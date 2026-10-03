#!/usr/bin/env node
/*
 * Offline baker for the photoscanned map props (web/public/props/).
 *
 *   node tools/bake-props.mjs        (needs curl and ImageMagick `convert` with WebP support,
 *                                     plus the devDependencies @gltf-transform/* and meshoptimizer)
 *
 * Downloads CC0 models from Poly Haven (glTF, 1k textures) and one CC0 fabric
 * from ambientCG (cached in $PROPS_CACHE or the OS temp dir), and turns them
 * into a small set of game-ready battlefield props (barrels, crates, cars,
 * barriers, lamps, benches, bins...) that all share ONE material:
 *
 *  - geometry: the parts of each model are merged into a single primitive,
 *    re-centred (base at y = 0, centred on x / z, long axis along +x) and
 *    scaled to the game's unit scale (props match the enlarged units, not real
 *    metres: see `mpu`, world units per metre), then welded, deduplicated and
 *    simplified with meshoptimizer to <= 1.5k triangles (LOD0) and <= 300
 *    (LOD1, used when zoomed out). A few props are built procedurally here
 *    (sandbag walls, Czech hedgehogs, dumpsters, bollards, pallets) or composed
 *    from scanned parts (log piles, tyre stacks), textured with sub-rects of the
 *    scans so they need no extra texture.
 *  - textures: every material's albedo / normal / ARM (AO, roughness, metal)
 *    map is resized and packed into three shared atlases (5 x 4 cells, small
 *    props use quarter cells, 1/32 edge-extended padding against mip bleeding),
 *    at two sizes: 256 px cells (phones / medium) and 512 px cells (high).
 *    UVs are remapped into the atlas (glTF convention: v runs down the image,
 *    textures load with flipY = false), so every prop instances with the same
 *    material.
 *  - output: props.glb (KHR_mesh_quantization + EXT_meshopt_compression; mesh
 *    "<id>" = LOD0, "<id>.lod1" = LOD1), props-{albedo,normal,orm}-{256,512}.webp,
 *    props.json (atlas layout, per-prop footprint / height / biomes /
 *    destructibility, download size per tier) and CREDITS.txt.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';
import { Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { dedup, weld, simplifyPrimitive, meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'public', 'props');
const CACHE = process.env.PROPS_CACHE || join(os.tmpdir(), 'ironfront-props-cache');
const TMP = join(os.tmpdir(), 'ironfront-props-bake');
const COLS = 5;
const ROWS = 4;
const SIZES = [256, 512];
/** Padding as a fraction of the slot size (edge-extended). */
const PAD = 1 / 32;
const MAX_TRIS = 1500;
const MAX_TRIS_LOD1 = 300;

// ------------------------------------------------------------------ sources

/** Poly Haven models (https://polyhaven.com/a/<id>), all CC0. */
const PH = [
  'Barrel_01', 'Barrel_02', 'barrel_03', 'barrel_stove', 'metal_jerrycan_green', 'propane_tank', 'wooden_crate_02', 'old_military_crate',
  'wine_barrel_01', 'old_tyre', 'dead_tree_trunk', 'tree_stump_01', 'covered_car', 'concrete_road_barrier', 'concrete_road_barrier_02',
  'portable_generator', 'street_lamp_01', 'modular_street_seating', 'metal_trash_can', 'trashbag', 'utility_box_02', 'fire_hydrant',
];
/** ambientCG materials (https://ambientcg.com/view?id=<id>), CC0. */
const ACG = ['Fabric045'];

/**
 * Atlas slots: one per source material. `q` = quarter cell (small props).
 * `tint` multiplies the albedo (sRGB), e.g. the grey fabric dyed burlap.
 */
const SLOTS = [
  { key: 'Barrel_01/Barrel_01' },
  { key: 'Barrel_02/Barrel_02' },
  { key: 'barrel_03/barrel_03' },
  { key: 'barrel_stove/barrel_stove' },
  { key: 'wooden_crate_02/wooden_crate_02' },
  { key: 'old_military_crate/military_crate_m_01' },
  { key: 'wine_barrel_01/wine_barrel_01' },
  { key: 'dead_tree_trunk/dead_tree_trunk' },
  { key: 'tree_stump_01/tree_stump_01' },
  { key: 'covered_car/covered_car' },
  { key: 'concrete_road_barrier/concrete_road_barrier' },
  { key: 'concrete_road_barrier_02/concrete_road_barrier_02' },
  { key: 'portable_generator/portable_generator' },
  { key: 'street_lamp_01/street_lamp_01' },
  { key: 'metal_trash_can/metal_trash_can' },
  { key: 'utility_box_02/utility_box_02' },
  { key: 'Fabric045', acg: true, tint: [0.86, 0.74, 0.53] },
  { key: 'metal_jerrycan_green/metal_jerrycan_green', q: true },
  { key: 'propane_tank/propane_tank', q: true },
  { key: 'old_tyre/old_tyre', q: true },
  { key: 'trashbag/trashbag', q: true },
  { key: 'fire_hydrant/fire_hydrant_aged', q: true },
  { key: 'modular_street_seating/modular_street_seating_armrests', q: true },
  { key: 'modular_street_seating/modular_street_seating_supports', q: true },
  { key: 'modular_street_seating/modular_street_seating_timber', q: true },
];

/** Sub-rects of scans reused by the procedural props (source uv, glTF convention). */
const SUB = {
  rust: ['barrel_stove/barrel_stove', [0.02, 0.56, 0.58, 0.95]],
  greenPaint: ['utility_box_02/utility_box_02', [0.06, 0.62, 0.37, 0.95]],
  tarp: ['covered_car/covered_car', [0.36, 0.2, 0.5, 0.75]],
  concrete: ['concrete_road_barrier/concrete_road_barrier', [0.04, 0.02, 0.3, 0.24]],
  planks: ['wooden_crate_02/wooden_crate_02', [0.19, 0.32, 0.44, 0.95]],
  fabric: ['Fabric045', [0, 0, 1, 1]],
};

