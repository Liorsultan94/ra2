import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { DEFS, unitDef } from '../sim/defs';
import { standHeight } from '../sim/map';
import type { Entity, SimEvent } from '../sim/types';
import type { GameRenderer } from './renderer';
import { THERMAL_GLSL, renderHeatMask, thermalUniforms } from './thermal';

/*
 * Live drone camera (picture-in-picture).
 *
 * Shows a white-hot thermal feed from one of the player's drones: the selected
 * UAV, or automatically a drone that is attacking / a kamikaze munition diving
 * on its target (the feed rides the munition down and cuts to static on impact).
 *
 * Cost control: the feed renders the scene into a small render target
 * (320x240, 256x192 on phones) and a half-size heat mask at ~12 fps with
 * shadows frozen and a short far plane; every frame only a tiny composite quad
 * is drawn into the PiP rectangle of the main canvas (scissored viewport).
 * The DOM frame on top carries the HUD text, crosshair, target box and buttons.
 */

const FEED_FPS = 12;
const STATIC_TIME = 1.0;

export function isDroneDef(def: string): boolean {
  const d = DEFS[def];
  if (!d || d.kind !== 'unit') return false;
  const u = unitDef(def);
  return !!u.air && (!!u.kamikaze || u.model === 'uav' || u.model === 'heavy_uav' || u.model === 'shahed');
}

interface Feed {
  id: number;
  kamikaze: boolean;
  /** Lost (destroyed / impact): playing static since this time. */
  lostAt: number;
  name: string;
  callsign: string;
}

export class DroneCam {
  /** 'auto' follows selected / attacking drones; 'off' disables the feed. */
  mode: 'auto' | 'off' = 'auto';
  readonly el: HTMLElement;
  private screen: HTMLElement;
  private txtTL: HTMLElement;
  private txtTR: HTMLElement;
  private txtBL: HTMLElement;
  private txtBR: HTMLElement;
  private box: HTMLElement;
  private title: HTMLElement;
  private cam = new THREE.PerspectiveCamera(22, 4 / 3, 0.5, 80);
  private rt: THREE.WebGLRenderTarget;
  private heat: THREE.WebGLRenderTarget;
  private quad: FullScreenQuad;
  private uniforms = { ...thermalUniforms(), staticAmt: { value: 0 } };
  private feed: Feed | null = null;
  private time = 0;
  private acc = 1;
  private rendered = false;
  private collapsed = false;
  private closedUntil = -1;
  private selKey = '';
  private attackAt = new Map<number, number>();
  private lookAt = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private tgt = new THREE.Vector3();
  private lastPos = new THREE.Vector3();
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private rectAt = -1;
  private textAt = 0;
  private snap = true;
  /** Cost of the last feed update (ms), for perf checks. */
  lastCostMs = 0;

