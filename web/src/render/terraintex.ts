import * as THREE from 'three';

/*
 * Procedural textures for the landscape: the tiling ground detail map used by
 * the splat shader, the foliage atlas shared by every plant, the road strip and
 * a few small building textures. Everything is generated at start-up.
 */

// ------------------------------------------------------------------ noise

function hash(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Periodic value noise with period p cells. */
function pnoise(x: number, y: number, p: number, s: number) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const m = (a: number) => ((a % p) + p) % p;
  const a = hash(m(xi), m(yi), s);
  const b = hash(m(xi + 1), m(yi), s);
  const c = hash(m(xi), m(yi + 1), s);
  const d = hash(m(xi + 1), m(yi + 1), s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Periodic fBm over the unit square with integer base frequency f. */
function pfbm(u: number, v: number, f: number, s: number, oct = 4) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let freq = f;
  for (let i = 0; i < oct; i++) {
    sum += pnoise(u * freq, v * freq, freq, s + i * 31) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return sum / norm;
}

/** Periodic cellular noise: distance to the nearest feature point (in cell units). */
function worley(u: number, v: number, cells: number, s: number) {
  const x = u * cells;
  const y = v * cells;
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  let best = 9;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      const cx = xi + i;
      const cy = yi + j;
      const wx = ((cx % cells) + cells) % cells;
      const wy = ((cy % cells) + cells) % cells;
      const px = cx + hash(wx, wy, s);
      const py = cy + hash(wx, wy, s + 7);
      const d = Math.hypot(px - x, py - y);
      if (d < best) best = d;
    }
  }
  return best;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** Small deterministic PRNG for canvas painting. */
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

function canvas(w: number, h: number) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return { c, ctx: c.getContext('2d')! };
}

// ------------------------------------------------------- ground detail map

/**
 * Tiling detail heights for the four ground materials, one per channel:
 * R grass (clumps + speckle), G soil (clods + pebbles), B rock (cracks,
 * strata), A sand (fine grain + ripples). Mean ~0.5 for every channel.
 */
export function groundDetailTexture(N: number): THREE.DataTexture {
  const data = new Uint8Array(N * N * 4);
  const pebbles = new Float32Array(N * N);
  // pebbles: small domes stamped into a separate height layer
  const rnd = prng(91);
  const count = Math.round((N * N) / 260);
  for (let n = 0; n < count; n++) {
    const cx = rnd() * N;
    const cy = rnd() * N;
    const r = (0.6 + rnd() * rnd() * 2.6) * (N / 512) * 2.2;
    const hgt = 0.5 + rnd() * 0.5;
    const R = Math.ceil(r + 1);
    for (let j = -R; j <= R; j++) {
      for (let i = -R; i <= R; i++) {
        const d = Math.hypot(i, j) / r;
        if (d >= 1) continue;
        const x = (((Math.floor(cx) + i) % N) + N) % N;
        const y = (((Math.floor(cy) + j) % N) + N) % N;
        const k = y * N + x;
        pebbles[k] = Math.max(pebbles[k], hgt * Math.sqrt(1 - d * d));
      }
    }
  }
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const k = y * N + x;
      // grass: tufty clumps over mottled noise and fine speckle
      const cl = worley(u, v, 22, 3);
      const clump = 1 - smooth(0.05, 0.75, cl);
      const mott = pfbm(u, v, 6, 11, 5);
      const g = 0.18 + clump * 0.38 + (mott - 0.5) * 0.7 + (hash(x, y, 5) - 0.5) * 0.28 + (pnoise(u * 96, v * 96, 96, 9) - 0.5) * 0.3 + 0.25;
      // soil: clods + pebbles
      const clod = pfbm(u, v, 12, 21, 4);
      const crack = Math.abs(pfbm(u, v, 5, 23, 3) - 0.5) * 2;
      const s = 0.2 + (clod - 0.5) * 0.9 + pebbles[k] * 0.55 + (hash(x, y, 6) - 0.5) * 0.18 + smooth(0, 0.06, crack) * 0.2 + 0.15;
      // rock: ridged cracks + faint strata
      const rf = pfbm(u, v, 4, 31, 5);
      const ridge = 1 - Math.abs(rf * 2 - 1);
      const cracks = smooth(0.82, 0.97, ridge);
      const strata = Math.sin((v + pfbm(u, v, 3, 37, 3) * 0.35) * Math.PI * 2 * 9) * 0.5 + 0.5;
      const r = 0.25 + (pfbm(u, v, 10, 33, 4) - 0.5) * 0.8 + strata * 0.18 - cracks * 0.45 + (hash(x, y, 7) - 0.5) * 0.12 + 0.3;
      // sand: grain + gentle ripples
      const rip = Math.sin((u * 0.6 + v + pfbm(u, v, 4, 41, 3) * 0.25) * Math.PI * 2 * 14) * 0.5 + 0.5;
      const a = 0.3 + rip * 0.25 + (pfbm(u, v, 16, 43, 3) - 0.5) * 0.5 + (hash(x, y, 8) - 0.5) * 0.3 + pebbles[(k + N * 37) % (N * N)] * 0.2;
      const o = k * 4;
      data[o] = clamp01(g) * 255;
      data[o + 1] = clamp01(s) * 255;
      data[o + 2] = clamp01(r) * 255;
      data[o + 3] = clamp01(a) * 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.anisotropy = 4;
  tex.needsUpdate = true;
  return tex;
}

