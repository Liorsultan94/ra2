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
import './maps.css';

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
  /** Skirmish atmosphere (visual only; read by src/render/atmos.ts). 'map' / unset = the map's own weather. */
  tod?: 'day' | 'dusk' | 'night';
  weather?: 'map' | 'clear' | 'rain' | 'snow' | 'sandstorm';
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

export interface MenuHandlers {
  onStart(s: Settings): void;
  onSettings(s: Settings): void;
  onUnlockAudio(): void;
}

/** Main menu shown over the live AI-vs-AI demo battle. */
export class MainMenu {
  readonly el: HTMLElement;
  private settings: Settings;

  constructor(
    parent: HTMLElement,
    private handlers: MenuHandlers,
  ) {
    this.settings = loadSettings();
    this.el = h(`<div class="menu-layer"></div>`);
    parent.appendChild(this.el);
    this.el.addEventListener('pointerdown', () => handlers.onUnlockAudio());
    this.showTitle();
  }

  private screen(html: string) {
    this.el.innerHTML = '';
    const s = h(html);
    this.el.appendChild(s);
    return s;
  }

  showTitle() {
    const s = this.screen(`
      <div class="title-screen">
        <div class="logo">
          <div class="logo-emblem">${emblemSvg}</div>
          <div class="logo-top">IRON</div>
          <div class="logo-bottom">FRONT</div>
          <div class="logo-sub">MODERN WARFARE · REAL-TIME STRATEGY</div>
        </div>
        <div class="menu-buttons">
          <button class="mbtn primary" data-a="quick">Quick Battle <small class="qb-nation">${flagHtml(this.settings.faction)}${FACTIONS.find((f) => f.id === this.settings.faction)?.name ?? ''}</small></button>
          <button class="mbtn" data-a="skirmish">Skirmish Setup</button>
          <button class="mbtn" disabled title="Coming in the next update">Online Multiplayer <small>soon</small></button>
          <button class="mbtn" data-a="howto">How to Play</button>
          <button class="mbtn" data-a="settings">Settings</button>
        </div>
        <div class="menu-foot">Original fan project inspired by classic RTS games. All art and sound are procedurally generated.</div>
      </div>`);
    // one tap into a battle with the last skirmish settings
    s.querySelector('[data-a=quick]')!.addEventListener('click', () => this.handlers.onStart(this.settings));
    s.querySelector('[data-a=skirmish]')!.addEventListener('click', () => this.showSkirmish());
    s.querySelector('[data-a=howto]')!.addEventListener('click', () => this.showHowTo(() => this.showTitle()));
    s.querySelector('[data-a=settings]')!.addEventListener('click', () => this.showSettings(() => this.showTitle()));
  }

