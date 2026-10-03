import * as THREE from 'three';
import { buildingDef } from '../../sim/defs';
import { StructureKind, type GameMap } from '../../sim/map';
import type { World } from '../../sim/world';
import type { FogOfWar } from '../fog';
import { GeoBuilder } from '../geo';
import { type Layout, type V2 } from '../layout';
import { BlobShadows, CIV_SCALE, CivilianInstances, HIP_Y, Opt, Pose, ballGeometry, marketStall } from '../models/civilians';
import { planProps, type PropsManifest } from '../props';
import { roadClear } from './clearance';
import type { RoadNet } from './roadnet';
import { groundAt, wrapAngle, type AmbientFrame, type Danger, type FogProbe, type Quality } from './shared';
import { PathFinder, RES, WF, buildWalkGrid, cellOf, costAt, flagAt, sameRegion, zebraBands, type WalkGrid } from './walkgrid';

/*
 * Pedestrians: the civilians of the villages and the city.
 *
 * They walk the pavements, plazas, park paths and village lanes (walkgrid.ts:
 * roads are dear, so they keep to the pavement and cross on the zebras), go
 * in and out of the houses, sit on the benches the props layer placed, stand
 * about chatting in small groups, browse the market stalls (city squares and
 * a village square or two), and kids play ball in the parks and yards, or
 * walk hand in hand with a parent. Clothing follows the biome: robes and
 * keffiyehs in the desert, coats and hats in the snow, modern clothes in the
 * city, rural wear in the farming villages.
 *
 * War: gunfire, blasts and troops nearby frighten them. They throw their
 * hands up, then run for the nearest standing house or away to the map
 * edge, parents grabbing their children (small ones are carried, the others
 * pulled along by the hand); blasts knock people over (they get up and run).
 * The streets empty. After a long calm they slowly come back out.
 *
 * Purely visual. One instanced draw call for every figure (models/civilians.ts:
 * vertex-animated), one for the blob shadows, one for the market stalls, one
 * for the balls. Hard caps on what is drawn; nothing under the fog of war or
 * off screen; skipped when zoomed far out. No per-frame allocation.
 *
 * Other ambient systems hand in extra figures (shepherds, the caravan leader,
 * police officers, paramedics) through `figures`; traffic can ask
 * `crossingBusy(x, y, r)` whether someone is crossing the road there.
 */

const enum S {
  Walk = 0,
  Idle = 1,
  Chat = 2,
  Sit = 3,
  Inside = 4,
  Shop = 5,
  Vendor = 6,
  Play = 7,
  Alarm = 8,
  Flee = 9,
  Down = 10,
  Gone = 11,
  Fetch = 12,
  Follow = 13,
}

const enum Goal {
  None = 0,
  Stroll = 1,
  Door = 2,
  Bench = 3,
  Stall = 4,
  Chat = 5,
  Shelter = 6,
  Away = 7,
  Edge = 8,
  Kid = 9,
  Return = 10,
}

const enum K {
  Man = 0,
  Woman = 1,
  Kid = 2,
  Elder = 3,
}

/** An externally driven figure drawn with the civilians (shepherd, caravan leader, police, paramedics). */
export interface Figure {
  x: number;
  y: number;
  yaw: number;
  /** Ground height (world y). */
  hgt: number;
  size: number;
  phase: number;
  stride: number;
  pose: number;
  mask: number;
  lean: number;
  skin: THREE.Color;
  top: THREE.Color;
  bot: THREE.Color;
  hat: THREE.Color;
  show: boolean;
}

interface Ped extends Figure {
  id: number;
  kind: K;
  s: S;
  t: number;
  v: number;
  speed: number;
  run: number;
  path: Float32Array;
  np: number;
  pi: number;
  goal: Goal;
  gi: number;
  gx: number;
  gy: number;
  gyaw: number;
  /** Home area (villages): destinations stay within `roam` of it. */
  hx: number;
  hy: number;
  roam: number;
  parent: Ped | null;
  child: Ped | null;
  /** Lateral offset while walking (lanes on a pavement). */
  side: number;
  onRoad: boolean;
  fall: number;
  fallT: number;
  door: number;
  stuck: number;
  scareT: number;
  fx: number;
  fy: number;
  unitT: number;
  lastPath: number;
  seat: number;
  vendor: boolean;
  play: number;
  ang: number;
  baseLean: number;
  rescuer: Ped | null;
}

interface Door {
  x: number;
  y: number;
  /** Facing out of the door. */
  yaw: number;
  ent: number;
  alive: boolean;
  urbanShop: boolean;
}

interface Seat {
  x: number;
  y: number;
  yaw: number;
  taken: Ped | null;
}

interface Stall {
  x: number;
  y: number;
  /** Front (customers' side) direction. */
  yaw: number;
  vendor: Ped | null;
}

interface Spot {
  x: number;
  y: number;
}

interface ChatGroup {
  x: number;
  y: number;
  n: number;
  members: Ped[];
}

interface PlayGroup {
  x: number;
  y: number;
  r: number;
  kids: Ped[];
  bx: number;
  by: number;
  bvx: number;
  bvy: number;
  bz: number;
  bvz: number;
  kickT: number;
  spin: number;
}

const C = (h: number) => new THREE.Color(h);
const pal = (a: number[]) => a.map(C);

interface Wardrobe {
  skin: THREE.Color[];
  manTop: THREE.Color[];
  manBot: THREE.Color[];
  womanTop: THREE.Color[];
  womanBot: THREE.Color[];
  kidTop: THREE.Color[];
  hair: THREE.Color[];
  hat: THREE.Color[];
}

const HAIR = pal([0x1a1410, 0x2a1d14, 0x3b2a1c, 0x5a3c22, 0x8a6a3a, 0x16120f, 0x6b4a2a]);
const GREY = pal([0x9a968e, 0xc4c0b8, 0x7d7a74, 0xdedad2]);
const WARDROBES: Record<string, Wardrobe> = {
  urban: {
    skin: pal([0xe8c4a8, 0xd6a688, 0xc08a68, 0x9a6a4a, 0x6e4a32, 0xf0d0b8, 0x4a3022]),
    manTop: pal([0x2a3a5a, 0xe6e6e2, 0x8a1c1c, 0x3a5a3a, 0x1c1c1e, 0xb0b4ba, 0x2a6a9a, 0xd8a030, 0x5a3a6a, 0x6a6a6e]),
    manBot: pal([0x2a3448, 0x1e2230, 0x3a3a3c, 0x7a6a50, 0x23272e, 0x4a5262]),
    womanTop: pal([0xc02a4a, 0xe8e2d4, 0x2a7a8a, 0xd87a2a, 0x7a3a8a, 0x1c1c22, 0xe0b0c0, 0x4a8a4a, 0xf0d040]),
    womanBot: pal([0x1c1c22, 0x2a3448, 0x6a2a3a, 0x3a4a6a, 0xa08a6a, 0x5a5a62]),
    kidTop: pal([0xe03a3a, 0x3a7ae0, 0xf0c020, 0x3ab04a, 0xe060a0, 0xf08020, 0x40c0d0]),
    hair: HAIR,
    hat: pal([0x1c1c22, 0xa02020, 0x2a4a8a, 0xe8e2d4, 0x3a5a3a]),
  },
  temperate: {
    skin: pal([0xe8c4a8, 0xdcb090, 0xf0d0b8, 0xc8987a, 0xe0b898]),
    manTop: pal([0x5a4a32, 0x3a4a2a, 0x7a3a2a, 0x4a5a6a, 0x8a7a5a, 0x2a3a4a, 0x9a8a6a, 0x6a2a2a]),
    manBot: pal([0x3a3428, 0x2a3040, 0x4a4030, 0x5a5040, 0x30302a]),
    womanTop: pal([0x8a2a3a, 0x3a5a7a, 0xd8c8a8, 0x5a7a4a, 0x9a6a3a, 0x6a4a7a, 0xc89a6a]),
    womanBot: pal([0x3a2a2a, 0x2a3448, 0x5a4a3a, 0x4a5a3a, 0x6a2a2a]),
    kidTop: pal([0xc03a3a, 0x3a6ab0, 0xd8b030, 0x4a9a4a, 0xa05a9a]),
    hair: HAIR,
    hat: pal([0x4a3a2a, 0x3a3a3a, 0x6a5a40, 0x2a2a30, 0x8a6a4a]),
  },
  desert: {
    skin: pal([0xc89a72, 0xb08058, 0x9a6a48, 0xd8aa82, 0x8a5a3a]),
    manTop: pal([0xf0ece2, 0xe6dcc8, 0xd8ccb0, 0xb8a888, 0x8a7a62, 0x6a6a6e, 0xe8e4dc]),
    manBot: pal([0xe6dcc8, 0xc8bca0, 0x8a7a62]),
    womanTop: pal([0x1c1a1c, 0x2a2228, 0x3a2a3a, 0x4a3a30, 0x2a2a3a, 0x6a3a2a]),
    womanBot: pal([0x1c1a1c, 0x2a2228, 0x3a2a3a]),
    kidTop: pal([0xe8e2d4, 0xc05a3a, 0x3a7ab0, 0xd8b040, 0x6a9a4a]),
    hair: HAIR,
    hat: pal([0xd04040, 0xf0ece4, 0xe8e2d8, 0xb03030, 0x2a2a2a]),
  },
  winter: {
    skin: pal([0xf0d0b8, 0xe8c4a8, 0xdcb090, 0xf4dcc8]),
    manTop: pal([0x2a2e36, 0x5a3a2a, 0x3a4a3a, 0x6a2a2a, 0x2a3a5a, 0x4a4a4e, 0x7a6a50]),
    manBot: pal([0x2a2a30, 0x1e2230, 0x3a3428]),
    womanTop: pal([0x8a2a3a, 0x2a4a6a, 0xc8b8a0, 0x5a3a5a, 0x3a5a4a, 0xa04a2a]),
    womanBot: pal([0x1c1c22, 0x2a2a34, 0x3a2a2a]),
    kidTop: pal([0xd03030, 0x3060c0, 0xe0b020, 0x30a040, 0xe06090]),
    hair: HAIR,
    hat: pal([0xa02020, 0x2a4a8a, 0xe8e2d4, 0x3a5a3a, 0x2a2a30, 0xd0a020, 0x6a3a6a]),
  },
};

