import * as THREE from 'three';
import type { AvatarAdapter, TapPlayer } from '../interfaces';

type Side = 'left' | 'right';

/** Seconds per phase: reach out, press in, hold on the glass, let go, bring the arm back. */
const REACH = 0.5;
const PRESS = 0.12;
const HOLD = 0.14;
const RELEASE = 0.12;
const RETRACT = 0.5;
const DURATION = REACH + PRESS + HOLD + RELEASE + RETRACT;
/** How far behind the glass the fingertip hovers before and after the press, metres. */
const HOVER = 0.06;
/** Keep the arm a little short of straight, so the elbow never snaps. */
const REACH_MARGIN = 0.96;
const CURL: Record<string, number> = { Proximal: 1.25, Intermediate: 1.35, Distal: 0.9 };
const DOWN = new THREE.Vector3(0, -1, 0);

const v = () => new THREE.Vector3();
const smooth = (x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

/**
 * Taps the screen with the index finger: a two-bone IK reach of the nearer arm to a point on the
 * glass, finger pointing, other fingers curled, blended over whatever clip the body plays.
 * Works in world space, so it does not care which way the rig's bones face.
 */
export class IkScreenTap implements TapPlayer {
  playing = false;
  private t = 0;
  private side: Side = 'right';
  private readonly target = v();
  private readonly normal = v();
  private onContact: ((p: THREE.Vector3) => void) | undefined;
  private onDone: ((completed: boolean) => void) | undefined;
  private contacted = false;
  /** Bones changed last frame: what they were before, and what we left them at. */
  private touched = new Map<THREE.Object3D, { base: THREE.Quaternion; left: THREE.Quaternion }>();

  constructor(private readonly avatar: AvatarAdapter) {}

  tap(target: THREE.Vector3, normal: THREE.Vector3, onContact: (p: THREE.Vector3) => void, onDone?: (completed: boolean) => void): THREE.Vector3 | null {
    const n = normal.clone().normalize();
    const side = this.nearerSide(target);
    const arm = side && this.arm(side);
    if (!arm) return null;
    // Wrists that put the fingertip on the glass lie on a plane `hand` behind it; the shoulder
    // reaches a disc of that plane. Move the target into the disc.
    const reach = (arm.upper + arm.lower) * REACH_MARGIN;
    const wrist = target.clone().addScaledVector(n, -arm.hand);
    const depth = wrist.clone().sub(arm.shoulder).dot(n);
    if (Math.abs(depth) >= reach) return null; // the glass is out of reach
    const centre = arm.shoulder.clone().addScaledVector(n, depth);
    const offset = wrist.sub(centre);
    const r = Math.sqrt(reach * reach - depth * depth);
    if (offset.length() > r) offset.setLength(r);
    const pressed = centre.add(offset).addScaledVector(n, arm.hand);

    this.onDone?.(false);
    Object.assign(this, { playing: true, t: 0, side, onContact, onDone, contacted: false });
    this.target.copy(pressed);
    this.normal.copy(n);
    return pressed.clone();
  }

  update(dt: number): void {
    // Bones nothing else animates still hold last frame's offset: put them back first.
    for (const [node, { base, left }] of this.touched) if (node.quaternion.equals(left)) node.quaternion.copy(base);
    this.touched.clear();
    if (!this.playing) return;
    this.t += dt;
    if (this.t >= DURATION) {
      const done = this.onDone;
      this.playing = false;
      this.onDone = this.onContact = undefined;
      done?.(true);
      return;
    }
    const t = this.t;
    const w = t < REACH ? smooth(t / REACH) : smooth((DURATION - t) / RETRACT);
    const pressStart = REACH;
    const releaseStart = REACH + PRESS + HOLD;
    const depth =
      t < pressStart ? HOVER
      : t < pressStart + PRESS ? HOVER * (1 - smooth((t - pressStart) / PRESS))
      : t < releaseStart ? 0
      : HOVER * smooth((t - releaseStart) / RELEASE);
    if (!this.contacted && t >= pressStart + PRESS) {
      this.contacted = true;
      this.onContact?.(this.target.clone());
    }
    this.solve(this.target.clone().addScaledVector(this.normal, -depth), w);
  }

  /** Pose the arm so the fingertip sits on `tip`, blended in by `w`. */
  private solve(tip: THREE.Vector3, w: number): void {
    const s = this.side;
    const arm = this.arm(s);
    if (!arm) return;
    const { upperArm, lowerArm, hand } = arm.nodes;
    const fingers = this.fingers(s);
    const all = [upperArm, lowerArm, hand, ...fingers.map((f) => f.node)];
    const base = all.map((b) => b.quaternion.clone());

    const n = this.normal;
    const wrist = tip.clone().addScaledVector(n, -arm.hand);
    const S = arm.shoulder;
    const toWrist = wrist.clone().sub(S);
    const d = Math.min(Math.max(toWrist.length(), 1e-3), (arm.upper + arm.lower) * 0.999);
    const u = toWrist.normalize();
    // Elbow bends down, out to the side and a little back, like a person pressing a button.
    const out = S.clone().sub(this.avatar.object.getWorldPosition(v())).setY(0).normalize();
    const pole = DOWN.clone().add(out.multiplyScalar(0.6)).addScaledVector(n, -0.3);
    pole.addScaledVector(u, -pole.dot(u)).normalize();
    const a = (arm.upper ** 2 - arm.lower ** 2 + d * d) / (2 * d);
    const elbow = S.clone().addScaledVector(u, a).addScaledVector(pole, Math.sqrt(Math.max(0, arm.upper ** 2 - a * a)));

    aim(upperArm, lowerArm, elbow);
    aim(lowerArm, hand, wrist);
    aim(hand, null, tip, arm.tipLocal);
    for (const f of fingers) f.node.quaternion.copy(f.pose);

    all.forEach((b, i) => {
      const ik = b.quaternion.clone();
      b.quaternion.copy(base[i]).slerp(ik, w);
      this.touched.set(b, { base: base[i], left: b.quaternion.clone() });
    });
  }

  private nearerSide(target: THREE.Vector3): Side | null {
    const l = this.avatar.bone('leftUpperArm');
    const r = this.avatar.bone('rightUpperArm');
    if (!l || !r) return l ? 'left' : r ? 'right' : null;
    return target.distanceToSquared(l.getWorldPosition(v())) < target.distanceToSquared(r.getWorldPosition(v())) ? 'left' : 'right';
  }

  /** Arm bones, their lengths and the shoulder in world space, from the current pose. */
  private arm(side: Side) {
    const upperArm = this.avatar.bone(`${side}UpperArm`);
    const lowerArm = this.avatar.bone(`${side}LowerArm`);
    const hand = this.avatar.bone(`${side}Hand`);
    if (!upperArm || !lowerArm || !hand) return null;
    upperArm.updateWorldMatrix(true, true);
    const S = upperArm.getWorldPosition(v());
    const E = lowerArm.getWorldPosition(v());
    const W = hand.getWorldPosition(v());
    // Fingertip in the hand's space: the index finger's bones, extended by its last segment.
    const p1 = this.avatar.bone(`${side}IndexProximal`);
    const p2 = this.avatar.bone(`${side}IndexIntermediate`);
    const p3 = this.avatar.bone(`${side}IndexDistal`);
    const tipLocal =
      p1 && p2 && p3
        ? p1.position.clone().add(p2.position).add(p3.position).addScaledVector(p3.position, 0.9)
        : hand.worldToLocal(W.clone().add(W.clone().sub(E).setLength(0.12)));
    const handLen = tipLocal.length() * hand.getWorldScale(v()).x;
    return { nodes: { upperArm, lowerArm, hand }, shoulder: S, upper: S.distanceTo(E), lower: E.distanceTo(W), hand: handLen, tipLocal };
  }

  /** Index finger straight, the others curled into a fist, as local rotations. */
  private fingers(side: Side): { node: THREE.Object3D; pose: THREE.Quaternion }[] {
    const out: { node: THREE.Object3D; pose: THREE.Quaternion }[] = [];
    for (const finger of ['Index', 'Middle', 'Ring', 'Little']) {
      let axis: THREE.Vector3 | null = null;
      for (const seg of ['Proximal', 'Intermediate', 'Distal']) {
        const node = this.avatar.bone(`${side}${finger}${seg}`);
        if (!node) continue;
        if (finger === 'Index') {
          out.push({ node, pose: new THREE.Quaternion() });
          continue;
        }
        // Normalized bones rest in a T-pose with palms down: curling turns the finger towards -Y.
        const child = node.children.find((c) => c.position.lengthSq() > 0);
        if (child) axis = child.position.clone().normalize().cross(DOWN).normalize();
        if (axis && axis.lengthSq() > 0) out.push({ node, pose: new THREE.Quaternion().setFromAxisAngle(axis, CURL[seg]) });
      }
    }
    return out;
  }
}

const _q = new THREE.Quaternion();
const _pq = new THREE.Quaternion();
/**
 * Rotate `bone` so its child (or a point in its own space) points at `to`, world space.
 * Keeps the parent as it is and refreshes the bone's subtree.
 */
function aim(bone: THREE.Object3D, child: THREE.Object3D | null, to: THREE.Vector3, local?: THREE.Vector3): void {
  const origin = bone.getWorldPosition(v());
  const from = child ? child.getWorldPosition(v()) : bone.localToWorld(local!.clone());
  const a = from.sub(origin).normalize();
  const b = to.clone().sub(origin).normalize();
  if (a.lengthSq() === 0 || b.lengthSq() === 0) return;
  const world = bone.getWorldQuaternion(new THREE.Quaternion());
  const turned = _q.setFromUnitVectors(a, b).multiply(world);
  const parent = bone.parent ? bone.parent.getWorldQuaternion(_pq).invert() : _pq.identity();
  bone.quaternion.copy(parent.multiply(turned));
  bone.updateWorldMatrix(false, true);
}
