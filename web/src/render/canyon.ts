import * as THREE from 'three';
import type { GameMap } from '../sim/map';
import { hash2 } from '../sim/rng';
import type { FogOfWar } from './fog';
import { surfaceHeight } from './ground';
import { landmarkMaterial } from './landmarks/material';
import { Kit } from './models/landmarks';

/*
 * Wadi Al-Rimal's coloured canyons (render only; the sim carves them: sim/maps.ts DESERT_CANYON, mirrored). The
 * cliff relief bands the walls (relief.ts: the strata by height) and the ground shader the talus (ground.ts); here
 * the canyon's sandy floor gets what fell from them: sandstone blocks in the wall colours, and here and there a
 * weathered, banded pillar standing out from the foot of a wall. One merged mesh per canyon on the landmarks'
 * shared program (one draw call each, culled on its own); nothing glows.
 */

/** Strata colours from the floor up (repeating): the same order and band height as relief.ts / ground.ts. */
export const STRATA_RGB = [0xa8503a, 0xc0884a, 0xd8b878, 0x8a5a78, 0xe8e0cc, 0x8e3e30, 0xc89a62];
/** Bands per world unit of height. */
export const STRATA_PER_UNIT = 3.3;

export function buildCanyons(map: GameMap, fog: FogOfWar): THREE.Group | null {
  const list = map.deco?.canyons;
  if (!list?.length) return null;
  const group = new THREE.Group();
  group.name = 'canyons';
  group.userData.perfCat = 'canyons';
  const gh = (x: number, z: number) => surfaceHeight(map, Math.max(0, Math.min(map.w, x)), Math.max(0, Math.min(map.h, z)));
  const band = (y: number) => {
    const n = Math.floor(y * STRATA_PER_UNIT);
    return ((n % STRATA_RGB.length) + STRATA_RGB.length) % STRATA_RGB.length;
  };
  const col = new THREE.Color();
  list.forEach((c, ci) => {
    const k = new Kit();
    const h = (i: number, j: number) => hash2(i, j + ci * 31, 4481);
    let n = 0;
    for (let s = 0; s < c.pts.length - 1; s++) {
      const ax = c.pts[s].x + 0.5;
      const az = c.pts[s].y + 0.5;
      const bx = c.pts[s + 1].x + 0.5;
      const bz = c.pts[s + 1].y + 0.5;
      const len = Math.hypot(bx - ax, bz - az);
      const tx = (bx - ax) / len;
      const tz = (bz - az) / len;
      for (let t = 0.3; t < len; t += 0.45, n++) {
        const cx = ax + tx * t;
        const cz = az + tz * t;
        // fallen blocks, mostly near the walls
        if (h(n, 1) < 0.34) {
          const side = h(n, 2) < 0.5 ? -1 : 1;
          const off = side * c.hw * (0.45 + h(n, 3) * 0.5);
          const x = cx - tz * off;
          const z = cz + tx * off;
          const s = 0.05 + h(n, 4) * 0.08;
          col.setHex(STRATA_RGB[Math.floor(h(n, 5) * STRATA_RGB.length)]).multiplyScalar(0.85 + h(n, 6) * 0.2);
          k.at(x, gh(x, z) - s * 0.35, z, h(n, 7) * 6);
          k.box(s * 2.2, s * 1.3, s * 1.6, 0, s * 0.5, 0, col, 0, 0, (h(n, 8) - 0.5) * 0.5, (h(n, 9) - 0.5) * 0.5);
          if (h(n, 10) < 0.4) k.box(s * 1.1, s * 0.8, s * 1.0, s * 1.4, s * 0.3, s * 0.6, col.multiplyScalar(0.9), 0, h(n, 11) * 2);
        }
        // a weathered pillar at the foot of a wall: stacked, banded, narrowing, a pale cap rock
        if (h(n, 20) < 0.07) {
          const side = h(n, 21) < 0.5 ? -1 : 1;
          const off = side * c.hw * 0.78;
          const x = cx - tz * off;
          const z = cz + tx * off;
          let y = gh(x, z) - 0.03;
          const stack = 3 + Math.floor(h(n, 22) * 3);
          k.at(x, 0, z, h(n, 23) * 6);
          let r = 0.11 + h(n, 24) * 0.05;
          for (let i = 0; i < stack; i++) {
            const hh = 0.08 + h(n, 25 + i) * 0.07;
            col.setHex(STRATA_RGB[band(y + hh / 2)]);
            k.cyl(r, r * 0.9, hh, 0, y, 0, col, 7);
            y += hh;
            r *= 0.84 + h(n, 32 + i) * 0.1;
          }
          col.setHex(STRATA_RGB[4]);
          k.cyl(r * 1.35, r * 1.15, 0.04, 0, y, 0, col, 7);
        }
      }
    }
    if (!k.count) return;
    const mesh = new THREE.Mesh(k.build(), landmarkMaterial(fog));
    mesh.name = 'canyon';
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    group.add(mesh);
  });
  return group.children.length ? group : null;
}
