import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { groundHeight, type GameMap, WATER_LEVEL } from '../sim/map';
import { fbm, hash2, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import { treeGeometry, treeMaterials, treeTint } from './trees';
import { Species } from './treekinds';
import { grassRGB } from './grasstex';
import { biomeLook, hexRGB, type BiomeLook } from './biome';
import { CITY_NIGHT } from './models/citybldgs';
import { landmarkClear } from './landmarks/plan';

/** The terrain's painted control maps (see ground.ts). */
export interface GroundMaps {
  splat: Uint8Array;
  tint: Uint8Array;
  /** Grass control map (r = lush), see ground.ts. */
  ctl?: Uint8Array;
  res: number;
}

/** How far the countryside continues past each map edge (world units). */
const MARGIN = 84;
/** Grid spacing of the outskirts mesh. */
const CELL = 2;

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
  // desert: long dunes, gravel flats, a sandstone outcrop now and then
  {
    vec4 n = texture2D( fogNoise, p * 0.11 );
    float big = texture2D( fogNoise, p * 0.013 + 0.4 ).r;
    float u = dot( p, vec2( 0.29, 0.13 ) ) + big * 9.0;
    float dune = pow( 0.5 + 0.5 * cos( u * 2.1 ), 1.6 );
    vec3 c = mix( vec3( 0.7, 0.55, 0.36 ), vec3( 0.86, 0.7, 0.48 ), dune );
    c = mix( c, vec3( 0.58, 0.5, 0.4 ), smoothstep( 0.62, 0.7, big ) * 0.8 );
    c = mix( c, vec3( 0.62, 0.38, 0.25 ), smoothstep( 0.74, 0.78, texture2D( fogNoise, p * 0.021 + 0.7 ).g ) );
    return c * ( 0.9 + n.g * 0.16 ) * 0.86;
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

  constructor(
    private map: GameMap,
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
    terrainGround?: GroundMaps,
    terrainWater?: THREE.Mesh,
  ) {
    this.group.name = 'outskirts';
    this.look = biomeLook(map);
    this.edge = terrainGround ? this.sampleGround(terrainGround) : null;
    const ground = this.buildGround(fog);
    this.group.add(ground);
    this.buildTrees(fog, quality);
    if (this.look.code === 3) this.buildCityRing(fog, quality);
    this.buildWater(fog, terrainWater);
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
    // share the terrain's water material (its fog block upgraded to the smoky shroud / haze)
    fog.upgradeShader(src);
    const mat: THREE.Material = src;
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
    const { w, h } = this.map;
    const dx = Math.max(0, -x, x - w);
    const dy = Math.max(0, -y, y - h);
    return Math.hypot(dx, dy);
  }

  private edgeHeight(x: number, y: number) {
    const { w, h } = this.map;
    return groundHeight(this.map, Math.max(0, Math.min(w - 0.001, x)), Math.max(0, Math.min(h - 0.001, y)));
  }

  /** 1 where the map edge next to this point is under water (rivers flow on past the edge). */
  private wetNear(x: number, y: number) {
    const { w, h } = this.map;
    const ox = x < 0 || x > w;
    const oy = y < 0 || y > h;
    if (ox === oy) return 0; // inside, or in a corner quadrant
    let m = 0;
    for (let k = -4; k <= 4; k++) {
      const hh = ox && !oy ? this.edgeHeight(x, y + k) : !ox && oy ? this.edgeHeight(x + k, y) : this.edgeHeight(x, y);
      m = Math.max(m, smoothstep(0.05, -0.3, hh) * (1 - Math.abs(k) / 5));
    }
    return m;
  }

  private height(x: number, y: number) {
    const d = this.outside(x, y);
    const base = this.edgeHeight(x, y);
    if (d <= 0) return base - 0.14;
    // flatten towards a gentle plain, then rolling hills further out
    const plain = Math.max(base, 0) * (1 - smoothstep(0, 10, d));
    const hills = (fbm(x * 0.035, y * 0.035, 909, 3) - 0.38) * 5.5;
    const near = this.wetNear(x, y);
    const dry = plain + Math.max(-0.2, hills) * smoothstep(6, 46, d) * (1 - near) - 0.14 * (1 - smoothstep(0, 3, d));
    // river beds continue straight out at the edge's depth
    const corner = (x < 0 || x > this.map.w) && (y < 0 || y > this.map.h);
    const wet = corner ? 0 : smoothstep(0.0, -0.3, base);
    return dry * (1 - wet) + base * wet;
  }

  private woods(x: number, y: number) {
    return fbm(x * 0.045 + 13, y * 0.045, 515, 3);
  }

  /**
   * Low-res control map: rgb = the map's ground colour continued past the
   * edge, a = how much the procedural farmland (drawn crisply in the shader)
   * takes over. A second map holds the woodland floor mask.
   */
  private paint(size: number, ext: number) {
    const edge = new Uint8Array(size * size * 4);
    const woods = new Uint8Array(size * size);
    const t = [0, 0, 0];
    const ppu = size / ext;
    const { w, h } = this.map;
    for (let py = 0; py < size; py++) {
      for (let px = 0; px < size; px++) {
        const x = (px + 0.5) / ppu - MARGIN;
        const y = (py + 0.5) / ppu - MARGIN;
        const o = this.outside(x, y);
        const jitter = o <= 0 ? 0 : (valueNoise(x * 0.25, y * 0.25, 77) - 0.5) * 6;
        const near = o <= 0 ? 0 : this.wetNear(x, y);
        // farmland starts just past the edge so the seam reads as a field boundary, not a smear
        let blend = o <= 0 ? 0 : smoothstep(1.5, 11, o + jitter * 0.6) * (1 - near);
        if (o > 0 && near <= 0 && this.edgeHeight(x < 0 ? -x : x > w ? 2 * w - x : x, y < 0 ? -y : y > h ? 2 * h - y : y) < -0.05) blend = 1;
        this.terrainColor(x, y, t, near > 0);
        const i = (py * size + px) * 4;
        edge[i] = Math.min(255, t[0] * 255);
        edge[i + 1] = Math.min(255, t[1] * 255);
        edge[i + 2] = Math.min(255, t[2] * 255);
        edge[i + 3] = Math.round(blend * 255);
        woods[py * size + px] = o < 5 ? 0 : Math.round(smoothstep(0.55, 0.65, this.woods(x, y)) * smoothstep(5, 12, o) * 255);
      }
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

  private buildGround(fog: FogOfWar): THREE.Mesh {
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
        const a = vert(i, j);
        const b = vert(i + 1, j);
        const c = vert(i, j + 1);
        const d = vert(i + 1, j + 1);
        idx.push(a, c, b, b, c, d);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const maps = this.paint(384, ext);
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
      Object.assign(shader.uniforms, uniforms);
      shader.fragmentShader = shader.fragmentShader
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
    mat.customProgramCacheKey = () => 'outskirts-ground-2-b' + bk;
    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    mesh.name = 'outskirts-ground';
    return mesh;
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
    fog.apply(mat);
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
        const p = bk === 1 ? 0.012 : bk === 3 ? dense * 0.25 + 0.01 : dense * 0.85 + 0.035;
        if (hash2(k, 4, 5) > p) continue;
        if (o > MARGIN - 6) continue;
        if (landmarkClear(this.map, ox, oy, 0.8)) continue; // a landmark site / the railway (landmarks/plan.ts)
        const s = 1.15 + hash2(k, 5, 5) * 0.75 + dense * 0.45;
        const hy = this.height(ox, oy);
        // no trees standing in the river / canal / lake running on past the map edge
        if (hy < WATER_LEVEL + 0.1 || this.height(ox + 0.6, oy) < WATER_LEVEL || this.height(ox - 0.6, oy) < WATER_LEVEL || this.height(ox, oy + 0.6) < WATER_LEVEL || this.height(ox, oy - 0.6) < WATER_LEVEL) continue;
        q.setFromAxisAngle(up, hash2(k, 6, 5) * 6.28);
        const m = new THREE.Matrix4().compose(new THREE.Vector3(ox, hy - 0.05, oy), q, new THREE.Vector3(s, s * (0.9 + hash2(k, 7, 5) * 0.35), s));
        // the map's leaf tints, a little deeper (haze lifts them with distance)
        const pine = hash2(k, 10, 5) < 0.45 + (fbm(ox * 0.02, oy * 0.02, 66, 2) - 0.5);
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
    const { mat, depth } = treeMaterials(fog, quality);
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
  const o = Object.create(Outskirts.prototype) as { map: GameMap; height(x: number, y: number): number };
  o.map = m;
  return o.height(x, y);
}

/** Outskirts mesh grid: origin and spacing (the mesh is linear between its control points). */
export const OUTSKIRTS_GRID = { origin: -MARGIN, cell: CELL, margin: MARGIN };
