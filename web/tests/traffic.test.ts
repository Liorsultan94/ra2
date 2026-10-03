import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { Tile, type MapId } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { roadClear, roadNetFor } from '../src/render/ambient/clearance';
import { Driver, newDriveCar, type DriveCar } from '../src/render/ambient/driver';
import {
  Ctl,
  Light,
  SIGNAL_TIMING,
  SigMode,
  gapOk,
  headLight,
  loopGapFree,
  mustStop,
  onSurface,
  pointAt,
  signalCycle,
  signalLight,
  type RoadNet,
} from '../src/render/ambient/roadnet';

const MAPS: MapId[] = ['frontline', 'desert', 'winter', 'urban'];

const nets = new Map<MapId, RoadNet>();
function net(id: MapId): RoadNet {
  let n = nets.get(id);
  if (!n) {
    const m = createMap(id, 1);
    // the lane graph the layout was fitted to (built while laying it out)
    n = roadNetFor(m, buildLayout(m));
    nets.set(id, n);
  }
  return n;
}

/** Deterministic random numbers for the headless runs. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type SimCar = DriveCar & { driving: boolean; id: number; loops: number; turned: number };

/** Headless traffic: cars spawned along the network, driving by the rules; leaving at the map edge respawns them. */
function simulate(n: RoadNet, cars: number, seconds: number, seed: number, onStep?: (c: SimCar, t: number) => void) {
  const rand = rng(seed);
  const drv = new Driver(n, () => true, rand);
  const list: SimCar[] = [];
  let id = 0;
  const spawn = () => {
    const lines = n.lines.filter((L) => L.bridge < 0 && L.a1 - L.a0 > 1.5);
    for (let tries = 0; tries < 50; tries++) {
      const li = n.lines.indexOf(lines[Math.floor(rand() * lines.length)]);
      const L = n.lines[li];
      const arc = L.a0 + 0.5 + rand() * (L.a1 - L.a0 - 1);
      const dir = rand() < 0.5 ? 1 : -1;
      const p = pointAt(L, arc);
      const x = p.x - p.ty * dir * L.lane;
      const y = p.y + p.tx * dir * L.lane;
      if (!onSurface(n, x, y) || n.loops.some((lp) => Math.hypot(lp.x - x, lp.y - y) < lp.R + 0.3)) continue;
      if (n.nodes.some((nd) => nd.arms.length > 1 && Math.hypot(nd.x - x, nd.y - y) < 2.5)) continue;
      if (list.some((o) => Math.hypot(o.x - x, o.y - y) < 1.2)) continue;
      const kind = L.paved ? Math.floor(rand() * 3) : 3;
      const c = newDriveCar(kind, kind === 1 ? 0.56 : 0.5, li, arc, dir, x, y, Math.atan2(p.ty * dir, p.tx * dir), [1.25, 1.05, 1.1, 0.5][kind] * (L.paved ? 1 : 0.62)) as SimCar;
      c.driving = true;
      c.id = id++;
      c.loops = 0;
      c.turned = 0;
      list.push(c);
      return;
    }
  };
  for (let i = 0; i < cars; i++) spawn();
  const dt = 0.05;
  for (let t = 0; t < seconds; t += dt) {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      const inLoop = c.loop;
      const kt = c.kt;
      drv.step(c, list, t, dt);
      if (inLoop < 0 && c.loop >= 0) c.loops++;
      if (kt && !c.kt) c.turned++;
      onStep?.(c, t);
      const L = n.lines[c.line];
      if (c.loop < 0 && !c.kt && ((c.dir > 0 && L.portal[1] && c.arc > L.len - 0.3) || (c.dir < 0 && L.portal[0] && c.arc < 0.3))) {
        list.splice(i, 1);
        spawn();
      }
    }
  }
  return list;
}

