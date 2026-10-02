import { DEFS } from '../sim/defs';
import type { FogOfWar } from './fog';
import { AIRCRAFT, createMunition as createBaseMunition } from './models/aircraft';
import { BUILDINGS } from './models/buildings';
import { CARGO } from './models/cargo';
import { overrideModel } from './models/gltf';
import { INFANTRY } from './models/infantry';
import { EXTRA_MUNITIONS, createExtraMunition, type ExtraMunitionKind } from './models/munitions';
import { createModel as legacyModel } from './models/legacy';
import type { Builder } from './models/registry';
import type { Model, ModelStyle, MunitionKind, MunitionModel } from './models/types';
import { VEHICLES } from './models/vehicles';

export type { AnimState, Model, ModelStyle, MunitionKind, MunitionModel, Region } from './models/types';
export { FACTION_REGION } from './models/types';
export { loadModelOverrides } from './models/gltf';

let footprints: Map<string, { w: number; h: number }> | null = null;
function footprintOf(key: string) {
  if (!footprints) {
    footprints = new Map();
    for (const d of Object.values(DEFS)) if (d.kind === 'building') footprints.set(d.model, { w: d.w, h: d.h });
  }
  return footprints.get(key);
}

const ALL: Record<string, Builder>[] = [BUILDINGS, VEHICLES, AIRCRAFT, INFANTRY, CARGO];

/** Build the model for a model key: glTF override > detailed builder > legacy builder. */
export function createModel(key: string, style: ModelStyle, fog: FogOfWar | null): Model {
  const fp = footprintOf(key);
  const o = overrideModel(key, style, fog, fp);
  if (o) return o;
  for (const reg of ALL) {
    const b = reg[key];
    if (!b) continue;
    try {
      return b(style, fog);
    } catch (e) {
      console.error('model builder failed', key, e);
    }
  }
  return legacyModel(key, style, fog) as Model;
}

/** Projectile visual: the newer missile families live in munitions.ts, the rest in aircraft.ts. */
export function createMunition(kind: MunitionKind | ExtraMunitionKind, team: number): MunitionModel | null {
  if (EXTRA_MUNITIONS.has(kind)) return createExtraMunition(kind as ExtraMunitionKind, team);
  return createBaseMunition(kind as MunitionKind, team);
}
