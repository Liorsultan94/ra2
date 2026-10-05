// Garrisonable civilian houses (Red Alert 2 style).
//
// The village houses / cottages / barns of the map are neutral building
// entities (owner -1) standing on their `blocked` footprint (pathing is
// unchanged: the tiles stay blocked even after the house is destroyed - the
// rubble). Infantry ordered into a house ride inside it like APC passengers
// (Entity.inside / passengers) and fire from the windows with a range and
// firepower bonus; enemies can't hit them, only the house. While occupied the
// house belongs to the garrisoning player; empty it reverts to neutral.
// When it is destroyed the survivors are thrown out, wounded. Thermobaric
// weapons (and flamethrowers) are deadly to garrisons: they also burn the
// occupants inside. Engineers can't enter; enemies can't enter a held house.

import { DEFS, buildingDef, unitDef } from './defs';
import { StructureKind } from './map';
import type { Entity, Warhead, WeaponDef } from './types';
import type { World } from './world';

/** Weapon range bonus (tiles) for infantry firing from a building. */
export const GARRISON_RANGE = 1.5;
/** Lock-on weapons (snipers, sniper.ts) gain this share of their range instead, when it is more. */
export const GARRISON_SNIPER_RANGE = 0.2;
/** Firepower multiplier for garrisoned infantry. */
export const GARRISON_FIREPOWER = 1.25;
/** Thermobaric / flame hits on a held house: extra damage to the structure and the share that burns the occupants. */
export const GARRISON_THERMO_HOUSE = 1.5;
export const GARRISON_THERMO_BURN = 0.45;
/** Survivors of a destroyed house lose this share of their current health. */
export const GARRISON_EJECT_HURT = 0.5;

const DEF_BY_KIND: Partial<Record<StructureKind, string>> = {
  [StructureKind.House]: 'civ_house',
  [StructureKind.Cottage]: 'civ_cottage',
  [StructureKind.Barn]: 'civ_barn',
  [StructureKind.MudHouse]: 'civ_mudhouse',
  [StructureKind.Courtyard]: 'civ_courtyard',
  [StructureKind.Apartment]: 'civ_apartment',
  [StructureKind.Block]: 'civ_block',
  [StructureKind.Office]: 'civ_office',
  [StructureKind.Shop]: 'civ_shop',
  [StructureKind.Townhouse]: 'civ_townhouse',
};

/** Turn the map's village houses into neutral garrisonable building entities. */
export function spawnGarrisons(w: World) {
  for (const st of w.map.structures) {
    const id = DEF_BY_KIND[st.kind];
    if (!id) continue;
    const d = buildingDef(id);
    if (d.w !== st.w || d.h !== st.h) continue;
    w.spawnBuilding(id, -1, st.x, st.y, true);
  }
}

export function isGarrison(e: Entity | undefined): boolean {
  return !!e && e.kind === 'building' && !!buildingDef(e.def).garrison;
}

/**
 * Range bonus for infantry inside house h: measured from the house centre, so half its size plus the bonus
 * (a sniper's window shot reaches +20% further: GARRISON_SNIPER_RANGE).
 */
export function garrisonRangeBonus(h: Entity, wpn?: WeaponDef): number {
  const d = buildingDef(h.def);
  const bonus = wpn?.aim ? Math.max(GARRISON_RANGE, wpn.range * GARRISON_SNIPER_RANGE) : GARRISON_RANGE;
  return bonus + Math.max(d.w, d.h) / 2;
}

/** The civilian building a unit is garrisoning, if any. */
export function garrisonOf(w: World, e: Entity): Entity | undefined {
  if (e.inside < 0) return undefined;
  const h = w.get(e.inside);
  return isGarrison(h) ? h : undefined;
}

/** Can this unit type garrison a building? (armed infantry; not engineers) */
export function canGarrisonUnit(defId: string): boolean {
  const d = DEFS[defId];
  if (!d || d.kind !== 'unit') return false;
  const u = unitDef(defId);
  return u.category === 'infantry' && !u.engineer && !!u.weapon && !u.temp;
}