/** Rock surface: grain, cracks and lichen speckle (also used as bump map). */
export function rockTexture(N: number): THREE.DataTexture {
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const u = (x + 0.5) / N;
      const v = (y + 0.5) / N;
      const base = pfbm(u, v, 4, 71, 5);
      const ridge = 1 - Math.abs(pfbm(u, v, 3, 73, 4) * 2 - 1);
      const crack = smooth(0.86, 0.97, ridge);
      const grain = hash(x, y, 75);
      let l = 0.62 + (base - 0.5) * 0.5 + (grain - 0.5) * 0.14 - crack * 0.4;
      const lichen = pfbm(u, v, 12, 77, 3) > 0.68 ? 0.12 : 0;
      l = clamp01(l + lichen);
      const o = (y * N + x) * 4;
      data[o] = l * 255;
      data[o + 1] = l * 250;
      data[o + 2] = l * 240;
      data[o + 3] = 255;
    }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  return tex;
}

// ---------------------------------------------------------- foliage atlas

/** Cells of the 4x2 foliage atlas. */
export const enum Leaf {
  Conifer = 0,
  Broadleaf = 1,
  Solid = 2,
  Bark = 3,
  Grass = 4,
  DryGrass = 5,
  Reeds = 6,
  Bush = 7,
}

/** UV rectangle [u0, v0, u1, v1] of an atlas cell (with a small inset). */
export function leafCell(cell: Leaf): [number, number, number, number] {
  const cx = cell % 4;
  const cy = Math.floor(cell / 4);
  const e = 0.004;
  // canvas row 0 is at the top, i.e. v = 1 with flipY
  return [cx / 4 + e, 1 - (cy + 1) / 2 + e, (cx + 1) / 4 - e, 1 - cy / 2 - e];
}

