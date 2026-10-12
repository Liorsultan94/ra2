import * as THREE from 'three';
import { groundHeight, type GameMap } from '../sim/map';
import { assetBase, fetchBitmap } from './photoground';

/*
 * The ground under and round the base structures (render only; the sim's footprint rules are untouched).
 *
 *  - PADS: every structure levels the ground under its footprint (to its own base height) and blends the
 *    levelled ground back into the natural slope over ~0.8 tile, so it stands ON the ground with no
 *    floating or buried edges. `surfaceHeight` (ground.ts) applies them, so the ground mesh, the battle-scar
 *    decals and the apron all agree; `padDelta` gives everything else standing on the sim's height (units,
 *    rubble, contact shadows) the same lift. A pad is kept when the structure is destroyed (the rubble sits
 *    on the levelled ground) and replaced when a new one goes up on the spot.
 *  - SITE MAP: one RGBA8 texture over the map, painted from the pads: R = disturbed soil (a soft band round
 *    the footprint, 1 under it), G / B / A = a vehicle lane out of the front of the vehicle structures
 *    (offset across it, strength, tracked / wheeled). The terrain shader (ground.ts, SITE_MAP) turns it into
 *    compacted soil, scuffs and tyre / track ruts per biome (grass scuffed to dirt, sand drift in the desert,
 *    trampled snow in winter, dust and gravel in the city) and a soft ambient occlusion at the base, from two
 *    small baked height maps (tools/blender/gx4_basesoil.py: public/tex/basesoil/). No concrete, no lines.
 */

export interface Pad {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Level surface height. */
  h: number;
  /** 0 none, 1 tracked lane out of the front, 2 wheeled lane. */
  lane: number;
}

/** Blend distance (tiles) from the levelled footprint back to the natural ground. */
const BLEND = 0.85;
/** The levelled ground reaches this far past the footprint edge before blending (the walls stand on flat ground). */
const LEVEL_MARGIN = 0.12;
/** Disturbed soil band (tiles) round a footprint. */
const BAND = 1.15;

const ss = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export class PadSet {
  readonly pads: Pad[] = [];
  /** Per tile: the pads whose blend reaches it. */
  private cells: Pad[][];
  version = 0;
  private listeners: ((r: [number, number, number, number]) => void)[] = [];
  constructor(readonly map: GameMap) {
    this.cells = Array.from({ length: map.w * map.h }, () => []);
  }

  onChange(fn: (r: [number, number, number, number]) => void) {
    this.listeners.push(fn);
  }

  private reach() {
    return BLEND + LEVEL_MARGIN + 0.05;
  }

  private index(p: Pad, add: boolean) {
    const m = this.map;
    const r = this.reach();
    const tx0 = Math.max(0, Math.floor(p.x0 - r));
    const tx1 = Math.min(m.w - 1, Math.floor(p.x1 + r));
    const ty0 = Math.max(0, Math.floor(p.y0 - r));
    const ty1 = Math.min(m.h - 1, Math.floor(p.y1 + r));
    for (let y = ty0; y <= ty1; y++)
      for (let x = tx0; x <= tx1; x++) {
        const c = this.cells[y * m.w + x];
        if (add) c.push(p);
        else {
          const i = c.indexOf(p);
          if (i >= 0) c.splice(i, 1);
        }
      }
  }

  /** Level the ground under a footprint (tile rectangle) to height h. Replaces pads it covers. */
  add(x0: number, y0: number, x1: number, y1: number, h: number, lane = 0) {
    const gone: Pad[] = [];
    for (const q of this.pads) if (q.x0 < x1 && q.x1 > x0 && q.y0 < y1 && q.y1 > y0) gone.push(q);
    let dirty: [number, number, number, number] = [x0 - 3, y0 - 3, x1 + 3, y1 + 3];
    for (const q of gone) {
      this.index(q, false);
      this.pads.splice(this.pads.indexOf(q), 1);
      dirty = [Math.min(dirty[0], q.x0 - 3), Math.min(dirty[1], q.y0 - 3), Math.max(dirty[2], q.x1 + 3), Math.max(dirty[3], q.y1 + 3)];
    }
    const p: Pad = { x0, y0, x1, y1, h, lane };
    this.pads.push(p);
    this.index(p, true);
    this.version++;
    for (const l of this.listeners) l(dirty);
  }

  /** Weight (0..1) of a pad at (x, y): 1 over the footprint and its margin, easing to 0 over BLEND. */
  weight(p: Pad, x: number, y: number) {
    const dx = Math.max(p.x0 - x, 0, x - p.x1);
    const dy = Math.max(p.y0 - y, 0, y - p.y1);
    const d = Math.hypot(dx, dy) - LEVEL_MARGIN;
    return d <= 0 ? 1 : d >= BLEND ? 0 : 1 - ss(0, BLEND, d);
  }

  /** Surface height at (x, y) given the natural height there. */
  apply(x: number, y: number, base: number) {
    const m = this.map;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return base;
    const c = this.cells[ty * m.w + tx];
    for (let i = 0; i < c.length; i++) {
      const w = this.weight(c[i], x, y);
      if (w > 0) base += (c[i].h - base) * w;
    }
    return base;
  }

  /** How far the pads lift (or lower) the sim's ground at (x, y): for what stands on the sim's height. */
  delta(x: number, y: number) {
    const m = this.map;
    const tx = Math.floor(x);
    const ty = Math.floor(y);
    if (tx < 0 || ty < 0 || tx >= m.w || ty >= m.h) return 0;
    const c = this.cells[ty * m.w + tx];
    if (!c.length) return 0;
    const g = groundHeight(m, x, y);
    return this.apply(x, y, g) - g;
  }
}

