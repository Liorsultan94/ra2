import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
it('probe', () => {
  const m = createMap('frontline', 1);
  const L = buildLayout(m);
  const rows: string[] = [];
  for (let y = 0; y < 50; y++) {
    let s = String(y).padStart(2) + ' ';
    for (let x = 0; x < 14; x++) {
      const i = y * m.w + x;
      const t = m.tiles[i];
      const R = L.occRes;
      const o = L.occ[(y * R + 2) * m.w * R + x * R + 2];
      s += m.trees[i] ? 'T' : t === 3 ? '~' : t === 4 ? '#' : o & 1 ? '=' : o & 2 ? '-' : m.blocked[i] ? 'B' : t === 1 ? ',' : '.';
    }
    rows.push(s);
  }
  console.log(rows.join('\n'));
  const r0 = L.roads.find((r) => r.pts[0].x < 1 || r.pts[r.pts.length - 1].x < 1)!;
  console.log(r0.pts.slice(0, 40).filter((_, i) => i % 4 === 0).map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '));
});
