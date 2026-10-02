import * as THREE from 'three';
import { standHeight, type GameMap } from '../sim/map';
import type { Effects } from './effects';

/*
 * Building fracture (Red Alert 3 style collapse).
 *
 * When a building is destroyed its merged, per-material meshes are cut into
 * 12-30 rough "Voronoi" chunks: big triangles are bisected until they are
 * smaller than a chunk, then every triangle goes to the nearest of N seed
 * points (k-means over the surface, so chunks have similar areas). The
 * result - one geometry per source mesh, positions stored relative to their
 * chunk's pivot plus a chunk-id attribute - is built once per building
 * template (lazily, or ahead of time in idle callbacks once a building is
 * badly damaged) and shared by every wreck of that template.
 *
 * A wreck draws with the SAME number of draw calls as the intact building:
 * each material is cloned once per wreck with a vertex-shader patch that
 * moves every vertex by its chunk's transform (two vec4 uniform arrays:
 * rotation quaternion + position), plus a matching depth material so the
 * falling pieces cast shadows. Chunks are driven by a tiny CPU rigid-body
 * sim (gravity, launch impulse, spin, bouncy / frictional terrain contact
 * against standHeight + a coarse rubble heightfield so pieces pile up). The
 * total number of moving bodies is capped (pool) for phones; when the pool
 * is full the renderer falls back to the old sink-and-crumble collapse.
 */

/** Chunk slots per wreck (size of the shader uniform arrays). Slot 0 is the static ground pad. */
export const FR_SLOTS = 32;
const PAD_Y = 0.065;
const KEEP_ATTR = ['position', 'normal', 'uv', 'uv1', 'color'];

interface SrcMesh {
  mesh: THREE.Mesh;
  m: THREE.Matrix4;
}

interface FracTemplate {
  /** Per source mesh (traversal order): the chunked geometry, or null when the mesh had no usable triangles. */
  geos: (THREE.BufferGeometry | null)[];
  /** Chunk count including the pad slot 0. */
  n: number;
  /** Rest pivot (bbox centre) per chunk, xyz. */
  c: Float32Array;
  /** Half extents per chunk, xyz. */
  ext: Float32Array;
  area: Float32Array;
  top: number;
  tris: number;
  ms: number;
}

interface Body {
  members: number[];
  /** Offsets of the members' pivots from the body pivot (rest frame). */
  off: Float32Array;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  wx: number;
  wy: number;
  wz: number;
  hx: number;
  hy: number;
  hz: number;
  size: number;
  /** 0 = holding, 1 = leaning with the upper storeys, 2 = free, 3 = at rest. */
  state: number;
  delay: number;
  /** Rest pose (holding / leaning start). */
  rx: number;
  ry: number;
  rz: number;
  restT: number;
  trail: boolean;
  hits: number;
  /** Local axis (0 x, 1 y, 2 z) of a clearly thinnest extent, -1 = blocky. */
  thin: number;
  /** Settling into the pile after coming to rest: current / final depth. */
  sunk: number;
  sinkMax: number;
}

export interface FracStats {
  templates: number;
  wrecks: number;
  bodies: number;
  active: number;
  lastBuildMs: number;
  lastTris: number;
}

// ---------------------------------------------------------------- template building

