import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { WebAudioPlayer } from './audio/WebAudioPlayer';
import { configFromQuery, registerBuiltins } from './config';
import type {
  AnimationLibrary,
  AvatarAdapter,
  GesturePlayer,
  LipSyncDriver,
  MicCapture,
  NavigationProvider,
  ProtocolClient,
  QualitySettings,
  RoomProvider,
  ScreenTouch,
  ServerMsg,
  TapPlayer,
  TouchEffect,
  Vec2,
  VoiceActivityDetector,
} from './interfaces';
import { BrowserLifecycle } from './lifecycle/BrowserLifecycle';
import { Locomotion, pathLength, type LocoState, type WalkCommand } from './loco/Locomotion';
import { OpenMic, type AvatarActivity } from './mic/OpenMic';
import { PushToTalk } from './mic/PushToTalk';
import { WebSocketProtocolClient } from './net/WebSocketProtocolClient';
import { AdaptiveQuality, detectDevice, presetFor } from './quality/QualityProfile';
import { create } from './registry';
import { loadManifest } from './room/manifest';
import { SpeechPlayer } from './speech/SpeechPlayer';
import { ScreenGlass } from './touch/ScreenGlass';
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
controls.maxPolarAngle = cfg.debug ? Math.PI * 0.49 : Math.PI / 2; // the fixed view looks straight ahead
controls.minDistance = 0.6;
controls.maxDistance = 9;
// The screen is a window onto the avatar: a fixed view, and touches go to the glass. ?debug orbits.
controls.enabled = cfg.debug;

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
  camera.fov = h > w ? 55 : 40;
  camera.updateProjectionMatrix();
  if (framed && !cfg.debug) frame();
}

// Waist-up portrait: the avatar faces the screen, its waist sits on the top edge of the controls at
// the bottom (so the screen cuts it at the waist), and it is close enough to reach the glass.
// Measured from the avatar once loaded, and again on resize.
let framed = false;
function frame(): void {
  const body = avatar.object;
  body.updateWorldMatrix(true, true);
  const at = (bone: string, fallback: number) => avatar.bone(bone)?.getWorldPosition(new THREE.Vector3()).y ?? fallback;
  const waist = (at('hips', 0.9) + at('spine', 1.0)) / 2 + 0.06;
  const top = new THREE.Box3().setFromObject(body).max.y + 0.06;
  // Screen fractions (from the top) the avatar spans: below the status chips, above the dock.
  const h = canvas.clientHeight || 1;
  const yTop = Math.min(0.3, document.querySelector('.hud')!.getBoundingClientRect().bottom / h + 0.02);
  const yWaist = Math.max(0.6, document.querySelector('.dock')!.getBoundingClientRect().top / h);
  const halfV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  // Room for the shoulders and a bit of arm on a narrow portrait screen.
  const l = avatar.bone('leftUpperArm')?.getWorldPosition(new THREE.Vector3());
  const r = avatar.bone('rightUpperArm')?.getWorldPosition(new THREE.Vector3());
  const halfW = (l && r ? l.distanceTo(r) / 2 : 0.2) + 0.12;
  const dist = Math.max((top - waist) / ((yWaist - yTop) * 2 * halfV), halfW / (halfV * camera.aspect));
  const y = waist - (0.5 - yWaist) * 2 * dist * halfV; // looking straight ahead
  // First time in front of the avatar's face; on later resizes from wherever the view is now.
  const fwd = framed
    ? camera.position.clone().sub(controls.target).setY(0).normalize()
    : new THREE.Vector3(Math.sin(body.rotation.y), 0, Math.cos(body.rotation.y));
  controls.target.set(body.position.x, y, body.position.z);
  camera.position.copy(controls.target).addScaledVector(fwd, dist);
  followOffset = null;
  framed = true;
}

// ---------------------------------------------------------------- HUD
const $ = (id: string) => document.getElementById(id)!;
const hud = { fps: $('fps'), conn: $('conn'), quality: $('quality'), status: $('status'), latency: $('latency'), you: $('you'), kamari: $('kamari') };

// ---------------------------------------------------------------- components
const room = create<RoomProvider>('room', cfg.room);
scene.add(room.build(manifest, quality.current));