describe('traffic signals', () => {
  it('cycles green -> amber -> all red per axis, the two axes never green together', () => {
    const tm = SIGNAL_TIMING;
    const T = signalCycle(tm);
    expect(T).toBeCloseTo((tm.green + tm.amber + tm.clear) * 2);
    expect(signalLight(0, 0)).toBe(Light.Green);
    expect(signalLight(tm.green - 0.01, 0)).toBe(Light.Green);
    expect(signalLight(tm.green + 0.01, 0)).toBe(Light.Amber);
    expect(signalLight(tm.green + tm.amber + 0.01, 0)).toBe(Light.Red);
    // all-red clearance: both axes red between one amber and the other green
    expect(signalLight(tm.green + tm.amber + 0.01, 1)).toBe(Light.Red);
    expect(signalLight(tm.green + tm.amber + tm.clear + 0.01, 1)).toBe(Light.Green);
    expect(signalLight(tm.green + tm.amber + tm.clear + 0.01, 0)).toBe(Light.Red);
    let green0 = 0;
    let amber0 = 0;
    let allRed = 0;
    const step = 0.01;
    for (let t = -T; t < T * 3; t += step) {
      const a = signalLight(t, 0);
      const b = signalLight(t, 1);
      expect(a === Light.Green && b !== Light.Red).toBe(false);
      expect(b === Light.Green && a !== Light.Red).toBe(false);
      if (t >= 0 && t < T) {
        if (a === Light.Green) green0 += step;
        if (a === Light.Amber) amber0 += step;
        if (a === Light.Red && b === Light.Red) allRed += step;
      }
    }
    expect(green0).toBeCloseTo(tm.green, 1);
    expect(amber0).toBeCloseTo(tm.amber, 1);
    expect(allRed).toBeCloseTo(tm.clear * 2, 1);
    // periodic
    for (const t of [0.3, 5, 11.7, 17.2]) expect(signalLight(t + T * 7, 1)).toBe(signalLight(t, 1));
  });

  it('failed signals blink amber or stay dark', () => {
    let on = 0;
    for (let t = 0; t < 10; t += 0.01) {
      const l = headLight(SigMode.Flash, t, 0);
      expect(l === Light.Amber || l === Light.Off).toBe(true);
      if (l === Light.Amber) on++;
    }
    expect(on).toBeGreaterThan(300);
    expect(on).toBeLessThan(700);
    expect(headLight(SigMode.Dark, 3, 1)).toBe(Light.Off);
  });

  it('stops on red and amber unless too close to stop', () => {
    expect(mustStop(Light.Red, 3, 1)).toBe(true);
    expect(mustStop(Light.Red, 0.01, 1.2)).toBe(true);
    expect(mustStop(Light.Green, 0.5, 1)).toBe(false);
    expect(mustStop(Light.Amber, 3, 1)).toBe(true);
    // 1.2 tiles/s, 0.2 tiles before the line: can't stop comfortably -> goes
    expect(mustStop(Light.Amber, 0.2, 1.2)).toBe(false);
    expect(mustStop(Light.Off, 1, 1)).toBe(false);
  });
});

describe('yield gap acceptance', () => {
  it('accepts a gap by time and distance', () => {
    expect(gapOk(0.5, 0)).toBe(false); // in the way
    expect(gapOk(3, 0)).toBe(true); // parked / waiting further away
    expect(gapOk(3, 1.2, 2.2, 0.8)).toBe(false); // (3 - 0.8) / 1.2 = 1.8 s < 2.2 s
    expect(gapOk(4, 1.2, 2.2, 0.8)).toBe(true); // 2.7 s
    expect(gapOk(10, 5, 2.2, 0.8)).toBe(false); // fast car
  });

  it('roundabout entries give way to circulating traffic', () => {
    const rl = 1.1;
    const entry = 1.0;
    const car = (ang: number, v = 0.6, left = 5, loop = 0) => ({ loop, ang, v, left });
    // empty roundabout
    expect(loopGapFree(0, entry, rl, [], null)).toBe(true);
    // a car circulating towards the entry, close upstream: wait
    expect(loopGapFree(0, entry, rl, [car(entry + 0.6)], null)).toBe(false);
    // far upstream (about 3/4 of a turn away): go
    expect(loopGapFree(0, entry, rl, [car(entry + 4.5)], null)).toBe(true);
    // on the merge point / just past it: wait
    expect(loopGapFree(0, entry, rl, [car(entry - 0.2)], null)).toBe(false);
    // well past the entry (driving away): go
    expect(loopGapFree(0, entry, rl, [car(entry - 1.2, 0.6, 1)], null)).toBe(true);
    // close upstream but it leaves at an exit before the entry: go
    expect(loopGapFree(0, entry, rl, [car(entry + 0.9, 0.6, 0.3)], null)).toBe(true);
    // a car on another roundabout doesn't matter
    expect(loopGapFree(0, entry, rl, [car(entry + 0.6, 0.6, 5, 1)], null)).toBe(true);
    // self is skipped
    const me = car(entry + 0.6);
    expect(loopGapFree(0, entry, rl, [me], me)).toBe(true);
  });
});

