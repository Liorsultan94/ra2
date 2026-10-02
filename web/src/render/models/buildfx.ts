import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import type { AnimState, Model, Region } from './types';

/*
 * Construction and battle-damage visuals for the detailed buildings.
 *
 * Finished, undamaged buildings are untouched: they keep the shared template
 * materials and geometry and `BuildFx.update` returns after two compares.
 *
 * While a building is under construction (built < 1) or damaged
 * (damage >= 0.2) the instance switches every mesh to a per-instance clone of
 * its material. The clones run the same shader plus a small patch driven by
 * per-instance uniforms (shared by all clones of one instance):
 *  - bxClip:  building-space height above which fragments are discarded (the
 *             structure rises in horizontal slices, foundation slab first)
 *  - bxR/bxP: up to four "bites" (rect in xz + sloped top plane + ragged noise)
 *             that remove roof panels (holes), a parapet section and, at high
 *             damage, a collapsed corner; the area inside a bite is charred
 *  - bxSoot:  scorch blotches over the whole structure
 * Clones are DoubleSide so the interior shows through cuts, and a matching
 * per-instance depth material keeps shadows consistent with the cuts.
 *
 * Extra geometry (scaffolding, a small crane, welding sparks, soot / crack /
 * broken window decals, exposed beams, rubble piles) is generated lazily per
 * template from a heightfield of the template geometry, shared by all
 * instances (clones share geometry and materials), and attached to an
 * instance only while needed.
 */

export type DamageFx = NonNullable<Model['damageFx']>[number];
export type NightLight = { pos: THREE.Vector3; color: number; intensity: number };

/** Model with the optional building extras (until types.ts carries them). */
export interface FxModel extends Model {
  /** Local-space damage emitters: emit `kind` while damage >= at. Positions update in place (per-instance variant). */
  damageFx?: DamageFx[];
  /** Local-space lamp positions for a future night mode (shared, read-only). */
  nightLights?: NightLight[];
}

/** Records collected by the building kit while a template is assembled (building space). */
export interface FxRec {
  /** Axis-aligned wall boxes: x0,y0,z0,x1,y1,z1 per entry. */
  walls: number[];
  /** Window panes: cx, y0, cz, nx, nz, w, h per entry (horizontal facing only). */
  wins: number[];
  /** Lamps: x, y, z, r, g, b per entry. */
  lamps: number[];
  /** Blinking aviation lights: x, y, z. */
  blinks: number[];
  /** Electrical equipment (transformers): x, y, z. */
  elec: number[];
}
export const newRec = (): FxRec => ({ walls: [], wins: [], lamps: [], blinks: [], elec: [] });

type Mat = THREE.Material;
const Y0 = 0.04;
const CS = 0.05; // heightfield cell size
const LH = 0.1; // scaffold lift height
const D_ON = 0.2; // damage at which an instance switches to its own materials
const D_OFF = 0.15;
const TIER = [0.25, 0.45, 0.65, 0.8];
const CUT_AT = [0.45, 0.55, 0.65, 0.8]; // hole1, parapet, hole2, corner

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Cheap deterministic hash -> [0,1). */
function h01(a: number, b = 0) {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ================================================================ shared materials

const fogMats = new WeakMap<object, Map<string, Mat>>();
const NOFOG = {};
function shared<T extends Mat>(fog: FogOfWar | null, key: string, make: () => T): T {
  const fk = fog ?? NOFOG;
  let m = fogMats.get(fk);
  if (!m) {
    m = new Map();
    fogMats.set(fk, m);
  }
  let mat = m.get(key) as T | undefined;
  if (!mat) {
    mat = make();
    if (fog) fog.apply(mat);
    m.set(key, mat);
  }
  return mat;
}
const vcMat = (fog: FogOfWar | null) => shared(fog, 'vc', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, metalness: 0.15 }));
const metalMat = (fog: FogOfWar | null) => shared(fog, 'metal', () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.6 }));
const netMat = (fog: FogOfWar | null) =>
  shared(fog, 'net', () => {
    const m = new THREE.MeshStandardMaterial({ map: netTex(), vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide, roughness: 0.9, metalness: 0 });
    return m;
  });
const decalMat = (fog: FogOfWar | null) =>
  shared(fog, 'decal', () => {
    const m = new THREE.MeshStandardMaterial({ map: atlasTex(), transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 1, metalness: 0 });
    return m;
  });
let sparkMatC: THREE.PointsMaterial | null = null;
function sparkMat() {
  if (!sparkMatC) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const c = cv.getContext('2d')!;
    const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.35, 'rgba(255,230,160,0.9)');
    g.addColorStop(1, 'rgba(255,140,40,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 32, 32);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    sparkMatC = new THREE.PointsMaterial({ size: 5, map: t, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, sizeAttenuation: true });
  }
  return sparkMatC;
}

let glassMatC: THREE.PointsMaterial | null = null;
/** Additive glints for falling glass shards. */
function glassMat() {
  if (!glassMatC) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 32;
    const c = cv.getContext('2d')!;
    // a small four point star: reads as a glint, not a spark
    const g = c.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.25, 'rgba(210,235,255,0.6)');
    g.addColorStop(1, 'rgba(160,200,255,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, 32, 32);
    c.fillStyle = 'rgba(255,255,255,0.8)';
    c.fillRect(15, 2, 2, 28);
    c.fillRect(2, 15, 28, 2);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace;
    glassMatC = new THREE.PointsMaterial({ size: 4, map: t, vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, sizeAttenuation: true });
  }
  return glassMatC;
}

let netTexC: THREE.Texture | null = null;
function netTex() {
  if (netTexC) return netTexC;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 32;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, 32, 32);
  c.fillStyle = 'rgba(255,255,255,0.55)';
  c.fillRect(0, 0, 32, 32);
  c.fillStyle = 'rgba(255,255,255,0.95)';
  for (let i = 0; i < 32; i += 4) {
    c.fillRect(i, 0, 1, 32);
    c.fillRect(0, i, 32, 1);
  }
  netTexC = new THREE.CanvasTexture(cv);
  netTexC.wrapS = netTexC.wrapT = THREE.RepeatWrapping;
  netTexC.colorSpace = THREE.SRGBColorSpace;
  return netTexC;
}

/** 2x2 decal atlas: 0 soot streak, 1 crack, 2 broken window, 3 scorch. */
let atlasC: THREE.Texture | null = null;
function atlasTex() {
  if (atlasC) return atlasC;
  const S = 256;
  const T = S / 2;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const c = cv.getContext('2d')!;
  c.clearRect(0, 0, S, S);
  const r = rng(77);
  // tile 0 (u 0-.5, v .5-1 => canvas top-left): soot streak, dense at the bottom, streaky upwards
  c.save();
  c.beginPath();
  c.rect(0, 0, T, T);
  c.clip();
  for (let i = 0; i < 46; i++) {
    const x = T * 0.5 + (r() - 0.5) * T * 0.75 * (0.4 + r() * 0.6);
    const w = 4 + r() * 14;
    const top = T * (0.05 + r() * 0.5);
    const g = c.createLinearGradient(0, T, 0, top);
    const a = 0.16 + r() * 0.2;
    g.addColorStop(0, `rgba(12,10,9,${a * 1.6})`);
    g.addColorStop(0.5, `rgba(18,16,14,${a})`);
    g.addColorStop(1, 'rgba(20,18,16,0)');
    c.fillStyle = g;
    c.beginPath();
    c.moveTo(x - w, T);
    c.quadraticCurveTo(x - w * 0.3, (T + top) / 2, x + (r() - 0.5) * 10, top);
    c.quadraticCurveTo(x + w * 0.3, (T + top) / 2, x + w, T);
    c.fill();
  }
  c.restore();
  // tile 1 (u .5-1, v .5-1): branching cracks
  c.save();
  c.translate(T, 0);
  c.beginPath();
  c.rect(0, 0, T, T);
  c.clip();
  c.strokeStyle = 'rgba(16,14,12,0.95)';
  c.lineCap = 'round';
  const crack = (x: number, y: number, a: number, len: number, wdt: number, depth: number) => {
    let px = x;
    let py = y;
    const n = 6;
    for (let i = 0; i < n; i++) {
      a += (r() - 0.5) * 0.9;
      const nx = px + Math.cos(a) * (len / n);
      const ny = py + Math.sin(a) * (len / n);
      c.lineWidth = wdt * (1 - i / (n + 1));
      c.beginPath();
      c.moveTo(px, py);
      c.lineTo(nx, ny);
      c.stroke();
      if (depth > 0 && r() < 0.35) crack(nx, ny, a + (r() > 0.5 ? 0.8 : -0.8), len * 0.45, wdt * 0.6, depth - 1);
      px = nx;
      py = ny;
    }
  };
  for (let i = 0; i < 4; i++) crack(T / 2, T / 2, (i / 4) * Math.PI * 2 + r(), T * 0.48, 4, 2);
  c.restore();
  // tile 2 (u 0-.5, v 0-.5): broken window: dark void, jagged glass shards on the rim
  c.save();
  c.translate(0, T);
  c.fillStyle = 'rgba(8,8,9,0.96)';
  c.beginPath();
  const pts = 18;
  for (let i = 0; i <= pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const rr = T * (0.36 + r() * 0.14);
    const x = T / 2 + Math.cos(a) * rr * 1.15;
    const y = T / 2 + Math.sin(a) * rr * 1.15;
    if (i === 0) c.moveTo(x, y);
    else c.lineTo(x, y);
  }
  c.fill();
  c.fillStyle = 'rgba(150,170,185,0.55)';
  for (let i = 0; i < 9; i++) {
    const x = r() * T;
    const y = r() < 0.5 ? r() * T * 0.2 : T - r() * T * 0.2;
    c.beginPath();
    c.moveTo(x, y);
    c.lineTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30);
    c.lineTo(x + (r() - 0.5) * 30, y + (r() - 0.5) * 30);
    c.fill();
  }
  c.restore();
  // tile 3 (u .5-1, v 0-.5): scorch blotch
  c.save();
  c.translate(T, T);
  for (let i = 0; i < 14; i++) {
    const x = T / 2 + (r() - 0.5) * T * 0.35;
    const y = T / 2 + (r() - 0.5) * T * 0.35;
    const rad = T * (0.18 + r() * 0.25);
    const g = c.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, 'rgba(10,9,8,0.55)');
    g.addColorStop(1, 'rgba(10,9,8,0)');
    c.fillStyle = g;
    c.fillRect(0, 0, T, T);
  }
  c.restore();
  atlasC = new THREE.CanvasTexture(cv);
  atlasC.colorSpace = THREE.SRGBColorSpace;
  atlasC.anisotropy = 4;
  return atlasC;
}
const TILE: [number, number][] = [
  [0, 0.5],
  [0.5, 0.5],
  [0, 0],
  [0.5, 0],
];

// ================================================================ geometry bins

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);

