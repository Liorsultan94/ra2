import { AudioSystem, type Sfx } from '../audio/audio';
import { AudioScene } from '../audio/scene';
import { AIController, type Difficulty } from '../sim/ai';
import { canGarrisonUnit, garrisonRoom } from '../sim/garrison';
import { SW_INFO, type SwKind } from '../sim/specialdefs';
import { SuperweaponAI } from '../sim/superweapons';
import { canHurtBridge, isBridge } from '../sim/bridges';
import { DEFS, FACTIONS, WEAPONS, buildingDef, unitDef } from '../sim/defs';
import { standHeight, terrainPassable } from '../sim/map';
import { TICK_MS, type Category, type Command, type Entity, type Faction, type SimEvent, type Stance } from '../sim/types';
import { World } from '../sim/world';
import { skipFrame } from '../render/perf/hud';
import { sharedCameos } from '../render/cameo';
import { CinematicDirector, type CineShot } from '../render/cinematic';
import { GameRenderer, type Quality, type RendererParts } from '../render/renderer';
import { Slicer } from '../render/slice';
import { ATMOS_DEFAULTS } from '../render/atmos';
import { ViewModes } from '../render/viewmodes';
import { prefetchModels, warmUp, type WarmupResult } from '../render/warmup';
import { Hud } from '../ui/hud';
import { ControlsUI, type OrderMode } from '../ui/controls';
import { ControlGroups, STANCE_LABEL, nextStance, orderable, stanceForKey, type ControlsHost } from './controls';
import { PhotoMode } from './photomode';
import { MatchTracker, type MatchReport } from './matchstats';
import { Briefing, buildBriefing, type BriefingInfo } from '../ui/briefing';
import { CineCard } from '../ui/cinecard';
import { BattleIntro, BattleOutro } from '../render/intro';
import type { MapId } from '../sim/map';
import { flagDataUrl } from '../render/flags';

export interface GameOptions {
  faction: Faction;
  enemy: Faction;
  difficulty: Difficulty;
  credits: number;
  quality: Quality;
  attract?: boolean; // AI vs AI demo behind the main menu
  cinematic?: boolean; // slow-motion camera moments on big events (default on)
  seed?: number;
  /** Map (default Frontline Crossing; sim/maps.ts). */
  map?: MapId;
  /** Drone camera picture-in-picture (default auto). */
  droneCam?: 'auto' | 'off';
  /** X-ray silhouettes of hidden units (default on). */
  xray?: boolean;
  /** Control scheme: 'simple' touch controls + decluttered HUD, or 'advanced' (default: simple on touch screens). */
  controls?: 'simple' | 'advanced';
  /**
   * Mission briefing while loading + intro flyover + victory / defeat outro (default 'full').
   * 'quick': the briefing deploys itself as soon as loading ends and there is no intro flyover (test URLs);
   * 'off': the plain loading overlay and the classic end sequence.
   */
  briefing?: 'full' | 'quick' | 'off';
  /**
   * Battles started from the menu (skirmish, quick battle): unless the menu settings pick a time of day /
   * weather, play the live day (1 real minute = 1 game hour, from 05:30) with the map climate's dynamic
   * weather (render/atmos.ts ATMOS_DEFAULTS). Test URLs leave it off and keep the plain day.
   */
  liveSky?: boolean;
}

export interface GameCallbacks {
  onMenu(): void;
  onEnd(win: boolean, stats: { you: World['players'][0]; enemy: World['players'][0]; time: number; report?: MatchReport; codename?: string }): void;
}

type Mode = 'normal' | 'place' | 'sell' | 'repair' | 'attackMove' | 'patrol' | 'guard';

const PLAYER_COLOR = 0x2f8fff;
const ENEMY_COLOR = 0xe8352b;

export class Game {
  readonly world: World;
  readonly renderer: GameRenderer;
  readonly hud: Hud;
  /** The session's cameo factory (shared: one offscreen GL context for every battle and the menu). */
  private cameos = sharedCameos();
  private local: number;
  private raf = 0;
  private last = 0;
  private acc = 0;
  private hudTimer = 0;
  private mmTimer = 0;
  paused = false;
  speed = 1;
  private mode: Mode = 'normal';
  private placing: string | null = null;
  /** Control groups, stance / patrol / guard order modes (src/game/controls.ts) and their widgets. */
  readonly ctl: ControlGroups;
  private ctlUI: ControlsUI | null = null;
  private hover = -1;
  private mouse = { x: 0, y: 0, inside: false, type: 'mouse' };
  private keys = new Set<string>();
  private boxSelectMode = false;
  private ended = false;
  private startTime = performance.now();
  private hintShown = true;
  private destroyed = false;
  private disposers: (() => void)[] = [];
  readonly cine = new CinematicDirector();
  private mmFrame = 0;
  /** Thermal view, x-ray silhouettes and the drone camera (src/render/viewmodes.ts). */
  readonly modes: ViewModes;
  private warming = false;
  /** Shader warm-up stats (null until it has run, or when skipped). */
  warmup: WarmupResult | null = null;
  private thermalBtn: HTMLButtonElement | null = null;
  /** Simple control scheme (phones): tap = select / move, no long-press box, decluttered HUD. */
  private simple = false;
  /** While a simple-scheme tap is resolved: own units are only picked on a direct hit when units are selected. */
  private touchPick: 'tight' | 'loose' | null = null;
  private lastNudge = 0;
  /** Photo mode: frozen battle, free camera, filters and a PNG shutter (photomode.ts). */
  readonly photo: PhotoMode;
  /** Match seed (operation codename, briefing). */
  readonly seed: number;
  /** After-action report statistics (observes events only). */
  readonly tracker: MatchTracker | null = null;
  /** Mission briefing data (null in attract mode / with briefing 'off'). */
  readonly brief: BriefingInfo | null = null;
  /** Briefing overlay while loading / waiting for "Deploy" (the battle holds still). */
  private briefing: Briefing | null = null;
  /** Intro flyover / victory-defeat outro and their letterbox card. */
  private intro: BattleIntro | null = null;
  private outro: BattleOutro | null = null;
  private card: CineCard | null = null;
  /** Where the last structure fell (outro camera target). */
  private lastFall: { x: number; y: number; owner: number } | null = null;
  /** Listener / ambience / aircraft engines (reads the world, never writes it). */
  private audioScene: AudioScene;

  /** The match's world (the deterministic simulation; identical whichever way the game is built). */
  private static makeWorld(opts: GameOptions, seed: number): World {
    const attract = !!opts.attract;
    return new World({
      seed,
      map: opts.map,
      credits: opts.credits,
      players: [
        { name: attract ? FACTIONS.find((f) => f.id === opts.faction)!.name : 'You', faction: opts.faction, color: PLAYER_COLOR, isAI: attract },
        { name: FACTIONS.find((f) => f.id === opts.enemy)!.name, faction: opts.enemy, color: ENEMY_COLOR, isAI: true },
      ],
    });
  }

  /**
   * Build a game without long main-thread tasks: the world, then the heavy
   * battlefield parts (GameRenderer.prebuild) in ~35 ms slices with progress
   * (0..1), then the rest synchronously. `alive()` returning false (the player
   * left meanwhile) abandons the build (rejects with slice.ts Aborted).
   */
  static async create(container: HTMLElement, opts: GameOptions, audio: AudioSystem, cb: GameCallbacks, onProgress?: (k: number) => void, alive: () => boolean = () => true): Promise<Game> {
    const slicer = new Slicer(35, () => !alive());
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    onProgress?.(0.05);
    await slicer.yield();
    const world = Game.makeWorld(opts, seed);
    onProgress?.(0.2);
    await slicer.yield();
    // the renderer's (and ambient life's) settings follow the battle type, as in the constructor
    ATMOS_DEFAULTS.live = !!opts.liveSky && !opts.attract;
    const parts = await GameRenderer.prebuild(world, opts.quality, slicer);
    onProgress?.(0.85);
    await slicer.yield();
    const g = new Game(container, { ...opts, seed }, audio, cb, { world, parts });
    onProgress?.(1);
    return g;
  }

