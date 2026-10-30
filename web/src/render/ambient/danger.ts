import type { DriveCar, Driver, OtherCar } from './driver';
import { pointAt, type RoadNet } from './roadnet';

/*
 * War on the roads: how the civilians read the fighting (pure logic, no
 * three.js; AmbientLife feeds it, traffic.ts and people.ts ask it, the tests
 * run it headless).
 *
 * DangerField: a coarse grid (2-tile cells) of how frightening each place is,
 * 0..~1.2. Two layers: the troops and the burning wrecks (rebuilt a few times
 * a second from the units' positions: tanks and artillery weigh more and
 * reach further than infantry), and the blasts / gunfire / deaths (stamped
 * when they happen, fading out over ~40 s). Queries are bilinear; it also
 * remembers when each cell was last hot, so the traffic can wait for a calm.
 *
 * Wary: the drivers' reaction, on top of the rules of driver.ts. Every
 * quarter of a second a car samples the field along its route ahead (onto
 * the exit it plans to take), at its own place and behind it:
 *  - mild (far off / to the side): it slows down, the driver hesitates;
 *  - danger ahead on the route: first another exit at the junction ahead if
 *    one leads away; otherwise a stop, then a 3-point turn (or a U-turn where
 *    the road is wide) on the road surface, and away faster, hazard lights on;
 *  - very close / under fire: an emergency stop; some drivers get out and run
 *    (the caller abandons the car on the road and lets a pedestrian flee);
 *    the others turn away or, with danger both ways, sit it out with the
 *    hazards blinking.
 * New cars stop coming in at map-edge entries whose road leads into danger,
 * and the overall density drops while there is fighting; both come back
 * gradually, 1-2 minutes after it calmed down.
 *
 * Fear (the wary layer): word gets round long before the troops arrive. Armed
 * forces that are MOVING or FIGHTING (fired / were hit in the last ~10 s)
 * project a wide, soft zone, ~36 tiles (~200 m) for armour and artillery,
 * less for infantry on foot; blasts and gunfire do too, fading over a
 * minute or so. Idle units parked in a base don't (the small layer above
 * still keeps the civilians off their doorstep). A coarse grid (4-tile
 * cells), level 1 at the threat falling linearly to 0 at its reach, so:
 *  - wary (>= WARY, out to ~200 m): walkers drop what they are doing and go
 *    indoors / walk away, herds walk off with the shepherd, drivers re-route
 *    at the junction before it (or turn back), no new cars on roads into it;
 *  - flee (>= FLEE, ~100 m from armour): walkers run for shelter, herds bolt,
 *    drivers stop and turn round;
 *  - close / under fire: the small layer's panic as before.
 * Each cell remembers when it was last in a zone (waryCalm): life comes back
 * 1-2 minutes after the threat moved on or stopped. Bilinear and wide on
 * purpose: under the fog it reads as a vague unease, not a unit's outline.
 */

/** Danger levels: a driver hesitates / stops for it ahead / emergency stop. */
export const LOW = 0.12;
export const MID = 0.35;
export const HIGH = 0.72;
/** Wary levels: the outer (~200 m) zone, and the flee zone (half the reach: ~100 m from armour). */
export const WARY = 0.05;
export const FLEE = 0.5;
/** Reach (tiles) of a moving / fighting armoured unit or artillery (~200 m at 5.5 m a tile), of infantry on foot. */
export const WARY_R = 36;
export const WARY_R_INF = 26;
/** Fighting = fired or was hit within this many sim ticks (20 TPS: 10 s). */
const FIGHT_TICKS = 200;
/** Wary-layer blasts / gunfire fade with this time constant (s): a heavy one is felt for about a minute. */
const WFADE = 15;

/** What a unit needs to expose for the wary layer (a sim Entity is one). */
export interface ThreatUnit {
  moving: boolean;
  firedAt: number;
  hitAt: number;
}

/**
 * The wary reach of a military unit (0: none): armed ground / naval forces that are moving or fighting.
 * Idle units (a parked base) and the unarmed (harvesters, engineers) project nothing wide.
 */
