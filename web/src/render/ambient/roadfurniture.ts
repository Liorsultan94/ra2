import * as THREE from 'three';
import type { GameMap } from '../../sim/map';
import { rampHeight } from '../deckramp';
import type { FogOfWar } from '../fog';
import { surfaceHeight } from '../ground';
import type { GeoBuilder } from '../geo';
import type { Road } from '../layout';
import { netForRoads } from './clearance';
import { Landmarks, centrepiece } from './landmarks';
import { Light, MarkKind, PropKind, headLight, pointAt, wrapPi, type Mark, type RoadNet } from './roadnet';
import { groundAt, type AmbientFrame, type FogProbe, type LightSprites, type Quality } from './shared';

/*
 * Road furniture of the civilian traffic (roadnet.ts decides where):
 *
 *  - markings as one static decal mesh over the ground and the road ribbons
 *    (polygon offset, conforming to the terrain): turning circles /
 *    roundabouts (asphalt ring, striped kerb, island), gravel turning loops,
 *    stop lines, give-way "shark teeth", zebra crossings and the short links
 *    where a road or track stops short of the road it joins. One atlas
 *    texture painted for the map's biome (dusty desert, snowy winter, crisp
 *    city asphalt), one draw call;
 *  - traffic lights (pole + head, the lit lamp as a separate unlit instance
 *    and a LightSprites flare that glows at night), give-way and stop signs,
 *    roundabout island kerbs and shrubs: instanced, low-poly, one shared
 *    material, fog-of-war culled, hidden at far zoom and skipped on low
 *    quality (the rules still apply).
 *
 * Draw calls: decals 1, poles 1, heads 1, lit lamps 1, give-way signs 1,
 * stop signs 1, kerbs 1, shrubs 1 (empty ones are skipped).
 */

const LIFT = 0.045;
/** View width (tiles) beyond which the furniture is hidden. */
const FAR = 62;

const C = (hex: number) => new THREE.Color(hex);

// ------------------------------------------------------------------ ring ribbons

const _rv = new THREE.Vector3();
const _rn = new THREE.Vector3(0, 1, 0);

/**
 * The asphalt ring of every paved roundabout / turning circle as a road piece
 * in the road ribbon mesh (scenery.ts): same material, texture and biome look
 * as the roads it joins. Radially the ring is the outer half of a road (the
 * outer edge is the road's shoulder and edge line, the inner part plain
 * asphalt under the island); where an arm joins, the shoulder gives way to
 * asphalt and the edge flares out in curved corners. The roads themselves are
 * cut back to just inside the ring (clearance.ts), which sits a hair above them.
 */
export function appendLoopRibbons(rb: GeoBuilder, m: GameMap, roads: readonly Road[]) {
  // joined roads: one welded ribbon with the width tapering, the look switching on a shared row
  for (const r of roads) if (r.taper && !r.painted) taperedRibbon(rb, m, r);
  const net = netForRoads(roads);
  if (!net) return;
  for (const lp of net.loops) {
    if (!lp.paved) continue;
    const nd = net.nodes[lp.node];
    const L0 = net.lines[nd.arms[0].line];
    if (L0.painted) continue; // city streets: a decal on the painted asphalt
    const mouths = nd.arms.map((a) => {
      const L = net.lines[a.line];
      const p = pointAt(L, a.edge);
      return { ang: Math.atan2(p.y - lp.y, p.x - lp.x), h: L.half };
    });
    const u0 = nd.arms.some((a) => net.lines[a.line].variant === 0) ? 0.005 : 0.505;
    const N = Math.max(40, Math.ceil(lp.R * 30));
    const K = 5;
    const rIn = Math.max(0.05, lp.ri - 0.08);
    const rMid = (lp.R + rIn) / 2;
    const reps = Math.max(1, Math.round((Math.PI * 2 * rMid) / 6));
    const rows: number[][] = [];
    for (let i = 0; i <= N; i++) {
      const th = (i / N) * Math.PI * 2;
      let mouth = 0;
      let flare = 0;
      for (const mo of mouths) {
        const d = Math.abs(wrapPi(th - mo.ang)) * lp.R;
        const sm = (a: number, b: number, x: number) => {
          const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
          return t * t * (3 - 2 * t);
        };
        mouth = Math.max(mouth, 1 - sm(mo.h * 0.8, mo.h + 0.3, d));
        // curved corners: the edge swells out between the road edge and the ring
        flare = Math.max(flare, 0.03 + 0.13 * sm(mo.h * 0.5, mo.h + 0.05, d) * (1 - sm(mo.h + 0.1, mo.h + 0.5, d)));
      }
      const Ro = lp.R + flare;
      // across: the shoulder in a band as wide as a road's, then asphalt (no shoulder where an arm joins)
      const uOut = 0.02 + 0.3 * mouth;
      const row: number[] = [];
      for (let k = 0; k <= K; k++) {
        // outer -> inner (the ribbon builder's winding)
        const r = k === 0 ? Ro : k === 1 ? Ro - 0.12 : k === 2 ? Ro - 0.3 : Ro - 0.3 + ((rIn - Ro + 0.3) * (k - 2)) / (K - 2);
        const uu = k === 0 ? uOut : k === 1 ? Math.max(uOut, 0.16) : k === 2 ? Math.max(uOut, 0.32) : 0.32 + (0.44 - 0.32) * ((k - 2) / (K - 2));
        const x = lp.x + Math.cos(th) * r;
        const z = lp.y + Math.sin(th) * r;
        _rv.set(x, surfaceHeight(m, x, z) + 0.038, z);
        row.push(rb.vert(_rv, _rn, u0 + 0.49 * uu, (i / N) * reps, 1));
      }
      rows.push(row);
    }
    for (let i = 0; i < N; i++) for (let k = 0; k < K; k++) rb.quad(rows[i][k], rows[i + 1][k], rows[i][k + 1], rows[i + 1][k + 1]);
  }
  // parking lots: an asphalt apron with the road's shoulder round its edge
  for (const lot of net.lots) {
    const wx = -lot.uy;
    const wy = lot.ux;
    const ni = Math.ceil(lot.L / 0.25);
    const nk = Math.ceil(lot.D / 0.25);
    const rows: number[][] = [];
    for (let i = 0; i <= ni; i++) {
      const sx = -lot.L / 2 - 0.05 + ((lot.L + 0.1) * i) / ni;
      const row: number[] = [];
      for (let k = 0; k <= nk; k++) {
        const t = -lot.D / 2 - 0.05 + ((lot.D + 0.1) * k) / nk;
        const edge = Math.min(lot.L / 2 + 0.05 - Math.abs(sx), lot.D / 2 + 0.05 - Math.abs(t));
        const x = lot.x + lot.ux * sx + wx * t;
        const z = lot.y + lot.uy * sx + wy * t;
        _rv.set(x, surfaceHeight(m, x, z) + 0.034, z);
        row.push(rb.vert(_rv, _rn, 0.505 + 0.49 * Math.min(0.34, 0.02 + edge * 1.4), (sx + lot.L) / 6, 1));
      }
      rows.push(row);
    }
    for (let i = 0; i < ni; i++) for (let k = 0; k < nk; k++) rb.quad(rows[i][k], rows[i + 1][k], rows[i][k + 1], rows[i + 1][k + 1]);
  }
}

