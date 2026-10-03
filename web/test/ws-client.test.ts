import { describe, expect, it, vi } from 'vitest';
import { WebSocketProtocolClient } from '../src/net/WebSocketProtocolClient';

class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: Record<string, unknown>[] = [];
  onopen?: () => void;
  onmessage?: (ev: { data: string }) => void;
  onclose?: () => void;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(s: string) {
    this.sent.push(JSON.parse(s));
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(type: string, data: unknown, seq: number) {
    this.onmessage?.({ data: JSON.stringify({ v: 1, type, id: 'x', ts: 0, seq, data }) });
  }
  drop() {
    this.readyState = 3;
    this.onclose?.();
  }
}

describe('WebSocketProtocolClient', () => {
  it('says hello, then resumes the same session after a drop', () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const client = new WebSocketProtocolClient({
      url: 'ws://test/ws',
      hello: { client: 'test', version: '0', room_id: 'studio' },
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    const states: string[] = [];
    client.onState((s) => states.push(s));
    client.connect();

    const a = FakeSocket.instances[0];
    a.open();
    expect(a.sent[0]).toMatchObject({ type: 'hello', data: { room_id: 'studio' } });
    a.receive('session_ready', { session_id: 's_1', resume_token: 'rt', manifest_version: 'v', audio: { tts_rate: 22050, mic_rate: 16000 } }, 1);
    a.receive('pong', { t: 1 }, 2);
    expect(client.state).toBe('open');

    a.drop(); // phone locked
    expect(client.state).toBe('reconnecting');
    vi.advanceTimersByTime(600);
    const b = FakeSocket.instances[1];
    b.open();
    expect(b.sent[0]).toMatchObject({ type: 'resume', data: { session_id: 's_1', resume_token: 'rt', last_seq_received: 2 } });
    b.receive('state_sync', { session_id: 's_1', last_seq: 3, avatar: { location: null, position: { x: 0, z: 0 }, heading_deg: 0 }, pending_cmds: [], speech: 'silent' }, 3);
    expect(states).toEqual(['connecting', 'open', 'reconnecting', 'open']);
    client.close();
    vi.useRealTimers();
  });

  it('falls back to hello when the server forgot the session', () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const client = new WebSocketProtocolClient({
      url: 'ws://test/ws',
      hello: { client: 'test', version: '0', room_id: 'studio' },
      WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    });
    client.connect();
    const a = FakeSocket.instances[0];
    a.open();
    a.receive('session_ready', { session_id: 's_1', resume_token: 'rt', manifest_version: 'v', audio: { tts_rate: 1, mic_rate: 1 } }, 1);
    a.drop();
    vi.advanceTimersByTime(600);
    const b = FakeSocket.instances[1];
    b.open();
    b.receive('error', { code: 'resume_failed', message: 'expired' }, 0);
    b.drop();
    vi.advanceTimersByTime(1100);
    const c = FakeSocket.instances[2];
    c.open();
    expect(c.sent[0]).toMatchObject({ type: 'hello' });
    client.close();
    vi.useRealTimers();
  });
});
