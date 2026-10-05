import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { DEFS, WEAPONS, unitDef } from '../src/sim/defs';
import { BLEED_TICKS, HEAL_RATE, REVIVE_HP, TREAT_TICKS, WOUND_CHANCE, bigBlast, bleedLeft } from '../src/sim/medic';
import { xpValue } from '../src/sim/veterancy';
import { TPS, type Entity, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

/** USA (player 0) vs Russia (player 1), starting forces cleared, a construction yard each. */
function medWorld(seed = 7, ai = false) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: ai },
      { name: 'B', faction: 'russia', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  return w;
}

function runUntil(w: World, cond: () => boolean, ticks: number): SimEvent[] {
  const evs: SimEvent[] = [];
  for (let i = 0; i < ticks && !cond(); i++) {
    w.step();
    evs.push(...w.drainEvents());
  }
  return evs;
}

/** Put soldier t down with a rifle-like blow from src (rolls the wound chance). */
function shoot(w: World, t: Entity, src: Entity, warhead: 'mg' | 'sniper' | 'artillery' = 'mg', big = false) {
  w.damage(t, t.hp * 10 + 50, warhead, src, false, big);
}

/**
 * A rifleman of player 0 that goes down wounded (tries soldiers until the seeded roll says wounded; the ones
 * that die are cleared from the books, so stats / XP afterwards only count this one).
 */
function woundedSoldier(w: World, x: number, y: number, src: Entity): Entity {
  for (let i = 0; i < 40; i++) {
    const s = w.spawnUnit('usa_rifle', 0, x, y);
    const xp0 = src.xp;
    const p0 = { ...w.players[0].stats };
    const p1 = { ...w.players[1].stats };
    shoot(w, s, src);
    if (s.wound) return s;
    src.xp = xp0;
    w.players[0].stats = p0;
    w.players[1].stats = p1;
    w.step();
    w.drainEvents();
  }
  throw new Error('no wounded soldier in 40 tries');
}