export function threatReach(e: ThreatUnit, armed: boolean, infantry: boolean, tick: number): number {
  if (!armed) return 0;
  const fighting = tick - e.firedAt < FIGHT_TICKS || tick - e.hitAt < FIGHT_TICKS;
  if (!fighting && !e.moving) return 0;
  return infantry ? (fighting ? WARY_R_INF + 6 : WARY_R_INF) : WARY_R;
}

/** A cell this dangerous counts as "hot" (the calm clock restarts). */
const HOT = 0.2;
/** Blasts / gunfire fade with this time constant (s): a heavy blast is gone after ~45 s. */
const FADE = 20;
/** Chance a driver gets out and runs when it gets very close (or under fire). */
const BAIL = 0.35;

export class DangerField {
  /** Cell size (tiles). */
  readonly cell = 2;
  readonly cw: number;
  readonly ch: number;
  /** Troops and burning wrecks (rebuilt each refresh). */
  private units: Float32Array;
  /** Blasts, gunfire, deaths (fading). */
  private heat: Float32Array;
  /** The level: max of both. */
  private lv: Float32Array;
  /** Field time when each cell was last hot. */
  private hot: Float32Array;
  /** Field time (advanced by commit). */
  time = 0;
  /** When the last blast / shot was stamped (field time). */
  lastEvent = -1e9;
  /** Wary layer: cell size (tiles), size; live threats (rebuilt), blasts (fading), level, last time in a zone. */
  readonly wcell = 4;
  readonly ww: number;
  readonly wh: number;
  private wLive: Float32Array;
  private wHeat: Float32Array;
  private wLv: Float32Array;
  private wHot: Float32Array;
  /** Threats stamped this refresh (merged per cell: a column of tanks stamps once). */
  private wSeen = new Map<number, number>();
  /** Debug: threats stamped at the last refresh. */
  threats = 0;

  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cw = Math.max(1, Math.ceil(w / this.cell));
    this.ch = Math.max(1, Math.ceil(h / this.cell));
    const n = this.cw * this.ch;
    this.units = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.lv = new Float32Array(n);
    this.hot = new Float32Array(n).fill(-1e9);
    this.ww = Math.max(2, Math.ceil(w / this.wcell));
    this.wh = Math.max(2, Math.ceil(h / this.wcell));
    const wn = this.ww * this.wh;
    this.wLive = new Float32Array(wn);
    this.wHeat = new Float32Array(wn);
    this.wLv = new Float32Array(wn);
    this.wHot = new Float32Array(wn).fill(-1e9);
  }

  /** Stamp a cone (v at the centre, 0 at r: linear, so a level maps to a distance) into a wary-layer array. */
  private wstamp(a: Float32Array, x: number, y: number, r: number, v: number, mix: boolean) {
    const c = this.wcell;
    const i0 = Math.max(0, Math.floor((x - r) / c));
    const i1 = Math.min(this.ww - 1, Math.floor((x + r) / c));
    const j0 = Math.max(0, Math.floor((y - r) / c));
    const j1 = Math.min(this.wh - 1, Math.floor((y + r) / c));
    const r2 = r * r;
    const inv = 1 / r;
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) * c - y;
      const row = j * this.ww;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * c - x;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const k = v * (1 - Math.sqrt(d2) * inv);
        const q = row + i;
        if (k > a[q]) a[q] = k;
        if (mix) {
          const l = Math.max(this.wLive[q], this.wHeat[q]);
          this.wLv[q] = l;
          if (l >= WARY) this.wHot[q] = this.time;
        }
      }
    }
  }

  /** A moving / fighting force at (x, y) with wary reach `r` (threatReach) and weight `w` (call between begin and commit). */
  threat(x: number, y: number, r: number, w = 1) {
    if (r <= 0) return;
    // (units close together, the same reach: one stamp for the lot)
    const key = (Math.floor(y / this.wcell) * this.ww + Math.floor(x / this.wcell)) * 64 + Math.min(63, r | 0);
    const had = this.wSeen.get(key);
    if (had !== undefined && had >= w) return;
    this.wSeen.set(key, w);
    this.threats++;
    this.wstamp(this.wLive, x, y, r, w, false);
  }

  /** A blast / gunfire felt far off: a wary zone of reach `r` and level `v` at the centre, fading over a minute or so. */
  waryEvent(x: number, y: number, r: number, v: number) {
    this.wstamp(this.wHeat, x, y, r, Math.max(0, Math.min(1, v)), true);
  }

  /** Stamp a soft disc (1 at the centre, 0 at r) into `a`; `add`: repeated hits build up. */
  private stamp(a: Float32Array, x: number, y: number, r: number, v: number, add: boolean, mix: boolean) {
    const c = this.cell;
    const r2 = r * r;
    const i0 = Math.max(0, Math.floor((x - r) / c));
    const i1 = Math.min(this.cw - 1, Math.floor((x + r) / c));
    const j0 = Math.max(0, Math.floor((y - r) / c));
    const j1 = Math.min(this.ch - 1, Math.floor((y + r) / c));
    for (let j = j0; j <= j1; j++) {
      const dy = (j + 0.5) * c - y;
      for (let i = i0; i <= i1; i++) {
        const dx = (i + 0.5) * c - x;
        const d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const k = v * (1 - d2 / r2);
        const q = j * this.cw + i;
        a[q] = add ? Math.min(1.25, Math.max(a[q], k) + k * 0.25) : Math.max(a[q], k);
        if (mix) {
          const l = Math.max(this.units[q], this.heat[q]);
          this.lv[q] = l;
          if (l >= HOT) this.hot[q] = this.time;
        }
      }
    }
  }

  /** A blast / shot / death at (x, y): `power` 0..1 within `r` tiles; fades over ~40 s. */
  event(x: number, y: number, r: number, power: number) {
    this.stamp(this.heat, x, y, Math.max(1.5, r), Math.max(0, Math.min(1.1, power)), true, true);
    this.lastEvent = this.time;
  }

  /** Start a refresh: the troops / fires layer is rebuilt from scratch (unit(), then commit()). */
  begin() {
    this.units.fill(0);
    this.wLive.fill(0);
    this.wSeen.clear();
    this.threats = 0;
  }

  /** A unit (or a burning wreck) at (x, y): weight `w` (~1 for a tank), reach `r` tiles. */
  unit(x: number, y: number, r: number, w: number) {
    this.stamp(this.units, x, y, r, w, false, false);
  }

  /** Finish a refresh `dt` seconds after the last one: blasts fade, layers combine, hot cells noted. */
  commit(dt: number) {
    this.time += dt;
    const k = Math.exp(-dt / FADE);
    const { units, heat, lv, hot } = this;
    for (let q = 0; q < lv.length; q++) {
      let h = heat[q] * k;
      if (h < 0.01) h = 0;
      heat[q] = h;
      const l = units[q] > h ? units[q] : h;
      lv[q] = l;
      if (l >= HOT) hot[q] = this.time;
    }
    const kw = Math.exp(-dt / WFADE);
    const { wLive, wHeat, wLv, wHot } = this;
    for (let q = 0; q < wLv.length; q++) {
      let h = wHeat[q] * kw;
      if (h < 0.02) h = 0;
      wHeat[q] = h;
      const l = wLive[q] > h ? wLive[q] : h;
      wLv[q] = l;
      if (l >= WARY) wHot[q] = this.time;
    }
  }

  /** Everything forgotten (tests). */
  clear() {
    this.units.fill(0);
    this.heat.fill(0);
    this.lv.fill(0);
    this.wLive.fill(0);
    this.wHeat.fill(0);
    this.wLv.fill(0);
  }

  /** Wary level at (x, y) (bilinear, 0..1): >= WARY within ~200 m of a moving / fighting force, >= FLEE within ~100 m. */
  wary(x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.ww - 1, x / this.wcell - 0.5));
    const fy = Math.max(0, Math.min(this.wh - 1, y / this.wcell - 0.5));
    const i = Math.min(this.ww - 2, fx | 0);
    const j = Math.min(this.wh - 2, fy | 0);
    const u = fx - i;
    const v = fy - j;
    const q = j * this.ww + i;
    const a = this.wLv;
    return (a[q] * (1 - u) + a[q + 1] * u) * (1 - v) + (a[q + this.ww] * (1 - u) + a[q + this.ww + 1] * u) * v;
  }

  /** Seconds since (x, y) was last inside a wary zone (huge when it never was). */
  waryCalm(x: number, y: number): number {
    const i = Math.max(0, Math.min(this.ww - 1, Math.floor(x / this.wcell)));
    const j = Math.max(0, Math.min(this.wh - 1, Math.floor(y / this.wcell)));
    return this.time - this.wHot[j * this.ww + i];
  }

  /**
   * Where the fear at (x, y) comes from (to walk / run away from): a point up the wary slope,
   * `out.v` the level here (0: calm, out at x, y). A vague direction, not a unit's position.
   */
  waryFrom(x: number, y: number, out: { x: number; y: number; v: number }) {
    const v = this.wary(x, y);
    out.x = x;
    out.y = y;
    out.v = v;
    if (v < 0.005) return out;
    const e = this.wcell;
    const gx = this.wary(x + e, y) - this.wary(x - e, y);
    const gy = this.wary(x, y + e) - this.wary(x, y - e);
    const g = Math.hypot(gx, gy);
    if (g < 1e-4) return out;
    out.x = x + (gx / g) * 10;
    out.y = y + (gy / g) * 10;
    return out;
  }

  /** The drivers' reading of the wary layer on the danger scale: LOW at the edge of the zone, MID at the flee line, < HIGH. */
  waryDanger(x: number, y: number): number {
    const w = this.wary(x, y);
    if (w < WARY) return 0;
    return Math.min(HIGH - 0.1, LOW + ((w - WARY) / (FLEE - WARY)) * (MID - LOW));
  }

  /** Small layer and wary layer together, as the drivers see it. */
  drive(x: number, y: number): number {
    const a = this.at(x, y);
    const b = this.waryDanger(x, y);
    return a > b ? a : b;
  }

  /** Danger level at (x, y) (bilinear). */
  at(x: number, y: number): number {
    const fx = Math.max(0, Math.min(this.cw - 1, x / this.cell - 0.5));
    const fy = Math.max(0, Math.min(this.ch - 1, y / this.cell - 0.5));
    const i = Math.min(this.cw - 2, fx | 0);
    const j = Math.min(this.ch - 2, fy | 0);
    if (i < 0 || j < 0) return this.lv[0];
    const u = fx - i;
    const v = fy - j;
    const q = j * this.cw + i;
    const a = this.lv;
    return (a[q] * (1 - u) + a[q + 1] * u) * (1 - v) + (a[q + this.cw] * (1 - u) + a[q + this.cw + 1] * u) * v;
  }

  /** Level of cell #q. */
  cellLevel(q: number): number {
    return this.lv[q] ?? 0;
  }

  cellOf(x: number, y: number): number {
    const i = Math.max(0, Math.min(this.cw - 1, Math.floor(x / this.cell)));
    const j = Math.max(0, Math.min(this.ch - 1, Math.floor(y / this.cell)));
    return j * this.cw + i;
  }

  /** Seconds since (x, y) was last hot (huge when it never was). */
  calm(x: number, y: number): number {
    return this.time - this.hot[this.cellOf(x, y)];
  }

  /** The most dangerous cell centre within r of (x, y) (to run away from); level 0 when all is calm. */
  peak(x: number, y: number, r: number, out: { x: number; y: number; v: number }) {
    const c = this.cell;
    out.x = x;
    out.y = y;
    out.v = 0;
    const i0 = Math.max(0, Math.floor((x - r) / c));
    const i1 = Math.min(this.cw - 1, Math.floor((x + r) / c));
    const j0 = Math.max(0, Math.floor((y - r) / c));
    const j1 = Math.min(this.ch - 1, Math.floor((y + r) / c));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const l = this.lv[j * this.cw + i];
        if (l <= out.v) continue;
        out.v = l;
        out.x = (i + 0.5) * c;
        out.y = (j + 0.5) * c;
      }
    return out;
  }
}

