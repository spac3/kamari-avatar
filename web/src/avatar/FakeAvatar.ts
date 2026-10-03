import * as THREE from 'three';
import type { AvatarAdapter } from '../interfaces';
import type { Viseme } from '../protocol';

const OPEN: Partial<Record<Viseme, number>> = { aa: 1, O: 0.8, E: 0.6, U: 0.4, I: 0.4, kk: 0.3, DD: 0.3, SS: 0.2 };

/** Capsule stand-in with a mouth that opens per viseme. No assets needed. */
export class FakeAvatar implements AvatarAdapter {
  readonly object = new THREE.Group();
  private mouth: THREE.Mesh;
  private head: THREE.Mesh;
  private eyes: THREE.Mesh[] = [];
  private open = 0;
  private bones = new Map<string, THREE.Object3D>();

  constructor() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xf2c9a0 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 0.9, 6, 12), new THREE.MeshStandardMaterial({ color: 0x4a6fa5 }));
    body.position.y = 0.75;
    this.head = new THREE.Mesh(new THREE.SphereGeometry(0.17, 16, 12), skin);
    this.head.position.y = 1.5;
    const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
    for (const x of [-0.06, 0.06]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 6), eyeMat);
      eye.position.set(x, 0.04, 0.155);
      this.head.add(eye);
      this.eyes.push(eye);
    }
    this.mouth = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.02, 0.01), eyeMat);
    this.mouth.position.set(0, -0.06, 0.16);
    this.head.add(this.mouth);
    this.object.add(body, this.head);
    this.bones.set('hips', body).set('head', this.head);
  }

  async load(): Promise<void> {}
  setViseme(v: Viseme, w: number): void {
    this.open = Math.max(this.open, (OPEN[v] ?? 0) * w);
  }
  setExpression(): void {}
  setBlink(w: number): void {
    for (const e of this.eyes) e.scale.y = 1 - 0.9 * w;
  }
  lookAt(target: THREE.Vector3 | null): void {
    if (target) this.head.lookAt(target);
  }
  bone(name: string): THREE.Object3D | null {
    return this.bones.get(name) ?? null;
  }
  update(): void {
    this.mouth.scale.y = 1 + this.open * 3;
    this.open = 0;
  }
  dispose(): void {}
}
