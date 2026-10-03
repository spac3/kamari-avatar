import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebAudioPlayer } from './audio/WebAudioPlayer';
import { configFromQuery, registerBuiltins } from './config';
import type { AnimationLibrary, AvatarAdapter, NavigationProvider, ProtocolClient, QualitySettings, RoomProvider } from './interfaces';
import { BrowserLifecycle } from './lifecycle/BrowserLifecycle';
import { WebSocketProtocolClient } from './net/WebSocketProtocolClient';
import { AdaptiveQuality, detectDevice, presetFor } from './quality/QualityProfile';
import { create } from './registry';
import { loadManifest } from './room/manifest';
import './style.css';

const VERSION = '0.1.0';
const cfg = configFromQuery(location.search);
registerBuiltins();

const manifest = loadManifest(cfg.roomId);
const device = detectDevice();
const quality = new AdaptiveQuality(cfg.quality === 'auto' ? presetFor(device) : cfg.quality);
const base = import.meta.env.BASE_URL;

// ---------------------------------------------------------------- renderer, scene, camera
const canvas = document.querySelector<HTMLCanvasElement>('#scene')!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: quality.current.antialias, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xf4efe6);
const camera = new THREE.PerspectiveCamera(45, 1, 0.05, 50);
const controls = new OrbitControls(camera, canvas);
controls.target.set(0, 1.0, -0.6);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 1.2;
controls.maxDistance = 9;

const hemi = new THREE.HemisphereLight(0xffffff, 0xb9a88f, 1.6);
const sun = new THREE.DirectionalLight(0xfff2dd, 1.8);
sun.position.set(-2, 5, 3);
sun.shadow.mapSize.set(1024, 1024);
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 });
scene.add(hemi, sun);

let blobShadow: THREE.Mesh | null = null;
let started = false;

function applyQuality(q: QualitySettings): void {
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.pixelRatio));
  renderer.shadowMap.enabled = q.shadows;
  sun.castShadow = q.shadows;
  if (blobShadow) blobShadow.visible = !q.shadows;
  hud.quality.textContent = q.name;
  resize();
}

function resize(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  // Portrait phones: pull the camera back so the avatar and room stay framed.
  const portrait = h > w;
  camera.fov = portrait ? 62 : 45;
  camera.updateProjectionMatrix();
  if (!started) {
    camera.position.set(0, portrait ? 1.7 : 1.6, portrait ? 5.6 : 4.2);
    controls.target.set(0, portrait ? 0.9 : 1.0, -0.6);
  }
}

// ---------------------------------------------------------------- HUD
const $ = (id: string) => document.getElementById(id)!;
const hud = { fps: $('fps'), conn: $('conn'), quality: $('quality'), status: $('status') };

// ---------------------------------------------------------------- components
const room = create<RoomProvider>('room', cfg.room);
scene.add(room.build(manifest, quality.current));

const avatar = create<AvatarAdapter>('avatar', { ...cfg.avatar, options: { ...cfg.avatar.options, springBones: quality.current.springBones } });
const anim = create<AnimationLibrary>('animation', { ...cfg.animation, options: { avatar } });
const nav = create<NavigationProvider>('navigation', cfg.navigation);

