import type { MicCapture, ProtocolClient, VoiceActivityDetector } from '../interfaces';
import { encodeAudioFrame } from '../net/WebSocketProtocolClient';
import { EchoGate, rms } from './EchoGate';
import { AUDIO_MIC } from './PushToTalk';

export type OpenMicState = 'off' | 'opening' | 'listening' | 'maybe' | 'speaking';
export type AvatarActivity = 'idle' | 'talking' | 'walking' | 'thinking';

export interface OpenMicOptions {
  /** Voice probability that starts a possible utterance, and below which it counts as a pause. */
  startProb?: number;
  endProb?: number;
  /** Speech needed before it is the user talking, when the avatar is idle (ms). */
  minSpeechMs?: number;
  /** Speech needed to interrupt the avatar while it talks or walks: longer, so a cough does not cut it off. */
  bargeInMs?: number;
  /** A possible utterance is dropped after this much non-speech before it was confirmed. */
  maxGapMs?: number;
  /** Silence that ends an utterance. */
  hangoverMs?: number;
  /** Audio from before the detected start sent with the segment, so the first syllable is not lost. */
  preRollMs?: number;
  maxSegmentMs?: number;
  /** Avatar volume while a possible barge-in is checked (0..1). */
  duck?: number;
}

export interface OpenMicHooks {
  /** True while the server session is ready; until then nothing is heard (a segment could not be sent). */
  connected(): boolean;
  /** What the avatar is doing now. */
  activity(): AvatarActivity;
  /** Level of the avatar's audio output right now (the echo reference). */
  outputLevel(): number;
  /** Lower the avatar's voice while a barge-in is being confirmed, or restore it. */
  duck(on: boolean, gain: number): void;
  /** The user is talking over the avatar: stop its speech and walk now. */
  bargeIn(): void;
}

const DEFAULTS: Required<OpenMicOptions> = {
  startProb: 0.6,
  endProb: 0.35,
  minSpeechMs: 160,
  bargeInMs: 320,
  maxGapMs: 160,
  hangoverMs: 700,
  preRollMs: 300,
  maxSegmentMs: 20_000,
  duck: 0.3,
};

/**
 * Hands-free talking: the mic stays open, a VAD finds where the user speaks, and each utterance goes
 * to the server as a segment (user_speech_start, binary mic frames, user_speech_end).
 *
 * Talking over the avatar interrupts it in two steps. As soon as voice is detected its speech is
 * ducked; once the voice has lasted `bargeInMs` its speech and walk stop and the segment is sent.
 * A shorter sound (a cough, a knock, a word of the avatar's own that slipped past the echo canceller)
 * only dips the volume for a moment. The echo gate keeps output leaking into the mic from counting.
 */
export class OpenMic {
  state: OpenMicState = 'off';
  onState: (s: OpenMicState) => void = () => {};
  onError: (e: unknown) => void = () => {};
  /** Voice probability of each frame after the echo gate (for a level meter). */
  onProb: (p: number) => void = () => {};
  readonly stats = { segments: 0, bargeIns: 0, falseStarts: 0 };
  readonly gate = new EchoGate();
  private readonly o: Required<OpenMicOptions>;
  private chain: Promise<void> = Promise.resolve();
  private preRoll: Int16Array[] = [];
  private speechMs = 0;
  private gapMs = 0;
  private segmentMs = 0;
  private silenceMs = 0;
  private ducked = false;
  private streamId = 0;
  private seq = 0;
  private segment = 0;
  private generation = 0; // bumped by stop: frames queued before it are dropped

  constructor(
    private readonly mic: MicCapture,
    private vad: VoiceActivityDetector,
    private readonly net: ProtocolClient,
    private readonly hooks: OpenMicHooks,
    private readonly context: () => AudioContext | null,
    opts: OpenMicOptions = {},
    private readonly fallback: (() => VoiceActivityDetector) | null = null,
  ) {
    this.o = { ...DEFAULTS, ...opts };
    mic.onFrame((pcm) => {
      if (this.state === 'off' || this.state === 'opening') return;
      const out = this.hooks.outputLevel(); // now, not when the queued frame gets its turn
      const gen = this.generation;
      this.chain = this.chain.then(() => (gen === this.generation ? this.frame(pcm, out) : undefined)).catch((e) => this.onError(e));
    });
  }

  get detector(): string {
    return this.vad.name;
  }

  /** Open the mic (first time: the permission prompt, so call from a user gesture) and start listening. */
  async start(): Promise<void> {
    if (this.state !== 'off') return;
    this.set('opening');
    try {
      if (!this.mic.ready) {
        const ctx = this.context();
        if (!ctx) throw new Error('audio is not unlocked yet');
        await this.mic.open(ctx);
      }
      await this.loadVad();
    } catch (e) {
      this.set('off');
      this.onError(e);
      return;
    }
    if ((this.state as OpenMicState) !== 'opening') return; // stopped while opening
    this.reset();
    this.mic.start();
    this.set('listening');
  }

