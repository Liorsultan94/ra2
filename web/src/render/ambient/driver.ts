import { Ctl, Light, SigMode, gapOk, headLight, limitAt, loopGapFree, mod2pi, mustStop, pointAt, projectNear, wrapPi, type NetNode, type RoadNet, type Stop } from './roadnet';

/*
 * Driving by the rules on the lane graph (pure logic, no three.js; the
 * render-side Traffic wraps it with fleeing, wrecks and drawing, the tests
 * run it headless):
 *
 *  - keep the right lane by pure pursuit of a carrot point ahead on it;
 *  - speed limit of the zone (villages / city slower), slow for bends and turns;
 *  - pick the exit at the next junction early and blink the indicator;
 *  - stop at the stop line on red and amber (unless too close to stop), queue
 *    with spacing, pull away on green with a small reaction delay per car;
 *  - side roads give way to the main road (time-gap acceptance), roundabout
 *    entries give way to circulating traffic, then circulate counter-clockwise
 *    (on screen) to the chosen exit; dead ends are turned on their turning circle;
 *  - turning round anywhere else (blocked road, broken bridge, a dead end
 *    without room for a circle) is a 3-point turn kept on the road surface.
 *
 * Panicking cars (combat close by) ignore lights and priority.
 */

export interface DriveCar {
  /** Unique, for tie-breaks. */
  id: number;
  kind: number;
  /** Body length (tiles). */
  len: number;
  line: number;
  arc: number;
  dir: number;
  x: number;
  y: number;
  yaw: number;
  v: number;
  cruise: number;
  /** Roundabout being circulated (-1 none), current angle, radians left to the exit, exit arm. */
  loop: number;
  ang: number;
  left: number;
  exit: number;
  /** Node the plan is for, planned exit arm (-1: none possible -> turn round). */
  planNode: number;
  plan: number;
  /** Node just passed (its stop is skipped while still close). */
  passed: number;
  /** Indicator: -1 left, 1 right, 0 off; hold time after the turn. */
  ind: number;
  indT: number;
  /** Start delay: time since it could go, delay of this start. */
  go: number;
  delay: number;
  /** 3-point turn phase (0 none, 1 forward, 2 reverse, 3 forward) and the direction it ends in. */
  kt: number;
  ktDir: number;
  /** Node where it ran an amber light (no second thoughts). */
  commit: number;
  /** Waiting at a stop / give-way line (s). */
  waitT: number;
  waiting: boolean;
  panic: number;
  brake: number;
  /** Extra offset to the right while passing an oncoming car on a narrow track (0..1). */
  aside: number;
  /** Parking: 0 no, 1 to the bay's turn-in point, 2 into the bay, 3 parked, 4 backing out; lot, bay, timer. */
  pk: number;
  lot: number;
  bay: number;
  pkT: number;
}

/** Other cars as the rules see them. */
export interface OtherCar {
  id: number;
  x: number;
  y: number;
  yaw: number;
  v: number;
  loop: number;
  ang: number;
  left: number;
  line: number;
  dir: number;
  /** Still driving (not wrecked / abandoned / swerving off). */
  driving: boolean;
}

let nextId = 1;

export function newDriveCar(kind: number, len: number, line: number, arc: number, dir: number, x: number, y: number, yaw: number, cruise: number): DriveCar {
  return {
    id: nextId++,
    kind,
    len,
    line,
    arc,
    dir,
    x,
    y,
    yaw,
    v: 0,
    cruise,
    loop: -1,
    ang: 0,
    left: 0,
    exit: 0,
    planNode: -1,
    plan: -1,
    passed: -1,
    ind: 0,
    indT: 0,
    go: 0,
    delay: 0.5,
    kt: 0,
    ktDir: 1,
    commit: -1,
    waitT: 0,
    waiting: false,
    panic: 0,
    brake: 0,
    aside: 0,
    pk: 0,
    lot: -1,
    bay: -1,
    pkT: 0,
  };
}

export interface DriveResult {
  /** Stuck behind a non-driving obstacle (wreck, abandoned car) or a unit. */
  blocked: boolean;
  /** The road ahead bends (rad over the next tile). */
  curve: number;
}

