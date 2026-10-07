import * as THREE from 'three';

/*
 * Small geometry toolkit for the procedural scenery: an accumulating builder
 * (positions, normals, uvs, colours and an optional per-vertex wind "flex"),
 * and a chunked instancer that splits instances into spatial cells so that
 * frustum culling works for map-wide scatter.
 */

export type UvRect = [number, number, number, number];

export class GeoBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = [];
  flex: number[] = [];
  idx: number[] = [];

  get count() {
    return this.pos.length / 3;
  }

  vert(p: THREE.Vector3, n: THREE.Vector3, u: number, v: number, c: THREE.Color | number, flex = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(n.x, n.y, n.z);
    this.uv.push(u, v);
    if (typeof c === 'number') this.col.push(c, c, c);
    else this.col.push(c.r, c.g, c.b);
    this.flex.push(flex);
    return this.count - 1;
  }

  tri(a: number, b: number, c: number) {
    this.idx.push(a, b, c);
  }

  quad(a: number, b: number, c: number, d: number) {
    // a b
    // c d
    this.idx.push(a, c, b, b, c, d);
  }

  /**
   * Append a three.js geometry, transformed by `mat`. UVs are remapped into
   * `rect`; `color` may be a function of the transformed position/normal;
   * `normalFn` can override normals (e.g. spherical canopy normals).
   */
  add(
    geo: THREE.BufferGeometry,
    mat: THREE.Matrix4,
    rect: UvRect | null,
    color: THREE.Color | number | ((p: THREE.Vector3, n: THREE.Vector3) => THREE.Color | number),
    opts: { normalFn?: (p: THREE.Vector3, n: THREE.Vector3) => THREE.Vector3; flexFn?: (p: THREE.Vector3) => number; uvScale?: [number, number] } = {},
  ) {
    const g = geo;
    if (!g.attributes.normal) g.computeVertexNormals();
    const P = g.attributes.position;
    const Nn = g.attributes.normal;
    const U = g.attributes.uv;
    const nm = new THREE.Matrix3().getNormalMatrix(mat);
    const base = this.count;
    const p = new THREE.Vector3();
    const n = new THREE.Vector3();
    for (let i = 0; i < P.count; i++) {
      p.fromBufferAttribute(P, i).applyMatrix4(mat);
      n.fromBufferAttribute(Nn, i).applyMatrix3(nm).normalize();
      const nn = opts.normalFn ? opts.normalFn(p, n) : n;
      let u = U ? U.getX(i) : 0;
      let v = U ? U.getY(i) : 0;
      if (opts.uvScale) {
        u *= opts.uvScale[0];
        v *= opts.uvScale[1];
      }
      if (rect) {
        u = rect[0] + (rect[2] - rect[0]) * (u - Math.floor(u === 1 ? 0 : u));
        v = rect[1] + (rect[3] - rect[1]) * (v - Math.floor(v === 1 ? 0 : v));
      }
      const c = typeof color === 'function' ? color(p, nn) : color;
      this.vert(p, nn, u, v, c, opts.flexFn ? opts.flexFn(p) : 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) this.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < P.count; i++) this.idx.push(base + i);
  }

  build(withFlex = false): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (withFlex) geo.setAttribute('flex', new THREE.Float32BufferAttribute(this.flex, 1));
    geo.setIndex(this.count > 65535 ? new THREE.Uint32BufferAttribute(this.idx, 1) : new THREE.Uint16BufferAttribute(this.idx, 1));
    geo.computeBoundingSphere();
    return geo;
  }

  /**
   * Drop the accumulated arrays once the geometry is built (8 bytes per number in a JS array: a city's
   * builders hold ~20 MB). A builder captured by a closure that outlives its build (a lamp's onBeforeRender
   * keeps the whole building function's scope alive) would otherwise keep them for the rest of the match.
   */
  release() {
    this.pos = [];
    this.nor = [];
    this.uv = [];
    this.col = [];
    this.flex = [];
    this.idx = [];
  }
}

