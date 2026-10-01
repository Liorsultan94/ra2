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