describe('lane graph', () => {
  for (const id of MAPS) {
    it(`${id}: every dead end has a turning place, turning circles sit on free ground`, () => {
      const n = net(id);
      expect(n.lines.length).toBeGreaterThan(5);
      const dead = n.nodes.filter((nd) => nd.arms.length === 1);
      expect(dead.length).toBeGreaterThan(0);
      for (const nd of dead) {
        const L = n.lines[nd.arms[0].line];
        // a parking lot's aisle: the cars park (and leave the way they came)
        if (nd.ctl === Ctl.Lot) {
          expect(n.lots[nd.lot].line).toBe(nd.arms[0].line);
          continue;
        }
        if (nd.ctl === Ctl.Turn) {
          // no room for a circle (squeezed between quay walls): a wide road, turned on with a 3-point turn
          expect(L.half).toBeGreaterThanOrEqual(1);
          continue;
        }
        expect(nd.ctl).toBe(Ctl.Loop);
        const lp = n.loops[nd.loop];
        expect(lp.dead).toBe(true);
        // paved: circle with an island; dirt track: gravel loop
        if (L.paved) {
          expect(lp.ri).toBeGreaterThan(0.3);
          expect(lp.rl - 0.12).toBeGreaterThan(lp.ri);
          expect(lp.rl + 0.12).toBeLessThan(lp.R);
        } else expect(lp.ri).toBe(0);
        // the whole circulating lane is drivable surface
        for (let k = 0; k < 32; k++) {
          const a = (k / 32) * Math.PI * 2;
          expect(onSurface(n, lp.x + Math.cos(a) * lp.rl, lp.y + Math.sin(a) * lp.rl)).toBe(true);
        }
        // and the island isn't
        if (lp.ri > 0) expect(onSurface(n, lp.x, lp.y)).toBe(false);
      }
      // every non-portal line end belongs to a node
      n.lines.forEach((L, li) => {
        for (const e of [0, 1]) {
          if (L.portal[e]) continue;
          const arc = e ? L.len : 0;
          // (or the junction it overshoots by a stub, which is never driven: outside the drivable range)
          const ok = n.nodes.some((nd) => nd.arms.some((a) => a.line === li && Math.abs(a.arc - arc) < 0.05)) || (e ? L.a1 < L.len - 0.2 : L.a0 > 0.2);
          expect(ok, `line ${li} end ${e}`).toBe(true);
        }
      });
    });

    it(`${id}: lanes and turning circles stay on the road surface`, () => {
      const n = net(id);
      for (const L of n.lines) {
        for (let a = L.a0; a <= L.a1; a += 0.2)
          for (const dir of [1, -1]) {
            const p = pointAt(L, a);
            const x = p.x - p.ty * dir * L.lane;
            const y = p.y + p.tx * dir * L.lane;
            // (through a roundabout the cars circulate instead)
            if (n.loops.some((lp) => Math.hypot(lp.x - x, lp.y - y) < lp.R)) continue;
            expect(onSurface(n, x, y), `line ${n.lines.indexOf(L)} arc ${a.toFixed(2)} at ${x.toFixed(2)},${y.toFixed(2)}`).toBe(true);
          }
      }
    });
  }

  it('the city gets signalled crossings, the countryside roundabouts and give-way junctions', () => {
    const urban = net('urban');
    expect(urban.signals.length).toBeGreaterThan(30);
    for (const sg of urban.signals) {
      const nd = urban.nodes[sg.node];
      // both phase groups have approaches
      expect(nd.arms.some((a) => a.axis === 0)).toBe(true);
      expect(nd.arms.some((a) => a.axis === 1)).toBe(true);
    }
    const desert = net('desert');
    expect(desert.loops.some((lp) => !lp.dead)).toBe(true);
    const frontline = net('frontline');
    expect(frontline.nodes.some((nd) => nd.ctl === Ctl.Yield)).toBe(true);
  });
});

