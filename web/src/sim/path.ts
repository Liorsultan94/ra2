// Grid A* with octile movement (no corner cutting), partial paths to the
// closest reachable tile, and line-of-sight smoothing. With a slope field
// (slope.ts) steps steeper than the locomotion class takes are closed and
// climbing costs a little extra, so units wind up the gentle tracks.

import { DX, DY, dirOf } from './slope';

const SQRT2 = Math.SQRT2;

export class PathFinder {
  private g: Float32Array;
  private parent: Int32Array;
  private stamp: Uint32Array;
  private closed: Uint32Array;
  private cur = 1;
  private heap: Int32Array;
  private heapF: Float32Array;
  private heapSize = 0;
  private cache = new Map<number, number[]>();

  constructor(
    private w: number,
    private h: number,
    private pass: Uint8Array,
    /** Per tile: bit k set = the step towards neighbour k is too steep for this class (slope.ts). */
    private block: Uint8Array | null = null,
    /** Per tile and neighbour: extra cost of the step (climbing; slope.ts). */
    private climb: Float32Array | null = null,
    /** Search budget of a find() call (expanded nodes): the naval classes route round whole peninsulas. */
    private budget = 6000,
  ) {
    const n = w * h;
    this.g = new Float32Array(n);
    this.parent = new Int32Array(n);
    this.stamp = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.heap = new Int32Array(n * 2);
    this.heapF = new Float32Array(n * 2);
  }

  clearCache() {
    this.cache.clear();
  }