function rng(seed: number) {
  let a = seed >>> 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function usable(o: THREE.Object3D, root: THREE.Object3D): o is THREE.Mesh {
  const m = o as THREE.Mesh;
  if (!m.isMesh || (o as THREE.InstancedMesh).isInstancedMesh || (o as THREE.SkinnedMesh).isSkinnedMesh) return false;
  const mat = m.material;
  if (!mat || Array.isArray(mat)) return false;
  if ((mat as THREE.ShaderMaterial).isShaderMaterial || mat.blending === THREE.AdditiveBlending) return false;
  if (!m.geometry?.attributes?.position) return false;
  for (let p: THREE.Object3D | null = o; p && p !== root; p = p.parent) if (!p.visible) return false;
  return true;
}

function collect(root: THREE.Object3D): SrcMesh[] {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const out: SrcMesh[] = [];
  root.traverse((o) => {
    if (usable(o, root)) out.push({ mesh: o, m: new THREE.Matrix4().multiplyMatrices(inv, o.matrixWorld) });
  });
  return out;
}

const keyOf = (src: SrcMesh[]) => src.map((s) => s.mesh.geometry.uuid).join(',');

/** Attribute storage for one source mesh while it is being cut. */
class VPool {
  data: number[][];
  sizes: number[];
  count = 0;
  constructor(
    readonly names: string[],
    sizes: number[],
  ) {
    this.sizes = sizes;
    this.data = names.map(() => []);
  }
  mid(a: number, b: number): number {
    for (let k = 0; k < this.names.length; k++) {
      const s = this.sizes[k];
      const d = this.data[k];
      for (let i = 0; i < s; i++) d.push((d[a * s + i] + d[b * s + i]) * 0.5);
    }
    return this.count++;
  }
}

function buildTemplate(src: SrcMesh[], target: number, seed: number): FracTemplate {
  const t0 = performance.now();
  const pools: VPool[] = [];
  const triLists: number[][] = [];
  const nm = new THREE.Matrix3();
  const v = new THREE.Vector3();
  // 1. gather every triangle in root-local space
  let minX = 1e9,
    minY = 1e9,
    minZ = 1e9,
    maxX = -1e9,
    maxY = -1e9,
    maxZ = -1e9;
  let areaSum = 0;
  for (const s of src) {
    const g = s.mesh.geometry;
    const names = KEEP_ATTR.filter((n) => g.attributes[n] && g.attributes[n].itemSize <= 4);
    const sizes = names.map((n) => g.attributes[n].itemSize);
    const pool = new VPool(names, sizes);
    const pa = g.attributes.position;
    pool.count = pa.count;
    nm.getNormalMatrix(s.m);
    for (let k = 0; k < names.length; k++) {
      const a = g.attributes[names[k]] as THREE.BufferAttribute;
      const d = pool.data[k];
      const sz = sizes[k];
      for (let i = 0; i < a.count; i++) {
        if (names[k] === 'position') {
          v.fromBufferAttribute(a, i).applyMatrix4(s.m);
          d.push(v.x, v.y, v.z);
          if (v.x < minX) minX = v.x;
          if (v.y < minY) minY = v.y;
          if (v.z < minZ) minZ = v.z;
          if (v.x > maxX) maxX = v.x;
          if (v.y > maxY) maxY = v.y;
          if (v.z > maxZ) maxZ = v.z;
        } else if (names[k] === 'normal') {
          v.fromBufferAttribute(a, i).applyMatrix3(nm).normalize();
          d.push(v.x, v.y, v.z);
        } else for (let c = 0; c < sz; c++) d.push(a.getComponent(i, c));
      }
    }
    const tris: number[] = [];
    const idx = g.index;
    const n = idx ? idx.count : pa.count;
    const P = pool.data[0];
    for (let i = 0; i + 2 < n; i += 3) {
      const a = idx ? idx.getX(i) : i;
      const b = idx ? idx.getX(i + 1) : i + 1;
      const c = idx ? idx.getX(i + 2) : i + 2;
      tris.push(a, b, c);
      areaSum += triArea(P, a, b, c);
    }
    pools.push(pool);
    triLists.push(tris);
  }
  const top = maxY;
  // 2. bisect big triangles so walls and roofs break into several pieces
  const spacing = Math.sqrt(Math.max(0.01, areaSum) / target);
  let L = spacing * 0.55;
  const CAP = 70000;
  let total = 0;
  for (const t of triLists) total += t.length / 3;
  if (total > CAP * 0.8) L = spacing * 2; // already dense: barely subdivide
  const L2 = L * L;
  const outTris: number[][] = [];
  for (let m = 0; m < pools.length; m++) {
    const pool = pools[m];
    const P = pool.data[0];
    const stack = triLists[m];
    const done: number[] = [];
    while (stack.length) {
      const c = stack.pop()!;
      const b = stack.pop()!;
      const a = stack.pop()!;
      const ab = d2(P, a, b);
      const bc = d2(P, b, c);
      const ca = d2(P, c, a);
      const mx = Math.max(ab, bc, ca);
      if (mx <= L2 || total >= CAP) {
        done.push(a, b, c);
        continue;
      }
      total++;
      // split the longest edge
      if (mx === ab) {
        const mm = pool.mid(a, b);
        stack.push(a, mm, c, mm, b, c);
      } else if (mx === bc) {
        const mm = pool.mid(b, c);
        stack.push(a, b, mm, a, mm, c);
      } else {
        const mm = pool.mid(c, a);
        stack.push(a, b, mm, mm, b, c);
      }
    }
    outTris.push(done);
  }
  // 3. centroids, areas; pad triangles (on the ground slab) stay in slot 0
  let nt = 0;
  for (const t of outTris) nt += t.length / 3;
  const cx = new Float32Array(nt),
    cy = new Float32Array(nt),
    cz = new Float32Array(nt),
    ar = new Float32Array(nt);
  const chunk = new Int16Array(nt);
  {
    let k = 0;
    for (let m = 0; m < pools.length; m++) {
      const P = pools[m].data[0];
      const t = outTris[m];
      for (let i = 0; i < t.length; i += 3, k++) {
        const a = t[i] * 3,
          b = t[i + 1] * 3,
          c = t[i + 2] * 3;
        cx[k] = (P[a] + P[b] + P[c]) / 3;
        cy[k] = (P[a + 1] + P[b + 1] + P[c + 1]) / 3;
        cz[k] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
        ar[k] = triArea(P, t[i], t[i + 1], t[i + 2]);
        chunk[k] = Math.max(P[a + 1], P[b + 1], P[c + 1]) < PAD_Y ? 0 : -1;
      }
    }
  }
  // 4. seeds: k-means over (a sample of) the above-ground triangle centroids, area weighted
  const R = rng(seed);
  const up: number[] = [];
  for (let i = 0; i < nt; i++) if (chunk[i] < 0) up.push(i);
  const K = Math.max(1, Math.min(FR_SLOTS - 1, target - 1, up.length));
  const sample: number[] = [];
  const SMAX = 5000;
  for (let i = 0; i < up.length; i++) if (up.length <= SMAX || R() < SMAX / up.length) sample.push(up[i]);
  // area-weighted initial picks
  let sw = 0;
  for (const i of sample) sw += ar[i] + 1e-6;
  const sx = new Float32Array(K),
    sy = new Float32Array(K),
    sz = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let r = R() * sw;
    let pick = sample[sample.length - 1] ?? 0;
    for (const i of sample) {
      r -= ar[i] + 1e-6;
      if (r <= 0) {
        pick = i;
        break;
      }
    }
    sx[k] = cx[pick] + (R() - 0.5) * 0.01;
    sy[k] = cy[pick];
    sz[k] = cz[pick] + (R() - 0.5) * 0.01;
  }
  const YW = 1.3; // slightly flatter cells: storeys / slabs break off as layers
  const nearest = (i: number) => {
    let best = 0,
      bd = 1e18;
    for (let k = 0; k < K; k++) {
      const dx = cx[i] - sx[k],
        dy = (cy[i] - sy[k]) * YW,
        dz = cz[i] - sz[k];
      const d = dx * dx + dy * dy + dz * dz;
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    return best;
  };
  const ax = new Float64Array(K),
    ay = new Float64Array(K),
    az = new Float64Array(K),
    aw = new Float64Array(K);
  for (let it = 0; it < 5; it++) {
    ax.fill(0);
    ay.fill(0);
    az.fill(0);
    aw.fill(0);
    for (const i of sample) {
      const k = nearest(i);
      const w = ar[i] + 1e-6;
      ax[k] += cx[i] * w;
      ay[k] += cy[i] * w;
      az[k] += cz[i] * w;
      aw[k] += w;
    }
    for (let k = 0; k < K; k++) {
      if (aw[k] <= 0) continue;
      sx[k] = ax[k] / aw[k];
      sy[k] = ay[k] / aw[k];
      sz[k] = az[k] / aw[k];
    }
  }
  for (const i of up) chunk[i] = 1 + nearest(i);
  // compact (drop empty cells)
  const used = new Int16Array(K + 1).fill(-1);
  used[0] = 0;
  let n = 1;
  for (let i = 0; i < nt; i++) if (used[chunk[i]] < 0) used[chunk[i]] = n++;
  for (let i = 0; i < nt; i++) chunk[i] = used[chunk[i]];
  // 5. per chunk bbox -> pivot + half extents
  const bmin = new Float32Array(n * 3).fill(1e9);
  const bmax = new Float32Array(n * 3).fill(-1e9);
  const area = new Float32Array(n);
  {
    let k = 0;
    for (let m = 0; m < pools.length; m++) {
      const P = pools[m].data[0];
      const t = outTris[m];
      for (let i = 0; i < t.length; i += 3, k++) {
        const ch = chunk[k];
        area[ch] += ar[k];
        for (let j = 0; j < 3; j++) {
          const o = t[i + j] * 3;
          for (let a = 0; a < 3; a++) {
            const val = P[o + a];
            if (val < bmin[ch * 3 + a]) bmin[ch * 3 + a] = val;
            if (val > bmax[ch * 3 + a]) bmax[ch * 3 + a] = val;
          }
        }
      }
    }
  }
  const c = new Float32Array(n * 3);
  const ext = new Float32Array(n * 3);
  for (let i = 1; i < n; i++)
    for (let a = 0; a < 3; a++) {
      c[i * 3 + a] = (bmin[i * 3 + a] + bmax[i * 3 + a]) / 2;
      ext[i * 3 + a] = Math.max(0.02, (bmax[i * 3 + a] - bmin[i * 3 + a]) / 2);
    }
  // 6. output geometry per source mesh: non-indexed, positions relative to the chunk pivot
  const geos: (THREE.BufferGeometry | null)[] = [];
  {
    let k = 0;
    for (let m = 0; m < pools.length; m++) {
      const pool = pools[m];
      const t = outTris[m];
      const nv = t.length;
      if (!nv) {
        geos.push(null);
        continue;
      }
      const g = new THREE.BufferGeometry();
      const ch = new Float32Array(nv);
      const arrs = pool.names.map((_, a) => new Float32Array(nv * pool.sizes[a]));
      for (let i = 0; i < nv; i += 3, k++) {
        const cid = chunk[k];
        for (let j = 0; j < 3; j++) {
          const vi = t[i + j];
          const o = i + j;
          ch[o] = cid;
          for (let a = 0; a < pool.names.length; a++) {
            const s = pool.sizes[a];
            const src = pool.data[a];
            const dst = arrs[a];
            for (let q = 0; q < s; q++) dst[o * s + q] = src[vi * s + q] - (a === 0 ? c[cid * 3 + q] : 0);
          }
        }
      }
      pool.names.forEach((nmn, a) => g.setAttribute(nmn, new THREE.BufferAttribute(arrs[a], pool.sizes[a])));
      g.setAttribute('aChunk', new THREE.BufferAttribute(ch, 1));
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e4);
      geos.push(g);
    }
  }
  return { geos, n, c, ext, area, top, tris: nt, ms: performance.now() - t0 };
}

