import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { DEFS, WEAPONS, unitDef } from '../src/sim/defs';
import { BLEED_TICKS, HEAL_RATE, HURT_HP, MEDIC_RANGE, MEDIC_SCAN, REVIVE_HP, TREAT_RATE, TREAT_REACH, TREAT_TICKS, WOUND_CHANCE, bigBlast, bleedLeft, treatPoseOf, treatProgress, treatable, underFire } from '../src/sim/medic';
import { xpValue } from '../src/sim/veterancy';
import { TPS, type Entity, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

/** USA (player 0) vs Russia (player 1), starting forces cleared, a construction yard each. */
function medWorld(seed = 7, ai = false) {
  const w = new World({
    seed,
    wounds: true,
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

describe('wounded state is off in the game', () => {
  it('a soldier brought to 0 HP dies outright (no wounded state), on both sides', () => {
    const w = new World({ seed: 7, players: [{ name: 'A', faction: 'israel', color: 0, isAI: false }, { name: 'B', faction: 'iran', color: 0, isAI: true }] });
    expect(w.wounds).toBe(false);
    const a = w.spawnUnit('iran_rifle', 1, 60, 60);
    const b = w.spawnUnit('israel_rifle', 0, 61, 60);
    for (let i = 0; i < 30; i++) {
      for (const [owner, def, src] of [[0, 'israel_rifle', a], [1, 'iran_rifle', b]] as const) {
        const s = w.spawnUnit(def, owner, 20 + i * 0.5, 20 + owner * 3);
        shoot(w, s, src);
        expect(s.dead).toBe(true);
        expect(s.wound).toBeNull();
      }
    }
    expect(w.wounded.length).toBe(0);
  });
});

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

  it('a medic slowly heals hurt infantry near him, 2% max HP per second, one at a time (the fallback, held back from treating)', () => {
    const w = medWorld();
    const m = w.spawnUnit('usa_medic', 0, 30, 30);
    m.stance = 'holdFire'; // (no trips of his own: only the slow healing around him)
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

describe('medics treat hurt soldiers (on their feet)', () => {
  // (open ground on the test map: x 25..35, y 18..24 is clear but for the tiles (36, 21..22))

  /** Rifleman of player 0 at (x, y) with this share of his health. */
  function hurtSoldier(w: World, x: number, y: number, k: number): Entity {
    const s = w.spawnUnit('usa_rifle', 0, x, y);
    s.hp = s.maxHp * k;
    return s;
  }

  it('an idle medic goes to a hurt soldier and treats him to full health at ~8% per second', () => {
    const trace = (seed: number) => {
      const w = medWorld(seed);
      const m = w.spawnUnit('usa_medic', 0, 26, 20);
      const s = hurtSoldier(w, 31, 20, 0.4);
      const out: number[] = [];
      let rate = 0;
      let kneel = false;
      for (let i = 0; i < TPS * 20 && s.hp < s.maxHp; i++) {
        const h0 = s.hp;
        w.step();
        out.push(Math.round(s.hp * 1000), Math.round(m.x * 1000), Math.round(m.y * 1000));
        if (m.treat > 0) {
          rate = Math.max(rate, s.hp - h0);
          expect(Math.hypot(m.x - s.x, m.y - s.y)).toBeLessThanOrEqual(TREAT_REACH + 1e-6);
          expect(treatProgress(w, m)).toBeCloseTo(s.hp / s.maxHp, 5);
          const [hurt, stand] = treatPoseOf(w, m);
          expect(hurt).toBe(true);
          if (!stand) kneel = true;
        }
      }
      expect(s.hp).toBe(s.maxHp);
      expect(kneel).toBe(true); // he stands still: the medic kneels at his side
      // ~8% of max HP per second while at work (a tick's worth)
      expect(rate).toBeCloseTo((s.maxHp * TREAT_RATE) / TPS, 5);
      // done: back to idle, free for the next one
      w.step();
      expect(m.order.type).toBe('idle');
      expect(m.treat).toBe(0);
      expect(s.tendedBy).toBe(-1);
      return out;
    };
    const a = trace(3);
    // ~4.6 tiles' walk (~3.5 s) + 60% at 8%/s (7.5 s)
    expect(a.length / 3).toBeLessThan(TPS * 13);
    expect(a.length / 3).toBeGreaterThan(TPS * 9);
    expect(trace(3)).toEqual(a); // deterministic
  });

  it('a scratch (above 90%) or a soldier out of range is not worth a trip of his own', () => {
    const w = medWorld();
    const m = w.spawnUnit('usa_medic', 0, 26, 20);
    const a = hurtSoldier(w, 30, 20, HURT_HP + 0.04);
    const b = hurtSoldier(w, 26 + MEDIC_RANGE + 1.5, 22, 0.3);
    runUntil(w, () => false, TPS * 4);
    expect(m.order.type).toBe('idle');
    expect(a.hp).toBeCloseTo(a.maxHp * (HURT_HP + 0.04), 5);
    expect(b.hp).toBeCloseTo(b.maxHp * 0.3, 5);
    // but the player may send him to either
    expect(treatable(a) && treatable(b)).toBe(true);
  });

  it('wounded soldiers come first; then the most hurt, a little nearer preferred', () => {
    const w = medWorld();
    const enemy = w.spawnUnit('russia_rifle', 1, 70, 70);
    const down = woundedSoldier(w, 31, 20, enemy);
    const m = w.spawnUnit('usa_medic', 0, 26, 20);
    const hurt = hurtSoldier(w, 27.5, 20, 0.2); // much nearer, and badly hurt
    runUntil(w, () => m.order.type === 'treat', MEDIC_SCAN * 2);
    expect(m.order).toMatchObject({ type: 'treat', target: down.id });
    runUntil(w, () => !down.wound, TPS * 15);
    expect(down.wound).toBeNull();
    expect(hurt.hp).toBeCloseTo(hurt.maxHp * 0.2, 5); // no time for him meanwhile
    // then the most hurt of the two on their feet: the hurt one (20%) before the revived one (40%)
    runUntil(w, () => m.order.type === 'treat', TPS);
    expect(m.order).toMatchObject({ type: 'treat', target: hurt.id });
    runUntil(w, () => hurt.hp >= hurt.maxHp && down.hp >= down.maxHp, TPS * 30);
    expect(hurt.hp).toBe(hurt.maxHp);
    expect(down.hp).toBe(down.maxHp);
    // equally hurt: the nearer one; a little more hurt beats a little nearer
    const w2 = medWorld();
    const m2 = w2.spawnUnit('usa_medic', 0, 28, 20);
    const far = hurtSoldier(w2, 28, 24, 0.5);
    const near = hurtSoldier(w2, 30, 20, 0.5);
    const worse = hurtSoldier(w2, 33, 22, 0.42); // farther, a little worse: first
    runUntil(w2, () => m2.order.type === 'treat', MEDIC_SCAN * 2);
    expect(m2.order).toMatchObject({ type: 'treat', target: worse.id });
    worse.hp = worse.maxHp;
    runUntil(w2, () => m2.order.type === 'treat' && m2.order.target !== worse.id, TPS * 2);
    expect(m2.order).toMatchObject({ type: 'treat', target: near.id });
    expect(far.hp).toBeCloseTo(far.maxHp * 0.5, 5);
  });

  it('two medics never take the same patient', () => {
    const w = medWorld();
    const m1 = w.spawnUnit('usa_medic', 0, 26, 20);
    const m2 = w.spawnUnit('usa_medic', 0, 26.4, 20.3);
    const a = hurtSoldier(w, 29, 20, 0.3);
    const b = hurtSoldier(w, 26, 24, 0.5);
    let both = 0;
    for (let i = 0; i < TPS * 20 && (a.hp < a.maxHp || b.hp < b.maxHp); i++) {
      w.step();
      const t1 = m1.order.type === 'treat' ? m1.order.target : -1;
      const t2 = m2.order.type === 'treat' ? m2.order.target : -1;
      if (t1 >= 0 && t2 >= 0) {
        both++;
        expect(t1).not.toBe(t2);
      }
    }
    expect(both).toBeGreaterThan(TPS); // they worked side by side
    expect(a.hp).toBe(a.maxHp);
    expect(b.hp).toBe(b.maxHp);
    // one patient, two medics: only one of them goes
    const w2 = medWorld();
    const n1 = w2.spawnUnit('usa_medic', 0, 26, 20);
    const n2 = w2.spawnUnit('usa_medic', 0, 26, 21);
    const c = hurtSoldier(w2, 29, 20.5, 0.3);
    for (let i = 0; i < TPS * 12 && c.hp < c.maxHp; i++) {
      w2.step();
      expect(n1.order.type === 'treat' && n2.order.type === 'treat').toBe(false);
    }
    expect(c.hp).toBe(c.maxHp);
  });

  it('follows a patient who walks on, treating him on the way, and leaves his orders alone', () => {
    const w = medWorld();
    const m = w.spawnUnit('usa_medic', 0, 26, 20);
    const s = hurtSoldier(w, 27, 20, 0.2);
    runUntil(w, () => m.treat > 0, TPS * 3);
    expect(m.treat).toBeGreaterThan(0);
    w.issue(0, { type: 'move', ids: [s.id], x: 44, y: 19 });
    w.step();
    const order = { ...s.order };
    expect(order.type).toBe('move');
    let onTheMove = 0;
    let standing = 0;
    let gap = 0;
    for (let i = 0; i < TPS * 15 && s.hp < s.maxHp; i++) {
      const h0 = s.hp;
      w.step();
      if (s.moving && s.hp > h0) onTheMove++;
      if (m.treat > 0 && treatPoseOf(w, m)[1]) standing++;
      if (s.moving) expect(s.order).toEqual(order);
      gap = Math.max(gap, Math.hypot(m.x - s.x, m.y - s.y));
    }
    expect(s.hp).toBe(s.maxHp);
    expect(onTheMove).toBeGreaterThan(TPS * 3); // treated while walking
    expect(standing).toBeGreaterThan(TPS * 3); // on his feet beside him meanwhile
    expect(gap).toBeLessThan(2); // the medic kept up with him
    runUntil(w, () => !s.moving, TPS * 10);
    expect(Math.hypot(s.x - 44, s.y - 19)).toBeLessThan(1); // he got where he was sent
  });

  it('the player can send a medic to any hurt soldier, also a slightly hurt or far one', () => {
    const w = medWorld();
    const m = w.spawnUnit('usa_medic', 0, 26, 20);
    const s = hurtSoldier(w, 40, 19, 0.95); // a scratch, out of his own search range
    runUntil(w, () => false, TPS * 2);
    expect(m.order.type).toBe('idle');
    w.issue(0, { type: 'treat', ids: [m.id], target: s.id });
    runUntil(w, () => s.hp >= s.maxHp, TPS * 20);
    expect(s.hp).toBe(s.maxHp);
    w.step();
    expect(m.order.type).toBe('idle');
    // nothing to treat: a soldier at full health, a tank, an enemy soldier
    const tank = w.spawnUnit('usa_mbt', 0, 30, 22);
    tank.hp = tank.maxHp * 0.5;
    const foe = w.spawnUnit('russia_rifle', 1, 33, 22);
    foe.stance = 'holdFire';
    foe.hp = foe.maxHp * 0.5;
    for (const t of [s, tank, foe]) {
      w.issue(0, { type: 'treat', ids: [m.id], target: t.id });
      w.step();
      expect(m.order.type).not.toBe('treat');
    }
  });

  it('a hurt soldier under enemy fire is left alone unless the player sends the medic; the wounded are still rescued', () => {
    const w = medWorld();
    const m = w.spawnUnit('usa_medic', 0, 26, 20);
    const s = hurtSoldier(w, 30, 20, 0.4);
    s.stance = 'holdFire';
    const range = WEAPONS[unitDef('russia_rifle').weapon!].range;
    const enemy = w.spawnUnit('russia_rifle', 1, 30 + range - 0.5, 20);
    enemy.stance = 'holdFire';
    runUntil(w, () => false, TPS / 2);
    expect(w.sees(0, enemy)).toBe(true);
    expect(underFire(w, s, 0)).toBe(true);
    runUntil(w, () => false, TPS * 4);
    expect(m.order.type).toBe('idle');
    expect(s.hp).toBeCloseTo(s.maxHp * 0.4, 5);
    // an enemy out of range is no reason to stay away
    enemy.x = 30 + range + 1.5;
    w.step();
    expect(underFire(w, s, 0)).toBe(false);
    runUntil(w, () => m.order.type === 'treat', TPS);
    expect(m.order).toMatchObject({ type: 'treat', target: s.id, auto: true });
    // the enemy closes in: he leaves him
    enemy.x = 30 + range - 0.5;
    runUntil(w, () => m.order.type !== 'treat', TPS * 2);
    expect(m.order.type).toBe('idle');
    const h1 = s.hp;
    // the player sends him anyway
    w.issue(0, { type: 'treat', ids: [m.id], target: s.id });
    runUntil(w, () => s.hp >= s.maxHp, TPS * 15);
    expect(s.hp).toBe(s.maxHp);
    expect(h1).toBeLessThan(s.maxHp * 0.7);
    // a wounded soldier right there is rescued all the same
    const down = woundedSoldier(w, 31, 21, enemy);
    runUntil(w, () => !down.wound, TPS * 12);
    expect(down.wound).toBeNull();
    expect(down.dead).toBe(false);
  });

  it('on hold he treats only the soldiers right beside him', () => {
    const w = medWorld();
    const m = w.spawnUnit('usa_medic', 0, 26, 20);
    m.stance = 'hold';
    const far = hurtSoldier(w, 29, 20, 0.3);
    runUntil(w, () => false, TPS * 3);
    expect(m.order.type).toBe('idle');
    const near = hurtSoldier(w, 27.2, 20, 0.5);
    runUntil(w, () => near.hp >= near.maxHp, TPS * 10);
    expect(near.hp).toBe(near.maxHp);
    expect(Math.hypot(m.x - 26, m.y - 20)).toBeLessThan(1);
    expect(far.hp).toBeCloseTo(far.maxHp * 0.3, 5);
  });

  it('AI medics treat hurt soldiers the same way', () => {
    const w = medWorld(7, true);
    w.players[0].credits = 0;
    w.controllers.push(new AIController(w, 0, 'normal'));
    const m = w.spawnUnit('usa_medic', 0, 26, 20);
    const s = hurtSoldier(w, 29, 20, 0.35);
    runUntil(w, () => s.hp >= s.maxHp, TPS * 15);
    expect(s.hp).toBe(s.maxHp);
    expect(m.dead).toBe(false);
  });
});
