import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import { phoneCaps } from './devicecaps';
import type { FogOfWar } from './fog';
import type { CulledInstances, SceneryLod } from './geo';
import { assetBase, fetchBitmap } from './photoground';
import { Species } from './treekinds';
import { updateWind } from './trees';
import {
  type FrameLayout,
  type KindMeta,
  type TreeMatPair,
  heroMaterial,
  impostorMaterial,
  impostorQuad,
  lodBand,
  lodSplit,
  noteTreeRenderer,
  trackLod,
  updateTreeLod,
} from './treeimpostor';

/*
 * The Blender-built trees and shrubs (tools/blender/trees.py -> tools/bake-trees.mjs ->
 * public/tex/trees/): per species a hero mesh (close range) and a multi-angle impostor
 * atlas (mid / far range), plus the shared leaf-card atlas.
 *
 * Medium / high quality build the battlefield with the procedural trees first (trees.ts:
 * they show at once), then swap them in place once the assets have streamed in: same
 * instances, culling, envdamage (toppling, charring, fires) and minimap; the hero model
 * and the material change, a second instanced mesh draws the impostors and the instance
 * colours become relative tints (per-tree variation and the climate's season) over the
 * baked leaf colours. ?trees=0 keeps the procedural trees (before / after comparisons);
 * low quality keeps them too.
 */

interface Manifest {
  frames: FrameLayout;
  cells: { grid: [number, number]; names: string[] };
  framePx: number[];
  cellPx: number[];
  kinds: Record<string, KindMeta & { heroTris: number }>;
}

export interface TreeAssets {
  man: Manifest;
  hero: Map<string, THREE.BufferGeometry>;
  cardA: THREE.Texture;
  cardN: THREE.Texture;
  cellPx: number;
  framePx: number;
  imp: Map<string, { a: THREE.Texture; n: THREE.Texture }>;
}

export function treeAssetsWanted(quality: 'low' | 'medium' | 'high'): boolean {
  if (quality === 'low') return false;
  if (typeof location !== 'undefined' && /[?&]trees=0\b/.test(location.search)) return false;
  return typeof createImageBitmap !== 'undefined' && typeof fetch !== 'undefined';
}

let manLoad: Promise<Manifest | null> | null = null;
let heroLoad: Promise<Map<string, THREE.BufferGeometry> | null> | null = null;
const texLoads = new Map<string, Promise<THREE.Texture>>();

function dir() {
  return `${assetBase()}tex/trees/`;
}

function tex(file: string, srgb: boolean, aniso = 1): Promise<THREE.Texture> {
  let p = texLoads.get(file);
  if (!p) {
    p = fetchBitmap(dir() + file).then((bmp) => {
      const t = new THREE.Texture(bmp);
      t.flipY = false;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = aniso;
      t.minFilter = THREE.LinearMipmapLinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    });
    texLoads.set(file, p);
  }
  return p;
}

/** A glTF primitive as plain float attributes in world units (node transform baked; quantised data decoded). */
function bakeHero(mesh: THREE.Mesh): THREE.BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const src = mesh.geometry;
  const M = mesh.matrixWorld;
  const NM = new THREE.Matrix3().getNormalMatrix(M);
  const n = src.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const col = new Float32Array(n * 4);
  const flex = new Float32Array(n);
  const leaf = new Float32Array(n);
  const v = new THREE.Vector3();
  const P = src.attributes.position;
  const N = src.attributes.normal;
  const U = src.attributes.uv;
  const C = src.attributes.color;
  const F = src.attributes._flex;
  const L = src.attributes._leaf;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(M);
    pos.set([v.x, v.y, v.z], i * 3);
    if (N) {
      v.fromBufferAttribute(N, i).applyMatrix3(NM).normalize();
      nrm.set([v.x, v.y, v.z], i * 3);
    }
    if (U) uv.set([U.getX(i), U.getY(i)], i * 2);
    if (C) col.set([C.getX(i), C.getY(i), C.getZ(i), C.itemSize > 3 ? C.getW(i) : 1], i * 4);
    else col.set([1, 1, 1, 1], i * 4);
    flex[i] = F ? F.getX(i) : 0;
    leaf[i] = L ? L.getX(i) : 0;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('color', new THREE.BufferAttribute(col, 4));
  g.setAttribute('flex', new THREE.BufferAttribute(flex, 1));
  g.setAttribute('leaf', new THREE.BufferAttribute(leaf, 1));
  if (src.index) g.setIndex(new THREE.BufferAttribute(n > 65535 ? Uint32Array.from(src.index.array as ArrayLike<number>) : Uint16Array.from(src.index.array as ArrayLike<number>), 1));
  g.computeBoundingSphere();
  return g;
}

