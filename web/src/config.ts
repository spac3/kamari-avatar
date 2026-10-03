/**
 * Which implementation backs each browser interface. Swap one by changing `impl`,
 * or override at runtime with a query string, e.g. `?avatar=fake&nav=straight&quality=low&net=offline`.
 */
import { FakeAvatar } from './avatar/FakeAvatar';
import { ProceduralIdle } from './avatar/ProceduralIdle';
import { VrmAvatarAdapter } from './avatar/VrmAvatarAdapter';
import type { AnimationLibrary, AvatarAdapter, NavigationProvider, ProtocolClient, RoomProvider } from './interfaces';
import { RecastNavigation, StraightLineNavigation } from './nav/RecastNavigation';
import { OfflineProtocolClient, WebSocketProtocolClient, type WsClientOptions } from './net/WebSocketProtocolClient';
import { register } from './registry';
import { ProceduralRoom } from './room/ProceduralRoom';

export interface Spec { impl: string; options?: Record<string, unknown> }

export interface ClientConfig {
  roomId: string;
  avatar: Spec;
  animation: Spec;
  navigation: Spec;
  room: Spec;
  net: Spec;
  quality: 'auto' | 'desktop' | 'mobile' | 'low';
  debug: boolean;
}

export const defaultConfig: ClientConfig = {
  roomId: 'studio',
  avatar: { impl: 'vrm' },
  animation: { impl: 'procedural' },
  navigation: { impl: 'recast' },
  room: { impl: 'procedural' },
  net: { impl: 'websocket', options: { path: '/ws' } },
  quality: 'auto',
  debug: false,
};

export function configFromQuery(search: string, base: ClientConfig = defaultConfig): ClientConfig {
  const q = new URLSearchParams(search);
  const pick = (key: string, spec: Spec): Spec => (q.get(key) ? { ...spec, impl: q.get(key)! } : spec);
  return {
    ...base,
    roomId: q.get('room') ?? base.roomId,
    avatar: pick('avatar', base.avatar),
    animation: pick('anim', base.animation),
    navigation: pick('nav', base.navigation),
    room: pick('roomImpl', base.room),
    net: pick('net', base.net),
    quality: (q.get('quality') as ClientConfig['quality']) ?? base.quality,
    debug: q.has('debug') || base.debug,
  };
}

let registered = false;
export function registerBuiltins(): void {
  if (registered) return;
  registered = true;
  register<AvatarAdapter>('avatar', 'vrm', (o) => new VrmAvatarAdapter(o as { springBones?: boolean }));
  register<AvatarAdapter>('avatar', 'fake', () => new FakeAvatar());
  register<AnimationLibrary>('animation', 'procedural', (o) => new ProceduralIdle(o.avatar as AvatarAdapter));
  register<NavigationProvider>('navigation', 'recast', () => new RecastNavigation());
  register<NavigationProvider>('navigation', 'straight', () => new StraightLineNavigation());
  register<RoomProvider>('room', 'procedural', () => new ProceduralRoom());
  register<ProtocolClient>('net', 'websocket', (o) => new WebSocketProtocolClient(o as unknown as WsClientOptions));
  register<ProtocolClient>('net', 'offline', () => new OfflineProtocolClient());
}
