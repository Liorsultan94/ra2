import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { pbrMaterial, worldUV, type CamoPattern, type MatOpts } from '../textures';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle } from './types';
import { uniformCamo, unitLook } from './unittex';

/*
 * Procedural, animated infantry.
 *
 * Every soldier is a rigidly skinned character: the parts are modelled in
 * metres around a real-proportioned skeleton (pelvis -> spine -> head / arms,
 * hips -> thigh -> shin -> foot, plus a weapon bone), then every part that
 * shares a material is merged into ONE SkinnedMesh (vertex weight 1 to its
 * bone). A soldier is therefore ~6-8 draw calls whatever its gear count.
 * The whole body is scaled by S so a 1.8 m man is 0.34 tiles tall.
 *
 * Animation is procedural: gait from s.dist, IK arms that keep both hands on
 * the weapon in every pose (low ready / aim / recoil), kneeling, team specific
 * actions (mortar loading, AT reload, FPV launch) and a death fall.
 *
 * Templates are cached per (key, faction, team, fog) and cloned per unit.
 */

type V3 = [number, number, number];
type G = THREE.BufferGeometry;
const PI = Math.PI;
const S = 0.34 / 1.8; // metres -> tiles

// ------------------------------------------------------------------ math

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const approach = (cur: number, target: number, dt: number, rate: number) => cur + (target - cur) * (1 - Math.exp(-dt * rate));

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();

// ------------------------------------------------------------- geometry

function xf<T extends G>(g: T, p: V3 = [0, 0, 0], r: V3 = [0, 0, 0], s: V3 | number = 1): T {
  _e.set(r[0], r[1], r[2], 'XYZ');
  _q.setFromEuler(_e);
  if (typeof s === 'number') _s.set(s, s, s);
  else _s.set(s[0], s[1], s[2]);
  _m.compose(_v.set(p[0], p[1], p[2]), _q, _s);
  g.applyMatrix4(_m);
  return g;
}
const sph = (rx: number, ry: number, rz: number, w = 8, h = 6) => xf(new THREE.SphereGeometry(1, w, h), undefined, undefined, [rx, ry, rz]);
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Rounded box; tiny ones degrade to plain boxes (invisible at game scale). */
const rbox = (w: number, h: number, d: number, r: number, seg = 1): G =>
  Math.max(w, h, d) < 0.16 ? new THREE.BoxGeometry(w, h, d) : new RoundedBoxGeometry(w, h, d, Math.min(seg, 1), Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4));
const cylY = (rt: number, rb: number, h: number, seg = 6, open = false) => new THREE.CylinderGeometry(rt, rb, h, seg, 1, open);
/** Cylinder along +X (rt at +X end). */
const cylX = (rt: number, rb: number, h: number, seg = 6, open = false) => xf(cylY(rt, rb, h, seg, open), undefined, [0, 0, -PI / 2]);
/** Tapered limb hanging down from the origin along -Y, rounded both ends. */
function limb(r0: number, r1: number, len: number, seg = 7): G {
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 2; i++) {
    const a = -PI / 2 + (i * PI) / 4;
    pts.push(new THREE.Vector2(Math.max(1e-4, r1 * Math.cos(a)), -len + r1 * Math.sin(a)));
  }
  for (let i = 1; i <= 2; i++) {
    const a = (i * PI) / 4;
    pts.push(new THREE.Vector2(Math.max(1e-4, r0 * Math.cos(a)), r0 * Math.sin(a)));
  }
  return new THREE.LatheGeometry(pts, seg);
}
function lathe(pts: [number, number][], seg = 12): G {
  return new THREE.LatheGeometry(
    pts.map(([r, y]) => new THREE.Vector2(Math.max(1e-4, r), y)),
    seg,
  );
}
/** Open dome (helmet shell): sphere cap of polar angle `cap`. */
const dome = (cap: number, w = 12, h = 5) => new THREE.SphereGeometry(1, w, h, 0, PI * 2, 0, cap);
/** Deterministic radial jitter (rag helmet covers). */
function jitter(g: G, amt: number, seed: number) {
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const h = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
    const k = 1 + (h - Math.floor(h) - 0.5) * 2 * amt;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * (1 + (k - 1) * 0.5), p.getZ(i) * k);
  }
  g.computeVertexNormals();
  return g;
}
/** Segment between two points as a thin cylinder. */
function strut(a: V3, b: V3, r: number, seg = 5): G {
  const va = new THREE.Vector3(...a);
  const vb = new THREE.Vector3(...b);
  const d = vb.clone().sub(va);
  const g = cylY(r, r, d.length(), seg);
  _q.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  _m.compose(va.add(vb).multiplyScalar(0.5), _q, _s.set(1, 1, 1));
  g.applyMatrix4(_m);
  return g;
}

// --------------------------------------------------------------- kits

type MK = 'camo' | 'gear' | 'skin' | 'dark' | 'gun' | 'tube' | 'team' | 'glow' | 'hat';
const MK_ORDER: MK[] = ['camo', 'gear', 'skin', 'dark', 'gun', 'tube', 'team', 'glow', 'hat'];
/** Texture repeats per metre (worldUV) for textured materials. */
const UVS: Partial<Record<MK, number>> = { camo: 2.6, gear: 3.5, dark: 5, gun: 4, tube: 3 };

type HelmetKind = 'fast' | 'mitz' | 'm92' | '6b47' | 'qgf' | 'boonie' | 'hardhat';
type RifleKind = 'm4' | 'hk416' | 'tavor' | 'ak12' | 'ak74' | 'akm' | 'qbz191' | 'k2c' | 'mpt76';
type AtKind = 'javelin' | 'matador' | 'pzf3' | 'rpg7' | 'rpg29' | 'pf98';

interface Kit {
  camo: MatOpts;
  gearTex: 'camo' | 'canvas';
  gear: MatOpts;
  bootsGear: boolean;
  skin: number;
  helmet: HelmetKind;
  vest: 'pc' | 'bulky' | 'rig';
  rifle: RifleKind;
  at: AtKind;
  gun: number;
  tube: number;
  earpro: boolean;
  gloves: 'gear' | 'dark' | 'skin';
}

const cam = (pattern: CamoPattern, color: number, color2: number, color3: number, color4: number, seed: number): MatOpts => ({ pattern, color, color2, color3, color4, seed, grime: 0.12, size: 256 });
const canvas = (color: number): MatOpts => ({ color, grime: 0.2, size: 128, seed: 3 });

const KITS: Record<string, Kit> = {
  usa: {
    camo: cam('woodland', 0xa69a74, 0x6f6f4c, 0x5c4a34, 0xcabd96, 11), // OCP / multicam-like
    gearTex: 'canvas',
    gear: canvas(0x8c7854), // coyote brown
    bootsGear: true,
    skin: 0xb58a6a,
    helmet: 'fast',
    vest: 'pc',
    rifle: 'm4',
    at: 'javelin',
    gun: 0x2c2d2b,
    tube: 0x6c6a4c,
    earpro: true,
    gloves: 'gear',
  },
  israel: {
    camo: cam('plain', 0x5f5f3e, 0x56573a, 0x4a4c33, 0x66664a, 12), // IDF olive
    gearTex: 'canvas',
    gear: canvas(0x4d5034),
    bootsGear: false,
    skin: 0xb08866,
    helmet: 'mitz',
    vest: 'pc',
    rifle: 'tavor',
    at: 'matador',
    gun: 0x2a2b28,
    tube: 0x5a5d44,
    earpro: false,
    gloves: 'dark',
  },
  germany: {
    camo: cam('flecktarn', 0x707452, 0x464f30, 0x23241c, 0x6c4c31, 13), // Flecktarn
    gearTex: 'camo',
    gear: cam('flecktarn', 0x666a4a, 0x40482c, 0x22231b, 0x634631, 14),
    bootsGear: false,
    skin: 0xc9a184,
    helmet: 'm92',
    vest: 'pc',
    rifle: 'hk416',
    at: 'pzf3',
    gun: 0x2b2c2a,
    tube: 0x505a3c,
    earpro: false,
    gloves: 'dark',
  },
  russia: {
    camo: cam('digital', 0x75755a, 0x4e5538, 0x35362b, 0x8c7f60, 15), // Ratnik EMR
    gearTex: 'camo',
    gear: cam('digital', 0x6c6d52, 0x484f34, 0x292a22, 0x837759, 16),
    bootsGear: false,
    skin: 0xc8a387,
    helmet: '6b47',
    vest: 'bulky',
    rifle: 'ak12',
    at: 'rpg29',
    gun: 0x252624,
    tube: 0x3f4633,
    earpro: false,
    gloves: 'dark',
  },
  ukraine: {
    camo: cam('digital', 0x807b5a, 0x575c3c, 0x3a3a2b, 0x9c9170, 17), // MM-14 pixel
    gearTex: 'canvas',
    gear: canvas(0x595b3d),
    bootsGear: false,
    skin: 0xc6a085,
    helmet: 'fast',
    vest: 'bulky',
    rifle: 'ak74',
    at: 'rpg7',
    gun: 0x262725,
    tube: 0x414a35,
    earpro: true,
    gloves: 'gear',
  },
  china: {
    camo: cam('digital', 0x66704f, 0x3f4c34, 0x25291f, 0x847b5a, 18), // Type 07 woodland digital
    gearTex: 'camo',
    gear: cam('digital', 0x5f694a, 0x3c4732, 0x24271e, 0x7a7254, 19),
    bootsGear: false,
    skin: 0xc49c78,
    helmet: 'qgf',
    vest: 'pc',
    rifle: 'qbz191',
    at: 'pf98',
    gun: 0x2a2b29,
    tube: 0x4e5a3e,
    earpro: false,
    gloves: 'dark',
  },
  korea: {
    camo: cam('digital', 0x6e7260, 0x4a5141, 0x2b2d28, 0x8d886e, 20), // granite-B
    gearTex: 'camo',
    gear: cam('digital', 0x64685a, 0x454b3d, 0x2a2c27, 0x837e66, 21),
    bootsGear: false,
    skin: 0xc29a77,
    helmet: 'fast',
    vest: 'pc',
    rifle: 'k2c',
    at: 'pzf3',
    gun: 0x292a28,
    tube: 0x4f573f,
    earpro: true,
    gloves: 'dark',
  },
  iran: {
    camo: cam('digital', 0xb5a27b, 0x8f7c57, 0x6b5b3f, 0xcdbd93, 22), // desert digital
    gearTex: 'canvas',
    gear: canvas(0x95835f),
    bootsGear: false,
    skin: 0xa27656,
    helmet: 'boonie',
    vest: 'rig',
    rifle: 'akm',
    at: 'rpg7',
    gun: 0x2e2a26,
    tube: 0x4a4a36,
    earpro: false,
    gloves: 'skin',
  },
  turkey: {
    camo: cam('woodland', 0x777a5b, 0x4c5340, 0x2c2d26, 0x978c6c, 23),
    gearTex: 'canvas',
    gear: canvas(0x6a6447),
    bootsGear: false,
    skin: 0xae8463,
    helmet: 'm92',
    vest: 'pc',
    rifle: 'mpt76',
    at: 'pzf3',
    gun: 0x2a2a28,
    tube: 0x4e553e,
    earpro: false,
    gloves: 'dark',
  },
};
const REGION_FALLBACK: Record<string, string> = { west: 'usa', east: 'russia', asia: 'china', mideast: 'iran' };

function kitFor(style: ModelStyle): Kit {
  return KITS[style.faction] ?? KITS[REGION_FALLBACK[style.region] ?? 'usa'] ?? KITS.usa;
}

// ------------------------------------------------------------ materials

const fogIds = new WeakMap<FogOfWar, number>();
let fogCounter = 0;
function fogId(fog: FogOfWar | null) {
  if (!fog) return 0;
  let id = fogIds.get(fog);
  if (!id) fogIds.set(fog, (id = ++fogCounter));
  return id;
}
const stdCache = new Map<string, THREE.MeshStandardMaterial>();
function stdMat(key: string, fog: FogOfWar | null, p: THREE.MeshStandardMaterialParameters) {
  const k = `${fogId(fog)}:${key}`;
  let m = stdCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial(p);
    if (fog) fog.apply(m);
    stdCache.set(k, m);
  }
  return m;
}

/** Uniform fabric: the army's real camouflage pattern on a twill weave (unittex.ts), with the unit rim light. */
function uniformMat(faction: string, tint: number, fog: FogOfWar | null) {
  const k = `${fogId(fog)}:uni:${faction}:${tint}`;
  let m = stdCache.get(k);
  if (!m) {
    const t = uniformCamo(faction);
    m = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, color: tint, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.6, 0.6) });
    if (fog) fog.apply(m);
    unitLook(m, { rim: 0.7 });
    stdCache.set(k, m);
  }
  return m;
}

function materials(kit: Kit, style: ModelStyle, fog: FogOfWar | null, glow: number): Record<MK, THREE.Material> {
  const fac = KITS[style.faction] ? style.faction : (REGION_FALLBACK[style.region] ?? 'usa');
  return {
    camo: uniformMat(fac, 0xffffff, fog),
    gear: kit.gearTex === 'camo' ? uniformMat(fac, 0xe4e4e4, fog) : pbrMaterial(kit.gearTex, { ...kit.gear, normalScale: 0.6 }, fog),
    dark: pbrMaterial('rubber', { color: 0x2a2a27, size: 128, roughness: 0.9 }, fog),
    gun: pbrMaterial('metalPanel', { color: kit.gun, size: 128, divisions: 1, grime: 0.15, metalness: 0.45, roughness: 0.85 }, fog),
    tube: pbrMaterial('metalPanel', { color: kit.tube, size: 128, divisions: 1, grime: 0.35, metalness: 0.25, roughness: 1 }, fog),
    skin: stdMat(`skin:${kit.skin}`, fog, { color: kit.skin, roughness: 0.72, metalness: 0 }),
    team: stdMat(`team:${style.team}`, fog, { color: style.team, roughness: 0.5, metalness: 0.05, emissive: style.team, emissiveIntensity: 0.6 }),
    glow: stdMat(`glow:${glow}`, fog, { color: 0x101010, emissive: glow, emissiveIntensity: 2.6, roughness: 0.4 }),
    hat: stdMat('hat', fog, { color: 0xe2b322, roughness: 0.42, metalness: 0.05 }),
  };
}