/** Wary states of a car (DriveCar.wy). */
export const enum W {
  Calm = 0,
  /** Slowing down, hesitating (mild danger). */
  Wary = 1,
  /** Stopping / stopped for danger ahead (then turns away or waits). */
  Halt = 2,
  /** Turning round on the road to get away. */
  Turn = 3,
  /** Driving away from it, faster, hazards on. */
  Flee = 4,
  /** Stopped in the lane with danger both ways: sits it out, hazards on. */
  Cower = 5,
}

/** How far ahead a driver looks along the route (tiles), and stops for danger. */
const LOOK = 9;
const STOP_D = 6;

export class Wary {
  /** Traffic density factor (0.25..1): low while there is fighting, back up slowly after. */
  density = 1;
  private densTarget = 1;
  private densT = 0;
  /** Field cells on the roads (density estimate). */
  private roadCells: Int32Array;
  private aMax = 0;
  private aSmall = 0;
  private aDist = 1e9;

  constructor(
    readonly net: RoadNet,
    readonly driver: Driver,
    readonly field: DangerField,
    private rand: () => number = Math.random,
  ) {
    // junctions: exits that lead into danger (or deeper into a wary zone) are avoided
    driver.risk = (line, arc, dir) => this.exitRisk(line, arc, dir);
    const cells = new Set<number>();
    for (const L of net.lines) {
      if (L.lot >= 0) continue;
      for (let a = 0; a <= L.len; a += 1.5) {
        const p = pointAt(L, a);
        cells.add(field.cellOf(p.x, p.y));
      }
    }
    this.roadCells = Int32Array.from(cells);
  }

