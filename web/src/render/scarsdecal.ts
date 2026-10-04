import * as THREE from 'three';
import type { Biome, GameMap } from '../sim/map';
import { standHeight } from '../sim/map';
import type { FogOfWar } from './fog';
import { SUB, surfaceHeight } from './ground';

/*
 * Battle-scar ground decals (render only): craters, scorched earth, road
 * potholes / tar patches and ruin footprints.
 *
 * One procedural atlas holds every decal as four CHANNELS rather than
 * colours: R char / soot, G thrown soil, B bowl depth, A raised rim. The
 * decal shader turns them into a lit surface (soil + char albedo, a relief
 * normal from the height A - B, puddles filling the deepest part when the
 * ground is wet, snow filling the bowl in winter), so the same data can be
 * drawn live or baked:
 *
 *  - LIVE: the newest decals are an instanced ring buffer (one draw call),
 *    each tilted to the terrain, with an age (fresh embers, snow drifting in).
 *  - BAKED: when the ring wraps, the evicted decal is rendered into a
 *    map-wide RGBA8 render target with MAX blending (order independent,
 *    channels just accumulate) and is drawn by one sparse "drape" mesh that
 *    copies the ground's height field only on the 4x4-tile cells that hold
 *    baked scars. A long match therefore costs two draw calls and a fixed
 *    amount of memory however many shells land.
 */

export const enum ScarKind {
  CraterA = 0,
  CraterB = 1,
  ScorchA = 2,
  ScorchB = 3,
  Pothole = 4,
  Patch = 5,
  RuinPad = 6,
  Clods = 7,
}

const COLS = 4;
const ROWS = 2;

// ------------------------------------------------------------------ atlas

function hash(x: number, y: number, s: number) {
  const h = Math.sin(x * 127.1 + y * 311.7 + s * 74.7) * 43758.5453;
  return h - Math.floor(h);
}
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s);
  const b = hash(xi + 1, yi, s);
  const c = hash(xi, yi + 1, s);
  const d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
function fbm(x: number, y: number, s: number, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let n = 0;
  for (let o = 0; o < oct; o++) {
    sum += vnoise(x, y, s + o * 13) * amp;
    n += amp;
    amp *= 0.5;
    x *= 2.03;
    y *= 2.03;
  }
  return sum / n;
}
/** Angular noise, periodic around the circle. */
function anoise(a: number, f: number, s: number) {
  return fbm(Math.cos(a) * f + 7, Math.sin(a) * f + 3, s, 3);
}
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const sstep = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};
const gauss = (x: number, w: number) => Math.exp(-(x * x) / (w * w));

type Px = (u: number, v: number) => [number, number, number, number];

/** u, v in -1..1 (tile centre at 0). Returns [char, soil, depth, rim], 0..1. */
function craterPx(seed: number, oblique: number): Px {
  // clods: random blobs on the ejecta apron
  const clods: [number, number, number][] = [];
  for (let i = 0; i < 46; i++) {
    const a = hash(i, 1, seed) * Math.PI * 2;
    const bias = 1 + oblique * Math.cos(a - 0.6);
    const r = (0.48 + Math.pow(hash(i, 2, seed), 1.6) * 0.42) * Math.min(1.05, 0.85 + 0.2 * bias);
    clods.push([Math.cos(a) * r, Math.sin(a) * r, 0.012 + hash(i, 3, seed) * 0.03]);
  }
  return (u, v) => {
    const a = Math.atan2(v, u);
    const r0 = Math.hypot(u, v);
    const wob = 1 + (anoise(a, 1.6, seed) - 0.5) * 0.28;
    const r = r0 * wob;
    const R = 0.4;
    const bowl = r < R ? Math.pow(1 - (r / R) * (r / R), 0.75) : 0;
    const rim = gauss(r - R - 0.03, 0.085) * (0.75 + 0.5 * fbm(u * 6, v * 6, seed + 5));
    // ejecta rays (an oblique hit throws them to one side)
    const bias = 1 + oblique * Math.cos(a - 0.6);
    const ray = Math.pow(anoise(a, 9, seed + 2), 2.2) * 2.2;
    const apron = sstep(0.98 * Math.min(1.05, 0.62 + 0.3 * bias), 0.42, r0) * (0.55 + 0.45 * ray);
    let soil = Math.max(bowl > 0 ? 0.85 : 0, sstep(0.55, 0.38, r), apron * (0.6 + 0.4 * fbm(u * 9, v * 9, seed + 7)));
    let rimH = rim;
    for (const [cx, cy, cr] of clods) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < cr) {
        const k = 1 - d / cr;
        soil = Math.max(soil, 0.9);
        rimH = Math.max(rimH, k * 0.7);
      }
    }
    // char: the scorched centre and soot streaks
    const sootRay = Math.pow(anoise(a, 6, seed + 9), 3) * 2.5;
    const char = Math.max(sstep(0.5, 0.05, r) * (0.55 + 0.35 * fbm(u * 5, v * 5, seed + 11)), sstep(0.95, 0.35, r0) * sootRay * 0.55 * fbm(u * 7, v * 7, seed + 12));
    return [clamp01(char), clamp01(soil), clamp01(bowl), clamp01(rimH)];
  };
}

