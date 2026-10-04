import { describe, expect, it } from 'vitest';
import { DEF_LIST, FACTIONS, VERSUS, WEAPONS, buildingDef, defsForFaction, unitDef } from '../src/sim/defs';
import { GARRISON_RANGE, garrisonRangeBonus } from '../src/sim/garrison';
import { SNIPER_AIM, aimStatus } from '../src/sim/sniper';
import { TPS, type Entity, type Faction, type SimEvent, type UnitDef } from '../src/sim/types';
import { World } from '../src/sim/world';

/** Two players, starting forces cleared, a conyard + power each so nobody is defeated. */
function cleanWorld(a: Faction = 'usa', b: Faction = 'russia', seed = 21) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: a, color: 0, isAI: false },
      { name: 'B', faction: b, color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding(`${a}_conyard`, 0, 4, 88, true);
  w.spawnBuilding(`${b}_conyard`, 1, 88, 4, true);
  for (let i = 0; i < 3; i++) {
    w.spawnBuilding(`${a}_power`, 0, 8 + i * 3, 88, true);
    w.spawnBuilding(`${b}_power`, 1, 80 - i * 3, 4, true);
  }
  return w;
}

type Ev = SimEvent & { tick: number };
const run = (w: World, ticks: number, log?: Ev[]) => {
  for (let i = 0; i < ticks; i++) {
    w.step();
    const ev = w.drainEvents();
    if (log) for (const e of ev) log.push({ ...e, tick: w.tick });
  }
};

/** An open, passable strip of `len` tiles along x (so nobody is shoved around by terrain). */
function openRow(w: World, len = 16): [number, number] {
  const { w: W, h: H } = w.map;
  for (let y = 30; y < H - 30; y++)
    for (let x = 20; x < W - len - 20; x++) {
      let ok = true;
      for (let k = -2; k <= len && ok; k++) for (let dy = -2; dy <= 2 && ok; dy++) if (!w.pass[(y + dy) * W + x + k] || w.occ[(y + dy) * W + x + k]) ok = false;
      if (ok) return [x + 0.5, y + 0.5];
    }
  throw new Error('no open row');
}

/** A sniper of player 0 and `n` enemy soldiers standing still at `dist` tiles (hold fire: they just stand there). */
function duel(dist = 9, foeDef = 'russia_rifle', n = 1) {
  const w = cleanWorld();
  const [x, y] = openRow(w);
  const s = w.spawnUnit('usa_sniper', 0, x, y);
  const foes: Entity[] = [];
  for (let i = 0; i < n; i++) {
    const f = w.spawnUnit(foeDef, 1, x + dist, y - 1 + i);
    f.stance = 'holdFire';
    foes.push(f);
  }
  w.updateVisibility();
  return { w, s, foes, x, y };
}

type FireEv = Extract<SimEvent, { t: 'fire' }> & { tick: number };
const fires = (log: Ev[], id: number) => log.filter((e): e is FireEv => e.t === 'fire' && e.id === id);
const aims = (log: Ev[], id: number, phase: 'start' | 'lock') => log.filter((e) => e.t === 'aim' && e.id === id && e.phase === phase);

describe('sniper: roster and stats', () => {
  it('every nation trains one at the barracks (needs radar), priced as a specialist, and the AI builds it', () => {
    for (const f of FACTIONS) {
      const d = defsForFaction(f.id).find((x) => x.id === `${f.id}_sniper`) as UnitDef | undefined;
      expect(d, f.id).toBeTruthy();
      expect(d!.category).toBe('infantry');
      expect(d!.prereq).toEqual(['barracks', 'radar']);
      expect(d!.cost).toBeGreaterThanOrEqual(480); // Ukraine's -20% infantry discount
      expect(d!.cost).toBeLessThanOrEqual(600);
      expect(d!.aiWeight).toBeGreaterThan(0);
      expect(d!.model).toBe('sniper');
      expect(d!.name).not.toBe('Sniper'); // a national name
      const wpn = WEAPONS[d!.weapon!];
      expect(wpn.aim).toBe(SNIPER_AIM);
      expect(wpn.air).toBe('no');
      expect(d!.sight).toBeGreaterThanOrEqual(11);
    }
  });

  it('reaches 2.5x as far as a rifleman', () => {
    expect(WEAPONS.sniper.range).toBeCloseTo(WEAPONS.rifle.range * 2.5);
    expect(SNIPER_AIM).toBe(60);
  });
});

