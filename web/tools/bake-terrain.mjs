#!/usr/bin/env node
/*
 * Offline baker for the photoscanned ground materials, tree barks and sky
 * HDRIs (web/public/tex/terrain, tex/bark, tex/hdri).
 *
 *   node tools/bake-terrain.mjs            (needs ImageMagick `convert` with WebP support)
 *   node tools/bake-terrain.mjs --check    (only re-checks tiling of the cached sources)
 *
 * Sources are CC0 photoscans from Poly Haven (polyhaven.com) and ambientCG
 * (ambientcg.com), downloaded once into a cache outside the repository
 * (BAKE_CACHE, default <tmp>/ironfront-bake-cache): the 2k JPG maps (colour,
 * OpenGL normal, roughness, AO, displacement).
 *
 * Per material and output size (512 = phones / medium, 1024 = high):
 *   - exact integer box downscale in linear light (seamless by construction:
 *     no resampling kernel ever reads across the wrap), light unsharp mask;
 *   - "de-lighting": the photo's low-frequency brightness blotches are mostly
 *     divided out (the game paints its own macro variation), which is what
 *     makes a repeat visible from RTS height;
 *   - height normalised to its 1..99% range (layer height blending), normals
 *     renormalised after the downscale;
 *   - tiling check across the wrap edges (colour + height); a material whose
 *     seam stands out is cross-faded with a half-offset copy of itself.
 * Packed into two RGB WebPs per material (no alpha: WebP alpha is lossless
 * only and would triple the download):
 *   <key>_a.webp   albedo (sRGB) with half of the AO folded in
 *   <key>_n.webp   R/G normal X/Y (OpenGL, +Y = up in the image), B height
 * Roughness is reduced to a per-material mean (manifest), the shader varies
 * it with the height.
 * The runtime (src/render/photoground.ts) uploads them as layers of two
 * texture arrays per map, only the materials that map's biome uses.
 *
 * Barks: albedo only, 256 px, written into the tree atlas cells at runtime.
 * HDRIs: 1k Radiance files parsed here, box-downscaled to 512 x 256, the sun
 * clamped out (the direct light is the sun) and stored as RGBE in lossless
 * WebP (RGB mantissa, A exponent), with the sun direction and the sky / ground
 * hemisphere means used to fit them to the physical sky (src/render/sky.ts).
 *
 * Outputs: public/tex/terrain/terrain.json (manifest + byte sizes per tier),
 * src/render/terrainset.ts (the same data for the code: layer stacks, repeat
 * scales, mean colours - the minimap, grass palette and outskirts derive from
 * them) and the terrain section of public/tex/CREDITS.txt.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = process.env.BAKE_CACHE || join(os.tmpdir(), 'ironfront-bake-cache');
const OUT = join(ROOT, 'public/tex/terrain');
const SIZES = [512, 1024];
const CHECK_ONLY = process.argv.includes('--check');

// ------------------------------------------------------------------ catalogue

/**
 * Ground materials. tiles = map tiles per texture repeat (a tile is ~5.5 m;
 * the scans are 1.3 - 4 m, so they are blown up 3-6x - the usual RTS scale
 * that keeps the detail readable from the camera). regular = man-made
 * patterns (slabs, flags): sampled without the random rotation of the
 * anti-tiling. flatten = how much of the photo's low-frequency brightness is
 * divided out. nk = normal strength. rough = roughness override (some scans'
 * roughness maps are implausibly glossy for dry ground).
 */
