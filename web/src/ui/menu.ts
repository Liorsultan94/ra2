import { DEFS, FACTIONS } from '../sim/defs';
import type { Difficulty } from '../sim/ai';
import type { Faction, Player } from '../sim/types';
import type { MapId } from '../sim/map';
import type { Quality } from '../render/renderer';
import { autoQuality } from '../render/autoquality';
import { setReadabilityPrefs } from '../render/readability';
import { flagHtml } from './hud';
import emblemSvg from './emblem.svg?raw';
import { MAPS } from '../sim/maps';
import type { Game } from '../game/game';
import { MenuHero, heroDef } from './menuhero';
import { startMenuCamera } from './menucam';
import './maps.css';
import './menu.css';

export interface Settings {
  faction: Faction;
  enemy: Faction | 'random';
  difficulty: Difficulty;
  credits: number;
  quality: Quality | 'auto';
  sfx: number;
  music: number;
  voice: boolean;
  /** Slow-motion camera moments on big events (missile launches, interceptions, huge blasts). */
  cinematic: boolean;
  /** Skirmish map (sim/maps.ts; ?map= overrides it). */
  map?: MapId;
  /**
   * Skirmish atmosphere (visual only; read by src/render/atmos.ts). Unset = the live day ('cycle':
   * 1 real minute = 1 game hour, from 05:30) with dynamic weather following the map's climate;
   * weather 'map' = the map's own fixed weather.
   */
  tod?: 'day' | 'dusk' | 'night' | 'cycle' | 'mist';
  weather?: 'map' | 'clear' | 'rain' | 'snow' | 'sandstorm' | 'dynamic';
  /** Drone camera picture-in-picture: 'auto' shows the feed of a selected / attacking drone. */
  droneCam: 'auto' | 'off';
  /** Team-coloured silhouettes of units hidden behind buildings and trees. */
  xray: boolean;
  /** Team-coloured strategic unit icons when zoomed out (src/render/readability.ts). */
  icons?: boolean;
  /** Thin team-coloured outline around every unit. */
  outlines?: boolean;
  /** Performance readout (fps, frame ms, draw calls; src/render/perf/hud.ts). */
  showFps?: boolean;
  /** Battery saver: cap the frame rate at 30 fps. */
  battery?: boolean;
  /**
   * Control scheme: 'simple' (phones: tap = select / move, big ARMY button, decluttered HUD)
   * or 'advanced' (the full RTS command set; mouse and keyboard always work the same).
   */
  controls: 'simple' | 'advanced';
}

/** Default control scheme: simple on touch screens, advanced with a mouse. */
export function defaultControls(): Settings['controls'] {
  return typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches ? 'simple' : 'advanced';
}

const KEY = 'ironfront.settings.v1';

export function loadSettings(): Settings {
  const def: Settings = { faction: 'usa', enemy: 'random', difficulty: 'normal', credits: 10000, quality: 'auto', sfx: 0.8, music: 0.35, voice: true, cinematic: true, droneCam: 'auto', xray: true, controls: defaultControls() };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s: Settings = { ...def, ...JSON.parse(raw) };
      setReadabilityPrefs(s);
      return s;
    }
  } catch {
    /* storage unavailable */
  }
  return def;
}

