#!/usr/bin/env node
/*
 * Blender 5.2.2 asset pipeline, step 3 (see make.sh): pack a Blender export for the game.
 *
 *   node tools/blender/pack.mjs <asset>        (from web/)
 *
 * build/<asset>-raw.glb  -> public/models/blender/<asset>.glb  (weld + dedup + meshopt, quantised)
 *   LOD1 / LOD2 ("<part>_lod1", "<part>_lod2") are meshoptimizer simplifications stored as index buffers
 *   over the LOD0 vertex data (shared accessors: the LODs cost only their indices in the download).
 * build/<asset>-{albedo,normal,orm}.png -> public/models/blender/<asset>-*.webp (1024 px)
 * Prints the triangle count per mesh and the download size.
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

// [ratio, error, flags]: LOD1 keeps the attribute seams, LOD2 may cross them and prunes the small islands
const LODS = [[0.5, 0.04, ['Prune']], [0.28, 0.15, ['Prune', 'Permissive']]];
await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(join(BUILD, `${asset}-raw.glb`));
const root = doc.getRoot();
for (const n of root.listNodes()) if (/_lod\d$/.test(n.getName())) n.dispose();
await doc.transform(weld(), dedup(), prune());
const scene = root.listScenes()[0];
for (const node of root.listNodes()) {
  const mesh = node.getMesh();
  if (!mesh) continue;
  const prim = mesh.listPrimitives()[0];
  const pos = new Float32Array(prim.getAttribute('POSITION').getArray());
  const idx = new Uint32Array(prim.getIndices().getArray());
  LODS.forEach(([ratio, err, flags], i) => {
    const target = Math.floor((idx.length * ratio) / 3) * 3;
    const [lod] = MeshoptSimplifier.simplify(idx, pos, 3, target, err, flags);
    const p2 = doc.createPrimitive().setIndices(doc.createAccessor().setType('SCALAR').setArray(lod).setBuffer(root.listBuffers()[0]));
    for (const sem of prim.listSemantics()) p2.setAttribute(sem, prim.getAttribute(sem));
    const m2 = doc.createMesh(`${mesh.getName()}_lod${i + 1}`).addPrimitive(p2);
    const n2 = doc.createNode(`${node.getName()}_lod${i + 1}`).setMesh(m2).setTranslation(node.getTranslation()).setRotation(node.getRotation()).setScale(node.getScale());
    scene.addChild(n2);
  });
}
// quantise + meshopt-compress in place (no reorder / compaction pass: it would give each LOD its own copy of the vertices)
await doc.transform(quantize({ quantizePosition: 12, quantizeNormal: 8, quantizeTexcoord: 12 }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
const glb = join(OUT, `${asset}.glb`);
await io.write(glb, doc);
const tris = {};
for (const m of doc.getRoot().listMeshes())
  for (const p of m.listPrimitives()) tris[m.getName()] = `${(p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3}t/${p.getAttribute('POSITION').getCount()}v`;

let total = statSync(glb).size;
const sizes = { glb: statSync(glb).size };
// orm (team mask / roughness / metal) is smooth: half resolution
const Q = { albedo: 84, normal: 80, orm: 80 };
const SIZE = { albedo: 1024, normal: 1024, orm: 512 };
for (const layer of ['albedo', 'normal', 'orm']) {
  const dst = join(OUT, `${asset}-${layer}.webp`);
  execFileSync('convert', [join(BUILD, `${asset}-${layer}.png`), '-resize', `${SIZE[layer]}x${SIZE[layer]}`, '-alpha', 'off', '-define', 'webp:method=6', '-quality', String(Q[layer]), dst]);
  sizes[layer] = statSync(dst).size;
  total += sizes[layer];
}
console.log(`[pack] ${asset}: tris ${JSON.stringify(tris)}`);
console.log(`[pack] ${asset}: bytes ${JSON.stringify(sizes)} total ${(total / 1024).toFixed(0)} KB`);
