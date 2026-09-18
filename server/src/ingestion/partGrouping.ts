// Matches a trailing "Part N" / "Pt N" / "Disc N" / "CD N" marker (with or
// without surrounding parens), capturing everything before it in group 1 —
// used both to group same-book files together and to strip the marker back
// off the derived book title.
export const PART_MARKER_RE = /^(.*?)[\s,._-]*\(?\s*(?:part|pt|disc|cd)\.?\s*\d+\)?\s*$/i
// Same idea as PART_MARKER_RE but for the bare-trailing-number form, for
// stripping the marker back off a derived title once we already know (from
// groupM4bParts having formed a group) that the number really is a part
// marker rather than meaningful title text.
export const BARE_TRAILING_NUMBER_RE = /^(.*?)[\s,._-]+\d+\s*$/

const KEYWORD_RE = /^(.*?)[\s,._-]*\(?\s*(?:part|pt|disc|cd)\.?\s*(\d+)\)?\s*$/i
// A bare trailing number with no keyword (e.g. "The Blade Itself 1.m4b") is
// inherently more ambiguous — a genuine multi-book series could just as
// easily be numbered that way. The contiguous-run check in groupM4bParts is
// what keeps this safe: it only fires when 2+ files in the same folder
// share an identical base title and the numbers form an unbroken 1..N run.
const BARE_RE = /^(.*?)[\s,._-]+(\d+)\s*$/
const LEADING_TRACK_RE = /^\d+\s*[-.]?\s*/

function normalizeBase(filename: string): string {
  const withoutExt = filename.replace(/\.[^./]+$/, '')
  const withoutLeadingTrack = withoutExt.replace(LEADING_TRACK_RE, '')
  return withoutLeadingTrack.replace(/\s+/g, ' ').trim().toLowerCase()
}

function matchPart(filename: string, pattern: RegExp): { base: string; partNumber: number } | null {
  const m = pattern.exec(normalizeBase(filename))
  if (!m) return null
  return { base: m[1].replace(/\s+/g, ' ').trim(), partNumber: Number(m[2]) }
}

export function isContiguousRun(numbers: number[]): boolean {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b)
  if (sorted.length !== numbers.length) return false // had duplicates
  return sorted.every((n, i) => n === sorted[0] + i)
}

/**
 * Groups M4B filenames within one directory that are really parts of a
 * single book, so ingestion treats them as one book with N chapters
 * instead of N separate books (see Claude.md conversation: a bare `.m4b`
 * file becomes its own book by default, which is wrong for split-file
 * rips). Tries the unambiguous keyword form first ("Part N" etc.), then
 * falls back to a bare trailing number for whatever's left — but only
 * accepts a group when 2+ files share an identical base title AND their
 * numbers form a contiguous 1..N run, which is what keeps the bare-number
 * fallback from misgrouping an ordinary numbered series.
 */
export function groupM4bParts(filenames: string[]): { groups: string[][]; singles: string[] } {
  const remaining = new Set(filenames)
  const groups: string[][] = []

  for (const pattern of [KEYWORD_RE, BARE_RE]) {
    const buckets = new Map<string, { file: string; partNumber: number }[]>()
    for (const file of remaining) {
      const match = matchPart(file, pattern)
      if (!match) continue
      const bucket = buckets.get(match.base) ?? []
      bucket.push({ file, partNumber: match.partNumber })
      buckets.set(match.base, bucket)
    }

    // Some ripping tools leave the first part completely unnumbered and only
    // number the continuations (e.g. "Title.m4b" + "Title-1.m4b" — no
    // "Title-0.m4b"). Admit an otherwise-unmatched sibling whose whole
    // filename (no trailing number at all) exactly equals a bucket's base,
    // treating it as an implicit part 0. isContiguousRun's duplicate check
    // below safely rejects the group if more than one such file exists
    // (genuinely ambiguous), falling back to singles same as today.
    for (const [base, bucket] of buckets) {
      for (const file of remaining) {
        if (bucket.some((b) => b.file === file)) continue
        if (normalizeBase(file) === base) {
          bucket.push({ file, partNumber: 0 })
        }
      }
    }

    for (const bucket of buckets.values()) {
      if (bucket.length < 2) continue
      if (!isContiguousRun(bucket.map((b) => b.partNumber))) continue

      const sortedFiles = bucket.slice().sort((a, b) => a.partNumber - b.partNumber).map((b) => b.file)
      groups.push(sortedFiles)
      for (const f of sortedFiles) remaining.delete(f)
    }
  }

  return { groups, singles: [...remaining] }
}

/** Alias for grouping sibling directory names ("Disc 1"/"Disc 2", "CD1"/
 * "CD2") — identical matching/contiguity logic to grouping M4B filenames;
 * normalizeBase()'s extension-stripping is a harmless no-op on extensionless
 * directory names. Kept as one implementation, not a fork, so the two use
 * sites can't silently drift. */
export const groupSiblingFolders = groupM4bParts