// ------------------------------------------------------------------- rig

class Rig {
  readonly top = new THREE.Group();
  readonly bones: THREE.Bone[] = [];
  private parts = new Map<MK, G[]>();

  bone(name: string, parent: THREE.Object3D | null, x: number, y: number, z: number): THREE.Bone {
    const b = new THREE.Bone();
    b.name = name;
    b.position.set(x, y, z);
    b.rotation.order = 'YXZ';
    (parent ?? this.top).add(b);
    this.bones.push(b);
    return b;
  }
  point(name: string, parent: THREE.Object3D, p: V3): THREE.Object3D {
    const o = new THREE.Object3D();
    o.name = name;
    o.position.set(p[0], p[1], p[2]);
    parent.add(o);
    return o;
  }
  /** Add parts (modelled in the bone's local frame at its rest pose). */
  add(b: THREE.Bone, mk: MK, ...geos: G[]) {
    b.updateWorldMatrix(true, false);
    const idx = this.bones.indexOf(b);
    let list = this.parts.get(mk);
    if (!list) this.parts.set(mk, (list = []));
    for (const g of geos) {
      if (!g.index) {
        const n = g.attributes.position.count;
        const ix: number[] = [];
        for (let i = 0; i < n; i++) ix.push(i);
        g.setIndex(ix);
      }
      g.applyMatrix4(b.matrixWorld);
      const n = g.attributes.position.count;
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      for (let i = 0; i < n; i++) {
        si[i * 4] = idx;
        sw[i * 4] = 1;
      }
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      list.push(g);
    }
  }
  /** World (body-space) position of a bone-local point at rest. */
  rest(b: THREE.Object3D, p: V3): THREE.Vector3 {
    b.updateWorldMatrix(true, false);
    return new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(b.matrixWorld);
  }
  finish(mats: Record<MK, THREE.Material>, sphere: THREE.Sphere, uvs: Partial<Record<MK, number>>): { skel: THREE.Skeleton; tris: number } {
    this.top.updateMatrixWorld(true);
    const skel = new THREE.Skeleton(this.bones);
    const bind = new THREE.Matrix4();
    let tris = 0;
    for (const mk of MK_ORDER) {
      const list = this.parts.get(mk);
      if (!list || !list.length) continue;
      for (const g of list) {
        for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal' && name !== 'uv' && name !== 'skinIndex' && name !== 'skinWeight') g.deleteAttribute(name);
      }
      const g = mergeGeometries(list, false);
      for (const x of list) x.dispose();
      if (!g) continue;
      const sc = uvs[mk] ?? UVS[mk];
      if (sc) worldUV(g, sc);
      tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
      const m = new THREE.SkinnedMesh(g, mats[mk]);
      m.name = 'skin_' + mk;
      m.castShadow = true;
      m.receiveShadow = false;
      m.bind(skel, bind);
      m.boundingSphere = sphere.clone();
      this.top.add(m);
    }
    this.parts.clear();
    return { skel, tris };
  }
}

// --------------------------------------------------------------- weapons

interface WInfo {
  kind: 'rifle' | 'launcher' | 'controller' | 'bomb';
  grip: THREE.Vector3; // right hand centre (weapon local)
  fore: THREE.Vector3; // left hand centre
  pivot: THREE.Vector3; // butt (rifle) / shoulder contact (launcher) / centre
  round: boolean; // has a separate 'round' bone (visible warhead)
}
type Part = [MK, G];

interface RifleSpec {
  rec: number;
  hg: number;
  bar: number;
  stock: 'm4' | 'fixed' | 'fold';
  stockLen: number;
  mag: 'str' | 'curve' | 'str20';
  optic: 'dot' | 'acog' | 'none';
  bull?: boolean;
}
const RIFLES: Record<RifleKind, RifleSpec> = {
  m4: { rec: 0.24, hg: 0.24, bar: 0.09, stock: 'm4', stockLen: 0.25, mag: 'str', optic: 'acog' },
  hk416: { rec: 0.24, hg: 0.27, bar: 0.08, stock: 'm4', stockLen: 0.25, mag: 'str', optic: 'dot' },
  tavor: { rec: 0, hg: 0, bar: 0.14, stock: 'fixed', stockLen: 0, mag: 'str', optic: 'dot', bull: true },
  ak12: { rec: 0.29, hg: 0.22, bar: 0.15, stock: 'fold', stockLen: 0.26, mag: 'curve', optic: 'dot' },
  ak74: { rec: 0.29, hg: 0.2, bar: 0.18, stock: 'fixed', stockLen: 0.25, mag: 'curve', optic: 'none' },
  akm: { rec: 0.29, hg: 0.2, bar: 0.18, stock: 'fixed', stockLen: 0.26, mag: 'curve', optic: 'none' },
  qbz191: { rec: 0.25, hg: 0.29, bar: 0.08, stock: 'm4', stockLen: 0.24, mag: 'str', optic: 'acog' },
  k2c: { rec: 0.25, hg: 0.22, bar: 0.1, stock: 'fold', stockLen: 0.23, mag: 'str', optic: 'dot' },
  mpt76: { rec: 0.27, hg: 0.3, bar: 0.17, stock: 'm4', stockLen: 0.25, mag: 'str20', optic: 'acog' },
};

function rifleGeo(kind: RifleKind, short: boolean): { parts: Part[]; w: WInfo; muzzle: V3 } {
  const sp = RIFLES[kind];
  const parts: Part[] = [];
  const P = (g: G) => parts.push(['gun', g]);
  const by = 0.055; // bore height above the grip
  if (sp.bull) {
    // bullpup (Tavor): action behind the grip
    P(xf(rbox(0.5, 0.085, 0.045, 0.018), [-0.13, 0.045, 0]));
    P(xf(rbox(0.13, 0.03, 0.03, 0.01), [0.04, -0.025, 0])); // long trigger guard
    P(xf(rbox(0.035, 0.09, 0.026, 0.008), [-0.005, -0.03, 0], [0, 0, -0.25])); // grip
    P(xf(rbox(0.042, 0.14, 0.024, 0.006), [-0.16, -0.05, 0], [0, 0, -0.12])); // mag behind grip
    P(xf(cylX(0.01, 0.01, sp.bar, 6), [0.12 + sp.bar / 2, by, 0]));
    P(xf(cylX(0.013, 0.013, 0.04, 6), [0.14 + sp.bar, by, 0]));
    P(xf(rbox(0.06, 0.045, 0.035, 0.01), [0.0, 0.11, 0])); // red dot
    P(xf(box(0.3, 0.012, 0.022), [-0.02, 0.09, 0])); // rail
    const muzzle: V3 = [0.17 + sp.bar, by, 0];
    return { parts, muzzle, w: { kind: 'rifle', grip: new THREE.Vector3(-0.01, -0.01, 0.006), fore: new THREE.Vector3(0.13, 0.0, 0), pivot: new THREE.Vector3(-0.38, 0.04, 0), round: false } };
  }
  const hg = short ? sp.hg * 0.72 : sp.hg;
  const bar = short ? sp.bar * 0.5 : sp.bar;
  const x0 = -0.07; // receiver rear
  const x1 = x0 + sp.rec; // receiver front
  P(xf(box(sp.rec, 0.062, 0.034), [x0 + sp.rec / 2, 0.05, 0]));
  P(xf(rbox(hg, 0.05, 0.045, 0.014), [x1 + hg / 2, 0.056, 0]));
  P(xf(cylX(0.009, 0.009, bar, 6), [x1 + hg + bar / 2, by, 0]));
  P(xf(cylX(0.012, 0.012, 0.045, 6), [x1 + hg + bar + 0.022, by, 0]));
  P(xf(rbox(0.034, 0.1, 0.028, 0.008), [-0.012, -0.005, 0], [0, 0, -0.3])); // pistol grip
  if (sp.mag === 'curve') {
    P(xf(rbox(0.045, 0.09, 0.024, 0.006), [0.075, -0.015, 0], [0, 0, -0.12]));
    P(xf(rbox(0.045, 0.09, 0.024, 0.006), [0.098, -0.09, 0], [0, 0, -0.42]));
  } else {
    const ml = sp.mag === 'str20' ? 0.12 : 0.15;
    P(xf(rbox(0.04, ml, 0.024, 0.006), [0.075, 0.03 - ml / 2, 0], [0, 0, -0.1]));
  }
  // stock
  let butt: number;
  if (sp.stock === 'm4') {
    P(xf(cylX(0.015, 0.015, sp.stockLen * 0.7, 6), [x0 - sp.stockLen * 0.35, 0.055, 0]));
    P(xf(rbox(sp.stockLen * 0.55, 0.065, 0.036, 0.012), [x0 - sp.stockLen * 0.72, 0.04, 0]));
    butt = x0 - sp.stockLen;
  } else if (sp.stock === 'fold') {
    P(xf(rbox(sp.stockLen, 0.05, 0.034, 0.012), [x0 - sp.stockLen / 2, 0.045, 0]));
    P(xf(rbox(0.03, 0.09, 0.036, 0.01), [x0 - sp.stockLen + 0.015, 0.03, 0]));
    butt = x0 - sp.stockLen;
  } else {
    P(xf(rbox(sp.stockLen, 0.06, 0.036, 0.014), [x0 - sp.stockLen / 2, 0.03, 0], [0, 0, 0.12]));
    butt = x0 - sp.stockLen;
  }
  // sights
  if (sp.optic === 'acog') {
    P(xf(cylX(0.018, 0.021, 0.12, 8), [0.04, 0.115, 0]));
    P(xf(box(0.05, 0.03, 0.02), [0.04, 0.09, 0]));
  } else if (sp.optic === 'dot') {
    P(xf(rbox(0.06, 0.045, 0.034, 0.01), [0.05, 0.105, 0]));
  } else {
    P(xf(box(0.012, 0.04, 0.008), [x1 + hg - 0.01, 0.09, 0]));
    P(xf(box(0.03, 0.015, 0.02), [x1 - 0.12, 0.09, 0]));
  }
  if (sp.optic !== 'none') P(xf(box(sp.rec + hg * 0.8, 0.01, 0.022), [x0 + (sp.rec + hg * 0.8) / 2, 0.085, 0])); // top rail
  const muzzle: V3 = [x1 + hg + bar + 0.05, by, 0];
  return {
    parts,
    muzzle,
    w: { kind: 'rifle', grip: new THREE.Vector3(-0.012, -0.012, 0.006), fore: new THREE.Vector3(x1 + hg * 0.55, 0.012, 0), pivot: new THREE.Vector3(butt, 0.045, 0), round: false },
  };
}