/** The road ribbon of scenery.ts, with a width and look per point (Road.taper). */
function taperedRibbon(rb: GeoBuilder, m: GameMap, r: Road) {
  const t = r.taper!;
  const n = r.pts.length;
  const across = [-1, -0.5, 0, 0.5, 1];
  // closed rings: the last point is the first again; the neighbours wrap and the texture repeats a whole number of times
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(r.pts[i].x - r.pts[i - 1].x, r.pts[i].y - r.pts[i - 1].y);
  const vScale = r.closed ? Math.max(1, Math.round(total / 6)) / (total / 6) : 1;
  const from = t.from ?? 0;
  const to = Math.min(n, t.to ?? n);
  let s = 0;
  let prev: number[] | null = null;
  for (let i = 0; i < n; i++) {
    const p = r.pts[i];
    if (i > 0) s += Math.hypot(p.x - r.pts[i - 1].x, p.y - r.pts[i - 1].y);
    if (i < from || i >= to) continue;
    const a = r.pts[i > 0 ? i - 1 : r.closed ? n - 2 : 0];
    const c = r.pts[i < n - 1 ? i + 1 : r.closed ? 1 : n - 1];
    const L = Math.hypot(c.x - a.x, c.y - a.y) || 1;
    const nx = -(c.y - a.y) / L;
    const ny = (c.x - a.x) / L;
    const w = t.w[i] ?? r.width;
    const row = (variant: number) => {
      const u0 = variant === 0 ? 0.005 : 0.505;
      return across.map((o) => {
        const x = p.x + nx * o * (w / 2);
        const z = p.y + ny * o * (w / 2);
        const g = surfaceHeight(m, x, z);
        const h = rampHeight(m, x, z, g, 0.03 + (t.lift ?? 0));
        _rv.set(x, h, z);
        return rb.vert(_rv, _rn, u0 + 0.49 * ((o + 1) / 2), (s / 6) * vScale, 1);
      });
    };
    const v = t.v[i] ?? r.variant;
    const vPrev = i > 0 ? (t.v[i - 1] ?? r.variant) : v;
    // the look switches on a shared row: the old look's row closes the last quad, the new one starts the next
    const cur = row(vPrev);
    if (prev) for (let k = 0; k < across.length - 1; k++) rb.quad(prev[k], cur[k], prev[k + 1], cur[k + 1]);
    prev = v !== vPrev ? row(v) : cur;
  }
}

// ------------------------------------------------------------------ atlas

interface Pal {
  asphalt: [number, number, number];
  shoulder: [number, number, number];
  gravel: [number, number, number];
  island: [number, number, number];
  islandAlt: [number, number, number];
  paint: [number, number, number];
  urban: boolean;
}

