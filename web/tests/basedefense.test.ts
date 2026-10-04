import { describe, expect, it } from 'vitest';
import { DEFEND_PULL } from '../src/sim/basedefense';
import { TPS, type Entity, type FogMode } from '../src/sim/types';
import { World } from '../src/sim/world';

function base(opts: { autoDefend?: boolean; seed?: number; fog?: FogMode } = {}) {
  const w = new World({
    seed: opts.seed ?? 7,
    fog: opts.fog,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: false, autoDefend: opts.autoDefend ?? true },
      { name: 'B', faction: 'russia', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  const plant = w.spawnBuilding('usa_power', 0, 20, 80, true);
  plant.hp = plant.maxHp = 1e6; // survives the test
  return { w, plant };
}

function unitAt(w: World, def: string, owner: number, x: number, y: number) {
  const p = w.nearestPassable(x, y)!;
  return w.spawnUnit(def, owner, p[0] + 0.5, p[1] + 0.5);
}

function run(w: World, ticks: number) {
  for (let t = 0; t < ticks; t++) {
    w.step();
    w.drainEvents();
  }
}

/** Run until the structure takes its first hit, then a second more. */
function untilHit(w: World, b: Entity) {
  for (let t = 0; t < TPS * 20 && b.lastHurt < 0; t++) run(w, 1);
  run(w, TPS);
}

/** An enemy tank that shells the power plant from the east. */
function raider(w: World, plant: Entity) {
  const r = unitAt(w, 'russia_mbt', 1, 33, 81);
  w.issue(1, { type: 'attack', ids: [r.id], target: plant.id });
  return r;
}

describe('automatic base defence', () => {
  it('idle units near an attacked structure engage the attacker without orders, then return to their posts', () => {
    const { w, plant } = base();
    const a = unitAt(w, 'usa_mbt', 0, 14, 74);
    const b = unitAt(w, 'usa_mbt', 0, 12, 82);
    const post = [a.x, a.y, b.x, b.y];
    // too far away to be pulled in
    const far = unitAt(w, 'usa_mbt', 0, 60, 40);
    const r = raider(w, plant);
    r.hp = r.maxHp = 3000;
    untilHit(w, plant);
    expect(plant.lastHurt).toBeGreaterThan(0);
    expect(w.distTo(far, plant)).toBeGreaterThan(DEFEND_PULL);
    expect(a.order).toMatchObject({ type: 'attack', target: r.id });
    expect(b.order).toMatchObject({ type: 'attack', target: r.id });
    expect(a.defend).not.toBeNull();
    expect(far.order.type).toBe('idle');
    expect(far.defend).toBeNull();
    // they close in and kill it
    let t = 0;
    while (!r.dead && t++ < TPS * 60) run(w, 1);
    expect(r.dead).toBe(true);
    // and walk back home afterwards
    run(w, TPS * 25);
    expect(a.defend).toBeNull();
    expect(b.defend).toBeNull();
    expect(Math.hypot(a.x - post[0], a.y - post[1])).toBeLessThan(2.5);
    expect(Math.hypot(b.x - post[2], b.y - post[3])).toBeLessThan(2.5);
    expect(a.order.type).toBe('idle');
  });

  it('enemies walking into the base are engaged even before they shoot', () => {
    const { w, plant } = base();
    const a = unitAt(w, 'usa_mbt', 0, 12, 74);
    const s = unitAt(w, 'russia_rifle', 1, 26, 79); // ~4 tiles from the plant, out of the tank's sight
    s.stance = 'holdFire';
    s.hp = s.maxHp = 1e5;
    run(w, TPS);
    expect(w.distTo(s, plant)).toBeLessThan(6);
    expect(a.order).toMatchObject({ type: 'attack', target: s.id });
  });

  it('units on hold, recently ordered units and harvesters are left alone; artillery fires only from where it stands', () => {
    const { w, plant } = base();
    const hold = unitAt(w, 'usa_mbt', 0, 14, 74);
    w.issue(0, { type: 'stance', ids: [hold.id], stance: 'hold' });
    const ordered = unitAt(w, 'usa_mbt', 0, 12, 82);
    w.issue(0, { type: 'move', ids: [ordered.id], x: 10.5, y: 84.5 });
    const harv = unitAt(w, 'usa_harvester', 0, 16, 84);
    harv.order = { type: 'idle' };
    const arty = unitAt(w, 'usa_arty', 0, 13, 78);
    const hx = hold.x;
    const hy = hold.y;
    const ax = arty.x;
    const ay = arty.y;
    const r = raider(w, plant);
    r.hp = r.maxHp = 1e5;
    untilHit(w, plant);
    run(w, TPS * 3);
    expect(plant.lastHurt).toBeGreaterThan(0);
    expect(hold.defend).toBeNull();
    expect(hold.order.type).toBe('idle');
    expect(Math.hypot(hold.x - hx, hold.y - hy)).toBeLessThan(0.5);
    expect(ordered.defend).toBeNull();
    expect(ordered.order.type).not.toBe('attack');
    expect(harv.defend).toBeNull();
    expect(harv.order.type).not.toBe('attack');
    expect(arty.defend).toBeNull();
    expect(Math.hypot(arty.x - ax, arty.y - ay)).toBeLessThan(0.5);
  });

  it('a new player order overrides the defence at once', () => {
    const { w, plant } = base();
    const a = unitAt(w, 'usa_mbt', 0, 14, 74);
    const r = raider(w, plant);
    r.hp = r.maxHp = 1e5;
    untilHit(w, plant);
    expect(a.defend).not.toBeNull();
    w.issue(0, { type: 'move', ids: [a.id], x: 6.5, y: 70.5 });
    run(w, 1);
    expect(a.defend).toBeNull();
    expect(a.order).toMatchObject({ type: 'move' });
    // and it is not pulled back in while the order is fresh
    run(w, TPS * 5);
    expect(a.defend).toBeNull();
    expect(a.order.type).not.toBe('attack');
    // a hold stance calls it off too
    const { w: w2, plant: p2 } = base();
    const c = unitAt(w2, 'usa_mbt', 0, 14, 74);
    const r2 = raider(w2, p2);
    r2.hp = r2.maxHp = 1e5;
    untilHit(w2, p2);
    expect(c.defend).not.toBeNull();
    w2.issue(0, { type: 'stance', ids: [c.id], stance: 'hold' });
    run(w2, TPS * 3);
    expect(c.defend).toBeNull();
    expect(c.order.type).toBe('idle');
  });

  it('the toggle: off = units stay put; the autoDefend command switches it in lockstep', () => {
    const { w, plant } = base({ autoDefend: false });
    const a = unitAt(w, 'usa_mbt', 0, 14, 74);
    const r = raider(w, plant);
    r.hp = r.maxHp = 1e5;
    untilHit(w, plant);
    expect(a.defend).toBeNull();
    expect(a.order.type).toBe('idle');
    w.issue(0, { type: 'autoDefend', on: true });
    run(w, TPS * 2);
    expect(w.players[0].autoDefend).toBe(true);
    expect(a.order).toMatchObject({ type: 'attack', target: r.id });
    w.issue(0, { type: 'autoDefend', on: false });
    run(w, 1);
    expect(a.defend).toBeNull();
    expect(a.order.type).toBe('idle');
  });

  it('is deterministic', () => {
    const play = () => {
      const { w, plant } = base({ seed: 11 });
      for (let i = 0; i < 4; i++) unitAt(w, 'usa_mbt', 0, 12 + i, 74 + i * 2);
      for (let i = 0; i < 3; i++) unitAt(w, 'usa_rifle', 0, 16 + i, 86);
      for (let i = 0; i < 4; i++) {
        const r = unitAt(w, i % 2 ? 'russia_mbt' : 'russia_rifle', 1, 34 + i, 78 + i);
        w.issue(1, { type: 'attack', ids: [r.id], target: plant.id });
      }
      run(w, TPS * 40);
      return w.list
        .filter((e) => !e.dead && e.kind === 'unit')
        .map((e) => `${e.id}:${e.x.toFixed(4)},${e.y.toFixed(4)},${e.hp.toFixed(2)},${e.order.type}`)
        .join('|');
    };
    expect(play()).toBe(play());
  });
});
