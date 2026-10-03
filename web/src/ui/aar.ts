import { flagDataUrl } from '../render/flags';
import { clock, type MatchReport, type StatSample } from '../game/matchstats';
import type { Player } from '../sim/types';
import './aar.css';

/*
 * After-action report: replaces the plain end screen with a debrief of the
 * match (stats table, MVP, army value / income graphs, highlight reel).
 */

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const num = (n: number) => Math.round(n).toLocaleString('en-US');

const YOU = '#4aa8ff';
const FOE = '#ff5a48';

export interface AarInfo {
  report: MatchReport;
  you: Player;
  enemy: Player;
  codename?: string;
}

/** Line graph of one per-side series over match time. */
function drawGraph(cv: HTMLCanvasElement, samples: StatSample[], pick: (s: StatSample) => [number, number], local: number, unit: string) {
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const W = Math.max(10, cv.clientWidth);
  const H = Math.max(10, cv.clientHeight);
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  const ctx = cv.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const padL = 6;
  const padR = 6;
  const padT = 14;
  const padB = 16;
  const gw = W - padL - padR;
  const gh = H - padT - padB;
  const pts = samples.length ? samples : [{ t: 0, army: [0, 0], income: [0, 0] } as StatSample];
  const tMax = Math.max(1, pts[pts.length - 1].t);
  let vMax = 1;
  for (const s of pts) {
    const v = pick(s);
    vMax = Math.max(vMax, v[0], v[1]);
  }
  vMax *= 1.08;
  const X = (t: number) => padL + (t / tMax) * gw;
  const Y = (v: number) => padT + gh - (v / vMax) * gh;
  // grid
  ctx.strokeStyle = 'rgba(255,255,255,0.07)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = Math.round(padT + (gh * i) / 3) + 0.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();
  }
  ctx.font = '500 10px Inter, system-ui, sans-serif';
  ctx.fillStyle = 'rgba(200,210,205,0.6)';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillText(`${unit}${num(vMax / 1.08)}`, padL + 2, 1);
  ctx.textBaseline = 'bottom';
  ctx.fillText('0:00', padL, H);
  ctx.textAlign = 'right';
  ctx.fillText(clock(tMax), W - padR, H);
  const line = (side: number, color: string, fill: boolean) => {
    ctx.beginPath();
    pts.forEach((s, i) => {
      const x = X(s.t);
      const y = Y(pick(s)[side]);
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    });
    if (fill) {
      ctx.save();
      ctx.lineTo(X(pts[pts.length - 1].t), Y(0));
      ctx.lineTo(X(pts[0].t), Y(0));
      ctx.closePath();
      const g = ctx.createLinearGradient(0, padT, 0, padT + gh);
      g.addColorStop(0, color + '55');
      g.addColorStop(1, color + '00');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      pts.forEach((s, i) => (i ? ctx.lineTo(X(s.t), Y(pick(s)[side])) : ctx.moveTo(X(s.t), Y(pick(s)[side]))));
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  };
  line(1 - local, FOE, false);
  line(local, YOU, true);
}

