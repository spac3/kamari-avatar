import type { MicCapture, ProtocolClient } from '../interfaces';
import { encodeAudioFrame } from '../net/WebSocketProtocolClient';

export const AUDIO_MIC = 0x01;

export type PttState = 'idle' | 'opening' | 'talking' | 'sending';

export interface PttOptions {
  /** Keep recording this long after release, so the last word is not clipped. */
  tailMs?: number;
}

/**
 * Hold to talk: on press, stop the avatar talking (barge-in), tell the server and stream mic
 * frames as binary audio; on release, flush the mic and send `ptt up` so the server transcribes.
 * The first press opens the mic, which shows the permission prompt; that press only opens it.
 */
export class PushToTalk {
  state: PttState = 'idle';
  onState: (s: PttState) => void = () => {};
  onError: (e: unknown) => void = () => {};
  private streamId = 0;
  private seq = 0;
  private press = 0; // bumped by every press, release and cancel: a continuation for an older one stops
  private opening: Promise<void> | null = null;

  constructor(
    private readonly mic: MicCapture,
    private readonly net: ProtocolClient,
    private readonly interruptSpeech: () => void,
    private readonly context: () => AudioContext | null,
    private readonly opts: PttOptions = {},
  ) {
    mic.onFrame((pcm) => {
      if (this.state === 'talking' || this.state === 'sending') {
        this.net.sendBinary(encodeAudioFrame(AUDIO_MIC, this.streamId, this.seq++, pcm));
      }
    });
  }

  async down(): Promise<void> {
    if (this.state !== 'idle') return;
    const press = ++this.press;
    this.interruptSpeech();
    if (!this.mic.ready) {
      const ctx = this.context();
      if (!ctx) {
        this.onError(new Error('audio is not unlocked yet'));
        return;
      }
      this.set('opening');
      try {
        // One open at a time: a second press during the permission prompt waits for the first.
        await (this.opening ??= this.mic.open(ctx).finally(() => (this.opening = null)));
      } catch (e) {
        if (press === this.press) this.set('idle');
        this.onError(e);
        return;
      }
      if (press !== this.press) return; // released (or pressed again) while the permission prompt was up
    }
    this.streamId = (this.streamId + 1) >>> 0;
    this.seq = 0;
    this.net.send('ptt', { state: 'down', stream_id: this.streamId });
    this.mic.start();
    this.set('talking');
  }

  async up(): Promise<void> {
    if (this.state === 'opening') {
      this.press++;
      this.set('idle');
      return;
    }
    if (this.state !== 'talking') return;
    const press = this.press;
    const streamId = this.streamId;
    this.set('sending');
    if (this.opts.tailMs ?? 120) await new Promise((r) => setTimeout(r, this.opts.tailMs ?? 120));
    if (press !== this.press) return; // cancelled during the tail: that press is gone
    await this.mic.stop();
    if (press !== this.press) return;
    this.net.send('ptt', { state: 'up', stream_id: streamId });
    this.set('idle');
  }

  /** Page hidden mid-press: drop it. The server discards the audio when it hears the tab hid. */
  cancel(): void {
    if (this.state === 'idle') return;
    this.press++;
    void this.mic.stop();
    this.set('idle');
  }

  private set(s: PttState): void {
    this.state = s;
    this.onState(s);
  }
}
