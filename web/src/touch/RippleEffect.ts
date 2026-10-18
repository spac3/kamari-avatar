import * as THREE from 'three';
import type { ScreenTouch, TouchEffect, TouchSource } from '../interfaces';

export interface RippleOptions {
  /** Ring colour per side of the glass. */
  colors?: Record<TouchSource, THREE.ColorRepresentation>;
  /** Final ring radius on the glass, metres. */
  radius?: number;
  /** Seconds each ring takes to spread and fade. */
  duration?: number;
  rings?: number;
}

interface Ripple { group: THREE.Group; rings: THREE.Mesh[]; dot: THREE.Mesh; t: number }

const RING = new THREE.RingGeometry(0.88, 1, 48);
const DOT = new THREE.CircleGeometry(1, 32);
const ease = (x: number) => 1 - (1 - x) ** 3;

/** Concentric circles spreading out from the touch point, drawn on the glass over everything. */
export class RippleEffect implements TouchEffect {
  readonly object = new THREE.Group();
  private readonly ripples: Ripple[] = [];
  private readonly o: Required<RippleOptions>;

  constructor(opts: RippleOptions = {}) {
    this.o = { colors: { user: 0x2bb3c0, avatar: 0x63d13e }, radius: 0.07, duration: 0.9, rings: 3, ...opts };
    this.object.name = 'touch-effects';
    this.object.renderOrder = 10;
  }

  spawn(touch: ScreenTouch, facing: THREE.Quaternion): void {
    const group = new THREE.Group();
    group.position.copy(touch.point);
    group.quaternion.copy(facing);
    const mat = () => new THREE.MeshBasicMaterial({ color: this.o.colors[touch.source], transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const rings = Array.from({ length: this.o.rings }, () => new THREE.Mesh(RING, mat()));
    const dot = new THREE.Mesh(DOT, mat());
    for (const m of [...rings, dot]) {
      m.renderOrder = 10;
      m.scale.setScalar(1e-4);
      group.add(m);
    }
    this.object.add(group);
    this.ripples.push({ group, rings, dot, t: 0 });
  }

  update(dt: number): void {
    const { duration, radius } = this.o;
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      r.t += dt;
      // Rings start one after another, each spreading out while it fades.
      r.rings.forEach((ring, k) => {
        const p = Math.max(0, Math.min(1, (r.t - k * duration * 0.22) / duration));
        ring.scale.setScalar(Math.max(1e-4, radius * (0.15 + 0.85 * ease(p))));
        (ring.material as THREE.MeshBasicMaterial).opacity = p > 0 ? 0.9 * (1 - p) : 0;
      });
      const pd = Math.min(1, r.t / (duration * 0.5));
      r.dot.scale.setScalar(Math.max(1e-4, radius * 0.18 * (1 - 0.4 * pd)));
      (r.dot.material as THREE.MeshBasicMaterial).opacity = 0.8 * (1 - pd);
      if (r.t > duration * (1 + 0.22 * (r.rings.length - 1))) {
        for (const m of [...r.rings, r.dot]) (m.material as THREE.Material).dispose();
        this.object.remove(r.group);
        this.ripples.splice(i, 1);
      }
    }
  }

  /** Ripples still showing (tests, debugging). */
  get active(): number {
    return this.ripples.length;
  }
}
