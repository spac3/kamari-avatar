import type { MicCapture, ProtocolClient } from '../interfaces';
import { encodeAudioFrame } from '../net/WebSocketProtocolClient';

export const AUDIO_MIC = 0x01;

export type PttState = 'idle' | 'opening' | 'talking' | 'sending';

export interface PttOptions {
  /** Keep recording this long after release, so the last word is not clipped. */
  tailMs?: number;
}

/**
 * Hold to talk: on press, stop the avatar talking (barge-in), tell the server and stream mic
 * frames as binary audio; on release, flush the mic and send `ptt up` so the server transcribes.
 * The first press opens the mic, which shows the permission prompt; that press only opens it.
 */
export class PushToTalk {
  state: PttState = 'idle';
  onState: (s: PttState) => void = () => {};
  onError: (e: unknown) => void = () => {};
  private streamId = 0;
  private seq = 0;

  constructor(
    private readonly mic: MicCapture,
    private readonly net: ProtocolClient,
    private readonly interruptSpeech: () => void,
    private readonly context: () => AudioContext | null,
    private readonly opts: PttOptions = {},
  ) {
    mic.onFrame((pcm) => {
      if (this.state === 'talking' || this.state === 'sending') {
        this.net.sendBinary(encodeAudioFrame(AUDIO_MIC, this.streamId, this.seq++, pcm));
      }
    });
  }

  async down(): Promise<void> {
    if (this.state !== 'idle') return;
    this.interruptSpeech();
    if (!this.mic.ready) {
      const ctx = this.context();
      if (!ctx) {
        this.onError(new Error('audio is not unlocked yet'));
        return;
      }
      this.set('opening');
      try {
        await this.mic.open(ctx);
      } catch (e) {
        this.set('idle');
        this.onError(e);
        return;
      }
      if ((this.state as PttState) !== 'opening') return; // released while the permission prompt was up
    }
    this.streamId = (this.streamId + 1) >>> 0;
    this.seq = 0;
    this.net.send('ptt', { state: 'down', stream_id: this.streamId });
    this.mic.start();
    this.set('talking');
  }

  async up(): Promise<void> {
    if (this.state === 'opening') {
      this.set('idle');
      return;
    }
    if (this.state !== 'talking') return;
    this.set('sending');
    if (this.opts.tailMs ?? 120) await new Promise((r) => setTimeout(r, this.opts.tailMs ?? 120));
    await this.mic.stop();
    this.net.send('ptt', { state: 'up', stream_id: this.streamId });
    this.set('idle');
  }

  /** Page hidden mid-press: drop it. The server discards the audio when it hears the tab hid. */
  cancel(): void {
    if (this.state === 'idle') return;
    void this.mic.stop();
    this.set('idle');
  }

  private set(s: PttState): void {
    this.state = s;
    this.onState(s);
  }
}
