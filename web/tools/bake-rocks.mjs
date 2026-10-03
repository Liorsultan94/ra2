#!/usr/bin/env node
/*
 * Offline baker for the photoscanned rocks (web/public/tex/rocks/).
 *
 *   npm i --no-save --prefix /tmp/bakedeps @gltf-transform/core@4 @gltf-transform/functions@4 @gltf-transform/extensions@4 meshoptimizer
 *   BAKE_DEPS=/tmp/bakedeps node tools/bake-rocks.mjs
 *
 * (the glTF tooling is only needed here, so it is not a dependency of the game;
 * ImageMagick `convert` is used for the texture atlases.)
 *
 * Four CC0 rock scans from Poly Haven (glTF, 1k textures), one per rock class
 * of src/render/rocks.ts: two ridge outcrops, a boulder and a flat stone for
 * the scree. Each is
 *   - welded and simplified with meshoptimizer (attribute-aware) to a near
 *     model (<= ~1500 triangles) and a far model (<= ~300);
 *   - normalised like the procedural rocks: horizontal radius 1, base at
 *     y = -0.4 (the game sinks and scales every instance itself);
 *   - its UVs moved into one quadrant of a shared 2 x 2 texture atlas, so all
 *     rocks use a single material (512 px per rock on high, 256 on medium).
 * Output: rocks.glb (geometry only, quantised + EXT_meshopt_compression),
 * rocks_a_{512,1024}.webp (albedo with the AO folded in), rocks_n_{512,1024}.webp
 * (OpenGL normal map) and rocks.json (sizes, triangle counts, sources).
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = join(process.env.BAKE_CACHE || join(os.tmpdir(), 'ironfront-bake-cache'), 'rocks');
const OUT = join(ROOT, 'public/tex/rocks');
const DEPS = process.env.BAKE_DEPS || ROOT;
const req = createRequire(join(DEPS, 'package.json'));
const dep = (name) => import(pathToFileURL(req.resolve(name)).href);

const { NodeIO, Document } = await dep('@gltf-transform/core');
const { ALL_EXTENSIONS, EXTMeshoptCompression } = await dep('@gltf-transform/extensions');
const { weld, simplify, quantize, meshopt, dedup, prune, cloneDocument } = await dep('@gltf-transform/functions');
const { MeshoptSimplifier, MeshoptEncoder, MeshoptDecoder } = await dep('meshoptimizer');
await MeshoptSimplifier.ready;
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;

/** Atlas cell order = rock class index in rocks.ts. */
const ROCKS = [
  { key: 'outcrop', src: 'namaqualand_boulder_03', hi: 1400, lo: 280, note: 'ridge outcrop (blocky)' },
  { key: 'crag', src: 'namaqualand_boulder_04', hi: 1500, lo: 300, note: 'ridge outcrop (rounded, weathered)' },
  { key: 'boulder', src: 'namaqualand_boulder_06', hi: 900, lo: 200, note: 'boulder' },
  { key: 'stone', src: 'namaqualand_boulder_05', hi: 400, lo: 90, note: 'flat stone (scree)' },
];
const PAD = 6 / 512; // atlas gutter (uv units of a cell)

mkdirSync(CACHE, { recursive: true });
mkdirSync(OUT, { recursive: true });

function fetchTo(url, file) {
  if (existsSync(file) && statSync(file).size > 0) return file;
  mkdirSync(dirname(file), { recursive: true });
  console.log('  download', url);
  execFileSync('curl', ['-sSfL', '--retry', '3', '-m', '600', '-o', file + '.part', url], { stdio: 'inherit' });
  execFileSync('mv', [file + '.part', file]);
  return file;
}