function launcherGeo(kind: AtKind): { parts: Part[]; round: Part[]; w: WInfo; muzzle: V3; roundAt: V3 | null } {
  const parts: Part[] = [];
  const round: Part[] = [];
  const T = (g: G) => parts.push(['tube', g]);
  const Gn = (g: G) => parts.push(['gun', g]);
  const grip = (x: number) => Gn(xf(rbox(0.034, 0.1, 0.028, 0.008), [x, -0.0, 0], [0, 0, -0.25]));
  let h: number;
  let r: number;
  let muzzle: V3;
  let fore = new THREE.Vector3(0.18, 0.0, 0);
  const gripP = new THREE.Vector3(-0.005, -0.01, 0.006);
  let pivotX = -0.13;
  let roundAt: V3 | null = null;
  let tubeZ = 0;
  switch (kind) {
    case 'rpg7': {
      h = 0.085;
      r = 0.024;
      T(xf(cylX(r, r, 0.95, 8), [-0.025, h, 0]));
      T(xf(cylX(0.034, 0.034, 0.26, 8), [-0.06, h, 0])); // heat guard
      T(xf(cylX(r, 0.05, 0.14, 8), [-0.57, h, 0])); // venturi flare
      grip(0);
      grip(0.17);
      Gn(xf(box(0.08, 0.04, 0.026), [0.03, h + 0.04, -0.035])); // PGO-7 sight
      // PG-7V warhead
      round.push(['tube', xf(cylX(0.018, 0.018, 0.1, 6), [0.5, h, 0])]);
      round.push(['tube', xf(cylX(0.042, 0.042, 0.11, 10), [0.6, h, 0])]);
      round.push(['tube', xf(cylX(0.006, 0.042, 0.14, 10), [0.725, h, 0])]);
      roundAt = [0.45, h, 0];
      muzzle = [0.5, h, 0];
      break;
    }
    case 'rpg29': {
      h = 0.1;
      r = 0.052;
      T(xf(cylX(r, r, 1.5, 10), [-0.03, h, 0]));
      T(xf(cylX(r + 0.008, r + 0.008, 0.06, 10), [-0.1, h, 0])); // joint ring
      T(xf(cylX(r + 0.006, r + 0.006, 0.05, 10), [0.7, h, 0]));
      T(xf(cylX(r + 0.006, r + 0.006, 0.05, 10), [-0.76, h, 0]));
      grip(0);
      grip(0.2);
      Gn(xf(rbox(0.14, 0.07, 0.05, 0.012), [0.06, h + 0.08, -0.05])); // sight
      Gn(strut([0.55, h - 0.05, 0.02], [0.2, h - 0.06, 0.03], 0.007));
      Gn(strut([0.55, h - 0.05, -0.02], [0.2, h - 0.06, -0.03], 0.007));
      muzzle = [0.74, h, 0];
      pivotX = -0.16;
      break;
    }
    case 'javelin': {
      h = 0.1;
      r = 0.066;
      tubeZ = 0.07;
      T(xf(cylX(r, r, 1.15, 10), [0.05, h, tubeZ]));
      T(xf(cylX(r + 0.014, r + 0.014, 0.08, 10), [0.6, h, tubeZ]));
      T(xf(cylX(r + 0.014, r + 0.014, 0.08, 10), [-0.5, h, tubeZ]));
      T(xf(rbox(0.12, 0.06, 0.08, 0.015), [-0.15, h - 0.07, tubeZ])); // BCU
      // command launch unit, left of the tube in front of the face
      T(xf(rbox(0.2, 0.15, 0.17, 0.025), [0.03, h + 0.01, -0.08]));
      Gn(xf(rbox(0.06, 0.05, 0.07, 0.012), [-0.09, h + 0.03, -0.08])); // eyepiece
      Gn(xf(cylX(0.03, 0.03, 0.04, 8), [0.14, h + 0.03, -0.08])); // optics
      Gn(xf(rbox(0.03, 0.09, 0.03, 0.008), [0.0, 0.0, 0], [0, 0, -0.15]));
      Gn(xf(rbox(0.03, 0.09, 0.03, 0.008), [0.0, 0.0, -0.16], [0, 0, -0.15]));
      fore = new THREE.Vector3(0.0, -0.01, -0.16);
      muzzle = [0.66, h, tubeZ];
      pivotX = -0.24;
      break;
    }
    case 'matador': {
      h = 0.09;
      r = 0.046;
      T(xf(cylX(r, r, 1.0, 10), [0.0, h, 0]));
      T(xf(cylX(r + 0.01, r + 0.01, 0.07, 10), [0.47, h, 0]));
      T(xf(cylX(r + 0.01, r + 0.01, 0.07, 10), [-0.47, h, 0]));
      grip(0);
      grip(0.2);
      Gn(xf(rbox(0.09, 0.05, 0.03, 0.01), [0.08, h + 0.06, -0.045]));
      T(xf(rbox(0.12, 0.04, 0.05, 0.01), [-0.18, h - 0.06, 0])); // shoulder rest
      muzzle = [0.52, h, 0];
      break;
    }
    case 'pzf3': {
      h = 0.08;
      r = 0.032;
      T(xf(cylX(r, r, 0.78, 8), [-0.17, h, 0]));
      Gn(xf(rbox(0.3, 0.05, 0.04, 0.01), [0.07, h - 0.045, 0])); // firing & sighting unit
      Gn(xf(rbox(0.1, 0.06, 0.03, 0.01), [0.08, h + 0.055, -0.045]));
      grip(0);
      grip(0.19);
      // 110 mm warhead protruding from the tube
      round.push(['tube', xf(cylX(0.055, 0.05, 0.22, 10), [0.34, h, 0])]);
      round.push(['tube', xf(cylX(0.016, 0.055, 0.1, 10), [0.5, h, 0])]);
      round.push(['gun', xf(cylX(0.01, 0.01, 0.1, 5), [0.6, h, 0])]);
      roundAt = [0.23, h, 0];
      muzzle = [0.3, h, 0];
      pivotX = -0.15;
      break;
    }
    case 'pf98':
    default: {
      h = 0.1;
      r = 0.062;
      T(xf(cylX(r, r, 1.15, 10), [-0.03, h, 0]));
      T(xf(cylX(r + 0.012, r + 0.012, 0.32, 10), [0.4, h, 0]));
      T(xf(cylX(r + 0.006, r + 0.006, 0.05, 10), [-0.58, h, 0]));
      grip(0);
      grip(0.21);
      Gn(xf(rbox(0.12, 0.065, 0.045, 0.012), [0.04, h + 0.08, -0.06]));
      muzzle = [0.57, h, 0];
      pivotX = -0.16;
      break;
    }
  }
  return {
    parts,
    round,
    muzzle,
    roundAt,
    w: { kind: 'launcher', grip: gripP, fore, pivot: new THREE.Vector3(pivotX, h - r, tubeZ), round: round.length > 0 },
  };
}

// ------------------------------------------------------------------ body

type Role = 'rifle' | 'at' | 'engineer' | 'fpv' | 'ew' | 'gunner' | 'loader';
type PackKind = 'assault' | 'rpg' | 'tool' | 'jammer' | 'drone' | 'radio' | 'bombbag';

interface SolDef {
  p: string;
  role: Role;
  x: number;
  z: number;
  yaw: number;
  w: WInfo | null;
}

interface Body {
  hips: THREE.Bone;
  spine: THREE.Bone;
  head: THREE.Bone;
  uaR: THREE.Bone;
  uaL: THREE.Bone;
  faR: THREE.Bone;
  faL: THREE.Bone;
}

const TH = 0.44; // thigh
const SH = 0.43; // shin (knee -> ankle)
const UA = 0.29; // upper arm
const FA = 0.295; // elbow -> hand centre
const SHOULDER: V3 = [0, 0.385, 0.19];

function body(r: Rig, kit: Kit, p: string, x: number, z: number, yaw: number, helmet: HelmetKind, pack: PackKind): Body {
  const hips = r.bone(p + 'hips', null, x, 0.98, z);
  hips.rotation.y = yaw;
  const spine = r.bone(p + 'spine', hips, 0, 0.06, 0);
  const head = r.bone(p + 'head', spine, 0, 0.5, 0);
  const uaR = r.bone(p + 'uaR', spine, SHOULDER[0], SHOULDER[1], SHOULDER[2]);
  const faR = r.bone(p + 'faR', uaR, 0, -UA, 0);
  const uaL = r.bone(p + 'uaL', spine, SHOULDER[0], SHOULDER[1], -SHOULDER[2]);
  const faL = r.bone(p + 'faL', uaL, 0, -UA, 0);
  const glove: MK = kit.gloves === 'skin' ? 'skin' : kit.gloves;
  const bootM: MK = kit.bootsGear ? 'gear' : 'dark';
  const kneeM: MK = kit.gearTex === 'canvas' ? 'gear' : 'dark';

  // ---- pelvis, belt
  r.add(hips, 'camo', xf(sph(0.125, 0.125, 0.172, 8, 5), [0, -0.05, 0]));
  r.add(hips, 'gear', xf(cylY(1, 1, 0.05, 14, true), [0, 0.03, 0], [0, 0, 0], [0.137, 1, 0.183]));
  r.add(hips, 'gear', xf(rbox(0.06, 0.08, 0.06, 0.014), [-0.07, 0.0, 0.15]), xf(rbox(0.07, 0.07, 0.11, 0.016), [-0.14, -0.01, 0]), xf(rbox(0.06, 0.075, 0.05, 0.012), [-0.06, 0.0, -0.16]));

  // ---- legs
  for (const sd of [1, -1]) {
    const s = sd > 0 ? 'R' : 'L';
    const th = r.bone(p + 'th' + s, hips, 0, -0.04, sd * 0.095);
    const sh = r.bone(p + 'sh' + s, th, 0, -TH, 0);
    const ft = r.bone(p + 'ft' + s, sh, 0, -SH, 0);
    r.add(th, 'camo', xf(limb(0.096, 0.068, TH, 8), [0, 0, 0], [0, 0, 0], [1.08, 1, 1]));
    r.add(th, 'camo', xf(rbox(0.1, 0.12, 0.04, 0.014), [0.0, -0.22, sd * 0.07]));
    r.add(sh, 'camo', limb(0.068, 0.051, 0.36));
    r.add(sh, kneeM, xf(sph(0.037, 0.066, 0.064, 5, 4), [0.057, -0.01, 0]));
    r.add(ft, bootM, xf(cylY(0.053, 0.058, 0.16, 8), [-0.005, 0.035, 0]), xf(rbox(0.245, 0.08, 0.1, 0.03), [0.045, -0.03, 0]));
    r.add(ft, 'dark', xf(box(0.25, 0.016, 0.104), [0.045, -0.066, 0]));
  }

  // ---- torso
  const torso = lathe(
    [
      [0.128, -0.06],
      [0.14, 0.04],
      [0.155, 0.14],
      [0.17, 0.24],
      [0.176, 0.32],
      [0.164, 0.38],
      [0.12, 0.43],
      [0.06, 0.47],
      [0.045, 0.49],
    ],
    10,
  );
  r.add(spine, 'camo', xf(torso, [0, 0, 0], [0, 0, 0], [0.72, 1, 1]));
  vest(r, spine, kit);
  backpack(r, spine, kit, pack, p);

  // ---- arms
  for (const sd of [1, -1]) {
    const ua = sd > 0 ? uaR : uaL;
    const fa = sd > 0 ? faR : faL;
    r.add(ua, 'camo', xf(sph(0.074, 0.075, 0.072, 7, 5), [0, -0.02, 0]), limb(0.063, 0.05, UA - 0.02, 6));
    if (kit.vest === 'bulky') r.add(ua, 'gear', xf(sph(0.082, 0.06, 0.08, 8, 5), [0, -0.01, sd * 0.004]));
    r.add(ua, 'team', xf(cylY(0.067, 0.062, 0.1, 10, true), [0, -0.13, 0]), xf(box(0.075, 0.08, 0.02), [0.0, -0.05, sd * 0.07]));
    r.add(fa, 'camo', limb(0.052, 0.04, 0.235, 6));
    r.add(fa, glove, xf(sph(0.04, 0.056, 0.036, 6, 4), [0, -0.292, 0]), xf(box(0.022, 0.05, 0.02), [0.03, -0.272, -sd * 0.015]));
  }

  // ---- neck & head
  r.add(head, 'skin', xf(limb(0.052, 0.056, 0.11, 6), [0, 0.075, 0]));
  r.add(
    head,
    'skin',
    xf(sph(0.098, 0.117, 0.082, 9, 7), [0.0, 0.13, 0]),
    xf(sph(0.072, 0.07, 0.066, 10, 6), [0.034, 0.068, 0]),
    xf(sph(0.022, 0.032, 0.016, 5, 4), [0.1, 0.11, 0], [0, 0, -0.25]),
    xf(sph(0.016, 0.028, 0.011, 5, 4), [-0.004, 0.115, 0.082]),
    xf(sph(0.016, 0.028, 0.011, 5, 4), [-0.004, 0.115, -0.082]),
  );
  r.add(head, 'dark', xf(sph(0.011, 0.008, 0.013, 6, 4), [0.088, 0.137, 0.031]), xf(sph(0.011, 0.008, 0.013, 6, 4), [0.088, 0.137, -0.031]), xf(box(0.008, 0.006, 0.03), [0.092, 0.152, 0.031]), xf(box(0.008, 0.006, 0.03), [0.092, 0.152, -0.031]));
  hat(r, head, kit, helmet);
  return { hips, spine, head, uaR, uaL, faR, faL };
}

function hat(r: Rig, head: THREE.Bone, kit: Kit, kind: HelmetKind) {
  const band = (sx: number, sz: number, y: number, tilt: number, h = 0.045) => r.add(head, 'team', xf(cylY(1, 1, h, 12, true), [0.0, y, 0], [0, 0, tilt], [sx, 1, sz]));
  const top = (y: number) => r.add(head, 'team', xf(box(0.12, 0.014, 0.1), [-0.01, y, 0]));
  switch (kind) {
    case 'fast': {
      r.add(head, 'camo', xf(dome(1.5), [0.0, 0.14, 0], [0, 0, 0.2], [0.122, 0.122, 0.108]));
      r.add(head, 'dark', xf(rbox(0.03, 0.05, 0.045, 0.008), [0.118, 0.2, 0], [0, 0, 0.3]), xf(box(0.09, 0.014, 0.012), [0.0, 0.16, 0.106]), xf(box(0.09, 0.014, 0.012), [0.0, 0.16, -0.106]));
      r.add(head, 'gear', xf(rbox(0.035, 0.055, 0.08, 0.012), [-0.117, 0.16, 0]));
      if (kit.earpro) r.add(head, 'dark', xf(sph(0.03, 0.04, 0.022, 6, 4), [-0.005, 0.115, 0.092]), xf(sph(0.03, 0.04, 0.022, 6, 4), [-0.005, 0.115, -0.092]));
      band(0.124, 0.11, 0.17, 0.2);
      top(0.258);
      break;
    }
    case 'mitz': {
      r.add(head, 'camo', xf(dome(1.62), [0.0, 0.13, 0], [0, 0, 0.1], [0.123, 0.126, 0.11]));
      r.add(head, 'camo', jitter(xf(dome(1.9, 12, 6), [0, 0, 0], [0, 0, 0], [0.142, 0.135, 0.132]), 0.12, 7).translate(0.0, 0.135, 0));
      r.add(head, 'camo', xf(new THREE.ConeGeometry(0.035, 0.07, 5), [-0.04, 0.265, 0.03], [0.3, 0, 0.5]), xf(new THREE.ConeGeometry(0.03, 0.06, 5), [0.02, 0.27, -0.05], [-0.4, 0, -0.2]));
      band(0.141, 0.129, 0.16, 0.05, 0.03);
      top(0.26);
      break;
    }
    case 'm92':
    case 'qgf': {
      r.add(head, 'camo', xf(dome(1.66), [0.0, 0.13, 0], [0, 0, 0.1], [0.125, 0.128, 0.112]));
      r.add(head, 'camo', xf(cylY(0.128, 0.142, 0.025, 14, true), [0.0, 0.11, 0], [0, 0, 0.1], [1, 1, 0.9]));
      if (kind === 'qgf') r.add(head, 'dark', xf(box(0.02, 0.018, 0.17), [0.115, 0.17, 0]));
      if (kit.earpro) r.add(head, 'dark', xf(sph(0.03, 0.04, 0.022, 6, 4), [-0.005, 0.105, 0.094]), xf(sph(0.03, 0.04, 0.022, 6, 4), [-0.005, 0.105, -0.094]));
      band(0.127, 0.114, 0.175, 0.1);
      top(0.255);
      break;
    }
    case '6b47': {
      r.add(head, 'camo', xf(dome(1.72), [0.0, 0.13, 0], [0, 0, 0.12], [0.128, 0.13, 0.116]));
      r.add(head, 'dark', xf(rbox(0.04, 0.035, 0.1, 0.012), [0.11, 0.21, 0], [0, 0, 0.25])); // goggles on the brow
      r.add(head, 'gear', xf(rbox(0.035, 0.05, 0.08, 0.012), [-0.122, 0.15, 0]));
      if (kit.earpro) r.add(head, 'dark', xf(sph(0.03, 0.04, 0.022, 6, 4), [-0.005, 0.1, 0.1]), xf(sph(0.03, 0.04, 0.022, 6, 4), [-0.005, 0.1, -0.1]));
      band(0.13, 0.118, 0.17, 0.12);
      top(0.26);
      break;
    }
    case 'boonie': {
      r.add(head, 'camo', xf(lathe([[0.104, 0.155], [0.104, 0.2], [0.095, 0.245], [0.05, 0.255], [0.0, 0.257]], 12), [0.005, 0, 0], [0, 0, 0], [1.08, 1, 0.96]));
      r.add(head, 'camo', xf(cylY(0.17, 0.185, 0.012, 14), [0.005, 0.148, 0], [0, 0, 0.06], [1.05, 1, 0.95]));
      band(0.113, 0.1, 0.175, 0, 0.035);
      top(0.258);
      break;
    }
    case 'hardhat': {
      r.add(head, 'hat', xf(dome(1.5, 14, 6), [0.0, 0.14, 0], [0, 0, 0.1], [0.125, 0.125, 0.112]));
      r.add(head, 'hat', xf(cylY(0.13, 0.145, 0.018, 14), [0.01, 0.15, 0], [0, 0, 0.1], [1.12, 1, 0.94]));
      r.add(head, 'hat', xf(box(0.16, 0.022, 0.025), [0.0, 0.258, 0], [0, 0, 0.1]));
      band(0.127, 0.114, 0.185, 0.1, 0.03);
      break;
    }
  }
}

