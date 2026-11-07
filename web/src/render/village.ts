import * as THREE from 'three';
import { StructureKind, type GameMap, type Structure } from '../sim/map';
import { LT_GARRISON_KINDS } from '../sim/maps';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { GeoBuilder, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import type { HouseHandle } from './scenery';

/*
 * The Litani mouth's villages (MapDeco.village): every OSM building of the window where it really stands, at its
 * real size and heading (a little larger: game scale), built as south Lebanon builds - the reference photos of Burj
 * Rahhal and the satellite view of Qasmiyeh and Ain Abou Abdallah: two to four storeys of rendered concrete in cream,
 * off-white, beige, sand and pale pink (now and then grey block, unpainted), rows of windows, balconies along the
 * long side with slab floors and iron railings, flat roofs crowded with water tanks, solar water heaters and a stair
 * head, a third of them under a low hipped roof of orange-red tiles, some with the next storey's columns and their
 * rebar waiting on the roof.
 *
 * Cheap enough for the phone: each house is a handful of boxes (walls with a window texture, a roof slab or a tile
 * roof; ~30 triangles), its roof clutter and balconies a few more (~80) in a detail mesh hidden at far zoom
 * (SceneryLod). Merged per CHUNK-tile square into three meshes each (walls, tile roofs, detail), frustum-culled per
 * chunk: a dozen draw calls on screen for some 3000 houses.
 */

/** Chunk size (tiles) of the merged village meshes. */
const CHUNK = 32;
/** Storey height (height units; a tile's width is one). */
const STOREY = 0.12;
/** A window bay's width along a wall (world units). */
const BAY = 0.085;
/** The roof clutter and balconies are hidden once the view spans more than this (world units), as the desert town's kit. */
const DETAIL_SPAN = 30;

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const C = (hex: number) => new THREE.Color(hex);

/** Render plaster: cream, off-white, beige, sand, pale yellow, pale pink, light grey; the last, grey block, unpainted. */
const WALLS = [0xecdcbc, 0xf2ede2, 0xdcc49a, 0xe4c99a, 0xf0dca6, 0xeac2b0, 0xd2cbbd, 0xe8d3b0, 0xf3e6cf, 0xa9a59b];
const TILES = [0xb5532e, 0xc0663a, 0xa84a2a, 0xc8703f];
const TANKS = [0x2a2a2a, 0xe6e6e2, 0x3a6ea8, 0xd8cdb0, 0x2a2a2a];

/**
 * The facade texture: two window bays of one storey side by side (plaster; a framed dark window with a sill; the
 * second bay's window behind half-closed louvred shutters, faded green or brown), repeating along the walls.
 */
function facadeTexture(px: number): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = px * 2;
  c.height = px;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(px * 2, px);
  for (let y = 0; y < px; y++)
    for (let x = 0; x < px * 2; x++) {
      const bay = x >= px ? 1 : 0;
      const u = (x % px) / px;
      const v = 1 - y / px;
      const g = 0.86 + (hash2(x, y, 77) - 0.5) * 0.06;
      let rgb = [g, g, g];
      const win = u > 0.24 && u < 0.76 && v > 0.26 && v < 0.82;
      const glass = u > 0.28 && u < 0.72 && v > 0.3 && v < 0.78;
      if (win) rgb = [0.96, 0.96, 0.95];
      if (glass) {
        const gl = 0.13 + v * 0.1 + (u > 0.49 && u < 0.51 ? 0.4 : 0);
        rgb = [gl, gl * 1.05, gl * 1.12];
        // (the second bay: louvred shutters drawn halfway across)
        if (bay && (u < 0.4 || u > 0.6)) {
          const slat = Math.floor(v * 40) % 2 ? 0.9 : 0.75;
          rgb = (x >> 4) % 3 ? [0.36 * slat, 0.44 * slat, 0.34 * slat] : [0.46 * slat, 0.34 * slat, 0.24 * slat];
        }
      } else if (u > 0.21 && u < 0.79 && v > 0.22 && v <= 0.26) rgb = [0.97, 0.97, 0.96];
      // (the floor slab's line)
      if (v < 0.04) rgb = rgb.map((q) => q * 0.84);
      const o = (y * px * 2 + x) * 4;
      for (let k = 0; k < 3; k++) img.data[o + k] = Math.max(0, Math.min(255, rgb[k] * 255));
      img.data[o + 3] = 255;
    }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 4;
  return t;
}

