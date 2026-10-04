import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { hash2 } from '../sim/rng';
import { BRIDGE_HEIGHT, Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import type { FogOfWar } from './fog';
import { surfaceHeight } from './ground';
import { OCC_ROAD, OCC_TRACK, occAt, type Layout } from './layout';
import { RIVER, chamfer, type RiverInfo } from './water';
import { WX, WX_PARS } from './wxuniforms';

/*
 * Living river banks (all visual, built once from the river analysis in
 * water.ts):
 *  - a wet sand / mud ribbon that darkens toward the water, with a thin sheet
 *    of water and a foam line lapping up the bank and back (one draw call),
 *  - reed and cattail clusters swaying in the wind (instanced, one call),
 *  - pebbles and stones in the shallows and the rocks of the rapids
 *    (instanced, one call),
 *  - a small wooden jetty by the village with two moored boats bobbing,
 *  - a low weir across the river with a white spill (mist comes from
 *    fx/waterfx.ts).
 * Nothing here touches the simulation: the weir and the jetty sit on water
 * tiles away from bridges, where no ground unit can go anyway.
 */

export type Quality = 'low' | 'medium' | 'high';

const C = (h: number) => new THREE.Color(h);

/** Paint a geometry with one vertex colour (for merged, vertex-coloured props). */
function paint(g: THREE.BufferGeometry, c: THREE.Color, jitter = 0, seed = 1): THREE.BufferGeometry {
  const n = g.getAttribute('position').count;
  const a = new Float32Array(n * 3);
  const k = 1 + (hash2(seed, 3, 71) - 0.5) * jitter;
  for (let i = 0; i < n; i++) {
    a[i * 3] = c.r * k;
    a[i * 3 + 1] = c.g * k;
    a[i * 3 + 2] = c.b * k;
  }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return g;
}

/** Keep only position / normal / color (so merges line up). */
function clean(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const o = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(o.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'color') o.deleteAttribute(k);
  return o;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number, c: THREE.Color, ry = 0, seed = 1, jitter = 0.18) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (ry) g.rotateY(ry);
  g.translate(x, y, z);
  return clean(paint(g, c, jitter, seed));
}

function cyl(r: number, h: number, x: number, y: number, z: number, c: THREE.Color, seg = 6, seed = 1) {
  const g = new THREE.CylinderGeometry(r, r * 1.08, h, seg);
  g.translate(x, y, z);
  return clean(paint(g, c, 0.15, seed));
}

/**
 * A small wooden boat, bow along +x, waterline at y = 0. 'row': open
 * rowing boat; 'fish': a fishing boat with a little wheelhouse and a mast.
 * Vertex colour white on the painted hull band (instanceColor tints it).
 */
export function boatGeometry(kind: 'row' | 'fish'): THREE.BufferGeometry {
  const L = kind === 'fish' ? 0.66 : 0.5;
  const W = kind === 'fish' ? 0.22 : 0.18;
  const parts: THREE.BufferGeometry[] = [];
  // hull: a box pinched to a bow, narrower at the keel
  const hull = new THREE.BoxGeometry(L, 0.11, W, 4, 1, 1);
  const pos = hull.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const t = Math.max(0, Math.min(1, x / L + 0.5)) ** 2.2;
    let z = pos.getZ(i) * (1 - t * 0.92);
    if (y < 0) z *= 0.55;
    pos.setZ(i, z);
    // sheer: the bow rises a little
    pos.setY(i, y + (y > 0 ? t * 0.035 : 0) + 0.015);
  }
  hull.computeVertexNormals();
  parts.push(clean(paint(hull, C(0xffffff))));
  // inside floor (dark), thwarts / seat
  parts.push(box(L * 0.7, 0.012, W * 0.62, -L * 0.06, 0.06, 0, C(0x3a2a1c), 0, 2, 0));
  parts.push(box(0.03, 0.012, W * 0.8, 0.02, 0.075, 0, C(0x6a4a2c), 0, 3, 0));
  // dark keel stripe at the waterline
  parts.push(box(L * 0.92, 0.02, W * 0.6, -0.01, -0.035, 0, C(0x1e1a16), 0, 4, 0));
  if (kind === 'fish') {
    parts.push(box(0.16, 0.12, W * 0.62, -L * 0.24, 0.12, 0, C(0xd8d2c4), 0, 5, 0));
    parts.push(box(0.18, 0.02, W * 0.7, -L * 0.24, 0.19, 0, C(0x7a3a26), 0, 6, 0));
    parts.push(cyl(0.008, 0.36, L * 0.12, 0.24, 0, C(0x4a3a2a), 5, 7));
    parts.push(box(0.12, 0.006, 0.006, L * 0.12, 0.38, 0, C(0x4a3a2a), 0, 8, 0));
  } else {
    // oars shipped along the sides
    parts.push(box(L * 0.75, 0.01, 0.012, -0.02, 0.085, W * 0.3, C(0x8a6a44), 0.05, 9, 0));
    parts.push(box(L * 0.75, 0.01, 0.012, -0.02, 0.085, -W * 0.3, C(0x8a6a44), -0.05, 10, 0));
  }
  return mergeGeometries(parts)!;
}