// ---- the active pad set (one battlefield at a time: the Terrain binds it)
let active: PadSet | null = null;

export function bindPads(p: PadSet | null) {
  active = p;
}

export function padsFor(m: GameMap): PadSet | null {
  return active && active.map === m ? active : null;
}

/** Surface height with the pads applied (the ground's own formula calls this with its natural height). */
export function padSurface(m: GameMap, x: number, y: number, base: number): number {
  return active && active.map === m && active.pads.length ? active.apply(x, y, base) : base;
}

/** Lift of the pads over the sim's ground at (x, y) (0 away from every structure). */
export function padDelta(m: GameMap, x: number, y: number): number {
  return active && active.map === m && active.pads.length ? active.delta(x, y) : 0;
}

// ---- the site map

/** Texels per tile of the site map. */
export const SITE_RES = 6;

export class SiteMap {
  readonly data: Uint8Array;
  readonly tex: THREE.DataTexture;
  readonly scuff: { value: THREE.Texture };
  readonly track: { value: THREE.Texture };
  private n: number;
  private dirty = true;
  private readonly w: number;
  private readonly h: number;

  constructor(private pads: PadSet) {
    const m = pads.map;
    this.w = m.w * SITE_RES;
    this.h = m.h * SITE_RES;
    this.n = this.w * this.h;
    this.data = new Uint8Array(this.n * 4);
    this.tex = new THREE.DataTexture(this.data, this.w, this.h, THREE.RGBAFormat, THREE.UnsignedByteType);
    this.tex.magFilter = THREE.LinearFilter;
    this.tex.minFilter = THREE.LinearFilter;
    this.tex.generateMipmaps = false;
    this.tex.wrapS = this.tex.wrapT = THREE.ClampToEdgeWrapping;
    this.tex.flipY = false;
    this.tex.needsUpdate = true;
    // (until the baked height maps arrive: flat, i.e. no relief)
    const flat = (w: number, h: number) => {
      const d = new Uint8Array(w * h * 4).fill(128);
      const t = new THREE.DataTexture(d, w, h, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.magFilter = t.minFilter = THREE.LinearFilter;
      t.needsUpdate = true;
      return t;
    };
    this.scuff = { value: flat(2, 2) };
    this.track = { value: flat(2, 2) };
    pads.onChange(() => (this.dirty = true));
    void this.load();
  }

  private async load() {
    try {
      const base = `${assetBase()}tex/basesoil/`;
      const [a, b] = await Promise.all([fetchBitmap(`${base}scuff.webp`), fetchBitmap(`${base}track.webp`)]);
      const mk = (bm: ImageBitmap) => {
        const t = new THREE.Texture(bm);
        t.wrapS = t.wrapT = THREE.RepeatWrapping;
        t.magFilter = THREE.LinearFilter;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.generateMipmaps = true;
        t.anisotropy = 4;
        t.colorSpace = THREE.NoColorSpace;
        t.flipY = false;
        t.needsUpdate = true;
        return t;
      };
      this.scuff.value = mk(a);
      this.track.value = mk(b);
    } catch {
      /* the flat maps stay: soil band and AO without the scuff relief */
    }
  }

  /** Repaint the site map from the pads if any changed. */
  update() {
    if (!this.dirty) return;
    this.dirty = false;
    this.paint();
    this.tex.needsUpdate = true;
  }

  private paint() {
    const d = this.data;
    d.fill(0);
    const W = this.w;
    const H = this.h;
    for (const p of this.pads.pads) {
      const x0 = Math.max(0, Math.floor((p.x0 - BAND) * SITE_RES));
      const x1 = Math.min(W - 1, Math.ceil((p.x1 + BAND) * SITE_RES));
      const lane = p.lane;
      const cx = (p.x0 + p.x1) / 2;
      const yEnd = p.y1 + 2.6;
      const y0 = Math.max(0, Math.floor((p.y0 - BAND) * SITE_RES));
      const y1 = Math.min(H - 1, Math.ceil((lane ? yEnd + 0.3 : p.y1 + BAND) * SITE_RES));
      for (let py = y0; py <= y1; py++)
        for (let px = x0; px <= x1; px++) {
          const x = (px + 0.5) / SITE_RES;
          const y = (py + 0.5) / SITE_RES;
          const dx = Math.max(p.x0 - x, 0, x - p.x1);
          const dy = Math.max(p.y0 - y, 0, y - p.y1);
          const dist = Math.hypot(dx, dy);
          const o = (py * W + px) * 4;
          const r = Math.round(255 * (1 - ss(0, BAND, dist)));
          if (r > d[o]) d[o] = r;
          if (lane) {
            const off = x - cx;
            const along = y - p.y1;
            const b = ss(0.62, 0.3, Math.abs(off)) * ss(-1.1, -0.2, along) * (1 - ss(0.15, 2.6, along));
            const bb = Math.round(255 * b);
            if (bb > d[o + 2]) {
              d[o + 1] = Math.round(255 * Math.max(0, Math.min(1, off / 1.2 + 0.5)));
              d[o + 2] = bb;
              d[o + 3] = lane === 2 ? 255 : 0;
            }
          }
        }
    }
  }

  dispose() {
    this.tex.dispose();
    this.scuff.value.dispose();
    this.track.value.dispose();
  }
}
