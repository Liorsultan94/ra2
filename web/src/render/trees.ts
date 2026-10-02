import * as THREE from 'three';
import type { GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { CulledInstances, type Inst, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { TCell, tcell, treeAtlas } from './treeatlas';
import { Species, windTime, type TreeSpot } from './vegetation';

/*
 * Trees: eight species for a temperate river valley (oak, birch, Lombardy
 * poplar, weeping willow, orchard fruit trees, saplings, Norway spruce and
 * Scots pine), each built from a trunk, limbs and leaf-card clusters arranged
 * in lumpy sub-crowns. One alpha-tested material for all of them:
 *  - leaves: procedural leaf-card atlas (treeatlas.ts), canopy-shaped normals
 *    blended with the sub-crown lumps, vertex AO darker inside / under the crown;
 *  - lighting: wrap diffuse plus a back-lit translucency glow (the sun shining
 *    through the leaves, shadow-aware), a soft specular sheen;
 *  - wind: whole-tree bend + sway along the breeze, leaf flutter; it strengthens
 *    with the weather's wind (Atmosphere speeds up the foliage clock in a storm,
 *    the rate of that speed-up is read back here);
 *  - shadows: an alpha-tested depth material with the same wind, so the dappled
 *    shadows move with the leaves;
 *  - per-instance colour tints the leaves only (bark keeps its colour, but still
 *    darkens when envdamage.ts chars a tree);
 *  - LOD: a light model per species (a few big "mass" cards) for far zooms,
 *    swapped by SceneryLod; one CulledInstances (one draw call) per species.
 */

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ wind

/** x/y: world wind direction (x, z), z: strength (0.3 calm .. ~1.2 storm). */
export const treeWind = { value: new THREE.Vector3(Math.cos(-0.55), Math.sin(-0.55), 0.32) };
let wLast = -1;
let wExtra = 0;
let wK = 0.32;

/**
 * Per frame (first tree drawn): the weather wind. Atmosphere advances the
 * foliage clock (windTime) faster than the scene clock (fogTime) in strong
 * wind (rate = 1.8 * (wind - 0.2)), so the gap's growth rate gives the wind.
 */
function updateWind(fogTime: number) {
  if (fogTime === wLast) return;
  const extra = windTime.value - fogTime;
  if (wLast >= 0) {
    const dt = fogTime - wLast;
    if (dt > 1e-4 && dt < 0.5) {
      const rate = Math.max(0, (extra - wExtra) / dt);
      const target = Math.min(1.25, 0.32 + (rate / 1.8) * 1.1);
      wK += (target - wK) * Math.min(1, dt * 0.7);
    }
  }
  wLast = fogTime;
  wExtra = extra;
  const a = -0.55 + 0.35 * Math.sin(fogTime * 0.013);
  treeWind.value.set(Math.cos(a), Math.sin(a), wK);
}

const WIND_VERT = /* glsl */ `
{
  #ifdef USE_INSTANCING
    vec3 wo = instanceMatrix[3].xyz;
    vec3 tax = instanceMatrix[0].xyz;
    vec3 taz = instanceMatrix[2].xyz;
    // toppled trees (envdamage.ts) lie still
    float tup = clamp( instanceMatrix[1].y / max( 1e-4, length( instanceMatrix[1].xyz ) ), 0.0, 1.0 );
  #else
    float tup = 1.0;
    vec3 wo = vec3( 0.0 );
    vec3 tax = vec3( 1.0, 0.0, 0.0 );
    vec3 taz = vec3( 0.0, 0.0, 1.0 );
  #endif
  vec3 twd = vec3( treeWind.x, 0.0, treeWind.y );
  // the world wind direction in the tree's own (rotated, scaled) frame
  vec2 tld = vec2( dot( tax, twd ) / dot( tax, tax ), dot( taz, twd ) / dot( taz, taz ) );
  float tst = treeWind.z * tup * tup;
  float tph = windTime * 0.8 + wo.x * 0.21 + wo.z * 0.17;
  float gust = 0.5 + 0.5 * sin( tph ) * sin( tph * 0.37 + 1.7 );
  float osc = sin( windTime * ( 1.6 + tst * 0.8 ) + wo.x * 1.3 + wo.z * 0.9 ) * ( 0.2 + 0.25 * gust );
  float bend = tst * ( 0.3 + gust * 0.8 + osc ) * flex;
  transformed.xz += tld * bend;
  transformed.y -= bend * bend * 2.0;
  // leaf flutter (stronger in wind, per card phase)
  float fp = dot( position, vec3( 17.3, 11.1, 13.7 ) ) + wo.x * 3.1 + wo.z * 1.7;
  vec3 fl = vec3( sin( windTime * 6.3 + fp ), sin( windTime * 7.9 + fp * 1.3 ), cos( windTime * 5.7 + fp * 0.7 ) );
  transformed += fl * leaf * ( 0.0035 + 0.011 * tst * ( 0.5 + gust ) );
}
`;

/** Keep alpha-tested leaves from thinning out in the smaller mipmaps (far trees stay dense). */
const ALPHA_MIP = (px: number) => /* glsl */ `
#ifdef USE_MAP
{
  vec2 tdx = dFdx( vMapUv * ${px.toFixed(1)} );
  vec2 tdy = dFdy( vMapUv * ${px.toFixed(1)} );
  float tmip = max( 0.0, 0.5 * log2( max( dot( tdx, tdx ), dot( tdy, tdy ) ) ) );
  diffuseColor.a *= 1.0 + tmip * 0.28;
}
#endif
`;

/** Leaves: wrap lighting and sun-through-the-leaves translucency (shadowed light only). */
const FOLIAGE_LIGHT = /* glsl */ `
#undef RE_Direct
void RE_Direct_Foliage( const in IncidentLight directLight, const in vec3 geometryPosition, const in vec3 geometryNormal, const in vec3 geometryViewDir, const in vec3 geometryClearcoatNormal, const in PhysicalMaterial material, inout ReflectedLight reflectedLight ) {
  RE_Direct_Physical( directLight, geometryPosition, geometryNormal, geometryViewDir, geometryClearcoatNormal, material, reflectedLight );
  float tnl = dot( geometryNormal, directLight.direction );
  float twrap = clamp( ( tnl + 0.55 ) / 1.55, 0.0, 1.0 ) - clamp( tnl, 0.0, 1.0 );
  float tback = pow( clamp( dot( -geometryViewDir, directLight.direction ), 0.0, 1.0 ), 3.0 );
  float tthru = clamp( -tnl, 0.0, 1.0 );
  vec3 tglow = directLight.color * BRDF_Lambert( material.diffuseColor ) * vec3( 1.05, 1.1, 0.75 );
  reflectedLight.directDiffuse += tglow * ( twrap * 0.55 * fLeafAmt + fTransl * ( tback * 1.15 + tthru * 0.4 ) );
}
#define RE_Direct RE_Direct_Foliage
`;

export interface TreeMaterials {
  mat: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
}

const matCache = new WeakMap<FogOfWar, TreeMaterials>();

/** The shared tree material + its shadow depth material (one per fog-of-war instance). */
export function treeMaterials(fog: FogOfWar, quality: 'low' | 'medium' | 'high'): TreeMaterials {
  const hit = matCache.get(fog);
  if (hit) return hit;
  const cellPx = quality === 'low' ? 128 : 256;
  const atlas = treeAtlas(cellPx);
  const px = cellPx * 4;
  const mat = new THREE.MeshStandardMaterial({
    map: atlas,
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.74,
    metalness: 0,
    alphaToCoverage: quality !== 'low',
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windTime;
    shader.uniforms.treeWind = treeWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;\nuniform vec3 treeWind;\nattribute float flex;\nattribute float leaf;\nvarying float vLeaf;')
      .replace(
        '#include <color_vertex>',
        `vColor = vec4( 1.0 );
        #ifdef USE_COLOR
          vColor.rgb *= color.rgb;
        #endif
        #ifdef USE_INSTANCING_COLOR
          // the instance colour is the leaf tint (stored at half strength); bark only takes its brightness (charring)
          float tlum = dot( instanceColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
          vColor.rgb *= mix( vec3( clamp( tlum * 6.5, 0.0, 1.0 ) ), instanceColor.rgb * 2.0, clamp( leaf, 0.0, 1.0 ) );
        #endif
        vLeaf = leaf;`,
      )
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERT}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vLeaf;\nfloat fTransl = 0.0;\nfloat fLeafAmt = 0.0;')
      .replace('#include <map_fragment>', `#include <map_fragment>\n${ALPHA_MIP(px)}`)
      .replace('#include <lights_physical_pars_fragment>', `#include <lights_physical_pars_fragment>\n${FOLIAGE_LIGHT}`)
      // keep the authored (canopy-shaped) normals on both faces of the cards
      .replace(
        '#include <normal_fragment_begin>',
        `#include <normal_fragment_begin>
        #ifndef FLAT_SHADED
          normal = normalize( vNormal );
        #endif
        fLeafAmt = clamp( vLeaf, 0.0, 1.0 );
        // thin outer leaves pass more light than the dark inside of the crown
        fTransl = fLeafAmt * smoothstep( 0.25, 0.9, dot( vColor.rgb, vec3( 0.33 ) ) );`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'trees-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.42, side: THREE.DoubleSide });
  depth.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windTime;
    shader.uniforms.treeWind = treeWind;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;\nuniform vec3 treeWind;\nattribute float flex;\nattribute float leaf;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${WIND_VERT}`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>\n${ALPHA_MIP(px)}`);
  };
  depth.customProgramCacheKey = () => 'trees-depth-v1';
  const out = { mat, depth };
  matCache.set(fog, out);
  return out;
}

// -------------------------------------------------------------- builder

class TreeBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  flex: number[] = [];
  leaf: number[] = [];
  idx: number[] = [];

  constructor(
    /** Wind bend at the top of the tree (local units at full strength). */
    readonly flexK: number,
    /** Tree height (for the bend profile). */
    readonly H: number,
  ) {}

  get count() {
    return this.pos.length / 3;
  }

  bendAt(p: THREE.Vector3) {
    const t = Math.max(0, p.y / this.H);
    return this.flexK * t * t;
  }

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: [number, number, number], leaf: number, flexMul = 1) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    this.col.push(c[0], c[1], c[2]);
    this.flex.push(this.bendAt(p) * flexMul);
    this.leaf.push(leaf);
    return this.count - 1;
  }

  quad(a: number, b: number, c: number, d: number) {
    // a b / c d
    this.idx.push(a, c, b, b, c, d);
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('flex', new THREE.Float32BufferAttribute(this.flex, 1));
    g.setAttribute('leaf', new THREE.Float32BufferAttribute(this.leaf, 1));
    g.setIndex(this.idx);
    g.computeBoundingSphere();
    return g;
  }

  /** Tapered tube along a polyline (trunk / limb), bark-textured. */
  tube(pts: THREE.Vector3[], radii: number[], sides: number, cell: TCell, shade: (p: THREE.Vector3) => number) {
    const [u0, v0, u1, v1] = tcell(cell);
    const rings: number[][] = [];
    const e1 = new THREE.Vector3();
    const e2 = new THREE.Vector3();
    let len = 0;
    const total = pts.reduce((s, p, i) => (i ? s + p.distanceTo(pts[i - 1]) : 0), 0) || 1;
    for (let i = 0; i < pts.length; i++) {
      const d = (i < pts.length - 1 ? pts[i + 1].clone().sub(pts[i]) : pts[i].clone().sub(pts[i - 1])).normalize();
      e1.crossVectors(d, Math.abs(d.y) < 0.95 ? UP : V(1, 0, 0)).normalize();
      e2.crossVectors(d, e1).normalize();
      if (i) len += pts[i].distanceTo(pts[i - 1]);
      const ring: number[] = [];
      for (let k = 0; k <= sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        const n = e1.clone().multiplyScalar(Math.cos(a)).addScaledVector(e2, Math.sin(a));
        const p = pts[i].clone().addScaledVector(n, radii[i]);
        const s = shade(p);
        ring.push(this.vert(p, n, u0 + (u1 - u0) * (k / sides), v0 + (v1 - v0) * (len / total), [s, s * 0.97, s * 0.94], 0));
      }
      rings.push(ring);
    }
    for (let i = 0; i < rings.length - 1; i++)
      for (let k = 0; k < sides; k++) this.quad(rings[i + 1][k], rings[i + 1][k + 1], rings[i][k], rings[i][k + 1]);
  }

  /**
   * A leaf card centred at `c`, facing `facing`, its top towards `upHint`.
   * `light(p)` gives normal and AO colour per corner.
   */
  card(c: THREE.Vector3, facing: THREE.Vector3, upHint: THREE.Vector3, w: number, h: number, cell: TCell, light: (p: THREE.Vector3) => { n: THREE.Vector3; c: [number, number, number] }, leaf = 1, flexMul = 1, flipU = false) {
    const [u0, v0, u1, v1] = tcell(cell);
    const f = facing.clone().normalize();
    let right = new THREE.Vector3().crossVectors(upHint, f);
    if (right.lengthSq() < 1e-6) right = new THREE.Vector3().crossVectors(V(1, 0, 0), f);
    right.normalize();
    const up = new THREE.Vector3().crossVectors(f, right).normalize();
    const corners = [
      c.clone().addScaledVector(right, -w / 2).addScaledVector(up, h / 2),
      c.clone().addScaledVector(right, w / 2).addScaledVector(up, h / 2),
      c.clone().addScaledVector(right, -w / 2).addScaledVector(up, -h / 2),
      c.clone().addScaledVector(right, w / 2).addScaledVector(up, -h / 2),
    ];
    const ids = corners.map((p, k) => {
      const L = light(p);
      const left = k % 2 === 0;
      return this.vert(p, L.n, left !== flipU ? u0 : u1, k < 2 ? v1 : v0, L.c, leaf, flexMul);
    });
    this.quad(ids[0], ids[1], ids[2], ids[3]);
  }

  /** A card spanning from `a` (u0 edge) to `b` (u1 edge), `w` wide across `side`; used for conifer branches and vertical spires. */
  strip(a: THREE.Vector3, b: THREE.Vector3, side: THREE.Vector3, wa: number, wb: number, cell: TCell, light: (p: THREE.Vector3) => { n: THREE.Vector3; c: [number, number, number] }, uA = 0, uB = 1) {
    const [u0, v0, u1, v1] = tcell(cell);
    const ua = u0 + (u1 - u0) * uA;
    const ub = u0 + (u1 - u0) * uB;
    const s = side.clone().normalize();
    const P = [a.clone().addScaledVector(s, wa / 2), b.clone().addScaledVector(s, wb / 2), a.clone().addScaledVector(s, -wa / 2), b.clone().addScaledVector(s, -wb / 2)];
    const UV = [
      [ua, v1],
      [ub, v1],
      [ua, v0],
      [ub, v0],
    ];
    const ids = P.map((p, k) => {
      const L = light(p);
      return this.vert(p, L.n, UV[k][0], UV[k][1], L.c, 1);
    });
    this.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

// ----------------------------------------------------------- broadleaves

interface BroadSpec {
  seed: number;
  /** Trunk height (where the limbs start) and base radius. */
  trunkH: number;
  r0: number;
  lean: number;
  stems?: number;
  crownC: THREE.Vector3;
  crownR: THREE.Vector3;
  /** Sub-crown lumps (at the limb ends), their radius as a fraction of the crown. */
  lumps: number;
  lumpR: number;
  perLump: number;
  shell: number;
  inner: number;
  size: number;
  cell: TCell;
  bark: TCell;
  flexK: number;
  /** Cards stand upright (poplar), or hang (willow curtains). */
  upright?: boolean;
  curtains?: number;
  /** AO strength (0 = none). */
  ao?: number;
}

function rngOf(seed: number) {
  let k = 0;
  return () => hash2(seed, k++, 977);
}

function broadleaf(sp: BroadSpec, lite: boolean): THREE.BufferGeometry {
  const H = sp.crownC.y + sp.crownR.y;
  const b = new TreeBuilder(sp.flexK, H);
  const rnd = rngOf(sp.seed);
  const C = sp.crownC;
  const Rr = sp.crownR;
  const aoK = sp.ao ?? 1;
  const lumpRad = sp.lumpR * ((Rr.x + Rr.y + Rr.z) / 3);
  const lumps: THREE.Vector3[] = [];
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < sp.lumps; i++) {
    const a = i * golden + sp.seed;
    const el = sp.lumps === 1 ? 0.5 : -0.25 + (i / (sp.lumps - 1)) * 1.05;
    const ce = Math.cos(el);
    lumps.push(V(Math.cos(a) * ce * Rr.x * 0.62, Math.sin(el) * Rr.y * 0.6, Math.sin(a) * ce * Rr.z * 0.62).add(C));
  }
  /** Lighting of a crown point: normal blended from crown and lump, AO from depth / height. */
  const light = (lump: THREE.Vector3 | null) => (p: THREE.Vector3) => {
    const q = p.clone().sub(C).divide(Rr);
    const d = q.length();
    const n = q.clone().normalize();
    if (lump) n.multiplyScalar(0.55).add(p.clone().sub(lump).normalize().multiplyScalar(0.45));
    n.addScaledVector(UP, 0.22).normalize();
    const h = clamp01((p.y - (C.y - Rr.y)) / (2 * Rr.y));
    let ao = 0.42 + 0.58 * sstep(0.2, 1.0, d);
    ao *= 0.74 + 0.26 * h;
    ao = 1 - (1 - ao) * aoK;
    const top = clamp01(n.y);
    return { n, c: [ao * (1 + 0.05 * top), ao, ao * (0.93 - 0.05 * top)] as [number, number, number] };
  };
  const barkShade = (p: THREE.Vector3) => {
    const inCrown = sstep(C.y - Rr.y * 0.9, C.y, p.y);
    return (0.62 + 0.38 * clamp01(p.y / Math.max(0.2, sp.trunkH))) * (1 - 0.3 * inCrown);
  };

  // ---- trunk(s) and limbs
  const stems = sp.stems ?? 1;
  const tops: THREE.Vector3[] = [];
  for (let s = 0; s < stems; s++) {
    const a = rnd() * Math.PI * 2;
    const lean = sp.lean * (stems > 1 ? 1.6 : 1) * (0.5 + rnd() * 0.5);
    const off = stems > 1 ? V(Math.cos(a + 1) * sp.r0 * 0.8, 0, Math.sin(a + 1) * sp.r0 * 0.8) : V(0, 0, 0);
    const topY = stems > 1 || sp.upright ? Math.min(H * 0.92, C.y + Rr.y * 0.55) : sp.trunkH;
    const top = V(Math.cos(a) * lean, topY, Math.sin(a) * lean).add(off);
    const mid = off.clone().lerp(top, 0.5).add(V((rnd() - 0.5) * sp.r0, 0, (rnd() - 0.5) * sp.r0));
    const sides = lite ? 3 : 6;
    const r = stems > 1 ? sp.r0 * 0.72 : sp.r0;
    b.tube(lite ? [off, top] : [off, mid, top], lite ? [r, r * 0.45] : [r, r * 0.78, r * 0.5], sides, sp.bark, barkShade);
    tops.push(top);
  }
  if (!lite || sp.lumps <= 3)
    lumps.forEach((L, i) => {
      if (lite && i > 1) return;
      const from = tops[i % tops.length].clone().lerp(V(0, sp.trunkH * 0.85, 0), sp.upright ? 0.6 : 0.2);
      const end = L.clone().lerp(C, 0.15);
      const mid = from.clone().lerp(end, 0.5).add(V(0, 0.04, 0));
      b.tube([from, mid, end], [sp.r0 * 0.5, sp.r0 * 0.32, sp.r0 * 0.12], lite ? 3 : 4, sp.bark, (p) => barkShade(p) * 0.85);
    });

  // ---- leaf clusters
  const cluster = (centre: THREE.Vector3, out: THREE.Vector3, sz: number, lump: THREE.Vector3 | null, cell: TCell) => {
    // per-cluster brightness / hue jitter breaks up the crown surface
    const jb = 0.84 + rnd() * 0.3;
    const jy = (rnd() - 0.5) * 0.08;
    const L0 = light(lump);
    const L = (p: THREE.Vector3) => {
      const r = L0(p);
      r.c = [r.c[0] * jb * (1 + jy), r.c[1] * jb, r.c[2] * jb * (1 - jy)];
      return r;
    };
    const jitter = V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).multiplyScalar(0.7);
    const f1 = out.clone().add(jitter).normalize();
    const roll = V(rnd() - 0.5, rnd() - 0.5, rnd() - 0.5).normalize();
    const upHint = sp.upright ? UP : roll;
    if (lite) {
      b.card(centre, f1, upHint, sz, sz, cell, L);
      return;
    }
    b.card(centre, f1, upHint, sz, sz, cell, L, 1, 1, rnd() < 0.5);
    const f2 = new THREE.Vector3().crossVectors(f1, sp.upright ? UP : roll).normalize();
    b.card(centre.clone().addScaledVector(f1, -sz * 0.12), f2, sp.upright ? UP : f1, sz * 0.92, sz * 0.92, cell, L, 1, 1, rnd() < 0.5);
  };
  const leafCell = lite ? TCell.Mass : sp.cell;
  const szK = lite ? 1.75 : 1;
  for (const Lc of lumps) {
    const n = lite ? Math.max(2, Math.round(sp.perLump * 0.4)) : sp.perLump;
    const outward = Lc.clone().sub(C).divide(Rr).normalize();
    for (let i = 0; i < n; i++) {
      const yy = 1 - ((i + 0.5) / n) * 1.6;
      const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
      const th = i * golden + rnd();
      const dir = V(Math.cos(th) * rr, yy, Math.sin(th) * rr);
      if (dir.dot(outward) < -0.35) dir.addScaledVector(outward, 0.9).normalize();
      const p = Lc.clone().addScaledVector(dir, lumpRad * (0.7 + rnd() * 0.25));
      cluster(p, dir.clone().multiplyScalar(0.6).add(p.clone().sub(C).divide(Rr).normalize()), sp.size * szK * (0.85 + rnd() * 0.3), Lc, leafCell);
    }
  }
  const shell = lite ? Math.round(sp.shell * 0.45) : sp.shell;
  for (let i = 0; i < shell; i++) {
    const yy = 1 - ((i + 0.5) / shell) * 1.7;
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    const th = i * golden + sp.seed * 2.1;
    const dir = V(Math.cos(th) * rr, yy, Math.sin(th) * rr);
    const p = V(dir.x * Rr.x, dir.y * Rr.y, dir.z * Rr.z).multiplyScalar(0.84 + rnd() * 0.12).add(C);
    cluster(p, dir, sp.size * szK * (0.8 + rnd() * 0.3), null, leafCell);
  }
  if (!lite)
    for (let i = 0; i < sp.inner; i++) {
      const dir = V(rnd() - 0.5, rnd() * 0.6 - 0.1, rnd() - 0.5).normalize();
      const p = V(dir.x * Rr.x, dir.y * Rr.y, dir.z * Rr.z).multiplyScalar(0.45).add(C);
      cluster(p, dir, sp.size * 1.15, null, sp.cell);
    }
  // ---- weeping curtains (willow)
  if (sp.curtains) {
    const n = lite ? Math.ceil(sp.curtains * 0.5) : sp.curtains;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rnd() * 0.4;
      const rad = 0.82 + rnd() * 0.15;
      const top = V(Math.cos(a) * Rr.x * rad, C.y + Rr.y * (0.15 + rnd() * 0.3), Math.sin(a) * Rr.z * rad);
      const len = 0.38 + rnd() * 0.2;
      const w = (lite ? 0.36 : 0.24) * (0.85 + rnd() * 0.3);
      const out = V(Math.cos(a), 0.15, Math.sin(a));
      const L = (p: THREE.Vector3) => {
        const r = light(null)(p);
        r.n.lerp(out, 0.5).normalize();
        return r;
      };
      b.card(top.clone().add(V(0, -len / 2, 0)).addScaledVector(out, 0.03), out, UP, w, len, lite ? TCell.MassWillow : TCell.Willow, L, 1.4, 1.5);
    }
  }
  return b.build();
}