const MATS = [
  { key: 'meadow', src: 'acg:Grass004', tiles: 2.4, flatten: 0.8, nk: 1.0, rough: 0.86, note: 'lush meadow grass' },
  { key: 'withered', src: 'ph:withered_grass', tiles: 2.4, flatten: 0.8, nk: 1.0, note: 'dry / frozen grass, desert scrub' },
  { key: 'litter', src: 'ph:forest_leaves_02', tiles: 2.6, flatten: 0.7, nk: 1.0, note: 'forest floor: moss and leaf litter' },
  { key: 'drysoil', src: 'ph:dry_ground_rocks', tiles: 2.8, flatten: 0.8, nk: 1.0, note: 'bare stony soil, tracks' },
  { key: 'gravel', src: 'ph:rocky_trail', tiles: 2.2, flatten: 0.7, nk: 1.0, rough: 0.82, note: 'gravel shoulders, stony tracks' },
  { key: 'mossrock', src: 'ph:aerial_rocks_02', tiles: 5, flatten: 0.55, nk: 1.0, note: 'mossy cliff rock (aerial scan)' },
  { key: 'sandstone', src: 'ph:sandstone_cracks', tiles: 3.4, flatten: 0.6, nk: 1.2, note: 'desert mesa sandstone' },
  { key: 'snowrock', src: 'ph:rocks_ground_05', tiles: 3.2, flatten: 0.6, nk: 1.0, note: 'rocks with snow between' },
  { key: 'greyrock', src: 'ph:rock_boulder_dry', tiles: 3.2, flatten: 0.6, nk: 1.0, rough: 0.78, note: 'pale grey rock (quays)' },
  { key: 'beach', src: 'ph:coast_sand_01', tiles: 4.5, flatten: 0.7, nk: 1.0, note: 'river beach sand' },
  { key: 'dunes', src: 'ph:aerial_beach_01', tiles: 6, flatten: 0.7, nk: 1.3, rough: 0.9, note: 'wind-rippled sand (aerial scan)' },
  { key: 'mud', src: 'ph:brown_mud_02', tiles: 2.2, flatten: 0.7, nk: 1.0, note: 'wet mud' },
  { key: 'cracked', src: 'ph:mud_cracked_dry_03', tiles: 2.4, flatten: 0.7, nk: 1.0, note: 'cracked dry mud' },
  { key: 'farmsoil', src: 'ph:farm_soil', tiles: 2.2, flatten: 0.8, nk: 1.0, note: 'ploughed field soil' },
  { key: 'snow', src: 'ph:snow_02', tiles: 3.4, flatten: 0.8, nk: 1.4, note: 'snow' },
  { key: 'asphalt', src: 'ph:asphalt_02', tiles: 2.4, flatten: 0.85, nk: 1.0, note: 'cracked asphalt' },
  { key: 'pavement', src: 'ph:concrete_pavement', tiles: 2.0, flatten: 0.6, nk: 1.0, regular: true, note: 'concrete pavement slabs' },
  { key: 'rubble', src: 'ph:rubble', tiles: 2.2, flatten: 0.6, nk: 1.0, note: 'concrete rubble lots' },
  { key: 'flags', src: 'ph:precast_stone_paving', tiles: 2.4, flatten: 0.6, nk: 1.0, regular: true, note: 'stone flags (city squares)' },
];

/** Layer slots of the ground shader (src/render/ground.ts), per biome: material key or null (= procedural / fallback). */
const SLOTS = ['grass', 'dirt', 'rock', 'sand', 'mud', 'forest', 'gravel', 'soil', 'snow', 'asphalt', 'paving'];
const BIOMES = {
  temperate: { grass: 'meadow', dirt: 'drysoil', rock: 'mossrock', sand: 'beach', mud: 'mud', forest: 'litter', gravel: 'gravel', soil: 'farmsoil' },
  desert: { grass: 'withered', dirt: 'drysoil', rock: 'sandstone', sand: 'dunes', mud: 'cracked', gravel: 'gravel', soil: 'farmsoil' },
  winter: { grass: 'withered', dirt: 'drysoil', rock: 'snowrock', sand: 'snow', mud: 'mud', forest: 'litter', gravel: 'gravel', soil: 'farmsoil', snow: 'snow' },
  urban: { grass: 'meadow', dirt: 'pavement', rock: 'greyrock', sand: 'rubble', mud: 'mud', gravel: 'gravel', asphalt: 'asphalt', paving: 'flags' },
};
/** Slot fallbacks when a biome has no material of its own for it. */
const FALLBACK = { forest: 'dirt', gravel: 'dirt', soil: 'dirt', snow: 'sand', asphalt: 'rock', paving: 'dirt' };

const BARKS = [
  { key: 'oak', src: 'ph:bark_brown_02', note: 'broadleaf bark (oak, poplar, willow, fruit, acacia)' },
  { key: 'pine', src: 'ph:pine_bark', note: 'pine / spruce bark' },
  { key: 'palm', src: 'ph:palm_bark', note: 'palm trunk' },
];
const BARK_PX = 256;

const HDRIS = [
  { key: 'clear', src: 'noon_grass', note: 'clear midday, open field' },
  { key: 'overcast', src: 'overcast_soil', note: 'overcast, open field' },
  { key: 'sunset', src: 'grasslands_sunset', note: 'low sun, partly cloudy grassland' },
];
const HDRI_W = 512;

// ------------------------------------------------------------------ download

mkdirSync(CACHE, { recursive: true });

function fetchTo(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return file;
  console.log('  download', url);
  execFileSync('curl', ['-sSfL', '--retry', '3', '-m', '600', '-o', file + '.part', url], { stdio: 'inherit' });
  execFileSync('mv', [file + '.part', file]);
  return file;
}