  private push(node: number, f: number) {
    let i = this.heapSize++;
    const heap = this.heap;
    const hf = this.heapF;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hf[p] <= f) break;
      heap[i] = heap[p];
      hf[i] = hf[p];
      i = p;
    }
    heap[i] = node;
    hf[i] = f;
  }

  private pop(): number {
    const heap = this.heap;
    const hf = this.heapF;
    const top = heap[0];
    const last = heap[--this.heapSize];
    const lf = hf[this.heapSize];
    let i = 0;
    const n = this.heapSize;
    for (;;) {
      let c = i * 2 + 1;
      if (c >= n) break;
      if (c + 1 < n && hf[c + 1] < hf[c]) c++;
      if (hf[c] >= lf) break;
      heap[i] = heap[c];
      hf[i] = hf[c];
      i = c;
    }
    heap[i] = last;
    hf[i] = lf;
    return top;
  }

  passable(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.w && y < this.h && this.pass[y * this.w + x] === 1;
  }

  /** Is the step from tile (x, y) to its neighbour (x + dx, y + dy) within this class's slope limit? */
  stepOk(x: number, y: number, dx: number, dy: number): boolean {
    if (!this.block) return true;
    const k = dirOf(dx, dy);
    return k < 0 || !(this.block[y * this.w + x] & (1 << k));
  }

  /**
   * Returns a list of tile indices from (sx,sy) (exclusive) to the goal or to
   * the closest reachable tile if the goal can't be reached.
   */
  find(sx: number, sy: number, gx: number, gy: number, maxNodes = this.budget): number[] {
    const w = this.w;
    if (sx === gx && sy === gy) return [];
    const goal = gy * w + gx;
    if (Math.abs(gx - sx) <= 12 && Math.abs(gy - sy) <= 12 && this.lineClear(sx, sy, gx, gy)) {
      return [goal];
    }
    const key = ((sx & 0xff) << 24) | ((sy & 0xff) << 16) | ((gx & 0xff) << 8) | (gy & 0xff);
    const cached = this.cache.get(key);
    if (cached) return cached.slice();
    this.cur++;
    if (this.cur > 0xfffffff0) {
      this.stamp.fill(0);
      this.closed.fill(0);
      this.cur = 1;
    }
    const cur = this.cur;
    const start = sy * w + sx;
    this.heapSize = 0;
    const heur = (x: number, y: number) => {
      const dx = Math.abs(x - gx);
      const dy = Math.abs(y - gy);
      return dx + dy + (SQRT2 - 2) * Math.min(dx, dy);
    };
    this.g[start] = 0;
    this.parent[start] = -1;
    this.stamp[start] = cur;
    this.push(start, heur(sx, sy));
    let best = start;
    let bestH = heur(sx, sy);
    let expanded = 0;
    while (this.heapSize > 0) {
      const node = this.pop();
      if (this.closed[node] === cur) continue;
      this.closed[node] = cur;
      if (node === goal) {
        best = node;
        break;
      }
      const x = node % w;
      const y = (node - x) / w;
      const hcur = heur(x, y);
      if (hcur < bestH) {
        bestH = hcur;
        best = node;
      }
      if (++expanded > maxNodes) break;
      const gNode = this.g[node];
      const bl = this.block ? this.block[node] : 0;
      for (let k = 0; k < 8; k++) {
        if (bl & (1 << k)) continue;
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (!this.passable(nx, ny)) continue;
        if (k >= 4 && (!this.passable(x + DX[k], y) || !this.passable(x, y + DY[k]))) continue;
        const ni = ny * w + nx;
        if (this.closed[ni] === cur) continue;
        const ng = gNode + (k >= 4 ? SQRT2 : 1) + (this.climb ? this.climb[node * 8 + k] : 0);
        if (this.stamp[ni] !== cur || ng < this.g[ni]) {
          this.stamp[ni] = cur;
          this.g[ni] = ng;
          this.parent[ni] = node;
          this.push(ni, ng + heur(nx, ny) * 1.001);
        }
      }
    }
    const path: number[] = [];
    let n = best;
    while (n !== start && n !== -1) {
      path.push(n);
      n = this.parent[n];
    }
    path.reverse();
    const res = this.smooth(sx, sy, path);
    if (this.cache.size >= 256) this.cache.clear();
    this.cache.set(key, res);
    return res.slice();
  }

  /** Straight walkable line between tile centers (supercover walk). */
  lineClear(x0: number, y0: number, x1: number, y1: number): boolean {
    let dx = Math.abs(x1 - x0);
    let dy = Math.abs(y1 - y0);
    let x = x0;
    let y = y0;
    const sx = x1 > x0 ? 1 : -1;
    const sy = y1 > y0 ? 1 : -1;
    let err = dx - dy;
    dx *= 2;
    dy *= 2;
    let n = 1 + Math.abs(x1 - x0) + Math.abs(y1 - y0);
    const bl = this.block;
    const w = this.w;
    // (bits of the steps: +x 0 / -x 1, +y 2 / -y 3, diagonals 4..7 as in slope.ts)
    const kx = sx > 0 ? 0 : 1;
    const ky = sy > 0 ? 2 : 3;
    const kd = sx > 0 ? (sy > 0 ? 4 : 5) : sy > 0 ? 6 : 7;
    while (n-- > 0) {
      if (!this.passable(x, y)) return false;
      if (n === 0) break;
      const b = bl ? bl[y * w + x] : 0;
      if (err > 0) {
        if (b & (1 << kx)) return false;
        x += sx;
        err -= dy;
      } else if (err < 0) {
        if (b & (1 << ky)) return false;
        y += sy;
        err += dx;
      } else {
        // passes exactly through a corner: both neighbours must be free
        if (!this.passable(x + sx, y) || !this.passable(x, y + sy)) return false;
        if (b & (1 << kd)) return false;
        x += sx;
        y += sy;
        err += dx - dy;
        n--;
      }
    }
    return true;
  }

  private smooth(sx: number, sy: number, path: number[]): number[] {
    if (path.length < 3) return path;
    const w = this.w;
    const out: number[] = [];
    let ax = sx;
    let ay = sy;
    let i = 0;
    while (i < path.length) {
      let j = Math.min(path.length - 1, i + 12);
      for (; j > i; j--) {
        const px = path[j] % w;
        const py = (path[j] - px) / w;
        if (this.lineClear(ax, ay, px, py)) break;
      }
      out.push(path[j]);
      ax = path[j] % w;
      ay = (path[j] - ax) / w;
      i = j + 1;
    }
    return out;
  }
}