/** Collects primitives per (node, material) and merges them into meshes. */
class Bins {
  private bins = new Map<THREE.Object3D, Map<Mat, THREE.BufferGeometry[]>>();
  cur: THREE.Object3D;
  constructor(readonly root: THREE.Object3D) {
    this.cur = root;
  }
  add(g: THREE.BufferGeometry, m: Mat, color: number) {
    let geo = g.index ? g.toNonIndexed() : g;
    if (geo !== g) g.dispose();
    for (const n of Object.keys(geo.attributes)) if (n !== 'position' && n !== 'normal' && n !== 'uv') geo.deleteAttribute(n);
    if (!geo.attributes.normal) geo.computeVertexNormals();
    if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count * 2), 2));
    const n = geo.attributes.position.count;
    const col = new Float32Array(n * 3);
    _c.setHex(color);
    for (let i = 0; i < n; i++) {
      col[i * 3] = _c.r;
      col[i * 3 + 1] = _c.g;
      col[i * 3 + 2] = _c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    let bin = this.bins.get(this.cur);
    if (!bin) {
      bin = new Map();
      this.bins.set(this.cur, bin);
    }
    let l = bin.get(m);
    if (!l) {
      l = [];
      bin.set(m, l);
    }
    l.push(geo);
    geo = null as unknown as THREE.BufferGeometry;
  }
  /** Box centred at (x,y,z), rotated (YXZ). */
  box(m: Mat, color: number, w: number, h: number, d: number, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    const g = new THREE.BoxGeometry(w, h, d);
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz, 'YXZ')), _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    this.add(g, m, color);
  }
  /** Square bar between two points. */
  bar(m: Mat, color: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, t: number) {
    const dx = bx - ax;
    const dy = by - ay;
    const dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-5) return;
    const g = new THREE.BoxGeometry(t, len, t);
    _q.setFromUnitVectors(UP, _p.set(dx / len, dy / len, dz / len));
    _m.compose(_p.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    this.add(g, m, color);
  }
  /** Irregular rubble chunk. */
  chunk(m: Mat, color: number, x: number, y: number, z: number, sx: number, sy: number, sz: number, r: () => number) {
    const g = r() < 0.6 ? new THREE.IcosahedronGeometry(0.5, 0) : new THREE.BoxGeometry(1, 1, 1);
    _m.compose(_p.set(x, y, z), _q.setFromEuler(_e.set(r() * 3, r() * 6.3, r() * 3)), _s.set(sx, sy, sz));
    g.applyMatrix4(_m);
    this.add(g, m, color);
  }
  /** Quad from four corners (counter-clockwise seen from the front) with an atlas tile. */
  quad(m: Mat, p: number[], tile: number, flip = false, u0 = 0, u1 = 1, v0 = 0, v1 = 1) {
    const [tu, tv] = TILE[tile];
    const a = tu + (flip ? u1 : u0) * 0.5;
    const b = tu + (flip ? u0 : u1) * 0.5;
    const c0 = tv + v0 * 0.5;
    const c1 = tv + v1 * 0.5;
    const g = new THREE.BufferGeometry();
    const P = new Float32Array([p[0], p[1], p[2], p[3], p[4], p[5], p[6], p[7], p[8], p[0], p[1], p[2], p[6], p[7], p[8], p[9], p[10], p[11]]);
    const U = new Float32Array([a, c0, b, c0, b, c1, a, c0, b, c1, a, c1]);
    g.setAttribute('position', new THREE.BufferAttribute(P, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
    g.computeVertexNormals();
    this.add(g, m, 0xffffff);
  }
  /** Vertical decal facing (nx,0,nz), centred horizontally on (x,z), from y0 up by h. */
  vdecal(m: Mat, nx: number, nz: number, x: number, y0: number, z: number, w: number, h: number, tile: number, flip = false) {
    const rx = nz * (w / 2);
    const rz = -nx * (w / 2);
    this.quad(m, [x - rx, y0, z - rz, x + rx, y0, z + rz, x + rx, y0 + h, z + rz, x - rx, y0 + h, z - rz], tile, flip);
  }
  finish(castShadow = true) {
    for (const [obj, bin] of this.bins) {
      for (const [m, list] of bin) {
        const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
        if (!geo) continue;
        if (list.length > 1) for (const g of list) g.dispose();
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, m);
        mesh.castShadow = castShadow && !m.transparent;
        mesh.receiveShadow = !m.transparent;
        obj.add(mesh);
      }
    }
    this.bins.clear();
  }
}

// ================================================================ template analysis

interface Comp {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  h: number;
}
interface Hole {
  x: number;
  z: number;
  y: number;
  hx: number;
  hz: number;
  gx: number;
  gz: number;
}
interface Corner {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  cx: number;
  cz: number;
  sx: number;
  sz: number;
  lo: number;
  hi: number;
  a: number;
  b: number;
  c: number;
}
interface Notch {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  y: number;
  nx: number;
  nz: number;
}
interface Plan {
  seed: number;
  holes: (Hole | null)[];
  notch: Notch | null;
  corner: Corner | null;
  /** 4 cuts: rect x0,z0,x1,z1 and plane a,b,c,noise (8 numbers each, NaN = none). */
  cuts: Float32Array;
  fx: number[]; // x,y,z per damageFx slot
}
interface Analysis {
  maxY: number;
  lut: Float32Array;
  comps: Comp[];
  H: Float32Array;
  nx: number;
  nz: number;
  plans: Plan[];
}

/** damageFx slots (fixed layout so variants can be swapped in place). */
const FX_SLOTS: { kind: DamageFx['kind']; at: number }[] = [
  { kind: 'smoke', at: 0.3 },
  { kind: 'spark', at: 0.5 },
  { kind: 'fire', at: 0.6 },
  { kind: 'smoke', at: 0.55 },
  { kind: 'fire', at: 0.8 },
  { kind: 'smoke', at: 0.85 },
];
const VARIANTS = 3;

export interface FxInfo {
  key: string;
  w: number;
  d: number;
  height: number;
  region: Region;
  fog: FogOfWar | null;
  seed: number;
}

/** Per-template construction / damage data (lazily analysed, shared by all instances). */
export class FxTpl {
  readonly night: NightLight[];
  private an: Analysis | null = null;
  private scaf: THREE.Group | null = null;
  private scafLifts = 0;
  private ovl = new Map<number, THREE.Group>();
  constructor(
    readonly root: THREE.Group,
    readonly rec: FxRec,
    readonly info: FxInfo,
  ) {
    this.night = nightLights(rec, info);
  }

  get analysis(): Analysis {
    if (!this.an) this.an = analyse(this.root, this.rec, this.info);
    return this.an;
  }

  /** Scaffolding (+ crane) group template; lift i is the child named 'lift'+i. */
  scaffold(): { group: THREE.Group; lifts: number } {
    if (!this.scaf) {
      const r = buildScaffold(this.analysis, this.info);
      this.scaf = r.group;
      this.scafLifts = r.lifts;
    }
    return { group: this.scaf, lifts: this.scafLifts };
  }

  /** Damage overlay geometry for (variant, tier). */
  overlay(v: number, tier: number): THREE.Group {
    const k = v * 8 + tier;
    let g = this.ovl.get(k);
    if (!g) {
      g = buildOverlay(this.analysis, this.rec, this.info, v, tier);
      this.ovl.set(k, g);
    }
    return g;
  }
}

function nightLights(rec: FxRec, info: FxInfo): NightLight[] {
  const out: NightLight[] = [];
  const L = rec.lamps;
  for (let i = 0; i < L.length; i += 6) {
    const x = L[i];
    const y = L[i + 1];
    const z = L[i + 2];
    let dup = false;
    for (const o of out)
      if (Math.abs(o.pos.x - x) < 0.07 && Math.abs(o.pos.y - y) < 0.07 && Math.abs(o.pos.z - z) < 0.07) {
        dup = true;
        break;
      }
    if (dup) continue;
    const mx = Math.max(L[i + 3], L[i + 4], L[i + 5], 1e-3);
    const col = new THREE.Color(L[i + 3] / mx, L[i + 4] / mx, L[i + 5] / mx).getHex();
    const intensity = y > 0.3 ? 1 : y > 0.1 ? 0.5 : 0.25;
    out.push({ pos: new THREE.Vector3(x, y, z), color: col, intensity });
  }
  for (let i = 0; i < rec.blinks.length; i += 3) out.push({ pos: new THREE.Vector3(rec.blinks[i], rec.blinks[i + 1], rec.blinks[i + 2]), color: 0xff3020, intensity: 0.3 });
  // perimeter floodlights on the visible corners not already lit by a pole
  const { w, d } = info;
  const small = w * d <= 1;
  const corners: [number, number][] = small ? [[1, 1]] : [[1, 1], [-1, 1], [1, -1]];
  for (const [sx, sz] of corners) {
    const x = sx * (w / 2 - 0.08);
    const z = sz * (d / 2 - 0.08);
    if (out.some((o) => o.intensity >= 1 && Math.hypot(o.pos.x - x, o.pos.z - z) < 0.7)) continue;
    out.push({ pos: new THREE.Vector3(x, small ? 0.22 : 0.32, z), color: 0xf2f4ff, intensity: small ? 0.5 : 0.8 });
  }
  // keep the most important ones (bright first)
  out.sort((a, b) => b.intensity - a.intensity);
  return out.slice(0, 32);
}

function analyse(root: THREE.Group, rec: FxRec, info: FxInfo): Analysis {
  const { w, d } = info;
  const nx = Math.ceil(w / CS);
  const nz = Math.ceil(d / CS);
  const ox = -w / 2;
  const oz = -d / 2;
  const H = new Float32Array(nx * nz);
  const NB = 64;
  // every mesh (animated parts too, in their rest pose) in building space
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes: { pos: Float32Array; glow: boolean }[] = [];
  const tmp = new THREE.Vector3();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const src = mesh.geometry.attributes.position;
    const pos = new Float32Array(src.count * 3);
    const m = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
    for (let i = 0; i < src.count; i++) {
      tmp.fromBufferAttribute(src, i).applyMatrix4(m);
      pos[i * 3] = tmp.x;
      pos[i * 3 + 1] = tmp.y;
      pos[i * 3 + 2] = tmp.z;
    }
    meshes.push({ pos, glow: !!(mesh.material as THREE.Material).userData?.baseEI });
  });
  let rootMaxY = 0;
  for (const m of meshes) for (let i = 1; i < m.pos.length; i += 3) if (m.pos[i] > rootMaxY) rootMaxY = m.pos[i];
  const maxY = Math.max(info.height, rootMaxY);
  const span = Math.max(0.05, rootMaxY - Y0);
  const hist = new Float32Array(NB);
  const mark = (x0: number, x1: number, z0: number, z1: number, y: number) => {
    const i0 = Math.max(0, Math.floor((x0 - ox) / CS));
    const i1 = Math.min(nx - 1, Math.floor((x1 - ox) / CS));
    const j0 = Math.max(0, Math.floor((z0 - oz) / CS));
    const j1 = Math.min(nz - 1, Math.floor((z1 - oz) / CS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) if (H[j * nx + i] < y) H[j * nx + i] = y;
  };
  for (const { pos: p, glow } of meshes) {
    for (let i = 0; i + 8 < p.length; i += 9) {
      const ax = p[i];
      const ay = p[i + 1];
      const az = p[i + 2];
      const bx = p[i + 3];
      const by = p[i + 4];
      const bz = p[i + 5];
      const cx = p[i + 6];
      const cy = p[i + 7];
      const cz = p[i + 8];
      const y1 = Math.max(ay, by, cy);
      const y0 = Math.max(Y0, Math.min(ay, by, cy));
      // surface area per height drives the construction pace
      if (y1 > Y0 + 0.003) {
        const ux = bx - ax;
        const uy = by - ay;
        const uz = bz - az;
        const vx = cx - ax;
        const vy = cy - ay;
        const vz = cz - az;
        const area = 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
        const b0 = clamp(Math.floor(((y0 - Y0) / span) * NB), 0, NB - 1);
        const b1 = clamp(Math.floor(((y1 - Y0) / span) * NB), 0, NB - 1);
        const per = area / (b1 - b0 + 1);
        for (let b = b0; b <= b1; b++) hist[b] += per;
      }
      if (glow || y1 < 0.06) continue;
      const mnx = Math.min(ax, bx, cx);
      const mxx = Math.max(ax, bx, cx);
      const mnz = Math.min(az, bz, cz);
      const mxz = Math.max(az, bz, cz);
      const det = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
      if (Math.abs(det) < CS * CS * 0.05) {
        mark(mnx, mxx, mnz, mxz, y1);
        continue;
      }
      const i0 = Math.max(0, Math.ceil((mnx - ox) / CS - 0.5));
      const i1 = Math.min(nx - 1, Math.floor((mxx - ox) / CS - 0.5));
      const j0 = Math.max(0, Math.ceil((mnz - oz) / CS - 0.5));
      const j1 = Math.min(nz - 1, Math.floor((mxz - oz) / CS - 0.5));
      for (let j = j0; j <= j1; j++) {
        const pz = oz + (j + 0.5) * CS;
        for (let ii = i0; ii <= i1; ii++) {
          const px = ox + (ii + 0.5) * CS;
          const l1 = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / det;
          const l2 = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / det;
          const l3 = 1 - l1 - l2;
          if (l1 < -1e-4 || l2 < -1e-4 || l3 < -1e-4) continue;
          const y = l1 * ay + l2 * by + l3 * cy;
          const k = j * nx + ii;
          if (H[k] < y) H[k] = y;
        }
      }
    }
  }
  // construction pace: inverse CDF of surface area over height (blended with linear)
  let tot = 0;
  for (let b = 0; b < NB; b++) tot += hist[b];
  const lut = new Float32Array(33);
  let acc = 0;
  let b = 0;
  for (let k = 0; k <= 32; k++) {
    const target = (k / 32) * tot;
    while (b < NB && acc + hist[b] < target) acc += hist[b++];
    const frac = b < NB && hist[b] > 0 ? (target - acc) / hist[b] : 0;
    const yc = Y0 + ((Math.min(b, NB) + clamp(frac, 0, 1)) / NB) * span;
    lut[k] = 0.5 * yc + 0.5 * (Y0 + (k / 32) * span);
  }
  lut[32] = rootMaxY + 0.01;
  const comps = components(H, nx, nz, ox, oz, info);
  const plans: Plan[] = [];
  for (let v = 0; v < VARIANTS; v++) plans.push(plan(H, nx, nz, ox, oz, comps, rec, info, v));
  return { maxY, lut, comps, H, nx, nz, plans };
}

