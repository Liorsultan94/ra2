import menuSrc from '../src/ui/menu.ts?raw';
import appSrc from '../src/app.ts?raw';
import gameSrc from '../src/game/game.ts?raw';
import { describe, expect, it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { DEFS, FACTIONS, unitDef } from '../src/sim/defs';
import { enterGarrison } from '../src/sim/garrison';
import { FLARE_RADIUS, FLARE_TICKS, FLASH_TICKS, FLOOD_RADIUS, ILLUM_COOLDOWN, floodlit, hasNightVision } from '../src/sim/night';
import { parkJet } from '../src/sim/airbase';
import { TPS, type Command, type Entity, type SimEvent } from '../src/sim/types';
import { World } from '../src/sim/world';
import type { SimClock } from '../src/sim/clock';

const NIGHT: SimClock = { start: 23, live: false };
const DAY: SimClock = { start: 12, live: false };

/** USA (player 0) vs Russia (player 1), starting forces cleared, construction yards in the far corners. */
function duel(clock: SimClock, seed = 9, ai = false) {
  const w = new World({
    seed,
    clock,
    players: [
      { name: 'A', faction: 'usa', color: 0, isAI: false },
      { name: 'B', faction: 'russia', color: 0, isAI: ai },
    ],
  });
  for (const e of w.list) if (e.owner >= 0) e.dead = true;
  w.list = w.list.filter((e) => !e.dead);
  w.spawnBuilding('usa_conyard', 0, 4, 88, true);
  w.spawnBuilding('russia_conyard', 1, 88, 4, true);
  return w;
}

function at(w: World, def: string, owner: number, x: number, y: number) {
  const p = x === 30 && y === 60 ? open(w, x, y).map((v) => v - 0.5) : w.nearestPassable(x, y)!;
  const e = w.spawnUnit(def, owner, p[0] + 0.5, p[1] + 0.5);
  e.hp = e.maxHp = 1e6;
  return e;
}

function run(w: World, ticks: number, on?: (ev: SimEvent) => void) {
  for (let t = 0; t < ticks; t++) {
    w.step();
    for (const ev of w.drainEvents()) on?.(ev);
  }
}

/** Put b at distance d from a, along +x (on passable ground); it keeps that post. */
function placeFrom(w: World, a: Entity, b: Entity, d: number) {
  b.x = b.px = b.guardX = a.x + d;
  b.y = b.py = b.guardY = a.y;
  expect(w.pass[w.tileOf(b.x, b.y)]).toBe(1);
}

/** A spot near (x, y) with 16 tiles of open ground to its east (for placeFrom). */
function open(w: World, x: number, y: number): [number, number] {
  for (let r = 0; r < 30; r++)
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++) {
        if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
        const tx = Math.floor(x) + ox;
        const ty = Math.floor(y) + oy;
        let ok = true;
        for (let k = 0; k < 16 && ok; k++) ok = w.pf.passable(tx + k, ty) && w.pf.passable(tx + k, ty + 1) && w.pf.passable(tx + k, ty - 1);
        if (ok) return [tx + 0.5, ty + 0.5];
      }
  throw new Error('no open ground');
}

