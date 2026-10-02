// RTS control widgets: control-group strip (tap = select, double-tap = centre,
// long-press / right-click = assign), stance / patrol / guard / queue buttons,
// the repeat-build toggle and waypoint chains of the selected units.

import { unitDef } from '../sim/defs';
import { standHeight } from '../sim/map';
import { waypointChain, type WaypointPt } from '../sim/orders';
import type { Category, Entity, Stance } from '../sim/types';
import type { CameoFactory } from '../render/cameo';
import { styleFor, type GameRenderer } from '../render/renderer';
import { GROUPS, STANCE_KEY, STANCE_LABEL, commonStance, orderable, type ControlGroups } from '../game/controls';
import type { Hud } from './hud';
import './controls.css';

export type OrderMode = 'patrol' | 'guard';

export interface ControlsActions {
  onStance(s: Stance): void;
  onMode(m: OrderMode): void;
  onQueueToggle(): void;
  onRepeat(cat: Category, on: boolean): void;
  onGroupTap(g: number): void;
  onGroupAssign(g: number): void;
}

const svg = (inner: string) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;

const ICON: Record<string, string> = {
  aggressive: '<path d="M14.5 4.5L20 4l-.5 5.5L9 20l-5-5z"/><path d="M4 20l3-3M12 8l4 4"/>',
  guard: '<path d="M12 2.5l7.5 2.8v5.6c0 4.7-3.2 8.8-7.5 10.3-4.3-1.5-7.5-5.6-7.5-10.3V5.3z"/>',
  hold: '<path d="M12 3v13M6 11a6 6 0 0 0 12 0M8.5 5.5h7"/><circle cx="12" cy="3.5" r="1.2"/>',
  holdFire: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4M5 5l14 14"/>',
  patrol: '<path d="M4 8h14l-3.5-3.5M20 16H6l3.5 3.5"/>',
  queue: '<path d="M4 6h10M4 11h10M4 16h6"/><path d="M18 13v8M14 17h8"/>',
  repeat: '<path d="M17 2l3.5 3.5L17 9"/><path d="M3.5 11V9.5A4 4 0 0 1 7.5 5.5h13M7 22l-3.5-3.5L7 15"/><path d="M20.5 13v1.5a4 4 0 0 1-4 4h-13"/>',
};
const GUARD_ICON = '<path d="M12 2.5l7.5 2.8v5.6c0 4.7-3.2 8.8-7.5 10.3-4.3-1.5-7.5-5.6-7.5-10.3V5.3z"/><circle cx="12" cy="10" r="2.4"/><path d="M8.2 16.5c.8-1.7 2.2-2.6 3.8-2.6s3 .9 3.8 2.6"/>';

const STANCE_ORDER: Stance[] = ['aggressive', 'guard', 'hold', 'holdFire'];

const WP_COLOR: Record<WaypointPt['kind'], string> = {
  move: '110,255,170',
  attackMove: '255,150,70',
  attack: '255,70,60',
  patrol: '120,200,255',
  guard: '200,170,255',
};
const WP_HEX: Record<WaypointPt['kind'], number> = { move: 0x6effaa, attackMove: 0xff9646, attack: 0xff463c, patrol: 0x78c8ff, guard: 0xc8aaff };

const UNIT_CATS: Category[] = ['infantry', 'vehicle', 'air'];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: HTMLElement): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  parent?.appendChild(e);
  return e;
}

/** Tap / long-press on a button (long-press also on right-click). */
function press(b: HTMLElement, tap: () => void, long: () => void) {
  let timer = 0;
  let fired = false;
  b.addEventListener('pointerdown', (ev) => {
    ev.stopPropagation();
    if (ev.button === 2) return;
    fired = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      fired = true;
      navigator.vibrate?.(20);
      long();
    }, 480);
  });
  const cancel = () => clearTimeout(timer);
  b.addEventListener('pointerleave', cancel);
  b.addEventListener('pointercancel', cancel);
  b.addEventListener('pointerup', (ev) => {
    clearTimeout(timer);
    if (ev.button === 2 || fired) return;
    tap();
  });
  b.addEventListener('contextmenu', (ev) => {
    ev.preventDefault();
    clearTimeout(timer);
    if (!fired) long();
    fired = true;
  });
}