function components(H: Float32Array, nx: number, nz: number, ox: number, oz: number, info: FxInfo): Comp[] {
  const T = 0.15;
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= nz ? 0 : H[j * nx + i]);
  // structural mass: tall cells whose 4 neighbours are tall too (drops poles, fences, thin parts)
  const mass = new Uint8Array(nx * nz);
  for (let j = 0; j < nz; j++)
    for (let i = 0; i < nx; i++)
      if (at(i, j) >= T && at(i - 1, j) >= T && at(i + 1, j) >= T && at(i, j - 1) >= T && at(i, j + 1) >= T) mass[j * nx + i] = 1;
  // decompose into rectangles: repeatedly take the largest all-mass rectangle
  const out: (Comp & { score: number })[] = [];
  const hist = new Int32Array(nx);
  const stack = new Int32Array(nx + 1);
  for (let it = 0; it < 5; it++) {
    hist.fill(0);
    let best = 0;
    let bi0 = 0;
    let bi1 = 0;
    let bj0 = 0;
    let bj1 = 0;
    for (let j = 0; j < nz; j++) {
      for (let i = 0; i < nx; i++) hist[i] = mass[j * nx + i] ? hist[i] + 1 : 0;
      let sp = 0;
      for (let i = 0; i <= nx; i++) {
        const hh = i < nx ? hist[i] : 0;
        while (sp > 0 && hist[stack[sp - 1]] >= hh) {
          const top = stack[--sp];
          const height = hist[top];
          const left = sp > 0 ? stack[sp - 1] + 1 : 0;
          const area = height * (i - left);
          if (area > best) {
            best = area;
            bi0 = left;
            bi1 = i - 1;
            bj0 = j - height + 1;
            bj1 = j;
          }
        }
        stack[sp++] = i;
      }
    }
    if (best < 12 || (it > 0 && best < 20)) break;
    const hs: number[] = [];
    for (let j = bj0; j <= bj1; j++)
      for (let i = bi0; i <= bi1; i++) {
        hs.push(H[j * nx + i]);
        mass[j * nx + i] = 0;
      }
    hs.sort((x, y) => x - y);
    const h = hs[Math.floor(hs.length * 0.75)];
    const c: Comp = {
      x0: Math.max(ox + (bi0 - 1) * CS, -info.w / 2 + 0.02),
      x1: Math.min(ox + (bi1 + 2) * CS, info.w / 2 - 0.02),
      z0: Math.max(oz + (bj0 - 1) * CS, -info.d / 2 + 0.02),
      z1: Math.min(oz + (bj1 + 2) * CS, info.d / 2 - 0.02),
      h,
    };
    out.push({ ...c, score: best * CS * CS * (h - Y0) });
  }
  out.sort((x, y) => y.score - x.score);
  if (!out.length) {
    const m = Math.min(info.w, info.d) * 0.3;
    out.push({ x0: -m, x1: m, z0: -m, z1: m, h: Math.max(0.2, info.height * 0.45), score: 0 });
  }
  return out.slice(0, 4).map(({ x0, x1, z0, z1, h }) => ({ x0, x1, z0, z1, h }));
}

function heightAt(an: { H: Float32Array; nx: number; nz: number }, info: FxInfo, x: number, z: number) {
  const i = Math.floor((x + info.w / 2) / CS);
  const j = Math.floor((z + info.d / 2) / CS);
  if (i < 0 || j < 0 || i >= an.nx || j >= an.nz) return 0;
  return an.H[j * an.nx + i];
}

function plan(H: Float32Array, nx: number, nz: number, ox: number, oz: number, comps: Comp[], rec: FxRec, info: FxInfo, v: number): Plan {
  const r = rng(info.seed * 31 + v * 7919 + 17);
  const at = (i: number, j: number) => H[clamp(j, 0, nz - 1) * nx + clamp(i, 0, nx - 1)];
  // flat-ish roof cells (smooth 5x5 neighbourhood, high on its component)
  const cand = (c: Comp) => {
    const out: Hole[] = [];
    const i0 = Math.ceil((c.x0 - ox) / CS) + 2;
    const i1 = Math.floor((c.x1 - ox) / CS) - 3;
    const j0 = Math.ceil((c.z0 - oz) / CS) + 2;
    const j1 = Math.floor((c.z1 - oz) / CS) - 3;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const h = at(i, j);
        if (h < Y0 + (c.h - Y0) * 0.7) continue;
        const gx = (at(i + 2, j) - at(i - 2, j)) / (4 * CS);
        const gz = (at(i, j + 2) - at(i, j - 2)) / (4 * CS);
        if (Math.abs(gx) > 1.4 || Math.abs(gz) > 1.4) continue;
        const flat = (R: number) => {
          for (let dj = -R; dj <= R; dj++)
            for (let di = -R; di <= R; di++) if (Math.abs(at(i + di, j + dj) - (h + gx * di * CS + gz * dj * CS)) > 0.018) return false;
          return true;
        };
        if (!flat(2)) continue;
        const big = flat(3) ? 0.035 : 0;
        out.push({ x: ox + (i + 0.5) * CS, z: oz + (j + 0.5) * CS, y: h, hx: 0.065 + big + r() * 0.03, hz: 0.065 + big + r() * 0.03, gx, gz });
      }
    return out;
  };
  const c0 = comps[0];
  const c1 = comps[1] ?? comps[0];
  const ca = cand(c0);
  const cb = c1 === c0 ? ca : cand(c1);
  const pick = (l: Hole[], avoid?: Hole | null) => {
    let ok = avoid ? l.filter((h) => Math.hypot(h.x - avoid.x, h.z - avoid.z) > 0.3) : l;
    // prefer the bigger openings
    const big = ok.filter((h) => h.hx > 0.095 || h.hz > 0.095);
    if (big.length && r() < 0.75) ok = big;
    return ok.length ? ok[Math.floor(r() * ok.length)] : null;
  };
  const hole1 = pick(ca);
  const hole2 = pick(cb.length ? cb : ca, hole1);
  // parapet / eave section on a visible face of the main block
  let notch: Notch | null = null;
  {
    const hf = { H, nx, nz };
    for (let tries = 0; tries < 6 && !notch; tries++) {
      const alongX = (v + tries + (r() > 0.5 ? 1 : 0)) % 2 === 0;
      const L = Math.min(0.22, (alongX ? c0.x1 - c0.x0 : c0.z1 - c0.z0) * 0.4);
      if (L < 0.08) continue;
      const a0 = (alongX ? c0.x0 : c0.z0) + L / 2 + 0.04 + r() * Math.max(0, (alongX ? c0.x1 - c0.x0 : c0.z1 - c0.z0) - L - 0.08);
      // the edge must be a straight, roughly level wall top along the whole section
      let lo = 1e9;
      let hi = -1e9;
      for (let k = 0; k <= 4; k++) {
        const t = a0 - L / 2 + (L * k) / 4;
        const y = alongX ? heightAt(hf, info, t, c0.z1 - 0.08) : heightAt(hf, info, c0.x1 - 0.08, t);
        lo = Math.min(lo, y);
        hi = Math.max(hi, y);
      }
      if (lo < Y0 + 0.15 || hi - lo > 0.06) continue;
      const y = lo - 0.07;
      notch = alongX
        ? { x0: a0 - L / 2, x1: a0 + L / 2, z0: c0.z1 - 0.12, z1: c0.z1 + 0.08, y, nx: 0, nz: 1 }
        : { x0: c0.x1 - 0.12, x1: c0.x1 + 0.08, z0: a0 - L / 2, z1: a0 + L / 2, y, nx: 1, nz: 0 };
    }
  }
  // collapsed corner of the main block
  const CORN: [number, number][] = [
    [1, 1],
    [1, -1],
    [-1, 1],
  ];
  const [sx, sz] = CORN[v % 3];
  const W = c0.x1 - c0.x0;
  const D = c0.z1 - c0.z0;
  const ex = clamp(W * 0.42, 0.14, 0.6);
  const ez = clamp(D * 0.42, 0.14, 0.6);
  const cx = sx > 0 ? c0.x1 + 0.06 : c0.x0 - 0.06;
  const cz = sz > 0 ? c0.z1 + 0.06 : c0.z0 - 0.06;
  const hc = Math.max(0.12, c0.h - Y0);
  const lo = Y0 + hc * 0.1;
  const hi = Y0 + hc * 0.95;
  const kx = ((hi - lo) / (ex + 0.06)) * 0.62;
  const kz = ((hi - lo) / (ez + 0.06)) * 0.62;
  // top = lo + kx*|x-cx| + kz*|z-cz| (|x-cx| = -sx*(x-cx) inside the rect)
  const corner: Corner = {
    x0: sx > 0 ? cx - ex - 0.06 : cx,
    x1: sx > 0 ? cx : cx + ex + 0.06,
    z0: sz > 0 ? cz - ez - 0.06 : cz,
    z1: sz > 0 ? cz : cz + ez + 0.06,
    cx,
    cz,
    sx: ex,
    sz: ez,
    lo,
    hi,
    a: lo + sx * kx * cx + sz * kz * cz,
    b: -sx * kx,
    c: -sz * kz,
  };
  const cuts = new Float32Array(32).fill(NaN);
  const setCut = (k: number, x0: number, z0: number, x1: number, z1: number, a: number, b: number, c: number, n: number) => cuts.set([x0, z0, x1, z1, a, b, c, n], k * 8);
  const holeCut = (k: number, h: Hole | null) => {
    if (h) setCut(k, h.x - h.hx, h.z - h.hz, h.x + h.hx, h.z + h.hz, h.y - 0.032 - h.gx * h.x - h.gz * h.z, h.gx, h.gz, 0.014);
  };
  holeCut(0, hole1);
  if (notch) setCut(1, notch.x0, notch.z0, notch.x1, notch.z1, notch.y, 0, 0, 0.022);
  holeCut(2, hole2);
  setCut(3, corner.x0, corner.z0, corner.x1, corner.z1, corner.a, corner.b, corner.c, 0.03);
  // damage emitters
  const top = (c: Comp) => [(c.x0 + c.x1) / 2, heightAt({ H, nx, nz }, info, (c.x0 + c.x1) / 2, (c.z0 + c.z1) / 2) + 0.02, (c.z0 + c.z1) / 2];
  const p1 = hole1 ? [hole1.x, hole1.y, hole1.z] : top(c0);
  const p2 = hole2 ? [hole2.x, hole2.y, hole2.z] : c1 !== c0 ? top(c1) : [p1[0] + 0.1, p1[1], p1[2] - 0.1];
  let sp: number[];
  if (rec.elec.length) {
    const k = Math.floor(r() * (rec.elec.length / 3)) * 3;
    sp = [rec.elec[k], rec.elec[k + 1] + 0.12, rec.elec[k + 2]];
  } else if (notch) sp = [(notch.x0 + notch.x1) / 2, notch.y + 0.02, (notch.z0 + notch.z1) / 2];
  else sp = [c0.x1, (Y0 + c0.h) / 2, (c0.z0 + c0.z1) / 2];
  const ix = sx > 0 ? c0.x1 - ex * 0.45 : c0.x0 + ex * 0.45;
  const iz = sz > 0 ? c0.z1 - ez * 0.45 : c0.z0 + ez * 0.45;
  const pc = [ix, Y0 + hc * 0.45, iz];
  const pr = [sx > 0 ? c0.x1 : c0.x0, Y0 + 0.06, sz > 0 ? c0.z1 : c0.z0];
  const fx = [...p1, ...sp, ...p1, ...p2, ...pc, ...pr];
  return { seed: info.seed * 13 + v * 101, holes: [hole1, hole2], notch, corner, cuts, fx };
}