/**
 * The props. mpu = world units per metre (vehicles are drawn x1.25 and
 * infantry x1.4 in renderer.ts; small clutter matches the infantry, cars the
 * vehicles). nodes / drop filter the source model's nodes / materials; rotY
 * turns the long axis onto +x. tris = LOD0 budget. kind drives the runtime
 * destruction: small (crushed flat, thrown about), big (crushed / shoved by
 * vehicles), tall (topples), fixed (never moves; blasts only char it).
 */
const PROPS = [
  { id: 'drum_red', src: 'Barrel_01', mpu: 0.22, tris: 700, kind: 'small', biomes: ['temperate', 'desert'], shadow: true },
  { id: 'drum_blue', src: 'barrel_03', mpu: 0.21, tris: 700, kind: 'small', biomes: ['temperate', 'desert', 'winter'], shadow: true },
  { id: 'drum_rust', src: 'barrel_stove', mpu: 0.22, tris: 800, kind: 'small', biomes: ['desert', 'winter', 'urban'], shadow: true },
  { id: 'drum_plastic', src: 'Barrel_02', mpu: 0.21, tris: 700, kind: 'small', biomes: ['urban', 'temperate'], shadow: true },
  { id: 'jerrycan', src: 'metal_jerrycan_green', nodes: ['metal_jerrycan_green_body', 'metal_jerrycan_green_cap'], mpu: 0.24, tris: 500, kind: 'small', biomes: ['desert', 'temperate', 'winter'] },
  { id: 'propane', src: 'propane_tank', mpu: 0.23, tris: 600, kind: 'small', biomes: ['desert'] },
  { id: 'crate_long', src: 'wooden_crate_02', rotY: Math.PI / 2, mpu: 0.22, tris: 600, kind: 'small', biomes: ['temperate', 'winter'], shadow: true },
  { id: 'crate_ammo', src: 'old_military_crate', nodes: ['old_military_crate_a', 'old_military_crate_lid_a', 'old_military_crate_latch_a', 'old_military_crate_loop_a'], mpu: 0.22, tris: 800, kind: 'small', biomes: ['temperate', 'desert', 'winter', 'urban'], shadow: true },
  { id: 'barrel_wood', src: 'wine_barrel_01', mpu: 0.22, tris: 800, kind: 'small', biomes: ['temperate', 'winter'], shadow: true },
  { id: 'tyre', src: 'old_tyre', mpu: 0.22, tris: 500, kind: 'small', biomes: ['temperate', 'desert', 'winter'] },
  { id: 'tyre_stack', compose: 'tyreStack', mpu: 0.22, tris: 1200, kind: 'small', biomes: ['winter', 'desert'], shadow: true },
  { id: 'woodpile', compose: 'woodpile', mpu: 0.2, tris: 1500, kind: 'big', biomes: ['winter', 'temperate'], shadow: true },
  { id: 'stump', src: 'tree_stump_01', mpu: 0.17, tris: 900, kind: 'fixed', biomes: ['winter', 'temperate'] },
  { id: 'car_covered', src: 'covered_car', rotY: Math.PI / 2, mpu: 0.155, tris: 1500, kind: 'big', biomes: ['temperate', 'desert', 'winter', 'urban'], shadow: true },
  { id: 'barrier', src: 'concrete_road_barrier', mpu: 0.22, tris: 900, kind: 'big', biomes: ['temperate', 'desert', 'urban'], shadow: true },
  { id: 'block', src: 'concrete_road_barrier_02', mpu: 0.2, tris: 900, kind: 'big', biomes: ['desert', 'urban'], shadow: true },
  { id: 'generator', src: 'portable_generator', drop: ['portable_generator_glass'], mpu: 0.22, tris: 1200, kind: 'big', biomes: ['temperate', 'desert'], shadow: true },
  { id: 'lamp', src: 'street_lamp_01', drop: ['street_lamp_01_glass', 'street_lamp_01_bulb'], mpu: 0.19, tris: 1200, kind: 'tall', biomes: ['urban'], shadow: true },
  {
    id: 'bench',
    src: 'modular_street_seating',
    nodes: ['crossbar', 'legs_single', 'legs_double', 'suspended_support_01', 'back_support_r', 'back_support_l', 'arm_rest_01', 'arm_rest_02', 'seat', 'seat_back'],
    mpu: 0.2,
    tris: 1000,
    kind: 'big',
    biomes: ['urban'],
  },
  { id: 'bin', src: 'metal_trash_can', nodes: ['metal_trash_can', 'metal_trash_can_handle_left', 'metal_trash_can_handle_right'], mpu: 0.22, tris: 700, kind: 'small', biomes: ['urban'], shadow: true },
  { id: 'trashbag', src: 'trashbag', mpu: 0.22, tris: 400, kind: 'small', biomes: ['urban'] },
  { id: 'utility_box', src: 'utility_box_02', rotY: 0, mpu: 0.21, tris: 600, kind: 'big', biomes: ['urban'], shadow: true },
  { id: 'hydrant', src: 'fire_hydrant', nodes: ['fire_hydrant_aged', 'fire_hydrant_cap_01_aged', 'fire_hydrant_cap_02_aged', 'fire_hydrant_cap_03_aged'], mpu: 0.22, tris: 600, kind: 'small', biomes: ['urban'] },
  { id: 'sandbags', proc: 'sandbags', mpu: 0.25, tris: 1300, kind: 'big', biomes: ['temperate', 'desert', 'winter', 'urban'], shadow: true },
  { id: 'hedgehog', proc: 'hedgehog', mpu: 0.22, tris: 300, kind: 'big', biomes: ['temperate', 'winter', 'urban'], shadow: true },
  { id: 'dumpster', proc: 'dumpster', mpu: 0.2, tris: 400, kind: 'big', biomes: ['urban'], shadow: true },
  { id: 'bollard', proc: 'bollard', mpu: 0.22, tris: 120, kind: 'fixed', biomes: ['urban'] },
  { id: 'pallets', proc: 'pallets', mpu: 0.22, tris: 900, kind: 'small', biomes: ['temperate', 'desert', 'winter', 'urban'], shadow: true },
];