const avatar = create<AvatarAdapter>('avatar', { ...cfg.avatar, options: { ...cfg.avatar.options, springBones: quality.current.springBones } });
const animUrl = cfg.animation.options?.url as string | undefined;
let anim = create<AnimationLibrary>('animation', { ...cfg.animation, options: { ...cfg.animation.options, avatar, url: animUrl && `${base}${animUrl}` } });
const nav = create<NavigationProvider>('navigation', cfg.navigation);
const lipSync = create<LipSyncDriver>('lipsync', cfg.lipSync);
const gestures = create<GesturePlayer>('gestures', { ...cfg.gestures, options: { ...cfg.gestures.options, avatar } });
const mic = create<MicCapture>('mic', cfg.mic);
const tapper = create<TapPlayer>('tap', { ...cfg.tap, options: { ...cfg.tap.options, avatar } });
const touchFx = create<TouchEffect>('touchfx', cfg.touchFx);
const glass = new ScreenGlass(camera, avatar.object, touchFx);
scene.add(touchFx.object);

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

// ---------------------------------------------------------------- gestures and looking
function locationPoint(name: string): THREE.Vector3 | null {
  const loc = manifest.locations.find((l) => l.name === name);
  return loc ? new THREE.Vector3(loc.position.x, 1.3, loc.position.z) : null;
}

// One timer for every look (server look_at, glances at touches), so a short glance never ends a longer look early.
let lookTimer: ReturnType<typeof setTimeout> | null = null;
function lookFor(target: THREE.Vector3 | null, ms: number): void {
  gestures.lookAt(target);
  if (lookTimer) clearTimeout(lookTimer);
  lookTimer = setTimeout(() => gestures.lookAt(null), ms); // then back to facing ahead
}

function lookAt(data: ServerMsg<'look_at'>['data']): void {
  const target = data.target.location ? locationPoint(data.target.location) : data.target.point ? new THREE.Vector3(data.target.point.x, 1.3, data.target.point.z) : camera.position;
  lookFor(target, 4000);
  net.send('ack', { cmd_id: data.cmd_id });
}

function gesture(data: ServerMsg<'gesture'>['data']): void {
  if (data.name === 'tap') {
    const ok = avatarTap(null, (completed, reason) =>
      completed
        ? net.send('gesture_finished', { cmd_id: data.cmd_id, name: data.name })
        : net.send('command_cancelled', { cmd_id: data.cmd_id, reason: reason ?? 'interrupted' }),
    );
    if (!ok) net.send('command_cancelled', { cmd_id: data.cmd_id, reason: 'cannot tap while walking' });
    return;
  }
  // Gestures are for the user: turn to face them first when standing (a wave at the window would face away).
  if (!loco.cmd) loco.face((Math.atan2(camera.position.x - avatar.object.position.x, camera.position.z - avatar.object.position.z) * 180) / Math.PI);
  const ok = gestures.play(data.name, (completed) =>
    completed
      ? net.send('gesture_finished', { cmd_id: data.cmd_id, name: data.name })
      : net.send('command_cancelled', { cmd_id: data.cmd_id, reason: 'replaced' }),
  );
  if (!ok) net.send('command_cancelled', { cmd_id: data.cmd_id, reason: `unknown gesture ${data.name}` });
}

// ---------------------------------------------------------------- touching the screen
// Both sides of the glass can touch it: the person with a pointer, the avatar with a fingertip.
// Each touch draws ripples and reaches glass.onTouch, where touches will make things happen.
// Screen positions, not world points: the glass moves with the avatar and the camera.
let lastUserTouch: { x: number; y: number; at: number } | null = null;
/** Reports how a tap ended: completed, or not and why. Called exactly once per tap. */
type TapDone = (completed: boolean, reason?: string) => void;
let pendingTap: { at: { x: number; y: number } | null; onDone?: TapDone } | null = null;

/** A spot on the glass in front of the chest, a little to one side: easy reach for short arms. */
function somewhereInReach(): THREE.Vector3 | null {
  const chest = avatar.bone('upperChest') ?? avatar.bone('chest');
  if (!chest) return glass.pointAt(0.5, 0.55);
  const p = chest.getWorldPosition(new THREE.Vector3());
  const side = new THREE.Vector3().crossVectors(glass.normal, new THREE.Vector3(0, 1, 0)).normalize();
  p.addScaledVector(side, (Math.random() - 0.5) * 0.4).add(new THREE.Vector3(0, 0.05 + Math.random() * 0.12, 0));
  return glass.onGlass(p);
}

