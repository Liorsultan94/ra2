import { it } from 'vitest';
import { createMap } from '../src/sim/maps';
import { World } from '../src/sim/world';

it('sym', () => {
  for (const id of ['frontline', 'desert', 'winter', 'urban'] as const) for (const seed of [1, 2, 3]) {
    const m = createMap(id, seed);
    const { w, h } = m;
    const out: string[] = [];
    const cmp = (name: string, a: ArrayLike<number>, W: number, H: number, tol = 0) => {
      let n = 0; let ex = '';
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x, j = (H - 1 - y) * W + (W - 1 - x);
        if (Math.abs(a[i] - a[j]) > tol) { n++; if (n <= 6) ex += ` (${x},${y})=${a[i]}vs${a[j]}`; }
      }
      if (n) out.push(`${name}: ${n / 2} asym${ex}`);
    };
    cmp('tiles', m.tiles, w, h); cmp('heights', m.heights, w + 1, h + 1, 1e-4); cmp('trees', m.trees, w, h); cmp('ore', m.ore, w, h); cmp('oreKind', m.oreKind, w, h); cmp('blocked', m.blocked, w, h);
    const wd = new World({ seed, map: id, players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'usa', color: 0, isAI: true }] });
    cmp('pass', wd.pass, w, h);
    const s = m.starts;
    if (s[0].x + s[1].x !== w - 1 || s[0].y + s[1].y !== h - 1) out.push(`starts ${JSON.stringify(s)}`);
    const ptSet = (name: string, pts: { x: number; y: number }[], off: number) => {
      const key = (p: { x: number; y: number }) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
      const set = new Set(pts.map(key));
      const bad = pts.filter((p) => !set.has(key({ x: w - off - p.x, y: h - off - p.y })));
      if (bad.length) out.push(`${name}: ${bad.length} unmirrored ${bad.slice(0, 4).map(key).join(' ')}`);
    };
    ptSet('oils', m.oils, 2); ptSet('oreMines', m.oreMines, 1);
    ptSet('bridges', m.bridges.map((b) => ({ x: b.x, y: b.y })), 0);
    ptSet('lanes', m.lanes ?? [], 1);
    const neu = wd.list.filter((e: any) => e.owner < 0 || e.owner >= 2).map((e: any) => ({ x: e.x, y: e.y, d: e.def }));
    const nk = (p: any) => `${p.d}@${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    const ns = new Set(neu.map(nk));
    const nb = neu.filter((p) => !ns.has(nk({ d: p.d, x: w - p.x, y: h - p.y })));
    if (nb.length) out.push(`neutral ents: ${nb.length}/${neu.length} unmirrored ${nb.slice(0, 6).map(nk).join(' ')}`);
    const pe = wd.list.filter((e: any) => e.owner === 0 || e.owner === 1).map((e: any) => `p${e.owner}:${e.def}@${e.x.toFixed(1)},${e.y.toFixed(1)}`);
    out.push(`player ents: ${pe.join(' ')}`);
    let ore0 = 0, ore1 = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = m.ore[y * w + x]; const d0 = Math.hypot(x - s[0].x, y - s[0].y), d1 = Math.hypot(x - s[1].x, y - s[1].y); if (d0 < d1) ore0 += o; else if (d1 < d0) ore1 += o; }
    out.push(`starts ${JSON.stringify(s)} ore by side ${ore0} / ${ore1}; techSites ${JSON.stringify(m.techSites?.map((t) => t.def))}`);
    console.log(`== ${id} seed ${seed} ${w}x${h}\n  ` + out.join('\n  '));
  }
});
