import { DEFS } from '../sim/defs';
import { TPS, type SimEvent } from '../sim/types';
import { trackError, trackMatchEnded, trackMatchStarted, trackPerfSample, trackTutorialStep, trackUiAction, type ClassCounts, type DeviceClass, type MatchEndedProps, type MatchResult, type MatchStartedProps } from './events';
import { FrameStats } from './perf';
import { telemetryActive } from './client';

/*
 * One battle's analytics: a purely observing, render-side tracker (like game/matchstats.ts).
 * It is fed the simulation events the game already drains and reads a few numbers off the
 * world once per frame (tick, credits). It never writes the world, never uses the sim RNG;
 * its clocks are performance.now() (render side). Sends match_started, perf_sample (about
 * 3 match minutes in, and at the end) and match_ended (win / loss / quit / crash; on page
 * hide with sendBeacon).
 */

/** What the tracker reads (a structural slice of World / AIController, so tests can fake it). */
export interface MatchWorldView {
  readonly tick: number;
  readonly players: readonly { readonly credits: number }[];
}

export interface AiStatsView {
  readonly stats: Readonly<Record<string, unknown>>;
  readonly react?: { readonly stats: Readonly<Record<string, number>> } | null;
}

export interface MatchTelemetryOptions {
  world: MatchWorldView;
  local: number;
  info: MatchStartedProps;
  device: DeviceClass;
  ai?: AiStatsView | null;
  /** Dynamic quality governor rung (0 = best). */
  qualityLevel?: () => number;
  /** Clock (ms); performance.now() by default. */
  now?: () => number;
}

const MID_SAMPLE_TICKS = TPS * 180;
const zero = (): ClassCounts => ({ infantry: 0, vehicle: 0, air: 0, naval: 0 });
const sum = (c: ClassCounts) => c.infantry + c.vehicle + c.air + c.naval;
const r1 = (v: number) => Math.round(v * 10) / 10;

function top5(m: Map<string, number>): [string[], number[]] {
  const s = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 5);
  return [s.map((x) => x[0]), s.map((x) => x[1])];
}

function unitClass(def: string): keyof ClassCounts | null {
  const d = DEFS[def];
  if (!d || d.kind !== 'unit') return null;
  if ((d as { temp?: boolean }).temp) return null;
  return d.category;
}

export class MatchTelemetry {
  private started = false;
  private done = false;
  private startedAt = 0;
  private builtBy = zero();
  private lostBy = zero();
  private killed = 0;
  private bBuilt = 0;
  private bLost = 0;
  private bDestroyed = 0;
  private mine = new Map<string, number>();
  private theirs = new Map<string, number>();
  private enemyBuilt = 0;
  private firstAttackTick = -1;
  private sw = 0;
  private lastCredits = NaN;
  private earned = 0;
  private spent = 0;
  private midSent = false;
  private lastFrameAt = 0;
  private lastLevel = -1;
  private levelChanges = 0;
  private levelCheckAt = 0;
  readonly fps = new FrameStats();
  private milestones = new Set<string>();
  private readonly now: () => number;
  private disposers: (() => void)[] = [];

  constructor(private o: MatchTelemetryOptions) {
    this.now = o.now ?? (() => performance.now());
    if (typeof window !== 'undefined') {
      // tab closed / navigated away mid-match: a final 'quit' with sendBeacon
      const onHide = () => this.finish('quit', true);
      window.addEventListener('pagehide', onHide);
      this.disposers.push(() => window.removeEventListener('pagehide', onHide));
    }
  }

  private get local() {
    return this.o.local;
  }

  private minute(tick = this.o.world.tick) {
    return r1(tick / TPS / 60);
  }

