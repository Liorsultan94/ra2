import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { buildLayout } from '../src/render/layout';
it('dump', () => {
  for (const id of ['frontline', 'desert', 'winter', 'urban'] as const) {
    const m = createMap(id, 1);
    const L = buildLayout(m);
    console.log('MAP', id, m.w, m.h, 'roads', L.roads.length, 'tracks', L.tracks.length, 'bridges', m.bridges.length, 'structs', m.structures.length);
    const f = (p: {x:number;y:number}) => `(${p.x.toFixed(1)},${p.y.toFixed(1)})`;
    L.roads.forEach((r, i) => console.log(' R', i, r.width, r.variant, r.painted ? 'P' : '', r.pts.length, f(r.pts[0]), f(r.pts[r.pts.length - 1])));
    L.tracks.forEach((r, i) => console.log(' T', i, r.width, r.pts.length, f(r.pts[0]), f(r.pts[r.pts.length - 1])));
    m.bridges.forEach((b, i) => console.log(' B', i, JSON.stringify(b)));
  }
});
