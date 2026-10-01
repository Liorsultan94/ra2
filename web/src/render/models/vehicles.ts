import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { factionCamo, pbrMaterial, worldUV } from '../textures';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle } from './types';

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
  glassC: 0x0c141c,
  mesh: 0x3c4044,
};

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
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

const scaleP = (p: P2[], sx: number, sz: number, dx = 0, dz = 0): P2[] => p.map(([x, z]) => [x * sx + dx, z * sz + dz] as P2);

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
function glowMat(color: number, intensity: number, fog: FogOfWar | null, pulse = false) {
  return cmat(`glow${color}|${intensity}|${pulse}`, fog, () => {
    const m = new THREE.MeshStandardMaterial({ color: shade(color, 0.4), emissive: color, emissiveIntensity: intensity, roughness: 0.35, metalness: 0, toneMapped: false });
    if (pulse) m.userData.pulse = true;
    return m;
  });
}

const TREAD_K = 4; // texture repeats per world unit along the belt (6 links per repeat)

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
    let list = this.buckets.get(key);
    if (!list) this.buckets.set(key, (list = []));
    list.push(g);
    this.tris += g.attributes.position.count / 3;
    return this;
  }
  merged(key: string): THREE.BufferGeometry | null {
    const list = this.buckets.get(key);
    if (!list || !list.length) return null;
    return list.length === 1 ? list[0] : mergeGeometries(list, false);
  }
}

