// AI opening strategies (game plans). At match start each computer player picks one plan, seeded from the
// match seed and weighted by its nation's doctrine; the plan reshapes build order, unit mix, expansion and
// wave timing - only within the nation's own arsenal (a plan the arsenal cannot support is never picked).
// The AI may switch plan mid-game when its waves keep trading badly (ai.ts). Pure data + selection.

import type { Difficulty } from './ai';
import { WEAPONS, defsForFaction, unitDef } from './defs';
import type { Doctrine } from './doctrine';
import type { Rng } from './rng';
import type { Faction } from './types';

export type Plan = 'balanced' | 'rush' | 'boom' | 'harass' | 'air' | 'siege';
export const PLANS: Plan[] = ['balanced', 'rush', 'boom', 'harass', 'air', 'siege'];

export interface PlanCfg {
  /** Wave size multiplier, multiplier on the delay before an under-strength wave goes anyway. */
  wave: number;
  stale: number;
  /** Production-line spending multipliers. */
  spend: { infantry: number; vehicle: number; air: number };
  /** Unit-mix multipliers: fast units (speed >= 2.3, drones), artillery / strike launchers, aircraft, heavy armour. */
  fast: number;
  arty: number;
  air: number;
  heavy: number;
  /** Defensive structures multiplier, raid cadence multiplier (> 1 = more often), harvesters per refinery bonus. */
  defense: number;
  raids: number;
  harvesters: number;
  /** Engineers go for oil this early (s). */
  oilAt: number;
}

export const PLAN_CFG: Record<Plan, PlanCfg> = {
  balanced: { wave: 1, stale: 1, spend: { infantry: 1, vehicle: 1, air: 1 }, fast: 1, arty: 1, air: 1, heavy: 1, defense: 1, raids: 1, harvesters: 0, oilAt: 60 },
  // light, fast and early: smaller waves that go sooner, little artillery, a late second refinery
  rush: { wave: 0.75, stale: 0.65, spend: { infantry: 1.4, vehicle: 1.15, air: 0.8 }, fast: 1.7, arty: 0.5, air: 0.8, heavy: 0.8, defense: 0.6, raids: 1.2, harvesters: 0, oilAt: 90 },
  // economy and defences first, then a big late hammer
  boom: { wave: 1.35, stale: 1.4, spend: { infantry: 0.8, vehicle: 1.1, air: 1 }, fast: 0.8, arty: 1.1, air: 1, heavy: 1.4, defense: 1.4, raids: 0.6, harvesters: 1, oilAt: 40 },
  // fast raiders (and drones) hit harvesters and outposts often
  harass: { wave: 0.9, stale: 1, spend: { infantry: 0.9, vehicle: 1.2, air: 1.2 }, fast: 2, arty: 0.8, air: 1.3, heavy: 0.8, defense: 1, raids: 2, harvesters: 0, oilAt: 60 },
  // the air arm leads
  air: { wave: 1, stale: 1, spend: { infantry: 0.8, vehicle: 0.9, air: 1.6 }, fast: 1, arty: 0.9, air: 2.2, heavy: 1, defense: 1, raids: 1, harvesters: 0, oilAt: 60 },
  // guns and missiles grind the defences down ahead of a heavy push
  siege: { wave: 1.15, stale: 1.2, spend: { infantry: 0.9, vehicle: 1.2, air: 0.9 }, fast: 0.8, arty: 2.2, air: 0.9, heavy: 1.2, defense: 1.2, raids: 0.7, harvesters: 0, oilAt: 60 },
};

function isStrikeDef(def: string) {
  const w = unitDef(def)?.weapon;
  const f = w ? WEAPONS[w]?.flight : undefined;
  return f === 'ballistic' || f === 'hypersonic' || f === 'cruise';
}

/** Is a unit fast (raider) by the plan's measure: speed >= 2.3, a drone launcher or a non-jet aircraft? */
export function isFast(def: string): boolean {
  const d = unitDef(def);
  if (!d.weapon) return false;
  return d.speed >= 2.3 || WEAPONS[d.weapon].projectile === 'spawn' || (!!d.air && !d.fixedWing);
}

/** What a nation's AI-buildable arsenal supports: counts of fast, artillery / strike and air units with a weapon. */
export function arsenal(f: Faction) {
  let fast = 0;
  let arty = 0;
  let air = 0;
  for (const d of defsForFaction(f)) {
    if (d.kind !== 'unit' || !d.aiWeight || !d.weapon) continue;
    if (d.aiTag === 'arty' || isStrikeDef(d.id)) arty++;
    if (d.category === 'air') air++;
    if (isFast(d.id) && d.category !== 'air') fast++;
  }
  return { fast, arty, air };
}

/** Selection weights of each plan for a nation (0 = the arsenal cannot support it, never picked). */
export function planWeights(f: Faction, doc: Doctrine, difficulty: Difficulty): Record<Plan, number> {
  const a = arsenal(f);
  return {
    balanced: 1.2,
    rush: (difficulty === 'easy' ? 0.5 : 0.8) + (doc.wave < 1.1 ? 0.2 : 0),
    boom: 0.5 + doc.defense * 0.4 + (doc.wave > 1.1 ? 0.2 : 0),
    harass: a.fast >= 1 && doc.harass > 0 ? 0.3 + doc.harass * 0.5 : 0,
    air: a.air >= 1 ? 0.2 + Math.min(1, doc.airWing * 0.2) + Math.max(0, doc.spend.air - 1) * 1.5 : 0,
    siege: a.arty >= 1 ? 0.4 + (doc.counterBattery ? 0.3 : 0) + (doc.salvo - 1) * 0.3 + Math.max(0, (doc.bias.df ?? 1) - 1) * 0.2 : 0,
  };
}

/** Seeded weighted pick of a plan (optionally excluding one, for a mid-game switch). */
export function pickPlan(rng: Rng, weights: Record<Plan, number>, not?: Plan): Plan {
  const opts = PLANS.filter((p) => p !== not && weights[p] > 0);
  const total = opts.reduce((s, p) => s + weights[p], 0);
  let r = rng.next() * total;
  for (const p of opts) {
    r -= weights[p];
    if (r <= 0) return p;
  }
  return opts[opts.length - 1] ?? 'balanced';
}

/** The plan's build order: the economy core first; the plan moves expansion / tech / airfield earlier or later. */
export function planBuildOrder(base: [string, number][], plan: Plan): [string, number][] {
  const o = base.map((s) => [...s] as [string, number]);
  const move = (role: string, n: number, after: string, an: number) => {
    const i = o.findIndex(([r, k]) => r === role && k === n);
    if (i < 0) return;
    const [it] = o.splice(i, 1);
    const j = o.findIndex(([r, k]) => r === after && k === an);
    o.splice(j < 0 ? o.length : j + 1, 0, it);
  };
  if (plan === 'rush') {
    move('factory', 2, 'factory', 1); // a second war factory straight away
    move('refinery', 2, 'radar', 1); // expand later
  } else if (plan === 'boom') {
    // the third refinery once the radar is up (BAL1: straight after the second one, boom won ~70% of AI-vs-AI games)
    const at = o.findIndex(([r, k]) => r === 'radar' && k === 1);
    o.splice(at < 0 ? o.findIndex(([r, k]) => r === 'refinery' && k === 2) + 1 : at + 1, 0, ['power', 2], ['refinery', 3]);
  } else if (plan === 'air') move('airfield', 1, 'radar', 1);
  else if (plan === 'siege') move('tech', 1, 'radar', 1);
  // a repeated [role, n] is harmless: nextBuilding skips what is already built
  return o;
}