  /** Highest danger along `line` from `arc` in `dir` over `look` tiles (stops at the line's end). */
  lineRisk(line: number, arc: number, dir: number, look: number, wide = false): number {
    const L = this.net.lines[line];
    if (!L) return 0;
    let max = 0;
    for (let s = 0.4; s <= look; s += 0.8) {
      const a = arc + dir * s;
      if (a < 0 || a > L.len) break;
      const p = pointAt(L, a);
      const v = wide ? this.field.drive(p.x, p.y) : this.field.at(p.x, p.y);
      if (v > max) max = v;
    }
    return max;
  }

  /**
   * How bad an exit is: the danger along its first 7 tiles; and when it leads deeper into a wary zone
   * (the level 16 tiles on is up on the junction's), at least 0.3: avoided when there is another way.
   */
  exitRisk(line: number, arc: number, dir: number): number {
    const r = this.lineRisk(line, arc, dir, 7);
    const L = this.net.lines[line];
    if (!L) return r;
    const p0 = pointAt(L, Math.max(0, Math.min(L.len, arc)));
    const w0 = this.field.waryDanger(p0.x, p0.y);
    let w1 = 0;
    for (let s = 4; s <= 16; s += 4) {
      const a = Math.max(0, Math.min(L.len, arc + dir * s));
      const p = pointAt(L, a);
      w1 = Math.max(w1, this.field.waryDanger(p.x, p.y));
      if (a <= 0 || a >= L.len) break;
    }
    if (w1 > 0 && w1 > w0 + 0.01) return Math.max(r, 0.3, w1);
    return r;
  }

