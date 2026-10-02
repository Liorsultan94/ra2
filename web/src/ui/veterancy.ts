// Veterancy insignia for the HUD: rank chevrons next to health bars (2D overlay canvas)
// and the rank badge / experience line in the selected-unit portrait panel.

import { ELITE, RANK_NAMES, VETERAN, rankThreshold, type Rank } from '../sim/veterancy';
import type { Entity } from '../sim/types';
import './veterancy.css';

const GOLD = '#ffd45a';
const GOLD_HI = '#fff3b8';
const GOLD_LO = '#a8761c';

/** Animation state per unit: the moment it was last seen getting a new rank. */
export class RankPops {
  private seen = new Map<number, { rank: number; t: number }>();

  /** Returns the promotion pop 0..1 (1 = just promoted, fades over ~1.6 s). */
  pop(e: Entity, now: number): number {
    let s = this.seen.get(e.id);
    if (!s) {
      s = { rank: e.rank, t: -99 };
      this.seen.set(e.id, s);
    } else if (e.rank > s.rank) {
      s.rank = e.rank;
      s.t = now;
    }
    return Math.max(0, 1 - (now - s.t) / 1.6);
  }

  prune(alive: (id: number) => boolean) {
    if (this.seen.size < 400) return;
    for (const id of this.seen.keys()) if (!alive(id)) this.seen.delete(id);
  }
}

function chevron(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, t: number) {
  // a "^"-shaped stripe, point up
  ctx.beginPath();
  ctx.moveTo(cx - w / 2, cy + h / 2);
  ctx.lineTo(cx, cy - h / 2);
  ctx.lineTo(cx + w / 2, cy + h / 2);
  ctx.lineTo(cx + w / 2, cy + h / 2 - t);
  ctx.lineTo(cx, cy - h / 2 + t * 1.15);
  ctx.lineTo(cx - w / 2, cy + h / 2 - t);
  ctx.closePath();
}

function star(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 ? r * 0.45 : r;
    ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr);
  }
  ctx.closePath();
}

/**
 * Draw the rank insignia centred at (cx, cy) in canvas pixels: one chevron for a veteran,
 * two chevrons under a star for an elite. `pop` (0..1) scales and flares it right after a promotion.
 */
export function drawRankInsignia(ctx: CanvasRenderingContext2D, cx: number, cy: number, rank: number, pop = 0, now = 0) {
  if (rank < VETERAN) return;
  const s = 1.15 + pop * 0.9;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(s, s);
  if (pop > 0) {
    // golden flare behind the insignia
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 12);
    g.addColorStop(0, `rgba(255,236,150,${0.85 * pop})`);
    g.addColorStop(1, 'rgba(255,200,60,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-12, -12, 24, 24);
  }
  const grad = ctx.createLinearGradient(0, -6, 0, 6);
  grad.addColorStop(0, GOLD_HI);
  grad.addColorStop(0.45, GOLD);
  grad.addColorStop(1, GOLD_LO);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = 'rgba(10,8,2,0.85)';
  ctx.fillStyle = grad;
  if (rank >= ELITE) {
    // slow glint for elites
    const glint = 0.5 + 0.5 * Math.sin(now * 3.1);
    chevron(ctx, 0, 2.6, 9, 4.6, 2.1);
    ctx.stroke();
    ctx.fill();
    chevron(ctx, 0, 6.2, 9, 4.6, 2.1);
    ctx.stroke();
    ctx.fill();
    star(ctx, 0, -3.4, 3.9);
    ctx.stroke();
    ctx.fillStyle = `rgb(255,${Math.round(214 + 30 * glint)},${Math.round(90 + 110 * glint)})`;
    ctx.fill();
  } else {
    chevron(ctx, 0, 1, 9, 5, 2.3);
    ctx.stroke();
    ctx.fill();
  }
  ctx.restore();
}

/** Inline SVG rank badge for the portrait panel. */
export function rankBadgeSvg(rank: number): string {
  if (rank < VETERAN) return '';
  const chev = (y: number) => `<path d="M2 ${y + 5} L8 ${y} L14 ${y + 5} L14 ${y + 2.4} L8 ${y - 2.6} L2 ${y + 2.4} Z"/>`;
  const body = rank >= ELITE ? `<path d="M8 0.6 L9.3 3.6 L12.5 3.9 L10.1 6 L10.8 9.1 L8 7.5 L5.2 9.1 L5.9 6 L3.5 3.9 L6.7 3.6 Z"/>${chev(11)}${chev(15.5)}` : chev(10);
  return `<span class="vet-badge vet-r${rank}" title="${RANK_NAMES[rank]}"><svg viewBox="0 0 16 21" aria-hidden="true">${body}</svg></span>`;
}

/** Rank line for the portrait panel: rank name, and for own units the progress to the next rank. */
export function rankLineHtml(e: Entity, own: boolean, canRankUp: boolean): string {
  if (!canRankUp) return '';
  const rank = e.rank as Rank;
  let prog = '';
  if (own && rank < ELITE) {
    const lo = rankThreshold(e.def, rank);
    const hi = rankThreshold(e.def, (rank + 1) as Rank);
    const k = Math.max(0, Math.min(1, (e.xp - lo) / Math.max(1, hi - lo)));
    prog = `<span class="vet-xp" title="Experience to ${RANK_NAMES[rank + 1]}"><i style="width:${(k * 100).toFixed(0)}%"></i></span>`;
  }
  return `<div class="vet-line vet-r${rank}">${rank ? rankBadgeSvg(rank) : ''}<span class="vet-name">${RANK_NAMES[rank]}</span>${prog}</div>`;
}