// Requires " - N - " on BOTH sides (dash-space before AND after the
// number) — deliberately stricter than a bare separator, because this is
// what actually distinguishes a deliberate chapter-numbering convention
// from a number that's merely part of a title. Confirmed against real
// data: "Going Postal: ... Book 33 [B09M7FSBFC] - 01 - Opening Credits"
// has exactly one match position (the "33" in "Book 33" isn't followed by
// " - ", so it's never a candidate); "Jim Butcher - Dresden 1 - Strom
// Front" has a dash *after* the number but only a plain space *before*
// it ("Dresden 1"), so it correctly doesn't match at all — confirming
// real per-chapter rips use this as a deliberate delimiter, while a
// number embedded in prose text usually doesn't have a dash on both
// sides. 1-3 digits only, same reasoning as MAX_PLAUSIBLE_SERIES_NUMBER
// elsewhere: rejects a 4-digit year before it can even become a
// candidate.
const CHAPTER_RIP_RE = /^(.+)\s-\s(\d{1,3})\s-\s(.+)$/

// A real book title shared across every chapter file (see Going Postal
// above) is long — "DCC" (3 chars, the actual real-data case that would
// otherwise wrongly merge 8 separate Dungeon Crawler Carl novels sharing
// that prefix) is not. This threshold alone already rejects that case;
// the chapter-label check below is a second, independent line of
// defense against the same failure mode, not a redundant one — either
// check failing is enough to refuse the merge.
const CHAPTER_RIP_MIN_PREFIX_LENGTH = 15

// What comes after the number in a genuine chapter-per-file rip: either
// nothing/a bare number, or actual chapter-structure vocabulary. A real
// standalone book's title (confirmed real-data case: "Dungeon Crawler
// Carl", "The Gate of the Feral Gods", "Catching Fire") essentially never
// contains one of these words — a book *about* a prologue would be a
// strange coincidence, not a real risk seen in practice here.
const CHAPTER_LABEL_WORD_RE =
  /\b(?:chapter|part|prologue|epilogue|interlude|introduction|foreword|afterword|credits|acknowledge?ments?|dedication|preface|track|author'?s\s+notes?)\b/i

function looksLikeChapterLabel(suffix: string): boolean {
  const trimmed = suffix.trim()
  if (trimmed === '') return true
  if (/^\d+$/.test(trimmed)) return true
  return CHAPTER_LABEL_WORD_RE.test(trimmed)
}

/**
 * Groups M4B filenames that are really chapters of one book sharing a long,
 * specific, identical title prefix, differing only in an embedded
 * " - <number> - <chapter label>" segment (e.g. "Going Postal: Discworld,
 * Book 33 [B09M7FSBFC] - 01 - Opening Credits.m4b" through "... - 19 - End
 * Credits.m4b") — the shape groupM4bParts above does NOT cover, since that
 * one requires an (almost) identical base filename with only a *trailing*
 * part/disc marker, not a shared prefix with real differing content after
 * the number.
 *
 * This is deliberately much stricter than groupM4bParts, for a reason
 * discovered the hard way: a naive "shared prefix + number" match alone
 * is unsafe. Real-data counterexample: a folder of 8 separate Dungeon
 * Crawler Carl novels named "DCC - 1 - Dungeon Crawler Carl.m4b" through
 * "DCC - 8 - A Parade of Horribles.m4b" has the exact same shape (shared
 * prefix, contiguous number, differing suffix) but must NOT merge — doing
 * so once already corrupted real data (see
 * ozzbooks-google-drive-chapter-merge-fix memory). Two independent checks
 * guard against repeating that: the shared prefix must be long/specific
 * (CHAPTER_RIP_MIN_PREFIX_LENGTH — "DCC" is 3 characters, nowhere close),
 * and every file's suffix must look like an actual chapter/section label
 * (looksLikeChapterLabel) rather than an unrelated book title. Both must
 * pass, on every file in the group, or the group is rejected — never a
 * majority-vote or best-effort match. Contiguous 1..N numbering (same
 * isContiguousRun as groupM4bParts) is still required on top of both.
 */
export function groupChapterRipsByPrefix(filenames: string[]): { groups: string[][]; singles: string[] } {
  const remaining = new Set(filenames)
  const buckets = new Map<string, { file: string; num: number; suffix: string }[]>()

  for (const file of filenames) {
    const withoutExt = file.replace(/\.[^./]+$/, '')
    const match = CHAPTER_RIP_RE.exec(withoutExt)
    if (!match) continue
    const [, rawPrefix, numStr, rawSuffix] = match
    const prefix = rawPrefix.trim()
    if (prefix.length < CHAPTER_RIP_MIN_PREFIX_LENGTH) continue

    const key = prefix.toLowerCase()
    const bucket = buckets.get(key) ?? []
    bucket.push({ file, num: Number(numStr), suffix: rawSuffix.trim() })
    buckets.set(key, bucket)
  }

  const groups: string[][] = []
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    if (!isContiguousRun(bucket.map((b) => b.num))) continue
    // Accept two independent shapes of "this is safe": every suffix reads
    // as real chapter-structure vocabulary (the original rule), OR every
    // suffix in the group is exactly the same string. The second case
    // covers a generic repeated tag that isn't chapter vocabulary (a real
    // example: Discworld #27 "The Last Hero" tags every one of its 9 track
    // files "(enhanced)" — see groupParenthesizedTrackRips below for that
    // actual filename shape) — a per-book distinguishing title can never be
    // identical across every file in the folder, so requiring exact
    // equality here is just as safe as the keyword check, not a weaker
    // substitute for it. A bucket where suffixes differ but don't all pass
    // the keyword check (the DCC/Dresden shape) still correctly falls
    // through and is rejected.
    const allLookLikeChapters = bucket.every((b) => looksLikeChapterLabel(b.suffix))
    const allSuffixesIdentical = bucket.every((b) => b.suffix.toLowerCase() === bucket[0].suffix.toLowerCase())
    if (!allLookLikeChapters && !allSuffixesIdentical) continue

    const sorted = bucket
      .slice()
      .sort((a, b) => a.num - b.num)
      .map((b) => b.file)
    groups.push(sorted)
    for (const f of sorted) remaining.delete(f)
  }

  return { groups, singles: [...remaining] }
}

