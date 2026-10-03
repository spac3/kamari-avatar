import type { LifecycleManager } from '../interfaces';

/** Page Visibility + Screen Wake Lock. Phones suspend hidden tabs; we react instead of fighting it. */
export class BrowserLifecycle implements LifecycleManager {
  private lock: WakeLockSentinel | null = null;
  private wantAwake = false;

  constructor() {
    document.addEventListener('visibilitychange', () => {
      // Wake locks are released when the page is hidden; take it again on return.
      if (document.visibilityState === 'visible' && this.wantAwake) void this.keepAwake(true);
    });
  }

  onHidden(cb: () => void): void {
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && cb());
  }

  onVisible(cb: () => void): void {
    document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && cb());
  }

  async keepAwake(on: boolean): Promise<void> {
    this.wantAwake = on;
    if (!on) {
      await this.lock?.release();
      this.lock = null;
      return;
    }
    if (!('wakeLock' in navigator) || this.lock) return;
    try {
      this.lock = await navigator.wakeLock.request('screen');
      this.lock.addEventListener('release', () => (this.lock = null));
    } catch {
      // denied (low battery, not visible): nothing to do
    }
  }
}