// --------------------------------------------------------------- conifers

function spruce(lite: boolean): THREE.BufferGeometry {
  const H = 1.04;
  const b = new TreeBuilder(0.03, H);
  const rnd = rngOf(11);
  const R0 = 0.36;
  const radAt = (t: number) => R0 * Math.pow(1 - t, 0.95) + 0.03;
  const light = (p: THREE.Vector3) => {
    const r = Math.hypot(p.x, p.z);
    const t = clamp01((p.y - 0.1) / (H - 0.1));
    const rel = clamp01(r / radAt(t));
    const n = V(p.x, 0, p.z).normalize().multiplyScalar(0.85).addScaledVector(UP, 0.5).normalize();
    let ao = (0.48 + 0.52 * sstep(0.15, 0.95, rel)) * (0.72 + 0.28 * t);
    ao = Math.min(1, ao * 1.05);
    return { n, c: [ao * 0.96, ao, ao * 0.97] as [number, number, number] };
  };
  b.tube([V(0, 0, 0), V(0, H * 0.96, 0)], [0.038, 0.008], lite ? 3 : 5, TCell.Bark, (p) => 0.55 + 0.4 * (p.y / H));
  // central spire: crossed vertical cards whose fishbone outline tapers to the tip
  const spires = lite ? 3 : 2;
  for (let k = 0; k < spires; k++) {
    const a = (k / spires) * Math.PI + 0.3;
    const side = V(Math.cos(a), 0, Math.sin(a));
    b.strip(V(0, 0.1, 0), V(0, H, 0), side, R0 * 2.1, 0.04, TCell.MassConifer, light, 0.02, 1);
  }
  // drooping branch tiers
  const tiers = lite ? 5 : 9;
  for (let i = 0; i < tiers; i++) {
    const t = (i + 0.3) / tiers;
    const y = 0.12 + t * 0.8;
    const R = radAt(t) * (1.02 + (rnd() - 0.5) * 0.12);
    const n = lite ? 5 : Math.max(4, Math.round(7 - t * 3));
    const rot = i * 0.9 + rnd();
    for (let j = 0; j < n; j++) {
      const a = rot + (j / n) * Math.PI * 2 + (rnd() - 0.5) * 0.3;
      const dir = V(Math.cos(a), 0, Math.sin(a));
      const tan = V(-Math.sin(a), 0, Math.cos(a));
      const root = V(0, y + 0.03, 0).addScaledVector(dir, 0.02);
      const tip = dir.clone().multiplyScalar(R).add(V(0, -R * 0.38, 0));
      tip.y += y;
      const w = R * (lite ? 1.15 : 0.95);
      // tilt across the branch so it reads from above and from the side
      const side = tan.clone().addScaledVector(UP, (j % 2 ? 0.3 : -0.3)).normalize();
      if (lite) b.strip(root, tip, side, w * 0.55, w * 0.9, TCell.MassConifer, light, 0.05, 1);
      else {
        const mid = root.clone().lerp(tip, 0.5).add(V(0, R * 0.08, 0));
        b.strip(root, mid, side, w * 0.38, w * 0.82, TCell.Spruce, light, 0.0, 0.5);
        b.strip(mid, tip, side, w * 0.82, w * 0.5, TCell.Spruce, light, 0.5, 1);
      }
    }
  }
  return b.build();
}

