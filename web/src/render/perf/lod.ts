import * as THREE from 'three';

/**
 * Unit / building cost trimming applied from outside the model builders
 * (they stay untouched; animated parts keep working because nothing is
 * merged or re-parented):
 *
 *  - shadow casters (medium): infantry and tiny parts (antennas, handles,
 *    stowage, rivet strips...) don't cast into the sun shadow map; at play
 *    zoom their shadows are a texel or two. Infantry keep their contact shadow.
 *  - detail LOD: small parts relative to the model are dropped from layer 0
 *    (main view + shadow pass) when the model covers only a few pixels on
 *    screen (far zoom), and come back with hysteresis when zooming in. Using
 *    the layer instead of `visible` leaves the builders' own visibility
 *    animation (flashes, damage states) alone.
 */
export interface LodInfo {
  /** Small meshes hidden at far zoom. */
  detail: THREE.Mesh[];
  /** Model bounding radius (world units, scale applied). */
  radius: number;
  hidden: boolean;
  /** Meshes that cast into the sun shadow map (after the medium trimming). */
  casters: THREE.Mesh[];
  /** Casters currently switched on (off while the model and its shadow are off screen). */
  castOn: boolean;
  kind: 'infantry' | 'vehicle' | 'aircraft' | 'building';
  /** Meshes with geometry LODs: [LOD0, LOD1, LOD2] geometries. */
  swaps: { m: THREE.Mesh; g: THREE.BufferGeometry[] }[];
  /** Current geometry LOD (0 hero .. 2 far). */
  level: number;
}

/**
 * Vehicle geometry LODs (models/vehicles.ts): a template's merged buffers are sorted coarse-first and
 * LOD1 / LOD2 are index subsets sharing the same attributes, registered here by base geometry.
 *  - LOD0 (hero: close zoom, portrait, photo mode): everything;
 *  - LOD1 (battle zoom): without the smallest fittings (bolts, handles, periscope glass ...), the baked
 *    normal / AO atlas keeps the surface detail;
 *  - LOD2 (far): silhouette parts only.
 */
const LODS = new WeakMap<THREE.BufferGeometry, THREE.BufferGeometry[]>();
export function registerLods(base: THREE.BufferGeometry, lods: [THREE.BufferGeometry, THREE.BufferGeometry]) {
  LODS.set(base, lods);
}
/** [LOD1, LOD2] geometries of a base geometry (null: none). */
export const lodGeos = (g: THREE.BufferGeometry) => LODS.get(g) ?? null;
/** Model diameter on screen (CSS px) above which LOD0 is used / below which LOD2 (hysteresis applied). */
export const VEH_LOD0_PX = 240;
export const VEH_LOD2_PX = 40;

