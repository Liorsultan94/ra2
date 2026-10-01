import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { factionCamo, pbr, worldUV, type TexOpts } from '../textures';
import type { Builder } from './registry';
import { decalQuad, makeDecalMaterial, roundelCell } from './insignia';
import type { AnimState, Model, ModelStyle, MunitionKind, MunitionModel } from './types';
import { WearDriver, isWearMaterial, wearPatch, type WearCfg } from './wear';

/*
 * Procedural aircraft, drones and munitions.
 *
 * Every airframe is modelled in METRES from the real type's dimensions
 * (x = -distance from the nose, y up, z = starboard) with lofted
 * super-elliptic fuselage stations, NACA-section wing panels and lathed
 * stores, then scaled to game size. Static parts are merged per material
 * (textured skin, glass, vertex-coloured detail, lights); rotors, props and
 * the afterburner plume are separate groups driven by model.anim().
 *
 * Templates are cached per (key, faction, team, fog) and cloned per unit.
 */

type V3 = [number, number, number];
type P2 = [number, number];
const PI = Math.PI;
const TAU = PI * 2;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

// =================================================================== geometry

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

/** Non-indexed, position + normal (+uv when kept) so everything merges. */
function prep(g: THREE.BufferGeometry, keepUV = false): THREE.BufferGeometry {
  const o = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(o.attributes)) if (k !== 'position' && k !== 'normal' && !(keepUV && k === 'uv') && k !== 'color') o.deleteAttribute(k);
  if (!o.attributes.normal) o.computeVertexNormals();
  return o;
}

function tf<T extends THREE.BufferGeometry>(g: T, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 = [1, 1, 1]): T {
  _m.compose(_p.set(p[0], p[1], p[2]), _q.setFromEuler(_e.set(r[0], r[1], r[2])), _s.set(s[0], s[1], s[2]));
  g.applyMatrix4(_m);
  return g;
}

function flipWinding(g: THREE.BufferGeometry) {
  for (const name of Object.keys(g.attributes)) {
    const a = g.attributes[name] as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    const n = a.itemSize;
    for (let t = 0; t < a.count; t += 3) {
      for (let c = 0; c < n; c++) {
        const i1 = (t + 1) * n + c;
        const i2 = (t + 2) * n + c;
        const tmp = arr[i1];
        arr[i1] = arr[i2];
        arr[i2] = tmp;
      }
    }
    a.needsUpdate = true;
  }
}

/** Mirror across the XY plane (port <-> starboard), fixing the winding. */
function mirZ(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const c = prep(g.clone());
  c.scale(1, 1, -1);
  flipWinding(c);
  return c;
}

/** Skin a closed surface through rings of equal vertex count (caps optional). Orientation fixed by signed volume. */
function fromRings(rings: THREE.Vector3[][], cap0 = true, cap1 = true): THREE.BufferGeometry {
  const n = rings[0].length;
  const R = rings.length;
  const pos: number[] = [];
  const idx: number[] = [];
  for (const r of rings) for (const p of r) pos.push(p.x, p.y, p.z);
  for (let i = 0; i < R - 1; i++)
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      const a = i * n + j;
      const b = i * n + j1;
      const c = (i + 1) * n + j;
      const d = (i + 1) * n + j1;
      idx.push(a, c, b, b, c, d);
    }
  const cap = (r: THREE.Vector3[], end: boolean) => {
    const base = pos.length / 3;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (const p of r) {
      pos.push(p.x, p.y, p.z);
      cx += p.x / n;
      cy += p.y / n;
      cz += p.z / n;
    }
    pos.push(cx, cy, cz);
    const ci = base + n;
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      if (end) idx.push(ci, base + j1, base + j);
      else idx.push(ci, base + j, base + j1);
    }
  };
  if (cap0) cap(rings[0], false);
  if (cap1) cap(rings[R - 1], true);
  // signed volume about the vertex centroid
  let ox = 0;
  let oy = 0;
  let oz = 0;
  const nv = pos.length / 3;
  for (let i = 0; i < nv; i++) {
    ox += pos[i * 3] / nv;
    oy += pos[i * 3 + 1] / nv;
    oz += pos[i * 3 + 2] / nv;
  }
  let vol = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3;
    const b = idx[t + 1] * 3;
    const c = idx[t + 2] * 3;
    const ax = pos[a] - ox, ay = pos[a + 1] - oy, az = pos[a + 2] - oz;
    const bx = pos[b] - ox, by = pos[b + 1] - oy, bz = pos[b + 2] - oz;
    const cx = pos[c] - ox, cy = pos[c + 1] - oy, cz = pos[c + 2] - oz;
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol < 0)
    for (let t = 0; t < idx.length; t += 3) {
      const tmp = idx[t + 1];
      idx[t + 1] = idx[t + 2];
      idx[t + 2] = tmp;
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g.toNonIndexed();
}

/** Fuselage station: d = distance from the nose (m), w = half width, t/b = half height above/below y, z = lateral centre,
 *  a = horizontal exponent (<1 boxy), e = vertical exponent (>1 sharp chines at the sides). */
interface St {
  d: number;
  w: number;
  t: number;
  b?: number;
  y?: number;
  z?: number;
  a?: number;
  e?: number;
}
type StF = Required<St>;

function fullSt(s: St): StF {
  return { d: s.d, w: s.w, t: s.t, b: s.b ?? s.t, y: s.y ?? 0, z: s.z ?? 0, a: s.a ?? 1, e: s.e ?? 1 };
}

/** Catmull-Rom subdivision of stations for smooth longitudinal curvature. */
function smoothSt(sts: St[], sub: number): StF[] {
  const f = sts.map(fullSt);
  if (sub <= 1 || f.length < 3) return f;
  const keys: (keyof StF)[] = ['d', 'w', 't', 'b', 'y', 'z', 'a', 'e'];
  const out: StF[] = [];
  for (let i = 0; i < f.length - 1; i++) {
    const p0 = f[Math.max(0, i - 1)];
    const p1 = f[i];
    const p2 = f[i + 1];
    const p3 = f[Math.min(f.length - 1, i + 2)];
    for (let s = 0; s < sub; s++) {
      const t = s / sub;
      const o = {} as StF;
      for (const k of keys) {
        const a = p0[k];
        const b = p1[k];
        const c = p2[k];
        const d = p3[k];
        o[k] = 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
      }
      o.w = Math.max(0.002, o.w);
      o.t = Math.max(0.002, o.t);
      o.b = Math.max(0.002, o.b);
      out.push(o);
    }
  }
  out.push(f[f.length - 1]);
  return out;
}

function stRing(s: StF, n: number): THREE.Vector3[] {
  const r: THREE.Vector3[] = [];
  for (let j = 0; j < n; j++) {
    const th = (j / n) * TAU;
    const c = Math.cos(th);
    const sn = Math.sin(th);
    const z = s.z + s.w * Math.sign(c) * Math.abs(c) ** s.a;
    const h = sn >= 0 ? s.t : s.b;
    const y = s.y + h * Math.sign(sn) * Math.abs(sn) ** s.e;
    r.push(new THREE.Vector3(-s.d, y, z));
  }
  return r;
}

function loft(sts: St[], n = 16, sub = 2, cap0 = true, cap1 = true): THREE.BufferGeometry {
  return fromRings(smoothSt(sts, sub).map((s) => stRing(s, n)), cap0, cap1);
}

/** Wing section: leading edge at d, chord c, spanwise position z, height y, thickness ratio t. */
interface Sec {
  d: number;
  c: number;
  z: number;
  y?: number;
  t?: number;
}
const AFU = [1, 0.9, 0.75, 0.58, 0.42, 0.28, 0.16, 0.07, 0.02, 0];
const yt = (u: number) => 5 * (0.2969 * Math.sqrt(u) - 0.126 * u - 0.3516 * u * u + 0.2843 * u ** 3 - 0.1036 * u ** 4);

function afRing(s: Sec): THREE.Vector3[] {
  const t = s.t ?? 0.05;
  const y0 = s.y ?? 0;
  const half = (u: number) => Math.max(0.004, yt(u) * t * s.c);
  const pts: THREE.Vector3[] = [];
  for (const u of AFU) pts.push(new THREE.Vector3(-(s.d + u * s.c), y0 + (u === 1 ? 0 : half(u)), s.z));
  for (let i = AFU.length - 2; i >= 1; i--) {
    const u = AFU[i];
    pts.push(new THREE.Vector3(-(s.d + u * s.c), y0 - half(u), s.z));
  }
  return pts;
}

/** Lifting surface through sections (spanwise along +Z). */
function wing(secs: Sec[]): THREE.BufferGeometry {
  return fromRings(secs.map(afRing));
}

/** Interpolate a section between two at fraction f of the span. */
function lerpSec(a: Sec, b: Sec, f: number, thick = 1): Sec {
  const l = (x: number, y: number) => x + (y - x) * f;
  return { d: l(a.d, b.d), c: l(a.c, b.c), z: l(a.z, b.z), y: l(a.y ?? 0, b.y ?? 0), t: l(a.t ?? 0.05, b.t ?? 0.05) * thick };
}

/** Vertical/canted surface: sections with z = height above the root, placed at p and canted outboard (rad from vertical, + leans to +Z). */
function fin(secs: Sec[], p: V3, cant = 0): THREE.BufferGeometry {
  return tf(wing(secs), p, [cant - PI / 2, 0, 0]);
}

/** Horizontal plate from a (d, z) outline. */
function slab(pts: P2[], th: number, y = 0, bevel = th * 0.35): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([d, z]) => new THREE.Vector2(-d, z)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, steps: 1, curveSegments: 4 });
  return tf(g, [0, y + th / 2, 0], [PI / 2, 0, 0]);
}

/** Vertical plate from a (d, y) outline. */
function plate(pts: P2[], th: number, z = 0, bevel = th * 0.35): THREE.BufferGeometry {
  const sh = new THREE.Shape(pts.map(([d, y]) => new THREE.Vector2(-d, y)));
  const g = new THREE.ExtrudeGeometry(sh, { depth: th, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1, steps: 1, curveSegments: 4 });
  return tf(g, [0, 0, z - th / 2]);
}

/** Solid of revolution about the X axis; profile = (d from nose, radius). */
function lathe(prof: P2[], seg = 12, p: V3 = [0, 0, 0]): THREE.BufferGeometry {
  const pts = prof.map(([d, r]) => new THREE.Vector2(Math.max(0.0005, r), -d));
  const g = new THREE.LatheGeometry(pts, seg);
  g.rotateZ(-PI / 2);
  // fix orientation (lathe winding depends on profile direction)
  const pg = prep(g);
  const pos = pg.attributes.position;
  let vol = 0;
  for (let t = 0; t < pos.count; t += 3) {
    const ax = pos.getX(t), ay = pos.getY(t), az = pos.getZ(t);
    const bx = pos.getX(t + 1), by = pos.getY(t + 1), bz = pos.getZ(t + 1);
    const cx = pos.getX(t + 2), cy = pos.getY(t + 2), cz = pos.getZ(t + 2);
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  if (vol < 0) {
    flipWinding(pg);
    pg.computeVertexNormals();
  }
  return tf(pg, p);
}

const box = (w: number, h: number, d: number, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0]) => tf(prep(new THREE.BoxGeometry(w, h, d)), p, r);
/** Cylinder along X (r0 at front/+X, r1 at back). */
const cylX = (r0: number, r1: number, len: number, seg: number, p: V3 = [0, 0, 0]) => tf(prep(new THREE.CylinderGeometry(r0, r1, len, seg)), p, [0, 0, -PI / 2]);
const cylY = (r0: number, r1: number, h: number, seg: number, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0]) => tf(prep(new THREE.CylinderGeometry(r0, r1, h, seg)), p, r);
const cylZ = (r: number, len: number, seg: number, p: V3 = [0, 0, 0]) => tf(prep(new THREE.CylinderGeometry(r, r, len, seg)), p, [PI / 2, 0, 0]);
const sph = (r: number, p: V3 = [0, 0, 0], s: V3 = [1, 1, 1], ws = 10, hs = 7) => tf(prep(new THREE.SphereGeometry(r, ws, hs)), p, [0, 0, 0], s);
/** Flat ellipse facing +X (intake mouths, nozzle glows when flipped). */
const discX = (rz: number, ry: number, p: V3, back = false, seg = 14) => tf(prep(new THREE.CircleGeometry(1, seg)), p, [0, back ? -PI / 2 : PI / 2, 0], [rz, ry, 1]);

// =================================================================== kit

type Bk = 'skin' | 'skin2' | 'glass' | 'vc' | 'blade' | 'glow' | 'lit' | 'strobe' | 'disc' | 'plume' | 'decal';
const _c = new THREE.Color();

function colorize(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _c.setHex(hex);
  const n = g.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = _c.r;
    a[i * 3 + 1] = _c.g;
    a[i * 3 + 2] = _c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

interface Kid {
  kit: Kit;
  pos: V3;
  rot: V3;
  tag: Record<string, unknown>;
}

class Kit {
  parts = new Map<Bk, THREE.BufferGeometry[]>();
  kids: Kid[] = [];
  muz: V3[] = [];
  lights: { kind: 'lit' | 'strobe' | 'beacon'; hex: number; p: V3; r: number }[] = [];
  disc: string | null = null;
  decals: { v: boolean; d: number; y: number; z: number; r: number; nation: string; side: number; lowVis: boolean }[] = [];

  add(b: Bk, g: THREE.BufferGeometry | THREE.BufferGeometry[]) {
    const list = this.parts.get(b) ?? [];
    for (const x of Array.isArray(g) ? g : [g]) {
      const p = prep(x, b === 'disc' || b === 'decal');
      if (b !== 'vc' && b !== 'blade' && b !== 'lit' && b !== 'strobe' && b !== 'plume' && b !== 'decal' && p.attributes.color) p.deleteAttribute('color');
      list.push(p);
    }
    this.parts.set(b, list);
    return this;
  }
  /** Add mirrored pair. */
  sym(b: Bk, g: THREE.BufferGeometry) {
    const p = prep(g);
    return this.add(b, [p, mirZ(p)]);
  }
  col(g: THREE.BufferGeometry, hex: number) {
    return this.add('vc', colorize(prep(g), hex));
  }
  symc(g: THREE.BufferGeometry, hex: number) {
    const p = prep(g);
    return this.add('vc', [colorize(p, hex), colorize(mirZ(p), hex)]);
  }
  sub(pos: V3, rot: V3 = [0, 0, 0], tag: Record<string, unknown> = {}): Kit {
    const k = new Kit();
    this.kids.push({ kit: k, pos, rot, tag });
    return k;
  }
  muzzle(p: V3) {
    this.muz.push(p);
  }
  /** Navigation / strobe light; r in world units (sized when the kit is realised at its final scale). */
  light(kind: 'lit' | 'strobe' | 'beacon', hex: number, p: V3, r = 0.011) {
    this.lights.push({ kind, hex, p, r });
  }
}

// =================================================================== materials

const fogIds = new WeakMap<FogOfWar, number>();
let fogN = 0;
function fid(fog: FogOfWar | null) {
  if (!fog) return 0;
  let i = fogIds.get(fog);
  if (!i) fogIds.set(fog, (i = ++fogN));
  return i;
}
const mats = new Map<string, THREE.Material>();
function cmat<T extends THREE.Material>(key: string, fog: FogOfWar | null, make: () => T): T {
  const k = `${key}|${fid(fog)}`;
  let m = mats.get(k) as T | undefined;
  if (!m) {
    m = make();
    if (fog) fog.apply(m);
    mats.set(k, m);
  }
  return m;
}

interface SkinSpec {
  color: number;
  camo?: TexOpts;
  uv?: number; // texture repeats per metre
  metal?: number;
  rough?: number;
}

const AIR_WEAR: WearCfg = { dirt: false, loose: false, scale: 0.62 };
/** Battle-damage patch (soot, scorch, darkened panels) on a cached material. */
function worn<T extends THREE.Material>(m: T): T {
  if (!isWearMaterial(m)) wearPatch(m, AIR_WEAR);
  return m;
}
const decalMat = (fog: FogOfWar | null) => worn(cmat('decal', fog, makeDecalMaterial));

function skinMat(s: SkinSpec, fog: FogOfWar | null) {
  return worn(skinMatRaw(s, fog));
}
function skinMatRaw(s: SkinSpec, fog: FogOfWar | null) {
  return cmat('skin' + JSON.stringify(s), fog, () => {
    const set = s.camo ? pbr('camo', s.camo) : pbr('metalPanel', { color: 0xe4e4e4, grime: 0.15, seed: 23, divisions: 3 });
    return new THREE.MeshStandardMaterial({
      map: set.map,
      normalMap: set.normalMap,
      roughnessMap: set.roughnessMap,
      color: s.camo ? 0xffffff : s.color,
      metalness: s.metal ?? (s.camo ? 0.2 : 0.35),
      roughness: s.rough ?? 0.85,
      normalScale: new THREE.Vector2(0.6, 0.6),
    });
  });
}

const glassMat = (hex: number, fog: FogOfWar | null) =>
  cmat('glass' + hex, fog, () => new THREE.MeshStandardMaterial({ color: hex, metalness: 0.85, roughness: 0.12, envMapIntensity: 1.6 }));
const vcMat = (fog: FogOfWar | null) => worn(cmat('vc', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.55 })));
const bladeMat = (fog: FogOfWar | null) => cmat('blade', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.3, roughness: 0.6, transparent: true, opacity: 0.72 }));
const litMat = (fog: FogOfWar | null) => cmat('lit', fog, () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
const strobeMat = (fog: FogOfWar | null) => cmat('strobe', fog, () => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false }));
const plumeMat = (fog: FogOfWar | null) =>
  cmat('plume', fog, () => new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide, toneMapped: false }));
function nozzleGlow(fog: FogOfWar | null) {
  const m = new THREE.MeshStandardMaterial({ color: 0x1a0d05, emissive: 0xff7a2a, emissiveIntensity: 2.2, roughness: 1, metalness: 0 });
  if (fog) fog.apply(m);
  return m;
}

/** Motion-blurred rotor disc: n blade smears trailing behind each blade in the spin direction. */
const discTex = new Map<string, THREE.Texture>();
function rotorDiscTexture(n: number, dir: number): THREE.Texture {
  const key = `${n}|${dir}`;
  let t = discTex.get(key);
  if (t) return t;
  const N = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = N;
  const ctx = cv.getContext('2d')!;
  const c = N / 2;
  // alphaMap samples the green channel: paint grey levels on opaque black
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, N, N);
  ctx.fillStyle = 'rgba(255,255,255,0.09)';
  ctx.beginPath();
  ctx.arc(c, c, c - 1, 0, TAU);
  ctx.fill();
  const steps = 18;
  const sweep = (TAU / n) * 0.55;
  for (let k = 0; k < n; k++) {
    const a0 = -(k * TAU) / n;
    for (let i = 0; i < steps; i++) {
      const f = i / steps;
      const al = 0.4 * (1 - f) ** 2;
      const s0 = a0 + dir * f * sweep;
      const s1 = a0 + dir * (f + 1 / steps) * sweep;
      ctx.fillStyle = `rgba(255,255,255,${al})`;
      ctx.beginPath();
      ctx.moveTo(c, c);
      ctx.arc(c, c, c - 1, Math.min(s0, s1), Math.max(s0, s1));
      ctx.closePath();
      ctx.fill();
    }
  }
  // tip path ring; hub area cleared
  ctx.strokeStyle = 'rgba(255,255,255,0.25)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(c, c, c - 3, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = '#000';
  ctx.beginPath();
  ctx.arc(c, c, N * 0.06, 0, TAU);
  ctx.fill();
  t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.NoColorSpace;
  discTex.set(key, t);
  return t;
}
function discMat(key: string, fog: FogOfWar | null) {
  const [n, dir] = key.split('|').map(Number);
  return cmat('disc' + key, fog, () => new THREE.MeshStandardMaterial({ color: 0x55595e, alphaMap: rotorDiscTexture(n, dir), transparent: true, depthWrite: false, side: THREE.DoubleSide, roughness: 0.7, metalness: 0.2 }));
}

interface Paint {
  skin: SkinSpec;
  skin2?: SkinSpec;
  glass: number;
}

const UVS = 0.3;

function realize(k: Kit, p: Paint, fog: FogOfWar | null, S: number): THREE.Group {
  const g = new THREE.Group();
  for (const l of k.lights) {
    const lg = sph(l.r / S, l.p, [1, 1, 1], 6, 4);
    // steady nav lights in one mesh; strobes + red beacons share one blinking mesh
    k.add(l.kind === 'lit' ? 'lit' : 'strobe', colorize(lg, l.hex));
  }
  k.lights = [];
  for (const [b, list] of k.parts) {
    if (!list.length) continue;
    const geo = list.length === 1 ? list[0] : mergeGeometries(list, false);
    if (!geo) continue;
    let mat: THREE.Material;
    switch (b) {
      case 'skin':
        worldUV(geo, p.skin.uv ?? UVS);
        mat = skinMat(p.skin, fog);
        break;
      case 'skin2':
        worldUV(geo, (p.skin2 ?? p.skin).uv ?? UVS);
        mat = skinMat(p.skin2 ?? p.skin, fog);
        break;
      case 'glass':
        mat = glassMat(p.glass, fog);
        break;
      case 'vc':
        mat = vcMat(fog);
        break;
      case 'blade':
        mat = bladeMat(fog);
        break;
      case 'glow':
        mat = nozzleGlow(null); // replaced per instance
        break;
      case 'lit':
        mat = litMat(fog);
        break;
      case 'strobe':
        mat = strobeMat(fog);
        break;
      case 'plume':
        mat = plumeMat(fog);
        break;
      case 'disc':
        mat = discMat(k.disc ?? '4|1', fog);
        break;
      case 'decal':
        mat = decalMat(fog);
        break;
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.bk = b;
    mesh.castShadow = b === 'skin' || b === 'skin2' || b === 'vc' || b === 'glass';
    if (b === 'decal') mesh.receiveShadow = true;
    mesh.receiveShadow = b === 'skin' || b === 'skin2';
    if (b === 'disc' || b === 'plume') mesh.renderOrder = 2;
    if (b === 'blade') mesh.renderOrder = 3;
    g.add(mesh);
  }
  for (const kid of k.kids) {
    const cg = realize(kid.kit, p, fog, S);
    cg.position.set(...kid.pos);
    cg.rotation.set(...kid.rot);
    Object.assign(cg.userData, kid.tag);
    g.add(cg);
  }
  for (const m of k.muz) {
    const o = new THREE.Object3D();
    o.position.set(...m);
    o.userData.muzzle = true;
    g.add(o);
  }
  return g;
}

// =================================================================== shared parts (metres)

const C = {
  white: 0xe9e9e4,
  offwhite: 0xd8d8d0,
  grey: 0x8c9196,
  dgrey: 0x4a4e52,
  black: 0x1c1d1f,
  gun: 0x2e3134,
  metal: 0x6d6a66,
  burnt: 0x4c4440,
  ti: 0x8a8378,
  olive: 0x4f5a3a,
  yellow: 0xd8b02a,
  brown: 0x6b4a2a,
  rubber: 0x1a1a1a,
  sensor: 0x2b2f33,
  red: 0xff2a1a,
  green: 0x2bff5a,
  wlight: 0xfff4e0,
  intake: 0x101112,
};

interface MissileOpt {
  seg?: number;
  body?: number;
  nose?: number;
  band?: number;
  mid?: boolean; // mid-body wings
  canard?: boolean;
  fin?: number; // fin span (x radius)
  grid?: boolean;
}

/** Air-launched missile, nose at d, centred at (y, z). */
function missile(k: Kit, d: number, y: number, z: number, len: number, r: number, o: MissileOpt = {}) {
  const body = o.body ?? C.white;
  const nose = o.nose ?? 0x9a9c98;
  const L = len;
  const prof: P2[] = [
    [0, 0],
    [L * 0.025, r * 0.45],
    [L * 0.07, r * 0.85],
    [L * 0.11, r],
    [L * 0.98, r],
    [L, r * 0.75],
    [L, 0],
  ];
  k.add('vc', bandLathe(prof, o.seg ?? 8, [-d, y, z], (f) => (f < 0.105 ? nose : o.band !== undefined && f > 0.18 && f < 0.215 ? o.band : f > 0.99 ? C.black : body)));
  const fs = o.fin ?? r * 2.6;
  for (let i = 0; i < 4; i++) {
    const a = PI / 4 + (i * PI) / 2;
    const tail = slab(
      [
        [L * 0.86, 0],
        [L * 0.94, fs],
        [L, fs],
        [L, 0],
      ],
      r * 0.12,
      0,
      0,
    );
    k.col(tf(tail, [-d, y, z], [a, 0, 0]), o.grid ? C.dgrey : body);
    if (o.mid) k.col(tf(slab([[L * 0.38, 0], [L * 0.55, fs * 0.75], [L * 0.6, fs * 0.75], [L * 0.6, 0]], r * 0.1, 0, 0), [-d, y, z], [a, 0, 0]), body);
    if (o.canard) k.col(tf(slab([[L * 0.12, 0], [L * 0.18, fs * 0.6], [L * 0.22, fs * 0.6], [L * 0.2, 0]], r * 0.1, 0, 0), [-d, y, z], [a, 0, 0]), body);
  }
}

/** Lathe (profile in metres from the nose) coloured per triangle by fn(fraction of length); band edges get their own rings. */
function bandLathe(prof: P2[], seg: number, p: V3, fn: (f: number) => number): THREE.BufferGeometry {
  const L = prof[prof.length - 1][0] || 1;
  const pts: P2[] = [prof[0]];
  for (let i = 1; i < prof.length; i++) {
    const [d0, r0] = prof[i - 1];
    const [d1, r1] = prof[i];
    if (d1 > d0) {
      let prev = fn(d0 / L + 1e-4);
      for (let f = d0 / L + 0.004; f < d1 / L; f += 0.004) {
        const c = fn(f);
        if (c !== prev) {
          const dd = f * L;
          pts.push([dd, r0 + ((r1 - r0) * (dd - d0)) / (d1 - d0)]);
          prev = c;
        }
      }
    }
    pts.push(prof[i]);
  }
  return bandColor(lathe(pts, seg, p), (x) => fn((p[0] - x) / L));
}

/** Underwing pylon from (d0..d1) hanging from y0 down to y1. */
function pylon(k: Kit, d0: number, d1: number, y0: number, y1: number, z: number, th = 0.12, bucket: Bk = 'skin') {
  const h = y0 - y1;
  const g = plate(
    [
      [d0 + h * 0.4, y1],
      [d0, y0],
      [d1, y0],
      [d1 - h * 0.3, y1],
    ],
    th,
    z,
    th * 0.3,
  );
  k.add(bucket, g);
}

/** Drop tank / pod. */
function tank(k: Kit, d: number, y: number, z: number, len: number, r: number, bucket: Bk = 'skin') {
  k.add(
    bucket,
    lathe(
      [
        [0, 0],
        [len * 0.08, r * 0.6],
        [len * 0.25, r],
        [len * 0.7, r],
        [len * 0.95, r * 0.45],
        [len, 0],
      ],
      12,
      [-d, y, z],
    ),
  );
}

/** Rocket pod with open tube face. */
function rocketPod(k: Kit, d: number, y: number, z: number, len: number, r: number, color = 0x4b5238) {
  k.col(
    lathe(
      [
        [0, r * 0.9],
        [len * 0.04, r],
        [len * 0.96, r],
        [len, r * 0.85],
        [len, 0],
      ],
      12,
      [-d, y, z],
    ),
    color,
  );
  k.col(discX(r * 0.86, r * 0.86, [-d + 0.005, y, z], false, 12), 0x16181a);
  // tube rims
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * TAU;
    k.col(discX(r * 0.16, r * 0.16, [-d + 0.012, y + Math.sin(a) * r * 0.55, z + Math.cos(a) * r * 0.55], false, 6), 0x5a5d58);
  }
}