interface Chunk {
  walls: GeoBuilder;
  roofs: GeoBuilder;
  detail: GeoBuilder;
  /** Each house's (or garrison house's) vertex ranges in the three builders. */
  spans: { st: Structure; gy: number; from: number[]; to: number[] }[];
}

/** An axis box in a house's frame (centre x, y, z; size w, h, d along local x, y, z), its five visible faces (no bottom). */
function box(b: GeoBuilder, f: THREE.Matrix4, cx: number, cy: number, cz: number, w: number, h: number, d: number, col: THREE.Color, uv?: (lx: number, ly: number, face: number) => [number, number]) {
  const n3 = new THREE.Matrix3().getNormalMatrix(f);
  const face = (pts: THREE.Vector3[], n: THREE.Vector3, k: number) => {
    const nn = n.clone().applyMatrix3(n3).normalize();
    const ids = pts.map((p, j) => {
      const [u, v] = uv ? uv(j & 1 ? 1 : 0, j >> 1, k) : [0.04, 0.1];
      return b.vert(p.clone().applyMatrix4(f), nn, u, v, col);
    });
    // (GeoBuilder.quad(a, b, c, d) makes a-c-b and b-c-d: bottom-left, top-left, bottom-right, top-right faces out)
    b.quad(ids[0], ids[2], ids[1], ids[3]);
  };
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const y0 = cy - h / 2;
  const y1 = cy + h / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  // (each face: bottom-left, bottom-right, top-left, top-right seen from outside)
  face([V(x0, y0, z1), V(x1, y0, z1), V(x0, y1, z1), V(x1, y1, z1)], V(0, 0, 1), 0);
  face([V(x1, y0, z0), V(x0, y0, z0), V(x1, y1, z0), V(x0, y1, z0)], V(0, 0, -1), 1);
  face([V(x1, y0, z1), V(x1, y0, z0), V(x1, y1, z1), V(x1, y1, z0)], V(1, 0, 0), 2);
  face([V(x0, y0, z0), V(x0, y0, z1), V(x0, y1, z0), V(x0, y1, z1)], V(-1, 0, 0), 3);
  face([V(x0, y1, z1), V(x1, y1, z1), V(x0, y1, z0), V(x1, y1, z0)], V(0, 1, 0), 4);
}

/** A small upright cylinder (six sides and a lid) in a house's frame. */
function drum(b: GeoBuilder, f: THREE.Matrix4, x: number, y: number, z: number, r: number, h: number, col: THREE.Color) {
  const n3 = new THREE.Matrix3().getNormalMatrix(f);
  const K = 6;
  const top: number[] = [];
  for (let k = 0; k < K; k++) {
    const a0 = (k / K) * Math.PI * 2;
    const a1 = ((k + 1) / K) * Math.PI * 2;
    const n = V(Math.cos((a0 + a1) / 2), 0, Math.sin((a0 + a1) / 2)).applyMatrix3(n3).normalize();
    const p = [V(x + Math.cos(a0) * r, y, z + Math.sin(a0) * r), V(x + Math.cos(a1) * r, y, z + Math.sin(a1) * r), V(x + Math.cos(a0) * r, y + h, z + Math.sin(a0) * r), V(x + Math.cos(a1) * r, y + h, z + Math.sin(a1) * r)];
    const ids = p.map((q) => b.vert(q.applyMatrix4(f), n, 0.08, 0.08, col));
    b.quad(ids[1], ids[3], ids[0], ids[2]);
  }
  const up = V(0, 1, 0).applyMatrix3(n3).normalize();
  for (let k = 0; k < K; k++) top.push(b.vert(V(x + Math.cos((k / K) * Math.PI * 2) * r, y + h, z + Math.sin((k / K) * Math.PI * 2) * r).applyMatrix4(f), up, 0.08, 0.08, col));
  for (let k = 1; k < K - 1; k++) b.tri(top[0], top[k + 1], top[k]);
}

type VHouse = NonNullable<NonNullable<GameMap['deco']>['village']>[number];

