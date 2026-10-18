import type { MicCapture } from '../interfaces';
import { Downsampler } from './Downsampler';

// Runs on the audio thread: forwards 128-sample blocks while on. Messages keep their order, so
// "flushed" comes after the last block sent before "stop".
const WORKLET = `
class KamariMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.on = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.on = true;
      else if (e.data === 'stop') { this.on = false; this.port.postMessage('flushed'); }
    };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (this.on && ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('kamari-mic', KamariMic);
`;

const loaded = new WeakSet<BaseAudioContext>();

/**
 * getUserMedia with echo cancellation, noise suppression and gain control, into an AudioWorklet
 * on the playback AudioContext (one context for the whole session suits iOS), downsampled to
 * 16 kHz PCM16 in 20 ms frames. The stream stays open between presses.
 */
export class WorkletMicCapture implements MicCapture {
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private down: Downsampler | null = null;
  private cbs = new Set<(pcm: Int16Array) => void>();
  private flushed: (() => void) | null = null;

  get ready(): boolean {
    return !!this.stream?.getAudioTracks().some((t) => t.readyState === 'live') && !!this.node;
  }

  async open(ctx: AudioContext): Promise<void> {
    if (this.ready) return;
    this.close();
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('microphone needs HTTPS (or localhost)');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (!loaded.has(ctx)) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      loaded.add(ctx);
    }
    this.down = new Downsampler(ctx.sampleRate, (f) => this.cbs.forEach((cb) => cb(f)));
    this.source = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'kamari-mic', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
    this.node.port.onmessage = (e: MessageEvent<Float32Array | string>) => {
      if (e.data === 'flushed') {
        this.flushed?.();
        this.flushed = null;
      } else if (typeof e.data !== 'string') {
        this.down?.push(e.data);
      }
    };
    // A node must reach the destination to be processed everywhere; a zero gain keeps it silent.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    this.source.connect(this.node).connect(mute).connect(ctx.destination);
  }

  start(): void {
    this.down?.reset();
    this.node?.port.postMessage('start');
  }

  async stop(): Promise<void> {
    if (!this.node) return;
    const done = new Promise<void>((resolve) => {
      this.flushed = resolve;
      setTimeout(resolve, 250); // never hang the release on a stalled audio thread
    });
    this.node.port.postMessage('stop');
    await done;
    this.down?.flush();
  }

  onFrame(cb: (pcm16k: Int16Array) => void): void {
    this.cbs.add(cb);
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.source?.disconnect();
    this.node?.disconnect();
    this.stream = this.node = this.source = null;
  }
}

/** Fake mic for tests and machines without one: a quiet 220 Hz tone, 20 ms per frame while on. */
export class FakeMicCapture implements MicCapture {
  ready = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private cbs = new Set<(pcm: Int16Array) => void>();
  private t = 0;

  async open(): Promise<void> {
    this.ready = true;
  }

  start(): void {
    this.timer ??= setInterval(() => this.cbs.forEach((cb) => cb(this.frame())), 20);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onFrame(cb: (pcm16k: Int16Array) => void): void {
    this.cbs.add(cb);
  }

  close(): void {
    void this.stop();
    this.ready = false;
  }

  frame(): Int16Array {
    const f = new Int16Array(320);
    for (let i = 0; i < f.length; i++, this.t++) f[i] = Math.round(2000 * Math.sin((2 * Math.PI * 220 * this.t) / 16000));
    return f;
  }
}
