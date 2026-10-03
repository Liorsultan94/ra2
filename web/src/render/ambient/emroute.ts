import type { V2 } from '../layout';
import { pointAt, type RoadNet } from './roadnet';

/*
 * Routes for the emergency vehicles (emergency.ts), pure logic on the lane
 * graph of roadnet.ts (read only): shortest path over the lines between the
 * junction nodes, from a map-edge entry (or a junction far enough away) to
 * the stretch of road nearest an incident, as a polyline on the right-hand
 * lane, plus the way back out (the same roads, the other lane).
 */

export interface RouteSeg {
  line: number;
  a0: number;
  a1: number;
}

export interface EmRoute {
  /** Driving in: start -> incident. */
  segs: RouteSeg[];
  /** Total length (tiles). */
  len: number;
  /** Starts at the map edge (drives off it on the way out). */
  portal: boolean;
}

interface Edge {
  to: number;
  line: number;
  a0: number;
  a1: number;
}

/**
 * Plan a route to the road nearest (x, y): null if there is no road within
 * `reach` tiles or no entry between minLen and maxLen away.
 */
export function planRoute(net: RoadNet, x: number, y: number, reach = 4, minLen = 12, maxLen = 70): EmRoute | null {
  const lines = net.lines;
  // destination: nearest drivable line (no parking lot lanes)
  let dl = -1;
  let da = 0;
  let bd = reach;
  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    if (L.lot >= 0 || L.bridge >= 0) continue;
    if (x < L.bx0 - reach || x > L.bx1 + reach || y < L.by0 - reach || y > L.by1 + reach) continue;
    for (let i = 0; i < L.pts.length - 1; i++) {
      const a = L.pts[i];
      const b = L.pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1e-9;
      let t = ((x - a.x) * dx + (y - a.y) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(x - a.x - dx * t, y - a.y - dy * t) - (L.paved ? 0.3 : 0);
      if (d < bd) {
        bd = d;
        dl = li;
        da = L.cum[i] + t * Math.sqrt(l2);
      }
    }
  }
  if (dl < 0) return null;
  // vertices: nodes, then line ends that have no node, then the destination
  const N = net.nodes.length;
  const endId = (li: number, e: number) => N + li * 2 + e;
  const D = N + lines.length * 2;
  const adj: Edge[][] = Array.from({ length: D + 1 }, () => []);
  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    if (L.lot >= 0) continue;
    const st: { v: number; a: number }[] = [];
    net.nodes.forEach((n, ni) => {
      for (const arm of n.arms) if (arm.line === li) st.push({ v: ni, a: arm.arc });
    });
    for (const [e, a] of [
      [0, 0],
      [1, L.len],
    ] as const)
      if (!st.some((s) => Math.abs(s.a - a) < 0.6)) st.push({ v: endId(li, e), a });
    if (li === dl) st.push({ v: D, a: da });
    st.sort((p, q) => p.a - q.a);
    for (let i = 0; i + 1 < st.length; i++) {
      const p = st[i];
      const q = st[i + 1];
      if (p.v === q.v) continue;
      adj[p.v].push({ to: q.v, line: li, a0: p.a, a1: q.a });
      adj[q.v].push({ to: p.v, line: li, a0: q.a, a1: p.a });
    }
  }
  // Dijkstra from the destination (edges are symmetric)
  const dist = new Float64Array(D + 1).fill(Infinity);
  const prev = new Int32Array(D + 1).fill(-1);
  const via: (Edge | null)[] = new Array(D + 1).fill(null);
  const done = new Uint8Array(D + 1);
  dist[D] = 0;
  for (;;) {
    let u = -1;
    let ud = Infinity;
    for (let i = 0; i <= D; i++)
      if (!done[i] && dist[i] < ud) {
        ud = dist[i];
        u = i;
      }
    if (u < 0 || ud > maxLen) break;
    done[u] = 1;
    for (const e of adj[u]) {
      const nd = ud + Math.abs(e.a1 - e.a0);
      if (nd < dist[e.to]) {
        dist[e.to] = nd;
        prev[e.to] = u;
        via[e.to] = e;
      }
    }
  }
  // entry: a map-edge portal in range, else the farthest junction in range
  let start = -1;
  let portal = false;
  let sd = Infinity;
  for (let li = 0; li < lines.length; li++) {
    const L = lines[li];
    if (L.lot >= 0) continue;
    for (const e of [0, 1]) {
      if (!L.portal[e]) continue;
      // the portal end is a node or a bare end: either way the vertex at that arc
      const a = e ? L.len : 0;
      let v = endId(li, e);
      for (const [ni, n] of net.nodes.entries()) if (n.arms.some((arm) => arm.line === li && Math.abs(arm.arc - a) < 0.6)) v = ni;
      const d = dist[v];
      if (d >= minLen && d <= maxLen && d < sd) {
        sd = d;
        start = v;
        portal = true;
      }
    }
  }
  if (start < 0) {
    let far = -1;
    for (let v = 0; v < D; v++) if (dist[v] >= minLen && dist[v] <= Math.min(maxLen, 40) && dist[v] > far) {
      far = dist[v];
      start = v;
    }
    if (start < 0) return null;
  }
  // walk the predecessor chain start -> D: each step reverses the stored edge direction
  const segs: RouteSeg[] = [];
  for (let v = start; v !== D && v >= 0; v = prev[v]) {
    const e = via[v]!;
    // e goes prev[v] -> v; we drive v -> prev[v]
    segs.push({ line: e.line, a0: e.a1, a1: e.a0 });
  }
  let len = 0;
  for (const s of segs) len += Math.abs(s.a1 - s.a0);
  return segs.length ? { segs, len, portal } : null;
}

/** The way back: the same roads in reverse. */
export function reverseSegs(segs: RouteSeg[]): RouteSeg[] {
  return segs.map((s) => ({ line: s.line, a0: s.a1, a1: s.a0 })).reverse();
}

/**
 * Sample the route on the right-hand lane (`laneK` of the lane offset) every `step` tiles; the
 * last `pull` tiles drift further right (pulling over to the kerb).
 */
export function routePolyline(net: RoadNet, segs: RouteSeg[], step = 0.25, pull = 0, laneK = 1): V2[] {
  const out: V2[] = [];
  let total = 0;
  for (const s of segs) total += Math.abs(s.a1 - s.a0);
  let run = 0;
  for (const s of segs) {
    const L = net.lines[s.line];
    const dir = s.a1 >= s.a0 ? 1 : -1;
    const n = Math.max(1, Math.ceil(Math.abs(s.a1 - s.a0) / step));
    for (let k = out.length ? 1 : 0; k <= n; k++) {
      const a = s.a0 + ((s.a1 - s.a0) * k) / n;
      const p = pointAt(L, a);
      const left = total - (run + (Math.abs(s.a1 - s.a0) * k) / n);
      // (laneK < 1: blue lights on, nearer the centre line while the traffic pulls over to the right)
      const pk = pull > 0 ? Math.max(0, 1 - left / pull) : 0;
      const lane = L.lane * laneK + (L.lane * (1 - laneK) + Math.max(0, L.half - L.lane - 0.12)) * pk;
      out.push({ x: p.x - p.ty * dir * lane, y: p.y + p.tx * dir * lane });
    }
    run += Math.abs(s.a1 - s.a0);
  }
  return out;
}
