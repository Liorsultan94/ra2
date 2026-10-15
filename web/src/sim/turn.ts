// Fair starts on the point-symmetric maps: a building's exit, refinery dock and drive-through tiles are
// drawn on its south side, so in the base in the north half they would face the other way than in the
// mirrored base in the south half (units leaving towards the enemy, a dock facing the ore field the other
// base's docks away from). Buildings with such a layout that a player in the north half builds are turned
// half a circle (Entity.flip): the two bases are then exact point mirrors of each other, layout and all.

import { buildingDef } from './defs';

/** Does a building of this type get turned in the north base (it has an exit or a dock; not the airbase's runway)? */
export function turnable(defId: string): boolean {
  const d = buildingDef(defId);
  return !!(d.exit || d.dock || d.passable) && d.role !== 'airfield';
}

/** Is a start (tile) in the north half of a map `h` tiles high (its base faces the other way)? */
export function northStart(startY: number, h: number): boolean {
  return startY + 0.5 < h / 2;
}

/** Map tile of tile (px, py) of a building's def layout (exit, dock, drive-through tiles), turned if it is. */
export function layoutTile(b: { def: string; tx: number; ty: number; flip?: boolean }, px: number, py: number): [number, number] {
  if (!b.flip) return [b.tx + px, b.ty + py];
  const d = buildingDef(b.def);
  return [b.tx + d.w - 1 - px, b.ty + d.h - 1 - py];
}