/** Hellfire-type 4-round rack (2x2) with launcher rail; returns the muzzle point. */
function hellfireRack(k: Kit, d: number, y: number, z: number, len = 1.63, r = 0.09, color = 0x4c5636): V3 {
  k.col(box(len * 0.9, r * 0.8, r * 1.2, [-d - len * 0.48, y, z]), 0x3a3d36);
  for (const dy of [r * 1.25, -r * 1.25])
    for (const dz of [-r * 1.25, r * 1.25]) missile(k, d, y + dy * 0.9, z + dz, len, r, { body: color, nose: 0x2a2c2a, band: C.yellow, fin: r * 1.6, seg: 6 });
  return [-d + 0.05, y, z];
}

/** Tube launcher box (Vikhr, TOW, Spike). */
function tubeBox(k: Kit, d: number, y: number, z: number, len: number, r: number, nx: number, ny: number, color: number) {
  const W = nx * r * 2.1;
  const H = ny * r * 2.1;
  k.col(box(len, H, W, [-d - len / 2, y, z]), color);
  for (let i = 0; i < nx; i++)
    for (let j = 0; j < ny; j++) k.col(discX(r * 0.75, r * 0.75, [-d + 0.006, y - H / 2 + r * 1.05 + j * r * 2.1, z - W / 2 + r * 1.05 + i * r * 2.1], false, 8), 0x141516);
}

function wheel(k: Kit, d: number, y: number, z: number, r: number, w: number) {
  k.col(cylZ(r, w, 12, [-d, y, z]), C.rubber);
  k.col(cylZ(r * 0.55, w * 1.05, 8, [-d, y, z]), 0x7a7c78);
}

/** Main rotor: blades + hub + blurred disc spinning about local Y. */
function rotor(k: Kit, pos: V3, R: number, n: number, chord: number, speed: number, o: { phase?: number; hub?: number; color?: number; th?: number; sweep?: boolean } = {}) {
  const sp = k.sub(pos, [0, o.phase ?? 0, 0], { spin: speed });
  const hubR = o.hub ?? R * 0.07;
  const th = o.th ?? chord * 0.14;
  const col = o.color ?? 0x2a2c2a;
  for (let i = 0; i < n; i++) {
    const a = (i * TAU) / n;
    const tip = o.sweep ? chord * 0.9 : chord * 0.25;
    const g = slab(
      [
        [-hubR, -chord * 0.3],
        [-(R - tip), -chord * 0.5],
        [-R, -chord * 0.1],
        [-R, chord * 0.5],
        [-hubR, chord * 0.4],
      ],
      th,
      -th / 2,
      th * 0.3,
    );
    sp.add('blade', colorize(tf(g, [0, 0, 0], [0, a, 0]), col));
    sp.add('blade', colorize(box(hubR * 1.4, th * 2.2, chord * 0.7, [hubR * 1.1, 0, 0]).rotateY(a), 0x3b3d3a));
    // yellow tip caps read as a spinning ring
    sp.add('blade', colorize(tf(box(chord * 0.45, th * 1.05, chord * 0.98, [R - chord * 0.22, 0, 0]), [0, 0, 0], [0, a, 0]), 0xc9b85a));
  }
  sp.add('blade', colorize(cylY(hubR * 0.9, hubR, th * 3.2, 10), 0x34363a));
  sp.add('disc', tf(prep(new THREE.CircleGeometry(R, 40), true), [0, -th * 0.6, 0], [-PI / 2, 0, 0]));
  sp.disc = `${n}|${speed >= 0 ? 1 : -1}`;
  return sp;
}

/** Tail rotor / propeller: blades spin about the axis given by orientation (rot maps local Y to the axis). */
function prop(k: Kit, pos: V3, rot: V3, R: number, n: number, chord: number, speed: number, o: { angles?: number[]; color?: number; spinner?: number; th?: number; noDisc?: boolean } = {}) {
  const holder = k.sub(pos, rot);
  const sp = holder.sub([0, 0, 0], [0, 0, 0], { spin: speed });
  const angles = o.angles ?? Array.from({ length: n }, (_, i) => (i * TAU) / n);
  const th = o.th ?? chord * 0.18;
  const col = o.color ?? 0x2a2c2a;
  for (const a of angles) {
    const g = slab(
      [
        [-R * 0.12, -chord * 0.35],
        [-R * 0.55, -chord * 0.5],
        [-R, -chord * 0.2],
        [-R, chord * 0.25],
        [-R * 0.55, chord * 0.45],
        [-R * 0.12, chord * 0.3],
      ],
      th,
      -th / 2,
      th * 0.3,
    );
    sp.add('blade', colorize(tf(g, [0, 0, 0], [0.25, a, 0]), col));
  }
  if (o.spinner) sp.add('blade', colorize(tf(lathe([[0, 0], [o.spinner * 0.8, o.spinner * 0.75], [o.spinner * 1.6, o.spinner], [o.spinner * 1.8, o.spinner]], 10), [0, o.spinner * 0.4, 0], [0, 0, PI / 2]), 0x4a4c4e));
  else sp.add('blade', colorize(cylY(R * 0.1, R * 0.1, th * 2.6, 8), 0x3a3c3e));
  if (!o.noDisc) {
    sp.add('disc', tf(prep(new THREE.CircleGeometry(R, 32), true), [0, 0, 0], [-PI / 2, 0, 0]));
    sp.disc = `${angles.length}|${speed >= 0 ? 1 : -1}`;
  }
  return sp;
}

/** Jet nozzle at d0 (base) extending len; centre (y, z). Adds nozzle glow + plume. */
function nozzle(k: Kit, d0: number, len: number, r0: number, r1: number, y: number, z: number, color = C.burnt, petals = 14) {
  const d1 = d0 + len;
  k.col(
    lathe(
      [
        [d0 - 0.05, r0 * 1.02],
        [d0 + len * 0.35, r0],
        [d1, r1],
        [d1 + 0.02, r1 * 0.9],
        [d0 + len * 0.6, r1 * 0.82],
        [d0 + len * 0.6, 0],
      ],
      petals,
      [0, y, z],
    ),
    color,
  );
  // dark inner liner and hot glow face
  k.col(cylX(r1 * 0.84, r1 * 0.8, len * 0.25, petals, [-(d0 + len * 0.72), y, z]), 0x151414);
  k.add('glow', discX(r1 * 0.72, r1 * 0.72, [-(d0 + len * 0.62) - 0.02, y, z], true, 16));
}

/** Additive afterburner plume group anchored at the nozzle exit plane (scaled in x by anim). */
function plume(k: Kit, d: number, ends: [number, number][], r: number) {
  const pk = k.sub([-d, 0, 0], [0, 0, 0], { plume: true });
  for (const [y, z] of ends) {
    const outer = colorizeGrad(tf(prep(new THREE.ConeGeometry(r * 0.9, r * 5.5, 14, 1, true)), [-r * 2.75, y, z], [0, 0, PI / 2]), [0.5, 0.2, 0.05], [0, 0, 0]);
    const inner = colorizeGrad(tf(prep(new THREE.ConeGeometry(r * 0.55, r * 2.6, 12, 1, true)), [-r * 1.3, y, z], [0, 0, PI / 2]), [0.55, 0.42, 0.3], [0.1, 0.03, 0.0]);
    pk.add('plume', [outer, inner]);
    // shock diamonds
    for (let i = 0; i < 3; i++) {
      const dd = r * (1.1 + i * 1.2);
      pk.add('plume', colorizeGrad(sph(r * 0.32, [-dd, y, z], [1.8, 1, 1], 8, 5), [0.45 - i * 0.12, 0.3 - i * 0.08, 0.16 - i * 0.04], [0.45 - i * 0.12, 0.3 - i * 0.08, 0.16 - i * 0.04]));
    }
  }
}

/** Vertex colours graded along -X from colour a (front) to colour b (back). */
function colorizeGrad(g: THREE.BufferGeometry, a: V3, b: V3): THREE.BufferGeometry {
  const pos = g.attributes.position;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (let i = 0; i < pos.count; i++) {
    x0 = Math.min(x0, pos.getX(i));
    x1 = Math.max(x1, pos.getX(i));
  }
  const arr = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const f = x1 > x0 ? (x1 - pos.getX(i)) / (x1 - x0) : 0;
    for (let c = 0; c < 3; c++) arr[i * 3 + c] = a[c] + (b[c] - a[c]) * f;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

const _dc = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(1, 0, 0);
const AFT = new THREE.Vector3(-1, 0, 0);
const STBD = new THREE.Vector3(0, 0, 1);

/** National insignia decal on a horizontal (wing / fuselage top) surface; r = radius in metres. Star points forward. */
function roundelH(k: Kit, d: number, y: number, z: number, r: number, nation: string, lowVis = false) {
  k.decals.push({ v: false, d, y, z, r, nation, side: 1, lowVis });
}
/** Insignia on a vertical side surface facing +Z (side = 1) or -Z. */
function roundelV(k: Kit, d: number, y: number, z: number, r: number, nation: string, side: number, lowVis = false) {
  k.decals.push({ v: true, d, y, z, r, nation, side, lowVis });
}

/** Snap the pending insignia onto the finished skin (ray cast) and add them as decal quads. */
function placeDecals(k: Kit) {
  if (!k.decals.length) return;
  const skin = [...(k.parts.get('skin') ?? []), ...(k.parts.get('skin2') ?? [])].map((g) => {
    const c = new THREE.BufferGeometry();
    c.setAttribute('position', g.attributes.position);
    if (g.index) c.setIndex(g.index);
    return c;
  });
  const geo = skin.length ? mergeGeometries(skin, false) : null;
  const mesh = geo ? new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide })) : null;
  mesh?.updateMatrixWorld(true);
  const rc = new THREE.Raycaster();
  const n = new THREE.Vector3();
  const u = new THREE.Vector3();
  const v = new THREE.Vector3();
  for (const p0 of k.decals) {
    // a little larger than the old ring stacks so they read at RTS zoom
    const p = { ...p0, r: p0.r * (p0.v ? 1.35 : 1.15) };
    const cell = roundelCell(p.nation, p.lowVis);
    let hit: THREE.Intersection | undefined;
    if (mesh) {
      if (p.v) rc.set(_dc.set(-p.d, p.y, p.side * 30), n.set(0, 0, -p.side));
      else rc.set(_dc.set(-p.d, 30, p.z), n.set(0, -1, 0));
      hit = rc.intersectObject(mesh, false)[0];
    }
    if (hit && hit.face && (p.v ? Math.abs(hit.point.z - p.z) < 0.6 : Math.abs(hit.point.y - p.y) < 0.6)) {
      n.copy(hit.face.normal);
      if (p.v ? n.z * p.side < 0 : n.y < 0) n.negate();
      if (p.v) {
        v.copy(UP).addScaledVector(n, -n.y).normalize();
      } else {
        v.copy(FWD).addScaledVector(n, -n.x).normalize();
      }
      u.crossVectors(v, n).normalize();
      _dc.copy(hit.point).addScaledVector(n, 0.01);
      k.add('decal', decalQuad(_dc, u, v, 2 * p.r * cell.aspect, 2 * p.r, cell));
    } else if (p.v) {
      k.add('decal', decalQuad(_dc.set(-p.d, p.y, p.z + p.side * 0.012), p.side > 0 ? FWD : AFT, UP, 2 * p.r * cell.aspect, 2 * p.r, cell));
    } else {
      k.add('decal', decalQuad(_dc.set(-p.d, p.y + 0.012, p.z), STBD, FWD, 2 * p.r * cell.aspect, 2 * p.r, cell));
    }
  }
  k.decals = [];
  geo?.dispose();
}

// national insignia per faction
const INSIGNIA: Record<string, string> = {
  usa: 'usa',
  israel: 'israel',
  russia: 'russia',
  china: 'china',
  germany: 'germany',
  korea: 'korea',
  ukraine: 'ukraine',
  turkey: 'turkey',
  iran: 'iran',
  neutral: 'usa',
};

// =================================================================== fighters

interface Built {
  S: number;
  paint: Paint;
  kind: 'jet' | 'heli' | 'uav' | 'quad' | 'loiter';
}

/** Pair of AIM-120-style missiles on underwing pylons (z = |span station|). Returns muzzles. */
function wingStores(k: Kit, d: number, yWing: number, z: number, len: number, r: number, o: MissileOpt, pyl = true) {
  for (const s of [-1, 1]) {
    if (pyl) pylon(k, d - 0.2, d + 1.6, yWing, yWing - 0.32, s * z);
    missile(k, d, yWing - 0.32 - r, s * z, len, r, o);
    k.muzzle([-d + 0.1, yWing - 0.32 - r, s * z]);
  }
}

function navLights(k: Kit, d: number, y: number, z: number, tailD: number, tailY: number) {
  k.light('lit', C.red, [-d, y, -z]);
  k.light('lit', C.green, [-d, y, z]);
  k.light('lit', C.wlight, [-tailD, tailY, 0], 0.008);
}

function teamFinCap(k: Kit, a: Sec, b: Sec, p: V3, cant: number, team: number, from = 0.62) {
  const lo = lerpSec(a, b, from, 1.3);
  const hi = lerpSec(b, b, 0, 1.3);
  hi.c *= 1.02;
  const g = fin([lo, hi], p, cant);
  k.symc(g, team);
}

function f35(k: Kit, team: number, israel: boolean): Built {
  // fuselage: wide blended stealth body with chines
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.03, t: 0.03, y: -0.05 },
        { d: 0.9, w: 0.34, t: 0.26, b: 0.22, y: -0.04, a: 0.95, e: 1.5 },
        { d: 2.1, w: 0.6, t: 0.42, b: 0.36, y: 0.0, a: 0.85, e: 1.5 },
        { d: 3.4, w: 0.8, t: 0.54, b: 0.45, y: 0.04, a: 0.8, e: 1.45 },
        { d: 4.8, w: 1.12, t: 0.6, b: 0.52, y: 0.05, a: 0.7, e: 1.4 },
        { d: 6.6, w: 1.48, t: 0.68, b: 0.58, y: 0.05, a: 0.6, e: 1.4 },
        { d: 9.6, w: 1.52, t: 0.74, b: 0.58, y: 0.05, a: 0.6, e: 1.4 },
        { d: 12.4, w: 1.28, t: 0.62, b: 0.52, y: 0.05, a: 0.7, e: 1.25 },
        { d: 14.2, w: 0.84, t: 0.57, b: 0.55, y: 0.05, a: 0.9, e: 1.05 },
        { d: 15.0, w: 0.66, t: 0.6, b: 0.6, y: 0.05 },
      ],
      22,
      3,
    ),
  );
  // caret intakes (DSI)
  for (const s of [-1, 1]) {
    const g = loft(
      [
        { d: 4.3, z: 1.12, w: 0.3, t: 0.34, b: 0.3, y: -0.02, a: 0.55, e: 0.8 },
        { d: 5.4, z: 1.12, w: 0.36, t: 0.42, b: 0.36, y: 0.0, a: 0.6, e: 0.8 },
        { d: 7.6, z: 0.95, w: 0.3, t: 0.4, b: 0.36, y: 0.05, a: 0.7 },
      ],
      12,
      2,
    );
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(discX(0.26, 0.29, [-4.29, -0.01, s * 1.12]), C.intake);
    k.add('skin', sph(0.24, [-4.1, 0.0, s * 0.8], [1.6, 0.9, 0.5])); // DSI bump
  }
  // canopy (single piece, gold tint) + frame
  k.add(
    'glass',
    loft(
      [
        { d: 1.8, w: 0.08, t: 0.03, b: 0.1, y: 0.42 },
        { d: 2.6, w: 0.32, t: 0.24, b: 0.2, y: 0.48 },
        { d: 3.6, w: 0.42, t: 0.38, b: 0.22, y: 0.52 },
        { d: 4.7, w: 0.38, t: 0.32, b: 0.22, y: 0.56 },
        { d: 5.6, w: 0.12, t: 0.06, b: 0.15, y: 0.62 },
      ],
      16,
      3,
    ),
  );
  k.add('skin2', box(0.12, 0.08, 0.86, [-4.0, 0.88, 0], [0, 0, 0.35]));
  // EOTS under nose
  k.add('glass', sph(0.17, [-1.7, -0.27, 0], [1.4, 0.8, 1], 6, 4));
  // wings (34 deg LE, forward-swept TE)
  const wr: Sec = { d: 6.2, c: 5.4, z: 1.2, y: 0.0, t: 0.05 };
  const wt: Sec = { d: 9.05, c: 1.55, z: 5.35, y: -0.05, t: 0.04 };
  k.sym('skin', wing([wr, wt]));
  // RAM edge (darker) on wing leading edges
  k.sym('skin2', wing([{ ...wr, c: 0.5, t: 0.06 }, { ...wt, c: 0.3, t: 0.05 }]));
  // horizontal tails
  k.sym('skin', wing([{ d: 12.6, c: 3.1, z: 0.9, y: 0.05, t: 0.04 }, { d: 14.4, c: 1.25, z: 3.4, y: 0.05, t: 0.035 }]));
  // canted twin fins
  const fr: Sec = { d: 11.1, c: 3.4, z: 0, t: 0.05 };
  const ft: Sec = { d: 13.05, c: 1.45, z: 2.25, t: 0.04 };
  const fp: V3 = [0, 0.55, 0.95];
  k.sym('skin', fin([fr, ft], fp, 0.35));
  teamFinCap(k, fr, ft, fp, 0.35, team);
  // nozzle (single F135, serrated)
  nozzle(k, 14.9, 1.1, 0.64, 0.54, 0.05, 0, 0x55504a, 12);
  plume(k, 16.0, [[0.05, 0]], 0.5);
  // weapons: AIM-120 outboard, GBU-31 inboard
  wingStores(k, 7.6, -0.12, 3.6, 3.66, 0.09, { mid: true, band: C.yellow });
  for (const s of [-1, 1]) {
    pylon(k, 7.3, 9.4, -0.1, -0.42, s * 2.3);
    k.col(lathe([[0, 0], [0.4, 0.22], [1.2, 0.23], [3.4, 0.2], [3.9, 0.08]], 10, [-6.7, -0.66, s * 2.3]), 0x6a6e5a);
    k.col(box(0.6, 0.02, 0.62, [-10.3, -0.66, s * 2.3], [PI / 4, 0, 0]), 0x6a6e5a);
    k.col(box(0.6, 0.02, 0.62, [-10.3, -0.66, s * 2.3], [-PI / 4, 0, 0]), 0x6a6e5a);
  }
  // markings
  if (israel) {
    roundelH(k, 8.6, 0.12, 3.2, 0.55, 'israel');
    roundelH(k, 8.6, 0.12, -3.2, 0.55, 'israel');
    // Adir: dorsal EW/comm hump
    k.add('skin', sph(0.35, [-8.6, 0.78, 0], [2.4, 0.6, 0.9], 10, 6));
  } else {
    roundelH(k, 8.8, 0.13, 3.3, 0.36, 'usa', true);
    roundelH(k, 8.8, 0.13, -3.3, 0.36, 'usa', true);
  }
  // team: wingtip bands
  k.symc(wing([lerpSec(wr, wt, 0.86, 1.3), { ...wt, t: 0.052, c: wt.c * 1.01 }]), team);
  navLights(k, 9.6, -0.05, 5.4, 15.8, 0.3);
  k.light('strobe', 0xffffff, [-7.5, 0.82, 0], 0.009);
  return { S: 1.08 / 16.0, kind: 'jet', paint: { skin: { color: israel ? 0x666b6f : 0x60656a }, skin2: { color: 0x494d51 }, glass: 0x8c6a36 } };
}