// ------------------------------------------------------------------ helpers

const sh = (cmd, args) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 1 << 28 });
const fileSize = (p) => statSync(p).size;

function curl(url, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  sh('curl', ['-sSfL', '--retry', '3', '-A', 'IronFront-props-baker/1.0 (offline asset prep)', '-o', dest, url]);
}

async function download() {
  for (const id of PH) {
    const dir = join(CACHE, id);
    const gltf = join(dir, `${id}.gltf`);
    if (existsSync(gltf)) continue;
    console.log('download', id);
    const meta = join(dir, 'files.json');
    curl(`https://api.polyhaven.com/files/${id}`, meta);
    const g = JSON.parse(readFileSync(meta, 'utf8')).gltf['1k'].gltf;
    for (const [rel, f] of Object.entries(g.include)) curl(f.url, join(dir, rel));
    curl(g.url, gltf);
  }
  for (const id of ACG) {
    const dir = join(CACHE, id);
    if (existsSync(join(dir, `${id}_1K-JPG_Color.jpg`))) continue;
    console.log('download', id);
    const zip = join(dir, 'src.zip');
    curl(`https://ambientcg.com/get?file=${id}_1K-JPG.zip`, zip);
    sh('unzip', ['-o', '-q', zip, '-d', dir]);
  }
}

// ------------------------------------------------------------------ atlas layout

/** Assign every slot a rect (normalised atlas coords, padding excluded). */
function layoutSlots() {
  const rects = new Map();
  let cell = 0;
  const cellXY = (c) => [c % COLS, Math.floor(c / COLS)];
  for (const s of SLOTS.filter((s) => !s.q)) {
    const [cx, cy] = cellXY(cell++);
    rects.set(s.key, { slot: s, x: cx / COLS, y: cy / ROWS, w: 1 / COLS, h: 1 / ROWS });
  }
  const quarters = SLOTS.filter((s) => s.q);
  for (let i = 0; i < quarters.length; i++) {
    if (i % 4 === 0) cell++;
    const [cx, cy] = cellXY(cell - 1);
    const qx = i % 2;
    const qy = Math.floor((i % 4) / 2);
    rects.set(quarters[i].key, { slot: quarters[i], x: (cx + qx * 0.5) / COLS, y: (cy + qy * 0.5) / ROWS, w: 0.5 / COLS, h: 0.5 / ROWS });
  }
  if (cell > COLS * ROWS) throw new Error(`atlas overflow: ${cell} cells`);
  for (const r of rects.values()) {
    // inner (padded) rect
    r.ix = r.x + r.w * PAD;
    r.iy = r.y + r.h * PAD;
    r.iw = r.w * (1 - 2 * PAD);
    r.ih = r.h * (1 - 2 * PAD);
  }
  return { rects, cells: cell };
}

/** Map a source uv into a slot (optionally through a sub-rect of the source texture). */
function remapUV(r, u, v, sub) {
  if (sub) {
    u = sub[0] + (sub[2] - sub[0]) * u;
    v = sub[1] + (sub[3] - sub[1]) * v;
  }
  u = Math.min(1, Math.max(0, u));
  v = Math.min(1, Math.max(0, v));
  return [r.ix + r.iw * u, r.iy + r.ih * v];
}

// ------------------------------------------------------------------ textures

/** Texture files (albedo, normal, arm) of each slot. */
function slotFiles(doc, srcId) {
  const out = new Map();
  for (const m of doc.getRoot().listMaterials()) {
    const uri = (t) => (t ? join(CACHE, srcId, t.getURI()) : null);
    out.set(`${srcId}/${m.getName()}`, {
      albedo: uri(m.getBaseColorTexture()),
      normal: uri(m.getNormalTexture()),
      arm: uri(m.getMetallicRoughnessTexture()) ?? uri(m.getOcclusionTexture()),
      metal: m.getMetallicFactor(),
      rough: m.getRoughnessFactor(),
    });
  }
  return out;
}