/** Load the manifest, hero meshes, card atlas and the impostors of `kinds`. */
export function loadTreeAssets(kinds: string[], quality: 'medium' | 'high'): Promise<TreeAssets | null> {
  const small = phoneCaps();
  manLoad ??= fetch(dir() + 'trees.json')
    .then((r) => (r.ok ? (r.json() as Promise<Manifest>) : null))
    .catch(() => null);
  heroLoad ??= (async () => {
    try {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const gltf = await loader.loadAsync(dir() + 'trees.glb');
      gltf.scene.updateMatrixWorld(true);
      const out = new Map<string, THREE.BufferGeometry>();
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const name = mesh.name.replace(/^hero_/, '');
        out.set(name, bakeHero(mesh));
      });
      return out;
    } catch (e) {
      console.warn('[trees] hero meshes unavailable', e);
      return null;
    }
  })();
  return (async () => {
    try {
      const man = await manLoad;
      const hero = await heroLoad;
      if (!man || !hero) return null;
      const cellPx = small ? man.cellPx[man.cellPx.length - 1] : man.cellPx[0];
      const framePx = small ? man.framePx[man.framePx.length - 1] : man.framePx[0];
      const want = kinds.filter((k) => man.kinds[k] && hero.has(k));
      const [cardA, cardN, ...imps] = await Promise.all([
        tex(`cards_a_${cellPx}.webp`, true, quality === 'high' ? 4 : 2),
        tex(`cards_n_${cellPx}.webp`, false, quality === 'high' ? 4 : 2),
        ...want.flatMap((k) => [tex(`imp_${k}_${framePx}_a.webp`, true), tex(`imp_${k}_${framePx}_n.webp`, false)]),
      ]);
      const imp = new Map<string, { a: THREE.Texture; n: THREE.Texture }>();
      want.forEach((k, i) => imp.set(k, { a: imps[i * 2], n: imps[i * 2 + 1] }));
      return { man, hero, cardA, cardN, cellPx, framePx, imp };
    } catch (e) {
      console.warn('[trees] assets unavailable, keeping the procedural trees', e);
      return null;
    }
  })();
}

// ------------------------------------------------------------------ kinds and tints

/** The asset kind of a battlefield tree species in a climate. */
export function treeKind(sp: Species, biome: GameMap['biome']): string {
  const winter = biome === 'winter';
  switch (sp) {
    case Species.Spruce:
      return winter ? 'spruce_snow' : 'spruce';
    case Species.Pine:
      return winter ? 'pine_snow' : 'pine';
    case Species.Birch:
      return winter ? 'birch_bare' : 'birch';
    case Species.Oak:
      return 'oak';
    case Species.Young:
      return 'young';
    case Species.Poplar:
      return 'poplar';
    case Species.Willow:
      return 'willow';
    case Species.Fruit:
      return 'fruit';
    case Species.Palm:
      return 'palm';
    case Species.Acacia:
      return 'acacia';
  }
  return 'oak';
}