describe('sniper lock-on', () => {
  it('takes exactly 60 ticks to lock, then fires once and kills', () => {
    const { w, s, foes } = duel(9);
    const log: Ev[] = [];
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, SNIPER_AIM + 30, log);
    const start = aims(log, s.id, 'start');
    const shots = fires(log, s.id);
    expect(start.length).toBe(1);
    expect(shots.length).toBe(1);
    expect(shots[0].tick - start[0].tick).toBe(SNIPER_AIM);
    expect(aims(log, s.id, 'lock')[0].tick - start[0].tick).toBe(SNIPER_AIM - 8);
    expect(foes[0].dead).toBe(true);
    expect(s.aimTarget).toBe(-1);
    // the sniper never moved: target was in range from the start
    expect(log.some((e) => e.t === 'fire' && e.tick < start[0].tick + SNIPER_AIM)).toBe(false);
  });

  it('is part of the weapon state: aim progress is on the entity (HUD "Aiming 2.1s")', () => {
    const { w, s, foes } = duel(9);
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 1 + 18); // acquired on the first tick, 18 ticks of aim
    expect(s.aimTarget).toBe(foes[0].id);
    expect(s.aimTicks).toBe(18);
    const st = aimStatus(s)!;
    expect(st.left).toBeCloseTo(2.1);
    expect(st.k).toBeCloseTo(0.3);
  });

  it('a new target needs a fresh 3 s aim', () => {
    const { w, s, foes } = duel(9, 'russia_rifle', 2);
    const log: Ev[] = [];
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 40, log);
    expect(s.aimTicks).toBeGreaterThan(30);
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[1].id });
    run(w, 1, log);
    expect(s.aimTarget).toBe(foes[1].id);
    expect(s.aimTicks).toBe(0);
    run(w, SNIPER_AIM + 5, log);
    const shots = fires(log, s.id);
    expect(shots.length).toBe(1);
    expect(shots[0].targetId).toBe(foes[1].id);
    const st = aims(log, s.id, 'start').find((e) => e.t === 'aim' && e.target === foes[1].id)!;
    expect(shots[0].tick - st.tick).toBe(SNIPER_AIM);
    expect(foes[0].dead).toBe(false);
    expect(foes[1].dead).toBe(true);
  });

  it('re-issuing the same target keeps the lock', () => {
    const { w, s, foes } = duel(9);
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 31);
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 1);
    expect(s.aimTicks).toBe(31);
  });

  it('moving cancels the aim', () => {
    const { w, s, foes, x, y } = duel(9);
    const log: Ev[] = [];
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 40, log);
    expect(s.aimTicks).toBe(39);
    w.issue(0, { type: 'move', ids: [s.id], x: x - 4, y });
    run(w, 1, log);
    expect(s.aimTarget).toBe(-1);
    expect(s.aimTicks).toBe(0);
    run(w, 40, log);
    expect(fires(log, s.id).length).toBe(0);
    expect(foes[0].dead).toBe(false);
  });

  it('a stop order cancels the aim', () => {
    const { w, s, foes } = duel(9);
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 30);
    w.issue(0, { type: 'stop', ids: [s.id] });
    run(w, 1);
    expect(s.aimTicks).toBeLessThan(2); // the idle scan may pick the same soldier again: a fresh aim
  });

  it('the target leaving range cancels the aim (and it starts over when back in range)', () => {
    const { w, s, foes, x, y } = duel(9);
    const log: Ev[] = [];
    s.stance = 'hold'; // no chasing: just watch
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 45, log);
    expect(s.aimTicks).toBe(44);
    // the soldier steps out of range (12.5 tiles > 11.25), still in sight of a spotter
    w.spawnUnit('usa_engineer', 0, x + 9, y + 2);
    foes[0].x = foes[0].px = x + 12.5;
    run(w, 1, log);
    expect(s.aimTarget).toBe(-1);
    expect(s.aimTicks).toBe(0);
    run(w, 30, log);
    expect(fires(log, s.id).length).toBe(0);
  });

  it('the target hiding in a transport cancels the aim', () => {
    const { w, s, foes, x, y } = duel(9);
    const log: Ev[] = [];
    w.issue(0, { type: 'attack', ids: [s.id], target: foes[0].id });
    run(w, 30, log);
    const apc = w.spawnUnit('russia_apc', 1, x + 9.4, y);
    w.board(foes[0], apc);
    run(w, 2, log);
    expect(s.aimTarget).not.toBe(foes[0].id); // dropped (it may take a fresh aim on the IFV itself)
    run(w, SNIPER_AIM, log);
    // it never fires at the soldier inside the IFV
    expect(fires(log, s.id).filter((e) => e.t === 'fire' && e.targetId === foes[0].id).length).toBe(0);
    expect(foes[0].dead).toBe(false);
  });

  it('auto-targeting picks infantry first and ignores buildings', () => {
    const { w, s, foes, x, y } = duel(10, 'russia_rifle', 1);
    const ifv = w.spawnUnit('russia_apc', 1, x + 4, y + 1);
    ifv.stance = 'holdFire';
    w.spawnBuilding('russia_def_gun', 1, Math.floor(x) + 7, Math.floor(y) - 4, true); // out of its MG's reach, in the sniper's
    w.updateVisibility();
    const log: Ev[] = [];
    run(w, SNIPER_AIM + 10, log);
    const first = aims(log, s.id, 'start')[0];
    expect(first.t === 'aim' && first.target).toBe(foes[0].id);
    expect(foes[0].dead).toBe(true);
  });
});