  /** Every drained simulation event (read only). */
  onEvent(ev: SimEvent) {
    if (this.done) return;
    const me = this.local;
    switch (ev.t) {
      case 'unitReady': {
        const c = unitClass(ev.def);
        if (!c) break;
        if (ev.owner === me) {
          this.builtBy[c]++;
          this.mine.set(ev.def, (this.mine.get(ev.def) ?? 0) + 1);
          this.milestone('first_unit', { unit: ev.def });
        } else if (ev.owner >= 0) {
          this.enemyBuilt++;
          this.theirs.set(ev.def, (this.theirs.get(ev.def) ?? 0) + 1);
        }
        break;
      }
      case 'placed':
        if (ev.owner === me) {
          this.bBuilt++;
          this.milestone('first_structure');
        }
        break;
      case 'deployed':
        if (ev.owner === me) {
          this.bBuilt++;
          this.milestone('mcv_deployed');
        }
        break;
      case 'death': {
        if (ev.kind === 'building') {
          if (ev.owner === me) this.bLost++;
          else if (ev.owner >= 0) this.bDestroyed++;
          break;
        }
        const c = unitClass(ev.def);
        if (!c) break;
        if (ev.owner === me) this.lostBy[c]++;
        else if (ev.owner >= 0) {
          this.killed++;
          if (this.killed === 1) this.milestone('first_kill');
        }
        break;
      }
      case 'underAttack':
        if (ev.owner === me && this.firstAttackTick < 0) this.firstAttackTick = this.o.world.tick;
        break;
      case 'superweapon':
        if (ev.owner === me && ev.phase === 'launch') {
          this.sw++;
          trackUiAction('superweapon', String(ev.sw));
        }
        break;
      case 'paradrop':
        if (ev.owner === me) trackUiAction('support_power', 'paradrop');
        break;
    }
  }

  private milestone(step: string, extra: Record<string, unknown> = {}) {
    if (this.milestones.has(step)) return;
    this.milestones.add(step);
    trackTutorialStep(step, { match_min: this.minute(), ...extra });
  }

  /** Once per rendered battle frame. */
  frame(paused = false) {
    if (this.done) return;
    const now = this.now();
    const w = this.o.world;
    if (!this.started) {
      if (w.tick <= 0) return;
      this.started = true;
      this.startedAt = now;
      trackMatchStarted(this.o.info);
    }
    if (!paused && this.lastFrameAt > 0) this.fps.add(now - this.lastFrameAt, now);
    this.lastFrameAt = now;
    // credits flow (income, refunds / production, building costs)
    const c = w.players[this.local]?.credits ?? 0;
    if (Number.isFinite(this.lastCredits)) {
      const d = c - this.lastCredits;
      if (d > 0) this.earned += d;
      else this.spent -= d;
    }
    this.lastCredits = c;
    if (now >= this.levelCheckAt && this.o.qualityLevel) {
      this.levelCheckAt = now + 1000;
      const lv = this.o.qualityLevel();
      if (this.lastLevel >= 0 && lv !== this.lastLevel) this.levelChanges++;
      this.lastLevel = lv;
    }
    if (!this.midSent && w.tick >= MID_SAMPLE_TICKS) {
      this.midSent = true;
      this.sendPerf('mid');
    }
  }

  /** The last frame time (ms, performance.now()); crash detection. */
  get lastFrame() {
    return this.lastFrameAt;
  }

  get running() {
    return this.started && !this.done;
  }