/**
 * Relative tint (half strength, like trees.ts treeTint) over the baked leaf colours: each tree a
 * little lighter / darker, warmer / cooler, and the climate's season: summer greens with the odd
 * turning oak or yellowing birch in the valley, dusty sun-bleached crowns in the desert, cold
 * dark conifers under the snow, fresh watered park trees in the city.
 */
export function kindTint(kind: string, biome: GameMap['biome'], r1: number, r2: number, r3: number, out = new THREE.Color()): THREE.Color {
  const b = 0.88 + r2 * 0.24;
  const h = (r1 - 0.5) * 0.18;
  let r = b * (1 + h);
  let g = b * (1 + h * 0.15);
  let bl = b * (1 - h * 1.1);
  const mul = (x: number, y: number, z: number) => {
    r *= x;
    g *= y;
    bl *= z;
  };
  if (biome === 'desert') {
    mul(1.06, 1.0, 0.84);
    if (kind === 'palm' && r3 < 0.25) mul(1.08, 1.04, 0.82);
  } else if (biome === 'winter') {
    if (kind.startsWith('spruce') || kind.startsWith('pine')) mul(0.92, 0.97, 1.02);
    else mul(1.0, 0.98, 0.96);
  } else {
    if (biome === 'urban') mul(0.97, 1.04, 0.95);
    if ((kind === 'oak' || kind === 'young' || kind === 'fruit') && r3 < 0.045) mul(r1 < 0.5 ? 1.75 : 1.45, r1 < 0.5 ? 0.92 : 1.05, 0.4);
    else if (kind === 'birch' && r3 < 0.07) mul(1.45, 1.2, 0.5);
    else if (kind === 'oak' && r3 < 0.1) mul(1.08, 1.02, 0.86);
  }
  return out.setRGB(r * 0.5, g * 0.5, bl * 0.5);
}

// ------------------------------------------------------------------ the swap

export interface PlantSet {
  ci: CulledInstances;
  kind: string;
  /** Hash scale of the instance randoms (trees 7, shrubs 13: see trees.ts / vegetation.ts). */
  hashK: number;
}

/** Swap the procedural plants for the Blender assets once they have loaded (no-op when unwanted). */
export function upgradePlants(m: GameMap, sets: PlantSet[], fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod: SceneryLod) {
  if (!treeAssetsWanted(quality) || !sets.length) return;
  const kinds = [...new Set(sets.map((s) => s.kind))];
  void loadTreeAssets(kinds, quality === 'high' ? 'high' : 'medium').then((A) => {
    if (!A) return;
    const heroMats = new Map<string, TreeMatPair>();
    const impMats = new Map<string, TreeMatPair>();
    const col = new THREE.Color();
    let n = 0;
    for (const s of sets) {
      const meta = A.man.kinds[s.kind];
      const geo = A.hero.get(s.kind);
      const it = A.imp.get(s.kind);
      if (!meta || !geo || !it) continue;
      const band = lodBand(A.man.framePx[0], meta.Rf);
      let hm = heroMats.get(s.kind);
      if (!hm) heroMats.set(s.kind, (hm = heroMaterial(fog, quality, A.cardA, A.cardN, A.cellPx, A.man.cells.grid[0], meta, band)));
      let im = impMats.get(s.kind);
      if (!im) impMats.set(s.kind, (im = impostorMaterial(fog, quality, it.a, it.n, A.framePx, A.man.frames, meta, band)));
      const ci = s.ci;
      const hero = ci.mesh;
      hero.geometry = geo;
      lod.retarget(hero, geo, null);
      hero.material = hm.mat;
      hero.customDepthMaterial = hm.depth;
      const far = new THREE.InstancedMesh(impostorQuad(), im.mat, Math.max(1, ci.size));
      far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      far.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, ci.size) * 3), 3);
      far.instanceColor.setUsage(THREE.DynamicDrawUsage);
      far.count = 0;
      far.frustumCulled = false;
      far.receiveShadow = true;
      far.castShadow = hero.castShadow;
      far.customDepthMaterial = im.depth;
      far.name = hero.name + '-far';
      const prevHero = hero.onBeforeRender;
      const lodHook = (r: THREE.WebGLRenderer, cam: THREE.Camera) => {
        if (cam.userData.waterReflection) return;
        noteTreeRenderer(r);
        updateTreeLod(cam);
      };
      hero.onBeforeRender = (r, sc, cam, g, mt, gr) => {
        prevHero.call(hero, r, sc, cam, g, mt, gr);
        lodHook(r, cam);
      };
      far.onBeforeRender = (r, _sc, cam) => {
        updateWind(fog.uniforms.fogTime.value as number);
        lodHook(r, cam);
        far.castShadow = hero.castShadow;
      };
      (hero.parent ?? hero).add(far);
      // relative tints (the baked leaves carry the colour now)
      for (let j = 0; j < ci.size; j++) {
        const kx = Math.floor(ci.posX(j) * s.hashK);
        const kz = Math.floor(ci.posZ(j) * s.hashK);
        kindTint(s.kind, m.biome, hash2(kx, kz, 3), hash2(kx, kz, 4), hash2(kx, kz, 5), col);
        ci.setColor(j, col.r, col.g, col.b);
      }
      ci.attachFar(far, (x, z, c) => lodSplit(x, z, c, band));
      trackLod(ci);
      n += ci.size;
    }
    console.info(`[trees] Blender trees in place: ${n} plants, ${heroMats.size} kinds`);
  });
}

