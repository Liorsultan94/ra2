import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
import { LOT_STATS } from '../src/render/ambient/sites';
it('sites', () => {
  for (const id of ['frontline', 'desert', 'winter', 'urban'] as const) {
    const m = createMap(id, 1);
    const t0 = performance.now();
    for (const k in LOT_STATS) delete LOT_STATS[k]; const L = buildLayout(m); console.log(id, JSON.stringify(LOT_STATS));
    const n = roadNetFor(m, L);
    console.log(id, 'ms', (performance.now() - t0).toFixed(0), 'lots', n.lots.map((l) => `${l.x.toFixed(1)},${l.y.toFixed(1)} bays ${l.bays.length} line ${l.line}`).join(' | '), 'boards', n.boards.length, 'lotnodes', n.nodes.filter((x) => x.ctl === 5).length, 'loops', n.loops.length);
  }
});