function f16(k: Kit, team: number, faction: string): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.02, t: 0.02, y: 0.02 },
        { d: 1.3, w: 0.36, t: 0.36, y: 0.04 },
        { d: 2.6, w: 0.5, t: 0.52, b: 0.48, y: 0.08 },
        { d: 4.0, w: 0.56, t: 0.6, b: 0.55, y: 0.12 },
        { d: 6.0, w: 0.62, t: 0.66, b: 0.58, y: 0.14, a: 0.9 },
        { d: 8.5, w: 0.64, t: 0.72, b: 0.55, y: 0.16, a: 0.85 },
        { d: 11.2, w: 0.6, t: 0.64, b: 0.5, y: 0.12, a: 0.9 },
        { d: 13.6, w: 0.54, t: 0.54, b: 0.5, y: 0.1 },
        { d: 14.3, w: 0.5, t: 0.5, b: 0.5, y: 0.1 },
      ],
      18,
      3,
    ),
  );
  // chin intake (smile)
  k.add(
    'skin',
    loft(
      [
        { d: 4.1, w: 0.5, t: 0.28, b: 0.36, y: -0.82, a: 0.75, e: 0.8 },
        { d: 5.2, w: 0.52, t: 0.32, b: 0.38, y: -0.78, a: 0.8 },
        { d: 8.5, w: 0.5, t: 0.3, b: 0.3, y: -0.5 },
        { d: 10.5, w: 0.4, t: 0.25, b: 0.25, y: -0.3 },
      ],
      14,
      2,
    ),
  );
  k.col(discX(0.44, 0.27, [-4.08, -0.86, 0]), C.intake);
  // strakes (LERX) blending into the wings
  k.sym('skin', slab([[3.6, 0.42], [6.6, 1.05], [8.3, 1.25], [8.3, 0.45]], 0.06, -0.02, 0.04));
  // bubble canopy
  k.add(
    'glass',
    loft(
      [
        { d: 2.4, w: 0.1, t: 0.03, b: 0.1, y: 0.55 },
        { d: 3.1, w: 0.36, t: 0.32, b: 0.2, y: 0.6 },
        { d: 4.3, w: 0.44, t: 0.52, b: 0.2, y: 0.62 },
        { d: 5.6, w: 0.38, t: 0.42, b: 0.2, y: 0.66 },
        { d: 6.6, w: 0.1, t: 0.05, b: 0.15, y: 0.74 },
      ],
      16,
      3,
    ),
  );
  k.add('skin2', box(0.1, 0.04, 0.82, [-5.85, 1.0, 0], [0, 0, 0.5])); // canopy bow frame
  // wings (40 deg)
  const wr: Sec = { d: 7.4, c: 4.6, z: 0.9, y: -0.02, t: 0.045 };
  const wt: Sec = { d: 10.6, c: 1.05, z: 4.65, y: -0.02, t: 0.04 };
  k.sym('skin', wing([wr, wt]));
  // horizontal tails (anhedral)
  k.sym('skin', wing([{ d: 12.2, c: 2.7, z: 0.65, y: 0.0, t: 0.04 }, { d: 13.7, c: 1.05, z: 2.75, y: -0.35, t: 0.035 }]));
  // vertical tail + root fairing (brake chute)
  const fr: Sec = { d: 9.9, c: 4.1, z: 0, t: 0.05 };
  const ft: Sec = { d: 12.6, c: 1.35, z: 3.0, t: 0.04 };
  k.add('skin', fin([fr, ft], [0, 0.7, 0], 0));
  k.add('skin', loft([{ d: 12.4, w: 0.14, t: 0.12, y: 0.86 }, { d: 14.6, w: 0.14, t: 0.14, y: 0.8 }], 8, 1));
  teamFinCap(k, fr, ft, [0, 0.7, 0], 0, team, 0.6);
  // ventral fins
  for (const s of [-1, 1]) k.add('skin', fin([{ d: 11.6, c: 1.5, z: 0, t: 0.04 }, { d: 12.4, c: 0.8, z: 0.75, t: 0.04 }], [0, -0.35, s * 0.42], PI - s * 0.5));
  nozzle(k, 14.25, 0.85, 0.52, 0.46, 0.1, 0, C.ti, 14);
  plume(k, 15.1, [[0.1, 0]], 0.44);
  // stores: wingtip AIM-9, AIM-120 outboard, 370 gal tanks
  for (const s of [-1, 1]) {
    k.col(box(2.4, 0.08, 0.1, [-11.0, -0.02, s * 4.72]), C.grey);
    missile(k, 9.4, -0.02, s * 4.86, 2.9, 0.065, { canard: true, band: C.yellow, body: 0xd6d8d4 });
    pylon(k, 9.0, 10.8, -0.04, -0.3, s * 3.4, 0.1);
    missile(k, 8.9, -0.4, s * 3.4, 3.66, 0.09, { mid: true, band: C.yellow });
    k.muzzle([-8.8, -0.4, s * 3.4]);
    pylon(k, 8.0, 10.2, -0.04, -0.3, s * 2.2, 0.12);
    tank(k, 6.6, -0.62, s * 2.2, 4.4, 0.32);
  }
  const ins = INSIGNIA[faction] ?? INSIGNIA.neutral;
  roundelH(k, 10.0, 0.06, 3.0, 0.42, ins);
  roundelH(k, 10.0, 0.06, -3.0, 0.42, ins);
  k.symc(wing([lerpSec(wr, wt, 0.8, 1.3), { ...wt, t: 0.052 }]), team);
  navLights(k, 10.6, 0.0, 4.75, 14.6, 1.05);
  k.light('strobe', 0xffffff, [-12.9, 3.75, 0], 0.009);
  const two = faction === 'ukraine';
  return { S: 1.0 / 15.0, kind: 'jet', paint: { skin: { color: two ? 0x8f969c : 0x9ca2a8 }, skin2: { color: 0x6f767c }, glass: 0x7a6440 } };
}

function su35(k: Kit, team: number): Built {
  // forward fuselage + flat centre body
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.03, t: 0.03, y: -0.2 },
        { d: 1.6, w: 0.44, t: 0.44, y: -0.14 },
        { d: 3.6, w: 0.62, t: 0.64, b: 0.6, y: 0.0 },
        { d: 5.6, w: 0.72, t: 0.78, b: 0.64, y: 0.1 },
        { d: 7.4, w: 0.98, t: 0.72, b: 0.58, y: 0.1, a: 0.8, e: 1.3 },
        { d: 9.6, w: 1.6, t: 0.56, b: 0.4, y: 0.12, a: 0.55, e: 1.5 },
        { d: 13.4, w: 1.72, t: 0.52, b: 0.36, y: 0.14, a: 0.5, e: 1.5 },
        { d: 16.6, w: 1.25, t: 0.42, b: 0.3, y: 0.14, a: 0.6, e: 1.3 },
        { d: 19.2, w: 0.5, t: 0.3, b: 0.25, y: 0.14 },
        { d: 21.6, w: 0.2, t: 0.2, b: 0.2, y: 0.16 },
      ],
      20,
      2,
    ),
  );
  // radome
  k.add('skin2', loft([{ d: 0, w: 0.03, t: 0.03, y: -0.2 }, { d: 1.0, w: 0.33, t: 0.33, y: -0.17 }, { d: 1.75, w: 0.465, t: 0.465, y: -0.135 }], 16, 2));
  // engine nacelles under the centre body
  for (const s of [-1, 1]) {
    const g = loft(
      [
        { d: 7.7, z: 1.1, w: 0.46, t: 0.56, b: 0.56, y: -0.5, a: 0.45, e: 0.45 },
        { d: 9.5, z: 1.1, w: 0.52, t: 0.6, b: 0.6, y: -0.45, a: 0.55, e: 0.55 },
        { d: 12.5, z: 1.1, w: 0.62, t: 0.62, b: 0.62, y: -0.38 },
        { d: 17.5, z: 1.1, w: 0.6, t: 0.6, b: 0.6, y: -0.32 },
        { d: 19.1, z: 1.1, w: 0.58, t: 0.58, b: 0.58, y: -0.3 },
      ],
      14,
      2,
    );
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(tf(discX(0.42, 0.52, [0, 0, 0]), [-7.66, -0.5, s * 1.1], [0, 0, -0.3]), C.intake);
    // tail booms carrying fins and tailplanes
    const bm = loft([{ d: 14.5, z: 1.95, w: 0.18, t: 0.2, y: -0.05 }, { d: 20.6, z: 1.95, w: 0.16, t: 0.18, y: -0.05 }], 10, 1);
    k.add('skin', s > 0 ? bm : mirZ(bm));
  }
  // LERX + wing (flanker planform)
  k.sym('skin', slab([[5.3, 0.6], [8.6, 1.3], [11.0, 2.0], [11.0, 0.6]], 0.08, 0.1, 0.04));
  const wr: Sec = { d: 10.6, c: 6.2, z: 1.7, y: 0.08, t: 0.045 };
  const wt: Sec = { d: 15.4, c: 1.65, z: 7.1, y: 0.0, t: 0.04 };
  k.sym('skin', wing([wr, wt]));
  // wingtip EW pods (Khibiny)
  for (const s of [-1, 1]) k.col(lathe([[0, 0], [0.5, 0.17], [2.2, 0.17], [2.6, 0.06]], 8, [-14.9, 0.0, s * 7.25]), 0x6d7b88);
  // tailplanes
  k.sym('skin', wing([{ d: 17.0, c: 3.5, z: 1.95, y: -0.06, t: 0.04 }, { d: 19.3, c: 1.3, z: 4.95, y: -0.06, t: 0.035 }]));
  // twin vertical tails on the booms
  const fr: Sec = { d: 15.3, c: 4.2, z: 0, t: 0.05 };
  const ft: Sec = { d: 18.0, c: 1.7, z: 3.4, t: 0.04 };
  const fp: V3 = [0, 0.1, 1.55];
  k.sym('skin', fin([fr, ft], fp, 0.05));
  teamFinCap(k, fr, ft, fp, 0.05, team, 0.68);
  // ventral fins
  for (const s of [-1, 1]) k.add('skin', fin([{ d: 15.6, c: 1.7, z: 0 }, { d: 16.5, c: 0.8, z: 0.8 }], [0, -0.2, s * 1.95], PI - s * 0.25));
  // canopy (bubble) + IRST
  k.add(
    'glass',
    loft(
      [
        { d: 3.9, w: 0.1, t: 0.04, b: 0.12, y: 0.66 },
        { d: 4.7, w: 0.4, t: 0.35, b: 0.2, y: 0.7 },
        { d: 6.0, w: 0.46, t: 0.5, b: 0.2, y: 0.72 },
        { d: 7.4, w: 0.36, t: 0.32, b: 0.2, y: 0.74 },
        { d: 8.6, w: 0.12, t: 0.06, b: 0.15, y: 0.72 },
      ],
      16,
      3,
    ),
  );
  k.add('glass', sph(0.19, [-3.6, 0.66, 0.18], [1, 1, 1], 10, 7));
  k.add('skin2', box(0.1, 0.05, 0.86, [-4.7, 1.02, 0], [0, 0, 0.4]));
  // nozzles (AL-41F1S, titanium)
  for (const s of [-1, 1]) nozzle(k, 19.1, 1.1, 0.6, 0.55, -0.3, s * 1.1, C.ti, 14);
  plume(k, 20.2, [[-0.3, 1.1], [-0.3, -1.1]], 0.5);
  // stores: R-77 underwing, R-73 outer, Kh-31 under intakes
  for (const s of [-1, 1]) {
    pylon(k, 11.9, 13.6, 0.04, -0.28, s * 3.6);
    missile(k, 11.8, -0.4, s * 3.6, 3.6, 0.1, { grid: true, mid: true, band: C.red, body: 0xe2e3de });
    k.muzzle([-11.7, -0.4, s * 3.6]);
    pylon(k, 13.4, 14.8, 0.02, -0.22, s * 5.5, 0.1);
    missile(k, 13.2, -0.32, s * 5.5, 2.9, 0.08, { canard: true, band: C.red, body: 0xe2e3de });
    missile(k, 9.2, -1.22, s * 1.1, 4.7, 0.18, { mid: true, body: 0xb9bdb0, nose: 0x4a4c40, band: C.red });
  }
  roundelH(k, 13.4, 0.16, 4.6, 0.55, INSIGNIA.russia);
  roundelH(k, 13.4, 0.16, -4.6, 0.55, INSIGNIA.russia);
  k.symc(wing([lerpSec(wr, wt, 0.84, 1.3), { ...wt, t: 0.052 }]), team);
  navLights(k, 16.0, 0.0, 7.5, 21.6, 0.2);
  k.light('strobe', 0xffffff, [-9.0, 0.7, 0], 0.009);
  return {
    S: 1.2 / 21.9,
    kind: 'jet',
    paint: {
      skin: { color: 0xffffff, uv: 0.12, camo: { pattern: 'woodland', color: 0x93a5b5, color2: 0x7c90a3, color3: 0x5e7488, color4: 0xa8b7c3, grime: 0.12, seed: 5 } },
      skin2: { color: 0xc4ccd2 },
      glass: 0x8fb4c8,
    },
  };
}

function j20(k: Kit, team: number): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.03, t: 0.03, y: -0.05 },
        { d: 1.6, w: 0.42, t: 0.3, b: 0.28, y: -0.04, a: 0.9, e: 1.6 },
        { d: 3.6, w: 0.64, t: 0.5, b: 0.44, y: 0.0, a: 0.85, e: 1.5 },
        { d: 5.6, w: 0.78, t: 0.6, b: 0.54, y: 0.05, a: 0.8, e: 1.45 },
        { d: 8.2, w: 1.3, t: 0.62, b: 0.55, y: 0.05, a: 0.65, e: 1.4 },
        { d: 12.0, w: 1.6, t: 0.62, b: 0.5, y: 0.05, a: 0.6, e: 1.45 },
        { d: 16.0, w: 1.42, t: 0.56, b: 0.46, y: 0.05, a: 0.65, e: 1.35 },
        { d: 18.6, w: 1.18, t: 0.5, b: 0.45, y: 0.05, a: 0.7, e: 1.1 },
        { d: 19.2, w: 1.08, t: 0.48, b: 0.45, y: 0.05, a: 0.75 },
      ],
      22,
      3,
    ),
  );
  for (const s of [-1, 1]) {
    const g = loft(
      [
        { d: 6.4, z: 1.18, w: 0.32, t: 0.44, b: 0.4, y: -0.02, a: 0.5, e: 0.55 },
        { d: 7.8, z: 1.2, w: 0.38, t: 0.5, b: 0.44, y: 0.0, a: 0.55, e: 0.6 },
        { d: 10.5, z: 1.1, w: 0.34, t: 0.46, b: 0.42, y: 0.03, a: 0.7 },
      ],
      12,
      2,
    );
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(tf(discX(0.28, 0.4, [0, 0, 0]), [-6.38, -0.02, s * 1.18], [0, s * 0.25, 0]), C.intake);
    k.add('skin', sph(0.28, [-6.2, 0.02, s * 0.86], [1.6, 1.0, 0.55])); // DSI bump
  }
  // canards (dihedral)
  k.sym('skin', wing([{ d: 6.6, c: 2.2, z: 1.15, y: 0.32, t: 0.035 }, { d: 8.0, c: 0.85, z: 3.8, y: 0.62, t: 0.03 }]));
  // strake + main wing
  k.sym('skin', slab([[8.0, 0.9], [10.0, 1.65], [10.0, 0.9]], 0.06, 0.02, 0.03));
  const wr: Sec = { d: 9.6, c: 7.9, z: 1.3, y: 0.02, t: 0.04 };
  const wt: Sec = { d: 14.6, c: 1.5, z: 6.5, y: -0.05, t: 0.035 };
  k.sym('skin', wing([wr, wt]));
  // all-moving canted fins
  const fr: Sec = { d: 14.6, c: 4.0, z: 0, t: 0.045 };
  const ft: Sec = { d: 17.4, c: 1.3, z: 2.55, t: 0.035 };
  const fp: V3 = [0, 0.5, 1.05];
  k.sym('skin', fin([fr, ft], fp, 0.5));
  teamFinCap(k, fr, ft, fp, 0.5, team, 0.62);
  // ventral fins canted outward
  for (const s of [-1, 1]) k.add('skin', fin([{ d: 15.0, c: 2.6, z: 0, t: 0.04 }, { d: 16.4, c: 1.1, z: 1.0, t: 0.035 }], [0, -0.4, s * 0.95], PI - s * 0.55));
  // canopy
  k.add(
    'glass',
    loft(
      [
        { d: 3.3, w: 0.08, t: 0.03, b: 0.1, y: 0.42 },
        { d: 4.1, w: 0.36, t: 0.28, b: 0.2, y: 0.48 },
        { d: 5.3, w: 0.44, t: 0.42, b: 0.22, y: 0.52 },
        { d: 6.6, w: 0.38, t: 0.34, b: 0.22, y: 0.56 },
        { d: 7.6, w: 0.12, t: 0.06, b: 0.15, y: 0.62 },
      ],
      16,
      3,
    ),
  );
  k.add('glass', sph(0.14, [-2.7, 0.36, 0], [1.4, 0.7, 1], 6, 4)); // EOTS
  // twin nozzles close together (WS-10C)
  for (const s of [-1, 1]) nozzle(k, 19.0, 1.0, 0.52, 0.46, 0.0, s * 0.56, 0x5c574f, 14);
  plume(k, 20.0, [[0.0, 0.56], [0.0, -0.56]], 0.42);
  // PL-15 on wing pylons (main bay internal)
  wingStores(k, 11.4, -0.12, 3.5, 4.0, 0.1, { mid: true, band: C.yellow, body: 0xdedfd8 });
  roundelH(k, 13.0, 0.1, 4.4, 0.5, INSIGNIA.china);
  roundelH(k, 13.0, 0.1, -4.4, 0.5, INSIGNIA.china);
  k.symc(wing([lerpSec(wr, wt, 0.85, 1.3), { ...wt, t: 0.047 }]), team);
  navLights(k, 15.3, -0.05, 6.5, 20.0, 0.1);
  k.light('strobe', 0xffffff, [-10.0, 0.7, 0], 0.009);
  return { S: 1.2 / 20.4, kind: 'jet', paint: { skin: { color: 0x5a5f64 }, skin2: { color: 0x474b50 }, glass: 0x8a6a34 } };
}

function typhoon(k: Kit, team: number): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.03, t: 0.03, y: 0.0 },
        { d: 1.6, w: 0.4, t: 0.4, y: 0.02 },
        { d: 3.0, w: 0.55, t: 0.58, b: 0.55, y: 0.05 },
        { d: 4.6, w: 0.6, t: 0.64, b: 0.6, y: 0.1 },
        { d: 7.2, w: 0.74, t: 0.7, b: 0.56, y: 0.15, a: 0.9 },
        { d: 11.0, w: 0.86, t: 0.68, b: 0.5, y: 0.15, a: 0.8 },
        { d: 13.8, w: 0.84, t: 0.58, b: 0.5, y: 0.12, a: 0.75 },
        { d: 14.7, w: 0.8, t: 0.52, b: 0.48, y: 0.1, a: 0.75 },
      ],
      20,
      3,
    ),
  );
  k.add('skin2', loft([{ d: 0, w: 0.03, t: 0.03, y: 0 }, { d: 0.9, w: 0.29, t: 0.29, y: 0.01 }, { d: 1.65, w: 0.41, t: 0.41, y: 0.02 }], 16, 2));
  // chin intake with variable lip
  k.add(
    'skin',
    loft(
      [
        { d: 4.7, w: 0.64, t: 0.24, b: 0.38, y: -0.78, a: 0.6, e: 0.6 },
        { d: 6.0, w: 0.66, t: 0.28, b: 0.38, y: -0.72, a: 0.65, e: 0.7 },
        { d: 9.5, w: 0.6, t: 0.3, b: 0.32, y: -0.46 },
        { d: 12, w: 0.5, t: 0.25, b: 0.25, y: -0.28 },
      ],
      14,
      2,
    ),
  );
  k.col(discX(0.56, 0.27, [-4.68, -0.84, 0]), C.intake);
  // canards
  k.sym('skin', wing([{ d: 2.7, c: 1.7, z: 0.52, y: 0.05, t: 0.035 }, { d: 3.65, c: 0.7, z: 2.3, y: 0.02, t: 0.03 }]));
  // delta wing 53 deg
  const wr: Sec = { d: 6.4, c: 8.1, z: 0.75, y: -0.22, t: 0.045 };
  const wt: Sec = { d: 12.7, c: 1.15, z: 5.45, y: -0.25, t: 0.035 };
  k.sym('skin', wing([wr, wt]));
  // single fin
  const fr: Sec = { d: 9.7, c: 4.7, z: 0, t: 0.05 };
  const ft: Sec = { d: 13.1, c: 1.05, z: 3.4, t: 0.04 };
  k.add('skin', fin([fr, ft], [0, 0.75, 0], 0));
  teamFinCap(k, fr, ft, [0, 0.75, 0], 0, team, 0.6);
  // canopy
  k.add(
    'glass',
    loft(
      [
        { d: 2.4, w: 0.1, t: 0.03, b: 0.1, y: 0.56 },
        { d: 3.1, w: 0.36, t: 0.3, b: 0.2, y: 0.6 },
        { d: 4.3, w: 0.44, t: 0.48, b: 0.2, y: 0.64 },
        { d: 5.7, w: 0.38, t: 0.38, b: 0.2, y: 0.68 },
        { d: 6.8, w: 0.1, t: 0.05, b: 0.15, y: 0.74 },
      ],
      16,
      3,
    ),
  );
  k.add('skin2', box(0.1, 0.04, 0.82, [-3.05, 0.86, 0], [0, 0, -0.4]));
  // spine
  k.add('skin', loft([{ d: 6.6, w: 0.08, t: 0.05, y: 0.82 }, { d: 8.5, w: 0.3, t: 0.12, y: 0.8 }, { d: 10.5, w: 0.25, t: 0.1, y: 0.82 }], 10, 2));
  for (const s of [-1, 1]) nozzle(k, 14.6, 1.1, 0.46, 0.43, 0.1, s * 0.44, C.ti, 14);
  plume(k, 15.7, [[0.1, 0.44], [0.1, -0.44]], 0.38);
  // stores: Meteor/AMRAAM inner, IRIS-T outer, Taurus? -> tanks
  for (const s of [-1, 1]) {
    pylon(k, 9.6, 11.6, -0.26, -0.55, s * 3.0);
    missile(k, 9.4, -0.66, s * 3.0, 3.65, 0.09, { mid: true, band: C.yellow, body: 0xdedfd8 });
    k.muzzle([-9.3, -0.66, s * 3.0]);
    pylon(k, 11.3, 12.6, -0.26, -0.48, s * 4.4, 0.1);
    missile(k, 10.9, -0.58, s * 4.4, 2.95, 0.064, { canard: false, mid: false, band: C.yellow, body: 0xdedfd8 });
    pylon(k, 7.4, 9.6, -0.24, -0.5, s * 1.8, 0.12);
    tank(k, 6.4, -0.82, s * 1.8, 4.0, 0.3);
  }
  // Balkenkreuz: black cross over white
  for (const s of [-1, 1]) {
    k.col(box(0.9, 0.02, 0.32, [-11.2, -0.08, s * 3.6]), 0xf2f2f0);
    k.col(box(0.32, 0.02, 0.9, [-11.2, -0.08, s * 3.6]), 0xf2f2f0);
    k.col(box(0.7, 0.03, 0.18, [-11.2, -0.07, s * 3.6]), 0x111111);
    k.col(box(0.18, 0.03, 0.7, [-11.2, -0.07, s * 3.6]), 0x111111);
  }
  k.symc(wing([lerpSec(wr, wt, 0.86, 1.3), { ...wt, t: 0.047 }]), team);
  navLights(k, 13.0, -0.25, 5.5, 14.2, 4.0);
  roundelH(k, 11.0, -0.12, 3.5, 0.48, 'germany');
  roundelH(k, 11.0, -0.12, -3.5, 0.48, 'germany');
  k.light('strobe', 0xffffff, [-8.0, 0.92, 0], 0.009);
  return { S: 1.08 / 16.0, kind: 'jet', paint: { skin: { color: 0x8f969d }, skin2: { color: 0x6a7076 }, glass: 0x6a6048 } };
}

