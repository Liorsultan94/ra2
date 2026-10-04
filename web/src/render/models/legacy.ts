import * as THREE from 'three';
import type { FogOfWar } from '../fog';
import { onFogRelease, purgeKeys } from '../fogcache';

/*
 * Procedural unit / building models. Everything is built from Three.js
 * primitives; geometries and materials are cached and shared between
 * instances. Conventions: 1 tile = 1 unit, Y up, units face +X, buildings
 * are centred on their footprint with their "front" (doors, bays) on +Z.
 */

export interface ModelStyle {
  team: number; // player colour (stripes, panels, flags' team trim)
  hull: number; // faction vehicle paint
  accent: number; // faction building trim colour
  flag: number[]; // 3 stripe colours of the faction flag
}

export interface Model {
  root: THREE.Group;
  turret?: THREE.Object3D;
  muzzles: THREE.Object3D[];
  spinners: { obj: THREE.Object3D; axis: 'x' | 'y' | 'z'; speed: number }[];
  legs?: [THREE.Object3D, THREE.Object3D];
  rotors: THREE.Object3D[];
  glow: THREE.Material[];
  height: number;
  emitters: { pos: THREE.Vector3; kind: 'smoke' | 'steam' | 'spark' }[];
  recoil?: THREE.Object3D[];
}

type V3 = [number, number, number];
type P2 = [number, number];

// ------------------------------------------------------------------ palette

const C = {
  rubber: 0x1d1e1f,
  dark: 0x2b2d30,
  wheel: 0x3a3c3b,
  steel: 0x70757a,
  gun: 0x383c40,
  concrete: 0xb9b3a4,
  slab: 0x8e8a81,
  asphalt: 0x3a3c3f,
  roof: 0x4a4e54,
  glass: 0x18242e,
  skin: 0xd6a27a,
  yellow: 0xe2b021,
  white: 0xe6e6e2,
  sand: 0xa99a70,
  ore: 0xe0a92a,
  rust: 0x8c4a2f,
  win: 0xffc766,
  cyan: 0x5fdcff,
  red: 0xff2a1a,
  green: 0x2bff5a,
  amber: 0xffa21a,
  lamp: 0xfff1d0,
};

function mix(a: number, b: number, t: number): number {
  const ca = new THREE.Color(a);
  const cb = new THREE.Color(b);
  return ca.lerp(cb, t).getHex();
}
function shade(a: number, f: number): number {
  const c = new THREE.Color(a);
  c.r = Math.min(1, c.r * f);
  c.g = Math.min(1, c.g * f);
  c.b = Math.min(1, c.b * f);
  return c.getHex();
}

// ------------------------------------------------------------ geometry cache

const geoCache = new Map<string, THREE.BufferGeometry>();
const matCache = new Map<string, THREE.Material>();
// a finished match: drop its fog's materials (fogcache.ts)
onFogRelease((f) => {
  const id = fogIds.get(f);
  if (id !== undefined) purgeKeys(matCache, (k) => k.startsWith('f' + id + '|'));
});
const fogIds = new WeakMap<FogOfWar, number>();
let fogSeq = 0;

function G<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geoCache.get(key) as T | undefined;
  if (!g) {
    g = make();
    geoCache.set(key, g);
  }
  return g;
}
const kf = (...a: number[]) => a.map((n) => Math.round(n * 10000) / 10000).join(',');

const gBox = (w: number, h: number, d: number) => G('box' + kf(w, h, d), () => new THREE.BoxGeometry(w, h, d));
const gCyl = (rt: number, rb: number, h: number, s = 12, open = false) =>
  G('cyl' + kf(rt, rb, h, s) + (open ? 'o' : ''), () => new THREE.CylinderGeometry(rt, rb, h, s, 1, open));
/** Cylinder with its axis along X (radiusTop at +X). */
const gCylX = (rt: number, rb: number, h: number, s = 12) =>
  G('cx' + kf(rt, rb, h, s), () => new THREE.CylinderGeometry(rt, rb, h, s).rotateZ(-Math.PI / 2));
/** Cylinder with its axis along Z (radiusTop at +Z). */
const gCylZ = (rt: number, rb: number, h: number, s = 12) =>
  G('cz' + kf(rt, rb, h, s), () => new THREE.CylinderGeometry(rt, rb, h, s).rotateX(Math.PI / 2));
const gSph = (r: number, ws = 12, hs = 8) => G('sph' + kf(r, ws, hs), () => new THREE.SphereGeometry(r, ws, hs));
const gHemi = (r: number, ws = 12, hs = 6) =>
  G('hemi' + kf(r, ws, hs), () => new THREE.SphereGeometry(r, ws, hs, 0, Math.PI * 2, 0, Math.PI / 2));
const gTorus = (R: number, t: number, rs = 6, ts = 18) => G('tor' + kf(R, t, rs, ts), () => new THREE.TorusGeometry(R, t, rs, ts));
const gTorusArc = (R: number, t: number) => G('tora' + kf(R, t), () => new THREE.TorusGeometry(R, t, 4, 16, Math.PI));
const gIco = (r: number) => G('ico' + kf(r), () => new THREE.IcosahedronGeometry(r, 0));
/** Half cylinder (arch) along Z, the round half facing +Y; radius r, length len. */
const gArch = (r: number, len: number, s = 12) =>
  G('arch' + kf(r, len, s), () => new THREE.CylinderGeometry(r, r, len, s, 1, false, -Math.PI / 2, Math.PI).rotateX(-Math.PI / 2));

function shapeOf(pts: P2[]): THREE.Shape {
  const s = new THREE.Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

/** Side profile (x forward, y up) extruded along Z, centred on z = 0. */
function gSide(pts: P2[], depth: number, bevel = 0): THREE.BufferGeometry {
  return G('side' + kf(...pts.flat(), depth, bevel), () => {
    const d = depth - 2 * bevel;
    const g = new THREE.ExtrudeGeometry(shapeOf(pts), {
      depth: d,
      bevelEnabled: bevel > 0,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelOffset: -bevel,
      bevelSegments: 1,
    });
    g.translate(0, 0, -d / 2);
    return g;
  });
}

/** Plan outline (x, z) extruded upward from y = 0 to y = h. */
function gPlan(pts: P2[], h: number, bevel = 0): THREE.BufferGeometry {
  return G('plan' + kf(...pts.flat(), h, bevel), () => {
    const d = h - 2 * bevel;
    const g = new THREE.ExtrudeGeometry(
      shapeOf(pts.map(([x, z]) => [x, -z] as P2)),
      { depth: d, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelOffset: -bevel, bevelSegments: 1 },
    );
    g.rotateX(-Math.PI / 2);
    g.translate(0, bevel, 0);
    return g;
  });
}

/** Lathe around Y from (radius, y) points. */
function gLathe(pts: P2[], seg = 16): THREE.BufferGeometry {
  return G('lathe' + kf(...pts.flat(), seg), () => new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg));
}
/** Lathe whose axis runs along X (points are (radius, x), from tail to nose). */
function gLatheX(pts: P2[], seg = 10): THREE.BufferGeometry {
  return G('lathx' + kf(...pts.flat(), seg), () =>
    new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg).rotateZ(-Math.PI / 2),
  );
}
/** Shallow parabolic dish opening toward +Y. */
function gDish(R: number, depth: number, seg = 16): THREE.BufferGeometry {
  const pts: P2[] = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    pts.push([Math.max(0.001, R * t), depth * t * t]);
  }
  return gLathe(pts, seg);
}

const regular = (n: number, r: number, rot = 0): P2[] => {
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    out.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  return out;
};
const rect = (w: number, d: number): P2[] => [
  [-w / 2, -d / 2],
  [w / 2, -d / 2],
  [w / 2, d / 2],
  [-w / 2, d / 2],
];

const UP = new THREE.Vector3(0, 1, 0);

// ------------------------------------------------------------- build kit

class Kit {
  readonly m: Model;
  readonly fk: string;
  recv = false;

  constructor(
    readonly s: ModelStyle,
    readonly fog: FogOfWar | null,
  ) {
    this.m = { root: new THREE.Group(), muzzles: [], spinners: [], rotors: [], glow: [], height: 0.5, emitters: [] };
    if (fog) {
      let id = fogIds.get(fog);
      if (id === undefined) {
        id = ++fogSeq;
        fogIds.set(fog, id);
      }
      this.fk = 'f' + id;
    } else this.fk = 'n';
  }

  private cached<T extends THREE.Material>(key: string, lit: boolean, make: () => T): T {
    const full = (lit ? this.fk : 'b') + '|' + key;
    let m = matCache.get(full) as T | undefined;
    if (!m) {
      m = make();
      if (lit && this.fog) this.fog.apply(m);
      matCache.set(full, m);
    }
    return m;
  }

