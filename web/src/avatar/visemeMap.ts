import type { Viseme } from '../protocol';

/** VRM has five mouth shapes; blend them to approximate each Oculus viseme. */
export type VrmVowel = 'aa' | 'ih' | 'ou' | 'ee' | 'oh';

export const OCULUS_TO_VRM: Record<Viseme, Partial<Record<VrmVowel, number>>> = {
  sil: {},
  PP: {},
  FF: { ih: 0.2 },
  TH: { ih: 0.3, aa: 0.1 },
  DD: { ih: 0.3, aa: 0.15 },
  kk: { aa: 0.3, ih: 0.2 },
  CH: { ou: 0.3, ih: 0.25 },
  SS: { ih: 0.4 },
  nn: { ih: 0.2, aa: 0.1 },
  RR: { ou: 0.4, oh: 0.1 },
  aa: { aa: 1 },
  E: { ee: 0.8, aa: 0.1 },
  I: { ih: 0.9 },
  O: { oh: 1 },
  U: { ou: 1 },
};

/** Combine weighted visemes into VRM vowel weights, each clamped to 0..1. */
export function vowelWeights(visemes: Partial<Record<Viseme, number>>): Record<VrmVowel, number> {
  const out: Record<VrmVowel, number> = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  for (const [v, w] of Object.entries(visemes) as [Viseme, number][]) {
    for (const [vowel, k] of Object.entries(OCULUS_TO_VRM[v]) as [VrmVowel, number][]) out[vowel] += k * w;
  }
  for (const k of Object.keys(out) as VrmVowel[]) out[k] = Math.min(1, Math.max(0, out[k]));
  return out;
}