/**
 * Build the villages' houses (MapDeco.village): meshes to add to the scene. `roofTex`: the clay tile texture of the
 * other maps' village roofs (terraintex.ts buildingTextures). The garrison houses (sim/garrison.ts) are the real
 * buildings on their footprints (scenery.ts leaves them to this), or a block of flats where none stands; every house
 * hands its vertex ranges to `sink` (envdamage.ts: scorched, caved in, collapsed), the garrison ones under their own
 * structure, the others each under its bounding square.
 */
export function buildVillage(m: GameMap, fog: FogOfWar, quality: 'low' | 'medium' | 'high', roofTex: THREE.Texture, lod?: SceneryLod, sink?: { houses: HouseHandle[] }): THREE.Object3D[] {
  const list = m.deco?.village;
  if (!list?.length) return [];
  const chunks = new Map<number, Chunk>();
  const chunkAt = (x: number, y: number) => {
    const key = Math.floor(y / CHUNK) * 64 + Math.floor(x / CHUNK);
    let ch = chunks.get(key);
    if (!ch) chunks.set(key, (ch = { walls: new GeoBuilder(), roofs: new GeoBuilder(), detail: new GeoBuilder(), spans: [] }));
    return ch;
  };
  const counts = (ch: Chunk) => [ch.walls.count, ch.roofs.count, ch.detail.count];
  const used = new Uint8Array(list.length);
  // the garrison houses first, each its buildings in one run
  for (const st of m.structures) {
    if (!isVillageStructure(m, st)) continue;
    const ch = chunkAt(st.x + st.w / 2, st.y + st.h / 2);
    const from = counts(ch);
    let gy = 99;
    let n = 0;
    list.forEach((h, k) => {
      if (used[k] || h.x <= st.x || h.y <= st.y || h.x >= st.x + st.w || h.y >= st.y + st.h) return;
      used[k] = 1;
      n++;
      gy = Math.min(gy, house(m, ch, h));
    });
    // (none stands there: a block of flats on the footprint, its long side to the street)
    if (!n) gy = house(m, ch, { x: st.x + st.w / 2, y: st.y + st.h / 2, hl: st.w * 0.36, hw: st.h * 0.3, ang: st.rot % 2 ? Math.PI / 2 : 0 }, 3);
    ch.spans.push({ st, gy, from, to: counts(ch) });
  }
  list.forEach((h, k) => {
    if (used[k]) return;
    const ch = chunkAt(h.x, h.y);
    const from = counts(ch);
    const gy = house(m, ch, h);
    const r = Math.max(h.hl, h.hw);
    ch.spans.push({ st: { kind: StructureKind.House, x: h.x - r, y: h.y - r, w: 2 * r, h: 2 * r, rot: 0 }, gy, from, to: counts(ch) });
  });
  const shadows = quality !== 'low';
  const wallMat = fog.apply(new THREE.MeshStandardMaterial({ map: facadeTexture(quality === 'low' ? 32 : 64), vertexColors: true, roughness: 0.92 }));
  const roofMat = fog.apply(new THREE.MeshStandardMaterial({ map: roofTex, vertexColors: true, roughness: 0.8 }));
  const detMat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.15 }));
  const out: THREE.Object3D[] = [];
  for (const ch of chunks.values()) {
    const mk = (b: GeoBuilder, mat: THREE.Material, name: string, cast: boolean) => {
      if (!b.count) return null;
      const g = b.build();
      b.release();
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = cast;
      mesh.receiveShadow = true;
      mesh.name = name;
      mesh.userData.perfCat = 'scenery';
      out.push(mesh);
      return mesh;
    };
    const meshes = [mk(ch.walls, wallMat, 'village-walls', shadows), mk(ch.roofs, roofMat, 'village-roofs', shadows), mk(ch.detail, detMat, 'village-detail', shadows && quality === 'high')];
    const d = meshes[2];
    if (d && lod) lod.add([d], d.geometry, null, Infinity, DETAIL_SPAN);
    if (sink)
      for (const sp of ch.spans) {
        const ranges: HouseHandle['ranges'] = [];
        meshes.forEach((mesh, k) => {
          if (mesh && sp.to[k] > sp.from[k]) ranges.push({ mesh, start: sp.from[k], end: sp.to[k] });
        });
        sink.houses.push({ st: sp.st, cx: sp.st.x + sp.st.w / 2, cz: sp.st.y + sp.st.h / 2, gy: sp.gy, ranges });
      }
  }
  return out;
}

