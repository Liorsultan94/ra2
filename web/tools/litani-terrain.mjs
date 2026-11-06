#!/usr/bin/env node
// Builds the real-terrain data of the Litani river mouth map (map id 'frontline', src/sim/litani.ts) and writes
// src/sim/litanidata.ts. Run from web/:
//
//   node tools/litani-terrain.mjs [--cache DIR] [--debug out.png]
//
// Sources (downloaded, cached in --cache, default ./.litani-cache, never committed):
//  - elevation: AWS Terrain Tiles, terrarium encoding, zoom 15 (SRTM-based; height = R*256 + G + B/256 - 32768 m)
//    https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png
//  - the coastline, the Litani's course and banks, roads, bridges, buildings, land use and place names:
//    OpenStreetMap (API 0.6 map calls), (c) OpenStreetMap contributors, ODbL.
//
// The map window: a square of N x N tiles at M metres per tile (the game's scale, render/podmath.ts M_PER_TILE),
// centred on CENTER and turned so the decks of the two real highway bridges over the Litani (the coastal road's
// Qasmiyeh bridge and the motorway's) run along the engine's bridge direction, tile (1, -1) (screen east): tile +x
// points to bearing DECK + 45, tile +y to bearing DECK + 135. That puts the sea at the top of the screen and the
// river running up the screen into it.
//
// Output (all deterministic from the downloaded data; the game never touches the network):
//  - elev: vertex heights (N + 1)^2, Int16 decimetres above sea level (area-averaged over each vertex's cell);
//  - sea: vertex signed distance to the coastline (tiles, > 0 = sea), Int8 in quarter tiles;
//  - river: vertex signed distance to the Litani's banks (tiles, > 0 = in the river), Int8 in tenths of a tile;
//  - cover: per tile, land use class (3 bits) and building coverage (5 bits);
//  - vectors in map coordinates: the river's centreline, roads by class, the bridges over the Litani, places.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// ------------------------------------------------------------------ window
const CENTER = { lat: +(process.env.LAT ?? 33.3281), lon: +(process.env.LON ?? 35.2511) };
const N = +(process.env.N ?? 104);
const M = 35;
/** Bearing (degrees) of the engine's bridge deck direction, tile (1, -1): the real decks run N 17-19 E. */
const DECK = 18;
const Z = 15;

const args = process.argv.slice(2);
const opt = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const CACHE = opt('--cache', '.litani-cache');
const DEBUG = opt('--debug', null);
const OUT = opt('--out', 'src/sim/litanidata.ts');
fs.mkdirSync(CACHE, { recursive: true });

const rad = (d) => (d * Math.PI) / 180;
const phi = rad(CENTER.lat);
const M_LAT = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi);
const M_LON = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi);
const BX = rad(DECK + 45);
const BY = rad(DECK + 135);
/** Map point (continuous tile coordinates, 0..N) -> lat / lon. */
function geo(x, y) {
  const u = (x - N / 2) * M;
  const v = (y - N / 2) * M;
  const e = u * Math.sin(BX) + v * Math.sin(BY);
  const n = u * Math.cos(BX) + v * Math.cos(BY);
  return { lat: CENTER.lat + n / M_LAT, lon: CENTER.lon + e / M_LON };
}
/** lat / lon -> map point. */
function toMap(lat, lon) {
  const e = (lon - CENTER.lon) * M_LON;
  const n = (lat - CENTER.lat) * M_LAT;
  return { x: N / 2 + (e * Math.sin(BX) + n * Math.cos(BX)) / M, y: N / 2 + (e * Math.sin(BY) + n * Math.cos(BY)) / M };
}
const corners = [geo(0, 0), geo(N, 0), geo(N, N), geo(0, N)];
const pad = 0.004;
const bbox = {
  s: Math.min(...corners.map((c) => c.lat)) - pad,
  n: Math.max(...corners.map((c) => c.lat)) + pad,
  w: Math.min(...corners.map((c) => c.lon)) - pad,
  e: Math.max(...corners.map((c) => c.lon)) + pad,
};