  constructor(
    private r: GameRenderer,
    container: HTMLElement,
    private onJump: (x: number, y: number) => void,
  ) {
    const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    const w = coarse ? 256 : 320;
    const h = Math.round((w * 3) / 4);
    this.rt = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true });
    this.heat = new THREE.WebGLRenderTarget(w >> 1, h >> 1, { depthBuffer: true });
    this.uniforms.res.value.set(w, h);
    this.uniforms.linearIn.value = 1;
    this.uniforms.grain.value = 0.09;
    this.uniforms.tDiffuse.value = this.rt.texture;
    this.uniforms.tHeat.value = this.heat.texture;
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
      fragmentShader:
        THERMAL_GLSL +
        `
        uniform float staticAmt;
        varying vec2 vUv;
        void main() {
          float v = thermal(vUv);
          float s = hash(floor(vUv * res * 0.5) + fract(time * 31.7) * 57.0);
          float band = step(0.9, fract(vUv.y * 3.0 + time * 1.7)) * 0.25;
          v = mix(v, s * 0.85 + band, staticAmt);
          gl_FragColor = vec4(vec3(v), 1.0);
        }`,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this.quad = new FullScreenQuad(mat);

    this.el = document.createElement('div');
    this.el.className = 'dronecam hidden';
    this.el.innerHTML = `
      <div class="dc-bar"><span class="dc-rec"></span><span class="dc-title">DRONE FEED</span>
        <button class="dc-btn dc-min" title="Collapse">&#9662;</button><button class="dc-btn dc-close" title="Close drone camera">&#10005;</button></div>
      <div class="dc-screen">
        <i class="dc-cross"></i><i class="dc-box"></i>
        <span class="dc-t tl"></span><span class="dc-t tr"></span><span class="dc-t bl"></span><span class="dc-t br"></span>
      </div>`;
    container.appendChild(this.el);
    this.screen = this.el.querySelector('.dc-screen')!;
    this.title = this.el.querySelector('.dc-title')!;
    this.box = this.el.querySelector('.dc-box')!;
    this.txtTL = this.el.querySelector('.dc-t.tl')!;
    this.txtTR = this.el.querySelector('.dc-t.tr')!;
    this.txtBL = this.el.querySelector('.dc-t.bl')!;
    this.txtBR = this.el.querySelector('.dc-t.br')!;
    const stop = (e: Event) => e.stopPropagation();
    for (const ev of ['pointerdown', 'pointerup', 'mousedown', 'touchstart', 'wheel', 'contextmenu']) this.el.addEventListener(ev, stop);
    this.el.querySelector('.dc-close')!.addEventListener('click', () => this.close());
    this.el.querySelector('.dc-min')!.addEventListener('click', () => this.setCollapsed(!this.collapsed));
    this.title.addEventListener('click', () => this.collapsed && this.setCollapsed(false));
    this.screen.addEventListener('click', () => this.jump());
    if (coarse && Math.min(window.innerWidth, window.innerHeight) < 500) this.el.classList.add('phone');
  }

  get active(): boolean {
    return !!this.feed && !this.collapsed;
  }

  /** Followed entity id (or -1). */
  get feedId(): number {
    return this.feed?.id ?? -1;
  }

  setMode(m: 'auto' | 'off') {
    this.mode = m;
    if (m === 'off') this.setFeed(null);
  }

  private setCollapsed(c: boolean) {
    this.collapsed = c;
    this.el.classList.toggle('collapsed', c);
    this.rectAt = -1;
  }

  private close() {
    this.setFeed(null);
    this.closedUntil = this.time + 25;
  }

  private jump() {
    const f = this.feed;
    if (!f) return;
    const e = this.r.world.get(f.id);
    const t = e && e.targetId >= 0 ? this.r.world.get(e.targetId) : undefined;
    if (t) this.onJump(t.x, t.y);
    else if (e) this.onJump(e.x, e.y);
    else this.onJump(this.tgt.x, this.tgt.z);
  }

  /** Game events: remember which of the player's drones are attacking. */
  onEvent(ev: SimEvent) {
    if (ev.t === 'fire' && ev.owner === this.r.viewer) {
      const src = this.r.world.get(ev.id);
      if (src && isDroneDef(src.def)) this.attackAt.set(ev.id, this.time);
    }
  }

  private setFeed(e: Entity | null) {
    if (!e) {
      this.feed = null;
      this.el.classList.add('hidden');
      return;
    }
    const u = unitDef(e.def);
    const name = (u.name || 'UAV').toUpperCase();
    const short = name.replace(/[^A-Z0-9 -]/g, '').split(' ').slice(-1)[0] || 'UAV';
    this.feed = { id: e.id, kamikaze: !!u.kamikaze, lostAt: -1, name, callsign: `${short.slice(0, 8)}-${String(e.id % 100).padStart(2, '0')}` };
    this.title.textContent = `${u.kamikaze ? 'MUNITION' : 'UAV'} FEED · ${this.feed.callsign}`;
    this.el.classList.remove('hidden');
    this.el.classList.toggle('kamikaze', !!u.kamikaze);
    this.snap = true;
    this.acc = 1;
    this.rendered = false;
    this.rectAt = -1;
  }

  /** Pick what to show. */
  private choose() {
    const w = this.r.world;
    const viewer = this.r.viewer;
    if (this.mode === 'off' || viewer < 0) {
      if (this.feed) this.setFeed(null);
      return;
    }
    // a lost feed plays static, then frees up
    if (this.feed && this.feed.lostAt >= 0) {
      if (this.time - this.feed.lostAt < STATIC_TIME) return;
      this.setFeed(null);
    }
    const cur = this.feed ? w.get(this.feed.id) : undefined;
    if (this.feed && (!cur || cur.dead)) {
      this.feed.lostAt = this.time;
      this.el.classList.add('lost');
      return;
    }
    this.el.classList.remove('lost');
    // selected drone (explicit choice wins, reopens a closed feed)
    let sel: Entity | undefined;
    for (const id of this.r.selection) {
      const e = w.get(id);
      if (e && e.owner === viewer && isDroneDef(e.def)) {
        sel = e;
        break;
      }
    }
    const key = sel ? String(sel.id) : '';
    const fresh = key !== this.selKey;
    this.selKey = key;
    if (sel && (fresh || this.time >= this.closedUntil)) {
      if (fresh) this.closedUntil = -1;
      if (!this.feed || this.feed.id !== sel.id) {
        // keep riding a diving munition until it hits
        if (!(this.feed?.kamikaze && cur)) this.setFeed(sel);
      }
      return;
    }
    if (this.time < this.closedUntil) {
      if (this.feed) this.setFeed(null);
      return;
    }
    if (this.feed?.kamikaze && cur) return;
    // auto: newest kamikaze munition of ours, else a drone that attacked in the last few seconds
    let kami: Entity | undefined;
    let uav: Entity | undefined;
    let best = -1;
    for (const e of w.list) {
      if (e.dead || e.owner !== viewer || e.kind !== 'unit' || !isDroneDef(e.def)) continue;
      const u = unitDef(e.def);
      if (u.kamikaze) {
        if (!kami || e.id > kami.id) kami = e;
      } else {
        const at = this.attackAt.get(e.id) ?? -1;
        if (at >= 0 && this.time - at < 5 && at > best) {
          best = at;
          uav = e;
        }
      }
    }
    const pick = kami ?? uav;
    if (pick) {
      if (!this.feed || (this.feed.id !== pick.id && (kami || !cur || (this.attackAt.get(this.feed.id) ?? -1) < this.time - 5))) this.setFeed(pick);
      return;
    }
    // nothing selected, nothing attacking: keep a uav feed a little while, then hide
    if (this.feed && !sel && (this.attackAt.get(this.feed.id) ?? -1) < this.time - 6) this.setFeed(null);
  }

  /** Aim the feed camera. Returns false when there is nothing to look at. */
  private aim(dt: number): boolean {
    const f = this.feed!;
    const w = this.r.world;
    const e = w.get(f.id);
    if (!e || e.dead) return this.rendered;
    const p = this.r.entityPos(e, 1);
    const t = e.targetId >= 0 ? w.get(e.targetId) : undefined;
    if (t && !t.dead) {
      this.tgt.copy(this.r.entityPos(t, 1));
      this.tgt.y += t.kind === 'building' ? 0.4 : 0.2;
    } else {
      // look ahead of the drone
      const fx = Math.cos(e.facing);
      const fz = Math.sin(e.facing);
      const ax = Math.max(0, Math.min(w.map.w - 0.01, p.x + fx * (f.kamikaze ? 3 : 4)));
      const az = Math.max(0, Math.min(w.map.h - 0.01, p.z + fz * (f.kamikaze ? 3 : 4)));
      this.tgt.set(ax, standHeight(w.map, ax, az), az);
    }
    const cam = this.cam;
    const k = this.snap ? 1 : Math.min(1, dt * 4);
    if (f.kamikaze) {
      // nose camera: ride the munition, stare at the target
      const vel = new THREE.Vector3().subVectors(p, this.lastPos);
      this.lastPos.copy(p);
      const ahead = vel.lengthSq() > 1e-6 && !t ? p.clone().addScaledVector(vel.normalize(), 4) : this.tgt;
      this.camPos.copy(p).y += 0.08;
      this.lookAt.lerp(ahead, this.snap ? 1 : Math.min(1, dt * 8));
      cam.fov = 52;
      cam.near = 0.05;
      cam.far = 50;
    } else {
      // targeting pod: a long lens from high above, on the drone's side of the target
      let hx = p.x - this.tgt.x;
      let hz = p.z - this.tgt.z;
      const hl = Math.hypot(hx, hz);
      if (hl < 0.3) {
        hx = Math.cos(e.facing + Math.PI);
        hz = Math.sin(e.facing + Math.PI);
      } else {
        hx /= hl;
        hz /= hl;
      }
      const el = THREE.MathUtils.degToRad(58);
      const dist = 15;
      const goal = new THREE.Vector3(this.tgt.x + hx * dist * Math.cos(el), this.tgt.y + dist * Math.sin(el), this.tgt.z + hz * dist * Math.cos(el));
      // slow orbit drift like a real loiter
      const a = this.time * 0.07;
      goal.x += Math.cos(a) * 0.6;
      goal.z += Math.sin(a) * 0.6;
      this.camPos.lerp(goal, k);
      this.lookAt.lerp(this.tgt, k);
      cam.fov = t ? 16 : 24;
      cam.near = 1;
      cam.far = 60;
    }
    this.snap = false;
    cam.position.copy(this.camPos);
    cam.lookAt(this.lookAt);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    // hud text (10 Hz)
    if (this.time >= this.textAt) {
      this.textAt = this.time + 0.1;
      const ground = standHeight(w.map, Math.max(0, Math.min(w.map.w - 0.01, p.x)), Math.max(0, Math.min(w.map.h - 0.01, p.z)));
      const alt = Math.max(0, (p.y - ground) * (f.kamikaze ? 180 : 2600));
      const rng = Math.hypot(p.x - this.tgt.x, p.y - this.tgt.y, p.z - this.tgt.z) * 120;
      const hdg = Math.round(((THREE.MathUtils.radToDeg(e.facing) + 90 + 360) % 360));
      this.txtTL.textContent = `${f.callsign}\nWHT HOT  ${f.kamikaze ? 'TERMINAL' : 'NFOV'}`;
      this.txtTR.textContent = `ALT ${Math.round(alt / 10) * 10} FT\nHDG ${String(hdg).padStart(3, '0')}`;
      this.txtBL.textContent = t ? `TGT ${(DEFS[t.def]?.name ?? '').toUpperCase().slice(0, 18)}` : 'SCANNING';
      this.txtBR.textContent = `RNG ${Math.round(rng)} M\n${f.kamikaze ? 'DIVE' : t ? 'LOCK' : 'TRACK'}`;
      this.box.classList.toggle('lock', !!t);
    }
    return true;
  }

  private updateRect(force = false) {
    if (!force && this.time < this.rectAt) return;
    this.rectAt = this.time + 0.5;
    const c = this.r.canvas.getBoundingClientRect();
    const s = this.screen.getBoundingClientRect();
    this.rect = { x: s.left - c.left, y: c.bottom - s.bottom, w: s.width, h: s.height };
  }

  /** Screen rectangle of the feed relative to the view (CSS px, top-left origin), for the 2D overlay to keep clear. */
  overlayRect(): { x: number; y: number; w: number; h: number } | null {
    if (!this.active) return null;
    const c = this.r.canvas.getBoundingClientRect();
    return { x: this.rect.x, y: c.height - this.rect.y - this.rect.h, w: this.rect.w, h: this.rect.h };
  }

  /** Per frame, after the main view has been drawn. */
  frame(dt: number) {
    this.time += dt > 0 ? dt : 1 / 60;
    this.choose();
    if (!this.feed || this.collapsed) return;
    const lost = this.feed.lostAt >= 0;
    const ok = lost ? this.rendered : this.aim(dt);
    this.updateRect();
    if (this.rect.w < 8 || this.rect.h < 8) return;
    const gl = this.r.renderer;
    // refresh the feed at a low rate
    this.acc += dt > 0 ? dt : 1 / 60;
    if (ok && !lost && this.acc >= 1 / FEED_FPS) {
      this.acc = 0;
      const t0 = performance.now();
      this.cam.aspect = this.rect.w / Math.max(1, this.rect.h);
      this.cam.updateProjectionMatrix();
      const sh = gl.shadowMap.autoUpdate;
      gl.shadowMap.autoUpdate = false;
      const prev = gl.getRenderTarget();
      gl.setRenderTarget(this.rt);
      gl.render(this.r.scene, this.cam);
      gl.setRenderTarget(prev);
      gl.shadowMap.autoUpdate = sh;
      renderHeatMask(gl, this.r.scene, this.cam, this.heat);
      this.rendered = true;
      this.lastCostMs = performance.now() - t0;
    }
    // target box: project the target into the feed
    if (ok && !lost) {
      const v = this.tgt.clone().project(this.cam);
      const inView = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      this.box.style.display = inView ? '' : 'none';
      if (inView) this.box.style.transform = `translate(${((v.x + 1) / 2) * this.rect.w}px, ${((1 - v.y) / 2) * this.rect.h}px) translate(-50%, -50%)`;
    }
    const st = lost ? 1 : this.rendered ? 0 : 1;
    this.uniforms.staticAmt.value = st;
    this.uniforms.time.value = this.time;
    // composite into the PiP rectangle of the main canvas
    const auto = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    gl.setScissorTest(true);
    gl.setScissor(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    gl.setViewport(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    this.quad.render(gl);
    gl.setScissorTest(false);
    const size = gl.getSize(new THREE.Vector2());
    gl.setViewport(0, 0, size.x, size.y);
    gl.autoClear = auto;
  }

  dispose() {
    this.el.remove();
    this.rt.dispose();
    this.heat.dispose();
    this.quad.dispose();
  }
}
