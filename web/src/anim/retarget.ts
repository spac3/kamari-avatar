import * as THREE from 'three';
import type { HumanoidRig } from '../interfaces';

/** Universal Animation Library (Rigify DEF- bones) -> VRM humanoid bone names. */
export const UAL_BONES: Record<string, string> = {
  'DEF-hips': 'hips',
  'DEF-spine.001': 'spine',
  'DEF-spine.002': 'chest',
  'DEF-spine.003': 'upperChest',
  'DEF-neck': 'neck',
  'DEF-head': 'head',
  ...side('L', 'left'),
  ...side('R', 'right'),
};

function side(s: 'L' | 'R', p: 'left' | 'right'): Record<string, string> {
  const m: Record<string, string> = {
    [`DEF-shoulder.${s}`]: `${p}Shoulder`,
    [`DEF-upper_arm.${s}`]: `${p}UpperArm`,
    [`DEF-forearm.${s}`]: `${p}LowerArm`,
    [`DEF-hand.${s}`]: `${p}Hand`,
    [`DEF-thigh.${s}`]: `${p}UpperLeg`,
    [`DEF-shin.${s}`]: `${p}LowerLeg`,
    [`DEF-foot.${s}`]: `${p}Foot`,
    [`DEF-toe.${s}`]: `${p}Toes`,
    [`DEF-thumb.01.${s}`]: `${p}ThumbMetacarpal`,
    [`DEF-thumb.02.${s}`]: `${p}ThumbProximal`,
    [`DEF-thumb.03.${s}`]: `${p}ThumbDistal`,
  };
  for (const [src, dst] of [['index', 'Index'], ['middle', 'Middle'], ['ring', 'Ring'], ['pinky', 'Little']]) {
    m[`DEF-f_${src}.01.${s}`] = `${p}${dst}Proximal`;
    m[`DEF-f_${src}.02.${s}`] = `${p}${dst}Intermediate`;
    m[`DEF-f_${src}.03.${s}`] = `${p}${dst}Distal`;
  }
  return m;
}

const q = new THREE.Quaternion();
const restInv = new THREE.Quaternion();
const parentRest = new THREE.Quaternion();
const v = new THREE.Vector3();

/**
 * Retarget a clip authored on `source` (a skeleton in T-pose rest, facing +Z, Y up) onto a
 * humanoid rig whose normalized bones rest at identity. Each bone's local rotation becomes the
 * world-space change from its rest pose, which is what normalized humanoid bones expect.
 * Only the hips keep translation, scaled to the avatar's hips height; clips must be in place.
 */
export function retargetClip(
  clip: THREE.AnimationClip,
  source: THREE.Object3D,
  rig: HumanoidRig,
  boneMap: Record<string, string> = UAL_BONES,
  name = clip.name,
): THREE.AnimationClip {
  source.updateMatrixWorld(true);
  const byNode = new Map<string, string>();
  for (const [src, bone] of Object.entries(boneMap)) byNode.set(THREE.PropertyBinding.sanitizeNodeName(src), bone);
  const srcHips = source.getObjectByName(THREE.PropertyBinding.sanitizeNodeName(invert(boneMap).hips));
  const srcHipsHeight = srcHips ? srcHips.getWorldPosition(v).y : rig.hipsHeight;
  const scale = rig.hipsHeight / srcHipsHeight;
  // VRM 0.x normalized space faces -Z: mirror by rotating 180 degrees about Y (negate x and z).
  const flip = rig.facesNegativeZ ? -1 : 1;

  const tracks: THREE.KeyframeTrack[] = [];
  for (const track of clip.tracks) {
    const [nodeName, prop] = track.name.split('.');
    const bone = byNode.get(nodeName);
    const target = bone && rig.nodeName(bone);
    const node = source.getObjectByName(nodeName);
    if (!bone || !target || !node?.parent) continue;

    if (prop === 'quaternion') {
      node.getWorldQuaternion(restInv).invert();
      node.parent.getWorldQuaternion(parentRest);
      const values = new Float32Array(track.values.length);
      for (let i = 0; i < values.length; i += 4) {
        q.fromArray(track.values, i).premultiply(parentRest).multiply(restInv);
        values.set([flip * q.x, q.y, flip * q.z, q.w], i);
      }
      tracks.push(new THREE.QuaternionKeyframeTrack(`${target}.quaternion`, track.times, values));
    } else if (prop === 'position' && bone === 'hips') {
      const values = new Float32Array(track.values.length);
      for (let i = 0; i < values.length; i += 3) {
        v.fromArray(track.values, i).applyMatrix4(node.parent.matrixWorld).multiplyScalar(scale);
        values.set([flip * v.x, v.y, flip * v.z], i);
      }
      tracks.push(new THREE.VectorKeyframeTrack(`${target}.position`, track.times, values));
    }
  }
  return new THREE.AnimationClip(name, clip.duration, tracks);
}

function invert(m: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(m).map(([k, val]) => [val, k]));
}