export function saveSettings(s: Settings) {
  setReadabilityPrefs(s);
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function resolveQuality(q: Settings['quality']): Quality {
  // auto: device probe (GPU, memory, float targets, micro-benchmark), cached, corrected by the frame-time governor (src/render/autoquality.ts)
  return q === 'auto' ? autoQuality() : q;
}

const h = (html: string) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* small line icons for the menu (24 x 24, stroke = currentColor, like ui/icons.ts) */
const MI: Record<string, string> = {
  play: '<path d="M8 5.5v13l10.5-6.5z"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  book: '<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v16h5.5a1.5 1.5 0 0 0 1.5-1.5z"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7"/>',
  globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 3.8 5.2 3.8 8.5s-1.2 6.1-3.8 8.5c-2.6-2.4-3.8-5.2-3.8-8.5S9.4 5.9 12 3.5z"/>',
  eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  back: '<path d="M14.5 6l-6 6 6 6"/>',
  chev: '<path d="M9.5 6l6 6-6 6"/>',
  flagI: '<path d="M5 21V4M5 4.5h11l-2 3.5 2 3.5H5"/>',
  map: '<path d="M3.5 6.5l5-2 7 2.5 5-2v13l-5 2-7-2.5-5 2z"/><path d="M8.5 4.5v13M15.5 7v13"/>',
  rules: '<path d="M5 7h14M5 12h14M5 17h9"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1.2" fill="currentColor"/><circle cx="15" cy="15" r="1.2" fill="currentColor"/><circle cx="15" cy="9" r="1.2" fill="currentColor"/><circle cx="9" cy="15" r="1.2" fill="currentColor"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.5 1.5M17.2 17.2l1.5 1.5M5.3 18.7l1.5-1.5M17.2 6.8l1.5-1.5"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/><path d="M9.5 4.5L12 7l2.5-2.5M9.5 19.5L12 17l2.5 2.5"/>',
  dune: '<path d="M2.5 17.5c3-4 6-6 9.5-6s5.5 2 9.5 6"/><path d="M2.5 20.5h19"/><circle cx="17" cy="6.5" r="2.2"/>',
  city: '<path d="M3 20.5h18"/><path d="M5 20.5V9h5v11.5M10 20.5V4.5h6v16M16 20.5V11h3.5v9.5"/><path d="M12.5 8h1M12.5 11h1M12.5 14h1M7 12h1M7 15h1"/>',
};
const mi = (n: string, cls = '') => `<svg class="mi ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MI[n] ?? ''}</svg>`;

const DIFF_LABEL: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
const DIFF_NOTE: Record<Difficulty, string> = { easy: 'Relaxed AI, slow build-up', normal: 'Balanced, adaptive AI', hard: 'Aggressive, full-economy AI' };
const CLIMATE: Record<string, { label: string; icon: string }> = {
  temperate: { label: 'Temperate', icon: 'sun' },
  desert: { label: 'Arid', icon: 'dune' },
  winter: { label: 'Arctic', icon: 'snow' },
  urban: { label: 'Urban', icon: 'city' },
};
const TOD_OPTS: [string, string][] = [
  ['cycle', 'Dawn'],
  ['mist', 'Misty'],
  ['day', 'Day'],
  ['dusk', 'Dusk'],
  ['night', 'Night'],
];
const WX_OPTS: [string, string][] = [
  ['dynamic', 'Live'],
  ['map', 'Map'],
  ['clear', 'Clear'],
  ['rain', 'Rain'],
  ['snow', 'Snow'],
  ['sandstorm', 'Sand'],
];

/** Segmented control: visually hidden radios (keyboard + screen readers), labels as the segments. */
function seg(key: string, attr: 's' | 'o', cur: string, items: [string, string][], label: string, cls = '') {
  return `<div class="seg ${cls}" role="radiogroup" aria-label="${esc(label)}">${items
    .map(([v, l]) => `<label class="seg-i"><input type="radio" name="mm-${key}" value="${v}" data-${attr}="${key}"${v === cur ? ' checked' : ''}><span>${l}</span></label>`)
    .join('')}</div>`;
}

function mapThumb(id: string) {
  return `${import.meta.env.BASE_URL}ui/maps/${id}.jpg`;
}

export interface MenuHandlers {
  onStart(s: Settings): void;
  onSettings(s: Settings): void;
  onUnlockAudio(): void;
  /** The demo battle behind the menu (cinematic camera, menucam.ts). */
  demo?: () => Game | null;
}

type Tab = 'nation' | 'map' | 'rules';

/**
 * Main menu over the live AI-vs-AI demo battle: a title screen with the main
 * navigation, a three-tab skirmish setup (nation, battlefield, rules) beside a
 * loadout summary with the nation's rotating 3D hero vehicle, how-to-play and
 * settings pages. Styles: menu.css (layout, glass, motion), maps.css (map cards).
 */
export class MainMenu {
  readonly el: HTMLElement;
  private settings: Settings;
  private stage: HTMLElement;
  private tab: Tab = 'nation';
  private hero: MenuHero;
  private stopCam: () => void;
  private onKey = (e: KeyboardEvent) => this.key(e);
  private back: (() => void) | null = null;

  constructor(
    parent: HTMLElement,
    private handlers: MenuHandlers,
  ) {
    this.settings = loadSettings();
    const q = resolveQuality(this.settings.quality);
    const lite = q === 'low';
    this.el = h(`
      <div class="menu-layer mm${lite ? ' mm-lite' : ''}">
        <div class="mm-shade" aria-hidden="true"></div>
        <div class="mm-grain" aria-hidden="true"></div>
        <div class="mm-stage"></div>
      </div>`);
    this.stage = this.el.querySelector('.mm-stage')!;
    parent.appendChild(this.el);
    this.hero = new MenuHero(!lite);
    this.stopCam = handlers.demo ? startMenuCamera(handlers.demo) : () => {};
    this.el.addEventListener('pointerdown', () => handlers.onUnlockAudio());
    // watch mode: any tap brings the menu back
    this.el.addEventListener('click', (e) => {
      if (this.el.classList.contains('mm-watch') && !(e.target as Element).closest?.('[data-a=watch]')) this.el.classList.remove('mm-watch');
    });
    window.addEventListener('keydown', this.onKey);
    this.showTitle();
  }

  private key(e: KeyboardEvent) {
    if (!this.el.isConnected) return;
    if (e.key === 'Escape' && this.back) {
      e.preventDefault();
      this.back();
    } else if (this.el.classList.contains('mm-watch') && (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      this.el.classList.remove('mm-watch');
    }
  }

  /** Swap the page with a short cross-fade (the old page slides out, the new one staggers in). */
  private screen(html: string, back: (() => void) | null = null) {
    this.hero.hide();
    this.back = back;
    const old = [...this.stage.children] as HTMLElement[];
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const o of old) {
      if (reduce || !o.classList.contains('mm-page')) {
        o.remove();
        continue;
      }
      o.classList.add('mm-leave');
      o.setAttribute('aria-hidden', 'true');
      o.inert = true;
      setTimeout(() => o.remove(), 200);
    }
    const s = h(html);
    s.classList.add('mm-page');
    this.el.dataset.page = s.classList.contains('title-screen') ? 'title' : 'sub';
    this.el.classList.remove('mm-watch');
    this.stage.appendChild(s);
    return s;
  }

  private quickLine() {
    const st = this.settings;
    const f = FACTIONS.find((x) => x.id === st.faction);
    const m = MAPS.find((x) => x.id === (st.map ?? 'frontline')) ?? MAPS[0];
    return `<span class="qb-nation">${flagHtml(st.faction)}${f?.name ?? ''}</span><span class="qb-dot"></span><span>${m.name}</span><span class="qb-dot"></span><span>${DIFF_LABEL[st.difficulty]}</span>`;
  }

  showTitle() {
    const s = this.screen(`
      <div class="title-screen">
        <header class="mm-topbar mm-rise" style="--i:0">
          <span class="mm-live"><i></i>Live · AI demo battle</span>
        </header>
        <div class="tt-main">
          <div class="logo">
            <div class="logo-emblem">${emblemSvg}</div>
            <div class="logo-word">
              <div class="logo-top">IRON</div>
              <div class="logo-bottom">FRONT</div>
            </div>
            <div class="logo-sub">Modern warfare · Real-time strategy</div>
          </div>
          <nav class="menu-buttons mm-nav" aria-label="Main menu">
            <button class="mbtn primary mm-cta mm-rise" style="--i:1" data-a="quick">
              <span class="mm-cta-ico">${mi('play')}</span>
              <span class="mm-cta-txt"><b>Quick Battle</b><small class="qb-line">${this.quickLine()}</small></span>
              ${mi('chev', 'mm-go')}
            </button>
            <button class="mbtn mm-item mm-rise" style="--i:2" data-a="skirmish">
              <span class="mm-item-ico">${mi('sliders')}</span>
              <span class="mm-cta-txt"><b>Skirmish</b><small>Nation, battlefield &amp; rules</small></span>
              ${mi('chev', 'mm-go')}
            </button>
            <div class="mm-row">
              <button class="mbtn mm-tile mm-rise" style="--i:3" data-a="howto">${mi('book')}<span>How to play</span></button>
              <button class="mbtn mm-tile mm-rise" style="--i:4" data-a="settings">${mi('gear')}<span>Settings</span></button>
              <button class="mbtn mm-tile mm-rise" style="--i:5" data-a="watch" title="Hide the menu and watch the demo battle">${mi('eye')}<span>Watch</span></button>
              <button class="mbtn mm-tile mm-rise" style="--i:6" disabled title="Coming in the next update">${mi('globe')}<span>Online <small>soon</small></span></button>
            </div>
          </nav>
        </div>
        <footer class="menu-foot mm-rise" style="--i:7">Original fan project inspired by classic RTS games. All art and sound are procedurally generated.</footer>
        <button class="mm-watch-exit" data-a="unwatch" aria-label="Back to the menu">${mi('back')}<span>Menu</span></button>
      </div>`);
    // one tap into a battle with the last skirmish settings
    s.querySelector('[data-a=quick]')!.addEventListener('click', () => this.handlers.onStart(this.settings));
    s.querySelector('[data-a=skirmish]')!.addEventListener('click', () => this.showSkirmish());
    s.querySelector('[data-a=howto]')!.addEventListener('click', () => this.showHowTo(() => this.showTitle()));
    s.querySelector('[data-a=settings]')!.addEventListener('click', () => this.showSettings(() => this.showTitle()));
    s.querySelector('[data-a=watch]')!.addEventListener('click', () => this.el.classList.add('mm-watch'));
    s.querySelector('[data-a=unwatch]')!.addEventListener('click', () => this.el.classList.remove('mm-watch'));
  }

  showSkirmish() {
    const st = this.settings;
    const curMap = st.map ?? 'frontline';
    const cards = FACTIONS.map(
      (f, i) => `
      <button class="fcard${f.id === st.faction ? ' sel' : ''}" data-f="${f.id}" role="radio" aria-checked="${f.id === st.faction}" style="--i:${i}">
        <span class="fc-flag">${flagHtml(f.id)}</span>
        <span class="fc-txt"><b>${f.name}</b><span class="fc-doc">${f.doctrine}</span><span class="fc-bon">${f.bonuses.map((b) => `<span>${esc(b)}</span>`).join('')}</span></span>
      </button>`,
    ).join('');
    const maps = MAPS.map((m, i) => {
      const c = CLIMATE[m.biome] ?? CLIMATE.temperate;
      return `
      <button class="mtile${m.id === curMap ? ' sel' : ''}" data-map="${m.id}" role="radio" aria-checked="${m.id === curMap}" style="--i:${i}">
        <img class="mt-img" src="${mapThumb(m.id)}" alt="" decoding="async" onerror="this.remove()">
        <span class="mt-badge" data-c="${m.biome}">${mi(c.icon)}${c.label}</span>
        <span class="mt-txt"><b>${m.name}</b><small>${m.blurb}</small></span>
      </button>`;
    }).join('');
    const enemies: [string, string][] = [['random', `${mi('dice')}<em>Random</em>`], ...FACTIONS.map((f) => [f.id, flagHtml(f.id)] as [string, string])];
    const s = this.screen(
      `
      <div class="mm-sub skirmish">
        <header class="mm-head mm-rise" style="--i:0">
          <button class="mm-back" data-a="back" aria-label="Back to the main menu">${mi('back')}<span>Back</span></button>
          <h2 class="mm-title"><small>Skirmish</small>Mission setup</h2>
          <div class="mm-tabs" role="tablist" aria-label="Skirmish setup">
            <button class="mm-tab" role="tab" data-tab="nation">${mi('flagI')}<span>Nation</span></button>
            <button class="mm-tab" role="tab" data-tab="map">${mi('map')}<span>Battlefield</span></button>
            <button class="mm-tab" role="tab" data-tab="rules">${mi('rules')}<span>Rules</span></button>
          </div>
        </header>
        <div class="mm-body">
          <section class="mm-pane mm-glass mm-rise" style="--i:1">
            <div class="mm-panel" data-panel="nation" role="tabpanel">
              <div class="mm-kicker">Choose your nation</div>
              <div class="fgrid" role="radiogroup" aria-label="Nation">${cards}</div>
            </div>
            <div class="mm-panel" data-panel="map" role="tabpanel">
              <div class="mm-kicker">Choose the battlefield</div>
              <div class="mpick" role="radiogroup" aria-label="Battlefield">${maps}</div>
            </div>
            <div class="mm-panel opts" data-panel="rules" role="tabpanel">
              <div class="mm-kicker">Rules of engagement</div>
              <div class="mm-field"><span class="mm-lbl">Opponent<b data-v="enemy"></b></span>${seg('enemy', 'o', st.enemy, enemies, 'Opponent nation', 'seg-flags')}</div>
              <div class="mm-field"><span class="mm-lbl">Difficulty<b data-v="difficulty"></b></span>${seg('difficulty', 'o', st.difficulty, [['easy', 'Easy'], ['normal', 'Normal'], ['hard', 'Hard']], 'Difficulty')}</div>
              <div class="mm-field"><span class="mm-lbl">Credits</span>${seg('credits', 'o', String(st.credits), [5000, 10000, 20000].map((c) => [String(c), '$' + c / 1000 + 'k'] as [string, string]), 'Starting credits')}</div>
              <div class="mm-field"><span class="mm-lbl">Start time</span>${seg('tod', 'o', st.tod ?? 'cycle', TOD_OPTS, 'Time of day')}</div>
              <div class="mm-field"><span class="mm-lbl">Weather</span>${seg('weather', 'o', st.weather ?? 'dynamic', WX_OPTS, 'Weather')}</div>
              <p class="note live-note">The clock always runs (1 min = 1 hour): pick when the battle starts, at dawn 05:30, misty 06:00, day 10:00, dusk 17:30 or night 21:00. The sun sets around 18:30, rain, snow or dust fronts come and go with the map's climate. Map: the battlefield's own fixed weather.</p>
            </div>
          </section>
          <aside class="mm-sum mm-glass mm-rise" style="--i:2" aria-label="Loadout">
            <div class="sum-hero">
              <div class="sum-flagart" aria-hidden="true"></div>
              <div class="sum-stage"></div>
              <div class="sum-unit"><small>Hero vehicle</small><b data-v="hero"></b></div>
            </div>
            <div class="sum-nation"><span data-v="flag"></span><div><b data-v="nation"></b><small data-v="doctrine"></small></div></div>
            <ul class="sum-bonus" data-v="bonuses"></ul>
            <dl class="sum-lines">
              <div><dt>${mi('map')}Map</dt><dd data-v="map"></dd></div>
              <div><dt>${mi('flagI')}Enemy</dt><dd data-v="enemy2"></dd></div>
              <div><dt>${mi('rules')}AI</dt><dd data-v="diff2"></dd></div>
            </dl>
            <button class="mbtn primary deploy" data-a="start"><span>Deploy</span>${mi('chev', 'mm-go')}</button>
          </aside>
        </div>
      </div>`,
      () => this.showTitle(),
    );
    const $ = <T extends HTMLElement = HTMLElement>(q: string) => s.querySelector<T>(q)!;
    const set = (k: string, html: string) => s.querySelectorAll<HTMLElement>(`[data-v=${k}]`).forEach((e) => (e.innerHTML = html));
    const sum = () => {
      const f = FACTIONS.find((x) => x.id === st.faction) ?? FACTIONS[0];
      const m = MAPS.find((x) => x.id === (st.map ?? 'frontline')) ?? MAPS[0];
      const en = st.enemy === 'random' ? null : FACTIONS.find((x) => x.id === st.enemy);
      const hd = heroDef(f.id);
      set('flag', flagHtml(f.id));
      set('nation', esc(f.name));
      set('doctrine', esc(f.doctrine));
      set('bonuses', f.bonuses.map((b) => `<li>${esc(b)}</li>`).join('') + `<li class="sig">${f.signature.map((id) => `<span>${esc(DEFS[id]?.name ?? id)}</span>`).join('')}</li>`);
      set('hero', esc(hd ? (DEFS[hd]?.name ?? '') : ''));
      set('map', esc(m.name));
      set('enemy', esc(en ? en.name : 'Random nation'));
      set('enemy2', en ? `${flagHtml(en.id)}${esc(en.name)}` : 'Random nation');
      set('difficulty', esc(DIFF_NOTE[st.difficulty]));
      set('diff2', DIFF_LABEL[st.difficulty]);
      const art = $('.sum-flagart');
      art.style.backgroundImage = `url("${(flagHtml(f.id).match(/src="([^"]+)"/) ?? [])[1] ?? ''}")`;
      s.style.setProperty('--nat', '#' + f.accent.toString(16).padStart(6, '0'));
      this.hero.show($('.sum-stage'), f.id);
    };
    const setTab = (t: Tab, focus = false) => {
      this.tab = t;
      s.querySelectorAll<HTMLElement>('.mm-tab').forEach((b) => {
        const on = b.dataset.tab === t;
        b.setAttribute('aria-selected', String(on));
        b.tabIndex = on ? 0 : -1;
        if (on && focus) b.focus();
      });
      s.querySelectorAll<HTMLElement>('.mm-panel').forEach((p) => {
        const on = p.dataset.panel === t;
        p.hidden = !on;
        // replay the stagger on every tab switch
        if (on) {
          p.classList.remove('mm-in');
          void p.offsetWidth;
          p.classList.add('mm-in');
        }
      });
    };
    const tabs = [...s.querySelectorAll<HTMLElement>('.mm-tab')];
    tabs.forEach((b, i) => {
      b.addEventListener('click', () => setTab(b.dataset.tab as Tab));
      b.addEventListener('keydown', (e) => {
        const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
        if (!d) return;
        e.preventDefault();
        setTab(tabs[(i + d + tabs.length) % tabs.length].dataset.tab as Tab, true);
      });
    });
    const pick = (sel: string, el: HTMLElement) =>
      s.querySelectorAll<HTMLElement>(sel).forEach((x) => {
        x.classList.toggle('sel', x === el);
        x.setAttribute('aria-checked', String(x === el));
      });
    s.querySelectorAll<HTMLElement>('.fcard').forEach((c) =>
      c.addEventListener('click', () => {
        st.faction = c.dataset.f as Faction;
        pick('.fcard', c);
        sum();
      }),
    );
    s.querySelectorAll<HTMLElement>('.mtile').forEach((t) =>
      t.addEventListener('click', () => {
        st.map = t.dataset.map as MapId;
        pick('.mtile', t);
        sum();
      }),
    );
    s.querySelectorAll<HTMLInputElement>('input[data-o]').forEach((inp) =>
      inp.addEventListener('change', () => {
        if (!inp.checked) return;
        const k = inp.dataset.o!;
        if (k === 'credits') st.credits = Number(inp.value);
        else if (k === 'enemy') st.enemy = inp.value as Settings['enemy'];
        else if (k === 'difficulty') st.difficulty = inp.value as Difficulty;
        else if (k === 'tod') st.tod = inp.value as Settings['tod'];
        else if (k === 'weather') st.weather = inp.value as Settings['weather'];
        sum();
      }),
    );
    // opponent flags: name on hover / long-press for screen readers
    s.querySelectorAll<HTMLInputElement>('input[data-o=enemy]').forEach((inp) => {
      const f = FACTIONS.find((x) => x.id === inp.value);
      const name = f ? f.name : 'Random nation';
      inp.setAttribute('aria-label', name);
      inp.parentElement!.title = name;
    });
    $('[data-a=back]').addEventListener('click', () => this.showTitle());
    $('[data-a=start]').addEventListener('click', () => {
      saveSettings(st);
      this.handlers.onStart(st);
    });
    setTab(this.tab);
    // the hero canvas needs its host laid out: one frame after insertion
    requestAnimationFrame(sum);
    sum();
  }

  showHowTo(back: () => void) {
    const s = this.screen(
      `
      <div class="mm-sub howto-page">
        <header class="mm-head mm-rise" style="--i:0">
          <button class="mm-back" data-a="back" aria-label="Back">${mi('back')}<span>Back</span></button>
          <h2 class="mm-title"><small>Field manual</small>How to play</h2>
        </header>
        <div class="panel howto mm-glass mm-rise" style="--i:1">${howToHtml()}</div>
      </div>`,
      back,
    );
    s.querySelector('[data-a=back]')!.addEventListener('click', back);
  }

  showSettings(back: () => void) {
    const st = this.settings;
    const s = this.screen(
      `
      <div class="mm-sub settings-page">
        <header class="mm-head mm-rise" style="--i:0">
          <button class="mm-back" data-a="back" aria-label="Back">${mi('back')}<span>Back</span></button>
          <h2 class="mm-title"><small>Options</small>Settings</h2>
        </header>
        ${settingsHtml(st, true)}
      </div>`,
      back,
    );
    bindSettings(s, st, (ns) => {
      saveSettings(ns);
      this.handlers.onSettings(ns);
    });
    s.querySelector('[data-a=back]')!.addEventListener('click', back);
  }

  destroy() {
    this.stopCam();
    this.hero.hide();
    window.removeEventListener('keydown', this.onKey);
    this.el.remove();
  }
}

function howToHtml() {
  return `
        <div class="cols">
          <div>
            <h3>Goal</h3>
            <p>Deploy your <b>MCV</b> into a Construction Yard, build a base, harvest <b>ore</b> for credits and destroy every enemy structure.</p>
            <h3>Economy</h3>
            <p>Power Plant → Ore Refinery (comes with a harvester) → Barracks → War Factory → Radar → Airbase → Battle Lab. Keep power above use or production slows and defenses shut down. Capture <b>Oil Derricks</b> with an Engineer for extra income.</p>
            <h3>Counters</h3>
            <p>Tanks beat infantry & vehicles, AT teams and ATGMs beat tanks, MGs shred infantry and drones, AA vehicles and SAM sites stop drones and jets. EW jams drones. Artillery out-ranges everything but is fragile.</p>
          </div>
          <div>
            <h3>Mouse & keyboard</h3>
            <ul class="keys">
              <li><kbd>Left click</kbd> select / move / attack</li>
              <li><kbd>Drag</kbd> box select · <kbd>Double click</kbd> select type</li>
              <li><kbd>Right click</kbd> deselect · <kbd>Right drag</kbd> scroll</li>
              <li><kbd>Ctrl</kbd>+click force attack / attack-move</li>
              <li><kbd>A</kbd> attack-move · <kbd>S</kbd> stop · <kbd>D</kbd> deploy</li>
              <li><kbd>Ctrl+1-9</kbd> make group · <kbd>1-9</kbd> select group</li>
              <li><kbd>W</kbd> select army · <kbd>H</kbd> home · <kbd>R</kbd> repair · <kbd>X</kbd> sell</li>
              <li><kbd>Q</kbd> / <kbd>E</kbd> rotate the view 90°</li>
              <li><kbd>T</kbd> thermal view (twice: black-hot) · <kbd>N</kbd> night vision</li>
              <li><kbd>Arrows</kbd> / screen edge scroll · <kbd>Wheel</kbd> zoom</li>
              <li>Shift+click a build icon to queue 5 · right-click to cancel</li>
            </ul>
            <h3>Touch (Simple controls)</h3>
            <ul class="keys">
              <li><kbd>Tap a unit</kbd> select it · <kbd>Double-tap</kbd> all of its type on screen</li>
              <li><kbd>Tap the map</kbd> move there · tap an enemy to attack</li>
              <li><kbd>ARMY</kbd> select every combat unit · <kbd>ON SCREEN</kbd> the ones you see</li>
              <li><kbd>BOX</kbd> then drag to box-select · <kbd>CLEAR</kbd> deselect</li>
              <li><kbd>Drag</kbd> scroll · <kbd>Pinch</kbd> zoom · long-press a build icon to cancel</li>
              <li><kbd>MORE</kbd> stances, patrol, escort, groups, rotate / thermal view</li>
              <li>Build: tap an icon, when it is READY tap it, tap the map, tap the building again</li>
            </ul>
            <p class="note">Settings → Controls: Advanced brings back long-press box select and the full command bar.</p>
          </div>
        </div>`;
}

/** Settings form (main menu page and pause menu). `page`: inside the main menu's page frame (header outside). */
function settingsHtml(st: Settings, page = false) {
  const chk = (k: string, on: boolean, label: string, sub = '') =>
    `<label class="chk"><input type="checkbox" role="switch" data-s="${k}"${on ? ' checked' : ''}><span class="sw" aria-hidden="true"></span><span class="chk-t">${label}${sub ? `<small>${sub}</small>` : ''}</span></label>`;
  return `
    <div class="panel settings${page ? ' mm-glass mm-rise' : ''}"${page ? ' style="--i:1"' : ''}>
      ${page ? '' : '<h2>Settings</h2>'}
      <div class="set-group">
        <div class="mm-kicker">Controls</div>
        <div class="mm-field"><span class="mm-lbl">Scheme</span>${seg('controls', 's', st.controls === 'simple' ? 'simple' : 'advanced', [['simple', 'Simple'], ['advanced', 'Advanced']], 'Controls')}</div>
        <p class="note">Simple: tap to select, tap to move. Advanced: every RTS order.</p>
      </div>
      <div class="set-group">
        <div class="mm-kicker">Audio</div>
        <label class="rng"><span class="mm-lbl">Sound effects</span><input type="range" min="0" max="1" step="0.05" data-s="sfx" value="${st.sfx}"></label>
        <label class="rng"><span class="mm-lbl">Music</span><input type="range" min="0" max="1" step="0.05" data-s="music" value="${st.music}"></label>
        ${chk('voice', st.voice, 'Announcer voice')}
      </div>
      <div class="set-group">
        <div class="mm-kicker">Battlefield view</div>
        ${chk('cinematic', st.cinematic, 'Cinematic moments', 'Slow-motion on big missile strikes')}
        <div class="mm-field"><span class="mm-lbl">Drone camera</span>${seg('droneCam', 's', st.droneCam === 'off' ? 'off' : 'auto', [['auto', 'Auto'], ['off', 'Off']], 'Drone camera')}</div>
        ${chk('xray', st.xray !== false, 'X-ray silhouettes', 'Units hidden behind buildings and trees')}
        ${chk('icons', st.icons !== false, 'Unit icons when zoomed out')}
        ${chk('outlines', st.outlines !== false, 'Unit outlines', 'Team-coloured edge')}
      </div>
      <div class="set-group">
        <div class="mm-kicker">Graphics &amp; performance</div>
        <div class="mm-field"><span class="mm-lbl">Quality</span>${seg('quality', 's', st.quality, [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Med'], ['high', 'High'], ['ultra', 'Ultra']], 'Graphics quality')}</div>
        ${chk('battery', !!st.battery, 'Battery saver', '30 fps cap')}
        ${chk('showFps', !!st.showFps, 'Show FPS')}
        <p class="note">Graphics changes apply to the next battle.</p>
      </div>
      <div class="row"><button class="mbtn primary" data-a="back">Done</button></div>
    </div>`;
}

function bindSettings(root: HTMLElement, st: Settings, changed: (s: Settings) => void) {
  root.querySelectorAll<HTMLInputElement>('input[data-s]').forEach((inp) => {
    inp.addEventListener('input', () => {
      if (inp.type === 'radio' && !inp.checked) return;
      const k = inp.dataset.s!;
      if (k === 'voice') st.voice = inp.checked;
      else if (k === 'cinematic') st.cinematic = inp.checked;
      else if (k === 'droneCam') st.droneCam = inp.value === 'off' ? 'off' : 'auto';
      else if (k === 'xray') st.xray = inp.checked;
      else if (k === 'icons') st.icons = inp.checked;
      else if (k === 'outlines') st.outlines = inp.checked;
      else if (k === 'battery') st.battery = inp.checked;
      else if (k === 'showFps') st.showFps = inp.checked;
      else if (k === 'controls') st.controls = inp.value === 'simple' ? 'simple' : 'advanced';
      else if (k === 'quality') st.quality = inp.value as Settings['quality'];
      else if (k === 'sfx') st.sfx = Number(inp.value);
      else if (k === 'music') st.music = Number(inp.value);
      changed(st);
    });
  });
}

/** In-game pause menu. */
export function showPauseMenu(parent: HTMLElement, st: Settings, h2: { resume(): void; restart(): void; quit(): void; settings(s: Settings): void; photo?(): void }) {
  const layer = h(`<div class="menu-layer dim"></div>`);
  parent.appendChild(layer);
  const main = () => {
    layer.innerHTML = `
      <div class="panel pause">
        <h2>Paused</h2>
        <button class="mbtn primary" data-a="resume">Resume</button>
        <button class="mbtn" data-a="settings">Settings</button>
        ${h2.photo ? '<button class="mbtn" data-a="photo">Photo mode</button>' : ''}
        <button class="mbtn" data-a="restart">Restart battle</button>
        <button class="mbtn" data-a="quit">Quit to main menu</button>
      </div>`;
    const close = (fn: () => void) => () => {
      layer.remove();
      window.removeEventListener('keydown', onKey, true);
      fn();
    };
    layer.querySelector('[data-a=resume]')!.addEventListener('click', close(h2.resume));
    layer.querySelector('[data-a=restart]')!.addEventListener('click', close(h2.restart));
    if (h2.photo) layer.querySelector('[data-a=photo]')!.addEventListener('click', close(h2.photo));
    layer.querySelector('[data-a=quit]')!.addEventListener('click', close(h2.quit));
    layer.querySelector('[data-a=settings]')!.addEventListener('click', () => {
      layer.innerHTML = settingsHtml(st);
      bindSettings(layer, st, (ns) => {
        saveSettings(ns);
        h2.settings(ns);
      });
      layer.querySelector('[data-a=back]')!.addEventListener('click', main);
    });
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && document.body.contains(layer)) {
      e.stopImmediatePropagation();
      layer.remove();
      window.removeEventListener('keydown', onKey, true);
      h2.resume();
    }
  };
  window.addEventListener('keydown', onKey, true);
  main();
}