// ================================================================ scaffolding / crane

const SCAF_STEEL = 0x9aa1a8;
const PLANK = 0x9a7444;
const NET: Record<Region, number> = { west: 0x3c7a4c, east: 0x4c6e3a, asia: 0x2f62a8, mideast: 0x3c7a4c };
const CRANE: Record<Region, number> = { west: 0xe2ad1a, east: 0xd2661e, asia: 0xe2ad1a, mideast: 0xe2ad1a };

function buildScaffold(an: Analysis, info: FxInfo): { group: THREE.Group; lifts: number } {
  const group = new THREE.Group();
  group.name = 'scaffold';
  const fog = info.fog;
  const vc = vcMat(fog);
  const net = netMat(fog);
  const B = new Bins(group);
  const r = rng(info.seed + 5);
  const lifts: THREE.Object3D[] = [];
  const lift = (i: number) => {
    while (lifts.length <= i) {
      const o = new THREE.Group();
      o.name = 'lift' + lifts.length;
      group.add(o);
      lifts.push(o);
    }
    return lifts[i];
  };
  const comps = an.comps.filter((c, i) => i === 0 || (c.h > 0.14 && (c.x1 - c.x0) * (c.z1 - c.z0) > 0.05)).slice(0, 3);
  const lim = (v: number, half: number) => clamp(v, -half + 0.01, half - 0.01);
  for (const c of comps) {
    const o = 0.035;
    const x0 = lim(c.x0 - o, info.w / 2);
    const x1 = lim(c.x1 + o, info.w / 2);
    const z0 = lim(c.z0 - o, info.d / 2);
    const z1 = lim(c.z1 + o, info.d / 2);
    const top = Math.max(c.h + 0.04, Y0 + 0.14);
    const nl = Math.max(1, Math.ceil((top - Y0) / LH));
    // the four sides as (start, end, inward normal)
    const sides: [number, number, number, number, number, number][] = [
      [x0, z1, x1, z1, 0, -1],
      [x1, z1, x1, z0, -1, 0],
      [x1, z0, x0, z0, 0, 1],
      [x0, z0, x0, z1, 1, 0],
    ];
    for (let li = 0; li < nl; li++) {
      B.cur = lift(li);
      const y0 = Y0 + li * LH;
      const y1 = Math.min(top, y0 + LH);
      for (const [ax, az, bx, bz, inx, inz] of sides) {
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.max(1, Math.ceil(len / 0.17));
        for (let k = 0; k < n; k++) {
          const f = k / n;
          const px = ax + (bx - ax) * f;
          const pz = az + (bz - az) * f;
          B.box(vc, SCAF_STEEL, 0.011, y1 - y0, 0.011, px, (y0 + y1) / 2, pz);
          // diagonal brace on alternate bays of the outer face
          if ((k + li) % 3 === 0) {
            const qx = ax + (bx - ax) * ((k + 1) / n);
            const qz = az + (bz - az) * ((k + 1) / n);
            B.bar(vc, SCAF_STEEL, px, y0, pz, qx, y1, qz, 0.006);
          }
          // safety net on some bays
          if (r() < 0.32) {
            const qx = ax + (bx - ax) * ((k + 1) / n);
            const qz = az + (bz - az) * ((k + 1) / n);
            const ox2 = -inx * 0.006;
            const oz2 = -inz * 0.006;
            const g = new THREE.BufferGeometry();
            const P = new Float32Array([px + ox2, y0, pz + oz2, qx + ox2, y0, qz + oz2, qx + ox2, y1, qz + oz2, px + ox2, y0, pz + oz2, qx + ox2, y1, qz + oz2, px + ox2, y1, pz + oz2]);
            const L = Math.hypot(qx - px, qz - pz) * 14;
            const U = new Float32Array([0, 0, L, 0, L, (y1 - y0) * 14, 0, 0, L, (y1 - y0) * 14, 0, (y1 - y0) * 14]);
            g.setAttribute('position', new THREE.BufferAttribute(P, 3));
            g.setAttribute('uv', new THREE.BufferAttribute(U, 2));
            g.computeVertexNormals();
            B.add(g, net, NET[info.region]);
          }
        }
        // ledger + guard rail, and the working platform (planks) at the lift top
        const mx = (ax + bx) / 2;
        const mz = (az + bz) / 2;
        const ry = Math.atan2(-(bz - az), bx - ax);
        B.box(vc, SCAF_STEEL, len, 0.007, 0.007, mx, y1, mz, ry);
        if (y1 - y0 > 0.06) B.box(vc, SCAF_STEEL, len, 0.006, 0.006, mx, y0 + (y1 - y0) * 0.55, mz, ry);
        B.box(vc, shade(PLANK, 0.85 + r() * 0.3), len - 0.01, 0.006, 0.03, mx + inx * 0.017, y1 - 0.005, mz + inz * 0.017, ry);
      }
    }
  }
  // small tower crane on the bigger lots
  if (info.w * info.d >= 4 && info.key !== 'conyard') {
    const c = comps[0];
    const mx = (c.x0 + c.x1) / 2;
    const mz = (c.z0 + c.z1) / 2;
    let best: [number, number] = [-(info.w / 2 - 0.14), -(info.d / 2 - 0.14)];
    let bs = -1e9;
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        const x = sx * (info.w / 2 - 0.14);
        const z = sz * (info.d / 2 - 0.14);
        const ddx = Math.max(c.x0 - x, 0, x - c.x1);
        const ddz = Math.max(c.z0 - z, 0, z - c.z1);
        const s = Math.hypot(ddx, ddz) * 2 + (sx < 0 || sz < 0 ? 0.25 : 0) + (sx < 0 && sz < 0 ? 0.1 : 0);
        if (s > bs) {
          bs = s;
          best = [x, z];
        }
      }
    const [bx, bz] = best;
    const Hc = Math.max(c.h + 0.42, 0.95);
    const col = CRANE[info.region];
    const mast = new THREE.Group();
    mast.name = 'crane';
    group.add(mast);
    B.cur = mast;
    const s = 0.035;
    B.box(vc, 0x8a8a86, 0.12, 0.03, 0.12, bx, Y0 + 0.015, bz);
    for (const [dx, dz] of [
      [-s, -s],
      [s, -s],
      [s, s],
      [-s, s],
    ])
      B.box(vc, col, 0.009, Hc, 0.009, bx + dx, Y0 + Hc / 2, bz + dz);
    const nseg = Math.ceil(Hc / 0.07);
    for (let i = 0; i < nseg; i++) {
      const ya = Y0 + (i * Hc) / nseg;
      const yb = Y0 + ((i + 1) * Hc) / nseg;
      const a = i % 2 ? -s : s;
      B.bar(vc, col, bx - s, ya, bz + s, bx + s, yb, bz + s, 0.005);
      B.bar(vc, col, bx + s, ya, bz + a, bx + s, yb, bz - a, 0.005);
      B.bar(vc, col, bx - s, ya, bz - a, bx - s, yb, bz + a, 0.005);
    }
    // slewing jib (node rotated in update)
    const jib = new THREE.Group();
    jib.name = 'cjib';
    jib.position.set(bx, Y0 + Hc, bz);
    jib.rotation.y = Math.atan2(-(mz - bz), mx - bx);
    mast.add(jib);
    B.cur = jib;
    const L = clamp(Math.hypot(mx - bx, mz - bz) + 0.25, 0.7, 1.5);
    B.box(vc, 0x3a3e44, 0.07, 0.05, 0.06, 0.02, 0.025, 0.05); // cab
    B.box(vc, col, L, 0.012, 0.012, L / 2, 0.02, -0.018);
    B.box(vc, col, L, 0.012, 0.012, L / 2, 0.02, 0.018);
    B.box(vc, col, L * 0.95, 0.008, 0.008, L / 2, 0.06, 0);
    for (let i = 0; i < Math.ceil(L / 0.08); i++) {
      const xa = i * 0.08;
      B.bar(vc, col, xa, 0.02, -0.018, xa + 0.04, 0.06, 0, 0.004);
      B.bar(vc, col, xa + 0.04, 0.06, 0, xa + 0.08, 0.02, 0.018, 0.004);
    }
    B.box(vc, col, 0.34, 0.014, 0.03, -0.17, 0.02, 0);
    B.box(vc, 0x9a9890, 0.08, 0.06, 0.05, -0.3, 0.0, 0); // counterweight
    B.box(vc, col, 0.012, 0.16, 0.012, 0, 0.1, 0); // apex
    B.bar(vc, 0x30343a, 0, 0.18, 0, L * 0.7, 0.06, 0, 0.003);
    B.bar(vc, 0x30343a, 0, 0.18, 0, -0.3, 0.03, 0, 0.003);
    // trolley, hoist rope and hook block (rope node scaled in update)
    const tx = L * 0.62;
    B.box(vc, 0x3a3e44, 0.04, 0.015, 0.05, tx, 0.006, 0);
    const rope = new THREE.Group();
    rope.name = 'crope';
    rope.position.set(tx, 0, 0);
    jib.add(rope);
    B.cur = rope;
    B.box(vc, 0x202224, 0.003, 1, 0.003, 0, -0.5, 0);
    const hook = new THREE.Group();
    hook.name = 'chook';
    hook.position.set(tx, -0.3, 0);
    jib.add(hook);
    B.cur = hook;
    B.box(vc, 0xd8b020, 0.025, 0.03, 0.02, 0, -0.015, 0);
    B.box(vc, 0x7a6a50, 0.12, 0.02, 0.04, 0, -0.06, 0); // load: a bundle of planks
  }
  B.finish(true);
  // make every lift exist even if empty, ordered
  return { group, lifts: lifts.length };
}

function shade(a: number, f: number) {
  _c.setHex(a);
  return _c.setRGB(Math.min(1, _c.r * f), Math.min(1, _c.g * f), Math.min(1, _c.b * f)).getHex();
}

// ================================================================ damage overlays

const RUBBLE: Record<Region, number[]> = {
  west: [0x9c9a94, 0x7f7d78, 0xb3afa6, 0x5c5a56],
  east: [0x938e84, 0x77726a, 0xa69e90, 0x8a4a36],
  asia: [0xaaaca8, 0x8c8f90, 0xc4c2bc, 0x5a5c5e],
  mideast: [0xcdb78e, 0xb09a74, 0xdac9a6, 0x8a7a5e],
};