function bakeAtlases(rects, files) {
  mkdirSync(TMP, { recursive: true });
  const results = {};
  for (const S of SIZES) {
    const W = COLS * S;
    const H = ROWS * S;
    const layers = { albedo: [], normal: [], orm: [] };
    for (const r of rects.values()) {
      const key = r.slot.key;
      const px = Math.round(r.x * W);
      const py = Math.round(r.y * H);
      const sz = Math.round(r.w * W);
      const pad = Math.round(sz * PAD);
      const inner = sz - 2 * pad;
      let src;
      if (r.slot.acg) {
        const base = join(CACHE, key, `${key}_1K-JPG`);
        const orm = join(TMP, `${key}-orm.png`);
        if (!existsSync(orm)) sh('convert', [`${base}_AmbientOcclusion.jpg`, `${base}_Roughness.jpg`, '(', `${base}_Roughness.jpg`, '-evaluate', 'set', '0', ')', '-colorspace', 'sRGB', '-combine', orm]);
        src = { albedo: `${base}_Color.jpg`, normal: `${base}_NormalGL.jpg`, arm: orm };
      } else {
        src = files.get(key);
        if (!src) throw new Error(`no textures for ${key}`);
      }
      for (const [layer, file] of [['albedo', src.albedo], ['normal', src.normal], ['orm', src.arm]]) {
        const tile = join(TMP, `${key.replace(/\//g, '_')}-${layer}-${sz}.png`);
        const args = [file, '-resize', `${inner}x${inner}!`];
        // materials with metallicFactor 0 ship a meaningless metal channel: clear it
        if (layer === 'orm' && !r.slot.acg && src.metal === 0) args.push('-channel', 'B', '-evaluate', 'set', '0', '+channel');
        if (layer === 'albedo' && r.slot.tint) {
          const [tr, tg, tb] = r.slot.tint;
          args.push('-channel', 'R', '-evaluate', 'multiply', String(tr), '-channel', 'G', '-evaluate', 'multiply', String(tg), '-channel', 'B', '-evaluate', 'multiply', String(tb), '+channel');
        }
        // edge-extend the padding so mip levels don't pull in the neighbours
        args.push('-set', 'option:distort:viewport', `${sz}x${sz}-${pad}-${pad}`, '-virtual-pixel', 'Edge', '-distort', 'SRT', '0', '+repage', '-alpha', 'off', tile);
        sh('convert', args);
        layers[layer].push([tile, px, py]);
      }
    }
    results[S] = {};
    for (const [layer, tiles] of Object.entries(layers)) {
      const bg = layer === 'normal' ? 'rgb(128,128,255)' : layer === 'orm' ? 'rgb(255,200,0)' : 'rgb(110,104,96)';
      const name = `props-${layer}-${S}.webp`;
      const args = ['-size', `${W}x${H}`, `xc:${bg}`];
      for (const [t, x, y] of tiles) args.push(t, '-geometry', `+${x}+${y}`, '-composite');
      // normals and ARM data compress well enough at a lower quality than the albedo
      args.push('-alpha', 'off', '-define', 'webp:method=6', '-quality', layer === 'albedo' ? '82' : layer === 'normal' ? '78' : '70', join(OUT, name));
      sh('convert', args);
      results[S][layer] = name;
    }
    results[S].bytes = Object.values(results[S]).reduce((a, n) => a + fileSize(join(OUT, n)), 0);
  }
  return results;
}

// ------------------------------------------------------------------ geometry

/** Plain mesh arrays (metres while building). */
class Geo {
  pos = [];
  nor = [];
  uv = [];
  idx = [];
  get count() {
    return this.pos.length / 3;
  }
  add(o, m = null) {
    const base = this.count;
    for (let i = 0; i < o.pos.length / 3; i++) {
      let [x, y, z] = [o.pos[i * 3], o.pos[i * 3 + 1], o.pos[i * 3 + 2]];
      let [nx, ny, nz] = [o.nor[i * 3], o.nor[i * 3 + 1], o.nor[i * 3 + 2]];
      if (m) {
        [x, y, z] = xf(m, x, y, z, 1);
        [nx, ny, nz] = xf(m, nx, ny, nz, 0);
        const l = Math.hypot(nx, ny, nz) || 1;
        nx /= l;
        ny /= l;
        nz /= l;
      }
      this.pos.push(x, y, z);
      this.nor.push(nx, ny, nz);
      this.uv.push(o.uv[i * 2], o.uv[i * 2 + 1]);
    }
    for (const i of o.idx) this.idx.push(base + i);
    return this;
  }
  bounds() {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < this.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        mn[k] = Math.min(mn[k], this.pos[i + k]);
        mx[k] = Math.max(mx[k], this.pos[i + k]);
      }
    return { mn, mx };
  }
}

/** Column-major 4x4 (glTF) transform of a point (w = 1) or direction (w = 0, uses the inverse transpose for normals when non-uniform: our transforms are rotation + uniform scale + translation). */
function xf(m, x, y, z, w) {
  return [m[0] * x + m[4] * y + m[8] * z + m[12] * w, m[1] * x + m[5] * y + m[9] * z + m[13] * w, m[2] * x + m[6] * y + m[10] * z + m[14] * w];
}
function mat(rx = 0, ry = 0, rz = 0, tx = 0, ty = 0, tz = 0, s = 1) {
  // R = Ry * Rx * Rz
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz);
  const Rx = [1, 0, 0, 0, cx, sx, 0, -sx, cx];
  const Ry = [cy, 0, -sy, 0, 1, 0, sy, 0, cy];
  const Rz = [cz, sz, 0, -sz, cz, 0, 0, 0, 1];
  const mul3 = (a, b) => {
    const o = new Array(9).fill(0);
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) o[c * 3 + r] += a[k * 3 + r] * b[c * 3 + k];
    return o;
  };
  const R = mul3(mul3(Ry, Rx), Rz);
  return [R[0] * s, R[1] * s, R[2] * s, 0, R[3] * s, R[4] * s, R[5] * s, 0, R[6] * s, R[7] * s, R[8] * s, 0, tx, ty, tz, 1];
}

/** Load a model's selected nodes as one Geo with atlas uvs. */
async function loadModel(io, srcId, rects, { nodes, drop } = {}) {
  const doc = await io.read(join(CACHE, srcId, `${srcId}.gltf`));
  const g = new Geo();
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    if (nodes && !nodes.includes(node.getName())) continue;
    const wm = node.getWorldMatrix();
    for (const p of mesh.listPrimitives()) {
      const mname = p.getMaterial()?.getName();
      if (drop?.includes(mname)) continue;
      const r = rects.get(`${srcId}/${mname}`);
      if (!r) throw new Error(`${srcId}: material ${mname} has no atlas slot`);
      const P = p.getAttribute('POSITION');
      const N = p.getAttribute('NORMAL');
      const T = p.getAttribute('TEXCOORD_0');
      const I = p.getIndices();
      const o = { pos: [], nor: [], uv: [], idx: [] };
      const a = [];
      for (let i = 0; i < P.getCount(); i++) {
        o.pos.push(...P.getElement(i, a));
        o.nor.push(...N.getElement(i, a));
        const [u, v] = T.getElement(i, a);
        o.uv.push(...remapUV(r, u, v));
      }
      if (I) for (let i = 0; i < I.getCount(); i++) o.idx.push(I.getScalar(i));
      else for (let i = 0; i < P.getCount(); i++) o.idx.push(i);
      // mirrored node transforms flip the winding
      const det = wm[0] * (wm[5] * wm[10] - wm[6] * wm[9]) - wm[4] * (wm[1] * wm[10] - wm[2] * wm[9]) + wm[8] * (wm[1] * wm[6] - wm[2] * wm[5]);
      if (det < 0) for (let i = 0; i < o.idx.length; i += 3) [o.idx[i + 1], o.idx[i + 2]] = [o.idx[i + 2], o.idx[i + 1]];
      g.add(o, wm);
    }
  }
  return { geo: g, files: slotFiles(doc, srcId) };
}

