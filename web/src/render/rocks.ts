import * as THREE from 'three';
import { phoneCaps } from './devicecaps';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { Tile, groundHeight, type GameMap } from '../sim/map';
import { hash2, valueNoise } from '../sim/rng';
import type { FogOfWar } from './fog';
import { CulledInstances, type Inst, type SceneryLod } from './geo';
import { surfaceHeight } from './ground';
import { OCC_BUILT, OCC_FIELD, OCC_ROAD, OCC_TRACK, occAt, type Layout } from './layout';
import { rockTexture } from './terraintex';
import { buildRelief, canyonMask, reliefEnabled, reliefField, reliefHeight } from './relief';
import { loadRockKit, rockKitMaterial, type KitKey } from './rockkit';
import { strataMean } from './strata';
import { PHOTO_MATERIALS } from './terrainset';
import { assetBase, fetchBitmap } from './photoground';
import { landmarkClear } from './landmarks/plan';
import { inKeepOut, oreKeepOut } from './orefield';

/*
 * Natural rock: displaced, smooth-shaded icospheres with crevice darkening and
 * moss on top, laid along the ridges as cliff-like outcrops, plus scree,
 * riverbank stones and the odd field stone.
 *
 * Medium / high quality swap the procedural shapes for four CC0 photoscanned
 * rocks once they have streamed in (public/tex/rocks, baked and decimated by
 * tools/bake-rocks.mjs): same instancing, culling and LOD, the geometries are
 * replaced in place and the material becomes the scans' shared texture atlas,
 * graded per biome (grey and mossy in the temperate valley, warm sandstone in
 * the desert, cold granite under the winter snow, pale city stone).
 */

function noise3(x: number, y: number, z: number, seed: number) {
  return (valueNoise(x + z * 0.7, y, seed) + valueNoise(y + 3.1, z + x * 0.5, seed + 1) + valueNoise(z - 1.7, x, seed + 2)) / 3;
}

function rockGeo(detail: number, seed: number, opts: { strata?: number; flat?: number; cuts?: number } = {}): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, detail);
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const P = g.attributes.position;
  // fracture planes give the flat faces of broken rock
  const planes: [THREE.Vector3, number][] = [];
  const nc = opts.cuts ?? 5;
  for (let k = 0; k < nc; k++) {
    const n = new THREE.Vector3(hash2(k, seed, 1) - 0.5, (hash2(k, seed, 2) - 0.3) * 1.2, hash2(k, seed, 3) - 0.5).normalize();
    planes.push([n, 0.62 + hash2(k, seed, 4) * 0.25]);
  }
  const v = new THREE.Vector3();
  for (let i = 0; i < P.count; i++) {
    v.fromBufferAttribute(P, i);
    let r = 1;
    r += (noise3(v.x * 1.6, v.y * 1.6, v.z * 1.6, seed) - 0.5) * 0.55;
    r += (noise3(v.x * 4, v.y * 4, v.z * 4, seed + 5) - 0.5) * 0.16;
    v.multiplyScalar(r);
    for (const [n, d] of planes) {
      const e = v.dot(n) - d;
      if (e > 0) v.addScaledVector(n, -e * 0.92);
    }
    if (opts.strata) v.y += Math.sin(v.y * opts.strata) * 0.035;
    const flat = opts.flat ?? -0.35;
    if (v.y < flat) v.y = flat + (v.y - flat) * 0.25;
    P.setXYZ(i, v.x, v.y, v.z);
  }
  g = g.toNonIndexed();
  const P2 = g.attributes.position;
  const disp2 = new Float32Array(P2.count);
  for (let i = 0; i < P2.count; i++) disp2[i] = Math.hypot(P2.getX(i), P2.getY(i), P2.getZ(i));
  return finishRock(g, disp2, seed);
}