describe('sniper damage', () => {
  it('one shot kills every infantry type of every nation, even elite', () => {
    const w = cleanWorld();
    const [x, y] = openRow(w);
    const s = w.spawnUnit('usa_sniper', 0, x, y);
    const inf = DEF_LIST.filter((d): d is UnitDef => d.kind === 'unit' && d.category === 'infantry');
    expect(inf.length).toBeGreaterThanOrEqual(9 * 4);
    for (const d of inf) {
      const t = w.spawnUnit(d.id, 1, x + 5, y);
      t.rank = 2; // elite armour
      w.damage(t, WEAPONS.sniper.damage, 'sniper', s);
      expect(t.dead, d.id).toBe(true);
    }
    // and through the full weapon cycle, for every nation's own sniper rifle
    for (const f of FACTIONS) {
      const ww = cleanWorld(f.id, f.id === 'russia' ? 'usa' : 'russia');
      const [xx, yy] = openRow(ww);
      const sn = ww.spawnUnit(`${f.id}_sniper`, 0, xx, yy);
      const foe = ww.spawnUnit(`${ww.players[1].faction}_at`, 1, xx + 10, yy);
      foe.stance = 'holdFire';
      foe.rank = 2;
      ww.updateVisibility();
      ww.issue(0, { type: 'attack', ids: [sn.id], target: foe.id });
      run(ww, SNIPER_AIM + 3);
      expect(foe.dead, f.id).toBe(true);
    }
  });

  it('only scratches vehicles: ~5-10% of a light vehicle, very little to tanks, minimal to buildings, never aircraft', () => {
    const w = cleanWorld();
    const [x, y] = openRow(w);
    const s = w.spawnUnit('usa_sniper', 0, x, y);
    const dmg = WEAPONS.sniper.damage;
    let lights = 0;
    for (const d of DEF_LIST) {
      if (d.kind !== 'unit' || d.category !== 'vehicle' || d.faction === 'neutral' || d.faction === 'israel') continue;
      const v = w.spawnUnit(d.id, 1, x + 6, y);
      w.damage(v, dmg, 'sniper', s);
      const lost = 1 - v.hp / v.maxHp;
      if (d.armor === 'light') {
        lights++;
        expect(lost, d.id).toBeGreaterThanOrEqual(0.045);
        expect(lost, d.id).toBeLessThanOrEqual(0.1);
      } else {
        expect(lost, d.id).toBeLessThan(0.015); // tanks, heavy carriers, the harvester
      }
      v.dead = true;
    }
    expect(lights).toBeGreaterThan(20);
    // buildings: a scratch
    const b = w.spawnBuilding('russia_barracks', 1, Math.floor(x) + 4, Math.floor(y) + 3, true);
    w.damage(b, dmg, 'sniper', s);
    expect(1 - b.hp / b.maxHp).toBeLessThan(0.005);
    expect(VERSUS.sniper.aircraft).toBe(0);
    // aircraft can't be targeted at all
    const heli = w.spawnUnit('russia_heli', 1, x + 6, y);
    heli.z = 1.2;
    expect(w.canHit(WEAPONS.sniper, heli)).toBe(false);
  });
});

