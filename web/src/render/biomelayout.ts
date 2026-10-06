import { StructureKind, Tile, groundHeight, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import { finishRoadLayout, prepareRoadNet } from './ambient/clearance';
import { FieldType, OCC_BUILT, OCC_FIELD, OCC_ROAD, OCC_TRACK, SITE_CLEAR, detourSpans, edgesOffSites, makeRouter, nearSite, pylonFooting, segDist, smoothLine, type Edge, type Field, type Layout, type Road, type Track, type V2 } from './layout';

/*
 * Scenery layout of the hand-designed biome maps (desert, winter, city):
 * the same Layout the Frontline Crossing builder produces, but driven by the
 * render hints the map generator left in GameMap.deco (road widths, tracks,
 * plots, plazas, parks, power lines) instead of hard-coded via points.
 * Deterministic: a pure function of the map.
 */

const v = (x: number, y: number): V2 => ({ x, y });

export function buildBiomeLayout(m: GameMap): Layout {
  const W = m.w;
  const H = m.h;
  const deco = m.deco;
  const biome = m.biome;
  const route = makeRouter(m);
  const nearStart = (x: number, y: number, r: number) => m.starts.some((s) => Math.hypot(x - s.x - 0.5, y - s.y - 0.5) < r);

  // ---- roads: routed around obstacles (country), or straight (city streets)
  const roads: Road[] = [];
  const baseR = biome === 'urban' ? 0 : 8.5;
  m.roads.forEach((pts, i) => {
    const st = deco?.roadStyles[i] ?? { width: 0.9, variant: 1 as const };
    const via = pts.map((p) => v(p.x + 0.5, p.y + 0.5));
    const line = st.straight ? smoothLine(via, via.length > 2 ? 2 : 0, 0.25) : route(via, st.width);
    let run: V2[] = [];
    // city streets are painted into the ground (fields below); their centre lines still guide the traffic
    const painted = biome === 'urban' && !!st.straight && pts.length === 2;
    const flush = () => {
      if (run.length * 0.25 > 2) roads.push({ pts: run, width: st.width, variant: st.variant, painted });
      run = [];
    };
    for (const p of line) {
      if (baseR > 0 && nearStart(p.x, p.y, baseR)) flush();
      else run.push(p);
    }
    flush();
  });
  const tracks: Track[] = (deco?.tracks ?? []).map((pts) => ({ pts: route(pts.map((p) => v(p.x + 0.5, p.y + 0.5)), 0.5, 0.3), width: 0.5 }));

  // ---- occupancy grid
  const R = 4;
  const occ = new Uint8Array(W * R * H * R);
  const stampLine = (pts: V2[], radius: number, bit: number) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const x0 = Math.max(0, Math.floor((Math.min(a.x, b.x) - radius) * R));
      const x1 = Math.min(W * R - 1, Math.ceil((Math.max(a.x, b.x) + radius) * R));
      const y0 = Math.max(0, Math.floor((Math.min(a.y, b.y) - radius) * R));
      const y1 = Math.min(H * R - 1, Math.ceil((Math.max(a.y, b.y) + radius) * R));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (segDist((x + 0.5) / R, (y + 0.5) / R, a, b) < radius) occ[y * W * R + x] |= bit;
    }
  };
  for (const r of roads) stampLine(r.pts, r.width / 2 + 0.25, OCC_ROAD);
  for (const t of tracks) stampLine(t.pts, t.width / 2 + 0.2, OCC_TRACK);
  // the civilian lane graph: turning circles / junctions kept clear, roads fitted to them (ambient/clearance.ts)
  prepareRoadNet(m, roads, tracks, occ, R);
  const stampRect = (x0: number, y0: number, x1: number, y1: number, bit: number) => {
    for (let y = Math.floor(y0 * R); y < Math.ceil(y1 * R); y++)
      for (let x = Math.floor(x0 * R); x < Math.ceil(x1 * R); x++) if (x >= 0 && y >= 0 && x < W * R && y < H * R) occ[y * W * R + x] |= bit;
  };
  for (const st of m.structures) stampRect(st.x - 0.6, st.y - 0.6, st.x + st.w + 0.6, st.y + st.h + 0.6, OCC_BUILT);
  const occAt = (x: number, y: number) => {
    const ix = Math.floor(x * R);
    const iy = Math.floor(y * R);
    if (ix < 0 || iy < 0 || ix >= W * R || iy >= H * R) return 255;
    return occ[iy * W * R + ix];
  };

  // ---- fields: irrigated plots (desert), snowed-over fields (winter), city squares
  const fields: Field[] = [];
  const edges: Edge[] = [];
  const tileOk = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return false;
    const i = ty * W + tx;
    const t = m.tiles[i];
    if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[i] || m.blocked[i] || m.ore[i]) return false;
    if (occAt(x, y) & (OCC_ROAD | OCC_TRACK | OCC_BUILT | OCC_FIELD)) return false;
    if (nearStart(x, y, 12) || nearSite(m, x, y, SITE_CLEAR)) return false;
    for (const mm of m.oreMines) if (Math.abs(x - mm.x - 0.5) < 5.5 && Math.abs(y - mm.y - 0.5) < 5.5) return false;
    const h0 = groundHeight(m, x, y);
    return Math.abs(groundHeight(m, x + 0.5, y) - h0) + Math.abs(groundHeight(m, x, y + 0.5) - h0) <= 0.32;
  };
  const fieldOk = (f: Field) => {
    const ca = Math.cos(f.angle);
    const sa = Math.sin(f.angle);
    for (let a = -f.hl; a <= f.hl + 1e-6; a += 0.5) for (let b = -f.hw; b <= f.hw + 1e-6; b += 0.5) if (!tileOk(f.cx + ca * a - sa * b, f.cy + sa * a + ca * b)) return false;
    return true;
  };
  const markField = (g: Field) => {
    const ca = Math.cos(g.angle);
    const sa = Math.sin(g.angle);
    for (let a = -g.hl - 0.3; a <= g.hl + 0.3; a += 0.2)
      for (let b = -g.hw - 0.3; b <= g.hw + 0.3; b += 0.2) {
        const ix = Math.floor((g.cx + ca * a - sa * b) * R);
        const iy = Math.floor((g.cy + sa * a + ca * b) * R);
        if (ix >= 0 && iy >= 0 && ix < W * R && iy < H * R) occ[iy * W * R + ix] |= OCC_FIELD;
      }
  };
  let seed = 0;
  for (const z of deco?.fields ?? []) {
    const along = z.rows === 0;
    const len = along ? z.x1 - z.x0 : z.y1 - z.y0;
    const span = along ? z.y1 - z.y0 : z.x1 - z.x0;
    let s = 0;
    while (s < span - 1.5) {
      seed++;
      const wdt = Math.min(span - s, 2.4 + hash2(seed, 1, 615) * 2.2);
      if (wdt < 1.6) break;
      const mid = s + wdt / 2;
      const r = hash2(seed, 2, 615);
      const type = biome === 'desert' ? (r < 0.6 ? FieldType.Green : r < 0.85 ? FieldType.Wheat : FieldType.Plowed) : r < 0.5 ? FieldType.Plowed : r < 0.8 ? FieldType.Fallow : FieldType.Wheat;
      const tilt = (hash2(seed, 3, 615) - 0.5) * 0.06;
      const f: Field = along
        ? { cx: (z.x0 + z.x1) / 2, cy: z.y0 + mid, hl: len / 2 - 0.3, hw: wdt / 2 - 0.3, angle: tilt, type }
        : { cx: z.x0 + mid, cy: (z.y0 + z.y1) / 2, hl: len / 2 - 0.3, hw: wdt / 2 - 0.3, angle: Math.PI / 2 + tilt, type };
      // shrink until it fits
      let g: Field | null = null;
      for (let cut = 0; cut <= f.hl * 0.9 && !g; cut += 0.5) {
        const t = { ...f, hl: f.hl - cut };
        if (t.hl >= 1.2 && fieldOk(t)) g = t;
      }
      if (g) {
        fields.push(g);
        markField(g);
        // winter fields are fenced along one side
        if (biome === 'winter' && hash2(seed, 4, 615) < 0.7) {
          const ca = Math.cos(g.angle);
          const sa = Math.sin(g.angle);
          const side = hash2(seed, 5, 615) < 0.5 ? -1 : 1;
          const nx = -sa * (g.hw + 0.32) * side;
          const ny = ca * (g.hw + 0.32) * side;
          edges.push({ a: v(g.cx - ca * g.hl + nx, g.cy - sa * g.hl + ny), b: v(g.cx + ca * g.hl + nx, g.cy + sa * g.hl + ny), kind: 'fence' });
        }
      }
      s += wdt + 0.6;
    }
  }
  // city streets: asphalt strips with markings, and the crossings (zebras) where they meet
  if (biome === 'urban') {
    const ends: V2[] = [];
    m.roads.forEach((pts, i) => {
      const st = deco?.roadStyles[i];
      if (!st?.straight || pts.length !== 2) return;
      const a = v(pts[0].x + 0.5, pts[0].y + 0.5);
      const b = v(pts[1].x + 0.5, pts[1].y + 0.5);
      const horiz = Math.abs(b.y - a.y) < 0.01;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      fields.push({ cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, hl: len / 2 + 0.5, hw: 1.4, angle: horiz ? 0 : Math.PI / 2, type: st.variant === 0 ? FieldType.Avenue : FieldType.Street });
      ends.push(a, b);
    });
    // crossings: every grid point where a vertical and a horizontal street meet
    const xs = new Set<number>();
    const ys = new Set<number>();
    m.roads.forEach((pts, i) => {
      if (!deco?.roadStyles[i]?.straight || pts.length !== 2) return;
      if (pts[0].x === pts[1].x) xs.add(pts[0].x);
      if (pts[0].y === pts[1].y) ys.add(pts[0].y);
    });
    for (const x of xs)
      for (const y of ys) {
        const tx = Math.round(x);
        const ty = Math.round(y);
        if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
        const t = m.tiles[ty * W + tx];
        if (t === Tile.Water || t === Tile.Bridge) continue;
        fields.push({ cx: x + 0.5, cy: y + 0.5, hl: 1.5, hw: 1.5, angle: 0, type: FieldType.Crossing });
      }
    void ends;
  }
  // city squares: paved flags over the whole plaza (the field shader's Plaza type)
  for (const p of deco?.plazas ?? []) {
    const f: Field = { cx: (p.x0 + p.x1) / 2, cy: (p.y0 + p.y1) / 2, hl: (p.x1 - p.x0) / 2 - 0.15, hw: (p.y1 - p.y0) / 2 - 0.15, angle: 0, type: FieldType.Plaza };
    fields.push(f);
    markField(f);
  }
  // park hedges with gaps for the paths
  for (const p of deco?.parks ?? []) {
    const x0 = p.x0 + 0.35;
    const y0 = p.y0 + 0.35;
    const x1 = p.x1 - 0.35;
    const y1 = p.y1 - 0.35;
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    for (const [a, b] of [
      [v(x0, y0), v(mx - 0.9, y0)],
      [v(mx + 0.9, y0), v(x1, y0)],
      [v(x0, y1), v(mx - 0.9, y1)],
      [v(mx + 0.9, y1), v(x1, y1)],
      [v(x0, y0), v(x0, my - 0.9)],
      [v(x0, my + 0.9), v(x0, y1)],
      [v(x1, y0), v(x1, my - 0.9)],
      [v(x1, my + 0.9), v(x1, y1)],
    ] as [V2, V2][])
      edges.push({ a, b, kind: 'hedge' });
    // cross paths
    tracks.push({ pts: smoothLine([v(mx, y0 - 0.3), v(mx, y1 + 0.3)], 0, 0.3), width: 0.55 });
    tracks.push({ pts: smoothLine([v(x0 - 0.3, my), v(x1 + 0.3, my)], 0, 0.3), width: 0.55 });
  }
  // winter / desert yard fences around the houses (front side open)
  if (biome !== 'urban')
    for (const st of m.structures) {
      if (hash2(st.x, st.y, 77) < (biome === 'desert' ? 0.7 : 0.4)) continue;
      const x0 = st.x - 0.35;
      const y0 = st.y - 0.35;
      const x1 = st.x + st.w + 0.35;
      const y1 = st.y + st.h + 0.35;
      const sides: [V2, V2][] = [
        [v(x0, y0), v(x1, y0)],
        [v(x1, y0), v(x1, y1)],
        [v(x1, y1), v(x0, y1)],
        [v(x0, y1), v(x0, y0)],
      ];
      const open = [2, 1, 0, 3][st.rot];
      sides.forEach((sd, i) => {
        if (i === open) return;
        const mx = (sd[0].x + sd[1].x) / 2;
        const my = (sd[0].y + sd[1].y) / 2;
        if (occAt(mx, my) & (OCC_ROAD | OCC_TRACK)) return;
        edges.push({ a: sd[0], b: sd[1], kind: 'fence' });
      });
    }

  // ---- power lines
  const valid = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
    const i = ty * W + tx;
    const t = m.tiles[i];
    if (t === Tile.Water || t === Tile.Bridge || t === Tile.Rock || m.trees[i] || m.blocked[i]) return false;
    if (occAt(x, y) & (OCC_ROAD | OCC_TRACK | OCC_BUILT)) return false;
    if (nearStart(x, y, 9)) return false;
    for (const mm of m.oreMines) if (Math.hypot(x - mm.x - 0.5, y - mm.y - 0.5) < 6) return false;
    return !nearSite(m, x, y, 0.8) && pylonFooting(m, x, y);
  };
  const line = (pts: V2[], spacing: number) => {
    const out: V2[] = [];
    for (let s = 0; s < pts.length - 1; s++) {
      const a = pts[s];
      const b = pts[s + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.round(L / spacing));
      const dx = (b.x - a.x) / L;
      const dy = (b.y - a.y) / L;
      for (let k = s === 0 ? 0 : 1; k <= n; k++) {
        const t = (k / n) * L;
        for (const o of [0, 0.6, -0.6, 1.2, -1.2, 1.8, -1.8, 2.4, -2.4]) {
          const x = a.x + dx * (t + o);
          const y = a.y + dy * (t + o);
          if (valid(x, y)) {
            out.push(v(x, y));
            break;
          }
        }
      }
    }
    return out;
  };
  const pylons = { lines: (deco?.power ?? []).flatMap((l) => detourSpans(m, line(l.map((p) => v(p.x + 0.5, p.y + 0.5)), 7.6), valid)).filter((l) => l.length > 1) };

  // ---- utility poles along the country roads (not in the city)
  const poles: V2[][] = [];
  if (biome !== 'urban')
    for (const r of roads) {
      if (r.variant !== 1) continue;
      const run: V2[] = [];
      for (let i = 4; i < r.pts.length - 4; i += 12) {
        const a = r.pts[i - 1];
        const b = r.pts[i + 1];
        const L = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const p = v(r.pts[i].x - ((b.y - a.y) / L) * (r.width / 2 + 0.45), r.pts[i].y + ((b.x - a.x) / L) * (r.width / 2 + 0.45));
        const tx = Math.floor(p.x);
        const ty = Math.floor(p.y);
        const ok = tx >= 0 && ty >= 0 && tx < W && ty < H && m.tiles[ty * W + tx] !== Tile.Water && m.tiles[ty * W + tx] !== Tile.Bridge && !m.trees[ty * W + tx] && !m.blocked[ty * W + tx] && !nearStart(p.x, p.y, 7) && !nearSite(m, p.x, p.y, 0.5);
        if (ok) run.push(p);
        else if (run.length > 1) poles.push(run.splice(0));
        else run.length = 0;
      }
      if (run.length > 1) poles.push(run);
    }

  // ---- wrecked cars on the shoulders (the city's streets are full of them)
  const wrecks: Layout['wrecks'] = [];
  let wseed = 0;
  const gapA = biome === 'urban' ? 16 : 28;
  const gapB = biome === 'urban' ? 30 : 50;
  for (const r of roads) {
    for (let i = 12; i < r.pts.length - 12; i += gapA + Math.floor(hash2(i, r.pts.length, 61) * gapB)) {
      wseed++;
      if (hash2(wseed, 0, 62) < 0.45) continue;
      const a = r.pts[i - 1];
      const b = r.pts[i + 1];
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      const side = hash2(wseed, 1, 62) < 0.5 ? -1 : 1;
      const off = r.width / 2 + (biome === 'urban' ? -0.35 : 0.15) + hash2(wseed, 2, 62) * 0.35;
      const x = r.pts[i].x - Math.sin(ang) * off * side;
      const y = r.pts[i].y + Math.cos(ang) * off * side;
      if (nearStart(x, y, 10) || nearSite(m, x, y, 0.5)) continue;
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
      const wt = m.tiles[ty * W + tx];
      if (wt === Tile.Water || wt === Tile.Bridge || wt === Tile.Rock || m.trees[ty * W + tx] || m.blocked[ty * W + tx]) continue;
      wrecks.push({ x, y, rot: ang + (hash2(wseed, 3, 62) - 0.5) * 1.2 + (hash2(wseed, 4, 62) < 0.2 ? Math.PI / 2 : 0), kind: Math.floor(hash2(wseed, 5, 62) * 3) });
    }
  }
  // the park paths count as tracks in the occupancy grid
  for (const t of tracks) stampLine(t.pts, t.width / 2 + 0.2, OCC_TRACK);
  const pivots = biome === 'desert' ? findPivots(m, occ, R, pylons.lines, poles, wrecks) : [];
  // small plots round the villages and farmsteads (render only: greenhouses, orchards, crops)
  if (biome !== 'urban') {
    const posts = [...pylons.lines.flat(), ...poles.flat(), ...wrecks.map((w) => v(w.x, w.y))];
    const pick = (r: number) =>
      biome === 'desert'
        ? r < 0.4 ? FieldType.Plowed : r < 0.85 ? FieldType.Green : FieldType.Wheat
        : r < 0.5 ? FieldType.Plowed : FieldType.Fallow;
    fields.push(...villagePlots(m, fieldOk, markField, biome === 'desert' ? 26 : 14, pick, posts, edges));
  }
  edgesOffSites(m, edges);
  return finishRoadLayout(m, { roads, tracks, fields, edges, pylons, poles, wrecks, pivots, occ, occRes: R });
}

