import * as THREE from 'three';
import type { FogOfWar } from './fog';

/*
 * Battle-scar meshes (render only), each kind ONE BatchedMesh draw call:
 *
 *  - Pieces: rocks / clods thrown out of craters, and the ruins of
 *    destroyed buildings (rubble heaps, broken wall stubs, floor slabs,
 *    exposed rebar, charred beams). A handful of shared geometries, one
 *    instance per piece with its own matrix and colour. Pieces come in
 *    groups (one crater's clods, one ruin); when the instance budget is
 *    used up the oldest group is removed (its caller bakes a ground splat
 *    in its place, so the ground still remembers it).
 *  - Hulks: burnt-out vehicles. The wreck's meshes are merged once, in
 *    world space, into a single geometry with a per-vertex rust mask and
 *    shade (vertex colour r / g); the per-instance colour carries the rust
 *    level, so the hulks go from charred black to rust brown over the
 *    minutes without touching the geometry again. A vertex budget caps
 *    them: the oldest hulk sinks into the ground and frees its space.
 */

/** Make BatchedMesh materials work with FogOfWar.apply (it computes the world position for instancing only). */
function batchFog<T extends THREE.Material>(fog: FogOfWar, mat: T, key: string, frag?: (s: string) => string): T {
  fog.apply(mat);
  const fogObc = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    fogObc.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader.replace('fogWp = modelMatrix * fogWp;', '#ifdef USE_BATCHING\nfogWp = batchingMatrix * fogWp;\n#endif\nfogWp = modelMatrix * fogWp;');
    if (frag) sh.fragmentShader = frag(sh.fragmentShader);
  };
  mat.customProgramCacheKey = () => 'scars-' + key;
  return mat;
}

function prep(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (k !== 'position' && k !== 'normal') n.deleteAttribute(k);
  n.computeVertexNormals();
  return n;
}

function rockGeo(seed: number, detail: number): THREE.BufferGeometry {
  const g = detail ? new THREE.IcosahedronGeometry(0.5, 0) : new THREE.DodecahedronGeometry(0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const h = Math.sin((Math.round(p.getX(i) * 97) + Math.round(p.getY(i) * 57) * 3 + Math.round(p.getZ(i) * 31) * 7 + seed) * 12.9898) * 43758.5453;
    const k = 0.72 + (h - Math.floor(h)) * 0.5;
    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k * 0.62, p.getZ(i) * k);
  }
  return prep(g);
}

/** A broken wall stub (unit width / height, 0.14 thick), jagged top, base at y = 0. */
function wallGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 0.14, 7, 2, 1).translate(0, 0.5, 0);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    if (y > 0.99) {
      const s = Math.sin(Math.round((x + 0.5) * 7) * 3.7 + 1.1) * 0.5 + 0.5;
      p.setY(i, 0.35 + 0.65 * s * (1 - Math.abs(x) * 0.7));
    } else if (y > 0.4) p.setY(i, 0.3 + Math.sin(Math.round((x + 0.5) * 7) * 2.3) * 0.08);
  }
  return prep(g);
}

/** Exposed rebar: a thin bar bent near the top, base at y = 0, unit length. */
function rebarGeo(): THREE.BufferGeometry {
  const a = new THREE.BoxGeometry(0.03, 0.62, 0.03).translate(0, 0.31, 0);
  const b = new THREE.BoxGeometry(0.03, 0.45, 0.03).translate(0, 0.22, 0).rotateZ(0.7).translate(0, 0.6, 0);
  const pa = prep(a);
  const pb = prep(b);
  const g = new THREE.BufferGeometry();
  for (const k of ['position', 'normal']) {
    const A = pa.getAttribute(k).array as Float32Array;
    const B = pb.getAttribute(k).array as Float32Array;
    const o = new Float32Array(A.length + B.length);
    o.set(A);
    o.set(B, A.length);
    g.setAttribute(k, new THREE.BufferAttribute(o, 3));
  }
  return g;
}

/** A charred timber beam (unit length along x). */
function beamGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.08, 0.09, 4, 1, 1);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) if (Math.abs(p.getX(i)) > 0.49) p.setY(i, p.getY(i) * 0.6 + Math.sin(p.getZ(i) * 40) * 0.01);
  return prep(g);
}

