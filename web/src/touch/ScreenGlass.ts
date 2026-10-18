import * as THREE from 'three';
import type { ScreenTouch, TouchEffect, TouchSource } from '../interfaces';

/**
 * The screen as a pane of glass between the viewer and the avatar, `gap` metres in front of it.
 * The person touches it from outside (pointer), the avatar from inside (fingertip). Every touch
 * draws its effect and goes to the `onTouch` listeners, which is where touches will make things
 * happen (buttons, hotspots, tools).
 */
export class ScreenGlass {
  private readonly listeners = new Set<(t: ScreenTouch) => void>();
  private readonly plane = new THREE.Plane();
  private readonly ray = new THREE.Raycaster();
  private readonly forward = new THREE.Vector3();

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    /** The point the glass sits in front of (the avatar's root). */
    private readonly subject: THREE.Object3D,
    private readonly effect: TouchEffect | null,
    readonly gap = 0.38,
  ) {}

  /** Points from the glass towards the viewer. */
  get normal(): THREE.Vector3 {
    return this.camera.getWorldDirection(this.forward).negate();
  }

  private update(): THREE.Plane {
    const n = this.normal;
    const at = this.subject.getWorldPosition(new THREE.Vector3()).addScaledVector(n, this.gap);
    return this.plane.setFromNormalAndCoplanarPoint(n, at);
  }

  /** Glass point under a screen position (0..1 from the top left). */
  pointAt(x: number, y: number): THREE.Vector3 | null {
    this.ray.setFromCamera(new THREE.Vector2(x * 2 - 1, 1 - y * 2), this.camera);
    return this.ray.ray.intersectPlane(this.update(), new THREE.Vector3());
  }

  /** Screen position (0..1 from the top left) of a world point. */
  screenOf(point: THREE.Vector3): { x: number; y: number } {
    const p = point.clone().project(this.camera);
    return { x: (p.x + 1) / 2, y: (1 - p.y) / 2 };
  }

  /** Project a world point onto the glass. */
  onGlass(point: THREE.Vector3): THREE.Vector3 {
    return this.update().projectPoint(point, new THREE.Vector3());
  }

  /** Record a touch at a glass point: draw it and tell the listeners. */
  touch(source: TouchSource, point: THREE.Vector3): ScreenTouch {
    const t: ScreenTouch = { source, ...this.screenOf(point), point: point.clone() };
    this.effect?.spawn(t, this.camera.quaternion);
    for (const cb of this.listeners) cb(t);
    return t;
  }

  onTouch(cb: (t: ScreenTouch) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
}
