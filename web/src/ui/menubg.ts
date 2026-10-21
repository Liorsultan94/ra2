/*
 * Rotating picture backdrop of the main menu (menu.ts).
 *
 * Still pictures, one after another: each drifts and zooms very gently (a CSS transform on a
 * composited layer, so it costs nothing per frame) and melts into the next with a slow cross-fade.
 * The starting picture is random per visit and the order is shuffled, so it is never the same
 * picture twice in a row. Add a picture by dropping a file in public/ui/menubg/ and listing it here.
 * Under prefers-reduced-motion the pictures stay still and change with a plain fade.
 */

const PICTURES = ['jungle-carrier', 'neon-city', 'night-fire'];

/** Seconds each picture stays up, and the cross-fade between two of them. */
const HOLD = 9;
const FADE = 1.8;

/** A few drift directions (start and end of the pan, in % of the picture), so each picture moves differently. */
const DRIFTS: [number, number, number, number][] = [
  [-1.2, 0.6, 1.4, -0.8],
  [1.4, -0.6, -1.2, 0.8],
  [0.0, 1.2, 0.4, -1.0],
  [-0.8, -0.8, 1.0, 0.9],
];

function shuffled<T>(a: T[]): T[] {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [r[i], r[j]] = [r[j], r[i]];
  }
  return r;
}

export class MenuBackdrop {
  readonly el: HTMLElement;
  private order: string[] = [];
  private at = -1;
  private count = 0;
  private timer = 0;
  private dead = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'mm-bg';
    this.el.setAttribute('aria-hidden', 'true');
    parent.prepend(this.el);
    if (PICTURES.length === 0) return;
    this.next();
  }

  private url(name: string) {
    return `${import.meta.env.BASE_URL}ui/menubg/${name}.jpg`;
  }

  private pick(): string {
    if (this.order.length === 0 || this.at + 1 >= this.order.length) {
      const last = this.order[this.order.length - 1];
      let o = shuffled(PICTURES);
      // (never the picture that was just on screen, when there is a choice)
      if (o.length > 1 && o[0] === last) o = [...o.slice(1), o[0]];
      this.order = o;
      this.at = -1;
    }
    return this.order[++this.at];
  }

  private next() {
    if (this.dead) return;
    const name = this.pick();
    const img = new Image();
    img.decoding = 'async';
    const show = () => {
      if (this.dead) return;
      const slide = document.createElement('div');
      slide.className = 'mm-bg-slide';
      slide.style.backgroundImage = `url("${this.url(name)}")`;
      const d = DRIFTS[this.count++ % DRIFTS.length];
      slide.style.setProperty('--x0', `${d[0]}%`);
      slide.style.setProperty('--y0', `${d[1]}%`);
      slide.style.setProperty('--x1', `${d[2]}%`);
      slide.style.setProperty('--y1', `${d[3]}%`);
      slide.style.setProperty('--hold', `${HOLD + FADE * 2}s`);
      slide.style.setProperty('--fade', `${FADE}s`);
      const old = [...this.el.children] as HTMLElement[];
      this.el.appendChild(slide);
      // two frames so the new slide is laid out before it fades in; the new one fades in over the old
      // one, which keeps drifting underneath
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          slide.classList.add('go', 'on');
          // (the old picture stays fully up underneath until the new one is all the way in: no dip to black)
          for (const o of old) setTimeout(() => o.remove(), FADE * 1000 + 300);
        }),
      );
      this.timer = window.setTimeout(() => this.next(), HOLD * 1000);
    };
    // decoded before it is shown: no popping in, and a failed load just moves on to the next picture
    img.onload = show;
    img.onerror = () => {
      if (PICTURES.length > 1 && !this.dead) this.timer = window.setTimeout(() => this.next(), 500);
    };
    img.src = this.url(name);
  }

  destroy() {
    this.dead = true;
    clearTimeout(this.timer);
    this.el.remove();
  }
}
