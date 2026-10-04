import { formatPeace, peaceSecondsLeft } from '../sim/peace';
import './peace.css';

/*
 * "Peace time 5:12" chip under the HUD clock (top right of the view) while the
 * early-game grace runs (sim/peace.ts): the enemy builds up but does not attack.
 * Tick-based like the grace itself, so it follows the game speed. Tapping it
 * says what it means. Hidden once the grace is over (the game announces it).
 */
export class PeaceChip {
  readonly el: HTMLButtonElement;
  private time: HTMLElement;
  private until = 0;
  private shown = '';
  private tipTimer = 0;

  constructor(private host: HTMLElement) {
    const b = (this.el = document.createElement('button'));
    b.type = 'button';
    b.className = 'peace-chip hidden';
    b.innerHTML =
      '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4M5 4.5h11l-2 3.5 2 3.5H5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '<b>Peace time</b><span class="pc-time">0:00</span><span class="pc-tip" role="tooltip">No enemy attacks until the timer runs out: build up your base</span>';
    this.time = b.querySelector('.pc-time')!;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      clearTimeout(this.tipTimer);
      const on = !b.classList.contains('tip-on');
      b.classList.toggle('tip-on', on);
      if (on) this.tipTimer = window.setTimeout(() => b.classList.remove('tip-on'), 3500);
    });
    host.appendChild(b);
  }

  /** Grace end tick (0 = no grace: the chip stays hidden). */
  setUntil(until: number) {
    this.until = until;
    this.shown = '';
  }

  /** Refresh from the simulation tick (touches the DOM only when the text changes). */
  update(tick: number) {
    const left = peaceSecondsLeft(tick, this.until);
    const text = left > 0 ? formatPeace(left) : '';
    if (text === this.shown) return;
    this.shown = text;
    const on = left > 0;
    this.el.classList.toggle('hidden', !on);
    this.host.classList.toggle('peace-on', on);
    if (!on) return;
    this.time.textContent = text;
    // last minute: the chip turns amber
    this.el.classList.toggle('ending', left <= 60);
    this.el.setAttribute('aria-label', `Peace time: ${text} left before enemy attacks`);
  }

  /** Seconds of grace left (tests / debugging). */
  secondsLeft(tick: number) {
    return peaceSecondsLeft(tick, this.until);
  }
}