/**
 * Desert centre-pivot circles (render/farm.ts): flat, open ground clear of roads, tracks, fields,
 * structures, ore, oil, tech sites, power lines and the bases. Placed on player 0's half and mirrored
 * (point symmetry, like the map); the discs are marked as fields so nothing else grows on them.
 */
function findPivots(m: GameMap, occ: Uint8Array, R: number, lines: V2[][], poles: V2[][], wrecks: Layout['wrecks']): { x: number; y: number; r: number }[] {
  const W = m.w;
  const H = m.h;
  const posts = [...lines.flat(), ...poles.flat(), ...wrecks.map((w) => v(w.x, w.y))];
  const tech: { x0: number; y0: number; x1: number; y1: number }[] = [];
  for (const t of m.techSites ?? [])
    for (const [ax, ay] of t.at)
      for (const [px, py] of [
        [ax, ay],
        [W - ax - 3, H - ay - 3],
      ])
        tech.push({ x0: px - 1.5, y0: py - 1.5, x1: px + 4.5, y1: py + 4.5 });
  const okAt = (x: number, y: number) => {
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 1 || ty < 1 || tx >= W - 1 || ty >= H - 1) return false;
    const i = ty * W + tx;
    const t = m.tiles[i];
    if (t === Tile.Water || t === Tile.Rock || t === Tile.Bridge || m.trees[i] || m.blocked[i] || m.ore[i] || m.oreKind[i]) return false;
    if (occ[Math.floor(y * R) * W * R + Math.floor(x * R)] & (OCC_ROAD | OCC_TRACK | OCC_BUILT | OCC_FIELD)) return false;
    if (m.starts.some((s) => Math.hypot(x - s.x - 0.5, y - s.y - 0.5) < 16)) return false;
    for (const mm of m.oreMines) if (Math.hypot(x - mm.x - 0.5, y - mm.y - 0.5) < 7) return false;
    for (const o of m.oils) if (x > o.x - 2 && x < o.x + 4 && y > o.y - 2 && y < o.y + 4) return false;
    for (const z of tech) if (x > z.x0 && x < z.x1 && y > z.y0 && y < z.y1) return false;
    return true;
  };
  const discOk = (cx: number, cy: number, r: number) => {
    let lo = 1e9;
    let hi = -1e9;
    for (let y = -r - 0.4; y <= r + 0.4; y += 0.5)
      for (let x = -r - 0.4; x <= r + 0.4; x += 0.5) {
        if (x * x + y * y > (r + 0.4) * (r + 0.4)) continue;
        if (!okAt(cx + x, cy + y)) return false;
        const h = groundHeight(m, cx + x, cy + y);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
    if (hi - lo > 0.3) return false;
    return !posts.some((p) => Math.hypot(p.x - cx, p.y - cy) < r + 0.8);
  };
  const out: { x: number; y: number; r: number }[] = [];
  const mark = (p: { x: number; y: number; r: number }) => {
    const rr = p.r + 0.3;
    for (let y = Math.floor((p.y - rr) * R); y <= Math.ceil((p.y + rr) * R); y++)
      for (let x = Math.floor((p.x - rr) * R); x <= Math.ceil((p.x + rr) * R); x++) {
        if (x < 0 || y < 0 || x >= W * R || y >= H * R) continue;
        if (Math.hypot((x + 0.5) / R - p.x, (y + 0.5) / R - p.y) < rr) occ[y * W * R + x] |= OCC_FIELD;
      }
  };
  for (const r of [4.2, 3.4, 2.7]) {
    for (let y = 4; y < H - 4 && out.length < 4; y += 1.5)
      for (let x = 4; x < W - 4 && out.length < 4; x += 1.5) {
        // player 0's half (y > x), mirrored onto the other
        if (y - x < r + 1) continue;
        const a = { x: x + 0.25, y: y + 0.25, r };
        const b = { x: W - a.x, y: H - a.y, r };
        if (out.some((p) => Math.hypot(p.x - a.x, p.y - a.y) < p.r + r + 2.5 || Math.hypot(p.x - b.x, p.y - b.y) < p.r + r + 2.5)) continue;
        if (!discOk(a.x, a.y, r) || !discOk(b.x, b.y, r)) continue;
        out.push(a, b);
        mark(a);
        mark(b);
      }
  }
  return out;
}