describe('sniper in a building', () => {
  it('fires from the window with +20% range and the same 3 s lock', () => {
    const w = cleanWorld();
    const house = w.list.find((e) => e.kind === 'building' && e.def === 'civ_house' && e.tx === 25 && e.ty === 49)!;
    expect(house).toBeTruthy();
    const s = w.spawnUnit('usa_sniper', 0, 25.5, 52.5);
    w.issue(0, { type: 'enter', ids: [s.id], target: house.id });
    run(w, TPS * 6);
    expect(s.inside).toBe(house.id);
    const half = Math.max(buildingDef(house.def).w, buildingDef(house.def).h) / 2;
    const base = WEAPONS.sniper.range + 1; // + USA radar-network bonus (+1, only with a radar online)
    const r = w.weaponRange(s, WEAPONS.sniper) - (w.players[0].radarOnline ? 1 : 0);
    expect(r).toBeCloseTo(WEAPONS.sniper.range * 1.2 + half);
    expect(garrisonRangeBonus(house, WEAPONS.sniper)).toBeGreaterThan(GARRISON_RANGE + half);
    expect(base).toBeGreaterThan(0);
    // a rifleman in the same house only gets the flat window bonus
    expect(garrisonRangeBonus(house, WEAPONS.rifle)).toBeCloseTo(GARRISON_RANGE + half);
    // an enemy beyond the sniper's open-ground range but inside the window range, spotted by a friend
    const ang = 0.6;
    let foe: Entity | null = null;
    for (let d = 12.4; d <= 13.2 && !foe; d += 0.2)
      for (let a = 0; a < Math.PI * 2 && !foe; a += 0.2) {
        const fx = house.x + Math.cos(a + ang) * d;
        const fy = house.y + Math.sin(a + ang) * d;
        if (fx > 2 && fy > 2 && fx < w.map.w - 2 && fy < w.map.h - 2 && w.pass[w.tileOf(fx, fy)]) foe = w.spawnUnit('russia_rifle', 1, fx, fy);
      }
    expect(foe).toBeTruthy();
    foe!.stance = 'holdFire';
    const spot = w.spawnUnit('usa_engineer', 0, foe!.x + 1, foe!.y);
    spot.stance = 'holdFire';
    w.updateVisibility();
    expect(w.distTo(s, foe!)).toBeGreaterThan(WEAPONS.sniper.range + 1);
    const log: Ev[] = [];
    run(w, SNIPER_AIM + 20, log);
    const st = aims(log, s.id, 'start')[0];
    const shot = fires(log, s.id)[0];
    expect(st).toBeTruthy();
    expect(shot).toBeTruthy();
    expect(shot.tick - st.tick).toBe(SNIPER_AIM);
    expect(foe!.dead).toBe(true);
  });
});

