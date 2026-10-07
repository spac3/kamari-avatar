/**
 * Builds public/animations/ual.glb from Quaternius' Universal Animation Library (CC0):
 * keeps the clips the avatar uses plus the skeleton, drops the mannequin mesh and the
 * tracks retargeting ignores (scale everywhere, translation everywhere but the hips).
 *
 * Usage: npx tsx scripts/build-animations.ts path/to/AnimationLibrary_Godot_Standard.gltf
 * Source: https://quaternius.com/packs/universalanimationlibrary.html (or its itch.io page).
 */
import { NodeIO } from '@gltf-transform/core';
import { prune } from '@gltf-transform/functions';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIPS = [
  'Idle_Loop',
  'Idle_Talking_Loop',
  'Walk_Loop',
  'Jog_Fwd_Loop',
  'Interact',
  'Sitting_Enter',
  'Sitting_Idle_Loop',
  'Sitting_Exit',
  'Dance_Loop',
];

const src = process.argv[2];
if (!src) {
  console.error('usage: tsx scripts/build-animations.ts <UAL .gltf or .glb>');
  process.exit(1);
}
const out = resolve(dirname(fileURLToPath(import.meta.url)), '../public/animations/ual.glb');

const io = new NodeIO();
const doc = await io.read(src);
const root = doc.getRoot();

for (const anim of root.listAnimations()) {
  if (!CLIPS.includes(anim.getName())) {
    anim.dispose();
    continue;
  }
  for (const ch of anim.listChannels()) {
    const path = ch.getTargetPath();
    const node = ch.getTargetNode()?.getName() ?? '';
    if (path === 'scale' || (path === 'translation' && node !== 'DEF-hips') || node === 'root') {
      ch.getSampler()?.dispose();
      ch.dispose();
    }
  }
}
for (const node of root.listNodes()) if (node.getMesh()) node.setMesh(null).setSkin(null);
for (const mesh of root.listMeshes()) mesh.dispose();
await doc.transform(prune({ keepLeaves: true }));

const missing = CLIPS.filter((c) => !root.listAnimations().some((a) => a.getName() === c));
if (missing.length) throw new Error(`clips not found in ${src}: ${missing.join(', ')}`);
mkdirSync(dirname(out), { recursive: true });
await io.write(out, doc);
console.log(`wrote ${out} with ${root.listAnimations().length} clips`);
