import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { IkScreenTap } from '../src/anim/IkScreenTap';
import { FakeAvatar } from '../src/avatar/FakeAvatar';
import type { AvatarAdapter, ScreenTouch } from '../src/interfaces';
import { GlassPanel } from '../src/touch/GlassPanel';
import { RippleEffect } from '../src/touch/RippleEffect';
import { ScreenGlass } from '../src/touch/ScreenGlass';

/** T-posed arms with fingers, facing +Z: what normalized VRM bones look like at rest. */
function armed(): AvatarAdapter {
  const a = new FakeAvatar();
  const bones = new Map<string, THREE.Object3D>();
  const add = (name: string, parent: THREE.Object3D, x: number, y = 0) => {
    const b = new THREE.Object3D();
    b.position.set(x, y, 0);
    parent.add(b);
    bones.set(name, b);
    return b;
  };
  const chest = add('chest', a.object, 0, 1.2);
  for (const [side, s] of [['right', -1], ['left', 1]] as const) {
    const hand = add(`${side}Hand`, add(`${side}LowerArm`, add(`${side}UpperArm`, chest, 0.18 * s, 0.2), 0.25 * s), 0.25 * s);
    for (const finger of ['Index', 'Middle']) {
      add(`${side}${finger}Distal`, add(`${side}${finger}Intermediate`, add(`${side}${finger}Proximal`, hand, 0.05 * s), 0.03 * s), 0.02 * s);
    }
  }
  return Object.assign(a, { bone: (n: string) => bones.get(n) ?? null });
}

/** Where the index fingertip is, the way IkScreenTap measures it. */
function fingertip(a: AvatarAdapter, side: 'left' | 'right'): THREE.Vector3 {
  const [p1, p2, p3] = ['Proximal', 'Intermediate', 'Distal'].map((s) => a.bone(`${side}Index${s}`)!.position);
  const local = p1.clone().add(p2).add(p3).addScaledVector(p3, 0.9);
  a.object.updateMatrixWorld(true);
  return a.bone(`${side}Hand`)!.localToWorld(local);
}

const FORWARD = new THREE.Vector3(0, 0, 1);

