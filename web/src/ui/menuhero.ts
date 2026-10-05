import { sharedCameos, type CameoFactory } from '../render/cameo';
import { FACTION_REGION, type ModelStyle } from '../render/models';
import { DEFS, FACTION_INFO } from '../sim/defs';
import type { Entity, Faction } from '../sim/types';
import { LivePortrait } from './portrait3d';

/*
 * Rotating 3D hero vehicle for the skirmish nation picker (menu.ts).
 *
 * Reuses the selection panel's live portrait (portrait3d.ts): the nation's main
 * battle tank turns slowly on the studio rig at 15 fps into a small 2D canvas.
 * One offscreen GL context for the whole session (module singleton, never
 * re-created when the menu comes back, so contexts never pile up); nothing is
 * created or drawn on 'low' quality, where the card shows the flag art only.
 */

/** Player blue (game.ts PLAYER_COLOR): the hero wears the colours you will play with. */
const TEAM = 0x2f8fff;

let shared: CameoFactory | null = null;
let live: LivePortrait | null = null;

/** The nation's showcase vehicle: its main battle tank, else its first signature vehicle. */
export function heroDef(f: Faction): string | null {
  const mbt = `${f}_mbt`;
  if (DEFS[mbt]) return mbt;
  const sig = FACTION_INFO[f].signature.find((id) => DEFS[id]?.kind === 'unit');
  return sig ?? null;
}

export function styleOf(f: Faction): ModelStyle {
  const info = FACTION_INFO[f];
  return { team: TEAM, hull: info.hull, accent: info.accent, flag: info.flag, faction: f, region: FACTION_REGION[f] };
}

export class MenuHero {
  private host: HTMLElement | null = null;

  constructor(private readonly enabled: boolean) {}

  /** Show (or switch to) the nation's hero vehicle inside host. */
  show(host: HTMLElement, f: Faction) {
    if (!this.enabled) return;
    const def = heroDef(f);
    if (!def) return this.hide();
    try {
      shared ??= sharedCameos();
      live ??= new LivePortrait(shared, true);
    } catch {
      return;
    }
    if (!shared.available) return;
    this.host = host;
    const fake = { def, hp: 1, maxHp: 1 } as unknown as Entity;
    live.attach(host, () => fake, styleOf(f));
  }

  hide() {
    if (this.host) live?.detach();
    this.host = null;
  }
}
