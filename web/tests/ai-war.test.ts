import { describe, expect, it } from 'vitest';
import { AIController, type Difficulty } from '../src/sim/ai';
import { DEFS, defsForFaction, factionDefByRole, unitDef } from '../src/sim/defs';
import { DOCTRINES, NO_WAR } from '../src/sim/doctrine';
import { peaceTicks } from '../src/sim/peace';
import { TPS, type Command, type Entity, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAI = any;

function world(a: Faction, b: Faction, seed = 1, map: 'frontline' | 'desert' = 'frontline') {
  return new World({ seed, map, players: [
    { name: a, faction: a, color: 0, isAI: true },
    { name: b, faction: b, color: 0, isAI: true },
  ] });
}

/** A known (scouted) enemy structure of player 0 at a spot on open ground near (x, y). */
function known(w: World, ai: AnyAI, def: string, x: number, y: number): Entity {
  const p = w.nearestPassable(x, y, 8, w.mainland)!;
  const b = w.spawnBuilding(def, 0, p[0], p[1], true);
  ai.intel.set(b.id, { x: b.x, y: b.y, def: b.def, building: true, seen: w.tick, vx: 0, vy: 0 });
  return b;
}

describe('war doctrines (AI2)', () => {
  it('use only each nation’s own units; Iran has no jets', () => {
    for (const [f, doc] of Object.entries(DOCTRINES) as [Faction, (typeof DOCTRINES)[Faction]][]) {
      const keys = new Set(defsForFaction(f).filter((d) => d.kind === 'unit').map((d) => d.id.slice(f.length + 1)));
      for (const k of Object.keys(doc.war.mix)) expect(keys.has(k), `${f} ${k}`).toBe(true);
    }
    expect(defsForFaction('iran').some((d) => d.kind === 'unit' && unitDef(d.id).fixedWing && !!unitDef(d.id).weapon)).toBe(false);
    expect(DOCTRINES.iran.war.mix.fighter).toBeUndefined();
  });

  it('Easy plays no war doctrine; Normal and Hard do', () => {
    const w = world('usa', 'russia');
    for (const [d, on] of [['easy', false], ['normal', true], ['hard', true]] as [Difficulty, boolean][]) expect((new AIController(w, 1, d) as AnyAI).war !== NO_WAR).toBe(on);
  });

  it('Russia builds more artillery before its first big attack (and prepares it with the guns)', () => {
    const share = (warOn: boolean) => {
      let arty = 0;
      let all = 0;
      let preps = 0;
      for (const seed of [1, 2, 3]) {
        const w = world('usa', 'russia', seed);
        const pt = peaceTicks('hard', 'auto');
        const ai = new AIController(w, 1, 'hard', { peaceTicks: pt }) as AnyAI;
        if (!warOn) ai.war = NO_WAR;
        w.controllers.push(new AIController(w, 0, 'hard', { peaceTicks: pt }), ai);
        const issue = w.issue.bind(w);
        w.issue = (pid: number, c: Command) => {
          if (pid === 1 && c.type === 'produce' && DEFS[c.def]?.kind === 'unit' && unitDef(c.def).weapon && !unitDef(c.def).harvester && ai.stats.waves < 2) {
            all++;
            if (unitDef(c.def).aiTag === 'arty') arty++;
          }
          issue(pid, c);
        };
        for (let t = 0; t < TPS * 60 * 14 && !w.over && ai.stats.waves < 2; t++) w.step();
        preps += ai.stats.preps;
      }
      return { share: arty / Math.max(1, all), preps };
    };
    const on = share(true);
    const off = share(false);
    expect(on.share).toBeGreaterThan(off.share * 1.3);
    expect(on.preps).toBeGreaterThan(0);
  }, 300000);

  it('Iran fires its missiles at the economy, Israel strikes high-value targets (neither without the doctrine)', () => {
    for (const [f, near, far, launcher] of [
      ['iran', 'factory', 'refinery', 'iran_fateh'],
      ['israel', 'factory', 'superweapon', 'israel_lora'],
    ] as [Faction, string, string, string][]) {
      const w = world('usa', f);
      const ai = new AIController(w, 1, 'hard') as AnyAI;
      w.controllers.push(ai);
      const e = w.players[0];
      const me = w.players[1];
      const l = w.spawnUnit(launcher, 1, me.startX + 0.5, me.startY + 0.5);
      // the doctrine's target a little farther away than the other one
      const dx = (e.startX - me.startX) / Math.hypot(e.startX - me.startX, e.startY - me.startY);
      const dy = (e.startY - me.startY) / Math.hypot(e.startX - me.startX, e.startY - me.startY);
      const a = known(w, ai, factionDefByRole('usa', near).id, e.startX - dx * 14 + dy * 6, e.startY - dy * 14 - dx * 6);
      const b = known(w, ai, factionDefByRole('usa', far).id, e.startX - dx * 10 - dy * 6, e.startY - dy * 10 + dx * 6);
      expect(Math.hypot(b.x - l.x, b.y - l.y)).toBeGreaterThan(Math.hypot(a.x - l.x, a.y - l.y));
      expect(ai.pickStrikeTarget(l), f).toBe(b.id);
      ai.war = NO_WAR;
      expect(ai.pickStrikeTarget(l), f).toBe(a.id);
    }
  });

  it('Iran’s drone launchers go for the economy', () => {
    const w = world('usa', 'iran');
    const ai = new AIController(w, 1, 'hard') as AnyAI;
    w.controllers.push(ai);
    const me = w.players[1];
    const [x, y] = [me.startX + 0.5, me.startY + 0.5];
    const d = w.spawnUnit('iran_shahedl', 1, x, y);
    // a tank and a harvester in range and in sight
    const tank = w.spawnUnit('usa_mbt', 0, x + 5, y + 1);
    const harv = w.spawnUnit('usa_harvester', 0, x + 1, y + 5);
    for (let t = 0; t < 3; t++) w.step();
    const cmds: Command[] = [];
    const issue = w.issue.bind(w);
    w.issue = (pid: number, c: Command) => {
      if (pid === 1) cmds.push(c);
      issue(pid, c);
    };
    d.order = { type: 'idle' };
    ai.manageArtillery([d]);
    const atk = cmds.find((c) => c.type === 'attack') as { target: number } | undefined;
    expect(atk?.target).toBe(harv.id);
    expect(tank.dead).toBe(false);
  });

  it('USA: air superiority first - its jets hunt the air defences', () => {
    const w = world('russia', 'usa');
    const ai = new AIController(w, 1, 'hard') as AnyAI;
    w.controllers.push(ai);
    const e = w.players[0];
    const me = w.players[1];
    const jet = w.spawnUnit('usa_fighter', 1, me.startX + 0.5, me.startY + 0.5);
    const sam = known(w, ai, factionDefByRole('russia', 'def_aa').id, e.startX + 8, e.startY + 8);
    const ref = known(w, ai, factionDefByRole('russia', 'refinery').id, e.startX + 2, e.startY + 12);
    expect(ai.pickJetTarget(jet)).toBe(sam.id);
    ai.war = NO_WAR;
    expect(ai.pickJetTarget(jet)).toBe(ref.id);
  });

  it('China attacks on a broad front; Ukraine avoids pitched battles', () => {
    const w = world('china', 'ukraine', 2);
    const ais = [new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard')] as AnyAI[];
    w.controllers.push(...ais);
    for (let t = 0; t < TPS * 60 * 14 && !w.over && !ais[0].stats.broad; t++) w.step();
    expect(ais[0].stats.broad).toBeGreaterThan(0);
    // hit and run: Ukraine breaks off a fight sooner than anyone
    for (const f of Object.keys(DOCTRINES) as Faction[]) if (f !== 'ukraine') expect(DOCTRINES.ukraine.war.pitched).toBeGreaterThan(DOCTRINES[f].war.pitched);
    expect(DOCTRINES.ukraine.war.raid).toBeGreaterThan(1);
  }, 120000);
});
