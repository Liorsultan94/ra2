import { Tile, type GameMap } from '../../sim/map';
import type { Layout, Road, Track, V2 } from '../layout';
import { bridgeEnds, buildRoadNet, netInputFrom, pointAt, unspike, type RoadNet } from './roadnet';
import { placeBoards, placeLots } from './sites';

/*
 * Road clearance: the civilian lane graph (roadnet.ts) is built while the
 * scenery layout is laid out (layout.ts / biomelayout.ts call
 * prepareRoadNet right after stamping the roads), so that everything placed
 * afterwards keeps off the road surfaces:
 *
 *  - the turning circles / roundabouts, gravel loops, junction mouths and the
 *    short links are stamped into the layout's occupancy grid as road
 *    (OCC_ROAD, plus OCC_FURN to tell them apart): every placer that already
 *    keeps off roads (fields, fences, power lines, bushes, grass tufts, reeds,
 *    rocks, props) keeps off them too;
 *  - the road ribbons are cut back at the roundabouts (the ring is drawn as a
 *    road piece by roadfurniture.ts, continuous with them), the dead-end stubs
 *    beyond a turning circle dropped; dirt tracks get their gravel loop as a
 *    closed ring track (painted by the ground like every track) and the short
 *    links as track / road pieces (flagged `ring`: not lanes);
 *  - finishRoadLayout moves utility poles off the circles (or drops them) and
 *    drops wrecks standing on them;
 *  - roadClear(map, x, y) answers for placers without the layout (the render-
 *    only deco trees).
 *
 * Deterministic: a pure function of the map.
 */

export const OCC_FURN = 16;
const OCC_ROAD = 1;
const OCC_TRACK = 2;

interface Mask {
  occ: Uint8Array;
  R: number;
}

const nets = new WeakMap<object, RoadNet>();
const masks = new WeakMap<GameMap, Mask>();
let layoutBuilder: ((m: GameMap) => unknown) | null = null;

/** layout.ts hands its builder over (roadClear builds the layout on demand). */
export function setLayoutBuilder(fn: (m: GameMap) => unknown) {
  layoutBuilder = fn;
}

/** The lane graph built for this layout's roads (null if the layout didn't go through prepareRoadNet). */
export function netForRoads(roads: readonly Road[]): RoadNet | null {
  return nets.get(roads) ?? null;
}

/** The lane graph of a layout (built on the spot for a layout made elsewhere). */
export function roadNetFor(m: GameMap, layout: Layout, bridges?: readonly { ends: readonly V2[] }[]): RoadNet {
  return nets.get(layout.roads) ?? buildRoadNet(netInputFrom(m, layout.roads, layout.tracks, bridges ?? bridgeEnds(m)));
}

/** Is (x, y) clear of every road surface, track, turning circle and junction (within `r`)? */
export function roadClear(m: GameMap, x: number, y: number, r = 0): boolean {
  let mk = masks.get(m);
  if (!mk && layoutBuilder) {
    layoutBuilder(m);
    mk = masks.get(m);
  }
  if (!mk) return true;
  const at = (px: number, py: number) => {
    const ix = Math.floor(px * mk.R);
    const iy = Math.floor(py * mk.R);
    if (ix < 0 || iy < 0 || ix >= m.w * mk.R || iy >= m.h * mk.R) return 0;
    return mk.occ[iy * m.w * mk.R + ix];
  };
  const bits = OCC_ROAD | OCC_TRACK | OCC_FURN;
  if (at(x, y) & bits) return false;
  if (r > 0) for (let k = 0; k < 8; k++) if (at(x + Math.cos(k * 0.785) * r, y + Math.sin(k * 0.785) * r) & bits) return false;
  return true;
}

function dense(a: V2, b: V2, step = 0.25): V2[] {
  const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
  const out: V2[] = [];
  for (let i = 0; i <= n; i++) out.push({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n });
  return out;
}

/**
 * Two paved roads ending close together (both stopping short of a base, a
 * gap left by the router...) are one road: they are merged into a single
 * polyline through a smooth bend (cut back a little so it stays out of the
 * base) instead of leaving two dead ends side by side, each with its own
 * turning circle. One polyline = one welded ribbon: the width tapers over the
 * bend and the next 2.5 tiles, the markings run on (the road look switches
 * where the taper ends, see Road.taper). Not across water, rock, trees or
 * buildings, and not into a hairpin.
 */
