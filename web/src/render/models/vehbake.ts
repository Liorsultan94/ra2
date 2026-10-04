import * as THREE from 'three';

/*
 * Per-vehicle detail bake (runs once per vehicle type + nation, at template
 * build time, i.e. during the battle warm-up).
 *
 * 1. Charting: every merged armour mesh of the template (camo, painted and
 *    metal buckets, plus the road wheel / sprocket geometries) is cut into
 *    near-planar charts (flood fill over shared edges, <= 40 deg from the chart
 *    normal), each chart projected on its plane (u horizontal, v up; decks: u
 *    along the hull) and shelf-packed into one square atlas (2 texel gutters).
 *    The packed coordinates go into a second UV set (`uv1`) of the runtime
 *    geometry; the camo pattern keeps its tiling world-space `uv`.
 * 2. GPU bake (one render target, read back once): for each rigid group (hull
 *    with wheels and tracks, each turret with its gun, each wheel shape)
 *    depth maps are rendered from 64 directions (Fibonacci sphere), then the
 *    group's charts are rasterised in atlas space and every texel tests its
 *    position against those depth maps:
 *      - ambient occlusion (cosine weighted, short range falloff, the ground
 *        below counts as a dim bounce);
 *      - convex edge mask (exact distance to the triangle's convex edges,
 *        dihedral angles found while charting) for paint wear;
 *      - a tangent-space normal map: rounded bevels along convex edges plus
 *        procedural armour detail per chart (module seams at ~1 m pitch, bolt
 *        rows along rectangular plates and seams, non-slip grit on decks),
 *        crevices of seams folded into the AO.
 *    A few dilation passes fill the gutters (no seams at mip levels).
 * 3. The atlas (RGBA8: rg = normal xy, b = AO, a = edge wear) becomes a
 *    DataTexture so every renderer (game, cameo, portrait) can use it; the
 *    vehicle materials decode it in wear.ts (bake branch).
 *
 * Results are cached per (vehicle type, nation, atlas size): team / fog
 * variants of a template reuse the texture and the uv1 arrays.
 */

export interface BakeResult {
  tex: THREE.DataTexture;
  size: number;
  /** Texels per root-space unit. */
  density: number;
  charts: number;
  ms: number;
}

interface CacheEntry {
  res: BakeResult;
  uvs: Float32Array[];
  /** Per-vertex panel tone (chart seed 0..1; wear.ts varies the paint per panel). */
  tones: Float32Array[];
}

const cache = new Map<string, CacheEntry>();

let bakeR: THREE.WebGLRenderer | null = null;
let ownR = false;
let atlasSize = 1024;
let enabled = true;

/** Use this renderer for baking (the game's; otherwise a private 1x1 canvas context is created on demand). */
export function setBakeRenderer(r: THREE.WebGLRenderer | null) {
  if (ownR && bakeR && bakeR !== r) {
    bakeR.dispose();
    bakeR.forceContextLoss();
  }
  bakeR = r;
  ownR = false;
}
/** Atlas edge length for new bakes (1024 desktop high, 512 phones / medium). */
export function setBakeSize(n: number) {
  atlasSize = n;
}
export function setBakeEnabled(on: boolean) {
  enabled = on;
}
export const bakeSize = () => atlasSize;

function renderer(): THREE.WebGLRenderer | null {
  if (bakeR) return bakeR;
  if (typeof document === 'undefined') return null;
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    bakeR = new THREE.WebGLRenderer({ canvas: c, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'default' });
    ownR = true;
  } catch {
    bakeR = null;
  }
  return bakeR;
}

// ---------------------------------------------------------------- collect

type Kind = 'camo' | 'D' | 'M';
interface Src {
  mesh: THREE.Mesh;
  kind: Kind;
  /** Rigid group id ('' = not baked, gets the neutral texel). */
  group: string;
  /** Bake-space transform (template root space; identity for wheel shapes). */
  m: THREE.Matrix4;
  /** Part of a gun (under a 'recoil' / 'gunpiv' tag). */
  gun: boolean;
}

const NEUTRAL_TAGS = ['crew', 'crewA', 'crewB', 'hlid', 'whip', 'spin'];

function tagsOf(o: THREE.Object3D): string[] {
  const t = o.userData.tag;
  return typeof t === 'string' ? t.split(' ') : [];
}

function collect(root: THREE.Object3D): Src[] {
  const out: Src[] = [];
  root.updateMatrixWorld(true);
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const inst = (mesh as THREE.InstancedMesh).isInstancedMesh;
    let kind: Kind | null = null;
    if (inst) {
      if (tagsOf(mesh).includes('wheels')) kind = 'D';
    } else {
      const bk = mesh.userData.bk as string | undefined;
      kind = bk === 's-1' ? 'camo' : bk === 'D' ? 'D' : bk === 'M' ? 'M' : null;
    }
    if (!kind) return;
    let group = 'hull';
    let neutral = false;
    let gun = false;
    for (let q: THREE.Object3D | null = mesh; q && q !== root; q = q.parent) {
      const tg = tagsOf(q);
      if (tg.some((t) => NEUTRAL_TAGS.includes(t))) neutral = true;
      if (tg.includes('recoil') || tg.includes('gunpiv')) gun = true;
      if (group === 'hull' && tg.includes('turret')) group = 't:' + q.uuid;
    }
    if (inst) group = 'w:' + mesh.geometry.uuid;
    if (neutral) group = '';
    const g = mesh.geometry;
    if (g.index || !g.attributes.position) group = '';
    out.push({ mesh, kind, group, gun, m: inst ? new THREE.Matrix4() : mesh.matrixWorld.clone() });
  });
  return out;
}

// ---------------------------------------------------------------- charting

interface Chart {
  src: number;
  tris: number[];
  /** Projection basis. */
  U: THREE.Vector3;
  V: THREE.Vector3;
  N: THREE.Vector3;
  u0: number;
  v0: number;
  u1: number;
  v1: number;
  area: number;
  /** Packed rect (texels) and orientation. */
  x: number;
  y: number;
  w: number;
  h: number;
  rot: boolean;
  /** Density scale (hidden / downward charts get fewer texels) and "too small: neutral texel" flag. */
  k: number;
  tiny: boolean;
  /** Procedural detail: 0 none, 1 armour panels (camo), 2 painted fitting, 3 metal. */
  style: number;
  seam: number;
  bolts: number;
  seed: number;
}