function d2(P: number[], a: number, b: number) {
  const dx = P[a * 3] - P[b * 3],
    dy = P[a * 3 + 1] - P[b * 3 + 1],
    dz = P[a * 3 + 2] - P[b * 3 + 2];
  return dx * dx + dy * dy + dz * dz;
}

function triArea(P: number[], a: number, b: number, c: number) {
  const ux = P[b * 3] - P[a * 3],
    uy = P[b * 3 + 1] - P[a * 3 + 1],
    uz = P[b * 3 + 2] - P[a * 3 + 2];
  const wx = P[c * 3] - P[a * 3],
    wy = P[c * 3 + 1] - P[a * 3 + 1],
    wz = P[c * 3 + 2] - P[a * 3 + 2];
  const x = uy * wz - uz * wy,
    y = uz * wx - ux * wz,
    z = ux * wy - uy * wx;
  return 0.5 * Math.sqrt(x * x + y * y + z * z);
}

// ---------------------------------------------------------------- shader patch

const VERT_PARS = `
attribute float aChunk;
uniform vec4 frQ[ ${FR_SLOTS} ];
uniform vec4 frT[ ${FR_SLOTS} ];
vec3 frRot( vec4 q, vec3 v ) { return v + 2.0 * cross( q.xyz, cross( q.xyz, v ) + q.w * v ); }`;
const VERT_POS = `
{
  int fi = int( aChunk + 0.5 );
  transformed = frRot( frQ[ fi ], transformed ) + frT[ fi ].xyz;
}`;
const VERT_NRM = `
objectNormal = frRot( frQ[ int( aChunk + 0.5 ) ], objectNormal );`;