function fetchJson(url, file) {
  fetchTo(url, file);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Local paths of a material's maps: { color, normal, rough, ao, disp, page }. */
function sourceMaps(src, res = '2k') {
  const [lib, id] = src.split(':');
  const dir = join(CACHE, id);
  mkdirSync(dir, { recursive: true });
  if (lib === 'ph') {
    const files = fetchJson(`https://api.polyhaven.com/files/${id}`, join(dir, 'files.json'));
    const pick = (k, fmts = ['jpg', 'png']) => {
      const e = files[k]?.[res];
      if (!e) return null;
      for (const f of fmts) if (e[f]) return fetchTo(e[f].url, join(dir, basename(e[f].url)));
      return null;
    };
    return {
      color: pick('Diffuse'),
      normal: pick('nor_gl'),
      rough: pick('Rough'),
      ao: pick('AO'),
      disp: pick('Displacement', ['png', 'jpg']),
      page: `https://polyhaven.com/a/${id}`,
    };
  }
  if (lib === 'acg') {
    const R = res.toUpperCase();
    const zip = fetchTo(`https://ambientcg.com/get?file=${id}_${R}-JPG.zip`, join(dir, `${id}_${R}-JPG.zip`));
    const has = (s) => join(dir, `${id}_${R}-JPG_${s}.jpg`);
    if (!existsSync(has('Color'))) execFileSync('unzip', ['-o', '-q', zip, '-d', dir]);
    const opt = (s) => (existsSync(has(s)) ? has(s) : null);
    return { color: has('Color'), normal: has('NormalGL'), rough: opt('Roughness'), ao: opt('AmbientOcclusion'), disp: opt('Displacement'), page: `https://ambientcg.com/view?id=${id}` };
  }
  throw new Error('unknown source ' + src);
}

// ------------------------------------------------------------------ raw pixels

/** Decode an image to 16-bit RGB floats 0..1 (3 planes). */
function readRGB(file) {
  const [w, h] = execFileSync('identify', ['-format', '%w %h ', file]).toString().trim().split(/\s+/).map(Number);
  const buf = execFileSync('convert', [file + '[0]', '-depth', '16', '-endian', 'LSB', 'rgb:-'], { maxBuffer: 1 << 30 });
  const n = w * h;
  const u16 = new Uint16Array(buf.buffer, buf.byteOffset, n * 3);
  const r = new Float32Array(n);
  const g = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    r[i] = u16[i * 3] / 65535;
    g[i] = u16[i * 3 + 1] / 65535;
    b[i] = u16[i * 3 + 2] / 65535;
  }
  return { w, h, c: [r, g, b] };
}

const s2l = (v) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
const l2s = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055);
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Box downscale of a w x h plane to S x S (any ratio; exact integer boxes when w, h are multiples of S). */
function down(p, w, h, S) {
  const out = new Float32Array(S * S);
  const fx = w / S;
  const fy = h / S;
  for (let y = 0; y < S; y++) {
    const y0 = Math.floor(y * fy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < S; x++) {
      const x0 = Math.floor(x * fx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * fx));
      let s = 0;
      for (let j = y0; j < y1; j++) for (let i = x0; i < x1; i++) s += p[j * w + i];
      out[y * S + x] = s / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Wrap-around separable gaussian blur of an S x S plane (wide blurs run on a reduced copy). */
function blur(p, S, sigma) {
  if (sigma > 6 && S > 64) {
    // box down to 64 x 64, blur there, bilinear (wrapping) back up
    const s = 64;
    const f = S / s;
    const small = blur(down(p, S, S, s), s, sigma / f);
    const o = new Float32Array(S * S);
    for (let y = 0; y < S; y++) {
      const fy = (y + 0.5) / f - 0.5;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const ya = ((y0 % s) + s) % s;
      const yb = (ya + 1) % s;
      for (let x = 0; x < S; x++) {
        const fx = (x + 0.5) / f - 0.5;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const xa = ((x0 % s) + s) % s;
        const xb = (xa + 1) % s;
        const a = small[ya * s + xa] + (small[ya * s + xb] - small[ya * s + xa]) * tx;
        const b = small[yb * s + xa] + (small[yb * s + xb] - small[yb * s + xa]) * tx;
        o[y * S + x] = a + (b - a) * ty;
      }
    }
    return o;
  }
  const r = Math.ceil(sigma * 3);
  const k = new Float32Array(r * 2 + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const t = new Float32Array(S * S);
  const o = new Float32Array(S * S);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += p[y * S + ((((x + i) % S) + S) % S)] * k[i + r];
      t[y * S + x] = s;
    }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      let s = 0;
      for (let i = -r; i <= r; i++) s += t[((((y + i) % S) + S) % S) * S + x] * k[i + r];
      o[y * S + x] = s;
    }
  return o;
}

const mean = (p) => p.reduce((a, b) => a + b, 0) / p.length;

function percentile(p, q) {
  const s = Float32Array.from(p).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
}

/**
 * Tiling check on an S x S plane: mean step across the wrap edges relative to
 * the mean step between neighbouring interior rows / columns (1 = invisible).
 */
function seamRatio(p, S) {
  let edge = 0;
  let inner = 0;
  let n = 0;
  for (let i = 0; i < S; i++) {
    edge += Math.abs(p[i * S + S - 1] - p[i * S]) + Math.abs(p[(S - 1) * S + i] - p[i]);
    for (const k of [S >> 2, S >> 1, (S * 3) >> 2]) inner += Math.abs(p[i * S + k] - p[i * S + k - 1]) + Math.abs(p[k * S + i] - p[(k - 1) * S + i]);
    n++;
  }
  return edge / n / (inner / n / 3 + 1e-6);
}

/** Cross-fade with a half-offset copy so the wrap seam disappears (applied to every plane of a material alike). */
function healSeams(planes, S) {
  const m = new Float32Array(S * S);
  const edge = (t) => {
    const d = Math.min(t, 1 - t) * 2; // 0 at the border .. 1 in the middle
    return 1 - Math.min(1, d / 0.35);
  };
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const e = Math.max(edge((x + 0.5) / S), edge((y + 0.5) / S));
      m[y * S + x] = e * e * (3 - 2 * e);
    }
  return planes.map((p) => {
    const o = new Float32Array(S * S);
    const h = S >> 1;
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const k = y * S + x;
        o[k] = p[k] * (1 - m[k]) + p[((y + h) % S) * S + ((x + h) % S)] * m[k];
      }
    return o;
  });
}

