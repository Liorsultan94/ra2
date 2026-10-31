import { capture, onConsentChange, telemetryActive } from './client';

/*
 * Typed analytics events (developer-only; docs/ANALYTICS.md). Every helper is a no-op
 * until the player allows analytics and a PostHog key is configured (client.ts).
 * Nothing here reads or writes the simulation: callers pass plain values.
 */

export type DeviceClass = 'phone' | 'tablet' | 'desktop';
export type MatchResult = 'win' | 'loss' | 'quit' | 'crash';

export interface AppLoadedProps {
  load_ms: number;
  device: DeviceClass;
  screen_w: number;
  screen_h: number;
  viewport_w: number;
  viewport_h: number;
  dpr: number;
  /** Settings choice ('auto' or a tier). */
  quality_setting: string;
  /** The tier actually used. */
  quality: string;
  controls: 'simple' | 'advanced';
  gpu?: string;
  mem_gb?: number;
  cores?: number;
}

export interface MatchStartedProps {
  map: string;
  faction: string;
  enemy: string[];
  difficulty: string;
  game_speed: string;
  /** Early-game grace setting ('auto', 'off', '3'...) and what it resolved to (minutes). */
  grace: string;
  grace_min: number;
  ai_count: number;
  quality: string;
  controls: 'simple' | 'advanced';
  credits: number;
  auto_defend: boolean;
}

export interface ClassCounts {
  infantry: number;
  vehicle: number;
  air: number;
  naval: number;
}

export interface MatchEndedProps extends Omit<MatchStartedProps, 'credits' | 'auto_defend'> {
  result: MatchResult;
  game_min: number;
  real_min: number;
  /** Match minute of the first enemy attack on the player (-1: none). */
  first_attack_min: number;
  units_built: ClassCounts;
  units_lost: ClassCounts;
  units_built_total: number;
  units_lost_total: number;
  units_killed: number;
  buildings_built: number;
  buildings_lost: number;
  buildings_destroyed: number;
  credits_earned: number;
  credits_spent: number;
  top_units: string[];
  top_units_n: number[];
  enemy_top_units: string[];
  enemy_top_units_n: number[];
  enemy_units_built: number;
  /** Enemy AI behaviour (sim/ai.ts / aireact.ts stats), absent when unavailable. */
  ai?: Record<string, number>;
  superweapons_used: number;
}

export interface PerfSampleProps {
  /** 'mid' (about 3 match minutes in) or 'end'. */
  at: 'mid' | 'end';
  match_min: number;
  avg_fps: number;
  min_fps: number;
  p5_fps: number;
  frame_ms_p95: number;
  frames: number;
  quality: string;
  /** Dynamic quality governor rung (0 = best) and how often it changed. */
  quality_level: number;
  quality_changes: number;
  heap_mb?: number;
  device: DeviceClass;
}

export type UiAction =
  | 'build_tab'
  | 'superweapon'
  | 'support_power'
  | 'control_group_set'
  | 'pause'
  | 'resume'
  | 'speed_change'
  | 'photo_mode'
  | 'thermal_view'
  | 'settings_open';

// ------------------------------------------------------------------ app_loaded

let appLoaded: AppLoadedProps | null = null;
let appLoadedSent = false;

/** Once per page load, when the main menu is up. Kept and sent later if the player allows analytics afterwards. */
export function trackAppLoaded(p: AppLoadedProps) {
  appLoaded = p;
  flushAppLoaded();
}

function flushAppLoaded() {
  if (!appLoaded || appLoadedSent || !telemetryActive()) return;
  appLoadedSent = true;
  capture('app_loaded', { ...appLoaded });
}

onConsentChange((c) => {
  if (c === 'granted') flushAppLoaded();
});

// ------------------------------------------------------------------ matches

export function trackMatchStarted(p: MatchStartedProps) {
  capture('match_started', { ...p });
}

/** `beacon`: the page is going away (tab closed / hidden for good): send at once with sendBeacon. */
export function trackMatchEnded(p: MatchEndedProps, beacon = false) {
  capture('match_ended', { ...p }, { beacon });
}