interface FrUniforms {
  frQ: { value: THREE.Vector4[] };
  frT: { value: THREE.Vector4[] };
  frChar: { value: number };
}

function patchVertex(sh: THREE.WebGLProgramParametersWithUniforms, U: FrUniforms, normals: boolean) {
  sh.uniforms.frQ = U.frQ;
  sh.uniforms.frT = U.frT;
  sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\n' + VERT_PARS).replace('#include <begin_vertex>', '#include <begin_vertex>' + VERT_POS);
  if (normals) sh.vertexShader = sh.vertexShader.replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>' + VERT_NRM);
}

const NEUTRAL_R = [0, 1, 2, 3].map(() => new THREE.Vector4(1, 1, 0, 0));
const NEUTRAL_P = [0, 1, 2, 3].map(() => new THREE.Vector4(99, 0, 0, 0));

function fracMaterial(real: THREE.Material, U: FrUniforms): THREE.Material {
  const c = real.clone();
  c.side = THREE.DoubleSide;
  c.shadowSide = THREE.DoubleSide;
  const prevKey = real.customProgramCacheKey();
  c.onBeforeCompile = (sh, r) => {
    real.onBeforeCompile.call(real, sh, r);
    // construction clip / shell holes of the live building (models/buildfx.ts) make no sense on moving chunks
    if (sh.uniforms.bxClip) sh.uniforms.bxClip = { value: 99 };
    if (sh.uniforms.bxR) sh.uniforms.bxR = { value: NEUTRAL_R };
    if (sh.uniforms.bxP) sh.uniforms.bxP = { value: NEUTRAL_P };
    patchVertex(sh, U, true);
    sh.uniforms.frChar = U.frChar;
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform float frChar;')
      // charred, and the hollow insides of the broken shells read as dark cavities
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.15, 0.135, 0.12 ), frChar ) * ( gl_FrontFacing ? 1.0 : 0.3 );')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance *= 1.0 - frChar;');
  };
  c.customProgramCacheKey = () => 'frac|' + prevKey;
  return c;
}

// ---------------------------------------------------------------- per wreck