// ------------------------------------------------------------------ download (cached)
async function get(url, file) {
  const f = path.join(CACHE, file);
  if (fs.existsSync(f) && fs.statSync(f).size > 0) return fs.readFileSync(f);
  for (let a = 0; a < 4; a++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'iron-front-map-tool/1 (litani-terrain.mjs)' } });
      if (!r.ok) throw new Error(`${r.status} ${url}`);
      const b = Buffer.from(await r.arrayBuffer());
      fs.writeFileSync(f, b);
      return b;
    } catch (e) {
      if (a === 3) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (a + 1)));
    }
  }
}

// ------------------------------------------------------------------ PNG (8-bit RGB / RGBA, non-interlaced)
function decodePng(buf) {
  let p = 8;
  let w = 0;
  let h = 0;
  let ct = 0;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const d = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = d.readUInt32BE(0);
      h = d.readUInt32BE(4);
      if (d[8] !== 8 || d[12] !== 0) throw new Error('unsupported png');
      ct = d[9];
    } else if (type === 'IDAT') idat.push(d);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0;
  if (!bpp) throw new Error('unsupported png colour type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * bpp);
  const st = w * bpp;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)];
    const row = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1));
    for (let i = 0; i < st; i++) {
      const a = i >= bpp ? out[y * st + i - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * st + i] : 0;
      const c = i >= bpp && y > 0 ? out[(y - 1) * st + i - bpp] : 0;
      let v = row[i];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a);
        const pb = Math.abs(pp - b);
        const pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * st + i] = v & 255;
    }
  }
  return { w, h, bpp, data: out };
}

