import * as THREE from 'three';
import { Tile, WATER_LEVEL, type GameMap } from '../sim/map';
import { fbm, hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { CulledInstances, GeoBuilder, type Inst, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { OCC_BUILT, OCC_FIELD, OCC_ROAD, OCC_TRACK, occAt, type Layout } from './layout';
import { Leaf, foliageAtlas, leafCell } from './terraintex';

/*
 * Trees, bushes, grass and reeds. All plants share one alpha-tested foliage
 * atlas material with wind sway in the vertex shader; each species is one
 * geometry, instanced per map chunk.
 */

export const windTime = { value: 0 };

export const enum Species {
  Spruce = 0,
  Pine = 1,
  Oak = 2,
  Birch = 3,
  Young = 4,
}

export interface TreeSpot {
  x: number;
  y: number;
  s: number;
  species: Species;
  rot: number;
}

/** Culling cell size (tiles). */
const CELL = 4;

/** Deterministic tree placement for every tree tile of the map. */
export function treeSpots(m: GameMap, quality: 'low' | 'medium' | 'high'): TreeSpot[] {
  const out: TreeSpot[] = [];
  const isTree = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.trees[y * m.w + x] > 0;
  const maxPer = quality === 'low' ? 2 : 3;
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
        let species: Species;
        if (t === 1) species = r < 0.68 ? Species.Spruce : Species.Pine;
        else species = r < 0.55 ? Species.Oak : r < 0.8 ? Species.Birch : Species.Young;
        const forest = n4 >= 2;
        const s = (forest ? 0.95 : 0.82) + hash2(x, y, 70 + k) * 0.45;
        out.push({ x: ox, y: oy, s, species, rot: hash2(x, y, 90 + k) * Math.PI * 2 });
      }
    }
  }
  return out;
}

/** Approximate canopy radius of a tree spot (for ground shading). */
export function canopyRadius(t: TreeSpot) {
  const base = t.species === Species.Spruce ? 0.34 : t.species === Species.Pine ? 0.36 : t.species === Species.Oak ? 0.42 : t.species === Species.Birch ? 0.3 : 0.28;
  return base * t.s;
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

function trunk(b: GeoBuilder, h: number, r0: number, r1: number, shade: THREE.Color | number, sides = 5) {
  const cyl = new THREE.CylinderGeometry(r1, r0, h, sides, 1, true).translate(0, h / 2, 0);
  b.add(cyl, new THREE.Matrix4(), leafCell(Leaf.Bark), shade, { uvScale: [1, 1] });
}

/** Ring of drooping branch cards around the trunk. */
function branchTier(b: GeoBuilder, y: number, radius: number, droop: number, cards: number, rot: number, centre: THREE.Vector3, light: number, flexK: number) {
  const [u0, v0, u1, v1] = leafCell(Leaf.Conifer);
  for (let j = 0; j < cards; j++) {
    const a = rot + (j / cards) * Math.PI * 2;
    const dir = V(Math.cos(a), 0, Math.sin(a));
    const tan = V(-Math.sin(a), 0, Math.cos(a));
    const w = radius * 0.9;
    const root = V(0, y + droop * 0.25, 0).addScaledVector(dir, 0.02);
    const tip = V(dir.x * radius, y - droop, dir.z * radius);
    // the card is tilted so its face looks up/outwards
    const lift = V(0, 0.18 * w, 0);
    const p = [
      root.clone().addScaledVector(tan, -w * 0.22),
      root.clone().addScaledVector(tan, w * 0.22),
      tip.clone().addScaledVector(tan, -w * 0.5).add(lift),
      tip.clone().addScaledVector(tan, w * 0.5).sub(lift),
    ];
    const ids = p.map((q, k) => {
      const n = q.clone().sub(centre).normalize().addScaledVector(UP, 0.7).normalize();
      const tipSide = k >= 2;
      const c = light * (tipSide ? 1 : 0.6);
      const f = Math.max(0, q.y) * flexK * (tipSide ? 1 : 0.5);
      return b.vert(q, n, tipSide ? u1 : u0, k % 2 === 0 ? v0 : v1, c, f);
    });
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  }
}

function coniferGeo(kind: 'spruce' | 'pine', lite = false): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const centre = V(0, 0.45, 0);
  if (kind === 'spruce') {
    trunk(b, 0.95, 0.035, 0.01, 0.8, lite ? 3 : 5);
    // dark inner cone to make the crown read as dense from above
    const core = new THREE.ConeGeometry(0.2, 0.78, lite ? 5 : 6, 1, true).translate(0, 0.5, 0);
    b.add(core, new THREE.Matrix4(), leafCell(Leaf.Solid), 0.55, { normalFn: (p) => p.clone().sub(centre).normalize().addScaledVector(UP, 0.5).normalize() });
    const tiers = lite ? 5 : 7;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y = 0.14 + t * 0.74;
      const r = 0.38 * (1 - t * 0.82) + 0.04;
      branchTier(b, y, r, r * 0.42, lite ? (i > 2 ? 4 : 5) : i > 4 ? 5 : 7, i * 0.53, centre, 0.62 + t * 0.45, 0.022);
    }
    // leader at the top
    const [u0, v0, u1, v1] = leafCell(Leaf.Conifer);
    for (const a of lite ? [] : [0, Math.PI / 2]) {
      const t = V(Math.cos(a) * 0.05, 0, Math.sin(a) * 0.05);
      const ids = [V(0, 0.84, 0).sub(t), V(0, 0.84, 0).add(t), V(0, 1.0, 0).sub(t.clone().multiplyScalar(0.3)), V(0, 1.0, 0).add(t.clone().multiplyScalar(0.3))].map((q, k) =>
        b.vert(q, V(0, 1, 0), k >= 2 ? u1 : u0, k % 2 ? v1 : v0, 1.0, 0.02),
      );
      b.quad(ids[0], ids[1], ids[2], ids[3]);
    }
  } else {
    trunk(b, 0.9, 0.04, 0.015, 0.95, lite ? 3 : 5);
    const core = (lite ? new THREE.OctahedronGeometry(0.2, 0) : new THREE.IcosahedronGeometry(0.2, 0)).scale(1, 0.55, 1).translate(0, 0.74, 0);
    b.add(core, new THREE.Matrix4(), leafCell(Leaf.Solid), 0.6, { normalFn: (p) => p.clone().sub(V(0, 0.7, 0)).normalize() });
    const tiers = lite ? 2 : 4;
    for (let i = 0; i < tiers; i++) {
      const t = i / (tiers - 1);
      const y = 0.52 + t * 0.36;
      const r = 0.34 * (1 - t * 0.6) + 0.05;
      branchTier(b, y, r, r * 0.18, lite ? 5 : 6, i * 1.1, V(0, 0.7, 0), 0.7 + t * 0.4, 0.02);
    }
  }
  return b.build(true);
}

