/**
 * Which implementation backs each browser interface. Swap one by changing `impl`,
 * or override at runtime with a query string, e.g. `?avatar=fake&anim=procedural&nav=straight&quality=low&net=offline&mic=fake&touchfx=none&vad=energy&micmode=ptt`.
 * `?panel=none` turns off the translucent panel on the glass.
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
  GlassUi,
  LipSyncDriver,
  MicCapture,
  NavigationProvider,
  VoiceActivityDetector,
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
import { GlassPanel, type GlassPanelOptions } from './touch/GlassPanel';
import type { PanelControl } from './room/manifest';
import { RippleEffect, type RippleOptions } from './touch/RippleEffect';
import type { OpenMicOptions } from './mic/OpenMic';
import { EnergyVad, type EnergyVadOptions } from './vad/EnergyVad';
import { SileroVad, type SileroVadOptions } from './vad/SileroVad';

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
  /** Controls on the glass, shown near the room's panel location; its controls come from the manifest. */
  panel: Spec;
  /** Voice activity detector for the open mic; `energy` stands in if it cannot load. */
  vad: Spec;
  /**
   * How the user talks: `open` is hands-free (open mic, talk over Kamari to interrupt it), `ptt` is
   * hold to talk, `auto` picks open on desktops and ptt on phones (held close, noisy places, speaker by the mic).
   */
  micMode: 'auto' | 'open' | 'ptt';
  openMic: OpenMicOptions;
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
  panel: { impl: 'glass' },
  vad: { impl: 'silero', options: { model: 'vad/silero_vad_v6.onnx' } },
  micMode: 'auto',
  openMic: {},
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
    panel: pick('panel', base.panel),
    vad: pick('vad', base.vad),
    micMode: (q.get('micmode') as ClientConfig['micMode']) ?? base.micMode,
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
  register<GlassUi>('panel', 'glass', (o) => new GlassPanel(o.controls as PanelControl[], o as GlassPanelOptions));
  register<GlassUi | null>('panel', 'none', () => null);
  register<VoiceActivityDetector>('vad', 'silero', (o) => new SileroVad(o as unknown as SileroVadOptions));
  register<VoiceActivityDetector>('vad', 'energy', (o) => new EnergyVad(o as EnergyVadOptions));
}