/** A broken floor slab (unit square, 0.1 thick) with a ragged outline. */
function slabGeo(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 0.1, 1, 4, 1, 4);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    if (Math.abs(x) > 0.49 || Math.abs(z) > 0.49) {
      const k = 0.8 + 0.2 * Math.sin(x * 9.1 + z * 13.7);
      p.setX(i, x * k);
      p.setZ(i, z * k);
    }
  }
  return prep(g);
}

export const enum Piece {
  Rock = 0,
  Rock2 = 1,
  Wall = 2,
  Rebar = 3,
  Beam = 4,
  Slab = 5,
}

export interface PieceGroup {
  ids: number[];
  x: number;
  z: number;
  r: number;
  /** Called when the group is evicted to make room (bake a ground splat). */
  onEvict?: () => void;
  /** Rise-in animation: final matrices and how far below they start. */
  rise?: { t: number; dur: number; mats: Float32Array; drop: Float32Array };
}

const _m = new THREE.Matrix4();
const _c = new THREE.Color();

export class ScarPieces {
  readonly mesh: THREE.BatchedMesh;
  private geoIds: number[] = [];
  private groups: PieceGroup[] = [];
  private live = 0;
  readonly max: number;

  constructor(fog: FogOfWar, quality: 'low' | 'medium' | 'high') {
    const geos = [rockGeo(1, 0), rockGeo(7, 1), wallGeo(), rebarGeo(), beamGeo(), slabGeo()];
    let verts = 0;
    for (const g of geos) verts += g.getAttribute('position').count;
    this.max = quality === 'low' ? 500 : quality === 'medium' ? 1100 : 2200;
    const mat = batchFog(fog, new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.93, metalness: 0.02, flatShading: true }), 'pieces');
    this.mesh = new THREE.BatchedMesh(this.max, verts, 0, mat);
    this.mesh.sortObjects = false;
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.castShadow = quality !== 'low';
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'scars-pieces';
    this.mesh.visible = false;
    for (const g of geos) this.geoIds.push(this.mesh.addGeometry(g));
  }

  get count() {
    return this.live;
  }

  /** Begin a group of n pieces: evicts the oldest groups until they fit. */
  begin(n: number, x: number, z: number, r: number, onEvict?: () => void): PieceGroup | null {
    n = Math.min(n, this.max);
    while (this.live + n > this.max && this.groups.length) this.evict(this.groups[0]);
    if (this.live + n > this.max) return null;
    const g: PieceGroup = { ids: [], x, z, r, onEvict };
    this.groups.push(g);
    this.mesh.visible = true;
    return g;
  }

  add(g: PieceGroup, piece: Piece, m: THREE.Matrix4, color: number | THREE.Color) {
    if (this.live >= this.max) return;
    const id = this.mesh.addInstance(this.geoIds[piece]);
    this.mesh.setMatrixAt(id, m);
    this.mesh.setColorAt(id, typeof color === 'number' ? _c.setHex(color) : color);
    g.ids.push(id);
    this.live++;
  }

  /** Let the group's pieces rise out of the ground over dur seconds (ruins settling in as the rubble chunks sink). */
  rise(g: PieceGroup, dur: number, depth: (i: number) => number) {
    const mats = new Float32Array(g.ids.length * 16);
    const drop = new Float32Array(g.ids.length);
    g.ids.forEach((id, i) => {
      this.mesh.getMatrixAt(id, _m);
      _m.toArray(mats, i * 16);
      drop[i] = depth(i);
    });
    g.rise = { t: 0, dur, mats, drop };
    this.applyRise(g);
  }

  private applyRise(g: PieceGroup) {
    const R = g.rise!;
    const k = Math.min(1, R.t / R.dur);
    const e = 1 - (1 - k) * (1 - k);
    g.ids.forEach((id, i) => {
      _m.fromArray(R.mats, i * 16);
      _m.elements[13] -= R.drop[i] * (1 - e);
      this.mesh.setMatrixAt(id, _m);
    });
    if (k >= 1) g.rise = undefined;
  }

  private evict(g: PieceGroup) {
    for (const id of g.ids) this.mesh.deleteInstance(id);
    this.live -= g.ids.length;
    this.groups.splice(this.groups.indexOf(g), 1);
    g.onEvict?.();
  }

  update(dt: number) {
    for (const g of this.groups) if (g.rise) {
      g.rise.t += dt;
      this.applyRise(g);
    }
  }
}

