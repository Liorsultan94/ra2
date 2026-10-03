import * as THREE from 'three';
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
import { assetBase, fetchBitmap } from './photoground';

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
  desert: { sat: 1.0, color: 0xf2dcc6, moss: 0 },
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
  if (biome === 'desert') mat.color.setHex(0xd6aa86);
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
  const isRock = (x: number, y: number) => x >= 0 && y >= 0 && x < m.w && y < m.h && m.tiles[y * m.w + x] === Tile.Rock;

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
        const s = 0.3 + hash2(x, y, 3) * 0.22;
        const h = groundHeight(m, cx, cz);
        lists[hash2(x, y, 4) < 0.5 ? 0 : 1].push({
          x: cx,
          y: h - s * 0.3,
          z: cz,
          rotY: -ang + (hash2(x, y, 5) - 0.5) * 0.5,
          sx: s * 1.5,
          sy: s * (0.8 + hash2(x, y, 6) * 0.6),
          sz: s * 0.9,
          tiltX: (hash2(x, y, 7) - 0.5) * 0.3,
          tiltZ: (hash2(x, y, 8) - 0.5) * 0.3,
        });
        // a second, smaller boulder
        for (let j = 0; j < 2; j++) {
          const bx = x + hash2(x, y, 10 + j * 7);
          const bz = y + hash2(x, y, 11 + j * 7);
          const bs = 0.14 + hash2(x, y, 12 + j * 7) * 0.16;
          lists[2].push({ x: bx, y: groundHeight(m, bx, bz) - bs * 0.2, z: bz, rotY: hash2(x, y, 14 + j) * 6.28, sx: bs, sy: bs * 0.8, sz: bs });
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
        if (m.ore[i]) continue;
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
  const out: THREE.Object3D[] = [];
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
  // photoscanned rocks (medium: the far model near too, it is as light as the procedural rock; ?photo=0 keeps these)
  const photoOff = typeof location !== 'undefined' && /[?&]photo=0\b/.test(location.search);
  if (!low && !photoOff && typeof createImageBitmap !== 'undefined')
    void loadPhotoRocks(quality === 'high' ? 1024 : 512).then((pr) => {
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
  return out;
}