const out: DriveResult = { blocked: false, curve: 0 };
/** How far a car backs out of its bay (tiles, nose past the aisle edge). */
const BACK = 0.75;

export class Driver {
  /** Minimum turning radius (tiles). */
  static rho(kind: number) {
    return kind === 3 ? 0.34 : 0.3;
  }

  constructor(
    readonly net: RoadNet,
    /** Can the cars use this line (bridge decks: still standing)? */
    private usable: (line: number) => boolean = () => true,
    private rand: () => number = Math.random,
  ) {}

  /** The next junction approach ahead on the car's line, or null. */
  nextStop(c: DriveCar): Stop | null {
    const L = this.net.lines[c.line];
    let best: Stop | null = null;
    let bd = 1e9;
    for (const st of L.stops) {
      if (st.dir !== c.dir) continue;
      const d = (st.arc - c.arc) * c.dir;
      if (d < -0.3 || d >= bd) continue;
      if (st.node === c.passed && d < 1.5) continue;
      best = st;
      bd = d;
    }
    return best;
  }

  /** Pick the exit arm at `node` arriving through arm `inArm` (-1: nowhere to go). */
  choose(c: DriveCar, node: NetNode, inArm: number): number {
    const arms = node.arms;
    const loop = node.ctl === Ctl.Loop;
    if (arms.length === 1) return loop || node.ctl === Ctl.Lot ? 0 : -1;
    const inA = arms[inArm];
    const inHead = inA.ang + Math.PI;
    let tot = 0;
    for (let pass = 0; pass < 2; pass++) {
      let r = pass ? this.rand() * tot : 0;
      for (let j = 0; j < arms.length; j++) {
        const a = arms[j];
        if (j === inArm || !this.usable(a.line)) continue;
        // a car never turns back onto the line it came along (that's a U-turn)
        if (a.line === inA.line && a.dir === inA.dir) continue;
        const L = this.net.lines[a.line];
        let wgt = c.kind === 3 ? (L.paved ? 0.5 : 1.4) : L.paved ? 1 : 0.25;
        const turn = Math.abs(wrapPi(a.ang - inHead));
        if (turn < 0.5) wgt *= 1.6; // straight on is the usual way
        // a hairpin turn off a junction isn't drivable (roundabouts are fine)
        if (turn > 2.1 && !loop) continue;
        if (pass === 0) tot += wgt;
        else if ((r -= wgt) <= 0) return j;
      }
      if (tot <= 0) break;
    }
    // nothing usable: round the roundabout back, or turn round
    return loop ? inArm : -1;
  }

  /** Indicator for a turn from arm `inArm` to arm `exit` at `node`. */
  private turnSide(node: NetNode, inArm: number, exit: number): number {
    if (exit < 0 || node.ctl === Ctl.Loop) return 0;
    const turn = wrapPi(node.arms[exit].ang - (node.arms[inArm].ang + Math.PI));
    return Math.abs(turn) < 0.45 ? 0 : turn > 0 ? 1 : -1;
  }

  /** Must the car wait at the hold line of this approach? */
  private mustWait(c: DriveCar, node: NetNode, st: Stop, holdD: number, cars: readonly OtherCar[], time: number): boolean {
    const net = this.net;
    const arm = node.arms[st.arm];
    if (node.ctl === Ctl.Loop) {
      const lp = net.loops[node.loop];
      return !loopGapFree(node.loop, arm.inAng, lp.rl, cars, c);
    }
    let yieldNow = node.ctl === Ctl.Yield;
    if (node.ctl === Ctl.Signal) {
      const sg = net.signals[node.signal];
      if (sg.mode === SigMode.Normal) {
        const light = headLight(sg.mode, time + sg.offset, arm.axis);
        if (!mustStop(light, holdD, c.v)) {
          if (light === Light.Amber) c.commit = st.node;
          // green: still don't block the junction box
          return this.boxBusy(c, node, cars, 0.55);
        }
        return true;
      }
      // lights out / blinking amber: priority to the main road
      yieldNow = true;
    }
    if (!yieldNow || arm.major) return false;
    if (c.waitT > 10) return false; // nobody waits forever
    return !this.crossFree(c, node, cars);
  }

