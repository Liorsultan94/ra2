#!/usr/bin/env node
/*
 * GD2 Sinai building kit, last step (make.sh): compress the Blender export for the game.
 *
 *   node tools/blender/sinai/pack.mjs        (from web/)
 *
 * build/sinai/sinai-kit-raw.glb -> public/models/sinai/sinai-kit.glb (weld + dedup + quantise + meshopt; the
 *   LOD1 meshes are Blender's own "<piece>_l1", baked into the same atlas)
 * build/sinai/sinai-kit.json    -> public/models/sinai/sinai-kit.json (card rects, swatches, piece triangles)
 * build/sinai/atlas-{albedo,normal,orm}.png -> sinai-atlas-*.webp (1024, desktop) + -512 (phone / low)
 * build/sinai/plaster-{albedo,normal,orm}.png -> sinai-plaster-*.webp (512) + -256
 * Prints the download per profile.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build', 'sinai');
const OUT = join(HERE, '..', '..', '..', 'public', 'models', 'sinai');
mkdirSync(OUT, { recursive: true });

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(join(BUILD, 'sinai-kit-raw.glb'));
await doc.transform(weld(), dedup(), prune(), quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 14 }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
const glb = join(OUT, 'sinai-kit.glb');
await io.write(glb, doc);
copyFileSync(join(BUILD, 'sinai-kit.json'), join(OUT, 'sinai-kit.json'));

let tris = 0;
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices() ? p.getIndices().getCount() / 3 : 0;

const desk = { glb: statSync(glb).size };
const phone = { glb: desk.glb };
// [source, out name, desktop size, phone size, WebP quality] (ImageMagick 6's webp:target-size misfires on some maps)
const MAPS = [
  ['atlas-albedo', 'sinai-atlas-albedo', 1024, 512, 84],
  ['atlas-normal', 'sinai-atlas-normal', 1024, 512, 86],
  ['atlas-orm', 'sinai-atlas-orm', 1024, 512, 80],
  ['plaster-albedo', 'sinai-plaster-albedo', 512, 256, 80],
  ['plaster-normal', 'sinai-plaster-normal', 512, 256, 84],
  ['plaster-orm', 'sinai-plaster-orm', 512, 256, 60],
];
for (const [src, name, big, small, q] of MAPS) {
  for (const [sz, sfx, out] of [
    [big, '', desk],
    [small, `-${small}`, phone],
  ]) {
    const dst = join(OUT, `${name}${sfx}.webp`);
    const input = [join(BUILD, `${src}.png`), '-alpha', 'off'];
    execFileSync('convert', [...input, '-filter', 'Triangle', '-resize', `${sz}x${sz}`, '-define', 'webp:method=6', '-define', 'webp:use-sharp-yuv=true', '-quality', String(q), dst]);
    out[name] = statSync(dst).size;
  }
}
const kb = (o) => (Object.values(o).reduce((a, b) => a + b, 0) / 1024).toFixed(0);
console.log(`[pack] sinai-kit: ${doc.getRoot().listMeshes().length} meshes, ${tris} triangles (all pieces, both LODs)`);
console.log(`[pack] desktop ${kb(desk)} KB ${JSON.stringify(desk)}`);
console.log(`[pack] phone ${kb(phone)} KB ${JSON.stringify(phone)}`);
