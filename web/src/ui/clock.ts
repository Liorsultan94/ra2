import type { ClockState } from '../render/atmos';
import { icon } from './icons';
import './clock.css';

/*
 * HUD clock (top right of the 3D view): "06:42", a sky icon that follows the day
 * (sunrise, sun, sunset, moon), a small weather icon (nothing on a clear day) and
 * "Day 2" once the live day passes midnight. Tapping it shows what it is.
 *
 * The live day (render/atmos.ts) runs 1 real minute = 1 game hour at 1x speed, so
 * the minutes tick about once a real second. A fixed time of day shows its hour,
 * frozen and dimmed (the weather icon still follows dynamic weather).
 */

const WX_LABEL: Record<ClockState['weather'], string> = { clear: 'Clear', cloudy: 'Cloudy', rain: 'Rain', storm: 'Thunderstorm', snow: 'Snow', dust: 'Dust storm' };
const SKY_LABEL: Record<ClockState['icon'], string> = { sunrise: 'Sunrise', sun: 'Day', sunset: 'Sunset', moon: 'Night' };

export interface ClockSource {
  clock(): ClockState;
}

export class HudClock {
  readonly el: HTMLButtonElement;
  private sky: HTMLElement;
  private time: HTMLElement;
  private wx: HTMLElement;
  private day: HTMLElement;
  private tip: HTMLElement;
  private key = '';
  private skyKey = '';
  private wxKey = '';
  private acc = 1;
  private tipTimer = 0;
  private state: ClockState | null = null;

  constructor(parent: HTMLElement) {
    const b = (this.el = document.createElement('button'));
    b.type = 'button';
    b.className = 'hud-clock';
    b.innerHTML = '<span class="hc-day hidden"></span><span class="hc-sky"></span><span class="hc-time">--:--</span><span class="hc-wx hidden"></span><span class="hc-tip" role="tooltip"></span>';
    this.day = b.querySelector('.hc-day')!;
    this.sky = b.querySelector('.hc-sky')!;
    this.time = b.querySelector('.hc-time')!;
    this.wx = b.querySelector('.hc-wx')!;
    this.tip = b.querySelector('.hc-tip')!;
    // a tap on the clock never reaches the battlefield
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      this.showTip(!b.classList.contains('tip-on'));
    });
    parent.appendChild(b);
  }

  private tipText(c: ClockState): string {
    const wx = WX_LABEL[c.weather];
    if (!c.live) return `Fixed time of day · ${SKY_LABEL[c.icon]} · ${wx}`;
    return `Live day: 1 min = 1 hour · Day ${c.day} · ${wx}`;
  }

  private showTip(on: boolean) {
    clearTimeout(this.tipTimer);
    this.el.classList.toggle('tip-on', on);
    if (on) this.tipTimer = window.setTimeout(() => this.el.classList.remove('tip-on'), 3500);
  }

  /** Refresh (cheap: re-reads the source a few times per second, touches the DOM only on a change). */
  update(dt: number, src: ClockSource | null | undefined) {
    this.acc += dt;
    if (!src || this.acc < 0.2) return;
    this.acc = 0;
    const c = src.clock();
    this.state = c;
    const key = `${c.text}|${c.day}|${c.live}`;
    if (key !== this.key) {
      this.key = key;
      this.time.textContent = c.text;
      this.el.classList.toggle('fixed', !c.live);
      this.day.textContent = `Day ${c.day}`;
      this.day.classList.toggle('hidden', c.day < 2);
    }
    if (c.icon !== this.skyKey) {
      this.skyKey = c.icon;
      this.sky.innerHTML = icon(c.icon);
      this.el.dataset.sky = c.icon;
    }
    if (c.weather !== this.wxKey) {
      this.wxKey = c.weather;
      // a clear sky needs no second icon: the sun / moon already says it
      this.wx.innerHTML = c.weather === 'clear' ? '' : icon(c.weather === 'cloudy' ? 'cloud' : c.weather);
      this.wx.classList.toggle('hidden', c.weather === 'clear');
      this.el.dataset.wx = c.weather;
    }
    const tip = this.tipText(c);
    if (this.tip.textContent !== tip) {
      this.tip.textContent = tip;
      this.el.title = tip;
      this.el.setAttribute('aria-label', `${c.text}. ${tip}`);
    }
  }

  /** Last state shown (tests / debugging). */
  get shown(): ClockState | null {
    return this.state;
  }
}
