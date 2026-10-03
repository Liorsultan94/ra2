import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import { hash2 } from '../../sim/rng';
import { drawFlag } from '../flags';
import type { FogOfWar } from '../fog';
import { surfaceHeight } from '../ground';
import { adAtlas, LANGS } from './ads';
import type { RoadNet } from './roadnet';
import type { AmbientFrame, FogProbe, LightSprites, Quality } from './shared';

/*
 * Roadside life around the traffic network:
 *
 *  - roundabout centrepieces (not on every island): a fountain with animated
 *    water, a statue on a plinth, a flag pole with the national flag, flower
 *    beds, palms (desert), a decorated spruce with lights (winter);
 *  - billboards (double sided) with fictional local adverts (ads.ts), lit at
 *    night by their lamps;
 *  - parking lot lamp posts (lit at night) and, in the city, a ticket booth
 *    with a barrier.
 *
 * Everything is instanced with one shared vertex-coloured material (plus the
 * advert faces, the flag cloth and the fountain water), hidden at far zoom and
 * under the fog of war, skipped on low quality.
 */

const C = (hex: number) => new THREE.Color(hex);
const FAR = 62;

interface Item {
  x: number;
  y: number;
  h: number;
  yaw: number;
  s: number;
  /** Per-instance extra (advert cell, flower palette...). */
  a: number;
  b: number;
}

function paint(g: THREE.BufferGeometry, col: THREE.Color): THREE.BufferGeometry {
  const ng = g.index ? g.toNonIndexed() : g;
  const n = ng.attributes.position.count;
  const c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    c[i * 3] = col.r;
    c[i * 3 + 1] = col.g;
    c[i * 3 + 2] = col.b;
  }
  ng.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (!ng.attributes.normal) ng.computeVertexNormals();
  return ng;
}

function merge(parts: THREE.BufferGeometry[], keepUv = false): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const uv = keepUv ? new Float32Array(n * 2) : null;
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    nor.set(p.attributes.normal.array as Float32Array, o * 3);
    col.set(p.attributes.color.array as Float32Array, o * 3);
    if (uv && p.attributes.uv) uv.set(p.attributes.uv.array as Float32Array, o * 2);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number, col: number) => paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), C(col));
const cyl = (r0: number, r1: number, h: number, x: number, y: number, z: number, col: number, seg = 10, open = false) => paint(new THREE.CylinderGeometry(r1, r0, h, seg, 1, open).translate(x, y + h / 2, z), C(col));
const ball = (r: number, x: number, y: number, z: number, col: number, d = 0) => paint(new THREE.IcosahedronGeometry(r, d).translate(x, y, z), C(col));

// ------------------------------------------------------------------ models (origin on the ground, facing +X)

function fountainStone(): THREE.BufferGeometry {
  const stone = 0xbdb5a4;
  return merge([
    cyl(0.44, 0.44, 0.09, 0, 0, 0, stone, 22, true),
    paint(new THREE.RingGeometry(0.38, 0.46, 22).rotateX(-Math.PI / 2).translate(0, 0.09, 0), C(0xcfc7b6)),
    paint(new THREE.CircleGeometry(0.4, 18).rotateX(-Math.PI / 2).translate(0, 0.02, 0), C(0x2e4a52)),
    cyl(0.07, 0.05, 0.3, 0, 0, 0, stone, 10),
    paint(new THREE.CylinderGeometry(0.16, 0.07, 0.06, 14).translate(0, 0.33, 0), C(0xcfc7b6)),
  ]);
}

