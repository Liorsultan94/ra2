// SN1 design aid: the desert's road graph dead ends (turning circles or 3-point turns).
import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';

it('sinai roads', () => {
  const m = createMap('desert', 1);
  const n = roadNetFor(m, buildLayout(m)) as any;
  for (const nd of n.nodes.filter((nd: any) => nd.arms.length === 1)) {
    const L = n.lines[nd.arms[0].line];
    console.log(`dead end ctl ${nd.ctl} at ${nd.x?.toFixed?.(1)},${nd.y?.toFixed?.(1)} E${((nd.x - nd.y) / Math.SQRT2).toFixed(1)} S${((nd.x + nd.y) / Math.SQRT2).toFixed(1)} half ${L.half} paved ${L.paved}`);
  }
});
