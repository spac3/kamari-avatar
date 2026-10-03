import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import type { AvatarAdapter } from '../interfaces';
import type { Viseme } from '../protocol';
import { vowelWeights, type VrmVowel } from './visemeMap';

export class VrmAvatarAdapter implements AvatarAdapter {
  readonly object = new THREE.Group();
  private vrm: VRM | null = null;
  private visemes: Partial<Record<Viseme, number>> = {};
  private readonly lookTarget = new THREE.Object3D();

  constructor(private readonly opts: { springBones?: boolean } = {}) {
    this.object.name = 'avatar';
  }

  async load(url: string): Promise<void> {
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = await loader.loadAsync(url);
    const vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) throw new Error(`${url} is not a VRM`);
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM0 faces -Z; make every avatar face +Z
    vrm.scene.traverse((o) => {
      o.frustumCulled = false; // skinned bounds are unreliable once animated
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.object.add(vrm.scene);
    this.vrm = vrm;
  }

  setViseme(viseme: Viseme, weight: number): void {
    this.visemes[viseme] = weight;
  }

  setExpression(name: string, weight: number): void {
    this.vrm?.expressionManager?.setValue(name, weight);
  }

  setBlink(weight: number): void {
    this.vrm?.expressionManager?.setValue('blink', weight);
  }

  lookAt(target: THREE.Vector3 | null): void {
    if (!this.vrm?.lookAt) return;
    if (target) {
      this.lookTarget.position.copy(target); // world space; the target is never parented
      this.lookTarget.updateMatrixWorld();
      this.vrm.lookAt.target = this.lookTarget;
    } else {
      this.vrm.lookAt.target = null;
    }
  }

  bone(name: string): THREE.Object3D | null {
    return this.vrm?.humanoid.getNormalizedBoneNode(name as never) ?? null;
  }

  update(dt: number): void {
    const vrm = this.vrm;
    if (!vrm) return;
    const vowels = vowelWeights(this.visemes);
    for (const k of Object.keys(vowels) as VrmVowel[]) vrm.expressionManager?.setValue(k, vowels[k]);
    if (this.opts.springBones === false) {
      vrm.humanoid.update();
      vrm.lookAt?.update(dt);
      vrm.expressionManager?.update();
      vrm.nodeConstraintManager?.update();
    } else {
      vrm.update(dt);
    }
  }

  dispose(): void {
    if (this.vrm) VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
  }
}
