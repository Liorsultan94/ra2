import { Tile, type GameMap } from '../../sim/map';
import { hash2 } from '../../sim/rng';
import type { Road, V2 } from '../layout';
import { Ctl, type RoadNet } from './roadnet';

/*
 * Sites for the roadside life (pure, deterministic per map):
 *
 *  - parking lots: in the city and by village houses / shops, beside a paved
 *    road with an access lane off it (a lane of the traffic network: cars turn
 *    in, park in a free bay, and leave later). An aisle down the middle, bays
 *    on both sides;
 *  - billboard spots: by the roundabouts and the city's signalled crossings,
 *    facing the junction, on free ground.
 *
 * Both keep off the bases' build zones, ore, oil, tech sites, buildings,
 * trees, water and every road surface.
 */

export interface Bay {
  x: number;
  y: number;
  /** Heading of a car parked nose-in. */
  yaw: number;
  /** Point on the aisle in front of the bay. */
  ax: number;
  ay: number;
}

export interface Lot {
  /** Centre, along-road axis (unit), depth axis (unit, away from the road). */
  x: number;
  y: number;
  ux: number;
  uy: number;
  nx: number;
  ny: number;
  /** Length along the road, depth. */
  L: number;
  D: number;
  bays: Bay[];
  /** Access lane polyline: road centre -> lot edge -> aisle end. */
  access: V2[];
  /** Drawn part of the access lane (point indices [from, to)): road edge -> lot edge. */
  draw: [number, number];
  /** City lot (booth + barrier). */
  city: boolean;
  /** Lane of the network that serves it (set when the network is built), -1 none. */
  line: number;
  /** Bay occupancy (car id, 0 free): runtime state of the traffic. */
  taken: number[];
}

export interface Board {
  x: number;
  y: number;
  /** Facing (tile-space angle of the front face's normal). */
  yaw: number;
  /** Ad cells (front / back) are picked from this seed. */
  seed: number;
}

const BAY_W = 0.34;
const BAY_D = 0.62;
const AISLE = 0.64;

/** Is the ground free for a site footprint point? */
function siteFree(m: GameMap, occ: Uint8Array, R: number, x: number, y: number): boolean {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (tx < 1 || ty < 1 || tx >= m.w - 1 || ty >= m.h - 1) return false;
  const i = ty * m.w + tx;
  const t = m.tiles[i];
  if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[i] || m.blocked[i] || m.ore[i] || m.oreKind[i]) return false;
  const ix = Math.floor(x * R);
  const iy = Math.floor(y * R);
  if (occ[iy * m.w * R + ix] & 0x1f) return false; // roads, tracks, fields, built, turning places
  return true;
}

function nearForbidden(m: GameMap, x: number, y: number, extra: number): boolean {
  for (const s of m.starts) if (Math.hypot(x - s.x - 0.5, y - s.y - 0.5) < 13 + extra) return true;
  for (const o of m.oils) if (Math.hypot(x - o.x - 0.5, y - o.y - 0.5) < 3 + extra) return true;
  for (const mm of m.oreMines) if (Math.hypot(x - mm.x - 0.5, y - mm.y - 0.5) < 7 + extra) return true;
  for (const st of m.structures) {
    const dx = Math.max(st.x - 0.4 - x, 0, x - (st.x + st.w + 0.4));
    const dy = Math.max(st.y - 0.4 - y, 0, y - (st.y + st.h + 0.4));
    if (Math.hypot(dx, dy) < 0.3) return true;
  }
  // tech / garrison sites (both halves of the map)
  for (const site of m.techSites ?? [])
    for (const [ax, ay] of site.at) for (const [px, py] of [[ax + 1.5, ay + 1.5], [m.w - ax - 1.5, m.h - ay - 1.5]]) if (Math.hypot(x - px, y - py) < 5 + extra) return true;
  if (m.deco) for (const r of [...m.deco.lots, ...m.deco.parks, ...m.deco.plazas]) if (x > r.x0 - 0.3 - extra && x < r.x1 + 0.3 + extra && y > r.y0 - 0.3 - extra && y < r.y1 + 0.3 + extra) return true;
  return false;
}

