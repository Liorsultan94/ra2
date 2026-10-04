import type { GameRenderer } from '../render/renderer';
import { standHeight } from '../sim/map';
import { SIDE, type SideEvent, type SideKind } from '../sim/sideevents';
import { TPS } from '../sim/types';
import type { World } from '../sim/world';
import './sitrep.css';

/*
 * Side events on the HUD (sim/sideevents.ts): a chip per running event under the
 * clock (tap: the camera jumps there - the phone way to reach it), a marker on the
 * battlefield (a pulsing badge over the spot, or an arrow at the edge of the view
 * when it is off screen) and a ping on the radar. Reads the world, never writes it.
 */

/** Glyphs (24 x 24, stroked) shared by the chips (SVG) and the canvas markers (Path2D). */
export const SIDE_GLYPH: Record<SideKind, string> = {
  crash: 'M12 3c.9 0 1.4 1 1.4 2.4V10l6.6 3.8v1.9l-6.6-1.9v3.9l1.9 1.4V21L12 20.1 8.7 21v-1.9l1.9-1.4v-3.9L4 15.7v-1.9L10.6 10V5.4C10.6 4 11.1 3 12 3z',
  supply: 'M3.5 8L12 3.5 20.5 8v8.5L12 21l-8.5-4.5zM3.5 8L12 12.5 20.5 8M12 12.5V21',
  rescue: 'M12 3c1 3.6 5.5 5.6 5.5 10.6a5.5 5.5 0 0 1-11 0c0-2.7 1.6-3.9 1.9-6.3 1.6.9 2.6 2.6 2.6 4.4 1-1.6 1.2-5.4 1-8.7z',
  convoy: 'M2.5 6.5h11v9.5h-11zM13.5 9.5h4l3 3.6V16h-7zM4.5 18a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0M15.5 18a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0',
};

export const SIDE_LABEL: Record<SideKind, string> = { crash: 'Crash site', supply: 'Supply drop', rescue: 'Rescue', convoy: 'Convoy' };
/** What to do (chip second line / tip). */
export const SIDE_HINT: Record<SideKind, string> = {
  crash: 'Infantry: recover intel (map revealed 30 s)',
  supply: `Grab the crates: $${SIDE.CRATE_CASH} each`,
  rescue: `Infantry: rescue civilians ($${SIDE.RESCUE_CASH} + rank)`,
  convoy: `Stay next to a truck: $${SIDE.CAPTURE_CASH} · destroy: $${SIDE.BOUNTY}`,
};
const COLOR: Record<SideKind, string> = { crash: '255,201,74', supply: '120,230,140', rescue: '255,128,72', convoy: '120,200,255' };

const svg = (k: SideKind) => `<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${SIDE_GLYPH[k]}"/></svg>`;