class Part extends Acc {
  constructor(
    readonly b: Bld,
    readonly g: THREE.Object3D,
  ) {
    super();
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
  stats: { tris: number; meshes: number };
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
  custom?: CustomAnim;
  private mi = 0;
  extraTris = 0;
  constructor(
    readonly style: ModelStyle,
    readonly fog: FogOfWar | null,
  ) {
    this.f = style.faction;
    this.camoOpts = factionCamo(style.faction);
    this.base = this.camoOpts.color ?? 0x8a8070;
    this.baseD = shade(this.base, 0.72);
    this.team = style.team;
    this.body = this.part(this.root, 0, 0, 0, 'body');
    this.chassis = this.body;
  }
  part(parent: Part | THREE.Object3D, x = 0, y = 0, z = 0, tag?: string): Part {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    if (tag) g.userData.tag = tag;
    (parent instanceof Part ? parent.g : parent).add(g);
    const p = new Part(this, g);
    this.parts.push(p);
    return p;
  }
  muzzle(p: Part | THREE.Object3D, x: number, y: number, z: number) {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    o.userData.tag = 'muzzle';
    o.userData.mi = this.mi++;
    (p instanceof Part ? p.g : p).add(o);
    return o;
  }
  emit(x: number, y: number, z: number, kind: 'smoke' | 'steam' | 'spark' | 'fire' = 'smoke') {
    this.emitters.push({ pos: new THREE.Vector3(x, y, z), kind });
  }
  material(key: string): THREE.Material {
    const fog = this.fog;
    let m: THREE.Material;
    switch (key) {
      case 'D':
        m = cmat('vdull', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.12 }));
        break;
      case 'M':
        m = cmat('vmetal', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.72 }));
        break;
      case 's' + CAMO:
        return pbrMaterial('camo', this.camoOpts, fog);
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
        m = cmat('vdull', fog, () => new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.78, metalness: 0.12 }));
    }
    if (key.startsWith('s') && key !== 's' + CAMO && !this.glow.includes(m)) this.glow.push(m);
    return m;
  }
  /** Wheel set as one InstancedMesh (geometry: axle along Z, outer face toward +Z, centred on the origin). */
  wheels(parent: Part | THREE.Object3D, geo: THREE.BufferGeometry, entries: WheelEntry[], tag = 'wheels') {
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
  finish(): Tpl {
    let tris = this.extraTris;
    let meshes = 0;
    for (const p of this.parts) {
      for (const key of p.buckets.keys()) {
        const g = p.merged(key);
        if (!g) continue;
        g.computeBoundingSphere();
        const mesh = new THREE.Mesh(g, this.material(key));
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
    const box = new THREE.Box3().setFromObject(this.root);
    const size = { x: box.max.x - box.min.x, y: box.max.y, z: box.max.z - box.min.z };
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
      stats: { tris: Math.round(tris), meshes },
    };
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
  return pbrMaterial('tread', { color: 0x3a3936, divisions: 6, grime: 0.55, seed: 3 }, fog);
}

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
  return m;
}

// ------------------------------------------------------------- wheel styles

type WheelStyle = 'nato' | 'sov' | 't80' | 'merk' | 'asia' | 'light' | 'ugv';

const gDisc = (r: number, seg = 12) => new THREE.CircleGeometry(r, seg);
const gRing = (r0: number, r1: number, seg = 14) => new THREE.RingGeometry(r0, r1, seg, 1);

/** Road wheel: axle along Z, outer face toward +Z, centred on the origin (low poly: faces are discs). */
function roadWheelGeo(b: Bld, r: number, w: number, style: WheelStyle): THREE.BufferGeometry {
  const a = new Acc();
  const disc = style === 'sov' || style === 't80' ? shade(b.base, 0.8) : shade(b.base, 0.9);
  const hub = 0x3e4144;
  const zf = w / 2;
  a.add(gCylZ(r, r, w, 14, true), K.rubber);
  a.add(gRing(r * 0.8, r, 14), K.rubber, TR(0, 0, zf));
  a.add(gRing(r * 0.8, r, 14), K.rubber, TR(0, 0, -zf, 0, Math.PI, 0));
  a.add(gCylZ(r * 0.78, r * 0.8, 0.008, 14, true), disc, TR(0, 0, zf - 0.004));
  a.add(gDisc(r * 0.78, 14), disc, TR(0, 0, zf - 0.004 + 0.004));
  if (style === 'sov') {
    for (let i = 0; i < 8; i++) {
      const t = (i / 8) * Math.PI * 2;
      a.add(new THREE.PlaneGeometry(r * 0.4, r * 0.08), shade(disc, 0.55), TR(Math.cos(t) * r * 0.55, Math.sin(t) * r * 0.55, zf + 0.002, 0, 0, t));
    }
  } else if (style === 't80') {
    a.add(gRing(r * 0.5, r * 0.6, 14), shade(disc, 0.7), TR(0, 0, zf + 0.001));
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2;
      a.add(gDisc(r * 0.08, 5), K.dark, TR(Math.cos(t) * r * 0.38, Math.sin(t) * r * 0.38, zf + 0.002));
    }
  } else {
    const holes = style === 'merk' ? 0 : style === 'asia' ? 5 : style === 'light' || style === 'ugv' ? 4 : 6;
    for (let i = 0; i < holes; i++) {
      const t = (i / holes) * Math.PI * 2;
      a.add(gDisc(r * 0.11, 6), K.dark, TR(Math.cos(t) * r * 0.5, Math.sin(t) * r * 0.5, zf + 0.002));
    }
    if (style === 'merk') {
      for (let i = 0; i < 6; i++) {
        const t = (i / 6) * Math.PI * 2;
        a.add(new THREE.PlaneGeometry(r * 0.46, r * 0.08), shade(disc, 0.6), TR(Math.cos(t) * r * 0.45, Math.sin(t) * r * 0.45, zf + 0.002, 0, 0, t));
      }
    }
  }
  a.add(gCylZ(r * 0.22, r * 0.3, 0.016, 8), hub, TR(0, 0, zf + 0.006));
  a.add(new THREE.PlaneGeometry(r * 0.36, r * 0.06), 0x8a8e90, TR(0, 0, zf + 0.0145));
  return a.merged('D')!;
}

