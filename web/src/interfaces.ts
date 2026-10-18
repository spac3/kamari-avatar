/**
 * Swappable browser-side interfaces. Code depends on these, never on a concrete library;
 * `config.ts` picks the implementation for each through the registry.
 */
import type * as THREE from 'three';
import type { ClientMessage, ServerMessage, Viseme } from './protocol';
import type { RoomManifest } from './room/manifest';

export interface Vec2 { x: number; z: number }

export type ClientType = ClientMessage['type'];
export type ClientData<T extends ClientType> = Extract<ClientMessage, { type: T }>['data'];
export type ServerType = ServerMessage['type'];
export type ServerMsg<T extends ServerType> = Extract<ServerMessage, { type: T }>;

/** Face and body control for one avatar, whatever its format (VRM, GLB with blendshapes...). */
export interface AvatarAdapter {
  readonly object: THREE.Object3D;
  load(url: string): Promise<void>;
  /** Weight 0..1 for one Oculus viseme; the adapter maps it to whatever mouth shapes it has. */
  setViseme(viseme: Viseme, weight: number): void;
  setExpression(name: string, weight: number): void;
  setBlink(weight: number): void;
  lookAt(target: THREE.Vector3 | null): void;
  /** Normalized humanoid bone by standard name (hips, spine, head, leftUpperArm...). */
  bone(name: string): THREE.Object3D | null;
  /** Skeleton details animation retargeting needs; null for avatars clips cannot drive. */
  rig(): HumanoidRig | null;
  update(dt: number): void;
  dispose(): void;
}

export interface HumanoidRig {
  /** Root to bind an AnimationMixer to. */
  readonly root: THREE.Object3D;
  /** Scene node name of a normalized humanoid bone (hips, leftUpperArm...), or null if the avatar lacks it. */
  nodeName(bone: string): string | null;
  /** Hips height above the floor in the rest pose, metres. */
  readonly hipsHeight: number;
  /** True when the rig's model space faces -Z (VRM 0.x), so clips must be mirrored. */
  readonly facesNegativeZ: boolean;
}

/**
 * Body motion for an avatar under logical names: idle, talk, walk, run, and any gestures.
 * Backed by retargeted clips (CC0 Universal Animation Library) or procedural motion.
 */
export interface AnimationLibrary {
  /** Prepare clips for the loaded avatar. Call after AvatarAdapter.load. */
  load(): Promise<void>;
  list(): string[];
  readonly current: string | null;
  play(name: string, opts?: { fadeS?: number; loop?: boolean }): void;
  /** Ground speed (m/s) a locomotion clip shows at time scale 1 on this avatar; null if not locomotion. */
  groundSpeed(name: string): number | null;
  /** Playback rate of the current clip; locomotion matches it to actual speed to stop foot sliding. */
  setTimeScale(scale: number): void;
  update(dt: number): void;
}

export interface NavigationProvider {
  init(manifest: RoomManifest, navMeshUrl?: string): Promise<void>;
  findPath(from: Vec2, to: Vec2): Vec2[] | null;
  closestPoint(p: Vec2): Vec2 | null;
  /** Floor geometry for debug drawing. */
  debugMesh(): THREE.Object3D | null;
}

export interface RoomProvider {
  build(manifest: RoomManifest, quality: QualitySettings): THREE.Object3D;
}

export interface LipSyncDriver {
  /** Add a chunk's timeline (ms from chunk start) starting at an AudioContext time. Omit visemes for audio-driven drivers. */
  start(startAt: number, visemes?: { t: number; v: Viseme }[]): void;
  stop(): void;
  update(audioTime: number, avatar: AvatarAdapter): void;
}

export interface AudioPlayer {
  readonly context: AudioContext | null;
  unlock(): Promise<void>;
  enqueue(pcm: Int16Array, sampleRate: number): number; // returns scheduled start time
  stop(): void;
}

export interface MicCapture {
  start(): Promise<void>;
  stop(): void;
  onFrame(cb: (pcm16k: Int16Array) => void): void;
}

export interface AudioFrame { kind: number; streamId: number; seq: number; pcm: Int16Array }

export type ConnectionState = 'offline' | 'connecting' | 'open' | 'reconnecting' | 'closed';

export interface ProtocolClient {
  readonly state: ConnectionState;
  readonly sessionId: string | null;
  connect(): void;
  close(): void;
  send<T extends ClientType>(type: T, data: ClientData<T>): void;
  on<T extends ServerType>(type: T, cb: (msg: ServerMsg<T>) => void): () => void;
  /** Binary frames: [u8 kind][u32 stream_id][u32 seq][payload], header big-endian. */
  onBinary(cb: (frame: AudioFrame) => void): () => void;
  onState(cb: (s: ConnectionState) => void): () => void;
}

export interface QualitySettings {
  name: 'desktop' | 'mobile' | 'low';
  pixelRatio: number;
  maxFps: number;
  shadows: boolean;
  springBones: boolean;
  textureSize: number;
  antialias: boolean;
}

export interface QualityProfile {
  readonly current: QualitySettings;
  /** Feed frame times; returns a new profile when it decided to step down. */
  sample(frameMs: number): QualitySettings | null;
}

export interface LifecycleManager {
  onHidden(cb: () => void): void;
  onVisible(cb: () => void): void;
  keepAwake(on: boolean): Promise<void>;
}
