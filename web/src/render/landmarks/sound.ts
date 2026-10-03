/*
 * Civilian ambience sounds raised by the render-only set pieces (trains,
 * level crossing bells, church bells, airliners, helicopters, ship horns).
 * The renderer has no handle on the audio system, so they queue here and the
 * battle's sound scene (audio/scene.ts) drains the queue every frame and
 * plays them positionally. Capped, so a stalled drain never grows it.
 */

export type CivSound = 'trainPass' | 'trainHorn' | 'crossingBell' | 'churchBell' | 'jetHigh' | 'heliPass' | 'shipHorn';

export interface CivSoundReq {
  name: CivSound;
  vol: number;
  x: number;
  y: number;
  z: number;
}

const queue: CivSoundReq[] = [];

/** Queue a civilian sound at tile position (x, y), height z. */
export function civSound(name: CivSound, vol: number, x: number, y: number, z = 0): void {
  if (queue.length >= 16) queue.shift();
  queue.push({ name, vol, x, y, z });
}

/** Take everything queued since the last call. */
export function drainCivSounds(): CivSoundReq[] {
  if (!queue.length) return EMPTY;
  return queue.splice(0, queue.length);
}
const EMPTY: CivSoundReq[] = [];
