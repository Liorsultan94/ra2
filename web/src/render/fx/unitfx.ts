import * as THREE from 'three';
import type { Effects } from '../effects';
import type { Model } from '../models';

/*
 * Per-entity effect emitters driven by the renderer: battle damage
 * (Model.damageFx), decoy flares (Model.flareDispensers), shell casings.
 * Kept out of renderer.ts so the shared file only holds one-line calls.
 */

const WP = new THREE.Vector3();

/**
 * Emit battle-damage particles from a model's damageFx points (root-local
 * positions, transformed by root.matrixWorld - buildings update the array in
 * place). Smoke points grow into tall wind-blown columns as damage rises.
 * Returns false when the model has no damageFx (caller falls back to generic smoke).
 * scale ~ model size (1 for vehicles, building footprint for buildings).
 */
export function emitDamageFx(fx: Effects, m: Model, damage: number, dt: number, scale = 1): boolean {
  const pts = m.damageFx;
  if (!pts || !pts.length) return false;
  const mw = m.root.matrixWorld;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (damage < p.at) continue;
    const sev = Math.min(1, (damage - p.at) / Math.max(0.05, 1 - p.at) + 0.25);
    WP.copy(p.pos).applyMatrix4(mw);
    if (p.kind === 'smoke') {
      if (Math.random() < dt * (3 + 6 * sev)) fx.column(WP.x, WP.y, WP.z, (0.45 + 0.45 * sev) * scale, true);
    } else if (p.kind === 'fire') {
      if (Math.random() < dt * (10 + 10 * sev)) fx.flame(WP.x, WP.y, WP.z, (0.45 + 0.35 * sev) * Math.sqrt(scale));
      if (Math.random() < dt * 3) fx.column(WP.x, WP.y + 0.2, WP.z, 0.55 * scale, true);
      fx.burnGlow(WP.x, WP.y, WP.z, (1 + sev) * Math.sqrt(scale));
    } else if (Math.random() < dt * (1 + 2 * sev)) fx.spark(WP.x, WP.y, WP.z, 0xffd080);
  }
  return true;
}

/** Aircraft under missile attack: pop a flare salvo from each dispenser (or the model centre). */
export function popFlares(fx: Effects, m: Model, yaw: number) {
  // renderer yaw is -facing; forward in world xz
  const f = -yaw;
  const fxv = Math.cos(f);
  const fzv = Math.sin(f);
  m.root.updateMatrixWorld(true);
  const ds = m.flareDispensers;
  if (ds && ds.length) {
    for (const d of ds) {
      d.getWorldPosition(WP);
      fx.flares(WP, fxv, fzv, Math.max(2, Math.round(6 / ds.length)));
    }
  } else {
    WP.copy(m.root.position);
    fx.flares(WP, fxv, fzv, 4);
  }
}

/** Spent case thrown out of the breech / receiver, to the right of the firing direction. */
export function ejectCasing(fx: Effects, m: Model, dirX: number, dirZ: number, big: boolean) {
  const r = m.root.position;
  const h = (m.height ?? 0.5) * (big ? 0.75 : 0.85);
  // right-hand side of the barrel in the ground plane
  const sx = -dirZ;
  const sz = dirX;
  fx.casing(r.x + sx * 0.12 - dirX * 0.1, r.y + h, r.z + sz * 0.12 - dirZ * 0.1, sx, sz, big ? 2.4 : 1);
}
