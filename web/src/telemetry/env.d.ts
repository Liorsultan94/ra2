/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** PostHog project API key (phc_...; public by design). Set from the repo variable POSTHOG_KEY in CI. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingestion host (default https://us.i.posthog.com; EU: https://eu.i.posthog.com). */
  readonly VITE_POSTHOG_HOST?: string;
}
