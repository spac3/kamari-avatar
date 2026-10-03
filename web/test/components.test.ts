import { describe, expect, it } from 'vitest';
import { vowelWeights } from '../src/avatar/visemeMap';
import { configFromQuery, registerBuiltins } from '../src/config';
import { available, create } from '../src/registry';
import { AdaptiveQuality, presetFor } from '../src/quality/QualityProfile';

registerBuiltins();

describe('registry and config', () => {
  it('has a fake or alternative for every swappable component', () => {
    expect(available('avatar')).toEqual(['fake', 'vrm']);
    expect(available('navigation')).toEqual(['recast', 'straight']);
    expect(available('net')).toEqual(['offline', 'websocket']);
  });

  it('names the known implementations when one is missing', () => {
    expect(() => create('avatar', { impl: 'rpm' })).toThrow('known: fake, vrm');
  });

  it('swaps implementations from the query string', () => {
    const c = configFromQuery('?avatar=fake&nav=straight&quality=low&debug');
    expect([c.avatar.impl, c.navigation.impl, c.quality, c.debug]).toEqual(['fake', 'straight', 'low', true]);
    expect(configFromQuery('').avatar.impl).toBe('vrm');
  });
});

describe('visemes on a VRM', () => {
  it('maps open vowels fully and closed lips to nothing', () => {
    expect(vowelWeights({ aa: 1 }).aa).toBe(1);
    expect(Object.values(vowelWeights({ PP: 1 })).every((w) => w === 0)).toBe(true);
  });

  it('clamps blended weights', () => {
    expect(vowelWeights({ I: 1, SS: 1 }).ih).toBe(1);
  });
});

describe('quality', () => {
  it('picks presets from device hints', () => {
    expect(presetFor({ coarsePointer: true })).toBe('mobile');
    expect(presetFor({ coarsePointer: false })).toBe('desktop');
    expect(presetFor({ coarsePointer: true, deviceMemoryGb: 2 })).toBe('low');
  });

  it('steps down when frames stay over budget, and stops at low', () => {
    const q = new AdaptiveQuality('desktop', 10);
    for (let i = 0; i < 9; i++) expect(q.sample(40)).toBeNull();
    expect(q.sample(40)?.name).toBe('mobile');
    for (let i = 0; i < 10; i++) q.sample(60);
    expect(q.current.name).toBe('low');
    for (let i = 0; i < 10; i++) expect(q.sample(100)).toBeNull();
  });

  it('keeps the profile when frames are on budget', () => {
    const q = new AdaptiveQuality('mobile', 10);
    for (let i = 0; i < 30; i++) q.sample(30);
    expect(q.current.name).toBe('mobile');
  });
});
