import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { retargetClip } from '../src/anim/retarget';
import type { AnimationLibrary, AudioPlayer, HumanoidRig } from '../src/interfaces';
import { Locomotion, angleDelta } from '../src/loco/Locomotion';
import { parseAudioFrame } from '../src/net/WebSocketProtocolClient';
import { SpeechPlayer } from '../src/speech/SpeechPlayer';
import { TimelineLipSync } from '../src/speech/TimelineLipSync';

class StubAnim implements AnimationLibrary {
  current: string | null = 'idle';
  scale = 1;
  async load(): Promise<void> {}
  list(): string[] {
    return ['idle', 'walk'];
  }
  play(name: string): void {
    this.current = name;
  }
  groundSpeed(name: string): number | null {
    return name === 'walk' ? 1.2 : null;
  }
  setTimeScale(s: number): void {
    this.scale = s;
  }
  update(): void {}
}

describe('locomotion', () => {
  it('follows the path, matches clip speed and turns to the location heading on arrival', () => {
    const body = new THREE.Object3D();
    const anim = new StubAnim();
    const loco = new Locomotion(body, anim);
    const arrived: string[] = [];
    loco.onArrived = (c) => arrived.push(c.cmdId);
    loco.start({ cmdId: 'c1', path: [{ x: 0, z: 0 }, { x: 0, z: 2 }, { x: 2, z: 2 }], location: 'desk', faceDeg: 180, speed: 'walk' });
    expect(loco.state).toBe('walking'); // first leg is straight ahead (+Z)
    let maxScale = 0;
    for (let i = 0; i < 600 && !arrived.length; i++) {
      loco.update(1 / 60);
      maxScale = Math.max(maxScale, anim.scale);
    }
    expect(arrived).toEqual(['c1']);
    expect(body.position.x).toBeCloseTo(2);
    expect(body.position.z).toBeCloseTo(2);
    expect(Math.abs(angleDelta(body.rotation.y, Math.PI))).toBeLessThan(0.03);
    expect(maxScale).toBeCloseTo(1, 1); // cruising at the clip's own speed
    expect(loco.state).toBe('idle');
  });

  it('turns in place first when the target is behind, and reports what a new walk replaced', () => {
    const loco = new Locomotion(new THREE.Object3D(), new StubAnim());
    loco.start({ cmdId: 'a', path: [{ x: 0, z: 0 }, { x: 0, z: -2 }], location: null, faceDeg: null, speed: 'walk' });
    expect(loco.state).toBe('turning');
    const replaced = loco.start({ cmdId: 'b', path: [{ x: 0, z: 0 }, { x: 1, z: 0 }], location: null, faceDeg: null, speed: 'walk' });
    expect(replaced?.cmdId).toBe('a');
    expect(loco.stop()?.cmdId).toBe('b');
  });
});

describe('lip sync', () => {
  it('follows the audio clock and blends into the next viseme', () => {
    const ls = new TimelineLipSync({ blendS: 0.05, gain: 1 });
    ls.start(10, [{ t: 0, v: 'sil' }, { t: 100, v: 'aa' }, { t: 300, v: 'PP' }, { t: 400, v: 'sil' }]);
    expect(ls.weights(9.9)).toEqual({});
    expect(ls.weights(10.2).aa).toBe(1);
    const mid = ls.weights(10.275); // halfway through the blend from aa to PP (closed lips)
    expect(mid.aa).toBeCloseTo(0.5);
    expect(ls.weights(10.5)).toEqual({});
  });
});

class FakeAudio implements AudioPlayer {
  context = { currentTime: 0 } as AudioContext;
  queued: number[] = [];
  stopped = 0;
  private head = 0;
  async unlock(): Promise<void> {}
  enqueue(pcm: Int16Array, rate: number): number {
    const at = Math.max(this.context.currentTime + 0.05, this.head);
    this.head = at + pcm.length / rate;
    this.queued.push(at);
    return at;
  }
  stop(): void {
    this.stopped++;
    this.head = 0;
  }
}