function buildOverlay(an: Analysis, rec: FxRec, info: FxInfo, v: number, tier: number): THREE.Group {
  const g = new THREE.Group();
  g.name = 'dmg' + tier;
  const fog = info.fog;
  const vc = vcMat(fog);
  const mt = metalMat(fog);
  const dm = decalMat(fog);
  const B = new Bins(g);
  const p = an.plans[v];
  const r = rng(p.seed * 7 + tier * 131 + 3);
  const cols = RUBBLE[info.region];
  const rc = () => shade(cols[Math.floor(r() * cols.length)], 0.8 + r() * 0.35);
  const hAt = (x: number, z: number) => heightAt(an, info, x, z);
  const pile = (x: number, z: number, R: number, hp: number, n: number, sz = 0.03) => {
    for (let i = 0; i < n; i++) {
      const rr = R * Math.sqrt(r());
      const a = r() * Math.PI * 2;
      const px = clamp(x + Math.cos(a) * rr, -info.w / 2 + 0.02, info.w / 2 - 0.02);
      const pz = clamp(z + Math.sin(a) * rr, -info.d / 2 + 0.02, info.d / 2 - 0.02);
      const k = 1 - rr / R;
      const s = sz * (0.5 + r() * 0.9);
      B.chunk(vc, rc(), px, Y0 + s * 0.3 + k * hp * r(), pz, s * (0.8 + r() * 0.6), s * (0.5 + r() * 0.5), s * (0.8 + r() * 0.6), r);
    }
  };
  const W = rec.wins;
  // windows split into ~0.13 wide segments so long ribbons get several streaks / broken panes
  const segs: number[] = []; // window index, centre offset, width, hash
  for (let i = 0; i < W.length / 7; i++) {
    const ww = W[i * 7 + 5];
    const n = Math.max(1, Math.round(ww / 0.14));
    for (let k = 0; k < n; k++) segs.push(i, (k + 0.5) * (ww / n) - ww / 2, ww / n, h01(i * 16 + k + 0.5, p.seed));
  }
  // soot streak above a window segment
  const soot = (g: number) => {
    const o = segs[g * 4] * 7;
    const [cx, y0, cz, nx, nz, , wh] = [W[o], W[o + 1], W[o + 2], W[o + 3], W[o + 4], W[o + 5], W[o + 6]];
    const sw = Math.min(segs[g * 4 + 2] * 1.1, 0.15) * (0.85 + r() * 0.3);
    const off = segs[g * 4 + 1] + (r() - 0.5) * 0.02;
    const x = cx + nz * off;
    const z = cz - nx * off;
    const roofH = hAt(x - nx * 0.04, z - nz * 0.04);
    const yb = y0 + wh * 0.3;
    const yt = Math.min(y0 + wh + 0.08 + r() * 0.12, Math.max(y0 + wh + 0.03, roofH - 0.004));
    B.vdecal(dm, nx, nz, x + nx * 0.006, yb, z + nz * 0.006, sw, yt - yb, 0, r() > 0.5);
  };
  const nSeg = segs.length / 4;
  // crack on an exposed wall face
  const walls = rec.walls;
  const crack = () => {
    const nW = walls.length / 6;
    if (!nW) return;
    for (let tries = 0; tries < 10; tries++) {
      const k = Math.floor(r() * nW) * 6;
      const [x0, y0, z0, x1, y1, z1] = [walls[k], walls[k + 1], walls[k + 2], walls[k + 3], walls[k + 4], walls[k + 5]];
      const f = r();
      const face: [number, number] = f < 0.4 ? [0, 1] : f < 0.8 ? [1, 0] : f < 0.9 ? [0, -1] : [-1, 0];
      const [nx, nz] = face;
      const len = nx ? z1 - z0 : x1 - x0;
      if (len < 0.14 || y1 - y0 < 0.1) continue;
      const s = 0.06 + r() * 0.07;
      const u = (r() - 0.5) * (len - s);
      const x = nx ? (nx > 0 ? x1 : x0) : (x0 + x1) / 2 + u;
      const zz = nz ? (nz > 0 ? z1 : z0) : (z0 + z1) / 2 + u;
      const y = y0 + 0.02 + r() * Math.max(0, y1 - y0 - s - 0.03);
      // exposed: nothing tall right in front of the face
      if (hAt(x + nx * 0.06, zz + nz * 0.06) > y + s * 0.5) continue;
      B.vdecal(dm, nx, nz, x + nx * 0.004, y, zz + nz * 0.004, s, s, 1, r() > 0.5);
      return;
    }
  };
  const scorch = (x: number, z: number, s: number, gx = 0, gz = 0, y?: number) => {
    const yc = y ?? hAt(x, z);
    const Y = (px: number, pz: number) => yc + gx * (px - x) + gz * (pz - z) + 0.004;
    const a = x - s;
    const b = x + s;
    const c = z - s;
    const d = z + s;
    B.quad(dm, [a, Y(a, d), d, b, Y(b, d), d, b, Y(b, c), c, a, Y(a, c), c], 3, r() > 0.5);
  };
  const beams = (h: Hole) => {
    // exposed roof beams across the hole, one broken and sagging
    const yb = h.y - 0.026;
    const along = r() > 0.5;
    const n = 2 + Math.floor(r() * 2);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) / n - 0.5;
      const broken = i === 1;
      if (along) {
        const z = h.z + f * h.hz * 1.6;
        const y = yb + h.gz * (z - h.z);
        if (broken) {
          B.bar(mt, 0x4c4440, h.x - h.hx - 0.01, y + h.gx * -h.hx, z, h.x + 0.01, y - 0.05, z + 0.01, 0.012);
        } else B.box(mt, 0x50504c, h.hx * 2 + 0.03, 0.013, 0.011, h.x, y, z, 0, 0, -Math.atan(h.gx));
      } else {
        const x = h.x + f * h.hx * 1.6;
        const y = yb + h.gx * (x - h.x);
        if (broken) {
          B.bar(mt, 0x4c4440, x, y + h.gz * -h.hz, h.z - h.hz - 0.01, x + 0.01, y - 0.05, h.z + 0.01, 0.012);
        } else B.box(mt, 0x50504c, 0.011, 0.013, h.hz * 2 + 0.03, x, y, h.z, 0, Math.atan(h.gz), 0);
      }
    }
    // a few broken roof panels lying around the hole
    for (let i = 0; i < 4; i++) {
      const a = r() * Math.PI * 2;
      const rr = Math.max(h.hx, h.hz) + 0.02 + r() * 0.05;
      const x = h.x + Math.cos(a) * rr;
      const z = h.z + Math.sin(a) * rr;
      const y = h.y + h.gx * (x - h.x) + h.gz * (z - h.z);
      B.box(vc, rc(), 0.03 + r() * 0.03, 0.006, 0.02 + r() * 0.03, x, y + 0.006, z, r() * 3, (r() - 0.5) * 0.6, (r() - 0.5) * 0.6);
    }
  };
  const base = an.comps[0];
  switch (tier) {
    case 0: {
      for (let i = 0; i < nSeg; i++) if (segs[i * 4 + 3] < 0.35) soot(i);
      const nc = 2 + Math.round((info.w * info.d) / 3);
      for (let i = 0; i < nc; i++) crack();
      // loose debris along the walls
      for (let i = 0; i < 3; i++) {
        const side = r();
        const x = side < 0.5 ? base.x0 + r() * (base.x1 - base.x0) : base.x1 + 0.03;
        const z = side < 0.5 ? base.z1 + 0.03 : base.z0 + r() * (base.z1 - base.z0);
        pile(x, z, 0.06, 0.01, 4, 0.022);
      }
      break;
    }
    case 1: {
      for (let i = 0; i < nSeg; i++) {
        const sv = segs[i * 4 + 3];
        if (sv >= 0.35 && sv < 0.75) soot(i);

      }
      const h = p.holes[0];
      if (h) {
        beams(h);
        scorch(h.x, h.z, Math.max(h.hx, h.hz) * 1.9, h.gx, h.gz, h.y);
      }
      const n = p.notch;
      if (n) {
        // the fallen parapet lies at the foot of the wall
        const x = (n.x0 + n.x1) / 2 + n.nx * 0.12;
        const z = (n.z0 + n.z1) / 2 + n.nz * 0.12;
        pile(x, z, 0.12, 0.03, 12, 0.032);
        // rebar sticking out of the broken parapet
        for (let i = 0; i < 3; i++) {
          const f = (i + 0.5) / 3;
          const bx = n.nx ? n.x1 - 0.1 : n.x0 + (n.x1 - n.x0) * f;
          const bz = n.nz ? n.z1 - 0.1 : n.z0 + (n.z1 - n.z0) * f;
          if (hAt(bx, bz) < n.y + 0.02) continue;
          B.bar(mt, 0x6a4028, bx, n.y, bz, bx + n.nx * 0.03 + (r() - 0.5) * 0.02, n.y + 0.04 + r() * 0.03, bz + n.nz * 0.03 + (r() - 0.5) * 0.02, 0.004);
        }
      }
      break;
    }
    case 2: {
      const h = p.holes[1];
      if (h) {
        beams(h);
        scorch(h.x, h.z, Math.max(h.hx, h.hz) * 1.9, h.gx, h.gz, h.y);
      }
      const nc = 2 + Math.round((info.w * info.d) / 4);
      for (let i = 0; i < nc; i++) crack();
      for (let i = 0; i < nSeg; i++) if (segs[i * 4 + 3] >= 0.75) soot(i);
      // scorched ground and a second rubble pile
      for (let i = 0; i < 2; i++) {
        const x = base.x1 + 0.08 + r() * 0.1;
        const z = base.z0 + r() * (base.z1 - base.z0);
        if (x < info.w / 2 - 0.05) scorch(x, z, 0.12 + r() * 0.08, 0, 0, Y0);
      }
      pile(base.x0 + r() * (base.x1 - base.x0), Math.min(base.z1 + 0.1, info.d / 2 - 0.08), 0.1, 0.025, 10, 0.03);
      break;
    }
    case 3: {
      const c = p.corner;
      if (c) {
        // rubble heap at the collapsed corner
        const hx = c.cx - Math.sign(c.b === 0 ? 1 : -c.b) * c.sx * 0.35;
        const hz = c.cz - Math.sign(c.c === 0 ? 1 : -c.c) * c.sz * 0.35;
        const R = Math.max(c.sx, c.sz) * 0.75 + 0.08;
        pile(hx, hz, R, Math.min(0.18, (c.hi - Y0) * 0.4), 30 + Math.round(R * 40), 0.045);
        pile(hx, hz, R * 0.6, Math.min(0.1, (c.hi - Y0) * 0.25), 10, 0.06);
        scorch(c.cx - Math.sign(-c.b || 1) * c.sx * 0.5, c.cz - Math.sign(-c.c || 1) * c.sz * 0.5, R * 0.9, 0, 0, Y0);
        // twisted beams and rebar sticking out of the broken structure
        const sxs = Math.sign(-c.b || 1);
        const szs = Math.sign(-c.c || 1);
        for (let i = 0; i < 7; i++) {
          // on the broken wall tops of the two outer faces inside the collapse
          const f = 0.3 + r() * 0.7;
          const onX = r() > 0.5;
          const px = onX ? (sxs > 0 ? base.x1 - 0.025 : base.x0 + 0.025) : c.cx - sxs * (c.sx + 0.06) * f;
          const pz = onX ? c.cz - szs * (c.sz + 0.06) * f : szs > 0 ? base.z1 - 0.025 : base.z0 + 0.025;
          const top = Math.min(c.a + c.b * px + c.c * pz, c.hi);
          const y = Math.max(Y0 + 0.03, top - 0.01 - r() * 0.03);
          if (hAt(px, pz) < y + 0.01) continue; // nothing was standing there
          const L = 0.04 + r() * 0.07;
          const big = i < 2;
          B.bar(mt, big ? 0x4a4642 : 0x6a4028, px, y, pz, px + sxs * L * (0.2 + r() * 0.6), y + L * (0.4 + r() * 0.6), pz + szs * L * (0.2 + r() * 0.6), big ? 0.01 : 0.004);
        }
      }
      break;
    }
  }
  B.finish(true);
  return g;
}

// ================================================================ shader patch

const VERT_HEAD = 'uniform mat4 bxInv;\nvarying vec3 vBxP;';
const FRAG_HEAD = `uniform float bxClip;
uniform float bxSoot;
uniform float bxHit;
uniform float bxSeed;
uniform vec4 bxR[4];
uniform vec4 bxP[4];
varying vec3 vBxP;
float bxN( vec3 p ) { return sin( p.x * 61.3 + p.z * 23.9 + p.y * 7.1 ) * sin( p.z * 47.1 - p.x * 19.7 + p.y * 37.3 ); }
float bxH( vec3 p ) { return fract( sin( dot( p, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }
float bxV( vec3 p ) {
  vec3 i = floor( p );
  vec3 f = fract( p );
  f = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( mix( bxH( i ), bxH( i + vec3( 1, 0, 0 ) ), f.x ), mix( bxH( i + vec3( 0, 1, 0 ) ), bxH( i + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( bxH( i + vec3( 0, 0, 1 ) ), bxH( i + vec3( 1, 0, 1 ) ), f.x ), mix( bxH( i + vec3( 0, 1, 1 ) ), bxH( i + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}`;
