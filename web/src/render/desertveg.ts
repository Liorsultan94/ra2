import * as THREE from 'three';
import type { FogOfWar } from './fog';
import { CulledInstances, type Inst, type SceneryLod } from './geo';
import { assetBase } from './photoground';
import { hash2 } from '../sim/rng';
import { treeDepthShader, treeShader, updateWind } from './trees';

/*
 * The desert vegetation kit (GD3): plants modelled and baked in Blender (tools/blender/desertveg/desert_veg.py ->
 * pack.mjs -> public/models/desertveg/):
 *  - date palms (tall, short, leaning, a clump with offshoots): diamond-patterned trunks of cut leaf bases, a full
 *    crown of arching V-folded pinnate fronds, dead fronds hanging under it, bunches of dates;
 *  - a leaning coconut palm (ringed trunk, long drooping fronds, coconuts) for the beaches;
 *  - flat-topped umbrella acacias (a big one and a young one), a desert shrub and a dry thorn bush.
 * One atlas (albedo with the alpha cutout, tangent normals; leaflets, sprays and barks rendered from high poly
 * models), three levels per plant: LOD0 at play zoom, a lighter LOD1 further out, a far impostor (crossed side
 * cards and a top card rendered from the LOD0 model). The frond strips are trimmed to each card's leaflet
 * envelope, which keeps the alpha-tested overdraw down.
 * Material: the tree material's lighting (wrap, sun-through-the-leaves) and wind (trees.ts), the atlas' normal
 * map on top of the canopy-shaped normals, and the fronds flapping with the wind (strong in a sandstorm: the
 * weather speeds up the foliage clock and treeWind.z follows it).
 * Without the kit (tests, ?veg=0, a failed download) the procedural plants of trees.ts stay.
 */

export type VegKind = 'date_tall' | 'date_short' | 'date_lean' | 'date_clump' | 'coco' | 'acacia' | 'acacia_b' | 'shrub' | 'thorn';
export const VEG_KINDS: VegKind[] = ['date_tall', 'date_short', 'date_lean', 'date_clump', 'coco', 'acacia', 'acacia_b', 'shrub', 'thorn'];

interface VegManifest {
  atlas: number;
  meshes: Record<string, { tris: number; h: number; r: number }>;
}

export interface DesertVeg {
  man: VegManifest;
  /** Geometries by mesh name ('date_tall', 'date_tall_l1', 'date_tall_far', ...): position, normal, uv, color (AO), flex, leaf. */
  geo: Map<string, THREE.BufferGeometry>;
  albedo: THREE.Texture;
  normal: THREE.Texture;
  /** Atlas size loaded (px). */
  px: number;
  bytes: number;
}

let pending: Promise<DesertVeg | null> | null = null;
let ready: DesertVeg | null = null;

/** The loaded kit (null until loadDesertVeg() resolved, in tests, or after a failure). */
export function desertVeg(): DesertVeg | null {
  return ready;
}

async function tex(url: string, srgb: boolean, counter: { bytes: number }): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const blob = await res.blob();
  counter.bytes += blob.size;
  const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t = new THREE.Texture(bmp);
  t.flipY = false;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const _v = new THREE.Vector3();

/** Float copy of a (quantised) glTF plant with its node transform baked in; _AO -> color, _FLEX -> flex, _LEAF -> leaf. */
function dequantize(src: THREE.BufferGeometry, world: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  const copy = (name: string, as: string) => {
    const a = src.getAttribute(name);
    if (!a) return null;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    g.setAttribute(as, new THREE.BufferAttribute(out, a.itemSize));
    return out;
  };
  copy('position', 'position');
  copy('normal', 'normal');
  copy('uv', 'uv');
  copy('_flex', 'flex');
  copy('_leaf', 'leaf');
  const ao = src.getAttribute('_ao');
  if (ao) {
    const c = new Float32Array(ao.count * 3);
    for (let i = 0; i < ao.count; i++) {
      const k = ao.getComponent(i, 0);
      c[i * 3] = k;
      c[i * 3 + 1] = k;
      c[i * 3 + 2] = k * 0.97;
    }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  }
  if (src.index) g.setIndex(Array.from(src.index.array as ArrayLike<number>));
  g.applyMatrix4(world);
  const n = g.getAttribute('normal');
  if (n) for (let i = 0; i < n.count; i++) _v.fromBufferAttribute(n, i).normalize().toArray(n.array as Float32Array, i * 3);
  // (the wind weights are in the plant's own units: a scaled node would scale them too, but the export has none)
  g.computeBoundingSphere();
  return g;
}