  /** Some other car is in the middle of the junction. */
  private boxBusy(c: DriveCar, node: NetNode, cars: readonly OtherCar[], r: number): boolean {
    for (const o of cars) {
      if (o === (c as unknown) || !o.driving) continue;
      if (Math.hypot(o.x - node.x, o.y - node.y) < r && o.v > 0.02) return true;
    }
    return false;
  }

  /** Give way: no car on the main road closer than the critical gap, the junction box empty. */
  private crossFree(c: DriveCar, node: NetNode, cars: readonly OtherCar[]): boolean {
    let box = 0.5;
    for (const a of node.arms) box = Math.max(box, this.net.lines[a.line].half + 0.25);
    for (const o of cars) {
      if (o === (c as unknown) || !o.driving) continue;
      const dx = node.x - o.x;
      const dy = node.y - o.y;
      const d = Math.hypot(dx, dy);
      if (d > 7) continue;
      if (d < box * 0.85) return false; // someone in the junction
      if (o.loop >= 0 || !node.majorLines.includes(o.line)) continue;
      // heading for the junction on the main road
      if ((dx * Math.cos(o.yaw) + dy * Math.sin(o.yaw)) / (d || 1) < 0.5) continue;
      if (!gapOk(d - box, o.v)) return false;
    }
    return true;
  }

  /** Leave the line at a node: hop to the planned arm / onto the roundabout / turn round. */
  private transit(c: DriveCar, node: NetNode, st: Stop) {
    const net = this.net;
    c.passed = st.node;
    c.commit = -1;
    c.waitT = 0;
    if (c.plan >= 0 && !this.usable(node.arms[c.plan].line)) c.plan = this.choose(c, node, st.arm);
    if (node.ctl === Ctl.Lot) {
      if (!this.startPark(c, node.lot)) this.startTurn(c);
      return;
    }
    if (node.ctl === Ctl.Loop) {
      const lp = net.loops[node.loop];
      const ex = c.plan >= 0 ? c.plan : st.arm;
      c.loop = node.loop;
      c.exit = ex;
      c.ang = Math.atan2(c.y - lp.y, c.x - lp.x);
      let left = mod2pi(c.ang - node.arms[ex].outAng);
      if (left < 0.5) left += Math.PI * 2;
      c.left = left;
      c.ind = 0;
      c.planNode = -1;
      return;
    }
    if (c.plan < 0) {
      this.startTurn(c);
      return;
    }
    const ex = node.arms[c.plan];
    if (!(ex.line === c.line && ex.dir === c.dir)) {
      c.line = ex.line;
      c.arc = ex.arc;
      c.dir = ex.dir;
    }
    c.planNode = -1;
    if (c.ind) c.indT = 1.2;
  }

  /** Pick a free bay ahead in the lot's aisle; false when the lot is full. */
  startPark(c: DriveCar, li: number): boolean {
    const lot = this.net.lots[li];
    if (!lot) return false;
    const s0 = (c.x - lot.x) * lot.ux + (c.y - lot.y) * lot.uy;
    let n = 0;
    for (let k = 0; k < lot.bays.length; k++) {
      const b = lot.bays[k];
      if (lot.taken[k] || (b.ax - lot.x) * lot.ux + (b.ay - lot.y) * lot.uy < s0 + 0.45) continue;
      n++;
    }
    if (!n) return false;
    let r = Math.floor(this.rand() * n);
    for (let k = 0; k < lot.bays.length; k++) {
      const b = lot.bays[k];
      if (lot.taken[k] || (b.ax - lot.x) * lot.ux + (b.ay - lot.y) * lot.uy < s0 + 0.45) continue;
      if (r-- > 0) continue;
      lot.taken[k] = c.id;
      c.pk = 1;
      c.lot = li;
      c.bay = k;
      // indicate towards the bay's side of the aisle (right of the travel direction = (-uy, ux))
      c.ind = Math.cos(b.yaw) * -lot.uy + Math.sin(b.yaw) * lot.ux > 0 ? 1 : -1;
      c.indT = 0;
      return true;
    }
    return false;
  }

