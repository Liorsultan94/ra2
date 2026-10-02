import { describe, expect, it } from 'vitest';
import { waypointChain } from '../src/sim/orders';
import { TPS, type Command } from '../src/sim/types';
import { World } from '../src/sim/world';

function duel(seed = 5) {
  const w = new World({
    seed,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: false },
      { name: 'B', faction: 'russia', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  return w;
}

function run(w: World, ticks: number, onEvent?: (e: ReturnType<World['drainEvents']>[number]) => void) {
  for (let t = 0; t < ticks; t++) {
    w.step();
    for (const ev of w.drainEvents()) onEvent?.(ev);
  }
}

describe('stances', () => {
  it('units default to guard stance; the stance command changes it', () => {
    const w = duel();
    const a = w.spawnUnit('usa_mbt', 0, 30.5, 60.5);
    expect(a.stance).toBe('guard');
    w.issue(0, { type: 'stance', ids: [a.id], stance: 'aggressive' });
    w.step();
    expect(a.stance).toBe('aggressive');
    // enemies can't change our stance
    w.issue(1, { type: 'stance', ids: [a.id], stance: 'holdFire' });
    w.step();
    expect(a.stance).toBe('aggressive');
  });

  it('hold-fire units never shoot on their own, even when attacked', () => {
    const w = duel();
    const a = w.spawnUnit('usa_mbt', 0, 40.5, 60.5);
    a.hp = a.maxHp = 1e6;
    const b = w.spawnUnit('russia_rifle', 1, 43.5, 60.5);
    b.hp = b.maxHp = 1e6;
    w.issue(0, { type: 'stance', ids: [a.id], stance: 'holdFire' });
    let fired = 0;
    run(w, TPS * 20, (ev) => ev.t === 'fire' && ev.owner === 0 && fired++);
    expect(fired).toBe(0);
    expect(a.lastHurt).toBeGreaterThan(0); // it was shot at
    // an explicit attack order still fires
    w.issue(0, { type: 'attack', ids: [a.id], target: b.id });
    run(w, TPS * 5, (ev) => ev.t === 'fire' && ev.owner === 0 && fired++);
    expect(fired).toBeGreaterThan(0);
  });

  it('hold-position units do not move to chase, guard units do', () => {
    const mk = (stance: 'hold' | 'guard') => {
      const w = duel();
      const a = w.spawnUnit('usa_mbt', 0, 40.5, 60.5);
      a.hp = a.maxHp = 1e6;
      // enemy inside sight but outside cannon range
      const b = w.spawnUnit('russia_rifle', 1, 46.2, 60.5);
      b.hp = b.maxHp = 1e6;
      w.issue(0, { type: 'stance', ids: [a.id], stance });
      run(w, TPS * 15);
      return Math.hypot(a.x - 40.5, a.y - 60.5);
    };
    expect(mk('hold')).toBeLessThan(0.05);
    expect(mk('guard')).toBeGreaterThan(0.5);
  });

  it('hold-position units still fire at enemies in range', () => {
    const w = duel();
    const a = w.spawnUnit('usa_mbt', 0, 40.5, 60.5);
    w.spawnUnit('russia_rifle', 1, 43.5, 60.5);
    w.issue(0, { type: 'stance', ids: [a.id], stance: 'hold' });
    let fired = 0;
    run(w, TPS * 6, (ev) => ev.t === 'fire' && ev.owner === 0 && fired++);
    expect(fired).toBeGreaterThan(0);
    expect(Math.hypot(a.x - 40.5, a.y - 60.5)).toBeLessThan(0.05);
  });

  it('aggressive units chase further than guard units and stay where the fight ended', () => {
    const chase = (stance: 'aggressive' | 'guard') => {
      const w = duel();
      const a = w.spawnUnit('usa_mbt', 0, 40.5, 60.5);
      a.hp = a.maxHp = 1e6;
      const b = w.spawnUnit('russia_rifle', 1, 45.5, 60.5);
      b.hp = b.maxHp = 1e6;
      w.issue(0, { type: 'stance', ids: [a.id], stance });
      run(w, TPS * 2);
      // the enemy runs away down the road
      w.issue(1, { type: 'move', ids: [b.id], x: 40.5, y: 76.5 });
      run(w, TPS * 25);
      return Math.hypot(a.x - 40.5, a.y - 60.5);
    };
    expect(chase('aggressive')).toBeGreaterThan(chase('guard') + 2);
  });
});

describe('patrol, guard and waypoint queues', () => {
  it('patrol walks back and forth and engages on the way', () => {
    const w = duel();
    const a = w.spawnUnit('usa_rifle', 0, 30.5, 64.5);
    w.issue(0, { type: 'patrol', ids: [a.id], x: 36.5, y: 64.5 });
    let maxX = 0;
    let minXAfter = 99;
    for (let t = 0; t < TPS * 30; t++) {
      w.step();
      maxX = Math.max(maxX, a.x);
      if (maxX > 36) minXAfter = Math.min(minXAfter, a.x);
    }
    expect(maxX).toBeGreaterThan(36);
    expect(minXAfter).toBeLessThan(31.5);
    expect(a.patrol).not.toBeNull();
    // an enemy wanders onto the patrol route and gets shot
    const b = w.spawnUnit('russia_rifle', 1, 33.5, 65.5);
    let fired = 0;
    run(w, TPS * 10, (ev) => ev.t === 'fire' && ev.owner === 0 && fired++);
    expect(fired).toBeGreaterThan(0);
    expect(b.hp).toBeLessThan(b.maxHp);
    // a plain move cancels the patrol
    w.issue(0, { type: 'move', ids: [a.id], x: 30.5, y: 62.5 });
    w.step();
    expect(a.patrol).toBeNull();
  });

  it('queued waypoints are followed in order', () => {
    const w = duel();
    const a = w.spawnUnit('usa_mbt', 0, 30.5, 64.5);
    w.issue(0, { type: 'move', ids: [a.id], x: 34.5, y: 64.5 });
    w.issue(0, { type: 'move', ids: [a.id], x: 34.5, y: 69.5, queue: true });
    w.issue(0, { type: 'move', ids: [a.id], x: 30.5, y: 69.5, queue: true });
    w.step();
    expect(a.queue.length).toBe(2);
    expect(waypointChain(w, a).length).toBe(3);
    const visits: number[] = [];
    const pts = [
      [34.5, 64.5],
      [34.5, 69.5],
      [30.5, 69.5],
    ];
    for (let t = 0; t < TPS * 30; t++) {
      w.step();
      pts.forEach(([x, y], i) => {
        if (!visits.includes(i) && Math.hypot(a.x - x, a.y - y) < 0.3) visits.push(i);
      });
    }
    expect(visits).toEqual([0, 1, 2]);
    expect(a.queue.length).toBe(0);
    expect(a.order.type).toBe('idle');
  });

  it('a queued order on an idle unit starts at once; a new plain order clears the queue', () => {
    const w = duel();
    const a = w.spawnUnit('usa_mbt', 0, 30.5, 64.5);
    w.issue(0, { type: 'move', ids: [a.id], x: 34.5, y: 64.5, queue: true });
    w.step();
    expect(a.order.type).toBe('move');
    w.issue(0, { type: 'move', ids: [a.id], x: 34.5, y: 69.5, queue: true });
    w.step();
    expect(a.queue.length).toBe(1);
    w.issue(0, { type: 'stop', ids: [a.id] });
    w.step();
    expect(a.queue.length).toBe(0);
  });

  it('guards follow and protect the escorted unit', () => {
    const w = duel();
    const vip = w.spawnUnit('usa_mbt', 0, 30.5, 64.5);
    vip.hp = vip.maxHp = 1e6;
    const g = w.spawnUnit('usa_apc', 0, 28.5, 66.5);
    w.issue(0, { type: 'guard', ids: [g.id], target: vip.id });
    w.issue(0, { type: 'move', ids: [vip.id], x: 40.5, y: 62.5 });
    run(w, TPS * 15);
    expect(g.guardId).toBe(vip.id);
    expect(Math.hypot(g.x - vip.x, g.y - vip.y)).toBeLessThan(3.5);
    // an attacker shows up: the escort engages it
    const b = w.spawnUnit('russia_rifle', 1, vip.x + 4, vip.y);
    let fired = 0;
    run(w, TPS * 8, (ev) => ev.t === 'fire' && ev.id === g.id && fired++);
    expect(fired).toBeGreaterThan(0);
    expect(b.hp).toBeLessThan(b.maxHp);
  });

  it('production queues hold 9 per factory and repeat-build re-queues finished units', () => {
    const w = duel();
    w.spawnBuilding('usa_power', 0, 10, 88, true);
    w.spawnBuilding('usa_barracks', 0, 13, 88, true);
    w.players[0].credits = 100000;
    w.issue(0, { type: 'produce', def: 'usa_rifle', count: 10 });
    w.issue(0, { type: 'produce', def: 'usa_rifle', count: 5 });
    w.step();
    expect(w.players[0].queues.infantry.length).toBe(9);
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'cancel', def: 'usa_rifle' });
    w.issue(0, { type: 'repeat', cat: 'infantry', on: true });
    w.step();
    expect(w.players[0].queues.infantry.length).toBe(1);
    let ready = 0;
    run(w, TPS * 20, (ev) => ev.t === 'unitReady' && ready++);
    expect(ready).toBeGreaterThanOrEqual(3);
    expect(w.players[0].queues.infantry.length).toBe(1);
    w.issue(0, { type: 'repeat', cat: 'infantry', on: false });
    run(w, TPS * 10);
    expect(w.players[0].queues.infantry.length).toBe(0);
  });

  it('stance / patrol / guard / queue commands are deterministic', () => {
    const play = () => {
      const w = duel(9);
      const ids: number[] = [];
      for (let i = 0; i < 6; i++) ids.push(w.spawnUnit(i % 2 ? 'usa_rifle' : 'usa_mbt', 0, 28.5 + i, 64.5).id);
      const foes: number[] = [];
      for (let i = 0; i < 6; i++) foes.push(w.spawnUnit(i % 2 ? 'russia_rifle' : 'russia_mbt', 1, 44.5 + (i % 3), 56.5 + i).id);
      const script: [number, number, Command][] = [
        [1, 0, { type: 'stance', ids: ids.slice(0, 2), stance: 'aggressive' }],
        [1, 0, { type: 'patrol', ids: ids.slice(2, 4), x: 38.5, y: 60.5 }],
        [1, 0, { type: 'guard', ids: [ids[4]], target: ids[0] }],
        [2, 0, { type: 'move', ids: ids.slice(0, 2), x: 36.5, y: 62.5 }],
        [2, 0, { type: 'move', ids: ids.slice(0, 2), x: 42.5, y: 58.5, attackMove: true, queue: true }],
        [3, 1, { type: 'stance', ids: foes.slice(0, 3), stance: 'hold' }],
        [3, 1, { type: 'move', ids: foes.slice(3), x: 34.5, y: 62.5, attackMove: true }],
        [200, 0, { type: 'stance', ids: [ids[5]], stance: 'holdFire' }],
      ];
      for (let t = 0; t < TPS * 60; t++) {
        for (const [at, pid, cmd] of script) if (at === t) w.issue(pid, cmd);
        w.step();
        w.drainEvents();
      }
      return w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.x.toFixed(4)}:${e.y.toFixed(4)}:${e.hp.toFixed(2)}:${e.order.type}`).join('|');
    };
    expect(play()).toBe(play());
  });
});
