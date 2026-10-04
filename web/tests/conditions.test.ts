import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { COVER_MUL, Conditions, FOG_SIGHT, GAME_HOUR_TICKS, MUD_SLOW, NIGHT_SIGHT, SNOW_SLOW_VEH, clockHours, conditionLines, darkAt, hasNightVision, hourToU } from '../src/sim/conditions';
import { SIDE, type SideKind } from '../src/sim/sideevents';
import { unitDef } from '../src/sim/defs';
import { TPS, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';
import { clockHours as renderClock, hourToU as renderHourToU, START_HOUR, GAME_HOUR_TICKS as RENDER_HOUR } from '../src/render/atmos';
import { WeatherCycle } from '../src/render/weathercycle';
import type { MapId } from '../src/sim/map';

function world(seed = 5, map: MapId = 'frontline') {
  return new World({
    seed,
    map,
    players: [
      { name: 'A', faction: 'usa', color: 0x2f7dff, isAI: false },
      { name: 'B', faction: 'russia', color: 0xe0322b, isAI: false },
    ],
  });
}

/** Clear the start armies (the MCVs stay: the players must not lose) so tests see only what they place. */
function clearUnits(w: World) {
  for (const e of w.list) if (e.kind === 'unit' && e.owner >= 0 && !unitDef(e.def).mcv) w.remove(e);
}

/** An open spot with no structure within r tiles. */
function openSpot(w: World, r = 10): [number, number] {
  const m = w.map;
  for (let y = r; y < m.h - r; y += 2)
    for (let x = r; x < m.w - r; x += 2) {
      if (!w.pf.passable(x, y)) continue;
      if (w.list.some((e) => !e.dead && (e.kind === 'building' || unitDef(e.def).mcv) && Math.hypot(e.x - x, e.y - y) < r)) continue;
      return [x + 0.5, y + 0.5];
    }
  return [m.w / 2, m.h / 2];
}

/** Visible tiles of a player within radius r of (x, y). */
function visibleAround(w: World, pid: number, x: number, y: number, r: number) {
  let n = 0;
  for (let ty = Math.floor(y - r); ty <= y + r; ty++) for (let tx = Math.floor(x - r); tx <= x + r; tx++) if (Math.hypot(tx + 0.5 - x, ty + 0.5 - y) <= r && w.visibleTo(pid, tx + 0.5, ty + 0.5)) n++;
  return n;
}

/** Visible tiles of a player around (x, y) within radius r. */
function visibleCount(w: World, pid: number) {
  let n = 0;
  for (const v of w.players[pid].visible) n += v;
  return n;
}

describe('battle clock in the sim', () => {
  it('matches the render clock (1 real minute = 1 game hour from 05:30)', () => {
    expect(GAME_HOUR_TICKS).toBe(RENDER_HOUR);
    for (const t of [0, 1, 777, GAME_HOUR_TICKS * 5, GAME_HOUR_TICKS * 17 + 33, GAME_HOUR_TICKS * 30]) {
      expect(clockHours(t)).toBeCloseTo(renderClock(t, START_HOUR), 10);
      expect(hourToU(clockHours(t))).toBeCloseTo(renderHourToU(renderClock(t, START_HOUR)), 10);
    }
  });

  it('is dark at night with a smooth dusk and dawn', () => {
    expect(darkAt(12)).toBe(0);
    expect(darkAt(15)).toBe(0);
    expect(darkAt(23)).toBe(1);
    expect(darkAt(3)).toBe(1);
    // dusk ramps up, dawn ramps down, never jumps
    let prev = darkAt(17);
    for (let h = 17; h <= 21; h += 0.05) {
      const d = darkAt(h);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(d - prev).toBeLessThan(0.05);
      prev = d;
    }
    expect(darkAt(5.5)).toBeGreaterThan(0.5); // the battle starts in the dawn twilight
    expect(darkAt(8)).toBeLessThan(0.06);
  });
});

describe('conditions are deterministic', () => {
  it('same seed -> same conditions, and the sim weather is the render weather', () => {
    const run = () => {
      const w = world(11);
      w.cond.configure({ tod: 'cycle', weather: 'dynamic' });
      const out: string[] = [];
      for (let t = 0; t <= TPS * 60 * 26; t += TPS * 15) {
        const s = w.cond.evaluate(t);
        out.push([s.hour, s.dark, s.fog, s.wet, s.mud, s.precip, s.sight, s.vehOff].map((v) => v.toFixed(5)).join(','));
      }
      return { out, seed: w.cond.wxSeed };
    };
    const a = run();
    const b = run();
    expect(a.out).toEqual(b.out);
    // the renderer's timeline with the same seed gives the same weather at every game second
    const w = world(11);
    w.cond.configure({ tod: 'cycle', weather: 'dynamic' });
    const rc = new WeatherCycle(w.cond.wxSeed, { climate: 'temperate', cold: false });
    rc.force = null;
    for (let t = 0; t < 60 * 26; t += 37) {
      const s = w.cond.evaluate(t * TPS);
      const r = rc.at(t);
      expect(s.wx!.precip).toBe(r.precip);
      expect(s.wx!.wet).toBe(r.wet);
      expect(s.wx!.mist).toBe(r.mist);
    }
    // the seed is the one render/atmos.ts derives from the world (PRNG state + map name)
    expect(w.cond.wxSeed).toBe(Conditions.seedFor(w));
  });

  it('a whole match with conditions and side events replays identically', () => {
    const run = () => {
      const w = world(21);
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
      w.cond.configure({ tod: 'cycle', weather: 'dynamic', startHour: 19 });
      w.side.enabled = true;
      w.side.next = TPS * 20;
      const log: string[] = [];
      for (let i = 0; i < TPS * 150; i++) {
        w.step();
        for (const e of w.drainEvents()) if (e.t === 'side' || e.t === 'conditions') log.push(JSON.stringify(e));
      }
      const snap = w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp.toFixed(3)}`).join('|');
      return { log, snap, credits: w.players.map((p) => p.credits) };
    };
    const a = run();
    const b = run();
    expect(a.log.length).toBeGreaterThan(0);
    expect(a.log).toEqual(b.log);
    expect(a.snap).toBe(b.snap);
    expect(a.credits).toEqual(b.credits);
  }, 60000);
});

describe('night sight', () => {
  it('shrinks sight by up to 35% at full dark; night-vision units keep theirs', () => {
    const w = world();
    clearUnits(w);
    w.updateVisibility();
    const [ox, oy] = openSpot(w);
    const rifle = w.spawnUnit('usa_rifle', 0, ox, oy); // sight 6 (5 + USA +1)
    const tank = w.spawnUnit('usa_mbt', 1, ox, oy); // thermal sights
    expect(hasNightVision('usa_rifle')).toBe(false);
    expect(hasNightVision('usa_mbt')).toBe(true);
    expect(hasNightVision('russia_uav')).toBe(true);
    w.cond.configure({ tod: 'day', weather: 'clear' });
    const r0 = w.cond.sightOf(rifle, unitDef(rifle.def).sight);
    expect(r0).toBe(unitDef(rifle.def).sight);
    w.updateVisibility();
    const day0 = visibleAround(w, 0, ox, oy, 8);
    const day1 = visibleAround(w, 1, ox, oy, 8);
    w.cond.configure({ tod: 'night', weather: 'clear' });
    expect(w.cond.state.dark).toBe(1);
    expect(w.cond.state.sight).toBeCloseTo(1 - NIGHT_SIGHT, 6);
    expect(w.cond.sightOf(rifle, unitDef(rifle.def).sight)).toBeCloseTo(unitDef(rifle.def).sight * (1 - NIGHT_SIGHT), 6);
    expect(w.cond.sightOf(tank, unitDef(tank.def).sight)).toBe(unitDef(tank.def).sight);
    w.updateVisibility();
    // the rifleman sees ~0.65^2 of the area; the tank (night vision) the same as by day
    const ratio = visibleAround(w, 0, ox, oy, 8) / day0;
    expect(ratio).toBeGreaterThan(0.3);
    expect(ratio).toBeLessThan(0.6);
    expect(visibleAround(w, 1, ox, oy, 8)).toBe(day1);
    // dusk: part of the way
    w.cond.configure({ tod: 'dusk', weather: 'clear' });
    expect(w.cond.state.sight).toBeGreaterThan(1 - NIGHT_SIGHT);
    expect(w.cond.state.sight).toBeLessThan(1);
    expect(conditionLines(w.cond.state)[0].kind).toBe('night');
  });

  it('firing gives the shooter away in the dark; fog cuts everybody', () => {
    const w = world();
    clearUnits(w);
    w.cond.configure({ tod: 'night', weather: 'clear' });
    const [ox, oy] = openSpot(w, 12);
    const a = w.spawnUnit('usa_rifle', 0, ox - 4, oy);
    const b = w.spawnUnit('russia_rifle', 1, ox + 4, oy);
    w.updateVisibility();
    expect(w.visibleTo(1, a.x, a.y)).toBe(false);
    a.firedAt = w.tick;
    w.updateVisibility();
    expect(w.visibleTo(1, a.x, a.y)).toBe(true);
    void b;
    // fog: the misty morning
    w.cond.configure({ tod: 'mist', weather: 'clear' });
    expect(w.cond.state.fog).toBeGreaterThan(0.8);
    expect(w.cond.state.sightNV).toBeCloseTo(1 - FOG_SIGHT * w.cond.state.fog, 6);
    expect(conditionLines(w.cond.state).some((l) => l.kind === 'fog')).toBe(true);
  });
});

describe('mud and snow', () => {
  it('slows vehicles off-road by up to 20% on soaked ground; roads and infantry are not affected', () => {
    const w = world();
    clearUnits(w);
    w.cond.configure({ tod: 'day', weather: 'rain' });
    expect(w.cond.state.mud).toBe(1);
    const tank = unitDef('usa_mbt');
    const rifle = unitDef('usa_rifle');
    const off = w.cond.road.indexOf(0);
    const on = w.cond.road.indexOf(1);
    expect(on).toBeGreaterThanOrEqual(0);
    expect(w.cond.moveMul(tank, off)).toBeCloseTo(1 - MUD_SLOW, 6);
    expect(w.cond.moveMul(tank, on)).toBe(1);
    expect(w.cond.moveMul(rifle, off)).toBe(1);
    expect(conditionLines(w.cond.state).some((l) => l.kind === 'mud')).toBe(true);
    // the tank really drives slower off-road
    const drive = (cfg: 'clear' | 'rain') => {
      const v = world();
      clearUnits(v);
      v.cond.configure({ tod: 'day', weather: cfg });
      // an off-road start with open ground to the east
      let sx = 20;
      let sy = 20;
      search: for (let y = 10; y < v.map.h - 10; y++)
        for (let x = 10; x < v.map.w - 20; x++) {
          let ok = true;
          for (let k = 0; k < 8 && ok; k++) ok = v.pf.passable(x + k, y) && !v.cond.road[y * v.map.w + x + k];
          if (ok) {
            sx = x;
            sy = y;
            break search;
          }
        }
      const t = v.spawnUnit('usa_mbt', 0, sx + 0.5, sy + 0.5);
      t.facing = 0;
      v.issue(0, { type: 'move', ids: [t.id], x: sx + 7.5, y: sy + 0.5 });
      for (let i = 0; i < TPS * 2; i++) v.step();
      return t.x - (sx + 0.5);
    };
    const dry = drive('clear');
    const wet = drive('rain');
    expect(wet / dry).toBeGreaterThan(0.74);
    expect(wet / dry).toBeLessThan(0.86);
  });

  it('ramps in and out with the ground wetness', () => {
    const w = world(3);
    w.cond.configure({ tod: 'cycle', weather: 'dynamic' });
    let maxMud = 0;
    let wetSeen = false;
    let prev = -1;
    for (let t = 0; t < TPS * 60 * 24; t += TPS) {
      const s = w.cond.evaluate(t);
      maxMud = Math.max(maxMud, s.mud);
      if (s.wet > 0.5) wetSeen = true;
      if (prev >= 0) expect(Math.abs(s.vehOff - prev)).toBeLessThan(0.03); // no jumps
      prev = s.vehOff;
    }
    expect(wetSeen).toBe(true);
    expect(maxMud).toBeGreaterThan(0.5);
  });

  it('winter snow slows off-road vehicles a little', () => {
    const w = world(4, 'winter');
    w.cond.configure({ tod: 'day', weather: 'clear' });
    expect(w.cond.state.snow).toBe(1);
    expect(w.cond.state.vehOff).toBeCloseTo(1 - SNOW_SLOW_VEH, 6);
    expect(w.cond.state.infOff).toBeLessThan(1);
  });

  it('vehicles route along roads when the fields are mud', () => {
    const w = world();
    w.cond.configure({ tod: 'day', weather: 'rain' });
    expect(w.cond.cost).not.toBeNull();
    const m = w.map;
    // a long trip between the bases
    const [a, b] = m.starts;
    const dry = w.pf.find(a.x + 3, a.y, b.x - 3, b.y, 100000);
    const mud = w.pf.find(a.x + 3, a.y, b.x - 3, b.y, 100000, w.cond.cost);
    const roadShare = (p: number[]) => p.filter((t) => w.cond.road[t]).length / Math.max(1, p.length);
    expect(roadShare(mud)).toBeGreaterThanOrEqual(roadShare(dry));
  });
});

describe('cover', () => {
  it('infantry in a crater or next to ruins take less damage', () => {
    const w = world();
    clearUnits(w);
    w.cond.configure({ tod: 'day', weather: 'clear' });
    const shooter = w.spawnUnit('russia_mbt', 1, 50.5, 50.5);
    const open = w.spawnUnit('usa_rifle', 0, 30.5, 30.5);
    const dug = w.spawnUnit('usa_rifle', 0, 34.5, 30.5);
    w.cond.crater(34.5, 30.5, 1.5, 100);
    expect(w.cond.inCover(dug.x, dug.y)).toBe(true);
    expect(w.cond.inCover(open.x, open.y)).toBe(false);
    w.damage(open, 50, 'mg', shooter);
    w.damage(dug, 50, 'mg', shooter);
    expect((dug.maxHp - dug.hp) / (open.maxHp - open.hp)).toBeCloseTo(COVER_MUL, 6);
    // a destroyed building leaves ruins: cover next to them too
    const house = w.list.find((e) => e.kind === 'building' && e.owner < 0 && e.def.startsWith('civ'))!;
    if (house) {
      w.kill(house, -1);
      expect(w.cond.inCover(house.tx - 0.5, house.ty + 0.5)).toBe(true);
    }
  });
});

describe('side events', () => {
  const evs = (w: World, f: (e: SimEvent) => boolean) => w.drainEvents().filter(f);

  it('spawn on a seeded schedule, the same for the same seed', () => {
    const sched = (seed: number) => {
      const w = world(seed);
      w.side.enabled = true;
      const out: string[] = [];
      for (let i = 0; i < TPS * 60 * 12; i++) {
        w.step();
        for (const e of w.drainEvents()) if (e.t === 'side' && e.phase === 'start') out.push(`${w.tick}:${e.kind}:${e.x.toFixed(2)},${e.y.toFixed(2)}`);
      }
      return out;
    };
    const a = sched(9);
    expect(a.length).toBeGreaterThanOrEqual(3);
    expect(a.length).toBeLessThanOrEqual(5);
    expect(sched(9)).toEqual(a);
    expect(sched(10)).not.toEqual(a);
    expect(+a[0].split(':')[0]).toBe(SIDE.FIRST);
  }, 60000);

  it('spots are fair: about as far from both bases', () => {
    const w = world(13);
    w.side.enabled = true;
    for (let i = 0; i < 6; i++) {
      const s = w.side.pickSpot()!;
      const d = w.players.map((p) => Math.hypot(s[0] - p.startX - 0.5, s[1] - p.startY - 0.5));
      expect(Math.abs(d[0] - d[1]) / Math.max(d[0], d[1])).toBeLessThan(0.25);
    }
  });

  it('crash: the first infantry to reach the wreck reveals the map for 30 s', () => {
    const w = world();
    clearUnits(w);
    w.side.enabled = true;
    const ev = w.side.spawn('crash')!;
    expect(ev).not.toBeNull();
    w.step();
    const before = visibleCount(w, 0);
    const u = w.spawnUnit('usa_rifle', 0, ev.x + 1, ev.y);
    for (let i = 0; i < 10; i++) w.step();
    expect(ev.done).toBe(true);
    expect(ev.winner).toBe(0);
    expect(visibleCount(w, 0)).toBe(w.map.w * w.map.h);
    expect(visibleCount(w, 0)).toBeGreaterThan(before);
    for (let i = 0; i < SIDE.INTEL + 8; i++) w.step();
    expect(visibleCount(w, 0)).toBeLessThan(w.map.w * w.map.h);
    void u;
  });

  it('supply drop: crates parachute in and pay whoever picks them up', () => {
    const w = world();
    clearUnits(w);
    w.side.enabled = true;
    const ev = w.side.spawn('supply')!;
    const crates = ev.ents.map((id) => w.get(id)!);
    expect(crates.length).toBe(SIDE.CRATES);
    expect(crates.every((c) => !!c.para)).toBe(true);
    for (let i = 0; i < TPS * 7; i++) w.step();
    expect(crates.every((c) => !c.para && !c.dead)).toBe(true);
    const cash = w.players[1].credits;
    const c0 = crates[0];
    w.spawnUnit('russia_mbt', 1, c0.x + 0.3, c0.y);
    for (let i = 0; i < 8; i++) w.step();
    expect(w.players[1].credits).toBe(cash + SIDE.CRATE_CASH);
    expect(c0.dead).toBe(true);
    expect(ev.done).toBe(false);
  });

  it('rescue: infantry pull the civilians out of a burning building for cash and rank', () => {
    const w = world();
    clearUnits(w);
    w.side.enabled = true;
    const ev = w.side.spawn('rescue')!;
    expect(ev.kind).toBe('rescue');
    const house = w.get(ev.ents[0])!;
    expect(house.hp / house.maxHp).toBeLessThan(0.3);
    const cash = w.players[0].credits;
    const u = w.spawnUnit('usa_rifle', 0, house.x, house.y + 2.2);
    w.issue(0, { type: 'move', ids: [u.id], x: house.x, y: house.y + 1.6 });
    for (let i = 0; i < TPS * 4 && !ev.done; i++) w.step();
    expect(ev.done).toBe(true);
    expect(ev.winner).toBe(0);
    expect(w.players[0].credits).toBe(cash + SIDE.RESCUE_CASH);
    expect(u.rank).toBe(1);
    expect(house.hp / house.maxHp).toBeGreaterThan(0.5);
  });

  it('a burning building left alone burns down', () => {
    const w = world();
    clearUnits(w);
    w.side.enabled = true;
    const ev = w.side.spawn('rescue')!;
    const house = w.get(ev.ents[0])!;
    for (let i = 0; i < SIDE.RESCUE_LIFE + 2; i++) w.step();
    expect(ev.done).toBe(true);
    expect(house.dead).toBe(true);
    expect(w.cond.inCover(house.x, house.y)).toBe(true);
  });

  it('convoy: trucks cross the map; standing next to one captures it, killing one pays a bounty', () => {
    const w = world();
    clearUnits(w);
    w.side.enabled = true;
    const ev = w.side.spawn('convoy')!;
    expect(ev.kind).toBe('convoy');
    const trucks = ev.ents.map((id) => w.get(id)!);
    expect(trucks.length).toBe(SIDE.TRUCKS);
    for (let i = 0; i < TPS * 5; i++) w.step();
    const lead = trucks[0];
    const x0 = lead.x;
    const y0 = lead.y;
    expect(Math.hypot(lead.x - ev.route![0].x, lead.y - ev.route![0].y)).toBeGreaterThan(3);
    // capture the lead truck
    const cash = w.players[0].credits;
    w.spawnUnit('usa_mbt', 0, lead.x + 1, lead.y);
    for (let i = 0; i < SIDE.CAPTURE_TICKS + 4; i++) w.step();
    expect(lead.dead).toBe(true);
    expect(w.players[0].credits).toBe(cash + SIDE.CAPTURE_CASH);
    void x0;
    void y0;
    // destroy another one: bounty for the shooter
    const t2 = trucks[2];
    const shooter = w.spawnUnit('russia_mbt', 1, t2.x - 4, t2.y);
    const c1 = w.players[1].credits;
    w.issue(1, { type: 'attack', ids: [shooter.id], target: t2.id });
    for (let i = 0; i < TPS * 20 && !t2.dead; i++) w.step();
    expect(t2.dead).toBe(true);
    expect(w.players[1].credits).toBe(c1 + SIDE.BOUNTY);
  });

  it('the AI sends a detachment to contest an event', () => {
    const w = world(17);
    w.players[1].isAI = true;
    w.controllers.push(new AIController(w, 1, 'hard'));
    w.side.enabled = true;
    w.side.next = 1e9;
    for (let i = 0; i < TPS * 60; i++) w.step();
    const kinds: SideKind[] = ['supply', 'crash'];
    const ev = w.side.spawn(kinds[0])!;
    const near = () => w.list.filter((e) => !e.dead && e.owner === 1 && e.kind === 'unit' && Math.hypot(e.x - ev.x, e.y - ev.y) < 4).length;
    let claimed = false;
    for (let i = 0; i < TPS * 90 && !claimed; i++) {
      w.step();
      if (evs(w, (e) => e.t === 'side' && e.phase === 'claim' && e.owner === 1).length) claimed = true;
    }
    expect(claimed || near() > 0).toBe(true);
  }, 60000);
});
