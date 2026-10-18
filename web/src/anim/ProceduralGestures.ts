import * as THREE from 'three';
import type { AvatarAdapter, GesturePlayer } from '../interfaces';

/** Bone name -> rotation [x, y, z] (radians), in normalized humanoid space facing -Z (VRM 0.x). */
type Pose = Record<string, [number, number, number]>;

interface Gesture {
  duration: number;
  /** Pose at time t (seconds since the start). */
  pose(t: number): Pose;
}

const wave = (t: number) => Math.sin(t * Math.PI * 2 * 1.6);

/**
 * Wave, nod, shrug and point as poses blended over the playing clip on the upper body only, so
 * they work while idling, talking or walking. Clip-based gestures can replace this behind the
 * same interface (M4).
 */
export const GESTURES: Record<string, Gesture> = {
  wave: {
    duration: 2.2,
    pose: (t) => ({
      rightShoulder: [0, 0, 0.12],
      rightUpperArm: [0, 0.35, 0.2],
      rightLowerArm: [0, 0, 1.3 + 0.35 * wave(t)],
      rightHand: [0, 0, 0.15 * wave(t)],
      head: [0, 0, -0.06],
    }),
  },
  nod: {
    duration: 1.1,
    pose: (t) => ({
      neck: [-0.12 * Math.abs(Math.sin((t * Math.PI) / 0.5)), 0, 0],
      head: [-0.22 * Math.abs(Math.sin((t * Math.PI) / 0.5)), 0, 0],
    }),
  },
  shrug: {
    duration: 1.6,
    pose: () => ({
      rightShoulder: [0, 0, 0.3],
      leftShoulder: [0, 0, -0.3],
      rightUpperArm: [0, 0.2, -0.95],
      leftUpperArm: [0, -0.2, 0.95],
      rightLowerArm: [0, 1.25, 0],
      leftLowerArm: [0, -1.25, 0],
      rightHand: [-0.5, 0, 0],
      leftHand: [-0.5, 0, 0],
      head: [0, 0, 0.12],
    }),
  },
  point: {
    duration: 1.8,
    pose: () => ({
      rightUpperArm: [0, 1.15, 0.05],
      rightLowerArm: [0, 0.1, 0],
      rightHand: [0, 0, 0],
    }),
  },
};

const FADE_IN = 0.3;
const FADE_OUT = 0.35;
const MAX_YAW = 1.1; // how far the head turns to look, radians
const euler = new THREE.Euler();
const q = new THREE.Quaternion();
const yawQ = new THREE.Quaternion();
const UP = new THREE.Vector3(0, 1, 0);

export class ProceduralGestures implements GesturePlayer {
  playing: string | null = null;
  private t = 0;
  private onDone: ((completed: boolean) => void) | undefined;
  private target: THREE.Vector3 | null = null;
  private yaw = 0;
  /** Bones changed last frame: what they were before, and what we left them at. */
  private touched = new Map<THREE.Object3D, { base: THREE.Quaternion; left: THREE.Quaternion }>();

  constructor(private readonly avatar: AvatarAdapter, private readonly gestures: Record<string, Gesture> = GESTURES) {}

  list(): string[] {
    return Object.keys(this.gestures);
  }

  play(name: string, onDone?: (completed: boolean) => void): boolean {
    if (!Object.hasOwn(this.gestures, name)) return false; // not 'constructor' and friends
    this.onDone?.(false);
    this.playing = name;
    this.t = 0;
    this.onDone = onDone;
    return true;
  }

  lookAt(target: THREE.Vector3 | null): void {
    this.target = target?.clone() ?? null;
  }

  update(dt: number): void {
    // Bones nothing else animates still hold last frame's offset: put them back first.
    for (const [node, { base, left }] of this.touched) if (node.quaternion.equals(left)) node.quaternion.copy(base);
    const before = new Map<THREE.Object3D, THREE.Quaternion>();
    const touch = (node: THREE.Object3D) => before.has(node) || before.set(node, node.quaternion.clone());
    this.apply(dt, touch);
    this.touched.clear();
    for (const [node, base] of before) this.touched.set(node, { base, left: node.quaternion.clone() });
  }

  private apply(dt: number, touch: (node: THREE.Object3D) => void): void {
    this.updateLook(dt, touch);
    const name = this.playing;
    if (!name) return;
    const g = this.gestures[name];
    this.t += dt;
    if (this.t >= g.duration) {
      const done = this.onDone;
      this.playing = null;
      this.onDone = undefined;
      done?.(true);
      return;
    }
    const w = smooth(Math.min(1, this.t / FADE_IN, (g.duration - this.t) / FADE_OUT));
    // VRM 1.0 and +Z-facing rigs: the same pose mirrored through the Y axis.
    const mirror = this.avatar.rig()?.facesNegativeZ === false;
    for (const [bone, [x, y, z]] of Object.entries(g.pose(this.t))) {
      const node = this.avatar.bone(bone);
      if (!node) continue;
      touch(node);
      q.setFromEuler(euler.set(x, y, z));
      if (mirror) q.set(-q.x, q.y, -q.z, q.w);
      node.quaternion.slerp(q, w);
    }
  }

  /** Turns neck and head about the vertical axis towards the target, on top of the clip. */
  private updateLook(dt: number, touch: (node: THREE.Object3D) => void): void {
    let want = 0;
    if (this.target) {
      const body = this.avatar.object;
      const dx = this.target.x - body.position.x;
      const dz = this.target.z - body.position.z;
      let d = Math.atan2(dx, dz) - body.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      want = Math.max(-MAX_YAW, Math.min(MAX_YAW, d));
    }
    this.yaw += (want - this.yaw) * Math.min(1, dt * 5);
    if (Math.abs(this.yaw) < 1e-3) return;
    // Rotation about the vertical axis looks the same in -Z and +Z facing rigs, so no mirroring here.
    for (const [bone, share] of [['neck', 0.4], ['head', 0.6]] as const) {
      const node = this.avatar.bone(bone);
      if (!node) continue;
      touch(node);
      node.quaternion.premultiply(yawQ.setFromAxisAngle(UP, this.yaw * share));
    }
  }
}

function smooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}