const MAX_PATH = 48;
const DWELL: Partial<Record<StructureKind, number>> = {
  [StructureKind.House]: 1,
  [StructureKind.Cottage]: 1,
  [StructureKind.Barn]: 1,
  [StructureKind.MudHouse]: 1,
  [StructureKind.Courtyard]: 1,
  [StructureKind.Apartment]: 1,
  [StructureKind.Block]: 1,
  [StructureKind.Office]: 1,
  [StructureKind.Shop]: 2,
  [StructureKind.Townhouse]: 1,
};

const _m = new THREE.Matrix4();
const _r = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** The live pedestrian system (traffic asks it through crossingBusy). */
let active: People | null = null;

/**
 * Is anyone crossing the road within `r` tiles of (x, y)? (Walkers on the
 * paved road surface; cars can stop for them at the zebras.)
 */
export function crossingBusy(x: number, y: number, r: number): boolean {
  return active ? active.crossingBusy(x, y, r) : false;
}

export class People {
  readonly group = new THREE.Group();
  /** Extra figures drawn with the civilians (filled in by other ambient systems). */
  readonly figures: Figure[] = [];
  /** Footprints of the players' buildings (tile resolution; civilian houses are in the walk grid already). */
  private busy: Uint8Array;
  private peds: Ped[] = [];
  private grid: WalkGrid;
  private pf: PathFinder;
  private doors: Door[] = [];
  private seats: Seat[] = [];
  private stalls: Stall[] = [];
  private spots: Spot[] = [];
  private plays: PlayGroup[] = [];
  private chats: ChatGroup[] = [];
  private inst: CivilianInstances;
  private shadows: BlobShadows;
  private balls: THREE.InstancedMesh;
  private heat: Float32Array;
  private hw: number;
  private time = 0;
  private pathBudget = 0;
  private panicBudget = 0;
  private wardrobe: Wardrobe;
  private cap: number;
  private blockedFn: (tx: number, ty: number) => boolean;
  private nextId = 1;
  private frameNo = 0;
  private houseEnt = new Map<number, number[]>();
  private dark = 0;
  /** Debug / tests: counters. */
  readonly stat = { paths: 0, failed: 0, fled: 0, returned: 0 };

  constructor(
    private map: GameMap,
    private layout: Layout,
    private world: World,
    net: RoadNet | null,
    private fog: FogOfWar,
    private probe: FogProbe,
    private quality: Quality,
    phone: boolean,
  ) {
    const m = map;
    const urban = m.biome === 'urban';
    this.wardrobe = WARDROBES[m.biome] ?? WARDROBES.temperate;
    this.grid = buildWalkGrid(m, layout, net, zebraBands(m, layout, net));
    this.pf = new PathFinder(this.grid, phone ? 6000 : 9000);
    this.hw = Math.ceil(m.w / 4);
    this.heat = new Float32Array(this.hw * Math.ceil(m.h / 4)).fill(-1e9);
    this.busy = new Uint8Array(m.w * m.h);
    this.scanBuildings();
    this.blockedFn = (tx, ty) => this.busy[ty * this.map.w + tx] === 1;
    this.group.name = 'ambient-people';
    // ---- budgets
    const qk = quality === 'high' ? 1.7 : quality === 'medium' ? 1 : 0.22;
    const pk = phone ? 0.8 : 1;
    let pop = Math.round((urban ? 72 : 40) * qk * pk);
    this.cap = quality === 'high' ? 140 : quality === 'medium' ? 60 : 16;
    if (phone) this.cap = Math.min(this.cap, 60);
    // ---- places
    this.findDoors();
    this.findSpots();
    const markets = quality !== 'low' ? this.placeMarkets() : null;
    const capInst = Math.max(8, Math.min(this.cap + 16, pop + 24));
    this.inst = new CivilianInstances(fog, capInst);
    this.shadows = new BlobShadows(capInst, 0.38);
    const ballMat = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
    fog.apply(ballMat);
    this.balls = new THREE.InstancedMesh(ballGeometry(), ballMat, 8);
    this.balls.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.balls.frustumCulled = false;
    this.balls.count = 0;
    this.balls.name = 'ambient-balls';
    this.group.add(this.inst.mesh, this.shadows.mesh, this.balls);
    if (markets) this.group.add(markets);
    if (!this.spots.length && !this.doors.length) pop = 0;
    // ---- people
    this.populate(pop, quality !== 'low');
    // benches come from the props plan (needs the props manifest)
    if (urban && quality !== 'low') void this.loadBenches();
    active = this;
  }

  dispose() {
    if (active === this) active = null;
  }

  get count() {
    let n = 0;
    for (const p of this.peds) if (p.s !== S.Inside && p.s !== S.Gone) n++;
    return n;
  }

  // ------------------------------------------------------------------ places

  private scanBuildings() {
    const b = this.busy;
    const W = this.map.w;
    b.fill(0);
    for (const e of this.world.entities.values()) {
      if (e.kind !== 'building' || e.dead) continue;
      const d = buildingDef(e.def);
      if (!d || d.role === 'civilian') continue;
      for (let y = Math.max(0, e.ty); y < Math.min(this.map.h, e.ty + d.h); y++) for (let x = Math.max(0, e.tx); x < Math.min(W, e.tx + d.w); x++) b[y * W + x] = 1;
    }
  }

  private passable(x: number, y: number) {
    return costAt(this.grid, x, y) > 0 && !this.blockedFn(x | 0, y | 0);
  }

  /** May p step onto (x, y)? Calm walkers keep off the road except on the zebras (or to get off it). */
  private canStep(p: Ped, x: number, y: number) {
    if (!this.passable(x, y)) return false;
    if (p.s === S.Flee || p.s === S.Fetch || p.s === S.Alarm || p.s === S.Down) return true;
    const f = flagAt(this.grid, x, y);
    if ((f & (WF.Road | WF.Zebra)) !== WF.Road) return true;
    return (flagAt(this.grid, p.x, p.y) & (WF.Road | WF.Zebra)) === WF.Road;
  }

  /** Nearest cheap (pavement-like) cell within r of (x, y). */
  private snap(x: number, y: number, r: number, maxCost = 2): V2 | null {
    let best: V2 | null = null;
    let bd = 1e9;
    const st = 1 / RES;
    for (let dy = -r; dy <= r; dy += st)
      for (let dx = -r; dx <= r; dx += st) {
        const px = x + dx;
        const py = y + dy;
        const c = costAt(this.grid, px, py);
        if (!c || c > maxCost || flagAt(this.grid, px, py) & (WF.Road | WF.Base)) continue;
        const d = dx * dx + dy * dy;
        if (d < bd) {
          bd = d;
          best = { x: Math.floor(px * RES) / RES + 0.5 / RES, y: Math.floor(py * RES) / RES + 0.5 / RES };
        }
      }
    return best;
  }

  private findDoors() {
    const m = this.map;
    const ents: { id: number; tx: number; ty: number }[] = [];
    for (const e of this.world.entities.values()) if (e.kind === 'building' && !e.dead && buildingDef(e.def)?.role === 'civilian') ents.push({ id: e.id, tx: e.tx, ty: e.ty });
    for (const st of m.structures) {
      if (!DWELL[st.kind]) continue;
      const cx = st.x + st.w / 2;
      const cy = st.y + st.h / 2;
      const dirs = [
        [0, 1],
        [1, 0],
        [0, -1],
        [-1, 0],
      ];
      const [dx, dy] = dirs[st.rot & 3];
      const ox = cx + dx * (st.w / 2 + 0.2);
      const oy = cy + dy * (st.h / 2 + 0.2);
      const p = this.snap(ox, oy, 0.7, 2);
      if (!p) continue;
      const e = ents.find((q) => q.tx === st.x && q.ty === st.y);
      const di = this.doors.length;
      this.doors.push({ x: p.x, y: p.y, yaw: Math.atan2(dy, dx), ent: e ? e.id : -1, alive: true, urbanShop: st.kind === StructureKind.Shop });
      if (e) {
        let l = this.houseEnt.get(e.id);
        if (!l) this.houseEnt.set(e.id, (l = []));
        l.push(di);
      }
    }
  }

