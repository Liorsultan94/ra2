import * as THREE from 'three';

/*
 * Sector split for frustum culling.
 *
 * The world past the map edge (outskirts ground and city ring, the horizon's terrain ring, forest cards,
 * towns and Canal City's harbour) and the railway were each built as one merged or instanced mesh. Their
 * bounding spheres were huge, so they always passed three's per-object frustum test and every triangle
 * was sent every frame, mostly to be clipped: from the RTS camera almost none of it is on screen.
 *
 * These helpers cut such a mesh into spatial sectors. The pieces share the original vertex buffers (an
 * indexed geometry gets its index reordered sector by sector, one shared index with a draw range per
 * sector; a non-indexed one gets its vertices reordered the same way; instanced meshes are regrouped by
 * instance position) and each piece carries a tight bounding sphere, so three drops the pieces out of
 * view. Same vertices, same material, same shading: what is on screen is drawn exactly as before.
 */

/** `sectorOf(x, z)`: sector key of a point (a triangle's centroid, an instance's position). */
export type SectorOf = (x: number, z: number) => number;

/** Square grid sectors of `size` world units (cell corners at ox + k * size, oz + k * size). */
export function gridSectors(size: number, ox = 0, oz = 0): SectorOf {
  return (x, z) => (Math.floor((z - oz) / size) + 512) * 1024 + Math.floor((x - ox) / size) + 512;
}

/** Wedges round (cx, cz) (`wedges` of them) times rings split at the radii `bands` (ascending). */
export function radialSectors(cx: number, cz: number, wedges: number, bands: number[]): SectorOf {
  return (x, z) => {
    const d = Math.hypot(x - cx, z - cz);
    let b = 0;
    while (b < bands.length && d >= bands[b]) b++;
    const a = Math.atan2(z - cz, x - cx) / (Math.PI * 2) + 1;
    const w = Math.floor(a * wedges) % wedges;
    return b * wedges + w;
  };
}

/**
 * Split a static mesh by the sector of each triangle's centroid. Returns the pieces (in ascending sector
 * order, triangles in their original order within a piece), or `[mesh]` when it all falls in one sector.
 */
export function splitMeshBySector(mesh: THREE.Mesh, sectorOf: SectorOf): THREE.Mesh[] {
  const geo = mesh.geometry;
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const index = geo.index;
  const nTri = Math.floor((index ? index.count : pos.count) / 3);
  if (nTri === 0 || Array.isArray(mesh.material) || geo.groups.length || geo.morphAttributes.position) return [mesh];
  const ia = index ? (index.array as Uint16Array | Uint32Array) : null;
  const key = new Float64Array(nTri);
  const counts = new Map<number, number>();
  for (let t = 0; t < nTri; t++) {
    let x = 0;
    let z = 0;
    for (let k = 0; k < 3; k++) {
      const v = ia ? ia[t * 3 + k] : t * 3 + k;
      x += pos.getX(v);
      z += pos.getZ(v);
    }
    const s = sectorOf(x / 3, z / 3);
    key[t] = s;
    counts.set(s, (counts.get(s) ?? 0) + 1);
  }
  if (counts.size < 2) return [mesh];
  const order = [...counts.keys()].sort((a, b) => a - b);
  const start = new Map<number, number>();
  let acc = 0;
  for (const s of order) {
    start.set(s, acc);
    acc += counts.get(s)!;
  }
  const fill = new Map(start);
  // new slot of each triangle
  const dst = new Uint32Array(nTri);
  for (let t = 0; t < nTri; t++) {
    const at = fill.get(key[t])!;
    dst[t] = at;
    fill.set(key[t], at + 1);
  }
  const attrs: [string, THREE.BufferAttribute][] = [];
  let shared: THREE.BufferAttribute | null = null;
  if (ia) {
    const out = new (ia.constructor as Uint16ArrayConstructor | Uint32ArrayConstructor)(nTri * 3);
    for (let t = 0; t < nTri; t++) {
      const d = dst[t] * 3;
      out[d] = ia[t * 3];
      out[d + 1] = ia[t * 3 + 1];
      out[d + 2] = ia[t * 3 + 2];
    }
    shared = new THREE.BufferAttribute(out, 1);
    for (const [n, a] of Object.entries(geo.attributes)) attrs.push([n, a as THREE.BufferAttribute]);
  } else {
    for (const [n, a0] of Object.entries(geo.attributes)) {
      const a = a0 as THREE.BufferAttribute;
      if ((a as unknown as THREE.InterleavedBufferAttribute).isInterleavedBufferAttribute) return [mesh];
      const w = a.itemSize * 3;
      const src = a.array as Float32Array;
      const out = new (src.constructor as Float32ArrayConstructor)(nTri * w);
      for (let t = 0; t < nTri; t++) out.set(src.subarray(t * w, t * w + w), dst[t] * w);
      const na = new THREE.BufferAttribute(out, a.itemSize, a.normalized);
      na.name = a.name;
      attrs.push([n, na]);
    }
  }
  const p = attrs.find(([n]) => n === 'position')![1];
  const out: THREE.Mesh[] = [];
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  const sharedArr = shared?.array as Uint16Array | Uint32Array | undefined;
  for (const s of order) {
    const i0 = start.get(s)! * 3;
    const i1 = i0 + counts.get(s)! * 3;
    const g = new THREE.BufferGeometry();
    for (const [n, a] of attrs) g.setAttribute(n, a);
    if (shared) g.setIndex(shared);
    g.setDrawRange(i0, i1 - i0);
    // tight bounds over this sector's vertices
    box.makeEmpty();
    for (let i = i0; i < i1; i++) box.expandByPoint(v.fromBufferAttribute(p, sharedArr ? sharedArr[i] : i));
    const sph = new THREE.Sphere();
    box.getCenter(sph.center);
    let r2 = 0;
    for (let i = i0; i < i1; i++) r2 = Math.max(r2, sph.center.distanceToSquared(v.fromBufferAttribute(p, sharedArr ? sharedArr[i] : i)));
    sph.radius = Math.sqrt(r2);
    g.boundingBox = box.clone();
    g.boundingSphere = sph;
    out.push(copyShell(mesh, new THREE.Mesh(g, mesh.material)));
  }
  return out;
}

