import { standHeight } from '../sim/map';
import { SW_INFO, type SwKind } from '../sim/specialdefs';
import { superweaponStatus } from '../sim/superweapons';
import type { SimEvent } from '../sim/types';
import type { SupportHost } from './support';
import './superweapons.css';

/*
 * Superweapon HUD (RA2 style):
 *  - a button in the sidebar tool row with a charge ring (hidden until the
 *    structure stands); tap it, then tap / click the target on the map (drag
 *    still pans; Esc, right-click or the button again cancels). Issues the
 *    lockstep `superweapon` command; the sim validates it;
 *  - the big countdown list at the top of the view: every player's
 *    superweapon (own in team colour, enemies in red), blinking when ready;
 *  - warnings to everybody (detected / ready / launched) and a target marker.
 */

const ICONS: Record<SwKind, string> = {
  darkEagle: '<path d="M12 1l3 7-3 13-3-13z"/><path d="M5 14l4-3v4zM19 14l-4-3v4z"/>',
  ironBeam: '<path d="M3 20a9 9 0 0 1 18 0z" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 20V9h2v11z"/><path d="M12 3l1 5h-2z"/>',
  droneSwarm: '<circle cx="6" cy="7" r="2"/><circle cx="18" cy="7" r="2"/><circle cx="12" cy="12" r="2.2"/><circle cx="6" cy="17" r="2"/><circle cx="18" cy="17" r="2"/>',
  tos2: '<path d="M3 18l7-12 2 1-7 12z"/><path d="M9 18l7-12 2 1-7 12z"/><path d="M15 18l5-9 2 1-5 9z"/>',
  taurusSalvo: '<path d="M2 12l15-3 5 3-5 3z"/><path d="M7 11l-2-4h2l3 3zM7 13l-2 4h2l3-3z"/>',
  hyunmoo5: '<path d="M10 2h4v14l-2 6-2-6z"/><path d="M7 16l3-3v4zM17 16l-3-3v4z"/>',
  neptuneFpv: '<path d="M2 10l13-2 4 2-4 2z"/><path d="M9 17h6M12 14v6" stroke="currentColor" stroke-width="2"/><circle cx="9" cy="17" r="1.6"/><circle cx="15" cy="17" r="1.6"/>',
  kizilelma: '<path d="M12 3l9 12-9-3-9 3z"/><path d="M12 12v8" stroke="currentColor" stroke-width="2"/>',
  kheibar: '<path d="M6 3h3v13l-1.5 5L6 16z"/><path d="M15 3h3v13l-1.5 5-1.5-5z"/>',
};

const RING_R = 15.5;
const RING_C = 2 * Math.PI * RING_R;

function fmt(s: number) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

export class SuperweaponPower {
  private btn: HTMLButtonElement;
  private ring: SVGCircleElement;
  private timer: HTMLElement;
  private icon: SVGElement;
  private reticle: HTMLElement;
  private timers: HTMLElement;
  private markers: { el: HTMLElement; x: number; y: number; until: number }[] = [];
  private armed = false;
  private wasReady = false;
  private wasUnlocked = false;
  private lastKey = '';
  private press: { id: number; x: number; y: number; lx: number; ly: number; moved: boolean } | null = null;
  private disposers: (() => void)[] = [];