  constructor(
    container: HTMLElement,
    readonly opts: GameOptions,
    readonly audio: AudioSystem,
    private cb: GameCallbacks,
    pre?: { world: World; parts: RendererParts } | null,
  ) {
    const attract = !!opts.attract;
    this.seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    this.world = pre?.world ?? Game.makeWorld(opts, this.seed);
    this.local = attract ? -1 : 0;
    this.ctl = new ControlGroups(this.controlsHost());
    if (attract) this.world.controllers.push(new AIController(this.world, 0, 'hard'));
    this.world.controllers.push(new AIController(this.world, 1, attract ? 'hard' : opts.difficulty));
    // superweapon builder / user (superweapons.ts)
    for (const p of this.world.players) if (p.isAI) this.world.controllers.push(new SuperweaponAI(this.world, p.id));

    this.hud = new Hud(container, this.cameos, {
      onCameo: (id, cat, shift) => this.onCameo(id, cat, shift),
      onCancel: (id) => {
        this.issue({ type: 'cancel', def: id });
        this.sfx('click');
      },
      onTool: (t) => this.onTool(t),
      onCommand: (c) => this.onCommand(c),
      onMinimap: (x, y) => this.renderer.centerOn(x, y),
      onSelectType: (id) => this.select([...this.renderer.selection].filter((s) => this.world.get(s)?.def === id)),
      onRotate: (steps) => this.rotateView(steps),
      onLayout: () => this.resize(),
      onMore: () => {
        this.audio.unlock();
        this.sfx('click', undefined, undefined, 0.6);
      },
    });
    this.cine.enabled = opts.cinematic ?? true;
    if (attract) this.hud.root.classList.add('attract');
    ATMOS_DEFAULTS.live = !!opts.liveSky && !attract;
    this.renderer = new GameRenderer(this.hud.canvas, this.world, this.local, opts.quality, pre?.parts);
    // (the demo battle behind the menu has no sidebar: no cameos, no live portrait)
    this.hud.attach(this.world, this.renderer, Math.max(0, this.local), !attract);
    this.renderer.atmos.onThunder = (v) => this.audio.thunder(v);
    // positional audio: the camera is the listener (src/audio/scene.ts)
    this.audio.setNation(attract ? null : opts.faction);
    this.audioScene = new AudioScene(this.audio, this.world, this.renderer, (x, y) => this.visibleToLocal(x, y), !attract);
    this.modes = new ViewModes(this.renderer, attract ? null : this.hud.viewWrap, (x, y) => {
      if (this.cine.active) this.cine.skip();
      this.renderer.centerOn(x, y);
    });
    this.renderer.viewHook = this.modes;
    const game = this;
    this.photo = new PhotoMode({
      renderer: this.renderer,
      modes: this.modes,
      root: this.hud.root,
      layer: this.hud.viewWrap,
      get paused() {
        return game.paused;
      },
      set paused(v: boolean) {
        game.paused = v;
      },
      onToggle: () => {
        this.keys.clear();
        this.hud.forceSelectionRefresh();
      },
    });
    this.modes.xray = opts.xray ?? true;
    this.modes.drone?.setMode(opts.droneCam ?? 'auto');
    this.hud.keepClear = () => this.modes.drone?.overlayRect() ?? null;
    if (!attract) {
      this.thermalBtn = this.hud.addViewButton(
        'Thermal view (T)',
        '<path d="M12 2a3 3 0 0 0-3 3v8.1a5 5 0 1 0 6 0V5a3 3 0 0 0-3-3zm0 2a1 1 0 0 1 1 1v9.1l.4.3a3 3 0 1 1-2.8 0l.4-.3V5a1 1 0 0 1 1-1zm-1 6v5.3a2 2 0 1 0 2 0V10z"/>',
        () => this.modes.cycleThermal(),
      );
      this.thermalBtn.classList.add('vc-thermal');
      this.modes.onChange = () => {
        this.thermalBtn?.classList.toggle('on', this.modes.thermal);
        this.thermalBtn?.classList.toggle('black', this.modes.thermal && this.modes.polarity === 'black');
      };
      // photo mode (photomode.ts): view button on desktop, More panel entry in the simple scheme
      this.hud.addViewButton('Photo mode (Y)', '<path d="M9 4l-1.6 2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.4L15 4zm3 4.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 2a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/>', () => this.enterPhotoMode()).classList.add('vc-photo');
    }
    if (attract) {
      this.renderer.centerOn(this.world.map.w / 2, this.world.map.h / 2);
    } else {
      const mcv = this.world.list.find((e) => e.owner === 0 && e.kind === 'unit' && unitDef(e.def).mcv);
      if (mcv) {
        this.select([mcv.id], false);
        this.renderer.centerOn(mcv.x, mcv.y);
      }
      const simple = (opts.controls ?? (window.matchMedia?.('(pointer: coarse)').matches ? 'simple' : 'advanced')) === 'simple';
      this.hud.showHint(
        simple
          ? 'Your MCV is selected. Tap <b>Deploy</b> (or tap the MCV again) to build your Construction Yard.'
          : 'Your MCV is selected. Press <b>Deploy</b> (or <kbd>D</kbd>, or click the MCV again) to build your Construction Yard.',
      );
      if ((opts.briefing ?? 'full') === 'off') this.audio.say('Battle control online');
    }
    if (!attract) {
      this.ctlUI = new ControlsUI(this.hud, this.renderer, this.cameos, this.ctl, this.local, {
        onStance: (st) => this.setStance(st),
        onMode: (m) => this.toggleOrderMode(m),
        onQueueToggle: () => {
          this.ctl.queueMode = !this.ctl.queueMode;
          this.sfx('click');
        },
        onRepeat: (cat, on) => {
          this.issue({ type: 'repeat', cat, on });
          this.sfx('click');
        },
        onGroupTap: (g) => {
          this.audio.unlock();
          if (!this.ctl.recall(g, performance.now())) this.sfx('error');
        },
        onGroupAssign: (g) => this.ctl.assign(g),
      });
      this.setControls(opts.controls ?? (window.matchMedia?.('(pointer: coarse)').matches ? 'simple' : 'advanced'));
      if (this.simple && this.smallScreen() && window.innerHeight > window.innerWidth) this.hud.message('Tip: turn your phone sideways for a bigger battlefield', 'info');
    }
    this.bindInput();
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.disposers.push(() => window.removeEventListener('resize', onResize));
    if (typeof ResizeObserver !== 'undefined') {
      // the sidebar can collapse / expand without a window resize
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.hud.viewWrap);
      this.disposers.push(() => ro.disconnect());
    }
    this.resize();
    // zoom depends on the view size (phones get a closer, RA2-like view)
    this.renderer.setZoom(this.renderer.defaultZoom(attract));
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    if (!attract) {
      this.tracker = new MatchTracker(this.world, this.local);
      if ((opts.briefing ?? 'full') !== 'off') this.openBriefing(container);
    }
    if (!attract && !/[?&]warm=0\b/.test(location.search)) this.startWarmup();
    else if (this.briefing) this.briefing.setReady(() => this.deploy());
  }

  /** Mission briefing over the whole screen while the battle loads (src/ui/briefing.ts). */
  private openBriefing(container: HTMLElement) {
    const a = this.renderer.atmos;
    const atm = a.cfg;
    const info = buildBriefing(this.world, this.local, { seed: this.seed, difficulty: this.opts.difficulty, tod: atm.tod, weather: atm.weather, credits: this.opts.credits, start: atm.tod === 'cycle' ? a.startHour : undefined, forecast: a.forecast() });
    (this as { brief: BriefingInfo | null }).brief = info;
    this.briefing = new Briefing(container, info, this.world, this.local, this.renderer.terrain.minimapImage, {
      autoDeploy: this.opts.briefing === 'quick' ? 1.2 : 12,
      say: (t) => this.audio.unlocked && this.audio.say(t),
    });
  }

  /** "Deploy" on the briefing: fly the intro (or hand over control straight away). */
  private deploy() {
    this.briefing = null; // it fades out by itself
    this.audio.unlock();
    this.last = performance.now();
    const mcv = this.world.list.find((e) => e.owner === this.local && e.kind === 'unit' && unitDef(e.def).mcv);
    const me = this.world.players[this.local];
    const hx = mcv ? mcv.x : me.startX + 0.5;
    const hy = mcv ? mcv.y : me.startY + 0.5;
    if (this.opts.briefing === 'quick' || !this.brief) {
      this.startBattleClock();
      return;
    }
    const m = this.world.map;
    const foe = m.starts[1 - this.local] ?? { x: m.w / 2, y: m.h / 2 };
    const via = m.bridges[0] ?? { x: m.w / 2, y: m.h / 2 };
    this.intro = new BattleIntro(this.renderer, m, { x: foe.x + 0.5, y: foe.y + 0.5 }, via, { x: hx, y: hy }, this.renderer.zoom, 6.5);
    this.card = new CineCard(this.hud.viewWrap, () => this.skipIntro());
    this.hud.root.classList.add('intro-on');
    const you = this.brief.you;
    this.introCardAt = [0.5, 4.9];
    this.introCardShown = 0;
    this.cardText = { kicker: `${you.name} · Operation`, flag: flagDataUrl(you.faction), title: this.brief.codename, sub: `${this.world.map.name} · ${this.brief.time.split(' · ')[0]}`, tone: 'intro' };
    this.audio.sting('heavy');
  }
  private introCardAt: [number, number] = [0, 0];
  private introCardShown = 0;
  private introT = 0;
  private cardText: { kicker?: string; flag?: string; title: string; sub?: string; tone?: 'intro' | 'win' | 'lose' } | null = null;

  private skipIntro() {
    if (!this.intro) return;
    this.intro.finish();
    this.endIntro();
  }

  private endIntro() {
    this.intro = null;
    this.card?.close();
    this.card = null;
    this.hud.root.classList.remove('intro-on');
    this.startBattleClock();
  }

  /** Control to the player: the simulation starts now. */
  private startBattleClock() {
    this.last = performance.now();
    this.acc = 0;
    this.startTime = performance.now();
    this.audio.say('Battle control online');
  }

  /** Compile every shader / material of this match under a loading overlay before the first battle frame. */
  private startWarmup() {
    this.warming = true;
    // the cameo queue waits: its readbacks would queue behind this match's shader compiles on the GPU
    this.cameos.paused = true;
    const progress = (k: number) => (this.briefing ? this.briefing.setProgress(k) : this.hud.setLoading(k));
    progress(0);
    const factions = [...new Set(this.world.players.map((p) => p.faction))];
    void warmUp(this.renderer, factions, this.modes, (k) => !this.destroyed && progress(k), () => !this.destroyed)
      .then((res) => {
        this.warmup = res;
        console.info(`[warmup] ${res.models} models, ${res.programs} programs in ${res.ms} ms (longest slice ${res.worst} ms)`);
      })
      .catch((e) => !this.destroyed && console.warn('[warmup] failed', e))
      .finally(() => {
        if (this.destroyed) return;
        this.cameos.paused = false;
        this.warming = false;
        if (this.briefing) this.briefing.setReady(() => this.deploy());
        else this.hud.setLoading(null);
        this.last = performance.now();
      });
  }

  /**
   * Attract mode: compile the scene's shaders while the boot splash covers it
   * (the demo battle holds still meanwhile). `full` also builds every unit /
   * building model of both sides (slower, smoother demo).
   */
  async prewarm(onProgress: (k: number) => void, full = false): Promise<void> {
    if (this.warming || this.destroyed) return;
    this.warming = true;
    try {
      const factions = full ? [...new Set(this.world.players.map((p) => p.faction))] : [];
      this.warmup = await warmUp(this.renderer, factions, null, (k) => !this.destroyed && onProgress(k), () => !this.destroyed);
      console.info(`[warmup] attract: ${this.warmup.models} models, ${this.warmup.programs} programs in ${this.warmup.ms} ms (longest slice ${this.warmup.worst} ms)`);
    } catch (e) {
      if (!this.destroyed) console.warn('[warmup] failed', e);
    } finally {
      if (!this.destroyed) {
        this.warming = false;
        this.last = performance.now();
      }
    }
  }

  /**
   * Demo battle: after the scene warm-up, build both sides' unit / building models and compile their
   * shaders in the background (small idle slices), so the AI's first tank of a type does not stall a frame.
   */
  prefetch() {
    if (!this.opts.attract || this.destroyed) return;
    const factions = [...new Set(this.world.players.map((p) => p.faction))];
    void prefetchModels(this.renderer, factions, () => !this.destroyed).then((n) => n && console.info(`[warmup] demo: ${n} models prefetched`));
  }

  /** Switch the control scheme (Settings → Controls; can change mid-battle). */
  setControls(c: 'simple' | 'advanced') {
    if (this.local < 0) return;
    this.simple = c === 'simple';
    this.hud.setSimple(this.simple);
    this.ctlUI?.dock(this.simple ? this.hud.moreSlots : null);
    if (!this.simple && this.boxSelectMode) {
      this.boxSelectMode = false;
      this.setMode(this.mode);
    }
  }

  /** Is this a small (phone-sized) screen? */
  private smallScreen() {
    return Math.min(window.innerWidth, window.innerHeight) < 560;
  }

  /** Finger movement (CSS px) that still counts as a tap in the simple scheme; larger drags pan. */
  private tapSlop() {
    const m = Math.min(window.innerWidth, window.innerHeight);
    return Math.round(Math.max(16, Math.min(26, 18 * Math.sqrt(Math.max(1, m / 420)))));
  }

  /** Short, rate-limited help line when a tap could not do anything. */
  private nudge(text: string) {
    const now = performance.now();
    if (now - this.lastNudge < 9000) return;
    this.lastNudge = now;
    this.hud.message(text, 'info');
  }

  /** Settings that can change mid-battle (pause menu). */
  setViewSettings(s: { droneCam?: 'auto' | 'off'; xray?: boolean }) {
    if (s.droneCam) this.modes.drone?.setMode(s.droneCam);
    if (s.xray !== undefined) this.modes.xray = s.xray;
  }

  private resize() {
    const r = this.hud.viewWrap.getBoundingClientRect();
    const dpr = this.renderer.renderer.getPixelRatio();
    this.renderer.resize(Math.max(1, r.width), Math.max(1, r.height));
    this.audioScene?.resize(r.width, r.height);
    this.hud.resizeOverlay(r.width, r.height, Math.min(2, window.devicePixelRatio));
    void dpr;
  }

  /** Open photo mode; from the pause menu (`resume`) the battle runs again on the way out. */
  enterPhotoMode(resume = false) {
    if (this.local < 0 || this.ended || this.photo.active) return;
    if (this.cine.active) this.cine.skip();
    this.audio.unlock();
    this.sfx('click');
    this.photo.enter(resume);
  }

  // ------------------------------------------------------------------- loop

  private frame = (now: number) => {
    if (this.destroyed) return;
    this.raf = requestAnimationFrame(this.frame);
    if (skipFrame(now)) return; // battery saver: 30 fps cap (render/perf/hud.ts)
    const dt = Math.max(0, Math.min(0.1, (now - this.last) / 1000));
    this.last = now;
    if (this.warming || this.briefing) return;
    this.audioScene.update(dt);
    if (this.intro) {
      // intro flyover: the simulation has not started; only the camera moves
      this.introT = this.intro.time;
      if (this.cardText && this.introCardShown === 0 && this.introT >= this.introCardAt[0]) {
        this.introCardShown = 1;
        this.card?.show(this.cardText);
      } else if (this.introCardShown === 1 && this.introT >= this.introCardAt[1]) {
        this.introCardShown = 2;
        this.card?.hideCard();
      }
      if (this.intro.update(dt)) this.endIntro();
      this.renderer.render(1, dt);
      return;
    }
    if (this.outro && this.outro.update(dt)) this.endOutro();
    if (this.cine.active) this.cine.update(dt, this.renderer);
    this.hud.setCinematic(this.cine.active);
    const ts = this.cine.timeScale * (this.outro ? this.outro.timeScale : 1);
    if (!this.paused) {
      this.acc += dt * 1000 * this.speed * ts;
      let steps = 0;
      while (this.acc >= TICK_MS && steps < 6) {
        this.world.step();
        this.acc -= TICK_MS;
        steps++;
        for (const ev of this.world.drainEvents()) this.onEvent(ev);
      }
      if (steps >= 6) this.acc = 0;
    }
    const alpha = this.paused ? 1 : Math.min(1, this.acc / TICK_MS);
    this.tracker?.update();
    if (!this.cine.active && !this.photo.active && !this.outro) this.updateCamera(dt);
    if (this.local >= 0 && !this.photo.active) this.updateHover();
    this.renderer.render(alpha, this.paused ? 0 : dt * ts);
    this.hud.drawOverlay(alpha, this.hover, this.ctl.groupOf, now / 1000);
    this.ctlUI?.drawWaypoints(this.selectedOwnUnits(), alpha, now / 1000);
    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      if (this.local >= 0) this.hud.update(0.1);
      this.ctlUI?.update(this.selectedOwnUnits());
      this.pruneSelection();
    }
    this.mmTimer -= dt;
    if (this.local >= 0) {
      if (this.mmTimer <= 0) {
        this.mmTimer = 0.25;
        this.hud.drawMinimap();
      }
      // sweep + view frustum at ~30 fps
      if (++this.mmFrame % 2 === 0) this.hud.tickMinimap(now / 1000);
    }
  };

  /** Rotate the camera by 90 degree steps (Q / E, or the on-screen buttons). */
  rotateView(steps: number) {
    if (this.cine.active) this.cine.skip();
    this.renderer.rotateView(steps);
    this.sfx('click', undefined, undefined, 0.5);
  }

  /** Settings toggle: cinematic moments on / off. */
  setCinematic(on: boolean) {
    this.cine.enabled = on;
    if (!on) this.cine.skip();
  }

  // ------------------------------------------------------------ cinematics

  /** Is a ground point on screen or just outside it? */
  private nearView(x: number, y: number, margin = 0.25) {
    const s = this.renderer.project(x, standHeight(this.world.map, x, y), y);
    const r = this.hud.viewWrap.getBoundingClientRect();
    return s.x > -r.width * margin && s.x < r.width * (1 + margin) && s.y > -r.height * margin && s.y < r.height * (1 + margin);
  }

  /** Start a slow-motion camera moment for big events the player can see. */
  private considerCinematic(ev: SimEvent) {
    const c = this.cine;
    if (!c.enabled || c.active || this.paused || this.ended) return;
    // never fight the player for the camera
    if (this.drag || this.pinch || this.touches.size || this.mode === 'place' || this.renderer.rotating) return;
    if ([...this.keys].some((k) => k.startsWith('Arrow'))) return;
    const r = this.renderer;
    let shot: CineShot | null = null;
    if (ev.t === 'launch') {
      if (ev.flight !== 'ballistic' && ev.flight !== 'hypersonic') return;
      if (!(ev.owner === this.local || this.visibleToLocal(ev.x, ev.y)) || !this.nearView(ev.x, ev.y)) return;
      const pid = ev.id;
      const sx = ev.x;
      const sy = ev.y;
      const sz = ev.z;
      shot = {
        label: 'launch',
        push: 1.3,
        duration: 2.4,
        focus: () => {
          // between the launcher and the climbing missile
          const p = this.world.projectiles.find((q) => q.id === pid);
          if (!p) return null;
          return r.focusPoint(sx + (p.x - sx) * 0.4, sz + (p.z - sz) * 0.4, sy + (p.y - sy) * 0.4);
        },
      };
    } else if (ev.t === 'airburst') {
      if (ev.kind !== 'kill' || (ev.victim !== 'ballistic' && ev.victim !== 'hypersonic')) return;
      if (!this.visibleToLocal(ev.x, ev.y) || !this.nearView(ev.x, ev.y, 0.15)) return;
      const f = r.focusPoint(ev.x, ev.z, ev.y);
      shot = { label: 'intercept', push: 1.35, duration: 2.1, focus: () => f };
    } else if (ev.t === 'impact') {
      const w = WEAPONS[ev.weapon];
      if (!w || !(w.flight === 'ballistic' || w.flight === 'hypersonic' || w.damage >= 400)) return;
      if (!this.visibleToLocal(ev.x, ev.y) || !this.nearView(ev.x, ev.y, 0.15)) return;
      const f = { x: ev.x, y: ev.y };
      shot = { label: 'impact', push: 1.25, duration: 2.0, focus: () => f };
    }
    if (shot) c.trigger(shot, r, performance.now() / 1000);
  }

  private attractT = 0;

  private updateCamera(dt: number) {
    const r = this.renderer;
    if (this.opts.attract) {
      // slow cinematic drift towards the action
      this.attractT += dt;
      const fights = this.world.list.filter((e) => !e.dead && e.kind === 'unit' && e.firedAt > this.world.tick - 40);
      const tx = fights.length ? fights.reduce((s, e) => s + e.x, 0) / fights.length : this.world.map.w / 2 + Math.sin(this.attractT * 0.05) * 20;
      const ty = fights.length ? fights.reduce((s, e) => s + e.y, 0) / fights.length : this.world.map.h / 2 + Math.cos(this.attractT * 0.05) * 20;
      r.target.x += (tx - r.target.x) * Math.min(1, dt * 0.25);
      r.target.z += (ty - r.target.z) * Math.min(1, dt * 0.25);
      return;
    }
    const speed = 900 * dt;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('ArrowLeft')) dx -= speed;
    if (this.keys.has('ArrowRight')) dx += speed;
    if (this.keys.has('ArrowUp')) dy -= speed;
    if (this.keys.has('ArrowDown')) dy += speed;
    if (this.mouse.inside && this.mouse.type === 'mouse' && !this.drag && document.hasFocus()) {
      const rect = this.hud.viewWrap.getBoundingClientRect();
      const m = 8;
      if (this.mouse.x < m) dx -= speed;
      if (this.mouse.x > rect.width - m) dx += speed;
      if (this.mouse.y < m) dy -= speed;
      if (this.mouse.y > rect.height - m) dy += speed;
    }
    if (dx || dy) r.panPixels(dx, dy);
  }

  // ----------------------------------------------------------------- events

  /** Play an effect; with a world position it is positional (pan, distance, off-screen muffling, delay). */
  private sfx(name: Sfx, x?: number, y?: number, vol = 1, z = 0) {
    if (x === undefined || y === undefined) {
      this.audio.play(name, vol);
      return;
    }
    this.audio.play(name, vol, { x, y, z });
  }

  private visibleToLocal(x: number, y: number) {
    return this.local < 0 || this.world.visibleTo(this.local, x, y);
  }

  private onEvent(ev: SimEvent) {
    this.tracker?.onEvent(ev);
    if (ev.t === 'death' && ev.kind === 'building' && ev.owner >= 0) this.lastFall = { x: ev.x, y: ev.y, owner: ev.owner };
    this.renderer.handleEvent(ev);
    this.modes.onEvent(ev);
    if (ev.t === 'launch' || ev.t === 'airburst' || ev.t === 'impact') this.considerCinematic(ev);
    const mine = 'owner' in ev && ev.owner === this.local;
    switch (ev.t) {
      case 'launch': {
        if (!this.visibleToLocal(ev.x, ev.y)) break;
        const f = ev.flight;
        const snd: Sfx = f === 'interceptor' ? 'interceptorLaunch' : f === 'sam' || f === 'ballistic' || f === 'hypersonic' || f === 'cruise' ? 'missileLaunch' : f === 'rocketSalvo' ? 'thermo' : 'rocket';
        this.sfx(snd, ev.x, ev.y, f === 'ballistic' || f === 'hypersonic' ? 1 : 0.75);
        break;
      }
      case 'airburst':
        if (this.visibleToLocal(ev.x, ev.y)) this.sfx(ev.kind === 'kill' ? (ev.victim === 'ballistic' || ev.victim === 'hypersonic' ? 'explosionLarge' : 'explosionMedium') : 'explosionSmall', ev.x, ev.y, 0.8, ev.z);
        break;
      case 'fire': {
        if (!this.visibleToLocal(ev.x, ev.y) && !this.visibleToLocal(ev.tx, ev.ty)) break;
        const w = WEAPONS[ev.weapon];
        if (w.flight && w.flight !== 'shell' && w.flight !== 'artillery' && w.flight !== 'mortar') break; // launch event plays it
        if (ev.targetId < 0 && w.projectile !== 'beam') break;
        const snd: Sfx =
          w.projectile === 'beam' ? 'laser'
          : w.projectile === 'spawn' ? 'droneLaunch'
          : ev.weapon === 'autocannon' ? 'autocannon'
          : w.warhead === 'flak' ? 'flak'
          : w.warhead === 'thermo' ? 'thermo'
          : w.projectile === 'missile' ? 'missileLaunch'
          : w.projectile === 'rocket' ? 'rocket'
          : w.projectile === 'artillery' ? (w.flight === 'mortar' ? 'mortar' : 'artillery')
          : w.projectile === 'shell' ? (w.damage > 70 ? 'cannonHeavy' : 'cannon')
          : w.rof < 10 ? 'mg' : 'rifle';
        this.sfx(snd, ev.x, ev.y, snd === 'mg' || snd === 'rifle' ? 0.5 : 0.8);
        break;
      }
      case 'impact': {
        if (!this.visibleToLocal(ev.x, ev.y)) break;
        const w = WEAPONS[ev.weapon];
        if (w.projectile === 'instant' && w.damage < 30) break;
        if (w.projectile === 'beam') break;
        const big = w.damage >= 200 || w.warhead === 'thermo';
        this.sfx(big ? 'explosionLarge' : w.damage >= 70 || w.splash ? 'explosionMedium' : 'explosionSmall', ev.x, ev.y, big ? 1 : 0.8, ev.air ? ev.z : 0);
        break;
      }
      case 'intercept':
        if (this.visibleToLocal(ev.x, ev.y)) this.sfx('intercept', ev.x, ev.y);
        break;
      case 'death': {
        if (!this.visibleToLocal(ev.x, ev.y)) break;
        const d = DEFS[ev.def];
        if (d.kind === 'building') this.sfx(ev.def === 'bridge' ? 'bridgeCollapse' : 'buildingCollapse', ev.x, ev.y);
        else if (d.category === 'vehicle') this.sfx('explosionLarge', ev.x, ev.y);
        else if (d.category === 'air' && !unitDef(d.id).temp) this.sfx('explosionMedium', ev.x, ev.y);
        if (ev.owner === this.local && d.kind === 'unit' && !unitDef(d.id).temp) {
          if (unitDef(d.id).harvester) this.say('Ore harvester lost', 'warn');
        }
        if (ev.owner === this.local && d.kind === 'building') this.say('Structure lost', 'warn');
        break;
      }
      case 'crushed':
        if (this.visibleToLocal(ev.x, ev.y)) this.sfx('crush', ev.x, ev.y, 0.9);
        break;
      case 'dodge':
        if (mine && !ev.yield) this.sfx('squelch', ev.x, ev.y, 0.6); // one of ours yelling a warning
        break;
      case 'placed':
        if (mine) this.sfx('place');
        break;
      case 'deployed':
        if (mine) {
          this.sfx('deploy');
          this.hintShown = true;
          this.hud.showHint('Construction Yard deployed! Build a <b>Power Plant</b> from the Base tab on the right, then place it next to your base.');
          this.hud.setTab('building');
        }
        break;
      case 'buildingReady':
        if (mine) {
          this.say('Construction complete', 'good');
          this.sfx('build');
          if (this.hintShown && this.world.players[this.local].stats.built === 0) this.hud.showHint('Click the flashing <b>READY</b> icon, then click on the map near your base to place the building.');
        }
        break;
      case 'unitReady':
        if (mine) {
          const d = unitDef(ev.def);
          this.say(d.category === 'infantry' ? 'Unit ready' : d.category === 'air' ? 'Aircraft ready' : 'Unit ready', 'good');
        }
        break;
      case 'noFunds':
        if (mine) this.say('Insufficient funds', 'warn');
        break;
      case 'sortie':
        // jet sortie cycle (sim/airbase.ts): only the bad news is worth a voice line
        if (mine && ev.what === 'orbit') this.say('Airbase lost - jets need a free pad', 'warn');
        else if (mine && ev.what === 'divert') this.say('Jets diverting to another airbase', 'warn');
        else if (mine && ev.what === 'crash') this.say('Jet lost with its airbase', 'warn');
        break;
      case 'lowPower':
        if (mine) this.say('Low power', 'warn');
        break;
      case 'underAttack':
        if (mine) {
          const base = this.world.list.some((e) => !e.dead && e.owner === this.local && e.kind === 'building' && Math.hypot(e.x - ev.x, e.y - ev.y) < 0.01);
          this.say(base ? 'Our base is under attack' : 'Unit under attack', 'warn');
          this.sfx('alarm', undefined, undefined, 0.5);
        }
        break;
      case 'captured':
        if (mine) this.say('Building captured', 'good');
        break;
      case 'superweapon': {
        // warnings for everybody (superweapons.ts); the HUD shows the countdowns and impact markers
        this.hud.superweapons.onEvent(ev);
        const info = SW_INFO[ev.sw as SwKind];
        const own = ev.owner === this.local;
        if (ev.phase === 'detected') this.say(own ? `${info.building} online - charging` : `Warning: enemy superweapon detected - ${info.name}`, own ? 'good' : 'warn');
        else if (ev.phase === 'ready') this.say(own ? `${info.name} ready` : `Warning: enemy ${info.name} ready`, own ? 'good' : 'warn');
        else if (ev.phase === 'launch') {
          this.say(own ? `${info.name} launched` : `Enemy ${info.name} launched!`, own ? 'good' : 'warn');
          if (!own) this.sfx('alarm', undefined, undefined, 0.8);
        } else if (ev.phase === 'lost' && own) this.say('Superweapon lost', 'warn');
        break;
      }
      case 'garrison':
        if (mine && ev.enter) this.say('Building garrisoned', 'good');
        break;
      case 'promoted':
        if (mine) this.say(ev.rank >= 2 ? 'Unit promoted to elite' : 'Unit promoted', 'good');
        break;
      case 'sold':
        if (mine) this.sfx('sell');
        break;
      case 'gameOver':
        this.finish(ev.winner === this.local);
        break;
    }
  }

  private lastSay = new Map<string, number>();
  private say(text: string, kind: 'info' | 'warn' | 'good') {
    if (this.local < 0) return;
    const now = performance.now();
    if (now - (this.lastSay.get(text) ?? -1e9) < 3500) return;
    this.lastSay.set(text, now);
    this.hud.message(text, kind);
    this.audio.say(text);
  }

  private finish(win: boolean) {
    if (this.ended) return;
    this.ended = true;
    this.cine.cancel(this.renderer);
    if (this.local < 0) {
      // restart the attract demo
      setTimeout(() => this.cb.onMenu(), 4000);
      return;
    }
    this.audio.say(win ? 'Mission accomplished' : 'Mission failed');
    this.endWin = win;
    if ((this.opts.briefing ?? 'full') === 'off') {
      setTimeout(() => this.endOutro(), 2500);
      return;
    }
    // outro: slow motion, the camera drifts to where the last structure fell, VICTORY / DEFEAT card
    if (this.photo.active) this.photo.exit();
    const fall = this.lastFall ?? { x: this.renderer.target.x, y: this.renderer.target.z, owner: -1 };
    this.outro = new BattleOutro(this.renderer, this.world.map, fall, 4.8);
    this.card = new CineCard(this.hud.viewWrap, () => this.outro?.skip(), 'TAP TO CONTINUE');
    this.card.show({ kicker: this.brief ? `Operation ${this.brief.codename}` : undefined, title: win ? 'VICTORY' : 'DEFEAT', sub: win ? 'Mission accomplished' : 'Mission failed', tone: win ? 'win' : 'lose' });
    this.hud.root.classList.add('intro-on');
    this.renderer.selection.clear();
    if (win) this.audio.sting('heavy');
    // victory fireworks over the base, the nearest town and the outro shot (render/fx/fireworks.ts)
    if (win) this.renderer.atmos.living.celebrate(this.local, fall, (n, v, at) => this.audio.play(n, v, at));
  }
  private endWin = false;
  private reported = false;

  /** Outro over (or skipped): freeze the battle and hand over to the after-action report. */
  private endOutro() {
    if (this.destroyed || this.reported) return;
    this.reported = true;
    this.outro = null;
    this.paused = true;
    this.card?.destroy();
    this.card = null;
    const report = this.tracker?.report(this.endWin);
    this.cb.onEnd(this.endWin, { you: this.world.players[0], enemy: this.world.players[1], time: report?.time ?? (performance.now() - this.startTime) / 1000, report, codename: this.brief?.codename });
  }

  // --------------------------------------------------------------- commands

  private issue(cmd: Command) {
    if (this.local >= 0) this.world.issue(this.local, cmd);
  }

  private selectedOwnUnits(): Entity[] {
    return [...this.renderer.selection].map((id) => this.world.get(id)).filter((e): e is Entity => !!e && e.owner === this.local && e.kind === 'unit');
  }

  private select(ids: number[], add = false, sound = true) {
    const sel = this.renderer.selection;
    if (!add) sel.clear();
    for (const id of ids) sel.add(id);
    this.hud.forceSelectionRefresh();
    if (sound && ids.length) this.sfx('select');
  }

  private pruneSelection() {
    for (const id of this.renderer.selection) {
      const e = this.world.get(id);
      if (!e || e.inside >= 0) this.renderer.selection.delete(id);
    }
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.touchPlace = null;
    if (m !== 'place') {
      this.placing = null;
      this.renderer.setGhost(null, 0, 0, false, 0);
    }
    this.hud.setToolActive(m === 'sell' ? 'sell' : m === 'repair' ? 'repair' : this.boxSelectMode ? 'boxselect' : null);
    this.hud.setOrderMode(m === 'normal' ? null : m);
    if (this.ctlUI) this.ctlUI.mode = m === 'patrol' || m === 'guard' ? m : null;
    if (this.simple) {
      // say what the next tap does
      const hint =
        m === 'place' ? 'Tap the map to preview the building, then tap it <b>again</b> to build it.'
        : m === 'attackMove' ? 'Tap the map: units move there and fight everything on the way.'
        : m === 'sell' ? 'Tap one of your buildings to sell it.'
        : m === 'repair' ? 'Tap a damaged building to repair it.'
        : this.boxSelectMode ? '<b>Drag</b> on the map to select units.'
        : null;
      if (hint) this.hud.showHint(hint);
      else if (this.modeHint) this.hud.showHint(null);
      this.modeHint = !!hint;
    }
  }
  private modeHint = false;

  // ------------------------------------------------------------ RTS controls (src/game/controls.ts)

  private controlsHost(): ControlsHost {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const g = this;
    return {
      get world() {
        return g.world;
      },
      get local() {
        return g.local;
      },
      selection: () => g.renderer.selection,
      select: (ids, add) => g.select(ids, add),
      issue: (c) => g.issue(c),
      centerOn: (x, y) => g.renderer.centerOn(x, y),
      ack: (k) => g.sfx(k),
      message: (t) => g.hud.message(t, 'info'),
    };
  }

  /** Shift held (desktop) or the queue toggle (phone): orders go into the waypoint queue. */
  private queueing() {
    return this.keys.has('Shift') || this.ctl.queueMode;
  }

  private setStance(st: Stance) {
    const ids = orderable(this.selectedOwnUnits()).map((u) => u.id);
    if (!ids.length) return;
    this.issue({ type: 'stance', ids, stance: st });
    this.sfx('ack');
    this.hud.message(`Stance: ${STANCE_LABEL[st]}`, 'info');
  }

  private toggleOrderMode(m: OrderMode) {
    if (!orderable(this.selectedOwnUnits()).length) return;
    this.setMode(this.mode === m ? 'normal' : m);
    this.sfx('click');
    if (this.mode === m && this.mouse.type === 'touch') this.hud.message(m === 'patrol' ? 'Tap the far end of the patrol route' : 'Tap a friendly unit or building to escort', 'info');
  }

  private onCameo(id: string, cat: Category, shift: boolean) {
    this.audio.unlock();
    const p = this.world.players[this.local];
    if (p.ready[cat] === id) {
      this.setMode('place');
      this.placing = id;
      this.sfx('click');
      // small screens: fold the build menu away so the whole battlefield is free for placing
      // (landscape only: in portrait the sidebar is docked under the battlefield)
      if (this.simple && this.smallScreen() && window.innerWidth > window.innerHeight) this.hud.setCollapsed(true);
      return;
    }
    if (!this.world.canBuild(this.local, id)) {
      this.sfx('error');
      return;
    }
    const d = DEFS[id];
    if (d.kind === 'building' && (p.queues[cat].length || p.ready[cat])) {
      this.sfx('error');
      this.say('Unable to comply. Building in progress', 'warn');
      return;
    }
    this.issue({ type: 'produce', def: id, count: shift ? 5 : 1 });
    this.sfx('click');
    if (d.kind === 'building') this.audio.say('Building');
    else this.audio.say('Training');
    if (this.hintShown && d.kind === 'building') this.hud.showHint(null);
  }

  private onTool(t: 'repair' | 'sell' | 'menu' | 'boxselect') {
    this.audio.unlock();
    this.sfx('click');
    if (t === 'menu') {
      this.cb.onMenu();
      return;
    }
    if (t === 'boxselect') {
      this.boxSelectMode = !this.boxSelectMode;
      this.setMode(this.mode === 'place' ? 'place' : 'normal');
      if (!this.boxSelectMode && this.simple) this.hud.showHint(null);
      return;
    }
    this.setMode(this.mode === t ? 'normal' : t);
  }

  private onCommand(c: 'stop' | 'attackMove' | 'deploy' | 'selectArmy' | 'selectScreen' | 'deselect' | 'sellSel' | 'repairSel' | 'evacuate' | 'cancel' | 'repairMode' | 'sellMode') {
    this.audio.unlock();
    const units = this.selectedOwnUnits();
    switch (c) {
      case 'stop':
        if (units.length) this.issue({ type: 'stop', ids: units.map((u) => u.id) });
        this.sfx('ack');
        break;
      case 'attackMove':
        this.setMode('attackMove');
        this.sfx('click');
        break;
      case 'deploy':
      case 'evacuate': {
        // a selected garrisoned house of ours: send the garrison out (garrison.ts)
        const house = [...this.renderer.selection].map((id) => this.world.get(id)).find((e) => e && e.kind === 'building' && e.owner === this.local && e.passengers.length);
        if (house && (c === 'evacuate' || !units.length)) {
          this.issue({ type: 'evacuate', id: house.id });
          this.sfx('ack');
          break;
        }
        if (c === 'deploy') this.issue({ type: 'deploy', ids: units.map((u) => u.id) });
        break;
      }
      case 'selectArmy':
      case 'selectScreen': {
        const army = this.world.list.filter((e) => !e.dead && e.owner === this.local && e.kind === 'unit' && e.inside < 0 && !!unitDef(e.def).weapon && !unitDef(e.def).temp && !unitDef(e.def).harvester);
        const ids = (c === 'selectScreen' ? army.filter((e) => this.onScreen(e)) : army).map((e) => e.id);
        this.select(ids);
        if (ids.length) {
          navigator.vibrate?.(8);
          this.hud.flashUnits(ids, 'select');
          if (this.simple) this.hud.message(`${ids.length} unit${ids.length > 1 ? 's' : ''} selected · tap the map to move`, 'info');
        } else if (this.simple) {
          this.sfx('error');
          this.hud.message(c === 'selectScreen' ? 'No combat units on screen' : 'No combat units yet', 'warn');
        }
        if (this.simple && (this.mode === 'attackMove' || this.mode === 'patrol' || this.mode === 'guard')) this.setMode('normal');
        break;
      }
      case 'deselect':
        this.select([]);
        if (this.simple) {
          this.sfx('click', undefined, undefined, 0.5);
          if (this.mode !== 'normal' && this.mode !== 'place') this.setMode('normal');
        }
        break;
      case 'cancel':
        if (this.boxSelectMode) this.boxSelectMode = false;
        this.setMode('normal');
        this.hud.showHint(null);
        this.sfx('click');
        break;
      case 'repairMode':
        this.setMode(this.mode === 'repair' ? 'normal' : 'repair');
        this.sfx('click');
        break;
      case 'sellMode':
        this.setMode(this.mode === 'sell' ? 'normal' : 'sell');
        this.sfx('click');
        break;
      case 'sellSel':
      case 'repairSel': {
        const b = [...this.renderer.selection].map((id) => this.world.get(id)).find((e) => e && e.kind === 'building' && e.owner === this.local);
        if (b) this.issue(c === 'sellSel' ? { type: 'sell', id: b.id } : { type: 'repair', id: b.id });
        this.sfx(c === 'sellSel' ? 'sell' : 'repair');
        break;
      }
    }
  }

  /** Is the entity inside the battlefield view? */
  private onScreen(e: Entity) {
    const rect = this.hud.viewWrap.getBoundingClientRect();
    const p = this.renderer.entityPos(e, 1);
    const s = this.renderer.project(p.x, p.y, p.z);
    return s.x >= 0 && s.y >= 0 && s.x <= rect.width && s.y <= rect.height;
  }

  // ------------------------------------------------------------------ picking

  /**
   * Simple-scheme unit hit test against the visible model: the distance from the tap to the
   * unit's upright body (a segment from its feet to its top, as wide as the drawn model).
   * Returns the distance, or Infinity on a miss. `tight`: only a direct hit on the body counts.
   */
  private touchHit(e: Entity, sx: number, sy: number, tight: boolean): number {
    const r = this.renderer;
    const d = unitDef(e.def);
    const p = r.entityPos(e, 1);
    const scale = r.pixelsPerUnit(p);
    const m = r.visuals.get(e.id)?.model;
    const half = m?.size ? Math.max(m.size.x, m.size.z) / 2 : d.radius * 1.3;
    const h = r.visualHeight(e.id);
    const a = r.project(p.x, p.y, p.z);
    const b = r.project(p.x, p.y + h, p.z);
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const L = vx * vx + vy * vy;
    const t = L > 0 ? Math.max(0, Math.min(1, ((sx - a.x) * vx + (sy - a.y) * vy) / L)) : 0;
    const dist = Math.hypot(sx - (a.x + vx * t), sy - (a.y + vy * t));
    // the body: the model's half width on screen (at least a fingertip); loose: a generous halo
    const body = Math.max(7, half * scale * 0.85);
    const rad = tight ? body : Math.max(24, half * scale * 1.5);
    return dist < rad ? dist : Infinity;
  }

  private pick(sx: number, sy: number): Entity | null {
    const w = this.world;
    const r = this.renderer;
    let best: Entity | null = null;
    let bd = Infinity;
    const tp = this.touchPick;
    for (const e of w.list) {
      if (e.dead || e.kind !== 'unit' || !r.isShown(e.id)) continue;
      const d = unitDef(e.def);
      if (d.temp) continue;
      if (tp) {
        // simple scheme: own units need a direct hit while units are selected (so a tap next to
        // them moves the selection there); enemies and an empty selection get a generous halo
        const dist = this.touchHit(e, sx, sy, tp === 'tight' && e.owner === this.local) - (d.air ? 6 : 0);
        if (dist < bd) {
          bd = dist;
          best = e;
        }
        continue;
      }
      const p = r.entityPos(e, 1);
      const scale = r.pixelsPerUnit(p);
      const s = r.project(p.x, p.y + r.visualHeight(e.id) * 0.45, p.z);
      const rad = Math.max(13, d.radius * scale * 1.5);
      const dist = Math.hypot(s.x - sx, s.y - sy);
      if (dist < rad && dist - (d.air ? 6 : 0) < bd) {
        bd = dist - (d.air ? 6 : 0);
        best = e;
      }
    }
    if (best) return best;
    const g = r.screenToGround(sx, sy);
    const tx = Math.floor(g.x);
    const ty = Math.floor(g.y);
    if (tx >= 0 && ty >= 0 && tx < w.map.w && ty < w.map.h) {
      const id = w.occ[ty * w.map.w + tx];
      const b = id ? w.get(id) : undefined;
      if (b && r.isShown(b.id)) return b;
    }
    // tall buildings: test their projected box too
    for (const e of w.list) {
      if (e.dead || e.kind !== 'building' || !r.isShown(e.id)) continue;
      // simple scheme with units selected: own buildings only by their footprint (the ground behind them moves)
      if (tp === 'tight' && e.owner === this.local) continue;
      const d = buildingDef(e.def);
      const p = r.entityPos(e, 1);
      const scale = r.pixelsPerUnit(p);
      const c = r.project(p.x, p.y + r.visualHeight(e.id) * 0.5, p.z);
      const span = (d.w + d.h) / 2;
      if (Math.abs(c.x - sx) < span * scale * 0.55 && Math.abs(c.y - sy) < span * scale * 0.45) return e;
    }
    return null;
  }

  /** Decide the context action for the cursor position. */
  private contextAction(sx: number, sy: number, ctrl: boolean): { cursor: string; run: () => void } {
    const w = this.world;
    const units = this.selectedOwnUnits();
    const target = this.pick(sx, sy);
    const g = this.renderer.screenToGround(sx, sy);
    const none = { cursor: 'default', run: () => {} };
    if (this.mode === 'place' && this.placing) {
      const d = buildingDef(this.placing);
      const tx = Math.round(g.x - d.w / 2);
      const ty = Math.round(g.y - d.h / 2);
      const ok = w.canPlace(this.local, this.placing, tx, ty);
      this.renderer.setGhost(this.placing, tx, ty, ok, this.local);
      return {
        cursor: ok ? 'place' : 'nope',
        run: () => {
          if (!ok) {
            this.sfx('error');
            return;
          }
          this.issue({ type: 'place', def: this.placing!, tx, ty });
          this.setMode('normal');
          if (this.hintShown) {
            this.hintShown = false;
            this.hud.showHint(null);
          }
        },
      };
    }
    if (this.mode === 'sell' || this.mode === 'repair') {
      const ok = target && target.kind === 'building' && target.owner === this.local;
      return {
        cursor: ok ? this.mode : 'nope',
        run: () => {
          if (!ok) return;
          this.issue(this.mode === 'sell' ? { type: 'sell', id: target!.id } : { type: 'repair', id: target!.id });
          this.sfx(this.mode === 'sell' ? 'sell' : 'repair');
          if (this.mode === 'sell') this.setMode('normal');
        },
      };
    }
    const ownSel = units.length > 0;
    if ((this.mode === 'patrol' || this.mode === 'guard') && ownSel) {
      const ids = orderable(units).map((u) => u.id);
      if (this.mode === 'guard') {
        const ok = !!target && target.owner === this.local && !ids.includes(target.id) && !(target.kind === 'unit' && unitDef(target.def).temp);
        return {
          cursor: ok ? 'enter' : 'nope',
          run: () => {
            if (!ok) return this.sfx('error');
            this.order({ type: 'guard', ids, target: target!.id, queue: this.queueing() }, target, false);
            this.setMode('normal');
          },
        };
      }
      return {
        cursor: 'attack',
        run: () => {
          this.order({ type: 'patrol', ids, x: g.x, y: g.y, queue: this.queueing() }, null, true, g);
          this.setMode('normal');
        },
      };
    }
    if (target && target.owner === this.local && !(ctrl && ownSel)) {
      // own unit/building: select, deploy MCV, or engineer repair
      const eng = units.filter((u) => unitDef(u.def).engineer);
      if (target.kind === 'building' && eng.length && target.hp < target.maxHp) {
        return { cursor: 'enter', run: () => this.order({ type: 'capture', ids: eng.map((u) => u.id), target: target.id }, target, false) };
      }
      if (units.length === 1 && units[0].id === target.id && unitDef(target.def).mcv) {
        return { cursor: 'deploy', run: () => this.issue({ type: 'deploy', ids: [target.id] }) };
      }
      const cap = target.kind === 'unit' ? (unitDef(target.def).transport ?? 0) : 0;
      const riders = units.filter((u) => unitDef(u.def).category === 'infantry');
      if (cap && riders.length && target.passengers.length < cap) {
        return { cursor: 'enter', run: () => this.order({ type: 'enter', ids: riders.map((u) => u.id), target: target.id }, target, false) };
      }
      const garrison = units.filter((u) => canGarrisonUnit(u.def));
      if (target.kind === 'building' && garrison.length && garrisonRoom(w, target, this.local) > 0) {
        return { cursor: 'enter', run: () => this.order({ type: 'enter', ids: garrison.map((u) => u.id), target: target.id }, target, false) };
      }
      return { cursor: 'select', run: () => this.select([target.id], this.keys.has('Shift')) };
    }
    if (ownSel) {
      if (target && target.owner !== this.local) {
        const eng = units.filter((u) => unitDef(u.def).engineer);
        if (target.kind === 'building' && eng.length && !buildingDef(target.def).garrison && (target.owner >= 0 || buildingDef(target.def).capturable)) {
          return { cursor: 'enter', run: () => this.order({ type: 'capture', ids: eng.map((u) => u.id), target: target.id }, target, false) };
        }
        // garrison an empty civilian building (garrison.ts)
        const garrison = units.filter((u) => canGarrisonUnit(u.def));
        if (target.kind === 'building' && target.owner < 0 && garrison.length && garrisonRoom(w, target, this.local) > 0 && !ctrl) {
          return { cursor: 'enter', run: () => this.order({ type: 'enter', ids: garrison.map((u) => u.id), target: target.id }, target, false) };
        }
        const attackers = units.filter((u) => {
          const d = unitDef(u.def);
          return d.weapon && !d.temp && WEAPONS[d.weapon] && w.canHit(WEAPONS[d.weapon], target);
        });
        if (target.owner >= 0 && attackers.length) {
          return { cursor: 'attack', run: () => this.order({ type: 'attack', ids: attackers.map((u) => u.id), target: target.id, queue: this.queueing() }, target, true) };
        }
        if (isBridge(target)) {
          // bridges: Ctrl force-fires heavy ordnance at the deck; otherwise the deck is just ground to move onto
          const heavy = attackers.filter((u) => canHurtBridge(unitDef(u.def).weapon));
          if (ctrl && heavy.length) return { cursor: 'attack', run: () => this.order({ type: 'attack', ids: heavy.map((u) => u.id), target: target.id }, target, true) };
        } else if (target.owner < 0) return { cursor: 'select', run: () => this.select([target.id]) };
      }
      if (ctrl && target && target.owner === this.local) {
        const attackers = units.filter((u) => unitDef(u.def).weapon);
        return { cursor: 'attack', run: () => this.order({ type: 'attack', ids: attackers.map((u) => u.id), target: target.id, queue: this.queueing() }, target, true) };
      }
      const tile = Math.floor(g.y) * w.map.w + Math.floor(g.x);
      const harvesters = units.filter((u) => unitDef(u.def).harvester);
      if (harvesters.length === units.length && w.map.ore[tile] > 0) {
        return { cursor: 'harvest', run: () => this.order({ type: 'harvest', ids: harvesters.map((u) => u.id), x: g.x, y: g.y }, null, false, g) };
      }
      const allAir = units.every((u) => unitDef(u.def).air);
      const passable = allAir || terrainPassable(w.map, Math.floor(g.x), Math.floor(g.y));
      const attackMove = this.mode === 'attackMove' || ctrl;
      if (!passable && this.local >= 0 && w.players[this.local].explored[tile]) return { cursor: 'nomove', run: () => this.sfx('error') };
      return {
        cursor: attackMove ? 'attack' : 'move',
        run: () => {
          this.order({ type: 'move', ids: units.map((u) => u.id), x: g.x, y: g.y, attackMove, queue: this.queueing() }, null, attackMove, g);
          if (this.mode === 'attackMove') this.setMode('normal');
        },
      };
    }
    // own production building selected: set rally point
    const sel = [...this.renderer.selection].map((id) => w.get(id)).find((e) => e && e.kind === 'building' && e.owner === this.local && buildingDef(e.def).produces);
    if (sel && !target) {
      return {
        cursor: 'move',
        run: () => {
          this.issue({ type: 'rally', id: sel.id, x: g.x, y: g.y });
          this.renderer.overlay.order('rally', g.x, g.y);
          this.sfx('ack');
        },
      };
    }
    if (target) return { cursor: 'select', run: () => this.select([target.id]) };
    return { ...none, run: () => this.select([]) };
  }

  private order(cmd: Command, target: Entity | null, attack: boolean, g?: { x: number; y: number }) {
    this.issue(cmd);
    this.sfx('ack');
    const r = this.renderer;
    const ids = 'ids' in cmd ? cmd.ids : [];
    if (this.mouse.type === 'touch') navigator.vibrate?.(10);
    // the units that took the order flash briefly
    this.hud.flashUnits(ids, attack ? 'attack' : 'move');
    if (target) {
      const tid = target.id;
      const big = target.kind === 'building' ? Math.max(buildingDef(target.def).w, buildingDef(target.def).h) * 0.75 : Math.max(1, unitDef(target.def).radius * 2.2);
      const follow = () => {
        const t = this.world.get(tid);
        if (!t || t.dead) return null;
        const p = r.entityPos(t, 1);
        if (t.kind === 'unit' && unitDef(t.def).air) p.y = standHeight(this.world.map, p.x, p.z);
        return p;
      };
      const p = r.entityPos(target, 1);
      r.overlay.order(attack ? 'attack' : 'move', p.x, p.z, follow, big);
      this.hud.orderLine(ids, p.x, p.z, tid, attack ? 'attack' : 'other');
    } else if (g) {
      const am = cmd.type === 'move' && !!cmd.attackMove;
      r.overlay.order(am ? 'attackMove' : 'move', g.x, g.y);
      this.hud.orderLine(ids, g.x, g.y, -1, am ? 'attackMove' : 'move');
    }
  }

  private updateHover() {
    if (!this.mouse.inside || this.drag?.panning) return;
    if (this.mouse.type === 'touch' && this.mode === 'place') return;
    const t = this.pick(this.mouse.x, this.mouse.y);
    this.hover = t ? t.id : -1;
    this.renderer.hover = this.mouse.type === 'mouse' ? this.hover : -1;
    if (this.drag?.box) return;
    const a = this.contextAction(this.mouse.x, this.mouse.y, this.keys.has('Control') || this.keys.has('Meta'));
    this.hud.setCursor(a.cursor);
  }

  // ------------------------------------------------------------------- input

  private drag: { id: number; sx: number; sy: number; button: number; box: boolean; panning: boolean; moved: boolean; longTimer: number; time: number } | null = null;
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; zoom: number; cx: number; cy: number } | null = null;
  private lastClick = { t: 0, id: -1 };

  private bindInput() {
    const view = this.hud.viewWrap;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      t.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => t.removeEventListener(type, fn as EventListener, opts));
    };
    const local = (e: PointerEvent | WheelEvent | MouseEvent) => {
      const r = view.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    on(view, 'contextmenu', (e) => e.preventDefault());
    // any tap / click skips a cinematic moment (the tap on the map is swallowed)
    on(window, 'pointerdown', () => this.cine.skip(), { capture: true });
    on(view, 'pointerdown', (e) => {
      this.audio.unlock();
      if (this.cine.active) return;
      // HUD widgets inside the view (command bar, portrait, rotate buttons) are not map clicks
      if ((e.target as HTMLElement).closest?.('button, .selpanel, .cmdbar, .view-ctrl, .hint, .quickbar, .more-panel, .ctl-groups, .ctl-orders')) return;
      if (this.local < 0) return;
      const p = local(e);
      this.mouse = { x: p.x, y: p.y, inside: true, type: e.pointerType };
      view.setPointerCapture(e.pointerId);
      if (e.pointerType === 'touch') {
        this.touches.set(e.pointerId, p);
        if (this.touches.size === 2) {
          if (this.drag) clearTimeout(this.drag.longTimer);
          this.drag = null;
          this.hud.selBox.style.display = 'none';
          const [a, b] = [...this.touches.values()];
          this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: this.renderer.zoom, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
          return;
        }
      }
      const d = { id: e.pointerId, sx: p.x, sy: p.y, button: e.button, box: false, panning: false, moved: false, longTimer: 0, time: performance.now() };
      if (e.pointerType === 'touch') {
        if (this.boxSelectMode) d.box = true;
        // simple scheme: no long-press box select (a slow tap must stay a tap)
        else if (!this.simple)
          d.longTimer = window.setTimeout(() => {
            if (this.drag === d && !d.moved) {
              d.box = true;
              navigator.vibrate?.(15);
              this.updateBox(d.sx, d.sy, d.sx, d.sy);
            }
          }, 380);
      }
      this.drag = d;
    });
    on(view, 'pointermove', (e) => {
      const p = local(e);
      this.mouse = { x: p.x, y: p.y, inside: true, type: e.pointerType };
      if (e.pointerType === 'touch' && this.touches.has(e.pointerId)) {
        this.touches.set(e.pointerId, p);
        if (this.pinch && this.touches.size >= 2) {
          const [a, b] = [...this.touches.values()];
          const dist = Math.hypot(a.x - b.x, a.y - b.y);
          this.renderer.setZoom((this.pinch.zoom * dist) / Math.max(1, this.pinch.dist));
          const cx = (a.x + b.x) / 2;
          const cy = (a.y + b.y) / 2;
          this.renderer.panDrag(this.pinch.cx, this.pinch.cy, cx, cy);
          this.pinch.cx = cx;
          this.pinch.cy = cy;
          return;
        }
      }
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      const dist = Math.hypot(p.x - d.sx, p.y - d.sy);
      const touch = e.pointerType === 'touch';
      // simple scheme: finger jitter up to ~18 px is still a tap; only a real drag pans
      if (dist > (touch && this.simple ? this.tapSlop() : 7)) d.moved = true;
      if (!d.moved) return;
      if ((touch && !d.box) || d.button === 2 || d.button === 1) {
        if (!d.panning) {
          d.panning = true;
          clearTimeout(d.longTimer);
          this.hud.setCursor('pan');
        }
        this.renderer.panDrag(d.sx, d.sy, p.x, p.y);
        d.sx = p.x;
        d.sy = p.y;
        return;
      }
      if (d.button === 0 && this.mode !== 'place') {
        d.box = true;
        this.updateBox(d.sx, d.sy, p.x, p.y);
      }
    });
    const end = (e: PointerEvent) => {
      const p = local(e);
      if (e.pointerType === 'touch') {
        this.touches.delete(e.pointerId);
        if (this.pinch) {
          if (this.touches.size < 2) this.pinch = null;
          this.drag = null;
          return;
        }
      }
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      clearTimeout(d.longTimer);
      this.drag = null;
      this.hud.selBox.style.display = 'none';
      if (d.panning) return;
      if (d.box && d.moved) {
        this.boxSelect(d.sx, d.sy, p.x, p.y, e.shiftKey);
        if (this.simple && this.boxSelectMode && e.pointerType === 'touch') {
          // one box per press of the BOX button: the next tap moves the new selection
          this.boxSelectMode = false;
          this.setMode(this.mode);
          this.hud.showHint(null);
        }
        return;
      }
      // simple scheme: a tap in box mode is still a tap (never swallowed)
      if (d.box && !d.moved && e.pointerType === 'touch' && !this.simple) return;
      if (d.button === 2) {
        // right click: cancel mode, else deselect
        if (this.mode !== 'normal') this.setMode('normal');
        else this.select([]);
        return;
      }
      if (d.button !== 0) return;
      // simple scheme: resolve the tap where the finger went down (jitter while lifting is noise)
      if (e.pointerType === 'touch' && this.simple) this.tapSimple(d.sx, d.sy);
      else this.click(p.x, p.y, e.ctrlKey || e.metaKey, e.shiftKey);
    };
    on(view, 'pointerup', end);
    on(view, 'pointercancel', (e) => {
      this.touches.delete(e.pointerId);
      this.pinch = null;
      if (this.drag) clearTimeout(this.drag.longTimer);
      this.drag = null;
      this.hud.selBox.style.display = 'none';
    });
    on(view, 'pointerleave', () => (this.mouse.inside = false));
    on(
      view,
      'wheel',
      (e) => {
        e.preventDefault();
        this.renderer.setZoom(this.renderer.zoom * (e.deltaY > 0 ? 0.9 : 1.1));
      },
      { passive: false },
    );
    on(window, 'keydown', (e) => this.onKey(e as KeyboardEvent, true));
    on(window, 'keyup', (e) => this.onKey(e as KeyboardEvent, false));
    on(window, 'blur', () => this.keys.clear());
  }

  private updateBox(x0: number, y0: number, x1: number, y1: number) {
    const s = this.hud.selBox.style;
    s.display = 'block';
    s.left = `${Math.min(x0, x1)}px`;
    s.top = `${Math.min(y0, y1)}px`;
    s.width = `${Math.abs(x1 - x0)}px`;
    s.height = `${Math.abs(y1 - y0)}px`;
  }

  private boxSelect(x0: number, y0: number, x1: number, y1: number, add: boolean) {
    const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
    const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
    const ids: number[] = [];
    for (const e of this.world.list) {
      if (e.dead || e.owner !== this.local || e.kind !== 'unit' || unitDef(e.def).temp) continue;
      const p = this.renderer.entityPos(e, 1);
      const s = this.renderer.project(p.x, p.y + 0.15, p.z);
      if (s.x >= ax && s.x <= bx && s.y >= ay && s.y <= by) ids.push(e.id);
    }
    // prefer combat units over harvesters when both are boxed
    const combat = ids.filter((id) => !unitDef(this.world.get(id)!.def).harvester);
    this.select(combat.length ? combat : ids, add);
  }

  private touchPlace: { tx: number; ty: number } | null = null;

  private click(x: number, y: number, ctrl: boolean, shift: boolean) {
    const now = performance.now();
    // touch placement: first tap previews the building, a tap on the preview confirms
    if (this.mode === 'place' && this.placing && this.mouse.type === 'touch') {
      const d = buildingDef(this.placing);
      const g = this.renderer.screenToGround(x, y);
      const tp = this.touchPlace;
      if (tp && g.x >= tp.tx - 0.3 && g.x < tp.tx + d.w + 0.3 && g.y >= tp.ty - 0.3 && g.y < tp.ty + d.h + 0.3) {
        if (this.world.canPlace(this.local, this.placing, tp.tx, tp.ty)) {
          this.issue({ type: 'place', def: this.placing, tx: tp.tx, ty: tp.ty });
          this.setMode('normal');
          this.hintShown = false;
          this.hud.showHint(null);
        } else this.sfx('error');
        return;
      }
      const tx = Math.round(g.x - d.w / 2);
      const ty = Math.round(g.y - d.h / 2);
      this.touchPlace = { tx, ty };
      this.renderer.setGhost(this.placing, tx, ty, this.world.canPlace(this.local, this.placing, tx, ty), this.local);
      this.hud.showHint('Tap the highlighted building again to place it, or tap elsewhere to move it.');
      return;
    }
    const target = this.pick(x, y);
    // double click selects all of that type on screen
    if (target && target.owner === this.local && target.kind === 'unit' && now - this.lastClick.t < 350 && this.lastClick.id === target.id && this.mode === 'normal') {
      const rect = this.hud.viewWrap.getBoundingClientRect();
      const ids = this.world.list
        .filter((e) => {
          if (e.dead || e.owner !== this.local || e.def !== target.def) return false;
          const p = this.renderer.entityPos(e, 1);
          const s = this.renderer.project(p.x, p.y, p.z);
          return s.x >= 0 && s.y >= 0 && s.x <= rect.width && s.y <= rect.height;
        })
        .map((e) => e.id);
      this.select(ids, shift);
      this.lastClick = { t: 0, id: -1 };
      return;
    }
    this.lastClick = { t: now, id: target?.id ?? -1 };
    if (shift && target && target.owner === this.local && this.mode === 'normal') {
      const sel = this.renderer.selection;
      if (sel.has(target.id)) sel.delete(target.id);
      else sel.add(target.id);
      this.hud.forceSelectionRefresh();
      this.sfx('select');
      return;
    }
    this.contextAction(x, y, ctrl).run();
  }

  /**
   * Simple touch scheme: tap an own unit = select it; with units selected, a tap anywhere else
   * (ground, enemy, a building to enter / repair / garrison) is an order. Own units only take
   * the tap on a direct hit while something is selected, so tapping next to a unit in a crowd
   * moves the selection instead of re-selecting. Double-tap a unit = all of its type on screen.
   */
  private tapSimple(x: number, y: number) {
    const units = this.selectedOwnUnits();
    const hadSel = this.renderer.selection.size > 0;
    // (escort mode wants a friendly unit under the finger: generous there)
    this.touchPick = units.length && this.mode !== 'guard' ? 'tight' : 'loose';
    try {
      if (this.mode === 'place' && this.placing) {
        this.click(x, y, false, false);
        return;
      }
      const target = this.pick(x, y);
      const now = performance.now();
      if (target && target.owner === this.local && target.kind === 'unit' && this.mode === 'normal' && now - this.lastClick.t < 450 && this.lastClick.id === target.id) {
        // double tap: every unit of that type on screen
        const ids = this.world.list.filter((e) => !e.dead && e.owner === this.local && e.def === target.def && e.inside < 0 && this.onScreen(e)).map((e) => e.id);
        this.select(ids);
        this.hud.flashUnits(ids, 'select');
        navigator.vibrate?.(8);
        this.lastClick = { t: 0, id: -1 };
        return;
      }
      this.lastClick = { t: now, id: target?.id ?? -1 };
      const a = this.contextAction(x, y, false);
      a.run();
      if (a.cursor === 'select' && target) {
        navigator.vibrate?.(6);
        if (target.owner === this.local && target.kind === 'unit') this.hud.flashUnits([target.id], 'select');
      } else if (a.cursor === 'nomove') this.nudge("Can't move there");
      else if (a.cursor === 'default' && !target && !hadSel) {
        // nothing selected and nothing under the finger: explain once in a while
        this.hud.tapRipple(x, y);
        this.nudge('Tap one of your units first, or press ARMY');
      }
    } finally {
      this.touchPick = null;
    }
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    if (this.briefing || this.intro || this.outro) {
      // briefing / intro / outro: any key skips the cinematic (the briefing handles its own keys)
      if (down && !e.repeat && this.intro) this.skipIntro();
      else if (down && !e.repeat && this.outro && e.key !== 'Escape') this.outro.skip();
      return;
    }
    if (down && this.cine.active) {
      this.cine.skip();
      return;
    }
    if (down && !e.repeat && (e.key === 'y' || e.key === 'Y') && !e.ctrlKey && !e.metaKey && !e.altKey && this.local >= 0 && !this.paused && !this.photo.active) {
      if ((e.target as HTMLElement)?.tagName !== 'INPUT') this.enterPhotoMode();
      return;
    }
    if (this.local < 0 || (this.paused && down)) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key;
    if (down) this.keys.add(k);
    else {
      this.keys.delete(k);
      return;
    }
    if (k.startsWith('Arrow')) {
      e.preventDefault();
      return;
    }
    const units = this.selectedOwnUnits();
    // control groups (Ctrl+N assign, Shift+N add, N select, NN centre) and Alt+A/S/D/F stances
    if (this.ctl.onKey(e)) return;
    const st = stanceForKey(e);
    if (st) {
      e.preventDefault();
      this.setStance(st);
      return;
    }
    switch (k.toLowerCase()) {
      case 'escape':
        if (this.mode !== 'normal') this.setMode('normal');
        else this.cb.onMenu();
        break;
      case 'p':
        this.toggleOrderMode('patrol');
        break;
      case 'g':
        this.toggleOrderMode('guard');
        break;
      case 'v': {
        const ou = orderable(units);
        if (ou.length) this.setStance(nextStance(ou));
        break;
      }
      case 's':
        if (units.length) {
          this.issue({ type: 'stop', ids: units.map((u) => u.id) });
          this.sfx('ack');
        }
        break;
      case 'a':
        if (units.length) this.setMode('attackMove');
        break;
      case 'd':
        if (units.length) this.issue({ type: 'deploy', ids: units.map((u) => u.id) });
        break;
      case 'w':
        this.onCommand('selectArmy');
        break;
      case 'q':
        this.rotateView(-1);
        break;
      case 't':
        this.modes.cycleThermal();
        break;
      case 'n':
        // atmos toggles night vision on N; thermal and night vision are exclusive
        this.modes.syncNightVision();
        break;
      case 'e':
        this.rotateView(1);
        break;
      case 'h': {
        const cy = this.world.list.find((b) => !b.dead && b.owner === this.local && b.kind === 'building');
        if (cy) this.renderer.centerOn(cy.x, cy.y);
        break;
      }
      case 'r':
        this.setMode(this.mode === 'repair' ? 'normal' : 'repair');
        break;
      case 'x':
        this.setMode(this.mode === 'sell' ? 'normal' : 'sell');
        break;
      case '+':
      case '=':
        this.renderer.setZoom(this.renderer.zoom * 1.15);
        break;
      case '-':
        this.renderer.setZoom(this.renderer.zoom / 1.15);
        break;
      case 'tab': {
        e.preventDefault();
        const order: Category[] = ['building', 'defense', 'infantry', 'vehicle', 'air'];
        this.hud.setTab(order[(order.indexOf(this.hud.tab) + 1) % order.length]);
        break;
      }
    }
  }

  /** Debug: advance the simulation instantly (events are dropped). */
  fastForward(seconds: number) {
    const n = Math.round((seconds * 1000) / TICK_MS);
    for (let i = 0; i < n && !this.world.over; i++) {
      this.world.step();
      this.world.drainEvents();
    }
  }

  // --------------------------------------------------------------- lifecycle

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    this.briefing?.destroy();
    this.briefing = null;
    this.card?.destroy();
    this.renderer.photoCam = null;
    for (const d of this.disposers) d();
    this.renderer.viewHook = null;
    this.photo.dispose();
    this.modes.dispose();
    this.renderer.dispose();
    this.audioScene.dispose();
    this.ctlUI?.destroy();
    this.cameos.paused = false;
    this.hud.destroy();
  }
}
