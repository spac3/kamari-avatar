import type { AvatarAdapter } from '../interfaces';

/** 120 ms close-open blink every 2-6 s. Clips do not carry facial animation, so this runs alongside them. */
export class Blinker {
  private t = 0;
  private next = 2;
  private blinkT = -1;

  constructor(private readonly avatar: AvatarAdapter, private readonly rand: () => number = Math.random) {}

  update(dt: number): void {
    this.t += dt;
    if (this.blinkT < 0 && this.t >= this.next) this.blinkT = 0;
    if (this.blinkT < 0) return;
    this.blinkT += dt;
    const p = this.blinkT / 0.12;
    this.avatar.setBlink(p < 0.5 ? p * 2 : Math.max(0, 2 - p * 2));
    if (p >= 1) {
      this.blinkT = -1;
      this.next = this.t + 2 + this.rand() * 4;
      this.avatar.setBlink(0);
    }
  }
}
