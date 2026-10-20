import { describe, expect, it } from 'vitest';
import { DECK, deckToWorld } from '../src/sim/airbase';
import { DEF_LIST, DEFS, FACTIONS, buildingDef, unitDef } from '../src/sim/defs';
import { Loco } from '../src/sim/slope';
import { TPS, type Entity, type Faction, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV2 aircraft carriers (USA, Russia, China): one per player, late tech, deep water only (naval.ts DEEP_DEPTH), a
 * mobile airbase whose deck jets launch off the bow, strike, land back on the moving deck from the stern and
 * rearm there (airbase.ts); a sunk carrier takes its deck down and the airborne jets divert.
 */

const mk = (a: Faction = 'usa', b: Faction = 'russia', map: 'desert' | 'frontline' = 'desert', seed = 1) =>
  new World({ seed, map, players: [
    { name: 'A', faction: a, color: 0, isAI: false },
    { name: 'B', faction: b, color: 0, isAI: false },
  ] });

/** Deep water (the carrier's class) nearest (x, y). */
function deepNear(w: World, x: number, y: number): [number, number] {
  const pass = w.passes[Loco.Deep];
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < pass.length; i++) {
    if (!pass[i]) continue;
    // (in the open: deep water two tiles round as well, room to turn)
    const tx = i % w.map.w;
    const ty = Math.floor(i / w.map.w);
    let open = true;
    for (let oy = -2; oy <= 2 && open; oy++) for (let ox = -2; ox <= 2; ox++) if (!pass[(ty + oy) * w.map.w + tx + ox]) open = false;
    if (!open) continue;
    const d = Math.hypot(tx - x, ty - y);
    if (d < bd) (bd = d), (best = i);
  }
  expect(best).toBeGreaterThanOrEqual(0);
  return [(best % w.map.w) + 0.5, Math.floor(best / w.map.w) + 0.5];
}

/** Deep water about `r` tiles from (x, y), towards (dx, dy) if it can. */
function deepAway(w: World, x: number, y: number, r: number): [number, number] {
  const pass = w.passes[Loco.Deep];
  const reg = w.regions[Loco.Deep];
  const r0 = reg[w.tileOf(x, y)];
  let best = -1;
  let bd = Infinity;
  for (let i = 0; i < pass.length; i++) {
    if (!pass[i] || reg[i] !== r0) continue;
    const d = Math.abs(Math.hypot((i % w.map.w) - x, Math.floor(i / w.map.w) - y) - r);
    if (d < bd) (bd = d), (best = i);
  }
  return [(best % w.map.w) + 0.5, Math.floor(best / w.map.w) + 0.5];
}

/** Run until cond or max ticks, collecting events. */
function run(w: World, max: number, cond: () => boolean, evs?: SimEvent[]) {
  for (let i = 0; i < max && !cond(); i++) {
    w.step();
    const e = w.drainEvents();
    if (evs) evs.push(...e);
  }
  return cond();
}