/** Drop points where the polyline kinks (cos < minCos), keeping the per-point arrays aligned; endpoints stay. */
function dekink(pts: V2[], arrs: unknown[][], minCos: number, i0 = 1, i1 = Infinity) {
  for (let pass = 0; pass < 60; pass++) {
    let changed = false;
    for (let i = Math.max(1, i0); i < Math.min(pts.length - 1, i1); i++) {
      const ax = pts[i].x - pts[i - 1].x;
      const ay = pts[i].y - pts[i - 1].y;
      const bx = pts[i + 1].x - pts[i].x;
      const by = pts[i + 1].y - pts[i].y;
      const l = Math.hypot(ax, ay) * Math.hypot(bx, by);
      if (l > 1e-9 && (ax * bx + ay * by) / l >= minCos) continue;
      pts.splice(i, 1);
      for (const a of arrs) a.splice(i, 1);
      i--;
      i1--;
      changed = true;
    }
    if (!changed) break;
  }
}

/** Road surface width of a bridge deck (render/bridgefx.ts builds the decks 2 x BRIDGE_HALF_WIDTH wide, kerbs inside). */
const DECK_W = 1.9;

/** Roads running onto a bridge widen smoothly to the deck's width over their last 4 tiles. */
function widenToDecks(m: GameMap, roads: Road[]) {
  const ends = bridgeEnds(m).flatMap((b) => b.ends);
  for (const r of roads) {
    if (r.painted || r.ring || r.lot !== undefined || r.pts.length < 4) continue;
    for (const at of [0, 1] as const) {
      const p = r.pts[at ? r.pts.length - 1 : 0];
      if (!ends.some((e) => Math.hypot(e.x - p.x, e.y - p.y) < 0.8)) continue;
      const w = r.taper?.w ?? r.pts.map(() => r.width);
      const v = r.taper?.v ?? r.pts.map(() => r.variant);
      const smooth = (x: number) => x * x * (3 - 2 * x);
      let along = 0;
      for (let k = 0; k < r.pts.length; k++) {
        const i = at ? r.pts.length - 1 - k : k;
        if (k > 0) {
          const j = at ? i + 1 : i - 1;
          along += Math.hypot(r.pts[i].x - r.pts[j].x, r.pts[i].y - r.pts[j].y);
        }
        if (along > 4) break;
        const f = smooth(1 - along / 4);
        w[i] = w[i] + (Math.max(w[i], DECK_W) - w[i]) * f;
      }
      r.taper = { ...(r.taper ?? {}), w, v };
    }
  }
}

