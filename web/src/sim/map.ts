import { fbm, hash2 } from './rng';

export const enum Tile {
  Grass = 0,
  Dirt = 1,
  Sand = 2,
  Water = 3,
  Rock = 4,
  Bridge = 5,
}

export const WATER_LEVEL = -0.25;
export const BRIDGE_HEIGHT = 0.35;

export interface Point {
  x: number;
  y: number;
}

export interface GameMap {
  name: string;
  w: number;
  h: number;
  tiles: Uint8Array;
  /** Vertex heights, (w+1) * (h+1). */
  heights: Float32Array;
  trees: Uint8Array; // 0 none, 1 pine, 2 broadleaf
  ore: Uint8Array; // amount of ore units on tile
  oreKind: Uint8Array; // 1 ore, 2 gems
  oreMines: Point[];
  starts: Point[];
  oils: Point[];
  bridges: { x: number; y: number; angle: number; length: number }[];
  /** Road centerlines (the sim only marks them as dirt tiles; the renderer paves them). */
  roads: Point[][];
  /** Civilian scenery buildings. Their footprints are impassable (see `blocked`). */
  structures: Structure[];
  /** 1 where a civilian structure stands. */
  blocked: Uint8Array;
}

export const enum StructureKind {
  House = 0,
  Cottage = 1,
  Barn = 2,
  Tower = 3,
  WaterTower = 4,
  Silo = 5,
}

export interface Structure {
  kind: StructureKind;
  /** Footprint in tiles (top-left corner + size). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Facing (0..3, quarter turns): which side the front door / gable faces. */
  rot: number;
}

export const ORE_MAX = 10;
export const ORE_VALUE = 25;
export const GEM_VALUE = 50;

export function inBounds(m: GameMap, x: number, y: number) {
  return x >= 0 && y >= 0 && x < m.w && y < m.h;
}

/** Ground-unit passability from terrain alone (buildings handled by the world). */
export function terrainPassable(m: GameMap, x: number, y: number): boolean {
  if (!inBounds(m, x, y)) return false;
  const i = y * m.w + x;
  const t = m.tiles[i];
  return t !== Tile.Water && t !== Tile.Rock && m.trees[i] === 0 && m.blocked[i] === 0;
}

export function terrainBuildable(m: GameMap, x: number, y: number): boolean {
  if (!terrainPassable(m, x, y)) return false;
  const i = y * m.w + x;
  return m.tiles[i] !== Tile.Bridge && m.ore[i] === 0;
}

function vertexHeight(m: GameMap, vx: number, vy: number) {
  vx = Math.max(0, Math.min(m.w, vx));
  vy = Math.max(0, Math.min(m.h, vy));
  return m.heights[vy * (m.w + 1) + vx];
}