/**
 * Fetch the kit once; resolves null when it cannot load (no fetch in tests, ?veg=0 for comparison shots, a network
 * failure): the plants then stay the procedural ones.
 */
export function loadDesertVeg(quality: 'low' | 'medium' | 'high'): Promise<DesertVeg | null> {
  if (pending) return pending;
  pending = (async () => {
    if (typeof fetch === 'undefined' || typeof createImageBitmap === 'undefined') return null;
    if (typeof location !== 'undefined' && /[?&]veg=0\b/.test(location.search)) return null;
    const t0 = performance.now();
    try {
      const dir = `${assetBase()}models/desertveg/`;
      const counter = { bytes: 0 };
      const big = quality === 'high';
      const sfx = big ? '' : '-512';
      const manRes = await fetch(dir + 'desert-veg.json');
      if (!manRes.ok) throw new Error('desert-veg.json: HTTP ' + manRes.status);
      const man = (await manRes.json()) as VegManifest;
      const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
      const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
      const glbRes = await fetch(dir + 'desert-veg.glb');
      if (!glbRes.ok) throw new Error('desert-veg.glb: HTTP ' + glbRes.status);
      const buf = await glbRes.arrayBuffer();
      counter.bytes += buf.byteLength;
      const [gltf, albedo, normal] = await Promise.all([loader.parseAsync(buf, dir), tex(`${dir}desert-veg-albedo${sfx}.webp`, true, counter), tex(`${dir}desert-veg-normal${sfx}.webp`, false, counter)]);
      const geo = new Map<string, THREE.BufferGeometry>();
      gltf.scene.updateMatrixWorld(true);
      gltf.scene.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) geo.set(mesh.name, dequantize(mesh.geometry, mesh.matrixWorld));
      });
      for (const k of VEG_KINDS) if (!geo.has(k) || !geo.has(k + '_l1')) throw new Error('desert-veg.glb: no ' + k);
      ready = { man, geo, albedo, normal, px: big ? man.atlas : 512, bytes: counter.bytes };
      console.info(`[veg] desert vegetation: ${geo.size} meshes, ${(counter.bytes / 1024).toFixed(0)} KB in ${Math.round(performance.now() - t0)} ms`);
      return ready;
    } catch (e) {
      console.warn('[veg] desert vegetation unavailable, keeping the procedural plants', e);
      return null;
    }
  })();
  return pending;
}

// ------------------------------------------------------------------ material

/**
 * Frond flap on top of the trees' bend: the leafy tips (flex grows along a frond) swing and lift with the wind,
 * a slow gentle nod in calm air, a hard thrash in a sandstorm (tst ~ 1.2).
 */
const FROND_WIND = /* glsl */ `
{
  float fph = windTime * ( 2.1 + tst * 1.6 ) + dot( position, vec3( 3.1, 2.3, 2.7 ) ) + wo.x * 0.7 + wo.z * 0.5;
  float flap = flex * leaf * ( 0.35 + 1.6 * tst * ( 0.4 + gust ) );
  transformed.y += sin( fph ) * flap * 0.55;
  transformed.xz += tld * ( sin( fph * 0.73 + 1.1 ) * 0.5 + 0.5 ) * flap * 0.6;
}
`;

/** The atlas normal map perturbs the canopy-shaped normal (not the card's flat one): the frame is re-orthogonalised. */
const CANOPY_NORMAL_MAP = /* glsl */ `
#ifdef USE_NORMALMAP_TANGENTSPACE
{
  vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
  mapN.xy *= normalScale;
  vec3 tT = normalize( tbn[0] - normal * dot( normal, tbn[0] ) );
  vec3 tB = normalize( tbn[1] - normal * dot( normal, tbn[1] ) );
  normal = normalize( tT * mapN.x + tB * mapN.y + normal * max( mapN.z, 0.2 ) );
}
#endif
`;

