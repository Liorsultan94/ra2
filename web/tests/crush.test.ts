import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { CRUSH_CHASE, dodgeChance, isCrushable, posture } from '../src/sim/crush';
import { DEF_LIST, unitDef } from '../src/sim/defs';
import { TPS, type Entity, type SimEvent, type UnitDef } from '../src/sim/types';
import { ELITE, VETERAN } from '../src/sim/veterancy';
import { World } from '../src/sim/world';
import { enterGarrison, isGarrison } from '../src/sim/garrison';

/** Two human players, no starting forces, a construction yard each far away (keeps both alive). */
function arena(seed = 5) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: false },
      { name: 'B', faction: 'russia', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  return w;
}

/** A clear stretch of passable ground (row y, columns x0..x1) to drive across. */
function lane(w: World, len = 12): { x0: number; y: number } {
  for (let y = 40; y < w.map.h - 10; y++) {
    for (let x0 = 20; x0 < w.map.w - len - 10; x0++) {
      let ok = true;
      for (let x = x0; x <= x0 + len && ok; x++) for (let dy = -2; dy <= 2 && ok; dy++) if (!w.pf.passable(x, y + dy)) ok = false;
      if (ok) return { x0, y };
    }
  }
  throw new Error('no open lane');
}

interface Run {
  crushed: number;
  dodged: number;
  dead: number;
  events: SimEvent[];
  tank: Entity;
  inf: Entity[];
  w: World;
}

/**
 * A tank ordered to drive straight through a squad of riflemen standing in its path.
 * `owner` of the riflemen (1 = enemy, 0 = friendly), their rank, `dodge` = leave them able to dodge.
 */
function driveThrough(seed: number, opts: { owner?: number; rank?: number; n?: number; dodge?: boolean; tank?: string } = {}): Run {
  const w = arena(seed);
  const { x0, y } = lane(w);
  const owner = opts.owner ?? 1;
  const tank = w.spawnUnit(opts.tank ?? 'usa_mbt', 0, x0 + 0.5, y + 0.5);
  tank.facing = tank.pfacing = 0;
  tank.hp = tank.maxHp = 1e6;
  tank.stance = 'holdFire'; // the crush is the only way it kills here
  const inf: Entity[] = [];
  const n = opts.n ?? 6;
  for (let i = 0; i < n; i++) {
    const s = w.spawnUnit(owner === 1 ? 'russia_rifle' : 'usa_rifle', owner, x0 + 5.5 + i * 0.9, y + 0.5 + ((i % 3) - 1) * 0.08);
    s.stance = 'holdFire';
    s.rank = opts.rank ?? 0;
    if (opts.dodge === false) s.dodgeAt = 1e9;
    inf.push(s);
  }
  w.issue(0, { type: 'move', ids: [tank.id], x: x0 + 11.5, y: y + 0.5 });
  const events: SimEvent[] = [];
  for (let t = 0; t < TPS * 8; t++) {
    w.step();
    events.push(...w.drainEvents());
  }
  return {
    crushed: events.filter((e) => e.t === 'crushed').length,
    dodged: events.filter((e) => e.t === 'dodge' && !e.yield).length,
    dead: inf.filter((s) => s.dead).length,
    events,
    tank,
    inf,
    w,
  };
}