const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Classify a freshly built (and scaled) model's meshes. */
export function prepareLod(root: THREE.Object3D, kind: 'infantry' | 'vehicle' | 'aircraft' | 'building', medium: boolean, team: number): LodInfo {
  const tc = _c.setHex(team);
  root.updateMatrixWorld(true);
  const meshes: { m: THREE.Mesh; r: number }[] = [];
  const swaps: LodInfo['swaps'] = [];
  let big = 0;
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || !m.geometry) return;
    const l = LODS.get(m.geometry);
    if (l) swaps.push({ m, g: [m.geometry, l[0], l[1]] });
    const g = m.geometry;
    if (!g.boundingSphere) g.computeBoundingSphere();
    m.getWorldScale(_s);
    const r = (g.boundingSphere?.radius ?? 0) * Math.max(_s.x, _s.y, _s.z);
    meshes.push({ m, r });
    if (r > big) big = r;
  });
  const detail: THREE.Mesh[] = [];
  for (const { m, r } of meshes) {
    // buildings: the builder already split its small parts into dedicated detail meshes (models/buildings.ts)
    if (m.userData.lodDetail) {
      if (medium) m.castShadow = false;
      detail.push(m);
      continue;
    }
    if (medium && m.castShadow && (kind === 'infantry' || r < (kind === 'building' ? 0.07 : 0.045))) m.castShadow = false;
    // infantry are a handful of merged skinned meshes: nothing to drop
    if (kind === 'infantry' || (m as THREE.InstancedMesh).isInstancedMesh || r >= Math.max(kind === 'building' ? 0.09 : 0.05, big * 0.14)) continue;
    // team colour panels / stripes and lights stay: they carry the readability at far zoom
    const mat = m.material as THREE.MeshStandardMaterial;
    if (Array.isArray(m.material) || !mat || mat.transparent) continue;
    if (mat.color && Math.abs(mat.color.r - tc.r) + Math.abs(mat.color.g - tc.g) + Math.abs(mat.color.b - tc.b) < 0.12) continue;
    if (mat.emissive && mat.emissiveIntensity > 0 && mat.emissive.r + mat.emissive.g + mat.emissive.b > 0.05) continue;
    detail.push(m);
  }
  const casters = meshes.filter((x) => x.m.castShadow).map((x) => x.m);
  return { detail, radius: big, hidden: false, casters, castOn: true, kind, swaps, level: 0 };
}

/**
 * Show / hide the detail meshes from the model's on-screen size (CSS px per
 * world unit at the model); hysteresis keeps it from flickering at the edge.
 */
export function applyLod(info: LodInfo, pxPerUnit: number) {
  const px = pxPerUnit * info.radius * 2;
  if (info.swaps.length) {
    const cur = info.level;
    const lv = cur === 0 ? (px < VEH_LOD0_PX * 0.88 ? (px < VEH_LOD2_PX ? 2 : 1) : 0) : cur === 1 ? (px > VEH_LOD0_PX ? 0 : px < VEH_LOD2_PX ? 2 : 1) : px > VEH_LOD2_PX * 1.15 ? (px > VEH_LOD0_PX ? 0 : 1) : 2;
    if (lv !== cur) setGeoLod(info, lv);
  }
  // buildings: drop the detail meshes once a tile is only ~20 px across (strategic zoom)
  const hide = info.kind === 'building' ? (info.hidden ? pxPerUnit < 26 : pxPerUnit < 21) : info.hidden ? px < 30 : px < 24;
  if (hide === info.hidden || !info.detail.length) return;
  info.hidden = hide;
  for (const m of info.detail) setHidden(m, HIDE_LOD, hide);
}

/** Switch a model to geometry LOD lv (0 hero .. 2 far). */
export function setGeoLod(info: LodInfo, lv: number) {
  info.level = lv;
  for (const e of info.swaps) e.m.geometry = e.g[lv];
}

/** Reasons a mesh is kept off layer 0 (main view + shadow pass); it is drawn again once none is left. */
export const HIDE_LOD = 1;
export const HIDE_INSTANCED = 2;

/** Hide / show a mesh from the main view and the shadow pass for one reason (outline / heat / x-ray layers untouched). */
export function setHidden(m: THREE.Object3D, reason: number, on: boolean) {
  const prev = (m.userData.hide as number | undefined) ?? 0;
  const next = on ? prev | reason : prev & ~reason;
  if (next === prev) return;
  m.userData.hide = next;
  if (next) m.layers.disable(0);
  else m.layers.enable(0);
}

/** Put every mesh of a model back on layer 0 (before it becomes a wreck / rubble that copies its layers). */
export function restoreMain(root: THREE.Object3D) {
  root.traverse((o) => {
    if (o.userData.hide) {
      o.userData.hide = 0;
      o.layers.enable(0);
    }
  });
}

/** Switch the model's shadow casters on / off (no-op when unchanged). */
export function setCasting(info: LodInfo, on: boolean) {
  if (on === info.castOn) return;
  info.castOn = on;
  for (const m of info.casters) m.castShadow = on;
}
