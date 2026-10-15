// Path symmetry: find(p -> q) vs find(mirror p -> mirror q) on each map; reached goal and path length.
import { it } from 'vitest';
import { World } from '../src/sim/world';
import { Rng } from '../src/sim/rng';

it('pathsym', () => {
  for (const map of ['frontline', 'desert', 'winter', 'urban'] as const) {
    const w = new World({ seed: 1, map, players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'usa', color: 0, isAI: true }] });
    const { w: W, h: H } = w.map;
    const len = (sx: number, sy: number, p: number[]) => {
      let L = 0, x = sx, y = sy;
      for (const t of p) { const tx = t % W, ty = Math.floor(t / W); L += Math.hypot(tx - x, ty - y); x = tx; y = ty; }
      return L;
    };
    const run = (sx: number, sy: number, gx: number, gy: number) => {
      w.pf.clearCache();
      const p = w.pf.find(sx, sy, gx, gy);
      const end = p.length ? p[p.length - 1] : sy * W + sx;
      return { ok: end === gy * W + gx, L: len(sx, sy, p) };
    };
    const s = w.map.starts;
    const lanes = [...w.map.bridges.map((b) => ({ x: Math.floor(b.x), y: Math.floor(b.y) })), ...(w.map.lanes ?? []).map((l) => ({ x: Math.floor(l.x), y: Math.floor(l.y) }))];
    const out: string[] = [];
    const a = run(s[0].x, s[0].y, s[1].x, s[1].y), b = run(s[1].x, s[1].y, s[0].x, s[0].y);
    out.push(`base->base p0 ${a.ok ? '' : 'PARTIAL '}${a.L.toFixed(1)} p1 ${b.ok ? '' : 'PARTIAL '}${b.L.toFixed(1)}`);
    // each start to every lane: own start vs mirrored lane from the other start
    for (const l of lanes) {
      const m = { x: W - 1 - l.x, y: H - 1 - l.y };
      const r0 = run(s[0].x, s[0].y, l.x, l.y), r1 = run(s[1].x, s[1].y, m.x, m.y);
      if (!w.pf.passable(l.x, l.y)) continue;
      out.push(`lane ${l.x},${l.y}: p0 ${r0.ok ? '' : 'PARTIAL '}${r0.L.toFixed(1)} | p1->mirror ${r1.ok ? '' : 'PARTIAL '}${r1.L.toFixed(1)}`);
    }
    // random mirrored pairs
    const rng = new Rng(7);
    let n = 0, diff = 0, part0 = 0, part1 = 0, sumd = 0;
    while (n < 300) {
      const sx = rng.int(W), sy = rng.int(H), gx = rng.int(W), gy = rng.int(H);
      if (!w.pf.passable(sx, sy) || !w.pf.passable(gx, gy) || Math.hypot(gx - sx, gy - sy) < 30) continue;
      n++;
      const r0 = run(sx, sy, gx, gy), r1 = run(W - 1 - sx, H - 1 - sy, W - 1 - gx, H - 1 - gy);
      if (!r0.ok) part0++;
      if (!r1.ok) part1++;
      if (Math.abs(r0.L - r1.L) > 0.5) { diff++; sumd += r0.L - r1.L; }
    }
    out.push(`300 random mirrored pairs: length differs in ${diff} (sum ${sumd.toFixed(0)}), partial (cap) ${part0} vs ${part1}`);
    console.log(`== ${map}\n  ` + out.join('\n  '));
  }
});