// --------------------------------------------------------------------- hulks

export interface Hulk {
  geoId: number;
  instId: number;
  verts: number;
  x: number;
  y: number;
  z: number;
  size: number;
  born: number;
  sink: number;
  /** Rust level 0..1 written to the instance colour (updated in steps). */
  rust: number;
}

/** Charred steel turning to rust (vertex colour r = rust mask x instance level, g = shade). */
const HULK_COLOR = /* glsl */ `
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  {
    float scN = texture2D( fogNoise, vFogP.xz * 1.9 + vFogP.y * 0.8 ).r;
    float scN2 = texture2D( fogNoise, vFogP.xz * 6.3 - vFogP.y * 2.1 ).g;
    float scRust = smoothstep( 0.32, 0.72, vColor.r + ( scN - 0.5 ) * 0.7 + ( scN2 - 0.5 ) * 0.25 );
    vec3 scChar = vec3( 0.011, 0.0095, 0.0085 ) * ( 0.8 + 0.5 * scN2 );
    vec3 scRustC = mix( vec3( 0.13, 0.042, 0.014 ), vec3( 0.075, 0.03, 0.012 ), scN );
    diffuseColor.rgb = mix( scChar, scRustC, scRust ) * vColor.g;
  }
  #endif
`;

const _v = new THREE.Vector3();
const _nm = new THREE.Matrix3();

export class ScarHulks {
  readonly mesh: THREE.BatchedMesh;
  readonly hulks: Hulk[] = [];
  private maxVerts: number;
  private usedVerts = 0;
  readonly maxHulks: number;