function scorchPx(seed: number, streaky: number): Px {
  return (u, v) => {
    const a = Math.atan2(v, u);
    const r0 = Math.hypot(u, v);
    const edge = 0.62 + (anoise(a, 2.2, seed) - 0.5) * 0.45;
    const blot = fbm(u * 3.2, v * 3.2, seed + 1);
    const body = sstep(edge + 0.15, edge - 0.25, r0 + (blot - 0.5) * 0.35);
    const streak = Math.pow(anoise(a, 11, seed + 3), 3) * 3 * sstep(0.98, 0.3, r0) * streaky;
    const speck = fbm(u * 14, v * 14, seed + 4) > 0.68 ? sstep(0.95, 0.5, r0) * 0.5 : 0;
    const c = Math.max(body * (0.55 + 0.45 * blot), streak * 0.7, speck);
    return [clamp01(c), 0, 0, 0];
  };
}

function potholePx(seed: number): Px {
  return (u, v) => {
    const a = Math.atan2(v, u);
    const r0 = Math.hypot(u, v);
    const edge = 0.3 + (anoise(a, 3.5, seed) - 0.5) * 0.22 + (fbm(u * 12, v * 12, seed + 1) - 0.5) * 0.06;
    const hole = sstep(edge + 0.02, edge - 0.06, r0);
    const depth = hole * (0.55 + 0.45 * sstep(edge, 0, r0));
    // broken asphalt edge: a darker ring of crumbs
    const lip = gauss(r0 - edge - 0.03, 0.04);
    // crack web (ridged noise), denser near the hole, some of it sealed with tar (wider, darker lines)
    const n1 = fbm(u * 3.5, v * 3.5, seed + 2, 3);
    const n2 = fbm(u * 6, v * 6, seed + 3, 3);
    const crack = sstep(0.025, 0.0, Math.abs(n1 - 0.5)) * sstep(0.95, 0.4, r0);
    const sealed = sstep(0.05, 0.025, Math.abs(n2 - 0.5)) * sstep(0.9, 0.5, r0) * (hash(Math.floor(u * 3), Math.floor(v * 3), seed) > 0.45 ? 1 : 0);
    const radial = Math.pow(anoise(a, 14, seed + 5), 6) * 9 * sstep(0.8, edge, r0) * (r0 > edge ? 1 : 0);
    const char = Math.max(crack * 0.85, sealed * 0.6, Math.min(1, radial) * 0.8, lip * 0.5, hole * 0.35);
    const soil = hole * (0.45 + 0.35 * fbm(u * 10, v * 10, seed + 6));
    return [clamp01(char), clamp01(soil), clamp01(depth), clamp01(lip * 0.35)];
  };
}

function patchPx(seed: number): Px {
  return (u, v) => {
    const ex = 0.62 + (fbm(v * 4, 1, seed) - 0.5) * 0.1;
    const ey = 0.42 + (fbm(u * 4, 2, seed) - 0.5) * 0.08;
    const box = sstep(0.03, -0.01, Math.max(Math.abs(u) - ex, Math.abs(v) - ey));
    const seam = gauss(Math.max(Math.abs(u) - ex, Math.abs(v) - ey), 0.02);
    const n = fbm(u * 5, v * 5, seed + 1, 3);
    const sealed = sstep(0.04, 0.02, Math.abs(n - 0.5)) * sstep(0.98, 0.7, Math.hypot(u * 0.8, v)) * (1 - box);
    const tex = 0.32 + 0.12 * fbm(u * 18, v * 18, seed + 2);
    return [clamp01(Math.max(box * tex, seam * 0.6, sealed * 0.55)), 0, 0, clamp01(box * 0.12 + seam * 0.2)];
  };
}

