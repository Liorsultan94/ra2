import * as THREE from 'three';
import { Tile, WATER_LEVEL, type GameMap } from '../sim/map';
import { fbm, hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { CulledInstances, GeoBuilder, type Inst, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { OCC_BUILT, OCC_FIELD, OCC_ROAD, OCC_TRACK, occAt, type Layout } from './layout';
import { grassRGB } from './grasstex';
import { Leaf, foliageAtlas, leafCell } from './terraintex';
import { Shrub, buildTrees, shrubGeometry, shrubTint, treeMaterials } from './trees';
import { biomeLook } from './biome';
import { Species, windTime, type TreeSpot } from './treekinds';
import { roadClear } from './ambient/clearance';

/*
 * Trees, bushes, grass and reeds. All plants share one alpha-tested foliage
 * atlas material with wind sway in the vertex shader; each species is one
 * geometry, instanced per map chunk.
 */

// shared with trees.ts (re-exported for the existing importers)
export { Species, windTime, type TreeSpot } from './treekinds';

/** Culling cell size (tiles). */
const CELL = 4;

/** A trunk stands on dry land: clear of the water surface and of water tiles (no trees growing in a lake). */
function dryLand(m: GameMap, x: number, y: number): boolean {
  if (surfaceHeight(m, x, y) < WATER_LEVEL + 0.08) return false;
  for (const [dx, dy] of [[0, 0], [-0.55, 0], [0.55, 0], [0, -0.55], [0, 0.55]]) {
    const tx = Math.floor(x + dx);
    const ty = Math.floor(y + dy);
    if (tx >= 0 && ty >= 0 && tx < m.w && ty < m.h && m.tiles[ty * m.w + tx] === Tile.Water) return false;
  }
  return true;
}

/** Deterministic tree placement for every tree tile of the map. */
export function treeSpots(m: GameMap, quality: 'low' | 'medium' | 'high'): TreeSpot[] {
  const out: TreeSpot[] = [];
  const isTree = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.trees[y * m.w + x] > 0;
  const maxPer = quality === 'low' ? 2 : 3;
  const ctx = { roads: m.roads, structures: m.structures };
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const t = m.trees[y * m.w + x];
      if (!t) continue;
      const n4 = +isTree(x - 1, y) + +isTree(x + 1, y) + +isTree(x, y - 1) + +isTree(x, y + 1);
      let count = n4 >= 3 ? 3 : n4 >= 1 ? 2 : 1 + (hash2(x, y, 41) < 0.4 ? 1 : 0);
      count = Math.min(count, maxPer);
      // stratified positions inside the tile
      const slots = count === 1 ? [[0.5, 0.5]] : count === 2 ? [[0.3, 0.35], [0.7, 0.68]] : [[0.27, 0.3], [0.73, 0.4], [0.45, 0.75]];
      const flip = hash2(x, y, 42) < 0.5;
      for (let k = 0; k < count; k++) {
        const [sx, sy] = slots[k];
        const ox = x + (flip ? 1 - sx : sx) + (hash2(x, y, 50 + k) - 0.5) * 0.28;
        const oy = y + sy + (hash2(x, y, 60 + k) - 0.5) * 0.28;
        const r = hash2(x, y, 80 + k);
        const forest = n4 >= 2;
        const species = treeSpecies(m, x, y, t, n4, r, ctx);
        const s = (forest ? 0.95 : 0.82) + hash2(x, y, 70 + k) * 0.45;
        if (!dryLand(m, ox, oy)) continue;
        out.push({ x: ox, y: oy, s, species, rot: hash2(x, y, 90 + k) * Math.PI * 2 });
      }
    }
  }
  // render-only trees of the hand-designed maps: street trees, roadside palms (sim/maps.ts deco)
  (m.deco?.trees ?? []).forEach((t, k) => {
    if (!roadClear(m, t.x, t.y, 0.3)) return; // never on a road, turning circle or junction
    if (!dryLand(m, t.x, t.y)) return;
    const r = hash2(k, 7, 43);
    const species = m.biome === 'desert' ? (t.kind === 2 ? Species.Palm : Species.Acacia) : m.biome === 'winter' ? Species.Birch : r < 0.7 ? Species.Young : Species.Fruit;
    out.push({ x: t.x, y: t.y, s: (m.biome === 'urban' ? 0.85 : 0.95) + hash2(k, 8, 43) * 0.3, species, rot: hash2(k, 9, 43) * Math.PI * 2 });
  });
  return out;
}