/** Parking lots beside the paved roads (the access lanes are appended to `roads`). */
export function placeLots(m: GameMap, roads: Road[], occ: Uint8Array, R: number): Lot[] {
  const city = m.biome === 'urban';
  const want = city ? 5 : 2;
  const L = city ? 3.0 : 2.4;
  const D = BAY_D * 2 + AISLE;
  const cands: { lot: Lot; score: number }[] = [];
  roads.forEach((r, ri) => {
    if (r.ring || r.pts.length < 12) return;
    const half = r.painted ? 1.3 : r.width / 2;
    for (let i = 6; i < r.pts.length - 6; i += 5) {
      const a = r.pts[i - 2];
      const b = r.pts[i + 2];
      const ll = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const ux = (b.x - a.x) / ll;
      const uy = (b.y - a.y) / ll;
      // straight stretches only
      const a2 = r.pts[i - 6];
      const b2 = r.pts[i + 6];
      const l2 = Math.hypot(b2.x - a2.x, b2.y - a2.y) || 1;
      if (((b2.x - a2.x) * ux + (b2.y - a2.y) * uy) / l2 < 0.97) continue;
      for (const side of [1, -1]) {
        const nx = -uy * side;
        const ny = ux * side;
        const gap = r.painted ? 0.45 : 0.4;
        const off = half + gap + D / 2;
        const cx = r.pts[i].x + nx * off;
        const cy = r.pts[i].y + ny * off;
        if (nearForbidden(m, cx, cy, 1.4)) continue;
        // the whole footprint (+ margin) on free, fairly flat ground
        let ok = true;
        for (let s = -L / 2 - 0.25; s <= L / 2 + 0.25 && ok; s += 0.25)
          for (let t = -D / 2 + 0.1; t <= D / 2 + 0.25 && ok; t += 0.25) ok = siteFree(m, occ, R, cx + ux * s + nx * t, cy + uy * s + ny * t);
        if (!ok) continue;
        const h = (x: number, y: number) => m.heights[Math.floor(y) * (m.w + 1) + Math.floor(x)] ?? 0;
        if (Math.abs(h(cx + ux * L * 0.5, cy + uy * L * 0.5) - h(cx - ux * L * 0.5, cy - uy * L * 0.5)) > 0.25) continue;
        // village lots: by houses / shops
        let near = 0;
        for (const st of m.structures) if (Math.hypot(st.x + st.w / 2 - cx, st.y + st.h / 2 - cy) < 7) near++;
        if (!city && near < 1) continue;
        // access lane: off the road centre at the lot's first end, down the aisle
        const e0x = cx - ux * (L / 2 - 0.3);
        const e0y = cy - uy * (L / 2 - 0.3);
        const access: V2[] = [];
        const push = (p: V2, q: V2) => {
          const n = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.y - p.y) / 0.25));
          for (let k = access.length ? 1 : 0; k <= n; k++) access.push({ x: p.x + ((q.x - p.x) * k) / n, y: p.y + ((q.y - p.y) * k) / n });
        };
        const p0 = { x: e0x - nx * off, y: e0y - ny * off };
        const p1 = { x: e0x - nx * (D / 2 - 0.05), y: e0y - ny * (D / 2 - 0.05) };
        const p2 = { x: e0x, y: e0y };
        const p3 = { x: cx + ux * (L / 2 - 0.25), y: cy + uy * (L / 2 - 0.25) };
        push(p0, p1);
        // the drive is drawn from the road's edge (it meets the road's own asphalt there) to the lot
        let from = 0;
        while (from < access.length - 1 && Math.hypot(access[from].x - p0.x, access[from].y - p0.y) < half - 0.08) from++;
        const to = access.length;
        push(p1, p2);
        push(p2, p3);
        const bays: Bay[] = [];
        const n = Math.floor((L - 0.75) / BAY_W);
        for (let k = 0; k < n; k++) {
          const s = -L / 2 + 0.6 + (k + 0.5) * BAY_W;
          for (const row of [-1, 1]) {
            const t = row * (AISLE / 2 + BAY_D / 2);
            bays.push({ x: cx + ux * s + nx * t, y: cy + uy * s + ny * t, yaw: Math.atan2(ny * row, nx * row), ax: cx + ux * s, ay: cy + uy * s });
          }
        }
        cands.push({ lot: { x: cx, y: cy, ux, uy, nx, ny, L, D, bays, access, draw: [from, to], city, line: -1, taken: bays.map(() => 0) }, score: hash2(ri, i * 2 + (side > 0 ? 1 : 0), 977) + (city ? 0 : near * 0.1) });
      }
    }
  });
  cands.sort((p, q) => q.score - p.score);
  const lots: Lot[] = [];
  for (const c of cands) {
    if (lots.length >= want) break;
    if (lots.some((o) => Math.hypot(o.x - c.lot.x, o.y - c.lot.y) < (city ? 14 : 16))) continue;
    // and not mirrored onto another lot's spot (the maps are point symmetric: keep it fair, one per half is fine)
    lots.push(c.lot);
  }
  // stamp them (built ground: nothing else goes there) and hand the access lanes to the network
  for (const lot of lots) {
    for (let s = -lot.L / 2 - 0.2; s <= lot.L / 2 + 0.2; s += 0.1)
      for (let t = -lot.D / 2 - 0.2; t <= lot.D / 2 + 0.2; t += 0.1) {
        const x = lot.x + lot.ux * s + lot.nx * t;
        const y = lot.y + lot.uy * s + lot.ny * t;
        const ix = Math.floor(x * R);
        const iy = Math.floor(y * R);
        if (ix >= 0 && iy >= 0 && ix < m.w * R && iy < m.h * R) occ[iy * m.w * R + ix] |= 1 | 8 | 16;
      }
    const [d0, d1] = lot.draw;
    roads.push({ pts: lot.access, width: 0.62, variant: 1, lot: lots.indexOf(lot), taper: { w: lot.access.map(() => 0.62), v: lot.access.map(() => 1), from: d0, to: d1, lift: 0.004 } });
  }
  return lots;
}

