#!/usr/bin/env node
/*
 * Offline baker for the explosion / smoke / fire flipbooks (web/public/fx/).
 *
 *   node tools/bake-fx.mjs            (needs ImageMagick `convert` with WebP support)
 *
 * Every effect is a short volumetric simulation evaluated on a 128 x 128 x 72
 * density grid per frame (pyroclastic noise-displaced puffs, jets, rings and
 * flame columns, all driven by 3D value-noise fbm and advected over time),
 * plus a temperature field. Each frame is then "photographed" orthographically:
 *
 *   - six directional light-transmittance volumes are swept along the grid
 *     axes (light from right / top / left / bottom / front / back) with a cheap
 *     multiple-scattering approximation, and integrated along the view ray
 *     with the view transmittance -> "6-way lightmaps" (as used by Unity's
 *     VFX Graph / modern engines). At runtime the sprite is relit from any sun /
 *     sky / fire light direction by weighting the six maps.
 *   - the emissive pass integrates blackbody emission (temperature^n) with the
 *     same view transmittance (self-occluded fire inside the smoke).
 *
 * Output: two RGBA atlases holding 8 effects (4 x 2 blocks of 8 x 8 frames of
 * 128 px), plus half-resolution variants for phones:
 *   fx-a.webp      R = light from +x, G = from +y, B = from -x, A = opacity
 *   fx-b.webp      R = from -y, G = from the camera, B = from behind, A = emission
 * Lightmaps / emission are stored sqrt-encoded (more precision in the darks);
 * lightmaps are straight (divided by opacity), emission premultiplied.
 * fx.json describes the layout (see src/render/fx/flipbook.ts).
 */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const FRAME = 128;
const NZ = 72;
const GRID = 8; // 8 x 8 frames per effect
const NF = GRID * GRID;
const BLOCKS_X = 4;
const BLOCKS_Y = 2;

/** Effects, in atlas block order. k = extinction scale, life = suggested runtime seconds. */
const EFFECTS = [
  { name: 'fireball', k: 16, life: 3.2, loop: false },
  { name: 'burst', k: 14, life: 0.9, loop: false },
  { name: 'fuel', k: 20, life: 3.8, loop: false },
  { name: 'dust', k: 10, life: 2.6, loop: false },
  { name: 'smoke', k: 9, life: 6, loop: false },
  { name: 'flame', k: 5, life: 2.4, loop: true },
  { name: 'sparks', k: 1, life: 1.0, loop: false },
  { name: 'airburst', k: 15, life: 3.0, loop: false },
];

// ------------------------------------------------------------------ noise

function makeNoise(seed) {
  const perm = new Uint8Array(512);
  const val = new Float32Array(256);
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const p = [...Array(256).keys()];
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
  for (let i = 0; i < 256; i++) val[i] = rnd();
  const noise = (x, y, z) => {
    const xf = Math.floor(x), yf = Math.floor(y), zf = Math.floor(z);
    const xi = xf & 255, yi = yf & 255, zi = zf & 255;
    let u = x - xf, v = y - yf, w = z - zf;
    u = u * u * (3 - 2 * u);
    v = v * v * (3 - 2 * v);
    w = w * w * (3 - 2 * w);
    const a = perm[xi] + yi, b = perm[xi + 1] + yi;
    const aa = perm[a] + zi, ab = perm[a + 1] + zi, ba = perm[b] + zi, bb = perm[b + 1] + zi;
    const x1 = val[perm[aa]] + (val[perm[ba]] - val[perm[aa]]) * u;
    const x2 = val[perm[ab]] + (val[perm[bb]] - val[perm[ab]]) * u;
    const x3 = val[perm[aa + 1]] + (val[perm[ba + 1]] - val[perm[aa + 1]]) * u;
    const x4 = val[perm[ab + 1]] + (val[perm[bb + 1]] - val[perm[ab + 1]]) * u;
    const y1 = x1 + (x2 - x1) * v;
    const y2 = x3 + (x4 - x3) * v;
    return y1 + (y2 - y1) * w;
  };
  /** Turbulence (sum of |2n-1|): rounded lobes with sharp creases -> cauliflower billows. 0..~1 */
  const turb = (x, y, z, oct) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += Math.abs(noise(x, y, z) * 2 - 1) * amp;
      norm += amp;
      // rotate the domain between octaves (hides the value-noise lattice)
      const nx = 0.0 * x + 1.6 * y + 1.2 * z + 17.1;
      const ny = -1.6 * x + 0.72 * y - 0.96 * z + 3.7;
      const nz = -1.2 * x - 0.96 * y + 1.28 * z + 9.3;
      x = nx;
      y = ny;
      z = nz;
      amp *= 0.5;
    }
    return sum / norm;
  };
  const fbm = (x, y, z, oct) => {
    let sum = 0, amp = 0.5, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += noise(x, y, z) * amp;
      norm += amp;
      // rotate the domain between octaves (hides the value-noise lattice)
      const nx = 0.0 * x + 1.6 * y + 1.2 * z + 17.1;
      const ny = -1.6 * x + 0.72 * y - 0.96 * z + 3.7;
      const nz = -1.2 * x - 0.96 * y + 1.28 * z + 9.3;
      x = nx;
      y = ny;
      z = nz;
      amp *= 0.5;
    }
    return sum / norm;
  };
  return { noise, turb, fbm, rnd };
}

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