// Matches "<prefix> - <N> (<tag>)" — e.g. "DW27 - The Last Hero - 04
// (enhanced).m4a" — a distinct shape from CHAPTER_RIP_RE above: no second
// " - " delimiter, just a trailing parenthesized tag. Same 1-3 digit
// number as the other patterns.
const PARENTHESIZED_TRACK_RE = /^(.+)\s-\s(\d{1,3})\s*\(([^)]*)\)$/

/**
 * Groups M4B/M4A filenames that are really tracks of one book sharing a
 * long, specific, identical title prefix and a trailing parenthesized tag
 * — e.g. Discworld #27 "The Last Hero" split into 9 files each tagged
 * "(enhanced)". groupChapterRipsByPrefix above doesn't cover this shape:
 * there's no second " - " before the tag, and "enhanced" isn't chapter
 * vocabulary.
 *
 * Same two-signal safety discipline as groupChapterRipsByPrefix: a long,
 * specific shared prefix (CHAPTER_RIP_MIN_PREFIX_LENGTH) rules out a short
 * generic token like "DCC", and — since a generic technical tag like
 * "enhanced" has no fixed vocabulary to check against — every file's tag
 * must be *exactly identical* across the whole group. A real per-book
 * distinguishing subtitle could never repeat verbatim across every file in
 * the folder, so this is the direct equivalent of the keyword check, not a
 * looser stand-in for it. Contiguous 1..N numbering is still required.
 */
export function groupParenthesizedTrackRips(filenames: string[]): { groups: string[][]; singles: string[] } {
  const remaining = new Set(filenames)
  const buckets = new Map<string, { file: string; num: number; tag: string }[]>()

  for (const file of filenames) {
    const withoutExt = file.replace(/\.[^./]+$/, '')
    const match = PARENTHESIZED_TRACK_RE.exec(withoutExt)
    if (!match) continue
    const [, rawPrefix, numStr, rawTag] = match
    const prefix = rawPrefix.trim()
    if (prefix.length < CHAPTER_RIP_MIN_PREFIX_LENGTH) continue

    const key = prefix.toLowerCase()
    const bucket = buckets.get(key) ?? []
    bucket.push({ file, num: Number(numStr), tag: rawTag.trim().toLowerCase() })
    buckets.set(key, bucket)
  }

  const groups: string[][] = []
  for (const bucket of buckets.values()) {
    if (bucket.length < 2) continue
    if (!isContiguousRun(bucket.map((b) => b.num))) continue
    if (!bucket.every((b) => b.tag === bucket[0].tag)) continue

    const sorted = bucket
      .slice()
      .sort((a, b) => a.num - b.num)
      .map((b) => b.file)
    groups.push(sorted)
    for (const f of sorted) remaining.delete(f)
  }

  return { groups, singles: [...remaining] }
}

// Real case found in this library: an entire Discworld folder tree on
// Google Drive names each book's own folder "(#N) Title" — e.g. "(#16)
// Soul Music", "(#36) Making Money" — where N is the book's place in the
// series. Nothing extracted that number before now, so it stayed stuck as
// a literal, ugly prefix on the display title ("(#16) Soul Music" as the
// title, forever) instead of becoming series_number the way an ordinary
// "Series Name 16 - Title" folder already would (see
// deriveSeriesNumberFromName in scan.ts — a different, non-parenthesized
// convention that pattern doesn't cover). Deliberately narrow to exactly
// this "(#<digits>) " shape: a real book title essentially never starts
// with a literal "(#", so there's no realistic false-positive risk the way
// a bare leading number would carry.
const LEADING_INDEX_TAG_RE = /^\(#(\d{1,4})\)\s*(.+)$/

export function extractLeadingIndexTag(name: string): { title: string; index: number | null } {
  const match = LEADING_INDEX_TAG_RE.exec(name.trim())
  if (!match) return { title: name, index: null }
  return { title: match[2].trim(), index: Number(match[1]) }
}
