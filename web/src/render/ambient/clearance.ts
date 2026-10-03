import { Tile, type GameMap } from '../../sim/map';
import type { Layout, Road, Track, V2 } from '../layout';
import { bridgeEnds, buildRoadNet, netInputFrom, pointAt, type RoadNet } from './roadnet';

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
 * Build the lane graph for the layout's roads / tracks, stamp the clearance
 * into the occupancy grid and fit the roads and tracks to the turning places.
 * Mutates `roads` / `tracks` in place (the arrays become the layout's).
 */
export function prepareRoadNet(m: GameMap, roads: Road[], tracks: Track[], occ: Uint8Array, R: number): RoadNet {
  const net = buildRoadNet(netInputFrom(m, roads, tracks, bridgeEnds(m)));
  nets.set(roads, net);
  masks.set(m, { occ, R });
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

  // cut the road ribbons back at the roundabouts (the ring is its own road piece); drop the stubs past dead-end circles
  const cut = <T extends { pts: V2[] }>(list: T[], paved: boolean) => {
    const loops = net.loops.filter((lp) => lp.paved === paved && !(paved && net.lines[net.nodes[lp.node].arms[0].line].painted));
    if (!loops.length) return;
    const out: T[] = [];
    for (const r of list) {
      const inside = r.pts.map((p) => loops.findIndex((lp) => Math.hypot(p.x - lp.x, p.y - lp.y) < (paved ? lp.R - 0.3 : lp.rl)));
      if (inside.every((i) => i < 0)) {
        out.push(r);
        continue;
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
        if (keep) out.push({ ...r, pts });
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
    return (layout.occ[iy * m.w * R + ix] & (OCC_FURN | OCC_ROAD)) !== 0;
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
