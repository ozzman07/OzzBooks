// TEMPORARY diagnostic — remove once the CarPlay stutter bug (plays a
// few words, goes silent, repeats — only when routed through CarPlay,
// never through the phone's own speaker) is understood. Nobody can watch
// devtools while driving, so this persists a capped ring buffer of
// player events to localStorage instead of just logging to the console —
// survives the drive, checked afterward from Settings.
const STORAGE_KEY = 'ozzbooks_player_debug_log'
const MAX_ENTRIES = 400

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
