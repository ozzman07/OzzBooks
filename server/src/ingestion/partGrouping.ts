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

function isContiguousRun(numbers: number[]): boolean {
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