/**
 * RGB WebP from raw 8-bit RGB. Lossy files aim at a PSNR (dB) rather than a
 * "quality" (ImageMagick 6 ignores -quality for WebP; target-psnr works and
 * adapts the bit rate to how busy each texture is).
 */
function writeWebp(file, S, rgb, opts) {
  const args = ['-size', `${S}x${S}`, '-depth', '8', 'rgb:-', '-define', 'webp:method=6'];
  if (opts.lossless) args.push('-define', 'webp:lossless=true', '-define', 'webp:exact=true');
  else args.push('-define', `webp:target-psnr=${opts.psnr ?? 38}`, '-define', 'webp:use-sharp-yuv=true');
  args.push(file);
  execFileSync('convert', args, { input: Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength), maxBuffer: 1 << 28 });
  return statSync(file).size;
}

const b8 = (v) => Math.round(clamp01(v) * 255);

/** PSNR target (dB) for packed 8-bit RGB: error ~ 0.2 x the mean channel standard deviation, never below `floor`. */
function psnrFor(rgb, floor) {
  let sd = 0;
  for (let c = 0; c < 3; c++) {
    let m = 0;
    let m2 = 0;
    const n = rgb.length / 3;
    for (let k = c; k < rgb.length; k += 3) {
      m += rgb[k];
      m2 += rgb[k] * rgb[k];
    }
    m /= n;
    sd += Math.sqrt(Math.max(0, m2 / n - m * m)) / 3;
  }
  return Math.round(Math.min(48, Math.max(floor, 20 * Math.log10(255 / (0.2 * Math.max(1, sd))))));
}

// ------------------------------------------------------------------ materials

