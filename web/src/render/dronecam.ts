import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { isSortieJet } from '../sim/airbase';
import { DEFS, WEAPONS, unitDef } from '../sim/defs';
import { heliGrounded, isHeli } from '../sim/helipad';
import { standHeight } from '../sim/map';
import { TPS, type Entity, type SimEvent } from '../sim/types';
import {
  MIN_HOLD,
  PRIO,
  WFOV_ABOVE,
  facingHeading,
  feedTitle,
  fmtAlt,
  fmtHdg,
  fmtRange,
  fmtSpeed,
  fmtTti,
  footprintFor,
  fovFor,
  groundSpeedKt,
  jetRunStarted,
  northInPicture,
  tapeLabel,
  wrapDeg,
  pickFeed,
  podPosition,
  projectCorners,
  projectPx,
  readouts,
  slewAngle,
  smoothK,
  type CurFeed,
  type FeedCand,
  type FeedKind,
} from './podmath';
import type { GameRenderer } from './renderer';
import { THERMAL_GLSL, renderHeatMask, thermalUniforms } from './thermal';
import { HIDE_LOD } from './perf/lod';
import { XRAY_LAYER } from './xray';

const XRAY_MASK = 1 << XRAY_LAYER;

/*
 * Live strike camera (picture-in-picture).
 *
 * A white-hot thermal feed from the sensor of one of the player's aircraft:
 *  - a strike drone's targeting pod (the selected UAV, or a drone that is attacking),
 *  - a kamikaze munition's nose camera (it rides the munition down and cuts to static on impact),
 *  - a strike jet's targeting pod during its bombing run ("F-35A · TGT POD"): lock, bomb away with a
 *    time-to-impact countdown, the bomb arriving, the blast whiting out the sensor, the hot fire and smoke,
 *  - an attack helicopter's nose sight while it engages ("AH-64E · TADS"), the same sequence for its missiles.
 * Which one (podmath.ts pickFeed): a selected unit, then a jet run, a helicopter, a kamikaze dive, a drone;
 * a feed stays up at least MIN_HOLD seconds unless its strike ends.
 *
 * Accuracy: the sensor sits on the aircraft's real bearing and (scaled, podmath.ts) altitude and stays
 * locked on the target (gimbal: smooth slews on a target change, no lag on a moving target). The target box
 * is the target's real bounding box projected with the camera matrices the picture was drawn with, so box,
 * crosshair and picture always agree; the readouts come from the same geometry.
 *
 * Cost control: the feed renders the scene into a small render target (480x360, 320x240 on touch
 * screens) plus the heat mask (depth-tested against it: hot bodies behind walls stay hidden) at
 * ~12 fps with shadows frozen and a short far plane, and maps it to thermal once per feed frame. Every frame
 * only a one-tap composite (sensor noise, scan lines, vignette, flash) is drawn into the PiP rectangle of the
 * main canvas (scissored viewport). The DOM frame on top carries the HUD text, crosshair, target box, buttons.
 */

const FEED_FPS = 12;
const STATIC_TIME = 1.0;
/** Seconds the picture stays white after a kamikaze impact before the static. */
const WHITEOUT = 0.16;
/** Jet / helicopter feed: aftermath shown after the last impact before the feed ends or switches. */
const AFTERMATH = 2.0;
/** Drone / helicopter feed: seconds without engaging before it ends. */
const IDLE_END = 2.5;
const MAX_BURNS = 6;
/** Symbology fades back below this time to impact (s) and for this long after an impact (s). */
const FADE_TTI = 2.5;
const FADE_AFTER = 2.0;
const MAX_MUN = 4;

/** Compass tape: degrees of tape beyond 0..360 on each side (so the window never runs off its end). */
const TAPE_SPAN = 60;

/** Compass tape ticks (every 5 degrees, longer every 10) and labels every 30 degrees, -TAPE_SPAN .. 360 + TAPE_SPAN. */
function tapeHtml(): string {
  const all = 360 + 2 * TAPE_SPAN;
  let h = '';
  for (let d = -TAPE_SPAN; d <= 360 + TAPE_SPAN; d += 5) {
    const x = (((d + TAPE_SPAN) / all) * 100).toFixed(3);
    h += `<i class="${d % 10 === 0 ? 'mj' : 'mn'}" style="left:${x}%"></i>`;
    if (d % 30 === 0) h += `<b style="left:${x}%">${tapeLabel(d)}</b>`;
  }
  return h;
}

export function isDroneDef(def: string): boolean {
  const d = DEFS[def];
  if (!d || d.kind !== 'unit') return false;
  const u = unitDef(def);
  return !!u.air && (!!u.kamikaze || u.model === 'uav' || u.model === 'heavy_uav' || u.model === 'shahed');
}

/** Feed kind of a unit definition (null: no strike camera). */
export function feedKindOf(def: string): FeedKind | null {
  const d = DEFS[def];
  if (!d || d.kind !== 'unit') return null;
  const u = unitDef(def);
  if (isDroneDef(def)) return u.kamikaze ? 'kami' : 'uav';
  if (isSortieJet(u)) return 'jet';
  if (isHeli(u) && u.weapon) return 'heli';
  return null;
}

interface Feed extends CurFeed {
  kind: FeedKind;
  weapon: string;
  name: string;
  callsign: string;
  /** Lost (destroyed / impact): playing static since this time. */
  lostAt: number;
  /** Locked target (-1 none), its last known centre, ground level, size, name. */
  tgtId: number;
  tgtPos: THREE.Vector3;
  tgtGround: number;
  tgtExtent: number;
  tgtName: string;
  /** Target model's bounding-box centre relative to its position (measured at each feed frame). */
  tgtOff: THREE.Vector3;
  /** Last time the unit was engaging (target in reach, firing, munitions in flight). */
  activeAt: number;
  /** Last impact of its munitions near the target (-1 none). */
  impactAt: number;
  /** Jet: bomb released (the feed then ends after the aftermath). */
  released: boolean;
  /** Feed to go back to when a jet run ends (-1 none). */
  prevId: number;
  /** Smoothed ground speed (kt, -1 unset) and when it was last updated. */
  gs: number;
  gsAt: number;
  /** Platform title ("F-35A · TGT POD"). */
  title: string;
  /** Time the current target was acquired (the lock marker blinks while acquiring). */
  lockAt: number;
  /** Half length of the aircraft's own model (the nose camera sits that far ahead of its centre). */
  selfR: number;
}