const player = new WebAudioPlayer();
const lifecycle = new BrowserLifecycle();
const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${(cfg.net.options?.path as string) ?? '/ws'}`;
const net = create<ProtocolClient>('net', {
  ...cfg.net,
  options: {
    url: wsUrl,
    hello: {
      client: 'web', version: VERSION, room_id: manifest.room_id, device: device.coarsePointer ? 'mobile' : 'desktop',
      capabilities: { visemes: 'oculus15', audio_driven_lipsync: false, mic_modes: device.coarsePointer ? ['ptt'] : ['ptt', 'open_mic'] },
    },
  },
});

const spawn = manifest.spawn;
avatar.object.position.set(spawn.position.x, 0, spawn.position.z);
avatar.object.rotation.y = THREE.MathUtils.degToRad(spawn.heading_deg);
scene.add(avatar.object);

blobShadow = new THREE.Mesh(new THREE.CircleGeometry(0.32, 24), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.18, depthWrite: false }));
blobShadow.rotation.x = -Math.PI / 2;
blobShadow.position.y = 0.01;
avatar.object.add(blobShadow);

// Location markers + path preview (walking itself arrives in M1).
const markers = new THREE.Group();
for (const loc of manifest.locations) {
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 24), new THREE.MeshBasicMaterial({ color: 0x2f7d6d }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.set(loc.position.x, 0.015, loc.position.z);
  ring.name = `loc:${loc.name}`;
  markers.add(ring);
}
markers.visible = cfg.debug;
scene.add(markers);
const pathLine = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xd2492a }));
scene.add(pathLine);

function previewPath(name: string): void {
  const loc = manifest.locations.find((l) => l.name === name)!;
  const from = { x: avatar.object.position.x, z: avatar.object.position.z };
  const path = nav.findPath(from, loc.position);
  hud.status.textContent = path ? `Path to ${loc.label}: ${path.length} points` : `${loc.label} is unreachable`;
  pathLine.geometry.setFromPoints((path ?? []).map((p) => new THREE.Vector3(p.x, 0.04, p.z)));
}

function buildDebugPanel(): void {
  const panel = $('locations');
  for (const loc of manifest.locations) {
    const b = document.createElement('button');
    b.textContent = loc.label;
    b.onclick = () => previewPath(loc.name);
    panel.appendChild(b);
  }
  const navBtn = $('toggle-nav') as HTMLButtonElement;
  navBtn.onclick = () => {
    const mesh = scene.getObjectByName('navmesh-debug');
    if (mesh) mesh.visible = !mesh.visible;
    markers.visible = !markers.visible;
  };
}

// ---------------------------------------------------------------- start
async function start(): Promise<void> {
  applyQuality(quality.current);
  addEventListener('resize', resize);
  buildDebugPanel();
  started = true;

  const results = await Promise.allSettled([
    avatar.load(`${base}${manifest.avatar.url}`),
    nav.init(manifest, `${base}rooms/${manifest.room_id}/navmesh.bin`),
  ]);
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${['avatar', 'navigation'][i]}: ${r.reason}`] : []));
  hud.status.textContent = failed.length ? failed.join(' | ') : 'Ready';
  const navMesh = nav.debugMesh();
  if (navMesh) {
    navMesh.visible = cfg.debug;
    scene.add(navMesh);
  }
  avatar.lookAt(camera.position);

  net.onState((s) => (hud.conn.textContent = s));
  lifecycle.onHidden(() => net.send('visibility', { state: 'hidden' }));
  lifecycle.onVisible(() => {
    if (net instanceof WebSocketProtocolClient) net.wake();
    net.send('visibility', { state: 'visible' });
  });

  loop();
  document.body.dataset.ready = 'true';
}

// Audio needs a user gesture on every mobile browser, so the session starts from a tap.
$('start').addEventListener('click', async () => {
  $('overlay').hidden = true;
  try {
    await player.unlock();
  } catch {
    hud.status.textContent = 'Audio is blocked; tap again to retry';
  }
  void lifecycle.keepAwake(true);
  net.connect();
});

// ---------------------------------------------------------------- loop
const timer = new THREE.Timer();
let acc = 0;
let frames = 0;
let fpsT = 0;

function loop(time?: number): void {
  requestAnimationFrame(loop);
  timer.update(time);
  const dt = timer.getDelta();
  acc += dt;
  const minDt = 1 / quality.current.maxFps;
  if (acc < minDt * 0.95) return; // frame cap (30 fps on phones saves heat and battery)
  const step = Math.min(acc, 0.1);
  acc = 0;

  anim.update(step);
  avatar.lookAt(camera.position);
  avatar.update(step);
  controls.update();
  renderer.render(scene, camera);

  frames++;
  fpsT += step;
  if (fpsT >= 0.5) {
    hud.fps.textContent = String(Math.round(frames / fpsT));
    frames = 0;
    fpsT = 0;
  }
  const downgraded = quality.sample(step * 1000);
  if (downgraded) applyQuality(downgraded);
}

void start();
