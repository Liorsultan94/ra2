import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import type { MapId } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { buildRoadNet, netInput } from '../src/render/ambient/roadnet';
it('net', () => {
  const id = (process.env.TFMAP || 'winter') as MapId;
  const m = createMap(id, 1);
  const D = Math.SQRT1_2;
  const br = m.bridges.map((b) => ({ ends: [{ x: b.x - (b.length / 2) * D, y: b.y + (b.length / 2) * D }, { x: b.x + (b.length / 2) * D, y: b.y - (b.length / 2) * D }] }));
  const net = buildRoadNet(netInput(m, buildLayout(m), br));
  const ctl = ['Free', 'Yield', 'Signal', 'Loop', 'TURN'];
  net.nodes.forEach((n, i) => console.log(' N', i, ctl[n.ctl], n.x.toFixed(1), n.y.toFixed(1), 'arms', n.arms.map((a) => `${a.line}${a.dir > 0 ? '+' : '-'}${a.major ? '*' : ''}@${a.arc.toFixed(1)}`).join(' '), n.loop >= 0 ? `R=${net.loops[n.loop].R.toFixed(2)}` : ''));
});
