#!/usr/bin/env node
/*
 * GD3 desert vegetation, last step (make.sh): compress the Blender export for the game.
 *
 *   node tools/blender/desertveg/pack.mjs        (from web/)
 *
 * build/desertveg/desert-veg-raw.glb -> public/models/desertveg/desert-veg.glb (weld + dedup + quantise + meshopt;
 *   LOD0, LOD1 and the far impostor of every plant; custom attributes _FLEX / _LEAF / _AO)
 * build/desertveg/desert-veg.json    -> public/models/desertveg/desert-veg.json (triangles and sizes per mesh)
 * build/desertveg/atlas-albedo.png   -> desert-veg-albedo.webp (RGBA: the alpha is the cutout; 1024 desktop, -512 phone / low)
 * build/desertveg/atlas-normal.png   -> desert-veg-normal.webp (1024, -512)
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
const BUILD = join(HERE, '..', 'build', 'desertveg');
const OUT = join(HERE, '..', '..', '..', 'public', 'models', 'desertveg');
mkdirSync(OUT, { recursive: true });

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const doc = await io.read(join(BUILD, 'desert-veg-raw.glb'));
// (the custom attributes are 0..1 weights: 8-bit normalised is plenty; the wind weight keeps 16)
await doc.transform(weld(), dedup(), prune(), quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeTexcoord: 14, quantizeGeneric: 12 }));
doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
const glb = join(OUT, 'desert-veg.glb');
await io.write(glb, doc);
copyFileSync(join(BUILD, 'desert-veg.json'), join(OUT, 'desert-veg.json'));

let tris = 0;
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += p.getIndices() ? p.getIndices().getCount() / 3 : 0;

const desk = { glb: statSync(glb).size };
const phone = { glb: desk.glb };
// [source, out name, desktop size, phone size, WebP quality, keep alpha]
const MAPS = [
  ['atlas-albedo', 'desert-veg-albedo', 1024, 512, 88, true],
  ['atlas-normal', 'desert-veg-normal', 1024, 512, 86, false],
];
for (const [src, name, big, small, q, alpha] of MAPS) {
  for (const [sz, sfx, out] of [
    [big, '', desk],
    [small, `-${small}`, phone],
  ]) {
    const dst = join(OUT, `${name}${sfx}.webp`);
    const input = [join(BUILD, `${src}.png`), ...(alpha ? [] : ['-alpha', 'off'])];
    const extra = alpha ? ['-define', 'webp:alpha-quality=100', '-define', 'webp:exact=true'] : [];
    execFileSync('convert', [...input, '-filter', 'Triangle', '-resize', `${sz}x${sz}`, '-define', 'webp:method=6', '-define', 'webp:use-sharp-yuv=true', ...extra, '-quality', String(q), dst]);
    out[name] = statSync(dst).size;
  }
}
const kb = (o) => (Object.values(o).reduce((a, b) => a + b, 0) / 1024).toFixed(0);
console.log(`[pack] desert-veg: ${doc.getRoot().listMeshes().length} meshes, ${tris} triangles (all plants, all LODs)`);
console.log(`[pack] desktop ${kb(desk)} KB ${JSON.stringify(desk)}`);
console.log(`[pack] phone ${kb(phone)} KB ${JSON.stringify(phone)}`);
