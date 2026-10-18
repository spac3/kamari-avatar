/**
 * Keeps the avatar's own voice from counting as the user's. Browsers cancel most echo (getUserMedia
 * echoCancellation), but not all of it, and on some systems none for Web Audio output. The gate
 * compares each mic frame with what was playing just before it: while the avatar talks, a frame only
 * counts as the user when it is clearly louder than the echo that output would leave in the mic.
 *
 * How much output leaks into the mic (the coupling) depends on speakers, volume, room and the
 * browser's echo canceller, so it is measured during playback: a high percentile of the mic/output
 * ratio over recent frames that were echo alone. Echo alone is when the mic's loudness follows the
 * output's (their envelopes correlate, at some lag); when the user talks too it stops following
 * (double talk), so their voice is never learnt as echo, and a frame that does not follow the output
 * passes at a lower margin. Until enough has been measured a cautious guess is used.
 */
export interface EchoGateOptions {
  /** Mic level must exceed the expected echo by this factor to be the user (2 = 6 dB). */
  margin?: number;
  /** Coupling (mic RMS / output RMS) used before enough has been measured: cautious. */
  initialCoupling?: number;
  /** Output quieter than this (RMS 0..1) is silence: nothing to gate. */
  silence?: number;
  /** How far back the output reference reaches, in mic frames (covers output and mic latency). */
  historyFrames?: number;
  /** Playback frames the coupling is measured over, and how many it needs before trusting it. */
  window?: number;
  minSamples?: number;
  /** Percentile of the measured ratios taken as the coupling (0..1). */
  percentile?: number;
  /** Coupling never goes past this. */
  maxCoupling?: number;
  /** Envelope correlation above which the mic is echo alone, and below which it is double talk. */
  echoCorrelation?: number;
  doubleTalkCorrelation?: number;
  /** Margin over the expected echo for a frame in double talk. */
  doubleTalkMargin?: number;
}

const ENV_WINDOW = 15; // frames (300 ms) of envelope compared
const MAX_LAG = 8; // frames (160 ms) the mic may lag the output reference

function pearson(a: number[], b: number[]): number | null {
  const n = a.length;
  const ma = a.reduce((s, v) => s + v, 0) / n;
  const mb = b.reduce((s, v) => s + v, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    sab += (a[i] - ma) * (b[i] - mb);
    saa += (a[i] - ma) ** 2;
    sbb += (b[i] - mb) ** 2;
  }
  return saa < 1e-9 || sbb < 1e-9 ? null : sab / Math.sqrt(saa * sbb);
}

const db = (x: number) => 20 * Math.log10(Math.max(x, 1e-5));

export class EchoGate {
  private readonly o: Required<EchoGateOptions>;
  private history: number[] = [];
  private ratios: number[] = [];
  private measured: number | null = null;
  private micEnv: number[] = [];
  private refEnv: number[] = [];
  /** Latest envelope correlation between mic and output (null when it could not be measured). */
  correlation: number | null = null;

  constructor(opts: EchoGateOptions = {}) {
    this.o = {
      margin: 2, initialCoupling: 0.5, silence: 0.003, historyFrames: 10, // 200 ms of 20 ms frames
      window: 150, minSamples: 15, percentile: 0.9, maxCoupling: 1.5,
      echoCorrelation: 0.7, doubleTalkCorrelation: 0.4, doubleTalkMargin: 1.2, ...opts,
    };
  }

  /** Expected echo level in the mic per unit of output level. */
  get coupling(): number {
    return this.measured ?? this.o.initialCoupling;
  }

  /**
   * One mic frame (its RMS 0..1) and the output level measured as it arrived. Returns how much of
   * the frame's voice probability to keep: 1 when nothing plays or the user is clearly louder than
   * the echo, 0 when the frame is the avatar's echo.
   */
  check(micRms: number, outputRms: number): number {
    this.history.push(outputRms);
    if (this.history.length > this.o.historyFrames) this.history.shift();
    this.micEnv.push(db(micRms));
    this.refEnv.push(db(outputRms));
    if (this.micEnv.length > ENV_WINDOW + MAX_LAG) {
      this.micEnv.shift();
      this.refEnv.shift();
    }
    const ref = Math.max(...this.history);
    if (ref < this.o.silence) {
      this.correlation = null;
      return 1;
    }
    const corr = (this.correlation = this.envelopeCorrelation());
    const expected = this.coupling * ref;
    const doubleTalk = corr !== null && corr < this.o.doubleTalkCorrelation;
    if (micRms > expected * (doubleTalk ? this.o.doubleTalkMargin : this.o.margin)) return 1;
    if (corr !== null && corr > this.o.echoCorrelation) this.learn(micRms / ref);
    return 0;
  }

  /** Best correlation of the mic's loudness with the output's over the last 300 ms, at any lag up to 160 ms. */
  private envelopeCorrelation(): number | null {
    const n = this.micEnv.length;
    if (n < ENV_WINDOW + MAX_LAG) return null;
    const mic = this.micEnv.slice(n - ENV_WINDOW);
    let best: number | null = null;
    for (let lag = 0; lag <= MAX_LAG; lag++) {
      const c = pearson(mic, this.refEnv.slice(n - ENV_WINDOW - lag, n - lag));
      if (c !== null && (best === null || c > best)) best = c;
    }
    return best;
  }

  reset(): void {
    this.history = [];
    this.ratios = [];
    this.measured = null;
    this.micEnv = [];
    this.refEnv = [];
    this.correlation = null;
  }

  private learn(ratio: number): void {
    this.ratios.push(ratio);
    if (this.ratios.length > this.o.window) this.ratios.shift();
    if (this.ratios.length < this.o.minSamples) return;
    const sorted = [...this.ratios].sort((a, b) => a - b);
    this.measured = Math.min(this.o.maxCoupling, sorted[Math.floor((sorted.length - 1) * this.o.percentile)]);
  }
}

export function rms(frame: Int16Array): number {
  let sum = 0;
  for (const v of frame) sum += v * v;
  return Math.sqrt(sum / Math.max(1, frame.length)) / 32768;
}
