export type ReaderThemeName = 'eink' | 'dark' | 'sepia'

export interface ReaderPrefs {
  fontSizePct: number
  lineHeight: number
  theme: ReaderThemeName
}

export const DEFAULT_READER_PREFS: ReaderPrefs = {
  fontSizePct: 100,
  lineHeight: 1.5,
  theme: 'eink',
}

export const FONT_SIZE_MIN = 80
export const FONT_SIZE_MAX = 200
export const FONT_SIZE_STEP = 10

export const LINE_HEIGHT_OPTIONS: { value: number; label: string }[] = [
  { value: 1.3, label: 'Compact' },
  { value: 1.5, label: 'Normal' },
  { value: 1.8, label: 'Relaxed' },
]

export const READER_THEMES: Record<ReaderThemeName, { bg: string; fg: string; label: string }> = {
  eink: { bg: '#F2F0E9', fg: '#1A1A1A', label: 'E-ink' },
  dark: { bg: '#1A1A1A', fg: '#E8E6DF', label: 'Dark' },
  sepia: { bg: '#F4ECD8', fg: '#5B4636', label: 'Sepia' },
}

const STORAGE_KEY = 'ozzbooks_reader_prefs'

// Per-device, not synced to the cloud account — family members share the
// app but read on their own device, and different people wanting
// different text sizes/themes is the whole point of this feature, so
// there's no "one true setting" to sync across devices anyway.
export function loadReaderPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULT_READER_PREFS
    const parsed = JSON.parse(raw) as Partial<ReaderPrefs>
    return {
      fontSizePct: parsed.fontSizePct ?? DEFAULT_READER_PREFS.fontSizePct,
      lineHeight: parsed.lineHeight ?? DEFAULT_READER_PREFS.lineHeight,
      theme: parsed.theme && parsed.theme in READER_THEMES ? parsed.theme : DEFAULT_READER_PREFS.theme,
    }
  } catch {
    return DEFAULT_READER_PREFS
  }
}

export function saveReaderPrefs(prefs: ReaderPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs))
  } catch {
    // Storage full/unavailable (e.g. Safari private mode) — reading still
    // works, the preference just won't be remembered next time.
  }
}