export interface Inst {
  x: number;
  y: number; // height
  z: number;
  rotY: number;
  sx: number;
  sy: number;
  sz: number;
  color?: THREE.Color;
  tiltX?: number;
  tiltZ?: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();

export function instMatrix(i: Inst, out = _m) {
  _e.set(i.tiltX ?? 0, i.rotY, i.tiltZ ?? 0, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(i.x, i.y, i.z);
  _s.set(i.sx, i.sy, i.sz);
  return out.compose(_p, _q, _s);
}

/**
 * Build instanced meshes split into square chunks (in world x/z) so each
 * chunk gets its own bounding sphere and is frustum culled independently.
 */
export function chunkedInstances(
  geo: THREE.BufferGeometry,
  mat: THREE.Material,
  list: Inst[],
  chunk: number,
  opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {},
): THREE.InstancedMesh[] {
  const cells = new Map<string, Inst[]>();
  for (const it of list) {
    const key = `${Math.floor(it.x / chunk)},${Math.floor(it.z / chunk)}`;
    let a = cells.get(key);
    if (!a) cells.set(key, (a = []));
    a.push(it);
  }
  const out: THREE.InstancedMesh[] = [];
  for (const arr of cells.values()) {
    const im = new THREE.InstancedMesh(geo, mat, arr.length);
    arr.forEach((it, k) => {
      im.setMatrixAt(k, instMatrix(it));
      if (it.color) im.setColorAt(k, it.color);
    });
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.castShadow = !!opts.castShadow;
    im.receiveShadow = opts.receiveShadow ?? true;
    im.computeBoundingSphere();
    im.computeBoundingBox();
    if (opts.name) im.name = opts.name;
    out.push(im);
  }
  return out;
}

/**
 * Map-wide instanced mesh whose instances are culled on the CPU by grid
 * cell against the camera's ground footprint: one draw call for the whole
 * map, but only the instances near the view are drawn. Instances are kept
 * sorted by cell so a visible run of cells is a single contiguous copy.
 */
export class CulledInstances {
  readonly mesh: THREE.InstancedMesh;
  private mats: Float32Array;
  private cols: Float32Array | null = null;
  private start: Int32Array;
  private gw: number;
  private gh: number;
  /** Bumped whenever an instance is edited (render-side damage); SceneryLod re-culls then. */
  version = 0;

  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    list: Inst[],
    mapW: number,
    mapH: number,
    private cell = 4,
    opts: { castShadow?: boolean; receiveShadow?: boolean; name?: string } = {},
  ) {
    this.gw = Math.ceil(mapW / cell);
    this.gh = Math.ceil(mapH / cell);
    const key = (it: Inst) => Math.max(0, Math.min(this.gh - 1, Math.floor(it.z / cell))) * this.gw + Math.max(0, Math.min(this.gw - 1, Math.floor(it.x / cell)));
    const sorted = list.map((it, i) => ({ it, k: key(it), i })).sort((a, b) => a.k - b.k || a.i - b.i);
    const n = sorted.length;
    this.mats = new Float32Array(n * 16);
    const hasCol = list.some((it) => it.color);
    if (hasCol) this.cols = new Float32Array(n * 3);
    this.start = new Int32Array(this.gw * this.gh + 1);
    const m4 = new THREE.Matrix4();
    sorted.forEach(({ it, k }, j) => {
      instMatrix(it, m4).toArray(this.mats, j * 16);
      if (this.cols) {
        const c = it.color ?? new THREE.Color(1, 1, 1);
        this.cols[j * 3] = c.r;
        this.cols[j * 3 + 1] = c.g;
        this.cols[j * 3 + 2] = c.b;
      }
      this.start[k + 1]++;
    });
    for (let c = 0; c < this.gw * this.gh; c++) this.start[c + 1] += this.start[c];
    const im = new THREE.InstancedMesh(geo, mat, Math.max(1, n));
    im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    im.instanceMatrix.array.set(this.mats);
    if (this.cols) {
      im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
      im.instanceColor.setUsage(THREE.DynamicDrawUsage);
      (im.instanceColor.array as Float32Array).set(this.cols);
    }
    im.count = n;
    im.frustumCulled = false;
    im.castShadow = !!opts.castShadow;
    im.receiveShadow = opts.receiveShadow ?? true;
    if (opts.name) im.name = opts.name;
    this.mesh = im;
  }

  /** Number of instances (in the internal, cell-sorted order used by the accessors below). */
  get size() {
    return this.mats.length / 16;
  }

  /** World x / z of instance j (its translation). */
  posX(j: number) {
    return this.mats[j * 16 + 12];
  }
  posZ(j: number) {
    return this.mats[j * 16 + 14];
  }

  getMatrix(j: number, out: THREE.Matrix4) {
    return out.fromArray(this.mats, j * 16);
  }

  /** Replace an instance's transform (e.g. a tree knocked over); takes effect on the next cull. */
  setMatrix(j: number, m: THREE.Matrix4) {
    m.toArray(this.mats, j * 16);
    // tilted over (a toppled tree): kept on the full model (see attachFar)
    const e = m.elements;
    const up = e[5] / Math.max(1e-6, Math.hypot(e[4], e[5], e[6]));
    if (up < 0.97) this.forced.add(j);
    else this.forced.delete(j);
    this.version++;
  }

  /** Multiply an instance's colour (e.g. charred by fire). */
  tint(j: number, r: number, g: number, b: number) {
    if (!this.cols) return;
    this.cols[j * 3] *= r;
    this.cols[j * 3 + 1] *= g;
    this.cols[j * 3 + 2] *= b;
    this.version++;
  }

  /** Keep the instances whose cell lies within `margin` of the convex ground polygon `poly` (x/z pairs). */
  cull(poly: ArrayLike<number>, margin: number) {
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      x0 = Math.min(x0, poly[i]);
      x1 = Math.max(x1, poly[i]);
      z0 = Math.min(z0, poly[i + 1]);
      z1 = Math.max(z1, poly[i + 1]);
    }
    const c = this.cell;
    const cx0 = Math.max(0, Math.floor((x0 - margin) / c));
    const cx1 = Math.min(this.gw - 1, Math.floor((x1 + margin) / c));
    const cz0 = Math.max(0, Math.floor((z0 - margin) / c));
    const cz1 = Math.min(this.gh - 1, Math.floor((z1 + margin) / c));
    const reach = margin + c * 0.7072;
    // signed distance of a point to the polygon (assumed convex; either winding)
    const np = poly.length / 2;
    let area = 0;
    for (let i = 0; i < np; i++) {
      const j = (i + 1) % np;
      area += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
    }
    const sgn = area >= 0 ? 1 : -1;
    const inside = (px: number, pz: number) => {
      for (let i = 0; i < np; i++) {
        const j = (i + 1) % np;
        const ex = poly[j * 2] - poly[i * 2];
        const ez = poly[j * 2 + 1] - poly[i * 2 + 1];
        const l = Math.hypot(ex, ez) || 1;
        // outward distance
        const d = (sgn * (ex * (pz - poly[i * 2 + 1]) - ez * (px - poly[i * 2]))) / l;
        if (d < -reach) return false;
      }
      return true;
    };
    const near = this.near;
    near.begin(this.mesh, this.mats, this.cols);
    const far = this.far;
    far?.out.begin(far.mesh, this.mats, this.cols);
    const split = far?.split;
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const k = cz * this.gw + cx;
        const a = this.start[k];
        const b = this.start[k + 1];
        if (a === b) continue;
        const px = (cx + 0.5) * c;
        const pz = (cz + 0.5) * c;
        if (!inside(px, pz)) continue;
        // far LOD (tree impostors): the near and / or the far mesh draw this cell (both while it crossfades)
        const lod = split ? split(px, pz, c) : 1;
        if (lod & 1) near.run(a, b);
        if (lod & 2) far!.out.run(a, b);
        if (!(lod & 1) && far && this.forced.size) far.pending.push(a, b);
      }
    }
    // toppled trees always draw the full model (the impostors only show standing trees)
    if (far && this.forced.size) {
      const pend = far.pending;
      for (const j of this.forced) {
        let draw = false;
        for (let i = 0; i < pend.length; i += 2)
          if (j >= pend[i] && j < pend[i + 1]) {
            draw = true;
            break;
          }
        if (draw) near.run(j, j + 1);
      }
      pend.length = 0;
    }
    near.end();
    far?.out.end();
  }

  private near = new RunWriter();
  private far: { mesh: THREE.InstancedMesh; split: (x: number, z: number, cell: number) => number; out: RunWriter; pending: number[] } | null = null;
  /** Instances drawn by the main mesh whatever their distance (toppled trees). */
  private forced = new Set<number>();

  /**
   * A second, far LOD mesh (tree impostors) fed from the same instances: `split(x, z, cell)` says for a
   * visible cell (centre x, z) whether the main mesh (bit 1), the far mesh (bit 2) or both draw it.
   */
  attachFar(mesh: THREE.InstancedMesh, split: (x: number, z: number, cell: number) => number) {
    this.far = { mesh, split, out: new RunWriter(), pending: [] };
    this.version++;
  }

  /** Replace an instance's colour (asset swap: new tints). */
  setColor(j: number, r: number, g: number, b: number) {
    if (!this.cols) return;
    this.cols[j * 3] = r;
    this.cols[j * 3 + 1] = g;
    this.cols[j * 3 + 2] = b;
    this.version++;
  }
}

