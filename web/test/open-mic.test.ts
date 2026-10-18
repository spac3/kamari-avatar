import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ClientData, ClientType, ProtocolClient, VoiceActivityDetector } from '../src/interfaces';
import { EchoGate, rms } from '../src/mic/EchoGate';
import { OpenMic, type AvatarActivity, type OpenMicOptions } from '../src/mic/OpenMic';
import { FakeMicCapture } from '../src/mic/WorkletMicCapture';
import { OfflineProtocolClient, parseAudioFrame } from '../src/net/WebSocketProtocolClient';
import { EnergyVad } from '../src/vad/EnergyVad';
import { SileroVad } from '../src/vad/SileroVad';

// Piper (ljspeech) saying "Wait, stop. Go to the sofa instead." and "Sure, I will walk over to the
// window and wave at you.", 16 kHz PCM16 mono.
const fixture = (name: string) => {
  const b = readFileSync(new URL(`./fixtures/${name}-16k.pcm`, import.meta.url));
  return new Int16Array(b.buffer, b.byteOffset, b.byteLength / 2);
};
const USER = fixture('user');
const AVATAR = fixture('avatar');
const FRAME = 320; // 20 ms

function frames(pcm: Int16Array): Int16Array[] {
  const out: Int16Array[] = [];
  for (let i = 0; i + FRAME <= pcm.length; i += FRAME) out.push(pcm.slice(i, i + FRAME));
  return out;
}

/** Room noise: quiet, deterministic. */
function noise(ms: number, amp = 60): Int16Array {
  const n = (16000 * ms) / 1000;
  const out = new Int16Array(n);
  let x = 12345;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (x % (2 * amp + 1)) - amp;
  }
  return out;
}

function mix(...parts: { pcm: Int16Array; gain?: number; at?: number }[]): Int16Array {
  const len = Math.max(...parts.map((p) => (p.at ?? 0) + p.pcm.length));
  const out = new Int16Array(len);
  for (const { pcm, gain = 1, at = 0 } of parts) {
    for (let i = 0; i < pcm.length; i++) out[at + i] = Math.max(-32768, Math.min(32767, out[at + i] + pcm[i] * gain));
  }
  return out;
}

const concat = (...parts: Int16Array[]) => {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) out.set(p, (o += p.length) - p.length);
  return out;
};

class RecordingNet extends OfflineProtocolClient {
  sent: [string, unknown][] = [];
  frames: ArrayBuffer[] = [];
  override send<T extends ClientType>(type: T, data: ClientData<T>): void {
    this.sent.push([type, data]);
  }
  override sendBinary(frame: ArrayBuffer): void {
    this.frames.push(frame);
  }
  types(): string[] {
    return this.sent.map(([t]) => t);
  }
}

class ManualMic extends FakeMicCapture {
  push(f: Int16Array): void {
    (this as unknown as { cbs: Set<(f: Int16Array) => void> }).cbs.forEach((cb) => cb(f));
  }
  override start(): void {}
}

/** Probabilities scripted per frame, to test the state machine on its own. */
class ScriptedVad implements VoiceActivityDetector {
  readonly name = 'scripted';
  constructor(private readonly probs: number[]) {}
  async load(): Promise<void> {}
  async process(): Promise<number> {
    return this.probs.shift() ?? 0;
  }
  reset(): void {}
}

interface Rig {
  mic: ManualMic;
  net: RecordingNet;
  om: OpenMic;
  log: string[];
  activity: AvatarActivity;
  output: number;
  /** The avatar's volume: ducked while a barge-in is checked. */
  gain: number;
  /** Frames fed so far, and how many had been fed when the barge-in came. */
  fed: number;
  bargeInAt: number | null;
  /** Feed frames one by one; `output` gives the avatar's output level for each. */
  feed(fs: Int16Array[], output?: (i: number) => number): Promise<void>;
}

async function rig(vad: VoiceActivityDetector, opts: OpenMicOptions = {}): Promise<Rig> {
  const mic = new ManualMic();
  const net = new RecordingNet();
  const r = { mic, net, log: [] as string[], activity: 'idle' as AvatarActivity, output: 0, gain: 1, fed: 0, bargeInAt: null } as Rig;
  r.om = new OpenMic(mic, vad, net as unknown as ProtocolClient, {
    activity: () => r.activity,
    outputLevel: () => r.output,
    duck: (on, gain) => {
      r.log.push(on ? 'duck' : 'unduck');
      r.gain = on ? gain : 1;
    },
    bargeIn: () => {
      r.log.push('barge-in');
      r.bargeInAt = r.fed;
      r.activity = 'idle'; // the avatar stopped
      r.output = 0;
    },
  }, () => ({}) as AudioContext, opts);
  r.feed = async (fs, output) => {
    for (let i = 0; i < fs.length; i++) {
      if (output) r.output = output(i);
      mic.push(fs[i]);
      r.fed++;
    }
    await (r.om as unknown as { chain: Promise<void> }).chain;
  };
  await r.om.start();
  return r;
}

