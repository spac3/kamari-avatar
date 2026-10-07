import type { AudioFrame, AudioPlayer, ClientData, ClientType, LipSyncDriver, ServerMsg } from '../interfaces';

type Send = <T extends ClientType>(type: T, data: ClientData<T>) => void;
type ChunkHeader = ServerMsg<'speech_chunk'>['data'];

interface Utterance {
  id: string;
  headers: Map<number, ChunkHeader>; // by stream_id, waiting for their audio frame
  played: number; // chunks scheduled
  total: number | null; // known once speech_end arrives
  firstAt: number | null;
  endAt: number;
}

/**
 * Pairs speech_chunk headers with their binary audio frames, schedules the audio back to back,
 * hands each chunk's viseme timeline to the lip sync driver on the same clock, and reports
 * speech_started / speech_finished to the server.
 */
export class SpeechPlayer {
  private u: Utterance | null = null;

  constructor(private readonly audio: AudioPlayer, private readonly lipSync: LipSyncDriver, private readonly send: Send) {}

  get talking(): boolean {
    return this.u !== null && this.u.firstAt !== null;
  }

  onStart(msg: ServerMsg<'speech_start'>): void {
    if (this.u) this.interrupt();
    this.u = { id: msg.data.utterance_id, headers: new Map(), played: 0, total: null, firstAt: null, endAt: 0 };
  }

  onChunk(msg: ServerMsg<'speech_chunk'>): void {
    if (this.u?.id === msg.data.utterance_id) this.u.headers.set(msg.data.stream_id, msg.data);
  }

  onAudio(frame: AudioFrame): void {
    const u = this.u;
    const header = u?.headers.get(frame.streamId);
    if (!u || !header) return; // audio for a cancelled utterance
    u.headers.delete(frame.streamId);
    if (!this.audio.context) {
      u.played++; // no audio output (not unlocked): count it so the utterance still finishes
      return;
    }
    const at = this.audio.enqueue(frame.pcm, header.sample_rate);
    this.lipSync.start(at, header.visemes);
    u.played++;
    u.endAt = at + frame.pcm.length / header.sample_rate;
    if (u.firstAt === null) {
      u.firstAt = at;
      this.send('speech_started', { utterance_id: u.id });
    }
  }

  onEnd(msg: ServerMsg<'speech_end'>): void {
    if (this.u?.id === msg.data.utterance_id) this.u.total = msg.data.total_chunks;
  }

  /** The server cancelled it (superseded): stop locally; the server already knows. */
  onCancel(msg: ServerMsg<'speech_cancel'>): void {
    if (this.u?.id !== msg.data.utterance_id) return;
    this.audio.stop();
    this.lipSync.stop();
    this.u = null;
  }

  /** Stop speaking now (barge-in, new utterance) and tell the server how much was heard. */
  interrupt(): void {
    const u = this.u;
    if (!u) return;
    this.audio.stop();
    this.lipSync.stop();
    this.u = null;
    this.send('speech_finished', { utterance_id: u.id, interrupted: true, played_ms: this.playedMs(u) });
  }

  update(): void {
    const u = this.u;
    const now = this.audio.context?.currentTime ?? 0;
    if (!u || u.total === null || u.played < u.total || now < u.endAt) return;
    this.u = null;
    this.send('speech_finished', { utterance_id: u.id, interrupted: false, played_ms: this.playedMs(u) });
  }

  private playedMs(u: Utterance): number {
    if (u.firstAt === null) return 0;
    const now = this.audio.context?.currentTime ?? u.endAt;
    return Math.round((Math.min(now, u.endAt) - u.firstAt) * 1000);
  }
}
