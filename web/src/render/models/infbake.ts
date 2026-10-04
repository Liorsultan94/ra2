import * as THREE from 'three';

/*
 * Baked surface textures for the infantry (models/infantry.ts), generated once
 * on first use and shared by every soldier:
 *
 *  - gearWebbing(): nylon load-bearing gear - rows of MOLLE / PALS webbing
 *    (1" straps with bar-tack stitching every 1.5"), a cordura weave and soft
 *    wear. Near-white albedo: the kit colour (coyote, ranger green, olive ...)
 *    comes from material.color, so one texture serves every nation.
 *
 * Tile: 128 px = 1 / 3.5 m (worldUV / cylUV at 3.5 repeats per metre), i.e.
 * 8 webbing rows of ~3.6 cm per tile.
 */

export interface InfTexSet {
  map: THREE.Texture;
  normalMap: THREE.Texture;
  roughnessMap: THREE.Texture;
}

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Periodic value noise on an N-pixel tile with `cells` cells per side. */
function vnoise(x: number, y: number, N: number, cells: number, s: number) {
  const fx = (x / N) * cells;
  const fy = (y / N) * cells;
  const xi = Math.floor(fx);
  const yi = Math.floor(fy);
  const u = fx - xi;
  const v = fy - yi;
  const a = hash(xi % cells, yi % cells, s);
  const b = hash((xi + 1) % cells, yi % cells, s);
  const c = hash(xi % cells, (yi + 1) % cells, s);
  const d = hash((xi + 1) % cells, (yi + 1) % cells, s);
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

function dataTex(N: number, data: Uint8Array, srgb: boolean) {
  const t = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.needsUpdate = true;
  return t;
}

/** Tangent-space normal map from a periodic height field. */
function normals(N: number, h: Float32Array, k: number) {
  const out = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const l = h[y * N + ((x + N - 1) % N)];
      const r = h[y * N + ((x + 1) % N)];
      const u = h[((y + N - 1) % N) * N + x];
      const d = h[((y + 1) % N) * N + x];
      let nx = (l - r) * k;
      let ny = (d - u) * k;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);
      nx /= len;
      ny /= len;
      const i = (y * N + x) * 4;
      out[i] = Math.round((nx * 0.5 + 0.5) * 255);
      out[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
      out[i + 2] = Math.round((nz / len) * 0.5 * 255 + 127.5);
      out[i + 3] = 255;
    }
  return out;
}

let webbing: InfTexSet | null = null;

/** MOLLE webbing on cordura (near-white albedo, tinted by material.color). */
export function gearWebbing(): InfTexSet {
  if (webbing) return webbing;
  const N = 128;
  const ROW = 16; // px per webbing row (strap + gap)
  const STRAP = 9; // strap height in px
  const TACK = 24; // bar-tack spacing in px
  const h = new Float32Array(N * N);
  const alb = new Uint8Array(N * N * 4);
  const rough = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const ry = y % ROW;
      const strap = ry >= 2 && ry < 2 + STRAP;
      const edge = strap && (ry === 2 || ry === 1 + STRAP);
      // bar-tack stitching: short vertical seams where the strap is sewn down
      const tx = x % TACK;
      const tack = strap && (tx === 0 || tx === 1);
      // cordura weave (fine basket) + soft wear / dirt
      const weave = ((x >> 1) + (y >> 1)) & 1 ? 0.03 : -0.03;
      const wear = vnoise(x, y, N, 8, 11) * 0.6 + vnoise(x, y, N, 16, 13) * 0.4;
      let ht = 0.3 + weave * 0.3;
      let a = 0.9 + weave + (wear - 0.5) * 0.14;
      if (strap) {
        ht = 0.75 + (((x >> 1) & 1) ? 0.03 : 0);
        a = 0.97 + (wear - 0.5) * 0.1;
        if (edge) {
          ht -= 0.15;
          a *= 0.86;
        }
        if (tack) {
          ht -= 0.3;
          a *= 0.72;
        }
      } else if (ry === 1 || ry === 2 + STRAP) a *= 0.7; // shadow under the strap
      h[y * N + x] = ht;
      const v = Math.max(0, Math.min(255, Math.round(a * 235)));
      const i = (y * N + x) * 4;
      alb[i] = alb[i + 1] = alb[i + 2] = v;
      alb[i + 3] = 255;
      const rv = Math.round((0.86 + (strap ? -0.06 : 0.04) + (wear - 0.5) * 0.08) * 255);
      rough[i] = rough[i + 1] = rough[i + 2] = rv;
      rough[i + 3] = 255;
    }
  webbing = { map: dataTex(N, alb, true), normalMap: dataTex(N, normals(N, h, 2.4), false), roughnessMap: dataTex(N, rough, false) };
  return webbing;
}