/** Heading that faces the screen, and how far off it the avatar is now (degrees). */
function screenFacing(): { deg: number; off: number } {
  const deg = (Math.atan2(camera.position.x - avatar.object.position.x, camera.position.z - avatar.object.position.z) * 180) / Math.PI;
  return { deg, off: Math.abs(((deg - loco.headingDeg + 540) % 360) - 180) };
}

/**
 * The avatar taps the glass: at a screen position, back where the person just touched, or somewhere
 * in reach. Queued until it stands still facing the screen (the loop turns it and starts the tap).
 * False, with no `onDone`, if it is walking; otherwise `onDone` reports the outcome.
 */
function avatarTap(at: { x: number; y: number } | null, onDone?: TapDone): boolean {
  if (loco.moving) return false;
  cancelPendingTap('replaced');
  pendingTap = { at, onDone };
  tryPendingTap();
  return true;
}

function cancelPendingTap(reason: string): void {
  const p = pendingTap;
  pendingTap = null;
  p?.onDone?.(false, reason);
}

/** Start the waiting tap if the avatar stands facing the screen, else turn it (once per frame call). */
function tryPendingTap(): void {
  if (!pendingTap || loco.cmd) return;
  const { deg, off } = screenFacing();
  if (off > 5) {
    loco.face(deg);
    return;
  }
  const p = pendingTap;
  pendingTap = null;
  const recent = lastUserTouch && performance.now() - lastUserTouch.at < 10_000 ? lastUserTouch : null;
  const spot = p.at ?? recent;
  const target = spot ? glass.pointAt(spot.x, spot.y) : somewhereInReach();
  const pressed = target && tapper.tap(target, glass.normal, (pt) => glass.touch('avatar', pt), (c) => p.onDone?.(c, c ? undefined : 'interrupted'));
  if (!pressed) {
    p.onDone?.(false, 'out of reach');
    return;
  }
  lookFor(pressed, 1800);
}

glass.onTouch((t: ScreenTouch) => {
  hud.status.textContent = `${t.source === 'user' ? 'You' : 'Kamari'} touched the screen at ${Math.round(t.x * 100)}%, ${Math.round(t.y * 100)}%`;
  if (t.source === 'user') {
    lastUserTouch = { x: t.x, y: t.y, at: performance.now() };
    lookFor(t.point, 1500);
  }
});

function userTouch(e: PointerEvent): void {
  const rect = canvas.getBoundingClientRect();
  const point = glass.pointAt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
  if (point) glass.touch('user', point);
}

function wireTouches(): void {
  // Debug mode orbits the camera by dragging, so only a click that did not move counts as a touch there.
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (!cfg.debug) userTouch(e);
    else down = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener('pointerup', (e) => {
    if (cfg.debug && down && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 6) userTouch(e);
    down = null;
  });
}

// ---------------------------------------------------------------- speech and conversation
const speech = new SpeechPlayer(player, lipSync, (type, data) => net.send(type, data));

/** The user started talking over the avatar: stop its speech and its walk now, before the server hears. */
function bargeIn(): void {
  speech.interrupt();
  cancelPendingTap('interrupted');
  tapper.cancel();
  const stopped = loco.stop();
  if (stopped?.cmdId) net.send('command_cancelled', { cmd_id: stopped.cmdId, reason: 'interrupted' });
  if (stopped) {
    sendState();
    hud.status.textContent = 'Stopped: you started talking';
  }
}

function activity(): AvatarActivity {
  return speech.talking ? 'talking' : loco.moving ? 'walking' : 'idle';
}

const ptt = new PushToTalk(mic, net, bargeIn, () => player.context, { tailMs: cfg.mic.options?.tailMs as number | undefined });
const vadSpec = { ...cfg.vad, options: { ...cfg.vad.options, ...(typeof cfg.vad.options?.model === 'string' ? { model: `${base}${cfg.vad.options.model}` } : {}) } };
const openMic = new OpenMic(
  mic,
  create<VoiceActivityDetector>('vad', vadSpec),
  net,
  {
    activity,
    outputLevel: () => player.outputLevel(),
    duck: (on, gain) => player.setVolume(on ? gain : 1, on ? 0.04 : 0.15),
    bargeIn,
  },
  () => player.context,
  cfg.openMic,
  () => create<VoiceActivityDetector>('vad', { impl: 'energy' }),
);
const MODE_KEY = 'kamari.micMode';
function initialMode(): 'open' | 'ptt' {
  if (cfg.micMode !== 'auto') return cfg.micMode;
  try {
    const saved = localStorage.getItem(MODE_KEY);
    if (saved === 'open' || saved === 'ptt') return saved;
  } catch {
    // storage blocked: use the default
  }
  return device.coarsePointer ? 'ptt' : 'open';
}
let micMode = initialMode();
let muted = false;

