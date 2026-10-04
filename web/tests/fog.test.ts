import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS, type Faction, type FogMode } from '../src/sim/types';
import { World } from '../src/sim/world';

function duel(fog?: FogMode, seed = 9) {
  const w = new World({
    seed,
    fog,
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

function at(w: World, def: string, owner: number, x: number, y: number) {
  const p = w.nearestPassable(x, y)!;
  return w.spawnUnit(def, owner, p[0] + 0.5, p[1] + 0.5);
}

function run(w: World, ticks: number) {
  for (let t = 0; t < ticks; t++) {
    w.step();
    w.drainEvents();
  }
}

/** A scout drives past an enemy outpost and comes home; returns what the player still sees there. */
function scoutPast(fog?: FogMode) {
  const w = duel(fog);
  const post = w.spawnBuilding('russia_power', 1, 60, 50, true);
  const tank = at(w, 'russia_mbt', 1, 62, 55);
  for (const e of [post, tank]) e.hp = e.maxHp = 1e6;
  tank.stance = 'holdFire';
  const scout = at(w, 'usa_mbt', 0, 30, 60);
  scout.hp = scout.maxHp = 1e6;
  scout.stance = 'holdFire';
  const unseen = () => !w.visibleTo(0, post.x, post.y) && !w.visibleTo(0, tank.x, tank.y);
  run(w, TPS);
  expect(unseen()).toBe(true); // never explored yet
  w.issue(0, { type: 'move', ids: [scout.id], x: 57.5, y: 54.5 });
  run(w, TPS * 25);
  expect(w.visibleTo(0, post.x, post.y)).toBe(true);
  expect(w.visibleTo(0, tank.x, tank.y)).toBe(true);
  w.issue(0, { type: 'move', ids: [scout.id], x: 20.5, y: 75.5 });
  run(w, TPS * 30);
  expect(Math.hypot(scout.x - tank.x, scout.y - tank.y)).toBeGreaterThan(25);
  const p = w.players[0];
  return {
    w,
    explored: p.explored[w.tileOf(post.x, post.y)] > 0 && p.explored[w.tileOf(tank.x, tank.y)] > 0,
    post: w.visibleTo(0, post.x, post.y),
    tank: w.visibleTo(0, tank.x, tank.y),
  };
}

describe('fog of war', () => {
  it('classic (RA2): explored ground stays revealed, structures and units on it stay visible after the scout leaves', () => {
    const r = scoutPast('classic');
    expect(r.w.fog).toBe('classic');
    expect(r.explored).toBe(true);
    expect(r.post).toBe(true);
    expect(r.tank).toBe(true);
    // the visible grid is exactly the explored grid
    const p = r.w.players[0];
    expect(p.visible).toEqual(p.explored);
  });

  it('modern: explored ground outside sight is fogged and hides what is there (unchanged default)', () => {
    const r = scoutPast();
    expect(r.w.fog).toBe('modern');
    expect(r.explored).toBe(true);
    expect(r.post).toBe(false);
    expect(r.tank).toBe(false);
  });

  it('classic: artillery shells revealed targets beyond its own sight on its own; modern does not', () => {
    const shots = (fog: FogMode) => {
      const w = duel(fog);
      const arty = at(w, 'usa_arty', 0, 40, 60);
      const tank = at(w, 'russia_mbt', 1, 49, 60);
      tank.hp = tank.maxHp = 1e6;
      tank.stance = 'holdFire';
      // explored earlier (a scout went by), nobody of ours sees it now
      const p = w.players[0];
      for (let y = 50; y < 70; y++) for (let x = 44; x < 56; x++) p.explored[y * w.map.w + x] = 1;
      const d = Math.hypot(tank.x - arty.x, tank.y - arty.y);
      expect(d).toBeGreaterThan(6.5); // beyond the howitzer's sight (6), inside its range (10)
      expect(d).toBeLessThan(10);
      let fired = 0;
      for (let t = 0; t < TPS * 10; t++) {
        w.step();
        for (const ev of w.drainEvents()) if (ev.t === 'fire' && ev.owner === 0) fired++;
      }
      return fired;
    };
    expect(shots('classic')).toBeGreaterThan(0);
    expect(shots('modern')).toBe(0);
  });

  it('classic applies to the AI as well: AI games run sensibly and stay deterministic', () => {
    const game = (a: Faction, b: Faction, seed: number) => {
      const w = new World({
        seed,
        fog: 'classic',
        players: [
          { name: a, faction: a, color: 0, isAI: true },
          { name: b, faction: b, color: 0, isAI: true },
        ],
      });
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
      return w;
    };
    const snap = (w: World) => w.tick + '#' + w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.hp.toFixed(1)}`).join('|');
    const x = game('usa', 'russia', 31);
    const y = game('usa', 'russia', 31);
    let fired = 0;
    let built = 0;
    for (let t = 0; t < TPS * 60 * 7 && !x.over; t++) {
      x.step();
      y.step();
      for (const ev of x.drainEvents()) {
        if (ev.t === 'fire') fired++;
        if (ev.t === 'placed') built++;
      }
      y.drainEvents();
      if (t % (TPS * 60) === 0) expect(snap(x)).toBe(snap(y));
    }
    expect(snap(x)).toBe(snap(y));
    expect(built).toBeGreaterThan(6);
    expect(fired).toBeGreaterThan(20);
    // each side's view: everything it explored is revealed, nothing more
    for (const p of x.players) expect(p.visible).toEqual(p.explored);
  }, 240000);
});