/** Re-centre (base y = 0, centred on x / z), turn and scale to world units. */
function normalise(g, rotY, mpu) {
  if (rotY) {
    const m = mat(0, rotY);
    const t = new Geo().add(g, m);
    g.pos = t.pos;
    g.nor = t.nor;
  }
  const { mn, mx } = g.bounds();
  const cx = (mn[0] + mx[0]) / 2;
  const cz = (mn[2] + mx[2]) / 2;
  for (let i = 0; i < g.pos.length; i += 3) {
    g.pos[i] = (g.pos[i] - cx) * mpu;
    g.pos[i + 1] = (g.pos[i + 1] - mn[1]) * mpu;
    g.pos[i + 2] = (g.pos[i + 2] - cz) * mpu;
  }
  return g;
}

// --- procedural primitives (metres, local uv 0..1 mapped through a sub-rect)

function quadStrip(o, pts, n, uvs) {
  const b = o.pos.length / 3;
  for (let k = 0; k < 4; k++) {
    o.pos.push(...pts[k]);
    o.nor.push(...n);
    o.uv.push(...uvs[k]);
  }
  o.idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
}

/** Axis-aligned box (centre c, size s) with per-face uv spanning the texture by world size / `tile` metres. */
function box(c, s, tile = 1, uvOff = [0, 0]) {
  const o = { pos: [], nor: [], uv: [], idx: [] };
  const [x, y, z] = c;
  const [hx, hy, hz] = s.map((v) => v / 2);
  const faces = [
    [[1, 0, 0], [[x + hx, y - hy, z + hz], [x + hx, y - hy, z - hz], [x + hx, y + hy, z - hz], [x + hx, y + hy, z + hz]], [s[2], s[1]]],
    [[-1, 0, 0], [[x - hx, y - hy, z - hz], [x - hx, y - hy, z + hz], [x - hx, y + hy, z + hz], [x - hx, y + hy, z - hz]], [s[2], s[1]]],
    [[0, 1, 0], [[x - hx, y + hy, z + hz], [x + hx, y + hy, z + hz], [x + hx, y + hy, z - hz], [x - hx, y + hy, z - hz]], [s[0], s[2]]],
    [[0, -1, 0], [[x - hx, y - hy, z - hz], [x + hx, y - hy, z - hz], [x + hx, y - hy, z + hz], [x - hx, y - hy, z + hz]], [s[0], s[2]]],
    [[0, 0, 1], [[x - hx, y - hy, z + hz], [x + hx, y - hy, z + hz], [x + hx, y + hy, z + hz], [x - hx, y + hy, z + hz]], [s[0], s[1]]],
    [[0, 0, -1], [[x + hx, y - hy, z - hz], [x - hx, y - hy, z - hz], [x - hx, y + hy, z - hz], [x + hx, y + hy, z - hz]], [s[0], s[1]]],
  ];
  for (const [n, p, [w, h]] of faces) {
    const u1 = Math.min(1, w / tile);
    const v1 = Math.min(1, h / tile);
    const [ou, ov] = uvOff;
    quadStrip(o, p, n, [[ou, ov + v1], [ou + u1, ov + v1], [ou + u1, ov], [ou, ov]].map(([u, v]) => [Math.min(1, u), Math.min(1, v)]));
  }
  return o;
}

/** Superellipsoid "pillow" (a filled sack), size a x b x c (half extents), exponents e. */
function pillow(a, b, c, nu, nv, e = 0.35) {
  const o = { pos: [], nor: [], uv: [], idx: [] };
  const sp = (w, m) => Math.sign(Math.cos(w)) * Math.pow(Math.abs(Math.cos(w)), m);
  const ss = (w, m) => Math.sign(Math.sin(w)) * Math.pow(Math.abs(Math.sin(w)), m);
  for (let j = 0; j <= nv; j++) {
    const phi = -Math.PI / 2 + (Math.PI * j) / nv;
    for (let i = 0; i <= nu; i++) {
      const th = -Math.PI + (2 * Math.PI * i) / nu;
      const x = a * sp(phi, e) * sp(th, e);
      const z = c * sp(phi, e) * ss(th, e);
      const y = b * ss(phi, e * 1.6);
      o.pos.push(x, y, z);
      // normal of the implicit surface (approximate, fine for a sack)
      const nx = (sp(phi, 2 - e) * sp(th, 2 - e)) / a;
      const nz = (sp(phi, 2 - e) * ss(th, 2 - e)) / c;
      const ny = ss(phi, 2 - e * 1.6) / b;
      const l = Math.hypot(nx, ny, nz) || 1;
      o.nor.push(nx / l, ny / l, nz / l);
      o.uv.push(i / nu, j / nv);
    }
  }
  for (let j = 0; j < nv; j++)
    for (let i = 0; i < nu; i++) {
      const a0 = j * (nu + 1) + i;
      const b0 = a0 + nu + 1;
      o.idx.push(a0, b0, a0 + 1, a0 + 1, b0, b0 + 1);
    }
  return o;
}

