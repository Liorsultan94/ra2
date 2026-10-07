#!/usr/bin/env node
/*
 * Packs the Blender tree bake (tools/blender/trees.py) for the game: web/public/tex/trees/.
 *
 *   nice -n 10 /opt/blender/blender -b --factory-startup -P tools/blender/trees.py -- --out /tmp/treebake
 *   node tools/bake-trees.mjs /tmp/treebake
 *
 * (ImageMagick `convert` with WebP; the glTF tooling as in tools/bake-rocks.mjs.)
 * Output:
 *   trees.json            frame layout, atlas cells, per species: height, impostor half-extent and centre, wind
 *   trees.glb             hero meshes (quantised + EXT_meshopt_compression), one node per species
 *   cards_{a,n}_{256,128}.webp   leaf-card atlas: albedo + coverage / tangent normal + translucency
 *   imp_<kind>_{96,48}_{a,n}.webp impostor atlases: albedo (AO folded in) + coverage / oct normal, depth, translucency
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = process.argv[2] || '/tmp/treebake';
const OUT = join(ROOT, 'public/tex/trees');
const DEPS = process.env.BAKE_DEPS || ROOT;
const req = createRequire(join(DEPS, 'package.json'));
const dep = (name) => import(pathToFileURL(req.resolve(name)).href);
const TMP = join(os.tmpdir(), 'ironfront-bake-trees');
mkdirSync(OUT, { recursive: true });
mkdirSync(TMP, { recursive: true });

// keep in step with tools/blender/trees.py
const CELLS = ['oak', 'young', 'birch', 'poplar', 'willow', 'fruit', 'spruce', 'pine', 'palm', 'acacia',
  'spruce_snow', 'pine_snow', 'birch_bare', 'bush', 'hedge', 'scrub', 'bush_bare', 'willow_strand',
  'palm_dead', 'bark_oak', 'bark_birch', 'bark_pine', 'bark_palm', 'bark_pine_top'];
const CGRID = [6, 4];
const FRAMES = { grid: 6, az: 12, els: [12, 38, 64] };
const FPX = [96, 48];
const CPX = [256, 128];

const meta = JSON.parse(readFileSync(join(RAW, 'meta.json'), 'utf8'));
const im = (...a) => execFileSync('convert', a.flat(), { stdio: ['ignore', 'pipe', 'inherit'] });
const kb = (f) => (statSync(f).size / 1024).toFixed(1);

/** RGBA PNG -> WebP; `data`: alpha is not coverage (keep the colour under it). */
function webp(src, dst, q, data = false) {
  // lossy (libwebp keeps the colour under any non-zero alpha: data maps get a floor of ~1% so the
  // bark normals under zero translucency survive; the shaders ignore anything that low)
  const floor = data ? ['-channel', 'A', '+level', '1.2%,100%', '+channel'] : [];
  im(src, ...floor, '-define', 'webp:lossless=false', '-define', 'webp:method=6', '-define', `webp:alpha-quality=${data ? 50 : 90}`, '-quality', String(q), dst);
}
/** Half size: RGB and A filtered separately when A is data (no alpha weighting). */
function half(src, dst, data) {
  if (!data) return im(src, '-filter', 'Box', '-resize', '50%', dst);
  const rgb = join(TMP, 'h_rgb.png');
  const a = join(TMP, 'h_a.png');
  im(src, '-alpha', 'off', '-filter', 'Box', '-resize', '50%', rgb);
  im(src, '-alpha', 'extract', '-filter', 'Box', '-resize', '50%', a);
  im(rgb, a, '-alpha', 'off', '-compose', 'CopyOpacity', '-composite', dst);
}

// ---- leaf-card atlas
const cellPng = (name, ch) => {
  const f = join(RAW, `cell_${name}_${ch}.png`);
  if (existsSync(f)) return f;
  const blank = join(TMP, `blank_${ch}.png`);
  im('-size', `${CPX[0]}x${CPX[0]}`, 'xc:none', blank);
  return blank;
};
for (const ch of ['a', 'n']) {
  const rows = [];
  for (let r = 0; r < CGRID[1]; r++) {
    const row = join(TMP, `row_${ch}_${r}.png`);
    const files = CELLS.slice(r * CGRID[0], (r + 1) * CGRID[0]).map((n) => cellPng(n, ch));
    while (files.length < CGRID[0]) files.push(cellPng('__none', ch));
    im(...files, '-background', 'none', '+append', row);
    rows.push(row);
  }
  const full = join(TMP, `cards_${ch}.png`);
  im(...rows, '-background', 'none', '-append', full);
  const small = join(TMP, `cards_${ch}_small.png`);
  half(full, small, ch === 'n');
  webp(full, join(OUT, `cards_${ch}_${CPX[0]}.webp`), ch === 'a' ? 86 : 76, ch === 'n');
  webp(small, join(OUT, `cards_${ch}_${CPX[1]}.webp`), ch === 'a' ? 86 : 76, ch === 'n');
  console.log(`cards ${ch}: ${kb(join(OUT, `cards_${ch}_${CPX[0]}.webp`))} KB / ${kb(join(OUT, `cards_${ch}_${CPX[1]}.webp`))} KB`);
}

// ---- impostors
const kinds = {};
let impKB = [0, 0];
for (const [kind, m] of Object.entries(meta)) {
  if (!m.Rf) continue;
  FPX.forEach((px, i) => {
    for (const ch of ['a', 'n']) {
      const src = join(RAW, `imp_${kind}_${px}_${ch}.png`);
      const dst = join(OUT, `imp_${kind}_${px}_${ch}.webp`);
      webp(src, dst, ch === 'a' ? 84 : 72, ch === 'n');
      impKB[i] += statSync(dst).size / 1024;
    }
  });
  kinds[kind] = { H: m.H, Rf: +m.Rf.toFixed(4), Cx: +m.Cx.toFixed(4), Cy: +m.Cy.toFixed(4), Cz: +m.Cz.toFixed(4), flexK: m.flexK, heroTris: m.hero_tris ?? 0, fullTris: m.tris_full };
}
console.log(`impostors: ${impKB[0].toFixed(0)} KB (${FPX[0]} px frames), ${impKB[1].toFixed(0)} KB (${FPX[1]} px)`);

// ---- hero meshes
const { NodeIO } = await dep('@gltf-transform/core');
const { ALL_EXTENSIONS } = await dep('@gltf-transform/extensions');
const { quantize, meshopt, dedup, prune } = await dep('@gltf-transform/functions');
const { MeshoptEncoder, MeshoptDecoder } = await dep('meshoptimizer');
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });
const doc = await io.read(join(RAW, 'hero_all.glb'));
await doc.transform(dedup(), prune(), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 14, quantizeColor: 8 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
const glb = join(OUT, 'trees.glb');
writeFileSync(glb, await io.writeBinary(doc));
console.log(`trees.glb: ${kb(glb)} KB`);

writeFileSync(join(OUT, 'trees.json'), JSON.stringify({ frames: FRAMES, cells: { grid: CGRID, names: CELLS }, framePx: FPX, cellPx: CPX, kinds }, null, 1) + '\n');
rmSync(TMP, { recursive: true, force: true });
console.log('done');