/** A reed / cattail clump (origin at the base, ~1 tall before scaling). */
function reedGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const base = C(0x3a4220);
  const mid = C(0x6a7a34);
  const tip = C(0xb0a860);
  const push = (x: number, y: number, z: number, c: THREE.Color, nx: number, nz: number) => {
    pos.push(x, y, z);
    col.push(c.r, c.g, c.b);
    nor.push(nx, 0.35, nz);
  };
  const tmp = new THREE.Color();
  // blades: tapered, bending outward
  const NB = 9;
  for (let b = 0; b < NB; b++) {
    const a = (b / NB) * Math.PI * 2 + hash2(b, 1, 501) * 0.9;
    const r0 = 0.03 + hash2(b, 2, 501) * 0.05;
    const hgt = 0.6 + hash2(b, 3, 501) * 0.45;
    const lean = 0.12 + hash2(b, 4, 501) * 0.22;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const wdt = 0.022;
    const px = -sa;
    const pz = ca;
    const seg = 3;
    for (let s = 0; s < seg; s++) {
      const t0 = s / seg;
      const t1 = (s + 1) / seg;
      const w0 = wdt * (1 - t0 * 0.85);
      const w1 = wdt * (1 - t1 * 0.85);
      const o0 = r0 + lean * t0 * t0;
      const o1 = r0 + lean * t1 * t1;
      const c0 = tmp.copy(base).lerp(mid, t0 * 1.6 > 1 ? 1 : t0 * 1.6).lerp(tip, Math.max(0, t0 - 0.5) * 1.4).clone();
      const c1 = tmp.copy(base).lerp(mid, t1 * 1.6 > 1 ? 1 : t1 * 1.6).lerp(tip, Math.max(0, t1 - 0.5) * 1.4).clone();
      const ax0 = ca * o0;
      const az0 = sa * o0;
      const ax1 = ca * o1;
      const az1 = sa * o1;
      const y0 = t0 * hgt;
      const y1 = t1 * hgt;
      push(ax0 - px * w0, y0, az0 - pz * w0, c0, ca, sa);
      push(ax0 + px * w0, y0, az0 + pz * w0, c0, ca, sa);
      push(ax1 + px * w1, y1, az1 + pz * w1, c1, ca, sa);
      push(ax0 - px * w0, y0, az0 - pz * w0, c0, ca, sa);
      push(ax1 + px * w1, y1, az1 + pz * w1, c1, ca, sa);
      push(ax1 - px * w1, y1, az1 - pz * w1, c1, ca, sa);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const parts: THREE.BufferGeometry[] = [g];
  // cattails: stalks with brown seed heads
  for (let k = 0; k < 3; k++) {
    const a = k * 2.1 + 0.4;
    const r = 0.04 + k * 0.02;
    const h = 0.82 + k * 0.12;
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    parts.push(cyl(0.007, h, x, h / 2, z, C(0x5a6a2c), 4, 20 + k));
    parts.push(cyl(0.022, 0.13, x, h - 0.04, z, C(0x4a2c18), 6, 30 + k));
    parts.push(cyl(0.004, 0.06, x, h + 0.05, z, C(0x6a6040), 3, 40 + k));
  }
  return mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)))!;
}

function stoneGeometry(): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 1);
  const pos = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = 0.8 + hash2(Math.round(x * 50) + 99, Math.round(y * 50) * 7 + Math.round(z * 50), 611) * 0.4;
    pos.setXYZ(i, x * k, y * k * 0.62, z * k);
  }
  g.computeVertexNormals();
  return clean(paint(g, C(0xffffff)));
}

export interface WatersideHandles {
  group: THREE.Group;
  update(time: number): void;
}

/** Instanced mesh helper (static instances). */
function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, list: { m: THREE.Matrix4; c: THREE.Color }[], name: string) {
  const im = new THREE.InstancedMesh(geo, mat, Math.max(1, list.length));
  list.forEach((e, i) => {
    im.setMatrixAt(i, e.m);
    im.setColorAt(i, e.c);
  });
  im.count = list.length;
  im.name = name;
  im.computeBoundingSphere();
  return im;
}