  /** Stroll / chat / play spots: plazas, park lawns, pavements, village lanes near the houses. */
  private findSpots() {
    const m = this.map;
    const g = this.grid;
    const urban = m.biome === 'urban';
    const near = (x: number, y: number, r: number) => this.doors.some((d) => Math.abs(d.x - x) < r && Math.abs(d.y - y) < r);
    let seed = 7;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let k = 0; k < 6000 && this.spots.length < (urban ? 420 : 220); k++) {
      const x = 1 + rnd() * (m.w - 2);
      const y = 1 + rnd() * (m.h - 2);
      const c = costAt(g, x, y);
      const f = flagAt(g, x, y);
      if (!c || c > 2 || f & (WF.Road | WF.Base | WF.Field | WF.Edge)) continue;
      if (!urban && !near(x, y, 6)) continue;
      if (urban && !(f & (WF.Plaza | WF.Park)) && !near(x, y, 3.5)) continue;
      const p = this.snap(x, y, 0.3, 2);
      if (p) this.spots.push(p);
    }
  }

  private async loadBenches() {
    try {
      if (typeof fetch === 'undefined') return;
      const res = await fetch('props/props.json');
      if (!res.ok) return;
      const man = (await res.json()) as PropsManifest;
      const plan = planProps(this.map, this.layout, this.quality, man);
      for (const b of plan.get('bench') ?? []) {
        // the sitter faces the bench's front: (sin rot, cos rot)
        const fx = Math.sin(b.rot);
        const fy = Math.cos(b.rot);
        const yaw = Math.atan2(fy, fx);
        for (const s of [-0.15, 0.15]) this.seats.push({ x: b.x - fy * s - fx * 0.025, y: b.z + fx * s - fy * 0.025, yaw, taken: null });
      }
      // a few sitting already
      for (const p of this.peds) if (p.s === S.Idle && p.kind !== K.Kid && !p.child && Math.random() < 0.35) this.goBench(p, 30);
    } catch {
      /* no benches */
    }
  }

  /** Market stalls in the city squares and the biggest village squares (one static mesh). */
  private placeMarkets(): THREE.Mesh | null {
    const m = this.map;
    const g = this.grid;
    const urban = m.biome === 'urban';
    const sites: { x: number; y: number; along: number; n: number }[] = [];
    const free = (x: number, y: number, hx: number, hy: number) => {
      for (let yy = y - hy; yy <= y + hy; yy += 0.25)
        for (let xx = x - hx; xx <= x + hx; xx += 0.25) {
          const c = costAt(g, xx, yy);
          if (!c || c > 2 || flagAt(g, xx, yy) & (WF.Road | WF.Base | WF.Field | WF.Zebra)) return false;
          if (this.blockedFn(xx | 0, yy | 0)) return false;
        }
      return roadClear(m, x, y, Math.max(hx, hy) + 0.2);
    };
    if (urban) {
      for (const f of this.layout.fields) {
        if (f.type !== 4) continue;
        if (m.starts.some((s) => Math.hypot(s.x - f.cx, s.y - f.cy) < 16)) continue;
        // two rows of stalls facing each other across a lane in the middle of the square
        for (const s of [-1, 1]) {
          const y = f.cy + s * 1.4;
          if (free(f.cx, y, 1.3, 0.3)) sites.push({ x: f.cx, y, along: 0, n: 3 });
        }
      }
    } else {
      // village squares: open ground near the middle of the biggest clusters of houses
      const cl: { x: number; y: number; n: number }[] = [];
      for (const d of this.doors) {
        const c = cl.find((q) => Math.hypot(q.x / q.n - d.x, q.y / q.n - d.y) < 6);
        if (c) {
          c.x += d.x;
          c.y += d.y;
          c.n++;
        } else cl.push({ x: d.x, y: d.y, n: 1 });
      }
      cl.sort((a, b) => b.n - a.n);
      for (const c of cl.slice(0, 2)) {
        if (c.n < 3) continue;
        const cx = c.x / c.n;
        const cy = c.y / c.n;
        let done = false;
        for (let r = 0; r < 5 && !done; r += 0.5)
          for (let a = 0; a < 16 && !done; a++) {
            const x = cx + Math.cos((a / 16) * Math.PI * 2) * r;
            const y = cy + Math.sin((a / 16) * Math.PI * 2) * r;
            for (const along of [0, 1]) {
              if (done) break;
              const hx = along ? 0.35 : 1.2;
              const hy = along ? 1.2 : 0.35;
              if (free(x, y, hx + 0.35, hy + 0.35)) {
                sites.push({ x, y, along, n: 3 });
                done = true;
              }
            }
          }
      }
    }
    if (!sites.length) return null;
    const b = new GeoBuilder();
    const awnings = pal([0xb02a2a, 0x2a6aa0, 0x3a8a3a, 0xd89a20, 0x8a3a8a, 0xc05a20]);
    let k = 0;
    const len = 2.4 * CIV_SCALE;
    for (const s of sites) {
      for (let i = 0; i < s.n; i++) {
        const off = (i - (s.n - 1) / 2) * (len + 0.06);
        const x = s.x + (s.along ? 0 : off);
        const y = s.y + (s.along ? off : 0);
        // urban rows face the lane between them; village rows face the open side (towards the centre of the map)
        let fx = s.along ? 1 : 0;
        let fy = s.along ? 0 : 1;
        if (urban) {
          const sgn = Math.sign(this.layout.fields.find((f) => f.type === 4 && Math.abs(f.cx - s.x) < 0.1 && Math.abs(f.cy - s.y) < 3)!.cy - s.y) || 1;
          fx = 0;
          fy = sgn;
        } else if ((s.along ? m.w / 2 - x : m.h / 2 - y) < 0) {
          fx = -fx;
          fy = -fy;
        }
        const yaw = Math.atan2(fy, fx);
        const h = groundAt(m, x, y);
        _e.set(0, -yaw, 0, 'YXZ');
        _q.setFromEuler(_e);
        _m.compose(_p.set(x, h, y), _q, _s.set(1, 1, 1));
        marketStall(b, _m, awnings[k % awnings.length], k);
        this.stalls.push({ x, y, yaw, vendor: null });
        k++;
        // close the footprint to walkers
        const hx = (1.3 * CIV_SCALE) / 2 + 0.06;
        const hz = len / 2;
        for (let yy = -hz; yy <= hz; yy += 0.125)
          for (let xx = -hx; xx <= hx; xx += 0.125) {
            const c = cellOf(g, x + fx * xx - fy * yy, y + fy * xx + fx * yy);
            if (c >= 0) g.cost[c] = 0;
          }
      }
    }
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 });
    const geo = b.build(false);
    const mesh = new THREE.Mesh(geo, this.fog.apply(mat));
    mesh.name = 'ambient-market';
    mesh.castShadow = this.quality === 'high';
    mesh.receiveShadow = true;
    return mesh;
  }


  // ------------------------------------------------------------------ people

  private dress(kind: K, p: Ped) {
    const w = this.wardrobe;
    const pick = <T>(a: T[]) => a[(Math.random() * a.length) | 0];
    const biome = this.map.biome;
    const tone = 0.9 + Math.random() * 0.2;
    p.skin.copy(pick(w.skin));
    p.hat.copy(kind === K.Elder ? pick(GREY) : pick(w.hair));
    let mask = 0;
    if (kind === K.Kid) {
      p.top.copy(pick(w.kidTop)).multiplyScalar(tone);
      p.bot.copy(pick(w.manBot));
      if (Math.random() < 0.5) mask |= Opt.LongHair;
      if (biome === 'urban' && Math.random() < 0.35) mask |= Opt.Backpack;
      if (biome === 'winter') {
        mask |= Opt.Coat | (Math.random() < 0.8 ? Opt.Beanie : 0);
        if (mask & Opt.Beanie) p.hat.copy(pick(w.hat));
      }
      if (biome === 'desert' && Math.random() < 0.4) {
        mask |= Opt.Robe;
        p.top.copy(pick(w.manTop));
      }
    } else if (kind === K.Woman || (kind === K.Elder && Math.random() < 0.5)) {
      p.top.copy(pick(w.womanTop)).multiplyScalar(tone);
      p.bot.copy(pick(w.womanBot));
      mask |= Opt.LongHair;
      if (biome === 'desert') {
        mask |= Opt.Robe | Opt.Headscarf;
        p.hat.copy(pick(w.womanTop)).multiplyScalar(0.9);
      } else if (biome === 'winter') {
        mask |= Opt.Coat | (Math.random() < 0.6 ? Opt.Beanie : Opt.Headscarf);
        p.hat.copy(pick(w.hat));
        if (Math.random() < 0.5) mask |= Opt.Skirt;
      } else {
        if (Math.random() < (biome === 'urban' ? 0.4 : 0.65)) mask |= Opt.Skirt;
        if (biome === 'temperate' && Math.random() < 0.3) {
          mask |= Opt.Headscarf;
          p.hat.copy(pick(w.hat));
        }
        if (biome === 'urban' && Math.random() < 0.35) mask |= Opt.Bag;
      }
      if (kind === K.Elder) p.hat.copy(pick(GREY));
    } else {
      p.top.copy(pick(w.manTop)).multiplyScalar(tone);
      p.bot.copy(pick(w.manBot));
      if (biome === 'desert') {
        if (Math.random() < 0.8) {
          mask |= Opt.Robe;
          p.bot.copy(p.top);
        }
        if (Math.random() < 0.75) {
          mask |= Opt.Keffiyeh;
          p.hat.copy(pick(w.hat));
        }
      } else if (biome === 'winter') {
        mask |= Opt.Coat | (Math.random() < 0.75 ? Opt.Beanie : Opt.Cap);
        p.hat.copy(pick(w.hat));
      } else if (biome === 'temperate') {
        if (Math.random() < 0.45) {
          mask |= Math.random() < 0.5 ? Opt.Cap : Opt.BrimHat;
          p.hat.copy(pick(w.hat));
        }
      } else {
        if (Math.random() < 0.18) {
          mask |= Opt.Cap;
          p.hat.copy(pick(w.hat));
        }
        if (Math.random() < 0.2) mask |= Opt.Backpack;
        if (Math.random() < 0.1) mask |= Opt.Bag;
      }
    }
    if (kind === K.Elder) {
      if (Math.random() < 0.45) mask |= Opt.Cane;
      if (biome !== 'desert' && Math.random() < 0.5) mask |= Opt.Coat;
    }
    p.mask = mask;
  }

  private makePed(kind: K, x: number, y: number): Ped {
    const size = kind === K.Kid ? 0.55 + Math.random() * 0.17 : kind === K.Elder ? 0.92 + Math.random() * 0.06 : kind === K.Woman ? 0.93 + Math.random() * 0.06 : 0.98 + Math.random() * 0.07;
    const p: Ped = {
      id: this.nextId++,
      kind,
      x,
      y,
      yaw: Math.random() * 6.28,
      hgt: groundAt(this.map, x, y),
      size,
      phase: Math.random() * 6.28,
      stride: 0,
      pose: Pose.Walk,
      mask: 0,
      lean: 0,
      skin: new THREE.Color(),
      top: new THREE.Color(),
      bot: new THREE.Color(),
      hat: new THREE.Color(),
      show: true,
      s: S.Idle,
      t: Math.random() * 4,
      v: 0,
      speed: kind === K.Elder ? 0.2 + Math.random() * 0.05 : kind === K.Kid ? 0.32 + Math.random() * 0.06 : 0.3 + Math.random() * 0.08,
      run: kind === K.Elder ? 0.55 : kind === K.Kid ? 0.85 : 0.95 + Math.random() * 0.2,
      path: new Float32Array(MAX_PATH * 2),
      np: 0,
      pi: 0,
      goal: Goal.None,
      gi: -1,
      gx: x,
      gy: y,
      gyaw: 0,
      hx: x,
      hy: y,
      roam: this.map.biome === 'urban' ? 14 : 8,
      parent: null,
      child: null,
      side: (Math.random() - 0.5) * 0.12,
      onRoad: false,
      fall: 0,
      fallT: 0,
      door: -1,
      stuck: 0,
      scareT: -1e9,
      fx: 0,
      fy: 0,
      unitT: Math.random() * 0.5,
      lastPath: -1e9,
      seat: -1,
      vendor: false,
      play: -1,
      ang: Math.random() * 6.28,
      baseLean: kind === K.Elder ? 0.22 + Math.random() * 0.1 : 0,
      rescuer: null,
    };
    this.dress(kind, p);
    this.peds.push(p);
    return p;
  }

  private randomKind(): K {
    const r = Math.random();
    return r < 0.42 ? K.Man : r < 0.82 ? K.Woman : K.Elder;
  }

  private populate(pop: number, rich: boolean) {
    const m = this.map;
    let left = pop;
    // vendors
    for (const st of this.stalls) {
      if (left <= 0) break;
      const p = this.makePed(Math.random() < 0.6 ? K.Man : K.Woman, st.x - Math.cos(st.yaw) * 0.25, st.y - Math.sin(st.yaw) * 0.25);
      p.s = S.Vendor;
      p.vendor = true;
      p.yaw = st.yaw;
      st.vendor = p;
      left--;
    }
    // a crowd at the market
    for (const st of this.stalls) {
      if (left <= 0) break;
      if (Math.random() < 0.3) continue;
      const fx = Math.cos(st.yaw);
      const fy = Math.sin(st.yaw);
      const lat = (Math.random() - 0.5) * 0.4;
      const p = this.makePed(this.randomKind(), st.x + fx * 0.34 - fy * lat, st.y + fy * 0.34 + fx * lat);
      p.s = S.Shop;
      p.t = 3 + Math.random() * 15;
      p.yaw = wrapAngle(st.yaw + Math.PI);
      left--;
    }
    // kids at play: park lawns (city), yards (villages)
    if (rich && this.spots.length) {
      const nGroups = Math.max(1, Math.round(pop / (m.biome === 'urban' ? 22 : 16)));
      for (let gi = 0; gi < nGroups && left > 2; gi++) {
        let sp: Spot | null = null;
        for (let k = 0; k < 30 && !sp; k++) {
          const c = this.spots[(Math.random() * this.spots.length) | 0];
          // room to run around
          let ok = true;
          for (let a = 0; a < 8 && ok; a++) ok = costAt(this.grid, c.x + Math.cos(a * 0.785) * 0.9, c.y + Math.sin(a * 0.785) * 0.9) > 0 && !(flagAt(this.grid, c.x + Math.cos(a * 0.785) * 0.9, c.y + Math.sin(a * 0.785) * 0.9) & WF.Road);
          const park = flagAt(this.grid, c.x, c.y) & (WF.Park | WF.Plaza);
          if (ok && (m.biome !== 'urban' || park)) sp = c;
        }
        if (!sp) continue;
        const pg: PlayGroup = { x: sp.x, y: sp.y, r: 0.75, kids: [], bx: sp.x, by: sp.y, bvx: 0, bvy: 0, bz: 0, bvz: 0, kickT: 1, spin: Math.random() < 0.5 ? 1 : -1 };
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n && left > 0; i++, left--) {
          const a = (i / n) * Math.PI * 2;
          const k = this.makePed(K.Kid, sp.x + Math.cos(a) * 0.5, sp.y + Math.sin(a) * 0.5);
          k.s = S.Play;
          k.play = this.plays.length;
          k.ang = a;
          pg.kids.push(k);
        }
        this.plays.push(pg);
      }
    }
    // everyone else: at doors, on the spots, some already inside
    const starts = [...this.spots];
    while (left > 0 && (starts.length || this.doors.length)) {
      const kind = this.randomKind();
      let x: number;
      let y: number;
      if (this.doors.length && (Math.random() < 0.3 || !starts.length)) {
        const d = this.doors[(Math.random() * this.doors.length) | 0];
        x = d.x;
        y = d.y;
      } else {
        const s = starts[(Math.random() * starts.length) | 0];
        x = s.x;
        y = s.y;
      }
      const p = this.makePed(kind, x, y);
      p.hx = x;
      p.hy = y;
      left--;
      // a child walking with a parent
      if (rich && kind !== K.Elder && left > 0 && Math.random() < 0.16) {
        const k = this.makePed(K.Kid, x + 0.15, y);
        k.size = 0.48 + Math.random() * 0.14;
        k.s = S.Follow;
        k.parent = p;
        p.child = k;
        left--;
      }
      const r = Math.random();
      if (r < 0.15 && this.doors.length) {
        this.enterNearestDoor(p, Math.random() * 25);
      } else {
        p.s = S.Idle;
        p.t = Math.random() * 3;
      }
    }
    // a few chat groups to begin with
    for (const p of this.peds) if (p.s === S.Idle && p.kind !== K.Kid && Math.random() < 0.25) this.goChat(p, true);
  }

  private enterNearestDoor(p: Ped, dur: number) {
    let best = -1;
    let bd = 1e9;
    for (let i = 0; i < this.doors.length; i++) {
      const d = this.doors[i];
      if (!d.alive) continue;
      const dd = Math.hypot(d.x - p.x, d.y - p.y);
      if (dd < bd) {
        bd = dd;
        best = i;
      }
    }
    if (best < 0) return;
    const d = this.doors[best];
    p.x = d.x;
    p.y = d.y;
    p.door = best;
    this.hide(p, dur);
  }

  private hide(p: Ped, dur: number) {
    p.s = S.Inside;
    p.t = dur;
    p.np = 0;
    p.v = 0;
    this.leaveGroups(p);
    if (p.child) {
      p.child.s = S.Inside;
      p.child.x = p.x;
      p.child.y = p.y;
    }
  }

  // ------------------------------------------------------------------ plans

  private setPath(p: Ped, x: number, y: number, panic: boolean): boolean {
    // (a calm walker on the pavement can't reach the far side of a road without a zebra)
    if (!panic && (flagAt(this.grid, p.x, p.y) & (WF.Road | WF.Zebra)) !== WF.Road && !sameRegion(this.grid, p.x, p.y, x, y)) return false;
    if (panic ? this.panicBudget <= 0 : this.pathBudget <= 0) return false;
    if (panic) this.panicBudget--;
    else this.pathBudget--;
    this.stat.paths++;
    p.lastPath = this.time;
    const n = this.pf.find(p.x, p.y, x, y, p.path, panic, this.blockedFn);
    if (!n) {
      this.stat.failed++;
      return false;
    }
    p.np = n;
    p.pi = 0;
    p.gx = x;
    p.gy = y;
    p.stuck = 0;
    return true;
  }

  private walkTo(p: Ped, x: number, y: number, goal: Goal, gi = -1): boolean {
    if (!this.setPath(p, x, y, false)) return false;
    p.s = S.Walk;
    p.goal = goal;
    p.gi = gi;
    p.t = 0;
    return true;
  }

  /** Pick something to do next. */
  private plan(p: Ped) {
    if (p.kind === K.Kid && p.parent) return;
    const night = this.dark > 0.6;
    const r = Math.random();
    if (r < (night ? 0.5 : 0.16) && this.goDoor(p)) return;
    if (r < 0.3 && p.kind !== K.Kid && this.goBench(p, 14)) return;
    if (r < 0.46 && this.goStall(p)) return;
    if (r < 0.6 && p.kind !== K.Kid && !p.child && this.goChat(p, false)) return;
    this.goStroll(p);
  }

  private goStroll(p: Ped) {
    for (let k = 0; k < 40; k++) {
      const s = this.spots[(Math.random() * this.spots.length) | 0];
      if (!s) break;
      const d = Math.hypot(s.x - p.x, s.y - p.y);
      if (Math.hypot(s.x - p.hx, s.y - p.hy) > p.roam || d < 2 || d > 11) continue;
      if (this.walkTo(p, s.x, s.y, Goal.Stroll)) return;
      break;
    }
    p.s = S.Idle;
    p.t = 1 + Math.random() * 3;
  }

  private goDoor(p: Ped): boolean {
    for (let k = 0; k < 30; k++) {
      const i = (Math.random() * this.doors.length) | 0;
      const d = this.doors[i];
      if (!d || !d.alive || Math.hypot(d.x - p.hx, d.y - p.hy) > p.roam || Math.hypot(d.x - p.x, d.y - p.y) > 10) continue;
      return this.walkTo(p, d.x, d.y, Goal.Door, i);
    }
    return false;
  }

  private goBench(p: Ped, r: number): boolean {
    let best = -1;
    let bd = r;
    for (let i = 0; i < this.seats.length; i++) {
      const s = this.seats[i];
      if (s.taken) continue;
      const d = Math.hypot(s.x - p.x, s.y - p.y) * (0.7 + Math.random() * 0.6);
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    if (best < 0) return false;
    const s = this.seats[best];
    // walk to just in front of the seat
    const ok = this.walkTo(p, s.x + Math.cos(s.yaw) * 0.14, s.y + Math.sin(s.yaw) * 0.14, Goal.Bench, best);
    if (ok) s.taken = p;
    return ok;
  }

  private goStall(p: Ped): boolean {
    if (!this.stalls.length) return false;
    const st = this.stalls[(Math.random() * this.stalls.length) | 0];
    if (Math.hypot(st.x - p.x, st.y - p.y) > 16) return false;
    const fx = Math.cos(st.yaw);
    const fy = Math.sin(st.yaw);
    const lat = (Math.random() - 0.5) * 0.4;
    const d = 0.28 + Math.random() * 0.12;
    return this.walkTo(p, st.x + fx * d - fy * lat, st.y + fy * d + fx * lat, Goal.Stall, this.stalls.indexOf(st));
  }

  private goChat(p: Ped, instant: boolean): boolean {
    // join a small group nearby, or start one on a free spot
    let g: ChatGroup | null = null;
    for (const c of this.chats) if (c.members.length < 4 && Math.hypot(c.x - p.x, c.y - p.y) < 10) g = c;
    if (!g) {
      let s: Spot | null = null;
      for (let k = 0; k < 12 && !s; k++) {
        const c = this.spots[(Math.random() * this.spots.length) | 0];
        if (c && Math.hypot(c.x - p.x, c.y - p.y) < 6 && Math.hypot(c.x - p.hx, c.y - p.hy) < p.roam && !this.chats.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 1)) s = c;
      }
      if (!s) return false;
      g = { x: s.x, y: s.y, n: 0, members: [] };
      this.chats.push(g);
    }
    const i = g.members.length;
    const a = i * 2.1 + Math.random() * 0.4;
    const r = 0.22;
    const x = g.x + Math.cos(a) * r;
    const y = g.y + Math.sin(a) * r;
    g.members.push(p);
    if (instant) {
      p.x = x;
      p.y = y;
      p.hgt = groundAt(this.map, x, y);
      this.startChat(p, g);
      return true;
    }
    if (this.walkTo(p, x, y, Goal.Chat, this.chats.indexOf(g))) return true;
    g.members.pop();
    if (!g.members.length) this.chats.splice(this.chats.indexOf(g), 1);
    return false;
  }

  private startChat(p: Ped, g: ChatGroup) {
    p.s = S.Chat;
    p.t = 15 + Math.random() * 35;
    p.yaw = Math.atan2(g.y - p.y, g.x - p.x);
  }

  private leaveGroups(p: Ped) {
    for (let i = this.chats.length - 1; i >= 0; i--) {
      const c = this.chats[i];
      const k = c.members.indexOf(p);
      if (k >= 0) c.members.splice(k, 1);
      if (!c.members.length) this.chats.splice(i, 1);
    }
    if (p.seat >= 0 && this.seats[p.seat]) this.seats[p.seat].taken = null;
    p.seat = -1;
    if (p.goal === Goal.Bench && p.gi >= 0 && this.seats[p.gi]?.taken === p) this.seats[p.gi].taken = null;
  }

  private arrive(p: Ped) {
    p.np = 0;
    switch (p.goal) {
      case Goal.Door: {
        const d = this.doors[p.gi];
        if (d && d.alive) {
          p.door = p.gi;
          this.hide(p, 8 + Math.random() * (this.dark > 0.6 ? 90 : 40));
          return;
        }
        break;
      }
      case Goal.Bench: {
        const s = this.seats[p.gi];
        if (s && s.taken === p) {
          p.s = S.Sit;
          p.seat = p.gi;
          p.t = 12 + Math.random() * 40;
          p.x = s.x;
          p.y = s.y;
          p.yaw = s.yaw;
          return;
        }
        break;
      }
      case Goal.Stall: {
        const st = this.stalls[p.gi];
        if (st) {
          p.s = S.Shop;
          p.t = 6 + Math.random() * 14;
          p.yaw = wrapAngle(st.yaw + Math.PI);
          return;
        }
        break;
      }
      case Goal.Chat: {
        const g = this.chats[p.gi];
        if (g && g.members.includes(p)) {
          this.startChat(p, g);
          return;
        }
        break;
      }
      case Goal.Shelter: {
        const d = this.doors[p.gi];
        if (d && d.alive) {
          p.door = p.gi;
          this.hide(p, 60 + Math.random() * 60);
          return;
        }
        // gone: run on
        this.flee(p, p.fx, p.fy, 0.6, false);
        return;
      }
      case Goal.Away:
        // far enough? catch breath, else run on
        if (this.time - this.heatAt(p.x, p.y) < 6) {
          this.flee(p, p.fx, p.fy, 0.5, false);
          return;
        }
        p.s = S.Idle;
        p.t = 3 + Math.random() * 4;
        p.goal = Goal.None;
        return;
      case Goal.Edge:
        p.s = S.Gone;
        p.t = 90 + Math.random() * 90;
        if (p.child) p.child.s = S.Gone;
        return;
      case Goal.Kid: {
        const k = p.child;
        if (k) {
          k.s = S.Follow;
          k.parent = p;
          k.rescuer = null;
          k.play = -1;
        }
        this.flee(p, p.fx, p.fy, 0.6, false);
        return;
      }
    }
    p.s = S.Idle;
    p.t = 1 + Math.random() * 5;
    p.goal = Goal.None;
  }

  // ------------------------------------------------------------------ fear

  private heatAt(x: number, y: number) {
    const cx = Math.max(0, Math.min(this.hw - 1, (x / 4) | 0));
    const cy = Math.max(0, Math.min(this.heat.length / this.hw - 1, (y / 4) | 0));
    return this.heat[cy * this.hw + cx];
  }

  private warm(d: Danger, R: number) {
    const hh = this.heat.length / this.hw;
    const r = Math.ceil(R / 4);
    const cx = (d.x / 4) | 0;
    const cy = (d.y / 4) | 0;
    for (let y = Math.max(0, cy - r); y <= Math.min(hh - 1, cy + r); y++) for (let x = Math.max(0, cx - r); x <= Math.min(this.hw - 1, cx + r); x++) this.heat[y * this.hw + x] = this.time;
  }

  /** Run from (sx, sy): for the nearest standing house, or away (to the map edge in the end). */
  private flee(p: Ped, sx: number, sy: number, power: number, startle: boolean) {
    if (p.s === S.Inside || p.s === S.Gone || p.s === S.Vendor && power < 0.3) return;
    if (p.parent && p.s === S.Follow) return;
    this.leaveGroups(p);
    let dx = p.x - sx;
    let dy = p.y - sy;
    const L = Math.hypot(dx, dy) || 1;
    dx /= L;
    dy /= L;
    p.fx = sx;
    p.fy = sy;
    p.scareT = this.time;
    if (this.panicBudget <= 0 && !startle) {
      // too many route searches this frame: try again in a moment
      p.s = S.Alarm;
      p.t = 0.05 + Math.random() * 0.3;
      p.np = 0;
      return;
    }
    if (startle && p.s !== S.Flee && p.s !== S.Alarm && p.s !== S.Down && p.s !== S.Fetch) {
      p.s = S.Alarm;
      p.t = 0.35 + Math.random() * 0.5;
      p.np = 0;
      if (p.vendor) p.vendor = false;
      return;
    }
    // a parent first fetches a child that wandered off (play groups)
    if (p.child && p.child.s !== S.Follow) {
      const k = p.child;
      if (this.setPath(p, k.x, k.y, true)) {
        p.s = S.Fetch;
        p.goal = Goal.Kid;
        return;
      }
    }
    // shelter: a standing house close by, not towards the danger
    let best = -1;
    let bd = 7;
    for (let i = 0; i < this.doors.length; i++) {
      const d = this.doors[i];
      if (!d.alive) continue;
      const ex = d.x - p.x;
      const ey = d.y - p.y;
      const dd = Math.hypot(ex, ey);
      if (dd > bd) continue;
      if (dd > 1.2 && (ex * dx + ey * dy) / dd < -0.25) continue;
      if (Math.hypot(d.x - sx, d.y - sy) < 2.5) continue;
      bd = dd;
      best = i;
    }
    p.s = S.Flee;
    p.t = 0;
    if (best >= 0 && this.setPath(p, this.doors[best].x, this.doors[best].y, true)) {
      p.goal = Goal.Shelter;
      p.gi = best;
      return;
    }
    // away: a point well clear, the map edge if that is close
    const m = this.map;
    for (let k = 0; k < 4; k++) {
      const a = Math.atan2(dy, dx) + (k === 0 ? 0 : (Math.random() - 0.5) * 2);
      const run = 8 + Math.random() * 3;
      let tx = p.x + Math.cos(a) * run;
      let ty = p.y + Math.sin(a) * run;
      let goal = Goal.Away;
      if (tx < 1 || ty < 1 || tx > m.w - 1 || ty > m.h - 1) {
        tx = Math.max(0.3, Math.min(m.w - 0.3, tx));
        ty = Math.max(0.3, Math.min(m.h - 0.3, ty));
        goal = Goal.Edge;
      }
      const s = this.snap(tx, ty, 1.2, 6);
      if (!s) continue;
      if (this.setPath(p, s.x, s.y, true)) {
        p.goal = goal;
        return;
      }
    }
    // no route: just run, sliding along whatever is in the way
    p.np = 0;
    p.goal = Goal.Away;
    p.gx = p.x + dx * 6;
    p.gy = p.y + dy * 6;
  }

  private alarm(f: AmbientFrame) {
    for (const d of f.dangers) {
      const R = d.r * 1.4 + d.power * 5 + 2.5;
      this.warm(d, R);
      for (const p of this.peds) {
        if (p.s === S.Inside || p.s === S.Gone || (p.rescuer && p.s === S.Alarm)) continue;
        const dist = Math.hypot(p.x - d.x, p.y - d.y);
        if (dist > R) continue;
        if (d.kill > 0 && dist < d.kill * 1.3 + 0.4 && p.s !== S.Down) {
          // knocked over by the blast (gets up and runs)
          this.leaveGroups(p);
          if (p.parent) {
            p.parent.child = null;
            p.parent = null;
          }
          p.s = S.Down;
          p.t = 1.5 + Math.random() * 2;
          p.fallT = 0;
          p.fx = d.x;
          p.fy = d.y;
          p.np = 0;
          this.stat.fled++;
          continue;
        }
        if (p.s === S.Flee && this.time - p.lastPath < 1.2) continue;
        if (p.s === S.Down || p.s === S.Alarm || p.s === S.Fetch) continue;
        this.stat.fled++;
        this.flee(p, d.x, d.y, d.power, true);
      }
    }
    // kids at play without a parent: the nearest grown-up grabs them
    for (const pg of this.plays)
      for (const k of pg.kids) {
        if (k.s !== S.Play || this.time - this.heatAt(k.x, k.y) > 0.5) continue;
        let best: Ped | null = null;
        let bd = 6;
        for (const p of this.peds) {
          if (p.kind === K.Kid || p.child || p.s === S.Inside || p.s === S.Gone || p.s === S.Down || p.s === S.Sit) continue;
          const dd = Math.hypot(p.x - k.x, p.y - k.y);
          if (dd < bd) {
            bd = dd;
            best = p;
          }
        }
        if (best) {
          best.child = k;
          k.rescuer = best;
          // waits, frightened, to be fetched
          k.s = S.Alarm;
          k.t = 25;
          k.fx = best.fx = k.x - 0.5 + Math.random();
          k.fy = best.fy = k.y - 0.5 + Math.random();
          if (best.s !== S.Alarm) this.flee(best, best.fx, best.fy, 0.6, false);
        } else this.flee(k, k.x - 0.5 + Math.random(), k.y - 0.5 + Math.random(), 0.5, false);
      }
  }

  private unitsNear(p: Ped, f: AmbientFrame): boolean {
    for (let i = 0; i < f.nUnits; i++) {
      const ux = f.units[i * 2];
      const uy = f.units[i * 2 + 1];
      if (Math.abs(ux - p.x) < 2.6 && Math.abs(uy - p.y) < 2.6 && Math.hypot(ux - p.x, uy - p.y) < 2.6) {
        p.fx = ux;
        p.fy = uy;
        return true;
      }
    }
    return false;
  }

  /** A civilian building was destroyed: whoever sheltered in it runs out. */
  houseDestroyed(entId: number) {
    const ds = this.houseEnt.get(entId);
    if (!ds) return;
    for (const di of ds) {
      const d = this.doors[di];
      d.alive = false;
      for (const p of this.peds)
        if (p.door === di && p.s === S.Inside) {
          p.s = S.Idle;
          p.x = d.x;
          p.y = d.y;
          p.door = -1;
          this.flee(p, d.x - Math.cos(d.yaw), d.y - Math.sin(d.yaw), 1, true);
          if (p.child) {
            p.child.s = S.Follow;
            p.child.x = p.x;
            p.child.y = p.y;
          }
        }
    }
  }

  // ------------------------------------------------------------------ update

  update(f: AmbientFrame) {
    const dt = Math.min(0.1, f.dt);
    this.time += dt;
    this.dark = f.dark;
    this.frameNo++;
    this.pathBudget = 3;
    this.panicBudget = 4;
    if (f.dangers.length) this.alarm(f);
    // building states (doors of destroyed houses close), new bases
    if ((this.frameNo & 63) === 0) {
      this.scanBuildings();
      for (const d of this.doors) {
        if (!d.alive || d.ent < 0) continue;
        const e = this.world.entities.get(d.ent);
        if (!e || e.dead) d.alive = false;
      }
    }
    const inView = (p: Ped) => p.x > f.vx0 && p.x < f.vx1 && p.y > f.vy0 && p.y < f.vy1;
    for (const p of this.peds) {
      // off screen: a quarter of the updates
      if (!inView(p) && ((p.id + this.frameNo) & 3) !== 0 && p.s !== S.Flee) continue;
      const pdt = inView(p) || p.s === S.Flee ? dt : dt * 4;
      this.step(p, pdt, f);
    }
    for (const pg of this.plays) this.ball(pg, dt);
    this.separate();
  }

  private separate() {
    const ps = this.peds;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.s !== S.Walk && a.s !== S.Flee) continue;
      for (let j = 0; j < ps.length; j++) {
        if (i === j) continue;
        const b = ps[j];
        if (b.s === S.Inside || b.s === S.Gone || b === a.child || b === a.parent) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        if (dx > 0.2 || dx < -0.2 || dy > 0.2 || dy < -0.2) continue;
        const d2 = dx * dx + dy * dy;
        if (d2 > 0.03 || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        // step aside, to the right
        const k = ((0.173 - d) / d) * 0.25;
        const nx = a.x + dx * k - Math.sin(a.yaw) * 0.004;
        const ny = a.y + dy * k + Math.cos(a.yaw) * 0.004;
        if (this.canStep(a, nx, ny)) {
          a.x = nx;
          a.y = ny;
        }
      }
    }
  }

  private step(p: Ped, dt: number, f: AmbientFrame) {
    p.t -= dt;
    let vt = 0;
    let want = p.yaw;
    let pose = Pose.Walk;
    let follow = false;
    // troops close by: off the street
    p.unitT -= dt;
    if (p.unitT <= 0) {
      p.unitT = 0.4 + Math.random() * 0.3;
      if (p.s !== S.Inside && p.s !== S.Gone && p.s !== S.Flee && p.s !== S.Down && p.s !== S.Follow && p.s !== S.Fetch && p.s !== S.Alarm && this.unitsNear(p, f)) {
        this.stat.fled++;
        this.flee(p, p.fx, p.fy, 0.3, Math.random() < 0.3);
      }
    }
    switch (p.s) {
      case S.Inside:
        p.show = false;
        if (p.t <= 0) {
          // come out when it has been quiet here for a while
          const calm = this.time - this.heatAt(p.x, p.y);
          if (calm < 70 + (p.id % 7) * 9) {
            p.t = 5 + Math.random() * 10;
            return;
          }
          if (p.door >= 0 && !this.doors[p.door].alive) p.door = -1;
          const d = p.door >= 0 ? this.doors[p.door] : null;
          if (d) {
            p.x = d.x;
            p.y = d.y;
            p.yaw = d.yaw;
          }
          if (this.dark > 0.6 && Math.random() < 0.6) {
            p.t = 20 + Math.random() * 40;
            return;
          }
          p.show = true;
          p.s = S.Idle;
          p.t = 0.5 + Math.random();
          p.hgt = groundAt(this.map, p.x, p.y);
          if (p.child) {
            p.child.s = S.Follow;
            p.child.x = p.x;
            p.child.y = p.y;
          }
          this.stat.returned++;
        }
        return;
      case S.Gone:
        p.show = false;
        if (p.t <= 0) {
          if (this.time - this.heatAt(p.x, p.y) < 110 || this.time - this.heatAt(p.hx, p.hy) < 110) {
            p.t = 10 + Math.random() * 20;
            return;
          }
          // walk back in from the edge
          p.show = true;
          this.stat.returned++;
          if (p.child) {
            p.child.s = S.Follow;
            p.child.x = p.x;
            p.child.y = p.y;
          }
          if (!this.walkTo(p, p.hx, p.hy, Goal.Return)) {
            p.s = S.Idle;
            p.t = 2;
          }
        }
        return;
      case S.Follow: {
        const q = p.parent;
        if (!q) {
          p.s = S.Idle;
          p.t = 1;
          break;
        }
        follow = true;
        p.show = q.show;
        if (q.s === S.Inside || q.s === S.Gone) {
          p.show = false;
          p.x = q.x;
          p.y = q.y;
          return;
        }
        break;
      }
      case S.Idle:
        pose = Pose.Walk;
        // look around a little
        if (Math.sin(this.time * 0.6 + p.id) > 0.97) want = p.yaw + 0.6;
        if (p.t <= 0) this.plan(p);
        break;
      case S.Chat:
        pose = Math.sin(this.time * 0.35 + p.id * 1.7) > 0.2 ? Pose.Chat : Pose.Walk;
        p.phase += dt * 2.2;
        if (p.t <= 0) {
          this.leaveGroups(p);
          this.plan(p);
        }
        break;
      case S.Sit:
        pose = Pose.Sit;
        if (p.t <= 0) {
          const s = this.seats[p.seat];
          this.leaveGroups(p);
          if (s) {
            p.x = s.x + Math.cos(s.yaw) * 0.14;
            p.y = s.y + Math.sin(s.yaw) * 0.14;
          }
          p.s = S.Idle;
          p.t = 0.5;
        }
        break;
      case S.Shop:
        pose = Math.sin(this.time * 0.5 + p.id) > 0.5 ? Pose.Vendor : Pose.Walk;
        p.phase += dt * 2;
        if (p.t <= 0) {
          if (Math.random() < 0.3) p.mask |= this.map.biome === 'urban' || this.map.biome === 'temperate' ? Opt.Bag : 0;
          this.plan(p);
        }
        break;
      case S.Vendor: {
        pose = Pose.Vendor;
        p.phase += dt * 2.5;
        // face the customers, now and then turn to the goods
        const st = this.stalls.find((q) => q.vendor === p);
        if (st) want = Math.sin(this.time * 0.2 + p.id) > 0.8 ? st.yaw + 0.8 : st.yaw;
        break;
      }
      case S.Play: {
        const pg = this.plays[p.play];
        if (!pg) {
          p.s = S.Idle;
          break;
        }
        // chase the ball when it comes near, else run round in a loose ring
        const db = Math.hypot(pg.bx - p.x, pg.by - p.y);
        let tx: number;
        let ty: number;
        if (db < 0.6 && pg.kids.every((k) => k === p || Math.hypot(pg.bx - k.x, pg.by - k.y) >= db)) {
          tx = pg.bx;
          ty = pg.by;
        } else {
          p.ang += dt * 0.55 * pg.spin * (0.8 + (p.id % 3) * 0.15);
          tx = pg.x + Math.cos(p.ang) * pg.r;
          ty = pg.y + Math.sin(p.ang) * pg.r;
        }
        const dx = tx - p.x;
        const dy = ty - p.y;
        const d = Math.hypot(dx, dy);
        want = Math.atan2(dy, dx);
        vt = Math.min(p.run * 0.75, d * 2.2);
        if (d < 0.08 && db < 0.15) pose = Pose.Kick;
        break;
      }
      case S.Alarm:
        pose = Pose.Alarm;
        p.v *= 0.8;
        want = Math.atan2(p.fy - p.y, p.fx - p.x);
        if (p.t <= 0) this.flee(p, p.fx, p.fy, 0.6, false);
        break;
      case S.Down: {
        p.fallT += dt;
        p.v = 0;
        if (p.t > 0) p.fall = Math.min(Math.PI / 2, p.fall + dt * 6);
        else {
          p.fall = Math.max(0, p.fall - dt * 2.5);
          if (p.fall <= 0) this.flee(p, p.fx, p.fy, 0.8, false);
        }
        pose = p.fall > 0.3 ? Pose.Lying : Pose.Walk;
        break;
      }
      case S.Walk:
      case S.Flee:
      case S.Fetch: {
        const running = p.s !== S.Walk;
        if (running) pose = p.child && p.child.s === S.Follow ? (p.child.size < 0.56 ? Pose.Carry : Pose.HoldHand) : Pose.Walk;
        if (p.np > 0 && p.pi < p.np) {
          let tx = p.path[p.pi * 2];
          let ty = p.path[p.pi * 2 + 1];
          const last = p.pi === p.np - 1;
          // keep to one side of the pavement
          if (!last && !running) {
            const ax = tx - p.x;
            const ay = ty - p.y;
            const al = Math.hypot(ax, ay) || 1;
            const ox = tx - (ay / al) * p.side;
            const oy = ty + (ax / al) * p.side;
            if (this.canStep(p, ox, oy)) {
              tx = ox;
              ty = oy;
            }
          }
          const dx = tx - p.x;
          const dy = ty - p.y;
          const d = Math.hypot(dx, dy);
          want = Math.atan2(dy, dx);
          vt = (running ? p.run : p.speed) * (last ? Math.min(1, d * 4 + 0.25) : 1);
          if (p.s === S.Walk && p.parent === null && p.child && p.child.s === S.Follow) vt = Math.min(vt, 0.26);
          if (d < (last ? 0.05 : 0.14)) {
            p.pi++;
            if (p.pi >= p.np) {
              if (p.s === S.Fetch) {
                p.goal = Goal.Kid;
              }
              this.arrive(p);
            }
          }
        } else if (running) {
          // pathless run (no route found): straight away from the danger
          const dx = p.gx - p.x;
          const dy = p.gy - p.y;
          want = Math.atan2(dy, dx);
          vt = p.run;
          if (Math.hypot(dx, dy) < 0.3 || p.t < -8) this.arrive(p);
        } else {
          this.arrive(p);
        }
        if (p.s === S.Walk && p.t < -60) {
          // walking for ages: give up
          p.s = S.Idle;
          p.t = 1;
          p.np = 0;
        }
        break;
      }
    }
    if (follow) {
      this.stepChild(p, dt);
      return;
    }
    // turn, then move (sliding along closed cells)
    const turnRate = (p.s === S.Flee || p.s === S.Play ? 9 : 5) * dt;
    p.yaw = wrapAngle(p.yaw + Math.max(-turnRate, Math.min(turnRate, wrapAngle(want - p.yaw))));
    p.v += (vt - p.v) * Math.min(1, dt * (vt > p.v ? 4 : 6));
    if (p.v > 0.004) {
      const off = Math.abs(wrapAngle(want - p.yaw));
      const sp = p.v * (off > 1.2 ? 0.2 : 1);
      const nx = p.x + Math.cos(p.yaw) * sp * dt;
      const ny = p.y + Math.sin(p.yaw) * sp * dt;
      if (this.canStep(p, nx, ny) || !this.passable(p.x, p.y)) {
        p.x = nx;
        p.y = ny;
        p.stuck = Math.max(0, p.stuck - dt);
      } else if (this.canStep(p, nx, p.y)) p.x = nx;
      else if (this.canStep(p, p.x, ny)) p.y = ny;
      else {
        p.stuck += dt;
        if (p.stuck > 1.5) {
          p.stuck = 0;
          if (p.s === S.Walk || p.s === S.Flee) {
            if (!this.setPath(p, p.gx, p.gy, p.s === S.Flee)) this.arrive(p);
          }
        }
      }
    }
    const m = this.map;
    if (p.x < 0.05 || p.y < 0.05 || p.x > m.w - 0.05 || p.y > m.h - 0.05) {
      p.x = Math.max(0.05, Math.min(m.w - 0.05, p.x));
      p.y = Math.max(0.05, Math.min(m.h - 0.05, p.y));
      if (p.s === S.Flee) {
        p.goal = Goal.Edge;
        this.arrive(p);
      }
    }
    this.animate(p, pose, dt);
  }

  private animate(p: Ped, pose: number, dt: number) {
    const run = p.v > p.speed * 1.5;
    const strideLen = (run ? 1.9 : 1.45) * CIV_SCALE * p.size;
    if (pose !== Pose.Chat && pose !== Pose.Vendor) p.phase += ((p.v * dt) / strideLen) * Math.PI * 2;
    const st = pose === Pose.Sit || pose === Pose.Lying ? 0 : Math.min(run ? 1.6 : 1.05, p.v / Math.max(0.05, p.speed * 0.8));
    p.stride += (st - p.stride) * Math.min(1, dt * 8);
    p.pose = pose;
    p.lean = p.baseLean + (run ? 0.2 : 0) + (pose === Pose.Sit ? -0.05 : 0);
    p.hgt += (groundAt(this.map, p.x, p.y) - p.hgt) * Math.min(1, dt * 12);
    p.onRoad = p.show && p.s !== S.Inside && p.s !== S.Gone && (flagAt(this.grid, p.x, p.y) & WF.Road) !== 0;
  }

  /** A child by the parent: hand in hand, or carried when running (small ones). */
  private stepChild(k: Ped, dt: number) {
    const q = k.parent!;
    const running = q.v > q.speed * 1.5;
    const carried = running && k.size < 0.56;
    const ca = Math.cos(q.yaw);
    const sa = Math.sin(q.yaw);
    let tx: number;
    let ty: number;
    if (carried) {
      tx = q.x + ca * 0.05 + sa * 0.06;
      ty = q.y + sa * 0.05 - ca * 0.06;
      k.x = tx;
      k.y = ty;
      k.yaw = q.yaw + 1.2;
      k.v = 0;
      k.pose = Pose.Carried;
      k.stride = 0;
      k.lean = 0;
      k.hgt = q.hgt;
      return;
    }
    // walking at the parent's right hand (q holds out the right arm)
    const side = q.s === S.Sit ? 0.3 : 0.15;
    tx = q.x + sa * side;
    ty = q.y - ca * side;
    if (q.s === S.Sit) {
      tx = q.x - sa * 0.3;
      ty = q.y + ca * 0.3;
    }
    const dx = tx - k.x;
    const dy = ty - k.y;
    const d = Math.hypot(dx, dy);
    const vt = Math.min(q.run, d * 4 + (q.v > 0.05 ? q.v : 0));
    if (d > 1.5) {
      k.x = tx;
      k.y = ty;
    } else if (d > 0.02) {
      const sp = Math.min(d, vt * dt);
      k.x += (dx / d) * sp;
      k.y += (dy / d) * sp;
    }
    k.v = q.v > 0.05 ? q.v : vt * 0.5;
    k.yaw = d > 0.12 ? Math.atan2(dy, dx) : q.yaw;
    const pose = q.s === S.Sit ? Pose.Walk : q.v > 0.05 || q.s === S.Flee ? Pose.Child : Pose.Walk;
    this.animate(k, pose, dt);
  }

  private ball(pg: PlayGroup, dt: number) {
    pg.kickT -= dt;
    let kicker: Ped | null = null;
    for (const k of pg.kids) if (k.s === S.Play && Math.hypot(k.x - pg.bx, k.y - pg.by) < 0.12) kicker = k;
    if (kicker && pg.kickT <= 0) {
      // pass to another kid (or punt it into the middle)
      const others = pg.kids.filter((k) => k !== kicker && k.s === S.Play);
      const to = others.length ? others[(Math.random() * others.length) | 0] : null;
      const tx = to ? to.x : pg.x;
      const ty = to ? to.y : pg.y;
      const dx = tx - pg.bx;
      const dy = ty - pg.by;
      const d = Math.hypot(dx, dy) || 1;
      const sp = 0.9 + Math.random() * 0.7;
      pg.bvx = (dx / d) * sp;
      pg.bvy = (dy / d) * sp;
      if (Math.random() < 0.3) pg.bvz = 0.5;
      pg.kickT = 0.8 + Math.random();
    }
    pg.bx += pg.bvx * dt;
    pg.by += pg.bvy * dt;
    pg.bz = Math.max(0, pg.bz + pg.bvz * dt);
    pg.bvz = pg.bz > 0 ? pg.bvz - 3 * dt : pg.bvz < -0.2 ? -pg.bvz * 0.4 : 0;
    const fr = Math.exp(-dt * 1.2);
    pg.bvx *= fr;
    pg.bvy *= fr;
    // keep it on the lawn: bounce off closed ground / the edge of the play area
    if (!this.passable(pg.bx, pg.by) || Math.hypot(pg.bx - pg.x, pg.by - pg.y) > pg.r * 1.8) {
      pg.bx -= pg.bvx * dt * 2;
      pg.by -= pg.bvy * dt * 2;
      pg.bvx = (pg.x - pg.bx) * 0.8;
      pg.bvy = (pg.y - pg.by) * 0.8;
    }
  }

  // ------------------------------------------------------------------ queries

  crossingBusy(x: number, y: number, r: number): boolean {
    for (const p of this.peds) if (p.onRoad && Math.abs(p.x - x) < r && Math.abs(p.y - y) < r && Math.hypot(p.x - x, p.y - y) < r) return true;
    return false;
  }

  /** Debug / tests. */
  debug() {
    const by: Record<number, number> = {};
    for (const p of this.peds) by[p.s] = (by[p.s] ?? 0) + 1;
    return { total: this.peds.length, shown: this.count, states: by, doors: this.doors.length, seats: this.seats.length, stalls: this.stalls.length, plays: this.plays.length, chats: this.chats.length, spots: this.spots.length, drawn: this.inst.n, ...this.stat };
  }

  // ------------------------------------------------------------------ draw

  draw(f: AmbientFrame) {
    const im = this.inst;
    const sh = this.shadows;
    im.begin();
    sh.begin();
    let nb = 0;
    {
      const cap = this.cap;
      for (let i = 0; i < this.peds.length && im.n < cap; i++) {
        const p = this.peds[i];
        if (!p.show || p.s === S.Inside || p.s === S.Gone) continue;
        this.drawFig(p, f, p.s === S.Sit);
      }
      for (const g of this.figures) if (g.show && im.n < cap + 16) this.drawFig(g, f, false);
      // balls
      for (const pg of this.plays) {
        if (nb >= 8 || !pg.kids.some((k) => k.s === S.Play)) continue;
        if (pg.bx < f.vx0 || pg.bx > f.vx1 || pg.by < f.vy0 || pg.by > f.vy1 || !this.probe.visible(pg.bx, pg.by)) continue;
        const h = groundAt(this.map, pg.bx, pg.by) + 0.11 * CIV_SCALE + pg.bz * 0.25;
        _m.makeRotationY(this.time * 3 + pg.bx * 5).setPosition(pg.bx, h, pg.by);
        this.balls.setMatrixAt(nb++, _m);
      }
    }
    this.balls.count = nb;
    this.balls.visible = nb > 0;
    if (nb) this.balls.instanceMatrix.needsUpdate = true;
    im.commit();
    sh.commit();
  }

  private drawFig(p: Figure, f: AmbientFrame, sitting: boolean) {
    if (p.x < f.vx0 || p.x > f.vx1 || p.y < f.vy0 || p.y > f.vy1) return;
    if (!this.probe.visible(p.x, p.y)) return;
    const k = CIV_SCALE * p.size;
    let y = p.hgt;
    _e.set(0, -p.yaw, 0, 'YXZ');
    _q.setFromEuler(_e);
    const fall = (p as Ped).fall ?? 0;
    if (sitting) y += 0.12 - (HIP_Y - 0.02) * k;
    if (p.pose === Pose.Carried) {
      const q = (p as Ped).parent;
      y += (1.05 * (q ? q.size : 1) - HIP_Y * p.size) * CIV_SCALE;
    }
    _m.compose(_p.set(p.x, y + Math.sin(fall) * 0.12 * k, p.y), _q, _s.set(k, k, k));
    if (fall > 0) {
      _r.makeRotationZ(fall);
      _m.multiply(_r);
    }
    this.inst.push(_m, p.phase, p.stride, p.pose, p.mask, p.skin, p.lean, p.top, p.bot, p.hat);
    if (!sitting && p.pose !== Pose.Carried) this.shadows.push(p.x + Math.cos(p.yaw) * fall * 0.35 * k * -1, p.hgt, p.y + Math.sin(p.yaw) * fall * 0.35 * k * -1, (0.5 + fall * 0.4) * k);
  }
}

void _c;