function finishRock(g: THREE.BufferGeometry, disp: Float32Array, seed: number): THREE.BufferGeometry {
  const P = g.attributes.position;
  g.computeVertexNormals();
  // vertex colours: crevices dark, moss on upward faces
  const N = g.attributes.normal;
  const col = new Float32Array(P.count * 3);
  for (let i = 0; i < P.count; i++) {
    const x = P.getX(i);
    const y = P.getY(i);
    const z = P.getZ(i);
    const ao = Math.max(0.45, Math.min(1.1, 0.55 + (disp[i] - 0.75) * 0.9));
    const tone = 0.85 + (noise3(x * 3, y * 3, z * 3, seed + 20) - 0.5) * 0.35;
    let r = 0.92 * tone * ao;
    let gg = 0.88 * tone * ao;
    let b = 0.8 * tone * ao;
    const up = N.getY(i);
    const moss = Math.max(0, Math.min(1, (up - 0.45) * 2.5)) * (noise3(x * 2.2, y * 2.2, z * 2.2, seed + 30) > 0.45 ? 1 : 0.35);
    r = r * (1 - moss * 0.8) + 0.42 * moss * 0.8 * ao;
    gg = gg * (1 - moss * 0.8) + 0.5 * moss * 0.8 * ao;
    b = b * (1 - moss * 0.8) + 0.24 * moss * 0.8 * ao;
    // darker damp base
    const base = Math.max(0, Math.min(1, (-y + 0.1) * 2));
    col[i * 3] = r * (1 - base * 0.35);
    col[i * 3 + 1] = gg * (1 - base * 0.35);
    col[i * 3 + 2] = b * (1 - base * 0.3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  // spherical uvs from the original geometry were lost by mergeVertices; use a box projection
  const uv = new Float32Array(P.count * 2);
  for (let i = 0; i < P.count; i++) {
    const nx = Math.abs(N.getX(i));
    const ny = Math.abs(N.getY(i));
    const nz = Math.abs(N.getZ(i));
    const x = P.getX(i);
    const y = P.getY(i);
    const z = P.getZ(i);
    const [u, v] = ny > nx && ny > nz ? [x, z] : nx > nz ? [z, y] : [x, y];
    uv[i * 2] = u * 0.9;
    uv[i * 2 + 1] = v * 0.9;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ photoscans

interface PhotoRocks {
  /** Per rock class: near / far geometry (normalised like rockGeo: radius 1, base at y = -0.4). */
  geos: { hi: THREE.BufferGeometry; lo: THREE.BufferGeometry }[];
  albedo: THREE.Texture;
  normal: THREE.Texture;
}

const ROCK_KEYS = ['outcrop', 'crag', 'boulder', 'stone'];
/** Where seat() tries a rock (in units of its footprint radius): the spot itself, then inwards round it. */
const SEAT_OFFSETS: [number, number][] = [[0, 0], [0.6, 0], [-0.6, 0], [0, 0.6], [0, -0.6], [0.45, 0.45], [-0.45, -0.45], [0.45, -0.45], [-0.45, 0.45], [1.1, 0], [-1.1, 0], [0, 1.1], [0, -1.1]];
let rocksLoad: Promise<PhotoRocks | null> | null = null;

/** Plain float geometry (dequantised, node transform applied) from a loaded glTF mesh. */
function bakeMesh(mesh: THREE.Mesh): THREE.BufferGeometry {
  mesh.updateWorldMatrix(true, false);
  const src = mesh.geometry;
  const n = src.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const uv = new Float32Array(n * 2);
  const v = new THREE.Vector3();
  const nm = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
  const P = src.attributes.position;
  const N = src.attributes.normal;
  const T = src.attributes.uv;
  for (let i = 0; i < n; i++) {
    v.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld);
    pos.set([v.x, v.y, v.z], i * 3);
    if (N) {
      v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
      nrm.set([v.x, v.y, v.z], i * 3);
    }
    if (T) uv.set([T.getX(i), T.getY(i)], i * 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  if (src.index) g.setIndex(new THREE.BufferAttribute(Uint16Array.from(src.index.array as ArrayLike<number>), 1));
  g.computeBoundingSphere();
  return g;
}

function loadPhotoRocks(size: number): Promise<PhotoRocks | null> {
  if (rocksLoad) return rocksLoad;
  const dir = `${assetBase()}tex/rocks/`;
  const tex = async (url: string, srgb: boolean) => {
    const t = new THREE.Texture(await fetchBitmap(url));
    t.flipY = false;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 4;
    t.needsUpdate = true;
    return t;
  };
  rocksLoad = (async () => {
    try {
      const loader = new GLTFLoader();
      loader.setMeshoptDecoder(MeshoptDecoder);
      const [gltf, albedo, normal] = await Promise.all([loader.loadAsync(`${dir}rocks.glb`), tex(`${dir}rocks_a_${size}.webp`, true), tex(`${dir}rocks_n_${size}.webp`, false)]);
      gltf.scene.updateMatrixWorld(true);
      const find = (name: string) => {
        let hit: THREE.Mesh | null = null;
        gltf.scene.traverse((o) => {
          if (!hit && (o as THREE.Mesh).isMesh && (o.name === name || o.parent?.name === name)) hit = o as THREE.Mesh;
        });
        if (!hit) throw new Error('rocks.glb: no mesh ' + name);
        return bakeMesh(hit);
      };
      const geos = ROCK_KEYS.map((k) => ({ hi: find(`${k}_hi`), lo: find(`${k}_lo`) }));
      return { geos, albedo, normal };
    } catch (e) {
      console.warn('[photo] rock scans unavailable, keeping the procedural rocks', e);
      return null;
    }
  })();
  return rocksLoad;
}

/** Swap a geometry's buffers in place (instanced meshes and the LOD table keep the same object). */
function replaceGeometry(dst: THREE.BufferGeometry, src: THREE.BufferGeometry) {
  dst.dispose();
  for (const name of Object.keys(dst.attributes)) dst.deleteAttribute(name);
  for (const [name, a] of Object.entries(src.attributes)) dst.setAttribute(name, a);
  dst.setIndex(src.index);
  dst.clearGroups();
  dst.boundingBox = null;
  dst.boundingSphere = src.boundingSphere?.clone() ?? null;
}

/** Biome grade of the (warm, sandstone) scans: saturation, colour, moss on top. */
const ROCK_GRADE: Record<string, { sat: number; color: number; moss: number }> = {
  temperate: { sat: 0.35, color: 0xb4b2aa, moss: 0.7 },
  desert: { sat: 0.6, color: 0xb08878, moss: 0 },
  winter: { sat: 0.3, color: 0xb0b6c0, moss: 0.15 },
  urban: { sat: 0.25, color: 0xb2b0aa, moss: 0.2 },
};

function photoRockMaterial(pr: PhotoRocks, biome: string, fog: FogOfWar): THREE.MeshStandardMaterial {
  const gr = ROCK_GRADE[biome] ?? ROCK_GRADE.temperate;
  const mat = new THREE.MeshStandardMaterial({ map: pr.albedo, normalMap: pr.normal, roughness: 0.88, metalness: 0, color: gr.color });
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        diffuseColor.rgb = mix( vec3( dot( diffuseColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ), diffuseColor.rgb, ${gr.sat.toFixed(2)} );`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
        #if ${gr.moss > 0 ? 1 : 0}
        {
          // moss and lichen on the upward faces
          float up = inverseTransformDirection( normal, viewMatrix ).y;
          float mn = texture2D( fogNoise, vFogP.xz * 0.9 ).g;
          float moss = smoothstep( 0.5, 0.85, up + ( mn - 0.5 ) * 0.5 ) * ${gr.moss.toFixed(2)};
          diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.07, 0.085, 0.03 ) * ( 0.7 + mn * 0.6 ), moss );
        }
        #endif`,
      );
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'photo-rock-' + biome;
  return mat;
}

export function buildRocks(m: GameMap, layout: Layout, fog: FogOfWar, quality: 'low' | 'medium' | 'high', lod: SceneryLod): THREE.Object3D[] {
  const tex = rockTexture(quality === 'low' ? 128 : 256);
  const biome = m.biome;
  const mat = fog.apply(
    new THREE.MeshStandardMaterial({ vertexColors: true, map: tex, bumpMap: tex, bumpScale: 2.5, roughness: 0.92, metalness: 0, flatShading: true }),
  );
  // desert sandstone / winter granite (temperate keeps the white base colour)
  if (biome === 'desert') mat.color.setHex(0xa07a68);
  else if (biome === 'winter') mat.color.setHex(0xc4c8d0);
  const shadows = quality !== 'low';
  // [full, lite] pairs: the lite model is the same rock at a lower subdivision
  const low = quality === 'low';
  const pair = (d: number, seed: number, opts: Parameters<typeof rockGeo>[2] = {}): [THREE.BufferGeometry, THREE.BufferGeometry | null] => {
    const lo = d > 0 ? rockGeo(d - 1, seed, opts) : null;
    return [low && lo ? lo : rockGeo(d, seed, opts), low ? null : lo];
  };
  const geos = [pair(2, 11, { strata: 9, cuts: 7 }), pair(2, 23, { strata: 7, cuts: 6 }), pair(1, 41), pair(0, 61, { cuts: 3 })];
  const lists: Inst[][] = [[], [], [], []];
  // no loose stones in or right next to an ore field (they read as ore lying outside it)
  const keep = oreKeepOut(m, 1);
  // cliff faces over the rock (relief.ts); off with ?relief=0
  const relief = reliefEnabled() && reliefField(m).count > 0;
  const isRock = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.tiles[y * m.w + x] === Tile.Rock;

  /**
   * Seat a rock of footprint radius r on the relief: the spot near (cx, cz) where the ground under it
   * drops least (on the rim, not out over the cliff), sunk so its underside never shows over the
   * lowest ground beneath it. Null where it would still hang over the edge.
   */
  const seat = (cx: number, cz: number, r: number, s: number) => {
    let best: { x: number; z: number; hc: number; lo: number } | null = null;
    for (const [ox, oz] of SEAT_OFFSETS) {
      const x = cx + ox * r;
      const z = cz + oz * r;
      if (!isRock(Math.floor(x), Math.floor(z))) continue;
      const hc = reliefHeight(m, x, z);
      let lo = hc;
      for (let k = 0; k < 8; k++) lo = Math.min(lo, reliefHeight(m, x + Math.cos(k * 0.785) * r, z + Math.sin(k * 0.785) * r));
      if (!best || hc - lo < best.hc - best.lo) best = { x, z, hc, lo };
    }
    if (!best || best.hc - best.lo > r * 0.9) return null;
    return { x: best.x, z: best.z, y: Math.min(best.hc - s * 0.45, best.lo + s * 0.1) };
  };

  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      const i = y * m.w + x;
      const t = m.tiles[i];
      if (t === Tile.Rock) {
        // desert mesas: boulders only along the cliff rim, the flat top stays bare
        if (biome === 'desert' && isRock(x - 1, y) && isRock(x + 1, y) && isRock(x, y - 1) && isRock(x, y + 1) && hash2(x, y, 9) < 0.85) continue;
        // principal direction of the ridge around this tile
        let sxx = 0;
        let sxy = 0;
        let syy = 0;
        for (let j = -2; j <= 2; j++)
          for (let k = -2; k <= 2; k++)
            if (isRock(x + k, y + j)) {
              sxx += k * k;
              sxy += k * j;
              syy += j * j;
            }
        const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
        const cx = x + 0.5 + (hash2(x, y, 1) - 0.5) * 0.4;
        const cz = y + 0.5 + (hash2(x, y, 2) - 0.5) * 0.4;
        // sizes vary a lot (a few big blocks, more small ones), never a flat slab: height >= 0.7 of the width
        const s = 0.26 + Math.pow(hash2(x, y, 3), 1.6) * 0.36;
        const sx = s * (1.05 + hash2(x, y, 16) * 0.45);
        const sz = s * (0.8 + hash2(x, y, 17) * 0.35);
        const sy = Math.max(s * (0.8 + hash2(x, y, 6) * 0.6), Math.max(sx, sz) * 0.7);
        if (relief && (hash2(x, y, 15) < 0.35 || landmarkClear(m, cx, cz, 0.7))) continue;
        // desert mesa rims: in irregular clusters with gaps, not one lump per tile
        if (biome === 'desert' && hash2(Math.floor(x / 3), Math.floor(y / 3), 18) < 0.3 && hash2(x, y, 19) < 0.7) continue;
        const at = relief ? seat(cx, cz, Math.max(sx, sz) * 0.75, s) : { x: cx, z: cz, y: groundHeight(m, cx, cz) - s * 0.3 };
        if (!at) continue;
        lists[hash2(x, y, 4) < 0.5 ? 0 : 1].push({
          x: at.x,
          y: at.y,
          z: at.z,
          // ridge crags follow the ridge line; mesa rim blocks lie every which way
          rotY: biome === 'desert' ? hash2(x, y, 5) * Math.PI * 2 : -ang + (hash2(x, y, 5) - 0.5) * 0.5,
          sx,
          sy,
          sz,
          tiltX: (hash2(x, y, 7) - 0.5) * 0.3,
          tiltZ: (hash2(x, y, 8) - 0.5) * 0.3,
        });
        // a second, smaller boulder
        for (let j = 0; j < (relief ? 1 : 2); j++) {
          const bx = x + hash2(x, y, 10 + j * 7);
          const bz = y + hash2(x, y, 11 + j * 7);
          const bs = 0.14 + hash2(x, y, 12 + j * 7) * 0.16;
          const b = relief ? seat(bx, bz, bs * 0.8, bs) : { x: bx, z: bz, y: groundHeight(m, bx, bz) - bs * 0.2 };
          if (b) lists[2].push({ x: b.x, y: b.y, z: b.z, rotY: hash2(x, y, 14 + j) * 6.28, sx: bs, sy: bs * 0.8, sz: bs });
        }
        continue;
      }
      if (t === Tile.Water || t === Tile.Bridge || m.blocked[i]) continue;
      // scree around the ridges, stones on steep ground and riverbanks
      let near = false;
      for (let j = -1; j <= 1 && !near; j++) for (let k = -1; k <= 1 && !near; k++) if (isRock(x + k, y + j)) near = true;
      const slope = Math.abs(groundHeight(m, x + 0.8, y + 0.5) - groundHeight(m, x + 0.2, y + 0.5)) + Math.abs(groundHeight(m, x + 0.5, y + 0.8) - groundHeight(m, x + 0.5, y + 0.2));
      let n = 0;
      if (near) n = 3 + Math.floor(hash2(x, y, 20) * 4);
      else if (slope > 0.45) n = 1 + Math.floor(hash2(x, y, 21) * 2);
      else if (t === Tile.Sand) n = hash2(x, y, 22) < (biome === 'desert' ? 0.05 : 0.5) ? 1 + Math.floor(hash2(x, y, 23) * 3) : 0;
      else if (hash2(x, y, 24) < 0.03) n = 1;
      if (quality === 'low') n = Math.ceil(n / 2);
      for (let k = 0; k < n; k++) {
        const px = x + hash2(x, y, 30 + k);
        const pz = y + hash2(x, y, 40 + k);
        if (occAt(layout, m, px, pz) & (OCC_ROAD | OCC_TRACK | OCC_FIELD | OCC_BUILT)) continue;
        if (m.ore[i] || inKeepOut(m, keep, px, pz)) continue;
        const s = (near ? 0.06 + hash2(x, y, 50 + k) * 0.1 : 0.05 + hash2(x, y, 50 + k) * 0.07) * (t === Tile.Sand ? 0.9 : 1);
        const wet = t === Tile.Sand ? 0.75 : 1;
        lists[3].push({
          x: px,
          y: surfaceHeight(m, px, pz) - s * 0.25,
          z: pz,
          rotY: hash2(x, y, 60 + k) * 6.28,
          sx: s * 1.2,
          sy: s * 0.7,
          sz: s,
          color: new THREE.Color(wet, wet, wet),
          tiltX: hash2(x, y, 70 + k) - 0.5,
        });
      }
    }
  }
  const out: THREE.Object3D[] = relief ? buildRelief(m, fog, quality, lod) : [];
  const meshes: THREE.InstancedMesh[] = [];
  const loSpan = quality === 'high' ? 19 : 14.5;
  geos.forEach(([hi, lo], k) => {
    if (!lists[k].length) return;
    const ci = new CulledInstances(hi, mat, lists[k], m.w, m.h, 4, { castShadow: shadows && k < 3, receiveShadow: true, name: 'rocks' });
    out.push(ci.mesh);
    meshes.push(ci.mesh);
    // scree is hidden when zoomed far out
    lod.addCulled(ci, lo, loSpan, k === 3 ? loSpan + 6 : Infinity);
  });
  const photoOff = typeof location !== 'undefined' && /[?&]photo=0\b/.test(location.search);
  const streams = !low && !photoOff && typeof createImageBitmap !== 'undefined';
  // the desert (GD4): the Blender rock kit - granite tors, corestones, boulders and scree slabs in place of the
  // scans, and rockfall talus at the cliff feet (granite; sandstone in the coloured canyon)
  if (biome === 'desert' && streams && relief) {
    const kq = quality === 'high' ? 'high' : 'medium';
    const talus = buildTalus(m, layout, keep, quality);
    const kitMeshes: { im: THREE.InstancedMesh; hi: THREE.BufferGeometry; lo: THREE.BufferGeometry | null; key: KitKey; sand: boolean }[] = [];
    for (const t of talus) {
      if (!t.list.length) continue;
      // (placeholders until the kit streams in: the procedural block and chip)
      const hi = rockGeo(t.key === 'chip' ? 0 : 1, t.key === 'chip' ? 67 : 53, { cuts: 6 });
      const lo = t.key === 'chip' ? null : rockGeo(0, 53, { cuts: 6 });
      const ci = new CulledInstances(hi, mat, t.list, m.w, m.h, 4, { castShadow: shadows && t.key !== 'chip', receiveShadow: true, name: 'talus' });
      ci.mesh.userData.perfCat = 'rocks';
      out.push(ci.mesh);
      kitMeshes.push({ im: ci.mesh, hi, lo, key: t.key, sand: t.sand });
      // the chips go when zoomed far out
      lod.addCulled(ci, lo, loSpan, t.key === 'chip' ? loSpan + 6 : Infinity);
    }
    console.info(`[talus] ${talus.map((t) => `${t.key}${t.sand ? '(sandstone)' : ''} ${t.list.length}`).join(', ')}`);
    void loadRockKit().then((kit) => {
      if (!kit) {
        // no kit: the scans as before
        void swapToScans();
        return;
      }
      const gmat = rockKitMaterial(fog, 'granite', kq, kitColour('granite'));
      const smat = rockKitMaterial(fog, 'sandstone', kq, kitColour('sandstone'));
      const legacy: KitKey[] = ['tor', 'corestone', 'boulder', 'slab'];
      geos.forEach(([hi, lo], k) => {
        const g = kit.geos[legacy[k]];
        // (medium: the far model near too, as the scans were)
        replaceGeometry(hi, quality === 'high' ? g.hi : g.lo);
        if (lo) replaceGeometry(lo, g.lo);
      });
      for (const im of meshes) im.material = gmat;
      for (const t of kitMeshes) {
        const g = kit.geos[t.key];
        // (medium / phones: the far model near too, as for the rocks above)
        replaceGeometry(t.hi, quality === 'high' ? g.hi : g.lo);
        if (t.lo) replaceGeometry(t.lo, g.lo);
        t.im.material = t.sand ? smat : gmat;
      }
      mat.dispose();
      console.info('[rockkit] desert rock kit in place');
    });
    return out;
  }
  // photoscanned rocks (medium: the far model near too, it is as light as the procedural rock; ?photo=0 keeps these)
  function swapToScans() {
    return loadPhotoRocks(quality === 'high' && !phoneCaps() ? 1024 : 512).then((pr) => {
      if (!pr) return;
      const pmat = photoRockMaterial(pr, biome ?? 'temperate', fog);
      geos.forEach(([hi, lo], k) => {
        const g = pr.geos[k];
        replaceGeometry(hi, quality === 'high' ? g.hi : g.lo);
        if (lo) replaceGeometry(lo, g.lo);
      });
      for (const im of meshes) im.material = pmat;
      mat.dispose();
      console.info('[photo] rock scans in place');
    });
  }
  if (streams) void swapToScans();
  return out;
}

/** The kit's base colours (linear): the desert cliffs' granite (relief.ts) and the canyon's sandstone (strata.ts). */
function kitColour(kind: 'granite' | 'sandstone'): THREE.Color {
  if (kind === 'sandstone') return strataMean().multiplyScalar(0.57 * 1.6);
  // the cliff faces' average: the grey rock scan's mean under the desert side tint, 75 % saturation, x1.6
  const g = PHOTO_MATERIALS.greyrock.mean;
  const t = new THREE.Color(0x9a7262);
  const c = new THREE.Color(g[0] * t.r, g[1] * t.g, g[2] * t.b);
  const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  return new THREE.Color(l + (c.r - l) * 0.7, l + (c.g - l) * 0.7, l + (c.b - l) * 0.7).multiplyScalar(1.6 * 1.3);
}

/**
 * Rockfall at the cliff feet (desert relief, GD4): talus blocks leaning on the foot of the cliffs, inside the rock
 * (never over passable ground), in clusters with gaps, and chips spilling a little way out onto the ground below.
 * In the coloured canyon the blocks are sandstone.
 */
export function buildTalus(m: GameMap, layout: Layout, keep: ReturnType<typeof oreKeepOut>, quality: 'low' | 'medium' | 'high'): { key: KitKey; sand: boolean; list: Inst[] }[] {
  const rf = reliefField(m);
  const F = rf.F;
  const can = canyonMask(m);
  const t1: Inst[] = [];
  const t2: Inst[] = [];
  const ts: Inst[] = [];
  const chips: Inst[] = [];
  const isRock = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.tiles[Math.floor(y) * m.w + Math.floor(x)] === Tile.Rock;
  const dAt = (i: number, j: number) => (i < 0 || j < 0 || i >= rf.NW || j >= rf.NH ? 0 : rf.d[j * rf.NW + i]);
  const density = quality === 'high' ? 1 : 0.8;
  for (let j = 1; j < rf.NH - 1; j++)
    for (let i = 1; i < rf.NW - 1; i++) {
      const d = rf.d[j * rf.NW + i];
      if (d < 0.14 || d > 0.42) continue;
      // clusters along the feet with gaps between them
      const cl = valueNoise(i * 0.21, j * 0.21, 4601);
      if (hash2(i, j, 4603) > (cl - 0.32) * 0.9 * density) continue;
      // outward: down the distance field, towards the open ground
      let ox = dAt(i - 1, j) - dAt(i + 1, j);
      let oz = dAt(i, j - 1) - dAt(i, j + 1);
      const ol = Math.hypot(ox, oz);
      if (ol < 1e-4) continue;
      ox /= ol;
      oz /= ol;
      const big = hash2(i, j, 4605);
      const s = 0.07 + Math.pow(big, 1.8) * 0.19;
      // the block's centre stays inside the rock by its own radius
      const back = Math.max(0, s * 0.85 - d) + (hash2(i, j, 4607) - 0.5) * 0.06;
      const x = i / F + rf.jx[j * rf.NW + i] - ox * back;
      const z = j / F + rf.jz[j * rf.NW + i] - oz * back;
      if (!isRock(x, z) || landmarkClear(m, x, z, 0.4)) continue;
      // seat it on the lowest ground under it (leaning on the cliff, sunk at the foot)
      let lo = reliefHeight(m, x, z);
      for (let k = 0; k < 8; k++) lo = Math.min(lo, reliefHeight(m, x + Math.cos(k * 0.785) * s, z + Math.sin(k * 0.785) * s));
      const sand = !!can && can(x, z) > 0.5;
      const sy = s * (0.62 + hash2(i, j, 4609) * 0.4);
      const inst: Inst = {
        x,
        y: lo + sy * 0.28,
        z,
        rotY: hash2(i, j, 4611) * 6.283,
        sx: s * (0.9 + hash2(i, j, 4613) * 0.35),
        sy,
        sz: s * (0.75 + hash2(i, j, 4615) * 0.3),
        tiltX: (hash2(i, j, 4617) - 0.5) * 0.5,
        tiltZ: (hash2(i, j, 4619) - 0.5) * 0.5,
      };
      (sand ? ts : hash2(i, j, 4621) < 0.5 ? t1 : t2).push(inst);
      // chips spilling out onto the ground below (granite: the canyon has its own, canyon.ts)
      const nc = sand ? 0 : Math.floor(hash2(i, j, 4623) * (2 + s * 10) * density);
      for (let c = 0; c < nc; c++) {
        const r = s + 0.06 + hash2(i, j, 4630 + c) * 0.45;
        const a = (hash2(i, j, 4640 + c) - 0.5) * 1.6;
        const px = x + (ox * Math.cos(a) - oz * Math.sin(a)) * r;
        const pz = z + (ox * Math.sin(a) + oz * Math.cos(a)) * r;
        const tx = Math.floor(px);
        const tz = Math.floor(pz);
        if (tx < 0 || tz < 0 || tx >= m.w || tz >= m.h) continue;
        const ti = tz * m.w + tx;
        const onRock = m.tiles[ti] === Tile.Rock;
        if (!onRock && (m.tiles[ti] === Tile.Water || m.ore[ti] || inKeepOut(m, keep, px, pz) || occAt(layout, m, px, pz) & (OCC_ROAD | OCC_TRACK | OCC_FIELD | OCC_BUILT))) continue;
        const cs = 0.025 + hash2(i, j, 4650 + c) * 0.045;
        chips.push({
          x: px,
          y: (onRock ? reliefHeight(m, px, pz) : surfaceHeight(m, px, pz)) - cs * 0.1,
          z: pz,
          rotY: hash2(i, j, 4660 + c) * 6.283,
          sx: cs * 1.2,
          sy: cs * 0.8,
          sz: cs,
          tiltX: (hash2(i, j, 4670 + c) - 0.5) * 0.6,
        });
      }
    }
  // the graded mountain tracks (SL1): the rubble pushed aside when they were cut lies along both verges, so the
  // trodden bed reads as a way cut through the rock
  for (const [ti, tr] of layout.tracks.entries()) {
    if (!tr.bed) continue;
    const half = tr.width / 2 + tr.bed;
    let along = 0;
    for (let k = 0; k < tr.pts.length - 1; k++) {
      const a = tr.pts[k];
      const b = tr.pts[k + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      if (L < 1e-4) continue;
      const tx = (b.x - a.x) / L;
      const tz = (b.y - a.y) / L;
      for (let s = 0; s < L; s += 0.22, along += 0.22) {
        const q = Math.round(along / 0.22);
        for (const side of [-1, 1]) {
          if (hash2(q, ti * 2 + (side > 0 ? 1 : 0), 4701) > 0.62 * density) continue;
          const off = half + 0.08 + Math.pow(hash2(q, ti, 4703 + side), 1.5) * 0.5;
          const px = a.x + tx * s - tz * off * side + (hash2(q, ti, 4705) - 0.5) * 0.15;
          const pz = a.y + tz * s + tx * off * side + (hash2(q, ti, 4707) - 0.5) * 0.15;
          const ix = Math.floor(px);
          const iz = Math.floor(pz);
          if (ix < 0 || iz < 0 || ix >= m.w || iz >= m.h) continue;
          const ii = iz * m.w + ix;
          if (m.tiles[ii] === Tile.Water || m.ore[ii] || inKeepOut(m, keep, px, pz) || occAt(layout, m, px, pz) & (OCC_ROAD | OCC_TRACK | OCC_BUILT)) continue;
          const cs = 0.03 + Math.pow(hash2(q, ti, 4709 + side), 1.4) * 0.045;
          const onRock = m.tiles[ii] === Tile.Rock;
          chips.push({
            x: px,
            y: (onRock ? reliefHeight(m, px, pz) : surfaceHeight(m, px, pz)) - cs * 0.12,
            z: pz,
            rotY: hash2(q, ti, 4711 + side) * 6.283,
            sx: cs * 1.25,
            sy: cs * 0.75,
            sz: cs,
            tiltX: (hash2(q, ti, 4713 + side) - 0.5) * 0.5,
          });
        }
      }
    }
  }
  return [
    { key: 'talus1', sand: false, list: t1 },
    { key: 'talus2', sand: false, list: t2 },
    { key: 'talus1', sand: true, list: ts },
    { key: 'chip', sand: false, list: chips },
  ];
}
