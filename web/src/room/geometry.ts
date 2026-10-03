/**
 * Walkable-surface geometry for a room: the floor plus a box per obstacle.
 * Pure data (no three.js) so the navmesh bake script and the browser share it.
 */
import type { RoomManifest } from './manifest';

export interface TriangleSoup { positions: number[]; indices: number[] }

function addBox(soup: TriangleSoup, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): void {
  const base = soup.positions.length / 3;
  const [hx, hy, hz] = [sx / 2, sy / 2, sz / 2];
  for (const dy of [-hy, hy]) for (const dz of [-hz, hz]) for (const dx of [-hx, hx]) soup.positions.push(cx + dx, cy + dy, cz + dz);
  // corners: 0..3 bottom (y-), 4..7 top (y+); within each: (x-,z-), (x+,z-), (x-,z+), (x+,z+)
  const faces = [
    [4, 6, 7, 5], // top
    [0, 1, 3, 2], // bottom
    [0, 4, 5, 1], // z-
    [2, 3, 7, 6], // z+
    [0, 2, 6, 4], // x-
    [1, 5, 7, 3], // x+
  ];
  for (const [a, b, c, d] of faces) soup.indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
}

export function walkableGeometry(m: RoomManifest): TriangleSoup {
  const soup: TriangleSoup = { positions: [], indices: [] };
  const { min, max } = m.floor;
  // Floor as a thin slab so Recast sees a solid surface.
  addBox(soup, (min.x + max.x) / 2, -0.05, (min.z + max.z) / 2, max.x - min.x, 0.1, max.z - min.z);
  for (const o of m.obstacles) addBox(soup, o.center.x, o.size.y / 2, o.center.z, o.size.x, o.size.y, o.size.z);
  return soup;
}

/** Recast settings sized for a person-scale agent in a small room. */
export const NAVMESH_CONFIG = {
  cs: 0.05,
  ch: 0.05,
  walkableRadius: 6, // cells: 0.3 m
  walkableHeight: 34, // cells: 1.7 m
  walkableClimb: 4, // cells: 0.2 m
  walkableSlopeAngle: 35,
  maxEdgeLen: 24,
  minRegionArea: 8,
};