describe('sniper determinism', () => {
  it('a sniper skirmish replays identically (aim state included)', () => {
    const play = () => {
      const w = cleanWorld('israel', 'iran', 5);
      const [x, y] = openRow(w);
      const mine = [0, 1, 2].map((i) => w.spawnUnit('israel_sniper', 0, x, y - 1 + i));
      const theirs = [0, 1, 2].map((i) => w.spawnUnit('iran_sniper', 1, x + 14, y - 1 + i));
      const rifles = [0, 1, 2, 3].map((i) => w.spawnUnit('iran_rifle', 1, x + 12, y - 2 + i));
      w.issue(0, { type: 'move', ids: mine.map((e) => e.id), x: x + 4, y, attackMove: true });
      w.issue(1, { type: 'move', ids: [...theirs, ...rifles].map((e) => e.id), x: x + 3, y, attackMove: true });
      const log: Ev[] = [];
      run(w, TPS * 40, log);
      const snap = w.list.filter((e) => !e.dead && e.kind === 'unit').map((e) => `${e.id}:${e.x.toFixed(4)},${e.y.toFixed(4)}:${e.hp.toFixed(2)}:${e.aimTarget}:${e.aimTicks}`).join('|');
      const shots = log.filter((e) => e.t === 'fire' && WEAPONS[e.weapon].aim).map((e) => `${e.tick}:${e.t === 'fire' ? e.id : 0}`).join(',');
      return { snap, shots, n: shots.length };
    };
    const a = play();
    const b = play();
    expect(a.n).toBeGreaterThan(3);
    expect(a.snap).toBe(b.snap);
    expect(a.shots).toBe(b.shots);
  }, 30000);

  it('AI vs AI with snipers on the roster stays deterministic', async () => {
    const { AIController } = await import('../src/sim/ai');
    const mk = () => {
      const w = new World({ seed: 17, players: [{ name: 'A', faction: 'israel', color: 0, isAI: true }, { name: 'B', faction: 'korea', color: 0, isAI: true }] });
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
      return w;
    };
    const a = mk();
    const b = mk();
    for (let i = 0; i < TPS * 60 * 6; i++) {
      a.step();
      b.step();
    }
    const snap = (w: World) => w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.def}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp}:${e.aimTarget}:${e.aimTicks}`).join('|');
    expect(snap(a)).toBe(snap(b));
    expect(unitDef('israel_sniper').aiWeight).toBeGreaterThan(0);
  }, 120000);
});

describe('sniper laser (render helpers)', () => {
  it('the dot sways like a hand: big figure-8 drift early, settling, dead steady for the final lock', async () => {
    const { swayOffset, laserIsGreen, SWAY_AMP } = await import('../src/render/fx/sniperfx');
    const steady = 1 - 8 / 60;
    const amp = (k: number) => {
      let m = 0;
      for (let t = 0; t < 3; t += 0.05) {
        const [x, y] = swayOffset(k, t, 0.37, steady);
        m = Math.max(m, Math.hypot(x, y));
      }
      return m;
    };
    expect(amp(0.05)).toBeGreaterThan(SWAY_AMP * 0.6);
    expect(amp(0.5)).toBeLessThan(amp(0.05));
    expect(amp(0.8)).toBeLessThan(amp(0.5));
    expect(amp(steady)).toBe(0);
    expect(amp(1)).toBe(0);
    // green by day, red at dusk / night / dawn
    expect(laserIsGreen(12)).toBe(true);
    expect(laserIsGreen(9)).toBe(true);
    expect(laserIsGreen(19)).toBe(false);
    expect(laserIsGreen(22)).toBe(false);
    expect(laserIsGreen(4)).toBe(false);
  });
});
