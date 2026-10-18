import type { Vec2 } from '../interfaces';
import studio from '../../../rooms/studio/manifest.json';

export interface Obstacle {
  name: string;
  kind: string;
  center: Vec2;
  size: { x: number; y: number; z: number };
  color: string;
}

export interface NamedLocation { name: string; label: string; position: Vec2; heading_deg: number }

export interface PanelControl {
  id: string;
  label: string;
  /** `toggle` keeps an on/off state; a `button` (the default) just presses. */
  kind?: 'button' | 'toggle';
  /** Starting state of a toggle. */
  on?: boolean;
  /** What pressing it does in the browser, e.g. `lights` or `gesture:wave`. */
  action?: string;
}

/** The translucent panel on the glass: shown while the avatar stands near `location`. */
export interface PanelSpec { location: string; radius_m: number; controls: PanelControl[] }

export interface RoomManifest {
  room_id: string;
  manifest_version: string;
  floor: { min: Vec2; max: Vec2 };
  wall_height: number;
  spawn: { position: Vec2; heading_deg: number };
  locations: NamedLocation[];
  obstacles: Obstacle[];
  panel?: PanelSpec;
  gestures: string[];
  avatar: { id: string; url: string };
}

/** Rooms are bundled at build time from /rooms, the same files the backend reads. */
const rooms: Record<string, RoomManifest> = { studio: studio as RoomManifest };

export function loadManifest(roomId: string): RoomManifest {
  const m = rooms[roomId];
  if (!m) throw new Error(`unknown room "${roomId}"`);
  return m;
}