function f15k(k: Kit, team: number): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.03, t: 0.03, y: 0.08 },
        { d: 1.8, w: 0.45, t: 0.45, y: 0.1 },
        { d: 3.6, w: 0.6, t: 0.62, b: 0.6, y: 0.15 },
        { d: 5.6, w: 0.64, t: 0.72, b: 0.6, y: 0.25, a: 0.9 },
        { d: 8.2, w: 0.7, t: 0.76, b: 0.55, y: 0.28, a: 0.85 },
        { d: 10.0, w: 1.3, t: 0.58, b: 0.5, y: 0.18, a: 0.5, e: 0.8 },
        { d: 14.0, w: 1.45, t: 0.52, b: 0.5, y: 0.15, a: 0.45, e: 0.8 },
        { d: 17.4, w: 1.28, t: 0.46, b: 0.46, y: 0.1, a: 0.5 },
        { d: 18.2, w: 1.18, t: 0.44, b: 0.44, y: 0.1, a: 0.55 },
      ],
      20,
      3,
    ),
  );
  for (const s of [-1, 1]) {
    // boxy variable-ramp intakes
    const g = loft(
      [
        { d: 5.4, z: 1.18, w: 0.46, t: 0.66, b: 0.5, y: 0.05, a: 0.35, e: 0.35 },
        { d: 7.0, z: 1.18, w: 0.48, t: 0.66, b: 0.52, y: 0.05, a: 0.4, e: 0.4 },
        { d: 10.5, z: 1.1, w: 0.45, t: 0.55, b: 0.5, y: 0.05, a: 0.5, e: 0.5 },
      ],
      12,
      2,
    );
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(tf(discX(0.4, 0.55, [0, 0, 0], false, 4), [-5.37, 0.12, s * 1.18], [PI / 4, 0, 0], [1, 1, 1]), C.intake);
    // conformal fuel tanks
    const cft = loft([{ d: 7.6, z: 1.62, w: 0.12, t: 0.3, y: -0.05 }, { d: 9.0, z: 1.68, w: 0.34, t: 0.46, y: -0.05 }, { d: 13.6, z: 1.68, w: 0.34, t: 0.45, y: -0.05 }, { d: 15.0, z: 1.6, w: 0.12, t: 0.3, y: -0.05 }], 12, 2);
    k.add('skin', s > 0 ? cft : mirZ(cft));
    const bm = loft([{ d: 15.0, z: 1.55, w: 0.2, t: 0.22, y: 0.0 }, { d: 18.6, z: 1.55, w: 0.18, t: 0.2, y: 0.0 }], 10, 1);
    k.add('skin', s > 0 ? bm : mirZ(bm));
  }
  const wr: Sec = { d: 9.0, c: 6.4, z: 1.6, y: 0.2, t: 0.05 };
  const wt: Sec = { d: 14.2, c: 1.6, z: 6.5, y: 0.1, t: 0.04 };
  k.sym('skin', wing([wr, wt]));
  k.sym('skin', wing([{ d: 15.6, c: 3.1, z: 1.6, y: 0.0, t: 0.04 }, { d: 17.4, c: 1.4, z: 4.35, y: 0.0, t: 0.035 }]));
  const fr: Sec = { d: 13.5, c: 3.7, z: 0, t: 0.05 };
  const ft: Sec = { d: 16.0, c: 1.5, z: 3.1, t: 0.04 };
  const fp: V3 = [0, 0.55, 1.35];
  k.sym('skin', fin([fr, ft], fp, 0.0));
  teamFinCap(k, fr, ft, fp, 0.0, team, 0.6);
  // tandem two-seat canopy
  k.add(
    'glass',
    loft(
      [
        { d: 3.6, w: 0.1, t: 0.04, b: 0.12, y: 0.74 },
        { d: 4.4, w: 0.42, t: 0.38, b: 0.22, y: 0.8 },
        { d: 6.0, w: 0.5, t: 0.52, b: 0.22, y: 0.84 },
        { d: 7.8, w: 0.5, t: 0.55, b: 0.22, y: 0.86 },
        { d: 9.0, w: 0.36, t: 0.3, b: 0.2, y: 0.9 },
        { d: 9.8, w: 0.1, t: 0.05, b: 0.15, y: 0.9 },
      ],
      16,
      3,
    ),
  );
  k.add('skin2', box(0.1, 0.05, 0.98, [-4.5, 1.12, 0], [0, 0, 0.5]));
  k.add('skin2', box(0.12, 0.05, 1.0, [-6.95, 1.4, 0]));
  for (const s of [-1, 1]) nozzle(k, 18.1, 1.2, 0.56, 0.52, 0.1, s * 0.62, C.ti, 14);
  plume(k, 19.3, [[0.1, 0.62], [0.1, -0.62]], 0.46);
  // stores: AIM-120 on CFT, AIM-9 on wing, SLAM-ER / JDAM, centreline tank
  for (const s of [-1, 1]) {
    missile(k, 9.0, -0.55, s * 1.95, 3.66, 0.09, { mid: true, band: C.yellow });
    k.muzzle([-8.9, -0.55, s * 1.95]);
    pylon(k, 10.2, 12.4, 0.1, -0.25, s * 3.6);
    k.col(lathe([[0, 0], [0.5, 0.2], [1.2, 0.24], [3.2, 0.22], [3.8, 0.1]], 10, [-8.9, -0.5, s * 3.6]), 0x6d7060);
    k.col(slab([[11.6, 0], [12.2, 0.45], [12.7, 0.45], [12.7, 0]], 0.03, -0.5, 0).translate(0, 0, s * 3.6), 0x6d7060);
    k.col(slab([[11.6, 0], [12.2, -0.45], [12.7, -0.45], [12.7, 0]], 0.03, -0.5, 0).translate(0, 0, s * 3.6), 0x6d7060);
    pylon(k, 12.4, 14.0, 0.06, -0.18, s * 4.9, 0.1);
    missile(k, 12.0, -0.26, s * 4.9, 2.9, 0.065, { canard: true, band: C.yellow, body: 0xd6d8d4 });
  }
  pylon(k, 9.6, 11.6, -0.3, -0.55, 0);
  tank(k, 8.6, -0.95, 0, 5.3, 0.38);
  roundelH(k, 11.8, 0.25, 4.4, 0.5, INSIGNIA.korea);
  roundelH(k, 11.8, 0.25, -4.4, 0.5, INSIGNIA.korea);
  k.symc(wing([lerpSec(wr, wt, 0.84, 1.3), { ...wt, t: 0.052 }]), team);
  navLights(k, 14.9, 0.12, 6.55, 19.3, 0.15);
  k.light('strobe', 0xffffff, [-10.0, 0.85, 0], 0.009);
  return { S: 1.15 / 19.43, kind: 'jet', paint: { skin: { color: 0x5b6166 }, skin2: { color: 0x44484c }, glass: 0x7a6440 } };
}

// =================================================================== helicopters

interface HeliO {
  team: number;
  faction: string;
}

/** Stub wing sections helper. */
function stubWing(k: Kit, d: number, c: number, y: number, z0: number, z1: number, dy: number, t = 0.14) {
  k.sym('skin', wing([{ d, c, z: z0, y, t }, { d: d + 0.1, c: c * 0.85, z: z1, y: y + dy, t }]));
}

function apache(k: Kit, o: HeliO, saraf: boolean): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0.15, w: 0.2, t: 0.18, b: 0.24, y: -0.36, a: 0.7 },
        { d: 0.9, w: 0.42, t: 0.34, b: 0.42, y: -0.3, a: 0.6 },
        { d: 2.2, w: 0.5, t: 0.52, b: 0.6, y: -0.2, a: 0.55 },
        { d: 3.6, w: 0.55, t: 0.72, b: 0.66, y: -0.1, a: 0.55 },
        { d: 5.2, w: 0.62, t: 0.8, b: 0.7, y: -0.05, a: 0.5 },
        { d: 7.0, w: 0.58, t: 0.7, b: 0.62, y: 0.0, a: 0.55 },
        { d: 8.4, w: 0.4, t: 0.48, b: 0.4, y: 0.12, a: 0.6 },
        { d: 10.2, w: 0.27, t: 0.32, b: 0.28, y: 0.26, a: 0.7 },
        { d: 13.4, w: 0.2, t: 0.25, b: 0.22, y: 0.36, a: 0.8 },
        { d: 15.3, w: 0.15, t: 0.2, b: 0.18, y: 0.42, a: 0.8 },
      ],
      16,
      2,
    ),
  );
  // stepped tandem canopy, flat-plate glass
  k.add(
    'glass',
    loft(
      [
        { d: 0.55, w: 0.3, t: 0.04, b: 0.3, y: 0.0, a: 0.5 },
        { d: 1.2, w: 0.42, t: 0.38, b: 0.3, y: 0.08, a: 0.45, e: 0.7 },
        { d: 2.3, w: 0.46, t: 0.5, b: 0.3, y: 0.15, a: 0.45, e: 0.7 },
        { d: 2.55, w: 0.47, t: 0.72, b: 0.3, y: 0.18, a: 0.45, e: 0.7 },
        { d: 3.6, w: 0.47, t: 0.8, b: 0.3, y: 0.22, a: 0.45, e: 0.7 },
        { d: 4.4, w: 0.43, t: 0.66, b: 0.3, y: 0.22, a: 0.5 },
        { d: 4.7, w: 0.3, t: 0.3, b: 0.3, y: 0.3 },
      ],
      14,
      1,
    ),
  );
  // canopy frames
  for (const d of [1.25, 2.45, 3.6]) k.add('skin2', box(0.07, 0.07, 0.96, [-d, d < 2 ? 0.5 : 1.0, 0]));
  // TADS / PNVS nose turret
  k.col(sph(0.36, [-0.05, -0.38, 0], [1.1, 0.9, 1.1], 10, 7), 0x33362f);
  k.col(box(0.5, 0.42, 0.24, [-0.05, -0.38, 0.38]), 0x2c2f29);
  k.col(box(0.5, 0.42, 0.24, [-0.05, -0.38, -0.38]), 0x2c2f29);
  k.add('glass', box(0.04, 0.26, 0.18, [0.22, -0.38, 0.38]));
  k.add('glass', box(0.04, 0.26, 0.18, [0.22, -0.38, -0.38]));
  k.col(sph(0.18, [-0.1, 0.02, 0], [1.2, 0.8, 1], 8, 6), 0x2c2f29);
  // M230 chin gun
  k.col(sph(0.22, [-1.7, -0.95, 0], [1.2, 0.8, 1], 8, 6), C.gun);
  k.col(cylX(0.05, 0.05, 1.7, 6, [-0.9, -1.0, 0]), C.gun);
  // engine nacelles + black hole exhausts
  for (const s of [-1, 1]) {
    const g = loft([{ d: 4.4, z: 0.82, w: 0.3, t: 0.3, y: 0.55 }, { d: 5.2, z: 0.84, w: 0.38, t: 0.38, y: 0.55 }, { d: 7.4, z: 0.84, w: 0.36, t: 0.36, y: 0.55 }, { d: 8.6, z: 0.84, w: 0.24, t: 0.24, y: 0.58 }], 12, 2);
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(discX(0.24, 0.24, [-4.38, 0.55, s * 0.82]), C.intake);
    k.col(box(0.9, 0.36, 0.06, [-8.1, 0.58, s * 1.12]), 0x2a2522);
  }
  // mast fairing, mast, Longbow FCR dome
  k.add('skin', loft([{ d: 4.2, w: 0.2, t: 0.1, y: 0.68 }, { d: 5.0, w: 0.4, t: 0.48, y: 0.72 }, { d: 6.7, w: 0.36, t: 0.42, y: 0.72 }, { d: 7.8, w: 0.14, t: 0.1, y: 0.68 }], 12, 2));
  k.col(cylY(0.13, 0.16, 0.7, 10, [-5.7, 1.45, 0]), 0x3a3d38);
  k.col(cylY(0.08, 0.1, 0.5, 8, [-5.7, 1.95, 0]), 0x3a3d38);
  k.add('skin2', sph(0.52, [-5.7, 2.32, 0], [1, 0.5, 1], 14, 8));
  // stub wings + stores
  stubWing(k, 5.0, 1.15, -0.12, 0.55, 2.45, -0.12);
  for (const s of [-1, 1]) {
    pylon(k, 5.0, 6.0, -0.15, -0.42, s * 1.25, 0.12, 'skin2');
    rocketPod(k, 4.6, -0.78, s * 1.25, 1.6, 0.27, 0x4a5236);
    pylon(k, 5.0, 6.0, -0.2, -0.45, s * 2.1, 0.12, 'skin2');
    hellfireRack(k, 4.5, -0.75, s * 2.1);
    k.col(box(0.3, 0.12, 0.3, [-5.4, -0.22, s * 2.5]), 0x2e312b); // wingtip ATAS rail
  }
  k.muzzle([-4.45, -0.65, -2.1]);
  k.muzzle([-4.45, -0.65, 2.1]);
  k.muzzle([-4.55, -0.78, -1.25]);
  k.muzzle([-4.55, -0.78, 1.25]);
  // tail fin, stabilator, tail rotor (left side, scissor)
  const fr: Sec = { d: 13.2, c: 2.1, z: 0, t: 0.12 };
  const ft: Sec = { d: 14.4, c: 1.05, z: 1.95, t: 0.1 };
  k.add('skin', fin([fr, ft], [0, 0.48, 0], 0));
  k.symc(fin([lerpSec(fr, ft, 0.6, 1.3), { ...ft, t: 0.13 }], [0, 0.48, 0], 0), o.team);
  k.sym('skin', wing([{ d: 14.3, c: 1.1, z: 0.12, y: 0.42, t: 0.08 }, { d: 14.5, c: 0.85, z: 1.7, y: 0.42, t: 0.07 }]));
  prop(k, [-14.95, 2.05, -0.28], [-PI / 2, 0, 0], 1.4, 4, 0.25, 70, { angles: [0, 0.96, PI, PI + 0.96] });
  k.col(cylZ(0.1, 0.3, 8, [-14.95, 2.05, -0.14]), 0x3a3d38);
  // fixed landing gear
  for (const s of [-1, 1]) {
    k.col(box(0.12, 0.85, 0.12, [-4.2, -0.95, s * 0.82], [s * 0.45, 0, 0]), 0x3a3d38);
    wheel(k, 4.2, -1.3, s * 1.05, 0.32, 0.2);
  }
  k.col(box(0.08, 0.5, 0.08, [-13.4, -0.05, 0]), 0x3a3d38);
  wheel(k, 13.4, -0.3, 0, 0.16, 0.1);
  // markings + lights
  if (saraf) for (const s of [-1, 1]) roundelV(k, 10.8, 0.3, s * 0.3, 0.26, 'israel', s);
  else if (o.faction === 'korea') for (const s of [-1, 1]) roundelV(k, 10.8, 0.3, s * 0.3, 0.24, INSIGNIA.korea, s);
  k.symc(wing([{ d: 5.08, c: 1.0, z: 2.2, y: -0.235, t: 0.17 }, { d: 5.1, c: 0.98, z: 2.47, y: -0.24, t: 0.17 }]), o.team);
  k.light('lit', C.red, [-5.6, -0.24, -2.5]);
  k.light('lit', C.green, [-5.6, -0.24, 2.5]);
  k.light('beacon', 0xff2a1a, [-14.4, 2.48, 0], 0.01);
  k.light('strobe', 0xffffff, [-7.0, -0.75, 0], 0.008);
  rotor(k, [-5.7, 2.0, 0], 7.3, 4, 0.53, 25, { sweep: true });
  const col = saraf ? 0x4c4b39 : o.faction === 'korea' ? 0x454b3d : 0x3e4535;
  return { S: 1.0 / 16.0, kind: 'heli', paint: { skin: { color: col, metal: 0.15, rough: 0.95 }, skin2: { color: 0x2f342b, metal: 0.15, rough: 0.9 }, glass: 0x3a5058 } };
}

function z10(k: Kit, o: HeliO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0.0, w: 0.14, t: 0.12, b: 0.2, y: -0.32, a: 0.6 },
        { d: 0.8, w: 0.38, t: 0.34, b: 0.44, y: -0.26, a: 0.42, e: 0.8 },
        { d: 2.4, w: 0.45, t: 0.52, b: 0.58, y: -0.16, a: 0.38, e: 0.7 },
        { d: 4.6, w: 0.55, t: 0.74, b: 0.66, y: -0.06, a: 0.38, e: 0.7 },
        { d: 6.6, w: 0.52, t: 0.7, b: 0.6, y: 0.0, a: 0.4, e: 0.75 },
        { d: 8.0, w: 0.36, t: 0.46, b: 0.38, y: 0.1, a: 0.5 },
        { d: 12.4, w: 0.2, t: 0.25, b: 0.22, y: 0.3, a: 0.6 },
        { d: 14.0, w: 0.16, t: 0.22, b: 0.2, y: 0.36 },
      ],
      16,
      2,
    ),
  );
  k.add(
    'glass',
    loft(
      [
        { d: 0.5, w: 0.26, t: 0.04, b: 0.3, y: 0.02, a: 0.4 },
        { d: 1.2, w: 0.4, t: 0.36, b: 0.3, y: 0.08, a: 0.38, e: 0.6 },
        { d: 2.3, w: 0.44, t: 0.48, b: 0.3, y: 0.14, a: 0.38, e: 0.6 },
        { d: 2.5, w: 0.45, t: 0.7, b: 0.3, y: 0.18, a: 0.38, e: 0.6 },
        { d: 3.6, w: 0.45, t: 0.78, b: 0.3, y: 0.22, a: 0.38, e: 0.6 },
        { d: 4.4, w: 0.4, t: 0.62, b: 0.3, y: 0.24, a: 0.45 },
        { d: 4.7, w: 0.28, t: 0.3, b: 0.3, y: 0.3 },
      ],
      14,
      1,
    ),
  );
  for (const d of [1.25, 2.42, 3.6]) k.add('skin2', box(0.07, 0.07, 0.92, [-d, d < 2 ? 0.48 : 0.98, 0]));
  // nose sensor ball + chin gun
  k.col(sph(0.3, [-0.35, -0.62, 0], [1, 1, 1], 10, 8), 0x2f3236);
  k.add('glass', box(0.04, 0.2, 0.3, [-0.08, -0.62, 0]));
  k.col(sph(0.18, [-1.4, -0.92, 0], [1.2, 0.8, 1], 8, 6), C.gun);
  k.col(cylX(0.045, 0.045, 1.4, 6, [-0.7, -0.96, 0]), C.gun);
  for (const s of [-1, 1]) {
    const g = loft([{ d: 4.3, z: 0.74, w: 0.28, t: 0.3, y: 0.55, a: 0.6 }, { d: 5.2, z: 0.78, w: 0.36, t: 0.36, y: 0.56, a: 0.6 }, { d: 7.6, z: 0.76, w: 0.32, t: 0.32, y: 0.58, a: 0.6 }, { d: 8.4, z: 0.72, w: 0.2, t: 0.2, y: 0.62 }], 12, 2);
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(discX(0.22, 0.24, [-4.28, 0.55, s * 0.74]), C.intake);
    k.col(tf(cylY(0.16, 0.2, 0.5, 8), [-8.0, 0.86, s * 0.85], [s * 0.6, 0, 0]), 0x2a2522); // upturned exhaust
  }
  k.add('skin', loft([{ d: 4.2, w: 0.2, t: 0.1, y: 0.7 }, { d: 5.0, w: 0.38, t: 0.45, y: 0.72 }, { d: 6.5, w: 0.34, t: 0.4, y: 0.72 }, { d: 7.6, w: 0.14, t: 0.1, y: 0.68 }], 12, 2));
  k.col(cylY(0.13, 0.15, 0.6, 10, [-5.6, 1.4, 0]), 0x3a3d40);
  stubWing(k, 5.0, 1.1, -0.15, 0.5, 2.25, -0.06);
  for (const s of [-1, 1]) {
    pylon(k, 5.0, 6.0, -0.18, -0.42, s * 1.2, 0.12, 'skin2');
    rocketPod(k, 4.7, -0.74, s * 1.2, 1.5, 0.24, 0x5b6268);
    pylon(k, 5.0, 6.0, -0.18, -0.42, s * 1.95, 0.12, 'skin2');
    k.muzzle(hellfireRack(k, 4.6, -0.7, s * 1.95, 1.75, 0.085, 0xc8c9c0));
  }
  k.muzzle([-4.75, -0.74, -1.2]);
  k.muzzle([-4.75, -0.74, 1.2]);
  const fr: Sec = { d: 12.2, c: 1.8, z: 0, t: 0.12 };
  const ft: Sec = { d: 13.5, c: 0.9, z: 1.8, t: 0.1 };
  k.add('skin', fin([fr, ft], [0, 0.45, 0], 0));
  k.symc(fin([lerpSec(fr, ft, 0.6, 1.3), { ...ft, t: 0.13 }], [0, 0.45, 0], 0), o.team);
  k.sym('skin', wing([{ d: 12.4, c: 1.0, z: 0.12, y: 0.4, t: 0.08 }, { d: 12.6, c: 0.8, z: 1.4, y: 0.4, t: 0.07 }]));
  prop(k, [-13.85, 1.85, 0.26], [PI / 2, 0, 0], 1.2, 4, 0.22, 70, { angles: [0, 0.96, PI, PI + 0.96] });
  for (const s of [-1, 1]) {
    k.col(box(0.12, 0.8, 0.12, [-4.0, -0.95, s * 0.75], [s * 0.4, 0, 0]), 0x3a3d40);
    wheel(k, 4.0, -1.28, s * 0.95, 0.28, 0.18);
  }
  wheel(k, 12.6, -0.25, 0, 0.14, 0.1);
  for (const s of [-1, 1]) roundelV(k, 9.8, 0.3, s * 0.3, 0.24, INSIGNIA.china, s);
  k.symc(wing([{ d: 5.08, c: 0.95, z: 2.0, y: -0.21, t: 0.17 }, { d: 5.1, c: 0.93, z: 2.27, y: -0.21, t: 0.17 }]), o.team);
  k.light('lit', C.red, [-5.5, -0.2, -2.3]);
  k.light('lit', C.green, [-5.5, -0.2, 2.3]);
  k.light('beacon', 0xff2a1a, [-13.4, 2.3, 0], 0.01);
  k.light('strobe', 0xffffff, [-7.0, -0.7, 0], 0.008);
  rotor(k, [-5.6, 1.72, 0], 6.0, 5, 0.45, 26);
  return { S: 1.0 / 14.6, kind: 'heli', paint: { skin: { color: 0x5d6670, metal: 0.2, rough: 0.9 }, skin2: { color: 0x3e454c }, glass: 0x34505e } };
}