/** Download the 1k glTF (and its bin / textures) of a Poly Haven model. */
function download(id) {
  const dir = join(CACHE, id);
  const files = JSON.parse(readFileSync(fetchTo(`https://api.polyhaven.com/files/${id}`, join(dir, 'files.json')), 'utf8'));
  const g = files.gltf['1k'].gltf;
  const gltf = fetchTo(g.url, join(dir, `${id}.gltf`));
  for (const [rel, f] of Object.entries(g.include)) fetchTo(f.url, join(dir, rel));
  const tex = (k) => Object.keys(g.include).find((r) => r.includes(`_${k}_`));
  return { gltf, dir, diff: join(dir, tex('diff')), nor: join(dir, tex('nor_gl')), arm: tex('arm') ? join(dir, tex('arm')) : null };
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

/** World-space triangle soup of the document's meshes: { pos, nrm, uv, idx } (indexed). */
function extract(doc) {
  const pos = [];
  const nrm = [];
  const uv = [];
  const idx = [];
  const m = new Float64Array(16);
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const W = node.getWorldMatrix();
    m.set(W);
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION');
      const N = prim.getAttribute('NORMAL');
      const T = prim.getAttribute('TEXCOORD_0');
      const I = prim.getIndices();
      const base = pos.length / 3;
      const p = [0, 0, 0];
      const n = [0, 0, 0];
      const t = [0, 0];
      for (let i = 0; i < P.getCount(); i++) {
        P.getElement(i, p);
        pos.push(m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]);
        if (N) {
          N.getElement(i, n);
          const x = m[0] * n[0] + m[4] * n[1] + m[8] * n[2];
          const y = m[1] * n[0] + m[5] * n[1] + m[9] * n[2];
          const z = m[2] * n[0] + m[6] * n[1] + m[10] * n[2];
          const l = Math.hypot(x, y, z) || 1;
          nrm.push(x / l, y / l, z / l);
        } else nrm.push(0, 1, 0);
        if (T) {
          T.getElement(i, t);
          uv.push(t[0], t[1]);
        } else uv.push(0, 0);
      }
      if (I) for (let i = 0; i < I.getCount(); i++) idx.push(base + I.getScalar(i));
      else for (let i = 0; i < P.getCount(); i++) idx.push(base + i);
    }
  }
  return { pos, nrm, uv, idx };
}

async function simplified(file, target) {
  const doc = await io.read(file);
  // only the geometry matters (textures are baked separately)
  for (const t of doc.getRoot().listTextures()) t.dispose();
  for (const mt of doc.getRoot().listMaterials()) mt.dispose();
  await doc.transform(weld());
  let tris = 0;
  for (const mesh of doc.getRoot().listMeshes()) for (const p of mesh.listPrimitives()) tris += p.getIndices().getCount() / 3;
  const ratio = Math.min(1, target / tris);
  // simplify with a growing error budget until the triangle target is met
  for (const error of [0.002, 0.005, 0.01, 0.02, 0.04, 0.08]) {
    const d = cloneDocument(doc);
    await d.transform(simplify({ simplifier: MeshoptSimplifier, ratio, error, lockBorder: false }));
    const g = extract(d);
    if (g.idx.length / 3 <= target * 1.15 || error === 0.08) return { ...g, src: tris, error };
  }
}

