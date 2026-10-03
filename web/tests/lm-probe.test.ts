import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
import { roadNetFor } from '../src/render/ambient/clearance';
it('probe', () => {
  for (const id of ['frontline', 'desert', 'winter', 'urban'] as const) {
    const m = createMap(id, 1);
    const n = roadNetFor(m, buildLayout(m));
    const out: string[] = [];
    n.lines.forEach((L, i) => {
      for (const e of [0, 1]) if (L.portal[e]) { const p = e ? L.pts[L.pts.length - 1] : L.pts[0]; out.push(`L${i} paved=${L.paved} (${p.x.toFixed(1)},${p.y.toFixed(1)})`); }
    });
    console.log(id, m.starts.map((s) => `${s.x},${s.y}`).join(' '), '\n ', out.join('\n  '));
    console.log(' structures', m.structures.map((s) => `${s.kind}@${s.x},${s.y}`).join(' '));
  }
});
