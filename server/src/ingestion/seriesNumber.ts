// No real audiobook series in this library runs past ~40 entries — this
// ceiling is what safely rejects a bare 4+ digit number (almost always a
// year, not a series position — see the documented false positive this
// guards against: "Odyssey Series/1997 - 3001 The Final Odyssey" would
// otherwise misread either number as the book's place in the series).
export const MAX_PLAUSIBLE_SERIES_NUMBER = 200

// "#" doesn't get a \b guard — it's a non-word character, so \b never
// matches immediately before it at the start of a string (no left
// context to form the boundary), unlike the word-keyword alternatives.
const KEYWORD_NUMBER_RE = /(?:\b(?:book|vol\.?|volume|no\.?)|#)\s*(\d+(?:\.\d+)?)\b/i
const LEADING_NUMBER_RE = /^\s*(\d+(?:\.\d+)?)\b/

function isPlausible(n: number): boolean {
  return n > 0 && n <= MAX_PLAUSIBLE_SERIES_NUMBER
}

function lastWord(s: string): string {
  return s.trim().split(/\s+/).pop() ?? s
}

/**
 * Given a known series name and one of a book's own name candidates (its
 * folder name, or its filename minus extension — callers should try both,
 * since this library numbers one or the other inconsistently: confirmed
 * directly against real data that Reacher numbers the file while Dresden/
 * Ender's Saga/Codex Alera number the folder), finds this book's position
 * within the series.
 *
 * Three tiers, tried in order, each gated by the plausibility ceiling
 * above so nothing implausibly large is ever accepted.
 */
export function deriveSeriesNumberFromName(seriesName: string, bookOwnName: string): number | null {
  // Tier 1: an explicit, unambiguous marker — "Book 3", "#3", "Vol. 3".
  const keywordMatch = KEYWORD_NUMBER_RE.exec(bookOwnName)
  if (keywordMatch) {
    const n = Number(keywordMatch[1])
    if (isPlausible(n)) return n
  }

  // Tier 2: the number immediately following the series name itself,
  // wherever it appears — not necessarily a strict prefix. Also tries just
  // the series name's last word, since some real folder-naming echoes only
  // that ("Jack Reacher" the series, "Reacher 1 - Killing Floor" the file).
  for (const needle of [seriesName, lastWord(seriesName)]) {
    const idx = bookOwnName.toLowerCase().lastIndexOf(needle.toLowerCase())
    if (idx === -1) continue
    const after = bookOwnName.slice(idx + needle.length).replace(/^[\s,._:-]+/, '')
    const m = LEADING_NUMBER_RE.exec(after)
    if (m && isPlausible(Number(m[1]))) return Number(m[1])
  }

  // Tier 3: lowest confidence — a number as the very first token of the
  // whole name, or the first token right after its first separator
  // (catches "Lee Child - 01 Killing Floor", where the series name isn't
  // echoed in the book's own folder at all).
  const afterFirstSeparator = bookOwnName.split(/\s*[-:]\s*/, 2)[1]
  for (const candidate of [bookOwnName, afterFirstSeparator]) {
    if (!candidate) continue
    const m = LEADING_NUMBER_RE.exec(candidate)
    if (m && isPlausible(Number(m[1]))) return Number(m[1])
  }

  return null
}