const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class FracWreck {
  readonly group = new THREE.Group();
  readonly bodies: Body[] = [];
  private U: FrUniforms;
  t = 0;
  settled = false;
  private surged = false;
  /** Rubble heightfield over the footprint (+ margin), PxP cells. */
  private pile: Float32Array;
  private pw: number;
  private pd: number;
  private lean: { ax: number; az: number; px: number; py: number; pz: number; alpha: number };

  constructor(
    readonly tpl: FracTemplate,
    src: SrcMesh[],
    root: THREE.Object3D,
    nBodies: number,
    private sys: Fracture,
    readonly w: number,
    readonly d: number,
  ) {
    const g = this.group;
    g.position.copy(root.position);
    g.quaternion.copy(root.quaternion);
    g.scale.copy(root.scale);
    g.updateMatrix();
    g.matrixAutoUpdate = true;
    this.U = {
      frQ: { value: Array.from({ length: FR_SLOTS }, () => new THREE.Vector4(0, 0, 0, 1)) },
      frT: { value: Array.from({ length: FR_SLOTS }, () => new THREE.Vector4()) },
      frChar: { value: 0 },
    };
    const U = this.U;
    const depth = new THREE.MeshDepthMaterial();
    depth.onBeforeCompile = (sh) => patchVertex(sh, U, false);
    depth.customProgramCacheKey = () => 'fracdepth';
    const mats = new Map<THREE.Material, THREE.Material>();
    for (let i = 0; i < src.length; i++) {
      const geo = tpl.geos[i];
      if (!geo) continue;
      const sm = src[i].mesh;
      const real = sm.material as THREE.Material;
      let m = mats.get(real);
      if (!m) mats.set(real, (m = fracMaterial(real, U)));
      const mesh = new THREE.Mesh(geo, m);
      mesh.castShadow = sm.castShadow;
      mesh.receiveShadow = sm.receiveShadow;
      mesh.customDepthMaterial = depth;
      mesh.frustumCulled = false;
      mesh.layers.mask = sm.layers.mask;
      mesh.renderOrder = sm.renderOrder;
      g.add(mesh);
    }
    // rest pose for every slot
    for (let i = 0; i < tpl.n; i++) U.frT.value[i].set(tpl.c[i * 3], tpl.c[i * 3 + 1], tpl.c[i * 3 + 2], 0);
    this.pw = Math.max(1, w) + 1.2;
    this.pd = Math.max(1, d) + 1.2;
    this.pile = new Float32Array(36);
    // the upper storeys topple towards a random side
    const a = Math.random() * Math.PI * 2;
    const dx = Math.cos(a),
      dz = Math.sin(a);
    const top = Math.max(0.2, tpl.top);
    const reach = Math.abs(dx) * w * 0.5 + Math.abs(dz) * d * 0.5;
    this.lean = { ax: dz, az: -dx, px: dx * reach * 0.8, py: top * 0.38, pz: dz * reach * 0.8, alpha: 2.2 + Math.random() * 1.6 };
    this.makeBodies(nBodies);
  }

  private makeBodies(nb: number) {
    const tpl = this.tpl;
    const n = tpl.n - 1;
    const c = tpl.c;
    // assign chunks to bodies (1:1 when the pool allows, else farthest-point clusters)
    const groups: number[][] = [];
    if (nb >= n) for (let i = 1; i <= n; i++) groups.push([i]);
    else {
      const seeds = [1 + Math.floor(Math.random() * n)];
      const dist = new Float32Array(tpl.n).fill(1e9);
      while (seeds.length < nb) {
        const s = seeds[seeds.length - 1];
        let far = -1,
          fd = -1;
        for (let i = 1; i <= n; i++) {
          const dd = (c[i * 3] - c[s * 3]) ** 2 + (c[i * 3 + 1] - c[s * 3 + 1]) ** 2 + (c[i * 3 + 2] - c[s * 3 + 2]) ** 2;
          if (dd < dist[i]) dist[i] = dd;
          if (dist[i] > fd) {
            fd = dist[i];
            far = i;
          }
        }
        seeds.push(far);
      }
      for (let k = 0; k < nb; k++) groups.push([]);
      for (let i = 1; i <= n; i++) {
        let best = 0,
          bd = 1e18;
        for (let k = 0; k < nb; k++) {
          const s = seeds[k];
          const dd = (c[i * 3] - c[s * 3]) ** 2 + (c[i * 3 + 1] - c[s * 3 + 1]) ** 2 + (c[i * 3 + 2] - c[s * 3 + 2]) ** 2;
          if (dd < bd) {
            bd = dd;
            best = k;
          }
        }
        groups[best].push(i);
      }
    }
    const top = Math.max(0.2, tpl.top);
    const L = this.lean;
    for (const mem of groups) {
      if (!mem.length) continue;
      let x = 0,
        y = 0,
        z = 0,
        wsum = 0;
      for (const i of mem) {
        const wgt = tpl.area[i] + 1e-4;
        x += c[i * 3] * wgt;
        y += c[i * 3 + 1] * wgt;
        z += c[i * 3 + 2] * wgt;
        wsum += wgt;
      }
      x /= wsum;
      y /= wsum;
      z /= wsum;
      let hx = 0.02,
        hy = 0.02,
        hz = 0.02;
      const off = new Float32Array(mem.length * 3);
      mem.forEach((i, j) => {
        off[j * 3] = c[i * 3] - x;
        off[j * 3 + 1] = c[i * 3 + 1] - y;
        off[j * 3 + 2] = c[i * 3 + 2] - z;
        hx = Math.max(hx, Math.abs(off[j * 3]) + tpl.ext[i * 3]);
        hy = Math.max(hy, Math.abs(off[j * 3 + 1]) + tpl.ext[i * 3 + 1]);
        hz = Math.max(hz, Math.abs(off[j * 3 + 2]) + tpl.ext[i * 3 + 2]);
      });
      // shells are hollow: the contact box is a bit smaller than the bbox so pieces nest into a pile
      hx *= 0.7;
      hy *= 0.6;
      hz *= 0.7;
      const h = y / top;
      const b: Body = {
        members: mem,
        off,
        x,
        y,
        z,
        vx: 0,
        vy: 0,
        vz: 0,
        qx: 0,
        qy: 0,
        qz: 0,
        qw: 1,
        wx: 0,
        wy: 0,
        wz: 0,
        hx,
        hy,
        hz,
        size: Math.cbrt(hx * hy * hz) * 2,
        state: 0,
        delay: 0,
        rx: x,
        ry: y,
        rz: z,
        restT: 0,
        trail: false,
        hits: 0,
        thin: -1,
        sunk: 0,
        sinkMax: 0,
      };
      {
        const e = [hx, hy, hz];
        const lo = e.indexOf(Math.min(hx, hy, hz));
        const mid = [...e].sort((p, q) => p - q)[1];
        if (e[lo] < mid * 0.6) b.thin = lo;
      }
      const r = Math.random();
      // big slabs are too heavy to be thrown far
      const light = Math.min(1, 0.12 / Math.max(0.04, b.size));
      if (r < (0.1 + 0.14 * h) * (0.4 + 0.6 * light)) {
        // blown out by the blast: outward and up, tumbling, trailing smoke
        const ox = x + (Math.random() - 0.5) * 0.2,
          oz = z + (Math.random() - 0.5) * 0.2;
        const len = Math.hypot(ox, oz) || 1;
        const sp = (0.6 + Math.random() * 1.6) * (0.5 + 0.5 * light);
        b.vx = (ox / len) * sp;
        b.vz = (oz / len) * sp;
        b.vy = (1.2 + Math.random() * 2.2) * (0.6 + 0.4 * light);
        b.wx = (Math.random() - 0.5) * 9;
        b.wy = (Math.random() - 0.5) * 6;
        b.wz = (Math.random() - 0.5) * 9;
        b.state = 2;
        b.delay = Math.random() * 0.12;
        b.trail = Math.random() < 0.6;
      } else if (y > L.py && h > 0.4) {
        // upper storeys lean over as one, then break off
        b.state = 1;
        b.delay = 0.35 + Math.random() * 0.55 + (1 - h) * 0.2;
      } else {
        // lower walls slump down and outwards
        b.state = 0;
        b.delay = 0.12 + Math.random() * 0.45 + h * 0.3;
      }
      this.bodies.push(b);
    }
    this.sys.active += this.bodies.length;
  }

  get activeCount() {
    let n = 0;
    for (const b of this.bodies) if (b.state < 3) n++;
    return n;
  }

  /** World position of a random rubble piece (fires, smoke). */
  randomPiece(out: THREE.Vector3): THREE.Vector3 {
    const b = this.bodies[Math.floor(Math.random() * this.bodies.length)];
    if (!b) return out.copy(this.group.position);
    return out.set(b.x, b.y, b.z).applyMatrix4(this.group.matrix);
  }

  private pileAt(x: number, z: number) {
    const i = Math.floor(((x / this.pw) + 0.5) * 6);
    const k = Math.floor(((z / this.pd) + 0.5) * 6);
    if (i < 0 || k < 0 || i > 5 || k > 5) return -1;
    return k * 6 + i;
  }

  private groundAt(x: number, z: number, map: GameMap) {
    const cell = this.pileAt(x, z);
    const pad = Math.abs(x) <= this.w * 0.5 && Math.abs(z) <= this.d * 0.5;
    let base: number;
    if (pad) base = 0.04;
    else {
      _v.set(x, 0, z).applyMatrix4(this.group.matrix);
      const gx = Math.max(0, Math.min(map.w - 0.01, _v.x));
      const gz = Math.max(0, Math.min(map.h - 0.01, _v.z));
      base = standHeight(map, gx, gz) - this.group.position.y;
    }
    return base + (cell >= 0 ? this.pile[cell] : 0);
  }

  /** Returns true while anything still moves. */
  update(dt: number, map: GameMap, fx: Effects, visible: boolean) {
    this.t += dt;
    const U = this.U;
    U.frChar.value = Math.min(0.62, this.t * 0.3);
    if (visible) this.ambient(dt, fx);
    if (this.settled) return false;
    const G = 6.5;
    const L = this.lean;
    let moving = 0;
    for (const b of this.bodies) {
      if (b.state === 3) {
        // rubble beds down into the pile
        if (b.sunk < b.sinkMax) {
          const k = Math.min(b.sinkMax - b.sunk, dt * 0.06);
          b.sunk += k;
          b.y -= k;
          moving++;
        }
        continue;
      }
      moving++;
      if (b.state === 0 || b.state === 1) {
        if (b.state === 1) {
          // rigid lean about the pivot line (axis (ax,0,az) through P)
          const th = 0.5 * L.alpha * this.t * this.t;
          const s = Math.sin(th / 2);
          b.qx = L.ax * s;
          b.qy = 0;
          b.qz = L.az * s;
          b.qw = Math.cos(th / 2);
          _q.set(b.qx, b.qy, b.qz, b.qw);
          _v.set(b.rx - L.px, b.ry - L.py, b.rz - L.pz).applyQuaternion(_q);
          b.x = L.px + _v.x;
          b.y = L.py + _v.y;
          b.z = L.pz + _v.z;
        } else if (visible && Math.random() < dt * 3) fx.dust(...this.world(b.x, b.y - b.hy, b.z), 1.4);
        if (this.t >= b.delay) {
          if (b.state === 1) {
            // inherit the toppling motion: v = w x r
            const om = L.alpha * this.t;
            const rx = b.x - L.px,
              ry = b.y - L.py,
              rz = b.z - L.pz;
            b.wx = L.ax * om + (Math.random() - 0.5) * 2;
            b.wy = (Math.random() - 0.5) * 1.5;
            b.wz = L.az * om + (Math.random() - 0.5) * 2;
            b.vx = -L.az * om * ry;
            b.vy = L.az * om * rx - L.ax * om * rz;
            b.vz = L.ax * om * ry;
            b.vx += (Math.random() - 0.5) * 0.6;
            b.vz += (Math.random() - 0.5) * 0.6;
          } else {
            const len = Math.hypot(b.x, b.z) || 1;
            const sp = 0.35 + Math.random() * 1.1;
            b.vx = (b.x / len) * sp + (Math.random() - 0.5) * 0.4;
            b.vz = (b.z / len) * sp + (Math.random() - 0.5) * 0.4;
            b.vy = Math.random() * 0.8;
            // walls fall outwards: tip about the horizontal axis perpendicular to the way out
            b.wx = (b.z / len) * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2;
            b.wy = (Math.random() - 0.5) * 2;
            b.wz = -(b.x / len) * (2 + Math.random() * 3) + (Math.random() - 0.5) * 2;
          }
          b.state = 2;
        }
        if (b.state !== 2) continue;
      }
      if (this.t < b.delay) continue;
      // free rigid body
      b.vy -= G * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z += b.vz * dt;
      // integrate orientation: q += 0.5 * (w, 0) * q * dt
      const { qx, qy, qz, qw, wx, wy, wz } = b;
      b.qx += 0.5 * dt * (wx * qw + wy * qz - wz * qy);
      b.qy += 0.5 * dt * (wy * qw + wz * qx - wx * qz);
      b.qz += 0.5 * dt * (wz * qw + wx * qy - wy * qx);
      b.qw += 0.5 * dt * (-wx * qx - wy * qy - wz * qz);
      const ql = Math.hypot(b.qx, b.qy, b.qz, b.qw) || 1;
      b.qx /= ql;
      b.qy /= ql;
      b.qz /= ql;
      b.qw /= ql;
      // lowest point of the rotated contact box
      const r10 = 2 * (b.qx * b.qy + b.qw * b.qz);
      const r11 = 1 - 2 * (b.qx * b.qx + b.qz * b.qz);
      const r12 = 2 * (b.qy * b.qz - b.qw * b.qx);
      const low = Math.abs(r10) * b.hx + Math.abs(r11) * b.hy + Math.abs(r12) * b.hz;
      const ground = this.groundAt(b.x, b.z, map);
      if (b.y - low <= ground) {
        b.y = ground + low;
        const speed = Math.hypot(b.vx, b.vy, b.vz);
        if (b.vy < -1.1) {
          if (visible && b.hits < 2) this.impact(b, speed, fx);
          b.hits++;
          b.vy = -b.vy * 0.22;
          b.vx *= 0.55;
          b.vz *= 0.55;
          b.wx *= 0.5;
          b.wy *= 0.5;
          b.wz *= 0.5;
        } else {
          b.vy = 0;
          // slabs and walls do not balance on an edge: tip over towards their flattest face
          if (b.thin >= 0) {
            const { qx: x, qy: y, qz: z, qw: w } = b;
            let ux: number, uy: number, uz: number;
            if (b.thin === 0) {
              ux = 1 - 2 * (y * y + z * z);
              uy = 2 * (x * y + w * z);
              uz = 2 * (x * z - w * y);
            } else if (b.thin === 1) {
              ux = 2 * (x * y - w * z);
              uy = 1 - 2 * (x * x + z * z);
              uz = 2 * (y * z + w * x);
            } else {
              ux = 2 * (x * z + w * y);
              uy = 2 * (y * z - w * x);
              uz = 1 - 2 * (x * x + y * y);
            }
            const sg = uy >= 0 ? 1 : -1;
            const k = 16 * dt;
            b.wx += -uz * sg * k;
            b.wz += ux * sg * k;
            if (Math.abs(uy) < 0.97) b.restT = 0;
          }
          const f = Math.max(0, 1 - 7 * dt);
          b.vx *= f;
          b.vz *= f;
          const fw = Math.max(0, 1 - 6 * dt);
          b.wx *= fw;
          b.wy *= fw;
          b.wz *= fw;
          if (speed < 0.25 && Math.abs(b.wx) + Math.abs(b.wy) + Math.abs(b.wz) < 0.5) b.restT += dt;
          if (b.restT > 0.25) this.rest(b);
        }
      } else if (visible) {
        if (b.trail && Math.random() < dt * 22) fx.smoke(...this.world(b.x, b.y, b.z), 0.45 * Math.min(1.6, b.size * 3), true);
        if (b.vy < -1.5 && Math.random() < dt * 4) {
          const [wx2, wy2, wz2] = this.world(b.x, b.y - b.hy, b.z);
          fx.fire.spawn({ x: wx2, y: wy2, z: wz2, vx: (Math.random() - 0.5) * 2, vy: Math.random() * 1.5, vz: (Math.random() - 0.5) * 2, life: 0.5 + Math.random() * 0.4, size: 0.05, color: 0xffd080, colorEnd: 0xff4000, gravity: 8, drag: 0.4 });
        }
      }
      if (this.t > 9) this.rest(b);
    }
    // push the transforms into the uniform arrays
    for (const b of this.bodies) {
      _q.set(b.qx, b.qy, b.qz, b.qw);
      for (let j = 0; j < b.members.length; j++) {
        const slot = b.members[j];
        _v.set(b.off[j * 3], b.off[j * 3 + 1], b.off[j * 3 + 2]).applyQuaternion(_q);
        U.frQ.value[slot].set(b.qx, b.qy, b.qz, b.qw);
        U.frT.value[slot].set(b.x + _v.x, b.y + _v.y, b.z + _v.z, 0);
      }
    }
    if (!moving) this.settled = true;
    return moving > 0;
  }

  /** Dust surge, crumbling bits, then small fires and lingering smoke over the pile. */
  private ambient(dt: number, fx: Effects) {
    const t = this.t;
    const g = this.group.position;
    const w = this.w,
      d = this.d;
    const rnd = Math.random;
    if (t - dt <= 0 && t > 0) {
      for (let i = 0; i < 14; i++) fx.dust(g.x + (rnd() - 0.5) * w, g.y + 0.1, g.z + (rnd() - 0.5) * d, 3);
    }
    if (!this.surged && t > 0.9) {
      // the upper storeys hit the ground: a rolling dust wave pushes out from the base
      this.surged = true;
      const n = Math.round(30 * fx.rate);
      const R = Math.max(w, d) * 0.5;
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rnd() * 0.2;
        const sp = 1.2 + rnd() * 1.4;
        fx.smokeSys.spawn({ x: g.x + Math.cos(a) * R * 0.8, y: g.y + 0.1, z: g.z + Math.sin(a) * R * 0.8, vx: Math.cos(a) * sp, vy: 0.15 + rnd() * 0.3, vz: Math.sin(a) * sp, life: 2.4 + rnd() * 1.6, size: 0.45, sizeEnd: 1.6 + rnd() * 0.8, color: 0x8a7c66, colorEnd: 0xa89c86, alpha: 0.55, drag: 1.3, wind: 0.5 });
      }
      fx.addShake(0.12, g.x, g.z);
    }
    if (t < 2.4) {
      if (rnd() < dt * 18) fx.dust(g.x + (rnd() - 0.5) * w * 1.1, g.y + 0.1, g.z + (rnd() - 0.5) * d * 1.1, 2.6);
      if (fx.debris && rnd() < dt * 5) {
        this.randomPiece(_v);
        fx.debris.burst('concrete', _v.x, _v.y, _v.z, 2, 1.8, 0.07);
      }
    } else if (t < 30) {
      if (t < 16 && rnd() < dt * 7) {
        this.randomPiece(_v);
        fx.flame(_v.x, _v.y + 0.05, _v.z, 1.1);
      }
      if (rnd() < dt * (t < 12 ? 7 : 3)) {
        this.randomPiece(_v);
        fx.column(_v.x, _v.y + 0.15, _v.z, 1.3);
      }
    }
    if (t > 1 && t < 12) fx.burnGlow(g.x, g.y + 0.4, g.z, 3 * Math.min(1, (12 - t) / 4));
  }

  private rest(b: Body) {
    if (b.state === 3) return;
    b.state = 3;
    b.vx = b.vy = b.vz = b.wx = b.wy = b.wz = 0;
    b.sinkMax = Math.min(0.12, Math.min(b.hx, b.hy, b.hz) * 0.6);
    this.sys.active--;
    const cell = this.pileAt(b.x, b.z);
    if (cell >= 0) this.pile[cell] = Math.min(0.5, this.pile[cell] + b.hy * 0.9);
  }

  private impact(b: Body, speed: number, fx: Effects) {
    const [x, y, z] = this.world(b.x, b.y - b.hy * 0.5, b.z);
    const s = Math.min(2.2, 0.8 + b.size * 4);
    const n = Math.min(4, 1 + Math.floor(speed * 0.6));
    for (let i = 0; i < n; i++) fx.dust(x + (Math.random() - 0.5) * b.hx * 2, y, z + (Math.random() - 0.5) * b.hz * 2, s);
    if (speed > 3 && Math.random() < 0.5) for (let i = 0; i < 5; i++) fx.fire.spawn({ x, y, z, vx: (Math.random() - 0.5) * 3, vy: 1 + Math.random() * 2.5, vz: (Math.random() - 0.5) * 3, life: 0.4 + Math.random() * 0.4, size: 0.045, color: 0xffe0a0, colorEnd: 0xff4000, gravity: 9, drag: 0.5 });
    if (speed > 2.5) fx.addShake(0.02 * Math.min(1, b.size * 3), x, z);
  }

  private world(x: number, y: number, z: number): [number, number, number] {
    _v.set(x, y, z).applyMatrix4(this.group.matrix);
    return [_v.x, _v.y, _v.z];
  }

  dispose() {
    for (const b of this.bodies) if (b.state < 3) this.sys.active--;
    this.bodies.length = 0;
  }
}