function ruinPadPx(seed: number): Px {
  const bits: [number, number, number][] = [];
  for (let i = 0; i < 70; i++) bits.push([(hash(i, 1, seed) - 0.5) * 1.8, (hash(i, 2, seed) - 0.5) * 1.8, 0.015 + hash(i, 3, seed) * 0.035]);
  return (u, v) => {
    // rounded square footprint with ragged edges
    const q = Math.pow(Math.pow(Math.abs(u), 4) + Math.pow(Math.abs(v), 4), 0.25);
    const ed = 0.78 + (fbm(u * 3, v * 3, seed) - 0.5) * 0.3;
    const body = sstep(ed + 0.12, ed - 0.2, q);
    const dust = body * (0.45 + 0.55 * fbm(u * 6, v * 6, seed + 1));
    const char = body * sstep(0.45, 0.75, fbm(u * 2.5, v * 2.5, seed + 2)) * 0.9;
    let rim = 0;
    let soil = dust;
    for (const [cx, cy, cr] of bits) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < cr) {
        rim = Math.max(rim, (1 - d / cr) * 0.6);
        soil = Math.max(soil, 0.8);
      }
    }
    return [clamp01(char), clamp01(soil), 0, clamp01(rim + body * 0.08)];
  };
}

function clodsPx(seed: number): Px {
  const bits: [number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const a = hash(i, 1, seed) * Math.PI * 2;
    const r = Math.sqrt(hash(i, 2, seed)) * 0.75;
    bits.push([Math.cos(a) * r, Math.sin(a) * r, 0.06 + hash(i, 3, seed) * 0.12]);
  }
  return (u, v) => {
    let rim = 0;
    let soil = 0;
    for (const [cx, cy, cr] of bits) {
      const d = Math.hypot(u - cx, v - cy);
      if (d < cr) {
        rim = Math.max(rim, (1 - d / cr) * 0.8);
        soil = Math.max(soil, sstep(cr, cr * 0.6, d));
      }
    }
    return [0, clamp01(soil), 0, clamp01(rim)];
  };
}