// ------------------------------------------------------------------ effect fields

/**
 * Per-frame setup: returns { bound: [cx, cy, cz, r] (skip voxels outside), sample(x, y, z, out) }
 * where sample writes out[0] = density 0..1, out[1] = emission 0..
 */
function effectFrame(name, t, N) {
  const R = makeNoise(name.length * 7919 + 13);
  const { turb, fbm } = N;
  // random, but fixed per effect, sub-billow directions
  const lobes = [];
  for (let i = 0; i < 9; i++) {
    const a = R.rnd() * Math.PI * 2;
    const e = R.rnd() * 1.2 - 0.25;
    lobes.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.45 + R.rnd() * 0.3, R.rnd()]);
  }
  const jets = [];
  for (let i = 0; i < 7; i++) {
    const a = R.rnd() * Math.PI * 2;
    const e = 0.15 + R.rnd() * 1.2;
    jets.push([Math.cos(a) * Math.cos(e), Math.sin(e), Math.sin(a) * Math.cos(e), 0.6 + R.rnd() * 0.5]);
  }
  /** Pyroclastic puff: signed distance to a noise-displaced sphere -> density. */
  const pyro = (x, y, z, cx, cy, cz, r, amp, freq, scroll, oct, edge) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > r * (1 + amp) + 0.02) return 0;
    const n = turb(x * freq + 11.3, y * freq - scroll, z * freq + 5.1, oct);
    return clamp01((r * (1 + amp * (n * 2 - 0.55)) - d) / (edge * r));
  };
  /** Same, with the noise value supplied (one noise field shared by several puffs). */
  const pyroN = (x, y, z, cx, cy, cz, r, amp, n, edge) => {
    const dx = x - cx, dy = y - cy, dz = z - cz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d > r * (1 + amp) + 0.02) return 0;
    return clamp01((r * (1 + amp * (n * 2 - 0.55)) - d) / (edge * r));
  };
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  switch (name) {
    case 'fireball':
    case 'fuel':
    case 'airburst': {
      const fuel = name === 'fuel';
      const air = name === 'airburst';
      const grow = 1 - Math.exp(-(air ? 9 : 6.5) * t);
      const rad = (fuel ? 0.2 : 0.18) + (fuel ? 0.36 : 0.32) * grow + 0.08 * t;
      const cy = air ? -0.05 - 0.08 * t : -0.5 + (fuel ? 0.68 : 0.62) * ease(Math.min(1, t * 1.15));
      const heat = Math.exp(-t * (fuel ? 2.0 : air ? 5.0 : 2.9));
      const amp = 0.38 + 0.25 * t;
      const scroll = t * (fuel ? 3.2 : 2.6);
      const thin = 1 - 0.55 * smooth(0.55, 1, t);
      const stem = air ? 0 : smooth(0.12, 0.35, t) * (1 - 0.6 * smooth(0.7, 1, t));
      return {
        bound: [0, cy, 0, rad * 2.2 + 0.1],
        sample(x, y, z, out) {
          // main ball + sub billows that roll outwards (mushroom cap for the fuel fireball)
          const nA = turb(x * 3.1 + 11.3, y * 3.1 - scroll, z * 3.1 + 5.1, 4);
          let dens = pyroN(x, y, z, 0, cy, 0, rad, amp, nA, 0.22);
          const nB = dens >= 1 ? nA : turb(x * 3.6 + 4.7, y * 3.6 - scroll * 1.1, z * 3.6 + 1.3, 3);
          for (let i = 0; i < lobes.length && dens < 1; i++) {
            const l = lobes[i];
            const off = rad * (0.55 + 0.25 * grow) * l[3];
            const ly = air ? l[1] : Math.max(-0.2, l[1]);
            const lx = l[0] * off * (fuel ? 1.25 : 1);
            const lz = l[2] * off * (fuel ? 1.25 : 1);
            const lyy = cy + ly * off * (fuel ? 0.6 : 0.85) + (fuel ? 0.05 * t : 0);
            const d = pyroN(x, y, z, lx, lyy, lz, rad * (0.48 + 0.12 * l[4]), amp, nB, 0.3);
            if (d > dens) dens = d;
          }
          if (stem > 0 && y < cy) {
            const rr = Math.sqrt(x * x + z * z);
            const w = (fuel ? 0.14 : 0.1) + 0.08 * (cy - y) + 0.06 * fbm(x * 6, y * 6 - scroll, z * 6, 2);
            const sd = clamp01((w - rr) / (w * 0.6)) * stem * smooth(-0.95, -0.6, y) * 0.8;
            if (sd > dens) dens = sd;
          }
          if (!air) dens *= smooth(-0.98, -0.86, y); // sits on the ground
          dens *= thin;
          // temperature: hot core, cooling outwards and over time, flickering
          let emis = 0;
          if (heat > 0.01 && dens > 0) {
            const dx = x, dy = y - cy, dz = z;
            const r01 = Math.sqrt(dx * dx + dy * dy + dz * dz) / rad;
            const flick = 0.75 + 0.5 * fbm(x * 5 + 3, y * 5 - scroll * 1.5, z * 5, 3);
            const temp = clamp01((1.15 - r01 * (fuel ? 0.85 : 1.0)) * heat * flick * 1.4);
            emis = Math.pow(temp, 2.2) * (fuel ? 1.25 : 1);
          }
          out[0] = dens;
          out[1] = emis;
        },
      };
    }
    case 'burst': {
      const grow = 1 - Math.exp(-11 * t);
      const rad = 0.16 + 0.5 * grow;
      const heat = Math.exp(-t * 6);
      const thin = Math.pow(1 - t, 1.3);
      return {
        bound: [0, 0, 0, 1],
        sample(x, y, z, out) {
          let dens = pyro(x, y, z, 0, -0.05, 0, rad, 0.6, 4.2, t * 3, 4, 0.35);
          // jets of debris / fire shooting out
          const d0 = Math.sqrt(x * x + (y + 0.05) * (y + 0.05) + z * z);
          for (const j of jets) {
            const along = x * j[0] + (y + 0.05) * j[1] + z * j[2];
            if (along < 0) continue;
            const len = (0.35 + 0.55 * grow) * j[3];
            if (along > len) continue;
            const perp = Math.sqrt(Math.max(0, d0 * d0 - along * along));
            const w = 0.045 + 0.06 * (along / len);
            const jd = clamp01((w - perp) / w) * (1 - along / len) * 0.9;
            if (jd > dens) dens = jd;
          }
          dens *= thin;
          const r01 = d0 / rad;
          const temp = clamp01((1.2 - r01) * heat * (0.7 + 0.6 * fbm(x * 6, y * 6 - t * 4, z * 6, 2)) * 1.5);
          out[0] = dens;
          out[1] = Math.pow(temp, 2) * 1.2;
        },
      };
    }
    case 'dust': {
      // dirt jets thrown up in a crown, falling back, plus a base surge rolling outwards
      const up = ease(Math.min(1, t * 1.6));
      const fall = smooth(0.35, 1, t);
      const thin = 1 - 0.75 * smooth(0.4, 1, t);
      const surgeR = 0.15 + 0.6 * ease(t);
      return {
        bound: [0, -0.2, 0, 1.05],
        sample(x, y, z, out) {
          let dens = 0;
          const g = -0.9;
          const nJ = turb(x * 5 + 2.1, y * 5 - t * 1.5, z * 5 + 7.7, 3);
          // crown of jets (mostly vertical, fanned)
          for (let i = 0; i < jets.length; i++) {
            const j = jets[i];
            const tilt = 0.35 * (1 - j[1]);
            const top = g + (0.55 + 0.75 * j[3] * (1 - 0.3 * i / jets.length)) * up - 0.35 * fall * fall;
            if (y > top + 0.25 || y < g) continue;
            const h01 = clamp01((y - g) / Math.max(0.05, top - g));
            const ax = j[0] * tilt * (y - g) * 1.4;
            const az = j[2] * tilt * (y - g) * 1.4;
            const rr = Math.hypot(x - ax, z - az);
            const w = 0.06 + 0.12 * h01 + 0.15 * t;
            if (rr > w * 3.2) continue;
            const d = pyroN(x, y, z, ax, Math.min(y, top), az, w, 0.9, nJ, 0.5) * (rr < w * 2 ? 1 : 0);
            const capd = pyroN(x, y, z, ax, top, az, w * 1.25, 0.7, nJ, 0.35);
            dens = Math.max(dens, d * (0.6 + 0.4 * h01), capd);
          }
          // base surge: flat doughnut of dust
          const rr = Math.hypot(x, z);
          const sy = g + 0.08 + 0.12 * t;
          const ring = Math.hypot(rr - surgeR * 0.7, (y - sy) * 1.6);
          const sw = 0.12 + 0.18 * t;
          if (ring < sw * 1.8) {
            const n = turb(x * 4.5, y * 4.5 - t, z * 4.5, 3);
            dens = Math.max(dens, clamp01((sw * (0.7 + 0.8 * n) - ring) / (sw * 0.5)) * 0.85);
          }
          dens *= thin * smooth(g - 0.02, g + 0.06, y);
          out[0] = dens;
          out[1] = 0;
        },
      };
    }
    case 'smoke': {
      const grow = ease(t);
      const rad = 0.3 + 0.32 * grow;
      const thin = 1 - 0.85 * smooth(0.3, 1, t);
      return {
        bound: [0, 0, 0, 1.0],
        sample(x, y, z, out) {
          const nA = turb(x * 2.6 + 11.3, y * 2.6 - t * 1.2, z * 2.6 + 5.1, 4);
          let dens = pyroN(x, y, z, 0, 0.0 + 0.1 * t, 0, rad, 0.45 + 0.4 * t, nA, 0.35 + 0.4 * t);
          for (let i = 0; i < 5 && dens < 1; i++) {
            const l = lobes[i];
            const off = rad * 0.6;
            const d = pyroN(x, y, z, l[0] * off, l[1] * off * 0.7 + 0.1 * t, l[2] * off, rad * 0.55, 0.5 + 0.4 * t, nA, 0.4 + 0.4 * t);
            if (d > dens) dens = d;
          }
          // erosion: wisps thin out as the puff ages
          const ero = fbm(x * 7, y * 7 - t * 2, z * 7, 2);
          dens *= thin * clamp01(1 - (0.25 + 0.7 * t) * smooth(0.35, 0.7, ero) * 0.9);
          out[0] = dens;
          out[1] = 0;
        },
      };
    }
    case 'flame': {
      // seamless loop: two noise phases cross-faded (t and t-1)
      return {
        bound: [0, 0, 0, 1.0],
        sample(x, y, z, out) {
          if (y < -0.95 || y > 0.95) {
            out[0] = out[1] = 0;
            return;
          }
          const h = (y + 0.9) / 1.8; // 0 bottom .. 1 top
          const S = 3.2; // scroll distance per loop (noise units)
          const n0 = fbm(x * 3.5, y * 2.6 - t * S, z * 3.5, 4);
          const n1 = fbm(x * 3.5, y * 2.6 - (t - 1) * S, z * 3.5, 4);
          const n = n0 * (1 - t) + n1 * t;
          // finer licking tongues (also loop-blended)
          const m0 = turb(x * 7, y * 4.5 - t * S * 1.6, z * 7, 3);
          const m1 = turb(x * 7, y * 4.5 - (t - 1) * S * 1.6, z * 7, 3);
          const m = m0 * (1 - t) + m1 * t;
          const sway = (n - 0.5) * 0.7 * h;
          const rr = Math.hypot(x - sway, z - sway * 0.5);
          const w = 0.4 * (1 - h) * (1 - h * 0.3) + 0.05;
          let dens = clamp01((w * (0.25 + 1.5 * n + 0.6 * (m - 0.4)) - rr) / (w * 0.45));
          // the top breaks up into separate tongues
          dens *= smooth(0, 0.08, h) * (1 - smooth(0.35, 0.85, h + (n - 0.5) * 0.9 + (m - 0.45) * 0.6));
          const temp = clamp01((1 - h * 0.9) * (0.6 + 0.8 * n) * (1 - rr / (w + 0.05) * 0.5));
          out[0] = dens * 0.55;
          out[1] = dens * Math.pow(temp, 1.6) * 1.6;
        },
      };
    }
  }
  throw new Error('unknown effect ' + name);
}