describe('tapping the screen', () => {
  it('puts the fingertip on the target with the nearer hand, then puts the arm back', () => {
    const a = armed();
    const tap = new IkScreenTap(a);
    const target = new THREE.Vector3(-0.15, 1.3, 0.35);
    const contacts: THREE.Vector3[] = [];
    const done: boolean[] = [];
    const pressed = tap.tap(target, FORWARD, (p) => contacts.push(p), (c) => done.push(c))!;
    expect(pressed.distanceTo(target)).toBeLessThan(1e-6); // within reach: unchanged
    while (!contacts.length) tap.update(1 / 60);
    expect(fingertip(a, 'right').distanceTo(target)).toBeLessThan(0.01);
    while (tap.playing) tap.update(1 / 60);
    expect(done).toEqual([true]);
    for (const n of ['rightUpperArm', 'rightLowerArm', 'rightHand', 'rightMiddleProximal']) {
      expect(a.bone(n)!.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
    }
  });

  it('moves a target out of reach onto the nearest spot it can press', () => {
    const a = armed();
    const tap = new IkScreenTap(a);
    const pressed = tap.tap(new THREE.Vector3(2, 1.4, 0.3), FORWARD, () => {})!;
    expect(pressed.z).toBeCloseTo(0.3); // still on the glass
    expect(pressed.x).toBeGreaterThan(0); // left hand, the nearer one
    expect(pressed.x).toBeLessThan(0.75);
    expect(tap.tap(new THREE.Vector3(0, 1.4, 3), FORWARD, () => {})).toBeNull(); // glass too far away
  });

  it('can be called off mid-reach, giving the arm back to the clip', () => {
    const a = armed();
    const tap = new IkScreenTap(a);
    const done: boolean[] = [];
    const contacts: unknown[] = [];
    tap.tap(new THREE.Vector3(-0.15, 1.3, 0.35), FORWARD, (p) => contacts.push(p), (c) => done.push(c));
    for (let i = 0; i < 20; i++) tap.update(1 / 60);
    expect(a.bone('rightUpperArm')!.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(0.1);
    tap.cancel();
    tap.cancel(); // once only
    expect(done).toEqual([false]);
    tap.update(1 / 60);
    expect(tap.playing).toBe(false);
    expect(contacts).toHaveLength(0);
    expect(a.bone('rightUpperArm')!.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it('reports a tap replaced by another', () => {
    const tap = new IkScreenTap(armed());
    const done: boolean[] = [];
    tap.tap(new THREE.Vector3(-0.1, 1.3, 0.3), FORWARD, () => {}, (c) => done.push(c));
    tap.update(0.1);
    tap.tap(new THREE.Vector3(0.1, 1.3, 0.3), FORWARD, () => {});
    expect(done).toEqual([false]);
  });
});

describe('the screen as glass', () => {
  const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 50);
  camera.position.set(0, 1.3, 2);
  camera.lookAt(0, 1.3, 0);
  camera.updateMatrixWorld();
  const subject = new THREE.Object3D();

  it('maps screen positions to glass points in front of the avatar and back', () => {
    const glass = new ScreenGlass(camera, subject, null, 0.4);
    expect(glass.pointAt(0.5, 0.5)!.distanceTo(new THREE.Vector3(0, 1.3, 0.4))).toBeLessThan(1e-6);
    const p = glass.pointAt(0.2, 0.7)!;
    expect(p.z).toBeCloseTo(0.4);
    expect(p.x).toBeLessThan(0);
    expect(p.y).toBeLessThan(1.3);
    const back = glass.screenOf(p);
    expect(back.x).toBeCloseTo(0.2);
    expect(back.y).toBeCloseTo(0.7);
  });

  it('draws a ripple for touches from either side and tells the listeners', () => {
    const fx = new RippleEffect();
    const glass = new ScreenGlass(camera, subject, fx, 0.4);
    const seen: ScreenTouch[] = [];
    const off = glass.onTouch((t) => seen.push(t));
    glass.touch('user', glass.pointAt(0.3, 0.3)!);
    glass.touch('avatar', glass.pointAt(0.6, 0.5)!);
    expect(seen.map((t) => t.source)).toEqual(['user', 'avatar']);
    expect(seen[1].x).toBeCloseTo(0.6);
    expect(fx.active).toBe(2);
    fx.update(0.3);
    expect(fx.object.children).toHaveLength(2);
    fx.update(3);
    expect(fx.active).toBe(0);
    expect(fx.object.children).toHaveLength(0);
    off();
    glass.touch('user', glass.pointAt(0.5, 0.5)!);
    expect(seen).toHaveLength(2);
  });
});

describe('the panel on the glass', () => {
  const controls = [
    { id: 'lights', label: 'Lights', kind: 'toggle' as const, on: true },
    { id: 'wave', label: 'Wave' },
  ];
  const facing = new THREE.Quaternion();
  const make = () => {
    const p = new GlassPanel(controls, { width: 0.3, height: 0.1, fadeS: 0.2 });
    p.place(new THREE.Vector3(0, 1.1, 0.4), facing);
    return p;
  };

  it('fades in when asked, and only takes touches once mostly shown', () => {
    const p = make();
    const at = p.pointOf('wave')!;
    expect(p.object.visible).toBe(false);
    expect(p.controlAt(at)).toBeNull();
    p.show(true);
    p.update(0.05);
    expect(p.object.visible).toBe(true);
    expect(p.touchable).toBe(false);
    p.update(0.1);
    expect(p.controlAt(at)?.id).toBe('wave');
    expect(p.controlAt(new THREE.Vector3(0, 1.1 + 0.2, 0.4))).toBeNull(); // above the panel
    p.show(false);
    expect(p.controlAt(at)).toBeNull(); // fading out: no more touches
    p.update(0.3);
    expect(p.object.visible).toBe(false);
  });

  it('flips toggles from either side and refuses presses while hidden', () => {
    const p = make();
    expect(p.press('lights', 'user')).toBeNull();
    p.show(true);
    p.update(1);
    expect(p.press('lights', 'user')!.control.on).toBe(false);
    expect(p.press('lights', 'avatar')!.control.on).toBe(true);
    expect(p.press('wave', 'avatar')!.control.on).toBeUndefined();
    expect(p.press('nope', 'user')).toBeNull();
  });

  it('puts each control where a fingertip tapping its centre lands', () => {
    const p = make();
    p.show(true);
    p.update(1);
    const tap = new IkScreenTap(armed());
    const seen: string[] = [];
    for (const c of controls) {
      const target = p.pointOf(c.id)!;
      expect(target.z).toBeCloseTo(0.4); // on the glass
      const pressed = tap.tap(target, FORWARD, (pt) => seen.push(p.controlAt(pt)?.id ?? 'missed'))!;
      expect(pressed.distanceTo(target)).toBeLessThan(1e-6); // within reach
      while (tap.playing) tap.update(1 / 60);
    }
    expect(seen).toEqual(['lights', 'wave']);
  });
});