  std(color: number, rough = 0.75, metal = 0.1, double = false): THREE.MeshStandardMaterial {
    return this.cached(`std${color}|${rough}|${metal}|${double ? 1 : 0}`, true, () =>
      new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: metal, side: double ? THREE.DoubleSide : THREE.FrontSide }),
    );
  }

  /** Emissive light material (registered in model.glow). */
  glow(color: number, intensity = 2.6): THREE.MeshStandardMaterial {
    const m = this.cached(`glow${color}|${intensity}`, true, () =>
      new THREE.MeshStandardMaterial({
        color: shade(color, 0.35),
        emissive: color,
        emissiveIntensity: intensity,
        roughness: 0.5,
        metalness: 0,
        toneMapped: false,
      }),
    );
    if (!this.m.glow.includes(m)) this.m.glow.push(m);
    return m;
  }

  /** Semi transparent glass (optionally glowing; then it is registered in model.glow). */
  glass(color: number, opacity: number, emissive = 0, ei = 0): THREE.MeshStandardMaterial {
    const m = this.cached(`glass${color}|${opacity}|${emissive}|${ei}`, true, () =>
      new THREE.MeshStandardMaterial({
        color,
        transparent: true,
        opacity,
        roughness: 0.08,
        metalness: 0.4,
        emissive,
        emissiveIntensity: ei,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    if (ei > 0 && !this.m.glow.includes(m)) this.m.glow.push(m);
    return m;
  }

  get team() {
    return this.std(this.s.team, 0.55, 0.15);
  }
  get hull() {
    return this.std(this.s.hull, 0.72, 0.18);
  }
  get hullD() {
    return this.std(shade(this.s.hull, 0.7), 0.8, 0.15);
  }
  get dark() {
    return this.std(C.dark, 0.8, 0.3);
  }
  get rubber() {
    return this.std(C.rubber, 0.95, 0);
  }
  get steel() {
    return this.std(C.steel, 0.45, 0.6);
  }
  get gunM() {
    return this.std(C.gun, 0.5, 0.55);
  }
  get glassM() {
    return this.std(C.glass, 0.15, 0.7);
  }
  get wall() {
    return this.std(mix(0xcfc8b4, this.s.accent, 0.16), 0.85, 0.05);
  }
  get wallD() {
    return this.std(mix(0xa9a28f, this.s.accent, 0.22), 0.85, 0.05);
  }
  get accentM() {
    return this.std(this.s.accent, 0.6, 0.2);
  }
  get roof() {
    return this.std(C.roof, 0.8, 0.2);
  }
  get concrete() {
    return this.std(C.concrete, 0.92, 0);
  }

  mk(p: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0): THREE.Mesh {
    const me = new THREE.Mesh(g, m);
    me.position.set(x, y, z);
    if (rx || ry || rz) me.rotation.set(rx, ry, rz);
    me.castShadow = true;
    me.receiveShadow = this.recv;
    p.add(me);
    return me;
  }
  box(p: THREE.Object3D, m: THREE.Material, w: number, h: number, d: number, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
    return this.mk(p, gBox(w, h, d), m, x, y, z, rx, ry, rz);
  }
  /** Vertical cylinder standing on y (base at y). */
  cyl(p: THREE.Object3D, m: THREE.Material, r: number, h: number, x: number, y: number, z: number, s = 12, rt = r) {
    return this.mk(p, gCyl(rt, r, h, s), m, x, y + h / 2, z);
  }
  strut(p: THREE.Object3D, m: THREE.Material, a: V3, b: V3, r: number, seg = 6) {
    const va = new THREE.Vector3(...a);
    const d = new THREE.Vector3(...b).sub(va);
    const len = d.length();
    const me = this.mk(p, gCyl(r, r, 1, seg), m, a[0] + d.x / 2, a[1] + d.y / 2, a[2] + d.z / 2);
    me.scale.y = len;
    me.quaternion.setFromUnitVectors(UP, d.normalize());
    return me;
  }
  group(p: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, y, z);
    p.add(g);
    return g;
  }
  muzzle(p: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
    const o = new THREE.Object3D();
    o.position.set(x, y, z);
    p.add(o);
    this.m.muzzles.push(o);
    return o;
  }
  spin(obj: THREE.Object3D, axis: 'x' | 'y' | 'z', speed: number) {
    this.m.spinners.push({ obj, axis, speed });
  }
  emit(x: number, y: number, z: number, kind: 'smoke' | 'steam' | 'spark') {
    this.m.emitters.push({ pos: new THREE.Vector3(x, y, z), kind });
  }
  light(p: THREE.Object3D, color: number, r: number, x: number, y: number, z: number, intensity = 2.6) {
    return this.mk(p, gSph(r, 8, 6), this.glow(color, intensity), x, y, z);
  }
}

// ============================================================== INFANTRY

interface Gear {
  head: 'helmet' | 'hardhat';
  weapon: 'rifle' | 'carbine' | 'at' | 'controller' | 'none';
  pack: 'pack' | 'toolbox' | 'jammer' | 'drone' | 'radio';
  goggles?: boolean;
}

function infantry(k: Kit, g: Gear): THREE.Group {
  const r = k.m.root;
  const uni = k.std(k.s.hull, 0.9, 0);
  const uniD = k.std(shade(k.s.hull, 0.7), 0.9, 0);
  const vest = k.std(k.s.team, 0.6, 0.05);
  const skin = k.std(C.skin, 0.8, 0);
  const boot = k.std(0x2b2621, 0.9, 0);
  const gun = k.gunM;

  const legs: THREE.Object3D[] = [];
  for (const sd of [-1, 1]) {
    const L = k.group(r, 0, 0.165, sd * 0.026);
    k.box(L, uni, 0.044, 0.15, 0.04, 0, -0.077, 0);
    k.box(L, uniD, 0.05, 0.026, 0.044, 0.004, -0.08, 0);
    k.box(L, boot, 0.064, 0.026, 0.046, 0.012, -0.152, 0);
    legs.push(L);
  }
  k.m.legs = [legs[0], legs[1]];
  k.box(r, uniD, 0.056, 0.04, 0.094, 0, 0.175, 0);
  k.box(r, uni, 0.058, 0.1, 0.1, -0.002, 0.24, 0);
  k.box(r, vest, 0.072, 0.075, 0.098, 0.002, 0.232, 0);
  k.box(r, uniD, 0.014, 0.026, 0.024, 0.04, 0.214, 0.024);
  k.box(r, uniD, 0.014, 0.026, 0.024, 0.04, 0.214, -0.024);
  // head
  k.mk(r, gSph(0.028, 10, 8), skin, 0.004, 0.307, 0);
  if (g.head === 'helmet') {
    const hm = k.std(shade(k.s.hull, 0.8), 0.85, 0.05);
    k.mk(r, gHemi(0.035, 10, 5), hm, 0.0, 0.313, 0);
    k.mk(r, gCyl(0.037, 0.037, 0.008, 10), hm, 0.0, 0.316, 0);
  } else {
    const hh = k.std(C.yellow, 0.45, 0.1);
    k.mk(r, gHemi(0.034, 10, 5), hh, 0.0, 0.316, 0);
    k.mk(r, gCyl(0.044, 0.044, 0.006, 12), hh, 0.004, 0.318, 0);
  }
  if (g.goggles) {
    k.box(r, k.dark, 0.032, 0.026, 0.066, 0.03, 0.31, 0);
    k.box(r, k.glow(C.cyan, 1.8), 0.004, 0.008, 0.05, 0.047, 0.31, 0);
  }

  // arms: upper arm pivots at the shoulder, forearm at the elbow; rotation.z > 0 swings forward
  const arm = (side: number, up: number, fore: number, inward: number) => {
    const a = k.group(r, 0, 0.272, side * 0.062);
    a.rotation.set(side * inward, 0, up);
    k.box(a, uni, 0.027, 0.07, 0.027, 0, -0.03, 0);
    const e = k.group(a, 0, -0.064, 0);
    e.rotation.z = fore;
    k.box(e, uni, 0.024, 0.062, 0.024, 0, -0.028, 0);
    k.mk(e, gSph(0.014, 6, 5), skin, 0, -0.062, 0);
  };

  switch (g.weapon) {
    case 'rifle':
    case 'carbine': {
      const len = g.weapon === 'rifle' ? 1 : 0.8;
      arm(1, 0.3, 1.2, 0.15);
      arm(-1, 0.75, 0.75, 0.9);
      const gy = 0.218;
      k.box(r, gun, 0.13 * len, 0.024, 0.014, 0.075, gy, 0.03);
      k.box(r, gun, 0.05, 0.03, 0.012, 0.0, gy - 0.006, 0.03); // stock
      k.box(r, gun, 0.016, 0.034, 0.01, 0.08, gy - 0.024, 0.03); // magazine
      k.mk(r, gCylX(0.005, 0.005, 0.06 * len, 6), gun, 0.14 * len + 0.02, gy + 0.006, 0.03);
      k.box(r, k.dark, 0.03, 0.012, 0.01, 0.07, gy + 0.018, 0.03); // optic
      k.muzzle(r, 0.16 * len + 0.035, gy + 0.006, 0.03);
      break;
    }
    case 'at': {
      arm(1, 0.1, 2.4, 0.1);
      arm(-1, 0.9, 1.0, 0.6);
      const tube = k.std(shade(k.s.hull, 0.55), 0.7, 0.2);
      k.mk(r, gCylX(0.021, 0.021, 0.27, 10), tube, 0.03, 0.29, 0.052);
      k.mk(r, gCylX(0.026, 0.021, 0.04, 10), tube, -0.12, 0.29, 0.052);
      k.mk(r, gCylX(0.0, 0.03, 0.06, 10), k.std(0x59633d, 0.7, 0.1), 0.195, 0.29, 0.052); // warhead
      k.box(r, k.dark, 0.04, 0.024, 0.012, 0.04, 0.31, 0.028); // sight
      k.box(r, gun, 0.02, 0.04, 0.012, 0.02, 0.262, 0.052); // grip
      k.muzzle(r, 0.23, 0.29, 0.052);
      break;
    }
    case 'controller': {
      arm(1, 0.25, 1.15, 0.35);
      arm(-1, 0.25, 1.15, 0.35);
      k.box(r, k.dark, 0.035, 0.014, 0.075, 0.082, 0.205, 0);
      k.box(r, k.glow(0x7fd8ff, 1.6), 0.02, 0.016, 0.03, 0.082, 0.207, 0);
      k.strut(r, k.steel, [0.09, 0.21, 0.03], [0.1, 0.26, 0.04], 0.003, 4);
      k.strut(r, k.steel, [0.09, 0.21, -0.03], [0.1, 0.26, -0.04], 0.003, 4);
      break;
    }
    case 'none': {
      arm(1, 0.1, 0.15, 0.05);
      arm(-1, 0.2, 0.4, 0.05);
      break;
    }
  }

  // back gear
  switch (g.pack) {
    case 'pack':
      k.box(r, uniD, 0.04, 0.075, 0.075, -0.052, 0.24, 0);
      k.box(r, uniD, 0.03, 0.02, 0.08, -0.05, 0.285, 0);
      break;
    case 'radio':
      k.box(r, uniD, 0.04, 0.08, 0.07, -0.052, 0.24, 0);
      k.strut(r, k.dark, [-0.06, 0.28, -0.02], [-0.07, 0.43, -0.03], 0.0025, 4);
      break;
    case 'toolbox': {
      const tb = k.std(0xc4471f, 0.6, 0.2);
      k.box(r, k.std(C.yellow, 0.6, 0.1), 0.045, 0.085, 0.08, -0.055, 0.24, 0);
      k.box(r, tb, 0.055, 0.035, 0.026, 0.025, 0.118, 0.07); // toolbox in the hand
      k.box(r, k.dark, 0.012, 0.008, 0.004, 0.025, 0.14, 0.07);
      k.box(r, k.std(0xe8e8d0, 0.5, 0), 0.074, 0.01, 0.1, 0.002, 0.25, 0); // hi-vis band
      break;
    }
    case 'jammer': {
      const jm = k.std(0x3e4440, 0.7, 0.3);
      k.box(r, jm, 0.065, 0.13, 0.09, -0.07, 0.25, 0);
      k.box(r, k.team, 0.067, 0.02, 0.092, -0.07, 0.29, 0);
      k.box(r, k.dark, 0.05, 0.03, 0.05, -0.07, 0.33, 0);
      k.strut(r, k.dark, [-0.08, 0.34, 0.02], [-0.1, 0.56, 0.04], 0.0035, 4);
      k.strut(r, k.dark, [-0.08, 0.34, -0.02], [-0.11, 0.5, -0.05], 0.0035, 4);
      k.strut(r, k.dark, [-0.06, 0.34, 0], [-0.055, 0.47, 0], 0.003, 4);
      k.light(r, C.cyan, 0.012, -0.1, 0.565, 0.04, 3);
      k.box(r, k.glow(C.green, 2), 0.004, 0.01, 0.03, -0.036, 0.26, 0);
      k.emit(-0.1, 0.565, 0.04, 'spark');
      break;
    }
    case 'drone': {
      k.box(r, uniD, 0.04, 0.08, 0.075, -0.052, 0.24, 0);
      const d = k.group(r, -0.06, 0.29, 0);
      const fr = k.std(0x2f3336, 0.6, 0.3);
      k.box(d, fr, 0.11, 0.008, 0.012, 0, 0, 0, 0, Math.PI / 4, 0);
      k.box(d, fr, 0.11, 0.008, 0.012, 0, 0, 0, 0, -Math.PI / 4, 0);
      k.box(d, k.team, 0.03, 0.014, 0.022, 0, 0.006, 0);
      for (const [x, z] of [
        [0.039, 0.039],
        [0.039, -0.039],
        [-0.039, 0.039],
        [-0.039, -0.039],
      ]) {
        k.mk(d, gCyl(0.008, 0.008, 0.012, 6), fr, x, 0.006, z);
        k.mk(d, gCyl(0.024, 0.024, 0.002, 10), k.std(0x9aa0a4, 0.4, 0.3), x, 0.013, z);
      }
      break;
    }
  }
  k.m.height = 0.36;
  return r;
}

// ============================================================ CHASSIS

interface TrackOpt {
  L: number;
  W: number;
  tw: number;
  th: number;
  hh: number;
  n: number;
  glacis: number;
  rear?: number;
}

/** Tracked chassis: belts, road wheels, side skirts with team stripe, upper hull. Returns deck height. */
function tracked(k: Kit, p: THREE.Object3D, o: TrackOpt): number {
  const { L, W, tw, th, hh, n, glacis } = o;
  const rear = o.rear ?? 0.04;
  const hull = k.hull;
  const wheelM = k.std(C.wheel, 0.8, 0.3);
  const hubM = k.std(0x55585a, 0.5, 0.5);
  const belt: P2[] = [
    [-L / 2 + 0.08, 0],
    [L / 2 - 0.1, 0],
    [L / 2 - 0.004, th * 0.5],
    [L / 2 - 0.06, th * 0.86],
    [-L / 2 + 0.05, th * 0.86],
    [-L / 2 + 0.004, th * 0.45],
  ];
  const rw = th * 0.36;
  for (const s of [-1, 1]) {
    k.mk(p, gSide(belt, tw), k.rubber, 0, 0, s * (W / 2 - tw / 2 - 0.006));
    for (let i = 0; i < n; i++) {
      const x = -L / 2 + 0.13 + ((L - 0.29) * i) / (n - 1);
      k.mk(p, gCylZ(rw, rw, 0.03, 10), wheelM, x, rw + 0.01, s * (W / 2 - 0.018));
      k.mk(p, gCylZ(rw * 0.42, rw * 0.42, 0.036, 6), hubM, x, rw + 0.01, s * (W / 2 - 0.018));
    }
    k.mk(p, gCylZ(th * 0.25, th * 0.25, 0.034, 8), hubM, L / 2 - 0.065, th * 0.52, s * (W / 2 - 0.018));
    k.mk(p, gCylZ(th * 0.22, th * 0.22, 0.034, 8), wheelM, -L / 2 + 0.06, th * 0.48, s * (W / 2 - 0.018));
    // side skirt (covers the top of the wheels) + team stripe
    k.box(p, hull, L - 0.14, th * 0.4, 0.014, 0.01, th * 0.8, s * (W / 2 + 0.003));
    k.box(p, k.hullD, L - 0.14, 0.008, 0.016, 0.01, th * 0.6, s * (W / 2 + 0.003));
    k.box(p, k.team, L * 0.42, th * 0.15, 0.006, -L * 0.12, th * 0.8, s * (W / 2 + 0.012));
  }
  // lower hull between the belts
  const lw = W - 2 * tw;
  k.mk(
    p,
    gSide(
      [
        [-L / 2 + 0.05, 0.05],
        [L / 2 - 0.13, 0.05],
        [L / 2 - 0.03, th],
        [-L / 2 + 0.02, th],
      ],
      lw,
    ),
    k.hullD,
  );
  // fender plate over the tracks
  k.mk(
    p,
    gSide(
      [
        [-L / 2 + 0.005, th - 0.004],
        [L / 2 - 0.035, th - 0.004],
        [L / 2 + 0.002, th + 0.022],
        [-L / 2, th + 0.022],
      ],
      W + 0.014,
      0.006,
    ),
    k.hullD,
  );
  // upper hull / superstructure, inset from the fenders, chamfered edges
  const top = th + hh;
  k.mk(
    p,
    gSide(
      [
        [-L / 2 + 0.01, th],
        [L / 2 - 0.03, th],
        [L / 2 + 0.005, th + hh * 0.35],
        [L / 2 - glacis, top],
        [-L / 2 + rear, top],
        [-L / 2 + 0.005, top - hh * 0.45],
      ],
      W - 0.09,
      0.022,
    ),
    hull,
  );
  // lights, grille, tow hooks
  for (const s of [-1, 1]) {
    k.box(p, k.glow(C.lamp, 2.2), 0.012, 0.016, 0.03, L / 2 + 0.006, th + hh * 0.22, s * (W / 2 - 0.05));
    k.box(p, k.glow(C.red, 2.2), 0.008, 0.014, 0.03, -L / 2 - 0.004, top - hh * 0.3, s * (W / 2 - 0.05));
    k.box(p, k.dark, 0.03, 0.02, 0.02, L / 2 - 0.01, th * 0.35, s * (lw / 2 - 0.03));
  }
  k.box(p, k.dark, 0.2, 0.006, W * 0.5, -L / 2 + rear + 0.13, top + 0.002, 0);
  for (let i = 0; i < 4; i++) k.box(p, k.hullD, 0.012, 0.01, W * 0.5, -L / 2 + rear + 0.05 + i * 0.05, top + 0.005, 0);
  return top;
}

/** Wheel rows + chassis frame. axles: x positions. */
function wheels(k: Kit, p: THREE.Object3D, W: number, axles: number[], r: number, frameX0: number, frameX1: number) {
  const tire = k.rubber;
  const hub = k.std(0x5d6058, 0.5, 0.5);
  const ww = 0.075;
  for (const x of axles) {
    for (const s of [-1, 1]) {
      const z = s * (W / 2 - ww / 2);
      k.mk(p, gCylZ(r, r, ww, 12), tire, x, r, z);
      k.mk(p, gCylZ(r * 0.5, r * 0.5, ww + 0.008, 8), hub, x, r, z);
    }
    k.box(p, k.dark, 0.05, 0.04, W - 2 * ww, x, r, 0);
  }
  for (const s of [-1, 1]) k.box(p, k.dark, frameX1 - frameX0, 0.05, 0.05, (frameX0 + frameX1) / 2, r + 0.035, s * W * 0.22);
}

/** Truck cab between x0 and x1 (front), sitting on y0. */
function cab(k: Kit, p: THREE.Object3D, x0: number, x1: number, W: number, y0: number, h: number, mat: THREE.Material) {
  const slope = 0.07;
  k.mk(
    p,
    gSide(
      [
        [x0, y0],
        [x1, y0],
        [x1, y0 + h * 0.52],
        [x1 - slope, y0 + h],
        [x0, y0 + h],
      ],
      W,
      0.014,
    ),
    mat,
  );
  const wh = h * 0.48;
  const len = Math.hypot(slope, wh) - 0.02;
  const ang = Math.atan2(slope, wh);
  k.box(p, k.glassM, 0.006, len, W - 0.06, x1 - slope / 2 + 0.005, y0 + h * 0.76, 0, 0, 0, ang);
  for (const s of [-1, 1]) {
    k.box(p, k.glassM, (x1 - x0) * 0.45, h * 0.26, 0.006, x1 - slope - (x1 - x0) * 0.2, y0 + h * 0.74, s * (W / 2 + 0.001));
    k.box(p, k.glow(C.lamp, 2.4), 0.01, 0.022, 0.04, x1 + 0.004, y0 + 0.06, s * (W / 2 - 0.06));
    k.box(p, k.dark, 0.008, 0.03, 0.03, x1 - slope - 0.01, y0 + h * 0.8, s * (W / 2 + 0.02)); // mirrors
  }
  k.box(p, k.dark, 0.03, 0.04, W + 0.02, x1 + 0.012, y0 + 0.01, 0); // bumper
  k.box(p, k.dark, 0.008, h * 0.22, W * 0.5, x1 + 0.003, y0 + h * 0.3, 0); // grille
  k.box(p, k.team, (x1 - x0) * 0.6, 0.012, W + 0.004, x0 + (x1 - x0) * 0.4, y0 + h * 0.45, 0);
}

// ---------------------------------------------------------------- tanks

function tankGun(k: Kit, tur: THREE.Object3D, x: number, y: number, len: number, r: number, elev = 0) {
  const pivot = k.group(tur, x, y, 0);
  pivot.rotation.z = elev;
  const barrel = k.group(pivot);
  k.mk(barrel, gCylX(r * 0.9, r, len, 10), k.gunM, len / 2, 0, 0);
  k.mk(barrel, gCylX(r * 1.45, r * 1.45, len * 0.13, 10), k.gunM, len * 0.5, 0, 0);
  k.mk(barrel, gCylX(r * 1.2, r * 1.1, len * 0.06, 10), k.gunM, len * 0.97, 0, 0);
  k.muzzle(barrel, len + 0.01, 0, 0);
  (k.m.recoil ??= []).push(barrel);
  return barrel;
}

/** Barrel group sitting at the origin of a fixed pivot, registered for recoil (kicked along local -X). */
function recoilGroup(k: Kit, p: THREE.Object3D, x: number, y: number, z: number): THREE.Group {
  const pivot = k.group(p, x, y, z);
  const g = k.group(pivot);
  (k.m.recoil ??= []).push(g);
  return g;
}

function smokeLaunchers(k: Kit, tur: THREE.Object3D, x: number, y: number, z: number) {
  for (const s of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      k.mk(tur, gCylX(0.009, 0.009, 0.04, 6), k.gunM, x - i * 0.016, y + (i % 2) * 0.012, s * z, 0, s * -0.6, 0.5);
    }
  }
}

function cupolaMG(k: Kit, tur: THREE.Object3D, x: number, y: number, z: number) {
  k.mk(tur, gCyl(0.042, 0.046, 0.03, 10), k.hullD, x, y + 0.015, z);
  k.box(tur, k.gunM, 0.06, 0.018, 0.018, x + 0.01, y + 0.045, z);
  k.mk(tur, gCylX(0.004, 0.004, 0.08, 5), k.gunM, x + 0.08, y + 0.048, z);
  k.box(tur, k.dark, 0.01, 0.03, 0.03, x + 0.04, y + 0.045, z);
}

function antenna(k: Kit, p: THREE.Object3D, x: number, y: number, z: number, h: number) {
  k.mk(p, gCyl(0.008, 0.01, 0.02, 6), k.dark, x, y + 0.01, z);
  k.mk(p, gCyl(0.0025, 0.0025, h, 4), k.dark, x, y + h / 2, z);
}

function buildMBT(k: Kit) {
  const r = k.m.root;
  const top = tracked(k, r, { L: 1.0, W: 0.6, tw: 0.13, th: 0.17, hh: 0.1, n: 6, glacis: 0.2 });
  // driver hatch
  k.mk(r, gCyl(0.035, 0.035, 0.012, 10), k.hullD, 0.24, top + 0.005, 0);
  const tur = k.group(r, -0.04, top, 0);
  k.m.turret = tur;
  const plan: P2[] = [
    [0.25, 0.09],
    [0.2, 0.2],
    [-0.15, 0.215],
    [-0.27, 0.17],
    [-0.27, -0.17],
    [-0.15, -0.215],
    [0.2, -0.2],
    [0.25, -0.09],
  ];
  k.mk(tur, gPlan(plan, 0.115, 0.02), k.hull);
  k.mk(tur, gCyl(0.2, 0.2, 0.02, 14), k.hullD, -0.02, 0.0, 0);
  // bustle rack (team colour boxes)
  k.box(tur, k.hullD, 0.06, 0.06, 0.36, -0.3, 0.06, 0);
  k.box(tur, k.team, 0.065, 0.02, 0.37, -0.3, 0.07, 0);
  // team band across the turret roof
  k.box(tur, k.team, 0.05, 0.006, 0.34, -0.16, 0.117, 0);
  // mantlet + gun
  k.box(tur, k.hullD, 0.07, 0.07, 0.12, 0.24, 0.055, 0);
  tankGun(k, tur, 0.27, 0.055, 0.5, 0.019);
  cupolaMG(k, tur, -0.06, 0.115, 0.1);
  k.mk(tur, gCyl(0.03, 0.03, 0.012, 10), k.hullD, -0.06, 0.12, -0.1);
  k.box(tur, k.hullD, 0.05, 0.05, 0.05, 0.1, 0.14, -0.11); // gunner sight
  k.box(tur, k.glassM, 0.006, 0.03, 0.04, 0.127, 0.145, -0.11);
  smokeLaunchers(k, tur, 0.16, 0.08, 0.2);
  antenna(k, tur, -0.22, 0.115, 0.15, 0.22);
  antenna(k, tur, -0.22, 0.115, -0.15, 0.18);
  k.m.height = 0.45;
}

function buildMBTHeavy(k: Kit) {
  const r = k.m.root;
  const top = tracked(k, r, { L: 1.1, W: 0.64, tw: 0.14, th: 0.18, hh: 0.12, n: 7, glacis: 0.26 });
  // front engine deck grilles (Merkava style)
  for (let i = 0; i < 3; i++) k.box(r, k.dark, 0.012, 0.008, 0.3, 0.12 + i * 0.04, top + 0.003, 0.08);
  k.mk(r, gCyl(0.035, 0.035, 0.012, 10), k.hullD, 0.2, top + 0.005, -0.17);
  const tur = k.group(r, -0.1, top, 0);
  k.m.turret = tur;
  const plan: P2[] = [
    [0.36, 0.0],
    [0.22, 0.2],
    [-0.18, 0.235],
    [-0.32, 0.19],
    [-0.32, -0.19],
    [-0.18, -0.235],
    [0.22, -0.2],
  ];
  k.mk(tur, gPlan(plan, 0.13, 0.022), k.hull);
  k.mk(tur, gCyl(0.22, 0.22, 0.02, 14), k.hullD, 0, 0, 0);
  // wedge add-on armour plates
  for (const s of [-1, 1]) {
    k.box(tur, k.hullD, 0.2, 0.09, 0.012, 0.25, 0.065, s * 0.105, 0, s * 0.95, 0);
  }
  // APS: radar panels + launchers
  for (const s of [-1, 1]) {
    const pnl = k.group(tur, 0.05, 0.1, s * 0.235);
    pnl.rotation.y = s * -0.35;
    k.box(pnl, k.dark, 0.08, 0.06, 0.016, 0, 0, 0);
    k.box(pnl, k.glow(0x4fe0a0, 1.6), 0.05, 0.035, 0.004, 0, 0, s * 0.009);
    const ln = k.group(tur, -0.17, 0.13, s * 0.18);
    k.box(ln, k.hullD, 0.06, 0.04, 0.05, 0, 0.02, 0);
    k.mk(ln, gHemi(0.026, 8, 4), k.gunM, 0, 0.04, 0);
  }
  // rear basket with team panel
  k.box(tur, k.hullD, 0.08, 0.07, 0.4, -0.36, 0.06, 0);
  k.box(tur, k.team, 0.085, 0.022, 0.41, -0.36, 0.08, 0);
  k.box(tur, k.team, 0.06, 0.006, 0.3, -0.2, 0.131, 0);
  k.box(tur, k.hullD, 0.08, 0.08, 0.12, 0.3, 0.065, 0);
  tankGun(k, tur, 0.33, 0.065, 0.56, 0.021);
  cupolaMG(k, tur, -0.08, 0.13, 0.1);
  k.box(tur, k.hullD, 0.055, 0.055, 0.055, 0.08, 0.16, -0.12);
  k.box(tur, k.glassM, 0.006, 0.035, 0.045, 0.11, 0.165, -0.12);
  smokeLaunchers(k, tur, 0.0, 0.12, 0.2);
  antenna(k, tur, -0.27, 0.13, 0.16, 0.24);
  antenna(k, tur, -0.27, 0.13, -0.16, 0.2);
  k.m.height = 0.5;
}

