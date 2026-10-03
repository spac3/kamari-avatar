/**
 * Bake each room's navmesh at build time (never on the phone).
 * Output: public/rooms/<room>/navmesh.bin
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportNavMesh, init } from 'recast-navigation';
import { generateSoloNavMesh } from 'recast-navigation/generators';
import { NAVMESH_CONFIG, walkableGeometry } from '../src/room/geometry';
import { loadManifest } from '../src/room/manifest';

const here = dirname(fileURLToPath(import.meta.url));

await init();
for (const roomId of ['studio']) {
  const soup = walkableGeometry(loadManifest(roomId));
  const result = generateSoloNavMesh(soup.positions, soup.indices, NAVMESH_CONFIG);
  if (!result.success) throw new Error(`navmesh bake failed for ${roomId}: ${result.error}`);
  const out = resolve(here, `../public/rooms/${roomId}/navmesh.bin`);
  mkdirSync(dirname(out), { recursive: true });
  const data = exportNavMesh(result.navMesh);
  writeFileSync(out, data);
  console.log(`baked ${roomId}: ${data.byteLength} bytes -> ${out}`);
}
