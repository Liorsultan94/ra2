// SN1 design aid: the Sinai map drawn top-down in screen orientation (north up: the map's top corner), tiles
// coloured by kind and shaded by height, with the starts, ore, oil, structures, tech sites and roads.
// BENCH=1 OUT=/tmp/x.png SEED=1 npx vitest run bench/sinai-view.test.ts
import { it } from 'vitest';
import { writeFileSync } from 'fs';
import { deflateSync } from 'zlib';
import { Tile, groundHeight } from '../src/sim/map';
import { World } from '../src/sim/world';
import { neutralSites } from '../src/sim/capture';

function png(w: number, h: number, rgb: Uint8Array) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w * 3; x++) raw[y * (w * 3 + 1) + 1 + x] = rgb[y * w * 3 + x];
  }
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b: Buffer) => {
    let c = -1;
    for (const v of b) c = crcT[(c ^ v) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t: string, d: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const hdr = Buffer.alloc(13);
  hdr.writeUInt32BE(w, 0);
  hdr.writeUInt32BE(h, 4);
  hdr[8] = 8;
  hdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', hdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

it('sinai view', () => {
  const seed = Number(process.env.SEED ?? 1);
  const w = new World({ seed, map: 'desert', players: [{ name: 'a', faction: 'usa', color: 0, isAI: true }, { name: 'b', faction: 'russia', color: 0, isAI: true }] });
  const m = w.map;
  const N = m.w;
  const PX = Number(process.env.PX ?? 4);
  const D = N / Math.SQRT2;
  const [E0, S0, SZ] = (process.env.CROP ?? `${-D},0,${2 * D}`).split(",").map(Number);
  const S = Math.ceil(SZ * PX);
  const img = new Uint8Array(S * S * 3);
  const col: Record<number, [number, number, number]> = {
    [Tile.Sand]: [222, 196, 140],
    [Tile.Dirt]: [190, 160, 118],
    [Tile.Grass]: [140, 160, 80],
    [Tile.Water]: [40, 110, 170],
    [Tile.Rock]: [110, 92, 84],
    [Tile.Bridge]: [255, 0, 255],
  };
  const sites = neutralSites(m);
  const occ = new Uint8Array(N * N);
  for (const s of sites) for (let y = s.y; y < s.y + s.h; y++) for (let x = s.x; x < s.x + s.w; x++) occ[y * N + x] = s.def === 'oil' ? 1 : 2;
  const roadT = new Uint8Array(N * N);
  for (const r of m.roads)
    for (let k = 0; k < r.length - 1; k++) {
      const a = r[k];
      const b = r[k + 1];
      const L = Math.hypot(b.x - a.x, b.y - a.y);
      for (let t = 0; t <= L; t += 0.3) {
        const x = Math.round(a.x + ((b.x - a.x) * t) / L);
        const y = Math.round(a.y + ((b.y - a.y) * t) / L);
        if (x >= 0 && y >= 0 && x < N && y < N) roadT[y * N + x] = 1;
      }
    }
  for (let py = 0; py < S; py++)
    for (let px = 0; px < S; px++) {
      const e = E0 + px / PX;
      const s = S0 + py / PX;
      const x = (s + e) / Math.SQRT2;
      const y = (s - e) / Math.SQRT2;
      const o = (py * S + px) * 3;
      if (x < 0 || y < 0 || x >= N || y >= N) {
        img[o] = img[o + 1] = img[o + 2] = 30;
        continue;
      }
      const tx = Math.floor(x);
      const ty = Math.floor(y);
      const i = ty * N + tx;
      let c = col[m.tiles[i]] ?? [255, 0, 0];
      if (m.ore[i]) c = m.oreKind[i] === 2 ? [80, 220, 230] : [230, 200, 40];
      if (m.trees[i]) c = [40, 110, 40];
      if (roadT[i]) c = [90, 90, 96];
      if (m.blocked[i]) c = [245, 245, 240];
      if (occ[i] === 1) c = [20, 20, 20];
      if (occ[i] === 2) c = [200, 60, 200];
      if (m.offshore?.[i]) c = [c[0], c[1] * 0.7, c[2]];
      // vehicles cannot get here (slopes): violet; soldiers neither: red
      if (w.pass[i] && w.regions[1][i] !== w.mainlands[1]) c = w.regions[0][i] === w.mainlands[0] ? [170, 90, 220] : [230, 30, 30];
      // a vehicle step out of this tile is too steep: darken
      if (w.pass[i] && w.regions[1][i] === w.mainlands[1] && (w.slope.block[1][i] & 15)) c = [c[0] * 0.75, c[1] * 0.75, c[2] * 0.9];
      if (!w.pass[i] && m.tiles[i] !== Tile.Water && m.tiles[i] !== Tile.Rock && !m.blocked[i] && !occ[i] && !m.trees[i]) c = [255, 120, 0];
      const h = groundHeight(m, x, y);
      const hx = groundHeight(m, Math.min(N - 0.01, x + 0.3), y) - h;
      const hy = groundHeight(m, x, Math.min(N - 0.01, y + 0.3)) - h;
      const shade = Math.max(0.35, Math.min(1.5, 1 + (-hx - hy) * 3));
      if (m.tiles[i] !== Tile.Water && h > 0.9) {
        const k = Math.min(1, (h - 0.9) / 5);
        c = [c[0] * (1 - k) + 120 * k, c[1] * (1 - k) + 70 * k, c[2] * (1 - k) + 60 * k];
      }
      for (let k = 0; k < 3; k++) img[o + k] = Math.max(0, Math.min(255, c[k] * shade));
    }
  const dot = (x: number, y: number, r: number, c: [number, number, number]) => {
    const e = (x - y) / Math.SQRT2 + D;
    const s = (x + y) / Math.SQRT2;
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const px = Math.round((e - D - E0) * PX) + dx;
        const py = Math.round((s - S0) * PX) + dy;
        if (px < 0 || py < 0 || px >= S || py >= S || dx * dx + dy * dy > r * r) continue;
        const o = (py * S + px) * 3;
        img[o] = c[0];
        img[o + 1] = c[1];
        img[o + 2] = c[2];
      }
  };
  dot(m.starts[0].x + 0.5, m.starts[0].y + 0.5, 3 * PX, [40, 90, 255]);
  dot(m.starts[1].x + 0.5, m.starts[1].y + 0.5, 3 * PX, [230, 40, 40]);
  for (const l of m.lanes ?? []) dot(l.x + 0.5, l.y + 0.5, PX, [255, 255, 0]);
  writeFileSync(process.env.OUT ?? '/tmp/sinai.png', png(S, S, img));
  // numbers
  const len = (p: number[], sx: number, sy: number) => {
    let L = 0;
    let x = sx;
    let y = sy;
    for (const t of p) {
      const tx = t % N;
      const ty = Math.floor(t / N);
      L += Math.hypot(tx - x, ty - y);
      x = tx;
      y = ty;
    }
    return L;
  };
  const s0 = m.starts[0];
  const s1 = m.starts[1];
  const p01 = w.pf.find(s0.x, s0.y, s1.x, s1.y, 2000000);
  const p10 = w.pf.find(s1.x, s1.y, s0.x, s0.y, 2000000);
  console.log(`start->start ${len(p01, s0.x, s0.y).toFixed(1)} (${p01[p01.length - 1] === s1.y * N + s1.x}) / ${len(p10, s1.x, s1.y).toFixed(1)} (${p10[p10.length - 1] === s0.y * N + s0.x})`);
  console.log(`structures ${m.structures.length}, sites ${sites.map((s) => s.def + '@' + s.x + ',' + s.y).join(' ')}`);
});
