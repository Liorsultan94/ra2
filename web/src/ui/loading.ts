/*
 * Full-screen loading overlay while a battle's world and battlefield are being
 * built (app.ts, before the battle's own briefing / warm-up overlay takes over).
 * Same look as the HUD's shader warm-up overlay (style.css .warmup): emblem,
 * radar sweep, progress bar. The build runs in time slices (game.ts
 * Game.create), so the sweep keeps turning and the bar keeps moving.
 */

export interface LoadingOverlay {
  set(k: number): void;
  close(): void;
}

export function showLoading(parent: HTMLElement, title = 'Deploying forces', sub = 'Building the battlefield'): LoadingOverlay {
  const L = document.createElement('div');
  L.className = 'warmup boot-load';
  L.innerHTML = `<div class="wu-box"><div class="wu-title"></div><div class="wu-bar"><i></i></div><div class="wu-sub"></div></div>`;
  (L.querySelector('.wu-sub') as HTMLElement).textContent = sub;
  const t = L.querySelector('.wu-title') as HTMLElement;
  const bar = L.querySelector('.wu-bar i') as HTMLElement;
  parent.appendChild(L);
  let closed = false;
  const set = (k: number) => {
    if (closed) return;
    const p = Math.round(Math.max(0, Math.min(1, k)) * 100);
    t.textContent = `${title}… ${p}%`;
    bar.style.width = `${p}%`;
  };
  set(0);
  return {
    set,
    close() {
      if (closed) return;
      closed = true;
      L.classList.add('done');
      setTimeout(() => L.remove(), 350);
    },
  };
}