  /** Stop listening (mute, or switching to push-to-talk). An utterance in progress is sent as it is. */
  async stop(): Promise<void> {
    if (this.state === 'speaking') this.end();
    this.halt();
    await this.mic.stop();
  }

  /** Page hidden: drop everything; the server discards a segment in progress when it hears the tab hid. */
  cancel(): void {
    this.halt();
    void this.mic.stop();
  }

  private halt(): void {
    this.generation++;
    if (this.ducked) this.duck(false);
    this.set('off');
  }

  private async loadVad(): Promise<void> {
    try {
      await this.vad.load();
    } catch (e) {
      if (!this.fallback) throw e;
      console.warn(`voice detector ${this.vad.name} unavailable, falling back:`, e);
      this.vad = this.fallback();
      await this.vad.load();
    }
  }

  private reset(): void {
    this.vad.reset();
    this.preRoll = [];
    this.speechMs = this.gapMs = this.segmentMs = this.silenceMs = 0;
  }

  private async frame(pcm: Int16Array, outputLevel: number): Promise<void> {
    if (!this.hooks.connected()) return; // the caller cancels a segment in progress when the connection drops
    const keep = this.gate.check(rms(pcm), outputLevel);
    const p = (await this.vad.process(pcm)) * keep;
    this.onProb(p);
    const ms = (pcm.length / 16000) * 1000;
    switch (this.state) {
      case 'listening':
        this.remember(pcm);
        if (p >= this.o.startProb) {
          this.speechMs = ms;
          this.gapMs = 0;
          this.set('maybe');
          if (this.hooks.activity() === 'talking') this.duck(true);
          this.maybeConfirm();
        }
        break;
      case 'maybe':
        this.preRoll.push(pcm);
        if (p >= this.o.startProb) {
          this.speechMs += ms;
          this.gapMs = 0;
        } else if ((this.gapMs += ms) > this.o.maxGapMs) {
          this.stats.falseStarts++;
          if (this.ducked) this.duck(false);
          this.set('listening');
          this.trimPreRoll();
          break;
        }
        this.maybeConfirm();
        break;
      case 'speaking':
        this.send(pcm);
        this.segmentMs += ms;
        this.silenceMs = p < this.o.endProb ? this.silenceMs + ms : 0;
        if (this.silenceMs >= this.o.hangoverMs || this.segmentMs >= this.o.maxSegmentMs) this.end();
        break;
    }
  }

  private maybeConfirm(): void {
    const activity = this.hooks.activity();
    const busy = activity === 'talking' || activity === 'walking';
    if (this.speechMs < (busy ? this.o.bargeInMs : this.o.minSpeechMs)) return;
    if (busy) {
      this.stats.bargeIns++;
      this.hooks.bargeIn();
    }
    if (this.ducked) this.duck(false);
    this.stats.segments++;
    this.streamId = (this.streamId + 1) >>> 0;
    this.seq = 0;
    this.net.send('user_speech_start', { segment_id: `seg_${++this.segment}`, stream_id: this.streamId, while: activity });
    this.segmentMs = this.silenceMs = 0;
    for (const f of this.preRoll) {
      this.send(f);
      this.segmentMs += (f.length / 16000) * 1000;
    }
    this.preRoll = [];
    this.set('speaking');
  }

  private end(): void {
    this.net.send('user_speech_end', { segment_id: `seg_${this.segment}`, duration_ms: Math.round(this.segmentMs) });
    this.speechMs = this.gapMs = 0;
    this.set('listening');
  }

  private send(pcm: Int16Array): void {
    this.net.sendBinary(encodeAudioFrame(AUDIO_MIC, this.streamId, this.seq++, pcm));
  }

  private remember(pcm: Int16Array): void {
    this.preRoll.push(pcm);
    this.trimPreRoll();
  }

  private trimPreRoll(): void {
    let ms = this.preRoll.reduce((s, f) => s + (f.length / 16000) * 1000, 0);
    while (this.preRoll.length > 1 && ms - (this.preRoll[0].length / 16000) * 1000 >= this.o.preRollMs) {
      ms -= (this.preRoll.shift()!.length / 16000) * 1000;
    }
  }

  private duck(on: boolean): void {
    this.ducked = on;
    this.hooks.duck(on, this.o.duck);
  }

  private set(s: OpenMicState): void {
    if (this.state === s) return;
    this.state = s;
    this.onState(s);
  }
}
