import './ui/style.css';
import { installCursors } from './ui/cursors';
import { AudioSystem } from './audio/audio';
import { FACTIONS } from './sim/defs';
import type { Faction } from './sim/types';
import { Game, type GameOptions } from './game/game';
import { loadModelOverrides } from './render/models';
import { MainMenu, loadSettings, resolveQuality, showEndScreen, showPauseMenu, type Settings } from './ui/menu';
import type { Splash } from './ui/splash';
import { showAfterAction } from './ui/aar';
import { isMapId } from './sim/maps';
import { isPeaceOption } from './sim/peace';
import { speedFactor } from './game/pace';
import type { MapId } from './sim/map';

/** The demo battle behind the menu never needs more than medium: it only has to look alive, not burn the battery. */
function demoQuality(q: ReturnType<typeof resolveQuality>): ReturnType<typeof resolveQuality> {
  return q === 'high' || q === 'ultra' ? 'medium' : q;
}

/** ?map=frontline|desert|winter|urban picks the map (overrides the menu choice). */
function urlMap(): MapId | undefined {
  const v = new URLSearchParams(location.search).get('map');
  return isMapId(v) ? v : undefined;
}

/*
 * The game proper, loaded by the small entry (src/main.ts) behind the boot
 * splash. boot() reports its milestones to the splash and hands over to the
 * main menu (or straight to a battle / demo for the ?play= / ?demo= URLs).
 */

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
    { faction: a, enemy: randomFaction(a), difficulty: 'hard', credits: 10000, quality: demoQuality(resolveQuality(settings.quality)), attract: true, cinematic: settings.cinematic, map: urlMap() },
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
  return game;
}

function unlockMenuAudio() {
  audio.unlock();
  audio.setMusicMode('menu');
  audio.startMusic();
}

function showMainMenu(newDemo = true) {
  if (newDemo) startAttract();
  menu?.destroy();
  menu = new MainMenu(app, {
    onStart: (s) => {
      settings = s;
      const enemy = s.enemy === 'random' ? randomFaction(s.faction) : s.enemy;
      startBattle({ faction: s.faction, enemy, difficulty: s.difficulty, credits: s.credits, quality: resolveQuality(s.quality), cinematic: s.cinematic, droneCam: s.droneCam, xray: s.xray, controls: s.controls, map: urlMap() ?? s.map, liveSky: true, peace: s.peace ?? 'auto', gameSpeed: s.gameSpeed });
    },
    onSettings: (s) => {
      settings = s;
      applyAudio(s);
    },
    onUnlockAudio: unlockMenuAudio,
    demo: () => game,
  });
  return menu;
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
        photo: () => game?.enterPhotoMode(true),
        restart: () => lastOptions && startBattle(lastOptions),
        quit: () => {
          audio.setMusicMode('menu');
          showMainMenu();
        },
        settings: (s) => {
          settings = s;
          applyAudio(s);
          game?.setCinematic(s.cinematic);
          game?.setViewSettings({ droneCam: s.droneCam, xray: s.xray });
          game?.setControls(s.controls);
          if (game) game.speed = speedFactor(s.gameSpeed);
        },
      });
    },
    onEnd: (win, stats) => {
      const h = {
        again: () => lastOptions && startBattle(lastOptions),
        menu: () => {
          audio.setMusicMode('menu');
          showMainMenu();
        },
      };
      // after-action report (src/ui/aar.ts); the plain end screen when there are no match stats
      if (stats.report) showAfterAction(app, { report: stats.report, you: stats.you, enemy: stats.enemy, codename: stats.codename }, h);
      else showEndScreen(app, win, stats.you, stats.enemy, stats.time, h);
    },
  });
}

const frames = (n: number) =>
  new Promise<void>((res) => {
    const step = () => (--n <= 0 ? res() : requestAnimationFrame(step));
    requestAnimationFrame(step);
  });

/** Boot the game behind the splash (progress 0.55 → 1 after the chunks have loaded). */
export async function boot(splash: Splash) {
  // expose for debugging in the console
  (window as unknown as { ironfront: unknown }).ironfront = { get game() { return game; } };
  splash.onGesture(unlockMenuAudio);

  splash.stage('Loading models', 0.55, 0.6);
  await loadModelOverrides(import.meta.env.BASE_URL);

  // Debug/test hooks: ?play=usa,russia,normal jumps straight into a battle, ?demo=usa,russia watches one.
  const params = new URLSearchParams(location.search);
  const play = params.get('play');
  const demo = params.get('demo');
  splash.stage('Generating terrain', 0.6, 0.7);
  await frames(2); // let the status line paint before the synchronous world / scene build
  if (demo) {
    // ?demo=usa,russia&ff=240 : watch an AI battle, optionally fast-forwarded
    const [a, b] = demo.split(',') as Faction[];
    game = new Game(app, { faction: a || 'usa', enemy: b || 'russia', difficulty: 'hard', credits: 10000, quality: (params.get('q') as GameOptions['quality']) || resolveQuality(settings.quality), attract: true, seed: 42, cinematic: params.get('cine') !== '0', map: urlMap() }, audio, { onMenu: () => {}, onEnd: () => {} });
    const g = game as Game;
    g.fastForward(Number(params.get('ff') ?? 0));
    const cx = Number(params.get('cx'));
    const cy = Number(params.get('cy'));
    if (cx && cy) {
      (g as unknown as { updateCamera: () => void }).updateCamera = () => {};
      g.renderer.centerOn(cx, cy);
    }
    if (params.get('z')) g.renderer.setZoom(Number(params.get('z')));
    splash.dismiss();
  } else if (play) {
    const [f, e, d] = play.split(',');
    // ?peace=auto|off|3|6|10|15 (default off: test sessions start fighting at once)
    const peace = params.get('peace');
    // ?brief=0: no briefing / intro / outro; ?brief=1: the full sequence; default: quick briefing, no intro
    const brief = params.get('brief');
    startBattle({ briefing: brief === '0' ? 'off' : brief === '1' ? 'full' : 'quick', faction: (f as Faction) || 'usa', enemy: (e as Faction) || 'russia', difficulty: (d as GameOptions['difficulty']) || 'normal', credits: 10000, quality: (params.get('q') as GameOptions['quality']) || resolveQuality(settings.quality), cinematic: settings.cinematic, droneCam: settings.droneCam, xray: settings.xray, controls: (params.get('controls') as GameOptions['controls']) || settings.controls, map: urlMap() ?? settings.map, peace: isPeaceOption(peace) ? peace : 'off', gameSpeed: settings.gameSpeed });
    const speed = Number(params.get('speed'));
    const g = game as Game | null;
    if (speed && g) g.speed = speed;
    // the battle's own warm-up overlay (same emblem) takes over
    splash.dismiss();
  } else {
    const g = startAttract();
    splash.stage('Compiling shaders', 0.7, 0.95);
    if (!/[?&]warm=0\b/.test(location.search)) await g.prewarm((k) => splash.sub(k));
    splash.stage('Deploying forces', 0.95, 1);
    await frames(2); // first frames of the demo battle rendered
    const m = showMainMenu(false);
    await splash.finish(m.el);
  }
}