/** Water of the fountain: surface disc + jets (aT: 0..1 along a jet, -1 the pool). */
function fountainWater(): THREE.BufferGeometry {
  const pos: number[] = [];
  const at: number[] = [];
  const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, ta: number, tb: number) => {
    pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z, b.x, b.y, b.z, d.x, d.y, d.z, c.x, c.y, c.z);
    at.push(ta, tb, ta, tb, tb, ta);
  };
  // pool surface
  const N = 18;
  for (let i = 0; i < N; i++) {
    const a0 = (i / N) * Math.PI * 2;
    const a1 = ((i + 1) / N) * Math.PI * 2;
    pos.push(0, 0.075, 0, Math.cos(a1) * 0.39, 0.075, Math.sin(a1) * 0.39, Math.cos(a0) * 0.39, 0.075, Math.sin(a0) * 0.39);
    at.push(-1, -1, -1);
  }
  // jets: arcs from the bowl rim down into the pool, and a plume up the middle
  const J = 8;
  const S = 6;
  for (let j = 0; j < J; j++) {
    const a = (j / J) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const w = 0.012;
    for (let k = 0; k < S; k++) {
      const p = (t: number) => {
        const r = 0.15 + t * 0.2;
        const y = 0.38 + t * 0.1 - t * t * 0.42;
        return [r, y] as const;
      };
      const [r0, y0] = p(k / S);
      const [r1, y1] = p((k + 1) / S);
      quad(new THREE.Vector3(ca * r0 - sa * w, y0, sa * r0 + ca * w), new THREE.Vector3(ca * r1 - sa * w, y1, sa * r1 + ca * w), new THREE.Vector3(ca * r0 + sa * w, y0, sa * r0 - ca * w), new THREE.Vector3(ca * r1 + sa * w, y1, sa * r1 - ca * w), k / S, (k + 1) / S);
    }
  }
  for (const a of [0, Math.PI / 2]) {
    const ca = Math.cos(a) * 0.018;
    const sa = Math.sin(a) * 0.018;
    quad(new THREE.Vector3(-ca, 0.36, -sa), new THREE.Vector3(-ca * 0.4, 0.62, -sa * 0.4), new THREE.Vector3(ca, 0.36, sa), new THREE.Vector3(ca * 0.4, 0.62, sa * 0.4), 0, 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('aT', new THREE.Float32BufferAttribute(at, 1));
  return g;
}

function statue(): THREE.BufferGeometry {
  const stone = 0xb9b2a6;
  const bronze = 0x5e6b4a;
  return merge([
    box(0.3, 0.06, 0.3, 0, 0.03, 0, 0xa8a196),
    box(0.22, 0.24, 0.22, 0, 0.18, 0, stone),
    box(0.26, 0.03, 0.26, 0, 0.315, 0, 0xc8c1b4),
    // a figure with a raised arm (bronze, weathered green)
    box(0.07, 0.15, 0.05, 0, 0.405, 0, bronze),
    box(0.09, 0.14, 0.07, 0, 0.55, 0, bronze),
    ball(0.035, 0, 0.66, 0, bronze, 1),
    paint(new THREE.BoxGeometry(0.03, 0.14, 0.03).rotateX(-0.5).translate(0, 0.64, 0.07), C(bronze)),
    box(0.025, 0.11, 0.025, 0, 0.52, -0.06, bronze),
  ]);
}

function flagPole(): THREE.BufferGeometry {
  return merge([box(0.12, 0.05, 0.12, 0, 0.025, 0, 0xc0bab0), cyl(0.012, 0.009, 0.95, 0, 0.05, 0, 0xeeeeee, 6), ball(0.018, 0, 1.01, 0, 0xd8b440)]);
}

/** Flag cloth: hoist edge at the origin, flying along +X (uv for the flag texture). */
function flagCloth(): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(0.33, 0.22, 8, 4).translate(0.165, 0, 0);
  return g;
}

function flowers(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const cols = [0xd8243a, 0xf2c21b, 0x8a3fc4, 0xf4f0ea, 0xff7a1a];
  // soil bed ring + rings of blooms + a clipped bush in the middle
  parts.push(paint(new THREE.RingGeometry(0.18, 0.4, 20).rotateX(-Math.PI / 2).translate(0, 0.012, 0), C(0x4a3424)));
  for (const [r, n, ci] of [
    [0.36, 16, 0],
    [0.28, 12, 1],
    [0.21, 9, 2],
  ] as const) {
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2 + r;
      parts.push(ball(0.03 + (k % 3) * 0.004, Math.cos(a) * r, 0.03, Math.sin(a) * r, cols[(ci + (k % 2) * 3) % cols.length]));
    }
  }
  parts.push(ball(0.12, 0, 0.1, 0, 0x3d6e2a, 1));
  return merge(parts);
}