export function showEndScreen(parent: HTMLElement, win: boolean, you: Player, enemy: Player, seconds: number, h2: { again(): void; menu(): void }) {
  const mm = Math.floor(seconds / 60);
  const ss = String(Math.floor(seconds % 60)).padStart(2, '0');
  const row = (label: string, a: number, b: number) => `<tr><td>${label}</td><td>${a.toLocaleString('en-US')}</td><td>${b.toLocaleString('en-US')}</td></tr>`;
  const layer = h(`
    <div class="menu-layer dim">
      <div class="panel end ${win ? 'win' : 'lose'}">
        <h1>${win ? 'VICTORY' : 'DEFEAT'}</h1>
        <p>${win ? 'The enemy has been eliminated.' : 'Your forces have been destroyed.'} Battle time ${mm}:${ss}</p>
        <table>
          <tr><th></th><th>You</th><th>${enemy.name}</th></tr>
          ${row('Units & structures destroyed', you.stats.killed, enemy.stats.killed)}
          ${row('Losses', you.stats.lost, enemy.stats.lost)}
          ${row('Structures built', you.stats.built, enemy.stats.built)}
          ${row('Credits harvested', you.stats.harvested, enemy.stats.harvested)}
        </table>
        <div class="row">
          <button class="mbtn" data-a="menu">Main menu</button>
          <button class="mbtn primary" data-a="again">Play again</button>
        </div>
      </div>
    </div>`);
  parent.appendChild(layer);
  layer.querySelector('[data-a=again]')!.addEventListener('click', () => {
    layer.remove();
    h2.again();
  });
  layer.querySelector('[data-a=menu]')!.addEventListener('click', () => {
    layer.remove();
    h2.menu();
  });
}
