import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { factionCamo, worldUV } from '../textures';
import type { Builder } from './registry';
import { chevronCell, decalQuad, flagPatchCell, hash01, makeDecalMaterial, numberQuads, roundelCell, type Cell } from './insignia';
import type { AnimState, Model, ModelStyle } from './types';
import { armourMod, armourModPlain, treadTex, unitLook, vehCamo } from './unittex';
import { PAINT_LOUVRE, PAINT_MESH, bakeVehicle, type BakeResult } from './vehbake';
import { lodGeos, registerLods } from '../perf/lod';
import { WearDriver, isWearMaterial, wearPatch, type WearCfg } from './wear';

/*
 * Detailed procedural ground vehicles (one design per nation for the shared
 * roster keys). Conventions: 1 tile = 1 unit, Y up, forward = +X, origin on
 * the ground at the footprint centre; right-hand side of the vehicle = +Z.
 *
 * Every vehicle is built once per (key, faction, team, fog) as a template:
 * static geometry is merged per material inside each moving part (body,
 * turret, gun, recoiling barrel ...). Road wheels / tyres are InstancedMeshes
 * (one draw call for all of them) whose instance matrices are rotated by the
 * distance travelled; track belts are swept meshes with U = distance along the
 * belt, so scrolling the tread texture offset moves the links. Instances are
 * deep clones of the template; animated parts are found again via userData
 * tags, and only the track materials are per instance.
 */

type P2 = [number, number];
type V3 = [number, number, number];

// ------------------------------------------------------------------ paints

/** Paint codes: a hex colour = matte vertex-coloured detail; mt(hex) = metallic detail; negatives = special materials. */
const MT = 0x1000000;
const mt = (c: number) => c + MT;
const CAMO = -1;
const GLASS = -2; // dark glossy optics (merged into the metal bucket)
const LAMP = -3;
const TAIL = -4;
const AMBER = -5;
const LENS = -6;
const EYE = -7;
const RED = -8; // red warning / eye glow

const K = {
  black: 0x141516,
  rubber: 0x1c1d1e,
  dark: 0x2a2c2e,
  gun: 0x34373a,
  steel: 0x676c70,
  bright: 0x9a9fa3,
  olive: 0x4a5032,
  canvas: 0x6c6a4a,
  khaki: 0x8c7f5a,
  brown: 0x5a4632,
  yellow: 0xd8a21c,
  white: 0xd8d8d2,
  red: 0x8c1c14,
  copper: 0x8a5a32,
  ore: 0xc7962c,
  glassC: 0x1a2632,
  mesh: 0x3c4044,
};

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
function shade(c: number, f: number): number {
  const r = Math.min(255, Math.round(((c >> 16) & 255) * f));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * f));
  const b = Math.min(255, Math.round((c & 255) * f));
  return (r << 16) | (g << 8) | b;
}
function mixc(a: number, b: number, t: number): number {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - t) + ((b >> s) & 255) * t);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

// ------------------------------------------------------------- transforms

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
function TR(x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, sx = 1, sy = 1, sz = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(_v.set(x, y, z), _q.setFromEuler(_e.set(rx, ry, rz)), _s.set(sx, sy, sz));
}

/** Index subset (first n vertices) of a non-indexed geometry, sharing its attribute buffers. */
function subGeo(g: THREE.BufferGeometry, n: number): THREE.BufferGeometry {
  const s = new THREE.BufferGeometry();
  for (const k of Object.keys(g.attributes)) s.setAttribute(k, g.attributes[k]);
  const idx = n > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  s.setIndex(new THREE.BufferAttribute(idx, 1));
  if (!g.boundingSphere) g.computeBoundingSphere();
  s.boundingSphere = g.boundingSphere;
  s.boundingBox = g.boundingBox;
  return s;
}

// --------------------------------------------------------- raw geometries

function shapeOf(pts: P2[]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

/** Side profile (x, y) extruded along Z, centred on z = 0, optional chamfer. */
function gSide(pts: P2[], depth: number, bevel = 0): THREE.BufferGeometry {
  const b = Math.min(bevel, depth * 0.45);
  const d = Math.max(0.0005, depth - 2 * b);
  const g = new THREE.ExtrudeGeometry(shapeOf(pts), {
    depth: d,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 1,
    steps: 1,
    curveSegments: 4,
  });
  g.translate(0, 0, -d / 2);
  return g;
}

/** Plan outline (x, z) extruded upward from y = 0 to y = h. */
function gPlan(pts: P2[], h: number, bevel = 0): THREE.BufferGeometry {
  const b = Math.min(bevel, h * 0.45);
  const d = Math.max(0.0005, h - 2 * b);
  const g = new THREE.ExtrudeGeometry(shapeOf(pts.map(([x, z]) => [x, -z] as P2)), {
    depth: d,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments: 1,
    steps: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, b, 0);
  return g;
}

/** Chamfered box (all 12 edges cut by c). */
function gCBox(w: number, h: number, d: number, c: number): THREE.BufferGeometry {
  const cc = Math.min(c, w * 0.45, h * 0.45, d * 0.45);
  const hw = w / 2;
  const hh = h / 2;
  return gSide(
    [
      [-hw + cc, -hh],
      [hw - cc, -hh],
      [hw, -hh + cc],
      [hw, hh - cc],
      [hw - cc, hh],
      [-hw + cc, hh],
      [-hw, hh - cc],
      [-hw, -hh + cc],
    ],
    d,
    cc,
  );
}

const gCylY = (rt: number, rb: number, h: number, s = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open);
/** Cylinder along X, radius rt at +X. */
const gCylX = (rt: number, rb: number, h: number, s = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open).rotateZ(-Math.PI / 2);
/** Cylinder along Z, radius rt at +Z. */
const gCylZ = (rt: number, rb: number, h: number, s = 12, open = false) => new THREE.CylinderGeometry(rt, rb, h, s, 1, open).rotateX(Math.PI / 2);

function polyArea(p: P2[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i][0] * q[1] - q[0] * p[i][1];
  }
  return a / 2;
}

/** Offset a simple polygon inward by d (miter joins). */
function inset(pts: P2[], d: number): P2[] {
  const n = pts.length;
  const sg = polyArea(pts) > 0 ? 1 : -1;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const p = pts[i];
    const c = pts[(i + 1) % n];
    let e1x = p[0] - a[0];
    let e1z = p[1] - a[1];
    let l = Math.hypot(e1x, e1z) || 1;
    e1x /= l;
    e1z /= l;
    let e2x = c[0] - p[0];
    let e2z = c[1] - p[1];
    l = Math.hypot(e2x, e2z) || 1;
    e2x /= l;
    e2z /= l;
    // inward normals (left of edge for CCW)
    const n1x = -e1z * sg;
    const n1z = e1x * sg;
    const n2x = -e2z * sg;
    const n2z = e2x * sg;
    const k = d / Math.max(0.25, 1 + n1x * n2x + n1z * n2z);
    out.push([p[0] + (n1x + n2x) * k, p[1] + (n1z + n2z) * k]);
  }
  return out;
}

/** Full outline from a half outline (z >= 0) listed from the front centre line to the rear centre line. */
function mirrorZ(half: P2[]): P2[] {
  const out = half.slice();
  for (let i = half.length - 1; i >= 0; i--) {
    const [x, z] = half[i];
    if (Math.abs(z) < 1e-6) continue;
    out.push([x, -z]);
  }
  // drop duplicate centre points at the ends
  return out;
}


interface Ring {
  y: number;
  p: P2[];
}

/** Stack of plan rings (same vertex count) joined into a closed solid. */
function gLoft(rings: Ring[], smooth = false, capTop = true, capBot = true): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const n = rings[0].p.length;
  const sg = polyArea(rings[0].p) > 0 ? 1 : -1;
  const V = (r: number, j: number) => new THREE.Vector3(rings[r].p[j % n][0], rings[r].y, rings[r].p[j % n][1]);
  const bands = rings.length - 1;
  // face normals per band / edge, oriented outward
  const fn: THREE.Vector3[][] = [];
  const flip: boolean[][] = [];
  for (let b = 0; b < bands; b++) {
    fn.push([]);
    flip.push([]);
    for (let j = 0; j < n; j++) {
      const p00 = V(b, j);
      const p01 = V(b, j + 1);
      const p11 = V(b + 1, j + 1);
      const p10 = V(b + 1, j);
      let dx = p01.x - p00.x;
      let dz = p01.z - p00.z;
      if (Math.hypot(dx, dz) < 1e-6) {
        dx = p11.x - p10.x;
        dz = p11.z - p10.z;
      }
      const out = new THREE.Vector3(dz * sg, 0, -dx * sg);
      const nn = new THREE.Vector3().subVectors(p01, p00).cross(new THREE.Vector3().subVectors(p11, p00));
      if (nn.lengthSq() < 1e-14) nn.subVectors(p11, p00).cross(new THREE.Vector3().subVectors(p10, p00));
      const f = nn.dot(out) < 0;
      if (f) nn.negate();
      nn.normalize();
      fn[b].push(nn);
      flip[b].push(f);
    }
  }
  const vn = (r: number, j: number, b: number, e: number) => {
    if (!smooth) return fn[b][e];
    const acc = new THREE.Vector3();
    for (const bb of [r - 1, r]) {
      if (bb < 0 || bb >= bands) continue;
      acc.add(fn[bb][(j - 1 + n) % n]).add(fn[bb][j % n]);
    }
    return acc.normalize();
  };
  const push = (p: THREE.Vector3, q: THREE.Vector3) => {
    pos.push(p.x, p.y, p.z);
    nor.push(q.x, q.y, q.z);
  };
  for (let b = 0; b < bands; b++) {
    for (let j = 0; j < n; j++) {
      const j1 = (j + 1) % n;
      const a = [V(b, j), V(b, j1), V(b + 1, j1), V(b + 1, j)];
      const an = [vn(b, j, b, j), vn(b, j1, b, j), vn(b + 1, j1, b, j), vn(b + 1, j, b, j)];
      const order = flip[b][j] ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3];
      for (const o of order) push(a[o], an[o]);
    }
  }
  const cap = (r: number, up: boolean) => {
    const ring = rings[r];
    const tris = THREE.ShapeUtils.triangulateShape(
      ring.p.map(([x, z]) => new THREE.Vector2(x, z)),
      [],
    );
    const nn = new THREE.Vector3(0, up ? 1 : -1, 0);
    for (const t of tris) {
      const a = new THREE.Vector3(ring.p[t[0]][0], ring.y, ring.p[t[0]][1]);
      const b2 = new THREE.Vector3(ring.p[t[1]][0], ring.y, ring.p[t[1]][1]);
      const c = new THREE.Vector3(ring.p[t[2]][0], ring.y, ring.p[t[2]][1]);
      const cr = new THREE.Vector3().subVectors(b2, a).cross(new THREE.Vector3().subVectors(c, a));
      if ((cr.y > 0) === up) {
        push(a, nn);
        push(b2, nn);
        push(c, nn);
      } else {
        push(a, nn);
        push(c, nn);
        push(b2, nn);
      }
    }
  };
  if (capBot) cap(0, false);
  if (capTop) cap(rings.length - 1, true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  return g;
}

/** Ellipse-ish ring (x radius a, z radius c), n points, optional front squash. */
function ell(n: number, a: number, c: number, dx = 0, frontK = 1, rearK = 1): P2[] {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const x = Math.cos(t);
    out.push([dx + x * a * (x > 0 ? frontK : rearK), Math.sin(t) * c]);
  }
  return out;
}

// ---------------------------------------------------------------- materials

const fogIds = new WeakMap<FogOfWar, number>();
let fogSeq = 0;
function fogId(f: FogOfWar | null): number {
  if (!f) return 0;
  let id = fogIds.get(f);
  if (id === undefined) {
    id = ++fogSeq;
    fogIds.set(f, id);
  }
  return id;
}
const matCache = new Map<string, THREE.Material>();
function cmat<T extends THREE.Material>(key: string, fog: FogOfWar | null, make: () => T): T {
  const k = fogId(fog) + '|' + key;
  let m = matCache.get(k) as T | undefined;
  if (!m) {
    m = make();
    if (fog) fog.apply(m);
    matCache.set(k, m);
  }
  return m;
}
const VEH_WEAR: WearCfg = { dirt: true, loose: true, scale: 9 };
const DECAL_WEAR: WearCfg = { dirt: false, loose: false, scale: 9 };
/** Cached material with the dust / damage / loose-part patch (shared by every vehicle). */
function wmat(key: string, fog: FogOfWar | null, make: () => THREE.Material, cfg: WearCfg = VEH_WEAR): THREE.Material {
  const m = cmat('w|' + key, fog, make);
  if (!isWearMaterial(m)) {
    wearPatch(m, cfg);
    if (cfg.dirt) unitLook(m, { rim: 0.9, team: true });
  }
  return m;
}
/** Painted armour detail (vertex-coloured parts): plate seams, bolts, chipping (shared maps). */
function dullMat(): THREE.MeshStandardMaterial {
  const t = armourMod();
  return new THREE.MeshStandardMaterial({ vertexColors: true, map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1.02, metalness: 0.12, normalScale: new THREE.Vector2(0.7, 0.7) });
}
const decalMat = (fog: FogOfWar | null) => wmat('decal', fog, makeDecalMaterial, DECAL_WEAR);

/** Template keys whose armour gets the per-vehicle detail bake (vehbake.ts). */
const BAKE_KEYS = new Set(['mbt', 'apc']);
const VEH_BAKE: WearCfg = { dirt: true, loose: true, scale: 9, bake: true };
const WHEEL_BAKE: WearCfg = { dirt: true, loose: false, scale: 9, bake: true, run: 'inst' };
/** Material of a baked bucket (camo / painted detail / metal) bound to the template's atlas. */
function bakedMat(bk: string, f: string, res: BakeResult, fog: FogOfWar | null): THREE.Material {
  const id = res.tex.uuid;
  const ns = new THREE.Vector2(1, 1);
  if (bk === 's' + CAMO)
    return wmat(`bk|c|${f}|${id}`, fog, () => {
      const t = vehCamo(f, 0.8, true);
      return new THREE.MeshStandardMaterial({ map: t.map, roughnessMap: t.roughnessMap, normalMap: res.tex, normalScale: ns, roughness: 1, metalness: 0.15 });
    }, VEH_BAKE);
  if (bk === 'M') return wmat(`bk|m|${id}`, fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, normalMap: res.tex, normalScale: ns, roughness: 0.4, metalness: 0.7 }), VEH_BAKE);
  const wheel = bk === 'W';
  return wmat(`bk|${wheel ? 'w' : 'd'}|${id}`, fog, () => {
    const t = armourModPlain();
    return new THREE.MeshStandardMaterial({ vertexColors: true, map: t.map, roughnessMap: t.roughnessMap, normalMap: res.tex, normalScale: ns, roughness: 1.02, metalness: 0.12 });
  }, wheel ? WHEEL_BAKE : VEH_BAKE);
}

function glowMat(color: number, intensity: number, fog: FogOfWar | null, pulse = false) {
  return cmat(`glow${color}|${intensity}|${pulse}`, fog, () => {
    const m = new THREE.MeshStandardMaterial({ color: shade(color, 0.4), emissive: color, emissiveIntensity: intensity, roughness: 0.35, metalness: 0, toneMapped: false });
    if (pulse) m.userData.pulse = true;
    return m;
  });
}

const TREAD_K = 4; // texture repeats per world unit along the belt (8 links per repeat, unittex treadTex)

// ------------------------------------------------------------- build parts

function bucketOf(paint: number): string {
  if (paint === GLASS) return 'M';
  if (paint < 0) return 's' + paint;
  return paint >= MT ? 'M' : 'D';
}

const _col = new THREE.Color();

/** Geometry accumulator: one list of geometries per material bucket. */
class Acc {
  readonly buckets = new Map<string, THREE.BufferGeometry[]>();
  tris = 0;
  /** Team colour hex: matte detail painted exactly this colour is flagged (stays clean of dust, glows slightly). */
  teamHex = -1;
  /** Current loose-piece tag (see wear.ts): id + 256 * mode, hinge y / z. */
  private lc = 0;
  private lpy = 0;
  private lpz = 0;
  private static pid = 0;
  /** Everything fn() adds is one piece that is blown off (mode 1) or hangs from a corner (x, y) when damaged (mode 2: hinge at the front end, 3: at the rear end). */
  piece(mode: 1 | 2 | 3, fn: () => void, py = 0, pz = 0): this {
    const save = [this.lc, this.lpy, this.lpz];
    Acc.pid = (Acc.pid % 254) + 1;
    this.lc = Acc.pid + mode * 256;
    this.lpy = py;
    this.lpz = pz;
    try {
      fn();
    } finally {
      [this.lc, this.lpy, this.lpz] = save;
    }
    return this;
  }
  /**
   * Detail level of what is added next (null = automatic by size): 0 = every LOD, 1 = LOD0 + LOD1
   * (dropped far out), 2 = hero LOD0 only (close zoom, portrait, photo mode).
   */
  lv: number | null = null;
  /** Run fn with an explicit detail level for everything it adds. */
  at(level: number, fn: () => void): this {
    const save = this.lv;
    this.lv = level;
    try {
      fn();
    } finally {
      this.lv = save;
    }
    return this;
  }
  add(geo: THREE.BufferGeometry, paint: number, m?: THREE.Matrix4): this {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g === geo) g = geo.clone();
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.clearGroups();
    g.morphAttributes = {};
    if (!g.attributes.normal) g.computeVertexNormals();
    if (m) g.applyMatrix4(m);
    worldUV(g, paint === CAMO ? 1.1 : 2);
    const key = bucketOf(paint);
    // LOD level: small parts drop out with distance (team colour and lamps never do)
    g.computeBoundingSphere();
    const rad = g.boundingSphere!.radius;
    // battle zoom (LOD1) is ~40 CSS px / unit on phones (x2.6 DPR), ~87 on desktop: parts under ~0.028 across
    // are ~2.5 px there -> hero only; far zoom (LOD2, < ~25 px / unit): parts under ~0.056 across go too
    const auto = rad < 0.014 ? 2 : rad < 0.028 ? 1 : 0;
    g.userData.lv = (key !== 'D' && key !== 'M' && key !== 's' + CAMO) || paint === this.teamHex ? 0 : this.lv ?? auto;
    const dbg = (globalThis as { __LVDBG?: unknown[] }).__LVDBG;
    if (dbg) dbg.push({ lv: g.userData.lv, n: g.attributes.position.count / 3, st: (new Error().stack ?? '').split('\n').slice(2, 6).map((l) => l.trim().split(' ')[1]).join('<') });
    if (key === 'D' || key === 'M') {
      const c = paint === GLASS ? K.glassC : paint >= MT ? paint - MT : paint;
      _col.setHex(c);
      const n = g.attributes.position.count;
      const arr = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        arr[i * 3] = _col.r;
        arr[i * 3 + 1] = _col.g;
        arr[i * 3 + 2] = _col.b;
      }
      g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
    }
    if (key === 'D' || key === 'M' || key === 's' + CAMO) {
      // aWear: x = dust / mud (filled in by Bld.finish), y = loose piece code, zw = hinge
      const n = g.attributes.position.count;
      const w = new Float32Array(n * 4);
      if (key === 'D' && paint === this.teamHex) for (let i = 0; i < n; i++) w[i * 4] = -1;
      if (this.lc)
        for (let i = 0; i < n; i++) {
          w[i * 4 + 1] = this.lc;
          w[i * 4 + 2] = this.lpy;
          w[i * 4 + 3] = this.lpz;
        }
      g.setAttribute('aWear', new THREE.BufferAttribute(w, 4));
    }
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
    this.last = g;
    this.tris += g.attributes.position.count / 3;
    return this;
  }
  /** Geometry pushed by the latest add() (build time bookkeeping, e.g. hatch lids moved to their own part). */
  last: THREE.BufferGeometry | null = null;
  /** Take a geometry added earlier back out of its bucket. */
  drop(g: THREE.BufferGeometry | null) {
    if (!g) return;
    for (const list of this.buckets.values()) {
      const i = list.indexOf(g);
      if (i >= 0) {
        list.splice(i, 1);
        this.tris -= g.attributes.position.count / 3;
        return;
      }
    }
  }
  /** Merge a bucket, coarse parts first: userData.lodN = vertex counts of the LOD2 and LOD1 prefixes. */
  merged(key: string): THREE.BufferGeometry | null {
    const list = this.buckets.get(key);
    if (!list || !list.length) return null;
    const lvOf = (g: THREE.BufferGeometry) => (g.userData.lv as number | undefined) ?? 0;
    const sorted = list.slice().sort((a, b) => lvOf(a) - lvOf(b));
    const n = [0, 0];
    for (const g of sorted) {
      const c = g.attributes.position.count;
      if (lvOf(g) <= 0) n[0] += c;
      if (lvOf(g) <= 1) n[1] += c;
    }
    const out = sorted.length === 1 ? sorted[0] : mergeGeometries(sorted, false);
    out.userData = { lodN: n };
    return out;
  }
}

class Part extends Acc {
  constructor(
    readonly b: Bld,
    readonly g: THREE.Object3D,
  ) {
    super();
    this.teamHex = b.team;
  }
  /** Geometry is narrowed by the builder's width factor (Bld.zk) while the template is being built. */
  override add(geo: THREE.BufferGeometry, paint: number, m?: THREE.Matrix4): this {
    const k = this.b?.zk ?? 1;
    if (k !== 1) m = new THREE.Matrix4().makeScale(1, 1, k).multiply(m ?? new THREE.Matrix4());
    return super.add(geo, paint, m);
  }
  box(w: number, h: number, d: number, x: number, y: number, z: number, paint: number, rx = 0, ry = 0, rz = 0) {
    return this.add(new THREE.BoxGeometry(w, h, d), paint, TR(x, y, z, rx, ry, rz));
  }
  cbox(w: number, h: number, d: number, c: number, x: number, y: number, z: number, paint: number, rx = 0, ry = 0, rz = 0) {
    return this.add(gCBox(w, h, d, c), paint, TR(x, y, z, rx, ry, rz));
  }
  /** Cylinder along X centred at x (radius r1 at +X). */
  cx(r1: number, r2: number, len: number, x: number, y: number, z: number, paint: number, seg = 12, open = false) {
    return this.add(gCylX(r1, r2, len, seg, open), paint, TR(x, y, z));
  }
  /** Vertical cylinder standing on y (radius r1 at the top). */
  cy(r1: number, r2: number, h: number, x: number, y: number, z: number, paint: number, seg = 12) {
    return this.add(gCylY(r1, r2, h, seg), paint, TR(x, y + h / 2, z));
  }
  /** Cylinder along Z centred at z (radius r1 at +Z). */
  cz(r1: number, r2: number, len: number, x: number, y: number, z: number, paint: number, seg = 12) {
    return this.add(gCylZ(r1, r2, len, seg), paint, TR(x, y, z));
  }
  side(pts: P2[], depth: number, z: number, paint: number, bevel = 0) {
    return this.add(gSide(pts, depth, bevel), paint, TR(0, 0, z));
  }
  plan(pts: P2[], h: number, y: number, paint: number, bevel = 0) {
    return this.add(gPlan(pts, h, bevel), paint, TR(0, y, 0));
  }
  loft(rings: Ring[], paint: number, smooth = false, m?: THREE.Matrix4) {
    return this.add(gLoft(rings, smooth), paint, m);
  }
  strut(a: V3, b: V3, r: number, paint: number, seg = 6) {
    const va = new THREE.Vector3(...a);
    const d = new THREE.Vector3(...b).sub(va);
    const len = d.length();
    if (len < 1e-5) return this;
    const g = gCylY(r, r, len, seg);
    const m = new THREE.Matrix4().compose(
      new THREE.Vector3(a[0] + d.x / 2, a[1] + d.y / 2, a[2] + d.z / 2),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()),
      new THREE.Vector3(1, 1, 1),
    );
    return this.add(g, paint, m);
  }
  sph(r: number, x: number, y: number, z: number, paint: number, ws = 10, hs = 7, sy = 1, half = false) {
    return this.add(new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, half ? Math.PI / 2 : Math.PI), paint, TR(x, y, z, 0, 0, 0, 1, sy, 1));
  }
  tube(pts: V3[], r: number, paint: number, seg = 5) {
    const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
    return this.add(new THREE.TubeGeometry(curve, Math.max(4, pts.length * 4), r, seg, false), paint);
  }
}

interface WheelEntry {
  x: number;
  y: number;
  z: number;
  r: number; // rolling radius
  s: number; // geometry scale
  flip: number; // 1 = outer face toward -Z
  steer: number; // steering factor
}

type CustomAnim = (q: (tag: string) => THREE.Object3D[], m: Model) => ((s: AnimState) => void) | undefined;

interface Tpl {
  root: THREE.Group;
  height: number;
  size: { x: number; y: number; z: number };
  glow: THREE.Material[];
  emitters: Model['emitters'];
  gauge?: number;
  tw?: number;
  wheeled: boolean;
  custom?: CustomAnim;
  bob: number;
  /** Hull rock per main-gun shot (0 = none, 1 = 120 mm MBT, ~1.4 = SPH, ~0.25 = autocannon). */
  kick: number;
  stats: { tris: number; meshes: number; lod?: number[] };
  key: string;
  decals: DecalSpec | null;
  fx: NonNullable<Model['damageFx']>;
}

/** Marking layout found on the template (target-local coordinates). */
interface DecalSpot {
  p: THREE.Vector3;
  u: THREE.Vector3;
  v: THREE.Vector3;
  numH: number;
  numOff: number; // number centre offset along u
  emblem: { cell: Cell; w: number; h: number; off: number; color: number } | null;
}
interface DecalSpec {
  spots: DecalSpot[];
  digits: number;
  color: number;
}

class Bld {
  readonly root = new THREE.Group();
  readonly parts: Part[] = [];
  readonly glow: THREE.Material[] = [];
  readonly emitters: Model['emitters'] = [];
  readonly camoOpts: ReturnType<typeof factionCamo>;
  readonly base: number; // main paint colour (for vertex-coloured painted parts)
  readonly baseD: number;
  readonly team: number;
  readonly f: string;
  readonly body: Part;
  readonly chassis: Part;
  gauge?: number;
  tw?: number;
  wheeled = false;
  bob = 1;
  kick = 0;
  custom?: CustomAnim;
  /**
   * Width factor applied to everything built (geometry, part offsets, wheels, belts, muzzles, emitters):
   * lets a design be authored at the old exaggerated width and brought to the real length : width ratio.
   * Reset to 1 by finish() (stowage / markings are placed on the finished, already narrowed geometry).
   */
  zk = 1;
  private mi = 0;
  extraTris = 0;
  constructor(
    readonly style: ModelStyle,
    readonly fog: FogOfWar | null,
  ) {
    this.f = style.faction;
    const c = factionCamo(style.faction);
    const dk = (x: number | undefined) => (x === undefined ? undefined : shade(x, 0.8));
    this.camoOpts = { ...c, color: dk(c.color), color2: dk(c.color2), color3: dk(c.color3), color4: dk(c.color4), seed: 5 };
    this.base = this.camoOpts.color ?? 0x8a8070;
    this.baseD = shade(this.base, 0.72);
    this.team = style.team;
    this.body = this.part(this.root, 0, 0, 0, 'body');
    this.chassis = this.body;
  }
  part(parent: Part | THREE.Object3D, x = 0, y = 0, z = 0, tag?: string): Part {
    const g = new THREE.Group();
    g.position.set(x, y, z * this.zk);
    if (tag) g.userData.tag = tag;
    (parent instanceof Part ? parent.g : parent).add(g);
    const p = new Part(this, g);
    this.parts.push(p);
    return p;
  }
  muzzle(p: Part | THREE.Object3D, x: number, y: number, z: number) {
    const o = new THREE.Object3D();
    o.position.set(x, y, z * this.zk);
    o.userData.tag = 'muzzle';
    o.userData.mi = this.mi++;
    (p instanceof Part ? p.g : p).add(o);
    return o;
  }
  emit(x: number, y: number, z: number, kind: 'smoke' | 'steam' | 'spark' | 'fire' = 'smoke') {
    this.emitters.push({ pos: new THREE.Vector3(x, y, z * this.zk), kind });
  }
  material(key: string): THREE.Material {
    const fog = this.fog;
    let m: THREE.Material;
    switch (key) {
      case 'D':
        return wmat('vdull2', fog, dullMat);
      case 'M':
        return wmat('vmetal', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.72 }));
      case 's' + CAMO:
        return wmat('camo2|' + this.f, fog, () => {
          const t = vehCamo(this.f);
          return new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0.15, normalScale: new THREE.Vector2(0.85, 0.85) });
        });
      case 's' + LAMP:
        m = glowMat(0xfff0d0, 2.4, fog);
        break;
      case 's' + TAIL:
        m = glowMat(0xff2a12, 1.8, fog);
        break;
      case 's' + AMBER:
        m = glowMat(0xffa21a, 3.2, fog);
        break;
      case 's' + LENS:
        m = glowMat(0x7fe8ff, 3.2, fog, true);
        break;
      case 's' + EYE:
        m = glowMat(0x58e0ff, 2.8, fog);
        break;
      case 's' + RED:
        m = glowMat(0xff3020, 2.6, fog);
        break;
      default:
        return wmat('vdull2', fog, dullMat);
    }
    if (key.startsWith('s') && key !== 's' + CAMO && !this.glow.includes(m)) this.glow.push(m);
    return m;
  }
  /** Wheel set as one InstancedMesh (geometry: axle along Z, outer face toward +Z, centred on the origin). */
  wheels(parent: Part | THREE.Object3D, geo: THREE.BufferGeometry, entries: WheelEntry[], tag = 'wheels') {
    if (this.zk !== 1) entries = entries.map((e) => ({ ...e, z: e.z * this.zk }));
    // running gear: mud caked on the rims and tyres, more toward the outside
    for (const g of [geo, ...(lodGeos(geo) ?? [])]) {
      const aw = g.getAttribute('aWear') as THREE.BufferAttribute | undefined;
      if (!aw) continue;
      const pos = g.attributes.position;
      let R = 1e-6;
      for (let i = 0; i < pos.count; i++) R = Math.max(R, Math.hypot(pos.getX(i), pos.getY(i)));
      for (let i = 0; i < pos.count; i++) aw.setX(i, 0.08 + 0.44 * Math.min(1, Math.hypot(pos.getX(i), pos.getY(i)) / R) ** 2);
    }
    const im = new THREE.InstancedMesh(geo, this.material('D'), entries.length);
    im.userData.tag = tag;
    im.userData.wheels = entries;
    im.castShadow = true;
    im.receiveShadow = true;
    setWheelMatrices(im, entries, 0, 0, 0);
    im.computeBoundingSphere();
    im.computeBoundingBox();
    (parent instanceof Part ? parent.g : parent).add(im);
    this.extraTris += (geo.attributes.position.count / 3) * entries.length;
    return im;
  }
  /**
   * Top-down height buffer over the unmerged parts (template build time only):
   * every upward-facing triangle is rasterised into a grid (cell = 4 mm of
   * tile) keeping the highest surface, its part and whether it is plain camo
   * paint. Much cheaper than ray casting each probe point.
   */
  private probe() {
    this.root.updateMatrixWorld(true);
    const tagged = (o: THREE.Object3D, t: string) => typeof o.userData.tag === 'string' && (o.userData.tag as string).split(' ').includes(t);
    const C = 0.005;
    const bb = new THREE.Box3();
    const v = new THREE.Vector3();
    const parts = this.parts;
    for (const p of parts)
      for (const geos of p.buckets.values())
        for (const g of geos) {
          const pos = g.attributes.position;
          for (let i = 0; i < pos.count; i++) bb.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(p.g.matrixWorld));
        }
    const x0 = bb.min.x - C;
    const z0 = bb.min.z - C;
    const nx = Math.max(1, Math.ceil((bb.max.x - x0) / C) + 2);
    const nz = Math.max(1, Math.ceil((bb.max.z - z0) / C) + 2);
    const H = new Float32Array(nx * nz).fill(-1e9);
    const O = new Int16Array(nx * nz).fill(-1); // part index; -2 - index for non-camo / skipped parts
    const NY = new Float32Array(nx * nz);
    const camoBox = parts.map(() => new THREE.Box3());
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    parts.forEach((p, pi) => {
      let skipIt = false;
      for (let q: THREE.Object3D | null = p.g; q; q = q.parent) if (tagged(q, 'recoil') || tagged(q, 'whip') || tagged(q, 'spin')) skipIt = true;
      const m = p.g.matrixWorld;
      for (const [key, geos] of p.buckets) {
        const camo = !skipIt && key === 's' + CAMO;
        for (const g of geos) {
          const pos = g.attributes.position;
          for (let t = 0; t + 2 < pos.count; t += 3) {
            a.fromBufferAttribute(pos, t).applyMatrix4(m);
            b.fromBufferAttribute(pos, t + 1).applyMatrix4(m);
            c.fromBufferAttribute(pos, t + 2).applyMatrix4(m);
            n.subVectors(b, a).cross(v.subVectors(c, a));
            const len = n.length();
            if (len < 1e-12) continue;
            n.divideScalar(len);
            if (n.y < 0) n.negate(); // winding is not reliable on all primitives: take the upward side
            if (n.y < 0.05) continue;
            if (camo) {
              camoBox[pi].expandByPoint(a).expandByPoint(b).expandByPoint(c);
            }
            const i0 = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / C));
            const i1 = Math.min(nx - 1, Math.ceil((Math.max(a.x, b.x, c.x) - x0) / C));
            const j0 = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / C));
            const j1 = Math.min(nz - 1, Math.ceil((Math.max(a.z, b.z, c.z) - z0) / C));
            const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
            if (Math.abs(d) < 1e-12) continue;
            for (let j = j0; j <= j1; j++) {
              const pz = z0 + (j + 0.5) * C;
              for (let i = i0; i <= i1; i++) {
                const px = x0 + (i + 0.5) * C;
                const w1 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / d;
                const w2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / d;
                const w3 = 1 - w1 - w2;
                if (w1 < -1e-4 || w2 < -1e-4 || w3 < -1e-4) continue;
                const y = w1 * a.y + w2 * b.y + w3 * c.y;
                const k = j * nx + i;
                if (y > H[k] + 1e-5) {
                  H[k] = y;
                  O[k] = camo ? pi : -2 - pi;
                  NY[k] = n.y;
                }
              }
            }
          }
        }
      }
    });
    const tur = parts.find((p) => tagged(p.g, 'turret') && !camoBox[parts.indexOf(p)].isEmpty());
    const boxOf = (p: Part) => camoBox[parts.indexOf(p)];
    const cell = (x: number, z: number) => {
      const i = Math.floor((x - x0) / C);
      const j = Math.floor((z - z0) / C);
      return i < 0 || j < 0 || i >= nx || j >= nz ? -1 : j * nx + i;
    };
    /** Flat spot of camo paint of part p at (x, z) with footprint (l along x, w along z); returns the root-space point. */
    const flat = (p: Part, x: number, z: number, l: number, w: number, tol = 0.0025) => {
      const pi = parts.indexOf(p);
      const k0 = cell(x, z);
      if (k0 < 0 || O[k0] !== pi || NY[k0] < 0.96) return null;
      const y0 = H[k0];
      for (let zz = z - w / 2; zz <= z + w / 2 + 1e-6; zz += C) {
        for (let xx = x - l / 2; xx <= x + l / 2 + 1e-6; xx += C) {
          const k = cell(xx, zz);
          if (k < 0 || O[k] !== pi || NY[k] < 0.9 || Math.abs(H[k] - y0) > tol) return null;
        }
      }
      return new THREE.Vector3(x, y0, z);
    };
    /** Mark a footprint as taken (nothing else may be placed on it). */
    const block = (x: number, z: number, l: number, w: number) => {
      for (let zz = z - w / 2; zz <= z + w / 2 + 1e-6; zz += C)
        for (let xx = x - l / 2; xx <= x + l / 2 + 1e-6; xx += C) {
          const k = cell(xx, zz);
          if (k >= 0) O[k] = -1;
        }
    };
    return { tur, boxOf, flat, block };
  }
  /**
   * Air-recognition panel (VS-17 style) in the team colour on the turret roof
   * (or the rear deck): a flat, unobstructed spot is found by ray casting the
   * unmerged parts, so it reads from above at RTS zoom whatever the design.
   */
  private idPanel(pr: ReturnType<Bld['probe']>) {
    if (this.noIdPanel) return;
    const targets: { p: Part; rear: boolean }[] = [];
    if (pr.tur) targets.push({ p: pr.tur, rear: false });
    targets.push({ p: this.body, rear: true });
    {
      for (const { p, rear } of targets) {
        const bb = pr.boxOf(p);
        if (bb.isEmpty()) continue;
        const L = bb.max.x - bb.min.x;
        const W = bb.max.z - bb.min.z;
        if (L < 0.12 || W < 0.1) continue;
        for (const k of [1, 0.75, 0.55]) {
          const pl = Math.min(0.075, L * 0.28) * k;
          const pw = Math.min(0.17, W * 0.6) * k;
          const x0 = bb.min.x + pl / 2 + L * 0.06;
          const x1 = rear ? bb.min.x + L * 0.45 : bb.max.x - pl / 2 - L * 0.2;
          const zc = (bb.min.z + bb.max.z) / 2;
          for (let x = x0; x <= x1; x += 0.012) {
            for (const dz of [0, 0.02, -0.02, 0.04, -0.04]) {
              const hit = pr.flat(p, x, zc + dz, pl, pw);
              if (!hit) continue;
              const lp = p.g.worldToLocal(hit);
              p.box(pl + 0.008, 0.002, pw + 0.008, lp.x, lp.y + 0.001, lp.z, K.black);
              p.box(pl, 0.0025, pw, lp.x, lp.y + 0.002, lp.z, this.team);
              pr.block(x, zc + dz, pl + 0.02, pw + 0.02);
              return;
            }
          }
        }
      }
    }
  }
  /** Skip the air-recognition panel (set by builders with no suitable roof). */
  noIdPanel = false;
  /** Detail bake of this template (null: plain tiling materials). */
  baked: BakeResult | null = null;
  /** Template key (mbt, apc, ...). */
  key = '';
  /** Hatches built with hatch() (z already narrowed); geos = the lid disc + handle in p's buckets. */
  readonly hatches: { p: Part; x: number; y: number; z: number; r: number; paint: number; geos: (THREE.BufferGeometry | null)[] }[] = [];
  /** Put a commander in a hatch (tanks, IFVs). */
  crewOn = false;
  /**
   * Vehicle commander riding out of a hatch: the hatch lid becomes its own part
   * hinged at its rear edge ('hlid', opens to ~110 deg), with a dark opening
   * under it, and a head-and-shoulders figure ('crew' pivot; 'crewA' hands on
   * the rim, 'crewB' glassing with binoculars - one shown at a time) that ducks
   * inside when the vehicle buttons up. Each is a single vertex-coloured mesh
   * (lid: camo + handle), so a crewed vehicle adds 3 drawn meshes.
   * Turret hatches first (the commander's / loader's), else the largest hull hatch.
   */
  private crew() {
    const inTurret = (p: Part) => {
      for (let q: THREE.Object3D | null = p.g; q; q = q.parent) if (typeof q.userData.tag === 'string' && (q.userData.tag as string).split(' ').includes('turret')) return true;
      return false;
    };
    let list = this.hatches.filter((h) => inTurret(h.p));
    if (!list.length) list = this.hatches.slice();
    if (!list.length) return;
    list.sort((a, b) => b.r - a.r || a.x - b.x);
    const h = list[0];
    const P = h.p;
    for (const g of h.geos) P.drop(g);
    const r = h.r;
    // the open hatch: dark ring well + coaming lip
    P.cy(r * 0.9, r * 0.9, 0.002, h.x, h.y + 0.0004, h.z, K.black, 12);
    P.add(new THREE.TorusGeometry(r * 0.95, 0.0035, 4, 14).rotateX(Math.PI / 2), shade(this.base, 0.75), TR(h.x, h.y + 0.003, h.z));
    // lid, hinged at its rear edge (rotation.z opens it up and back)
    const L = this.part(P, h.x - r, h.y, h.z, 'hlid');
    L.cy(r, r * 1.04, 0.008, r, 0, 0, h.paint, 12);
    L.box(r * 0.8, 0.004, 0.004, r * 1.1, 0.011, 0, K.steel);
    L.box(r * 1.2, 0.0035, r * 1.1, r, -0.002, 0, 0x2c2e2a); // underside padding (seen when open)
    // the commander
    const reg = this.style.region;
    const uni = reg === 'west' ? 0x6c6446 : reg === 'east' ? 0x4c5232 : reg === 'asia' ? 0x4a5434 : 0x857558;
    const helm = reg === 'west' ? 0x5c5a44 : reg === 'east' ? 0x202020 : reg === 'asia' ? 0x34382c : 0x4a4636;
    const skin = reg === 'mideast' ? 0xa8805e : reg === 'asia' ? 0xc8a07c : 0xc49478;
    const F = this.part(P, h.x + r * 0.08, h.y, h.z, 'crew');
    F.g.scale.setScalar(CREW_K); // RTS exaggeration: readable at play zoom
    const figure = (Q: Part, glass: boolean) => {
      Q.lv = 2; // the figure is hero detail (a few px at battle zoom); the hatch lid still opens at every LOD
      // torso in the hatch well, shoulders, collar of the vest
      Q.add(gCylY(0.021, 0.019, 0.07, 7, true), uni, TR(0, -0.022, 0));
      Q.cbox(0.032, 0.02, 0.056, 0.007, 0, 0.018, 0, uni);
      Q.cbox(0.036, 0.012, 0.05, 0.004, 0.002, 0.008, 0, shade(uni, 0.72));
      Q.add(gCylY(0.007, 0.008, 0.012, 6, true), skin, TR(0.001, 0.032, 0));
      // head + tanker helmet with ear cups, boom mic
      Q.sph(0.0125, 0.002, 0.048, 0, skin, 7, 5);
      Q.sph(0.0142, 0.0, 0.052, 0, helm, 8, 4, 0.9, true);
      Q.add(gCylY(0.0142, 0.0142, 0.006, 8, true), helm, TR(0, 0.05, 0));
      for (const s of [-1, 1]) Q.add(gCylZ(0.006, 0.006, 0.005, 6), helm, TR(0.0, 0.046, s * 0.0135));
      Q.box(0.012, 0.0018, 0.0018, 0.012, 0.04, 0.012, K.dark, 0, 0.5, 0.2);
      if (!glass) {
        // forearms resting on the hatch rim
        for (const s of [-1, 1]) {
          Q.strut([0, 0.022, s * 0.026], [0.012, 0.004, s * 0.03], 0.0055, uni, 5);
          Q.strut([0.012, 0.004, s * 0.03], [0.034, 0.004, s * 0.014], 0.005, uni, 5);
          Q.sph(0.005, 0.036, 0.004, s * 0.012, K.olive, 5, 3);
        }
      } else {
        // binoculars up at the eyes, elbows out
        for (const s of [-1, 1]) {
          Q.strut([0, 0.022, s * 0.026], [0.016, 0.028, s * 0.03], 0.0055, uni, 5);
          Q.strut([0.016, 0.028, s * 0.03], [0.022, 0.046, s * 0.008], 0.005, uni, 5);
          Q.add(gCylX(0.0045, 0.0045, 0.014, 7), K.black, TR(0.022, 0.049, s * 0.0055));
        }
        Q.box(0.006, 0.006, 0.006, 0.019, 0.049, 0, K.dark);
      }
    };
    figure(this.part(F, 0, 0, 0, 'crewA'), false);
    figure(this.part(F, 0, 0, 0, 'crewB'), true);
  }
  /** Number of stowage items scattered on free flat deck / roof areas (0 = none). */
  clutterN = 0;
  /**
   * Field stowage: kit bags, rolled camouflage nets / tarps, ammo boxes, jerry
   * cans and spare track links on free, flat spots of the hull deck (outside
   * the turret's sweep) and the turret roof. Every item is a loose piece (blown
   * off by battle damage).
   */
  private clutter(pr: ReturnType<Bld['probe']>) {
    if (this.clutterN <= 0) return;
    {
      const reg = this.style.region;
      const bagC = reg === 'west' ? [0x7c6a4a, 0x5a5c3c, 0x8a7a58] : reg === 'east' ? [0x4e5434, 0x5c5a3c, 0x3e4430] : reg === 'asia' ? [0x4c5636, 0x5e5e40, 0x424a32] : [0x8c7a56, 0x6c6444, 0x9a8a64];
      const netC = reg === 'mideast' ? 0x8a7c5a : reg === 'west' && this.f !== 'germany' ? 0x76683e : 0x4a5232;
      let seed = 0;
      for (const ch of this.f + this.parts.length) seed = (seed * 31 + ch.charCodeAt(0)) | 0;
      let ri = 0;
      const rnd = () => hash01(seed + ri++ * 7919);
      const used: THREE.Box3[] = [];
      const free = (bx: THREE.Box3) => !used.some((u) => u.intersectsBox(bx));
      // turret sweep radius (hull clutter must stay clear of the bustle / gun)
      let tc: THREE.Vector3 | null = null;
      let tr = 0;
      if (pr.tur) {
        tc = new THREE.Vector3().setFromMatrixPosition(pr.tur.g.matrixWorld);
        const tb = pr.boxOf(pr.tur);
        for (const x of [tb.min.x, tb.max.x]) for (const z of [tb.min.z, tb.max.z]) tr = Math.max(tr, Math.hypot(x - tc.x, z - tc.z));
        tr += 0.025;
      }
      type Item = { l: number; w: number; put: (p: Part, x: number, y: number, z: number) => void };
      const S = 1.3; // chunky, readable stowage (C&C3-like exaggeration)
      const items: Item[] = [
        // kit bag / rucksack
        { l: 0.05 * S, w: 0.032 * S, put: (p, x, y, z) => { const c = bagC[Math.floor(rnd() * 3)]; p.cbox(0.048 * S, 0.024 * S, 0.03 * S, 0.006, x, y + 0.012 * S, z, c); p.box(0.05 * S, 0.004, 0.006, x, y + 0.02 * S, z, shade(c, 0.7)); } },
        // rolled net / tarp across the deck (along z) with straps
        { l: 0.036 * S, w: 0.1 * S, put: (p, x, y, z) => { p.cz(0.016 * S, 0.016 * S, 0.1 * S, x, y + 0.016 * S, z, netC, 7); for (const dz of [-0.03, 0.03]) p.cz(0.0175 * S, 0.0175 * S, 0.005, x, y + 0.016 * S, z + dz * S, K.dark, 7); } },
        // ammo boxes, two stacked
        { l: 0.04 * S, w: 0.026 * S, put: (p, x, y, z) => { p.box(0.038 * S, 0.02 * S, 0.024 * S, x, y + 0.01 * S, z, K.olive); p.box(0.034 * S, 0.016 * S, 0.022 * S, x + 0.002, y + 0.028 * S, z, shade(K.olive, 0.85)); p.box(0.04 * S, 0.003, 0.025 * S, x, y + 0.017 * S, z, K.dark); } },
        // jerry cans side by side
        { l: 0.036, w: 0.04, put: (p, x, y, z) => { jerry(p, x, y, z - 0.01, reg === 'mideast' ? 0x6a6244 : 0x4c5434); jerry(p, x, y, z + 0.01, 0x4c5434); } },
        // spare track links
        { l: 0.034 * S, w: 0.07 * S, put: (p, x, y, z) => { for (let i = 0; i < 2; i++) p.box(0.032 * S, 0.006 * S, 0.066 * S, x, y + 0.003 * S + i * 0.0065 * S, z + i * 0.004, K.dark); p.box(0.034 * S, 0.003, 0.004, x, y + 0.014 * S, z, mt(K.steel)); } },
        // folded tarp
        { l: 0.06 * S, w: 0.05 * S, put: (p, x, y, z) => { p.cbox(0.058 * S, 0.012 * S, 0.048 * S, 0.004, x, y + 0.006 * S, z, netC); p.cbox(0.044 * S, 0.008 * S, 0.036 * S, 0.003, x - 0.004, y + 0.016 * S, z + 0.002, shade(netC, 1.1)); } },
      ];
      const place = (p: Part, maxN: number, xmin: number, xmax: number, zs: number[], avoidTurret: boolean) => {
        let n = 0;
        for (let tries = 0; tries < maxN * 6 && n < maxN; tries++) {
          const it = items[Math.floor(rnd() * items.length)];
          const z0 = zs[Math.floor(rnd() * zs.length)];
          // scan along x from a random start for a free flat spot
          const span = xmax - xmin;
          if (span <= 0) return;
          const start = rnd();
          for (let k = 0; k < 14; k++) {
            const x = xmin + ((start + k / 14) % 1) * span;
            const z = z0;
            const bx = new THREE.Box3(new THREE.Vector3(x - it.l / 2 - 0.006, -1, z - it.w / 2 - 0.006), new THREE.Vector3(x + it.l / 2 + 0.006, 5, z + it.w / 2 + 0.006));
            if (!free(bx)) continue;
            if (avoidTurret && tc && Math.hypot(Math.max(Math.abs(x - tc.x) - it.l / 2, 0), Math.max(Math.abs(z - tc.z) - it.w / 2, 0)) < tr) continue;
            const hit = pr.flat(p, x, z, it.l + 0.008, it.w + 0.008, 0.004);
            if (!hit) continue;
            const lp = p.g.worldToLocal(hit);
            p.piece(1, () => it.put(p, lp.x, lp.y, lp.z));
            used.push(bx);
            n++;
            break;
          }
        }
      };
      const hb = pr.boxOf(this.body);
      if (!hb.isEmpty()) {
        const W = hb.max.z - hb.min.z;
        place(this.body, this.clutterN, hb.min.x + 0.04, hb.max.x - 0.04, [hb.min.z + W * 0.2, hb.max.z - W * 0.2, (hb.min.z + hb.max.z) / 2, hb.min.z + W * 0.3, hb.max.z - W * 0.3], true);
      }
      if (pr.tur) {
        const tb = pr.boxOf(pr.tur);
        const W = tb.max.z - tb.min.z;
        place(pr.tur, Math.ceil(this.clutterN / 2), tb.min.x + 0.03, tb.min.x + (tb.max.x - tb.min.x) * 0.5, [tb.min.z + W * 0.22, tb.max.z - W * 0.22], false);
      }
    }
  }
  finish(): Tpl {
    this.zk = 1;
    if (this.crewOn) this.crew();
    if (!this.noIdPanel || this.clutterN > 0) {
      const pr = this.probe();
      this.idPanel(pr);
      this.clutter(pr);
    }
    let tris = this.extraTris;
    let meshes = 0;
    for (const p of this.parts) {
      for (const key of p.buckets.keys()) {
        const g = p.merged(key);
        if (!g) continue;
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.material(key));
        mesh.userData.bk = key;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        p.g.add(mesh);
        tris += g.attributes.position.count / 3;
      }
    }
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes++;
    });
    this.root.updateMatrixWorld(true);
    // footprint without barrels and antennas (they would inflate selection / health bar placement)
    const box = new THREE.Box3();
    const skip = (o: THREE.Object3D | null): boolean => {
      for (let q = o; q; q = q.parent) {
        const tg = q.userData.tag;
        if (typeof tg === 'string' && (tg.includes('recoil') || tg.includes('whip') || tg.includes('crew') || tg.includes('ramp'))) return true;
      }
      return false;
    };
    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !skip(o)) box.expandByObject(o, false);
    });
    if (box.isEmpty()) box.setFromObject(this.root);
    const size = { x: box.max.x - box.min.x, y: box.max.y, z: box.max.z - box.min.z };
    this.bakeDirt();
    if (BAKE_KEYS.has(this.key)) {
      const res = bakeVehicle(this.root, this.key + '|' + this.f);
      if (res) {
        this.baked = res;
        this.root.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh || !m.geometry.attributes.uv1) return;
          const bk = (m as THREE.InstancedMesh).isInstancedMesh ? 'W' : (m.userData.bk as string);
          if (bk === 's' + CAMO || bk === 'D' || bk === 'M' || bk === 'W') m.material = bakedMat(bk, this.f, res, this.fog);
        });
      }
    }
    // LOD1 / LOD2: index subsets of the merged buffers (shared attributes, incl. the baked uv1)
    let lodTris = [0, 0, 0];
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry;
      const total = g.attributes.position.count;
      const n = g.userData.lodN as number[] | undefined;
      const k = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
      let cnt = [total, total, total];
      const ex = lodGeos(g);
      if (ex) cnt = [total, ex[0].attributes.position.count, ex[1].attributes.position.count];
      else if (n && (n[0] < total || n[1] < total)) {
        const g1 = n[1] < total ? subGeo(g, n[1]) : g;
        const g2 = n[0] < n[1] ? subGeo(g, n[0]) : g1;
        registerLods(g, [g1, g2]);
        cnt = [total, n[1], n[0]];
      }
      for (let i = 0; i < 3; i++) lodTris[i] += (cnt[i] / 3) * k;
    });
    lodTris = lodTris.map(Math.round);
    const ray = new Probe(this.root, skip);
    return {
      root: this.root,
      height: box.max.y,
      size,
      glow: this.glow,
      emitters: this.emitters,
      gauge: this.gauge,
      tw: this.tw,
      wheeled: this.wheeled,
      custom: this.custom,
      bob: this.bob,
      kick: this.kick || (this.mi > 0 ? 0.18 : 0),
      stats: { tris: Math.round(tris), meshes, lod: lodTris },
      key: '',
      decals: this.layoutDecals(ray),
      fx: this.damagePoints(ray, box),
    };
  }
  /** Dust & mud amount per vertex from its height above the ground (root space) and facing. */
  private bakeDirt() {
    this.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || (mesh as THREE.InstancedMesh).isInstancedMesh || o.userData.tag === 'belt') return;
      const aw = mesh.geometry.getAttribute('aWear') as THREE.BufferAttribute | undefined;
      if (!aw) return;
      const pos = mesh.geometry.attributes.position;
      const nor = mesh.geometry.attributes.normal;
      const mw = mesh.matrixWorld;
      for (let i = 0; i < pos.count; i++) {
        if (aw.getX(i) < -0.5) continue; // team colour: kept clean
        _dv.fromBufferAttribute(pos, i).applyMatrix4(mw);
        const low = clamp((0.235 - _dv.y) / 0.165, 0, 1);
        const ny = nor.getY(i);
        // caked on the lower hull / fenders, a light film of dust on decks and the glacis
        const d = low * low * (3 - 2 * low) + Math.max(0, ny) * 0.12 + (ny < -0.5 ? 0.25 : 0);
        aw.setX(i, clamp(d, 0, 1));
      }
      aw.needsUpdate = true;
    });
  }
  /** Hull numbers + national marking spots on the turret (or hull) sides, found by ray casting the finished template. */
  private layoutDecals(ray: Probe): DecalSpec | null {
    const own = (t: THREE.Object3D) => t.children.filter((c) => (c as THREE.Mesh).isMesh && (c.userData.bk === 's' + CAMO || c.userData.bk === 'D')) as THREE.Mesh[];
    const tagged = (o: THREE.Object3D, t: string) => typeof o.userData.tag === 'string' && (o.userData.tag as string).split(' ').includes(t);
    // candidate parts: the turret first, then the part with the largest painted side (hull, launcher box, cargo body...)
    const cands: { g: THREE.Object3D; area: number; turret: boolean }[] = [];
    for (const p of this.parts) {
      let skipIt = false;
      for (let q: THREE.Object3D | null = p.g; q; q = q.parent) if (tagged(q, 'recoil') || tagged(q, 'whip') || tagged(q, 'spin')) skipIt = true;
      if (skipIt) continue;
      const bb = new THREE.Box3();
      for (const m of own(p.g)) if (m.userData.bk === 's' + CAMO) bb.expandByObject(m, false);
      if (bb.isEmpty()) continue;
      const area = (bb.max.x - bb.min.x) * (bb.max.y - bb.min.y);
      const turret = tagged(p.g, 'turret') && bb.max.y - bb.min.y > 0.05 && bb.max.x - bb.min.x > 0.2;
      cands.push({ g: p.g, area: area * (turret ? 100 : 1), turret });
    }
    cands.sort((a, b) => b.area - a.area);
    for (const c of cands.slice(0, 4)) {
      const r = this.layoutOn(ray, c.g, c.turret ? 'turret' : 'body', own);
      if (r) {
        c.g.userData.tag = ((c.g.userData.tag as string | undefined) ? c.g.userData.tag + ' ' : '') + 'decalT';
        return r;
      }
    }
    return null;
  }
  private layoutOn(ray: Probe, tg: THREE.Object3D, tkind: 'turret' | 'body', own: (t: THREE.Object3D) => THREE.Mesh[]): DecalSpec | null {
    const meshes = own(tg);
    const camo = meshes.filter((m) => m.userData.bk === 's' + CAMO);
    if (!camo.length) return null;
    const bb = new THREE.Box3();
    for (const m of camo) bb.expandByObject(m, false);
    const H = bb.max.y - bb.min.y;
    const numH0 = clamp(H * (tkind === 'turret' ? 0.4 : 0.22), 0.024, tkind === 'turret' ? 0.048 : 0.04);
    const f = this.f;
    const lum = ((this.base >> 16) & 255) * 0.3 + ((this.base >> 8) & 255) * 0.59 + (this.base & 255) * 0.11;
    const color = lum > 140 ? 0x1c1c1a : 0xe6e6de;
    const digits = f === 'israel' ? 2 : 3;
    // national marking: flag patch, the Bundeswehr cross, the PLA star, the IDF chevron
    const emblemOf = (numH: number): DecalSpot['emblem'] => {
      if (f === 'germany') return { cell: roundelCell('germany'), w: numH * 1.05, h: numH * 1.05, off: 0, color: 0xffffff };
      if (f === 'china') return { cell: roundelCell('china'), w: numH * 1.1, h: numH * 1.1, off: 0, color: 0xffffff };
      if (f === 'israel') return { cell: chevronCell(), w: numH * 0.95, h: numH * 0.95, off: 0, color };
      if (f !== 'neutral') return { cell: flagPatchCell(f), w: numH * 1.05, h: numH * 0.7, off: 0, color: 0xffffff };
      return null;
    };
    const spots: DecalSpot[] = [];
    const camoSet = new Set<THREE.Object3D>(camo);
    const bl = bb.max.x - bb.min.x;
    const xc0 = (bb.min.x + bb.max.x) / 2 - (tkind === 'turret' ? bl * 0.12 : bl * 0.05);
    // hull / truck bodies: also try the cab doors (front) and the rear body when the middle is a low flat bed
    const xcs = tkind === 'turret' ? [xc0] : [xc0, bb.max.x - bl * 0.16, bb.min.x + bl * 0.22, bb.max.x - bl * 0.3];
    const yf = tkind === 'turret' ? 0.5 : 0.62;
    for (const side of [1, -1]) {
      for (const k of [1, 0.75, 0.56]) {
        const numH = numH0 * k;
        const numW = digits * numH * 0.47 + (digits - 1) * numH * 0.08;
        const gap = numH * 0.35;
        let em = emblemOf(numH);
        let tot = numW + (em ? gap + em.w : 0);
        let hit: ReturnType<Probe['flatSpot']> = null;
        for (const xc of xcs) if (!hit) hit = ray.flatSpot(side, bb, tot, Math.max(numH, em?.h ?? 0), xc, yf, camoSet);
        if (!hit && em) {
          // not enough flat room for both: number only
          for (const xc of xcs) if (!hit) hit = ray.flatSpot(side, bb, numW, numH, xc, yf, camoSet);
          em = null;
          tot = numW;
        }
        if (!hit) continue;
        const n = hit.n;
        const u = new THREE.Vector3(side, 0, 0).addScaledVector(n, -n.x * side).normalize();
        const v = new THREE.Vector3().crossVectors(n, u).normalize();
        // to target-local space
        const inv = new THREE.Matrix4().copy(tg.matrixWorld).invert();
        const p = hit.p.clone().addScaledVector(n, 0.0015).applyMatrix4(inv);
        const nm = new THREE.Matrix3().setFromMatrix4(inv);
        u.applyMatrix3(nm).normalize();
        v.applyMatrix3(nm).normalize();
        const start = -tot / 2;
        spots.push({ p, u, v, numH, numOff: em ? start + em.w + gap + numW / 2 : 0, emblem: em ? { ...em, off: start + em.w / 2 } : null });
        break;
      }
    }
    if (!spots.length) return null;
    return { spots, digits, color };
  }
  /** Battle-damage particle points: engine deck smoke / fire, torn-plate sparks, turret ring fire. */
  private damagePoints(ray: Probe, box: THREE.Box3): NonNullable<Model['damageFx']> {
    const x0 = box.min.x;
    const x1 = box.max.x;
    const L = x1 - x0;
    const W = box.max.z - box.min.z;
    // engine near the exhaust (rear for most tanks, front for Merkava / Namer / trucks)
    const ex = this.emitters.find((e) => e.kind === 'smoke');
    let ex0 = x0 + L * 0.16;
    if (ex) ex0 = ex.pos.x > (x0 + x1) / 2 ? ex.pos.x - L * 0.14 : ex.pos.x + L * 0.14;
    ex0 = clamp(ex0, x0 + L * 0.1, x1 - L * 0.1);
    const top = (x: number, z: number) => new THREE.Vector3(x, ray.topY(x, z, true) + 0.012, z);
    let turretTop: THREE.Vector3 | null = null;
    this.root.traverse((o) => {
      if (!turretTop && typeof o.userData.tag === 'string' && (o.userData.tag as string).split(' ').includes('turret')) {
        const p = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
        turretTop = new THREE.Vector3(p.x, ray.topY(p.x, p.z, false) + 0.01, p.z);
      }
    });
    const mid = (x0 + x1) / 2;
    const fx: NonNullable<Model['damageFx']> = [
      { pos: top(ex0, W * 0.08), kind: 'smoke', at: 0.35 },
      { pos: new THREE.Vector3(mid + L * 0.1, box.max.y * 0.45, box.max.z * 0.92), kind: 'spark', at: 0.45 },
      { pos: turretTop ?? top(mid, 0), kind: 'smoke', at: 0.55 },
      { pos: new THREE.Vector3(mid - L * 0.15, box.max.y * 0.4, box.min.z * 0.92), kind: 'spark', at: 0.6 },
      { pos: top(ex0, -W * 0.1), kind: 'fire', at: 0.7 },
      { pos: top(mid + (ex0 < mid ? L * 0.22 : -L * 0.22), W * 0.12), kind: 'smoke', at: 0.8 },
      { pos: turretTop ? (turretTop as THREE.Vector3).clone().setY((turretTop as THREE.Vector3).y - 0.005) : top(mid, -W * 0.1), kind: 'fire', at: 0.88 },
    ];
    return fx;
  }
}

// ------------------------------------------------------------ template probing

const _dv = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);

const GRID: [number, number][] = [];
for (const gy of [-1, -0.5, 0, 0.5, 1]) for (const gx of [-1, -0.5, 0, 0.5, 1]) if (gx || gy) GRID.push([gx * 0.98, gy * 0.96]);

/** Hit on a loose piece (skirt, ERA brick, bin)? Markings must not sit on parts that fall off. */
function loose(h: THREE.Intersection): boolean {
  const aw = (h.object as THREE.Mesh).geometry?.getAttribute('aWear');
  return !!(aw && h.face && aw.getY(h.face.a) > 0.5);
}

/** Ray casts against a finished template (marking placement, damage points). */
class Probe {
  private readonly rc = new THREE.Raycaster();
  private readonly all: THREE.Object3D[] = [];
  private readonly hull: THREE.Object3D[] = [];
  private readonly o = new THREE.Vector3();
  private readonly d = new THREE.Vector3();
  constructor(root: THREE.Object3D, skip: (o: THREE.Object3D | null) => boolean) {
    const inTurret = (o: THREE.Object3D | null): boolean => {
      for (let q = o; q; q = q.parent) if (typeof q.userData.tag === 'string' && (q.userData.tag as string).split(' ').includes('turret')) return true;
      return false;
    };
    root.traverse((o) => {
      if (!(o as THREE.Mesh).isMesh || skip(o)) return;
      this.all.push(o);
      if (!inTurret(o)) this.hull.push(o);
    });
    this.rc.far = 20;
  }
  private first(list: THREE.Object3D[]) {
    this.rc.set(this.o, this.d);
    const h = this.rc.intersectObjects(list, false);
    return h.length ? h[0] : null;
  }
  /** Height of the first surface straight below (x, z). */
  topY(x: number, z: number, hullOnly: boolean): number {
    this.o.set(x, 6, z);
    this.d.copy(DOWN);
    const h = this.first(hullOnly ? this.hull : this.all);
    return h ? h.point.y : 0.15;
  }
  private side(x: number, y: number, side: number) {
    this.o.set(x, y, side * 6);
    this.d.set(0, 0, -side);
    return this.first(this.all);
  }
  /** A flat, unobstructed w x h patch of `paint` meshes on the +Z (side = 1) or -Z face of bb, near (xc, yFrac). */
  flatSpot(side: number, bb: THREE.Box3, w: number, h: number, xc: number, yFrac: number, paint: Set<THREE.Object3D>): { p: THREE.Vector3; n: THREE.Vector3 } | null {
    const y0 = bb.min.y + (bb.max.y - bb.min.y) * yFrac;
    const ys: number[] = [];
    for (let y = bb.min.y + h / 2 + 0.004; y <= bb.max.y - h / 2 - 0.004; y += 0.01) ys.push(y);
    ys.sort((a, b) => Math.abs(a - y0) - Math.abs(b - y0));
    const own = [...paint];
    for (const y of ys.slice(0, 10)) {
      for (let k = 0; k < 14; k++) {
        const x = xc + Math.ceil(k / 2) * 0.02 * (k % 2 ? 1 : -1);
        if (x - w / 2 < bb.min.x + 0.004 || x + w / 2 > bb.max.x - 0.004) continue;
        // cheap test against the target's own paint first, occlusion by the whole model after
        this.o.set(x, y, side * 6);
        this.d.set(0, 0, -side);
        const h0 = this.first(own);
        if (!h0 || !h0.face || loose(h0)) continue;
        const n = h0.face.normal.clone().transformDirection(h0.object.matrixWorld);
        if (n.z * side < 0.6 || Math.abs(n.y) > 0.55) continue;
        const occ = this.side(x, y, side);
        if (!occ || occ.object !== h0.object || occ.distance < h0.distance - 1e-4) continue;
        let ok = true;
        for (const [cx, cy] of GRID) {
          const hc = this.side(x + (cx * w) / 2, y + (cy * h) / 2, side);
          if (!hc || !paint.has(hc.object) || loose(hc) || Math.abs(_dv.subVectors(hc.point, h0.point).dot(n)) > 0.004) {
            ok = false;
            break;
          }
        }
        if (ok) return { p: h0.point.clone(), n };
      }
    }
    return null;
  }
}

// ------------------------------------------------------------ wheel matrices

const _wm = new THREE.Matrix4();
const _wq = new THREE.Quaternion();
const _wq2 = new THREE.Quaternion();
const _wp = new THREE.Vector3();
const _ws = new THREE.Vector3();
const AX_Y = new THREE.Vector3(0, 1, 0);
const AX_Z = new THREE.Vector3(0, 0, 1);
const Q_FLIP = new THREE.Quaternion().setFromAxisAngle(AX_Y, Math.PI);

function setWheelMatrices(im: THREE.InstancedMesh, list: WheelEntry[], dL: number, dR: number, steer: number) {
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const d = e.z >= 0 ? dR : dL;
    _wq.setFromAxisAngle(AX_Y, steer * e.steer);
    _wq2.setFromAxisAngle(AX_Z, -d / e.r);
    _wq.multiply(_wq2);
    if (e.flip) _wq.multiply(Q_FLIP);
    _wm.compose(_wp.set(e.x, e.y, e.z), _wq, _ws.set(e.s, e.s, e.s));
    im.setMatrixAt(i, _wm);
  }
  im.instanceMatrix.needsUpdate = true;
}

// ------------------------------------------------------------ track belts

interface Circ {
  x: number;
  y: number;
  r: number;
}

/** Closed belt centre line around the wheels (convex hull of circles), CCW in (x, y). */
function beltLoop(circles: Circ[], bt: number, sag: number): { p: P2[]; n: P2[]; s: number[]; len: number } {
  const pts: P2[] = [];
  for (const c of circles) {
    const r = c.r + bt / 2;
    for (let i = 0; i < 40; i++) {
      const a = (i / 40) * Math.PI * 2;
      pts.push([c.x + Math.cos(a) * r, c.y + Math.sin(a) * r]);
    }
  }
  pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: P2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 1e-9) lower.pop();
    lower.push(p);
  }
  const upper: P2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 1e-9) upper.pop();
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  let hull = lower.concat(upper); // CCW
  // subdivide long straight runs (for sag and smoother shading)
  const sub: P2[] = [];
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i];
    const b = hull[(i + 1) % hull.length];
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const k = sag > 0 ? Math.max(1, Math.ceil(l / 0.025)) : 1;
    for (let j = 0; j < k; j++) sub.push([a[0] + ((b[0] - a[0]) * j) / k, a[1] + ((b[1] - a[1]) * j) / k]);
  }
  hull = sub;
  if (sag > 0) {
    // supports along the top run: circles whose top lies on the hull
    const yTop = Math.max(...circles.map((c) => c.y + c.r));
    const sup = circles.filter((c) => c.y + c.r > yTop - 0.06).sort((a, b) => a.x - b.x);
    hull = hull.map(([x, y]) => {
      const cy = circles.reduce((m, c) => Math.max(m, c.y), 0);
      if (y < cy) return [x, y] as P2;
      for (let i = 0; i + 1 < sup.length; i++) {
        const a = sup[i].x + sup[i].r * 0.6;
        const b = sup[i + 1].x - sup[i + 1].r * 0.6;
        if (x > a && x < b) {
          const t = (x - a) / (b - a);
          return [x, y - sag * Math.sin(Math.PI * t) * Math.min(1, (b - a) / 0.25)] as P2;
        }
      }
      return [x, y] as P2;
    });
  }
  const n = hull.length;
  const nrm: P2[] = [];
  const s: number[] = [];
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const a = hull[(i - 1 + n) % n];
    const b = hull[(i + 1) % n];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const l = Math.hypot(tx, ty) || 1;
    tx /= l;
    ty /= l;
    nrm.push([ty, -tx]);
    s.push(acc);
    const c = hull[(i + 1) % n];
    acc += Math.hypot(c[0] - hull[i][0], c[1] - hull[i][1]);
  }
  return { p: hull, n: nrm, s, len: acc };
}

/** Swept track belt: outer tread surface, inner surface and both link-end sides. U = distance along the belt * k. */
function beltGeo(loop: ReturnType<typeof beltLoop>, z0: number, z1: number, bt: number, k: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const uv: number[] = [];
  const N = loop.p.length;
  const h = bt / 2;
  const tri = (a: number[], b: number[], c: number[], n: V3, want: V3) => {
    // a/b/c = [x,y,z,u,v]
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const ord = cx * want[0] + cy * want[1] + cz * want[2] >= 0 ? [a, b, c] : [a, c, b];
    for (const p of ord) {
      pos.push(p[0], p[1], p[2]);
      nor.push(n[0], n[1], n[2]);
      uv.push(p[3], p[4]);
    }
  };
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    const si = loop.s[i] * k;
    const sj = (j === 0 ? loop.len : loop.s[j]) * k;
    const [px, py] = loop.p[i];
    const [qx, qy] = loop.p[j];
    const [nx, ny] = loop.n[i];
    const [mx, my] = loop.n[j];
    const oi = [px + nx * h, py + ny * h];
    const oj = [qx + mx * h, qy + my * h];
    const ii = [px - nx * h, py - ny * h];
    const ij = [qx - mx * h, qy - my * h];
    const fx = (nx + mx) / 2;
    const fy = (ny + my) / 2;
    // outer
    const A = [oi[0], oi[1], z0, si, 0];
    const B = [oj[0], oj[1], z0, sj, 0];
    const C = [oj[0], oj[1], z1, sj, 1];
    const D = [oi[0], oi[1], z1, si, 1];
    tri(A, B, C, [fx, fy, 0], [fx, fy, 0]);
    tri(A, C, D, [fx, fy, 0], [fx, fy, 0]);
    // inner
    const E = [ii[0], ii[1], z0, si, 0];
    const F = [ij[0], ij[1], z0, sj, 0];
    const G = [ij[0], ij[1], z1, sj, 1];
    const H = [ii[0], ii[1], z1, si, 1];
    tri(E, F, G, [-fx, -fy, 0], [-fx, -fy, 0]);
    tri(E, G, H, [-fx, -fy, 0], [-fx, -fy, 0]);
    // sides (link ends)
    for (const [z, sz] of [
      [z1, 1],
      [z0, -1],
    ] as const) {
      const a = [oi[0], oi[1], z, si, 0.02];
      const b = [oj[0], oj[1], z, sj, 0.02];
      const c = [ij[0], ij[1], z, sj, 0.14];
      const d = [ii[0], ii[1], z, si, 0.14];
      tri(a, b, c, [0, 0, sz], [0, 0, sz]);
      tri(a, c, d, [0, 0, sz], [0, 0, sz]);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

function treadBase(fog: FogOfWar | null) {
  return cmat('tread3', fog, () => {
    const t = treadTex();
    return new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, roughness: 1, metalness: 0.3, normalScale: new THREE.Vector2(1.1, 1.1) });
  });
}

const BELT_WEAR: WearCfg = { dirt: true, loose: false, scale: 9, run: 'attr' };
function treadInstance(base: THREE.MeshStandardMaterial, fog: FogOfWar | null) {
  const m = new THREE.MeshStandardMaterial({
    map: base.map ? base.map.clone() : null,
    normalMap: base.normalMap ? base.normalMap.clone() : null,
    roughnessMap: base.roughnessMap ? base.roughnessMap.clone() : null,
    roughness: base.roughness,
    metalness: base.metalness,
    normalScale: base.normalScale.clone(),
  });
  if (fog) fog.apply(m);
  return wearPatch(m, BELT_WEAR);
}

// ------------------------------------------------------------- wheel styles

type WheelStyle = 'nato' | 'sov' | 't80' | 'merk' | 'asia' | 'light' | 'ugv';

const gDisc = (r: number, seg = 12) => new THREE.CircleGeometry(r, seg);
const gRing = (r0: number, r1: number, seg = 14) => new THREE.RingGeometry(r0, r1, seg, 1);

/** Lathe around the Z axis from a [radius, z] profile (outward faces: profile runs up the tread, then inward along the face). */
function gLatheZ(pts: [number, number][], seg: number): THREE.BufferGeometry {
  const g = new THREE.LatheGeometry(
    pts.map(([r, z]) => new THREE.Vector2(r, z)),
    seg,
  );
  g.rotateX(Math.PI / 2);
  return g;
}

/** LOD stand-ins of a wheel shape carry a neutral baked texel (their own charts are LOD0 only). */
function neutralUv1(g: THREE.BufferGeometry) {
  const n = g.attributes.position.count;
  g.setAttribute('uv1', new THREE.BufferAttribute(new Float32Array(n * 2).fill(0.003), 2));
  g.setAttribute('aTone', new THREE.BufferAttribute(new Float32Array(n).fill(0.5), 1));
  return g;
}

/**
 * Road wheel: axle along Z, outer face toward +Z, centred on the origin. LOD0: lathe-turned rubber tyre
 * with a rounded shoulder, steel rim lip, dished disc (style: holes / ribs), raised hub with cap;
 * LOD1: 10-sided tyre + flat disc + hub; LOD2: 8-sided drum. Registered as explicit geometry LODs.
 */
function roadWheelGeo(b: Bld, r: number, w: number, style: WheelStyle): THREE.BufferGeometry {
  const disc = style === 'sov' || style === 't80' ? shade(b.base, 0.68) : shade(b.base, 0.74);
  const rub = K.rubber;
  const hub = 0x3e4144;
  const zf = w / 2;
  const S = 13;
  const a = new Acc();
  // tyre: tread band with a rounded shoulder into the outer side wall
  a.add(gLatheZ([[r * 0.97, -zf], [r, -zf + w * 0.12], [r, zf - w * 0.12], [r * 0.95, zf], [r * 0.86, zf + 0.0008]], S), rub);
  a.add(gDisc(r * 0.97, S), rub, TR(0, 0, -zf, 0, Math.PI, 0));
  // steel rim lip + shallow dish (with a stiffening ring) + hub boss
  a.add(gLatheZ([[r * 0.86, zf + 0.0008], [r * 0.81, zf + 0.0028], [r * 0.6, zf - 0.003], [r * 0.54, zf - 0.0015], [r * 0.38, zf - 0.005]], S), disc);
  a.add(gLatheZ([[r * 0.38, zf - 0.005], [r * 0.33, zf + 0.0035], [r * 0.21, zf + 0.0075], [0.0001, zf + 0.0095]], 10), hub);
  // disc pattern
  if (style === 'sov') {
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * Math.PI * 2;
      a.add(new THREE.PlaneGeometry(r * 0.36, r * 0.07), shade(disc, 0.6), TR(Math.cos(t) * r * 0.62, Math.sin(t) * r * 0.62, zf - 0.0016, 0, 0, t));
    }
  } else if (style !== 'merk') {
    const holes = style === 'asia' ? 5 : style === 'light' || style === 'ugv' ? 4 : style === 't80' ? 8 : 6;
    const hr = style === 't80' ? 0.075 : 0.1;
    for (let i = 0; i < holes; i++) {
      const t = (i / holes) * Math.PI * 2 + 0.3;
      a.add(gDisc(r * hr, 7), K.black, TR(Math.cos(t) * r * 0.66, Math.sin(t) * r * 0.66, zf - 0.0018));
    }
  }
  // hub bolt circle (lug nuts)
  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2;
    a.add(gCylZ(r * 0.032, r * 0.032, 0.003, 3, true), 0x56595a, TR(Math.cos(t) * r * 0.27, Math.sin(t) * r * 0.27, zf + 0.0055));
  }
  const g0 = a.merged('D')!;
  delete g0.userData.lodN;
  // LOD1
  const a1 = new Acc();
  a1.add(gCylZ(r, r, w, 10, true), rub);
  a1.add(gDisc(r, 10), rub, TR(0, 0, zf));
  a1.add(gDisc(r * 0.8, 8), disc, TR(0, 0, zf + 0.0012));
  a1.add(gDisc(r, 8), rub, TR(0, 0, -zf, 0, Math.PI, 0));
  a1.add(gCylZ(r * 0.3, r * 0.36, 0.012, 6, true), hub, TR(0, 0, zf + 0.002));
  const g1 = neutralUv1(a1.merged('D')!);
  // LOD2
  const a2 = new Acc();
  a2.add(gCylZ(r, r, w, 8), rub);
  a2.add(gDisc(r * 0.78, 8), disc, TR(0, 0, zf + 0.0005));
  const g2 = neutralUv1(a2.merged('D')!);
  delete g1.userData.lodN;
  delete g2.userData.lodN;
  registerLods(g0, [g1, g2]);
  return g0;
}

/** Toothed ring (extruded gear outline) of radius r, axle along Z, centred on z. */
function gGear(r: number, teeth: number, depth: number): THREE.BufferGeometry {
  const pts: P2[] = [];
  const rr = r * 0.82;
  for (let i = 0; i < teeth; i++) {
    const t0 = (i / teeth) * Math.PI * 2;
    const dt = (Math.PI * 2) / teeth;
    for (const [f, rad] of [
      [0.0, rr],
      [0.22, rr],
      [0.36, r],
      [0.64, r],
      [0.78, rr],
    ] as [number, number][])
      pts.push([Math.cos(t0 + f * dt) * rad, Math.sin(t0 + f * dt) * rad]);
  }
  const g = gSide(pts, depth, 0);
  return g;
}

/** Flat spoked plate (axle along Z, centred on z = 0): outer ring to r, n spokes, hub hole free. */
function gSpokes(r: number, rHub: number, n: number, depth: number, spokeW = 0.32): THREE.BufferGeometry {
  const sh = new THREE.Shape();
  const N = 20;
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    if (i === 0) sh.moveTo(Math.cos(t) * r, Math.sin(t) * r);
    else sh.lineTo(Math.cos(t) * r, Math.sin(t) * r);
  }
  const r0 = rHub * 1.15;
  const r1 = r * 0.78;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2 + spokeW / 2 * ((Math.PI * 2) / n);
    const a1 = ((k + 1) / n) * Math.PI * 2 - spokeW / 2 * ((Math.PI * 2) / n);
    const h = new THREE.Path();
    const m = 3;
    for (let i = 0; i <= m; i++) {
      const t = a0 + ((a1 - a0) * i) / m;
      const p = [Math.cos(t) * r1, Math.sin(t) * r1];
      if (i === 0) h.moveTo(p[0], p[1]);
      else h.lineTo(p[0], p[1]);
    }
    for (let i = 0; i <= 2; i++) {
      const t = a1 - ((a1 - a0) * i) / 2;
      h.lineTo(Math.cos(t) * r0, Math.sin(t) * r0);
    }
    h.closePath();
    sh.holes.push(h);
  }
  const g = new THREE.ExtrudeGeometry(sh, { depth, bevelEnabled: false, curveSegments: 4 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Drive sprocket: two toothed rings on a spoked carrier, dark gap between them, hub boss (LOD1: one gear, LOD2: drum). */
function sprocketGeo(b: Bld, r: number, w: number, teeth = 12): THREE.BufferGeometry {
  const c = 0x4a4038; // worn / rusty teeth
  const disc = shade(b.base, 0.72);
  const zf = w / 2;
  const a = new Acc();
  for (const z of [-w * 0.27, w * 0.27]) a.add(gGear(r, teeth, w * 0.2), c, TR(0, 0, z));
  a.add(gCylZ(r * 0.62, r * 0.62, w * 0.36, 12, true), 0x262624);
  a.add(gSpokes(r * 0.8, r * 0.22, 6, 0.004), disc, TR(0, 0, zf * 0.72 + 0.002));
  a.add(gLatheZ([[r * 0.26, zf * 0.72], [r * 0.25, zf * 0.72 + 0.007], [r * 0.18, zf * 0.72 + 0.011], [0.0001, zf * 0.72 + 0.012]], 10), 0x3e4144);
  a.add(gDisc(r * 0.82, 12), shade(c, 0.6), TR(0, 0, -zf * 0.72, 0, Math.PI, 0));
  const g0 = a.merged('D')!;
  delete g0.userData.lodN;
  const a1 = new Acc();
  a1.add(gGear(r, teeth, w * 0.7), c);
  a1.add(gDisc(r * 0.8, 10), disc, TR(0, 0, w * 0.35 + 0.002));
  a1.add(gCylZ(r * 0.24, r * 0.3, 0.014, 6), 0x3e4144, TR(0, 0, w * 0.35 + 0.006));
  const g1 = neutralUv1(a1.merged('D')!);
  const a2 = new Acc();
  a2.add(gCylZ(r * 0.9, r * 0.9, w * 0.7, 8), c);
  const g2 = neutralUv1(a2.merged('D')!);
  delete g1.userData.lodN;
  delete g2.userData.lodN;
  registerLods(g0, [g1, g2]);
  return g0;
}

/** Spoked idler: rubber-tyred rim on a spoked plate, hub boss (LOD1: disc wheel, LOD2: drum). */
function idlerGeo(b: Bld, r: number, w: number): THREE.BufferGeometry {
  const disc = shade(b.base, 0.72);
  const zf = w / 2;
  const a = new Acc();
  a.add(gLatheZ([[r * 0.97, -zf], [r, -zf + w * 0.1], [r, zf - w * 0.12], [r * 0.95, zf], [r * 0.86, zf]], 15), K.rubber);
  a.add(gCylZ(r * 0.86, r * 0.86, w * 0.9, 15, true), 0x2a2a28);
  a.add(gSpokes(r * 0.87, r * 0.22, 6, 0.004), disc, TR(0, 0, zf - 0.003));
  a.add(gSpokes(r * 0.87, r * 0.22, 6, 0.004), disc, TR(0, 0, -zf + 0.003, 0, Math.PI, 0));
  a.add(gLatheZ([[r * 0.26, zf - 0.004], [r * 0.25, zf + 0.004], [r * 0.18, zf + 0.008], [0.0001, zf + 0.009]], 10), 0x3e4144);
  const g0 = a.merged('D')!;
  delete g0.userData.lodN;
  const a1 = new Acc();
  a1.add(gCylZ(r, r, w, 10, true), K.rubber);
  a1.add(gDisc(r, 10), disc, TR(0, 0, zf));
  a1.add(gDisc(r, 8), disc, TR(0, 0, -zf, 0, Math.PI, 0));
  const g1 = neutralUv1(a1.merged('D')!);
  const a2 = new Acc();
  a2.add(gCylZ(r, r, w, 8), K.rubber);
  const g2 = neutralUv1(a2.merged('D')!);
  delete g1.userData.lodN;
  delete g2.userData.lodN;
  registerLods(g0, [g1, g2]);
  return g0;
}

/** Truck / wheeled AFV tyre with hub (axle along Z, outer face +Z). */
function tyreGeo(b: Bld, r: number, w: number, military = true): THREE.BufferGeometry {
  const a = new Acc();
  a.add(gCylZ(r, r, w, 16, true), K.rubber);
  a.add(gRing(r * 0.62, r, 16), 0x202122, TR(0, 0, w / 2));
  a.add(gRing(r * 0.62, r, 16), 0x202122, TR(0, 0, -w / 2, 0, Math.PI, 0));
  // tread lugs on the rolling surface (chevrons, alternate sides)
  const lugs = 12;
  for (let i = 0; i < lugs; i++) {
    const t = (i / lugs) * Math.PI * 2;
    const zz = (i % 2 ? 1 : -1) * w * 0.2;
    a.add(new THREE.BoxGeometry(r * 0.16, r * 0.09, w * 0.5), 0x252627, TR(Math.cos(t) * r, Math.sin(t) * r, zz, 0, 0, t));
  }
  const hubC = military ? shade(b.base, 0.85) : 0x9a9a96;
  a.add(gCylZ(r * 0.62, r * 0.62, 0.01, 14, true), hubC, TR(0, 0, w / 2 - 0.004));
  a.add(gDisc(r * 0.62, 14), hubC, TR(0, 0, w / 2 - 0.002));
  a.add(gCylZ(r * 0.24, r * 0.32, 0.024, 8), 0x3a3c3e, TR(0, 0, w / 2 + 0.008));
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    a.add(gDisc(r * 0.05, 5), 0x9a9ea0, TR(Math.cos(t) * r * 0.44, Math.sin(t) * r * 0.44, w / 2 - 0.001));
  }
  // CTIS valve line (makes rotation readable)
  a.add(new THREE.BoxGeometry(r * 0.5, r * 0.07, 0.01), 0x2a2a2a, TR(r * 0.3, 0, w / 2 + 0.02));
  return a.merged('D')!;
}

// ---------------------------------------------------------- running gear

interface TrackSpec {
  wheels: number[]; // road wheel x positions
  rw: number; // road wheel radius
  spr: V3; // sprocket x, y, r
  idl: V3; // idler x, y, r
  rollers?: V3[]; // return rollers x, y, r
  gauge: number; // z of the belt centre line
  tw: number; // belt width
  bt?: number; // belt thickness
  sag?: number;
  style: WheelStyle;
  teeth?: number;
  arms?: boolean; // visible suspension arms
  /** Idler shape: 'wheel' = same as the road wheels (default), 'spoked' = open spoked idler. */
  idler?: 'wheel' | 'spoked';
}

function running(b: Bld, t: TrackSpec) {
  const bt = t.bt ?? 0.016;
  const wy = t.rw + bt;
  const circles: Circ[] = t.wheels.map((x) => ({ x, y: wy, r: t.rw }));
  circles.push({ x: t.spr[0], y: t.spr[1], r: t.spr[2] });
  circles.push({ x: t.idl[0], y: t.idl[1], r: t.idl[2] });
  for (const r of t.rollers ?? []) circles.push({ x: r[0], y: r[1], r: r[2] });
  const loop = beltLoop(circles, bt, t.sag ?? 0);
  const k = Math.max(1, Math.round(loop.len * TREAD_K)) / loop.len;
  const base = treadBase(b.fog);
  for (const side of [-1, 1]) {
    const zc = side * t.gauge * b.zk;
    const geo = beltGeo(loop, zc - t.tw / 2, zc + t.tw / 2, bt, k);
    const wa = new Float32Array(geo.attributes.position.count * 4);
    const py = geo.attributes.position;
    for (let i = 0; i < py.count; i++) {
      wa[i * 4] = 0.4;
      wa[i * 4 + 2] = py.getY(i); // root-space height: shade of the fenders (wear.ts run)
    }
    geo.setAttribute('aWear', new THREE.BufferAttribute(wa, 4));
    const mesh = new THREE.Mesh(geo, base);
    mesh.userData.tag = 'belt';
    mesh.userData.side = side;
    mesh.userData.k = k;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    b.root.add(mesh);
    b.extraTris += geo.attributes.position.count / 3;
  }
  // road wheels + idlers share one instanced geometry
  const ww = t.tw * 0.86;
  const rwGeo = roadWheelGeo(b, t.rw, ww, t.style);
  const list: WheelEntry[] = [];
  for (const side of [-1, 1]) {
    const z = side * t.gauge;
    for (const x of t.wheels) list.push({ x, y: wy, z, r: t.rw, s: 1, flip: side < 0 ? 1 : 0, steer: 0 });
    if (t.idler !== 'spoked') list.push({ x: t.idl[0], y: t.idl[1], z, r: t.idl[2], s: t.idl[2] / t.rw, flip: side < 0 ? 1 : 0, steer: 0 });
  }
  b.wheels(b.root, rwGeo, list);
  if (t.idler === 'spoked')
    b.wheels(
      b.root,
      idlerGeo(b, t.idl[2], ww),
      [-1, 1].map((side) => ({ x: t.idl[0], y: t.idl[1], z: side * t.gauge, r: t.idl[2], s: 1, flip: side < 0 ? 1 : 0, steer: 0 })),
      'wheels',
    );
  const spGeo = sprocketGeo(b, t.spr[2], ww, t.teeth ?? 12);
  b.wheels(
    b.root,
    spGeo,
    [-1, 1].map((side) => ({ x: t.spr[0], y: t.spr[1], z: side * t.gauge, r: t.spr[2], s: 1, flip: side < 0 ? 1 : 0, steer: 0 })),
    'wheels',
  );
  // return rollers (static) and suspension arms / hubs
  const c = b.chassis;
  // (behind the wheels / under the skirts at battle zoom: hero detail)
  c.at(2, () => {
    for (const side of [-1, 1]) {
      for (const r of t.rollers ?? []) {
        c.cz(r[2], r[2], t.tw * 0.5, r[0], r[1], side * t.gauge, K.rubber, 10);
        c.cz(r[2] * 0.5, r[2] * 0.5, t.tw * 0.55, r[0], r[1], side * t.gauge, 0x3e4144, 8);
      }
      if (t.arms !== false) {
        for (const x of t.wheels) {
          const zi = side * (t.gauge - t.tw / 2 - 0.012);
          c.box(t.rw * 1.3, 0.018, 0.016, x + t.rw * 0.55, wy + 0.012, zi, K.dark, 0, 0, 0.35);
          c.box(0.02, 0.02, 0.02, x + t.rw * 1.15, wy + t.rw * 0.35, zi, K.dark);
        }
      }
    }
  });
  b.gauge = t.gauge * b.zk;
  b.tw = t.tw;
}

/** Evenly spaced road wheel positions. */
function evenly(n: number, x0: number, x1: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(x0 + ((x1 - x0) * i) / Math.max(1, n - 1));
  return out;
}

interface Axle {
  x: number;
  steer: number;
}

/** Wheeled running gear: one InstancedMesh for all tyres; returns the axle height. */
function wheelSet(b: Bld, axles: Axle[], r: number, w: number, zc: number, military = true) {
  const geo = tyreGeo(b, r, w, military);
  const list: WheelEntry[] = [];
  for (const a of axles) for (const side of [-1, 1]) list.push({ x: a.x, y: r, z: side * zc, r, s: 1, flip: side < 0 ? 1 : 0, steer: a.steer });
  b.wheels(b.root, geo, list);
  // axles / differentials / suspension (static)
  const c = b.chassis;
  for (const a of axles) {
    c.cz(0.014, 0.014, zc * 2 - w, a.x, r, 0, K.dark, 6);
    c.box(0.05, 0.04, 0.06, a.x, r, 0, K.dark);
    for (const side of [-1, 1]) c.box(0.06, 0.012, 0.03, a.x, r + 0.03, side * (zc - w / 2 - 0.02), K.dark);
  }
  b.gauge = zc * b.zk;
  b.tw = w;
  b.wheeled = true;
  return r;
}

// ------------------------------------------------------------ common details

/** Headlight cluster (housing + lamp glow) facing +X at (x,y,z). */
function headlight(p: Part, x: number, y: number, z: number, s = 1) {
  p.box(0.022 * s, 0.026 * s, 0.04 * s, x - 0.006, y, z, K.dark);
  p.box(0.006, 0.016 * s, 0.026 * s, x + 0.006, y, z, LAMP);
  p.box(0.012, 0.004, 0.044 * s, x + 0.002, y + 0.015 * s, z, K.dark);
}
function taillight(p: Part, x: number, y: number, z: number) {
  p.box(0.012, 0.018, 0.026, x, y, z, K.dark);
  p.box(0.004, 0.012, 0.018, x - 0.007, y, z, 0xb02018);
}

/** Smoke grenade discharger bank: n tubes in a fan, facing roughly +X and outward. */
function smokeBank(p: Part, x: number, y: number, z: number, side: number, n = 4, yaw = 0.5, r = 0.009) {
  p.box(0.03, 0.012, n * r * 2.3, x - 0.01, y - r * 1.1, z, K.dark, 0, side * yaw, 0);
  for (let i = 0; i < n; i++) {
    const t = i / Math.max(1, n - 1) - 0.5;
    const zz = z + t * n * r * 2.2;
    const ry = side * (yaw + t * 0.5);
    const m = TR(x, y + Math.abs(t) * 0.004, zz, 0, -ry, 0.45);
    p.add(gCylX(r, r, 0.026, 6), mt(K.gun), m);
  }
}

/** Machine gun (receiver, barrel, ammo box) pointing +X, receiver centre at (x,y,z). */
function mgun(p: Part, x: number, y: number, z: number, len = 0.1, r = 0.0045, heavy = false) {
  p.box(0.05, 0.016, 0.016, x, y, z, mt(K.gun));
  p.cx(r, r, len, x + 0.025 + len / 2, y + 0.002, z, mt(K.dark), 6);
  if (heavy) p.cx(r * 1.7, r * 1.7, len * 0.2, x + 0.03 + len * 0.15, y + 0.002, z, mt(K.dark), 6);
  p.box(0.018, 0.02, 0.022, x - 0.004, y - 0.012, z + 0.016, K.olive);
  p.box(0.018, 0.008, 0.006, x - 0.026, y - 0.004, z, mt(K.gun));
}

/** Remote weapon station (CROWS / Samson style): base, cradle, MG, sight. Returns barrel tip x. */
function rws(p: Part, x: number, y: number, z: number, s = 1, heavy = true) {
  p.cy(0.026 * s, 0.03 * s, 0.014 * s, x, y, z, K.dark, 10);
  p.cbox(0.034 * s, 0.03 * s, 0.05 * s, 0.004, x, y + 0.03 * s, z, CAMO);
  p.box(0.03 * s, 0.026 * s, 0.022 * s, x + 0.01 * s, y + 0.034 * s, z - 0.036 * s, mixc(0x404040, 0x000000, 0.1));
  p.box(0.004, 0.012 * s, 0.014 * s, x + 0.026 * s, y + 0.036 * s, z - 0.036 * s, GLASS);
  p.box(0.06 * s, 0.018 * s, 0.018 * s, x + 0.005 * s, y + 0.034 * s, z + 0.012 * s, mt(K.gun));
  const len = (heavy ? 0.12 : 0.08) * s;
  p.cx(0.005 * s, 0.005 * s, len, x + 0.035 * s + len / 2, y + 0.036 * s, z + 0.012 * s, mt(K.dark), 6);
  if (heavy) p.cx(0.008 * s, 0.008 * s, 0.03 * s, x + 0.045 * s, y + 0.036 * s, z + 0.012 * s, mt(K.dark), 6);
  p.box(0.024 * s, 0.022 * s, 0.02 * s, x - 0.006 * s, y + 0.026 * s, z + 0.036 * s, K.olive);
  return x + 0.035 * s + len;
}

/** Hatch: low cylinder with a hinge and handle (recorded: the crew hatch is later rebuilt as an opening lid, see Bld.crew). */
function hatch(p: Part, x: number, y: number, z: number, r = 0.03, paint = CAMO) {
  p.cy(r, r * 1.04, 0.008, x, y, z, paint, 12);
  const disc = p.last;
  p.box(0.01, 0.006, r * 1.2, x - r * 0.9, y + 0.006, z, K.dark);
  p.box(r * 0.8, 0.004, 0.004, x + r * 0.1, y + 0.011, z, mt(K.steel));
  p.b.hatches.push({ p, x, y, z: z * p.b.zk, r, paint, geos: [disc, p.last] });
}

/** Periscope block (vision block) facing +X with glass. */
function periscope(p: Part, x: number, y: number, z: number, ry = 0, w = 0.022) {
  p.box(0.014, 0.012, w, x, y + 0.006, z, K.dark, 0, ry, 0);
  p.box(0.004, 0.007, w * 0.8, x + Math.cos(ry) * 0.007, y + 0.007, z - Math.sin(ry) * 0.007, GLASS, 0, ry, 0);
}

/** Panoramic sight head on a mast (commander's independent sight). */
function panoSight(p: Part, x: number, y: number, z: number, h = 0.04, s = 1) {
  p.cy(0.014 * s, 0.018 * s, h, x, y, z, K.dark, 10);
  p.cbox(0.044 * s, 0.034 * s, 0.04 * s, 0.006 * s, x, y + h + 0.017 * s, z, CAMO);
  p.box(0.005, 0.02 * s, 0.026 * s, x + 0.022 * s, y + h + 0.018 * s, z, GLASS);
  p.box(0.046 * s, 0.006 * s, 0.042 * s, x, y + h + 0.036 * s, z, K.dark);
}

/** Toolbox / stowage bin. */
function bin(p: Part, w: number, h: number, d: number, x: number, y: number, z: number, paint: number = CAMO, ry = 0) {
  p.piece(1, () => {
    p.cbox(w, h, d, Math.min(0.004, h * 0.2), x, y + h / 2, z, paint, 0, ry, 0);
    p.box(w * 1.01, 0.003, d * 1.01, x, y + h * 0.82, z, K.dark, 0, ry, 0);
    p.box(0.006, 0.006, 0.006, x + w * 0.3, y + h * 0.6, z + (d / 2) * Math.sign(z || 1), mt(K.steel));
    p.box(0.006, 0.006, 0.006, x - w * 0.3, y + h * 0.6, z + (d / 2) * Math.sign(z || 1), mt(K.steel));
  });
}

/** Jerry can standing on y, long side along X. */
function jerry(p: Part, x: number, y: number, z: number, c = 0x4c5434) {
  p.piece(1, () => {
    p.cbox(0.032, 0.046, 0.016, 0.003, x, y + 0.023, z, c);
    p.box(0.01, 0.006, 0.006, x + 0.008, y + 0.049, z, c);
  });
}

/** Tow cable along a polyline with eye loops. */
function cable(p: Part, pts: V3[], r = 0.0045) {
  p.at(2, () => {
    p.tube(pts, r, mt(0x3c3a36), 5);
    for (const e of [pts[0], pts[pts.length - 1]]) p.add(new THREE.TorusGeometry(r * 2.4, r * 0.8, 4, 8), mt(0x3c3a36), TR(e[0], e[1], e[2], 0, 0, 0));
  });
}

/** Engine deck grille: dark recess + slats along Z. */
function grille(p: Part, x: number, y: number, z: number, lx: number, lz: number, n = 6, paint: number = CAMO) {
  p.box(lx, 0.004, lz, x, y + 0.001, z, K.black);
  for (let i = 0; i < n; i++) p.box(0.006, 0.006, lz * 0.96, x - lx / 2 + ((i + 0.5) * lx) / n, y + 0.004, z, paint);
  p.box(lx + 0.008, 0.006, 0.006, x, y + 0.003, z - lz / 2, paint);
  p.box(lx + 0.008, 0.006, 0.006, x, y + 0.003, z + lz / 2, paint);
}

/** Team colour identification panel (thin plate) on a surface. */
function teamPanel(p: Part, w: number, h: number, d: number, x: number, y: number, z: number, team: number, rx = 0, ry = 0, rz = 0) {
  p.box(w, h, d, x, y, z, team, rx, ry, rz);
}

/** Pair of whip antennas on one pivot (sways with speed). */
function antennas(b: Bld, parent: Part, x: number, y: number, zs: number[], h: number) {
  const ap = b.part(parent, x, y, 0, 'whip');
  for (const z of zs) {
    ap.cy(0.008, 0.01, 0.016, 0, 0, z, K.dark, 6);
    ap.cy(0.0022, 0.003, h, 0, 0.016, z, K.black, 4);
    ap.sph(0.004, 0, 0.016 + h, z, K.black, 4, 3);
  }
  return ap;
}

/** Bolt row (tiny cylinders) along a vector. */
function bolts(p: Part, a: V3, d: V3, n: number, axis: 'x' | 'y' | 'z' = 'y', r = 0.0035) {
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : i / (n - 1);
    const g = axis === 'x' ? gCylX(r, r, 0.006, 5) : axis === 'z' ? gCylZ(r, r, 0.006, 5) : gCylY(r, r, 0.006, 5);
    p.add(g, mt(0x5a5e60), TR(a[0] + d[0] * t, a[1] + d[1] * t, a[2] + d[2] * t));
  }
}

/** Grid of ERA / armour bricks on a plane: m maps plane (u = X, v = Z, normal = Y). */
function bricks(p: Part, m: THREE.Matrix4, u0: number, u1: number, v0: number, v1: number, nu: number, nv: number, th: number, gap: number, paint: number = CAMO, stagger = false) {
  const du = (u1 - u0) / nu;
  const dv = (v1 - v0) / nv;
  for (let i = 0; i < nu; i++) {
    for (let j = 0; j < nv; j++) {
      const off = stagger && i % 2 ? dv * 0.5 : 0;
      const v = v0 + dv * (j + 0.5) + off;
      if (v + dv / 2 > v1 + 1e-6) continue;
      const g = new THREE.BoxGeometry(du - gap, th, dv - gap);
      p.piece(1, () => p.add(g, paint, m.clone().multiply(TR(u0 + du * (i + 0.5), th / 2, v))));
    }
  }
}

/** Slat armour panel: vertical bars between y0..y1 along a line in plan (x0,z0)->(x1,z1). */
function slats(p: Part, a: P2, c: P2, y0: number, y1: number, n: number, paint = 0x3a3d32) {
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const x = a[0] + (c[0] - a[0]) * t;
    const z = a[1] + (c[1] - a[1]) * t;
    p.box(0.004, y1 - y0, 0.004, x, (y0 + y1) / 2, z, paint);
  }
  for (const y of [y0 + 0.004, (y0 + y1) / 2, y1 - 0.003]) {
    const l = Math.hypot(c[0] - a[0], c[1] - a[1]);
    p.box(l, 0.004, 0.003, (a[0] + c[0]) / 2, y, (a[1] + c[1]) / 2, paint, 0, -Math.atan2(c[1] - a[1], c[0] - a[0]), 0);
  }
}

// ----------------------------------------------------------- main guns

interface GunOpt {
  len: number; // barrel length from the trunnion
  r: number; // barrel radius at the muzzle
  sleeve?: number; // thermal sleeve paint (default camo) or 0 for none
  fume?: number; // fume extractor position (0..1 along the barrel), <0 for none
  brake?: 'none' | 'arty' | 'small';
  mrs?: boolean; // muzzle reference sensor
  mantlet?: [number, number, number]; // mantlet box size
  elev?: number;
  sleevePaint?: number;
}

/** Main gun: fixed pivot (elevation) + recoil group with barrel, muzzle at the tip. */
function mainGun(b: Bld, tur: Part, x: number, y: number, z: number, o: GunOpt) {
  const piv = b.part(tur, x, y, z, 'gunpiv');
  piv.g.rotation.z = o.elev ?? 0.02;
  b.kick = Math.max(b.kick, o.brake === 'arty' ? 1.4 : clamp(o.r / 0.018, 0.6, 1.2));
  if (o.mantlet) {
    const [mw, mh, md] = o.mantlet;
    tur.cbox(mw, mh, md, 0.008, x - mw / 2 + 0.01, y, z, CAMO);
  }
  const rec = b.part(piv, 0, 0, 0, 'recoil');
  const L = o.len;
  const r = o.r;
  const sp = o.sleevePaint ?? CAMO;
  rec.cx(r * 1.35, r * 1.5, L * 0.3, L * 0.15, 0, 0, o.sleeve === 0 ? mt(K.gun) : sp, 12);
  rec.cx(r * 1.15, r * 1.3, L * 0.35, L * 0.47, 0, 0, o.sleeve === 0 ? mt(K.gun) : sp, 12);
  rec.cx(r, r * 1.12, L * 0.36, L * 0.81, 0, 0, o.sleeve === 0 ? mt(K.gun) : sp, 12);
  // sleeve clamps
  rec.at(2, () => {
    for (const t of [0.3, 0.64]) rec.cx(r * 1.4, r * 1.4, 0.008, L * t, 0, 0, mt(K.gun), 12);
  });
  const fume = o.fume ?? 0.45;
  if (fume >= 0) rec.cx(r * 1.75, r * 1.75, L * 0.16, L * fume, 0, 0, sp, 14);
  if (fume >= 0) {
    rec.cx(r * 1.3, r * 1.75, L * 0.03, L * fume - L * 0.095, 0, 0, sp, 14);
    rec.cx(r * 1.75, r * 1.3, L * 0.03, L * fume + L * 0.095, 0, 0, sp, 14);
  }
  if (o.brake === 'arty') {
    rec.cbox(L * 0.07, r * 3.2, r * 3.6, 0.004, L + L * 0.02, 0, 0, mt(K.gun));
    rec.box(L * 0.05, r * 2.4, r * 3.7, L + L * 0.02, 0, 0, K.black);
  } else if (o.brake === 'small') {
    rec.cx(r * 1.6, r * 1.6, L * 0.06, L - L * 0.02, 0, 0, mt(K.gun), 10);
  } else {
    rec.cx(r * 1.08, r * 1.08, 0.014, L - 0.007, 0, 0, mt(K.gun), 12);
  }
  rec.cx(r * 0.62, r * 0.62, 0.004, L + (o.brake === 'arty' ? L * 0.055 : 0.0015), 0, 0, mt(K.black), 10);
  if (o.mrs) {
    rec.box(0.022, 0.01, 0.012, L - 0.02, r * 1.2 + 0.004, 0, mt(K.gun));
    rec.box(0.008, 0.008, 0.008, L * 0.55, r * 1.5 + 0.003, 0, mt(K.gun));
  }
  b.muzzle(rec, L + (o.brake === 'arty' ? L * 0.06 : 0.012), 0, 0);
  return { piv, rec };
}

/** Autocannon / small gun barrel pointing +X in a recoil group, muzzle at the tip. */
function cannon(b: Bld, parent: Part, x: number, y: number, z: number, len: number, r: number, opts: { brake?: boolean; shroud?: number; paint?: number } = {}) {
  b.kick = Math.max(b.kick, clamp(r / 0.04, 0.15, 0.3));
  const rec = b.part(parent, x, y, z, 'recoil');
  const paint = opts.paint ?? mt(K.gun);
  rec.cx(r, r * 1.15, len, len / 2, 0, 0, paint, 8);
  if (opts.shroud) rec.cx(r * 1.9, r * 1.9, len * opts.shroud, (len * opts.shroud) / 2, 0, 0, paint, 10);
  if (opts.brake !== false) rec.cx(r * 1.7, r * 1.6, len * 0.09, len - len * 0.045, 0, 0, paint, 8);
  rec.cx(r * 0.55, r * 0.55, 0.003, len + 0.001, 0, 0, mt(K.black), 6);
  b.muzzle(rec, len + 0.006, 0, 0);
  return rec;
}

// ------------------------------------------------------------- instancing

const templates = new Map<string, Tpl>();
/** Field stowage items per template key (see Bld.clutter). */
/**
 * Width factors (Bld.zk) per template key or key|faction: older designs were authored ~20-30 % wider than
 * the real vehicles (real length : width ratios, e.g. Bradley 6.55 x 3.6 m, BTR-4 7.76 x 2.9 m, Boxer 7.93 x 2.99 m).
 */
const WIDTH_K: Record<string, number> = {
  apc: 0.85,
  'apc|china': 0.8,
  'apc|ukraine': 0.78,
  'apc|turkey': 0.8,
  aa: 0.84,
  arty: 0.82,
  laser: 0.82,
  tos: 0.86,
  berge: 0.86,
};
const CLUTTER: Record<string, number> = { mbt: 7, apc: 4, arty: 4, aa: 3, laser: 3, tos: 3, ew: 2, berge: 4, missile_truck: 2 };

function build(key: string, style: ModelStyle, fog: FogOfWar | null, fn: (b: Bld) => void): Model {
  const ck = `${key}|${style.faction}|${style.team}|${fogId(fog)}`;
  let t = templates.get(ck);
  if (!t) {
    const b = new Bld(style, fog);
    b.clutterN = CLUTTER[key] ?? 0;
    b.zk = WIDTH_K[key + '|' + style.faction] ?? WIDTH_K[key] ?? 1;
    b.key = key;
    b.crewOn = key === 'mbt' || key === 'apc';
    fn(b);
    t = b.finish();
    t.key = ck;
    templates.set(ck, t);
  }
  return instantiate(t, fog);
}

let instSeq = 0;
const decalGeos = new Map<string, THREE.BufferGeometry>();

/** Markings mesh (national emblem + per-instance tactical number), one draw call. */
function decalGeo(t: Tpl, num: string): THREE.BufferGeometry | null {
  const d = t.decals;
  if (!d) return null;
  const key = t.key + '|' + num;
  let g = decalGeos.get(key);
  if (g) return g;
  const parts: THREE.BufferGeometry[] = [];
  const c = new THREE.Vector3();
  for (const sp of d.spots) {
    if (sp.emblem) parts.push(decalQuad(c.copy(sp.p).addScaledVector(sp.u, sp.emblem.off), sp.u, sp.v, sp.emblem.w, sp.emblem.h, sp.emblem.cell, sp.emblem.color));
    parts.push(...numberQuads(c.copy(sp.p).addScaledVector(sp.u, sp.numOff), sp.u, sp.v, sp.numH, num, d.color));
  }
  if (!parts.length) return null;
  g = mergeGeometries(parts, false);
  g.computeBoundingSphere();
  decalGeos.set(key, g);
  return g;
}

function instantiate(t: Tpl, fog: FogOfWar | null): Model {
  const root = t.root.clone(true);
  const id = instSeq++;
  const seed = id & 3;
  const tags = new Map<string, THREE.Object3D[]>();
  root.traverse((o) => {
    const tg = o.userData.tag;
    if (typeof tg === 'string') {
      for (const name of tg.split(' ')) {
        let l = tags.get(name);
        if (!l) tags.set(name, (l = []));
        l.push(o);
      }
    }
  });
  const q = (tag: string) => tags.get(tag) ?? [];
  const muzzles = q('muzzle')
    .slice()
    .sort((a, b) => (a.userData.mi as number) - (b.userData.mi as number));
  const belts = q('belt') as THREE.Mesh[];
  const beltMats: THREE.MeshStandardMaterial[] = [];
  for (const m of belts) {
    const mat = treadInstance(m.material as THREE.MeshStandardMaterial, fog);
    m.material = mat;
    beltMats.push(mat);
  }
  const model: Model = {
    root,
    turret: q('turret')[0],
    muzzles,
    height: t.height,
    size: { ...t.size },
    glow: t.glow,
    emitters: t.emitters.map((e) => ({ pos: e.pos.clone(), kind: e.kind })),
    recoil: q('recoil'),
    trackGauge: t.gauge,
    trackWidth: t.tw,
    wheeled: t.wheeled,
  };
  if (!model.recoil!.length) delete model.recoil;
  // markings: national emblem + tactical number on the turret / hull sides
  const num = String((t.decals?.digits ?? 3) === 2 ? 10 + Math.floor(hash01(id * 7 + 3) * 90) : 100 + Math.floor(hash01(id * 7 + 3) * 900));
  const dg = decalGeo(t, num);
  const dTarget = q('decalT')[0];
  if (dg && dTarget) {
    const dm = new THREE.Mesh(dg, decalMat(fog));
    dm.receiveShadow = true;
    dm.userData.tag = 'decal';
    dTarget.add(dm);
  }
  model.damageFx = t.fx.map((f) => ({ pos: f.pos.clone(), kind: f.kind, at: f.at }));
  // battle damage: shared damaged material variants + per-instance belts
  const wear = new WearDriver(root, seed, beltMats);
  const gunPivs = q('gunpiv').map((o) => ({ o, z: o.rotation.z, k: 0.03 + 0.07 * hash01(id * 13 + o.id) }));
  const tur = model.turret;
  const turTilt = (hash01(id * 5 + 1) - 0.5) * 0.05;
  const wheelSets = q('wheels') as THREE.InstancedMesh[];
  const body = q('body')[0];
  const bodyY = body ? body.position.y : 0;
  const bodyX = body ? body.position.x : 0;
  const whips = q('whip');
  const spins = q('spin');
  const custom = t.custom ? t.custom(q, model) : undefined;
  const crew = crewAnim(q, id);
  const ramps = q('ramp');
  let rampT = 0;
  const ph = Math.random() * 100;
  let turnAcc = 0;
  let lastSpeed = 0;
  let acc = 0;
  // sprung hull state: pitch / roll / fore-aft shove and their velocities
  let pitch = 0;
  let roll = 0;
  let shove = 0;
  let pv = 0;
  let rv = 0;
  let xv = 0;
  let lastFired = Infinity;
  const wheeled = t.wheeled;
  // wheeled hulls ride softer and bouncier than tracked ones
  const SK = wheeled ? 62 : 115;
  const SC = 2 * (wheeled ? 0.26 : 0.42) * Math.sqrt(SK);
  let steer = 0;
  let lastD = NaN;
  let lastT = NaN;
  const gauge = t.gauge ?? 0.25;
  model.anim = (s: AnimState) => {
    const dt = s.dt;
    if (dt > 0) {
      turnAcc += s.turn * dt;
      const a = (s.speed - lastSpeed) / Math.max(dt, 1e-3);
      lastSpeed = s.speed;
      acc += (clamp(a, -8, 8) - acc) * Math.min(1, dt * 5);
      steer += (clamp(s.turn * 0.9, -0.45, 0.45) - steer) * Math.min(1, dt * 6);
    }
    const dL = s.dist - turnAcc * gauge;
    const dR = s.dist + turnAcc * gauge;
    if (dL !== lastD || dR !== lastT || Math.abs(steer) > 1e-4) {
      lastD = dL;
      lastT = dR;
      for (const w of wheelSets) setWheelMatrices(w, w.userData.wheels as WheelEntry[], dL, dR, steer);
      for (let i = 0; i < belts.length; i++) {
        const k = belts[i].userData.k as number;
        const d = (belts[i].userData.side as number) < 0 ? dL : dR;
        const off = (d * k) % 1;
        const mat = beltMats[i];
        if (mat.map) mat.map.offset.x = off;
        if (mat.normalMap) mat.normalMap.offset.x = off;
        if (mat.roughnessMap) mat.roughnessMap.offset.x = off;
      }
    }
    if (body) {
      const bob = t.bob;
      const sp = Math.min(1, s.speed / 1.5);
      // main gun shot: the hull rocks away from the gun (nose up for a shot over the front,
      // rolls away from a side shot) and is shoved back a touch, then settles on its springs
      if (s.fired < lastFired && s.fired < 0.25 && t.kick > 0 && bob > 0 && s.dead <= 0) {
        const ta = tur ? tur.rotation.y : 0;
        const imp = t.kick * 0.85 * (wheeled ? 1.25 : 1);
        pv += imp * Math.cos(ta);
        rv += imp * Math.sin(ta);
        xv -= t.kick * 0.25 * Math.cos(ta);
      }
      lastFired = s.fired;
      // load transfer: squat under acceleration, dive under braking, lean out of turns
      const pT = clamp(acc * 0.014, -0.045, 0.045) * bob;
      const rT = clamp(s.turn * s.speed * 0.03, -0.04, 0.04) * bob;
      let h = Math.min(dt, 0.1);
      while (h > 1e-5) {
        const st = Math.min(h, 1 / 60);
        h -= st;
        pv += (SK * (pT - pitch) - SC * pv) * st;
        pitch += pv * st;
        rv += (SK * (rT - roll) - SC * rv) * st;
        roll += rv * st;
        xv += (SK * 1.5 * -shove - SC * 1.2 * xv) * st;
        shove += xv * st;
      }
      // ground bounce: proportional to speed and the roughness under the hull (AnimState.rough)
      let by = 0;
      let bp = 0;
      let br = 0;
      if (s.moving && bob > 0) {
        const rough = s.rough ?? 0.35;
        const d = s.dist;
        if (wheeled) {
          const a = (0.25 + rough) * sp * bob;
          by = (Math.sin(d * 7.3 + ph) * 0.6 + Math.sin(d * 15.1 + ph * 2) * 0.4) * 0.0055 * a;
          bp = (Math.sin(d * 5.2 + ph * 3) * 0.7 + Math.sin(d * 11.7 + ph) * 0.3) * 0.016 * a;
          br = Math.sin(d * 6.1 + ph * 5) * 0.012 * a;
        } else {
          const a = (0.2 + rough) * sp * bob;
          by = Math.sin(d * 21 + ph) * 0.0022 * sp * bob + (Math.sin(d * 33 + ph * 2) * 0.6 + Math.sin(d * 12.7 + ph) * 0.4) * 0.0028 * a;
          bp = (Math.sin(d * 8.3 + ph * 3) * 0.6 + Math.sin(d * 19.7 + ph) * 0.4) * 0.009 * a;
          br = Math.sin(d * 10.9 + ph * 5) * 0.005 * a;
        }
      }
      body.rotation.z = pitch + bp;
      body.rotation.x = roll + br;
      body.position.y = bodyY + by;
      body.position.x = bodyX + shove;
    }
    const dmg = s.dead > 0 ? 1 : s.damage;
    if (s.dead <= 0) wear.update(dmg);
    for (let i = 0; i < whips.length; i++) {
      const w = whips[i];
      const sp = Math.min(s.speed, 3);
      // antennas snapped off by fragments
      const broken = dmg > 0.45 + 0.4 * hash01(id * 11 + i);
      w.scale.y = broken ? 0.3 : 1;
      w.rotation.z = -sp * 0.07 - acc * 0.01 + Math.sin(s.time * 8 + ph) * 0.035 * Math.min(1, sp + 0.2) - (broken ? 0.5 : 0);
      w.rotation.x = Math.sin(s.time * 5.3 + ph * 1.7) * 0.02 * Math.min(1, sp + 0.3);
    }
    // battered gun (drooping barrel) and a turret knocked askew on its ring
    const bat = dmg > 0.6 ? sstep(0.6, 0.92, dmg) : 0;
    for (const g of gunPivs) g.o.rotation.z = g.z - g.k * bat;
    if (tur) tur.rotation.x = turTilt * sstep(0.72, 0.95, dmg);
    for (const o of spins) {
      const rate = (o.userData.rate as number) ?? 1;
      const ax = (o.userData.axis as 'x' | 'y' | 'z') ?? 'y';
      o.rotation[ax] = ph + s.time * rate;
    }
    if (crew) crew(s);
    if (ramps.length) {
      // troop door: eases to AnimState.ramp (opening slower than the slam shut)
      const tgt = s.dead > 0 ? 0 : clamp(s.ramp ?? 0, 0, 1);
      const was = rampT;
      rampT = dt === 0 && s.time === 0 ? tgt : tgt > rampT ? Math.min(tgt, rampT + dt * 1.6) : Math.max(tgt, rampT - dt * 2.2);
      if (rampT !== was || s.time === 0) {
        const k = sstep(0, 1, rampT);
        for (const r of ramps) r.rotation[r.userData.axis as 'y' | 'z'] = (r.userData.open as number) * k;
      }
    }
    if (custom) custom(s);
  };
  return model;
}

/**
 * Commander in the hatch (see Bld.crew): rides out while calm, ducks inside and
 * pulls the lid shut within ~0.4 s when the vehicle fires, takes damage or the
 * renderer reports enemies near (AnimState.hatch = 0); pops back up after a few
 * quiet seconds. Idle: looks around, now and then glasses the horizon with
 * binoculars. Dead / wreck: inside, lid shut.
 */
const CREW_K = 1.35;
function crewAnim(q: (tag: string) => THREE.Object3D[], id: number): ((s: AnimState) => void) | undefined {
  const F = q('crew')[0];
  const A = q('crewA')[0];
  const Bn = q('crewB')[0];
  const lid = q('hlid')[0];
  if (!F || !A || !Bn || !lid) return undefined;
  const y0 = F.position.y;
  const seed = hash01(id * 17 + 5) * 100;
  let expo = 1;
  let calm = 10;
  let lastDmg = 0;
  let look = 0;
  let glass = false;
  let shown = -1;
  const OPEN = 1.95;
  Bn.visible = false;
  return (s: AnimState) => {
    const dt = Math.min(Math.max(s.dt, 0), 0.1);
    const dead = s.dead > 0;
    const hurt = s.damage > lastDmg + 0.001;
    lastDmg = s.damage;
    if (dead || (s.hatch ?? 1) < 0.5 || s.fired < 2.5 || hurt) calm = 0;
    else calm += dt;
    const tgt = calm > 3 ? 1 : 0;
    if (dead) expo = 0;
    else if (dt === 0 && s.time === 0) expo = tgt;
    else expo = tgt > expo ? Math.min(1, expo + dt / 1.6) : Math.max(0, expo - dt / 0.45);
    // 0 .. 0.3: lid swings open (closes last when ducking), 0.25 .. 1: the commander climbs up
    lid.rotation.z = OPEN * sstep(0, 0.3, expo);
    const up = sstep(0.25, 1, expo);
    F.position.y = y0 - 0.075 * CREW_K * (1 - up);
    const vis = up > 0.02 ? 1 : 0;
    if (vis !== shown) {
      F.visible = vis === 1;
      shown = vis;
    }
    if (!vis) return;
    // idle: scan the surroundings, binoculars for a few seconds every ~15 s (forward arc)
    const t = s.time + seed;
    const cyc = (t % 15) / 15;
    const g = up > 0.9 && cyc > 0.72 && cyc < 0.93;
    if (g !== glass) {
      glass = g;
      A.visible = !g;
      Bn.visible = g;
    }
    const want = g ? Math.sin(seed) * 0.5 : Math.sin(t * 0.37) * 1.1 + Math.sin(t * 0.91 + seed) * 0.45;
    look += (want - look) * Math.min(1, dt * 2.2);
    F.rotation.y = look;
    F.rotation.z = (g ? 0.06 : 0) + 0.04 * Math.sin(t * 0.6);
  };
}

/** Mark an object as a continuous spinner (rotation = time * rate). */
function spinner(o: THREE.Object3D, axis: 'x' | 'y' | 'z', rate: number) {
  o.userData.tag = ((o.userData.tag as string | undefined) ? o.userData.tag + ' ' : '') + 'spin';
  o.userData.axis = axis;
  o.userData.rate = rate;
}

/** Rotating amber beacon on a part. */
function beacon(b: Bld, p: Part, x: number, y: number, z: number, paint = AMBER) {
  p.cy(0.012, 0.014, 0.008, x, y, z, K.dark, 8);
  const sp = b.part(p, x, y + 0.008, z);
  spinner(sp.g, 'y', 7);
  sp.cy(0.011, 0.011, 0.018, 0, 0, 0, paint, 8);
  sp.box(0.004, 0.016, 0.023, 0.006, 0.009, 0, mt(K.bright));
  return sp;
}

/** Stats for the preview harness. */
export function vehicleStats(): Record<string, { tris: number; meshes: number; lod?: number[] }> {
  const out: Record<string, { tris: number; meshes: number; lod?: number[] }> = {};
  for (const [k, t] of templates) out[k] = t.stats;
  return out;
}


// =============================================================== tanks

/** Lower hull between the tracks (side profile, width 2*hw). */
function lowerHull(p: Part, pts: P2[], hw: number) {
  p.side(pts, hw * 2, 0, CAMO, 0.01);
}

/** Side skirt plate (profile in x/y) on both sides at |z| = zs, with panel seams. */
function skirts(p: Part, pts: P2[], zs: number, th: number, seams: number[], paint: number = CAMO, seamY: [number, number] = [0.09, 0.18]) {
  const top = Math.max(...pts.map((q) => q[1]));
  const xa = Math.min(...pts.map((q) => q[0]));
  const xb = Math.max(...pts.map((q) => q[0]));
  for (const s of [-1, 1]) {
    p.piece(
      s > 0 ? 2 : 3,
      () => {
        p.side(pts, th, s * zs, paint, Math.min(0.004, th * 0.3));
        for (const x of seams) p.box(0.004, seamY[1] - seamY[0], 0.003, x, (seamY[0] + seamY[1]) / 2, s * (zs + th / 2 + 0.001), K.dark);
      },
      s > 0 ? xb : xa,
      top,
    );
  }
}



/** Matrix for a plane from a to c in the x/y side profile (u along a->c, v along Z, normal up/out). */
function slopePlane(a: P2, c: P2, z = 0): THREE.Matrix4 {
  return TR(a[0], a[1], z, 0, 0, Math.atan2(c[1] - a[1], c[0] - a[0]));
}
/** Trophy APS: radar panel + launcher on a turret side (side = +-1). */
function trophy(T: Part, x: number, y: number, z: number, side: number, team?: number) {
  // launcher: armoured box + dome
  T.cbox(0.06, 0.035, 0.05, 0.006, x - 0.08, y + 0.018, z - side * 0.01, CAMO);
  T.sph(0.022, x - 0.08, y + 0.035, z - side * 0.01, mt(K.gun), 8, 4, 0.8, true);
  // flat radar panel
  T.cbox(0.075, 0.055, 0.012, 0.004, x, y - 0.005, z, CAMO, 0, side * 0.35, 0);
  T.box(0.058, 0.043, 0.002, x + 0.004, y - 0.005, z + side * 0.006, shade(T.b.base, 0.78), 0, side * 0.35, 0);
  if (team !== undefined) T.box(0.02, 0.006, 0.002, x - 0.02, y + 0.018, z + side * 0.007, team, 0, side * 0.35, 0);
}

/** Self-entrenching dozer blade folded under the nose (nose bottom at x0). */
function dozer(B: Part, x0: number) {
  B.side([[x0 - 0.01, 0.055], [x0 + 0.035, 0.055], [x0 + 0.075, 0.14], [x0 + 0.05, 0.145]], 0.5, 0, CAMO, 0.004);
  for (const z of [-0.2, -0.07, 0.07, 0.2]) B.box(0.008, 0.07, 0.008, x0 + 0.058, 0.1, z, K.dark, 0, 0, 0.4);
}

/** Two external fuel drums across the hull rear (Soviet style). */
function fuelDrums(B: Part, x: number, y: number, zs: number[]) {
  for (const z of zs) {
    B.cz(0.04, 0.04, 0.11, x, y, z, 0x4a5236, 12);
    for (const dz of [-0.035, 0.035]) B.cz(0.042, 0.042, 0.006, x, y, z + dz, 0x3c4230, 12);
    B.box(0.012, 0.09, 0.012, x + 0.03, y - 0.02, z - 0.06, K.dark);
  }
}

/** Unditching log across the rear. */
function unditchLog(B: Part, x: number, y: number, len: number) {
  B.cz(0.022, 0.024, len, x, y, 0, K.brown, 8);
  for (const z of [-len * 0.35, len * 0.35]) B.cz(0.026, 0.026, 0.008, x, y, z, K.dark, 8);
}

/** Soviet-style hull (T-72 family): low hull, fenders, flat deck. Returns deck height. */
function sovHull(b: Bld, o: { L: number; deck: number; nose: number; glacisX: number; W?: number; lowFront?: number }) {
  const B = b.body;
  const W = o.W ?? 0.62;
  const L = o.L;
  lowerHull(B, [[-L / 2 + 0.03, 0.06], [o.nose - 0.08, 0.06], [o.nose, 0.15], [-L / 2, 0.15]], 0.172);
  B.side(
    [
      [-L / 2 + 0.005, 0.15],
      [o.nose, 0.15],
      [o.nose + 0.01, 0.17],
      [o.glacisX, o.deck],
      [-L / 2 + 0.03, o.deck],
      [-L / 2, o.deck - 0.03],
    ],
    W - 0.02,
    0,
    CAMO,
    0.008,
  );
  // fenders over the tracks, extending fore and aft
  for (const s of [-1, 1]) {
    B.box(L + 0.03, 0.006, 0.135, -0.005, 0.155, s * 0.25, CAMO);
    B.box(0.05, 0.004, 0.13, o.nose + 0.02, 0.165, s * 0.25, CAMO, 0, 0, 0.35);
  }
  return o.deck;
}

/** Thin rubber side skirt with an optional row of ERA bricks on the forward part. */
function sovSkirts(b: Bld, x0: number, x1: number, y0: number, y1: number, eraTo: number, eraRows = 1) {
  const B = b.body;
  for (const s of [-1, 1]) {
    const z = s * 0.318;
    B.piece(s > 0 ? 3 : 2, () => B.box(x1 - x0, y1 - y0, 0.008, (x0 + x1) / 2, (y0 + y1) / 2, z, 0x26282a), s > 0 ? x0 : x1, y1);
    if (eraTo > x0) {
      const n = Math.round((eraTo - x0) / 0.072);
      bricks(B, TR(x0, y1 - 0.005, z + s * 0.004, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0, 0), 0, eraTo - x0, s > 0 ? 0 : -(y1 - y0 - 0.01) * 0 - 0.0, (y1 - y0 - 0.01), n, eraRows, 0.018, 0.006);
    }
  }
}







/** K2 / Altay family: sleek hull, angular wedge turret with a long autoloader bustle. */


/** Half outline ring (front centre -> rear centre, z >= 0) mirrored and lofted. */
/** Move the points of a half outline forward of x0 by dx (sloped front faces between rings). */
/** Uniform z scale of a half outline (side walls leaning in / out). */
/** Thin raised plate (bolted armour package lid, access panel) with a dark seam. */
/** Coaxial MG port beside the gun (dark slot + short barrel stub). */
/** Bustle / turret-side stowage rack: open frame of tubes with bags inside. */




/** Half outline ring (front centre -> rear centre, z >= 0) mirrored and lofted. */
/** Move the points of a half outline forward of x0 by dx (sloped front faces between rings). */
/** Uniform z scale of a half outline (side walls leaning in / out). */
/** Thin raised plate (bolted armour package lid, access panel) with a dark seam. */
/** Coaxial MG port beside the gun (dark slot + short barrel stub). */
/** Bustle / turret-side stowage rack: open frame of tubes with bags inside. */



// ---------------------------------------------------------------- MBT kit
/*
 * Main battle tanks, rebuilt from real dimensions (hull length ~1.1 tiles):
 * x scale ~0.139 / m, y ~0.15 / m (a touch of vertical exaggeration for RTS
 * readability) and true length : width ratios (the old hulls were ~30 % too
 * wide). Turrets are multi-ring faceted lofts (undercut lower edge, sloped
 * cheeks / roof chamfers) instead of single extrusions.
 */

/** Half outline ring (front centre -> rear centre, z >= 0) mirrored and lofted. */
function hloft(p: Part, rings: { y: number; h: P2[] }[], paint: number = CAMO, m?: THREE.Matrix4) {
  return p.loft(rings.map((r) => ({ y: r.y, p: mirrorZ(r.h) })), paint, false, m);
}
/** Move the points of a half outline forward of x0 by dx (sloped front faces between rings). */
function slopeF(h: P2[], x0: number, dx: number, dz = 0): P2[] {
  return h.map(([x, z]) => (x > x0 ? ([x + dx, Math.max(0, z + (z > 0.001 ? dz : 0))] as P2) : ([x, z] as P2)));
}
/** Uniform z scale of a half outline (side walls leaning in / out). */
function sz(h: P2[], k: number, dz = 0): P2[] {
  return h.map(([x, z]) => [x, z > 0.001 ? Math.max(0.002, z * k + dz) : 0] as P2);
}
/** Thin raised plate (bolted armour package lid, access panel) with a dark seam. */
function lid(p: Part, w: number, d: number, x: number, y: number, z: number, ry = 0) {
  p.box(w + 0.004, 0.002, d + 0.004, x, y + 0.001, z, K.dark, 0, ry, 0);
  p.box(w, 0.004, d, x, y + 0.002, z, CAMO, 0, ry, 0);
}
/** Coaxial MG port beside the gun (dark slot + short barrel stub). */
function coax(p: Part, x: number, y: number, z: number) {
  p.box(0.012, 0.014, 0.016, x, y, z, K.black);
  p.cx(0.0035, 0.0035, 0.02, x + 0.01, y, z, mt(K.dark), 6);
}
/** Bustle / turret-side stowage rack: open frame of tubes with bags inside. */
function rack(p: Part, x0: number, x1: number, z0: number, z1: number, y0: number, h: number, posts = 5) {
  const rk = 0x3a3d34;
  for (const y of [y0 + 0.004, y0 + h]) {
    p.box(x1 - x0, 0.005, 0.005, (x0 + x1) / 2, y, z0, rk);
    p.box(x1 - x0, 0.005, 0.005, (x0 + x1) / 2, y, z1, rk);
    p.box(0.005, 0.005, Math.abs(z1 - z0), x0, y, (z0 + z1) / 2, rk);
  }
  for (let i = 0; i < posts; i++) {
    const t = i / (posts - 1);
    p.box(0.005, h, 0.005, x0, y0 + h / 2, z0 + (z1 - z0) * t, rk);
  }
  for (const z of [z0, z1]) for (const x of [x0 + (x1 - x0) * 0.5, x1]) p.box(0.005, h, 0.005, x, y0 + h / 2, z, rk);
  p.box(Math.abs(x1 - x0), 0.003, Math.abs(z1 - z0), (x0 + x1) / 2, y0 + 0.002, (z0 + z1) / 2, rk);
}

// ---------------------------------------------------------------- MBT chassis specs
/*
 * Every MBT is built on its own chassis spec (CHASSIS below): hull profiles, running gear (road wheel
 * count / size / spacing and hub style, return rollers, sprocket front or rear, idler), engine position,
 * nose shape and rear. Proportions from published dimensions and the reference photos / drawings in
 * tools/vehicle-refs.md (x ~0.139 / m along the hull, y ~0.15 / m). The skirts, engine deck, armour
 * packages and turrets stay in each tank's builder.
 */
interface ChassisSpec {
  /** Real vehicle (for the reference log / checklist). */
  name: string;
  /** Lower hull side profile (between the tracks) and its half width. */
  lower: P2[];
  hw: number;
  /** Upper hull side profile over the tracks (nose, glacis, deck, rear) and its width. */
  upper: P2[];
  W: number;
  run: TrackSpec;
  engine: 'front' | 'rear';
  /** Rounded bow lip across the nose: x, y, radius. */
  lip?: V3;
  /** Rear crew door in the hull back plate: x of the plate, door centre y, height, width. */
  door?: [number, number, number, number];
}

/** Lower + upper hull, bow lip, rear door and running gear from a chassis spec. */
function chassis(b: Bld, c: ChassisSpec) {
  const B = b.body;
  running(b, c.run);
  lowerHull(B, c.lower, c.hw);
  B.side(c.upper, c.W, 0, CAMO, 0.01);
  if (c.lip) B.cz(c.lip[2], c.lip[2], c.W - 0.03, c.lip[0], c.lip[1], 0, CAMO, 10);
  if (c.door) {
    const [x, y, h, w] = c.door;
    B.box(0.006, h + 0.012, w + 0.012, x - 0.002, y, 0, K.dark);
    B.cbox(0.008, h, w, 0.003, x - 0.004, y, 0, CAMO);
    for (const dy of [-h * 0.32, h * 0.32]) B.cz(0.005, 0.005, 0.02, x - 0.006, y + dy, w / 2 - 0.004, mt(K.gun), 6);
    B.box(0.006, 0.006, 0.03, x - 0.01, y, -w * 0.25, mt(K.steel));
  }
}

const CHASSIS: Record<string, ChassisSpec> = {
  // Merkava Mk4: front engine (sprocket front), 6 large road wheels, return rollers behind the skirts,
  // rear idler; long sloped front deck to a rounded bow with a lip; rear crew door under the bustle
  israel: {
    name: 'Merkava Mk4',
    lower: [[-0.52, 0.07], [0.4, 0.07], [0.545, 0.15], [0.572, 0.19], [-0.55, 0.19]],
    hw: 0.148,
    upper: [[-0.553, 0.19], [0.46, 0.19], [0.56, 0.172], [0.585, 0.176], [0.598, 0.19], [0.6, 0.203], [0.592, 0.213], [0.572, 0.22], [0.08, 0.272], [-0.52, 0.278], [-0.556, 0.252]],
    W: 0.53,
    run: {
      wheels: evenly(6, -0.37, 0.31),
      rw: 0.06,
      spr: [0.478, 0.118, 0.054],
      idl: [-0.5, 0.106, 0.05],
      rollers: [
        [-0.24, 0.166, 0.013],
        [-0.03, 0.168, 0.013],
        [0.18, 0.168, 0.013],
      ],
      gauge: 0.208,
      tw: 0.114,
      bt: 0.022,
      sag: 0.004,
      style: 'merk',
      teeth: 11,
      idler: 'spoked',
    },
    engine: 'front',
    lip: [0.596, 0.197, 0.008],
    door: [-0.556, 0.222, 0.05, 0.15],
  },
};

/** Armour skirt panel of the side profile pts on side s (outer face at |z| = zo, thickness th), bevelled. */
function skirtPanel(B: Part, pts: P2[], s: number, zo: number, th: number, bevel = 0.003) {
  B.side(pts, th, s * (zo - th / 2), CAMO, bevel);
}

function mbtAbrams(b: Bld) {
  // M1A2 SEPv3: 7.93 m hull, 3.66 m wide, 2.44 m to the turret roof; 7 road wheels, 2 return rollers,
  // rear sprocket; flat angular turret with a long bustle + rack, CROWS, CITV, GPS "doghouse"
  const B = b.body;
  running(b, {
    wheels: evenly(7, -0.355, 0.335),
    rw: 0.047,
    spr: [-0.468, 0.104, 0.046],
    idl: [0.452, 0.094, 0.042],
    rollers: [
      [-0.19, 0.129, 0.014],
      [0.14, 0.129, 0.014],
    ],
    gauge: 0.206,
    tw: 0.112,
    style: 'nato',
  });
  lowerHull(B, [[-0.5, 0.072], [0.4, 0.072], [0.54, 0.16], [-0.52, 0.16]], 0.148);
  // upper hull + sponsons: very shallow upper glacis, flat deck, slightly sloped rear deck edge
  B.side([[-0.528, 0.156], [0.55, 0.156], [0.572, 0.182], [0.31, 0.244], [-0.47, 0.25], [-0.53, 0.232]], 0.52, 0, CAMO, 0.008);
  // skirts: thick ballistic front panels over the first three wheels, thin rear panels, cut-away at the sprocket
  skirts(B, [[-0.455, 0.096], [0.13, 0.096], [0.13, 0.2], [-0.47, 0.2]], 0.267, 0.012, [-0.31, -0.165, -0.02], CAMO, [0.098, 0.198]);
  skirts(B, [[0.13, 0.086], [0.45, 0.086], [0.548, 0.15], [0.556, 0.2], [0.13, 0.2]], 0.271, 0.022, [0.26, 0.4], CAMO, [0.09, 0.198]);
  for (const s of [-1, 1]) {
    B.box(1.0, 0.006, 0.03, 0.04, 0.2, s * 0.268, shade(b.base, 0.9)); // skirt top lip
    bolts(B, [-0.44, 0.188, s * 0.274], [0.56, 0, 0], 9, 'z', 0.003);
    headlight(B, 0.556, 0.2, s * 0.235);
    B.box(0.03, 0.03, 0.03, 0.545, 0.19, s * 0.17, K.dark); // brush guard base
    taillight(B, -0.533, 0.236, s * 0.24);
    bin(B, 0.11, 0.038, 0.06, -0.43, 0.25, s * 0.225);
  }
  // driver: centre hatch with 3 periscopes in the glacis
  hatch(B, 0.36, 0.236, 0, 0.034);
  for (const z of [-0.036, 0, 0.036]) periscope(B, 0.41, 0.229, z, 0, 0.02);
  // engine deck: big rear grille + access doors, rear exhaust grille, SEPv3 UAPU armoured box (left rear)
  grille(B, -0.39, 0.25, 0, 0.13, 0.32, 9);
  lid(B, 0.11, 0.2, -0.24, 0.25, 0);
  lid(B, 0.09, 0.2, -0.13, 0.25, 0);
  B.box(0.012, 0.055, 0.34, -0.533, 0.198, 0, K.black);
  for (let i = 0; i < 6; i++) B.box(0.006, 0.004, 0.34, -0.537, 0.178 + i * 0.008, 0, CAMO);
  B.cbox(0.1, 0.05, 0.07, 0.006, -0.47, 0.275, -0.205, CAMO);
  B.box(0.004, 0.03, 0.05, -0.521, 0.276, -0.205, K.black);
  cable(B, [[-0.52, 0.244, -0.2], [-0.535, 0.215, -0.08], [-0.535, 0.215, 0.08], [-0.52, 0.244, 0.2]]);
  for (const s of [-1, 1]) B.box(0.03, 0.026, 0.04, 0.47, 0.094, s * 0.1, K.dark); // tow eyes
  teamPanel(B, 0.004, 0.03, 0.12, -0.536, 0.236, 0.06, b.team);
  b.emit(-0.54, 0.2, 0.08);
  b.emit(-0.54, 0.2, -0.08);

  // ---- turret: flat, angular; cheeks with a chamfered roof edge; bustle overhangs the deck
  const T = b.part(B, -0.045, 0.25, 0, 'turret');
  const P0: P2[] = [[0.285, 0], [0.285, 0.072], [0.245, 0.15], [0.19, 0.226], [0.13, 0.232], [-0.13, 0.232], [-0.165, 0.214], [-0.375, 0.205], [-0.388, 0]];
  const PT: P2[] = [[0.205, 0], [0.205, 0.07], [0.18, 0.148], [0.14, 0.208], [0.1, 0.214], [-0.13, 0.218], [-0.16, 0.202], [-0.365, 0.193], [-0.376, 0]];
  hloft(T, [
    { y: -0.004, h: sz(slopeF(P0, 0.1, -0.012), 0.93) },
    { y: 0.024, h: P0 },
    { y: 0.08, h: slopeF(sz(P0, 0.985), 0.1, -0.01) },
    { y: 0.106, h: PT },
  ]);
  T.cy(0.19, 0.19, 0.012, 0, -0.012, 0, K.dark, 20);
  // armour package roof lids, gun slot
  for (const s of [-1, 1]) {
    lid(T, 0.06, 0.07, 0.15, 0.106, s * 0.15, s * 0.5);
    lid(T, 0.08, 0.06, 0.03, 0.106, s * 0.175);
  }
  T.box(0.012, 0.072, 0.112, 0.28, 0.052, 0, K.dark);
  coax(T, 0.29, 0.06, 0.058);
  // bustle rack (rear and sides) with bags, team panel on the rack
  rack(T, -0.47, -0.37, -0.195, 0.195, 0.022, 0.07, 7);
  for (const s of [-1, 1]) rack(T, -0.37, -0.2, s * 0.205, s * 0.235, 0.03, 0.06, 2);
  T.cbox(0.085, 0.055, 0.15, 0.012, -0.42, 0.06, 0.08, K.canvas);
  T.cbox(0.075, 0.05, 0.13, 0.012, -0.425, 0.054, -0.1, K.khaki);
  T.cbox(0.06, 0.04, 0.08, 0.01, -0.33, 0.05, -0.22, K.olive);
  teamPanel(T, 0.006, 0.026, 0.3, -0.474, 0.075, 0, b.team);
  for (const s of [-1, 1]) teamPanel(T, 0.15, 0.022, 0.004, -0.02, 0.06, s * 0.235, b.team, 0, s * 0.03, 0);
  // smoke grenade launchers (M250, 6 tubes) on the cheeks
  for (const s of [-1, 1]) smokeBank(T, 0.15, 0.09, s * 0.205, s, 6, 0.9, 0.008);
  // roof: commander CROWS (right), loader hatch + M240 with shield (left), GPS doghouse (right front), CITV (left)
  T.cy(0.05, 0.055, 0.016, -0.07, 0.106, 0.1, CAMO, 14);
  for (let i = 0; i < 6; i++) periscope(T, -0.07 + Math.cos(i) * 0.05, 0.106, 0.1 + Math.sin(i) * 0.05, -i, 0.016);
  rws(T, -0.06, 0.122, 0.1, 1.0, true);
  hatch(T, -0.08, 0.106, -0.11, 0.036);
  T.box(0.006, 0.04, 0.06, 0.0, 0.135, -0.11, CAMO); // MG shield
  mgun(T, -0.02, 0.15, -0.11, 0.09);
  T.cbox(0.085, 0.05, 0.065, 0.008, 0.11, 0.131, 0.125, CAMO);
  T.box(0.012, 0.034, 0.05, 0.156, 0.134, 0.125, K.dark, 0, 0, 0.3);
  T.box(0.004, 0.022, 0.04, 0.159, 0.13, 0.125, GLASS);
  T.cy(0.014, 0.018, 0.04, 0.06, 0.106, -0.07, K.dark, 10);
  T.cbox(0.05, 0.034, 0.045, 0.006, 0.06, 0.162, -0.07, CAMO);
  T.box(0.004, 0.02, 0.03, 0.086, 0.163, -0.07, GLASS);
  // wind sensor mast + antennas at the rear of the roof
  T.cy(0.003, 0.003, 0.05, -0.32, 0.106, 0.03, K.dark, 4);
  T.box(0.02, 0.005, 0.005, -0.32, 0.158, 0.03, K.dark);
  antennas(b, T, -0.27, 0.106, [-0.165, 0.165], 0.24);
  // M256 L/44: 9.77 m gun forward vs 7.93 m hull = 1.84 m overhang
  mainGun(b, T, 0.28, 0.052, 0, { len: 0.585, r: 0.0145, fume: 0.47, mrs: true, mantlet: [0.05, 0.066, 0.104] });
}

/** Painted marking chevron (two bars, apex toward +X) on a side face at |z| = zf, centred (x, y), arm length l. */
function chevron(p: Part, x: number, y: number, zf: number, l: number, th: number, side: number, color = 0xdcdad0) {
  const a = 0.62;
  for (const s of [-1, 1]) {
    const dx = Math.cos(a) * l * 0.5;
    const dy = Math.sin(a) * l * 0.5 * s;
    p.box(l, th, 0.0016, x - dx, y + dy, side * zf, color, 0, 0, -s * a);
  }
}

/** Basket on a turret bustle: tube frame, vertical bar mesh on the open faces, floor, stowed kit inside. */
function basket(p: Part, x0: number, x1: number, zw: number, y0: number, h: number, sideTo: number, reg: string) {
  const rk = 0x3c3e36;
  const t = 0.0042;
  // floor + rails (top, mid) around the rear (x0) and the two sides back to sideTo
  p.box(x1 - x0, 0.004, zw * 2, (x0 + x1) / 2, y0 + 0.002, 0, rk);
  for (const y of [y0 + h, y0 + h * 0.52]) {
    p.add(gCylZ(t, t, zw * 2, 5), rk, TR(x0, y, 0));
    for (const s of [-1, 1]) p.add(gCylX(t, t, sideTo - x0, 5), rk, TR((x0 + sideTo) / 2, y, s * zw));
  }
  for (const s of [-1, 1]) {
    p.box(t * 1.4, h, t * 1.4, x0, y0 + h / 2, s * zw, rk);
    p.box(t * 1.4, h, t * 1.4, sideTo, y0 + h / 2, s * zw, rk);
  }
  // bar mesh (dropped at far zoom; the bake keeps the rails' shading)
  p.at(1, () => {
    const n = Math.round((zw * 2) / 0.0125);
    const bar = gCylY(0.0013, 0.0013, h * 0.96, 3, true);
    for (let i = 1; i < n; i++) p.add(bar, rk, TR(x0, y0 + h * 0.5, -zw + (i * zw * 2) / n));
    const m = Math.round((sideTo - x0) / 0.0125);
    for (const s of [-1, 1]) for (let i = 1; i < m; i++) p.add(bar, rk, TR(x0 + (i * (sideTo - x0)) / m, y0 + h * 0.5, s * zw));
  });
  // stowed kit: rolled tarp, kit bags, ammo boxes
  const bag = reg === 'mideast' ? [0x8c7a56, 0x6c6444, 0x7a6a4a] : [0x5c5a3c, 0x4e5434, 0x6a6448];
  const dx = x1 - x0;
  p.cz(h * 0.32, h * 0.32, zw * 1.6, x0 + dx * 0.5, y0 + h * 0.36, 0, bag[0], 9);
  p.cbox(dx * 0.5, h * 0.55, zw * 0.5, 0.006, x0 + dx * 0.32, y0 + h * 0.3, zw * 0.45, bag[1]);
  p.cbox(dx * 0.42, h * 0.5, zw * 0.45, 0.006, x0 + dx * 0.3, y0 + h * 0.3 + 0.004, -zw * 0.5, bag[2]);
  p.box(dx * 0.3, h * 0.35, zw * 0.3, x0 + dx * 0.72, y0 + h * 0.2, -zw * 0.15, K.olive);
}

/** Ball-and-chain curtain hanging from a rail: n chains from a to b (plan points) at height y, length len. */
function chains(p: Part, a: P2, c: P2, n: number, y: number, len: number) {
  const ck = 0x34352f;
  p.add(gCylX(0.003, 0.003, Math.hypot(c[0] - a[0], c[1] - a[1]), 5), ck, TR((a[0] + c[0]) / 2, y, (a[1] + c[1]) / 2, 0, -Math.atan2(c[1] - a[1], c[0] - a[0]), 0));
  p.at(1, () => {
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = a[0] + (c[0] - a[0]) * t;
      const z = a[1] + (c[1] - a[1]) * t;
      const l = len * (0.97 + 0.06 * hash01(i * 7 + Math.round(x * 1000)));
      p.add(gCylY(0.0018, 0.0018, l, 3, true), ck, TR(x, y - l / 2, z));
      p.add(new THREE.OctahedronGeometry(0.0078, 0), mt(0x3a3a36), TR(x, y - l - 0.005, z, 0.3, i * 0.7, 0));
    }
  });
}

/** Thin armour module plate on a leaning turret side (lean angle th; side s), centred (x, y, z on the face). */
function turretModule(p: Part, x: number, y: number, z: number, L: number, H: number, th: number, s: number, t = 0.0075) {
  const nY = Math.sin(th);
  const nZ = Math.cos(th);
  p.cbox(L, H, t, 0.0022, x, y + nY * t * 0.5, s * (z + nZ * t * 0.5), CAMO, -s * th, 0, 0);
}

function mbtMerkava(b: Bld) {
  // Merkava Mk4: front engine, very long low wedge turret mounted far back, ball-and-chain bustle curtain,
  // Trophy APS, rear crew door (chassis: CHASSIS.israel)
  const B = b.body;
  chassis(b, CHASSIS.israel);
  // ---- side skirts: four long bolted panels (horizontal mid joint) per side, a front panel carrying the engine
  // intake (right) / exhaust louvres (left), a nose panel tapering into the bow, a row of flaps under a rib
  const zo = 0.284;
  const top = (x: number) => 0.27 - (x + 0.47) * 0.011;
  const yb = 0.147;
  const xs = [-0.47, -0.31, -0.15, 0.01, 0.17, 0.37];
  for (const s of [-1, 1]) {
    for (let i = 0; i < xs.length - 1; i++) {
      const x0 = xs[i] + 0.0016;
      const x1 = xs[i + 1] - 0.0016;
      const mid = (yb + top((x0 + x1) / 2)) / 2;
      B.piece(
        s > 0 ? 3 : 2,
        () => {
          if (i === 4) {
            // engine panel: frame around a big grille (left: exhaust louvres in two columns; right: diamond-mesh intake)
            skirtPanel(B, [[x0, yb], [x1, yb], [x1, top(x1)], [x0, top(x0)]], s, zo, 0.012, 0.003);
            const gx0 = x0 + 0.014;
            const gx1 = x1 - 0.014;
            const gy0 = yb + 0.014;
            const gy1 = top(x1) - 0.014;
            B.box(gx1 - gx0, gy1 - gy0, 0.004, (gx0 + gx1) / 2, (gy0 + gy1) / 2, s * (zo + 0.0005), s < 0 ? PAINT_LOUVRE : PAINT_MESH);
            if (s < 0) B.box(0.006, gy1 - gy0, 0.006, (gx0 + gx1) / 2, (gy0 + gy1) / 2, s * (zo + 0.002), CAMO);
            for (const y of [gy0 - 0.003, gy1 + 0.003]) B.box(gx1 - gx0 + 0.012, 0.006, 0.007, (gx0 + gx1) / 2, y, s * (zo + 0.002), CAMO);
            for (const x of [gx0 - 0.003, gx1 + 0.003]) B.box(0.006, gy1 - gy0 + 0.012, 0.007, x, (gy0 + gy1) / 2, s * (zo + 0.002), CAMO);
          } else {
            skirtPanel(B, [[x0, mid + 0.0013], [x1, mid + 0.0013], [x1, top(x1)], [x0, top(x0)]], s, zo, 0.017);
            skirtPanel(B, [[x0, yb], [x1, yb], [x1, mid - 0.0013], [x0, mid - 0.0013]], s, zo, 0.017);
          }
          // flap under the rib
          B.box(x1 - x0 - 0.003, 0.033, 0.009, (x0 + x1) / 2, yb - 0.0185, s * (zo - 0.006), CAMO);
        },
        s > 0 ? x0 : x1,
        top(x0),
      );
    }
    // nose panel tapering into the bow, the sprocket left open under it
    B.piece(s > 0 ? 3 : 2, () => {
      skirtPanel(B, [[0.372, yb], [0.43, yb], [0.5, 0.18], [0.565, 0.2], [0.586, 0.214], [0.372, top(0.372)]], s, zo, 0.017);
      B.side([[0.372, 0.114], [0.43, 0.114], [0.43, yb - 0.002], [0.372, yb - 0.002]], 0.009, s * (zo - 0.006), CAMO, 0.002);
    }, 0.372, top(0.372));
    // rib between the panels and the flap row, the top ledge, rubber strip
    B.box(0.856, 0.005, 0.007, -0.05, yb - 0.0015, s * (zo + 0.001), shade(b.base, 0.9));
    B.box(0.86, 0.005, 0.024, -0.05, top(-0.05) + 0.0025, s * (zo - 0.011), shade(b.base, 0.92), 0, 0, -0.011);
    B.box(0.9, 0.008, 0.006, -0.03, 0.098, s * (zo - 0.006), K.rubber);
    // IDF chevron on the nose panel
    chevron(B, 0.452, 0.19, zo + 0.0009, 0.064, 0.011, s);
    // grab handles / lifting brackets along the ledge
    B.at(2, () => {
      for (const x of [-0.39, -0.23, -0.07, 0.09, 0.27]) {
        B.box(0.022, 0.004, 0.004, x, top(x) - 0.008, s * (zo + 0.006), shade(b.base, 0.85));
        for (const dx of [-0.01, 0.01]) B.box(0.004, 0.009, 0.006, x + dx, top(x) - 0.004, s * (zo + 0.003), shade(b.base, 0.85));
      }
    });
  }
  // ---- front engine deck: big louvred air grille + access lids, driver front left, lights, tow cable
  B.box(0.16, 0.004, 0.13, 0.31, 0.2325, 0.1, PAINT_LOUVRE, 0, 0, -0.165);
  for (const z of [0.033, 0.167]) B.box(0.164, 0.006, 0.005, 0.31, 0.2335, z, CAMO, 0, 0, -0.165);
  B.box(0.11, 0.004, 0.09, 0.37, 0.222, -0.06, PAINT_LOUVRE, 0, 0, -0.165);
  lid(B, 0.12, 0.1, 0.17, 0.252, 0.12);
  lid(B, 0.1, 0.08, 0.46, 0.2045, 0.12);
  hatch(B, 0.17, 0.25, -0.13, 0.034);
  for (const z of [-0.17, -0.13, -0.09]) periscope(B, 0.215, 0.247, z, 0, 0.018);
  for (const s of [-1, 1]) {
    headlight(B, 0.565, 0.22, s * 0.22);
    B.at(1, () => {
      B.box(0.004, 0.03, 0.05, 0.588, 0.22, s * 0.22, K.dark);
      B.box(0.026, 0.004, 0.05, 0.575, 0.236, s * 0.22, K.dark);
    });
    // tow hooks on the bow
    B.box(0.022, 0.016, 0.026, 0.592, 0.178, s * 0.13, K.dark);
    taillight(B, -0.558, 0.262, s * 0.235);
  }
  cable(B, [[0.5, 0.215, 0.25], [0.2, 0.255, 0.25], [-0.2, 0.28, 0.24], [-0.4, 0.28, 0.22]]);
  // rear: stowage racks either side of the crew door, team panel
  teamPanel(B, 0.003, 0.016, 0.09, -0.564, 0.259, 0, b.team);
  for (const s of [-1, 1]) {
    B.at(2, () => rack(B, -0.585, -0.556, s * 0.1, s * 0.245, 0.195, 0.055, 4));
    B.cbox(0.025, 0.04, 0.07, 0.008, -0.57, 0.225, s * 0.2, K.canvas);
  }
  b.emit(0.27, 0.21, -0.29);
  b.clutterN = 0; // the kit rides in the turret basket

  // ---- turret: very long, low arrowhead wedge with leaning sides; bolted add-on modules on the flanks
  const T = b.part(B, -0.19, 0.288, 0, 'turret');
  // beaked nose: the undercut lower facet rises to the tip (gun at mid height), the roof slopes down to it
  const P0: P2[] = [[0.47, 0], [0.47, 0.03], [0.32, 0.12], [0.16, 0.215], [-0.15, 0.226], [-0.33, 0.218], [-0.39, 0.17], [-0.4, 0]];
  const PT: P2[] = [[0.29, 0], [0.29, 0.025], [0.2, 0.09], [0.07, 0.17], [-0.15, 0.18], [-0.32, 0.168], [-0.37, 0.13], [-0.38, 0]];
  // the bustle underside slopes up to the rear: the chain curtain hangs in the gap above the deck
  const under = (h: P2[]) => h.map(([x, z]) => [x < -0.19 ? -0.19 + (x + 0.19) * 0.08 : x, z] as P2);
  hloft(T, [
    { y: -0.02, h: under(slopeF(sz(P0, 0.88), 0.0, -0.13)) },
    { y: 0.03, h: P0 },
    { y: 0.094, h: slopeF(sz(P0, 0.9), 0.0, -0.11) },
    { y: 0.124, h: PT },
  ]);
  T.cy(0.19, 0.19, 0.016, 0.0, -0.034, 0, K.dark, 20);
  const lean = Math.atan2(0.0226, 0.064);
  for (const s of [-1, 1]) {
    // flank modules (the number / ID stripe sit on the middle one)
    // a long rear module (carries the big number and the ID stripe) and a front one
    turretModule(T, -0.245, 0.061, 0.2168, 0.25, 0.056, lean, s);
    turretModule(T, -0.055, 0.061, 0.218, 0.118, 0.056, lean, s);
    teamPanel(T, 0.1, 0.0095, 0.0015, -0.225, 0.0415, s * 0.2348, b.team, -s * lean, 0, 0);
    // lifting eyes
    T.at(2, () => {
      for (const x of [-0.3, 0.05]) T.add(new THREE.TorusGeometry(0.006, 0.0018, 4, 8), mt(0x4a4c48), TR(x, 0.126, s * 0.17, Math.PI / 2, 0, 0));
    });
    trophy(T, 0.06, 0.072, s * 0.218, s, b.team);
    smokeBank(T, 0.15, 0.104, s * 0.15, s, 5, 0.6, 0.008);
  }
  // roof plates, bustle rails
  lid(T, 0.15, 0.2, -0.25, 0.124, 0);
  for (const s of [-1, 1]) lid(T, 0.09, 0.06, 0.13, 0.124, s * 0.06, 0);
  // rear basket and the chain curtain under the bustle
  basket(T, -0.49, -0.385, 0.205, 0.026, 0.104, -0.33, b.style.region);
  chains(T, [-0.488, -0.2], [-0.488, 0.2], 28, 0.026, 0.058);
  for (const s of [-1, 1]) chains(T, [-0.475, s * 0.207], [-0.24, s * 0.218], 17, 0.024, 0.044);
  teamPanel(T, 0.004, 0.024, 0.2, -0.494, 0.07, 0, b.team);
  // mantlet: armoured box at the wedge tip, coax
  T.cbox(0.06, 0.056, 0.078, 0.008, 0.45, 0.05, 0, CAMO);
  coax(T, 0.47, 0.035, 0.035);
  // roof: commander's cupola (right rear) with sight block, panoramic sight, MG; loader hatch + MG (left),
  // 60 mm mortar, gunner's sight hood (front right)
  T.cy(0.045, 0.05, 0.016, -0.1, 0.124, 0.09, CAMO, 14);
  for (let i = 0; i < 5; i++) periscope(T, -0.1 + Math.cos(i * 1.2) * 0.045, 0.126, 0.09 + Math.sin(i * 1.2) * 0.045, -i * 1.2, 0.014);
  panoSight(T, -0.035, 0.124, 0.14, 0.034, 1.05);
  T.cbox(0.05, 0.05, 0.045, 0.006, -0.03, 0.164, 0.08, CAMO);
  T.box(0.004, 0.026, 0.03, -0.004, 0.17, 0.08, GLASS);
  // commander's MG on a pintle
  T.cy(0.004, 0.005, 0.03, -0.155, 0.14, 0.09, K.dark, 6);
  mgun(T, -0.13, 0.175, 0.09, 0.11, 0.0048, true);
  hatch(T, -0.1, 0.124, -0.1, 0.036);
  // loader MG on a ring mount with a small shield
  T.cy(0.004, 0.005, 0.028, -0.05, 0.124, -0.135, K.dark, 6);
  mgun(T, -0.035, 0.156, -0.135, 0.09);
  T.box(0.004, 0.026, 0.04, -0.012, 0.16, -0.135, CAMO);
  // 60 mm mortar tube with a muzzle cover
  T.cx(0.011, 0.011, 0.09, -0.03, 0.146, -0.07, mt(K.gun), 8);
  T.cx(0.0125, 0.0125, 0.012, 0.018, 0.146, -0.07, K.canvas, 8);
  T.box(0.026, 0.02, 0.026, -0.08, 0.134, -0.07, K.dark);
  T.cbox(0.06, 0.03, 0.045, 0.006, 0.1, 0.13, 0.07, CAMO);
  T.box(0.004, 0.02, 0.032, 0.131, 0.132, 0.07, GLASS);
  antennas(b, T, -0.34, 0.124, [-0.15, 0.15], 0.26);
  // MG253 L/44: 9.04 m gun forward vs 7.60 m hull = 1.44 m overhang; white recognition bands on the sleeve
  const g = mainGun(b, T, 0.48, 0.05, 0, { len: 0.5, r: 0.0158, fume: 0.42, mrs: true });
  // the sleeve thickens toward the mantlet
  g.rec.cx(0.0158 * 1.62, 0.0158 * 1.8, 0.075, 0.0375, 0, 0, CAMO, 14);
  g.rec.at(2, () => {
    for (const x of [0.36, 0.385]) g.rec.cx(0.0158 * 1.2, 0.0158 * 1.22, 0.009, x, 0, 0, 0xd4d2c8, 12);
  });
}
/** Slim Soviet-lineage hull (T-72 / T-80 / T-90 family): low hull, fenders over the tracks, flat deck. */
function sovHull2(b: Bld, o: { L: number; deck: number; nose: number; glacisX: number; W?: number; fw?: number }) {
  const B = b.body;
  const W = o.W ?? 0.44;
  const fw = o.fw ?? 0.272;
  const L = o.L;
  lowerHull(B, [[-L / 2 + 0.03, 0.07], [o.nose - 0.085, 0.07], [o.nose, 0.15], [-L / 2, 0.15]], 0.15);
  B.side([[-L / 2 + 0.005, 0.148], [o.nose, 0.148], [o.nose + 0.012, 0.168], [o.glacisX, o.deck], [-L / 2 + 0.03, o.deck], [-L / 2, o.deck - 0.028]], W, 0, CAMO, 0.008);
  // fenders over the tracks, running the full length with a raised front mudguard
  for (const s of [-1, 1]) {
    B.box(L + 0.03, 0.006, fw - W / 2 + 0.006, -0.005, 0.152, s * (W / 2 + fw) / 2, CAMO);
    B.box(0.05, 0.004, fw - W / 2, o.nose + 0.022, 0.163, s * (W / 2 + fw) / 2, CAMO, 0, 0, 0.35);
  }
  return o.deck;
}

/** Rubber side skirt hung off the fender with Relikt / Kontakt ERA bricks over its front part and an optional slat screen at the rear. */
function eraSkirt(b: Bld, x0: number, x1: number, y0: number, y1: number, eraTo: number, z: number, brickW = 0.07, slatFrom = 0) {
  const B = b.body;
  for (const s of [-1, 1]) {
    B.piece(s > 0 ? 3 : 2, () => B.box(x1 - x0, y1 - y0, 0.007, (x0 + x1) / 2, (y0 + y1) / 2, s * z, 0x26282a), s > 0 ? x0 : x1, y1);
    if (eraTo > x0) {
      const n = Math.max(1, Math.round((eraTo - x0) / brickW));
      const w = (eraTo - x0) / n;
      for (let i = 0; i < n; i++) B.piece(1, () => B.cbox(w - 0.006, y1 - y0 - 0.006, 0.018, 0.003, x1 - (i + 0.5) * w - (x1 - eraTo), (y0 + y1) / 2 + 0.002, s * (z + 0.012), CAMO));
    }
    if (slatFrom) slats(B, [x0, s * (z + 0.012)], [slatFrom, s * (z + 0.012)], y0 + 0.004, y1 + 0.02, 8);
  }
}

function mbtLeopard(b: Bld) {
  // Leopard 2A8: 7.7 m hull, 3.75 m wide, 7 road wheels + 4 return rollers, rear sprocket; vertical-sided
  // turret with the arrowhead wedge add-on armour and wedge mantlet, EMES-15 + PERI R17, Trophy, L/55 gun
  const B = b.body;
  running(b, {
    wheels: evenly(7, -0.365, 0.33),
    rw: 0.047,
    spr: [-0.47, 0.106, 0.046],
    idl: [0.452, 0.096, 0.042],
    rollers: [
      [-0.27, 0.13, 0.013],
      [-0.085, 0.13, 0.013],
      [0.1, 0.13, 0.013],
      [0.27, 0.13, 0.013],
    ],
    gauge: 0.207,
    tw: 0.112,
    style: 'nato',
  });
  lowerHull(B, [[-0.5, 0.072], [0.42, 0.072], [0.545, 0.16], [-0.52, 0.16]], 0.148);
  // short steep upper glacis with the 2A7 add-on plate, long flat deck, sloped rear plate
  B.side([[-0.535, 0.158], [0.548, 0.158], [0.565, 0.212], [0.36, 0.254], [-0.5, 0.258], [-0.537, 0.24]], 0.52, 0, CAMO, 0.008);
  B.add(gSide([[0.36, 0.256], [0.568, 0.214], [0.575, 0.198], [0.552, 0.196], [0.35, 0.24]], 0.4, 0.004), CAMO);
  // heavy front skirt modules (2A7 armour package), thin rear skirts with a rubber lower edge
  skirts(B, [[0.08, 0.088], [0.45, 0.088], [0.548, 0.14], [0.556, 0.212], [0.08, 0.212]], 0.272, 0.026, [0.2, 0.33]);
  skirts(B, [[-0.48, 0.1], [0.08, 0.1], [0.08, 0.205], [-0.49, 0.205]], 0.267, 0.01, [-0.36, -0.22, -0.08]);
  for (const s of [-1, 1]) {
    B.box(0.56, 0.014, 0.008, -0.2, 0.094, s * 0.271, K.rubber);
    headlight(B, 0.556, 0.222, s * 0.225);
    taillight(B, -0.535, 0.242, s * 0.24);
    bin(B, 0.1, 0.035, 0.055, -0.43, 0.258, s * 0.225);
    grille(B, -0.34, 0.258, s * 0.13, 0.18, 0.1, 7);
    b.emit(-0.54, 0.222, s * 0.17);
  }
  // driver front right
  hatch(B, 0.33, 0.255, 0.11, 0.032);
  for (const z of [0.07, 0.11, 0.15]) periscope(B, 0.375, 0.25, z, 0, 0.018);
  B.box(0.008, 0.05, 0.3, -0.537, 0.205, 0, K.dark);
  teamPanel(B, 0.004, 0.026, 0.12, -0.541, 0.205, 0, b.team);
  cable(B, [[0.5, 0.232, -0.235], [0.3, 0.258, -0.22], [-0.1, 0.26, -0.23]]);
  for (const s of [-1, 1]) B.box(0.03, 0.026, 0.04, 0.47, 0.092, s * 0.1, K.dark);

  // ---- turret: tall vertical sides, flat roof, long bustle with basket
  const T = b.part(B, -0.07, 0.258, 0, 'turret');
  const P0: P2[] = [[0.18, 0], [0.18, 0.222], [0.15, 0.23], [-0.22, 0.23], [-0.27, 0.218], [-0.4, 0.205], [-0.41, 0]];
  hloft(T, [
    { y: -0.004, h: sz(P0, 0.94) },
    { y: 0.02, h: P0 },
    { y: 0.128, h: sz(slopeF(P0, 0.1, -0.008), 0.975) },
  ]);
  T.cy(0.19, 0.19, 0.012, 0, -0.012, 0, K.dark, 20);
  for (const s of [-1, 1]) {
    // arrowhead wedge module: sharp tip by the gun, top sloping down to the front
    const bot: P2[] = s > 0 ? [[0.18, 0.07], [0.36, 0.072], [0.18, 0.236]] : [[0.18, -0.07], [0.18, -0.236], [0.36, -0.072]];
    const mid: P2[] = s > 0 ? [[0.18, 0.07], [0.34, 0.072], [0.18, 0.22]] : [[0.18, -0.07], [0.18, -0.22], [0.34, -0.072]];
    const tp: P2[] = s > 0 ? [[0.18, 0.07], [0.215, 0.071], [0.18, 0.11]] : [[0.18, -0.07], [0.18, -0.11], [0.215, -0.071]];
    T.loft([{ y: 0.006, p: bot }, { y: 0.07, p: mid }, { y: 0.126, p: tp }], CAMO);
    // Trophy radar panel + launcher, side stowage boxes, smoke dischargers at the rear sides
    trophy(T, 0.06, 0.07, s * 0.236, s, b.team);
    T.cbox(0.17, 0.065, 0.032, 0.006, -0.17, 0.06, s * 0.243, CAMO);
    T.cbox(0.1, 0.06, 0.03, 0.006, -0.33, 0.058, s * 0.22, CAMO);
    smokeBank(T, -0.23, 0.11, s * 0.236, s, 4, 1.25, 0.008);
    teamPanel(T, 0.15, 0.022, 0.003, -0.17, 0.06, s * 0.26, b.team);
  }
  // wedge mantlet
  T.plan([[0.33, 0], [0.25, 0.062], [0.19, 0.064], [0.19, -0.064], [0.25, -0.062]], 0.085, 0.022, CAMO, 0.004);
  coax(T, 0.27, 0.035, -0.05);
  // bustle basket with stowage
  rack(T, -0.5, -0.41, -0.2, 0.2, 0.02, 0.075, 6);
  T.cbox(0.075, 0.06, 0.16, 0.012, -0.455, 0.06, 0.08, K.canvas);
  T.cbox(0.07, 0.05, 0.14, 0.012, -0.455, 0.052, -0.1, 0x55583c);
  teamPanel(T, 0.004, 0.026, 0.3, -0.503, 0.07, 0, b.team);
  // roof: EMES-15 doghouse (right front), commander hatch + PERI R17 (right), loader hatch + FLW 200 RWS (left)
  T.cbox(0.09, 0.045, 0.065, 0.006, 0.1, 0.15, 0.13, CAMO);
  T.box(0.012, 0.036, 0.055, 0.147, 0.152, 0.13, K.dark, 0, 0, 0.35);
  T.box(0.004, 0.022, 0.044, 0.15, 0.15, 0.13, GLASS);
  T.cy(0.045, 0.05, 0.014, -0.08, 0.128, 0.12, CAMO, 14);
  for (let i = 0; i < 6; i++) periscope(T, -0.08 + Math.cos(i * 1.05) * 0.045, 0.128, 0.12 + Math.sin(i * 1.05) * 0.045, -i * 1.05, 0.014);
  panoSight(T, -0.02, 0.128, 0.17, 0.045, 1.0);
  hatch(T, -0.08, 0.128, -0.11, 0.036);
  rws(T, -0.17, 0.128, -0.1, 0.85, false);
  for (const s of [-1, 1]) lid(T, 0.08, 0.06, 0.04, 0.128, s * 0.16 - (s > 0 ? 0.05 : 0));
  antennas(b, T, -0.36, 0.128, [-0.15, 0.15], 0.24);
  // L/55: 10.97 m gun forward vs 7.72 m hull; fume extractor a quarter of the way out
  mainGun(b, T, 0.27, 0.065, 0, { len: 0.82, r: 0.0145, fume: 0.25, mrs: true });
}

function mbtT90(b: Bld) {
  // T-90M Proryv: 6.86 m hull, 3.78 m, 2.23 m; 6 large spoked road wheels, 3 return rollers; low hull with
  // Relikt glacis + V splash board, welded turret with Relikt "brows", big ammunition bustle in a slat cage
  const B = b.body;
  running(b, {
    wheels: [-0.35, -0.24, -0.095, 0.02, 0.165, 0.28],
    rw: 0.055,
    spr: [-0.455, 0.102, 0.046],
    idl: [0.42, 0.09, 0.043],
    rollers: [
      [-0.19, 0.143, 0.013],
      [-0.03, 0.143, 0.013],
      [0.13, 0.143, 0.013],
    ],
    gauge: 0.205,
    tw: 0.11,
    style: 'sov',
    sag: 0.012,
  });
  const deck = sovHull2(b, { L: 0.98, deck: 0.218, nose: 0.475, glacisX: 0.27 });
  eraSkirt(b, -0.46, 0.49, 0.098, 0.16, 0.49, 0.276, 0.075);
  // Relikt on the glacis + V splash board + dozer blade
  bricks(B, slopePlane([0.27, deck], [0.487, 0.168], 0), 0.012, 0.21, -0.22, 0.22, 3, 6, 0.02, 0.008);
  for (const s of [-1, 1]) B.box(0.012, 0.028, 0.22, 0.3, deck + 0.02, s * 0.1, CAMO, 0, s * 0.45, -0.3);
  dozer(B, 0.39);
  for (const s of [-1, 1]) {
    headlight(B, 0.49, 0.198, s * 0.19, 0.9);
    taillight(B, -0.49, 0.2, s * 0.235);
    bin(B, 0.12, 0.04, 0.06, 0.2, 0.155, s * 0.245, CAMO);
    bin(B, 0.1, 0.04, 0.06, -0.06, 0.155, s * 0.245, CAMO);
  }
  // right fender fuel tanks, left exhaust louvre
  for (const x of [-0.2, -0.33]) B.cx(0.028, 0.028, 0.11, x, 0.184, 0.245, CAMO, 10);
  B.box(0.07, 0.032, 0.02, -0.32, 0.18, -0.268, K.black);
  b.emit(-0.32, 0.19, -0.29);
  grille(B, -0.37, deck, 0, 0.16, 0.28, 8);
  unditchLog(B, -0.5, 0.25, 0.46);
  hatch(B, 0.32, deck, 0, 0.03);
  periscope(B, 0.36, deck, 0, 0, 0.026);
  cable(B, [[0.45, 0.17, -0.235], [0.2, 0.19, -0.225], [-0.1, 0.19, -0.235]]);
  teamPanel(B, 0.36, 0.02, 0.003, -0.02, 0.13, 0.299, b.team);
  teamPanel(B, 0.36, 0.02, 0.003, -0.02, 0.13, -0.299, b.team);

  // ---- turret: welded, angular, Relikt front "brows", long rectangular bustle
  const T = b.part(B, -0.04, deck, 0, 'turret');
  const P0: P2[] = [[0.2, 0], [0.2, 0.07], [0.12, 0.19], [0.04, 0.215], [-0.13, 0.215], [-0.17, 0.19], [-0.36, 0.18], [-0.37, 0]];
  hloft(T, [
    { y: -0.004, h: sz(P0, 0.92) },
    { y: 0.02, h: P0 },
    { y: 0.085, h: slopeF(sz(P0, 0.9), 0.05, -0.03) },
    { y: 0.1, h: slopeF(sz(P0, 0.84), 0.05, -0.06) },
  ]);
  T.cy(0.18, 0.18, 0.012, 0, -0.012, 0, K.dark, 20);
  for (const s of [-1, 1]) {
    // Relikt brow: thick wedge package each side of the gun; in side view its front face leans back ~45 deg
    // from the gun level to the roof (T-90M reference photos), plan arrowhead towards the gun
    const bot: P2[] = s > 0 ? [[0.32, 0.06], [0.15, 0.236], [0.08, 0.208], [0.2, 0.055]] : [[0.32, -0.06], [0.2, -0.055], [0.08, -0.208], [0.15, -0.236]];
    const mid: P2[] = s > 0 ? [[0.28, 0.059], [0.13, 0.226], [0.075, 0.2], [0.19, 0.053]] : [[0.28, -0.059], [0.19, -0.053], [0.075, -0.2], [0.13, -0.226]];
    const tp: P2[] = s > 0 ? [[0.2, 0.058], [0.1, 0.205], [0.07, 0.19], [0.15, 0.052]] : [[0.2, -0.058], [0.15, -0.052], [0.07, -0.19], [0.1, -0.205]];
    T.loft([{ y: 0.004, p: bot }, { y: 0.045, p: mid }, { y: 0.1, p: tp }], CAMO);
    for (let i = 0; i < 4; i++) {
      const t = (i + 0.5) / 4;
      T.box(0.004, 0.004, 0.07, 0.235 - t * 0.12, 0.099, s * (0.06 + t * 0.15), K.dark, 0, s * 0.85, 0);
    }
    // Relikt panels along the turret sides, smoke dischargers
    for (let i = 0; i < 3; i++) T.piece(1, () => T.cbox(0.06, 0.055, 0.016, 0.004, 0.01 - i * 0.065, 0.05, s * 0.223, CAMO));
    smokeBank(T, 0.06, 0.1, s * 0.19, s, 4, 1.0, 0.009);
    // roof Relikt plates over the front
    T.box(0.1, 0.014, 0.07, 0.11, 0.098, s * 0.09, CAMO, 0, 0, -0.08);
  }
  // bustle cage (slat armour + net)
  slats(T, [-0.43, -0.2], [-0.43, 0.2], -0.01, 0.1, 10);
  for (const s of [-1, 1]) slats(T, [-0.17, s * 0.22], [-0.43, s * 0.2], -0.01, 0.1, 6);
  T.box(0.26, 0.004, 0.4, -0.3, -0.008, 0, 0x3a3d32);
  teamPanel(T, 0.004, 0.022, 0.22, -0.372, 0.05, 0, b.team);
  // commander PK-5 sight + Kord RWS (right), gunner Sosna-U (left front), commander / gunner hatches
  T.cy(0.045, 0.05, 0.016, -0.07, 0.1, 0.09, CAMO, 14);
  rws(T, -0.08, 0.116, 0.09, 0.9, true);
  panoSight(T, 0.0, 0.1, 0.12, 0.04, 0.95);
  T.cbox(0.06, 0.045, 0.05, 0.006, 0.07, 0.122, -0.11, CAMO);
  T.box(0.004, 0.026, 0.036, 0.102, 0.124, -0.11, GLASS);
  hatch(T, -0.07, 0.1, -0.09, 0.034);
  antennas(b, T, -0.2, 0.1, [-0.14, 0.15], 0.24);
  // 2A46M-5: 9.63 m gun forward vs 6.86 m hull = 2.77 m overhang
  mainGun(b, T, 0.27, 0.05, 0, { len: 0.665, r: 0.014, fume: 0.6, mrs: false, mantlet: [0.04, 0.055, 0.08] });
}

function mbtOplot(b: Bld) {
  // T-84 Oplot-M: T-80UD-derived hull (6TD diesel, rear exhaust grille), 6 rubber-tyred road wheels + 5 return
  // rollers; welded box turret with Nozh ERA chevron brows, big rear ammunition bustle, PNK-6 panoramic sight
  const B = b.body;
  running(b, {
    wheels: evenly(6, -0.35, 0.3),
    rw: 0.053,
    spr: [-0.458, 0.102, 0.046],
    idl: [0.425, 0.088, 0.043],
    rollers: [
      [-0.27, 0.143, 0.012],
      [-0.13, 0.143, 0.012],
      [0.01, 0.143, 0.012],
      [0.15, 0.143, 0.012],
      [0.28, 0.143, 0.012],
    ],
    gauge: 0.205,
    tw: 0.11,
    style: 't80',
    sag: 0.006,
  });
  const deck = sovHull2(b, { L: 1.0, deck: 0.222, nose: 0.485, glacisX: 0.27 });
  eraSkirt(b, -0.47, 0.5, 0.098, 0.162, 0.5, 0.276, 0.06);
  // Nozh ERA: long thin chevron cassettes on the glacis
  const gp = slopePlane([0.27, deck], [0.497, 0.17], 0);
  for (let i = 0; i < 4; i++) for (const s of [-1, 1]) B.add(new THREE.BoxGeometry(0.03, 0.02, 0.22), CAMO, gp.clone().multiply(TR(0.035 + i * 0.05, 0.011, s * 0.11, 0, s * 0.35, 0)));
  dozer(B, 0.4);
  for (const s of [-1, 1]) {
    headlight(B, 0.5, 0.198, s * 0.19, 0.9);
    taillight(B, -0.5, 0.205, s * 0.235);
    bin(B, 0.11, 0.04, 0.06, 0.2, 0.155, s * 0.245, CAMO);
    bin(B, 0.14, 0.04, 0.06, -0.18, 0.155, s * 0.245, CAMO);
  }
  grille(B, -0.37, deck, 0, 0.2, 0.3, 9);
  B.box(0.008, 0.05, 0.3, -0.502, 0.19, 0, K.black);
  for (let i = 0; i < 5; i++) B.box(0.005, 0.004, 0.3, -0.506, 0.172 + i * 0.009, 0, CAMO);
  b.emit(-0.51, 0.19, 0.09);
  b.emit(-0.51, 0.19, -0.09);
  hatch(B, 0.32, deck, 0, 0.03);
  periscope(B, 0.36, deck, 0, 0, 0.026);
  unditchLog(B, -0.49, 0.262, 0.46);
  teamPanel(B, 0.36, 0.02, 0.003, 0.0, 0.13, 0.299, b.team);
  teamPanel(B, 0.36, 0.02, 0.003, 0.0, 0.13, -0.299, b.team);

  // ---- turret: flat-sided welded box, Nozh chevron brows, long bustle box almost to the hull rear
  const T = b.part(B, -0.05, deck, 0, 'turret');
  // (side drawing: the bustle box ends well ahead of the stern)
  const P0: P2[] = [[0.2, 0], [0.19, 0.09], [0.1, 0.205], [-0.12, 0.218], [-0.2, 0.2], [-0.36, 0.19], [-0.37, 0]];
  hloft(T, [
    { y: -0.004, h: sz(P0, 0.93) },
    { y: 0.02, h: P0 },
    { y: 0.105, h: slopeF(sz(P0, 0.92), 0.0, -0.02) },
  ]);
  T.cy(0.18, 0.18, 0.012, 0, -0.012, 0, K.dark, 20);
  for (const s of [-1, 1]) {
    const bot: P2[] = s > 0 ? [[0.33, 0.06], [0.13, 0.235], [0.08, 0.212], [0.21, 0.052]] : [[0.33, -0.06], [0.21, -0.052], [0.08, -0.212], [0.13, -0.235]];
    const tp: P2[] = s > 0 ? [[0.25, 0.058], [0.11, 0.205], [0.07, 0.19], [0.19, 0.05]] : [[0.25, -0.058], [0.19, -0.05], [0.07, -0.19], [0.11, -0.205]];
    T.loft([{ y: 0.004, p: bot }, { y: 0.1, p: tp }], CAMO);
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3;
      T.box(0.005, 0.006, 0.075, 0.29 - t * 0.17, 0.052, s * (0.065 + t * 0.15), K.dark, 0, s * 0.9, 0);
    }
    smokeBank(T, -0.04, 0.1, s * 0.21, s, 6, 1.0, 0.008);
    T.cbox(0.12, 0.05, 0.022, 0.006, -0.27, 0.05, s * 0.2, CAMO);
    // Varta optical-jammer emitters on the front corners
    T.cbox(0.03, 0.03, 0.03, 0.004, 0.06, 0.12, s * 0.18, 0x34363a);
    T.box(0.004, 0.02, 0.02, 0.076, 0.12, s * 0.18, RED);
  }
  for (let i = 0; i < 2; i++) lid(T, 0.06, 0.24, -0.25 - i * 0.065, 0.105, 0);
  teamPanel(T, 0.004, 0.022, 0.24, -0.372, 0.05, 0, b.team);
  // commander cupola + PNK-6 sight + MG (right), gunner sight (left)
  T.cy(0.045, 0.05, 0.02, -0.05, 0.105, 0.09, CAMO, 14);
  panoSight(T, -0.0, 0.125, 0.12, 0.03, 1.0);
  mgun(T, -0.07, 0.15, 0.07, 0.1, 0.005, true);
  T.box(0.03, 0.025, 0.03, -0.09, 0.135, 0.07, K.dark);
  T.cbox(0.06, 0.04, 0.05, 0.006, 0.08, 0.124, -0.11, CAMO);
  T.box(0.004, 0.024, 0.036, 0.112, 0.126, -0.11, GLASS);
  hatch(T, -0.06, 0.105, -0.09, 0.034);
  antennas(b, T, -0.27, 0.105, [-0.13, 0.13], 0.24);
  // KBA-3: 9.72 m gun forward vs 7.08 m hull = 2.64 m overhang
  mainGun(b, T, 0.27, 0.05, 0, { len: 0.67, r: 0.014, fume: 0.58, mrs: false, mantlet: [0.05, 0.055, 0.08] });
}

function mbtKarrar(b: Bld) {
  // Karrar: T-72-derived hull with box-ERA skirts all along, T-90MS-style welded turret with big ERA cheeks,
  // stowage bustle with slat cage, RWS; desert tan
  const B = b.body;
  running(b, {
    wheels: [-0.35, -0.24, -0.095, 0.02, 0.165, 0.28],
    rw: 0.055,
    spr: [-0.455, 0.102, 0.046],
    idl: [0.42, 0.09, 0.043],
    rollers: [
      [-0.19, 0.143, 0.013],
      [-0.03, 0.143, 0.013],
      [0.13, 0.143, 0.013],
    ],
    gauge: 0.205,
    tw: 0.11,
    style: 'sov',
    sag: 0.012,
  });
  const deck = sovHull2(b, { L: 0.98, deck: 0.22, nose: 0.475, glacisX: 0.27 });
  for (const s of [-1, 1]) {
    // (reference photos: Karrar's box skirts hang low, covering most of the road wheels)
    B.box(0.95, 0.1, 0.008, 0.015, 0.113, s * 0.275, 0x2a2c2e);
    for (let i = 0; i < 9; i++) B.piece(1, () => B.cbox(0.098, 0.096, 0.02, 0.004, -0.43 + i * 0.106, 0.115, s * 0.289, CAMO));
  }
  bricks(B, slopePlane([0.27, deck], [0.487, 0.168], 0), 0.006, 0.21, -0.22, 0.22, 2, 5, 0.024, 0.01);
  dozer(B, 0.39);
  for (const s of [-1, 1]) {
    headlight(B, 0.49, 0.198, s * 0.19, 0.9);
    taillight(B, -0.49, 0.2, s * 0.235);
    bin(B, 0.12, 0.04, 0.06, 0.24, 0.155, s * 0.245, CAMO);
  }
  B.box(0.07, 0.032, 0.02, -0.32, 0.18, -0.268, K.black);
  b.emit(-0.32, 0.19, -0.29);
  grille(B, -0.37, deck, 0, 0.16, 0.28, 8);
  fuelDrums(B, -0.525, 0.235, [-0.13, 0.13]);
  hatch(B, 0.32, deck, 0, 0.03);
  periscope(B, 0.36, deck, 0, 0, 0.026);
  teamPanel(B, 0.004, 0.024, 0.18, -0.494, 0.2, 0, b.team);

  // ---- turret: angular welded, large ERA cheek blocks, square bustle box with slats
  const T = b.part(B, -0.04, deck, 0, 'turret');
  const P0: P2[] = [[0.22, 0], [0.21, 0.1], [0.12, 0.212], [-0.12, 0.222], [-0.22, 0.196], [-0.38, 0.186], [-0.39, 0]];
  hloft(T, [
    { y: -0.004, h: sz(P0, 0.93) },
    { y: 0.02, h: P0 },
    { y: 0.1, h: slopeF(sz(P0, 0.93), 0.0, -0.02) },
  ]);
  T.cy(0.18, 0.18, 0.012, 0, -0.012, 0, K.dark, 20);
  for (const s of [-1, 1]) {
    // front ERA: 2 x 3 big blocks on each cheek
    const nx = 0.75;
    const nz = s * 0.66;
    for (let i = 0; i < 3; i++) {
      const t = (i + 0.5) / 3;
      const x = 0.215 - 0.1 * t + nx * 0.016;
      const z = s * (0.1 + 0.11 * t) + nz * 0.016;
      for (let j = 0; j < 2; j++) T.piece(1, () => T.cbox(0.03, 0.04, 0.05, 0.004, x, 0.028 + j * 0.044, z, CAMO, 0, -Math.atan2(nz, nx), 0));
    }
    T.box(0.08, 0.016, 0.07, 0.08, 0.104, s * 0.09, CAMO, 0, 0, -0.1);
    smokeBank(T, 0.02, 0.09, s * 0.21, s, 6, 1.1, 0.008);
    T.cbox(0.14, 0.05, 0.024, 0.006, -0.28, 0.05, s * 0.192, CAMO);
    teamPanel(T, 0.14, 0.02, 0.003, -0.08, 0.05, s * 0.224, b.team);
  }
  T.box(0.04, 0.085, 0.075, 0.24, 0.045, 0, CAMO);
  slats(T, [-0.42, -0.18], [-0.42, 0.18], 0.0, 0.1, 9);
  // commander cupola + RWS, panoramic sight, gunner sight
  T.cy(0.045, 0.05, 0.018, -0.06, 0.1, 0.09, CAMO, 14);
  rws(T, -0.07, 0.118, 0.09, 0.85, true);
  panoSight(T, 0.0, 0.1, 0.13, 0.03, 0.9);
  T.cbox(0.07, 0.045, 0.055, 0.006, 0.08, 0.125, -0.11, CAMO);
  T.box(0.004, 0.026, 0.04, 0.117, 0.127, -0.11, GLASS);
  hatch(T, -0.06, 0.1, -0.09, 0.034);
  antennas(b, T, -0.3, 0.1, [-0.13, 0.14], 0.22);
  mainGun(b, T, 0.26, 0.05, 0, { len: 0.64, r: 0.014, fume: 0.6, mrs: true, mantlet: [0.04, 0.05, 0.08] });
}

function mbtType99(b: Bld) {
  // Type 99A: 7.6 m hull, 3.5 m wide; 6 road wheels unevenly spaced (close pairs front + rear, two far apart
  // in the middle), 4 return rollers; arrowhead ERA turret front, ERA side panels, laser dazzler, RWS
  const B = b.body;
  running(b, {
    wheels: [-0.37, -0.25, -0.07, 0.11, 0.225, 0.34],
    rw: 0.058,
    spr: [-0.47, 0.108, 0.047],
    idl: [0.45, 0.096, 0.044],
    rollers: [
      [-0.3, 0.152, 0.013],
      [-0.16, 0.152, 0.013],
      [0.02, 0.152, 0.013],
      [0.17, 0.152, 0.013],
    ],
    gauge: 0.2,
    tw: 0.11,
    style: 'asia',
  });
  lowerHull(B, [[-0.5, 0.072], [0.43, 0.072], [0.545, 0.17], [-0.525, 0.17]], 0.145);
  B.side([[-0.53, 0.168], [0.548, 0.168], [0.568, 0.2], [0.33, 0.252], [-0.5, 0.256], [-0.533, 0.236]], 0.5, 0, CAMO, 0.008);
  // deep skirts (lower edge near the hub line) with bolted composite / ERA modules along the whole run
  skirts(B, [[-0.48, 0.088], [0.42, 0.088], [0.548, 0.15], [0.556, 0.212], [-0.49, 0.212]], 0.263, 0.012, [-0.3, -0.12, 0.06]);
  for (const s of [-1, 1]) {
    for (let i = 0; i < 9; i++) B.piece(1, () => B.cbox(0.094, 0.1, 0.018, 0.004, -0.43 + i * 0.1, 0.148, s * 0.277, CAMO));
    headlight(B, 0.556, 0.212, s * 0.225);
    taillight(B, -0.535, 0.236, s * 0.235);
    bin(B, 0.12, 0.035, 0.055, -0.42, 0.256, s * 0.22);
  }
  bricks(B, slopePlane([0.33, 0.252], [0.568, 0.2], 0), 0.02, 0.22, -0.23, 0.23, 2, 6, 0.018, 0.01);
  grille(B, -0.37, 0.256, 0, 0.2, 0.3, 9);
  hatch(B, 0.36, 0.242, 0, 0.032);
  periscope(B, 0.4, 0.236, 0, 0, 0.03);
  B.box(0.008, 0.05, 0.3, -0.537, 0.21, 0, K.black);
  b.emit(-0.54, 0.21, 0.09);
  b.emit(-0.54, 0.21, -0.09);
  teamPanel(B, 0.38, 0.022, 0.003, -0.1, 0.17, 0.2875, b.team);
  teamPanel(B, 0.38, 0.022, 0.003, -0.1, 0.17, -0.2875, b.team);

  // ---- turret: vertical-sided box with the long arrowhead ERA nose, bustle with stowage basket
  const T = b.part(B, -0.06, 0.256, 0, 'turret');
  const P0: P2[] = [[0.17, 0], [0.17, 0.2], [0.12, 0.222], [-0.2, 0.222], [-0.34, 0.195], [-0.37, 0]];
  hloft(T, [
    { y: -0.004, h: sz(P0, 0.94) },
    { y: 0.02, h: P0 },
    { y: 0.112, h: sz(P0, 0.96) },
  ]);
  T.cy(0.18, 0.18, 0.012, 0, -0.012, 0, K.dark, 20);
  for (const s of [-1, 1]) {
    const bot: P2[] = s > 0 ? [[0.17, 0.058], [0.43, 0.062], [0.17, 0.236]] : [[0.17, -0.058], [0.17, -0.236], [0.43, -0.062]];
    const tp: P2[] = s > 0 ? [[0.17, 0.058], [0.3, 0.06], [0.17, 0.18]] : [[0.17, -0.058], [0.17, -0.18], [0.3, -0.06]];
    T.loft([{ y: 0.006, p: bot }, { y: 0.104, p: tp }], CAMO);
    for (let i = 0; i < 4; i++) {
      const t = (i + 0.5) / 4;
      T.box(0.004, 0.08, 0.004, 0.43 - t * 0.26, 0.05, s * (0.062 + t * 0.18), K.dark);
    }
    for (let i = 0; i < 3; i++) T.piece(1, () => T.cbox(0.07, 0.065, 0.016, 0.004, 0.06 - i * 0.08, 0.055, s * 0.232, CAMO));
    smokeBank(T, -0.24, 0.112, s * 0.16, s, 5, 1.3, 0.008);
    teamPanel(T, 0.12, 0.02, 0.003, -0.24, 0.05, s * 0.224, b.team);
  }
  rack(T, -0.45, -0.37, -0.17, 0.17, 0.02, 0.065, 5);
  T.cbox(0.06, 0.05, 0.14, 0.01, -0.41, 0.05, 0.06, K.canvas);
  // big stowage cylinder along the right rear of the turret (a Type 99A signature)
  T.cx(0.034, 0.034, 0.16, -0.36, 0.07, 0.205, CAMO, 14);
  T.cx(0.036, 0.036, 0.006, -0.44, 0.07, 0.205, K.dark, 14);
  T.box(0.012, 0.03, 0.03, -0.3, 0.05, 0.19, K.dark);
  teamPanel(T, 0.004, 0.024, 0.28, -0.453, 0.055, 0, b.team);
  // roof: laser dazzler / LWR box (right front), gunner sight (left), commander panoramic sight + RWS
  T.cbox(0.075, 0.055, 0.055, 0.006, 0.07, 0.14, 0.14, CAMO);
  T.cx(0.018, 0.018, 0.01, 0.11, 0.145, 0.14, LENS, 10);
  T.cbox(0.06, 0.04, 0.05, 0.006, 0.08, 0.132, -0.11, CAMO);
  T.box(0.004, 0.024, 0.036, 0.112, 0.134, -0.11, GLASS);
  panoSight(T, -0.06, 0.112, 0.08, 0.035, 0.95);
  rws(T, -0.16, 0.112, 0.11, 0.85, true);
  hatch(T, -0.08, 0.112, -0.1, 0.035);
  antennas(b, T, -0.3, 0.112, [-0.14, 0.14], 0.24);
  // ZPT-98A 125 mm L/50: 11.0 m gun forward vs 7.6 m hull = 3.4 m overhang
  mainGun(b, T, 0.28, 0.056, 0, { len: 0.8, r: 0.0145, fume: 0.5, mrs: true, mantlet: [0.07, 0.07, 0.1] });
}

/** K2 / Altay family: sleek hull, angular wedge turret with a long autoloader / ammunition bustle. */
function mbtK2(b: Bld, altay: boolean) {
  // K2: 7.5 m hull, 3.6 m; 6 road wheels (in-arm hydropneumatic), KCPS sight, MMW radar, L/55.
  // Altay: 7 road wheels + 3 return rollers, blunter taller turret, big rear basket, SARP RWS.
  const B = b.body;
  running(b, {
    wheels: altay ? evenly(7, -0.37, 0.335) : evenly(6, -0.355, 0.32),
    rw: altay ? 0.047 : 0.053,
    spr: [-0.47, 0.106, 0.046],
    idl: [0.45, 0.096, 0.043],
    rollers: [
      [-0.2, 0.138, 0.013],
      [0.0, 0.138, 0.013],
      [0.2, 0.138, 0.013],
    ],
    gauge: 0.205,
    tw: 0.112,
    style: altay ? 'nato' : 'asia',
  });
  lowerHull(B, [[-0.5, 0.072], [0.43, 0.072], [0.548, 0.164], [-0.52, 0.164]], 0.148);
  B.side([[-0.53, 0.162], [0.55, 0.162], [0.575, 0.194], [0.31, 0.25], [-0.5, 0.253], [-0.53, 0.233]], 0.52, 0, CAMO, 0.008);
  skirts(B, [[-0.47, 0.098], [0.4, 0.098], [0.53, 0.13], [0.565, 0.205], [-0.48, 0.205]], 0.27, 0.016, altay ? [-0.32, -0.16, 0.0, 0.16, 0.32] : [-0.25, 0.0, 0.25]);
  for (const s of [-1, 1]) {
    B.box(1.0, 0.006, 0.028, 0.04, 0.205, s * 0.27, shade(b.base, 0.9));
    headlight(B, 0.56, 0.206, s * 0.225);
    taillight(B, -0.53, 0.233, s * 0.24);
    bin(B, 0.1, 0.035, 0.055, -0.42, 0.253, s * 0.225);
    grille(B, -0.33, 0.253, s * 0.13, 0.2, 0.1, 8);
    b.emit(-0.535, 0.215, s * 0.16);
  }
  hatch(B, 0.36, 0.236, altay ? 0 : 0.09, 0.032);
  for (const z of [-0.035, 0, 0.035]) periscope(B, 0.4, 0.229, (altay ? 0 : 0.09) + z, 0, 0.018);
  B.box(0.008, 0.045, 0.3, -0.532, 0.205, 0, K.black);
  teamPanel(B, 0.42, 0.022, 0.003, -0.08, 0.17, 0.279, b.team);
  teamPanel(B, 0.42, 0.022, 0.003, -0.08, 0.17, -0.279, b.team);
  cable(B, [[0.52, 0.215, -0.235], [0.3, 0.25, -0.22], [-0.1, 0.254, -0.23]]);

  // reference photos: the K2 turret sits well forward (mantlet ~0.2 hull lengths behind the nose) and is
  // tall and slab sided over a low hull; Altay's sits further back with a blunter face
  const T = b.part(B, altay ? -0.03 : 0.015, 0.253, 0, 'turret');
  const P0: P2[] = altay
    ? [[0.33, 0], [0.32, 0.07], [0.21, 0.19], [0.1, 0.23], [-0.15, 0.234], [-0.3, 0.22], [-0.46, 0.195], [-0.47, 0]]
    : [[0.32, 0], [0.31, 0.065], [0.22, 0.155], [0.12, 0.222], [-0.12, 0.228], [-0.25, 0.218], [-0.44, 0.19], [-0.452, 0]];
  const h = altay ? 0.125 : 0.126;
  hloft(T, [
    { y: -0.004, h: sz(P0, 0.93) },
    { y: 0.02, h: P0 },
    { y: h * 0.62, h: sz(slopeF(P0, 0.1, -0.008), 0.985) },
    { y: h, h: sz(slopeF(P0, 0.1, altay ? -0.05 : -0.075), 0.92) },
  ]);
  T.cy(0.19, 0.19, 0.012, 0, -0.012, 0, K.dark, 20);
  // armour-module seams on the wedge faces
  for (const s of [-1, 1]) {
    for (let i = 1; i < 3; i++) {
      const t = i / 3;
      const [ax, az] = altay ? [0.32 - 0.11 * t, 0.07 + 0.12 * t] : [0.31 - 0.09 * t, 0.065 + 0.09 * t];
      T.box(0.004, h * 0.6, 0.004, ax + 0.003, 0.02 + h * 0.3, s * (az + 0.003), K.dark);
    }
    // MMW radar / laser warning sensors (KAPS) on the front roof corners
    T.cbox(0.03, 0.03, 0.03, 0.004, altay ? 0.19 : 0.2, h + 0.012, s * (altay ? 0.16 : 0.13), 0x3a3d40);
    T.box(0.004, 0.02, 0.022, (altay ? 0.19 : 0.2) + 0.016, h + 0.012, s * (altay ? 0.16 : 0.13), GLASS);
    smokeBank(T, altay ? 0.0 : 0.04, h * 0.78, s * (altay ? 0.236 : 0.228), s, 4, 1.25, 0.008);
    T.cbox(0.16, 0.045, 0.02, 0.005, -0.29, 0.05, s * (altay ? 0.21 : 0.2), CAMO);
    teamPanel(T, 0.13, 0.02, 0.003, -0.08, h * 0.45, s * (altay ? 0.236 : 0.23), b.team);
  }
  coax(T, 0.315, 0.04, 0.05);
  for (let i = 0; i < 3; i++) lid(T, 0.06, 0.22, -0.25 - i * 0.065, h, 0);
  if (altay) {
    rack(T, -0.56, -0.47, -0.19, 0.19, 0.02, 0.075, 6);
    T.cbox(0.07, 0.06, 0.16, 0.012, -0.515, 0.06, 0.07, K.canvas);
    teamPanel(T, 0.004, 0.024, 0.28, -0.563, 0.06, 0, b.team);
  } else {
    T.cbox(0.04, 0.05, 0.28, 0.008, -0.465, 0.05, 0, CAMO);
    teamPanel(T, 0.004, 0.022, 0.24, -0.486, 0.05, 0, b.team);
  }
  // roof: gunner sight (left front), commander panoramic sight (right), RWS, loader hatch
  T.cbox(0.07, 0.04, 0.05, 0.006, 0.1, h + 0.018, -0.12, CAMO);
  T.box(0.004, 0.024, 0.036, 0.136, h + 0.02, -0.12, GLASS);
  panoSight(T, altay ? -0.12 : 0.02, h, 0.13, altay ? 0.06 : 0.045, 1.0);
  rws(T, -0.12, h, altay ? 0.05 : 0.08, 0.9, true);
  hatch(T, -0.06, h, -0.1, 0.035);
  antennas(b, T, altay ? -0.38 : -0.36, h, [-0.15, 0.15], 0.24);
  // L/55 120 mm: K2 10.8 m gun forward vs 7.5 m hull (3.3 m overhang), Altay 10.3 m vs 7.3 m (3.0 m)
  // (both fume extractors sit just ahead of the mantlet)
  mainGun(b, T, 0.31, 0.058, 0, { len: altay ? 0.7 : 0.72, r: 0.0145, fume: altay ? 0.2 : 0.14, mrs: true, mantlet: [0.06, 0.062, 0.1] });
}

function mbt(style: ModelStyle, fog: FogOfWar | null): Model {
  const f = style.faction;
  const fn = MBT[f] ?? mbtAbrams;
  return build('mbt', style, fog, fn);
}

const MBT: Record<string, (b: Bld) => void> = {
  usa: mbtAbrams,
  israel: mbtMerkava,
  germany: mbtLeopard,
  russia: mbtT90,
  ukraine: mbtOplot,
  iran: mbtKarrar,
  china: mbtType99,
  korea: (b) => mbtK2(b, false),
  turkey: (b) => mbtK2(b, true),
};


// ================================================================ IFVs / APCs

/** Standard light tracked running gear (IFV / SPAAG). */
function lightTracks(b: Bld, o: { n: number; x0: number; x1: number; rw?: number; front?: boolean; gauge?: number; tw?: number; style?: WheelStyle; rollers?: number; sag?: number; idlUp?: number }) {
  const rw = o.rw ?? 0.048;
  const bt = 0.015;
  const wy = rw + bt;
  const sx = o.front ? o.x1 + rw + 0.045 : o.x0 - rw - 0.05;
  const ix = o.front ? o.x0 - rw - 0.045 : o.x1 + rw + 0.04;
  const nr = o.rollers ?? 3;
  const rollers: V3[] = [];
  for (let i = 0; i < nr; i++) rollers.push([o.x0 + ((o.x1 - o.x0) * (i + 0.5)) / nr, wy + rw + 0.024, 0.013]);
  running(b, {
    wheels: evenly(o.n, o.x0, o.x1),
    rw,
    spr: [sx, wy + 0.04, 0.044],
    idl: [ix, wy + (o.idlUp ?? 0.03), 0.04],
    rollers: nr ? rollers : undefined,
    gauge: o.gauge ?? 0.225,
    tw: o.tw ?? 0.12,
    bt,
    style: o.style ?? 'nato',
    sag: o.sag,
  });
}

/** Rear ramp / door outline with a team panel on the rear plate at x. */
function rearRamp(B: Part, x: number, y0: number, y1: number, w: number, team: number, doors = 1) {
  if (B.b.key === 'apc') return troopRamp(B, x, y0, y1, w, team, doors);
  B.box(0.006, y1 - y0, w, x - 0.002, (y0 + y1) / 2, 0, K.dark);
  if (doors === 1) B.box(0.006, y1 - y0 - 0.012, w - 0.014, x, (y0 + y1) / 2, 0, CAMO);
  else for (const s of [-1, 1]) B.box(0.006, y1 - y0 - 0.012, w / 2 - 0.012, x, (y0 + y1) / 2, (s * w) / 4, CAMO);
  B.box(0.004, 0.022, w * 0.6, x + 0.003 * Math.sign(x) * -1 + (x < 0 ? -0.004 : 0.004), y1 - 0.025, 0, team);
  for (const s of [-1, 1]) B.box(0.008, 0.024, 0.008, x + (x < 0 ? -0.004 : 0.004), (y0 + y1) / 2, (s * w) / 2.6, mt(K.steel));
}

/**
 * Troop transport's working rear door(s), tagged 'ramp' (userData.axis / open = the hinge axis and open angle;
 * the instance animation eases them with AnimState.ramp). One door = a ramp hinged at its bottom edge that
 * drops to the ground; two doors = leaves hinged at the outer edges that swing out to the sides.
 * Behind them: a dark troop compartment with benches and a lit interior.
 */
function troopRamp(B: Part, x: number, y0: number, y1: number, w: number, team: number, doors: number) {
  const b = B.b;
  const h = y1 - y0;
  // compartment opening: dark recess, side benches, red interior lamp
  B.box(0.006, h, w, x + 0.006, (y0 + y1) / 2, 0, K.black);
  B.box(0.004, 0.006, w + 0.006, x - 0.001, y1 + 0.002, 0, K.dark);
  B.box(0.004, 0.006, w + 0.006, x - 0.001, y0 - 0.002, 0, K.dark);
  for (const s of [-1, 1]) {
    B.box(0.004, h + 0.008, 0.006, x - 0.001, (y0 + y1) / 2, (s * (w + 0.006)) / 2, K.dark);
    B.box(0.01, 0.018, 0.004, x + 0.005, y0 + h * 0.35, s * w * 0.38, K.olive);
  }
  B.box(0.003, 0.008, 0.02, x + 0.004, y1 - 0.012, 0, 0x8a2c1e);
  if (doors === 1) {
    const R = b.part(B, x - 0.004, y0, 0, 'ramp');
    R.g.userData.axis = 'z';
    // drop to the ground (hinge height y0, ramp length h): rotate past horizontal until the lip touches
    R.g.userData.open = Math.min(2.25, Math.acos(Math.max(-1, Math.min(1, -y0 / h))));
    R.box(0.008, h - 0.004, w - 0.01, 0, h / 2, 0, CAMO);
    R.box(0.003, 0.022, w * 0.6, -0.005, h - 0.025, 0, team);
    for (let i = 0; i < 4; i++) R.box(0.003, 0.004, w - 0.04, 0.0055, 0.03 + i * (h - 0.05) / 3, 0, 0x34362e); // inside treads (seen when down)
    for (const s of [-1, 1]) R.box(0.008, 0.024, 0.008, -0.005, h / 2, (s * w) / 2.6, K.steel);
  } else {
    for (const s of [-1, 1]) {
      const D = b.part(B, x - 0.004, (y0 + y1) / 2, (s * w) / 2, 'ramp');
      D.g.userData.axis = 'y';
      D.g.userData.open = s * 1.85;
      const lw = w / 2 - 0.004;
      D.box(0.008, h - 0.006, lw, 0, 0, (-s * lw) / 2, CAMO);
      D.box(0.003, 0.022, lw * 0.7, -0.005, h / 2 - 0.025, (-s * lw) / 2, team);
      D.box(0.008, 0.024, 0.008, -0.005, 0, -s * lw * 0.8, K.steel);
    }
  }
}

/** Small two-man / unmanned IFV turret base; returns the turret part. */
function ifvTurret(b: Bld, parent: Part, x: number, y: number, z: number, half: P2[], h: number, ins = 0.02) {
  const T = b.part(parent, x, y, z, 'turret');
  const plan = mirrorZ(half);
  T.loft([{ y: 0, p: plan }, { y: h, p: inset(plan, ins) }], CAMO);
  return T;
}

/** ATGM twin launcher box (TOW / Spike / Kornet). */
function atgmBox(T: Part, x: number, y: number, z: number, len = 0.16, tubes = 2, w = 0.05) {
  T.cbox(len, 0.06, w, 0.006, x, y, z, CAMO);
  for (let i = 0; i < tubes; i++) {
    const zz = z + (tubes === 1 ? 0 : (i - (tubes - 1) / 2) * (w * 0.48));
    T.cx(0.013, 0.013, 0.006, x + len / 2 + 0.001, y, zz, K.black, 8);
  }
  T.box(0.02, 0.03, 0.02, x - len * 0.2, y - 0.04, z + Math.sign(z || 1) * -0.02, K.dark);
}

function apcBradley(b: Bld) {
  const B = b.body;
  lightTracks(b, { n: 6, x0: -0.31, x1: 0.28, rw: 0.05, front: true, style: 'nato' });
  B.side([[-0.44, 0.06], [0.33, 0.06], [0.43, 0.15], [-0.46, 0.15]], 0.33, 0, CAMO, 0.008);
  B.side(
    [
      [-0.47, 0.15],
      [0.43, 0.15],
      [0.475, 0.19],
      [0.3, 0.275],
      [-0.45, 0.28],
      [-0.47, 0.26],
    ],
    0.58,
    0,
    CAMO,
    0.008,
  );
  // BUSK / BRAT armour tiles on the skirts
  for (const s of [-1, 1]) {
    B.box(0.88, 0.09, 0.012, -0.01, 0.15, s * 0.296, CAMO);
    for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) B.cbox(0.1, 0.042, 0.018, 0.004, -0.4 + i * 0.112, 0.128 + j * 0.046, s * 0.31, CAMO);
    headlight(B, 0.465, 0.215, s * 0.24, 0.9);
    taillight(B, -0.47, 0.255, s * 0.25);
  }
  // BRAT reactive tiles in a grid over the upper glacis (M2A3 reference photos)
  bricks(B, slopePlane([0.3, 0.276], [0.475, 0.191], 0), 0.012, 0.18, -0.25, 0.25, 3, 5, 0.014, 0.008);
  grille(B, 0.2, 0.268, 0.17, 0.1, 0.14, 6);
  B.box(0.04, 0.02, 0.05, 0.12, 0.29, 0.24, K.black);
  b.emit(0.12, 0.3, 0.24);
  hatch(B, 0.25, 0.27, -0.16, 0.032);
  for (const z of [-0.2, -0.12]) periscope(B, 0.3, 0.266, z, 0, 0.018);
  rearRamp(B, -0.472, 0.08, 0.25, 0.32, b.team);
  hatch(B, -0.34, 0.28, 0, 0.05);
  for (const s of [-1, 1]) bin(B, 0.08, 0.04, 0.05, -0.4, 0.28, s * 0.24, CAMO);
  const T = ifvTurret(b, B, -0.05, 0.28, 0.04, [[0.18, 0], [0.17, 0.11], [0.1, 0.16], [-0.17, 0.16], [-0.21, 0.12], [-0.21, 0]], 0.095);
  T.cy(0.15, 0.15, 0.01, 0, -0.008, 0, K.dark, 16);
  T.cbox(0.06, 0.06, 0.07, 0.008, 0.18, 0.045, 0.02, CAMO);
  cannon(b, T, 0.2, 0.045, 0.02, 0.3, 0.008, { shroud: 0.25 });
  T.cx(0.004, 0.004, 0.06, 0.24, 0.05, 0.06, mt(K.dark), 5);
  atgmBox(T, -0.02, 0.06, -0.2, 0.2, 2, 0.07);
  teamPanel(T, 0.002, 0.03, 0.06, 0.081, 0.06, -0.2, b.team);
  // commander independent viewer + sight
  T.cy(0.018, 0.022, 0.03, -0.08, 0.095, 0.08, K.dark, 10);
  T.cbox(0.05, 0.035, 0.045, 0.006, -0.08, 0.14, 0.08, CAMO);
  T.box(0.004, 0.02, 0.03, -0.054, 0.142, 0.08, GLASS);
  T.cbox(0.05, 0.03, 0.04, 0.005, 0.1, 0.11, -0.08, CAMO);
  T.box(0.004, 0.018, 0.03, 0.126, 0.11, -0.08, GLASS);
  hatch(T, -0.08, 0.095, -0.05, 0.03);
  for (const s of [-1, 1]) smokeBank(T, 0.13, 0.07, 0.02 + s * 0.15, s, 4, 0.9, 0.008);
  teamPanel(T, 0.14, 0.022, 0.003, -0.04, 0.05, 0.161, b.team);
  antennas(b, T, -0.18, 0.095, [-0.1, 0.12], 0.2);
}

function apcNamer(b: Bld) {
  const B = b.body;
  running(b, {
    wheels: evenly(6, -0.37, 0.31),
    rw: 0.056,
    spr: [0.465, 0.115, 0.05],
    idl: [-0.47, 0.1, 0.047],
    rollers: [
      [-0.2, 0.15, 0.015],
      [0.0, 0.152, 0.015],
      [0.2, 0.152, 0.015],
    ],
    gauge: 0.243,
    tw: 0.13,
    style: 'merk',
  });
  lowerHull(B, [[-0.52, 0.065], [0.42, 0.065], [0.55, 0.17], [-0.55, 0.17]], 0.172);
  // front engine glacis, tall troop superstructure (reference photos: the flat roof runs forward to ~0.35,
  // then a shallow glacis drops to a high, blunt nose)
  B.side(
    [
      [-0.55, 0.17],
      [0.56, 0.17],
      [0.595, 0.2],
      [0.59, 0.258],
      [0.36, 0.33],
      [-0.52, 0.335],
      [-0.55, 0.3],
    ],
    0.6,
    0,
    CAMO,
    0.012,
  );
  skirts(B, [[-0.5, 0.1], [0.36, 0.1], [0.5, 0.13], [0.585, 0.2], [0.58, 0.215], [-0.52, 0.215]], 0.322, 0.016, [-0.33, -0.15, 0.03, 0.2, 0.37]);
  // superstructure side armour modules
  for (const s of [-1, 1]) {
    B.cbox(0.86, 0.07, 0.02, 0.006, -0.09, 0.27, s * 0.3, CAMO);
    for (const x of [-0.42, -0.27, -0.12, 0.03, 0.18]) B.box(0.004, 0.06, 0.004, x, 0.27, s * 0.311, K.dark);
    headlight(B, 0.57, 0.205, s * 0.27);
    taillight(B, -0.555, 0.3, s * 0.27);
    trophy(B, 0.02, 0.31, s * 0.27, s, b.team);
  }
  grille(B, 0.42, 0.312, 0.13, 0.14, 0.16, 7);
  hatch(B, 0.29, 0.335, -0.14, 0.032);
  for (const z of [-0.18, -0.1]) periscope(B, 0.335, 0.333, z, 0, 0.018);
  rearRamp(B, -0.552, 0.11, 0.3, 0.34, b.team);
  for (const x of [-0.38, -0.2]) hatch(B, x, 0.335, 0.11, 0.035);
  for (let i = 0; i < 4; i++) periscope(B, -0.4 + i * 0.1, 0.335, -0.29, -Math.PI / 2, 0.018);
  cable(B, [[0.5, 0.27, 0.31], [0.3, 0.315, 0.3], [0.04, 0.315, 0.29]]);
  teamPanel(B, 0.3, 0.025, 0.003, -0.25, 0.25, 0.322, b.team);
  teamPanel(B, 0.3, 0.025, 0.003, -0.25, 0.25, -0.322, b.team);
  b.emit(0.3, 0.24, 0.32);
  // RWS (Samson) as the turret
  const T = b.part(B, -0.12, 0.335, -0.06, 'turret');
  T.cy(0.05, 0.055, 0.02, 0, 0, 0, K.dark, 12);
  T.cbox(0.11, 0.06, 0.1, 0.01, 0.0, 0.05, 0, CAMO);
  T.cbox(0.06, 0.04, 0.035, 0.006, 0.02, 0.06, -0.07, 0x3a3d40);
  T.box(0.004, 0.025, 0.024, 0.052, 0.062, -0.07, GLASS);
  T.box(0.08, 0.028, 0.028, 0.06, 0.06, 0.03, mt(K.gun));
  cannon(b, T, 0.1, 0.06, 0.03, 0.17, 0.0065, { brake: true });
  T.box(0.04, 0.035, 0.03, -0.02, 0.05, 0.07, K.olive);
  smokeBank(T, 0.02, 0.09, 0.0, 1, 4, 0.0, 0.008);
  antennas(b, B, -0.45, 0.335, [-0.2, 0.2], 0.22);
}

/** 8x8 wheeled hull: boxy body with sloped nose. Returns roof height. */
function wheeledHull(b: Bld, o: { L: number; W: number; y0: number; roof: number; nose: number; glacisX: number; rearSlope?: number; axles: Axle[]; r: number; tyreW?: number }) {
  const B = b.body;
  wheelSet(b, o.axles, o.r, o.tyreW ?? 0.075, o.W / 2 - (o.tyreW ?? 0.075) / 2 - 0.004);
  const L = o.L;
  B.side(
    [
      [-L / 2 + 0.02, o.y0],
      [o.nose - 0.06, o.y0],
      [o.nose, o.y0 + 0.08],
      [o.nose - 0.005, o.y0 + 0.1],
      [o.glacisX, o.roof],
      [-L / 2 + (o.rearSlope ?? 0.02), o.roof],
      [-L / 2, o.roof - 0.04],
      [-L / 2, o.y0 + 0.03],
    ],
    o.W - 0.16,
    0,
    CAMO,
    0.01,
  );
  // upper hull over the wheels (sponsons) with wheel arches cut by fenders
  B.side(
    [
      [-L / 2 + 0.01, o.y0 + 0.07],
      [o.nose - 0.02, o.y0 + 0.07],
      [o.nose - 0.005, o.y0 + 0.1],
      [o.glacisX, o.roof],
      [-L / 2 + (o.rearSlope ?? 0.02), o.roof],
      [-L / 2 + 0.005, o.roof - 0.04],
    ],
    o.W,
    0,
    CAMO,
    0.01,
  );
  for (const s of [-1, 1]) {
    for (const a of o.axles) {
      // wheel arch shadows
      B.box(o.r * 2.3, 0.012, 0.004, a.x, o.y0 + 0.068, s * (o.W / 2 + 0.002), K.dark);
    }
  }
  return o.roof;
}

function apcZBL08(b: Bld) {
  const B = b.body;
  const axles: Axle[] = [
    { x: 0.31, steer: 1 },
    { x: 0.16, steer: 0.6 },
    { x: -0.1, steer: 0 },
    { x: -0.25, steer: 0 },
  ];
  const roof = wheeledHull(b, { L: 0.98, W: 0.56, y0: 0.1, roof: 0.27, nose: 0.49, glacisX: 0.28, axles, r: 0.068 });
  for (const s of [-1, 1]) {
    headlight(B, 0.47, 0.2, s * 0.22, 0.9);
    taillight(B, -0.49, 0.24, s * 0.24);
    for (const x of [-0.35, -0.18, 0.0]) periscope(B, x, roof - 0.01, s * 0.27, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0.02);
    B.box(0.28, 0.006, 0.004, -0.18, 0.18, s * 0.281, K.dark);
  }
  // trim vane on the glacis, driver hatch, engine grille (front right)
  B.side([[0.43, 0.2], [0.47, 0.205], [0.4, 0.25], [0.38, 0.245]], 0.44, 0, CAMO, 0.004);
  hatch(B, 0.26, roof, -0.15, 0.03);
  grille(B, 0.25, roof, 0.14, 0.12, 0.14, 6);
  B.box(0.04, 0.02, 0.04, 0.18, roof + 0.012, 0.26, K.black);
  b.emit(0.18, roof + 0.03, 0.27);
  rearRamp(B, -0.492, 0.12, 0.25, 0.26, b.team, 2);
  hatch(B, -0.32, roof, 0.1, 0.03);
  hatch(B, -0.32, roof, -0.1, 0.03);
  teamPanel(B, 0.3, 0.024, 0.003, -0.2, 0.225, 0.281, b.team);
  teamPanel(B, 0.3, 0.024, 0.003, -0.2, 0.225, -0.281, b.team);
  const T = ifvTurret(b, B, -0.02, roof, 0, [[0.15, 0], [0.14, 0.1], [0.06, 0.15], [-0.14, 0.15], [-0.17, 0.1], [-0.17, 0]], 0.085);
  T.cbox(0.05, 0.055, 0.07, 0.008, 0.16, 0.04, 0, CAMO);
  cannon(b, T, 0.18, 0.04, 0.0, 0.3, 0.0085, { shroud: 0.2 });
  T.cx(0.004, 0.004, 0.05, 0.2, 0.05, 0.05, mt(K.dark), 5);
  atgmBox(T, -0.02, 0.105, -0.12, 0.13, 1, 0.035);
  T.cbox(0.05, 0.035, 0.04, 0.005, -0.06, 0.1, 0.08, CAMO);
  T.box(0.004, 0.02, 0.028, -0.034, 0.102, 0.08, GLASS);
  for (const s of [-1, 1]) smokeBank(T, 0.06, 0.07, s * 0.14, s, 4, 0.9, 0.008);
  teamPanel(T, 0.12, 0.02, 0.003, -0.05, 0.045, 0.151, b.team);
  antennas(b, B, -0.42, roof, [-0.2, 0.2], 0.22);
}

function apcBMP3(b: Bld) {
  const B = b.body;
  lightTracks(b, { n: 6, x0: -0.32, x1: 0.3, rw: 0.05, front: false, style: 'sov', rollers: 3, sag: 0.008 });
  B.side([[-0.44, 0.06], [0.38, 0.06], [0.46, 0.14], [-0.46, 0.14]], 0.33, 0, CAMO, 0.008);
  // low front, raised rear engine deck
  B.side(
    [
      [-0.47, 0.14],
      [0.45, 0.14],
      [0.5, 0.17],
      [0.32, 0.225],
      [-0.1, 0.235],
      [-0.2, 0.26],
      [-0.45, 0.26],
      [-0.47, 0.235],
    ],
    0.6,
    0,
    CAMO,
    0.008,
  );
  // trim vane folded on the glacis, bow MGs
  B.side([[0.44, 0.17], [0.49, 0.175], [0.42, 0.215], [0.4, 0.21]], 0.46, 0, CAMO, 0.004);
  for (const s of [-1, 1]) {
    B.cy(0.022, 0.026, 0.02, 0.42, 0.16, s * 0.24, CAMO, 10);
    B.cx(0.004, 0.004, 0.06, 0.46, 0.175, s * 0.24, mt(K.dark), 5);
    headlight(B, 0.44, 0.2, s * 0.17, 0.9);
    taillight(B, -0.47, 0.245, s * 0.25);
    B.box(0.86, 0.006, 0.12, 0.0, 0.142, s * 0.245, CAMO);
    B.box(0.9, 0.05, 0.008, -0.01, 0.12, s * 0.306, 0x26282a);
  }
  // rear troop doors (in the engine deck) and roof hatches
  rearRamp(B, -0.472, 0.1, 0.235, 0.3, b.team, 2);
  for (const z of [-0.12, 0.12]) B.box(0.14, 0.006, 0.1, -0.36, 0.262, z, shade(b.base, 0.85));
  grille(B, -0.32, 0.26, 0, 0.1, 0.07, 5);
  B.box(0.05, 0.02, 0.03, -0.2, 0.24, -0.29, K.black);
  b.emit(-0.2, 0.25, -0.3);
  hatch(B, 0.3, 0.228, 0, 0.026);
  // OPVT snorkel tube stowed along the left of the roof (a BMP-3 signature)
  B.cx(0.016, 0.016, 0.36, -0.24, 0.278, -0.22, CAMO, 10);
  B.cx(0.02, 0.02, 0.05, -0.04, 0.278, -0.22, CAMO, 10);
  for (const x of [-0.38, -0.12]) B.box(0.012, 0.022, 0.03, x, 0.266, -0.22, K.dark);
  teamPanel(B, 0.36, 0.022, 0.003, -0.1, 0.2, 0.301, b.team);
  teamPanel(B, 0.36, 0.022, 0.003, -0.1, 0.2, -0.301, b.team);
  // turret: low dome with 100mm launcher-gun + coaxial 30mm
  const T = b.part(B, 0.05, 0.235, 0, 'turret');
  T.loft(
    [
      { y: 0, p: ell(16, 0.16, 0.17, -0.01, 1.05, 1.1) },
      { y: 0.05, p: ell(16, 0.15, 0.16, -0.01, 1.0, 1.05) },
      { y: 0.08, p: ell(16, 0.1, 0.11, -0.03) },
    ],
    CAMO,
    true,
  );
  T.cbox(0.06, 0.06, 0.1, 0.01, 0.16, 0.04, 0, CAMO);
  const g = b.part(T, 0.18, 0.05, 0);
  g.g.rotation.z = 0.03;
  const r100 = b.part(g, 0, 0, 0, 'recoil');
  // 2A70 100 mm gun-launcher: a long, slim barrel (~2.6 m out of the mantlet, reference photos), thicker breech
  r100.cx(0.016, 0.018, 0.08, 0.04, 0, 0, mt(K.gun), 12);
  r100.cx(0.0115, 0.0125, 0.3, 0.23, 0, 0, mt(K.gun), 12);
  r100.cx(0.0135, 0.0135, 0.02, 0.37, 0, 0, mt(K.gun), 12);
  r100.cx(0.008, 0.008, 0.004, 0.381, 0, 0, mt(K.black), 10);
  b.muzzle(r100, 0.385, 0, 0);
  cannon(b, T, 0.18, 0.05, 0.05, 0.27, 0.007, { brake: false });
  T.cx(0.004, 0.004, 0.05, 0.2, 0.04, -0.05, mt(K.dark), 5);
  T.cbox(0.05, 0.035, 0.04, 0.005, 0.04, 0.09, -0.08, CAMO);
  T.box(0.004, 0.02, 0.028, 0.066, 0.092, -0.08, GLASS);
  panoSight(T, -0.05, 0.08, 0.07, 0.02, 0.8);
  for (const s of [-1, 1]) smokeBank(T, 0.06, 0.06, s * 0.15, s, 3, 1.0, 0.008);
  teamPanel(T, 0.004, 0.02, 0.14, -0.175, 0.03, 0, b.team);
  antennas(b, T, -0.12, 0.07, [-0.12, 0.12], 0.2);
}

function apcPuma(b: Bld) {
  const B = b.body;
  lightTracks(b, { n: 6, x0: -0.33, x1: 0.3, rw: 0.05, front: true, style: 'nato', rollers: 3 });
  B.side([[-0.45, 0.06], [0.36, 0.06], [0.46, 0.16], [-0.47, 0.16]], 0.33, 0, CAMO, 0.008);
  B.side(
    [
      [-0.48, 0.16],
      [0.46, 0.16],
      [0.5, 0.2],
      [0.3, 0.29],
      [-0.46, 0.295],
      [-0.48, 0.27],
    ],
    0.58,
    0,
    CAMO,
    0.01,
  );
  // thick add-on side armour slabs with horizontal grooves
  for (const s of [-1, 1]) {
    B.side([[-0.46, 0.085], [0.38, 0.085], [0.48, 0.15], [0.49, 0.25], [-0.47, 0.25]], 0.035, s * 0.31, CAMO, 0.006);
    B.box(0.85, 0.004, 0.004, -0.04, 0.17, s * 0.329, K.dark);
    for (const x of [-0.25, 0.0, 0.25]) B.box(0.004, 0.16, 0.004, x, 0.165, s * 0.329, K.dark);
    headlight(B, 0.47, 0.235, s * 0.24, 0.9);
    taillight(B, -0.48, 0.27, s * 0.25);
  }
  grille(B, 0.24, 0.27, 0.15, 0.14, 0.12, 6);
  hatch(B, 0.3, 0.282, -0.14, 0.03);
  rearRamp(B, -0.482, 0.09, 0.27, 0.34, b.team);
  b.emit(0.2, 0.28, 0.3);
  teamPanel(B, 0.3, 0.025, 0.003, -0.2, 0.21, 0.329, b.team);
  teamPanel(B, 0.3, 0.025, 0.003, -0.2, 0.21, -0.329, b.team);
  // unmanned RCT30 turret: low angular box, 30mm with long shroud, Spike launcher left
  const T = ifvTurret(b, B, -0.06, 0.295, 0, [[0.2, 0], [0.19, 0.08], [0.13, 0.15], [-0.18, 0.15], [-0.22, 0.11], [-0.22, 0]], 0.075, 0.015);
  T.cbox(0.07, 0.05, 0.08, 0.008, 0.21, 0.035, 0, CAMO);
  cannon(b, T, 0.24, 0.035, 0, 0.34, 0.0085, { shroud: 0.32 });
  atgmBox(T, -0.04, 0.06, -0.19, 0.17, 2, 0.06);
  // panoramic sight and gunner sight
  panoSight(T, -0.1, 0.075, 0.08, 0.03, 0.9);
  T.cbox(0.05, 0.03, 0.04, 0.005, 0.1, 0.09, 0.09, CAMO);
  T.box(0.004, 0.018, 0.03, 0.126, 0.09, 0.09, GLASS);
  T.box(0.08, 0.025, 0.03, -0.02, 0.085, 0.0, mt(K.gun));
  for (const s of [-1, 1]) smokeBank(T, 0.14, 0.06, s * 0.13, s, 4, 0.9, 0.008);
  teamPanel(T, 0.14, 0.02, 0.003, -0.04, 0.04, 0.151, b.team);
  antennas(b, B, -0.4, 0.295, [-0.2, 0.2], 0.22);
}

function apcK21(b: Bld) {
  const B = b.body;
  lightTracks(b, { n: 6, x0: -0.32, x1: 0.29, rw: 0.05, front: true, style: 'asia', rollers: 3 });
  B.side([[-0.45, 0.06], [0.36, 0.06], [0.46, 0.15], [-0.47, 0.15]], 0.33, 0, CAMO, 0.008);
  B.side(
    [
      [-0.48, 0.15],
      [0.45, 0.15],
      [0.5, 0.18],
      [0.27, 0.27],
      [-0.46, 0.272],
      [-0.48, 0.25],
    ],
    0.58,
    0,
    CAMO,
    0.01,
  );
  // flotation bladder boxes over the skirts
  for (const s of [-1, 1]) {
    B.cbox(0.84, 0.05, 0.03, 0.012, -0.02, 0.2, s * 0.3, CAMO);
    B.box(0.84, 0.05, 0.006, -0.02, 0.135, s * 0.296, 0x26282a);
    headlight(B, 0.48, 0.2, s * 0.24, 0.9);
    taillight(B, -0.48, 0.25, s * 0.25);
  }
  grille(B, 0.2, 0.258, 0.15, 0.14, 0.12, 6);
  hatch(B, 0.28, 0.262, -0.14, 0.03);
  rearRamp(B, -0.482, 0.08, 0.25, 0.32, b.team);
  b.emit(0.18, 0.27, 0.27);
  teamPanel(B, 0.3, 0.024, 0.003, -0.2, 0.2, 0.317, b.team);
  teamPanel(B, 0.3, 0.024, 0.003, -0.2, 0.2, -0.317, b.team);
  // turret: 40mm gun with muzzle brake, two ATGM tubes
  const T = ifvTurret(b, B, -0.06, 0.272, 0, [[0.18, 0], [0.17, 0.09], [0.1, 0.16], [-0.17, 0.16], [-0.21, 0.11], [-0.21, 0]], 0.09);
  T.cbox(0.06, 0.06, 0.08, 0.008, 0.18, 0.045, 0, CAMO);
  cannon(b, T, 0.2, 0.045, 0, 0.33, 0.0105, { shroud: 0.18 });
  for (const s of [-1, 1]) {
    T.cx(0.015, 0.015, 0.16, 0.0, 0.1, s * 0.12, CAMO, 8);
    T.cx(0.011, 0.011, 0.004, 0.081, 0.1, s * 0.12, K.black, 8);
    smokeBank(T, 0.12, 0.07, s * 0.15, s, 4, 0.9, 0.008);
  }
  panoSight(T, -0.08, 0.09, 0.07, 0.025, 0.85);
  T.cbox(0.05, 0.03, 0.04, 0.005, 0.08, 0.105, -0.08, CAMO);
  T.box(0.004, 0.018, 0.03, 0.106, 0.105, -0.08, GLASS);
  teamPanel(T, 0.14, 0.02, 0.003, -0.05, 0.05, 0.161, b.team);
  antennas(b, T, -0.17, 0.09, [-0.11, 0.11], 0.2);
}

function apcBTR4(b: Bld) {
  const B = b.body;
  const axles: Axle[] = [
    { x: 0.3, steer: 1 },
    { x: 0.14, steer: 0.6 },
    { x: -0.07, steer: 0 },
    { x: -0.23, steer: 0 },
  ];
  wheelSet(b, axles, 0.066, 0.075, 0.24);
  // tall boxy hull, crew cab with armoured windscreen at the front
  B.side([[-0.47, 0.1], [0.42, 0.1], [0.48, 0.17], [-0.48, 0.17]], 0.4, 0, CAMO, 0.008);
  B.side(
    [
      [-0.48, 0.15],
      [0.46, 0.15],
      [0.49, 0.2],
      [0.42, 0.3],
      [0.32, 0.32],
      [-0.46, 0.32],
      [-0.48, 0.3],
    ],
    0.57,
    0,
    CAMO,
    0.01,
  );
  // windscreen armoured glass + shutters
  for (const s of [-1, 1]) {
    B.box(0.004, 0.05, 0.16, 0.452, 0.27, s * 0.12, GLASS, 0, 0, 0.6);
    B.box(0.06, 0.04, 0.004, 0.36, 0.27, s * 0.286, GLASS);
    B.box(0.03, 0.08, 0.004, 0.25, 0.23, s * 0.286, K.dark);
    headlight(B, 0.48, 0.2, s * 0.22, 0.9);
    taillight(B, -0.48, 0.29, s * 0.25);
    for (const a of axles) B.box(0.15, 0.012, 0.004, a.x, 0.148, s * 0.287, K.dark);
    jerry(B, -0.42, 0.32, s * 0.2);
  }
  B.box(0.06, 0.03, 0.03, -0.05, 0.31, -0.29, K.black);
  b.emit(-0.05, 0.32, -0.3);
  grille(B, 0.05, 0.32, -0.15, 0.14, 0.12, 6);
  rearRamp(B, -0.482, 0.15, 0.3, 0.26, b.team, 2);
  hatch(B, 0.38, 0.32, 0.12, 0.03);
  hatch(B, 0.38, 0.32, -0.12, 0.03);
  teamPanel(B, 0.36, 0.024, 0.003, -0.15, 0.27, 0.287, b.team);
  teamPanel(B, 0.36, 0.024, 0.003, -0.15, 0.27, -0.287, b.team);
  // Parus RWS turret: 30mm, grenade launcher, ATGM
  const T = b.part(B, -0.1, 0.32, 0, 'turret');
  T.cy(0.1, 0.11, 0.02, 0, 0, 0, K.dark, 14);
  T.cbox(0.2, 0.07, 0.15, 0.012, 0.0, 0.055, 0, CAMO);
  T.cbox(0.06, 0.05, 0.04, 0.006, 0.07, 0.11, -0.04, 0x3a3d40);
  T.box(0.004, 0.03, 0.03, 0.102, 0.112, -0.04, GLASS);
  cannon(b, T, 0.1, 0.055, 0.03, 0.3, 0.008, { shroud: 0.15 });
  atgmBox(T, -0.02, 0.07, -0.1, 0.17, 2, 0.05);
  smokeBank(T, 0.06, 0.08, 0.08, 1, 3, 0.9, 0.008);
  teamPanel(T, 0.12, 0.02, 0.003, -0.02, 0.05, 0.076, b.team);
  antennas(b, B, -0.4, 0.32, [-0.2, 0.2], 0.22);
}

function apcPars(b: Bld) {
  const B = b.body;
  const axles: Axle[] = [
    { x: 0.32, steer: 1 },
    { x: 0.15, steer: 0.6 },
    { x: -0.1, steer: -0.2 },
    { x: -0.27, steer: -0.4 },
  ];
  const roof = wheeledHull(b, { L: 1.0, W: 0.57, y0: 0.11, roof: 0.285, nose: 0.5, glacisX: 0.26, rearSlope: 0.06, axles, r: 0.07 });
  for (const s of [-1, 1]) {
    headlight(B, 0.48, 0.21, s * 0.22, 0.9);
    taillight(B, -0.495, 0.25, s * 0.24);
    B.cbox(0.3, 0.04, 0.02, 0.006, -0.18, 0.24, s * 0.29, CAMO);
    bin(B, 0.1, 0.035, 0.04, 0.05, 0.25, s * 0.29, CAMO);
  }
  B.box(0.04, 0.02, 0.04, 0.1, roof + 0.01, 0.25, K.black);
  b.emit(0.1, roof + 0.02, 0.26);
  hatch(B, 0.25, roof, -0.13, 0.03);
  for (const z of [-0.17, -0.09]) periscope(B, 0.28, roof - 0.006, z, 0, 0.018);
  rearRamp(B, -0.5, 0.13, 0.25, 0.28, b.team);
  teamPanel(B, 0.3, 0.024, 0.003, -0.18, 0.2, 0.287, b.team);
  teamPanel(B, 0.3, 0.024, 0.003, -0.18, 0.2, -0.287, b.team);
  const T = ifvTurret(b, B, -0.05, roof, 0, [[0.16, 0], [0.15, 0.09], [0.08, 0.14], [-0.15, 0.14], [-0.18, 0.1], [-0.18, 0]], 0.08);
  T.cbox(0.05, 0.05, 0.07, 0.008, 0.17, 0.04, 0, CAMO);
  cannon(b, T, 0.19, 0.04, 0, 0.3, 0.008, { shroud: 0.22 });
  atgmBox(T, -0.04, 0.06, 0.17, 0.15, 2, 0.05);
  panoSight(T, -0.08, 0.08, -0.07, 0.025, 0.85);
  T.cbox(0.05, 0.03, 0.04, 0.005, 0.08, 0.095, 0.06, CAMO);
  T.box(0.004, 0.018, 0.03, 0.106, 0.095, 0.06, GLASS);
  for (const s of [-1, 1]) smokeBank(T, 0.1, 0.065, s * 0.13, s, 4, 0.9, 0.008);
  teamPanel(T, 0.12, 0.02, 0.003, -0.05, 0.04, -0.141, b.team);
  antennas(b, B, -0.42, roof, [-0.2, 0.2], 0.22);
}

function apcBoragh(b: Bld) {
  const B = b.body;
  lightTracks(b, { n: 6, x0: -0.33, x1: 0.27, rw: 0.048, front: true, style: 'sov', rollers: 3, sag: 0.01 });
  B.side([[-0.44, 0.06], [0.3, 0.06], [0.44, 0.13], [-0.46, 0.13]], 0.33, 0, CAMO, 0.008);
  // BMP-1 style: long pointed ribbed nose, low hull
  B.side(
    [
      [-0.47, 0.13],
      [0.44, 0.13],
      [0.49, 0.15],
      [0.2, 0.235],
      [-0.44, 0.24],
      [-0.47, 0.22],
    ],
    0.56,
    0,
    CAMO,
    0.008,
  );
  const gp = slopePlane([0.2, 0.235], [0.49, 0.15], 0);
  for (let i = 0; i < 5; i++) B.add(new THREE.BoxGeometry(0.008, 0.01, 0.42), CAMO, gp.clone().multiply(TR(0.03 + i * 0.055, 0.004, 0)));
  for (const s of [-1, 1]) {
    B.box(0.88, 0.006, 0.12, -0.02, 0.132, s * 0.235, CAMO);
    headlight(B, 0.44, 0.17, s * 0.2, 0.85);
    taillight(B, -0.47, 0.23, s * 0.24);
    for (let i = 0; i < 4; i++) periscope(B, -0.36 + i * 0.07, 0.236, s * 0.2, s > 0 ? Math.PI / 2 : -Math.PI / 2, 0.016);
  }
  // two rear doors (BMP style bulged) and roof hatches
  for (const s of [-1, 1]) {
    B.cbox(0.03, 0.09, 0.13, 0.01, -0.475, 0.17, s * 0.08, CAMO);
    B.box(0.004, 0.02, 0.06, -0.493, 0.2, s * 0.08, b.team);
    for (const x of [-0.36, -0.22]) B.box(0.12, 0.006, 0.09, x + 0.04, 0.242, s * 0.12, shade(b.base, 0.85));
  }
  grille(B, 0.25, 0.205, -0.1, 0.1, 0.12, 5);
  hatch(B, 0.18, 0.236, -0.14, 0.026);
  B.box(0.05, 0.02, 0.03, 0.22, 0.19, 0.27, K.black);
  b.emit(0.22, 0.2, 0.28);
  // BMP-2 style turret: frustum, long 30mm, Konkurs launcher on the roof
  const T = b.part(B, 0.02, 0.24, 0, 'turret');
  T.loft(
    [
      { y: 0, p: ell(14, 0.15, 0.15) },
      { y: 0.075, p: ell(14, 0.1, 0.11, -0.01) },
    ],
    CAMO,
  );
  T.cbox(0.05, 0.05, 0.06, 0.008, 0.14, 0.035, 0, CAMO);
  cannon(b, T, 0.15, 0.04, 0, 0.36, 0.0075, { brake: false });
  T.cx(0.004, 0.004, 0.05, 0.17, 0.03, 0.04, mt(K.dark), 5);
  T.cx(0.014, 0.014, 0.17, 0.0, 0.11, 0.0, 0x4a5032, 8);
  T.box(0.02, 0.03, 0.02, -0.02, 0.085, 0, K.dark);
  hatch(T, -0.04, 0.075, -0.05, 0.028);
  hatch(T, -0.04, 0.075, 0.05, 0.028);
  for (const s of [-1, 1]) smokeBank(T, 0.03, 0.05, s * 0.12, s, 3, 1.1, 0.008);
  teamPanel(T, 0.004, 0.02, 0.1, -0.145, 0.03, 0, b.team);
  antennas(b, T, -0.09, 0.075, [-0.08, 0.08], 0.2);
}

function apc(style: ModelStyle, fog: FogOfWar | null): Model {
  const fn = APC[style.faction] ?? apcBradley;
  return build('apc', style, fog, fn);
}

const APC: Record<string, (b: Bld) => void> = {
  usa: apcBradley,
  israel: apcNamer,
  china: apcZBL08,
  russia: apcBMP3,
  germany: apcPuma,
  korea: apcK21,
  ukraine: apcBTR4,
  turkey: apcPars,
  iran: apcBoragh,
};


// ================================================================ air defence

/** Spinning radar head on a part: returns the spin part (rotates about Y). */
function spinRadar(b: Bld, p: Part, x: number, y: number, z: number, rate = 2.6) {
  p.cy(0.012, 0.016, 0.03, x, y, z, K.dark, 8);
  const r = b.part(p, x, y + 0.03, z);
  spinner(r.g, 'y', rate);
  return r;
}

/** Flat search radar antenna (planar array) on a spin part. */
function planarRadar(r: Part, w: number, h: number, tilt = 0.35) {
  r.box(0.02, 0.02, 0.03, 0, 0.01, 0, K.dark);
  r.cbox(0.014, h, w, 0.003, 0.008, 0.02 + h / 2, 0, 0x4a4e48, 0, 0, tilt);
  r.box(0.003, h * 0.84, w * 0.9, 0.016, 0.02 + h / 2, 0, 0x2a2c2a, 0, 0, tilt);
}

/** Parabolic dish facing +X (axis along X) on a part. */
function dishX(p: Part, x: number, y: number, z: number, R: number, paint = 0x8a8e88, deep = 0.35) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector2(Math.max(0.001, R * t), R * deep * t * t));
  }
  const g = new THREE.LatheGeometry(pts, 16).rotateZ(Math.PI / 2);
  p.add(g, paint, TR(x, y, z));
  // back side (lathe is single-sided)
  const g2 = new THREE.LatheGeometry(pts.slice().reverse(), 16).rotateZ(Math.PI / 2);
  p.add(g2, shade(paint, 0.7), TR(x - 0.002, y, z));
  p.cx(0.004, 0.004, R * 0.7, x + R * 0.35 - R * deep, y, z, K.dark, 4);
  p.sph(R * 0.12, x + R * 0.7 - R * deep, y, z, K.dark, 6, 4);
}

/** Twin outboard autocannons (Gepard style) on a turret: each side a recoiling barrel. */
function twinGuns(b: Bld, T: Part, x: number, y: number, zs: number[], len: number, r: number, housing = true) {
  for (const z of zs) {
    if (housing) T.cbox(0.16, 0.06, 0.05, 0.008, x - 0.06, y, z, CAMO);
    cannon(b, T, x + 0.02, y + 0.005, z, len, r, { shroud: 0.18 });
  }
}

function aaGepard(b: Bld, chinese = false, korean = false, turkish = false) {
  const B = b.body;
  if (korean || turkish) lightTracks(b, { n: 5, x0: -0.3, x1: 0.26, rw: 0.052, front: true, style: 'nato' });
  else
    running(b, {
      wheels: evenly(chinese ? 6 : 7, -0.36, 0.32),
      rw: chinese ? 0.056 : 0.05,
      spr: [-0.465, 0.11, 0.05],
      idl: [0.445, 0.1, 0.045],
      rollers: [
        [-0.2, 0.14, 0.015],
        [0.0, 0.14, 0.015],
        [0.2, 0.14, 0.015],
      ],
      gauge: 0.24,
      tw: 0.125,
      style: chinese ? 'asia' : 'nato',
    });
  const L = korean || turkish ? 0.9 : 1.0;
  B.side([[-L / 2 + 0.03, 0.06], [L / 2 - 0.1, 0.06], [L / 2 - 0.02, 0.165], [-L / 2, 0.165]], 0.33, 0, CAMO, 0.008);
  B.side(
    [
      [-L / 2, 0.165],
      [L / 2 - 0.02, 0.165],
      [L / 2 + 0.01, 0.2],
      [L / 2 - 0.18, 0.25],
      [-L / 2 + 0.03, 0.255],
      [-L / 2, 0.235],
    ],
    0.6,
    0,
    CAMO,
    0.008,
  );
  skirts(B, [[-L / 2 + 0.03, 0.1], [L / 2 - 0.08, 0.1], [L / 2, 0.15], [L / 2, 0.2], [-L / 2 + 0.02, 0.2]], 0.31, 0.01, [-0.2, 0.0, 0.2]);
  for (const s of [-1, 1]) {
    headlight(B, L / 2, 0.215, s * 0.25, 0.9);
    taillight(B, -L / 2, 0.235, s * 0.27);
    b.emit(-L / 2 - 0.005, 0.22, s * 0.18);
  }
  grille(B, -L / 2 + 0.12, 0.255, 0, 0.14, 0.3, 7);
  hatch(B, L / 2 - 0.15, 0.24, 0.12, 0.03);
  teamPanel(B, 0.4, 0.024, 0.003, -0.05, 0.16, 0.316, b.team);
  teamPanel(B, 0.4, 0.024, 0.003, -0.05, 0.16, -0.316, b.team);
  // big box turret
  const T = b.part(B, -0.06, 0.255, 0, 'turret');
  const plan = mirrorZ([[0.22, 0], [0.22, 0.14], [0.16, 0.19], [-0.2, 0.19], [-0.26, 0.15], [-0.26, 0]]);
  T.loft([{ y: 0, p: plan }, { y: 0.13, p: inset(plan, 0.012) }], CAMO);
  T.cy(0.2, 0.2, 0.012, 0, -0.01, 0, K.dark, 18);
  const gz = turkish ? 0.215 : 0.225;
  twinGuns(b, T, 0.12, 0.08, [-gz, gz], korean ? 0.4 : 0.48, korean ? 0.008 : 0.0095);
  for (const s of [-1, 1]) T.box(0.08, 0.04, 0.02, 0.0, 0.08, s * (gz - 0.03), K.dark);
  // tracking radar (front) + search radar (rotating, rear)
  if (chinese || turkish) {
    T.cbox(0.06, 0.07, 0.12, 0.01, 0.22, 0.09, 0, 0x4a4e48);
    T.box(0.004, 0.05, 0.09, 0.252, 0.09, 0, 0x2a2c2a);
  } else {
    dishX(T, 0.22, 0.14, 0, 0.06, 0x7a7e78, 0.3);
    T.box(0.04, 0.02, 0.03, 0.2, 0.135, 0, K.dark);
  }
  const R = spinRadar(b, T, -0.16, 0.13, 0, 2.4);
  if (korean) planarRadar(R, 0.18, 0.07, 0.2);
  else {
    R.box(0.02, 0.03, 0.03, 0, 0.015, 0, K.dark);
    R.cbox(0.02, 0.06, 0.24, 0.004, 0.0, 0.07, 0, 0x5a5e58, 0, 0, 0.3);
    R.box(0.004, 0.045, 0.22, 0.012, 0.07, 0, 0x2a2c2a, 0, 0, 0.3);
  }
  // EO sight, hatches
  T.cbox(0.05, 0.04, 0.04, 0.005, 0.1, 0.15, 0.1, CAMO);
  T.box(0.004, 0.024, 0.03, 0.126, 0.15, 0.1, GLASS);
  hatch(T, -0.05, 0.13, 0.1, 0.03);
  hatch(T, -0.05, 0.13, -0.1, 0.03);
  for (const s of [-1, 1]) {
    smokeBank(T, 0.17, 0.09, s * 0.17, s, 4, 0.8, 0.008);
    teamPanel(T, 0.16, 0.022, 0.003, -0.08, 0.05, s * 0.19, b.team);
  }
  antennas(b, T, -0.24, 0.13, [-0.14, 0.14], 0.2);
}

/** Generic military truck chassis (cab at the front). Returns frame top height. */
function truck(b: Bld, o: { axles: Axle[]; r: number; W: number; cabX0: number; cabX1: number; frameX0: number; cabH?: number; armoured?: boolean; tyreW?: number }) {
  const B = b.body;
  const tw = o.tyreW ?? 0.07;
  wheelSet(b, o.axles, o.r, tw, o.W / 2 - tw / 2 - 0.004);
  const fy = o.r + 0.03;
  for (const s of [-1, 1]) B.box(o.cabX1 - o.frameX0, 0.04, 0.035, (o.cabX1 + o.frameX0) / 2, fy, s * o.W * 0.22, K.dark);
  B.box(o.cabX1 - o.frameX0 - 0.02, 0.01, o.W * 0.5, (o.cabX1 + o.frameX0) / 2, fy + 0.02, 0, K.dark);
  // mudguards over the wheels
  for (const a of o.axles) for (const s of [-1, 1]) B.box(o.r * 2.3, 0.008, tw + 0.02, a.x, o.r * 2 + 0.012, s * (o.W / 2 - tw / 2 - 0.004), K.dark);
  // cab
  const y0 = fy + 0.02;
  const h = o.cabH ?? 0.17;
  const x0 = o.cabX0;
  const x1 = o.cabX1;
  B.side(
    [
      [x0, y0],
      [x1, y0],
      [x1 + 0.005, y0 + h * 0.45],
      [x1 - 0.05, y0 + h],
      [x0, y0 + h],
    ],
    o.W - 0.01,
    0,
    CAMO,
    0.012,
  );
  const wl = Math.hypot(0.055, h * 0.5);
  const wa = Math.atan2(0.055, h * 0.5);
  for (const s of [-1, 1]) B.box(0.006, wl * 0.62, o.W / 2 - 0.07, x1 - 0.024, y0 + h * 0.74, (s * (o.W / 2 - 0.03)) / 2, GLASS, 0, 0, wa);
  B.box(0.008, wl * 0.66, 0.016, x1 - 0.023, y0 + h * 0.74, 0, CAMO, 0, 0, wa);
  for (const s of [-1, 1]) {
    B.box((x1 - x0) * 0.45, h * 0.3, 0.004, x1 - 0.08, y0 + h * 0.72, s * (o.W / 2 - 0.003), GLASS);
    headlight(B, x1 + 0.004, y0 + 0.045, s * (o.W / 2 - 0.05), 0.9);
    B.box(0.01, 0.04, 0.03, x1 - 0.06, y0 + h * 0.75, s * (o.W / 2 + 0.02), K.dark);
  }
  B.box(0.03, 0.04, o.W + 0.01, x1 + 0.014, y0 + 0.01, 0, K.dark);
  B.box(0.006, h * 0.25, o.W * 0.5, x1 + 0.004, y0 + h * 0.28, 0, K.dark);
  B.box(0.03, 0.008, o.W - 0.02, x0 + 0.04, y0 + h + 0.004, 0, K.dark);
  teamPanel(B, (x1 - x0) * 0.5, 0.02, o.W + 0.004, x0 + (x1 - x0) * 0.4, y0 + h * 0.4, 0, b.team);
  B.cy(0.01, 0.012, 0.1, x0 - 0.01, y0 + h * 0.4, o.W / 2 - 0.03, K.dark, 6);
  b.emit(x0 - 0.01, y0 + h * 0.4 + 0.1, o.W / 2 - 0.03);
  return y0;
}

function aaPantsir(b: Bld) {
  const B = b.body;
  const axles: Axle[] = [
    { x: 0.42, steer: 1 },
    { x: 0.26, steer: 0.6 },
    { x: -0.14, steer: 0 },
    { x: -0.3, steer: 0 },
  ];
  const fy = truck(b, { axles, r: 0.068, W: 0.52, cabX0: 0.33, cabX1: 0.55, frameX0: -0.5, cabH: 0.18 });
  // equipment body and turret platform
  B.cbox(0.3, 0.14, 0.5, 0.01, 0.15, fy + 0.07, 0, CAMO);
  B.box(0.62, 0.03, 0.5, -0.2, fy + 0.015, 0, CAMO);
  for (const s of [-1, 1]) B.box(0.04, 0.06, 0.04, -0.46, fy - 0.02, s * 0.2, K.dark);
  const T = b.part(B, -0.18, fy + 0.03, 0, 'turret');
  T.cy(0.16, 0.18, 0.04, 0, 0, 0, CAMO, 16);
  T.cbox(0.28, 0.16, 0.22, 0.014, -0.02, 0.12, 0, CAMO);
  // tracking radar (front, round), search radar (top, rotating)
  dishX(T, 0.12, 0.16, 0, 0.07, 0x6a6e66, 0.25);
  T.box(0.03, 0.08, 0.03, 0.1, 0.13, 0, K.dark);
  const R = spinRadar(b, T, -0.08, 0.18, 0, 2.0);
  planarRadar(R, 0.2, 0.08, 0.3);
  for (const s of [-1, 1]) {
    // 6 missile tubes per side + twin 30mm
    // (reference photos: the 57E6 containers are bare tubes, 2 rows x 3 per side, held by two clamp frames and
    // reaching well ahead of the turret face - the Pantsir's bristling silhouette)
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) T.cx(0.0165, 0.0165, 0.32, 0.0, 0.09 + i * 0.034, s * (0.13 + j * 0.034), 0x4e5634, 8);
    for (const x of [-0.12, 0.06]) T.box(0.014, 0.075, 0.112, x, 0.107, s * 0.164, 0x3e4430);
    for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) T.cx(0.012, 0.012, 0.004, 0.161, 0.09 + i * 0.034, s * (0.13 + j * 0.034), K.black, 6);
    T.cbox(0.12, 0.05, 0.05, 0.006, 0.05, 0.05, s * 0.12, CAMO);
    for (const dy of [-0.012, 0.012]) cannon(b, T, 0.1, 0.05 + dy, s * 0.12, 0.26, 0.0065, { brake: false });
    teamPanel(T, 0.12, 0.02, 0.003, -0.04, 0.09, s * 0.101, b.team);
  }
  antennas(b, B, 0.36, fy + 0.18, [-0.2, 0.2], 0.2);
}

function aaShilka(b: Bld) {
  const B = b.body;
  lightTracks(b, { n: 6, x0: -0.33, x1: 0.28, rw: 0.05, front: false, style: 'sov', rollers: 0, idlUp: 0.025 });
  B.side([[-0.44, 0.06], [0.33, 0.06], [0.44, 0.15], [-0.46, 0.15]], 0.33, 0, CAMO, 0.008);
  B.side([[-0.47, 0.15], [0.44, 0.15], [0.48, 0.18], [0.36, 0.23], [-0.45, 0.235], [-0.47, 0.21]], 0.58, 0, CAMO, 0.008);
  for (const s of [-1, 1]) {
    B.box(0.9, 0.006, 0.12, -0.01, 0.152, s * 0.235, CAMO);
    headlight(B, 0.46, 0.195, s * 0.22, 0.85);
    taillight(B, -0.47, 0.22, s * 0.25);
    bin(B, 0.14, 0.04, 0.06, 0.25, 0.152, s * 0.26, CAMO);
  }
  grille(B, -0.37, 0.235, 0, 0.12, 0.3, 6);
  B.box(0.008, 0.04, 0.3, -0.472, 0.19, 0, K.black);
  b.emit(-0.48, 0.19, 0.1);
  teamPanel(B, 0.004, 0.025, 0.2, -0.474, 0.22, 0, b.team);
  // wide flat turret, four 23mm guns, round radar dish on the rear mast
  const T = b.part(B, -0.02, 0.235, 0, 'turret');
  const plan = mirrorZ([[0.26, 0], [0.26, 0.17], [0.22, 0.24], [-0.24, 0.24], [-0.28, 0.2], [-0.28, 0]]);
  T.loft([{ y: 0, p: plan }, { y: 0.11, p: inset(plan, 0.012) }], CAMO);
  T.cbox(0.06, 0.08, 0.2, 0.01, 0.27, 0.06, 0, CAMO);
  for (const z of [-0.055, 0.055]) for (const y of [0.04, 0.085]) cannon(b, T, 0.29, y, z, 0.24, 0.0055, { brake: true });
  T.box(0.012, 0.06, 0.34, 0.265, 0.045, 0, K.dark);
  T.cy(0.012, 0.014, 0.08, -0.2, 0.11, 0, K.dark, 8);
  const R = b.part(T, -0.2, 0.19, 0);
  spinner(R.g, 'y', 1.6);
  dishX(R, 0.0, 0.05, 0, 0.075, 0x8a8e84, 0.35);
  R.box(0.03, 0.05, 0.03, -0.02, 0.025, 0, K.dark);
  for (const s of [-1, 1]) {
    T.box(0.36, 0.006, 0.004, -0.02, 0.06, s * 0.236, K.dark);
    teamPanel(T, 0.16, 0.022, 0.003, -0.08, 0.08, s * 0.237, b.team);
    T.cbox(0.06, 0.04, 0.04, 0.005, 0.1, 0.13, s * 0.13, CAMO);
  }
  hatch(T, -0.06, 0.11, 0.12, 0.03);
  antennas(b, T, -0.24, 0.11, [-0.18, 0.18], 0.2);
}

function m113Hull(b: Bld) {
  const B = b.body;
  lightTracks(b, { n: 5, x0: -0.3, x1: 0.25, rw: 0.052, front: true, style: 'light', rollers: 0, idlUp: 0.02 });
  B.side([[-0.44, 0.06], [0.33, 0.06], [0.43, 0.15], [-0.46, 0.15]], 0.33, 0, CAMO, 0.008);
  B.side([[-0.46, 0.13], [0.42, 0.13], [0.46, 0.17], [0.3, 0.29], [-0.44, 0.295], [-0.46, 0.28]], 0.56, 0, CAMO, 0.01);
  for (const s of [-1, 1]) {
    B.box(0.88, 0.04, 0.008, -0.02, 0.12, s * 0.284, 0x26282a);
    headlight(B, 0.44, 0.2, s * 0.22, 0.85);
    taillight(B, -0.46, 0.27, s * 0.24);
  }
  B.side([[0.38, 0.18], [0.44, 0.182], [0.36, 0.25], [0.33, 0.245]], 0.4, 0, CAMO, 0.004);
  rearRamp(B, -0.462, 0.09, 0.27, 0.32, b.team);
  B.box(0.04, 0.03, 0.03, 0.3, 0.28, 0.24, K.black);
  b.emit(0.3, 0.3, 0.25);
  teamPanel(B, 0.36, 0.024, 0.003, -0.12, 0.23, 0.281, b.team);
  teamPanel(B, 0.36, 0.024, 0.003, -0.12, 0.23, -0.281, b.team);
  return 0.295;
}

function aaMachbet(b: Bld) {
  const B = b.body;
  const top = m113Hull(b);
  hatch(B, 0.28, top - 0.01, -0.14, 0.03);
  const T = b.part(B, -0.08, top, 0, 'turret');
  T.cy(0.13, 0.14, 0.03, 0, 0, 0, CAMO, 14);
  T.cbox(0.18, 0.1, 0.16, 0.012, -0.01, 0.08, 0, CAMO);
  // M61 Vulcan (six barrels) on the right, Stinger quad pod on the left
  const vul = b.part(T, 0.1, 0.07, 0.11, 'recoil');
  vul.cx(0.022, 0.024, 0.06, 0.0, 0, 0, mt(K.gun), 10);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    vul.cx(0.004, 0.004, 0.28, 0.16, Math.cos(a) * 0.012, Math.sin(a) * 0.012, mt(K.dark), 5);
  }
  vul.cx(0.017, 0.017, 0.01, 0.25, 0, 0, mt(K.gun), 10);
  b.muzzle(vul, 0.31, 0, 0);
  T.box(0.08, 0.06, 0.06, 0.02, 0.07, 0.11, CAMO);
  const pod = b.part(T, 0.0, 0.1, -0.12);
  pod.g.rotation.z = 0.2;
  pod.cbox(0.2, 0.08, 0.08, 0.008, 0.02, 0.0, 0, CAMO);
  for (const y of [-0.019, 0.019]) for (const z of [-0.019, 0.019]) pod.cx(0.014, 0.014, 0.004, 0.122, y, z, K.black, 8);
  b.muzzle(pod, 0.13, 0, 0);
  T.cbox(0.05, 0.04, 0.04, 0.005, 0.05, 0.15, 0.0, CAMO);
  T.box(0.004, 0.024, 0.03, 0.076, 0.15, 0.0, GLASS);
  const R = spinRadar(b, T, -0.08, 0.13, 0, 2.2);
  planarRadar(R, 0.12, 0.05, 0.3);
  teamPanel(T, 0.12, 0.022, 0.003, -0.02, 0.06, 0.081, b.team);
  antennas(b, B, -0.4, top, [-0.2, 0.2], 0.2);
}

/** Boxer 8x8 drive module + mission module. Returns roof height. */
function boxerHull(b: Bld) {
  const B = b.body;
  const axles: Axle[] = [
    { x: 0.36, steer: 1 },
    { x: 0.18, steer: 0.6 },
    { x: -0.1, steer: 0 },
    { x: -0.28, steer: 0 },
  ];
  const roof = wheeledHull(b, { L: 1.04, W: 0.58, y0: 0.11, roof: 0.3, nose: 0.52, glacisX: 0.3, rearSlope: 0.03, axles, r: 0.074, tyreW: 0.08 });
  // mission module seam and side armour
  for (const s of [-1, 1]) {
    B.box(0.004, 0.15, 0.004, 0.1, 0.22, s * 0.292, K.dark);
    B.box(0.7, 0.004, 0.004, -0.12, 0.27, s * 0.292, K.dark);
    headlight(B, 0.5, 0.22, s * 0.23, 0.9);
    taillight(B, -0.52, 0.27, s * 0.25);
  }
  grille(B, 0.3, roof, -0.1, 0.12, 0.16, 6);
  hatch(B, 0.36, roof - 0.02, 0.14, 0.03);
  B.box(0.05, 0.02, 0.04, 0.2, roof + 0.01, -0.25, K.black);
  b.emit(0.2, roof + 0.02, -0.26);
  rearRamp(B, -0.522, 0.14, 0.28, 0.3, b.team);
  teamPanel(B, 0.36, 0.024, 0.003, -0.15, 0.24, 0.292, b.team);
  teamPanel(B, 0.36, 0.024, 0.003, -0.15, 0.24, -0.292, b.team);
  return roof;
}

function aaSkyranger(b: Bld) {
  const B = b.body;
  const roof = boxerHull(b);
  const T = b.part(B, -0.12, roof, 0, 'turret');
  T.cy(0.15, 0.16, 0.02, 0, 0, 0, K.dark, 16);
  const plan = mirrorZ([[0.2, 0], [0.19, 0.11], [0.12, 0.18], [-0.18, 0.18], [-0.23, 0.13], [-0.23, 0]]);
  T.loft([{ y: 0.02, p: plan }, { y: 0.16, p: inset(plan, 0.026) }], CAMO);
  // AESA radar panels on four faces
  for (const [x, z, ry] of [
    [0.155, 0.13, -0.78],
    [0.155, -0.13, 0.78],
    [-0.19, 0.14, -2.4],
    [-0.19, -0.14, 2.4],
  ] as const) {
    T.box(0.008, 0.08, 0.09, x, 0.09, z, 0x3a3e40, 0, ry, 0);
  }
  // 30mm revolver gun in a centre cradle + missile pods on the sides
  T.cbox(0.1, 0.07, 0.08, 0.008, 0.19, 0.09, 0, CAMO);
  cannon(b, T, 0.23, 0.09, 0, 0.38, 0.009, { shroud: 0.25 });
  for (const s of [-1, 1]) {
    const pod = b.part(T, 0.02, 0.11, s * 0.215);
    pod.cbox(0.16, 0.07, 0.06, 0.008, 0, 0, 0, CAMO);
    for (const y of [-0.017, 0.017]) pod.cx(0.013, 0.013, 0.004, 0.081, y, 0, K.black, 8);
    if (s > 0) b.muzzle(pod, 0.09, 0, 0);
    teamPanel(pod, 0.1, 0.018, 0.003, -0.02, 0.0, s * 0.031, b.team);
  }
  T.cbox(0.05, 0.04, 0.05, 0.006, 0.0, 0.18, 0, 0x3a3e40);
  T.box(0.004, 0.024, 0.03, 0.026, 0.18, 0, GLASS);
  antennas(b, B, -0.44, roof, [-0.2, 0.2], 0.22);
}

function aa(style: ModelStyle, fog: FogOfWar | null): Model {
  const fn = AA[style.faction] ?? aaSkyranger;
  return build('aa', style, fog, fn);
}

const AA: Record<string, (b: Bld) => void> = {
  germany: aaSkyranger,
  ukraine: (b) => aaGepard(b),
  russia: aaPantsir,
  china: (b) => aaGepard(b, true),
  korea: (b) => aaGepard(b, false, true),
  iran: aaShilka,
  turkey: (b) => aaGepard(b, false, false, true),
  israel: aaMachbet,
};

// ---------------------------------------------------------------- laser

/** Stryker ICV-style 8x8 hull (V-hull). Returns roof height. */
function strykerHull(b: Bld) {
  const B = b.body;
  const axles: Axle[] = [
    { x: 0.35, steer: 1 },
    { x: 0.19, steer: 0.6 },
    { x: -0.12, steer: 0 },
    { x: -0.28, steer: 0 },
  ];
  wheelSet(b, axles, 0.066, 0.072, 0.245);
  // double-V belly
  B.loft(
    [
      { y: 0.06, p: [[-0.46, -0.06], [0.42, -0.06], [0.42, 0.06], [-0.46, 0.06]] },
      { y: 0.16, p: [[-0.48, -0.2], [0.46, -0.2], [0.46, 0.2], [-0.48, 0.2]] },
    ],
    CAMO,
  );
  B.side(
    [
      [-0.49, 0.15],
      [0.47, 0.15],
      [0.51, 0.18],
      [0.33, 0.28],
      [-0.47, 0.285],
      [-0.49, 0.26],
    ],
    0.56,
    0,
    CAMO,
    0.01,
  );
  for (const s of [-1, 1]) {
    for (const a of axles) B.box(0.15, 0.012, 0.004, a.x, 0.149, s * 0.282, K.dark);
    // slat-like add-on armour tiles
    for (let i = 0; i < 6; i++) B.cbox(0.13, 0.08, 0.014, 0.004, -0.38 + i * 0.14, 0.215, s * 0.287, CAMO);
    headlight(B, 0.5, 0.2, s * 0.23, 0.9);
    taillight(B, -0.49, 0.26, s * 0.25);
  }
  hatch(B, 0.36, 0.272, -0.15, 0.03);
  grille(B, 0.27, 0.282, 0.14, 0.1, 0.14, 5);
  B.box(0.05, 0.02, 0.04, 0.3, 0.29, 0.25, K.black);
  b.emit(0.3, 0.3, 0.26);
  rearRamp(B, -0.492, 0.12, 0.27, 0.32, b.team);
  teamPanel(B, 0.004, 0.025, 0.2, -0.495, 0.25, 0, b.team);
  return 0.285;
}

function laser(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('laser', style, fog, (b) => {
    const B = b.body;
    const roof = strykerHull(b);
    // power / cooling module on the rear roof
    B.cbox(0.3, 0.07, 0.4, 0.01, -0.28, roof + 0.035, 0, CAMO);
    grille(B, -0.28, roof + 0.07, 0, 0.2, 0.3, 8, 0x3a3d40);
    for (const s of [-1, 1]) B.cy(0.03, 0.03, 0.03, -0.38, roof + 0.07, s * 0.14, 0x3a3d40, 10);
    const T = b.part(B, 0.02, roof, 0, 'turret');
    T.cy(0.11, 0.12, 0.03, 0, 0, 0, CAMO, 16);
    T.cbox(0.16, 0.09, 0.2, 0.012, -0.02, 0.07, 0, CAMO);
    // beam director: armoured drum with a big glowing aperture
    const bd = b.part(T, 0.03, 0.14, 0);
    bd.g.rotation.z = 0.12;
    bd.cz(0.065, 0.065, 0.14, 0, 0, 0, CAMO, 18);
    bd.cx(0.05, 0.058, 0.04, 0.06, 0, 0, 0x2c2f32, 18);
    bd.cx(0.045, 0.045, 0.004, 0.082, 0, 0, LENS, 18);
    bd.add(new THREE.TorusGeometry(0.05, 0.006, 6, 18).rotateY(Math.PI / 2), mt(K.steel), TR(0.083, 0, 0));
    for (const s of [-1, 1]) bd.cz(0.03, 0.03, 0.03, 0, 0, s * 0.08, K.dark, 10);
    b.muzzle(bd, 0.09, 0, 0);
    // sensor ball + 30mm for ground targets
    T.sph(0.032, 0.08, 0.1, 0.1, 0x3a3e40, 10, 7);
    T.cx(0.02, 0.02, 0.004, 0.112, 0.1, 0.1, GLASS, 10);
    T.box(0.1, 0.02, 0.02, 0.0, 0.05, -0.1, mt(K.gun));
    teamPanel(T, 0.12, 0.02, 0.003, -0.03, 0.06, 0.101, b.team);
    teamPanel(T, 0.12, 0.02, 0.003, -0.03, 0.06, -0.101, b.team);
    antennas(b, B, -0.44, roof, [-0.2, 0.2], 0.22);
  });
}

// ---------------------------------------------------------------- artillery

interface SphOpt {
  wheels: number;
  L: number;
  turretPlan: P2[]; // half plan
  turretH: number;
  turretX: number;
  barrel: number;
  r: number;
  front?: boolean; // front sprocket
  style?: WheelStyle;
  baskets?: boolean;
  rws?: boolean;
  cupola?: boolean;
}

function sph(b: Bld, o: SphOpt) {
  const B = b.body;
  const L = o.L;
  const x0 = -L / 2 + 0.1;
  const x1 = L / 2 - 0.13;
  running(b, {
    wheels: evenly(o.wheels, x0 + 0.02, x1),
    rw: o.wheels >= 7 ? 0.048 : 0.054,
    spr: o.front ? [L / 2 - 0.05, 0.11, 0.048] : [-L / 2 + 0.04, 0.11, 0.048],
    idl: o.front ? [-L / 2 + 0.04, 0.1, 0.044] : [L / 2 - 0.06, 0.1, 0.044],
    rollers: [
      [x0 + 0.15, 0.14, 0.014],
      [0.0, 0.14, 0.014],
      [x1 - 0.15, 0.14, 0.014],
    ],
    gauge: 0.243,
    tw: 0.13,
    style: o.style ?? 'nato',
  });
  B.side([[-L / 2 + 0.03, 0.06], [L / 2 - 0.1, 0.06], [L / 2 - 0.02, 0.165], [-L / 2, 0.165]], 0.33, 0, CAMO, 0.008);
  B.side(
    [
      [-L / 2, 0.165],
      [L / 2 - 0.02, 0.165],
      [L / 2 + 0.01, 0.195],
      [L / 2 - 0.2, 0.25],
      [-L / 2 + 0.02, 0.255],
      [-L / 2, 0.235],
    ],
    0.62,
    0,
    CAMO,
    0.008,
  );
  skirts(B, [[-L / 2 + 0.04, 0.105], [L / 2 - 0.08, 0.105], [L / 2, 0.16], [L / 2, 0.2], [-L / 2 + 0.03, 0.2]], 0.318, 0.01, evenly(4, -L / 2 + 0.2, L / 2 - 0.2));
  for (const s of [-1, 1]) {
    headlight(B, L / 2, 0.21, s * 0.26, 0.9);
    taillight(B, -L / 2, 0.235, s * 0.27);
  }
  hatch(B, L / 2 - 0.16, 0.235, -0.13, 0.03);
  grille(B, L / 2 - 0.12, 0.215, 0.12, 0.1, 0.14, 5);
  b.emit(L / 2 - 0.2, 0.25, 0.27);
  // barrel travel lock (A-frame) on the glacis
  for (const s of [-1, 1]) B.strut([L / 2 - 0.1, 0.205, s * 0.04], [L / 2 - 0.16, 0.29, 0], 0.006, K.dark);
  B.box(0.03, 0.02, 0.05, L / 2 - 0.16, 0.29, 0, K.dark);
  // big turret
  const T = b.part(B, o.turretX, 0.255, 0, 'turret');
  const plan = mirrorZ(o.turretPlan);
  T.loft([{ y: 0, p: plan }, { y: o.turretH * 0.7, p: inset(plan, 0.004) }, { y: o.turretH, p: inset(plan, 0.02) }], CAMO);
  const fx = o.turretPlan[0][0];
  T.cbox(0.08, 0.1, 0.13, 0.012, fx + 0.01, 0.07, 0, CAMO);
  mainGun(b, T, fx + 0.04, 0.07, 0, { len: o.barrel, r: o.r, fume: 0.3, brake: 'arty', elev: 0.05, sleeve: 0 });
  const rear = o.turretPlan[o.turretPlan.length - 1][0];
  for (const s of [-1, 1]) {
    const zSide = Math.max(...o.turretPlan.map((p) => p[1]));
    teamPanel(T, 0.2, 0.026, 0.003, (fx + rear) / 2, o.turretH * 0.55, s * (zSide + 0.002), b.team);
    if (o.baskets) {
      for (let i = 0; i < 4; i++) T.box(0.004, 0.06, 0.004, rear + 0.05 + i * 0.06, o.turretH * 0.5, s * (zSide + 0.03), 0x3a3d34);
      T.box(0.2, 0.004, 0.004, rear + 0.14, o.turretH * 0.5 + 0.03, s * (zSide + 0.03), 0x3a3d34);
      T.cbox(0.16, 0.04, 0.025, 0.008, rear + 0.14, o.turretH * 0.4, s * (zSide + 0.016), K.canvas);
    }
    smokeBank(T, fx - 0.03, o.turretH * 0.7, s * (zSide - 0.02), s, 4, 0.9, 0.008);
  }
  teamPanel(T, 0.004, 0.026, 0.2, rear - 0.002, o.turretH * 0.6, 0, b.team);
  hatch(T, rear + 0.1, o.turretH, 0.1, 0.035);
  hatch(T, rear + 0.1, o.turretH, -0.1, 0.035);
  if (o.cupola) {
    T.cy(0.04, 0.045, 0.03, fx - 0.12, o.turretH, 0.12, CAMO, 12);
    mgun(T, fx - 0.1, o.turretH + 0.045, 0.12, 0.1, 0.0055, true);
  }
  if (o.rws) rws(T, fx - 0.12, o.turretH, 0.12, 0.9, true);
  T.cbox(0.05, 0.035, 0.045, 0.006, fx - 0.06, o.turretH + 0.017, -0.12, CAMO);
  T.box(0.004, 0.02, 0.03, fx - 0.034, o.turretH + 0.018, -0.12, GLASS);
  antennas(b, T, rear + 0.05, o.turretH, [-0.17, 0.17], 0.22);
}

function arty(style: ModelStyle, fog: FogOfWar | null): Model {
  const fn = ARTY[style.faction] ?? ARTY.usa;
  return build('arty', style, fog, fn);
}

const PALADIN: P2[] = [[0.18, 0], [0.18, 0.2], [0.14, 0.235], [-0.42, 0.235], [-0.44, 0]];
const ARTY: Record<string, (b: Bld) => void> = {
  usa: (b) => sph(b, { wheels: 7, L: 1.02, turretPlan: PALADIN, turretH: 0.15, turretX: -0.04, barrel: 0.7, r: 0.019, front: true, cupola: true }),
  israel: (b) => sph(b, { wheels: 7, L: 1.02, turretPlan: PALADIN, turretH: 0.145, turretX: -0.04, barrel: 0.62, r: 0.019, front: true, cupola: true, baskets: true }),
  china: (b) => sph(b, { wheels: 6, L: 1.05, turretPlan: [[0.2, 0], [0.2, 0.16], [0.12, 0.24], [-0.4, 0.245], [-0.44, 0]], turretH: 0.16, turretX: -0.06, barrel: 0.82, r: 0.018, style: 'asia', rws: true }),
  germany: (b) => sph(b, { wheels: 7, L: 1.1, turretPlan: [[0.16, 0], [0.16, 0.17], [0.1, 0.24], [-0.36, 0.25], [-0.5, 0.22], [-0.52, 0]], turretH: 0.165, turretX: -0.06, barrel: 0.86, r: 0.018, rws: true, baskets: true }),
  ukraine: (b) => sph(b, { wheels: 7, L: 1.1, turretPlan: [[0.16, 0], [0.16, 0.17], [0.1, 0.24], [-0.36, 0.25], [-0.5, 0.22], [-0.52, 0]], turretH: 0.165, turretX: -0.06, barrel: 0.86, r: 0.018, rws: true, baskets: true }),
  korea: (b) => sph(b, { wheels: 6, L: 1.04, turretPlan: [[0.19, 0], [0.19, 0.19], [0.14, 0.24], [-0.42, 0.24], [-0.45, 0]], turretH: 0.155, turretX: -0.05, barrel: 0.82, r: 0.018, front: true, style: 'asia', cupola: true }),
  turkey: (b) => sph(b, { wheels: 6, L: 1.04, turretPlan: [[0.2, 0], [0.19, 0.19], [0.13, 0.245], [-0.42, 0.245], [-0.46, 0]], turretH: 0.16, turretX: -0.05, barrel: 0.82, r: 0.018, front: true, style: 'nato', rws: true, baskets: true }),
  iran: (b) => sph(b, { wheels: 6, L: 1.0, turretPlan: [[0.18, 0], [0.18, 0.2], [0.12, 0.235], [-0.4, 0.235], [-0.42, 0]], turretH: 0.14, turretX: -0.04, barrel: 0.66, r: 0.019, front: true, style: 'sov', cupola: true }),
};


// ================================================================ special vehicles

/** T-72 style chassis without turret (TOS-1A). Returns deck height. */
function t72Chassis(b: Bld) {
  running(b, {
    wheels: [-0.36, -0.245, -0.095, 0.02, 0.17, 0.285],
    rw: 0.058,
    spr: [-0.465, 0.105, 0.048],
    idl: [0.425, 0.092, 0.045],
    rollers: [
      [-0.2, 0.146, 0.014],
      [-0.03, 0.146, 0.014],
      [0.13, 0.146, 0.014],
    ],
    gauge: 0.243,
    tw: 0.13,
    style: 'sov',
    sag: 0.012,
  });
  const deck = sovHull(b, { L: 1.0, deck: 0.235, nose: 0.48, glacisX: 0.28 });
  sovSkirts(b, -0.47, 0.5, 0.1, 0.165, 0.5, 1);
  const B = b.body;
  bricks(B, slopePlane([0.28, deck], [0.49, 0.17], 0), 0.01, 0.2, -0.27, 0.27, 3, 7, 0.02, 0.008);
  dozer(B, 0.4);
  for (const s of [-1, 1]) {
    headlight(B, 0.5, 0.2, s * 0.21, 0.9);
    taillight(B, -0.5, 0.215, s * 0.27);
  }
  B.box(0.07, 0.035, 0.02, -0.32, 0.19, -0.3, K.black);
  b.emit(-0.32, 0.2, -0.32);
  hatch(B, 0.33, deck, 0, 0.03);
  periscope(B, 0.37, deck, 0, 0, 0.026);
  teamPanel(B, 0.4, 0.022, 0.003, 0.0, 0.135, 0.324, b.team);
  teamPanel(B, 0.4, 0.022, 0.003, 0.0, 0.135, -0.324, b.team);
  return deck;
}

function tos(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('tos', style, fog, (b) => {
    const deck = t72Chassis(b);
    const B = b.body;
    grille(B, -0.4, deck, 0, 0.12, 0.3, 6);
    // rotating launcher base
    const T = b.part(B, -0.12, deck, 0, 'turret');
    T.cy(0.2, 0.21, 0.03, 0, 0, 0, CAMO, 18);
    for (const s of [-1, 1]) T.side([[-0.2, 0.03], [0.05, 0.03], [-0.12, 0.13], [-0.2, 0.13]], 0.03, s * 0.12, CAMO, 0.004);
    // elevating 24-tube launcher box: pivot at the rear
    const E = b.part(T, -0.2, 0.12, 0, 'elev');
    const len = 0.78;
    E.cbox(len, 0.17, 0.3, 0.012, len / 2 - 0.04, 0.085, 0, CAMO);
    for (const sd of [-1, 1]) {
      E.box(len * 0.9, 0.006, 0.004, len / 2, 0.12, sd * 0.152, K.dark);
      E.box(len * 0.9, 0.006, 0.004, len / 2, 0.05, sd * 0.152, K.dark);
      teamPanel(E, 0.24, 0.026, 0.003, len * 0.45, 0.085, sd * 0.152, b.team);
    }
    // tube mouths (6 x 4) on the front face
    E.box(0.004, 0.15, 0.27, len - 0.04 + 0.002, 0.085, 0, K.dark);
    for (let i = 0; i < 6; i++) {
      for (let j = 0; j < 4; j++) {
        const z = -0.11 + i * 0.044;
        const y = 0.024 + j * 0.04;
        E.cx(0.017, 0.017, 0.012, len - 0.034, y, z, 0x3a3d32, 8);
        E.cx(0.012, 0.012, 0.004, len - 0.027, y, z, mt(K.black), 8);
        if ((i === 1 || i === 4) && j % 2 === 0) b.muzzle(E, len - 0.02, y, z);
        if ((i === 2 || i === 3) && j % 2 === 1) b.muzzle(E, len - 0.02, y, z);
      }
    }
    // hydraulic rams
    for (const sd of [-1, 1]) E.strut([0.18, 0.0, sd * 0.1], [0.3, -0.05, sd * 0.1], 0.01, mt(K.steel));
    E.box(0.07, 0.04, 0.05, -0.02, 0.18, 0.1, CAMO);
    // laser rangefinder / sight
    T.cbox(0.06, 0.05, 0.06, 0.006, 0.12, 0.06, 0.14, CAMO);
    T.box(0.004, 0.03, 0.04, 0.152, 0.065, 0.14, GLASS);
    antennas(b, B, -0.44, deck, [-0.2, 0.2], 0.22);
    b.custom = (q) => {
      const e = q('elev')[0];
      if (!e) return undefined;
      let a = 0.05;
      let still = 0;
      return (s) => {
        still = s.moving ? 0 : still + s.dt;
        const target = s.fired < 4 ? 0.55 : still > 1.2 ? 0.3 : 0.04;
        a += (target - a) * Math.min(1, s.dt * 1.8);
        e.rotation.z = a;
      };
    };
  });
}

/** Mesh dish (circular reflector made of rings and ribs + backing). Axis along +X. */
function meshDish(p: Part, R: number, depth: number) {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 6; i++) {
    const t = i / 6;
    pts.push(new THREE.Vector2(Math.max(0.001, R * t), depth * t * t));
  }
  p.add(new THREE.LatheGeometry(pts, 20).rotateZ(Math.PI / 2), 0x3a3e3c);
  p.add(new THREE.LatheGeometry(pts.slice().reverse(), 20).rotateZ(Math.PI / 2), 0x2e3230, TR(-0.003, 0, 0));
  for (const t of [0.35, 0.65, 1]) {
    const r = R * t;
    p.add(new THREE.TorusGeometry(r, 0.0035, 4, 24).rotateY(Math.PI / 2), mt(0x9a9e9a), TR(depth * t * t + 0.002, 0, 0));
  }
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    p.strut([0.002, 0, 0], [depth + 0.002, ca * R, sa * R], 0.003, mt(0x9a9e9a), 4);
  }
  for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) p.strut([depth, Math.cos(a) * R * 0.9, Math.sin(a) * R * 0.9], [R * 0.65, 0, 0], 0.003, K.dark, 4);
  p.cx(0.016, 0.02, 0.04, R * 0.67, 0, 0, K.dark, 8);
}

function ew(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('ew', style, fog, (b) => {
    const B = b.body;
    const axles: Axle[] = [
      { x: 0.44, steer: 1 },
      { x: 0.28, steer: 0.6 },
      { x: -0.18, steer: 0 },
      { x: -0.34, steer: 0 },
    ];
    const fy = truck(b, { axles, r: 0.072, W: 0.54, cabX0: 0.34, cabX1: 0.58, frameX0: -0.52, cabH: 0.19 });
    // equipment shelter with vents, ladders and outriggers
    B.cbox(0.8, 0.2, 0.52, 0.012, -0.11, fy + 0.11, 0, CAMO);
    for (const s of [-1, 1]) {
      B.box(0.12, 0.08, 0.004, -0.2, fy + 0.12, s * 0.262, K.dark);
      B.box(0.06, 0.03, 0.004, 0.15, fy + 0.15, s * 0.262, 0x3a3d40);
      B.box(0.03, 0.14, 0.03, -0.48, fy + 0.0, s * 0.27, K.dark);
      B.box(0.03, 0.03, 0.08, -0.48, fy - 0.06, s * 0.3, K.dark);
      teamPanel(B, 0.4, 0.026, 0.003, -0.16, fy + 0.18, s * 0.262, b.team);
    }
    for (let i = 0; i < 5; i++) B.box(0.004, 0.16, 0.004, -0.515, fy + 0.1, -0.15 + i * 0.008, K.dark);
    grille(B, 0.12, fy + 0.21, 0.12, 0.1, 0.14, 5, 0x3a3d40);
    // turntable + big rotating mesh dish
    B.cy(0.13, 0.14, 0.03, -0.18, fy + 0.21, 0, K.dark, 16);
    const D = b.part(B, -0.18, fy + 0.24, 0, 'dish');
    spinner(D.g, 'y', 0.9);
    D.cy(0.11, 0.12, 0.04, 0, 0, 0, CAMO, 14);
    D.box(0.08, 0.16, 0.06, -0.02, 0.1, 0, CAMO);
    const H = b.part(D, 0.02, 0.18, 0);
    H.g.rotation.z = 0.25;
    meshDish(H, 0.27, 0.07);
    b.emit(-0.18, fy + 0.45, 0, 'spark');
    antennas(b, B, 0.3, fy + 0.19, [-0.2, 0.2], 0.24);
  });
}

function berge(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('berge', style, fog, (b) => {
    const B = b.body;
    running(b, {
      wheels: evenly(7, -0.37, 0.33),
      rw: 0.05,
      spr: [-0.475, 0.112, 0.05],
      idl: [0.452, 0.1, 0.045],
      rollers: [
        [-0.27, 0.138, 0.015],
        [-0.08, 0.138, 0.015],
        [0.11, 0.138, 0.015],
        [0.28, 0.138, 0.015],
      ],
      gauge: 0.243,
      tw: 0.13,
      style: 'nato',
    });
    lowerHull(B, [[-0.5, 0.06], [0.44, 0.06], [0.55, 0.165], [-0.52, 0.165]], 0.172);
    B.side([[-0.535, 0.165], [0.55, 0.165], [0.57, 0.215], [0.45, 0.25], [-0.5, 0.255], [-0.535, 0.24]], 0.62, 0, CAMO, 0.008);
    skirts(B, [[-0.48, 0.1], [0.45, 0.1], [0.55, 0.14], [0.56, 0.205], [-0.49, 0.205]], 0.318, 0.012, [-0.3, -0.1, 0.1, 0.3]);
    // forward crew superstructure (left) leaving room for the crane on the right
    B.side([[0.0, 0.25], [0.48, 0.25], [0.44, 0.33], [0.36, 0.36], [0.0, 0.36]], 0.38, -0.1, CAMO, 0.01);
    for (const z of [-0.24, -0.16, -0.06]) periscope(B, 0.4, 0.355, z, 0, 0.02);
    hatch(B, 0.18, 0.36, -0.12, 0.034);
    rws(B, 0.25, 0.36, -0.2, 0.8, false);
    // dozer / stabilising blade at the front
    B.side([[0.56, 0.03], [0.6, 0.03], [0.62, 0.15], [0.58, 0.16]], 0.64, 0, CAMO, 0.006);
    B.box(0.02, 0.02, 0.62, 0.6, 0.035, 0, mt(K.steel));
    for (const s of [-1, 1]) B.strut([0.5, 0.12, s * 0.2], [0.59, 0.1, s * 0.2], 0.012, mt(K.steel));
    // crane: slewing base at the front right, boom resting along the hull
    B.cy(0.06, 0.07, 0.04, 0.38, 0.25, 0.19, CAMO, 14);
    const C = b.part(B, 0.38, 0.29, 0.19, 'crane');
    C.g.rotation.y = Math.PI - 0.06;
    C.g.rotation.z = 0.02;
    B.box(0.04, 0.05, 0.04, -0.42, 0.28, 0.17, K.dark);
    C.cbox(0.82, 0.07, 0.07, 0.01, 0.38, 0.0, 0, CAMO);
    C.cbox(0.3, 0.055, 0.055, 0.008, 0.85, -0.005, 0, CAMO);
    C.cz(0.03, 0.03, 0.08, 0.98, 0.0, 0, K.dark, 10);
    C.strut([0.15, -0.03, 0], [0.04, -0.08, 0], 0.016, mt(K.steel));
    C.box(0.012, 0.06, 0.012, 1.0, -0.05, 0, K.dark);
    C.box(0.03, 0.03, 0.02, 1.0, -0.09, 0, K.yellow);
    teamPanel(C, 0.3, 0.02, 0.072, 0.5, 0.0, 0, b.team);
    // winch drum on the rear deck, spare power pack cover, tow bars
    B.cz(0.04, 0.04, 0.28, -0.38, 0.29, 0, K.dark, 12);
    B.cz(0.042, 0.042, 0.2, -0.38, 0.29, 0, mt(0x4a4a46), 12);
    for (const s of [-1, 1]) B.box(0.12, 0.06, 0.02, -0.38, 0.28, s * 0.16, CAMO);
    grille(B, -0.2, 0.255, 0, 0.18, 0.34, 8);
    B.strut([-0.52, 0.22, 0.12], [-0.3, 0.27, 0.0], 0.008, K.yellow);
    for (const s of [-1, 1]) {
      headlight(B, 0.55, 0.215, s * 0.27);
      taillight(B, -0.535, 0.24, s * 0.28);
      b.emit(-0.54, 0.225, s * 0.2);
      teamPanel(B, 0.36, 0.026, 0.003, -0.2, 0.17, s * 0.326, b.team);
    }
    beacon(b, B, 0.3, 0.36, -0.05);
    beacon(b, B, -0.5, 0.255, -0.24);
    antennas(b, B, 0.05, 0.36, [-0.26, 0.04], 0.22);
  });
}

function swarm(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('swarm', style, fog, (b) => {
    const B = b.body;
    const axles: Axle[] = [
      { x: 0.4, steer: 1 },
      { x: -0.12, steer: 0 },
      { x: -0.3, steer: 0 },
    ];
    const fy = truck(b, { axles, r: 0.07, W: 0.52, cabX0: 0.3, cabX1: 0.52, frameX0: -0.5, cabH: 0.18 });
    B.box(0.76, 0.03, 0.5, -0.11, fy + 0.015, 0, CAMO);
    for (const s of [-1, 1]) {
      B.box(0.03, 0.12, 0.03, -0.46, fy - 0.03, s * 0.22, K.dark);
      bin(B, 0.12, 0.06, 0.06, 0.18, fy + 0.03, s * 0.21, CAMO);
    }
    // rack of drone canisters on an elevating cradle
    B.box(0.1, 0.08, 0.3, -0.36, fy + 0.07, 0, K.dark);
    const R = b.part(B, -0.36, fy + 0.11, 0);
    R.g.rotation.z = 0.42;
    R.cbox(0.6, 0.22, 0.46, 0.01, 0.3, 0.11, 0, CAMO);
    R.box(0.004, 0.2, 0.43, 0.602, 0.11, 0, K.dark);
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 4; j++) {
        const z = -0.19 + i * 0.054;
        const y = 0.032 + j * 0.052;
        R.box(0.012, 0.044, 0.046, 0.605, y, z, 0x4e5636);
        R.box(0.004, 0.032, 0.034, 0.612, y, z, mt(K.black));
        if (j === 1 && (i === 2 || i === 5)) b.muzzle(R, 0.62, y, z);
      }
    }
    for (const s of [-1, 1]) teamPanel(R, 0.3, 0.03, 0.003, 0.3, 0.11, s * 0.231, b.team);
    // control mast with datalink antennas
    B.cy(0.01, 0.012, 0.12, 0.25, fy + 0.03, -0.18, K.dark, 6);
    B.box(0.05, 0.03, 0.05, 0.25, fy + 0.16, -0.18, 0x3a3e40);
    antennas(b, B, 0.32, fy + 0.18, [-0.2, 0.2], 0.24);
  });
}

function missileTruck(style: ModelStyle, fog: FogOfWar | null): Model {
  const china = style.faction !== 'iran';
  return build('missile_truck', style, fog, (b) => {
    const B = b.body;
    const axles: Axle[] = china
      ? [
          { x: 0.48, steer: 1 },
          { x: 0.33, steer: 0.7 },
          { x: -0.05, steer: 0 },
          { x: -0.2, steer: 0 },
          { x: -0.35, steer: -0.3 },
        ]
      : [
          { x: 0.4, steer: 1 },
          { x: -0.12, steer: 0 },
          { x: -0.28, steer: 0 },
        ];
    const L = china ? 1.3 : 1.1;
    const fy = truck(b, { axles, r: china ? 0.075 : 0.07, W: china ? 0.56 : 0.5, cabX0: china ? 0.42 : 0.3, cabX1: china ? 0.66 : 0.52, frameX0: -L / 2 + 0.05, cabH: china ? 0.17 : 0.18 });
    const bedL = china ? 0.98 : 0.74;
    const bx = (china ? 0.4 : 0.28) - bedL / 2;
    B.box(bedL, 0.03, china ? 0.52 : 0.46, bx, fy + 0.015, 0, CAMO);
    for (const s of [-1, 1]) {
      B.box(0.03, 0.12, 0.03, -L / 2 + 0.06, fy - 0.03, s * 0.22, K.dark);
      B.box(0.05, 0.02, 0.05, -L / 2 + 0.06, fy - 0.09, s * 0.22, K.dark);
      bin(B, 0.12, 0.05, 0.05, bx + bedL / 2 - 0.1, fy + 0.03, s * 0.22, CAMO);
      teamPanel(B, 0.3, 0.024, 0.003, bx, fy + 0.0, s * ((china ? 0.26 : 0.23) + 0.002), b.team);
    }
    // erector arm (pivot at the rear) + missile
    const ex = -L / 2 + 0.08;
    B.box(0.06, 0.06, 0.2, ex, fy + 0.06, 0, K.dark);
    const E = b.part(B, ex, fy + 0.08, 0, 'erect');
    const ml = china ? 0.95 : 0.78;
    const mr = china ? 0.042 : 0.034;
    for (const s of [-1, 1]) E.box(ml * 0.85, 0.03, 0.025, ml * 0.42, 0.0, s * (mr + 0.02), K.dark);
    for (let i = 0; i < 3; i++) E.box(0.03, 0.03, (mr + 0.03) * 2, 0.12 + i * 0.28, 0.0, 0, K.dark);
    E.strut([0.25, -0.02, 0], [0.4, -0.06, 0], 0.016, mt(K.steel));
    const my = mr + 0.02;
    if (china) {
      // DF-17: booster + hypersonic glide vehicle (flat wedge with fins)
      E.cx(mr, mr, 0.6, 0.32, my, 0, 0xd8d8d0, 16);
      E.cx(mr * 1.05, mr * 1.05, 0.02, 0.05, my, 0, 0x3a3a3a, 16);
      E.cx(mr * 0.9, mr, 0.03, 0.035, my, 0, 0x2a2a2a, 12);
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
        E.box(0.07, 0.003, 0.04, 0.06, my + Math.sin(a) * (mr + 0.015), Math.cos(a) * (mr + 0.015), 0x9a9a96, a, 0, 0);
      }
      E.box(0.006, 0.01, mr * 2.2, 0.36, my, 0, b.team);
      // glide vehicle
      E.loft(
        [
          { y: -0.022, p: [[0.62, -mr], [0.62, mr], [0.9, 0.004], [0.9, -0.004]] },
          { y: 0.022, p: [[0.62, -mr * 0.6], [0.62, mr * 0.6], [0.88, 0.002], [0.88, -0.002]] },
        ],
        0x2c2c2c,
        false,
        TR(0, my, 0),
      );
      for (const s of [-1, 1]) E.box(0.06, 0.004, 0.03, 0.65, my + 0.0, s * (mr + 0.012), 0x2c2c2c, 0, s * 0.3, 0);
      E.box(0.05, 0.03, 0.003, 0.64, my + 0.03, 0, 0x2c2c2c);
      b.muzzle(E, 0.91, my, 0);
    } else {
      // Fateh-110: single stage with ogive nose, canards and tail fins
      E.cx(mr, mr, 0.56, 0.32, my, 0, 0xd0d0c8, 16);
      E.add(new THREE.LatheGeometry([new THREE.Vector2(mr, 0), new THREE.Vector2(mr * 0.85, 0.06), new THREE.Vector2(mr * 0.5, 0.13), new THREE.Vector2(0.001, 0.17)], 14).rotateZ(-Math.PI / 2), 0xd0d0c8, TR(0.6, my, 0));
      for (let i = 0; i < 4; i++) {
        const a = (i / 4) * Math.PI * 2;
        E.box(0.08, 0.003, 0.05, 0.08, my + Math.sin(a) * (mr + 0.02), Math.cos(a) * (mr + 0.02), 0x5a5e58, a, 0, 0);
        E.box(0.03, 0.003, 0.024, 0.6, my + Math.sin(a) * (mr + 0.01), Math.cos(a) * (mr + 0.01), 0x5a5e58, a, 0, 0);
      }
      E.box(0.006, 0.01, mr * 2.2, 0.4, my, 0, b.team);
      E.cx(mr * 1.02, mr * 1.02, 0.03, 0.47, my, 0, 0x3a3e38, 16);
      b.muzzle(E, 0.78, my, 0);
    }
    antennas(b, B, china ? 0.44 : 0.33, fy + (china ? 0.17 : 0.18), [-0.2, 0.2], 0.22);
    b.custom = (q) => {
      const e = q('erect')[0];
      if (!e) return undefined;
      let a = 0;
      let still = 0;
      return (s) => {
        still = s.moving ? 0 : still + s.dt;
        const target = s.fired < 3 ? 1.1 : still > 1.5 ? 0.55 : 0;
        a += (target - a) * Math.min(1, s.dt * 1.2);
        e.rotation.z = a;
      };
    };
  });
}

// ------------------------------------------------------------ strike-missile TELs

interface TelCfg {
  /** Axle x positions, front first; the first `steer` axles steer. */
  axles: number[];
  steer: number;
  L: number;
  W: number;
  r: number;
  cab: [number, number, number]; // x0, x1, height
  /** bare missile(s) on rails, box canisters / pod, or round canisters. */
  load: 'bare' | 'box' | 'round';
  cols: number;
  rows: number;
  len: number;
  w: number; // box width / round & bare radius * 2
  h: number; // box height (box) / ignored
  mcol: number; // missile body / canister colour (CAMO = vehicle paint)
  elev: number; // firing elevation (rad)
  caps?: number; // box: muzzle caps per canister face (HIMARS pod: 2, Typhon cells: 1)
  nose?: number; // bare: ogive length
  cover?: boolean; // bare: canvas cover over the rear half (Iskander)
}

function telModel(key: string, c: TelCfg) {
  return (style: ModelStyle, fog: FogOfWar | null): Model =>
    build(key, style, fog, (b) => {
      const B = b.body;
      const axles: Axle[] = c.axles.map((x, i) => ({ x, steer: i < c.steer ? 1 - i * 0.3 : i === c.axles.length - 1 && c.axles.length > 4 ? -0.25 : 0 }));
      const fy = truck(b, { axles, r: c.r, W: c.W, cabX0: c.cab[0], cabX1: c.cab[1], frameX0: -c.L / 2 + 0.04, cabH: c.cab[2] });
      const bedX1 = c.cab[0] - 0.02;
      const bedX0 = -c.L / 2 + 0.03;
      const bedL = bedX1 - bedX0;
      B.box(bedL, 0.028, c.W * 0.9, (bedX0 + bedX1) / 2, fy + 0.014, 0, CAMO);
      for (const s of [-1, 1]) {
        B.box(0.03, 0.11, 0.03, bedX0 + 0.03, fy - 0.03, s * c.W * 0.4, K.dark); // stabiliser jacks
        B.box(0.05, 0.02, 0.05, bedX0 + 0.03, fy - 0.09, s * c.W * 0.4, K.dark);
        bin(B, 0.1, 0.045, 0.045, bedX1 - 0.08, fy + 0.028, s * (c.W * 0.45 - 0.03), CAMO);
        teamPanel(B, Math.min(0.3, bedL * 0.4), 0.022, 0.003, (bedX0 + bedX1) / 2, fy, s * (c.W * 0.45 + 0.002), b.team);
      }
      // erector: pivot at the rear of the bed, payload forward over the bed (travel), raised to fire
      const ex = bedX0 + 0.04;
      B.box(0.05, 0.05, c.W * 0.5, ex, fy + 0.05, 0, K.dark);
      const E = b.part(B, ex, fy + 0.07, 0, 'erect');
      const len = c.len;
      const span = c.cols * c.w + (c.cols - 1) * 0.008;
      for (const s of [-1, 1]) E.box(len * 0.9, 0.024, 0.02, len * 0.47, 0, s * (span / 2 - 0.01), K.dark);
      for (let i = 0; i < 3; i++) E.box(0.025, 0.024, span, 0.08 + i * (len * 0.38), 0, 0, K.dark);
      E.strut([len * 0.3, -0.015, 0], [len * 0.48, -0.05, 0], 0.014, mt(K.steel));
      const x0 = 0.02;
      const xm = x0 + len / 2;
      for (let row = 0; row < c.rows; row++)
        for (let col = 0; col < c.cols; col++) {
          const z = (col - (c.cols - 1) / 2) * (c.w + 0.008);
          if (c.load === 'box') {
            const y = 0.012 + c.h / 2 + row * (c.h + 0.004);
            E.cbox(len, c.h, c.w, 0.005, xm, y, z, c.mcol);
            for (const k of [0.2, 0.5, 0.8]) E.box(0.008, c.h + 0.006, c.w + 0.006, x0 + len * k, y, z, K.dark); // frame ribs
            const n = c.caps ?? 1;
            for (let j = 0; j < n; j++) {
              const cz = z + (n > 1 ? (j - (n - 1) / 2) * (c.w / n) : 0);
              E.box(0.004, c.h * 0.8, (c.w / n) * 0.8, x0 + len + 0.002, y, cz, 0x2a2c28);
              b.muzzle(E, x0 + len + 0.01, y, cz);
            }
          } else if (c.load === 'round') {
            const R = c.w / 2;
            const y = 0.012 + R + row * (c.w + 0.004);
            E.cx(R, R, len, xm, y, z, c.mcol, 14);
            for (const k of [0.04, 0.5, 0.96]) E.cx(R * 1.08, R * 1.08, 0.014, x0 + len * k, y, z, K.dark, 14);
            E.cx(R * 0.9, R * 0.9, 0.004, x0 + len + 0.002, y, z, 0x2a2c28, 14);
            b.muzzle(E, x0 + len + 0.01, y, z);
          } else {
            const R = c.w / 2;
            const y = 0.014 + R + 0.01;
            const nose = c.nose ?? R * 4;
            const body = len - nose;
            E.cx(R, R, body, x0 + body / 2, y, z, c.mcol, 16);
            E.add(new THREE.LatheGeometry([new THREE.Vector2(R, 0), new THREE.Vector2(R * 0.86, nose * 0.38), new THREE.Vector2(R * 0.5, nose * 0.78), new THREE.Vector2(0.001, nose)], 14).rotateZ(-Math.PI / 2), c.mcol, TR(x0 + body, y, z));
            for (let i = 0; i < 4; i++) {
              const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
              E.box(len * 0.09, 0.003, R * 1.1, x0 + len * 0.06, y + Math.sin(a) * R * 1.5, z + Math.cos(a) * R * 1.5, 0x5a5e58, a, 0, 0);
            }
            E.cx(R * 1.03, R * 1.03, 0.012, x0 + body * 0.62, y, z, b.team, 16);
            E.cx(R * 1.04, R * 1.04, 0.02, x0 + 0.01, y, z, 0x2a2a2a, 16);
            if (c.cover) E.cbox(body * 0.42, R * 2.3, R * 2.3, R * 0.6, x0 + body * 0.22, y, z, 0x4e5240);
            b.muzzle(E, x0 + len, y, z);
          }
        }
      antennas(b, B, c.cab[0] + 0.03, fy + c.cab[2] + 0.004, [-c.W * 0.38, c.W * 0.38], 0.2);
      const elev = c.elev;
      b.custom = (q) => {
        const e = q('erect')[0];
        if (!e) return undefined;
        let a = 0;
        let still = 0;
        return (s) => {
          still = s.moving ? 0 : still + s.dt;
          const target = s.fired < 3 ? elev : still > 1.5 ? elev * 0.5 : 0;
          a += (target - a) * Math.min(1, s.dt * 1.2);
          e.rotation.z = a;
        };
      };
    });
}

const TELS: Record<string, TelCfg> = {
  // M142 HIMARS: 6x6, one launch pod (2 PrSM cells) on a slewing platform
  tel_himars: { axles: [0.34, -0.08, -0.26], steer: 1, L: 0.98, W: 0.48, r: 0.072, cab: [0.24, 0.47, 0.19], load: 'box', cols: 1, rows: 1, len: 0.58, w: 0.25, h: 0.15, mcol: CAMO, elev: 0.75, caps: 2 },
  // Typhon MRC: Mk 41 cells (2 x 2) raised near-vertical
  tel_typhon: { axles: [0.48, 0.32, -0.12, -0.28, -0.44], steer: 2, L: 1.3, W: 0.54, r: 0.072, cab: [0.36, 0.62, 0.19], load: 'box', cols: 2, rows: 2, len: 0.78, w: 0.13, h: 0.11, mcol: CAMO, elev: 1.4, caps: 1 },
  // LORA: 8x8 with two box canisters
  tel_lora: { axles: [0.46, 0.3, -0.16, -0.32], steer: 2, L: 1.2, W: 0.52, r: 0.074, cab: [0.36, 0.6, 0.18], load: 'box', cols: 2, rows: 1, len: 0.8, w: 0.12, h: 0.12, mcol: CAMO, elev: 0.95 },
  // Taurus KEPD 350 (ground-launched): one long flat canister
  tel_taurus: { axles: [0.38, -0.1, -0.27], steer: 1, L: 1.05, W: 0.5, r: 0.07, cab: [0.28, 0.52, 0.18], load: 'box', cols: 1, rows: 1, len: 0.66, w: 0.26, h: 0.1, mcol: CAMO, elev: 0.55 },
  // Hyunmoo-2: 8x8, two bare missiles
  tel_hyunmoo: { axles: [0.46, 0.3, -0.14, -0.3], steer: 2, L: 1.2, W: 0.52, r: 0.074, cab: [0.36, 0.6, 0.18], load: 'bare', cols: 2, rows: 1, len: 0.82, w: 0.07, h: 0, mcol: 0xd6d8d2, elev: 1.15, nose: 0.13 },
  // R-360 Neptune: USPU-360 launcher on the KrAZ-7634HE 8x8, four round canisters (2 x 2)
  tel_neptune: { axles: [0.46, 0.3, -0.14, -0.3], steer: 2, L: 1.2, W: 0.5, r: 0.074, cab: [0.36, 0.6, 0.19], load: 'round', cols: 2, rows: 2, len: 0.66, w: 0.075, h: 0, mcol: CAMO, elev: 0.5 },
  // Tayfun: 8x8 with two round canisters
  tel_tayfun: { axles: [0.46, 0.3, -0.14, -0.3], steer: 2, L: 1.2, W: 0.52, r: 0.074, cab: [0.36, 0.6, 0.18], load: 'round', cols: 2, rows: 1, len: 0.8, w: 0.1, h: 0, mcol: CAMO, elev: 1.0 },
  // 9K720 Iskander-M: MZKT 8x8, two missiles under a rear cover
  tel_iskander: { axles: [0.46, 0.3, -0.14, -0.3], steer: 2, L: 1.2, W: 0.54, r: 0.076, cab: [0.36, 0.6, 0.17], load: 'bare', cols: 2, rows: 1, len: 0.8, w: 0.085, h: 0, mcol: 0x6a7058, elev: 1.25, nose: 0.17, cover: true },
  // Khorramshahr-4: heavy 10x10, one huge missile
  tel_khorramshahr: { axles: [0.6, 0.44, 0.0, -0.16, -0.32], steer: 2, L: 1.5, W: 0.58, r: 0.08, cab: [0.48, 0.74, 0.19], load: 'bare', cols: 1, rows: 1, len: 1.12, w: 0.13, h: 0, mcol: 0xd2d0c4, elev: 1.25, nose: 0.24 },
};

/** Shahed-136 style delta-wing drone (forward = +X) in a part. */
function shahedDrone(p: Part, x: number, y: number, z: number, s = 1) {
  const c = 0x8a8a84;
  p.add(gPlan([[0.11 * s, 0], [-0.07 * s, 0.1 * s], [-0.08 * s, 0.09 * s], [-0.07 * s, 0], [-0.08 * s, -0.09 * s], [-0.07 * s, -0.1 * s]], 0.006, 0), c, TR(x, y, z));
  p.cx(0.012 * s, 0.014 * s, 0.17 * s, x + 0.01 * s, y + 0.01 * s, z, c, 8);
  for (const sd of [-1, 1]) p.box(0.04 * s, 0.03 * s, 0.003, x - 0.065 * s, y + 0.016 * s, z + sd * 0.095 * s, c);
  p.cx(0.005, 0.005, 0.01, x - 0.085 * s, y + 0.01 * s, z, K.dark, 6);
}

function container(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('container', style, fog, (b) => {
    const B = b.body;
    const axles: Axle[] = [
      { x: 0.42, steer: 1 },
      { x: -0.12, steer: 0 },
      { x: -0.3, steer: 0 },
    ];
    const fy = truck(b, { axles, r: 0.07, W: 0.52, cabX0: 0.32, cabX1: 0.55, frameX0: -0.52, cabH: 0.18 });
    // 20 ft shipping container, rear end open with doors swung out
    const cx0 = -0.54;
    const cx1 = 0.28;
    const ch = 0.24;
    const cw = 0.5;
    const cc = 0x7a4a32;
    const C = b.part(B, 0, fy + 0.02, 0);
    C.box(cx1 - cx0, 0.012, cw, (cx0 + cx1) / 2, 0.006, 0, cc);
    C.box((cx1 - cx0) * 0.4, 0.012, cw, cx1 - (cx1 - cx0) * 0.2, ch - 0.006, 0, cc);
    C.box((cx1 - cx0) * 0.4, 0.012, cw - 0.01, cx1 - (cx1 - cx0) * 0.22, ch + 0.008, 0, shade(cc, 0.92));
    C.box((cx1 - cx0) * 0.4, 0.012, cw - 0.02, cx1 - (cx1 - cx0) * 0.24, ch + 0.022, 0, shade(cc, 0.85));
    for (const sd of [-1, 1]) C.box(cx1 - cx0, 0.016, 0.02, (cx0 + cx1) / 2, ch - 0.008, sd * (cw / 2 - 0.01), shade(cc, 0.75));
    C.box(0.012, ch, cw, cx1 - 0.006, ch / 2, 0, cc);
    for (const s of [-1, 1]) {
      C.box(cx1 - cx0, ch, 0.012, (cx0 + cx1) / 2, ch / 2, s * (cw / 2 - 0.006), cc);
      // corrugation ribs
      for (let i = 0; i < 14; i++) C.box(0.008, ch - 0.03, 0.006, cx0 + 0.04 + i * 0.056, ch / 2, s * (cw / 2 + 0.002), shade(cc, 0.85));
      // open doors
      C.box(0.012, ch - 0.01, cw / 2 - 0.01, cx0 - 0.01, ch / 2, s * (cw / 2 + 0.1), shade(cc, 0.9), 0, s * -1.35, 0);
      teamPanel(C, 0.3, 0.03, 0.003, (cx0 + cx1) / 2, ch * 0.75, s * (cw / 2 + 0.006), b.team);
    }
    for (const x of [cx0, cx1]) for (const s of [-1, 1]) C.box(0.02, ch + 0.004, 0.02, x, ch / 2, s * (cw / 2 - 0.01), shade(cc, 0.7));
    C.box(cx1 - cx0 - 0.02, 0.004, cw - 0.03, (cx0 + cx1) / 2, 0.014, 0, 0x2a2a28);
    // inclined launch rails with three drones, fired out of the open rear
    const R = b.part(C, cx0 + 0.62, 0.05, 0);
    R.g.rotation.y = Math.PI;
    R.g.rotation.z = 0.16;
    for (const sd of [-1, 1]) R.box(0.66, 0.012, 0.012, 0.3, 0.0, sd * 0.03, mt(K.steel));
    for (let i = 0; i < 3; i++) R.box(0.012, 0.05, 0.08, 0.08 + i * 0.22, -0.03, 0, K.dark);
    for (let i = 0; i < 3; i++) shahedDrone(R, 0.14 + i * 0.2, 0.026, 0, 1);
    b.muzzle(R, 0.68, 0.05, 0);
    antennas(b, B, 0.36, fy + 0.18, [-0.2, 0.2], 0.22);
  });
}

function harvester(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('harvester', style, fog, (b) => {
    const B = b.body;
    running(b, {
      wheels: evenly(6, -0.48, 0.36),
      rw: 0.06,
      spr: [-0.6, 0.12, 0.055],
      idl: [0.5, 0.11, 0.05],
      rollers: [
        [-0.3, 0.165, 0.016],
        [-0.05, 0.165, 0.016],
        [0.2, 0.165, 0.016],
      ],
      gauge: 0.27,
      tw: 0.17,
      style: 'nato',
    });
    lowerHull(B, [[-0.64, 0.07], [0.46, 0.07], [0.54, 0.19], [-0.66, 0.19]], 0.18);
    B.side([[-0.68, 0.19], [0.56, 0.19], [0.58, 0.27], [-0.66, 0.28], [-0.68, 0.25]], 0.74, 0, CAMO, 0.01);
    for (const s of [-1, 1]) {
      B.box(1.2, 0.012, 0.18, -0.06, 0.2, s * 0.28, K.dark);
      headlight(B, 0.585, 0.25, s * 0.3, 1.1);
      taillight(B, -0.68, 0.25, s * 0.3);
      teamPanel(B, 0.5, 0.03, 0.003, -0.1, 0.235, s * 0.371, b.team);
    }
    // front cutter drum (spins) in a housing
    B.side([[0.5, 0.1], [0.6, 0.1], [0.7, 0.2], [0.7, 0.3], [0.56, 0.3]], 0.04, 0.33, CAMO, 0.006);
    B.side([[0.5, 0.1], [0.6, 0.1], [0.7, 0.2], [0.7, 0.3], [0.56, 0.3]], 0.04, -0.33, CAMO, 0.006);
    B.box(0.18, 0.02, 0.7, 0.62, 0.3, 0, CAMO, 0, 0, -0.3);
    const D = b.part(B, 0.67, 0.12, 0, 'drum');
    spinner(D.g, 'z', -6);
    D.cz(0.08, 0.08, 0.6, 0, 0, 0, 0x5a5a56, 14);
    for (let i = 0; i < 10; i++) {
      for (let j = 0; j < 7; j++) {
        const a = (i / 10) * Math.PI * 2 + j * 0.6;
        const z = -0.27 + j * 0.09;
        D.box(0.03, 0.02, 0.02, Math.cos(a) * 0.088, Math.sin(a) * 0.088, z, mt(0x8a8a86), 0, 0, a);
      }
    }
    for (let i = 0; i < 2; i++) D.add(new THREE.TorusGeometry(0.08, 0.008, 4, 16), K.yellow, TR(0, 0, -0.28 + i * 0.56));
    // conveyor from the drum to the hopper
    B.side([[0.36, 0.28], [0.58, 0.28], [0.46, 0.45], [0.3, 0.45]], 0.16, 0, 0x3a3d40, 0.006);
    // cab on the front left
    B.cbox(0.24, 0.2, 0.24, 0.016, 0.35, 0.38, -0.22, CAMO);
    B.box(0.006, 0.1, 0.2, 0.473, 0.41, -0.22, GLASS);
    B.box(0.16, 0.08, 0.004, 0.36, 0.42, -0.341, GLASS);
    B.box(0.16, 0.08, 0.004, 0.36, 0.42, -0.099, GLASS);
    beacon(b, B, 0.35, 0.48, -0.22);
    // big hopper with ore load and hazard trim
    const hx0 = -0.62;
    const hx1 = 0.24;
    B.loft(
      [
        { y: 0.28, p: [[hx0 + 0.04, -0.3], [hx1 - 0.04, -0.3], [hx1 - 0.04, 0.3], [hx0 + 0.04, 0.3]] },
        { y: 0.5, p: [[hx0, -0.36], [hx1, -0.36], [hx1, 0.36], [hx0, 0.36]] },
      ],
      CAMO,
    );
    B.box(hx1 - hx0 - 0.04, 0.004, 0.68, (hx0 + hx1) / 2, 0.47, 0, 0x5a4a30);
    for (let i = 0; i < 26; i++) {
      const x = hx0 + 0.06 + ((i * 37) % 100) / 100 * (hx1 - hx0 - 0.12);
      const z = -0.28 + ((i * 61) % 100) / 100 * 0.56;
      B.add(new THREE.IcosahedronGeometry(0.035 + (i % 4) * 0.008, 0), K.ore, TR(x, 0.48, z, i, i * 2, 0));
    }
    for (let i = 0; i < 16; i++) {
      const x = hx0 + 0.03 + i * 0.054;
      B.box(0.027, 0.02, 0.012, x, 0.505, 0.36, i % 2 ? K.yellow : K.black);
      B.box(0.027, 0.02, 0.012, x, 0.505, -0.36, i % 2 ? K.yellow : K.black);
    }
    for (const z of [-0.33, 0.33]) beacon(b, B, hx0 + 0.04, 0.51, z);
    teamPanel(B, 0.004, 0.06, 0.4, hx0 - 0.002, 0.4, 0, b.team);
    // exhaust stacks
    for (const z of [0.12, 0.2]) {
      B.cy(0.014, 0.016, 0.2, 0.3, 0.28, z, K.dark, 8);
      b.emit(0.3, 0.5, z);
    }
    b.bob = 0.6;
  });
}

/**
 * MCV: truck with a folded construction module. Deploying (AnimState.deploy 0..1, ~4 s, driven by the
 * renderer's deploy overlay) unfolds it: outrigger beams slide out and their jacks press down, lifting
 * the truck level; the module's side walls fold down into floor wings, wall panels hinged on the wings
 * swing up, roof panels flip over onto them and the crane boom rises and slews.
 */
function mcv(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('mcv', style, fog, (b) => {
    const B = b.body;
    const axles: Axle[] = [
      { x: 0.5, steer: 1 },
      { x: 0.33, steer: 0.7 },
      { x: -0.2, steer: 0 },
      { x: -0.37, steer: -0.3 },
    ];
    const fy = truck(b, { axles, r: 0.085, W: 0.64, cabX0: 0.4, cabX1: 0.68, frameX0: -0.62, cabH: 0.22, tyreW: 0.085 });
    B.box(1.02, 0.04, 0.62, -0.13, fy + 0.02, 0, CAMO);
    // construction module: core (floor, end walls, roof, machinery) + folding side walls
    const mx = -0.2;
    const LX = 0.64;
    const H = 0.24;
    const HZ = 0.28;
    const y0 = fy + 0.04;
    B.box(LX, 0.012, HZ * 2, mx, y0 + 0.006, 0, 0x3a3c38);
    for (const e of [-1, 1]) B.box(0.014, H, HZ * 2, mx + (e * (LX - 0.014)) / 2, y0 + H / 2, 0, CAMO);
    B.cbox(LX, 0.014, HZ * 2, 0.004, mx, y0 + H, 0, CAMO);
    // machinery inside (seen once the walls are down): 3D-printer gantry, power packs, consoles
    B.box(LX - 0.06, 0.16, 0.2, mx, y0 + 0.09, 0, 0x5a5e60);
    B.box(LX - 0.1, 0.02, 0.22, mx, y0 + 0.18, 0, K.yellow);
    for (const x of [-0.2, 0, 0.2]) B.box(0.03, 0.05, 0.03, mx + x, y0 + 0.215, 0, K.dark);
    for (const z of [-1, 1]) {
      for (let i = 0; i < 3; i++) B.box(0.1, 0.07, 0.02, mx - 0.18 + i * 0.18, y0 + 0.05, z * 0.115, i === 1 ? 0x2c4a5c : 0x4a4c48);
      B.box(LX - 0.04, 0.008, 0.008, mx, y0 + 0.235, z * 0.2, K.yellow);
    }
    grille(B, mx - 0.15, y0 + H, 0.12, 0.16, 0.16, 6, 0x3a3d40);
    B.cy(0.05, 0.05, 0.04, mx + 0.15, y0 + H, -0.12, 0x3a3d40, 12);
    beacon(b, B, mx - 0.28, y0 + H, 0.24);
    beacon(b, B, 0.6, fy + 0.24, -0.24);
    for (const s of [-1, 1]) {
      // side wall: hinged at its bottom edge, folds out into a floor wing (inner face = deck plate)
      const W = b.part(B, mx, y0, s * HZ, 'mcvwall');
      W.g.userData.side = s;
      W.box(LX - 0.03, H, 0.012, 0, H / 2, s * 0.006, CAMO);
      for (let i = 0; i < 4; i++) W.box(0.004, H - 0.04, 0.004, -0.24 + i * 0.16, H / 2, s * 0.013, K.dark);
      for (const x of [-0.1, 0.1]) W.box(0.1, 0.05, 0.004, x, 0.16, s * 0.013, 0x1e2a34);
      W.box(0.6, 0.03, 0.003, 0, 0.03, s * 0.0135, b.team);
      W.box(LX - 0.05, H - 0.02, 0.003, 0, H / 2, -s * 0.0015, 0x55585a); // anti-slip deck plate
      for (let i = 0; i < 3; i++) W.box(LX - 0.06, 0.004, 0.003, 0, 0.05 + i * 0.07, -s * 0.0035, K.yellow);
      // wall panel stowed against the inside of the side wall; swings up from the wing's outer edge
      const O = b.part(W, 0, H, -s * 0.004, 'mcvpanel');
      O.g.userData.side = s;
      O.box(LX - 0.06, 0.2, 0.01, 0, -0.1, -s * 0.005, CAMO);
      for (const x of [-0.18, 0.02, 0.2]) O.box(0.08, 0.05, 0.003, x, -0.12, -s * 0.0105, 0x1e2a34);
      O.box(LX - 0.06, 0.012, 0.012, 0, -0.006, -s * 0.005, b.team);
      // roof panel folded on the roof; flips over onto the raised wall panel
      const R = b.part(B, mx, y0 + H + 0.007 + (s > 0 ? 0.007 : 0), s * (HZ - 0.01), 'mcvroof');
      R.g.userData.side = s;
      R.box(LX - 0.03, 0.006, 0.25, 0, 0.003, -s * 0.125, CAMO);
      for (let i = 0; i < 3; i++) R.box(LX - 0.05, 0.004, 0.006, 0, 0.007, -s * (0.04 + i * 0.08), K.dark);
    }
    // outriggers: beams slide out sideways, jack legs press down (leg = unit height, scaled to reach the ground)
    for (const x of [-0.56, 0.28])
      for (const s of [-1, 1]) {
        const J = b.part(B, x, fy - 0.01, s * 0.26, 'mcvjack');
        J.g.userData.side = s;
        J.box(0.06, 0.05, 0.1, 0, 0, s * 0.04, K.yellow);
        J.box(0.062, 0.012, 0.03, 0, 0.0, s * 0.085, K.black);
        const Lg = b.part(J, 0, 0, s * 0.07, 'mcvleg');
        Lg.box(0.03, 0.12, 0.03, 0, -0.06, 0, K.yellow);
        J.box(0.036, 0.05, 0.036, 0, -0.03, s * 0.07, K.dark);
        const Pd = b.part(J, 0, 0, s * 0.07, 'mcvpad');
        Pd.box(0.07, 0.012, 0.07, 0, -0.006, 0, K.dark);
      }
    // crane: base on the front of the bed, boom resting on the module
    B.cy(0.06, 0.07, 0.05, 0.27, fy + 0.04, 0.12, K.yellow, 12);
    const C = b.part(B, 0.27, fy + 0.11, 0.12, 'mcvcrane');
    C.g.rotation.y = Math.PI;
    C.g.rotation.z = -0.13;
    C.cbox(0.8, 0.06, 0.06, 0.01, 0.4, 0.04, 0, K.yellow);
    C.cbox(0.3, 0.045, 0.045, 0.008, 0.7, 0.04, 0, K.yellow);
    C.strut([0.05, -0.02, 0], [0.2, 0.02, 0], 0.016, mt(K.steel));
    C.box(0.012, 0.08, 0.012, 0.84, -0.0, 0, K.dark);
    C.box(0.03, 0.03, 0.02, 0.84, -0.05, 0, K.dark);
    for (let i = 0; i < 6; i++) C.box(0.04, 0.004, 0.062, 0.1 + i * 0.12, 0.071, 0, K.black);
    antennas(b, B, 0.45, fy + 0.22, [-0.25, 0.25], 0.24);
    b.bob = 0.5;
    const legTop = fy - 0.01;
    b.custom = (q) => {
      const body = q('body')[0];
      const walls = q('mcvwall');
      const panels = q('mcvpanel');
      const roofs = q('mcvroof');
      const jacks = q('mcvjack');
      const legs = q('mcvleg');
      const pads = q('mcvpad');
      const crane = q('mcvcrane')[0];
      const jz = jacks.map((j) => j.position.z);
      const R0 = 0.035;
      for (const l of legs) l.scale.y = R0 / 0.12;
      for (const p of pads) p.position.y = -R0 + 0.012;
      let last = 0;
      return (s: AnimState) => {
        const d = s.deploy ?? 0;
        const T = d * 4;
        const lift = 0.028 * sstep(0.85, 1.25, T);
        if (body && d > 0) body.position.y += lift;
        if (d === last) return;
        last = d;
        const out = sstep(0.3, 0.75, T);
        const press = sstep(0.6, 1.15, T);
        for (let i = 0; i < jacks.length; i++) {
          const sd = jacks[i].userData.side as number;
          jacks[i].position.z = jz[i] + sd * 0.11 * out;
          // leg reaches from the beam to the ground (body origin = ground; the hull rises by lift)
          const len = R0 + (legTop + lift - R0) * press;
          legs[i].scale.y = len / 0.12;
          pads[i].position.y = -len + 0.012;
        }
        const fold = sstep(1.0, 1.75, T);
        for (const w of walls) w.rotation.x = (w.userData.side as number) * (Math.PI / 2) * fold;
        const up = sstep(1.6, 2.25, T);
        for (const p of panels) p.rotation.x = (p.userData.side as number) * (Math.PI / 2) * up;
        const flip = sstep(2.0, 2.75, T);
        for (const r of roofs) r.rotation.x = (r.userData.side as number) * (Math.PI + 0.13) * flip;
        if (crane) {
          crane.rotation.z = -0.13 + 1.0 * sstep(1.1, 2.0, T);
          crane.rotation.y = Math.PI - 0.9 * sstep(2.0, 3.0, T) + 0.5 * sstep(3.0, 3.8, T);
        }
      };
    };
  });
}

// ---------------------------------------------------------------- UGVs

function ugvTracks(b: Bld, L: number, gauge: number, tw: number, n = 4, rw = 0.034) {
  running(b, {
    wheels: evenly(n, -L / 2 + 0.08, L / 2 - 0.09),
    rw,
    spr: [-L / 2 + 0.035, rw + 0.04, 0.032],
    idl: [L / 2 - 0.035, rw + 0.035, 0.03],
    gauge,
    tw,
    bt: 0.012,
    style: 'ugv',
    teeth: 9,
    arms: false,
  });
}

function ugvRws(b: Bld, parent: Part, x: number, y: number, z: number, heavy = true, s = 0.85) {
  const T = b.part(parent, x, y, z, 'turret');
  const tip = rws(T, 0, 0, 0, s, heavy);
  b.muzzle(T, tip + 0.005, 0.036 * s, 0.012 * s);
  return T;
}

function ugvJaguar(b: Bld) {
  const B = b.body;
  wheelSet(b, [{ x: 0.17, steer: 1 }, { x: 0.0, steer: 0 }, { x: -0.17, steer: -0.6 }], 0.05, 0.05, 0.155);
  B.side([[-0.27, 0.06], [0.24, 0.06], [0.28, 0.11], [0.22, 0.17], [-0.25, 0.175], [-0.27, 0.15]], 0.26, 0, CAMO, 0.01);
  for (const s of [-1, 1]) {
    B.box(0.5, 0.012, 0.06, 0.0, 0.112, s * 0.165, K.dark);
    headlight(B, 0.27, 0.12, s * 0.09, 0.7);
    teamPanel(B, 0.2, 0.02, 0.003, -0.05, 0.13, s * 0.131, b.team);
  }
  // sensor mast with cameras, bumper, comms
  B.cy(0.008, 0.01, 0.08, 0.12, 0.175, -0.07, K.dark, 6);
  B.cbox(0.04, 0.03, 0.05, 0.005, 0.12, 0.27, -0.07, 0x3a3e40);
  B.box(0.004, 0.016, 0.03, 0.142, 0.27, -0.07, GLASS);
  B.box(0.02, 0.03, 0.26, 0.28, 0.08, 0, K.dark);
  B.box(0.08, 0.02, 0.08, -0.18, 0.18, 0.06, 0x3a3e40);
  ugvRws(b, B, -0.02, 0.175, 0.0, true, 0.85);
  antennas(b, B, -0.22, 0.175, [-0.09, 0.09], 0.16);
  b.bob = 0.6;
}

function ugvUran(b: Bld) {
  const B = b.body;
  ugvTracks(b, 0.6, 0.17, 0.085, 5, 0.036);
  B.side([[-0.29, 0.06], [0.24, 0.06], [0.31, 0.12], [0.25, 0.17], [-0.28, 0.175], [-0.3, 0.15]], 0.42, 0, CAMO, 0.01);
  for (const s of [-1, 1]) {
    B.box(0.58, 0.006, 0.09, 0.0, 0.122, s * 0.17, CAMO);
    headlight(B, 0.29, 0.13, s * 0.12, 0.7);
    teamPanel(B, 0.2, 0.02, 0.003, -0.08, 0.15, s * 0.211, b.team);
  }
  grille(B, -0.18, 0.175, 0, 0.1, 0.2, 5);
  b.emit(-0.3, 0.15, 0.1);
  const T = b.part(B, 0.0, 0.175, 0, 'turret');
  T.cy(0.08, 0.09, 0.02, 0, 0, 0, K.dark, 12);
  T.cbox(0.18, 0.07, 0.14, 0.012, 0.0, 0.055, 0, CAMO);
  cannon(b, T, 0.09, 0.06, 0.0, 0.26, 0.0075, { brake: false });
  for (const s of [-1, 1]) {
    for (const y of [0.04, 0.08]) {
      T.cx(0.015, 0.015, 0.18, 0.0, y, s * 0.1, 0x4a5032, 8);
      T.cx(0.011, 0.011, 0.004, 0.091, y, s * 0.1, K.black, 8);
    }
  }
  T.cbox(0.05, 0.035, 0.04, 0.005, 0.02, 0.105, -0.04, 0x3a3e40);
  T.box(0.004, 0.02, 0.028, 0.046, 0.106, -0.04, GLASS);
  antennas(b, B, -0.25, 0.175, [-0.12, 0.12], 0.16);
  b.bob = 0.6;
}

function ugvThemis(b: Bld, barkan = false, iran = false) {
  const B = b.body;
  const L = barkan ? 0.56 : 0.52;
  ugvTracks(b, L, 0.16, 0.09, 4, 0.034);
  // two track pods (hybrid modules) with a low payload deck between
  for (const s of [-1, 1]) {
    B.side([[-L / 2 + 0.01, 0.07], [L / 2 - 0.01, 0.07], [L / 2 + 0.015, 0.1], [L / 2 - 0.03, 0.13], [-L / 2 + 0.03, 0.13], [-L / 2 - 0.015, 0.1]], 0.1, s * 0.16, CAMO, 0.008);
    headlight(B, L / 2 + 0.01, 0.105, s * 0.16, 0.7);
    teamPanel(B, 0.2, 0.02, 0.003, 0.0, 0.11, s * 0.211, b.team);
  }
  B.box(L - 0.08, 0.025, 0.24, 0.0, 0.1, 0, K.dark);
  B.box(L - 0.12, 0.012, 0.22, 0.0, 0.118, 0, CAMO);
  if (iran) B.cbox(0.24, 0.06, 0.2, 0.01, 0.0, 0.15, 0, CAMO);
  else B.cbox(0.16, 0.04, 0.16, 0.008, -0.05, 0.14, 0, CAMO);
  B.box(0.06, 0.03, 0.06, -0.18, 0.14, 0.0, 0x3a3e40);
  const y = iran ? 0.18 : 0.16;
  if (iran) {
    const T = b.part(B, 0.0, y, 0, 'turret');
    T.cy(0.05, 0.06, 0.02, 0, 0, 0, K.dark, 10);
    T.cbox(0.1, 0.05, 0.09, 0.008, 0.0, 0.045, 0, CAMO);
    mgun(T, 0.03, 0.05, 0.0, 0.1, 0.005, true);
    b.muzzle(T, 0.17, 0.052, 0);
    T.cbox(0.04, 0.03, 0.03, 0.004, 0.0, 0.085, -0.03, 0x3a3e40);
  } else ugvRws(b, B, barkan ? 0.04 : 0.0, y, 0, true, barkan ? 0.9 : 0.8);
  antennas(b, B, -L / 2 + 0.05, 0.12, [-0.08, 0.08], 0.16);
  b.bob = 0.5;
}

function ugvMissionMaster(b: Bld) {
  const B = b.body;
  wheelSet(b, [{ x: 0.2, steer: 1 }, { x: 0.07, steer: 0.5 }, { x: -0.07, steer: -0.5 }, { x: -0.2, steer: -1 }], 0.045, 0.045, 0.16);
  B.side([[-0.27, 0.05], [0.25, 0.05], [0.28, 0.09], [0.24, 0.13], [-0.26, 0.135], [-0.28, 0.11]], 0.26, 0, CAMO, 0.01);
  for (const s of [-1, 1]) {
    B.box(0.5, 0.012, 0.06, 0.0, 0.098, s * 0.165, K.dark);
    headlight(B, 0.27, 0.1, s * 0.09, 0.7);
    teamPanel(B, 0.2, 0.02, 0.003, -0.05, 0.11, s * 0.131, b.team);
  }
  // cargo / weapon rack and sensor head
  for (const s of [-1, 1]) B.box(0.4, 0.04, 0.012, -0.03, 0.155, s * 0.12, K.dark);
  B.cy(0.008, 0.01, 0.07, 0.2, 0.135, 0.0, K.dark, 6);
  B.cbox(0.04, 0.03, 0.05, 0.005, 0.2, 0.22, 0.0, 0x3a3e40);
  B.box(0.004, 0.016, 0.03, 0.222, 0.22, 0.0, GLASS);
  ugvRws(b, B, -0.06, 0.135, 0.0, true, 0.8);
  antennas(b, B, -0.23, 0.135, [-0.08, 0.08], 0.16);
  b.bob = 0.5;
}

function ugv(style: ModelStyle, fog: FogOfWar | null): Model {
  const fn = UGV[style.faction] ?? ((b: Bld) => ugvThemis(b));
  return build('ugv', style, fog, fn);
}

const UGV: Record<string, (b: Bld) => void> = {
  israel: ugvJaguar,
  russia: ugvUran,
  ukraine: (b) => ugvThemis(b),
  germany: ugvMissionMaster,
  turkey: (b) => ugvThemis(b, true),
  iran: (b) => ugvThemis(b, false, true),
};

// ---------------------------------------------------------------- robot dog

function robodog(style: ModelStyle, fog: FogOfWar | null): Model {
  return build('robodog', style, fog, (b) => {
    const f = b.f;
    const shell = f === 'china' ? 0x3c4436 : f === 'korea' ? 0x5c6066 : 0x2e3134;
    const accent = f === 'china' ? 0x252a22 : 0x1e2022;
    const B = b.body;
    const by = 0.2; // body centre height
    B.cbox(0.3, 0.07, 0.13, 0.016, 0, by, 0, shell);
    B.cbox(0.26, 0.02, 0.11, 0.008, 0, by + 0.043, 0, accent);
    B.cbox(0.22, 0.025, 0.12, 0.008, 0, by - 0.045, 0, accent);
    for (const s of [-1, 1]) {
      teamPanel(B, 0.12, 0.016, 0.003, -0.02, by + 0.005, s * 0.066, b.team);
      // hip actuator housings
      for (const x of [-0.12, 0.12]) B.cz(0.03, 0.03, 0.03, x, by - 0.02, s * 0.075, accent, 10);
    }
    // sensor head with glowing eyes
    B.cbox(0.06, 0.05, 0.09, 0.012, 0.165, by + 0.005, 0, shell);
    B.box(0.006, 0.026, 0.07, 0.196, by + 0.006, 0, mt(K.black));
    for (const s of [-1, 1]) B.box(0.004, 0.01, 0.014, 0.2, by + 0.008, s * 0.02, EYE);
    for (const s of [-1, 1]) B.box(0.006, 0.012, 0.02, 0.14, by - 0.03, s * 0.068, mt(K.black));
    B.box(0.006, 0.012, 0.03, -0.152, by, 0, mt(K.black));
    B.cy(0.004, 0.004, 0.08, -0.12, by + 0.035, -0.04, K.black, 4);
    // weapon pod on the back (turret)
    const T = b.part(B, -0.01, by + 0.055, 0, 'turret');
    T.cy(0.03, 0.035, 0.015, 0, 0, 0, accent, 10);
    T.cbox(0.11, 0.035, 0.05, 0.008, 0.0, 0.035, 0, shell);
    T.box(0.13, 0.016, 0.014, 0.04, 0.037, 0.0, mt(K.gun));
    T.cx(0.004, 0.004, 0.1, 0.15, 0.04, 0.0, mt(K.dark), 6);
    T.box(0.024, 0.028, 0.016, 0.0, 0.016, 0.03, f === 'china' ? 0x4a5032 : K.dark);
    T.box(0.03, 0.02, 0.022, 0.06, 0.06, 0, 0x3a3e40);
    T.box(0.004, 0.012, 0.016, 0.076, 0.06, 0, GLASS);
    b.muzzle(T, 0.205, 0.04, 0);
    // legs: hip (abduction + swing) -> thigh -> knee -> shin -> foot
    const L1 = 0.1;
    const L2 = 0.11;
    let i = 0;
    for (const x of [0.12, -0.12]) {
      for (const s of [-1, 1]) {
        const hip = b.part(B, x, by - 0.02, s * 0.092, 'hip' + i);
        hip.cz(0.024, 0.024, 0.026, 0, 0, 0, shell, 10);
        hip.cbox(0.03, L1, 0.026, 0.008, 0, -L1 / 2, 0, shell);
        hip.box(0.01, L1 * 0.7, 0.028, 0.012, -L1 / 2, 0, accent);
        const knee = b.part(hip, 0, -L1, 0, 'knee' + i);
        knee.cz(0.016, 0.016, 0.024, 0, 0, 0, accent, 8);
        knee.cbox(0.018, L2, 0.018, 0.005, 0, -L2 / 2, 0, accent);
        knee.sph(0.014, 0, -L2, 0, K.rubber, 8, 6);
        i++;
      }
    }
    b.gauge = 0.09;
    b.tw = 0.03;
    b.bob = 0;
    b.custom = (q) => {
      const hips = [0, 1, 2, 3].map((k) => q('hip' + k)[0]);
      const knees = [0, 1, 2, 3].map((k) => q('knee' + k)[0]);
      const body = q('body')[0];
      if (hips.some((h) => !h) || knees.some((k) => !k) || !body) return undefined;
      // diagonal pairs (FL+RR, FR+RL) in phase for a trot
      const phase = [0, Math.PI, Math.PI, 0];
      let blend = 0;
      const ph0 = Math.random() * 10;
      return (s) => {
        blend += ((s.moving ? 1 : 0) - blend) * Math.min(1, s.dt * 6);
        const g = (s.dist / 0.16) * Math.PI;
        let lift = 0;
        for (let k = 0; k < 4; k++) {
          const ph = g + phase[k];
          const front = k < 2;
          const sw = Math.sin(ph) * 0.42 * blend;
          const up = Math.max(0, Math.cos(ph)) * 0.55 * blend;
          const idle = Math.sin(s.time * 1.3 + ph0 + k) * 0.03 * (1 - blend);
          // knees point backward: thigh leans forward, shin back
          hips[k].rotation.z = (front ? -0.5 : -0.6) + sw - up * 0.35 + idle;
          knees[k].rotation.z = (front ? 1.0 : 1.2) + up * 1.1 - idle * 0.5;
          lift += up;
        }
        body.position.y = Math.sin(g * 2) * 0.004 * blend + Math.sin(s.time * 1.7 + ph0) * 0.002 * (1 - blend) - lift * 0.0;
        body.rotation.x = Math.sin(s.time * 0.9 + ph0) * 0.015 * (1 - blend) + Math.sin(g) * 0.02 * blend;
        body.rotation.z = Math.sin(s.time * 0.7 + ph0) * 0.01 * (1 - blend);
      };
    };
  });
}

// @@MORE@@

export const VEHICLES: Record<string, Builder> = {
  mbt,
  mbt_heavy: mbt,
  apc,
  aa,
  laser,
  arty,
  tos,
  ew,
  berge,
  swarm,
  missile_truck: missileTruck,
  ...Object.fromEntries(Object.entries(TELS).map(([k, c]) => [k, telModel(k, c)])),
  container,
  harvester,
  mcv,
  ugv,
  robodog,
};