/** The decal atlas (COLS x ROWS tiles of `tile` px). Texel row 0 is v = 0. */
export function scarAtlas(tile: number): THREE.DataTexture {
  const W = tile * COLS;
  const H = tile * ROWS;
  const data = new Uint8Array(W * H * 4);
  const tiles: Px[] = [craterPx(11, 0.15), craterPx(23, 0.75), scorchPx(31, 0.6), scorchPx(43, 1.4), potholePx(53), patchPx(61), ruinPadPx(71), clodsPx(83)];
  tiles.forEach((fn, t) => {
    const ox = (t % COLS) * tile;
    const oy = Math.floor(t / COLS) * tile;
    for (let y = 0; y < tile; y++)
      for (let x = 0; x < tile; x++) {
        // keep a 2 px empty border so the bilinear filter never bleeds between tiles
        const border = x < 2 || y < 2 || x >= tile - 2 || y >= tile - 2;
        const px = border ? [0, 0, 0, 0] : fn(((x + 0.5) / tile) * 2 - 1, ((y + 0.5) / tile) * 2 - 1);
        const o = ((oy + y) * W + ox + x) * 4;
        // fade every channel out towards the tile edge (no hard square cut-off)
        const e = sstep(1.0, 0.9, Math.max(Math.abs(((x + 0.5) / tile) * 2 - 1), Math.abs(((y + 0.5) / tile) * 2 - 1)));
        data[o] = Math.round(px[0] * e * 255);
        data[o + 1] = Math.round(px[1] * e * 255);
        data[o + 2] = Math.round(px[2] * e * 255);
        data[o + 3] = Math.round(px[3] * e * 255);
      }
  });
  const t = new THREE.DataTexture(data, W, H, THREE.RGBAFormat, THREE.UnsignedByteType);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ------------------------------------------------------------------ shading

/** Thrown soil per biome (linear RGB). */
const SOIL: Record<Biome, [number, number, number]> = {
  temperate: [0.074, 0.05, 0.03],
  desert: [0.25, 0.17, 0.095],
  winter: [0.06, 0.047, 0.036],
  urban: [0.075, 0.064, 0.052],
};

/** World-units of relief per unit of channel height (baked layer; live decals scale with their size). */
const BAKED_RELIEF = 0.16;

const PARS = /* glsl */ `
uniform sampler2D scTex;
uniform vec3 scSoil;
uniform float scTime;
varying vec2 vScUv;
varying vec4 vScInfo;
// (three's perturbNormalArb, which is only compiled with a bump map)
vec3 scPerturb( vec3 surf_pos, vec3 surf_norm, vec2 dHdxy, float faceDirection ) {
  vec3 vSigmaX = normalize( dFdx( surf_pos.xyz ) );
  vec3 vSigmaY = normalize( dFdy( surf_pos.xyz ) );
  vec3 vN = surf_norm;
  vec3 R1 = cross( vSigmaY, vN );
  vec3 R2 = cross( vN, vSigmaX );
  float fDet = dot( vSigmaX, R1 ) * faceDirection;
  vec3 vGrad = sign( fDet ) * ( dHdxy.x * R1 + dHdxy.y * R2 );
  return normalize( abs( fDet ) * surf_norm - vGrad );
}
`;

/** Channels -> albedo / alpha / height (map_fragment replacement). vScInfo: x age (s), y relief scale, z ember, w kind. */
const SURFACE = /* glsl */ `
  vec4 scT = texture2D( scTex, vScUv );
  vec2 scDx = dFdx( vScUv );
  vec2 scDy = dFdy( vScUv );
  float scH = scT.a * 0.55 - scT.b;
  vec4 scTx = texture2D( scTex, vScUv + scDx );
  vec4 scTy = texture2D( scTex, vScUv + scDy );
  vec2 scDH = vec2( scTx.a * 0.55 - scTx.b - scH, scTy.a * 0.55 - scTy.b - scH ) * vScInfo.y;
  float scAge = vScInfo.x;
  // soil darker and moister down in the bowl, a little lighter on the rim
  vec3 scSoilC = scSoil * ( 1.0 - 0.5 * scT.b ) * ( 1.0 + 0.35 * scT.a );
  vec3 scChar = vec3( 0.0075, 0.0063, 0.0055 );
  float scCw = scT.r / max( scT.r + scT.g * ( 1.0 - scT.r ), 1e-3 );
  diffuseColor.rgb = mix( scSoilC, scChar, scCw );
  float scA = clamp( max( max( scT.r * 0.93, scT.g * 0.95 ), max( scT.b * 1.6, scT.a * 1.4 ) ), 0.0, 1.0 );
  diffuseColor.a *= scA;
  if ( diffuseColor.a < 0.004 ) discard;
  // winter: fresh scars show dark soil, snow drifts back into them over a couple of minutes
  float scSnowK = smoothstep( 12.0, 150.0, scAge ) * ( 0.75 + 0.25 * scT.b );
`;

const NORMAL = /* glsl */ `
  #include <normal_fragment_maps>
  vec3 scFlatN = normal;
  normal = scPerturb( - vViewPosition, normal, scDH, faceDirection );
`;

/** After the shared weather surface: puddles in the bowls, fresh embers. */
const WET = /* glsl */ `
  {
    float scWet = wxWet;
    diffuseColor.rgb *= 1.0 - 0.36 * scWet;
    // muddy water stands in the deepest part of the bowl; the level rises with the wetness
    float scLvl = 1.0 - 0.8 * scWet;
    float scPud = smoothstep( scLvl, scLvl + 0.1, scT.b ) * step( 0.12, scWet );
    if ( scPud > 0.001 ) {
      vec3 scRipN = scFlatN;
      if ( wxRain > 0.01 ) {
        vec2 rp = vFogP.xz * 9.0;
        float rr = sin( length( fract( rp ) - 0.5 ) * 40.0 - wxTime * 9.0 ) * wxRain * 0.06;
        scRipN = normalize( scFlatN + vec3( rr, 0.0, rr * 0.7 ) );
      }
      normal = normalize( mix( normal, scRipN, scPud ) );
      diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.022, 0.017, 0.012 ), scPud * 0.9 );
      roughnessFactor = mix( roughnessFactor, 0.07, scPud );
      float scFr = 0.04 + 0.96 * pow( 1.0 - clamp( dot( normal, normalize( vViewPosition ) ), 0.0, 1.0 ), 5.0 );
      vec3 scSky = hazeColor / ( 1.0 + max( hazeColor.r, max( hazeColor.g, hazeColor.b ) ) );
      totalEmissiveRadiance += scSky * scPud * ( 0.12 + 0.8 * scFr );
    }
  }
  // embers glow in a fresh crater for a few seconds
  totalEmissiveRadiance += vec3( 1.0, 0.32, 0.06 ) * scT.r * vScInfo.z * ( 1.0 - smoothstep( 0.0, 7.0, scAge ) ) * ( 0.4 + 0.6 * fract( sin( dot( floor( vScUv * 512.0 ), vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) ) * 1.5;
`;

function scarMaterial(fog: FogOfWar, tex: THREE.Texture, soil: [number, number, number], vertex: string, key: string, order: number) {
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.96, metalness: 0, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 - order, polygonOffsetUnits: -4 - order * 2 });
  mat.defines = { WX_SNOW_K: 'scSnowK', WX_OWN_WET: 1 };
  const uniforms = { scTex: { value: tex }, scSoil: { value: new THREE.Vector3(...soil) }, scTime: { value: 0 } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${vertex.split('//MAIN')[0]}`).replace('#include <begin_vertex>', `#include <begin_vertex>\n${vertex.split('//MAIN')[1]}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${PARS}`)
      .replace('#include <map_fragment>', SURFACE)
      .replace('#include <normal_fragment_maps>', NORMAL)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${WET}`);
  };
  fog.apply(mat);
  // fog.apply sets a shared cache key: ours patches more, keep the programs apart
  mat.customProgramCacheKey = () => 'scars-' + key;
  (mat as unknown as { scUniforms: typeof uniforms }).scUniforms = uniforms;
  return mat;
}

// ------------------------------------------------------------------ layers

interface Splat {
  kind: number;
  x: number;
  z: number;
  angle: number;
  len: number;
  wid: number;
  k: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class ScarDecals {
  readonly group = new THREE.Group();
  readonly atlas: THREE.DataTexture;
  // live ring
  private live: THREE.InstancedMesh;
  private info: Float32Array;
  private infoAttr: THREE.InstancedBufferAttribute;
  private slots: (Splat | null)[];
  private next = 0;
  private liveMax: number;
  // baked layer
  private rt: THREE.WebGLRenderTarget;
  private bakeScene = new THREE.Scene();
  private bakeCam: THREE.OrthographicCamera;
  private bakeMesh: THREE.InstancedMesh;
  private bakeAttr: THREE.InstancedBufferAttribute;
  private pending: Splat[] = [];
  private cleared = false;
  private drape: THREE.Mesh;
  private cellOn: Uint8Array;
  private cellsW: number;
  private cellsH: number;
  private cellsUsed = 0;
  private drapePos: Float32Array;
  private drapeNor: Float32Array;
  private drapeIdx: Uint32Array;
  private vertsPerCell: number;
  private idxPerCell: number;
  private liveMat: THREE.MeshStandardMaterial;
  private drapeMat: THREE.MeshStandardMaterial;
  time = 0;
  baked = 0;
  added = 0;

  static CELL = 4;

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
  ) {
    const tile = quality === 'low' ? 128 : 256;
    this.atlas = scarAtlas(tile);
    const soil = SOIL[map.biome] ?? SOIL.temperate;
    this.liveMax = quality === 'low' ? 48 : quality === 'medium' ? 96 : 192;

    // --- live ring: instanced quads tilted to the terrain
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    geo.deleteAttribute('uv');
    this.info = new Float32Array(this.liveMax * 4);
    this.infoAttr = new THREE.InstancedBufferAttribute(this.info, 4);
    this.infoAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aScInfo', this.infoAttr);
    const liveVert = /* glsl */ `
      attribute vec4 aScInfo;
      varying vec2 vScUv;
      varying vec4 vScInfo;
      uniform float scTime;
      //MAIN
      {
        float tile = aScInfo.w;
        vec2 cell = vec2( mod( tile, ${COLS}.0 ), floor( tile / ${COLS}.0 ) );
        vScUv = ( vec2( position.x + 0.5, 0.5 - position.z ) + cell ) / vec2( ${COLS}.0, ${ROWS}.0 );
        vScInfo = vec4( scTime - aScInfo.x, aScInfo.y, aScInfo.z, tile );
      }`;
    this.liveMat = scarMaterial(fog, this.atlas, soil, liveVert, 'live', 1);
    this.live = new THREE.InstancedMesh(geo, this.liveMat, this.liveMax);
    this.live.count = 0;
    this.live.visible = false;
    this.live.frustumCulled = false;
    this.live.receiveShadow = true;
    this.live.renderOrder = 3;
    this.live.name = 'scars-live';
    this.live.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.slots = new Array(this.liveMax).fill(null);

    // --- baked layer: map-wide channel render target
    const ppt = quality === 'low' ? 6 : quality === 'medium' ? 10 : 16;
    const W = map.w;
    const H = map.h;
    const rw = Math.min(2048, Math.round(W * ppt));
    const rh = Math.min(2048, Math.round(H * ppt));
    this.rt = new THREE.WebGLRenderTarget(rw, rh, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, stencilBuffer: false, generateMipmaps: true, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter });
    this.rt.texture.name = 'scars-baked';
    this.bakeCam = new THREE.OrthographicCamera(0, W, 0, -H, 1, 100);
    this.bakeCam.position.set(0, 50, 0);
    this.bakeCam.rotation.x = -Math.PI / 2;
    this.bakeCam.updateMatrixWorld(true);
    this.bakeScene.userData.scarsBake = true;
    const bgeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    bgeo.deleteAttribute('uv');
    const bakeMax = 256;
    this.bakeAttr = new THREE.InstancedBufferAttribute(new Float32Array(bakeMax * 2), 2);
    this.bakeAttr.setUsage(THREE.DynamicDrawUsage);
    bgeo.setAttribute('aBk', this.bakeAttr);
    const bmat = new THREE.ShaderMaterial({
      uniforms: { scTex: { value: this.atlas } },
      vertexShader: /* glsl */ `
        attribute vec2 aBk;
        varying vec2 vUv;
        varying float vK;
        void main() {
          vec2 cell = vec2( mod( aBk.x, ${COLS}.0 ), floor( aBk.x / ${COLS}.0 ) );
          vUv = ( vec2( position.x + 0.5, 0.5 - position.z ) + cell ) / vec2( ${COLS}.0, ${ROWS}.0 );
          vK = aBk.y;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4( position, 1.0 );
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D scTex;
        varying vec2 vUv;
        varying float vK;
        void main() { gl_FragColor = texture2D( scTex, vUv ) * vK; }`,
      blending: THREE.CustomBlending,
      blendEquation: THREE.MaxEquation,
      blendEquationAlpha: THREE.MaxEquation,
      blendSrc: THREE.OneFactor,
      blendDst: THREE.OneFactor,
      depthTest: false,
      depthWrite: false,
      transparent: true,
    });
    this.bakeMesh = new THREE.InstancedMesh(bgeo, bmat, bakeMax);
    this.bakeMesh.frustumCulled = false;
    this.bakeMesh.count = 0;
    this.bakeScene.add(this.bakeMesh);

    // --- drape: sparse copy of the ground height field (cells of CELL x CELL tiles)
    const C = ScarDecals.CELL;
    this.cellsW = Math.ceil(W / C);
    this.cellsH = Math.ceil(H / C);
    this.cellOn = new Uint8Array(this.cellsW * this.cellsH);
    const nv = C * SUB + 1;
    this.vertsPerCell = nv * nv;
    this.idxPerCell = (nv - 1) * (nv - 1) * 6;
    const maxCells = this.cellsW * this.cellsH;
    this.drapePos = new Float32Array(maxCells * this.vertsPerCell * 3);
    this.drapeNor = new Float32Array(maxCells * this.vertsPerCell * 3);
    this.drapeIdx = new Uint32Array(maxCells * this.idxPerCell);
    const dgeo = new THREE.BufferGeometry();
    dgeo.setAttribute('position', new THREE.BufferAttribute(this.drapePos, 3).setUsage(THREE.DynamicDrawUsage));
    dgeo.setAttribute('normal', new THREE.BufferAttribute(this.drapeNor, 3).setUsage(THREE.DynamicDrawUsage));
    dgeo.setIndex(new THREE.BufferAttribute(this.drapeIdx, 1).setUsage(THREE.DynamicDrawUsage));
    dgeo.setDrawRange(0, 0);
    const drapeVert = /* glsl */ `
      varying vec2 vScUv;
      varying vec4 vScInfo;
      //MAIN
      vScUv = vec2( position.x / ${W.toFixed(1)}, 1.0 - position.z / ${H.toFixed(1)} );
      vScInfo = vec4( 1e5, ${BAKED_RELIEF}, 0.0, -1.0 );`;
    this.drapeMat = scarMaterial(fog, this.rt.texture, soil, drapeVert, 'drape', 0);
    this.drape = new THREE.Mesh(dgeo, this.drapeMat);
    this.drape.frustumCulled = false;
    this.drape.receiveShadow = true;
    this.drape.renderOrder = 2;
    this.drape.visible = false;
    this.drape.name = 'scars-baked';
    this.group.add(this.drape, this.live);
  }

  /** Add a decal of atlas tile `kind`, centred at (x, z), len x wid tiles, rotated by angle; relief in world units per channel unit. */
  add(kind: ScarKind, x: number, z: number, angle: number, len: number, wid: number, relief: number, ember = 0) {
    const map = this.map;
    if (x < -1 || z < -1 || x > map.w + 1 || z > map.h + 1) return;
    const i = this.next;
    this.next = (this.next + 1) % this.liveMax;
    const old = this.slots[i];
    if (old) this.pending.push(old);
    this.slots[i] = { kind, x, z, angle, len, wid, k: 1 };
    const cx = Math.max(0, Math.min(map.w - 0.01, x));
    const cz = Math.max(0, Math.min(map.h - 0.01, z));
    const e = Math.max(0.3, Math.min(len, wid) * 0.35);
    const hx = standHeight(map, Math.min(map.w - 0.01, cx + e), cz) - standHeight(map, Math.max(0, cx - e), cz);
    const hz = standHeight(map, cx, Math.min(map.h - 0.01, cz + e)) - standHeight(map, cx, Math.max(0, cz - e));
    _n.set(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
    _q.setFromUnitVectors(UP, _n);
    _q2.setFromAxisAngle(UP, -angle);
    _q.multiply(_q2);
    // lift clears the ground's micro relief (+-0.03) and some of the slope curvature under big decals
    const lift = 0.028 + Math.min(0.05, Math.max(len, wid) * 0.008);
    _m.compose(_p.set(x, standHeight(map, cx, cz) + lift, z), _q, _s.set(len, 1, wid));
    this.live.setMatrixAt(i, _m);
    this.info[i * 4] = this.time;
    this.info[i * 4 + 1] = relief;
    this.info[i * 4 + 2] = ember;
    this.info[i * 4 + 3] = kind;
    this.live.count = Math.max(this.live.count, i + 1);
    this.live.visible = true;
    this.live.instanceMatrix.addUpdateRange(i * 16, 16);
    this.live.instanceMatrix.needsUpdate = true;
    this.infoAttr.addUpdateRange(i * 4, 4);
    this.infoAttr.needsUpdate = true;
    this.added++;
  }

  /** Bake a splat straight into the persistent layer (no live phase): evicted rubble, wrecks that sank away. */
  bake(kind: ScarKind, x: number, z: number, angle: number, len: number, wid: number, k = 1) {
    this.pending.push({ kind, x, z, angle, len, wid, k });
  }

  get liveCount() {
    return this.live.count;
  }

  get cells() {
    return this.cellsUsed;
  }

  get pendingCount() {
    return this.pending.length;
  }

  private activate(x: number, z: number, r: number) {
    const C = ScarDecals.CELL;
    const x0 = Math.max(0, Math.floor((x - r) / C));
    const x1 = Math.min(this.cellsW - 1, Math.floor((x + r) / C));
    const z0 = Math.max(0, Math.floor((z - r) / C));
    const z1 = Math.min(this.cellsH - 1, Math.floor((z + r) / C));
    for (let cz = z0; cz <= z1; cz++)
      for (let cx = x0; cx <= x1; cx++) {
        const c = cz * this.cellsW + cx;
        if (this.cellOn[c]) continue;
        this.cellOn[c] = 1;
        this.buildCell(cx, cz);
      }
  }

  private buildCell(cx: number, cz: number) {
    const C = ScarDecals.CELL;
    const m = this.map;
    const nv = C * SUB + 1;
    const slot = this.cellsUsed++;
    const vb = slot * this.vertsPerCell;
    const P = this.drapePos;
    const N = this.drapeNor;
    const gw = m.w * SUB;
    const gh = m.h * SUB;
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nv; i++) {
        const gi = Math.min(gw, cx * C * SUB + i);
        const gj = Math.min(gh, cz * C * SUB + j);
        const x = gi / SUB;
        const z = gj / SUB;
        const o = (vb + j * nv + i) * 3;
        P[o] = x;
        P[o + 1] = surfaceHeight(m, x, z) + 0.006;
        P[o + 2] = z;
        // same finite differences as the ground mesh (ground.ts)
        const h = (a: number, b: number) => surfaceHeight(m, Math.max(0, Math.min(gw, a)) / SUB, Math.max(0, Math.min(gh, b)) / SUB);
        const dx = (h(gi + 1, gj) - h(gi - 1, gj)) * SUB * 0.5;
        const dz = (h(gi, gj + 1) - h(gi, gj - 1)) * SUB * 0.5;
        const l = Math.hypot(dx, 1, dz);
        N[o] = -dx / l;
        N[o + 1] = 1 / l;
        N[o + 2] = -dz / l;
      }
    const I = this.drapeIdx;
    let o = slot * this.idxPerCell;
    for (let j = 0; j < nv - 1; j++)
      for (let i = 0; i < nv - 1; i++) {
        const a = vb + j * nv + i;
        const b = a + 1;
        const c = a + nv;
        const d = c + 1;
        // the ground's diagonal pattern (global vertex parity) so the drape lies exactly on it
        if ((cx * C * SUB + i + cz * C * SUB + j) & 1) {
          I[o++] = a;
          I[o++] = c;
          I[o++] = b;
          I[o++] = b;
          I[o++] = c;
          I[o++] = d;
        } else {
          I[o++] = a;
          I[o++] = c;
          I[o++] = d;
          I[o++] = a;
          I[o++] = d;
          I[o++] = b;
        }
      }
    const g = this.drape.geometry;
    const pa = g.getAttribute('position') as THREE.BufferAttribute;
    const na = g.getAttribute('normal') as THREE.BufferAttribute;
    pa.addUpdateRange(vb * 3, this.vertsPerCell * 3);
    pa.needsUpdate = true;
    na.addUpdateRange(vb * 3, this.vertsPerCell * 3);
    na.needsUpdate = true;
    g.index!.addUpdateRange(slot * this.idxPerCell, this.idxPerCell);
    g.index!.needsUpdate = true;
    g.setDrawRange(0, this.cellsUsed * this.idxPerCell);
    this.drape.visible = true;
  }

  /** Render the pending splats into the baked layer (at most one batch per frame). */
  flush(renderer: THREE.WebGLRenderer) {
    if (!this.pending.length) return;
    const n = Math.min(this.pending.length, this.bakeMesh.instanceMatrix.count);
    const batch = this.pending.splice(0, n);
    const A = this.bakeAttr.array as Float32Array;
    batch.forEach((s, i) => {
      _q.setFromAxisAngle(UP, -s.angle);
      _m.compose(_p.set(s.x, 0, s.z), _q, _s.set(s.len, 1, s.wid));
      this.bakeMesh.setMatrixAt(i, _m);
      A[i * 2] = s.kind;
      A[i * 2 + 1] = s.k;
      this.activate(s.x, s.z, Math.max(s.len, s.wid) * 0.72);
    });
    this.bakeMesh.count = n;
    this.bakeMesh.instanceMatrix.needsUpdate = true;
    this.bakeAttr.needsUpdate = true;
    const prevRT = renderer.getRenderTarget();
    const prevAuto = renderer.autoClear;
    const prevXr = renderer.xr.enabled;
    renderer.xr.enabled = false;
    renderer.autoClear = false;
    renderer.setRenderTarget(this.rt);
    if (!this.cleared) {
      const cc = renderer.getClearColor(new THREE.Color());
      const ca = renderer.getClearAlpha();
      renderer.setClearColor(0x000000, 0);
      renderer.clear(true, false, false);
      renderer.setClearColor(cc, ca);
      this.cleared = true;
    }
    renderer.render(this.bakeScene, this.bakeCam);
    renderer.setRenderTarget(prevRT);
    renderer.autoClear = prevAuto;
    renderer.xr.enabled = prevXr;
    this.baked += n;
  }

  update(dt: number) {
    this.time += dt;
    (this.liveMat as unknown as { scUniforms: { scTime: { value: number } } }).scUniforms.scTime.value = this.time;
  }

  dispose() {
    this.rt.dispose();
    this.atlas.dispose();
    this.live.geometry.dispose();
    this.drape.geometry.dispose();
    this.bakeMesh.geometry.dispose();
    this.liveMat.dispose();
    this.drapeMat.dispose();
    (this.bakeMesh.material as THREE.Material).dispose();
  }
}
