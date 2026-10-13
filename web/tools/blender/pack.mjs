#!/usr/bin/env node
/*
 * Blender 5.2.2 asset pipeline, last step (see hero-game/make.sh): pack a Blender export for the game.
 *
 *   node tools/blender/pack.mjs <asset>        (from web/)
 *
 * build/<asset>-raw.glb  -> public/models/blender/<asset>.glb  (weld + dedup + meshopt, quantised)
 *   LOD1 / LOD2 ("<part>_lod1", "<part>_lod2") are meshoptimizer simplifications stored as index buffers
 *   over the LOD0 vertex data (shared accessors: the LODs cost only their indices in the download).
 * build/<asset>-{albedo,normal,orm}.png -> public/models/blender/<asset>-*.webp, and -256 variants for
 *   the phone profile.
 * Prints the triangle count per mesh / LOD and the download size.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, weld } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, 'build');
const OUT = join(HERE, '..', '..', 'public', 'models', 'blender');
const asset = process.argv[2];
if (!asset) throw new Error('usage: pack.mjs <asset>');
mkdirSync(OUT, { recursive: true });

/*
 * Per asset: LOD [ratio, error, flags] (LOD1 keeps the attribute seams, LOD2 may cross them and prunes the
 * small islands; parts under `keep` triangles stay whole at LOD1), map sizes and WebP qualities.
 * Infantry: LOD1 is the battle-zoom mesh, so it keeps most of the silhouette.
 */
const CFG = {
  'idf-rifleman': {
    // LOD1 is what battle zoom shows (soldiers ~20-65 px): about the procedural soldier's LOD1 / LOD2 budgets
    lods: [
      [0.42, 0.2, ['Prune', 'Permissive']],
      [0.21, 0.2, ['Prune', 'Permissive']],
    ],
    keep: 24,
    size: { albedo: 512, normal: 512, orm: 256 },
    small: { albedo: 256, normal: 256, orm: 128 },
    // WebP byte targets (KB): ImageMagick 6's WebP writer ignores -quality, webp:target-size works
    kb: { albedo: 30, normal: 36, orm: 14 },
    smallKb: { albedo: 13, normal: 14, orm: 6 },
  },
  // hero tier of the IDF rifleman (hero-game/): one close-up mesh per bone, 1024 px maps (512 px phone)
  'idf-rifleman-hero': {
    lods: [],
    keep: 0,
    size: { albedo: 1024, normal: 1024, orm: 256 },
    small: { albedo: 512, normal: 512, orm: 256 },
    smallSfx: '-512',
    kb: { albedo: 72, normal: 92, orm: 18 },
    smallKb: { albedo: 34, normal: 40, orm: 18 },
  },
};
const cfg = CFG[asset];
if (!cfg) throw new Error(`pack.mjs: no config for ${asset}`);
// tuning: PACK_LODS='[[ratio, error, flags], [...]]' overrides the LOD settings for one run
if (process.env.PACK_LODS) cfg.lods = JSON.parse(process.env.PACK_LODS);

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(join(BUILD, `${asset}-raw.glb`));
const root = doc.getRoot();
for (const n of root.listNodes()) if (/_lod\d$/.test(n.getName())) n.dispose();
await doc.transform(weld(), dedup(), prune());
const scene = root.listScenes()[0];
// vertex cache / fetch order of each LOD0 mesh (meshopt compresses far better in this order); the LOD index
// subsets are built afterwards over the reordered vertices, so they still share them
for (const node of root.listNodes()) {
  const prim = node.getMesh()?.listPrimitives()[0];
  if (!prim) continue;
  const idx = new Uint32Array(prim.getIndices().getArray());
  const [remap, unique] = MeshoptEncoder.reorderMesh(idx, true, true);
  for (const sem of prim.listSemantics()) {
    const acc = prim.getAttribute(sem);
    const src = acc.getArray();
    const n = acc.getElementSize();
    const dst = new src.constructor(unique * n);
    for (let i = 0; i < remap.length; i++) if (remap[i] !== 0xffffffff) for (let c = 0; c < n; c++) dst[remap[i] * n + c] = src[i * n + c];
    acc.setArray(dst);
  }
  prim.getIndices().setArray(idx);
}
const lodTris = [0, 0, 0];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const prim = mesh.listPrimitives()[0];
  const pos = new Float32Array(prim.getAttribute('POSITION').getArray());
  const idx = new Uint32Array(prim.getIndices().getArray());
  lodTris[0] += idx.length / 3;
  cfg.lods.forEach(([ratio, err, flags], i) => {
    let lod = idx;
    if (idx.length / 3 > cfg.keep || i > 0) {
      const target = Math.floor((idx.length * ratio) / 3) * 3;
      [lod] = MeshoptSimplifier.simplify(idx, pos, 3, target, err, flags);
    }
    lodTris[i + 1] += lod.length / 3;
    const p2 = doc.createPrimitive().setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(lod)).setBuffer(root.listBuffers()[0]));
    for (const sem of prim.listSemantics()) p2.setAttribute(sem, prim.getAttribute(sem));
    const m2 = doc.createMesh(`${mesh.getName()}_lod${i + 1}`).addPrimitive(p2);
    const n2 = doc.createNode(`${node.getName()}_lod${i + 1}`).setMesh(m2).setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale());
    scene.addChild(n2);
  });
}
// quantise + meshopt-compress in place (no reorder / compaction pass: it would give each LOD its own copy of the vertices)
await doc.transform(quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 12 }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
const glb = join(OUT, `${asset}.glb`);
await io.write(glb, doc);

const sizes = { glb: statSync(glb).size };
const small = { glb: sizes.glb };
for (const layer of ['albedo', 'normal', 'orm']) {
  for (const [sfx, sz, out, kb] of [
    ['', cfg.size[layer], sizes, cfg.kb[layer]],
    [cfg.smallSfx ?? '-256', cfg.small[layer], small, cfg.smallKb[layer]],
  ]) {
    const dst = join(OUT, `${asset}-${layer}${sfx}.webp`);
    // box-filtered downsample of the 1024 (hero: 2048) bake (Lanczos rings on the normal map's island edges)
    execFileSync('convert', [join(BUILD, `${asset}-${layer}.png`), '-filter', 'Triangle', '-resize', `${sz}x${sz}`, '-alpha', 'off', '-define', 'webp:method=6', '-define', `webp:target-size=${kb * 1024}`, dst]);
    out[layer] = statSync(dst).size;
  }
}
const kb = (o) => (Object.values(o).reduce((a, b) => a + b, 0) / 1024).toFixed(0);
console.log(`[pack] ${asset}: triangles per LOD ${lodTris.join(' / ')}`);
console.log(`[pack] ${asset}: desktop ${JSON.stringify(sizes)} = ${kb(sizes)} KB, phone ${JSON.stringify(small)} = ${kb(small)} KB`);