function palm(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const trunk = 0x8a6a46;
  let x = 0;
  let y = 0;
  for (let k = 0; k < 6; k++) {
    const r = 0.035 - k * 0.003;
    parts.push(paint(new THREE.CylinderGeometry(r * 0.9, r, 0.14, 6).translate(x, y + 0.07, 0), C(k % 2 ? trunk : 0x7a5c3c)));
    x += 0.012 + k * 0.004;
    y += 0.135;
  }
  for (let f = 0; f < 7; f++) {
    const a = (f / 7) * Math.PI * 2;
    for (let s = 0; s < 3; s++) {
      const L = 0.13;
      const d0 = s * L;
      const g = new THREE.BoxGeometry(L, 0.008, 0.07 - s * 0.018);
      g.translate(L / 2, 0, 0);
      g.rotateZ(-0.25 - s * 0.35);
      const drop = -(s * s) * 0.03;
      g.translate(d0 * 0.95, drop, 0);
      g.rotateY(a);
      g.translate(x, y, 0);
      parts.push(paint(g, C(s === 2 ? 0x5e8a2a : 0x3e7a24)));
    }
  }
  parts.push(ball(0.04, x, y - 0.02, 0, 0x6a4a20));
  return merge(parts);
}

function spruce(): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [cyl(0.03, 0.025, 0.12, 0, 0, 0, 0x4a3424, 6)];
  const tiers = [
    [0.26, 0.24, 0.1],
    [0.21, 0.22, 0.26],
    [0.16, 0.2, 0.4],
    [0.1, 0.18, 0.53],
  ];
  for (const [r, h, y] of tiers) {
    parts.push(paint(new THREE.ConeGeometry(r, h, 9).translate(0, y + h / 2, 0), C(0x1f4a2e)));
    parts.push(paint(new THREE.ConeGeometry(r * 0.7, h * 0.45, 9).translate(0, y + h * 0.78, 0), C(0xe8eef4)));
  }
  parts.push(paint(new THREE.OctahedronGeometry(0.04).translate(0, 0.76, 0), C(0xffd84a)));
  const cols = [0xe0203a, 0x2a6ae0, 0xf2c21b, 0xe0203a, 0xf4f4f4];
  for (let k = 0; k < 14; k++) {
    const t = k / 14;
    const yy = 0.15 + t * 0.52;
    const rr = 0.24 * (1 - t * 0.85);
    const a = k * 2.4;
    parts.push(ball(0.016, Math.cos(a) * rr, yy, Math.sin(a) * rr, cols[k % cols.length]));
  }
  return merge(parts);
}

/** Billboard frame (facing +X): two posts, a frame, lamp arms. The faces are separate (adverts). */
const BB_W = 0.92;
const BB_H = 0.46;
const BB_Y = 0.64;
function billboard(): THREE.BufferGeometry {
  const steel = 0x6b6f74;
  return merge([
    box(0.05, BB_Y, 0.05, 0, BB_Y / 2, -0.26, steel),
    box(0.05, BB_Y, 0.05, 0, BB_Y / 2, 0.26, steel),
    box(0.03, BB_H + 0.04, BB_W + 0.04, 0, BB_Y, 0, 0x2a2c30),
    box(0.1, 0.012, BB_W, 0.07, BB_Y - BB_H / 2 - 0.03, 0, steel),
    // lamp arms over the front face
    box(0.14, 0.012, 0.012, 0.07, BB_Y + BB_H / 2 + 0.04, -0.24, steel),
    box(0.14, 0.012, 0.012, 0.07, BB_Y + BB_H / 2 + 0.04, 0.24, steel),
    box(0.05, 0.025, 0.06, 0.14, BB_Y + BB_H / 2 + 0.03, -0.24, 0x30343a),
    box(0.05, 0.025, 0.06, 0.14, BB_Y + BB_H / 2 + 0.03, 0.24, 0x30343a),
  ]);
}

function lotLamp(): THREE.BufferGeometry {
  return merge([cyl(0.016, 0.012, 0.72, 0, 0, 0, 0x7f8388, 6), box(0.16, 0.014, 0.014, 0.07, 0.71, 0, 0x7f8388), box(0.07, 0.022, 0.045, 0.15, 0.7, 0, 0x2c2f33)]);
}