/** Copies runs of instances (matrices + colours) into an instanced mesh's buffers. */
class RunWriter {
  private im: THREE.InstancedMesh | null = null;
  private mats: Float32Array | null = null;
  private cols: Float32Array | null = null;
  private n = 0;
  private a = -1;
  private b = -1;
  begin(im: THREE.InstancedMesh, mats: Float32Array, cols: Float32Array | null) {
    this.im = im;
    this.mats = mats;
    this.cols = cols;
    this.n = 0;
    this.a = this.b = -1;
  }
  /** Add instances [a, b) (joined with the previous run when contiguous). */
  run(a: number, b: number) {
    if (a === this.b) this.b = b;
    else {
      this.flush();
      this.a = a;
      this.b = b;
    }
  }
  flush() {
    if (this.a >= 0 && this.b > this.a) {
      const im = this.im!;
      (im.instanceMatrix.array as Float32Array).set(this.mats!.subarray(this.a * 16, this.b * 16), this.n * 16);
      if (im.instanceColor && this.cols) (im.instanceColor.array as Float32Array).set(this.cols.subarray(this.a * 3, this.b * 3), this.n * 3);
      this.n += this.b - this.a;
    }
    this.a = this.b = -1;
  }
  end() {
    this.flush();
    const im = this.im!;
    const n = this.n;
    im.count = n;
    im.instanceMatrix.clearUpdateRanges();
    im.instanceMatrix.addUpdateRange(0, n * 16);
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) {
      im.instanceColor.clearUpdateRanges();
      im.instanceColor.addUpdateRange(0, n * 3);
      im.instanceColor.needsUpdate = true;
    }
  }
}