  /** Park a car in a bay right away (cars already parked when the map starts). */
  parkAt(c: DriveCar, li: number, k: number, time: number) {
    const lot = this.net.lots[li];
    const b = lot.bays[k];
    lot.taken[k] = c.id;
    c.pk = 3;
    c.lot = li;
    c.bay = k;
    c.pkT = time;
    c.x = b.x;
    c.y = b.y;
    c.yaw = b.yaw;
    c.v = 0;
    c.line = lot.line;
    c.loop = -1;
  }

  /** Drive towards (tx, ty) (forwards, or backwards: the rear leads) with the turning radius limit. */
  private toward(c: DriveCar, tx: number, ty: number, vt: number, dt: number) {
    const rev = vt < 0;
    const want = rev ? Math.atan2(c.y - ty, c.x - tx) : Math.atan2(ty - c.y, tx - c.x);
    const dyaw = wrapPi(want - c.yaw);
    const maxTurn = (Math.abs(c.v) / Driver.rho(c.kind) + 0.02) * dt;
    c.yaw = wrapPi(c.yaw + Math.max(-maxTurn, Math.min(maxTurn, dyaw)));
    const acc = 0.8 * dt;
    c.v = vt > c.v ? Math.min(vt, c.v + acc) : Math.max(vt, c.v - acc * 2);
    c.x += Math.cos(c.yaw) * c.v * dt;
    c.y += Math.sin(c.yaw) * c.v * dt;
  }

  /** In a parking lot: turn into the bay, stay a while, back out and leave down the aisle. */
  private parkStep(c: DriveCar, cars: readonly OtherCar[], dt: number) {
    const lot = this.net.lots[c.lot];
    const b = lot.bays[c.bay];
    c.waiting = false;
    if (c.pk === 1) {
      // the turn-in point: on the aisle a little before the bay
      const tx = b.ax - lot.ux * 0.3;
      const ty = b.ay - lot.uy * 0.3;
      this.toward(c, tx, ty, 0.32, dt);
      if (Math.hypot(tx - c.x, ty - c.y) < 0.2 || (c.x - tx) * lot.ux + (c.y - ty) * lot.uy > 0) c.pk = 2;
    } else if (c.pk === 2) {
      const tx = b.x + Math.cos(b.yaw) * 0.06;
      const ty = b.y + Math.sin(b.yaw) * 0.06;
      const d = Math.hypot(tx - c.x, ty - c.y);
      this.toward(c, tx, ty, Math.min(0.25, d * 1.2 + 0.03), dt);
      if (d < 0.1 || (c.x - b.x) * Math.cos(b.yaw) + (c.y - b.y) * Math.sin(b.yaw) > 0.05) {
        c.pk = 3;
        c.v = 0;
        c.ind = 0;
        c.pkT = 12 + this.rand() * 50;
      }
    } else if (c.pk === 3) {
      c.v = 0;
      c.yaw += wrapPi(b.yaw - c.yaw) * Math.min(1, dt * 2);
      c.pkT -= dt;
      if (c.pkT <= 0) {
        // back out once the aisle behind is clear
        let busy = false;
        for (const o of cars) if (o !== (c as unknown) && o.driving && Math.hypot(o.x - b.ax, o.y - b.ay) < 0.8) busy = true;
        if (!busy) {
          c.pk = 4;
          c.ind = 0;
        } else c.pkT = 1;
      }
    } else {
      // back out so the nose ends up pointing to the exit (the aisle's entry end)
      const tx = b.ax + lot.ux * 0.32;
      const ty = b.ay + lot.uy * 0.32;
      this.toward(c, tx, ty, -0.16, dt);
      if (Math.hypot(tx - c.x, ty - c.y) < 0.16 || (b.x - c.x) * Math.cos(b.yaw) + (b.y - c.y) * Math.sin(b.yaw) > BACK) {
        // drive off down the aisle and out along the access lane
        lot.taken[c.bay] = 0;
        const L = this.net.lines[lot.line];
        c.pk = 0;
        c.v = 0;
        c.line = lot.line;
        c.dir = -1;
        c.arc = Math.max(0, Math.min(L.len, (L.len - 0.3) - Math.max(0, (lot.x + lot.ux * (lot.L / 2 - 0.25) - c.x) * lot.ux + (lot.y + lot.uy * (lot.L / 2 - 0.25) - c.y) * lot.uy)));
        c.planNode = -1;
        c.passed = -1;
        c.go = 0;
      }
    }
    c.brake = c.pk === 3 ? 0 : Math.abs(c.v) < 0.03 ? 1 : 0;
  }

