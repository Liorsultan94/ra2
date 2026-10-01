import type { Builder } from './registry';

/** Model builders keyed by model key (see sim/defs.ts `model` fields). */
export const AIRCRAFT: Record<string, Builder> = {};

import type { MunitionKind, MunitionModel } from './types';

/** Projectile visual (forward = +X). Returns null to use the renderer's simple fallback. */
export function createMunition(_kind: MunitionKind, _team: number): MunitionModel | null {
  return null;
}