function ka52(k: Kit, o: HeliO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0.0, w: 0.16, t: 0.16, y: -0.1 },
        { d: 0.6, w: 0.44, t: 0.42, b: 0.42, y: -0.1 },
        { d: 1.6, w: 0.68, t: 0.62, b: 0.62, y: -0.08, a: 0.7 },
        { d: 3.2, w: 0.82, t: 0.82, b: 0.72, y: 0.0, a: 0.6 },
        { d: 5.0, w: 0.76, t: 0.86, b: 0.72, y: 0.05, a: 0.55 },
        { d: 7.0, w: 0.66, t: 0.76, b: 0.6, y: 0.1, a: 0.55 },
        { d: 8.6, w: 0.44, t: 0.5, b: 0.4, y: 0.2, a: 0.6 },
        { d: 12.4, w: 0.26, t: 0.3, b: 0.26, y: 0.36 },
        { d: 13.5, w: 0.2, t: 0.25, b: 0.2, y: 0.38 },
      ],
      18,
      2,
    ),
  );
  k.add('skin2', loft([{ d: 0.0, w: 0.16, t: 0.16, y: -0.1 }, { d: 0.35, w: 0.36, t: 0.36, y: -0.1 }, { d: 0.65, w: 0.455, t: 0.435, y: -0.1 }], 16, 1));
  // side-by-side cockpit: wide glazing
  k.add(
    'glass',
    loft(
      [
        { d: 0.8, w: 0.5, t: 0.08, b: 0.3, y: 0.15, a: 0.7 },
        { d: 1.5, w: 0.7, t: 0.45, b: 0.3, y: 0.25, a: 0.6 },
        { d: 2.6, w: 0.8, t: 0.66, b: 0.3, y: 0.32, a: 0.55 },
        { d: 3.6, w: 0.78, t: 0.62, b: 0.3, y: 0.34, a: 0.55 },
        { d: 4.1, w: 0.6, t: 0.3, b: 0.3, y: 0.4 },
      ],
      16,
      2,
    ),
  );
  k.add('skin2', box(1.6, 0.06, 0.07, [-2.4, 1.0, 0], [0, 0, -0.35]));
  k.add('skin2', box(0.07, 0.08, 1.5, [-2.0, 0.9, 0]));
  // GOES sensor ball under nose
  k.col(sph(0.32, [-1.0, -0.78, 0], [1, 1, 1], 10, 8), 0x2f3236);
  k.add('glass', box(0.05, 0.22, 0.3, [-0.72, -0.78, 0]));
  // 2A42 cannon on the starboard side
  k.col(box(1.5, 0.3, 0.3, [-4.0, -0.35, 0.82]), 0x3a3d3a);
  k.col(cylX(0.06, 0.06, 2.5, 6, [-2.0, -0.35, 0.86]), C.gun);
  // engines
  for (const s of [-1, 1]) {
    const g = loft([{ d: 3.9, z: 0.86, w: 0.32, t: 0.32, y: 0.7 }, { d: 4.6, z: 0.88, w: 0.4, t: 0.4, y: 0.7 }, { d: 7.0, z: 0.88, w: 0.38, t: 0.38, y: 0.72 }, { d: 7.6, z: 0.95, w: 0.3, t: 0.3, y: 0.78 }], 12, 2);
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(sph(0.28, [-3.9, 0.7, s * 0.86], [0.6, 1, 1], 8, 6), 0x5a5e60); // dust protector dome
    k.col(tf(cylY(0.2, 0.24, 0.5, 8), [-7.7, 0.95, s * 1.15], [s * 0.9, 0, 0]), 0x2a2522);
  }
  k.add('skin', loft([{ d: 4.0, w: 0.25, t: 0.1, y: 0.85 }, { d: 4.8, w: 0.45, t: 0.42, y: 0.85 }, { d: 6.6, w: 0.4, t: 0.38, y: 0.85 }, { d: 7.8, w: 0.15, t: 0.1, y: 0.8 }], 12, 2));
  // coaxial mast
  k.col(cylY(0.17, 0.2, 1.9, 10, [-5.3, 2.05, 0]), 0x3a3d3a);
  k.col(cylY(0.22, 0.22, 0.25, 10, [-5.3, 2.4, 0]), 0x34363a);
  // stub wings with ECM pods and stores
  stubWing(k, 4.6, 1.3, -0.2, 0.7, 2.9, -0.05);
  for (const s of [-1, 1]) {
    k.col(lathe([[0, 0], [0.3, 0.16], [1.3, 0.16], [1.6, 0.06]], 8, [-4.4, -0.25, s * 2.95]), 0x4d5246);
    pylon(k, 4.7, 5.7, -0.24, -0.46, s * 1.4, 0.12, 'skin2');
    rocketPod(k, 4.4, -0.78, s * 1.4, 1.9, 0.26, 0x55584e);
    pylon(k, 4.7, 5.7, -0.24, -0.46, s * 2.3, 0.12, 'skin2');
    tubeBox(k, 4.3, -0.72, s * 2.3, 2.0, 0.08, 3, 2, 0x5c6150);
    k.muzzle([-4.3, -0.72, s * 2.3]);
  }
  k.muzzle([-4.4, -0.78, -1.4]);
  k.muzzle([-4.4, -0.78, 1.4]);
  // tail: tailplane with endplate fins + central fin
  k.sym('skin', wing([{ d: 12.0, c: 1.1, z: 0.12, y: 0.42, t: 0.08 }, { d: 12.2, c: 0.9, z: 1.65, y: 0.42, t: 0.07 }]));
  for (const s of [-1, 1]) {
    const g = fin([{ d: 11.9, c: 1.2, z: 0, t: 0.08 }, { d: 12.3, c: 0.85, z: 1.1, t: 0.07 }], [0, -0.05, s * 1.68], 0);
    k.add('skin', g);
    k.col(fin([{ d: 12.0, c: 1.12, z: 0.75, t: 0.1 }, { d: 12.3, c: 0.87, z: 1.12, t: 0.1 }], [0, -0.05, s * 1.68], 0), o.team);
  }
  k.add('skin', fin([{ d: 11.8, c: 1.8, z: 0, t: 0.12 }, { d: 12.9, c: 1.0, z: 1.5, t: 0.1 }], [0, 0.5, 0], 0));
  for (const s of [-1, 1]) roundelV(k, 9.6, 0.38, s * 0.3, 0.26, INSIGNIA.russia, s);
  k.light('lit', C.red, [-4.45, -0.25, -3.14]);
  k.light('lit', C.green, [-4.45, -0.25, 3.14]);
  k.light('beacon', 0xff2a1a, [-12.6, 2.05, 0], 0.01);
  k.light('strobe', 0xffffff, [-6.0, -0.7, 0], 0.008);
  rotor(k, [-5.3, 1.75, 0], 7.25, 3, 0.48, 24);
  rotor(k, [-5.3, 2.75, 0], 7.25, 3, 0.48, -24, { phase: 0.5 });
  return {
    S: 1.0 / 14.0,
    kind: 'heli',
    paint: { skin: { color: 0xffffff, uv: 0.16, camo: { pattern: 'urban', color: 0x6c7377, color2: 0x50575c, color3: 0x3a3f43, color4: 0x80878a, grime: 0.3, seed: 9 } }, skin2: { color: 0x3b4044 }, glass: 0x3a5664 },
  };
}

function tiger(k: Kit, o: HeliO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0.0, w: 0.12, t: 0.12, b: 0.15, y: -0.25 },
        { d: 0.8, w: 0.4, t: 0.38, b: 0.45, y: -0.2, a: 0.7 },
        { d: 2.4, w: 0.48, t: 0.55, b: 0.6, y: -0.12, a: 0.65 },
        { d: 4.4, w: 0.56, t: 0.75, b: 0.66, y: -0.05, a: 0.6 },
        { d: 6.4, w: 0.55, t: 0.7, b: 0.6, y: 0.0, a: 0.6 },
        { d: 7.8, w: 0.36, t: 0.45, b: 0.38, y: 0.12 },
        { d: 12.5, w: 0.2, t: 0.25, b: 0.2, y: 0.3 },
        { d: 14.0, w: 0.16, t: 0.2, b: 0.17, y: 0.35 },
      ],
      16,
      2,
    ),
  );
  k.add(
    'glass',
    loft(
      [
        { d: 0.5, w: 0.3, t: 0.04, b: 0.3, y: 0.02, a: 0.6 },
        { d: 1.2, w: 0.42, t: 0.38, b: 0.3, y: 0.08, a: 0.55, e: 0.8 },
        { d: 2.3, w: 0.46, t: 0.48, b: 0.3, y: 0.14, a: 0.55, e: 0.8 },
        { d: 2.6, w: 0.47, t: 0.7, b: 0.3, y: 0.18, a: 0.55, e: 0.8 },
        { d: 3.7, w: 0.47, t: 0.78, b: 0.3, y: 0.22, a: 0.55, e: 0.8 },
        { d: 4.4, w: 0.42, t: 0.62, b: 0.3, y: 0.24, a: 0.6 },
        { d: 4.8, w: 0.28, t: 0.3, b: 0.3, y: 0.3 },
      ],
      14,
      2,
    ),
  );
  for (const d of [1.25, 2.5, 3.7]) k.add('skin2', box(0.07, 0.07, 0.96, [-d, d < 2 ? 0.48 : 0.98, 0]));
  for (const s of [-1, 1]) {
    const g = loft([{ d: 4.6, z: 0.62, w: 0.28, t: 0.3, y: 0.62 }, { d: 5.4, z: 0.66, w: 0.34, t: 0.34, y: 0.62 }, { d: 7.6, z: 0.64, w: 0.3, t: 0.3, y: 0.62 }, { d: 8.4, z: 0.6, w: 0.2, t: 0.2, y: 0.64 }], 12, 2);
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(discX(0.2, 0.22, [-4.58, 0.62, s * 0.62]), C.intake);
    k.col(box(0.6, 0.25, 0.06, [-8.0, 0.7, s * 0.84]), 0x2a2522);
  }
  k.add('skin', loft([{ d: 4.4, w: 0.2, t: 0.1, y: 0.7 }, { d: 5.2, w: 0.36, t: 0.4, y: 0.72 }, { d: 6.6, w: 0.32, t: 0.36, y: 0.72 }, { d: 7.6, w: 0.14, t: 0.1, y: 0.68 }], 12, 2));
  // mast + Osiris mast-mounted sight
  k.col(cylY(0.12, 0.15, 1.4, 10, [-5.8, 1.75, 0]), 0x3a3d38);
  k.add('skin2', sph(0.36, [-5.8, 2.5, 0], [1, 0.9, 1], 12, 8));
  k.add('glass', box(0.06, 0.24, 0.42, [-5.46, 2.52, 0]));
  // nose sensor + gun pod mount
  k.col(sph(0.16, [-0.2, -0.45, 0], [1, 1, 1], 8, 6), 0x2f3236);
  stubWing(k, 5.2, 1.0, -0.12, 0.5, 2.15, 0.02);
  for (const s of [-1, 1]) {
    pylon(k, 5.2, 6.1, -0.14, -0.38, s * 1.15, 0.12, 'skin2');
    rocketPod(k, 4.9, -0.7, s * 1.15, 1.5, 0.24, 0x4c5444);
    pylon(k, 5.2, 6.1, -0.14, -0.38, s * 1.9, 0.12, 'skin2');
    k.muzzle(hellfireRack(k, 4.8, -0.66, s * 1.9, 1.6, 0.08, 0x8a8c80)); // PARS 3 LR
    k.col(cylX(0.06, 0.06, 1.4, 6, [-5.9, -0.05, s * 2.22]), 0x2e322b); // Stinger
  }
  k.muzzle([-4.95, -0.7, -1.15]);
  k.muzzle([-4.95, -0.7, 1.15]);
  // tail: vertical fin, horizontal stab with canted endplates
  const fr: Sec = { d: 12.6, c: 1.6, z: 0, t: 0.12 };
  const ft: Sec = { d: 13.6, c: 0.9, z: 1.5, t: 0.1 };
  k.add('skin', fin([fr, ft], [0, 0.42, 0], 0));
  k.sym('skin', wing([{ d: 12.3, c: 1.0, z: 0.1, y: 0.3, t: 0.08 }, { d: 12.4, c: 0.9, z: 1.3, y: 0.3, t: 0.07 }]));
  for (const s of [-1, 1]) {
    k.add('skin', fin([{ d: 12.2, c: 1.1, z: 0, t: 0.08 }, { d: 12.5, c: 0.8, z: 0.8, t: 0.07 }], [0, 0.3, s * 1.32], s * 0.25));
    k.col(fin([{ d: 12.32, c: 0.95, z: 0.5, t: 0.1 }, { d: 12.5, c: 0.8, z: 0.82, t: 0.1 }], [0, 0.3, s * 1.32], s * 0.25), o.team);
  }
  k.symc(fin([lerpSec(fr, ft, 0.65, 1.3), { ...ft, t: 0.13 }], [0, 0.42, 0], 0), o.team);
  prop(k, [-13.4, 1.7, 0.26], [PI / 2, 0, 0], 1.35, 3, 0.24, 70);
  for (const s of [-1, 1]) {
    k.col(box(0.12, 0.8, 0.12, [-4.4, -0.95, s * 0.7], [s * 0.45, 0, 0]), 0x3a3d38);
    wheel(k, 4.4, -1.28, s * 0.95, 0.28, 0.18);
  }
  wheel(k, 12.8, -0.2, 0, 0.14, 0.1);
  for (const s of [-1, 1]) {
    k.col(box(0.6, 0.6, 0.02, [-10.6, 0.32, s * 0.24]), 0xf2f2f0);
    k.col(box(0.46, 0.14, 0.03, [-10.6, 0.32, s * 0.24]), 0x111111);
    k.col(box(0.14, 0.46, 0.03, [-10.6, 0.32, s * 0.24]), 0x111111);
  }
  k.light('lit', C.red, [-5.6, -0.1, -2.2]);
  k.light('lit', C.green, [-5.6, -0.1, 2.2]);
  k.light('beacon', 0xff2a1a, [-13.6, 2.0, 0], 0.01);
  k.light('strobe', 0xffffff, [-7.0, -0.7, 0], 0.008);
  rotor(k, [-5.8, 1.95, 0], 6.5, 4, 0.5, 26);
  for (const s of [-1, 1]) roundelV(k, 9.4, 0.22, s * 0.3, 0.22, 'germany', s);
  return { S: 1.0 / 14.5, kind: 'heli', paint: { skin: { color: 0x515b47, metal: 0.15, rough: 0.95 }, skin2: { color: 0x353c30 }, glass: 0x34505a } };
}

function mi24(k: Kit, o: HeliO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0.0, w: 0.1, t: 0.1, b: 0.2, y: -0.42 },
        { d: 0.6, w: 0.42, t: 0.32, b: 0.45, y: -0.36, a: 0.7 },
        { d: 1.8, w: 0.62, t: 0.5, b: 0.6, y: -0.26, a: 0.6 },
        { d: 3.4, w: 0.86, t: 0.86, b: 0.76, y: -0.05, a: 0.55 },
        { d: 5.5, w: 0.96, t: 1.0, b: 0.86, y: 0.05, a: 0.5 },
        { d: 8.5, w: 0.96, t: 1.0, b: 0.82, y: 0.1, a: 0.5 },
        { d: 10.2, w: 0.6, t: 0.66, b: 0.46, y: 0.32, a: 0.6 },
        { d: 14.0, w: 0.3, t: 0.32, b: 0.26, y: 0.55 },
        { d: 17.0, w: 0.22, t: 0.25, b: 0.2, y: 0.62 },
      ],
      18,
      2,
    ),
  );
  // double bubble: gunner + pilot
  k.add('glass', loft([{ d: 0.1, w: 0.2, t: 0.1, b: 0.3, y: -0.2 }, { d: 0.7, w: 0.44, t: 0.42, b: 0.3, y: -0.14 }, { d: 1.6, w: 0.5, t: 0.5, b: 0.3, y: -0.1 }, { d: 2.3, w: 0.36, t: 0.3, b: 0.3, y: 0.0 }], 14, 2));
  k.add('glass', loft([{ d: 2.3, w: 0.3, t: 0.1, b: 0.3, y: 0.5 }, { d: 2.8, w: 0.5, t: 0.4, b: 0.3, y: 0.55 }, { d: 3.6, w: 0.56, t: 0.5, b: 0.3, y: 0.6 }, { d: 4.3, w: 0.36, t: 0.25, b: 0.3, y: 0.7 }], 14, 2));
  // nose gun turret (YakB)
  k.col(sph(0.28, [-0.5, -0.8, 0], [1, 0.8, 1], 10, 6), C.gun);
  k.col(cylX(0.07, 0.07, 1.0, 6, [-0.0, -0.84, 0]), C.gun);
  // cabin windows
  for (const s of [-1, 1]) for (let i = 0; i < 3; i++) k.col(box(0.42, 0.34, 0.03, [-(5.2 + i * 0.85), 0.25, s * 0.96]), 0x1a2228);
  // engines on top, gearbox hump
  for (const s of [-1, 1]) {
    const g = loft([{ d: 3.6, z: 0.56, w: 0.34, t: 0.34, y: 1.15 }, { d: 4.6, z: 0.58, w: 0.42, t: 0.42, y: 1.15 }, { d: 7.8, z: 0.58, w: 0.42, t: 0.42, y: 1.15 }, { d: 8.8, z: 0.62, w: 0.32, t: 0.32, y: 1.12 }], 12, 2);
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(sph(0.32, [-3.5, 1.15, s * 0.56], [0.7, 1, 1], 8, 6), 0x55594c);
    k.col(tf(cylY(0.22, 0.26, 0.6, 8), [-9.0, 1.05, s * 0.95], [s * 1.1, 0, 0.4]), 0x2a2522);
  }
  k.add('skin', loft([{ d: 4.5, w: 0.3, t: 0.15, y: 1.25 }, { d: 5.4, w: 0.5, t: 0.45, y: 1.25 }, { d: 8.0, w: 0.45, t: 0.4, y: 1.25 }, { d: 9.4, w: 0.2, t: 0.1, y: 1.2 }], 12, 2));
  k.col(cylY(0.17, 0.2, 0.6, 10, [-6.3, 1.85, 0]), 0x3a3d38);
  // anhedral stub wings with endplate launchers and UB-32 pods
  k.sym('skin', wing([{ d: 5.6, c: 1.8, z: 0.9, y: -0.1, t: 0.13 }, { d: 6.0, c: 1.25, z: 3.25, y: -0.65, t: 0.11 }]));
  for (const s of [-1, 1]) {
    k.add('skin2', plate([[5.9, -0.6], [6.2, -1.25], [7.1, -1.25], [7.2, -0.6]], 0.08, s * 3.3));
    tubeBox(k, 5.4, -1.1, s * 3.42, 1.9, 0.08, 1, 2, 0x5c6150); // Shturm
    pylon(k, 5.9, 7.0, -0.25, -0.5, s * 1.65, 0.12, 'skin2');
    rocketPod(k, 5.4, -0.86, s * 1.65, 1.9, 0.27, 0x4f5545);
    pylon(k, 6.0, 7.1, -0.45, -0.7, s * 2.55, 0.12, 'skin2');
    rocketPod(k, 5.5, -1.06, s * 2.55, 1.9, 0.27, 0x4f5545);
  }
  k.muzzle([-5.45, -0.86, -1.65]);
  k.muzzle([-5.45, -0.86, 1.65]);
  k.muzzle([-5.45, -1.1, -3.42]);
  k.muzzle([-5.45, -1.1, 3.42]);
  // tail
  const fr: Sec = { d: 15.0, c: 2.0, z: 0, t: 0.12 };
  const ft: Sec = { d: 16.6, c: 1.1, z: 2.2, t: 0.1 };
  k.add('skin', fin([fr, ft], [0, 0.65, 0], 0));
  k.symc(fin([lerpSec(fr, ft, 0.62, 1.3), { ...ft, t: 0.13 }], [0, 0.65, 0], 0), o.team);
  k.sym('skin', wing([{ d: 14.6, c: 1.0, z: 0.15, y: 0.5, t: 0.08 }, { d: 14.8, c: 0.85, z: 1.6, y: 0.5, t: 0.07 }]));
  prop(k, [-16.6, 2.35, -0.32], [-PI / 2, 0, 0], 1.95, 3, 0.3, 60);
  for (const s of [-1, 1]) roundelV(k, 11.5, 0.5, s * 0.5, 0.3, INSIGNIA.ukraine, s);
  k.symc(wing([{ d: 5.9, c: 1.3, z: 2.9, y: -0.57, t: 0.15 }, { d: 6.0, c: 1.27, z: 3.26, y: -0.66, t: 0.15 }]), o.team);
  k.light('lit', C.red, [-6.3, -0.66, -3.3]);
  k.light('lit', C.green, [-6.3, -0.66, 3.3]);
  k.light('beacon', 0xff2a1a, [-8.6, 1.45, 0], 0.01);
  k.light('strobe', 0xffffff, [-16.4, 2.9, 0], 0.008);
  rotor(k, [-6.3, 2.2, 0], 8.6, 5, 0.58, 22, { hub: 0.5 });
  return { S: 1.05 / 18.0, kind: 'heli', paint: { skin: { color: 0xffffff, uv: 0.18, camo: factionCamo('ukraine') }, skin2: { color: 0x3c4232 }, glass: 0x3a5664 } };
}

function t129(k: Kit, o: HeliO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0.0, w: 0.1, t: 0.1, b: 0.12, y: -0.22 },
        { d: 0.7, w: 0.33, t: 0.3, b: 0.38, y: -0.2, a: 0.6 },
        { d: 2.2, w: 0.42, t: 0.5, b: 0.55, y: -0.12, a: 0.55 },
        { d: 4.2, w: 0.48, t: 0.7, b: 0.6, y: -0.05, a: 0.5 },
        { d: 6.0, w: 0.48, t: 0.65, b: 0.58, y: 0.0, a: 0.5 },
        { d: 7.3, w: 0.32, t: 0.4, b: 0.35, y: 0.12 },
        { d: 11.8, w: 0.18, t: 0.22, b: 0.2, y: 0.3 },
        { d: 13.4, w: 0.14, t: 0.18, b: 0.16, y: 0.35 },
      ],
      16,
      2,
    ),
  );
  k.add(
    'glass',
    loft(
      [
        { d: 0.6, w: 0.24, t: 0.04, b: 0.3, y: 0.0, a: 0.5 },
        { d: 1.2, w: 0.36, t: 0.34, b: 0.3, y: 0.06, a: 0.5, e: 0.7 },
        { d: 2.2, w: 0.4, t: 0.44, b: 0.3, y: 0.12, a: 0.5, e: 0.7 },
        { d: 2.45, w: 0.41, t: 0.64, b: 0.3, y: 0.16, a: 0.5, e: 0.7 },
        { d: 3.5, w: 0.41, t: 0.72, b: 0.3, y: 0.2, a: 0.5, e: 0.7 },
        { d: 4.2, w: 0.36, t: 0.56, b: 0.3, y: 0.22, a: 0.55 },
        { d: 4.5, w: 0.24, t: 0.26, b: 0.3, y: 0.28 },
      ],
      14,
      1,
    ),
  );
  for (const d of [1.2, 2.35, 3.5]) k.add('skin2', box(0.06, 0.06, 0.84, [-d, d < 2 ? 0.42 : 0.9, 0]));
  k.col(sph(0.26, [0.15, -0.28, 0], [1, 1, 1], 10, 8), 0x2f3236); // ASELFLIR nose turret
  k.add('glass', box(0.04, 0.16, 0.24, [0.4, -0.28, 0]));
  k.col(sph(0.17, [-1.5, -0.82, 0], [1.2, 0.8, 1], 8, 6), C.gun);
  for (const dz of [-0.04, 0, 0.04]) k.col(cylX(0.025, 0.025, 1.2, 5, [-0.9, -0.86, dz]), C.gun);
  for (const s of [-1, 1]) {
    const g = loft([{ d: 4.2, z: 0.55, w: 0.26, t: 0.28, y: 0.55 }, { d: 5.0, z: 0.58, w: 0.3, t: 0.3, y: 0.55 }, { d: 7.0, z: 0.56, w: 0.28, t: 0.28, y: 0.56 }, { d: 7.8, z: 0.52, w: 0.18, t: 0.18, y: 0.58 }], 12, 2);
    k.add('skin', s > 0 ? g : mirZ(g));
    k.col(discX(0.18, 0.2, [-4.18, 0.55, s * 0.55]), C.intake);
    k.col(box(0.5, 0.22, 0.05, [-7.5, 0.6, s * 0.74]), 0x2a2522);
  }
  k.add('skin', loft([{ d: 4.0, w: 0.18, t: 0.1, y: 0.66 }, { d: 4.8, w: 0.32, t: 0.38, y: 0.68 }, { d: 6.2, w: 0.3, t: 0.34, y: 0.68 }, { d: 7.2, w: 0.12, t: 0.1, y: 0.64 }], 12, 2));
  k.col(cylY(0.11, 0.14, 0.6, 10, [-5.3, 1.3, 0]), 0x3a3d38);
  stubWing(k, 4.8, 0.95, -0.12, 0.45, 2.0, 0.0);
  for (const s of [-1, 1]) {
    pylon(k, 4.8, 5.6, -0.14, -0.36, s * 1.05, 0.11, 'skin2');
    rocketPod(k, 4.5, -0.64, s * 1.05, 1.4, 0.22, 0x51574a);
    pylon(k, 4.8, 5.6, -0.14, -0.36, s * 1.75, 0.11, 'skin2');
    k.muzzle(hellfireRack(k, 4.4, -0.62, s * 1.75, 1.8, 0.08, 0xd0d0c6)); // UMTAS
  }
  k.muzzle([-4.55, -0.64, -1.05]);
  k.muzzle([-4.55, -0.64, 1.05]);
  const fr: Sec = { d: 11.6, c: 1.7, z: 0, t: 0.12 };
  const ft: Sec = { d: 12.8, c: 0.85, z: 1.6, t: 0.1 };
  k.add('skin', fin([fr, ft], [0, 0.4, 0], 0));
  k.symc(fin([lerpSec(fr, ft, 0.6, 1.3), { ...ft, t: 0.13 }], [0, 0.4, 0], 0), o.team);
  k.sym('skin', wing([{ d: 12.0, c: 0.85, z: 0.1, y: 0.35, t: 0.08 }, { d: 12.1, c: 0.7, z: 1.25, y: 0.35, t: 0.07 }]));
  prop(k, [-12.95, 1.7, -0.24], [-PI / 2, 0, 0], 1.1, 2, 0.26, 70);
  for (const s of [-1, 1]) {
    k.col(box(0.1, 0.75, 0.1, [-4.0, -0.9, s * 0.65], [s * 0.45, 0, 0]), 0x3a3d38);
    wheel(k, 4.0, -1.22, s * 0.88, 0.26, 0.16);
  }
  wheel(k, 12.2, -0.15, 0, 0.13, 0.09);
  for (const s of [-1, 1]) roundelV(k, 9.6, 0.32, s * 0.27, 0.24, INSIGNIA.turkey, s);
  k.symc(wing([{ d: 4.88, c: 0.82, z: 1.8, y: -0.12, t: 0.17 }, { d: 4.9, c: 0.81, z: 2.02, y: -0.12, t: 0.17 }]), o.team);
  k.light('lit', C.red, [-5.2, -0.12, -2.05]);
  k.light('lit', C.green, [-5.2, -0.12, 2.05]);
  k.light('beacon', 0xff2a1a, [-12.6, 2.05, 0], 0.01);
  k.light('strobe', 0xffffff, [-6.5, -0.65, 0], 0.008);
  rotor(k, [-5.3, 1.65, 0], 5.95, 4, 0.48, 27, { sweep: true });
  return { S: 1.0 / 14.0, kind: 'heli', paint: { skin: { color: 0x59604f, metal: 0.15, rough: 0.95 }, skin2: { color: 0x3a4036 }, glass: 0x34505a } };
}