const VERT_BODY = `
{
  vec4 bxW = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
  bxW = instanceMatrix * bxW;
  #endif
  vBxP = ( bxInv * ( modelMatrix * bxW ) ).xyz;
}`;
const FRAG_CUT = `
float bxK = 0.0;
{
  float bn = bxN( vBxP );
  if ( vBxP.y > bxClip + bn * 0.006 ) discard;
  for ( int i = 0; i < 4; i ++ ) {
    vec4 r = bxR[ i ];
    float e = 0.016 * bn;
    if ( vBxP.x > r.x + e && vBxP.x < r.z - e && vBxP.z > r.y - e && vBxP.z < r.w + e ) {
      vec4 pl = bxP[ i ];
      float top = pl.x + pl.y * vBxP.x + pl.z * vBxP.z + pl.w * bn;
      if ( vBxP.y > top ) discard;
      bxK = max( bxK, 0.55 + 0.45 * ( 1.0 - smoothstep( 0.0, 0.05, top - vBxP.y ) ) );
    }
  }
}`;
/*
 * Small arms damage on walls (vertical faces only, building space, so it is
 * deterministic per instance via bxSeed): clustered bullet holes with a
 * chipped light rim, and fewer larger spalled patches (shrapnel / cannon).
 * Density follows bxHit (0 at D_ON .. 1 near destruction).
 */
const HOLES_GLSL = /* glsl */ `
vec3 hfn = normalize( cross( dFdx( vBxP ), dFdy( vBxP ) ) );
if ( abs( hfn.y ) < 0.5 ) {
  bool hX = abs( hfn.x ) > abs( hfn.z );
  vec2 wp = vec2( hX ? vBxP.z : vBxP.x, vBxP.y );
  float fid = ( hX ? 3.0 : 7.0 ) + sign( hX ? hfn.x : hfn.z ) + bxSeed;
  // bursts: holes cluster where a burst hit
  float clus = bxV( vec3( wp * 3.2, fid * 1.7 ) );
  vec2 cg = wp * 12.0;
  vec2 ci = floor( cg );
  vec3 hk = vec3( ci, fid );
  float hr = bxH( hk );
  if ( hr < bxHit * smoothstep( 0.62 - bxHit * 0.3, 0.9 - bxHit * 0.2, clus ) * 0.75 ) {
    vec2 dv = cg - ci - ( vec2( bxH( hk + 3.1 ), bxH( hk + 7.7 ) ) * 0.5 + 0.25 );
    float d = length( dv );
    float rr = 0.1 + 0.07 * bxH( hk + 1.3 );
    float jag = 1.0 + 0.3 * sin( atan( dv.y, dv.x ) * 5.0 + hr * 40.0 );
    float chip = 1.0 - smoothstep( rr * 2.0 * jag, rr * 2.7 * jag, d );
    float hole = 1.0 - smoothstep( rr * 0.7, rr, d );
    outgoingLight = mix( outgoingLight, max( bxRaw, vec3( bxL2 * 1.2 ) ), chip * 0.55 );
    outgoingLight *= 1.0 - hole * 0.88;
  }
  // larger spalled chips
  vec2 cg2 = wp * 4.0;
  vec2 ci2 = floor( cg2 );
  vec3 hk2 = vec3( ci2, fid + 11.0 );
  if ( bxH( hk2 ) < bxHit * 0.32 ) {
    vec2 dv2 = cg2 - ci2 - ( vec2( bxH( hk2 + 2.3 ), bxH( hk2 + 5.9 ) ) * 0.4 + 0.3 );
    float n2 = bxV( vec3( wp * 40.0, fid ) );
    float d2 = length( dv2 ) + ( n2 - 0.5 ) * 0.14;
    float r2 = 0.12 + 0.12 * bxH( hk2 + 9.1 );
    float spall = 1.0 - smoothstep( r2 * 0.85, r2, d2 );
    float rim = smoothstep( r2 * 0.7, r2 * 0.95, d2 ) * spall;
    float pit = 1.0 - smoothstep( r2 * 0.2, r2 * 0.45, d2 );
    vec3 raw = max( bxRaw, vec3( bxL2 * 1.1 ) ) * ( 0.75 + n2 * 0.45 );
    outgoingLight = mix( outgoingLight, raw, spall * 0.75 );
    outgoingLight *= ( 1.0 - rim * 0.45 ) * ( 1.0 - pit * 0.6 );
  }
}
`;

/*
 * Window panes (the lit window materials; their uv grid is 8 x 4 cells with
 * two half panes per cell): with damage, half panes crack into a spider web
 * around a bullet hole, then shatter out leaving jagged shards at the frame.
 * The pane centre is rebuilt from screen derivatives so every half pane
 * gets its own stable state.
 */
const GLASS_GLSL = /* glsl */ `
#ifdef USE_MAP
vec2 wg = vMapUv * vec2( 8.0, 4.0 );
vec2 wf = fract( wg );
vec2 gx = dFdx( wg );
vec2 gy = dFdy( wg );
float gdet = gx.x * gy.y - gx.y * gy.x;
float side = step( 0.5, wf.x );
vec2 lq = vec2( ( wf.x - mix( 0.12, 0.525, side ) ) / 0.355, ( wf.y - 0.18 ) / 0.68 );
if ( abs( gdet ) > 1e-14 && lq.x > 0.0 && lq.x < 1.0 && lq.y > 0.0 && lq.y < 1.0 ) {
  vec3 px = dFdx( vBxP );
  vec3 py = dFdy( vBxP );
  vec3 dPdu = ( gy.y * px - gx.y * py ) / gdet;
  vec3 dPdv = ( gx.x * py - gy.x * px ) / gdet;
  vec3 pc = vBxP - dPdu * ( wf.x - mix( 0.2975, 0.7025, side ) ) - dPdv * ( wf.y - 0.52 );
  vec3 pk = floor( pc * 50.0 + 0.5 ) + bxSeed;
  float r = bxH( pk );
  vec3 voidC = vec3( 0.006, 0.006, 0.007 );
  if ( r < bxHit * 0.42 ) {
    // pane gone: dark interior, jagged teeth of glass left in the frame
    float e = min( min( lq.x, 1.0 - lq.x ), min( lq.y, 1.0 - lq.y ) );
    float per = ( min( lq.x, 1.0 - lq.x ) < min( lq.y, 1.0 - lq.y ) ) ? lq.y * 1.9 : lq.x;
    float tk = per * 4.0 + r * 13.0;
    float tooth = ( 1.0 - abs( fract( tk ) * 2.0 - 1.0 ) ) * ( 0.05 + 0.3 * bxH( vec3( floor( tk ), r, 3.0 ) ) );
    float glassK = step( e, tooth );
    outgoingLight = mix( voidC, outgoingLight * 0.8 + vec3( 0.05, 0.06, 0.065 ) * bxL2, glassK );
  } else if ( r < bxHit * 0.95 ) {
    // bullet hole with radial and ring cracks
    vec2 ip = vec2( bxH( pk + 1.7 ), bxH( pk + 4.3 ) ) * 0.6 + 0.2;
    vec2 dv = ( lq - ip ) * vec2( 1.0, 1.9 );
    float d = length( dv );
    float a = atan( dv.y, dv.x ) / 6.2832 + 0.5;
    float h3 = bxH( pk + 8.9 );
    float rh = ( 0.05 + 0.07 * h3 ) * ( 0.75 + 0.5 * bxH( vec3( floor( a * 9.0 ), r, 5.0 ) ) );
    float spokes = 6.0 + floor( h3 * 4.0 );
    float sd = abs( fract( a * spokes + h3 * 3.0 ) - 0.5 ) / spokes * 6.2832 * d;
    float ringI = floor( d * 7.0 );
    float rd = abs( fract( d * 7.0 ) - 0.5 ) / 7.0;
    float ringOn = step( 0.45, bxH( vec3( floor( a * spokes + h3 * 3.0 ), ringI, 7.0 ) ) ) * step( d, 0.5 );
    float lw = 0.012 + fwidth( d ) * 0.6;
    float crack = max( 1.0 - smoothstep( lw * 0.5, lw, sd ), ( 1.0 - smoothstep( lw * 0.5, lw, rd ) ) * ringOn ) * ( 1.0 - smoothstep( 0.35, 1.1, d ) );
    outgoingLight = mix( outgoingLight, vec3( 0.32, 0.36, 0.38 ) * ( 0.4 + bxL2 * 2.0 ), crack * 0.75 );
    outgoingLight = mix( outgoingLight, voidC, 1.0 - smoothstep( rh * 0.85, rh, d ) );
  }
}
#endif
`;

const FRAG_LIGHT = `
{
  float bxB = 1.0 - smoothstep( 0.0, 0.035, bxClip - vBxP.y );
  float bxL = dot( outgoingLight, vec3( 0.3, 0.59, 0.11 ) );
  outgoingLight = mix( outgoingLight, vec3( bxL * 0.98, bxL * 0.95, bxL * 0.9 ), bxB * 0.7 );
  float bxS = 0.0;
  if ( bxSoot > 0.0 ) {
    // scorch blotches with upward streaks; the ground apron stays clean
    vec3 sp = vBxP * vec3( 4.0, 2.0, 4.0 );
    float n = bxV( sp ) * 0.6 + bxV( sp * 2.7 + 7.0 ) * 0.3 + bxV( sp * 7.3 + 3.0 ) * 0.1;
    bxS = bxSoot * smoothstep( 0.7 - 0.28 * bxSoot, 0.95 - 0.2 * bxSoot, n ) * smoothstep( 0.045, 0.1, vBxP.y );
  }
  outgoingLight *= ( 1.0 - 0.62 * bxS ) * ( 1.0 - 0.8 * bxK );
  if ( bxHit > 0.0 && vBxP.y > 0.05 ) {
    float bxL2 = dot( outgoingLight, vec3( 0.3, 0.59, 0.11 ) );
    // light reaching the surface, so exposed raw material can be lit like the wall
    #if defined( STANDARD )
    float bxIrr = dot( totalDiffuse, vec3( 0.3, 0.59, 0.11 ) ) / max( dot( diffuseColor.rgb, vec3( 0.3, 0.59, 0.11 ) ), 0.03 );
    #else
    float bxIrr = bxL2 * 2.0;
    #endif
    vec3 bxRaw = vec3( 0.46, 0.44, 0.41 ) * bxIrr;
    #ifdef BX_GLASS
    ${GLASS_GLSL}
    #else
    ${HOLES_GLSL}
    #endif
  }
  #ifdef BX_FRONT
  // inside faces seen through a cut / the open top: the interior is in shade
  if ( ! gl_FrontFacing ) outgoingLight *= 0.38;
  #endif
}`;

interface BxUniforms {
  bxInv: { value: THREE.Matrix4 };
  bxClip: { value: number };
  bxSoot: { value: number };
  bxHit: { value: number };
  bxSeed: { value: number };
  bxR: { value: THREE.Vector4[] };
  bxP: { value: THREE.Vector4[] };
  [k: string]: THREE.IUniform;
}

function patchShader(sh: THREE.WebGLProgramParametersWithUniforms, U: BxUniforms, light: boolean) {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_HEAD).replace('#include <project_vertex>', '#include <project_vertex>' + VERT_BODY);
  sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\n' + FRAG_HEAD).replace('#include <clipping_planes_fragment>', FRAG_CUT + '\n#include <clipping_planes_fragment>');
  if (light) sh.fragmentShader = sh.fragmentShader.replace('#include <opaque_fragment>', FRAG_LIGHT + '\n#include <opaque_fragment>');
}

