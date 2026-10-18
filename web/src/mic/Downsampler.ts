/**
 * Float samples at the AudioContext rate -> 16 kHz PCM16 frames. Averages the input samples that
 * fall in each output sample (a crude low-pass that keeps aliasing out of the speech band).
 */
export class Downsampler {
  private acc = 0;
  private n = 0;
  private pos = 0;
  private readonly out: Int16Array;
  private len = 0;
  private readonly ratio: number;

  constructor(
    inRate: number,
    private readonly emit: (frame: Int16Array) => void,
    outRate = 16000,
    frameSamples = 320, // 20 ms
  ) {
    if (inRate < outRate) throw new Error(`cannot downsample ${inRate} Hz to ${outRate} Hz`);
    this.ratio = inRate / outRate;
    this.out = new Int16Array(frameSamples);
  }

  push(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.n++;
      if (++this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.write(this.acc / this.n);
        this.acc = this.n = 0;
      }
    }
  }

  /** Emit whatever is buffered as a final, shorter frame. */
  flush(): void {
    if (this.n) this.write(this.acc / this.n);
    if (this.len) this.emit(this.out.slice(0, this.len));
    this.reset();
  }

  reset(): void {
    this.acc = this.n = this.pos = this.len = 0;
  }

  private write(v: number): void {
    this.out[this.len++] = Math.round(Math.max(-1, Math.min(1, v)) * 32767);
    if (this.len === this.out.length) {
      this.emit(this.out.slice());
      this.len = 0;
    }
  }
}