/** Ground height at a continuous tile-space position (bilinear over vertices). */
export function groundHeight(m: GameMap, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = vertexHeight(m, x0, y0);
  const b = vertexHeight(m, x0 + 1, y0);
  const c = vertexHeight(m, x0, y0 + 1);
  const d = vertexHeight(m, x0 + 1, y0 + 1);
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

/** Height at which a unit stands (bridges lift units above the water). */
export function standHeight(m: GameMap, x: number, y: number): number {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  if (inBounds(m, tx, ty) && m.tiles[ty * m.w + tx] === Tile.Bridge) return BRIDGE_HEIGHT;
  return Math.max(groundHeight(m, x, y), WATER_LEVEL);
}

function smoothstep(e0: number, e1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return Math.hypot(px - cx, py - cy);
}

/**
 * "Frontline Crossing": a hand-designed, point-symmetric two player map.
 * A meandering river runs between the bases and is crossed by three bridges.
 */
export function createFrontlineMap(): GameMap {
  const W = 96;
  const H = 96;
  const SEED = 1337;
  const cx = (W - 1) / 2;
  const cy = (H - 1) / 2;

  const starts: Point[] = [
    { x: 15, y: 80 },
    { x: W - 1 - 15, y: H - 1 - 80 },
  ];

  // Features are described for player 0's half and mirrored through the center.
  const mirror = (p: Point): Point => ({ x: W - 1 - p.x, y: H - 1 - p.y });
  const half = <T extends Point>(arr: T[]) => [...arr, ...arr.map((p) => ({ ...p, ...mirror(p) }))];

  const oreFields = half([
    { x: 27, y: 87, r: 3.6, kind: 1 },
    { x: 8, y: 66, r: 3.2, kind: 1 },
    { x: 33, y: 62, r: 3.0, kind: 1 },
    { x: 20, y: 46, r: 2.6, kind: 2 },
    { x: 46, y: 89, r: 2.6, kind: 2 },
  ]);
  const oils = half([
    { x: 38, y: 74 },
    { x: 6, y: 50 },
  ]);
  const ridges = half([
    { x: 24, y: 70, x2: 31, y2: 74 },
    { x: 40, y: 64, x2: 44, y2: 58 },
    { x: 12, y: 56, x2: 18, y2: 58 },
    { x: 54, y: 80, x2: 60, y2: 84 },
  ] as (Point & { x2: number; y2: number })[]).map((r, i, a) => {
    // mirror the second endpoint too
    if (i >= a.length / 2) {
      const src = a[i - a.length / 2];
      return { ...r, x2: W - 1 - src.x2, y2: H - 1 - src.y2 };
    }
    return r;
  });
  const roads: Point[][] = [
    [starts[0], { x: 30, y: 72 }, { x: 44, y: 60 }, { x: cx, y: cy }],
    [starts[0], { x: 30, y: 84 }, { x: 52, y: 82 }, { x: 64, y: 76 }],
    [starts[0], { x: 12, y: 62 }, { x: 18, y: 44 }, { x: 24, y: 30 }],
  ];
  const allRoads = [...roads, ...roads.map((r) => r.map(mirror))];

  // River geometry: centerline x == y, meandering perpendicular to it.
  const riverOffset = (s: number) => 4.5 * Math.sin((s - cx) * 0.11) + 1.5 * Math.sin((s - cx) * 0.31);
  const riverDist = (x: number, y: number) => {
    const s = (x + y) / 2;
    const d = (x - y) / Math.SQRT2;
    return Math.abs(d - riverOffset(s));
  };
  const bridgeS = [cx, cx - 27, cx + 27];

  const symNoise = (x: number, y: number, scale: number, seed: number) =>
    (fbm(x * scale, y * scale, seed) + fbm((W - x) * scale, (H - y) * scale, seed)) / 2;

  const heights = new Float32Array((W + 1) * (H + 1));
  for (let vy = 0; vy <= H; vy++) {
    for (let vx = 0; vx <= W; vx++) {
      let h = (symNoise(vx, vy, 0.055, SEED) - 0.5) * 2.4 + 0.5;
      // flatten bases
      for (const s of starts) {
        const d = Math.hypot(vx - s.x - 0.5, vy - s.y - 0.5);
        h = h + (0.45 - h) * (1 - smoothstep(9, 15, d));
      }
      // river carving
      const rd = riverDist(vx - 0.5, vy - 0.5);
      h = h + (-0.9 - h) * (1 - smoothstep(1.6, 3.6, rd));
      // ridges
      for (const r of ridges) {
        const d = distToSegment(vx, vy, r.x, r.y, r.x2, r.y2);
        h += 1.6 * (1 - smoothstep(0.6, 2.4, d)) * (0.85 + 0.3 * hash2(vx, vy, 99));
      }
      heights[vy * (W + 1) + vx] = h;
    }
  }

  const tiles = new Uint8Array(W * H);
  const trees = new Uint8Array(W * H);
  const ore = new Uint8Array(W * H);
  const oreKind = new Uint8Array(W * H);

  const nearStart = (x: number, y: number, r: number) => starts.some((s) => Math.hypot(x - s.x, y - s.y) < r);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const fx = x + 0.5;
      const fy = y + 0.5;
      const rd = riverDist(x, y);
      let t: Tile = Tile.Grass;
      const s = (x + y) / 2;
      if (rd < 2.3) {
        t = Tile.Water;
        for (const bs of bridgeS) if (Math.abs(s - bs) <= 1.0) t = Tile.Bridge;
      } else if (rd < 3.4) {
        t = Tile.Sand;
      } else {
        const n = symNoise(x, y, 0.09, SEED + 5);
        if (n > 0.6) t = Tile.Dirt;
      }
      for (const r of ridges) {
        if (distToSegment(fx, fy, r.x, r.y, r.x2, r.y2) < 1.15) t = Tile.Rock;
      }
      tiles[i] = t;
    }
  }

  // Roads (visual dirt paths, passable)
  for (const road of allRoads) {
    for (let k = 0; k < road.length - 1; k++) {
      const a = road[k];
      const b = road[k + 1];
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          if (tiles[i] !== Tile.Grass && tiles[i] !== Tile.Dirt && tiles[i] !== Tile.Sand) continue;
          if (distToSegment(x + 0.5, y + 0.5, a.x + 0.5, a.y + 0.5, b.x + 0.5, b.y + 0.5) < 0.9) tiles[i] = Tile.Dirt;
        }
      }
    }
  }

  // Ore fields
  for (const f of oreFields) {
    for (let y = Math.floor(f.y - f.r - 1); y <= f.y + f.r + 1; y++) {
      for (let x = Math.floor(f.x - f.r - 1); x <= f.x + f.r + 1; x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = y * W + x;
        if (tiles[i] === Tile.Water || tiles[i] === Tile.Rock || tiles[i] === Tile.Bridge) continue;
        const d = Math.hypot(x - f.x, y - f.y);
        const jitter = (hash2(x, y, 7) + hash2(W - 1 - x, H - 1 - y, 7)) / 2;
        if (d < f.r + jitter * 1.2 - 0.6) {
          oreKind[i] = f.kind;
          ore[i] = Math.max(2, Math.round(ORE_MAX * (1 - d / (f.r + 1.5)) + 2));
          if (ore[i] > ORE_MAX) ore[i] = ORE_MAX;
          if (tiles[i] === Tile.Sand) tiles[i] = Tile.Dirt;
        }
      }
    }
  }

  const reserved = (x: number, y: number) =>
    nearStart(x, y, 10) ||
    oils.some((o) => Math.abs(x - o.x - 0.5) < 3 && Math.abs(y - o.y - 0.5) < 3) ||
    oreFields.some((f) => Math.hypot(x - f.x, y - f.y) < f.r + 2.5);

  // Trees: forest patches + scattered singles, symmetric
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (tiles[i] !== Tile.Grass || reserved(x, y)) continue;
      if (riverDist(x, y) < 4.5) continue;
      const n = symNoise(x, y, 0.07, SEED + 31);
      const single = (hash2(x, y, 3) + hash2(W - 1 - x, H - 1 - y, 3)) / 2;
      const kindSel = hash2(Math.min(x, W - 1 - x), Math.min(y, H - 1 - y) + (x < W - 1 - x ? 0 : 1000), 11);
      if (n > 0.64 || single > 0.93) trees[i] = kindSel < 0.6 ? 1 : 2;
    }
  }
  // Edge forest frame for looks
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const e = Math.min(x, y, W - 1 - x, H - 1 - y);
      if (e < 2 && tiles[i] === Tile.Grass && !reserved(x, y) && hash2(x, y, 5) < 0.55) trees[i] = 1 + (hash2(x, y, 6) < 0.5 ? 0 : 1);
    }
  }

  const { structures, blocked } = placeStructures(W, H, tiles, trees, ore, heights, starts, oils, oreFields, allRoads, mirror);

  const bridges = bridgeS.map((s) => {
    // bridge center lies on the river centerline at diagonal coordinate s
    const d = riverOffset(s);
    const x = s + d / Math.SQRT2;
    const y = s - d / Math.SQRT2;
    return { x: x + 0.5, y: y + 0.5, angle: -Math.PI / 4, length: 7.5 };
  });

  return {
    name: 'Frontline Crossing',
    w: W,
    h: H,
    tiles,
    heights,
    trees,
    ore,
    oreKind,
    oreMines: oreFields.map((f) => ({ x: Math.round(f.x), y: Math.round(f.y) })),
    starts,
    oils,
    bridges,
    roads: allRoads,
    structures,
    blocked,
  };
}