  showSkirmish() {
    const st = this.settings;
    const cards = FACTIONS.map(
      (f) => `
      <button class="fcard${f.id === st.faction ? ' sel' : ''}" data-f="${f.id}">
        <div class="fc-head">${flagHtml(f.id)}<b>${f.name}</b></div>
        <div class="fc-doc">${f.doctrine}</div>
        <ul>${f.bonuses.map((b) => `<li>${b}</li>`).join('')}</ul>
        <div class="fc-sig">${f.signature.map((id) => `<span>${DEFS[id]?.name ?? id}</span>`).join('')}</div>
      </button>`,
    ).join('');
    const opt = (v: string, cur: string, label: string) => `<option value="${v}"${v === cur ? ' selected' : ''}>${label}</option>`;
    const s = this.screen(`
      <div class="panel skirmish">
        <h2>Choose your nation</h2>
        <div class="fgrid">${cards}</div>
        <div class="opts">
          <div class="mpick" role="radiogroup" aria-label="Map">
            <div class="mpick-title">Battlefield</div>
            ${MAPS.map((m) => `<button class="mtile${m.id === (st.map ?? 'frontline') ? ' sel' : ''}" data-map="${m.id}" role="radio" aria-checked="${m.id === (st.map ?? 'frontline')}"><b>${m.name}</b><small>${m.blurb}</small></button>`).join('')}
          </div>
          <label>Opponent<select data-o="enemy">${opt('random', st.enemy, 'Random nation')}${FACTIONS.map((f) => opt(f.id, st.enemy, f.name)).join('')}</select></label>
          <label>Difficulty<select data-o="difficulty">${opt('easy', st.difficulty, 'Easy')}${opt('normal', st.difficulty, 'Normal')}${opt('hard', st.difficulty, 'Hard')}</select></label>
          <label>Credits<select data-o="credits">${[5000, 10000, 20000].map((c) => opt(String(c), String(st.credits), '$' + c.toLocaleString('en-US'))).join('')}</select></label>

          <label>Time of day<select data-o="tod">${opt('day', st.tod ?? 'day', 'Day')}${opt('dusk', st.tod ?? 'day', 'Dusk')}${opt('night', st.tod ?? 'day', 'Night')}${opt('cycle', st.tod ?? 'day', 'Dynamic cycle')}${opt('mist', st.tod ?? 'day', 'Misty morning')}</select></label>
          <label>Weather<select data-o="weather">${opt('map', st.weather ?? 'map', 'Map default')}${opt('clear', st.weather ?? 'map', 'Clear')}${opt('rain', st.weather ?? 'map', 'Rain')}${opt('snow', st.weather ?? 'map', 'Snow')}${opt('sandstorm', st.weather ?? 'map', 'Sandstorm')}${opt('dynamic', st.weather ?? 'map', 'Dynamic')}</select></label>
        </div>
        <div class="row">
          <button class="mbtn" data-a="back">Back</button>
          <button class="mbtn primary" data-a="start">Deploy!</button>
        </div>
      </div>`);
    s.querySelectorAll<HTMLElement>('.fcard').forEach((c) =>
      c.addEventListener('click', () => {
        st.faction = c.dataset.f as Faction;
        s.querySelectorAll('.fcard').forEach((x) => x.classList.toggle('sel', x === c));
      }),
    );
    s.querySelectorAll<HTMLElement>('.mtile').forEach((t) =>
      t.addEventListener('click', () => {
        st.map = t.dataset.map as MapId;
        s.querySelectorAll<HTMLElement>('.mtile').forEach((x) => {
          x.classList.toggle('sel', x === t);
          x.setAttribute('aria-checked', String(x === t));
        });
      }),
    );
    s.querySelectorAll<HTMLSelectElement>('select[data-o]').forEach((sel) =>
      sel.addEventListener('change', () => {
        const k = sel.dataset.o!;
        if (k === 'credits') st.credits = Number(sel.value);
        else if (k === 'enemy') st.enemy = sel.value as Settings['enemy'];
        else if (k === 'difficulty') st.difficulty = sel.value as Difficulty;
        else if (k === 'tod') st.tod = sel.value as Settings['tod'];
        else if (k === 'weather') st.weather = sel.value as Settings['weather'];
      }),
    );
    s.querySelector('[data-a=back]')!.addEventListener('click', () => this.showTitle());
    s.querySelector('[data-a=start]')!.addEventListener('click', () => {
      saveSettings(st);
      this.handlers.onStart(st);
    });
  }

  showHowTo(back: () => void) {
    const s = this.screen(`
      <div class="panel howto">
        <h2>How to play</h2>
        <div class="cols">
          <div>
            <h3>Goal</h3>
            <p>Deploy your <b>MCV</b> into a Construction Yard, build a base, harvest <b>ore</b> for credits and destroy every enemy structure.</p>
            <h3>Economy</h3>
            <p>Power Plant → Ore Refinery (comes with a harvester) → Barracks → War Factory → Radar → Drone Hub → Battle Lab. Keep power above use or production slows and defenses shut down. Capture <b>Oil Derricks</b> with an Engineer for extra income.</p>
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
        </div>
        <div class="row"><button class="mbtn primary" data-a="back">Back</button></div>
      </div>`);
    s.querySelector('[data-a=back]')!.addEventListener('click', back);
  }

