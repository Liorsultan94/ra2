import * as THREE from 'three';
import { Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import { fbm, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import { GRASS_GLSL, GRASS_TEX_TILES, grassTexture, grassUniforms } from './grasstex';
import { segDist, smoothLine, type Layout } from './layout';
import { groundDetailTexture } from './terraintex';

/*
 * Ground: a height-blended splat material. Low resolution control maps
 * (painted on the CPU from the map + scenery layout) choose between five
 * materials - grass (lush .. dry), soil, rock, sand and mud - and a tiling
 * detail map sampled at two rotated scales supplies crisp per-material
 * detail, height-based transitions and bump. Farm fields are drawn by the
 * same shader from a field map (rows, furrows, crops), so they cost nothing.
 */

export const SUB = 2; // mesh vertices per tile

/** Height of the rendered ground surface (sim height + visual micro relief). */
export function surfaceHeight(m: GameMap, x: number, y: number) {
  return groundHeight(m, x, y) + (valueNoise(x * 1.7, y * 1.7, 5) - 0.5) * 0.06;
}

export interface TreeShade {
  x: number;
  y: number;
  r: number;
}

/** Bilinear sampler over a coarse noise grid (res cells per tile). */
function coarseField(w: number, h: number, res: number, fn: (x: number, y: number) => number) {
  const gw = w * res + 2;
  const gh = h * res + 2;
  const g = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) g[j * gw + i] = fn((i - 0.5) / res, (j - 0.5) / res);
  return (x: number, y: number) => {
    const fx = Math.max(0, Math.min(gw - 1.001, x * res + 0.5));
    const fy = Math.max(0, Math.min(gh - 1.001, y * res + 0.5));
    const i = Math.floor(fx);
    const j = Math.floor(fy);
    const tx = fx - i;
    const ty = fy - j;
    const a = g[j * gw + i];
    const b = g[j * gw + i + 1];
    const c = g[(j + 1) * gw + i];
    const d = g[(j + 1) * gw + i + 1];
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
  };
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Trodden footpaths (render only): each village house to the nearest road
 * when it is a short walk away, and to its nearest neighbour. Gently
 * wandering, smoothed polylines.
 */
function footpaths(m: GameMap, L: Layout): { x: number; y: number }[][] {
  const out: { x: number; y: number }[][] = [];
  const roadPts: { x: number; y: number }[] = [];
  for (const r of L.roads) for (let i = 0; i < r.pts.length; i += 2) roadPts.push(r.pts[i]);
  const centres = m.structures.map((s) => ({ x: s.x + s.w / 2, y: s.y + s.h / 2, r: Math.max(s.w, s.h) / 2 }));
  const nearest = centres.map((c, i) => {
    let nb = -1;
    let nd = 1e9;
    centres.forEach((o, j) => {
      const d = Math.hypot(o.x - c.x, o.y - c.y);
      if (j !== i && d < nd) {
        nd = d;
        nb = j;
      }
    });
    return nb;
  });
  const wander = (a: { x: number; y: number }, b: { x: number; y: number }, seed: number) => {
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const n = Math.max(3, Math.ceil(len / 1.5));
    const amp = (valueNoise(seed * 3.1, 0.5, 91) - 0.5) * 0.5 * Math.min(4, len);
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const off = Math.sin(t * Math.PI) * amp + (i > 0 && i < n ? (valueNoise(seed + i * 0.7, 3.3, 93) - 0.5) * 0.5 : 0);
      pts.push({ x: a.x + (b.x - a.x) * t + nx * off, y: a.y + (b.y - a.y) * t + ny * off });
    }
    return smoothLine(pts, 2, 0.3);
  };
  centres.forEach((c, i) => {
    let best: { x: number; y: number } | null = null;
    let bd = 1e9;
    for (const p of roadPts) {
      const d = Math.hypot(p.x - c.x, p.y - c.y);
      if (d < bd) {
        bd = d;
        best = p;
      }
    }
    if (best && bd > c.r + 1.2 && bd < 11) {
      const dx = (best.x - c.x) / bd;
      const dy = (best.y - c.y) / bd;
      out.push(wander({ x: c.x + dx * (c.r + 0.3), y: c.y + dy * (c.r + 0.3) }, best, i * 7 + 1));
    }
    const nb = nearest[i];
    const nd = nb >= 0 ? Math.hypot(centres[nb].x - c.x, centres[nb].y - c.y) : 1e9;
    // each pair once
    if (nb >= 0 && (nb > i || nearest[nb] !== i)) {
      const o = centres[nb];
      if (nd > c.r + o.r + 1 && nd < 9) {
        const dx = (o.x - c.x) / nd;
        const dy = (o.y - c.y) / nd;
        out.push(wander({ x: c.x + dx * (c.r + 0.3), y: c.y + dy * (c.r + 0.3) }, { x: o.x - dx * (o.r + 0.3), y: o.y - dy * (o.r + 0.3) }, i * 13 + 5));
      }
    }
  });
  return out;
}

export class Ground {
  /** The ground, split into square chunks so off-screen parts are culled. */
  readonly mesh = new THREE.Group();
  readonly chunks: THREE.Mesh[] = [];
  readonly material: THREE.MeshStandardMaterial;
  /** Painted control maps, also reused for the minimap. */
  readonly splat: Uint8Array;
  readonly tint: Uint8Array;
  /** Grass control map: r lush, g clover, b wildflowers, a worn (paths, trampled yards). */
  readonly ctl: Uint8Array;
  /** 3D grass blade map: r density, g height (src/render/grass.ts). */
  readonly blades: Uint8Array;
  readonly res: number;
  /** Rendered surface heights on the mesh grid (hx * hy vertices, SUB per tile). */
  readonly heights: Float32Array;
  readonly hx: number;
  readonly hy: number;
  /** Textures and palette uniforms shared with the grass blades. */
  readonly shared: Record<string, { value: unknown }>;

  constructor(
    private map: GameMap,
    private layout: Layout,
    trees: TreeShade[],
    fog: FogOfWar,
    quality: 'low' | 'medium' | 'high',
  ) {
    const m = map;
    this.res = quality === 'low' ? 6 : quality === 'medium' ? 8 : 10;
    const N = m.w * this.res;
    this.splat = new Uint8Array(N * N * 4);
    this.tint = new Uint8Array(N * N * 4);
    this.ctl = new Uint8Array(N * N * 4);
    this.blades = new Uint8Array(N * N * 4);
    const field = new Uint8Array(N * N * 4);
    this.paint(this.splat, this.tint, field, trees);
    const tex = (data: Uint8Array) => {
      const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.magFilter = THREE.LinearFilter;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.generateMipmaps = true;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.flipY = false;
      t.needsUpdate = true;
      return t;
    };
    const fieldTex = tex(field);
    // the field map must not be mip-blended into neighbouring fields
    fieldTex.minFilter = THREE.LinearFilter;
    fieldTex.generateMipmaps = false;
    const detail = groundDetailTexture(quality === 'low' ? 256 : 512);
    const grassTex = grassTexture(quality === 'low' ? 256 : 512);

    const mat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    const col = (hex: number) => new THREE.Color(hex);
    const uniforms = {
      splatTex: { value: tex(this.splat) },
      tintTex: { value: tex(this.tint) },
      fieldTex: { value: fieldTex },
      detailTex: { value: detail },
      grassTex: { value: grassTex },
      ctlTex: { value: tex(this.ctl) },
      terrMapSize: { value: new THREE.Vector2(m.w, m.h) },
      ...grassUniforms(),
      cDirt: { value: col(0x7a6448) },
      cRock: { value: col(0x77716a) },
      cSand: { value: col(0xa89a7a) },
      cMud: { value: col(0x4a3e30) },
      cSoil: { value: col(0x5e4632) },
      cCrop: { value: col(0x4f6a22) },
      cWheat: { value: col(0xb59a52) },
      cHay: { value: col(0x8e8a4a) },
    };
    this.shared = { ...uniforms, bladeTex: { value: tex(this.blades) } };
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTerrW;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvTerrW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${GRASS_GLSL}\n${TERRAIN_PARS}`)
        .replace('#include <map_fragment>', TERRAIN_MAP)
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = terrRough;')
        .replace('#include <normal_fragment_maps>', TERRAIN_NORMAL);
    };
    fog.apply(mat);
    // relief mapping steps: high 12, medium 5, low off (?pom=0 forces it off for comparisons)
    const pomOff = typeof location !== 'undefined' && /[?&]pom=0\b/.test(location.search);
    const pom = pomOff ? 0 : quality === 'high' ? 12 : quality === 'medium' ? 5 : 0;
    mat.defines = { ...(mat.defines ?? {}), TERR_POM: pom };
    mat.defines.GRASS_TILES = GRASS_TEX_TILES.toFixed(3);
    mat.customProgramCacheKey = () => 'terrain-splat-3-' + pom;
    this.material = mat;

    // mesh: one height field (so normals are continuous), cut into chunks
    const nx = m.w * SUB + 1;
    const ny = m.h * SUB + 1;
    const pos = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const k = (j * nx + i) * 3;
        pos[k] = i / SUB;
        pos[k + 1] = surfaceHeight(m, i / SUB, j / SUB);
        pos[k + 2] = j / SUB;
      }
    this.hx = nx;
    this.hy = ny;
    this.heights = new Float32Array(nx * ny);
    for (let k = 0; k < nx * ny; k++) this.heights[k] = pos[k * 3 + 1];
    const nor = new Float32Array(nx * ny * 3);
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const h = (ii: number, jj: number) => pos[(Math.max(0, Math.min(ny - 1, jj)) * nx + Math.max(0, Math.min(nx - 1, ii))) * 3 + 1];
        const dx = (h(i + 1, j) - h(i - 1, j)) * SUB * 0.5;
        const dz = (h(i, j + 1) - h(i, j - 1)) * SUB * 0.5;
        const l = Math.hypot(dx, 1, dz);
        nor.set([-dx / l, 1 / l, -dz / l], (j * nx + i) * 3);
      }
    const CH = 24 * SUB; // chunk size in vertices
    for (let cj = 0; cj < ny - 1; cj += CH)
      for (let ci = 0; ci < nx - 1; ci += CH) {
        const cw = Math.min(CH, nx - 1 - ci) + 1;
        const chh = Math.min(CH, ny - 1 - cj) + 1;
        const cpos = new Float32Array(cw * chh * 3);
        const cnor = new Float32Array(cw * chh * 3);
        for (let j = 0; j < chh; j++)
          for (let i = 0; i < cw; i++) {
            const src = ((cj + j) * nx + ci + i) * 3;
            cpos.set(pos.subarray(src, src + 3), (j * cw + i) * 3);
            cnor.set(nor.subarray(src, src + 3), (j * cw + i) * 3);
          }
        const idx = new Uint16Array((cw - 1) * (chh - 1) * 6);
        let o = 0;
        for (let j = 0; j < chh - 1; j++)
          for (let i = 0; i < cw - 1; i++) {
            const a = j * cw + i;
            const b = a + 1;
            const c = a + cw;
            const d = c + 1;
            // alternate the diagonal to avoid a visible grain
            if ((ci + i + cj + j) & 1) idx.set([a, c, b, b, c, d], o);
            else idx.set([a, c, d, a, d, b], o);
            o += 6;
          }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(cpos, 3));
        geo.setAttribute('normal', new THREE.BufferAttribute(cnor, 3));
        geo.setIndex(new THREE.BufferAttribute(idx, 1));
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, mat);
        mesh.receiveShadow = true;
        mesh.name = 'ground';
        this.chunks.push(mesh);
        this.mesh.add(mesh);
      }
    this.mesh.name = 'ground';
  }

  // ------------------------------------------------------------ painting

  private paint(splat: Uint8Array, tint: Uint8Array, field: Uint8Array, trees: TreeShade[]) {
    const m = this.map;
    const L = this.layout;
    const P = this.res;
    const N = m.w * P;
    const W = m.w;

    // per tile material weights: [dirt, rock, sand, mud, oreRed, gemBlue, forest]
    const simRoad = new Uint8Array(W * m.h);
    for (const r of m.roads)
      for (let k = 0; k < r.length - 1; k++) {
        const a = { x: r[k].x + 0.5, y: r[k].y + 0.5 };
        const b = { x: r[k + 1].x + 0.5, y: r[k + 1].y + 0.5 };
        for (let y = 0; y < m.h; y++)
          for (let x = 0; x < W; x++) if (segDist(x + 0.5, y + 0.5, a, b) < 1.0) simRoad[y * W + x] = 1;
      }
    const TW = 7;
    const tileW = new Float32Array(W * m.h * TW);
    const oreNear = (i: number, kind: number) => {
      const x = i % W;
      const y = (i / W) | 0;
      let n = 0;
      for (let j = -1; j <= 1; j++)
        for (let k = -1; k <= 1; k++) {
          const xx = x + k;
          const yy = y + j;
          if (xx >= 0 && yy >= 0 && xx < W && yy < m.h && m.oreKind[yy * W + xx] === kind) n++;
        }
      return n / 9;
    };
    for (let i = 0; i < W * m.h; i++) {
      const t = m.tiles[i];
      const o = i * TW;
      if (t === Tile.Dirt && !simRoad[i]) tileW[o] = 0.62;
      if (t === Tile.Rock) tileW[o + 1] = 1;
      if (t === Tile.Sand) tileW[o + 2] = 0.85;
      if (t === Tile.Water || t === Tile.Bridge) {
        tileW[o + 3] = 0.55;
        tileW[o + 2] = 0.2;
        tileW[o + 1] = 0.25;
      }
      const ore = oreNear(i, 1);
      const gem = oreNear(i, 2);
      if (m.oreKind[i] === 1 || ore > 0.3) {
        tileW[o] = Math.max(tileW[o], 0.75);
        tileW[o + 3] = 0.2;
        tileW[o + 4] = Math.max(ore, m.oreKind[i] === 1 ? 0.8 : 0);
      }
      if (m.oreKind[i] === 2 || gem > 0.3) {
        tileW[o] = Math.max(tileW[o], 0.35);
        tileW[o + 1] = Math.max(tileW[o + 1], 0.35);
        tileW[o + 2] = Math.max(tileW[o + 2], 0.2);
        tileW[o + 5] = Math.max(gem, m.oreKind[i] === 2 ? 0.8 : 0);
      }
      if (m.trees[i]) tileW[o + 6] = 1;
    }
    const tw = (x: number, y: number, c: number) => {
      const tx = Math.max(0, Math.min(W - 1, x));
      const ty = Math.max(0, Math.min(m.h - 1, y));
      return tileW[(ty * W + tx) * TW + c];
    };

    // coarse noise fields
    const jx = coarseField(W, m.h, 4, (x, y) => fbm(x * 0.9, y * 0.9, 3, 2) - 0.5);
    const jy = coarseField(W, m.h, 4, (x, y) => fbm(x * 0.9 + 40, y * 0.9, 3, 2) - 0.5);
    const macro = coarseField(W, m.h, 2, (x, y) => fbm(x * 0.09, y * 0.09, 21, 3));
    const blotch = coarseField(W, m.h, 4, (x, y) => fbm(x * 0.45, y * 0.45, 33, 3));
    const dryN = coarseField(W, m.h, 2, (x, y) => fbm(x * 0.06, y * 0.06, 47, 3));
    const patchN = coarseField(W, m.h, 4, (x, y) => fbm(x * 0.7, y * 0.7, 51, 3));
    const hueN = coarseField(W, m.h, 2, (x, y) => fbm(x * 0.13 + 7, y * 0.13, 61, 2));
    const lushN = coarseField(W, m.h, 2, (x, y) => fbm(x * 0.08 + 3, y * 0.08, 67, 3));
    const cloverN = coarseField(W, m.h, 4, (x, y) => fbm(x * 0.3 + 11, y * 0.3, 71, 3));
    const flowerN = coarseField(W, m.h, 4, (x, y) => fbm(x * 0.22, y * 0.22 + 5, 73, 3));
    const tallN = coarseField(W, m.h, 4, (x, y) => fbm(x * 0.16, y * 0.16, 79, 3));

    // distance (tiles) to the nearest water tile: lush banks, no blades on the shore
    const wd = new Float32Array(W * m.h).fill(1e3);
    for (let i = 0; i < W * m.h; i++) if (m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Bridge) wd[i] = 0;
    const relax = (i: number, j: number, c: number) => {
      if (wd[j] + c < wd[i]) wd[i] = wd[j] + c;
    };
    for (let y = 0; y < m.h; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (x > 0) relax(i, i - 1, 1);
        if (y > 0) relax(i, i - W, 1);
        if (x > 0 && y > 0) relax(i, i - W - 1, 1.414);
        if (x < W - 1 && y > 0) relax(i, i - W + 1, 1.414);
      }
    for (let y = m.h - 1; y >= 0; y--)
      for (let x = W - 1; x >= 0; x--) {
        const i = y * W + x;
        if (x < W - 1) relax(i, i + 1, 1);
        if (y < m.h - 1) relax(i, i + W, 1);
        if (x < W - 1 && y < m.h - 1) relax(i, i + W + 1, 1.414);
        if (x > 0 && y < m.h - 1) relax(i, i + W - 1, 1.414);
      }
    const waterD = coarseField(W, m.h, 1, (x, y) => wd[Math.max(0, Math.min(m.h - 1, Math.floor(y))) * W + Math.max(0, Math.min(W - 1, Math.floor(x)))]);

    // distance fields to roads and tracks (stamped per segment)
    const roadD = new Float32Array(N * N).fill(99);
    const roadW = new Float32Array(N * N);
    const trackD = new Float32Array(N * N).fill(99);
    const stamp = (pts: { x: number; y: number }[], reach: number, dist: Float32Array, width: number, wout: Float32Array | null) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - reach) * P));
        const x1 = Math.min(N - 1, Math.ceil((Math.max(a.x, b.x) + reach) * P));
        const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - reach) * P));
        const y1 = Math.min(N - 1, Math.ceil((Math.max(a.y, b.y) + reach) * P));
        for (let y = y0; y <= y1; y++)
          for (let x = x0; x <= x1; x++) {
            const d = segDist((x + 0.5) / P, (y + 0.5) / P, a, b);
            const k = y * N + x;
            if (d - width / 2 < dist[k] - (wout ? wout[k] / 2 : 0)) {
              dist[k] = d;
              if (wout) wout[k] = width;
            }
          }
      }
    };
    for (const r of L.roads) stamp(r.pts, r.width / 2 + 1, roadD, r.width, roadW);
    for (const t of L.tracks) stamp(t.pts, 1, trackD, t.width, null);
    // trodden footpaths: village houses to the nearest road, and between neighbouring houses
    const pathD = new Float32Array(N * N).fill(99);
    for (const p of footpaths(m, L)) stamp(p, 0.7, pathD, 0, null);

    // fields: coverage + type + row direction (dilated so filtering stays stable)
    const fieldMask = new Float32Array(N * N);
    for (const f of L.fields) {
      const ca = Math.cos(f.angle);
      const sa = Math.sin(f.angle);
      const R = Math.hypot(f.hl, f.hw) + 1;
      const x0 = Math.max(0, Math.floor((f.cx - R) * P));
      const x1 = Math.min(N - 1, Math.ceil((f.cx + R) * P));
      const y0 = Math.max(0, Math.floor((f.cy - R) * P));
      const y1 = Math.min(N - 1, Math.ceil((f.cy + R) * P));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const px = (x + 0.5) / P - f.cx;
          const py = (y + 0.5) / P - f.cy;
          const a = px * ca + py * sa;
          const b = -px * sa + py * ca;
          const qx = Math.abs(a) - f.hl;
          const qy = Math.abs(b) - f.hw;
          const sd = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
          if (sd > 0.8) continue;
          const k = y * N + x;
          const cov = Math.max(0, Math.min(1, 0.5 - sd * P));
          if (cov >= fieldMask[k] || field[k * 4 + 1] === 0) {
            field[k * 4 + 1] = 1 + f.type * 60;
            field[k * 4 + 2] = (ca * 0.5 + 0.5) * 255;
            field[k * 4 + 3] = (sa * 0.5 + 0.5) * 255;
          }
          if (cov > fieldMask[k]) fieldMask[k] = cov;
        }
    }
    for (let k = 0; k < N * N; k++) field[k * 4] = fieldMask[k] * 255;

    // tree shade (soft AO under canopies)
    const shade = new Float32Array(N * N);
    for (const t of trees) {
      const R = t.r * 1.3;
      const x0 = Math.max(0, Math.floor((t.x - R) * P));
      const x1 = Math.min(N - 1, Math.ceil((t.x + R) * P));
      const y0 = Math.max(0, Math.floor((t.y - R) * P));
      const y1 = Math.min(N - 1, Math.ceil((t.y + R) * P));
      for (let y = y0; y <= y1; y++)
        for (let x = x0; x <= x1; x++) {
          const d = Math.hypot((x + 0.5) / P - t.x, (y + 0.5) / P - t.y) / R;
          if (d < 1) shade[y * N + x] += (1 - d * d) * 0.35;
        }
    }

    const nearStart = (x: number, y: number) => {
      let best = 99;
      for (const s of m.starts) best = Math.min(best, Math.hypot(x - s.x - 0.5, y - s.y - 0.5));
      return best;
    };
    const yard = (x: number, y: number) => {
      let best = 99;
      for (const st of m.structures) {
        const dx = Math.max(st.x - x, 0, x - st.x - st.w);
        const dy = Math.max(st.y - y, 0, y - st.y - st.h);
        best = Math.min(best, Math.hypot(dx, dy));
      }
      return best;
    };

    const w = [0, 0, 0, 0, 0, 0, 0];
    const ctl = this.ctl;
    const bladeMap = this.blades;
    for (let py = 0; py < N; py++) {
      for (let px = 0; px < N; px++) {
        const x = (px + 0.5) / P;
        const y = (py + 0.5) / P;
        const k = py * N + px;
        // jittered bilinear blend of the per tile weights -> organic borders
        const bx = x - 0.5 + jx(x, y) * 0.9;
        const by = y - 0.5 + jy(x, y) * 0.9;
        const x0 = Math.floor(bx);
        const y0 = Math.floor(by);
        const fx = bx - x0;
        const fy = by - y0;
        const sx = fx * fx * (3 - 2 * fx);
        const sy = fy * fy * (3 - 2 * fy);
        for (let c = 0; c < TW; c++)
          w[c] = (tw(x0, y0, c) * (1 - sx) + tw(x0 + 1, y0, c) * sx) * (1 - sy) + (tw(x0, y0 + 1, c) * (1 - sx) + tw(x0 + 1, y0 + 1, c) * sx) * sy;
        let dirt = w[0];
        let rock = w[1];
        let sand = w[2];
        let mud = w[3];
        const pn = patchN(x, y);
        // sim dirt patches: broken, patchy bare ground rather than a solid blob
        dirt *= smooth(0.25, 0.6, pn + dirt * 0.45);
        // slopes turn rocky
        const h0 = groundHeight(m, x, y);
        const slope = Math.abs(groundHeight(m, x + 0.3, y) - h0) + Math.abs(groundHeight(m, x, y + 0.3) - h0);
        rock = Math.max(rock, smooth(0.16, 0.34, slope + (pn - 0.5) * 0.12));
        // riverbank: wet sand -> mud at the waterline
        const wl = h0 - WATER_LEVEL;
        if (wl < 0.45) {
          const wet = 1 - smooth(-0.05, 0.45, wl);
          sand = Math.max(sand, wet * 0.7 * smooth(0.2, 0.55, pn + 0.2));
          mud = Math.max(mud, (1 - smooth(-0.25, 0.12, wl)) * 0.6);
        }
        // forest floor
        const forest = w[6];
        dirt = Math.max(dirt, forest * 0.35 * smooth(0.3, 0.7, pn));
        // tracks with ruts, road shoulders
        const td = trackD[k];
        const trk = 1 - smooth(0.16, 0.36, td + (pn - 0.5) * 0.12);
        dirt = Math.max(dirt, trk);
        const rut = trk * Math.exp(-Math.pow((td - 0.13) / 0.05, 2));
        mud = Math.max(mud, rut * 0.55);
        const rd = roadD[k] - roadW[k] / 2;
        const shoulder = 1 - smooth(0.0, 0.45, rd + (pn - 0.5) * 0.25);
        dirt = Math.max(dirt, shoulder * 0.85);
        // village yards and the trampled ground of the bases
        const yd = yard(x, y);
        if (yd < 1.2) dirt = Math.max(dirt, (1 - smooth(0.2, 1.2, yd)) * smooth(0.35, 0.65, pn) * 0.8);
        const sd = nearStart(x, y);
        const base = 1 - smooth(6, 12, sd);
        dirt = Math.max(dirt, base * 0.45 * smooth(0.45, 0.75, pn));
        // fields sit on ploughed soil (seen at the margins)
        const fm = fieldMask[k];
        if (fm > 0) dirt = Math.max(dirt, fm);

        // normalise so the total never exceeds 1 (grass takes the rest)
        let tot = dirt + rock + sand + mud;
        if (tot > 1) {
          dirt /= tot;
          rock /= tot;
          sand /= tot;
          mud /= tot;
          tot = 1;
        }
        const o = k * 4;
        splat[o] = dirt * 255;
        splat[o + 1] = rock * 255;
        splat[o + 2] = sand * 255;
        splat[o + 3] = mud * 255;

        // tint: macro brightness / hue variation, wetness, shade, ore stain
        const mac = macro(x, y);
        const bl = blotch(x, y);
        const br = 0.86 + mac * 0.24 + (bl - 0.5) * 0.16;
        const hue = (hueN(x, y) - 0.5) * 0.18;
        let r = br * (1 + hue);
        let g = br;
        let b = br * (1 - hue * 0.6);
        if (wl < 0.35) {
          const wet = 1 - smooth(-0.1, 0.35, wl);
          r *= 1 - wet * 0.3;
          g *= 1 - wet * 0.27;
          b *= 1 - wet * 0.22;
        }
        const sh = Math.min(0.6, shade[k] + forest * 0.12);
        r *= 1 - sh;
        g *= 1 - sh * 0.92;
        b *= 1 - sh * 0.85;
        const ore = w[4];
        if (ore > 0) {
          r *= 1 - ore * 0.08;
          g *= 1 - ore * 0.3;
          b *= 1 - ore * 0.42;
        }
        const gem = w[5];
        if (gem > 0) {
          r *= 1 + gem * 0.05;
          g *= 1 + gem * 0.12;
          b *= 1 + gem * 0.3;
        }
        tint[o] = Math.min(255, r * 127.5);
        tint[o + 1] = Math.min(255, g * 127.5);
        tint[o + 2] = Math.min(255, b * 127.5);
        // dryness: macro patches, higher ground, road verges and bases are drier
        let dry = smooth(0.45, 0.8, dryN(x, y)) * 0.6 + Math.max(0, h0 - 0.8) * 0.2 + (bl - 0.5) * 0.25;
        dry += (1 - smooth(0, 1.2, rd)) * 0.2 + base * 0.2;
        dry -= (1 - smooth(0.1, 0.7, wl)) * 0.4 + forest * 0.2;
        // lushness: river banks, low ground and damp hollows; hills and slopes are drier
        const dW = waterD(x, y);
        let lush = (1 - smooth(0.6, 6, dW)) * 0.8 + smooth(0.5, -0.4, h0) * 0.35 + (lushN(x, y) - 0.45) * 0.9 + forest * 0.25;
        lush -= slope * 1.6 + base * 0.3;
        lush = Math.max(0, Math.min(1, lush));
        dry = dry * 0.85 - lush * 0.45 + slope * 1.2;
        tint[o + 3] = Math.max(0, Math.min(1, dry)) * 255;
        const dryC = Math.max(0, Math.min(1, dry));
        // footpaths, trampled base and yard ground
        const pd = pathD[k];
        const path = (1 - smooth(0.06, 0.24, pd + (pn - 0.5) * 0.08)) * (1 - fm) * smooth(0.2, 0.4, wl);
        let worn = Math.max(path, base * 0.55 * smooth(0.3, 0.6, pn), yd < 1.5 ? (1 - smooth(0.3, 1.5, yd)) * 0.45 : 0, shoulder * 0.35);
        worn = Math.min(1, worn);
        ctl[o] = lush * 255;
        ctl[o + 1] = smooth(0.58, 0.72, cloverN(x, y)) * (1 - dryC * 0.8) * (1 - worn) * 255;
        ctl[o + 2] = smooth(0.6, 0.76, flowerN(x, y)) * (1 - dryC * 0.6) * (1 - worn) * (1 - base) * (1 - forest * 0.7) * 255;
        ctl[o + 3] = worn * 255;
        // 3D grass blades: grass layer only, off paths, roads, tracks, fields, yards and the shore
        const grassW = 1 - tot;
        let dens = smooth(0.5, 0.85, grassW);
        dens *= 1 - smooth(0.02, 0.25, fm);
        dens *= smooth(0.15, 0.5, rd) * smooth(0.25, 0.5, td);
        dens *= smooth(0.3, 0.6, wl) * smooth(0.9, 1.6, dW);
        dens *= 1 - Math.max(path * 1.3, worn * 0.7);
        dens *= smooth(0.45, 0.9, yd);
        dens *= 1 - forest * 0.45;
        if (w[4] > 0.05 || w[5] > 0.05) dens *= 0.2;
        bladeMap[o] = Math.max(0, Math.min(1, dens)) * 255;
        const tall = 0.35 + smooth(0.42, 0.75, tallN(x, y)) * 0.5 + lush * 0.25 - dryC * 0.2 - base * 0.3 - worn * 0.3;
        bladeMap[o + 1] = Math.max(0, Math.min(1, tall)) * 255;
      }
    }
  }
}

// ------------------------------------------------------------------ GLSL

const TERRAIN_PARS = /* glsl */ `
varying vec3 vTerrW;
uniform sampler2D splatTex;
uniform sampler2D tintTex;
uniform sampler2D fieldTex;
uniform sampler2D detailTex;
uniform sampler2D grassTex;
uniform sampler2D ctlTex;
uniform vec2 terrMapSize;
uniform vec3 cDirt, cRock, cSand, cMud, cSoil, cCrop, cWheat, cHay;
float terrH;
float terrRough;
float wxPud;
float terrPomAO = 0.0;
vec2 wxHash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
#if TERR_POM > 0
// depth (0 = top) of the soil / rock detail relief at tw, same blend as TERRAIN_MAP
float terrPomDepth(vec2 tw, float rockW, vec2 gAx, vec2 gAy, vec2 gBx, vec2 gBy) {
  vec2 rw = vec2(tw.x * 0.8 - tw.y * 0.6, tw.x * 0.6 + tw.y * 0.8);
  vec2 a = textureGrad(detailTex, tw * 0.29, gAx, gAy).gb;
  vec2 b = textureGrad(detailTex, rw * 0.113 + 0.31, gBx, gBy).gb;
  vec2 d = clamp((a * 0.6 + b * 0.4 - 0.5) * 1.45 + 0.5, 0.0, 1.0);
  return 1.0 - mix(d.x, d.y, rockW);
}
#endif
`;

const TERRAIN_MAP = /* glsl */ `
{
  vec2 tw = vTerrW.xz;
  vec2 mUV = tw / terrMapSize;
  vec4 spl = texture2D(splatTex, mUV);
  vec4 tnt = texture2D(tintTex, mUV);
  vec4 fld = texture2D(fieldTex, mUV);
  vec4 ctl = texture2D(ctlTex, mUV);
#if TERR_POM > 0
  // relief mapping on soil / rock: march the view ray down into the detail
  // height field (world xz = tangent plane; the ground is mostly flat) and
  // shade the detail where it hits. Control maps stay at the true position.
  {
    float relief = (spl.r * 0.1 + spl.g * 0.26) * (1.0 - smoothstep(0.3, 0.7, fld.r));
    if (relief > 0.004) {
      vec3 V = normalize(cameraPosition - vTerrW);
      vec2 dir = -V.xz / max(V.y, 0.3) * relief;
      float rockW = spl.g / max(spl.r + spl.g, 1e-3);
      vec2 gAx = dFdx(tw * 0.29);
      vec2 gAy = dFdy(tw * 0.29);
      vec2 rw0 = vec2(tw.x * 0.8 - tw.y * 0.6, tw.x * 0.6 + tw.y * 0.8) * 0.113;
      vec2 gBx = dFdx(rw0);
      vec2 gBy = dFdy(rw0);
      float stepD = 1.0 / float(TERR_POM);
      float layer = 0.0;
      float dPrev = 0.0;
      float lPrev = 0.0;
      float dCur = terrPomDepth(tw, rockW, gAx, gAy, gBx, gBy);
      for (int i = 0; i < TERR_POM; i++) {
        if (layer < dCur) {
          lPrev = layer;
          dPrev = dCur;
          layer += stepD;
          dCur = terrPomDepth(tw + dir * layer, rockW, gAx, gAy, gBx, gBy);
        }
      }
      // linear refinement between the last two layers
      float a = dCur - layer;
      float b = dPrev - lPrev;
      float t = clamp(a / min(a - b, -1e-4), 0.0, 1.0);
      float hitD = mix(layer, lPrev, t);
      tw += dir * hitD;
      // cavities sit in their own shade
      terrPomAO = hitD * 0.4 * clamp(relief * 9.0, 0.0, 1.0);
    }
  }
#endif
  vec2 rw = vec2(tw.x * 0.8 - tw.y * 0.6, tw.x * 0.6 + tw.y * 0.8);
  vec4 dA = texture2D(detailTex, tw * 0.29);
  vec4 dB = texture2D(detailTex, rw * 0.113 + 0.31);
  vec4 det = clamp((dA * 0.6 + dB * 0.4 - 0.5) * 1.45 + 0.5, 0.0, 1.0);

  // ---- grass micro texture: two decorrelated (rotated, rescaled) samples,
  // chosen region by region by low-frequency noise, blended so the contrast
  // survives - no visible repeat at any zoom
  vec2 gq = tw * (1.0 / GRASS_TILES);
  vec2 gq2 = vec2(gq.x * 0.799 - gq.y * 0.602, gq.x * 0.602 + gq.y * 0.799) * 0.83 + vec2(0.37, 0.11);
  vec4 gA = texture2D(grassTex, gq);
  vec4 gB = texture2D(grassTex, gq2);
  vec4 gnz = texture2D(fogNoise, tw * 0.043);
  float gsel = smoothstep(0.36, 0.64, gnz.r);
  float gH = clamp(((gA.r - 0.5) * (1.0 - gsel) + (gB.r - 0.5) * gsel) * inversesqrt(gsel * gsel + (1.0 - gsel) * (1.0 - gsel)) + 0.5, 0.0, 1.0);
  vec4 gT = mix(gA, gB, gsel);
  // fine detail fades to its mean where it would only shimmer
  float gFine = 1.0 - smoothstep(0.5, 1.5, fwidth(gq.x) * 40.0);
  gH = mix(0.5, gH, 0.35 + 0.65 * gFine);
  float gDrift = (gnz.b - 0.5) + (texture2D(fogNoise, tw * 0.0117 + 0.5).g - 0.5);

  // height-blended layer weights
  float wG = clamp(1.0 - spl.r - spl.g - spl.b - spl.a, 0.0, 1.0);
  vec4 present = smoothstep(0.0, 0.06, spl);
  vec4 hw = spl + vec4(det.g, det.b, det.a, det.g) * vec4(0.5, 0.55, 0.35, 0.3);
  float hg = wG + det.r * 0.5;
  float mx = max(max(max(hw.x, hw.y), max(hw.z, hw.w)), hg);
  vec4 bw = max(hw - mx + 0.2, 0.0) * present;
  float bg = max(hg - mx + 0.2, 0.0) * smoothstep(0.0, 0.06, wG);
  float tot = bg + bw.x + bw.y + bw.z + bw.w + 1e-4;
  bg /= tot;
  bw /= tot;

  float dry = clamp(tnt.a + (dB.r - 0.5) * 0.3 + (det.g - 0.5) * 0.15, 0.0, 1.0);
  vec3 gc = grassBase(ctl.r, dry, gDrift * 0.8);
  // single blades: some fresh and bright, a few dead straw ones (more where it is dry)
  gc = mix(gc, gcFresh, smoothstep(0.66, 0.97, gT.g) * (0.5 - dry * 0.3) * gFine);
  gc = mix(gc, gcDry * vec3(1.2, 1.08, 0.78), smoothstep(0.14, 0.0, gT.g) * (0.3 + dry * 0.5) * gFine);
  // dark gaps between the blades, lit tips; clump scale from the detail map
  vec3 grass = gc * (0.5 + gH * 0.82) * (0.8 + det.r * 0.4);
  // clover patches: rounder, darker, bluer leaves
  float clov = ctl.g * smoothstep(0.2, 0.5, gT.b);
  grass = mix(grass, gcClover * (0.72 + gT.b * 0.5), clov * 0.85);
  // worn ground (paths, trampled yards): soil shows through the gaps first
  float gSoil = smoothstep(0.0, 0.3, ctl.a * 1.15 - gH * 0.5 + (det.g - 0.5) * 0.35 * ctl.a);
  grass = mix(grass, cDirt * (0.62 + det.g * 0.55), gSoil);
  // wildflowers: crisp heads up close, a faint wash of colour further out
  if (ctl.b > 0.01) {
    float sp = texture2D(fogNoise, tw * 0.09 + 0.7).a;
    vec3 fcol = sp < 0.42 ? vec3(0.82, 0.82, 0.72) : sp < 0.68 ? vec3(0.86, 0.6, 0.06) : vec3(0.42, 0.22, 0.66);
    float fl = ctl.b * smoothstep(0.3, 0.6, gT.a) * (1.0 - gSoil);
    grass = mix(grass, fcol, fl * gFine + ctl.b * 0.1 * (1.0 - gFine));
  }
  vec3 dirt = cDirt * (0.55 + det.g * 0.9);
  vec3 rock = cRock * (0.45 + det.b * 1.1);
  vec3 sand = cSand * (0.72 + det.a * 0.56);
  vec3 mud = cMud * (0.7 + det.g * 0.5);
  vec3 col = grass * bg + dirt * bw.x + rock * bw.y + sand * bw.z + mud * bw.w;
  terrH = (gH * 0.8 + det.r * 0.35 + clov * gT.b * 0.4) * bg + det.g * bw.x * 1.0 + det.b * bw.y * 2.2 + det.a * bw.z * 0.5 + det.g * bw.w * 0.3;
  terrRough = 0.96 - bw.w * 0.4 - bw.y * 0.12;

  // farm fields
  float fMask = smoothstep(0.3, 0.7, fld.r);
  vec2 fdir = normalize(fld.ba * 2.0 - 1.0 + vec2(1e-4, 0.0));
  float across = dot(tw, vec2(-fdir.y, fdir.x));
  float aa = fwidth(across);
  if (fMask > 0.001) {
    float ftype = floor((fld.g * 255.0 - 1.0) / 60.0 + 0.5);
    vec3 fc;
    float fh;
    if (ftype < 0.5) {
      // ploughed: furrows
      float per = 0.17;
      float ph = across / per;
      float s = 0.5 + 0.5 * sin(ph * 6.2832 + det.g * 1.2);
      float k = clamp(1.0 - aa / per * 1.4, 0.0, 1.0);
      s = mix(0.5, s, k);
      fc = cSoil * (0.62 + s * 0.6) * (0.8 + det.g * 0.4);
      fh = s * 1.2 + det.g * 0.4;
    } else if (ftype < 1.5) {
      // green crop rows on soil
      float per = 0.2;
      float s = 0.5 + 0.5 * sin(across / per * 6.2832);
      float k = clamp(1.0 - aa / per * 1.4, 0.0, 1.0);
      float plant = smoothstep(0.35, 0.75, s + (det.r - 0.5) * 0.6);
      plant = mix(0.62, plant, k);
      fc = mix(cSoil * (0.7 + det.g * 0.5), cCrop * (0.7 + det.r * 0.6), plant);
      fh = plant * 1.0 + det.r * 0.3;
    } else if (ftype < 2.5) {
      // ripe wheat: fine rows and tramlines
      float per = 0.12;
      float s = 0.5 + 0.5 * sin(across / per * 6.2832);
      float k = clamp(1.0 - aa / per * 1.4, 0.0, 1.0);
      float tram = smoothstep(0.06, 0.02, abs(fract(across / 2.2) - 0.5) - 0.03) * clamp(1.0 - aa * 6.0, 0.0, 1.0);
      fc = cWheat * (0.8 + mix(0.5, s, k) * 0.25 + (det.r - 0.5) * 0.35 + (dB.g - 0.5) * 0.25);
      fc = mix(fc, cSoil * 0.9, tram * 0.7);
      fh = mix(0.5, s, k) * 0.5 + det.r * 0.5 - tram * 0.6;
    } else {
      // mown meadow: lawn-like mowing stripes, short fresh grass
      float sw = fract(across / 1.1);
      float st = smoothstep(0.47, 0.53, sw) * (1.0 - smoothstep(0.97, 1.0, sw));
      st = mix(0.5, st, clamp(1.0 - aa * 2.0, 0.0, 1.0));
      vec3 lawn = grassBase(0.3 + ctl.r * 0.4, 0.12, gDrift * 0.5);
      fc = lawn * (0.58 + gH * 0.5) * (0.84 + st * 0.26) * (0.92 + det.r * 0.16);
      fh = gH * 0.45;
    }
    // darker rim along the field edge
    fc *= 0.82 + 0.18 * smoothstep(0.5, 0.95, fld.r);
    col = mix(col, fc, fMask);
    terrH = mix(terrH, fh, fMask);
    terrRough = mix(terrRough, 0.95, fMask);
  }
  col *= tnt.rgb * 2.0;
#if TERR_POM > 0
  col *= 1.0 - terrPomAO;
#endif
  diffuseColor.rgb = col;
  // rain: puddles collect in low, muddy spots (flat, dark, mirror-like)
  wxPud = 0.0;
  if (wxWet > 0.001) {
    float n1 = texture2D(fogNoise, tw * 0.085 + 0.13).g;
    float n2 = texture2D(fogNoise, tw * 0.33 + 0.57).r;
    float lowSpot = n1 * 0.78 + n2 * 0.22 - terrH * 0.1 + (bw.x + bw.w) * 0.1 - bw.y * 0.25 - fMask * 0.05;
    // puddles shrink into the deepest spots as the ground dries (wxWet 1 = full size)
    float wxPudT = 0.65 + (1.0 - wxWet) * 0.16;
    wxPud = smoothstep(wxPudT, wxPudT + 0.03, lowSpot) * min(1.0, wxWet * 2.5);
    diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 0.62 + vec3(0.03, 0.035, 0.042), wxPud);
    terrRough = mix(terrRough, 0.03, wxPud);
    terrH = mix(terrH, 0.0, wxPud);
  }
}
`;

const TERRAIN_NORMAL = /* glsl */ `
{
  vec2 dHdxy = vec2(dFdx(terrH), dFdy(terrH)) * 0.022;
  vec3 vSigmaX = dFdx(-vViewPosition);
  vec3 vSigmaY = dFdy(-vViewPosition);
  vec3 R1 = cross(vSigmaY, normal);
  vec3 R2 = cross(normal, vSigmaX);
  float fDet = dot(vSigmaX, R1) * faceDirection;
  vec3 vGrad = sign(fDet) * (dHdxy.x * R1 + dHdxy.y * R2);
  normal = normalize(abs(fDet) * normal - vGrad);
  if (wxPud * wxRain > 0.01) {
    // rain drop ripples (only while it rains: wxRain): one expanding ring per 0.45-tile cell, random phase
    vec2 rp = vTerrW.xz / 0.45;
    vec2 ci = floor(rp);
    vec2 g = vec2(0.0);
    for (int j = 0; j < 4; j++) {
      vec2 c = ci + vec2(float(j - (j / 2) * 2), float(j / 2));
      vec2 h = wxHash2(c);
      vec2 o = rp - (c + 0.2 + h * 0.6);
      float ph = fract(wxTime * 0.9 + h.x * 7.3);
      float d = length(o) - ph * 0.55;
      float wv = sin(d * 38.0) * exp(-abs(d) * 14.0) * (1.0 - ph);
      g += normalize(o + 1e-4) * wv;
    }
    normal = normalize(normal + (viewMatrix * vec4(g.x, 0.0, g.y, 0.0)).xyz * 0.35 * wxPud * wxRain);
  }
}
`;
