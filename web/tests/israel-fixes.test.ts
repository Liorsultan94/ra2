import { describe, expect, it } from 'vitest';
import { APS_PK, APS_RELOAD, launch } from '../src/sim/ballistics';
import { WEAPONS, unitDef } from '../src/sim/defs';
import { TPS, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Israel (player 0) vs Iran (player 1), starting forces cleared, a construction yard and power each. */
function arena(seed = 5) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: 'israel', color: 0, isAI: false },
      { name: 'B', faction: 'iran', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('israel_conyard', 0, 4, 88, true);
  w.spawnBuilding('iran_conyard', 1, 88, 4, true);
  for (let i = 0; i < 3; i++) w.spawnBuilding('israel_power', 0, 30 + i * 3, 52, true);
  return w;
}

function run(w: World, ticks: number, onEv?: (e: SimEvent) => void) {
  for (let i = 0; i < ticks; i++) {
    w.step();
    for (const e of w.drainEvents()) onEv?.(e);
  }
}

describe('Iron Dome', () => {
  it('fires up to 6 interceptors a second into a salvo, each at its own threat', () => {
    const w = arena();
    const dome = w.spawnBuilding('israel_def_aa', 0, 40, 46, true);
    expect(WEAPONS[unitDef('israel_def_aa').weapon!]?.id ?? '').toBe('ironDome');
    run(w, 5);
    const src = w.spawnUnit('iran_rifle', 1, 40, 30);
    src.stance = 'holdFire';
    // a 24-rocket salvo arriving over a few seconds at buildings next to the battery
    const tgt = w.spawnBuilding('israel_power', 0, 44, 46, true);
    for (let i = 0; i < 24; i++) launch(w, src, tgt, WEAPONS.tos, 44.5 + (i % 4) * 0.3, 46.5 + Math.floor(i / 4) * 0.2);
    const launches: number[] = [];
    run(w, TPS * 6, (e) => {
      if (e.t === 'fire' && e.id === dome.id) launches.push(w.tick);
    });
    expect(launches.length).toBeGreaterThan(8);
    // never more than 6 launches (each one or a shoot-shoot pair counts once) in any one-second window
    for (const t0 of launches) expect(launches.filter((t) => t >= t0 && t < t0 + TPS).length).toBeLessThanOrEqual(6);
    // and it does reach the full cadence while the salvo lasts
    expect(Math.max(...launches.map((t0) => launches.filter((t) => t >= t0 && t < t0 + TPS).length))).toBe(6);
  });
});

describe('Trophy active protection (every Israeli vehicle)', () => {
  /** Fires `n` RPGs at the tank one at a time, `gap` ticks apart; returns how many the APS destroyed in flight. */
  function volley(n: number, gap: number, seed = 9) {
    const w = arena(seed);
    const tank = w.spawnUnit('israel_mbt', 0, 50, 50);
    tank.stance = 'holdFire';
    const rpg = w.spawnUnit('iran_at', 1, 50, 45);
    rpg.stance = 'holdFire';
    let kills = 0;
    let hp = tank.hp;
    let hits = 0;
    for (let i = 0; i < n; i++) {
      launch(w, rpg, tank, WEAPONS.atRocket, tank.x, tank.y);
      run(w, gap, (e) => {
        if (e.t === 'intercept' && e.id === tank.id) {
          kills++;
          // destroyed short of the hull, at the stand-off distance
          expect(Math.hypot(e.x - tank.x, e.y - tank.y)).toBeGreaterThan(0.5);
        }
      });
      if (tank.hp < hp) hits++;
      hp = tank.hp = unitDef('israel_mbt').hp;
    }
    return { kills, hits };
  }

  it('every Israeli combat vehicle carries it; other factions do not', () => {
    for (const id of ['israel_mbt', 'israel_ifv', 'israel_apc']) if (unitDef(id)) expect(unitDef(id).aps).toBe(1);
    expect(unitDef('iran_mbt').aps ?? 0).toBe(0);
  });

  it('defeats about 90% of RPGs, destroying them before they reach the hull', () => {
    const r = volley(60, APS_RELOAD + 30);
    expect(r.kills / 60).toBeGreaterThan(APS_PK.atgm! - 0.12);
    expect(r.kills + r.hits).toBe(60);
  });

  it('needs to reload between intercepts, so a tight salvo can saturate it', () => {
    const r = volley(40, 2);
    expect(r.hits).toBeGreaterThan(20);
  });
});

describe('soldiers fire on the move', () => {
  it('a soldier on a plain move order shoots at enemies in range without stopping, and arrives', () => {
    const w = arena(4);
    const s = w.spawnUnit('israel_rifle', 0, 40, 40);
    const foe = w.spawnUnit('iran_rifle', 1, 44, 44);
    foe.stance = 'holdFire';
    foe.hp = foe.maxHp = 100000;
    w.issue(0, { type: 'move', ids: [s.id], x: 48, y: 40 });
    let shots = 0;
    let movedWhileFiring = 0;
    let last = { x: s.x, y: s.y };
    for (let i = 0; i < TPS * 20 && (i < 3 || s.order.type !== 'idle'); i++) {
      w.step();
      for (const e of w.drainEvents()) if (e.t === 'fire' && e.id === s.id) shots++;
      if (s.moveFireAt === w.tick && Math.hypot(s.x - last.x, s.y - last.y) > 0.01) movedWhileFiring++;
      last = { x: s.x, y: s.y };
    }
    expect(shots).toBeGreaterThan(1);
    expect(movedWhileFiring).toBeGreaterThan(5);
    expect(s.order.type).toBe('idle');
    expect(Math.hypot(s.x - 48.5, s.y - 40.5)).toBeLessThan(1.5);
  });

  it('hold fire and snipers do not shoot on the move', () => {
    const w = arena(4);
    const a = w.spawnUnit('israel_rifle', 0, 40, 40);
    a.stance = 'holdFire';
    const sn = w.spawnUnit('israel_sniper', 0, 40, 41);
    const foe = w.spawnUnit('iran_rifle', 1, 44, 44);
    foe.stance = 'holdFire';
    foe.hp = foe.maxHp = 100000;
    w.issue(0, { type: 'move', ids: [a.id, sn.id], x: 48, y: 40 });
    let shots = 0;
    run(w, TPS * 8, (e) => {
      if (e.t === 'fire' && (e.id === a.id || e.id === sn.id)) shots++;
    });
    expect(shots).toBe(0);
  });
});
