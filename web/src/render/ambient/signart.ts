import { CELLS, CELL_COUNT } from './signplan';
import { PRODUCTS, paintAd, type Product } from './ads';

/*
 * The Sinai's sign atlas: one small canvas with every face the roadside signs wear (signplan.ts CELLS): the six
 * product adverts in Arabic, six more painted adverts, four hand-painted shop signs, six direction boards, two
 * wall murals, portrait and square boards, and the round / triangular road signs. All fictional names (no real
 * brands), Arabic with an English line, painted procedurally from shapes and gradients.
 */

export const ATLAS_W = 1024;
export const ATLAS_H = 1408;

export interface CellRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Pixel rect of a cell in the full-size atlas. */
export function cellRect(id: number): CellRect {
  if (id <= 23) return { x: (id % 4) * 256, y: Math.floor(id / 4) * 128, w: 256, h: 128 };
  if (id <= 31) return { x: (id - 24) * 128, y: 768, w: 128, h: 256 };
  if (id <= 39) return { x: (id - 32) * 128, y: 1024, w: 128, h: 128 };
  if (id <= 47) return { x: (id - 40) * 128, y: 1152, w: 128, h: 128 };
  // backs: round, triangle (square cells), the arrow board's (landscape)
  if (id === CELLS.roundBack) return { x: 0, y: 1280, w: 128, h: 128 };
  if (id === CELLS.triBack) return { x: 128, y: 1280, w: 128, h: 128 };
  return { x: 256, y: 1280, w: 256, h: 128 };
}

/** uv rects (u0, v0, du, dv) of every cell, for the sign shader. */
export function cellUvs(): Float32Array {
  const a = new Float32Array(CELL_COUNT * 4);
  for (let i = 0; i < CELL_COUNT; i++) {
    const r = cellRect(i);
    const pad = 0.5; // half a texel in
    a[i * 4] = (r.x + pad) / ATLAS_W;
    a[i * 4 + 1] = 1 - (r.y + r.h - pad) / ATLAS_H;
    a[i * 4 + 2] = (r.w - pad * 2) / ATLAS_W;
    a[i * 4 + 3] = (r.h - pad * 2) / ATLAS_H;
  }
  return a;
}

type Ctx = CanvasRenderingContext2D;
const SANS = '"Noto Sans Arabic", "Noto Sans", "DejaVu Sans", "Liberation Sans", Arial, sans-serif';
const HAND = '"Noto Sans Arabic", "DejaVu Sans", "Comic Sans MS", cursive, sans-serif';

function fit(c: Ctx, text: string, max: number, size: number, weight: string, font: string) {
  let s = size;
  c.font = `${weight} ${s}px ${font}`;
  while (s > 8 && c.measureText(text).width > max) {
    s -= 2;
    c.font = `${weight} ${s}px ${font}`;
  }
  return s;
}

function grad(c: Ctx, x: number, y: number, w: number, h: number, a: string, b: string, vertical = true) {
  const g = vertical ? c.createLinearGradient(0, y, 0, y + h) : c.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
}

// ------------------------------------------------------------------ pictograms (drawn in a 100 x 100 box at (0, 0), centre 50, 50)

