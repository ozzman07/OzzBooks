// TEMPORARY diagnostic — remove once both bugs it's currently tracking
// are understood and fixed for good:
//  - the CarPlay stutter (plays a few words, goes silent, repeats — only
//    when routed through CarPlay, never through the phone's own speaker)
//  - stale local-storage reads/writes after the app sits backgrounded a
//    long time (events prefixed "progress:"/"db:" — see progressStore.ts,
//    reconcile.ts, db.ts, PlayerContext.tsx)
// Nobody can watch devtools while driving, or leave their phone plugged
// into devtools for hours of background listening, so this persists a
// capped ring buffer of events to localStorage instead of just logging to
// the console — survives both, checked afterward from Settings, which
// also offers filter presets to isolate one investigation from the other.
const STORAGE_KEY = 'ozzbooks_player_debug_log'
// Two concerns now share this one ring buffer (see above) — bumped up
// from the original 400 so a long background-listening session invest-
// igating the progress/db bug doesn't push every CarPlay entry out
// before anyone gets a chance to look, and vice versa.
const MAX_ENTRIES = 1000

export function logPlayerEvent(label: string, extra?: Record<string, unknown>): void {
  try {
    const entry = { t: new Date().toISOString(), label, ...extra }
    const existing: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    const log = Array.isArray(existing) ? existing : []
    log.push(entry)
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log.slice(-MAX_ENTRIES)))
  } catch {
    // Best-effort — losing a diagnostic entry isn't worth surfacing an error.
  }
}

export function readPlayerDebugLog(): string {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (!Array.isArray(raw)) return ''
    return raw
      .map((e: { t: string; label: string; [key: string]: unknown }) => {
        const { t, label, ...rest } = e
        const restStr = Object.entries(rest)
          .map(([k, v]) => `${k}=${v}`)
          .join(' ')
        return `${t.slice(11, 23)} ${label}${restStr ? `  ${restStr}` : ''}`
      })
      .join('\n')
  } catch {
    return ''
  }
}

export function clearPlayerDebugLog(): void {
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // no-op
  }
}
