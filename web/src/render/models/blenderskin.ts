import * as THREE from 'three';

/*
 * Blender-authored skins for procedural models (pipeline: web/tools/blender/, assets: public/models/blender/).
 *
 * A skin swaps the static merged meshes of a procedural template (vehicles.ts / buildings.ts) for the
 * Blender low poly and its baked PBR maps, part by part, and leaves the rest of the template alone:
 * pivots, animated parts, muzzles, recoil, tracks and road wheels, crew, decals, lamp / glow meshes,
 * damage points, night lights and the construction / damage effects all come from the procedural build.
 * When an asset is missing or fails to load (or `?blender=0`), the procedural mesh is used as before.
 *
 * Asset layout (tools/blender/pack.mjs):
 *  - <id>.glb: one mesh node per part ("body", "turret", "recoil" / "root") plus "<part>_lod1" and
 *    "<part>_lod2", positions in the part's local frame (meshopt + quantised, decoded to floats here);
 *  - <id>-albedo.webp (sRGB), <id>-normal.webp (tangent space, glTF convention), <id>-orm.webp
 *    (R = player colour mask, G = roughness, B = metalness).
 *
 * New assets: add a SKINS entry and a builder script; vehicles / buildings pick it up by model key + faction.
 */

export interface SkinDef {
  /** File stem in public/models/blender/. */
  id: string;
  /** Model key (sim defs `model`). */
  model: string;
  /** Faction (ModelStyle.faction). */
  faction: string;
}

export const SKINS: SkinDef[] = [
  { id: 'merkava', model: 'mbt', faction: 'israel' },
  { id: 'factory', model: 'factory', faction: 'israel' },
];

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

/** Test / debug hook: register a skin directly. */
export function registerSkin(s: Skin) {
  skins.set(s.def.model + '|' + s.def.faction, s);
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

/**
 * Load every skin (boot, before any model is built). Resolves with the number loaded; never rejects.
 * A skin that is not complete within `timeoutMs` is dropped for the whole session (no mid-match swaps).
 */
export async function loadSkins(base: string, timeoutMs = 20000): Promise<number> {
  if (typeof fetch === 'undefined' || typeof createImageBitmap === 'undefined') return 0;
  if (typeof location !== 'undefined' && /[?&]blender=0\b/.test(location.search)) {
    disabled = true;
    return 0;
  }
  let late = false;
  const dir = `${base}models/blender/`;
  const work = (async () => {
    const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([import('three/addons/loaders/GLTFLoader.js'), import('three/addons/libs/meshopt_decoder.module.js')]);
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    await Promise.all(
      SKINS.map(async (def) => {
        try {
          const [gltf, albedo, normal, orm] = await Promise.all([loader.loadAsync(`${dir}${def.id}.glb`), texture(`${dir}${def.id}-albedo.webp`, true), texture(`${dir}${def.id}-normal.webp`, false), texture(`${dir}${def.id}-orm.webp`, false)]);
          const geos = new Map<string, THREE.BufferGeometry>();
          gltf.scene.updateMatrixWorld(true);
          gltf.scene.traverse((o) => {
            const m = o as THREE.Mesh;
            if (m.isMesh) geos.set(m.name || o.parent?.name || '', dequantize(m.geometry, m.matrixWorld));
          });
          const parts = new Map<string, THREE.BufferGeometry[]>();
          for (const [name, g] of geos) {
            if (/_lod\d$/.test(name)) continue;
            parts.set(name, [g, geos.get(name + '_lod1'), geos.get(name + '_lod2')].filter((x): x is THREE.BufferGeometry => !!x));
          }
          if (!parts.size) throw new Error('no meshes');
          if (late) return;
          registerSkin({ def, parts, albedo, normal, orm });
          console.info(`[glb] skin ${def.id} for ${def.model}|${def.faction}: ${[...parts.keys()].join(', ')}`);
        } catch (e) {
          console.warn(`[glb] skin ${def.id} unavailable, keeping the procedural model`, e);
        }
      }),
    );
  })();
  await Promise.race([work, new Promise((r) => setTimeout(r, timeoutMs))]);
  late = true;
  return skins.size;
}

/**
 * Fresh skin material: the baked maps + the player colour on the orm R mask (multiplied into a neutral
 * grey paint, with the same faint self-light as the procedural team panels). Callers cache it per
 * (skin, team, fog) and add their own fog / wear patches; `variant` names those patches (e.g. fogged or
 * not) and goes into the program cache key, so differently patched copies never share a shader program.
 */
export function skinMaterial(skin: Skin, team: number, variant: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    map: skin.albedo,
    normalMap: skin.normal,
    // glTF tangent-space normals with derivative tangents (as GLTFLoader does)
    normalScale: new THREE.Vector2(1, -1),
    roughnessMap: skin.orm,
    metalnessMap: skin.orm,
    roughness: 1,
    metalness: 1,
  });
  m.name = 'skin:' + skin.def.id;
  const col = new THREE.Color(team);
  const uTeam = { value: new THREE.Vector3(col.r, col.g, col.b).multiplyScalar(1 / 0.62) };
  m.onBeforeCompile = (sh) => {
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
  m.customProgramCacheKey = () => 'blenderSkin|' + variant;
  return m;
}

/**
 * Copy a per-vertex attribute (e.g. the wear / loose-part data `aWear`) onto `dst` from the nearest
 * vertex of the procedural source geometries (same local frame). Grid hash, once per geometry.
 */
export function transferAttr(dst: THREE.BufferGeometry, srcs: THREE.BufferGeometry[], name: string, fill?: (out: Float32Array, i: number, size: number) => void) {
  if (dst.getAttribute(name)) return;
  const list = srcs.filter((g) => g.getAttribute(name));
  if (!list.length) return;
  const size = list[0].getAttribute(name).itemSize;
  const C = 0.02;
  const cells = new Map<string, number[]>();
  const pts: { g: THREE.BufferAttribute; a: THREE.BufferAttribute; i: number }[] = [];
  for (const g of list) {
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const a = g.getAttribute(name) as THREE.BufferAttribute;
    for (let i = 0; i < p.count; i++) {
      const k = `${Math.floor(p.getX(i) / C)},${Math.floor(p.getY(i) / C)},${Math.floor(p.getZ(i) / C)}`;
      let l = cells.get(k);
      if (!l) cells.set(k, (l = []));
      l.push(pts.length);
      pts.push({ g: p, a, i });
    }
  }
  const pos = dst.getAttribute('position') as THREE.BufferAttribute;
  const out = new Float32Array(pos.count * size);
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const cx = Math.floor(x / C);
    const cy = Math.floor(y / C);
    const cz = Math.floor(z / C);
    let best = -1;
    let bd = Infinity;
    for (let r = 1; r <= 3 && best < 0; r++)
      for (let dx = -r; dx <= r; dx++)
        for (let dy = -r; dy <= r; dy++)
          for (let dz = -r; dz <= r; dz++) {
            const l = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
            if (!l) continue;
            for (const j of l) {
              const q = pts[j];
              const d = (q.g.getX(q.i) - x) ** 2 + (q.g.getY(q.i) - y) ** 2 + (q.g.getZ(q.i) - z) ** 2;
              if (d < bd) {
                bd = d;
                best = j;
              }
            }
          }
    if (best >= 0) {
      const q = pts[best];
      for (let c = 0; c < size; c++) out[i * size + c] = q.a.getComponent(q.i, c);
    }
    fill?.(out, i, size);
  }
  dst.setAttribute(name, new THREE.BufferAttribute(out, size));
}

export const triCount = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.attributes.position.count) / 3;
