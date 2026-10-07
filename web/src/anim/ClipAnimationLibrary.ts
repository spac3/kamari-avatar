import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { AnimationLibrary, AvatarAdapter } from '../interfaces';
import { Blinker } from './Blinker';
import { retargetClip } from './retarget';

export interface ClipSpec {
  /** Clip name in the source file. */
  clip: string;
  loop?: boolean;
  /** Ground speed in m/s at the source skeleton's scale, for locomotion clips. */
  speed?: number;
}

/** Logical names the rest of the app uses, mapped to Universal Animation Library clips. */
export const UAL_CLIPS: Record<string, ClipSpec> = {
  idle: { clip: 'Idle_Loop' },
  talk: { clip: 'Idle_Talking_Loop' },
  // Measured from the clips: the planted foot travels 0.67 m per half cycle of 1.33 s.
  walk: { clip: 'Walk_Loop', speed: 1.0 },
  run: { clip: 'Jog_Fwd_Loop', speed: 2.5 },
  interact: { clip: 'Interact', loop: false },
  dance: { clip: 'Dance_Loop' },
  sit_down: { clip: 'Sitting_Enter', loop: false },
  sit: { clip: 'Sitting_Idle_Loop' },
  stand_up: { clip: 'Sitting_Exit', loop: false },
};

/** Retargets CC0 clips onto the avatar at load time and cross-fades between them. */
export class ClipAnimationLibrary implements AnimationLibrary {
  current: string | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private actions = new Map<string, THREE.AnimationAction>();
  private speeds = new Map<string, number>();
  private readonly blinker: Blinker;

  constructor(
    private readonly avatar: AvatarAdapter,
    private readonly opts: { url: string; clips?: Record<string, ClipSpec> },
  ) {
    this.blinker = new Blinker(avatar);
  }

  async load(): Promise<void> {
    const rig = this.avatar.rig();
    if (!rig) throw new Error('this avatar has no humanoid rig for clips');
    const gltf = await new GLTFLoader().loadAsync(this.opts.url);
    const source = gltf.scene;
    const srcHips = source.getObjectByName('DEF-hips');
    const scale = srcHips ? rig.hipsHeight / srcHips.getWorldPosition(new THREE.Vector3()).y : 1;
    this.mixer = new THREE.AnimationMixer(rig.root);
    for (const [name, spec] of Object.entries(this.opts.clips ?? UAL_CLIPS)) {
      const clip = gltf.animations.find((a) => a.name === spec.clip);
      if (!clip) continue;
      const action = this.mixer.clipAction(retargetClip(clip, source, rig, undefined, name));
      if (spec.loop === false) {
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
      }
      this.actions.set(name, action);
      if (spec.speed) this.speeds.set(name, spec.speed * scale);
    }
    this.play('idle', { fadeS: 0 });
  }

  list(): string[] {
    return [...this.actions.keys()];
  }

  play(name: string, opts: { fadeS?: number; loop?: boolean } = {}): void {
    const next = this.actions.get(name);
    if (!next || name === this.current) return;
    const prev = this.current ? this.actions.get(this.current) : undefined;
    next.reset().setEffectiveTimeScale(1).setEffectiveWeight(1).play();
    if (opts.loop !== undefined) next.setLoop(opts.loop ? THREE.LoopRepeat : THREE.LoopOnce, opts.loop ? Infinity : 1);
    if (prev) next.crossFadeFrom(prev, opts.fadeS ?? 0.25, true);
    this.current = name;
  }

  groundSpeed(name: string): number | null {
    return this.speeds.get(name) ?? null;
  }

  setTimeScale(scale: number): void {
    if (this.current) this.actions.get(this.current)?.setEffectiveTimeScale(scale);
  }

  update(dt: number): void {
    this.mixer?.update(dt);
    this.blinker.update(dt);
  }
}
