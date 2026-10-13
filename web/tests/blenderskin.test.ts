import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { INFANTRY, infantryTemplate } from '../src/render/models/infantry';
import { loadSkins, registerSkin, skinParts, SKINS, type Skin } from '../src/render/models/blenderskin';
import { forceHero, HeroLod, heroOf, INF_HERO_PX, lodGeos, prepareLod, setGeoLod } from '../src/render/perf/lod';
import type { AnimState } from '../src/render/models/types';

// minimal canvas stand-in for the procedural texture generators (node has no DOM)
if (typeof (globalThis as { document?: unknown }).document === 'undefined') {
  const ctx = new Proxy(
    {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    } as Record<string, unknown>,
    { get: (t, k: string) => (k in t ? t[k] : () => undefined) },
  );
  (globalThis as { document?: unknown }).document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx, style: {} }) };
}

const style = (faction: string, team: number) => ({ team, hull: 0x777755, accent: 0x333333, flag: 0, faction, region: 'west' }) as never;
const DEF = SKINS.find((s) => s.model === 'rifle' && s.faction === 'israel')!;
// the shipped files (base64 data URLs: 3 bytes per 4 characters)
const FILES: Record<string, string> = {};
for (const [k, v] of Object.entries(import.meta.glob('../public/models/blender/*.webp', { query: '?inline', eager: true, import: 'default' }))) FILES[k.replace('../public/models/blender/', '')] = v as string;
const bytes = (f: string) => ((FILES[f].length - FILES[f].indexOf(',') - 1) * 3) / 4;
/** The GLB (vite has no inline loader for it): read through node's fs (no node typings in this project). */
async function readGlb(id: string): Promise<ArrayBuffer | null> {
  const mod = 'node:fs';
  const fs = (await import(/* @vite-ignore */ mod)) as { existsSync(p: URL): boolean; readFileSync(p: URL): Uint8Array };
  const url = new URL(`../public/models/blender/${id}.glb`, import.meta.url);
  if (!fs.existsSync(url)) return null;
  const b = fs.readFileSync(url);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}
const base = (): AnimState => ({ dt: 0.033, time: 1, moving: false, speed: 0, dist: 0, turn: 0, fired: Infinity, dead: 0, damage: 0, built: 1, powered: true, seed: 3, lod: 0 });

/** A stand-in skin: an indexed, uv-mapped box per bone (frame-local), LOD1 / LOD2 smaller. */
function fakeSkin(bones: string[], hero = false): Skin {
  const g = (b: THREE.BufferGeometry) => b.translate(0, -0.1, 0);
  const lods = () => [g(new THREE.SphereGeometry(0.05, 8, 6)), g(new THREE.SphereGeometry(0.05, 6, 4)), g(new THREE.BoxGeometry(0.08, 0.08, 0.08))];
  const tier = hero ? { parts: new Map(bones.map((b) => [b, g(new THREE.SphereGeometry(0.05, 24, 16))])), albedo: new THREE.Texture(), normal: new THREE.Texture(), orm: new THREE.Texture() } : null;
  return { def: DEF, parts: new Map(bones.map((b) => [b, lods()])), albedo: new THREE.Texture(), normal: new THREE.Texture(), orm: new THREE.Texture(), hero: tier };
}
const meshes = (root: THREE.Object3D) => {
  const out: THREE.SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as THREE.SkinnedMesh).isSkinnedMesh) out.push(o as THREE.SkinnedMesh);
  });
  return out;
};
const names = (root: THREE.Object3D) => {
  const out: string[] = [];
  root.traverse((o) => o.name && !o.name.startsWith('skin_') && out.push(o.name));
  return out.sort();
};
function poseAll(m: ReturnType<(typeof INFANTRY)['rifle']>) {
  for (const st of [{ moving: true, speed: 1.3, dist: 0.5 }, { fired: 0.05 }, { dead: 1.5 }] as Partial<AnimState>[]) {
    const a = { ...base(), ...st };
    for (let i = 0; i < 6; i++) {
      a.time += 0.033;
      m.anim!(a);
    }
    m.root.updateMatrixWorld(true);
    m.root.traverse((o) => {
      for (const v of o.matrixWorld.elements) expect(Number.isFinite(v)).toBe(true);
    });
  }
}

