import type { VoiceActivityDetector } from '../interfaces';

type Ort = typeof import('onnxruntime-web/wasm');
type Session = Awaited<ReturnType<Ort['InferenceSession']['create']>>;

export interface SileroVadOptions {
  /** URL (or bytes) of the Silero VAD ONNX model, v5 or v6 interface: input, state, sr. */
  model: string | Uint8Array;
}

const WINDOW = 512; // 32 ms at 16 kHz, what the model takes
const CONTEXT = 64; // samples of the previous window put in front of each one, as the reference code does

/**
 * Silero VAD (MIT, snakers4/silero-vad) run in the browser with onnxruntime-web (MIT) on WASM. Tells
 * speech from noise, music and knocks far better than an energy threshold, for about a millisecond
 * of CPU per 32 ms window. The runtime (~14 MB of WASM) loads only when the open mic is first used.
 */
export class SileroVad implements VoiceActivityDetector {
  readonly name = 'silero';
  private ort: Ort | null = null;
  private session: Session | null = null;
  private state = new Float32Array(2 * 128);
  private buf = new Float32Array(CONTEXT + WINDOW);
  private fill = 0; // samples of the current window collected so far
  private prob = 0;

  constructor(private readonly opts: SileroVadOptions) {}

  async load(): Promise<void> {
    if (this.session) return;
    this.ort = await import('onnxruntime-web/wasm');
    this.ort.env.wasm.numThreads = 1; // threads need cross-origin isolation; one is plenty for this model
    const model = this.opts.model;
    this.session = typeof model === 'string'
      ? await this.ort.InferenceSession.create(model, { executionProviders: ['wasm'] })
      : await this.ort.InferenceSession.create(model, { executionProviders: ['wasm'] });
  }

  async process(frame: Int16Array): Promise<number> {
    if (!this.session || !this.ort) throw new Error('Silero VAD not loaded');
    for (const v of frame) {
      this.buf[CONTEXT + this.fill++] = v / 32768;
      if (this.fill === WINDOW) await this.run();
    }
    return this.prob;
  }

  reset(): void {
    this.state.fill(0);
    this.buf.fill(0);
    this.fill = 0;
    this.prob = 0;
  }

  private async run(): Promise<void> {
    const ort = this.ort!;
    const out = await this.session!.run({
      input: new ort.Tensor('float32', this.buf.slice(), [1, CONTEXT + WINDOW]),
      state: new ort.Tensor('float32', this.state, [2, 1, 128]),
      sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
    });
    this.prob = (out.output.data as Float32Array)[0];
    this.state = new Float32Array(out.stateN.data as Float32Array);
    this.buf.copyWithin(0, WINDOW, WINDOW + CONTEXT);
    this.fill = 0;
  }
}