function vest(r: Rig, spine: THREE.Bone, kit: Kit) {
  const g = (...gs: G[]) => r.add(spine, 'gear', ...gs);
  if (kit.vest === 'rig') {
    // chest rig: harness + row of mag pouches over the belly
    g(xf(cylY(1, 1, 0.12, 14, true), [0, 0.17, 0], [0, 0, 0], [0.128, 1, 0.172]));
    for (const z of [-0.09, -0.03, 0.03, 0.09]) g(xf(rbox(0.05, 0.11, 0.055, 0.01), [0.135, 0.17, z]));
    for (const sd of [1, -1]) g(xf(box(0.2, 0.02, 0.04), [0, 0.43, sd * 0.1]), xf(box(0.025, 0.24, 0.04), [-0.12, 0.31, sd * 0.07], [sd * 0.35, 0, 0]));
    r.add(spine, 'team', xf(box(0.014, 0.09, 0.18), [0.13, 0.33, 0], [0, 0, -0.15]));
    return;
  }
  const big = kit.vest === 'bulky';
  const t = big ? 0.065 : 0.05;
  const w = big ? 0.32 : 0.28;
  g(xf(cylY(1, 1, big ? 0.24 : 0.18, 14, true), [0, big ? 0.17 : 0.19, 0], [0, 0, 0], [big ? 0.145 : 0.135, 1, big ? 0.192 : 0.186]));
  g(xf(rbox(t, big ? 0.34 : 0.3, w, 0.02, 2), [0.118, 0.26, 0], [0, 0, -0.06]));
  g(xf(box(t, big ? 0.34 : 0.3, w), [-0.122, 0.27, 0], [0, 0, 0.04]));
  for (const sd of [1, -1]) g(xf(box(0.25, 0.024, 0.06), [0, 0.425, sd * 0.105]));
  // mag pouches + admin
  for (const z of [-0.08, 0, 0.08]) g(xf(rbox(0.05, 0.1, 0.07, 0.012), [0.163, 0.155, z]));
  if (big) {
    // 6B45-style collar and groin protector
    g(xf(new THREE.TorusGeometry(0.105, 0.03, 5, 12, PI * 1.35), [-0.01, 0.44, 0], [PI / 2, 0, PI * 0.82], [0.95, 1.1, 1]));
    g(xf(rbox(0.04, 0.13, 0.17, 0.02), [0.13, -0.06, 0], [0, 0, 0.1]));
  }
  // radio + antenna (left side)
  r.add(spine, 'dark', xf(rbox(0.06, 0.12, 0.045, 0.01), [-0.04, 0.27, -0.2]), xf(cylY(0.0035, 0.006, 0.42, 4), [-0.06, 0.53, -0.2], [0.1, 0, 0.05]));
  // team ID patch on the chest
  r.add(spine, 'team', xf(box(0.014, 0.115, 0.23), [0.15, 0.33, 0], [0, 0, -0.06]));
}

function backpack(r: Rig, spine: THREE.Bone, kit: Kit, pack: PackKind, p: string) {
  const g = (...gs: G[]) => r.add(spine, 'gear', ...gs);
  const teamBack = (x: number, y: number) => r.add(spine, 'team', xf(box(0.014, 0.12, 0.23), [x, y, 0]), xf(box(0.08, 0.014, 0.2), [x + 0.04, y + 0.115, 0]));
  switch (pack) {
    case 'assault':
    case 'rpg': {
      g(xf(rbox(0.15, 0.32, 0.27, 0.045, 2), [-0.215, 0.25, 0]), xf(box(0.05, 0.14, 0.2), [-0.3, 0.2, 0]));
      teamBack(-0.296, 0.355);
      if (pack === 'rpg') {
        for (const z of [-0.065, 0.065]) {
          r.add(spine, 'tube', xf(cylY(0.042, 0.042, 0.13, 8), [-0.2, 0.47, z]), xf(cylY(0.006, 0.042, 0.13, 8), [-0.2, 0.6, z]));
        }
      }
      break;
    }
    case 'tool': {
      g(xf(rbox(0.13, 0.28, 0.25, 0.04, 2), [-0.21, 0.26, 0]));
      teamBack(-0.28, 0.33);
      // slung carbine across the back
      const { parts } = rifleGeo(kit.rifle, true);
      for (const [mk, geo] of parts) r.add(spine, mk, xf(geo, [-0.3, 0.25, 0], [PI / 2, 0, 0.75]));
      break;
    }
    case 'radio': {
      g(xf(rbox(0.13, 0.28, 0.25, 0.04, 2), [-0.21, 0.26, 0]));
      r.add(spine, 'dark', xf(rbox(0.06, 0.16, 0.12, 0.01), [-0.29, 0.3, -0.04]), xf(cylY(0.004, 0.007, 0.6, 4), [-0.28, 0.66, -0.08], [0.12, 0, 0.1]));
      teamBack(-0.275, 0.24);
      break;
    }
    case 'bombbag': {
      g(xf(rbox(0.16, 0.3, 0.28, 0.04, 2), [-0.22, 0.24, 0]));
      for (const z of [-0.08, 0, 0.08]) r.add(spine, 'tube', xf(cylY(0.03, 0.03, 0.12, 6), [-0.22, 0.43, z]), xf(cylY(0.012, 0.03, 0.04, 6), [-0.22, 0.51, z]));
      teamBack(-0.303, 0.3);
      break;
    }
    case 'jammer': {
      // big backpack jammer: frame + RF box with fins
      g(xf(rbox(0.07, 0.42, 0.28, 0.02), [-0.17, 0.27, 0]));
      r.add(spine, 'dark', xf(rbox(0.17, 0.4, 0.3, 0.025, 2), [-0.29, 0.27, 0]));
      for (const y of [0.13, 0.19, 0.25, 0.31, 0.37]) r.add(spine, 'gun', xf(box(0.02, 0.012, 0.26), [-0.385, y, 0]));
      r.add(spine, 'gun', xf(rbox(0.13, 0.06, 0.26, 0.012), [-0.29, 0.5, 0]));
      teamBack(-0.385, 0.44);
      // antenna cluster on its own bone so it can sway
      const ant = r.bone(p + 'ant', spine, -0.29, 0.53, 0);
      const tips: V3[] = [
        [0.03, 0.62, 0.11],
        [-0.04, 0.68, 0.04],
        [-0.03, 0.6, -0.1],
        [0.06, 0.5, -0.04],
      ];
      for (const [i, t] of tips.entries()) {
        r.add(ant, 'dark', strut([t[0] * 0.05, 0.0, t[2] * 0.6], t, i === 3 ? 0.008 : 0.005, 4));
        r.add(ant, 'dark', xf(cylY(0.014, 0.014, 0.04, 6), [t[0] * 0.05, 0.02, t[2] * 0.6]));
      }
      r.add(ant, 'glow', xf(sph(0.03, 0.03, 0.03, 6, 4), [0.06, 0.0, 0.1]), xf(sph(0.022, 0.022, 0.022, 6, 4), [0.06, 0.0, -0.1]), xf(box(0.008, 0.05, 0.2), [0.116, -0.05, 0]));
      for (const [i, t] of tips.entries()) r.point(p + 'tip' + i, ant, t);
      break;
    }
    case 'drone': {
      g(xf(rbox(0.13, 0.3, 0.26, 0.04, 2), [-0.21, 0.25, 0]));
      teamBack(-0.28, 0.4);
      // quadcopter strapped flat against the pack (own bone: hidden after launch)
      const dr = r.bone(p + 'drone', spine, -0.32, 0.27, 0);
      r.add(dr, 'dark', xf(rbox(0.05, 0.1, 0.09, 0.015), [0, 0, 0]));
      for (const a of [PI / 4, -PI / 4]) r.add(dr, 'dark', xf(box(0.018, 0.32, 0.025), [-0.005, 0, 0], [a, 0, 0]));
      for (const [y, z] of [
        [0.14, 0.14],
        [0.14, -0.14],
        [-0.14, 0.14],
        [-0.14, -0.14],
      ] as const) {
        r.add(dr, 'gun', xf(cylX(0.02, 0.02, 0.04, 6), [-0.03, y * 0.8, z * 0.8]));
        r.add(dr, 'dark', xf(cylX(0.06, 0.06, 0.004, 10), [-0.055, y * 0.8, z * 0.8]));
      }
      r.add(dr, 'tube', xf(cylY(0.03, 0.03, 0.13, 8), [-0.03, -0.1, 0]), xf(cylY(0.006, 0.03, 0.06, 8), [-0.03, -0.195, 0], [PI, 0, 0]));
      r.add(dr, 'team', xf(box(0.01, 0.05, 0.06), [-0.03, 0.04, 0]));
      r.point(p + 'muzzle0', dr, [-0.05, 0.05, 0]);
      break;
    }
  }
}

// ------------------------------------------------------------ templates

interface Tpl {
  top: THREE.Group;
  skel: THREE.Skeleton;
  sphere: THREE.Sphere;
  sols: SolDef[];
  muzzles: string[];
  glowMat: THREE.Material | null;
  emitters: { pos: THREE.Vector3; kind: 'spark' }[];
  height: number;
  size: { x: number; y: number; z: number };
  key: string;
  tris: number;
}

/** Adds the weapon bone + geometry for a soldier; returns weapon info and muzzle name. */
function arm(r: Rig, b: Body, p: string, kind: 'rifle' | 'carbine' | AtKind | 'controller', kit: Kit, muzzles: string[]): WInfo {
  const wpn = r.bone(p + 'wpn', b.spine, 0.3, 0.2, 0.12);
  if (kind === 'rifle' || kind === 'carbine') {
    const g = rifleGeo(kit.rifle, kind === 'carbine');
    for (const [mk, geo] of g.parts) r.add(wpn, mk, geo);
    r.point(p + 'muzzle0', wpn, g.muzzle);
    muzzles.push(p + 'muzzle0');
    return g.w;
  }
  if (kind === 'controller') {
    r.add(wpn, 'gun', rbox(0.075, 0.035, 0.18, 0.014), xf(rbox(0.05, 0.05, 0.035, 0.012), [-0.02, -0.02, 0.085]), xf(rbox(0.05, 0.05, 0.035, 0.012), [-0.02, -0.02, -0.085]));
    r.add(wpn, 'dark', xf(cylY(0.005, 0.005, 0.03, 5), [0.0, 0.03, 0.045]), xf(cylY(0.005, 0.005, 0.03, 5), [0.0, 0.03, -0.045]), strut([0.03, 0.01, 0.07], [0.12, 0.16, 0.09], 0.004), strut([0.03, 0.01, -0.07], [0.12, 0.16, -0.09], 0.004));
    r.add(wpn, 'glow', xf(box(0.035, 0.006, 0.05), [0.01, 0.019, 0]));
    return { kind: 'controller', grip: new THREE.Vector3(-0.02, -0.02, 0.095), fore: new THREE.Vector3(-0.02, -0.02, -0.095), pivot: new THREE.Vector3(0, 0, 0), round: false };
  }
  const g = launcherGeo(kind);
  for (const [mk, geo] of g.parts) r.add(wpn, mk, geo);
  if (g.round.length) {
    const rd = r.bone(p + 'round', wpn, 0, 0, 0);
    for (const [mk, geo] of g.round) r.add(rd, mk, geo);
  }
  r.point(p + 'muzzle0', wpn, g.muzzle);
  muzzles.push(p + 'muzzle0');
  return g.w;
}

