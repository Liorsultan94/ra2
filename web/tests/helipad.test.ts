import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { REPAIR_RATE, baseGeo, parkJet } from '../src/sim/airbase';
import { WEAPONS, buildingDef } from '../src/sim/defs';
import { HELI_ORDER_GRACE, HELI_RETURN_HP, heliGrounded, heliRepairing, heliStatus, helipadSpots } from '../src/sim/helipad';
import { TPS, type Entity, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

/** USA (player 0) vs Russia, starting forces cleared; an airbase for player 0 at (10, 60). */
function heliWorld(base = true, ai = false) {
  const w = new World({
    seed: 5,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: ai },
      { name: 'B', faction: 'russia', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  const af = base ? w.spawnBuilding('usa_airfield', 0, 10, 60, true) : (null as unknown as Entity);
  return { w, af };
}

function heliAt(w: World, x: number, y: number, owner = 0, def = 'usa_heli') {
  const h = w.spawnUnit(def, owner, x, y);
  h.z = h.pz = 1.15;
  return h;
}

function runUntil(w: World, cond: () => boolean, ticks: number): SimEvent[] {
  const evs: SimEvent[] = [];
  for (let i = 0; i < ticks && !cond(); i++) {
    w.step();
    evs.push(...w.drainEvents());
  }
  return evs;
}

describe('attack helicopter repair at the airbase', () => {
  it('breaks off below 40% HP, lands beside the airbase, repairs at 4%/s and resumes its attack', () => {
    const { w, af } = heliWorld();
    const tank = w.spawnUnit('russia_mbt', 1, 40, 40);
    tank.hp = tank.maxHp * 50; // a tough target so the attack order outlives the trip
    tank.maxHp = tank.hp;
    const h = heliAt(w, 30, 40);
    w.issue(0, { type: 'attack', ids: [h.id], target: tank.id });
    w.step();
    expect(h.order).toMatchObject({ type: 'attack', target: tank.id });
    // badly hit, but the player's order is fresh: it stays in the fight for a few seconds
    h.hp = h.maxHp * (HELI_RETURN_HP - 0.05);
    runUntil(w, () => false, 20);
    expect(h.heli).toBeNull();
    // the order is old now: it flies home
    const evs = runUntil(w, () => !!h.heli, HELI_ORDER_GRACE + 20);
    expect(h.heli).not.toBeNull();
    expect(evs.some((e) => e.t === 'heliPad' && e.what === 'return')).toBe(true);
    expect(heliStatus(h)).toBe('Returning for repair');
    expect(h.heli!.base).toBe(af.id);
    // lands on its spot
    runUntil(w, () => h.heli?.phase === 'landed', TPS * 40);
    expect(h.heli!.phase).toBe('landed');
    expect(h.z).toBe(0);
    expect(heliGrounded(h)).toBe(true);
    expect(heliRepairing(h)).toBe(true);
    expect(heliStatus(h)).toMatch(/^Repairing \d+%$/);
    const hp0 = h.hp;
    w.step();
    expect(h.hp).toBeCloseTo(hp0 + (h.maxHp * REPAIR_RATE) / TPS, 5);
    // ~15 s to full, then lifts off and goes back to its attack
    const t0 = w.tick;
    runUntil(w, () => !h.heli, TPS * 30);
    expect(h.heli).toBeNull();
    expect(h.hp).toBe(h.maxHp);
    expect((w.tick - t0) / TPS).toBeGreaterThan(13);
    expect((w.tick - t0) / TPS).toBeLessThan(18);
    expect(h.order).toMatchObject({ type: 'attack', target: tank.id });
  });

  it('lands clear of the runway, the taxiway and the jet stands, never on the slab', () => {
    const { w, af } = heliWorld();
    const g = baseGeo(w, af);
    const bd = buildingDef(af.def);
    const spots = helipadSpots(w, af).filter((s): s is [number, number] => !!s);
    expect(spots.length).toBeGreaterThan(0);
    for (const [x, y] of spots) {
      // outside the airbase footprint
      const inside = x >= af.tx && x <= af.tx + bd.w && y >= af.ty && y <= af.ty + bd.h;
      expect(inside).toBe(false);
      // well clear of the runway centreline and its extension (approach / climb-out)
      expect(Math.abs(y - g.rwyY)).toBeGreaterThan(1);
      // no stand: at least a tile from each pad centre
      for (const px of g.pads) expect(Math.hypot(x - px, y - g.padY)).toBeGreaterThan(1.4);
    }
    // four helicopters at once each get their own spot
    const hs = [0, 1, 2, 3].map((i) => heliAt(w, 30 + i, 50));
    for (const h of hs) h.hp = h.maxHp * 0.3;
    for (const h of hs) w.issue(0, { type: 'land', ids: [h.id], target: af.id });
    runUntil(w, () => hs.every((h) => h.heli?.phase === 'landed'), TPS * 40);
    const pts = hs.map((h) => `${h.x.toFixed(2)},${h.y.toFixed(2)}`);
    expect(new Set(pts).size).toBe(4);
    for (const h of hs) expect(h.heli!.phase).toBe('landed');
  });

  it('a manual order lands a lightly damaged helicopter for repair, then it hovers back to where it was', () => {
    const { w, af } = heliWorld();
    const h = heliAt(w, 30, 30);
    h.hp = h.maxHp * 0.9;
    w.issue(0, { type: 'land', ids: [h.id], target: af.id });
    runUntil(w, () => h.heli?.phase === 'landed', TPS * 40);
    expect(h.heli?.phase).toBe('landed');
    expect(h.heli!.manual).toBe(true);
    runUntil(w, () => !h.heli, TPS * 10);
    expect(h.hp).toBe(h.maxHp);
    expect(h.order).toMatchObject({ type: 'move' });
    runUntil(w, () => h.order.type === 'idle', TPS * 30);
    expect(Math.hypot(h.x - 30, h.y - 30)).toBeLessThan(1.5);
  });

  it('a new order cancels the trip', () => {
    const { w, af } = heliWorld();
    const h = heliAt(w, 30, 30);
    w.issue(0, { type: 'land', ids: [h.id], target: af.id });
    runUntil(w, () => false, 10);
    expect(h.heli).not.toBeNull();
    w.issue(0, { type: 'move', ids: [h.id], x: 50, y: 30 });
    runUntil(w, () => false, 2);
    expect(h.heli).toBeNull();
    expect(h.order.type).toBe('move');
  });

  it('on the ground it is a ground target: rifles can hit it, AA cannot', () => {
    const { w, af } = heliWorld();
    const h = heliAt(w, 30, 30);
    w.issue(0, { type: 'land', ids: [h.id], target: af.id });
    // airborne: rifles can't touch it
    expect(w.canHit(WEAPONS.rifle, h)).toBe(false);
    expect(w.canHit(WEAPONS.flak, h)).toBe(true);
    runUntil(w, () => h.heli?.phase === 'landed', TPS * 40);
    expect(w.isAir(h)).toBe(false);
    expect(w.canHit(WEAPONS.rifle, h)).toBe(true);
    expect(w.canHit(WEAPONS.flak, h)).toBe(false);
    // an enemy rifleman next to it opens fire on his own and hurts it
    const r = w.spawnUnit('russia_rifle', 1, h.x + 2, h.y);
    const hp0 = h.hp;
    runUntil(w, () => false, TPS * 3);
    expect(r.targetId).toBe(h.id);
    expect(h.hp).toBeLessThan(hp0 + (h.maxHp * REPAIR_RATE * 3) - 1);
  });

  it('with no airbase it fights on', () => {
    const { w } = heliWorld(false);
    const tank = w.spawnUnit('russia_mbt', 1, 40, 40);
    tank.hp = tank.maxHp = 50000;
    const h = heliAt(w, 34, 40);
    h.hp = h.maxHp * 0.2;
    w.issue(0, { type: 'attack', ids: [h.id], target: tank.id });
    runUntil(w, () => false, HELI_ORDER_GRACE + TPS * 3);
    expect(h.heli).toBeNull();
    expect(h.order).toMatchObject({ type: 'attack', target: tank.id });
    expect(w.isAir(h)).toBe(true);
  });

  it('jets on the same airbase are unaffected by a helicopter on its spot', () => {
    const { w, af } = heliWorld();
    const j = w.spawnUnit('usa_fighter', 0, af.x, af.y);
    expect(parkJet(w, j, af)).toBe(true);
    const h = heliAt(w, 30, 30);
    w.issue(0, { type: 'land', ids: [h.id], target: af.id });
    runUntil(w, () => h.heli?.phase === 'landed', TPS * 40);
    const tgt = w.spawnBuilding('russia_factory', 1, 40, 20, true);
    w.issue(0, { type: 'attack', ids: [j.id], target: tgt.id });
    const evs = runUntil(w, () => j.sortie!.phase === 'sortie', TPS * 60);
    expect(evs.some((e) => e.t === 'sortie' && e.what === 'takeoff')).toBe(true);
    expect(j.sortie!.phase).toBe('sortie');
  });

  it('AI helicopters follow the same rule', () => {
    const { w, af } = heliWorld(true, true);
    w.controllers.push(new AIController(w, 0, 'normal'));
    const h = heliAt(w, 40, 40);
    h.hp = h.maxHp * 0.3;
    runUntil(w, () => h.heli?.phase === 'landed', TPS * 40);
    expect(h.heli?.phase).toBe('landed');
    expect(h.heli!.base).toBe(af.id);
    runUntil(w, () => !h.heli, TPS * 30);
    expect(h.hp).toBe(h.maxHp);
  });
});