function booth(): THREE.BufferGeometry {
  return merge([
    box(0.2, 0.2, 0.16, 0, 0.1, 0, 0xe2ddd2),
    box(0.006, 0.07, 0.12, 0.101, 0.14, 0, 0x2a4a5a),
    box(0.24, 0.025, 0.2, 0, 0.212, 0, 0xc0262a),
    // barrier post and a raised arm, red and white
    box(0.04, 0.12, 0.04, 0.0, 0.06, 0.22, 0x8a8e94),
    paint(new THREE.BoxGeometry(0.02, 0.56, 0.02).translate(0, 0.28, 0).rotateX(-0.35).translate(0, 0.11, 0.22), C(0xd8202a)),
  ]);
}

// ------------------------------------------------------------------ banks

class Bank {
  readonly mesh: THREE.InstancedMesh;
  readonly cell: THREE.InstancedBufferAttribute | null;
  constructor(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    readonly items: Item[],
    name: string,
    shadow: boolean,
    cells = false,
  ) {
    if (cells) {
      geo.setAttribute('aCell', (this.cell = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, items.length) * 2), 2)));
      this.cell.setUsage(THREE.DynamicDrawUsage);
    } else this.cell = null;
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = shadow;
    m.count = 0;
    m.visible = false;
    m.name = name;
    this.mesh = m;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

/** Which centrepiece an island gets (deterministic), or none. */
export function centrepiece(biome: GameMap['biome'], i: number, ri: number, dead: boolean): 'fountain' | 'statue' | 'flag' | 'flowers' | 'palms' | 'spruce' | null {
  const r = hash2(i, 17, 4049);
  if (r < 0.22) return null; // plain shrubs on some
  const big = ri > 0.62 && !dead;
  const k = hash2(i, 18, 4049);
  if (biome === 'desert') return k < 0.55 ? 'palms' : k < 0.75 && big ? 'fountain' : k < 0.88 ? 'flag' : 'statue';
  if (biome === 'winter') return k < 0.5 ? 'spruce' : k < 0.75 ? 'statue' : 'flag';
  if (biome === 'urban') return k < 0.4 ? 'fountain' : k < 0.65 ? 'statue' : k < 0.85 ? 'flag' : 'flowers';
  return k < 0.4 ? 'flowers' : k < 0.6 ? 'statue' : k < 0.8 ? 'flag' : 'fountain';
}

export class Landmarks {
  readonly group = new THREE.Group();
  private banks: Bank[] = [];
  private refreshT = 0;
  private hidden = false;
  private time = { value: 0 };
  private boardMat: THREE.MeshStandardMaterial | null = null;
  private boards: Item[] = [];
  private spruces: Item[] = [];
  private lotLamps: Item[] = [];
  private visBoards: number[] = [];
  private visSpruce: number[] = [];
  private visLamps: number[] = [];
  /** Islands with a centrepiece (the island shrubs keep off them). */
  readonly decorated = new Set<number>();

