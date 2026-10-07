/*
 * Step 1 of the Blender asset pipeline (see make.sh): dump the game's procedural models as reference
 * geometry for Blender, so the Blender versions keep the exact proportions, pivots and attachment points.
 *
 *   npx vitest run --config tools/blender/vitest.config.ts
 *
 * Writes tools/blender/build/<asset>-proc.glb (+ .json with pivots / anchors). Each static mesh of the
 * template becomes one glTF node named "<part>|<bucket>" with its geometry in the part's local frame
 * (part = body / turret / recoil for vehicles, root for buildings), carrying POSITION, NORMAL,
 * COLOR_0 (vertex paint), TEXCOORD_0 / TEXCOORD_1 (buildings: atlas uv, tile id) when present.
 * Canvas textures are stubbed: only the geometry matters here.
 */
import { it } from 'vitest';
import * as THREE from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO } from '@gltf-transform/core';

const OUT = join(dirname(fileURLToPath(import.meta.url)), 'build');

// --- minimal 2D canvas stub (the builders paint a few canvas textures; geometry does not depend on them)
const ctx: Record<string | symbol, unknown> = new Proxy(
  {},
  {
    get(t: Record<string | symbol, unknown>, k) {
      if (k in t) return t[k];
      if (k === 'getImageData' || k === 'createImageData')
        return (x: number, y: number, w?: number, h?: number) => ({ data: new Uint8ClampedArray(Math.max(4, ((w ?? x) | 0) * ((h ?? y) | 0) * 4)), width: w ?? x, height: h ?? y });
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => ({ addColorStop() {} });
      return () => {};
    },
    set(t: Record<string | symbol, unknown>, k, v) {
      t[k] = v;
      return true;
    },
  },
);
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({ width: 1, height: 1, style: {}, getContext: () => ctx, toDataURL: () => '' }),
};

const ISRAEL = { team: 0x2a6cff, hull: 0x8a8070, accent: 0x888888, flag: [0xffffff, 0x0038b8, 0xffffff], faction: 'israel', region: 'west' } as const;

function addMesh(doc: Document, scene: ReturnType<Document['createScene']>, name: string, g: THREE.BufferGeometry, m?: THREE.Matrix4) {
  const geo = g.index ? g.toNonIndexed() : g.clone();
  if (m) geo.applyMatrix4(m);
  const buf = doc.getRoot().listBuffers()[0];
  const prim = doc.createPrimitive();
  const acc = (arr: Float32Array, type: 'VEC2' | 'VEC3' | 'VEC4') => doc.createAccessor().setType(type).setArray(arr).setBuffer(buf);
  prim.setAttribute('POSITION', acc(new Float32Array(geo.attributes.position.array), 'VEC3'));
  if (geo.attributes.normal) prim.setAttribute('NORMAL', acc(new Float32Array(geo.attributes.normal.array), 'VEC3'));
  const col = geo.attributes.color;
  if (col) {
    const n = col.count;
    const c4 = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      c4[i * 4] = col.getX(i);
      c4[i * 4 + 1] = col.getY(i);
      c4[i * 4 + 2] = col.getZ(i);
      c4[i * 4 + 3] = 1;
    }
    prim.setAttribute('COLOR_0', acc(c4, 'VEC4'));
  }
  if (geo.attributes.uv) prim.setAttribute('TEXCOORD_0', acc(new Float32Array(geo.attributes.uv.array), 'VEC2'));
  if (geo.attributes.uv1 && geo.attributes.uv1.itemSize === 2) prim.setAttribute('TEXCOORD_1', acc(new Float32Array(geo.attributes.uv1.array), 'VEC2'));
  const mesh = doc.createMesh(name).addPrimitive(prim);
  scene.addChild(doc.createNode(name).setMesh(mesh));
}

async function write(doc: Document, name: string, meta: unknown) {
  mkdirSync(OUT, { recursive: true });
  await new NodeIO().write(join(OUT, name + '-proc.glb'), doc);
  writeFileSync(join(OUT, name + '-proc.json'), JSON.stringify(meta, null, 1));
}

const bucketName = (bk: string) => (bk === 's-1' ? 'camo' : bk === 'D' ? 'paint' : bk === 'M' ? 'metal' : 'glow' + bk);

it('export merkava (mbt | israel)', async () => {
  const { createModel } = await import('../../src/render/models');
  const m = createModel('mbt', ISRAEL as never, null);
  m.root.updateMatrixWorld(true);
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('merkava');
  const parts: Record<string, { pos: number[]; rotZ: number; world: number[] }> = {};
  const wp = new THREE.Vector3();
  m.root.traverse((o) => {
    const tag = (o.userData.tag as string | undefined)?.split(' ')[0];
    if (tag === 'body' || tag === 'turret' || tag === 'gunpiv' || tag === 'recoil' || tag === 'hlid' || tag === 'crew' || tag === 'whip') {
      o.getWorldPosition(wp);
      parts[tag] = { pos: o.position.toArray(), rotZ: o.rotation.z, world: wp.toArray() };
    }
    const me = o as THREE.Mesh;
    if (!me.isMesh || (me as THREE.InstancedMesh).isInstancedMesh) return;
    const ptag = (o.parent?.userData.tag as string | undefined)?.split(' ')[0];
    const bk = o.userData.bk as string | undefined;
    if (o.userData.tag === 'belt') {
      // track belts: root space, reference only
      addMesh(doc, scene, 'ref|belt', me.geometry, me.matrixWorld);
      return;
    }
    if (!bk || !ptag || !['body', 'turret', 'recoil'].includes(ptag)) return;
    addMesh(doc, scene, `${ptag}|${bucketName(bk)}`, me.geometry);
  });
  // road wheels (instanced): one reference copy per instance, root space
  m.root.traverse((o) => {
    const im = o as THREE.InstancedMesh;
    if (!im.isInstancedMesh) return;
    const mm = new THREE.Matrix4();
    for (let i = 0; i < im.count; i++) {
      im.getMatrixAt(i, mm);
      addMesh(doc, scene, `ref|wheel${i}`, im.geometry, im.matrixWorld.clone().multiply(mm));
    }
  });
  const muzzle = new THREE.Vector3();
  m.muzzles[0]?.getWorldPosition(muzzle);
  await write(doc, 'merkava', { parts, muzzle: muzzle.toArray(), size: m.size, height: m.height, damageFx: m.damageFx });
});

it('export war factory (factory | israel)', async () => {
  const { createModel } = await import('../../src/render/models');
  const m = createModel('factory', ISRAEL as never, null);
  m.root.updateMatrixWorld(true);
  const doc = new Document();
  doc.createBuffer();
  const scene = doc.createScene('factory');
  const nodes: Record<string, number[]> = {};
  let i = 0;
  m.root.traverse((o) => {
    if (o.name && o !== m.root) nodes[o.name] = o.position.toArray();
    const me = o as THREE.Mesh;
    if (!me.isMesh) return;
    const mat = me.material as THREE.MeshStandardMaterial;
    const anim = o.parent && o.parent !== m.root && o.parent.name !== 'lod-detail' ? o.parent.name : '';
    const kind = mat.emissive && mat.emissive.getHex() && mat.emissiveIntensity > 0.2 ? 'glow' : mat.transparent ? 'alpha' : 'solid';
    addMesh(doc, scene, `${anim || (o.parent?.name === 'lod-detail' ? 'detail' : 'root')}|${kind}|${i++}`, me.geometry, anim ? undefined : me.matrixWorld);
  });
  await write(doc, 'factory', { nodes, size: m.size, height: m.height, damageFx: m.damageFx, nightLights: m.nightLights });
});
