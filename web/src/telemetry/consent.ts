/*
 * The analytics on/off state (always on in the game; tests switch it), kept in its own
 * localStorage key. null = never changed (treated as on, telemetry/client.ts); 'denied' = switched off.
 */

export type Consent = 'granted' | 'denied' | null;

export const CONSENT_KEY = 'ironfront.analytics.v1';

export function loadConsent(): Consent {
  try {
    const v = localStorage.getItem(CONSENT_KEY);
    return v === 'granted' || v === 'denied' ? v : null;
  } catch {
    return null;
  }
}

export function saveConsent(c: 'granted' | 'denied') {
  try {
    localStorage.setItem(CONSENT_KEY, c);
  } catch {
    /* storage unavailable: the choice lasts this session */
  }
}

/** Browser "Do Not Track" / Global Privacy Control: respected as a permanent no. */
export function doNotTrack(): boolean {
  try {
    const n = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { msDoNotTrack?: string; globalPrivacyControl?: boolean };
    const w = (typeof window !== 'undefined' ? window : {}) as { doNotTrack?: string };
    const v = n.doNotTrack ?? w.doNotTrack ?? n.msDoNotTrack;
    return v === '1' || v === 'yes' || n.globalPrivacyControl === true;
  } catch {
    return false;
  }
}