function cylinder(r0, r1, h, n, y0 = 0, cap = true) {
  const o = { pos: [], nor: [], uv: [], idx: [] };
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a);
    const s = Math.sin(a);
    const slope = (r0 - r1) / h;
    const l = Math.hypot(1, slope);
    o.pos.push(c * r0, y0, s * r0, c * r1, y0 + h, s * r1);
    o.nor.push(c / l, slope / l, s / l, c / l, slope / l, s / l);
    o.uv.push(i / n, 1, i / n, 0);
  }
  for (let i = 0; i < n; i++) o.idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 2, i * 2 + 1, i * 2 + 3);
  if (cap) {
    const b = o.pos.length / 3;
    o.pos.push(0, y0 + h, 0);
    o.nor.push(0, 1, 0);
    o.uv.push(0.5, 0.5);
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * Math.PI * 2;
      o.pos.push(Math.cos(a) * r1, y0 + h, Math.sin(a) * r1);
      o.nor.push(0, 1, 0);
      o.uv.push(0.5 + Math.cos(a) * 0.5, 0.5 + Math.sin(a) * 0.5);
    }
    for (let i = 0; i < n; i++) o.idx.push(b, b + 2 + i, b + 1 + i);
  }
  return o;
}

/** Apply a sub-rect mapping to a primitive's local uvs. */
function mapped(o, rects, subName) {
  const [key, sub] = SUB[subName];
  const r = rects.get(key);
  const uv = [];
  for (let i = 0; i < o.uv.length; i += 2) uv.push(...remapUV(r, o.uv[i], o.uv[i + 1], sub));
  return { ...o, uv };
}

const PROC = {
  /** A short sandbag wall: 4 courses of 3 bags in a running bond (~1.9 m long, 0.6 m high). */
  sandbags(rects, lod) {
    const g = new Geo();
    const [nu, nv] = lod ? [6, 2] : [10, 4];
    let k = 0;
    for (let row = 0; row < 4; row++) {
      const off = row % 2 ? 0.3 : 0;
      for (let i = 0; i < 3; i++) {
        k++;
        const jit = (Math.sin(k * 12.9898) * 43758.5453) % 1;
        const x = -0.6 + i * 0.62 + off - (row % 2 ? 0.15 : 0);
        const bag = pillow(0.3, 0.085, 0.19 - row * 0.012, nu, nv);
        g.add(mapped(bag, rects, 'fabric'), mat(0, jit * 0.12, jit * 0.04, x, 0.075 + row * 0.15, (row % 2 ? 0.02 : -0.01) + row * -0.015));
      }
    }
    return g;
  },
  /** Czech hedgehog: three angle-iron beams crossed at their middles, standing on three legs. */
  hedgehog(rects) {
    const g = new Geo();
    const L = 1.8;
    const beam = new Geo();
    beam.add(mapped(box([0, 0, 0.03], [L, 0.012, 0.09], 0.6), rects, 'rust'));
    beam.add(mapped(box([0, 0.039, 0], [L, 0.09, 0.012], 0.6), rects, 'rust'));
    // beams along x, y and z, then the (1,1,1) diagonal turned upright
    const axes = [mat(0, 0, 0), mat(0, 0, Math.PI / 2), mat(0, Math.PI / 2, 0)];
    const tilt = Math.acos(1 / Math.sqrt(3));
    const up = (m) => {
      // rotate (1,1,1) onto +y: about (1,1,1) x (0,1,0) = (-1,0,1)/sqrt2 by `tilt`
      const ax = [-1 / Math.SQRT2, 0, 1 / Math.SQRT2];
      const c = Math.cos(tilt), s = Math.sin(tilt), t = 1 - c;
      const [x, y, z] = ax;
      const R = [t * x * x + c, t * x * y + s * z, t * x * z - s * y, 0, t * x * y - s * z, t * y * y + c, t * y * z + s * x, 0, t * x * z + s * y, t * y * z - s * x, t * z * z + c, 0, 0, 0, 0, 1];
      return mul4(R, m);
    };
    for (const a of axes) g.add(beam, up(a));
    return g;
  },
  /** Commercial waste container: tapered green steel body, black plastic lids, side ribs. */
  dumpster(rects) {
    const g = new Geo();
    g.add(mapped(box([0, 0.62, 0], [1.8, 1.04, 1.05], 1.2), rects, 'greenPaint'));
    g.add(mapped(box([0, 0.06, 0], [1.7, 0.12, 0.95], 1.2), rects, 'tarp'));
    for (const x of [-0.6, 0, 0.6]) g.add(mapped(box([x, 0.66, 0.54], [0.08, 0.9, 0.06], 1.2), rects, 'greenPaint'));
    for (const s of [-1, 1]) g.add(mapped(box([s * 0.44, 1.2, 0.02], [0.86, 0.06, 1.12], 1.2), rects, 'tarp'), mat(0.12, 0, 0));
    g.add(mapped(box([0, 0.95, -0.56], [1.84, 0.08, 0.08], 1.2), rects, 'greenPaint'));
    return g;
  },
  /** Concrete bollard with a domed top. */
  bollard(rects) {
    const g = new Geo();
    g.add(mapped(cylinder(0.17, 0.15, 0.7, 10, 0, false), rects, 'concrete'));
    g.add(mapped(cylinder(0.15, 0.06, 0.1, 10, 0.7, true), rects, 'concrete'));
    return g;
  },
  /** A small stack of wooden pallets (3-4), slightly askew. */
  pallets(rects, lod) {
    const g = new Geo();
    const pallet = new Geo();
    if (lod) pallet.add(mapped(box([0, 0.072, 0], [1.2, 0.144, 0.8], 1.2), rects, 'planks'));
    else {
      for (let i = 0; i < 5; i++) pallet.add(mapped(box([0, 0.136, -0.34 + i * 0.17], [1.2, 0.022, 0.12], 1.2), rects, 'planks'));
      for (const z of [-0.36, 0, 0.36]) pallet.add(mapped(box([0, 0.075, z], [1.2, 0.1, 0.09], 1.2, [0, 0.3]), rects, 'planks'));
      for (const z of [-0.34, 0, 0.34]) pallet.add(mapped(box([0, 0.011, z], [1.2, 0.022, 0.12], 1.2, [0, 0.5]), rects, 'planks'));
    }
    const n = 4;
    for (let i = 0; i < n; i++) g.add(pallet, mat(0, Math.sin(i * 7.1) * 0.08, 0, Math.sin(i * 3.3) * 0.03, i * 0.146, Math.cos(i * 5.7) * 0.03));
    return g;
  },
};

