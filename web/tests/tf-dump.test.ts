import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { createMap } from '../src/sim/maps';
import type { MapId } from '../src/sim/map';
import { buildLayout } from '../src/render/layout';
import { buildRoadNet, netInput, onSurface, pointAt } from '../src/render/ambient/roadnet';
import { Driver, newDriveCar, type DriveCar } from '../src/render/ambient/driver';
const D = Math.SQRT1_2;
function rng(seed: number) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const ID = (process.env.TFMAP || 'winter') as MapId; const CAR = +(process.env.TFCAR || 2); const T0 = +(process.env.TFT0 || 5); const T1 = +(process.env.TFT1 || 11);
it('dump', () => {
  const m = createMap(ID, 1);
  const br = m.bridges.map((b) => ({ ends: [{ x: b.x - (b.length / 2) * D, y: b.y + (b.length / 2) * D }, { x: b.x + (b.length / 2) * D, y: b.y - (b.length / 2) * D }] }));
  const n = buildRoadNet(netInput(m, buildLayout(m), br));
  const rand = rng(+(process.env.TFSEED || 7) + ID.length);
  const drv = new Driver(n, () => true, rand);
  type SimCar = DriveCar & { driving: boolean; id: number };
  const list: SimCar[] = []; let id = 0;
  const spawn = () => {
    const lines = n.lines.filter((L) => L.bridge < 0 && L.a1 - L.a0 > 1.5);
    for (let tries = 0; tries < 50; tries++) {
      const li = n.lines.indexOf(lines[Math.floor(rand() * lines.length)]);
      const L = n.lines[li];
      const arc = L.a0 + 0.5 + rand() * (L.a1 - L.a0 - 1);
      const dir = rand() < 0.5 ? 1 : -1;
      const p = pointAt(L, arc);
      const x = p.x - p.ty * dir * L.lane; const y = p.y + p.tx * dir * L.lane;
      if (!onSurface(n, x, y) || n.loops.some((lp) => Math.hypot(lp.x - x, lp.y - y) < lp.R + 0.3)) continue;
      if (n.nodes.some((nd) => nd.arms.length > 1 && Math.hypot(nd.x - x, nd.y - y) < 2.5)) continue;
      if (list.some((o) => Math.hypot(o.x - x, o.y - y) < 1.2)) continue;
      const kind = L.paved ? Math.floor(rand() * 3) : 3;
      const c = newDriveCar(kind, kind === 1 ? 0.56 : 0.5, li, arc, dir, x, y, Math.atan2(p.ty * dir, p.tx * dir), [1.25, 1.05, 1.1, 0.5][kind] * (L.paved ? 1 : 0.62)) as SimCar;
      c.driving = true; c.id = id++; list.push(c); return;
    }
  };
  for (let i = 0; i < +(process.env.TFN || 18); i++) spawn();
  const tr: string[] = []; const pts: [number, number, number][] = [];
  for (let t = 0; t < T1; t += 0.05) {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      drv.step(c, list, t, 0.05);
      if (c.id === CAR && t >= T0) { pts.push([c.x, c.y, onSurface(n, c.x, c.y) ? 1 : 0]); tr.push(`${t.toFixed(2)} ${c.x.toFixed(2)},${c.y.toFixed(2)} yaw ${c.yaw.toFixed(2)} v ${c.v.toFixed(2)} line ${c.line} arc ${c.arc.toFixed(2)} dir ${c.dir} loop ${c.loop} kt ${c.kt} plan ${c.planNode}/${c.plan} ${onSurface(n, c.x, c.y) ? '' : 'OFF'}`); }
      const L = n.lines[c.line];
      if (c.loop < 0 && !c.kt && ((c.dir > 0 && L.portal[1] && c.arc > L.len - 0.3) || (c.dir < 0 && L.portal[0] && c.arc < 0.3))) { list.splice(i, 1); spawn(); }
    }
  }
  console.log(tr.join('\n'));
  for (const c of list) console.log('END car', c.id, c.x.toFixed(1), c.y.toFixed(1), 'v', c.v.toFixed(2), 'line', c.line, 'arc', c.arc.toFixed(1), 'dir', c.dir, 'loop', c.loop, 'kt', c.kt, 'wait', c.waiting, c.waitT.toFixed(1), 'plan', c.planNode, c.plan, 'kind', c.kind);
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length, cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  const S = 60, half = 6;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * half * S}" height="${2 * half * S}" style="background:#cdb">`;
  for (let y = cy - half; y < cy + half; y += 0.25) for (let x = cx - half; x < cx + half; x += 0.25) {
    const gx = Math.floor(x * 4) / 4, gy = Math.floor(y * 4) / 4;
    if (onSurface(n, gx + 0.1, gy + 0.1)) svg += `<rect x="${(gx - cx + half) * S}" y="${(gy - cy + half) * S}" width="${S / 4}" height="${S / 4}" fill="#999"/>`;
  }
  n.lines.forEach((L) => { svg += `<polyline fill="none" stroke="#000" stroke-width="1" points="${L.pts.map((p) => `${(p.x - cx + half) * S},${(p.y - cy + half) * S}`).join(' ')}"/>`; });
  for (const nd of n.nodes) svg += `<circle cx="${(nd.x - cx + half) * S}" cy="${(nd.y - cy + half) * S}" r="6" fill="#f0f"/>`;
  for (const lp of n.loops) svg += `<circle cx="${(lp.x - cx + half) * S}" cy="${(lp.y - cy + half) * S}" r="${lp.R * S}" fill="none" stroke="#0a0"/>`;
  for (const p of pts) svg += `<circle cx="${(p[0] - cx + half) * S}" cy="${(p[1] - cy + half) * S}" r="2" fill="${p[2] ? '#00f' : '#f00'}"/>`;
  writeFileSync('/tmp/claude-0/TF/TF-dbg.svg', svg + '</svg>');
});