function joinCloseEnds(m: GameMap, roads: Road[]) {
  // the router leaves the odd hairpin spike (at bridge approaches...): no road piece may double back
  for (const r of roads) if (!r.painted && r.pts.length > 2) r.pts = unspike(r.pts, 0.6);
  const hard = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return true;
    const i = ty * m.w + tx;
    const t = m.tiles[i];
    return t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || !!m.trees[i] || !!m.blocked[i] || !!m.ore[i];
  };
  const edge = (p: V2) => p.x < 1.6 || p.y < 1.6 || p.x > m.w - 1.6 || p.y > m.h - 1.6;
  type End = { r: number; at: 0 | 1 };
  // per-point width / look of a road (plain roads: constant)
  const widthsOf = (r: Road) => r.taper?.w ?? r.pts.map(() => r.width);
  const looksOf = (r: Road) => r.taper?.v ?? r.pts.map(() => r.variant);
  // a point `back` tiles in from the end, and the direction the road runs into the end
  const probe = (e: End, back: number) => {
    const pts = roads[e.r].pts;
    const n = pts.length;
    const idx = (k: number) => (e.at ? n - 1 - k : k);
    let acc = 0;
    let k = 0;
    while (k < n - 2 && acc < back) {
      acc += Math.hypot(pts[idx(k + 1)].x - pts[idx(k)].x, pts[idx(k + 1)].y - pts[idx(k)].y);
      k++;
    }
    const p = pts[idx(k)];
    const q = pts[idx(Math.max(0, k - 2))];
    const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    return { k, p, dx: (q.x - p.x) / d, dy: (q.y - p.y) / d };
  };
  for (let pass = 0; pass < 16; pass++) {
    const ends: End[] = [];
    roads.forEach((r, i) => {
      if (r.painted || r.ring || r.closed || r.lot !== undefined || r.pts.length < 12) return;
      if (!edge(r.pts[0])) ends.push({ r: i, at: 0 });
      if (!edge(r.pts[r.pts.length - 1])) ends.push({ r: i, at: 1 });
    });
    let done = false;
    for (let i = 0; i < ends.length && !done; i++)
      for (let j = i + 1; j < ends.length && !done; j++) {
        const A = ends[i];
        const B = ends[j];
        if (A.r === B.r) continue;
        const pa = roads[A.r].pts[A.at ? roads[A.r].pts.length - 1 : 0];
        const pb = roads[B.r].pts[B.at ? roads[B.r].pts.length - 1 : 0];
        const gap = Math.hypot(pb.x - pa.x, pb.y - pa.y);
        if (gap > 5.5) continue;
        // touching ends running on (two pieces of one road): joined as they are, no bend
        const touching = gap < 0.6;
        const back = touching ? 0 : Math.min(1.4, gap * 0.3);
        const a = probe(A, back);
        const b = probe(B, back);
        // the car comes in along a, leaves against b; a U-bend is fine if it's wide enough
        const turn = Math.acos(Math.max(-1, Math.min(1, -(touching ? probe(A, 0.6).dx * probe(B, 0.6).dx + probe(A, 0.6).dy * probe(B, 0.6).dy : a.dx * b.dx + a.dy * b.dy))));
        if (touching && turn > 0.7) continue;
        const span = Math.hypot(b.p.x - a.p.x, b.p.y - a.p.y);
        if (!touching && span / (2 * Math.max(0.2, Math.sin(turn / 2))) < 1.3) continue;
        const kk = span * (0.38 + 0.3 * Math.max(0, (turn - 1.6) / 1.5));
        const c1 = { x: a.p.x + a.dx * kk, y: a.p.y + a.dy * kk };
        const c2 = { x: b.p.x + b.dx * kk, y: b.p.y + b.dy * kk };
        const bend: V2[] = [];
        const n = touching ? 0 : Math.max(4, Math.ceil((span * 1.3) / 0.25));
        let free = true;
        for (let s = 1; s < n; s++) {
          const t = s / n;
          const u = 1 - t;
          const x = u * u * u * a.p.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.p.x;
          const y = u * u * u * a.p.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.p.y;
          if (hard(x, y)) free = false;
          bend.push({ x, y });
        }
        if (!free) continue;
        // roads crossing the bend would make it a junction: leave those to the lane graph
        if (roads.some((r, ri) => ri !== A.r && ri !== B.r && !r.ring && r.pts.some((p) => bend.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.8)))) continue;
        // one polyline: A (towards its joined end) + bend + B (away from its joined end)
        const ra = roads[A.r];
        const rb = roads[B.r];
        const orient = <T>(arr: T[], e: End, k: number, towardEnd: boolean) => {
          const cut = e.at ? arr.slice(0, arr.length - k) : arr.slice(k);
          // cut runs from the far end to the joined end when e.at = 1
          const toEnd = e.at ? cut : cut.slice().reverse();
          return towardEnd ? toEnd : toEnd.slice().reverse();
        };
        const pA = orient(ra.pts, A, a.k, true);
        const wA = orient(widthsOf(ra), A, a.k, true);
        const vA = orient(looksOf(ra), A, a.k, true);
        let pB = orient(rb.pts, B, b.k, false);
        const wB = orient(widthsOf(rb), B, b.k, false);
        const vB = orient(looksOf(rb), B, b.k, false);
        let wBx = wB;
        if (touching) {
          // pieces overlapping at the joint: drop B's points that don't lie ahead of A's end
          const e = pA[pA.length - 1];
          const f = pA[Math.max(0, pA.length - 3)];
          const dl = Math.hypot(e.x - f.x, e.y - f.y) || 1;
          let k2 = 0;
          while (k2 < pB.length - 4 && ((pB[k2].x - e.x) * (e.x - f.x) + (pB[k2].y - e.y) * (e.y - f.y)) / dl < 0.12) k2++;
          pB = pB.slice(k2);
          wBx = wB.slice(k2);
        }
        const w0 = wA[wA.length - 1];
        const w1 = wBx[0];
        // one look for the whole road (no texture jump anywhere): the longer piece's
        const lenOf = (pp: V2[]) => pp.reduce((acc, p, i) => (i ? acc + Math.hypot(p.x - pp[i - 1].x, p.y - pp[i - 1].y) : 0), 0);
        const look: 0 | 1 = lenOf(pA) >= lenOf(pB) ? vA[vA.length - 1] : vB[vB.length - 1];
        // taper across the bend and 2.5 tiles on into the narrower side
        const pts = [...pA, ...bend, ...pB];
        const ws: number[] = [...wA];
        const vs: (0 | 1)[] = vA.map(() => look);
        const bendLen = touching ? 0 : bend.length * 0.25 + 0.5;
        const taperLen = bendLen + 2.5;
        const smooth = (x: number) => x * x * (3 - 2 * x);
        bend.forEach((_, i2) => {
          const t = ((i2 + 1) * 0.25) / taperLen;
          ws.push(w0 + (w1 - w0) * smooth(Math.min(1, t)));
          vs.push(look);
        });
        let along = bendLen;
        pB.forEach((_, i2) => {
          if (i2 > 0) along += Math.hypot(pB[i2].x - pB[i2 - 1].x, pB[i2].y - pB[i2 - 1].y);
          const t = Math.min(1, along / taperLen);
          ws.push(t < 1 ? w0 + (w1 - w0) * smooth(t) : wBx[i2]);
          vs.push(look);
        });
        // ease the joint: a few rounds of smoothing on the points around it (no kink, no notch in the edges)
        const jn = pA.length;
        const win = touching ? 12 : 6;
        for (let it = 0; it < (touching ? 24 : 6); it++) {
          const cp = pts.map((p) => ({ x: p.x, y: p.y }));
          for (let q = Math.max(1, jn - win); q <= Math.min(pts.length - 2, jn + bend.length + win); q++) {
            pts[q] = { x: (cp[q - 1].x + 2 * cp[q].x + cp[q + 1].x) / 4, y: (cp[q - 1].y + 2 * cp[q].y + cp[q + 1].y) / 4 };
          }
        }
        // (only round the joint: the rest of the road keeps its exact line)
        dekink(pts, [ws, vs], 0.93, jn - win - 4, jn + bend.length + win + 4);
        // even spacing again where points were dropped
        for (let q = 1; q < pts.length; q++) {
          const d = Math.hypot(pts[q].x - pts[q - 1].x, pts[q].y - pts[q - 1].y);
          if (d <= 0.32) continue;
          const nIns = Math.ceil(d / 0.25) - 1;
          const a0 = pts[q - 1];
          const b0 = pts[q];
          const ins: V2[] = [];
          const wi: number[] = [];
          for (let k = 1; k <= nIns; k++) {
            const f = k / (nIns + 1);
            ins.push({ x: a0.x + (b0.x - a0.x) * f, y: a0.y + (b0.y - a0.y) * f });
            wi.push(ws[q - 1] + (ws[q] - ws[q - 1]) * f);
          }
          pts.splice(q, 0, ...ins);
          ws.splice(q, 0, ...wi);
          vs.splice(q, 0, ...ins.map(() => vs[q - 1]));
          q += nIns;
        }
        const merged: Road = {
          pts,
          width: Math.min(...ws),
          // (variant 1 if either part is a country road: its utility poles carry on)
          variant: ra.variant === 1 || rb.variant === 1 ? 1 : 0,
          taper: { w: ws, v: vs },
        };
        roads[A.r] = merged;
        roads.splice(B.r, 1);
        done = true;
        // a road joined round into a ring (the oasis ring road...): closed, drawn without a seam
        const p0 = merged.pts[0];
        const p1 = merged.pts[merged.pts.length - 1];
        if (Math.hypot(p0.x - p1.x, p0.y - p1.y) < 0.6) {
          // closed round: put the seam in the middle of the arrays, round it off like a joint, weld the ends
          const t = merged.taper!;
          const n0 = merged.pts.length - 1;
          const h = n0 >> 1;
          const rot = <U>(a: U[]) => {
            const b = a.slice(0, n0);
            return [...b.slice(h), ...b.slice(0, h)];
          };
          const P = rot(merged.pts);
          const Wd = rot(t.w);
          const Vd = rot(t.v);
          const seam = n0 - h;
          for (let it = 0; it < 24; it++) {
            const cp = P.map((p) => ({ x: p.x, y: p.y }));
            for (let q = Math.max(1, seam - 12); q <= Math.min(P.length - 2, seam + 12); q++) P[q] = { x: (cp[q - 1].x + 2 * cp[q].x + cp[q + 1].x) / 4, y: (cp[q - 1].y + 2 * cp[q].y + cp[q + 1].y) / 4 };
          }
          dekink(P, [Wd, Vd], 0.93, seam - 16, seam + 16);
          P.push({ x: P[0].x, y: P[0].y });
          Wd.push(Wd[0]);
          Vd.push(Vd[0]);
          merged.pts = P;
          merged.taper = { ...t, w: Wd, v: Vd };
          merged.closed = true;
        }
      }
    if (!done) break;
  }
}

