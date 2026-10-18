import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { GESTURES, ProceduralGestures } from '../src/anim/ProceduralGestures';
import { FakeAvatar } from '../src/avatar/FakeAvatar';
import type { AvatarAdapter, ClientData, ClientType, MicCapture, ProtocolClient } from '../src/interfaces';
import { Downsampler } from '../src/mic/Downsampler';
import { PushToTalk } from '../src/mic/PushToTalk';
import { FakeMicCapture } from '../src/mic/WorkletMicCapture';
import { OfflineProtocolClient, encodeAudioFrame, parseAudioFrame } from '../src/net/WebSocketProtocolClient';

describe('mic audio', () => {
  it('downsamples 48 kHz to 16 kHz PCM16 in 20 ms frames, then flushes the rest', () => {
    const frames: Int16Array[] = [];
    const d = new Downsampler(48000, (f) => frames.push(f));
    const block = new Float32Array(128).fill(0.5);
    for (let i = 0; i < 10; i++) d.push(block); // 1280 samples -> 426.67 out
    expect(frames.map((f) => f.length)).toEqual([320]);
    expect(frames[0][0]).toBe(Math.round(0.5 * 32767));
    d.flush();
    expect(frames.map((f) => f.length)).toEqual([320, 107]);
  });

  it('round-trips a frame with an odd header length', () => {
    const pcm = new Int16Array([1, -2, 32767, -32768]);
    const f = parseAudioFrame(encodeAudioFrame(0x01, 7, 3, pcm))!;
    expect([f.kind, f.streamId, f.seq]).toEqual([1, 7, 3]);
    expect([...f.pcm]).toEqual([...pcm]);
  });
});

class RecordingNet extends OfflineProtocolClient {
  sent: [string, unknown][] = [];
  frames: ArrayBuffer[] = [];
  override send<T extends ClientType>(type: T, data: ClientData<T>): void {
    this.sent.push([type, data]);
  }
  override sendBinary(frame: ArrayBuffer): void {
    this.frames.push(frame);
  }
}

class ManualMic extends FakeMicCapture {
  emit(n = 1): void {
    for (let i = 0; i < n; i++) (this as unknown as { cbs: Set<(f: Int16Array) => void> }).cbs.forEach((cb) => cb(this.frame()));
  }
  override start(): void {} // frames only when the test emits them
}

describe('push to talk', () => {
  const ctx = {} as AudioContext;

  it('stops the avatar talking, streams frames for this press, then sends ptt up', async () => {
    const net = new RecordingNet();
    const mic = new ManualMic();
    let interrupted = 0;
    const ptt = new PushToTalk(mic, net as unknown as ProtocolClient, () => interrupted++, () => ctx, { tailMs: 0 });
    mic.emit(); // not pressed: nothing is sent
    await ptt.down();
    expect(interrupted).toBe(1);
    expect(ptt.state).toBe('talking');
    mic.emit(3);
    await ptt.up();
    expect(net.sent).toEqual([['ptt', { state: 'down', stream_id: 1 }], ['ptt', { state: 'up', stream_id: 1 }]]);
    expect(net.frames.map((f) => parseAudioFrame(f)!.seq)).toEqual([0, 1, 2]);
    expect(new Set(net.frames.map((f) => parseAudioFrame(f)!.streamId))).toEqual(new Set([1]));
    await ptt.down();
    expect(net.sent.at(-1)).toEqual(['ptt', { state: 'down', stream_id: 2 }]); // a new stream per press
  });

  it('only opens the mic on a press released during the permission prompt', async () => {
    const net = new RecordingNet();
    let release: () => void = () => {};
    const mic: MicCapture = Object.assign(new ManualMic(), {
      ready: false,
      open(): Promise<void> {
        return new Promise<void>((r) => (release = () => ((mic as { ready: boolean }).ready = true) && r()));
      },
    });
    const ptt = new PushToTalk(mic, net as unknown as ProtocolClient, () => {}, () => ctx, { tailMs: 0 });
    const pressed = ptt.down();
    expect(ptt.state).toBe('opening');
    await ptt.up(); // finger lifted while the browser asks for permission
    release();
    await pressed;
    expect(ptt.state).toBe('idle');
    expect(net.sent).toEqual([]);
  });

  it('drops a release that was cancelled during its tail', async () => {
    const net = new RecordingNet();
    const mic = new ManualMic();
    const ptt = new PushToTalk(mic, net as unknown as ProtocolClient, () => {}, () => ctx, { tailMs: 20 });
    await ptt.down();
    const released = ptt.up();
    ptt.cancel(); // tab hidden while the tail was recording
    await ptt.down(); // and a new press before the old release finished
    await released;
    expect(ptt.state).toBe('talking');
    expect(net.sent).toEqual([['ptt', { state: 'down', stream_id: 1 }], ['ptt', { state: 'down', stream_id: 2 }]]);
  });

  it('opens the mic once when pressed again during the permission prompt', async () => {
    const net = new RecordingNet();
    let opens = 0;
    let release: () => void = () => {};
    const mic: MicCapture = Object.assign(new ManualMic(), {
      ready: false,
      open(): Promise<void> {
        opens++;
        return new Promise<void>((r) => (release = () => ((mic as { ready: boolean }).ready = true) && r()));
      },
    });
    const ptt = new PushToTalk(mic, net as unknown as ProtocolClient, () => {}, () => ctx, { tailMs: 0 });
    const first = ptt.down();
    await ptt.up();
    const second = ptt.down(); // pressed again, the prompt still up
    release();
    await Promise.all([first, second]);
    expect(opens).toBe(1);
    expect(ptt.state).toBe('talking');
    expect(net.sent).toEqual([['ptt', { state: 'down', stream_id: 1 }]]); // only the press still held
  });

  it('reports a mic that cannot open', async () => {
    const mic = Object.assign(new ManualMic(), { open: () => Promise.reject(new Error('denied')) });
    const errors: unknown[] = [];
    const ptt = new PushToTalk(mic, new RecordingNet() as unknown as ProtocolClient, () => {}, () => ctx);
    ptt.onError = (e) => errors.push(e);
    await ptt.down();
    expect(ptt.state).toBe('idle');
    expect(String(errors[0])).toContain('denied');
  });
});