export function showAfterAction(parent: HTMLElement, info: AarInfo, h: { again(): void; menu(): void }) {
  const r = info.report;
  const win = r.win;
  const y = r.you;
  const e = r.enemy;
  const row = (label: string, a: number, b: number, money = false) => {
    const better = a > b ? 'a' : b > a ? 'b' : '';
    return `<tr><td>${label}</td><td class="${better === 'a' ? 'lead' : ''}">${money ? '$' : ''}${num(a)}</td><td class="${better === 'b' ? 'lead' : ''}">${money ? '$' : ''}${num(b)}</td></tr>`;
  };
  const rowLow = (label: string, a: number, b: number) => `<tr><td>${label}</td><td class="${a < b ? 'lead' : ''}">${num(a)}</td><td class="${b < a ? 'lead' : ''}">${num(b)}</td></tr>`;
  const mvp = r.mvp;
  const stars = mvp ? (mvp.rank >= 2 ? '★★★' : mvp.rank >= 1 ? '★★' : '★') : '';
  const layer = document.createElement('div');
  layer.className = `aar ${win ? 'win' : 'lose'}`;
  layer.innerHTML = `
    <div class="aar-panel">
      <header class="aar-head">
        <div class="aar-result">${win ? 'VICTORY' : 'DEFEAT'}</div>
        <div class="aar-meta">
          <small>AFTER-ACTION REPORT${info.codename ? ` · OPERATION ${esc(info.codename)}` : ''}</small>
          <span>${win ? 'The enemy has been eliminated.' : 'Your forces have been destroyed.'}</span>
          <span>Battle time <b>${clock(r.time)}</b></span>
        </div>
      </header>
      <div class="aar-body">
        <section class="aar-col">
          <table class="aar-table">
            <tr><th></th><th><img src="${flagDataUrl(info.you.faction)}" alt="">You</th><th><img src="${flagDataUrl(info.enemy.faction)}" alt="">${esc(info.enemy.name)}</th></tr>
            ${row('Units built', y.unitsBuilt, e.unitsBuilt)}
            ${row('Units destroyed', y.unitsKilled, e.unitsKilled)}
            ${rowLow('Units lost', y.unitsLost, e.unitsLost)}
            ${row('Structures built', y.structuresBuilt, e.structuresBuilt)}
            ${row('Structures destroyed', y.structuresDestroyed, e.structuresDestroyed)}
            ${rowLow('Structures lost', y.structuresLost, e.structuresLost)}
            ${row('Credits harvested', y.harvested, e.harvested, true)}
            ${row('Peak army value', y.peakArmy, e.peakArmy, true)}
            ${row('Superweapons used', y.superweapons, e.superweapons)}
            ${row('Missiles intercepted', y.intercepted, e.intercepted)}
          </table>
          <div class="aar-mvp">
            <div class="mvp-badge">MVP</div>
            ${
              mvp
                ? `<div class="mvp-info"><b>${esc(mvp.name)}</b><span class="mvp-rank r${mvp.rank}">${stars} ${esc(mvp.rankName || 'Rookie')}</span><small>${mvp.kills} kill${mvp.kills === 1 ? '' : 's'} · ${mvp.alive ? 'survived the battle' : 'fell in battle'}</small></div>`
                : '<div class="mvp-info"><b>No confirmed kills</b><small>Nobody earned the honours this time.</small></div>'
            }
          </div>
        </section>
        <section class="aar-col">
          <div class="aar-graph">
            <div class="ag-tabs"><button class="on" data-g="army">Army value</button><button data-g="income">Income</button><span class="ag-key"><i style="background:${YOU}"></i>You <i style="background:${FOE}"></i>Enemy</span></div>
            <canvas></canvas>
          </div>
          <div class="aar-hl">
            <h3>Highlights</h3>
            <ol>${r.highlights.map((x) => `<li class="${x.kind}"><time>${clock(x.t)}</time>${esc(x.text)}</li>`).join('')}</ol>
          </div>
        </section>
      </div>
      <footer class="aar-foot">
        <button class="mbtn" data-a="menu">Main menu</button>
        <button class="mbtn primary" data-a="again">Play again</button>
      </footer>
    </div>`;
  parent.appendChild(layer);
  const cv = layer.querySelector('canvas') as HTMLCanvasElement;
  let mode: 'army' | 'income' = 'army';
  const draw = () => drawGraph(cv, r.samples, mode === 'army' ? (s) => s.army : (s) => s.income, r.local, mode === 'army' ? '$' : '$/min ');
  requestAnimationFrame(draw);
  const onResize = () => draw();
  window.addEventListener('resize', onResize);
  layer.querySelectorAll<HTMLButtonElement>('.ag-tabs button').forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.g === 'income' ? 'income' : 'army';
      layer.querySelectorAll('.ag-tabs button').forEach((x) => x.classList.toggle('on', x === b));
      draw();
    }),
  );
  const close = (fn: () => void) => () => {
    window.removeEventListener('resize', onResize);
    layer.remove();
    fn();
  };
  layer.querySelector('[data-a=again]')!.addEventListener('click', close(h.again));
  layer.querySelector('[data-a=menu]')!.addEventListener('click', close(h.menu));
  return layer;
}
