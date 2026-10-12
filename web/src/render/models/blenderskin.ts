import * as THREE from 'three';

/*
 * Blender-authored skins for procedural models (pipeline: web/tools/blender/, assets: public/models/blender/).
 *
 * A skin swaps only the geometry (and surface maps) of a procedural template, part by part, and leaves
 * everything else to the procedural build: skeleton / pivots, animation, IK, muzzles, emitters, LODs,
 * team colour, fog and lighting patches. When an asset is missing or fails to load (or `?blender=0`),
 * the procedural model is used as before. Loading never blocks: models built before a skin has
 * arrived simply stay procedural.
 *
 * Asset layout (tools/blender/pack.mjs):
 *  - <id>.glb: one mesh node per part (infantry: per bone, e.g. "ahips", "awpn") plus "<part>_lod1" and
 *    "<part>_lod2", positions in the part's local (modelling) frame, meshopt + quantised (decoded to
 *    floats here);
 *  - <id>-albedo.webp (sRGB), <id>-normal.webp (tangent space, glTF convention), <id>-orm.webp
 *    (R = player colour mask, G = roughness, B = metalness); `-256` variants for the phone profile.
 *
 * New assets: add a SKINS entry and a builder script; the model builder picks it up by model key + faction.
 */

export interface SkinDef {
  /** File stem in public/models/blender/. */
  id: string;
  /** Model key (sim defs `model`). */
  model: string;
  /** Faction (ModelStyle.faction). */
  faction: string;
}

export const SKINS: SkinDef[] = [{ id: 'idf-rifleman', model: 'rifle', faction: 'israel' }];

export interface Skin {
  def: SkinDef;
  /** Part name -> [LOD0, LOD1, LOD2] geometries (LOD1 / LOD2 may be missing). */
  parts: Map<string, THREE.BufferGeometry[]>;
  albedo: THREE.Texture;
  normal: THREE.Texture;
  orm: THREE.Texture;
}

const skins = new Map<string, Skin>();
let disabled = false;

/** The loaded skin for a model key + faction (null: use the procedural look). */
export function skinFor(model: string, faction: string): Skin | null {
  if (disabled) return null;
  return skins.get(model + '|' + faction) ?? null;
}

/** Test / debug hook: register (or with null, drop) a skin directly. */
export function registerSkin(s: Skin | null, def?: SkinDef) {
  const d = s?.def ?? def;
  if (!d) return;
  if (s) skins.set(d.model + '|' + d.faction, s);
  else skins.delete(d.model + '|' + d.faction);
}

async function texture(url: string, srgb: boolean): Promise<THREE.Texture> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const t = new THREE.Texture(bmp);
  t.flipY = false; // glTF uv convention
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.anisotropy = 4;
  t.needsUpdate = true;
  return t;
}

const _n = new THREE.Vector3();
/** Float copy of a (quantised) glTF geometry with its node transform baked in. */
function dequantize(src: THREE.BufferGeometry, world: THREE.Matrix4): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = src.getAttribute(name);
    if (!a) continue;
    const out = new Float32Array(a.count * a.itemSize);
    for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) out[i * a.itemSize + c] = a.getComponent(i, c);
    g.setAttribute(name, new THREE.BufferAttribute(out, a.itemSize));
  }
  if (src.index) g.setIndex(new THREE.BufferAttribute(src.index.array.slice(), 1));
  g.applyMatrix4(world);
  const n = g.getAttribute('normal');
  if (n) for (let i = 0; i < n.count; i++) _n.fromBufferAttribute(n, i).normalize().toArray(n.array as Float32Array, i * 3);
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

/** Part name -> [LOD0, LOD1, LOD2] from the meshes of a loaded glTF scene. */
export function skinParts(scene: THREE.Object3D): Map<string, THREE.BufferGeometry[]> {
  const geos = new Map<string, THREE.BufferGeometry>();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) geos.set(m.name || o.parent?.name || '', dequantize(m.geometry, m.matrixWorld));
  });
  const parts = new Map<string, THREE.BufferGeometry[]>();
  for (const [name, g] of geos) {
    if (/_lod\d$/.test(name)) continue;
    parts.set(name, [g, geos.get(name + '_lod1'), geos.get(name + '_lod2')].filter((x): x is THREE.BufferGeometry => !!x));
  }
  return parts;
}

let pending: Promise<number> | null = null;

/**
 * Start loading every skin (boot). Resolves with the number loaded; never rejects. Callers may await it
 * with their own time cap: a skin that arrives later is still registered and used by the models built
 * from then on (cached templates keep the look they were built with, so nothing swaps mid-match).
 * `small`: the phone profile's 256 px maps instead of 512 px.
 */
export function loadSkins(base: string, small = false): Promise<number> {
  if (pending) return pending;
  if (typeof fetch === 'undefined' || typeof createImageBitmap === 'undefined') return Promise.resolve(0);
  if (typeof location !== 'undefined' && /[?&]blender=0\b/.test(location.search)) {
    disabled = true;
    return Promise.resolve(0);
  }
  const dir = `${base}models/blender/`;
  const sfx = small ? '-256' : '';
  pending = (async () => {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    await Promise.all(
      SKINS.map(async (def) => {
        try {
          const [gltf, albedo, normal, orm] = await Promise.all([loader.loadAsync(`${dir}${def.id}.glb`), texture(`${dir}${def.id}-albedo${sfx}.webp`, true), texture(`${dir}${def.id}-normal${sfx}.webp`, false), texture(`${dir}${def.id}-orm${sfx}.webp`, false)]);
          const parts = skinParts(gltf.scene);
          if (!parts.size) throw new Error('no meshes');
          registerSkin({ def, parts, albedo, normal, orm });
          console.info(`[glb] skin ${def.id} for ${def.model}|${def.faction}: ${parts.size} parts`);
        } catch (e) {
          console.warn(`[glb] skin ${def.id} unavailable, keeping the procedural model`, e);
        }
      }),
    );
    return skins.size;
  })().catch(() => skins.size);
  return pending;
}

/**
 * Player colour on the skin's orm R mask: the albedo there is a neutral grey (0.62) that is multiplied by
 * the team colour, with the same faint self-light (0.3) as the procedural team panels. Chain it after the
 * fog patch (fog.apply replaces the program cache key) so its key is appended, never dropped.
 */
export function skinTeamPatch<T extends THREE.MeshStandardMaterial>(m: T, team: number): T {
  const col = new THREE.Color(team);
  const uTeam = { value: new THREE.Vector3(col.r, col.g, col.b).multiplyScalar(1 / 0.62) };
  const prev = m.onBeforeCompile;
  const key = `${m.customProgramCacheKey()}|skinTeam`;
  m.onBeforeCompile = function (this: THREE.Material, sh, renderer) {
    prev.call(this, sh, renderer);
    sh.uniforms.uSkinTeam = uTeam;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSkinTeam;\nfloat skinTeamK;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        skinTeamK = texture2D(roughnessMap, vRoughnessMapUv).r;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uSkinTeam, skinTeamK);`,
      )
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * 0.3 * skinTeamK;');
  };
  m.customProgramCacheKey = () => key;
  return m;
}

export const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;