describe('night combat: sight and the night fog', () => {
  it('an enemy at the same distance: seen by day, hidden by night (ordinary sight halves)', () => {
    const seen = (clock: SimClock) => {
      const w = duel(clock);
      const rifle = at(w, 'usa_rifle', 0, 30, 60);
      rifle.stance = 'holdFire';
      const foe = at(w, 'russia_apc', 1, 30, 60);
      foe.stance = 'holdFire';
      placeFrom(w, rifle, foe, 4.6);
      run(w, 8);
      return { w, rifle, foe, sees: w.sees(0, foe) };
    };
    const day = seen(DAY);
    const night = seen(NIGHT);
    expect(day.w.night).toBe(false);
    expect(day.w.fog).toBe('classic');
    expect(night.w.night).toBe(true);
    expect(night.w.fog).toBe('modern');
    expect(day.sees).toBe(true);
    expect(night.sees).toBe(false);
    expect(night.w.sightOf(night.rifle)).toBeCloseTo(DEFS.usa_rifle.sight * 0.5, 6);
    // ... but the ground stays explored (memory), and it comes into view once close enough
    night.foe.x = night.foe.px = night.foe.guardX = night.rifle.x + 2.4;
    run(night.w, 8);
    expect(night.w.sees(0, night.foe)).toBe(true);
    night.foe.x = night.foe.px = night.foe.guardX = night.rifle.x + 4.6;
    run(night.w, 8);
    expect(night.w.sees(0, night.foe)).toBe(false);
  });

  it('discovered enemy structures stay known by night (explored), units on that ground are hidden', () => {
    const w = duel(NIGHT);
    const post = w.spawnBuilding('russia_power', 1, 60, 50, true);
    const p = w.players[0];
    for (let y = 45; y < 60; y++) for (let x = 55; x < 70; x++) p.explored[y * w.map.w + x] = 1;
    const tank = at(w, 'russia_apc', 1, 62, 55);
    tank.stance = 'holdFire';
    run(w, 8);
    expect(w.sees(0, tank)).toBe(false);
    expect(p.explored[w.tileOf(post.x, post.y)]).toBe(1); // the renderer shows explored structures (last known)
  });

  it('night vision keeps the full sight: snipers, MBTs, attack helicopters, drones, airborne jets (every faction)', () => {
    for (const f of FACTIONS) {
      for (const role of ['sniper', 'mbt', 'heli', 'uav']) {
        const d = DEFS[`${f.id}_${role}`];
        expect(d && d.kind === 'unit' && d.nvg, `${f.id}_${role}`).toBe(true);
      }
      const jet = DEFS[`${f.id}_fighter`];
      if (jet) expect(jet.kind === 'unit' && jet.nvg).toBe(true);
      for (const role of ['rifle', 'at', 'apc', 'harvester', 'mcv', 'engineer']) {
        const d = DEFS[`${f.id}_${role}`];
        if (d) expect(d.kind === 'unit' && !!d.nvg, `${f.id}_${role}`).toBe(false);
      }
    }
    expect(unitDef('turkey_akinci').nvg).toBe(true);
    const w = duel(NIGHT);
    for (const def of ['usa_sniper', 'usa_mbt', 'russia_mbt', 'usa_heli', 'usa_uav', 'israel_mbt']) {
      const e = at(w, def, 0, 30, 60);
      expect(w.sightOf(e), def).toBe(DEFS[def].sight);
      e.dead = true;
    }
    // an NVG tank sees a hidden enemy at a range where a rifleman sees nothing
    const tank = at(w, 'usa_mbt', 0, 30, 60);
    tank.stance = 'holdFire';
    const rifle = at(w, 'usa_rifle', 0, 30, 62);
    rifle.stance = 'holdFire';
    const foe = at(w, 'russia_apc', 1, 30, 60);
    foe.stance = 'holdFire';
    placeFrom(w, tank, foe, 6.2);
    rifle.x = rifle.px = rifle.guardX = tank.x;
    run(w, 8);
    expect(w.sees(0, foe)).toBe(true);
    tank.dead = true;
    run(w, 8);
    expect(w.sees(0, foe)).toBe(false);
  });

  it('fighter jets see in the dark only while airborne', () => {
    const w = duel(NIGHT);
    const af = w.spawnBuilding('usa_airfield', 0, 10, 60, true);
    const jet = w.spawnUnit('usa_fighter', 0, 12, 62);
    parkJet(w, jet, af);
    expect(hasNightVision(jet)).toBe(false); // parked: on its wheels
    jet.z = 3;
    expect(hasNightVision(jet)).toBe(true);
  });
});