const silent = (n: number) => Array.from({ length: n }, () => new Int16Array(FRAME));

describe('open mic state machine', () => {
  it('sends an utterance with the audio from just before it started, then ends it after a pause', async () => {
    const probs = [...Array(20).fill(0), ...Array(30).fill(0.9), ...Array(40).fill(0.05)];
    const r = await rig(new ScriptedVad(probs));
    await r.feed(silent(90));
    expect(r.net.sent).toEqual([
      ['user_speech_start', { segment_id: 'seg_1', stream_id: 1, while: 'idle' }],
      ['user_speech_end', { segment_id: 'seg_1', duration_ms: expect.any(Number) }],
    ]);
    // 300 ms of pre-roll + 30 frames of speech + the 700 ms pause (35 frames) that ended it
    const seqs = r.net.frames.map((f) => parseAudioFrame(f)!.seq);
    expect(seqs.length).toBe(14 + 30 + 35); // the pre-roll's 300 ms end with the first voiced frame
    expect(seqs).toEqual([...seqs.keys()]);
    expect(r.om.state).toBe('listening');
    expect(r.log).toEqual([]); // nothing was playing: no duck, no barge-in
  });

  it('only dips the avatar for a cough while it talks', async () => {
    const r = await rig(new ScriptedVad([...Array(5).fill(0.95), ...Array(20).fill(0)]));
    r.activity = 'talking';
    await r.feed(silent(25));
    expect(r.log).toEqual(['duck', 'unduck']);
    expect(r.net.sent).toEqual([]);
    expect(r.om.stats).toMatchObject({ falseStarts: 1, bargeIns: 0 });
  });

  it('interrupts the avatar once the user has talked over it for long enough', async () => {
    const r = await rig(new ScriptedVad(Array(40).fill(0.95)));
    r.activity = 'talking';
    await r.feed(silent(15)); // 300 ms: not yet
    expect(r.log).toEqual(['duck']);
    await r.feed(silent(1)); // 320 ms
    expect(r.log).toEqual(['duck', 'barge-in', 'unduck']);
    expect(r.net.sent[0]).toEqual(['user_speech_start', { segment_id: 'seg_1', stream_id: 1, while: 'talking' }]);
  });

  it('interrupts a walk the same way, without ducking (nothing to duck)', async () => {
    const r = await rig(new ScriptedVad(Array(20).fill(0.95)));
    r.activity = 'walking';
    await r.feed(silent(20));
    expect(r.log).toEqual(['barge-in']);
    expect(r.net.sent[0]).toEqual(['user_speech_start', expect.objectContaining({ while: 'walking' })]);
  });

  it('stops listening when muted, sending what was said so far', async () => {
    const r = await rig(new ScriptedVad(Array(30).fill(0.95)));
    await r.feed(silent(20));
    await r.om.stop();
    expect(r.net.types()).toEqual(['user_speech_start', 'user_speech_end']);
    expect(r.om.state).toBe('off');
    await r.feed(silent(5));
    expect(r.net.types()).toEqual(['user_speech_start', 'user_speech_end']);
  });

  it('falls back to another detector when the first cannot load', async () => {
    const broken: VoiceActivityDetector = { name: 'silero', load: () => Promise.reject(new Error('no wasm')), process: async () => 0, reset() {} };
    const mic = new ManualMic();
    const om = new OpenMic(mic, broken, new RecordingNet() as unknown as ProtocolClient,
      { activity: () => 'idle', outputLevel: () => 0, duck() {}, bargeIn() {} }, () => ({}) as AudioContext, {}, () => new EnergyVad());
    await om.start();
    expect([om.state, om.detector]).toEqual(['listening', 'energy']);
  });
});