function buildSoldierTpl(r: Rig, kit: Kit, key: string, t: Tpl) {
  const p = 'a';
  const role: Role = key === 'at' ? 'at' : key === 'engineer' ? 'engineer' : key === 'fpvteam' ? 'fpv' : key === 'ewinf' ? 'ew' : 'rifle';
  const pack: PackKind = role === 'at' ? (kit.at === 'rpg7' || kit.at === 'rpg29' || kit.at === 'pf98' ? 'rpg' : 'assault') : role === 'engineer' ? 'tool' : role === 'fpv' ? 'drone' : role === 'ew' ? 'jammer' : 'assault';
  const helmet: HelmetKind = role === 'engineer' ? 'hardhat' : kit.helmet === 'boonie' && role !== 'rifle' ? 'm92' : kit.helmet;
  const b = body(r, kit, p, 0, 0, 0, helmet, pack);
  let w: WInfo | null = null;
  switch (role) {
    case 'rifle':
      w = arm(r, b, p, 'rifle', kit, t.muzzles);
      break;
    case 'ew':
      w = arm(r, b, p, 'carbine', kit, t.muzzles);
      t.height = 0.47;
      for (let i = 0; i < 4; i++) {
        const o = r.top.getObjectByName(p + 'tip' + i);
        if (o) {
          o.updateWorldMatrix(true, false);
          t.emitters.push({ pos: new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).multiplyScalar(S), kind: 'spark' });
        }
      }
      break;
    case 'at':
      w = arm(r, b, p, kit.at, kit, t.muzzles);
      break;
    case 'fpv': {
      w = arm(r, b, p, 'controller', kit, t.muzzles);
      t.muzzles.push(p + 'muzzle0'); // launch point on the drone
      // FPV goggles over the helmet brim
      r.add(b.head, 'dark', xf(rbox(0.06, 0.055, 0.15, 0.015), [0.1, 0.14, 0]), xf(cylY(0.108, 0.108, 0.025, 12, true), [0.0, 0.145, 0], [0, 0, 0.05], [1, 1, 0.86]));
      r.add(b.head, 'glow', xf(box(0.01, 0.012, 0.012), [0.132, 0.16, 0.045]));
      break;
    }
    case 'engineer': {
      // wrench in the right hand, tool bag in the left
      r.add(b.faR, 'gun', xf(box(0.022, 0.32, 0.012), [0.02, -0.33, 0], [0, 0, 0.15]), xf(rbox(0.06, 0.05, 0.016, 0.01), [0.045, -0.48, 0]));
      r.add(b.faL, 'gear', xf(rbox(0.22, 0.13, 0.12, 0.035, 2), [0.0, -0.42, 0]), xf(box(0.012, 0.09, 0.012), [0.06, -0.33, 0]), xf(box(0.012, 0.09, 0.012), [-0.06, -0.33, 0]));
      r.add(b.faL, 'team', xf(box(0.08, 0.04, 0.124), [0.0, -0.42, 0]));
      r.add(b.faL, 'dark', xf(box(0.03, 0.04, 0.02), [0.03, -0.35, 0.05]));
      // hi-vis/ID band on the vest back
      r.add(b.spine, 'hat', xf(cylY(1, 1, 0.035, 14, true), [0, 0.33, 0], [0, 0, 0], [0.165, 1, 0.2]));
      break;
    }
  }
  t.sols.push({ p, role, x: 0, z: 0, yaw: 0, w });
}

// mortar team layout (metres, team-local)
const M_BASE: V3 = [0.32, 0, 0]; // mortar bone (baseplate centre)
const M_ELEV = 1.08; // tube elevation (rad)
const M_TUBE0: V3 = [-0.12, 0.06, 0]; // tube breech, mortar local
const M_LEN = 1.0;
const G_HOME: V3 = [-0.06, -0.52, -0.6]; // gunner x, z, yaw
const L_HOME: V3 = [0.62, 0.64, PI / 2 + 0.1]; // loader x, z, yaw  (faces -Z, towards the tube)
const PACK_G: V3 = [0, -0.42, 0];
const PACK_L: V3 = [0, 0.42, 0];

function buildMortarTpl(r: Rig, kit: Kit, t: Tpl) {
  body(r, kit, 'g', G_HOME[0], G_HOME[1], G_HOME[2], kit.helmet === 'boonie' ? 'm92' : kit.helmet, 'radio');
  const l = body(r, kit, 'l', L_HOME[0], L_HOME[1], L_HOME[2], kit.helmet, 'bombbag');
  // mortar
  const mb = r.bone('mortar', null, M_BASE[0], M_BASE[1], M_BASE[2]);
  r.add(mb, 'gun', xf(cylY(0.25, 0.27, 0.04, 14), [M_TUBE0[0], 0.02, 0]), xf(cylY(0.07, 0.09, 0.05, 8), [M_TUBE0[0], 0.06, 0]));
  for (const a of [0, PI / 3, (2 * PI) / 3]) r.add(mb, 'gun', xf(box(0.48, 0.03, 0.02), [M_TUBE0[0], 0.05, 0], [0, a, 0]));
  const collar: V3 = [M_TUBE0[0] + Math.cos(M_ELEV) * 0.62, M_TUBE0[1] + Math.sin(M_ELEV) * 0.62, 0];
  // bipod, sight and spare rounds: own bone, folded away (hidden) on the march
  const bp = r.bone('mbipod', mb, 0, 0, 0);
  for (const sd of [1, -1]) r.add(bp, 'gun', strut([0.5, 0.0, sd * 0.27], [collar[0] + 0.02, collar[1] - 0.12, sd * 0.03], 0.016), xf(cylY(0.03, 0.03, 0.02, 6), [0.5, 0.01, sd * 0.27]));
  r.add(bp, 'gun', strut([0.36, 0.2, 0.2], [0.36, 0.2, -0.2], 0.01), strut([collar[0] + 0.02, collar[1] - 0.12, 0], [collar[0], collar[1], 0], 0.02));
  r.add(bp, 'gun', xf(rbox(0.1, 0.07, 0.05, 0.012), [collar[0] - 0.04, collar[1] + 0.02, -0.08]), xf(cylX(0.016, 0.016, 0.07, 6), [collar[0] - 0.07, collar[1] + 0.08, -0.08], [0, 0, 0.4]));
  for (const z of [0.2, 0.28]) r.add(bp, 'tube', xf(cylX(0.04, 0.04, 0.22, 8), [-0.32, 0.04, z], [0, 0.3, 0]), xf(cylX(0.012, 0.04, 0.09, 8), [-0.17, 0.04, z + 0.045], [0, 0.3, 0]));
  r.add(mb, 'team', xf(cylY(0.255, 0.255, 0.012, 14, true), [M_TUBE0[0], 0.04, 0]));
  const tube = r.bone('mtube', mb, M_TUBE0[0], M_TUBE0[1], M_TUBE0[2]);
  tube.rotation.z = M_ELEV;
  r.add(tube, 'tube', xf(cylX(0.05, 0.053, M_LEN, 10), [M_LEN / 2, 0, 0]), xf(cylX(0.053, 0.053, 0.05, 10), [M_LEN - 0.03, 0, 0]), xf(cylX(0.06, 0.06, 0.1, 10), [0.05, 0, 0]));
  r.add(tube, 'team', xf(cylX(0.05, 0.05, 0.05, 10, true), [M_LEN * 0.8, 0, 0]));
  r.point('muzzle0', tube, [M_LEN + 0.02, 0, 0]);
  t.muzzles.push('muzzle0');
  // loader's bomb (held in the hands)
  const bomb = r.bone('lbomb', l.spine, 0.3, 0.2, 0);
  r.add(bomb, 'tube', xf(cylX(0.04, 0.04, 0.16, 10), [0.02, 0, 0]), xf(cylX(0.012, 0.04, 0.09, 10), [0.145, 0, 0]), xf(cylX(0.04, 0.02, 0.07, 8), [-0.095, 0, 0]));
  r.add(bomb, 'dark', xf(cylX(0.012, 0.012, 0.1, 5), [-0.17, 0, 0]), xf(box(0.06, 0.07, 0.006), [-0.19, 0, 0]), xf(box(0.06, 0.006, 0.07), [-0.19, 0, 0]));
  const w: WInfo = { kind: 'bomb', grip: new THREE.Vector3(0.0, -0.01, 0.055), fore: new THREE.Vector3(0.0, -0.01, -0.055), pivot: new THREE.Vector3(0, 0, 0), round: false };
  t.sols.push({ p: 'g', role: 'gunner', x: G_HOME[0], z: G_HOME[1], yaw: G_HOME[2], w: null });
  t.sols.push({ p: 'l', role: 'loader', x: L_HOME[0], z: L_HOME[1], yaw: L_HOME[2], w });
  t.height = 0.3;
  t.size = { x: 0.3, y: 0.3, z: 0.4 };
  t.sphere = new THREE.Sphere(new THREE.Vector3(0.2, 0.6, 0), 2.8);
}

const tplCache = new Map<string, Tpl>();

function getTpl(key: string, style: ModelStyle, fog: FogOfWar | null): Tpl {
  const ck = `${key}|${style.faction}|${style.region}|${style.team}|${fogId(fog)}`;
  const hit = tplCache.get(ck);
  if (hit) return hit;
  const kit = kitFor(style);
  const r = new Rig();
  const t: Tpl = {
    top: r.top,
    skel: null as unknown as THREE.Skeleton,
    sphere: new THREE.Sphere(new THREE.Vector3(0, 0.8, 0), 2.2),
    sols: [],
    muzzles: [],
    glowMat: null,
    emitters: [],
    height: 0.36,
    size: { x: 0.12, y: 0.36, z: 0.12 },
    key,
    tris: 0,
  };
  if (key === 'mortar') buildMortarTpl(r, kit, t);
  else buildSoldierTpl(r, kit, key, t);
  const glowColor = key === 'ewinf' ? 0x5dff7a : 0x63d8ff;
  const mats = materials(kit, style, fog, glowColor);
  const pat = kit.camo.pattern;
  const { skel, tris } = r.finish(mats, t.sphere, { camo: pat === 'digital' ? 1.5 : pat === 'flecktarn' ? 1.9 : 2.3, gear: kit.gearTex === 'camo' ? (pat === 'digital' ? 1.8 : 2.2) : 3.5 });
  t.skel = skel;
  t.tris = tris;
  t.top.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh && m.material === mats.glow) t.glowMat = mats.glow;
  });
  tplCache.set(ck, t);
  return t;
}

// -------------------------------------------------------------- runtime

