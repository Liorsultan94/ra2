import { frameUV, seaDist, type GameMap } from '../../sim/map';
import { sinaiPlaces } from '../../sim/maps';
import { hash2 } from '../../sim/rng';
import { isSinai } from './sinairoads';
import { nearForbidden, siteFree } from './sites';
import { onSurface, pointAt, type NetLine, type RoadNet } from './roadnet';

/*
 * The Sinai's roadside signs (pure and deterministic: every choice is a hash of the tile position, nothing is
 * random): billboards of different size and shape along the highway and the coast roads, hand-painted shop signs
 * and painted walls in the villages, and the road signs of the junctions (speed limits, warning triangles,
 * direction boards). Each sign is a style (shape), a size, a height, a lean, a facing, a weathering and a palette,
 * its two faces' designs picked from the small atlas (signart.ts). Fictional names only.
 */

export const enum SignKind {
  /** Landscape board on two posts, two lamps (medium). */
  Board = 0,
  /** Big highway billboard: a wide board on two thick posts with a catwalk and three lamps (large). */
  Big = 1,
  /** Tall pole sign: a portrait board high on one pole. */
  Pole = 2,
  /** Small square board on one post. */
  Square = 3,
  /** Two landscape boards one above the other on two posts. */
  Stack = 4,
  /** A painted mud-brick wall with a wall-painted advert. */
  Wall = 5,
  /** A hand-painted shop sign: a plank on two short stakes. */
  Shop = 6,
  /** Round road sign (speed limit, no overtaking) on a post. */
  Round = 7,
  /** Warning triangle on a post. */
  Tri = 8,
  /** Direction board with an arrow tip (points to the right; `flip`: to the left) on a post. */
  Arrow = 9,
}
export const SIGN_KINDS = 10;

/** The adverts: everything that is not a road sign. */
export const isAd = (k: SignKind) => k <= SignKind.Shop;

/** Size class: 0 small roadside, 1 medium board, 2 large, 3 huge highway billboard. */
export const SIGN_SIZE: Record<number, number> = {
  [SignKind.Board]: 1,
  [SignKind.Big]: 3,
  [SignKind.Pole]: 2,
  [SignKind.Square]: 1,
  [SignKind.Stack]: 2,
  [SignKind.Wall]: 1,
  [SignKind.Shop]: 0,
  [SignKind.Round]: 0,
  [SignKind.Tri]: 0,
  [SignKind.Arrow]: 1,
};

/** Atlas cells by group: [first, last] ids (signart.ts lays them out and paints them). */
export const CELLS = {
  land: [0, 11],
  hand: [12, 15],
  arrow: [16, 21],
  mural: [22, 23],
  portrait: [24, 31],
  square: [32, 39],
  round: [40, 43],
  tri: [44, 46],
  white: 47,
  roundBack: 48,
  triBack: 49,
  arrowBack: 50,
} as const;
export const CELL_COUNT = 51;

/** Cell ids of road signs (CELLS.round / CELLS.tri). */
export const ROUND_SPEED30 = 40;
export const ROUND_SPEED50 = 41;
export const ROUND_SPEED80 = 42;
export const ROUND_NOOVERTAKE = 43;
export const TRI_ROUNDABOUT = 44;
export const TRI_CURVE = 45;
export const TRI_CAMELS = 46;

export interface Sign {
  kind: SignKind;
  x: number;
  y: number;
  /** Facing: tile-space angle of the front face's normal. */
  yaw: number;
  /** Uniform scale within the size class (0.8 .. 1.3). */
  scale: number;
  /** Lift (tiles): how high the board stands on its posts. */
  lift: number;
  /** Lean, radians: sideways in the board's plane, and backwards. */
  roll: number;
  pitch: number;
  /** Weathering 0..1: sun fade, sand blasting, peeling, rust. */
  wear: number;
  /** Palette of the frame / posts (index into signs.ts FRAME_TINTS). */
  pal: number;
  /** Atlas cells of the front and the back face. */
  front: number;
  back: number;
  /** Lamps over the board (lit at night). */
  lamp: boolean;
  /** Arrow boards: point to the left. */
  flip: boolean;
  /** The road it stands by and the arc along it (order along a road: the neighbours are tested). */
  line: number;
  arc: number;
  seed: number;
}