/**
 * Zoom-driven level of detail and view culling for the scenery. The
 * renderer uses an orthographic camera, so detail depends on how many world
 * units the view spans rather than on per-object distance: when zoomed out,
 * meshes swap to lighter geometry and the smallest clutter is hidden.
 * `Terrain` feeds the camera in, so the renderer needs no changes.
 */
export class SceneryLod {
  private entries: { meshes: THREE.Mesh[]; hi: THREE.BufferGeometry; lo: THREE.BufferGeometry | null; loSpan: number; hideSpan: number }[] = [];
  private culled: CulledInstances[] = [];
  private versions = 0;
  private state = -1;
  private last = -1;
  /** Last footprint key (footprintKey); the first call always differs. */
  private camKey = new Int32Array(8).fill(-0x7fffffff);

  /**
   * Register meshes: they use `lo` once the view spans more than `loSpan`
   * world units and are hidden beyond `hideSpan`.
   */
  add(meshes: THREE.Mesh[], hi: THREE.BufferGeometry, lo: THREE.BufferGeometry | null, loSpan: number, hideSpan = Infinity) {
    this.entries.push({ meshes, hi, lo, loSpan, hideSpan });
    this.state = -1;
  }

  /** Swap the models of a registered mesh (assets streamed in). */
  retarget(mesh: THREE.Mesh, hi: THREE.BufferGeometry, lo: THREE.BufferGeometry | null) {
    for (const e of this.entries)
      if (e.meshes.includes(mesh)) {
        e.hi = hi;
        e.lo = lo;
      }
    this.state = -1;
    this.last = -1;
  }