function buildAA(k: Kit) {
  const r = k.m.root;
  const top = tracked(k, r, { L: 0.98, W: 0.58, tw: 0.13, th: 0.16, hh: 0.11, n: 6, glacis: 0.22 });
  const tur = k.group(r, -0.06, top, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.19, 0.19, 0.02, 14), k.hullD, 0, 0, 0);
  k.mk(
    tur,
    gSide(
      [
        [-0.21, 0],
        [0.17, 0],
        [0.22, 0.08],
        [0.13, 0.19],
        [-0.21, 0.19],
      ],
      0.34,
      0.015,
    ),
    k.hull,
  );
  k.box(tur, k.team, 0.2, 0.03, 0.344, -0.08, 0.12, 0);
  // tracking radar (front)
  const tr = k.group(tur, 0.17, 0.17, 0);
  k.mk(tr, gCylX(0.06, 0.06, 0.03, 12), k.hullD, 0, 0, 0);
  k.mk(tr, gCylX(0.05, 0.05, 0.034, 12), k.dark, 0, 0, 0);
  // twin cannons
  for (const s of [-1, 1]) {
    k.box(tur, k.hull, 0.24, 0.08, 0.07, 0.03, 0.1, s * 0.21);
    k.box(tur, k.hullD, 0.1, 0.04, 0.074, -0.06, 0.07, s * 0.21);
    const b = recoilGroup(k, tur, 0.15, 0.11, s * 0.21);
    k.mk(b, gCylX(0.012, 0.013, 0.36, 8), k.gunM, 0.18, 0, 0);
    k.mk(b, gCylX(0.018, 0.018, 0.05, 8), k.gunM, 0.06, 0, 0);
    k.mk(b, gCylX(0.017, 0.017, 0.035, 8), k.gunM, 0.35, 0, 0);
    k.muzzle(b, 0.38, 0, 0);
  }
  // search radar on a mast at the rear (spinner)
  k.mk(tur, gCyl(0.02, 0.03, 0.08, 8), k.hullD, -0.14, 0.23, 0);
  const sr = k.group(tur, -0.14, 0.28, 0);
  const dishM = k.std(0x8d9296, 0.5, 0.4, true);
  const dish = k.group(sr, 0, 0.04, 0);
  dish.rotation.z = -Math.PI / 2 + 0.15;
  dish.scale.set(1, 1, 0.45);
  k.mk(dish, gDish(0.13, 0.04, 14), dishM, 0, 0, 0);
  k.box(sr, k.dark, 0.06, 0.02, 0.02, 0.05, 0.04, 0);
  k.spin(sr, 'y', 2.4);
  antenna(k, tur, -0.18, 0.19, 0.14, 0.18);
  k.m.height = 0.62;
}

function buildLaser(k: Kit) {
  const r = k.m.root;
  wheels(k, r, 0.58, [0.34, 0.15, -0.13, -0.32], 0.085, -0.45, 0.45);
  const hull = k.hull;
  k.mk(
    r,
    gSide(
      [
        [-0.52, 0.11],
        [0.43, 0.11],
        [0.53, 0.2],
        [0.38, 0.31],
        [-0.5, 0.31],
        [-0.53, 0.22],
      ],
      0.5,
      0.015,
    ),
    hull,
  );
  // fenders over the wheels
  for (const s of [-1, 1]) {
    k.box(r, k.hullD, 0.92, 0.012, 0.06, -0.02, 0.19, s * 0.27);
    k.box(r, k.team, 0.5, 0.03, 0.006, -0.12, 0.25, s * 0.253);
  }
  // cab windows
  k.box(r, k.glassM, 0.006, 0.05, 0.36, 0.455, 0.27, 0, 0, 0, 0.88);
  for (const s of [-1, 1]) k.box(r, k.glassM, 0.08, 0.04, 0.006, 0.33, 0.27, s * 0.253);
  for (const s of [-1, 1]) k.box(r, k.glow(C.lamp, 2.2), 0.01, 0.018, 0.04, 0.5, 0.18, s * 0.19);
  k.box(r, k.dark, 0.18, 0.006, 0.3, -0.38, 0.313, 0);
  antenna(k, r, -0.46, 0.31, 0.2, 0.2);
  // turret
  const tur = k.group(r, -0.12, 0.31, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.1, 0.12, 0.06, 12), k.hullD, 0, 0.03, 0);
  for (const s of [-1, 1]) k.box(tur, k.hull, 0.1, 0.14, 0.03, 0, 0.12, s * 0.12);
  const head = k.group(tur, 0, 0.17, 0);
  head.rotation.z = 0.08;
  k.mk(
    head,
    gSide(
      [
        [-0.14, -0.08],
        [0.12, -0.08],
        [0.14, -0.05],
        [0.14, 0.06],
        [0.1, 0.09],
        [-0.14, 0.09],
      ],
      0.2,
      0.012,
    ),
    k.std(mix(k.s.hull, 0xd0d0d0, 0.3), 0.6, 0.2),
  );
  k.box(head, k.team, 0.18, 0.012, 0.204, -0.03, 0.06, 0);
  // the lens
  k.mk(head, gCylX(0.075, 0.075, 0.03, 18), k.gunM, 0.15, 0.0, 0);
  k.mk(head, gTorus(0.07, 0.01, 6, 18), k.steel, 0.168, 0, 0, 0, Math.PI / 2, 0);
  k.mk(head, gCylX(0.058, 0.058, 0.012, 18), k.glow(0x8ff0ff, 2.2), 0.165, 0, 0);
  k.mk(head, gCylX(0.025, 0.025, 0.014, 12), k.glow(0xeaffff, 2.4), 0.168, 0, 0);
  k.muzzle(head, 0.18, 0, 0);
  // sensor ball
  k.mk(head, gSph(0.04, 10, 8), k.std(0x2c3034, 0.3, 0.6), 0.04, 0.03, 0.135);
  k.mk(head, gCylX(0.016, 0.016, 0.01, 8), k.glow(C.red, 2.6), 0.078, 0.03, 0.135);
  k.m.height = 0.6;
}

function buildArty(k: Kit) {
  const r = k.m.root;
  const top = tracked(k, r, { L: 1.08, W: 0.6, tw: 0.13, th: 0.16, hh: 0.12, n: 7, glacis: 0.2 });
  k.mk(r, gCyl(0.035, 0.035, 0.012, 10), k.hullD, 0.3, top + 0.005, -0.15);
  const tur = k.group(r, -0.2, top, 0);
  k.m.turret = tur;
  k.mk(
    tur,
    gSide(
      [
        [-0.34, 0],
        [0.26, 0],
        [0.32, 0.08],
        [0.27, 0.22],
        [-0.32, 0.22],
        [-0.35, 0.15],
      ],
      0.56,
      0.02,
    ),
    k.hull,
  );
  for (const s of [-1, 1]) {
    k.box(tur, k.team, 0.34, 0.04, 0.006, -0.06, 0.15, s * 0.282);
    k.box(tur, k.hullD, 0.16, 0.06, 0.02, -0.18, 0.07, s * 0.29); // stowage bins
    k.box(tur, k.dark, 0.05, 0.03, 0.006, 0.16, 0.16, s * 0.282); // vision blocks
  }
  k.box(tur, k.team, 0.07, 0.006, 0.46, -0.24, 0.222, 0);
  k.box(tur, k.hullD, 0.08, 0.12, 0.16, 0.32, 0.1, 0);
  tankGun(k, tur, 0.35, 0.1, 0.8, 0.02, 0.07);
  cupolaMG(k, tur, -0.06, 0.22, 0.15);
  k.mk(tur, gCyl(0.03, 0.03, 0.012, 10), k.hullD, -0.06, 0.226, -0.13);
  k.box(tur, k.dark, 0.12, 0.04, 0.14, -0.24, 0.24, -0.08);
  k.box(tur, k.dark, 0.01, 0.12, 0.2, -0.355, 0.1, 0); // rear ammo door
  antenna(k, tur, -0.3, 0.22, 0.22, 0.2);
  k.m.height = 0.56;
}

function buildTOS(k: Kit) {
  const r = k.m.root;
  const top = tracked(k, r, { L: 0.98, W: 0.6, tw: 0.13, th: 0.16, hh: 0.1, n: 6, glacis: 0.2 });
  k.box(r, k.hullD, 0.04, 0.04, 0.5, 0.3, top + 0.02, 0); // log / dozer stow
  const tur = k.group(r, -0.08, top, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.19, 0.2, 0.05, 14), k.hullD, 0, 0.025, 0);
  for (const s of [-1, 1]) k.box(tur, k.hull, 0.16, 0.1, 0.03, -0.12, 0.09, s * 0.16);
  k.strut(tur, k.steel, [0.06, 0.05, 0.06], [0.0, 0.17, 0.06], 0.014, 6);
  const pod = k.group(tur, -0.2, 0.13, 0);
  pod.rotation.z = 0.32;
  const len = 0.66;
  k.box(pod, k.hull, len, 0.2, 0.4, len / 2 - 0.08, 0.1, 0);
  for (let i = 0; i < 4; i++) k.box(pod, k.hullD, 0.02, 0.204, 0.404, i * 0.15, 0.1, 0);
  for (const s of [-1, 1]) k.box(pod, k.team, 0.36, 0.04, 0.006, 0.25, 0.13, s * 0.204);
  k.box(pod, k.team, 0.1, 0.006, 0.36, 0.08, 0.203, 0);
  // tube grid on the front face
  const fx = len - 0.08 + 0.002;
  k.box(pod, k.hullD, 0.01, 0.2, 0.4, fx, 0.1, 0);
  const tubeEnd = k.std(0x161718, 0.9, 0.1);
  const rim = k.gunM;
  const rows = 4;
  const cols = 6;
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      const y = 0.03 + i * 0.047;
      const z = -0.165 + j * 0.066;
      k.mk(pod, gCylX(0.024, 0.024, 0.012, 8), rim, fx + 0.007, y, z);
      k.mk(pod, gCylX(0.016, 0.016, 0.014, 8), tubeEnd, fx + 0.008, y, z);
      if ((i === 1 || i === 2) && j % 2 === (i === 1 ? 0 : 1)) k.muzzle(pod, fx + 0.02, y, z);
    }
  }
  k.m.height = 0.62;
}

function buildEW(k: Kit) {
  const r = k.m.root;
  const W = 0.56;
  wheels(k, r, W, [0.4, 0.22, -0.2, -0.38], 0.08, -0.6, 0.55);
  k.box(r, k.hullD, 1.18, 0.04, W - 0.16, -0.03, 0.15, 0);
  cab(k, r, 0.33, 0.6, W, 0.12, 0.28, k.hull);
  k.light(r, C.amber, 0.018, 0.42, 0.42, 0.0, 3);
  // equipment shelter
  const sh = k.hull;
  k.box(r, sh, 0.56, 0.24, W - 0.04, -0.27, 0.29, 0);
  k.box(r, k.hullD, 0.57, 0.02, W - 0.03, -0.27, 0.41, 0);
  for (const s of [-1, 1]) {
    k.box(r, k.team, 0.4, 0.04, 0.006, -0.27, 0.34, s * (W / 2 - 0.017));
    k.box(r, k.dark, 0.1, 0.16, 0.006, -0.08, 0.27, s * (W / 2 - 0.017));
    k.box(r, k.dark, 0.05, 0.05, 0.03, -0.45, 0.3, s * (W / 2 - 0.0)); // AC unit
  }
  k.box(r, k.glow(C.red, 2.6), 0.012, 0.012, 0.012, 0.0, 0.43, 0.24);
  k.box(r, k.glow(0x3a8cff, 2.6), 0.012, 0.012, 0.012, 0.0, 0.43, -0.24);
  // antenna turntable + rotating mesh dish
  k.mk(r, gCyl(0.1, 0.12, 0.05, 12), k.dark, -0.3, 0.445, 0);
  const ant = k.group(r, -0.3, 0.47, 0);
  k.box(ant, k.hullD, 0.08, 0.16, 0.1, 0, 0.08, 0);
  const dish = k.group(ant, 0.04, 0.2, 0);
  dish.rotation.z = -Math.PI / 2 + 0.55;
  const dm = k.std(0x8a908a, 0.55, 0.5, true);
  k.mk(dish, gDish(0.3, 0.1, 16), dm, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.strut(dish, k.dark, [0, 0.005, 0], [Math.cos(a) * 0.3, 0.1, Math.sin(a) * 0.3], 0.004, 4);
  }
  k.mk(dish, gTorus(0.3, 0.008, 4, 24), k.dark, 0, 0.1, 0, Math.PI / 2, 0, 0);
  for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    k.strut(dish, k.steel, [Math.cos(a) * 0.28, 0.1, Math.sin(a) * 0.28], [0, 0.26, 0], 0.004, 4);
  }
  k.mk(dish, gCyl(0.025, 0.02, 0.05, 8), k.dark, 0, 0.27, 0);
  k.mk(dish, gSph(0.014, 8, 6), k.glow(0x9fd8ff, 3.2), 0, 0.3, 0);
  k.spin(ant, 'y', 0.45);
  k.emit(-0.3, 0.86, 0, 'spark');
  k.m.height = 0.85;
}

function buildBerge(k: Kit) {
  const r = k.m.root;
  const top = tracked(k, r, { L: 1.0, W: 0.6, tw: 0.13, th: 0.17, hh: 0.11, n: 6, glacis: 0.2 });
  // crew superstructure (front left) with team band
  k.mk(
    r,
    gSide(
      [
        [-0.05, 0],
        [0.24, 0],
        [0.3, 0.06],
        [0.26, 0.13],
        [-0.05, 0.13],
      ],
      0.26,
      0.012,
    ),
    k.hull,
    0.02,
    top,
    -0.15,
  );
  k.box(r, k.team, 0.25, 0.03, 0.264, 0.08, top + 0.09, -0.15);
  k.box(r, k.glassM, 0.006, 0.03, 0.18, 0.3, top + 0.075, -0.15, 0, 0, 0.6);
  k.mk(r, gCyl(0.035, 0.035, 0.012, 10), k.hullD, 0.04, top + 0.136, -0.2);
  // beacon
  k.mk(r, gCyl(0.02, 0.02, 0.012, 8), k.dark, 0.12, top + 0.136, -0.08);
  const bc = k.group(r, 0.12, top + 0.17, -0.08);
  k.mk(bc, gSph(0.022, 10, 8), k.glass(0xffc23a, 0.55, 0xffaa00, 1.4), 0, 0, 0);
  k.box(bc, k.glow(0xffb020, 3.4), 0.03, 0.014, 0.008, 0, 0, 0);
  k.spin(bc, 'y', 6);
  // dozer blade
  for (const s of [-1, 1]) k.strut(r, k.hullD, [0.38, 0.17, s * 0.22], [0.56, 0.1, s * 0.22], 0.016, 6);
  k.mk(
    r,
    gSide(
      [
        [0.55, 0.0],
        [0.6, 0.0],
        [0.6, 0.02],
        [0.575, 0.06],
        [0.57, 0.12],
        [0.6, 0.19],
        [0.585, 0.2],
        [0.55, 0.13],
        [0.545, 0.05],
      ],
      0.66,
    ),
    k.std(C.yellow, 0.6, 0.25),
  );
  k.box(r, k.std(0x222222, 0.7, 0.2), 0.01, 0.025, 0.66, 0.6, 0.02, 0);
  // A-frame crane (raised, leaning back) with hook
  const yel = k.std(C.yellow, 0.55, 0.25);
  const apex: V3 = [0.12, 0.72, 0.1];
  k.strut(r, yel, [0.36, top, 0.26], apex, 0.017, 6);
  k.strut(r, yel, [0.36, top, -0.06], apex, 0.017, 6);
  k.strut(r, yel, [0.36, top + 0.2, 0.2], [0.32, top + 0.25, -0.01], 0.01, 5);
  k.strut(r, k.dark, [-0.3, top + 0.06, 0.1], apex, 0.004, 4); // stay cable
  k.mk(r, gCyl(0.004, 0.004, 0.24, 4), k.dark, 0.12, 0.6, 0.1);
  k.mk(r, gTorus(0.022, 0.006, 4, 10), k.gunM, 0.12, 0.46, 0.1);
  k.box(r, yel, 0.04, 0.04, 0.05, 0.12, 0.72, 0.1);
  // winch drum at the rear
  k.mk(r, gCylZ(0.05, 0.05, 0.3, 12), k.gunM, -0.38, top + 0.06, 0.12);
  k.mk(r, gCylZ(0.055, 0.055, 0.22, 12), k.std(0x3c3020, 0.9, 0.3), -0.38, top + 0.06, 0.12);
  for (const s of [-1, 1]) k.box(r, k.hullD, 0.1, 0.1, 0.02, -0.38, top + 0.05, 0.12 + s * 0.16);
  k.box(r, k.hullD, 0.25, 0.06, 0.12, -0.25, top + 0.03, -0.18); // tool box
  k.m.height = 0.75;
}

function buildUGV(k: Kit) {
  const r = k.m.root;
  const L = 0.62;
  const W = 0.44;
  const tw = 0.12;
  const th = 0.17;
  const wheelM = k.std(C.wheel, 0.8, 0.3);
  // two tall track modules
  const belt: P2[] = [
    [-L / 2 + 0.06, 0],
    [L / 2 - 0.06, 0],
    [L / 2, th * 0.5],
    [L / 2 - 0.05, th],
    [-L / 2 + 0.05, th],
    [-L / 2, th * 0.5],
  ];
  for (const s of [-1, 1]) {
    const z = s * (W / 2 - tw / 2);
    k.mk(r, gSide(belt, tw), k.rubber, 0, 0, z);
    k.box(r, k.hull, L - 0.12, th * 0.55, tw + 0.01, 0, th * 0.55, z);
    k.box(r, k.hull, L - 0.08, 0.02, tw + 0.02, 0, th + 0.002, z);
    k.box(r, k.team, L * 0.45, 0.025, 0.004, -0.04, th * 0.6, z + s * (tw / 2 + 0.006));
    for (let i = 0; i < 4; i++) {
      k.mk(r, gCylZ(0.035, 0.035, 0.02, 8), wheelM, -0.2 + i * 0.133, 0.04, z + s * (tw / 2 + 0.003));
    }
    k.mk(r, gCylZ(0.045, 0.045, 0.02, 8), wheelM, L / 2 - 0.05, th * 0.55, z + s * (tw / 2 + 0.003));
  }
  // central payload deck
  k.box(r, k.hullD, L - 0.12, 0.08, W - 2 * tw + 0.01, 0, 0.12, 0);
  k.box(r, k.hull, L - 0.1, 0.02, W - 0.02, 0, th + 0.012, 0);
  k.box(r, k.dark, 0.14, 0.03, 0.14, -0.18, th + 0.035, 0.1); // battery box
  for (const s of [-1, 1]) k.box(r, k.glow(C.lamp, 2.2), 0.008, 0.016, 0.03, L / 2 + 0.002, th * 0.7, s * (W / 2 - tw / 2));
  // sensor mast
  k.mk(r, gCyl(0.008, 0.01, 0.2, 6), k.dark, -0.22, th + 0.12, -0.12);
  k.box(r, k.std(0x30343a, 0.4, 0.5), 0.04, 0.03, 0.05, -0.21, th + 0.235, -0.12);
  k.box(r, k.glow(C.cyan, 2.4), 0.004, 0.012, 0.012, -0.188, th + 0.237, -0.12);
  antenna(k, r, -0.25, th + 0.02, 0.15, 0.18);
  // remote weapon station
  const tur = k.group(r, 0.02, th + 0.022, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.07, 0.08, 0.03, 12), k.hullD, 0, 0.015, 0);
  k.box(tur, k.hull, 0.1, 0.06, 0.03, 0, 0.06, -0.05);
  k.box(tur, k.gunM, 0.16, 0.035, 0.035, 0.03, 0.08, 0.0);
  k.box(tur, k.hullD, 0.07, 0.05, 0.04, -0.03, 0.06, 0.05); // ammo
  k.box(tur, k.std(0x30343a, 0.4, 0.5), 0.05, 0.04, 0.04, 0.02, 0.125, -0.05); // sight
  k.box(tur, k.glassM, 0.004, 0.025, 0.028, 0.047, 0.125, -0.05);
  const b = recoilGroup(k, tur, 0.11, 0.08, 0);
  k.mk(b, gCylX(0.007, 0.008, 0.16, 6), k.gunM, 0.08, 0, 0);
  k.muzzle(b, 0.17, 0, 0);
  k.m.height = 0.42;
}