/**
 * Kitchen gardens, greenhouses and orchards round the villages: small plots next to the houses
 * (render only), wherever a whole rectangle is clear (`fieldOk`: no roads, tracks, structures,
 * trees, ore or steep ground; away from the bases). Deterministic.
 */
export function villagePlots(m: GameMap, fieldOk: (f: Field) => boolean, mark: (f: Field) => void, max: number, pick: (r: number) => FieldType, posts: V2[], edges?: Edge[]): Field[] {
  const out: Field[] = [];
  const houses = m.structures.filter((st) => st.kind !== StructureKind.Tower && st.kind !== StructureKind.WaterTower);
  const dirs = [
    [1, 0],
    [0, 1],
    [-1, 0],
    [0, -1],
    [1, 1],
    [-1, 1],
    [1, -1],
    [-1, -1],
  ];
  houses.forEach((st, si) => {
    let n = 0;
    for (let k = 0; k < dirs.length && out.length < max && n < 2; k++) {
      const [dx, dy] = dirs[(k + si) % dirs.length];
      const along = hash2(si, k, 616) < 0.5;
      const hl = 1.5 + hash2(si, k, 617) * 1.3;
      const hw = 0.8 + hash2(si, k, 618) * 0.6;
      const ex = along ? hl : hw;
      const ey = along ? hw : hl;
      const cx = st.x + st.w / 2 + dx * (st.w / 2 + 1.1 + ex);
      const cy = st.y + st.h / 2 + dy * (st.h / 2 + 1.1 + ey);
      const f: Field = { cx, cy, hl, hw, angle: along ? 0 : Math.PI / 2, type: pick(hash2(si, k, 619)), plot: true };
      if (!fieldOk(f)) continue;
      if (posts.some((p) => Math.abs(p.x - cx) < ex + 0.6 && Math.abs(p.y - cy) < ey + 0.6)) continue;
      out.push(f);
      mark(f);
      n++;
      // a garden fence along the far long side
      if (edges && hash2(si, k, 620) < 0.6) {
        const ca = Math.cos(f.angle);
        const sa = Math.sin(f.angle);
        const side = (along ? dy : dx) >= 0 ? 1 : -1;
        const nx = -sa * (hw + 0.3) * side;
        const ny = ca * (hw + 0.3) * side;
        edges.push({ a: v(cx - ca * hl + nx, cy - sa * hl + ny), b: v(cx + ca * hl + nx, cy + sa * hl + ny), kind: 'fence' });
      }
    }
  });
  return out;
}
