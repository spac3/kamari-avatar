import type { AudioFrame, ClientData, ClientType, ConnectionState, ProtocolClient, ServerMsg, ServerType } from '../interfaces';
import type { ClientMessage, ServerMessage } from '../protocol';

type Handler = (msg: ServerMessage) => void;

export interface WsClientOptions {
  url: string;
  hello: Extract<ClientMessage, { type: 'hello' }>['data'];
  heartbeatMs?: number;
  maxBackoffMs?: number;
  /** Injected for tests. */
  WebSocketImpl?: typeof WebSocket;
}

/**
 * WebSocket transport with heartbeats and resume. Phones drop sockets when the tab is
 * backgrounded; on reconnect we send `resume` and the server answers with `state_sync`.
 */
export class WebSocketProtocolClient implements ProtocolClient {
  state: ConnectionState = 'offline';
  sessionId: string | null = null;
  private resumeToken: string | null = null;
  private lastSeq = 0;
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  private stateHandlers = new Set<(s: ConnectionState) => void>();
  private binaryHandlers = new Set<(f: AudioFrame) => void>();
  private attempts = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private closedByUser = false;
  private n = 0;

  constructor(private readonly opts: WsClientOptions) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.ws?.close();
    this.setState('closed');
  }

  send<T extends ClientType>(type: T, data: ClientData<T>): void {
    if (this.ws?.readyState !== 1) return; // dropped; state is rebuilt by resume
    this.ws.send(JSON.stringify({ v: 1, type, id: `c_${++this.n}`, ts: Date.now(), data }));
  }

  on<T extends ServerType>(type: T, cb: (msg: ServerMsg<T>) => void): () => void {
    const set = this.handlers.get(type) ?? new Set<Handler>();
    set.add(cb as Handler);
    this.handlers.set(type, set);
    return () => set.delete(cb as Handler);
  }

  onState(cb: (s: ConnectionState) => void): () => void {
    this.stateHandlers.add(cb);
    return () => this.stateHandlers.delete(cb);
  }

  onBinary(cb: (f: AudioFrame) => void): () => void {
    this.binaryHandlers.add(cb);
    return () => this.binaryHandlers.delete(cb);
  }

  private open(): void {
    this.clearTimers();
    this.setState(this.sessionId ? 'reconnecting' : 'connecting');
    const WS = this.opts.WebSocketImpl ?? WebSocket;
    const ws = new WS(this.opts.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      this.attempts = 0;
      if (this.sessionId && this.resumeToken) {
        this.send('resume', { session_id: this.sessionId, resume_token: this.resumeToken, last_seq_received: this.lastSeq });
      } else {
        this.send('hello', this.opts.hello);
      }
      this.heartbeat = setInterval(() => this.send('ping', { t: Date.now() }), this.opts.heartbeatMs ?? 15000);
    };
    ws.onmessage = (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        const frame = parseAudioFrame(ev.data);
        if (frame) this.binaryHandlers.forEach((h) => h(frame));
        return;
      }
      const msg = JSON.parse(ev.data) as ServerMessage;
      this.lastSeq = Math.max(this.lastSeq, msg.seq);
      if (msg.type === 'session_ready') {
        this.sessionId = msg.data.session_id;
        this.resumeToken = msg.data.resume_token;
        this.setState('open');
      } else if (msg.type === 'state_sync') {
        this.setState('open');
      } else if (msg.type === 'error' && msg.data.code === 'resume_failed') {
        this.sessionId = this.resumeToken = null; // session expired: start fresh on the next attempt
        this.lastSeq = 0;
      }
      this.handlers.get(msg.type)?.forEach((h) => h(msg));
    };
    ws.onclose = () => {
      this.clearTimers();
      if (this.closedByUser) return;
      const delay = Math.min(this.opts.maxBackoffMs ?? 10000, 500 * 2 ** this.attempts++);
      this.setState(this.sessionId ? 'reconnecting' : 'connecting');
      this.retry = setTimeout(() => this.open(), delay);
    };
  }

  /** Call when the page becomes visible again: reconnect now instead of waiting for backoff. */
  wake(): void {
    if (!this.closedByUser && this.ws?.readyState !== 1 && this.ws?.readyState !== 0) {
      this.attempts = 0;
      this.open();
    }
  }

  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.retry) clearTimeout(this.retry);
    this.heartbeat = this.retry = null;
  }

  private setState(s: ConnectionState): void {
    if (s === this.state) return;
    this.state = s;
    this.stateHandlers.forEach((h) => h(s));
  }
}

/** Splits a binary frame. The PCM16 payload is little-endian, which is every browser's native order. */
export function parseAudioFrame(buf: ArrayBuffer): AudioFrame | null {
  if (buf.byteLength < 9) return null;
  const view = new DataView(buf);
  const pcm = new Int16Array(buf.slice(9, 9 + ((buf.byteLength - 9) & ~1)));
  return { kind: view.getUint8(0), streamId: view.getUint32(1), seq: view.getUint32(5), pcm };
}

/** Fake: no server. Lets the scene run standalone (and in tests). */
export class OfflineProtocolClient implements ProtocolClient {
  state: ConnectionState = 'offline';
  sessionId = null;
  connect(): void {}
  close(): void {}
  send(): void {}
  on(): () => void {
    return () => {};
  }
  onState(): () => void {
    return () => {};
  }
  onBinary(): () => void {
    return () => {};
  }
}