interface SrcData {
  /** Bake-space positions (3 per vertex) and face normals (3 per triangle). */
  P: Float32Array;
  FN: Float32Array;
  /** Per triangle edge (3 per triangle, edge i is opposite vertex i): convexity -1 (concave) .. 1 (sharp convex). */
  E: Float32Array;
  /** Chart index per triangle. */
  C: Int32Array;
  /** Per vertex chart coords (u, v world units). */
  CU: Float32Array;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();

function analyse(s: Src, si: number, charts: Chart[]): SrcData {
  const g = s.mesh.geometry;
  const pos = g.attributes.position;
  const nv = pos.count;
  const nt = Math.floor(nv / 3);
  const P = new Float32Array(nv * 3);
  for (let i = 0; i < nv; i++) {
    _a.fromBufferAttribute(pos, i).applyMatrix4(s.m);
    P[i * 3] = _a.x;
    P[i * 3 + 1] = _a.y;
    P[i * 3 + 2] = _a.z;
  }
  const FN = new Float32Array(nt * 3);
  const AR = new Float32Array(nt);
  const CEN = new Float32Array(nt * 3);
  for (let t = 0; t < nt; t++) {
    _a.fromArray(P, t * 9);
    _b.fromArray(P, t * 9 + 3);
    _c.fromArray(P, t * 9 + 6);
    _n.subVectors(_b, _a).cross(_c.clone().sub(_a));
    const l = _n.length();
    AR[t] = l / 2;
    if (l > 1e-12) _n.divideScalar(l);
    else _n.set(0, 1, 0);
    FN[t * 3] = _n.x;
    FN[t * 3 + 1] = _n.y;
    FN[t * 3 + 2] = _n.z;
    CEN[t * 3] = (_a.x + _b.x + _c.x) / 3;
    CEN[t * 3 + 1] = (_a.y + _b.y + _c.y) / 3;
    CEN[t * 3 + 2] = (_a.z + _b.z + _c.z) / 3;
  }
  // shared edges (positions welded at 0.05 mm)
  const q = (i: number) => Math.round(P[i * 3] * 2e4) + ',' + Math.round(P[i * 3 + 1] * 2e4) + ',' + Math.round(P[i * 3 + 2] * 2e4);
  const vk: string[] = new Array(nv);
  for (let i = 0; i < nv; i++) vk[i] = q(i);
  const edges = new Map<string, number[]>();
  const ekey = (t: number, e: number) => {
    const a = vk[t * 3 + ((e + 1) % 3)];
    const b = vk[t * 3 + ((e + 2) % 3)];
    return a < b ? a + '|' + b : b + '|' + a;
  };
  for (let t = 0; t < nt; t++) {
    if (AR[t] < 1e-12) continue;
    for (let e = 0; e < 3; e++) {
      const k = ekey(t, e);
      let l = edges.get(k);
      if (!l) edges.set(k, (l = []));
      l.push(t * 3 + e);
    }
  }
  const E = new Float32Array(nt * 3);
  const nb = new Int32Array(nt * 3).fill(-1);
  for (const l of edges.values()) {
    for (const te of l) {
      const t = Math.floor(te / 3);
      // best neighbour: the one most coplanar (closed boxes: exactly one other)
      let best = -1;
      let bd = -2;
      for (const te2 of l) {
        const t2 = Math.floor(te2 / 3);
        if (t2 === t) continue;
        const d = FN[t * 3] * FN[t2 * 3] + FN[t * 3 + 1] * FN[t2 * 3 + 1] + FN[t * 3 + 2] * FN[t2 * 3 + 2];
        if (d > bd) {
          bd = d;
          best = t2;
        }
      }
      if (best < 0) {
        E[te] = 0.45; // open boundary (plane / open cylinder): a light edge
        continue;
      }
      nb[te] = best;
      const ang = Math.acos(Math.max(-1, Math.min(1, bd)));
      // convex if the neighbour's centroid lies behind this triangle's plane
      const dx = CEN[best * 3] - CEN[t * 3];
      const dy = CEN[best * 3 + 1] - CEN[t * 3 + 1];
      const dz = CEN[best * 3 + 2] - CEN[t * 3 + 2];
      const side = dx * FN[t * 3] + dy * FN[t * 3 + 1] + dz * FN[t * 3 + 2];
      const k = Math.min(1, Math.max(0, (ang - 0.14) / 0.75));
      E[te] = side < 0 ? k : -k;
    }
  }
  // flood-fill charts
  const C = new Int32Array(nt).fill(-1);
  const order = Array.from({ length: nt }, (_, i) => i).sort((x, y) => AR[y] - AR[x]);
  const COS = Math.cos((40 * Math.PI) / 180);
  const stack: number[] = [];
  for (const seed of order) {
    if (C[seed] >= 0) continue;
    const ci = charts.length;
    const N = new THREE.Vector3(FN[seed * 3], FN[seed * 3 + 1], FN[seed * 3 + 2]);
    const acc = N.clone().multiplyScalar(AR[seed] + 1e-9);
    const tris: number[] = [];
    C[seed] = ci;
    stack.push(seed);
    while (stack.length) {
      const t = stack.pop()!;
      tris.push(t);
      for (let e = 0; e < 3; e++) {
        const t2 = nb[t * 3 + e];
        if (t2 < 0 || C[t2] >= 0) continue;
        const d = FN[t2 * 3] * N.x + FN[t2 * 3 + 1] * N.y + FN[t2 * 3 + 2] * N.z;
        if (d < COS) continue;
        C[t2] = ci;
        acc.x += FN[t2 * 3] * AR[t2];
        acc.y += FN[t2 * 3 + 1] * AR[t2];
        acc.z += FN[t2 * 3 + 2] * AR[t2];
        N.copy(acc).normalize();
        stack.push(t2);
      }
    }
    N.copy(acc);
    if (N.lengthSq() < 1e-18) N.set(FN[seed * 3], FN[seed * 3 + 1], FN[seed * 3 + 2]);
    N.normalize();
    // basis: decks / bellies u along the hull (X); walls u horizontal, v up
    const U = new THREE.Vector3();
    const V = new THREE.Vector3();
    if (Math.abs(N.y) > 0.72) {
      U.set(1, 0, 0).addScaledVector(N, -N.x);
      if (U.lengthSq() < 1e-6) U.set(0, 0, 1).addScaledVector(N, -N.z);
      U.normalize();
      V.crossVectors(N, U).normalize();
    } else {
      V.set(0, 1, 0).addScaledVector(N, -N.y).normalize();
      U.crossVectors(V, N).normalize();
    }
    let area = 0;
    for (const t of tris) area += AR[t];
    charts.push({ src: si, tris, U, V, N, u0: 0, v0: 0, u1: 0, v1: 0, area, x: 0, y: 0, w: 0, h: 0, rot: false, k: 1, tiny: false, style: 0, seam: 0, bolts: 0, seed: 0 });
  }
  // chart coordinates per vertex
  const CU = new Float32Array(nv * 2);
  const first = charts.length - new Set(C).size;
  for (let ci = first; ci < charts.length; ci++) {
    const ch = charts[ci];
    let u0 = Infinity;
    let v0 = Infinity;
    let u1 = -Infinity;
    let v1 = -Infinity;
    for (const t of ch.tris) {
      for (let k = 0; k < 3; k++) {
        const i = t * 3 + k;
        const x = P[i * 3];
        const y = P[i * 3 + 1];
        const z = P[i * 3 + 2];
        const u = x * ch.U.x + y * ch.U.y + z * ch.U.z;
        const v = x * ch.V.x + y * ch.V.y + z * ch.V.z;
        CU[i * 2] = u;
        CU[i * 2 + 1] = v;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
    }
    ch.u0 = u0;
    ch.v0 = v0;
    ch.u1 = u1;
    ch.v1 = v1;
  }
  return { P, FN, E, C, CU };
}

/** Paint codes (vertex colours of the painted-detail bucket) that bake as a diamond mesh grille / louvres. */
export const PAINT_MESH = 0x2b2c2d;
export const PAINT_LOUVRE = 0x2d2c2b;
const C_MESH = new THREE.Color(PAINT_MESH);
const C_LOUVRE = new THREE.Color(PAINT_LOUVRE);

let seedK = 0;
function styleCharts(charts: Chart[], srcs: Src[]) {
  for (const ch of charts) {
    const s = srcs[ch.src];
    const L = ch.u1 - ch.u0;
    const H = ch.v1 - ch.v0;
    ch.seed = ((seedK++ * 0.61803398875) % 1 + (ch.u0 * 13.1 + ch.v0 * 7.3)) % 1;
    if (s.group.startsWith('w:')) {
      ch.style = 3;
      continue;
    }
    ch.style = s.kind === 'camo' ? 1 : s.kind === 'D' ? 2 : 3;
    // guns (recoiling barrels, sleeves): no plate seams or bolts
    if (ch.style === 1 && s.gun) ch.style = 2;
    if (ch.style === 2) {
      // grille paints: diamond mesh / louvres baked into the normal + AO
      const col = s.mesh.geometry.attributes.color;
      if (col) {
        const i = ch.tris[0] * 3;
        const m = (c: THREE.Color) => Math.abs(col.getX(i) - c.r) + Math.abs(col.getY(i) - c.g) + Math.abs(col.getZ(i) - c.b) < 0.0015;
        if (m(C_MESH)) ch.style = 4;
        else if (m(C_LOUVRE)) ch.style = 5;
      }
    }
    if (ch.style !== 1) continue;
    const fill = ch.area / Math.max(1e-9, L * H);
    // module seams on long plates (~1 m pitch), not on the deck / roof (hatches and grilles live there)
    if (L > 0.2 && H > 0.035 && Math.abs(ch.N.y) < 0.8) {
      const n = Math.max(2, Math.round(L / 0.135));
      ch.seam = L / n;
    } else if (L > 0.3 && H > 0.12 && ch.N.y > 0.8) {
      // long decks / glacis: welded plate joints every ~1.5 m
      const n = Math.max(2, Math.round(L / 0.21));
      ch.seam = L / n;
    }
    // bolt rows along the long edges of rectangular plates
    if (fill > 0.8 && L > 0.07 && H > 0.03 && Math.abs(ch.N.y) < 0.8) ch.bolts = 1;
    // decks: non-slip grit field
    if (ch.N.y > 0.8 && L > 0.08 && H > 0.06) ch.bolts = 2;
  }
}

/** Shelf packing (rects rotated to lie flat); charts under ~2 texels are left out (tiny: neutral texel). */
function pack(charts: Chart[], S: number, D: number, gut: number): boolean {
  const live: number[] = [];
  charts.forEach((ch, i) => {
    const L = (ch.u1 - ch.u0) * D * ch.k;
    const H = (ch.v1 - ch.v0) * D * ch.k;
    ch.tiny = Math.max(L, H) < 2.2;
    if (ch.tiny) return;
    let w = Math.max(1, Math.ceil(L)) + gut * 2;
    let h = Math.max(1, Math.ceil(H)) + gut * 2;
    ch.rot = h > w;
    if (ch.rot) [w, h] = [h, w];
    ch.w = w;
    ch.h = h;
    live.push(i);
  });
  live.sort((a, b) => charts[b].h - charts[a].h || charts[b].w - charts[a].w);
  // texel block 0..5 x 0..5 is the neutral (unbaked parts) block
  let x = 6;
  let y = 0;
  let shelf = 6;
  for (const i of live) {
    const ch = charts[i];
    if (ch.w > S) return false;
    if (x + ch.w > S) {
      y += shelf;
      x = 0;
      shelf = 0;
    }
    if (y + ch.h > S) return false;
    ch.x = x;
    ch.y = y;
    x += ch.w;
    shelf = Math.max(shelf, ch.h);
  }
  return true;
}

/** Largest density (texels / unit) whose packing fits an S x S atlas. */
function fit(charts: Chart[], S: number, gut: number): number {
  let area = 0;
  for (const ch of charts) area += Math.max(ch.u1 - ch.u0, 0.002) * Math.max(ch.v1 - ch.v0, 0.002) * ch.k * ch.k;
  let D = Math.min(1600, Math.sqrt((0.66 * S * S) / Math.max(1e-6, area)));
  for (let it = 0; it < 40; it++) {
    if (pack(charts, S, D, gut)) return D;
    D *= 0.95;
  }
  return 0;
}

// ---------------------------------------------------------------- shaders

const FIB = /* glsl */ `
uniform int uN;
vec3 fibDir(int i) {
  float k = (float(i) + 0.5) / float(uN);
  float y = 1.0 - 2.0 * k;
  float r = sqrt(max(0.0, 1.0 - y * y));
  float ph = float(i) * 2.399963229728653;
  return vec3(cos(ph) * r, y, sin(ph) * r);
}
void basisOf(vec3 d, out vec3 u, out vec3 v) {
  vec3 a = abs(d.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  u = normalize(cross(a, d));
  v = cross(d, u);
}
vec4 packF(float v) {
  vec4 e = fract(clamp(v, 0.0, 0.99999) * vec4(1.0, 255.0, 65025.0, 16581375.0));
  return e - e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
}
float unpackF(vec4 e) {
  return dot(e, vec4(1.0, 1.0 / 255.0, 1.0 / 65025.0, 1.0 / 16581375.0));
}
`;

const DEPTH_VS = /* glsl */ `
precision highp float;
precision highp int;
in vec3 position;
uniform mat4 modelMatrix;
uniform int uI;
uniform vec3 uC;
uniform float uR;
${FIB}
out float vS;
void main() {
  vec3 d = fibDir(uI);
  vec3 u; vec3 v;
  basisOf(d, u, v);
  vec3 p = (modelMatrix * vec4(position, 1.0)).xyz - uC;
  vS = dot(p, d);
  gl_Position = vec4(dot(p, u) / uR, dot(p, v) / uR, -vS / uR, 1.0);
}`;

const DEPTH_FS = /* glsl */ `
precision highp float;
precision highp int;
uniform int uN;
in float vS;
uniform float uR;
out vec4 oC;
${FIB.replace('uniform int uN;', '')}
void main() { oC = packF(vS / uR * 0.5 + 0.5); }`;

const ATLAS_VS = /* glsl */ `
precision highp float;
in vec3 position;
in vec3 normal;
in vec2 uv1;
in vec2 aC;
in vec4 aCh;
in vec4 aSt;
in vec3 aBary;
in vec3 aAlt;
in vec3 aEdge;
in float aK;
out float vK;
out vec3 vP;
out vec3 vN;
out vec2 vC;
out vec4 vCh;
out vec4 vSt;
out vec3 vBary;
out vec3 vAlt;
out vec3 vEdge;
void main() {
  vP = position;
  vN = normal;
  vC = aC;
  vCh = aCh;
  vSt = aSt;
  vBary = aBary;
  vAlt = aAlt;
  vEdge = aEdge;
  vK = aK;
  gl_Position = vec4(uv1 * 2.0 - 1.0, 0.0, 1.0);
}`;

const ATLAS_FS = /* glsl */ `
precision highp float;
precision highp int;
${FIB}
uniform sampler2D uDepth;
uniform vec3 uC;
uniform float uR;
uniform float uT;
in float vK;
in vec3 vP;
in vec3 vN;
in vec2 vC;
in vec4 vCh;
in vec4 vSt;
in vec3 vBary;
in vec3 vAlt;
in vec3 vEdge;
out vec4 oC;

float hsh(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hsh(i), hsh(i + vec2(1, 0)), f.x), mix(hsh(i + vec2(0, 1)), hsh(i + vec2(1, 1)), f.x), f.y);
}
float dome(float d, float r) { float t = clamp(1.0 - d * d / (r * r), 0.0, 1.0); return sqrt(t); }

// procedural armour detail height (world units) at chart coords c; cav = crevice amount
float detailH(vec2 c, out float cav) {
  cav = 0.0;
  float st = vSt.x;
  if (st > 3.5) {
    vec2 q = c - vCh.xy;
    float L0 = vCh.z - vCh.x;
    float H0 = vCh.w - vCh.y;
    float inF = step(0.003, q.x) * step(q.x, L0 - 0.003) * step(0.003, q.y) * step(q.y, H0 - 0.003);
    if (st < 4.5) {
      // diamond mesh: bars on a 45 deg grid, deep dark holes
      vec2 d = vec2(q.x + q.y, q.x - q.y) / 0.0115;
      vec2 f = min(fract(d), 1.0 - fract(d));
      float bar = 1.0 - smoothstep(0.09, 0.17, min(f.x, f.y));
      cav = (1.0 - bar) * inF;
      return -0.004 * cav;
    }
    // louvres: slanted horizontal slats
    float t = q.y / 0.0075;
    float f = fract(t);
    cav = smoothstep(0.62, 0.98, f) * inF;
    return (-0.0028 * f) * inF;
  }
  if (st < 0.5 || st > 1.5) return 0.0;
  float h = 0.0;
  float seed = vSt.y;
  float L = vCh.z - vCh.x;
  float Hh = vCh.w - vCh.y;
  // module seams (vertical grooves) + a bolt column on each side of a seam
  if (vSt.z > 0.0) {
    float t = (c.x - vCh.x) / vSt.z;
    float k = floor(t + 0.5);
    float d = abs(t - k) * vSt.z;
    float inner = step(0.5, k) * step(k, L / vSt.z - 0.5);
    float g = (1.0 - smoothstep(0.0009, 0.0026, d)) * inner;
    h -= 0.0022 * g;
    cav = max(cav, g);
    // bolts 9 mm either side of the seam every 22 mm
    float by = (c.y - vCh.y - 0.011) / 0.022;
    float bk = floor(by + 0.5);
    float inRow = step(0.0, bk) * step(bk * 0.022 + 0.011, Hh - 0.008);
    float dyb = (by - bk) * 0.022;
    float dxb = abs(d - 0.0085);
    h += 0.002 * dome(length(vec2(dxb, dyb)), 0.0034) * inner * inRow;
  }
  // bolt rows along the edges of rectangular armour plates (grime ring around each head)
  if (vSt.w > 0.5 && vSt.w < 1.5) {
    float pitch = 0.023;
    float ins = 0.0075;
    float bx = (c.x - vCh.x - ins) / pitch;
    float bk = floor(bx + 0.5);
    float inRow = step(0.0, bk) * step(bk * pitch + ins, L - ins + 0.001);
    float dx = (bx - bk) * pitch;
    float by = (c.y - vCh.y - ins) / pitch;
    float bj = floor(by + 0.5);
    float inCol = step(0.0, bj) * step(bj * pitch + ins, Hh - ins + 0.001);
    float dy = (by - bj) * pitch;
    float dT = length(vec2(dx, c.y - (vCh.w - ins)));
    float dB = length(vec2(dx, c.y - (vCh.y + ins)));
    float dL = length(vec2(c.x - (vCh.x + ins), dy));
    float dR = length(vec2(c.x - (vCh.z - ins), dy));
    float dm = min(min(dT, dB) + (1.0 - inRow) * 9.0, min(dL, dR) + (1.0 - inCol) * 9.0);
    h += 0.0016 * dome(dm, 0.0024);
    cav = max(cav, (smoothstep(0.0021, 0.0026, dm) - smoothstep(0.0034, 0.0046, dm)) * 0.75);
  }
  // non-slip grit on decks (inset patch)
  if (vSt.w > 1.5) {
    vec2 q = c - vCh.xy;
    float inP = step(0.018, q.x) * step(q.x, L - 0.018) * step(0.018, q.y) * step(q.y, Hh - 0.018);
    float n = vn(c * 900.0 + seed * 50.0) * 0.6 + vn(c * 2300.0) * 0.4;
    h += inP * 0.00035 * n;
    // patch border groove
    float bd = min(min(abs(q.x - 0.018), abs(q.x - (L - 0.018))), min(abs(q.y - 0.018), abs(q.y - (Hh - 0.018))));
    float onB = step(0.016, q.x) * step(q.x, L - 0.016) * step(0.016, q.y) * step(q.y, Hh - 0.016);
    float gb = (1.0 - smoothstep(0.0005, 0.0018, bd)) * onB;
    h -= 0.0008 * gb;
    cav = max(cav, gb * 0.5);
  }
  return h;
}

void main() {
  vec3 n = normalize(vN);
  // ---------------- ambient occlusion from the depth maps
  vec3 p = vP + n * 0.0035;
  float vis = 0.0;
  float tot = 0.0;
  for (int i = 0; i < 128; i++) {
    if (i >= uN) break;
    vec3 d = fibDir(i);
    float w = dot(n, d);
    if (w <= 0.0) continue;
    vec3 u; vec3 v;
    basisOf(d, u, v);
    vec3 q = p - uC;
    vec2 tc = vec2(dot(q, u), dot(q, v)) / uR * 0.5 + 0.5;
    float col = mod(float(i), uT);
    float row = floor(float(i) / uT);
    vec2 at = (vec2(col, row) + clamp(tc, 0.0, 1.0)) / uT;
    float s = dot(q, d);
    float so = (unpackF(texture(uDepth, at)) * 2.0 - 1.0) * uR;
    // occluder height above this texel along d: near occluders count fully, far ones fade (no hard shadows of the gun)
    float dz = so - s;
    float occ = smoothstep(0.004, 0.012, dz) * (1.0 - smoothstep(0.22, 0.5, dz));
    float sky = d.y < -0.05 ? 0.42 : d.y < 0.1 ? mix(0.42, 1.0, (d.y + 0.05) / 0.15) : 1.0;
    vis += w * (1.0 - occ) * sky;
    tot += w;
  }
  float ao = tot > 0.0 ? vis / tot : 1.0;
  // ---------------- convex edges (paint wear + rounded bevel) and concave creases
  vec3 dist = vBary * vAlt;
  float edge = 0.0;
  float crease = 0.0;
  vec2 gB = vec2(0.0);
  for (int k = 0; k < 3; k++) {
    float e = vEdge[k];
    float dk = dist[k];
    vec2 gd = vec2(dFdx(dk), dFdy(dk)) * vK; // d(dist)/d(world) along atlas x / y
    if (e > 0.0) {
      edge = max(edge, e * (1.0 - smoothstep(0.0015, 0.0055, dk)));
      // bevel: height rises from the edge over 6 mm
      float bw = 0.006;
      if (dk < bw) {
        float t = 1.0 - dk / bw;
        gB += gd * (2.0 * 0.0024 * t / bw) * e;
      }
    } else if (e < 0.0) {
      crease = max(crease, -e * (1.0 - smoothstep(0.0, 0.012, dk)));
    }
  }
  // ---------------- procedural detail -> slope via central differences in chart space
  float cav;
  float cav2;
  float eps = 0.35 / vK;
  float h0 = detailH(vC, cav);
  float hu = detailH(vC + vec2(eps, 0.0), cav2) - detailH(vC - vec2(eps, 0.0), cav2);
  float hv = detailH(vC + vec2(0.0, eps), cav2) - detailH(vC - vec2(0.0, eps), cav2);
  vec2 gC = vec2(hu, hv) / (2.0 * eps);
  // chart coords -> atlas axes (charts may be rotated in the atlas)
  vec2 dcx = dFdx(vC) * vK;
  vec2 dcy = dFdy(vC) * vK;
  vec2 gA = vec2(dot(gC, dcx), dot(gC, dcy)) + gB;
  vec3 nm = normalize(vec3(-gA, 1.0));
  ao *= 1.0 - (vSt.x > 3.5 ? 0.88 : 0.55) * cav;
  ao *= 1.0 - 0.35 * crease;
  oC = vec4(nm.xy * 0.5 + 0.5, clamp(ao, 0.0, 1.0), clamp(edge, 0.0, 1.0));
  // never write the "empty" marker
  if (oC.r < 0.004 && oC.g < 0.004) oC.r = 0.004;
}`;

const QUAD_VS = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const DILATE_FS = /* glsl */ `
precision highp float;
uniform sampler2D uT;
uniform vec2 uPx;
in vec2 vUv;
out vec4 oC;
bool full(vec4 c) { return c.r + c.g > 0.006; }
void main() {
  vec4 c = texture(uT, vUv);
  if (full(c)) { oC = c; return; }
  vec4 s = vec4(0.0);
  float n = 0.0;
  for (int y = -1; y <= 1; y++)
    for (int x = -1; x <= 1; x++) {
      vec4 q = texture(uT, vUv + vec2(float(x), float(y)) * uPx);
      if (full(q)) { s += q; n += 1.0; }
    }
  oC = n > 0.0 ? s / n : vec4(0.0);
}`;

// ---------------------------------------------------------------- bake

const N_DIRS = 64;
const TILE = 256;

function bakeGeometry(s: Src, d: SrcData, charts: Chart[], uv1: Float32Array, D: number): THREE.BufferGeometry {
  const g = s.mesh.geometry;
  const nv = g.attributes.position.count;
  const nt = Math.floor(nv / 3);
  const nor = g.attributes.normal;
  const N = new Float32Array(nv * 3);
  const nm = new THREE.Matrix3().getNormalMatrix(s.m);
  for (let i = 0; i < nv; i++) {
    _a.fromBufferAttribute(nor, i).applyMatrix3(nm).normalize();
    N[i * 3] = _a.x;
    N[i * 3 + 1] = _a.y;
    N[i * 3 + 2] = _a.z;
  }
  const aCh = new Float32Array(nv * 4);
  const aSt = new Float32Array(nv * 4);
  const aBary = new Float32Array(nv * 3);
  const aAlt = new Float32Array(nv * 3);
  const aEdge = new Float32Array(nv * 3);
  const aK = new Float32Array(nv);
  for (let t = 0; t < nt; t++) {
    const ch = charts[d.C[t]] ?? null;
    _a.fromArray(d.P, t * 9);
    _b.fromArray(d.P, t * 9 + 3);
    _c.fromArray(d.P, t * 9 + 6);
    const A2 = _n.subVectors(_b, _a).cross(_c.clone().sub(_a)).length();
    // altitude from vertex k onto the opposite edge
    const la = _b.distanceTo(_c);
    const lb = _c.distanceTo(_a);
    const lc = _a.distanceTo(_b);
    const alt = [A2 / Math.max(1e-9, la), A2 / Math.max(1e-9, lb), A2 / Math.max(1e-9, lc)];
    for (let k = 0; k < 3; k++) {
      const i = t * 3 + k;
      aK[i] = D * (ch ? ch.k : 1);
      if (ch) {
        aCh.set([ch.u0, ch.v0, ch.u1, ch.v1], i * 4);
        aSt.set([ch.style, ch.seed, ch.seam, ch.bolts], i * 4);
      }
      aBary[i * 3 + k] = 1;
      aAlt.set(alt, i * 3);
      aEdge.set([d.E[t * 3], d.E[t * 3 + 1], d.E[t * 3 + 2]], i * 3);
    }
  }
  const bg = new THREE.BufferGeometry();
  bg.setAttribute('position', new THREE.BufferAttribute(d.P, 3));
  bg.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  bg.setAttribute('uv1', new THREE.BufferAttribute(uv1, 2));
  bg.setAttribute('aC', new THREE.BufferAttribute(d.CU, 2));
  bg.setAttribute('aCh', new THREE.BufferAttribute(aCh, 4));
  bg.setAttribute('aSt', new THREE.BufferAttribute(aSt, 4));
  bg.setAttribute('aBary', new THREE.BufferAttribute(aBary, 3));
  bg.setAttribute('aAlt', new THREE.BufferAttribute(aAlt, 3));
  bg.setAttribute('aEdge', new THREE.BufferAttribute(aEdge, 3));
  bg.setAttribute('aK', new THREE.BufferAttribute(aK, 1));
  return bg;
}

/** Neutral texel (unbaked parts: crew, hatch lids, antennas). */
function neutralUV(S: number) {
  return [3 / S, 3 / S];
}

type Occ = Map<string, { g: THREE.BufferGeometry; m: THREE.Matrix4 }[]>;

/** Occluder lists per rigid group (see the header comment). */
function occluders(root: THREE.Object3D): Occ {
  const occ: Occ = new Map();
  const add = (grp: string, g: THREE.BufferGeometry, m: THREE.Matrix4) => {
    let l = occ.get(grp);
    if (!l) occ.set(grp, (l = []));
    l.push({ g, m });
  };
  const hullOcc: { g: THREE.BufferGeometry; m: THREE.Matrix4 }[] = [];
  const turretBoxes = new Map<string, { box: THREE.Box3; piv: THREE.Vector3 }>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry?.attributes.position) return;
    let skip = false;
    let tur = '';
    let turObj: THREE.Object3D | null = null;
    for (let q: THREE.Object3D | null = mesh; q && q !== root; q = q.parent) {
      const tg = tagsOf(q);
      if (tg.some((t) => NEUTRAL_TAGS.includes(t))) skip = true;
      if (!tur && tg.includes('turret')) {
        tur = 't:' + q.uuid;
        turObj = q;
      }
    }
    const mat = mesh.material as THREE.Material;
    if (skip || Array.isArray(mesh.material) || mat.transparent) return;
    const inst = mesh as THREE.InstancedMesh;
    if (inst.isInstancedMesh) {
      const im = new THREE.Matrix4();
      for (let i = 0; i < inst.count; i++) {
        inst.getMatrixAt(i, im);
        hullOcc.push({ g: mesh.geometry, m: mesh.matrixWorld.clone().multiply(im) });
      }
      add('w:' + mesh.geometry.uuid, mesh.geometry, new THREE.Matrix4());
      return;
    }
    const e = { g: mesh.geometry, m: mesh.matrixWorld.clone() };
    if (tur) {
      add(tur, e.g, e.m);
      let tb = turretBoxes.get(tur);
      if (!tb) turretBoxes.set(tur, (tb = { box: new THREE.Box3(), piv: new THREE.Vector3().setFromMatrixPosition(turObj!.matrixWorld) }));
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (mesh.userData.bk === 's-1') tb.box.union(mesh.geometry.boundingBox!.clone().applyMatrix4(mesh.matrixWorld));
    } else hullOcc.push(e);
  });
  for (const e of hullOcc) add('hull', e.g, e.m);
  // turrets see the hull under them; the hull sees a rotation-averaged turret: a drum around the ring
  for (const [tur, tb] of turretBoxes) {
    for (const e of hullOcc) add(tur, e.g, e.m);
    if (tb.box.isEmpty()) continue;
    const hw = Math.min(tb.box.max.z - tb.piv.z, tb.piv.z - tb.box.min.z);
    const rad = Math.max(0.05, hw * 0.92);
    const h = Math.max(0.02, (tb.box.max.y - tb.piv.y) * 0.75);
    add('hull', new THREE.CylinderGeometry(rad, rad, h, 24), new THREE.Matrix4().makeTranslation(tb.piv.x, tb.piv.y + h / 2, tb.piv.z));
  }
  return occ;
}