/**
 * Build the lane graph for the layout's roads / tracks, stamp the clearance
 * into the occupancy grid and fit the roads and tracks to the turning places.
 * Mutates `roads` / `tracks` in place (the arrays become the layout's).
 */
export function prepareRoadNet(m: GameMap, roads: Road[], tracks: Track[], occ: Uint8Array, R: number): RoadNet {
  joinCloseEnds(m, roads);
  widenToDecks(m, roads);
  // parking lots first: their access lanes are lanes of the network
  const lots = placeLots(m, roads, occ, R);
  const net = buildRoadNet(netInputFrom(m, roads, tracks, bridgeEnds(m)));
  nets.set(roads, net);
  masks.set(m, { occ, R });
  net.lots = lots;
  lots.forEach((lot, i) => (lot.line = net.lines.findIndex((L) => L.lot === i)));
  // the lots are drivable surface
  {
    const res = net.res;
    for (const lot of lots)
      for (let s = -lot.L / 2; s <= lot.L / 2; s += 0.1)
        for (let t = -lot.D / 2; t <= lot.D / 2; t += 0.1) {
          const ix = Math.floor((lot.x + lot.ux * s + lot.nx * t) * res);
          const iy = Math.floor((lot.y + lot.uy * s + lot.ny * t) * res);
          if (ix >= 0 && iy >= 0 && ix < net.w * res && iy < net.h * res) net.surface[iy * net.w * res + ix] = 1;
        }
  }
  const W = m.w * R;
  const H = m.h * R;
  const disc = (cx: number, cy: number, r: number) => {
    const x0 = Math.max(0, Math.floor((cx - r) * R));
    const x1 = Math.min(W - 1, Math.ceil((cx + r) * R));
    const y0 = Math.max(0, Math.floor((cy - r) * R));
    const y1 = Math.min(H - 1, Math.ceil((cy + r) * R));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (Math.hypot((x + 0.5) / R - cx, (y + 0.5) / R - cy) <= r) occ[y * W + x] |= OCC_ROAD | OCC_FURN;
  };
  const capsule = (a: V2, b: V2, r: number) => {
    for (const p of dense(a, b, 0.1)) disc(p.x, p.y, r);
  };
  // turning places, junction mouths, links
  for (const lp of net.loops) disc(lp.x, lp.y, lp.R + (lp.paved ? 0.3 : 0.22));
  for (const n of net.nodes) {
    if (n.loop >= 0 || n.arms.length < 2) continue;
    let h = 0;
    for (const a of n.arms) h = Math.max(h, net.lines[a.line].half);
    disc(n.x, n.y, h + 0.3);
  }
  for (const k of net.links) capsule({ x: k.x0, y: k.y0 }, { x: k.x1, y: k.y1 }, k.half + 0.25);
  for (const lot of lots) for (let i = 1; i < lot.access.length; i++) capsule(lot.access[i - 1], lot.access[i], 0.45);

  // cut the road ribbons back at the roundabouts (the ring is its own road piece); drop the stubs past dead-end circles
  const cut = <T extends { pts: V2[]; taper?: Road["taper"]; closed?: boolean }>(list: T[], paved: boolean) => {
    const loops = net.loops.filter((lp) => lp.paved === paved && !(paved && net.lines[net.nodes[lp.node].arms[0].line].painted));
    if (!loops.length) return;
    const out: T[] = [];
    for (const r0 of list) {
      let r = r0;
      let inside = r.pts.map((p) => loops.findIndex((lp) => Math.hypot(p.x - lp.x, p.y - lp.y) < (paved ? lp.R - 0.3 : lp.rl)));
      if (inside.every((i) => i < 0)) {
        out.push(r);
        continue;
      }
      if (r.closed) {
        // a ring road cut by a circle: start it there, so no piece is split at the ring's seam
        const k = inside.findIndex((i) => i >= 0);
        const rot = <U>(a: U[]) => {
          const b = a.slice(0, -1);
          const out2 = [...b.slice(k), ...b.slice(0, k)];
          return [...out2, out2[0]];
        };
        r = { ...r, closed: false, pts: rot(r.pts), ...(r.taper ? { taper: { ...r.taper, w: rot(r.taper.w), v: rot(r.taper.v) } } : {}) };
        inside = rot(inside);
      }
      // runs outside the circles, with the circle they touch at either end
      let i = 0;
      while (i < r.pts.length) {
        if (inside[i] >= 0) {
          i++;
          continue;
        }
        const i0 = i;
        while (i < r.pts.length && inside[i] < 0) i++;
        const pts = r.pts.slice(i0, i);
        if (pts.length < 3) continue;
        let keep = true;
        for (const [li, end] of [
          [i0 > 0 ? inside[i0 - 1] : -1, 0],
          [i < r.pts.length ? inside[i] : -1, 1],
        ] as const) {
          const lp = li >= 0 ? loops[li] : null;
          if (!lp?.dead) continue;
          // a run leaving a dead-end circle away from its mouth is the stub beyond it
          const arm = net.nodes[lp.node].arms[0];
          const mouth = pointAt(net.lines[arm.line], arm.edge + arm.dir * 0.8);
          const kx = mouth.x - lp.x;
          const ky = mouth.y - lp.y;
          const q = end === 0 ? pts[Math.min(pts.length - 1, 3)] : pts[Math.max(0, pts.length - 4)];
          if ((q.x - lp.x) * kx + (q.y - lp.y) * ky < 0) keep = false;
        }
        if (keep) out.push({ ...r, pts, closed: false, ...(r.taper ? { taper: { ...r.taper, w: r.taper.w.slice(i0, i), v: r.taper.v.slice(i0, i) } } : {}) });
      }
    }
    list.length = 0;
    list.push(...out);
  };
  cut(roads, true);
  cut(tracks, false);
  // gravel loops: a ring track the ground paints like any track
  for (const lp of net.loops) {
    if (lp.paved) continue;
    const pts: V2[] = [];
    const n = Math.max(12, Math.ceil((Math.PI * 2 * lp.rl) / 0.2));
    for (let i = 0; i <= n; i++) pts.push({ x: lp.x + Math.cos((i / n) * Math.PI * 2) * lp.rl, y: lp.y + Math.sin((i / n) * Math.PI * 2) * lp.rl });
    tracks.push({ pts, width: 0.56, ring: true });
  }
  // links: a road / track piece from the end that stops short up to the road it joins
  for (const k of net.links) {
    const d = Math.hypot(k.x1 - k.x0, k.y1 - k.y0) || 1;
    // stop inside the joined road's asphalt (not across its far edge)
    const into = Math.max(0, d - k.joinHalf * 0.55);
    const b = { x: k.x0 + ((k.x1 - k.x0) / d) * into, y: k.y0 + ((k.y1 - k.y0) / d) * into };
    // and start a little back on the road / track it continues
    const s = { x: k.x0 - ((k.x1 - k.x0) / d) * 0.2, y: k.y0 - ((k.y1 - k.y0) / d) * 0.2 };
    if (k.paved) roads.push({ pts: dense(s, b), width: k.half * 2, variant: k.variant === 0 ? 0 : 1, ring: true });
    else tracks.push({ pts: dense(s, { x: k.x1, y: k.y1 }), width: k.half * 2, ring: true });
  }
  // billboards by the roundabouts and crossings (after the circles are known)
  net.boards = placeBoards(m, net, occ, R);
  return net;
}

