#!/usr/bin/env node
/*
 * Offline baker for the photoscanned building materials (web/public/tex/buildings/).
 *
 *   node tools/bake-bldtex.mjs            (needs curl and ImageMagick `convert` with WebP support)
 *
 * Downloads CC0 PBR photoscans (Poly Haven, 1k JPG maps; cached in
 * $TEX_CACHE or the OS temp dir), and packs them into the SAME 4 x 6 tile
 * layout as the procedural building atlas (src/render/models/bldtex.ts), at
 * two tile sizes: 256 px (phone / medium) and 512 px (high).
 *
 * Per tile:
 *  - resized with wrap-around (virtual pixel tile) so the photoscans stay
 *    seamless; a source that does not tile (edge discontinuity well above its
 *    interior gradient) is made seamless with a half-offset cross blend;
 *  - albedo is re-balanced for the atlas convention: most tiles are tinted per
 *    vertex (team / nation paint), so their hue is pulled towards neutral
 *    (luminance + a fraction of the stain chroma, so rust and runoff keep a
 *    little colour) and their mean is normalised to the procedural tile's mean
 *    (the shader's brightness gain then applies to both alike); brick / wood
 *    keep their colour, normalised the same way;
 *  - normals are converted to the atlas convention (Poly Haven ships OpenGL
 *    normals for an upright image; atlas rows run top-down = down the wall,
 *    so green is flipped), optionally scaled;
 *  - roughness / metalness come from the scan's maps (or a constant).
 *
 * Output per size S (tile px):
 *   bld-albedo-S.webp   sRGB albedo
 *   bld-normal-S.webp   tangent normal (x, y, z) in RGB
 *   bld-rm-S.webp       R = roughness, G = metalness
 * All three are opaque RGB on purpose: the runtime decodes them through a 2D
 * canvas (no premultiplied alpha games) and packs metalness / roughness into
 * the atlas alpha channels itself. Tiles that stay procedural (camo, hazard
 * stripes, glass, radar faces, solar cells, grating) are left blank.
 * manifest.json lists the photo tiles with their uv scale (photoscans often
 * cover a different physical size than the procedural tile) and the sources;
 * CREDITS-buildings.txt (one level up) carries the attribution.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'tex', 'buildings');
const CREDITS = join(HERE, '..', 'public', 'tex', 'CREDITS-buildings.txt');
const CACHE = process.env.TEX_CACHE || join(os.tmpdir(), 'ironfront-tex-cache');
const COLS = 4;
const ROWS = 6;
const SIZES = [256, 512];
const UA = 'IronFront-texture-baker/1.0 (offline asset prep)';

/** Tile ids (must match `Tile` in src/render/models/bldtex.ts). */
const T = { Panel: 0, Cast: 1, Corr: 2, Plate: 3, Paint: 4, Clad: 5, Bag: 9, Canvas: 10, Asphalt: 11, Soil: 12, Brick: 13, Plaster: 14, Wood: 16, RoofTile: 17, Stone: 19, Roof: 23 };

/**
 * One photoscan per tile.
 *  mean: target mean albedo (sRGB, 0..1) = the procedural tile's mean
 *  chroma: fraction of the colour kept (1 = original hue, 0 = grey + stains only via `stain`)
 *  stain: fraction of the per-pixel colour deviation (rust, runoff) kept on tinted tiles
 *  contrast: luminance contrast around the mean
 *  scale: uv multiplier vs the procedural tile (< 1 = the photo covers more surface)
 *  metal: constant metalness, or 'map' (x metalK)
 *  rough: [scale, offset] applied to the roughness map
 *  nrm: normal strength multiplier
 */