function sun(c: Ctx, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.arc(50, 50, 20, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = col;
  c.lineWidth = 5;
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    c.beginPath();
    c.moveTo(50 + Math.cos(a) * 29, 50 + Math.sin(a) * 29);
    c.lineTo(50 + Math.cos(a) * 42, 50 + Math.sin(a) * 42);
    c.stroke();
  }
}
function wave(c: Ctx, col: string) {
  c.strokeStyle = col;
  c.lineWidth = 7;
  c.lineCap = 'round';
  for (const y of [32, 52, 72]) {
    c.beginPath();
    c.moveTo(6, y);
    for (let k = 0; k < 4; k++) c.quadraticCurveTo(6 + k * 24 + 12, y - 14, 6 + (k + 1) * 24, y);
    c.stroke();
  }
}
function palm(c: Ctx, col: string, trunk: string) {
  c.strokeStyle = trunk;
  c.lineWidth = 7;
  c.beginPath();
  c.moveTo(48, 96);
  c.quadraticCurveTo(54, 60, 50, 38);
  c.stroke();
  c.strokeStyle = col;
  c.lineWidth = 6;
  c.lineCap = 'round';
  for (const [dx, dy] of [[-34, 8], [-22, -10], [0, -18], [24, -8], [36, 10]]) {
    c.beginPath();
    c.moveTo(50, 38);
    c.quadraticCurveTo(50 + dx * 0.5, 38 + dy - 14, 50 + dx, 38 + dy + 12);
    c.stroke();
  }
}
function camel(c: Ctx, col: string) {
  c.fillStyle = col;
  c.strokeStyle = col;
  c.lineWidth = 5;
  c.beginPath();
  c.moveTo(16, 56);
  c.quadraticCurveTo(24, 40, 36, 52);
  c.quadraticCurveTo(46, 34, 58, 52);
  c.lineTo(72, 50);
  c.lineTo(80, 28);
  c.lineTo(90, 30);
  c.lineTo(88, 38);
  c.lineTo(80, 42);
  c.lineTo(78, 62);
  c.lineTo(22, 62);
  c.closePath();
  c.fill();
  for (const x of [26, 38, 62, 74]) {
    c.beginPath();
    c.moveTo(x, 60);
    c.lineTo(x, 88);
    c.stroke();
  }
}
function bottle(c: Ctx, col: string, label: string) {
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(42, 8);
  c.lineTo(58, 8);
  c.lineTo(58, 28);
  c.quadraticCurveTo(72, 40, 72, 60);
  c.lineTo(72, 92);
  c.lineTo(28, 92);
  c.lineTo(28, 60);
  c.quadraticCurveTo(28, 40, 42, 28);
  c.closePath();
  c.fill();
  c.fillStyle = label;
  c.fillRect(28, 56, 44, 22);
}
function cup(c: Ctx, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(20, 40);
  c.lineTo(72, 40);
  c.lineTo(66, 84);
  c.lineTo(26, 84);
  c.closePath();
  c.fill();
  c.strokeStyle = col;
  c.lineWidth = 7;
  c.beginPath();
  c.arc(74, 56, 11, -1.4, 1.4);
  c.stroke();
  c.strokeStyle = 'rgba(255,255,255,0.8)';
  c.lineWidth = 4;
  for (const x of [34, 46, 58]) {
    c.beginPath();
    c.moveTo(x, 30);
    c.bezierCurveTo(x - 8, 20, x + 8, 12, x, 2);
    c.stroke();
  }
}
function car(c: Ctx, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(6, 70);
  c.lineTo(6, 54);
  c.quadraticCurveTo(10, 46, 28, 44);
  c.lineTo(38, 28);
  c.lineTo(66, 28);
  c.lineTo(78, 44);
  c.quadraticCurveTo(96, 46, 96, 58);
  c.lineTo(96, 70);
  c.closePath();
  c.fill();
  c.fillStyle = '#10151b';
  for (const x of [26, 76]) {
    c.beginPath();
    c.arc(x, 72, 10, 0, Math.PI * 2);
    c.fill();
  }
}
function cross(c: Ctx, col: string) {
  c.fillStyle = col;
  c.fillRect(38, 14, 24, 72);
  c.fillRect(14, 38, 72, 24);
}
function fish(c: Ctx, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.ellipse(46, 50, 30, 18, 0, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.moveTo(70, 50);
  c.lineTo(94, 30);
  c.lineTo(94, 70);
  c.closePath();
  c.fill();
  c.fillStyle = '#fff';
  c.beginPath();
  c.arc(30, 44, 4, 0, Math.PI * 2);
  c.fill();
}
function tent(c: Ctx, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(8, 84);
  c.lineTo(50, 22);
  c.lineTo(92, 84);
  c.closePath();
  c.fill();
  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.beginPath();
  c.moveTo(42, 84);
  c.lineTo(50, 52);
  c.lineTo(58, 84);
  c.closePath();
  c.fill();
}
function fuel(c: Ctx, col: string) {
  c.fillStyle = col;
  c.fillRect(22, 14, 40, 72);
  c.fillStyle = 'rgba(255,255,255,0.8)';
  c.fillRect(28, 22, 28, 20);
  c.strokeStyle = col;
  c.lineWidth = 6;
  c.beginPath();
  c.moveTo(62, 34);
  c.quadraticCurveTo(82, 36, 80, 56);
  c.lineTo(80, 74);
  c.stroke();
}
function cart(c: Ctx, col: string) {
  c.strokeStyle = col;
  c.fillStyle = col;
  c.lineWidth = 7;
  c.lineJoin = 'round';
  c.beginPath();
  c.moveTo(8, 18);
  c.lineTo(24, 18);
  c.lineTo(34, 62);
  c.lineTo(80, 62);
  c.lineTo(88, 30);
  c.lineTo(28, 30);
  c.stroke();
  for (const x of [40, 74]) {
    c.beginPath();
    c.arc(x, 78, 7, 0, Math.PI * 2);
    c.fill();
  }
}
function icecream(c: Ctx, col: string, cone: string) {
  c.fillStyle = cone;
  c.beginPath();
  c.moveTo(32, 50);
  c.lineTo(68, 50);
  c.lineTo(50, 94);
  c.closePath();
  c.fill();
  c.fillStyle = col;
  c.beginPath();
  c.arc(50, 38, 22, 0, Math.PI * 2);
  c.fill();
  c.beginPath();
  c.arc(50, 20, 12, 0, Math.PI * 2);
  c.fill();
}
function phoneIc(c: Ctx, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.roundRect(32, 6, 36, 88, 7);
  c.fill();
  c.fillStyle = 'rgba(255,255,255,0.85)';
  c.fillRect(37, 16, 26, 56);
  c.beginPath();
  c.arc(50, 83, 4, 0, Math.PI * 2);
  c.fill();
}
function bread(c: Ctx, col: string) {
  c.fillStyle = col;
  c.beginPath();
  c.ellipse(50, 56, 38, 22, 0, 0, Math.PI * 2);
  c.fill();
  c.strokeStyle = 'rgba(80,40,10,0.5)';
  c.lineWidth = 4;
  for (const x of [32, 50, 68]) {
    c.beginPath();
    c.moveTo(x - 6, 46);
    c.lineTo(x + 6, 66);
    c.stroke();
  }
}
function scissors(c: Ctx, col: string) {
  c.strokeStyle = col;
  c.lineWidth = 7;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(24, 20);
  c.lineTo(78, 82);
  c.moveTo(78, 20);
  c.lineTo(24, 82);
  c.stroke();
  c.beginPath();
  c.arc(22, 84, 9, 0, Math.PI * 2);
  c.arc(80, 84, 9, 0, Math.PI * 2);
  c.stroke();
}
function wrench(c: Ctx, col: string) {
  c.strokeStyle = col;
  c.lineWidth = 10;
  c.lineCap = 'round';
  c.beginPath();
  c.moveTo(24, 82);
  c.lineTo(66, 36);
  c.stroke();
  c.lineWidth = 8;
  c.beginPath();
  c.arc(70, 30, 15, 0.5, 5.3);
  c.stroke();
}

type Icon = (c: Ctx) => void;

interface Panel {
  top: string;
  bottom: string;
  ink: string;
  accent: string;
  ar: string;
  en: string;
  tag?: string;
  icon: Icon;
  /** Icon on the left (default: the side opposite the text). */
  style?: 'plain' | 'stripe' | 'hand' | 'sun';
}

/** Landscape adverts beyond the six products (ids 6 .. 11), 256 x 128 cells painted at 512 x 256. */
const ADS: Panel[] = [
  { top: '#06607a', bottom: '#023247', ink: '#ffffff', accent: '#ffd23f', ar: 'غوص الشعاب', en: 'CORAL DIVE CENTRE', tag: 'دورات · رحلات · معدات', icon: (c) => fish(c, '#ffd23f') },
  { top: '#e8f6ff', bottom: '#9fd0ee', ink: '#0a3c63', accent: '#1d86c7', ar: 'مياه الينبوع', en: 'SPRING WATER', tag: 'نقية من قلب سيناء', icon: (c) => bottle(c, '#2f9bd8', '#ffffff') },
  { top: '#2a0f3d', bottom: '#5b1a73', ink: '#ffffff', accent: '#ff9d2e', ar: 'رمال سل', en: 'SANDCOM MOBILE', tag: 'باقة بلا حدود', icon: (c) => phoneIc(c, '#ff9d2e') },
  { top: '#c93a1e', bottom: '#7a1a0d', ink: '#fff4d6', accent: '#ffd23f', ar: 'شاي الواحة', en: 'OASIS TEA', tag: 'أصلي · دافئ · معطر', icon: (c) => cup(c, '#fff4d6') },
  { top: '#f2d066', bottom: '#d49a1c', ink: '#3a2300', accent: '#7a1a0d', ar: 'فندق نخيل البحر', en: 'PALM SEA HOTEL', tag: 'غرف متاحة · شاطئ خاص', icon: (c) => palm(c, '#2f7a2e', '#6a4520') },
  { top: '#1d6e54', bottom: '#0b3a2c', ink: '#ffffff', accent: '#f4e3a0', ar: 'رحلات الجمال', en: 'CAMEL TREKS SINAI', tag: 'سفاري · مخيمات', icon: (c) => camel(c, '#f4e3a0') },
];
/** Hand-painted shop signs (ids 12 .. 15): rough strokes, uneven letters. */
const SHOPS: Panel[] = [
  { top: '#2b6fb3', bottom: '#2b6fb3', ink: '#fff6c8', accent: '#e8453c', ar: 'بقالة الأمل', en: 'AL-AMAL GROCERY', icon: (c) => cart(c, '#fff6c8'), style: 'hand' },
  { top: '#e7d6a4', bottom: '#e7d6a4', ink: '#7a1a0d', accent: '#1d6e54', ar: 'مقهى الواحة', en: 'OASIS CAFE', icon: (c) => cup(c, '#7a1a0d'), style: 'hand' },
  { top: '#1d6e54', bottom: '#1d6e54', ink: '#ffffff', accent: '#ffd23f', ar: 'ورشة السلام', en: 'GARAGE & TYRES', icon: (c) => wrench(c, '#ffd23f'), style: 'hand' },
  { top: '#f0eadc', bottom: '#f0eadc', ink: '#0a3c63', accent: '#e8453c', ar: 'حلاقة النيل', en: 'BARBER', icon: (c) => scissors(c, '#e8453c'), style: 'hand' },
];
/** Direction boards (ids 16 .. 21): a green arrow board with the name of the place in both scripts. */
const DIRS: [string, string, string][] = [
  ['شرم الشيخ', 'SHARM EL-SHEIKH', '٦٠ كم'],
  ['نويبع', 'NUWEIBA', '٣٥ كم'],
  ['السويس', 'SUEZ', '١٢٠ كم'],
  ['دهب', 'DAHAB', '٨٠ كم'],
  ['سانت كاترين', 'ST CATHERINE', '٩٠ كم'],
  ['العريش', 'EL-ARISH', '١٤٠ كم'],
];
/** Wall murals (ids 22, 23). */
const MURALS: Panel[] = [
  { top: '#fbe7b0', bottom: '#f1b84c', ink: '#5a2a0a', accent: '#0a7d7a', ar: 'أهلاً بكم في سيناء', en: 'WELCOME TO SINAI', icon: (c) => sun(c, '#c8541e') },
  { top: '#cfe9f2', bottom: '#59b0cf', ink: '#08334a', accent: '#ffd23f', ar: 'شاطئ ورمال وجبال', en: 'SEA · SAND · MOUNTAINS', icon: (c) => wave(c, '#08334a') },
];
/** Portrait boards (ids 24 .. 31), 128 x 256 cells painted at 256 x 512. */
const TALL: Panel[] = [
  { top: '#14507a', bottom: '#082a44', ink: '#ffffff', accent: '#ffd23f', ar: 'صيدلية الشفاء', en: 'PHARMACY', tag: '٢٤ ساعة', icon: (c) => cross(c, '#3fbf6b') },
  { top: '#e84a2a', bottom: '#9a2410', ink: '#ffffff', accent: '#ffe14a', ar: 'وقود', en: 'FUEL · 91 · 95', tag: 'محطة النخيل', icon: (c) => fuel(c, '#ffe14a') },
  { top: '#f6edd8', bottom: '#d9c79b', ink: '#3a2300', accent: '#b05a1a', ar: 'مخبز البركة', en: 'BAKERY', tag: 'عيش طازج', icon: (c) => bread(c, '#b05a1a') },
  { top: '#0d7a6d', bottom: '#064038', ink: '#ffffff', accent: '#ffd23f', ar: 'سوبر ماركت الواحة', en: 'SUPERMARKET', tag: 'عروض الأسبوع', icon: (c) => cart(c, '#ffd23f') },
  { top: '#7a3dbf', bottom: '#3b1a63', ink: '#ffffff', accent: '#ffd23f', ar: 'مخيم نجوم الليل', en: 'STAR CAMP', tag: 'مبيت · عشاء بدوي', icon: (c) => tent(c, '#ffd23f') },
  { top: '#bfe9ff', bottom: '#6cb7e3', ink: '#05314f', accent: '#ff6a3d', ar: 'آيس كريم', en: 'ICE CREAM', tag: 'بارد · لذيذ', icon: (c) => icecream(c, '#ff9bb8', '#d9a35a') },
  { top: '#1b1f2a', bottom: '#2e3550', ink: '#ffffff', accent: '#5ef2ff', ar: 'شحن رصيد', en: 'TOP-UP & SIM', tag: 'رمال سل', icon: (c) => phoneIc(c, '#5ef2ff') },
  { top: '#e0b24a', bottom: '#a8741a', ink: '#2a1600', accent: '#ffffff', ar: 'تأجير دراجات', en: 'QUAD BIKES', tag: 'جولات الصحراء', icon: (c) => wrench(c, '#2a1600') },
];
/** Square boards (ids 32 .. 39), 128 x 128 cells painted at 256 x 256. */
const SQUARES: Panel[] = [
  { top: '#ffd23f', bottom: '#e8a31a', ink: '#3a1d00', accent: '#c8302a', ar: 'عصير قصب', en: 'FRESH JUICE', icon: (c) => bottle(c, '#c8302a', '#ffd23f') },
  { top: '#1d86c7', bottom: '#0c4a78', ink: '#ffffff', accent: '#ffd23f', ar: 'غرف للإيجار', en: 'ROOMS', icon: (c) => palm(c, '#9be07a', '#d9b36a') },
  { top: '#e8453c', bottom: '#8a1e18', ink: '#ffffff', accent: '#ffe9a8', ar: 'مشويات', en: 'GRILL', icon: (c) => fish(c, '#ffe9a8') },
  { top: '#2f7a2e', bottom: '#174a18', ink: '#ffffff', accent: '#ffd23f', ar: 'أعشاب', en: 'HERBS', icon: (c) => palm(c, '#ffffff', '#ffd23f') },
  { top: '#f2f0ea', bottom: '#cfc7b4', ink: '#12324a', accent: '#d8392c', ar: 'عيادة', en: 'CLINIC', icon: (c) => cross(c, '#d8392c') },
  { top: '#14507a', bottom: '#082a44', ink: '#ffffff', accent: '#ffd23f', ar: 'تاكسي', en: 'TAXI', icon: (c) => car(c, '#ffd23f') },
  { top: '#c97a2a', bottom: '#7a4210', ink: '#fff3d4', accent: '#fff3d4', ar: 'هدايا وتحف', en: 'GIFTS', icon: (c) => camel(c, '#fff3d4') },
  { top: '#7bc6e8', bottom: '#2a84b8', ink: '#08334a', accent: '#ffffff', ar: 'رحلات بحرية', en: 'BOAT TRIPS', icon: (c) => wave(c, '#ffffff') },
];

/** Paint a panel into a w x h box scaled from a 256 x 128 design box (landscape), 128 x 256 (portrait) or 128 x 128. */
function panel(c: Ctx, p: Panel, x: number, y: number, w: number, h: number) {
  const landscape = w > h * 1.5;
  const portrait = h > w * 1.5;
  const DW = landscape ? 512 : portrait ? 256 : 256;
  const DH = landscape ? 256 : portrait ? 512 : 256;
  c.save();
  c.translate(x, y);
  c.scale(w / DW, h / DH);
  c.beginPath();
  c.rect(0, 0, DW, DH);
  c.clip();
  grad(c, 0, 0, DW, DH, p.top, p.bottom);
  if (p.style === 'hand') {
    // brush-painted board: a border, uneven strokes
    c.strokeStyle = p.accent;
    c.lineWidth = 9;
    c.strokeRect(10, 10, DW - 20, DH - 20);
  } else {
    c.fillStyle = 'rgba(255,255,255,0.1)';
    c.beginPath();
    c.moveTo(0, DH * 0.75);
    c.lineTo(DW, DH * 0.35);
    c.lineTo(DW, DH * 0.55);
    c.lineTo(0, DH * 0.95);
    c.closePath();
    c.fill();
    c.fillStyle = p.accent;
    c.fillRect(0, DH - 14, DW, 14);
  }
  c.shadowColor = 'rgba(0,0,0,0.3)';
  c.shadowBlur = 5;
  c.fillStyle = p.ink;
  c.textBaseline = 'alphabetic';
  c.direction = 'rtl';
  if (landscape) {
    // icon left, text right (Arabic reads from the right)
    c.save();
    c.translate(24, 56);
    c.scale(1.45, 1.45);
    c.shadowBlur = 0;
    p.icon(c);
    c.restore();
    c.textAlign = 'right';
    const tx = DW - 26;
    const mw = DW - 220;
    fit(c, p.ar, mw, 66, p.style === 'hand' ? '700' : '800', p.style === 'hand' ? HAND : SANS);
    c.fillText(p.ar, tx, 112);
    c.direction = 'ltr';
    c.textAlign = 'right';
    fit(c, p.en, mw, 30, '700', SANS);
    c.fillStyle = p.accent;
    c.fillText(p.en, tx, 160);
    if (p.tag) {
      c.direction = 'rtl';
      c.fillStyle = p.ink;
      c.globalAlpha = 0.9;
      fit(c, p.tag, mw, 26, '600', SANS);
      c.fillText(p.tag, tx, 208);
      c.globalAlpha = 1;
    }
  } else {
    // portrait / square: icon above, texts under, centred
    c.save();
    c.shadowBlur = 0;
    const iconSize = portrait ? 1.7 : 1.2;
    c.translate(DW / 2 - 50 * iconSize, portrait ? 56 : 24);
    c.scale(iconSize, iconSize);
    p.icon(c);
    c.restore();
    c.textAlign = 'center';
    const y0 = portrait ? 300 : 178;
    fit(c, p.ar, DW - 24, portrait ? 52 : 44, '800', SANS);
    c.fillText(p.ar, DW / 2, y0);
    c.direction = 'ltr';
    fit(c, p.en, DW - 24, portrait ? 32 : 28, '700', SANS);
    c.fillStyle = p.accent;
    c.fillText(p.en, DW / 2, y0 + (portrait ? 56 : 36));
    if (p.tag && portrait) {
      c.direction = 'rtl';
      c.fillStyle = p.ink;
      fit(c, p.tag, DW - 30, 30, '600', SANS);
      c.fillText(p.tag, DW / 2, y0 + 116);
    }
  }
  c.restore();
}

function roundSign(c: Ctx, x: number, y: number, s: number, kind: number) {
  c.save();
  c.translate(x, y);
  c.scale(s / 128, s / 128);
  c.clearRect(0, 0, 128, 128);
  const r = 60;
  // white face, red ring (speed limits / no overtaking)
  c.fillStyle = '#d82b20';
  c.beginPath();
  c.arc(64, 64, r + 2, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#f7f5ee';
  c.beginPath();
  c.arc(64, 64, r - 12, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#12151a';
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  if (kind < 3) {
    const txt = ['30', '50', '80'][kind];
    c.font = `800 ${txt.length > 1 ? 50 : 56}px ${SANS}`;
    c.fillText(txt, 64, 68);
  } else {
    // no overtaking: two cars, the red one on the right
    c.save();
    c.translate(64, 64);
    c.scale(0.5, 0.5);
    c.translate(-50, -52);
    car(c, '#12151a');
    c.translate(0, 0);
    c.restore();
    c.save();
    c.translate(64, 64);
    c.scale(0.35, 0.35);
    c.translate(-12, -46);
    car(c, '#d82b20');
    c.restore();
  }
  c.restore();
}

function triSign(c: Ctx, x: number, y: number, s: number, kind: number) {
  c.save();
  c.translate(x, y);
  c.scale(s / 128, s / 128);
  c.clearRect(0, 0, 128, 128);
  // red-bordered white triangle
  const tri = (inset: number) => {
    c.beginPath();
    c.moveTo(64, 6 + inset * 1.9);
    c.lineTo(122 - inset * 1.6, 112 - inset * 0.7);
    c.lineTo(6 + inset * 1.6, 112 - inset * 0.7);
    c.closePath();
  };
  c.lineJoin = 'round';
  c.fillStyle = '#d82b20';
  tri(0);
  c.fill();
  c.fillStyle = '#f7f5ee';
  tri(11);
  c.fill();
  c.fillStyle = '#12151a';
  c.strokeStyle = '#12151a';
  if (kind === 0) {
    // roundabout: three arrows chasing in a ring
    c.lineWidth = 7;
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * Math.PI * 2 - Math.PI / 2;
      c.beginPath();
      c.arc(64, 76, 19, a + 0.2, a + 1.7);
      c.stroke();
      const ex = 64 + Math.cos(a + 1.7) * 19;
      const ey = 76 + Math.sin(a + 1.7) * 19;
      c.beginPath();
      c.moveTo(ex + Math.cos(a + 1.7 + 1.57) * 10, ey + Math.sin(a + 1.7 + 1.57) * 10);
      c.lineTo(ex - Math.cos(a + 1.7) * 7, ey - Math.sin(a + 1.7) * 7);
      c.lineTo(ex - Math.cos(a + 1.7 + 1.57) * 5, ey - Math.sin(a + 1.7 + 1.57) * 5);
      c.closePath();
      c.fill();
    }
  } else if (kind === 1) {
    // a bend
    c.lineWidth = 11;
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(50, 104);
    c.lineTo(50, 80);
    c.quadraticCurveTo(50, 58, 78, 52);
    c.stroke();
    c.beginPath();
    c.moveTo(70, 36);
    c.lineTo(92, 52);
    c.lineTo(70, 66);
    c.closePath();
    c.fill();
  } else {
    // camels
    c.save();
    c.translate(24, 36);
    c.scale(0.8, 0.8);
    camel(c, '#12151a');
    c.restore();
  }
  c.restore();
}

function arrowBoard(c: Ctx, x: number, y: number, w: number, h: number, ar: string, en: string, km: string) {
  c.save();
  c.translate(x, y);
  c.scale(w / 512, h / 256);
  c.clearRect(0, 0, 512, 256);
  // a board with a pointed right-hand end
  const path = () => {
    c.beginPath();
    c.moveTo(10, 30);
    c.lineTo(410, 30);
    c.lineTo(502, 128);
    c.lineTo(410, 226);
    c.lineTo(10, 226);
    c.closePath();
  };
  c.fillStyle = '#f7f5ee';
  path();
  c.fill();
  c.fillStyle = '#0c6b3d';
  c.lineJoin = 'round';
  c.save();
  c.translate(256, 128);
  c.scale(0.955, 0.86);
  c.translate(-256, -128);
  path();
  c.fill();
  c.restore();
  c.fillStyle = '#ffffff';
  c.textBaseline = 'alphabetic';
  c.textAlign = 'center';
  c.direction = 'rtl';
  fit(c, ar, 330, 76, '800', SANS);
  c.fillText(ar, 208, 120);
  c.direction = 'ltr';
  fit(c, en, 330, 38, '700', SANS);
  c.fillText(en, 208, 170);
  c.direction = 'rtl';
  c.fillStyle = '#ffe14a';
  fit(c, km, 200, 34, '700', SANS);
  c.fillText(km, 208, 212);
  c.restore();
}

/** Back faces: plain galvanised grey with a rim (round / triangle / arrow shapes). */
function backs(c: Ctx) {
  const grey = '#9aa0a6';
  const dark = '#6f757a';
  {
    const r = cellRect(CELLS.roundBack);
    c.save();
    c.translate(r.x, r.y);
    c.clearRect(0, 0, r.w, r.h);
    c.fillStyle = dark;
    c.beginPath();
    c.arc(64, 64, 62, 0, Math.PI * 2);
    c.fill();
    c.fillStyle = grey;
    c.beginPath();
    c.arc(64, 64, 56, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }
  {
    const r = cellRect(CELLS.triBack);
    c.save();
    c.translate(r.x, r.y);
    c.clearRect(0, 0, r.w, r.h);
    c.lineJoin = 'round';
    for (const [col, ins] of [[dark, 0], [grey, 6]] as const) {
      c.fillStyle = col;
      c.beginPath();
      c.moveTo(64, 6 + ins * 1.9);
      c.lineTo(122 - ins * 1.6, 112 - ins * 0.7);
      c.lineTo(6 + ins * 1.6, 112 - ins * 0.7);
      c.closePath();
      c.fill();
    }
    c.restore();
  }
  {
    const r = cellRect(CELLS.arrowBack);
    c.save();
    c.translate(r.x, r.y);
    c.scale(r.w / 512, r.h / 256);
    c.clearRect(0, 0, 512, 256);
    for (const [col, k] of [[dark, 1], [grey, 0.95]] as const) {
      c.fillStyle = col;
      c.save();
      c.translate(256, 128);
      c.scale(k, k === 1 ? 1 : 0.88);
      c.translate(-256, -128);
      c.beginPath();
      c.moveTo(10, 30);
      c.lineTo(410, 30);
      c.lineTo(502, 128);
      c.lineTo(410, 226);
      c.lineTo(10, 226);
      c.closePath();
      c.fill();
      c.restore();
    }
    c.restore();
  }
}

/**
 * Paint the whole atlas (`scale` 1: 1024 x 1408, 0.5 for the phone's medium quality). Null where there is no
 * canvas (the tests).
 */
export function signAtlas(scale = 1): HTMLCanvasElement | null {
  if (typeof document === 'undefined') return null;
  const cv = document.createElement('canvas');
  cv.width = Math.round(ATLAS_W * scale);
  cv.height = Math.round(ATLAS_H * scale);
  const c = cv.getContext('2d');
  if (!c) return null;
  c.scale(scale, scale);
  const at = (id: number, fn: (r: CellRect) => void) => {
    const r = cellRect(id);
    c.save();
    c.beginPath();
    c.rect(r.x, r.y, r.w, r.h);
    c.clip();
    fn(r);
    c.restore();
  };
  // 0 .. 5: the six products in Arabic (ads.ts)
  PRODUCTS.forEach((p: Product, i) => at(i, (r) => paintAd(c, 'egypt', p, r.x, r.y, r.w, r.h)));
  ADS.forEach((p, i) => at(6 + i, (r) => panel(c, p, r.x, r.y, r.w, r.h)));
  SHOPS.forEach((p, i) => at(12 + i, (r) => panel(c, p, r.x, r.y, r.w, r.h)));
  DIRS.forEach(([ar, en, km], i) => at(16 + i, (r) => arrowBoard(c, r.x, r.y, r.w, r.h, ar, en, km)));
  MURALS.forEach((p, i) => at(22 + i, (r) => panel(c, p, r.x, r.y, r.w, r.h)));
  TALL.forEach((p, i) => at(24 + i, (r) => panel(c, p, r.x, r.y, r.w, r.h)));
  SQUARES.forEach((p, i) => at(32 + i, (r) => panel(c, p, r.x, r.y, r.w, r.h)));
  for (let k = 0; k < 4; k++) at(40 + k, (r) => roundSign(c, r.x, r.y, r.w, k));
  for (let k = 0; k < 3; k++) at(44 + k, (r) => triSign(c, r.x, r.y, r.w, k));
  at(CELLS.white, (r) => {
    c.fillStyle = '#ffffff';
    c.fillRect(r.x, r.y, r.w, r.h);
  });
  backs(c);
  return cv;
}