/** uv1 for every source + the bake geometries of the charted ones, for a packing at density D. */
function layout(srcs: Src[], data: (SrcData | null)[], seenGeo: Map<THREE.BufferGeometry, number>, charts: Chart[], S: number, D: number, gut: number) {
  const [nu, nvv] = neutralUV(S);
  const uvs: Float32Array[] = [];
  const tones: Float32Array[] = [];
  const geos: { g: THREE.BufferGeometry; group: string }[] = [];
  srcs.forEach((s, si) => {
    const nv = s.mesh.geometry.attributes.position.count;
    let uv: Float32Array = new Float32Array(nv * 2);
    let tone: Float32Array = new Float32Array(nv).fill(0.5);
    const d = data[si];
    if (s.group && !d) {
      uv = uvs[seenGeo.get(s.mesh.geometry)!];
      tone = tones[seenGeo.get(s.mesh.geometry)!];
    } else
      for (let i = 0; i < nv; i++) {
        const ch = d ? charts[d.C[Math.floor(i / 3)]] : null;
        if (ch) tone[i] = ch.seed;
        if (!ch || ch.tiny) {
          uv[i * 2] = nu;
          uv[i * 2 + 1] = nvv;
          continue;
        }
        const k = D * ch.k;
        const cu = (d!.CU[i * 2] - ch.u0) * k;
        const cv = (d!.CU[i * 2 + 1] - ch.v0) * k;
        uv[i * 2] = (ch.x + gut + (ch.rot ? cv : cu)) / S;
        uv[i * 2 + 1] = (ch.y + gut + (ch.rot ? cu : cv)) / S;
      }
    if (d) geos.push({ g: bakeGeometry(s, d, charts, uv, D), group: s.group });
    uvs.push(uv);
    tones.push(tone);
  });
  return { uvs, tones, geos };
}