const SOURCES = [
  { tile: T.Panel, name: 'precast concrete', id: 'concrete_wall_008', mean: 0.8, chroma: 0.25, stain: 0.5, contrast: 1.15, scale: 1, metal: 0, rough: [1, 0.04], nrm: 1.2 },
  { tile: T.Cast, name: 'board-formed concrete', id: 'concrete_layers_02', mean: 0.78, chroma: 0.25, stain: 0.5, contrast: 1.0, scale: 1, metal: 0, rough: [1, 0.04], nrm: 1.1 },
  { tile: T.Corr, name: 'corrugated steel', id: 'corrugated_iron_02', mean: 0.8, chroma: 0.2, stain: 0.7, contrast: 1.0, scale: 0.42, metal: 'map', metalK: 0.75, rough: [1, 0], nrm: 1.4 },
  { tile: T.Plate, name: 'steel plate', id: 'blue_metal_plate', mean: 0.78, chroma: 0.0, stain: 0.35, contrast: 1.15, scale: 1, metal: 0.62, rough: [0.9, 0.02], nrm: 1.3 },
  { tile: T.Paint, name: 'painted metal', id: 'green_metal_rust', mean: 0.92, chroma: 0.0, stain: 0.45, contrast: 1.2, scale: 0.55, metal: 0.12, rough: [0.9, 0.06], nrm: 1 },
  { tile: T.Clad, name: 'box profile cladding', id: 'box_profile_metal_sheet', mean: 0.84, chroma: 0.0, stain: 0.3, contrast: 1.1, scale: 0.5, metal: 'map', metalK: 0.4, rough: [1, 0.12], nrm: 1.3 },
  { tile: T.Bag, name: 'sandbag hessian', id: 'hessian_230', mean: 0.78, chroma: 0.3, stain: 0.3, contrast: 1.0, scale: 1, metal: 0, rough: [1, 0.06], nrm: 0.8, bulge: true },
  { tile: T.Canvas, name: 'canvas', id: 'hessian_380', mean: 0.84, chroma: 0.15, stain: 0.3, contrast: 1.2, scale: 1, metal: 0, rough: [1, 0.05], nrm: 0.9 },
  { tile: T.Asphalt, name: 'asphalt', id: 'asphalt_04', mean: 0.52, chroma: 0.1, stain: 0.3, contrast: 1.0, scale: 1, metal: 0, rough: [1, 0], nrm: 1 },
  { tile: T.Soil, name: 'gravel hardstand', id: 'gravel_floor_02', mean: 0.72, chroma: 0.3, stain: 0.3, contrast: 0.85, scale: 1, metal: 0, rough: [1, 0], nrm: 1 },
  { tile: T.Brick, name: 'brick', id: 'brick_wall_001', mean: 0.5, chroma: 1, stain: 1, contrast: 1, scale: 0.75, metal: 0, rough: [1, 0], nrm: 1.2 },
  { tile: T.Plaster, name: 'plaster', id: 'plaster_grey_04', mean: 0.9, chroma: 0.2, stain: 0.5, contrast: 0.9, scale: 1, metal: 0, rough: [1, 0], nrm: 1 },
  { tile: T.Wood, name: 'wood planks', id: 'planks_brown_10', mean: 0.6, chroma: 1, stain: 1, contrast: 1, scale: 1.25, metal: 0, rough: [1, 0], nrm: 1.1 },
  { tile: T.RoofTile, name: 'curved clay roof tiles', id: 'roof_09', mean: 0.78, chroma: 0.12, stain: 0.3, contrast: 1.0, scale: 0.8, metal: 0.03, rough: [1, 0], nrm: 1.2 },
  { tile: T.Stone, name: 'rough-faced sandstone ashlar', id: 'sandstone_blocks_05', mean: 0.84, chroma: 0.35, stain: 0.4, contrast: 0.9, scale: 1, metal: 0, rough: [1, 0], nrm: 1.1 },
  { tile: T.Roof, name: 'tar and gravel flat roof', id: 'tarred_gravel', mean: 0.76, chroma: 0.1, stain: 0.3, contrast: 1.1, scale: 1, metal: 0, rough: [1, 0], nrm: 1 },
];

// ------------------------------------------------------------------ download