/** Typed text goes to the LLM; "/go to sofa", "/say hi" and "/gesture wave" drive the avatar directly. Offline, only walking works. */
function command(text: string): void {
  const tap = /^\/tap(?:\s+(\S+)\s+(\S+))?$/i.exec(text);
  if (tap) {
    // "/tap" or "/tap 0.3 0.6" (screen position, 0..1 from the top left): works offline too.
    const at = tap[1] ? { x: Number(tap[1]), y: Number(tap[2]) } : null;
    if (at && ![at.x, at.y].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) hud.status.textContent = 'Usage: /tap, or /tap x y with x and y between 0 and 1';
    else if (!avatarTap(at, (ok, reason) => !ok && (hud.status.textContent = `Didn't tap: ${reason}`))) hud.status.textContent = "Can't tap while walking";
    return;
  }
  if (net.state === 'open') {
    net.send('user_text', { text });
    return;
  }
  const m = /^\/?(?:go|walk) to (.+)$/i.exec(text);
  const loc = m && manifest.locations.find((l) => l.name === m[1] || l.label.toLowerCase() === m[1].toLowerCase());
  if (loc) walk({ cmd_id: `local_${++localCmds}`, target: { location: loc.name } });
  else hud.status.textContent = 'Offline: only "go to <place>" works without the server';
}

function buildDebugPanel(): void {
  document.body.classList.toggle('compact', device.coarsePointer && !cfg.debug);
  const panel = $('locations');
  for (const loc of manifest.locations) {
    const b = document.createElement('button');
    b.textContent = loc.label;
    b.onclick = () => command(`/go to ${loc.name}`);
    panel.appendChild(b);
  }
  const form = $('say') as HTMLFormElement;
  const input = form.querySelector('input')!;
  form.onsubmit = (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (text) command(text);
    input.value = '';
  };
  buildTalkButton();
  const navBtn = $('toggle-nav') as HTMLButtonElement;
  navBtn.onclick = () => {
    const mesh = scene.getObjectByName('navmesh-debug');
    if (mesh) mesh.visible = !mesh.visible;
    markers.visible = !markers.visible;
    pathLine.visible = markers.visible;
  };
}

function buildTalkButton(): void {
  const btn = $('talk') as HTMLButtonElement;
  const label = btn.querySelector('span')!;
  const modeBtn = $('mode') as HTMLButtonElement;
  const micError = (e: unknown) => (hud.status.textContent = `Microphone: ${e instanceof Error ? e.message : String(e)}`);
  ptt.onState = (st) => {
    if (micMode !== 'ptt') return;
    btn.dataset.state = st;
    label.textContent = { idle: 'Hold to talk', opening: 'Allow the microphone…', talking: 'Listening… release to send', sending: 'Sending…' }[st];
    if (st === 'talking') hud.you.textContent = '…';
  };
  ptt.onError = micError;
  openMic.onError = micError;
  openMic.onState = (st) => {
    if (micMode !== 'open') return;
    btn.dataset.state = { off: muted ? 'muted' : 'idle', opening: 'opening', listening: 'listening', maybe: 'listening', speaking: 'talking' }[st];
    label.textContent = muted ? 'Muted: tap to listen' : { off: 'Tap to listen', opening: 'Allow the microphone…', listening: 'Listening: just talk', maybe: 'Listening: just talk', speaking: 'Hearing you…' }[st];
    if (st === 'speaking') hud.you.textContent = '…';
    if (st === 'listening' && openMic.detector !== 'silero') hud.status.textContent = `Voice detection: ${openMic.detector}`;
  };
  openMic.onProb = (p) => btn.style.setProperty('--voice', p.toFixed(2));
  const showMode = () => {
    modeBtn.textContent = micMode === 'open' ? 'Hands-free: on' : 'Hands-free: off';
    modeBtn.setAttribute('aria-pressed', String(micMode === 'open'));
    if (micMode === 'open') openMic.onState(openMic.state);
    else ptt.onState(ptt.state);
  };
  modeBtn.onclick = async () => {
    micMode = micMode === 'open' ? 'ptt' : 'open';
    try {
      localStorage.setItem(MODE_KEY, micMode);
    } catch {
      // not remembered: fine
    }
    if (micMode === 'ptt') await openMic.stop();
    else {
      ptt.cancel();
      muted = false;
      void openMic.start(); // a click: the permission prompt may show
    }
    showMode();
  };
  showMode();
  // Hold to talk; in hands-free mode a tap mutes or unmutes the open mic.
  btn.addEventListener('pointerdown', (e) => {
    if (micMode === 'open') {
      muted = openMic.state !== 'off';
      void (muted ? openMic.stop() : openMic.start()).then(showMode);
      return;
    }
    btn.setPointerCapture(e.pointerId);
    void ptt.down();
  });
  for (const ev of ['pointerup', 'pointercancel', 'lostpointercapture']) btn.addEventListener(ev, () => micMode === 'ptt' && void ptt.up());
  btn.addEventListener('contextmenu', (e) => e.preventDefault()); // long press on phones
  // Desktop: hold the space bar, unless typing in the text box.
  addEventListener('keydown', (e) => {
    if (micMode === 'ptt' && e.code === 'Space' && !e.repeat && document.activeElement?.tagName !== 'INPUT' && started) {
      e.preventDefault();
      void ptt.down();
    }
  });
  addEventListener('keyup', (e) => micMode === 'ptt' && e.code === 'Space' && void ptt.up());
}

