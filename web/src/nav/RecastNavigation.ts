import * as THREE from 'three';
import { DebugDrawerUtils, importNavMesh, init, NavMesh, NavMeshQuery } from 'recast-navigation';
import type { NavigationProvider, Vec2 } from '../interfaces';
import type { RoomManifest } from '../room/manifest';

// Small vertical extent: only floor-level polygons count, not the tops of furniture.
const HALF_EXTENTS = { x: 1, y: 0.3, z: 1 };

export class RecastNavigation implements NavigationProvider {
  private navMesh: NavMesh | null = null;
  private query: NavMeshQuery | null = null;

  async init(_manifest: RoomManifest, navMeshUrl?: string): Promise<void> {
    if (!navMeshUrl) throw new Error('RecastNavigation needs a baked navmesh url');
    await init();
    const res = await fetch(navMeshUrl);
    if (!res.ok) throw new Error(`navmesh ${navMeshUrl}: HTTP ${res.status}`);
    this.load(new Uint8Array(await res.arrayBuffer()));
  }

  /** Load baked data directly (tests, workers). */
  load(data: Uint8Array): void {
    const { navMesh } = importNavMesh(data);
    this.navMesh = navMesh;
    this.query = new NavMeshQuery(navMesh);
  }

  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    if (!this.query) return null;
    const r = this.query.computePath({ x: from.x, y: 0, z: from.z }, { x: to.x, y: 0, z: to.z }, { halfExtents: HALF_EXTENTS });
    if (!r.success || r.path.length === 0) return null;
    const end = r.path[r.path.length - 1];
    // Detour returns a partial path when the goal is off the mesh; treat that as unreachable.
    if (Math.hypot(end.x - to.x, end.z - to.z) > 0.25) return null;
    return r.path.map((p) => ({ x: p.x, z: p.z }));
  }

  closestPoint(p: Vec2): Vec2 | null {
    if (!this.query) return null;
    const r = this.query.findClosestPoint({ x: p.x, y: 0, z: p.z }, { halfExtents: HALF_EXTENTS });
    return r.success ? { x: r.point.x, z: r.point.z } : null;
  }

  debugMesh(): THREE.Object3D | null {
    if (!this.navMesh) return null;
    const drawer = new DebugDrawerUtils();
    const positions: number[] = [];
    for (const prim of drawer.drawNavMesh(this.navMesh)) {
      if (prim.type === 'tris') for (const [x, y, z] of prim.vertices) positions.push(x, y, z);
    }
    drawer.dispose();
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x33cc88, transparent: true, opacity: 0.35, depthWrite: false }));
    mesh.position.y = 0.02;
    mesh.name = 'navmesh-debug';
    return mesh;
  }
}

/** Fake: straight lines inside the floor rectangle, ignoring obstacles. For tests and fallbacks. */
export class StraightLineNavigation implements NavigationProvider {
  private floor: RoomManifest['floor'] | null = null;

  async init(manifest: RoomManifest): Promise<void> {
    this.floor = manifest.floor;
  }

  findPath(from: Vec2, to: Vec2): Vec2[] | null {
    const end = this.closestPoint(to);
    return end && Math.hypot(end.x - to.x, end.z - to.z) < 1e-6 ? [from, end] : null;
  }

  closestPoint(p: Vec2): Vec2 | null {
    if (!this.floor) return null;
    const { min, max } = this.floor;
    return { x: Math.min(max.x, Math.max(min.x, p.x)), z: Math.min(max.z, Math.max(min.z, p.z)) };
  }

  debugMesh(): THREE.Object3D | null {
    return null;
  }
}
