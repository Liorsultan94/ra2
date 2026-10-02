import * as THREE from 'three';

/*
 * Grass: the shared palette, the tiling micro texture of the ground's grass
 * layer and the GLSL that turns the painted control maps into a grass colour.
 * The same colour function runs in the ground shader (per pixel) and in the
 * 3D blades (src/render/grass.ts, per blade), so blades always match the turf
 * they grow from. The outskirts and the minimap use the CPU twin (grassRGB).
 */

// ------------------------------------------------------------------ palette

/** Grass colours (sRGB hex). Lush = wet low ground, Mid = ordinary meadow, Dry = hills / verges. */
export const GRASS = {
  lush: 0x2a5523,
  mid: 0x426f2b,
  dry: 0x7e8047,
  fresh: 0x5f8e35,
  clover: 0x28542d,
};

/** A grass palette (the biome's, render/biome.ts); GRASS is the temperate one. */
export type GrassPalette = typeof GRASS;

const srgb = (v: number) => [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
const palCache = new Map<GrassPalette, { lush: number[]; mid: number[]; dry: number[] }>();
const palOf = (g: GrassPalette) => {
  let p = palCache.get(g);
  if (!p) palCache.set(g, (p = { lush: srgb(g.lush), mid: srgb(g.mid), dry: srgb(g.dry) }));
  return p;
};

/**
 * Approximate flat grass colour (0-1 sRGB) for the control map values at a
 * point - the CPU twin of grassBase() in GRASS_GLSL (without the micro detail,
 * which darkens the result by ~10%).
 */
export function grassRGB(lush: number, dry: number, out: number[], pal: GrassPalette = GRASS) {
  const P = palOf(pal);
  for (let j = 0; j < 3; j++) {
    const c = P.mid[j] + (P.lush[j] - P.mid[j]) * lush;
    out[j] = c + (P.dry[j] - c) * dry;
  }
  return out;
}

/** Uniform objects for the palette (shared by every material that includes GRASS_GLSL). */
export function grassUniforms(pal: GrassPalette = GRASS) {
  const col = (hex: number) => ({ value: new THREE.Color(hex) });
  return {
    gcLush: col(pal.lush),
    gcMid: col(pal.mid),
    gcDry: col(pal.dry),
    gcFresh: col(pal.fresh),
    gcClover: col(pal.clover),
  };
}

/**
 * Grass base colour from the control maps: lush (ctl.r), dryness (tint.a) and
 * a large-scale hue drift (-0.5..0.5) that keeps wide meadows from looking flat.
 */
export const GRASS_GLSL = /* glsl */ `
uniform vec3 gcLush, gcMid, gcDry, gcFresh, gcClover;
vec3 grassBase( float lush, float dry, float drift ) {
  vec3 c = mix( gcMid, gcLush, lush );
  c = mix( c, gcDry, dry );
  // drift: some swathes a touch yellower / bluer, never far from the palette
  return c * vec3( 1.0 + drift * 0.16, 1.0 + drift * 0.04, 1.0 - drift * 0.2 );
}
`;

// ------------------------------------------------------------------ texture

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Periodic value noise (period p cells). */
function pnoise(x: number, y: number, p: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const m = (a: number) => ((a % p) + p) % p;
  const a = hash(m(xi), m(yi), s);
  const b = hash(m(xi + 1), m(yi), s);
  const c = hash(m(xi), m(yi + 1), s);
  const d = hash(m(xi + 1), m(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/**
 * Tiling grass micro texture (one repeat = GRASS_TEX_TILES map tiles):
 *  R  blade height / brightness: tufts of radiating blades over a dark under-layer
 *  G  per-blade random value (the shader turns it into fresh / dead blade tints)
 *  B  clover: round trefoil leaflets
 *  A  wildflower heads: small dots
 */
export const GRASS_TEX_TILES = 1.5;

export function grassTexture(N: number): THREE.DataTexture {
  const R = new Float32Array(N * N);
  const G = new Float32Array(N * N);
  const B = new Float32Array(N * N);
  const A = new Float32Array(N * N);
  const px = N / GRASS_TEX_TILES; // pixels per map tile
  const rnd = prng(17);
  // under-layer: dark, softly mottled
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = x / N;
      const v = y / N;
      const n = pnoise(u * 12, v * 12, 12, 3) * 0.5 + pnoise(u * 40, v * 40, 40, 4) * 0.5;
      R[y * N + x] = 0.12 + n * 0.14;
      G[y * N + x] = hash(x >> 2, y >> 2, 9);
    }
  // one blade: a tapered stroke from (x0,y0) to (x1,y1); brighter, higher towards the tip
  const blade = (x0: number, y0: number, x1: number, y1: number, w: number, hBase: number, hTip: number, id: number) => {
    const minX = Math.floor(Math.min(x0, x1) - w - 1);
    const maxX = Math.ceil(Math.max(x0, x1) + w + 1);
    const minY = Math.floor(Math.min(y0, y1) - w - 1);
    const maxY = Math.ceil(Math.max(y0, y1) + w + 1);
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        let t = ((x + 0.5 - x0) * dx + (y + 0.5 - y0) * dy) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = x + 0.5 - (x0 + dx * t);
        const ey = y + 0.5 - (y0 + dy * t);
        const ww = w * (1 - t * 0.75);
        const d = Math.sqrt(ex * ex + ey * ey);
        if (d > ww + 0.5) continue;
        const cov = Math.min(1, ww + 0.5 - d);
        // blade cross-section: lit ridge in the middle
        const ridge = 1 - (d / (ww + 0.5)) * 0.35;
        const h = (hBase + (hTip - hBase) * t) * ridge;
        const k = (((y % N) + N) % N) * N + (((x % N) + N) % N);
        const hv = R[k] + (h - R[k]) * cov;
        if (hv > R[k]) {
          R[k] = hv;
          if (cov > 0.5) G[k] = id;
        }
      }
  };
  // tufts: blades radiating from jittered centres
  const tg = Math.round(GRASS_TEX_TILES * 8);
  for (let j = 0; j < tg; j++)
    for (let i = 0; i < tg; i++) {
      const cx = ((i + 0.15 + rnd() * 0.7) / tg) * N;
      const cy = ((j + 0.15 + rnd() * 0.7) / tg) * N;
      const rt = px * (0.05 + rnd() * 0.05);
      const nb = 16 + Math.floor(rnd() * 22);
      const lean = rnd() * Math.PI * 2;
      const tuftLight = 0.75 + rnd() * 0.25;
      for (let b = 0; b < nb; b++) {
        const a = rnd() * Math.PI * 2;
        const r0 = rnd() * rt * 0.35;
        const L = rt * (0.6 + rnd() * 0.7);
        // a common lean: the tuft is combed one way by the wind
        const ax = Math.cos(a) + Math.cos(lean) * 0.6;
        const ay = Math.sin(a) + Math.sin(lean) * 0.6;
        const al = Math.hypot(ax, ay) || 1;
        const x0 = cx + Math.cos(a) * r0;
        const y0 = cy + Math.sin(a) * r0;
        blade(x0, y0, x0 + (ax / al) * L, y0 + (ay / al) * L, px * (0.007 + rnd() * 0.006), 0.42 * tuftLight, (0.75 + rnd() * 0.25) * tuftLight, rnd());
      }
    }
  // loose blades filling the gaps
  const loose = Math.round(GRASS_TEX_TILES * GRASS_TEX_TILES * 900);
  for (let n = 0; n < loose; n++) {
    const x0 = rnd() * N;
    const y0 = rnd() * N;
    const a = rnd() * Math.PI * 2;
    const L = px * (0.025 + rnd() * 0.04);
    blade(x0, y0, x0 + Math.cos(a) * L, y0 + Math.sin(a) * L, px * (0.005 + rnd() * 0.005), 0.3, 0.45 + rnd() * 0.35, rnd());
  }
  // clover: trefoils of round leaflets
  const clovers = Math.round(GRASS_TEX_TILES * GRASS_TEX_TILES * 260);
  for (let n = 0; n < clovers; n++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    const r = px * (0.012 + rnd() * 0.01);
    const a0 = rnd() * Math.PI * 2;
    const hgt = 0.6 + rnd() * 0.4;
    for (let l = 0; l < 3; l++) {
      const a = a0 + (l * Math.PI * 2) / 3;
      const lx = cx + Math.cos(a) * r * 1.05;
      const ly = cy + Math.sin(a) * r * 1.05;
      const R2 = Math.ceil(r + 1);
      for (let j = -R2; j <= R2; j++)
        for (let i = -R2; i <= R2; i++) {
          const d = Math.hypot(i + 0.5 - (lx - Math.floor(lx)), j + 0.5 - (ly - Math.floor(ly))) / r;
          if (d >= 1) continue;
          const k = ((((Math.floor(ly) + j) % N) + N) % N) * N + ((((Math.floor(lx) + i) % N) + N) % N);
          B[k] = Math.max(B[k], hgt * Math.sqrt(1 - d * d));
        }
    }
  }
  // wildflower heads
  const flowers = Math.round(GRASS_TEX_TILES * GRASS_TEX_TILES * 45);
  for (let n = 0; n < flowers; n++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    const r = px * (0.016 + rnd() * 0.01);
    const R2 = Math.ceil(r + 1);
    for (let j = -R2; j <= R2; j++)
      for (let i = -R2; i <= R2; i++) {
        const d = Math.hypot(i + 0.5 - (cx - Math.floor(cx)), j + 0.5 - (cy - Math.floor(cy))) / r;
        if (d >= 1) continue;
        const k = ((((Math.floor(cy) + j) % N) + N) % N) * N + ((((Math.floor(cx) + i) % N) + N) % N);
        A[k] = Math.max(A[k], Math.min(1, (1 - d) * 2.2));
      }
  }
  // normalise R to a mean of ~0.5 so the shader's brightness curve is texture independent
  let sum = 0;
  for (let k = 0; k < N * N; k++) sum += R[k];
  const mean = sum / (N * N);
  const data = new Uint8Array(N * N * 4);
  const c = (v: number) => (v < 0 ? 0 : v > 1 ? 255 : Math.round(v * 255));
  for (let k = 0; k < N * N; k++) {
    data[k * 4] = c(0.5 + (R[k] - mean) * 1.25);
    data[k * 4 + 1] = c(G[k]);
    data[k * 4 + 2] = c(B[k]);
    data[k * 4 + 3] = c(A[k]);
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}
