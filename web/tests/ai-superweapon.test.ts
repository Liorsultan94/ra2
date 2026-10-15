import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { SW_INFO } from '../src/sim/specialdefs';
import { SuperweaponAI, swInfoOf } from '../src/sim/superweapons';
import { TPS, type Entity } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAI = any;

/**
 * Russia's Hard AI (player 1) with a charged superweapon. Enemy (USA) tank clusters: A seen now, B richer but never
 * seen (fog), C the richest seen but one of our own units stands in it.
 */
function setup() {
  const w = new World({ seed: 2, map: 'frontline', players: [
    { name: 'usa', faction: 'usa', color: 0, isAI: true },
    { name: 'russia', faction: 'russia', color: 0, isAI: true },
  ] });
  const ai = new AIController(w, 1, 'hard') as AnyAI;
  w.controllers.push(ai);
  const at = (x: number, y: number) => {
    const p = w.nearestPassable(x, y, 6, w.mainland)!;
    return [p[0] + 0.5, p[1] + 0.5];
  };
  const seen = (e: Entity) => ai.intel.set(e.id, { x: e.x, y: e.y, def: e.def, building: false, seen: w.tick, vx: 0, vy: 0 });
  const cluster = (cx: number, cy: number, n: number, mark: boolean) => {
    const [x, y] = at(cx, cy);
    const out: Entity[] = [];
    for (let k = 0; k < n; k++) out.push(w.spawnUnit('usa_mbt', 0, x + (k % 3) - 1, y + Math.floor(k / 3) - 1));
    if (mark) out.forEach(seen);
    return { x, y, out };
  };
  const m = w.map;
  const A = cluster(m.w * 0.35, m.h * 0.5, 6, true);
  const B = cluster(m.w * 0.5, m.h * 0.3, 10, false);
  const C = cluster(m.w * 0.6, m.h * 0.65, 9, true);
  const own = w.spawnUnit('russia_rifle', 1, C.x + 1, C.y);
  w.step(); // (the spatial index)
  return { w, ai, A, B, C, own, seen };
}

describe('smart superweapon use (AI2)', () => {
  it('aims at the most valuable target it has seen, never one its own units stand in, never one it has not seen', () => {
    const { w, ai, A, own } = setup();
    const r = SW_INFO.tos2.radius;
    const aim = ai.swAim(r, w.tick - TPS * 120);
    expect(aim).toBeTruthy();
    expect(Math.hypot(aim[0] - A.x, aim[1] - A.y)).toBeLessThan(2.5);
    expect(Math.hypot(aim[0] - own.x, aim[1] - own.y)).toBeGreaterThan(r + 1.5);
    // our soldier leaves cluster C: now it is the best target
    w.remove(own);
    const aim2 = ai.swAim(r, w.tick - TPS * 120);
    expect(aim2[0]).not.toBeCloseTo(aim[0]);
  });

  it('Hard holds it for a big attack massing (or its own push), then fires anyway; Easy fires at once', () => {
    const { w, ai, A } = setup();
    const r = SW_INFO.tos2.radius;
    for (const u of A.out.slice(3)) w.remove(u);
    for (const id of [...ai.intel.keys()]) if (!w.get(id)) ai.intel.delete(id);
    // small fry only (C carries our soldier): hold
    expect(ai.swAim(r, w.tick)).toBeNull();
    // ... but not for ever
    expect(ai.swAim(r, w.tick - TPS * 61)).toBeTruthy();
    const easy = new AIController(w, 1, 'easy') as AnyAI;
    easy.intel = ai.intel;
    // (Easy aims only at structures it has seen, at once: none here, so where the enemy base is known to be)
    const e = w.players[0];
    expect(easy.swAim(r, w.tick)).toEqual([e.startX + 0.5, e.startY + 0.5]);
  });

  it('leads a moving cluster a little (Hard)', () => {
    const { w, ai, A } = setup();
    for (const u of A.out) ai.intel.get(u.id).vx = 0.08; // 1.6 tiles per second east
    const aim = ai.swAim(SW_INFO.tos2.radius, w.tick - TPS * 120);
    expect(aim[0] - A.x).toBeGreaterThan(1);
    expect(aim[0] - A.x).toBeLessThan(3.6);
  });

  it('fires through the normal superweapon command (warnings and countdown unchanged)', () => {
    const { w, ai, A } = setup();
    const p = w.players[1];
    const q = w.nearestPassable(p.startX + 4, p.startY + 4, 8, w.mainland)!;
    w.spawnBuilding('russia_superweapon', 1, q[0], q[1], true);
    w.controllers.push(new SuperweaponAI(w, 1, { ai }));
    w.step();
    expect(p.sw.at).toBeGreaterThan(w.tick);
    p.sw.at = w.tick; // charged (cluster A, six tanks, is a big force massing: no need to hold)
    const ev: { x: number; y: number }[] = [];
    for (let t = 0; t < TPS * 3 && !ev.length; t++) {
      // (keep cluster A in sight for the test: the AI's own updates only see what its units see)
      for (const u of A.out) {
        const it = ai.intel.get(u.id);
        if (it) it.seen = w.tick;
      }
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'superweapon' && e.phase === 'launch' && e.owner === 1) ev.push({ x: e.x, y: e.y });
    }
    expect(ev.length).toBe(1);
    expect(Math.hypot(ev[0].x - A.x, ev[0].y - A.y)).toBeLessThan(2.5);
    expect(p.sw.at).toBeGreaterThan(w.tick + swInfoOf(p).charge - TPS * 5);
  });
});