function cloneFor(real: Mat, U: BxUniforms): Mat {
  const c = real.clone();
  c.side = THREE.DoubleSide;
  if (real.side === THREE.FrontSide) c.defines = { ...(c.defines ?? {}), BX_FRONT: '' };
  // lit window panes shatter instead of collecting bullet holes
  if ((real as THREE.MeshStandardMaterial).emissiveMap && real.userData.baseEI) c.defines = { ...(c.defines ?? {}), BX_GLASS: '' };
  c.shadowSide = real.shadowSide ?? (real.side === THREE.FrontSide ? THREE.BackSide : real.side);
  const prevKey = real.customProgramCacheKey();
  c.onBeforeCompile = (sh, r) => {
    real.onBeforeCompile(sh, r);
    patchShader(sh, U, true);
  };
  c.customProgramCacheKey = () => 'bx|' + prevKey;
  return c;
}

const noopBR = THREE.Object3D.prototype.onBeforeRender;

// ================================================================ per instance controller

const _v4 = new THREE.Vector4();

/** Every live BuildFx (fire spread between neighbours) and the ones currently burning hard enough to spread. */
const ALL_FX = new Set<BuildFx>();
const INFERNO = new Set<BuildFx>();

/** Per-instance construction / damage driver, called from the model's anim. */
export class BuildFx {
  readonly damageFx: DamageFx[];
  private variant = -1;
  private custom = false;
  private meshes: THREE.Mesh[] | null = null;
  private orig: Mat[] = [];
  private clones: Mat[] = [];
  private glowClones: THREE.MeshStandardMaterial[] = [];
  private depth: THREE.MeshDepthMaterial | null = null;
  private U: BxUniforms | null = null;
  private fxRoot: THREE.Group | null = null;
  private scaf: THREE.Object3D | null = null;
  private lifts: THREE.Object3D[] = [];
  private jib: THREE.Object3D | null = null;
  private rope: THREE.Object3D | null = null;
  private hook: THREE.Object3D | null = null;
  private jib0 = 0;
  private sparks: THREE.Points | null = null;
  private sparkPos: Float32Array | null = null;
  private tiers: (THREE.Object3D | null)[] = [null, null, null, null];
  private seed = 0;
  /** Falling glass shards when windows break (lazily created, shared material). */
  private shards: THREE.Points | null = null;
  private shardT0 = -1;
  private shardAt = new THREE.Vector3();
  private shardN = new THREE.Vector2();
  private shardD = -1;
  private shardK = 0;
  private obr: (r: THREE.WebGLRenderer, s: THREE.Scene, c: THREE.Camera, g: THREE.BufferGeometry, m: Mat) => void;

  constructor(
    readonly tpl: FxTpl,
    readonly root: THREE.Group,
  ) {
    this.damageFx = FX_SLOTS.map((s) => ({ pos: new THREE.Vector3(0, tpl.info.height * 0.6, 0), kind: s.kind, at: s.at }));
    ALL_FX.add(this);
    const root2 = root;
    this.obr = () => {
      const U = this.U;
      if (U) U.bxInv.value.copy(root2.matrixWorld).invert();
    };
  }

  /** Cheap when finished and intact; otherwise drives construction / damage visuals. */
  update(s: AnimState) {
    const b = s.built;
    const d = s.damage;
    this.burn(s);
    if (b >= 1 && d < D_ON && !this.custom && !this.scaf && this.fxRoot === null) return;
    if (this.variant < 0) this.pickVariant();
    const want = b < 1 || d >= D_ON || (this.custom && d >= D_OFF);
    if (want && !this.custom) this.enter();
    else if (!want && this.custom) this.exit();
    if (b < 1) this.construct(s);
    else if (this.scaf || this.sparks) this.endConstruction();
    if (this.custom) this.damage(s);
    else if (this.fxRoot) for (const t of this.tiers) if (t) t.visible = false;
    if (!this.custom && !this.scaf && this.fxRoot) {
      let any = false;
      for (const t of this.tiers) if (t && t.visible) any = true;
      if (!any) {
        // drop the overlays with their group (re-cloned from the template if damaged again)
        this.root.remove(this.fxRoot);
        this.fxRoot = null;
        this.tiers.fill(null);
        this.shards?.geometry.dispose();
        this.shards = null;
        this.shardT0 = -1;
      }
    }
  }

  private pickVariant() {
    const an = this.tpl.analysis;
    const x = this.root.position.x;
    const z = this.root.position.z;
    this.seed = Math.floor(h01(x * 1.37 + 0.11, z * 2.71 + 0.17) * 1e6);
    this.variant = this.seed % VARIANTS;
    const fx = an.plans[this.variant].fx;
    for (let i = 0; i < FX_SLOTS.length; i++) this.damageFx[i].pos.set(fx[i * 3], fx[i * 3 + 1], fx[i * 3 + 2]);
  }

  private fx(): THREE.Group {
    if (!this.fxRoot) {
      this.fxRoot = new THREE.Group();
      this.fxRoot.name = 'bxfx';
      this.root.add(this.fxRoot);
    }
    return this.fxRoot;
  }