function sh(cmd, args, input) {
  return execFileSync(cmd, args, { input, maxBuffer: 1 << 30 });
}
function curl(url, out) {
  sh('curl', ['-sS', '-f', '-L', '--retry', '3', '-m', '300', '-A', UA, '-o', out, url]);
}
const phFiles = new Map();
function phMaps(id) {
  if (phFiles.has(id)) return phFiles.get(id);
  mkdirSync(CACHE, { recursive: true });
  const meta = join(CACHE, `${id}.files.json`);
  if (!existsSync(meta)) curl(`https://api.polyhaven.com/files/${id}`, meta);
  const f = JSON.parse(readFileSync(meta, 'utf8'));
  const res = {};
  for (const [key, name] of [
    ['Diffuse', 'diff'],
    ['nor_gl', 'nor'],
    ['Rough', 'rough'],
    ['Metal', 'metal'],
  ]) {
    const e = f[key]?.['1k']?.jpg ?? f[key]?.['1k']?.png;
    if (!e) continue;
    const p = join(CACHE, `${id}_${name}_1k.${e.url.endsWith('.png') ? 'png' : 'jpg'}`);
    if (!existsSync(p) || statSync(p).size !== e.size) curl(e.url, p);
    res[name] = { path: p, url: e.url };
  }
  phFiles.set(id, res);
  return res;
}

// ------------------------------------------------------------------ image io

/** Decode + wrap-aware resize to S x S, returns Float32 rgb in 0..1 (sRGB encoded values). */
function load(path, S) {
  const buf = sh('convert', [path, '-colorspace', 'sRGB', '-type', 'TrueColor', '-virtual-pixel', 'tile', '-filter', 'Lanczos', '-distort', 'Resize', `${S}x${S}!`, '-depth', '8', 'rgb:-']);
  if (buf.length !== S * S * 3) throw new Error(`${path}: got ${buf.length} bytes`);
  const f = new Float32Array(S * S * 3);
  for (let i = 0; i < f.length; i++) f[i] = buf[i] / 255;
  return f;
}
function writeWebp(rgb, W, H, out, q) {
  sh('convert', ['-size', `${W}x${H}`, '-depth', '8', 'rgb:-', '-quality', String(q), '-define', 'webp:method=6', '-define', 'webp:use-sharp-yuv=true', out], Buffer.from(rgb.buffer, rgb.byteOffset, rgb.byteLength));
}

const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const enc = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const frac = (x) => x - Math.floor(x);
const lineD = (t, n) => {
  const f = frac(t * n);
  return Math.min(f, 1 - f) / n;
};

/** Ratio of the wrap-around edge step to the mean step between interior neighbours (~1 = seamless). */
function seamRatio(img, S) {
  const px = (x, y, c) => img[(y * S + x) * 3 + c];
  const step = (a, b, horiz) => {
    let d = 0;
    for (let i = 0; i < S; i++)
      for (let c = 0; c < 3; c++) d += horiz ? Math.abs(px(a, i, c) - px(b, i, c)) : Math.abs(px(i, a, c) - px(i, b, c));
    return d;
  };
  const edge = step(0, S - 1, true) + step(0, S - 1, false);
  let inner = 0;
  for (let k = 1; k <= 15; k++) {
    const a = Math.floor((k * S) / 16);
    inner += step(a, a - 1, true) + step(a, a - 1, false);
  }
  return edge / Math.max(1e-6, inner / 15);
}
/** Half-offset cross blend: makes any image tile (softens the borders a little). */
function makeSeamless(img, S, ch = 3) {
  const out = new Float32Array(img.length);
  const h = S >> 1;
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = Math.min(x, S - 1 - x) / h;
      const dy = Math.min(y, S - 1 - y) / h;
      const m = sstep(0, 0.35, Math.min(dx, dy));
      const i = (y * S + x) * ch;
      const j = (((y + h) % S) * S + ((x + h) % S)) * ch;
      for (let c = 0; c < ch; c++) out[i + c] = img[j + c] + (img[i + c] - img[j + c]) * m;
    }
  return out;
}

// ------------------------------------------------------------------ per tile