function encodePng(w, h, rgb) {
  const crcT = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (b) => {
    let c = -1;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (t, d) => {
    const l = Buffer.alloc(4);
    l.writeUInt32BE(d.length);
    const td = Buffer.concat([Buffer.from(t, 'ascii'), d]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([l, td, c]);
  };
  const ih = Buffer.alloc(13);
  ih.writeUInt32BE(w, 0);
  ih.writeUInt32BE(h, 4);
  ih[8] = 8;
  ih[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) rgb.copy ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3) : 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ elevation
const TS = 256;
const gpx = (lat, lon) => {
  const n = 2 ** Z * TS;
  const s = Math.sin(rad(lat));
  return { x: ((lon + 180) / 360) * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
};
const tiles = new Map();
async function loadDem() {
  const a = gpx(bbox.n, bbox.w);
  const b = gpx(bbox.s, bbox.e);
  for (let ty = Math.floor(a.y / TS); ty <= Math.floor(b.y / TS); ty++)
    for (let tx = Math.floor(a.x / TS); tx <= Math.floor(b.x / TS); tx++) {
      const png = decodePng(await get(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${Z}/${tx}/${ty}.png`, `t${Z}_${tx}_${ty}.png`));
      const h = new Float32Array(TS * TS);
      for (let i = 0; i < TS * TS; i++) h[i] = png.data[i * png.bpp] * 256 + png.data[i * png.bpp + 1] + png.data[i * png.bpp + 2] / 256 - 32768;
      tiles.set(`${tx},${ty}`, h);
    }
}
function demPx(px, py) {
  const tx = Math.floor(px / TS);
  const ty = Math.floor(py / TS);
  const t = tiles.get(`${tx},${ty}`);
  if (!t) throw new Error('dem tile missing ' + tx + ',' + ty);
  return t[(Math.floor(py) - ty * TS) * TS + (Math.floor(px) - tx * TS)];
}
/** Bilinear DEM height at lat / lon. */
function dem(lat, lon) {
  const p = gpx(lat, lon);
  const x = p.x - 0.5;
  const y = p.y - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  return (demPx(x0, y0) * (1 - fx) + demPx(x0 + 1, y0) * fx) * (1 - fy) + (demPx(x0, y0 + 1) * (1 - fx) + demPx(x0 + 1, y0 + 1) * fx) * fy;
}

// ------------------------------------------------------------------ OSM
const nodes = new Map();
const ways = new Map();
const rels = new Map();
const tagsOf = (s) => {
  const t = {};
  for (const m of s.matchAll(/<tag k="([^"]*)" v="([^"]*)"\s*\/>/g)) t[m[1]] = m[2].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'");
  return t;
};
function parseOsm(xml) {
  for (const m of xml.matchAll(/<node ([^>]*?)(\/>|>([\s\S]*?)<\/node>)/g)) {
    const id = /\bid="(\d+)"/.exec(m[1])[1];
    nodes.set(id, { lat: +/\blat="([^"]+)"/.exec(m[1])[1], lon: +/\blon="([^"]+)"/.exec(m[1])[1], tags: m[3] ? tagsOf(m[3]) : {} });
  }
  for (const m of xml.matchAll(/<way ([^>]*?)>([\s\S]*?)<\/way>/g)) {
    const id = /\bid="(\d+)"/.exec(m[1])[1];
    ways.set(id, { id, nds: [...m[2].matchAll(/<nd ref="(\d+)"\s*\/>/g)].map((x) => x[1]), tags: tagsOf(m[2]) });
  }
  for (const m of xml.matchAll(/<relation ([^>]*?)>([\s\S]*?)<\/relation>/g)) {
    const id = /\bid="(\d+)"/.exec(m[1])[1];
    rels.set(id, { id, members: [...m[2].matchAll(/<member type="(\w+)" ref="(\d+)" role="([^"]*)"\s*\/>/g)].map((x) => ({ type: x[1], ref: x[2], role: x[3] })), tags: tagsOf(m[2]) });
  }
}
async function loadOsm() {
  const K = 3;
  for (let j = 0; j < K; j++)
    for (let i = 0; i < K; i++) {
      const w = bbox.w + ((bbox.e - bbox.w) * i) / K;
      const e = bbox.w + ((bbox.e - bbox.w) * (i + 1)) / K;
      const s = bbox.s + ((bbox.n - bbox.s) * j) / K;
      const n = bbox.s + ((bbox.n - bbox.s) * (j + 1)) / K;
      const q = [w, s, e, n].map((v) => v.toFixed(5)).join(',');
      parseOsm((await get(`https://api.openstreetmap.org/api/0.6/map?bbox=${q}`, `osm_${q}.xml`)).toString('utf8'));
    }
  // the Litani's banks (its riverbank multipolygon) in full
  for (const [id, r] of [...rels]) if (r.tags.natural === 'water' && r.tags.water === 'river') parseOsm((await get(`https://api.openstreetmap.org/api/0.6/relation/${id}/full`, `rel_${id}.xml`)).toString('utf8'));
}
const wayPts = (w) => w.nds.map((n) => nodes.get(n)).filter(Boolean).map((n) => toMap(n.lat, n.lon));
/** Merge open ways into rings / lines by shared end nodes. */
function mergeWays(list) {
  const segs = list.map((w) => [...w.nds]);
  const out = [];
  while (segs.length) {
    let cur = segs.shift();
    let grew = true;
    while (grew && cur[0] !== cur[cur.length - 1]) {
      grew = false;
      for (let k = 0; k < segs.length; k++) {
        const s = segs[k];
        if (s[0] === cur[cur.length - 1]) cur = [...cur, ...s.slice(1)];
        else if (s[s.length - 1] === cur[0]) cur = [...s, ...cur.slice(1)];
        else if (s[s.length - 1] === cur[cur.length - 1]) cur = [...cur, ...[...s].reverse().slice(1)];
        else if (s[0] === cur[0]) cur = [...[...s].reverse(), ...cur.slice(1)];
        else continue;
        segs.splice(k, 1);
        grew = true;
        break;
      }
    }
    out.push(cur.map((n) => nodes.get(n)).filter(Boolean).map((n) => toMap(n.lat, n.lon)));
  }
  return out;
}
function inRing(r, x, y) {
  let c = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i];
    const b = r[j];
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
  }
  return c;
}
function segD(px, py, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - a.x - dx * t, py - a.y - dy * t);
}
const ringDist = (rings, x, y) => {
  let d = Infinity;
  for (const r of rings) for (let i = 0; i < r.length - 1; i++) d = Math.min(d, segD(x, y, r[i], r[i + 1]));
  return d;
};
/** Douglas-Peucker. */
function simplify(pts, eps) {
  if (pts.length < 3) return pts;
  let best = 0;
  let k = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segD(pts[i].x, pts[i].y, pts[0], pts[pts.length - 1]);
    if (d > best) (best = d), (k = i);
  }
  if (best <= eps) return [pts[0], pts[pts.length - 1]];
  return [...simplify(pts.slice(0, k + 1), eps).slice(0, -1), ...simplify(pts.slice(k), eps)];
}
/** Clip a polyline to the map square (plus a margin), splitting where it leaves. */
function clipLine(pts, mg = 2) {
  const inside = (p) => p.x >= -mg && p.y >= -mg && p.x <= N + mg && p.y <= N + mg;
  const out = [];
  let run = [];
  pts.forEach((p, i) => {
    if (inside(p) || (i > 0 && inside(pts[i - 1])) || (i < pts.length - 1 && inside(pts[i + 1]))) run.push(p);
    else if (run.length) out.push(run), (run = []);
  });
  if (run.length > 1) out.push(run);
  return out.filter((r) => r.length > 1);
}
/** Line-line intersection of segments ab and cd (null if none). */
function cross(a, b, c, d) {
  const r = { x: b.x - a.x, y: b.y - a.y };
  const s = { x: d.x - c.x, y: d.y - c.y };
  const den = r.x * s.y - r.y * s.x;
  if (Math.abs(den) < 1e-12) return null;
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den;
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? { x: a.x + r.x * t, y: a.y + r.y * t } : null;
}

// ------------------------------------------------------------------ main
await loadDem();
await loadOsm();
console.log(`window centre ${CENTER.lat}, ${CENTER.lon}; corners (x,y)=(0,0) ${fmt(corners[0])} (N,0) ${fmt(corners[1])} (N,N) ${fmt(corners[2])} (0,N) ${fmt(corners[3])}`);
function fmt(c) {
  return `${c.lat.toFixed(5)} N ${c.lon.toFixed(5)} E`;
}
const W1 = N + 1;

// coastline: OSM keeps the land on the left of the way's direction
const coastWays = [...ways.values()].filter((w) => w.tags.natural === 'coastline');
const coast = mergeWays(coastWays);
const coastSD = (x, y) => {
  let best = Infinity;
  let sign = 1;
  for (const r of coast)
    for (let i = 0; i < r.length - 1; i++) {
      const d = segD(x, y, r[i], r[i + 1]);
      if (d < best - 1e-9) {
        best = d;
        const c = (r[i + 1].x - r[i].x) * (y - r[i].y) - (r[i + 1].y - r[i].y) * (x - r[i].x);
        // (map y points "down": the left of the way, seen from above, has c < 0 in these coordinates)
        sign = c > 0 ? 1 : -1;
      }
    }
  return best * sign;
};

// the Litani: its centreline (waterway=river) and its banks (the riverbank multipolygon)
const isLitani = (t) => t.waterway === 'river' && /Litani|الليطاني/.test((t['name:en'] ?? '') + (t.name ?? ''));
const riverLines = mergeWays([...ways.values()].filter((w) => isLitani(w.tags)));
const bankRel = [...rels.values()].find((r) => r.tags.natural === 'water' && r.tags.water === 'river');
const bankOuter = bankRel ? mergeWays(bankRel.members.filter((m) => m.type === 'way' && m.role === 'outer').map((m) => ways.get(m.ref)).filter(Boolean)) : [];
const bankInner = bankRel ? mergeWays(bankRel.members.filter((m) => m.type === 'way' && m.role === 'inner').map((m) => ways.get(m.ref)).filter(Boolean)) : [];
const inBank = (x, y) => bankOuter.some((r) => inRing(r, x, y)) && !bankInner.some((r) => inRing(r, x, y));
const riverSD = (x, y) => {
  const d = ringDist([...bankOuter, ...bankInner], x, y);
  return inBank(x, y) ? d : -d;
};
// the centreline: longest merged line, downstream (ending at the coast)
riverLines.sort((a, b) => b.length - a.length);
let river = riverLines[0];
if (Math.abs(coastSD(river[0].x, river[0].y)) < Math.abs(coastSD(river[river.length - 1].x, river[river.length - 1].y))) river = [...river].reverse();

// land use
const LU = { orchard: 1, greenhouse_horticulture: 2, residential: 3, scrub: 4, forest: 4, wood: 4, beach: 5, farmland: 6, grass: 6, meadow: 6, grassland: 6, brownfield: 7, industrial: 7, construction: 7, cemetery: 7, military: 7 };
const areas = [];
const addArea = (cls, rings, inner = []) => {
  const all = rings.flat();
  if (!all.length) return;
  const bb = { x0: Math.min(...all.map((p) => p.x)), y0: Math.min(...all.map((p) => p.y)), x1: Math.max(...all.map((p) => p.x)), y1: Math.max(...all.map((p) => p.y)) };
  if (bb.x1 < 0 || bb.y1 < 0 || bb.x0 > N || bb.y0 > N) return;
  areas.push({ cls, rings, inner, bb });
};
for (const w of ways.values()) {
  const t = w.tags;
  const cls = LU[t.landuse] ?? LU[t.natural] ?? (t.leisure === 'pitch' ? 7 : 0);
  if (!cls || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
  addArea(cls, [wayPts(w)]);
}
for (const r of rels.values()) {
  const cls = LU[r.tags.landuse] ?? LU[r.tags.natural] ?? 0;
  if (!cls || r.tags.type !== 'multipolygon') continue;
  const get = (role) => mergeWays(r.members.filter((m) => m.type === 'way' && m.role === role).map((m) => ways.get(m.ref)).filter(Boolean));
  addArea(cls, get('outer'), get('inner'));
}
// smaller areas win (an orchard inside a residential area)
areas.sort((a, b) => (b.bb.x1 - b.bb.x0) * (b.bb.y1 - b.bb.y0) - (a.bb.x1 - a.bb.x0) * (a.bb.y1 - a.bb.y0));
// buildings: footprint area (m^2) at the centroid
const bArea = new Float32Array(N * N);
let nBuild = 0;
for (const w of ways.values()) {
  if (!w.tags.building || w.nds[0] !== w.nds[w.nds.length - 1]) continue;
  const p = wayPts(w);
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < p.length - 1; i++) {
    const c = p[i].x * p[i + 1].y - p[i + 1].x * p[i].y;
    a += c;
    cx += (p[i].x + p[i + 1].x) * c;
    cy += (p[i].y + p[i + 1].y) * c;
  }
  if (Math.abs(a) < 1e-9) continue;
  cx /= 3 * a;
  cy /= 3 * a;
  const tx = Math.floor(cx);
  const ty = Math.floor(cy);
  if (tx < 0 || ty < 0 || tx >= N || ty >= N) continue;
  bArea[ty * N + tx] += (Math.abs(a) / 2) * M * M;
  nBuild++;
}

// vertex fields
const elev = new Int16Array(W1 * W1);
const seaQ = new Int8Array(W1 * W1);
const rivQ = new Int8Array(W1 * W1);
const q8 = (v, s) => Math.max(-127, Math.min(127, Math.round(v * s)));
for (let vy = 0; vy <= N; vy++)
  for (let vx = 0; vx <= N; vx++) {
    let s = 0;
    for (let j = 0; j < 4; j++)
      for (let i = 0; i < 4; i++) {
        const g = geo(vx - 0.5 + (i + 0.5) / 4, vy - 0.5 + (j + 0.5) / 4);
        s += dem(g.lat, g.lon);
      }
    elev[vy * W1 + vx] = Math.round((s / 16) * 10);
    seaQ[vy * W1 + vx] = q8(coastSD(vx, vy), 4);
    rivQ[vy * W1 + vx] = q8(riverSD(vx, vy), 10);
  }
// tile cover: the land use class most of the tile's samples fall in; building coverage
const cover = new Uint8Array(N * N);
const hist = new Array(8).fill(0);
for (let ty = 0; ty < N; ty++)
  for (let tx = 0; tx < N; tx++) {
    const votes = new Array(8).fill(0);
    for (let j = 0; j < 3; j++)
      for (let i = 0; i < 3; i++) {
        const x = tx + (i + 0.5) / 3;
        const y = ty + (j + 0.5) / 3;
        let c = 0;
        for (const a of areas) {
          if (x < a.bb.x0 || x > a.bb.x1 || y < a.bb.y0 || y > a.bb.y1) continue;
          if (a.rings.some((r) => inRing(r, x, y)) && !a.inner.some((r) => inRing(r, x, y))) c = a.cls;
        }
        votes[c]++;
      }
    let cls = 0;
    for (let k = 1; k < 8; k++) if (votes[k] > votes[cls] || (cls === 0 && votes[k] >= 4)) cls = k;
    const b = Math.min(31, Math.round((bArea[ty * N + tx] / (M * M)) * 31 * 1.6));
    cover[ty * N + tx] = cls | (b << 3);
    hist[cls]++;
  }

// roads by class (0 motorway, 1 trunk / primary, 2 secondary / tertiary, 3 unclassified / residential, 4 track)
const RC = { motorway: 0, motorway_link: 0, trunk: 1, trunk_link: 1, primary: 1, primary_link: 1, secondary: 2, tertiary: 2, secondary_link: 2, tertiary_link: 2, unclassified: 3, residential: 3, living_street: 3, service: 4, track: 4 };
const roadWays = [...ways.values()].filter((w) => RC[w.tags.highway] !== undefined);
const roads = [];
for (const cls of [0, 1, 2, 3]) {
  // merge each class's ways with the same name / ref into long lines (bridges are separate ways in OSM)
  const groups = new Map();
  for (const w of roadWays) {
    if (RC[w.tags.highway] !== cls) continue;
    const key = (w.tags.ref ?? '') + '|' + (w.tags['name:en'] ?? w.tags.name ?? (cls >= 3 ? 'x' : w.id));
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(w);
  }
  for (const [key, list] of groups)
    for (const line of mergeWays(list))
      for (const part of clipLine(line)) {
        const s = simplify(part, cls >= 3 ? 0.35 : 0.25);
        let len = 0;
        for (let i = 0; i < s.length - 1; i++) len += Math.hypot(s[i + 1].x - s[i].x, s[i + 1].y - s[i].y);
        if (len < (cls >= 3 ? 4 : 2)) continue;
        roads.push({ cls, name: key.split('|')[1].length > 1 && !/^\d+$/.test(key.split('|')[1]) ? key.split('|')[1] : '', ref: key.split('|')[0], pts: s });
      }
}
// bridges over the Litani: OSM bridge ways that cross its centreline
const bridges = [];
for (const w of roadWays) {
  if (!w.tags.bridge) continue;
  const p = wayPts(w);
  for (let i = 0; i < p.length - 1; i++)
    for (let k = 0; k < river.length - 1; k++) {
      const c = cross(p[i], p[i + 1], river[k], river[k + 1]);
      if (!c) continue;
      const g0 = nodes.get(w.nds[i]);
      const g1 = nodes.get(w.nds[i + 1]);
      const brg = (Math.atan2((g1.lon - g0.lon) * M_LON, (g1.lat - g0.lat) * M_LAT) * 180) / Math.PI;
      bridges.push({ x: c.x, y: c.y, cls: RC[w.tags.highway], name: w.tags['name:en'] ?? w.tags.name ?? '', ref: w.tags.ref ?? '', bearing: (brg + 360) % 180, osm: w.id });
    }
}
// places in the window (OSM place nodes)
const places = [];
for (const n of nodes.values()) {
  if (!n.tags.place || !n.tags.name) continue;
  const p = toMap(n.lat, n.lon);
  places.push({ name: n.tags['name:en'] ?? n.tags.name, ar: n.tags.name, kind: n.tags.place, x: p.x, y: p.y, inside: p.x >= 0 && p.y >= 0 && p.x <= N && p.y <= N });
}
const riverIn = clipLine(river, 3).flat();
const riverOut = simplify(riverIn, 0.15);

// ------------------------------------------------------------------ write
const b64 = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength).toString('base64');
const r2 = (v) => Math.round(v * 100) / 100;
const pts = (l) => l.map((p) => [r2(p.x), r2(p.y)]);
let elevMin = Infinity;
let elevMax = -Infinity;
for (const v of elev) (elevMin = Math.min(elevMin, v)), (elevMax = Math.max(elevMax, v));
const today = new Date().toISOString().slice(0, 10);
const ts = `// GENERATED by tools/litani-terrain.mjs (${today}) - do not edit by hand.
//
// The Litani river mouth, south Lebanon: real terrain for map id 'frontline' (src/sim/litani.ts).
// Elevation: AWS Terrain Tiles (terrarium, zoom ${Z}; SRTM-based, attribution recommended: Mapzen / AWS Open Data / NASA SRTM).
// Coastline, river, roads, bridges, buildings, land use and names: (c) OpenStreetMap contributors, ODbL 1.0.
// Window: ${N} x ${N} tiles of ${M} m, centre ${CENTER.lat} N ${CENTER.lon} E, tile (1, -1) at bearing ${DECK} deg.
//   (0, 0) ${fmt(corners[0])}; (${N}, 0) ${fmt(corners[1])}; (${N}, ${N}) ${fmt(corners[2])}; (0, ${N}) ${fmt(corners[3])}.
// Elevation range ${(elevMin / 10).toFixed(1)} .. ${(elevMax / 10).toFixed(1)} m.

/** Vertex heights (${N + 1}^2, row-major), Int16 decimetres above sea level. */
export const LITANI_ELEV = '${b64(elev)}';
/** Vertex signed distance to the coastline (tiles, > 0 = sea), Int8 in quarter tiles. */
export const LITANI_SEA = '${b64(seaQ)}';
/** Vertex signed distance to the Litani's banks (tiles, > 0 = in the river), Int8 in tenths of a tile. */
export const LITANI_RIVER = '${b64(rivQ)}';
/** Per tile: land use (bits 0-2: 0 open, 1 orchard, 2 greenhouses, 3 residential, 4 scrub / wood, 5 beach, 6 farmland / grass, 7 other) and building coverage (bits 3-7, 0..31). */
export const LITANI_COVER = '${b64(cover)}';
export const LITANI_N = ${N};
/** The window: centre, metres per tile, bearing of tile (1, -1), corners (lat, lon) of (0,0), (N,0), (N,N), (0,N). */
export const LITANI_WINDOW = ${JSON.stringify({ lat: CENTER.lat, lon: CENTER.lon, m: M, deck: DECK, corners: corners.map((c) => [+c.lat.toFixed(6), +c.lon.toFixed(6)]) })};
/** The Litani's centreline (map coordinates, downstream: from the east edge to the mouth). */
export const LITANI_COURSE: [number, number][] = ${JSON.stringify(pts(riverOut))};
/** Roads (map coordinates): class 0 motorway, 1 trunk / primary, 2 secondary / tertiary, 3 local, 4 track / service. */
export const LITANI_ROADS: { cls: number; name: string; ref: string; pts: [number, number][] }[] = ${JSON.stringify(roads.map((r) => ({ cls: r.cls, name: r.name, ref: r.ref, pts: pts(r.pts) })))};
/** OSM bridges over the Litani (map coordinates; bearing of the deck, degrees 0..180). */
export const LITANI_BRIDGES: { x: number; y: number; cls: number; name: string; ref: string; bearing: number }[] = ${JSON.stringify(bridges.map((b) => ({ x: r2(b.x), y: r2(b.y), cls: b.cls, name: b.name, ref: b.ref, bearing: Math.round(b.bearing) })))};
/** OSM places (map coordinates; outside the window too, for reference). */
export const LITANI_PLACES: { name: string; kind: string; x: number; y: number }[] = ${JSON.stringify(places.filter((p) => p.x > -40 && p.y > -40 && p.x < N + 40 && p.y < N + 40).map((p) => ({ name: p.name, kind: p.kind, x: r2(p.x), y: r2(p.y) })))};
`;
fs.writeFileSync(OUT, ts);
console.log(`wrote ${OUT} (${(ts.length / 1024).toFixed(1)} KB); elevation ${elevMin / 10}..${elevMax / 10} m; buildings ${nBuild}; land use tiles`, hist, `; roads ${roads.length}; bridges`, bridges, '; places', places.filter((p) => p.inside));