describe('aircraft carrier: who and how many', () => {
  it('only USA, Russia and China have one, deep-water, expensive and late', () => {
    const carriers = DEF_LIST.filter((d) => d.kind === 'unit' && d.naval === 'deep');
    expect(carriers.map((d) => d.faction).sort()).toEqual(['china', 'russia', 'usa']);
    for (const f of FACTIONS) {
      const has = !!DEFS[`${f.id}_carrier`];
      expect(has, f.id).toBe(['usa', 'russia', 'china'].includes(f.id));
      expect(!!DEFS[`${f.id}_cvjet`], f.id).toBe(has);
    }
    for (const d of carriers) {
      if (d.kind !== 'unit') continue;
      expect(d.limit).toBe(1);
      expect(d.deck).toBe(4);
      expect(d.cost).toBeGreaterThanOrEqual(3500);
      expect(d.buildTime).toBeGreaterThanOrEqual(40);
      expect(d.prereq).toEqual(expect.arrayContaining(['shipyard', 'airfield', 'tech']));
      // no main gun: air defence only
      for (const wid of [d.weapon, d.weapon2]) if (wid) expect(['ciws', 'carrierSam'].some((k) => wid.endsWith(k)), wid).toBe(true);
    }
    expect((DEFS.usa_cvjet as { deckJet?: string }).deckJet).toBe('catapult');
    expect((DEFS.russia_cvjet as { deckJet?: string }).deckJet).toBe('skijump');
    expect((DEFS.china_cvjet as { deckJet?: string }).deckJet).toBe('skijump');
  });

  it('needs the Shipyard (by deep water), the airbase and the battle lab; one per player', () => {
    const w = mk();
    const s = w.map.starts[0];
    for (const e of [...w.list]) if (e.owner === 0 && e.kind === 'unit') w.remove(e);
    w.spawnBuilding('usa_conyard', 0, s.x - 1, s.y - 1, true);
    w.players[0].credits = 100000;
    expect(w.canBuild(0, 'usa_carrier')).toBe(false);
    let k = 0;
    for (const r of ['power', 'barracks', 'refinery', 'factory', 'radar', 'airfield', 'tech', 'power', 'power']) {
      const d = buildingDef(`usa_${r}`);
      w.spawnBuilding(d.id, 0, 2 + (k % 6) * 8, w.map.h - 8 - Math.floor(k / 6) * 6, true);
      k++;
    }
    expect(w.canBuild(0, 'usa_carrier')).toBe(false); // no Shipyard yet
    // the Shipyard on the coast by the deep sea
    let yard: Entity | null = null;
    for (const i of w.shipSpots) {
      const tx = i % w.map.w;
      const ty = Math.floor(i / w.map.w);
      if (!w.canPlace(0, 'usa_shipyard', tx, ty)) continue;
      yard = w.spawnBuilding('usa_shipyard', 0, tx, ty, true);
      if (w.canBuild(0, 'usa_carrier')) break;
      w.remove(yard);
      yard = null;
    }
    expect(yard).not.toBeNull();
    expect(w.canBuild(0, 'usa_carrier')).toBe(true);
    // the deck jets need the carrier
    expect(w.canBuild(0, 'usa_cvjet')).toBe(false);
    w.issue(0, { type: 'produce', def: 'usa_carrier' });
    w.step();
    expect(w.players[0].queues.naval.map((q) => q.def)).toEqual(['usa_carrier']);
    expect(w.canBuild(0, 'usa_carrier')).toBe(false); // limit 1: one in production
    expect(run(w, TPS * 60, () => w.list.some((e) => e.def === 'usa_carrier'))).toBe(true);
    const c = w.list.find((e) => e.def === 'usa_carrier')!;
    expect(w.passes[Loco.Deep][w.tileOf(c.x, c.y)]).toBe(1);
    expect(w.canBuild(0, 'usa_carrier')).toBe(false); // limit 1: one afloat
    // now its air wing, 4 deck pads
    for (let i = 0; i < 4; i++) {
      expect(w.canBuild(0, 'usa_cvjet')).toBe(true);
      w.issue(0, { type: 'produce', def: 'usa_cvjet' });
      w.step();
    }
    expect(w.canBuild(0, 'usa_cvjet')).toBe(false);
    expect(run(w, TPS * 90, () => w.list.filter((e) => e.def === 'usa_cvjet').length === 4)).toBe(true);
    for (const j of w.list.filter((e) => e.def === 'usa_cvjet')) {
      expect(j.sortie?.base).toBe(c.id);
      expect(j.sortie?.phase).toBe('parked');
    }
    // other nations cannot
    expect(w.canBuild(1, 'russia_carrier')).toBe(false);
  });

  it('sails deep water only', () => {
    const w = mk('china', 'usa');
    const s = w.map.starts[0];
    const [cx, cy] = deepNear(w, s.x, s.y);
    const c = w.spawnUnit('china_carrier', 0, cx, cy);
    let seed = 11;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    let moved = 0;
    let lx = c.x;
    let ly = c.y;
    for (let t = 0; t < TPS * 150; t++) {
      if (t % (TPS * 25) === 0) w.issue(0, { type: 'move', ids: [c.id], x: rnd() * w.map.w, y: rnd() * w.map.h });
      w.step();
      expect(w.naval.base[3][w.tileOf(c.x, c.y)], `${c.x},${c.y}`).toBe(1);
      moved += Math.hypot(c.x - lx, c.y - ly);
      lx = c.x;
      ly = c.y;
    }
    expect(moved).toBeGreaterThan(20);
    // and never onto a reef, a shelf or the land: a deep-water tile has deep water all round
    expect(unitDef('china_carrier').naval).toBe('deep');
  });
});