describe('night combat: air defence sensors', () => {
  it('by night a SAM site acquires a helicopter at its full range; its sight against ground units still halves', () => {
    const w = duel(NIGHT);
    w.spawnBuilding('usa_power', 0, 20, 70, true);
    const sam = w.spawnBuilding('usa_def_aa', 0, 30, 60, true);
    sam.hp = sam.maxHp = 1e6;
    expect(DEFS.usa_def_aa.airSensor).toBe(true);
    expect(DEFS.russia_aa.airSensor).toBe(true);
    expect(DEFS.usa_laser.airSensor).toBe(true);
    expect(DEFS.usa_at.airSensor).toBe(true); // the Rocket Team's IR-seeker AA missile
    expect(DEFS.usa_mbt.airSensor).toBeFalsy();
    const heli = w.spawnUnit('russia_heli', 1, sam.x + 9, sam.y);
    heli.hp = heli.maxHp = 1e6;
    heli.stance = 'holdFire';
    heli.z = heli.pz = 1.7;
    const apc = at(w, 'russia_apc', 1, sam.x - 8, sam.y);
    apc.stance = 'holdFire';
    apc.x = apc.px = apc.guardX = sam.x - 7.5;
    apc.y = apc.py = apc.guardY = sam.y;
    run(w, 8);
    expect(w.night).toBe(true);
    expect(w.sightOf(sam)).toBeLessThan(DEFS.usa_def_aa.sight); // halved for the ground...
    expect(w.sees(0, heli)).toBe(true); // ... the radar still has the helicopter at 9 tiles
    expect(w.sees(0, apc)).toBe(false);
    let engaged = false;
    run(w, TPS * 8, (ev) => {
      if ((ev.t === 'fire' && ev.id === sam.id && ev.targetId === heli.id) || (ev.t === 'launch' && ev.sourceId === sam.id)) engaged = true;
    });
    expect(engaged).toBe(true);
  });

  it('by night an ordinary rifleman does not see a helicopter beyond his halved sight', () => {
    const seen = (clock: SimClock) => {
      const w = duel(clock);
      const rifle = at(w, 'usa_rifle', 0, 30, 60);
      rifle.stance = 'holdFire';
      const heli = w.spawnUnit('russia_heli', 1, rifle.x + 4.6, rifle.y);
      heli.hp = heli.maxHp = 1e6;
      heli.stance = 'holdFire';
      heli.z = heli.pz = 1.7;
      run(w, 8);
      return w.sees(0, heli);
    };
    expect(seen(DAY)).toBe(true);
    expect(seen(NIGHT)).toBe(false);
  });
});