function cobra(k: Kit, o: HeliO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0.0, w: 0.1, t: 0.12, b: 0.16, y: -0.26 },
        { d: 0.8, w: 0.32, t: 0.3, b: 0.4, y: -0.2, a: 0.7 },
        { d: 2.3, w: 0.42, t: 0.5, b: 0.55, y: -0.12, a: 0.65 },
        { d: 4.3, w: 0.48, t: 0.7, b: 0.6, y: -0.05, a: 0.6 },
        { d: 6.2, w: 0.48, t: 0.72, b: 0.6, y: 0.0, a: 0.6 },
        { d: 7.6, w: 0.3, t: 0.42, b: 0.35, y: 0.15 },
        { d: 12.0, w: 0.16, t: 0.2, b: 0.18, y: 0.35 },
        { d: 13.5, w: 0.12, t: 0.16, b: 0.14, y: 0.4 },
      ],
      16,
      2,
    ),
  );
  // long framed tandem canopy
  k.add(
    'glass',
    loft(
      [
        { d: 0.7, w: 0.22, t: 0.05, b: 0.3, y: 0.02 },
        { d: 1.3, w: 0.34, t: 0.36, b: 0.3, y: 0.08, a: 0.75 },
        { d: 2.4, w: 0.38, t: 0.48, b: 0.3, y: 0.14, a: 0.75 },
        { d: 2.7, w: 0.39, t: 0.68, b: 0.3, y: 0.16, a: 0.75 },
        { d: 3.9, w: 0.39, t: 0.74, b: 0.3, y: 0.2, a: 0.75 },
        { d: 4.6, w: 0.3, t: 0.5, b: 0.3, y: 0.25 },
        { d: 4.9, w: 0.18, t: 0.2, b: 0.3, y: 0.3 },
      ],
      14,
      2,
    ),
  );
  for (const d of [1.3, 2.0, 2.6, 3.3, 3.95]) k.add('skin2', box(0.05, 0.05, 0.8, [-d, d < 2.5 ? 0.5 : 0.92, 0]));
  k.add('skin2', box(3.4, 0.05, 0.05, [-2.6, 0.82, 0], [0, 0, -0.15]));
  // M197 chin turret
  k.col(sph(0.2, [-1.0, -0.72, 0], [1.2, 0.8, 1], 8, 6), C.gun);
  for (const dz of [-0.035, 0, 0.035]) k.col(cylX(0.022, 0.022, 1.3, 5, [-0.3, -0.76, dz]), C.gun);
  k.col(sph(0.1, [-0.05, -0.3, 0], [1, 1, 1], 6, 4), 0x2f3236);
  // engine cowl (T64 twin-pac) + exhaust
  k.add('skin', loft([{ d: 4.2, w: 0.2, t: 0.1, y: 0.62 }, { d: 5.0, w: 0.42, t: 0.42, y: 0.66 }, { d: 7.8, w: 0.4, t: 0.38, y: 0.66 }, { d: 8.8, w: 0.24, t: 0.2, y: 0.62 }], 12, 2));
  k.col(cylX(0.2, 0.24, 0.5, 8, [-8.95, 0.68, 0]), 0x2a2522);
  for (const s of [-1, 1]) k.col(discX(0.15, 0.2, [-4.75, 0.82, s * 0.36]), C.intake);
  k.col(cylY(0.1, 0.13, 0.5, 8, [-5.6, 1.3, 0]), 0x3a3d38);
  // stub wings
  k.sym('skin', wing([{ d: 5.6, c: 1.05, z: 0.45, y: -0.15, t: 0.14 }, { d: 5.7, c: 0.85, z: 1.65, y: -0.2, t: 0.13 }]));
  for (const s of [-1, 1]) {
    pylon(k, 5.6, 6.4, -0.18, -0.36, s * 0.95, 0.1, 'skin2');
    rocketPod(k, 5.3, -0.62, s * 0.95, 1.4, 0.22, 0x5a5640);
    pylon(k, 5.6, 6.4, -0.2, -0.38, s * 1.55, 0.1, 'skin2');
    tubeBox(k, 5.2, -0.62, s * 1.55, 1.3, 0.085, 2, 2, 0x6a6650); // TOW
    k.muzzle([-5.2, -0.62, s * 1.55]);
  }
  k.muzzle([-5.35, -0.62, -0.95]);
  k.muzzle([-5.35, -0.62, 0.95]);
  // skids: two tubes on bow-shaped cross tubes
  for (const sd of [-1, 1]) k.col(lathe([[0, 0.035], [0.25, 0.05], [5.0, 0.05], [5.1, 0.035]], 6, [-1.6, -1.22, sd * 0.98]), 0x3a3d38);
  for (const d of [2.6, 5.6]) {
    k.col(cylZ(0.045, 1.2, 6, [-d, -0.86, 0]), 0x3a3d38);
    for (const sd of [-1, 1]) k.col(tf(cylY(0.045, 0.045, 0.5, 6), [-d, -1.02, sd * 0.78], [sd * 0.75, 0, 0]), 0x3a3d38);
  }
  // tail: elevator mid-boom, fin with tail rotor (left)
  k.sym('skin', wing([{ d: 9.3, c: 0.8, z: 0.1, y: 0.3, t: 0.08 }, { d: 9.4, c: 0.65, z: 1.15, y: 0.3, t: 0.07 }]));
  const fr: Sec = { d: 12.0, c: 1.5, z: 0, t: 0.12 };
  const ft: Sec = { d: 13.2, c: 0.8, z: 1.5, t: 0.1 };
  k.add('skin', fin([fr, ft], [0, 0.4, 0], 0));
  k.symc(fin([lerpSec(fr, ft, 0.6, 1.3), { ...ft, t: 0.13 }], [0, 0.4, 0], 0), o.team);
  prop(k, [-13.05, 1.45, -0.2], [-PI / 2, 0, 0], 1.3, 2, 0.28, 60);
  for (const s of [-1, 1]) roundelV(k, 9.6, 0.36, s * 0.22, 0.22, INSIGNIA.iran, s);
  k.symc(wing([{ d: 5.65, c: 0.88, z: 1.45, y: -0.19, t: 0.16 }, { d: 5.7, c: 0.87, z: 1.67, y: -0.2, t: 0.16 }]), o.team);
  k.light('lit', C.red, [-6.0, -0.2, -1.7]);
  k.light('lit', C.green, [-6.0, -0.2, 1.7]);
  k.light('beacon', 0xff2a1a, [-7.0, 1.08, 0], 0.01);
  k.light('strobe', 0xffffff, [-13.0, 2.0, 0], 0.008);
  // 2-blade teetering rotor with wide-chord blades
  rotor(k, [-5.6, 1.62, 0], 6.7, 2, 0.75, 22, { hub: 0.45 });
  return { S: 1.0 / 14.0, kind: 'heli', paint: { skin: { color: 0xffffff, uv: 0.18, camo: factionCamo('iran') }, skin2: { color: 0x4a4436 }, glass: 0x3a5664 } };
}

// =================================================================== UAVs

interface UavO {
  team: number;
  faction: string;
}

/** Underwing hardpoint with a small missile; adds the muzzle. */
function uavMissile(k: Kit, d: number, yWing: number, z: number, len: number, r: number, color = C.offwhite) {
  pylon(k, d - 0.05, d + len * 0.55, yWing, yWing - 0.16, z, 0.07);
  missile(k, d, yWing - 0.16 - r, z, len, r, { body: color, mid: true, band: C.yellow, fin: r * 1.8 });
  k.muzzle([-d + 0.05, yWing - 0.16 - r, z]);
}

function sensorBall(k: Kit, d: number, y: number, r: number) {
  k.col(cylY(r * 0.5, r * 0.6, r * 0.5, 8, [-d, y + r * 0.9, 0]), 0x5a5e62);
  k.col(sph(r, [-d, y, 0], [1, 1, 1], 10, 8), 0x3c4044);
  k.add('glass', sph(r * 0.45, [-d + r * 0.75, y - r * 0.1, 0], [0.5, 1, 1], 8, 6));
}

function reaperLike(k: Kit, o: UavO, wl2: boolean): Built {
  const L = 11;
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.12, t: 0.1, b: 0.12, y: 0.0 },
        { d: 0.5, w: 0.42, t: 0.42, b: 0.4, y: 0.06 },
        { d: 1.5, w: 0.54, t: wl2 ? 0.6 : 0.64, b: 0.45, y: 0.12 },
        { d: 3.2, w: 0.5, t: 0.52, b: 0.45, y: 0.1 },
        { d: 6.0, w: 0.44, t: 0.44, b: 0.42, y: 0.06 },
        { d: 9.0, w: 0.3, t: 0.3, b: 0.3, y: 0.06 },
        { d: 10.4, w: 0.2, t: 0.2, b: 0.2, y: 0.06 },
        { d: 10.7, w: 0.14, t: 0.14, b: 0.14, y: 0.06 },
      ],
      16,
      2,
    ),
  );
  // straight high-aspect wing, slight dihedral
  const wr: Sec = { d: 4.1, c: 1.5, z: 0.35, y: 0.22, t: 0.14 };
  const wt: Sec = { d: 4.55, c: 0.62, z: 10.0, y: 0.6, t: 0.12 };
  k.sym('skin', wing([wr, wt]));
  if (wl2) for (const s of [-1, 1]) k.add('skin', fin([{ d: 4.55, c: 0.62, z: 0, t: 0.1 }, { d: 4.8, c: 0.35, z: 0.9, t: 0.1 }], [0, 0.6, s * 10.0], s * 0.25));
  // V-tail (upward) + ventral fin
  const vr: Sec = { d: 8.9, c: 1.35, z: 0, t: 0.1 };
  const vt: Sec = { d: 9.85, c: 0.6, z: 2.3, t: 0.09 };
  k.sym('skin', fin([vr, vt], [0, 0.2, 0.12], 0.78));
  k.symc(fin([lerpSec(vr, vt, 0.72, 1.3), { ...vt, t: 0.12 }], [0, 0.2, 0.12], 0.78), o.team);
  k.add('skin', fin([{ d: 9.2, c: 1.1, z: 0, t: 0.1 }, { d: 9.8, c: 0.55, z: 1.15, t: 0.09 }], [0, -0.2, 0], PI));
  // sensor turret, SATCOM bulge shading
  sensorBall(k, 1.3, -0.68, 0.34);
  // pusher prop
  prop(k, [-L + 0.05, 0.06, 0], [0, 0, PI / 2], 1.45, wl2 ? 3 : 4, 0.22, 60, { spinner: 0.14 });
  k.col(cylX(0.12, 0.08, 0.3, 8, [-10.75, 0.06, 0]), 0x3a3c3e);
  // stores: Hellfire inner/outer, GBU-12
  for (const s of [-1, 1]) {
    uavMissile(k, 3.9, 0.12, s * 3.1, 1.63, 0.09, 0x50583a);
    uavMissile(k, 4.0, 0.2, s * 5.0, 1.63, 0.09, 0x50583a);
    if (wl2) uavMissile(k, 4.1, 0.28, s * 6.6, 1.63, 0.09, 0xd0d2cc);
  }
  k.symc(wing([lerpSec(wr, wt, 0.9, 1.25), { ...wt, t: 0.15 }]), o.team);
  k.light('lit', C.red, [-4.8, 0.6, -10.05]);
  k.light('lit', C.green, [-4.8, 0.6, 10.05]);
  k.light('strobe', 0xffffff, [-5.0, 0.58, 0], 0.008);
  k.light('beacon', 0xff2a1a, [-6.0, -0.4, 0], 0.008);
  if (wl2) roundelH(k, 4.8, 0.45, 7.8, 0.35, INSIGNIA.china), roundelH(k, 4.8, 0.45, -7.8, 0.35, INSIGNIA.china);
  return { S: 0.92 / 20.3, kind: 'uav', paint: { skin: { color: wl2 ? 0xd5d8da : 0x8d9398, metal: 0.25 }, glass: 0x2a3540 } };
}

function hermes(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.06, t: 0.06, y: 0 },
        { d: 0.4, w: 0.22, t: 0.24, b: 0.22, y: 0.02 },
        { d: 1.4, w: 0.3, t: 0.34, b: 0.3, y: 0.04 },
        { d: 3.6, w: 0.28, t: 0.32, b: 0.28, y: 0.04 },
        { d: 5.4, w: 0.16, t: 0.18, b: 0.16, y: 0.04 },
        { d: 6.0, w: 0.08, t: 0.08, y: 0.04 },
      ],
      14,
      2,
    ),
  );
  const wr: Sec = { d: 2.1, c: 0.85, z: 0.2, y: 0.3, t: 0.13 };
  const wt: Sec = { d: 2.3, c: 0.42, z: 5.25, y: 0.42, t: 0.12 };
  k.sym('skin', wing([wr, wt]));
  k.add('skin', loft([{ d: 2.0, w: 0.12, t: 0.06, y: 0.36 }, { d: 2.5, w: 0.18, t: 0.12, y: 0.36 }, { d: 3.0, w: 0.12, t: 0.06, y: 0.36 }], 10, 1)); // wing pylon fairing
  const vr: Sec = { d: 5.0, c: 0.85, z: 0, t: 0.1 };
  const vt: Sec = { d: 5.6, c: 0.4, z: 1.35, t: 0.09 };
  k.sym('skin', fin([vr, vt], [0, 0.1, 0.06], 0.75));
  k.symc(fin([lerpSec(vr, vt, 0.68, 1.3), { ...vt, t: 0.12 }], [0, 0.1, 0.06], 0.75), o.team);
  sensorBall(k, 1.0, -0.45, 0.2);
  prop(k, [-6.05, 0.04, 0], [0, 0, PI / 2], 0.85, 2, 0.14, 70, { spinner: 0.08 });
  for (const s of [-1, 1]) uavMissile(k, 1.9, 0.2, s * 1.5, 1.2, 0.07);
  k.symc(wing([lerpSec(wr, wt, 0.88, 1.25), { ...wt, t: 0.15 }]), o.team);
  roundelH(k, 2.4, 0.4, 3.4, 0.22, 'israel');
  roundelH(k, 2.4, 0.4, -3.4, 0.22, 'israel');
  k.light('lit', C.red, [-2.5, 0.42, -5.3]);
  k.light('lit', C.green, [-2.5, 0.42, 5.3]);
  k.light('strobe', 0xffffff, [-3.0, 0.32, 0], 0.008);
  return { S: 0.86 / 10.5, kind: 'uav', paint: { skin: { color: 0xc6c9cb, metal: 0.2 }, glass: 0x2a3540 } };
}

function orion(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.1, t: 0.1, y: 0 },
        { d: 0.5, w: 0.38, t: 0.4, b: 0.36, y: 0.06 },
        { d: 1.4, w: 0.44, t: 0.48, b: 0.36, y: 0.08 },
        { d: 3.0, w: 0.38, t: 0.38, b: 0.34, y: 0.06 },
        { d: 6.0, w: 0.22, t: 0.22, b: 0.2, y: 0.04 },
        { d: 7.7, w: 0.1, t: 0.1, y: 0.04 },
      ],
      16,
      2,
    ),
  );
  const wr: Sec = { d: 2.7, c: 1.0, z: 0.3, y: 0.34, t: 0.13 };
  const wt: Sec = { d: 2.95, c: 0.45, z: 8.0, y: 0.55, t: 0.12 };
  k.sym('skin', wing([wr, wt]));
  const vr: Sec = { d: 6.6, c: 1.0, z: 0, t: 0.1 };
  const vt: Sec = { d: 7.3, c: 0.48, z: 1.7, t: 0.09 };
  k.sym('skin', fin([vr, vt], [0, 0.12, 0.08], 0.7));
  k.symc(fin([lerpSec(vr, vt, 0.68, 1.3), { ...vt, t: 0.12 }], [0, 0.12, 0.08], 0.7), o.team);
  sensorBall(k, 1.1, -0.58, 0.28);
  prop(k, [-7.75, 0.04, 0], [0, 0, PI / 2], 1.0, 2, 0.18, 65, { spinner: 0.1 });
  for (const s of [-1, 1]) {
    uavMissile(k, 2.6, 0.24, s * 2.2, 1.4, 0.08, 0x5a6248);
    uavMissile(k, 2.65, 0.3, s * 3.6, 1.0, 0.1, 0x5a6248);
  }
  k.symc(wing([lerpSec(wr, wt, 0.88, 1.25), { ...wt, t: 0.15 }]), o.team);
  roundelH(k, 3.2, 0.48, 5.6, 0.3, INSIGNIA.russia);
  roundelH(k, 3.2, 0.48, -5.6, 0.3, INSIGNIA.russia);
  k.light('lit', C.red, [-3.2, 0.55, -8.05]);
  k.light('lit', C.green, [-3.2, 0.55, 8.05]);
  k.light('strobe', 0xffffff, [-3.5, 0.5, 0], 0.008);
  return { S: 0.9 / 16.0, kind: 'uav', paint: { skin: { color: 0xc9cdcf, metal: 0.2 }, glass: 0x2a3540 } };
}

function heronTP(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.12, t: 0.12, y: 0 },
        { d: 0.6, w: 0.48, t: 0.5, b: 0.46, y: 0.06 },
        { d: 1.8, w: 0.6, t: 0.82, b: 0.52, y: 0.14 },
        { d: 4.0, w: 0.6, t: 0.66, b: 0.55, y: 0.1 },
        { d: 7.2, w: 0.52, t: 0.55, b: 0.5, y: 0.08 },
        { d: 9.0, w: 0.36, t: 0.36, b: 0.34, y: 0.08 },
        { d: 9.6, w: 0.22, t: 0.22, b: 0.22, y: 0.08 },
      ],
      16,
      2,
    ),
  );
  const wr: Sec = { d: 4.7, c: 1.75, z: 0.45, y: 0.42, t: 0.13 };
  const wt: Sec = { d: 5.2, c: 0.7, z: 13.0, y: 0.9, t: 0.12 };
  k.sym('skin', wing([wr, wt]));
  // twin booms with fins and a connecting tailplane
  for (const s of [-1, 1]) {
    const bm = loft([{ d: 4.0, z: 2.0, w: 0.16, t: 0.2, y: 0.44 }, { d: 5.0, z: 2.0, w: 0.2, t: 0.24, y: 0.44 }, { d: 12.4, z: 2.0, w: 0.13, t: 0.15, y: 0.44 }, { d: 13.9, z: 2.0, w: 0.08, t: 0.1, y: 0.46 }], 10, 2);
    k.add('skin', s > 0 ? bm : mirZ(bm));
    const fr: Sec = { d: 12.1, c: 1.7, z: 0, t: 0.1 };
    const ft: Sec = { d: 12.9, c: 0.9, z: 1.9, t: 0.09 };
    k.add('skin', fin([fr, ft], [0, 0.5, s * 2.0], 0));
    k.col(fin([lerpSec(fr, ft, 0.66, 1.3), { ...ft, t: 0.12 }], [0, 0.5, s * 2.0], 0), o.team);
  }
  k.add('skin', wing([{ d: 12.5, c: 1.25, z: -2.0, y: 1.6, t: 0.1 }, { d: 12.5, c: 1.25, z: 2.0, y: 1.6, t: 0.1 }]));
  sensorBall(k, 1.6, -0.75, 0.36);
  prop(k, [-9.75, 0.08, 0], [0, 0, PI / 2], 1.45, 3, 0.24, 60, { spinner: 0.16 });
  for (const s of [-1, 1]) uavMissile(k, 4.6, 0.3, s * 4.6, 1.4, 0.09);
  k.symc(wing([lerpSec(wr, wt, 0.9, 1.25), { ...wt, t: 0.15 }]), o.team);
  for (const s of [-1, 1]) {
    k.col(box(0.7, 0.02, 0.24, [-5.6, 0.82, s * 8.0]), 0xf2f2f0);
    k.col(box(0.24, 0.02, 0.7, [-5.6, 0.82, s * 8.0]), 0xf2f2f0);
    k.col(box(0.55, 0.03, 0.12, [-5.6, 0.83, s * 8.0]), 0x111111);
    k.col(box(0.12, 0.03, 0.55, [-5.6, 0.83, s * 8.0]), 0x111111);
  }
  k.light('lit', C.red, [-5.5, 0.9, -13.05]);
  k.light('lit', C.green, [-5.5, 0.9, 13.05]);
  k.light('strobe', 0xffffff, [-5.0, 0.98, 0], 0.008);
  roundelH(k, 5.6, 0.8, 8.0, 0.42, 'germany');
  roundelH(k, 5.6, 0.8, -8.0, 0.42, 'germany');
  return { S: 1.0 / 26.0, kind: 'uav', paint: { skin: { color: 0xb9bec2, metal: 0.25 }, glass: 0x2a3540 } };
}

function kusfs(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.1, t: 0.1, y: 0 },
        { d: 0.6, w: 0.45, t: 0.48, b: 0.42, y: 0.06 },
        { d: 1.8, w: 0.55, t: 0.7, b: 0.48, y: 0.14 },
        { d: 4.0, w: 0.54, t: 0.56, b: 0.48, y: 0.1 },
        { d: 8.5, w: 0.38, t: 0.38, b: 0.36, y: 0.06 },
        { d: 11.8, w: 0.18, t: 0.18, b: 0.18, y: 0.06 },
        { d: 12.4, w: 0.1, t: 0.1, y: 0.06 },
      ],
      16,
      2,
    ),
  );
  const wr: Sec = { d: 4.8, c: 1.7, z: 0.4, y: 0.35, t: 0.14 };
  const wt: Sec = { d: 5.4, c: 0.6, z: 12.5, y: 0.75, t: 0.12 };
  k.sym('skin', wing([wr, wt]));
  for (const s of [-1, 1]) k.add('skin', fin([{ d: 5.4, c: 0.6, z: 0, t: 0.1 }, { d: 5.75, c: 0.32, z: 1.0, t: 0.1 }], [0, 0.75, s * 12.5], s * 0.2));
  // inverted-V tail with a dorsal fin
  const vr: Sec = { d: 10.4, c: 1.5, z: 0, t: 0.1 };
  const vt: Sec = { d: 11.4, c: 0.7, z: 2.2, t: 0.09 };
  k.sym('skin', fin([vr, vt], [0, -0.05, 0.1], PI - 0.85));
  k.symc(fin([lerpSec(vr, vt, 0.72, 1.3), { ...vt, t: 0.12 }], [0, -0.05, 0.1], PI - 0.85), o.team);
  k.add('skin', fin([{ d: 10.2, c: 1.6, z: 0, t: 0.1 }, { d: 11.2, c: 0.7, z: 1.3, t: 0.09 }], [0, 0.25, 0], 0));
  sensorBall(k, 1.5, -0.68, 0.34);
  prop(k, [-12.45, 0.06, 0], [0, 0, PI / 2], 1.5, 3, 0.24, 60, { spinner: 0.13 });
  for (const s of [-1, 1]) {
    uavMissile(k, 4.6, 0.22, s * 3.4, 1.63, 0.09, 0x50583a);
    uavMissile(k, 4.7, 0.3, s * 5.4, 1.63, 0.09, 0x50583a);
  }
  k.symc(wing([lerpSec(wr, wt, 0.9, 1.25), { ...wt, t: 0.15 }]), o.team);
  roundelH(k, 5.6, 0.62, 8.6, 0.38, INSIGNIA.korea);
  roundelH(k, 5.6, 0.62, -8.6, 0.38, INSIGNIA.korea);
  k.light('lit', C.red, [-5.6, 0.78, -12.55]);
  k.light('lit', C.green, [-5.6, 0.78, 12.55]);
  k.light('strobe', 0xffffff, [-6.0, 0.6, 0], 0.008);
  return { S: 0.95 / 25.0, kind: 'uav', paint: { skin: { color: 0xd6d9db, metal: 0.2 }, glass: 0x2a3540 } };
}

