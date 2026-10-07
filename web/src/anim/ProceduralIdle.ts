import type { AnimationLibrary, AvatarAdapter } from '../interfaces';
import { Blinker } from './Blinker';

/**
 * Fallback animation source with no assets: arms down from the T-pose, breathing, weight shift
 * and blinking, driven directly on humanoid bones. Walking glides (no leg motion); use the clip
 * library for real locomotion.
 */
export class ProceduralIdle implements AnimationLibrary {
  current: string | null = 'idle';
  private t = 0;
  private readonly blinker: Blinker;

  constructor(private readonly avatar: AvatarAdapter, rand: () => number = Math.random) {
    this.blinker = new Blinker(avatar, rand);
  }

  async load(): Promise<void> {}

  list(): string[] {
    return ['idle', 'talk', 'walk'];
  }

  play(name: string): void {
    this.current = name;
  }

  groundSpeed(): number | null {
    return null;
  }

  setTimeScale(): void {}

  update(dt: number): void {
    this.t += dt;
    const t = this.t;
    const a = this.avatar;
    const breath = Math.sin(t * 2 * Math.PI * 0.25); // ~15 breaths a minute
    const sway = Math.sin(t * 2 * Math.PI * 0.12);

    a.bone('leftUpperArm')?.rotation.set(0, 0, 1.2 - 0.03 * breath);
    a.bone('rightUpperArm')?.rotation.set(0, 0, -1.2 + 0.03 * breath);
    a.bone('leftLowerArm')?.rotation.set(0, -0.25, 0);
    a.bone('rightLowerArm')?.rotation.set(0, 0.25, 0);
    a.bone('spine')?.rotation.set(0.02 * breath, 0, 0.015 * sway);
    a.bone('chest')?.rotation.set(0.025 * breath, 0, 0);
    a.bone('hips')?.rotation.set(0, 0.03 * sway, -0.02 * sway);
    a.bone('neck')?.rotation.set(-0.01 * breath, 0.04 * Math.sin(t * 0.37), 0);
    a.bone('head')?.rotation.set(0.02 * Math.sin(t * 0.23), 0.05 * Math.sin(t * 0.31), 0.02 * sway);
    this.blinker.update(dt);
  }
}