// ------------------------------------------------------------------ renderer

function renderFrame(fx, f) {
  const loop = fx.loop;
  const t = loop ? f / NF : f / (NF - 1);
  const W = FRAME;
  const outA = new Float32Array(W * W * 4);
  const outB = new Float32Array(W * W * 4);
  if (fx.name === 'sparks') return renderSparks(t, outA, outB);
  const N = makeNoise(1234 + fx.name.charCodeAt(0) * 31 + fx.name.length);
  const fr = effectFrame(fx.name, t, N);
  const NX = W, NY = W;
  const vol = new Float32Array(NX * NY * NZ);
  const emi = new Float32Array(NX * NY * NZ);
  const tmp = [0, 0];
  const [bx, by, bz, br] = fr.bound;
  const idx = (i, j, k) => (k * NY + j) * NX + i;
  for (let k = 0; k < NZ; k++) {
    const z = ((k + 0.5) / NZ) * 2 - 1;
    for (let j = 0; j < NY; j++) {
      const y = 1 - ((j + 0.5) / NY) * 2;
      for (let i = 0; i < NX; i++) {
        const x = ((i + 0.5) / NX) * 2 - 1;
        // keep everything inside the frame (soft vignette of the volume)
        const edge = Math.max(Math.abs(x), Math.abs(y));
        if (edge > 0.97 || (x - bx) ** 2 + (y - by) ** 2 + (z - bz) ** 2 > br * br) continue;
        fr.sample(x, y, z, tmp);
        const fade = 1 - smooth(0.86, 0.97, edge);
        const n = idx(i, j, k);
        vol[n] = tmp[0] * fade;
        emi[n] = tmp[1] * fade;
      }
    }
  }
  // extinction per voxel step (box is 2 units wide)
  const K = fx.k;
  const dxy = 2 / NX;
  const dz = 2 / NZ;
  const ms = (T) => 0.62 * T + 0.38 * Math.pow(T, 0.22); // multiple-scattering approximation
  // six directional transmittance volumes (light arriving from each side)
  const L = [0, 1, 2, 3, 4, 5].map(() => new Float32Array(NX * NY * NZ));
  // +x (right) and -x (left)
  for (let k = 0; k < NZ; k++)
    for (let j = 0; j < NY; j++) {
      let acc = 0;
      for (let i = NX - 1; i >= 0; i--) {
        const n = idx(i, j, k);
        const s = vol[n] * K * dxy;
        L[0][n] = ms(Math.exp(-(acc + s * 0.5)));
        acc += s;
      }
      acc = 0;
      for (let i = 0; i < NX; i++) {
        const n = idx(i, j, k);
        const s = vol[n] * K * dxy;
        L[2][n] = ms(Math.exp(-(acc + s * 0.5)));
        acc += s;
      }
    }
  // +y (top: row 0) and -y (bottom)
  for (let k = 0; k < NZ; k++)
    for (let i = 0; i < NX; i++) {
      let acc = 0;
      for (let j = 0; j < NY; j++) {
        const n = idx(i, j, k);
        const s = vol[n] * K * dxy;
        L[1][n] = ms(Math.exp(-(acc + s * 0.5)));
        acc += s;
      }
      acc = 0;
      for (let j = NY - 1; j >= 0; j--) {
        const n = idx(i, j, k);
        const s = vol[n] * K * dxy;
        L[3][n] = ms(Math.exp(-(acc + s * 0.5)));
        acc += s;
      }
    }
  // +z (front, camera side) and -z (back)
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      let acc = 0;
      for (let k = NZ - 1; k >= 0; k--) {
        const n = idx(i, j, k);
        const s = vol[n] * K * dz;
        L[4][n] = ms(Math.exp(-(acc + s * 0.5)));
        acc += s;
      }
      acc = 0;
      for (let k = 0; k < NZ; k++) {
        const n = idx(i, j, k);
        const s = vol[n] * K * dz;
        L[5][n] = ms(Math.exp(-(acc + s * 0.5)));
        acc += s;
      }
    }
  // view integration (camera at +z)
  for (let j = 0; j < NY; j++)
    for (let i = 0; i < NX; i++) {
      let Tv = 1;
      let l0 = 0, l1 = 0, l2 = 0, l3 = 0, l4 = 0, l5 = 0, e = 0;
      for (let k = NZ - 1; k >= 0 && Tv > 0.002; k--) {
        const n = idx(i, j, k);
        const d = vol[n];
        const em = emi[n];
        if (d <= 0) continue;
        const a = 1 - Math.exp(-d * K * dz);
        const w = Tv * a;
        l0 += w * L[0][n];
        l1 += w * L[1][n];
        l2 += w * L[2][n];
        l3 += w * L[3][n];
        l4 += w * L[4][n];
        l5 += w * L[5][n];
        e += w * em;
        Tv *= 1 - a;
      }
      const alpha = 1 - Tv;
      const p = (j * W + i) * 4;
      const inv = alpha > 1e-4 ? 1 / alpha : 0;
      outA[p] = l0 * inv;
      outA[p + 1] = l1 * inv;
      outA[p + 2] = l2 * inv;
      outA[p + 3] = alpha;
      outB[p] = l3 * inv;
      outB[p + 1] = l4 * inv;
      outB[p + 2] = l5 * inv;
      outB[p + 3] = e;
    }
  return { outA, outB };
}