/** Leaf-card clusters on an ellipsoid around a dark solid core. */
function canopy(b: GeoBuilder, centre: THREE.Vector3, rad: THREE.Vector3, clusters: number, size: number, cell: Leaf, seed: number, flexK: number, coreDetail = 1, cards = 3) {
  const core = coreDetail < 0 ? new THREE.OctahedronGeometry(1, 0) : new THREE.IcosahedronGeometry(1, coreDetail);
  const cm = new THREE.Matrix4().compose(centre, new THREE.Quaternion(), rad.clone().multiplyScalar(0.78));
  b.add(core, cm, leafCell(Leaf.Solid), (p) => 0.5 + Math.max(0, (p.y - centre.y) / rad.y) * 0.25, {
    normalFn: (p) => p.clone().sub(centre).divide(rad).normalize(),
    flexFn: (p) => Math.max(0, p.y) * flexK * 0.5,
  });
  const [u0, v0, u1, v1] = leafCell(cell);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < clusters; i++) {
    // fibonacci points, skipping the very bottom
    const yy = 1 - (i / (clusters - 1)) * 1.7;
    const rr = Math.sqrt(Math.max(0, 1 - yy * yy));
    const th = i * golden + seed;
    const jit = 0.85 + hash2(i, seed * 13, 7) * 0.25;
    const c = V(Math.cos(th) * rr * rad.x * jit, yy * rad.y * jit, Math.sin(th) * rr * rad.z * jit).add(centre);
    const sz = size * (0.8 + hash2(i, seed * 17, 8) * 0.4);
    // crossed cards per cluster
    for (let k = 0; k < cards; k++) {
      const a = th + (k * Math.PI) / cards;
      const e1 = V(Math.cos(a), 0, Math.sin(a)).multiplyScalar(sz);
      const e2 = k === cards - 1 && cards > 2 ? V(-Math.sin(a), 0, Math.cos(a)).multiplyScalar(sz) : V(0, sz * 0.85, 0).addScaledVector(V(-Math.sin(a), 0, Math.cos(a)), sz * 0.35);
      const corners = [c.clone().sub(e1).add(e2), c.clone().add(e1).add(e2), c.clone().sub(e1).sub(e2), c.clone().add(e1).sub(e2)];
      const ids = corners.map((q, j) => {
        const n = q.clone().sub(centre).divide(rad).normalize();
        const lightK = 0.62 + Math.max(-0.3, (q.y - centre.y) / rad.y) * 0.32 + 0.1;
        return b.vert(q, n, j % 2 ? u1 : u0, j < 2 ? v1 : v0, lightK, Math.max(0, q.y) * flexK);
      });
      b.quad(ids[0], ids[1], ids[2], ids[3]);
    }
  }
}