function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}

/** Props assembled from (pre-simplified) scanned parts. */
const COMPOSE = {
  /** Firewood: seven logs stacked 3 / 2 / 2 (sawn from the scanned trunk, ~2 m long). */
  async woodpile(io, rects, part) {
    const log = await part('dead_tree_trunk', 190, {}, 2 / 3.05);
    const g = new Geo();
    const rows = [
      [-0.27, 0, 0.27],
      [-0.135, 0.135],
      [0, 0.27],
    ];
    let k = 0;
    rows.forEach((zs, row) =>
      zs.forEach((z) => {
        k++;
        g.add(log, mat(0.6 * k, Math.sin(k * 2.7) * 0.06, 0, Math.sin(k * 1.9) * 0.08, 0.135 + row * 0.235, z - (row === 2 ? 0.135 : 0)));
      }),
    );
    return g;
  },
  /** Scrap tyres: three lying stacked, one leaning against them. */
  async tyreStack(io, rects, part) {
    const t = await part('old_tyre', 240);
    const g = new Geo();
    // the scanned tyre stands upright facing z; lay it flat
    for (let i = 0; i < 3; i++) g.add(t, mat(Math.PI / 2, i * 0.7, 0, Math.sin(i * 4.1) * 0.03, 0.08 + i * 0.16, Math.cos(i * 3.3) * 0.03));
    g.add(t, mat(-0.32, 0.4, 0, 0.36, 0.29, 0.12));
    return g;
  },
};

// ------------------------------------------------------------------ simplification

function toDoc(g) {
  const doc = new Document();
  const buf = doc.createBuffer();
  const prim = doc
    .createPrimitive()
    .setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buf))
    .setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(new Float32Array(g.nor)).setBuffer(buf))
    .setAttribute('TEXCOORD_0', doc.createAccessor().setType('VEC2').setArray(new Float32Array(g.uv)).setBuffer(buf))
    .setIndices(doc.createAccessor().setType('SCALAR').setArray(new Uint32Array(g.idx)).setBuffer(buf));
  doc.createNode().setMesh(doc.createMesh().addPrimitive(prim));
  doc.createScene().addChild(doc.getRoot().listNodes()[0]);
  return { doc, prim };
}

function fromPrim(prim) {
  const g = new Geo();
  g.pos = Array.from(prim.getAttribute('POSITION').getArray());
  g.nor = Array.from(prim.getAttribute('NORMAL').getArray());
  g.uv = Array.from(prim.getAttribute('TEXCOORD_0').getArray());
  g.idx = Array.from(prim.getIndices().getArray());
  return g;
}

const tris = (g) => g.idx.length / 3;

/** Weld + simplify to at most `budget` triangles (meshoptimizer; sloppy fallback for stubborn seams). */
async function simplifyTo(g, budget) {
  const { doc, prim } = toDoc(g);
  await doc.transform(weld(), dedup());
  let out = fromPrim(prim);
  if (tris(out) <= budget) return out;
  const src = tris(out);
  for (const error of [0.002, 0.006, 0.015, 0.04, 0.1]) {
    const { doc: d2, prim: p2 } = toDoc(out);
    await d2.transform(weld());
    simplifyPrimitive(p2, { simplifier: MeshoptSimplifier, ratio: (budget / src) * 0.98, error, lockBorder: false });
    const r = fromPrim(p2);
    if (tris(r) <= budget) return r;
    if (tris(r) < tris(out)) out = r;
  }
  // sloppy: ignores attribute seams (fine for the far LOD and the odd fragmented scan)
  const idx = new Uint32Array(out.idx);
  const pos = new Float32Array(out.pos);
  for (const err of [0.01, 0.03, 0.1, 1]) {
    const [res] = MeshoptSimplifier.simplifySloppy(idx, pos, 3, null, Math.floor((budget * 3) / 3) * 3, err);
    if (res.length / 3 <= budget && res.length > 0) {
      const r = new Geo();
      r.pos = out.pos;
      r.nor = out.nor;
      r.uv = out.uv;
      r.idx = Array.from(res);
      return compact(r);
    }
  }
  throw new Error(`cannot simplify to ${budget}`);
}

