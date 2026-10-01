import { DEFS, FACTIONS } from '../sim/defs';
import type { Difficulty } from '../sim/ai';
import type { Faction, Player } from '../sim/types';
import type { Quality } from '../render/renderer';
import { flagHtml } from './hud';

export interface Settings {
  faction: Faction;
  enemy: Faction | 'random';
  difficulty: Difficulty;
  credits: number;
  quality: Quality | 'auto';
  sfx: number;
  music: number;
  voice: boolean;
}

const KEY = 'ironfront.settings.v1';

export function loadSettings(): Settings {
  const def: Settings = { faction: 'usa', enemy: 'random', difficulty: 'normal', credits: 10000, quality: 'auto', sfx: 0.8, music: 0.35, voice: true };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...def, ...JSON.parse(raw) };
  } catch {
    /* storage unavailable */
  }
  return def;
}

export function saveSettings(s: Settings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function resolveQuality(q: Settings['quality']): Quality {
  if (q !== 'auto') return q;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 600;
  if (coarse && small) return 'low';
  if (coarse) return 'medium';
  return 'high';
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
          <div class="logo-top">IRON</div>
          <div class="logo-bottom">FRONT</div>
          <div class="logo-sub">MODERN WARFARE · REAL-TIME STRATEGY</div>
        </div>
        <div class="menu-buttons">
          <button class="mbtn primary" data-a="skirmish">Skirmish vs AI</button>
          <button class="mbtn" disabled title="Coming in the next update">Online Multiplayer <small>soon</small></button>
          <button class="mbtn" data-a="howto">How to Play</button>
          <button class="mbtn" data-a="settings">Settings</button>
        </div>
        <div class="menu-foot">Original fan project inspired by classic RTS games. All art and sound are procedurally generated.</div>
      </div>`);
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
          <label>Opponent<select data-o="enemy">${opt('random', st.enemy, 'Random nation')}${FACTIONS.map((f) => opt(f.id, st.enemy, f.name)).join('')}</select></label>
          <label>Difficulty<select data-o="difficulty">${opt('easy', st.difficulty, 'Easy')}${opt('normal', st.difficulty, 'Normal')}${opt('hard', st.difficulty, 'Hard')}</select></label>
          <label>Credits<select data-o="credits">${[5000, 10000, 20000].map((c) => opt(String(c), String(st.credits), '$' + c.toLocaleString('en-US'))).join('')}</select></label>
          <label>Map<select disabled><option>Frontline Crossing (2 players)</option></select></label>
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
    s.querySelectorAll<HTMLSelectElement>('select[data-o]').forEach((sel) =>
      sel.addEventListener('change', () => {
        const k = sel.dataset.o!;
        if (k === 'credits') st.credits = Number(sel.value);
        else if (k === 'enemy') st.enemy = sel.value as Settings['enemy'];
        else if (k === 'difficulty') st.difficulty = sel.value as Difficulty;
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
              <li><kbd>Q</kbd> select army · <kbd>H</kbd> home · <kbd>R</kbd> repair · <kbd>X</kbd> sell</li>
              <li><kbd>Arrows</kbd> / screen edge scroll · <kbd>Wheel</kbd> zoom</li>
              <li>Shift+click a build icon to queue 5 · right-click to cancel</li>
            </ul>
            <h3>Touch</h3>
            <ul class="keys">
              <li><kbd>Tap</kbd> select / command · <kbd>Drag</kbd> scroll</li>
              <li><kbd>Long-press + drag</kbd> box select (or the box tool)</li>
              <li><kbd>Pinch</kbd> zoom · long-press a build icon to cancel</li>
            </ul>
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
      <label>Sound effects<input type="range" min="0" max="1" step="0.05" data-s="sfx" value="${st.sfx}"></label>
      <label>Music<input type="range" min="0" max="1" step="0.05" data-s="music" value="${st.music}"></label>
      <label class="chk"><input type="checkbox" data-s="voice"${st.voice ? ' checked' : ''}> Announcer voice</label>
      <label>Graphics<select data-s="quality">${opt('auto', 'Auto')}${opt('low', 'Low (phones)')}${opt('medium', 'Medium')}${opt('high', 'High')}</select></label>
      <p class="note">Graphics changes apply to the next battle.</p>
      <div class="row"><button class="mbtn primary" data-a="back">Back</button></div>
    </div>`;
}

function bindSettings(root: HTMLElement, st: Settings, changed: (s: Settings) => void) {
  root.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[data-s]').forEach((inp) => {
    inp.addEventListener('input', () => {
      const k = inp.dataset.s!;
      if (k === 'voice') st.voice = (inp as HTMLInputElement).checked;
      else if (k === 'quality') st.quality = inp.value as Settings['quality'];
      else if (k === 'sfx') st.sfx = Number(inp.value);
      else if (k === 'music') st.music = Number(inp.value);
      changed(st);
    });
  });
}

/** In-game pause menu. */
export function showPauseMenu(parent: HTMLElement, st: Settings, h2: { resume(): void; restart(): void; quit(): void; settings(s: Settings): void }) {
  const layer = h(`<div class="menu-layer dim"></div>`);
  parent.appendChild(layer);
  const main = () => {
    layer.innerHTML = `
      <div class="panel pause">
        <h2>Paused</h2>
        <button class="mbtn primary" data-a="resume">Resume</button>
        <button class="mbtn" data-a="settings">Settings</button>
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
