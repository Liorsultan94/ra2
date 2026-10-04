import * as THREE from 'three';
import { WEAPONS, buildingDef, unitDef } from '../../sim/defs';
import { standHeight } from '../../sim/map';
import { SNIPER_STEADY, aimWeapon } from '../../sim/sniper';
import type { Entity, SimEvent } from '../../sim/types';
import type { World } from '../../sim/world';
import type { Effects } from '../effects';

/*
 * Sniper laser designator (render only, not deterministic; the sim lock-on lives in sim/sniper.ts).
 *
 * While a sniper holds its aim (Entity.aimTarget / aimTicks) a thin laser beam runs from the rifle
 * muzzle (or a window of the building it garrisons) to a bright dot on the target. The dot is held
 * by a human hand: a slow figure-8 drift plus a fine tremor, both shrinking as the aim settles, and
 * dead steady for the final SNIPER_STEADY ticks. GREEN by day, RED at dusk and night (live day clock).
 * Beam and dot are additive with a soft glow and a minimum on-screen width, so they read on a phone
 * while staying thin. The shot: crisp flash, a faint tracer, a dust kick at the muzzle, a puff on the
 * target. The target does not react (visual only).
 */

export interface SniperFxHost {
  world: World;
  scene: THREE.Scene;
  effects: Effects;
  camera: THREE.Camera;
  /** Viewport height in CSS px (for the minimum on-screen width). */
  viewHeight(): number;
  /** Live clock hour (0..24, fractional) from the atmosphere. */
  hour(): number;
  /** World position of the sniper's rifle muzzle (its visual), or null when it has no visible model. */
  muzzle(e: Entity): THREE.Vector3 | null;
  /** Interpolated world position of an entity (x, height, y). */
  entityPos(e: Entity, alpha: number): THREE.Vector3;
  visibleAt(x: number, y: number): boolean;
  /** The sniper's model should play its shot (recoil, bolt). */
  markFired(e: Entity): void;
}

/** Extra muzzle height range for garrisons in tall city buildings (matches fx/superfx.ts). */
const CITY_TALL: Record<string, number> = { civ_apartment: 1.4, civ_office: 1.9, civ_block: 1.1, civ_townhouse: 0.55, civ_shop: 0.3 };

const RED = new THREE.Color(0xff2414);
const GREEN = new THREE.Color(0x33ff4a);
const WHITE = new THREE.Color(1, 1, 1);

/** Hand sway: figure-8 drift amplitude (tiles) at the start of the aim, its period (s), tremor amplitude. */
export const SWAY_AMP = 0.3;
export const SWAY_PERIOD = 2.3;
export const TREMOR_AMP = 0.035;

/** Deterministic hash of an integer to [0, 1). */
function hash(n: number) {
  const h = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return h - Math.floor(h);
}

/**
 * Hand sway offset of the laser dot (lateral, vertical) in tiles, `k` = aim progress 0..1, `t` seconds,
 * `seed` per sniper. Exported for tests: zero once the final steady phase starts.
 */
export function swayOffset(k: number, t: number, seed: number, steadyFrom: number): [number, number] {
  if (k >= steadyFrom) return [0, 0];
  const settle = 1 - k / steadyFrom; // 1 at the start of the aim .. 0 at the lock
  const amp = SWAY_AMP * Math.pow(settle, 1.25) + 0.02 * settle;
  const u = (t / SWAY_PERIOD) * Math.PI * 2 + seed * 6.283;
  // figure 8 (Lissajous 1:2), slowly breathing
  let x = Math.sin(u) * amp;
  let y = Math.sin(2 * u) * 0.5 * amp * (0.8 + 0.2 * Math.sin(u * 0.37));
  // tremor: a few incommensurate fast sines, fading as the aim settles
  const tr = TREMOR_AMP * (0.25 + 0.75 * settle) * settle;
  x += (Math.sin(t * 21.7 + seed * 40) * 0.6 + Math.sin(t * 33.1 + seed * 13) * 0.4) * tr;
  y += (Math.sin(t * 26.3 + seed * 27) * 0.6 + Math.sin(t * 39.7 + seed * 7) * 0.4) * tr;
  return [x, y];
}

/** Laser colour of the hour: green by day (06:30 .. 18:00), red at dusk, night and dawn. */
export function laserIsGreen(hour: number): boolean {
  const h = ((hour % 24) + 24) % 24;
  return h >= 6.5 && h < 18;
}

