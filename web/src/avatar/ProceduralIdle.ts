import type { AnimationLibrary, AvatarAdapter } from '../interfaces';

/**
 * M0 animation source: arms down from the T-pose, breathing, weight shift and blinking,
 * driven directly on humanoid bones. Replaced by retargeted CC0 clips (Quaternius UAL) in M1
 * through the same AnimationLibrary interface.
 */
export class ProceduralIdle implements AnimationLibrary {
  private t = 0;
  private nextBlink = 2;
  private blinkT = -1;

  constructor(private readonly avatar: AvatarAdapter, private readonly rand: () => number = Math.random) {}

  list(): string[] {
    return ['idle'];
  }

  play(): void {}

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

    // Blink: 120 ms close-open every 2-6 s.
    if (this.blinkT < 0 && t >= this.nextBlink) this.blinkT = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const p = this.blinkT / 0.12;
      a.setBlink(p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2));
      if (p >= 1) {
        this.blinkT = -1;
        this.nextBlink = t + 2 + this.rand() * 4;
        a.setBlink(0);
      }
    }
  }
}
