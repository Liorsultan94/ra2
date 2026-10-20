import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { FogOfWar } from '../src/render/fog';
import { SceneryLod } from '../src/render/geo';
import type { HouseHandle } from '../src/render/scenery';
import type { KitManifest, SinaiKit } from '../src/render/sinaikit';
import { buildSinaiTown, isSinaiKind } from '../src/render/sinaitown';
import { createMap } from '../src/sim/maps';

// the manifest the runtime loads (tools/blender/sinai/sinai_kit.py -> pack.mjs)
import manRaw from '../public/models/sinai/sinai-kit.json?raw';

const man = JSON.parse(manRaw) as KitManifest;
const DIR = new URL('../public/models/sinai/', import.meta.url);
/** File sizes through node's fs (no node typings in this project). */
async function sizer() {
  const mod = 'node:fs';
  const fs = (await import(/* @vite-ignore */ mod)) as { statSync(p: URL): { size: number } };
  return (f: string) => fs.statSync(new URL(f, DIR)).size;
}

/** The kit with stand-in piece geometry (the GLB needs the meshopt decoder and fetch): same names, uvs, normals. */
function fakeKit(): SinaiKit {
  const geo = new Map<string, THREE.BufferGeometry>();
  for (const [n, tris] of Object.entries(man.pieces)) {
    geo.set(n, new THREE.BoxGeometry(0.1, 0.1, 0.1));
    if (tris.length > 1) geo.set(n + '_l1', new THREE.BoxGeometry(0.1, 0.1, 0.1));
  }
  const t = new THREE.Texture();
  return { man, geo, atlas: { albedo: t, normal: t, orm: t }, plaster: { albedo: t, normal: t, orm: t }, bytes: 0 };
}

describe('Sinai building kit (GD2)', () => {
  it('manifest: the cards, swatches and pieces the town and the resort use; piece triangle budgets', () => {
    for (const c of ['win', 'win_shut', 'win_closed', 'win_grille', 'win_arch', 'win_tall', 'win_hotel', 'door_hotel', 'vent', 'door', 'door_arch', 'gate', 'shop', 'arch']) {
      expect(man.cards[c], c).toBeDefined();
      const [u0, v0, u1, v1] = man.cards[c].uv;
      expect(u0).toBeGreaterThanOrEqual(0);
      expect(v1).toBeLessThanOrEqual(1);
      expect(u1).toBeGreaterThan(u0);
      expect(v1).toBeGreaterThan(v0);
    }
    for (const s of ['frame', 'wood', 'wood_lt', 'steel', 'stone', 'glass', 'paint', 'fabric_acc', 'aluminium']) expect(man.swatches[s], s).toBeDefined();
    for (const p of ['ac', 'tank', 'dish', 'solar', 'rail', 'awning', 'dome', 'mdome', 'minaret', 'merlon', 'table', 'kiosk']) expect(man.pieces[p], p).toBeDefined();
    for (const [n, tris] of Object.entries(man.pieces)) {
      expect(tris[0], n).toBeLessThanOrEqual(n === 'minaret' || n === 'mdome' ? 700 : 200);
      if (tris[1] !== undefined) expect(tris[1], n).toBeLessThan(tris[0]);
    }
  });

  it('download stays in the asset family budget (desktop <= 512 KB, phone <= 200 KB)', async () => {
    const size = await sizer();
    const maps = ['atlas-albedo', 'atlas-normal', 'atlas-orm'];
    const plaster = ['plaster-albedo', 'plaster-normal', 'plaster-orm'];
    const glb = size('sinai-kit.glb') + size('sinai-kit.json');
    const desk = glb + maps.reduce((a, m) => a + size(`sinai-${m}.webp`), 0) + plaster.reduce((a, m) => a + size(`sinai-${m}.webp`), 0);
    const phone = glb + maps.reduce((a, m) => a + size(`sinai-${m}-512.webp`), 0) + plaster.reduce((a, m) => a + size(`sinai-${m}-256.webp`), 0);
    expect(desk).toBeLessThanOrEqual(512 * 1024);
    expect(phone).toBeLessThanOrEqual(200 * 1024);
  });

  it('desert town: every house built (handles in the walls and both kit LODs), finite, deterministic', () => {
    const m = createMap('desert', 3);
    const fog = new FogOfWar(m.w, m.h);
    const kit = fakeKit();
    const run = () => {
      const sink = { houses: [] as HouseHandle[] };
      const lod = new SceneryLod();
      const out = buildSinaiTown(m, kit, fog, 'medium', sink, lod);
      return { out, sink, lod };
    };
    const a = run();
    const houses = m.structures.filter((s) => isSinaiKind(s.kind));
    expect(houses.length).toBeGreaterThan(40);
    expect(a.sink.houses.length).toBe(houses.length);
    for (const hh of a.sink.houses) {
      expect(hh.ranges.length, `${hh.st.x},${hh.st.y}`).toBeGreaterThanOrEqual(2);
      for (const r of hh.ranges) expect(r.end).toBeGreaterThan(r.start);
    }
    const names = new Set(a.out.map((o) => o.name));
    expect(names).toEqual(new Set(['sinai-walls', 'sinai-kit', 'sinai-kit-far']));
    let verts = 0;
    for (const o of a.out) {
      const g = (o as THREE.Mesh).geometry;
      const p = g.getAttribute('position').array as Float32Array;
      for (let i = 0; i < p.length; i++) expect(Number.isFinite(p[i])).toBe(true);
      verts += p.length / 3;
      for (const att of ['normal', 'uv', 'color']) expect(g.getAttribute(att), att).toBeDefined();
    }
    // the mosque is there, with its minaret's piece in the play-zoom mesh
    // (one in each crossing's village, Sharm's and Nuweiba's, the north's two villages and the mainlands': SN1)
    expect(m.structures.filter((s) => s.look === 'mosque').length).toBe(8);
    // LOD swap: the far kit shows only zoomed out
    const k0 = a.out.filter((o) => o.name === 'sinai-kit');
    const k1 = a.out.filter((o) => o.name === 'sinai-kit-far');
    a.lod.update(12);
    expect(k0.every((o) => o.visible) && k1.every((o) => !o.visible)).toBe(true);
    a.lod.update(40);
    expect(k0.every((o) => !o.visible) && k1.every((o) => o.visible)).toBe(true);
    const b = run();
    let vb = 0;
    for (const o of b.out) vb += ((o as THREE.Mesh).geometry.getAttribute('position').array as Float32Array).length / 3;
    expect(vb).toBe(verts);
  });
});