{
  let sea = 0;
  let deep = 0;
  for (const v of seaQ) (sea += v > 0 ? 1 : 0), (deep += v > 12 ? 1 : 0);
  console.log(`sea vertices ${sea}, > 3 tiles offshore ${deep}; river course ends`, riverOut[0], riverOut[riverOut.length - 1]);
}
if (DEBUG) {
  const S = 6;
  const img = Buffer.alloc(N * S * N * S * 3);
  for (let py = 0; py < N * S; py++)
    for (let px = 0; px < N * S; px++) {
      const x = px / S;
      const y = py / S;
      const vx = Math.min(N, Math.round(x));
      const vy = Math.min(N, Math.round(y));
      const e = elev[vy * W1 + vx] / 10;
      const c = cover[Math.min(N - 1, Math.floor(y)) * N + Math.min(N - 1, Math.floor(x))];
      let col = [90 + e * 1.3, 120 + e * 1.0, 60 + e * 0.8];
      const cls = c & 7;
      if (cls === 1) col = [40, 110, 40];
      if (cls === 2) col = [230, 230, 240];
      if (cls === 3) col = [170, 150, 130];
      if (cls === 4) col = [110, 120, 70];
      if (cls === 5) col = [230, 210, 150];
      if (cls === 6) col = [150, 170, 80];
      if (c >> 3 > 6) col = [120, 60, 60];
      if (seaQ[vy * W1 + vx] > 0) col = [20, 60, 140];
      if (rivQ[vy * W1 + vx] > 0) col = [40, 140, 220];
      const o = (py * N * S + px) * 3;
      img[o] = Math.max(0, Math.min(255, col[0]));
      img[o + 1] = Math.max(0, Math.min(255, col[1]));
      img[o + 2] = Math.max(0, Math.min(255, col[2]));
    }
  const plot = (l, col) => {
    for (let i = 0; i < l.length - 1; i++) {
      const n = Math.ceil(Math.hypot(l[i + 1].x - l[i].x, l[i + 1].y - l[i].y) * S * 2);
      for (let k = 0; k <= n; k++) {
        const x = Math.round((l[i].x + ((l[i + 1].x - l[i].x) * k) / n) * S);
        const y = Math.round((l[i].y + ((l[i + 1].y - l[i].y) * k) / n) * S);
        if (x < 0 || y < 0 || x >= N * S || y >= N * S) continue;
        const o = (y * N * S + x) * 3;
        img[o] = col[0];
        img[o + 1] = col[1];
        img[o + 2] = col[2];
      }
    }
  };
  for (const r of roads) plot(r.pts, [[255, 0, 0], [255, 80, 0], [255, 170, 0], [250, 240, 120], [200, 200, 200]][r.cls]);
  plot(riverOut, [0, 255, 255]);
  for (const b of bridges) plot([{ x: b.x - 1, y: b.y - 1 }, { x: b.x + 1, y: b.y + 1 }, { x: b.x - 1, y: b.y + 1 }, { x: b.x + 1, y: b.y - 1 }], [255, 0, 255]);
  for (const p of places) if (p.inside) plot([{ x: p.x - 1.5, y: p.y }, { x: p.x + 1.5, y: p.y }, { x: p.x, y: p.y - 1.5 }, { x: p.x, y: p.y + 1.5 }], [0, 0, 0]);
  fs.writeFileSync(DEBUG, encodePng(N * S, N * S, img));
}