function bakeTile(src, S) {
  const maps = phMaps(src.id);
  let diff = load(maps.diff.path, S);
  let nor = load(maps.nor.path, S);
  let rough = maps.rough ? load(maps.rough.path, S) : null;
  let metal = src.metal === 'map' && maps.metal ? load(maps.metal.path, S) : null;
  const sr = seamRatio(diff, S);
  if (sr > 2.2) {
    console.log(`  ${src.id}: seam ratio ${sr.toFixed(2)} -> cross blend`);
    diff = makeSeamless(diff, S);
    nor = makeSeamless(nor, S);
    if (rough) rough = makeSeamless(rough, S);
    if (metal) metal = makeSeamless(metal, S);
  }
  const N = S * S;
  // ---- albedo: work in linear light
  const L = new Float32Array(N);
  const rgb = new Float32Array(N * 3);
  let mr = 0;
  let mg = 0;
  let mb = 0;
  let ml = 0;
  for (let i = 0; i < N; i++) {
    const r = lin(diff[i * 3]);
    const g = lin(diff[i * 3 + 1]);
    const b = lin(diff[i * 3 + 2]);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    L[i] = l;
    mr += r;
    mg += g;
    mb += b;
    ml += l;
  }
  mr /= N;
  mg /= N;
  mb /= N;
  ml /= N;
  // mean chroma of the scan (its base hue) vs per pixel deviation (stains)
  const hr = mr / ml;
  const hg = mg / ml;
  const hb = mb / ml;
  // optional bulge field (sandbag tile: 4 x 4 filled bags per tile, like the procedural one)
  const bul = src.bulge ? new Float32Array(N) : null;
  if (bul)
    for (let y = 0; y < S; y++)
      for (let x = 0; x < S; x++) {
        const u = (x + 0.5) / S;
        const v = (y + 0.5) / S;
        bul[y * S + x] = sstep(0.0, 0.06, Math.min(lineD(u, 4), lineD(v, 4)));
      }
  const outA = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const l = ml * Math.pow(Math.max(1e-5, L[i] / ml), src.contrast);
    const k = l / Math.max(1e-5, L[i]);
    // pixel colour at the new luminance, split into base hue and stain deviation
    const pr = rgb[i * 3] * k;
    const pg = rgb[i * 3 + 1] * k;
    const pb = rgb[i * 3 + 2] * k;
    const br = l * hr;
    const bg = l * hg;
    const bb = l * hb;
    const keepBase = src.chroma;
    const baseR = l + (br - l) * keepBase;
    const baseG = l + (bg - l) * keepBase;
    const baseB = l + (bb - l) * keepBase;
    let r = baseR + (pr - br) * src.stain;
    let g = baseG + (pg - bg) * src.stain;
    let b = baseB + (pb - bb) * src.stain;
    if (bul) {
      const s = 0.8 + 0.2 * bul[i];
      r *= s;
      g *= s;
      b *= s;
    }
    outA[i * 3] = r;
    outA[i * 3 + 1] = g;
    outA[i * 3 + 2] = b;
  }
  // normalise the mean (in sRGB, matching how the procedural tiles were authored)
  let m = 0;
  for (let i = 0; i < N * 3; i++) m += enc(clamp01(outA[i]));
  m /= N * 3;
  // iterate a gain in linear space until the encoded mean hits the target
  let gain = lin(src.mean) / Math.max(1e-5, lin(m));
  for (let it = 0; it < 6; it++) {
    let mm = 0;
    for (let i = 0; i < N * 3; i++) mm += enc(clamp01(outA[i] * gain));
    mm /= N * 3;
    gain *= lin(src.mean) / Math.max(1e-5, lin(mm));
  }
  const albedo = new Uint8Array(N * 3);
  for (let i = 0; i < N * 3; i++) albedo[i] = Math.round(enc(clamp01(outA[i] * gain)) * 255);
  // ---- normals: OpenGL (upright image) -> atlas rows (top-down): flip green; strength; optional bulge
  const normal = new Uint8Array(N * 3);
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const i = y * S + x;
      let nx = nor[i * 3] * 2 - 1;
      let ny = -(nor[i * 3 + 1] * 2 - 1);
      let nz = nor[i * 3 + 2] * 2 - 1;
      nx *= src.nrm;
      ny *= src.nrm;
      if (bul) {
        // bulge slope (Sobel on the bulge height, wrap) added on top (whiteout style)
        const H = (xx, yy) => bul[((yy + S) % S) * S + ((xx + S) % S)];
        const k = S * 0.012;
        const dx = (H(x + 1, y) - H(x - 1, y)) * k;
        const dDown = (H(x, y + 1) - H(x, y - 1)) * k;
        // atlas convention: x = -dH/du, y = +dH/d(up the wall) = -dH/d(image row)
        nx += -dx;
        ny += -dDown;
      }
      const len = Math.hypot(nx, ny, nz) || 1;
      normal[i * 3] = Math.round(clamp01((nx / len) * 0.5 + 0.5) * 255);
      normal[i * 3 + 1] = Math.round(clamp01((ny / len) * 0.5 + 0.5) * 255);
      normal[i * 3 + 2] = Math.round(clamp01((nz / len) * 0.5 + 0.5) * 255);
    }
  // ---- roughness / metalness
  const rm = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) {
    const ro = rough ? rough[i * 3] * src.rough[0] + src.rough[1] : 0.85;
    const me = metal ? metal[i * 3] * (src.metalK ?? 1) : typeof src.metal === 'number' ? src.metal : 0;
    rm[i * 3] = Math.round(clamp01(ro) * 255);
    rm[i * 3 + 1] = Math.round(clamp01(me) * 255);
    rm[i * 3 + 2] = 0;
  }
  return { albedo, normal, rm };
}