  constructor(
    private host: SupportHost,
    toolRow: HTMLElement,
  ) {
    const b = (this.btn = document.createElement('button'));
    b.className = 'tool-btn support-btn sw-btn locked';
    b.innerHTML = `<svg class="sp-ring" viewBox="0 0 36 36"><circle class="sp-track" cx="18" cy="18" r="${RING_R}"/><circle class="sp-fill" cx="18" cy="18" r="${RING_R}" stroke-dasharray="${RING_C}" stroke-dashoffset="${RING_C}"/></svg><svg class="sp-icon" viewBox="0 0 24 24" fill="currentColor"></svg><span class="sp-time"></span>`;
    this.ring = b.querySelector('.sp-fill') as SVGCircleElement;
    this.timer = b.querySelector('.sp-time') as HTMLElement;
    this.icon = b.querySelector('.sp-icon') as SVGElement;
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.onclick = () => this.toggle();
    toolRow.appendChild(b);
    const view = host.viewWrap;
    this.reticle = document.createElement('div');
    this.reticle.className = 'sw-reticle hidden';
    view.appendChild(this.reticle);
    this.timers = document.createElement('div');
    this.timers.className = 'sw-timers';
    view.appendChild(this.timers);
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, fn as EventListener, { capture: true });
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, { capture: true }));
    };
    const local = (e: PointerEvent) => {
      const r = view.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    on(view, 'pointerdown', (e) => {
      if (!this.armed) return;
      if ((e.target as HTMLElement).closest?.('button, .selpanel, .cmdbar, .view-ctrl')) return;
      e.stopPropagation();
      e.preventDefault();
      if (e.button === 2) {
        this.disarm();
        return;
      }
      if (this.press) return;
      const p = local(e);
      this.press = { id: e.pointerId, x: p.x, y: p.y, lx: p.x, ly: p.y, moved: false };
      this.showReticle(p.x, p.y);
      try {
        view.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    });
    on(view, 'pointermove', (e) => {
      if (!this.armed) return;
      const p = local(e);
      if (e.pointerType === 'mouse') this.showReticle(p.x, p.y);
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

  private showReticle(x: number, y: number) {
    const st = superweaponStatus(this.host.world, this.host.player);
    const r = this.host.renderer;
    const g = r.screenToGround(x, y);
    const px = r.pixelsPerUnit({ x: g.x, y: standHeight(this.host.world.map, Math.max(0, Math.min(this.host.world.map.w - 0.01, g.x)), Math.max(0, Math.min(this.host.world.map.h - 0.01, g.y))), z: g.y });
    const d = Math.max(40, Math.min(420, st.info.radius * 2 * px));
    this.reticle.style.width = this.reticle.style.height = `${d}px`;
    this.reticle.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    this.reticle.classList.toggle('defensive', !!st.info.defensive);
    this.reticle.classList.remove('hidden');
  }

  private toggle() {
    if (this.armed) {
      this.disarm();
      return;
    }
    const st = superweaponStatus(this.host.world, this.host.player);
    if (!st.unlocked) {
      this.host.message(`${st.info.name} needs the ${st.info.building}`, 'warn');
      return;
    }
    if (!st.ready) {
      this.host.message(`${st.info.name} charging (${fmt(st.secondsLeft)})`, 'info');
      return;
    }
    this.armed = true;
    this.press = null;
    this.btn.classList.add('active');
    this.host.viewWrap.classList.add('drop-targeting');
    this.host.showHint(`<b>${st.info.name}</b>: tap / click the ${st.info.defensive ? 'area to protect' : 'target'} &middot; Esc or right-click to cancel`);
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
      this.host.message('Target must be on the map', 'warn');
      return;
    }
    this.disarm();
    w.issue(this.host.player, { type: 'superweapon', x: g.x, y: g.y });
  }

  /** Superweapon sim events: warnings for everybody plus a ground marker on launches. */
  onEvent(ev: Extract<SimEvent, { t: 'superweapon' }>) {
    if (ev.phase !== 'launch') return;
    const el = document.createElement('div');
    const info = SW_INFO[ev.sw as SwKind];
    el.className = `sw-marker${info.defensive ? ' defensive' : ''}`;
    el.innerHTML = `<i></i><span>${info.defensive ? 'DOME' : 'IMPACT'}</span>`;
    this.host.viewWrap.appendChild(el);
    this.markers.push({ el, x: ev.x, y: ev.y, until: performance.now() + (info.defensive ? 30000 : 16000) });
  }

  update() {
    const w = this.host.world;
    const me = this.host.player;
    const st = superweaponStatus(w, me);
    this.btn.classList.toggle('locked', !st.unlocked && st.beamLeft === 0);
    this.btn.classList.toggle('ready', st.ready);
    this.btn.title = `${st.info.name} - ${st.info.desc}`;
    if (this.icon.dataset.kind !== st.kind) {
      this.icon.dataset.kind = st.kind;
      this.icon.innerHTML = ICONS[st.kind];
    }
    this.ring.style.strokeDashoffset = String(RING_C * (1 - (st.unlocked ? st.progress : 0)));
    this.timer.textContent = st.beamLeft ? `${st.beamLeft}s` : st.unlocked && !st.ready ? fmt(st.secondsLeft) : '';
    this.wasReady = st.ready;
    this.wasUnlocked = st.unlocked;
    if (this.armed && !st.ready) this.disarm();
    // the countdown list (RA2: every superweapon on the map, for everybody)
    const rows: string[] = [];
    for (const p of w.players) {
      if (p.defeated) continue;
      const s = superweaponStatus(w, p.id);
      if (!s.unlocked && !s.beamLeft) continue;
      const own = p.id === me;
      const col = own ? `#${p.color.toString(16).padStart(6, '0')}` : '#ff4a3a';
      const state = s.beamLeft ? `ACTIVE ${s.beamLeft}s` : s.ready ? 'READY' : fmt(s.secondsLeft);
      const hot = s.ready || s.beamLeft > 0 || s.secondsLeft <= 30;
      rows.push(`<div class="sw-row${own ? ' own' : ' enemy'}${hot ? ' hot' : ''}${s.ready ? ' ready' : ''}" style="--swc:${col}"><svg viewBox="0 0 24 24" fill="currentColor">${ICONS[s.kind]}</svg><b>${s.info.name}</b><span>${state}</span></div>`);
    }
    const key = rows.join('');
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.timers.innerHTML = key;
    }
    const now = performance.now();
    for (let i = this.markers.length - 1; i >= 0; i--) {
      const m = this.markers[i];
      if (now > m.until) {
        m.el.remove();
        this.markers.splice(i, 1);
        continue;
      }
      const s = this.host.renderer.project(m.x, standHeight(w.map, m.x, m.y), m.y);
      m.el.style.transform = `translate(${s.x}px, ${s.y}px) translate(-50%, -50%)`;
    }
  }

  get state() {
    return { ready: this.wasReady, unlocked: this.wasUnlocked, armed: this.armed };
  }

  destroy() {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.btn.remove();
    this.reticle.remove();
    this.timers.remove();
    for (const m of this.markers) m.el.remove();
    this.markers = [];
  }
}