/** Sparks: motion-blurred glowing streaks on ballistic arcs (2D, emission only). */
function renderSparks(t, outA, outB) {
  const W = FRAME;
  const N = makeNoise(777);
  const sparks = [];
  for (let i = 0; i < 56; i++) {
    const a = N.rnd() * Math.PI * 2;
    const el = 0.1 + N.rnd() * 1.35;
    const sp = 0.7 + N.rnd() * 1.3;
    sparks.push({ vx: Math.cos(a) * Math.cos(el) * sp, vy: Math.sin(el) * sp, life: 0.45 + N.rnd() * 0.55, w: 0.6 + N.rnd() * 0.7, b: 0.6 + N.rnd() * 0.6 });
  }
  const g = 2.4;
  const pos = (s, tt) => [s.vx * tt * 0.9, -0.15 + s.vy * tt * 0.9 - 0.5 * g * tt * tt * 0.9];
  for (const s of sparks) {
    if (t > s.life) continue;
    const k = t / s.life;
    const br = s.b * (1 - k) * (1 - k) * (k < 0.05 ? k / 0.05 : 1);
    const t0 = Math.max(0, t - 0.06);
    const [x0, y0] = pos(s, t0);
    const [x1, y1] = pos(s, t);
    // rasterise a thick line (gaussian falloff) into emission + opacity
    const px0 = ((x0 + 1) / 2) * W, py0 = ((1 - y0) / 2) * W;
    const px1 = ((x1 + 1) / 2) * W, py1 = ((1 - y1) / 2) * W;
    const rad = 1.1 * s.w + 0.6;
    const minx = Math.max(0, Math.floor(Math.min(px0, px1) - 3)), maxx = Math.min(W - 1, Math.ceil(Math.max(px0, px1) + 3));
    const miny = Math.max(0, Math.floor(Math.min(py0, py1) - 3)), maxy = Math.min(W - 1, Math.ceil(Math.max(py0, py1) + 3));
    const dx = px1 - px0, dy = py1 - py0;
    const len2 = Math.max(1e-6, dx * dx + dy * dy);
    for (let y = miny; y <= maxy; y++)
      for (let x = minx; x <= maxx; x++) {
        const u = clamp01(((x + 0.5 - px0) * dx + (y + 0.5 - py0) * dy) / len2);
        const ex = px0 + dx * u - (x + 0.5), ey = py0 + dy * u - (y + 0.5);
        const d2 = ex * ex + ey * ey;
        const v = Math.exp(-d2 / (rad * rad)) * br * (0.35 + 0.65 * u);
        if (v < 0.002) continue;
        const p = (y * W + x) * 4;
        outB[p + 3] = Math.min(1, outB[p + 3] + v);
        outA[p + 3] = Math.min(1, outA[p + 3] + v * 0.35);
      }
  }
  for (let p = 0; p < W * W * 4; p += 4) {
    outA[p] = outA[p + 1] = outA[p + 2] = 1;
    outB[p] = outB[p + 1] = outB[p + 2] = 1;
  }
  return { outA, outB };
}