describe('night combat: muzzle flashes', () => {
  /** An enemy sniper (night sight) 8 tiles from our rifleman (night sight 3): it shoots, we can't see it. */
  function sniperDuel(stance: 'aggressive' | 'holdFire') {
    const w = duel(NIGHT);
    const rifle = at(w, 'usa_rifle', 0, 30, 60);
    rifle.stance = 'holdFire';
    const sniper = at(w, 'russia_sniper', 1, 30, 60);
    placeFrom(w, rifle, sniper, 8);
    sniper.stance = stance;
    return { w, rifle, sniper };
  }

  it('a shot reveals the shooter to every enemy for 5 s after its last shot, then it is hidden again', () => {
    const { w, sniper } = sniperDuel('aggressive');
    run(w, 4);
    expect(w.sees(0, sniper)).toBe(false);
    let shot = -1;
    for (let t = 0; t < TPS * 10 && shot < 0; t++) run(w, 1, (ev) => ev.t === 'fire' && ev.id === sniper.id && (shot = w.tick));
    expect(shot).toBeGreaterThan(0);
    expect(w.sees(0, sniper)).toBe(true);
    // stop it shooting: the flash fades 5 s after this last shot
    w.issue(1, { type: 'stance', ids: [sniper.id], stance: 'holdFire' });
    run(w, shot + FLASH_TICKS - 1 - w.tick);
    expect(w.sees(0, sniper)).toBe(true);
    run(w, 2);
    expect(w.sees(0, sniper)).toBe(false);
    expect(FLASH_TICKS).toBe(5 * TPS);
  });

  it('a shooter revealed by its flash can be targeted (our units answer fire they could not see)', () => {
    const { w, sniper } = sniperDuel('aggressive');
    const arty = at(w, 'usa_arty', 0, 30, 66);
    arty.x = arty.px = arty.guardX = sniper.x - 4;
    arty.y = arty.py = arty.guardY = sniper.y + 4;
    let answered = false;
    run(w, TPS * 15, (ev) => {
      if (ev.t === 'fire' && ev.id === arty.id && ev.targetId === sniper.id) answered = true;
    });
    expect(answered).toBe(true);
  });

  it('"No fire" (holdFire): no shot, no flash, it stays hidden (the ambush)', () => {
    const { w, sniper } = sniperDuel('holdFire');
    let fired = 0;
    let seen = 0;
    for (let t = 0; t < TPS * 20; t++) {
      run(w, 1, (ev) => ev.t === 'fire' && ev.id === sniper.id && fired++);
      if (w.sees(0, sniper)) seen++;
    }
    expect(fired).toBe(0);
    expect(seen).toBe(0);
  });

  it('base defences and garrisoned buildings are given away by their muzzle flashes too', () => {
    // defence: a bunker firing by night is lit up for 5 s
    const w = duel(NIGHT);
    const bunker = w.spawnBuilding('russia_def_gun', 1, 40, 40, true);
    const rifle = at(w, 'usa_rifle', 0, 43, 41);
    rifle.stance = 'holdFire';
    let fired = false;
    run(w, TPS * 6, (ev) => ev.t === 'fire' && ev.id === bunker.id && (fired = true));
    expect(fired).toBe(true);
    expect(w.tick - bunker.flashAt).toBeLessThan(FLASH_TICKS);
    expect(w.sees(0, bunker)).toBe(true);
    // garrison: soldiers firing from a house give the house away
    const house = w.list.find((e) => !e.dead && e.kind === 'building' && DEFS[e.def].kind === 'building' && (DEFS[e.def] as { garrison?: number }).garrison)!;
    expect(house).toBeTruthy();
    const g = at(w, 'russia_rifle', 1, house.x, house.y);
    expect(enterGarrison(w, g, house)).toBe(true);
    const target = at(w, 'usa_apc', 0, house.x, house.y);
    target.stance = 'holdFire';
    target.x = target.px = target.guardX = house.x + 3.2;
    target.y = target.py = target.guardY = house.y;
    let houseFire = false;
    run(w, TPS * 6, (ev) => ev.t === 'fire' && ev.id === g.id && (houseFire = true));
    expect(houseFire).toBe(true);
    expect(w.tick - house.flashAt).toBeLessThan(FLASH_TICKS);
    expect(w.tick - g.flashAt).toBeLessThan(FLASH_TICKS);
  });
});

