import { exportNavMesh, init } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { beforeAll, describe, expect, it } from 'vitest';
import { RecastNavigation, StraightLineNavigation } from '../src/nav/RecastNavigation';
import { NAVMESH_CONFIG, walkableGeometry } from '../src/room/geometry';
import { loadManifest } from '../src/room/manifest';

const manifest = loadManifest('studio');
const nav = new RecastNavigation();

beforeAll(async () => {
  await init();
  const soup = walkableGeometry(manifest);
  const r = generateSoloNavMesh(soup.positions, soup.indices, NAVMESH_CONFIG);
  if (!r.success) throw new Error(r.error);
  nav.load(exportNavMesh(r.navMesh)); // same path the browser takes: baked bytes in, query out
});

describe('recast navigation over the studio', () => {
  it('reaches every named location from the spawn point', () => {
    for (const loc of manifest.locations) {
      const path = nav.findPath(manifest.spawn.position, loc.position);
      expect(path, loc.name).not.toBeNull();
      const end = path![path!.length - 1];
      expect(Math.hypot(end.x - loc.position.x, end.z - loc.position.z)).toBeLessThan(0.05);
    }
  });

  it('routes around the coffee table instead of through it', () => {
    const path = nav.findPath({ x: -0.6, z: -1.5 }, manifest.locations.find((l) => l.name === 'sofa')!.position)!;
    expect(path.length).toBeGreaterThan(2);
  });

  it('reports points inside furniture as unreachable', () => {
    expect(nav.findPath(manifest.spawn.position, { x: -3.4, z: -1.5 })).toBeNull(); // the sofa itself
  });

  it('snaps a point to the nearest walkable spot', () => {
    const p = nav.closestPoint({ x: -3.4, z: -1.5 })!;
    expect(p.x).toBeGreaterThan(-3.0);
  });
});

describe('straight-line fake navigation', () => {
  it('clamps to the floor and ignores obstacles', async () => {
    const fake = new StraightLineNavigation();
    await fake.init(manifest);
    expect(fake.findPath({ x: 0, z: 0 }, { x: 1, z: 1 })).toEqual([{ x: 0, z: 0 }, { x: 1, z: 1 }]);
    expect(fake.findPath({ x: 0, z: 0 }, { x: 99, z: 0 })).toBeNull();
  });
});
