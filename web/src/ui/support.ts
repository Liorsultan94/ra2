import { airdropStatus } from '../sim/airdrop';
import { TRANSPORTS, unitDef } from '../sim/defs';
import { standHeight } from '../sim/map';
import type { World } from '../sim/world';
import type { GameRenderer } from '../render/renderer';

/*
 * Airborne-drop support power button (sidebar tool row) with a recharge ring,
 * plus its targeting mode: tap the button, then tap / click the drop zone on
 * the map (drag still pans the camera; Esc, right-click or the button again
 * cancels). Issues the lockstep `airdrop` command; the sim validates it.
 */

export interface SupportHost {
  readonly viewWrap: HTMLElement;
  world: World;
  renderer: GameRenderer;
  player: number;
  message(text: string, kind?: 'info' | 'warn' | 'good'): void;
  showHint(html: string | null): void;
}

const ICON =
  '<path d="M12 2C6.8 2 2.6 5.6 2 10.3c1.2-.9 2.4-1.3 3.6-1.3 1.3 0 2.5.5 3.4 1.3.9-.8 2-1.3 3-1.3s2.1.5 3 1.3c.9-.8 2.1-1.3 3.4-1.3 1.2 0 2.4.4 3.6 1.3C21.4 5.6 17.2 2 12 2z"/>' +
  '<path d="M2.6 10.6l7.9 6.6M21.4 10.6l-7.9 6.6M9 10.5l2.2 6.3M15 10.5l-2.2 6.3" stroke="currentColor" stroke-width="1.1" fill="none"/>' +
  '<circle cx="12" cy="17.6" r="1.5"/><path d="M10.5 19.3h3l.6 2.7h-1.3l-.8-1.7-.8 1.7H9.9z"/>';

const RING_R = 15.5;
const RING_C = 2 * Math.PI * RING_R;

export class SupportPower {
  private btn: HTMLButtonElement;
  private ring: SVGCircleElement;
  private timer: HTMLElement;
  private reticle: HTMLElement;
  private marker: HTMLElement;
  private armed = false;
  private wasReady = false;
  private wasUnlocked = false;
  private press: { id: number; x: number; y: number; lx: number; ly: number; moved: boolean } | null = null;
  private dz: { x: number; y: number; until: number } | null = null;
  private seenTransports = new Set<number>();
  private scanAt = 0;
  private disposers: (() => void)[] = [];