export class ControlsUI {
  private strip: HTMLElement;
  private slots: { b: HTMLButtonElement; key: string }[] = [];
  private bar: HTMLElement;
  private stanceBtns = new Map<Stance, HTMLButtonElement>();
  private patrolBtn: HTMLButtonElement;
  private guardBtn: HTMLButtonElement;
  private queueBtn: HTMLButtonElement;
  private repeatBtn: HTMLButtonElement | null = null;
  private touch = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
  mode: OrderMode | null = null;

  constructor(
    private hud: Hud,
    private renderer: GameRenderer,
    private cameos: CameoFactory,
    private groups: ControlGroups,
    private player: number,
    actions: ControlsActions,
  ) {
    // control-group strip at the left edge of the battlefield
    this.strip = el('div', 'ctl-groups', hud.viewWrap);
    for (let g = 1; g <= GROUPS; g++) {
      const b = el('button', 'ctl-slot', this.strip);
      b.dataset.g = String(g);
      b.title = `Group ${g}: tap / ${g} to select, double-tap to centre, hold or Ctrl+${g} to assign, Shift+${g} to add`;
      b.innerHTML = `<b>${g}</b><img alt="" draggable="false"><span></span>`;
      press(b, () => actions.onGroupTap(g), () => actions.onGroupAssign(g));
      this.slots.push({ b, key: '' });
    }
    // order bar: stances, patrol, guard, waypoint queue
    const bl = hud.viewWrap.querySelector('.bottom-left') as HTMLElement;
    this.bar = el('div', 'ctl-orders hidden', bl);
    const mk = (icon: string, label: string, title: string, kbd: string, fn: () => void, cls = '') => {
      const b = el('button', `cmd-btn ctl-btn ${cls}`, this.bar);
      b.innerHTML = `${svg(icon)}<span>${label}</span>${kbd ? `<kbd>${kbd}</kbd>` : ''}`;
      b.title = title;
      b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      b.onclick = fn;
      return b;
    };
    for (const s of STANCE_ORDER) {
      const short = s === 'aggressive' ? 'Aggr.' : s === 'guard' ? 'Guard' : s === 'hold' ? 'Hold' : 'No Fire';
      const b = mk(ICON[s], short, `Stance: ${STANCE_LABEL[s]} (Alt+${STANCE_KEY[s]}, V cycles)`, `Alt+${STANCE_KEY[s]}`, () => actions.onStance(s), 'ctl-stance');
      this.stanceBtns.set(s, b);
    }
    el('i', 'ctl-sep', this.bar);
    this.patrolBtn = mk(ICON.patrol, 'Patrol', 'Patrol (P), then click / tap the far end of the route', 'P', () => actions.onMode('patrol'));
    this.guardBtn = mk(GUARD_ICON, 'Escort', 'Guard / escort (G), then click / tap a friendly unit or building', 'G', () => actions.onMode('guard'));
    this.queueBtn = mk(ICON.queue, 'Queue', 'Waypoint queue: orders are added after the current ones (or hold Shift)', '⇧', () => actions.onQueueToggle(), 'ctl-queue');
    // repeat-build toggle next to the sidebar tools
    const tools = hud.root.querySelector('.sb-tools');
    if (tools) {
      const b = el('button', 'tool-btn ctl-repeat', tools as HTMLElement);
      b.innerHTML = svg(ICON.repeat);
      b.title = 'Repeat build: finished units of this tab are queued again';
      b.onclick = () => {
        const cat = hud.tab;
        if (!UNIT_CATS.includes(cat)) return;
        actions.onRepeat(cat, !hud.world.players[player].repeat?.[cat]);
      };
      this.repeatBtn = b;
    }
    this.strip.classList.toggle('touch', this.touch);
  }

  /**
   * Simple control scheme: move the group strip and the order bar into the HUD's
   * collapsible "More" panel (null puts them back on the battlefield).
   */
  dock(slots: { groups: HTMLElement; orders: HTMLElement } | null) {
    const bl = this.hud.viewWrap.querySelector('.bottom-left') as HTMLElement;
    if (slots) {
      slots.groups.appendChild(this.strip);
      slots.orders.appendChild(this.bar);
    } else {
      this.hud.viewWrap.appendChild(this.strip);
      bl.appendChild(this.bar);
    }
    this.docked = !!slots;
    this.strip.classList.toggle('docked', this.docked);
    this.bar.classList.toggle('docked', this.docked);
  }
  private docked = false;