interface Sol {
  def: SolDef;
  hips: THREE.Bone;
  spine: THREE.Bone;
  head: THREE.Bone;
  uaR: THREE.Bone;
  uaL: THREE.Bone;
  faR: THREE.Bone;
  faL: THREE.Bone;
  thR: THREE.Bone;
  thL: THREE.Bone;
  shR: THREE.Bone;
  shL: THREE.Bone;
  ftR: THREE.Bone;
  ftL: THREE.Bone;
  wpn: THREE.Bone | null;
  round: THREE.Bone | null;
  extra: THREE.Bone | null; // antenna / drone
  seed: number;
  aimW: number;
  moveW: number;
  kneelW: number;
  /** Smoothed walk (0) -> run (1) blend. */
  runW: number;
  /** Smoothed firing recoil impulse (0..1) and hit flinch timer / side. */
  kickW: number;
  flinch: number;
  flinchDir: number;
  lastDmg: number;
  /** Pose at the moment of death (blended out over the first ~0.2 s of the fall). */
  snap: { q: THREE.Quaternion[]; hp: THREE.Vector3; wp: THREE.Vector3 | null } | null;
  hx: number; // current home (team-local) position / yaw
  hz: number;
  hyaw: number;
  /** Parachute pose weight (1 = hanging under the canopy). */
  paraW: number;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpE = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const shR = new THREE.Vector3(SHOULDER[0], SHOULDER[1], SHOULDER[2]);
const shL = new THREE.Vector3(SHOULDER[0], SHOULDER[1], -SHOULDER[2]);
const POLE_R = new THREE.Vector3(-0.35, -0.6, 1).normalize();
const POLE_L = new THREE.Vector3(-0.1, -1, -0.55).normalize();
const POLE_RC = new THREE.Vector3(-0.3, -1, 0.6).normalize();
const POLE_LC = new THREE.Vector3(-0.3, -1, -0.6).normalize();

/** Two-bone IK in the spine frame; hinge at the elbow (forearm rotation.z). */
function ik(ua: THREE.Bone, fa: THREE.Bone, S0: THREE.Vector3, T: THREE.Vector3, pole: THREE.Vector3) {
  const a = UA;
  const b = FA;
  const d = tmpA.subVectors(T, S0);
  let c = d.length();
  if (c < 1e-5) {
    d.set(0, -1, 0);
    c = 1e-5;
  } else d.divideScalar(c);
  c = clamp(c, Math.abs(a - b) + 0.02, (a + b) * 0.995);
  const cosA = clamp((a * a + c * c - b * b) / (2 * a * c), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  const pp = tmpB.copy(pole).addScaledVector(d, -pole.dot(d));
  if (pp.lengthSq() < 1e-6) pp.set(0, -1, 0).addScaledVector(d, -d.y);
  pp.normalize();
  // elbow
  const E = tmpC.copy(S0).addScaledVector(d, a * cosA).addScaledVector(pp, a * sinA);
  const u = tmpD.subVectors(E, S0).normalize(); // upper arm direction
  const Tc = tmpE.copy(S0).addScaledVector(d, c);
  const v = Tc.sub(E).normalize(); // forearm direction
  const y = _v.copy(u).negate();
  const z = _s.crossVectors(u, v);
  if (z.lengthSq() < 1e-8) z.crossVectors(u, pp);
  z.normalize();
  const x = tmpB.crossVectors(y, z).normalize();
  tmpM.makeBasis(x, y, z);
  ua.quaternion.setFromRotationMatrix(tmpM);
  fa.rotation.set(0, 0, Math.acos(clamp(u.dot(v), -1, 1)));
}

function freeArm(ua: THREE.Bone, fa: THREE.Bone, sd: number, swing: number, abduct: number, flex: number) {
  ua.rotation.set(-sd * abduct, 0, swing);
  fa.rotation.set(0, 0, flex);
}

/** Pose the weapon bone so its pivot sits at P (spine space) with the given yaw/pitch/roll. */
function placeWeapon(sol: Sol, w: WInfo, px: number, py: number, pz: number, pitch: number, yaw: number, roll: number, kick: number) {
  const wpn = sol.wpn!;
  _e.set(roll, yaw, pitch, 'YZX');
  wpn.quaternion.setFromEuler(_e);
  tmpA.copy(w.pivot).applyQuaternion(wpn.quaternion);
  wpn.position.set(px, py, pz).sub(tmpA);
  if (kick > 0) {
    tmpA.set(-0.04 * kick, 0, 0).applyQuaternion(wpn.quaternion);
    wpn.position.add(tmpA);
  }
}
function handTargets(sol: Sol, w: WInfo, R: THREE.Vector3, L: THREE.Vector3) {
  const wpn = sol.wpn!;
  R.copy(w.grip).applyQuaternion(wpn.quaternion).add(wpn.position);
  L.copy(w.fore).applyQuaternion(wpn.quaternion).add(wpn.position);
}

interface LegOut {
  hp: number;
  phase: number;
  runK: number;
}

/** Legs + hips: gait from s.dist, idle weight shift, kneel blend. Sets hips height so the lowest contact touches the ground. */
function legs(sol: Sol, s: AnimState, t: number): LegOut {
  const mw = sol.moveW;
  const kw = sol.kneelW;
  // walk <-> run blend follows the ground speed smoothly (no pops on speed changes)
  const runT = s.moving ? clamp((s.speed - 0.55) / 0.55, 0, 1) : 0;
  sol.runW = s.dt === 0 && s.time === 0 ? runT : approach(sol.runW, runT, clamp(s.dt, 0, 0.1), 5);
  const runK = sol.runW;
  const ph = (s.dist / 0.17) * PI;
  const A = mix(0.42, 0.62, runK) * mw;
  const kb = mix(0.06, 0.16, runK);
  const kf = mix(0.8, 1.45, runK);
  const shift = Math.sin(t * 0.45 + sol.seed * 6);
  const ang = [0, 0, 0, 0, 0, 0]; // thL shL ftL thR shR ftR (world-ish angles)
  for (let i = 0; i < 2; i++) {
    const p = ph + i * PI;
    const sw = Math.max(0, Math.cos(p));
    const thG = A * Math.sin(p) + 0.12 * runK * mw;
    const knG = -(kb + kf * Math.pow(sw, 1.3) + 0.35 * runK * Math.max(0, -Math.sin(p))) * mw;
    // idle: one relaxed knee
    const relax = (i === 0 ? Math.max(0, shift) : Math.max(0, -shift)) * (1 - mw);
    let th = thG + (i === 0 ? 0.04 : -0.02) * (1 - mw) + relax * 0.1;
    let kn = knG - relax * 0.18 - 0.03 * (1 - mw);
    let ft = -(th + kn) - 0.35 * sw * mw;
    if (kw > 0) {
      // kneeling on the right knee, left foot forward
      const kth = i === 0 ? 1.57 : 0.06;
      const kkn = i === 0 ? -1.62 : -1.62;
      const kft = i === 0 ? 0.05 : 0.0;
      th = mix(th, kth, kw);
      kn = mix(kn, kkn, kw);
      ft = mix(ft, kft, kw);
    }
    ang[i * 3] = th;
    ang[i * 3 + 1] = kn;
    ang[i * 3 + 2] = ft;
  }
  const hp = -0.2 * runK * mw;
  let hy = 0;
  for (let i = 0; i < 2; i++) {
    const a1 = ang[i * 3];
    const a2 = a1 + ang[i * 3 + 1];
    const knee = 0.04 + TH * Math.cos(a1);
    hy = Math.max(hy, knee + SH * Math.cos(a2) + 0.072, knee + 0.05);
  }
  sol.thL.rotation.set(0.05 * (1 - kw), 0, ang[0] - hp);
  sol.shL.rotation.set(0, 0, ang[1]);
  sol.ftL.rotation.set(0, 0, ang[2]);
  sol.thR.rotation.set(-0.05 * (1 - kw), 0, ang[3] - hp);
  sol.shR.rotation.set(0, 0, ang[4]);
  sol.ftR.rotation.set(0, 0, ang[5]);
  const sway = 0.018 * shift * (1 - mw) * (1 - kw);
  const c = Math.cos(sol.hyaw);
  const sn = Math.sin(sol.hyaw);
  // weight shift is lateral (soldier's +Z)
  sol.hips.position.set(sol.hx + sn * sway, hy + 0.01 * runK * mw * Math.abs(Math.sin(ph)), sol.hz + c * sway);
  sol.hips.rotation.set(-0.03 * shift * (1 - mw) * (1 - kw), sol.hyaw + 0.09 * Math.sin(ph) * mw, hp);
  return { hp, phase: ph, runK };
}

function solBones(sol: Sol): THREE.Object3D[] {
  const b: THREE.Object3D[] = [sol.hips, sol.spine, sol.head, sol.uaR, sol.uaL, sol.faR, sol.faL, sol.thR, sol.thL, sol.shR, sol.shL, sol.ftR, sol.ftL];
  if (sol.wpn) b.push(sol.wpn);
  return b;
}

/**
 * Death animation: three deterministic variations per soldier (thrown back,
 * pitched forward, knees buckle and topple sideways), blended in from the
 * pose the soldier was in when hit.
 */
function deathPose(sol: Sol, d: number) {
  if (!sol.snap) {
    const bones = solBones(sol);
    sol.snap = { q: bones.map((o) => o.quaternion.clone()), hp: sol.hips.position.clone(), wp: sol.wpn ? sol.wpn.position.clone() : null };
  }
  if (sol.seed >= 0.7) crumplePose(sol, d);
  else fallPose(sol, d);
  const b = sstep(0, 0.22, d);
  if (b < 1) {
    const bones = solBones(sol);
    const sn = sol.snap;
    for (let i = 0; i < bones.length && i < sn.q.length; i++) bones[i].quaternion.slerpQuaternions(sn.q[i], tmpQ2.copy(bones[i].quaternion), b);
    sol.hips.position.lerpVectors(sn.hp, tmpE.copy(sol.hips.position), b);
    if (sol.wpn && sn.wp) sol.wpn.position.lerpVectors(sn.wp, tmpE.copy(sol.wpn.position), b);
  }
}

/** Knees buckle, the soldier slumps onto them, then topples onto his side. */
function crumplePose(sol: Sol, d: number) {
  const side = sol.seed > 0.85 ? 1 : -1;
  const k1 = sstep(0, 0.42, d); // buckle to the knees
  const k2 = sstep(0.38, 0.95, d); // topple
  const settle = d > 0.95 ? Math.sin(clamp((d - 0.95) / 0.22, 0, 1) * PI) * 0.05 : 0;
  // legs: kneel, then curl up on the ground
  const th = mix(1.45 * k1, 1.05, k2);
  const kn = mix(-2.1 * k1, -1.5, k2);
  sol.thL.rotation.set(0.06, 0, th * 0.92);
  sol.thR.rotation.set(-0.06, 0, th);
  sol.shL.rotation.set(0, 0, kn);
  sol.shR.rotation.set(0, 0, kn * 1.03);
  sol.ftL.rotation.set(0, 0, mix(0.3 * k1, 0.45, k2));
  sol.ftR.rotation.set(0, 0, mix(0.3 * k1, 0.5, k2));
  const hy = mix(mix(0.95, 0.5, k1), 0.2, k2) + settle * 0.2;
  const off = 0.24 * k2 * side;
  const back = -0.12 * k1;
  const c = Math.cos(sol.hyaw);
  const sn = Math.sin(sol.hyaw);
  sol.hips.position.set(sol.hx + sn * off + c * back, hy, sol.hz + c * off - sn * back);
  // body slumps forward over the knees, then rolls onto its side
  sol.hips.rotation.set(side * (PI / 2) * 0.92 * k2 + settle * side, sol.hyaw + 0.15 * k2 * side, -0.35 * k1 * (1 - k2) - 0.2 * k2);
  sol.spine.rotation.set(0.08 * k2 * side, 0.1 * k2, -0.45 * k1 + 0.15 * k2);
  sol.spine.scale.set(1, 1, 1);
  sol.head.rotation.set(0.35 * k2 * side, 0.2 * k2, -0.5 * k1 + 0.25 * k2);
  // arms hang limp, then sprawl
  freeArm(sol.uaR, sol.faR, 1, mix(0.25 * k1, 0.9, k2), mix(0.12, 0.3, k2), mix(0.2 + 0.3 * k1, 0.9, k2));
  freeArm(sol.uaL, sol.faL, -1, mix(0.3 * k1, 0.6, k2), mix(0.12, 0.45 + 0.4 * k2, k2), mix(0.2 + 0.2 * k1, 0.5, k2));
  dropWeapon(sol, d, side > 0);
}

function fallPose(sol: Sol, d: number) {
  const back = sol.seed < 0.36;
  const dir = back ? 1 : -1;
  const k1 = sstep(0, 0.28, d);
  const kf = clamp((d - 0.12) / 0.55, 0, 1);
  const k2 = kf * kf * (3 - 2 * kf) * 0.35 + kf * kf * 0.65;
  const settle = d > 0.67 ? Math.sin(clamp((d - 0.67) / 0.25, 0, 1) * PI) * 0.06 : 0;
  // legs: buckle, then relax on the ground
  const thA = mix(0.95 * k1, back ? 0.15 : -0.1, k2);
  const knA = mix(-1.6 * k1, back ? -0.35 : -0.25, k2);
  sol.thL.rotation.set(0.08, 0, thA);
  sol.thR.rotation.set(-0.12, 0, thA * (back ? 0.6 : 1.2));
  sol.shL.rotation.set(0, 0, knA);
  sol.shR.rotation.set(0, 0, knA * 0.5);
  sol.ftL.rotation.set(0, 0, 0.5 * k2);
  sol.ftR.rotation.set(0, 0, 0.6 * k2);
  const hy = mix(mix(0.95, 0.6, k1), back ? 0.15 : 0.17, k2) + settle * 0.3;
  const off = mix(0, back ? -0.3 : 0.28, k2);
  const c = Math.cos(sol.hyaw);
  const sn = Math.sin(sol.hyaw);
  sol.hips.position.set(sol.hx + c * off, hy, sol.hz - sn * off);
  sol.hips.rotation.set(0.15 * k2 * (sol.seed - 0.5), sol.hyaw + 0.3 * k2 * (sol.seed - 0.5), (-0.25 * k1 * (1 - k2) + dir * (PI / 2) * k2) * 1 + settle * dir);
  sol.spine.rotation.set(0.1 * k2, 0.2 * (sol.seed - 0.5) * k2, -0.2 * k1 * (1 - k2) + (back ? 0.12 : -0.05) * k2);
  sol.spine.scale.set(1, 1, 1);
  sol.head.rotation.set(0, (sol.seed - 0.5) * 1.4 * k2, (back ? 0.3 : 0.1) * k2 - 0.3 * k1 * (1 - k2));
  // arms flail
  const flail = Math.sin(d * 9) * (1 - k2) * k1 * 0.3;
  freeArm(sol.uaR, sol.faR, 1, mix(0.45 * k1 + flail, back ? 0.15 : -0.1, k2), mix(0.15 + 0.4 * k1, back ? 1.25 : 0.9, k2), mix(0.3 + 0.6 * k1, back ? 0.5 : 0.25, k2));
  freeArm(sol.uaL, sol.faL, -1, mix(0.6 * k1 - flail, back ? 0.3 : 0.05, k2), mix(0.15 + 0.3 * k1, back ? 0.55 : 0.35, k2), mix(0.3 + 0.7 * k1, back ? 0.9 : 0.2, k2));
  dropWeapon(sol, d, back);
}

/** The weapon leaves the hands and lies beside the body. */
function dropWeapon(sol: Sol, d: number, back: boolean) {
  if (sol.wpn && sol.def.w && sol.def.w.kind !== 'bomb') {
    const w = sol.def.w;
    const kw = sstep(0.05, 0.6, d);
    if (w.kind === 'rifle') placeWeapon(sol, w, 0.1, 0.3, 0.17, -0.6, 0.5, 0.25, 0);
    else if (w.kind === 'launcher') placeWeapon(sol, w, 0.02, 0.43, 0.17, 0.5, 0.05, 0, 0);
    else placeWeapon(sol, w, 0.3, 0.18, 0, -0.5, 0, 0, 0);
    if (back) tmpM.makeBasis(tmpA.set(0, 1, 0), tmpB.set(0, 0, 1), tmpC.set(1, 0, 0));
    else tmpM.makeBasis(tmpA.set(0, 1, 0), tmpB.set(0, 0, -1), tmpC.set(-1, 0, 0));
    tmpQ.setFromRotationMatrix(tmpM);
    sol.wpn.quaternion.slerp(tmpQ, kw);
    tmpD.set(back ? -0.11 : 0.12, 0.15, 0.46).sub(tmpA.copy(w.grip).applyQuaternion(tmpQ));
    sol.wpn.position.lerp(tmpD, kw);
  }
  if (sol.round) sol.round.scale.setScalar(1);
}

// ------------------------------------------------------------ instance

function bindInstance(t: Tpl): { top: THREE.Group; map: Map<string, THREE.Object3D>; skel: THREE.Skeleton } {
  const top = t.top.clone(true);
  const map = new Map<string, THREE.Object3D>();
  top.traverse((o) => {
    if (o.name) map.set(o.name, o);
  });
  const bones = t.skel.bones.map((b) => map.get(b.name) as THREE.Bone);
  const skel = new THREE.Skeleton(bones, t.skel.boneInverses);
  top.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (m.isSkinnedMesh) {
      m.bind(skel, m.bindMatrix);
      m.boundingSphere = t.sphere.clone();
    }
  });
  return { top, map, skel };
}