describe('Blender skin: IDF rifleman (models/blenderskin.ts + infantry.ts)', () => {
  afterEach(() => registerSkin(null, DEF));

  it('swaps the part geometry per bone and keeps every rig hook', () => {
    const plain = INFANTRY.rifle(style('israel', 0x101010), null);
    const plainTpl = infantryTemplate('rifle', style('israel', 0x101010));
    expect(plainTpl.skin).toBeNull();
    const all = plainTpl.skel.bones.map((b) => b.name).filter((n) => !['aspine', 'aclR', 'aclL'].includes(n));
    registerSkin(fakeSkin(all));
    const tpl = infantryTemplate('rifle', style('israel', 0x2a6cff));
    expect(tpl.skin?.id).toBe(DEF.id);
    expect(tpl.skin?.bones.sort()).toEqual(all.sort());
    const m = INFANTRY.rifle(style('israel', 0x2a6cff), null);
    // the same skeleton, bone names, muzzle / anchors, size and height as the procedural soldier
    expect(names(m.root)).toEqual(names(plain.root));
    expect(m.muzzles.length).toBe(plain.muzzles.length);
    expect(m.muzzles[0].name).toBe(plain.muzzles[0].name);
    expect(m.height).toBe(plain.height);
    expect(m.size).toEqual(plain.size);
    // one skinned mesh (one draw call) with the baked atlas uv, rigid weight 1 per bone (the chest soft-blended into the spine as before)
    const sk = meshes(m.root);
    expect(sk.map((s) => s.name)).toEqual(['skin_bl']);
    const g = sk[0].geometry;
    expect(g.getAttribute('uv')).toBeTruthy();
    const si = g.getAttribute('skinIndex');
    const sw = g.getAttribute('skinWeight');
    const bones = tpl.skel.bones.map((b) => b.name);
    const chest = bones.indexOf('achest');
    for (let i = 0; i < si.count; i++) {
      if (si.getX(i) !== chest) expect(sw.getX(i)).toBe(1);
      expect(sw.getX(i) + sw.getY(i)).toBeCloseTo(1, 5);
    }
    // LOD1 / LOD2 index subsets over the same vertices, fewer triangles each step
    const l = lodGeos(g)!;
    expect(l).not.toBeNull();
    expect(l[0].attributes.position).toBe(g.attributes.position);
    expect(l[0].index!.count).toBeLessThan(g.index!.count);
    expect(l[1].index!.count).toBeLessThan(l[0].index!.count);
    // the skin material keeps the infantry look patches and the player colour, per team
    const mat = sk[0].material as THREE.MeshStandardMaterial;
    expect(mat.map).toBeTruthy();
    expect(mat.vertexColors).toBe(true);
    expect(mat.customProgramCacheKey()).toMatch(/skinTeam\|look.*\|inf/);
    const other = meshes(INFANTRY.rifle(style('israel', 0x22aa22), null).root)[0].material as THREE.Material;
    expect(other).not.toBe(mat);
    expect(other.customProgramCacheKey()).toBe(mat.customProgramCacheKey());
    poseAll(m);
  });

  it('only the Israeli rifleman wears it; other nations and roles stay procedural', () => {
    registerSkin(fakeSkin(['ahead', 'awpn']));
    for (const [key, f] of [
      ['rifle', 'usa'],
      ['at', 'israel'],
      ['medic', 'israel'],
      ['engineer', 'israel'],
    ] as const) {
      const tpl = infantryTemplate(key, style(f, 0x3344aa));
      expect(tpl.skin).toBeNull();
      expect(meshes(INFANTRY[key](style(f, 0x3344aa), null).root).some((s) => s.name === 'skin_bl')).toBe(false);
    }
    // a partial skin keeps the procedural parts of the bones it does not cover
    const m = INFANTRY.rifle(style('israel', 0x3344ab), null);
    const ns = meshes(m.root).map((s) => s.name);
    expect(ns).toContain('skin_bl');
    expect(ns).toContain('skin_camo');
  });

  it('falls back to the procedural soldier without the asset or the ?blender=1 opt-in', async () => {
    // node: no fetch of images -> nothing loads, nothing throws
    expect(await loadSkins('/')).toBe(0);
    const tpl = infantryTemplate('rifle', style('israel', 0x5566cc));
    expect(tpl.skin).toBeNull();
    const m = INFANTRY.rifle(style('israel', 0x5566cc), null);
    expect(meshes(m.root).length).toBeGreaterThan(4);
    poseAll(m);
  });

  it('hero tier: a close-up geometry + material swap on the skin mesh, shared across teams, same program', () => {
    const plainTpl = infantryTemplate('rifle', style('israel', 0x101013));
    const all = plainTpl.skel.bones.map((b) => b.name).filter((n) => !['aspine', 'aclR', 'aclL'].includes(n));
    registerSkin(fakeSkin(all, true));
    const tpl = infantryTemplate('rifle', style('israel', 0x2a6c01));
    expect(tpl.skin!.heroTris).toBeGreaterThan(tpl.lodTris[0]);
    const a = INFANTRY.rifle(style('israel', 0x2a6c01), null);
    const b = INFANTRY.rifle(style('israel', 0x22aa02), null);
    // still one skinned mesh per soldier: the hero tier is not drawn on its own
    expect(meshes(a.root).map((s) => s.name)).toEqual(['skin_bl']);
    const ma = meshes(a.root)[0];
    const mb = meshes(b.root)[0];
    const ha = heroOf(ma.geometry)!;
    const hb = heroOf(mb.geometry)!;
    expect(ha).toBeTruthy();
    // one hero geometry for every team (team colour is a uniform), a hero material per team with the same program
    expect(ha.g).toBe(hb.g);
    const hm = ha.mats.get(ma.material as THREE.Material) as THREE.MeshStandardMaterial;
    expect(hm).toBeTruthy();
    expect(hm).not.toBe(ma.material);
    expect(hm.customProgramCacheKey()).toBe((ma.material as THREE.Material).customProgramCacheKey());
    expect(hm.map).not.toBe((ma.material as THREE.MeshStandardMaterial).map);
    // same skeleton binding: skin indices within the bones, rigid weights
    const si = ha.g.getAttribute('skinIndex');
    for (let i = 0; i < si.count; i++) expect(si.getX(i)).toBeLessThan(tpl.skel.bones.length);
    // the portrait / warm-up switch
    const c = INFANTRY.rifle(style('israel', 0x2a6c01), null);
    expect(forceHero(c.root)).toBe(true);
    expect(meshes(c.root)[0].geometry).toBe(ha.g);
    expect(meshes(c.root)[0].material).toBe(hm);
    poseAll(c);
    // no hero tier: nothing to force
    registerSkin(fakeSkin(all, false));
    expect(forceHero(INFANTRY.rifle(style('israel', 0x2a6c03), null).root)).toBe(false);
  });

  it('hero tier: hard cap on how many soldiers show it, largest first, hysteresis, LOD kept underneath', () => {
    const plainTpl = infantryTemplate('rifle', style('israel', 0x101014));
    const all = plainTpl.skel.bones.map((b) => b.name).filter((n) => !['aspine', 'aclR', 'aclL'].includes(n));
    registerSkin(fakeSkin(all, true));
    const infos = Array.from({ length: 10 }, () => prepareLod(INFANTRY.rifle(style('israel', 0x2a6c04), null).root, 'infantry', true, 0x2a6c04));
    expect(infos.every((i) => i.heroable)).toBe(true);
    // a procedural soldier has no hero tier
    expect(prepareLod(INFANTRY.rifle(style('usa', 0x2a6c04), null).root, 'infantry', true, 0x2a6c04).heroable).toBe(false);
    const pool = new HeroLod(6);
    const frame = (px: (i: number) => number) => {
      infos.forEach((info, i) => pool.offer(info, px(i)));
      pool.end();
    };
    frame((i) => INF_HERO_PX * (1.2 + i * 0.1));
    expect(pool.count).toBe(6);
    // the six largest
    expect(infos.map((i) => i.hero)).toEqual([false, false, false, false, true, true, true, true, true, true]);
    const g0 = infos[9].swaps[0].m.geometry;
    expect(g0).toBe(infos[9].swaps[0].hero!.g);
    // a slightly bigger newcomer does not evict a soldier already shown (hysteresis), a much bigger one does
    frame((i) => (i === 0 ? INF_HERO_PX * 1.75 : INF_HERO_PX * (1.2 + i * 0.1)));
    expect(infos[0].hero).toBe(false);
    frame((i) => (i === 0 ? INF_HERO_PX * 2.5 : INF_HERO_PX * (1.2 + i * 0.1)));
    expect(infos[0].hero).toBe(true);
    expect(pool.count).toBe(6);
    // the LOD changes underneath are remembered and applied when the hero tier goes
    setGeoLod(infos[0], 2);
    expect(infos[0].swaps[0].m.geometry).toBe(infos[0].swaps[0].hero!.g);
    // zoomed out / off screen (not offered): everybody back to the play tier
    frame(() => INF_HERO_PX * 0.5);
    expect(pool.count).toBe(0);
    expect(infos[0].swaps[0].m.geometry).toBe(infos[0].swaps[0].g[2]);
    expect(infos[0].swaps[0].m.material).toBe(infos[0].swaps[0].mat);
    for (const info of infos.slice(1)) expect(info.swaps[0].m.geometry).toBe(info.swaps[0].g[0]);
    // low quality: off
    pool.cap = 0;
    frame(() => INF_HERO_PX * 4);
    expect(pool.count).toBe(0);
  });

  it('the shipped asset: a part per covered bone, under the triangle and download budgets', async () => {
    const glb = await readGlb(DEF.id);
    expect(glb).not.toBeNull();
    const sfx = ['-albedo', '-normal', '-orm'];
    for (const s of sfx) for (const v of ['.webp', '-256.webp']) expect(FILES[DEF.id + s + v]).toBeTruthy();
    const hglb = await readGlb(DEF.id + '-hero');
    expect(hglb).not.toBeNull();
    for (const s of sfx) for (const v of ['.webp', '-512.webp']) expect(FILES[DEF.id + '-hero' + s + v]).toBeTruthy();
    // every tier one client downloads: play (512 / phone 256 px maps) + hero (1024 / phone 512 px maps)
    const desk = glb!.byteLength + hglb!.byteLength + sfx.reduce((a, s) => a + bytes(DEF.id + s + '.webp') + bytes(DEF.id + '-hero' + s + '.webp'), 0);
    const phone = glb!.byteLength + hglb!.byteLength + sfx.reduce((a, s) => a + bytes(DEF.id + s + '-256.webp') + bytes(DEF.id + '-hero' + s + '-512.webp'), 0);
    expect(desk).toBeLessThan(600 * 1024);
    expect(phone).toBeLessThan(desk);
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const { MeshoptDecoder } = await import('three/addons/libs/meshopt_decoder.module.js');
    await MeshoptDecoder.ready;
    const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(glb!, '');
    const parts = skinParts(gltf.scene);
    const plain = infantryTemplate('rifle', style('israel', 0x101011));
    const bones = new Set(plain.skel.bones.map((b) => b.name));
    for (const [name, lods] of parts) {
      expect(bones.has(name)).toBe(true);
      expect(lods.length).toBe(3);
      for (const g of lods) expect(g.getAttribute('uv')).toBeTruthy();
    }
    const hg = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parseAsync(hglb!, '');
    const hparts = new Map([...skinParts(hg.scene)].map(([k, v]) => [k, v[0]]));
    expect([...hparts.keys()].sort()).toEqual([...parts.keys()].sort());
    for (const g of hparts.values()) expect(g.getAttribute('uv')).toBeTruthy();
    const T = () => new THREE.Texture();
    registerSkin({ def: DEF, parts, albedo: T(), normal: T(), orm: T(), hero: { parts: hparts, albedo: T(), normal: T(), orm: T() } });
    const tpl = infantryTemplate('rifle', style('israel', 0x101012));
    expect(tpl.skin?.bones.length).toBe(parts.size);
    // budgets: play LOD0 no more than the procedural soldier's LOD0, LOD1 / LOD2 no more than its LOD1 / LOD2;
    // the hero tier 12-20k triangles
    expect(tpl.lodTris[0]).toBeLessThanOrEqual(plain.lodTris[0]);
    expect(tpl.skin!.heroTris).toBeGreaterThan(12000);
    expect(tpl.skin!.heroTris).toBeLessThan(20000);
    expect(tpl.lodTris[1]).toBeLessThanOrEqual(plain.lodTris[1]);
    expect(tpl.lodTris[2]).toBeLessThanOrEqual(plain.lodTris[2]);
    expect(tpl.lodTris[2]).toBeLessThan(tpl.lodTris[1]);
    // in place: the parts' bind-pose bounds match the procedural soldier's (same man, same rig)
    const box = (t: typeof tpl) => {
      const b = new THREE.Box3();
      for (const s of meshes(t.top)) b.union(new THREE.Box3().setFromBufferAttribute(s.geometry.getAttribute('position') as THREE.BufferAttribute));
      return b;
    };
    const a = box(plain);
    const b = box(tpl);
    for (const k of ['x', 'y', 'z'] as const) {
      expect(Math.abs(a.min[k] - b.min[k])).toBeLessThan(0.08);
      expect(Math.abs(a.max[k] - b.max[k])).toBeLessThan(0.08);
    }
  });
});
