import * as THREE from 'three';
import { Tile, WATER_LEVEL, groundHeight, type GameMap } from '../sim/map';
import { fbm } from '../sim/rng';
import { APRON_W, SUB, surfaceHeight } from './ground';
import type { ChannelSample, HorizonWorld } from './horizonworld';
import type { BiomeLook } from './biome';

/*
 * The battlefield ground carried on past the map edge (render only).
 *
 * A band APRON_W units wide round the map drawn with the terrain's own material, so the in-map
 * ground (photo layers, grass, sand ripples, snow) runs on without a seam; over its outer half it
 * melts into the outskirts' colour (ground.ts, the APRON block), and the outskirts mesh takes over
 * under its rim. The shader can't read the control textures out here (they would only clamp), so
 * the ground's control values (splat / tint / grass / snow) come per vertex, painted by a reduced
 * version of the in-map painter (ground.ts paint): the map's own values at the edge, then the same
 * noise fields at the real position, the tile types mirrored back into the map (the sand / dirt
 * patches continue), banks / wadi floor by height (channels run on in their own direction,
 * horizonworld.ts) and slopes turning rocky.
 *
 * Grid: 0.5 apart along the edge (the terrain edge's own vertices, no cracks), rows 0.5 .. 1.5 apart
 * across; split into 24-unit pieces so off-screen ones are culled. ~13k vertices in all.
 */

/** Rows of the apron (distance past the edge). */
const ROWS = [0, 0.5, 1, 1.5, 2, 3, 4, 5, 6, 7, 8, 9.5, 11, 12.5, 14, 15.5, 17, 18, 19, APRON_W];

const ss = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface ApronInputs {
  map: GameMap;
  world: HorizonWorld;
  look: BiomeLook;
  /** The terrain's painted control maps (ground.ts) and its material. */
  splat: Uint8Array;
  tint: Uint8Array;
  ctl: Uint8Array;
  res: number;
  material: THREE.Material;
  /** The outskirts' ground colour at (x, y) (sRGB 0-1), the apron fades into it. */
  edgeColour: (x: number, y: number, out: number[]) => void;
}

/** Apron surface height at (x, y) (inside the map: the terrain's surface). */
export function apronHeight(m: GameMap, world: HorizonWorld, x: number, y: number) {
  const d = world.outside(x, y);
  const cx = Math.max(0, Math.min(m.w, x));
  const cy = Math.max(0, Math.min(m.h, y));
  if (d <= 1e-6) return surfaceHeight(m, cx, cy);
  // the terrain's fine surface noise at the edge eases out; a hair above the outskirts under the rim
  const sn = surfaceHeight(m, cx, cy) - groundHeight(m, cx, cy);
  return world.height(x, y, false) + sn * (1 - ss(0, 4, d)) + 0.04 * ss(APRON_W - 8, APRON_W - 3, d);
}

