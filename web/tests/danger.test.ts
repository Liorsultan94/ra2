import { describe, expect, it } from 'vitest';
import { createMap } from '../src/sim/maps';
import type { GameMap, MapId } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
import { Driver, newDriveCar, type DriveCar } from '../src/render/ambient/driver';
import { DangerField, HIGH, W, Wary } from '../src/render/ambient/danger';
import { CAR_SCALE } from '../src/render/ambient/models';
import { onSurface, pointAt as pointAtShared, type RoadNet } from '../src/render/ambient/roadnet';

/** (pointAt returns a shared scratch point: copied here) */
const pointAt = (L: Parameters<typeof pointAtShared>[0], a: number) => ({ ...pointAtShared(L, a) });

/*
 * Civilian traffic under fire (danger.ts): cars stop for danger ahead and turn
 * away on the road, no new cars come in on roads into the fighting (and they
 * come back after a calm), no off-road driving and no gridlock.
 */

const worlds = new Map<MapId, { m: GameMap; n: RoadNet }>();
function world(id: MapId) {
  let w = worlds.get(id);
  if (!w) {
    const m = createMap(id, 1);
    w = { m, n: roadNetFor(m, buildLayout(m)) };
    worlds.set(id, w);
  }
  return w;
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

type Car = DriveCar & { driving: boolean; gone: number };

function makeCar(n: RoadNet, li: number, arc: number, dir: number, kind = 0): Car {
  const L = n.lines[li];
  const p = pointAt(L, arc);
  const x = p.x - p.ty * dir * L.lane;
  const y = p.y + p.tx * dir * L.lane;
  const c = newDriveCar(kind, (kind === 1 ? 0.54 : kind === 2 ? 0.56 : 0.5) * CAR_SCALE, li, arc, dir, x, y, Math.atan2(p.ty * dir, p.tx * dir), [1.25, 1.05, 1.1, 0.5][kind] * (L.paved ? 1 : 0.62)) as Car;
  c.v = c.cruise * 0.8;
  c.driving = true;
  c.gone = -1;
  return c;
}

/** On the drivable surface (a hair of tolerance for corner cutting), as in traffic.test.ts. */
function onRoad(n: RoadNet, x: number, y: number) {
  let ok = onSurface(n, x, y);
  for (let k = 0; k < 8 && !ok; k++) ok = onSurface(n, x + Math.cos(k * 0.785) * 0.12, y + Math.sin(k * 0.785) * 0.12);
  return ok;
}

/** A straight-ish stretch of paved road with no junction over `len` tiles: line, start arc. */
function openRoad(n: RoadNet, len: number): { li: number; a: number; len: number } {
  let best: { li: number; a: number; len: number } | null = null;
  n.lines.forEach((L, li) => {
    if (L.bridge >= 0 || L.lot >= 0 || !L.paved) return;
    const arcs = [L.a0, ...L.stops.map((s) => s.arc), L.a1].sort((a, b) => a - b);
    for (let k = 0; k + 1 < arcs.length; k++) {
      const gap = arcs[k + 1] - arcs[k] - 4;
      if (gap >= len && (!best || gap > best.len)) best = { li, a: arcs[k] + 2, len: gap };
    }
  });
  if (!best) throw new Error('no open road');
  return best;
}

describe('danger field', () => {
  it('troops and blasts raise it, blasts fade over ~40 s, calm is timed', () => {
    const f = new DangerField(64, 64);
    f.begin();
    f.unit(20, 20, 5.5, 1.05);
    f.commit(0.25);
    expect(f.at(20, 20)).toBeGreaterThan(0.8);
    expect(f.at(23, 20)).toBeGreaterThan(0.3);
    expect(f.at(30, 20)).toBe(0);
    // the unit leaves: gone at the next refresh
    f.begin();
    f.commit(0.25);
    expect(f.at(20, 20)).toBe(0);
    f.event(40, 40, 6, 1);
    expect(f.at(40, 40)).toBeGreaterThan(0.8);
    for (let t = 0; t < 20; t += 0.25) {
      f.begin();
      f.commit(0.25);
    }
    expect(f.at(40, 40)).toBeGreaterThan(0.2);
    expect(f.at(40, 40)).toBeLessThan(0.5);
    for (let t = 0; t < 30; t += 0.25) {
      f.begin();
      f.commit(0.25);
    }
    expect(f.at(40, 40)).toBeLessThan(0.12);
    expect(f.calm(40, 40)).toBeGreaterThan(10);
    expect(f.calm(40, 40)).toBeLessThan(40);
    expect(f.calm(5, 60)).toBeGreaterThan(1e6);
  });
});

describe('traffic under fire', () => {
  for (const id of ['frontline', 'urban'] as MapId[]) {
    it(`${id}: a car facing a tank on the road ahead stops short, turns round on the road and drives away`, () => {
      const { m, n } = world(id);
      const road = openRoad(n, 8);
      const L = n.lines[road.li];
      const drv = new Driver(n, () => true, rng(7));
      const field = new DangerField(m.w, m.h);
      const wary = new Wary(n, drv, field, rng(8));
      const c = makeCar(n, road.li, road.a, 1);
      // (before the next junction: no other way to go)
      const tank = pointAt(L, road.a + Math.min(15, road.len + 1));
      let minD = 1e9;
      let stopped = false;
      let turned = false;
      let fled = false;
      let hazards = false;
      const off: string[] = [];
      let tf = 0;
      for (let t = 0; t < 40; t += 0.05) {
        tf += 0.05;
        if (tf >= 0.25) {
          field.begin();
          field.unit(tank.x, tank.y, 5.5, 1.05);
          field.commit(tf);
          tf = 0;
        }
        const d = Math.hypot(c.x - tank.x, c.y - tank.y);
        expect(wary.drive(c, [c], t, 0.05, d)).toBe(false);
        minD = Math.min(minD, Math.hypot(c.x - tank.x, c.y - tank.y));
        if (Math.abs(c.v) < 0.03 && !turned) stopped = true;
        if (c.kt) turned = true;
        if (c.wy === W.Flee) fled = true;
        if (c.haz > 0) hazards = true;
        if (!onRoad(n, c.x, c.y) && off.length < 5) off.push(`t=${t.toFixed(1)} ${c.x.toFixed(2)},${c.y.toFixed(2)} kt ${c.kt}`);
      }
      expect(off).toEqual([]);
      // stopped well short of it (no driving up to the tank), then a turn on the road
      expect(minD).toBeGreaterThan(6);
      expect(stopped).toBe(true);
      expect(turned).toBe(true);
      expect(fled).toBe(true);
      expect(hazards).toBe(true);
      // ... and away: far from it now, heading away from it
      expect(Math.hypot(c.x - tank.x, c.y - tank.y)).toBeGreaterThan(minD + 4);
      expect((tank.x - c.x) * Math.cos(c.yaw) + (tank.y - c.y) * Math.sin(c.yaw)).toBeLessThan(0);
    });
  }

  it('a tank on the planned exit: the car takes another way at the junction', () => {
    const { m, n } = world('urban');
    // a 4-way junction (signals or give way) with long arms
    let found: { node: number; inArm: number } | null = null;
    n.nodes.forEach((nd, ni) => {
      if (found || nd.arms.length < 3 || nd.loop >= 0) return;
      for (let k = 0; k < nd.arms.length; k++) {
        const a = nd.arms[k];
        const L = n.lines[a.line];
        // room to come in along this arm
        const back = a.dir > 0 ? L.len - a.arc : a.arc;
        if (back > 8 && L.paved && L.lot < 0 && L.bridge < 0) {
          found = { node: ni, inArm: k };
          return;
        }
      }
    });
    expect(found).not.toBeNull();
    const { node, inArm } = found!;
    const nd = n.nodes[node];
    const arm = nd.arms[inArm];
    let switched = 0;
    for (let trial = 0; trial < 12; trial++) {
      const drv = new Driver(n, () => true, rng(100 + trial));
      const field = new DangerField(m.w, m.h);
      const wary = new Wary(n, drv, field, rng(200 + trial));
      // a car coming in along the arm (towards the node)
      const c = makeCar(n, arm.line, arm.arc + arm.dir * 6, -arm.dir);
      // it plans an exit first, then a tank appears on it
      for (let t = 0; t < 6 && c.planNode !== node; t += 0.05) wary.drive(c, [c], t, 0.05);
      expect(c.planNode).toBe(node);
      if (c.plan < 0) continue;
      const ex = nd.arms[c.plan];
      const tp = pointAt(n.lines[ex.line], ex.arc + ex.dir * 4);
      field.begin();
      field.unit(tp.x, tp.y, 5.5, 1.05);
      field.commit(0.25);
      const before = c.plan;
      for (let t = 6; t < 7; t += 0.05) wary.drive(c, [c], t, 0.05);
      if (c.planNode === node && c.plan !== before && c.plan >= 0) {
        const nx = nd.arms[c.plan];
        expect(wary.lineRisk(nx.line, nx.arc, nx.dir, 7)).toBeLessThan(0.3);
        switched++;
      } else if (c.kt || c.wy === W.Halt || c.wy === W.Turn || c.wy === W.Cower) switched++; // (no safe exit: stops and turns instead)
    }
    expect(switched).toBeGreaterThan(8);
  });

  it('under fire: an emergency stop, some drivers get out and run, nobody drives on into it', () => {
    const { m, n } = world('frontline');
    const road = openRoad(n, 14);
    let bailed = 0;
    let stoppedAll = true;
    for (let trial = 0; trial < 40; trial++) {
      const drv = new Driver(n, () => true, rng(300 + trial));
      const field = new DangerField(m.w, m.h);
      const wary = new Wary(n, drv, field, rng(400 + trial));
      const c = makeCar(n, road.li, road.a + 2, 1);
      const x0 = c.x;
      const y0 = c.y;
      let out = false;
      for (let t = 0; t < 4 && !out; t += 0.05) {
        // shells landing right by the car
        if (Math.round(t * 20) % 10 === 0) {
          field.event(x0 + 0.6, y0, 4, 1);
          field.commit(0.05);
        }
        out = wary.drive(c, [c], t, 0.05);
      }
      if (out) bailed++;
      else if (Math.abs(c.v) > 0.05 && c.wy !== W.Turn && c.wy !== W.Flee) stoppedAll = false;
      // the emergency stop: not far down the road
      expect(Math.hypot(c.x - x0, c.y - y0)).toBeLessThan(1.6);
      expect(field.at(x0, y0)).toBeGreaterThan(HIGH);
    }
    expect(stoppedAll).toBe(true);
    expect(bailed).toBeGreaterThan(4);
    expect(bailed).toBeLessThan(30);
  });

  it('no new cars come in on roads into danger; they come back gradually after a calm', () => {
    const { m, n } = world('frontline');
    const field = new DangerField(m.w, m.h);
    const wary = new Wary(n, new Driver(n), field, rng(5));
    const entries: { li: number; arc: number; dir: number; x: number; y: number }[] = [];
    n.lines.forEach((L, li) => {
      if (L.bridge >= 0) return;
      for (let e = 0; e < 2; e++) {
        if (!L.portal[e]) continue;
        const arc = e ? L.len - 0.3 : 0.3;
        const p = pointAt(L, arc);
        entries.push({ li, arc, dir: e ? -1 : 1, x: p.x, y: p.y });
      }
    });
    expect(entries.length).toBeGreaterThan(1);
    const hot = entries[0];
    const tank = pointAt(n.lines[hot.li], hot.arc + hot.dir * 7);
    const far = entries.filter((e) => Math.hypot(e.x - tank.x, e.y - tank.y) > 30);
    expect(far.length).toBeGreaterThan(0);
    const step = (sec: number, unit: boolean, blasts: boolean, each?: (t: number) => void) => {
      for (let t = 0; t < sec; t += 0.25) {
        field.begin();
        if (unit) field.unit(tank.x, tank.y, 5.5, 1.05);
        if (blasts && Math.round(t * 4) % 12 === 0) field.event(tank.x + 1, tank.y, 6, 0.9);
        field.commit(0.25);
        wary.tick(0.25);
        each?.(t);
      }
    };
    expect(wary.entryOk(hot.li, hot.arc, hot.dir)).toBe(true);
    // fighting by the entry for half a minute
    step(30, true, true, () => {
      expect(wary.entryOk(hot.li, hot.arc, hot.dir)).toBe(false);
    });
    // the other entries stay open, the overall density is down
    for (const e of far) expect(wary.entryOk(e.li, e.arc, e.dir)).toBe(true);
    expect(wary.density).toBeLessThan(0.7);
    // the tank leaves: for a minute or so nobody comes in there, then more and more
    let early = 0;
    step(50, false, false, () => {
      if (wary.entryOk(hot.li, hot.arc, hot.dir)) early++;
    });
    expect(early).toBe(0);
    expect(wary.density).toBeLessThan(0.95);
    let mid = 0;
    let tries = 0;
    step(60, false, false, (t) => {
      if (t < 20) return;
      tries++;
      if (wary.entryOk(hot.li, hot.arc, hot.dir)) mid++;
    });
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(tries);
    step(70, false, false);
    for (let k = 0; k < 10; k++) expect(wary.entryOk(hot.li, hot.arc, hot.dir)).toBe(true);
    expect(wary.density).toBeGreaterThan(0.98);
  });

  for (const id of ['desert', 'winter', 'frontline', 'urban'] as MapId[]) {
    it(`${id}: tanks and shelling by the roads: nobody drives off the road or into a tank, no gridlock after`, () => {
      const { m, n } = world(id);
      const rand = rng(77 + id.length);
      const drv = new Driver(n, () => true, rand);
      const field = new DangerField(m.w, m.h);
      const wary = new Wary(n, drv, field, rng(91));
      // three tanks parked on the roads
      const lines = n.lines.map((L, li) => ({ L, li })).filter(({ L }) => L.bridge < 0 && L.lot < 0 && L.a1 - L.a0 > 6);
      const tanks: { x: number; y: number }[] = [];
      for (let k = 0; k < 3; k++) {
        const { L } = lines[Math.floor(rand() * lines.length)];
        tanks.push(pointAt(L, L.a0 + 3 + rand() * (L.a1 - L.a0 - 6)));
      }
      const cars: Car[] = [];
      const spawn = (t: number) => {
        for (let tries = 0; tries < 60; tries++) {
          const { L, li } = lines[Math.floor(rand() * lines.length)];
          const arc = L.a0 + 0.5 + rand() * (L.a1 - L.a0 - 1);
          const dir = rand() < 0.5 ? 1 : -1;
          const c = makeCar(n, li, arc, dir, L.paved ? Math.floor(rand() * 3) : 3);
          if (!onSurface(n, c.x, c.y) || n.loops.some((lp) => Math.hypot(lp.x - c.x, lp.y - c.y) < lp.R + 0.3)) continue;
          if (n.nodes.some((nd) => nd.arms.length > 1 && Math.hypot(nd.x - c.x, nd.y - c.y) < 2.5)) continue;
          if (cars.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 1.2)) continue;
          if (t < 60 && tanks.some((tk) => Math.hypot(tk.x - c.x, tk.y - c.y) < 7)) continue;
          cars.push(c);
          return;
        }
      };
      for (let i = 0; i < 24; i++) spawn(0);
      const off: string[] = [];
      let intoTank = 1e9;
      const still = new Map<number, number>();
      let longestCalm = 0;
      let reacted = 0;
      let tf = 0;
      const dt = 0.05;
      for (let t = 0; t < 190; t += dt) {
        tf += dt;
        if (tf >= 0.25) {
          field.begin();
          if (t < 60) for (const tk of tanks) field.unit(tk.x, tk.y, 5.5, 1.05);
          field.commit(tf);
          tf = 0;
          // shelling round the tanks now and then
          if (t < 60 && rand() < 0.08) {
            const tk = tanks[Math.floor(rand() * tanks.length)];
            field.event(tk.x + (rand() - 0.5) * 6, tk.y + (rand() - 0.5) * 6, 6, 0.9);
          }
        }
        for (let i = cars.length - 1; i >= 0; i--) {
          const c = cars[i];
          if (c.gone >= 0) {
            // left on the road by the driver: an obstacle for a while, then towed away
            if (t - c.gone > 30) {
              cars.splice(i, 1);
              spawn(t);
            }
            continue;
          }
          let near = 1e9;
          if (t < 60) for (const tk of tanks) near = Math.min(near, Math.hypot(tk.x - c.x, tk.y - c.y));
          c.driving = !wary.stoppedInLane(c);
          if (wary.drive(c, cars, t, dt, near)) {
            c.gone = t;
            c.driving = false;
            c.v = 0;
            continue;
          }
          if (c.wy !== W.Calm) reacted++;
          if (t < 60) intoTank = Math.min(intoTank, near);
          if (!onRoad(n, c.x, c.y) && off.length < 8) off.push(`t=${t.toFixed(1)} car ${c.id} at ${c.x.toFixed(2)},${c.y.toFixed(2)} line ${c.line} loop ${c.loop} kt ${c.kt} wy ${c.wy}`);
          const s = Math.abs(c.v) < 0.02 && c.pk !== 3 ? (still.get(c.id) ?? 0) + dt : 0;
          still.set(c.id, s);
          // once it is all calm again (the blasts faded), nobody stands still for long
          if (t > 115) longestCalm = Math.max(longestCalm, s);
          const L = n.lines[c.line];
          if (c.loop < 0 && !c.kt && ((c.dir > 0 && L.portal[1] && c.arc > L.len - 0.3) || (c.dir < 0 && L.portal[0] && c.arc < 0.3))) {
            cars.splice(i, 1);
            spawn(t);
          }
        }
      }
      expect(off).toEqual([]);
      expect(reacted).toBeGreaterThan(100);
      expect(intoTank).toBeGreaterThan(1.2);
      expect(longestCalm).toBeLessThan(30);
      const moving = cars.filter((c) => c.gone < 0 && (Math.abs(c.v) > 0.05 || c.waiting || c.pk === 3)).length;
      expect(moving).toBeGreaterThan(cars.length * 0.5);
    });
  }
});
