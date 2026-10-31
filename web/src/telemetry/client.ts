import { posthogHost, posthogKey, RECORD_SESSIONS } from './config';
import { doNotTrack, loadConsent, saveConsent, type Consent } from './consent';

/*
 * The PostHog client, loaded lazily: the posthog-js chunk is only fetched (dynamic import)
 * once the player has allowed analytics AND a project key is configured, and the browser
 * does not send Do Not Track. Until then every call here is a cheap no-op: no network,
 * no posthog code, no errors. Calls made while the chunk loads are queued (a few dozen).
 *
 * Telemetry lives outside the deterministic simulation: it only ever reads game / UI
 * state, never writes the world, never touches the sim RNG.
 */

/** The slice of the posthog-js API used here (kept small so tests can mock it). */
export interface PostHogLike {
  init(key: string, config: Record<string, unknown>): unknown;
  capture(event: string, props?: Record<string, unknown>, opts?: Record<string, unknown>): unknown;
  register(props: Record<string, unknown>): void;
  opt_in_capturing(): void;
  opt_out_capturing(): void;
  has_opted_out_capturing(): boolean;
}

export type CaptureOpts = { beacon?: boolean };

type Loader = () => Promise<PostHogLike>;

const defaultLoader: Loader = () => import('posthog-js').then((m) => m.default as unknown as PostHogLike);

let loader: Loader = defaultLoader;
let consent: Consent = null;
let consentRead = false;
let ph: PostHogLike | null = null;
let loading: Promise<PostHogLike | null> | null = null;
let failed = false;
const queue: [string, Record<string, unknown>, CaptureOpts | undefined][] = [];
const MAX_QUEUE = 50;
const listeners: ((c: Consent) => void)[] = [];
/** Super properties registered on every event (app version, device class...). */
let superProps: Record<string, unknown> = {};

function currentConsent(): Consent {
  if (!consentRead) {
    consent = loadConsent();
    consentRead = true;
  }
  return consent;
}

/** True when events may be sent at all: allowed, a key exists, no Do Not Track. */
export function telemetryActive(): boolean {
  return currentConsent() === 'granted' && !!posthogKey() && !doNotTrack() && !failed;
}

/** The consent notice is worth showing: a key exists, nothing chosen yet, no Do Not Track. */
export function shouldAskConsent(): boolean {
  return currentConsent() === null && !!posthogKey() && !doNotTrack();
}

export function getConsent(): Consent {
  return currentConsent();
}

/** Analytics can be switched on here at all (a key is configured, the browser does not say Do Not Track). */
export function telemetryAvailable(): { key: boolean; dnt: boolean } {
  return { key: !!posthogKey(), dnt: doNotTrack() };
}

export function onConsentChange(fn: (c: Consent) => void): () => void {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** The player's choice (consent notice / Settings). Allow loads posthog; No stops all capture at once. */
export function setConsent(c: 'granted' | 'denied') {
  currentConsent();
  const changed = consent !== c;
  consent = c;
  saveConsent(c);
  if (c === 'granted') {
    if (ph) {
      if (ph.has_opted_out_capturing()) ph.opt_in_capturing();
    } else void ensureLoaded();
  } else {
    queue.length = 0;
    ph?.opt_out_capturing();
  }
  if (changed) for (const l of listeners.slice()) l(c);
}

/** posthog-js init options: anonymous, no IP, no text inputs, no recording, nothing external loaded. */
export function posthogConfig(): Record<string, unknown> {
  return {
    api_host: posthogHost(),
    // anonymous random id only: no person profiles, never identify()
    person_profiles: 'never',
    persistence: 'localStorage',
    respect_dnt: true,
    ip: false,
    // the SDK's own batching (request queue, flushes every few seconds and on page hide)
    request_batching: true,
    capture_pageview: true,
    capture_pageleave: false,
    // menus / buttons are autocaptured; text inputs never are (and their values never were)
    autocapture: {
      dom_event_allowlist: ['click'],
      element_allowlist: ['a', 'button', 'label'],
      css_selector_ignorelist: ['input', 'textarea', 'select', '[contenteditable]', '.ph-no-capture'],
      capture_copied_text: false,
    },
    rageclick: false,
    capture_dead_clicks: false,
    capture_heatmaps: false,
    capture_performance: false,
    capture_exceptions: false, // our own `error` event (dedupe + cap; errors.ts)
    mask_all_element_attributes: false, // (data-a="quick" etc. name the menu buttons; no input values are ever attributes here)
    disable_session_recording: !RECORD_SESSIONS,
    session_recording: { maskAllInputs: true, maskTextSelector: 'input, textarea' },
    disable_surveys: true,
    disable_product_tours: true,
    disable_conversations: true,
    disable_web_experiments: true,
    advanced_disable_flags: true,
    // no extra scripts from the PostHog CDN (recorder, surveys, toolbar...)
    disable_external_dependency_loading: !RECORD_SESSIONS,
    // strip any IP the SDK might attach; the project's "Discard client IP data" setting does the rest
    before_send: (ev: { properties?: Record<string, unknown> } | null) => {
      if (ev?.properties) delete ev.properties.$ip;
      return ev;
    },
  };
}

function ensureLoaded(): Promise<PostHogLike | null> {
  if (ph) return Promise.resolve(ph);
  if (loading) return loading;
  if (!telemetryActive()) return Promise.resolve(null);
  loading = loader()
    .then((p) => {
      if (!telemetryActive()) {
        // the player said no while the chunk loaded
        loading = null;
        return null;
      }
      p.init(posthogKey(), posthogConfig());
      // a "No" in an earlier session left posthog's own opt-out flag behind
      if (p.has_opted_out_capturing()) p.opt_in_capturing();
      p.register(superProps);
      ph = p;
      for (const [n, props, o] of queue.splice(0)) send(n, props, o);
      return p;
    })
    .catch((e) => {
      // blocked by an ad blocker / offline before the chunk was cached: stay quiet for the session
      failed = true;
      queue.length = 0;
      loading = null;
      console.warn('[telemetry] posthog unavailable', e);
      return null;
    });
  return loading;
}

function send(name: string, props: Record<string, unknown>, o?: CaptureOpts) {
  if (!ph) return;
  try {
    ph.capture(name, props, o?.beacon ? { transport: 'sendBeacon', send_instantly: true } : undefined);
  } catch {
    /* never let analytics break the game */
  }
}

/** Send one event (no-op without consent / key). */
export function capture(name: string, props: Record<string, unknown> = {}, o?: CaptureOpts) {
  if (!telemetryActive()) return;
  if (ph) {
    send(name, props, o);
    return;
  }
  if (queue.length < MAX_QUEUE) queue.push([name, props, o]);
  void ensureLoaded();
}

/** Properties sent with every event from now on. */
export function registerSuper(props: Record<string, unknown>) {
  superProps = { ...superProps, ...props };
  if (ph) {
    try {
      ph.register(props);
    } catch {
      /* ignore */
    }
  }
}

/** Start loading posthog now if allowed (e.g. at boot for a returning player who said yes). */
export function startTelemetry(): Promise<PostHogLike | null> {
  return ensureLoaded();
}

/** Tests: swap the posthog loader and forget all state. */
export function __resetTelemetryForTests(l?: Loader) {
  loader = l ?? defaultLoader;
  consent = null;
  consentRead = false;
  ph = null;
  loading = null;
  failed = false;
  queue.length = 0;
  listeners.length = 0;
  superProps = {};
}