/** Drive sprocket: toothed rim + hub. */
function sprocketGeo(b: Bld, r: number, w: number, teeth = 12): THREE.BufferGeometry {
  const a = new Acc();
  const c = 0x3a3c3c;
  const zf = w / 2;
  a.add(gCylZ(r * 0.84, r * 0.84, w * 0.9, teeth, true), c);
  for (let i = 0; i < teeth; i++) {
    const t = (i / teeth) * Math.PI * 2;
    a.add(new THREE.BoxGeometry(r * 0.26, r * 0.2, w * 0.9), 0x47473f, TR(Math.cos(t) * r * 0.9, Math.sin(t) * r * 0.9, 0, 0, 0, t));
  }
  a.add(gDisc(r * 0.84, teeth), shade(b.base, 0.75), TR(0, 0, zf * 0.9));
  a.add(gCylZ(r * 0.3, r * 0.42, 0.02, 8), 0x3e4144, TR(0, 0, zf * 0.9 + 0.008));
  for (let i = 0; i < 6; i++) {
    const t = (i / 6) * Math.PI * 2 + 0.5;
    a.add(gDisc(r * 0.09, 5), K.dark, TR(Math.cos(t) * r * 0.6, Math.sin(t) * r * 0.6, zf * 0.9 + 0.001));
  }
  return a.merged('D')!;
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
    const zc = side * t.gauge;
    const geo = beltGeo(loop, zc - t.tw / 2, zc + t.tw / 2, bt, k);
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
    list.push({ x: t.idl[0], y: t.idl[1], z, r: t.idl[2], s: t.idl[2] / t.rw, flip: side < 0 ? 1 : 0, steer: 0 });
  }
  b.wheels(b.root, rwGeo, list);
  const spGeo = sprocketGeo(b, t.spr[2], ww, t.teeth ?? 12);
  b.wheels(
    b.root,
    spGeo,
    [-1, 1].map((side) => ({ x: t.spr[0], y: t.spr[1], z: side * t.gauge, r: t.spr[2], s: 1, flip: side < 0 ? 1 : 0, steer: 0 })),
    'wheels',
  );
  // return rollers (static) and suspension arms / hubs
  const c = b.chassis;
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
  b.gauge = t.gauge;
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
  b.gauge = zc;
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
    p.add(gCylX(r, r, 0.036, 5), mt(K.gun), m);
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

/** Hatch: low cylinder with a hinge and handle. */
function hatch(p: Part, x: number, y: number, z: number, r = 0.03, paint = CAMO) {
  p.cy(r, r * 1.04, 0.008, x, y, z, paint, 12);
  p.box(0.01, 0.006, r * 1.2, x - r * 0.9, y + 0.006, z, K.dark);
  p.box(r * 0.8, 0.004, 0.004, x + r * 0.1, y + 0.011, z, mt(K.steel));
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
  p.cbox(w, h, d, Math.min(0.004, h * 0.2), x, y + h / 2, z, paint, 0, ry, 0);
  p.box(w * 1.01, 0.003, d * 1.01, x, y + h * 0.82, z, K.dark, 0, ry, 0);
  p.box(0.006, 0.006, 0.006, x + w * 0.3, y + h * 0.6, z + (d / 2) * Math.sign(z || 1), mt(K.steel));
  p.box(0.006, 0.006, 0.006, x - w * 0.3, y + h * 0.6, z + (d / 2) * Math.sign(z || 1), mt(K.steel));
}

/** Jerry can standing on y, long side along X. */
function jerry(p: Part, x: number, y: number, z: number, c = 0x4c5434) {
  p.cbox(0.032, 0.046, 0.016, 0.003, x, y + 0.023, z, c);
  p.box(0.01, 0.006, 0.006, x + 0.008, y + 0.049, z, c);
}