function bakeMaterial(mat) {
  console.log(`material ${mat.key} <- ${mat.src}`);
  const src = sourceMaps(mat.src);
  const col = readRGB(src.color);
  const { w, h } = col;
  const lin = col.c.map((p) => p.map(s2l));
  const nrm = readRGB(src.normal);
  if (nrm.w !== w || nrm.h !== h) throw new Error(`${mat.key}: normal size mismatch`);
  const rough = src.rough ? readRGB(src.rough).c[0] : null;
  const ao = src.ao ? readRGB(src.ao).c[0] : null;
  const disp = src.disp ? readRGB(src.disp) : null;
  const out = { sizes: {}, page: src.page };
  for (const S of SIZES) {
    // ---- downscale (linear light / unit vectors / plain values)
    let A = lin.map((p) => down(p, w, h, S));
    let N = nrm.c.map((p) => down(p.map((v) => v * 2 - 1), w, h, S));
    let R = rough ? down(rough, w, h, S) : new Float32Array(S * S).fill(0.9);
    let O = ao ? down(ao, w, h, S) : new Float32Array(S * S).fill(1);
    let H = disp ? down(disp.c[0], disp.w, disp.h, S) : null;
    if (!H) {
      // no displacement: luminance stands in
      H = new Float32Array(S * S);
      for (let k = 0; k < S * S; k++) H[k] = A[0][k] * 0.3 + A[1][k] * 0.6 + A[2][k] * 0.1;
    }
    // ---- de-light: divide out most of the low-frequency brightness
    const L = new Float32Array(S * S);
    for (let k = 0; k < S * S; k++) L[k] = A[0][k] * 0.2126 + A[1][k] * 0.7152 + A[2][k] * 0.0722;
    const Lm = mean(L);
    const Lb = blur(L, S, S / 14);
    const fk = mat.flatten ?? 0.75;
    for (let k = 0; k < S * S; k++) {
      const f = Math.pow(Lm / Math.max(1e-4, Lb[k]), fk);
      for (let c = 0; c < 3; c++) A[c][k] *= f;
    }
    // same for the height (blending wants a level field), then 1..99% -> 0..1
    const Hb = blur(H, S, S / 14);
    const Hm = mean(H);
    for (let k = 0; k < S * S; k++) H[k] = H[k] - (Hb[k] - Hm) * 0.8;
    const h0 = percentile(H, 0.01);
    const h1 = percentile(H, 0.99);
    for (let k = 0; k < S * S; k++) H[k] = clamp01((H[k] - h0) / Math.max(1e-4, h1 - h0));
    // ---- light unsharp mask (box downscale is soft)
    for (let c = 0; c < 3; c++) {
      const bl = blur(A[c], S, 0.9);
      for (let k = 0; k < S * S; k++) A[c][k] = Math.max(0, A[c][k] + (A[c][k] - bl[k]) * 0.35);
    }
    // ---- tiling check / heal
    const sr = Math.max(seamRatio(L, S), seamRatio(H, S));
    let healed = false;
    if (sr > 1.6) {
      [A[0], A[1], A[2], N[0], N[1], N[2], R, O, H] = healSeams([A[0], A[1], A[2], N[0], N[1], N[2], R, O, H], S);
      healed = true;
    }
    if (CHECK_ONLY) {
      console.log(`  ${S}: seam ratio ${sr.toFixed(2)}${healed ? ' (healed)' : ''}`);
      continue;
    }
    // ---- pack (alpha-free: WebP alpha is lossless only and would triple the size)
    //   _a: albedo with half of the AO folded in (sRGB)
    //   _n: normal X, normal Y, height (roughness -> per-material mean, AO -> albedo)
    const pa = new Uint8Array(S * S * 3);
    const pn = new Uint8Array(S * S * 3);
    const nk = mat.nk ?? 1;
    const sum = [0, 0, 0];
    let rs = 0;
    for (let k = 0; k < S * S; k++) {
      const ao = 1 - (1 - O[k]) * 0.5;
      for (let c = 0; c < 3; c++) {
        const v = Math.min(1, A[c][k] * ao);
        sum[c] += v;
        pa[k * 3 + c] = b8(l2s(v));
      }
      let nx = N[0][k] * nk;
      let ny = N[1][k] * nk;
      const nz = Math.max(0.05, N[2][k]);
      const l = Math.hypot(nx, ny, nz);
      nx /= l;
      ny /= l;
      pn[k * 3] = b8(nx * 0.5 + 0.5);
      pn[k * 3 + 1] = b8(ny * 0.5 + 0.5);
      pn[k * 3 + 2] = b8(H[k]);
      rs += R[k];
    }
    const dir = join(OUT, String(S));
    mkdirSync(dir, { recursive: true });
    // encoder target: an error of ~1/5 of the texture's own contrast (a fixed PSNR would wipe
    // out the detail of low-contrast scans - snow, smooth dirt - and waste bytes on busy ones)
    const ba = writeWebp(join(dir, `${mat.key}_a.webp`), S, pa, { psnr: psnrFor(pa, S >= 1024 ? 35 : 36) });
    const bn = writeWebp(join(dir, `${mat.key}_n.webp`), S, pn, { psnr: psnrFor(pn, S >= 1024 ? 33 : 34) });
    const meanLin = sum.map((v) => v / (S * S));
    out.sizes[S] = { bytes: ba + bn, seam: +sr.toFixed(2), healed };
    if (S === SIZES[0]) {
      out.mean = meanLin.map((v) => +v.toFixed(4));
      out.meanHex = '#' + meanLin.map((v) => b8(l2s(v)).toString(16).padStart(2, '0')).join('');
      out.rough = mat.rough ?? +(rs / (S * S)).toFixed(3);
    }
    console.log(`  ${S}: ${(ba / 1024).toFixed(0)} + ${(bn / 1024).toFixed(0)} KB, seam ${sr.toFixed(2)}${healed ? ' healed' : ''}`);
  }
  return out;
}

function bakeBark(b) {
  console.log(`bark ${b.key} <- ${b.src}`);
  const src = sourceMaps(b.src, '1k');
  const col = readRGB(src.color);
  const S = BARK_PX;
  const A = col.c.map((p) => down(p.map(s2l), col.w, col.h, S));
  // keep the bark's own character but even out its large-scale lighting
  const L = new Float32Array(S * S);
  for (let k = 0; k < S * S; k++) L[k] = A[0][k] * 0.2126 + A[1][k] * 0.7152 + A[2][k] * 0.0722;
  const Lm = mean(L);
  const Lb = blur(L, S, S / 8);
  const rgb = new Uint8Array(S * S * 3);
  const sum = [0, 0, 0];
  for (let k = 0; k < S * S; k++) {
    const f = Math.pow(Lm / Math.max(1e-4, Lb[k]), 0.6);
    for (let c = 0; c < 3; c++) {
      const v = Math.min(1, A[c][k] * f);
      sum[c] += v;
      rgb[k * 3 + c] = b8(l2s(v));
    }
  }
  const dir = join(ROOT, 'public/tex/bark');
  mkdirSync(dir, { recursive: true });
  const bytes = writeWebp(join(dir, `${b.key}.webp`), S, rgb, { psnr: psnrFor(rgb, 36) });
  const m = sum.map((v) => v / (S * S));
  console.log(`  ${(bytes / 1024).toFixed(0)} KB`);
  return { bytes, page: src.page, mean: m.map((v) => +v.toFixed(4)) };
}