// ------------------------------------------------------------------ outskirts

export interface OutskirtTrees {
  mesh: THREE.InstancedMesh;
  kind: string;
  /** r1, r2, r3 per instance. */
  rnd: number[];
}

/** The out-of-map woods: impostors only (always far), same assets, the horizon's aerial perspective (`wrap`). */
export function upgradeOutskirtTrees(biome: GameMap['biome'], sets: OutskirtTrees[], fog: FogOfWar, quality: 'low' | 'medium' | 'high', wrap: (m: THREE.MeshStandardMaterial) => THREE.MeshStandardMaterial) {
  if (!treeAssetsWanted(quality) || !sets.length) return;
  const kinds = [...new Set(sets.map((s) => s.kind))];
  void loadTreeAssets(kinds, quality === 'high' ? 'high' : 'medium').then((A) => {
    if (!A) return;
    const mats = new Map<string, { mat: THREE.MeshStandardMaterial; depth: THREE.MeshDepthMaterial }>();
    const col = new THREE.Color();
    for (const s of sets) {
      const meta = A.man.kinds[s.kind];
      const it = A.imp.get(s.kind);
      if (!meta || !it) continue;
      let pair = mats.get(s.kind);
      if (!pair) {
        const p = impostorMaterial(fog, quality, it.a, it.n, A.framePx, A.man.frames, meta, null);
        mats.set(s.kind, (pair = { mat: wrap(p.mat), depth: p.depth }));
      }
      s.mesh.geometry = impostorQuad();
      s.mesh.material = pair.mat;
      s.mesh.customDepthMaterial = pair.depth;
      // (the instance spread is unchanged; widen the bounds for the camera-facing quads)
      s.mesh.computeBoundingSphere();
      if (s.mesh.boundingSphere) s.mesh.boundingSphere.radius += 2;
      for (let i = 0; i < s.mesh.count; i++) {
        kindTint(s.kind, biome, s.rnd[i * 3], s.rnd[i * 3 + 1], s.rnd[i * 3 + 2], col).multiplyScalar(0.92);
        s.mesh.setColorAt(i, col);
      }
      if (s.mesh.instanceColor) s.mesh.instanceColor.needsUpdate = true;
      const prev = s.mesh.onBeforeRender;
      s.mesh.onBeforeRender = (r, sc, cam, g, m, gr) => {
        prev.call(s.mesh, r, sc, cam, g, m, gr);
        updateWind(fog.uniforms.fogTime.value as number);
      };
    }
  });
}
