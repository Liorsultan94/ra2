import { Tile, type GameMap } from '../../../sim/map';
import type { SeaNightSpot } from '../../seaside';
import { Mode, type NightLamp } from './places';

/*
 * The seaside's night lights (NT1): the resorts' lit pools, bar, restaurant, palms and jetties, navigation lights on
 * the moored boats and the buoys. Pure functions of the spots the resort builder recorded (seaside.ts nightSpots,
 * boatSpots), so they can be tested without a GL context. Gentle by design: small warm points, soft pools.
 */

export interface BoatSpot {
  x: number;
  z: number;
  yaw: number;
  kind: number;
}

/** Hull sizes per kind (seaside.ts yachtGeometry / speedboatGeometry / dinghyGeometry): half length, half beam, light height, mast height. */
const HULL = [
  { len: 0.75, beam: 0.21, deck: 0.2, mast: 0.56 },
  { len: 0.31, beam: 0.11, deck: 0.1, mast: 0.18 },
  { len: 0.45, beam: 0.15, deck: 0.12, mast: 0.25 },
];

const lamp = (x: number, y: number, z: number, size: number, c: readonly [number, number, number], kind: string, pool = 0, mode: Mode = Mode.Steady, phase = 0): NightLamp => ({
  x,
  y,
  z,
  size,
  r: c[0],
  g: c[1],
  b: c[2],
  mode,
  phase,
  pool,
  kind,
  house: -1,
});

const WARM = [1.0, 0.66, 0.3] as const;
const AQUA = [0.1, 0.72, 0.95] as const;
const RED = [1.0, 0.16, 0.1] as const;
const GREEN = [0.12, 1.0, 0.36] as const;
const WHITE = [1.0, 0.95, 0.85] as const;
const AMBER = [1.0, 0.7, 0.26] as const;
const PALM = [0.62, 1.0, 0.5] as const;

/** The resort lights: pools, the restaurant's ring of bulbs, the beach bar, the palms' uplights, the jetty. */
export function planResorts(spots: readonly SeaNightSpot[]): NightLamp[] {
  const out: NightLamp[] = [];
  // every other palm is lit from below (a tiny warm-green point at its foot and a soft pool)
  let palmN = 0;
  for (const s of spots) {
    switch (s.kind) {
      case 'pool':
        // the lit pool: an aqua glow over the basin (a flat soft pool; no sprite)
        out.push(lamp(s.x, s.y, s.z, 0.01, AQUA, 'pool', s.r * 1.25, Mode.Steady, 0));
        out[out.length - 1].size = 0;
        break;
      case 'restaurant':
        // a ring of bulbs under the thatch's eaves and a warm pool on the terrace
        for (let i = 0; i < 8; i++) {
          const a = (i / 8) * Math.PI * 2;
          out.push(lamp(s.x + Math.cos(a) * 0.62, s.y + 0.42, s.z + Math.sin(a) * 0.62, 0.05, WARM, 'string', 0, Mode.Sign, i / 8));
        }
        out.push(lamp(s.x, s.y + 0.36, s.z, 0.1, WARM, 'restaurant', 1.9, Mode.Steady));
        break;
      case 'bar':
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2 + 0.3;
          out.push(lamp(s.x + Math.cos(a) * 0.4, s.y + 0.5, s.z + Math.sin(a) * 0.4, 0.05, AMBER, 'string', 0, Mode.Sign, i / 6));
        }
        out.push(lamp(s.x, s.y + 0.4, s.z, 0.11, WARM, 'bar', 1.7, Mode.Steady));
        break;
      case 'palm':
        if (palmN++ % 2 === 0) out.push(lamp(s.x, s.y + 0.03, s.z, 0.05, PALM, 'palm', 0.5, Mode.Steady));
        break;
      case 'jetty':
        // amber lamps along the jetty, a red and a green at its head
        if (s.r === 1) {
          const side = Math.sin(s.yaw);
          void side;
          out.push(lamp(s.x, s.y + 0.1, s.z, 0.07, WHITE, 'jetty', 0, Mode.Steady));
        } else out.push(lamp(s.x, s.y + 0.08, s.z, 0.05, AMBER, 'jetty', 0.45, Mode.Steady));
        break;
      case 'pontoon':
        // a red / green pair across the pontoon's head (seen from the sea: port red, starboard green)
        out.push(lamp(s.x - Math.sin(s.yaw) * 0.8, s.y, s.z + Math.cos(s.yaw) * 0.8, 0.07, RED, 'pontoon', 0, Mode.Steady));
        out.push(lamp(s.x + Math.sin(s.yaw) * 0.8, s.y, s.z - Math.cos(s.yaw) * 0.8, 0.07, GREEN, 'pontoon', 0, Mode.Steady));
        break;
      case 'buoy':
        out.push(lamp(s.x, s.y + 0.08, s.z, 0.1, s.r === 0 ? RED : GREEN, 'buoy', 0, Mode.Blink, (s.x * 0.37 + s.z * 0.11) % 1));
        break;
      default:
        break;
    }
  }
  return out;
}

