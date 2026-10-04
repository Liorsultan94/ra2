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
 */

/** Danger levels: a driver hesitates / stops for it ahead / emergency stop. */
export const LOW = 0.12;
export const MID = 0.35;
export const HIGH = 0.72;
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
  }

  /** Everything forgotten (tests). */
  clear() {
    this.units.fill(0);
    this.heat.fill(0);
    this.lv.fill(0);
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
  private aDist = 1e9;

  constructor(
    readonly net: RoadNet,
    readonly driver: Driver,
    readonly field: DangerField,
    private rand: () => number = Math.random,
  ) {
    // junctions: exits that lead into danger are avoided
    driver.risk = (line, arc, dir) => this.lineRisk(line, arc, dir, 7);
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
  lineRisk(line: number, arc: number, dir: number, look: number): number {
    const L = this.net.lines[line];
    if (!L) return 0;
    let max = 0;
    for (let s = 0.4; s <= look; s += 0.8) {
      const a = arc + dir * s;
      if (a < 0 || a > L.len) break;
      const p = pointAt(L, a);
      const v = this.field.at(p.x, p.y);
      if (v > max) max = v;
    }
    return max;
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
      const v = this.field.at(p.x, p.y);
      if (v > max) max = v;
      if (v >= MID && dist > 1e8) dist = s;
    }
    this.aMax = max;
    this.aDist = dist;
  }

  /** The planned exit at the junction ahead leads into danger: pick again (choose() avoids it now). */
  private replan(c: DriveCar) {
    if (c.planNode < 0 || c.plan < 0) return;
    const node = this.net.nodes[c.planNode];
    const arm = node.arms[c.plan];
    if (!arm || this.lineRisk(arm.line, arm.arc, arm.dir, 7) < MID * 0.85) return;
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
    const here = this.field.at(c.x, c.y);
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
      const B = this.lineRisk(c.line, c.arc, -c.dir, 7);
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
    const lvl = Math.max(here, A * 0.85);
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
