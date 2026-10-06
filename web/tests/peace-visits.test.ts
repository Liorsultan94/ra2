import { describe, expect, it } from 'vitest';
import { AIController, HARVEST_KEEP_OUT } from '../src/sim/ai';
import { buildingDef, unitDef } from '../src/sim/defs';
import type { MapId } from '../src/sim/map';
import { MAP_IDS } from '../src/sim/maps';
import { peaceTicks } from '../src/sim/peace';
import { SuperweaponAI } from '../src/sim/superweapons';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

// The owner: "at the start of every game enemy vehicles come to my base, even with no attack". The AI's scout
// toured the player's ore fields and base from 0:25 on, through the grace. Now nothing of the enemy comes near
// the player's base during the grace, scouts only look from the edge afterwards, and the attacks still come.

/** The player's base: this close to its construction yard (or MCV / start), or to one of its structures. */
const BASE_R = 20;
const BUILDING_R = 8;
/** After the grace a scout looks from the edge of its sight: never this deep. */
const SCOUT_R = 15;

/** Player 0 stands in for a human who builds up and defends but never attacks; player 1 is the enemy AI (menu settings). */
function skirmish(map: MapId, seed: number, peace: number, a: Faction, b: Faction) {
  const w = new World({
    seed,
    map,
    players: [
      { name: 'You', faction: a, color: 0, isAI: false },
      { name: 'AI', faction: b, color: 0, isAI: true },
    ],
  });
  const ai = new AIController(w, 1, 'normal', { peaceTicks: peace });
  w.controllers.push(new AIController(w, 0, 'normal', { peaceTicks: Infinity }), ai, new SuperweaponAI(w, 1, { peaceTicks: peace }));
  return { w, ai };
}

function centre(w: World): [number, number] {
  const c =
    w.list.find((e) => !e.dead && e.owner === 0 && e.kind === 'building' && buildingDef(e.def).role === 'conyard') ??
    w.list.find((e) => !e.dead && e.owner === 0 && e.kind === 'unit' && unitDef(e.def).mcv);
  return c ? [c.x, c.y] : [w.players[0].startX + 0.5, w.players[0].startY + 0.5];
}

describe('enemy visits to the player base', () => {
  const pairs: [Faction, Faction][] = [
    ['usa', 'russia'],
    ['israel', 'iran'],
    ['germany', 'turkey'],
  ];
  for (const map of MAP_IDS) {
    it(`${map}: nothing comes near during the grace; afterwards attacks do, scouts stay at the edge`, () => {
      const peace = peaceTicks('normal', 'auto');
      pairs.forEach(([a, b], i) => {
        const { w, ai } = skirmish(map, 21 + i * 7, peace, a, b);
        const role = (ai as unknown as { role: Map<number, string> }).role;
        const inPeace: string[] = [];
        const scoutsDeep: string[] = [];
        let attack = -1;
        while (w.tick < peace + TPS * 60 * 5 && !w.over && attack < 0) {
          w.step();
          w.drainEvents();
          if (w.tick % 10) continue;
          const [px, py] = centre(w);
          const mine = w.list.filter((e) => !e.dead && e.owner === 0 && e.kind === 'building');
          for (const e of w.list) {
            if (e.dead || e.owner !== 1 || e.kind !== 'unit' || e.inside >= 0 || unitDef(e.def).temp) continue;
            const d = Math.hypot(e.x - px, e.y - py);
            const near = d <= BASE_R || mine.some((m) => Math.hypot(m.x - e.x, m.y - e.y) <= BUILDING_R);
            const tag = `${(w.tick / TPS).toFixed(0)}s ${e.def} (${role.get(e.id) ?? 'army'}, ${e.order.type}) ${d.toFixed(1)} tiles`;
            if (w.tick < peace) {
              if (near) inPeace.push(tag);
            } else if (role.get(e.id) === 'scout') {
              if (d <= SCOUT_R) scoutsDeep.push(tag);
            } else if (near && attack < 0) attack = w.tick;
          }
        }
        console.log(`${map} ${a} v ${b}: in the base during the grace ${inPeace.length}, first attack in the base ${attack < 0 ? 'never' : `${(attack / TPS / 60).toFixed(1)} min`}`);
        expect(inPeace.slice(0, 5)).toEqual([]);
        expect(scoutsDeep.slice(0, 5)).toEqual([]);
        expect(attack).toBeGreaterThanOrEqual(peace);
      });
    }, 240000);
  }

  it('AI harvesters never work the ore fields of the player base', () => {
    const { w } = skirmish('frontline', 5, Infinity, 'usa', 'russia');
    for (let i = 0; i < TPS * 100; i++) w.step();
    w.drainEvents();
    // an AI harvester just outside the player base, beyond its home ore field: its own search finds that field first
    const me = w.players[0];
    const field = w.map.oreMines.reduce((b, m) => (Math.hypot(m.x - me.startX, m.y - me.startY) < Math.hypot(b.x - me.startX, b.y - me.startY) ? m : b));
    const dx = field.x - me.startX;
    const dy = field.y - me.startY;
    const k = (HARVEST_KEEP_OUT + 3) / Math.hypot(dx, dy);
    const spot = w.nearestPassable(me.startX + dx * k, me.startY + dy * k, 6)!;
    // ore is left only in the player base and in one field at the AI's home, far away
    const ai = w.players[1];
    const far = w.map.oreMines.reduce((b, m) => (Math.hypot(m.x - ai.startX, m.y - ai.startY) < Math.hypot(b.x - ai.startX, b.y - ai.startY) ? m : b));
    for (let t = 0; t < w.map.ore.length; t++) {
      const x = t % w.map.w;
      const y = Math.floor(t / w.map.w);
      if (Math.hypot(x - me.startX, y - me.startY) > HARVEST_KEEP_OUT + 2 && Math.hypot(x - far.x, y - far.y) > 5) w.map.ore[t] = 0;
    }
    const hv = w.spawnUnit('russia_harvester', 1, spot[0] + 0.5, spot[1] + 0.5);
    const inBase = (t: number) => Math.hypot((t % w.map.w) + 0.5 - me.startX - 0.5, Math.floor(t / w.map.w) + 0.5 - me.startY - 0.5) <= HARVEST_KEEP_OUT;
    let picked = 0;
    let mined = 0;
    for (let i = 0; i < TPS * 90; i++) {
      w.step();
      w.drainEvents();
      for (const e of w.list) {
        if (e.dead || e.owner !== 1 || !unitDef(e.def).harvester || e.oreTile < 0 || !inBase(e.oreTile)) continue;
        if (e.id === hv.id && e.hstate === 'toOre') picked++;
        if (e.hstate === 'mining') mined++;
      }
    }
    // (the world's search may pick the field for a moment; the AI turns the harvester away before it gets there)
    expect(picked).toBeLessThan(TPS * 2);
    expect(mined).toBe(0);
    expect(hv.dead || Math.hypot(hv.x - me.startX, hv.y - me.startY) > 10).toBe(true);
  }, 120000);
});
