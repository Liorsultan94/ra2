import * as THREE from 'three';
import { DEFS, FACTION_INFO, unitDef } from '../sim/defs';
import type { Entity } from '../sim/types';
import type { CameoFactory } from '../render/cameo';
import { createModel, type AnimState, type Model, type ModelStyle } from '../render/models';
import './portrait3d.css';

/*
 * Live 3D portrait for the selection panel.
 *
 * The selected unit / building turns slowly on a dark studio backdrop (the
 * backdrop itself is the portrait's CSS gradient) under a key light, a
 * faction-coloured rim light and a tinted hemisphere fill. The model's own
 * animation runs with the entity's damage (wear.ts soot / battered plates),
 * turrets sweep gently and rotors spin.
 *
 * Cost: the frame is rendered at ~15 fps into the CameoFactory's small
 * offscreen canvas (same GL context as the sidebar cameos, so no extra
 * context and the shader programs are already compiled) and blitted into a
 * 2D canvas inside the portrait. Nothing runs while nothing is selected, the
 * portrait is hidden (More panel, photo mode, background tab) or on 'low'
 * quality, where the static cameo stays.
 */

const FPS = 15;
const MAX_PX = 256;
const CACHE = 4;

interface Entry {
  key: string;
  model: Model;
  center: THREE.Vector3;
  /** Radius of the turntable sweep (horizontal) and half height, for framing. */
  rh: number;
  hy: number;
  floorY: number;
  air: boolean;
}

export class LivePortrait {
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(26, 4 / 3, 0.05, 200);
  private readonly pivot = new THREE.Group();
  private readonly hemi = new THREE.HemisphereLight(0xa4b6d0, 0x202830, 1.25);
  private readonly key = new THREE.DirectionalLight(0xfff0dc, 3.0);
  private readonly rim = new THREE.DirectionalLight(0x4aa0ff, 3.2);
  private readonly floor: THREE.Mesh;
  private readonly cache = new Map<string, Entry>();
  private cur: Entry | null = null;
  private host: HTMLElement | null = null;
  private getEntity: (() => Entity | undefined) | null = null;
  private raf = 0;
  private last = 0;
  private time = 0;
  private dist = 0;
  private angle = 0.65;
  private drawn = false;
  private disposed = false;
  private anim: AnimState = { dt: 0, time: 0, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true };