const BEAM_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BEAM_FS = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
uniform float uTime;
uniform float uLen;
varying vec2 vUv;
void main() {
  float v = abs(vUv.y - 0.5) * 2.0; // 0 centre .. 1 edge
  float core = 1.0 - smoothstep(0.0, 0.18, v);
  float glow = exp(-v * 3.5) * 0.6;
  // dust in the beam: faint travelling sparkle; ends fade in / out
  float motes = 0.82 + 0.18 * sin(vUv.x * uLen * 37.0 - uTime * 7.0) * sin(vUv.x * uLen * 11.0 + uTime * 3.0);
  float ends = smoothstep(0.0, 0.03, vUv.x) * (0.55 + 0.45 * smoothstep(1.0, 0.85, vUv.x));
  vec3 c = mix(uColor, vec3(1.0), core * 0.22) * (1.0 + core * 0.8);
  float a = (core + glow) * motes * ends * uOpacity;
  gl_FragColor = vec4(c * a, a);
}`;

function dotTexture(): THREE.Texture {
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.12, 'rgba(255,255,255,0.95)');
  gr.addColorStop(0.3, 'rgba(255,255,255,0.35)');
  gr.addColorStop(0.6, 'rgba(255,255,255,0.08)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface Laser {
  id: number;
  beam: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  dot: THREE.Sprite;
  dotMat: THREE.SpriteMaterial;
  halo: THREE.Sprite;
  haloMat: THREE.SpriteMaterial;
  a: THREE.Vector3;
  b: THREE.Vector3;
  fade: number; // 1 while aiming, falls to 0 after the aim ends
  live: boolean;
  seed: number;
}

export class SniperFx {
  readonly group = new THREE.Group();
  private lasers = new Map<number, Laser>();
  private quad = new THREE.PlaneGeometry(1, 1).translate(0.5, 0, 0);
  private tex: THREE.Texture | null = null;
  private color = new THREE.Color();
  private time = 0;
  private tmp = new THREE.Vector3();
  private side = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private nrm = new THREE.Vector3();
  private m4 = new THREE.Matrix4();

  constructor(private host: SniperFxHost) {
    this.group.name = 'sniperfx';
    this.group.renderOrder = 6;
    host.scene.add(this.group);
  }

  /** Sniper shots: returns true when handled (the renderer skips its default tracer / window fire). */
  onEvent(ev: SimEvent): boolean {
    if (ev.t !== 'fire') return false;
    const wpn = WEAPONS[ev.weapon];
    if (!wpn || !wpn.aim) return false;
    const w = this.host.world;
    const src = w.get(ev.id);
    if (!src) return true;
    if (!this.host.visibleAt(ev.x, ev.y) && !this.host.visibleAt(ev.tx, ev.ty)) return true;
    const t = w.get(ev.targetId);
    const tp = t ? this.aimPoint(t, 1) : new THREE.Vector3(ev.tx, standHeight(w.map, ev.tx, ev.ty) + 0.2, ev.ty);
    const a = this.startPoint(src, tp);
    if (!a) return true;
    this.host.markFired(src);
    const fx = this.host.effects;
    const dir = this.tmp.copy(tp).sub(a);
    dir.y = 0;
    dir.normalize();
    // crisp flash (white-hot, small), a faint tracer, dust kicked up by the muzzle blast
    fx.muzzle(a, dir, 0.55, 0xfff4d8);
    fx.flashLight(a.x, a.y, a.z, 2.2, 0xfff0d0, 0.06);
    fx.beam(a, tp, 0xfff2d8, 0.01, 0.1);
    fx.beam(a, tp, 0xffd9a0, 0.028, 0.06);
    if (src.inside < 0) fx.dust(a.x + dir.x * 0.25, standHeight(w.map, a.x, a.z), a.z + dir.z * 0.25, 0.55);
    // the hit: a puff on the target (sparks off armour)
    const armoured = t && t.kind === 'unit' && unitDef(t.def).category !== 'infantry';
    fx.after(0.03, () => {
      fx.dust(tp.x, tp.y - 0.12, tp.z, armoured ? 0.4 : 0.6);
      if (armoured) fx.spark(tp.x, tp.y, tp.z, 0xffd08a);
      else fx.spark(tp.x, tp.y, tp.z, 0xcfc4b0);
    });
    // the laser winks out with the shot
    const l = this.lasers.get(src.id);
    if (l) l.fade = Math.min(l.fade, 0.6);
    return true;
  }

  /** Per frame: one laser per aiming sniper (alpha = sim interpolation). */
  update(dt: number, alpha: number) {
    this.time += dt;
    const h = this.host;
    const w = h.world;
    const green = laserIsGreen(h.hour());
    this.color.copy(green ? GREEN : RED);
    for (const l of this.lasers.values()) l.live = false;
    for (const e of w.list) {
      if (e.dead || e.aimTarget < 0 || e.kind !== 'unit') continue;
      const wpn = aimWeapon(e);
      const t = w.get(e.aimTarget);
      if (!wpn || !wpn.aim || !t) continue;
      const seen = e.inside >= 0 ? h.visibleAt(e.x, e.y) || h.visibleAt(t.x, t.y) : h.visibleAt(e.x, e.y);
      if (!seen) continue;
      const tp = this.aimPoint(t, alpha);
      const a = this.startPoint(e, tp);
      if (!a) continue;
      let l = this.lasers.get(e.id);
      if (!l) {
        l = this.make(e.id);
        this.lasers.set(e.id, l);
      }
      l.live = true;
      l.fade = Math.min(1, l.fade + dt * 10);
      const k = Math.min(1, (e.aimTicks + alpha) / wpn.aim);
      const steadyFrom = 1 - SNIPER_STEADY / wpn.aim;
      const [sx, sy] = swayOffset(k, this.time, l.seed, steadyFrom);
      // sway in the plane across the beam: sideways and up / down
      this.fwd.copy(tp).sub(a);
      this.fwd.y = 0;
      if (this.fwd.lengthSq() < 1e-6) this.fwd.set(1, 0, 0);
      this.fwd.normalize();
      const size = t.kind === 'unit' && unitDef(t.def).category !== 'infantry' ? 1.5 : 1;
      tp.x += -this.fwd.z * sx * size;
      tp.z += this.fwd.x * sx * size;
      tp.y = Math.max(standHeight(w.map, tp.x, tp.z) + 0.03, tp.y + sy * size * 0.8);
      l.a.copy(a);
      l.b.copy(tp);
      const locked = k >= steadyFrom;
      this.place(l, locked ? 1 : 0.8 + 0.2 * k);
    }
    for (const [id, l] of this.lasers) {
      if (l.live) continue;
      l.fade -= dt * 6;
      if (l.fade <= 0) {
        this.group.remove(l.beam, l.dot, l.halo);
        l.mat.dispose();
        l.dotMat.dispose();
        l.haloMat.dispose();
        this.lasers.delete(id);
      } else this.place(l, 1);
    }
  }

  /** Where the laser sits on a target (chest of a soldier, the hull of a vehicle). */
  private aimPoint(t: Entity, alpha: number): THREE.Vector3 {
    const p = this.host.entityPos(t, alpha);
    if (t.kind === 'building') p.y += 0.4;
    else p.y += unitDef(t.def).category === 'infantry' ? 0.2 : 0.26;
    return p;
  }

  /** Rifle muzzle, or the window of the garrisoned building that faces the target. */
  private startPoint(e: Entity, tp: THREE.Vector3): THREE.Vector3 | null {
    const w = this.host.world;
    if (e.inside >= 0) {
      const house = w.get(e.inside);
      if (!house || house.kind !== 'building' || !buildingDef(house.def).garrison) return null;
      const d = buildingDef(house.def);
      const dx = tp.x - house.x;
      const dy = tp.z - house.y;
      const l = Math.hypot(dx, dy) || 1;
      const nx = dx / l;
      const ny = dy / l;
      const k = Math.min(d.w / 2 / Math.max(1e-3, Math.abs(nx)), d.h / 2 / Math.max(1e-3, Math.abs(ny))) * 0.9;
      const side = (hash(e.id) - 0.5) * 0.6;
      const g = standHeight(w.map, house.x, house.y);
      const tall = CITY_TALL[house.def] ?? 0;
      return new THREE.Vector3(house.x + nx * k - ny * side, g + 0.34 + (tall ? hash(e.id + 7) * tall : hash(e.id + 7) < 0.4 ? 0.25 : 0), house.y + ny * k + nx * side);
    }
    return this.host.muzzle(e);
  }

  private make(id: number): Laser {
    if (!this.tex) this.tex = dotTexture();
    const mat = new THREE.ShaderMaterial({
      vertexShader: BEAM_VS,
      fragmentShader: BEAM_FS,
      uniforms: { uColor: { value: new THREE.Color() }, uOpacity: { value: 0 }, uTime: { value: 0 }, uLen: { value: 1 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
    const beam = new THREE.Mesh(this.quad, mat);
    beam.matrixAutoUpdate = false;
    beam.frustumCulled = false;
    beam.renderOrder = 6;
    const dotMat = new THREE.SpriteMaterial({ map: this.tex, color: 0xffffff, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const dot = new THREE.Sprite(dotMat);
    dot.renderOrder = 7;
    const haloMat = new THREE.SpriteMaterial({ map: this.tex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
    const halo = new THREE.Sprite(haloMat);
    halo.renderOrder = 6;
    this.group.add(beam, halo, dot);
    return { id, beam, mat, dot, dotMat, halo, haloMat, a: new THREE.Vector3(), b: new THREE.Vector3(), fade: 0, live: true, seed: hash(id * 3 + 1) };
  }

  /** World size of one CSS pixel at p (perspective camera); orthographic: a fixed guess. */
  private pxAt(p: THREE.Vector3): number {
    const cam = this.host.camera as THREE.PerspectiveCamera;
    const vh = Math.max(200, this.host.viewHeight());
    if (cam.isPerspectiveCamera) {
      const d = cam.position.distanceTo(p);
      return (2 * d * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)) / vh;
    }
    const oc = this.host.camera as THREE.OrthographicCamera;
    return (oc.top - oc.bottom) / oc.zoom / vh;
  }

  private place(l: Laser, bright: number) {
    const cam = this.host.camera;
    const a = l.a;
    const b = l.b;
    const len = a.distanceTo(b);
    if (len < 1e-3) return;
    this.fwd.copy(b).sub(a).divideScalar(len);
    // billboard the quad round its own axis towards the camera
    const mid = this.tmp.copy(a).add(b).multiplyScalar(0.5);
    const view = this.nrm.copy(cam.position).sub(mid).normalize();
    this.side.crossVectors(this.fwd, view);
    if (this.side.lengthSq() < 1e-8) this.side.set(0, 1, 0);
    this.side.normalize();
    const px = this.pxAt(mid);
    const width = Math.max(0.05, px * 6); // thin, but never under ~6 px of glow (core ~1 px)
    this.nrm.crossVectors(this.fwd, this.side).normalize();
    this.m4.makeBasis(this.fwd.clone().multiplyScalar(len), this.side.clone().multiplyScalar(width), this.nrm);
    this.m4.setPosition(a);
    l.beam.matrix.copy(this.m4);
    l.beam.matrixWorldNeedsUpdate = true;
    const u = l.mat.uniforms;
    (u.uColor.value as THREE.Color).copy(this.color);
    u.uOpacity.value = 0.85 * l.fade;
    u.uTime.value = this.time;
    u.uLen.value = len;
    // the dot: a hot core and a soft halo, a constant few pixels whatever the zoom
    const pd = this.pxAt(b);
    const flick = 0.92 + 0.08 * Math.sin(this.time * 37 + l.seed * 20);
    const ds = Math.max(0.09, pd * 13) * (0.85 + 0.15 * bright);
    l.dot.position.copy(b);
    l.dot.scale.set(ds, ds, 1);
    l.dotMat.color.copy(this.color).lerp(WHITE, 0.45).multiplyScalar(2.2 * l.fade * flick * bright);
    l.halo.position.copy(b);
    const hs = Math.max(0.24, pd * 34);
    l.halo.scale.set(hs, hs, 1);
    l.haloMat.color.copy(this.color).multiplyScalar(0.9 * l.fade * bright);
  }

  dispose() {
    for (const l of this.lasers.values()) {
      l.mat.dispose();
      l.dotMat.dispose();
      l.haloMat.dispose();
    }
    this.lasers.clear();
    this.quad.dispose();
    this.tex?.dispose();
    this.host.scene.remove(this.group);
  }
}