  /** Danger along the car's route ahead (onto its planned exit): aMax, aDist (first sample >= MID). */
  private ahead(c: DriveCar, look: number) {
    const net = this.net;
    const L = net.lines[c.line];
    let swAt = 1e9;
    let swLine = -1;
    let swArc = 0;
    let swDir = 1;
    if (c.planNode >= 0 && c.plan >= 0) {
      const st = this.driver.nextStop(c);
      if (st && st.node === c.planNode) {
        const arm = net.nodes[st.node].arms[c.plan];
        if (arm && (arm.line !== c.line || arm.dir !== c.dir)) {
          swAt = Math.max(0, (st.arc - c.arc) * c.dir);
          swLine = arm.line;
          swArc = arm.arc;
          swDir = arm.dir;
        }
      }
    }
    let max = 0;
    let small = 0;
    let dist = 1e9;
    for (let s = 0.4; s <= look; s += 0.8) {
      let Ln = L;
      let a = c.arc + c.dir * s;
      if (swLine >= 0 && s > swAt) {
        Ln = net.lines[swLine];
        a = swArc + swDir * (s - swAt);
      }
      if (a < 0 || a > Ln.len) break;
      const p = pointAt(Ln, a);
      const v0 = this.field.at(p.x, p.y);
      const v = Math.max(v0, this.field.waryDanger(p.x, p.y));
      if (v > max) max = v;
      if (v0 > small) small = v0;
      if (v >= MID && dist > 1e8) dist = s;
    }
    this.aMax = max;
    this.aSmall = small;
    this.aDist = dist;
  }