export function trackPerfSample(p: PerfSampleProps, beacon = false) {
  capture('perf_sample', { ...p }, { beacon });
}

// ------------------------------------------------------------------ ui_action

const UI_MIN_GAP_MS = 2000;
const UI_MAX_PER_SESSION = 150;
const uiLast = new Map<string, number>();
let uiCount = 0;

/** Key gameplay UI actions that autocapture cannot see (keys, canvas taps). Rate-limited per action. */
export function trackUiAction(action: UiAction, detail?: string, now = typeof performance !== 'undefined' ? performance.now() : Date.now()) {
  if (!telemetryActive()) return false;
  const k = action + ':' + (detail ?? '');
  if (now - (uiLast.get(k) ?? -1e12) < UI_MIN_GAP_MS || uiCount >= UI_MAX_PER_SESSION) return false;
  uiLast.set(k, now);
  uiCount++;
  capture('ui_action', detail === undefined ? { action } : { action, detail });
  return true;
}

// ------------------------------------------------------------------ tutorial / hints

const hintsSeen = new Set<string>();

/** Plain text of a hint (developer-authored strings), trimmed. */
export function hintText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

/** A tutorial milestone (first structure, first unit...) or an on-screen hint (each distinct hint once per session). */
export function trackTutorialStep(step: string, props: Record<string, unknown> = {}) {
  if (!telemetryActive()) return;
  // (hints: each text once per session; the per-match milestones are deduplicated by telemetry/match.ts)
  if (props.hint !== undefined) {
    const k = step + '|' + String(props.hint);
    if (hintsSeen.has(k)) return;
    hintsSeen.add(k);
  }
  capture('tutorial_step', { step, ...props });
}

// ------------------------------------------------------------------ errors

export interface ErrorContext {
  map?: string;
  match_min?: number;
  quality?: string;
}

const MAX_ERRORS = 20;
const STACK_MAX = 2048;
const errorsSeen = new Set<string>();
let errorCount = 0;
let errorCtx: () => ErrorContext = () => ({});

/** Where the game is (map, match minute, quality), attached to every error. */
export function setErrorContext(fn: () => ErrorContext) {
  errorCtx = fn;
}

/** One error (deduplicated by message within the session, at most 20 per session). Returns whether it was sent. */
export function trackError(kind: 'error' | 'unhandledrejection' | 'webgl_context_lost' | 'fatal', message: string, stack?: string): boolean {
  if (!telemetryActive()) return false;
  const msg = String(message || 'unknown').slice(0, 300);
  const key = kind + ':' + msg;
  if (errorsSeen.has(key) || errorCount >= MAX_ERRORS) return false;
  errorsSeen.add(key);
  errorCount++;
  let ctx: ErrorContext = {};
  try {
    ctx = errorCtx();
  } catch {
    /* ignore */
  }
  capture('error', { kind, message: msg, stack: stack ? String(stack).slice(0, STACK_MAX) : undefined, ...ctx });
  return true;
}

let installed = false;

/** window.onerror / unhandledrejection → `error` events (installed once at boot). */
export function installErrorHandlers(onAny?: () => void) {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    // resource load errors (an <img> 404) have no message: skip them
    if (!e.message && !e.error) return;
    const err = e.error as Error | undefined;
    trackError('error', e.message || err?.message || 'error', err?.stack ?? `${e.filename}:${e.lineno}:${e.colno}`);
    onAny?.();
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string; stack?: string } | string | undefined;
    // (the game's own build-abort rejections are caught; anything here is a real bug)
    trackError('unhandledrejection', typeof r === 'string' ? r : (r?.message ?? String(r)), typeof r === 'object' ? r?.stack : undefined);
    onAny?.();
  });
}

/** Tests: forget the per-session counters. */
export function __resetEventsForTests() {
  appLoaded = null;
  appLoadedSent = false;
  uiLast.clear();
  uiCount = 0;
  hintsSeen.clear();
  errorsSeen.clear();
  errorCount = 0;
  errorCtx = () => ({});
  onConsentChange((c) => {
    if (c === 'granted') flushAppLoaded();
  });
}
