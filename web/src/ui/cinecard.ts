import './cinecard.css';

/*
 * Letterbox bars and title cards for the battle intro / outro (src/render/intro.ts).
 * Pure DOM; it swallows taps on the battlefield while it is up (they skip).
 */

export interface CardText {
  kicker?: string;
  /** Flag image (data URL) shown before the kicker. */
  flag?: string;
  title: string;
  sub?: string;
  tone?: 'intro' | 'win' | 'lose';
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export class CineCard {
  readonly el: HTMLElement;
  private card: HTMLElement;

  constructor(parent: HTMLElement, onSkip: () => void, skipLabel = 'TAP TO SKIP') {
    this.el = document.createElement('div');
    this.el.className = 'cinecard';
    this.el.innerHTML = `<div class="cc-bar top"></div><div class="cc-bar bottom"></div><div class="cc-card"></div><div class="cc-skip">${esc(skipLabel)}</div>`;
    this.card = this.el.querySelector('.cc-card') as HTMLElement;
    this.el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onSkip();
    });
    parent.appendChild(this.el);
    // next frame: slide the bars in
    requestAnimationFrame(() => this.el.classList.add('on'));
  }

  show(t: CardText) {
    this.card.className = `cc-card ${t.tone ?? 'intro'}`;
    this.card.innerHTML = `
      ${t.kicker ? `<div class="cc-kicker">${t.flag ? `<img src="${t.flag}" alt="">` : ''}${esc(t.kicker)}</div>` : ''}
      <div class="cc-title">${esc(t.title)}</div>
      ${t.sub ? `<div class="cc-sub">${esc(t.sub)}</div>` : ''}`;
    requestAnimationFrame(() => this.card.classList.add('in'));
  }

  hideCard() {
    this.card.classList.remove('in');
    this.card.classList.add('out');
  }

  /** Bars out, then remove. */
  close() {
    this.el.classList.remove('on');
    this.el.classList.add('closing');
    this.hideCard();
    setTimeout(() => this.el.remove(), 450);
  }

  destroy() {
    this.el.remove();
  }
}
