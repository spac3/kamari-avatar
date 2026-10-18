import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebAudioPlayer } from './audio/WebAudioPlayer';
import { configFromQuery, registerBuiltins } from './config';
import type {
  AnimationLibrary,
  AvatarAdapter,
  LipSyncDriver,
  NavigationProvider,
  ProtocolClient,
  QualitySettings,
  RoomProvider,
  ServerMsg,
  Vec2,
} from './interfaces';
import { BrowserLifecycle } from './lifecycle/BrowserLifecycle';
import { Locomotion, pathLength, type LocoState, type WalkCommand } from './loco/Locomotion';
import { WebSocketProtocolClient } from './net/WebSocketProtocolClient';
import { AdaptiveQuality, detectDevice, presetFor } from './quality/QualityProfile';
import { create } from './registry';
import { loadManifest } from './room/manifest';
import { SpeechPlayer } from './speech/SpeechPlayer';
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
const animUrl = cfg.animation.options?.url as string | undefined;
let anim = create<AnimationLibrary>('animation', { ...cfg.animation, options: { ...cfg.animation.options, avatar, url: animUrl && `${base}${animUrl}` } });
const nav = create<NavigationProvider>('navigation', cfg.navigation);
const lipSync = create<LipSyncDriver>('lipsync', cfg.lipSync);

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

// Location markers (debug) and the path being walked.
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

pathLine.visible = cfg.debug;
scene.add(pathLine);

// ---------------------------------------------------------------- walking
let loco = new Locomotion(avatar.object, anim);
let localCmds = 0;

function resolveTarget(target: ServerMsg<'walk_to'>['data']['target']): { to: Vec2; faceDeg: number | null; location: string | null } | null {
  if (target.location) {
    const loc = manifest.locations.find((l) => l.name === target.location);
    return loc ? { to: loc.position, faceDeg: loc.heading_deg, location: loc.name } : null;
  }
  if (target.point) return { to: target.point, faceDeg: null, location: null };
  if (target.user) {
    // Walk towards the viewer: the camera's spot on the floor, stopping short of it.
    const cam = new THREE.Vector2(camera.position.x, camera.position.z);
    const here = new THREE.Vector2(avatar.object.position.x, avatar.object.position.z);
    const to = here.clone().lerp(cam, Math.max(0, 1 - 1.5 / Math.max(1.5, here.distanceTo(cam))));
    return { to: { x: to.x, z: to.y }, faceDeg: (Math.atan2(cam.x - to.x, cam.y - to.y) * 180) / Math.PI, location: null };
  }
  return null;
}

function walk(data: ServerMsg<'walk_to'>['data']): void {
  const t = resolveTarget(data.target);
  if (!t) {
    net.send('walk_failed', { cmd_id: data.cmd_id, reason: 'unknown_location' });
    return;
  }
  const from = { x: avatar.object.position.x, z: avatar.object.position.z };
  const path = nav.findPath(from, t.to);
  if (!path) {
    const nearest = nav.closestPoint(t.to);
    net.send('walk_failed', { cmd_id: data.cmd_id, reason: 'unreachable', ...(nearest ? { nearest } : {}) });
    hud.status.textContent = `Can't reach ${t.location ?? 'that spot'}`;
    return;
  }
  pathLine.geometry.setFromPoints(path.map((p) => new THREE.Vector3(p.x, 0.04, p.z)));
  const cmd: WalkCommand = { cmdId: data.cmd_id, path, location: t.location, faceDeg: t.faceDeg, speed: data.speed === 'run' ? 'run' : 'walk' };
  const replaced = loco.start(cmd);
  if (replaced) net.send('command_cancelled', { cmd_id: replaced.cmdId, reason: 'replaced' });
  const len = pathLength(path);
  const speed = anim.groundSpeed(cmd.speed) ?? 1;
  net.send('walk_started', { cmd_id: cmd.cmdId, path_length_m: Math.round(len * 100) / 100, eta_ms: Math.round((len / speed) * 1000) });
  hud.status.textContent = `Walking to ${t.location ?? 'a point'} (${len.toFixed(1)} m)`;
}

function wireLocomotion(): void {
  loco.onArrived = (cmd) => {
    const position = loco.position;
    net.send('arrived', { cmd_id: cmd.cmdId, location: cmd.location, position });
    hud.status.textContent = `Arrived${cmd.location ? ` at ${cmd.location}` : ''}`;
    sendState();
  };
  loco.onStateChange = () => sendState();
}