// ---------------------------------------------------------------- start
async function start(): Promise<void> {
  applyQuality(quality.current);
  addEventListener('resize', resize);
  buildDebugPanel();
  started = true;

  const results = await Promise.allSettled([
    avatar.load(`${base}${cfg.model ? `avatars/${cfg.model}.vrm` : manifest.avatar.url}`),
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
  anim.play('idle');
  anim.update(0);
  frame();
  wireTouches();
  if (cfg.debug) Object.assign(window, { kamari: { scene, camera, controls, avatar, glass } }); // poke at it from the console
  avatar.lookAt(camera.position);

  hud.conn.textContent = net.state; // the tap may have connected while assets were loading
  net.onState((s) => (hud.conn.textContent = s));
  net.on('walk_to', (m) => walk(m.data));
  net.on('stop_moving', (m) => {
    cancelPendingTap('stopped');
    tapper.cancel();
    const stopped = loco.stop();
    if (stopped?.cmdId) net.send('command_cancelled', { cmd_id: stopped.cmdId, reason: 'stopped' }); // turns on the spot have no id
    net.send('ack', { cmd_id: m.data.cmd_id });
  });
  net.on('speech_start', (m) => speech.onStart(m));
  net.on('speech_chunk', (m) => {
    speech.onChunk(m);
    if (m.data.text && m.data.seq === 0) hud.kamari.textContent = m.data.text;
    else if (m.data.text && !hud.kamari.textContent?.endsWith(m.data.text)) hud.kamari.textContent += ` ${m.data.text}`;
  });
  net.on('gesture', (m) => gesture(m.data));
  net.on('look_at', (m) => lookAt(m.data));
  net.on('transcript', (m) => (hud.you.textContent = m.data.text || '(nothing heard)'));
  net.on('turn_timing', (m) => {
    const ms = m.data.first_audio_ms ?? m.data.tts_first_audio_ms;
    if (ms !== undefined) hud.latency.textContent = `${(ms / 1000).toFixed(2)} s`;
  });
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
  lifecycle.onHidden(() => {
    ptt.cancel();
    openMic.cancel();
    net.send('visibility', { state: 'hidden' });
  });
  lifecycle.onVisible(() => {
    if (net instanceof WebSocketProtocolClient) net.wake();
    net.send('visibility', { state: 'visible' });
    if (micMode === 'open' && !muted) void openMic.start();
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
  if (micMode === 'open') void openMic.start(); // inside the tap: the mic permission prompt needs one
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
  if (loco.moving) {
    // A walk took over: drop a tap still waiting for the turn, and pull back a finger on the glass.
    cancelPendingTap('walking');
    tapper.cancel();
  } else tryPendingTap();
  speech.update();
  anim.play(loco.moving ? (loco.cmd?.speed === 'run' ? 'run' : 'walk') : speech.talking ? 'talk' : 'idle', { fadeS: 0.3 });
  if (!loco.moving) anim.setTimeScale(1);
  anim.update(step);
  gestures.update(step);
  tapper.update(step);
  touchFx.update(step);
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