/** Tow cable along a polyline with eye loops. */
function cable(p: Part, pts: V3[], r = 0.0045) {
  p.tube(pts, r, mt(0x3c3a36), 5);
  for (const e of [pts[0], pts[pts.length - 1]]) p.add(new THREE.TorusGeometry(r * 2.4, r * 0.8, 4, 8), mt(0x3c3a36), TR(e[0], e[1], e[2], 0, 0, 0));
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
      p.add(g, paint, m.clone().multiply(TR(u0 + du * (i + 0.5), th / 2, v)));
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
  const piv = b.part(tur, x, y, z);
  piv.g.rotation.z = o.elev ?? 0.02;
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
  for (const t of [0.3, 0.64]) rec.cx(r * 1.4, r * 1.4, 0.008, L * t, 0, 0, mt(K.gun), 12);
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

function build(key: string, style: ModelStyle, fog: FogOfWar | null, fn: (b: Bld) => void): Model {
  const ck = `${key}|${style.faction}|${style.team}|${fogId(fog)}`;
  let t = templates.get(ck);
  if (!t) {
    const b = new Bld(style, fog);
    fn(b);
    t = b.finish();
    templates.set(ck, t);
  }
  return instantiate(t, fog);
}

function instantiate(t: Tpl, fog: FogOfWar | null): Model {
  const root = t.root.clone(true);
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
  const wheelSets = q('wheels') as THREE.InstancedMesh[];
  const body = q('body')[0];
  const bodyY = body ? body.position.y : 0;
  const whips = q('whip');
  const spins = q('spin');
  const custom = t.custom ? t.custom(q, model) : undefined;
  const ph = Math.random() * 100;
  let turnAcc = 0;
  let lastSpeed = 0;
  let acc = 0;
  let pitch = 0;
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
      const sp = Math.min(1, s.speed / 1.5);
      const target = clamp(acc * 0.012, -0.035, 0.035) * t.bob;
      pitch += (target - pitch) * Math.min(1, dt * 8);
      body.rotation.z = pitch;
      body.rotation.x = clamp(s.turn * s.speed * 0.025, -0.03, 0.03) * t.bob;
      body.position.y = bodyY + (s.moving ? Math.sin(s.dist * 21 + ph) * 0.0022 * sp * t.bob : 0);
    }
    for (const w of whips) {
      const sp = Math.min(s.speed, 3);
      w.rotation.z = -sp * 0.07 - acc * 0.01 + Math.sin(s.time * 8 + ph) * 0.035 * Math.min(1, sp + 0.2);
      w.rotation.x = Math.sin(s.time * 5.3 + ph * 1.7) * 0.02 * Math.min(1, sp + 0.3);
    }
    for (const o of spins) {
      const rate = (o.userData.rate as number) ?? 1;
      const ax = (o.userData.axis as 'x' | 'y' | 'z') ?? 'y';
      o.rotation[ax] = ph + s.time * rate;
    }
    if (custom) custom(s);
  };
  return model;
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
export function vehicleStats(): Record<string, { tris: number; meshes: number }> {
  const out: Record<string, { tris: number; meshes: number }> = {};
  for (const [k, t] of templates) out[k] = t.stats;
  return out;
}

void mixc;

// =============================================================== tanks

/** Lower hull between the tracks (side profile, width 2*hw). */
function lowerHull(p: Part, pts: P2[], hw: number) {
  p.side(pts, hw * 2, 0, CAMO, 0.01);
}

/** Side skirt plate (profile in x/y) on both sides at |z| = zs, with panel seams. */
function skirts(p: Part, pts: P2[], zs: number, th: number, seams: number[], paint: number = CAMO, seamY: [number, number] = [0.09, 0.18]) {
  for (const s of [-1, 1]) {
    p.side(pts, th, s * zs, paint, Math.min(0.004, th * 0.3));
    for (const x of seams) p.box(0.004, seamY[1] - seamY[0], 0.003, x, (seamY[0] + seamY[1]) / 2, s * (zs + th / 2 + 0.001), K.dark);
  }
}