  /** Map-wide instanced scatter, culled to the view by `cull()`. */
  addCulled(ci: CulledInstances, lo: THREE.BufferGeometry | null, loSpan: number, hideSpan = Infinity) {
    this.culled.push(ci);
    this.add([ci.mesh], ci.mesh.geometry, lo, loSpan, hideSpan);
    this.camKey.fill(-0x7fffffff);
  }

  /** View height in world units (orthographic span). */
  update(span: number) {
    // a little hysteresis so a pinch hovering at a threshold doesn't flicker
    if (this.last >= 0 && Math.abs(span - this.last) < 0.4 && this.state >= 0) return;
    this.last = span;
    this.state = 1;
    for (const e of this.entries) {
      const geo = e.lo && span > e.loSpan ? e.lo : e.hi;
      const vis = span <= e.hideSpan;
      for (const m of e.meshes) {
        if (m.geometry !== geo) m.geometry = geo;
        m.visible = vis;
      }
    }
  }

  /**
   * Re-cull the scatter to the camera's footprint on the ground. Cheap when
   * the camera hasn't moved; while panning it refreshes every ~1.5 tiles
   * (the margin hides the step).
   */
  cull(cam: THREE.Camera) {
    if (!this.culled.length) return;
    // footprint on a plane slightly above the ground (tree crowns / roofs)
    const poly = groundFootprint(cam, 0.6, this.poly);
    // (per frame: no allocation; the key is the footprint in 1.5 unit steps)
    const changed = footprintKey(poly, this.camKey);
    let ver = 0;
    for (const ci of this.culled) ver += ci.version;
    if (!changed && ver === this.versions) return;
    this.versions = ver;
    for (const ci of this.culled) ci.cull(poly, 4);
  }
  private poly = new Float64Array(8);
}

const _fv0 = new THREE.Vector3();
const _fv1 = new THREE.Vector3();
const _fray = new THREE.Ray();
const FOOT_CORNERS = [-1, -1, 1, -1, 1, 1, -1, 1];

/** The camera's footprint on the plane y = h: where its four corner rays hit it (x, z pairs, into `out`). */
export function groundFootprint(cam: THREE.Camera, h: number, out: Float64Array): Float64Array {
  cam.updateMatrixWorld();
  for (let k = 0; k < 4; k++) {
    const x = FOOT_CORNERS[k * 2];
    const y = FOOT_CORNERS[k * 2 + 1];
    _fv0.set(x, y, -1).unproject(cam);
    _fv1.set(x, y, 1).unproject(cam);
    _fray.set(_fv0, _fv1.sub(_fv0).normalize());
    const dy = _fray.direction.y;
    const t = Math.abs(dy) > 1e-4 ? (h - _fray.origin.y) / dy : 0;
    _fray.at(Math.max(0, Math.min(1e4, t)), _fv0);
    out[k * 2] = _fv0.x;
    out[k * 2 + 1] = _fv0.z;
  }
  return out;
}

/** Store the footprint quantised to 1.5 units in `key`; true when that changed. */
export function footprintKey(poly: ArrayLike<number>, key: Int32Array): boolean {
  let changed = false;
  for (let i = 0; i < 8; i++) {
    const q = Math.round(poly[i] / 1.5) | 0;
    if (key[i] !== q) {
      key[i] = q;
      changed = true;
    }
  }
  return changed;
}