/** Free places in house `t` for player `pid` (0 when it can't be entered by them). */
export function garrisonRoom(_w: World, t: Entity, pid: number): number {
  if (!isGarrison(t) || t.dead) return 0;
  if (t.owner >= 0 && t.owner !== pid) return 0;
  return Math.max(0, (buildingDef(t.def).garrison ?? 0) - t.passengers.length);
}

/** A unit has reached the house it was ordered into. */
export function enterGarrison(w: World, e: Entity, house: Entity): boolean {
  if (garrisonRoom(w, house, e.owner) <= 0 || !canGarrisonUnit(e.def)) return false;
  if (house.owner !== e.owner) {
    house.owner = e.owner;
    house.targetId = -1;
    house.repairing = false;
  }
  w.board(e, house);
  e.scanAt = w.tick + 1;
  w.events.push({ t: 'garrison', id: house.id, owner: e.owner, enter: true });
  return true;
}

/**
 * Throw everyone out of a house (evacuate, or it was destroyed). Survivors of a destroyed house are hurt;
 * returns the occupants that did not make it (the caller kills them).
 */
export function ejectAll(w: World, house: Entity, destroyed: boolean): Entity[] {
  const d = buildingDef(house.def);
  const dead: Entity[] = [];
  const ids = house.passengers;
  house.passengers = [];
  ids.forEach((id, k) => {
    const p = w.get(id);
    if (!p || p.inside !== house.id) return;
    p.inside = -1;
    // around the footprint, spreading the survivors over the door side first
    const side = k % 4;
    const ox = side === 0 ? d.w / 2 : side === 1 ? d.w + 0.6 : side === 2 ? d.w / 2 : -0.6;
    const oy = side === 0 ? d.h + 0.6 : side === 1 ? d.h / 2 : side === 2 ? -0.6 : d.h / 2;
    const spot = w.nearestPassable(house.tx + ox, house.ty + oy, 5);
    const [x, y] = spot ? [spot[0] + 0.5, spot[1] + 0.5] : [house.tx + ox, house.ty + oy];
    p.x = p.px = x + w.rng.range(-0.2, 0.2);
    p.y = p.py = y + w.rng.range(-0.2, 0.2);
    p.order = { type: 'idle' };
    p.path = null;
    p.targetId = -1;
    p.guardX = p.x;
    p.guardY = p.y;
    if (destroyed) {
      p.hp -= p.hp * GARRISON_EJECT_HURT;
      if (p.hp < 8) dead.push(p);
    }
  });
  if (!destroyed && house.owner >= 0) w.events.push({ t: 'garrison', id: house.id, owner: house.owner, enter: false });
  house.owner = -1;
  house.targetId = -1;
  return dead;
}

/**
 * A garrisoned house takes damage: thermobaric warheads (thermobaric rockets, flamethrowers) are extra
 * effective and burn the occupants inside. Returns the damage the structure itself takes.
 */
export function garrisonHit(w: World, house: Entity, amount: number, warhead: Warhead, src: Entity): number {
  if (house.owner < 0 || !house.passengers.length || warhead !== 'thermo') return amount;
  const burn = amount * GARRISON_THERMO_BURN;
  for (const id of [...house.passengers]) {
    const p = w.get(id);
    if (p) w.damage(p, burn, warhead, src, true);
  }
  return amount * GARRISON_THERMO_HOUSE;
}

/** Per-tick upkeep: drop dead occupants, revert empty houses to neutral. */
export function updateGarrisons(w: World) {
  if (w.tick % 5 !== 0) return;
  for (const h of w.list) {
    if (h.dead || h.kind !== 'building' || h.owner < 0 || !buildingDef(h.def).garrison) continue;
    h.passengers = h.passengers.filter((id) => {
      const p = w.get(id);
      return !!p && p.inside === h.id;
    });
    if (!h.passengers.length) {
      h.owner = -1;
      h.targetId = -1;
      h.repairing = false;
    }
  }
}