/** Bayraktar TB2: slim fuselage, twin booms with an inverted-V tail, pusher prop. */
function tb2(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.08, t: 0.08, y: 0 },
        { d: 0.5, w: 0.25, t: 0.26, b: 0.24, y: 0.02 },
        { d: 1.6, w: 0.32, t: 0.36, b: 0.3, y: 0.04 },
        { d: 3.6, w: 0.3, t: 0.32, b: 0.28, y: 0.04 },
        { d: 5.0, w: 0.18, t: 0.2, b: 0.18, y: 0.04 },
        { d: 5.4, w: 0.1, t: 0.1, y: 0.04 },
      ],
      14,
      2,
    ),
  );
  const wr: Sec = { d: 2.1, c: 0.95, z: 0.2, y: 0.26, t: 0.13 };
  const wt: Sec = { d: 2.3, c: 0.45, z: 6.0, y: 0.4, t: 0.12 };
  k.sym('skin', wing([wr, wt]));
  for (const s of [-1, 1]) {
    const bm = loft([{ d: 1.8, z: 1.1, w: 0.07, t: 0.08, y: 0.26 }, { d: 2.3, z: 1.1, w: 0.09, t: 0.1, y: 0.26 }, { d: 6.0, z: 1.1, w: 0.06, t: 0.07, y: 0.26 }, { d: 6.5, z: 1.1, w: 0.04, t: 0.05, y: 0.26 }], 8, 2);
    k.add('skin', s > 0 ? bm : mirZ(bm));
    // inverted V: each surface slopes down and inward from the boom
    const vr: Sec = { d: 5.6, c: 0.85, z: 0, t: 0.1 };
    const vt: Sec = { d: 6.0, c: 0.5, z: 1.05, t: 0.09 };
    k.add('skin', fin([vr, vt], [0, 0.26, s * 1.1], PI + s * 0.8));
    k.col(fin([lerpSec(vr, vt, 0.6, 1.3), { ...vt, t: 0.12 }], [0, 0.26, s * 1.1], PI + s * 0.8), o.team);
  }
  sensorBall(k, 0.9, -0.4, 0.22);
  prop(k, [-5.45, 0.04, 0], [0, 0, PI / 2], 0.85, 2, 0.15, 70, { spinner: 0.08 });
  for (const s of [-1, 1]) {
    uavMissile(k, 1.95, 0.18, s * 2.0, 0.95, 0.08, 0x4d5040); // MAM-L
    uavMissile(k, 2.0, 0.22, s * 3.0, 0.95, 0.08, 0x4d5040);
  }
  k.symc(wing([lerpSec(wr, wt, 0.88, 1.25), { ...wt, t: 0.15 }]), o.team);
  const ins = INSIGNIA[o.faction] ?? INSIGNIA.turkey;
  roundelH(k, 2.3, 0.38, 4.4, 0.26, ins);
  roundelH(k, 2.3, 0.38, -4.4, 0.26, ins);
  k.light('lit', C.red, [-2.5, 0.4, -6.05]);
  k.light('lit', C.green, [-2.5, 0.4, 6.05]);
  k.light('strobe', 0xffffff, [-3.0, 0.32, 0], 0.008);
  return { S: 0.86 / 12.0, kind: 'uav', paint: { skin: { color: 0xc2c6c9, metal: 0.2 }, glass: 0x2a3540 } };
}

/** Mohajer-6: high wing, twin booms, twin fins joined by a tailplane, pusher prop. */
function mohajer(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.1, t: 0.1, y: -0.02 },
        { d: 0.5, w: 0.3, t: 0.3, b: 0.3, y: 0.0 },
        { d: 1.6, w: 0.36, t: 0.4, b: 0.34, y: 0.04 },
        { d: 3.4, w: 0.34, t: 0.36, b: 0.32, y: 0.04 },
        { d: 4.4, w: 0.2, t: 0.22, b: 0.2, y: 0.04 },
        { d: 4.7, w: 0.12, t: 0.12, y: 0.04 },
      ],
      14,
      2,
    ),
  );
  const wr: Sec = { d: 1.9, c: 0.95, z: 0.2, y: 0.36, t: 0.14 };
  const wt: Sec = { d: 2.0, c: 0.6, z: 5.0, y: 0.42, t: 0.12 };
  k.sym('skin', wing([wr, wt]));
  for (const s of [-1, 1]) {
    const bm = loft([{ d: 1.7, z: 1.0, w: 0.08, t: 0.09, y: 0.34 }, { d: 2.4, z: 1.0, w: 0.1, t: 0.11, y: 0.34 }, { d: 5.2, z: 1.0, w: 0.07, t: 0.08, y: 0.34 }, { d: 5.7, z: 1.0, w: 0.04, t: 0.05, y: 0.34 }], 8, 2);
    k.add('skin', s > 0 ? bm : mirZ(bm));
    const fr: Sec = { d: 4.9, c: 0.8, z: 0, t: 0.1 };
    const ft: Sec = { d: 5.3, c: 0.48, z: 0.9, t: 0.09 };
    k.add('skin', fin([fr, ft], [0, 0.36, s * 1.0], 0));
    k.col(fin([lerpSec(fr, ft, 0.58, 1.3), { ...ft, t: 0.12 }], [0, 0.36, s * 1.0], 0), o.team);
  }
  k.add('skin', wing([{ d: 5.15, c: 0.6, z: -1.0, y: 0.9, t: 0.1 }, { d: 5.15, c: 0.6, z: 1.0, y: 0.9, t: 0.1 }]));
  sensorBall(k, 0.8, -0.42, 0.22);
  prop(k, [-4.75, 0.04, 0], [0, 0, PI / 2], 0.75, 2, 0.14, 70, { spinner: 0.08 });
  for (const s of [-1, 1]) uavMissile(k, 1.8, 0.22, s * 2.3, 1.3, 0.09, 0x6a6a58); // Qaem
  k.symc(wing([lerpSec(wr, wt, 0.86, 1.25), { ...wt, t: 0.15 }]), o.team);
  roundelH(k, 2.2, 0.44, 3.6, 0.24, INSIGNIA.iran);
  roundelH(k, 2.2, 0.44, -3.6, 0.24, INSIGNIA.iran);
  k.light('lit', C.red, [-2.3, 0.42, -5.05]);
  k.light('lit', C.green, [-2.3, 0.42, 5.05]);
  k.light('strobe', 0xffffff, [-2.5, 0.42, 0], 0.008);
  return { S: 0.86 / 10.0, kind: 'uav', paint: { skin: { color: 0xb4b8b2, metal: 0.2 }, glass: 0x2a3540 } };
}

/** Bayraktar Akinci: twin wing-mounted turboprops, drooped outer wings, twin canted fins. */
function akinci(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    loft(
      [
        { d: 0, w: 0.12, t: 0.12, y: -0.05 },
        { d: 0.7, w: 0.5, t: 0.5, b: 0.48, y: 0.02 },
        { d: 2.0, w: 0.66, t: 0.78, b: 0.6, y: 0.1 },
        { d: 4.6, w: 0.68, t: 0.68, b: 0.62, y: 0.1 },
        { d: 8.4, w: 0.48, t: 0.5, b: 0.45, y: 0.12 },
        { d: 11.2, w: 0.22, t: 0.24, b: 0.2, y: 0.18 },
        { d: 12.1, w: 0.08, t: 0.08, y: 0.2 },
      ],
      18,
      2,
    ),
  );
  // inner wing (low), drooped outer panels
  const w0: Sec = { d: 4.6, c: 2.3, z: 0.5, y: -0.3, t: 0.14 };
  const w1: Sec = { d: 5.2, c: 1.5, z: 6.0, y: -0.15, t: 0.13 };
  const w2: Sec = { d: 5.8, c: 0.7, z: 10.0, y: -0.7, t: 0.12 };
  k.sym('skin', wing([w0, w1]));
  k.sym('skin', wing([w1, w2]));
  // engine nacelles with tractor props
  for (const s of [-1, 1]) {
    const n = loft([{ d: 2.7, z: 3.2, w: 0.22, t: 0.22, y: -0.2 }, { d: 3.2, z: 3.2, w: 0.38, t: 0.4, y: -0.22 }, { d: 5.5, z: 3.2, w: 0.36, t: 0.38, y: -0.25 }, { d: 7.6, z: 3.2, w: 0.12, t: 0.12, y: -0.24 }], 12, 2);
    k.add('skin', s > 0 ? n : mirZ(n));
    k.col(box(0.5, 0.12, 0.14, [-5.6, -0.2, s * 3.56]), 0x2a2522);
    prop(k, [-2.6, -0.2, s * 3.2], [0, 0, -PI / 2], 1.3, 3, 0.26, s * 55, { spinner: 0.22 });
  }
  // twin canted fins + tailplane
  const vr: Sec = { d: 9.6, c: 1.9, z: 0, t: 0.1 };
  const vt: Sec = { d: 10.8, c: 0.9, z: 2.2, t: 0.09 };
  k.sym('skin', fin([vr, vt], [0, 0.45, 0.25], 0.55));
  k.symc(fin([lerpSec(vr, vt, 0.7, 1.3), { ...vt, t: 0.12 }], [0, 0.45, 0.25], 0.55), o.team);
  k.sym('skin', wing([{ d: 10.0, c: 1.5, z: 0.2, y: 0.25, t: 0.09 }, { d: 10.6, c: 0.8, z: 2.6, y: 0.25, t: 0.08 }]));
  sensorBall(k, 1.6, -0.75, 0.36);
  for (const s of [-1, 1]) {
    uavMissile(k, 4.4, -0.42, s * 1.9, 1.8, 0.1, 0xc8c8be);
    uavMissile(k, 5.0, -0.32, s * 5.0, 1.8, 0.1, 0xc8c8be);
  }
  k.symc(wing([lerpSec(w1, w2, 0.88, 1.25), { ...w2, t: 0.15 }]), o.team);
  roundelH(k, 5.5, 0.0, 7.6, 0.4, INSIGNIA.turkey);
  roundelH(k, 5.5, 0.0, -7.6, 0.4, INSIGNIA.turkey);
  k.light('lit', C.red, [-6.0, -0.7, -10.05]);
  k.light('lit', C.green, [-6.0, -0.7, 10.05]);
  k.light('strobe', 0xffffff, [-6.0, 0.82, 0], 0.008);
  k.light('beacon', 0xff2a1a, [-7.0, -0.48, 0], 0.008);
  return { S: 1.1 / 20.0, kind: 'uav', paint: { skin: { color: 0xc4c7c9, metal: 0.25 }, glass: 0x2a3540 } };
}

// =================================================================== small drones

/** FPV kamikaze quad with an RPG warhead slung underneath (metres; ~0.42 m across). */
function fpv(k: Kit, o: UavO): Built {
  const carbon = 0x1f2224;
  const arm = 0.16;
  for (const a of [PI / 4, -PI / 4]) k.col(tf(box(arm * 2 + 0.04, 0.012, 0.028), [0, 0, 0], [0, a, 0]), carbon);
  k.col(box(0.11, 0.008, 0.07, [0, 0.03, 0]), carbon);
  for (const [x, z] of [
    [0.04, 0.025],
    [0.04, -0.025],
    [-0.04, 0.025],
    [-0.04, -0.025],
  ] as P2[])
    k.col(cylY(0.003, 0.003, 0.03, 4, [x, 0.017, z]), 0xc8a050);
  // battery + strap (team)
  k.col(box(0.085, 0.032, 0.042, [-0.005, 0.052, 0]), 0x2a2c30);
  k.col(box(0.02, 0.036, 0.046, [-0.005, 0.052, 0]), o.team);
  k.col(box(0.07, 0.003, 0.036, [-0.005, 0.07, 0]), 0xd8c030);
  // camera
  k.col(tf(box(0.022, 0.022, 0.024), [0.058, 0.018, 0], [0, 0, 0.35]), 0x2a2c30);
  k.add('glass', cylX(0.007, 0.008, 0.008, 8, [0.071, 0.022, 0]));
  // antennas
  k.col(tf(cylY(0.0015, 0.0015, 0.06, 4), [-0.06, 0.05, 0.012], [0.4, 0, 0.6]), 0x111111);
  k.col(tf(cylY(0.0015, 0.0015, 0.06, 4), [-0.06, 0.05, -0.012], [-0.4, 0, 0.6]), 0x111111);
  // motors + props
  const ends: P2[] = [];
  const discs: THREE.BufferGeometry[] = [];
  for (const a of [PI / 4, (3 * PI) / 4, (5 * PI) / 4, (7 * PI) / 4]) ends.push([Math.cos(a) * arm, Math.sin(a) * arm]);
  ends.forEach(([x, z], i) => {
    k.col(cylY(0.014, 0.014, 0.018, 10, [x, 0.012, z]), 0x3a3c40);
    k.col(cylY(0.016, 0.016, 0.004, 10, [x, 0.0, z]), o.team);
    prop(k, [x, 0.026, z], [0, 0, 0], 0.088, 3, 0.022, i % 2 ? 110 : -110, { color: 0x2a2c30, th: 0.003, noDisc: true });
    discs.push(tf(prep(new THREE.CircleGeometry(0.088, 24), true), [x, 0.026, z], [-PI / 2, 0, 0]));
  });
  const dk = k.sub([0, 0, 0]);
  dk.add('disc', discs);
  dk.disc = '3|1';
  // RPG warhead (PG-7VL) strapped beneath, pointing forward
  k.col(lathe([[0, 0], [0.012, 0.012], [0.05, 0.034], [0.09, 0.046], [0.12, 0.046], [0.15, 0.022], [0.3, 0.02], [0.32, 0.015]], 12, [0.16, -0.045, 0]), 0x58603e);
  k.col(cylX(0.006, 0.006, 0.02, 6, [0.17, -0.045, 0]), 0x9a9a90);
  k.col(box(0.012, 0.05, 0.05, [-0.1, -0.045, 0]), 0x222222);
  k.col(box(0.06, 0.012, 0.03, [0.0, -0.016, 0]), 0x111111); // zip ties / mount
  k.light('lit', 0x30ff60, [-0.05, 0.03, 0.04], 0.006);
  k.light('lit', 0xff3020, [-0.05, 0.03, -0.04], 0.006);
  k.light('strobe', 0xffffff, [0.045, 0.034, 0], 0.005);
  return { S: 0.43, kind: 'quad', paint: { skin: { color: 0x2a2c30 }, glass: 0x1a2a3a } };
}

/** Tube-launched swarm micro-drone (CH-901 class): cylinder body, tandem folding wings, pusher prop. */
function micro(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    lathe(
      [
        [0, 0],
        [0.02, 0.025],
        [0.06, 0.04],
        [0.5, 0.04],
        [0.58, 0.028],
      ],
      12,
    ),
  );
  k.add('glass', sph(0.026, [-0.012, -0.012, 0], [1.3, 0.9, 0.9], 8, 6));
  k.sym('skin', wing([{ d: 0.12, c: 0.06, z: 0.03, y: 0.035, t: 0.08 }, { d: 0.15, c: 0.045, z: 0.3, y: 0.05, t: 0.08 }]));
  k.sym('skin', wing([{ d: 0.38, c: 0.06, z: 0.03, y: -0.03, t: 0.08 }, { d: 0.4, c: 0.05, z: 0.28, y: -0.04, t: 0.08 }]));
  k.add('skin', fin([{ d: 0.46, c: 0.09, z: 0, t: 0.08 }, { d: 0.5, c: 0.05, z: 0.07, t: 0.08 }], [0, 0.03, 0], 0));
  k.add('skin', fin([{ d: 0.46, c: 0.09, z: 0, t: 0.08 }, { d: 0.5, c: 0.05, z: 0.06, t: 0.08 }], [0, -0.03, 0], PI));
  k.col(cylX(0.042, 0.042, 0.05, 12, [-0.2, 0, 0]), o.team);
  k.symc(wing([{ d: 0.14, c: 0.05, z: 0.25, y: 0.047, t: 0.1 }, { d: 0.15, c: 0.046, z: 0.305, y: 0.05, t: 0.1 }]), o.team);
  prop(k, [-0.59, 0, 0], [0, 0, PI / 2], 0.075, 2, 0.018, 120, { color: 0x222426, th: 0.004, spinner: 0.012 });
  k.light('lit', 0xff3020, [-0.3, 0.045, 0], 0.005);
  return { S: 0.15 / 0.62, kind: 'loiter', paint: { skin: { color: 0x7d8488, metal: 0.3 }, glass: 0x152530 } };
}

/** Shahed-136: cropped delta with wingtip fins, nose warhead, rear pusher. */
function shahed(k: Kit, o: UavO): Built {
  k.add(
    'skin',
    lathe(
      [
        [0, 0],
        [0.08, 0.12],
        [0.25, 0.2],
        [0.5, 0.22],
        [2.9, 0.22],
        [3.15, 0.17],
        [3.3, 0.12],
      ],
      14,
    ),
  );
  // warhead section seam + darker nose
  k.add('skin2', lathe([[0, 0], [0.08, 0.121], [0.25, 0.201], [0.5, 0.221], [0.52, 0]], 14));
  // cropped delta wing
  k.sym(
    'skin',
    wing([
      { d: 0.9, c: 2.2, z: 0.15, y: 0.0, t: 0.07 },
      { d: 2.35, c: 0.72, z: 1.22, y: 0.0, t: 0.06 },
    ]),
  );
  // wingtip fins (up & down)
  for (const s of [-1, 1]) {
    k.add('skin', plate([[2.4, -0.28], [2.2, 0.0], [2.35, 0.38], [2.7, 0.38], [3.06, 0.0], [2.9, -0.28]], 0.035, s * 1.24, 0.01));
    k.col(plate([[2.33, 0.2], [2.35, 0.38], [2.7, 0.38], [2.83, 0.2]], 0.045, s * 1.24, 0.01), o.team);
  }
  // engine + prop
  k.col(lathe([[3.2, 0.13], [3.35, 0.14], [3.45, 0.11], [3.5, 0.05]], 10), 0x3a3a38);
  k.col(cylY(0.02, 0.02, 0.18, 6, [-3.15, 0.25, 0]), 0x2a2a28); // exhaust stack
  prop(k, [-3.52, 0, 0], [0, 0, PI / 2], 0.38, 2, 0.07, 90, { color: 0x2a2826, spinner: 0.05 });
  k.col(box(0.3, 0.02, 0.02, [-1.6, 0.22, 0]), 0x333333);
  return { S: 0.62 / 3.5, kind: 'loiter', paint: { skin: { color: 0xa69f8e, metal: 0.15, rough: 0.95 }, skin2: { color: 0x8a8576, metal: 0.15 }, glass: 0x222222 } };
}

// =================================================================== registry & templates

type DesignFn = (k: Kit, team: number, faction: string) => Built;

function fighterDesign(f: string): DesignFn {
  switch (f) {
    case 'israel':
      return (k, t) => f35(k, t, true);
    case 'china':
      return (k, t) => j20(k, t);
    case 'russia':
      return (k, t) => su35(k, t);
    case 'germany':
      return (k, t) => typhoon(k, t);
    case 'korea':
      return (k, t) => f15k(k, t);
    case 'ukraine':
    case 'turkey':
    case 'iran':
      return (k, t, fa) => f16(k, t, fa);
    default:
      return (k, t) => f35(k, t, false);
  }
}
function heliDesign(f: string): DesignFn {
  switch (f) {
    case 'israel':
      return (k, team, faction) => apache(k, { team, faction }, true);
    case 'china':
      return (k, team, faction) => z10(k, { team, faction });
    case 'russia':
      return (k, team, faction) => ka52(k, { team, faction });
    case 'germany':
      return (k, team, faction) => tiger(k, { team, faction });
    case 'ukraine':
      return (k, team, faction) => mi24(k, { team, faction });
    case 'turkey':
      return (k, team, faction) => t129(k, { team, faction });
    case 'iran':
      return (k, team, faction) => cobra(k, { team, faction });
    default:
      return (k, team, faction) => apache(k, { team, faction }, false);
  }
}
function uavDesign(f: string): DesignFn {
  switch (f) {
    case 'israel':
      return (k, team, faction) => hermes(k, { team, faction });
    case 'china':
      return (k, team, faction) => reaperLike(k, { team, faction }, true);
    case 'russia':
      return (k, team, faction) => orion(k, { team, faction });
    case 'germany':
      return (k, team, faction) => heronTP(k, { team, faction });
    case 'korea':
      return (k, team, faction) => kusfs(k, { team, faction });
    case 'ukraine':
    case 'turkey':
      return (k, team, faction) => tb2(k, { team, faction });
    case 'iran':
      return (k, team, faction) => mohajer(k, { team, faction });
    default:
      return (k, team, faction) => reaperLike(k, { team, faction }, false);
  }
}

function designFor(key: string, faction: string): DesignFn {
  switch (key) {
    case 'fighter':
    case 'jet':
      return fighterDesign(faction);
    case 'heli':
      return heliDesign(faction);
    case 'uav':
      return uavDesign(faction);
    case 'heavy_uav':
      return (k, team, f) => akinci(k, { team, faction: f });
    case 'fpv':
      return (k, team, f) => fpv(k, { team, faction: f });
    case 'micro':
      return (k, team, f) => micro(k, { team, faction: f });
    default:
      return (k, team, f) => shahed(k, { team, faction: f });
  }
}

interface Template {
  root: THREE.Group;
  height: number;
  size: { x: number; y: number; z: number };
  kind: Built['kind'];
  fx: NonNullable<Model['damageFx']>;
}
const templates = new Map<string, Template>();