/**
 * Villages and farmsteads: a fixed layout for player 0's half, mirrored for
 * player 1. Every footprint is validated (open, flat ground away from bases,
 * ore, oil, roads and bridges) and a flood fill makes sure no structure cuts
 * off any part of the walkable map; anything that fails is simply skipped.
 */
function placeStructures(
  W: number,
  H: number,
  tiles: Uint8Array,
  trees: Uint8Array,
  ore: Uint8Array,
  heights: Float32Array,
  starts: Point[],
  oils: Point[],
  oreFields: (Point & { r: number })[],
  roads: Point[][],
  mirror: (p: Point) => Point,
) {
  const layout: Structure[] = [
    // village west of the centre bridge, around an east-west lane at y ~ 52.5
    { kind: StructureKind.House, x: 25, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.Cottage, x: 28, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.House, x: 32, y: 49, w: 2, h: 2, rot: 2 },
    { kind: StructureKind.House, x: 24, y: 55, w: 2, h: 2, rot: 0 },
    { kind: StructureKind.Cottage, x: 29, y: 55, w: 2, h: 2, rot: 0 },
    { kind: StructureKind.Tower, x: 35, y: 54, w: 1, h: 1, rot: 0 },
    { kind: StructureKind.WaterTower, x: 36, y: 50, w: 1, h: 1, rot: 0 },
    // farmstead in the southern fields
    { kind: StructureKind.House, x: 58, y: 88, w: 2, h: 2, rot: 3 },
    { kind: StructureKind.Barn, x: 62, y: 88, w: 3, h: 2, rot: 0 },
    { kind: StructureKind.Silo, x: 62, y: 86, w: 1, h: 1, rot: 0 },
    // roadside hamlet on the highway to the centre bridge
    { kind: StructureKind.Cottage, x: 48, y: 73, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.House, x: 52, y: 73, w: 2, h: 2, rot: 1 },
    { kind: StructureKind.Cottage, x: 49, y: 77, w: 2, h: 2, rot: 1 },
  ];
  const all = [
    ...layout,
    ...layout.map((st) => {
      const p = mirror({ x: st.x + st.w - 1, y: st.y + st.h - 1 });
      return { ...st, x: p.x, y: p.y, rot: (st.rot + 2) % 4 };
    }),
  ];
  const blocked = new Uint8Array(W * H);
  const structures: Structure[] = [];
  const vh = (vx: number, vy: number) => heights[vy * (W + 1) + vx];
  const roadDist = (x: number, y: number) => {
    let best = 1e9;
    for (const r of roads)
      for (let k = 0; k < r.length - 1; k++) best = Math.min(best, distToSegment(x, y, r[k].x + 0.5, r[k].y + 0.5, r[k + 1].x + 0.5, r[k + 1].y + 0.5));
    return best;
  };
  const okTile = (x: number, y: number) => {
    if (x < 2 || y < 2 || x >= W - 2 || y >= H - 2) return false;
    const i = y * W + x;
    if ((tiles[i] !== Tile.Grass && tiles[i] !== Tile.Dirt) || trees[i] || ore[i] || blocked[i]) return false;
    const cx = x + 0.5;
    const cy = y + 0.5;
    if (starts.some((s) => Math.hypot(cx - s.x, cy - s.y) < 16)) return false;
    if (oils.some((o) => Math.hypot(cx - o.x - 1, cy - o.y - 1) < 4.5)) return false;
    if (oreFields.some((f) => Math.hypot(cx - f.x, cy - f.y) < f.r + 2.2)) return false;
    if (roadDist(cx, cy) < 1.6) return false;
    const hs = [vh(x, y), vh(x + 1, y), vh(x, y + 1), vh(x + 1, y + 1)];
    if (Math.max(...hs) - Math.min(...hs) > 0.35) return false;
    return true;
  };
  // flood fill over walkable tiles, returns the reachable count from a start
  const reach = () => {
    const seen = new Uint8Array(W * H);
    const s0 = starts[0].y * W + starts[0].x;
    const q = [s0];
    seen[s0] = 1;
    let n = 0;
    while (q.length) {
      const t = q.pop()!;
      n++;
      const x = t % W;
      const y = (t / W) | 0;
      const nb = [x > 0 ? t - 1 : -1, x < W - 1 ? t + 1 : -1, y > 0 ? t - W : -1, y < H - 1 ? t + W : -1];
      for (const u of nb) {
        if (u < 0 || seen[u]) continue;
        if (tiles[u] === Tile.Water || tiles[u] === Tile.Rock || trees[u] || blocked[u]) continue;
        seen[u] = 1;
        q.push(u);
      }
    }
    return n;
  };
  let reachable = reach();
  for (const st of all) {
    let ok = true;
    // footprint plus a one tile walkable margin
    for (let y = st.y - 1; y <= st.y + st.h && ok; y++)
      for (let x = st.x - 1; x <= st.x + st.w && ok; x++) {
        const inside = x >= st.x && y >= st.y && x < st.x + st.w && y < st.y + st.h;
        if (inside ? !okTile(x, y) : x < 0 || y < 0 || x >= W || y >= H || blocked[y * W + x]) ok = false;
      }
    if (!ok) continue;
    for (let y = st.y; y < st.y + st.h; y++) for (let x = st.x; x < st.x + st.w; x++) blocked[y * W + x] = 1;
    const now = reach();
    if (now !== reachable - st.w * st.h) {
      for (let y = st.y; y < st.y + st.h; y++) for (let x = st.x; x < st.x + st.w; x++) blocked[y * W + x] = 0;
      continue;
    }
    reachable = now;
    structures.push(st);
  }
  return { structures, blocked };
}
