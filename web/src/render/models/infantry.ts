import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { FogOfWar } from '../fog';
import { onFogRelease, purgeKeys } from '../fogcache';
import { pbrMaterial, worldUV, type CamoPattern, type MatOpts } from '../textures';
import { registerLods } from '../perf/lod';
import type { Builder } from './registry';
import type { AnimState, Model, ModelStyle } from './types';
import { gearWebbing } from './infbake';
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
  (g.userData.lo as G | undefined)?.applyMatrix4(_m);
  return g;
}
/** Attach a cheaper stand-in used at geometry LOD1/2 (Rig.add splits the part). */
function withLo<T extends G>(hi: T, lo: G): T {
  hi.userData.lo = lo;
  return hi;
}
const sph = (rx: number, ry: number, rz: number, w = 8, h = 6) => {
  const g = new THREE.SphereGeometry(1, w, h);
  if (w >= 7) withLo(g, new THREE.SphereGeometry(1, Math.max(5, Math.ceil(w * 0.6)), Math.max(3, Math.ceil(h * 0.6))));
  return xf(g, undefined, undefined, [rx, ry, rz]);
};
const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
/** Rounded box; tiny ones degrade to plain boxes (invisible at game scale). */
const rbox = (w: number, h: number, d: number, r: number, seg = 1): G =>
  Math.max(w, h, d) < 0.16 ? new THREE.BoxGeometry(w, h, d) : withLo(new RoundedBoxGeometry(w, h, d, Math.min(seg, 1), Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4)), new THREE.BoxGeometry(w, h, d));
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

type MK = 'camo' | 'gear' | 'skin' | 'dark' | 'gun' | 'tube' | 'team' | 'glow' | 'hat' | 'hair';
const MK_ORDER: MK[] = ['camo', 'gear', 'skin', 'hair', 'dark', 'gun', 'tube', 'team', 'glow', 'hat'];
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
  /** Uniform tint (multiplies the camo texture). */
  camoTint?: number;
  beard?: boolean;
  shades?: boolean;
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
    shades: true,
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
    beard: true,
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
    beard: true,
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

/**
 * Infantry "hero fill": soldiers are small, dark and often back-lit from the RTS camera,
 * so their indirect (sky / hemisphere / IBL) light is lifted and the sun wraps a little
 * round onto the shaded side. Both scale with the scene's own lights, so night stays night. Chained after fog.apply / unitLook.
 */
const INF_FILL = 1.45;
/** Share of the sun wrapped round onto the shaded side. */
const INF_WRAP = 0.8;
function infLook<T extends THREE.Material>(m: T, fill = INF_FILL): T {
  const prev = m.onBeforeCompile;
  const key = `${m.customProgramCacheKey()}|inf${fill}`;
  m.onBeforeCompile = function (this: THREE.Material, shader, renderer) {
    prev.call(this, shader, renderer);
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_fragment_end>',
      `#include <lights_fragment_end>
      reflectedLight.indirectDiffuse *= ${fill.toFixed(3)};
      #if NUM_DIR_LIGHTS > 0
      {
        // wrapped sun: the side away from the sun keeps some of its light (soft terminator)
        vec3 infWrap = vec3( 0.0 );
        float infNl;
        #pragma unroll_loop_start
        for ( int i = 0; i < NUM_DIR_LIGHTS; i ++ ) {
          infNl = dot( normal, directionalLights[ i ].direction );
          infWrap += directionalLights[ i ].color * max( ( infNl + 0.6 ) / 1.6 - max( infNl, 0.0 ), 0.0 );
        }
        #pragma unroll_loop_end
        reflectedLight.directDiffuse += infWrap * ${INF_WRAP.toFixed(3)} * BRDF_Lambert( material.diffuseColor );
      }
      #endif`,
    );
  };
  m.customProgramCacheKey = () => key;
  return m;
}

/** Infantry materials read the baked vertex shading (Rig.add) and carry the unit rim light. */
function stdMat(key: string, fog: FogOfWar | null, p: THREE.MeshStandardMaterialParameters, rim = 0.5) {
  const k = `${fogId(fog)}:${key}`;
  let m = stdCache.get(k);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ ...p, vertexColors: true });
    if (fog) fog.apply(m);
    if (rim > 0) unitLook(m, { rim });
    infLook(m);
    stdCache.set(k, m);
  }
  return m;
}
/** Private copy of a shared procedural PBR material (textures shared) with vertex colours on. */
function pbrCopy(key: string, fog: FogOfWar | null, make: () => THREE.MeshStandardMaterial, rim = 0.55) {
  const k = `${fogId(fog)}:pbr:${key}`;
  let m = stdCache.get(k);
  if (!m) {
    const base = make();
    m = new THREE.MeshStandardMaterial({
      map: base.map,
      normalMap: base.normalMap,
      roughnessMap: base.roughnessMap,
      roughness: base.roughness,
      metalness: base.metalness,
      normalScale: base.normalScale.clone(),
      color: base.color.clone(),
      vertexColors: true,
    });
    if (fog) fog.apply(m);
    unitLook(m, { rim });
    infLook(m);
    stdCache.set(k, m);
  }
  return m;
}

/** Nylon load-bearing gear: MOLLE webbing on cordura (infbake.ts) in the kit colour. */
function gearMat(color: number, fog: FogOfWar | null) {
  const k = `${fogId(fog)}:gear:${color}`;
  let m = stdCache.get(k);
  if (!m) {
    const t = gearWebbing();
    m = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, color, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.8, 0.8), vertexColors: true });
    m.color.multiplyScalar(1.1);
    if (fog) fog.apply(m);
    unitLook(m, { rim: 0.6 });
    infLook(m);
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
    m = new THREE.MeshStandardMaterial({ map: t.map, normalMap: t.normalMap, roughnessMap: t.roughnessMap, color: tint, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.7, 0.7), vertexColors: true });
    // a little lighter than the cloth swatch: value contrast against grass and shade at RTS zoom
    m.color.multiplyScalar(1.14);
    if (fog) fog.apply(m);
    unitLook(m, { rim: 0.75 });
    infLook(m);
    stdCache.set(k, m);
  }
  return m;
}

function materials(kit: Kit, style: ModelStyle, fog: FogOfWar | null, glow: number): Record<MK, THREE.Material> {
  const fac = KITS[style.faction] ? style.faction : (REGION_FALLBACK[style.region] ?? 'usa');
  return {
    camo: uniformMat(fac, kit.camoTint ?? 0xffffff, fog),
    gear: kit.gearTex === 'camo' ? uniformMat(fac, 0xd6d6d6, fog) : gearMat(kit.gear.color ?? 0x8c7854, fog),
    dark: stdMat('dark', fog, { color: 0x2d2c29, roughness: 0.82, metalness: 0 }, 0.45),
    gun: pbrCopy(`gun:${kit.gun}`, fog, () => pbrMaterial('metalPanel', { color: kit.gun, size: 128, divisions: 1, grime: 0.15, metalness: 0.45, roughness: 0.7 }), 0.45),
    tube: pbrCopy(`tube:${kit.tube}`, fog, () => pbrMaterial('metalPanel', { color: kit.tube, size: 128, divisions: 1, grime: 0.35, metalness: 0.25, roughness: 1 })),
    skin: stdMat(`skin:${kit.skin}`, fog, { color: kit.skin, roughness: 0.68, metalness: 0 }, 0.35),
    team: stdMat(`team:${style.team}`, fog, { color: style.team, roughness: 0.45, metalness: 0.05, emissive: style.team, emissiveIntensity: 0.3 }, 0.8),
    glow: stdMat(`glow:${glow}`, fog, { color: 0x101010, emissive: glow, emissiveIntensity: 2.6, roughness: 0.4 }, 0),
    hat: stdMat('hat', fog, { color: 0xe2b322, roughness: 0.42, metalness: 0.05 }),
    hair: stdMat('hair', fog, { color: 0x2a1f17, roughness: 0.95, metalness: 0 }, 0.3),
  };
}

// ------------------------------------------------------------------- rig

/*
 * Geometry LOD masks (bit n = drawn at geometry LOD n, see perf/lod.ts):
 *   LOD0 hero (close zoom, portraits, photo mode), LOD1 battle zoom, LOD2 far / strategic.
 * Every part is tagged; parts tagged LOD1|LOD2 only are the low-poly stand-ins for
 * the hero versions. The LOD geometries are index subsets sharing one vertex buffer.
 */
const L0 = 1;
const L_ALL = 7;
const L_LO = 6;
const L_HI = 3;

/** Baked vertex shading: sky occlusion (dark undersides) and a vertical value ramp (light helmet / shoulders, darker legs and boots) that keeps the silhouette readable from the RTS camera. */
const GRADED: Partial<Record<MK, number>> = { camo: 1, gear: 1, dark: 1, skin: 0.6, tube: 0.4, gun: 0.25 };