describe('voice detectors', () => {
  async function probs(vad: VoiceActivityDetector, pcm: Int16Array): Promise<number[]> {
    await vad.load();
    vad.reset();
    const out: number[] = [];
    for (const f of frames(pcm)) out.push(await vad.process(f));
    return out;
  }

  it('energy: speech is loud against the room, its noise is not', async () => {
    const p = await probs(new EnergyVad(), concat(noise(500), USER, noise(500)));
    expect(Math.max(...p.slice(0, 25))).toBeLessThan(0.2);
    expect(p.filter((x) => x > 0.5).length * 20).toBeGreaterThan(1200); // most of the 2.5 s sentence
  });

  it('silero: hears speech, not noise or a hum', async () => {
    const model = new Uint8Array(readFileSync(new URL('../public/vad/silero_vad_v6.onnx', import.meta.url)));
    const vad = new SileroVad({ model });
    const speech = await probs(vad, concat(noise(500), USER, noise(500)));
    expect(Math.max(...speech.slice(0, 20))).toBeLessThan(0.3);
    expect(speech.filter((x) => x > 0.6).length * 20).toBeGreaterThan(1000);
    const hum = new Int16Array(16000);
    for (let i = 0; i < hum.length; i++) hum[i] = Math.round(6000 * Math.sin((2 * Math.PI * 100 * i) / 16000));
    const loud = await probs(vad, concat(noise(1000, 3000), hum));
    expect(Math.max(...loud)).toBeLessThan(0.5);
  }, 30_000);
});

describe('echo', () => {
  it('learns how much output leaks into the mic and gates it', () => {
    const gate = new EchoGate();
    const out = frames(AVATAR);
    const keep = out.map((f) => gate.check(rms(f) * 0.6, rms(f))); // a leaky setup: 60% comes back
    expect(keep.slice(50).filter((k) => k === 1).length).toBeLessThan(5);
    expect(gate.check(0.3, 0.05)).toBe(1); // the user, far louder than the echo would be
    for (let i = 0; i < 10; i++) gate.check(0.01, 0); // the output stopped 200 ms ago
    expect(gate.check(0.01, 0)).toBe(1); // nothing playing: nothing to gate
  });

  /**
   * The avatar says its sentence; the mic hears it back at `leak` (the browser's echo canceller left
   * that much), 40 ms late, over room noise. With `userAt` the user also talks over it from then on.
   */
  async function talkOver(vad: VoiceActivityDetector, leak: number, userAt: number | null) {
    const out = frames(concat(noise(400, 0), AVATAR));
    const room = frames(noise(4500));
    const user = userAt === null ? [] : frames(concat(new Int16Array((16000 * userAt) / 1000), USER));
    const r = await rig(vad);
    r.activity = 'talking';
    const played: Int16Array[] = []; // what actually came out of the speakers, frame by frame
    for (let i = 0; i < room.length; i++) {
      const talking = r.activity === 'talking' && i < out.length;
      played.push(talking ? out[i].map((v) => v * r.gain) : new Int16Array(FRAME));
      const echo = played[i - 2]; // heard 40 ms later
      const mic = mix({ pcm: room[i] }, ...(echo ? [{ pcm: echo, gain: leak }] : []), ...(user[i] ? [{ pcm: user[i], gain: 0.9 }] : []));
      await r.feed([mic], () => rms(played[i]));
    }
    return r;
  }

  for (const [name, make] of [
    ['energy', () => new EnergyVad()],
    ['silero', () => new SileroVad({ model: new Uint8Array(readFileSync(new URL('../public/vad/silero_vad_v6.onnx', import.meta.url))) })],
  ] as const) {
    it(`${name}: the avatar's own voice coming back does not interrupt it`, async () => {
      for (const leak of [0.05, 0.2, 0.5, 0.8]) { // 0.8: no echo cancelling at all, speakers loud
        const r = await talkOver(make(), leak, null);
        expect(r.log, `leak ${leak}`).not.toContain('barge-in');
        expect(r.net.sent, `leak ${leak}`).toEqual([]);
      }
    }, 30_000);

    it(`${name}: the user talking over it does`, async () => {
      for (const [leak, at] of [[0.05, 500], [0.05, 1200], [0.2, 700], [0.2, 2000], [0.5, 1200]]) {
        const r = await talkOver(make(), leak, at);
        expect(r.log, `leak ${leak}`).toContain('barge-in');
        // 320 ms of speech to confirm, more while the avatar's voice masks the user's
        expect(r.bargeInAt! * 20 - at, `leak ${leak} at ${at} ms`).toBeLessThan(1500);
        expect(r.net.sent[0], `leak ${leak}`).toEqual(['user_speech_start', expect.objectContaining({ while: 'talking' })]);
      }
    }, 30_000);
  }
});
