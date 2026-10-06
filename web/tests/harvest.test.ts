import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { HV_ALERT_GAP, HV_CALM, HV_FIELD_R, HV_ORDER_GRACE, HV_REPAIR_RATE, dockXY, harvestStatus, harvesterRepairing, refinerySpots } from '../src/sim/harvest';
import { TPS, type Entity, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';

// Income of the same benches on the code before the harvester fixes (5 minutes, seed 5, Frontline home field):
// three harvesters made $13,075; six jammed at the refinery for good after the first trip and made $3,600.
const BEFORE_3 = 13075;
const BEFORE_6 = 3600;
/** Player 0's home ore field on Frontline (sim/map.ts). */
const FIELD = { x: 27.5, y: 87.5 };

/** USA (player 0) vs Russia, starting forces cleared; player 0's refinery by its home ore field. */
function hvWorld(opts: { ai?: boolean; seed?: number } = {}) {
  const w = new World({
    seed: opts.seed ?? 5,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: !!opts.ai },
      { name: 'B', faction: 'russia', color: 0, isAI: false },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 14, 79, true);
  w.spawnBuilding('russia_conyard', 1, 80, 14, true);
  w.spawnBuilding('usa_power', 0, 10, 79, true);
  const ref = w.spawnBuilding('usa_refinery', 0, 21, 85, true);
  return { w, ref };
}

/** Only the home field keeps any ore (and only its ore mine regrows). */
function onlyHomeField(w: World) {
  for (let i = 0; i < w.map.ore.length; i++) {
    const x = i % w.map.w;
    const y = Math.floor(i / w.map.w);
    if (Math.hypot(x + 0.5 - FIELD.x, y + 0.5 - FIELD.y) > 6) w.map.ore[i] = 0;
  }
  w.map.oreMines = w.map.oreMines.filter((m) => Math.hypot(m.x + 0.5 - FIELD.x, m.y + 0.5 - FIELD.y) < 3);
}

function harvester(w: World, x: number, y: number, owner = 0): Entity {
  const h = w.spawnUnit(owner === 0 ? 'usa_harvester' : 'russia_harvester', owner, x, y);
  h.order = { type: 'harvest' };
  h.hstate = 'seek';
  return h;
}

/** A harvester at work on the home field with some ore aboard. */
function miner(w: World, cargo: number): Entity {
  const t = w.tileOf(FIELD.x, FIELD.y);
  const h = harvester(w, FIELD.x, FIELD.y);
  h.oreTile = t;
  h.hstate = 'mining';
  h.cargo = cargo;
  return h;
}

function run(w: World, ticks: number, until?: () => boolean): SimEvent[] {
  const evs: SimEvent[] = [];
  for (let i = 0; i < ticks && !(until && until()); i++) {
    w.step();
    evs.push(...w.drainEvents());
  }
  return evs;
}

/** The dock lane: the dock tile, the exit tile and the apron in front of it (tile indices). */
function laneTiles(w: World, ref: Entity): Set<number> {
  const s = new Set<number>();
  for (let dy = 2; dy <= 6; dy++) for (let dx = 0; dx <= 2; dx++) if (dy >= 3 || dx === 1) s.add(w.tileOf(ref.tx + dx + 0.5, ref.ty + dy + 0.5));
  return s;
}

function hostileTank(w: World, x: number, y: number): Entity {
  const t = w.spawnUnit('russia_mbt', 1, x, y);
  t.stance = 'holdFire'; // a threat in sight that does not shoot (the tests control the damage)
  t.hp = t.maxHp = 1e6;
  return t;
}

function hit(w: World, h: Entity, by: Entity, amount = 100) {
  w.damage(h, amount, 'cannon', by);
}

describe('harvesters sharing a field and a refinery', () => {
  function bench(n: number, minutes: number) {
    const { w, ref } = hvWorld();
    const hs: Entity[] = [];
    for (let i = 0; i < n; i++) hs.push(harvester(w, ref.tx + 1.5 + ((i % 3) - 1) * 1.1, ref.ty + 4.5 + Math.floor(i / 3) * 1.1));
    const hist = hs.map(() => [] as [number, number][]);
    const lastBusy = hs.map(() => -999);
    const run = hs.map(() => 0);
    let maxRun = 0;
    let overlap = 0;
    let minGap = 9;
    for (let t = 0; t < TPS * 60 * minutes; t++) {
      w.step();
      w.drainEvents();
      hs.forEach((h, i) => {
        hist[i].push([h.x, h.y]);
        const H = hist[i];
        const old = H.length > 60 ? H[H.length - 61] : null;
        // stuck: not mining / unloading / waiting its turn, yet less than 0.3 tiles of headway in 3 s
        const waitingTurn = h.hstate === 'toRefinery' && !h.path && !h.moving && h.dockSeq >= 0;
        if (h.hstate === 'mining' || h.hstate === 'unloading' || waitingTurn) lastBusy[i] = t;
        if (old && t - lastBusy[i] > 60 && Math.hypot(h.x - old[0], h.y - old[1]) < 0.3) maxRun = Math.max(maxRun, ++run[i] + 60);
        else run[i] = 0;
      });
      for (let a = 0; a < n; a++)
        for (let b = a + 1; b < n; b++) {
          const d = Math.hypot(hs[a].x - hs[b].x, hs[a].y - hs[b].y);
          minGap = Math.min(minGap, d);
          if (d < 0.7) overlap++;
        }
    }
    return { w, income: w.players[0].stats.harvested, maxStuck: maxRun / TPS, overlap, minGap };
  }

  it('six harvesters on one field and one refinery: nobody stuck, no overlap jams, more income than before', () => {
    const six = bench(6, 5);
    const three = bench(3, 5);
    console.log('6 harvesters / 5 min', six.income, 'max stuck', six.maxStuck.toFixed(1), 's, overlap ticks', six.overlap, 'min gap', six.minGap.toFixed(2));
    console.log('3 harvesters / 5 min', three.income, 'max stuck', three.maxStuck.toFixed(1), 's');
    expect(six.maxStuck).toBeLessThan(8);
    expect(three.maxStuck).toBeLessThan(8);
    expect(six.overlap).toBeLessThan(TPS * 2);
    expect(six.minGap).toBeGreaterThan(0.3);
    expect(three.income).toBeGreaterThanOrEqual(BEFORE_3);
    expect(six.income).toBeGreaterThan(BEFORE_6 * 4);
    // a sixth harvester is worth having now: six clearly out-earn three
    expect(six.income).toBeGreaterThan(three.income * 1.4);
  });

  it('spreads over the field: harvesters at work never share an ore tile', () => {
    const { w, ref } = hvWorld();
    const hs: Entity[] = [];
    for (let i = 0; i < 5; i++) hs.push(harvester(w, ref.tx + 1.5 + i - 2, ref.ty + 5.5));
    let shared = 0;
    let spreadMax = 0;
    for (let t = 0; t < TPS * 90; t++) {
      w.step();
      const work = hs.filter((h) => h.hstate === 'toOre' || h.hstate === 'mining');
      const tiles = work.map((h) => h.oreTile);
      if (new Set(tiles).size < tiles.length) shared++;
      const mining = hs.filter((h) => h.hstate === 'mining');
      for (let a = 0; a < mining.length; a++) for (let b = a + 1; b < mining.length; b++) spreadMax = Math.max(spreadMax, Math.hypot(mining[a].x - mining[b].x, mining[a].y - mining[b].y));
    }
    expect(shared).toBe(0);
    expect(spreadMax).toBeGreaterThan(2);
  });

  it('dock queue: one at a time, in turn, waiting on distinct spots off the lane', () => {
    const { w, ref } = hvWorld();
    const [dx, dy] = dockXY(ref);
    const hs: Entity[] = [];
    // four full harvesters coming home from the field, one behind the other
    for (let i = 0; i < 4; i++) {
      const h = harvester(w, dx + 7 + i * 1.6, dy + 1.5 + (i % 2) * 1.2);
      h.cargo = 900;
      h.hstate = 'toRefinery';
      hs.push(h);
    }
    w.map.ore.fill(0); // nothing to go back to: they unload once each
    w.map.oreMines = [];
    const lane = laneTiles(w, ref);
    const spots = refinerySpots(w, ref).queue;
    const ticket = new Map<number, number>();
    const order: number[] = [];
    const income0 = w.players[0].stats.harvested;
    let doubleDock = 0;
    let waitOnLane = 0;
    let sharedSpot = 0;
    for (let t = 0; t < TPS * 90 && order.length < 4; t++) {
      w.step();
      for (const h of hs) {
        if (h.dockSeq >= 0 && !ticket.has(h.id)) ticket.set(h.id, h.dockSeq);
        if (h.hstate === 'unloading' && !order.includes(h.id)) order.push(h.id);
      }
      const docking = hs.filter((h) => h.hstate === 'unloading' || h.hstate === 'leaving' || (h.hstate === 'toRefinery' && ref.dockedBy === h.id));
      if (docking.length > 1) doubleDock++;
      const parked = hs.filter((h) => h.hstate === 'toRefinery' && ref.dockedBy !== h.id && h.dockSeq >= 0 && !h.path);
      for (const h of parked) if (lane.has(w.tileOf(h.x, h.y))) waitOnLane++;
      if (new Set(parked.map((h) => h.qspot)).size < parked.length) sharedSpot++;
      for (const h of parked) expect(Math.hypot(h.x - spots[h.qspot][0], h.y - spots[h.qspot][1])).toBeLessThan(1.2);
    }
    expect(order.length).toBe(4);
    expect(doubleDock).toBe(0);
    expect(waitOnLane).toBe(0);
    expect(sharedSpot).toBe(0);
    // first come, first served: they dock in the order they joined the line
    const byTicket = [...ticket.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    expect(order).toEqual(byTicket);
    run(w, TPS * 10);
    expect(w.players[0].stats.harvested - income0).toBe(3600);
  });

  it('a second refinery takes the overflow', () => {
    const { w, ref } = hvWorld();
    const ref2 = w.spawnBuilding('usa_refinery', 0, 17, 85, true);
    w.map.ore.fill(0); // one trip each
    w.map.oreMines = [];
    const [dx, dy] = dockXY(ref);
    const hs: Entity[] = [];
    for (let i = 0; i < 4; i++) {
      const h = harvester(w, dx + 6 + i * 1.6, dy + 1.5 + (i % 2) * 1.2);
      h.cargo = 900;
      h.hstate = 'toRefinery';
      hs.push(h);
    }
    const used = new Set<number>();
    run(w, TPS * 60, () => {
      for (const h of hs) if (h.hstate === 'unloading') used.add(h.targetId);
      return hs.every((h) => h.cargo === 0);
    });
    expect(hs.every((h) => h.cargo === 0)).toBe(true);
    expect(used).toEqual(new Set([ref.id, ref2.id]));
  });
});

describe('harvesters under attack', () => {
  it('flee on damage with a partial load: unload it, park off the lane, repair at 3%/s, resume after the field is calm', () => {
    const { w, ref } = hvWorld();
    const h = miner(w, 300);
    const foe = w.spawnUnit('russia_mbt', 1, 50, 70); // far away: only the shot counts
    foe.stance = 'holdFire';
    run(w, 5);
    expect(h.hflee).toBeNull();
    const credits0 = w.players[0].stats.harvested;
    h.hp = h.maxHp * 0.4 + 100;
    hit(w, h, foe);
    const t0 = w.tick;
    const evs = run(w, 2);
    expect(h.hflee).not.toBeNull();
    expect(h.hstate).toBe('toRefinery');
    expect(harvestStatus(h)).toBe('Returning - under attack');
    expect(evs.filter((e) => e.t === 'harvesterAttack').length).toBe(1);
    expect(evs.some((e) => e.t === 'underAttack')).toBe(false);
    // home, unloads the partial load, parks for repair
    run(w, TPS * 40, () => !!h.hflee?.parked);
    expect(h.hflee?.parked).toBe(true);
    expect(w.players[0].stats.harvested - credits0).toBe(300);
    expect(h.cargo).toBe(0);
    expect(laneTiles(w, ref).has(w.tileOf(h.x, h.y))).toBe(false);
    expect(Math.hypot(h.x - (ref.tx + 1.5), h.y - (ref.ty + 1.5))).toBeLessThan(3.6); // beside the refinery
    expect(harvesterRepairing(h)).toBe(true);
    expect(harvestStatus(h)).toMatch(/^Repairing \d+%$/);
    const hp0 = h.hp;
    w.step();
    expect(h.hp - hp0).toBeCloseTo((h.maxHp * HV_REPAIR_RATE) / TPS, 6);
    // 40% -> 100% at 3%/s: about 20 s
    const tr = w.tick;
    run(w, TPS * 40, () => h.hp >= h.maxHp);
    expect(h.hp).toBe(h.maxHp);
    expect((w.tick - tr) / TPS).toBeGreaterThan(19);
    expect((w.tick - tr) / TPS).toBeLessThan(21);
    // repaired; the field was hit 15 s+ ago and nothing is there: back to it straight away
    run(w, TPS * 3, () => !h.hflee);
    expect(h.hflee).toBeNull();
    expect(w.tick - t0).toBeGreaterThanOrEqual(HV_CALM);
    expect(h.hstate).toBe('toOre');
    const ox = (h.oreTile % w.map.w) + 0.5;
    const oy = Math.floor(h.oreTile / w.map.w) + 0.5;
    expect(Math.hypot(ox - FIELD.x, oy - FIELD.y)).toBeLessThan(HV_FIELD_R);
  });

  it('a hostile closing in sends it home; it waits while its field is hot and goes back 15 s after it calms down', () => {
    const { w } = hvWorld();
    onlyHomeField(w); // nowhere else to go
    const h = miner(w, 0);
    h.hp = h.maxHp * 0.9;
    run(w, 4);
    const tank = hostileTank(w, FIELD.x + 3, FIELD.y - 1);
    const evs = run(w, 20);
    expect(h.hflee).not.toBeNull();
    expect(evs.filter((e) => e.t === 'harvesterAttack').length).toBe(1);
    run(w, TPS * 40, () => !!h.hflee?.parked && h.hp >= h.maxHp);
    expect(h.hp).toBe(h.maxHp);
    // repaired, but the hostile is still on the field: it waits
    run(w, TPS * 30);
    expect(h.hflee).not.toBeNull();
    expect(harvestStatus(h)).toBe('Waiting - ore field under attack');
    // the hostile goes: back to work about 15 s later, not before
    tank.dead = true;
    const gone = w.tick;
    run(w, TPS * 30, () => !h.hflee);
    expect(h.hflee).toBeNull();
    expect((w.tick - gone) / TPS).toBeGreaterThan(13);
    expect((w.tick - gone) / TPS).toBeLessThan(17);
    expect(['toOre', 'mining']).toContain(h.hstate);
  });

  it('picks another field when its own is still hot', () => {
    const { w } = hvWorld();
    const h = miner(w, 450);
    run(w, 4);
    hostileTank(w, FIELD.x + 2, FIELD.y);
    run(w, 20);
    expect(h.hflee).not.toBeNull();
    const income0 = w.players[0].stats.harvested;
    run(w, TPS * 60, () => !h.hflee);
    expect(h.hflee).toBeNull();
    expect(w.players[0].stats.harvested - income0).toBe(450);
    const ox = (h.oreTile % w.map.w) + 0.5;
    const oy = Math.floor(h.oreTile / w.map.w) + 0.5;
    expect(Math.hypot(ox - FIELD.x, oy - FIELD.y)).toBeGreaterThan(HV_FIELD_R + 2);
    // and it gets on with the work there
    run(w, TPS * 60);
    expect(h.hflee).toBeNull();
    expect(w.players[0].stats.harvested - income0).toBeGreaterThan(450);
  });

  it("a player's order overrides the run home", () => {
    const { w } = hvWorld();
    const h = miner(w, 200);
    const foe = w.spawnUnit('russia_mbt', 1, 50, 70);
    foe.stance = 'holdFire';
    run(w, 4);
    hit(w, h, foe);
    run(w, 3);
    expect(h.hflee).not.toBeNull();
    // move order: it goes where it is told
    w.issue(0, { type: 'move', ids: [h.id], x: 30.5, y: 80.5 });
    run(w, 2);
    expect(h.hflee).toBeNull();
    expect(h.order.type).toBe('move');
    expect(harvestStatus(h)).toBe('');
    run(w, TPS * 20, () => h.order.type !== 'move');
    expect(Math.hypot(h.x - 30.5, h.y - 80.5)).toBeLessThan(1.5);
    // harvest order onto the (hot) field: it goes and works there, and a hit right after does not send it home
    w.issue(0, { type: 'harvest', ids: [h.id], x: FIELD.x, y: FIELD.y });
    run(w, 2);
    expect(h.order.type).toBe('harvest');
    expect(h.hstate).toBe('toOre');
    hit(w, h, foe);
    run(w, 3);
    expect(h.hflee).toBeNull();
    run(w, HV_ORDER_GRACE);
    // the grace is over: the next hit does
    hit(w, h, foe);
    run(w, 3);
    expect(h.hflee).not.toBeNull();
  });

  it("the AI's harvesters do the same", () => {
    const { w } = hvWorld({ ai: true });
    w.controllers.push(new AIController(w, 0, 'hard'));
    const h = miner(w, 250);
    const foe = w.spawnUnit('russia_mbt', 1, 50, 70);
    foe.stance = 'holdFire';
    run(w, 4);
    const income0 = w.players[0].stats.harvested;
    h.hp = h.maxHp * 0.5;
    hit(w, h, foe);
    run(w, 3);
    expect(h.hflee).not.toBeNull();
    run(w, TPS * 40, () => !!h.hflee?.parked);
    expect(h.hflee?.parked).toBe(true);
    expect(w.players[0].stats.harvested - income0).toBeGreaterThanOrEqual(250);
    const hp0 = h.hp;
    run(w, TPS);
    expect(h.hp).toBeGreaterThan(hp0);
    run(w, TPS * 40, () => !h.hflee);
    expect(h.hflee).toBeNull();
    expect(h.hp).toBe(h.maxHp);
  });

  it('one "harvester under attack" alert per 20 s at most', () => {
    const { w } = hvWorld();
    const hs = [miner(w, 0), harvester(w, FIELD.x + 2, FIELD.y)];
    const foe = w.spawnUnit('russia_mbt', 1, 50, 70);
    foe.stance = 'holdFire';
    run(w, 4);
    const alerts: number[] = [];
    let generic = 0;
    for (let s = 0; s < 50; s++) {
      for (const h of hs) {
        h.hp = h.maxHp;
        hit(w, h, foe, 10);
      }
      for (const e of run(w, TPS)) {
        if (e.t === 'harvesterAttack') alerts.push(w.tick);
        if (e.t === 'underAttack') generic++;
      }
    }
    expect(generic).toBe(0);
    expect(alerts.length).toBeGreaterThanOrEqual(2);
    expect(alerts.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < alerts.length; i++) expect(alerts[i] - alerts[i - 1]).toBeGreaterThanOrEqual(HV_ALERT_GAP);
  });

  it('no flee-and-return loops with a hostile parked by the field', () => {
    const { w, ref } = hvWorld();
    const hs: Entity[] = [];
    for (let i = 0; i < 4; i++) hs.push(harvester(w, ref.tx + 0.5 + i, ref.ty + 5.5));
    // a hostile parked on the field for good
    hostileTank(w, FIELD.x + 3, FIELD.y + 1);
    const was = hs.map(() => false);
    let flights = 0;
    for (let t = 0; t < TPS * 240; t++) {
      w.step();
      w.drainEvents();
      hs.forEach((h, i) => {
        if (h.hflee && !was[i]) flights++;
        was[i] = !!h.hflee;
      });
    }
    console.log('flights in 4 min with a hostile by the field', flights, 'income', w.players[0].stats.harvested);
    expect(flights).toBeLessThanOrEqual(hs.length);
    expect(w.players[0].stats.harvested).toBeGreaterThan(8000);
  });

  it('is deterministic', () => {
    const snap = () => {
      const { w, ref } = hvWorld({ seed: 11 });
      const hs: Entity[] = [];
      for (let i = 0; i < 5; i++) hs.push(harvester(w, ref.tx + 0.5 + i, ref.ty + 5.5));
      const tank = hostileTank(w, FIELD.x + 4, FIELD.y - 2);
      run(w, TPS * 40);
      tank.stance = 'aggressive';
      run(w, TPS * 20);
      tank.dead = true;
      run(w, TPS * 60);
      return JSON.stringify([w.players[0].credits, w.players[0].stats.harvested, hs.map((h) => [h.x.toFixed(5), h.y.toFixed(5), h.hp.toFixed(3), h.hstate, h.cargo, !!h.hflee])]);
    };
    expect(snap()).toBe(snap());
  });
});