/** Billboard spots by the roundabouts and the city's signalled crossings (stamped as built ground). */
export function placeBoards(m: GameMap, net: RoadNet, occ: Uint8Array, R: number): Board[] {
  const out: Board[] = [];
  const free = (x: number, y: number) => {
    if (nearForbidden(m, x, y, 0.2)) return false;
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI * 2;
      const r = k === 8 ? 0 : 0.5;
      if (!siteFree(m, occ, R, x + Math.cos(a) * r, y + Math.sin(a) * r)) return false;
    }
    return !out.some((b) => Math.hypot(b.x - x, b.y - y) < 4);
  };
  const tryAround = (cx: number, cy: number, r0: number, r1: number, seed: number, want: number) => {
    let got = 0;
    for (let k = 0; k < 16 && got < want; k++) {
      const a = (hash2(seed, k, 31) + k / 16) * Math.PI * 2;
      const r = r0 + hash2(seed, k, 32) * (r1 - r0);
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (!free(x, y)) continue;
      out.push({ x, y, yaw: Math.atan2(cy - y, cx - x), seed: Math.floor(hash2(seed, k, 33) * 1e6) });
      got++;
    }
  };
  net.loops.forEach((lp, i) => {
    if (!lp.paved) return;
    tryAround(lp.x, lp.y, lp.R + 1.2, lp.R + 2.2, 100 + i, lp.dead ? 1 : 2);
  });
  net.nodes.forEach((n, i) => {
    if (n.ctl !== Ctl.Signal || hash2(i, 5, 34) < 0.45) return;
    tryAround(n.x, n.y, 2.3, 2.9, 300 + i, 1);
  });
  // stamp
  for (const b of out) {
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI * 2;
      const r = k === 8 ? 0 : 0.45;
      const ix = Math.floor((b.x + Math.cos(a) * r) * R);
      const iy = Math.floor((b.y + Math.sin(a) * r) * R);
      if (ix >= 0 && iy >= 0 && ix < m.w * R && iy < m.h * R) occ[iy * m.w * R + ix] |= 8 | 16;
    }
  }
  return out;
}