export function* buildApron(I: ApronInputs, out: THREE.Mesh[]): Generator<void> {
  const { map: m, world } = I;
  const { w, h } = m;
  const bc = I.look.code;
  const N = m.w * I.res;
  const ch: ChannelSample = { bed: Infinity, valley: 0, wet: 0, t: 0, d: 0, sx: 0, sy: 0 };
  const ec = [0, 0, 0];
  // the terrain's edge normals, as ground.ts computes them (central differences on its 0.5 grid, clamped)
  const sH = (x: number, y: number) => surfaceHeight(m, Math.max(0, Math.min(w, x)), Math.max(0, Math.min(h, y)));
  const H = (x: number, y: number) => apronHeight(m, world, x, y);
  const tileW = (tx: number, ty: number, o: number[]) => {
    const t = m.tiles[Math.max(0, Math.min(h - 1, ty)) * w + Math.max(0, Math.min(w - 1, tx))];
    o[0] = t === Tile.Dirt ? (bc === 3 ? 1 : 0.62) : 0;
    o[1] = 0;
    o[2] = t === Tile.Sand ? (bc === 1 ? 1 : 0.85) : 0;
  };
  const tw4 = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]];

  const vertex = (x: number, y: number, d: number, pos: number[], nor: number[], aS: number[], aT: number[], aC: number[], aO: number[]) => {
    const edge = d <= 1e-6;
    const hy = H(x, y);
    pos.push(x, hy, y);
    // normal
    let dx: number;
    let dz: number;
    if (edge) {
      // ground.ts: (h(i + 1) - h(i - 1)) * SUB * 0.5 with clamped neighbours
      const e = 1 / SUB;
      dx = (sH(Math.min(w, x + e), y) - sH(Math.max(0, x - e), y)) * SUB * 0.5;
      dz = (sH(x, Math.min(h, y + e)) - sH(x, Math.max(0, y - e))) * SUB * 0.5;
    } else {
      const e = 0.5;
      dx = (H(x + e, y) - H(x - e, y)) / (2 * e);
      dz = (H(x, y + e) - H(x, y - e)) / (2 * e);
    }
    const l = Math.hypot(dx, 1, dz);
    nor.push(-dx / l, 1 / l, -dz / l);
    // the map's own control values at the nearest edge texel
    const cx = Math.max(0, Math.min(w - 1e-3, x));
    const cy = Math.max(0, Math.min(h - 1e-3, y));
    const k = (Math.min(N - 1, Math.floor(cy * I.res)) * N + Math.min(N - 1, Math.floor(cx * I.res))) * 4;
    const eS = [I.splat[k] / 255, I.splat[k + 1] / 255, I.splat[k + 2] / 255, I.splat[k + 3] / 255];
    const eT = [I.tint[k] / 255, I.tint[k + 1] / 255, I.tint[k + 2] / 255, I.tint[k + 3] / 255];
    const eC = [I.ctl[k] / 255, I.ctl[k + 1] / 255, I.ctl[k + 2] / 255, I.ctl[k + 3] / 255];
    // ---- the reduced painter at the real position
    world.channelAt(x, y, ch);
    const val = d > 0 ? ch.valley : 0;
    // tile types mirrored back into the map (bilinear between tile centres)
    const mx = Math.max(0.5, Math.min(w - 0.5, x < 0 ? -x : x > w ? 2 * w - x : x)) - 0.5;
    const my = Math.max(0.5, Math.min(h - 0.5, y < 0 ? -y : y > h ? 2 * h - y : y)) - 0.5;
    const x0 = Math.floor(mx);
    const y0 = Math.floor(my);
    const fx = mx - x0;
    const fy = my - y0;
    tileW(x0, y0, tw4[0]);
    tileW(x0 + 1, y0, tw4[1]);
    tileW(x0, y0 + 1, tw4[2]);
    tileW(x0 + 1, y0 + 1, tw4[3]);
    const tl = (c: number) => (tw4[0][c] * (1 - fx) + tw4[1][c] * fx) * (1 - fy) + (tw4[2][c] * (1 - fx) + tw4[3][c] * fx) * fy;
    const pn = fbm(x * 0.7, y * 0.7, 51, 3);
    let dirt = tl(0) * (1 - val);
    let sand = tl(2) * (1 - val * 0.6);
    let mud = 0;
    if (bc !== 3) dirt *= ss(0.25, 0.6, pn + dirt * 0.45);
    const slope = Math.abs(H(x + 0.3, y) - hy) + Math.abs(H(x, y + 0.3) - hy);
    let rock = ss(0.16, 0.34, slope + (pn - 0.5) * 0.12);
    const wl = hy - WATER_LEVEL;
    if (bc === 1) {
      // the wadi floor: gravelly dirt drying into cracked mud, sand banks
      const floor = val * (1 - ss(0.02, 0.32, hy));
      dirt = Math.max(dirt, floor * 0.62);
      mud = Math.max(mud, floor * 0.55 * ss(0.25, 0.55, pn + 0.15));
      sand = Math.max(sand, 1 - floor);
      // a spring's margin: dark wet sand and mud
      if (wl < 0.3) mud = Math.max(mud, (1 - ss(-0.2, 0.3, wl)) * 0.65);
    } else if (bc === 3) {
      if (wl < 0.5) rock = Math.max(rock, 1 - ss(0.25, 0.5, wl));
    } else if (wl < 0.45) {
      const wet = 1 - ss(-0.05, 0.45, wl);
      sand = Math.max(sand, wet * 0.7 * ss(0.2, 0.55, pn + 0.2));
      mud = Math.max(mud, (1 - ss(-0.25, 0.12, wl)) * 0.6);
    }
    if (wl < 0) {
      mud = Math.max(mud, 0.55);
      sand = Math.max(sand, 0.2);
      rock = Math.max(rock, 0.25);
    }
    let tot = dirt + rock + sand + mud;
    if (tot > 1) {
      dirt /= tot;
      rock /= tot;
      sand /= tot;
      mud /= tot;
      tot = 1;
    }
    const mac = fbm(x * 0.09, y * 0.09, 21, 3);
    const bl = fbm(x * 0.45, y * 0.45, 33, 3);
    const br = 0.86 + mac * 0.24 + (bl - 0.5) * 0.16;
    const hue = (fbm(x * 0.13 + 7, y * 0.13, 61, 2) - 0.5) * 0.18;
    let r = br * (1 + hue);
    let g = br;
    let b = br * (1 - hue * 0.6);
    if (wl < 0.35) {
      const wet = 1 - ss(-0.1, 0.35, wl);
      r *= 1 - wet * 0.3;
      g *= 1 - wet * 0.27;
      b *= 1 - wet * 0.22;
    }
    let dry = ss(0.45, 0.8, fbm(x * 0.06, y * 0.06, 47, 3)) * 0.6 + Math.max(0, hy - 0.8) * 0.2 + (bl - 0.5) * 0.25;
    dry -= (1 - ss(0.1, 0.7, wl)) * 0.4;
    // lush banks along the rivers running on
    const dW = ch.wet > 0 && d > 0 ? Math.max(0, Math.abs(ch.t) - 4) : world.nearPond(x, y, 3) ? 0.5 : 1e3;
    let lush = (1 - ss(0.6, 6, dW)) * 0.8 + ss(0.5, -0.4, hy) * 0.35 + (fbm(x * 0.08 + 3, y * 0.08, 67, 3) - 0.45) * 0.9;
    lush -= slope * 1.6;
    lush = Math.max(0, Math.min(1, lush));
    dry = dry * 0.85 - lush * 0.45 + slope * 1.2;
    const dryC = Math.max(0, Math.min(1, dry));
    const clover = ss(0.58, 0.72, fbm(x * 0.3 + 11, y * 0.3, 71, 3)) * (1 - dryC * 0.8) * I.look.clover;
    let blue = ss(0.6, 0.76, fbm(x * 0.22, y * 0.22 + 5, 73, 3)) * (1 - dryC * 0.6) * I.look.flowers;
    if (bc === 2) {
      // winter: snow cover (thin on steep and wet ground)
      blue = (1 - ss(0.22, 0.5, slope + (pn - 0.5) * 0.1)) * (0.25 + 0.75 * ss(0.0, 0.35, wl));
    }
    // from the map's own values at the edge to the painter's within 3 units (roads, fields and yards end)
    const k3 = edge ? 0 : ss(0, 3, d);
    const gS = [dirt, rock, sand, mud];
    const gT = [Math.min(1, r / 2), Math.min(1, g / 2), Math.min(1, b / 2), dryC];
    const gC = [lush, clover, blue, 0];
    for (let j = 0; j < 4; j++) {
      aS.push(Math.round((eS[j] + (gS[j] - eS[j]) * k3) * 255));
      aT.push(Math.round((eT[j] + (gT[j] - eT[j]) * k3) * 255));
      aC.push(Math.round((eC[j] + (gC[j] - eC[j]) * k3) * 255));
    }
    I.edgeColour(x, y, ec);
    aO.push(Math.round(Math.min(1, ec[0]) * 255), Math.round(Math.min(1, ec[1]) * 255), Math.round(Math.min(1, ec[2]) * 255), 255);
  };

  const make = (nu: number, nv: number, at: (i: number, j: number) => [number, number, number], name: string) => {
    const pos: number[] = [];
    const nor: number[] = [];
    const aS: number[] = [];
    const aT: number[] = [];
    const aC: number[] = [];
    const aO: number[] = [];
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const [x, y, d] = at(i, j);
        vertex(x, y, d, pos, nor, aS, aT, aC, aO);
      }
    const idx: number[] = [];
    for (let j = 0; j < nv - 1; j++)
      for (let i = 0; i < nu - 1; i++) {
        const a = j * nu + i;
        const b2 = a + 1;
        const c = a + nu;
        const dd = c + 1;
        if ((i + j) & 1) idx.push(a, c, b2, b2, c, dd);
        else idx.push(a, c, dd, a, dd, b2);
      }
    // face up: flip the winding when the grid runs the other way round
    const p = (q: number) => new THREE.Vector3(pos[q * 3], pos[q * 3 + 1], pos[q * 3 + 2]);
    const n0 = new THREE.Vector3().crossVectors(p(idx[1]).sub(p(idx[0])), p(idx[2]).sub(p(idx[0])));
    if (n0.y < 0) for (let q = 0; q < idx.length; q += 3) [idx[q + 1], idx[q + 2]] = [idx[q + 2], idx[q + 1]];
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aApS', new THREE.Uint8BufferAttribute(aS, 4, true));
    geo.setAttribute('aApT', new THREE.Uint8BufferAttribute(aT, 4, true));
    geo.setAttribute('aApC', new THREE.Uint8BufferAttribute(aC, 4, true));
    geo.setAttribute('aApO', new THREE.Uint8BufferAttribute(aO, 4, true));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, I.material);
    mesh.receiveShadow = true;
    mesh.name = name;
    out.push(mesh);
  };

  const nr = ROWS.length;
  // the four sides, in 24-unit pieces
  for (let side = 0; side < 4; side++) {
    const len = side < 2 ? h : w;
    for (let u0 = 0; u0 < len; u0 += 24) {
      const u1 = Math.min(len, u0 + 24);
      const nu = Math.round((u1 - u0) * SUB) + 1;
      make(
        nu,
        nr,
        (i, j) => {
          const u = u0 + i / SUB;
          const d = ROWS[j];
          return side === 0 ? [-d, u, d] : side === 1 ? [w + d, u, d] : side === 2 ? [u, -d, d] : [u, h + d, d];
        },
        'ground-apron',
      );
      yield;
    }
  }
  // the corners
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [-1, 1],
    [1, 1],
  ]) {
    make(
      nr,
      nr,
      (i, j) => {
        const x = sx < 0 ? -ROWS[i] : w + ROWS[i];
        const y = sy < 0 ? -ROWS[j] : h + ROWS[j];
        return [x, y, Math.hypot(ROWS[i], ROWS[j])];
      },
      'ground-apron',
    );
  }
  yield;
}