export class Waterside implements WatersideHandles {
  readonly group = new THREE.Group();
  private reedMat: THREE.MeshStandardMaterial | null = null;
  private reedTime = { value: 0 };
  private boats: THREE.InstancedMesh | null = null;
  private moored: { x: number; y: number; yaw: number; ph: number; c: THREE.Color }[] = [];
  private bankMat: THREE.ShaderMaterial | null = null;
  private spillMat: THREE.ShaderMaterial | null = null;
  private m4 = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);

  constructor(
    private map: GameMap,
    private river: RiverInfo,
    layout: Layout,
    private fog: FogOfWar,
    private quality: Quality,
    /** The river material's wxLight (atmos tints it for time of day / weather). */
    private wxLight: { value: THREE.Vector3 },
    private waveTex: THREE.Texture,
  ) {
    this.group.name = 'waterside';
    this.group.userData.perfCat = 'waterside';
    if (!river.samples.length) return;
    this.buildBank();
    // the city canal is walled: stone quays instead of reeds and pebbles
    if (map.biome === 'urban') this.buildQuays();
    else {
      this.buildReeds(layout);
      this.buildStones(layout);
    }
    this.buildJetty();
    this.buildWeir();
  }

  // --------------------------------------------------------------- the bank

  private buildBank() {
    const m = this.map;
    const R = this.river;
    const N = R.N;
    const NH = R.NH;
    const res = R.res;
    // signed distance to the waterline: + on land, - in the water
    const land = chamfer(R.wetMask, N, NH);
    const data = new Uint8Array(N * NH);
    const LO = -0.6;
    const HI = 1.8;
    for (let k = 0; k < N * NH; k++) {
      const d = R.wetMask[k] ? -R.shore[k] : land[k] / res;
      data[k] = Math.max(0, Math.min(255, Math.round(((d - LO) / (HI - LO)) * 255)));
    }
    const tex = new THREE.DataTexture(data, N, NH, THREE.RedFormat, THREE.UnsignedByteType);
    tex.magFilter = tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    // geometry: 3 x 3 quads per tile along the waterline, draped on the ground
    const S = this.quality === 'low' ? 2 : 3;
    const pos: number[] = [];
    const idx: number[] = [];
    const near = (tx: number, ty: number) => {
      let lo = 9;
      let hi = -9;
      for (let j = 0; j <= res; j += 2)
        for (let i = 0; i <= res; i += 2) {
          const ii = Math.min(N - 1, tx * res + i);
          const jj = Math.min(NH - 1, ty * res + j);
          const k = jj * N + ii;
          const d = R.wetMask[k] ? -R.shore[k] : land[k] / res;
          lo = Math.min(lo, d);
          hi = Math.max(hi, d);
        }
      return lo < 1.5 && hi > -0.35;
    };
    for (let ty = 0; ty < m.h; ty++)
      for (let tx = 0; tx < m.w; tx++) {
        if (!near(tx, ty)) continue;
        const b = pos.length / 3;
        for (let j = 0; j <= S; j++)
          for (let i = 0; i <= S; i++) {
            const x = tx + i / S;
            const y = ty + j / S;
            pos.push(x, Math.max(surfaceHeight(m, Math.min(m.w - 0.001, x), Math.min(m.h - 0.001, y)), WATER_LEVEL - 0.05) + 0.012, y);
          }
        for (let j = 0; j < S; j++)
          for (let i = 0; i < S; i++) {
            const a = b + j * (S + 1) + i;
            idx.push(a, a + S + 1, a + 1, a + 1, a + S + 1, a + S + 2);
          }
      }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    // real normals: the AO pass draws every mesh's normals (none would read as a black crease)
    g.computeVertexNormals();
    g.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -4,
      uniforms: {
        bankTex: { value: tex },
        waveTex: { value: this.waveTex },
        mapSize: { value: new THREE.Vector2(m.w, m.h) },
        time: RIVER.time,
        wState: RIVER.wState,
        sunDir: RIVER.sunDir,
        sunCol: RIVER.sunCol,
        wxLight: this.wxLight,
        ...this.fog.uniforms,
        ...WX,
      },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform sampler2D bankTex;
        uniform sampler2D waveTex;
        uniform vec2 mapSize;
        uniform float time;
        uniform vec4 wState;
        uniform vec3 sunDir;
        uniform vec3 sunCol;
        uniform vec3 wxLight;
        ${WX_PARS}
        uniform sampler2D fogTex;
        uniform vec2 fogSize;
        uniform float fogEnabled;
        varying vec3 vWorld;
        void main() {
          vec2 p = vWorld.xz;
          float d = texture2D(bankTex, p / mapSize).r * ${(1.8 + 0.6).toFixed(1)} - 0.6;
          float n = texture2D(waveTex, p * 0.37).a;
          float n2 = texture2D(waveTex, p * 1.3 + 0.4).a;
          float chop = wState.x;
          float calm = wState.y;
          float ice = wState.w;
          // the water's edge runs up the bank and slides back (slower, smaller on calm water; frozen in the cold)
          float reach = (0.07 + 0.12 * chop - 0.03 * calm) * (1.0 - ice);
          float lapT = sin(time * 0.85 + n * 5.0 + dot(p, vec2(0.21, 0.17)));
          float edge = reach * (0.5 + 0.5 * lapT) - 0.015;
          float wetW = 0.45 + 0.55 * n + wxWet * 0.9;
          if (d > wetW + 0.1) discard;
          // wet sand / mud: darker toward the water, the band left by the last wave glistens
          float wet = 1.0 - smoothstep(0.0, wetW, d);
          float fresh = (1.0 - smoothstep(edge, edge + reach * 0.9 + 0.04, d)) * step(-0.02, d);
          vec3 mudC = mix(vec3(0.2, 0.165, 0.115), vec3(0.11, 0.09, 0.062), wet * wet);
          float a = wet * 0.5 * (1.0 - 0.75 * wxSnow) * (1.0 - smoothstep(0.0, 0.3, -d));
          vec3 col = mudC;
          // the thin sheet of water and its foam line
          float sheet = (1.0 - smoothstep(edge - 0.03, edge + 0.005, d)) * smoothstep(-0.3, -0.02, d);
          float fq = (d - edge) / (0.022 + 0.02 * chop);
          float foamL = exp(-fq * fq) * smoothstep(0.35, 0.8, n2) * (0.5 + 0.5 * chop) * (1.0 - ice) * step(-0.06, d);
          col = mix(col, vec3(0.05, 0.075, 0.065), sheet * 0.7);
          a = max(a, sheet * 0.55);
          col *= wxLight;
          vec3 V = normalize(cameraPosition - vWorld);
          float sp = pow(max(dot(reflect(-V, vec3(0.0, 1.0, 0.0)), sunDir), 0.0), 40.0);
          col += sunCol * sp * (sheet * 0.6 + fresh * 0.35) * (1.0 - wxSnow);
          col = mix(col, vec3(0.8, 0.84, 0.83) * wxLight, foamL * 0.8);
          a = max(a, foamL * 0.6);
          float fogV = texture2D(fogTex, p / fogSize).r;
          float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
          col *= mix(1.0, fogK, fogEnabled);
          // never hand NaN / Inf to the HDR chain (bloom would smear it over the frame)
          col = (col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0) ? min(col, vec3(32.0)) : vec3(0.0);
          gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.fog.upgradeShader(mat);
    this.bankMat = mat;
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 0;
    mesh.name = 'river-bank';
    this.group.add(mesh);
  }

  // --------------------------------------------------------------- quays

  /** City canal: dressed stone quay walls with a pale coping along both banks. */
  private buildQuays() {
    const m = this.map;
    const R = this.river;
    const pos: number[] = [];
    const nor: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    const stone = [0.52, 0.5, 0.47];
    const cope = [0.74, 0.72, 0.68];
    const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], k: number[]) => {
      const i0 = pos.length / 3;
      for (const p of [a, b, c, d]) {
        pos.push(p[0], p[1], p[2]);
        nor.push(n[0], n[1], n[2]);
        col.push(k[0], k[1], k[2]);
      }
      idx.push(i0, i0 + 2, i0 + 1, i0 + 1, i0 + 2, i0 + 3);
    };
    for (const side of [1, -1]) {
      let prev: { x: number; y: number; top: number } | null = null;
      for (const c of R.samples) {
        const half = c.width / 2 + 0.06;
        const x = c.x - c.ty * half * side;
        const y = c.y + c.tx * half * side;
        if (x < -1 || y < -1 || x > m.w + 1 || y > m.h + 1) {
          prev = null;
          continue;
        }
        let top = surfaceHeight(m, Math.max(0, Math.min(m.w - 0.01, x - c.ty * 0.5 * side)), Math.max(0, Math.min(m.h - 0.01, y + c.tx * 0.5 * side))) + 0.05;
        // under a bridge deck the wall stops below it
        if (R.bridgeS.some((bs) => Math.abs(bs - c.s) < 1.5)) top = Math.min(top, BRIDGE_HEIGHT - 0.06);
        if (prev && Math.hypot(x - prev.x, y - prev.y) < 1.2) {
          // the wall face looks into the canal (towards the centreline)
          const nx = c.ty * side;
          const nz = -c.tx * side;
          const lo = WATER_LEVEL - 0.35;
          quad([prev.x, prev.top, prev.y], [x, top, y], [prev.x, lo, prev.y], [x, lo, y], [nx, 0, nz], stone);
          // coping: a flat strip on top, a little proud of the wall
          const ox = -nx * 0.12;
          const oz = -nz * 0.12;
          quad([prev.x + ox, prev.top + 0.02, prev.y + oz], [x + ox, top + 0.02, y + oz], [prev.x - nx * 0.04, prev.top + 0.02, prev.y - nz * 0.04], [x - nx * 0.04, top + 0.02, y - nz * 0.04], [0, 1, 0], cope);
        }
        prev = { x, y, top };
      }
    }
    if (!pos.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeBoundingSphere();
    const mat = this.fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.castShadow = this.quality !== 'low';
    mesh.name = 'canal-quays';
    this.group.add(mesh);
  }

  // --------------------------------------------------------------- reeds

  private avoid(x: number, y: number, layout: Layout, rapidsOk = false) {
    const m = this.map;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
    if (m.tiles[ty * m.w + tx] === Tile.Bridge) return true;
    for (const b of m.bridges) if (Math.hypot(x - b.x, y - b.y) < b.length / 2 + 1.2) return true;
    if (occAt(layout, m, x, y) & (OCC_ROAD | OCC_TRACK)) return true;
    const f = this.river.features;
    if (f.jetty && Math.hypot(x - (f.jetty.x + f.jetty.dx), y - (f.jetty.y + f.jetty.dy)) < 2.2) return true;
    if (f.weir && Math.hypot(x - f.weir.x, y - f.weir.y) < f.weir.half + 1.2) return true;
    if (f.rapids && !rapidsOk) {
      const s = this.river.sAt(x, y);
      if (s > f.rapids.s0 - 1 && s < f.rapids.s1 + 1) return true;
    }
    return false;
  }

  private buildReeds(layout: Layout) {
    const m = this.map;
    const R = this.river;
    const cap = this.quality === 'low' ? 180 : this.quality === 'medium' ? 420 : 700;
    const list: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const mt = new THREE.Matrix4();
    const tries = cap * 14;
    let seed = 7;
    for (let t = 0; t < tries && list.length < cap; t++) {
      seed++;
      const x = 0.5 + hash2(seed, 1, 801) * (m.w - 1);
      const y = 0.5 + hash2(seed, 2, 801) * (m.h - 1);
      const dep = R.depthAt(x, y);
      // the shallows and the wet foot of the bank
      if (dep > 0.1 || dep < -0.14) continue;
      const patch = hash2(Math.floor(x / 2.5), Math.floor(y / 2.5), 803);
      if (patch < 0.45) continue;
      if (this.avoid(x, y, layout)) continue;
      const s = 0.42 + hash2(seed, 3, 801) * 0.32;
      this.q.setFromEuler(this.e.set((hash2(seed, 5, 801) - 0.5) * 0.15, hash2(seed, 4, 801) * 6.28, (hash2(seed, 6, 801) - 0.5) * 0.15));
      mt.compose(this.v.set(x, Math.max(WATER_LEVEL - 0.08, surfaceHeight(m, x, y)) - 0.02, y), this.q, this.s.set(s, s * (0.85 + hash2(seed, 7, 801) * 0.4), s));
      const tint = 0.85 + hash2(seed, 8, 801) * 0.3;
      list.push({ m: mt.clone(), c: new THREE.Color(tint, tint * (0.95 + hash2(seed, 9, 801) * 0.1), tint * 0.9) });
    }
    if (!list.length) return;
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, side: THREE.DoubleSide });
    const rt = this.reedTime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.rTime = rt;
      sh.uniforms.rState = RIVER.wState;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float rTime;\nuniform vec4 rState;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
          float ph = ip.x * 0.71 + ip.z * 0.93;
          float h2 = transformed.y * transformed.y;
          float gust = 0.6 + 0.4 * sin(rTime * 0.37 + ip.x * 0.11);
          float sw = (0.05 + 0.16 * rState.x) * h2 * gust;
          transformed.x += (sin(rTime * 1.9 + ph) + 0.6 * rState.x) * sw;
          transformed.z += cos(rTime * 1.43 + ph * 1.3) * sw * 0.6;
        }`,
      );
    };
    this.fog.apply(mat);
    mat.customProgramCacheKey = () => 'fog2-reeds';
    this.reedMat = mat;
    const im = instanced(reedGeometry(), mat, list, 'reeds');
    im.receiveShadow = true;
    this.group.add(im);
  }

  // --------------------------------------------------------------- stones

  private buildStones(layout: Layout) {
    const m = this.map;
    const R = this.river;
    const cap = this.quality === 'low' ? 120 : this.quality === 'medium' ? 260 : 420;
    const list: { m: THREE.Matrix4; c: THREE.Color }[] = [];
    const mt = new THREE.Matrix4();
    let seed = 1000;
    const add = (x: number, y: number, z: number, r: number, h: number, sd: number, tone: number) => {
      this.q.setFromEuler(this.e.set((hash2(sd, 1, 901) - 0.5) * 0.4, hash2(sd, 2, 901) * 6.28, (hash2(sd, 3, 901) - 0.5) * 0.4));
      mt.compose(this.v.set(x, y, z), this.q, this.s.set(r * (0.8 + hash2(sd, 4, 901) * 0.5), h, r));
      const warm = hash2(sd, 5, 901);
      list.push({ m: mt.clone(), c: new THREE.Color(tone * (0.95 + warm * 0.12), tone * (0.93 + warm * 0.05), tone * 0.88) });
    };
    for (let t = 0; t < cap * 12 && list.length < cap; t++) {
      seed++;
      const x = 0.5 + hash2(seed, 1, 903) * (m.w - 1);
      const y = 0.5 + hash2(seed, 2, 903) * (m.h - 1);
      const dep = R.depthAt(x, y);
      if (dep > 0.16 || dep < -0.22) continue;
      if (hash2(Math.floor(x / 1.7), Math.floor(y / 1.7), 905) < 0.4) continue;
      if (this.avoid(x, y, layout, true)) continue;
      const big = hash2(seed, 3, 903) < 0.12;
      const r = big ? 0.09 + hash2(seed, 4, 903) * 0.08 : 0.025 + hash2(seed, 4, 903) * 0.045;
      add(x, surfaceHeight(m, x, y) + r * 0.12, y, r, r * (big ? 0.75 : 0.6), seed, 0.36 + hash2(seed, 6, 903) * 0.22);
    }
    // the rapids' rocks break the surface
    let k = 0;
    for (const rk of R.features.rocks) {
      k++;
      const gh = groundHeight(m, rk.x, rk.y);
      const top = WATER_LEVEL + 0.04 + rk.r * 0.35;
      const h = (top - gh) / 0.62 / 2 + 0.02;
      add(rk.x, (top + gh) / 2, rk.y, rk.r * 1.15, Math.max(h, rk.r * 0.6), 5000 + k, 0.27 + hash2(k, 7, 903) * 0.1);
      // smaller stones scattered round it
      for (let j = 0; j < 3; j++) {
        const a = hash2(k, j, 907) * 6.28;
        const d = rk.r + 0.08 + hash2(k, j + 5, 907) * 0.2;
        const x = rk.x + Math.cos(a) * d;
        const y = rk.y + Math.sin(a) * d;
        const r = 0.05 + hash2(k, j + 9, 907) * 0.05;
        add(x, WATER_LEVEL - 0.02 + r * 0.2, y, r, r * 0.7 + (WATER_LEVEL - groundHeight(m, x, y)) * 0.4, 6000 + k * 7 + j, 0.38);
      }
    }
    if (!list.length) return;
    const mat = this.fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.82, metalness: 0 }));
    const im = instanced(stoneGeometry(), mat, list, 'river-stones');
    im.receiveShadow = true;
    im.castShadow = this.quality === 'high';
    this.group.add(im);
  }

  // --------------------------------------------------------------- jetty + boats

  private buildJetty() {
    const j = this.river.features.jetty;
    const m = this.map;
    if (!j) return;
    const parts: THREE.BufferGeometry[] = [];
    const deckY = WATER_LEVEL + 0.13;
    const yaw = Math.atan2(-j.dy, j.dx);
    const L = j.len + 0.55;
    const W = 0.4;
    // local frame: +x out over the water, starting 0.55 up the bank
    const sx = j.x - j.dx * 0.55;
    const sy = j.y - j.dy * 0.55;
    const local: THREE.BufferGeometry[] = [];
    const wood = C(0x7a5a3a);
    const dark = C(0x4a3624);
    let n = 0;
    for (let x = 0.05; x < L; x += 0.085) {
      n++;
      const tone = wood.clone().multiplyScalar(0.8 + hash2(n, 1, 1101) * 0.35);
      local.push(box(0.07, 0.022, W * (0.94 + hash2(n, 2, 1101) * 0.08), x, deckY + (hash2(n, 3, 1101) - 0.5) * 0.006, (hash2(n, 4, 1101) - 0.5) * 0.02, tone, (hash2(n, 5, 1101) - 0.5) * 0.04, n));
    }
    // stringers
    local.push(box(L, 0.03, 0.04, L / 2, deckY - 0.026, W * 0.36, dark, 0, 91, 0));
    local.push(box(L, 0.03, 0.04, L / 2, deckY - 0.026, -W * 0.36, dark, 0, 92, 0));
    // posts down to the bed (the pairs on land stop at the ground)
    for (let x = 0.12; x < L + 0.01; x += 0.55) {
      for (const z of [-W * 0.44, W * 0.44]) {
        const wx = sx + j.dx * x - j.dy * z;
        const wy = sy + j.dy * x + j.dx * z;
        const bed = groundHeight(m, Math.max(0, Math.min(m.w, wx)), Math.max(0, Math.min(m.h, wy))) - 0.05;
        const top = deckY + 0.07;
        local.push(cyl(0.028, top - bed, x, (top + bed) / 2, z, dark, 6, Math.round(x * 100 + z * 10)));
      }
    }
    // bollards and a coil of rope at the end
    local.push(cyl(0.03, 0.08, L - 0.08, deckY + 0.05, W * 0.3, dark, 6, 301));
    local.push(cyl(0.03, 0.08, L - 0.08, deckY + 0.05, -W * 0.3, dark, 6, 302));
    local.push(cyl(0.035, 0.02, L - 0.3, deckY + 0.02, 0.05, C(0xa89870), 8, 303));
    const g = mergeGeometries(local)!;
    g.rotateY(yaw);
    g.translate(sx, 0, sy);
    parts.push(g);
    const mat = this.fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
    const mesh = new THREE.Mesh(mergeGeometries(parts)!, mat);
    mesh.name = 'jetty';
    mesh.castShadow = this.quality !== 'low';
    mesh.receiveShadow = true;
    this.group.add(mesh);
    // two rowing boats tied alongside
    const px = -j.dy;
    const py = j.dx;
    const at = (along: number, side: number) => ({ x: sx + j.dx * along + px * side, y: sy + j.dy * along + py * side });
    const b1 = at(L - 0.32, 0.36);
    const b2 = at(L - 0.95, -0.37);
    const boatYaw = Math.atan2(-j.dy, j.dx);
    this.moored.push({ x: b1.x, y: b1.y, yaw: boatYaw + 0.08, ph: 0, c: C(0x3a6a8a) });
    if (this.river.depthAt(b2.x, b2.y) > 0.05) this.moored.push({ x: b2.x, y: b2.y, yaw: boatYaw - 0.12, ph: 2.1, c: C(0xa84a32) });
    const bm = this.fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75 }));
    const boats = new THREE.InstancedMesh(boatGeometry('row'), bm, this.moored.length);
    boats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.moored.forEach((b, i) => boats.setColorAt(i, b.c));
    boats.name = 'moored-boats';
    boats.castShadow = this.quality !== 'low';
    boats.frustumCulled = false;
    this.boats = boats;
    this.group.add(boats);
  }

  // --------------------------------------------------------------- weir

  private buildWeir() {
    const w = this.river.features.weir;
    const m = this.map;
    if (!w) return;
    // span only the water tiles
    const onWater = (o: number) => {
      const x = w.x + w.ax * o;
      const y = w.y + w.ay * o;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      return tx >= 0 && ty >= 0 && tx < m.w && ty < m.h && m.tiles[ty * m.w + tx] === Tile.Water && groundHeight(m, x, y) < WATER_LEVEL - 0.02;
    };
    let a = 0;
    let b = 0;
    while (a > -6 && onWater(a - 0.05)) a -= 0.05;
    while (b < 6 && onWater(b + 0.05)) b += 0.05;
    if (b - a < 1.5) return;
    const mid = (a + b) / 2;
    const half = (b - a) / 2;
    const cx = w.x + w.ax * mid;
    const cy = w.y + w.ay * mid;
    const yaw = Math.atan2(-w.ay, w.ax);
    const conc = C(0x8a8478);
    const local: THREE.BufferGeometry[] = [];
    const crest = WATER_LEVEL + 0.012;
    const bed = WATER_LEVEL - 0.75;
    // the crest wall (local x across the river, local z downstream)
    local.push(box(half * 2, crest - bed, 0.16, 0, (crest + bed) / 2, 0, conc, 0, 1, 0.05));
    // a stepped apron just below the water downstream
    local.push(box(half * 2, 0.05, 0.22, 0, WATER_LEVEL - 0.07, 0.17, conc.clone().multiplyScalar(0.8), 0, 2, 0.05));
    // abutments at the ends
    for (const e of [-1, 1]) {
      local.push(box(0.22, WATER_LEVEL + 0.2 - bed, 0.34, e * (half - 0.08), (WATER_LEVEL + 0.2 + bed) / 2, 0.02, conc.clone().multiplyScalar(0.95), 0, 3 + e, 0.05));
      local.push(box(0.26, 0.03, 0.38, e * (half - 0.08), WATER_LEVEL + 0.215, 0.02, conc.clone().multiplyScalar(1.1), 0, 5 + e, 0.05));
    }
    const g = mergeGeometries(local)!;
    // local z must point downstream: rotate so +x = across (ax, ay), +z = (tx, ty)
    const flip = w.ax * w.ty - w.ay * w.tx < 0 ? -1 : 1;
    if (flip < 0) g.rotateY(Math.PI);
    g.rotateY(yaw);
    g.translate(cx, 0, cy);
    const mat = this.fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9 }));
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = 'weir';
    mesh.castShadow = this.quality !== 'low';
    mesh.receiveShadow = true;
    this.group.add(mesh);
    // the spill: a white tongue of tumbling water over the crest and the roller below it
    const SEG = 6;
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const across = 18;
    for (let j = 0; j <= SEG; j++) {
      const t = j / SEG;
      const z = -0.06 + t * 0.5;
      const y = WATER_LEVEL + 0.024 - Math.sin(Math.min(1, t * 1.6) * Math.PI * 0.5) * 0.02 + (t > 0.55 ? Math.sin((t - 0.55) * 7) * 0.006 : 0);
      for (let i = 0; i <= across; i++) {
        const x = -half + 0.14 + ((half - 0.14) * 2 * i) / across;
        pos.push(x, y, z * flip);
        uv.push(i / across, t);
      }
    }
    for (let j = 0; j < SEG; j++)
      for (let i = 0; i < across; i++) {
        const k = j * (across + 1) + i;
        idx.push(k, k + across + 1, k + 1, k + 1, k + across + 1, k + across + 2);
      }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    sg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    sg.setIndex(idx);
    sg.computeVertexNormals();
    sg.rotateY(yaw);
    sg.translate(cx, 0, cy);
    sg.computeBoundingSphere();
    const smat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      uniforms: { time: RIVER.time, waveTex: { value: this.waveTex }, wxLight: this.wxLight, wState: RIVER.wState, len: { value: half * 2 }, ...this.fog.uniforms },
      vertexShader: /* glsl */ `
        varying vec3 vWorld;
        varying vec2 vUv;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorld = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }`,
      fragmentShader: /* glsl */ `
        uniform float time;
        uniform sampler2D waveTex;
        uniform vec3 wxLight;
        uniform vec4 wState;
        uniform float len;
        uniform sampler2D fogTex;
        uniform vec2 fogSize;
        uniform float fogEnabled;
        varying vec3 vWorld;
        varying vec2 vUv;
        void main() {
          float u = vUv.x * len;
          float t = vUv.y;
          float n1 = texture2D(waveTex, vec2(u * 0.9, t * 1.2 - time * 1.1)).a;
          float n2 = texture2D(waveTex, vec2(u * 2.3 + 0.3, t * 2.0 - time * 1.9)).a;
          float roll = texture2D(waveTex, vec2(u * 1.4 + 0.6, t * 0.6 + time * 0.35)).a;
          // glassy dark tongue over the crest, white where it tumbles, ragged foam trailing off
          float white = smoothstep(0.12, 0.3, t) * (1.0 - smoothstep(0.55, 1.0, t + (n2 - 0.5) * 0.4));
          float f = white * smoothstep(0.3, 0.62, n1 * 0.6 + n2 * 0.4 + 0.18) + white * 0.35 * roll;
          float tongue = 1.0 - smoothstep(0.08, 0.2, t);
          vec3 col = mix(vec3(0.05, 0.08, 0.075), vec3(0.86, 0.9, 0.9), clamp(f, 0.0, 1.0));
          col *= wxLight;
          float a = max(tongue * 0.55, clamp(f, 0.0, 1.0) * 0.92) * smoothstep(0.0, 0.04, vUv.x) * smoothstep(0.0, 0.04, 1.0 - vUv.x);
          a *= 1.0 - wState.w * 0.7;
          float fogV = texture2D(fogTex, vWorld.xz / fogSize).r;
          float fogK = fogV < 0.5 ? fogV * 0.9 : 0.45 + (fogV - 0.5) * 1.1;
          col *= mix(1.0, fogK, fogEnabled);
          // never hand NaN / Inf to the HDR chain (bloom would smear it over the frame)
          col = (col.r >= 0.0 && col.g >= 0.0 && col.b >= 0.0) ? min(col, vec3(32.0)) : vec3(0.0);
          gl_FragColor = vec4(col, a);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
    });
    this.fog.upgradeShader(smat);
    this.spillMat = smat;
    const spill = new THREE.Mesh(sg, smat);
    spill.renderOrder = 2;
    spill.name = 'weir-spill';
    this.group.add(spill);
    // record the real span for the mist (fx/waterfx.ts)
    w.x = cx;
    w.y = cy;
    w.half = half;
  }

  /** Per frame: reed sway clock, bobbing moored boats. */
  update(time: number) {
    this.reedTime.value = time;
    const b = this.boats;
    if (!b) return;
    const chop = RIVER.wState.value.x;
    for (let i = 0; i < this.moored.length; i++) {
      const o = this.moored[i];
      const t = time + o.ph;
      const amp = 1 + chop * 2.5;
      this.e.set(Math.sin(t * 1.3) * 0.05 * amp, o.yaw + Math.sin(t * 0.31) * 0.06, Math.sin(t * 0.9 + 1) * 0.035 * amp, 'YXZ');
      this.q.setFromEuler(this.e);
      this.m4.compose(this.v.set(o.x, WATER_LEVEL - 0.01 + Math.sin(t * 1.1) * 0.008 * amp, o.y), this.q, this.s.set(1, 1, 1));
      b.setMatrixAt(i, this.m4);
    }
    b.instanceMatrix.needsUpdate = true;
  }

  dispose() {
    this.bankMat?.dispose();
    this.spillMat?.dispose();
    this.reedMat?.dispose();
  }
}
