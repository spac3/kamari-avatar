import * as THREE from 'three';
import type { QualitySettings, RoomProvider } from '../interfaces';
import type { Obstacle, RoomManifest } from './manifest';

/**
 * Builds the room from its manifest with plain three.js geometry. A GLB room
 * (authored in Blender, locations as empties) can replace it behind RoomProvider.
 */
export class ProceduralRoom implements RoomProvider {
  build(m: RoomManifest, q: QualitySettings): THREE.Object3D {
    const room = new THREE.Group();
    room.name = `room:${m.room_id}`;
    const { min, max } = m.floor;
    const w = max.x - min.x;
    const d = max.z - min.z;
    const h = m.wall_height;
    const cx = (min.x + max.x) / 2;
    const cz = (min.z + max.z) / 2;

    // The visible floor runs past the open front edge so a pulled-back phone camera never sees its end.
    const apron = 4;
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d + apron), new THREE.MeshStandardMaterial({ color: 0xc9b79c, roughness: 0.9 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(cx, 0, cz + apron / 2);
    floor.receiveShadow = q.shadows;
    floor.name = 'floor';

    const rug = new THREE.Mesh(new THREE.CircleGeometry(1.1, 40), new THREE.MeshStandardMaterial({ color: 0x9c5b4e, roughness: 1 }));
    rug.rotation.x = -Math.PI / 2;
    rug.position.set(-1.6, 0.005, -1.4);
    rug.receiveShadow = q.shadows;

    const wallMat = new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.95, side: THREE.DoubleSide });
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, h), wallMat);
    back.position.set(cx, h / 2, min.z);
    const left = new THREE.Mesh(new THREE.PlaneGeometry(d, h), wallMat);
    left.rotation.y = Math.PI / 2;
    left.position.set(min.x, h / 2, cz);
    const right = left.clone();
    right.rotation.y = -Math.PI / 2;
    right.position.x = max.x;

    // Window on the back wall: a glowing pane with a frame.
    const window = new THREE.Group();
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 1.2), new THREE.MeshBasicMaterial({ color: 0xbfe3ff }));
    const frameMat = new THREE.MeshStandardMaterial({ color: 0xffffff });
    const bars = [
      new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.06, 0.06), frameMat),
      new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.06, 0.06), frameMat),
      new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.3, 0.06), frameMat),
    ];
    bars[0].position.y = 0.62;
    bars[1].position.y = -0.62;
    window.add(pane, ...bars);
    window.position.set(0, 1.55, min.z + 0.01);

    const door = new THREE.Mesh(new THREE.BoxGeometry(0.05, 2.1, 0.95), new THREE.MeshStandardMaterial({ color: 0x8a6a4a }));
    door.position.set(max.x - 0.02, 1.05, 2.2);

    room.add(floor, rug, back, left, right, window, door);
    for (const o of m.obstacles) room.add(this.furniture(o, q));
    return room;
  }

  private furniture(o: Obstacle, q: QualitySettings): THREE.Object3D {
    const mat = new THREE.MeshStandardMaterial({ color: o.color, roughness: 0.8 });
    const g = new THREE.Group();
    g.name = o.name;
    g.position.set(o.center.x, 0, o.center.z);
    const box = (sx: number, sy: number, sz: number, x = 0, y = sy / 2, z = 0, m = mat) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = q.shadows;
      g.add(mesh);
    };
    const { x: sx, y: sy, z: sz } = o.size;
    if (o.kind === 'sofa') {
      box(sx, sy * 0.5, sz); // seat
      box(sx * 0.3, sy, sz, -sx * 0.35); // back against the wall
      box(sx, sy * 0.7, 0.18, 0, sy * 0.35, -sz / 2 + 0.09); // arms
      box(sx, sy * 0.7, 0.18, 0, sy * 0.35, sz / 2 - 0.09);
    } else if (o.kind === 'plant') {
      box(sx * 0.6, 0.4, sz * 0.6, 0, 0.2, 0, new THREE.MeshStandardMaterial({ color: 0xb5651d }));
      const leaves = new THREE.Mesh(new THREE.SphereGeometry(sx * 0.6, 12, 10), mat);
      leaves.position.y = 0.4 + sx * 0.6;
      leaves.castShadow = q.shadows;
      g.add(leaves);
    } else {
      box(sx, 0.05, sz, 0, sy - 0.025); // top
      for (const [dx, dz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(0.05, sy - 0.05, 0.05, dx * (sx / 2 - 0.05), (sy - 0.05) / 2, dz * (sz / 2 - 0.05));
    }
    return g;
  }
}