let solSeq = 0;
/** Deterministic per-instance seed in [0, 1) (death variation, idle phase). */
function hashSeed(n: number): number {
  let x = (n * 0x9e3779b1 + 0x7f4a7c15) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function makeSol(def: SolDef, map: Map<string, THREE.Object3D>): Sol {
  const g = (n: string) => map.get(def.p + n) as THREE.Bone;
  // hips: yaw outermost, so rotation.x is a body-local sideways roll (crumple death)
  g('hips').rotation.order = 'YXZ';
  return {
    def,
    hips: g('hips'),
    spine: g('spine'),
    head: g('head'),
    uaR: g('uaR'),
    uaL: g('uaL'),
    faR: g('faR'),
    faL: g('faL'),
    thR: g('thR'),
    thL: g('thL'),
    shR: g('shR'),
    shL: g('shL'),
    ftR: g('ftR'),
    ftL: g('ftL'),
    wpn: (map.get(def.p + 'wpn') as THREE.Bone) ?? (map.get(def.p + 'bomb') as THREE.Bone) ?? null,
    round: (map.get(def.p + 'round') as THREE.Bone) ?? null,
    extra: (map.get(def.p + 'ant') as THREE.Bone) ?? (map.get(def.p + 'drone') as THREE.Bone) ?? null,
    seed: hashSeed(solSeq++),
    aimW: 0,
    moveW: 0,
    kneelW: 0,
    runW: 0,
    kickW: 0,
    flinch: 0,
    flinchDir: 1,
    lastDmg: 0,
    snap: null,
    hx: def.x,
    hz: def.z,
    hyaw: def.yaw,
    paraW: 0,
  };
}

const RT = new THREE.Vector3();
const LT = new THREE.Vector3();

/** One soldier (rifle / at / engineer / fpv / ew), blended into the parachute pose while under a canopy. */
function animSoldier(sol: Sol, s: AnimState) {
  animSoldierBase(sol, s);
  const dig = s.dead > 0 ? 0 : (s.dig ?? 0);
  if (dig > 0 && dig < DIG_T) digPose(sol, dig);
  const tgt = s.dead > 0 ? 0 : clamp(s.para ?? 0, 0, 1);
  const dt = Math.min(Math.max(s.dt, 0), 0.1);
  sol.paraW = dt === 0 && s.time === 0 ? tgt : approach(sol.paraW, tgt, dt, tgt > sol.paraW ? 20 : 5);
  if (sol.paraW > 0.002) paraPose(sol, sol.paraW, s.time + sol.seed * 40);
}

/** Length of the digging-in motion (AnimState.dig seconds); afterwards the soldier kneels in his foxhole. */
const DIG_T = 2.6;
const _dq = [new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion(), new THREE.Quaternion()];
const _dwp = new THREE.Vector3();
const _dwq = new THREE.Quaternion();
const POLE_DIG = new THREE.Vector3(-0.2, -1, 0).normalize();

/**
 * Digging in (kneeling, from the normal kneel pose): rifle slung across the back,
 * both hands on an entrenching tool chopping at the ground in front of the knees,
 * leaning into each stroke. Blended in and out over the first / last ~0.4 s.
 */
function digPose(sol: Sol, dig: number) {
  const k = sstep(0, 0.4, dig) * (1 - sstep(DIG_T - 0.45, DIG_T, dig));
  if (k <= 0.001) return;
  // stroke: quick chop down, slower lift (about 1.7 strokes per second)
  const ph = (dig * 1.7) % 1;
  const c = ph < 0.35 ? sstep(0, 0.35, ph) : 1 - sstep(0.35, 1, ph);
  sol.spine.rotation.z += (-0.32 - 0.22 * c) * k;
  sol.head.rotation.z += 0.12 * k;
  _dq[0].copy(sol.uaR.quaternion);
  _dq[1].copy(sol.faR.quaternion);
  _dq[2].copy(sol.uaL.quaternion);
  _dq[3].copy(sol.faL.quaternion);
  const w = sol.def.w;
  if (w && sol.wpn) {
    _dwp.copy(sol.wpn.position);
    _dwq.copy(sol.wpn.quaternion);
    placeWeapon(sol, w, -0.17, 0.2, 0.0, 0.75, PI / 2, 0.15, 0);
    sol.wpn.position.lerp(_dwp, 1 - k);
    sol.wpn.quaternion.slerp(_dwq, 1 - k);
  }
  // hands (spine space): raised by the chest -> down at the ground in front
  RT.set(mix(0.3, 0.52, c), mix(0.12, -0.3, c), 0.07);
  LT.set(mix(0.22, 0.42, c), mix(0.26, -0.1, c), -0.03);
  ik(sol.uaR, sol.faR, shR, RT, POLE_DIG);
  ik(sol.uaL, sol.faL, shL, LT, POLE_LC);
  blendFrom(sol.uaR, _dq[0], k);
  blendFrom(sol.faR, _dq[1], k);
  blendFrom(sol.uaL, _dq[2], k);
  blendFrom(sol.faL, _dq[3], k);
}
/** bone = slerp(from, bone's current pose, k). */
function blendFrom(b: THREE.Object3D, from: THREE.Quaternion, k: number) {
  _pq.copy(b.quaternion);
  b.quaternion.copy(from).slerp(_pq, k);
}

const _pq = new THREE.Quaternion();
const _pe = new THREE.Euler();
function blendBone(b: THREE.Object3D, x: number, y: number, z: number, k: number) {
  _pq.setFromEuler(_pe.set(x, y, z, b.rotation.order));
  b.quaternion.slerp(_pq, k);
}
const _wp = new THREE.Vector3();
const _wq = new THREE.Quaternion();

/**
 * Under canopy: both hands up on the risers, legs together and dangling (a slow
 * kick as the jumper sways), weapon strapped muzzle-down across the chest,
 * head down watching the drop zone. Weighted so landing blends back to the
 * ground pose (knees soak up the touchdown).
 */
function paraPose(sol: Sol, k: number, t: number) {
  const kick = Math.sin(t * 2.1) * 0.1;
  blendBone(sol.thL, 0.02, 0, 0.2 + kick, k);
  blendBone(sol.thR, -0.02, 0, 0.1 - kick, k);
  blendBone(sol.shL, 0, 0, -0.34, k);
  blendBone(sol.shR, 0, 0, -0.46, k);
  blendBone(sol.ftL, 0, 0, -0.3, k);
  blendBone(sol.ftR, 0, 0, -0.24, k);
  blendBone(sol.uaR, -0.32, 0, 2.7, k);
  blendBone(sol.faR, 0, 0, 0.4, k);
  blendBone(sol.uaL, 0.32, 0, 2.7, k);
  blendBone(sol.faL, 0, 0, 0.4, k);
  blendBone(sol.spine, 0, 0, 0.08, k);
  blendBone(sol.head, 0, 0, -0.3, k);
  const w = sol.def.w;
  if (w && sol.wpn) {
    _wp.copy(sol.wpn.position);
    _wq.copy(sol.wpn.quaternion);
    placeWeapon(sol, w, 0.15, 0.22, 0.04, -1.3, 0.2, 0.25, 0);
    sol.wpn.position.lerp(_wp, 1 - k);
    sol.wpn.quaternion.slerp(_wq, 1 - k);
  }
}

function animSoldierBase(sol: Sol, s: AnimState) {
  const role = sol.def.role;
  const w = sol.def.w;
  const t = s.time + sol.seed * 40;
  const dt = Math.min(Math.max(s.dt, 0), 0.1);
  if (s.dead > 0) {
    deathPose(sol, s.dead);
    if (sol.extra && role === 'fpv') sol.extra.scale.setScalar(1);
    return;
  }
  sol.snap = null;
  const moving = s.moving && s.speed > 0.05;
  sol.moveW = approach(sol.moveW, moving ? 1 : 0, dt, 7);
  // hit flinch when the squad takes damage
  const dmg = s.damage || 0;
  if (dmg > sol.lastDmg + 0.005) {
    sol.flinch = 0.32;
    sol.flinchDir = Math.sin(s.time * 13.7 + sol.seed * 50) > 0 ? 1 : -1;
  }
  sol.lastDmg = dmg;
  sol.flinch = Math.max(0, sol.flinch - dt);
  const fl = sol.flinch > 0 ? Math.sin((1 - sol.flinch / 0.32) * PI) : 0;
  const holdAim = role === 'at' ? 3 : role === 'fpv' ? 5 : 1.4;
  const aimT = s.fired < holdAim ? 1 : 0;
  sol.aimW = approach(sol.aimW, aimT, dt, role === 'at' ? 7 : 12);
  sol.kneelW = approach(sol.kneelW, (role === 'fpv' && aimT && !moving) || ((s.dig ?? 0) > 0 && !moving) ? 1 : 0, dt, 5);
  if (dt === 0 && s.time === 0) {
    sol.moveW = moving ? 1 : 0;
    sol.aimW = aimT;
  }
  const L = legs(sol, s, t);
  const mw = sol.moveW;
  const aw = sol.aimW;
  // recoil: sharp kick on the shot, exponential recovery
  const f0 = s.fired;
  const kick = f0 >= 0 && f0 < 0.3 ? Math.exp(-f0 * (role === 'at' ? 11 : 24)) * Math.min(1, (f0 + 0.008) / 0.012) : 0;
  sol.kickW = kick;
  // spine: lean, twist, breathing
  const lean = -0.04 - 0.14 * mw * (0.3 + 0.7 * L.runK) - 0.07 * aw - 0.1 * sol.kneelW + 0.12 * fl;
  const twist = -0.09 * Math.sin(L.phase) * mw * (w ? 1 : 0.6) + 0.2 * fl * sol.flinchDir;
  const br = Math.sin(t * 1.7);
  sol.spine.rotation.set(0.02 * Math.sin(t * 0.45 + sol.seed * 6) * (1 - mw) + 0.1 * fl * sol.flinchDir, twist, lean + kick * 0.05 * (role === 'at' ? 2 : 1));
  sol.spine.scale.set(1 + 0.014 * br * (1 - mw), 1, 1 + 0.007 * br * (1 - mw));
  const tot = L.hp + lean;
  // head: keep the eyes level, idle glances
  const glance = Math.sin(t * 0.31) * Math.max(0, Math.sin(t * 0.13 + sol.seed * 9)) * 0.9;
  const rifleAim = aw * (w && w.kind === 'rifle' ? 1 : 0);
  sol.head.rotation.set(0.16 * rifleAim, glance * (1 - aw) * (1 - mw * 0.6) - twist, -tot * 0.85 - 0.12 * aw - 0.22 * rifleAim + 0.03 * Math.sin(t * 0.7) * (1 - mw));

  // arms
  if (!w || !sol.wpn) {
    // engineer: tools in both hands, natural swing
    const sw = Math.sin(L.phase) * mw;
    const amp = mix(0.35, 0.7, L.runK);
    freeArm(sol.uaR, sol.faR, 1, -amp * sw * 0.8 + 0.08, 0.12, mix(0.35, 1.2, L.runK * mw));
    freeArm(sol.uaL, sol.faL, -1, amp * sw * 0.6, 0.16, mix(0.15, 0.6, L.runK * mw));
    if (sol.extra) sol.extra.rotation.set(0, 0, 0);
    return;
  }
  const bob = Math.sin(L.phase * 2) * mw;
  // weapon sway: slow idle drift + breathing (much smaller while aiming), carried at port arms when running
  const still = 1 - mw;
  const swayP = (0.035 * Math.sin(t * 0.83 + sol.seed * 7) + 0.012 * br) * still * (1 - 0.8 * aw) + 0.006 * Math.sin(t * 2.3) * aw;
  const swayY = 0.04 * Math.sin(t * 0.57 + sol.seed * 3) * still * (1 - 0.85 * aw);
  const port = L.runK * mw * (1 - aw);
  if (w.kind === 'rifle') {
    // low ready <-> shouldered aim
    const px = mix(0.1, 0.12, aw) + 0.04 * port;
    const py = mix(0.29, 0.47, aw) + 0.012 * bob + 0.07 * port;
    const pz = mix(0.17, 0.12, aw) - 0.05 * port;
    const pitch = mix(-0.55 + 0.1 * mw, -tot - 0.01, aw) + kick * 0.14 + swayP + 0.8 * port;
    const yaw = mix(0.5, 0.06 - twist, aw) + swayY + 0.2 * port;
    const roll = mix(0.3, 0, aw);
    placeWeapon(sol, w, px, py, pz, pitch, yaw, roll, kick);
    handTargets(sol, w, RT, LT);
    ik(sol.uaR, sol.faR, shR, RT, POLE_R);
    ik(sol.uaL, sol.faL, shL, LT, POLE_L);
  } else if (w.kind === 'launcher') {
    const px = mix(0.02, 0.0, aw);
    const py = mix(0.43, 0.445, aw) + 0.01 * bob;
    const pz = mix(0.17, 0.155, aw);
    const pitch = mix(0.5 - 0.1 * mw, -tot + 0.04, aw) + kick * 0.18 + swayP * 0.6;
    const yaw = mix(0.06, 0.03 - twist, aw) + swayY * 0.5;
    placeWeapon(sol, w, px, py, pz, pitch, yaw, 0, kick * 1.5);
    handTargets(sol, w, RT, LT);
    // reload: warhead gone after the shot, left hand fetches a new one
    if (sol.round) {
      const f = s.fired;
      const gone = f > 0.04 && f < 1.6;
      sol.round.scale.setScalar(gone ? 1e-3 : 1);
      if (f > 0.25 && f < 1.75) {
        const k = sstep(0.25, 0.7, f) * (1 - sstep(1.3, 1.75, f));
        const toMuzzle = sstep(0.85, 1.25, f);
        tmpA.set(-0.15, 0.35, -0.22); // reach behind to the pack
        tmpB.set(0.72, 0.08, 0).applyQuaternion(sol.wpn.quaternion).add(sol.wpn.position); // in front of the tube
        tmpA.lerp(tmpB, toMuzzle);
        LT.lerp(tmpA, k);
      }
    }
    ik(sol.uaR, sol.faR, shR, RT, POLE_R);
    ik(sol.uaL, sol.faL, shL, LT, POLE_L);
  } else {
    // FPV controller: chest height, raised when flying a drone
    const px = mix(0.3, 0.33, aw);
    const py = mix(0.15, 0.27, aw) + 0.01 * bob;
    const pitch = mix(-0.55, -0.25, aw) - tot * aw;
    placeWeapon(sol, w, px, py, 0, pitch, -twist * 0.5, 0, 0);
    handTargets(sol, w, RT, LT);
    ik(sol.uaR, sol.faR, shR, RT, POLE_RC);
    ik(sol.uaL, sol.faL, shL, LT, POLE_LC);
    sol.head.rotation.z -= 0.12 * aw;
  }
  // extras
  if (sol.extra) {
    if (role === 'fpv') {
      const f = s.fired;
      const k = f < 0.05 ? 1 : f < 4 ? 1e-3 : Math.min(1, (f - 4) / 0.4 + 1e-3);
      sol.extra.scale.setScalar(k);
    } else {
      // antenna sway
      sol.extra.rotation.set(0.05 * Math.sin(L.phase) * mw + 0.02 * Math.sin(t * 2.1), 0, -0.08 * mw + 0.03 * Math.sin(L.phase * 2) * mw + kick * 0.03);
    }
  }
}

// ---------------------------------------------------------- mortar team

interface MortarState {
  g: Sol;
  l: Sol;
  mortar: THREE.Bone;
  tube: THREE.Bone;
  bipod: THREE.Bone;
  bomb: THREE.Bone;
  top: THREE.Group;
  packed: boolean;
}

/** Body-space point -> soldier spine space (uses local matrices; no world update needed). */
function bodyToSpine(sol: Sol, p: THREE.Vector3, out: THREE.Vector3) {
  sol.hips.updateMatrix();
  sol.spine.updateMatrix();
  tmpM2.multiplyMatrices(sol.hips.matrix, sol.spine.matrix).invert();
  return out.copy(p).applyMatrix4(tmpM2);
}
function bodyQuatToSpine(sol: Sol, q: THREE.Quaternion, out: THREE.Quaternion) {
  tmpQ2.copy(sol.hips.quaternion).multiply(sol.spine.quaternion).invert();
  return out.copy(tmpQ2).multiply(q);
}

const MOUTH = new THREE.Vector3(M_BASE[0] + M_TUBE0[0] + Math.cos(M_ELEV) * M_LEN, M_TUBE0[1] + Math.sin(M_ELEV) * M_LEN, 0);
const TUBE_DIR = new THREE.Vector3(Math.cos(M_ELEV), Math.sin(M_ELEV), 0);
const TUBE_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), M_ELEV);
const UP_Q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), PI / 2);
// gunner's hand holds on the mortar (body space)
const G_HOLD_L = new THREE.Vector3(M_BASE[0] + M_TUBE0[0] + Math.cos(M_ELEV) * 0.5, M_TUBE0[1] + Math.sin(M_ELEV) * 0.5, -0.06);
const G_HOLD_R = new THREE.Vector3(M_BASE[0] + 0.22, 0.47, -0.08);

