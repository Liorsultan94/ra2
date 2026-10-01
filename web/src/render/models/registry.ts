import type { FogOfWar } from '../fog';
import type { Model, ModelStyle } from './types';

export type Builder = (style: ModelStyle, fog: FogOfWar | null) => Model;
