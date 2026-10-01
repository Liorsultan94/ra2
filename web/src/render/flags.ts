/*
 * Real national flags drawn with Canvas 2D, following each flag's official
 * construction sheet (proportions, star and emblem placement). Every flag is
 * fitted into whatever w x h box it is given; the UI and the waving flags on
 * buildings both use a 3:2 box.
 */

const TAU = Math.PI * 2;

type Ctx = CanvasRenderingContext2D;

function bands(c: Ctx, w: number, h: number, cols: string[], vertical = false) {
  const n = cols.length;
  cols.forEach((col, i) => {
    c.fillStyle = col;
    if (vertical) c.fillRect((i * w) / n, 0, w / n + 1, h);
    else c.fillRect(0, (i * h) / n, w, h / n + 1);
  });
}

/** Filled five-pointed star; `rot` 0 points up. */
function star(c: Ctx, x: number, y: number, r: number, rot = 0) {
  const inner = r * 0.382;
  c.beginPath();
  for (let k = 0; k < 10; k++) {
    const rr = k % 2 ? inner : r;
    const a = rot - Math.PI / 2 + (k / 10) * TAU;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (k) c.lineTo(px, py);
    else c.moveTo(px, py);
  }
  c.closePath();
  c.fill();
}

function usa(c: Ctx, w: number, h: number) {
  for (let i = 0; i < 13; i++) {
    c.fillStyle = i % 2 ? '#ffffff' : '#b22234';
    c.fillRect(0, (i * h) / 13, w, h / 13 + 1);
  }
  const cw = w * 0.4;
  const ch = (h * 7) / 13;
  c.fillStyle = '#3c3b6e';
  c.fillRect(0, 0, cw, ch);
  c.fillStyle = '#ffffff';
  const r = h * 0.0308;
  for (let i = 0; i < 9; i++) {
    const y = ((i + 1) * ch) / 10;
    const n = i % 2 ? 5 : 6;
    for (let j = 0; j < n; j++) {
      const x = ((i % 2 ? 2 * j + 2 : 2 * j + 1) * cw) / 12;
      star(c, x, y, r);
    }
  }
}

function israel(c: Ctx, w: number, h: number) {
  // 220 x 160 sheet: stripes 25 high, 15 from the edges; hexagram outline
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#0038b8';
  c.fillRect(0, (h * 15) / 160, w, (h * 25) / 160);
  c.fillRect(0, (h * 120) / 160, w, (h * 25) / 160);
  c.strokeStyle = '#0038b8';
  c.lineWidth = (h * 5.5) / 160;
  c.lineJoin = 'miter';
  const R = (h * 30) / 160;
  for (const r0 of [-Math.PI / 2, Math.PI / 2]) {
    c.beginPath();
    for (let k = 0; k < 3; k++) {
      const a = r0 + (k / 3) * TAU;
      const x = w / 2 + Math.cos(a) * R;
      const y = h / 2 + Math.sin(a) * R;
      if (k) c.lineTo(x, y);
      else c.moveTo(x, y);
    }
    c.closePath();
    c.stroke();
  }
}

function china(c: Ctx, w: number, h: number) {
  c.fillStyle = '#ee1c25';
  c.fillRect(0, 0, w, h);
  c.fillStyle = '#ffff00';
  // 30 x 20 grid
  const ux = w / 30;
  const uy = h / 20;
  const u = Math.min(ux, uy);
  star(c, 5 * ux, 5 * uy, 3 * u);
  for (const [gx, gy] of [
    [10, 2],
    [12, 4],
    [12, 7],
    [10, 9],
  ]) {
    // each small star points one tip at the centre of the large star
    const rot = Math.atan2(5 * uy - gy * uy, 5 * ux - gx * ux) + Math.PI / 2;
    star(c, gx * ux, gy * uy, u, rot);
  }
}

function korea(c: Ctx, w: number, h: number) {
  c.fillStyle = '#ffffff';
  c.fillRect(0, 0, w, h);
  const cx = w / 2;
  const cy = h / 2;
  const R = h / 4;
  const tilt = Math.atan2(2, 3);
  // taegeuk: red above, blue below, red head on the hoist side
  c.save();
  c.translate(cx, cy);
  c.rotate(tilt);
  c.fillStyle = '#0047a0';
  c.beginPath();
  c.arc(0, 0, R, 0, TAU);
  c.fill();
  c.fillStyle = '#cd2e3a';
  c.beginPath();
  c.arc(0, 0, R, Math.PI, TAU);
  c.fill();
  c.beginPath();
  c.arc(-R / 2, 0, R / 2, 0, TAU);
  c.fill();
  c.fillStyle = '#0047a0';
  c.beginPath();
  c.arc(R / 2, 0, R / 2, 0, TAU);
  c.fill();
  c.restore();
  // trigrams on the diagonals: geon (top-left), gam (top-right), ri (bottom-left), gon (bottom-right)
  const bar = h / 24;
  const gap = h / 48;
  const len = h / 4;
  const start = (3 * h) / 8;
  const trig: [number, number, boolean[]][] = [
    [-3, -2, [false, false, false]],
    [3, -2, [true, false, true]],
    [-3, 2, [false, true, false]],
    [3, 2, [true, true, true]],
  ];
  c.fillStyle = '#000000';
  for (const [dx, dy, broken] of trig) {
    c.save();
    c.translate(cx, cy);
    c.rotate(Math.atan2(dy, dx));
    for (let k = 0; k < 3; k++) {
      const x = start + k * (bar + gap);
      if (broken[k]) {
        c.fillRect(x, -len / 2, bar, len / 2 - gap / 2);
        c.fillRect(x, gap / 2, bar, len / 2 - gap / 2);
      } else c.fillRect(x, -len / 2, bar, len);
    }
    c.restore();
  }
}

