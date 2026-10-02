import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { unitDef, buildingDef } from '../src/sim/defs';
import { TPS, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
it('dbg2', () => {
  const [a, b] = ['iran', 'israel'] as [Faction, Faction];
  const w = new World({ seed: 3, players: [{ name: a, faction: a, color: 0, isAI: true }, { name: b, faction: b, color: 0, isAI: true }] });
  const ais = [new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard')];
  w.controllers.push(...ais);
  for (let t = 0; t < TPS * 60 * 20 && !w.over; t++) {
    w.step(); w.drainEvents();
    if (t % (TPS * 30) === 0) {
      for (const p of w.players) {
        const us = w.list.filter((e) => !e.dead && e.owner === p.id && e.kind === 'unit');
        const roles: Record<string, number> = {};
        for (const u of us) { const r = (ais[p.id] as any).role.get(u.id) ?? 'army'; const k = r + ':' + u.order.type; roles[k] = (roles[k] ?? 0) + 1; }
        const hurt = w.list.filter((e) => !e.dead && e.owner === p.id && (e.kind === 'building' || unitDef(e.def).harvester) && w.tick - e.lastHurt < TPS * 3).map((e) => e.def);
        console.log(Math.round(t / TPS), p.faction, 'cr', Math.round(p.credits), 'units', us.length, JSON.stringify(roles), 'wave', (ais[p.id] as any).waveSize, 'hurt', hurt.join(','), 'blds', w.list.filter((e) => !e.dead && e.owner === p.id && e.kind === 'building').map((e) => buildingDef(e.def).role).join(','));
      }
    }
  }
}, 600000);
