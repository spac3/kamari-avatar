import type { AudioPlayer } from '../interfaces';

/**
 * One long-lived AudioContext (iOS limits them), unlocked from a user gesture.
 * Queues PCM16 chunks back to back; `enqueue` returns the scheduled start time,
 * which the lip sync driver uses as its clock.
 */
export class WebAudioPlayer implements AudioPlayer {
  context: AudioContext | null = null;
  private playHead = 0;
  private sources = new Set<AudioBufferSourceNode>();

  async unlock(): Promise<void> {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'playback'; // iOS: play even with the silent switch on
    this.context ??= new AudioContext();
    if (this.context.state !== 'running') await this.context.resume();
    // A silent buffer played inside the gesture fully unlocks output on older iOS.
    const src = this.context.createBufferSource();
    src.buffer = this.context.createBuffer(1, 1, 22050);
    src.connect(this.context.destination);
    src.start();
  }

  enqueue(pcm: Int16Array, sampleRate: number): number {
    const ctx = this.context;
    if (!ctx) throw new Error('audio not unlocked');
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.05, this.playHead);
    src.start(startAt);
    this.playHead = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
    return startAt;
  }

  stop(): void {
    for (const s of this.sources) s.stop();
    this.sources.clear();
    this.playHead = 0;
  }
}