describe('speech player', () => {
  const frame = (streamId: number, seq: number, samples: number) => {
    const buf = new ArrayBuffer(9 + samples * 2);
    const view = new DataView(buf);
    view.setUint8(0, 2);
    view.setUint32(1, streamId);
    view.setUint32(5, seq);
    return parseAudioFrame(buf)!;
  };

  it('parses big-endian frame headers', () => {
    expect(frame(258, 3, 4)).toMatchObject({ kind: 2, streamId: 258, seq: 3 });
    expect(frame(1, 0, 4).pcm.length).toBe(4);
    expect(parseAudioFrame(new ArrayBuffer(4))).toBeNull();
  });

  it('schedules chunks back to back and reports started and finished', () => {
    const audio = new FakeAudio();
    const sent: [string, unknown][] = [];
    const sp = new SpeechPlayer(audio, new TimelineLipSync(), (t, d) => sent.push([t, d]));
    const header = (stream_id: number, seq: number) =>
      ({ type: 'speech_chunk', data: { utterance_id: 'u1', stream_id, seq, sample_rate: 1000, duration_ms: 500, visemes: [], last: false } }) as never;
    sp.onStart({ type: 'speech_start', data: { utterance_id: 'u1', text: 'hi' } } as never);
    sp.onChunk(header(7, 0));
    sp.onAudio(frame(7, 0, 500));
    sp.onChunk(header(8, 1));
    sp.onAudio(frame(8, 1, 500));
    sp.onEnd({ type: 'speech_end', data: { utterance_id: 'u1', total_chunks: 2 } } as never);
    expect(audio.queued).toEqual([0.05, 0.55]);
    expect(sent.map((s) => s[0])).toEqual(['speech_started']);
    expect(sp.talking).toBe(true);
    (audio.context as { currentTime: number }).currentTime = 1.06;
    sp.update();
    expect(sent[1]).toEqual(['speech_finished', { utterance_id: 'u1', interrupted: false, played_ms: 1000 }]);
    expect(sp.talking).toBe(false);
  });

  it('reports how much was heard when interrupted', () => {
    const audio = new FakeAudio();
    const sent: [string, unknown][] = [];
    const sp = new SpeechPlayer(audio, new TimelineLipSync(), (t, d) => sent.push([t, d]));
    sp.onStart({ type: 'speech_start', data: { utterance_id: 'u2', text: 'hi' } } as never);
    sp.onChunk({ type: 'speech_chunk', data: { utterance_id: 'u2', stream_id: 1, seq: 0, sample_rate: 1000, duration_ms: 1000, last: false } } as never);
    sp.onAudio(frame(1, 0, 1000));
    (audio.context as { currentTime: number }).currentTime = 0.45;
    sp.interrupt();
    expect(audio.stopped).toBe(1);
    expect(sent.at(-1)).toEqual(['speech_finished', { utterance_id: 'u2', interrupted: true, played_ms: 400 }]);
  });
});

describe('retargeting', () => {
  // Source skeleton like the UAL one: a Z-up root rotated to Y-up, hips, and a left arm along +X.
  function source() {
    const root = new THREE.Object3D();
    root.name = 'root';
    root.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
    const hips = new THREE.Object3D();
    hips.name = 'DEF-hips';
    hips.position.set(0, 0, 1); // 1 m up in Z-up space
    hips.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2); // back to Y-up
    const arm = new THREE.Object3D();
    arm.name = 'DEF-upper_armL';
    arm.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 2); // bone points along +X
    root.add(hips);
    hips.add(arm);
    return root;
  }
  const rig = (facesNegativeZ: boolean): HumanoidRig => ({
    root: new THREE.Object3D(),
    nodeName: (b) => ({ hips: 'N_hips', leftUpperArm: 'N_leftUpperArm' })[b] ?? null,
    hipsHeight: 0.5,
    facesNegativeZ,
  });

  it('turns rest pose into identity and a lowered arm into the same world rotation', () => {
    const src = source();
    const arm = src.getObjectByName('DEF-upper_armL')!;
    const rest = arm.quaternion.clone();
    // lower the arm by 60 degrees about the world Z axis, expressed in the arm's parent space
    const hipsWorld = src.getObjectByName('DEF-hips')!.getWorldQuaternion(new THREE.Quaternion());
    const worldLower = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -Math.PI / 3);
    const lowered = hipsWorld.clone().invert().multiply(worldLower).multiply(hipsWorld).multiply(rest);
    const clip = new THREE.AnimationClip('t', 1, [
      new THREE.QuaternionKeyframeTrack('DEF-upper_armL.quaternion', [0, 1], [...rest.toArray(), ...lowered.toArray()]),
      new THREE.VectorKeyframeTrack('DEF-hips.position', [0], [0.1, 0, 1]),
    ]);
    const out = retargetClip(clip, src, rig(false));
    const [armTrack, hipsTrack] = out.tracks;
    expect(armTrack.name).toBe('N_leftUpperArm.quaternion');
    // values are Float32, and angleTo amplifies rounding near zero: 1e-3 rad is 0.06 degrees
    const q0 = new THREE.Quaternion().fromArray(armTrack.values, 0);
    const q1 = new THREE.Quaternion().fromArray(armTrack.values, 4);
    expect(q0.angleTo(new THREE.Quaternion())).toBeLessThan(1e-3);
    expect(q1.angleTo(worldLower)).toBeLessThan(1e-3);
    // hips: 1 m source height scaled to the 0.5 m avatar; Z-up translation becomes Y-up
    expect([...hipsTrack.values].map((v) => +v.toFixed(5))).toEqual([0.05, 0.5, 0]);

    const mirrored = retargetClip(clip, source(), rig(true)).tracks[0];
    const m1 = new THREE.Quaternion().fromArray(mirrored.values, 4);
    expect(m1.angleTo(new THREE.Quaternion(-worldLower.x, worldLower.y, -worldLower.z, worldLower.w))).toBeLessThan(1e-3);
  });
});