function truckBase(k: Kit, W: number, axles: number[], cabX0: number, cabX1: number, frameX0: number) {
  const r = k.m.root;
  wheels(k, r, W, axles, 0.08, frameX0, cabX1 - 0.02);
  k.box(r, k.hullD, cabX0 - frameX0, 0.03, W - 0.16, (cabX0 + frameX0) / 2, 0.15, 0);
  cab(k, r, cabX0, cabX1, W, 0.12, 0.27, k.hull);
  for (const x of axles) for (const s of [-1, 1]) k.box(r, k.hullD, 0.2, 0.01, 0.085, x, 0.17, s * (W / 2 - 0.035));
}

function buildSwarm(k: Kit) {
  const r = k.m.root;
  const W = 0.54;
  truckBase(k, W, [0.38, -0.18, -0.38], 0.32, 0.56, -0.56);
  // rack base
  k.box(r, k.hullD, 0.7, 0.06, W - 0.06, -0.2, 0.19, 0);
  k.box(r, k.dark, 0.08, 0.1, 0.3, -0.48, 0.26, 0);
  const rack = k.group(r, -0.52, 0.27, 0);
  rack.rotation.z = 0.3;
  const len = 0.74;
  k.box(rack, k.hull, len, 0.2, W - 0.04, len / 2, 0.1, 0);
  for (const s of [-1, 1]) k.box(rack, k.team, len * 0.6, 0.04, 0.006, len * 0.45, 0.12, s * (W / 2 - 0.017));
  k.box(rack, k.team, 0.06, 0.006, W - 0.08, 0.15, 0.203, 0);
  for (let i = 0; i < 3; i++) k.box(rack, k.hullD, 0.015, 0.204, W - 0.036, 0.1 + i * 0.2, 0.1, 0);
  // canister ends: 3 x 6 grid
  const cap = k.std(0x8b9290, 0.5, 0.4);
  const hole = k.std(0x141516, 0.9, 0);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 6; j++) {
      const y = 0.035 + i * 0.065;
      const z = -0.2 + j * 0.08;
      k.box(rack, cap, 0.012, 0.058, 0.072, len + 0.004, y, z);
      k.box(rack, hole, 0.006, 0.04, 0.054, len + 0.011, y, z);
    }
  }
  k.muzzle(rack, len + 0.03, 0.1, 0);
  for (const s of [-1, 1]) k.strut(r, k.steel, [-0.15, 0.2, s * 0.18], [-0.05, 0.4, s * 0.18], 0.014, 6);
  k.m.height = 0.72;
}

function buildMissileTruck(k: Kit) {
  const r = k.m.root;
  const W = 0.6;
  truckBase(k, W, [0.48, 0.3, -0.2, -0.4], 0.42, 0.66, -0.66);
  k.box(r, k.hullD, 1.08, 0.08, W - 0.08, -0.12, 0.21, 0);
  for (const s of [-1, 1]) {
    const z = s * (W / 2 - 0.04);
    k.box(r, k.hull, 0.42, 0.1, 0.08, 0.05, 0.3, z); // equipment lockers
    k.box(r, k.team, 0.42, 0.025, 0.006, 0.05, 0.31, z + s * 0.042);
    for (let i = 0; i < 3; i++) k.box(r, k.hullD, 0.006, 0.08, 0.006, -0.08 + i * 0.13, 0.3, z + s * 0.042);
    k.box(r, k.hullD, 0.3, 0.08, 0.07, -0.48, 0.29, z);
    for (const jx of [-0.58, 0.28]) {
      k.box(r, k.dark, 0.04, 0.12, 0.04, jx, 0.12, s * (W / 2 + 0.01)); // stabiliser jacks
      k.box(r, k.dark, 0.08, 0.012, 0.08, jx, 0.006, s * (W / 2 + 0.01));
    }
  }
  // erector frame
  const er = k.group(r, -0.6, 0.29, 0);
  er.rotation.z = 0.06;
  for (const s of [-1, 1]) k.box(er, k.hull, 1.0, 0.05, 0.04, 0.5, 0.0, s * 0.11);
  for (let i = 0; i < 4; i++) k.box(er, k.hull, 0.03, 0.04, 0.26, 0.1 + i * 0.27, 0.0, 0);
  // the missile
  const ms = k.group(er, 0, 0.1, 0);
  const body = k.std(mix(k.s.hull, 0xe0ddd0, 0.55), 0.55, 0.2);
  k.mk(ms, gCylX(0.068, 0.068, 0.82, 14), body, 0.43, 0, 0);
  k.mk(ms, gCylX(0.0, 0.068, 0.22, 14), k.glow(0xdfe6ff, 0.7), 0.95, 0, 0);
  k.mk(ms, gCylX(0.07, 0.07, 0.05, 14), k.team, 0.62, 0, 0);
  k.mk(ms, gCylX(0.07, 0.07, 0.03, 14), k.dark, 0.2, 0, 0);
  k.mk(ms, gCylX(0.06, 0.05, 0.04, 12), k.dark, 0.0, 0, 0);
  for (let i = 0; i < 4; i++) {
    const f = k.group(ms, 0.08, 0, 0);
    f.rotation.x = Math.PI / 4 + (i * Math.PI) / 2;
    k.mk(
      f,
      gSide(
        [
          [-0.06, 0.06],
          [0.08, 0.06],
          [0.0, 0.13],
          [-0.06, 0.13],
        ],
        0.008,
      ),
      body,
    );
  }
  k.muzzle(ms, 1.07, 0, 0);
  for (const s of [-1, 1]) k.strut(r, k.steel, [-0.1, 0.22, s * 0.11], [-0.02, 0.33, s * 0.11], 0.014, 6);
  k.m.height = 0.5;
}

/** Shahed-style delta wing body (built along +X, origin at the centre). */
function shahedBody(k: Kit, p: THREE.Object3D, s: number, withProp: boolean) {
  const g = k.group(p);
  g.scale.setScalar(s);
  const skin = k.std(0x5d6264, 0.6, 0.25);
  const wing: P2[] = [
    [0.12, 0.03],
    [-0.12, 0.25],
    [-0.2, 0.25],
    [-0.2, -0.25],
    [-0.12, -0.25],
    [0.12, -0.03],
  ];
  k.mk(g, gPlan(wing, 0.016, 0.004), skin, 0, -0.008, 0);
  k.mk(
    g,
    gLatheX(
      [
        [0.0001, -0.21],
        [0.028, -0.19],
        [0.032, 0.05],
        [0.03, 0.15],
        [0.018, 0.21],
        [0.0001, 0.23],
      ],
      10,
    ),
    skin,
  );
  for (const z of [-0.25, 0.25]) {
    k.mk(
      g,
      gSide(
        [
          [-0.2, -0.04],
          [-0.12, -0.04],
          [-0.15, 0.06],
          [-0.2, 0.06],
        ],
        0.008,
      ),
      skin,
      0,
      0,
      z,
    );
  }
  k.box(g, k.team, 0.08, 0.004, 0.04, -0.15, 0.009, 0.17);
  k.box(g, k.team, 0.08, 0.004, 0.04, -0.15, 0.009, -0.17);
  const prop = k.group(g, -0.215, 0, 0);
  const pm = k.std(0x222426, 0.6, 0.2);
  k.box(prop, pm, 0.006, 0.12, 0.014, 0, 0, 0);
  k.mk(prop, gCylX(0.008, 0.012, 0.02, 6), pm, 0, 0, 0);
  if (withProp) k.spin(prop, 'x', 40);
  return g;
}

function buildContainer(k: Kit) {
  const r = k.m.root;
  const W = 0.56;
  truckBase(k, W, [0.42, -0.22, -0.42], 0.34, 0.58, -0.6);
  k.box(r, k.hullD, 0.92, 0.04, W - 0.06, -0.15, 0.19, 0);
  // open-top container, opened rear end
  const cm = k.std(mix(C.rust, k.s.hull, 0.25), 0.8, 0.2);
  const cmD = k.std(shade(mix(C.rust, k.s.hull, 0.25), 0.7), 0.8, 0.2);
  const x0 = -0.62;
  const x1 = 0.3;
  const cx = (x0 + x1) / 2;
  const L = x1 - x0;
  const y0 = 0.21;
  const h = 0.3;
  k.box(r, cm, L, 0.02, W - 0.04, cx, y0 + 0.01, 0);
  k.box(r, cm, 0.02, h, W - 0.04, x1 - 0.01, y0 + h / 2, 0);
  for (const s of [-1, 1]) {
    const z = s * (W / 2 - 0.03);
    k.box(r, cm, L, h, 0.02, cx, y0 + h / 2, z);
    for (let i = 0; i < 9; i++) k.box(r, cmD, 0.016, h - 0.02, 0.006, x0 + 0.06 + i * 0.1, y0 + h / 2, z + s * 0.012);
    k.box(r, k.team, L, 0.025, 0.026, cx, y0 + h, z);
    // swung-open doors
    const d = k.group(r, x0, y0, z + s * 0.018);
    d.rotation.y = Math.PI;
    k.box(d, cmD, 0.26, h - 0.01, 0.014, 0.13, h / 2, 0);
  }
  // launch rails with munitions (2 x 2), sloping up toward the rear
  const rail = k.std(C.steel, 0.5, 0.6);
  for (const [x, z] of [
    [-0.08, 0.12],
    [-0.08, -0.12],
    [-0.38, 0.12],
    [-0.38, -0.12],
  ]) {
    const rg = k.group(r, x + 0.12, y0 + 0.06, z);
    rg.rotation.z = -0.32;
    k.box(rg, rail, 0.32, 0.012, 0.02, -0.12, 0, 0);
    const sb = shahedBody(k, rg, 0.46, false);
    sb.position.set(-0.12, 0.025, 0);
    sb.rotation.y = Math.PI;
  }
  k.muzzle(r, x0 - 0.02, y0 + h, 0);
  k.m.height = 0.55;
}

function buildHarvester(k: Kit) {
  const r = k.m.root;
  const top = tracked(k, r, { L: 1.12, W: 0.66, tw: 0.15, th: 0.18, hh: 0.07, n: 6, glacis: 0.14 });
  // armoured cab front-right (+Z, faces the camera)
  k.mk(
    r,
    gSide(
      [
        [0.12, 0],
        [0.44, 0],
        [0.46, 0.1],
        [0.38, 0.22],
        [0.12, 0.22],
      ],
      0.26,
      0.014,
    ),
    k.hull,
    0,
    top,
    0.17,
  );
  k.box(r, k.glassM, 0.006, 0.07, 0.2, 0.427, top + 0.16, 0.17, 0, 0, 0.98);
  k.box(r, k.glassM, 0.18, 0.06, 0.006, 0.28, top + 0.16, 0.302);
  k.box(r, k.team, 0.3, 0.03, 0.264, 0.27, top + 0.06, 0.17);
  k.light(r, C.amber, 0.02, 0.2, top + 0.235, 0.24, 3.2);
  k.light(r, C.amber, 0.02, 0.2, top + 0.235, 0.1, 3.2);
  // engine block front-left
  k.box(r, k.hullD, 0.28, 0.12, 0.26, 0.28, top + 0.06, -0.17);
  k.mk(r, gCyl(0.025, 0.025, 0.14, 8), k.dark, 0.2, top + 0.18, -0.24);
  k.emit(0.2, top + 0.26, -0.24, 'smoke');
  // hopper (tapered bin) at the back
  const hx = -0.24;
  const binG = k.group(r, hx, top, 0);
  k.box(binG, k.hullD, 0.6, 0.05, 0.58, 0, 0.025, 0);
  for (const s of [-1, 1]) {
    k.box(binG, k.hull, 0.64, 0.3, 0.025, 0, 0.17, s * 0.29, s * 0.12, 0, 0);
    k.box(binG, k.hull, 0.025, 0.3, 0.6, s * 0.31, 0.17, 0, 0, 0, -s * 0.12);
    k.box(binG, k.hullD, 0.7, 0.025, 0.035, 0, 0.32, s * 0.31);
    k.box(binG, k.hullD, 0.035, 0.025, 0.66, s * 0.33, 0.32, 0);
    k.box(binG, k.team, 0.5, 0.05, 0.006, 0, 0.2, s * 0.31, s * 0.12, 0, 0);
    for (let i = 0; i < 3; i++) k.box(binG, k.hullD, 0.02, 0.28, 0.012, -0.2 + i * 0.2, 0.16, s * 0.307, s * 0.12, 0, 0);
  }
  // ore heap inside
  k.mk(binG, gHemi(0.3, 12, 4), k.std(0x8a6428, 0.9, 0.1), 0, 0.12, 0).scale.set(0.95, 0.5, 0.9);
  const oreM = k.std(C.ore, 0.35, 0.55);
  const lumps: V3[] = [
    [-0.12, 0.25, -0.08],
    [0.06, 0.26, 0.1],
    [0.16, 0.235, -0.1],
    [-0.02, 0.27, -0.01],
    [-0.18, 0.235, 0.12],
    [0.12, 0.25, 0.03],
    [0.0, 0.245, -0.16],
  ];
  for (const [x, y, z] of lumps) k.mk(binG, gIco(0.04), oreM, x, y, z, x * 9, z * 7, 0);
  k.light(binG, C.amber, 0.016, -0.33, 0.35, 0.3, 3.2);
  k.light(binG, C.amber, 0.016, -0.33, 0.35, -0.3, 3.2);
  // front cutter drum (spinner about Z) under a hood
  for (const s of [-1, 1]) {
    k.strut(r, k.hullD, [0.44, 0.22, s * 0.3], [0.64, 0.12, s * 0.3], 0.022, 6);
    k.box(r, k.hullD, 0.16, 0.16, 0.02, 0.65, 0.12, s * 0.32);
  }
  k.box(r, k.std(C.yellow, 0.55, 0.25), 0.15, 0.014, 0.66, 0.6, 0.235, 0, 0, 0, -0.45);
  k.box(r, k.std(0x1c1c1c, 0.7, 0.1), 0.15, 0.016, 0.1, 0.6, 0.238, 0, 0, 0, -0.45);
  const drum = k.group(r, 0.66, 0.11, 0);
  k.mk(drum, gCylZ(0.09, 0.09, 0.6, 12), k.std(0x5c5f60, 0.5, 0.5), 0, 0, 0);
  const tooth = k.std(0xd8a21c, 0.45, 0.4);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    k.box(drum, tooth, 0.035, 0.03, 0.6, Math.cos(a) * 0.095, Math.sin(a) * 0.095, 0, 0, 0, a);
  }
  k.spin(drum, 'z', -3);
  k.m.height = 0.62;
}

function buildMCV(k: Kit) {
  const r = k.m.root;
  const W = 0.62;
  truckBase(k, W, [0.44, 0.26, -0.22, -0.42], 0.36, 0.62, -0.62);
  k.box(r, k.hullD, 0.98, 0.05, W - 0.04, -0.13, 0.2, 0);
  // module
  const x0 = -0.62;
  const x1 = 0.3;
  const L = x1 - x0;
  const cx = (x0 + x1) / 2;
  k.mk(
    r,
    gSide(
      [
        [x0, 0.22],
        [x1, 0.22],
        [x1, 0.52],
        [x1 - 0.04, 0.56],
        [x0 + 0.03, 0.56],
        [x0, 0.53],
      ],
      W - 0.02,
      0.014,
    ),
    k.hull,
  );
  for (const s of [-1, 1]) {
    const z = s * (W / 2 - 0.008);
    k.box(r, k.team, L * 0.62, 0.14, 0.006, cx - 0.06, 0.38, z);
    k.box(r, k.hullD, 0.014, 0.3, 0.008, cx + 0.3, 0.37, z);
    k.box(r, k.hullD, 0.014, 0.3, 0.008, cx - 0.36, 0.37, z);
    k.box(r, k.glow(C.amber, 2.6), 0.02, 0.02, 0.01, x1 - 0.02, 0.54, z);
  }
  k.box(r, k.dark, 0.006, 0.2, 0.3, x0 - 0.002, 0.37, 0); // rear doors
  // folded crane on the roof
  const yel = k.std(C.yellow, 0.55, 0.25);
  const cz = -0.16;
  k.mk(r, gCyl(0.07, 0.08, 0.06, 12), k.dark, x0 + 0.12, 0.59, cz);
  k.box(r, yel, 0.1, 0.08, 0.1, x0 + 0.12, 0.66, cz);
  k.box(r, yel, 0.78, 0.05, 0.06, x0 + 0.5, 0.66, cz);
  k.box(r, yel, 0.6, 0.035, 0.045, x0 + 0.5, 0.7, cz);
  k.strut(r, k.dark, [x0 + 0.88, 0.66, cz], [x0 + 0.88, 0.58, cz], 0.004, 4);
  k.mk(r, gTorus(0.02, 0.006, 4, 10), k.gunM, x0 + 0.88, 0.575, cz);
  // raised control cabin
  k.box(r, k.hull, 0.24, 0.12, 0.26, 0.13, 0.62, 0.13);
  k.box(r, k.hullD, 0.27, 0.02, 0.29, 0.13, 0.69, 0.13);
  windows(k, r, 'x', 0.05, 0.21, 3, 0.635, 0.262, 0.04, 0.04);
  windows(k, r, 'z', 0.05, 0.21, 3, 0.635, 0.252, 0.04, 0.04);
  k.mk(r, gHemi(0.05, 10, 4), k.std(0xd8d8d0, 0.5, 0.1), 0.1, 0.7, 0.13);
  // roof gear
  k.box(r, k.dark, 0.14, 0.04, 0.12, x0 + 0.2, 0.58, 0.16);
  k.mk(r, gCyl(0.03, 0.03, 0.02, 10), k.steel, x0 + 0.45, 0.57, 0.16);
  antenna(k, r, x0 + 0.05, 0.56, 0.24, 0.25);
  k.light(r, C.amber, 0.02, 0.45, 0.425, 0, 3);
  k.m.height = 0.75;
}

// ================================================================ AIRCRAFT

function navLights(k: Kit, p: THREE.Object3D, x: number, y: number, span: number) {
  k.light(p, C.red, 0.014, x, y, -span, 3);
  k.light(p, C.green, 0.014, x, y, span, 3);
}

function wingPlan(root: number, tip: number, span: number, sweep: number, z0 = 0): P2[] {
  // leading edge at x=0 at the root; tip leading edge moved back by sweep
  return [
    [0, z0],
    [-sweep, span],
    [-sweep - tip, span],
    [-root, z0],
  ];
}