  /** The planned exit at the junction ahead leads into danger: pick again (choose() avoids it now). */
  private replan(c: DriveCar) {
    if (c.planNode < 0 || c.plan < 0) return;
    const node = this.net.nodes[c.planNode];
    const arm = node.arms[c.plan];
    if (!arm || this.exitRisk(arm.line, arm.arc, arm.dir) < MID * 0.85) return;
    const st = this.driver.nextStop(c);
    if (!st || st.node !== c.planNode) return;
    c.plan = this.driver.choose(c, node, st.arm);
  }

  /**
   * May a new car come in at this map-edge entry? Not while the road in leads
   * into danger; after it calmed down, more and more likely over 60..120 s.
   */
  entryOk(line: number, arc: number, dir: number): boolean {
    const L = this.net.lines[line];
    if (!L) return false;
    let calm = 1e9;
    for (let s = 0; s <= 14; s += 1) {
      const a = arc + dir * s;
      if (a < 0 || a > L.len) break;
      const p = pointAt(L, a);
      if (this.field.at(p.x, p.y) >= 0.08) return false;
      calm = Math.min(calm, this.field.calm(p.x, p.y));
    }
    // ... nor on a road into a wary zone (~200 m round a moving / fighting force), nor until it has been quiet a while
    for (let s = 0; s <= 36; s += 3) {
      const a = arc + dir * s;
      if (a < 0 || a > L.len) break;
      const p = pointAt(L, a);
      if (this.field.wary(p.x, p.y) >= WARY) return false;
      calm = Math.min(calm, this.field.waryCalm(p.x, p.y));
    }
    if (calm >= 120) return true;
    if (calm < 60) return false;
    return this.rand() < (calm - 60) / 60;
  }

  /** Per frame: the traffic density follows the fighting (down within seconds, back up over 1-2 min). */
  tick(dt: number) {
    this.densT -= dt;
    if (this.densT <= 0) {
      this.densT = 1;
      let hot = 0;
      for (const q of this.roadCells) if (this.field.cellLevel(q) >= HOT) hot++;
      const frac = this.roadCells.length ? hot / this.roadCells.length : 0;
      let t = Math.max(0.25, 1 - frac * 5);
      if (this.field.time - this.field.lastEvent < 25) t = Math.min(t, 0.6);
      this.densTarget = t;
    }
    const d = this.densTarget - this.density;
    this.density += d < 0 ? Math.max(d, -dt * 0.1) : Math.min(d, dt / 120);
  }

  /** Stopped in its lane for the danger (the others treat it as an obstacle: they turn round, not queue for ever). */
  stoppedInLane(c: DriveCar): boolean {
    return (c.wy === W.Halt || c.wy === W.Cower) && Math.abs(c.v) < 0.05;
  }

  /** Turn round on the road (3-point turn; on a wide road it comes out as a U-turn). Roundabout cars keep circulating. */
  turnRound(c: DriveCar) {
    if (c.cd > 0 || c.pk || c.kt || c.loop >= 0) return;
    this.driver.startTurn(c);
    c.cd = 6;
    if (c.wy === W.Halt || c.wy === W.Cower || c.wy === W.Flee) {
      c.wy = W.Turn;
      c.wyT = 0;
    }
  }

  private halt(c: DriveCar, here: number) {
    if (c.wy !== W.Halt && c.wy !== W.Cower) {
      c.wy = W.Halt;
      c.wyT = 0;
    }
    c.vmax = 0;
    c.haz = 1;
    if (here >= HIGH && c.bail === 0) c.bail = this.rand() < BAIL ? 1 : -1;
  }

  private flee(c: DriveCar) {
    c.wy = W.Flee;
    c.wyT = 0;
    c.vmax = 1e9;
    c.haz = 1;
    c.panic = Math.max(c.panic, 2);
  }

