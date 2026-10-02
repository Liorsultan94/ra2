import { groundHeight, type GameMap } from '../../sim/map';

/**
 * Conservative "could anything hide this unit?" test for the x-ray
 * silhouettes (xray.ts): every unit carries a few proxy meshes that only
 * draw where the unit is behind something, but they cost draw calls for
 * every unit on screen. A coarse per-tile grid of occluder tops (trees,
 * buildings) plus the terrain is ray-marched from the unit's base towards
 * the camera; units in the open skip their proxies. False positives only
 * cost the old draw calls, so the grid errs on the tall / wide side.
 */
export class OccluderGrid {
  private trees: Float32Array;
  private top: Float32Array;
  private bkey = '';

  constructor(
    private map: GameMap,
    trees: { x: number; y: number; s: number }[],
  ) {
    const { w, h } = map;
    this.trees = new Float32Array(w * h);
    for (const t of trees) {
      const r = 0.45 * t.s + 0.1;
      const top = 1.2 * t.s + 0.1;
      for (let y = Math.floor(t.y - r); y <= Math.floor(t.y + r); y++)
        for (let x = Math.floor(t.x - r); x <= Math.floor(t.x + r); x++) {
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const i = y * w + x;
          if (this.trees[i] < top) this.trees[i] = top;
        }
    }
    this.top = this.trees.slice();
  }

  /** Rebuild the building part (cheap; skipped when the building set is unchanged). */
  setBuildings(list: { id: number; tx: number; ty: number; w: number; h: number; height: number }[]) {
    let key = '';
    for (const b of list) key += b.id + ',';
    if (key === this.bkey) return;
    this.bkey = key;
    const { w, h } = this.map;
    this.top.set(this.trees);
    for (const b of list) {
      const top = b.height + 0.2;
      for (let y = Math.max(0, b.ty - 1); y < Math.min(h, b.ty + b.h + 1); y++)
        for (let x = Math.max(0, b.tx - 1); x < Math.min(w, b.tx + b.w + 1); x++) {
          // a one-tile margin covers roofs / chimneys hanging over the footprint
          const edge = x < b.tx || y < b.ty || x >= b.tx + b.w || y >= b.ty + b.h;
          const t = edge ? top * 0.6 : top;
          const i = y * w + x;
          if (this.top[i] < t) this.top[i] = t;
        }
    }
  }

  /**
   * Could the point (x, baseY, z) be hidden from a camera in direction
   * (dx, dy, dz) (unit vector from the scene towards the camera)?
   */
  mayHide(x: number, baseY: number, z: number, dx: number, dy: number, dz: number): boolean {
    const m = this.map;
    const hl = Math.hypot(dx, dz);
    if (hl < 1e-4) return false;
    const ux = dx / hl;
    const uz = dz / hl;
    const slope = dy / hl;
    const step = 0.35;
    const y0 = baseY + 0.04;
    for (let d = step; d < 7; d += step) {
      const ry = y0 + d * slope;
      if (ry > 4.5) break;
      const sx = x + ux * d;
      const sz = z + uz * d;
      if (sx < 0 || sz < 0 || sx >= m.w || sz >= m.h) break;
      const i = Math.floor(sz) * m.w + Math.floor(sx);
      const occ = this.top[i];
      const g = groundHeight(m, sx, sz);
      if (g + occ > ry) return true;
    }
    return false;
  }
}
