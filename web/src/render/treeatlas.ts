import * as THREE from 'three';

/*
 * Procedural texture atlas for the trees (src/render/trees.ts): leaf-card
 * clusters painted leaf by leaf on a canvas (real silhouettes, a lit and a
 * shaded half per leaf, midribs, twigs, darker leaves behind lighter ones),
 * conifer branch sprays, pine needle tufts, willow curtains, dense "mass"
 * cards for the far LOD and three barks. Leaves are painted in light,
 * desaturated tones: the per-instance colour gives each tree its hue, so one
 * texture covers summer greens, olive and autumn tints.
 */

export const enum TCell {
  Oak = 0,
  Broad = 1,
  Birch = 2,
  Poplar = 3,
  Willow = 4,
  Spruce = 5,
  Pine = 6,
  Fruit = 7,
  Mass = 8,
  MassConifer = 9,
  Bark = 10,
  BirchBark = 11,
  PineBark = 12,
  MassWillow = 13,
}

const GRID = 4;

/** UV rectangle [u0, v0, u1, v1] of an atlas cell (v1 = top of the painted cell). */
export function tcell(c: TCell): [number, number, number, number] {
  const cx = c % GRID;
  const cy = Math.floor(c / GRID);
  const e = 0.003;
  return [cx / GRID + e, 1 - (cy + 1) / GRID + e, (cx + 1) / GRID - e, 1 - cy / GRID - e];
}

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Shape = 'oak' | 'oval' | 'tri' | 'round' | 'lance';

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h.toFixed(1)},${s.toFixed(1)}%,${l.toFixed(1)}%,${a})`;

const cache = new Map<number, THREE.CanvasTexture>();

/** The tree atlas, `cellPx` pixels per cell (cached per size). */
export function treeAtlas(cellPx: number): THREE.CanvasTexture {
  const hit = cache.get(cellPx);
  if (hit) return hit;
  const S = cellPx;
  const c = document.createElement('canvas');
  c.width = c.height = S * GRID;
  const ctx = c.getContext('2d')!;
  const rnd = prng(1234);
  const R = (a: number, b: number) => a + (b - a) * rnd();

  const clip = (cell: TCell) => {
    ctx.restore();
    ctx.save();
    const cx = (cell % GRID) * S;
    const cy = Math.floor(cell / GRID) * S;
    ctx.beginPath();
    ctx.rect(cx, cy, S, S);
    ctx.clip();
    ctx.translate(cx, cy);
  };
  ctx.save();

  /** One leaf: base at (x, y), pointing along `ang`, `len` long; `lit` 0..1 light level. */
  const leafPath = (shape: Shape, len: number, wid: number) => {
    ctx.beginPath();
    if (shape === 'oak') {
      // lobed: a wavy outline with three lobes per side
      ctx.moveTo(0, 0);
      const n = 3;
      for (const side of [1, -1]) {
        for (let i = 0; i <= n; i++) {
          const t = (i + 0.5) / (n + 1);
          const w = wid * Math.sin(Math.PI * Math.min(1, t * 1.15)) * (i % 2 ? 0.7 : 1);
          if (side > 0) ctx.quadraticCurveTo(len * (t - 0.12), side * w * 1.1, len * t, side * w * 0.55);
          else ctx.quadraticCurveTo(len * (1 - t + 0.12), side * w * 1.1, len * (1 - t), side * w * 0.55);
        }
        if (side > 0) ctx.quadraticCurveTo(len * 0.97, wid * 0.25, len, 0);
      }
      ctx.closePath();
      return;
    }
    const wmax = shape === 'round' ? wid * 1.15 : shape === 'lance' ? wid * 0.5 : wid;
    const bulge = shape === 'tri' ? 0.32 : shape === 'round' ? 0.5 : 0.45;
    ctx.moveTo(0, 0);
    ctx.bezierCurveTo(len * bulge * 0.4, wmax * 1.1, len * (bulge + 0.25), wmax, len, 0);
    ctx.bezierCurveTo(len * (bulge + 0.25), -wmax, len * bulge * 0.4, -wmax * 1.1, 0, 0);
    ctx.closePath();
  };
  const leaf = (shape: Shape, x: number, y: number, ang: number, len: number, wid: number, hue: number, sat: number, lit: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(ang);
    leafPath(shape, len, wid);
    ctx.fillStyle = hsl(hue, sat, lit * 0.78);
    ctx.fill();
    // the lit half: a narrower copy shifted to one side
    ctx.save();
    ctx.clip();
    ctx.translate(0, -wid * 0.32);
    ctx.scale(1, 0.75);
    leafPath(shape, len, wid);
    ctx.fillStyle = hsl(hue - 4, sat * 0.9, Math.min(96, lit * 1.08));
    ctx.fill();
    ctx.restore();
    if (len > S * 0.05) {
      ctx.strokeStyle = hsl(hue - 8, sat * 0.6, Math.min(96, lit * 1.2), 0.55);
      ctx.lineWidth = Math.max(0.6, len * 0.035);
      ctx.beginPath();
      ctx.moveTo(len * 0.04, 0);
      ctx.lineTo(len * 0.85, 0);
      ctx.stroke();
    }
    ctx.restore();
  };
  const twig = (x0: number, y0: number, x1: number, y1: number, w: number, col = '#4a3a2c') => {
    ctx.strokeStyle = col;
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.quadraticCurveTo((x0 + x1) / 2 + (y1 - y0) * 0.12, (y0 + y1) / 2 - (x1 - x0) * 0.12, x1, y1);
    ctx.stroke();
  };

  /**
   * Radial leaf spray (a leaf cluster seen from any side): twigs from the
   * centre with leaves along them, darker leaves first (inside), lighter on top.
   */
  const spray = (cell: TCell, o: { shape: Shape; n: number; len: number; wid: number; hue: number; sat: number; light: number; twigs: number; rad?: number; fruit?: boolean; upright?: boolean }) => {
    clip(cell);
    const cx = S / 2;
    const cy = S / 2;
    const rad = (o.rad ?? 0.44) * S;
    const tw: [number, number][] = [];
    for (let i = 0; i < o.twigs; i++) {
      const a = o.upright ? -Math.PI / 2 + R(-1.1, 1.1) : (i / o.twigs) * Math.PI * 2 + R(-0.3, 0.3);
      const l = rad * R(0.6, 0.85);
      const x1 = cx + Math.cos(a) * l;
      const y1 = (o.upright ? S * 0.92 : cy) + Math.sin(a) * l * (o.upright ? 1.6 : 1);
      tw.push([x1, y1]);
      twig(cx, o.upright ? S * 0.96 : cy, x1, y1, Math.max(1, S * 0.012));
    }
    for (let layer = 0; layer < 3; layer++) {
      const cnt = Math.round(o.n * (layer === 2 ? 0.45 : 0.35));
      for (let i = 0; i < cnt; i++) {
        // leaves cluster around the twig ends and along the twigs
        let x: number;
        let y: number;
        if (rnd() < 0.65) {
          const [tx, ty] = tw[Math.floor(rnd() * tw.length)];
          const t = Math.sqrt(rnd());
          const bx = o.upright ? cx : cx;
          const by = o.upright ? S * 0.96 : cy;
          x = bx + (tx - bx) * t + R(-1, 1) * rad * 0.18;
          y = by + (ty - by) * t + R(-1, 1) * rad * 0.18;
        } else {
          const a = rnd() * Math.PI * 2;
          const r = rad * Math.sqrt(rnd()) * 0.92;
          x = cx + Math.cos(a) * r;
          y = (o.upright ? S * 0.52 : cy) + Math.sin(a) * r * (o.upright ? 1.05 : 1);
        }
        const dx = x - cx;
        const dy = y - cy;
        const out = Math.atan2(dy, dx);
        const ang = (o.upright ? -Math.PI / 2 + out * 0.25 : out) + R(-0.9, 0.9);
        const d = Math.hypot(dx, dy) / rad;
        if (d > 1.02) continue;
        const sz = R(0.75, 1.2) * (1 - d * 0.18);
        const lit = o.light * (layer === 0 ? 0.62 : layer === 1 ? 0.82 : 1.0) * R(0.88, 1.1) * (1.05 - 0.15 * Math.max(0, dy / rad));
        leaf(o.shape, x, y, ang, o.len * S * sz, o.wid * S * sz, o.hue + R(-8, 8), o.sat * R(0.8, 1.15), lit);
      }
    }
    if (o.fruit) {
      for (let i = 0; i < 9; i++) {
        const a = rnd() * Math.PI * 2;
        const r = rad * Math.sqrt(rnd()) * 0.75;
        const x = cx + Math.cos(a) * r;
        const y = cy + Math.sin(a) * r;
        const fr = S * R(0.022, 0.03);
        ctx.fillStyle = hsl(R(2, 16), 75, 62);
        ctx.beginPath();
        ctx.arc(x, y, fr, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = hsl(20, 60, 84, 0.8);
        ctx.beginPath();
        ctx.arc(x - fr * 0.3, y - fr * 0.3, fr * 0.35, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  };

  // ---------------------------------------------------------- leaf clusters
  spray(TCell.Oak, { shape: 'oak', n: 120, len: 0.13, wid: 0.05, hue: 80, sat: 26, light: 74, twigs: 6 });
  spray(TCell.Broad, { shape: 'oval', n: 150, len: 0.115, wid: 0.045, hue: 78, sat: 24, light: 76, twigs: 7 });
  spray(TCell.Birch, { shape: 'tri', n: 120, len: 0.075, wid: 0.04, hue: 72, sat: 26, light: 80, twigs: 7, rad: 0.42 });
  spray(TCell.Poplar, { shape: 'round', n: 170, len: 0.07, wid: 0.038, hue: 80, sat: 24, light: 76, twigs: 5, upright: true, rad: 0.36 });
  spray(TCell.Fruit, { shape: 'oval', n: 140, len: 0.1, wid: 0.045, hue: 82, sat: 24, light: 74, twigs: 6, fruit: true });
  // far LOD mass: many small leaves in a lumpy, dense blob
  {
    clip(TCell.Mass);
    const lumps: [number, number, number][] = [];
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2 + R(-0.3, 0.3);
      const r = i === 0 ? 0 : S * R(0.16, 0.24);
      lumps.push([S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, S * R(0.17, 0.22)]);
    }
    for (let layer = 0; layer < 3; layer++)
      for (const [lx, ly, lr] of lumps)
        for (let i = 0; i < 70; i++) {
          const a = rnd() * Math.PI * 2;
          const r = lr * Math.sqrt(rnd());
          const x = lx + Math.cos(a) * r;
          const y = ly + Math.sin(a) * r;
          const top = (S / 2 - y) / (S * 0.5);
          const lit = 76 * (layer === 0 ? 0.55 : layer === 1 ? 0.78 : 1) * (0.92 + 0.18 * top) * R(0.9, 1.08);
          leaf('oval', x, y, rnd() * Math.PI * 2, S * 0.06, S * 0.026, 80 + R(-8, 8), 24, lit);
        }
  }

  // ------------------------------------------------------------ willow curtain
  {
    clip(TCell.Willow);
    for (let layer = 0; layer < 2; layer++)
      for (let i = 0; i < 16; i++) {
        const x0 = S * (0.06 + 0.88 * ((i + rnd() * 0.8) / 16));
        const len = S * R(0.6, 0.95);
        const sway = R(-0.08, 0.08) * S;
        ctx.strokeStyle = 'rgba(80,72,50,0.7)';
        ctx.lineWidth = Math.max(0.6, S * 0.005);
        ctx.beginPath();
        ctx.moveTo(x0, 0);
        ctx.quadraticCurveTo(x0 + sway * 0.3, len * 0.5, x0 + sway, len);
        ctx.stroke();
        const nl = Math.round(len / (S * 0.022));
        for (let k = 0; k < nl; k++) {
          const t = k / nl;
          const x = x0 + sway * t * t + R(-1, 1) * S * 0.006;
          const y = len * t;
          const side = k % 2 ? 1 : -1;
          const lit = 78 * (layer === 0 ? 0.68 : 1) * (1.04 - t * 0.2) * R(0.88, 1.1);
          leaf('lance', x, y, Math.PI / 2 + side * R(0.25, 0.6), S * R(0.07, 0.1), S * 0.03, 70 + R(-6, 6), 28, lit);
        }
      }
  }
  // willow far mass: stacked short curtains
  {
    clip(TCell.MassWillow);
    for (let i = 0; i < 60; i++) {
      const x0 = S * R(0.05, 0.95);
      const y0 = S * R(0, 0.25);
      const len = S * R(0.4, 0.75) * (1 - Math.abs(x0 / S - 0.5));
      for (let k = 0; k < len / (S * 0.03); k++) {
        const y = y0 + k * S * 0.03;
        leaf('lance', x0 + R(-2, 2), y, Math.PI / 2 + R(-0.5, 0.5), S * 0.07, S * 0.028, 70 + R(-6, 6), 28, 78 * R(0.6, 1.05) * (1 - (y / S) * 0.25));
      }
    }
  }

  // --------------------------------------------------- conifer branch sprays
  /** Fishbone spray from the root (left edge) to the tip (right edge), seen from above. */
  const fishbone = (cell: TCell, o: { width: number; dense: number; light: number }) => {
    clip(cell);
    const y0 = S * 0.5;
    const tipW = (t: number) => o.width * S * Math.sin(Math.PI * Math.min(1, 0.15 + t * 0.95)) * (1 - t * 0.35);
    ctx.strokeStyle = '#4b3b2c';
    ctx.lineWidth = Math.max(1, S * 0.018);
    ctx.beginPath();
    ctx.moveTo(0, y0);
    ctx.lineTo(S * 0.97, y0);
    ctx.stroke();
    for (let layer = 0; layer < 3; layer++) {
      const nb = Math.round(16 * o.dense);
      for (let i = 0; i < nb; i++) {
        const t = (i + rnd()) / nb;
        const x = S * (0.03 + t * 0.92);
        for (const side of [-1, 1]) {
          const bl = tipW(t) * R(0.75, 1.05);
          const bx = x + bl * 0.55;
          const by = y0 + side * bl;
          ctx.strokeStyle = hsl(30, 25, 22);
          ctx.lineWidth = Math.max(0.6, S * 0.006);
          ctx.beginPath();
          ctx.moveTo(x, y0);
          ctx.lineTo(bx, by);
          ctx.stroke();
          // needles along the branchlet
          const nn = Math.round(14 * o.dense);
          for (let k = 0; k < nn; k++) {
            const u = k / nn;
            const px = x + (bx - x) * u;
            const py = y0 + (by - y0) * u;
            const lit = o.light * (layer === 0 ? 0.55 : layer === 1 ? 0.78 : 1) * R(0.85, 1.12) * (0.9 + 0.2 * t);
            ctx.strokeStyle = hsl(95 + R(-10, 10), 22, lit);
            ctx.lineWidth = Math.max(0.7, S * 0.008);
            for (const s2 of [-1, 1]) {
              const na = Math.atan2(by - y0, bx - x) + s2 * R(0.5, 1.0);
              const nl = S * R(0.03, 0.05) * (1 - u * 0.4);
              ctx.beginPath();
              ctx.moveTo(px, py);
              ctx.lineTo(px + Math.cos(na) * nl, py + Math.sin(na) * nl);
              ctx.stroke();
            }
          }
        }
      }
    }
  };
  fishbone(TCell.Spruce, { width: 0.3, dense: 1, light: 62 });
  fishbone(TCell.MassConifer, { width: 0.44, dense: 1.35, light: 60 });

  // pine: needle tufts at the ends of twigs
  {
    clip(TCell.Pine);
    const tufts: [number, number][] = [];
    for (let i = 0; i < 9; i++) {
      const a = (i / 9) * Math.PI * 2 + R(-0.25, 0.25);
      const r = i === 0 ? 0 : S * R(0.16, 0.3);
      tufts.push([S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r]);
    }
    for (const [x, y] of tufts) twig(S / 2, S / 2, x, y, Math.max(1, S * 0.014), '#5d4636');
    for (let layer = 0; layer < 2; layer++)
      for (const [x, y] of tufts) {
        const n = 46;
        for (let k = 0; k < n; k++) {
          const a = rnd() * Math.PI * 2;
          const l = S * R(0.06, 0.13);
          const lit = 64 * (layer === 0 ? 0.6 : 1) * R(0.85, 1.15) * (1 - ((y - S / 2) / S) * 0.3);
          ctx.strokeStyle = hsl(150 - 50 + R(-8, 8), 20, lit);
          ctx.lineWidth = Math.max(0.7, S * 0.008);
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.quadraticCurveTo(x + Math.cos(a) * l * 0.5, y + Math.sin(a) * l * 0.5 - l * 0.08, x + Math.cos(a) * l, y + Math.sin(a) * l);
          ctx.stroke();
        }
      }
  }

  // ------------------------------------------------------------------ barks
  const bark = (cell: TCell, base: [number, number, number], fissure: string, top?: [number, number, number]) => {
    clip(cell);
    const g = ctx.createLinearGradient(0, S, 0, 0);
    g.addColorStop(0, hsl(...base));
    g.addColorStop(1, hsl(...(top ?? base)));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < S * 0.9; i++) {
      const x = rnd() * S;
      const y = rnd() * S;
      ctx.strokeStyle = fissure;
      ctx.globalAlpha = R(0.25, 0.7);
      ctx.lineWidth = R(0.6, 2.2) * (S / 128);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + R(-2, 2), y + R(6, 22) * (S / 128));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  };
  bark(TCell.Bark, [28, 22, 34], 'rgba(30,22,16,1)', [30, 20, 40]);
  bark(TCell.PineBark, [25, 14, 34], 'rgba(40,26,18,1)', [20, 46, 50]);
  {
    clip(TCell.BirchBark);
    ctx.fillStyle = '#e6e2d6';
    ctx.fillRect(0, 0, S, S);
    for (let i = 0; i < 60; i++) {
      const y = rnd() * S;
      const x = rnd() * S;
      const dark = rnd() < 0.7;
      ctx.fillStyle = dark ? 'rgba(30,28,26,0.85)' : 'rgba(150,140,120,0.5)';
      ctx.fillRect(x, y, S * R(0.05, 0.22), S * R(0.008, dark ? 0.022 : 0.04));
    }
    // dark rough base
    const g = ctx.createLinearGradient(0, S, 0, S * 0.7);
    g.addColorStop(0, 'rgba(40,36,32,0.85)');
    g.addColorStop(1, 'rgba(40,36,32,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, S * 0.7, S, S * 0.3);
  }
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  cache.set(cellPx, tex);
  return tex;
}