describe('crushing', () => {
  it('classifies crushers and crushables', () => {
    const units = DEF_LIST.filter((d): d is UnitDef => d.kind === 'unit');
    for (const id of ['usa_mbt', 'russia_apc', 'germany_berge', 'iran_harvester', 'china_mcv', 'russia_tos', 'usa_himars', 'iran_shahedl']) expect(unitDef(id).crusher, id).toBe(true);
    for (const id of ['usa_robot', 'israel_ugv', 'russia_robot', 'usa_heli', 'usa_rifle', 'usa_fpv', 'supply_crate', 'usa_transport']) expect(!!unitDef(id).crusher, id).toBe(false);
    for (const d of units) expect(!!d.crushable, d.id).toBe(d.category === 'infantry');
  });

  it('a tank driven through enemy infantry runs them over, deterministically', () => {
    const a = driveThrough(21, { dodge: false });
    expect(a.crushed).toBe(6);
    expect(a.dead).toBe(6);
    // the vehicle reached its destination: it drove through them, not around or stopped
    expect(a.tank.x).toBeGreaterThan(a.inf[5].x);
    // events: 'crushed' then the death with its cause
    const deaths = a.events.filter((e) => e.t === 'death');
    expect(deaths.length).toBe(6);
    for (const d of deaths) expect(d.t === 'death' && d.cause).toBe('crushed');
    const c = a.events.find((e) => e.t === 'crushed');
    expect(c && c.t === 'crushed' && c.by).toBe(a.tank.id);
    // kills and experience go to the tank
    expect(a.w.players[0].stats.killed).toBe(6);
    expect(a.w.players[1].stats.lost).toBe(6);
    expect(a.tank.xp).toBe(6 * unitDef('russia_rifle').cost);
    expect(a.tank.rank).toBe(VETERAN);

    // same seed, same everything (with dodging)
    const b1 = driveThrough(33);
    const b2 = driveThrough(33);
    const snap = (r: Run) => r.events.map((e) => JSON.stringify(e)).join('|') + r.inf.map((s) => `${s.x.toFixed(5)},${s.y.toFixed(5)},${s.dead}`).join(';');
    expect(snap(b1)).toBe(snap(b2));
  });

  it('never crushes friendly infantry: they step aside and the tank gets through', () => {
    const r = driveThrough(21, { owner: 0 });
    expect(r.crushed).toBe(0);
    expect(r.dead).toBe(0);
    expect(r.events.some((e) => e.t === 'dodge' && e.yield)).toBe(true);
    expect(Math.abs(r.tank.x - (lane(r.w).x0 + 11.5))).toBeLessThan(0.3);
    // and they are out of the way of its line, not under it
    for (const s of r.inf) expect(Math.abs(s.y - r.tank.y) > 0.4 || Math.abs(s.x - r.tank.x) > 0.6).toBe(true);
  });

  it('garrisoned, embarked and airborne infantry are safe', () => {
    const w = arena(9);
    const { x0, y } = lane(w);
    // in an APC parked on the tank's path
    const apc = w.spawnUnit('russia_apc', 1, x0 + 6.5, y - 1.5);
    const rider = w.spawnUnit('russia_rifle', 1, x0 + 6.5, y - 1.5);
    w.board(rider, apc);
    // a paratrooper hanging under canopy just above the path
    const jumper = w.spawnUnit('russia_rifle', 1, x0 + 4.5, y + 0.5);
    jumper.para = { t: TPS * 30, T: TPS * 30, z0: 2, x0: x0 + 4.5, y0: y + 0.5 };
    jumper.guardX = x0 + 4.5;
    jumper.guardY = y + 0.5;
    jumper.z = 1.5;
    expect(isCrushable(rider)).toBe(false);
    expect(isCrushable(jumper)).toBe(false);
    const tank = w.spawnUnit('usa_mbt', 0, x0 + 0.5, y + 0.5);
    tank.stance = 'holdFire';
    tank.hp = tank.maxHp = 1e6;
    w.issue(0, { type: 'move', ids: [tank.id], x: x0 + 11.5, y: y + 0.5 });
    for (let t = 0; t < TPS * 7; t++) w.step();
    expect(rider.dead).toBe(false);
    expect(jumper.dead).toBe(false);
    expect(tank.x).toBeGreaterThan(x0 + 9);

    // a garrison inside a civilian building: a tank driving right past the house can't touch it
    const house = w.list.find((e) => isGarrison(e));
    expect(house).toBeTruthy();
    const g = w.spawnUnit('russia_rifle', 1, house!.x, house!.y);
    expect(enterGarrison(w, g, house!)).toBe(true);
    expect(isCrushable(g)).toBe(false);
    const t2 = w.spawnUnit('usa_mbt', 0, house!.x - 3, house!.y);
    t2.stance = 'holdFire';
    w.issue(0, { type: 'move', ids: [t2.id], x: house!.x + 3, y: house!.y });
    for (let t = 0; t < TPS * 6; t++) w.step();
    expect(g.dead).toBe(false);
    expect(g.inside).toBe(house!.id);
  });

  it('a stationary vehicle shoves infantry aside and crushes nobody', () => {
    const w = arena(4);
    const { x0, y } = lane(w);
    const tank = w.spawnUnit('usa_mbt', 0, x0 + 3.5, y + 0.5);
    tank.stance = 'holdFire';
    const s = w.spawnUnit('russia_rifle', 1, x0 + 3.6, y + 0.55);
    s.stance = 'holdFire';
    for (let t = 0; t < TPS; t++) w.step();
    expect(s.dead).toBe(false);
    expect(Math.hypot(s.x - tank.x, s.y - tank.y)).toBeGreaterThan(0.55);
    expect(tank.x).toBe(x0 + 3.5); // the tank didn't budge
  });

  it('infantry in the path dodge at least sometimes, and veterans dodge more', () => {
    let rookieSaved = 0;
    let eliteSaved = 0;
    let rookieDodges = 0;
    let dives = 0;
    const runs = 10;
    for (let i = 0; i < runs; i++) {
      const r = driveThrough(100 + i, { rank: 0 });
      const e = driveThrough(100 + i, { rank: ELITE });
      rookieSaved += 6 - r.dead;
      eliteSaved += 6 - e.dead;
      rookieDodges += r.dodged;
      dives += r.events.filter((ev) => ev.t === 'dodge' && ev.dive).length + e.events.filter((ev) => ev.t === 'dodge' && ev.dive).length;
    }
    console.log(`dodge: rookies survived ${rookieSaved}/${runs * 6}, elites ${eliteSaved}/${runs * 6}, dives ${dives}`);
    expect(rookieDodges).toBeGreaterThan(0);
    expect(rookieSaved).toBeGreaterThan(0);
    expect(rookieSaved).toBeLessThan(runs * 6); // and the tank still gets some
    expect(eliteSaved).toBeGreaterThan(rookieSaved);
  });

  it('dodge chance: veterans and moving soldiers react better, dug-in ones worse, fast vehicles are harder to dodge', () => {
    const w = arena(2);
    const { x0, y } = lane(w);
    const s = w.spawnUnit('russia_rifle', 1, x0 + 2.5, y + 0.5);
    const d = unitDef(s.def);
    for (let t = 0; t < 3; t++) w.step();
    expect(posture(w, s, d)).toBe('standing');
    const base = dodgeChance(w, s, d, 2.2);
    s.rank = VETERAN;
    const vet = dodgeChance(w, s, d, 2.2);
    s.rank = ELITE;
    const elite = dodgeChance(w, s, d, 2.2);
    expect(vet).toBeGreaterThan(base);
    expect(elite).toBeGreaterThan(vet);
    s.rank = 0;
    expect(dodgeChance(w, s, d, 3)).toBeLessThan(base);
    expect(dodgeChance(w, s, d, 1.4)).toBeGreaterThan(base);
    // standing calm on the same spot for a while: dug in
    for (let t = 0; t < TPS * 10; t++) w.step();
    expect(posture(w, s, d)).toBe('dug');
    expect(dodgeChance(w, s, d, 2.2)).toBeLessThan(base);
  });

  it('dodging soldiers resume their orders', () => {
    const w = arena(7);
    const { x0, y } = lane(w);
    // a rifleman walking across the tank's path to a point beyond it
    const s = w.spawnUnit('russia_rifle', 1, x0 + 6.5, y - 2.5);
    s.stance = 'holdFire';
    s.rank = ELITE;
    const tank = w.spawnUnit('usa_mbt', 0, x0 + 0.5, y + 0.5);
    tank.stance = 'holdFire';
    w.issue(1, { type: 'move', ids: [s.id], x: x0 + 6.5, y: y + 3.5 });
    w.issue(0, { type: 'move', ids: [tank.id], x: x0 + 11.5, y: y + 0.5 });
    let dodged = false;
    for (let t = 0; t < TPS * 12; t++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'dodge' && e.id === s.id) dodged = true;
    }
    expect(dodged).toBe(true);
    expect(s.dead).toBe(false);
    expect(s.dodge).toBe(null);
    expect(s.order.type).toBe('idle'); // the move finished
    expect(Math.hypot(s.x - (x0 + 6.5), s.y - (y + 3.5))).toBeLessThan(0.6);
  });

  it('an attack order on infantry in contact runs them over', () => {
    const w = arena(12);
    const { x0, y } = lane(w);
    const tank = w.spawnUnit('usa_mbt', 0, x0 + 0.5, y + 0.5);
    tank.facing = tank.pfacing = 0;
    const s = w.spawnUnit('russia_rifle', 1, x0 + 0.5 + CRUSH_CHASE - 0.3, y + 0.5);
    s.stance = 'holdFire';
    s.dodgeAt = 1e9; // a sitting duck
    w.issue(0, { type: 'attack', ids: [tank.id], target: s.id });
    let how = '';
    for (let t = 0; t < TPS * 6 && !s.dead; t++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'death' && e.id === s.id) how = e.cause ?? 'shot';
    }
    expect(s.dead).toBe(true);
    expect(how).toBe('crushed');
  });

  it('AI games stay deterministic with crushing and dodging, and the AI runs infantry over', () => {
    const make = () => {
      const w = new World({
        seed: 17,
        players: [
          { name: 'A', faction: 'germany', color: 0, isAI: true },
          { name: 'B', faction: 'ukraine', color: 0, isAI: true },
        ],
      });
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
      return w;
    };
    const a = make();
    const b = make();
    let crushed = 0;
    let dodges = 0;
    for (let i = 0; i < TPS * 60 * 10; i++) {
      a.step();
      b.step();
      for (const e of a.drainEvents()) {
        if (e.t === 'crushed') crushed++;
        if (e.t === 'dodge' && !e.yield) dodges++;
      }
      b.drainEvents();
    }
    const snap = (w: World) => w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp}:${e.xp}`).join('|');
    expect(snap(a)).toBe(snap(b));
    console.log(`AI game: ${crushed} soldiers crushed, ${dodges} dodges`);
    expect(crushed + dodges).toBeGreaterThan(0);
  }, 120000);
});