function pine(lite: boolean): THREE.BufferGeometry {
  const H = 1.05;
  const b = new TreeBuilder(0.034, H);
  const rnd = rngOf(23);
  const C = V(0.03, 0.82, 0);
  const Rr = V(0.32, 0.17, 0.3);
  const top = V(0.05, 0.86, 0.02);
  b.tube(lite ? [V(0, 0, 0), top] : [V(0, 0, 0), V(0.035, 0.45, 0.01), top], lite ? [0.036, 0.016] : [0.036, 0.027, 0.014], lite ? 3 : 5, TCell.PineBark, (p) => 0.6 + 0.4 * (p.y / H));
  const lumps: THREE.Vector3[] = [];
  const nL = lite ? 4 : 7;
  for (let i = 0; i < nL; i++) {
    const a = (i / nL) * Math.PI * 2 + rnd() * 0.6;
    const r = i === 0 ? 0.04 : 0.18 + rnd() * 0.08;
    lumps.push(V(Math.cos(a) * r, 0.72 + rnd() * 0.2 + (i === 0 ? 0.08 : 0), Math.sin(a) * r).add(V(0.03, 0, 0)));
  }
  if (!lite)
    for (const L of lumps.slice(1)) {
      const from = V(0.04, 0.6 + rnd() * 0.15, 0);
      b.tube([from, from.clone().lerp(L, 0.5).add(V(0, 0.03, 0)), L], [0.014, 0.009, 0.005], 3, TCell.PineBark, () => 0.8);
    }
  const light = (lump: THREE.Vector3) => (p: THREE.Vector3) => {
    const q = p.clone().sub(C).divide(Rr);
    const n = q.clone().normalize().multiplyScalar(0.5).add(p.clone().sub(lump).normalize().multiplyScalar(0.5)).addScaledVector(UP, 0.45).normalize();
    const ao = (0.5 + 0.5 * sstep(0.2, 1.0, q.length())) * (0.75 + 0.25 * clamp01((p.y - 0.62) / 0.35));
    return { n, c: [ao, ao, ao * 0.97] as [number, number, number] };
  };
  for (const L of lumps) {
    const n = lite ? 2 : 5;
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const off = V(Math.cos(a) * 0.08, (rnd() - 0.3) * 0.05, Math.sin(a) * 0.08);
      const p = L.clone().add(off);
      const f = off.clone().normalize().multiplyScalar(0.55).addScaledVector(UP, 1.2).normalize();
      const sz = (lite ? 0.34 : 0.25) * (0.85 + rnd() * 0.3);
      b.card(p, f, V(rnd() - 0.5, 0, rnd() - 0.5), sz, sz, lite ? TCell.MassConifer : TCell.Pine, light(L));
      if (!lite && i % 2 === 0) b.card(p, V(Math.cos(a + 1.3), 0.2, Math.sin(a + 1.3)), UP, sz * 0.9, sz * 0.7, TCell.Pine, light(L));
    }
  }
  return b.build();
}