// ------------------------------------------------------------------ driver

if (!isMainThread) {
  const { fxIndex, frames } = workerData;
  const fx = EFFECTS[fxIndex];
  for (const f of frames) {
    const { outA, outB } = renderFrame(fx, f);
    parentPort.postMessage({ f, outA, outB }, [outA.buffer, outB.buffer]);
  }
  parentPort.postMessage({ done: true });
} else {
  const here = dirname(fileURLToPath(import.meta.url));
  const outDir = join(here, '..', 'public', 'fx');
  const tmpDir = join(os.tmpdir(), 'bake-fx');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(tmpDir, { recursive: true });
  const AW = FRAME * GRID * BLOCKS_X;
  const AH = FRAME * GRID * BLOCKS_Y;
  const atlasA = new Uint8Array(AW * AH * 4);
  const atlasB = new Uint8Array(AW * AH * 4);
  const threads = Math.max(1, Math.min(8, os.cpus().length));
  const args = process.argv.slice(2);
  const fArg = args.find((a) => a.startsWith('--frames='));
  const pick = fArg ? fArg.slice(9).split(',').map(Number) : null;
  const only = args.filter((a) => !a.startsWith('--'));
  const manifest = { version: 1, frame: FRAME, grid: GRID, blocks: [BLOCKS_X, BLOCKS_Y], encoding: 'sqrt', effects: {} };
  const t0 = Date.now();
  for (let e = 0; e < EFFECTS.length; e++) {
    const fx = EFFECTS[e];
    if (only.length && !only.includes(fx.name)) continue;
    // finished effects are cached (an interrupted bake resumes; --force re-bakes)
    const cache = join(tmpDir, `cache-${fx.name}-${FRAME}-${NZ}.bin`);
    const bx = (e % BLOCKS_X) * FRAME * GRID;
    const by = Math.floor(e / BLOCKS_X) * FRAME * GRID;
    const BW = FRAME * GRID;
    if (!pick && !args.includes('--force') && existsSync(cache)) {
      const buf = readFileSync(cache);
      const emax = buf.readFloatLE(0);
      for (let y = 0; y < BW; y++) {
        const s0 = 4 + y * BW * 4;
        const d = ((by + y) * AW + bx) * 4;
        atlasA.set(buf.subarray(s0, s0 + BW * 4), d);
        atlasB.set(buf.subarray(4 + BW * BW * 4 + y * BW * 4, 4 + BW * BW * 4 + (y + 1) * BW * 4), d);
      }
      manifest.effects[fx.name] = { block: e, life: fx.life, loop: fx.loop, emission: +emax.toFixed(4) };
      console.log(`${fx.name}: cached`);
      continue;
    }
    const frames = new Array(NF);
    await Promise.all(
      [...Array(threads).keys()].map(
        (w) =>
          new Promise((res, rej) => {
            const mine = [];
            for (let f = w; f < NF; f += threads) if (!pick || pick.includes(f)) mine.push(f);
            const wk = new Worker(fileURLToPath(import.meta.url), { workerData: { fxIndex: e, frames: mine } });
            wk.on('message', (m) => {
              if (m.done) {
                wk.terminate();
                res();
              } else frames[m.f] = m;
            });
            wk.on('error', rej);
          }),
      ),
    );
    // emission normalisation (manifest carries the scale back)
    let emax = 0;
    for (const fr of frames) if (fr) for (let p = 3; p < fr.outB.length; p += 4) emax = Math.max(emax, fr.outB[p]);
    emax = emax || 1;
    const enc = (v) => Math.round(Math.sqrt(clamp01(v)) * 255);
    for (let f = 0; f < NF; f++) {
      if (!frames[f]) continue;
      const { outA, outB } = frames[f];
      const ox = bx + (f % GRID) * FRAME;
      const oy = by + Math.floor(f / GRID) * FRAME;
      for (let y = 0; y < FRAME; y++)
        for (let x = 0; x < FRAME; x++) {
          const s = (y * FRAME + x) * 4;
          const d = ((oy + y) * AW + ox + x) * 4;
          atlasA[d] = enc(outA[s]);
          atlasA[d + 1] = enc(outA[s + 1]);
          atlasA[d + 2] = enc(outA[s + 2]);
          atlasA[d + 3] = Math.round(clamp01(outA[s + 3]) * 255);
          atlasB[d] = enc(outB[s]);
          atlasB[d + 1] = enc(outB[s + 1]);
          atlasB[d + 2] = enc(outB[s + 2]);
          atlasB[d + 3] = enc(outB[s + 3] / emax);
        }
    }
    manifest.effects[fx.name] = { block: e, life: fx.life, loop: fx.loop, emission: +emax.toFixed(4) };
    if (!pick) {
      const buf = Buffer.alloc(4 + BW * BW * 8);
      buf.writeFloatLE(emax, 0);
      for (let y = 0; y < BW; y++) {
        const d = ((by + y) * AW + bx) * 4;
        buf.set(atlasA.subarray(d, d + BW * 4), 4 + y * BW * 4);
        buf.set(atlasB.subarray(d, d + BW * 4), 4 + BW * BW * 4 + y * BW * 4);
      }
      writeFileSync(cache, buf);
    }
    console.log(`${fx.name}: ${((Date.now() - t0) / 1000).toFixed(1)}s emax ${emax.toFixed(3)}`);
  }
  const write = (buf, name) => {
    const raw = join(tmpDir, name + '.rgba');
    writeFileSync(raw, buf);
    const common = ['-size', `${AW}x${AH}`, '-depth', '8', `rgba:${raw}`, '-define', 'webp:exact=true', '-define', 'webp:use-sharp-yuv=true', '-define', 'webp:method=6', '-define', 'webp:alpha-quality=92'];
    execFileSync('convert', [...common, '-quality', '86', join(outDir, `${name}.webp`)]);
    execFileSync('convert', [...common, '-filter', 'Triangle', '-resize', '50%', '-quality', '88', join(outDir, `${name}-half.webp`)]);
  };
  if (!only.length) {
    write(atlasA, 'fx-a');
    write(atlasB, 'fx-b');
    writeFileSync(join(outDir, 'fx.json'), JSON.stringify(manifest, null, 1) + '\n');
  } else {
    // preview a subset (debugging): relit contact sheet (sun from the upper left, grey smoke, fire ramp) over a sky colour
    const prev = new Uint8Array(AW * AH * 3);
    const dec = (v) => (v / 255) ** 2;
    for (let p = 0, q = 0; p < atlasA.length; p += 4, q += 3) {
      const a = atlasA[p + 3] / 255;
      const sun = 0.55 * dec(atlasA[p + 1]) + 0.25 * dec(atlasA[p + 2]) + 0.2 * dec(atlasB[p + 1]);
      const amb = 0.5 * dec(atlasA[p + 1]) + 0.1 * (dec(atlasA[p]) + dec(atlasA[p + 2]) + dec(atlasB[p]) + dec(atlasB[p + 1]) + dec(atlasB[p + 2]));
      const e = dec(atlasB[p + 3]) * 3;
      const lit = 0.45 * (sun * 1.6 + amb * 0.45);
      const fire = [Math.min(1, e * 1.0), Math.min(1, e * 0.5 * Math.min(1, e)), Math.min(1, e * 0.15 * e)];
      const bg = [0.45, 0.6, 0.8];
      for (let c = 0; c < 3; c++) prev[q + c] = Math.round(Math.min(1, bg[c] * (1 - a) + lit * a + fire[c]) ** (1 / 2.2) * 255);
    }
    writeFileSync(join(tmpDir, 'preview.rgb'), prev);
    execFileSync('convert', ['-size', `${AW}x${AH}`, '-depth', '8', `rgb:${join(tmpDir, 'preview.rgb')}`, '-resize', '50%', join(tmpDir, 'preview.png')]);
    console.log('preview written to', join(tmpDir, 'preview.png'));
  }
  rmSync(join(tmpDir, 'fx-a.rgba'), { force: true });
  rmSync(join(tmpDir, 'fx-b.rgba'), { force: true });
  console.log(`baked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
