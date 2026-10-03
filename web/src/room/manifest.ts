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

export interface RoomManifest {
  room_id: string;
  manifest_version: string;
  floor: { min: Vec2; max: Vec2 };
  wall_height: number;
  spawn: { position: Vec2; heading_deg: number };
  locations: NamedLocation[];
  obstacles: Obstacle[];
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