  showSettings(back: () => void) {
    const st = this.settings;
    const s = this.screen(settingsHtml(st));
    bindSettings(s, st, (ns) => {
      saveSettings(ns);
      this.handlers.onSettings(ns);
    });
    s.querySelector('[data-a=back]')!.addEventListener('click', back);
  }

  destroy() {
    this.el.remove();
  }
}

function settingsHtml(st: Settings) {
  const opt = (v: string, label: string) => `<option value="${v}"${v === st.quality ? ' selected' : ''}>${label}</option>`;
  return `
    <div class="panel settings">
      <h2>Settings</h2>
      <label>Controls<select data-s="controls"><option value="simple"${st.controls === 'simple' ? ' selected' : ''}>Simple (tap to select, tap to move)</option><option value="advanced"${st.controls !== 'simple' ? ' selected' : ''}>Advanced (all RTS orders)</option></select></label>
      <label>Sound effects<input type="range" min="0" max="1" step="0.05" data-s="sfx" value="${st.sfx}"></label>
      <label>Music<input type="range" min="0" max="1" step="0.05" data-s="music" value="${st.music}"></label>
      <label class="chk"><input type="checkbox" data-s="voice"${st.voice ? ' checked' : ''}> Announcer voice</label>
      <label class="chk"><input type="checkbox" data-s="cinematic"${st.cinematic ? ' checked' : ''}> Cinematic moments (slow-motion on big missile strikes)</label>
      <label>Drone camera<select data-s="droneCam"><option value="auto"${st.droneCam !== 'off' ? ' selected' : ''}>Auto (live feed when a drone attacks)</option><option value="off"${st.droneCam === 'off' ? ' selected' : ''}>Off</option></select></label>
      <label class="chk"><input type="checkbox" data-s="xray"${st.xray !== false ? ' checked' : ''}> X-ray silhouettes (units hidden behind buildings / trees)</label>
      <label class="chk"><input type="checkbox" data-s="icons"${st.icons !== false ? ' checked' : ''}> Unit icons when zoomed out</label>
      <label class="chk"><input type="checkbox" data-s="outlines"${st.outlines !== false ? ' checked' : ''}> Unit outlines (team-coloured edge)</label>
      <label class="chk"><input type="checkbox" data-s="battery"${st.battery ? ' checked' : ''}> Battery saver (30 fps cap)</label>
      <label class="chk"><input type="checkbox" data-s="showFps"${st.showFps ? ' checked' : ''}> Show FPS</label>
      <label>Graphics<select data-s="quality">${opt('auto', 'Auto')}${opt('low', 'Low (weak devices)')}${opt('medium', 'Medium')}${opt('high', 'High')}${opt('ultra', 'Ultra (strong PCs)')}</select></label>
      <p class="note">Graphics changes apply to the next battle.</p>
      <div class="row"><button class="mbtn primary" data-a="back">Back</button></div>
    </div>`;
}

function bindSettings(root: HTMLElement, st: Settings, changed: (s: Settings) => void) {
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.s!;
      if (k === 'voice') st.voice = (inp as HTMLInputElement).checked;
      else if (k === 'cinematic') st.cinematic = (inp as HTMLInputElement).checked;
      else if (k === 'droneCam') st.droneCam = inp.value === 'off' ? 'off' : 'auto';
      else if (k === 'xray') st.xray = (inp as HTMLInputElement).checked;
      else if (k === 'icons') st.icons = (inp as HTMLInputElement).checked;
      else if (k === 'outlines') st.outlines = (inp as HTMLInputElement).checked;
      else if (k === 'battery') st.battery = (inp as HTMLInputElement).checked;
      else if (k === 'showFps') st.showFps = (inp as HTMLInputElement).checked;
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
