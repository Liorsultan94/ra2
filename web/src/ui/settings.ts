// Player settings (main menu, skirmish setup and pause menu; src/ui/menu.ts), saved in localStorage.

import type { Difficulty } from '../sim/ai';
import type { Faction, FogMode } from '../sim/types';
import type { MapId } from '../sim/map';
import type { Quality } from '../render/renderer';
import { isPeaceOption, type PeaceOption } from '../sim/peace';
import { isGameSpeed, type GameSpeed } from '../game/pace';
import { setReadabilityPrefs } from '../render/readability';

export interface Settings {
  faction: Faction;
  enemy: Faction | 'random';
  difficulty: Difficulty;
  credits: number;
  quality: Quality | 'auto';
  sfx: number;
  music: number;
  voice: boolean;
  /** Slow-motion camera moments on big events (missile launches, interceptions, huge blasts). */
  cinematic: boolean;
  /** Skirmish map (sim/maps.ts; ?map= overrides it). */
  map?: MapId;
  /**
   * Skirmish atmosphere (visual only; read by src/render/atmos.ts). Unset = the live day ('cycle':
   * 1 real minute = 1 game hour, from 05:30) with dynamic weather following the map's climate;
   * weather 'map' = the map's own fixed weather.
   */
  tod?: 'day' | 'dusk' | 'night' | 'cycle' | 'mist';
  weather?: 'map' | 'clear' | 'rain' | 'snow' | 'sandstorm' | 'dynamic';
  /** Drone camera picture-in-picture: 'auto' shows the feed of a selected / attacking drone. */
  droneCam: 'auto' | 'off';
  /** Team-coloured silhouettes of units hidden behind buildings and trees. */
  xray: boolean;
  /** Team-coloured strategic unit icons when zoomed out (src/render/readability.ts). */
  icons?: boolean;
  /** Thin team-coloured outline around every unit. */
  outlines?: boolean;
  /** Performance readout (fps, frame ms, draw calls; src/render/perf/hud.ts). */
  showFps?: boolean;
  /** Battery saver: cap the frame rate at 30 fps. */
  battery?: boolean;
  /**
   * Control scheme: 'simple' (phones: tap = select / move, big ARMY button, decluttered HUD)
   * or 'advanced' (the full RTS command set; mouse and keyboard always work the same).
   */
  controls: 'simple' | 'advanced';
  /** Skirmish: early-game grace before the AI attacks ('auto' = by difficulty: easy 10, normal 6, hard 3 min; sim/peace.ts). */
  peace?: PeaceOption;
  /** Game speed: slow 0.75x / normal / fast 1.25x simulation ticks per real second (game/pace.ts). */
  gameSpeed?: GameSpeed;
  /** Skirmish fog of war: 'classic' = Off (Red Alert 2: explored ground stays revealed), 'modern' = On (sim types.ts). */
  fog?: FogMode;
  /** Idle units near the base engage attackers on their own (sim/basedefense.ts; can change mid-battle). */
  autoDefend?: boolean;
}

/** Default control scheme: simple on touch screens, advanced with a mouse. */
export function defaultControls(): Settings['controls'] {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'simple' : 'advanced';
}

/** localStorage key of the saved settings. */
export const SETTINGS_KEY = 'ironfront.settings.v1';
const KEY = SETTINGS_KEY;

export function loadSettings(): Settings {
  const def: Settings = { faction: 'usa', enemy: 'random', difficulty: 'normal', credits: 10000, quality: 'auto', sfx: 0.8, music: 0.35, voice: true, cinematic: true, droneCam: 'auto', xray: true, controls: defaultControls(), peace: 'auto', gameSpeed: 'normal', fog: 'classic', autoDefend: true };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s: Settings = { ...def, ...JSON.parse(raw) };
      // values from an older or hand-edited save fall back to the defaults
      if (!isPeaceOption(s.peace)) s.peace = def.peace;
      if (!isGameSpeed(s.gameSpeed)) s.gameSpeed = def.gameSpeed;
      if (s.fog !== 'classic' && s.fog !== 'modern') s.fog = def.fog;
      if (typeof s.autoDefend !== 'boolean') s.autoDefend = def.autoDefend;
      setReadabilityPrefs(s);
      return s;
    }
  } catch {
    /* storage unavailable */
  }
  return def;
}

export function saveSettings(s: Settings) {
  setReadabilityPrefs(s);
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