/** Navigation lights of the moored boats: a white stern light, red / green sidelights at the bow, an anchor light on the mast. */
export function planBoats(boats: readonly BoatSpot[]): NightLamp[] {
  const out: NightLamp[] = [];
  for (const b of boats) {
    const H = HULL[b.kind] ?? HULL[1];
    // the hull's bow points along +x of its local frame, which the instance turns by -yaw: bow = (cos yaw, sin yaw) on the ground
    const fx = Math.cos(b.yaw);
    const fz = Math.sin(b.yaw);
    const rx = -fz;
    const rz = fx;
    const y = -0.25 + H.deck;
    const at = (a: number, s: number, up: number) => [b.x + fx * a + rx * s, y + up, b.z + fz * a + rz * s] as const;
    // sidelights (red to port, green to starboard) and the stern light
    const bow = H.len * 0.62;
    let p = at(bow, -H.beam * 0.85, 0.02);
    out.push(lamp(p[0], p[1], p[2], 0.055, RED, 'boat'));
    p = at(bow, H.beam * 0.85, 0.02);
    out.push(lamp(p[0], p[1], p[2], 0.055, GREEN, 'boat'));
    p = at(-H.len * 0.92, 0, 0.05);
    out.push(lamp(p[0], p[1], p[2], 0.05, WHITE, 'boat'));
    // the all-round anchor light at the masthead
    p = at(-H.len * 0.1, 0, H.mast - H.deck);
    out.push(lamp(p[0], p[1], p[2], 0.07, WHITE, 'boat'));
  }
  return out;
}

/**
 * The oil sites (the 2 x 2 derricks of GameMap.oils, centred on the footprint): a small gas flare burning on its
 * stack just outside the fence and a red mast light pulsing on the pumpjack's post. The stack's flame is a
 * flickering warm point (no particles), the pool it throws is soft.
 */
export function planOil(oils: readonly { x: number; y: number }[], groundAt: (x: number, z: number) => number, landAt: (x: number, z: number) => boolean = () => true): { lamps: NightLamp[]; stacks: { x: number; y: number; z: number; h: number }[] } {
  const lamps: NightLamp[] = [];
  const stacks: { x: number; y: number; z: number; h: number }[] = [];
  oils.forEach((o, i) => {
    const cx = o.x + 1;
    const cz = o.y + 1;
    // the flare stack: at a corner of the pad, on the first side that is dry land (alternating by site)
    const s0 = i % 2 === 0 ? 1.18 : -1.18;
    const spots: [number, number][] = [[s0, -1.05], [-s0, -1.05], [s0, 1.05], [-s0, 1.05], [0, -1.5], [0, 1.5]];
    const [ox, oz] = spots.find(([x, z]) => landAt(cx + x, cz + z) && landAt(cx + x * 1.2, cz + z * 1.2)) ?? spots[0];
    const fx = cx + ox;
    const fz = cz + oz;
    const gy = groundAt(fx, fz);
    stacks.push({ x: fx, y: gy, z: fz, h: 0.95 });
    lamps.push({ x: fx, y: gy + 0.99, z: fz, size: 0.2, r: 1.0, g: 0.52, b: 0.16, mode: Mode.Fire, phase: (i * 0.37) % 1, pool: 1.5, kind: 'flare', house: -1 });
    // the pumpjack's post carries a red mast light (the post stands at the pad's middle, 0.15 off centre)
    const py = groundAt(cx, cz);
    lamps.push({ x: cx, y: py + 0.8, z: cz + 0.15, size: 0.07, r: 1.0, g: 0.1, b: 0.06, mode: Mode.Pulse, phase: (i * 0.23) % 1, pool: 0, kind: 'derrick', house: -1 });
  });
  return { lamps, stacks };
}

/**
 * The heads of the gulfs (the water that lies farthest from the open sea, by flood fill through the water tiles
 * from the map's edge): where the harbours are. A pure function of the tiles.
 */