  constructor(
    private readonly cameos: CameoFactory,
    readonly enabled: boolean,
  ) {
    this.canvas.className = 'pt-live';
    this.ctx = this.canvas.getContext('2d');
    // same light rig layout as the cameo scene (1 hemisphere + 2 directional): the programs are shared
    this.key.position.set(-3, 5, 4.5);
    this.rim.position.set(3.5, 2.2, -5);
    this.scene.add(this.hemi, this.key, this.rim, this.pivot);
    // soft studio floor spot under the model
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    if (g) {
      const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      gr.addColorStop(0, 'rgba(255,255,255,0.55)');
      gr.addColorStop(0.45, 'rgba(255,255,255,0.18)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.fillRect(0, 0, 64, 64);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, color: 0x6d8296 }));
    this.floor.renderOrder = -1;
    this.scene.add(this.floor);
  }

  /**
   * Show the live portrait inside `host` (the `.portrait` box or a multi-select
   * type button) for the entity returned by `get`; host null hides it.
   */
  attach(host: HTMLElement | null, get: (() => Entity | undefined) | null, style: ModelStyle | null) {
    if (!this.enabled || this.disposed || !this.cameos.available) return;
    const e = get?.();
    if (!host || !e || !style) {
      this.detach();
      return;
    }
    this.getEntity = get;
    const d = DEFS[e.def];
    const key = `${d.model}:${style.team}:${style.faction}`;
    if (this.cur?.key !== key) {
      this.cur = this.entry(key, d.model, style, d.kind === 'unit' && !!unitDef(e.def).air);
      this.angle = 0.65;
      this.dist = 0;
      this.drawn = false;
      this.setAccent(style);
    }
    if (this.host !== host || this.canvas.parentElement !== host) {
      this.host = host;
      host.insertBefore(this.canvas, host.firstChild);
    }
    host.classList.toggle('live', this.drawn);
    if (!this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.loop);
    }
  }

  detach() {
    this.host?.classList.remove('live');
    this.canvas.remove();
    this.host = null;
    this.getEntity = null;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private setAccent(style: ModelStyle) {
    const f = style.faction !== 'neutral' ? FACTION_INFO[style.faction] : null;
    const accent = new THREE.Color(f ? f.accent : 0xffd9a0);
    // keep the rim saturated but bright enough to read on any accent colour
    const hsl = { h: 0, s: 0, l: 0 };
    accent.getHSL(hsl);
    this.rim.color.setHSL(hsl.h, Math.min(1, hsl.s * 1.1), Math.max(0.55, hsl.l));
    this.hemi.groundColor.copy(accent).multiplyScalar(0.28);
    (this.floor.material as THREE.MeshBasicMaterial).color.copy(accent).lerp(new THREE.Color(0x8aa0b4), 0.6);
  }

  private entry(key: string, modelKey: string, style: ModelStyle, air: boolean): Entry {
    const hit = this.cache.get(key);
    if (hit) {
      // LRU refresh
      this.cache.delete(key);
      this.cache.set(key, hit);
      this.show(hit);
      return hit;
    }
    const model = createModel(modelKey, style, null);
    // settle the pose once before measuring (buildings fully built, gear down)
    model.anim?.({ ...this.anim, dt: 0 });
    const box = new THREE.Box3().setFromObject(model.root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    // skinned meshes (infantry) report their bind-space box: trust the model's own height then
    if (!air && model.height > size.y * 1.4) {
      size.set(Math.max(size.x, model.height * 0.55), model.height, Math.max(size.z, model.height * 0.4));
      center.set(0, model.height / 2, 0);
      box.min.y = 0;
    }
    const e: Entry = { key, model, center, rh: 0.5 * Math.hypot(size.x, size.z), hy: size.y * 0.5, floorY: air ? box.min.y - size.y * 0.35 : box.min.y + 0.005, air };
    this.cache.set(key, e);
    while (this.cache.size > CACHE) {
      const [k, old] = this.cache.entries().next().value as [string, Entry];
      this.cache.delete(k);
      // templates (geometry / materials) are shared with the battlefield: only drop the instance
      old.model.root.removeFromParent();
    }
    this.show(e);
    return e;
  }

  private show(e: Entry) {
    this.pivot.clear();
    this.pivot.add(e.model.root);
    e.model.root.position.set(-e.center.x, 0, -e.center.z);
    this.floor.position.set(0, e.floorY, 0);
    const s = Math.max(0.6, e.rh * 2.3);
    this.floor.scale.set(s, 1, s);
  }

  private loop = (now: number) => {
    this.raf = requestAnimationFrame(this.loop);
    if (this.last && now - this.last < 1000 / FPS - 2) return;
    const dt = this.last ? Math.min(0.2, (now - this.last) / 1000) : 0;
    this.last = now;
    const host = this.host;
    const cur = this.cur;
    if (!host || !cur || !this.ctx || document.hidden) return;
    // hidden (More panel open, photo mode, HUD collapsed): skip the work
    const cw = host.clientWidth;
    const ch = host.clientHeight;
    if (!cw || !ch) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    let w = Math.round(cw * dpr);
    let h = Math.round(ch * dpr);
    const k = Math.min(1, MAX_PX / Math.max(w, h));
    w = Math.max(16, Math.round(w * k));
    h = Math.max(16, Math.round(h * k));
    this.time += dt;
    this.angle += dt * 0.42;
    this.pivot.rotation.y = this.angle;
    const e = this.getEntity?.();
    const a = this.anim;
    a.dt = dt;
    a.time = this.time;
    if (e) {
      a.damage = Math.max(0, Math.min(1, 1 - e.hp / Math.max(1, e.maxHp)));
      a.powered = true;
      a.built = 1;
    }
    a.dist += dt * 0.05;
    const m = cur.model;
    if (m.turret) m.turret.rotation.y = Math.sin(this.time * 0.55) * 0.5;
    for (const r of m.rotors ?? []) r.rotation.y += dt * 30;
    for (const sp of m.spinners ?? []) sp.obj.rotation[sp.axis] += sp.speed * dt;
    m.anim?.(a);
    // gentle hover bob for aircraft
    m.root.position.y = cur.air ? Math.sin(this.time * 1.3) * cur.hy * 0.06 : 0;
    // framing: the whole turntable sweep fits the view
    const cam = this.camera;
    cam.aspect = w / h;
    const elev = THREE.MathUtils.degToRad(cur.air ? 16 : 22);
    // horizontal: the sweep radius; vertical: the sweep ellipse seen from above plus the height
    const vHalf = Math.max(cur.rh / cam.aspect, cur.rh * Math.sin(elev) + cur.hy * Math.cos(elev)) * 1.06;
    const dist = vHalf / Math.tan(THREE.MathUtils.degToRad(cam.fov / 2));
    this.dist = this.dist ? this.dist + (dist - this.dist) * 0.3 : dist;
    const cy = cur.center.y;
    cam.position.set(0, cy + Math.sin(elev) * this.dist, Math.cos(elev) * this.dist);
    cam.near = Math.max(0.02, this.dist * 0.05);
    cam.far = this.dist * 4 + 10;
    cam.lookAt(0, cy, 0);
    cam.updateProjectionMatrix();
    const src = this.cameos.renderLive(this.scene, cam, w, h);
    if (!src) return this.detach();
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(src, 0, 0, w, h, 0, 0, w, h);
    if (!this.drawn) {
      this.drawn = true;
      host.classList.add('live');
    }
  };

  dispose() {
    this.disposed = true;
    this.detach();
    for (const e of this.cache.values()) e.model.root.removeFromParent();
    this.cache.clear();
    this.cur = null;
    this.floor.geometry.dispose();
    const fm = this.floor.material as THREE.MeshBasicMaterial;
    fm.map?.dispose();
    fm.dispose();
  }
}
