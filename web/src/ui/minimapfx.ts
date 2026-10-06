import { ORE_MAX, type GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';

/*
 * Minimap overlays on top of the baked recon photo (render/minimap.ts):
 *  - the ore / gem fields, highlighted (a soft glow per tile by the amount left,
 *    re-drawn only when the mined amounts or the explored area change);
 *  - the static of a radar that is offline (a few pre-made noise frames cycled,
 *    plus a slow rolling interference band);
 *  - alert pings (a base / unit under attack): rings opening at the spot.
 */

/** Ore / gem fields: one pixel per tile, alpha by the amount left; explored tiles only. */
export class OreLayer {
  readonly canvas: HTMLCanvasElement;
  private img: ImageData;
  private key = -1;

  constructor(private map: GameMap) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = map.w;
    this.canvas.height = map.h;
    this.img = new ImageData(map.w, map.h);
  }

  /** Bring the layer up to date (cheap when nothing changed). Returns whether it was redrawn. */
  update(explored: ArrayLike<number>): boolean {
    const m = this.map;
    let key = 0;
    for (let i = 0; i < m.ore.length; i++) if (m.ore[i] && explored[i]) key = (key * 31 + i * 17 + m.ore[i] * (m.oreKind[i] === 2 ? 7 : 3)) | 0;
    if (key === this.key) return false;
    this.key = key;
    oreImage(m, explored, this.img.data);
    this.canvas.getContext('2d')!.putImageData(this.img, 0, 0);
    return true;
  }
}

/** The ore layer's pixels (RGBA, one per tile): gold ore, violet gems, alpha by the amount left. */
export function oreImage(m: GameMap, explored: ArrayLike<number>, data: Uint8ClampedArray) {
  for (let i = 0; i < m.ore.length; i++) {
    const o = i * 4;
    const n = explored[i] ? m.ore[i] : 0;
    if (!n) {
      data[o + 3] = 0;
      continue;
    }
    const gem = m.oreKind[i] === 2;
    data[o] = gem ? 206 : 255;
    data[o + 1] = gem ? 110 : 198;
    data[o + 2] = gem ? 255 : 72;
    data[o + 3] = Math.round(255 * (0.4 + 0.6 * Math.min(1, n / ORE_MAX)));
  }
}

/** Pre-made static noise frames (grey speckle on transparent), cycled while the radar is offline. */
export function noiseFrames(w: number, h: number, n = 4): HTMLCanvasElement[] {
  const out: HTMLCanvasElement[] = [];
  for (let f = 0; f < n; f++) {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = hash2(i % w, Math.floor(i / w), 401 + f * 7);
      // sparse bright and dark specks, mostly clear
      const a = v < 0.18 ? 150 : v > 0.9 ? 110 : 0;
      const g = v < 0.18 ? 200 + v * 300 : 10;
      img.data[i * 4] = g * 0.92;
      img.data[i * 4 + 1] = g;
      img.data[i * 4 + 2] = g * 0.95;
      img.data[i * 4 + 3] = a;
    }
    ctx.putImageData(img, 0, 0);
    out.push(c);
  }
  return out;
}

export type PingKind = 'attack' | 'info';

/** Alert pings on the minimap: rings opening at a tile-space spot. */
export class MinimapPings {
  private list: { x: number; y: number; t0: number; kind: PingKind }[] = [];
  static readonly LIFE = 3;

  add(x: number, y: number, kind: PingKind, now: number) {
    // one ping per spot at a time (a fight keeps raising the same alert)
    const near = this.list.find((p) => Math.hypot(p.x - x, p.y - y) < 6 && now - p.t0 < MinimapPings.LIFE * 0.6);
    if (near) return;
    this.list.push({ x, y, t0: now, kind });
    if (this.list.length > 6) this.list.shift();
  }

  get count() {
    return this.list.length;
  }

  /** Draw (canvas pixel space; `toPx` maps a tile-space point to the canvas). `u` scales the sizes. */
  draw(ctx: CanvasRenderingContext2D, toPx: (x: number, y: number) => { x: number; y: number }, now: number, u: number) {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const p = this.list[i];
      const t = now - p.t0;
      if (t > MinimapPings.LIFE || t < 0) {
        this.list.splice(i, 1);
        continue;
      }
      const q = toPx(p.x, p.y);
      const col = p.kind === 'attack' ? '255,72,56' : '255,214,90';
      // two rings opening one after the other, a steady dot at the spot
      for (let k = 0; k < 2; k++) {
        const f = ((t - k * 0.45) % 1.2) / 1.2;
        if (t - k * 0.45 < 0) continue;
        ctx.strokeStyle = `rgba(${col},${(1 - f) * (1 - t / MinimapPings.LIFE) * 0.95})`;
        ctx.lineWidth = 1.6 * u;
        ctx.beginPath();
        ctx.arc(q.x, q.y, (3 + f * 13) * u, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = `rgba(${col},${0.9 * (1 - t / MinimapPings.LIFE)})`;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 2.2 * u, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