  /** Refresh widgets (called ~10x per second). */
  update(selected: Entity[]) {
    const w = this.hud.world;
    // group strip
    const style = styleFor(w, this.player);
    for (const s of this.slots) {
      const g = Number(s.b.dataset.g);
      const info = this.groups.info(g);
      const sel = info.count > 0 && this.groups.members(g).every((id) => this.renderer.selection.has(id));
      const key = `${info.count}:${info.def}:${sel}`;
      // phones show a fixed strip of 5 slots; desktops show assigned groups only
      const show = info.count > 0 || ((this.touch || this.docked) && g <= 5);
      s.b.style.display = show ? '' : 'none';
      if (key === s.key) continue;
      s.key = key;
      s.b.classList.toggle('empty', !info.count);
      s.b.classList.toggle('sel', sel);
      const img = s.b.querySelector('img') as HTMLImageElement;
      if (info.def) {
        img.src = this.cameos.get(info.def, style);
        img.style.visibility = '';
      } else img.style.visibility = 'hidden';
      (s.b.querySelector('span') as HTMLElement).textContent = info.count ? String(info.count) : '';
    }
    this.strip.classList.toggle('hidden', !this.slots.some((s) => s.b.style.display !== 'none'));
    // order bar
    const units = orderable(selected);
    this.bar.classList.toggle('hidden', units.length === 0);
    if (units.length) {
      const st = commonStance(units);
      for (const [s, b] of this.stanceBtns) b.classList.toggle('on', st === s);
      this.patrolBtn.classList.toggle('on', this.mode === 'patrol');
      this.guardBtn.classList.toggle('on', this.mode === 'guard');
      this.queueBtn.classList.toggle('on', this.groups.queueMode);
      const armed = units.some((u) => !!unitDef(u.def).weapon);
      this.patrolBtn.disabled = !armed;
    }
    if (this.repeatBtn) {
      const cat = this.hud.tab;
      const unitTab = UNIT_CATS.includes(cat);
      this.repeatBtn.style.display = unitTab ? '' : 'none';
      this.repeatBtn.classList.toggle('active', unitTab && !!w.players[this.player].repeat?.[cat]);
    }
  }

  /** Waypoint chains of the selected units: dashed lines on the 2D overlay plus ground pins. */
  drawWaypoints(selected: Entity[], alpha: number, now: number) {
    const w = this.hud.world;
    const r = this.renderer;
    const ctx = this.hud.overlay.getContext('2d')!;
    const pins = new Map<string, { x: number; y: number; color: number }>();
    let drawn = 0;
    ctx.save();
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 5]);
    ctx.lineDashOffset = -now * 22;
    for (const u of selected) {
      if (u.owner !== this.player || u.kind !== 'unit' || drawn > 60) continue;
      const chain = waypointChain(w, u);
      // a lone current move needs no chain (the order line shows it); patrols, guards and queues do
      if (!chain.length || (chain.length === 1 && u.queue.length === 0 && !u.patrol && u.guardId < 0)) continue;
      drawn++;
      const up = r.entityPos(u, alpha);
      let a = r.project(up.x, up.y + 0.05, up.z);
      for (const p of chain) {
        const b = r.project(p.x, standHeight(w.map, p.x, p.y) + 0.05, p.y);
        ctx.strokeStyle = `rgba(${WP_COLOR[p.kind]},0.75)`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        a = b;
        const key = `${Math.round(p.x / 1.5)}:${Math.round(p.y / 1.5)}:${p.kind}`;
        if (!pins.has(key) && p.kind !== 'attack' && p.kind !== 'guard') pins.set(key, { x: p.x, y: p.y, color: WP_HEX[p.kind] });
      }
      // patrol: close the loop back to the first point
      if (u.patrol && chain.length >= 2) {
        const b = r.project(chain[0].x, standHeight(w.map, chain[0].x, chain[0].y) + 0.05, chain[0].y);
        ctx.strokeStyle = `rgba(${WP_COLOR.patrol},0.35)`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }
    ctx.restore();
    r.overlay.pins([...pins.values()].slice(0, 48));
    const keep = this.hud.keepClear?.();
    if (keep && drawn) ctx.clearRect(keep.x, keep.y, keep.w, keep.h);
  }

  destroy() {
    this.strip.remove();
    this.bar.remove();
    this.repeatBtn?.remove();
  }
}
