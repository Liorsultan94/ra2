import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { type GameMap, WATER_LEVEL, groundHeight as groundHeightAt } from '../sim/map';
import { fbm, hash2, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import { treeGeometry, treeMaterials, treeTint } from './trees';
import { Species } from './treekinds';
import { grassRGB } from './grasstex';
import { biomeLook, hexRGB, type BiomeLook } from './biome';
import { CITY_NIGHT } from './models/citybldgs';
import { landmarkClear } from './landmarks/plan';
import { HZ_CELL, HZ_MARGIN, horizonWorld, type ChannelSample, type HorizonWorld } from './horizonworld';
import { APRON_W } from './ground';
import { apronHeight, buildApron } from './apron';
import { HORIZON, Horizon, hzApply, hzClone, hzFragment, hzWaterClone } from './horizon';
import type { Slicer } from './slice';
import { gridSectors, splitMeshBySector, type SectorOf } from './sectors';

/** The terrain's painted control maps (see ground.ts). */
export interface GroundMaps {
  splat: Uint8Array;
  tint: Uint8Array;
  /** Grass control map (r = lush), see ground.ts. */
  ctl?: Uint8Array;
  res: number;
  /** The terrain's material: the apron past the edge is drawn with it (apron.ts). */
  material?: THREE.Material;
}

/** How far the countryside continues past each map edge (world units); the far ring (horizon.ts) takes over from there. */
const MARGIN = HZ_MARGIN;
/** Grid spacing of the outskirts mesh. */
const CELL = HZ_CELL;

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Farmland patchwork drawn per pixel (crisp at any zoom): fields on a
 * rotated grid with hedgerows and furrows, broken up by meadows. Output is
 * sRGB 0-1. Needs `fogNoise` (declared by the fog patch).
 */
const OUTSKIRTS_GLSL = /* glsl */ `
uniform sampler2D oskEdge;
uniform sampler2D oskWoods;
uniform vec2 oskOrigin;
uniform float oskExt;
float oskHash( vec2 c ) { return fract( sin( dot( c, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
vec3 oskFields( vec2 p ) {
#if OSK_BIOME == 1
  // desert: wind-shaped dune fields (gentle lit windward slopes, short dark lee faces, sharp crests,
  // wind ripples up close) between stony flats (reg) crossed by dry wadis
  {
    vec4 n = texture2D( fogNoise, p * 0.11 );
    float big = texture2D( fogNoise, p * 0.0093 + 0.4 ).r;
    float warp = texture2D( fogNoise, p * 0.019 + 0.13 ).g;
    const vec2 wd = vec2( 0.82, 0.57 );
    float along = dot( p, wd );
    float across = dot( p, vec2( -wd.y, wd.x ) );
    // crests meander: the phase drifts along them
    float u = along * 0.13 + warp * 4.0 + sin( across * 0.07 + warp * 3.0 ) * 0.8;
    float ph = fract( u );
    float wind = ph / 0.8;
    float lee = smoothstep( 0.78, 0.82, ph ) * ( 1.0 - smoothstep( 0.96, 1.0, ph ) );
    float crest = smoothstep( 0.7, 0.8, ph ) * ( 1.0 - smoothstep( 0.8, 0.83, ph ) );
    vec3 lit = vec3( 0.88, 0.73, 0.52 );
    vec3 shade = vec3( 0.7, 0.55, 0.38 );
    vec3 dune = mix( shade, lit, 0.35 + 0.65 * clamp( wind, 0.0, 1.0 ) );
    dune *= 1.0 - 0.2 * lee;
    dune += vec3( 0.05, 0.045, 0.03 ) * crest;
    // ripples (faded out where they would shimmer)
    float rf = along * 1.6 + warp * 9.0;
    float rAA = clamp( 1.0 - fwidth( rf ) * 1.5, 0.0, 1.0 );
    dune *= 1.0 + ( sin( rf * 6.2832 ) * 0.035 ) * rAA * ( 1.0 - lee );
    // reg: flat gravel plain, grey-brown, speckled with darker stones
    float stones = texture2D( fogNoise, p * 0.83 + 0.27 ).a;
    vec3 reg = mix( vec3( 0.6, 0.51, 0.39 ), vec3( 0.67, 0.58, 0.45 ), n.r ) * ( 1.0 - 0.12 * smoothstep( 0.62, 0.8, stones ) );
    float duneK = smoothstep( 0.38, 0.52, big + ( n.g - 0.5 ) * 0.08 );
    vec3 c = mix( reg, dune, duneK );
    // dry wadis: braided pale beds of silt and pebbles winding over the reg
    float wn = texture2D( fogNoise, p * 0.0061 + 0.61 ).b + ( n.b - 0.5 ) * 0.02;
    float wadi = 1.0 - smoothstep( 0.008, 0.022, abs( wn - 0.5 ) );
    c = mix( c, vec3( 0.76, 0.68, 0.56 ) * ( 0.94 + n.a * 0.1 ), wadi * 0.7 * ( 1.0 - duneK * 0.8 ) );
    return c * ( 0.93 + n.g * 0.1 ) * 0.86;
  }
#elif OSK_BIOME == 2
  // winter: snowfields, fence lines and dark copses
  {
    vec4 n = texture2D( fogNoise, p * 0.11 );
    float drift = texture2D( fogNoise, p * 0.031 + 0.2 ).r;
    vec3 c = vec3( 0.8, 0.84, 0.9 ) * ( 0.9 + drift * 0.12 + n.b * 0.05 );
    const float ca = 0.94604, sa = 0.32404;
    vec2 g = vec2( ( p.x * ca - p.y * sa ) / 13.0, ( p.x * sa + p.y * ca ) / 9.0 );
    vec2 l = fract( g );
    float border = min( min( l.x, 1.0 - l.x ), min( l.y, 1.0 - l.y ) * 1.4 );
    c = mix( c, vec3( 0.4, 0.38, 0.36 ), ( 1.0 - smoothstep( 0.008, 0.02, border ) ) * 0.6 );
    c = mix( c, vec3( 0.42, 0.4, 0.36 ), smoothstep( 0.7, 0.76, drift ) * 0.5 );
    return c * 0.86;
  }
#elif OSK_BIOME == 3
  // city: streets on the same grid, roofs, the odd park
  {
    vec2 g = p / 12.0;
    vec2 l = fract( g );
    vec2 ci = floor( g );
    float st = 1.0 - smoothstep( 0.1, 0.13, min( min( l.x, 1.0 - l.x ), min( l.y, 1.0 - l.y ) ) );
    float r = oskHash( ci );
    vec2 lot = floor( l * vec2( 3.0, 2.0 ) );
    float rl = oskHash( ci * 7.1 + lot );
    vec3 roof = mix( vec3( 0.36, 0.35, 0.34 ), vec3( 0.55, 0.42, 0.36 ), step( 0.6, rl ) ) * ( 0.75 + rl * 0.4 );
    vec3 c = r < 0.15 ? vec3( 0.3, 0.42, 0.22 ) : roof;
    c = mix( c, vec3( 0.2, 0.2, 0.21 ), st );
    return c * ( 0.9 + texture2D( fogNoise, p * 0.11 ).g * 0.15 ) * 0.86;
  }
#endif
  const float ca = 0.94604, sa = 0.32404; // rotation by 0.33 rad
  float u = p.x * ca - p.y * sa;
  float v = p.x * sa + p.y * ca;
  vec2 g = vec2( u / 11.0, v / 8.0 );
  vec2 cell = floor( g );
  vec2 l = g - cell;
  float r = oskHash( cell );
  float border = min( min( l.x, 1.0 - l.x ), min( l.y, 1.0 - l.y ) * 1.4 );
  float meadow = texture2D( fogNoise, p * 0.011 + 0.21 ).r;
  vec4 n = texture2D( fogNoise, p * 0.11 );
  vec3 c;
  if ( meadow > 0.6 || r < 0.28 ) {
    c = vec3( 0.36, 0.46, 0.22 ) * ( 0.82 + n.g * 0.3 );
  } else {
    if ( r < 0.48 ) c = vec3( 0.72, 0.6, 0.32 );       // ripe wheat
    else if ( r < 0.62 ) c = vec3( 0.5, 0.38, 0.25 );  // ploughed
    else if ( r < 0.8 ) c = vec3( 0.42, 0.52, 0.2 );   // young crop
    else c = vec3( 0.6, 0.55, 0.3 );                   // stubble
    float rows = 0.9 + 0.1 * sin( ( r >= 0.48 && r < 0.62 ? v : u ) * 5.5 );
    c *= rows * ( 0.88 + n.b * 0.24 );
    float hedge = 1.0 - smoothstep( 0.015, 0.05, border );
    c = mix( c, vec3( 0.16, 0.24, 0.11 ), hedge );
  }
  // toned down so the countryside doesn't outshine the battlefield
  return c * 0.82;
}
`;

/**
 * Countryside beyond the playable map: a ring of rolling ground, farm fields
 * and woods that continues the map edge and fades into haze, so the world
 * no longer ends in a black void. Purely cosmetic (no picking, no sim).
 */
export class Outskirts {
  readonly group = new THREE.Group();
  private edge: { data: Float32Array; size: number } | null = null;
  private look: BiomeLook;
  private world: HorizonWorld;
  /** The world beyond the outskirts, out to the horizon (horizon.ts). */
  horizon!: Horizon;

  /** Frustum culling sectors of the belt round the map (sectors.ts): a 6 x 6 grid over its square (44 unit cells on Canal City). */
  private sectors(): SectorOf {
    const ext = Math.max(this.map.w, this.map.h) + MARGIN * 2;
    return gridSectors(ext / 6, -MARGIN, -MARGIN);
  }

  /** Build synchronously (tests, tools); the game uses `Outskirts.build()`, which yields between the steps. */
  constructor(
    private map: GameMap,
    private fog: FogOfWar,
    private quality: 'low' | 'medium' | 'high',
    private terrainGround?: GroundMaps,
    private terrainWater?: THREE.Mesh,
    deferred = false,
  ) {
    this.group.name = 'outskirts';
    this.look = biomeLook(map);
    this.world = horizonWorld(map);
    if (!deferred) for (const _ of this.steps()) void _;
  }

  /** Build in time slices (slice.ts): the far world is several heavy steps on a phone. */
  static async build(map: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high', slicer: Slicer, terrainGround?: GroundMaps, terrainWater?: THREE.Mesh): Promise<Outskirts> {
    const o = new Outskirts(map, fog, quality, terrainGround, terrainWater, true);
    for (const _ of o.steps()) await slicer.tick();
    return o;
  }

  /** The construction, one yield per step (the horizon's own steps included). */
  private *steps(): Generator<void> {
    const { fog, quality, terrainWater } = this;
    this.edge = this.terrainGround ? this.sampleGround(this.terrainGround) : null;
    yield;
    yield* this.buildApron();
    yield* this.buildGround(fog);
    yield;
    this.buildTrees(fog, quality);
    yield;
    if (this.look.code === 3) this.buildCityRing(fog, quality);
    this.buildWater(fog, terrainWater);
    yield;
    this.horizon = new Horizon(this.map, fog, quality, terrainWater, true);
    yield* this.horizon.steps();
    this.group.add(this.horizon.group);
  }

  /**
   * Rivers that reach the map edge keep flowing: a ring of water around the
   * map using the terrain's water shader (its height lookup clamps at the
   * edge, so it continues exactly where the edge is wet). The shroud part is
   * swapped for the shared fog/haze function when the source allows it.
   */
  private buildWater(fog: FogOfWar, terrainWater?: THREE.Mesh) {
    const src = terrainWater?.material as THREE.ShaderMaterial | undefined;
    if (!src || !(src as THREE.ShaderMaterial).isShaderMaterial) return;
    const { w, h } = this.map;
    const M = MARGIN;
    const rect = (x0: number, y0: number, x1: number, y1: number) =>
      new THREE.PlaneGeometry(x1 - x0, y1 - y0).rotateX(-Math.PI / 2).translate((x0 + x1) / 2, 0, (y0 + y1) / 2);
    const geo = mergeGeometries([rect(-M, -M, w + M, 0), rect(-M, h, w + M, h + M), rect(-M, 0, 0, h), rect(w, 0, w + M, h)])!;
    // the terrain's water material (its fog block upgraded to the smoky shroud / haze), with the horizon's
    // aerial perspective past the edge instead of the dark surround (same uniforms, so it stays in sync)
    fog.upgradeShader(src);
    const mat: THREE.Material = hzWaterClone(src) ?? src;
    if (mat !== src) this.channelWater(mat as THREE.ShaderMaterial, src);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.y = terrainWater!.position.y;
    mesh.renderOrder = terrainWater!.renderOrder;
    mesh.name = 'outskirts-water';
    // planar reflection (high): hidden while the mirrored view renders; either water mesh can trigger it
    const refl = terrainWater!.userData.waterReflection as { meshes: THREE.Mesh[]; hook: THREE.Object3D['onBeforeRender'] } | null | undefined;
    if (refl) {
      refl.meshes.push(mesh);
      mesh.onBeforeRender = refl.hook;
    }
    this.group.add(mesh);
  }

  /** Width of the terrain's apron past the edge (0 = none: tests / tools without the terrain). */
  private apronW = 0;
  private chS: ChannelSample = { bed: Infinity, valley: 0, wet: 0, t: 0, d: 0, sx: 0, sy: 0 };

  /**
   * The battlefield ground carried on past the edge (apron.ts), drawn with the terrain's own material;
   * that material gets the horizon fog block (identical inside the map: it only differs past the edge).
   */
  private *buildApron(): Generator<void> {
    const g = this.terrainGround;
    const mat = g?.material;
    if (!g || !mat || !g.ctl) return;
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      prev.call(mat, shader, r);
      Object.assign(shader.uniforms, HORIZON);
      shader.fragmentShader = hzFragment(shader.fragmentShader);
    };
    const ck = mat.customProgramCacheKey.bind(mat);
    mat.customProgramCacheKey = () => ck() + '-hz';
    mat.needsUpdate = true;
    this.apronW = APRON_W;
    const meshes: THREE.Mesh[] = [];
    const t0 = performance.now();
    yield* buildApron({ map: this.map, world: this.world, look: this.look, splat: g.splat, tint: g.tint, ctl: g.ctl, res: g.res, material: mat, edgeColour: (x, y, o) => this.edgeColour(x, y, o) }, meshes);
    const grp = new THREE.Group();
    grp.name = 'ground-apron';
    grp.add(...meshes);
    this.group.add(grp);
    console.info(`ground apron: ${meshes.reduce((a, m) => a + m.geometry.attributes.position.count, 0)} vertices in ${Math.round(performance.now() - t0)} ms`);
  }

  /**
   * The rivers past the edge run on in their own direction (horizonworld.ts channels), so the water ring
   * can't read its depth / shore / flow from the battlefield's maps (they clamp at the edge, i.e. a
   * straight strip out of the edge): a map of its own (1 texel per unit over the belt: bed height, shore
   * distance, flow), blended in over the first 2.5 units past the edge.
   */
  private channelWater(mat: THREE.ShaderMaterial, src: THREE.ShaderMaterial) {
    const W = this.world;
    if (!W.rivers.length && !W.ponds.length) return;
    let fs = mat.fragmentShader;
    const gRe = /float ground = texture2D\(heightTex,[^;]*;/;
    const dat2 = 'vec4 dat2 = texture2D(waterData2, tuv);';
    if (!gRe.test(fs) || !fs.includes(dat2) || !fs.includes('vec4 dat = texture2D(waterData, tuv);') || !/void main\(\)\s*\{/.test(fs)) {
      console.warn('outskirts water: the river shader changed, rivers past the edge keep the edge strip');
      return;
    }
    const { w, h } = this.map;
    const M = MARGIN;
    const S = Math.round(w + 2 * M);
    const hgt = new Float32Array(S * S).fill(9);
    const wet = new Uint8Array(S * S);
    const vel = new Float32Array(S * S * 2);
    // the flow where each river leaves the map (the battlefield's velocity map), to carry on with
    const v2 = (src.uniforms.waterData2?.value as THREE.DataTexture | undefined)?.image as { data: Uint8Array; width: number; height: number } | undefined;
    const ch: ChannelSample = { bed: Infinity, valley: 0, wet: 0, t: 0, d: 0, sx: 0, sy: 0 };
    for (let j = 0; j < S; j++)
      for (let i = 0; i < S; i++) {
        const x = i + 0.5 - M;
        const y = j + 0.5 - M;
        const o = this.outside(x, y);
        if (o > M) continue;
        const k = j * S + i;
        if (o <= 0) {
          // a rim inside the map (bilinear filtering across the edge)
          if (Math.min(x, y, w - x, h - y) < 2) hgt[k] = groundHeightAt(this.map, x, y);
          continue;
        }
        W.channelAt(x, y, ch);
        if (ch.wet <= 0 && !W.nearPond(x, y)) continue;
        const hh = o < APRON_W ? apronHeight(this.map, W, x, y) : W.height(x, y);
        hgt[k] = hh;
        if (hh < WATER_LEVEL) wet[k] = 1;
      }
    // shore distance (units) by a two-pass chamfer transform over the wet texels
    const sd = new Float32Array(S * S);
    for (let k = 0; k < S * S; k++) sd[k] = wet[k] ? 1e3 : 0;
    const rel = (k: number, q: number, c: number) => {
      if (sd[q] + c < sd[k]) sd[k] = sd[q] + c;
    };
    for (let j = 1; j < S - 1; j++)
      for (let i = 1; i < S - 1; i++) {
        const k = j * S + i;
        if (!wet[k]) continue;
        rel(k, k - 1, 1);
        rel(k, k - S, 1);
        rel(k, k - S - 1, 1.414);
        rel(k, k - S + 1, 1.414);
      }
    for (let j = S - 2; j > 0; j--)
      for (let i = S - 2; i > 0; i--) {
        const k = j * S + i;
        if (!wet[k]) continue;
        rel(k, k + 1, 1);
        rel(k, k + S, 1);
        rel(k, k + S + 1, 1.414);
        rel(k, k + S - 1, 1.414);
      }
    // flow: along the channel (its centre line's direction), the edge's speed and sense
    for (const r of W.rivers) {
      const p0 = W.riverPoint(r, 0);
      const p1 = W.riverPoint(r, 1.5);
      let ux = p1.x - p0.x;
      let uy = p1.y - p0.y;
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul;
      uy /= ul;
      let sense = 1;
      let speed = 0.35;
      if (v2) {
        const ix = Math.max(0, Math.min(v2.width - 1, Math.floor(((p0.x - ux * 1.5) / w) * v2.width)));
        const iy = Math.max(0, Math.min(v2.height - 1, Math.floor(((p0.y - uy * 1.5) / h) * v2.height)));
        const q = (iy * v2.width + ix) * 4;
        const vx = (v2.data[q] / 255) * 2 - 1;
        const vy = (v2.data[q + 1] / 255) * 2 - 1;
        speed = Math.min(0.8, Math.max(0.12, Math.hypot(vx, vy)));
        sense = vx * ux + vy * uy < 0 ? -1 : 1;
      }
      for (let dd = 0; dd < M; dd += 0.5) {
        const a = W.riverPoint(r, dd);
        const b = W.riverPoint(r, dd + 0.5);
        const tx = ((b.x - a.x) / 0.5) * sense * speed;
        const ty = ((b.y - a.y) / 0.5) * sense * speed;
        const hwd = r.hw * (1 + dd / 220) * 1.8 + 2;
        for (let t = -hwd; t <= hwd; t += 0.5) {
          const x = a.x + (r.side < 2 ? 0 : t);
          const y = a.y + (r.side < 2 ? t : 0);
          const i = Math.floor(x + M);
          const j = Math.floor(y + M);
          if (i < 0 || j < 0 || i >= S || j >= S) continue;
          const k = j * S + i;
          vel[k * 2] = tx;
          vel[k * 2 + 1] = ty;
        }
      }
    }
    const data = new Uint16Array(S * S * 4);
    const hf = THREE.DataUtils.toHalfFloat;
    for (let k = 0; k < S * S; k++) {
      data[k * 4] = hf(hgt[k]);
      data[k * 4 + 1] = hf(Math.min(60, sd[k]));
      data[k * 4 + 2] = hf(vel[k * 2]);
      data[k * 4 + 3] = hf(vel[k * 2 + 1]);
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat, THREE.HalfFloatType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.needsUpdate = true;
    mat.uniforms.oskWater = { value: tex };
    mat.uniforms.oskWBox = { value: new THREE.Vector4(-M, -M, 1 / S, 0) };
    fs = fs.replace(/void main\(\)\s*\{/, 'uniform sampler2D oskWater;\nuniform vec4 oskWBox;\nvoid main() {');
    fs = fs.replace(gRe, (g) => `${g}
        float oskK = smoothstep(0.0, 2.5, length(max(max(-p, p - mapSize), 0.0)));
        vec4 oskW = texture2D(oskWater, (p - oskWBox.xy) * oskWBox.z);
        ground = mix(ground, oskW.r, oskK);`);
    fs = fs.replace(dat2, `${dat2}
        dat.g = mix(dat.g, oskW.g / SHORE, oskK);
        dat.ba *= 1.0 - oskK;
        dat2.rg = mix(dat2.rg, clamp(oskW.ba, -1.0, 1.0) * 0.5 + 0.5, oskK);
        dat2.ba *= 1.0 - oskK;`);
    mat.fragmentShader = fs;
    mat.needsUpdate = true;
  }

  /** Mean colour of the map's dry ground (stands in where the mirrored map would show water). */
  private dryMean: number[] | null = null;

  /**
   * The outskirts' own ground colour past the edge (sRGB 0-1): the map's colours mirrored back in, and
   * along a channel (river, wadi) the colours of the edge it came through, so its banks run on.
   */
  edgeColour(x: number, y: number, out: number[]) {
    const { w, h } = this.map;
    this.terrainColor(x, y, out);
    const mx = x < 0 ? -x : x > w ? 2 * w - x : x;
    const my = y < 0 ? -y : y > h ? 2 * h - y : y;
    const o = this.outside(x, y);
    if (o <= 0) return;
    const ch = this.chS;
    this.world.channelAt(x, y, ch);
    const v = ch.valley;
    // the mirror lands in the river: dry ground colour instead
    if (v < 0.99 && this.edgeHeight(mx, my) < WATER_LEVEL + 0.12 && this.dryMean) for (let j = 0; j < 3; j++) out[j] = this.dryMean[j];
    if (v > 0) {
      const t = [0, 0, 0];
      this.terrainColor(ch.sx, ch.sy, t, true);
      for (let j = 0; j < 3; j++) out[j] += (t[j] - out[j]) * v;
    }
  }

  /**
   * Approximate ground colour (0-1 sRGB) from the terrain's splat / tint
   * control maps, using the same palette as the splat shader, so the seam
   * continues the map's colours.
   */
  private sampleGround(g: GroundMaps): { data: Float32Array; size: number } {
    const { w, h } = this.map;
    const size = 192;
    const data = new Float32Array(size * size * 3);
    const N = w * g.res;
    const gcol = [0, 0, 0];
    const L = this.look;
    const dirt = hexRGB(L.ground.dirt);
    const rock = hexRGB(L.ground.rock);
    const sand = hexRGB(L.ground.sand);
    const mud = hexRGB(L.ground.mud);
    const mean = [0, 0, 0, 0];
    for (let py = 0; py < size; py++)
      for (let px = 0; px < size; px++) {
        const x = ((px + 0.5) / size) * w;
        const y = ((py + 0.5) / size) * h;
        const k = (Math.min(N - 1, Math.floor(y * g.res)) * N + Math.min(N - 1, Math.floor(x * g.res))) * 4;
        const s0 = g.splat[k] / 255;
        const s1 = g.splat[k + 1] / 255;
        const s2 = g.splat[k + 2] / 255;
        const s3 = g.splat[k + 3] / 255;
        const wg = Math.max(0, 1 - s0 - s1 - s2 - s3);
        const dr = g.tint[k + 3] / 255;
        grassRGB(g.ctl ? g.ctl[k] / 255 : 0, dr, gcol, L.grass);
        // winter: the painted snow cover (ground.ts keeps its depth in the grass control map's blue)
        const sn = L.code === 2 && g.ctl ? Math.max(0, Math.min(1, (g.ctl[k + 2] / 255 - 0.25) / 0.4)) : 0;
        for (let j = 0; j < 3; j++) {
          let c = gcol[j] * wg + dirt[j] * s0 + rock[j] * s1 + sand[j] * s2 + mud[j] * s3;
          c += ([0.84, 0.88, 0.95][j] - c) * sn;
          // a touch darker: the splat shader's detail maps darken the flat palette colours
          data[(py * size + px) * 3 + j] = Math.min(1, 0.88 * c * Math.pow((g.tint[k + j] / 255) * 2, 0.6));
        }
        if (groundHeightAt(this.map, x, y) > WATER_LEVEL + 0.2) {
          for (let j = 0; j < 3; j++) mean[j] += data[(py * size + px) * 3 + j];
          mean[3]++;
        }
      }
    if (mean[3]) this.dryMean = [mean[0] / mean[3], mean[1] / mean[3], mean[2] / mean[3]];
    // soften it (two box passes, ~3 units): mirrored back past the edge, the map's yards, fields and
    // tracks would otherwise show as blurred blocks; the apron carries the crisp detail (apron.ts)
    const tmp = new Float32Array(data.length);
    const R = 6;
    for (let pass = 0; pass < 2; pass++)
      for (const dir of [0, 1]) {
        const src = dir ? tmp : data;
        const dst = dir ? data : tmp;
        for (let a = 0; a < size; a++)
          for (let b = 0; b < size; b++) {
            let r = 0;
            let g = 0;
            let bl = 0;
            let n = 0;
            for (let k = -R; k <= R; k++) {
              const q = b + k;
              if (q < 0 || q >= size) continue;
              const i = (dir ? q * size + a : a * size + q) * 3;
              r += src[i];
              g += src[i + 1];
              bl += src[i + 2];
              n++;
            }
            const o = (dir ? b * size + a : a * size + b) * 3;
            dst[o] = r / n;
            dst[o + 1] = g / n;
            dst[o + 2] = bl / n;
          }
      }
    return { data, size };
  }

  /** Terrain colour (0-1 sRGB) at map position, mirrored back inside the map (or clamped to the edge). */
  private terrainColor(x: number, y: number, out: number[], clamp = false) {
    const { w, h } = this.map;
    const mx = clamp ? Math.max(0, Math.min(w, x)) : x < 0 ? -x : x > w ? 2 * w - x : x;
    const my = clamp ? Math.max(0, Math.min(h, y)) : y < 0 ? -y : y > h ? 2 * h - y : y;
    const e = this.edge;
    if (!e) {
      out[0] = 0.3;
      out[1] = 0.41;
      out[2] = 0.17;
      return;
    }
    const px = Math.max(0, Math.min(e.size - 1, Math.floor((mx / w) * e.size)));
    const py = Math.max(0, Math.min(e.size - 1, Math.floor((my / h) * e.size)));
    const i = (py * e.size + px) * 3;
    out[0] = e.data[i];
    out[1] = e.data[i + 1];
    out[2] = e.data[i + 2];
  }

  private outside(x: number, y: number) {
    return this.world.outside(x, y);
  }

  private edgeHeight(x: number, y: number) {
    return this.world.edgeHeight(x, y);
  }

  /** Ground height (horizonworld.ts: the near belt, the far relief, rivers, the bay). */
  private height(x: number, y: number) {
    return this.world.height(x, y);
  }

  /** Desert: acacia scrub along the wadi's banks (and a rare one out on the reg). */
  private wadiScrub(x: number, y: number) {
    this.world.channelAt(x, y, this.chS);
    const t = Math.abs(this.chS.t);
    return (1 - smoothstep(3, 8, t)) * smoothstep(1.5, 3, t) * 0.14 + 0.0006;
  }

  private woods(x: number, y: number) {
    return fbm(x * 0.045 + 13, y * 0.045, 515, 3);
  }

  /**
   * Low-res control map: rgb = the map's ground colour continued past the
   * edge, a = how much the procedural farmland (drawn crisply in the shader)
   * takes over. A second map holds the woodland floor mask.
   */
  private *paint(size: number, ext: number): Generator<void, { edge: THREE.DataTexture; woods: THREE.DataTexture }> {
    const edge = new Uint8Array(size * size * 4);
    const woods = new Uint8Array(size * size);
    const t = [0, 0, 0];
    const ppu = size / ext;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px + 0.5) / ppu - MARGIN;
        const y = (py + 0.5) / ppu - MARGIN;
        const o = this.outside(x, y);
        const jitter = o <= 0 ? 0 : (valueNoise(x * 0.25, y * 0.25, 77) - 0.5) * 6;
        const val = o <= 0 ? 0 : this.world.valleyNear(x, y);
        // past the apron (the battlefield ground carried on) the farmland / dunes take over along a ragged line
        const a0 = this.apronW;
        let blend = o <= 0 ? 0 : smoothstep(a0 + 1.5, a0 + 11, o + jitter * 0.6) * (1 - val * 0.9);
        this.edgeColour(x, y, t);
        if (this.world.sea && o > 0) {
          // the bay: sand on the beach, concrete in the container yard, a sandy bed under the water
          const { u, v } = this.world.seaV(x, y);
          const sea = this.world.sea;
          const hb = u > sea.harbour[0] && u < sea.harbour[1];
          const k = smoothstep(hb ? -46 : -12, hb ? -40 : -4, v);
          const c = hb ? [0.52, 0.52, 0.5] : [0.84, 0.76, 0.58];
          for (let j = 0; j < 3; j++) t[j] += (c[j] - t[j]) * k;
          blend *= 1 - k;
        }
        const i = (py * size + px) * 4;
        edge[i] = Math.min(255, t[0] * 255);
        edge[i + 1] = Math.min(255, t[1] * 255);
        edge[i + 2] = Math.min(255, t[2] * 255);
        edge[i + 3] = Math.round(blend * 255);
        woods[py * size + px] = o < a0 + 5 ? 0 : Math.round(smoothstep(0.55, 0.65, this.woods(x, y)) * smoothstep(a0 + 5, a0 + 12, o) * 255);
      }
      if ((py & 15) === 15) yield;
    }
    const tex = (data: Uint8Array, fmt: THREE.PixelFormat) => {
      const tx = new THREE.DataTexture(data, size, size, fmt, THREE.UnsignedByteType);
      tx.magFilter = THREE.LinearFilter;
      tx.minFilter = THREE.LinearMipmapLinearFilter;
      tx.generateMipmaps = true;
      tx.wrapS = tx.wrapT = THREE.ClampToEdgeWrapping;
      tx.needsUpdate = true;
      return tx;
    };
    return { edge: tex(edge, THREE.RGBAFormat), woods: tex(woods, THREE.RedFormat) };
  }

  private *buildGround(fog: FogOfWar): Generator<void> {
    const { w, h } = this.map;
    const x0 = -MARGIN;
    const y0 = -MARGIN;
    const ext = Math.max(w, h) + MARGIN * 2;
    const n = Math.round(ext / CELL);
    const pos: number[] = [];
    const uv: number[] = [];
    const vid = new Int32Array((n + 1) * (n + 1)).fill(-1);
    const vert = (i: number, j: number) => {
      const k = j * (n + 1) + i;
      if (vid[k] >= 0) return vid[k];
      const x = x0 + i * CELL;
      const y = y0 + j * CELL;
      pos.push(x, this.height(x, y), y);
      uv.push(i / n, 1 - j / n);
      vid[k] = pos.length / 3 - 1;
      return vid[k];
    };
    const idx: number[] = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const cx0 = x0 + i * CELL;
        const cy0 = y0 + j * CELL;
        // skip cells well inside the map (the terrain covers them); keep a 2 unit overlap
        if (cx0 >= 2 && cx0 + CELL <= w - 2 && cy0 >= 2 && cy0 + CELL <= h - 2) continue;
        // under the terrain's apron (apron.ts): only its rim overlaps
        if (this.apronW > 0 && Math.max(this.outside(cx0, cy0), this.outside(cx0 + CELL, cy0), this.outside(cx0, cy0 + CELL), this.outside(cx0 + CELL, cy0 + CELL)) < this.apronW - 2.5) continue;
        const a = vert(i, j);
        const b = vert(i + 1, j);
        const c = vert(i, j + 1);
        const d = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
      if ((j & 7) === 7) yield;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    yield;
    const maps = yield* this.paint(384, ext);
    const uniforms = {
      oskEdge: { value: maps.edge },
      oskWoods: { value: maps.woods },
      oskOrigin: { value: new THREE.Vector2(x0, y0) },
      oskExt: { value: ext },
    };
    const mat = fog.apply(new THREE.MeshStandardMaterial({ roughness: 0.97, metalness: 0 }));
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, r) => {
      prev.call(mat, shader, r);
      Object.assign(shader.uniforms, uniforms, HORIZON);
      shader.fragmentShader = hzFragment(shader.fragmentShader)
        .replace('#include <map_pars_fragment>', `#include <map_pars_fragment>\n${OUTSKIRTS_GLSL}`)
        .replace(
          '#include <map_fragment>',
          `{
            vec2 oskUv = ( vFogP.xz - oskOrigin ) / oskExt;
            vec4 e = texture2D( oskEdge, oskUv );
            float wd = texture2D( oskWoods, oskUv ).r;
            vec3 c = mix( e.rgb, oskFields( vFogP.xz ), e.a );
            c *= mix( vec3( 1.0 ), vec3( 0.55, 0.65, 0.55 ), wd );
            // fine grain so the countryside reads as ground up close, not a smear
            vec4 gn = texture2D( fogNoise, vFogP.xz * 0.37 );
            vec4 gn2 = texture2D( fogNoise, vFogP.xz * 1.9 );
            c *= 0.86 + gn.r * 0.18 + gn2.g * 0.12;
            diffuseColor.rgb *= pow( c, vec3( 2.2 ) );
          }`,
        );
    };
    mat.defines = { ...(mat.defines ?? {}), OSK_BIOME: this.look.code };
    // woods darken the countryside (not the desert / city)
    if (this.look.code === 1 || this.look.code === 3) {
      maps.woods.image.data?.fill(0);
      maps.woods.needsUpdate = true;
    }
    const bk = this.look.code;
    mat.customProgramCacheKey = () => 'outskirts-ground-hz1-b' + bk;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'outskirts-ground';
    // (in sectors: only the stretch of the belt in view is drawn, sectors.ts)
    this.group.add(...splitMeshBySector(mesh, this.sectors()));
  }

  /** City map: the town goes on past the edge (instanced blocks on the street grid, lit windows at night). */
  private buildCityRing(fog: FogOfWar, quality: 'low' | 'medium' | 'high') {
    const { w, h } = this.map;
    const N = 64;
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const g = cv.getContext('2d')!;
    g.fillStyle = '#b8b2a8';
    g.fillRect(0, 0, N, N);
    const ce = document.createElement('canvas');
    ce.width = ce.height = N;
    const ge = ce.getContext('2d')!;
    ge.fillStyle = '#000';
    ge.fillRect(0, 0, N, N);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++) {
        g.fillStyle = '#3a4048';
        g.fillRect(x * 8 + 2, y * 8 + 2, 4, 4);
        if (hash2(x, y, 77) < 0.4) {
          ge.fillStyle = hash2(x, y, 78) < 0.8 ? '#ffc880' : '#b8d0ff';
          ge.fillRect(x * 8 + 2, y * 8 + 2, 4, 4);
        }
      }
    const map = new THREE.CanvasTexture(cv);
    map.colorSpace = THREE.SRGBColorSpace;
    const em = new THREE.CanvasTexture(ce);
    const mat = new THREE.MeshStandardMaterial({ map, emissiveMap: em, emissive: 0xffffff, emissiveIntensity: 0, roughness: 0.85, vertexColors: false });
    hzApply(fog, mat, 'city-ring');
    const box = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
    // drop the bottom face's UV stretch: the roofs read as flat concrete through the texture's border colour
    const list: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const budget = quality === 'low' ? 260 : quality === 'medium' ? 460 : 700;
    for (let by = -MARGIN + 4; by < h + MARGIN - 4 && list.length < budget; by += 12)
      for (let bx = -MARGIN + 4; bx < w + MARGIN - 4 && list.length < budget; bx += 12)
        for (let k = 0; k < 4; k++) {
          const x = bx + 2.5 + (k % 2) * 5 + (hash2(bx, by, 60 + k) - 0.5);
          const y = by + 2.5 + (k >> 1) * 5 + (hash2(bx, by, 70 + k) - 0.5);
          const o = this.outside(x, y);
          if (o < 4 || o > MARGIN - 8) continue;
          if ((x > w || y > h) && o < 10) continue;
          if (hash2(bx, by, 50) < 0.12) continue; // a park
          if (landmarkClear(this.map, x, y, 2.2)) continue; // a landmark site (landmarks/plan.ts)
          if (this.world.sea) {
            // the bay, its beach and the container yard
            const { u, v } = this.world.seaV(x, y);
            const sea = this.world.sea;
            if (v > (u > sea.harbour[0] - 4 && u < sea.harbour[1] + 4 ? -50 : -16)) continue;
          }
          const hh = 0.7 + hash2(bx, by, 80 + k) * (o > 20 ? 2.4 : 1.6);
          const sx = 2.6 + hash2(bx, by, 90 + k) * 1.4;
          const sz = 2.6 + hash2(bx, by, 95 + k) * 1.4;
          const m = new THREE.Matrix4().compose(new THREE.Vector3(x, this.height(x, y) - 0.1, y), new THREE.Quaternion(), new THREE.Vector3(sx, hh, sz));
          const t = 0.75 + hash2(bx, by, 99 + k) * 0.35;
          list.push({ m, c: new THREE.Color(t, t * (0.95 + hash2(k, by, 3) * 0.08), t * 0.92) });
        }
    if (!list.length) return;
    const im = new THREE.InstancedMesh(box, mat, list.length);
    list.forEach((e, i) => {
      im.setMatrixAt(i, e.m);
      im.setColorAt(i, e.c);
    });
    im.computeBoundingSphere();
    im.castShadow = quality === 'high';
    im.receiveShadow = true;
    im.name = 'outskirts-city';
    im.onBeforeRender = () => {
      mat.emissiveIntensity = CITY_NIGHT.value * 1.4;
    };
    // (not split in sectors: ~5k triangles in all, one draw is cheaper than the pieces a wide view catches)
    this.group.add(im);
  }

  private buildTrees(fog: FogOfWar, quality: 'low' | 'medium' | 'high') {
    const { w, h } = this.map;
    // the battlefield's own tree models (light LOD) and material: same leaves, wind and lighting
    const bk = this.look.code;
    const spA = bk === 1 ? Species.Acacia : bk === 3 ? Species.Young : Species.Spruce;
    const spB = bk === 1 ? Species.Palm : bk === 2 ? Species.Birch : Species.Oak;
    const pineGeo = treeGeometry(spA, true);
    const leafyGeo = treeGeometry(spB, true);
    const pines: THREE.Matrix4[] = [];
    const leafy: THREE.Matrix4[] = [];
    const pc: THREE.Color[] = [];
    const lc: THREE.Color[] = [];
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const budget = quality === 'low' ? 900 : quality === 'medium' ? 1600 : 2400;
    const step = 1.3;
    let k = 0;
    for (let y = -MARGIN + 2; y < h + MARGIN - 2 && pines.length + leafy.length < budget; y += step) {
      for (let x = -MARGIN + 2; x < w + MARGIN - 2; x += step) {
        k++;
        const ox = x + (hash2(k, 1, 3) - 0.5) * step;
        const oy = y + (hash2(k, 2, 3) - 0.5) * step;
        const o = this.outside(ox, oy);
        if (o < 3) continue;
        // keep the near edges on the camera side clear so trees never hide units
        if ((ox > w || oy > h) && o < 9) continue;
        const wd = this.woods(ox, oy);
        const dense = smoothstep(0.56, 0.66, wd);
        // scattered trees along hedgerows / in meadows
        // rivers running on past the edge keep a fringe of trees on their banks; the desert's scrub keeps to
        // the wadi (no palms out on the open dunes: they only stand at water, the oasis spots)
        const riv = bk === 3 ? 0 : this.world.wetNear(ox, oy);
        const p = bk === 1 ? this.wadiScrub(ox, oy) : bk === 3 ? dense * 0.25 + 0.01 : dense * 0.85 + 0.035 + riv * riv * 0.3;
        if (hash2(k, 4, 5) > p) continue;
        if (o > MARGIN - 6) continue;
        if (landmarkClear(this.map, ox, oy, 0.8)) continue; // a landmark site / the railway (landmarks/plan.ts)
        if (this.world.nearPath(ox, oy, 0.5)) continue; // a road / railway running on to the horizon
        if (this.world.sea && this.world.seaV(ox, oy).v > -8) continue;
        // the battlefield's own tree sizes (vegetation.ts: 0.82 .. 1.4)
        const s = 0.85 + hash2(k, 5, 5) * 0.45 + dense * 0.15;
        const hy = this.height(ox, oy);
        // no trees standing in the river / canal / lake running on past the map edge
        if (hy < WATER_LEVEL + 0.1 || this.height(ox + 0.6, oy) < WATER_LEVEL || this.height(ox - 0.6, oy) < WATER_LEVEL || this.height(ox, oy + 0.6) < WATER_LEVEL || this.height(ox, oy - 0.6) < WATER_LEVEL) continue;
        q.setFromAxisAngle(up, hash2(k, 6, 5) * 6.28);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(ox, hy - 0.05, oy), q, new THREE.Vector3(s, s * (0.9 + hash2(k, 7, 5) * 0.35), s));
        // the map's leaf tints, a little deeper (haze lifts them with distance)
        const pine = bk === 1 || hash2(k, 10, 5) < 0.45 + (fbm(ox * 0.02, oy * 0.02, 66, 2) - 0.5) - riv * 0.3;
        const c = treeTint(pine ? spA : spB, hash2(k, 8, 5), hash2(k, 9, 5), hash2(k, 11, 5)).multiplyScalar(0.85);
        if (pine) {
          pines.push(m);
          pc.push(c);
        } else {
          leafy.push(m);
          lc.push(c);
        }
        if (pines.length + leafy.length >= budget) break;
      }
    }
    const tm = treeMaterials(fog, quality);
    const depth = tm.depth;
    // the battlefield's tree material with the horizon's aerial perspective instead of the dark surround
    const mat = hzClone(tm.mat, 'osk-trees');
    // one instanced mesh per type and sector so off-screen sectors are frustum culled
    const G = 5;
    const cell = (Math.max(w, h) + MARGIN * 2) / G;
    const sector = (m: THREE.Matrix4) => {
      const gx = Math.max(0, Math.min(G - 1, Math.floor((m.elements[12] + MARGIN) / cell)));
      const gy = Math.max(0, Math.min(G - 1, Math.floor((m.elements[14] + MARGIN) / cell)));
      return gy * G + gx;
    };
    for (const [geo, mats, cols] of [
      [pineGeo, pines, pc],
      [leafyGeo, leafy, lc],
    ] as const) {
      for (let sct = 0; sct < G * G; sct++) {
        const idx: number[] = [];
        mats.forEach((mm, i) => sector(mm) === sct && idx.push(i));
        if (!idx.length) continue;
        const im = new THREE.InstancedMesh(geo, mat, idx.length);
        idx.forEach((src, i) => {
          im.setMatrixAt(i, mats[src]);
          im.setColorAt(i, cols[src]);
        });
        im.castShadow = quality === 'high';
        im.customDepthMaterial = depth;
        im.receiveShadow = false;
        im.computeBoundingSphere();
        this.group.add(im);
      }
    }
  }
}

/** Ground height of the outskirts mesh's control points at (x, y) (landmarks/plan.ts stands its set pieces on it). */
export function outskirtsHeight(m: GameMap, x: number, y: number): number {
  return horizonWorld(m).height(x, y);
}

/** Outskirts mesh grid: origin and spacing (the mesh is linear between its control points). */
export const OUTSKIRTS_GRID = { origin: -MARGIN, cell: CELL, margin: MARGIN };
