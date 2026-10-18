import type { VoiceActivityDetector } from '../interfaces';

export interface EnergyVadOptions {
  /** Frames this much louder than the room's noise floor count as speech (dB). */
  marginDb?: number;
  /** Never speech below this level (dBFS). */
  minDbfs?: number;
}

/** RMS level of PCM16 samples in dBFS. */
export function dbfs(frame: Int16Array): number {
  let sum = 0;
  for (const v of frame) sum += v * v;
  const rms = Math.sqrt(sum / Math.max(1, frame.length)) / 32768;
  return 20 * Math.log10(Math.max(rms, 1e-6));
}

/**
 * Speech is whatever is clearly louder than the room's noise floor, which it tracks as it goes
 * (falls fast, rises slowly, so a long sentence does not become the new floor). No model, no
 * download: the fallback when Silero cannot load, and good enough in a quiet room. It cannot tell a
 * voice from a slammed door or music, which Silero can.
 */
export class EnergyVad implements VoiceActivityDetector {
  readonly name = 'energy';
  private floor = -60;
  private readonly marginDb: number;
  private readonly minDbfs: number;

  constructor(opts: EnergyVadOptions = {}) {
    this.marginDb = opts.marginDb ?? 12;
    this.minDbfs = opts.minDbfs ?? -50;
  }

  async load(): Promise<void> {}

  async process(frame: Int16Array): Promise<number> {
    const level = dbfs(frame);
    this.floor = level < this.floor ? this.floor + (level - this.floor) * 0.3 : this.floor + (level - this.floor) * 0.005;
    const over = level - Math.max(this.floor + this.marginDb, this.minDbfs);
    return 1 / (1 + Math.exp(-over / 2)); // 0.5 right at the threshold
  }

  reset(): void {
    this.floor = -60;
  }
}