  constructor(fog: FogOfWar, quality: 'low' | 'medium' | 'high') {
    this.maxHulks = quality === 'low' ? 6 : quality === 'medium' ? 14 : 28;
    this.maxVerts = quality === 'low' ? 40000 : quality === 'medium' ? 110000 : 240000;
    const mat = batchFog(fog, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.88, metalness: 0.2 }), 'hulks', (s) => s.replace('#include <color_fragment>', HULK_COLOR));
    this.mesh = new THREE.BatchedMesh(this.maxHulks, this.maxVerts, this.maxVerts * 2, mat);
    this.mesh.sortObjects = false;
    this.mesh.perObjectFrustumCulled = true;
    this.mesh.castShadow = quality !== 'low';
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.mesh.name = 'scars-hulks';
    this.mesh.visible = false;
  }

  get vertsUsed() {
    return this.usedVerts;
  }

  /**
   * Merge the visible meshes under root (world space) into one hulk. Returns null when the model
   * is too big for the budget (the caller keeps the old sink-away behaviour).
   */
  adopt(roots: THREE.Object3D[], x: number, y: number, z: number, size: number, time: number, onEvict: (h: Hulk) => void): Hulk | null {
    const parts: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
    let nv = 0;
    let ni = 0;
    for (const root of roots) {
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const me = o as THREE.Mesh;
        if (!me.isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) return;
        for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return;
        const mat = me.material as THREE.Material;
        if (!mat || Array.isArray(mat) || mat.transparent || (mat as THREE.ShaderMaterial).isShaderMaterial) return;
        const g = me.geometry;
        const pos = g?.getAttribute('position');
        if (!pos || pos.itemSize !== 3) return;
        const cnt = g.drawRange.count === Infinity ? (g.index ? g.index.count : pos.count) : g.drawRange.count;
        if (!cnt) return;
        parts.push({ g, m: me.matrixWorld });
        nv += pos.count;
        ni += g.index ? g.index.count : pos.count;
      });
    }
    if (!parts.length || nv > this.maxVerts * 0.5 || ni > this.maxVerts * 2 * 0.5) return null;
    while ((this.usedVerts + nv > this.maxVerts || this.hulks.length >= this.maxHulks) && this.hulks.length) this.remove(this.hulks[0], onEvict);
    if (this.usedVerts + nv > this.maxVerts) return null;
    // merged geometry
    const P = new Float32Array(nv * 3);
    const N = new Float32Array(nv * 3);
    const C = new Float32Array(nv * 3);
    const I = new Uint32Array(ni);
    let vo = 0;
    let io = 0;
    for (const { g, m } of parts) {
      const pos = g.getAttribute('position');
      const nor = g.getAttribute('normal');
      _nm.getNormalMatrix(m);
      const shade = 0.75 + Math.random() * 0.35;
      const rustBias = Math.random() * 0.35;
      for (let i = 0; i < pos.count; i++) {
        _v.fromBufferAttribute(pos, i).applyMatrix4(m);
        P[(vo + i) * 3] = _v.x;
        P[(vo + i) * 3 + 1] = _v.y;
        P[(vo + i) * 3 + 2] = _v.z;
        const up = _v.y - y;
        if (nor) _v.fromBufferAttribute(nor, i).applyMatrix3(_nm).normalize();
        else _v.set(0, 1, 0);
        N[(vo + i) * 3] = _v.x;
        N[(vo + i) * 3 + 1] = _v.y;
        N[(vo + i) * 3 + 2] = _v.z;
        // rust gathers on top surfaces and low down where water stands; soot stays under overhangs
        const mask = 0.35 + rustBias + Math.max(0, _v.y) * 0.25 + (up < 0.12 ? 0.15 : 0);
        C[(vo + i) * 3] = Math.min(1, mask);
        C[(vo + i) * 3 + 1] = shade * (0.85 + 0.15 * Math.max(0, _v.y));
        C[(vo + i) * 3 + 2] = 1;
      }
      if (g.index) {
        const ix = g.index;
        for (let k = 0; k < ix.count; k++) I[io + k] = ix.getX(k) + vo;
        io += ix.count;
      } else {
        for (let k = 0; k < pos.count; k++) I[io + k] = vo + k;
        io += pos.count;
      }
      vo += pos.count;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(P, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(C, 3));
    geo.setIndex(new THREE.BufferAttribute(I, 1));
    let geoId: number;
    try {
      geoId = this.mesh.addGeometry(geo);
    } catch {
      // fragmented: repack and retry once
      this.mesh.optimize();
      try {
        geoId = this.mesh.addGeometry(geo);
      } catch {
        return null;
      }
    }
    const instId = this.mesh.addInstance(geoId);
    this.mesh.setMatrixAt(instId, _m.identity());
    this.mesh.setColorAt(instId, new THREE.Color(0, 1, 1));
    this.mesh.visible = true;
    const h: Hulk = { geoId, instId, verts: nv, x, y, z, size, born: time, sink: -1, rust: 0 };
    this.hulks.push(h);
    this.usedVerts += nv;
    return h;
  }

  private remove(h: Hulk, onEvict: (h: Hulk) => void) {
    this.mesh.deleteGeometry(h.geoId);
    this.usedVerts -= h.verts;
    this.hulks.splice(this.hulks.indexOf(h), 1);
    onEvict(h);
    // compact so the freed space can be reused
    this.mesh.optimize();
  }

  /** Rust level over time and the sinking of hulks marked for removal. */
  update(time: number, dt: number, rustTime: number, onEvict: (h: Hulk) => void) {
    for (let i = this.hulks.length - 1; i >= 0; i--) {
      const h = this.hulks[i];
      if (h.sink >= 0) {
        h.sink += dt;
        this.mesh.setMatrixAt(h.instId, _m.makeTranslation(0, -h.sink * 0.22, 0));
        if (h.sink > 3) this.remove(h, onEvict);
        continue;
      }
      const r = Math.min(1, (time - h.born) / rustTime);
      if (Math.abs(r - h.rust) > 0.02) {
        h.rust = r;
        this.mesh.setColorAt(h.instId, _c.setRGB(0.15 + r * 1.1, 1, 1));
      }
    }
  }
}
