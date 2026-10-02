import { it } from 'vitest';
import { AIController } from '../src/sim/ai';
import { TPS, type Command, type Faction } from '../src/sim/types';
import { World } from '../src/sim/world';
it('dbg', () => {
  for (const [a, b] of [['ukraine', 'russia']] as [Faction, Faction][]) {
    const w = new World({ seed: 8, players: [{ name: a, faction: a, color: 0, isAI: true }, { name: b, faction: b, color: 0, isAI: true }] });
    w.controllers.push(new AIController(w, 0, 'hard'), new AIController(w, 1, 'hard'));
    const tally: Record<string, number>[] = [{}, {}];
    const orig = w.issue.bind(w);
    w.issue = (p: number, c: Command) => {
      const k = c.type + ('queue' in c && c.queue ? '+q' : '') + (c.type === 'stance' ? ':' + c.stance : '') + (c.type === 'move' && c.attackMove ? '(am)' : '') + (c.type === 'move' ? '[' + Math.min(c.ids.length, 3) + ']' : '');
      if (!['produce', 'place', 'deploy', 'capture', 'repair', 'cancel'].includes(c.type)) tally[p][k] = (tally[p][k] ?? 0) + 1;
      orig(p, c);
    };
    for (let t = 0; t < TPS * 60 * 14 && !w.over; t++) { w.step(); w.drainEvents(); }
    console.log(a, b, 'winner', w.winner, 'min', (w.tick / TPS / 60).toFixed(1), 'kills', w.players.map((p) => p.stats.killed));
    console.log(' ', a, JSON.stringify(tally[0]));
    console.log(' ', b, JSON.stringify(tally[1]));
  }
}, 600000);
