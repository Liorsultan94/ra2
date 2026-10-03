import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
it('dbg', () => {
  const m = createMap('frontline', 1);
  const n = roadNetFor(m, buildLayout(m));
  n.nodes.forEach((nd, i) => { if (nd.ctl === 4) console.log('TURN', i, nd.x.toFixed(1), nd.y.toFixed(1), 'line', nd.arms[0].line, n.lines[nd.arms[0].line].paved, 'len', n.lines[nd.arms[0].line].len.toFixed(1), 'loops near', n.loops.filter((l) => Math.hypot(l.x - nd.x, l.y - nd.y) < 6).map((l) => [l.x.toFixed(1), l.y.toFixed(1), l.R]).join(';')); });
});