/** After the layout is laid out: utility poles off the turning circles (moved beside them, or dropped), no wrecks on them. */
export function finishRoadLayout<L extends Layout>(m: GameMap, layout: L): L {
  const net = nets.get(layout.roads);
  if (!net) return layout;
  const R = layout.occRes;
  const furn = (x: number, y: number) => {
    const ix = Math.floor(x * R);
    const iy = Math.floor(y * R);
    if (ix < 0 || iy < 0 || ix >= m.w * R || iy >= m.h * R) return true;
    return (layout.occ[iy * m.w * R + ix] & (OCC_FURN | OCC_ROAD | OCC_TRACK)) !== 0;
  };
  const tileOk = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return false;
    const i = ty * m.w + tx;
    const t = m.tiles[i];
    return t !== Tile.Water && t !== Tile.Bridge && t !== Tile.Rock && !m.trees[i] && !m.blocked[i];
  };
  const runs: V2[][] = [];
  for (const run of layout.poles) {
    let cur: V2[] = [];
    for (const p0 of run) {
      let p: V2 | null = p0;
      if (furn(p.x, p.y)) {
        // beside the circle it stands in, else gone (the wire still crosses the road)
        p = null;
        for (const lp of net.loops) {
          const d = Math.hypot(p0.x - lp.x, p0.y - lp.y);
          if (d > lp.R + 0.6) continue;
          const k = (lp.R + 0.5) / (d || 1);
          const q = { x: lp.x + (p0.x - lp.x) * k, y: lp.y + (p0.y - lp.y) * k };
          if (!furn(q.x, q.y) && tileOk(q.x, q.y)) p = q;
          break;
        }
      }
      if (p) cur.push(p);
      else if (cur.length) {
        if (cur.length > 1) runs.push(cur);
        cur = [];
      }
    }
    if (cur.length > 1) runs.push(cur);
  }
  layout.poles.length = 0;
  layout.poles.push(...runs);
  // power-line towers (the mirrored half isn't checked by the layout): slide along the line off the road, else skip one
  layout.pylons.lines = layout.pylons.lines.map((line) => {
    const out: V2[] = [];
    line.forEach((p, i) => {
      if (!furn(p.x, p.y) && !furn(p.x + 0.35, p.y) && !furn(p.x - 0.35, p.y) && !furn(p.x, p.y + 0.35) && !furn(p.x, p.y - 0.35)) {
        out.push(p);
        return;
      }
      const q = line[i + 1] ?? line[i - 1];
      if (!q) return;
      const d = Math.hypot(q.x - p.x, q.y - p.y) || 1;
      for (const o of [0.6, -0.6, 1.2, -1.2, 1.8, -1.8]) {
        const x = p.x + ((q.x - p.x) / d) * o;
        const y = p.y + ((q.y - p.y) / d) * o;
        if (tileOk(x, y) && !furn(x, y) && !furn(x + 0.35, y) && !furn(x - 0.35, y) && !furn(x, y + 0.35) && !furn(x, y - 0.35)) {
          out.push({ x, y });
          return;
        }
      }
    });
    return out;
  }).filter((l) => l.length > 1);
  const keep = layout.wrecks.filter((w) => {
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2;
      const x = w.x + Math.cos(a) * 0.25;
      const y = w.y + Math.sin(a) * 0.25;
      const ix = Math.floor(x * R);
      const iy = Math.floor(y * R);
      if (ix >= 0 && iy >= 0 && ix < m.w * R && iy < m.h * R && layout.occ[iy * m.w * R + ix] & OCC_FURN) return false;
    }
    return true;
  });
  layout.wrecks.length = 0;
  layout.wrecks.push(...keep);
  return layout;
}