function palette(biome: GameMap['biome']): Pal {
  switch (biome) {
    case 'desert':
      return { asphalt: [78, 74, 68], shoulder: [168, 140, 104], gravel: [176, 150, 112], island: [190, 160, 118], islandAlt: [150, 140, 90], paint: [226, 218, 196], urban: false };
    case 'winter':
      return { asphalt: [150, 156, 166], shoulder: [196, 202, 212], gravel: [170, 168, 166], island: [222, 228, 236], islandAlt: [190, 198, 206], paint: [236, 238, 240], urban: false };
    case 'urban':
      return { asphalt: [92, 94, 98], shoulder: [150, 148, 142], gravel: [128, 120, 108], island: [82, 120, 58], islandAlt: [66, 104, 46], paint: [236, 234, 226], urban: true };
    default:
      return { asphalt: [70, 71, 75], shoulder: [118, 108, 92], gravel: [128, 116, 96], island: [86, 118, 56], islandAlt: [70, 100, 44], paint: [228, 226, 216], urban: false };
  }
}

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(s, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1). */
function vnoise(x: number, y: number, s: number) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const u = fx * fx * (3 - 2 * fx);
  const v = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, s);
  const b = hash(ix + 1, iy, s);
  const c = hash(ix, iy + 1, s);
  const d = hash(ix + 1, iy + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

const CELL = 256;

/** Atlas cells (uv rects): paved disc, gravel disc, strip rows (stop bar, teeth, zebra, asphalt link) and a gravel link. */
const UV = {
  disc: [0, 0, 0.5, 0.5],
  island: [0.5, 0, 1, 0.5],
  bar: [0, 0.5, 0.5, 0.625],
  teeth: [0, 0.625, 0.5, 0.75],
  zebra: [0, 0.75, 0.5, 0.875],
  splitter: [0, 0.875, 0.5, 1],
  gravel2: [0.5, 0.5, 1, 1],
} as const;

function paintAtlas(pal: Pal): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const S = CELL * 2;
  const cv = document.createElement('canvas');
  cv.width = S;
  cv.height = S;
  const ctx = cv.getContext('2d');
  if (!ctx) return null;
  const img = ctx.createImageData(S, S);
  const d = img.data;
  const put = (x: number, y: number, c: readonly number[], a = 255) => {
    const o = (y * S + x) * 4;
    d[o] = Math.max(0, Math.min(255, c[0]));
    d[o + 1] = Math.max(0, Math.min(255, c[1]));
    d[o + 2] = Math.max(0, Math.min(255, c[2]));
    d[o + 3] = a;
  };
  const shade = (c: readonly number[], k: number) => [c[0] * k, c[1] * k, c[2] * k];
  const mix = (a: readonly number[], b: readonly number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const asph = (x: number, y: number) => {
    const n = vnoise(x / 9, y / 9, 3) * 0.6 + vnoise(x / 3, y / 3, 4) * 0.4;
    return shade(pal.asphalt, 0.86 + n * 0.2 + (hash(x, y, 5) - 0.5) * 0.12);
  };
  const grav = (x: number, y: number, base: readonly number[]) => shade(base, 0.8 + vnoise(x / 5, y / 5, 7) * 0.25 + (hash(x, y, 8) - 0.5) * 0.35);
  // paved turning circle: asphalt ring, striped kerb round the island, island (grass / sand / snow)
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const dx = (x + 0.5) / (CELL / 2) - 1;
      const dy = (y + 0.5) / (CELL / 2) - 1;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      const rag = (vnoise(ang * 9 + 20, 0.5, 11) - 0.5) * 0.04;
      if (r > 1 + (pal.urban ? 0 : rag)) {
        put(x, y, [0, 0, 0], 0);
        continue;
      }
      let c: number[];
      if (r < 0.42) {
        if (r > 0.37) {
          // kerb: alternating light / dark blocks
          const seg = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 24) % 2;
          c = seg ? [222, 220, 212] : pal.urban ? [70, 72, 76] : [196, 60, 50];
          c = shade(c, 0.9 + hash(x, y, 12) * 0.12);
        } else {
          const n = vnoise(x / 6, y / 6, 13);
          c = shade(mix(pal.island, pal.islandAlt, n), 0.85 + hash(x, y, 14) * 0.25);
        }
      } else {
        c = asph(x, y);
        // tyre-polished circulating lane, oil stains in the middle of it
        c = shade(c, 1 - Math.exp(-Math.pow((r - 0.72) / 0.08, 2)) * 0.08);
        if (r > 0.93) c = pal.urban ? shade([168, 166, 160], 0.9 + hash(x, y, 15) * 0.15) : mix(c, grav(x, y, pal.shoulder), Math.min(1, (r - 0.93) / 0.05));
        // inner edge line (dashed) round the island
        if (Math.abs(r - 0.455) < 0.008 && Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 36) % 2 === 0) c = mix(c, pal.paint, 0.85);
      }
      put(x, y, c);
    }
  // roundabout island: striped kerb round grass / sand / snow
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const dx = (x + 0.5) / (CELL / 2) - 1;
      const dy = (y + 0.5) / (CELL / 2) - 1;
      const r = Math.hypot(dx, dy);
      const ang = Math.atan2(dy, dx);
      if (r > 1) {
        put(CELL + x, y, [0, 0, 0], 0);
        continue;
      }
      let c: number[];
      if (r > 0.86) {
        const seg = Math.floor(((ang + Math.PI) / (Math.PI * 2)) * 28) % 2;
        c = shade(seg ? [222, 220, 212] : pal.urban ? [70, 72, 76] : [196, 60, 50], 0.9 + hash(x, y, 12) * 0.12);
      } else {
        const n = vnoise(x / 6, y / 6, 13);
        c = shade(mix(pal.island, pal.islandAlt, n), 0.85 + hash(x, y, 14) * 0.25);
        // a darker rim of soil just inside the kerb
        if (r > 0.8) c = shade(c, 0.8);
      }
      put(CELL + x, y, c);
    }
  // strip rows: stop bar, give-way teeth, zebra stripes, splitter island
  const RH = CELL / 4;
  for (let row = 0; row < 4; row++)
    for (let y = 0; y < RH; y++)
      for (let x = 0; x < CELL; x++) {
        const py = CELL + row * RH + y;
        const u = (x + 0.5) / CELL; // along (car side at u = 0)
        const v = (y + 0.5) / RH; // across
        const wear = 0.82 + vnoise(x / 6, y / 3 + row * 7, 19) * 0.25;
        let a = 255;
        let c: number[] = shade(pal.paint, wear);
        if (row === 0) {
          // stop line: solid, a little ragged at the ends
          if (v < 0.03 || v > 0.97) a = 0;
        } else if (row === 1) {
          // shark teeth: apex towards the approaching car
          const k = (v * 7) % 1;
          if (Math.abs(k - 0.5) * 2 > u * 0.92 || k < 0.08 || k > 0.92) a = 0;
        } else if (row === 2) {
          // zebra: stripes along the road, alternating across it
          const k = (v * 9) % 1;
          if (k > 0.55 || u < 0.03 || u > 0.97) a = 0;
        } else {
          // splitter: a painted ghost island (white outline, diagonal hatching) pointing away from the circle
          const w = Math.sin(Math.PI * Math.min(1, u * 1.04)) * (0.6 + 0.4 * (1 - u));
          const d = Math.abs(v - 0.5) * 2;
          const hatch = ((u * 7 + v * 1.2) % 1) < 0.28;
          if (d > w || (d < w - 0.2 && !hatch)) a = 0;
        }
        put(x, py, c, a);
      }
  // gravel link
  for (let y = 0; y < CELL; y++)
    for (let x = 0; x < CELL; x++) {
      const v = (y + 0.5) / CELL;
      const rag = (vnoise(x / 12, 4.5, 23) - 0.5) * 0.12;
      put(CELL + x, CELL + y, grav(x, y + 900, pal.gravel), v < 0.06 + rag || v > 0.94 - rag ? 0 : 255);
    }
  ctx.putImageData(img, 0, 0);
  return cv;
}