/** A garrison house of the Litani mouth: built here from the real buildings on its footprint (scenery.ts skips it). */
export function isVillageStructure(m: GameMap, st: Structure) {
  return !!m.deco?.village && LT_GARRISON_KINDS.has(st.kind);
}

/** One house: walls, its roof (slab or tiles), the clutter on it and its balconies. Returns its ground height. */
function house(m: GameMap, ch: Chunk, h: VHouse, minStoreys = 1): number {
  const qx = Math.round(h.x * 16);
  const qy = Math.round(h.y * 16);
  const r = (k: number) => hash2(qx + k * 131, qy, 5101 + k);
  const ca = Math.cos(h.ang);
  const sa = Math.sin(h.ang);
  // ground: the lowest of the footprint's corners and centre (the house steps down the slope on its terrace)
  let gy = surfaceHeight(m, h.x, h.y);
  for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) gy = Math.min(gy, surfaceHeight(m, h.x + sx * h.hl * ca - sz * h.hw * sa, h.y + sx * h.hl * sa + sz * h.hw * ca));
  const area = 4 * h.hl * h.hw;
  // two to four storeys mostly; the small ones (sheds, a single room) one or two
  const rs = r(1);
  let storeys = rs < 0.12 ? 1 : rs < 0.45 ? 2 : rs < 0.86 ? 3 : 4;
  if (area < 0.08) storeys = Math.min(storeys, 2);
  if (area > 0.5 && storeys < 3) storeys++;
  storeys = Math.max(storeys, minStoreys);
  const H = storeys * STOREY;
  const L = 2 * h.hl;
  const D = 2 * h.hw;
  // the house's frame: local x along its length, z across, y up from its floor
  const f = new THREE.Matrix4().compose(V(h.x, gy, h.y), new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), -h.ang), V(1, 1, 1));
  const wallC = C(WALLS[Math.floor(r(2) * WALLS.length)]).multiplyScalar(0.94 + r(3) * 0.08);
  // walls: from below the ground (the downhill side's plinth) to the roof, the window rows from the floor up
  const sink = 0.12;
  const wy = (H + sink) / 2 - sink;
  box(ch.walls, f, 0, wy, 0, L, H + sink, D, wallC, (lx, ly, face) => {
    const along = face < 2 ? L : D;
    const off = r(4);
    return face === 4 ? [0.04, 0.1] : [off + (lx * along) / (2 * BAY), ly ? H / STOREY : -sink / STOREY];
  });
  const roof = r(5);
  const top = H;
  if (roof < 0.32) {
    // a low hipped roof of clay tiles over the top floor, a little overhang
    const ov = 0.025;
    const rise = Math.min(0.09, D * 0.35);
    const x0 = -L / 2 - ov;
    const x1 = L / 2 + ov;
    const z0 = -D / 2 - ov;
    const z1 = D / 2 + ov;
    const rx = Math.max(0, L / 2 - D / 2);
    const tileC = C(TILES[Math.floor(r(6) * TILES.length)]).multiplyScalar(0.9 + r(7) * 0.15);
    const n3 = new THREE.Matrix3().getNormalMatrix(f);
    const P = (x: number, y: number, z: number) => V(x, y, z).applyMatrix4(f);
    const ridgeA = V(-rx, top + rise, 0);
    const ridgeB = V(rx, top + rise, 0);
    const eaves = [V(x0, top, z1), V(x1, top, z1), V(x1, top, z0), V(x0, top, z0)];
    const tri = (a: THREE.Vector3, b2: THREE.Vector3, c: THREE.Vector3) => {
      const cr = b2.clone().sub(a).cross(c.clone().sub(a));
      if (cr.lengthSq() < 1e-10) return; // (a square house: its hip ends meet at a point, the ridge has no length)
      const n = cr.normalize().applyMatrix3(n3).normalize();
      const ids = [a, b2, c].map((p) => ch.roofs.vert(P(p.x, p.y, p.z), n, (p.x + p.z) * 4, (p.y - top) * 12 + p.z * 4, tileC));
      ch.roofs.tri(ids[0], ids[1], ids[2]);
    };
    // front and back slopes (two triangles each), the hipped ends
    tri(eaves[0], eaves[1], ridgeB);
    tri(eaves[0], ridgeB, ridgeA);
    tri(eaves[2], eaves[3], ridgeA);
    tri(eaves[2], ridgeA, ridgeB);
    tri(eaves[1], eaves[2], ridgeB);
    tri(eaves[3], eaves[0], ridgeA);
    // (its underside at the eaves: a thin band of the wall colour so the overhang isn't see-through from below)
    box(ch.walls, f, 0, top - 0.006, 0, L + 2 * ov, 0.012, D + 2 * ov, wallC.clone().multiplyScalar(0.85));
  } else {
    // a flat concrete roof, its slab edge standing proud of the walls
    box(ch.walls, f, 0, top + 0.012, 0, L + 0.02, 0.024, D + 0.02, C(0xcbc6bb).multiplyScalar(0.92 + r(8) * 0.1));
    const ry = top + 0.024;
    // water tanks (one to three: black plastic, white, blue, beige), a solar water heater (a tilted panel and its
    // tank) on half of them, a stair head on some
    const nt = 1 + Math.floor(r(9) * 3);
    for (let k = 0; k < nt; k++) {
      const tx = (r(10 + k) - 0.5) * Math.max(0, L - 0.08);
      const tz = (r(13 + k) - 0.5) * Math.max(0, D - 0.08);
      drum(ch.detail, f, tx, ry, tz, 0.022, 0.04, C(TANKS[Math.floor(r(16 + k) * TANKS.length)]));
    }
    if (r(20) < 0.5 && L > 0.14) {
      const sx = (r(21) - 0.5) * (L - 0.12);
      const sz = -D / 2 + 0.05;
      const pm = f.clone().multiply(new THREE.Matrix4().compose(V(sx, ry + 0.025, sz), new THREE.Quaternion().setFromAxisAngle(V(1, 0, 0), -0.7), V(1, 1, 1)));
      box(ch.detail, pm, 0, 0, 0, 0.07, 0.004, 0.05, C(0x23314a));
      box(ch.detail, f, sx, ry + 0.045, sz + 0.03, 0.08, 0.018, 0.018, C(0xdedbd2));
    }
    if (r(22) < 0.4 && L > 0.16 && D > 0.12) box(ch.walls, f, L / 2 - 0.045, ry + 0.035, D / 2 - 0.045, 0.07, 0.07, 0.07, wallC, () => [0.04, 0.1]);
    // the next storey still to come: its columns, rebar sticking out of them
    if (roof > 0.86 && L > 0.16) {
      const rebar = C(0x5a4a3c);
      const col = C(0xb3ada2);
      for (const [cx, cz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const px = cx * (L / 2 - 0.015);
        const pz = cz * (D / 2 - 0.015);
        box(ch.detail, f, px, ry + 0.03, pz, 0.022, 0.06, 0.022, col);
        box(ch.detail, f, px, ry + 0.075, pz, 0.004, 0.03, 0.004, rebar);
      }
    }
  }
  // balconies along the long side on the upper floors: a slab and an iron railing
  if (storeys >= 2 && r(25) < 0.65 && L > 0.14) {
    const bw = L * (0.55 + r(26) * 0.35);
    const bx = (r(27) - 0.5) * (L - bw);
    const sides = r(28) < 0.35 ? [-1, 1] : [r(29) < 0.5 ? -1 : 1];
    const rail = C(r(30) < 0.5 ? 0x2e2e30 : 0xd8d6d0);
    for (const s of sides)
      for (let k = 1; k < storeys; k++) {
        const y = k * STOREY;
        box(ch.detail, f, bx, y + 0.006, s * (D / 2 + 0.018), bw, 0.012, 0.036, C(0xd5d0c6));
        box(ch.detail, f, bx, y + 0.028, s * (D / 2 + 0.035), bw, 0.032, 0.003, rail);
      }
  }
  return gy;
}