  constructor(
    map: GameMap,
    net: RoadNet,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
    nations: string[],
  ) {
    this.group.name = 'roadside-landmarks';
    if (quality === 'low') return;
    const m = map;
    const shadow = quality === 'high';
    const mat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.65, metalness: 0.1 }));
    const gh = (x: number, y: number) => surfaceHeight(m, x, y);
    const lists: Record<string, Item[]> = { fountain: [], statue: [], flag: [], flowers: [], palms: [], spruce: [] };
    net.loops.forEach((lp, i) => {
      if (!lp.paved || lp.ri < 0.4) return;
      const kind = centrepiece(m.biome, i, lp.ri, lp.dead);
      if (!kind) return;
      this.decorated.add(i);
      const sc = Math.min(1.25, lp.ri / 0.7);
      const h = gh(lp.x, lp.y) + 0.045;
      if (kind === 'palms') {
        const n = lp.ri > 0.6 ? 3 : 2;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + i;
          const r = n > 1 ? lp.ri * 0.4 : 0;
          lists.palms.push({ x: lp.x + Math.cos(a) * r, y: lp.y + Math.sin(a) * r, h, yaw: a * 2.3, s: (0.85 + hash2(i, k, 77) * 0.35) * Math.min(1.1, sc), a: 0, b: 0 });
        }
        lists.flowers.push({ x: lp.x, y: lp.y, h, yaw: 0, s: lp.ri * 0.9 / 0.4 * 0.55, a: 0, b: 0 });
      } else lists[kind].push({ x: lp.x, y: lp.y, h, yaw: hash2(i, 3, 78) * Math.PI * 2, s: kind === 'flowers' ? (lp.ri * 0.92) / 0.4 : sc, a: 0, b: 0 });
    });
    const add = (geo: THREE.BufferGeometry, items: Item[], name: string, sh: boolean, mt: THREE.Material = mat, cells = false) => {
      if (!items.length) return null;
      const b = new Bank(geo, mt, items, name, sh, cells);
      this.banks.push(b);
      this.group.add(b.mesh);
      return b;
    };
    add(fountainStone(), lists.fountain, 'lm-fountain', shadow);
    if (lists.fountain.length) add(fountainWater(), lists.fountain, 'lm-fountain-water', false, this.waterMaterial());
    add(statue(), lists.statue, 'lm-statue', shadow);
    add(flagPole(), lists.flag, 'lm-flagpole', shadow);
    if (lists.flag.length) {
      const flagItems = lists.flag.map((it) => ({ ...it, h: it.h + 0.86 }));
      add(flagCloth(), flagItems, 'lm-flag', false, this.flagMaterial(fog, nations[0] ?? 'usa'));
    }
    add(flowers(), lists.flowers, 'lm-flowers', false);
    add(palm(), lists.palms, 'lm-palms', shadow);
    add(spruce(), lists.spruce, 'lm-spruce', shadow);
    this.spruces = lists.spruce;

    // billboards: the local language mostly, the other side's here and there
    const langs = [...new Set(nations.filter((n) => LANGS[n]))];
    if (!langs.length) langs.push('usa');
    const atlas = net.boards.length ? adAtlas(langs, quality === 'high' ? 1 : 0.5) : null;
    if (atlas) {
      const rows = Math.ceil(atlas.cells / 2);
      for (const bd of net.boards) {
        const pick = (salt: number) => {
          const li = langs.length > 1 && hash2(bd.seed, salt, 5) < 0.3 ? 1 : 0;
          const ad = Math.floor(hash2(bd.seed, salt, 6) * 6);
          return li * 6 + ad;
        };
        this.boards.push({ x: bd.x, y: bd.y, h: gh(bd.x, bd.y), yaw: bd.yaw, s: 1, a: pick(1), b: pick(2) });
      }
      add(billboard(), this.boards, 'lm-billboards', shadow);
      const tex = new THREE.CanvasTexture(atlas.canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const bm = new THREE.MeshStandardMaterial({ map: tex, emissiveMap: tex, emissive: new THREE.Color(1, 1, 1), emissiveIntensity: 0, roughness: 0.55, metalness: 0 });
      bm.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace('#include <common>', `#include <common>\nattribute vec2 aCell;`)
          .replace(
            '#include <uv_vertex>',
            `#include <uv_vertex>
            {
              vec2 cuv = vec2( ( aCell.x + uv.x ) * 0.5, 1.0 - ( aCell.y + 1.0 - uv.y ) / ${rows.toFixed(1)} );
              #ifdef USE_MAP
                vMapUv = cuv;
              #endif
              #ifdef USE_EMISSIVEMAP
                vEmissiveMapUv = cuv;
              #endif
            }`,
          );
      };
      fog.apply(bm);
      bm.customProgramCacheKey = () => 'fog2-billboard-' + rows;
      this.boardMat = bm;
      const face = (side: number) => {
        const g = new THREE.PlaneGeometry(BB_W, BB_H).rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2).translate(side * 0.017, BB_Y, 0);
        return g;
      };
      const cellOf = (k: number) => [k % 2, Math.floor(k / 2)];
      const front = add(face(1), this.boards, 'lm-ads-front', false, bm, true);
      const back = add(face(-1), this.boards.map((it) => ({ ...it, a: it.b })), 'lm-ads-back', false, bm, true);
      for (const b of [front, back]) {
        if (!b?.cell) continue;
        b.items.forEach((it, i) => {
          const [cx, cy] = cellOf(it.a);
          b.cell!.setXY(i, cx, cy);
        });
        // (cells are re-packed with the visible instances in refresh())
      }
    }
    // parking lots: lamp posts, and in the city a ticket booth with a barrier
    const booths: Item[] = [];
    for (const lot of net.lots) {
      for (const sgn of [-1, 1]) {
        const x = lot.x + lot.ux * sgn * (lot.L / 2 - 0.15) + lot.nx * (lot.D / 2 + 0.08);
        const y = lot.y + lot.uy * sgn * (lot.L / 2 - 0.15) + lot.ny * (lot.D / 2 + 0.08);
        this.lotLamps.push({ x, y, h: gh(x, y), yaw: Math.atan2(-lot.ny, -lot.nx), s: 1, a: 0, b: 0 });
      }
      if (lot.city) {
        const x = lot.x - lot.ux * (lot.L / 2 - 0.05) - lot.nx * (lot.D / 2 - 0.22);
        const y = lot.y - lot.uy * (lot.L / 2 - 0.05) - lot.ny * (lot.D / 2 - 0.22);
        booths.push({ x, y, h: gh(x, y), yaw: Math.atan2(-lot.ny, -lot.nx), s: 1, a: 0, b: 0 });
      }
    }
    add(lotLamp(), this.lotLamps, 'lm-lot-lamps', shadow);
    add(booth(), booths, 'lm-booths', shadow);
  }

  private waterMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: { uTime: this.time },
      transparent: true,
      depthWrite: false,
      vertexShader: /* glsl */ `
        attribute float aT;
        uniform float uTime;
        varying float vT;
        varying vec2 vXZ;
        void main() {
          vT = aT;
          vec3 p = position;
          // the jets flicker a little
          if (aT >= 0.0) p += vec3(sin(uTime * 13.0 + p.y * 40.0), 0.0, cos(uTime * 11.0 + p.y * 37.0)) * 0.004 * aT;
          vXZ = p.xz;
          gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(p, 1.0);
        }`,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        varying float vT;
        varying vec2 vXZ;
        void main() {
          if (vT < 0.0) {
            float r = length(vXZ);
            float rip = 0.5 + 0.5 * sin(r * 70.0 - uTime * 6.0);
            vec3 c = mix(vec3(0.16, 0.36, 0.42), vec3(0.62, 0.82, 0.86), rip * 0.35 + smoothstep(0.2, 0.0, r) * 0.4);
            gl_FragColor = vec4(c, 0.82);
          } else {
            float flow = 0.55 + 0.45 * sin(vT * 26.0 - uTime * 14.0);
            gl_FragColor = vec4(vec3(0.85, 0.94, 1.0), (0.35 + 0.4 * flow) * (1.0 - vT * 0.35));
          }
        }`,
    });
  }

  private flagMaterial(fog: FogOfWar, nation: string): THREE.Material {
    let tex: THREE.Texture | null = null;
    if (typeof document !== 'undefined') {
      const cv = document.createElement('canvas');
      cv.width = 96;
      cv.height = 64;
      const c = cv.getContext('2d');
      if (c && drawFlag(c, nation, 96, 64)) {
        tex = new THREE.CanvasTexture(cv);
        tex.colorSpace = THREE.SRGBColorSpace;
      }
    }
    const mat = new THREE.MeshStandardMaterial({ map: tex, color: tex ? 0xffffff : 0xcc2222, side: THREE.DoubleSide, roughness: 0.8 });
    const time = this.time;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = time;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;').replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        {
          float k = transformed.x / 0.33;
          transformed.z += sin(transformed.x * 26.0 - uTime * 7.0) * 0.022 * k;
          transformed.y -= k * k * 0.03;
        }`,
      );
    };
    fog.apply(mat);
    mat.customProgramCacheKey = () => 'fog2-flagcloth';
    return mat;
  }

  private refresh(f: AmbientFrame) {
    const vis = (it: Item) => it.x > f.vx0 && it.x < f.vx1 && it.y > f.vy0 && it.y < f.vy1 && this.probe.visible(it.x, it.y);
    for (const b of this.banks) {
      let n = 0;
      for (const it of b.items) {
        if (!vis(it)) continue;
        _q.setFromAxisAngle(_up, -it.yaw);
        _m.compose(_p.set(it.x, it.h, it.y), _q, _s.set(it.s, it.s, it.s));
        b.mesh.setMatrixAt(n, _m);
        if (b.cell) b.cell.setXY(n, it.a % 2, Math.floor(it.a / 2));
        n++;
      }
      b.mesh.count = n;
      b.mesh.visible = n > 0;
      if (n) {
        b.mesh.instanceMatrix.clearUpdateRanges();
        b.mesh.instanceMatrix.addUpdateRange(0, n * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
        if (b.cell) {
          b.cell.clearUpdateRanges();
          b.cell.addUpdateRange(0, n * 2);
          b.cell.needsUpdate = true;
        }
      }
    }
    const pick = (list: Item[], out: number[]) => {
      out.length = 0;
      for (let i = 0; i < list.length; i++) if (vis(list[i])) out.push(i);
    };
    pick(this.boards, this.visBoards);
    pick(this.spruces, this.visSpruce);
    pick(this.lotLamps, this.visLamps);
  }

  draw(f: AmbientFrame, time: number) {
    if (!this.banks.length) return;
    this.time.value = time;
    if (f.vx1 - f.vx0 > FAR) {
      if (!this.hidden) for (const b of this.banks) b.mesh.visible = false;
      this.hidden = true;
      return;
    }
    this.refreshT -= f.dt;
    if (this.hidden || this.refreshT <= 0) {
      this.refreshT = 0.3;
      this.refresh(f);
      this.hidden = false;
    }
    const dk = f.dark;
    // adverts glow at night, their lamps light them
    if (this.boardMat) this.boardMat.emissiveIntensity = dk * 0.85;
    const Lt = this.lights;
    if (dk > 0.1) {
      for (const i of this.visBoards) {
        const b = this.boards[i];
        const fx = Math.cos(b.yaw);
        const fy = Math.sin(b.yaw);
        for (const z of [-0.24, 0.24]) {
          const x = b.x + fx * 0.14 - fy * z;
          const y = b.y + fy * 0.14 + fx * z;
          Lt.flare(x, b.h + BB_Y + BB_H / 2 + 0.01, y, 0.1, 1.6 * dk, 1.5 * dk, 1.2 * dk);
        }
      }
      for (const i of this.visLamps) {
        const l = this.lotLamps[i];
        const x = l.x + Math.cos(l.yaw) * 0.15;
        const y = l.y + Math.sin(l.yaw) * 0.15;
        Lt.flare(x, l.h + 0.68, y, 0.13, 1.9 * dk, 1.65 * dk, 1.1 * dk);
        Lt.pool(x, l.h, y, 0, 1.1, 1.1, 0.32 * dk, 0.28 * dk, 0.18 * dk);
      }
      // the spruce's fairy lights twinkle
      for (const i of this.visSpruce) {
        const s = this.spruces[i];
        for (let k = 0; k < 6; k++) {
          const t = k / 6;
          const a = k * 2.4 + s.yaw;
          const rr = 0.22 * (1 - t * 0.85) * s.s;
          const on = Math.sin(time * 3 + k * 1.7) > -0.2;
          if (!on) continue;
          const col = k % 3;
          Lt.flare(s.x + Math.cos(a) * rr, s.h + (0.17 + t * 0.5) * s.s, s.y + Math.sin(a) * rr, 0.05, col === 0 ? 1.6 * dk : 0.6 * dk, col === 1 ? 1.4 * dk : 0.5 * dk, col === 2 ? 1.6 * dk : 0.3 * dk);
        }
        Lt.flare(s.x, s.h + 0.76 * s.s, s.y, 0.08, 1.8 * dk, 1.5 * dk, 0.4 * dk);
      }
    }
  }
}