function mbtAbrams(b: Bld) {
  const B = b.body;
  running(b, {
    wheels: evenly(7, -0.355, 0.33),
    rw: 0.05,
    spr: [-0.465, 0.11, 0.05],
    idl: [0.445, 0.098, 0.045],
    rollers: [
      [-0.22, 0.138, 0.016],
      [0.12, 0.138, 0.016],
    ],
    gauge: 0.243,
    tw: 0.13,
    style: 'nato',
  });
  const W = 0.62;
  lowerHull(B, [[-0.5, 0.06], [0.42, 0.06], [0.53, 0.165], [-0.52, 0.165]], 0.172);
  // upper hull with sponsons (shallow glacis, flat deck)
  B.side(
    [
      [-0.525, 0.165],
      [0.54, 0.165],
      [0.565, 0.19],
      [0.3, 0.255],
      [-0.5, 0.257],
      [-0.528, 0.235],
    ],
    W,
    0,
    CAMO,
    0.008,
  );
  // skirts: heavy front panels, thinner rear
  skirts(B, [[-0.47, 0.095], [0.18, 0.095], [0.18, 0.2], [-0.48, 0.2]], 0.317, 0.01, [-0.32, -0.16, 0.0, 0.16]);
  skirts(B, [[0.18, 0.085], [0.45, 0.085], [0.545, 0.15], [0.55, 0.2], [0.18, 0.2]], 0.32, 0.018, [0.33]);
  bolts(B, [-0.44, 0.19, 0.324], [0.6, 0, 0], 10, 'z');
  // front fender lights and driver
  for (const s of [-1, 1]) {
    headlight(B, 0.548, 0.2, s * 0.255);
    taillight(B, -0.53, 0.235, s * 0.27);
    bin(B, 0.12, 0.04, 0.07, -0.43, 0.257, s * 0.255);
  }
  hatch(B, 0.36, 0.236, 0, 0.034);
  for (const z of [-0.035, 0, 0.035]) periscope(B, 0.41, 0.232, z, 0, 0.02);
  // engine deck: grilles and access panels, rear exhaust grille
  grille(B, -0.39, 0.257, 0, 0.14, 0.3, 8);
  for (const x of [-0.14, -0.25]) B.box(0.1, 0.004, 0.22, x, 0.258, 0, shade(b.base, 0.88));
  B.box(0.012, 0.05, 0.36, -0.531, 0.205, 0, K.black);
  for (let i = 0; i < 5; i++) B.box(0.006, 0.004, 0.36, -0.535, 0.188 + i * 0.009, 0, CAMO);
  cable(B, [[-0.52, 0.245, -0.22], [-0.53, 0.22, -0.1], [-0.53, 0.22, 0.1], [-0.52, 0.245, 0.22]]);
  for (const s of [-1, 1]) B.box(0.03, 0.026, 0.04, 0.47, 0.095, s * 0.12, K.dark);
  teamPanel(B, 0.004, 0.035, 0.12, -0.533, 0.24, 0.0, b.team);
  b.emit(-0.54, 0.205, 0.08);
  b.emit(-0.54, 0.205, -0.08);

  // ---- turret: flat angular with a big bustle
  const T = b.part(B, -0.03, 0.257, 0, 'turret');
  const plan = mirrorZ([
    [0.28, 0],
    [0.28, 0.065],
    [0.17, 0.235],
    [-0.06, 0.25],
    [-0.17, 0.243],
    [-0.21, 0.215],
    [-0.36, 0.205],
    [-0.375, 0],
  ]);
  T.loft(
    [
      { y: 0, p: plan },
      { y: 0.085, p: inset(plan, 0.006) },
      { y: 0.118, p: inset(plan, 0.024) },
    ],
    CAMO,
  );
  T.cy(0.21, 0.21, 0.012, -0.02, -0.01, 0, K.dark, 20);
  // gun slot / mantlet face
  T.box(0.02, 0.07, 0.12, 0.275, 0.058, 0, K.dark);
  // bustle rack with stowage
  const rk = 0x3a3d34;
  for (const y of [0.035, 0.1]) {
    T.box(0.006, 0.006, 0.44, -0.47, y, 0, rk);
    for (const s of [-1, 1]) T.box(0.27, 0.006, 0.006, -0.335, y, s * 0.22, rk);
  }
  for (let i = 0; i < 6; i++) {
    const z = -0.2 + i * 0.08;
    T.box(0.006, 0.07, 0.006, -0.47, 0.068, z, rk);
  }
  for (const s of [-1, 1]) for (const x of [-0.24, -0.33, -0.42]) T.box(0.006, 0.07, 0.006, x, 0.068, s * 0.22, rk);
  T.box(0.27, 0.004, 0.44, -0.335, 0.03, 0, rk);
  T.cbox(0.09, 0.06, 0.16, 0.012, -0.415, 0.065, 0.08, K.canvas);
  T.cbox(0.08, 0.05, 0.14, 0.012, -0.42, 0.058, -0.11, K.khaki);
  T.cbox(0.07, 0.04, 0.08, 0.01, -0.33, 0.05, -0.14, K.olive);
  teamPanel(T, 0.006, 0.026, 0.3, -0.474, 0.075, 0, b.team);
  for (const s of [-1, 1]) teamPanel(T, 0.16, 0.022, 0.004, -0.01, 0.06, s * 0.247, b.team, 0, s * 0.06, 0);
  // roof: commander CROWS (right), loader MG (left), sights
  T.cy(0.05, 0.055, 0.016, -0.06, 0.118, 0.105, CAMO, 14);
  rws(T, -0.05, 0.134, 0.105, 1.05, true);
  hatch(T, -0.07, 0.118, -0.11, 0.038);
  T.box(0.03, 0.04, 0.07, 0.0, 0.14, -0.13, CAMO);
  mgun(T, 0.0, 0.17, -0.13, 0.1);
  T.cbox(0.075, 0.045, 0.055, 0.008, 0.13, 0.14, 0.13, CAMO);
  T.box(0.004, 0.026, 0.04, 0.168, 0.143, 0.13, GLASS);
  T.cy(0.018, 0.022, 0.03, 0.09, 0.118, -0.06, K.dark, 10);
  T.cbox(0.04, 0.03, 0.04, 0.006, 0.09, 0.163, -0.06, CAMO);
  T.box(0.004, 0.018, 0.026, 0.111, 0.164, -0.06, GLASS);
  for (let i = 0; i < 6; i++) periscope(T, -0.06 + Math.cos(i) * 0.05, 0.118, 0.105 + Math.sin(i) * 0.05, -i, 0.016);
  T.cy(0.004, 0.004, 0.05, -0.3, 0.118, 0.04, K.dark, 4);
  T.box(0.02, 0.006, 0.006, -0.3, 0.17, 0.04, K.dark);
  for (const s of [-1, 1]) smokeBank(T, 0.13, 0.085, s * 0.228, s, 6, 0.95);
  antennas(b, T, -0.25, 0.118, [-0.17, 0.17], 0.24);
  mainGun(b, T, 0.27, 0.058, 0, { len: 0.66, r: 0.018, fume: 0.4, mrs: true, mantlet: [0.06, 0.07, 0.1] });
}

function mbt(style: ModelStyle, fog: FogOfWar | null): Model {
  const f = style.faction;
  const fn = MBT[f] ?? mbtAbrams;
  return build('mbt', style, fog, fn);
}

const MBT: Record<string, (b: Bld) => void> = {
  usa: mbtAbrams,
};

// @@MORE@@

export const VEHICLES: Record<string, Builder> = {
  mbt,
  mbt_heavy: mbt,
};