// ------------------------------------------------------------------ main

mkdirSync(OUT, { recursive: true });
const manifest = {
  version: 1,
  note: 'Photoscanned building atlas tiles (see tools/bake-bldtex.mjs). Layout = Tile enum of src/render/models/bldtex.ts.',
  cols: COLS,
  rows: ROWS,
  sizes: {},
  tiles: SOURCES.map((s) => ({ tile: s.tile, name: s.name, id: s.id, scale: s.scale })),
};
for (const S of SIZES) {
  const W = COLS * S;
  const H = ROWS * S;
  const A = new Uint8Array(W * H * 3).fill(128);
  const Nn = new Uint8Array(W * H * 3);
  const RM = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    Nn[i * 3] = Nn[i * 3 + 1] = 128;
    Nn[i * 3 + 2] = 255;
    RM[i * 3] = 230;
  }
  for (const src of SOURCES) {
    console.log(`[${S}] tile ${src.tile} ${src.name} <- ${src.id}`);
    const t = bakeTile(src, S);
    const ox = (src.tile % COLS) * S;
    const oy = Math.floor(src.tile / COLS) * S;
    for (let y = 0; y < S; y++) {
      const d = ((oy + y) * W + ox) * 3;
      const s = y * S * 3;
      A.set(t.albedo.subarray(s, s + S * 3), d);
      Nn.set(t.normal.subarray(s, s + S * 3), d);
      RM.set(t.rm.subarray(s, s + S * 3), d);
    }
  }
  const files = { albedo: `bld-albedo-${S}.webp`, normal: `bld-normal-${S}.webp`, rm: `bld-rm-${S}.webp` };
  writeWebp(A, W, H, join(OUT, files.albedo), S > 256 ? 88 : 92);
  writeWebp(Nn, W, H, join(OUT, files.normal), 92);
  writeWebp(RM, W, H, join(OUT, files.rm), 85);
  let bytes = 0;
  for (const f of Object.values(files)) bytes += statSync(join(OUT, f)).size;
  manifest.sizes[S] = { ...files, bytes };
  console.log(`[${S}] ${(bytes / 1024).toFixed(0)} KB`);
}
writeFileSync(join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1) + '\n');

// credits
const lines = [
  'Iron Front - building material photoscans (public/tex/buildings/)',
  '',
  'All source textures are CC0 1.0 Universal (public domain dedication),',
  'https://creativecommons.org/publicdomain/zero/1.0/',
  'Downloaded from Poly Haven (https://polyhaven.com/license) and processed by',
  'tools/bake-bldtex.mjs (resized, recoloured towards neutral for per-vertex',
  'tinting, normal maps converted, packed into the building atlas layout).',
  '',
];
for (const s of SOURCES) {
  const m = phMaps(s.id);
  lines.push(`${s.name} (atlas tile ${s.tile}): Poly Haven "${s.id}" - https://polyhaven.com/a/${s.id} - CC0`);
  for (const [k, v] of Object.entries(m)) lines.push(`    ${k}: ${v.url}`);
}
writeFileSync(CREDITS, lines.join('\n') + '\n');
console.log('done ->', OUT);