describe('driving by the rules (headless)', () => {
  for (const id of MAPS) {
    it(`${id}: no car path leaves the road, dead ends are turned on the turning circle`, () => {
      const n = net(id);
      const off: string[] = [];
      let samples = 0;
      const still = new Map<number, number>();
      const parked = new Set<number>();
      let longest = 0;
      const list = simulate(n, 24, 200, 33 + id.length, (c, t) => {
        samples++;
        if (c.pk >= 2) parked.add(c.id);
        const s = c.v < 0.02 && c.pk !== 3 ? (still.get(c.id) ?? 0) + 0.05 : 0;
        still.set(c.id, s);
        longest = Math.max(longest, s);
        // the car body centre stays on the drivable surface (a hair of tolerance for corner cutting)
        let ok = onSurface(n, c.x, c.y);
        for (let k = 0; k < 8 && !ok; k++) ok = onSurface(n, c.x + Math.cos(k * 0.785) * 0.12, c.y + Math.sin(k * 0.785) * 0.12);
        if (!ok && off.length < 12) off.push(`t=${t.toFixed(1)} car ${c.id} at ${c.x.toFixed(2)},${c.y.toFixed(2)} line ${c.line} arc ${c.arc.toFixed(2)} dir ${c.dir} loop ${c.loop} kt ${c.kt}`);
      });
      expect(samples).toBeGreaterThan(1000);
      expect(off).toEqual([]);
      // traffic flows: most cars are moving at the end, nobody is stuck for good
      const moving = list.filter((c) => Math.abs(c.v) > 0.05 || c.waiting || c.pk === 3).length;
      expect(moving).toBeGreaterThan(list.length * 0.5);
      expect(list.reduce((s, c) => s + c.loops, 0)).toBeGreaterThan(0);
      // no gridlock: nobody stands still for half a minute (parked cars aside)
      expect(longest).toBeLessThan(30);
      // some cars turn into the parking lots and park
      if (n.lots.length) expect(parked.size).toBeGreaterThan(0);
    });
  }

  it('a car at a dead end turns round on the turning circle, not on the sand', () => {
    const n = net('desert');
    const lp = n.loops.find((l) => l.dead && l.paved)!;
    const nd = n.nodes[lp.node];
    const arm = nd.arms[0];
    const L = n.lines[arm.line];
    // start 6 tiles up the road, driving towards the dead end
    const arc = arm.edge + arm.dir * 6;
    const dir = -arm.dir;
    const p = pointAt(L, arc);
    const c = newDriveCar(0, 0.5, arm.line, arc, dir, p.x - p.ty * dir * L.lane, p.y + p.tx * dir * L.lane, Math.atan2(p.ty * dir, p.tx * dir), 1.25) as SimCar;
    c.driving = true;
    const drv = new Driver(n, () => true, rng(3));
    let entered = false;
    let maxLeft = 0;
    let minR = 1e9;
    let maxR = 0;
    for (let t = 0; t < 40 && !(entered && c.loop < 0 && c.dir === arm.dir && Math.hypot(c.x - lp.x, c.y - lp.y) > lp.R + 1); t += 0.05) {
      drv.step(c, [c], t, 0.05);
      if (c.loop >= 0) {
        entered = true;
        maxLeft = Math.max(maxLeft, c.left);
        const r = Math.hypot(c.x - lp.x, c.y - lp.y);
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
      }
      expect(onSurface(n, c.x, c.y)).toBe(true);
      expect(c.kt).toBe(0);
    }
    expect(entered).toBe(true);
    // nearly a full turn round the island, inside the paved ring
    expect(maxLeft).toBeGreaterThan(Math.PI * 1.5);
    expect(minR).toBeGreaterThan(lp.ri + 0.1);
    expect(maxR).toBeLessThan(lp.R + 0.25); // (entering from the road)
    // and drives back up the road on the other lane
    expect(c.dir).toBe(arm.dir);
    expect(c.line).toBe(arm.line);
  });

  for (const id of ['frontline', 'winter', 'urban'] as MapId[])
    it(`${id}: a 3-point turn (road blocked ahead) stays on the road and ends driving the other way`, () => {
      const n = net(id);
      const rand = rng(11);
      let tested = 0;
      for (let li = 0; li < n.lines.length && tested < 8; li++) {
        const L = n.lines[li];
        if (!L.paved || L.bridge >= 0 || L.a1 - L.a0 < 12) continue;
        // a straight-ish stretch away from junctions
        const arc = L.a0 + 4 + rand() * (L.a1 - L.a0 - 8);
        const p = pointAt(L, arc);
        if (n.nodes.some((nd) => Math.hypot(nd.x - p.x, nd.y - p.y) < 4)) continue;
        const dir = rand() < 0.5 ? 1 : -1;
        const c = newDriveCar(0, 0.5, li, arc, dir, p.x - p.ty * dir * L.lane, p.y + p.tx * dir * L.lane, Math.atan2(p.ty * dir, p.tx * dir), 1.2) as SimCar;
        c.v = 0.3;
        c.driving = true;
        const drv = new Driver(n, () => true, rng(2));
        drv.startTurn(c);
        let t = 0;
        let reversed = false;
        for (; t < 30 && c.kt; t += 0.05) {
          drv.step(c, [c], t, 0.05);
          if (c.v < -0.02) reversed = true;
          let ok = onSurface(n, c.x, c.y);
          for (let k = 0; k < 8 && !ok; k++) ok = onSurface(n, c.x + Math.cos(k * 0.785) * 0.1, c.y + Math.sin(k * 0.785) * 0.1);
          expect(ok, `${id} line ${li} t ${t.toFixed(2)} at ${c.x.toFixed(2)},${c.y.toFixed(2)}`).toBe(true);
        }
        expect(c.kt).toBe(0);
        expect(c.dir).toBe(-dir);
        // narrow country roads need the reverse leg, wide city streets may not
        if (L.half < 0.6) expect(reversed).toBe(true);
        tested++;
      }
      expect(tested).toBeGreaterThan(2);
    });

  it('the side road gives way to traffic on the main road', () => {
    const n = net('frontline');
    const nd = n.nodes.find((x) => x.ctl === Ctl.Yield && x.arms.some((a) => !a.major && (a.dir > 0 ? n.lines[a.line].len - a.arc : a.arc) > 4) && x.arms.filter((a) => a.major).every((a) => (a.dir > 0 ? n.lines[a.line].len - a.arc : a.arc) > 6))!;
    expect(nd).toBeTruthy();
    const minor = nd.arms.find((a) => !a.major)!;
    const major = nd.arms.find((a) => a.major)!;
    const place = (arm: typeof minor, dist: number, v: number) => {
      const L = n.lines[arm.line];
      const arc = arm.arc + arm.dir * dist;
      const dir = -arm.dir;
      const p = pointAt(L, arc);
      const c = newDriveCar(0, 0.5, arm.line, arc, dir, p.x - p.ty * dir * L.lane, p.y + p.tx * dir * L.lane, Math.atan2(p.ty * dir, p.tx * dir), 1.2) as SimCar;
      c.v = v;
      c.driving = true;
      return c;
    };
    const side = place(minor, 2.2, 0.5);
    const main = place(major, 4.5, 1.0);
    const drv = new Driver(n, () => true, rng(9));
    const cars = [side, main];
    let sideWaited = false;
    let mainPassed = -1;
    let sideCrossed = -1;
    for (let t = 0; t < 14; t += 0.05) {
      for (const c of cars) drv.step(c, cars, t, 0.05);
      if (side.waiting && side.v < 0.05) sideWaited = true;
      if (mainPassed < 0 && main.passed >= 0) mainPassed = t;
      if (sideCrossed < 0 && side.passed >= 0) sideCrossed = t;
    }
    expect(sideWaited).toBe(true);
    expect(mainPassed).toBeGreaterThan(0);
    expect(sideCrossed).toBeGreaterThan(mainPassed);
  });

  it('cars queue at a red light and pull away one after another on green', () => {
    const n = net('urban');
    const sg = n.signals.find((s) => {
      const nd = n.nodes[s.node];
      return nd.arms.length === 4 && nd.arms.every((a) => n.lines[a.line].painted);
    })!;
    const nd = n.nodes[sg.node];
    const arm = nd.arms.find((a) => a.axis === 0 && (a.dir > 0 ? n.lines[a.line].len - a.arc : a.arc) > 8)!;
    const L = n.lines[arm.line];
    const dir = -arm.dir;
    const drv = new Driver(n, () => true, rng(5));
    // start at the beginning of axis 0's red (all red after its amber)
    const t0 = SIGNAL_TIMING.green + SIGNAL_TIMING.amber + 0.1 - sg.offset;
    const cars: SimCar[] = [];
    for (let k = 0; k < 3; k++) {
      const arc = arm.hold + arm.dir * (2.5 + k * 1.2);
      const p = pointAt(L, arc);
      const c = newDriveCar(0, 0.5, arm.line, arc, dir, p.x - p.ty * dir * L.lane, p.y + p.tx * dir * L.lane, Math.atan2(p.ty * dir, p.tx * dir), 1.1) as SimCar;
      c.v = 0.8;
      c.driving = true;
      cars.push(c);
    }
    const dt = 0.05;
    let t = t0;
    // red for (all red + the other axis' green + amber + all red) = until axis 0 turns green again
    const redFor = SIGNAL_TIMING.clear - 0.1 + SIGNAL_TIMING.green + SIGNAL_TIMING.amber + SIGNAL_TIMING.clear;
    for (; t < t0 + redFor - 0.2; t += dt) for (const c of cars) drv.step(c, cars, t, dt);
    // all stopped behind the stop line, in a queue with spacing
    for (const c of cars) expect(c.v).toBeLessThan(0.02);
    const d = cars.map((c) => (arm.hold - c.arc) * dir);
    expect(d[0]).toBeGreaterThan(-0.05);
    expect(d[0]).toBeLessThan(0.3);
    expect(d[1] - d[0]).toBeGreaterThan(0.6);
    expect(d[2] - d[1]).toBeGreaterThan(0.6);
    // green: they start one after the other
    const start: number[] = [-1, -1, -1];
    for (; t < t0 + redFor + 8; t += dt)
      cars.forEach((c, k) => {
        drv.step(c, cars, t, dt);
        if (start[k] < 0 && c.v > 0.05) start[k] = t;
      });
    expect(start.every((s) => s > 0)).toBe(true);
    expect(start[1]).toBeGreaterThan(start[0] + 0.2);
    expect(start[2]).toBeGreaterThan(start[1] + 0.2);
  });
});

