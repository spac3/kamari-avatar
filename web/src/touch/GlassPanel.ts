import * as THREE from 'three';
import type { GlassUi, PanelPress, TouchSource } from '../interfaces';
import type { PanelControl } from '../room/manifest';

export interface GlassPanelOptions {
  /** Panel size on the glass, metres. Small enough for the avatar to reach every control. */
  width?: number;
  height?: number;
  /** Seconds to fade fully in or out. */
  fadeS?: number;
  /** Highest opacity: translucent, so the avatar stays visible behind it. */
  opacity?: number;
}

/** One round touch pad: centre and radius in the panel's own metres. */
interface Slot { control: PanelControl; center: THREE.Vector2; r: number; glow: THREE.Mesh; flash: number }

const PX_PER_M = 2400;
const FLASH_S = 0.35;
const SOURCE_COLOR: Record<TouchSource, string> = { user: '#2bb3c0', avatar: '#63d13e' };

/**
 * A translucent row of round touch pads drawn on the glass, readable from both sides: the person presses
 * it with a pointer, the avatar with a fingertip. The page places it on the glass every frame and
 * says when it should show; it fades in and out, and only takes touches while mostly shown.
 */
export class GlassPanel implements GlassUi {
  readonly object = new THREE.Group();
  private readonly o: Required<GlassPanelOptions>;
  private readonly slots: Slot[] = [];
  private readonly material: THREE.MeshBasicMaterial;
  private readonly canvas: HTMLCanvasElement | null;
  private readonly texture: THREE.CanvasTexture | null;
  private readonly lastSource = new Map<string, TouchSource>();
  private alpha = 0;
  private wanted = false;

  constructor(controls: PanelControl[], opts: GlassPanelOptions = {}) {
    this.o = { width: 0.34, height: 0.1, fadeS: 0.35, opacity: 0.85, ...opts };
    this.object.name = 'glass-panel';
    this.object.renderOrder = 9; // over the room, under the ripples
    this.object.visible = false;
    const { width: w, height: h } = this.o;

    // No canvas outside a browser (tests): the controls still work, they just have no face.
    this.canvas = typeof document === 'undefined' ? null : document.createElement('canvas');
    if (this.canvas) {
      this.canvas.width = Math.round(w * PX_PER_M);
      this.canvas.height = Math.round(h * PX_PER_M);
    }
    this.texture = this.canvas ? new THREE.CanvasTexture(this.canvas) : null;
    if (this.texture) this.texture.colorSpace = THREE.SRGBColorSpace;
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, color: this.texture ? 0xffffff : 0xbfe9ee, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), this.material);
    face.renderOrder = 9;
    this.object.add(face);

    // Round pads in one row, evenly spaced, in the panel's own metres (origin at its centre).
    const n = Math.max(1, controls.length);
    const r = Math.min(h * 0.46, (w / n) * 0.42);
    controls.forEach((c, i) => {
      const center = new THREE.Vector2(-w / 2 + (w / n) * (i + 0.5), 0);
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(r, 40),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthTest: false, depthWrite: false, side: THREE.DoubleSide }),
      );
      glow.position.set(center.x, center.y, 0.001);
      glow.renderOrder = 9;
      this.object.add(glow);
      this.slots.push({ control: { kind: 'button', ...c, on: c.kind === 'toggle' ? (c.on ?? false) : undefined }, center, r, glow, flash: 0 });
    });
    this.draw();
  }

  get controls(): PanelControl[] {
    return this.slots.map((s) => ({ ...s.control }));
  }

  get shown(): number {
    return this.alpha;
  }

  /** Shown enough to read and press. */
  get touchable(): boolean {
    return this.wanted && this.alpha > 0.5;
  }

  place(center: THREE.Vector3, facing: THREE.Quaternion): void {
    this.object.position.copy(center);
    this.object.quaternion.copy(facing);
    this.object.updateMatrixWorld(true);
  }

  show(on: boolean): void {
    this.wanted = on;
  }

  controlAt(point: THREE.Vector3): PanelControl | null {
    if (!this.touchable) return null;
    const p = this.object.worldToLocal(point.clone());
    const slot = this.slots.find((s) => Math.hypot(p.x - s.center.x, p.y - s.center.y) <= s.r);
    return slot ? { ...slot.control } : null;
  }

  pointOf(id: string): THREE.Vector3 | null {
    const s = this.slots.find((x) => x.control.id === id);
    if (!s) return null;
    return this.object.localToWorld(new THREE.Vector3(s.center.x, s.center.y, 0));
  }

  press(id: string, source: TouchSource): PanelPress | null {
    const s = this.slots.find((x) => x.control.id === id);
    if (!s || !this.touchable) return null;
    if (s.control.kind === 'toggle') s.control.on = !s.control.on;
    s.flash = FLASH_S;
    (s.glow.material as THREE.MeshBasicMaterial).color.set(SOURCE_COLOR[source]);
    this.lastSource.set(id, source);
    this.draw();
    return { control: { ...s.control }, source };
  }

  update(dt: number): void {
    const step = dt / this.o.fadeS;
    this.alpha = this.wanted ? Math.min(1, this.alpha + step) : Math.max(0, this.alpha - step);
    const a = this.alpha * this.alpha * (3 - 2 * this.alpha);
    this.object.visible = this.alpha > 0;
    this.material.opacity = a * this.o.opacity;
    for (const s of this.slots) {
      s.flash = Math.max(0, s.flash - dt);
      (s.glow.material as THREE.MeshBasicMaterial).opacity = a * 0.55 * (s.flash / FLASH_S);
    }
  }

  /** Paint the panel face: a frosted circle per control with its label; a toggle that is on glows green. */
  private draw(): void {
    const cv = this.canvas;
    const g = cv?.getContext('2d');
    if (!cv || !g) return;
    const k = PX_PER_M;
    g.clearRect(0, 0, cv.width, cv.height);
    for (const s of this.slots) {
      const x = (s.center.x + this.o.width / 2) * k;
      const y = (this.o.height / 2 - s.center.y) * k;
      const r = s.r * k - 3;
      const on = s.control.kind === 'toggle' && s.control.on;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = on ? 'rgba(99, 209, 62, 0.42)' : 'rgba(214, 240, 244, 0.42)';
      g.fill();
      g.lineWidth = 4;
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      g.stroke();
      g.fillStyle = '#17323a';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.font = `600 ${Math.round(r * 0.42)}px system-ui, sans-serif`;
      if (s.control.kind === 'toggle') {
        g.fillText(s.control.label, x, y - r * 0.16, r * 1.7);
        g.font = `500 ${Math.round(r * 0.3)}px system-ui, sans-serif`;
        g.fillText(s.control.on ? 'on' : 'off', x, y + r * 0.3, r * 1.7);
      } else g.fillText(s.control.label, x, y, r * 1.7);
    }
    if (this.texture) this.texture.needsUpdate = true;
  }
}