function buildTemplate(key: string, style: ModelStyle, fog: FogOfWar | null): Template {
  const faction = style.faction;
  // pre-scan S: designs declare S in their return value, so build into a kit first
  const k = new Kit();
  const built = designFor(key, faction)(k, style.team, faction);
  placeDecals(k);
  const body = realize(k, built.paint, fog, built.S);
  body.scale.setScalar(built.S);
  const bank = new THREE.Group();
  bank.userData.bank = built.kind;
  bank.add(body);
  const root = new THREE.Group();
  root.add(bank);
  root.updateMatrixWorld(true);
  const bb = new THREE.Box3().setFromObject(root);
  const c = bb.getCenter(new THREE.Vector3());
  body.position.set(-c.x, -c.y, -c.z);
  root.updateMatrixWorld(true);
  bb.setFromObject(root);
  const sz = bb.getSize(new THREE.Vector3());
  // airframe box (skin only: no rotor discs / plumes) for damage points and flare dispensers
  const ab = new THREE.Box3();
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh && (o.userData.bk === 'skin' || o.userData.bk === 'skin2')) ab.expandByObject(o, false);
  });
  if (ab.isEmpty()) ab.copy(bb);
  const L = ab.max.x - ab.min.x;
  const Hh = ab.max.y - ab.min.y;
  const Wd = ab.max.z - ab.min.z;
  const cy = (ab.min.y + ab.max.y) / 2;
  const kind = built.kind;
  const fx: NonNullable<Model['damageFx']> = [];
  const P = (fx_: number, fy: number, fz: number) => new THREE.Vector3(ab.min.x + L * fx_, ab.min.y + Hh * fy, ab.min.z + Wd * fz);
  if (kind === 'jet') {
    fx.push({ pos: P(0.04, 0.45, 0.5), kind: 'smoke', at: 0.35 }, { pos: P(0.5, 0.5, 0.36), kind: 'spark', at: 0.45 }, { pos: P(0.42, 0.5, 0.7), kind: 'smoke', at: 0.55 }, { pos: P(0.06, 0.45, 0.5), kind: 'fire', at: 0.7 }, { pos: P(0.45, 0.5, 0.3), kind: 'fire', at: 0.88 });
  } else if (kind === 'heli') {
    fx.push({ pos: P(0.42, 0.62, 0.5), kind: 'smoke', at: 0.35 }, { pos: P(0.6, 0.45, 0.62), kind: 'spark', at: 0.45 }, { pos: P(0.22, 0.55, 0.5), kind: 'smoke', at: 0.6 }, { pos: P(0.45, 0.6, 0.45), kind: 'fire', at: 0.7 }, { pos: P(0.62, 0.4, 0.4), kind: 'spark', at: 0.8 });
  } else if (kind === 'uav') {
    fx.push({ pos: P(0.12, 0.5, 0.5), kind: 'smoke', at: 0.35 }, { pos: P(0.55, 0.5, 0.35), kind: 'spark', at: 0.5 }, { pos: P(0.14, 0.5, 0.5), kind: 'fire', at: 0.7 });
  } else {
    fx.push({ pos: P(0.3, 0.5, 0.5), kind: 'smoke', at: 0.4 }, { pos: P(0.5, 0.5, 0.5), kind: 'spark', at: 0.6 });
  }
  // flare / chaff dispensers under the rear fuselage (jets) or on the cabin / boom sides (helicopters)
  if (kind === 'jet' || kind === 'heli') {
    for (const s of [-1, 1]) {
      const o = new THREE.Object3D();
      o.userData.flare = true;
      const zc = (ab.min.z + ab.max.z) / 2;
      if (kind === 'jet') o.position.set(ab.min.x + L * 0.16, ab.min.y + Hh * 0.25, zc + s * Wd * 0.07);
      else o.position.set(ab.min.x + L * 0.42, cy - Hh * 0.05, zc + s * Wd * 0.14);
      bank.add(o);
    }
  }
  return { root, height: Math.max(0.08, bb.max.y + 0.04), size: { x: sz.x, y: sz.y, z: sz.z }, kind: built.kind, fx };
}

function instance(key: string, style: ModelStyle, fog: FogOfWar | null): Model {
  const tk = `${key}|${style.faction}|${style.team}|${fid(fog)}`;
  let t = templates.get(tk);
  if (!t) {
    t = buildTemplate(key, style, fog);
    templates.set(tk, t);
  }
  const root = t.root.clone(true);
  const spins: THREE.Object3D[] = [];
  const muzzles: THREE.Object3D[] = [];
  const strobes: THREE.Object3D[] = [];
  const plumes: THREE.Object3D[] = [];
  const flares: THREE.Object3D[] = [];
  const glow: THREE.Material[] = [];
  let bank: THREE.Object3D | null = null;
  let abMat: THREE.MeshStandardMaterial | null = null;
  root.traverse((o) => {
    const u = o.userData;
    if (u.spin) spins.push(o);
    if (u.muzzle) muzzles.push(o);
    if (u.bank) bank = o;
    if (u.plume) plumes.push(o);
    if (u.flare) flares.push(o);
    if (o instanceof THREE.Mesh) {
      if (u.bk === 'strobe') strobes.push(o);
      else if (u.bk === 'glow') {
        abMat ??= nozzleGlow(fog);
        o.material = abMat;
      }
      if (u.bk === 'glow' || u.bk === 'lit' || u.bk === 'strobe') {
        if (!glow.includes(o.material as THREE.Material)) glow.push(o.material as THREE.Material);
      }
    }
  });
  const kind = t.kind;
  const phase = Math.random() * 10;
  const wear = new WearDriver(root, airSeq++ & 3);
  for (const s of spins) s.rotation.y += Math.random() * TAU;
  let roll = 0;
  let pitch = 0;
  let ab = 0.3;
  const anim = (s: AnimState) => {
    const dt = s.dt;
    if (!(s.dead > 0)) wear.update(s.damage);
    for (const sp of spins) sp.rotation.y += (sp.userData.spin as number) * dt;
    const b = bank as THREE.Object3D | null;
    const k = Math.min(1, dt * 4);
    if (b) {
      const turn = Number.isFinite(s.turn) ? s.turn : 0;
      const maxRoll = kind === 'jet' ? 0.75 : kind === 'heli' ? 0.3 : kind === 'quad' ? 0.45 : 0.4;
      roll += (clamp(-turn * (kind === 'jet' ? 0.9 : 0.5), -maxRoll, maxRoll) - roll) * k;
      const sp = Math.max(0, s.speed || 0);
      const pitchT = kind === 'heli' ? -Math.min(1, sp / 3) * 0.13 : kind === 'quad' ? -Math.min(1, sp / 5) * 0.4 : 0;
      pitch += (pitchT - pitch) * k;
      b.rotation.set(roll, 0, pitch);
      if (kind === 'heli') b.position.y = Math.sin(s.time * 1.6 + phase) * 0.012;
      else if (kind === 'quad') b.position.y = Math.sin(s.time * 3.1 + phase) * 0.006;
      else b.position.y = Math.sin(s.time * 0.9 + phase) * 0.008;
    }
    // anti-collision lights (white strobes + red beacons): double flash
    const ts = (s.time + phase) % 1.3;
    const on = ts < 0.06 || (ts > 0.16 && ts < 0.22);
    for (const o of strobes) o.visible = on;
    if (abMat || plumes.length) {
      const sp = Math.max(0, s.speed || 0);
      const target = clamp(sp / 5, 0, 1);
      ab += (target - ab) * Math.min(1, dt * 2.5);
      if (abMat) (abMat as THREE.MeshStandardMaterial).emissiveIntensity = 1.4 + ab * 3.6 + Math.sin(s.time * 37 + phase) * 0.25 * ab;
      for (const p of plumes) {
        const f = ab > 0.15 ? (ab - 0.15) / 0.85 : 0;
        p.visible = f > 0.02;
        p.scale.set(0.35 + f * (0.85 + Math.sin(s.time * 29 + phase) * 0.08), 0.7 + f * 0.3, 0.7 + f * 0.3);
      }
    }
  };
  // initial state
  for (const p of plumes) p.visible = false;
  for (const o of strobes) o.visible = false;
  const model: Model = { root, muzzles, height: t.height, size: t.size, glow, emitters: [], anim, damageFx: t.fx.map((f) => ({ pos: f.pos.clone(), kind: f.kind, at: f.at })) };
  if (flares.length) model.flareDispensers = flares;
  return model;
}
let airSeq = 0;

function builder(key: string): Builder {
  return (style, fog) => {
    try {
      return instance(key, style, fog);
    } catch (e) {
      console.error('aircraft builder failed', key, style.faction, e);
      const root = new THREE.Group();
      root.add(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.06, 0.3), new THREE.MeshStandardMaterial({ color: 0x777777 })));
      return { root, muzzles: [], height: 0.1, glow: [], emitters: [] };
    }
  };
}

/** Model builders keyed by model key (see sim/defs.ts `model` fields). */
export const AIRCRAFT: Record<string, Builder> = {
  fighter: builder('fighter'),
  jet: builder('jet'),
  heli: builder('heli'),
  uav: builder('uav'),
  heavy_uav: builder('heavy_uav'),
  fpv: builder('fpv'),
  micro: builder('micro'),
  shahed: builder('shahed'),
};

// =================================================================== munitions

/*
 * Munitions are modelled with length 1 (nose at +0.5) and scaled to their game
 * length. One vertex-coloured mesh (+ an optional glowing tracer/nozzle mesh).
 * Plain materials (no fog patch): the renderer hides invisible projectiles.
 */

let munMat: THREE.MeshStandardMaterial | null = null;
let munGlow: THREE.MeshBasicMaterial | null = null;
const munCache = new Map<string, { body: THREE.BufferGeometry; glow: THREE.BufferGeometry | null; len: number; nozzle?: THREE.Vector3 }>();

/** Colour each triangle by a function of its centroid x (crisp bands on lathes). */
function bandColor(g: THREE.BufferGeometry, fn: (x: number) => number): THREE.BufferGeometry {
  const pos = g.attributes.position;
  const arr = new Float32Array(pos.count * 3);
  for (let t = 0; t < pos.count; t += 3) {
    const cx = (pos.getX(t) + pos.getX(t + 1) + pos.getX(t + 2)) / 3;
    _c.setHex(fn(cx));
    for (let v = 0; v < 3; v++) {
      arr[(t + v) * 3] = _c.r;
      arr[(t + v) * 3 + 1] = _c.g;
      arr[(t + v) * 3 + 2] = _c.b;
    }
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

/** Lathe in unit length: profile (d from nose 0..1, radius); placed so the nose is at x = +0.5. */
function mLathe(prof: P2[], seg: number, fn: (d: number) => number) {
  return bandLathe(prof, seg, [0.5, 0, 0], fn);
}

/** n fins around the axis; outline in (d, radial) coordinates. */
function mFins(n: number, outline: P2[], th: number, color: number, rot0 = PI / 4) {
  const out: THREE.BufferGeometry[] = [];
  for (let i = 0; i < n; i++) {
    const g = slab(outline.map(([d, r]) => [d - 0.5, r] as P2), th, -th / 2, 0);
    out.push(colorize(tf(g, [0, 0, 0], [rot0 + (i * TAU) / n, 0, 0]), color));
  }
  return out;
}

function buildMunition(kind: MunitionKind, team: number) {
  const parts: THREE.BufferGeometry[] = [];
  const glows: THREE.BufferGeometry[] = [];
  let len = 0.2;
  let powered = true;
  const add = (g: THREE.BufferGeometry | THREE.BufferGeometry[]) => {
    for (const x of Array.isArray(g) ? g : [g]) parts.push(prep(x));
  };
  switch (kind) {
    case 'tankShell': {
      len = 0.13;
      powered = false;
      const R = 0.032;
      add(mLathe([[0, 0], [0.12, R * 0.6], [0.2, R], [0.97, R], [1, R * 0.8], [1, 0]], 8, (d) => (d < 0.2 ? 0x8a8e90 : 0x45494c)));
      add(mFins(6, [[0.72, R], [0.8, R * 3.2], [1.0, R * 3.2], [1.0, R]], 0.008, 0xb6babd));
      add(colorize(cylX(R * 0.8, R * 0.8, 0.04, 6, [-0.52, 0, 0]), team));
      glows.push(prep(cylX(R * 0.75, R * 0.5, 0.05, 6, [-0.53, 0, 0])));
      break;
    }
    case 'artilleryShell': {
      len = 0.11;
      powered = false;
      const R = 0.1;
      add(
        mLathe(
          [
            [0, 0],
            [0.06, R * 0.25],
            [0.12, R * 0.42],
            [0.3, R * 0.85],
            [0.42, R],
            [0.78, R],
            [0.8, R * 1.06],
            [0.86, R * 1.06],
            [0.88, R],
            [1, R * 0.82],
            [1, 0],
          ],
          12,
          (d) => (d < 0.12 ? 0x9a9c9a : d < 0.3 ? 0xd8b030 : d > 0.79 && d < 0.87 ? 0xb87333 : d > 0.6 && d < 0.66 ? team : 0x5a6340),
        ),
      );
      break;
    }
    case 'mortarBomb': {
      len = 0.095;
      powered = false;
      const R = 0.12;
      add(
        mLathe(
          [
            [0, 0],
            [0.05, R * 0.35],
            [0.2, R * 0.85],
            [0.35, R],
            [0.5, R * 0.9],
            [0.7, R * 0.4],
            [0.72, R * 0.26],
            [1, R * 0.24],
            [1, 0],
          ],
          12,
          (d) => (d < 0.06 ? 0x9a9c9a : d < 0.18 ? 0xd8b030 : d > 0.4 && d < 0.46 ? team : 0x515a3c),
        ),
      );
      add(mFins(8, [[0.8, R * 0.24], [0.84, R * 0.8], [1.0, R * 0.8], [1.0, R * 0.24]], 0.01, 0x484e36, 0));
      break;
    }
    case 'rpg': {
      len = 0.11;
      const R = 0.085;
      add(
        mLathe(
          [
            [0, 0],
            [0.03, R * 0.18],
            [0.1, R * 0.2],
            [0.16, R * 0.6],
            [0.32, R],
            [0.4, R],
            [0.46, R * 0.45],
            [0.6, R * 0.4],
            [0.95, R * 0.42],
            [1, R * 0.35],
            [1, 0],
          ],
          12,
          (d) => (d < 0.12 ? 0x9a9c94 : d < 0.42 ? 0x4b5a3a : d > 0.62 && d < 0.68 ? team : 0x3d4232),
        ),
      );
      add(mFins(4, [[0.84, R * 0.4], [0.88, R * 1.3], [1.0, R * 1.3], [1.0, R * 0.4]], 0.01, 0x2e3128));
      break;
    }
    case 'atgm': {
      len = 0.17;
      const R = 0.058;
      add(
        mLathe(
          [
            [0, 0],
            [0.02, R * 0.6],
            [0.06, R * 0.95],
            [0.08, R],
            [0.97, R],
            [1, R * 0.7],
            [1, 0],
          ],
          12,
          (d) => (d < 0.06 ? 0x1c2228 : d < 0.08 ? 0x8a8c80 : d > 0.3 && d < 0.34 ? team : d > 0.12 && d < 0.15 ? C.yellow : 0x6b6a4a),
        ),
      );
      add(mFins(4, [[0.36, R], [0.42, R * 2.0], [0.62, R * 2.0], [0.64, R]], 0.012, 0x5d5c40));
      add(mFins(4, [[0.86, R], [0.9, R * 1.9], [1.0, R * 1.9], [1.0, R]], 0.012, 0x5d5c40));
      break;
    }
    case 'rocket': {
      len = 0.2;
      const R = 0.024;
      add(
        mLathe(
          [
            [0, 0],
            [0.02, R * 0.3],
            [0.07, R * 0.8],
            [0.1, R],
            [0.98, R],
            [1, R * 0.8],
            [1, 0],
          ],
          10,
          (d) => (d < 0.03 ? 0x8a8c88 : d < 0.25 ? 0x6b7148 : d > 0.25 && d < 0.29 ? team : d > 0.32 && d < 0.34 ? 0xe8e8e0 : 0x556040),
        ),
      );
      add(mFins(4, [[0.9, R], [0.92, R * 3.2], [1.0, R * 3.2], [1.0, R]], 0.006, 0x4a5236));
      add(colorize(prep(new THREE.TorusGeometry(R * 3.2, R * 0.25, 4, 12)).rotateY(PI / 2).translate(-0.48, 0, 0), 0x4a5236));
      break;
    }
    case 'thermoRocket': {
      len = 0.22;
      const R = 0.038;
      add(
        mLathe(
          [
            [0, 0],
            [0.04, R * 0.45],
            [0.12, R * 0.92],
            [0.16, R],
            [0.4, R],
            [0.42, R * 0.92],
            [0.98, R * 0.92],
            [1, R * 0.75],
            [1, 0],
          ],
          12,
          (d) => (d < 0.05 ? 0x8a8c88 : d < 0.41 ? 0x5e6a48 : d > 0.44 && d < 0.47 ? team : d > 0.5 && d < 0.52 ? 0xc02020 : 0x4f5a3c),
        ),
      );
      add(mFins(6, [[0.86, R * 0.92], [0.89, R * 2.5], [1.0, R * 2.5], [1.0, R * 0.92]], 0.008, 0x47513a, 0));
      break;
    }
    case 'sam': {
      len = 0.36;
      const R = 0.032;
      add(
        mLathe(
          [
            [0, 0],
            [0.03, R * 0.45],
            [0.09, R * 0.85],
            [0.13, R],
            [0.98, R],
            [1, R * 0.8],
            [1, 0],
          ],
          12,
          (d) => (d < 0.09 ? 0x4a4c4e : d > 0.24 && d < 0.27 ? team : d > 0.3 && d < 0.32 ? C.yellow : 0xe6e6e0),
        ),
      );
      add(mFins(4, [[0.78, R], [0.88, R * 3.4], [0.99, R * 3.4], [1.0, R]], 0.01, 0xd8d8d2, 0));
      add(mFins(4, [[0.18, R], [0.21, R * 1.6], [0.26, R * 1.6], [0.27, R]], 0.008, 0xd8d8d2, 0));
      break;
    }
    case 'interceptor': {
      len = 0.22;
      const R = 0.02;
      add(
        mLathe(
          [
            [0, 0],
            [0.04, R * 0.5],
            [0.1, R * 0.9],
            [0.14, R],
            [0.98, R],
            [1, R * 0.8],
            [1, 0],
          ],
          10,
          (d) => (d < 0.06 ? 0x2a2c2e : d > 0.4 && d < 0.43 ? team : d > 0.16 && d < 0.18 ? 0x2a6ad0 : 0xf0f0ea),
        ),
      );
      add(mFins(4, [[0.16, R], [0.19, R * 2.6], [0.23, R * 2.6], [0.24, R]], 0.008, 0xe0e0da));
      add(mFins(4, [[0.86, R], [0.9, R * 2.8], [1.0, R * 2.8], [1.0, R]], 0.008, 0xe0e0da));
      break;
    }
    case 'airMissile': {
      len = 0.18;
      const R = 0.014 * 1.25;
      add(
        mLathe(
          [
            [0, 0],
            [0.03, R * 0.5],
            [0.09, R * 0.9],
            [0.12, R],
            [0.98, R],
            [1, R * 0.8],
            [1, 0],
          ],
          10,
          (d) => (d < 0.12 ? 0x9a9c98 : d > 0.2 && d < 0.23 ? C.yellow : d > 0.3 && d < 0.33 ? 0x8a5a2a : d > 0.5 && d < 0.53 ? team : 0xe6e7e2),
        ),
      );
      add(mFins(4, [[0.36, R], [0.48, R * 2.4], [0.56, R * 2.4], [0.58, R]], 0.008, 0xdcddd8));
      add(mFins(4, [[0.86, R], [0.92, R * 2.6], [1.0, R * 2.6], [1.0, R]], 0.008, 0xdcddd8));
      break;
    }
    case 'ballistic': {
      len = 0.56;
      const R = 0.034;
      add(
        mLathe(
          [
            [0, 0],
            [0.03, R * 0.25],
            [0.12, R * 0.75],
            [0.2, R],
            [0.98, R],
            [1, R * 0.85],
            [1, 0],
          ],
          12,
          (d) => (d < 0.2 ? 0x3c3e3c : d > 0.22 && d < 0.24 ? team : d > 0.55 && d < 0.57 ? 0x3c3e3c : 0xb9b59c),
        ),
      );
      add(mFins(4, [[0.82, R], [0.9, R * 2.6], [1.0, R * 2.6], [1.0, R]], 0.01, 0xa8a48a, 0));
      add(mFins(4, [[0.2, R], [0.215, R * 1.5], [0.245, R * 1.5], [0.25, R]], 0.008, 0x3c3e3c, 0));
      break;
    }
    case 'hypersonic': {
      len = 0.62;
      const R = 0.032;
      // booster (from d = 0.36 to 1)
      add(
        mLathe(
          [
            [0.34, R * 0.55],
            [0.38, R],
            [0.98, R],
            [1, R * 0.8],
            [1, 0],
          ],
          12,
          (d) => (d < 0.4 ? 0x2c2e30 : d > 0.5 && d < 0.53 ? team : d > 0.7 && d < 0.72 ? 0xe0e0d8 : 0x4a523e),
        ),
      );
      add(mFins(4, [[0.88, R], [0.94, R * 2.2], [1.0, R * 2.2], [1.0, R]], 0.01, 0x434a38, 0));
      // wedge glide vehicle: flat bottom, ridged top, delta planform
      const gv = new THREE.BufferGeometry();
      const n0: V3 = [0.5, -0.005, 0];
      const tl: V3 = [0.5 - 0.34, -R * 0.6, -R * 1.25];
      const tr: V3 = [0.5 - 0.34, -R * 0.6, R * 1.25];
      const ridge: V3 = [0.5 - 0.3, R * 0.9, 0];
      const back: V3 = [0.5 - 0.34, R * 0.6, 0];
      const tri = (a: V3, b: V3, c: V3) => [...a, ...b, ...c];
      gv.setAttribute('position', new THREE.Float32BufferAttribute([...tri(n0, tl, tr), ...tri(n0, ridge, tl), ...tri(n0, tr, ridge), ...tri(ridge, back, tl), ...tri(ridge, tr, back), ...tri(tl, back, tr)], 3));
      gv.computeVertexNormals();
      // ensure outward winding (signed volume)
      const pa = gv.attributes.position;
      let vol = 0;
      for (let t = 0; t < pa.count; t += 3) {
        const a = new THREE.Vector3().fromBufferAttribute(pa, t).sub(new THREE.Vector3(0.25, 0, 0));
        const b = new THREE.Vector3().fromBufferAttribute(pa, t + 1).sub(new THREE.Vector3(0.25, 0, 0));
        const c = new THREE.Vector3().fromBufferAttribute(pa, t + 2).sub(new THREE.Vector3(0.25, 0, 0));
        vol += a.dot(b.cross(c));
      }
      if (vol < 0) {
        flipWinding(gv);
        gv.computeVertexNormals();
      }
      add(colorize(gv, 0x2a2b2d));
      add(mFins(2, [[0.24, R * 0.6], [0.3, R * 1.7], [0.34, R * 1.7], [0.34, R * 0.6]], 0.006, 0x2a2b2d, PI / 2 - 0.5));
      add(colorize(cylX(R * 0.7, R * 0.95, 0.03, 10, [0.5 - 0.35, 0, 0]), 0x3a3c3e));
      break;
    }
  }
  if (powered && !glows.length) {
    // hot motor throat: a small glowing disc + short core cone at the nozzle (the renderer adds the flame / trail)
    const rr = kind === 'thermoRocket' ? 0.026 : kind === 'sam' || kind === 'ballistic' || kind === 'hypersonic' ? 0.024 : kind === 'rocket' ? 0.018 : 0.03;
    glows.push(prep(discX(rr, rr, [-0.505, 0, 0], true, 10)));
    glows.push(prep(tf(new THREE.ConeGeometry(rr * 0.8, rr * 4, 8, 1, true), [-0.505 - rr * 2, 0, 0], [0, 0, PI / 2])));
  }
  const body = mergeGeometries(parts, false)!;
  body.scale(len, len, len);
  let glow: THREE.BufferGeometry | null = null;
  if (glows.length) {
    glow = mergeGeometries(glows, false);
    glow?.scale(len, len, len);
  }
  return { body, glow, len, nozzle: powered ? new THREE.Vector3(-len / 2, 0, 0) : undefined };
}

/** Projectile visual (forward = +X). Returns null to use the renderer's simple fallback. */
export function createMunition(kind: MunitionKind, team: number): MunitionModel | null {
  try {
    const key = `${kind}|${team}`;
    let m = munCache.get(key);
    if (!m) {
      m = buildMunition(kind, team);
      munCache.set(key, m);
    }
    munMat ??= new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.45 });
    munGlow ??= new THREE.MeshBasicMaterial({ color: 0xffa040, toneMapped: false, side: THREE.DoubleSide });
    const root = new THREE.Group();
    root.add(new THREE.Mesh(m.body, munMat));
    if (m.glow) root.add(new THREE.Mesh(m.glow, munGlow));
    return { root, nozzle: m.nozzle?.clone(), length: m.len };
  } catch (e) {
    console.error('munition build failed', kind, e);
    return null;
  }
}
