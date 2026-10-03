import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { buildRoadNet, netInput } from '../src/render/ambient/roadnet';
it('net', () => {
  for (const id of ['frontline', 'desert', 'winter'] as const) {
    const m = createMap(id, 1);
    const net = buildRoadNet(netInput(m, buildLayout(m), []));
    const ctl = ['Free', 'Yield', 'Signal', 'Loop', 'TURN'];
    net.nodes.forEach((n, i) => {
      if (n.arms.length < 3) return;
      const near = m.structures.filter((s) => Math.hypot(s.x + s.w / 2 - n.x, s.y + s.h / 2 - n.y) < 8).length;
      console.log(id, ' N', i, ctl[n.ctl], n.x.toFixed(1), n.y.toFixed(1), 'arms', n.arms.map((a) => `${a.line}${net.lines[a.line].paved ? 'P' : 't'}`).join(' '), 'structs<8', near);
    });
  }
});