// ------------------------------------------------------------ species

/** Broadleaf species parameters (a function: Species lives in vegetation.ts, which imports this module). */
function broadSpec(sp: Species): BroadSpec {
  const BROAD: Partial<Record<number, BroadSpec>> = {
  [Species.Oak]: { seed: 3, trunkH: 0.42, r0: 0.05, lean: 0.03, crownC: V(0, 0.7, 0), crownR: V(0.46, 0.31, 0.46), lumps: 6, lumpR: 0.48, perLump: 5, shell: 9, inner: 3, size: 0.22, cell: TCell.Oak, bark: TCell.Bark, flexK: 0.045 },
  [Species.Birch]: { seed: 5, trunkH: 0.5, r0: 0.03, lean: 0.05, stems: 2, crownC: V(0, 0.76, 0), crownR: V(0.26, 0.34, 0.26), lumps: 4, lumpR: 0.5, perLump: 4, shell: 8, inner: 1, size: 0.17, cell: TCell.Birch, bark: TCell.BirchBark, flexK: 0.06, ao: 0.75 },
  [Species.Young]: { seed: 7, trunkH: 0.28, r0: 0.026, lean: 0.04, crownC: V(0, 0.5, 0), crownR: V(0.27, 0.23, 0.27), lumps: 3, lumpR: 0.5, perLump: 4, shell: 6, inner: 1, size: 0.17, cell: TCell.Broad, bark: TCell.Bark, flexK: 0.05 },
  [Species.Poplar]: { seed: 9, trunkH: 0.2, r0: 0.035, lean: 0.01, crownC: V(0, 0.74, 0), crownR: V(0.17, 0.52, 0.17), lumps: 3, lumpR: 0.75, perLump: 5, shell: 12, inner: 2, size: 0.17, cell: TCell.Poplar, bark: TCell.Bark, flexK: 0.07, upright: true },
  [Species.Willow]: { seed: 13, trunkH: 0.36, r0: 0.055, lean: 0.07, crownC: V(0, 0.62, 0), crownR: V(0.46, 0.25, 0.46), lumps: 5, lumpR: 0.45, perLump: 4, shell: 8, inner: 2, size: 0.2, cell: TCell.Broad, bark: TCell.Bark, flexK: 0.05, curtains: 16 },
  [Species.Fruit]: { seed: 17, trunkH: 0.24, r0: 0.032, lean: 0.04, crownC: V(0, 0.47, 0), crownR: V(0.36, 0.22, 0.36), lumps: 5, lumpR: 0.45, perLump: 4, shell: 7, inner: 1, size: 0.17, cell: TCell.Fruit, bark: TCell.Bark, flexK: 0.04 },
  };
  return BROAD[sp] ?? BROAD[Species.Oak]!;
}