  /** Start a 3-point turn (ends driving the other way along the same line). */
  startTurn(c: DriveCar) {
    if (c.kt || c.loop >= 0) return;
    c.kt = 1;
    c.ktDir = -c.dir;
    c.waitT = 0;
    c.ind = -1;
    c.indT = 0;
    c.planNode = -1;
    c.waiting = false;
  }

  /**
   * One step of rule-abiding driving. `cars` are all cars (self included,
   * skipped); `nearUnit` the distance to the closest military ground unit.
   */
  step(c: DriveCar, cars: readonly OtherCar[], time: number, dt: number, nearUnit = 1e9): DriveResult {
    out.blocked = false;
    out.curve = 0;
    if (c.kt) {
      this.turnStep(c, dt);
      return out;
    }
    if (c.pk) {
      this.parkStep(c, cars, dt);
      return out;
    }
    const net = this.net;
    const rho = Driver.rho(c.kind);
    let cx = c.x;
    let cy = c.y;
    let curve = 0;
    let vt = c.cruise;
    const fleeing = c.panic > 0;
    c.waiting = false;
    let holdD = -1;
    let slowTo = 1e9;
    for (let pass = 0; pass < 2; pass++) {
      if (c.loop >= 0) {
        // circulating: counter-clockwise on screen = tile angle decreasing
        const lp = net.loops[c.loop];
        const a = Math.atan2(c.y - lp.y, c.x - lp.x);
        const da = wrapPi(c.ang - a);
        c.ang = a;
        if (da > 0) c.left -= da;
        if (c.left <= 0.3) {
          // leave along the exit arm
          const node = net.nodes[lp.node];
          const ex = node.arms[c.exit];
          c.loop = -1;
          c.line = ex.line;
          c.arc = ex.edge;
          c.dir = ex.dir;
          c.passed = lp.node;
          c.ind = 1;
          c.indT = 0.8;
          continue;
        }
        const look = 0.28 + c.v * 0.3;
        const ca = a - look / lp.rl;
        cx = lp.x + Math.cos(ca) * lp.rl;
        cy = lp.y + Math.sin(ca) * lp.rl;
        vt = Math.min(vt, 0.22 + lp.rl * 0.3);
        // signal right just before the exit
        c.ind = c.left < 1.3 ? 1 : 0;
        break;
      }
      const L = net.lines[c.line];
      c.arc = projectNear(L, c.arc, c.x, c.y);
      const st = this.nextStop(c);
      if (st) {
        const node = net.nodes[st.node];
        const dist = (st.arc - c.arc) * c.dir;
        if (c.planNode !== st.node && dist < 5) {
          c.planNode = st.node;
          c.plan = this.choose(c, node, st.arm);
        }
        if (c.planNode === st.node) {
          if (dist < 3.4) c.ind = this.turnSide(node, st.arm, c.plan);
          // turning: slow down for the corner; roundabouts: slow to enter
          if (node.ctl === Ctl.Loop) slowTo = 0.35 + dist * 0.45;
          else if (c.plan >= 0 && Math.abs(wrapPi(node.arms[c.plan].ang - (node.arms[st.arm].ang + Math.PI))) > 0.5) slowTo = 0.32 + dist * 0.4;
        }
        let wait = false;
        const hd = (st.hold - c.arc) * c.dir;
        if (!fleeing && c.commit !== st.node && hd > -0.05 && node.ctl !== Ctl.Free && node.ctl !== Ctl.Turn) {
          wait = this.mustWait(c, node, st, hd, cars, time);
          if (wait) holdD = Math.max(0, hd);
        }
        // (dead end without a turning place: start the 3-point turn with road left ahead)
        const hop = node.ctl === Ctl.Lot ? net.lots[node.lot].L - 0.55 : node.ctl === Ctl.Turn ? 1.1 : node.ctl === Ctl.Loop ? 0.08 : st.arc <= 0.01 || st.arc >= L.len - 0.01 ? 0.3 : 0.1;
        if (!wait && dist <= hop) {
          this.transit(c, node, st);
          if (c.kt) {
            this.turnStep(c, dt);
            return out;
          }
          if (c.pk) {
            this.parkStep(c, cars, dt);
            return out;
          }
          continue;
        }
      }
      // lane following: carrot ahead on the right lane
      const L2 = net.lines[c.line];
      const p0 = pointAt(L2, c.arc);
      const t0 = Math.atan2(p0.ty * c.dir, p0.tx * c.dir);
      // still off this road (coming along the link from a track end that stops short): head straight onto it
      const offRoad = Math.hypot(c.x - p0.x, c.y - p0.y) > L2.half + 0.05;
      const look = offRoad ? 0.1 : 0.32 + c.v * 0.3;
      const pa = pointAt(L2, c.arc + c.dir * look);
      // narrow tracks: pull over to the right to pass oncoming traffic
      const lane = L2.lane + c.aside * Math.max(0, L2.half - (L2.paved ? 0.12 : 0.08) - L2.lane);
      cx = pa.x - pa.ty * c.dir * lane;
      cy = pa.y + pa.tx * c.dir * lane;
      const pb = pointAt(L2, c.arc + c.dir * 1.3);
      curve = Math.abs(wrapPi(Math.atan2(pb.ty * c.dir, pb.tx * c.dir) - t0));
      vt *= limitAt(L2, c.arc);
      break;
    }
    out.curve = curve;
    if (c.indT > 0) {
      c.indT -= dt;
      if (c.indT <= 0) c.ind = 0;
    }
    // steering: limited by the turning radius (no turning on the spot)
    const want = Math.atan2(cy - c.y, cx - c.x);
    const dyaw = wrapPi(want - c.yaw);
    const maxTurn = (Math.abs(c.v) / rho + 0.04) * dt;
    c.yaw = wrapPi(c.yaw + Math.max(-maxTurn, Math.min(maxTurn, dyaw)));
    // speed: cruise / zone limit, slower in bends and turns, faster when fleeing
    vt *= fleeing ? (c.kind === 3 ? 1.5 : 1.9) : 1;
    vt *= 1 - Math.min(0.65, curve * 0.55);
    vt *= 1 - Math.min(0.7, Math.abs(dyaw) * 0.6);
    if (!fleeing) vt = Math.min(vt, slowTo);
    if (holdD >= 0) {
      // smooth stop with the front bumper at the line
      vt = Math.min(vt, Math.sqrt(2 * 1.1 * Math.max(0, holdD - 0.02)));
      c.waiting = true;
    }
    // traffic ahead (cars, wrecks) and units in the road
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    let meet = false;
    for (const o of cars) {
      if (o === (c as unknown)) continue;
      const dx = o.x - c.x;
      const dy = o.y - c.y;
      const along = dx * hx + dy * hy;
      if (along <= 0 || along > 3.5) continue;
      const lat = Math.abs(dx * -hy + dy * hx);
      const oncoming = o.driving && Math.cos(o.yaw - c.yaw) < -0.3;
      if (oncoming && lat < 0.3) {
        // head-on in one lane (narrow track, roads sharing a corridor): both pull over to the right and pass slowly
        meet = true;
        vt = Math.min(vt, 0.25 + along * 0.2);
        continue;
      }
      if (along > 1.4 || lat > 0.19) continue;
      // converging at an angle and each in the other's way: the lower id goes first
      if (o.driving && !oncoming && o.v > -0.01) {
        const ox = Math.cos(o.yaw);
        const oy = Math.sin(o.yaw);
        const back = -dx * ox - dy * oy;
        if (back > 0 && back < 1.4 && Math.abs(-dx * -oy + -dy * ox) < 0.19 && c.id < o.id) continue;
      }
      // keep ~0.2 tiles between bumpers in a queue, more at speed
      const gap = along - 0.68;
      vt = Math.min(vt, Math.max(0, gap * 1.8 + (o.driving ? Math.max(0, o.v) * 0.7 : 0)));
      if (gap < 0.25 && !o.driving) out.blocked = true;
    }
    c.aside = meet ? Math.min(1, c.aside + dt * 2.5) : Math.max(0, c.aside - dt * 0.8);
    if (nearUnit < 1.6) {
      vt = Math.min(vt, Math.max(0, (nearUnit - 0.9) * 0.8));
      if (nearUnit < 1.2) out.blocked = true;
    }
    // reaction time when pulling away from a stop
    if (c.v < 0.03 && !fleeing) {
      if (vt > 0.015) {
        c.go += dt;
        if (c.go < c.delay) vt = 0;
      } else {
        c.go = 0;
        c.delay = 0.3 + this.rand() * 0.55;
      }
    } else c.go = 0;
    if (c.waiting && c.v < 0.05) c.waitT += dt;
    const acc = fleeing ? 1.6 : 0.7;
    const prevV = c.v;
    c.v = vt > c.v ? Math.min(vt, c.v + acc * dt) : Math.max(vt, c.v - 2.4 * dt);
    c.brake = c.v < prevV - 0.5 * dt || (c.v < 0.02 && c.waiting) ? 1 : Math.max(0, c.brake - dt * 3);
    c.x += hx * c.v * dt;
    c.y += hy * c.v * dt;
    return out;
  }