function buildUAV(k: Kit) {
  const r = k.m.root;
  const skin = k.std(0xc4c8cb, 0.55, 0.25);
  const skinD = k.std(0x9ca1a5, 0.6, 0.25);
  k.mk(
    r,
    gLatheX(
      [
        [0.0001, -0.27],
        [0.025, -0.24],
        [0.04, -0.1],
        [0.046, 0.1],
        [0.04, 0.2],
        [0.022, 0.27],
        [0.0001, 0.29],
      ],
      10,
    ),
    skin,
  );
  // wings
  for (const s of [-1, 1]) {
    const w = k.mk(r, gPlan(wingPlan(0.1, 0.06, 0.45, 0.02), 0.012, 0.003), skin, 0.06, 0.022, 0);
    if (s < 0) w.scale.z = -1;
    k.box(r, k.team, 0.05, 0.004, 0.06, 0.02, 0.035, s * 0.36);
    // twin tail booms
    k.mk(r, gCylX(0.012, 0.012, 0.42, 6), skinD, -0.18, 0.025, s * 0.13);
    // inverted V tail panel
    const t = k.group(r, -0.38, 0.025, s * 0.13);
    t.rotation.x = s * 0.75;
    k.mk(t, gPlan(wingPlan(0.07, 0.045, 0.17, 0.03), 0.006), skinD, 0.03, 0, 0).scale.z = -s;
    // missiles
    k.box(r, skinD, 0.04, 0.02, 0.008, 0.03, 0.005, s * 0.24);
    k.mk(r, gCylX(0.011, 0.011, 0.13, 6), k.std(0xeeeee6, 0.5, 0.2), 0.03, -0.012, s * 0.24);
    k.mk(r, gCylX(0.0, 0.011, 0.025, 6), k.std(0x6a6f50, 0.6, 0.2), 0.107, -0.012, s * 0.24);
  }
  k.muzzle(r, 0.13, -0.015, 0.24);
  // sensor ball + nose
  k.mk(r, gSph(0.028, 10, 8), k.std(0x2b2f33, 0.3, 0.6), 0.18, -0.045, 0);
  k.mk(r, gCylX(0.012, 0.012, 0.01, 8), k.glow(C.cyan, 2.6), 0.205, -0.05, 0);
  k.mk(r, gSph(0.012, 6, 4), skinD, 0.0, 0.047, 0);
  // pusher prop
  const prop = k.group(r, -0.29, 0, 0);
  const pm = k.std(0x2a2c2e, 0.6, 0.2);
  k.box(prop, pm, 0.005, 0.16, 0.012, 0, 0, 0);
  k.mk(prop, gCylX(0.08, 0.08, 0.002, 16), k.glass(0xc8ccd0, 0.18), 0, 0, 0);
  k.mk(prop, gCylX(0.0, 0.016, 0.03, 8), skinD, -0.012, 0, 0);
  k.spin(prop, 'x', 40);
  navLights(k, r, 0.03, 0.03, 0.465);
  k.light(r, 0xffffff, 0.01, -0.27, 0.035, 0, 3);
  k.m.height = 0.15;
}

function buildHeavyUAV(k: Kit) {
  const r = k.m.root;
  const skin = k.std(0xb9bec2, 0.55, 0.25);
  const skinD = k.std(0x8f959a, 0.6, 0.25);
  k.mk(
    r,
    gLatheX(
      [
        [0.0001, -0.4],
        [0.035, -0.36],
        [0.058, -0.15],
        [0.065, 0.12],
        [0.055, 0.27],
        [0.03, 0.36],
        [0.0001, 0.38],
      ],
      12,
    ),
    skin,
  );
  for (const s of [-1, 1]) {
    const w = k.mk(r, gPlan(wingPlan(0.16, 0.07, 0.6, 0.06), 0.016, 0.004), skin, 0.1, 0.02, 0);
    if (s < 0) w.scale.z = -1;
    k.box(r, k.team, 0.07, 0.004, 0.08, 0.0, 0.037, s * 0.48);
    // engine pod with tractor prop
    const pz = s * 0.21;
    k.mk(
      r,
      gLatheX(
        [
          [0.0001, -0.16],
          [0.02, -0.14],
          [0.033, 0.0],
          [0.03, 0.1],
          [0.012, 0.14],
          [0.0001, 0.145],
        ],
        10,
      ),
      skinD,
      0.03,
      0.0,
      pz,
    );
    const prop = k.group(r, 0.18, 0.0, pz);
    const pm = k.std(0x2a2c2e, 0.6, 0.2);
    k.box(prop, pm, 0.005, 0.19, 0.012, 0, 0, 0);
    k.box(prop, pm, 0.005, 0.012, 0.19, 0, 0, 0);
    k.mk(prop, gCylX(0.095, 0.095, 0.002, 16), k.glass(0xc8ccd0, 0.18), 0, 0, 0);
    k.mk(prop, gCylX(0.0, 0.02, 0.03, 8), skinD, 0.015, 0, 0);
    k.spin(prop, 'x', 36 * s);
    // missiles
    for (const mz of [0.33, 0.42]) {
      k.box(r, skinD, 0.04, 0.02, 0.008, 0.02, 0.0, s * mz);
      k.mk(r, gCylX(0.014, 0.014, 0.16, 6), k.std(0xeeeee6, 0.5, 0.2), 0.02, -0.02, s * mz);
      k.mk(r, gCylX(0.0, 0.014, 0.03, 6), k.std(0x6a6f50, 0.6, 0.2), 0.115, -0.02, s * mz);
    }
    // V tail
    const t = k.group(r, -0.32, 0.03, s * 0.02);
    t.rotation.x = s * -0.7;
    const tp = k.mk(t, gPlan(wingPlan(0.1, 0.06, 0.2, 0.06), 0.008), skinD, 0.04, 0, 0);
    tp.scale.z = s;
  }
  k.muzzle(r, 0.15, -0.025, 0.33);
  k.muzzle(r, 0.15, -0.025, -0.33);
  k.mk(r, gSph(0.034, 10, 8), k.std(0x2b2f33, 0.3, 0.6), 0.24, -0.06, 0);
  k.mk(r, gCylX(0.014, 0.014, 0.01, 8), k.glow(C.cyan, 2.6), 0.27, -0.065, 0);
  navLights(k, r, 0.03, 0.03, 0.62);
  k.light(r, 0xffffff, 0.012, -0.39, 0.0, 0, 3);
  k.m.height = 0.18;
}

function buildJet(k: Kit) {
  const r = k.m.root;
  const skin = k.std(0x7f868c, 0.5, 0.35);
  const skinD = k.std(0x666d73, 0.55, 0.35);
  // faceted body: chined plan extruded with a heavy bevel
  const body: P2[] = [
    [0.52, 0],
    [0.36, 0.05],
    [0.18, 0.09],
    [0.1, 0.14],
    [-0.36, 0.15],
    [-0.46, 0.1],
    [-0.48, 0.07],
    [-0.48, -0.07],
    [-0.46, -0.1],
    [-0.36, -0.15],
    [0.1, -0.14],
    [0.18, -0.09],
    [0.36, -0.05],
  ];
  k.mk(r, gPlan(body, 0.11, 0.04), skin, 0, -0.055, 0);
  // spine hump
  k.mk(
    r,
    gSide(
      [
        [-0.4, 0],
        [0.2, 0],
        [0.1, 0.035],
        [-0.3, 0.03],
      ],
      0.12,
      0.01,
    ),
    skin,
    0,
    0.045,
    0,
  );
  // canopy
  const can = k.mk(r, gSph(0.05, 12, 8), k.std(0x6b5520, 0.12, 0.9), 0.26, 0.05, 0);
  can.scale.set(2.6, 0.75, 0.85);
  // wings (trapezoid)
  for (const s of [-1, 1]) {
    const w = k.mk(
      r,
      gPlan(
        [
          [0.08, 0.12],
          [-0.2, 0.5],
          [-0.3, 0.5],
          [-0.33, 0.12],
        ],
        0.014,
        0.004,
      ),
      skin,
      0,
      -0.01,
      0,
    );
    if (s < 0) w.scale.z = -1;
    const st = k.mk(
      r,
      gPlan(
        [
          [-0.36, 0.12],
          [-0.47, 0.3],
          [-0.53, 0.3],
          [-0.52, 0.12],
        ],
        0.01,
        0.003,
      ),
      skin,
      0,
      -0.005,
      0,
    );
    if (s < 0) st.scale.z = -1;
    // canted twin tails
    const t = k.group(r, 0, 0.04, s * 0.1);
    t.rotation.x = s * -0.42;
    k.mk(
      t,
      gSide(
        [
          [-0.3, 0],
          [-0.47, 0],
          [-0.49, 0.17],
          [-0.42, 0.17],
        ],
        0.01,
      ),
      skinD,
    );
    k.box(t, k.team, 0.06, 0.03, 0.012, -0.455, 0.15, 0);
    // intakes
    k.box(r, k.dark, 0.06, 0.05, 0.03, 0.12, -0.005, s * 0.125, 0, s * 0.35, 0);
    k.box(r, k.team, 0.1, 0.004, 0.02, -0.25, 0.007, s * 0.4);
  }
  // exhaust
  k.mk(r, gCylX(0.05, 0.06, 0.1, 12), skinD, -0.5, 0.0, 0);
  k.mk(r, gCylX(0.042, 0.042, 0.012, 12), k.glow(0xff8a3a, 3.4), -0.555, 0, 0);
  k.muzzle(r, 0.1, -0.07, 0.06);
  k.muzzle(r, 0.1, -0.07, -0.06);
  navLights(k, r, -0.25, 0.005, 0.5);
  k.m.height = 0.2;
}

function buildFPV(k: Kit) {
  const r = k.m.root;
  const fr = k.std(0x2f3336, 0.55, 0.35);
  k.box(r, fr, 0.17, 0.01, 0.016, 0, 0, 0, 0, Math.PI / 4, 0);
  k.box(r, fr, 0.17, 0.01, 0.016, 0, 0, 0, 0, -Math.PI / 4, 0);
  k.box(r, k.team, 0.06, 0.022, 0.035, 0, 0.012, 0);
  k.box(r, k.dark, 0.016, 0.014, 0.016, 0.035, 0.012, 0); // camera
  k.box(r, k.glassM, 0.003, 0.008, 0.008, 0.044, 0.012, 0);
  const disc = k.glass(0xbfc6cc, 0.22);
  const blade = k.std(0x1d1f20, 0.6, 0.2);
  for (const [x, z] of [
    [0.06, 0.06],
    [0.06, -0.06],
    [-0.06, 0.06],
    [-0.06, -0.06],
  ]) {
    k.mk(r, gCyl(0.01, 0.01, 0.016, 8), fr, x, 0.006, z);
    const ro = k.group(r, x, 0.017, z);
    k.box(ro, blade, 0.075, 0.003, 0.01, 0, 0, 0);
    k.mk(ro, gCyl(0.038, 0.038, 0.002, 14), disc, 0, 0, 0);
    k.m.rotors.push(ro);
  }
  // warhead slung underneath
  k.mk(r, gCylX(0.016, 0.016, 0.08, 8), k.std(0x59633d, 0.7, 0.2), 0.0, -0.024, 0);
  k.mk(r, gCylX(0.0, 0.016, 0.03, 8), k.std(0x59633d, 0.7, 0.2), 0.055, -0.024, 0);
  k.light(r, C.red, 0.008, -0.03, 0.022, 0, 3.4);
  k.m.height = 0.06;
}

function buildMicro(k: Kit) {
  const r = k.m.root;
  const skin = k.std(0x8e9598, 0.5, 0.3);
  k.mk(
    r,
    gPlan(
      [
        [0.06, 0],
        [-0.03, 0.075],
        [-0.05, 0.07],
        [-0.03, 0],
        [-0.05, -0.07],
        [-0.03, -0.075],
      ],
      0.008,
      0.002,
    ),
    skin,
    0,
    -0.004,
    0,
  );
  k.mk(r, gSph(0.014, 8, 6), k.team, 0.01, 0.004, 0).scale.set(2, 0.8, 1);
  const blade = k.std(0x1d1f20, 0.6, 0.2);
  const disc = k.glass(0xbfc6cc, 0.22);
  for (const z of [0.05, -0.05]) {
    k.mk(r, gCyl(0.007, 0.007, 0.014, 6), skin, -0.015, 0.008, z);
    const ro = k.group(r, -0.015, 0.016, z);
    k.box(ro, blade, 0.05, 0.002, 0.007, 0, 0, 0);
    k.mk(ro, gCyl(0.026, 0.026, 0.0015, 12), disc, 0, 0, 0);
    k.m.rotors.push(ro);
  }
  k.light(r, C.red, 0.007, 0.045, 0.004, 0, 3.4);
  k.m.height = 0.04;
}

function buildShahed(k: Kit) {
  shahedBody(k, k.m.root, 1, true);
  k.light(k.m.root, C.red, 0.008, -0.2, 0.01, -0.25, 3);
  k.light(k.m.root, C.green, 0.008, -0.2, 0.01, 0.25, 3);
  k.m.height = 0.08;
}

// ================================================================ BUILDINGS

/** Concrete base slab; notch = [x0, x1, z0] cuts a ground-level opening from z0 to the front (+Z) edge. */
function slab(k: Kit, w: number, h: number, height = 0.06, notch?: [number, number, number]) {
  const W = w / 2 - 0.02;
  const H = h / 2 - 0.02;
  const pts: P2[] = notch
    ? [
        [-W, -H],
        [W, -H],
        [W, H],
        [notch[1], H],
        [notch[1], notch[2]],
        [notch[0], notch[2]],
        [notch[0], H],
        [-W, H],
      ]
    : rect(W * 2, H * 2);
  const m = k.mk(k.m.root, gPlan(pts, height, 0.02), k.std(C.slab, 0.95, 0));
  m.receiveShadow = true;
  return m;
}

/** Row of lit windows on a face. axis: which axis the row runs along; the face normal is the other horizontal axis. */
function windows(
  k: Kit,
  p: THREE.Object3D,
  axis: 'x' | 'z',
  a0: number,
  a1: number,
  n: number,
  y: number,
  face: number,
  ww: number,
  wh: number,
  color = C.win,
) {
  const lit = k.glow(color, 2.2);
  const off = k.std(0x2a3640, 0.2, 0.6);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0.5 : i / (n - 1);
    const a = a0 + (a1 - a0) * t;
    const m = (i * 7 + Math.round(a * 13)) % 5 === 2 ? off : lit;
    if (axis === 'x') k.box(p, m, ww, wh, 0.012, a, y, face);
    else k.box(p, m, 0.012, wh, ww, face, y, a);
  }
}

function lamp(k: Kit, p: THREE.Object3D, x: number, z: number, h = 0.32) {
  k.mk(p, gCyl(0.008, 0.01, h, 6), k.dark, x, h / 2, z);
  k.box(p, k.dark, 0.06, 0.01, 0.015, x + 0.025, h, z);
  k.box(p, k.glow(C.lamp, 2.8), 0.03, 0.008, 0.012, x + 0.04, h - 0.008, z);
}

function flag(k: Kit, p: THREE.Object3D, x: number, z: number, h: number) {
  const pole = k.std(0xc9ccce, 0.4, 0.6);
  k.mk(p, gCyl(0.012, 0.016, h, 6), pole, x, h / 2, z);
  k.mk(p, gSph(0.02, 8, 6), k.team, x, h + 0.01, z);
  k.mk(p, gCyl(0.04, 0.05, 0.04, 8), k.concrete, x, 0.02, z);
  const fw = 0.3;
  const bh = 0.055;
  const cols = k.s.flag.length >= 3 ? k.s.flag : [k.s.team, 0xffffff, k.s.team];
  const fg = k.group(p, x + 0.012, h - 0.02, z);
  fg.rotation.y = -0.25;
  for (let i = 0; i < 3; i++) {
    k.box(fg, k.std(cols[i], 0.85, 0, true), fw, bh, 0.006, fw / 2 + 0.008, -bh / 2 - i * bh, 0);
  }
  k.box(fg, k.team, 0.018, bh * 3, 0.01, 0.006, -bh * 1.5, 0); // team hoist trim
}

function sandbagLine(k: Kit, p: THREE.Object3D, a: P2, b: P2, rows = 2) {
  const m1 = k.std(C.sand, 0.95, 0);
  const m2 = k.std(shade(C.sand, 0.86), 0.95, 0);
  const g = gSph(1, 7, 4);
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const len = Math.hypot(dx, dz);
  const n = Math.max(1, Math.round(len / 0.095));
  const ang = Math.atan2(-dz, dx);
  for (let row = 0; row < rows; row++) {
    const off = row % 2 ? 0.5 : 0;
    for (let i = 0; i < n - (row % 2); i++) {
      const t = (i + 0.5 + off) / n;
      const me = k.mk(p, g, (i + row) % 3 ? m1 : m2, a[0] + dx * t, 0.045 + row * 0.04, a[1] + dz * t, 0, ang, 0);
      me.scale.set(0.054, 0.026, 0.034);
    }
  }
}

function containerBox(k: Kit, p: THREE.Object3D, x: number, y: number, z: number, color: number, ry = 0) {
  const g = k.group(p, x, y, z);
  g.rotation.y = ry;
  k.box(g, k.std(color, 0.8, 0.25), 0.6, 0.24, 0.24, 0, 0.12, 0);
  const d = k.std(shade(color, 0.72), 0.8, 0.25);
  for (let i = 0; i < 6; i++) {
    k.box(g, d, 0.014, 0.21, 0.252, -0.25 + i * 0.1, 0.12, 0);
  }
  k.box(g, d, 0.006, 0.22, 0.22, 0.301, 0.12, 0);
}

function lattice(k: Kit, p: THREE.Object3D, m: THREE.Material, x: number, z: number, y0: number, h: number, wb: number, wt: number, levels: number, r = 0.008) {
  const pts = (t: number): V3[] => {
    const hw = (wb + (wt - wb) * t) / 2;
    const y = y0 + h * t;
    return [
      [x - hw, y, z - hw],
      [x + hw, y, z - hw],
      [x + hw, y, z + hw],
      [x - hw, y, z + hw],
    ];
  };
  const b = pts(0);
  const t = pts(1);
  for (let i = 0; i < 4; i++) k.strut(p, m, b[i], t[i], r * 1.4, 5);
  for (let l = 1; l <= levels; l++) {
    const lo = pts((l - 1) / levels);
    const hi = pts(l / levels);
    for (let i = 0; i < 4; i++) {
      k.strut(p, m, hi[i], hi[(i + 1) % 4], r, 4);
      k.strut(p, m, lo[i], hi[(i + 1) % 4], r * 0.8, 4);
    }
  }
}

function vent(k: Kit, p: THREE.Object3D, x: number, y: number, z: number, spin = true) {
  k.box(p, k.std(0x8a8f92, 0.6, 0.4), 0.12, 0.05, 0.12, x, y + 0.025, z);
  k.mk(p, gCyl(0.045, 0.045, 0.012, 12), k.dark, x, y + 0.054, z);
  const f = k.group(p, x, y + 0.062, z);
  k.box(f, k.steel, 0.08, 0.004, 0.014, 0, 0, 0);
  k.box(f, k.steel, 0.014, 0.004, 0.08, 0, 0, 0);
  if (spin) k.spin(f, 'y', 4);
}

function hazardBorder(k: Kit, p: THREE.Object3D, x0: number, x1: number, z0: number, z1: number, y: number, t = 0.05) {
  const yel = k.std(C.yellow, 0.7, 0.1);
  const blk = k.std(0x1c1c1c, 0.8, 0.1);
  const seg = 0.1;
  const edge = (ax: number, az: number, bx: number, bz: number) => {
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(2, Math.round(len / seg));
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n;
      const along = len / n;
      const horiz = Math.abs(bz - az) < 1e-6;
      k.box(p, i % 2 ? blk : yel, horiz ? along : t, 0.006, horiz ? t : along, ax + (bx - ax) * u, y, az + (bz - az) * u);
    }
  };
  edge(x0, z0, x1, z0);
  edge(x0, z1, x1, z1);
  edge(x0, z0 + t, x0, z1 - t);
  edge(x1, z0 + t, x1, z1 - t);
}

