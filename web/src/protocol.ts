/* Generated from schema/protocol.schema.json by scripts/gen-types.sh. Do not edit. */

/**
 * Kamari avatar WebSocket protocol v1. Source of truth for generated Python and TypeScript types. Binary audio frames: [u8 kind][u32 stream_id][u32 seq][payload], kind 0x01 = mic PCM16 16 kHz (client to server), 0x02 = TTS PCM16 (server to client).
 */
export type Protocol = ServerMessage | ClientMessage;
export type ServerMessage =
  | SessionReadyMessage
  | WalkToMessage
  | StopMovingMessage
  | SpeechStartMessage
  | SpeechChunkMessage
  | SpeechEndMessage
  | SpeechCancelMessage
  | GestureMessage
  | LookAtMessage
  | SetExpressionMessage
  | ListeningMessage
  | TranscriptMessage
  | ErrorMessage
  | StateSyncMessage
  | PongMessage;
/**
 * Oculus 15-viseme set
 */
export type Viseme =
  "sil" | "PP" | "FF" | "TH" | "DD" | "kk" | "CH" | "SS" | "nn" | "RR" | "aa" | "E" | "I" | "O" | "U";
export type ClientMessage =
  | HelloMessage
  | ResumeMessage
  | VisibilityMessage
  | PingMessage
  | AckMessage
  | WalkStartedMessage
  | ArrivedMessage
  | WalkFailedMessage
  | CommandCancelledMessage
  | SpeechStartedMessage
  | SpeechFinishedMessage
  | GestureFinishedMessage
  | UserSpeechStartMessage
  | UserSpeechEndMessage
  | PttMessage
  | UserTextMessage
  | StateMessage;

