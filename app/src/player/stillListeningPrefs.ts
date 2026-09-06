export interface StillListeningPrefs {
  enabled: boolean
  /** Minutes of continuous, uninterrupted playback before a check-in fires. */
  idleMinutes: number
  /** Seconds to wait for any response before assuming the listener is asleep. */
  responseWindowSeconds: number
  /** How far back to rewind if nobody responds. */
  rewindSeconds: number
}

export const DEFAULT_STILL_LISTENING_PREFS: StillListeningPrefs = {
  enabled: true,
  idleMinutes: 20,
  responseWindowSeconds: 20,
  rewindSeconds: 120,
}

export const IDLE_MINUTES_MIN = 5
export const IDLE_MINUTES_MAX = 90
export const RESPONSE_WINDOW_MIN = 10
export const RESPONSE_WINDOW_MAX = 60
export const REWIND_SECONDS_MIN = 15
export const REWIND_SECONDS_MAX = 300

const STORAGE_KEY = 'ozzbooks_still_listening_prefs'

// Per-device, like theme/reader prefs — this is about one person's own
// listening habits (falling asleep in bed vs. driving with the phone
// mounted), not something to sync across a shared account.
export function loadStillListeningPrefs(): StillListeningPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_STILL_LISTENING_PREFS
    const parsed = JSON.parse(raw) as Partial<StillListeningPrefs>
    return sanitizeStillListeningPrefs({
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_STILL_LISTENING_PREFS.enabled,
      idleMinutes: parsed.idleMinutes ?? DEFAULT_STILL_LISTENING_PREFS.idleMinutes,
      responseWindowSeconds: parsed.responseWindowSeconds ?? DEFAULT_STILL_LISTENING_PREFS.responseWindowSeconds,
      rewindSeconds: parsed.rewindSeconds ?? DEFAULT_STILL_LISTENING_PREFS.rewindSeconds,
    })
  } catch {
    return DEFAULT_STILL_LISTENING_PREFS
  }
}

// Re-clamps a full prefs object — used both when reading a possibly-stale
// localStorage blob and when applying a live edit from the Settings form,
// since a typed (not spinner-dragged) number input doesn't enforce its own
// min/max.
export function sanitizeStillListeningPrefs(prefs: StillListeningPrefs): StillListeningPrefs {
  return {
    enabled: prefs.enabled,
    idleMinutes: clamp(prefs.idleMinutes, IDLE_MINUTES_MIN, IDLE_MINUTES_MAX, DEFAULT_STILL_LISTENING_PREFS.idleMinutes),
    responseWindowSeconds: clamp(
      prefs.responseWindowSeconds,
      RESPONSE_WINDOW_MIN,
      RESPONSE_WINDOW_MAX,
      DEFAULT_STILL_LISTENING_PREFS.responseWindowSeconds,
    ),
    rewindSeconds: clamp(
      prefs.rewindSeconds,
      REWIND_SECONDS_MIN,
      REWIND_SECONDS_MAX,
      DEFAULT_STILL_LISTENING_PREFS.rewindSeconds,
    ),
  }
}

export function saveStillListeningPrefs(prefs: StillListeningPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Storage full/unavailable (e.g. Safari private mode) — playback still
    // works, the preference just won't be remembered next time.
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