describe('aircraft carrier: the deck', () => {
  /** A carrier at sea with its 4 deck jets, sailing, and an enemy target on the coast in reach. */
  function setup(f: Faction) {
    const w = mk(f, f === 'usa' ? 'russia' : 'usa');
    const s = w.map.starts[0];
    const [cx, cy] = deepNear(w, s.x, s.y);
    const c = w.spawnUnit(`${f}_carrier`, 0, cx, cy);
    const jets: Entity[] = [];
    for (let i = 0; i < 4; i++) {
      const j = w.spawnUnit(`${f}_cvjet`, 0, c.x, c.y);
      w.step();
      jets.push(j);
    }
    for (const j of jets) expect(j.sortie?.base).toBe(c.id);
    // the target: an enemy structure ashore some way off
    const land = w.nearestPassable(cx + 14, cy - 14, 30, 0, Loco.Vehicle) ?? w.nearestPassable(cx, cy, 40, 0, Loco.Vehicle)!;
    const t = w.spawnBuilding(`${w.players[1].faction}_power`, 1, land[0], land[1], true);
    for (const p of w.players) p.explored.fill(1);
    return { w, c, jets, t };
  }

  for (const f of ['usa', 'russia'] as Faction[]) {
    it(`${f}: jets launch off the bow, strike and land back on the moving deck`, () => {
      const { w, c, jets, t } = setup(f);
      // the carrier under way while its jets fly
      const away = deepAway(w, c.x, c.y, 18);
      w.issue(0, { type: 'move', ids: [c.id], x: away[0], y: away[1] });
      w.issue(0, { type: 'attack', ids: jets.map((j) => j.id), target: t.id });
      const evs: SimEvent[] = [];
      const hp0 = t.hp;
      // every jet takes off, releases and lands back on the deck at least once
      const done = () => jets.every((j) => evs.some((e) => e.t === 'sortie' && e.id === j.id && e.what === 'touchdown'));
      let maxSpeed = 0;
      let ox = c.x;
      let oy = c.y;
      let offDeck = 0;
      for (let i = 0; i < TPS * 240 && !done(); i++) {
        w.step();
        evs.push(...w.drainEvents());
        maxSpeed = Math.max(maxSpeed, Math.hypot(c.x - ox, c.y - oy) * TPS);
        ox = c.x;
        oy = c.y;
        // jets on deck ride on the deck (within the ship's length of its centre)
        for (const j of jets) {
          const ph = j.sortie?.phase;
          if (ph === 'parked' || ph === 'taxiIn' || ph === 'taxiOut' || ph === 'rollout' || ph === 'hold' || ph === 'lineup') if (Math.hypot(j.x - c.x, j.y - c.y) > 2.8) offDeck++;
        }
      }
      const msg = JSON.stringify(jets.map((j) => [j.sortie?.phase, +j.x.toFixed(1), +j.y.toFixed(1), j.dead]));
      expect(done(), msg).toBe(true);
      expect(maxSpeed, 'the carrier sailed').toBeGreaterThan(0.8);
      expect(offDeck).toBe(0);
      for (const j of jets) {
        const mine = evs.filter((e) => e.t === 'sortie' && e.id === j.id);
        expect(mine.map((e) => (e as { what: string }).what)).toEqual(expect.arrayContaining(['takeoff', 'touchdown']));
      }
      // (the first bombs may destroy the target: the later jets turn back without releasing)
      expect(evs.some((e) => e.t === 'sortie' && (e as { what: string }).what === 'release')).toBe(true);
      // the touchdowns were on the moving deck: near the stern's landing area
      expect(t.hp < hp0 || t.dead).toBe(true);
      // back on their pads in the end, rearming
      expect(run(w, TPS * 40, () => jets.every((j) => j.dead || j.sortie?.phase === 'parked'))).toBe(true);
      for (const j of jets) {
        if (j.dead) continue;
        const [px, py] = deckToWorld(c, DECK.pads[j.sortie!.pad][0], DECK.pads[j.sortie!.pad][1]);
        expect(Math.hypot(j.x - px, j.y - py)).toBeLessThan(0.2);
      }
    });
  }

  it('a sunk carrier takes its deck down; the jets in the air divert to an airbase', () => {
    const { w, c, jets, t } = setup('china');
    const s = w.map.starts[0];
    w.spawnBuilding('china_airfield', 0, s.x - 3, s.y + 3, true);
    // two jets out on a strike, two on deck
    w.issue(0, { type: 'attack', ids: [jets[0].id, jets[1].id], target: t.id });
    const evs: SimEvent[] = [];
    expect(run(w, TPS * 60, () => jets[0].z > 1 && jets[1].z > 1, evs)).toBe(true);
    w.kill(c, -1);
    run(w, TPS * 3, () => false, evs);
    expect(jets[2].dead && jets[3].dead).toBe(true);
    expect(jets[0].dead || jets[1].dead).toBe(false);
    expect(evs.filter((e) => e.t === 'sortie' && (e as { what: string }).what === 'divert').length).toBeGreaterThanOrEqual(2);
    for (const j of [jets[0], jets[1]]) expect(w.get(j.sortie!.base)?.def).toBe('china_airfield');
    // they land there
    expect(run(w, TPS * 200, () => [jets[0], jets[1]].every((j) => j.sortie?.phase === 'parked'), evs)).toBe(true);
  });

  it('is deterministic', () => {
    const go = () => {
      const { w, c, jets, t } = setup('usa');
      w.issue(0, { type: 'attack', ids: jets.map((j) => j.id), target: t.id });
      const away = deepAway(w, c.x, c.y, 16);
      w.issue(0, { type: 'move', ids: [c.id], x: away[0], y: away[1] });
      for (let i = 0; i < TPS * 50; i++) w.step();
      return JSON.stringify([c.x, c.y, jets.map((j) => [j.x, j.y, j.z, j.sortie?.phase])]);
    };
    expect(go()).toBe(go());
  });
});