const geoCache = new Map<string, THREE.BufferGeometry>();

/** Hi / lo model of a species (cached). */
export function treeGeometry(sp: Species, lite: boolean): THREE.BufferGeometry {
  const key = `${sp}:${lite}`;
  let g = geoCache.get(key);
  if (g) return g;
  if (sp === Species.Spruce) g = spruce(lite);
  else if (sp === Species.Pine) g = pine(lite);
  else g = broadleaf(broadSpec(sp), lite);
  geoCache.set(key, g);
  return g;
}

export const SPECIES_COUNT = 8;

/**
 * Leaf tint of one tree (linear colour, stored at half strength in the
 * instance colour; see the material). `r1`, `r2` are per-tree randoms.
 */
export function treeTint(sp: Species, r1: number, r2: number, r3: number): THREE.Color {
  const c = new THREE.Color();
  const autumn = r3 < 0.045;
  switch (sp) {
    case Species.Spruce:
      c.setHSL(0.36 + r1 * 0.04, 0.26 + r2 * 0.1, 0.4 + r2 * 0.08);
      break;
    case Species.Pine:
      c.setHSL(0.31 + r1 * 0.05, 0.24 + r2 * 0.08, 0.42 + r2 * 0.08);
      break;
    case Species.Birch:
      if (r3 < 0.07) c.setHSL(0.13 + r1 * 0.03, 0.58, 0.52);
      else c.setHSL(0.21 + r1 * 0.04, 0.46 + r2 * 0.1, 0.55 + r2 * 0.06);
      break;
    case Species.Poplar:
      c.setHSL(0.24 + r1 * 0.04, 0.4 + r2 * 0.1, 0.46 + r2 * 0.06);
      break;
    case Species.Willow:
      c.setHSL(0.235 + r1 * 0.03, 0.32 + r2 * 0.08, 0.41 + r2 * 0.05);
      break;
    case Species.Fruit:
      c.setHSL(0.22 + r1 * 0.04, 0.44 + r2 * 0.1, 0.5 + r2 * 0.05);
      break;
    default:
      // oaks / saplings: fresh to deep greens, now and then an olive, a yellowing or a rusty one
      if (autumn) c.setHSL(r1 < 0.5 ? 0.07 + r2 * 0.03 : 0.12 + r2 * 0.03, 0.6, 0.5);
      else if (r3 < 0.1) c.setHSL(0.18 + r1 * 0.03, 0.4, 0.45);
      else c.setHSL(0.24 + r1 * 0.06, 0.4 + r2 * 0.14, 0.4 + r2 * 0.1);
  }
  return c.multiplyScalar(0.5);
}

