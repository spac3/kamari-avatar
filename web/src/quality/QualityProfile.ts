import type { QualityProfile, QualitySettings } from '../interfaces';

export const PRESETS: Record<QualitySettings['name'], QualitySettings> = {
  desktop: { name: 'desktop', pixelRatio: 2, maxFps: 60, shadows: true, springBones: true, textureSize: 2048, antialias: true },
  mobile: { name: 'mobile', pixelRatio: 1.5, maxFps: 30, shadows: false, springBones: true, textureSize: 1024, antialias: true },
  low: { name: 'low', pixelRatio: 1, maxFps: 30, shadows: false, springBones: false, textureSize: 512, antialias: false },
};

const ORDER: QualitySettings['name'][] = ['desktop', 'mobile', 'low'];

export interface DeviceHints { coarsePointer: boolean; deviceMemoryGb?: number; hardwareConcurrency?: number }

export function detectDevice(): DeviceHints {
  const nav = navigator as Navigator & { deviceMemory?: number };
  return {
    coarsePointer: typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches,
    deviceMemoryGb: nav.deviceMemory,
    hardwareConcurrency: nav.hardwareConcurrency,
  };
}

export function presetFor(h: DeviceHints): QualitySettings['name'] {
  if ((h.deviceMemoryGb ?? 8) <= 2 || (h.hardwareConcurrency ?? 8) <= 2) return 'low';
  return h.coarsePointer ? 'mobile' : 'desktop';
}

/** Starts from a preset and steps down when average frame time stays over budget. */
export class AdaptiveQuality implements QualityProfile {
  private samples: number[] = [];
  current: QualitySettings;

  constructor(start: QualitySettings['name'], private readonly window = 120, private readonly tolerance = 1.3) {
    this.current = PRESETS[start];
  }

  sample(frameMs: number): QualitySettings | null {
    this.samples.push(frameMs);
    if (this.samples.length < this.window) return null;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    this.samples = [];
    const budget = 1000 / this.current.maxFps;
    const i = ORDER.indexOf(this.current.name);
    if (avg > budget * this.tolerance && i < ORDER.length - 1) {
      this.current = PRESETS[ORDER[i + 1]];
      return this.current;
    }
    return null;
  }
}