// ---------------------------------------------------------------- system

export class Fracture {
  private cache = new Map<string, FracTemplate>();
  private queued = new WeakSet<THREE.Object3D>();
  private idle: { root: THREE.Object3D; target: number }[] = [];
  private idleBusy = false;
  /** Bodies currently moving (all wrecks). */
  active = 0;
  private wrecks = new Set<FracWreck>();
  private lastBuildMs = 0;
  private lastTris = 0;

  constructor(
    private quality: 'low' | 'medium' | 'high',
    /** Cap on simultaneously moving chunks across every collapsing building. */
    readonly maxActive = quality === 'high' ? 120 : quality === 'medium' ? 80 : 0,
  ) {}

  get enabled() {
    return this.maxActive > 0;
  }

  /** Chunk count for a building footprint. */
  targetFor(w: number, d: number) {
    const k = this.quality === 'high' ? 1 : 0.72;
    return Math.max(10, Math.min(FR_SLOTS - 1, Math.round((8 + Math.sqrt(w * d) * 7) * k)));
  }

  private template(root: THREE.Object3D, target: number, src = collect(root), sync = true): FracTemplate | null {
    if (!src.length) return null;
    const key = keyOf(src) + '|' + target;
    let t = this.cache.get(key);
    if (!t) {
      if (!sync) {
        // too heavy to cut inside a frame on this tier: do it in idle time for the next one
        this.prewarm(root, 0, 0, target);
        return null;
      }
      let h = 2166136261;
      for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
      t = buildTemplate(src, target, h >>> 0);
      this.cache.set(key, t);
      this.lastBuildMs = t.ms;
      this.lastTris = t.tris;
    }
    return t;
  }

