export type ReadingDirection = 'ltr' | 'rtl'

const STORAGE_KEY = 'ozzbooks_comic_reader_direction'

// Per-device, not synced to the cloud account — same reasoning as
// readerPrefs.ts's font/theme prefs. Defaults to left-to-right: the real
// library here is Western comics (Dresden Files, Expanse), not manga.
export function loadReadingDirection(): ReadingDirection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw === 'rtl' ? 'rtl' : 'ltr'
  } catch {
    return 'ltr'
  }
}

export function saveReadingDirection(direction: ReadingDirection): void {
  try {
    localStorage.setItem(STORAGE_KEY, direction)
  } catch {
    // Storage full/unavailable — reading still works, just won't remember
    // the toggle next time.
  }
}
