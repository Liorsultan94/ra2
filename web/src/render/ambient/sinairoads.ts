import { SINAI_N, sinaiPlaces } from '../../sim/maps';
import type { GameMap } from '../../sim/map';
import type { Road, V2 } from '../layout';

/*
 * The Sinai's civilian road network beyond the sim's three roads (the highway and the two coast roads): a few paved
 * links where the places are (the squares of the two seaside towns, the resort of the Gulf of Suez), and the places
 * whose crossings are laid out as roundabouts. Render only: nothing here is read by the simulation, the roads are
 * decoration plus traffic (the sim's own roads, houses, ore, oil and starts stay as they were). Routed round whatever
 * blocks (houses, ore, rock, the sea) by the layout's router; no bridges. Pure and deterministic.
 */

export interface ExtraRoad {
  pts: V2[];
  width: number;
  variant: 0 | 1;
}

type Router = (vias: V2[], width: number, step?: number) => V2[];

/** Is this the Sinai (the 208 x 208 desert map)? */
export const isSinai = (m: GameMap) => m.biome === 'desert' && m.w === SINAI_N && m.h === SINAI_N;

/**
 * Where the crossings of paved roads are made roundabouts (the villages at the heads of the gulfs, the squares of the
 * two towns), with the radius round each place in which a junction counts as its square. Elsewhere junctions stay
 * give-way crossings.
 */
export function sinaiRoundabouts(m: GameMap): { x: number; y: number; r: number }[] {
  if (!isSinai(m)) return [];
  const pl = sinaiPlaces();
  return [
    { ...pl.villages[0], r: 5 },
    { ...pl.villages[1], r: 5 },
    { ...pl.sharm, r: 6.5 },
    { ...pl.nuweiba, r: 6 },
  ];
}

/** The point of the existing roads nearest `at` (any point of any polyline). */
function nearestOnRoads(roads: readonly Road[], at: V2): V2 {
  let best = 1e9;
  let out = at;
  for (const r of roads) {
    if (r.ring || r.lot !== undefined) continue;
    for (let i = 0; i < r.pts.length - 1; i++) {
      const a = r.pts[i];
      const b = r.pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1e-9;
      const t = Math.max(0, Math.min(1, ((at.x - a.x) * dx + (at.y - a.y) * dy) / l2));
      const d = Math.hypot(at.x - a.x - dx * t, at.y - a.y - dy * t);
      if (d < best) {
        best = d;
        out = { x: a.x + dx * t, y: a.y + dy * t };
      }
    }
  }
  return out;
}

/** The end (of any road) nearest `at`. */
function nearestEnd(roads: readonly Road[], at: V2): V2 {
  let best = 1e9;
  let out = at;
  for (const r of roads) {
    if (r.ring || r.lot !== undefined || r.closed) continue;
    for (const p of [r.pts[0], r.pts[r.pts.length - 1]]) {
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d < best) {
        best = d;
        out = p;
      }
    }
  }
  return out;
}

const v = (x: number, y: number): V2 => ({ x, y });

/** Cut `len` tiles off the end of `r` nearest `at` (the town's square moves back from the road's end). */
function trimEnd(roads: Road[], at: V2, len: number) {
  let best = 1e9;
  let ri = -1;
  let end = 0;
  roads.forEach((r, i) => {
    if (r.ring || r.lot !== undefined || r.closed) return;
    ([0, 1] as const).forEach((e) => {
      const p = r.pts[e ? r.pts.length - 1 : 0];
      const d = Math.hypot(p.x - at.x, p.y - at.y);
      if (d < best) {
        best = d;
        ri = i;
        end = e;
      }
    });
  });
  if (ri < 0 || best > 8) return;
  const r = roads[ri];
  const n = Math.round(len / 0.25);
  if (r.pts.length < n + 40) return;
  if (end) r.pts = r.pts.slice(0, r.pts.length - n);
  else r.pts = r.pts.slice(n);
}

/** Sharm's road stops short of where it ran out: the square lies on free ground (before the extra roads are laid). */
export function sinaiTrimRoads(m: GameMap, roads: Road[]) {
  if (!isSinai(m)) return;
  trimEnd(roads, sinaiPlaces().sharm, 3.6);
}

/**
 * The extra paved links, routed from where they leave an existing road (`roads`: the sim's roads as the layout
 * routed them, cut short of the bases).
 */
export function sinaiExtraRoads(m: GameMap, route: Router, roads: readonly Road[]): ExtraRoad[] {
  if (!isSinai(m)) return [];
  const pl = sinaiPlaces();
  const out: ExtraRoad[] = [];
  const add = (via: V2[], width: number) => {
    const pts = route(via, width);
    if (pts.length > 8) out.push({ pts, width, variant: 1 });
  };
  const sharm = nearestEnd(roads, pl.sharm);
  const nuw = nearestEnd(roads, pl.nuweiba);
  // Sharm: its square, the seafront road round the south of the town to the resort's beach, and the road up the town
  add([sharm, v(sharm.x + 1.2, sharm.y + 4.6), v(sharm.x + 5.5, sharm.y + 5.4), v(sharm.x + 10.5, sharm.y + 4.6), v(sharm.x + 13.0, sharm.y + 1.8)], 0.85);
  add([sharm, v(sharm.x - 1.4, sharm.y - 4.0), v(sharm.x - 1.4, sharm.y - 8.8)], 0.85);
  // Nuweiba: its square, the waterfront street south and the street to the mosque
  add([nuw, v(nuw.x + 0.9, nuw.y + 4.2), v(nuw.x + 1.6, nuw.y + 8.6)], 0.85);
  add([nuw, v(nuw.x - 3.4, nuw.y + 3.4), v(nuw.x - 7.4, nuw.y + 2.8), v(nuw.x - 8.0, nuw.y + 2.6)], 0.85);
  // the resort of the Gulf of Suez: its drive from the coast road
  const rw = nearestOnRoads(roads, v(62.3, 113.6));
  add([rw, v(rw.x + 0.2, rw.y + 4.4), v(rw.x - 1.8, rw.y + 8.2), v(rw.x - 4.0, rw.y + 10.0)], 0.8);
  return out;
}
