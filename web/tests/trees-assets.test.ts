import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CulledInstances, type Inst } from '../src/render/geo';
import { kindTint, treeKind } from '../src/render/treeassets';
import { TREE_LOD, lodBand, lodSplit } from '../src/render/treeimpostor';
import { Species } from '../src/render/treekinds';

// the baked files (tools/blender/trees.py -> tools/bake-trees.mjs) as Vite sees them
const files = Object.keys(import.meta.glob('../public/tex/trees/*.{webp,glb,json}', { query: '?url', eager: true })).map((k) => k.replace('../public/', ''));
const man = Object.values(import.meta.glob('../public/tex/trees/trees.json', { eager: true, import: 'default' }))[0] as {
  framePx: number[];
  cellPx: number[];
  kinds: Record<string, { H: number; Rf: number; heroTris: number; fullTris: number }>;
};
const BIOMES = ['temperate', 'desert', 'winter', 'urban'] as const;
const SPECIES = [Species.Spruce, Species.Pine, Species.Oak, Species.Birch, Species.Young, Species.Poplar, Species.Willow, Species.Fruit, Species.Palm, Species.Acacia];
const SHRUBS = ['bush', 'bush_bare', 'hedge', 'scrub'];

describe('Blender tree assets', () => {
  it('every species of every climate (and every shrub) has a hero mesh entry and both impostor sizes', () => {
    const kinds = new Set<string>(SHRUBS);
    for (const b of BIOMES) for (const sp of SPECIES) kinds.add(treeKind(sp, b));
    expect(kinds.has('spruce_snow') && kinds.has('birch_bare') && kinds.has('palm') && kinds.has('willow')).toBe(true);
    for (const k of kinds) {
      expect(man.kinds[k], k).toBeTruthy();
      expect(man.kinds[k].Rf, k).toBeGreaterThan(0.1);
      for (const px of man.framePx) for (const ch of ['a', 'n']) expect(files, `${k} ${px} ${ch}`).toContain(`tex/trees/imp_${k}_${px}_${ch}.webp`);
    }
    for (const px of man.cellPx) for (const ch of ['a', 'n']) expect(files).toContain(`tex/trees/cards_${ch}_${px}.webp`);
    expect(files).toContain('tex/trees/trees.glb');
  });

  it('hero meshes fit the phone budget', () => {
    for (const [k, m] of Object.entries(man.kinds)) {
      expect(m.heroTris, k).toBeGreaterThan(20);
      expect(m.heroTris, k).toBeLessThanOrEqual(1000);
    }
  });

  it('tints vary around the baked colours, the season shows', () => {
    const c = new THREE.Color();
    for (const b of BIOMES)
      for (const k of ['oak', 'birch', 'spruce', 'palm', 'bush'])
        for (let i = 0; i < 20; i++) {
          kindTint(k, b, (i * 0.37) % 1, (i * 0.61) % 1, 0.5, c);
          for (const v of [c.r, c.g, c.b]) {
            expect(v).toBeGreaterThan(0.32);
            expect(v).toBeLessThan(0.66);
          }
        }
    // an autumn oak in the valley is warmer than a summer one
    const au = kindTint('oak', 'temperate', 0.2, 0.5, 0.01);
    const su = kindTint('oak', 'temperate', 0.2, 0.5, 0.5);
    expect(au.r / au.b).toBeGreaterThan((su.r / su.b) * 2);
  });
});

describe('tree LOD split', () => {
  const band = lodBand(96, 0.58);
  it('near cells draw the full model, far cells the impostor, the band both', () => {
    // perspective, zoomed in: K = 3000 px per unit at distance 1 (the band ~84 .. 108 px per unit: ~28 .. 36 units)
    TREE_LOD.value.set(0, 10, 0, 3000);
    expect(lodSplit(2, 2, 4, band)).toBe(1);
    expect(lodSplit(80, 80, 4, band)).toBe(2);
    expect(lodSplit(30, 0, 4, band)).toBe(3);
    // orthographic: one scale for the whole view
    TREE_LOD.value.set(0, 10, 0, -200);
    expect(lodSplit(80, 80, 4, band)).toBe(1);
    TREE_LOD.value.set(0, 10, 0, -40);
    expect(lodSplit(0, 0, 4, band)).toBe(2);
  });

  it('CulledInstances feeds both meshes; toppled trees stay on the full model', () => {
    const list: Inst[] = [];
    for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) list.push({ x: x + 0.5, y: 0, z: z + 0.5, rotY: 0, sx: 1, sy: 1, sz: 1, color: new THREE.Color(0.5, 0.5, 0.5) });
    const ci = new CulledInstances(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial(), list, 16, 16, 4);
    const far = new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), ci.size);
    far.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(ci.size * 3), 3);
    // left half (x < 8) near, right half far
    ci.attachFar(far, (x) => (x < 8 ? 1 : 2));
    const poly = [-1, -1, 17, -1, 17, 17, -1, 17];
    ci.cull(poly, 0);
    expect(ci.mesh.count).toBe(128);
    expect(far.count).toBe(128);
    // topple a tree on the far side: the full model draws it too
    let j = 0;
    while (ci.posX(j) < 8) j++;
    const m = new THREE.Matrix4().makeRotationZ(1.4).setPosition(ci.posX(j), 0, ci.posZ(j));
    ci.setMatrix(j, m);
    ci.cull(poly, 0);
    expect(ci.mesh.count).toBe(129);
    expect(far.count).toBe(128);
    const arr = ci.mesh.instanceMatrix.array as Float32Array;
    const last = new THREE.Matrix4().fromArray(arr, 128 * 16);
    expect(last.elements[12]).toBeCloseTo(ci.posX(j));
  });
});