  constructor(
    private host: SupportHost,
    toolRow: HTMLElement,
  ) {
    const b = (this.btn = document.createElement('button'));
    b.className = 'tool-btn support-btn locked';
    b.title = 'Airborne drop - paratroopers + supply pallet (needs an Airbase)';
    b.innerHTML = `<svg class="sp-ring" viewBox="0 0 36 36"><circle class="sp-track" cx="18" cy="18" r="${RING_R}"/><circle class="sp-fill" cx="18" cy="18" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg><svg class="sp-icon" viewBox="0 0 24 24" fill="currentColor">${ICON}</svg><span class="sp-time"></span>`;
    this.ring = b.querySelector('.sp-fill') as SVGCircleElement;
    this.timer = b.querySelector('.sp-time') as HTMLElement;
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.onclick = () => this.toggle();
    toolRow.appendChild(b);
    const view = host.viewWrap;
    this.reticle = document.createElement('div');
    this.reticle.className = 'drop-reticle hidden';
    view.appendChild(this.reticle);
    this.marker = document.createElement('div');
    this.marker.className = 'drop-marker hidden';
    this.marker.innerHTML = '<i></i><span>DZ</span>';
    view.appendChild(this.marker);
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, fn as EventListener, { capture: true });
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    const local = (e: PointerEvent) => {
      const r = view.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    // capture phase: while targeting, the map belongs to us (the game's own handlers never see these presses)
    on(view, 'pointerdown', (e) => {
      if (!this.armed) return;
      if ((e.target as HTMLElement).closest?.('button, .selpanel, .cmdbar, .view-ctrl')) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.button === 2) {
        this.disarm();
        return;
      }
      if (this.press) return; // second finger
      const p = local(e);
      this.press = { id: e.pointerId, x: p.x, y: p.y, lx: p.x, ly: p.y, moved: false };
      try {
        view.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    on(view, 'pointermove', (e) => {
      if (!this.armed) return;
      const p = local(e);
      if (e.pointerType === 'mouse') {
        this.reticle.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%)`;
        this.reticle.classList.remove('hidden');
      }
      const pr = this.press;
      if (!pr || pr.id !== e.pointerId) return;
      e.stopPropagation();
      // fingers jitter: a touch has to travel further before it counts as a drag (pan)
      if (!pr.moved && Math.hypot(p.x - pr.x, p.y - pr.y) > (e.pointerType === 'touch' ? 18 : 9)) pr.moved = true;
      if (pr.moved) this.host.renderer.panDrag(pr.lx, pr.ly, p.x, p.y);
      pr.lx = p.x;
      pr.ly = p.y;
    });
    const up = (e: PointerEvent) => {
      const pr = this.press;
      if (!this.armed || !pr || pr.id !== e.pointerId) return;
      e.stopPropagation();
      this.press = null;
      if (pr.moved || e.type === 'pointercancel') return;
      const p = local(e);
      this.fire(p.x, p.y);
    };
    on(view, 'pointerup', up);
    on(view, 'pointercancel', up);
    on(view, 'contextmenu', (e) => {
      if (this.armed) e.preventDefault();
    });
    on(view, 'pointerleave', () => this.reticle.classList.add('hidden'));
    on(window, 'keydown', (e) => {
      if (this.armed && (e as KeyboardEvent).key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        this.disarm();
      }
    });
  }

  private toggle() {
    if (this.armed) {
      this.disarm();
      return;
    }
    const st = airdropStatus(this.host.world, this.host.player);
    if (!st.unlocked) {
      this.host.message('Airborne drop needs an Airbase', 'warn');
      return;
    }
    if (!st.ready) {
      this.host.message(`Airborne drop recharging (${fmt(st.secondsLeft)})`, 'info');
      return;
    }
    this.armed = true;
    this.press = null;
    this.btn.classList.add('active');
    this.host.viewWrap.classList.add('drop-targeting');
    this.host.showHint('<b>Airborne drop</b>: tap / click the drop zone &middot; Esc or right-click to cancel');
  }

  private disarm() {
    this.armed = false;
    this.press = null;
    this.btn.classList.remove('active');
    this.host.viewWrap.classList.remove('drop-targeting');
    this.reticle.classList.add('hidden');
    this.host.showHint(null);
  }

  private fire(sx: number, sy: number) {
    const w = this.host.world;
    const g = this.host.renderer.screenToGround(sx, sy);
    if (g.x < 0 || g.y < 0 || g.x >= w.map.w || g.y >= w.map.h) {
      this.host.message('Drop zone must be on the map', 'warn');
      return;
    }
    this.disarm();
    w.issue(this.host.player, { type: 'airdrop', x: g.x, y: g.y });
    const tr = TRANSPORTS[w.players[this.host.player].faction];
    this.host.message(`${tr.name} inbound - paratroopers on the way`, 'good');
    this.dz = { x: g.x, y: g.y, until: performance.now() + 22000 };
  }

  update() {
    const w = this.host.world;
    const st = airdropStatus(w, this.host.player);
    this.btn.classList.toggle('locked', !st.unlocked);
    this.btn.classList.toggle('ready', st.ready);
    this.ring.style.strokeDashoffset = String(RING_C * (1 - (st.unlocked ? st.progress : 0)));
    this.timer.textContent = st.unlocked && !st.ready ? fmt(st.secondsLeft) : '';
    if (st.ready && !this.wasReady && st.unlocked) this.host.message('Airborne drop ready', 'good');
    if (st.unlocked && !this.wasUnlocked && !st.ready) this.host.message('Airborne drop unlocked - charging', 'info');
    this.wasReady = st.ready;
    this.wasUnlocked = st.unlocked;
    if (this.armed && !st.ready) this.disarm();
    // drop-zone marker until the stick is on the ground
    const dz = this.dz;
    if (dz && performance.now() < dz.until) {
      const r = this.host.renderer;
      const s = r.project(dz.x, standHeight(w.map, dz.x, dz.y), dz.y);
      this.marker.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
      this.marker.classList.remove('hidden');
    } else {
      this.dz = null;
      this.marker.classList.add('hidden');
    }
    // warn about enemy transports once they are seen
    const now = performance.now();
    if (now >= this.scanAt) {
      this.scanAt = now + 500;
      for (const e of w.list) {
        if (e.dead || e.kind !== 'unit' || e.owner === this.host.player || this.seenTransports.has(e.id)) continue;
        if (!unitDef(e.def).airlift || !this.host.renderer.isShown(e.id)) continue;
        this.seenTransports.add(e.id);
        if (w.isEnemy(this.host.player, e.owner)) this.host.message('Enemy transport aircraft inbound - airborne assault!', 'warn');
      }
    }
  }

  destroy() {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.btn.remove();
    this.reticle.remove();
    this.marker.remove();
  }
}

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}