/** Cylindrical UVs about the local Y axis (constant texel density on a ~9 cm radius limb). */
function cylUV(g: G, sc: number) {
  const pos = g.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = Math.atan2(pos.getZ(i), pos.getX(i)) * 0.095 * sc;
    uv[i * 2 + 1] = -pos.getY(i) * sc;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

class Rig {
  readonly top = new THREE.Group();
  readonly bones: THREE.Bone[] = [];
  private parts = new Map<MK, { g: G; mask: number }[]>();
  /** Geometry added to the key bone is modelled in the value's rest frame (the joint sits higher up the same chain). */
  readonly frames = new Map<THREE.Bone, THREE.Object3D>();
  /** Soft skinning: vertices of the key bone blend into `lo` below frame-local height y1 (fully `lo` under y0). */
  readonly soft = new Map<THREE.Bone, { lo: THREE.Bone; y0: number; y1: number }>();
  /** LOD mask applied to the parts being added. */
  mask = L_ALL;
  /** Albedo multiplier baked into the parts being added (pouch flaps, straps ...). */
  shade = 1;
  /** Texture repeats per metre by material (set before building; falls back to UVS). */
  uvs: Partial<Record<MK, number>> = {};
  /** Parts being added are round about their bone's Y axis (limbs, torso): cylindrical UVs, no box-projection seams. */
  cyl = false;
  /** Triangles per geometry LOD after finish(). */
  readonly lodTris = [0, 0, 0];

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
  /** Add parts with an explicit LOD mask (and optional shade). */
  addL(mask: number, b: THREE.Bone, mk: MK, ...geos: G[]): void {
    const m = this.mask;
    this.mask = mask;
    this.add(b, mk, ...geos);
    this.mask = m;
  }
  /** Add parts (modelled in the bone's local frame at its rest pose). */
  add(b: THREE.Bone, mk: MK, ...geos: G[]): void {
    // parts with a cheap stand-in: hero version at LOD0, the stand-in at LOD1/2
    if (this.mask & L_LO && geos.some((g) => g.userData.lo)) {
      const mask = this.mask;
      for (const g of geos) {
        const lo = g.userData.lo as G | undefined;
        if (!lo) {
          this.add(b, mk, g);
          continue;
        }
        delete g.userData.lo;
        if (mask & L0) this.addL(L0, b, mk, g);
        this.addL(mask & L_LO, b, mk, lo);
      }
      this.mask = mask;
      return;
    }
    for (const g of geos) delete g.userData.lo;
    const fr = this.frames.get(b) ?? b;
    fr.updateWorldMatrix(true, false);
    const idx = this.bones.indexOf(b);
    const sf = this.soft.get(b);
    const lo = sf ? this.bones.indexOf(sf.lo) : -1;
    let list = this.parts.get(mk);
    if (!list) this.parts.set(mk, (list = []));
    const gr = GRADED[mk] ?? 0;
    for (const g of geos) {
      for (const name of Object.keys(g.attributes)) if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
      if (!g.attributes.normal) g.computeVertexNormals();
      const n = g.attributes.position.count;
      const sc = this.uvs[mk] ?? UVS[mk];
      if (sc && this.cyl) cylUV(g, sc);
      if (!g.index) {
        const ix: number[] = [];
        for (let i = 0; i < n; i++) ix.push(i);
        g.setIndex(ix);
      }
      const si = new Uint16Array(n * 4);
      const sw = new Float32Array(n * 4);
      const pos = g.attributes.position;
      for (let i = 0; i < n; i++) {
        const k = sf ? sstep(sf.y0, sf.y1, pos.getY(i)) : 1;
        si[i * 4] = idx;
        sw[i * 4] = k;
        if (k < 1) {
          si[i * 4 + 1] = lo;
          sw[i * 4 + 1] = 1 - k;
        }
      }
      g.applyMatrix4(fr.matrixWorld);
      if (sc && !this.cyl) worldUV(g, sc);
      g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
      g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
      // baked shading (body space: soles at y = 0, helmet top ~1.85 m)
      const col = new Float32Array(n * 3);
      const nor = g.attributes.normal;
      for (let i = 0; i < n; i++) {
        const y = pos.getY(i);
        const ny = nor.getY(i);
        const ramp = 0.68 + 0.32 * sstep(0.02, 1.45, y) + 0.06 * sstep(1.6, 1.85, y);
        const occ = 0.74 + 0.26 * (ny * 0.5 + 0.5);
        const c = this.shade * mix(1, ramp * occ, gr);
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = c;
      }
      g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
      list.push({ g, mask: this.mask });
    }
  }
  /** World (body-space) position of a bone-local point at rest. */
  rest(b: THREE.Object3D, p: V3): THREE.Vector3 {
    b.updateWorldMatrix(true, false);
    return new THREE.Vector3(p[0], p[1], p[2]).applyMatrix4(b.matrixWorld);
  }
  finish(mats: Record<MK, THREE.Material>, sphere: THREE.Sphere): { skel: THREE.Skeleton; tris: number } {
    this.top.updateMatrixWorld(true);
    const skel = new THREE.Skeleton(this.bones);
    const bind = new THREE.Matrix4();
    let tris = 0;
    for (const mk of MK_ORDER) {
      const list = this.parts.get(mk);
      if (!list || !list.length) continue;
      const g = mergeGeometries(
        list.map((x) => x.g),
        false,
      );
      if (!g) continue;
      // each part's index range in the merged buffer -> per-LOD index subsets
      const lods: number[][] = [[], [], []];
      const src = g.index!.array;
      let at = 0;
      for (const { g: pg, mask } of list) {
        const cnt = pg.index!.count;
        for (let lv = 0; lv < 3; lv++) if (mask & (1 << lv)) for (let i = at; i < at + cnt; i++) lods[lv].push(src[i]);
        at += cnt;
        pg.dispose();
      }
      const big = g.attributes.position.count > 65535;
      const mkIndex = (a: number[]) => (big ? new THREE.Uint32BufferAttribute(a, 1) : new THREE.Uint16BufferAttribute(a, 1));
      const sub = (a: number[]) => {
        const s = new THREE.BufferGeometry();
        for (const name of Object.keys(g.attributes)) s.setAttribute(name, g.attributes[name]);
        s.setIndex(mkIndex(a));
        s.boundingSphere = sphere.clone();
        return s;
      };
      g.setIndex(mkIndex(lods[0]));
      g.computeBoundingSphere();
      registerLods(g, [sub(lods[1]), sub(lods[2])]);
      for (let lv = 0; lv < 3; lv++) this.lodTris[lv] += lods[lv].length / 3;
      tris += lods[0].length / 3;
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

/*
 * Sniper rifles (render only; sim weapon 'sniper'). Long barrel with a muzzle brake, a big
 * day scope with bells and turrets, a deployed bipod under the fore-end, a cheek riser.
 *   bolt:    tactical bolt-action chassis rifle (M2010, Matzpen, SV-98, G29, K14, UAR-10, KNT-308)
 *   svd:     Dragunov-pattern DMR with a skeleton (thumbhole) stock in dark wood (Nakhjir)
 *   bullpup: QBU-88-style bullpup marksman rifle
 */
type SniperKind = 'bolt' | 'svd' | 'bullpup';
const SNIPER_RIFLE: Record<string, SniperKind> = { china: 'bullpup', iran: 'svd' };

function sniperRifleGeo(kind: SniperKind): { parts: Part[]; w: WInfo; muzzle: V3 } {
  const parts: Part[] = [];
  const P = (g: G) => parts.push(['gun', g]);
  const D = (g: G) => parts.push(['dark', g]);
  const W = (g: G) => parts.push([kind === 'svd' ? 'hair' : 'gun', g]); // furniture: dark wood on the SVD
  const by = 0.055; // bore height above the grip
  // scope: main tube, objective / ocular bells, turrets, rings (shared, shifted per layout)
  const scope = (x: number, y: number, len: number, z = 0) => {
    P(xf(cylX(0.019, 0.019, len, 10), [x, y, z]));
    P(xf(cylX(0.033, 0.021, 0.085, 10), [x + len / 2 + 0.035, y, z]));
    P(xf(cylX(0.025, 0.02, 0.055, 10), [x - len / 2 - 0.022, y, z]));
    D(xf(cylX(0.029, 0.029, 0.012, 10), [x + len / 2 + 0.08, y, z])); // lens cap rim
    P(xf(cylY(0.013, 0.013, 0.03, 8), [x + 0.01, y + 0.03, z]));
    P(xf(cylY(0.012, 0.012, 0.028, 8), [x + 0.01, y, z + 0.03], [PI / 2, 0, 0]));
    for (const dx of [-len * 0.28, len * 0.28]) P(xf(box(0.022, y - 0.075, 0.026), [x + dx, 0.075 + (y - 0.075) / 2, z]));
  };
  // deployed bipod: two splayed legs with feet under the fore-end
  const bipod = (x: number) => {
    P(xf(rbox(0.04, 0.025, 0.04, 0.008), [x, 0.02, 0]));
    for (const sd of [1, -1]) {
      parts.push(['gun', strut([x, 0.015, sd * 0.012], [x + 0.13, -0.2, sd * 0.075], 0.0075)]);
      parts.push(['dark', xf(sph(0.014, 0.01, 0.014, 6, 4), [x + 0.13, -0.205, sd * 0.075])]);
    }
  };
  const brake = (x: number) => {
    P(xf(cylX(0.019, 0.019, 0.075, 8), [x, by, 0]));
    D(xf(box(0.012, 0.03, 0.042), [x + 0.012, by, 0]));
  };
  if (kind === 'bullpup') {
    // QBU-88 style: long polymer body, action behind the grip, scope on a raised rail
    W(xf(rbox(0.6, 0.085, 0.045, 0.02), [-0.15, 0.045, 0]));
    W(xf(rbox(0.14, 0.05, 0.046, 0.015), [0.18, 0.06, 0])); // fore-end
    P(xf(rbox(0.035, 0.09, 0.026, 0.008), [-0.005, -0.03, 0], [0, 0, -0.25])); // grip
    P(xf(rbox(0.042, 0.11, 0.024, 0.006), [-0.17, -0.035, 0], [0, 0, -0.12])); // mag behind the grip
    W(xf(rbox(0.035, 0.13, 0.05, 0.012), [-0.45, 0.02, 0])); // butt pad
    P(xf(cylX(0.011, 0.011, 0.44, 8), [0.47, by, 0]));
    brake(0.72);
    scope(-0.06, 0.15, 0.24);
    bipod(0.2);
    const muzzle: V3 = [0.765, by, 0];
    return { parts, muzzle, w: { kind: 'rifle', grip: new THREE.Vector3(-0.01, -0.01, 0.006), fore: new THREE.Vector3(0.17, 0.02, 0), pivot: new THREE.Vector3(-0.46, 0.04, 0), round: false } };
  }
  const svd = kind === 'svd';
  // receiver, bolt, magazine, trigger group
  P(xf(box(0.24, 0.064, 0.04), [0.05, 0.05, 0]));
  if (!svd) {
    P(xf(cylX(0.011, 0.011, 0.07, 6), [-0.045, 0.06, 0.03])); // bolt body
    P(strut([-0.04, 0.06, 0.03], [-0.035, 0.035, 0.075], 0.007));
    D(xf(sph(0.014, 0.014, 0.014, 6, 4), [-0.035, 0.035, 0.078])); // bolt knob
    P(xf(rbox(0.06, 0.07, 0.028, 0.006), [0.085, 0.0, 0]));
  } else {
    P(xf(rbox(0.045, 0.08, 0.024, 0.006), [0.09, -0.005, 0], [0, 0, -0.14])); // curved 10-round mag
    P(xf(rbox(0.045, 0.06, 0.024, 0.006), [0.105, -0.07, 0], [0, 0, -0.38]));
  }
  P(xf(rbox(0.034, 0.1, 0.028, 0.008), [-0.012, -0.005, 0], [0, 0, -0.3])); // pistol grip
  // fore-end / handguard
  if (svd) {
    W(xf(rbox(0.26, 0.055, 0.05, 0.016), [0.31, 0.055, 0]));
    P(xf(cylX(0.011, 0.011, 0.36, 8), [0.6, by, 0]));
    P(xf(cylX(0.016, 0.014, 0.06, 8), [0.81, by, 0])); // flash hider
  } else {
    P(xf(rbox(0.36, 0.055, 0.048, 0.016), [0.35, 0.056, 0]));
    for (const x of [0.22, 0.32, 0.42]) D(xf(box(0.04, 0.022, 0.05), [x, 0.056, 0])); // M-LOK slots
    P(xf(cylX(0.012, 0.012, 0.34, 8), [0.7, by, 0]));
    brake(0.9);
  }
  // stock
  if (svd) {
    // skeleton thumbhole stock: upper comb, lower strut, butt
    W(xf(rbox(0.3, 0.04, 0.036, 0.012), [-0.22, 0.06, 0]));
    W(xf(rbox(0.26, 0.03, 0.034, 0.01), [-0.24, -0.04, 0], [0, 0, 0.18]));
    W(xf(rbox(0.05, 0.15, 0.04, 0.014), [-0.38, 0.015, 0]));
    W(xf(rbox(0.1, 0.03, 0.03, 0.01), [-0.21, 0.09, 0])); // cheek pad
  } else {
    P(xf(rbox(0.34, 0.05, 0.036, 0.012), [-0.24, 0.045, 0])); // chassis comb
    P(xf(rbox(0.14, 0.035, 0.034, 0.01), [-0.25, 0.085, 0])); // adjustable cheek riser
    P(xf(rbox(0.045, 0.15, 0.04, 0.014), [-0.42, 0.02, 0])); // butt plate
    P(xf(box(0.2, 0.018, 0.022), [-0.3, -0.03, 0], [0, 0, 0.12])); // lower rail
    P(xf(cylY(0.008, 0.008, 0.07, 5), [-0.36, -0.07, 0])); // rear monopod
  }
  if (svd) scope(0.05, 0.13, 0.17, -0.012);
  else scope(0.04, 0.135, 0.26);
  bipod(svd ? 0.36 : 0.44);
  const muzzle: V3 = svd ? [0.85, by, 0] : [0.94, by, 0];
  const butt = svd ? -0.405 : -0.445;
  return { parts, muzzle, w: { kind: 'rifle', grip: new THREE.Vector3(-0.012, -0.012, 0.006), fore: new THREE.Vector3(svd ? 0.27 : 0.3, 0.015, 0), pivot: new THREE.Vector3(butt, 0.045, 0), round: false } };
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

type Role = 'rifle' | 'at' | 'engineer' | 'fpv' | 'ew' | 'gunner' | 'loader' | 'sniper';
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
  chest: THREE.Bone;
  neck: THREE.Bone;
  head: THREE.Bone;
  uaR: THREE.Bone;
  uaL: THREE.Bone;
  faR: THREE.Bone;
  faL: THREE.Bone;
}

/*
 * Skeleton (metres, rest pose, forward +X, right +Z):
 *   hips (pelvis) -> spine (lumbar) -> chest -> neck -> head
 *                                       chest -> clavicle -> upper arm -> forearm -> hand   (x2)
 *   hips -> thigh -> shin -> foot                                                          (x2)
 *   chest -> weapon (both hands IK'd onto its grips)
 * Torso / vest / pack vertices blend between spine and chest (soft skin), so the
 * body bends smoothly at the waist. Parts are modelled in the old single-spine
 * frame (`Rig.frames`), the joints themselves sit where a real one is.
 */
const TH = 0.44; // thigh
const SH = 0.43; // shin (knee -> ankle)
const UA = 0.29; // upper arm
const FA = 0.295; // elbow -> hand centre
const SHOULDER: V3 = [0, 0.385, 0.19]; // shoulder joint at rest (spine frame)
/** spine -> chest joint (spine frame height); weapon / hand targets are written in spine-frame numbers minus this. */
const CH = 0.22;
const NECK_Y = 0.28; // chest -> neck base
const HEAD_Y = 0.09; // neck base -> skull pivot
const CLAV: V3 = [0, 0.36 - CH, 0.035]; // clavicle root (chest frame, right side)
const CLAV_UA: V3 = [0, SHOULDER[1] - 0.36, SHOULDER[2] - 0.035]; // clavicle -> shoulder joint
const WRIST = 0.255; // elbow -> wrist

/** Hero part + its low-poly stand-in for LOD1/2. */
function hiLo(r: Rig, b: THREE.Bone, mk: MK, hi: G, lo: G) {
  r.addL(L0, b, mk, hi);
  r.addL(L_LO, b, mk, lo);
}
/** Round parts (limbs, torso): cylindrical UVs. */
function round(r: Rig, fn: () => void) {
  r.cyl = true;
  fn();
  r.cyl = false;
}
/** Shaded parts (pouch flaps, straps): albedo multiplier baked into the vertex colour. */
function shaded(r: Rig, k: number, fn: () => void) {
  const s = r.shade;
  r.shade = k;
  fn();
  r.shade = s;
}

/*
 * Proportions are a little heroic for the RTS camera: larger head and helmet,
 * broad plate-carrier shoulders, thick limbs and big boots, so the silhouette
 * (helmet dome, shoulders, pack, weapon) survives at phone zoom. The joints
 * stay where the animation expects them.
 */
function body(r: Rig, kit: Kit, p: string, x: number, z: number, yaw: number, helmet: HelmetKind, pack: PackKind): Body {
  const hips = r.bone(p + 'hips', null, x, 0.98, z);
  hips.rotation.y = yaw;
  const spine = r.bone(p + 'spine', hips, 0, 0.06, 0);
  const chest = r.bone(p + 'chest', spine, 0, CH, 0);
  r.frames.set(chest, spine);
  r.soft.set(chest, { lo: spine, y0: 0.06, y1: 0.3 });
  const neck = r.bone(p + 'neck', chest, 0, NECK_Y, 0);
  const head = r.bone(p + 'head', neck, 0, HEAD_Y, 0);
  r.frames.set(head, neck);
  const clR = r.bone(p + 'clR', chest, CLAV[0], CLAV[1], CLAV[2]);
  const clL = r.bone(p + 'clL', chest, CLAV[0], CLAV[1], -CLAV[2]);
  const uaR = r.bone(p + 'uaR', clR, CLAV_UA[0], CLAV_UA[1], CLAV_UA[2]);
  const faR = r.bone(p + 'faR', uaR, 0, -UA, 0);
  const uaL = r.bone(p + 'uaL', clL, CLAV_UA[0], CLAV_UA[1], -CLAV_UA[2]);
  const faL = r.bone(p + 'faL', uaL, 0, -UA, 0);
  const hdR = r.bone(p + 'hdR', faR, 0, -WRIST, 0);
  const hdL = r.bone(p + 'hdL', faL, 0, -WRIST, 0);
  r.frames.set(hdR, faR);
  r.frames.set(hdL, faL);
  const glove: MK = kit.gloves === 'skin' ? 'skin' : kit.gloves;
  const bootM: MK = kit.bootsGear ? 'gear' : 'dark';
  const kneeM: MK = kit.gearTex === 'canvas' ? 'gear' : 'dark';

  // ---- pelvis, belt (battle belt with pouches)
  round(r, () => hiLo(r, hips, 'camo', xf(sph(0.138, 0.13, 0.185, 12, 7), [0, -0.05, 0]), xf(sph(0.138, 0.13, 0.185, 8, 5), [0, -0.05, 0])));
  r.add(hips, 'gear', xf(cylY(1, 1, 0.06, 14, true), [0, 0.03, 0], [0, 0, 0], [0.15, 1, 0.196]));
  shaded(r, 0.92, () => {
    r.addL(L0, hips, 'gear', xf(rbox(0.065, 0.09, 0.07, 0.016), [-0.075, -0.005, 0.165]), xf(rbox(0.08, 0.08, 0.13, 0.018), [-0.15, -0.015, 0]), xf(rbox(0.065, 0.085, 0.06, 0.014), [-0.07, -0.005, -0.172]));
    r.addL(L0, hips, 'gear', xf(rbox(0.05, 0.08, 0.05, 0.012), [0.07, 0.0, 0.17]), xf(rbox(0.05, 0.08, 0.05, 0.012), [0.07, 0.0, -0.17]));
    r.addL(L_LO, hips, 'gear', xf(box(0.08, 0.08, 0.36), [-0.1, -0.01, 0]));
  });

  // ---- legs: thick thighs with cargo pockets, knee pads, big boots
  for (const sd of [1, -1]) {
    const s = sd > 0 ? 'R' : 'L';
    const th = r.bone(p + 'th' + s, hips, 0, -0.04, sd * 0.095);
    const sh = r.bone(p + 'sh' + s, th, 0, -TH, 0);
    const ft = r.bone(p + 'ft' + s, sh, 0, -SH, 0);
    round(r, () => hiLo(r, th, 'camo', xf(limb(0.116, 0.084, TH, 10), [0, 0, 0], [0, 0, 0], [1.1, 1, 1.02]), xf(limb(0.116, 0.084, TH, 6), [0, 0, 0], [0, 0, 0], [1.1, 1, 1.02])));
    shaded(r, 0.94, () => r.addL(L_HI, th, 'camo', xf(rbox(0.12, 0.13, 0.045, 0.016), [0.0, -0.22, sd * 0.078])));
    round(r, () => hiLo(r, sh, 'camo', limb(0.086, 0.064, 0.36, 10), limb(0.086, 0.064, 0.36, 6)));
    // knee pad (hard cap + strap)
    r.add(sh, kneeM, xf(sph(0.045, 0.075, 0.076, 7, 5), [0.066, -0.015, 0]));
    r.addL(L0, sh, kneeM, xf(cylY(0.083, 0.083, 0.022, 10, true), [0.0, -0.05, 0], [0, 0, 0.2], [1, 1, 1]));
    // boot: shaft, upper, toe cap, sole with heel
    hiLo(r, ft, bootM, xf(cylY(0.063, 0.067, 0.17, 10), [-0.005, 0.04, 0]), xf(cylY(0.063, 0.067, 0.17, 6), [-0.005, 0.04, 0]));
    r.add(ft, bootM, xf(rbox(0.275, 0.09, 0.118, 0.035), [0.05, -0.027, 0]));
    r.addL(L0, ft, bootM, xf(sph(0.06, 0.04, 0.058, 8, 4), [0.15, -0.035, 0]));
    r.add(ft, 'dark', xf(box(0.285, 0.022, 0.124), [0.05, -0.063, 0]));
  }

  // ---- torso
  const tp: [number, number][] = [
    [0.13, -0.06],
    [0.143, 0.04],
    [0.16, 0.14],
    [0.176, 0.24],
    [0.183, 0.32],
    [0.17, 0.38],
    [0.125, 0.43],
    [0.06, 0.47],
    [0.045, 0.49],
  ];
  round(r, () => hiLo(r, chest, 'camo', xf(lathe(tp, 14), [0, 0, 0], [0, 0, 0], [0.76, 1, 1.08]), xf(lathe(tp, 8), [0, 0, 0], [0, 0, 0], [0.76, 1, 1.08])));
  vest(r, chest, kit);
  backpack(r, chest, kit, pack, p);

  // ---- arms (broad deltoids, rolled-up feel at the cuff, gloves)
  for (const sd of [1, -1]) {
    const ua = sd > 0 ? uaR : uaL;
    const fa = sd > 0 ? faR : faL;
    const hd = sd > 0 ? hdR : hdL;
    hiLo(r, ua, 'camo', xf(sph(0.085, 0.083, 0.08, 10, 7), [0, -0.02, 0]), xf(sph(0.085, 0.083, 0.08, 7, 4), [0, -0.02, 0]));
    round(r, () => hiLo(r, ua, 'camo', limb(0.077, 0.061, UA - 0.02, 9), limb(0.077, 0.061, UA - 0.02, 6)));
    if (kit.vest === 'bulky') r.add(ua, 'gear', xf(sph(0.092, 0.066, 0.09, 8, 5), [0, -0.01, sd * 0.004]));
    // team armband (wide, wraps the sleeve) + velcro flag patch on the shoulder
    r.add(ua, 'team', xf(cylY(0.082, 0.076, 0.085, 10, true), [0, -0.135, 0]));
    r.addL(L0, ua, 'team', xf(rbox(0.07, 0.06, 0.016, 0.006), [0.0, -0.055, sd * 0.078], [sd * -0.12, 0, 0]));
    round(r, () => hiLo(r, fa, 'camo', limb(0.062, 0.046, 0.235, 9), limb(0.062, 0.046, 0.235, 6)));
    shaded(r, 0.9, () => r.addL(L0, fa, 'camo', xf(cylY(0.06, 0.06, 0.035, 9, true), [0, -0.02, 0])));
    // glove: palm + fingers + thumb
    r.add(hd, glove, xf(sph(0.043, 0.058, 0.038, 7, 5), [0, -0.29, 0]));
    r.addL(L0, hd, glove, xf(box(0.024, 0.052, 0.022), [0.032, -0.27, -sd * 0.016]));
  }

  // ---- neck & head (head parts are modelled in the neck-base frame; heroic 1.08 head)
  r.add(neck, 'skin', xf(limb(0.056, 0.06, 0.11, 7), [0, 0.075, 0]));
  const H = (g: G) => {
    (g.userData.lo as G | undefined)?.translate(0, -0.12, 0);
    return xf(g.translate(0, -0.12, 0), [0, 0.12, 0], [0, 0, 0], 1.06);
  };
  hiLo(r, head, 'skin', H(xf(sph(0.098, 0.115, 0.083, 12, 9), [0.0, 0.13, 0])), H(xf(sph(0.098, 0.115, 0.083, 8, 6), [0.0, 0.13, 0])));
  hiLo(r, head, 'skin', H(xf(sph(0.074, 0.072, 0.068, 10, 7), [0.034, 0.066, 0])), H(xf(sph(0.074, 0.072, 0.068, 6, 4), [0.034, 0.066, 0])));
  // face: nose, brow ridge, ears, eyes, brows
  r.addL(L0, head, 'skin', H(xf(sph(0.02, 0.03, 0.016, 6, 4), [0.1, 0.11, 0], [0, 0, -0.25])), H(xf(sph(0.03, 0.014, 0.075, 8, 4), [0.083, 0.15, 0])), H(xf(sph(0.016, 0.028, 0.011, 5, 4), [-0.004, 0.115, 0.084])), H(xf(sph(0.016, 0.028, 0.011, 5, 4), [-0.004, 0.115, -0.084])));
  r.addL(L0, head, 'dark', H(xf(sph(0.011, 0.008, 0.013, 6, 4), [0.091, 0.134, 0.032])), H(xf(sph(0.011, 0.008, 0.013, 6, 4), [0.091, 0.134, -0.032])), H(xf(box(0.01, 0.007, 0.032), [0.097, 0.153, 0.032])), H(xf(box(0.01, 0.007, 0.032), [0.097, 0.153, -0.032])));
  if (kit.beard) r.addL(L_HI, head, 'hair', H(xf(sph(0.072, 0.05, 0.066, 8, 5), [0.045, 0.058, 0])));
  if (kit.shades) r.addL(L_HI, head, 'dark', H(xf(rbox(0.025, 0.03, 0.15, 0.008), [0.093, 0.135, 0])));
  hat(r, head, kit, helmet);
  return { hips, spine, chest, neck, head, uaR, uaL, faR, faL };
}

/** Helmet shell scale (heroic: about 10 % over life size). */
const HS = 1.1;

function hat(r: Rig, head: THREE.Bone, kit: Kit, kind: HelmetKind) {
  // all helmet parts in the neck frame; `hx` = helmet transform (centre y, tilt, radii)
  const shell = (cap: number, y: number, tilt: number, rx: number, ry: number, rz: number, mk: MK = 'camo') => {
    const s: V3 = [rx * HS, ry * HS, rz * HS];
    hiLo(r, head, mk, xf(dome(cap, 18, 8), [0.0, y, 0], [0, 0, tilt], s), xf(dome(cap, 10, 4), [0.0, y, 0], [0, 0, tilt], s));
  };
  // team colour: band round the shell + an ID patch on the crown (readable from the RTS camera)
  const band = (y: number, tilt: number, rx: number, rz: number, h = 0.03) => r.add(head, 'team', xf(cylY(1, 1, h, 14, true), [0.0, y, 0], [0, 0, tilt], [rx * HS * 1.012, 1, rz * HS * 1.012]));
  const crown = (y: number, tilt: number, rx: number, ry: number, rz: number, cap = 0.5) => r.add(head, 'team', xf(dome(cap, 12, 2), [0.0, y, 0], [0, 0, tilt], [rx * HS * 1.018, ry * HS * 1.018, rz * HS * 1.018]));
  const earpro = (y: number, zz: number) => {
    if (kit.earpro) r.addL(L_HI, head, 'dark', xf(sph(0.034, 0.045, 0.026, 7, 5), [-0.005, y, zz * HS]), xf(sph(0.034, 0.045, 0.026, 7, 5), [-0.005, y, -zz * HS]));
  };
  switch (kind) {
    case 'fast': {
      // high-cut ballistic helmet: rails, NVG shroud, counterweight pouch
      shell(1.5, 0.15, 0.2, 0.122, 0.122, 0.108);
      r.addL(L_HI, head, 'dark', xf(rbox(0.035, 0.055, 0.05, 0.01), [0.13, 0.205, 0], [0, 0, 0.3]));
      r.addL(L0, head, 'dark', xf(box(0.1, 0.016, 0.014), [0.0, 0.165, 0.118]), xf(box(0.1, 0.016, 0.014), [0.0, 0.165, -0.118]));
      shaded(r, 0.9, () => r.addL(L_HI, head, 'gear', xf(rbox(0.04, 0.06, 0.09, 0.014), [-0.13, 0.165, 0])));
      earpro(0.115, 0.092);
      band(0.17, 0.2, 0.124, 0.11);
      crown(0.15, 0.2, 0.122, 0.122, 0.108);
      break;
    }
    case 'mitz': {
      // IDF: shell under the floppy "mitznefet" cover
      shell(1.62, 0.13, 0.1, 0.123, 0.126, 0.11);
      hiLo(r, head, 'camo', jitter(xf(dome(1.9, 16, 7), [0, 0, 0], [0, 0, 0], [0.142 * HS, 0.135 * HS, 0.132 * HS]), 0.12, 7).translate(0.0, 0.135, 0), jitter(xf(dome(1.9, 10, 4), [0, 0, 0], [0, 0, 0], [0.142 * HS, 0.135 * HS, 0.132 * HS]), 0.1, 7).translate(0.0, 0.135, 0));
      r.add(head, 'camo', xf(new THREE.ConeGeometry(0.04, 0.08, 5), [-0.045, 0.28, 0.035], [0.3, 0, 0.5]), xf(new THREE.ConeGeometry(0.034, 0.07, 5), [0.02, 0.285, -0.055], [-0.4, 0, -0.2]));
      band(0.16, 0.05, 0.141, 0.129, 0.03);
      crown(0.135, 0, 0.142, 0.135, 0.132, 0.45);
      break;
    }
    case 'm92':
    case 'qgf': {
      // full-cut shell with a flared brim
      shell(1.66, 0.13, 0.1, 0.125, 0.128, 0.112);
      r.add(head, 'camo', xf(cylY(0.128 * HS, 0.146 * HS, 0.028, 16, true), [0.0, 0.112, 0], [0, 0, 0.1], [1, 1, 0.9]));
      if (kind === 'qgf') r.addL(L_HI, head, 'dark', xf(box(0.022, 0.02, 0.18), [0.125, 0.175, 0]));
      if (kind === 'm92') shaded(r, 0.85, () => r.addL(L0, head, 'camo', xf(cylY(1, 1, 0.025, 14, true), [0, 0.2, 0], [0, 0, 0.1], [0.123 * HS, 1, 0.11 * HS])));
      earpro(0.105, 0.094);
      band(0.175, 0.1, 0.127, 0.114);
      crown(0.13, 0.1, 0.125, 0.128, 0.112, 0.48);
      break;
    }
    case '6b47': {
      // Ratnik 6B47 with cover, goggles on the brow
      shell(1.72, 0.13, 0.12, 0.128, 0.13, 0.116);
      r.addL(L_HI, head, 'dark', xf(rbox(0.045, 0.04, 0.12, 0.014), [0.12, 0.215, 0], [0, 0, 0.25]));
      shaded(r, 0.9, () => r.addL(L_HI, head, 'gear', xf(rbox(0.04, 0.055, 0.09, 0.014), [-0.135, 0.15, 0])));
      earpro(0.1, 0.1);
      band(0.17, 0.12, 0.13, 0.118);
      crown(0.13, 0.12, 0.128, 0.13, 0.116, 0.48);
      break;
    }
    case 'boonie': {
      const hp: [number, number][] = [
        [0.112, 0.155],
        [0.112, 0.205],
        [0.102, 0.25],
        [0.055, 0.262],
        [0.0, 0.264],
      ];
      hiLo(r, head, 'camo', xf(lathe(hp, 16), [0.005, 0, 0], [0, 0, 0], [1.08, 1, 0.96]), xf(lathe(hp, 10), [0.005, 0, 0], [0, 0, 0], [1.08, 1, 0.96]));
      // wide floppy brim, a little droop
      hiLo(r, head, 'camo', jitter(xf(cylY(0.19, 0.205, 0.014, 18), [0.005, 0.15, 0], [0, 0, 0.06], [1.05, 1, 0.95]), 0.05, 3), xf(cylY(0.19, 0.205, 0.014, 10), [0.005, 0.15, 0], [0, 0, 0.06], [1.05, 1, 0.95]));
      r.add(head, 'team', xf(cylY(1, 1, 0.038, 14, true), [0.005, 0.178, 0], [0, 0, 0], [0.121, 1, 0.108]));
      r.add(head, 'team', xf(cylY(0.06, 0.06, 0.006, 10), [0.005, 0.266, 0]));
      break;
    }
    case 'hardhat': {
      r.add(head, 'hat', xf(dome(1.5, 14, 6), [0.0, 0.14, 0], [0, 0, 0.1], [0.125 * HS, 0.125 * HS, 0.112 * HS]));
      r.add(head, 'hat', xf(cylY(0.13 * HS, 0.148 * HS, 0.02, 14), [0.01, 0.15, 0], [0, 0, 0.1], [1.12, 1, 0.94]));
      r.add(head, 'hat', xf(box(0.17, 0.024, 0.026), [0.0, 0.28, 0], [0, 0, 0.1]));
      band(0.19, 0.1, 0.127, 0.114, 0.032);
      break;
    }
  }
}

function vest(r: Rig, chest: THREE.Bone, kit: Kit) {
  const g = (...gs: G[]) => r.add(chest, 'gear', ...gs);
  const gH = (...gs: G[]) => r.addL(L0, chest, 'gear', ...gs);
  const gL = (...gs: G[]) => r.addL(L_LO, chest, 'gear', ...gs);
  if (kit.vest === 'rig') {
    // chest rig: harness + row of mag pouches over the belly
    g(xf(cylY(1, 1, 0.13, 14, true), [0, 0.17, 0], [0, 0, 0], [0.136, 1, 0.18]));
    shaded(r, 1.06, () => {
      for (const z of [-0.1, -0.034, 0.034, 0.1]) gH(xf(rbox(0.055, 0.12, 0.06, 0.012), [0.142, 0.17, z]), xf(box(0.02, 0.03, 0.062), [0.168, 0.22, z]));
      gL(xf(box(0.06, 0.12, 0.26), [0.142, 0.17, 0]));
    });
    shaded(r, 0.85, () => {
      for (const sd of [1, -1]) g(xf(box(0.22, 0.024, 0.05), [0, 0.43, sd * 0.105]), xf(box(0.03, 0.26, 0.045), [-0.125, 0.31, sd * 0.07], [sd * 0.35, 0, 0]));
      gH(xf(box(0.03, 0.2, 0.045), [0.13, 0.33, 0.07], [-0.3, 0, -0.05]), xf(box(0.03, 0.2, 0.045), [0.13, 0.33, -0.07], [0.3, 0, -0.05]));
    });
    r.add(chest, 'team', xf(box(0.014, 0.07, 0.14), [0.142, 0.33, 0], [0, 0, -0.15]));
    return;
  }
  const big = kit.vest === 'bulky';
  const t = big ? 0.07 : 0.055;
  const w = big ? 0.34 : 0.3;
  const hh = big ? 0.35 : 0.31;
  // cummerbund, front + back plate bags, broad shoulder straps
  g(xf(cylY(1, 1, big ? 0.25 : 0.19, 16, true), [0, big ? 0.17 : 0.19, 0], [0, 0, 0], [big ? 0.152 : 0.142, 1, big ? 0.2 : 0.194]));
  hiLo(r, chest, 'gear', xf(rbox(t, hh, w, 0.022, 2), [0.125, 0.26, 0], [0, 0, -0.06]), xf(box(t, hh, w), [0.125, 0.26, 0], [0, 0, -0.06]));
  g(xf(box(t, hh, w), [-0.128, 0.27, 0], [0, 0, 0.04]));
  shaded(r, 0.92, () => {
    for (const sd of [1, -1]) g(xf(box(0.27, 0.03, 0.075), [0, 0.43, sd * 0.11]));
    // shoulder pads give the broad silhouette
    for (const sd of [1, -1]) r.add(chest, 'gear', xf(rbox(0.14, 0.035, 0.09, 0.012), [0, 0.425, sd * 0.16], [sd * 0.38, 0, 0]));
  });
  // triple mag pouches + admin pouch + flaps (hero); one block at LOD1/2
  shaded(r, 1.05, () => {
    for (const z of [-0.088, 0, 0.088]) {
      gH(xf(rbox(0.055, 0.11, 0.08, 0.014), [0.17, 0.155, z]));
      shaded(r, 0.92, () => gH(xf(rbox(0.06, 0.028, 0.082, 0.008), [0.172, 0.215, z])));
    }
    gH(xf(rbox(0.045, 0.08, 0.15, 0.014), [0.163, 0.29, 0]));
    gL(xf(box(0.06, 0.12, 0.26), [0.168, 0.16, 0]));
  });
  // side pouches: IFAK / grenade
  shaded(r, 0.96, () => {
    gH(xf(rbox(0.08, 0.1, 0.05, 0.014), [0.02, 0.16, 0.2]), xf(rbox(0.06, 0.08, 0.05, 0.012), [0.06, 0.16, -0.2]));
  });
  if (big) {
    // 6B45-style collar and groin protector
    r.add(chest, 'gear', xf(new THREE.TorusGeometry(0.115, 0.034, 6, 14, PI * 1.35), [-0.01, 0.44, 0], [PI / 2, 0, PI * 0.82], [0.95, 1.1, 1]));
    g(xf(rbox(0.045, 0.14, 0.18, 0.02), [0.135, -0.06, 0], [0, 0, 0.1]));
  }
  // radio + antenna (left side)
  r.addL(L_HI, chest, 'dark', xf(rbox(0.06, 0.13, 0.05, 0.012), [-0.04, 0.27, -0.215]));
  r.addL(L0, chest, 'dark', xf(cylY(0.0035, 0.006, 0.42, 4), [-0.06, 0.53, -0.215], [0.1, 0, 0.05]));
  // team ID panel on the chest plate (velcro patch)
  r.add(chest, 'team', xf(box(0.014, 0.075, 0.17), [0.157, 0.355, 0], [0, 0, -0.06]));
}

function backpack(r: Rig, chest: THREE.Bone, kit: Kit, pack: PackKind, p: string) {
  const g = (...gs: G[]) => r.add(chest, 'gear', ...gs);
  /** Team-colour lid on top of the pack (readable from the RTS camera) and a small marker panel on its back. */
  const lid = (x: number, y: number, w: number, d: number) => {
    r.add(chest, 'team', xf(rbox(w, 0.03, d, 0.012), [x, y, 0]));
    r.addL(L_HI, chest, 'team', xf(box(0.014, 0.06, d * 0.6), [x - w / 2 - 0.004, y - 0.06, 0]));
  };
  const assault = (x: number, y: number, w: number, h: number, d: number) => {
    hiLo(r, chest, 'gear', xf(rbox(w, h, d, 0.05, 2), [x, y, 0]), xf(box(w, h, d), [x, y, 0]));
    shaded(r, 0.9, () => r.addL(L_HI, chest, 'gear', xf(rbox(0.05, h * 0.45, d * 0.75, 0.014), [x - w / 2 - 0.02, y - h * 0.18, 0])));
    shaded(r, 0.85, () => r.addL(L0, chest, 'gear', xf(box(0.02, h * 0.9, 0.03), [x - w / 2 - 0.005, y, d * 0.3]), xf(box(0.02, h * 0.9, 0.03), [x - w / 2 - 0.005, y, -d * 0.3])));
    lid(x - 0.005, y + h / 2 + 0.005, w * 0.95, d * 0.95);
  };
  switch (pack) {
    case 'assault':
    case 'rpg': {
      assault(-0.225, 0.25, 0.16, 0.33, 0.28);
      if (pack === 'rpg') {
        for (const z of [-0.07, 0.07]) {
          r.add(chest, 'tube', xf(cylY(0.045, 0.045, 0.13, 8), [-0.21, 0.48, z]), xf(cylY(0.006, 0.045, 0.14, 8), [-0.21, 0.615, z]));
        }
      }
      break;
    }
    case 'tool': {
      assault(-0.215, 0.26, 0.14, 0.29, 0.26);
      // slung carbine across the back
      const { parts } = rifleGeo(kit.rifle, true);
      for (const [mk, geo] of parts) r.add(chest, mk, xf(geo, [-0.31, 0.25, 0], [PI / 2, 0, 0.75], [1, 1.12, 1.25]));
      break;
    }
    case 'radio': {
      assault(-0.215, 0.26, 0.14, 0.29, 0.26);
      r.add(chest, 'dark', xf(rbox(0.06, 0.16, 0.12, 0.012), [-0.3, 0.3, -0.04]), xf(cylY(0.004, 0.007, 0.6, 4), [-0.29, 0.66, -0.08], [0.12, 0, 0.1]));
      break;
    }
    case 'bombbag': {
      hiLo(r, chest, 'gear', xf(rbox(0.17, 0.31, 0.29, 0.045, 2), [-0.225, 0.24, 0]), xf(box(0.17, 0.31, 0.29), [-0.225, 0.24, 0]));
      for (const z of [-0.08, 0, 0.08]) r.add(chest, 'tube', xf(cylY(0.032, 0.032, 0.12, 6), [-0.225, 0.44, z]), xf(cylY(0.012, 0.032, 0.04, 6), [-0.225, 0.52, z]));
      lid(-0.23, 0.39, 0.16, 0.26);
      break;
    }
    case 'jammer': {
      // big backpack jammer: frame + RF box with fins
      g(xf(rbox(0.07, 0.42, 0.28, 0.02), [-0.17, 0.27, 0]));
      r.add(chest, 'dark', xf(rbox(0.17, 0.4, 0.3, 0.025, 2), [-0.29, 0.27, 0]));
      for (const y of [0.13, 0.19, 0.25, 0.31, 0.37]) r.addL(L_HI, chest, 'gun', xf(box(0.02, 0.012, 0.26), [-0.385, y, 0]));
      r.add(chest, 'gun', xf(rbox(0.13, 0.06, 0.26, 0.012), [-0.29, 0.5, 0]));
      r.add(chest, 'team', xf(box(0.014, 0.12, 0.23), [-0.385, 0.44, 0]), xf(box(0.08, 0.014, 0.2), [-0.345, 0.555, 0]));
      // antenna cluster on its own bone so it can sway
      const ant = r.bone(p + 'ant', chest, -0.29, 0.53 - CH, 0);
      const tips: V3[] = [
        [0.03, 0.62, 0.11],
        [-0.04, 0.68, 0.04],
        [-0.03, 0.6, -0.1],
        [0.06, 0.5, -0.04],
      ];
      for (const [i, t] of tips.entries()) {
        r.add(ant, 'dark', strut([t[0] * 0.05, 0.0, t[2] * 0.6], t, i === 3 ? 0.009 : 0.006, 4));
        r.add(ant, 'dark', xf(cylY(0.015, 0.015, 0.04, 6), [t[0] * 0.05, 0.02, t[2] * 0.6]));
      }
      r.add(ant, 'glow', xf(sph(0.03, 0.03, 0.03, 6, 4), [0.06, 0.0, 0.1]), xf(sph(0.022, 0.022, 0.022, 6, 4), [0.06, 0.0, -0.1]), xf(box(0.008, 0.05, 0.2), [0.116, -0.05, 0]));
      for (const [i, t] of tips.entries()) r.point(p + 'tip' + i, ant, t);
      break;
    }
    case 'drone': {
      assault(-0.215, 0.25, 0.14, 0.31, 0.27);
      // quadcopter strapped flat against the pack (own bone: hidden after launch)
      const dr = r.bone(p + 'drone', chest, -0.33, 0.27 - CH, 0);
      r.add(dr, 'dark', xf(rbox(0.05, 0.1, 0.09, 0.015), [0, 0, 0]));
      for (const a of [PI / 4, -PI / 4]) r.add(dr, 'dark', xf(box(0.02, 0.32, 0.027), [-0.005, 0, 0], [a, 0, 0]));
      for (const [y, z] of [
        [0.14, 0.14],
        [0.14, -0.14],
        [-0.14, 0.14],
        [-0.14, -0.14],
      ] as const) {
        r.addL(L_HI, dr, 'gun', xf(cylX(0.02, 0.02, 0.04, 6), [-0.03, y * 0.8, z * 0.8]));
        r.add(dr, 'dark', xf(cylX(0.062, 0.062, 0.005, 10), [-0.055, y * 0.8, z * 0.8]));
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

const RIFLE_K: V3 = [1, 1.12, 1.3];

/** Adds the weapon bone + geometry for a soldier; returns weapon info and muzzle name. */
function arm(r: Rig, b: Body, p: string, kind: 'rifle' | 'carbine' | AtKind | 'controller', kit: Kit, muzzles: string[]): WInfo {
  const wpn = r.bone(p + 'wpn', b.chest, 0.3, 0.2 - CH, 0.12);
  if (kind === 'rifle' || kind === 'carbine') {
    // a touch chunkier than life (cross-section only) so the rifle reads at phone zoom
    const g = rifleGeo(kit.rifle, kind === 'carbine');
    for (const [mk, geo] of g.parts) r.add(wpn, mk, xf(geo, [0, 0, 0], [0, 0, 0], RIFLE_K));
    r.point(p + 'muzzle0', wpn, [g.muzzle[0], g.muzzle[1] * RIFLE_K[1], 0]);
    muzzles.push(p + 'muzzle0');
    for (const v of [g.w.grip, g.w.fore, g.w.pivot]) v.y *= RIFLE_K[1];
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
      r.add(b.chest, 'hat', xf(cylY(1, 1, 0.035, 14, true), [0, 0.33, 0], [0, 0, 0], [0.165, 1, 0.2]));
      break;
    }
  }
  t.sols.push({ p, role, x: 0, z: 0, yaw: 0, w });
}

/** Deterministic 0..1 noise for the ghillie strands. */
const gh = (i: number, k: number) => {
  const h = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return h - Math.floor(h);
};

/**
 * Ghillie hood and cape: a shaggy shoulder cape and hanging burlap strands in the nation's camo and
 * gear colours, a veil off the boonie brim. Hero strands only at LOD0; LOD1/2 keep the cape shape.
 */
function ghillie(r: Rig, b: Body) {
  // cape over the shoulders and upper back (soft-skinned with the chest)
  hiLo(r, b.chest, 'camo', jitter(xf(dome(1.75, 16, 7), [-0.03, 0.27, 0], [0, 0, 0.32], [0.21, 0.24, 0.25]), 0.16, 11), xf(dome(1.75, 9, 4), [-0.03, 0.27, 0], [0, 0, 0.32], [0.21, 0.24, 0.25]));
  shaded(r, 0.8, () => r.addL(L_HI, b.chest, 'gear', jitter(xf(dome(1.6, 14, 6), [-0.05, 0.31, 0], [0, 0, 0.35], [0.2, 0.2, 0.23]), 0.22, 5)));
  // strands: around the cape edge, down the back
  for (let i = 0; i < 26; i++) {
    const a = (i / 26) * PI * 2 + gh(i, 1) * 0.3;
    const back = Math.cos(a) < 0.2; // fewer in front (rifle stock, arms)
    if (!back && i % 3) continue;
    const len = 0.1 + 0.14 * gh(i, 2) + (Math.cos(a) < -0.5 ? 0.08 : 0);
    const x = -0.03 + Math.cos(a) * 0.2;
    const z = Math.sin(a) * 0.24;
    const y = 0.27 - len / 2 + 0.03 * gh(i, 3);
    const mk: MK = gh(i, 4) < 0.55 ? 'camo' : 'gear';
    shaded(r, 0.72 + 0.4 * gh(i, 5), () => r.addL(i % 2 ? L0 : L_HI, b.chest, mk, xf(box(0.018 + 0.014 * gh(i, 6), len, 0.035 + 0.02 * gh(i, 7)), [x, y, z], [Math.sin(a) * 0.25 + (gh(i, 8) - 0.5) * 0.3, -a, -Math.cos(a) * 0.25])));
  }
  // veil hanging off the back and sides of the boonie brim
  const H = (g: G) => xf(g.translate(0, -0.12, 0), [0, 0.12, 0], [0, 0, 0], 1.06);
  for (let i = 0; i < 16; i++) {
    const a = PI * 0.45 + (i / 15) * PI * 1.1 + gh(i, 9) * 0.1;
    const len = 0.09 + 0.08 * gh(i, 10);
    const mk: MK = gh(i, 11) < 0.5 ? 'camo' : 'gear';
    shaded(r, 0.75 + 0.35 * gh(i, 12), () => r.addL(i % 2 ? L0 : L_HI, b.head, mk, H(xf(box(0.016, len, 0.03), [Math.cos(a) * 0.19, 0.15 - len / 2, Math.sin(a) * 0.18], [Math.sin(a) * 0.3, -a, -Math.cos(a) * 0.3]))));
  }
  // burlap tufts on the hat crown
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * PI * 2;
    shaded(r, 0.8 + 0.3 * gh(i, 13), () => r.addL(L0, b.head, i % 2 ? 'gear' : 'camo', H(xf(box(0.014, 0.07, 0.03), [Math.cos(a) * 0.07, 0.27, Math.sin(a) * 0.06], [Math.sin(a) * 0.6, -a, -Math.cos(a) * 0.6]))));
  }
}

/** Sniper: boonie with a ghillie veil and cape, long scoped rifle on a bipod, radio pack. */
function buildSniperTpl(r: Rig, kit: Kit, style: ModelStyle, t: Tpl) {
  const p = 'a';
  const b = body(r, kit, p, 0, 0, 0, 'boonie', 'radio');
  ghillie(r, b);
  const wpn = r.bone(p + 'wpn', b.chest, 0.3, 0.2 - CH, 0.12);
  const g = sniperRifleGeo(SNIPER_RIFLE[style.faction] ?? 'bolt');
  for (const [mk, geo] of g.parts) r.add(wpn, mk, xf(geo, [0, 0, 0], [0, 0, 0], RIFLE_K));
  r.point(p + 'muzzle0', wpn, [g.muzzle[0], g.muzzle[1] * RIFLE_K[1], 0]);
  t.muzzles.push(p + 'muzzle0');
  for (const v of [g.w.grip, g.w.fore, g.w.pivot]) v.y *= RIFLE_K[1];
  t.sols.push({ p, role: 'sniper', x: 0, z: 0, yaw: 0, w: g.w });
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
  const bomb = r.bone('lbomb', l.chest, 0.3, 0.2 - CH, 0);
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
// a finished match: drop its fog's templates and materials (fogcache.ts)
onFogRelease((f) => {
  const id = fogIds.get(f);
  if (!id) return;
  purgeKeys(tplCache, (k) => k.endsWith('|' + id));
  purgeKeys(stdCache, (k) => k.startsWith(id + ':'));
});

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
  const pat = kit.camo.pattern;
  r.uvs = { camo: pat === 'digital' ? 1.5 : pat === 'flecktarn' ? 1.9 : 2.3, gear: kit.gearTex === 'camo' ? (pat === 'digital' ? 1.8 : 2.2) : 3.5 };
  if (key === 'mortar') buildMortarTpl(r, kit, t);
  else if (key === 'sniper') buildSniperTpl(r, kit, style, t);
  else buildSoldierTpl(r, kit, key, t);
  const glowColor = key === 'ewinf' ? 0x5dff7a : 0x63d8ff;
  const mats = materials(kit, style, fog, glowColor);
  const { skel, tris } = r.finish(mats, t.sphere);
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

/*
 * Procedural animation runtime (no clips, no allocations per frame).
 *
 *  Locomotion: a stride phase integrated from the distance actually covered
 *  (AnimState.dist, converted to model metres), so the planted foot moves
 *  backwards exactly at ground speed and never slides. Each foot follows a
 *  stance / swing curve (heel strike, roll over the ball, toe-off, lift);
 *  thigh / knee / ankle come from an analytic two-bone IK in the pelvis frame
 *  and the pelvis drops whenever a planted foot couldn't reach. Pelvis bob,
 *  lateral sway, hip drop and yaw twist; the chest counter-twists and the
 *  free arms counter-swing. Walk <-> run blend by speed (stride length,
 *  stance fraction, lift, lean, bob), shuffle steps when turning on the spot.
 *  Weapon: low ready / port arms on the run / shouldered aim (clavicle up,
 *  cheek on the stock); a shot kicks shoulder, chest and head; after a few
 *  bursts a quick magazine swap. Idle: weight shifts, breathing, head
 *  look-around and small gestures (helmet, radio, look back, shoulder roll),
 *  all de-synchronised by a per-unit seed (AnimState.seed = entity id).
 *  Riflemen with the habit (and most AT gunners) take a knee to fire.
 *  Death: knees buckle under the body's weight (legs IK'd to the planted
 *  feet), then a gravity-accelerated topple, impact bounce and limbs that lag
 *  and flop before lying still (forward / backward / sideways variants).
 *  All state weights are smoothed, so no transition snaps.
 *  AnimState.lod: 1 = cheap cycle (sine legs, no gestures / reload hand path),
 *  2 = off screen (only clocks advance).
 */

/** Ankle height above the sole (foot bone origin). */
const ANK = 0.074;
const HIPJ_Y = -0.04; // hip joint below the pelvis bone
const HIPJ_Z = 0.095;
const LEG = TH + SH;
/** Stride (two steps) length in metres and stance fraction, walking / running. */
const WALK_C = 1.45;
const RUN_C = 2.15;
const WALK_B = 0.6;
const RUN_B = 0.36;
/** Ground speed (m/s, model scale) where the walk starts turning into a run, and the width of the blend. */
const RUN_V0 = 2.6;
const RUN_DV = 1.6;
/** Pelvis bone height in the kneel pose. */
const KNEEL_Y = 0.556;
const RELOAD_T = 0.72;
const GEST_T = 2.1;

interface Sol {
  def: SolDef;
  hips: THREE.Bone;
  spine: THREE.Bone;
  chest: THREE.Bone;
  neck: THREE.Bone;
  head: THREE.Bone;
  clR: THREE.Bone;
  clL: THREE.Bone;
  uaR: THREE.Bone;
  uaL: THREE.Bone;
  faR: THREE.Bone;
  faL: THREE.Bone;
  hdR: THREE.Bone;
  hdL: THREE.Bone;
  thR: THREE.Bone;
  thL: THREE.Bone;
  shR: THREE.Bone;
  shL: THREE.Bone;
  ftR: THREE.Bone;
  ftL: THREE.Bone;
  wpn: THREE.Bone | null;
  round: THREE.Bone | null;
  extra: THREE.Bone | null; // antenna / drone
  /** Per-unit random in [0, 1) and its integer source (hashing). */
  seed: number;
  sid: number;
  /** AnimState.seed the seed was derived from (NaN = template counter). */
  seedSrc: number;
  salt: number;
  aimW: number;
  moveW: number;
  kneelW: number;
  /** Smoothed walk (0) -> run (1) blend. */
  runW: number;
  /** Firing recoil impulse (0..1) and hit flinch timer / side. */
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
  /** Stride phase in cycles (left heel strike at integers). */
  phase: number;
  lastDist: number;
  /** Shuffle-step weight while turning on the spot. */
  turnW: number;
  /** Smoothed acceleration lean. */
  accL: number;
  lastV: number;
  /** Model metres per map tile (1 / (S * root scale)). */
  mpt: number;
  // weapon handling
  prevFired: number;
  shots: number;
  mag: number;
  reload: number; // seconds into the magazine swap (-1 = none)
  reloadW: number;
  crouch: boolean;
  // idle life
  lookY: number;
  lookP: number;
  /** Bones blended by the death snapshot (built on first use). */
  bl: THREE.Object3D[] | null;
  /** Head turned towards a threat (AnimState.look): weight and smoothed yaw. */
  thrW: number;
  thrY: number;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpC = new THREE.Vector3();
const tmpD = new THREE.Vector3();
const tmpE = new THREE.Vector3();
const tmpF = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpM2 = new THREE.Matrix4();
const CLAV_OFF_R = new THREE.Vector3(CLAV_UA[0], CLAV_UA[1], CLAV_UA[2]);
const CLAV_OFF_L = new THREE.Vector3(CLAV_UA[0], CLAV_UA[1], -CLAV_UA[2]);
const POLE_R = new THREE.Vector3(-0.35, -0.6, 1).normalize();
const POLE_L = new THREE.Vector3(-0.1, -1, -0.55).normalize();
const POLE_RC = new THREE.Vector3(-0.3, -1, 0.6).normalize();
const POLE_LC = new THREE.Vector3(-0.3, -1, -0.6).normalize();

/**
 * Two-bone arm IK in the chest frame: hand centre to T, elbow towards `pole`.
 * The shoulder joint follows the clavicle; the upper arm's rotation is
 * expressed relative to it (hinge at the elbow: forearm rotation.z).
 */
function ik(sol: Sol, sd: number, T: THREE.Vector3, pole: THREE.Vector3) {
  const cl = sd > 0 ? sol.clR : sol.clL;
  const ua = sd > 0 ? sol.uaR : sol.uaL;
  const fa = sd > 0 ? sol.faR : sol.faL;
  const S0 = tmpF.copy(sd > 0 ? CLAV_OFF_R : CLAV_OFF_L).applyQuaternion(cl.quaternion).add(cl.position);
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
  ua.quaternion.setFromRotationMatrix(tmpM).premultiply(tmpQ2.copy(cl.quaternion).invert());
  fa.rotation.set(0, 0, Math.acos(clamp(u.dot(v), -1, 1)));
}

/** Arm hanging from its clavicle: swing (+ forward), abduction (+ out), elbow flex. */
function freeArm(ua: THREE.Bone, fa: THREE.Bone, sd: number, swing: number, abduct: number, flex: number) {
  ua.rotation.set(-sd * abduct, 0, swing);
  fa.rotation.set(0, 0, flex);
}

/** Pose the weapon bone so its pivot sits at P (spine-frame numbers, chest space) with the given yaw/pitch/roll. */
function placeWeapon(sol: Sol, w: WInfo, px: number, py: number, pz: number, pitch: number, yaw: number, roll: number, kick: number) {
  const wpn = sol.wpn!;
  _e.set(roll, yaw, pitch, 'YZX');
  wpn.quaternion.setFromEuler(_e);
  tmpA.copy(w.pivot).applyQuaternion(wpn.quaternion);
  wpn.position.set(px, py - CH, pz).sub(tmpA);
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
/** Weapon-local point -> chest space. */
function onWeapon(sol: Sol, x: number, y: number, z: number, out: THREE.Vector3) {
  const wpn = sol.wpn!;
  return out.set(x, y, z).applyQuaternion(wpn.quaternion).add(wpn.position);
}

interface LegOut {
  /** Pelvis pitch (rotation.z, + = back). */
  hp: number;
  /** Pelvis yaw twist and roll (soldier frame). */
  tw: number;
  roll: number;
  /** Stride angle (radians): sin(phase) = +1 when the left foot is forward. */
  phase: number;
  runK: number;
  /** Gait weight (moving or shuffling). */
  gw: number;
}
const LO: LegOut = { hp: 0, tw: 0, roll: 0, phase: 0, runK: 0, gw: 0 };

/** Per leg (L, R): thigh flex, knee, ankle, abduction. */
const _ang = new Float32Array(8);
/** Per leg (L, R): foot target x, y, z, ground pitch, planted. */
const _ft = new Float32Array(10);
const _hj = new THREE.Vector3();
const _pq3 = new THREE.Quaternion();
const _pe3 = new THREE.Euler(0, 0, 0, 'YXZ');

/**
 * Analytic two-bone leg IK, pelvis frame: ankle to (x, y, z), sole pitched by
 * `fp` relative to the ground. Writes thigh / knee / ankle / abduction for leg i.
 */
function legIK(i: number, sd: number, x: number, y: number, z: number, fp: number, hp: number) {
  const dy = y - HIPJ_Y;
  const dz = z - sd * HIPJ_Z;
  const abd = Math.atan2(-dz, -dy);
  const dv = Math.sqrt(dy * dy + dz * dz);
  const d = clamp(Math.sqrt(x * x + dv * dv), 0.3, LEG * 0.999);
  const a = Math.atan2(x, dv);
  const th = a + Math.acos(clamp((TH * TH + d * d - SH * SH) / (2 * TH * d), -1, 1));
  const kn = Math.acos(clamp((TH * TH + SH * SH - d * d) / (2 * TH * SH), -1, 1)) - PI;
  _ang[i * 4] = th;
  _ang[i * 4 + 1] = kn;
  _ang[i * 4 + 2] = fp - hp - th - kn;
  _ang[i * 4 + 3] = abd;
}

/**
 * Legs + pelvis. Full LOD: foot targets (stance / swing curves, idle stance,
 * weight shift) solved with IK; cheap LOD: sine leg angles. Then the kneel
 * blend. Sets the pelvis bone and the leg bones, returns pelvis attitude.
 */
function legs(sol: Sol, s: AnimState, t: number, dt: number, lod: number): LegOut {
  const mw = sol.moveW;
  const kw = sol.kneelW;
  const init = dt === 0 && s.time === 0;
  // stride phase from the distance really covered (model metres)
  let dd = s.dist - sol.lastDist;
  sol.lastDist = s.dist;
  if (!(dd >= 0 && dd < 1)) dd = 0;
  const vm = s.speed * sol.mpt;
  const runT = s.moving ? clamp((vm - RUN_V0) / RUN_DV, 0, 1) : 0;
  sol.runW = init ? runT : approach(sol.runW, runT, dt, 4);
  const rk = sol.runW;
  const C = mix(WALK_C, RUN_C, rk);
  const B = mix(WALK_B, RUN_B, rk);
  // turning on the spot: little steps in place
  const tw0 = (1 - mw) * (1 - kw) * clamp((Math.abs(s.turn) - 0.7) / 1.5, 0, 1);
  sol.turnW = init ? 0 : approach(sol.turnW, tw0, dt, 6);
  sol.phase += (dd * sol.mpt) / C + dt * 1.8 * sol.turnW;
  if (sol.phase > 4096) sol.phase -= 4096;
  const gw = Math.max(mw, sol.turnW * 0.75);
  // acceleration lean (speed up: forward, brake: back)
  if (dt > 0) {
    const acc = clamp((vm - sol.lastV) / dt, -12, 12);
    sol.accL = approach(sol.accL, acc, dt, 5);
  }
  sol.lastV = vm;

  const ph = sol.phase;
  const cyc = 2 * PI * ph;
  const ms = cyc - PI * B; // 0 at left mid-stance
  const cms = Math.cos(ms);
  // idle weight shift (slow, per-unit period): + = weight on the right leg, left knee relaxed
  const shift = Math.sin(t * (0.32 + 0.22 * sol.seed) + sol.seed * 6) * (1 - mw) * (1 - kw);
  const relaxL = Math.max(0, shift);
  const relaxR = Math.max(0, -shift);
  // pelvis attitude
  const hp = -mix(0.04, 0.2, rk) * mw * (1 - kw);
  const tw = -Math.cos(cyc) * mix(0.11, 0.16, rk) * mw;
  const roll = cms * mix(0.05, 0.028, rk) * gw - 0.045 * shift;
  const sway = -cms * mix(0.026, 0.01, rk) * gw + 0.02 * shift;
  let py = mix(0.972, mix(0.95, 0.905, rk) + Math.cos(2 * ms) * mix(0.02, -0.03, rk) * gw, gw);
  let px = 0.012 * gw;

  if (lod === 0) {
    // ---- foot targets (soldier frame)
    const h = 0.5 * C * B * mw;
    const lift = mix(0.1, 0.25, rk) * gw;
    const off = mix(0.5, 0.38, rk);
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? -1 : 1;
      let u = ph + i * 0.5;
      u -= Math.floor(u);
      let fx: number;
      let fy: number;
      let fp: number;
      let planted: number;
      if (u < B) {
        const k = u / B;
        fx = h * (1 - 2 * k);
        const heel = (1 - sstep(0, 0.22, k)) * 0.2 * (1 - rk);
        const roll2 = sstep(0.6, 1, k) * off;
        fp = heel - roll2;
        fy = ANK + 0.13 * Math.sin(roll2);
        planted = 1;
      } else {
        const k = (u - B) / (1 - B);
        const e = k * k * (3 - 2 * k);
        fx = h * (2 * e - 1);
        const kl = rk > 0.01 ? Math.pow(k, 1 - 0.38 * rk) : k;
        fy = ANK + lift * Math.sin(PI * kl) + 0.13 * Math.sin(off) * (1 - sstep(0, 0.3, k));
        fp = mix(-off, 0.2 * (1 - rk), sstep(0, 0.8, k));
        planted = 0;
      }
      const relax = i === 0 ? relaxL : relaxR;
      const ix = (i === 0 ? 0.035 : -0.025) + 0.05 * relax;
      const iz = sd * (0.112 + 0.025 * relax);
      _ft[i * 5] = mix(ix, fx, gw);
      _ft[i * 5 + 1] = mix(ANK, fy, gw);
      _ft[i * 5 + 2] = mix(iz, sd * 0.1, gw);
      _ft[i * 5 + 3] = fp * gw + 0.06 * relax;
      _ft[i * 5 + 4] = mix(1, planted, gw);
    }
    // pelvis rotation (no home yaw): hip joints in the soldier frame
    _pq3.setFromEuler(_pe3.set(roll, tw, hp, 'YXZ'));
    // a planted foot must reach: drop the pelvis if needed
    for (let i = 0; i < 2; i++) {
      if (_ft[i * 5 + 4] < 0.5) continue;
      const sd = i === 0 ? -1 : 1;
      _hj.set(0, HIPJ_Y, sd * HIPJ_Z).applyQuaternion(_pq3);
      const dx = _ft[i * 5] - (px + _hj.x);
      const dz = _ft[i * 5 + 2] - (sway + _hj.z);
      const r2 = LEG * LEG * 0.97 - dx * dx - dz * dz;
      const ymax = _ft[i * 5 + 1] + Math.sqrt(Math.max(0.04, r2)) - _hj.y;
      if (py > ymax) py = ymax;
    }
    // IK in the pelvis frame
    _pq3.invert();
    for (let i = 0; i < 2; i++) {
      tmpA.set(_ft[i * 5] - px, _ft[i * 5 + 1] - py, _ft[i * 5 + 2] - sway).applyQuaternion(_pq3);
      legIK(i, i === 0 ? -1 : 1, tmpA.x, tmpA.y, tmpA.z, _ft[i * 5 + 3], hp);
    }
  } else {
    // ---- cheap cycle: sine angles, pelvis height from the lowest contact
    const A = mix(0.42, 0.62, rk) * mw;
    const kb = mix(0.06, 0.16, rk);
    const kf = mix(0.8, 1.45, rk);
    let hy = 0;
    for (let i = 0; i < 2; i++) {
      const p = cyc + PI / 2 + i * PI;
      const sw = Math.max(0, Math.cos(p));
      const relax = i === 0 ? relaxL : relaxR;
      const th = A * Math.sin(p) + 0.12 * rk * mw + (i === 0 ? 0.04 : -0.02) * (1 - mw) + relax * 0.1;
      const kn = -(kb + kf * Math.pow(sw, 1.3) + 0.35 * rk * Math.max(0, -Math.sin(p))) * gw - relax * 0.18 - 0.03 * (1 - mw);
      _ang[i * 4] = th - hp;
      _ang[i * 4 + 1] = kn;
      _ang[i * 4 + 2] = -(th + kn) - 0.35 * sw * mw;
      _ang[i * 4 + 3] = (i === 0 ? 0.05 : -0.05) * (1 - mw);
      const knee = 0.04 + TH * Math.cos(th);
      hy = Math.max(hy, knee + SH * Math.cos(th + kn) + 0.072, knee + 0.05);
    }
    py = hy + 0.01 * rk * mw * Math.abs(Math.sin(cyc));
    px = 0;
  }

  if (kw > 0.001) {
    // kneeling on the right knee, left foot forward
    for (let i = 0; i < 2; i++) {
      _ang[i * 4] = mix(_ang[i * 4], i === 0 ? 1.57 : 0.06, kw);
      _ang[i * 4 + 1] = mix(_ang[i * 4 + 1], -1.62, kw);
      _ang[i * 4 + 2] = mix(_ang[i * 4 + 2], i === 0 ? 0.05 : 0, kw);
      _ang[i * 4 + 3] = mix(_ang[i * 4 + 3], i === 0 ? 0.05 : -0.05, kw);
    }
    py = mix(py, KNEEL_Y, kw);
    px *= 1 - kw;
  }
  sol.thL.rotation.set(_ang[3], 0, _ang[0]);
  sol.shL.rotation.set(0, 0, _ang[1]);
  sol.ftL.rotation.set(-_ang[3] * 0.8, 0, _ang[2]);
  sol.thR.rotation.set(_ang[7], 0, _ang[4]);
  sol.shR.rotation.set(0, 0, _ang[5]);
  sol.ftR.rotation.set(-_ang[7] * 0.8, 0, _ang[6]);

  const c = Math.cos(sol.hyaw);
  const sn = Math.sin(sol.hyaw);
  const sw2 = sway * (1 - kw);
  sol.hips.position.set(sol.hx + c * px + sn * sw2, py, sol.hz - sn * px + c * sw2);
  sol.hips.rotation.set(roll * (1 - kw), sol.hyaw + tw * (1 - kw), hp);
  LO.hp = hp;
  LO.tw = tw * (1 - kw);
  LO.roll = roll * (1 - kw);
  LO.phase = cyc + PI / 2;
  LO.runK = rk;
  LO.gw = gw;
  return LO;
}

function solBones(sol: Sol): THREE.Object3D[] {
  const b: THREE.Object3D[] = [sol.hips, sol.spine, sol.chest, sol.neck, sol.head, sol.clR, sol.clL, sol.uaR, sol.uaL, sol.faR, sol.faL, sol.hdR, sol.hdL, sol.thR, sol.thL, sol.shR, sol.shL, sol.ftR, sol.ftL];
  if (sol.wpn) b.push(sol.wpn);
  return b;
}

/**
 * Death: knees buckle under the body's weight, then a gravity-accelerated
 * topple, impact bounce and lagging limbs that flop and settle; three
 * deterministic variations per soldier (face down, on the back, on the side),
 * blended in from the pose the soldier was in when hit.
 */
function deathPose(sol: Sol, d: number, crushed = false) {
  const bones = (sol.bl ??= solBones(sol));
  if (!sol.snap) {
    sol.snap = { q: bones.map((o) => o.quaternion.clone()), hp: sol.hips.position.clone(), wp: sol.wpn ? sol.wpn.position.clone() : null };
  }
  // run over: knocked flat at once, face down or on the back (the model squashes the body; see build())
  if (crushed) d *= 3.2;
  ragdoll(sol, d, crushed ? (sol.seed < 0.5 ? 0 : 1) : -1);
  const b = sstep(0, 0.18, d);
  if (b < 1) {
    const sn = sol.snap;
    for (let i = 0; i < bones.length && i < sn.q.length; i++) bones[i].quaternion.slerpQuaternions(sn.q[i], tmpQ2.copy(bones[i].quaternion), b);
    sol.hips.position.lerpVectors(sn.hp, tmpE.copy(sol.hips.position), b);
    if (sol.wpn && sn.wp) sol.wpn.position.lerpVectors(sn.wp, tmpE.copy(sol.wpn.position), b);
  }
}

/** Final lying leg pose per variant: L thigh, knee, ankle, abduction, then R. */
const LIE_LEGS = [
  [0.05, -0.35, -0.9, 0.06, 0.12, -0.7, -0.8, -0.3], // face down, right leg drawn out
  [0.3, -0.55, 0.25, 0.1, 0.06, -0.18, 0.15, -0.16], // on the back, left knee up a little
  [0.95, -1.25, 0.3, 0.05, 0.6, -0.9, 0.25, -0.05], // on the side, curled
];
/** Final arm pose per variant: R swing, abduction, flex, then L. */
const LIE_ARMS = [
  [2.5, 0.45, 0.35, -0.15, 0.3, 0.25],
  [0.25, 1.3, 0.5, 0.45, 0.9, 0.9],
  [0.95, 0.3, 1.05, 0.6, 0.2, 1.25],
];

function ragdoll(sol: Sol, d: number, force = -1) {
  const v = force >= 0 ? force : sol.seed < 0.4 ? 0 : sol.seed < 0.72 ? 1 : 2;
  const side = hashSeed(sol.sid * 13 + 5) > 0.5 ? 1 : -1;
  const j = hashSeed(sol.sid * 17 + 3);
  // phase 1: the knees give (free fall of the pelvis, eased in), phase 2: topple (accelerating), then impact
  const tb = 0.24 + 0.1 * j;
  const kb = clamp(d / tb, 0, 1);
  const kb2 = kb * kb;
  const t0 = tb * 0.55;
  const tt = 0.4 + 0.08 * j;
  const kt = clamp((d - t0) / tt, 0, 1);
  const kt2 = kt * kt;
  const imp = t0 + tt;
  const af = d - imp;
  const bounce = af > 0 ? Math.exp(-af * 8) * Math.sin(af * 19) : 0;
  const ktl = clamp((d - t0 - 0.08) / tt, 0, 1);
  const kl = ktl * ktl;
  const al = af - 0.08;
  const flop = al > 0 ? Math.exp(-al * 6.5) * Math.sin(al * 16) : 0;
  const c = Math.cos(sol.hyaw);
  const sn = Math.sin(sol.hyaw);

  // ---- pelvis (soldier frame)
  let hx = 0;
  let hy: number;
  let hz = 0;
  let rx = 0;
  let ry = 0;
  let rz: number;
  if (v === 0) {
    // face down: slump forward over the buckling knees, pitch onto the chest
    hy = mix(mix(0.97, 0.55, kb2), 0.15, kt2) + 0.03 * Math.max(0, bounce);
    hx = mix(0.05 * kb, 0.36, sstep(0, 1, kt));
    rz = mix(-0.4 * kb, -PI / 2 + 0.07, kt2) + 0.05 * bounce;
    rx = side * 0.12 * kt;
    ry = side * 0.22 * kt;
  } else if (v === 1) {
    // thrown back: sit down hard, then onto the back
    hy = mix(mix(0.97, 0.5, kb2), 0.14, kt2) + 0.03 * Math.max(0, bounce);
    hx = mix(-0.08 * kb, -0.32, sstep(0, 1, kt));
    rz = mix(0.12 * kb, PI / 2 - 0.08, kt2) - 0.05 * bounce;
    ry = side * 0.25 * kt;
  } else {
    // crumple: knees fold, twist and roll onto the side
    hy = mix(mix(0.97, 0.52, kb2), 0.17, kt2) + 0.025 * Math.max(0, bounce);
    hz = side * 0.24 * sstep(0, 1, kt);
    hx = -0.08 * kt;
    rx = side * mix(0.12 * kb, PI / 2 - 0.12, kt2) + side * 0.05 * bounce;
    rz = mix(-0.35 * kb, -0.3, kt);
    ry = side * 0.3 * kt;
  }
  sol.hips.position.set(sol.hx + c * hx + sn * hz, hy, sol.hz - sn * hx + c * hz);
  sol.hips.rotation.set(rx, sol.hyaw + ry, rz);

  // ---- legs: IK to the planted feet while the knees give, then the lying pose
  _pq3.setFromEuler(_pe3.set(rx, ry, rz, 'YXZ')).invert();
  for (let i = 0; i < 2; i++) {
    const sd = i === 0 ? -1 : 1;
    tmpA.set((i === 0 ? 0.04 : -0.03) - hx, ANK - hy, sd * 0.12 - hz).applyQuaternion(_pq3);
    legIK(i, sd, tmpA.x, tmpA.y, tmpA.z, 0, rz);
  }
  const lie = LIE_LEGS[v];
  const kL = sstep(0, 1, kt) * (1 - 0.15 * flop);
  for (let k = 0; k < 8; k++) _ang[k] = mix(_ang[k], lie[k], kL);
  sol.thL.rotation.set(_ang[3], 0, _ang[0]);
  sol.shL.rotation.set(0, 0, _ang[1] - 0.12 * flop);
  sol.ftL.rotation.set(0, 0, _ang[2]);
  sol.thR.rotation.set(_ang[7], 0, _ang[4]);
  sol.shR.rotation.set(0, 0, _ang[5] - 0.1 * flop);
  sol.ftR.rotation.set(0, 0, _ang[6]);

  // ---- torso and head (head lags, whips on impact, ends turned to the side)
  const slump = v === 0 ? -0.3 : v === 1 ? 0.15 : -0.35;
  sol.spine.rotation.set(0.06 * side * kt, 0.08 * side * kt, mix(slump * kb, v === 2 ? -0.25 : 0.04, kt));
  sol.chest.rotation.set(0.05 * side * kt, 0.1 * side * kt, mix(slump * 0.8 * kb, v === 2 ? -0.2 : 0.02, kt) - 0.12 * flop);
  sol.clR.rotation.set(0, 0, 0);
  sol.clL.rotation.set(0, 0, 0);
  sol.neck.rotation.set(0, side * 0.4 * kl, -0.25 * kb * (1 - kl));
  sol.head.rotation.set(side * 0.25 * kl, side * (v === 1 ? 0.5 : 0.75) * kl, (v === 0 ? 0.35 : v === 1 ? 0.15 : 0.1) * kl - 0.35 * kb * (1 - kl) + 0.45 * flop);
  // ---- arms: thrown up as the knees give, trail the body down, flop on impact
  const la = LIE_ARMS[v];
  const reach = kb * (1 - kl);
  freeArm(sol.uaR, sol.faR, 1, mix(0.15 + 0.7 * reach * (v === 1 ? 0.6 : 1), la[0], kl) + 0.4 * flop, mix(0.15 + 0.3 * reach, la[1], kl), mix(0.25 + 0.6 * reach, la[2], kl) + 0.3 * flop);
  freeArm(sol.uaL, sol.faL, -1, mix(0.1 + 0.5 * reach, la[3], kl) - 0.3 * flop, mix(0.15 + 0.4 * reach, la[4], kl), mix(0.3 + 0.5 * reach, la[5], kl) + 0.25 * flop);
  sol.hdR.rotation.set(0, 0, 0.35 * kl);
  sol.hdL.rotation.set(0, 0, 0.25 * kl);
  dropWeapon(sol, d, v === 1 || (v === 2 && side > 0));
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
    tmpD.set(back ? -0.11 : 0.12, 0.15 - CH, 0.46).sub(tmpA.copy(w.grip).applyQuaternion(tmpQ));
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
/** Deterministic hash of an integer to [0, 1) (death variation, idle phase, gestures). */
function hashSeed(n: number): number {
  let x = (n * 0x9e3779b1 + 0x7f4a7c15) | 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** (Re)derive every per-unit random from an integer source. */
function reseed(sol: Sol, n: number) {
  sol.sid = (n * 2 + sol.salt) | 0;
  sol.seed = hashSeed(sol.sid);
  sol.mag = 4 + Math.floor(hashSeed(sol.sid * 3 + 1) * 4);
  const role = sol.def.role;
  sol.crouch = hashSeed(sol.sid * 5 + 2) < (role === 'sniper' ? 1 : role === 'at' ? 0.75 : role === 'rifle' ? 0.4 : role === 'ew' ? 0.3 : 0);
}

function makeSol(def: SolDef, map: Map<string, THREE.Object3D>, salt: number): Sol {
  const g = (n: string) => map.get(def.p + n) as THREE.Bone;
  // hips: yaw outermost, so rotation.x is a body-local sideways roll (crumple death)
  g('hips').rotation.order = 'YXZ';
  const sol: Sol = {
    def,
    hips: g('hips'),
    spine: g('spine'),
    chest: g('chest'),
    neck: g('neck'),
    head: g('head'),
    clR: g('clR'),
    clL: g('clL'),
    uaR: g('uaR'),
    uaL: g('uaL'),
    faR: g('faR'),
    faL: g('faL'),
    hdR: g('hdR'),
    hdL: g('hdL'),
    thR: g('thR'),
    thL: g('thL'),
    shR: g('shR'),
    shL: g('shL'),
    ftR: g('ftR'),
    ftL: g('ftL'),
    wpn: (map.get(def.p + 'wpn') as THREE.Bone) ?? (map.get(def.p + 'bomb') as THREE.Bone) ?? null,
    round: (map.get(def.p + 'round') as THREE.Bone) ?? null,
    extra: (map.get(def.p + 'ant') as THREE.Bone) ?? (map.get(def.p + 'drone') as THREE.Bone) ?? null,
    seed: 0,
    sid: 0,
    seedSrc: NaN,
    salt,
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
    phase: 0,
    lastDist: 0,
    turnW: 0,
    accL: 0,
    lastV: 0,
    mpt: 1 / (S * 1.4),
    prevFired: Infinity,
    shots: 0,
    mag: 5,
    reload: -1,
    reloadW: 0,
    crouch: false,
    lookY: 0,
    lookP: 0,
    bl: null,
    thrW: 0,
    thrY: 0,
  };
  reseed(sol, 100000 + solSeq++);
  return sol;
}

/** Pick up the renderer's per-unit seed (entity id) once it is known. */
function seedFrom(sol: Sol, s: AnimState) {
  const n = s.seed;
  if (n !== undefined && n !== sol.seedSrc) {
    sol.seedSrc = n;
    reseed(sol, n);
    sol.phase = sol.seed;
  }
}

const RT = new THREE.Vector3();
const LT = new THREE.Vector3();
const GT = new THREE.Vector3();

/** One soldier (rifle / at / engineer / fpv / ew), blended into the parachute pose while under a canopy. */
function animSoldier(sol: Sol, s: AnimState) {
  seedFrom(sol, s);
  animSoldierBase(sol, s);
  const dig = s.dead > 0 ? 0 : (s.dig ?? 0);
  if (dig > 0 && dig < DIG_T) digPose(sol, dig);
  if (!(s.dead > 0) && (s.lod ?? 0) < 2) {
    // (additive on this frame's pose: skipped off screen, where the base pose isn't rebuilt)
    threatPose(sol, s);
    const dv = s.dive ?? 0;
    if (dv > 0) divePose(sol, dv);
  }
  const tgt = s.dead > 0 ? 0 : clamp(s.para ?? 0, 0, 1);
  const dt = Math.min(Math.max(s.dt, 0), 0.1);
  sol.paraW = dt === 0 && s.time === 0 ? tgt : approach(sol.paraW, tgt, dt, tgt > sol.paraW ? 20 : 5);
  if (sol.paraW > 0.002) paraPose(sol, sol.paraW, s.time + sol.seed * 40);
}

/** Head (and a little of the neck) turned towards a threat: a vehicle about to run him over (AnimState.look). */
function threatPose(sol: Sol, s: AnimState) {
  const dt = Math.min(Math.max(s.dt, 0), 0.1);
  const on = s.look !== undefined && Number.isFinite(s.look);
  sol.thrW = approach(sol.thrW, on ? 1 : 0, dt, on ? 14 : 5);
  if (on) sol.thrY = sol.thrW < 0.02 ? s.look! : approach(sol.thrY, s.look!, dt, 12);
  const k = sol.thrW;
  if (k < 0.002) return;
  const y = clamp(sol.thrY, -1.5, 1.5) * k;
  sol.neck.rotation.y += y * 0.4;
  sol.head.rotation.y += y * 0.6;
  sol.chest.rotation.y += y * 0.15;
}

/** Dive and roll timing (AnimState.dive seconds): launch, a log roll on the ground, back up. */
const DIVE_T = 1.2;

/**
 * Close call: the soldier throws himself flat out of a vehicle's path (his legs trail the pelvis),
 * rolls once over his shoulder on the ground with the weapon held to his chest, and pushes back up.
 * Applied on top of the run pose; blended in / out at both ends.
 */
function divePose(sol: Sol, t: number) {
  const k = sstep(0, 0.1, t) * (1 - sstep(DIVE_T - 0.4, DIVE_T, t));
  if (k <= 0.001) return;
  const fly = sstep(0, 0.28, t);
  const arc = Math.sin(PI * clamp(t / 0.3, 0, 1));
  const side = sol.seed < 0.5 ? 1 : -1;
  // one full roll about the body's long axis; a whole turn is the identity, so it ends seamlessly
  const roll = t < 0.74 ? 2 * PI * side * sstep(0.32, 0.74, t) : 0;
  const h = sol.hips;
  h.position.y = mix(h.position.y, mix(0.8, 0.17, fly) + 0.16 * arc, k);
  h.rotation.z = mix(h.rotation.z, -(PI / 2 - 0.15) * fly, k);
  h.rotation.x = mix(h.rotation.x, 0, k) + roll * k;
  // legs stretched out behind, a little apart; chest and head up to look where he lands
  const legs = k * fly;
  sol.thL.rotation.z = mix(sol.thL.rotation.z, 0.1, legs);
  sol.thR.rotation.z = mix(sol.thR.rotation.z, -0.05, legs);
  sol.thL.rotation.x = mix(sol.thL.rotation.x, 0.12, legs);
  sol.thR.rotation.x = mix(sol.thR.rotation.x, -0.12, legs);
  sol.shL.rotation.z = mix(sol.shL.rotation.z, -0.35, legs);
  sol.shR.rotation.z = mix(sol.shR.rotation.z, -0.2, legs);
  sol.spine.rotation.z += 0.25 * legs;
  sol.neck.rotation.z += 0.35 * legs;
  sol.head.rotation.z += 0.3 * legs;
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
  sol.spine.rotation.z += (-0.18 - 0.1 * c) * k;
  sol.chest.rotation.z += (-0.14 - 0.12 * c) * k;
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
  // hands (spine-frame numbers): raised by the chest -> down at the ground in front
  RT.set(mix(0.3, 0.52, c), mix(0.12, -0.3, c) - CH, 0.07);
  LT.set(mix(0.22, 0.42, c), mix(0.26, -0.1, c) - CH, -0.03);
  ik(sol, 1, RT, POLE_DIG);
  ik(sol, -1, LT, POLE_LC);
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
  blendBone(sol.clR, -0.18, 0, 0, k);
  blendBone(sol.clL, 0.18, 0, 0, k);
  blendBone(sol.uaR, -0.32, 0, 2.7, k);
  blendBone(sol.faR, 0, 0, 0.4, k);
  blendBone(sol.uaL, 0.32, 0, 2.7, k);
  blendBone(sol.faL, 0, 0, 0.4, k);
  blendBone(sol.spine, 0, 0, 0.05, k);
  blendBone(sol.chest, 0, 0, 0.03, k);
  blendBone(sol.neck, 0, 0, -0.12, k);
  blendBone(sol.head, 0, 0, -0.18, k);
  const w = sol.def.w;
  if (w && sol.wpn) {
    _wp.copy(sol.wpn.position);
    _wq.copy(sol.wpn.quaternion);
    placeWeapon(sol, w, 0.15, 0.22, 0.04, -1.3, 0.2, 0.25, 0);
    sol.wpn.position.lerp(_wp, 1 - k);
    sol.wpn.quaternion.slerp(_wq, 1 - k);
  }
}

/** Shot counting and the magazine-swap timer (purely visual). */
function trackShots(sol: Sol, s: AnimState, dt: number) {
  const f = s.fired;
  if (f < sol.prevFired - 1e-3 && f < 0.25) {
    // a new shot: abandon a reload in progress
    sol.reload = -1;
    sol.shots++;
  }
  sol.prevFired = f;
  if (sol.reload < 0 && sol.shots >= sol.mag && f > 0.1 && f < 0.25) {
    sol.reload = 0;
    sol.shots = 0;
  }
  if (sol.reload >= 0) {
    sol.reload += dt;
    if (sol.reload > RELOAD_T) sol.reload = -1;
  }
  const on = sol.reload >= 0 && sol.reload < RELOAD_T - 0.12;
  sol.reloadW = dt === 0 && s.time === 0 ? 0 : approach(sol.reloadW, on ? 1 : 0, dt, on ? 16 : 12);
}

/** Left hand path of the magazine swap (chest space): magwell -> pouch -> magwell -> charging handle -> handguard. */
function reloadHand(sol: Sol, r: number, out: THREE.Vector3) {
  const t = clamp(sol.reload < 0 ? RELOAD_T : sol.reload, 0, RELOAD_T) / RELOAD_T;
  const well = onWeapon(sol, 0.07, -0.07, -0.02, tmpC);
  if (t < 0.2) out.lerp(well, sstep(0, 0.2, t) * r);
  else if (t < 0.42) out.lerp(tmpD.copy(well).lerp(tmpE.set(0.2, 0.16 - CH, -0.05), sstep(0.2, 0.42, t)), r);
  else if (t < 0.62) out.lerp(tmpD.set(0.2, 0.16 - CH, -0.05).lerp(well, sstep(0.42, 0.62, t)), r);
  else if (t < 0.8) out.lerp(tmpD.copy(well).lerp(onWeapon(sol, 0.02, 0.08, -0.05, tmpE), sstep(0.62, 0.8, t)), r);
  else out.lerp(onWeapon(sol, 0.02, 0.08, -0.05, tmpE), (1 - sstep(0.8, 1, t)) * r);
}

function animSoldierBase(sol: Sol, s: AnimState) {
  const role = sol.def.role;
  const w = sol.def.w;
  const t = s.time + sol.seed * 40;
  const dt = Math.min(Math.max(s.dt, 0), 0.1);
  const init = dt === 0 && s.time === 0;
  if (s.dead > 0) {
    deathPose(sol, s.dead, !!s.crushed);
    if (sol.extra && role === 'fpv') sol.extra.scale.setScalar(1);
    return;
  }
  sol.snap = null;
  const lod = init ? 0 : (s.lod ?? 0);
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
  const holdAim = role === 'at' ? 3 : role === 'fpv' ? 5 : role === 'sniper' ? 2.6 : 1.4;
  // snipers: shouldered and kneeling for the whole lock-on (AnimState.aim), not just after a shot
  const aimT = s.fired < holdAim || (s.aim ?? 0) > 0 ? 1 : 0;
  sol.aimW = approach(sol.aimW, aimT, dt, role === 'at' ? 7 : 12);
  trackShots(sol, s, dt);
  const dig = (s.dig ?? 0) > 0;
  const kneelT = !moving && ((role === 'fpv' && aimT > 0) || dig || (sol.crouch && aimT > 0)) ? 1 : 0;
  sol.kneelW = approach(sol.kneelW, kneelT, dt, kneelT ? 6 : 4);
  if (init) {
    sol.moveW = moving ? 1 : 0;
    sol.aimW = aimT;
    sol.lastDist = s.dist;
  }
  if (lod >= 2) {
    // off screen / under fog: keep the clocks running, skip the posing
    const dd = s.dist - sol.lastDist;
    sol.lastDist = s.dist;
    if (dd > 0 && dd < 1) sol.phase += (dd * sol.mpt) / mix(WALK_C, RUN_C, sol.runW);
    return;
  }
  const L = legs(sol, s, t, dt, lod);
  const mw = sol.moveW;
  const aw = sol.aimW;
  const kw = sol.kneelW;
  const rw = w && w.kind === 'rifle' ? sol.reloadW : 0;
  // recoil: sharp kick on the shot, exponential recovery
  const f0 = s.fired;
  const kick = f0 >= 0 && f0 < 0.3 ? Math.exp(-f0 * (role === 'at' ? 11 : 24)) * Math.min(1, (f0 + 0.008) / 0.012) : 0;
  sol.kickW = kick;
  const br = Math.sin(t * (1.5 + 0.4 * sol.seed)); // breathing
  const still = (1 - mw) * (1 - aw);

  // ---- idle gestures (de-synchronised per unit)
  let gk = 0;
  let ge = 0;
  let gs = 0;
  if (lod === 0 && still > 0.02 && kw < 0.5) {
    const per = 6.5 + 5 * sol.seed;
    const tt = s.time + sol.seed * per * 3.1;
    const slot = Math.floor(tt / per);
    const tau = tt - slot * per;
    if (tau < GEST_T) {
      const hv = hashSeed(sol.sid * 31 + slot);
      gk = hv < 0.3 ? 0 : 1 + Math.floor(((hv - 0.3) / 0.7) * 4); // 1 helmet, 2 look back, 3 shoulder roll, 4 radio
      if ((gk === 1 || gk === 4) && !(w && (w.kind === 'rifle' || w.kind === 'launcher'))) gk = 3;
      ge = sstep(0, 0.35, tau) * (1 - sstep(GEST_T - 0.5, GEST_T, tau)) * still * (1 - kw) * (1 - rw);
      gs = tau / GEST_T;
      if (ge < 0.002) gk = 0;
    }
  }
  const backSide = hashSeed(sol.sid * 7 + 3) > 0.5 ? 1 : -1;
  const gBack = gk === 2 ? ge : 0;
  const gRoll = gk === 3 ? ge * Math.sin(gs * 2 * PI) : 0;

  // ---- spine / chest: lean (speed, aim, kneel, acceleration), counter-twist, breathing, flinch
  const lean = -0.04 - 0.14 * mw * (0.3 + 0.7 * L.runK) - 0.07 * aw - 0.1 * kw + 0.12 * fl - clamp(sol.accL * 0.012, -0.08, 0.1) * mw;
  // shoulders counter-rotate against the pelvis (less with a rifle in both hands, square to the target when aiming)
  const twistUp = -L.tw * mix(w ? 1.35 : 1.8, 1, aw) + 0.2 * fl * sol.flinchDir + 0.3 * gBack * backSide;
  sol.spine.rotation.set(-L.roll * 0.55 + 0.02 * Math.sin(t * 0.45 + sol.seed * 6) * (1 - mw) + 0.06 * fl * sol.flinchDir, twistUp * 0.4, lean * 0.45);
  const chestP = lean * 0.55 + 0.012 * br * (1 - mw) + kick * 0.05 * (role === 'at' ? 2 : 1);
  sol.chest.rotation.set(-L.roll * 0.3 + 0.04 * fl * sol.flinchDir + 0.04 * gRoll, twistUp * 0.6, chestP);
  // world pitch of the chest (soldier frame) and its yaw away from the soldier's heading
  const tot = L.hp + lean * 0.45 + chestP;
  const twistAll = L.tw + twistUp;

  // ---- clavicles: breathing, shouldering the weapon, recoil, shoulder roll
  const rifleAim = aw * (w && w.kind === 'rifle' ? 1 : 0);
  const shrug = 0.015 * br * (1 - mw) + 0.12 * gRoll;
  sol.clR.rotation.set(-shrug - 0.07 * rifleAim, 0.08 * rifleAim - 0.2 * kick * (w && w.kind !== 'controller' ? 1 : 0), 0);
  sol.clL.rotation.set(shrug + 0.03 * rifleAim, -0.06 * rifleAim, 0);

  // ---- head: eyes level, look-around when idle, into turns when moving, cheek on the stock when aiming
  let lookT = 0;
  let lookP = 0;
  if (lod === 0) {
    const lp = 2.1 + 1.9 * sol.seed;
    const ls = Math.floor((s.time + sol.seed * 17) / lp);
    const hv = hashSeed(sol.sid * 7 + ls * 3 + 1);
    lookT = (hv < 0.32 ? 0 : ((hv - 0.32) / 0.68) * 1.7 - 0.85) * (1 - mw);
    lookP = (hashSeed(sol.sid * 11 + ls * 5 + 2) - 0.55) * 0.3 * (1 - mw);
  } else lookT = Math.sin(t * 0.31) * Math.max(0, Math.sin(t * 0.13 + sol.seed * 9)) * 0.8 * (1 - mw);
  lookT = lookT * (1 - aw) + clamp(s.turn * 0.22, -0.5, 0.5) * mw + gBack * backSide * 1.1;
  sol.lookY = init ? lookT : approach(sol.lookY, lookT, dt, 4.5);
  sol.lookP = init ? lookP : approach(sol.lookP, lookP * (1 - aw), dt, 3);
  const headP = -tot * 0.85 - 0.12 * aw - 0.22 * rifleAim + sol.lookP + 0.025 * Math.sin(t * 0.7) * still + 0.1 * kick + (gk === 1 ? -0.18 * ge : 0) - 0.3 * rw;
  const headY = sol.lookY - twistAll + 0.2 * rw;
  const tilt = 0.16 * rifleAim + (gk === 4 ? -0.28 * ge : 0) + 0.12 * gRoll * backSide;
  sol.neck.rotation.set(tilt * 0.3, headY * 0.4, headP * 0.35);
  sol.head.rotation.set(tilt * 0.7, headY * 0.6, headP * 0.65);
  sol.hdR.rotation.set(0, 0, -0.2);
  sol.hdL.rotation.set(0.25, 0, -0.15);

  // ---- arms
  if (!w || !sol.wpn) {
    // engineer: tools in both hands, arms counter-swing to the legs
    const sw = Math.sin(L.phase) * mw;
    const amp = mix(0.35, 0.7, L.runK);
    freeArm(sol.uaR, sol.faR, 1, amp * sw * 0.8 + 0.08, 0.12, mix(0.35, 1.2, L.runK * mw));
    freeArm(sol.uaL, sol.faL, -1, -amp * sw * 0.6, 0.16, mix(0.15, 0.6, L.runK * mw));
    if (sol.extra) sol.extra.rotation.set(0, 0, 0);
    return;
  }
  const bob = Math.sin(L.phase * 2) * mw;
  // weapon sway: slow idle drift + breathing (much smaller while aiming), carried at port arms when running
  const swayP = (0.035 * Math.sin(t * 0.83 + sol.seed * 7) + 0.012 * br) * (1 - mw) * (1 - 0.8 * aw) + 0.006 * Math.sin(t * 2.3) * aw;
  const swayY = 0.04 * Math.sin(t * 0.57 + sol.seed * 3) * (1 - mw) * (1 - 0.85 * aw);
  const port = L.runK * mw * (1 - aw);
  // gestures with the rifle hand: the weapon dips onto its sling, the left hand goes up
  const lift = gk === 1 || gk === 4 ? ge : 0;
  const regrip = gRoll * 0.04;
  if (w.kind === 'rifle') {
    // low ready <-> shouldered aim
    const px = mix(0.1, 0.12, aw) + 0.04 * port - 0.03 * rw;
    const py = mix(0.29, 0.47, aw) + 0.012 * bob + 0.07 * port - 0.04 * lift + regrip + 0.04 * rw;
    const pz = mix(0.17, 0.12, aw) - 0.05 * port - 0.02 * rw;
    const pitch = mix(-0.55 + 0.1 * mw, -tot - 0.01, aw) + kick * 0.14 + swayP + 0.8 * port - 0.2 * lift + 0.35 * rw;
    const yaw = mix(0.5, 0.06 - twistAll, aw) + swayY + 0.2 * port + 0.15 * rw;
    const roll = mix(0.3, 0, aw) + 0.5 * rw;
    placeWeapon(sol, w, px, py, pz, pitch, yaw, roll, kick);
    handTargets(sol, w, RT, LT);
    if (rw > 0.002 && lod === 0) reloadHand(sol, rw, LT);
    if (role === 'sniper' && lod === 0 && f0 > 0.3 && f0 < 1.1) {
      // work the bolt: the right hand leaves the grip, up-back-forward-down on the bolt knob, then back
      const k = sstep(0.3, 0.45, f0) * (1 - sstep(0.95, 1.1, f0));
      const pull = sstep(0.5, 0.65, f0) * (1 - sstep(0.75, 0.9, f0));
      RT.lerp(onWeapon(sol, -0.035 - 0.07 * pull, 0.04, 0.085, tmpC), k);
    }
    ik(sol, 1, RT, POLE_R);
    if (lift > 0.002) gestureHand(gk, ge, gs, LT);
    ik(sol, -1, LT, POLE_L);
  } else if (w.kind === 'launcher') {
    const px = mix(0.02, 0.0, aw);
    const py = mix(0.43, 0.445, aw) + 0.01 * bob;
    const pz = mix(0.17, 0.155, aw);
    const pitch = mix(0.5 - 0.1 * mw, -tot + 0.04, aw) + kick * 0.18 + swayP * 0.6;
    const yaw = mix(0.06, 0.03 - twistAll, aw) + swayY * 0.5;
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
        tmpA.set(-0.15, 0.35 - CH, -0.22); // reach behind to the pack
        tmpB.set(0.72, 0.08, 0).applyQuaternion(sol.wpn.quaternion).add(sol.wpn.position); // in front of the tube
        tmpA.lerp(tmpB, toMuzzle);
        LT.lerp(tmpA, k);
      }
    }
    ik(sol, 1, RT, POLE_R);
    if (lift > 0.002) gestureHand(gk, ge, gs, LT);
    ik(sol, -1, LT, POLE_L);
    // on the move the tube rides on the shoulder, the free left arm swings
    const free = mw * (1 - aw) * (s.fired > 1.8 ? 1 : 0);
    if (free > 0.002) {
      _dq[2].copy(sol.uaL.quaternion);
      _dq[3].copy(sol.faL.quaternion);
      freeArm(sol.uaL, sol.faL, -1, -mix(0.35, 0.6, L.runK) * Math.sin(L.phase), 0.14, mix(0.3, 1.1, L.runK));
      blendFrom(sol.uaL, _dq[2], free);
      blendFrom(sol.faL, _dq[3], free);
    }
  } else {
    // FPV controller: chest height, raised when flying a drone
    const px = mix(0.3, 0.33, aw);
    const py = mix(0.15, 0.27, aw) + 0.01 * bob;
    const pitch = mix(-0.55, -0.25, aw) - tot * aw;
    placeWeapon(sol, w, px, py, 0, pitch, -twistAll * 0.5, 0, 0);
    handTargets(sol, w, RT, LT);
    ik(sol, 1, RT, POLE_RC);
    ik(sol, -1, LT, POLE_LC);
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

/** Idle gesture targets for the left hand (chest space): 1 = straighten the helmet, 4 = key the radio. */
function gestureHand(gk: number, ge: number, gs: number, out: THREE.Vector3) {
  if (gk === 1) {
    // up to the helmet brim, a little tug side to side
    const wig = Math.sin(gs * PI * 5) * 0.02 * sstep(0.25, 0.4, gs);
    GT.set(0.13, NECK_Y + HEAD_Y + 0.12, -0.07 + wig);
  } else {
    // radio / shoulder mic on the left strap
    GT.set(0.13, 0.17, -0.12);
  }
  out.lerp(GT, ge);
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

/** Body-space point -> soldier chest space (uses local matrices; no world update needed). */
function bodyToSpine(sol: Sol, p: THREE.Vector3, out: THREE.Vector3) {
  sol.hips.updateMatrix();
  sol.spine.updateMatrix();
  sol.chest.updateMatrix();
  tmpM2.multiplyMatrices(sol.hips.matrix, sol.spine.matrix).multiply(sol.chest.matrix).invert();
  return out.copy(p).applyMatrix4(tmpM2);
}
function bodyQuatToSpine(sol: Sol, q: THREE.Quaternion, out: THREE.Quaternion) {
  tmpQ2.copy(sol.hips.quaternion).multiply(sol.spine.quaternion).multiply(sol.chest.quaternion).invert();
  return out.copy(tmpQ2).multiply(q);
}
const M_CHEST = new THREE.Vector3(0.3, 0.2 - CH, 0);
const M_BAG = new THREE.Vector3(-0.12, 0.12 - CH, -0.3);
const _mPos = new THREE.Vector3();
const _mRot = new THREE.Quaternion();
const _mReady = new THREE.Vector3();
const _mMouth = new THREE.Vector3();
const _mTubeQ = new THREE.Quaternion();

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
  g.moveW = approach(g.moveW, moving ? 1 : 0, dt, 6);
  l.moveW = approach(l.moveW, moving ? 1 : 0, dt, 6);
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
  g.kneelW = l.kneelW = 1 - mw;
  seedFrom(g, s);
  seedFrom(l, s);
  const f = s.fired;
  const tubeKick = f < 0.12 ? (1 - f / 0.12) * 0.05 : 0;
  if (!packed) m.tube.position.set(M_TUBE0[0] - TUBE_DIR.x * tubeKick, M_TUBE0[1] - TUBE_DIR.y * tubeKick, 0);

  // ---- gunner
  if (!(s.dead > 0)) g.snap = l.snap = null;
  if (s.dead > 0) deathPose(g, s.dead + 0.05, !!s.crushed);
  else {
    const t = s.time + g.seed * 40;
    const L = legs(g, s, t, dt, 0);
    const flinch = f < 0.6 ? Math.sin((f / 0.6) * PI) : 0;
    const lean = mix(-0.32, -0.12 * (0.4 + 0.6 * L.runK), mw);
    g.spine.rotation.set(0.12 * flinch * (1 - mw), 0.25 * (1 - mw) - L.tw * 0.5, lean + 0.12 * flinch * (1 - mw));
    g.chest.rotation.set(0, -L.tw * 0.7, 0.012 * Math.sin(t * 1.7));
    g.clR.rotation.set(0, 0, 0);
    g.clL.rotation.set(0, 0, 0);
    g.neck.rotation.set(0, 0, 0);
    g.head.rotation.set(0, mix(-0.3 + 0.5 * flinch, 0, mw), -(L.hp + lean) * 0.7 - 0.15 * (1 - mw));
    if (packed) {
      // arms counter-swing to the legs
      const sw = Math.sin(L.phase);
      freeArm(g.uaR, g.faR, 1, 0.5 * sw, 0.15, mix(0.3, 1.1, L.runK));
      freeArm(g.uaL, g.faL, -1, -0.5 * sw, 0.15, mix(0.3, 1.1, L.runK));
    } else {
      // hands on the tube and the elevation crank (crank turns while idle)
      const crank = Math.sin(t * 0.6) > 0.6 ? t * 5 : 0;
      tmpA.copy(G_HOLD_L);
      tmpB.copy(G_HOLD_R).add(_v.set(0, Math.sin(crank) * 0.03, Math.cos(crank) * 0.03));
      bodyToSpine(g, tmpA, LT);
      bodyToSpine(g, tmpB, RT);
      ik(g, 1, RT, POLE_R);
      ik(g, -1, LT, POLE_L);
    }
  }

  // ---- loader
  if (s.dead > 0) {
    deathPose(l, s.dead, !!s.crushed);
    m.bomb.scale.setScalar(1e-3);
    return;
  }
  const t = s.time + l.seed * 40;
  const L = legs(l, s, t, dt, 0);
  l.chest.rotation.set(0, -L.tw * 0.7, 0.012 * Math.sin(t * 1.7));
  l.clR.rotation.set(0, 0, 0);
  l.clL.rotation.set(0, 0, 0);
  l.neck.rotation.set(0, 0, 0);
  let lean = mix(-0.25, -0.12 * (0.4 + 0.6 * L.runK), mw);
  let twist = 0;
  // bomb pose (spine space) keyframes
  const chestP = M_CHEST;
  const chestQ = UP_Q;
  let bombVisible = true;
  const pos = _mPos.copy(chestP);
  const rot = _mRot.copy(chestQ);
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
    // ready / drop poses from the tube (body space -> chest)
    const readyP = bodyToSpine(l, tmpA.copy(MOUTH).addScaledVector(TUBE_DIR, 0.2), _mReady);
    const tubeQ = bodyQuatToSpine(l, TUBE_Q, _mTubeQ);
    const bagP = M_BAG;
    if (!ready) {
      // idle: cradle the round at the chest
    } else if (f < 0.15) {
      const k = f / 0.15;
      pos.copy(readyP).addScaledVector(bodyToSpine(l, tmpB.copy(MOUTH), _mMouth).sub(readyP), 1 + k * 1.2);
      rot.copy(tubeQ);
      bombVisible = k < 0.6;
    } else if (f < 0.6) {
      bombVisible = false;
      pos.copy(readyP).lerp(chestP, sstep(0.15, 0.6, f));
      rot.copy(tubeQ);
    } else if (f < 1.2) {
      const k = sstep(0.6, 0.9, f);
      pos.copy(chestP).lerp(bagP, k * (1 - sstep(0.95, 1.2, f)));
      bombVisible = f > 0.85;
      rot.copy(chestQ);
    } else {
      const k = sstep(1.2, 1.7, f);
      pos.copy(chestP).lerp(readyP, k);
      rot.copy(chestQ).slerp(tubeQ, k);
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
  ik(l, 1, RT, POLE_RC);
  ik(l, -1, LT, POLE_LC);
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
      const sols = t.sols.map((d, i) => makeSol(d, inst.map, i));
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
            // stride length is matched in model metres: follow the renderer's unit scale
            const mpt = 1 / (S * (root.scale.x || 1));
            for (const sol of sols) sol.mpt = mpt;
            anim(s);
            // run over: the body is pressed flat into the ground (and the template scale restored otherwise)
            const sq = s.dead > 0 && s.crushed ? sstep(0.06, 0.24, s.dead) : 0;
            if (sq > 0 || inst.top.scale.y !== S) inst.top.scale.set(S * (1 + 0.2 * sq), S * (1 - 0.75 * sq), S * (1 + 0.2 * sq));
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
  sniper: build('sniper'),
};