/**
 * The same for an instanced mesh: one instanced mesh per sector of the instances' positions (instances keep
 * their order), sharing the geometry's vertex buffers; per-instance geometry attributes are sliced.
 */
export function splitInstancesBySector(im: THREE.InstancedMesh, sectorOf: SectorOf): THREE.InstancedMesh[] {
  const n = im.count;
  if (n < 2 || Array.isArray(im.material)) return [im];
  const m = im.instanceMatrix.array as Float32Array;
  const lists = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const s = sectorOf(m[i * 16 + 12], m[i * 16 + 14]);
    let l = lists.get(s);
    if (!l) lists.set(s, (l = []));
    l.push(i);
  }
  if (lists.size < 2) return [im];
  const geo = im.geometry;
  const perInst = Object.entries(geo.attributes).filter(([, a]) => (a as THREE.InstancedBufferAttribute).isInstancedBufferAttribute) as [string, THREE.InstancedBufferAttribute][];
  if (!geo.boundingSphere) geo.computeBoundingSphere();
  if (!geo.boundingBox) geo.computeBoundingBox();
  const out: THREE.InstancedMesh[] = [];
  for (const s of [...lists.keys()].sort((a, b) => a - b)) {
    const l = lists.get(s)!;
    let g = geo;
    if (perInst.length) {
      g = new THREE.BufferGeometry();
      for (const [name, a] of Object.entries(geo.attributes)) g.setAttribute(name, a);
      if (geo.index) g.setIndex(geo.index);
      g.boundingBox = geo.boundingBox;
      g.boundingSphere = geo.boundingSphere;
      for (const [name, a] of perInst) {
        const w = a.itemSize;
        const src = a.array as Float32Array;
        const arr = new (src.constructor as Float32ArrayConstructor)(l.length * w);
        l.forEach((i, k) => arr.set(src.subarray(i * w, i * w + w), k * w));
        g.setAttribute(name, new THREE.InstancedBufferAttribute(arr, w, a.normalized, a.meshPerAttribute));
      }
    }
    const sub = new THREE.InstancedMesh(g, im.material, l.length);
    const sm = sub.instanceMatrix.array as Float32Array;
    l.forEach((i, k) => sm.set(m.subarray(i * 16, i * 16 + 16), k * 16));
    if (im.instanceColor) {
      const src = im.instanceColor.array as Float32Array;
      const cols = new Float32Array(l.length * 3);
      l.forEach((i, k) => cols.set(src.subarray(i * 3, i * 3 + 3), k * 3));
      sub.instanceColor = new THREE.InstancedBufferAttribute(cols, 3);
    }
    sub.computeBoundingSphere();
    sub.computeBoundingBox();
    out.push(copyShell(im, sub));
  }
  return out;
}

/** Copy a mesh's object state (name, shadows, render order, hooks, transform...) onto a sector piece. */
function copyShell<T extends THREE.Mesh>(src: THREE.Mesh, dst: T): T {
  dst.name = src.name;
  dst.castShadow = src.castShadow;
  dst.receiveShadow = src.receiveShadow;
  dst.renderOrder = src.renderOrder;
  dst.frustumCulled = src.frustumCulled;
  dst.visible = src.visible;
  dst.layers.mask = src.layers.mask;
  dst.userData = src.userData;
  dst.onBeforeRender = src.onBeforeRender;
  dst.onAfterRender = src.onAfterRender;
  dst.customDepthMaterial = src.customDepthMaterial;
  dst.customDistanceMaterial = src.customDistanceMaterial;
  dst.position.copy(src.position);
  dst.quaternion.copy(src.quaternion);
  dst.scale.copy(src.scale);
  dst.matrixAutoUpdate = src.matrixAutoUpdate;
  dst.matrix.copy(src.matrix);
  return dst;
}

/** Replace `obj` in its parent by the sector pieces (in place, same position in the child list). */
export function replaceBySectors(parent: THREE.Object3D, obj: THREE.Mesh, pieces: THREE.Mesh[]) {
  if (pieces.length === 1 && pieces[0] === obj) return;
  const i = parent.children.indexOf(obj);
  if (i < 0) {
    parent.add(...pieces);
    return;
  }
  parent.remove(obj);
  for (const p of pieces) {
    p.parent = parent;
    p.dispatchEvent({ type: 'added' });
  }
  parent.children.splice(i, 0, ...pieces);
}