/** Approximate canopy radius of a tree spot (for ground shading). */
export function canopyRadius(t: TreeSpot) {
  const base = [0.36, 0.32, 0.44, 0.3, 0.28, 0.2, 0.44, 0.36, 0.42, 0.48][t.species] ?? 0.3;
  return base * t.s;
}

/**
 * Species of a tree on tile (x, y) (`t`: 1 conifer tile, 2 broadleaf tile):
 * willows and birches along the water, fruit trees by the farmsteads, poplar
 * rows along the roads, Scots pine on the higher ground, oak-birch woods elsewhere.
 */
function treeSpecies(m: GameMap, x: number, y: number, t: number, n4: number, r: number, ctx: { roads: GameMap['roads']; structures: GameMap['structures'] }): Species {
  // the other climates: date palms by the water and umbrella acacias (desert); spruce / pine forest and
  // birch groves (winter); park and street trees (city)
  if (m.biome === 'desert') return t === 2 ? Species.Palm : r < 0.85 ? Species.Acacia : Species.Young;
  if (m.biome === 'winter') {
    if (t === 2) return r < 0.85 ? Species.Birch : Species.Spruce;
    const h = m.heights[y * (m.w + 1) + x] ?? 0;
    return r < 0.66 - Math.max(0, Math.min(0.3, h * 0.12)) ? Species.Spruce : Species.Pine;
  }
  if (m.biome === 'urban') return t === 1 ? (r < 0.7 ? Species.Young : Species.Fruit) : r < 0.45 ? Species.Oak : r < 0.7 ? Species.Birch : r < 0.85 ? Species.Young : Species.Willow;
  if (t === 1) {
    const h = m.heights[y * (m.w + 1) + x] ?? 0;
    return r < 0.66 - Math.max(0, Math.min(0.3, h * 0.12)) ? Species.Spruce : Species.Pine;
  }
  let water = false;
  for (let dy = -2; dy <= 2 && !water; dy++)
    for (let dx = -2; dx <= 2; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < m.w && yy < m.h && m.tiles[yy * m.w + xx] === Tile.Water) {
        water = true;
        break;
      }
    }
  if (water) return r < 0.42 ? Species.Willow : r < 0.76 ? Species.Birch : r < 0.9 ? Species.Oak : Species.Young;
  const cx = x + 0.5;
  const cy = y + 0.5;
  if (n4 <= 2) {
    let house = Infinity;
    for (const st of ctx.structures) house = Math.min(house, Math.hypot(Math.max(st.x - cx, 0, cx - (st.x + st.w)), Math.max(st.y - cy, 0, cy - (st.y + st.h))));
    if (house < 4.5) return r < 0.62 ? Species.Fruit : r < 0.85 ? Species.Oak : Species.Young;
    let road = Infinity;
    for (const pts of ctx.roads)
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        const ex = b.x - a.x;
        const ey = b.y - a.y;
        const l2 = ex * ex + ey * ey || 1;
        const k = Math.max(0, Math.min(1, ((cx - a.x) * ex + (cy - a.y) * ey) / l2));
        road = Math.min(road, Math.hypot(a.x + ex * k - cx, a.y + ey * k - cy));
      }
    if (road < 2.6) return r < 0.62 ? Species.Poplar : r < 0.85 ? Species.Oak : Species.Birch;
  }
  return r < 0.52 ? Species.Oak : r < 0.74 ? Species.Birch : Species.Young;
}

// ------------------------------------------------------------- material