function sendState(): void {
  net.send('state', {
    loco: loco.state as LocoState,
    speech: speech.talking ? 'talking' : 'silent',
    position: loco.position,
    heading_deg: Math.round(loco.headingDeg),
  });
}

// ---------------------------------------------------------------- speech
const speech = new SpeechPlayer(player, lipSync, (type, data) => net.send(type, data));

/** Debug commands go through the backend, like the LLM's will; offline they run locally. */
function command(text: string): void {
  if (net.state === 'open') {
    net.send('user_text', { text });
    return;
  }
  const m = /^(?:go|walk) to (.+)$/i.exec(text);
  const loc = m && manifest.locations.find((l) => l.name === m[1] || l.label.toLowerCase() === m[1].toLowerCase());
  if (loc) walk({ cmd_id: `local_${++localCmds}`, target: { location: loc.name } });
  else hud.status.textContent = 'Offline: only "go to <place>" works without the server';
}

function buildDebugPanel(): void {
  const panel = $('locations');
  for (const loc of manifest.locations) {
    const b = document.createElement('button');
    b.textContent = loc.label;
    b.onclick = () => command(`go to ${loc.name}`);
    panel.appendChild(b);
  }
  const form = $('say') as HTMLFormElement;
  const input = form.querySelector('input')!;
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) command(/^(go|walk|move) /i.test(text) ? text : `say ${text}`);
    input.value = '';
  };
  const navBtn = $('toggle-nav') as HTMLButtonElement;
  navBtn.onclick = () => {
    const mesh = scene.getObjectByName('navmesh-debug');
    if (mesh) mesh.visible = !mesh.visible;
    markers.visible = !markers.visible;
    pathLine.visible = markers.visible;
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
  try {
    await anim.load();
  } catch (e) {
    // e.g. the fake avatar has no humanoid rig: fall back to procedural motion
    console.warn('animation clips unavailable, using procedural idle:', e);
    anim = create<AnimationLibrary>('animation', { impl: 'procedural', options: { avatar } });
    loco = new Locomotion(avatar.object, anim);
  }
  wireLocomotion();
  hud.status.textContent = failed.length ? failed.join(' | ') : 'Ready';
  const navMesh = nav.debugMesh();
  if (navMesh) {
    navMesh.visible = cfg.debug;
    scene.add(navMesh);
  }
  avatar.lookAt(camera.position);

  net.onState((s) => (hud.conn.textContent = s));
  net.on('walk_to', (m) => walk(m.data));
  net.on('stop_moving', (m) => {
    const stopped = loco.stop();
    if (stopped) net.send('command_cancelled', { cmd_id: stopped.cmdId, reason: 'stopped' });
    net.send('ack', { cmd_id: m.data.cmd_id });
  });
  net.on('speech_start', (m) => speech.onStart(m));
  net.on('speech_chunk', (m) => speech.onChunk(m));
  net.on('speech_end', (m) => speech.onEnd(m));
  net.on('speech_cancel', (m) => speech.onCancel(m));
  net.onBinary((f) => speech.onAudio(f));
  net.on('state_sync', (m) => {
    // Back from the background: snap to where the server says we are unless we are mid-walk.
    if (!loco.cmd) {
      avatar.object.position.set(m.data.avatar.position.x, 0, m.data.avatar.position.z);
      avatar.object.rotation.y = THREE.MathUtils.degToRad(m.data.avatar.heading_deg);
    }
  });
  net.on('error', (m) => (hud.status.textContent = `Server: ${m.data.message}`));
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

// Keep the avatar framed (it walks off screen on a portrait phone): glide the orbit target
// after it and move the camera by the same amount, so the user's chosen angle is kept.
const followTarget = new THREE.Vector3();
const followDelta = new THREE.Vector3();
let followOffset: THREE.Vector3 | null = null;
function follow(dt: number): void {
  followOffset ??= controls.target.clone().sub(avatar.object.position).setY(0);
  followTarget.copy(avatar.object.position).add(followOffset).setY(controls.target.y);
  followDelta.subVectors(followTarget, controls.target).multiplyScalar(Math.min(1, dt * 2.5));
  controls.target.add(followDelta);
  camera.position.add(followDelta);
}

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

  loco.update(step);
  speech.update();
  anim.play(loco.moving ? (loco.cmd?.speed === 'run' ? 'run' : 'walk') : speech.talking ? 'talk' : 'idle', { fadeS: 0.3 });
  if (!loco.moving) anim.setTimeScale(1);
  anim.update(step);
  lipSync.update(player.context?.currentTime ?? 0, avatar);
  avatar.lookAt(camera.position);
  avatar.update(step);
  follow(step);
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