export interface VegMaterials {
  mat: THREE.MeshStandardMaterial;
  depth: THREE.MeshDepthMaterial;
}

const MATS = new WeakMap<FogOfWar, VegMaterials>();

/** The kit's material (one per fog of war instance) and its shadow depth material. */
export function vegMaterials(fog: FogOfWar, kit: DesertVeg, quality: 'low' | 'medium' | 'high'): VegMaterials {
  const hit = MATS.get(fog);
  if (hit) return hit;
  const mat = new THREE.MeshStandardMaterial({
    map: kit.albedo,
    normalMap: kit.normal,
    // Blender tangent normals through glTF's flipped v, a little softened (the leaflets' V fold)
    normalScale: new THREE.Vector2(0.85, -0.85),
    alphaTest: 0.42,
    side: THREE.DoubleSide,
    vertexColors: true,
    roughness: 0.78,
    metalness: 0,
    alphaToCoverage: quality !== 'low',
  });
  mat.onBeforeCompile = (shader) => {
    treeShader(shader, kit.px, FROND_WIND);
    shader.fragmentShader = shader.fragmentShader.replace('#include <normal_fragment_maps>', CANOPY_NORMAL_MAP);
  };
  fog.apply(mat);
  mat.customProgramCacheKey = () => 'desert-veg-v1';
  const depth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: kit.albedo, alphaTest: 0.42, side: THREE.DoubleSide });
  depth.onBeforeCompile = (shader) => treeDepthShader(shader, kit.px, FROND_WIND);
  depth.customProgramCacheKey = () => 'desert-veg-depth-v1';
  const out = { mat, depth };
  MATS.set(fog, out);
  return out;
}

/**
 * Leaf tint of one plant (half strength like treeTint): the atlas carries the colour, so this is a gentle
 * per-plant variation round neutral grey (a greener, a greyer, a sun-yellowed one).
 */
export function vegTint(kind: VegKind, r1: number, r2: number, r3: number): THREE.Color {
  const c = new THREE.Color();
  const dry = kind === 'thorn' || kind === 'shrub';
  const h = 0.16 + (r1 - 0.5) * (dry ? 0.06 : 0.08);
  const s = (dry ? 0.04 : 0.06) + r2 * 0.08;
  c.setHSL(h, s, 0.5);
  // keep the mean brightness at the atlas' own (0.5 grey = x1 in the shader)
  const lum = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  return c.multiplyScalar((0.5 * (0.94 + r3 * 0.12)) / Math.max(1e-3, lum));
}

/** The kit's geometry of a plant at one level (0 play zoom, 1 lighter, 2 far impostor; shrubs have no impostor). */
export function vegGeometry(kit: DesertVeg, kind: VegKind, lod: 0 | 1 | 2): THREE.BufferGeometry {
  const name = lod === 0 ? kind : lod === 1 ? kind + '_l1' : kind + '_far';
  return kit.geo.get(name) ?? kit.geo.get(kind + '_l1')!;
}

/** View spans (world units) of the level switches: LOD1 beyond `l1`, the impostors beyond `far`. */
export function vegSpans(quality: 'low' | 'medium' | 'high') {
  return quality === 'high' ? { l1: 19, far: 30 } : quality === 'medium' ? { l1: 14.5, far: 24 } : { l1: 0, far: 19 };
}

/** Per draw (onBeforeRender): the wind; on medium no plant shadows from the far zoom-out (as the trees). */
export function updateVegShadow(mesh: THREE.Mesh, cam: THREE.Camera, fog: FogOfWar, shadows: boolean, quality: 'low' | 'medium' | 'high') {
  updateWind(fog.uniforms.fogTime.value as number);
  if (!cam.userData.waterReflection) mesh.castShadow = shadows && !(quality === 'medium' && cam.position.y * 0.9 > 30);
}

/**
 * Instanced plants of one kind over the map (one CulledInstances, registered with the zoom LOD: LOD0 -> LOD1 ->
 * impostor). Low quality starts at LOD1.
 */