describe('night combat: illumination rounds', () => {
  it('artillery fires a flare that reveals the area to its owner for its burn time, with a 45 s cooldown', () => {
    const w = duel(NIGHT);
    const arty = at(w, 'usa_arty', 0, 30, 60);
    arty.stance = 'holdFire';
    expect(unitDef('usa_arty').illum).toBe(true);
    expect(unitDef('israel_mortar').illum).toBe(true);
    expect(unitDef('usa_mbt').illum).toBeFalsy();
    const foe = at(w, 'russia_apc', 1, 30, 60);
    foe.stance = 'holdFire';
    placeFrom(w, arty, foe, 8.5);
    run(w, 8);
    expect(w.sees(0, foe)).toBe(false);
    const evs: SimEvent[] = [];
    w.issue(0, { type: 'illum', ids: [arty.id], x: foe.x, y: foe.y });
    run(w, TPS * 2, (ev) => evs.push(ev));
    const ill = evs.find((e) => e.t === 'illum');
    expect(ill).toBeTruthy();
    expect(w.flares.length).toBe(1);
    const f = w.flares[0];
    expect(f.owner).toBe(0);
    expect(f.end - f.at).toBe(FLARE_TICKS);
    // in flight: not lit yet
    run(w, Math.max(0, f.at - w.tick - 4));
    expect(w.sees(0, foe)).toBe(false);
    run(w, 8);
    expect(w.sees(0, foe)).toBe(true);
    // the whole area around the flare, for the burn time, to the owner only
    const p0 = w.players[0];
    const mx = Math.floor(f.x);
    const my = Math.floor(f.y);
    expect(p0.visible[my * w.map.w + Math.min(w.map.w - 1, mx + FLARE_RADIUS - 1)]).toBe(1);
    expect(w.players[1].visible[my * w.map.w + mx - (FLARE_RADIUS - 1)]).toBe(0);
    run(w, f.end - w.tick - 8);
    expect(w.sees(0, foe)).toBe(true);
    run(w, 12);
    expect(w.flares.length).toBe(0);
    expect(w.sees(0, foe)).toBe(false);
    // the gun reloads its illumination round for 45 s
    expect(arty.illumAt - f.fired).toBe(ILLUM_COOLDOWN);
    w.issue(0, { type: 'illum', ids: [arty.id], x: foe.x, y: foe.y });
    run(w, TPS * 2);
    expect(w.flares.length).toBe(w.tick >= arty.illumAt - TPS * 2 ? 1 : 0);
    run(w, Math.max(0, arty.illumAt - w.tick));
    w.issue(0, { type: 'illum', ids: [arty.id], x: foe.x, y: foe.y });
    run(w, TPS * 2);
    expect(w.flares.length).toBe(1);
  });

  it('out of range the gun closes in first; the shot gives the gun away', () => {
    const w = duel(NIGHT);
    const arty = at(w, 'usa_arty', 0, 30, 60);
    const x0 = arty.x;
    w.issue(0, { type: 'illum', ids: [arty.id], x: arty.x + 14, y: arty.y });
    let fired = -1;
    run(w, TPS * 30, (ev) => ev.t === 'illum' && fired < 0 && (fired = w.tick));
    expect(fired).toBeGreaterThan(0);
    expect(arty.x).toBeGreaterThan(x0 + 3);
    expect(arty.flashAt).toBe(fired);
  });

  it('the AI fires illumination at night when its base is hit', () => {
    const w = duel(NIGHT, 11, true);
    const ai = new AIController(w, 1, 'normal');
    w.controllers.push(ai);
    w.spawnBuilding('russia_power', 1, 80, 14, true);
    const fac = w.spawnBuilding('russia_factory', 1, 74, 10, true);
    fac.hp = fac.maxHp = 1e6;
    const guns = [at(w, 'russia_tos', 1, 77, 18), at(w, 'russia_tos', 1, 79, 19)];
    for (const g of guns) g.stance = 'hold';
    // our tank shells the factory from the dark
    const tank = at(w, 'usa_mbt', 0, 66, 11);
    w.issue(0, { type: 'attack', ids: [tank.id], target: fac.id });
    let flare = false;
    run(w, TPS * 40, (ev) => ev.t === 'illum' && ev.owner === 1 && (flare = true));
    expect(flare).toBe(true);
  });
});

describe('night combat: base floodlights', () => {
  it('powered structures light and reveal a ring around them by night; low power puts them out', () => {
    const w = duel(NIGHT);
    const power = w.spawnBuilding('usa_power', 0, 30, 60, true);
    const fac = w.spawnBuilding('usa_factory', 0, 40, 60, true);
    fac.hp = fac.maxHp = 1e6;
    const foe = at(w, 'russia_apc', 1, 45, 61);
    foe.stance = 'holdFire';
    foe.x = foe.px = foe.guardX = fac.tx + 1.5 + 4.6;
    foe.y = foe.py = foe.guardY = fac.ty + 1.5;
    run(w, 8);
    expect(w.isLowPower(w.players[0])).toBe(false);
    expect(floodlit(w, fac)).toBe(true);
    expect(FLOOD_RADIUS).toBeGreaterThan(4.6);
    expect(w.sees(0, foe)).toBe(true); // in the floodlight, beyond the factory's own night sight
    // the power plant goes: low power, the lights go out
    w.kill(power, -1);
    run(w, 8);
    expect(w.isLowPower(w.players[0])).toBe(true);
    expect(floodlit(w, fac)).toBe(false);
    expect(w.sees(0, foe)).toBe(false);
    // by day there are no floodlights (and no need)
    const d = duel(DAY);
    const b = d.spawnBuilding('usa_power', 0, 30, 60, true);
    run(d, 4);
    expect(floodlit(d, b)).toBe(false);
  });
});