/** Drop unreferenced vertices. */
function compact(g) {
  const map = new Map();
  const o = new Geo();
  for (const i of g.idx) {
    if (!map.has(i)) {
      map.set(i, o.count);
      o.pos.push(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
      o.nor.push(g.nor[i * 3], g.nor[i * 3 + 1], g.nor[i * 3 + 2]);
      o.uv.push(g.uv[i * 2], g.uv[i * 2 + 1]);
    }
    o.idx.push(map.get(i));
  }
  return o;
}

// ------------------------------------------------------------------ main

async function main() {
  mkdirSync(OUT, { recursive: true });
  rmSync(TMP, { recursive: true, force: true });
  await download();
  await MeshoptSimplifier.ready;
  await MeshoptEncoder.ready;
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const { rects, cells } = layoutSlots();
  const files = new Map();
  const out = new Document();
  const buf = out.createBuffer();
  const scene = out.createScene();
  const manifest = { version: 1, cols: COLS, rows: ROWS, model: 'props.glb', atlas: {}, props: {}, tiers: {} };

  /** A scanned part, simplified to `budget` triangles, in metres (base at 0, centred), optionally rescaled. */
  const part = async (srcId, budget, opts = {}, scale = 1) => {
    const { geo, files: f } = await loadModel(io, srcId, rects, opts);
    for (const [k, v] of f) files.set(k, v);
    const g = normalise(geo, opts.rotY ?? 0, scale);
    return simplifyTo(g, budget);
  };

  const addMesh = (name, g) => {
    const prim = out
      .createPrimitive()
      .setAttribute('POSITION', out.createAccessor().setType('VEC3').setArray(new Float32Array(g.pos)).setBuffer(buf))
      .setAttribute('NORMAL', out.createAccessor().setType('VEC3').setArray(new Float32Array(g.nor)).setBuffer(buf))
      .setAttribute('TEXCOORD_0', out.createAccessor().setType('VEC2').setArray(new Float32Array(g.uv)).setBuffer(buf))
      .setIndices(out.createAccessor().setType('SCALAR').setArray(g.count > 65535 ? new Uint32Array(g.idx) : new Uint16Array(g.idx)).setBuffer(buf));
    scene.addChild(out.createNode(name).setMesh(out.createMesh(name).addPrimitive(prim)));
  };

  for (const p of PROPS) {
    let g;
    let lo = null;
    if (p.src) {
      const { geo, files: f } = await loadModel(io, p.src, rects, p);
      for (const [k, v] of f) files.set(k, v);
      g = normalise(geo, p.rotY ?? 0, p.mpu);
    } else if (p.compose) {
      g = normalise(await COMPOSE[p.compose](io, rects, part), 0, p.mpu);
    } else {
      g = normalise(PROC[p.proc](rects, false), 0, p.mpu);
      if (p.proc === 'sandbags' || p.proc === 'pallets') lo = normalise(PROC[p.proc](rects, true), 0, p.mpu);
    }
    const srcTris = tris(g);
    const lod0 = await simplifyTo(g, Math.min(p.tris, MAX_TRIS));
    const lod1 = await simplifyTo(lo ?? lod0, MAX_TRIS_LOD1);
    addMesh(p.id, lod0);
    addMesh(`${p.id}.lod1`, lod1);
    const { mn, mx } = lod0.bounds();
    const r3 = (v) => Math.round(v * 1000) / 1000;
    manifest.props[p.id] = {
      src: p.src ?? (p.compose ? `composed:${p.compose}` : `procedural:${p.proc}`),
      size: [r3(mx[0] - mn[0]), r3(mx[1] - mn[1]), r3(mx[2] - mn[2])],
      footprint: [r3(mx[0] - mn[0]), r3(mx[2] - mn[2])],
      height: r3(mx[1]),
      biomes: p.biomes,
      destructible: p.kind !== 'fixed',
      kind: p.kind,
      shadow: !!p.shadow,
      tris: [tris(lod0), tris(lod1)],
    };
    console.log(`${p.id.padEnd(13)} ${String(srcTris).padStart(7)} -> ${String(tris(lod0)).padStart(5)} / ${String(tris(lod1)).padStart(4)} tris   ${manifest.props[p.id].size.join(' x ')}`);
  }

  // load the remaining slots' texture lists (materials only used through sub-rects)
  for (const s of SLOTS) {
    if (s.acg || files.has(s.key)) continue;
    const id = s.key.split('/')[0];
    const doc = await io.read(join(CACHE, id, `${id}.gltf`));
    for (const [k, v] of slotFiles(doc, id)) files.set(k, v);
  }
  for (const [k, v] of files) if (rects.has(k) && v.rough !== 1) console.warn(`note: ${k} has roughness factor ${v.rough} (ignored)`);

  // geometry: quantised + meshopt compressed
  out.createExtension(KHRMeshQuantization).setRequired(true);
  await out.transform(dedup(), meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 14 }));
  const glb = await io.writeBinary(out);
  writeFileSync(join(OUT, 'props.glb'), glb);
  void EXTMeshoptCompression;

  console.log(`atlas: ${cells} of ${COLS * ROWS} cells`);
  manifest.atlas = bakeAtlases(rects, files);
  manifest.modelBytes = glb.byteLength;
  manifest.tiers = { medium: manifest.modelBytes + manifest.atlas[256].bytes, high: manifest.modelBytes + manifest.atlas[512].bytes };
  writeFileSync(join(OUT, 'props.json'), JSON.stringify(manifest, null, 1));
  writeCredits();
  const mb = (b) => (b / 1048576).toFixed(2) + ' MB';
  console.log(`props.glb ${mb(glb.byteLength)}; medium ${mb(manifest.tiers.medium)}, high ${mb(manifest.tiers.high)}`);
}

function writeCredits() {
  const lines = [
    'Iron Front map props (web/public/props/) - third-party assets',
    '',
    'All source models and textures below are licensed CC0 1.0 Universal (public domain dedication):',
    'https://creativecommons.org/publicdomain/zero/1.0/',
    'They were resized, simplified, re-UV-mapped into shared atlases and partly recombined by',
    'web/tools/bake-props.mjs. No attribution is legally required; we credit the authors anyway.',
    '',
    'Poly Haven (https://polyhaven.com) models:',
    ...PH.map((id) => `  ${id.padEnd(28)} https://polyhaven.com/a/${id}`),
    '',
    'ambientCG (https://ambientcg.com) materials:',
    ...ACG.map((id) => `  ${id.padEnd(28)} https://ambientcg.com/view?id=${id}`),
    '',
    'Procedural props (sandbags, hedgehogs, dumpsters, bollards, pallets) are generated by the bake',
    'script and textured with parts of the scans above.',
    '',
  ];
  writeFileSync(join(OUT, 'CREDITS.txt'), lines.join('\n'));
}

await main();