// ------------------------------------------------------------------ HDRIs

/** Minimal Radiance .hdr reader (new-style RLE and flat scanlines) -> Float32 RGB. */
function readHdr(file) {
  const buf = readFileSync(file);
  let p = 0;
  const line = () => {
    let s = '';
    while (buf[p] !== 0x0a) s += String.fromCharCode(buf[p++]);
    p++;
    return s;
  };
  let l;
  while ((l = line()) !== '') {
    /* header */
  }
  const dims = line().split(/\s+/);
  const h = +dims[1];
  const w = +dims[3];
  const rgbe = new Uint8Array(w * h * 4);
  const scan = new Uint8Array(w * 4);
  for (let y = 0; y < h; y++) {
    if (buf[p] === 2 && buf[p + 1] === 2 && ((buf[p + 2] << 8) | buf[p + 3]) === w) {
      p += 4;
      for (let c = 0; c < 4; c++) {
        let x = 0;
        while (x < w) {
          let n = buf[p++];
          if (n > 128) {
            n -= 128;
            const v = buf[p++];
            while (n--) scan[x++ * 4 + c] = v;
          } else while (n--) scan[x++ * 4 + c] = buf[p++];
        }
      }
    } else {
      for (let x = 0; x < w * 4; x++) scan[x] = buf[p++];
    }
    rgbe.set(scan, y * w * 4);
  }
  const f = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const e = rgbe[i * 4 + 3];
    const k = e ? Math.pow(2, e - 136) : 0;
    f[i * 3] = rgbe[i * 4] * k;
    f[i * 3 + 1] = rgbe[i * 4 + 1] * k;
    f[i * 3 + 2] = rgbe[i * 4 + 2] * k;
  }
  return { w, h, f };
}

function bakeHdri(hd) {
  console.log(`hdri ${hd.key} <- ${hd.src}`);
  const dir = join(CACHE, 'hdri');
  mkdirSync(dir, { recursive: true });
  const files = fetchJson(`https://api.polyhaven.com/files/${hd.src}`, join(dir, hd.src + '.json'));
  const file = fetchTo(files.hdri['1k'].hdr.url, join(dir, hd.src + '_1k.hdr'));
  const src = readHdr(file);
  const W = HDRI_W;
  const H = W / 2;
  const planes = [0, 1, 2].map((c) => {
    const p = new Float32Array(src.w * src.h);
    for (let i = 0; i < src.w * src.h; i++) p[i] = src.f[i * 3 + c];
    return p;
  });
  // the sun: brightest pixel of the full-res map (before it is averaged away)
  let best = 0;
  let bi = 0;
  for (let i = 0; i < src.w * src.h; i++) {
    const v = planes[0][i] + planes[1][i] + planes[2][i];
    if (v > best) {
      best = v;
      bi = i;
    }
  }
  const su = ((bi % src.w) + 0.5) / src.w;
  const sv = (Math.floor(bi / src.w) + 0.5) / src.h;
  // downscale (box: 1024 x 512 -> 512 x 256)
  const fx = src.w / W;
  const fy = src.h / H;
  const out = [0, 1, 2].map(() => new Float32Array(W * H));
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++)
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let j = 0; j < fy; j++) for (let i = 0; i < fx; i++) s += planes[c][(y * fy + j) * src.w + x * fx + i];
        out[c][y * W + x] = s / (fx * fy);
      }
  // clamp the sun / hot spots: the scene's directional light is the sun
  const lum = (k) => out[0][k] * 0.2126 + out[1][k] * 0.7152 + out[2][k] * 0.0722;
  const skyL = [];
  for (let y = 0; y < H / 2; y++) for (let x = 0; x < W; x += 4) skyL.push(lum(y * W + x));
  skyL.sort((a, b) => a - b);
  const cap = skyL[Math.floor(skyL.length * 0.98)] * 2.5;
  // hemisphere means (solid-angle weighted)
  const up = [0, 0, 0];
  const dn = [0, 0, 0];
  let wu = 0;
  let wd = 0;
  for (let y = 0; y < H; y++) {
    const th = ((y + 0.5) / H) * Math.PI;
    const sw = Math.sin(th);
    for (let x = 0; x < W; x++) {
      const k = y * W + x;
      const l = lum(k);
      if (l > cap) for (let c = 0; c < 3; c++) out[c][k] *= cap / l;
      const tgt = y < H / 2 ? up : dn;
      for (let c = 0; c < 3; c++) tgt[c] += out[c][k] * sw;
      if (y < H / 2) wu += sw;
      else wd += sw;
    }
  }
  // RGBE encode
  const rgba = new Uint8Array(W * H * 4);
  for (let k = 0; k < W * H; k++) {
    const r = out[0][k];
    const g = out[1][k];
    const b = out[2][k];
    const m = Math.max(r, g, b);
    if (m < 1e-32) continue;
    const e = Math.ceil(Math.log2(m) + 1e-6);
    const sc = Math.pow(2, -e) * 256;
    rgba[k * 4] = Math.min(255, Math.floor(r * sc));
    rgba[k * 4 + 1] = Math.min(255, Math.floor(g * sc));
    rgba[k * 4 + 2] = Math.min(255, Math.floor(b * sc));
    rgba[k * 4 + 3] = e + 128;
  }
  const odir = join(ROOT, 'public/tex/hdri');
  mkdirSync(odir, { recursive: true });
  // rectangular: write via a raw stream with explicit size
  const outFile = join(odir, `${hd.key}.webp`);
  execFileSync('convert', ['-size', `${W}x${H}`, '-depth', '8', 'rgba:-', '-define', 'webp:lossless=true', '-define', 'webp:exact=true', '-define', 'webp:method=6', outFile], { input: Buffer.from(rgba.buffer) });
  const bytes = statSync(outFile).size;
  // equirect u -> azimuth (three.js equirect convention: u = atan(dir.z, dir.x) / 2pi + 0.5), v -> elevation
  const sun = { u: +su.toFixed(4), v: +sv.toFixed(4), elev: +((0.5 - sv) * 180).toFixed(1) };
  console.log(`  ${(bytes / 1024).toFixed(0)} KB, sun at u ${sun.u} elev ${sun.elev} deg, cap ${cap.toFixed(2)}`);
  return { bytes, page: `https://polyhaven.com/a/${hd.src}`, sun, sky: up.map((v) => +(v / wu).toFixed(4)), ground: dn.map((v) => +(v / wd).toFixed(4)) };
}