function gableRoof(k: Kit, p: THREE.Object3D, m: THREE.Material, x: number, y: number, z: number, lenX: number, depthZ: number, rh: number) {
  const g = gSide(
    [
      [-depthZ / 2 - 0.035, 0],
      [depthZ / 2 + 0.035, 0],
      [0, rh],
    ],
    lenX + 0.06,
  );
  return k.mk(p, g, m, x, y, z, 0, Math.PI / 2, 0);
}

function buildConyard(k: Kit) {
  const r = k.m.root;
  slab(k, 3, 3);
  const Y = 0.06;
  // main hall
  const hx0 = -1.4;
  const hx1 = 0.45;
  const hz0 = -1.35;
  const hz1 = 0.35;
  const hcx = (hx0 + hx1) / 2;
  const hcz = (hz0 + hz1) / 2;
  const hw = hx1 - hx0;
  const hd = hz1 - hz0;
  const hh = 0.55;
  k.box(r, k.wall, hw, hh, hd, hcx, Y + hh / 2, hcz);
  k.box(r, k.wallD, hw + 0.02, 0.06, hd + 0.02, hcx, Y + hh + 0.03, hcz); // parapet
  k.box(r, k.roof, hw - 0.06, 0.02, hd - 0.06, hcx, Y + hh + 0.05, hcz);
  // roof monitors with glowing clerestory + team panels
  for (const zz of [-0.95, -0.35]) {
    k.box(r, k.wallD, hw - 0.3, 0.12, 0.24, hcx, Y + hh + 0.12, zz);
    gableRoof(k, r, k.roof, hcx, Y + hh + 0.18, zz, hw - 0.3, 0.24, 0.08);
    windows(k, r, 'x', hx0 + 0.25, hx1 - 0.25, 9, Y + hh + 0.12, zz + 0.123, 0.12, 0.05, C.win);
  }
  k.box(r, k.team, 0.5, 0.012, 0.3, hcx - 0.45, Y + hh + 0.065, 0.05);
  k.box(r, k.team, 0.5, 0.012, 0.3, hcx + 0.35, Y + hh + 0.065, 0.05);
  // big front door (+Z)
  k.box(r, k.dark, 0.9, 0.42, 0.02, -0.55, Y + 0.21, hz1 + 0.002);
  for (let i = 0; i < 6; i++) k.box(r, k.std(0x5a5f63, 0.6, 0.5), 0.86, 0.008, 0.01, -0.55, Y + 0.05 + i * 0.065, hz1 + 0.014);
  hazardBorder(k, r, -1.02, -0.08, hz1 + 0.01, hz1 + 0.06, Y + 0.002, 0.04);
  k.box(r, k.team, 1.0, 0.05, 0.016, -0.55, Y + 0.46, hz1 + 0.006);
  windows(k, r, 'x', 0.05, 0.35, 3, Y + 0.38, hz1 + 0.004, 0.07, 0.07);
  windows(k, r, 'z', hz0 + 0.2, hz1 - 0.2, 8, Y + 0.4, hx1 + 0.004, 0.08, 0.06);
  k.box(r, k.team, 0.016, 0.05, hd, hx1 + 0.006, Y + 0.48, hcz);
  vent(k, r, -1.2, Y + hh + 0.06, 0.15);
  vent(k, r, 0.25, Y + hh + 0.06, 0.15);
  // control tower (back right)
  const tx = 1.0;
  const tz = -0.95;
  k.mk(r, gCyl(0.2, 0.26, 0.85, 4), k.wall, tx, Y + 0.425, tz, 0, Math.PI / 4, 0);
  k.box(r, k.team, 0.3, 0.05, 0.3, tx, Y + 0.6, tz);
  const cabY = Y + 0.85;
  k.mk(r, gCyl(0.3, 0.24, 0.18, 8), k.wallD, tx, cabY + 0.09, tz, 0, Math.PI / 8, 0);
  k.mk(r, gCyl(0.29, 0.29, 0.1, 8), k.glow(0x8fd0f0, 0.85), tx, cabY + 0.12, tz, 0, Math.PI / 8, 0);
  k.mk(r, gCyl(0.33, 0.3, 0.04, 8), k.roof, tx, cabY + 0.2, tz, 0, Math.PI / 8, 0);
  antenna(k, r, tx + 0.1, cabY + 0.22, tz, 0.3);
  k.light(r, C.red, 0.018, tx + 0.1, cabY + 0.53, tz, 3.2);
  k.mk(r, gCyl(0.06, 0.06, 0.04, 8), k.steel, tx - 0.1, cabY + 0.24, tz);
  // crane (front right) with rotating jib
  const cxp = 0.95;
  const czp = 0.9;
  const yel = k.std(C.yellow, 0.55, 0.25);
  k.box(r, k.concrete, 0.3, 0.06, 0.3, cxp, Y + 0.03, czp);
  lattice(k, r, yel, cxp, czp, Y + 0.06, 0.9, 0.16, 0.14, 4, 0.007);
  const jib = k.group(r, cxp, Y + 0.99, czp);
  k.mk(jib, gCyl(0.1, 0.1, 0.04, 10), k.dark, 0, -0.02, 0);
  k.box(jib, yel, 0.12, 0.12, 0.12, 0, 0.06, 0);
  k.box(jib, k.glow(C.win, 2), 0.01, 0.06, 0.08, 0.065, 0.07, 0);
  k.box(jib, yel, 1.05, 0.05, 0.06, 0.3, 0.14, 0);
  k.box(jib, yel, 0.8, 0.015, 0.05, 0.4, 0.18, 0);
  for (let i = 0; i < 7; i++) k.strut(jib, yel, [-0.2 + i * 0.13, 0.165, 0], [-0.135 + i * 0.13, 0.18, 0], 0.005, 4);
  k.box(jib, k.team, 0.14, 0.1, 0.12, -0.25, 0.1, 0); // counterweight
  k.mk(jib, gCyl(0.004, 0.004, 0.5, 4), k.dark, 0.7, -0.11, 0);
  k.box(jib, k.gunM, 0.04, 0.04, 0.03, 0.7, -0.37, 0);
  k.box(jib, k.gunM, 0.04, 0.02, 0.04, 0.7, 0.14, 0);
  k.spin(jib, 'y', 0.25);
  // stacked containers (front left)
  containerBox(k, r, -1.05, Y, 0.85, 0x2f6b8f, 0);
  containerBox(k, r, -1.05, Y, 1.15, 0x8c4a2f, 0);
  containerBox(k, r, -1.0, Y + 0.24, 1.0, mix(k.s.team, 0x888888, 0.25), 0.15);
  flag(k, r, -0.3, 1.25, 0.75);
  lamp(k, r, 0.4, 1.3);
  lamp(k, r, -0.6, 0.6);
  // yard markings
  k.box(r, k.std(C.yellow, 0.8, 0), 0.6, 0.004, 0.03, 0.15, Y + 0.002, 0.95);
  k.box(r, k.std(C.yellow, 0.8, 0), 0.03, 0.004, 0.5, -0.15, Y + 0.002, 1.0);
  k.m.height = 1.25;
}

function coolingTower(k: Kit, p: THREE.Object3D, x: number, z: number, R: number, h: number) {
  const waist = 0.7 * h;
  const rw = R * 0.66;
  const rAt = (y: number) => {
    const t = (y - waist) / (y < waist ? waist : h - waist);
    return rw + (y < waist ? (R - rw) * t * t : (R * 0.78 - rw) * t * t);
  };
  const pts: P2[] = [];
  for (let i = 0; i <= 8; i++) pts.push([rAt((i / 8) * h), (i / 8) * h]);
  const wall = 0.022;
  pts.push([rAt(h) - wall, h]);
  pts.push([rAt(h - 0.06) - wall, h - 0.06]);
  pts.push([rAt(h - 0.13) - wall, h - 0.13]);
  pts.push([0.001, h - 0.13]);
  const m = k.std(0xd2cec4, 0.95, 0);
  k.mk(p, gLathe(pts, 20), m, x, 0.06, z);
  k.mk(p, gCyl(rAt(h - 0.12) - wall - 0.002, rAt(h - 0.12) - wall - 0.002, 0.004, 20), k.std(0x2a2a2a, 1, 0), x, 0.06 + h - 0.125, z);
  k.mk(p, gCyl(R + 0.02, R + 0.04, 0.05, 20), k.std(0x9a958a, 0.95, 0), x, 0.085, z);
  const y0 = 0.8 * h;
  const y1 = 0.9 * h;
  k.mk(p, gCyl(rAt(y1) + 0.004, rAt(y0) + 0.004, y1 - y0, 20, true), k.team, x, 0.06 + (y0 + y1) / 2, z);
  k.mk(p, gTorus(rAt(h) - wall / 2, wall * 0.6, 4, 24), k.std(0xb8b2a6, 0.9, 0), x, 0.06 + h, z, Math.PI / 2, 0, 0);
  k.emit(x, 0.06 + h + 0.05, z, 'steam');
}

function buildPower(k: Kit) {
  const r = k.m.root;
  slab(k, 2, 2);
  const Y = 0.06;
  coolingTower(k, r, -0.45, -0.45, 0.42, 1.0);
  coolingTower(k, r, 0.5, -0.55, 0.32, 0.78);
  // generator hall (front)
  const x0 = -0.92;
  const x1 = 0.2;
  const z0 = 0.05;
  const z1 = 0.85;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  k.box(r, k.wall, x1 - x0, 0.32, z1 - z0, cx, Y + 0.16, cz);
  gableRoof(k, r, k.roof, cx, Y + 0.32, cz, x1 - x0, z1 - z0, 0.14);
  k.box(r, k.team, x1 - x0 + 0.01, 0.04, z1 - z0 + 0.01, cx, Y + 0.28, cz);
  windows(k, r, 'x', x0 + 0.12, x1 - 0.12, 6, Y + 0.18, z1 + 0.004, 0.08, 0.07);
  windows(k, r, 'z', z0 + 0.12, z1 - 0.12, 4, Y + 0.18, x1 + 0.004, 0.08, 0.07);
  k.box(r, k.dark, 0.2, 0.2, 0.012, -0.7, Y + 0.1, z1 + 0.004);
  // chimney stack
  k.mk(r, gCyl(0.05, 0.065, 0.75, 10), k.std(0xb8b0a2, 0.9, 0), -0.75, Y + 0.375, -0.02);
  k.mk(r, gCyl(0.058, 0.058, 0.05, 10), k.team, -0.75, Y + 0.68, -0.02);
  k.emit(-0.75, Y + 0.78, -0.02, 'smoke');
  // pipes from towers into the hall
  const pm = k.std(0x8f9497, 0.5, 0.5);
  k.strut(r, pm, [-0.45, Y + 0.25, -0.1], [-0.45, Y + 0.25, 0.05], 0.03, 8);
  k.strut(r, pm, [0.5, Y + 0.18, -0.25], [0.15, Y + 0.18, 0.05], 0.025, 8);
  // transformer yard (front right)
  for (const [tx, tz] of [
    [0.48, 0.3],
    [0.75, 0.68],
  ]) {
    k.box(r, k.concrete, 0.26, 0.04, 0.26, tx, Y + 0.02, tz);
    k.box(r, k.std(0x6f767a, 0.6, 0.4), 0.18, 0.14, 0.14, tx, Y + 0.11, tz);
    for (let i = 0; i < 3; i++) k.box(r, k.std(0x5a6064, 0.6, 0.4), 0.2, 0.1, 0.012, tx, Y + 0.1, tz - 0.05 + i * 0.05);
    for (let i = 0; i < 3; i++) {
      k.mk(r, gTorus(0.03, 0.009, 5, 12), k.glow(C.cyan, 2.6), tx - 0.05 + i * 0.05, Y + 0.2, tz, Math.PI / 2, 0, 0);
      k.mk(r, gTorus(0.024, 0.008, 5, 12), k.glow(C.cyan, 2.6), tx - 0.05 + i * 0.05, Y + 0.23, tz, Math.PI / 2, 0, 0);
      k.mk(r, gCyl(0.008, 0.008, 0.12, 5), k.std(0xd8d0c0, 0.5, 0.1), tx - 0.05 + i * 0.05, Y + 0.24, tz);
    }
  }
  // fence posts
  for (let i = 0; i < 6; i++) k.mk(r, gCyl(0.006, 0.006, 0.12, 4), k.dark, 0.32 + i * 0.12, Y + 0.06, 0.94);
  k.box(r, k.dark, 0.6, 0.006, 0.006, 0.62, Y + 0.11, 0.94);
  k.box(r, k.dark, 0.6, 0.006, 0.006, 0.62, Y + 0.06, 0.94);
  lamp(k, r, 0.3, 0.6, 0.3);
  k.m.height = 1.1;
}

function silo(k: Kit, p: THREE.Object3D, x: number, z: number, R: number, h: number, y = 0.06) {
  const m = k.std(0xc9ccc9, 0.5, 0.45);
  k.mk(p, gCyl(R, R, h, 16), m, x, y + h / 2, z);
  k.mk(p, gHemi(R, 16, 5), m, x, y + h, z).scale.y = 0.45;
  k.mk(p, gCyl(R + 0.006, R + 0.006, 0.05, 16), k.team, x, y + h * 0.75, z);
  k.mk(p, gCyl(R + 0.004, R + 0.004, 0.012, 16), k.std(0x8f9497, 0.5, 0.5), x, y + h * 0.35, z);
  k.box(p, k.dark, 0.02, h, 0.03, x + R * 0.72, y + h / 2, z + R * 0.72, 0, Math.PI / 4, 0); // ladder
}

function buildRefinery(k: Kit) {
  const r = k.m.root;
  slab(k, 3, 3, 0.06, [-0.5, 0.5, 0.5]);
  const Y = 0.06;
  // dock pad (front centre tile): ground level, nothing on it taller than ~0.02
  k.box(r, k.std(C.asphalt, 0.95, 0), 0.98, 0.012, 0.98, 0, 0.006, 1.0).receiveShadow = true;
  hazardBorder(k, r, -0.47, 0.47, 0.53, 1.47, 0.014, 0.05);
  k.box(r, k.std(C.yellow, 0.8, 0), 0.04, 0.004, 0.5, 0, 0.014, 1.0);
  for (let i = 0; i < 2; i++) k.box(r, k.std(0xdddddd, 0.8, 0), 0.24, 0.004, 0.02, 0, 0.014, 0.72 + i * 0.12);
  // ore intake hopper right behind the pad
  k.box(r, k.wallD, 0.9, 0.22, 0.4, 0, Y + 0.11, 0.28);
  k.mk(
    r,
    gSide(
      [
        [-0.2, 0],
        [0.2, 0],
        [0.0, 0.16],
      ],
      0.92,
    ),
    k.dark,
    0,
    Y + 0.12,
    0.32,
    0,
    Math.PI / 2,
    0,
  );
  k.box(r, k.team, 0.92, 0.04, 0.02, 0, Y + 0.2, 0.485);
  k.box(r, k.dark, 0.6, 0.12, 0.012, 0, Y + 0.08, 0.485);
  // conveyor up into the plant
  const conv = k.group(r, 0, Y + 0.24, 0.1);
  conv.rotation.x = 0.5;
  k.box(conv, k.std(0x6f767a, 0.5, 0.5), 0.2, 0.06, 0.6, 0, 0, -0.25);
  k.box(conv, k.std(0x1d1d1d, 0.9, 0), 0.16, 0.012, 0.6, 0, 0.035, -0.25);
  // processing building (back)
  const x0 = -1.42;
  const x1 = 0.55;
  const z0 = -1.4;
  const z1 = -0.12;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  k.box(r, k.wall, x1 - x0, 0.5, z1 - z0, cx, Y + 0.25, cz);
  k.box(r, k.roof, x1 - x0 + 0.02, 0.04, z1 - z0 + 0.02, cx, Y + 0.52, cz);
  k.box(r, k.wallD, 0.8, 0.25, 0.7, cx - 0.4, Y + 0.66, cz - 0.15);
  gableRoof(k, r, k.roof, cx - 0.4, Y + 0.785, cz - 0.15, 0.8, 0.7, 0.14);
  k.box(r, k.team, x1 - x0 + 0.01, 0.05, z1 - z0 + 0.01, cx, Y + 0.44, cz);
  windows(k, r, 'x', x0 + 0.15, x1 - 0.15, 10, Y + 0.3, z1 + 0.004, 0.08, 0.07);
  windows(k, r, 'z', z0 + 0.15, z1 - 0.15, 6, Y + 0.3, x1 + 0.004, 0.08, 0.07);
  windows(k, r, 'x', cx - 0.75, cx - 0.05, 6, Y + 0.68, cz + 0.204, 0.06, 0.06);
  // smelter stack
  k.mk(r, gCyl(0.07, 0.09, 0.6, 10), k.std(0x9c968a, 0.9, 0), -1.2, Y + 0.8, -1.2);
  k.mk(r, gCyl(0.075, 0.075, 0.04, 10), k.team, -1.2, Y + 1.0, -1.2);
  k.emit(-1.2, Y + 1.15, -1.2, 'smoke');
  vent(k, r, 0.2, Y + 0.54, -0.45);
  vent(k, r, 0.2, Y + 0.54, -1.05);
  // silos (right column + front right) and front-left office
  silo(k, r, 1.05, -0.95, 0.3, 0.75);
  silo(k, r, 1.05, -0.2, 0.26, 0.6);
  silo(k, r, 1.0, 0.95, 0.28, 0.5);
  const pm = k.std(0x8f9497, 0.5, 0.5);
  k.strut(r, pm, [0.55, Y + 0.4, -0.95], [0.75, Y + 0.4, -0.95], 0.03, 8);
  k.strut(r, pm, [0.55, Y + 0.32, -0.25], [0.79, Y + 0.32, -0.25], 0.025, 8);
  k.strut(r, pm, [1.0, Y + 0.3, 0.67], [1.0, Y + 0.3, 0.06], 0.022, 8);
  k.strut(r, pm, [0.72, Y + 0.3, 0.95], [0.48, Y + 0.3, 0.6], 0.02, 8);
  // office (front left)
  k.box(r, k.wall, 0.7, 0.26, 0.6, -1.0, Y + 0.13, 0.95);
  k.box(r, k.roof, 0.74, 0.03, 0.64, -1.0, Y + 0.275, 0.95);
  windows(k, r, 'x', -1.25, -0.75, 4, Y + 0.16, 1.252, 0.08, 0.07);
  windows(k, r, 'z', 0.75, 1.15, 3, Y + 0.16, -0.648, 0.08, 0.07);
  k.box(r, k.team, 0.706, 0.03, 0.606, -1.0, Y + 0.24, 0.95);
  k.box(r, k.dark, 0.12, 0.08, 0.1, -1.15, Y + 0.33, 0.9);
  lamp(k, r, -0.6, 1.35);
  lamp(k, r, 0.55, 1.35);
  k.m.height = 1.15;
}