/** GPU passes: depth tiles per group, atlas rasterisation, optional gutter dilation; returns RGBA8 pixels. */
function runGPU(r: THREE.WebGLRenderer, S: number, geos: { g: THREE.BufferGeometry; group: string }[], occ: Occ, dilate: number): Uint8Array {
  const prev = {
    rt: r.getRenderTarget(),
    vp: r.getViewport(new THREE.Vector4()),
    sc: r.getScissor(new THREE.Vector4()),
    st: r.getScissorTest(),
    cc: r.getClearColor(new THREE.Color()),
    ca: r.getClearAlpha(),
    ac: r.autoClear,
  };
  const T = Math.ceil(Math.sqrt(N_DIRS));
  const opt = { depthBuffer: false, stencilBuffer: false, generateMipmaps: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
  const depthRT = new THREE.WebGLRenderTarget(T * TILE, T * TILE, { ...opt, depthBuffer: true });
  const atlasRT = new THREE.WebGLRenderTarget(S, S, opt);
  const pingRT = dilate > 0 ? new THREE.WebGLRenderTarget(S, S, opt) : null;
  const cam = new THREE.OrthographicCamera();
  const depthMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: DEPTH_VS,
    fragmentShader: DEPTH_FS,
    uniforms: { uI: { value: 0 }, uN: { value: N_DIRS }, uC: { value: new THREE.Vector3() }, uR: { value: 1 } },
    side: THREE.DoubleSide,
  });
  const atlasMat = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: ATLAS_VS,
    fragmentShader: ATLAS_FS,
    uniforms: { uN: { value: N_DIRS }, uDepth: { value: depthRT.texture }, uC: { value: new THREE.Vector3() }, uR: { value: 1 }, uT: { value: T } },
    side: THREE.DoubleSide,
    depthTest: false,
    depthWrite: false,
  });
  const quadG = new THREE.BufferGeometry();
  quadG.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const dil = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: QUAD_VS, fragmentShader: DILATE_FS, uniforms: { uT: { value: null }, uPx: { value: new THREE.Vector2(1 / S, 1 / S) } }, depthTest: false, depthWrite: false });
  const scene = new THREE.Scene();
  scene.matrixWorldAutoUpdate = false;
  const px = new Uint8Array(S * S * 4);
  try {
    r.autoClear = false;
    r.setClearColor(0x000000, 0);
    r.setRenderTarget(atlasRT);
    r.clear(true, false, false);
    const groups = new Set(geos.map((b) => b.group));
    for (const grp of groups) {
      const list = occ.get(grp) ?? [];
      const bb = new THREE.Box3();
      for (const e of list) {
        if (!e.g.boundingBox) e.g.computeBoundingBox();
        bb.union(e.g.boundingBox!.clone().applyMatrix4(e.m));
      }
      for (const b of geos)
        if (b.group === grp) {
          b.g.computeBoundingBox();
          bb.union(b.g.boundingBox!);
        }
      const C = bb.getCenter(new THREE.Vector3());
      const R = Math.max(0.01, bb.getSize(new THREE.Vector3()).length() / 2) * 1.02;
      depthMat.uniforms.uC.value.copy(C);
      depthMat.uniforms.uR.value = R;
      scene.clear();
      for (const e of list) {
        const m = new THREE.Mesh(e.g, depthMat);
        m.matrixAutoUpdate = false;
        m.matrixWorld.copy(e.m);
        m.frustumCulled = false;
        scene.add(m);
      }
      depthRT.scissorTest = false;
      depthRT.viewport.set(0, 0, T * TILE, T * TILE);
      r.setRenderTarget(depthRT);
      r.clear(true, true, false);
      depthRT.scissorTest = true;
      for (let i = 0; i < N_DIRS; i++) {
        const x = (i % T) * TILE;
        const y = Math.floor(i / T) * TILE;
        depthRT.viewport.set(x, y, TILE, TILE);
        depthRT.scissor.set(x, y, TILE, TILE);
        r.setRenderTarget(depthRT);
        depthMat.uniforms.uI.value = i;
        r.render(scene, cam);
      }
      scene.clear();
      atlasMat.uniforms.uC.value.copy(C);
      atlasMat.uniforms.uR.value = R;
      for (const b of geos) {
        if (b.group !== grp) continue;
        const m = new THREE.Mesh(b.g, atlasMat);
        m.matrixAutoUpdate = false;
        m.frustumCulled = false;
        scene.add(m);
      }
      r.setRenderTarget(atlasRT);
      r.render(scene, cam);
    }
    let src = atlasRT;
    if (pingRT) {
      const quad = new THREE.Mesh(quadG, dil);
      quad.frustumCulled = false;
      scene.clear();
      scene.add(quad);
      let dst = pingRT;
      for (let k = 0; k < dilate; k++) {
        dil.uniforms.uT.value = src.texture;
        r.setRenderTarget(dst);
        r.render(scene, cam);
        [src, dst] = [dst, src];
      }
    }
    r.readRenderTargetPixels(src, 0, 0, S, S, px);
  } finally {
    depthRT.dispose();
    atlasRT.dispose();
    pingRT?.dispose();
    depthMat.dispose();
    atlasMat.dispose();
    dil.dispose();
    quadG.dispose();
    r.setRenderTarget(prev.rt);
    r.setViewport(prev.vp);
    r.setScissor(prev.sc);
    r.setScissorTest(prev.st);
    r.setClearColor(prev.cc, prev.ca);
    r.autoClear = prev.ac;
  }
  return px;
}

