import { DEFS } from '../sim/defs';
import type { FogOfWar } from './fog';
import { AIRCRAFT, createMunition } from './models/aircraft';
import { BUILDINGS } from './models/buildings';
import { overrideModel } from './models/gltf';
import { INFANTRY } from './models/infantry';
import { createModel as legacyModel } from './models/legacy';
import type { Builder } from './models/registry';
import type { Model, ModelStyle } from './models/types';
import { VEHICLES } from './models/vehicles';

export type { AnimState, Model, ModelStyle, MunitionKind, MunitionModel, Region } from './models/types';
export { FACTION_REGION } from './models/types';
export { createMunition };
export { loadModelOverrides } from './models/gltf';

let footprints: Map<string, { w: number; h: number }> | null = null;
function footprintOf(key: string) {
  if (!footprints) {
    footprints = new Map();
    for (const d of Object.values(DEFS)) if (d.kind === 'building') footprints.set(d.model, { w: d.w, h: d.h });
  }
  return footprints.get(key);
}

const ALL: Record<string, Builder>[] = [BUILDINGS, VEHICLES, AIRCRAFT, INFANTRY];

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