/** Humanoid-ish bones that nothing else animates, so leftovers would show. */
function rigged(facesNegativeZ = true): AvatarAdapter {
  const a = new FakeAvatar();
  const bones = new Map<string, THREE.Object3D>();
  for (const name of ['neck', 'head', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand']) bones.set(name, new THREE.Object3D());
  return Object.assign(a, {
    bone: (n: string) => bones.get(n) ?? null,
    rig: () => ({ root: a.object, nodeName: () => null, hipsHeight: 1, facesNegativeZ }),
  });
}

describe('gestures', () => {
  it('blends a wave over the upper body, reports the end and leaves the bones as they were', () => {
    const avatar = rigged();
    const g = new ProceduralGestures(avatar);
    const done: boolean[] = [];
    expect(g.play('wave', (c) => done.push(c))).toBe(true);
    expect(g.play('moonwalk')).toBe(false);
    expect(g.play('constructor')).toBe(false); // inherited from Object, not a gesture
    for (let t = 0; t < 1; t += 1 / 30) g.update(1 / 30);
    const forearm = avatar.bone('rightLowerArm')!;
    expect(forearm.quaternion.angleTo(new THREE.Quaternion())).toBeGreaterThan(1); // raised
    for (let t = 0; t < GESTURES.wave.duration; t += 1 / 30) g.update(1 / 30);
    expect(done).toEqual([true]);
    expect(g.playing).toBeNull();
    expect(forearm.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(1e-6);
  });

  it('reports a gesture replaced by another', () => {
    const g = new ProceduralGestures(rigged());
    const done: boolean[] = [];
    g.play('nod', (c) => done.push(c));
    g.play('shrug');
    expect(done).toEqual([false]);
  });

  it('mirrors poses for rigs that face +Z', () => {
    const neg = rigged(true);
    const pos = rigged(false);
    for (const a of [neg, pos]) {
      const g = new ProceduralGestures(a);
      g.play('point');
      for (let i = 0; i < 20; i++) g.update(1 / 30);
    }
    const qa = neg.bone('rightUpperArm')!.quaternion;
    const qb = pos.bone('rightUpperArm')!.quaternion;
    expect(qb.x).toBeCloseTo(-qa.x);
    expect(qb.y).toBeCloseTo(qa.y);
    expect(qb.z).toBeCloseTo(-qa.z);
  });

  it('turns the head towards a look target and back', () => {
    const avatar = rigged();
    const g = new ProceduralGestures(avatar);
    g.lookAt(new THREE.Vector3(5, 1.3, 0)); // to the avatar's side (it faces +Z)
    for (let i = 0; i < 60; i++) g.update(1 / 30);
    const yaw = new THREE.Euler().setFromQuaternion(avatar.bone('head')!.quaternion, 'YXZ').y;
    expect(yaw).toBeGreaterThan(0.5);
    g.lookAt(null);
    for (let i = 0; i < 90; i++) g.update(1 / 30);
    expect(avatar.bone('head')!.quaternion.angleTo(new THREE.Quaternion())).toBeLessThan(0.01);
  });
});