function broadleafGeo(kind: 'oak' | 'birch' | 'young', lite = false): THREE.BufferGeometry {
  const b = new GeoBuilder();
  // the lite version keeps the silhouette: fewer, bigger leaf clusters of two cards
  const cl = (n: number) => (lite ? Math.ceil(n * 0.55) : n);
  const sz = (x: number) => (lite ? x * 1.3 : x);
  const core = lite ? 0 : 1;
  const cards = 3;
  if (kind === 'oak') {
    trunk(b, 0.55, 0.05, 0.03, 0.85, lite ? 4 : 5);
    if (!lite)
      for (const a of [0.4, 2.5, 4.4]) {
        const br = new THREE.CylinderGeometry(0.012, 0.025, 0.32, 4, 1, true).translate(0, 0.16, 0);
        const m = new THREE.Matrix4().makeRotationAxis(V(Math.cos(a), 0, Math.sin(a)).cross(UP).normalize(), -0.75).premultiply(new THREE.Matrix4().makeTranslation(0, 0.42, 0));
        b.add(br, m, leafCell(Leaf.Bark), 0.8);
      }
    canopy(b, V(0, 0.72, 0), V(0.42, 0.3, 0.42), cl(13), sz(0.17), Leaf.Broadleaf, 1, 0.025, core, cards);
  } else if (kind === 'birch') {
    trunk(b, 0.85, 0.03, 0.012, 2.2, lite ? 3 : 5);
    canopy(b, V(0, 0.78, 0), V(0.26, 0.38, 0.26), cl(11), sz(0.14), Leaf.Broadleaf, 2, 0.03, core, cards);
  } else {
    trunk(b, 0.3, 0.025, 0.018, 0.85, lite ? 3 : 5);
    canopy(b, V(0, 0.48, 0), V(0.3, 0.24, 0.3), cl(9), sz(0.15), Leaf.Bush, 3, 0.03, core, cards);
  }
  return b.build(true);
}

function bushGeo(lite = false): THREE.BufferGeometry {
  const b = new GeoBuilder();
  canopy(b, V(0, 0.13, 0), V(0.22, 0.15, 0.22), lite ? 4 : 6, lite ? 0.15 : 0.12, Leaf.Bush, 4, 0.05, lite ? -1 : 0, 3);
  return b.build(true);
}

function tuftGeo(cell: Leaf, h: number, w: number): THREE.BufferGeometry {
  const b = new GeoBuilder();
  const [u0, v0, u1, v1] = leafCell(cell);
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    const e = V(Math.cos(a) * w * 0.5, 0, Math.sin(a) * w * 0.5);
    const ids = [V(0, h, 0).sub(e), V(0, h, 0).add(e), V(0, 0, 0).sub(e), V(0, 0, 0).add(e)].map((q, j) =>
      b.vert(q, UP, j % 2 ? u1 : u0, j < 2 ? v1 : v0, j < 2 ? 1 : 0.55, j < 2 ? 0.08 : 0),
    );
    b.quad(ids[0], ids[1], ids[2], ids[3]);
  }
  return b.build(true);
}

// ------------------------------------------------------------- builder