function turkey(c: Ctx, w: number, h: number) {
  // construction sheet in units of the hoist G
  const G = h;
  c.fillStyle = '#e30a17';
  c.fillRect(0, 0, w, h);
  const sx = w / (1.5 * G); // stretch if the box isn't 3:2
  const cy = h / 2;
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.ellipse(0.5 * G * sx, cy, 0.25 * G * sx, 0.25 * G, 0, 0, TAU);
  c.fill();
  c.fillStyle = '#e30a17';
  c.beginPath();
  c.ellipse(0.5625 * G * sx, cy, 0.2 * G * sx, 0.2 * G, 0, 0, TAU);
  c.fill();
  c.fillStyle = '#ffffff';
  c.save();
  c.translate(0.8333 * G * sx, cy);
  c.scale(sx, 1);
  // one point aims at the crescent
  star(c, 0, 0, 0.125 * G, -Math.PI / 2);
  c.restore();
}

function iran(c: Ctx, w: number, h: number) {
  bands(c, w, h, ['#239f40', '#ffffff', '#da0000']);
  // stylised takbir (Kufic script) bands along the white stripe's edges
  const n = 11;
  const sw = w / n;
  const th = h / 3;
  for (let i = 0; i < n; i++) {
    const x = i * sw;
    c.fillStyle = '#ffffff';
    c.fillRect(x + sw * 0.15, th - h * 0.035, sw * 0.7, h * 0.012);
    c.fillRect(x + sw * 0.15, th - h * 0.05, sw * 0.08, h * 0.027);
    c.fillRect(x + sw * 0.5, th - h * 0.05, sw * 0.08, h * 0.027);
    c.fillRect(x + sw * 0.15, 2 * th + h * 0.023, sw * 0.7, h * 0.012);
    c.fillRect(x + sw * 0.15, 2 * th + h * 0.023, sw * 0.08, h * 0.027);
    c.fillRect(x + sw * 0.5, 2 * th + h * 0.023, sw * 0.08, h * 0.027);
  }
  // central emblem: four crescents around a sword with a shadda on top
  const cx = w / 2;
  const cy = h / 2;
  const s = h * 0.13;
  c.fillStyle = '#da0000';
  c.strokeStyle = '#da0000';
  c.lineCap = 'round';
  c.lineWidth = s * 0.16;
  for (const side of [-1, 1]) {
    for (const [r, off] of [
      [s * 0.95, 0.15],
      [s * 0.62, 0.32],
    ] as const) {
      c.beginPath();
      if (side < 0) c.arc(cx + s * off, cy + s * 0.05, r, Math.PI * 0.62, Math.PI * 1.38);
      else c.arc(cx - s * off, cy + s * 0.05, r, -Math.PI * 0.38, Math.PI * 0.38);
      c.stroke();
    }
  }
  c.lineWidth = s * 0.2;
  c.beginPath();
  c.moveTo(cx, cy - s * 0.85);
  c.lineTo(cx, cy + s * 0.95);
  c.stroke();
  c.lineWidth = s * 0.1;
  c.beginPath();
  c.moveTo(cx - s * 0.18, cy - s * 0.95);
  c.lineTo(cx - s * 0.06, cy - s * 1.1);
  c.lineTo(cx + s * 0.06, cy - s * 0.95);
  c.lineTo(cx + s * 0.18, cy - s * 1.1);
  c.stroke();
}

const DRAW: Record<string, (c: Ctx, w: number, h: number) => void> = {
  usa,
  israel,
  china,
  korea,
  turkey,
  iran,
  russia: (c, w, h) => bands(c, w, h, ['#ffffff', '#0039a6', '#d52b1e']),
  germany: (c, w, h) => bands(c, w, h, ['#000000', '#dd0000', '#ffce00']),
  ukraine: (c, w, h) => bands(c, w, h, ['#0057b7', '#ffd700']),
};

/** Draw the faction's national flag into the box; returns false for unknown factions. */
export function drawFlag(c: Ctx, faction: string, w: number, h: number): boolean {
  const fn = DRAW[faction];
  if (!fn) return false;
  c.save();
  fn(c, w, h);
  c.restore();
  return true;
}

const urls = new Map<string, string>();

/** PNG data URL of the flag (3:2), cached; used by the HTML UI. */
export function flagDataUrl(faction: string): string {
  let u = urls.get(faction);
  if (u) return u;
  const cv = document.createElement('canvas');
  cv.width = 120;
  cv.height = 80;
  const c = cv.getContext('2d')!;
  if (!drawFlag(c, faction, cv.width, cv.height)) {
    c.fillStyle = '#777';
    c.fillRect(0, 0, cv.width, cv.height);
  }
  u = cv.toDataURL('image/png');
  urls.set(faction, u);
  return u;
}