interface Burn {
  x: number;
  y: number;
  z: number;
  t: number;
  size: number;
  seed: number;
}

export class DroneCam {
  /** 'auto' follows selected / attacking aircraft; 'off' disables the feed. */
  mode: 'auto' | 'off' = 'auto';
  readonly el: HTMLElement;
  private screen: HTMLElement;
  private txtTL: HTMLElement;
  private txtTR: HTMLElement;
  private txtBL: HTMLElement;
  private txtBR: HTMLElement;
  private box: HTMLElement;
  private tape: HTMLElement;
  private brg: HTMLElement;
  private north: HTMLElement;
  private fading = false;
  /** Time to impact shown on the last feed frame (-1 none). */
  private lastTti = -1;
  private title: HTMLElement;
  private cam = new THREE.PerspectiveCamera(22, 4 / 3, 0.5, 80);
  private rt: THREE.WebGLRenderTarget;
  private heat: THREE.WebGLRenderTarget;
  private proc: THREE.WebGLRenderTarget;
  private procQuad: FullScreenQuad;
  private quad: FullScreenQuad;
  private pu = {
    ...thermalUniforms(),
    aspect: { value: 4 / 3 },
    burnA: { value: Array.from({ length: MAX_BURNS }, () => new THREE.Vector4()) },
    burnB: { value: Array.from({ length: MAX_BURNS }, () => new THREE.Vector4()) },
    munA: { value: Array.from({ length: MAX_MUN }, () => new THREE.Vector4()) },
    munB: { value: Array.from({ length: MAX_MUN }, () => new THREE.Vector4()) },
  };
  private uniforms = {
    tProc: { value: null as THREE.Texture | null },
    res: { value: new THREE.Vector2(1, 1) },
    time: { value: 0 },
    aspect: { value: 4 / 3 },
    staticAmt: { value: 0 },
    flash: { value: 0 },
    flashUv: { value: new THREE.Vector2(0.5, 0.5) },
    gain: { value: 1 },
  };
  private feed: Feed | null = null;
  private time = 0;
  private acc = 1;
  private rendered = false;
  private collapsed = false;
  private closedUntil = -1;
  private selKey = '';
  private attackAt = new Map<number, number>();
  private cands: FeedCand[] = [];
  private kinds = new Map<string, FeedKind | null>();
  private lookAt = new THREE.Vector3();
  private lookOff = new THREE.Vector3();
  private scan = new THREE.Vector3();
  private camPos = new THREE.Vector3();
  private air = new THREE.Vector3();
  private fwd = new THREE.Vector3();
  private upYaw = 0;
  private fov = 20;
  private footprint = 9;
  private snap = true;
  private vp = new THREE.Matrix4();
  private bbox = new THREE.Box3();
  private bbLocal = new THREE.Box3();
  private corners = Array.from({ length: 8 }, () => new THREE.Vector3());
  private inv = new THREE.Matrix4();
  private rel = new THREE.Matrix4();
  private bb = new THREE.Box3();
  private tmp = new THREE.Vector3();
  private tmp2 = new THREE.Vector3();
  private size2 = new THREE.Vector2();
  private rect = { x: 0, y: 0, w: 0, h: 0 };
  private rectAt = -1;
  private burns: Burn[] = [];
  private flashAt = -1;
  private flashAmp = 0;
  private flashPos = new THREE.Vector3();
  /** The ridden munition hit something (white-out before the static). */
  private impactLost = false;
  /** Cost of the last feed update (ms), for perf checks. */
  lastCostMs = 0;

