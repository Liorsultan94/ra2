import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { World } from '../src/sim/world';
import { MatchTracker, clock } from '../src/game/matchstats';
import { buildBriefing, mapUV, operationName } from '../src/ui/briefing';

function world(seed = 7) {
  return new World({
    seed,
    players: [
      { name: 'You', faction: 'usa', color: 0, isAI: false },
      { name: 'Russia', faction: 'russia', color: 0, isAI: true },
    ],
  });
}

describe('mission briefing', () => {
  it('codenames are deterministic per seed and vary between seeds', () => {
    expect(operationName(42)).toBe(operationName(42));
    expect(operationName(42)).toMatch(/^[A-Z]+ [A-Z]+$/);
    const names = new Set(Array.from({ length: 40 }, (_, i) => operationName(i * 7919)));
    expect(names.size).toBeGreaterThan(20);
  });

  it('builds intel and objectives from the map and factions', () => {
    const w = world();
    const b = buildBriefing(w, 0, { seed: 1, difficulty: 'hard', tod: 'night', weather: 'rain' });
    expect(b.enemy.name).toBe('Russia');
    expect(b.enemy.sw.name).toMatch(/TOS-2/);
    expect(b.enemy.threats.length).toBeGreaterThanOrEqual(2);
    expect(b.you.name).toBe('United States');
    expect(b.primary[0]).toMatch(/Destroy all enemy structures/);
    expect(b.secondary.length).toBeGreaterThanOrEqual(3);
    expect(b.secondary.length).toBeLessThanOrEqual(5);
    expect(b.secondary[0]).toMatch(/bridges/);
    expect(b.time).toMatch(/NIGHT/);
    expect(b.weather).toMatch(/RAIN/);
    expect(b.mapName).toBe('Frontline Crossing');
  });

  it('tactical map transform puts the two bases on opposite sides', () => {
    const w = world();
    const [a, c] = w.map.starts;
    const ua = mapUV(w.map.w, w.map.h, a.x, a.y);
    const uc = mapUV(w.map.w, w.map.h, c.x, c.y);
    expect(ua.u).toBeLessThan(0.5);
    expect(uc.u).toBeGreaterThan(0.5);
  });
});

describe('match tracker', () => {
  it('collects samples and a report from events only, without touching the sim', () => {
    const w = world(11);
    w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
    const t = new MatchTracker(w, 0);
    for (let i = 0; i < 20 * 240; i++) {
      w.step();
      for (const ev of w.drainEvents()) t.onEvent(ev);
      t.update();
    }
    // end it: every enemy structure / MCV falls
    const killer = w.list.find((e) => !e.dead && e.owner === 0 && e.kind === 'unit');
    for (const e of w.list.filter((e) => !e.dead && e.owner === 1 && (e.kind === 'building' || e.def.endsWith('mcv')))) w.kill(e, 0, killer);
    w.step();
    for (const ev of w.drainEvents()) t.onEvent(ev);
    const r = t.report(true);
    expect(r.time).toBeGreaterThan(200);
    expect(r.samples.length).toBeGreaterThan(40);
    expect(r.you.structuresBuilt).toBeGreaterThan(2);
    expect(r.you.unitsBuilt).toBeGreaterThan(0);
    expect(r.you.structuresDestroyed).toBeGreaterThan(0);
    expect(r.enemy.structuresLost).toBe(r.you.structuresDestroyed);
    expect(r.you.harvested).toBe(w.players[0].stats.harvested);
    expect(r.highlights.length).toBeGreaterThan(0);
    expect(r.highlights.at(-1)!.text).toMatch(/victory/);
    expect(clock(r.time)).toMatch(/^\d+:\d\d$/);
  });
});
