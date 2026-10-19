#!/usr/bin/env node
/*
 * NV1 naval kit, last step (make.sh): compress the Blender export for the game.
 *
 *   node tools/blender/naval/pack.mjs        (from web/)
 *
 * build/naval/naval-raw.glb -> public/models/naval/naval.glb (weld + dedup + quantise + meshopt; LOD1 meshes are the
 *   "<mesh>_l1" siblings, vertex colours carry albedo x AO)
 * build/naval/naval.json    -> public/models/naval/naval.json (triangles, sizes, lamps)
 * build/naval/naval-{rust,rust-n,glaze,solar}.png -> naval-*.webp (256 / 128 px tiles; the hall's tiled maps)
 * build/naval/cameo-*.png   -> public/ui/cameos/<key>.jpg (the build menu's pictures, 288 x 216)
 * Prints the download.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, quantize, weld } from '@gltf-transform/functions';
import { MeshoptEncoder } from 'meshoptimizer';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '..', 'build', 'naval');
const WEB = join(HERE, '..', '..', '..');
const OUT = join(WEB, 'public', 'models', 'naval');
const CAMEOS = join(WEB, 'public', 'ui', 'cameos');
mkdirSync(OUT, { recursive: true });

await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
// one GLB for the Shipyard, one per nation (naval-<group>-raw.glb -> naval-<group>.glb)
let bytes = 0;
let tris = 0;
const per = {};
for (const f of readdirSync(BUILD)) {
  const m = /^naval-(\w+)-raw\.glb$/.exec(f);
  if (!m) continue;
  const doc = await io.read(join(BUILD, f));
  // (materials are told apart by name only: keep them, the game assigns its shaders by name)
  await doc.transform(weld(), dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH] }), prune({ keepLeaves: true }), quantize({ quantizePosition: 14, quantizeNormal: 8, quantizeColor: 8 }));
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.FILTER });
  const glb = join(OUT, `naval-${m[1]}.glb`);
  await io.write(glb, doc);
  per[m[1]] = statSync(glb).size;
  bytes += per[m[1]];
  for (const me of doc.getRoot().listMeshes()) for (const p of me.listPrimitives()) tris += p.getIndices() ? p.getIndices().getCount() / 3 : 0;
}
copyFileSync(join(BUILD, 'naval.json'), join(OUT, 'naval.json'));
for (const [src, q] of [['naval-rust', 82], ['naval-rust-n', 90], ['naval-glaze', 86], ['naval-solar', 86]]) {
  const dst = join(OUT, `${src}.webp`);
  execFileSync('convert', [join(BUILD, `${src}.png`), '-alpha', 'off', '-define', 'webp:method=6', '-quality', String(q), dst]);
  bytes += statSync(dst).size;
}
let cam = 0;
if (existsSync(BUILD)) {
  for (const f of readdirSync(BUILD)) {
    if (!f.startsWith('cameo-') || !f.endsWith('.png')) continue;
    const key = f.slice(6, -4);
    const dst = join(CAMEOS, `${key}.jpg`);
    execFileSync('convert', [join(BUILD, f), '-resize', '288x216', '-quality', '84', '-sampling-factor', '4:2:0', '-strip', dst]);
    cam += statSync(dst).size;
  }
}
console.log(`[pack] naval GLBs + maps: ${(bytes / 1024).toFixed(0)} KB, ${tris} triangles (every model, both LODs); cameos ${(cam / 1024).toFixed(0)} KB`);
console.log(`[pack] per file (KB): ${Object.entries(per).map(([k, v]) => `${k} ${(v / 1024).toFixed(0)}`).join(', ')}`);