export function buildVegetation(m: GameMap, layout: Layout, trees: TreeSpot[], fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod: SceneryLod): THREE.Object3D[] {
  const atlas = foliageAtlas(quality === 'low' ? 128 : 256);
  const { mat, depth } = foliageMaterial(atlas, fog, quality);
  const out: THREE.Object3D[] = [];
  const shadows = quality !== 'low';

  const low = quality === 'low';
  const geoPair = (fn: (lite: boolean) => THREE.BufferGeometry): [THREE.BufferGeometry, THREE.BufferGeometry] => {
    const lo = fn(true);
    return [low ? lo : fn(false), lo];
  };
  const geos: Record<Species, [THREE.BufferGeometry, THREE.BufferGeometry]> = {
    [Species.Spruce]: geoPair((l) => coniferGeo('spruce', l)),
    [Species.Pine]: geoPair((l) => coniferGeo('pine', l)),
    [Species.Oak]: geoPair((l) => broadleafGeo('oak', l)),
    [Species.Birch]: geoPair((l) => broadleafGeo('birch', l)),
    [Species.Young]: geoPair((l) => broadleafGeo('young', l)),
  };
  // view span (world units) beyond which the lighter models / no clutter are used
  const treeLo = quality === 'high' ? 19 : 14.5;
  const grassHide = quality === 'high' ? 24 : quality === 'medium' ? 17 : 13.5;
  const lists: Inst[][] = [[], [], [], [], []];
  const col = (h: number, s: number, l: number) => new THREE.Color().setHSL(h, s, l);
  for (const t of trees) {
    const r1 = hash2(Math.floor(t.x * 7), Math.floor(t.y * 7), 3);
    const r2 = hash2(Math.floor(t.x * 7), Math.floor(t.y * 7), 4);
    let c: THREE.Color;
    switch (t.species) {
      case Species.Spruce:
        c = col(0.3 + r1 * 0.05, 0.22 + r2 * 0.15, 0.62 + r2 * 0.2);
        break;
      case Species.Pine:
        c = col(0.2 + r1 * 0.06, 0.3, 0.68 + r2 * 0.18);
        break;
      case Species.Birch:
        c = col(0.17 + r1 * 0.05, 0.45, 0.78 + r2 * 0.15);
        break;
      default:
        // oaks/young trees: green with an occasional olive or autumn-ish tone
        c = r1 < 0.08 ? col(0.1, 0.45, 0.72) : col(0.2 + r1 * 0.07, 0.3 + r2 * 0.2, 0.66 + r2 * 0.2);
    }
    const h = surfaceHeight(m, t.x, t.y);
    const sy = t.s * (0.9 + r2 * 0.25);
    lists[t.species].push({ x: t.x, y: h - 0.02, z: t.y, rotY: t.rot, sx: t.s, sy, sz: t.s, color: c, tiltX: (r1 - 0.5) * 0.08, tiltZ: (r2 - 0.5) * 0.08 });
  }
  lists.forEach((list, sp) => {
    if (!list.length) return;
    const [hi, lo] = geos[sp as Species];
    const ci = new CulledInstances(hi, mat, list, m.w, m.h, CELL, { castShadow: shadows, receiveShadow: true, name: 'trees' });
    ci.mesh.customDepthMaterial = depth;
    out.push(ci.mesh);
    lod.addCulled(ci, lo, treeLo);
  });

  // ---- ground cover
  const grass: Inst[] = [];
  const bushes: Inst[] = [];
  const reeds: Inst[] = [];
  const density = quality === 'high' ? 1 : quality === 'medium' ? 0.55 : 0.35;
  const nearStart = (x: number, y: number) => Math.min(...m.starts.map((s) => Math.hypot(x - s.x - 0.5, y - s.y - 0.5)));
  const isTree = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.trees[y * m.w + x] > 0;
  let seed = 0;
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
      n = Math.floor(n + hash2(x, y, 304));
      for (let k = 0; k < n; k++) {
        seed++;
        const px = x + hash2(seed, 1, 305);
        const pz = y + hash2(seed, 2, 305);
        const occ = occAt(layout, m, px, pz);
        if (occ & (OCC_ROAD | OCC_BUILT | OCC_FIELD)) continue;
        if (occ & OCC_TRACK && hash2(seed, 3, 305) < 0.85) continue;
        const r = hash2(seed, 4, 305);
        const dryK = Math.max(0, Math.min(1, (dryness - 0.4) * 1.6 + (r - 0.5) * 0.6 + (t === Tile.Sand ? 0.5 : 0)));
        const tuft = mk(px, pz, 0.6 + hash2(seed, 5, 305) * 0.6 + clump * 0.3, 0.85, 0.12);
        tuft.color = new THREE.Color(0.42 + dryK * 0.4, 0.62 + dryK * 0.12, 0.26 + dryK * 0.1).multiplyScalar(0.85 + hash2(seed, 6, 305) * 0.25);
        grass.push(tuft);
      }
      // bushes at forest edges and scattered singles
      const nb = edge ? 1 + (hash2(x, y, 306) < 0.5 ? 1 : 0) : hash2(x, y, 307) < 0.06 * baseK ? 1 : 0;
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
      bushes.push(mk(px, pz, (1.05 + hash2(seed, 3, 340) * 0.5) * Math.sqrt(hs), 0.25, 0.28));
    }
  }
  // reeds along the waterline
  const reedN = quality === 'low' ? 1 : quality === 'medium' ? 2 : 3;
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

  const bushLo = bushGeo(true);
  const groups: [THREE.BufferGeometry, THREE.BufferGeometry | null, Inst[], boolean, number, number][] = [
    [tuftGeo(Leaf.Grass, 0.2, 0.3), null, grass, false, Infinity, grassHide],
    [low ? bushLo : bushGeo(), bushLo, bushes, shadows && quality === 'high', treeLo - 2, Infinity],
    [tuftGeo(Leaf.Reeds, 0.36, 0.26), null, reeds, false, Infinity, grassHide + 4],
  ];
  for (const [g, lo, list, cast, loSpan, hideSpan] of groups) {
    if (!list.length) continue;
    const ci = new CulledInstances(g, mat, list, m.w, m.h, CELL, { castShadow: cast, receiveShadow: true, name: 'plants' });
    ci.mesh.customDepthMaterial = depth;
    out.push(ci.mesh);
    lod.addCulled(ci, lo, loSpan, hideSpan);
  }
  return out;
}
