/*
 * Developer analytics (PostHog) configuration. Players never see this data; it only
 * helps the developer balance the game and fix crashes / slow devices (docs/ANALYTICS.md).
 *
 * The key is read from the build env (VITE_POSTHOG_KEY / VITE_POSTHOG_HOST: the GitHub
 * Pages workflow passes the repo variables POSTHOG_KEY / POSTHOG_HOST), else from the
 * fallback below. A PostHog project key (phc_...) is public by design: it can only send
 * events, never read them. Without a key every telemetry call is a no-op (no network).
 */

/** Paste the PostHog project API key here (phc_...) if you don't use the repo variable. */
export const FALLBACK_POSTHOG_KEY = '';

/** PostHog region: US cloud. EU cloud: 'https://eu.i.posthog.com'. */
export const FALLBACK_POSTHOG_HOST = 'https://us.i.posthog.com';

/**
 * Session recording (replay). OFF: it is heavy on phones (DOM snapshots + a big extra
 * download). If it is ever enabled, every input is masked.
 */
export const RECORD_SESSIONS = false;

// (static property reads, so Vite inlines the values at build time)
const envKey = () => String(import.meta.env.VITE_POSTHOG_KEY ?? '').trim();
const envHost = () => String(import.meta.env.VITE_POSTHOG_HOST ?? '').trim();

/** The project key, '' when none is configured (telemetry off). */
export function posthogKey(): string {
  const k = envKey() || FALLBACK_POSTHOG_KEY.trim();
  return k.startsWith('phc_') ? k : '';
}

/** Ingestion host (no trailing slash). */
export function posthogHost(): string {
  return (envHost() || FALLBACK_POSTHOG_HOST).replace(/\/+$/, '');
}