describe('road clearance', () => {
  for (const id of MAPS) {
    it(`${id}: nothing stands on the roads, turning circles or lots; roads end at the circles`, () => {
      const m = createMap(id, 1);
      const L = buildLayout(m);
      const n = roadNetFor(m, L);
      const inLoop = (x: number, y: number, pad: number) => n.loops.some((lp) => Math.hypot(lp.x - x, lp.y - y) < lp.R + pad);
      const inLot = (x: number, y: number) =>
        n.lots.some((lot) => Math.abs((x - lot.x) * lot.ux + (y - lot.y) * lot.uy) < lot.L / 2 + 0.1 && Math.abs((x - lot.x) * lot.nx + (y - lot.y) * lot.ny) < lot.D / 2 + 0.1);
      for (const run of L.poles) for (const p of run) expect(inLoop(p.x, p.y, 0.15) || onSurface(n, p.x, p.y) || inLot(p.x, p.y), `pole ${p.x},${p.y}`).toBe(false);
      for (const line of L.pylons.lines) for (const p of line) expect(inLoop(p.x, p.y, 0.3) || onSurface(n, p.x, p.y) || inLot(p.x, p.y), `pylon ${p.x},${p.y}`).toBe(false);
      for (const w of L.wrecks) expect(inLoop(w.x, w.y, 0.1) || inLot(w.x, w.y)).toBe(false);
      // render-only trees (the desert's roadside palms...) are filtered by the clearance
      for (const t of m.deco?.trees ?? []) if (inLoop(t.x, t.y, 0.2) || inLot(t.x, t.y)) expect(roadClear(m, t.x, t.y, 0.3)).toBe(false);
      for (const e of L.edges) expect(inLoop((e.a.x + e.b.x) / 2, (e.a.y + e.b.y) / 2, 0.1)).toBe(false);
      for (const b of n.boards) expect(inLoop(b.x, b.y, 0.6) || onSurface(n, b.x, b.y) || inLot(b.x, b.y)).toBe(false);
      // the road ribbons are cut back at the paved circles (the ring is drawn as its own road piece), no stub past a dead end
      for (const lp of n.loops) {
        if (!lp.paved || n.lines[n.nodes[lp.node].arms[0].line].painted) continue;
        const arm = n.nodes[lp.node].arms[0];
        const mouth = pointAt(n.lines[arm.line], arm.edge + arm.dir * 0.8);
        const kx = mouth.x - lp.x;
        const ky = mouth.y - lp.y;
        for (const r of L.roads) {
          if (r.ring || r.lot !== undefined) continue;
          for (const p of r.pts) {
            const d = Math.hypot(p.x - lp.x, p.y - lp.y);
            expect(d).toBeGreaterThan(lp.R - 0.35);
            if (lp.dead && d < lp.R + 2) expect((p.x - lp.x) * kx + (p.y - lp.y) * ky).toBeGreaterThan(-0.3);
          }
        }
      }
      // gravel loops: a ring track the ground paints
      for (const lp of n.loops) if (!lp.paved) expect(L.tracks.some((t) => t.ring && Math.hypot(t.pts[0].x - lp.x, t.pts[0].y - lp.y) < lp.R)).toBe(true);
      // lots: off the bases, ore and buildings, with bays and a lane of the network
      for (const lot of n.lots) {
        expect(lot.line).toBeGreaterThanOrEqual(0);
        expect(lot.bays.length).toBeGreaterThan(5);
        for (const s of m.starts) expect(Math.hypot(lot.x - s.x, lot.y - s.y)).toBeGreaterThan(12);
        for (const b of lot.bays) {
          const i = Math.floor(b.y) * m.w + Math.floor(b.x);
          expect(m.ore[i] + m.blocked[i] + m.trees[i]).toBe(0);
          expect(onSurface(n, b.x, b.y)).toBe(true);
        }
      }
    });
  }

  for (const id of MAPS)
    it(`${id}: no turning circles side by side, no road split into two dead ends`, () => {
      const m = createMap(id, 1);
      const n = roadNetFor(m, buildLayout(m));
      // rings at least ~2 tiles apart
      for (let i = 0; i < n.loops.length; i++)
        for (let j = i + 1; j < n.loops.length; j++) {
          const a = n.loops[i];
          const b = n.loops[j];
          expect(Math.hypot(a.x - b.x, a.y - b.y) - a.R - b.R, `loops ${i} ${j} at ${a.x.toFixed(1)},${a.y.toFixed(1)}`).toBeGreaterThan(1.95);
        }
      // two paved dead ends close together with open ground between them would be one road split in two
      const hard = (x: number, y: number) => {
        const i = Math.floor(y) * m.w + Math.floor(x);
        return m.tiles[i] === Tile.Water || m.tiles[i] === Tile.Rock || m.tiles[i] === Tile.Bridge || m.blocked[i] > 0 || m.trees[i] > 0;
      };
      const dead = n.nodes.filter((nd) => nd.arms.length === 1 && nd.ctl !== Ctl.Lot && n.lines[nd.arms[0].line].paved);
      for (let i = 0; i < dead.length; i++)
        for (let j = i + 1; j < dead.length; j++) {
          const a = dead[i];
          const b = dead[j];
          const d = Math.hypot(a.x - b.x, a.y - b.y);
          if (d > 5) continue;
          // (city streets cut by the canal end at its quay, each as a cul-de-sac: their circles are kept apart above)
          if (n.lines[a.arms[0].line].painted && n.lines[b.arms[0].line].painted) continue;
          let blocked = false;
          for (let k = 0; k <= 20; k++) if (hard(a.x + ((b.x - a.x) * k) / 20, a.y + ((b.y - a.y) * k) / 20)) blocked = true;
          expect(blocked, `dead ends ${a.x.toFixed(1)},${a.y.toFixed(1)} and ${b.x.toFixed(1)},${b.y.toFixed(1)}`).toBe(true);
        }
    });

  it('is deterministic and every map gets parking lots, the city several', () => {
    const sig = (id: MapId) => {
      const m = createMap(id, 1);
      const n = roadNetFor(m, buildLayout(m));
      return JSON.stringify({ lots: n.lots.map((l) => [l.x, l.y]), boards: n.boards, loops: n.loops.map((l) => [l.x, l.y, l.R]) });
    };
    for (const id of MAPS) expect(sig(id)).toBe(sig(id));
    const urban = roadNetFor(createMap('urban', 1), buildLayout(createMap('urban', 1)));
    expect(urban.lots.length).toBeGreaterThanOrEqual(3);
    expect(urban.boards.length).toBeGreaterThan(4);
  });

  it('a car turns into a parking lot, parks, backs out and leaves', () => {
    const n = net('urban');
    const li = 0;
    const lot = n.lots[li];
    lot.taken.fill(0);
    const L = n.lines[lot.line];
    const p = pointAt(L, 0.3);
    const c = newDriveCar(0, 0.5, lot.line, 0.3, 1, p.x - p.ty * L.lane, p.y + p.tx * L.lane, Math.atan2(p.ty, p.tx), 1.1) as SimCar;
    c.driving = true;
    const drv = new Driver(n, () => true, rng(4));
    let parked = false;
    let left = false;
    for (let t = 0; t < 140 && !left; t += 0.05) {
      drv.step(c, [c], t, 0.05);
      if (c.pk === 3) parked = true;
      if (parked && c.pk === 0 && c.dir === -1) left = true;
      let ok = onSurface(n, c.x, c.y);
      for (let k = 0; k < 8 && !ok; k++) ok = onSurface(n, c.x + Math.cos(k * 0.785) * 0.12, c.y + Math.sin(k * 0.785) * 0.12);
      expect(ok, `t ${t.toFixed(2)} pk ${c.pk} at ${c.x.toFixed(2)},${c.y.toFixed(2)}`).toBe(true);
    }
    expect(parked).toBe(true);
    expect(left).toBe(true);
    expect(lot.taken.filter((x) => x !== 0), JSON.stringify([c.id, lot.taken])).toEqual([]);
  });
});
