import './ui/style.css';
import { installCursors } from './ui/cursors';
import { AudioSystem } from './audio/audio';
import { FACTIONS } from './sim/defs';
import type { Faction } from './sim/types';
import { Game, type GameOptions } from './game/game';
import { loadModelOverrides } from './render/models';
import { MainMenu, loadSettings, resolveQuality, showEndScreen, showPauseMenu, type Settings } from './ui/menu';

const app = document.getElementById('app')!;
const audio = new AudioSystem();
let settings = loadSettings();
let game: Game | null = null;
let menu: MainMenu | null = null;
let lastOptions: GameOptions | null = null;

function applyAudio(s: Settings) {
  audio.setSfxVolume(s.sfx);
  audio.setMusicVolume(s.music);
  audio.setVoiceEnabled(s.voice);
}
applyAudio(settings);
installCursors();

function randomFaction(except?: Faction): Faction {
  const pool = FACTIONS.filter((f) => f.id !== except);
  return pool[Math.floor(Math.random() * pool.length)].id;
}

function startAttract() {
  game?.destroy();
  const a = randomFaction();
  game = new Game(
    app,
    { faction: a, enemy: randomFaction(a), difficulty: 'hard', credits: 10000, quality: resolveQuality(settings.quality) === 'high' ? 'medium' : resolveQuality(settings.quality), attract: true },
    audio,
    {
      onMenu: () => {
        // the demo battle ended: start a fresh one behind the menu
        if (menu) startAttract();
      },
      onEnd: () => {},
    },
  );
  game.speed = 1.5;
}

function showMainMenu() {
  startAttract();
  menu?.destroy();
  menu = new MainMenu(app, {
    onStart: (s) => {
      settings = s;
      const enemy = s.enemy === 'random' ? randomFaction(s.faction) : s.enemy;
      startBattle({ faction: s.faction, enemy, difficulty: s.difficulty, credits: s.credits, quality: resolveQuality(s.quality) });
    },
    onSettings: (s) => {
      settings = s;
      applyAudio(s);
    },
    onUnlockAudio: () => {
      audio.unlock();
      audio.setMusicMode('menu');
      audio.startMusic();
    },
  });
}

function startBattle(opts: GameOptions) {
  menu?.destroy();
  menu = null;
  game?.destroy();
  lastOptions = opts;
  audio.unlock();
  audio.setMusicMode('battle');
  audio.startMusic();
  game = new Game(app, opts, audio, {
    onMenu: () => {
      if (!game) return;
      game.paused = true;
      showPauseMenu(app, settings, {
        resume: () => game && (game.paused = false),
        restart: () => lastOptions && startBattle(lastOptions),
        quit: () => {
          audio.setMusicMode('menu');
          showMainMenu();
        },
        settings: (s) => {
          settings = s;
          applyAudio(s);
        },
      });
    },
    onEnd: (win, stats) => {
      showEndScreen(app, win, stats.you, stats.enemy, stats.time, {
        again: () => lastOptions && startBattle(lastOptions),
        menu: () => {
          audio.setMusicMode('menu');
          showMainMenu();
        },
      });
    },
  });
}

// Debug/test hook: ?play=usa,russia,normal jumps straight into a battle.
const params = new URLSearchParams(location.search);
await loadModelOverrides(import.meta.env.BASE_URL);
const play = params.get('play');
const demo = params.get('demo');
if (demo) {
  // ?demo=usa,russia&ff=240 : watch an AI battle, optionally fast-forwarded
  const [a, b] = demo.split(',') as Faction[];
  game = new Game(app, { faction: a || 'usa', enemy: b || 'russia', difficulty: 'hard', credits: 10000, quality: (params.get('q') as GameOptions['quality']) || resolveQuality(settings.quality), attract: true, seed: 42 }, audio, { onMenu: () => {}, onEnd: () => {} });
  const g = game as Game;
  g.fastForward(Number(params.get('ff') ?? 0));
  const cx = Number(params.get('cx'));
  const cy = Number(params.get('cy'));
  if (cx && cy) {
    (g as unknown as { updateCamera: () => void }).updateCamera = () => {};
    g.renderer.centerOn(cx, cy);
  }
  if (params.get('z')) g.renderer.setZoom(Number(params.get('z')));
} else if (play) {
  const [f, e, d] = play.split(',');
  startBattle({ faction: (f as Faction) || 'usa', enemy: (e as Faction) || 'russia', difficulty: (d as GameOptions['difficulty']) || 'normal', credits: 10000, quality: (params.get('q') as GameOptions['quality']) || resolveQuality(settings.quality) });
  const speed = Number(params.get('speed'));
  const g = game as Game | null;
  if (speed && g) g.speed = speed;
} else {
  showMainMenu();
}

// expose for debugging in the console
(window as unknown as { ironfront: unknown }).ironfront = { get game() { return game; } };
