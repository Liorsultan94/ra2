/*
 * Step 1 of the Blender asset pipeline (see make.sh): dump the game's procedural models as reference
 * geometry for Blender, so the Blender versions keep the exact proportions, pivots and attachment points.
 *
 *   npx vitest run --config tools/blender/vitest.config.ts
 *
 * Infantry (models/infantry.ts) -> build/<asset>-proc.glb + .json:
 *  - one glTF node per (bone, material, LOD mask) named "<bone>|<mk>|<mask>", positions in BODY space at
 *    rest (soles at y = 0, forward +X, right +Z, metres), so Blender sees the whole man in place;
 *  - the json: per bone its modelling frame (the parts the game adds to a bone are modelled in that
 *    frame: Rig.frames) with the frame's body-space rest matrix, the bone's rest matrix, posed
 *    bone matrices for the studio renders (aim, walk), the muzzle / grip / fore-grip points and the
 *    procedural triangle counts per LOD and material (the budgets the Blender low poly must beat).
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

async function write(doc: Document, name: string, meta: unknown) {
  mkdirSync(OUT, { recursive: true });
  await new NodeIO().write(join(OUT, name + '-proc.glb'), doc);
  writeFileSync(join(OUT, name + '-proc.json'), JSON.stringify(meta, null, 1));
}

/** Export one infantry model key + nation (procedural build: any loaded skin is ignored). */
async function exportInfantry(asset: string, key: string, style: typeof ISRAEL) {
  const { infantryTemplate, INFANTRY } = await import('../../src/render/models/infantry');
  const { lodGeos } = await import('../../src/render/perf/lod');
  const t = infantryTemplate(key, style as never, null);
  if (t.skin) throw new Error('export the procedural model: no skin may be registered');
  t.top.updateMatrixWorld(true);
  const doc = new Document();
  const buf = doc.createBuffer();
  const scene = doc.createScene(asset);
  const bones = t.skel.bones;
  const trisBy: Record<string, number[]> = {};
  // bucket triangles by (bone of their first vertex, material, LOD mask)
  t.top.traverse((o) => {
    const sm = o as THREE.SkinnedMesh;
    if (!sm.isSkinnedMesh) return;
    const mk = sm.name.replace(/^skin_/, '');
    const g = sm.geometry;
    const lods = [g, ...(lodGeos(g) ?? [])];
    const pos = g.attributes.position;
    const nor = g.attributes.normal;
    const si = g.attributes.skinIndex;
    const mask = new Map<string, number>();
    lods.forEach((lg, lv) => {
      const ix = lg.index!;
      for (let i = 0; i < ix.count; i += 3) {
        const k = `${ix.getX(i)},${ix.getX(i + 1)},${ix.getX(i + 2)}`;
        mask.set(k, (mask.get(k) ?? 0) | (1 << lv));
      }
      (trisBy[mk] ??= [0, 0, 0])[lv] += ix.count / 3;
    });
    const buckets = new Map<string, number[]>();
    for (const [k, m] of mask) {
      const [a, b, c] = k.split(',').map(Number);
      const key2 = `${bones[si.getX(a)].name}|${mk}|${m}`;
      let l = buckets.get(key2);
      if (!l) buckets.set(key2, (l = []));
      l.push(a, b, c);
    }
    for (const [name, ids] of buckets) {
      const p = new Float32Array(ids.length * 3);
      const n = new Float32Array(ids.length * 3);
      ids.forEach((v, i) => {
        p.set([pos.getX(v), pos.getY(v), pos.getZ(v)], i * 3);
        n.set([nor.getX(v), nor.getY(v), nor.getZ(v)], i * 3);
      });
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(p).setBuffer(buf))
        .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(n).setBuffer(buf));
      scene.addChild(doc.createNode(name).setMesh(doc.createMesh(name).addPrimitive(prim)));
    }
  });
  // bones: rest matrices (body space) and the modelling frame of each
  const byName = new Map(bones.map((b) => [b.name, b]));
  const rest: Record<string, { parent: string | null; frame: string; rest: number[]; frameRest: number[] }> = {};
  for (const b of bones) {
    const f = t.frames[b.name] ?? b.name;
    rest[b.name] = { parent: (b.parent as THREE.Bone)?.isBone ? b.parent!.name : null, frame: f, rest: b.matrixWorld.toArray(), frameRest: byName.get(f)!.matrixWorld.toArray() };
  }
  const point = (n: string) => {
    const o = t.top.getObjectByName(n);
    return o ? new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).toArray() : null;
  };
  // posed bone matrices (body space, relative to rest: posed * rest^-1) for the studio renders
  const m = INFANTRY[key](style as never, null);
  const top = m.root.children[0];
  const base = { dt: 1 / 30, time: 1, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true, seed: 7, lod: 0 };
  const poses: Record<string, Record<string, number[]>> = {};
  const pose = (name: string, st: Record<string, number | boolean>, n: number) => {
    const a = { ...base, ...st };
    for (let i = 0; i < n; i++) {
      a.time += 1 / 30;
      if (typeof st.dist === 'number') a.dist = (st.dist as number) + i * (1 / 30) * (st.speed as number);
      m.anim!(a as never);
    }
    top.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(top.matrixWorld).invert();
    const out: Record<string, number[]> = {};
    for (const b of bones) {
      const pb = top.getObjectByName(b.name)!;
      const bodyPosed = new THREE.Matrix4().multiplyMatrices(inv, pb.matrixWorld);
      out[b.name] = bodyPosed.multiply(new THREE.Matrix4().copy(b.matrixWorld).invert()).toArray();
    }
    poses[name] = out;
  };
  pose('aim', { fired: 0.6 }, 60);
  pose('walk', { moving: true, speed: 0.35, dist: 0.2 }, 23);
  pose('idle', {}, 30);
  const meta = {
    key,
    faction: style.faction,
    bones: rest,
    points: { muzzle: point('amuzzle0') },
    /** Weapon hand points (weapon-bone local): right grip, left fore-grip, butt / shoulder pivot. */
    weapon: t.sols[0]?.w ?? null,
    lodTris: t.lodTris,
    trisByMaterial: trisBy,
    drawCalls: Object.keys(trisBy).length,
    poses,
  };
  await write(doc, asset, meta);
  console.log(`[export] ${asset}: LOD tris ${t.lodTris.join(' / ')}, draw calls ${meta.drawCalls}`, JSON.stringify(trisBy));
}

it('export the IDF rifleman (rifle | israel)', async () => {
  await exportInfantry('idf-rifleman', 'rifle', ISRAEL);
});