const out = new Document();
const buf = out.createBuffer();
const scene = out.createScene('rocks');
const info = [];
for (const [ci, r] of ROCKS.entries()) {
  console.log(`rock ${r.key} <- ${r.src}`);
  const src = download(r.src);
  const lods = { hi: await simplified(src.gltf, r.hi), lo: await simplified(src.gltf, r.lo) };
  // normalise on the near model's bounds: horizontal radius 1, base at y = -0.4
  const P = lods.hi.pos;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, z0 = Infinity, z1 = -Infinity;
  for (let i = 0; i < P.length; i += 3) {
    x0 = Math.min(x0, P[i]);
    x1 = Math.max(x1, P[i]);
    y0 = Math.min(y0, P[i + 1]);
    z0 = Math.min(z0, P[i + 2]);
    z1 = Math.max(z1, P[i + 2]);
  }
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const s = 1 / Math.max((x1 - x0) / 2, (z1 - z0) / 2);
  const cu = (ci % 2) * 0.5;
  const cv = Math.floor(ci / 2) * 0.5;
  const rec = { key: r.key, src: r.src, page: `https://polyhaven.com/a/${r.src}`, note: r.note, sourceTris: lods.hi.src, cell: ci };
  for (const [lk, g] of Object.entries(lods)) {
    const n = g.pos.length / 3;
    const pos = new Float32Array(n * 3);
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = (g.pos[i * 3] - cx) * s;
      pos[i * 3 + 1] = (g.pos[i * 3 + 1] - y0) * s - 0.4;
      pos[i * 3 + 2] = (g.pos[i * 3 + 2] - cz) * s;
      // glTF uv (v down) -> the atlas cell, inside its gutter
      const u = g.uv[i * 2] - Math.floor(g.uv[i * 2]);
      const v = g.uv[i * 2 + 1] - Math.floor(g.uv[i * 2 + 1]);
      uv[i * 2] = cu + PAD * 0.5 + u * (0.5 - PAD);
      uv[i * 2 + 1] = cv + PAD * 0.5 + v * (0.5 - PAD);
    }
    const prim = out
      .createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(pos).setBuffer(buf))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(g.nrm)).setBuffer(buf))
      .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(uv).setBuffer(buf))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(n > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx)).setBuffer(buf));
    const name = `${r.key}_${lk}`;
    scene.addChild(out.createNode(name).setMesh(out.createMesh(name).addPrimitive(prim)));
    rec[lk + 'Tris'] = g.idx.length / 3;
    console.log(`  ${lk}: ${g.idx.length / 3} tris (from ${g.src}, error ${g.error})`);
  }
  rec.files = src;
  info.push(rec);
}
await out.transform(dedup(), prune(), quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12 }), meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
out.createExtension(EXTMeshoptCompression).setRequired(true);
const glb = await io.writeBinary(out);
writeFileSync(join(OUT, 'rocks.glb'), glb);
console.log(`rocks.glb ${(glb.byteLength / 1024).toFixed(0)} KB`);


// ---- texture atlases: 2 x 2 cells, albedo (AO folded in) and normal
const sizes = {};
for (const S of [512, 1024]) {
  const c = S / 2;
  const inner = Math.round(c * (1 - PAD * 2));
  const off = Math.round((c - inner) / 2);
  // each cell: the map resized into the cell minus its gutter, the gutter filled by edge extension
  const fit = (tokens) => ['(', ...tokens, '-resize', `${inner}x${inner}!`, '-virtual-pixel', 'edge', '-set', 'option:distort:viewport', `${c}x${c}-${off}-${off}`, '-distort', 'SRT', '0', '+repage', ')'];
  // albedo x mix(1, ao, 0.6) (ao = red channel of the ARM map)
  const albedo = info.map((r) => fit([r.files.diff, ...(r.files.arm ? ['(', r.files.arm, '-channel', 'R', '-separate', '+channel', '-evaluate', 'multiply', '0.6', '-evaluate', 'add', `${Math.round(0.4 * 65535)}`, ')', '-compose', 'multiply', '-composite'] : [])]));
  const normal = info.map((r) => fit([r.files.nor]));
  // cells 0..3 = top-left, top-right, bottom-left, bottom-right (glTF v points down the image; uploaded with flipY = false)
  const grid = (cells, file) => {
    execFileSync('convert', ['(', ...cells[0], ...cells[1], '+append', ')', '(', ...cells[2], ...cells[3], '+append', ')', '-append', '-define', 'webp:target-psnr=37', '-define', 'webp:method=6', file]);
    return statSync(file).size;
  };
  const fa = join(OUT, `rocks_a_${S}.webp`);
  const fn = join(OUT, `rocks_n_${S}.webp`);
  sizes[S] = { albedo: grid(albedo, fa), normal: grid(normal, fn) };
  console.log(`atlas ${S}: ${(sizes[S].albedo / 1024).toFixed(0)} + ${(sizes[S].normal / 1024).toFixed(0)} KB`);
}

writeFileSync(
  join(OUT, 'rocks.json'),
  JSON.stringify(
    {
      version: 1,
      generated: 'tools/bake-rocks.mjs',
      license: 'CC0 1.0 (Poly Haven)',
      glb: { file: 'rocks.glb', bytes: glb.byteLength },
      atlas: sizes,
      rocks: info.map(({ files, ...r }) => r),
    },
    null,
    1,
  ) + '\n',
);