  /** Cut a badly damaged building's template ahead of time, in idle callbacks (no hitch at the moment of death). */
  prewarm(root: THREE.Object3D, w: number, d: number, target = this.targetFor(w, d)) {
    if (!this.enabled || this.queued.has(root)) return;
    this.queued.add(root);
    this.idle.push({ root, target });
    this.pump();
  }

  private pump() {
    if (this.idleBusy || !this.idle.length) return;
    this.idleBusy = true;
    const run = () => {
      this.idleBusy = false;
      const job = this.idle.shift();
      if (job && job.root.parent) this.template(job.root, job.target);
      this.pump();
    };
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(run, { timeout: 1500 });
    else setTimeout(run, 50);
  }

  /** Break a building model into a rubble wreck. Null = pool exhausted / nothing to cut (caller falls back to the sink collapse). */
  shatter(root: THREE.Object3D, w: number, d: number, scene: THREE.Object3D): FracWreck | null {
    if (!this.enabled) return null;
    const room = this.maxActive - this.active;
    if (room < 6) return null;
    const src = collect(root);
    let tris = 0;
    for (const s of src) tris += (s.mesh.geometry.index?.count ?? s.mesh.geometry.attributes.position.count) / 3;
    // medium (phones): only cut small models synchronously; big ones were normally prewarmed while burning
    const tpl = this.template(root, this.targetFor(w, d), src, this.quality === 'high' || tris < 6000);
    if (!tpl || tpl.n < 3) return null;
    const fw = new FracWreck(tpl, src, root, Math.min(tpl.n - 1, room), this, w, d);
    scene.add(fw.group);
    this.wrecks.add(fw);
    return fw;
  }

  release(fw: FracWreck) {
    fw.dispose();
    fw.group.removeFromParent();
    this.wrecks.delete(fw);
  }

  stats(): FracStats {
    let bodies = 0;
    for (const w of this.wrecks) bodies += w.bodies.length;
    return { templates: this.cache.size, wrecks: this.wrecks.size, bodies, active: this.active, lastBuildMs: Math.round(this.lastBuildMs * 10) / 10, lastTris: this.lastTris };
  }
}