describe('night combat: AI fairness', () => {
  /** AI player 1 with riflemen at home; our hold-fire APC parked 4.6 tiles from them. */
  function probe(clock: SimClock) {
    const w = duel(clock, 13, true);
    const ai = new AIController(w, 1, 'hard');
    w.controllers.push(ai);
    const home = [w.players[1].startX + 0.5, w.players[1].startY + 0.5];
    const r = [at(w, 'russia_rifle', 1, home[0] - 8, home[1] + 10), at(w, 'russia_rifle', 1, home[0] - 8, home[1] + 10)];
    for (const u of r) u.stance = 'hold';
    const spy = at(w, 'usa_apc', 0, r[0].x, r[0].y);
    spy.stance = 'holdFire';
    spy.x = spy.px = spy.guardX = r[0].x - 4.6;
    spy.y = spy.py = spy.guardY = r[0].y;
    expect(w.pass[w.tileOf(spy.x, spy.y)]).toBe(1);
    let targeted = 0;
    const orig = w.issue.bind(w);
    w.issue = (pid: number, c: Command) => {
      if (pid === 1 && c.type === 'attack' && c.target === spy.id) targeted++;
      orig(pid, c);
    };
    let shots = 0;
    let seen = 0;
    for (let t = 0; t < TPS * 30; t++) {
      run(w, 1, (ev) => {
        if (ev.t === 'fire' && ev.owner === 1 && ev.targetId === spy.id) {
          shots++;
        }
      });
      if (w.sees(1, spy)) seen++;
    }
    const intel = (ai as unknown as { intel: Map<number, unknown> }).intel;
    return { targeted, shots, seen, known: intel.has(spy.id) };
  }

  it('by night the AI neither sees, remembers nor targets a hidden unit it would see by day', () => {
    const day = probe(DAY);
    expect(day.seen).toBeGreaterThan(0);
    expect(day.known).toBe(true);
    expect(day.shots + day.targeted).toBeGreaterThan(0);
    const night = probe(NIGHT);
    expect(night.seen).toBe(0);
    expect(night.known).toBe(false);
    expect(night.targeted).toBe(0);
    expect(night.shots).toBe(0);
  });

  it('AI vs AI through the night stays deterministic and both sides play by the same rules', () => {
    const game = () => {
      const w = new World({
        seed: 41,
        clock: { start: 21, live: true },
        players: [
          { name: 'a', faction: 'usa', color: 0, isAI: true },
          { name: 'b', faction: 'russia', color: 0, isAI: true },
        ],
      });
      w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
      return w;
    };
    const snap = (w: World) => w.tick + '#' + w.flares.length + '#' + w.list.filter((e) => !e.dead).map((e) => `${e.id}:${e.x.toFixed(3)}:${e.y.toFixed(3)}:${e.hp.toFixed(1)}`).join('|');
    const x = game();
    const y = game();
    let fired = 0;
    for (let t = 0; t < TPS * 60 * 5 && !x.over; t++) {
      x.step();
      y.step();
      for (const ev of x.drainEvents()) if (ev.t === 'fire') fired++;
      y.drainEvents();
      if (t % (TPS * 30) === 0) expect(snap(x)).toBe(snap(y));
      expect(x.night).toBe(true);
    }
    expect(snap(x)).toBe(snap(y));
    expect(fired).toBeGreaterThan(10);
  }, 240000);
});

describe('fog of war setting removed', () => {
  it('the menu has no fog of war option and the game options / URL no fog parameter', () => {
    const menu = menuSrc;
    expect(menu).not.toMatch(/seg\('fog'/);
    expect(menu).not.toMatch(/FOG_OPTS|FOG_NOTE/);
    const app = appSrc;
    expect(app).not.toMatch(/params\.get\('fog'\)/);
    expect(app).not.toMatch(/\bfog:/);
    const game = gameSrc;
    expect(game).not.toMatch(/fog\?: FogMode/);
  });
});