  private sendPerf(at: 'mid' | 'end', beacon = false) {
    const s = this.fps.summary();
    if (!s.frames) return;
    const mem = (typeof performance !== 'undefined' ? (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory : undefined)?.usedJSHeapSize;
    trackPerfSample(
      {
        at,
        match_min: this.minute(),
        ...s,
        quality: this.o.info.quality,
        quality_level: Math.max(0, this.lastLevel),
        quality_changes: this.levelChanges,
        heap_mb: mem ? Math.round(mem / 1048576) : undefined,
        device: this.o.device,
      },
      beacon,
    );
  }

  /** The match_ended payload (also used by tests). */
  endedProps(result: MatchResult): MatchEndedProps {
    const i = this.o.info;
    const [top, topN] = top5(this.mine);
    const [etop, etopN] = top5(this.theirs);
    let ai: Record<string, number> | undefined;
    const st = this.o.ai?.stats;
    if (st) {
      const n = (k: string) => (typeof st[k] === 'number' ? (st[k] as number) : 0);
      ai = { waves: n('waves'), pincers: n('pincers'), combined: n('combined'), marches: n('marches'), feints: n('feints'), retreats: n('retreats'), counters: n('counters'), first_wave_min: n('firstWave') >= 0 ? this.minute(n('firstWave')) : -1 };
      const rs = this.o.ai?.react?.stats;
      if (rs) for (const [k, v] of Object.entries(rs)) if (typeof v === 'number') ai['react_' + k] = v;
    }
    return {
      map: i.map,
      faction: i.faction,
      enemy: i.enemy,
      difficulty: i.difficulty,
      game_speed: i.game_speed,
      grace: i.grace,
      grace_min: i.grace_min,
      ai_count: i.ai_count,
      quality: i.quality,
      controls: i.controls,
      result,
      game_min: this.minute(),
      real_min: this.started ? r1((this.now() - this.startedAt) / 60000) : 0,
      first_attack_min: this.firstAttackTick >= 0 ? this.minute(this.firstAttackTick) : -1,
      units_built: { ...this.builtBy },
      units_lost: { ...this.lostBy },
      units_built_total: sum(this.builtBy),
      units_lost_total: sum(this.lostBy),
      units_killed: this.killed,
      buildings_built: this.bBuilt,
      buildings_lost: this.bLost,
      buildings_destroyed: this.bDestroyed,
      credits_earned: Math.round(this.earned),
      credits_spent: Math.round(this.spent),
      top_units: top,
      top_units_n: topN,
      enemy_top_units: etop,
      enemy_top_units_n: etopN,
      enemy_units_built: this.enemyBuilt,
      ai,
      superweapons_used: this.sw,
    };
  }

  /** Close the match once (later calls are ignored). `beacon`: the page is going away. */
  finish(result: MatchResult, beacon = false) {
    if (this.done) return;
    this.done = true;
    for (const d of this.disposers.splice(0)) d();
    if (!this.started || !telemetryActive()) return;
    // (match_ended first: on page hide the browser may drop the later beacon)
    trackMatchEnded(this.endedProps(result), beacon);
    this.sendPerf('end', beacon);
  }

  /**
   * An uncaught error or a lost WebGL context during the match: if the battle stops
   * rendering for a few seconds afterwards (while the tab is visible), it crashed.
   */
  suspectCrash(reason: string) {
    if (!this.running || typeof window === 'undefined') return;
    const at = this.now();
    window.setTimeout(() => {
      if (!this.running || (typeof document !== 'undefined' && document.hidden)) return;
      if (this.lastFrameAt < at) {
        trackError('fatal', 'battle stopped rendering after ' + reason);
        this.finish('crash');
      }
    }, 4000);
  }

  /** WebGL context lost on the battle canvas: an `error`, and a crash unless it comes back within 4 s. */
  watchCanvas(canvas: HTMLCanvasElement) {
    let lostAt = -1;
    const lost = () => {
      lostAt = this.now();
      trackError('webgl_context_lost', 'WebGL context lost');
      const at = lostAt;
      window.setTimeout(() => {
        if (lostAt === at && this.running) this.finish('crash');
      }, 4000);
    };
    const restored = () => (lostAt = -1);
    canvas.addEventListener('webglcontextlost', lost);
    canvas.addEventListener('webglcontextrestored', restored);
    this.disposers.push(() => {
      canvas.removeEventListener('webglcontextlost', lost);
      canvas.removeEventListener('webglcontextrestored', restored);
    });
  }

  dispose() {
    for (const d of this.disposers.splice(0)) d();
  }
}
