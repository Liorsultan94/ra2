import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
import { buildRoadNet, netInputFrom, bridgeEnds } from '../src/render/ambient/roadnet';
it('nodes', () => {
  const m = createMap('desert', 1);
  const l = buildLayout(m);
  const n = roadNetFor(m, l);
  console.log('NODES ' + JSON.stringify(n.nodes.filter((x) => x.arms.length > 2 || (x.arms.length === 2 && x.arms[0].line !== x.arms[1].line)).map((x) => [x.x.toFixed(1), x.y.toFixed(1), x.arms.length, x.ctl, x.village])));
  const dbg: string[] = [];
  buildRoadNet({ ...netInputFrom(m, l.roads, l.tracks, bridgeEnds(m)), debug: dbg });
  console.log('DBG ' + dbg.filter((s) => !s.includes('R 0.') && !s.includes('R 1.4') && !s.includes('R 1.5')).join(' | '));
  console.log('LINES ' + JSON.stringify(n.lines.map((L, i) => [i, L.paved, L.len.toFixed(0), L.pts[0].x.toFixed(0), L.pts[0].y.toFixed(0), L.pts[L.pts.length - 1].x.toFixed(0), L.pts[L.pts.length - 1].y.toFixed(0)])));
});