export function gulfHeads(m: GameMap): { x: number; y: number; d: number }[] {
  const W = m.w;
  const H = m.h;
  const water = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H && m.tiles[y * W + x] === Tile.Water;
  const dist = new Int32Array(W * H).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    const y = (i / W) | 0;
    if (water(x, y) && (x === 0 || y === 0 || x === W - 1 || y === H - 1)) {
      dist[i] = 0;
      q.push(i);
    }
  }
  for (let h = 0; h < q.length; h++) {
    const i = q[h];
    const x = i % W;
    const y = (i / W) | 0;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx;
      const ny = y + dy;
      if (!water(nx, ny) || dist[ny * W + nx] >= 0) continue;
      dist[ny * W + nx] = dist[i] + 1;
      q.push(ny * W + nx);
    }
  }
  let best = 0;
  for (let i = 0; i < W * H; i++) if (dist[i] > best) best = dist[i];
  const out: { x: number; y: number; d: number }[] = [];
  for (let i = 0; i < W * H; i++) {
    if (best < 40 || dist[i] < best * 0.55) continue;
    const x = i % W;
    const y = (i / W) | 0;
    let peak = true;
    for (let dy = -7; dy <= 7 && peak; dy++)
      for (let dx = -7; dx <= 7; dx++) {
        const nx = Math.min(W - 1, Math.max(0, x + dx));
        const ny = Math.min(H - 1, Math.max(0, y + dy));
        const d = dist[ny * W + nx];
        if (d > dist[i] || (d === dist[i] && (dy < 0 || (dy === 0 && dx < 0)))) {
          peak = false;
          break;
        }
      }
    if (peak) out.push({ x: x + 0.5, y: y + 0.5, d: dist[i] });
  }
  return out.sort((a, b) => b.d - a.d).slice(0, 4);
}

/**
 * Harbour lights at the gulfs' heads: on the shore nearest each head, a quay line of five amber lamps on poles, a
 * green and a red light marking the harbour mouth either side, and a white mast light in the middle (gentle small
 * points: nothing flares). The poles are returned to be drawn with the street lamps'.
 */
export function planHarbours(m: GameMap, groundAt: (x: number, z: number) => number): { lamps: NightLamp[]; posts: { x: number; y: number; z: number; h: number }[] } {
  const lamps: NightLamp[] = [];
  const posts: { x: number; y: number; z: number; h: number }[] = [];
  const W = m.w;
  const land = (x: number, z: number) => {
    const tx = Math.floor(x);
    const tz = Math.floor(z);
    if (tx < 2 || tz < 2 || tx >= m.w - 2 || tz >= m.h - 2) return false;
    const i = tz * W + tx;
    return m.tiles[i] !== Tile.Water && m.tiles[i] !== Tile.Rock && m.blocked[i] !== 1;
  };
  for (const head of gulfHeads(m)) {
    // which way the gulf runs from its head: towards the middle of the water tiles around it
    let wx = 0;
    let wz = 0;
    for (let dz = -9; dz <= 9; dz++)
      for (let dx = -9; dx <= 9; dx++) {
        const tx = Math.floor(head.x) + dx;
        const tz = Math.floor(head.y) + dz;
        if (tx >= 0 && tz >= 0 && tx < m.w && tz < m.h && m.tiles[tz * W + tx] === Tile.Water) {
          wx += tx + 0.5 - head.x;
          wz += tz + 0.5 - head.y;
        }
      }
    const wl = Math.hypot(wx, wz) || 1;
    const ax = wx / wl;
    const az = wz / wl;
    // across it
    const px = -az;
    const pz = ax;
    const place = (x: number, z: number, size: number, c: readonly [number, number, number], pool: number) => {
      if (!land(x, z)) return;
      const g = groundAt(x, z);
      posts.push({ x, y: g, z, h: 0.52 });
      lamps.push({ x, y: g + 0.54, z, size, r: c[0], g: c[1], b: c[2], mode: Mode.Steady, phase: 0, pool, kind: 'harbour', house: -1 });
    };
    // the quay: five amber lamps along the land end of the gulf's head (the middle one a white mast light)
    for (let i = -2; i <= 2; i++) place(head.x - ax * 2.6 + px * i * 1.15, head.y - az * 2.6 + pz * i * 1.15, i === 0 ? 0.12 : 0.1, i === 0 ? WHITE : AMBER, i === 0 ? 0 : 1.3);
    // the harbour mouth: red to port, green to starboard, on the banks a little way down the water
    place(head.x + ax * 5 - px * 3.1, head.y + az * 5 - pz * 3.1, 0.1, RED, 0);
    place(head.x + ax * 5 + px * 3.1, head.y + az * 5 + pz * 3.1, 0.1, GREEN, 0);
  }
  return { lamps, posts };
}