// ------------------------------------------------------------- instancing

/** Culling cell size (tiles). */
const CELL = 4;

/** Instanced trees, one CulledInstances per species (registered with the LOD and the damage sink). */
export function buildTrees(m: GameMap, trees: TreeSpot[], fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod: SceneryLod, sink?: CulledInstances[]): THREE.Object3D[] {
  const { mat, depth } = treeMaterials(fog, quality);
  const out: THREE.Object3D[] = [];
  const shadows = quality !== 'low';
  // view span (world units) beyond which the light models are used
  const treeLo = quality === 'high' ? 19 : 14.5;
  const lists: Inst[][] = Array.from({ length: SPECIES_COUNT }, () => []);
  for (const t of trees) {
    const kx = Math.floor(t.x * 7);
    const ky = Math.floor(t.y * 7);
    const r1 = hash2(kx, ky, 3);
    const r2 = hash2(kx, ky, 4);
    const r3 = hash2(kx, ky, 5);
    const h = surfaceHeight(m, t.x, t.y);
    const sxz = t.s * (0.9 + r1 * 0.2);
    const sy = t.s * (0.9 + r2 * 0.22);
    lists[t.species].push({ x: t.x, y: h - 0.02, z: t.y, rotY: t.rot, sx: sxz, sy, sz: t.s * (0.9 + r3 * 0.2), color: treeTint(t.species, r1, r2, r3), tiltX: (r1 - 0.5) * 0.07, tiltZ: (r2 - 0.5) * 0.07 });
  }
  const tick = () => updateWind(fog.uniforms.fogTime.value as number);
  lists.forEach((list, sp) => {
    if (!list.length) return;
    const lo = treeGeometry(sp as Species, true);
    const hi = quality === 'low' ? lo : treeGeometry(sp as Species, false);
    const ci = new CulledInstances(hi, mat, list, m.w, m.h, CELL, { castShadow: shadows, receiveShadow: true, name: 'trees' });
    ci.mesh.customDepthMaterial = depth;
    // medium: no tree shadows from the far zoom-out (takes effect next frame; the view's span as in Terrain)
    const mesh = ci.mesh;
    mesh.onBeforeRender = (_r, _s, cam) => {
      tick();
      if (!cam.userData.waterReflection) mesh.castShadow = shadows && !(quality === 'medium' && cam.position.y * 0.9 > 30);
    };
    out.push(ci.mesh);
    lod.addCulled(ci, lo, treeLo);
    sink?.push(ci);
  });
  return out;
}