const fmt = (ticks: number) => {
  const s = Math.max(0, Math.ceil(ticks / TPS));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export class SitRep {
  readonly el: HTMLElement;
  private chips = new Map<number, HTMLButtonElement>();
  private paths = new Map<SideKind, Path2D>();
  private acc = 1;

  constructor(
    parent: HTMLElement,
    private onGo: (x: number, y: number) => void,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'sitrep';
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    parent.appendChild(this.el);
  }

  private glyph(k: SideKind): Path2D | null {
    if (typeof Path2D === 'undefined') return null;
    let p = this.paths.get(k);
    if (!p) this.paths.set(k, (p = new Path2D(SIDE_GLYPH[k])));
    return p;
  }

  /** Chips (a few times per second; DOM only on change). */
  update(dt: number, w: World | null) {
    this.acc += dt;
    if (!w || this.acc < 0.25) return;
    this.acc = 0;
    const live = w.side.enabled ? w.side.active : [];
    for (const [id, b] of this.chips) {
      if (live.some((e) => e.id === id)) continue;
      b.remove();
      this.chips.delete(id);
    }
    for (const ev of live.slice(-3)) {
      let b = this.chips.get(ev.id);
      if (!b) {
        b = document.createElement('button');
        b.type = 'button';
        b.className = 'sx-chip';
        b.dataset.kind = ev.kind;
        b.title = `${SIDE_LABEL[ev.kind]}: ${SIDE_HINT[ev.kind]} (tap to look)`;
        b.innerHTML = `<span class="sx-ico">${svg(ev.kind)}</span><span class="sx-txt"><b>${SIDE_LABEL[ev.kind]}</b><small>${SIDE_HINT[ev.kind]}</small></span><span class="sx-time"></span>`;
        const id = ev.id;
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const cur = w.side.events.find((x) => x.id === id);
          if (cur) this.onGo(cur.x, cur.y);
        });
        this.el.appendChild(b);
        this.chips.set(ev.id, b);
        b.classList.add('new');
        window.setTimeout(() => b!.classList.remove('new'), 2400);
      }
      const t = b.querySelector('.sx-time') as HTMLElement;
      const txt = fmt(ev.until - w.tick);
      if (t.textContent !== txt) t.textContent = txt;
    }
  }

  /** Battlefield markers (overlay canvas, CSS pixels). */
  drawMarkers(ctx: CanvasRenderingContext2D, w: World, r: GameRenderer, vw: number, vh: number, now: number) {
    if (!w.side.enabled) return;
    for (const ev of w.side.active) {
      const p = r.project(ev.x, standHeight(w.map, ev.x, ev.y) + 0.9, ev.y);
      const g = r.project(ev.x, standHeight(w.map, ev.x, ev.y) + 0.02, ev.y);
      const m = 26;
      const on = p.x > m && p.y > m && p.x < vw - m && p.y < vh - m && Number.isFinite(p.x);
      const col = COLOR[ev.kind];
      const pulse = (now * 0.8 + ev.id * 0.37) % 1;
      if (on) {
        // ground ring
        ctx.lineWidth = 2;
        ctx.strokeStyle = `rgba(${col},${0.7 * (1 - pulse)})`;
        ctx.beginPath();
        ctx.ellipse(g.x, g.y, 10 + 26 * pulse, (10 + 26 * pulse) * 0.5, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(${col},0.55)`;
        ctx.beginPath();
        ctx.moveTo(g.x, g.y);
        ctx.lineTo(p.x, p.y + 14);
        ctx.stroke();
        this.badge(ctx, ev, p.x, p.y, col, w);
      } else {
        // off screen: a badge at the edge of the view, pointing at it
        const cx = vw / 2;
        const cy = vh / 2;
        let dx = p.x - cx;
        let dy = p.y - cy;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
        const k = Math.min((vw / 2 - m) / Math.max(1e-3, Math.abs(dx)), (vh / 2 - m) / Math.max(1e-3, Math.abs(dy)));
        const ex = cx + dx * k;
        const ey = cy + dy * k;
        const len = Math.hypot(dx, dy) || 1;
        dx /= len;
        dy /= len;
        ctx.fillStyle = `rgba(${col},0.95)`;
        ctx.beginPath();
        ctx.moveTo(ex + dx * 22, ey + dy * 22);
        ctx.lineTo(ex + dx * 13 - dy * 7, ey + dy * 13 + dx * 7);
        ctx.lineTo(ex + dx * 13 + dy * 7, ey + dy * 13 - dx * 7);
        ctx.closePath();
        ctx.fill();
        this.badge(ctx, ev, ex, ey, col, null);
      }
    }
  }

  private badge(ctx: CanvasRenderingContext2D, ev: SideEvent, x: number, y: number, col: string, w: World | null) {
    ctx.fillStyle = 'rgba(12,16,20,0.82)';
    ctx.strokeStyle = `rgba(${col},0.95)`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 13, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    const p = this.glyph(ev.kind);
    if (p) {
      ctx.save();
      ctx.translate(x - 9, y - 9);
      ctx.scale(0.75, 0.75);
      ctx.strokeStyle = `rgb(${col})`;
      ctx.lineWidth = 2.2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke(p);
      ctx.restore();
    }
    if (!w) return;
    const label = `${SIDE_LABEL[ev.kind].toUpperCase()} ${fmt(ev.until - w.tick)}`;
    ctx.font = '600 12px "Barlow Condensed", "Roboto Condensed", "Arial Narrow", system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(12,16,20,0.75)';
    ctx.fillRect(x - tw / 2 - 5, y + 16, tw + 10, 15);
    ctx.fillStyle = `rgb(${col})`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 24);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /** Radar pings (minimap canvas, after its transform M: tile -> pixel). */
  drawMinimap(ctx: CanvasRenderingContext2D, w: World, M: DOMMatrix, now: number) {
    if (!w.side.enabled) return;
    for (const ev of w.side.active) {
      const q = M.transformPoint(new DOMPoint(ev.x, ev.y));
      const col = COLOR[ev.kind];
      const k = (now * 0.9 + ev.id * 0.37) % 1;
      ctx.strokeStyle = `rgba(${col},${1 - k})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 4 + 14 * k, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = `rgb(${col})`;
      ctx.beginPath();
      ctx.arc(q.x, q.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}