  /**
   * The driver's reaction (call before driver.step). True when the driver
   * gets out and runs: the caller leaves the car on the road.
   */
  think(c: DriveCar, dt: number): boolean {
    c.wyT += dt;
    c.haz = Math.max(0, c.haz - dt);
    c.cd = Math.max(0, c.cd - dt);
    if (c.pk) {
      c.wy = W.Calm;
      c.vmax = 1e9;
      return false;
    }
    switch (c.wy) {
      case W.Halt:
      case W.Cower:
        c.vmax = 0;
        c.haz = 1;
        break;
      case W.Turn:
        c.vmax = 1e9;
        c.haz = 1;
        if (!c.kt) this.flee(c);
        break;
      case W.Flee:
        c.vmax = 1e9;
        c.haz = 1;
        c.panic = Math.max(c.panic, 1);
        break;
      case W.Calm:
        c.vmax = 1e9;
        break;
    }
    c.scanT -= dt;
    if (c.scanT > 0) return false;
    c.scanT = 0.25 + this.rand() * 0.1;
    const small = this.field.at(c.x, c.y);
    const here = Math.max(small, this.field.waryDanger(c.x, c.y));
    if (c.wy === W.Turn) return false;
    if (c.loop >= 0 || c.kt) {
      // circulating / mid-manoeuvre: just ease off while it is tense
      c.wy = here >= LOW ? W.Wary : W.Calm;
      c.vmax = here >= LOW ? c.cruise * 0.7 : 1e9;
      return false;
    }
    this.replan(c);
    this.ahead(c, LOOK);
    const A = this.aMax;
    const front = A >= MID && this.aDist < STOP_D && A >= here - 0.05;
    if (c.wy === W.Halt || c.wy === W.Cower) {
      if (here >= HIGH && c.bail === 0) c.bail = this.rand() < BAIL ? 1 : -1;
      if (Math.abs(c.v) > 0.04) return false; // still braking
      if (c.bail === 1) return true;
      // a moment of hesitation before acting
      if (c.wy === W.Halt && c.wyT < 0.5 + (c.id % 7) * 0.12) return false;
      const B = this.lineRisk(c.line, c.arc, -c.dir, 7, true);
      // turning away helps when it is calmer behind
      const turnOk = B < A - 0.08 && B < HIGH && c.cd <= 0;
      if (A < MID && !(here >= HIGH && turnOk)) {
        // the danger is beside / behind (or gone): drive on, away
        this.flee(c);
        return false;
      }
      if (turnOk) {
        this.driver.startTurn(c);
        c.wy = W.Turn;
        c.wyT = 0;
        c.cd = 8;
        c.panic = Math.max(c.panic, 2);
        return false;
      }
      // danger both ways: sit it out, hazards blinking
      c.wy = W.Cower;
      return false;
    }
    if (front) {
      this.halt(c, here);
      return false;
    }
    if (here >= HIGH) {
      // escaping already: keep going
      if (c.wy === W.Flee) return false;
      this.halt(c, here);
      return false;
    }
    if (c.wy === W.Flee) {
      if (here < LOW && A < LOW && c.wyT > 3) c.wy = W.Calm;
      else if (here >= LOW || A >= LOW) c.wyT = Math.min(c.wyT, 1);
      return false;
    }
    // (the wary layer slows a driver heading deeper into it; driving out of it, it doesn't dawdle)
    let lvl = Math.max(small, this.aSmall * 0.85);
    if (A > here + 0.01) lvl = Math.max(lvl, here, A * 0.85);
    if (lvl >= LOW) {
      c.wy = W.Wary;
      c.vmax = c.cruise * Math.max(0.3, 0.8 - (lvl - LOW) * 2);
    } else {
      c.wy = W.Calm;
      c.vmax = 1e9;
      c.bail = 0;
    }
    return false;
  }

  /**
   * One step of a car that minds the fighting: the reaction, the rules
   * (driver.step), and turning round when stuck behind an obstacle.
   * Returns true when the driver abandons the car.
   */
  drive(c: DriveCar, cars: readonly OtherCar[], time: number, dt: number, nearUnit = 1e9): boolean {
    if (this.think(c, dt)) return true;
    const r = this.driver.step(c, cars, time, dt, nearUnit);
    c.blocked = r.blocked ? c.blocked + dt : 0;
    if (c.blocked > 3.5) {
      c.cd = 0;
      this.turnRound(c);
      c.blocked = 0;
    }
    return false;
  }
}
