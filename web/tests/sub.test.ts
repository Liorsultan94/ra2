import { describe, expect, it } from 'vitest';
import { DEFS, buildingDef, unitDef } from '../src/sim/defs';
import { SUB_DIVE_TICKS, SUB_SURFACE_TICKS } from '../src/sim/sub';
import { Loco } from '../src/sim/slope';
import { TPS, type Entity, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

/*
 * NV4 submarines: the roster (nuclear USA / Russia / China, conventional Israel / Germany / Korea / Turkey, nothing for
 * Iran and Ukraine), the prerequisites, invisibility, the 5 s up / 5 s down, submarines see submarines, hold fire stays
 * down, a land strike inside the range and not outside it, determinism.
 */

const mk = (a: Faction = 'usa', b: Faction = 'russia', seed = 1) =>
  new World({ seed, map: 'desert', players: [
    { name: 'A', faction: a, color: 0, isAI: false },
    { name: 'B', faction: b, color: 0, isAI: false },
  ] });

const SEA: [number, number] = [110.5, 152.5];
// (the start units stay: a player with nothing left is defeated and the match ends; they are far from the sea)
const clearUnits = (_w: World) => {};
/** A sub for player 0 in the open sea, and an enemy patrol boat `d` tiles east of it (still), both stepped once. */
function duel(a: Faction = 'usa', d = 5) {
  const w = mk(a, 'russia');
  clearUnits(w);
  const sub = w.spawnUnit(`${a}_sub`, 0, SEA[0], SEA[1]);
  const boat = w.spawnUnit('russia_patrol', 1, SEA[0] + d, SEA[1]);
  w.step();
  return { w, sub, boat };
}

describe('submarines: roster and prerequisites', () => {
  it('nuclear for USA / Russia / China, conventional for Israel / Germany / Korea / Turkey, none for Iran and Ukraine', () => {
    for (const n of ['usa', 'russia', 'china']) {
      const d = unitDef(`${n}_sub`);
      expect(d.submerge).toBe('sub');
      expect(d.prereq).toEqual(['shipyard', 'tech']);
      expect(d.weapon).toBe('subMissileN');
    }
    for (const n of ['israel', 'germany', 'korea', 'turkey']) {
      const d = unitDef(`${n}_sub`);
      expect(d.prereq).toEqual(['shipyard']);
      expect(d.weapon).toBe('subMissileC');
      expect(d.limit).toBeUndefined();
    }
    expect(DEFS['iran_sub']).toBeUndefined();
    expect(DEFS['ukraine_sub']).toBeUndefined();
    expect(unitDef('usa_sub').cost).toBeGreaterThan(unitDef('israel_sub').cost);
  });

  it('needs the Battle Lab (nuclear) / only the Shipyard (conventional)', () => {
    const w = mk('usa', 'israel');
    const s = w.map.starts[0];
    for (const e of [...w.list]) if (e.owner === 0 && e.kind === 'unit') w.remove(e);
    w.spawnBuilding('usa_conyard', 0, s.x - 1, s.y - 1, true);
    w.players[0].credits = 100000;
    for (const [k, r] of ['power', 'refinery', 'factory', 'radar'].entries()) w.spawnBuilding(buildingDef(`usa_${r}`).id, 0, 2 + k * 5, w.map.h - 8, true);
    let yard: Entity | null = null;
    for (const i of w.shipSpots) {
      const tx = i % w.map.w;
      const ty = Math.floor(i / w.map.w);
      if (!w.canPlace(0, 'usa_shipyard', tx, ty)) continue;
      yard = w.spawnBuilding('usa_shipyard', 0, tx, ty, true);
      break;
    }
    expect(yard).not.toBeNull();
    expect(w.canBuild(0, 'usa_patrol')).toBe(true);
    expect(w.canBuild(0, 'usa_sub')).toBe(false); // no Battle Lab yet
    w.spawnBuilding('usa_tech', 0, 40, w.map.h - 8, true);
    expect(w.canBuild(0, 'usa_sub')).toBe(true);
    // (no limit: a queue of them is fine)
    w.issue(0, { type: 'produce', def: 'usa_sub' });
    w.issue(0, { type: 'produce', def: 'usa_sub' });
    w.step();
    expect(w.players[0].queues.naval.length).toBe(2);
    expect(w.canBuild(0, 'usa_sub')).toBe(true);
  });
});

describe('submarines: stealth', () => {
  it('is invisible to the enemy and cannot be hit by anything, area attacks included; its owner sees it', () => {
    const { w, sub, boat } = duel('usa', 4);
    expect(sub.dive).toBe(true);
    expect(w.sees(0, sub)).toBe(true);
    expect(w.sees(1, sub)).toBe(false);
    // (the owner's submarine holds its fire: it must not come up by itself)
    w.issue(0, { type: 'stance', ids: [sub.id], stance: 'holdFire' });
    // the enemy boat is ordered to fire at it and an area weapon lands on it: nothing happens
    w.issue(1, { type: 'attack', ids: [boat.id], target: sub.id });
    const hp = sub.hp;
    for (let i = 0; i < 200; i++) w.step();
    expect(sub.hp).toBe(hp);
    w.damage(sub, 500, 'missile', boat);
    expect(sub.hp).toBe(hp);
  });

  it('comes up in 5 s to attack, stays visible while it attacks, dives 5 s after, then vanishes again', () => {
    const { w, sub, boat } = duel('usa', 5);
    sub.subPhase = 0;
    boat.hp = boat.maxHp = 100000; // (it must not die: the order is what we cancel)
    w.issue(0, { type: 'attack', ids: [sub.id], target: boat.id });
    let t0 = -1;
    let upAt = -1;
    let firstShot = -1;
    for (let i = 0; i < 400; i++) {
      w.step();
      if (t0 < 0 && sub.subPhase === 1) t0 = w.tick;
      if (upAt < 0 && sub.subPhase === 2) upAt = w.tick;
      for (const ev of w.drainEvents()) if (ev.t === 'fire' && ev.id === sub.id && firstShot < 0) firstShot = w.tick;
      if (i === 50) {
        // coming up: exposed (visible to the enemy, hittable) but not yet firing
        expect(sub.dive).toBe(false);
        expect(w.sees(1, sub)).toBe(true);
        expect(firstShot).toBe(-1);
      }
    }
    expect(t0).toBeGreaterThan(0);
    expect(upAt - t0).toBe(SUB_SURFACE_TICKS);
    expect(firstShot).toBeGreaterThanOrEqual(upAt);
    expect(sub.dive).toBe(false); // still attacking: still up
    // cancel the order: it dives after the linger and is gone 5 s later
    w.issue(0, { type: 'stop', ids: [sub.id] });
    w.issue(1, { type: 'move', ids: [boat.id], x: SEA[0] + 60, y: SEA[1] });
    let d0 = -1;
    let gone = -1;
    for (let i = 0; i < 600 && gone < 0; i++) {
      w.step();
      if (d0 < 0 && sub.subPhase === 3) d0 = w.tick;
      if (gone < 0 && sub.subPhase === 0) gone = w.tick;
    }
    expect(d0).toBeGreaterThan(0);
    expect(gone - d0).toBe(SUB_DIVE_TICKS);
    expect(sub.dive).toBe(true);
    expect(w.sees(1, sub)).toBe(false);
  });

  it('a submarine always sees an enemy submarine, hurts it with torpedoes, and a ship cannot', () => {
    const w = mk('usa', 'germany');
    clearUnits(w);
    const a = w.spawnUnit('usa_sub', 0, SEA[0], SEA[1]);
    const b = w.spawnUnit('germany_sub', 1, SEA[0] + 6, SEA[1]);
    const far = w.spawnUnit('germany_sub', 1, SEA[0] + 40, SEA[1]);
    w.step();
    expect(b.dive).toBe(true);
    expect(w.sees(0, b)).toBe(true); // our submarine hears it
    expect(w.sees(0, far)).toBe(false); // too far
    expect(w.sees(1, a)).toBe(true); // and it hears ours
    // a surface ship cannot hurt it, a submarine's torpedo does
    const ship = w.spawnUnit('usa_patrol', 0, SEA[0] + 5, SEA[1] + 1);
    w.step();
    const hp = b.hp;
    w.damage(b, 100, 'flak', ship);
    expect(b.hp).toBe(hp);
    w.damage(b, 100, 'missile', a);
    expect(b.hp).toBeLessThan(hp);
    // a submarine attack order on it works while it is still down
    w.issue(0, { type: 'attack', ids: [a.id], target: b.id });
    const hp2 = b.hp;
    for (let i = 0; i < 400; i++) w.step();
    expect(b.hp).toBeLessThan(hp2);
  });

  it('hold fire stays submerged: no auto engagement, no surfacing', () => {
    const { w, sub } = duel('usa', 4);
    w.issue(0, { type: 'stance', ids: [sub.id], stance: 'holdFire' });
    for (let i = 0; i < 300; i++) w.step();
    expect(sub.subPhase ?? 0).toBe(0);
    expect(sub.dive).toBe(true);
    // while a guarding one (the default) surfaces and engages the boat in view by itself
    const g = duel('usa', 4);
    for (let i = 0; i < 300; i++) g.w.step();
    expect(g.sub.subPhase ?? 0).toBeGreaterThan(0);
  });
});

describe('submarines: land strike', () => {
  /** An enemy building on land at distance d (±0.8) from the sea point, found by scanning the coast. */
  function landAt(w: World, d: number): [number, number] | null {
    for (let a = 0; a < 6.28; a += 0.05) {
      const x = Math.floor(SEA[0] + Math.cos(a) * d);
      const y = Math.floor(SEA[1] + Math.sin(a) * d);
      if (x < 2 || y < 2 || x > w.map.w - 6 || y > w.map.h - 6) continue;
      let ok = true;
      for (let oy = 0; oy < 3 && ok; oy++) for (let ox = 0; ox < 3; ox++) if (!w.passes[Loco.Foot][(y + oy) * w.map.w + x + ox]) ok = false;
      if (ok) return [x, y];
    }
    return null;
  }
  function strike(a: Faction, d: number) {
    const w = mk(a, 'russia');
    clearUnits(w);
    for (const e of [...w.list]) if (e.owner === 1 && e.kind === 'building') w.remove(e);
    const at = landAt(w, d);
    expect(at, `a building site ${d} tiles from the sea point`).not.toBeNull();
    const b = w.spawnBuilding('russia_power', 1, at![0], at![1], true);
    // (the other side's eyes on it: a rifleman beside it, so the submarine's owner may target it)
    const sub = w.spawnUnit(`${a}_sub`, 0, SEA[0], SEA[1]);
    const spy = w.spawnUnit('usa_rifle', 0, at![0] - 1, at![1] - 1);
    void spy;
    w.step();
    let fired = 0;
    let fireDist = -1;
    w.issue(0, { type: 'attack', ids: [sub.id], target: b.id });
    // only the first 300 ticks: it comes up (100), fires; out of range it moves instead
    const dist0 = Math.hypot(sub.x - b.tx, sub.y - b.ty);
    for (let i = 0; i < 300; i++) {
      w.step();
      for (const ev of w.drainEvents()) {
        if (ev.t === 'fire' && ev.id === sub.id) {
          if (!fired) fireDist = w.distTo(sub, b);
          fired++;
        }
      }
    }
    return { fired, dist0, sub, b, fireDist };
  }
  it('a nuclear boat hits a target about 26 tiles inland-ish from the water, a conventional one does not reach that far', () => {
    const n = strike('usa', 24);
    expect(n.dist0).toBeGreaterThan(20);
    expect(n.fired, 'the nuclear boat fires at 24 tiles').toBeGreaterThanOrEqual(1);
    expect(n.fireDist, 'from where it lay: no closing in').toBeGreaterThan(20);
    const c = strike('israel', 24);
    // (it must first close in: a conventional boat fires only inside 14 tiles)
    // (it closes in at its speed and shoots from inside its 14 tiles, never before)
    expect(c.fireDist, 'the conventional boat fires only from inside its 14 tiles').toBeLessThanOrEqual(14.2);
  });
  it('a conventional boat fires inside its 14 tiles', () => {
    const c = strike('israel', 11);
    expect(c.fired).toBeGreaterThanOrEqual(1);
  });
});

describe('submarines: determinism', () => {
  it('the same match gives the same phases', () => {
    const run = () => {
      const { w, sub, boat } = duel('usa', 5);
      w.issue(0, { type: 'attack', ids: [sub.id], target: boat.id });
      const log: number[] = [];
      for (let i = 0; i < 500; i++) {
        w.step();
        log.push((sub.subPhase ?? 0) * 10 + (sub.dive ? 1 : 0) + Math.round(boat.hp));
      }
      return log.join(',');
    };
    expect(run()).toBe(run());
    void TPS;
  });
});
