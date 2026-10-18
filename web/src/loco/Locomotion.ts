import type * as THREE from 'three';
import type { AnimationLibrary, Vec2 } from '../interfaces';

export type LocoState = 'idle' | 'turning' | 'walking' | 'arriving';

export interface WalkCommand {
  cmdId: string;
  /** Waypoints from the navigation provider; the first is the current position. */
  path: Vec2[];
  location: string | null;
  /** Heading to turn to on arrival, degrees (0 faces +Z); null keeps the walking direction. */
  faceDeg: number | null;
  speed: 'walk' | 'run';
}

export interface LocoOptions {
  walkSpeed: number; // m/s, used when the animation clip has no ground speed
  runSpeed: number;
  turnRateDeg: number; // per second
  /** Turn in place before setting off when the first leg is further off than this. */
  turnInPlaceDeg: number;
  slowRadius: number; // start decelerating this far from the end, metres
}

const DEFAULTS: LocoOptions = { walkSpeed: 1.0, runSpeed: 2.4, turnRateDeg: 300, turnInPlaceDeg: 70, slowRadius: 0.5 };
const TAU = Math.PI * 2;

/** Angle from a to b in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d <= -Math.PI) d += TAU;
  return d;
}

/** Heading (rotation.y) that faces from `from` towards `to`: 0 faces +Z. */
export function headingTo(from: Vec2, to: Vec2): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

/**
 * Moves the avatar root along a path: turn towards the first leg, walk with the walk clip's
 * playback rate matched to actual speed (no foot sliding), slow down near the end, then turn to
 * the location's heading. Reports arrival through `onArrived`.
 */
export class Locomotion {
  state: LocoState = 'idle';
  cmd: WalkCommand | null = null;
  onArrived: (cmd: WalkCommand) => void = () => {};
  onStateChange: (s: LocoState) => void = () => {};
  private wp = 1;
  private speed = 0;
  private readonly opts: LocoOptions;

  constructor(
    private readonly body: THREE.Object3D,
    private readonly anim: AnimationLibrary,
    opts: Partial<LocoOptions> = {},
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  get position(): Vec2 {
    return { x: this.body.position.x, z: this.body.position.z };
  }

  get headingDeg(): number {
    return ((this.body.rotation.y * 180) / Math.PI + 360) % 360;
  }

  /** Start a walk; returns the command it replaced, if any. */
  start(cmd: WalkCommand): WalkCommand | null {
    const replaced = this.cmd;
    this.cmd = cmd;
    this.wp = 1;
    const first = cmd.path[1];
    const off = first ? Math.abs(angleDelta(this.body.rotation.y, headingTo(this.position, first))) : 0;
    this.setState(!first ? 'arriving' : off > (this.opts.turnInPlaceDeg * Math.PI) / 180 && this.speed < 0.1 ? 'turning' : 'walking');
    return replaced;
  }

  /** Stop where we are; returns the command that was running. */
  stop(): WalkCommand | null {
    const cmd = this.cmd;
    this.cmd = null;
    this.speed = 0;
    this.setState('idle');
    return cmd;
  }

  get moving(): boolean {
    return this.state === 'walking' || this.state === 'turning';
  }

  update(dt: number): void {
    const cmd = this.cmd;
    if (!cmd) return;
    const loco = cmd.speed === 'run' ? 'run' : 'walk';
    const clipSpeed = this.anim.groundSpeed(loco);
    // Walk at the speed the clip was animated for, so stride and ground speed agree.
    const cruise = clipSpeed ?? (cmd.speed === 'run' ? this.opts.runSpeed : this.opts.walkSpeed);

    if (this.state === 'turning' || this.state === 'walking') {
      const target = cmd.path[this.wp];
      const pos = this.position;
      const want = headingTo(pos, target);
      const err = angleDelta(this.body.rotation.y, want);
      this.turn(err, dt);

      if (this.state === 'turning') {
        // Step around on the spot with a slow walk cycle until roughly facing the first leg.
        this.anim.setTimeScale(0.5);
        if (Math.abs(err) < 0.25) this.setState('walking');
        return;
      }

      const remaining = this.remaining();
      const ease = Math.min(1, Math.max(0.3, remaining / this.opts.slowRadius));
      const align = Math.max(0.2, Math.cos(err)); // slow down in sharp corners
      const desired = cruise * ease * align;
      this.speed += (desired - this.speed) * Math.min(1, dt * 6);
      this.anim.setTimeScale(clipSpeed ? Math.max(0.3, this.speed / clipSpeed) : 1);

      let step = this.speed * dt;
      while (step > 0 && this.cmd) {
        const t = cmd.path[this.wp];
        const d = Math.hypot(t.x - this.body.position.x, t.z - this.body.position.z);
        if (d > step) {
          this.body.position.x += ((t.x - this.body.position.x) / d) * step;
          this.body.position.z += ((t.z - this.body.position.z) / d) * step;
          step = 0;
        } else {
          this.body.position.x = t.x;
          this.body.position.z = t.z;
          step -= d;
          if (++this.wp >= cmd.path.length) {
            this.speed = 0;
            this.setState('arriving');
            break;
          }
        }
      }
      return;
    }

    if (this.state === 'arriving') {
      const err = cmd.faceDeg === null ? 0 : angleDelta(this.body.rotation.y, (cmd.faceDeg * Math.PI) / 180);
      this.turn(err, dt);
      if (Math.abs(err) < 0.02) {
        this.cmd = null;
        this.setState('idle');
        this.onArrived(cmd);
      }
    }
  }

  private turn(err: number, dt: number): void {
    const max = ((this.opts.turnRateDeg * Math.PI) / 180) * dt;
    this.body.rotation.y += Math.max(-max, Math.min(max, err));
  }

  private remaining(): number {
    const path = this.cmd!.path;
    let d = Math.hypot(path[this.wp].x - this.body.position.x, path[this.wp].z - this.body.position.z);
    for (let i = this.wp; i < path.length - 1; i++) d += Math.hypot(path[i + 1].x - path[i].x, path[i + 1].z - path[i].z);
    return d;
  }

  private setState(s: LocoState): void {
    if (s === this.state) return;
    this.state = s;
    this.onStateChange(s);
  }
}

export function pathLength(path: Vec2[]): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) d += Math.hypot(path[i].x - path[i - 1].x, path[i].z - path[i - 1].z);
  return d;
}
