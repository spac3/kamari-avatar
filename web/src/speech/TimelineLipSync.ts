import type { AvatarAdapter, LipSyncDriver } from '../interfaces';
import type { Viseme } from '../protocol';

const ALL: Viseme[] = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'];

interface Key { at: number; v: Viseme }

/**
 * Plays server viseme timelines against the audio clock (AudioContext.currentTime of the
 * buffer's scheduled start), so the mouth cannot drift from the sound. Neighbouring visemes
 * overlap by `blendS` for co-articulation instead of snapping.
 */
export class TimelineLipSync implements LipSyncDriver {
  private keys: Key[] = [];

  constructor(private readonly opts: { blendS?: number; gain?: number } = {}) {}

  start(startAt: number, visemes: { t: number; v: Viseme }[] = []): void {
    for (const k of visemes) this.keys.push({ at: startAt + k.t / 1000, v: k.v });
    this.keys.sort((a, b) => a.at - b.at);
  }

  stop(): void {
    this.keys = [];
  }

  /** Viseme weights at a given audio time. */
  weights(now: number): Partial<Record<Viseme, number>> {
    const keys = this.keys;
    // drop keys that are fully in the past, keeping the one in effect
    let drop = 0;
    while (drop + 1 < keys.length && keys[drop + 1].at <= now) drop++;
    if (drop) keys.splice(0, drop);
    const cur = keys[0];
    if (!cur || cur.at > now) return {};
    const blend = this.opts.blendS ?? 0.06;
    const gain = this.opts.gain ?? 0.9;
    const next = keys[1];
    const out: Partial<Record<Viseme, number>> = {};
    if (!next) {
      if (cur.v !== 'sil' && now - cur.at < 0.3) out[cur.v] = gain;
      return out;
    }
    // ramp into the next shape over the last `blend` seconds of this one
    const p = Math.min(1, Math.max(0, (now - (next.at - blend)) / blend));
    const ramp = p * p * (3 - 2 * p);
    if (cur.v !== 'sil') out[cur.v] = gain * (1 - ramp);
    if (next.v !== 'sil') out[next.v] = Math.max(out[next.v] ?? 0, gain * ramp);
    return out;
  }

  update(audioTime: number, avatar: AvatarAdapter): void {
    const w = this.weights(audioTime);
    for (const v of ALL) avatar.setViseme(v, w[v] ?? 0);
  }

  get idle(): boolean {
    return this.keys.length === 0;
  }
}