  private enter() {
    if (!this.meshes) {
      const list: THREE.Mesh[] = [];
      const walk = (o: THREE.Object3D) => {
        if (o.name === 'bxfx') return;
        if ((o as THREE.Mesh).isMesh) list.push(o as THREE.Mesh);
        for (const ch of o.children) walk(ch);
      };
      walk(this.root);
      this.meshes = list;
      this.orig = list.map((m) => m.material as Mat);
    }
    if (!this.U) {
      this.U = {
        bxInv: { value: new THREE.Matrix4() },
        bxClip: { value: 99 },
        bxSoot: { value: 0 },
        bxHit: { value: 0 },
        bxSeed: { value: (this.seed % 997) * 0.731 },
        bxR: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(1, 1, 0, 0)) },
        bxP: { value: [0, 1, 2, 3].map(() => new THREE.Vector4(99, 0, 0, 0)) },
      };
      this.root.updateMatrixWorld();
      this.U.bxInv.value.copy(this.root.matrixWorld).invert();
    }
    const U = this.U;
    if (!this.depth) {
      const dm = new THREE.MeshDepthMaterial();
      dm.onBeforeCompile = (sh) => patchShader(sh, U, false);
      dm.customProgramCacheKey = () => 'bxdepth';
      this.depth = dm;
    }
    const map = new Map<Mat, Mat>();
    this.clones = [];
    this.glowClones = [];
    for (let i = 0; i < this.meshes.length; i++) {
      const m = this.meshes[i];
      const real = this.orig[i];
      let c = map.get(real);
      if (!c) {
        c = cloneFor(real, U);
        map.set(real, c);
        this.clones.push(c);
        if (c.userData.baseEI) this.glowClones.push(c as THREE.MeshStandardMaterial);
      }
      m.material = c;
      // alpha tested materials keep the default (cut-less) shadow so their cut-outs stay right
      if (!(real.alphaTest > 0)) m.customDepthMaterial = this.depth;
      m.onBeforeRender = this.obr;
    }
    this.custom = true;
  }

  private exit() {
    if (this.meshes)
      for (let i = 0; i < this.meshes.length; i++) {
        const m = this.meshes[i];
        m.material = this.orig[i];
        m.customDepthMaterial = undefined;
        m.onBeforeRender = noopBR;
      }
    // clones are dropped (not disposed: their programs stay cached for the next instance)
    this.clones = [];
    this.glowClones = [];
    this.custom = false;
  }

  // ------------------------------------------------------------ construction
  private construct(s: AnimState) {
    const b = s.built;
    const tpl = this.tpl;
    const an = tpl.analysis;
    const U = this.U!;
    // the renderer squashes the root while building: the slices replace that
    this.root.scale.set(1, 1, 1);
    const B1 = 0.08; // foundation slab
    const B2 = 0.88; // structure complete, scaffolding comes down
    let clip: number;
    if (b < B1) clip = (b / B1) * (Y0 + 0.004);
    else if (b < B2) {
      const f = ((b - B1) / (B2 - B1)) * 32;
      const k = Math.min(31, Math.floor(f));
      clip = an.lut[k] + (an.lut[k + 1] - an.lut[k]) * (f - k);
    } else clip = 99;
    U.bxClip.value = clip;
    // scaffolding
    if (!this.scaf) {
      const sc = tpl.scaffold();
      this.scaf = sc.group.clone(true);
      this.lifts = [];
      for (let i = 0; i < sc.lifts; i++) {
        const o = this.scaf.getObjectByName('lift' + i);
        if (o) this.lifts.push(o);
      }
      this.jib = this.scaf.getObjectByName('cjib') ?? null;
      this.rope = this.scaf.getObjectByName('crope') ?? null;
      this.hook = this.scaf.getObjectByName('chook') ?? null;
      this.jib0 = this.jib ? this.jib.rotation.y : 0;
      this.fx().add(this.scaf);
    }
    const n = this.lifts.length;
    if (b < B2) {
      for (let i = 0; i < n; i++) this.lifts[i].visible = b > B1 * 0.5 && Y0 + i * LH < clip + 0.07;
    } else {
      const keep = Math.ceil(n * (1 - (b - B2) / (1 - B2)));
      for (let i = 0; i < n; i++) this.lifts[i].visible = i < keep;
    }
    const crane = this.jib?.parent;
    if (crane) crane.visible = b > 0.02 && b < 0.93;
    if (this.jib && this.rope && this.hook) {
      const t = s.time * 0.22 + (this.seed % 97);
      this.jib.rotation.y = this.jib0 + Math.sin(t) * 0.75;
      const drop = 0.25 + 0.2 * (0.5 + 0.5 * Math.sin(t * 1.7));
      this.rope.scale.y = drop;
      this.hook.position.y = -drop;
    }
    // welding sparks along the rising edge
    this.weld(s, b > B1 && b < B2, clip);
  }

  private weld(s: AnimState, on: boolean, clip: number) {
    if (!on) {
      if (this.sparks) this.sparks.visible = false;
      return;
    }
    const N = 30;
    if (!this.sparks) {
      const g = new THREE.BufferGeometry();
      this.sparkPos = new Float32Array(N * 3);
      const col = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        const w = i % 10 === 0;
        col[i * 3] = 1;
        col[i * 3 + 1] = w ? 0.95 : 0.65 + h01(i) * 0.3;
        col[i * 3 + 2] = w ? 0.85 : 0.25 + h01(i, 3) * 0.2;
      }
      g.setAttribute('position', new THREE.BufferAttribute(this.sparkPos, 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
      this.sparks = new THREE.Points(g, sparkMat());
      // point size is in pixels for an orthographic camera but scaled by 1/depth for a perspective one
      this.sparks.onBeforeRender = (_r, _s, cam) => {
        sparkMat().size = (cam as THREE.PerspectiveCamera).isPerspectiveCamera ? 0.16 : 5;
      };
      this.sparks.frustumCulled = false;
      this.sparks.renderOrder = 3;
      this.fx().add(this.sparks);
    }
    this.sparks.visible = true;
    const P = this.sparkPos!;
    const comps = this.tpl.analysis.comps;
    const t = s.time;
    for (let i = 0; i < N; i++) {
      const site = i % 3;
      // weld site moves every ~1.4 s
      const slot = Math.floor(t / 1.4 + site * 0.37);
      const hs = h01(slot * 3.1 + site, this.seed % 1000);
      const c = comps[Math.floor(h01(slot + 0.3, site) * comps.length) % comps.length];
      const side = h01(slot + 0.7, site + 2);
      let x: number;
      let z: number;
      if (side < 0.5) {
        x = c.x0 + (c.x1 - c.x0) * hs;
        z = c.z1;
      } else {
        x = c.x1;
        z = c.z0 + (c.z1 - c.z0) * hs;
      }
      const y = Math.min(clip, c.h) - 0.01;
      const ph = t * 1.9 + i * 0.137;
      const cyc = Math.floor(ph);
      const age = (ph - cyc) * 0.55;
      const base = i * 3;
      if (i % 10 === 0) {
        // the arc itself, flickering
        const on = h01(Math.floor(t * 14), i) > 0.3;
        P[base] = x;
        P[base + 1] = on ? y : -50;
        P[base + 2] = z;
        continue;
      }
      const vx = (h01(cyc, i) - 0.3) * 0.5 * (side < 0.5 ? 1 : 1.6);
      const vz = (h01(cyc, i + 9) - 0.3) * 0.5 * (side < 0.5 ? 1.6 : 1);
      const vy = 0.15 + h01(cyc, i + 5) * 0.35;
      P[base] = x + vx * age;
      P[base + 1] = Math.max(Y0, y + vy * age - 2.4 * age * age);
      P[base + 2] = z + vz * age;
    }
    (this.sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  private endConstruction() {
    if (this.scaf) {
      this.scaf.removeFromParent();
      this.scaf = null;
      this.lifts = [];
      this.jib = this.rope = this.hook = null;
    }
    if (this.sparks) {
      this.sparks.removeFromParent();
      this.sparks.geometry.dispose();
      this.sparks = null;
      this.sparkPos = null;
    }
    if (this.U) this.U.bxClip.value = 99;
  }

  // ------------------------------------------------------------ glass
  /**
   * A brief burst of glinting shards from a window whenever the damage has
   * grown enough for more panes to break (the shader breaks them by bxHit).
   */
  private glassFx(s: AnimState) {
    const W = this.tpl.rec.wins;
    const d = s.damage;
    if (!W.length || s.built < 1) return;
    if (this.shardD < 0 || d < this.shardD - 0.1) this.shardD = d;
    const t = s.time;
    if (d >= this.shardD + 0.07) {
      this.shardD = d;
      const n = W.length / 7;
      const i = Math.floor(h01(this.shardK++ * 3.7 + 0.3, this.seed % 1000) * n) * 7;
      const off = (h01(this.shardK, 7.1) - 0.5) * W[i + 5] * 0.8;
      this.shardAt.set(W[i] + W[i + 4] * off + W[i + 3] * 0.01, W[i + 1] + W[i + 6] * 0.6, W[i + 2] - W[i + 3] * off + W[i + 4] * 0.01);
      this.shardN.set(W[i + 3], W[i + 4]);
      this.shardT0 = t;
    }
    const age = this.shardT0 < 0 ? 99 : t - this.shardT0;
    const LIFE = 0.9;
    if (age > LIFE) {
      if (this.shards) this.shards.visible = false;
      return;
    }
    const N = 18;
    if (!this.shards) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(N * 3), 3).setUsage(THREE.DynamicDrawUsage));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 4);
      this.shards = new THREE.Points(g, glassMat());
      this.shards.onBeforeRender = (_r, _s, cam) => {
        glassMat().size = (cam as THREE.PerspectiveCamera).isPerspectiveCamera ? 0.09 : 3.5;
      };
      this.shards.frustumCulled = false;
      this.shards.renderOrder = 3;
      this.fx().add(this.shards);
    }
    this.shards.visible = true;
    const P = this.shards.geometry.attributes.position as THREE.BufferAttribute;
    const C = this.shards.geometry.attributes.color as THREE.BufferAttribute;
    const { x: nx, y: nz } = this.shardN;
    const k = this.shardK;
    const fade = 1 - age / LIFE;
    for (let i = 0; i < N; i++) {
      const out = 0.12 + h01(i, k) * 0.35;
      const side = (h01(i + 0.5, k) - 0.5) * 0.5;
      const up = h01(i + 0.25, k + 3) * 0.35;
      const x = this.shardAt.x + (nx * out + nz * side) * age;
      const z = this.shardAt.z + (nz * out - nx * side) * age;
      const y = Math.max(Y0, this.shardAt.y + up * age - 2.6 * age * age);
      P.setXYZ(i, x, y, z);
      // tumbling shards catch the light now and then
      const glint = Math.max(0, Math.sin(t * (18 + h01(i, 9) * 20) + i * 1.7)) ** 3;
      const b = fade * (0.25 + 1.6 * glint);
      C.setXYZ(i, b * 0.85, b * 0.95, b);
    }
    P.needsUpdate = true;
    C.needsUpdate = true;
  }

  // ------------------------------------------------------------ spreading fire
  // Visual only. While a building stays badly damaged, its fire spreads over
  // the structure: more points ignite one after another (windows, roof holes,
  // roof tops), outward from where it started, and the smoke thickens. A
  // building that burns long at very low HP exposes close neighbours, which
  // catch fire on the side facing it. Repair (damage falling) puts the fires
  // out one by one.
  private burnT = 0;
  private exposure = 0;
  private exposeAcc = 0;
  private lit = 0;
  private litT = 0;
  private lastT = -1;
  private fires: { fire: DamageFx; smoke: DamageFx }[] | null = null;
  private fireSrc: THREE.Vector3 | null = null;

  /** Candidate fire points (root-local): windows (flames licking out), roof holes, roof tops; ordered from `from` outwards. */
  private firePoints(from: THREE.Vector3) {
    if (this.variant < 0) this.pickVariant();
    const an = this.tpl.analysis;
    const rec = this.tpl.rec;
    const pts: THREE.Vector3[] = [];
    const wins = rec.wins;
    const nW = Math.floor(wins.length / 7);
    const stride = Math.max(1, Math.floor(nW / 9));
    for (let i = 0; i < nW; i += stride) {
      const o = i * 7;
      pts.push(new THREE.Vector3(wins[o] + wins[o + 3] * 0.06, wins[o + 1] + wins[o + 6] * 0.5, wins[o + 2] + wins[o + 4] * 0.06));
    }
    for (const h of an.plans[this.variant].holes) if (h) pts.push(new THREE.Vector3(h.x, h.y, h.z));
    for (const c of an.comps) {
      const cx = (c.x0 + c.x1) / 2;
      const cz = (c.z0 + c.z1) / 2;
      pts.push(new THREE.Vector3(cx, c.h, cz));
      if (c.x1 - c.x0 > 0.9) for (const k of [-0.3, 0.3]) pts.push(new THREE.Vector3(cx + (c.x1 - c.x0) * k, c.h, cz));
      if (c.z1 - c.z0 > 0.9) for (const k of [-0.3, 0.3]) pts.push(new THREE.Vector3(cx, c.h, cz + (c.z1 - c.z0) * k));
    }
    const out: THREE.Vector3[] = [];
    for (const p of pts) if (Number.isFinite(p.x + p.y + p.z) && !out.some((q) => q.distanceToSquared(p) < 0.04)) out.push(p);
    out.sort((a, b) => a.distanceToSquared(from) - b.distanceToSquared(from));
    return out.slice(0, 11).map((p) => {
      const fire: DamageFx = { pos: p, kind: 'fire', at: 9 };
      const smoke: DamageFx = { pos: p.clone().setY(p.y + 0.25), kind: 'smoke', at: 9 };
      this.damageFx.push(fire, smoke);
      return { fire, smoke };
    });
  }

  private burn(s: AnimState) {
    const dt = s.dt;
    const d = s.built >= 1 ? s.damage : 0;
    this.lastT = s.time;
    if (d < 0.5 && this.burnT === 0 && this.exposure === 0 && this.lit === 0) {
      INFERNO.delete(this);
      return;
    }
    if (dt <= 0) return;
    // own heat: grows while the damage stays high, cools quickly once repaired
    if (d >= 0.5) this.burnT = Math.min(120, this.burnT + dt * (0.6 + d));
    else this.burnT = Math.max(0, this.burnT - dt * 4);
    // exposure from burning neighbours decays unless they keep it up
    this.exposure = Math.max(0, this.exposure - dt * 0.5);
    const n = this.fires ? this.fires.length : 11;
    const own = d >= 0.5 ? Math.min(1 + Math.floor(this.burnT / 2.2), Math.round(n * smooth(0.42, 0.95, d))) : 0;
    const ext = this.exposure > 6 ? Math.min(1 + Math.floor((this.exposure - 6) / 3), Math.ceil(n * 0.45)) : 0;
    const want = Math.max(own, ext);
    if (!this.fires) {
      if (want === 0) return; // only warming up (exposure below the ignition point)
      const from = this.fireSrc ?? this.damageFx[2]?.pos ?? new THREE.Vector3();
      this.fires = this.firePoints(from);
    }
    // one point at a time: spreads every ~0.9 s, goes out every ~0.6 s
    if (want !== this.lit) {
      this.litT += dt;
      if (want > this.lit && this.litT >= 0.9) {
        this.lit++;
        this.litT = 0;
      } else if (want < this.lit && this.litT >= 0.6) {
        this.lit--;
        this.litT = 0;
      }
    } else this.litT = 0;
    for (let i = 0; i < this.fires.length; i++) {
      const on = i < this.lit;
      this.fires[i].fire.at = on ? 0 : 9;
      // smoke thickens as more of the structure burns (one extra plume at 2, 5 and 9 points)
      this.fires[i].smoke.at = on && (i === 1 || i === 4 || i === 8) ? 0 : 9;
    }
    if (this.lit === 0 && want === 0 && this.burnT === 0) {
      // all out: next fire starts from wherever it is lit next
      this.fires = null;
      this.fireSrc = null;
      this.damageFx.length = FX_SLOTS.length;
      INFERNO.delete(this);
      return;
    }
    // inferno: long burn at very low HP sets close neighbours alight
    if (d >= 0.8 && this.burnT > 20) {
      INFERNO.add(this);
      this.exposeAcc += dt;
      if (this.exposeAcc >= 0.5) {
        const step = this.exposeAcc;
        this.exposeAcc = 0;
        const me = this.root.position;
        for (const o of ALL_FX) {
          if (o === this) continue;
          if (!o.root.parent || s.time - o.lastT > 1) {
            if (!o.root.parent) ALL_FX.delete(o);
            continue;
          }
          const op = o.root.position;
          const gx = Math.abs(op.x - me.x) - (o.tpl.info.w + this.tpl.info.w) / 2;
          const gz = Math.abs(op.z - me.z) - (o.tpl.info.d + this.tpl.info.d) / 2;
          if (Math.max(gx, gz) > 1.3) continue;
          o.exposure = Math.min(40, o.exposure + step * 1.6);
          if (!o.fires && !o.fireSrc) {
            // the neighbour's fire starts on the side facing us
            o.fireSrc = o.root.worldToLocal(me.clone()).multiplyScalar(0.5);
          }
        }
      }
    } else INFERNO.delete(this);
  }

  // ------------------------------------------------------------ damage
  private damage(s: AnimState) {
    const d = s.damage;
    const U = this.U!;
    const p = this.tpl.analysis.plans[this.variant];
    for (let k = 0; k < 4; k++) {
      const o = k * 8;
      const on = d >= CUT_AT[k] && !Number.isNaN(p.cuts[o]);
      if (on) {
        U.bxR.value[k].set(p.cuts[o], p.cuts[o + 1], p.cuts[o + 2], p.cuts[o + 3]);
        U.bxP.value[k].set(p.cuts[o + 4], p.cuts[o + 5], p.cuts[o + 6], p.cuts[o + 7]);
      } else {
        U.bxR.value[k].copy(_v4.set(1, 1, 0, 0));
        U.bxP.value[k].set(99, 0, 0, 0);
      }
    }
    U.bxSoot.value = 0.85 * smooth(0.2, 0.95, d);
    U.bxHit.value = s.built >= 1 ? 0.15 + 0.85 * smooth(D_ON, 0.9, d) : 0;
    this.glassFx(s);
    // overlays (lazily built per template variant and tier)
    for (let k = 0; k < 4; k++) {
      const on = d >= TIER[k] && s.built >= 1;
      let t = this.tiers[k];
      if (on && !t) {
        t = this.tpl.overlay(this.variant, k).clone(true);
        this.tiers[k] = t;
        this.fx().add(t);
      }
      if (t) t.visible = on;
    }
    // window / lamp glow: dark while building, dimmer and flickering when damaged
    const pw = s.powered;
    const dim = s.built < 0.97 ? 0 : (pw ? 1 : 0.22) * (1 - smooth(0.15, 0.75, d) * 0.88);
    let fl = 1;
    if ((!pw && d >= D_ON) || d >= 0.6) {
      const t = s.time;
      const q = Math.sin(t * 23.1 + this.seed) * Math.sin(t * 7.7 + this.seed * 0.37);
      fl = q > (pw ? 0.55 : 0.2) ? 0.12 : 1;
    }
    for (const g of this.glowClones) g.emissiveIntensity = (g.userData.baseEI as number) * dim * fl;
  }
}