describe('wounded soldiers', () => {
  it('the wound chance is deterministic and about 60%', () => {
    const roll = (seed: number) => {
      const w = medWorld(seed);
      const src = w.spawnUnit('russia_rifle', 1, 60, 60);
      const out: boolean[] = [];
      for (let i = 0; i < 300; i++) {
        const s = w.spawnUnit('usa_rifle', 0, 20 + (i % 20), 20 + Math.floor(i / 20));
        shoot(w, s, src);
        out.push(!!s.wound);
        expect(s.wound ? !s.dead : s.dead).toBe(true);
        if (i % 7 === 0) w.step();
      }
      return out;
    };
    const a = roll(11);
    expect(roll(11)).toEqual(a);
    const k = a.filter(Boolean).length / a.length;
    expect(k).toBeGreaterThan(WOUND_CHANCE - 0.1);
    expect(k).toBeLessThan(WOUND_CHANCE + 0.1);
    expect(roll(12)).not.toEqual(a);
  });

  it('sniper shots, big explosions and crushing never leave wounded; vehicles and robots never go down wounded', () => {
    const w = medWorld();
    const src = w.spawnUnit('russia_sniper', 1, 60, 60);
    for (let i = 0; i < 40; i++) {
      const s = w.spawnUnit('usa_rifle', 0, 20, 20 + i * 0.5);
      shoot(w, s, src, 'sniper');
      expect(s.dead).toBe(true);
      expect(s.wound).toBeNull();
      const b = w.spawnUnit('usa_rifle', 0, 22, 20 + i * 0.5);
      shoot(w, b, src, 'artillery', true);
      expect(b.dead).toBe(true);
      const c = w.spawnUnit('usa_rifle', 0, 24, 20 + i * 0.5);
      w.kill(c, 1, src, 'crushed');
      expect(c.dead).toBe(true);
      const r = w.spawnUnit('usa_robot', 0, 26, 20 + i * 0.5);
      shoot(w, r, src);
      expect(r.dead).toBe(true);
      w.step();
    }
    expect(w.wounded.length).toBe(0);
    // the big-explosion rule: heavy artillery, missiles and bombs; not rifles, MGs, mortars or the RPG
    for (const id of ['howitzer', 'jetBomb', 'fateh', 'tomahawk', 'heliMissile', 'shahedWarhead']) expect(bigBlast(WEAPONS[id])).toBe(true);
    for (const id of ['rifle', 'mgHeavy', 'mortar', 'atRocket', 'cannon', 'sniper', 'manpads', 'sam']) expect(bigBlast(WEAPONS[id])).toBe(false);
  });

  it('a real howitzer shell kills soldiers outright', () => {
    const w = medWorld();
    const gun = w.spawnUnit('usa_arty', 1, 40, 46);
    const men = [0, 1, 2, 3, 4, 5].map((i) => w.spawnUnit('usa_rifle', 0, 40 + (i % 3) * 0.3, 40 + Math.floor(i / 3) * 0.3));
    for (const m of men) m.hp = 1;
    w.issue(1, { type: 'attack', ids: [gun.id], target: men[0].id });
    runUntil(w, () => men.every((m) => m.dead || m.wound), TPS * 30);
    expect(men.some((m) => m.dead)).toBe(true);
    expect(men.every((m) => !m.wound)).toBe(true);
  });

  it('passengers of a destroyed IFV die outright', () => {
    const w = medWorld();
    const apc = w.spawnUnit('usa_apc', 0, 30, 30);
    const riders = [0, 1, 2, 3, 4].map(() => w.spawnUnit('usa_rifle', 0, 30, 30));
    for (const r of riders) w.board(r, apc);
    const src = w.spawnUnit('russia_mbt', 1, 34, 30);
    w.damage(apc, 1e5, 'cannon', src);
    expect(apc.dead).toBe(true);
    for (const r of riders) {
      expect(r.dead).toBe(true);
      expect(r.wound).toBeNull();
    }
  });

  it('is untargetable and inactive, gives the kill XP as he goes down, and bleeds out at 45 s', () => {
    const w = medWorld();
    const enemy = w.spawnUnit('russia_rifle', 1, 33, 30);
    enemy.stance = 'hold';
    const xp0 = enemy.xp;
    const s = woundedSoldier(w, 30, 30, enemy);
    expect(s.hp).toBe(0);
    expect(enemy.xp - xp0).toBe(xpValue(s.def));
    const xp1 = enemy.xp;
    expect(bleedLeft(w, s)).toBeCloseTo(45, 0);
    const x0 = s.x;
    // the enemy next to him ignores him; orders to him are ignored; he never fires
    w.issue(0, { type: 'move', ids: [s.id], x: 40, y: 30 });
    w.issue(1, { type: 'attack', ids: [enemy.id], target: s.id });
    const evs = runUntil(w, () => s.dead, BLEED_TICKS + 5);
    expect(evs.filter((e) => e.t === 'fire').length).toBe(0);
    expect(enemy.order.type).not.toBe('attack');
    expect(s.x).toBe(x0);
    expect(s.dead).toBe(true);
    const down = s.wound!.at;
    const death = evs.find((e) => e.t === 'death' && e.id === s.id);
    expect(death).toBeTruthy();
    expect(evs.some((e) => e.t === 'wounded' && e.id === s.id && e.phase === 'bledOut')).toBe(true);
    expect(w.tick - down).toBe(BLEED_TICKS);
    // the kill counts when he dies; the XP was not given twice
    expect(w.players[1].stats.killed).toBe(1);
    expect(w.players[0].stats.lost).toBe(1);
    expect(enemy.xp).toBe(xp1);
    expect(w.wounded.length).toBe(0);
  });

  it('a medic revives a wounded soldier to 40%, and the soldier picks up his order', () => {
    const w = medWorld();
    const enemy = w.spawnUnit('russia_rifle', 1, 70, 70);
    const s = woundedSoldier(w, 30, 30, enemy);
    s.wound!.order = { type: 'attackMove', x: 40, y: 30 };
    const m = w.spawnUnit('usa_medic', 0, 35, 30);
    expect(unitDef(m.def).medic).toBe(true);
    const evs = runUntil(w, () => !s.wound, TPS * 20);
    expect(s.wound).toBeNull();
    expect(s.dead).toBe(false);
    expect(s.hp).toBeCloseTo(s.maxHp * REVIVE_HP, 5);
    expect(evs.some((e) => e.t === 'wounded' && e.phase === 'revived' && e.medic === m.id)).toBe(true);
    // he knelt at the soldier's side for the treatment
    expect(Math.hypot(m.x - s.x, m.y - s.y)).toBeLessThan(0.6);
    expect(s.order).toMatchObject({ type: 'attackMove', x: 40, y: 30 });
    expect(m.order.type).toBe('idle');
    expect(m.treat).toBe(0);
    expect(w.players[0].stats.lost).toBe(0);
  });

  it('treatment takes ~4 s at his side and two medics do not both take the same soldier', () => {
    const w = medWorld();
    const enemy = w.spawnUnit('russia_rifle', 1, 70, 70);
    const s = woundedSoldier(w, 30, 30, enemy);
    const m1 = w.spawnUnit('usa_medic', 0, 30.4, 30);
    const m2 = w.spawnUnit('usa_medic', 0, 31, 30.5);
    let started = -1;
    for (let i = 0; i < TPS * 12 && s.wound; i++) {
      w.step();
      if (started < 0 && (m1.treat > 0 || m2.treat > 0)) started = w.tick;
      expect(m1.treat > 0 && m2.treat > 0).toBe(false);
    }
    expect(s.wound).toBeNull();
    expect(w.tick - started).toBeGreaterThanOrEqual(TREAT_TICKS - 2);
    expect(w.tick - started).toBeLessThanOrEqual(TREAT_TICKS + 2);
  });

  it('the player can send a medic to a particular wounded soldier', () => {
    const w = medWorld();
    const enemy = w.spawnUnit('russia_rifle', 1, 70, 70);
    const s = woundedSoldier(w, 30, 30, enemy);
    const m = w.spawnUnit('usa_medic', 0, 30, 40); // out of his own search range
    runUntil(w, () => false, TPS * 2);
    expect(m.order.type).toBe('idle');
    w.issue(0, { type: 'treat', ids: [m.id], target: s.id });
    runUntil(w, () => !s.wound, TPS * 40);
    expect(s.wound).toBeNull();
    expect(s.hp).toBeCloseTo(s.maxHp * REVIVE_HP, 5);
  });

  it('a medic slowly heals hurt infantry near him, 2% max HP per second, one at a time', () => {
    const w = medWorld();
    const m = w.spawnUnit('usa_medic', 0, 30, 30);
    const a = w.spawnUnit('usa_rifle', 0, 31, 30);
    const b = w.spawnUnit('usa_rifle', 0, 30, 31);
    a.hp = a.maxHp * 0.5;
    b.hp = b.maxHp * 0.6;
    const tank = w.spawnUnit('usa_mbt', 0, 29, 30);
    tank.hp = tank.maxHp * 0.5;
    runUntil(w, () => false, TPS * 10);
    const healed = (a.hp - a.maxHp * 0.5) + (b.hp - b.maxHp * 0.6);
    // ~10 s of 2%/s on one soldier at a time (a 110 hp rifleman: 2.2 hp/s)
    expect(healed).toBeGreaterThan(a.maxHp * HEAL_RATE * 9);
    expect(healed).toBeLessThan(a.maxHp * HEAL_RATE * 11.5);
    expect(tank.hp).toBe(tank.maxHp * 0.5); // vehicles are not his job
    expect(m.hp).toBe(m.maxHp);
  });

  it('victory and defeat still trigger when only wounded soldiers remain', () => {
    const w = medWorld();
    const src = w.spawnUnit('usa_rifle', 0, 70, 70);
    const lone: Entity[] = [];
    for (let i = 0; i < 10 && lone.length < 2; i++) {
      const s = w.spawnUnit('russia_rifle', 1, 60 + i, 60);
      w.damage(s, 1e4, 'mg', src);
      if (s.wound) lone.push(s);
      w.step();
    }
    expect(lone.length).toBe(2);
    // player 1 loses his last structure: only wounded soldiers are left
    for (const e of w.list) if (e.owner === 1 && e.kind === 'building') w.kill(e, 0);
    const evs = runUntil(w, () => w.over, TPS * 3);
    expect(evs.some((e) => e.t === 'defeated' && e.owner === 1)).toBe(true);
    expect(w.over).toBe(true);
    expect(w.winner).toBe(0);
    for (const s of lone) expect(s.dead).toBe(true);
    expect(w.wounded.length).toBe(0);
  });

  it('the AI builds a couple of medics once it fields infantry, and they treat its wounded', () => {
    const w = medWorld(7, true);
    w.players[0].credits = 20000;
    w.spawnBuilding('usa_power', 0, 10, 84, true);
    w.spawnBuilding('usa_barracks', 0, 13, 84, true);
    for (let i = 0; i < 5; i++) w.spawnUnit('usa_rifle', 0, 14 + i * 0.4, 80);
    w.controllers.push(new AIController(w, 0, 'normal'));
    runUntil(w, () => w.list.filter((e) => !e.dead && e.def === 'usa_medic').length >= 2, TPS * 90);
    const medics = w.list.filter((e) => !e.dead && e.def === 'usa_medic');
    expect(medics.length).toBeGreaterThanOrEqual(2);
    expect(medics.length).toBeLessThanOrEqual(3);
    // a wounded soldier near one of them (once it has walked to the rally point) is picked up
    runUntil(w, () => medics[0].order.type === 'idle' && !medics[0].moving, TPS * 30);
    const enemy = w.spawnUnit('russia_rifle', 1, 70, 70);
    const s = woundedSoldier(w, medics[0].x + 2, medics[0].y, enemy);
    runUntil(w, () => !s.wound, TPS * 20);
    expect(s.wound).toBeNull();
    expect(s.dead).toBe(false);
  });

  it('every faction has a buildable medic at the barracks with its name', () => {
    const names: Record<string, string> = { usa: 'Combat Medic', israel: 'Medic', russia: 'Field Medic', china: 'Field Medic', iran: 'Medic', germany: 'Combat Medic', korea: 'Combat Medic', ukraine: 'Combat Medic', turkey: 'Combat Medic' };
    for (const [f, n] of Object.entries(names)) {
      const d = DEFS[`${f}_medic`];
      expect(d && d.kind === 'unit').toBe(true);
      const u = unitDef(`${f}_medic`);
      expect(u.name).toBe(n);
      expect(u.category).toBe('infantry');
      expect(u.weapon).toBeUndefined();
      expect(u.prereq).toEqual(['barracks']);
      expect(u.buildable).toBe(true);
      expect(u.cost).toBeGreaterThanOrEqual(200); // (about 300; some nations' infantry costs less)
      expect(u.cost).toBeLessThanOrEqual(350);
    }
  });
});