  constructor(
    private r: GameRenderer,
    container: HTMLElement,
    private onJump: (x: number, y: number) => void,
  ) {
    const coarse = typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches;
    const phone = coarse && Math.min(window.innerWidth, window.innerHeight) < 500;
    // (the phone's PiP is ~780 device px wide: 320 is ~0.5% of the main view's fill rate at the feed's 12 fps)
    const w = coarse ? 320 : 480;
    const h = Math.round((w * 3) / 4);
    const gl = r.renderer;
    // linear HDR colour: fires and blasts above 1.0 still read white-hot after the thermal mapping
    const half = gl.capabilities.isWebGL2 && gl.extensions.has('EXT_color_buffer_float');
    const depth = new THREE.DepthTexture(w, h);
    this.rt = new THREE.WebGLRenderTarget(w, h, { type: half ? THREE.HalfFloatType : THREE.UnsignedByteType, depthBuffer: true, depthTexture: depth });
    // the heat mask shares the colour pass's depth: hot bodies behind walls, trees or hills stay hidden
    this.heat = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, depthTexture: depth });
    this.proc = new THREE.WebGLRenderTarget(w, h, { depthBuffer: false });
    this.pu.res.value.set(w, h);
    this.pu.linearIn.value = 1;
    this.pu.hdrIn.value = half ? 1 : 0;
    this.pu.grain.value = 0;
    this.pu.tDiffuse.value = this.rt.texture;
    this.pu.tHeat.value = this.heat.texture;
    this.uniforms.res.value.set(w, h);
    this.uniforms.tProc.value = this.proc.texture;
    const vert = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;
    // once per feed frame, at the sensor's resolution: thermal mapping, detail enhancement, hot plumes / munitions
    this.procQuad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: this.pu,
        vertexShader: vert,
        fragmentShader:
          THERMAL_GLSL +
          /* glsl */ `
          uniform float aspect;
          uniform vec4 burnA[${MAX_BURNS}];
          uniform vec4 burnB[${MAX_BURNS}];
          uniform vec4 munA[${MAX_MUN}];
          uniform vec4 munB[${MAX_MUN}];
          varying vec2 vUv;
          float vnoise(vec2 p) {
            vec2 i = floor(p);
            vec2 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
          }
          float seg(vec2 p, vec2 a, vec2 b, out float h) {
            vec2 pa = p - a;
            vec2 ba = b - a;
            h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-8), 0.0, 1.0);
            return length(pa - ba * h);
          }
          void main() {
            vec2 px = 1.0 / res;
            float c = heatAt(vUv);
            float n4 = heatAt(vUv + vec2(px.x, 0.0)) + heatAt(vUv - vec2(px.x, 0.0)) + heatAt(vUv + vec2(0.0, px.y)) + heatAt(vUv - vec2(0.0, px.y));
            // digital detail enhancement, like a real FLIR's
            float v = c + (c - n4 * 0.25) * 0.7;
            vec2 p = vec2(vUv.x * aspect, vUv.y);
            vec2 ar = vec2(aspect, 1.0);
            // burning wrecks / craters: a hot core and a cooling, turbulent plume rising from it
            for (int i = 0; i < ${MAX_BURNS}; i++) {
              vec4 b = burnB[i];
              if (b.y <= 0.0) continue;
              float h;
              float d = seg(p, burnA[i].xy * ar, burnA[i].zw * ar, h);
              float rr = b.x * (0.7 + h * 1.3);
              float turb = vnoise(p / max(b.x, 1e-4) * 1.7 - vec2(0.0, time * 2.3) + b.z);
              float blob = exp(-(d * d) / (rr * rr) * (1.2 + 1.6 * (1.0 - turb)));
              v = max(v, b.y * (1.0 - 0.6 * h) * (0.7 + 0.45 * turb) * blob);
            }
            // munitions in flight: a hot missile motor and its exhaust trail, a warm bomb body
            for (int i = 0; i < ${MAX_MUN}; i++) {
              vec4 m = munB[i];
              if (m.y <= 0.0) continue;
              float h;
              float d = seg(p, munA[i].xy * ar, munA[i].zw * ar, h);
              float rr = m.x * (1.0 + h * 0.8);
              v = max(v, m.y * (1.0 - 0.55 * h) * exp(-(d * d) / (rr * rr)));
            }
            gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    // every frame, into the PiP rectangle: one texture tap + sensor noise, scan lines, vignette, flash, static
    this.quad = new FullScreenQuad(
      new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: vert,
        fragmentShader: /* glsl */ `
          uniform sampler2D tProc;
          uniform vec2 res;
          uniform float time;
          uniform float aspect;
          uniform float staticAmt;
          uniform float flash;
          uniform vec2 flashUv;
          uniform float gain;
          varying vec2 vUv;
          float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
          void main() {
            float v = texture2D(tProc, vUv).r * gain;
            // blast: the sensor saturates from the fireball outwards
            float fd = length((vUv - flashUv) * vec2(aspect, 1.0));
            v = mix(v, 1.0, clamp(flash * (0.6 + 0.4 * (1.0 - smoothstep(0.0, 0.55, fd))), 0.0, 1.0));
            vec2 sp = floor(vUv * res);
            v += (hash(sp + fract(time * 17.31) * 113.0) - 0.5) * 0.075;
            v += (hash(vec2(sp.x, 3.7)) - 0.5) * 0.02;
            v *= 0.95 + 0.05 * sin(vUv.y * res.y * 2.2);
            vec2 d = vUv - 0.5;
            v *= 1.0 - dot(d, d) * 0.6;
            float s = hash(floor(vUv * res * 0.5) + fract(time * 31.7) * 57.0);
            float band = step(0.9, fract(vUv.y * 3.0 + time * 1.7)) * 0.25;
            v = mix(v, s * 0.85 + band, staticAmt);
            gl_FragColor = vec4(vec3(clamp(v, 0.0, 1.0)), 1.0);
          }`,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      }),
    );

    this.el = document.createElement('div');
    this.el.className = 'dronecam hidden';
    this.el.innerHTML = `
      <div class="dc-bar"><span class="dc-rec"></span><span class="dc-title">DRONE FEED</span>
        <button class="dc-btn dc-min" title="Collapse">&#9662;</button><button class="dc-btn dc-close" title="Close drone camera">&#10005;</button></div>
      <div class="dc-screen">
        <div class="dc-sym">
          <div class="dc-tape"><div class="dc-tape-in">${tapeHtml()}</div></div><i class="dc-caret"></i><span class="dc-brg">000</span>
          <i class="dc-north"><b>N</b></i>
          <i class="dc-cross"></i><i class="dc-box"></i>
          <span class="dc-t tl"></span><span class="dc-t tr"></span><span class="dc-t bl"></span><span class="dc-t br"></span>
        </div>
      </div>`;
    container.appendChild(this.el);
    this.screen = this.el.querySelector('.dc-screen')!;
    this.title = this.el.querySelector('.dc-title')!;
    this.box = this.el.querySelector('.dc-box')!;
    this.tape = this.el.querySelector('.dc-tape-in')!;
    this.brg = this.el.querySelector('.dc-brg')!;
    this.north = this.el.querySelector('.dc-north')!;
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
    if (phone) this.el.classList.add('phone');
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
    const t = f.tgtId >= 0 ? this.r.world.get(f.tgtId) : undefined;
    if (t && !t.dead) this.onJump(t.x, t.y);
    else if (f.tgtId >= 0) this.onJump(f.tgtPos.x, f.tgtPos.z);
    else if (e) this.onJump(e.x, e.y);
  }

  private kindOf(e: Entity): FeedKind | null {
    let k = this.kinds.get(e.def);
    if (k === undefined) {
      k = feedKindOf(e.def);
      this.kinds.set(e.def, k);
    }
    return k;
  }

  /** Game events: which of the player's aircraft are firing; impacts for the blast flash and the burning plumes. */
  onEvent(ev: SimEvent) {
    if (ev.t === 'fire' && ev.owner === this.r.viewer) {
      const src = this.r.world.get(ev.id);
      if (src && this.kindOf(src)) this.attackAt.set(ev.id, this.time);
    } else if (ev.t === 'impact' && !ev.air) {
      const wpn = WEAPONS[ev.weapon];
      if (!wpn) return;
      const big = wpn.flight === 'bomb' ? 1.6 : wpn.warhead === 'missile' || wpn.warhead === 'thermo' || wpn.warhead === 'artillery' ? 1 : wpn.warhead === 'rocket' ? 0.7 : 0;
      if (!big) return;
      const map = this.r.world.map;
      const gx = Math.max(0, Math.min(map.w - 0.01, ev.x));
      const gy = Math.max(0, Math.min(map.h - 0.01, ev.y));
      this.burns.push({ x: ev.x, y: standHeight(map, gx, gy), z: ev.y, t: this.time, size: big * (0.6 + (wpn.splash ?? 0.6) * 0.35), seed: this.burns.length * 7.31 + ev.x });
      if (this.burns.length > MAX_BURNS) this.burns.shift();
      const f = this.feed;
      if (!f || f.lostAt >= 0) return;
      // our strike landing on the target: the sensor saturates
      const near = Math.hypot(ev.x - f.tgtPos.x, ev.y - f.tgtPos.z) < 2.2 || (f.kind === 'kami' && Math.hypot(ev.x - this.air.x, ev.y - this.air.z) < 1.5);
      if (near && (ev.weapon === f.weapon || f.kind === 'kami')) {
        f.impactAt = this.time;
        this.flashAt = this.time;
        this.flashAmp = wpn.flight === 'bomb' ? 1 : f.kind === 'kami' ? 1 : 0.75;
        this.flashPos.set(ev.x, ev.z, ev.y);
        if (f.kind === 'kami') this.impactLost = true;
      }
    }
  }

  private setFeed(e: Entity | null, prio = 0, prevId = -1) {
    if (!e) {
      this.feed = null;
      this.el.classList.add('hidden');
      return;
    }
    const kind = this.kindOf(e)!;
    const u = unitDef(e.def);
    const name = (u.name || 'UAV').toUpperCase();
    const short = name.replace(/[^A-Z0-9 -]/g, '').split(' ').slice(-1)[0] || 'UAV';
    const callsign = `${short.slice(0, 8)}-${String(e.id % 100).padStart(2, '0')}`;
    this.feed = {
      id: e.id,
      kind,
      prio,
      since: this.time,
      ended: false,
      locked: false,
      weapon: u.weapon ?? '',
      name,
      callsign,
      lostAt: -1,
      tgtId: -1,
      tgtPos: new THREE.Vector3(),
      tgtGround: 0,
      tgtExtent: 0,
      tgtName: '',
      tgtOff: new THREE.Vector3(0, 0.25, 0),
      activeAt: this.time,
      impactAt: -1,
      released: false,
      prevId,
      title: feedTitle(kind, u.name || 'UAV', callsign),
      gs: -1,
      gsAt: this.time,
      lockAt: this.time,
      selfR: this.targetBox(e, this.bb) ? Math.max(this.bb.max.x - this.bb.min.x, this.bb.max.z - this.bb.min.z) / 2 + 0.02 : 0.2,
    };
    this.title.textContent = this.feed.title;
    this.el.classList.remove('hidden', 'lost');
    this.box.style.display = 'none';
    this.el.classList.toggle('kamikaze', kind === 'kami');
    this.impactLost = false;
    this.flashAt = -1;
    this.lastTti = -1;
    this.snap = true;
    this.acc = 1;
    this.rendered = false;
    this.rectAt = -1;
  }

  /** The unit's current strike target (attack order kept by a jet after the release, too). */
  private targetOf(e: Entity): Entity | undefined {
    const w = this.r.world;
    let id = e.targetId;
    if (id < 0 && e.order.type === 'attack') id = e.order.target;
    const t = id >= 0 ? w.get(id) : undefined;
    return t && !t.dead ? t : undefined;
  }

  /** Is the unit engaging right now (target in reach / bombing run / firing)? */
  private engaging(e: Entity, k: FeedKind): boolean {
    const t = this.targetOf(e);
    const fired = this.attackAt.get(e.id) ?? -1e9;
    const u = unitDef(e.def);
    const range = u.weapon ? WEAPONS[u.weapon]?.range ?? 6 : 6;
    switch (k) {
      case 'kami':
        return true;
      case 'jet': {
        const s = e.sortie;
        if (!s || !t) return false;
        return jetRunStarted(s.phase, s.ammo, true, Math.hypot(t.x - e.x, t.y - e.y), s.v * TPS);
      }
      case 'heli':
        if (heliGrounded(e)) return false;
        return this.time - fired < 4 || (!!t && Math.hypot(t.x - e.x, t.y - e.y) <= range + 2);
      case 'uav':
        return this.time - fired < 5 || (!!t && Math.hypot(t.x - e.x, t.y - e.y) <= range + 1.5);
    }
  }

  /** Munitions of the feed's unit in flight. */
  private munitions(id: number) {
    const out: { x: number; y: number; z: number; vx: number; vy: number; vz: number; bomb: boolean; tti: number }[] = [];
    const a = this.r.frameAlpha;
    for (const p of this.r.world.projectiles) {
      if (p.sourceId !== id) continue;
      const x = p.px + (p.x - p.px) * a;
      const y = p.py + (p.y - p.py) * a;
      const z = p.pz + (p.z - p.pz) * a;
      const vx = (p.x - p.px) * TPS;
      const vy = (p.y - p.py) * TPS;
      const vz = (p.z - p.pz) * TPS;
      let tti: number;
      if (p.flight === 'bomb' || !(p.speed > 0)) tti = Math.max(0, p.T - p.age) / TPS - a / TPS;
      else {
        const f = this.feed;
        const tx = f && f.tgtId >= 0 ? f.tgtPos.x : p.tx;
        const ty = f && f.tgtId >= 0 ? f.tgtPos.z : p.ty;
        const tz = f && f.tgtId >= 0 ? f.tgtPos.y : p.tz;
        tti = Math.hypot(tx - x, ty - y, tz - z) / Math.max(1, p.speed, Math.hypot(vx, vy, vz));
      }
      out.push({ x, y, z, vx, vy, vz, bomb: p.flight === 'bomb', tti: Math.max(0, tti) });
    }
    return out;
  }

  /** Candidates for the feed, by priority. */
  private candidates(): FeedCand[] {
    const w = this.r.world;
    const viewer = this.r.viewer;
    const out = this.cands;
    out.length = 0;
    // an explicitly selected unit: a drone always, a jet or a helicopter while it is engaging
    let sel: Entity | undefined;
    let selK: FeedKind | null = null;
    for (const id of this.r.selection) {
      const e = w.get(id);
      if (!e || e.dead || e.owner !== viewer) continue;
      const k = this.kindOf(e);
      if (k && (k === 'uav' || k === 'kami' || this.engaging(e, k))) {
        sel = e;
        selK = k;
        break;
      }
    }
    const key = sel ? String(sel.id) : '';
    const fresh = key !== this.selKey;
    this.selKey = key;
    if (sel && fresh) this.closedUntil = -1;
    const closed = this.time < this.closedUntil;
    if (sel && selK) out.push({ id: sel.id, kind: selK, prio: PRIO.selected });
    if (closed) return out;
    for (const e of w.list) {
      if (e.dead || e.owner !== viewer || e.kind !== 'unit' || e === sel) continue;
      const k = this.kindOf(e);
      if (k && this.engaging(e, k)) out.push({ id: e.id, kind: k, prio: PRIO[k] });
    }
    return out;
  }

  /** Pick what to show. */
  private choose() {
    const w = this.r.world;
    if (this.mode === 'off' || this.r.viewer < 0) {
      if (this.feed) this.setFeed(null);
      return;
    }
    const f = this.feed;
    const cur = f ? w.get(f.id) : undefined;
    if (f && f.lostAt < 0 && (!cur || cur.dead)) {
      // lost: (white-out after an impact) then static, then the feed frees up
      f.lostAt = this.time;
      f.locked = false;
      this.el.classList.add('lost');
    }
    if (f && f.lostAt >= 0 && this.time - f.lostAt >= STATIC_TIME) f.ended = true;
    const cands = this.candidates();
    if (f && !f.ended && f.lostAt < 0 && cur) {
      const mine = cands.find((c) => c.id === f.id);
      if (mine) {
        f.prio = mine.prio;
        f.activeAt = this.time;
      }
      f.locked = f.kind === 'kami';
      const inFlight = this.r.world.projectiles.some((p) => p.sourceId === f.id);
      if (inFlight) f.activeAt = this.time;
      if (f.kind === 'jet') {
        if (cur.sortie && cur.sortie.ammo <= 0) f.released = true;
        // the run is over: bomb landed (aftermath shown), or the run broke off
        if (f.released && !inFlight && this.time - Math.max(f.impactAt, f.activeAt) >= AFTERMATH) f.ended = true;
        if (!f.released && !mine && this.time - f.activeAt >= IDLE_END) f.ended = true;
      } else if (f.kind !== 'kami' && !mine) {
        // engagement over (after the aftermath of its last hit)
        const quiet = Math.max(f.activeAt, f.impactAt >= 0 ? f.impactAt + AFTERMATH - IDLE_END : -1e9);
        if (this.time - quiet >= IDLE_END) f.ended = true;
      }
      if (!mine) f.prio = PRIO[f.kind];
      // a strike still running holds its place among the candidates
      if (!f.ended && !mine) cands.push({ id: f.id, kind: f.kind, prio: f.prio });
    }
    if (f && f.lostAt >= 0 && !f.ended) return; // static playing
    const pick = pickFeed(f, cands, this.time);
    if (pick) {
      const e = w.get(pick.id)!;
      // a jet run interrupting a running feed: go back to it afterwards
      const prev = f && !f.ended && pick.kind === 'jet' && f.lostAt < 0 ? f.id : -1;
      this.setFeed(e, pick.prio, prev);
      return;
    }
    if (f && f.ended) {
      const back = f.prevId >= 0 ? w.get(f.prevId) : undefined;
      if (back && !back.dead && this.kindOf(back) && this.time >= this.closedUntil) {
        this.setFeed(back, PRIO[this.kindOf(back)!]);
        // it may hand over to a newer strike straight away
        this.feed!.since = this.time - MIN_HOLD;
      } else this.setFeed(null);
    }
  }

  /** Track the target: the locked entity's centre, or its last known position once it is gone. */
  private track(e: Entity): boolean {
    const f = this.feed!;
    const t = this.targetOf(e);
    if (t) {
      const c = this.r.entityPos(t, this.r.frameAlpha, this.tmp);
      if (t.id !== f.tgtId) {
        // first sight: measure the model (then once per feed frame in annotate)
        if (this.targetBox(t, this.bb)) {
          this.bb.getCenter(f.tgtOff).sub(c);
          f.tgtExtent = Math.max(this.bb.max.x - this.bb.min.x, this.bb.max.z - this.bb.min.z);
        } else {
          f.tgtOff.set(0, t.kind === 'building' ? 0.5 : 0.25, 0);
          f.tgtExtent = 0.9;
        }
      }
      c.add(f.tgtOff);
      if (t.id !== f.tgtId) {
        // slew to the new target: the look point eases over from the old one
        if (!this.snap && f.tgtId >= 0) this.lookOff.add(f.tgtPos).sub(c);
        else if (!this.snap) this.lookOff.copy(this.lookAt).sub(c);
        f.tgtId = t.id;
        f.tgtName = (DEFS[t.def]?.name ?? '').toUpperCase().slice(0, 18);
        f.lockAt = this.time;
      }
      f.tgtPos.copy(c);
      const map = this.r.world.map;
      f.tgtGround = standHeight(map, Math.max(0, Math.min(map.w - 0.01, t.x)), Math.max(0, Math.min(map.h - 0.01, t.y)));
      return true;
    }
    // target destroyed: keep staring at where it was (the aftermath) while the strike is on
    return f.tgtId >= 0 && (f.kind === 'jet' || f.kind === 'heli' || f.kind === 'uav') && this.time - f.activeAt < AFTERMATH + 1;
  }

  /**
   * The target's body as an oriented box (a tank turned 45 degrees gets a tight box, not its world-axis
   * bounds): its 8 world corners in `this.corners`, their world bounds in `out`. False: no model to measure.
   */
  private targetBox(t: Entity, out: THREE.Box3): boolean {
    const v = this.r.visuals.get(t.id);
    if (!v) return false;
    const root = v.model.root;
    const loc = this.bbLocal.makeEmpty();
    const bb = this.bbox;
    this.inv.copy(root.matrixWorld).invert();
    root.traverseVisible((o) => {
      const m = o as THREE.Mesh;
      // (x-ray silhouette proxies sit on their own layer only; instanced parts keep their own bounds)
      if (!m.isMesh || !m.geometry || m.layers.mask === XRAY_MASK || (m as THREE.InstancedMesh).isInstancedMesh) return;
      if (((m.userData.hide as number | undefined) ?? 0) & HIDE_LOD) return; // a level of detail not drawn now
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      bb.copy(m.geometry.boundingBox!).applyMatrix4(this.rel.multiplyMatrices(this.inv, m.matrixWorld));
      loc.union(bb);
    });
    if (loc.isEmpty()) return false;
    // the body only: a model may carry wide helpers (ground aprons, glow cards) beyond it
    const d = DEFS[t.def];
    const c = this.corners;
    if (t.kind === 'building' && d?.kind === 'building') {
      // buildings stand square to the map: their footprint bounds the box
      out.makeEmpty();
      for (let i = 0; i < 8; i++) out.expandByPoint(c[i].set(i & 1 ? loc.max.x : loc.min.x, i & 2 ? loc.max.y : loc.min.y, i & 4 ? loc.max.z : loc.min.z).applyMatrix4(root.matrixWorld));
      const p = this.r.entityPos(t, this.r.frameAlpha, this.tmp2);
      bb.min.set(t.tx - 0.1, p.y - 0.3, t.ty - 0.1);
      bb.max.set(t.tx + d.w + 0.1, p.y + Math.max(0.6, this.r.visualHeight(t.id) * 1.2), t.ty + d.h + 0.1);
      if (!bb.containsBox(out)) {
        out.intersect(bb);
        if (out.isEmpty()) return false;
        for (let i = 0; i < 8; i++) c[i].set(i & 1 ? out.max.x : out.min.x, i & 2 ? out.max.y : out.min.y, i & 4 ? out.max.z : out.min.z);
      }
      return true;
    }
    // units: in the model's own frame (the box turns with the hull)
    const k = Math.max(1e-3, root.scale.x);
    const r = Math.max(0.6, (d?.kind === 'unit' ? unitDef(t.def).radius : 0.5) * 2.5) / k;
    bb.min.set(-r, -0.4 / k, -r);
    bb.max.set(r, Math.max(0.8, this.r.visualHeight(t.id) * 1.5) / k, r);
    loc.intersect(bb);
    if (loc.isEmpty()) return false;
    out.makeEmpty();
    for (let i = 0; i < 8; i++) out.expandByPoint(c[i].set(i & 1 ? loc.max.x : loc.min.x, i & 2 ? loc.max.y : loc.min.y, i & 4 ? loc.max.z : loc.min.z).applyMatrix4(root.matrixWorld));
    return true;
  }

  /** Aim the feed camera. Returns false when there is nothing to look at. */
  private aim(dt: number): boolean {
    const f = this.feed!;
    const w = this.r.world;
    const e = w.get(f.id);
    if (!e || e.dead) return this.rendered;
    const a = this.r.entityPos(e, this.r.frameAlpha, this.air);
    const locked = this.track(e);
    const cam = this.cam;
    const map = w.map;
    let ground: number;
    if (locked) {
      // gimbal: stays on the target; a target change slews over smoothly
      this.lookOff.multiplyScalar(1 - smoothK(dt, 7));
      if (this.snap) this.lookOff.set(0, 0, 0);
      this.lookAt.copy(f.tgtPos).add(this.lookOff);
      ground = f.tgtGround;
    } else {
      // no target: a stabilised look ahead of the aircraft
      const ahead = f.kind === 'kami' ? 3 : 4;
      const ax = Math.max(0, Math.min(map.w - 0.01, e.x + Math.cos(e.facing) * ahead));
      const az = Math.max(0, Math.min(map.h - 0.01, e.y + Math.sin(e.facing) * ahead));
      this.tmp.set(ax, standHeight(map, ax, az), az);
      if (this.snap) this.scan.copy(this.tmp);
      else this.scan.lerp(this.tmp, smoothK(dt, 2.5));
      this.lookOff.copy(this.lookAt).sub(this.scan);
      this.lookAt.copy(this.scan);
      this.lookOff.set(0, 0, 0);
      ground = this.scan.y;
    }
    if (f.kind === 'kami') {
      // nose camera on the munition: at the tip of the nose along the flight path (its own airframe is
      // behind the lens, out of the picture)
      const vx = e.x - e.px;
      const vy = e.y - e.py;
      const vz = e.z - e.pz;
      const vl = Math.hypot(vx, vy, vz);
      if (vl > 1e-4) this.fwd.set(vx / vl, vz / vl, vy / vl);
      else this.fwd.set(Math.cos(e.facing), 0, Math.sin(e.facing));
      this.camPos.copy(a).addScaledVector(this.fwd, f.selfR);
      cam.near = 0.03;
      cam.far = 45;
    } else {
      const p = podPosition(a, ground);
      this.camPos.set(p.x, p.y, p.z);
    }
    const dist = this.camPos.distanceTo(this.lookAt);
    if (f.kind !== 'kami') {
      cam.near = Math.max(0.2, dist * 0.08);
      cam.far = dist + 30;
    }
    // field of view: the target with room around it (a fixed lens on a munition)
    const aspect = this.rect.w > 8 && this.rect.h > 8 ? this.rect.w / this.rect.h : 4 / 3;
    this.footprint = footprintFor(f.kind, locked ? f.tgtExtent : 0);
    const want = f.kind === 'kami' ? 52 : fovFor(dist, this.footprint, aspect);
    this.fov = this.snap ? want : this.fov + (want - this.fov) * smoothK(dt, 3);
    cam.fov = this.fov;
    cam.aspect = aspect;
    // image up = the far side; looking (almost) straight down, the up direction is held / slewed, never flips
    const hx = this.lookAt.x - this.camPos.x;
    const hz = this.lookAt.z - this.camPos.z;
    const hl = Math.hypot(hx, hz);
    if (hl > 0.02) {
      const yaw = Math.atan2(hz, hx);
      this.upYaw = this.snap ? yaw : slewAngle(this.upYaw, yaw, dt * 2.5);
    }
    const dep = Math.atan2(this.camPos.y - this.lookAt.y, hl);
    const k = THREE.MathUtils.smoothstep(dep, THREE.MathUtils.degToRad(68), THREE.MathUtils.degToRad(86));
    cam.up.set(Math.cos(this.upYaw) * k, 1 - k, Math.sin(this.upYaw) * k).normalize();
    this.snap = false;
    cam.position.copy(this.camPos);
    cam.lookAt(this.lookAt);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
    return true;
  }

  /** HUD text, target box and the hot plume / munition uniforms for the picture about to be drawn. */
  private annotate() {
    const f = this.feed!;
    const e = this.r.world.get(f.id);
    if (!e) return;
    const W = this.rect.w;
    const H = this.rect.h;
    const vp = this.vp.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
    const el = vp.elements;
    const locked = f.tgtId >= 0 && this.lookOff.lengthSq() < 0.04;
    // target box: the target's real bounding box, projected with this picture's camera
    const t = f.tgtId >= 0 ? this.r.world.get(f.tgtId) : undefined;
    let shown = false;
    if (t && !t.dead && this.targetBox(t, this.bb)) {
      // keep the tracked centre and the framing on the model as it moves / turns / collapses
      this.bb.getCenter(f.tgtOff).sub(this.r.entityPos(t, this.r.frameAlpha, this.tmp));
      f.tgtExtent = Math.max(this.bb.max.x - this.bb.min.x, this.bb.max.z - this.bb.min.z);
      const b = projectCorners(el, this.corners, W, H);
      if (b && b.x1 > 0 && b.y1 > 0 && b.x0 < W && b.y0 < H) {
        // (a target filling the picture, close under a diving munition: the box frames its visible part)
        const pad = 3;
        const x0 = Math.max(2, b.x0 - pad);
        const y0 = Math.max(2, b.y0 - pad);
        const x1 = Math.min(W - 2, b.x1 + pad);
        const y1 = Math.min(H - 2, b.y1 + pad);
        const bw = Math.max(12, x1 - x0);
        const bh = Math.max(12, y1 - y0);
        const cx = (x0 + x1) / 2;
        const cy = (y0 + y1) / 2;
        this.box.style.width = `${bw.toFixed(1)}px`;
        this.box.style.height = `${bh.toFixed(1)}px`;
        this.box.style.transform = `translate(${(cx - bw / 2).toFixed(1)}px, ${(cy - bh / 2).toFixed(1)}px)`;
        shown = true;
      }
    }
    this.box.style.display = shown ? '' : 'none';
    // solid when locked, dashed and blinking while acquiring
    const acq = !locked || this.time - f.lockAt < 0.8;
    this.box.classList.toggle('lock', shown && !acq);
    this.box.classList.toggle('acq', shown && acq);
    // plumes of recent blasts and the munitions in flight, in picture uv
    const right = this.tmp2.setFromMatrixColumn(this.cam.matrixWorld, 0);
    const uvOf = (x: number, y: number, z: number) => {
      const q = projectPx(el, { x, y, z }, 1, 1);
      return q ? { x: q.x, y: 1 - q.y } : null;
    };
    const radiusUv = (x: number, y: number, z: number, r: number, base: { x: number; y: number }) => {
      const q = uvOf(x + right.x * r, y + right.y * r, z + right.z * r);
      return q ? Math.abs(q.x - base.x) * this.pu.aspect.value : 0;
    };
    this.pu.aspect.value = W / Math.max(1, H);
    const burnA = this.pu.burnA.value;
    const burnB = this.pu.burnB.value;
    for (let i = 0; i < MAX_BURNS; i++) burnB[i].set(0, 0, 0, 0);
    let n = 0;
    for (let i = this.burns.length - 1; i >= 0 && n < MAX_BURNS; i--) {
      const b = this.burns[i];
      const age = this.time - b.t;
      const life = 7 * b.size;
      if (age > life) continue;
      const amp = age < 0.4 ? 1 : Math.exp(-((age - 0.4) / life) * 2.6);
      const rise = (0.25 + Math.min(1, age / 2) * 0.9) * b.size;
      const base = uvOf(b.x, b.y + 0.05, b.z);
      const top = uvOf(b.x + 0.15 * b.size, b.y + rise, b.z - 0.1 * b.size);
      if (!base || !top) continue;
      const rad = radiusUv(b.x, b.y, b.z, 0.22 * b.size, base);
      if (rad <= 0) continue;
      burnA[n].set(base.x, base.y, top.x, top.y);
      burnB[n].set(rad, 0.95 * amp, b.seed, 0);
      n++;
    }
    const mun = this.munitions(f.id);
    const munA = this.pu.munA.value;
    const munB = this.pu.munB.value;
    let tti = -1;
    for (let i = 0; i < MAX_MUN; i++) munB[i].set(0, 0, 0, 0);
    for (let i = 0; i < mun.length; i++) {
      const m = mun[i];
      tti = tti < 0 ? m.tti : Math.min(tti, m.tti);
      if (i >= MAX_MUN) continue;
      const pos = uvOf(m.x, m.z, m.y);
      if (!pos) continue;
      const sp = Math.hypot(m.vx, m.vy, m.vz) || 1;
      const tail = m.bomb ? 0 : 0.45;
      const tl = uvOf(m.x - (m.vx / sp) * tail, m.z - (m.vz / sp) * tail, m.y - (m.vy / sp) * tail) ?? pos;
      const rad = Math.max(0.6 / H, radiusUv(m.x, m.z, m.y, m.bomb ? 0.05 : 0.06, pos));
      munA[i].set(pos.x, pos.y, tl.x, tl.y);
      munB[i].set(rad, m.bomb ? 0.62 : 1, 0, 0);
    }
    // readouts from the same geometry the picture shows
    // (a munition's nose camera flies at its drawn height; its readouts use the same altitude scale as the pods)
    const ground = f.kind === 'kami' ? this.groundUnder(this.camPos) : f.tgtGround;
    const ro = readouts(f.kind === 'kami' ? podPosition(this.camPos, ground, 0) : this.camPos, this.lookAt, ground);
    if (f.kind === 'kami' && f.tgtId >= 0) {
      const sp = Math.hypot(e.x - e.px, e.y - e.py, e.z - e.pz) * TPS;
      if (sp > 0.05) tti = this.camPos.distanceTo(f.tgtPos) / sp;
    }
    this.lastTti = tti;
    const tgt = f.tgtId >= 0;
    const fovTag = f.kind === 'kami' ? 'TERMINAL' : this.footprint > WFOV_ABOVE ? 'WFOV' : 'NFOV';
    // ground speed over the last half second (units hold position on some ticks: no 0 / 200 kt flicker)
    const now = groundSpeedKt(e.x - e.px, e.y - e.py, TPS);
    f.gs = f.gs < 0 ? now : f.gs + (now - f.gs) * smoothK(this.time - f.gsAt, 2);
    f.gsAt = this.time;
    const gs = f.gs;
    this.txtTL.textContent = `${f.kind === 'kami' ? f.callsign : f.title}\nWHT  ${fovTag}`;
    this.txtTR.textContent = `ALT ${fmtAlt(ro.altFt)} FT\nGS ${fmtSpeed(gs)} KT\nHDG ${fmtHdg(facingHeading(e.facing))}`;
    this.txtBL.textContent = tgt ? `TGT ${f.tgtName}\n${f.kind === 'kami' ? 'DIVE' : acq ? 'ACQ' : 'LOCK'}` : 'SCANNING\nTRK';
    this.txtBR.textContent = `RNG ${fmtRange(ro.slantM)} M${tti >= 0 ? `\nTTI ${fmtTti(tti)} S` : ''}`;
    // compass tape: the bearing the sensor looks along; north arrow: where north is in this picture
    this.tape.style.transform = `translateX(${(-((wrapDeg(ro.losHdg) + TAPE_SPAN) / (360 + 2 * TAPE_SPAN)) * 100).toFixed(3)}%)`;
    this.brg.textContent = fmtHdg(ro.losHdg);
    const camR = this.tmp.setFromMatrixColumn(this.cam.matrixWorld, 0);
    const camU = this.tmp2.setFromMatrixColumn(this.cam.matrixWorld, 1);
    this.north.style.transform = `rotate(${northInPicture(camR, camU).toFixed(1)}deg)`;
  }

  private groundUnder(p: THREE.Vector3): number {
    const map = this.r.world.map;
    return standHeight(map, Math.max(0, Math.min(map.w - 0.01, p.x)), Math.max(0, Math.min(map.h - 0.01, p.z)));
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
    const step = dt > 0 ? dt : 1 / 60;
    this.time += step;
    this.choose();
    if (!this.feed || this.collapsed) return;
    const f = this.feed;
    const lost = f.lostAt >= 0;
    this.updateRect();
    if (this.rect.w < 8 || this.rect.h < 8) return;
    const ok = lost ? this.rendered : this.aim(step);
    const gl = this.r.renderer;
    // refresh the feed at a low rate
    this.acc += step;
    if (ok && !lost && this.acc >= 1 / FEED_FPS) {
      this.acc = 0;
      const t0 = performance.now();
      const sh = gl.shadowMap.autoUpdate;
      gl.shadowMap.autoUpdate = false;
      const prev = gl.getRenderTarget();
      // the sensor never sees its own aircraft
      const own = this.r.visuals.get(f.id)?.model.root;
      const ownVis = own?.visible ?? false;
      if (own) own.visible = false;
      gl.setRenderTarget(this.rt);
      gl.render(this.r.scene, this.cam);
      gl.shadowMap.autoUpdate = sh;
      renderHeatMask(gl, this.r.scene, this.cam, this.heat, true);
      if (own) own.visible = ownVis;
      this.annotate();
      this.pu.time.value = this.time;
      gl.setRenderTarget(this.proc);
      this.procQuad.render(gl);
      gl.setRenderTarget(prev);
      this.rendered = true;
      this.lastCostMs = performance.now() - t0;
    }
    // blast flash: white-out from the fireball, then the sensor's gain recovering
    let flash = 0;
    let gain = 1;
    if (this.flashAt >= 0) {
      const ft = this.time - this.flashAt;
      flash = this.flashAmp * Math.exp(-ft * 4.5);
      if (ft > 0.12) gain = 1 - 0.3 * this.flashAmp * Math.exp(-(ft - 0.12) * 1.8);
      const q = projectPx(this.vp.elements, this.flashPos, 1, 1);
      if (q) this.uniforms.flashUv.value.set(q.x, 1 - q.y);
      if (ft > 4) this.flashAt = -1;
    }
    let st = this.rendered ? 0 : 1;
    if (lost) {
      const lt = this.time - f.lostAt;
      if (this.impactLost && lt < WHITEOUT) {
        flash = 1;
        st = 0;
      } else st = 1;
    }
    this.uniforms.flash.value = Math.min(1, flash);
    // the symbology fades back for the munition's last seconds, the blast and its aftermath
    const fl = flash > 0.15 || (this.lastTti >= 0 && this.lastTti < FADE_TTI) || (f.impactAt >= 0 && this.time - f.impactAt < FADE_AFTER);
    if (fl !== this.fading) {
      this.fading = fl;
      this.el.classList.toggle('fade', fl);
    }
    this.uniforms.gain.value = gain;
    this.uniforms.staticAmt.value = st;
    this.uniforms.time.value = this.time;
    this.uniforms.aspect.value = this.rect.w / Math.max(1, this.rect.h);
    // composite into the PiP rectangle of the main canvas
    const auto = gl.autoClear;
    gl.autoClear = false;
    gl.setRenderTarget(null);
    gl.setScissorTest(true);
    gl.setScissor(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    gl.setViewport(this.rect.x, this.rect.y, this.rect.w, this.rect.h);
    this.quad.render(gl);
    gl.setScissorTest(false);
    const size = gl.getSize(this.size2);
    gl.setViewport(0, 0, size.x, size.y);
    gl.autoClear = auto;
  }

  dispose() {
    this.el.remove();
    this.rt.depthTexture?.dispose();
    this.rt.dispose();
    this.heat.dispose();
    this.proc.dispose();
    this.quad.dispose();
    this.procQuad.dispose();
    (this.quad as unknown as { material: THREE.Material }).material?.dispose();
    (this.procQuad as unknown as { material: THREE.Material }).material?.dispose();
  }
}