function buildBarracks(k: Kit) {
  const r = k.m.root;
  slab(k, 2, 2);
  const Y = 0.06;
  const x0 = -0.85;
  const x1 = 0.55;
  const z0 = -0.8;
  const z1 = 0.3;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const camo = k.std(mix(k.s.hull, 0xc8c0a8, 0.35), 0.9, 0.05);
  k.box(r, camo, x1 - x0, 0.3, z1 - z0, cx, Y + 0.15, cz);
  k.box(r, k.wallD, x1 - x0 + 0.01, 0.05, z1 - z0 + 0.01, cx, Y + 0.025, cz);
  k.box(r, k.team, x1 - x0 + 0.012, 0.035, z1 - z0 + 0.012, cx, Y + 0.27, cz);
  gableRoof(k, r, k.std(shade(k.s.hull, 0.55), 0.85, 0.15), cx, Y + 0.3, cz, x1 - x0, z1 - z0, 0.26);
  // door (+Z) with canopy and lamp
  k.box(r, k.dark, 0.18, 0.22, 0.014, -0.15, Y + 0.11, z1 + 0.004);
  k.box(r, k.team, 0.24, 0.03, 0.02, -0.15, Y + 0.24, z1 + 0.008);
  k.box(r, k.roof, 0.3, 0.015, 0.12, -0.15, Y + 0.27, z1 + 0.06, 0.15, 0, 0);
  k.box(r, k.glow(C.lamp, 2.8), 0.04, 0.015, 0.015, -0.15, Y + 0.255, z1 + 0.02);
  windows(k, r, 'x', -0.7, -0.4, 2, Y + 0.17, z1 + 0.004, 0.08, 0.07);
  windows(k, r, 'x', 0.1, 0.4, 2, Y + 0.17, z1 + 0.004, 0.08, 0.07);
  windows(k, r, 'z', z0 + 0.15, z1 - 0.15, 4, Y + 0.17, x1 + 0.004, 0.08, 0.07);
  // ridge cap, roof vents, chimney
  k.box(r, k.team, x1 - x0 + 0.07, 0.025, 0.05, cx, Y + 0.555, cz);
  for (const vx of [-0.55, -0.05, 0.35]) k.mk(r, gCyl(0.022, 0.022, 0.1, 8), k.steel, vx, Y + 0.48, cz - 0.22);
  k.box(r, k.wallD, 0.1, 0.22, 0.1, -0.7, Y + 0.48, cz - 0.3);
  // gable end team emblem panel on +X
  k.box(r, k.team, 0.012, 0.1, 0.25, x1 + 0.03, Y + 0.38, cz);
  // sandbag walls
  sandbagLine(k, r, [0.25, 0.9], [0.9, 0.9], 3);
  sandbagLine(k, r, [0.9, 0.85], [0.9, 0.35], 3);
  sandbagLine(k, r, [-0.9, 0.9], [-0.45, 0.9], 2);
  // crates & flag
  k.box(r, k.std(0x6b5a3a, 0.9, 0), 0.14, 0.12, 0.14, 0.75, Y + 0.06, -0.5);
  k.box(r, k.std(0x5d6a3f, 0.9, 0), 0.12, 0.1, 0.12, 0.75, Y + 0.17, -0.5);
  k.box(r, k.std(0x5d6a3f, 0.9, 0), 0.14, 0.1, 0.12, 0.78, Y + 0.05, -0.3);
  flag(k, r, -0.75, 0.6, 0.85);
  lamp(k, r, 0.75, 0.15, 0.3);
  antenna(k, r, 0.4, Y + 0.3, -0.7, 0.35);
  k.m.height = 0.95;
}

function buildFactory(k: Kit) {
  const r = k.m.root;
  slab(k, 3, 3, 0.06, [-0.53, 0.53, -0.6]);
  const Y = 0.06;
  // bay floor + apron at ground level (vehicles spawn at the centre and drive out through +Z)
  k.box(r, k.std(C.asphalt, 0.95, 0), 1.06, 0.01, 2.08, 0, 0.005, 0.44).receiveShadow = true;
  for (const s of [-1, 1]) k.box(r, k.std(C.yellow, 0.8, 0), 0.03, 0.004, 1.9, s * 0.42, 0.012, 0.5);
  for (let i = 0; i < 4; i++) k.box(r, k.std(0xe0e0e0, 0.8, 0), 0.25, 0.004, 0.03, 0, 0.012, -0.2 + i * 0.4);
  // side halls with arched roofs
  const z0 = -1.4;
  const z1 = 1.0;
  const cz = (z0 + z1) / 2;
  const L = z1 - z0;
  for (const s of [-1, 1]) {
    const hx = s * 1.0;
    k.box(r, k.wall, 0.9, 0.45, L, hx, Y + 0.225, cz);
    k.mk(r, gArch(0.45, L + 0.04, 14), k.roof, hx, Y + 0.45, cz).scale.y = 0.55;
    // skylight strip on the arch
    k.box(r, k.glow(0x8cc8ec, 0.7), 0.08, 0.02, L - 0.2, hx, Y + 0.7, cz);
    // front faces (+Z) of halls
    k.box(r, k.team, 0.9, 0.05, 0.012, hx, Y + 0.4, z1 + 0.006);
    windows(k, r, 'x', hx - 0.3, hx + 0.3, 4, Y + 0.25, z1 + 0.006, 0.09, 0.08);
    k.box(r, k.dark, 0.3, 0.2, 0.01, hx + s * 0.18, Y + 0.1, z1 + 0.006);
    vent(k, r, hx + s * 0.25, Y + 0.45 + 0.1, -1.15, true);
  }
  windows(k, r, 'z', z0 + 0.2, z1 - 0.2, 8, Y + 0.28, 1.452, 0.1, 0.08);
  k.box(r, k.team, 0.012, 0.05, L, 1.452, Y + 0.4, cz);
  // back block over the centre (behind the bay)
  k.box(r, k.wallD, 1.1, 0.7, 0.85, 0, Y + 0.35, -1.0);
  k.box(r, k.roof, 1.14, 0.04, 0.89, 0, Y + 0.72, -1.0);
  k.box(r, k.team, 1.112, 0.06, 0.862, 0, Y + 0.6, -1.0);
  k.box(r, k.dark, 0.2, 0.08, 0.2, -0.25, Y + 0.78, -1.1);
  k.mk(r, gCyl(0.04, 0.05, 0.3, 8), k.std(0x9c968a, 0.9, 0), 0.3, Y + 0.89, -1.2);
  k.emit(0.3, Y + 1.08, -1.2, 'smoke');
  // bay roof
  const bz0 = -0.58;
  const bz1 = 1.0;
  k.box(r, k.roof, 1.12, 0.06, bz1 - bz0, 0, Y + 0.72, (bz0 + bz1) / 2);
  for (let i = 0; i < 3; i++) k.box(r, k.glow(0x8cc8ec, 0.7), 0.6, 0.02, 0.18, 0, Y + 0.755, -0.3 + i * 0.45);
  // door frame over the bay entrance
  k.box(r, k.wallD, 1.12, 0.16, 0.12, 0, Y + 0.65, 1.02);
  k.box(r, k.team, 1.12, 0.06, 0.012, 0, Y + 0.66, 1.086);
  k.mk(r, gCylX(0.05, 0.05, 1.0, 10), k.std(0x6f767a, 0.5, 0.5), 0, Y + 0.56, 0.98); // rolled-up door
  for (const s of [-1, 1]) {
    k.box(r, k.wallD, 0.08, 0.72, 0.14, s * 0.52, 0.36, 1.02);
    for (let i = 0; i < 6; i++) {
      k.box(r, k.std(i % 2 ? 0x1c1c1c : C.yellow, 0.7, 0.1), 0.012, 0.1, 0.1, s * 0.565, Y + 0.05 + i * 0.1, 1.04);
    }
    k.light(r, C.amber, 0.022, s * 0.45, Y + 0.6, 1.1, 3);
  }
  // interior back wall gets a glowing work light
  k.box(r, k.glow(C.win, 1.8), 0.6, 0.06, 0.01, 0, Y + 0.5, -0.57);
  k.box(r, k.std(0x55595d, 0.8, 0.3), 1.0, 0.72, 0.02, 0, 0.36, -0.585);
  lamp(k, r, 0.75, 1.35);
  lamp(k, r, -0.75, 1.35);
  k.m.height = 0.95;
}

function buildRadar(k: Kit) {
  const r = k.m.root;
  slab(k, 2, 2);
  const Y = 0.06;
  // operations building
  const x0 = -0.9;
  const x1 = 0.15;
  const z0 = -0.2;
  const z1 = 0.88;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  k.box(r, k.wall, x1 - x0, 0.34, z1 - z0, cx, Y + 0.17, cz);
  k.box(r, k.roof, x1 - x0 + 0.02, 0.03, z1 - z0 + 0.02, cx, Y + 0.355, cz);
  k.box(r, k.team, x1 - x0 + 0.012, 0.04, z1 - z0 + 0.012, cx, Y + 0.3, cz);
  windows(k, r, 'x', x0 + 0.12, x1 - 0.12, 5, Y + 0.18, z1 + 0.004, 0.08, 0.07);
  windows(k, r, 'z', z0 + 0.12, z1 - 0.12, 5, Y + 0.18, x1 + 0.004, 0.08, 0.07);
  k.box(r, k.wallD, 0.4, 0.18, 0.5, -0.12, Y + 0.46, 0.55);
  k.box(r, k.roof, 0.42, 0.02, 0.52, -0.12, Y + 0.56, 0.55);
  windows(k, r, 'x', -0.27, 0.03, 3, Y + 0.47, 0.802, 0.07, 0.06, 0x9fe0ff);
  windows(k, r, 'z', 0.38, 0.72, 3, Y + 0.47, 0.082, 0.07, 0.06, 0x9fe0ff);
  k.mk(r, gSph(0.15, 14, 10), k.std(0xe8e8e2, 0.5, 0.1), -0.55, Y + 0.48, 0.2);
  k.mk(r, gCyl(0.1, 0.12, 0.08, 10), k.wallD, -0.55, Y + 0.41, 0.2);
  vent(k, r, -0.6, Y + 0.37, 0.65);
  antenna(k, r, -0.8, Y + 0.37, 0.75, 0.3);
  // lattice mast + dish
  const mx = 0.45;
  const mz = -0.45;
  k.box(r, k.concrete, 0.42, 0.06, 0.42, mx, Y + 0.03, mz);
  const mastM = k.std(0x9a9fa3, 0.5, 0.6);
  lattice(k, r, mastM, mx, mz, Y + 0.06, 1.0, 0.34, 0.12, 5, 0.008);
  k.box(r, k.dark, 0.18, 0.04, 0.18, mx, Y + 1.08, mz);
  const head = k.group(r, mx, Y + 1.1, mz);
  k.mk(head, gCyl(0.05, 0.06, 0.08, 10), k.dark, 0, 0.04, 0);
  const dish = k.group(head, 0.03, 0.22, 0);
  dish.rotation.z = -Math.PI / 2 + 0.35;
  k.mk(dish, gDish(0.34, 0.11, 18), k.std(0xd6d8d6, 0.5, 0.3, true), 0, 0, 0);
  k.mk(dish, gTorus(0.34, 0.012, 4, 24), k.team, 0, 0.11, 0, Math.PI / 2, 0, 0);
  for (const a of [0, (Math.PI * 2) / 3, (Math.PI * 4) / 3]) {
    k.strut(dish, mastM, [Math.cos(a) * 0.32, 0.105, Math.sin(a) * 0.32], [0, 0.3, 0], 0.005, 4);
  }
  k.mk(dish, gCyl(0.025, 0.02, 0.05, 8), k.dark, 0, 0.31, 0);
  k.box(head, k.dark, 0.1, 0.12, 0.08, -0.06, 0.12, 0);
  k.spin(head, 'y', 1.5);
  k.light(r, C.red, 0.02, mx, Y + 1.12, mz + 0.1, 3.2);
  k.m.height = 1.55;
}

function buildAirfield(k: Kit) {
  const r = k.m.root;
  slab(k, 3, 3);
  const Y = 0.06;
  // hangar (left)
  const hx = -1.0;
  const z0 = -1.35;
  const z1 = 0.95;
  const cz = (z0 + z1) / 2;
  const L = z1 - z0;
  k.box(r, k.wall, 0.86, 0.32, L, hx, Y + 0.16, cz);
  k.mk(r, gArch(0.45, L + 0.04, 16), k.roof, hx, Y + 0.32, cz).scale.y = 0.7;
  k.box(r, k.glow(0x8cc8ec, 0.7), 0.08, 0.02, L - 0.2, hx, Y + 0.635, cz);
  k.box(r, k.dark, 0.7, 0.42, 0.012, hx, Y + 0.21, z1 + 0.008);
  k.box(r, k.team, 0.86, 0.05, 0.014, hx, Y + 0.45, z1 + 0.01);
  k.box(r, k.glow(C.win, 1.6), 0.6, 0.03, 0.006, hx, Y + 0.38, z1 + 0.016);
  windows(k, r, 'z', z0 + 0.2, z1 - 0.2, 7, Y + 0.2, hx + 0.434, 0.09, 0.07);
  // launch pad
  const px = 0.32;
  const pz = 0.3;
  k.mk(r, gCyl(0.8, 0.8, 0.012, 32), k.std(C.asphalt, 0.95, 0), px, Y + 0.006, pz).receiveShadow = true;
  const ring = k.mk(r, gTorus(0.65, 0.02, 3, 40), k.std(C.yellow, 0.7, 0), px, Y + 0.014, pz, Math.PI / 2, 0, 0);
  ring.scale.z = 0.3;
  const wm = k.std(0xeeeeea, 0.7, 0);
  k.box(r, wm, 0.06, 0.006, 0.5, px - 0.15, Y + 0.014, pz);
  k.box(r, wm, 0.06, 0.006, 0.5, px + 0.15, Y + 0.014, pz);
  k.box(r, wm, 0.3, 0.006, 0.06, px, Y + 0.014, pz);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    k.mk(r, gCyl(0.015, 0.018, 0.02, 6), k.glow(i % 2 ? C.green : 0x5fb0ff, 2.6), px + Math.cos(a) * 0.76, Y + 0.02, pz + Math.sin(a) * 0.76);
  }
  // control tower (back right)
  const tx = 1.05;
  const tz = -1.05;
  k.box(r, k.wall, 0.34, 0.55, 0.34, tx, Y + 0.275, tz);
  k.box(r, k.team, 0.35, 0.05, 0.35, tx, Y + 0.45, tz);
  const cy = Y + 0.55;
  k.mk(r, gCyl(0.27, 0.22, 0.04, 8), k.wallD, tx, cy + 0.02, tz, 0, Math.PI / 8, 0);
  k.mk(r, gCyl(0.25, 0.26, 0.13, 8), k.glow(0x8fd0f0, 0.85), tx, cy + 0.105, tz, 0, Math.PI / 8, 0);
  k.mk(r, gCyl(0.3, 0.27, 0.04, 8), k.roof, tx, cy + 0.19, tz, 0, Math.PI / 8, 0);
  const ant = k.group(r, tx, cy + 0.23, tz);
  k.mk(ant, gCyl(0.015, 0.02, 0.06, 6), k.dark, 0, 0.03, 0);
  k.box(ant, k.std(0xd8d8d2, 0.5, 0.3), 0.04, 0.05, 0.26, 0, 0.075, 0);
  k.spin(ant, 'y', 2.2);
  k.light(r, C.red, 0.016, tx + 0.15, cy + 0.24, tz, 3);
  // windsock + fuel tanks
  k.mk(r, gCyl(0.006, 0.006, 0.4, 4), k.dark, 1.3, Y + 0.2, 1.3);
  k.mk(r, gCylX(0.02, 0.035, 0.14, 8), k.std(0xff7a1a, 0.7, 0), 1.37, Y + 0.38, 1.3);
  k.mk(r, gCylZ(0.09, 0.09, 0.4, 12), k.std(0xd8d8d2, 0.5, 0.3), 1.25, Y + 0.1, -0.35);
  k.mk(r, gCylZ(0.09, 0.09, 0.4, 12), k.std(0xd8d8d2, 0.5, 0.3), 1.25, Y + 0.1, 0.0);
  k.box(r, k.team, 0.19, 0.03, 0.02, 1.25, Y + 0.13, 0.205);
  lamp(k, r, -0.4, 1.3);
  k.m.height = 0.95;
}

function buildTech(k: Kit) {
  const r = k.m.root;
  slab(k, 3, 3);
  const Y = 0.06;
  const oct = regular(8, 1.1, Math.PI / 8);
  k.mk(r, gPlan(oct, 0.42, 0.04), k.wall, 0, Y, 0);
  k.mk(r, gPlan(regular(8, 1.13, Math.PI / 8), 0.06, 0.02), k.wallD, 0, Y, 0);
  k.mk(r, gPlan(regular(8, 1.12, Math.PI / 8), 0.05, 0.015), k.team, 0, Y + 0.33, 0);
  // window bands on each face
  const ap = 1.1 * Math.cos(Math.PI / 8);
  const side = 2 * 1.1 * Math.sin(Math.PI / 8);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const g = k.group(r, Math.cos(a) * (ap + 0.005), Y + 0.2, -Math.sin(a) * (ap + 0.005));
    g.rotation.y = a;
    k.box(g, k.glow(0xbfeaff, 1.1), 0.012, 0.06, side * 0.75, 0, 0, 0);
    k.box(g, k.glow(0xbfeaff, 1.1), 0.012, 0.03, side * 0.75, 0, 0.1, 0);
  }
  // upper tier + dome
  k.mk(r, gPlan(regular(8, 0.8, Math.PI / 8), 0.14, 0.03), k.wallD, 0, Y + 0.42, 0);
  const dy = Y + 0.56;
  k.mk(r, gTorus(0.68, 0.035, 6, 32), k.team, 0, dy + 0.01, 0, Math.PI / 2, 0, 0);
  k.mk(r, gHemi(0.66, 24, 10), k.glass(0x9fe6ff, 0.4, 0x2aa8e0, 0.45), 0, dy, 0);
  for (let i = 0; i < 4; i++) {
    k.mk(r, gTorusArc(0.66, 0.008), k.std(0xd0d8dc, 0.4, 0.6), 0, dy, 0, 0, (i * Math.PI) / 4, 0);
  }
  k.mk(r, gSph(0.16, 14, 10), k.glow(0x7ff4ff, 1.8), 0, dy + 0.2, 0);
  k.mk(r, gCyl(0.05, 0.08, 0.2, 10), k.std(0x707880, 0.4, 0.6), 0, dy + 0.0, 0);
  k.mk(r, gTorus(0.25, 0.012, 4, 24), k.glow(0x7ff4ff, 1.8), 0, dy + 0.2, 0, Math.PI / 2, 0, 0);
  // corner modules + antennas
  for (const [x, z] of [
    [1.05, 1.05],
    [-1.05, 1.05],
    [1.05, -1.05],
  ]) {
    k.box(r, k.wallD, 0.4, 0.22, 0.4, x, Y + 0.11, z);
    k.box(r, k.team, 0.41, 0.04, 0.41, x, Y + 0.18, z);
    k.box(r, k.roof, 0.42, 0.02, 0.42, x, Y + 0.23, z);
  }
  for (const [x, z, h] of [
    [-0.85, -0.6, 0.9],
    [-0.6, -0.85, 0.7],
  ]) {
    k.mk(r, gCyl(0.012, 0.025, h, 6), k.std(0xb0b6ba, 0.4, 0.6), x, Y + 0.42 + h / 2, z);
    k.light(r, C.red, 0.022, x, Y + 0.42 + h + 0.01, z, 3.2);
  }
  // entrance (+Z)
  k.box(r, k.wallD, 0.4, 0.25, 0.2, 0, Y + 0.125, 1.08);
  k.box(r, k.glow(0xbfeaff, 1.4), 0.24, 0.16, 0.01, 0, Y + 0.09, 1.185);
  k.box(r, k.team, 0.42, 0.04, 0.21, 0, Y + 0.25, 1.08);
  k.m.height = 1.45;
}