// ------------------------------------------------------------------ main

const mats = {};
for (const m of MATS) mats[m.key] = { ...m, ...bakeMaterial(m) };
if (CHECK_ONLY) process.exit(0);
const barks = {};
for (const b of BARKS) barks[b.key] = { ...b, ...bakeBark(b) };
const hdris = {};
for (const h of HDRIS) hdris[h.key] = { ...h, ...bakeHdri(h) };

// per-biome stacks: the array layers each biome loads, slot -> layer index
const stacks = {};
for (const [biome, def] of Object.entries(BIOMES)) {
  const layers = [];
  const slot = {};
  for (const s of SLOTS) {
    const k = def[s];
    if (!k) continue;
    if (!layers.includes(k)) layers.push(k);
    slot[s] = layers.indexOf(k);
  }
  for (const s of SLOTS) if (slot[s] === undefined) slot[s] = slot[FALLBACK[s]] ?? 0;
  const bytes = Object.fromEntries(SIZES.map((S) => [S, layers.reduce((a, k) => a + mats[k].sizes[S].bytes, 0)]));
  stacks[biome] = { layers, slot, bytes };
}

const manifest = {
  version: 1,
  generated: 'tools/bake-terrain.mjs',
  license: 'CC0 1.0 (Poly Haven, ambientCG)',
  sizes: SIZES,
  slots: SLOTS,
  materials: Object.fromEntries(
    Object.values(mats).map((m) => [m.key, { src: m.src, page: m.page, note: m.note, tiles: m.tiles, regular: !!m.regular, mean: m.mean, meanHex: m.meanHex, rough: m.rough, sizes: m.sizes }]),
  ),
  biomes: stacks,
  barks: Object.fromEntries(Object.values(barks).map((b) => [b.key, { src: b.src, page: b.page, note: b.note, px: BARK_PX, bytes: b.bytes, mean: b.mean }])),
  hdris: Object.fromEntries(Object.values(hdris).map((h) => [h.key, { src: h.src, page: h.page, note: h.note, w: HDRI_W, h: HDRI_W / 2, bytes: h.bytes, sun: h.sun, sky: h.sky, ground: h.ground }])),
};
writeFileSync(join(OUT, 'terrain.json'), JSON.stringify(manifest, null, 1) + '\n');