export interface SessionReadyMessage {
  v: 1;
  type: "session_ready";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SessionReadyData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface SessionReadyData {
  session_id: string;
  resume_token: string;
  manifest_version: string;
  audio: {
    tts_rate: number;
    mic_rate: number;
  };
}
export interface WalkToMessage {
  v: 1;
  type: "walk_to";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: WalkToData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface WalkToData {
  cmd_id: string;
  target: Target;
  speed?: "walk" | "run";
  face_on_arrival?: string;
  interrupt?: "replace" | "queue";
}
/**
 * Exactly one of location, point or user.
 */
export interface Target {
  /**
   * Named location from the room manifest
   */
  location?: string;
  point?: Vec2;
  user?: boolean;
}
/**
 * Point on the floor plane, metres.
 */
export interface Vec2 {
  x: number;
  z: number;
}
export interface StopMovingMessage {
  v: 1;
  type: "stop_moving";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: StopMovingData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface StopMovingData {
  cmd_id: string;
  blend_ms?: number;
}
export interface SpeechStartMessage {
  v: 1;
  type: "speech_start";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SpeechStartData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface SpeechStartData {
  utterance_id: string;
  text: string;
  voice?: string;
}
export interface SpeechChunkMessage {
  v: 1;
  type: "speech_chunk";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SpeechChunkData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface SpeechChunkData {
  utterance_id: string;
  stream_id: number;
  seq: number;
  sample_rate: number;
  duration_ms: number;
  visemes?: VisemeKey[];
  words?: WordKey[];
  last: boolean;
}
export interface VisemeKey {
  /**
   * ms from chunk start
   */
  t: number;
  v: Viseme;
}
export interface WordKey {
  t: number;
  w: string;
}
export interface SpeechEndMessage {
  v: 1;
  type: "speech_end";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SpeechEndData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface SpeechEndData {
  utterance_id: string;
  total_chunks: number;
}
export interface SpeechCancelMessage {
  v: 1;
  type: "speech_cancel";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SpeechCancelData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface SpeechCancelData {
  utterance_id: string;
  reason: string;
}
export interface GestureMessage {
  v: 1;
  type: "gesture";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: GestureData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface GestureData {
  cmd_id: string;
  name: string;
  layer?: "upper" | "full";
  loop?: boolean;
  blend_ms?: number;
}
export interface LookAtMessage {
  v: 1;
  type: "look_at";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: LookAtData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface LookAtData {
  cmd_id: string;
  target: Target;
}
export interface SetExpressionMessage {
  v: 1;
  type: "set_expression";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SetExpressionData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface SetExpressionData {
  name: string;
  weight: number;
  duration_ms?: number;
}
export interface ListeningMessage {
  v: 1;
  type: "listening";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: ListeningData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface ListeningData {
  mode: "ptt" | "open_mic" | "off";
}
export interface TranscriptMessage {
  v: 1;
  type: "transcript";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: TranscriptData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface TranscriptData {
  text: string;
  final: boolean;
}
export interface ErrorMessage {
  v: 1;
  type: "error";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: ErrorData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface ErrorData {
  code: string;
  ref?: string;
  message: string;
}
export interface StateSyncMessage {
  v: 1;
  type: "state_sync";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: StateSyncData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface StateSyncData {
  session_id: string;
  last_seq: number;
  avatar: AvatarSnapshot;
  pending_cmds: string[];
  speech: "silent" | "talking" | "listening" | "thinking";
}
export interface AvatarSnapshot {
  location: string | null;
  position: Vec2;
  heading_deg: number;
}
export interface PongMessage {
  v: 1;
  type: "pong";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: PongData;
  /**
   * Monotonic per session, used by resume
   */
  seq: number;
}
export interface PongData {
  t: number;
}
export interface HelloMessage {
  v: 1;
  type: "hello";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: HelloData;
}
export interface HelloData {
  client: string;
  version: string;
  room_id: string;
  device?: "desktop" | "mobile";
  capabilities?: {
    visemes?: string;
    audio_driven_lipsync?: boolean;
    mic_modes?: ("ptt" | "open_mic")[];
  };
  output_latency_ms?: number;
}
export interface ResumeMessage {
  v: 1;
  type: "resume";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: ResumeData;
}
export interface ResumeData {
  session_id: string;
  resume_token: string;
  last_seq_received: number;
}
export interface VisibilityMessage {
  v: 1;
  type: "visibility";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: VisibilityData;
}
export interface VisibilityData {
  state: "hidden" | "visible";
}
export interface PingMessage {
  v: 1;
  type: "ping";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: PingData;
}
export interface PingData {
  t: number;
}
export interface AckMessage {
  v: 1;
  type: "ack";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: AckData;
}
export interface AckData {
  cmd_id: string;
}
export interface WalkStartedMessage {
  v: 1;
  type: "walk_started";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: WalkStartedData;
}
export interface WalkStartedData {
  cmd_id: string;
  path_length_m: number;
  eta_ms: number;
}
export interface ArrivedMessage {
  v: 1;
  type: "arrived";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: ArrivedData;
}
export interface ArrivedData {
  cmd_id: string;
  location?: string | null;
  position: Vec2;
}
export interface WalkFailedMessage {
  v: 1;
  type: "walk_failed";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: WalkFailedData;
}
export interface WalkFailedData {
  cmd_id: string;
  reason: "unreachable" | "unknown_location" | "blocked";
  nearest?: Vec2;
}
export interface CommandCancelledMessage {
  v: 1;
  type: "command_cancelled";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: CommandCancelledData;
}
export interface CommandCancelledData {
  cmd_id: string;
  reason: string;
}
export interface SpeechStartedMessage {
  v: 1;
  type: "speech_started";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SpeechStartedData;
}
export interface SpeechStartedData {
  utterance_id: string;
}
export interface SpeechFinishedMessage {
  v: 1;
  type: "speech_finished";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: SpeechFinishedData;
}
export interface SpeechFinishedData {
  utterance_id: string;
  interrupted: boolean;
  played_ms: number;
  last_word_index?: number;
}
export interface GestureFinishedMessage {
  v: 1;
  type: "gesture_finished";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: GestureFinishedData;
}
export interface GestureFinishedData {
  cmd_id: string;
  name: string;
}
export interface UserSpeechStartMessage {
  v: 1;
  type: "user_speech_start";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: UserSpeechStartData;
}
export interface UserSpeechStartData {
  segment_id: string;
  while?: "idle" | "talking" | "walking";
}
export interface UserSpeechEndMessage {
  v: 1;
  type: "user_speech_end";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: UserSpeechEndData;
}
export interface UserSpeechEndData {
  segment_id: string;
  duration_ms: number;
}
export interface PttMessage {
  v: 1;
  type: "ptt";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: PttData;
}
export interface PttData {
  state: "down" | "up";
}
export interface UserTextMessage {
  v: 1;
  type: "user_text";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: UserTextData;
}
export interface UserTextData {
  text: string;
}
export interface StateMessage {
  v: 1;
  type: "state";
  id: string;
  /**
   * Unix ms
   */
  ts: number;
  data: StateData;
}
export interface StateData {
  loco: "idle" | "turning" | "walking" | "arriving";
  speech: "silent" | "talking" | "listening" | "thinking";
  position: Vec2;
  heading_deg: number;
}