export function buildVegInstances(
  kit: DesertVeg,
  kind: VegKind,
  list: Inst[],
  fog: FogOfWar,
  quality: 'low' | 'medium' | 'high',
  lod: SceneryLod,
  mapW: number,
  mapH: number,
  opts: { castShadow: boolean; name: string; cell?: number },
): CulledInstances {
  const { mat, depth } = vegMaterials(fog, kit, quality);
  const sp = vegSpans(quality);
  const l0 = vegGeometry(kit, kind, 0);
  const l1 = vegGeometry(kit, kind, 1);
  const far = kind === 'shrub' || kind === 'thorn' ? null : vegGeometry(kit, kind, 2);
  const ci = new CulledInstances(quality === 'low' ? l1 : l0, mat, list, mapW, mapH, opts.cell ?? 4, { castShadow: opts.castShadow, receiveShadow: true, name: opts.name });
  ci.mesh.customDepthMaterial = depth;
  const shadows = opts.castShadow;
  const mesh = ci.mesh;
  mesh.onBeforeRender = (_r, _s, cam) => updateVegShadow(mesh, cam, fog, shadows, quality);
  lod.addCulled(ci, quality === 'low' ? null : l1, sp.l1, Infinity, far ? { geo: far, span: sp.far } : undefined);
  return ci;
}

/** Size of each plant against the procedural species it replaces (the Blender models are built at their own scale). */
export const VEG_SCALE: Record<VegKind, number> = {
  date_tall: 0.82,
  date_short: 0.9,
  date_lean: 0.86,
  date_clump: 0.86,
  coco: 0.9,
  acacia: 0.95,
  acacia_b: 0.95,
  shrub: 1,
  thorn: 1,
};

/** A date palm variant for a map tree (deterministic per spot): mostly tall, then leaning, short, now and then a clump. */
export function dateKind(r: number): VegKind {
  return r < 0.42 ? 'date_tall' : r < 0.66 ? 'date_lean' : r < 0.84 ? 'date_short' : 'date_clump';
}

/** The view span (world units) a camera sees, as Terrain's LOD reads it. */
function viewSpan(cam: THREE.Camera): number {
  const oc = cam as THREE.OrthographicCamera;
  if (oc.isOrthographicCamera) return (oc.top - oc.bottom) / oc.zoom;
  return cam.position.y * 0.9;
}

/**
 * A few plants of one kind placed by world matrices (the resort, the landmarks past the map edge): one instanced
 * mesh, its zoom level picked per draw from the camera (takes effect the next frame), wind and shadows as above.
 */
export function vegInstancedMesh(kit: DesertVeg, kind: VegKind, list: THREE.Matrix4[], fog: FogOfWar, quality: 'low' | 'medium' | 'high', name: string, castShadow = quality !== 'low'): THREE.InstancedMesh {
  const { mat, depth } = vegMaterials(fog, kit, quality);
  const l0 = vegGeometry(kit, kind, quality === 'low' ? 1 : 0);
  const l1 = vegGeometry(kit, kind, 1);
  const far = kind === 'shrub' || kind === 'thorn' ? l1 : vegGeometry(kit, kind, 2);
  const sp = vegSpans(quality);
  const im = new THREE.InstancedMesh(l0, mat, Math.max(1, list.length));
  const p = new THREE.Vector3();
  list.forEach((m, i) => {
    im.setMatrixAt(i, m);
    p.setFromMatrixPosition(m);
    const kx = Math.floor(p.x * 7);
    const kz = Math.floor(p.z * 7);
    im.setColorAt(i, vegTint(kind, hash2(kx, kz, 3), hash2(kx, kz, 4), hash2(kx, kz, 5)));
  });
  im.count = list.length;
  im.instanceMatrix.needsUpdate = true;
  if (im.instanceColor) im.instanceColor.needsUpdate = true;
  im.computeBoundingSphere();
  if (im.boundingSphere) im.boundingSphere.radius += 2;
  im.customDepthMaterial = depth;
  im.castShadow = castShadow;
  im.receiveShadow = true;
  im.name = name;
  im.onBeforeRender = (_r, _s, cam) => {
    updateVegShadow(im, cam, fog, castShadow, quality);
    if (cam.userData.waterReflection) return;
    const span = viewSpan(cam);
    const g = span > sp.far ? far : span > sp.l1 ? l1 : l0;
    if (im.geometry !== g) im.geometry = g;
  };
  return im;
}
