import { describe, expect, it } from 'vitest';
import { AIController, type Difficulty } from '../src/sim/ai';
import { factionDefByRole } from '../src/sim/defs';
import { TPS, type Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAI = any;

/**
 * AI2 orderly retreat: Russia's AI (player 1) with a gun tower out from its base sends a light wave towards the
 * enemy; a much stronger enemy tank force meets it in the open. Player 0 has no controller (the tanks just stand).
 */
function setup(diff: Difficulty) {
  const w = new World({
    seed: 3,
    map: 'frontline',
    players: [
      { name: 'usa', faction: 'usa', color: 0, isAI: true },
      { name: 'russia', faction: 'russia', color: 0, isAI: true },
    ],
  });
  const ai = new AIController(w, 1, diff) as AnyAI;
  w.controllers.push(ai);
  for (let t = 0; t < TPS * 20; t++) w.step();
  const p = w.players[1];
  const e = w.players[0];
  const [hx, hy] = [p.startX + 0.5, p.startY + 0.5];
  const dx = e.startX - p.startX;
  const dy = e.startY - p.startY;
  const len = Math.hypot(dx, dy);
  const at = (k: number): [number, number] => {
    const q = w.nearestPassable(hx + (dx / len) * k, hy + (dy / len) * k, 6, w.mainland)!;
    return [q[0] + 0.5, q[1] + 0.5];
  };
  // a gun tower 12 tiles out (our defensive position)
  const gun = factionDefByRole('russia', 'def_gun').id;
  const [gx, gy] = at(12);
  w.spawnBuilding(gun, 1, Math.floor(gx), Math.floor(gy), true);
  // the wave, 40 tiles out, attack-moving towards the enemy base
  const [wx, wy] = at(40);
  const wave: Entity[] = [];
  for (let k = 0; k < 5; k++) wave.push(w.spawnUnit('russia_apc', 1, wx + (k % 3) - 1, wy + Math.floor(k / 3)));
  const ids = wave.map((u) => u.id);
  w.issue(1, { type: 'move', ids, x: e.startX + 0.5, y: e.startY + 0.5, attackMove: true });
  ai.waves.push({ ids, tx: e.startX + 0.5, ty: e.startY + 0.5, focus: -1, born: w.tick, lane: '', value: 4000, killed: 0 });
  // a much stronger enemy tank force just ahead of it
  const [ex, ey] = at(47);
  const foes: Entity[] = [];
  for (let k = 0; k < 8; k++) foes.push(w.spawnUnit('usa_mbt', 0, ex + (k % 4) - 1.5, ey + Math.floor(k / 4)));
  return { w, ai, wave, foes, home: [hx, hy] as [number, number], gun: [gx, gy] as [number, number] };
}

describe('orderly retreat (AI2)', () => {
  it('Hard: a losing group pulls back together towards its defences, regroups and returns', () => {
    const { w, ai, wave, foes, home, gun } = setup('hard');
    const d0 = wave.map((u) => Math.hypot(u.x - home[0], u.y - home[1]));
    for (let t = 0; t < TPS * 8 && !ai.stats.retreats; t++) w.step();
    expect(ai.stats.retreats).toBe(1);
    const fb = ai.fallbacks[0];
    // towards its own gun tower (just behind it), not just away
    expect(Math.hypot(fb.x - gun[0], fb.y - gun[1])).toBeLessThan(4.5);
    expect(Math.hypot(fb.x - home[0], fb.y - home[1])).toBeLessThan(Math.hypot(gun[0] - home[0], gun[1] - home[1]));
    const alive = () => wave.filter((u) => !u.dead);
    expect(alive().every((u) => ai.roleOf(u) === 'fallback' || ai.roleOf(u) === 'retreat')).toBe(true);
    for (let t = 0; t < TPS * 12; t++) w.step();
    // all together, closer to home (no stopping to fight on the way)
    const back = alive().filter((u) => Math.hypot(u.x - home[0], u.y - home[1]) < d0[wave.indexOf(u)] - 8);
    expect(back.length).toBeGreaterThanOrEqual(Math.max(2, alive().length - 1));
    // the enemy force is gone (beaten elsewhere): the group regroups with reinforcements and returns, committed
    for (const f of foes) if (!f.dead) w.remove(f);
    ai.waveSize = 999; // (the next wave is not ready: the reinforcements wait at the rally point)
    ai.waveStale = 1e9;
    const [rx, ry] = ai.rally();
    for (let k = 0; k < 10; k++) w.spawnUnit('russia_mbt', 1, rx + (k % 5) - 2, ry + Math.floor(k / 5));
    for (let t = 0; t < TPS * 60 && !ai.stats.returns; t++) w.step();
    expect(ai.stats.returns, JSON.stringify(ai.stats)).toBe(1);
    const back2 = ai.waves[ai.waves.length - 1];
    expect(back2.commit).toBeGreaterThan(w.tick);
    // (merged with the reinforcements; a badly damaged vehicle may still be off to repair)
    expect(alive().some((u) => ai.roleOf(u) === 'fallback')).toBe(false);
    expect(back2.ids.length).toBeGreaterThan(alive().length);
    // heading out to the objective again
    for (let t = 0; t < TPS * 10; t++) w.step();
    const out = alive().filter((u) => Math.hypot(u.x - home[0], u.y - home[1]) > Math.hypot(fb.x - home[0], fb.y - home[1]) + 3);
    expect(out.length).toBeGreaterThanOrEqual(2);
  }, 60000);

  it('Hard: a committed group does not retreat', () => {
    const { w, ai } = setup('hard');
    for (const wv of ai.waves) wv.commit = w.tick + TPS * 30;
    for (let t = 0; t < TPS * 6; t++) w.step();
    expect(ai.stats.retreats).toBe(0);
  }, 60000);

  it('Easy never retreats as a group (Easy stays easy)', () => {
    const { w, ai } = setup('easy');
    for (let t = 0; t < TPS * 10; t++) w.step();
    expect(ai.stats.retreats).toBe(0);
  }, 60000);
});