// ---- the code's copy (src/render/terrainset.ts)
const ts = `// GENERATED by tools/bake-terrain.mjs - do not edit by hand (re-run the baker).
// Photoscanned ground materials (CC0, Poly Haven / ambientCG): layer stacks per biome,
// repeat scales and mean colours (linear RGB). Files: public/tex/terrain/<size>/<key>_{a,n}.webp.

export type PhotoSlot = ${SLOTS.map((s) => `'${s}'`).join(' | ')};

export interface PhotoMaterial {
  /** Map tiles per texture repeat. */
  tiles: number;
  /** Man-made pattern: no random rotation when anti-tiling. */
  regular: boolean;
  /** Mean albedo, linear RGB. */
  mean: [number, number, number];
  /** Mean albedo, sRGB hex. */
  hex: number;
  /** Mean roughness. */
  rough: number;
}

export interface PhotoStack {
  /** Material keys in array-layer order. */
  layers: string[];
  /** Shader slot -> array layer. */
  slot: Record<PhotoSlot, number>;
  /** Download size per texture size (both WebPs of every layer). */
  bytes: Record<number, number>;
}

export const PHOTO_SIZES = ${JSON.stringify(SIZES)};

export const PHOTO_MATERIALS: Record<string, PhotoMaterial> = {
${Object.values(mats)
  .map((m) => `  ${m.key}: { tiles: ${m.tiles}, regular: ${!!m.regular}, mean: [${m.mean.join(', ')}], hex: 0x${m.meanHex.slice(1)}, rough: ${m.rough} },`)
  .join('\n')}
};

export const PHOTO_STACKS: Record<'temperate' | 'desert' | 'winter' | 'urban', PhotoStack> = {
${Object.entries(stacks)
  .map(([b, s]) => `  ${b}: { layers: ${JSON.stringify(s.layers)}, slot: ${JSON.stringify(s.slot).replace(/"(\w+)":/g, '$1: ')}, bytes: ${JSON.stringify(s.bytes).replace(/"(\d+)":/g, '$1: ')} },`)
  .join('\n')}
};

/** Tree barks (atlas cells), ${BARK_PX} px albedo. */
export const PHOTO_BARKS = ${JSON.stringify(Object.fromEntries(Object.values(barks).map((b) => [b.key, { bytes: b.bytes, mean: b.mean }])))} as const;

/** Sky HDRIs (RGBE in lossless WebP, ${HDRI_W} x ${HDRI_W / 2}): sun position (equirect u / v), hemisphere means (linear). */
export const PHOTO_HDRIS = ${JSON.stringify(Object.fromEntries(Object.values(hdris).map((h) => [h.key, { bytes: h.bytes, sun: h.sun, sky: h.sky, ground: h.ground }])))} as const;
`;
writeFileSync(join(ROOT, 'src/render/terrainset.ts'), ts);

// ---- credits (own section of public/tex/CREDITS.txt; other bakers keep theirs)
const creditsFile = join(ROOT, 'public/tex/CREDITS.txt');
const BEGIN = '# ---- terrain, barks, sky HDRIs, rocks (tools/bake-terrain.mjs, tools/bake-rocks.mjs) ----';
const END = '# ---- end terrain ----';
let credits = existsSync(creditsFile) ? readFileSync(creditsFile, 'utf8') : 'Iron Front - third-party assets\n\nAll assets listed here are CC0 1.0 Universal (public domain dedication):\nhttps://creativecommons.org/publicdomain/zero/1.0/\nNo attribution is required; it is given here as a courtesy.\n\n';
const lines = [BEGIN];
lines.push('Ground materials (public/tex/terrain/):');
for (const m of Object.values(mats)) lines.push(`  ${m.key.padEnd(10)} ${m.src.padEnd(26)} ${m.page}  (CC0)`);
lines.push('Tree barks (public/tex/bark/):');
for (const b of Object.values(barks)) lines.push(`  ${b.key.padEnd(10)} ${b.src.padEnd(26)} ${b.page}  (CC0)`);
lines.push('Sky HDRIs (public/tex/hdri/):');
for (const h of Object.values(hdris)) lines.push(`  ${h.key.padEnd(10)} ph:${h.src.padEnd(23)} ${h.page}  (CC0)`);
const rocksJson = join(ROOT, 'public/tex/rocks/rocks.json');
if (existsSync(rocksJson)) {
  lines.push('Rock models (public/tex/rocks/):');
  for (const r of JSON.parse(readFileSync(rocksJson, 'utf8')).rocks) lines.push(`  ${r.key.padEnd(10)} ph:${r.src.padEnd(23)} ${r.page}  (CC0)`);
}
lines.push(END);
const re = new RegExp(`${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`);
credits = re.test(credits) ? credits.replace(re, lines.join('\n') + '\n') : credits.replace(/\n*$/, '\n\n') + lines.join('\n') + '\n';
writeFileSync(creditsFile, credits);

const kb = (b) => (b / 1024).toFixed(0) + ' KB';
console.log('\nper-map downloads:');
for (const [b, s] of Object.entries(stacks)) console.log(`  ${b.padEnd(10)} ${s.layers.length} layers  512: ${kb(s.bytes[512])}  1024: ${kb(s.bytes[1024])}`);
console.log(`  barks ${kb(Object.values(barks).reduce((a, b) => a + b.bytes, 0))}, hdris ${kb(Object.values(hdris).reduce((a, h) => a + h.bytes, 0))}`);