  /** 3-point turn on the road surface: forward-left, reverse-right, forward-left until it faces the other way. */
  private turnStep(c: DriveCar, dt: number) {
    const net = this.net;
    const L = net.lines[c.line];
    c.arc = projectNear(L, c.arc, c.x, c.y);
    const p = pointAt(L, c.arc);
    const d0 = -c.ktDir; // original travel direction
    const tx = p.tx * d0;
    const ty = p.ty * d0;
    const px = p.x;
    const py = p.y;
    // right of the original direction
    const nx = -ty;
    const ny = tx;
    const target = Math.atan2(-ty, -tx);
    // turning left = tile angle decreasing
    const rem = mod2pi(c.yaw - target);
    if (rem < 0.12 || rem > Math.PI * 2 - 0.25) {
      c.kt = 0;
      c.dir = c.ktDir;
      c.planNode = -1;
      c.passed = -1;
      c.ind = 0;
      c.go = 0;
      return;
    }
    const half = Math.max(L.half, 0.42) - 0.06;
    const hx = Math.cos(c.yaw);
    const hy = Math.sin(c.yaw);
    const reach = c.len / 2 + 0.04;
    const latF = (c.x + hx * reach - px) * nx + (c.y + hy * reach - py) * ny;
    const latB = (c.x - hx * reach - px) * nx + (c.y - hy * reach - py) * ny;
    const rho = Driver.rho(c.kind);
    let vt: number;
    if (c.kt === 2) {
      vt = -0.16;
      if (latB > half || rem < 1.1) c.kt = 3;
    } else {
      vt = 0.2;
      if (latF < -half && rem > 0.5) c.kt = 2;
    }
    if ((c.kt === 2 && c.v > 0) || (c.kt !== 2 && c.v < 0)) vt = 0; // stop before changing gear
    const acc = 0.9 * dt;
    c.v = vt > c.v ? Math.min(vt, c.v + acc) : Math.max(vt, c.v - acc);
    // forward with left lock / reverse with right lock: both swing the nose left
    const steerLeft = c.kt !== 2;
    c.yaw = wrapPi(c.yaw + (steerLeft ? -1 : 1) * (c.v / rho) * dt);
    c.x += Math.cos(c.yaw) * c.v * dt;
    c.y += Math.sin(c.yaw) * c.v * dt;
    c.brake = Math.abs(c.v) < 0.03 ? 1 : 0;
    c.ind = -1;
    // a turn that can't be finished (blocked in a narrow lane): give up and drive off the other way
    c.waitT += dt;
    if (c.waitT > 20) {
      c.kt = 0;
      c.dir = c.ktDir;
      c.waitT = 0;
    }
  }
}