export function foliageAtlas(cellPx: number): THREE.CanvasTexture {
  const S = cellPx;
  const { c, ctx } = canvas(S * 4, S * 2);
  const rnd = prng(5);
  const cell = (n: number) => [(n % 4) * S, Math.floor(n / 4) * S] as const;
  const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${h},${s}%,${l}%,${a})`;
  const clip = (n: number) => {
    const [x, y] = cell(n);
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, S, S);
    ctx.clip();
    ctx.translate(x, y);
  };

  // conifer branch card: twig runs left->right along the cell centre, needles splay out
  clip(Leaf.Conifer);
  for (let layer = 0; layer < 3; layer++) {
    for (let i = 0; i < 260; i++) {
      const t = rnd();
      const bx = S * (0.04 + t * 0.92);
      const half = S * 0.46 * (1 - t * 0.75) * (0.55 + rnd() * 0.45);
      const by = S * 0.5 + (rnd() - 0.5) * 2 * half * 0.9;
      const len = S * (0.05 + rnd() * 0.07);
      const ang = (by < S * 0.5 ? -1 : 1) * (0.5 + rnd() * 0.7) + 0.25;
      const l = 14 + layer * 7 + rnd() * 10;
      ctx.strokeStyle = hsl(118 + rnd() * 30, 32 + rnd() * 18, l);
      ctx.lineWidth = Math.max(1, S / 110);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx + Math.cos(ang) * len, by + Math.sin(ang) * len);
      ctx.stroke();
    }
  }
  ctx.strokeStyle = '#3a2a1c';
  ctx.lineWidth = S / 50;
  ctx.beginPath();
  ctx.moveTo(0, S * 0.5);
  ctx.lineTo(S * 0.85, S * 0.5);
  ctx.stroke();
  ctx.restore();

  // broadleaf cluster: dense leaves in a lumpy round blob, lit from the top
  const leafBlob = (n: Leaf, hue: number, sat: number, light: number, leafSize: number, count: number) => {
    clip(n);
    for (let i = 0; i < count; i++) {
      const a = rnd() * Math.PI * 2;
      const rr = Math.sqrt(rnd()) * S * 0.46 * (0.85 + 0.15 * Math.sin(a * 5 + 1));
      const x = S / 2 + Math.cos(a) * rr;
      const y = S / 2 + Math.sin(a) * rr;
      const shade = 1 - (y / S) * 0.55 + (rnd() - 0.5) * 0.3 - (rr / (S * 0.46)) * 0.1;
      ctx.fillStyle = hsl(hue + (rnd() - 0.5) * 18, sat + (rnd() - 0.5) * 14, light * (0.55 + shade * 0.75));
      ctx.beginPath();
      const ls = S * leafSize * (0.6 + rnd() * 0.7);
      ctx.ellipse(x, y, ls, ls * 0.55, rnd() * Math.PI, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  };
  leafBlob(Leaf.Broadleaf, 92, 42, 30, 0.035, 1500);
  leafBlob(Leaf.Bush, 84, 34, 26, 0.03, 1700);

  // solid foliage: opaque, mottled - fills the inside of canopies
  clip(Leaf.Solid);
  ctx.fillStyle = hsl(95, 35, 16);
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = hsl(85 + rnd() * 30, 30 + rnd() * 15, 10 + rnd() * 16);
    ctx.beginPath();
    ctx.arc(rnd() * S, rnd() * S, S * (0.01 + rnd() * 0.03), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // bark: vertical fissures
  clip(Leaf.Bark);
  ctx.fillStyle = '#5a4634';
  ctx.fillRect(0, 0, S, S);
  for (let i = 0; i < 220; i++) {
    ctx.strokeStyle = `rgba(${30 + rnd() * 60},${22 + rnd() * 40},${15 + rnd() * 25},0.7)`;
    ctx.lineWidth = 1 + rnd() * (S / 60);
    const x = rnd() * S;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + (rnd() - 0.5) * 10, S * 0.3, x + (rnd() - 0.5) * 10, S * 0.6, x + (rnd() - 0.5) * 8, S);
    ctx.stroke();
  }
  ctx.restore();

  // grass tufts: blades rising from the bottom edge
  const blades = (n: Leaf, hue: number, sat: number, light: number, count: number, tall: number, tip?: string) => {
    clip(n);
    for (let i = 0; i < count; i++) {
      const x0 = S * (0.1 + rnd() * 0.8);
      const h = S * tall * (0.45 + rnd() * 0.55);
      const lean = (x0 - S / 2) * 0.5 + (rnd() - 0.5) * S * 0.25;
      const l = light * (0.55 + rnd() * 0.7);
      ctx.strokeStyle = hsl(hue + (rnd() - 0.5) * 16, sat, l);
      ctx.lineWidth = Math.max(1, S / 70) * (0.7 + rnd() * 0.8);
      ctx.beginPath();
      ctx.moveTo(x0, S);
      ctx.quadraticCurveTo(x0 + lean * 0.2, S - h * 0.6, x0 + lean, S - h);
      ctx.stroke();
      if (tip && rnd() < 0.3) {
        ctx.fillStyle = tip;
        ctx.beginPath();
        ctx.ellipse(x0 + lean, S - h, S * 0.012, S * 0.045, lean / S, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  };
  blades(Leaf.Grass, 75, 18, 62, 150, 0.95);
  blades(Leaf.DryGrass, 52, 38, 52, 140, 0.95, 'hsl(40,40%,58%)');
  blades(Leaf.Reeds, 75, 32, 34, 70, 1.0, 'hsl(25,45%,26%)');

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

// ------------------------------------------------------------------ roads

/**
 * Road strip texture. U runs across the road: [0, 0.5) is a two lane
 * highway with markings, [0.5, 1) an older country road. V runs along the
 * road and repeats every 8 tiles. Alpha gives ragged gravel shoulders.
 */
export function roadTexture(px: number): THREE.CanvasTexture {
  const W = px; // per variant
  const H = px * 4;
  const { c, ctx } = canvas(W * 2, H);
  const img = ctx.createImageData(W * 2, H);
  const d = img.data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W * 2; x++) {
      const variant = x < W ? 0 : 1;
      const u = (x % W) / W; // across
      const v = y / H; // along
      const n1 = pfbm(u, v, 4, 3 + variant, 4);
      const grain = hash(x, y, 2);
      const edge = Math.min(u, 1 - u);
      // ragged edge: alpha cut by noise
      const ragged = 0.035 + pfbm(u * 0.25, v, 24, 7 + variant, 3) * (variant ? 0.09 : 0.05);
      const alpha = edge > ragged ? 255 : 0;
      const asphaltEdge = (variant ? 0.12 : 0.07) + (pfbm(0, v, 32, 11 + variant, 3) - 0.5) * (variant ? 0.08 : 0.02);
      let r: number;
      let g: number;
      let b: number;
      if (edge < asphaltEdge) {
        // gravel shoulder
        const gv = 0.42 + (grain - 0.5) * 0.35 + (n1 - 0.5) * 0.3;
        r = gv * 0.95;
        g = gv * 0.88;
        b = gv * 0.76;
      } else {
        const base = variant ? 0.3 : 0.24;
        let a = base + (n1 - 0.5) * 0.12 + (grain - 0.5) * 0.1;
        // tyre wear: slightly darker / polished lanes
        a -= Math.exp(-Math.pow((Math.abs(u - 0.5) - 0.26) / 0.06, 2)) * 0.035;
        // patches and cracks
        const patch = pfbm(u, v, 3, 19 + variant, 2);
        if (patch > (variant ? 0.62 : 0.7)) a *= 0.78;
        const ck = Math.abs(pfbm(u, v, 6, 23 + variant, 4) - 0.5);
        if (ck < (variant ? 0.012 : 0.006)) a *= 0.55;
        r = a;
        g = a;
        b = a * 1.04;
        // markings
        const worn = 0.55 + pfbm(u, v, 20, 29, 3) * 0.6;
        if (variant === 0) {
          const edgeLine = Math.abs(edge - 0.115) < 0.012;
          const dash = Math.abs(u - 0.5) < 0.012 && (v * 8) % 1 < 0.45;
          if (edgeLine || dash) {
            const m = Math.min(1, worn);
            r = r + (0.85 - r) * m;
            g = g + (0.84 - g) * m;
            b = b + (0.78 - b) * m;
          }
        } else if (Math.abs(u - 0.5) < 0.01 && (v * 8) % 1 < 0.3) {
          const m = Math.min(1, worn) * 0.5;
          r = r + (0.8 - r) * m;
          g = g + (0.78 - g) * m;
          b = b + (0.7 - b) * m;
        }
      }
      const o = (y * W * 2 + x) * 4;
      d[o] = clamp01(r) * 255;
      d[o + 1] = clamp01(g) * 255;
      d[o + 2] = clamp01(b) * 255;
      d[o + 3] = alpha;
    }
  }
  ctx.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

// ------------------------------------------------------------- buildings

/** Light, neutral textures that vertex colours tint: plaster, roof tiles, planks. */
export function buildingTextures(px: number) {
  const make = (paint: (u: number, v: number, x: number, y: number) => number, wrap = true) => {
    const { c, ctx } = canvas(px, px);
    const img = ctx.createImageData(px, px);
    for (let y = 0; y < px; y++)
      for (let x = 0; x < px; x++) {
        const val = clamp01(paint(x / px, y / px, x, y)) * 255;
        const o = (y * px + x) * 4;
        img.data[o] = img.data[o + 1] = img.data[o + 2] = val;
        img.data[o + 3] = 255;
      }
    ctx.putImageData(img, 0, 0);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    if (wrap) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  const plaster = make((u, v, x, y) => 0.82 + (pfbm(u, v, 8, 3, 5) - 0.5) * 0.18 + (hash(x, y, 1) - 0.5) * 0.06);
  // roof tiles: rows of overlapping tiles, darker gaps between rows and columns
  const roof = make((u, v, x, y) => {
    const rows = 8;
    const ry = v * rows;
    const row = Math.floor(ry);
    const fy = ry - row;
    const cols = 10;
    const cx = u * cols + (row % 2) * 0.5;
    const fx = cx - Math.floor(cx);
    const tileShade = 0.75 + hash(Math.floor(cx), row, 4) * 0.25;
    const lip = smooth(0.0, 0.25, fy) * (1 - smooth(0.85, 1, fy) * 0.6);
    const gap = smooth(0, 0.08, fx) * smooth(0, 0.08, 1 - fx);
    return tileShade * (0.55 + lip * 0.4) * (0.75 + gap * 0.25) + (hash(x, y, 2) - 0.5) * 0.06 + (pfbm(u, v, 4, 5, 3) - 0.5) * 0.2;
  });
  const planks = make((u, v, x, y) => {
    const n = 8;
    const k = u * n;
    const f = k - Math.floor(k);
    const seam = smooth(0, 0.06, f) * smooth(0, 0.06, 1 - f);
    const board = 0.7 + hash(Math.floor(k), 0, 6) * 0.25;
    const grainV = (pnoise(u * 64, v * 4, 64, 8) - 0.5) * 0.25;
    return board * (0.55 + seam * 0.45) + grainV + (hash(x, y, 3) - 0.5) * 0.05;
  });
  return { plaster, roof, planks };
}