function animMortar(m: MortarState, s: AnimState) {
  const { g, l } = m;
  const dt = Math.min(Math.max(s.dt, 0), 0.1);
  const moving = s.moving && s.speed > 0.05;
  for (const sol of [g, l]) sol.moveW = approach(sol.moveW, moving ? 1 : 0, dt, 6);
  if (dt === 0 && s.time === 0) g.moveW = l.moveW = moving ? 1 : 0;
  const mw = g.moveW;
  const packed = mw > 0.5;
  if (packed !== m.packed) {
    m.packed = packed;
    if (packed) {
      // tube slung diagonally on the gunner's back, baseplate on the loader's pack, bipod folded
      g.spine.add(m.tube);
      m.tube.position.set(-0.27, -0.08, -0.12);
      m.tube.rotation.set(0.4, 0, PI / 2 + 0.12);
      l.spine.add(m.mortar);
      m.mortar.position.set(-0.33, 0.4, 0);
      m.mortar.rotation.set(0, 0, PI / 2);
      m.bipod.scale.setScalar(1e-3);
    } else {
      m.top.add(m.mortar);
      m.mortar.position.set(M_BASE[0], M_BASE[1], M_BASE[2]);
      m.mortar.rotation.set(0, 0, 0);
      m.mortar.add(m.tube);
      m.tube.rotation.set(0, 0, M_ELEV);
      m.bipod.scale.setScalar(1);
    }
  }
  // positions: deployed around the mortar <-> walking side by side
  g.hx = mix(G_HOME[0], PACK_G[0], mw);
  g.hz = mix(G_HOME[1], PACK_G[1], mw);
  g.hyaw = mix(G_HOME[2], PACK_G[2], mw);
  l.hx = mix(L_HOME[0], PACK_L[0], mw);
  l.hz = mix(L_HOME[1], PACK_L[1], mw);
  l.hyaw = mix(L_HOME[2], PACK_L[2], mw);
  for (const sol of [g, l]) sol.kneelW = 1 - mw;
  const f = s.fired;
  const tubeKick = f < 0.12 ? (1 - f / 0.12) * 0.05 : 0;
  if (!packed) m.tube.position.set(M_TUBE0[0] - TUBE_DIR.x * tubeKick, M_TUBE0[1] - TUBE_DIR.y * tubeKick, 0);

  // ---- gunner
  if (!(s.dead > 0)) g.snap = l.snap = null;
  if (s.dead > 0) deathPose(g, s.dead + 0.05);
  else {
    const t = s.time + g.seed * 40;
    const L = legs(g, s, t);
    const flinch = f < 0.6 ? Math.sin((f / 0.6) * PI) : 0;
    const lean = mix(-0.32, -0.12 * (0.4 + 0.6 * L.runK), mw);
    g.spine.rotation.set(0.12 * flinch * (1 - mw), 0.25 * (1 - mw), lean + 0.12 * flinch * (1 - mw));
    g.spine.scale.set(1 + 0.012 * Math.sin(t * 1.7), 1, 1);
    g.head.rotation.set(0, mix(-0.3 + 0.5 * flinch, 0, mw), -(L.hp + lean) * 0.7 - 0.15 * (1 - mw));
    if (packed) {
      const sw = Math.sin(L.phase);
      freeArm(g.uaR, g.faR, 1, -0.5 * sw, 0.15, mix(0.3, 1.1, L.runK));
      freeArm(g.uaL, g.faL, -1, 0.5 * sw, 0.15, mix(0.3, 1.1, L.runK));
    } else {
      // hands on the tube and the elevation crank (crank turns while idle)
      const crank = Math.sin(t * 0.6) > 0.6 ? t * 5 : 0;
      tmpA.copy(G_HOLD_L);
      tmpB.copy(G_HOLD_R).add(_v.set(0, Math.sin(crank) * 0.03, Math.cos(crank) * 0.03));
      bodyToSpine(g, tmpA, LT);
      bodyToSpine(g, tmpB, RT);
      ik(g.uaR, g.faR, shR, RT, POLE_R);
      ik(g.uaL, g.faL, shL, LT, POLE_L);
    }
  }

  // ---- loader
  if (s.dead > 0) {
    deathPose(l, s.dead);
    m.bomb.scale.setScalar(1e-3);
    return;
  }
  const t = s.time + l.seed * 40;
  const L = legs(l, s, t);
  let lean = mix(-0.25, -0.12 * (0.4 + 0.6 * L.runK), mw);
  let twist = 0;
  // bomb pose (spine space) keyframes
  const chestP = tmpC.set(0.3, 0.2, 0);
  const chestQ = tmpQ.copy(UP_Q);
  let bombVisible = true;
  let pos = chestP.clone();
  let rot = chestQ.clone();
  let duck = 0;
  if (!packed) {
    // in action: hold ready over the muzzle, drop on fire, fetch the next round
    const ready = f < 10;
    // compute body-space targets in this frame's spine space (after setting spine)
    const readyLean = -0.35;
    if (f < 0.15) lean = readyLean;
    else if (f < 0.6) {
      duck = Math.sin(((f - 0.15) / 0.45) * PI);
      lean = mix(readyLean, -0.1, sstep(0.15, 0.4, f));
    } else if (f < 1.2) {
      lean = -0.45;
      twist = 0.7 * Math.sin(((f - 0.6) / 0.6) * PI);
    } else if (ready) lean = mix(-0.2, readyLean, sstep(1.2, 1.7, f));
    l.spine.rotation.set(-0.15 * duck, twist, lean);
    l.spine.scale.set(1 + 0.012 * Math.sin(t * 1.7), 1, 1);
    // ready / drop poses from the tube (body space -> spine)
    const readyP = bodyToSpine(l, tmpA.copy(MOUTH).addScaledVector(TUBE_DIR, 0.2), new THREE.Vector3());
    const tubeQ = bodyQuatToSpine(l, TUBE_Q, new THREE.Quaternion());
    const bagP = new THREE.Vector3(-0.12, 0.12, -0.3);
    if (!ready) {
      // idle: cradle the round at the chest
    } else if (f < 0.15) {
      const k = f / 0.15;
      pos = readyP.clone().addScaledVector(bodyToSpine(l, tmpB.copy(MOUTH), new THREE.Vector3()).sub(readyP), 1 + k * 1.2);
      rot = tubeQ.clone();
      bombVisible = k < 0.6;
    } else if (f < 0.6) {
      bombVisible = false;
      pos = readyP.clone().lerp(chestP, sstep(0.15, 0.6, f));
      rot = tubeQ.clone();
    } else if (f < 1.2) {
      const k = sstep(0.6, 0.9, f);
      pos = chestP.clone().lerp(bagP, k * (1 - sstep(0.95, 1.2, f)));
      bombVisible = f > 0.85;
      rot = chestQ.clone();
    } else {
      const k = sstep(1.2, 1.7, f);
      pos = chestP.clone().lerp(readyP, k);
      rot = chestQ.clone().slerp(tubeQ, k);
    }
  } else {
    l.spine.rotation.set(0, 0, lean);
    pos.y += 0.012 * Math.sin(L.phase * 2) * mw;
  }
  if (packed) l.spine.rotation.set(0, -0.09 * Math.sin(L.phase) * mw, lean);
  l.head.rotation.set(0, 0.4 * duck, -(L.hp + lean) * 0.6 - 0.2 * (1 - mw));
  m.bomb.position.copy(pos);
  m.bomb.quaternion.copy(rot);
  m.bomb.scale.setScalar(bombVisible ? 1 : 1e-3);
  // hands on the bomb
  RT.set(pos.x - 0.02, pos.y - 0.02, pos.z + 0.07);
  LT.set(pos.x - 0.02, pos.y - 0.02, pos.z - 0.07);
  ik(l.uaR, l.faR, shR, RT, POLE_RC);
  ik(l.uaL, l.faL, shL, LT, POLE_LC);
}

// --------------------------------------------------------------- builder

function fallback(style: ModelStyle): Model {
  const root = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CapsuleGeometry(0.05, 0.22, 2, 6), new THREE.MeshStandardMaterial({ color: style.team }));
  m.position.y = 0.16;
  root.add(m);
  return { root, muzzles: [], height: 0.34, glow: [], emitters: [], infantry: true };
}

function build(key: string): Builder {
  return (style, fog) => {
    try {
      const t = getTpl(key, style, fog);
      const inst = bindInstance(t);
      const root = new THREE.Group();
      root.name = 'infantry_' + key;
      inst.top.scale.setScalar(S);
      root.add(inst.top);
      root.addEventListener('removed', () => inst.skel.dispose());
      const muzzles = t.muzzles.map((n) => inst.map.get(n)).filter((o): o is THREE.Object3D => !!o);
      const sols = t.sols.map((d) => makeSol(d, inst.map));
      let anim: (s: AnimState) => void;
      if (key === 'mortar') {
        const ms: MortarState = {
          g: sols[0],
          l: sols[1],
          mortar: inst.map.get('mortar') as THREE.Bone,
          tube: inst.map.get('mtube') as THREE.Bone,
          bipod: inst.map.get('mbipod') as THREE.Bone,
          bomb: inst.map.get('lbomb') as THREE.Bone,
          top: inst.top,
          packed: false,
        };
        ms.l.wpn = ms.bomb;
        anim = (s) => animMortar(ms, s);
      } else {
        const sol = sols[0];
        anim = (s) => animSoldier(sol, s);
      }
      const model: Model = {
        root,
        muzzles,
        height: t.height,
        size: t.size,
        glow: t.glowMat ? [t.glowMat] : [],
        emitters: t.emitters.map((e) => ({ pos: e.pos.clone(), kind: e.kind })),
        infantry: true,
        anim: (s) => {
          try {
            anim(s);
          } catch {
            /* never throw from animation */
          }
        },
      };
      // settle into the idle pose immediately
      model.anim!({ dt: 0, time: 0, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true });
      return model;
    } catch (e) {
      console.error('infantry builder failed', key, e);
      return fallback(style);
    }
  };
}

/** Model builders keyed by model key (see sim/defs.ts `model` fields). */
export const INFANTRY: Record<string, Builder> = {
  rifle: build('rifle'),
  at: build('at'),
  engineer: build('engineer'),
  mortar: build('mortar'),
  fpvteam: build('fpvteam'),
  ewinf: build('ewinf'),
};