// ------------------------------------------------------------------ geometry helpers

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
  ng.deleteAttribute('uv');
  return ng;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  let n = 0;
  for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3);
  const nor = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    if (!p.attributes.normal) p.computeVertexNormals();
    pos.set(p.attributes.position.array as Float32Array, o * 3);
    nor.set(p.attributes.normal.array as Float32Array, o * 3);
    col.set(p.attributes.color.array as Float32Array, o * 3);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/** Flat polygon in the local YZ plane (facing +X) at depth x. */
function plate(pts: [number, number][], x: number, col: THREE.Color, back = false): THREE.BufferGeometry {
  const pos: number[] = [];
  for (let i = 1; i < pts.length - 1; i++) {
    const tri = back ? [pts[0], pts[i + 1], pts[i]] : [pts[0], pts[i], pts[i + 1]];
    for (const [y, z] of tri) pos.push(x, y, -z);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.computeVertexNormals();
  return paint(g, col);
}

const poly = (n: number, r: number, cy: number, rot: number): [number, number][] => Array.from({ length: n }, (_, i) => [cy + Math.sin(rot + (i / n) * Math.PI * 2) * r, Math.cos(rot + (i / n) * Math.PI * 2) * r] as [number, number]);

/**
 * Traffic light (facing +X): the pole at the origin, a mast arm reaching over
 * the inbound lane (local +Z, towards the road) with the head hanging from it.
 */
const POLE_H = 0.78;
const ARM = 0.6;
const HEAD_Y = 0.6;
const LAMP_DY = 0.068;
function headGeometry(): THREE.BufferGeometry {
  // (a little larger than life, like the rest of the RTS props: it's seen from high above)
  const parts: THREE.BufferGeometry[] = [];
  const body = C(0x1c1f1d);
  const metal = C(0x9a9da2);
  parts.push(paint(new THREE.BoxGeometry(0.032, 0.03, ARM + 0.05).translate(0, POLE_H - 0.03, ARM / 2), metal));
  parts.push(paint(new THREE.BoxGeometry(0.016, 0.05, 0.016).translate(0, POLE_H - 0.07, ARM), metal));
  parts.push(paint(new THREE.BoxGeometry(0.075, 0.23, 0.08).translate(0, HEAD_Y, ARM), body));
  // backboard with a white rim (reads against the dark street), yellow top
  parts.push(paint(new THREE.BoxGeometry(0.008, 0.27, 0.13).translate(-0.042, HEAD_Y, ARM), C(0xf2f2ea)));
  parts.push(paint(new THREE.BoxGeometry(0.01, 0.25, 0.11).translate(-0.037, HEAD_Y, ARM), body));
  parts.push(paint(new THREE.BoxGeometry(0.08, 0.012, 0.085).translate(0, HEAD_Y + 0.12, ARM), C(0xd8a91c)));
  for (const k of [-1, 0, 1]) {
    const y = HEAD_Y - k * LAMP_DY;
    parts.push(paint(new THREE.BoxGeometry(0.008, 0.05, 0.05).translate(0.04, y, ARM), C(0x2c2c28))); // dark lens
    parts.push(paint(new THREE.BoxGeometry(0.04, 0.006, 0.064).translate(0.058, y + 0.03, ARM), body)); // visor
  }
  return merge(parts);
}

/** Sign plates lean back a little so they read from the high RTS camera. */
function lean(g: THREE.BufferGeometry, y: number): THREE.BufferGeometry {
  return g.translate(0, -y, 0).rotateZ(0.45).translate(0, y, 0);
}

function giveWayGeometry(): THREE.BufferGeometry {
  const y = 0.44;
  // inverted triangle: red rim, white face
  const tri = (r: number): [number, number][] => [
    [y - r, 0],
    [y + r * 0.5, r * 0.866],
    [y + r * 0.5, -r * 0.866],
  ];
  return lean(merge([plate(tri(0.11), 0.012, C(0xc8201c)), plate(tri(0.066), 0.0135, C(0xf2f2ee)), plate(tri(0.11), 0.01, C(0x8a8c8e), true)]), y);
}

function stopGeometry(): THREE.BufferGeometry {
  const y = 0.44;
  const bar: [number, number][] = [
    [y - 0.012, -0.05],
    [y - 0.012, 0.05],
    [y + 0.012, 0.05],
    [y + 0.012, -0.05],
  ];
  return lean(merge([plate(poly(8, 0.085, y, Math.PI / 8), 0.012, C(0xc01818)), plate(bar, 0.0135, C(0xf4f4f0)), plate(poly(8, 0.085, y, Math.PI / 8), 0.01, C(0x8a8c8e), true)]), y);
}

function kerbGeometry(urban: boolean): THREE.BufferGeometry {
  const col = urban ? C(0xc9c8c2) : C(0xbdbab2);
  const wall = new THREE.CylinderGeometry(1, 1, 0.07, 28, 1, true).translate(0, 0.012, 0);
  const top = new THREE.RingGeometry(0.9, 1, 28, 1).rotateX(-Math.PI / 2).translate(0, 0.047, 0);
  return merge([paint(wall, col), paint(top, col)]);
}

function shrubGeometry(biome: GameMap['biome']): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 0);
  g.computeVertexNormals();
  const base = biome === 'desert' ? C(0x7d7a3e) : biome === 'winter' ? C(0x2f4a36) : C(0x3f6e2a);
  const top = biome === 'winter' ? C(0xe8edf2) : biome === 'desert' ? C(0x9b9450) : C(0x5d8f3a);
  const P = g.attributes.position;
  const col = new Float32Array(P.count * 3);
  const tmp = new THREE.Color();
  for (let i = 0; i < P.count; i++) {
    tmp.copy(base).lerp(top, Math.max(0, Math.min(1, P.getY(i) * 0.9 + 0.3)));
    col[i * 3] = tmp.r;
    col[i * 3 + 1] = tmp.g;
    col[i * 3 + 2] = tmp.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

// ------------------------------------------------------------------ furniture

interface Item {
  x: number;
  y: number;
  yaw: number;
  /** Uniform scale (kerbs: island radius; shrubs: size; poles: height). */
  s: number;
  h: number;
}

interface Head extends Item {
  sig: number;
  axis: number;
}

/** How an item's `s` scales its instance: 0 uniform, 1 height only (poles), 2 radius only (kerbs). */
type ScaleMode = 0 | 1 | 2;

class Bank {
  readonly mesh: THREE.InstancedMesh;
  n = 0;
  constructor(geo: THREE.BufferGeometry, mat: THREE.Material, readonly items: Item[], name: string, shadow: boolean, readonly mode: ScaleMode) {
    const m = new THREE.InstancedMesh(geo, mat, Math.max(1, items.length));
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    m.frustumCulled = false;
    m.castShadow = shadow;
    m.receiveShadow = false;
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
const _c = new THREE.Color();

export class RoadFurniture {
  readonly group = new THREE.Group();
  private banks: Bank[] = [];
  private heads: Head[] = [];
  private lamps: THREE.InstancedMesh | null = null;
  /** Visible heads (indices into `heads`), refreshed with the static banks. */
  private visHeads: number[] = [];
  private refreshT = 0;
  private lastView = [0, 0, 0, 0];
  private hidden = false;
  private landmarks: Landmarks;

  constructor(
    private map: GameMap,
    private net: RoadNet,
    fog: FogOfWar,
    private probe: FogProbe,
    private lights: LightSprites,
    quality: Quality,
    nations: string[] = [],
  ) {
    this.group.name = 'road-furniture';
    this.buildDecals(fog);
    this.landmarks = new Landmarks(map, net, fog, probe, lights, quality, nations);
    this.group.add(this.landmarks.group);
    if (quality === 'low') return; // the rules still apply, the hardware isn't drawn
    const mat = fog.apply(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, metalness: 0.15 }));
    const shadow = quality === 'high';
    const poles: Item[] = [];
    const give: Item[] = [];
    const stop: Item[] = [];
    const kerbs: Item[] = [];
    const shrubs: Item[] = [];
    const m = map;
    for (const p of net.props) {
      const h = groundAt(m, p.x, p.y);
      if (p.kind === PropKind.Light) {
        poles.push({ x: p.x, y: p.y, yaw: 0, s: POLE_H, h });
        this.heads.push({ x: p.x, y: p.y, yaw: p.yaw, s: 1, h, sig: p.ref, axis: p.axis });
      } else if (p.kind === PropKind.GiveWay || p.kind === PropKind.StopSign) {
        poles.push({ x: p.x, y: p.y, yaw: 0, s: 0.44, h });
        (p.kind === PropKind.GiveWay ? give : stop).push({ x: p.x, y: p.y, yaw: p.yaw, s: 1, h });
      } else if (p.kind === PropKind.Island) {
        kerbs.push({ x: p.x, y: p.y, yaw: 0, s: p.size, h: surfaceHeight(m, p.x, p.y) + LIFT - 0.02 });
        // a few shrubs on the island (deterministic per island), unless it has a centrepiece
        const lp = net.loops[p.ref];
        const n = centrepiece(map.biome, p.ref, lp.ri, lp.dead) && lp.ri >= 0.4 ? 0 : map.biome === 'desert' ? 3 : 5;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2 + hash(k, p.ref, 31) * 0.8;
          const r = k === 0 ? 0 : p.size * (0.45 + hash(k, p.ref, 32) * 0.2);
          const x = p.x + Math.cos(a) * r;
          const y = p.y + Math.sin(a) * r;
          const s = (k === 0 ? 0.13 : 0.075) * (0.8 + hash(k, p.ref, 33) * 0.4) * Math.min(1, p.size / 0.6);
          shrubs.push({ x, y, yaw: a * 3, s, h: surfaceHeight(m, x, y) + LIFT + s * 0.5 });
        }
      }
    }
    const pole = paint(new THREE.CylinderGeometry(0.016, 0.02, 1, 6, 1).translate(0, 0.5, 0), C(0x8d9094));
    const add = (geo: THREE.BufferGeometry, items: Item[], name: string, sh: boolean, mode: ScaleMode = 0) => {
      if (!items.length) return null;
      const b = new Bank(geo, mat, items, name, sh, mode);
      this.banks.push(b);
      this.group.add(b.mesh);
      return b;
    };
    add(pole, poles, 'furn-poles', shadow, 1);
    add(headGeometry(), this.heads, 'furn-heads', shadow);
    add(giveWayGeometry(), give, 'furn-giveway', false);
    add(stopGeometry(), stop, 'furn-stop', false);
    add(kerbGeometry(map.biome === 'urban'), kerbs, 'furn-kerbs', false, 2);
    add(shrubGeometry(map.biome), shrubs, 'furn-shrubs', shadow);
    if (this.heads.length) {
      // the lit lamp: unlit, bright, coloured per instance
      const lm = new THREE.InstancedMesh(new THREE.SphereGeometry(0.026, 8, 6), new THREE.MeshBasicMaterial({ toneMapped: false }), this.heads.length);
      lm.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      lm.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.heads.length * 3), 3);
      lm.instanceColor.setUsage(THREE.DynamicDrawUsage);
      lm.frustumCulled = false;
      lm.count = 0;
      lm.visible = false;
      lm.name = 'furn-lamps';
      this.lamps = lm;
      this.group.add(lm);
    }
  }

  // ---------------------------------------------------------------- decals

  private buildDecals(fog: FogOfWar) {
    const marks = this.net.marks;
    if (!marks.length) return;
    const m = this.map;
    const pal = palette(m.biome);
    const canvas = paintAtlas(pal);
    // bridge ramps: the road ribbons lift onto the decks near the bridge ends
    const height = (x: number, y: number) => {
      const g = surfaceHeight(m, x, y);
      return Math.max(g + LIFT, rampHeight(m, x, y, g, 0) + 0.015);
    };
    const pos: number[] = [];
    const uv: number[] = [];
    const idx: number[] = [];
    const quad = (mk: Mark, rect: readonly number[], disc: boolean) => {
      const [u0, v0, u1, v1] = rect;
      const ca = Math.cos(mk.ang);
      const sa = Math.sin(mk.ang);
      const L = disc ? mk.len * 2 : mk.len;
      const Wd = disc ? mk.len * 2 : mk.wid;
      const nu = Math.max(1, Math.ceil(L / 0.3));
      const nv = Math.max(1, Math.ceil(Wd / 0.3));
      const base = pos.length / 3;
      for (let j = 0; j <= nv; j++)
        for (let i = 0; i <= nu; i++) {
          const a = (i / nu - 0.5) * L; // along
          const b = (j / nv - 0.5) * Wd; // across
          const x = mk.x + ca * a - sa * b;
          const y = mk.y + sa * a + ca * b;
          pos.push(x, height(x, y), y);
          // canvas rows grow downwards: v = 1 - row
          uv.push(u0 + (u1 - u0) * (i / nu), 1 - (v0 + (v1 - v0) * (j / nv)));
        }
      for (let j = 0; j < nv; j++)
        for (let i = 0; i < nu; i++) {
          const a = base + j * (nu + 1) + i;
          const b = a + 1;
          const c = a + nu + 1;
          const d = c + 1;
          idx.push(a, c, b, b, c, d);
        }
    };
    for (const mk of marks) {
      if (mk.kind === MarkKind.Bar) quad(mk, UV.bar, false);
      else if (mk.kind === MarkKind.Teeth) quad(mk, UV.teeth, false);
      else if (mk.kind === MarkKind.Zebra) quad(mk, UV.zebra, false);
      // (turning circles / gravel loops / links: road pieces and ring tracks, see clearance.ts)
    }
    const net = this.net;
    // parking lots: bay lines and arrows
    for (const lot of net.lots) {
      const ang = Math.atan2(lot.ny, lot.nx);
      const n = Math.floor((lot.L - 0.75) / 0.34);
      for (let k = 0; k <= n; k++) {
        const sx = -lot.L / 2 + 0.6 + k * 0.34;
        for (const row of [-1, 1]) {
          const t = row * (0.32 + 0.31);
          quad({ kind: MarkKind.Bar, x: lot.x + lot.ux * sx + lot.nx * t, y: lot.y + lot.uy * sx + lot.ny * t, ang, len: 0.6, wid: 0.028 }, UV.bar, false);
        }
      }
      // arrows on the aisle: in on one side, out on the other
      for (const [side, dir] of [
        [0.14, 1],
        [-0.14, -1],
      ]) {
        const sx = -lot.L / 2 + 0.75;
        const cx = lot.x + lot.ux * sx + lot.nx * side;
        const cy = lot.y + lot.uy * sx + lot.ny * side;
        const ua = Math.atan2(lot.uy * dir, lot.ux * dir);
        quad({ kind: MarkKind.Bar, x: cx, y: cy, ang: ua, len: 0.3, wid: 0.03 }, UV.bar, false);
        for (const sg of [-1, 1]) {
          const ha = ua + sg * 2.5;
          const hx = cx + Math.cos(ua) * 0.15 + Math.cos(ha) * 0.05;
          const hy = cy + Math.sin(ua) * 0.15 + Math.sin(ha) * 0.05;
          quad({ kind: MarkKind.Bar, x: hx, y: hy, ang: ha, len: 0.11, wid: 0.028 }, UV.bar, false);
        }
      }
    }
    for (const lp of net.loops) {
      if (!lp.paved) continue;
      const nd = net.nodes[lp.node];
      // city streets are painted by the ground: the circle is a decal on them
      if (net.lines[nd.arms[0].line].painted) quad({ kind: MarkKind.Disc, x: lp.x, y: lp.y, ang: 0, len: lp.R, wid: lp.R }, UV.disc, true);
      quad({ kind: MarkKind.Disc, x: lp.x, y: lp.y, ang: 0, len: lp.ri + 0.03, wid: 0 }, UV.island, true);
      // splitter islands on the wider roads' mouths
      for (const a of nd.arms) {
        const L = net.lines[a.line];
        if (L.painted || L.lane < 0.2) continue;
        const p = pointAt(L, a.edge + a.dir * 0.5);
        quad({ kind: MarkKind.Disc, x: p.x, y: p.y, ang: Math.atan2(p.ty * a.dir, p.tx * a.dir), len: 0.9, wid: Math.min(0.2, (L.lane - 0.11) * 2) }, UV.splitter, false);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    const tex = canvas ? new THREE.CanvasTexture(canvas) : null;
    if (tex) {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
    }
    const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, roughness: 0.92, metalness: 0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -6 });
    const bc = m.biome === 'desert' ? 1 : m.biome === 'winter' ? 2 : 0;
    if (bc) {
      // desert: drifting sand; winter: snow lying on it (world-space noise, like the road ribbons)
      mat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace(
          '#include <map_fragment>',
          `#include <map_fragment>
          {
            float rn = texture2D( fogNoise, vFogP.xz * 0.21 ).r * 0.6 + texture2D( fogNoise, vFogP.xz * 0.9 ).g * 0.4;
            #if FURN_BIOME == 1
              diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.66, 0.53, 0.36 ) * ( 0.88 + rn * 0.2 ), smoothstep( 0.55, 0.8, rn ) * 0.75 );
            #else
              diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.8, 0.84, 0.9 ) * ( 0.92 + rn * 0.12 ), smoothstep( 0.42, 0.78, rn ) * 0.6 );
            #endif
          }`,
        );
      };
      mat.defines = { ...mat.defines, FURN_BIOME: bc };
    }
    fog.apply(mat);
    mat.customProgramCacheKey = () => 'fog2-roadfurn-b' + bc;
    const mesh = new THREE.Mesh(g, mat);
    mesh.receiveShadow = true;
    mesh.name = 'road-markings';
    mesh.renderOrder = 1;
    this.group.add(mesh);
  }

  // ---------------------------------------------------------------- per frame

  /** Repack the static banks for what's in view and not under the fog (a few times a second). */
  private refresh(f: AmbientFrame) {
    const vis = (it: Item) => it.x > f.vx0 && it.x < f.vx1 && it.y > f.vy0 && it.y < f.vy1 && this.probe.visible(it.x, it.y);
    for (const b of this.banks) {
      let n = 0;
      for (const it of b.items) {
        if (!vis(it)) continue;
        _q.setFromAxisAngle(_up, -it.yaw);
        if (b.mode === 1) _s.set(1, it.s, 1);
        else if (b.mode === 2) _s.set(it.s, 1, it.s);
        else _s.set(it.s, it.s, it.s);
        _m.compose(_p.set(it.x, it.h, it.y), _q, _s);
        b.mesh.setMatrixAt(n++, _m);
      }
      b.n = n;
      b.mesh.count = n;
      b.mesh.visible = n > 0;
      if (n) {
        b.mesh.instanceMatrix.clearUpdateRanges();
        b.mesh.instanceMatrix.addUpdateRange(0, n * 16);
        b.mesh.instanceMatrix.needsUpdate = true;
      }
    }
    this.visHeads.length = 0;
    this.heads.forEach((hd, i) => {
      if (vis(hd)) this.visHeads.push(i);
    });
  }

  draw(f: AmbientFrame, time: number) {
    this.landmarks.draw(f, time);
    if (!this.banks.length && !this.lamps) return;
    const far = f.vx1 - f.vx0 > FAR;
    if (far) {
      if (!this.hidden) {
        for (const b of this.banks) b.mesh.visible = false;
        if (this.lamps) this.lamps.visible = false;
        this.hidden = true;
      }
      return;
    }
    const v = this.lastView;
    this.refreshT -= f.dt;
    if (this.hidden || this.refreshT <= 0 || Math.abs(v[0] - f.vx0) + Math.abs(v[1] - f.vy0) + Math.abs(v[2] - f.vx1) + Math.abs(v[3] - f.vy1) > 1.5) {
      this.refreshT = 0.3;
      v[0] = f.vx0;
      v[1] = f.vy0;
      v[2] = f.vx1;
      v[3] = f.vy1;
      this.refresh(f);
      this.hidden = false;
    }
    // lit lamps (and their glow) follow the signal state every frame
    const lm = this.lamps;
    if (!lm) return;
    const dk = f.dark;
    let n = 0;
    for (const i of this.visHeads) {
      const hd = this.heads[i];
      const sg = this.net.signals[hd.sig];
      const light = headLight(sg.mode, time + sg.offset, hd.axis);
      if (light === Light.Off) continue;
      const ly = hd.h + HEAD_Y + (light === Light.Red ? LAMP_DY : light === Light.Amber ? 0 : -LAMP_DY);
      const fx = Math.cos(hd.yaw);
      const fy = Math.sin(hd.yaw);
      // the head hangs from the mast arm over the lane
      const hx = hd.x - fy * ARM;
      const hy = hd.y + fx * ARM;
      _q.setFromAxisAngle(_up, -hd.yaw);
      _m.compose(_p.set(hx + fx * 0.04, ly, hy + fy * 0.04), _q, _s.set(1, 1, 1));
      lm.setMatrixAt(n, _m);
      if (light === Light.Red) _c.setRGB(2.4, 0.12, 0.06);
      else if (light === Light.Amber) _c.setRGB(2.4, 1.1, 0.05);
      else _c.setRGB(0.15, 2.2, 0.75);
      lm.setColorAt(n++, _c);
      // glow: a soft flare, stronger at night
      const k = 0.6 + dk * 1.1;
      this.lights.flare(hx + fx * 0.07, ly, hy + fy * 0.07, 0.12 + dk * 0.06, _c.r * k * 0.8, _c.g * k * 0.8, _c.b * k * 0.8);
    }
    lm.count = n;
    lm.visible = n > 0;
    if (n) {
      lm.instanceMatrix.clearUpdateRanges();
      lm.instanceMatrix.addUpdateRange(0, n * 16);
      lm.instanceMatrix.needsUpdate = true;
      const ic = lm.instanceColor!;
      ic.clearUpdateRanges();
      ic.addUpdateRange(0, n * 3);
      ic.needsUpdate = true;
    }
  }
}
