// RTS control helpers for the local player: control groups (1-9), stance
// hotkeys, patrol / guard order modes and the waypoint-queue toggle. Pure input
// state; everything that changes the battle goes out as a sim command.

import { unitDef } from '../sim/defs';
import { STANCES } from '../sim/orders';
import type { Command, Entity, Stance } from '../sim/types';
import type { World } from '../sim/world';

export const GROUPS = 9;

export interface ControlsHost {
  readonly world: World;
  readonly local: number;
  selection(): Set<number>;
  select(ids: number[], add: boolean): void;
  issue(cmd: Command): void;
  centerOn(x: number, y: number): void;
  ack(kind: 'ack' | 'select' | 'click' | 'error'): void;
  message(text: string): void;
}

export interface GroupInfo {
  g: number;
  count: number;
  def: string | null; // most common unit type
}

export const STANCE_LABEL: Record<Stance, string> = {
  aggressive: 'Aggressive',
  guard: 'Guard',
  hold: 'Hold Position',
  holdFire: 'Hold Fire',
};
/** Alt+key stance hotkeys (C&C style) and their key codes. */
export const STANCE_KEY: Record<Stance, string> = { aggressive: 'A', guard: 'S', hold: 'D', holdFire: 'F' };

export class ControlGroups {
  readonly groups = new Map<number, number[]>();
  /** unit id -> group number (for the overlay badges). */
  readonly groupOf = new Map<number, number>();
  private lastTap = { g: -1, t: 0 };
  /** Phone: queue orders instead of replacing them (desktop holds Shift). */
  queueMode = false;

  constructor(private host: ControlsHost) {}

  private own(ids: Iterable<number>): number[] {
    const w = this.host.world;
    const out: number[] = [];
    for (const id of ids) {
      const e = w.get(id);
      if (e && e.owner === this.host.local && e.kind === 'unit' && !unitDef(e.def).temp) out.push(id);
    }
    return out;
  }

  /** Alive members of a group. */
  members(g: number): number[] {
    const ids = this.own(this.groups.get(g) ?? []);
    if (ids.length !== (this.groups.get(g)?.length ?? 0)) this.groups.set(g, ids);
    return ids;
  }

  /** Ctrl+N / long-press: the selection becomes group N (units leave their old group). */
  assign(g: number) {
    const ids = this.own(this.host.selection());
    for (const id of this.groups.get(g) ?? []) if (this.groupOf.get(id) === g) this.groupOf.delete(id);
    for (const id of ids) {
      const old = this.groupOf.get(id);
      if (old !== undefined && old !== g) this.groups.set(old, (this.groups.get(old) ?? []).filter((x) => x !== id));
      this.groupOf.set(id, g);
    }
    this.groups.set(g, ids);
    this.host.ack(ids.length ? 'ack' : 'click');
    if (ids.length) this.host.message(`Group ${g} assigned (${ids.length})`);
  }

  /** Shift+N: add the selection to group N. */
  add(g: number) {
    const ids = this.own(this.host.selection());
    const cur = this.members(g);
    for (const id of ids) {
      const old = this.groupOf.get(id);
      if (old === g) continue;
      if (old !== undefined) this.groups.set(old, (this.groups.get(old) ?? []).filter((x) => x !== id));
      this.groupOf.set(id, g);
      cur.push(id);
    }
    this.groups.set(g, cur);
    this.host.ack('ack');
  }

  /** N / tap: select group N; a second press within 400 ms centres the camera on it. */
  recall(g: number, now: number, add = false) {
    const ids = this.members(g);
    if (!ids.length) return false;
    this.host.select(ids, add);
    if (this.lastTap.g === g && now - this.lastTap.t < 400) {
      const c = this.centroid(ids);
      if (c) this.host.centerOn(c.x, c.y);
      this.lastTap = { g: -1, t: 0 };
    } else this.lastTap = { g, t: now };
    return true;
  }

  private centroid(ids: number[]) {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const id of ids) {
      const e = this.host.world.get(id);
      if (!e) continue;
      x += e.x;
      y += e.y;
      n++;
    }
    return n ? { x: x / n, y: y / n } : null;
  }

  info(g: number): GroupInfo {
    const ids = this.members(g);
    const counts = new Map<string, number>();
    for (const id of ids) {
      const d = this.host.world.get(id)!.def;
      counts.set(d, (counts.get(d) ?? 0) + 1);
    }
    let def: string | null = null;
    let best = 0;
    for (const [d, n] of counts)
      if (n > best) {
        best = n;
        def = d;
      }
    return { g, count: ids.length, def };
  }

  /** Keyboard: digits (Ctrl assigns, Shift adds, plain selects / double-tap centres). Returns true when handled. */
  onKey(e: KeyboardEvent): boolean {
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code);
    if (!m || e.altKey) return false;
    const g = Number(m[1]);
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) this.assign(g);
    else if (e.shiftKey) this.add(g);
    else this.recall(g, performance.now());
    return true;
  }
}

/** Selected units of the local player that take stance / patrol / guard orders. */
export function orderable(units: Entity[]) {
  return units.filter((u) => {
    const d = unitDef(u.def);
    return !d.temp && !d.harvester && !d.mcv;
  });
}

/** The stance shared by all units, or null when mixed. */
export function commonStance(units: Entity[]): Stance | null {
  let s: Stance | null = null;
  for (const u of units) {
    if (s === null) s = u.stance;
    else if (s !== u.stance) return null;
  }
  return s;
}

/** Next stance in the cycle (V). */
export function nextStance(units: Entity[]): Stance {
  const cur = commonStance(units) ?? 'holdFire';
  return STANCES[(STANCES.indexOf(cur) + 1) % STANCES.length];
}

/** Alt+A/S/D/F -> stance. */
export function stanceForKey(e: KeyboardEvent): Stance | null {
  if (!e.altKey || e.ctrlKey || e.metaKey) return null;
  const k = /^Key([A-Z])$/.exec(e.code)?.[1];
  if (!k) return null;
  return (Object.keys(STANCE_KEY) as Stance[]).find((s) => STANCE_KEY[s] === k) ?? null;
}