/**
 * Bake the template under `root` (charts + uv1 on the meshes + the atlas). Returns null when baking is
 * unavailable (no WebGL, e.g. unit tests); the caller keeps the plain tiling materials then.
 */
export function bakeVehicle(root: THREE.Object3D, key: string): BakeResult | null {
  if (!enabled) return null;
  const S = atlasSize;
  const ck = key + '|' + S;
  const srcs = collect(root);
  const hit = cache.get(ck);
  if (hit && hit.uvs.length === srcs.length && srcs.every((s, i) => s.mesh.geometry.attributes.position.count * 2 === hit.uvs[i].length)) {
    srcs.forEach((s, i) => {
      s.mesh.geometry.setAttribute('uv1', new THREE.BufferAttribute(hit.uvs[i], 2));
      s.mesh.geometry.setAttribute('aTone', new THREE.BufferAttribute(hit.tones[i], 1));
    });
    return hit.res;
  }
  const r = renderer();
  if (!r) return null;
  const t0 = performance.now();
  // ---- charts (shared shapes, e.g. one road wheel geometry for all wheels: charted once)
  const charts: Chart[] = [];
  const data: (SrcData | null)[] = [];
  const seenGeo = new Map<THREE.BufferGeometry, number>();
  srcs.forEach((s, si) => {
    if (!s.group || seenGeo.has(s.mesh.geometry)) {
      data.push(null);
      return;
    }
    seenGeo.set(s.mesh.geometry, si);
    data.push(analyse(s, si, charts));
  });
  styleCharts(charts, srcs);
  const occ = occluders(root);
  const gut = 2;
  let res: BakeResult | null = null;
  let uvs: Float32Array[] = [];
  let tones: Float32Array[] = [];
  const dispose = (geos: { g: THREE.BufferGeometry }[]) => geos.forEach((b) => b.g.dispose());
  try {
    // ---- visibility pre-pass (quarter size): charts that are hidden (behind skirts, under the hull) or face
    // the ground get a fraction of the texel density in the final atlas
    const P = Math.max(128, S >> 2);
    const D0 = fit(charts, P, 1);
    if (D0 > 0) {
      const pre = layout(srcs, data, seenGeo, charts, P, D0, 1);
      let px: Uint8Array;
      try {
        px = runGPU(r, P, pre.geos, occ, 0);
      } finally {
        dispose(pre.geos);
      }
      for (const ch of charts) {
        let k = ch.N.y < -0.6 ? 0.35 : 1;
        if (!ch.tiny) {
          let sum = 0;
          let n = 0;
          for (let y = ch.y + 1; y < ch.y + ch.h - 1; y++)
            for (let x = ch.x + 1; x < ch.x + ch.w - 1; x++) {
              const i = (y * P + x) * 4;
              if (px[i] + px[i + 1] < 2) continue;
              sum += px[i + 2];
              n++;
            }
          if (n > 0) {
            const ao = sum / n / 255;
            k = Math.min(k, ao < 0.06 ? 0.1 : ao < 0.14 ? 0.25 : ao < 0.28 ? 0.6 : 1);
          }
        }
        ch.k = k;
      }
    }
    // ---- final atlas
    const D = fit(charts, S, gut);
    if (!(D > 0)) return null;
    const fin = layout(srcs, data, seenGeo, charts, S, D, gut);
    uvs = fin.uvs;
    tones = fin.tones;
    let px: Uint8Array;
    try {
      px = runGPU(r, S, fin.geos, occ, 4);
    } finally {
      dispose(fin.geos);
    }
    // neutral block: flat, lightly occluded, no wear; still-empty texels: flat
    for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) px.set([128, 128, 215, 0], (y * S + x) * 4);
    for (let i = 0; i < S * S * 4; i += 4) if (px[i] + px[i + 1] < 2) px.set([128, 128, 200, 0], i);
    const tex = new THREE.DataTexture(px, S, S, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.anisotropy = 4;
    tex.channel = 1;
    tex.needsUpdate = true;
    res = { tex, size: S, density: D, charts: charts.filter((c) => !c.tiny).length, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    console.warn('vehicle bake failed', e);
    res = null;
  }
  if (!res) return null;
  srcs.forEach((s, i) => {
    s.mesh.geometry.setAttribute('uv1', new THREE.BufferAttribute(uvs[i], 2));
    s.mesh.geometry.setAttribute('aTone', new THREE.BufferAttribute(tones[i], 1));
  });
  cache.set(ck, { res, uvs, tones });
  return res;
}

/** Bake statistics (studio harness / perf HUD). */
export function bakeStats(): Record<string, { size: number; density: number; charts: number; ms: number }> {
  const out: Record<string, { size: number; density: number; charts: number; ms: number }> = {};
  for (const [k, v] of cache) out[k] = { size: v.res.size, density: Math.round(v.res.density), charts: v.res.charts, ms: v.res.ms };
  return out;
}

/** Raw atlas pixels of a cached bake (debug / studio harness). */
export function bakeAtlas(key: string): { size: number; data: Uint8Array } | null {
  const e = cache.get(key);
  if (!e) return null;
  return { size: e.res.size, data: e.res.tex.image.data as Uint8Array };
}