function buildBunker(k: Kit) {
  const r = k.m.root;
  slab(k, 1, 1, 0.04);
  const Y = 0.04;
  const hex = regular(6, 0.36, Math.PI / 6);
  k.mk(r, gPlan(hex, 0.12, 0.02), k.concrete, 0, Y, 0);
  k.mk(r, gPlan(regular(6, 0.335, Math.PI / 6), 0.04, 0), k.std(0x151515, 1, 0), 0, Y + 0.12, 0);
  k.mk(r, gPlan(regular(6, 0.37, Math.PI / 6), 0.07, 0.025), k.concrete, 0, Y + 0.16, 0);
  k.mk(r, gPlan(regular(6, 0.37, Math.PI / 6), 0.02, 0.008), k.team, 0, Y + 0.1, 0);
  sandbagLine(k, r, [0.42, -0.25], [0.42, 0.25], 2);
  sandbagLine(k, r, [-0.25, 0.42], [0.25, 0.42], 2);
  // turret (MG mount)
  const tur = k.group(r, 0, Y + 0.23, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.11, 0.12, 0.03, 12), k.dark, 0, 0.015, 0);
  k.box(tur, k.hullD, 0.03, 0.07, 0.03, 0, 0.06, 0);
  k.box(tur, k.gunM, 0.16, 0.04, 0.035, 0.03, 0.1, 0);
  k.box(tur, k.hull, 0.015, 0.09, 0.16, 0.07, 0.1, 0); // gun shield
  k.box(tur, k.team, 0.016, 0.02, 0.16, 0.071, 0.135, 0);
  k.box(tur, k.std(0x5d6a3f, 0.8, 0.1), 0.05, 0.04, 0.04, -0.01, 0.1, 0.04);
  const b = recoilGroup(k, tur, 0.11, 0.1, 0);
  k.mk(b, gCylX(0.008, 0.009, 0.16, 6), k.gunM, 0.08, 0, 0);
  k.muzzle(b, 0.17, 0, 0);
  k.m.height = 0.42;
}

function buildSentry(k: Kit) {
  const r = k.m.root;
  slab(k, 1, 1, 0.04);
  const Y = 0.04;
  k.mk(r, gPlan(regular(8, 0.28, Math.PI / 8), 0.06, 0.015), k.concrete, 0, Y, 0);
  k.mk(r, gCyl(0.05, 0.07, 0.32, 10), k.std(0x6f767a, 0.5, 0.5), 0, Y + 0.22, 0);
  k.box(r, k.dark, 0.12, 0.14, 0.08, -0.17, Y + 0.13, 0.12); // control box
  k.box(r, k.glow(C.green, 2.2), 0.004, 0.02, 0.03, -0.108, Y + 0.17, 0.12);
  sandbagLine(k, r, [0.4, -0.3], [0.4, 0.3], 2);
  const tur = k.group(r, 0, Y + 0.38, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.07, 0.07, 0.03, 12), k.dark, 0, 0.015, 0);
  const hm = k.std(0xb9bdb6, 0.5, 0.35);
  k.mk(
    tur,
    gSide(
      [
        [-0.1, 0.03],
        [0.08, 0.03],
        [0.11, 0.07],
        [0.09, 0.15],
        [-0.1, 0.15],
      ],
      0.14,
      0.012,
    ),
    hm,
  );
  k.box(tur, k.team, 0.14, 0.02, 0.144, -0.02, 0.13, 0);
  // camera / thermal sensor (glow lens)
  k.mk(tur, gCylX(0.03, 0.03, 0.02, 12), k.dark, 0.1, 0.11, 0.035);
  k.mk(tur, gCylX(0.022, 0.022, 0.01, 12), k.glow(C.red, 3), 0.112, 0.11, 0.035);
  k.mk(tur, gCylX(0.016, 0.016, 0.02, 10), k.dark, 0.1, 0.11, -0.035);
  k.mk(tur, gCylX(0.011, 0.011, 0.008, 10), k.glow(C.cyan, 2.6), 0.111, 0.11, -0.035);
  // MG below the sensor
  k.box(tur, k.gunM, 0.12, 0.035, 0.035, 0.05, 0.05, 0);
  const b = recoilGroup(k, tur, 0.11, 0.05, 0);
  k.mk(b, gCylX(0.007, 0.008, 0.16, 6), k.gunM, 0.08, 0, 0);
  k.muzzle(b, 0.17, 0, 0);
  k.box(tur, k.std(0x5d6a3f, 0.8, 0.1), 0.06, 0.05, 0.04, -0.02, 0.05, -0.09);
  k.m.height = 0.6;
}

function buildSAM(k: Kit) {
  const r = k.m.root;
  slab(k, 1, 1, 0.04);
  const Y = 0.04;
  k.mk(r, gPlan(regular(8, 0.36, Math.PI / 8), 0.06, 0.015), k.concrete, 0, Y, 0);
  // radar panel (static, back)
  k.mk(r, gCyl(0.015, 0.02, 0.22, 6), k.dark, -0.32, Y + 0.11, -0.32);
  const rp = k.group(r, -0.32, Y + 0.26, -0.32);
  rp.rotation.set(0, Math.PI / 4, -0.25);
  k.box(rp, k.std(0x6c7378, 0.5, 0.5), 0.03, 0.14, 0.18, 0, 0, 0);
  k.box(rp, k.std(0x2a2e33, 0.4, 0.5), 0.006, 0.12, 0.16, 0.017, 0, 0);
  k.box(r, k.glow(C.green, 2.2), 0.012, 0.012, 0.012, -0.27, Y + 0.2, -0.27);
  // turret
  const tur = k.group(r, 0, Y + 0.06, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.2, 0.22, 0.05, 14), k.hullD, 0, 0.025, 0);
  for (const s of [-1, 1]) k.box(tur, k.hull, 0.12, 0.2, 0.03, -0.02, 0.15, s * 0.13);
  k.box(tur, k.team, 0.1, 0.04, 0.27, -0.08, 0.08, 0);
  const pack = k.group(tur, -0.02, 0.22, 0);
  pack.rotation.z = 0.55;
  k.box(pack, k.hull, 0.46, 0.03, 0.22, 0.03, -0.075, 0);
  const tubeM = k.std(mix(k.s.hull, 0xd8d8d0, 0.4), 0.6, 0.2);
  for (const y of [-0.035, 0.05]) {
    for (const z of [-0.055, 0.055]) {
      k.mk(pack, gCylX(0.042, 0.042, 0.5, 10), tubeM, 0.03, y, z);
      k.mk(pack, gCylX(0.045, 0.045, 0.02, 10), k.team, 0.27, y, z);
      k.mk(pack, gCylX(0.032, 0.032, 0.01, 10), k.std(0x222222, 0.8, 0), 0.28, y, z);
      k.muzzle(pack, 0.3, y, z);
    }
  }
  k.m.height = 0.62;
}

function buildATGM(k: Kit) {
  const r = k.m.root;
  slab(k, 1, 1, 0.04);
  const Y = 0.04;
  const th = 0.42;
  k.mk(r, gCyl(0.22 * Math.SQRT2, 0.3 * Math.SQRT2, th, 4), k.concrete, 0, Y + th / 2, 0, 0, Math.PI / 4, 0);
  k.box(r, k.team, 0.4, 0.04, 0.42, 0, Y + th - 0.08, 0);
  k.box(r, k.wallD, 0.48, 0.04, 0.48, 0, Y + th + 0.02, 0);
  k.box(r, k.std(0x151515, 1, 0), 0.08, 0.03, 0.006, 0.12, Y + 0.28, 0.25, -0.12, 0, 0); // slit
  // ladder on +Z
  for (const s of [-1, 1]) k.box(r, k.dark, 0.01, th, 0.01, s * 0.05, Y + th / 2, 0.29, -0.17, 0, 0);
  for (let i = 0; i < 6; i++) k.box(r, k.dark, 0.1, 0.008, 0.008, 0, Y + 0.05 + i * 0.065, 0.285 - i * 0.011);
  const tur = k.group(r, 0, Y + th + 0.04, 0);
  k.m.turret = tur;
  k.mk(tur, gCyl(0.09, 0.1, 0.04, 12), k.dark, 0, 0.02, 0);
  k.box(tur, k.hull, 0.06, 0.1, 0.05, 0, 0.09, 0);
  const pod = k.group(tur, 0, 0.13, 0);
  pod.rotation.z = 0.08;
  k.box(pod, k.hull, 0.36, 0.08, 0.17, 0.04, 0, 0.0);
  k.box(pod, k.team, 0.2, 0.084, 0.02, 0.0, 0, 0.08);
  for (const z of [-0.042, 0.042]) {
    k.mk(pod, gCylX(0.032, 0.032, 0.012, 10), k.gunM, 0.225, 0, z);
    k.mk(pod, gCylX(0.024, 0.024, 0.014, 10), k.std(0x1a1a1a, 0.9, 0), 0.228, 0, z);
  }
  k.muzzle(pod, 0.25, 0, 0.042);
  // sensor head
  k.box(tur, k.std(0x30343a, 0.4, 0.5), 0.08, 0.07, 0.06, 0.02, 0.13, -0.12);
  k.mk(tur, gCylX(0.02, 0.02, 0.01, 10), k.glow(C.red, 3), 0.064, 0.13, -0.12);
  k.m.height = 0.75;
}

function buildOil(k: Kit) {
  const r = k.m.root;
  k.mk(r, gPlan(rect(1.9, 1.9), 0.03, 0.01), k.std(0x6f675a, 0.95, 0)).receiveShadow = true;
  k.mk(r, gCyl(0.55, 0.6, 0.006, 18), k.std(0x1c1a17, 0.4, 0.2), 0.1, 0.033, 0.25).scale.set(0.9, 1, 0.55);
  const Y = 0.03;
  const steel = k.std(0x6d6f68, 0.6, 0.5);
  const beamM = k.std(mix(k.s.team, 0x808080, 0.15), 0.6, 0.35);
  // skid
  k.box(r, k.dark, 1.15, 0.05, 0.22, -0.05, Y + 0.025, 0.15);
  // samson post (A-frame)
  for (const s of [-1, 1]) {
    k.strut(r, steel, [-0.18, Y + 0.05, 0.15 + s * 0.1], [0.0, Y + 0.6, 0.15 + s * 0.03], 0.016, 6);
    k.strut(r, steel, [0.18, Y + 0.05, 0.15 + s * 0.1], [0.0, Y + 0.6, 0.15 + s * 0.03], 0.016, 6);
  }
  // walking beam (static, slightly tilted) + horse head
  const beam = k.group(r, 0, Y + 0.62, 0.15);
  beam.rotation.z = 0.08;
  k.box(beam, beamM, 0.95, 0.05, 0.05, 0.05, 0, 0);
  k.mk(
    beam,
    gSide(
      [
        [0.48, 0.07],
        [0.56, 0.05],
        [0.6, -0.02],
        [0.58, -0.14],
        [0.52, -0.14],
        [0.53, -0.02],
        [0.48, 0.02],
      ],
      0.08,
      0.01,
    ),
    beamM,
  );
  k.box(beam, k.dark, 0.06, 0.06, 0.06, -0.4, -0.03, 0);
  k.mk(beam, gCylZ(0.035, 0.035, 0.1, 10), k.dark, 0, -0.01, 0);
  // polished rod to the wellhead
  k.mk(r, gCyl(0.005, 0.005, 0.46, 4), k.std(0xd0d0d0, 0.3, 0.8), 0.585, Y + 0.31, 0.15);
  k.mk(r, gCyl(0.035, 0.045, 0.1, 8), k.std(0x8a3b2a, 0.6, 0.4), 0.585, Y + 0.05, 0.15);
  k.box(r, steel, 0.12, 0.04, 0.12, 0.585, Y + 0.12, 0.15);
  // gearbox + crank (spinner about Z) + pitman arms
  k.box(r, k.std(0x55595d, 0.6, 0.4), 0.16, 0.16, 0.12, -0.42, Y + 0.13, 0.15);
  for (const s of [-1, 1]) {
    const crank = k.group(r, -0.42, Y + 0.18, 0.15 + s * 0.085);
    k.box(crank, k.dark, 0.26, 0.04, 0.02, 0.04, 0, 0);
    k.box(crank, k.std(0xd02a20, 0.6, 0.3), 0.1, 0.12, 0.03, -0.12, 0, 0);
    k.spin(crank, 'z', -1.2);
    k.strut(r, steel, [-0.3, Y + 0.2, 0.15 + s * 0.085], [-0.36, Y + 0.58, 0.15 + s * 0.04], 0.008, 4);
  }
  // storage tank + pipes
  const tm = k.std(0xc0bfb5, 0.6, 0.35);
  k.mk(r, gCyl(0.3, 0.3, 0.5, 18), tm, 0.5, Y + 0.25, -0.5);
  k.mk(r, gCyl(0.31, 0.3, 0.05, 18), k.team, 0.5, Y + 0.42, -0.5);
  k.mk(r, gCyl(0.31, 0.31, 0.02, 18), k.dark, 0.5, Y + 0.51, -0.5);
  k.box(r, k.dark, 0.02, 0.5, 0.04, 0.72, Y + 0.25, -0.3, 0, Math.PI / 4, 0);
  k.mk(r, gCyl(0.24, 0.24, 0.35, 16), tm, -0.45, Y + 0.175, -0.6);
  k.mk(r, gCyl(0.245, 0.245, 0.04, 16), k.team, -0.45, Y + 0.3, -0.6);
  const pm = k.std(0x55504a, 0.6, 0.5);
  k.strut(r, pm, [0.585, Y + 0.08, 0.15], [0.585, Y + 0.08, -0.2], 0.018, 6);
  k.strut(r, pm, [0.585, Y + 0.08, -0.2], [0.5, Y + 0.08, -0.2], 0.018, 6);
  k.strut(r, pm, [0.2, Y + 0.1, -0.5], [-0.21, Y + 0.1, -0.6], 0.018, 6);
  // shed + lamp
  k.box(r, k.std(0x8a8270, 0.9, 0.05), 0.3, 0.2, 0.26, -0.62, Y + 0.1, 0.7);
  k.box(r, k.roof, 0.34, 0.02, 0.3, -0.62, Y + 0.21, 0.7, 0.1, 0, 0);
  k.box(r, k.glow(C.win, 2), 0.08, 0.06, 0.006, -0.62, Y + 0.12, 0.833);
  lamp(k, r, 0.75, 0.75, 0.32);
  k.m.height = 0.8;
}

function buildGeneric(k: Kit) {
  const r = k.m.root;
  k.box(r, k.hull, 0.5, 0.25, 0.4, 0, 0.125, 0);
  k.box(r, k.team, 0.52, 0.06, 0.42, 0, 0.18, 0);
  k.m.height = 0.3;
}

// ================================================================== table

const BUILDERS: Record<string, (k: Kit) => void> = {
  rifle: (k) => infantry(k, { head: 'helmet', weapon: 'rifle', pack: 'pack' }),
  at: (k) => infantry(k, { head: 'helmet', weapon: 'at', pack: 'pack' }),
  engineer: (k) => infantry(k, { head: 'hardhat', weapon: 'none', pack: 'toolbox' }),
  mortar: (k) => {
    infantry(k, { head: 'helmet', weapon: 'none', pack: 'radio' });
    const r = k.m.root;
    const z = 0.12;
    k.mk(r, gCyl(0.04, 0.042, 0.008, 10), k.dark, 0.0, 0.004, z);
    const tubeM = k.std(shade(k.s.hull, 0.5), 0.6, 0.35);
    const tube = k.group(r, 0.0, 0.012, z);
    tube.rotation.z = 0.95; // tube tilts up toward +X
    k.mk(tube, gCylX(0.013, 0.015, 0.2, 8), tubeM, 0.1, 0, 0);
    k.mk(tube, gCylX(0.016, 0.016, 0.015, 8), k.dark, 0.19, 0, 0);
    k.muzzle(tube, 0.21, 0, 0);
    const mid: V3 = [0.12 * Math.cos(0.95), 0.012 + 0.12 * Math.sin(0.95), z];
    k.strut(r, k.dark, [0.13, 0, z - 0.04], mid, 0.004, 4);
    k.strut(r, k.dark, [0.13, 0, z + 0.04], mid, 0.004, 4);
    k.box(r, k.std(0x5d6a3f, 0.85, 0), 0.06, 0.035, 0.04, -0.07, 0.0175, z);
  },
  fpvteam: (k) => infantry(k, { head: 'helmet', weapon: 'controller', pack: 'drone', goggles: true }),
  ewinf: (k) => {
    infantry(k, { head: 'helmet', weapon: 'carbine', pack: 'jammer' });
    k.m.height = 0.5;
  },
  mbt: buildMBT,
  mbt_heavy: buildMBTHeavy,
  aa: buildAA,
  laser: buildLaser,
  arty: buildArty,
  tos: buildTOS,
  ew: buildEW,
  berge: buildBerge,
  ugv: buildUGV,
  swarm: buildSwarm,
  missile_truck: buildMissileTruck,
  container: buildContainer,
  harvester: buildHarvester,
  mcv: buildMCV,
  uav: buildUAV,
  heavy_uav: buildHeavyUAV,
  jet: buildJet,
  fpv: buildFPV,
  micro: buildMicro,
  shahed: buildShahed,
  conyard: (k) => ((k.recv = true), buildConyard(k)),
  power: (k) => ((k.recv = true), buildPower(k)),
  refinery: (k) => ((k.recv = true), buildRefinery(k)),
  barracks: (k) => ((k.recv = true), buildBarracks(k)),
  factory: (k) => ((k.recv = true), buildFactory(k)),
  radar: (k) => ((k.recv = true), buildRadar(k)),
  airfield: (k) => ((k.recv = true), buildAirfield(k)),
  tech: (k) => ((k.recv = true), buildTech(k)),
  bunker: (k) => ((k.recv = true), buildBunker(k)),
  sentry: (k) => ((k.recv = true), buildSentry(k)),
  sam: (k) => ((k.recv = true), buildSAM(k)),
  atgm: (k) => ((k.recv = true), buildATGM(k)),
  oil: (k) => ((k.recv = true), buildOil(k)),
};

export function createModel(key: string, style: ModelStyle, fog: FogOfWar | null): Model {
  const b = BUILDERS[key];
  try {
    const k = new Kit(style, fog);
    (b ?? buildGeneric)(k);
    return k.m;
  } catch (e) {
    console.error(`createModel(${key}) failed`, e);
    const k = new Kit(style, fog);
    buildGeneric(k);
    return k.m;
  }
}

export function disposeModelCaches(): void {
  for (const g of geoCache.values()) g.dispose();
  for (const m of matCache.values()) m.dispose();
  geoCache.clear();
  matCache.clear();
}