/** Style of a sign for the "no two alike in a row" rule: its shape and the design of its front. */
export const styleOf = (s: Sign) => s.kind * 100 + s.front;

function pick(group: readonly [number, number], h: number): number {
  return group[0] + Math.min(group[1] - group[0], Math.floor(h * (group[1] - group[0] + 1)));
}

interface Spot {
  x: number;
  y: number;
  nx: number;
  ny: number;
  line: number;
  arc: number;
}

/**
 * Signs of the Sinai (none elsewhere). `occ` / `R` is the layout's occupancy grid: spots on roads, tracks, fields,
 * buildings and turning circles are refused; `taken(x, y, r)` lets the caller stamp what it places.
 */
export function planSigns(m: GameMap, net: RoadNet, occ: Uint8Array, R: number): Sign[] {
  if (!isSinai(m)) return [];
  const out: Sign[] = [];
  const places = sinaiPlaces();
  const centres = [...places.villages, ...places.northVillages, places.sharm, places.nuweiba, ...places.baseVillages];

  const sea = m.deco?.sea;
  const free = (x: number, y: number, r: number) => {
    if (nearForbidden(m, x, y, r * 0.6)) return false;
    // not on the beaches (the resorts' sunbeds, the people): inland of the sea's busy strip, as the trees are
    if (sea && seaDist(sea, x, y) > -4.6) return false;
    // nor in a resort or on its beach front (the sunbeds, the terrace, the bars)
    if (sea)
      for (const st of sea.sites) {
        const f = frameUV(st, x, y);
        const r = st.resort;
        if (f.u > Math.min(r.u0, st.beach[0]) - 3 && f.u < Math.max(r.u1, st.beach[1]) + 3 && f.v > r.v0 - 3 && f.v < 5) return false;
      }
    for (let k = 0; k < 9; k++) {
      const a = (k / 8) * Math.PI * 2;
      const rr = k === 8 ? 0 : r;
      const px = x + Math.cos(a) * rr;
      const py = y + Math.sin(a) * rr;
      if (!siteFree(m, occ, R, px, py) || onSurface(net, px, py)) return false;
    }
    for (const lp of net.loops) if (Math.hypot(lp.x - x, lp.y - y) < lp.R + 0.9) return false;
    for (const lot of net.lots) {
      const dx = x - lot.x;
      const dy = y - lot.y;
      if (Math.abs(dx * lot.ux + dy * lot.uy) < lot.L / 2 + 0.6 && Math.abs(dx * lot.nx + dy * lot.ny) < lot.D / 2 + 0.6) return false;
    }
    return true;
  };
  const houses = (x: number, y: number, r: number) => {
    let n = 0;
    for (const s of m.structures) if (Math.hypot(s.x + s.w / 2 - x, s.y + s.h / 2 - y) < r) n++;
    return n;
  };
  /** A spot on the right of a car travelling `dir` along `L` at arc `s`, `off` beyond the edge, the face turned mostly to the road and a little to the oncoming traffic (so it reads from the road and from above). */
  const spot = (L: NetLine, li: number, s: number, dir: number, off: number): Spot => {
    const p = pointAt(L, s);
    const tx = p.tx * dir;
    const ty = p.ty * dir;
    // right of the travel direction (as the lanes: roadnet.ts)
    const rx = -ty;
    const ry = tx;
    const d = L.half + off;
    const x = p.x + rx * d;
    const y = p.y + ry * d;
    // towards the road and back against the traffic
    return { x, y, nx: -rx * 0.86 - tx * 0.5, ny: -ry * 0.86 - ty * 0.5, line: li, arc: s };
  };
  const mk = (sp: Spot, kind: SignKind, seed: number, over: Partial<Sign> = {}): Sign => {
    const h = (k: number) => hash2(seed, k, 8810);
    const size = SIGN_SIZE[kind];
    const yaw = Math.atan2(sp.ny, sp.nx) + (h(1) - 0.5) * 0.5;
    // wear: the road signs a little, adverts anything from new to wrecked
    const wear = kind >= SignKind.Round ? h(2) * 0.55 : h(2) < 0.22 ? 0.75 + h(3) * 0.25 : h(2) * 0.7;
    const leaning = h(4) < 0.2;
    const hand = kind === SignKind.Shop;
    const grp = (g: readonly [number, number], salt: number) => pick(g, h(salt));
    let front = 0;
    let back = 0;
    switch (kind) {
      case SignKind.Board:
      case SignKind.Big:
      case SignKind.Stack:
        front = grp(CELLS.land, 5);
        back = grp(CELLS.land, 6);
        if (back === front) back = CELLS.land[0] + ((back - CELLS.land[0] + 5) % (CELLS.land[1] - CELLS.land[0] + 1));
        break;
      case SignKind.Wall:
        front = h(5) < 0.45 ? grp(CELLS.mural, 5) : grp(CELLS.land, 5);
        back = h(6) < 0.5 ? grp(CELLS.hand, 6) : grp(CELLS.land, 6);
        break;
      case SignKind.Shop:
        front = grp(CELLS.hand, 5);
        back = grp(CELLS.hand, 6);
        break;
      case SignKind.Pole:
        front = grp(CELLS.portrait, 5);
        back = grp(CELLS.portrait, 6);
        break;
      case SignKind.Square:
        front = grp(CELLS.square, 5);
        back = grp(CELLS.square, 6);
        break;
      case SignKind.Round:
        front = ROUND_SPEED50;
        back = CELLS.roundBack;
        break;
      case SignKind.Tri:
        front = TRI_CURVE;
        back = CELLS.triBack;
        break;
      case SignKind.Arrow:
        front = grp(CELLS.arrow, 5);
        back = CELLS.arrowBack;
        break;
    }
    return {
      kind,
      x: sp.x,
      y: sp.y,
      yaw,
      scale: kind >= SignKind.Round ? 1.25 : size === 3 ? 0.9 + h(7) * 0.3 : 0.8 + h(7) * 0.5,
      lift: kind >= SignKind.Round || kind === SignKind.Wall ? 0 : h(8) * (size >= 2 ? 0.25 : 0.12),
      roll: leaning ? (h(9) < 0.5 ? -1 : 1) * (0.1 + h(10) * 0.2) : (h(10) - 0.5) * 0.05,
      pitch: leaning ? (h(11) - 0.3) * 0.18 : (h(11) - 0.5) * 0.04,
      wear: hand ? Math.max(wear, 0.25) : wear,
      pal: Math.floor(h(12) * 6),
      front,
      back,
      lamp: (kind === SignKind.Big || kind === SignKind.Board || kind === SignKind.Stack) && h(13) < 0.8,
      flip: false,
      line: sp.line,
      arc: sp.arc,
      seed: Math.floor(h(14) * 1e6),
      ...over,
    };
  };
  const accept = (sg: Sign, r: number, gap: number): boolean => {
    if (!free(sg.x, sg.y, r)) return false;
    for (const o of out) if (Math.hypot(o.x - sg.x, o.y - sg.y) < gap) return false;
    out.push(sg);
    return true;
  };
  const RAD: Record<number, number> = {
    [SignKind.Board]: 0.6,
    [SignKind.Big]: 1.1,
    [SignKind.Pole]: 0.4,
    [SignKind.Square]: 0.35,
    [SignKind.Stack]: 0.6,
    [SignKind.Wall]: 0.7,
    [SignKind.Shop]: 0.35,
    [SignKind.Round]: 0.2,
    [SignKind.Tri]: 0.2,
    [SignKind.Arrow]: 0.45,
  };
  /** Distance of a tile to the nearest place centre. */
  const nearPlace = (x: number, y: number) => centres.reduce((d, c) => Math.min(d, Math.hypot(c.x - x, c.y - y)), 1e9);

  // ---- billboards along the roads: a candidate every few tiles by the tile's hash, never the same style twice in a row
  net.lines.forEach((L, li) => {
    if (!L.paved || L.lot >= 0 || L.bridge >= 0 || L.len < 12) return;
    const mine: Sign[] = [];
    // (a second sweep fills the stretches the first left bare: no gap of more than ~20 tiles where there is room)
    for (const sweep of [0, 1]) {
      let prev: Sign | null = null;
      const before = (s: number) => mine.filter((q) => q.arc < s).sort((a, b) => b.arc - a.arc)[0] ?? null;
      for (let s = L.a0 + 4; s < L.a1 - 4; s += 2.4) {
      const p = pointAt(L, s);
      const fx = Math.floor(p.x * 2);
      const fy = Math.floor(p.y * 2);
      if (sweep === 0 ? hash2(fx, fy, 8801) > 0.42 : hash2(fx, fy, 8805) > 0.6 || mine.some((q) => Math.abs(q.arc - s) < 11)) continue;
      prev = before(s);
      if (prev && s - prev.arc < 8) continue;
      // not in the middle of a junction
      if (L.stops.some((st) => Math.abs(st.arc - s) < 4.5)) continue;
      const near = houses(p.x, p.y, 8);
      const dir = hash2(fx, fy, 8802) < 0.5 ? 1 : -1;
      const hw = L.variant === 0;
      // by the highway the huge boards, in the villages the walls and shop signs
      const w = hash2(fx, fy, 8803);
      let kinds: [SignKind, number][];
      if (near >= 3) kinds = [[SignKind.Wall, 0.3], [SignKind.Shop, 0.3], [SignKind.Square, 0.15], [SignKind.Board, 0.15], [SignKind.Pole, 0.1]];
      else if (hw) kinds = [[SignKind.Big, 0.4], [SignKind.Board, 0.22], [SignKind.Pole, 0.2], [SignKind.Stack, 0.18]];
      else if (near >= 1) kinds = [[SignKind.Board, 0.22], [SignKind.Pole, 0.18], [SignKind.Square, 0.18], [SignKind.Shop, 0.16], [SignKind.Stack, 0.12], [SignKind.Wall, 0.14]];
      else kinds = [[SignKind.Board, 0.28], [SignKind.Pole, 0.22], [SignKind.Square, 0.22], [SignKind.Stack, 0.14], [SignKind.Big, 0.14]];
      let kind = kinds[0][0];
      for (let k = 0; k < 7; k++) {
        const t = (w + k * 0.37) % 1;
        let acc = 0;
        kind = kinds[kinds.length - 1][0];
        for (const [kd, wt] of kinds) {
          acc += wt;
          if (t < acc) {
            kind = kd;
            break;
          }
        }
        if (!prev || prev.kind !== kind) break;
      }
      const off = kind === SignKind.Big ? 1.5 + hash2(fx, fy, 8804) * 1.0 : kind === SignKind.Wall ? 1.1 : 0.7 + hash2(fx, fy, 8804) * 0.8;
      const sg = mk(spot(L, li, s, dir, off), kind, fx * 7919 + fy * 104729 + li);
      // not the same design as the one before either
      if (prev && (prev.front === sg.front || prev.kind === sg.kind)) continue;
      if (accept(sg, RAD[kind], kind === SignKind.Big ? 11 : 6)) mine.push(sg);
      }
    }
  });

  // ---- village entrances: the speed limit on the right of each way in, a camel crossing on the open stretches
  net.lines.forEach((L, li) => {
    if (!L.paved || L.lot >= 0 || L.bridge >= 0 || L.len < 12) return;
    for (const c of centres) {
      let was = Math.hypot(pointAt(L, L.a0).x - c.x, pointAt(L, L.a0).y - c.y);
      for (let s = L.a0 + 0.6; s < L.a1; s += 0.6) {
        const p = pointAt(L, s);
        const d = Math.hypot(p.x - c.x, p.y - c.y);
        const R0 = 11;
        const enter = was > R0 && d <= R0;
        const leave = was <= R0 && d > R0;
        was = d;
        if (!enter && !leave) continue;
        const dir = enter ? 1 : -1;
        const sg = mk(spot(L, li, s + (enter ? -0.5 : 0.5), dir, 0.5), SignKind.Round, Math.floor(s * 10) + li * 977 + Math.floor(c.x * 31), { front: dir > 0 ? ROUND_SPEED30 : ROUND_SPEED50, wear: 0.1 + hash2(Math.floor(p.x), Math.floor(p.y), 8820) * 0.5 });
        accept(sg, RAD[SignKind.Round], 3);
      }
    }
  });

  // ---- the highway: 80 limits between places, warning triangles at the sharp bends and the camel crossings
  net.lines.forEach((L, li) => {
    if (!L.paved || L.lot >= 0 || L.bridge >= 0 || L.len < 30) return;
    let lastRound = -99;
    let lastTri = -99;
    for (let s = L.a0 + 6; s < L.a1 - 6; s += 1.5) {
      const p = pointAt(L, s);
      const a = pointAt(L, s - 3);
      const ax = a.tx;
      const ay = a.ty;
      const b = pointAt(L, s + 3);
      const turn = Math.abs(Math.atan2(ax * b.ty - ay * b.tx, ax * b.tx + ay * b.ty));
      const fx = Math.floor(p.x);
      const fy = Math.floor(p.y);
      if (turn > 0.5 && s - lastTri > 22 && nearPlace(p.x, p.y) > 14) {
        for (const dir of [1, -1]) {
          const sg = mk(spot(L, li, s - dir * 8, dir, 0.55), SignKind.Tri, fx * 31 + fy + dir, { front: TRI_CURVE });
          accept(sg, RAD[SignKind.Tri], 4);
        }
        lastTri = s;
      } else if (L.variant === 0 && s - lastRound > 55 && nearPlace(p.x, p.y) > 16 && hash2(fx, fy, 8830) < 0.4) {
        const dir = hash2(fx, fy, 8831) < 0.5 ? 1 : -1;
        if (accept(mk(spot(L, li, s, dir, 0.6), SignKind.Round, fx * 17 + fy, { front: hash2(fx, fy, 8832) < 0.2 ? ROUND_NOOVERTAKE : ROUND_SPEED80 }), RAD[SignKind.Round], 5)) lastRound = s;
      } else if (s - lastTri > 45 && nearPlace(p.x, p.y) > 20 && hash2(fx, fy, 8833) < 0.05) {
        const dir = hash2(fx, fy, 8834) < 0.5 ? 1 : -1;
        if (accept(mk(spot(L, li, s, dir, 0.6), SignKind.Tri, fx * 13 + fy, { front: TRI_CAMELS }), RAD[SignKind.Tri], 5)) lastTri = s;
      }
    }
  });

  // ---- the roundabouts: "roundabout ahead" before each way in, a direction board with the names
  net.loops.forEach((lp, i) => {
    if (!lp.town) return;
    const nd = net.nodes[lp.node];
    nd.arms.forEach((a, k) => {
      const L = net.lines[a.line];
      const dir = -a.dir;
      const s0 = a.edge + a.dir * 7.5;
      if (s0 < L.a0 + 0.5 || s0 > L.a1 - 0.5) return;
      accept(mk(spot(L, a.line, s0, dir, 0.55), SignKind.Tri, i * 53 + k, { front: TRI_ROUNDABOUT }), RAD[SignKind.Tri], 3);
      const s1 = a.edge + a.dir * 3.6;
      if (s1 > L.a0 + 0.5 && s1 < L.a1 - 0.5) accept(mk(spot(L, a.line, s1, dir, 0.7), SignKind.Arrow, i * 71 + k * 5, { front: CELLS.arrow[0] + ((i * 3 + k) % 6), flip: k % 4 === 2 }), RAD[SignKind.Arrow], 3);
    });
  });
  // ---- and a board by each square, turned to it (a pole sign, a board, a stack or a small square one)
  net.loops.forEach((lp, i) => {
    if (!lp.town) return;
    const kinds = [SignKind.Pole, SignKind.Board, SignKind.Stack, SignKind.Square];
    for (let k = 0; k < 20; k++) {
      const a = (hash2(i, k, 8840) + k / 20) * Math.PI * 2;
      const r = lp.R + 2.4 + hash2(i, k, 8841) * 1.4;
      const sp: Spot = { x: lp.x + Math.cos(a) * r, y: lp.y + Math.sin(a) * r, nx: -Math.cos(a), ny: -Math.sin(a), line: 1000 + i, arc: 0 };
      const kind = kinds[(i + k) % 4];
      if (accept(mk(sp, kind, i * 131 + k), RAD[kind], 4)) break;
    }
  });
  return out;
}