function foliageMaterial(atlas: THREE.Texture, fog: FogOfWar, quality: string) {
  const mat = new THREE.MeshStandardMaterial({
    map: atlas,
    alphaTest: 0.38,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.82,
    metalness: 0,
    alphaToCoverage: quality !== 'low',
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.windTime = windTime;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float windTime;\nattribute float flex;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          #ifdef USE_INSTANCING
            vec3 wo = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          #else
            vec3 wo = vec3(0.0);
          #endif
          float ph = windTime * 1.25 + wo.x * 0.31 + wo.z * 0.23;
          float sway = sin(ph) * 0.65 + sin(ph * 2.37 + 1.3) * 0.3 + sin(ph * 0.43) * 0.5;
          float flutter = sin(windTime * 7.0 + position.x * 23.0 + position.z * 19.0 + wo.x * 3.0) * 0.18;
          transformed.xz += vec2(0.82, 0.57) * (sway + flutter) * flex;
          transformed.y -= abs(sway) * flex * 0.15;
        }`,
      );
    // keep the authored (canopy-shaped) normals on both faces of the cards
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\nnormal = normalize( vNormal );');
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'foliage-wind-1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: atlas, alphaTest: 0.38, side: THREE.DoubleSide });
  return { mat, depth };
}

// ------------------------------------------------------------ geometries

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0);

function tuftGeo(cell: Leaf, h: number, w: number, rootShade = 0.55): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const [u0, v0, u1, v1] = leafCell(cell);
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    const e = V(Math.cos(a) * w * 0.5, 0, Math.sin(a) * w * 0.5);
    const ids = [V(0, h, 0).sub(e), V(0, h, 0).add(e), V(0, 0, 0).sub(e), V(0, 0, 0).add(e)].map((q, j) =>
      b.vert(q, UP, j % 2 ? u1 : u0, j < 2 ? v1 : v0, j < 2 ? 1 : rootShade, j < 2 ? 0.08 : 0),
    );
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  return b.build(true);
}

// ------------------------------------------------------------- builder

/** Handles to the instanced plants, for render-side environment damage (src/render/envdamage.ts). */
export interface VegetationHandles {
  trees: CulledInstances[];
  bushes: CulledInstances[];
}

export function buildVegetation(m: GameMap, layout: Layout, trees: TreeSpot[], fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod: SceneryLod, sink?: VegetationHandles): THREE.Object3D[] {
  const atlas = foliageAtlas(quality === 'low' ? 128 : 256);
  const { mat, depth } = foliageMaterial(atlas, fog, quality);
  const out: THREE.Object3D[] = [];
  const shadows = quality !== 'low';

  const low = quality === 'low';
  // view span (world units) beyond which the lighter models / no clutter are used
  const treeLo = quality === 'high' ? 19 : 14.5;
  const grassHide = quality === 'high' ? 24 : quality === 'medium' ? 17 : 13.5;
  // trees: species models, materials and instancing live in trees.ts
  out.push(...buildTrees(m, trees, fog, quality, lod, sink?.trees));

  // ---- ground cover
  const grass: Inst[] = [];
  const bushes: Inst[] = [];
  const hedges: Inst[] = [];
  const reeds: Inst[] = [];
  const look = biomeLook(m);
  const biome = m.biome;
  const density = quality === 'high' ? 1 : quality === 'medium' ? 0.55 : 0.35;
  const nearStart = (x: number, y: number) => Math.min(...m.starts.map((s) => Math.hypot(x - s.x - 0.5, y - s.y - 0.5)));
  const isTree = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.trees[y * m.w + x] > 0;
  let seed = 0;
  const tuftRGB = [0, 0, 0];
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      const t = m.tiles[i];
      if (t === Tile.Water || t === Tile.Bridge || t === Tile.Rock || m.blocked[i]) continue;
      const sd = nearStart(x + 0.5, y + 0.5);
      const baseK = sd < 8 ? 0.15 : sd < 12 ? 0.5 : 1;
      if (m.trees[i]) {
        // understory
        if (hash2(x, y, 300) < 0.15 + 0.15 * density) {
          const px = x + hash2(x, y, 301);
          const pz = y + hash2(x, y, 302);
          bushes.push(mk(px, pz, 0.8 + hash2(x, y, 303) * 0.6, 0.3, 0.32));
        }
        continue;
      }
      const edge = isTree(x - 1, y) || isTree(x + 1, y) || isTree(x, y - 1) || isTree(x, y + 1);
      const meadow = fbm(x * 0.12, y * 0.12, 71, 2);
      const dryness = fbm(x * 0.06, y * 0.06, 47, 3);
      // tall grass grows in clumps and swathes; between them it is short turf
      const clump = Math.max(0, Math.min(1, (meadow - 0.38) / 0.3));
      let n = (t === Tile.Grass ? 0.35 + clump * clump * 4.2 : t === Tile.Dirt ? 0.6 : 0.5) * density * baseK;
      if (m.ore[i]) n = 0;
      // tufts: scrub patches only in the desert, none in the snow, park lawns only in the city
      if (biome === 'winter' || ((biome === 'desert' || biome === 'urban') && t !== Tile.Grass)) n = 0;
      if (biome === 'desert') n *= 0.35;
      n = Math.floor(n + hash2(x, y, 304));
      // medium / high grow 3D grass blades instead (grass.ts): the card tufts are the low-quality
      // stand-in (the seed still advances so the reeds and hedges keep their places)
      if (quality !== 'low') {
        seed += n;
        n = 0;
      }
      for (let k = 0; k < n; k++) {
        seed++;
        const px = x + hash2(seed, 1, 305);
        const pz = y + hash2(seed, 2, 305);
        const occ = occAt(layout, m, px, pz);
        if (occ & (OCC_ROAD | OCC_BUILT | OCC_FIELD)) continue;
        if (occ & OCC_TRACK && hash2(seed, 3, 305) < 0.85) continue;
        const r = hash2(seed, 4, 305);
        const dryK = Math.max(0, Math.min(1, (dryness - 0.4) * 1.6 + (r - 0.5) * 0.6 + (t === Tile.Sand ? 0.5 : 0)));
        const tuft = mk(px, pz, 0.75 + hash2(seed, 5, 305) * 0.6 + clump * 0.35, 0.85, 0.12);
        // the meadow's own palette (grasstex.ts), lifted to cancel the card texture's darkness
        grassRGB(0.2 + clump * 0.3, dryK * 0.75, tuftRGB, look.grass);
        tuft.color = new THREE.Color().setRGB(tuftRGB[0], tuftRGB[1], tuftRGB[2], THREE.SRGBColorSpace).multiplyScalar(1.8 * (0.88 + hash2(seed, 6, 305) * 0.25));
        grass.push(tuft);
      }
      // bushes at forest edges and scattered singles (desert: sparse scrub; city: parks only)
      let nb = edge ? 1 + (hash2(x, y, 306) < 0.5 ? 1 : 0) : hash2(x, y, 307) < 0.06 * baseK ? 1 : 0;
      if (biome === 'urban' && t !== Tile.Grass) nb = 0;
      if (biome === 'desert' && t === Tile.Sand && hash2(x, y, 308) < 0.7) nb = 0;
      for (let k = 0; k < nb; k++) {
        const px = x + hash2(x, y, 310 + k);
        const pz = y + hash2(x, y, 320 + k);
        if (occAt(layout, m, px, pz) & (OCC_ROAD | OCC_TRACK | OCC_BUILT | OCC_FIELD)) continue;
        bushes.push(mk(px, pz, 0.7 + hash2(x, y, 330 + k) * 0.8, 0.28, 0.3));
      }
    }
  }
  // hedgerows
  for (const e of layout.edges) {
    if (e.kind !== 'hedge') continue;
    const L = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y);
    // fewer, larger shrubs per metre of hedge on lighter settings
    const gap = quality === 'high' ? 0.26 : quality === 'medium' ? 0.34 : 0.42;
    const hs = gap / 0.26;
    const n = Math.ceil(L / gap);
    for (let k = 0; k <= n; k++) {
      seed++;
      const t = k / n;
      const px = e.a.x + (e.b.x - e.a.x) * t + (hash2(seed, 1, 340) - 0.5) * 0.12;
      const pz = e.a.y + (e.b.y - e.a.y) * t + (hash2(seed, 2, 340) - 0.5) * 0.12;
      const tx = Math.floor(px);
      const ty = Math.floor(pz);
      if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h || m.tiles[ty * m.w + tx] === Tile.Water) continue;
      hedges.push(mk(px, pz, (1.05 + hash2(seed, 3, 340) * 0.5) * Math.sqrt(hs), 0.25, 0.28));
    }
  }
  // reeds along the waterline
  const reedN = 0; // waterline reeds now come from waterside.ts (swaying reed / cattail clusters)
  for (let y = 0; y < m.h; y++)
    for (let x = 0; x < m.w; x++) {
      const t = m.tiles[y * m.w + x];
      if (t !== Tile.Sand && t !== Tile.Water) continue;
      for (let k = 0; k < reedN * 2; k++) {
        seed++;
        const px = x + hash2(seed, 1, 350);
        const pz = y + hash2(seed, 2, 350);
        const h = surfaceHeight(m, px, pz);
        if (h < WATER_LEVEL - 0.12 || h > WATER_LEVEL + 0.18) continue;
        if (occAt(layout, m, px, pz) & OCC_ROAD) continue;
        if (fbm(px * 0.5, pz * 0.5, 351, 2) < 0.45) continue;
        reeds.push(mk(px, pz, 0.8 + hash2(seed, 3, 350) * 0.6, 0.7, 0.12));
      }
    }

  function mk(px: number, pz: number, s: number, sat: number, hueJ: number): Inst {
    const r = hash2(Math.floor(px * 97), Math.floor(pz * 97), 9);
    const c = new THREE.Color().setHSL(0.22 + (r - 0.5) * hueJ, 0.05 + sat * 0.1, 0.92 + (r - 0.5) * 0.16);
    return { x: px, y: surfaceHeight(m, px, pz) - 0.01, z: pz, rotY: r * Math.PI * 2, sx: s, sy: s * (0.85 + r * 0.3), sz: s, color: c };
  }

  const groups: [THREE.BufferGeometry, THREE.BufferGeometry | null, Inst[], boolean, number, number][] = [
    [tuftGeo(Leaf.Grass, 0.22, 0.32, 0.72), null, grass, false, Infinity, grassHide],
    [tuftGeo(Leaf.Reeds, 0.36, 0.26), null, reeds, false, Infinity, grassHide + 4],
  ];
  for (const [g, lo, list, cast, loSpan, hideSpan] of groups) {
    if (!list.length) continue;
    const ci = new CulledInstances(g, mat, list, m.w, m.h, CELL, { castShadow: cast, receiveShadow: true, name: 'plants' });
    ci.mesh.customDepthMaterial = depth;
    out.push(ci.mesh);
    lod.addCulled(ci, lo, loSpan, hideSpan);
  }
  // shrubs and hedgerows: built like the trees (leaf-card crowns, wrap lighting, translucency, wind)
  const tm = treeMaterials(fog, quality);
  const shrubSets: [Shrub, Inst[]][] = [
    [biome === 'desert' ? Shrub.Scrub : Shrub.Bush, bushes],
    [Shrub.Hedge, hedges],
  ];
  for (const [kind, list] of shrubSets) {
    if (!list.length) continue;
    for (const it of list) {
      const kx = Math.floor(it.x * 13);
      const kz = Math.floor(it.z * 13);
      it.color = shrubTint(biome, kind, hash2(kx, kz, 3), hash2(kx, kz, 4), hash2(kx, kz, 5));
      it.tiltX = (hash2(kx, kz, 6) - 0.5) * 0.12;
    }
    const lo = shrubGeometry(kind, true);
    const ci = new CulledInstances(low ? lo : shrubGeometry(kind, false), tm.mat, list, m.w, m.h, CELL, { castShadow: shadows && quality === 'high', receiveShadow: true, name: 'plants' });
    ci.mesh.customDepthMaterial = tm.depth;
    out.push(ci.mesh);
    lod.addCulled(ci, low ? null : lo, treeLo - 2, Infinity);
    sink?.bushes.push(ci);
  }
  return out;
}
