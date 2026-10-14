// Controlled harvest test: one refinery per player at point-mirrored spots by a base ore field, N harvesters, no AI.
import { it } from 'vitest';
import { TPS } from '../src/sim/types';
import { World } from '../src/sim/world';
import { factionUnit } from '../src/sim/defs';

it('dock', () => {
  const MAPS = (process.env.MAPS ?? 'frontline,desert,winter,urban').split(',');
  for (const map of MAPS) for (const mine of [0, 1]) for (const mode of ['ai', 'apron']) {
    const w = new World({ seed: 1, map: map as never, players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'usa', color: 0, isAI: true }] });
    const m = w.map;
    const s = m.starts[0];
    const ore = m.oreMines[mine];
    let best: [number, number] | null = null;
    let bs = Infinity;
    for (let ty = ore.y - 12; ty <= ore.y + 12; ty++) for (let tx = ore.x - 12; tx <= ore.x + 12; tx++) {
      const mx = m.w - tx - 3, my = m.h - ty - 3;
      if (!w.canPlace(0, 'usa_refinery', tx, ty, -1, false) || !w.canPlace(1, 'usa_refinery', mx, my, -1, false)) continue;
      const cx = tx + 1.5, cy = ty + 1.5;
      const sc = mode === 'ai' ? Math.hypot(cx - ore.x, cy - ore.y) * 1.5 + Math.hypot(cx - s.x, cy - s.y) * 0.3 : Math.hypot(tx + 1.5 - ore.x, ty + 4.5 - ore.y) * 1.5 + Math.hypot(cx - s.x, cy - s.y) * 0.3;
      if (Math.hypot(cx - ore.x, cy - ore.y) < 5) continue;
      if (sc < bs) { bs = sc; best = [tx, ty]; }
    }
    if (!best) { console.log(map, mine, 'no spot'); continue; }
    const [tx, ty] = best;
    const r0 = w.spawnBuilding('usa_refinery', 0, tx, ty, true);
    const r1 = w.spawnBuilding('usa_refinery', 1, m.w - tx - 3, m.h - ty - 3, true);
    const hv = factionUnit('usa', (u) => !!u.harvester).id;
    for (let k = 0; k < 2; k++) {
      w.spawnUnit(hv, 0, r0.tx + 1.5, r0.ty + 3.5 + k);
      w.spawnUnit(hv, 1, r1.tx + 1.5, r1.ty + 3.5 + k);
    }
    while (w.tick < TPS * 60 * 8) w.step();
    const h = w.players.map((p) => p.stats.harvested);
    console.log(`${map} mine${mine}@${ore.x},${ore.y} ${mode} ref0@${tx},${ty} -> harvested p0=${h[0]} p1=${h[1]} (${((h[0] - h[1]) / h[1] * 100).toFixed(0)}%)`);
  }
});
