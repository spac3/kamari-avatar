/**
 * Which implementation backs each browser interface. Swap one by changing `impl`,
 * or override at runtime with a query string, e.g. `?avatar=fake&anim=procedural&nav=straight&quality=low&net=offline&mic=fake&touchfx=none`.
 * `?model=jimmy` loads another avatar file from public/avatars instead of the room's.
 */
import * as THREE from 'three';
import { ClipAnimationLibrary } from './anim/ClipAnimationLibrary';
import { IkScreenTap } from './anim/IkScreenTap';
import { ProceduralGestures } from './anim/ProceduralGestures';
import { ProceduralIdle } from './anim/ProceduralIdle';
import { FakeAvatar } from './avatar/FakeAvatar';
import { VrmAvatarAdapter } from './avatar/VrmAvatarAdapter';
import type {
  AnimationLibrary,
  AvatarAdapter,
  GesturePlayer,
  LipSyncDriver,
  MicCapture,
  NavigationProvider,
  ProtocolClient,
  RoomProvider,
  TapPlayer,
  TouchEffect,
} from './interfaces';
import { FakeMicCapture, WorkletMicCapture } from './mic/WorkletMicCapture';
import { RecastNavigation, StraightLineNavigation } from './nav/RecastNavigation';
import { OfflineProtocolClient, WebSocketProtocolClient, type WsClientOptions } from './net/WebSocketProtocolClient';
import { register } from './registry';
import { ProceduralRoom } from './room/ProceduralRoom';
import { TimelineLipSync } from './speech/TimelineLipSync';
import { RippleEffect, type RippleOptions } from './touch/RippleEffect';

export interface Spec { impl: string; options?: Record<string, unknown> }

export interface ClientConfig {
  roomId: string;
  avatar: Spec;
  animation: Spec;
  navigation: Spec;
  room: Spec;
  net: Spec;
  lipSync: Spec;
  mic: Spec;
  gestures: Spec;
  tap: Spec;
  touchFx: Spec;
  /** Avatar file name in public/avatars (without .vrm) to use instead of the room's; null keeps the room's. */
  model: string | null;
  quality: 'auto' | 'desktop' | 'mobile' | 'low';
  debug: boolean;
}

export const defaultConfig: ClientConfig = {
  roomId: 'studio',
  avatar: { impl: 'vrm' },
  animation: { impl: 'clips', options: { url: 'animations/ual.glb' } },
  navigation: { impl: 'recast' },
  room: { impl: 'procedural' },
  net: { impl: 'websocket', options: { path: '/ws' } },
  lipSync: { impl: 'timeline' },
  mic: { impl: 'worklet', options: { tailMs: 120 } },
  gestures: { impl: 'procedural' },
  tap: { impl: 'ik' },
  touchFx: { impl: 'ripples' },
  model: null,
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
    lipSync: pick('lipsync', base.lipSync),
    mic: pick('mic', base.mic),
    gestures: pick('gestures', base.gestures),
    tap: pick('tap', base.tap),
    touchFx: pick('touchfx', base.touchFx),
    model: q.get('model') ?? base.model,
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
  register<AnimationLibrary>('animation', 'clips', (o) => new ClipAnimationLibrary(o.avatar as AvatarAdapter, { url: o.url as string }));
  register<LipSyncDriver>('lipsync', 'timeline', () => new TimelineLipSync());
  register<NavigationProvider>('navigation', 'recast', () => new RecastNavigation());
  register<NavigationProvider>('navigation', 'straight', () => new StraightLineNavigation());
  register<RoomProvider>('room', 'procedural', () => new ProceduralRoom());
  register<ProtocolClient>('net', 'websocket', (o) => new WebSocketProtocolClient(o as unknown as WsClientOptions));
  register<ProtocolClient>('net', 'offline', () => new OfflineProtocolClient());
  register<MicCapture>('mic', 'worklet', () => new WorkletMicCapture());
  register<MicCapture>('mic', 'fake', () => new FakeMicCapture());
  register<GesturePlayer>('gestures', 'procedural', (o) => new ProceduralGestures(o.avatar as AvatarAdapter));
  register<TapPlayer>('tap', 'ik', (o) => new IkScreenTap(o.avatar as AvatarAdapter));
  register<TouchEffect>('touchfx', 'ripples', (o) => new RippleEffect(o as RippleOptions));
  register<TouchEffect>('touchfx', 'none', () => ({ object: new THREE.Group(), spawn() {}, update() {} }));
}
