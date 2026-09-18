// Sanity-checks the dry-run output of backfill-series-numbers.ts before any
// of it gets applied. Open Library's edition series tags aren't always
// numbered consistently with each other — confirmed live: Asimov's
// "Second Foundation" (originally book 3 of the trilogy) has two editions
// both tagged "Foundation (5)", reflecting a later 7-book repackaging that
// counts prequels published decades afterward. Both editions agreeing with
// each other passed lookupSeriesNumber's own internal consensus check, but
// the number itself doesn't match this library's own numbering — so a
// second, cross-book pass here catches what a single-book lookup can't:
//
//  - a proposed number colliding with a number a DIFFERENT-titled book in
//    that series already has (folder/tag-derived, trusted) — e.g. James
//    Bond #2 proposed for "For Special Services" (a John Gardner
//    continuation novel) when "Live and Let Die" already correctly holds
//    #2 under Ian Fleming's original numbering
//  - the same number proposed for two different-titled books in one
//    series (real case: "Alex Cross #15" proposed for both "Alex Cross's
//    Trial" and "I, Alex Cross")
//  - a proposed number bigger than the total number of books this library
//    actually has in that series (existing-numbered + all candidates) —
//    can't be book 5 of a series we only have 3 books of; this is exactly
//    what catches the Second Foundation case
//
// Same-title matches are NOT flagged — a huge fraction of "collisions" and
// "duplicates" turned out to be a companion/duplicate copy of the exact
// same book (different UUID, same or near-identical title: a format
// variant, an alternate edition, a stray re-scan) legitimately getting the
// same number as its sibling. coreTitle() below normalizes past the
// superficial differences seen live: case ("Op-Center" / "Op-center"),
// a trailing parenthetical ("Mort" / "Mort (#4)", "A Wizard of Earthsea" /
// "... (1968)"), and a colon-attached series/book suffix ("Hogfather" /
// "Hogfather: Discworld, Book 20").
//
// Anything that still doesn't resolve to a same-title match is left out of
// the "safe to apply" list entirely rather than guessed at — same as the
// rest of this session's series work, missing is better than wrong.
//
// Run with: OZZBOOKS_DATA_DIR=... npx tsx scripts/check-series-number-proposals.ts <dry-run-log-path>
import { readFileSync } from 'node:fs'
import { getDb } from '../src/db/index.js'
import { logActivity } from '../src/db/activityLog.js'

const PROPOSAL_RE = /^(.+?) #(\d+(?:\.\d+)?) — (.+) \(([0-9a-f-]{36})\)$/

// Confirmed live and manually verified wrong, not caught by any check
// above: this library owns all 7 Foundation books (14 rows — 2 copies
// each), so the GAP check's "explain the gap by remaining unresolved
// candidates" logic wrongly treats the 4 still-unmatched prequels/sequels
// as enough slack to explain skipping 3 and 4 — when the real reason is
// that two Open Library editions tag it "Foundation (5)" under a later
// 7-book repackaging that counts the prequels first, not that this
// library is missing volumes. Second Foundation is book 3 of the original
// trilogy, not 5. A short, explicit list rather than a more general
// algorithm — every other check in this file is principled and generic;
// this one case needed a human to actually verify Asimov's real
// publication order against what Open Library's edition data disagreed
// with itself about.
const MANUALLY_EXCLUDED_BOOK_IDS = new Set<string>([
  'd268419f-e910-4ce7-a034-af5625734860', // Second Foundation
  '46e68c8a-aa2d-486e-9037-25a27109e9ff', // Second Foundation (duplicate copy)
])

// "James Bond" is excluded as a whole family (every series_name starting
// with it), not case by case — the phrase itself is too common to
// validate reliably. Real cases confirmed live: a French edition's series
// tag "La jeunesse de James Bond -- 1" ("The Youth of James Bond", a
// Young Bond spinoff) contains both "james" and "bond" as words, clearing
// even the 2-shared-word threshold against our own "James Bond - Raymond
// Benson" tag and wrongly attaching #1 to Charlie Higson's "Silverfin"
// (nothing to do with Benson at all). Separately, the flat "James Bond"
// tag mixes at least two incompatible numbering conventions across
// different continuation authors (Fleming's original books vs. Gardner's
// vs. an aggregate cross-author count some editions use) — several of
// those already surfaced as genuine COLLISIONs below, which is itself
// evidence this whole franchise's Open Library data isn't reliable enough
// for this backfill, not just the one Silverfin case caught by chance.
const EXCLUDED_SERIES_PREFIXES = ['James Bond']

interface Proposal {
  series: string
  number: number
  title: string
  bookId: string
}

function parseProposals(logPath: string): Proposal[] {
  const lines = readFileSync(logPath, 'utf-8').split('\n')
  const proposals: Proposal[] = []
  for (const line of lines) {
    const match = PROPOSAL_RE.exec(line.trim())
    if (!match) continue
    proposals.push({ series: match[1], number: Number(match[2]), title: match[3], bookId: match[4] })
  }
  return proposals
}

function coreTitle(title: string): string {
  return title
    .split(/[:(]/)[0]
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(the|a|an)\s+/, '')
    .trim()
}

// Word-level overlap, not substring containment — a naive substring check
// would wrongly match short titles against unrelated longer ones sharing a
// fragment ("Mort" is a substring of "Mortal Instruments"). Same threshold
// companionLink.ts's hasTitleOverlap already uses: 2+ shared words, or one
// title's whole word set contained in the other's (handles a short
// single-word title like "Mort" against its own parenthetical-suffixed
// variant "Mort (#4)").
//
// Series-name words are excluded from the comparison first — real case
// caught before this shipped: "Witch World" titles routinely embed the
// series name itself ("The Magestone - Witch World - The Turning 06",
// "Web Of The Witch World"), so two genuinely DIFFERENT books both share
// "witch"/"world"/"the" and clear the overlap threshold on nothing but
// series-name noise. Falls back to the un-stripped word sets whenever
// stripping would empty out either side entirely (a title that's little
// more than the series name itself, e.g. "The Final Empire" against
// "Mistborn - The Final Empire - Graphic Audio" parts of the same
// production) — there, the series-name overlap IS the actual signal.
function titlesMatch(a: string, b: string, seriesName: string): boolean {
  const seriesWords = new Set(coreTitle(seriesName).split(' ').filter(Boolean))
  const stripSeriesWords = (words: Set<string>): Set<string> => {
    const stripped = [...words].filter((w) => !seriesWords.has(w))
    return stripped.length > 0 ? new Set(stripped) : words
  }
  const wordsA = stripSeriesWords(new Set(coreTitle(a).split(' ').filter(Boolean)))
  const wordsB = stripSeriesWords(new Set(coreTitle(b).split(' ').filter(Boolean)))
  if (wordsA.size === 0 || wordsB.size === 0) return false
  const overlap = [...wordsA].filter((w) => wordsB.has(w)).length
  if (overlap >= 2) return true
  const [smaller, larger] = wordsA.size <= wordsB.size ? [wordsA, wordsB] : [wordsB, wordsA]
  return [...smaller].every((w) => larger.has(w))
}

function main() {
  const logPath = process.argv[2]
  if (!logPath) {
    console.error('Usage: check-series-number-proposals.ts <dry-run-log-path>')
    process.exit(1)
  }

  const allProposals = parseProposals(logPath)
  const excludedSeriesCount = allProposals.filter((p) =>
    EXCLUDED_SERIES_PREFIXES.some((prefix) => p.series.startsWith(prefix)),
  ).length
  const proposals = allProposals.filter((p) => !EXCLUDED_SERIES_PREFIXES.some((prefix) => p.series.startsWith(prefix)))
  console.log(`Parsed ${allProposals.length} proposal(s) from ${logPath}`)
  console.log(`Excluded ${excludedSeriesCount} proposal(s) from whole-series exclusions (${EXCLUDED_SERIES_PREFIXES.join(', ')})\n`)

  const db = getDb()
  const bySeriesTotalCount = new Map<string, number>()
  const bySeriesExisting = new Map<string, { number: number; title: string }[]>()
  for (const series of new Set(proposals.map((p) => p.series))) {
    const total = (db.prepare('SELECT count(*) as c FROM books WHERE status = ? AND series_name = ?').get('active', series) as { c: number }).c
    bySeriesTotalCount.set(series, total)
    const existing = db
      .prepare("SELECT series_number, title FROM books WHERE status = 'active' AND series_name = ? AND series_number IS NOT NULL")
      .all(series) as { series_number: number; title: string }[]
    bySeriesExisting.set(series, existing.map((r) => ({ number: r.series_number, title: r.title })))
  }

  const accepted: Proposal[] = []
  const reasons: string[] = []

  // Same proposed number, multiple different books, within one series.
  const proposedBySeriesNumber = new Map<string, Proposal[]>()
  for (const p of proposals) {
    const key = `${p.series} ${p.number}`
    const list = proposedBySeriesNumber.get(key) ?? []
    list.push(p)
    proposedBySeriesNumber.set(key, list)
  }

  const rejected = new Set<string>(MANUALLY_EXCLUDED_BOOK_IDS)

  for (const list of proposedBySeriesNumber.values()) {
    if (list.length < 2) continue
    const allSameTitle = list.every((p) => titlesMatch(p.title, list[0].title, list[0].series))
    if (allSameTitle) continue // legitimate duplicate copies of the same book — fine, both get the number
    reasons.push(`DUPLICATE: ${list[0].series} #${list[0].number} proposed for ${list.length} different-titled books:`)
    for (const p of list) {
      reasons.push(`  - ${p.title} (${p.bookId})`)
      rejected.add(p.bookId)
    }
  }

  for (const p of proposals) {
    if (rejected.has(p.bookId)) continue
    const existing = bySeriesExisting.get(p.series)!
    const sameNumberHolders = existing.filter((e) => e.number === p.number)
    if (sameNumberHolders.length > 0 && !sameNumberHolders.some((e) => titlesMatch(e.title, p.title, p.series))) {
      reasons.push(
        `COLLISION: ${p.series} #${p.number} — "${p.title}" (${p.bookId}) conflicts with existing "${sameNumberHolders[0].title}"`,
      )
      rejected.add(p.bookId)
      continue
    }

    const total = bySeriesTotalCount.get(p.series)!
    // The ceiling is whichever is larger: how many books we actually have
    // in the series, or the highest number we already trust — a library
    // can legitimately have sparse/gapped numbering (owns books 1-3 and 7
    // of a 10-book series, existing max already 7 despite only 4 books on
    // hand), and that must never itself get flagged as "too high."
    const existingMax = existing.length > 0 ? Math.max(...existing.map((e) => e.number)) : 0
    const ceiling = Math.max(total, existingMax)
    if (p.number > ceiling) {
      reasons.push(`OUT OF RANGE: ${p.series} #${p.number} — "${p.title}" (${p.bookId}) exceeds this library's own ceiling of ${ceiling}`)
      rejected.add(p.bookId)
    }
  }

  for (const p of proposals) if (!rejected.has(p.bookId)) accepted.push(p)

  // Internal-gap check, restricted to small series (<=10 total books).
  // Catches what the checks above structurally can't: Open Library's
  // "Second Foundation" mistagged as "Foundation (5)" (a later 7-book
  // repackaging counting prequels published decades afterward) passed
  // every check above — nothing else claims #5, and 5 doesn't exceed the
  // 6-book ceiling (3 titles, each present as 2 duplicate copies) — but
  // resolving all 3 Foundation titles to {1, 2, 5} leaves an unexplained
  // 2-wide gap (3, 4) with no remaining unresolved candidate left to fill
  // it, which is the actual tell. Restricted to small series because a
  // single missing volume in a 20-book series a person simply doesn't own
  // yet (Aubrey-Maturin's real #15, absent from this library entirely) is
  // completely normal and must never be flagged as suspicious the same
  // way — the smaller a series, the less plausible an unexplained
  // multi-book gap becomes.
  const SMALL_SERIES_CEILING = 10
  const acceptedBySeries = new Map<string, Proposal[]>()
  for (const p of accepted) {
    const list = acceptedBySeries.get(p.series) ?? []
    list.push(p)
    acceptedBySeries.set(p.series, list)
  }
  for (const [series, list] of acceptedBySeries) {
    const total = bySeriesTotalCount.get(series)!
    if (total > SMALL_SERIES_CEILING) continue
    const existing = bySeriesExisting.get(series)!
    const resolvedNumbers = new Set([...existing.map((e) => e.number), ...list.map((p) => p.number)])
    const sorted = [...resolvedNumbers].sort((a, b) => a - b)
    const stillUnresolvedCount = total - resolvedNumbers.size
    let gapSize = 0
    for (let i = 1; i < sorted.length; i++) gapSize += sorted[i] - sorted[i - 1] - 1
    if (gapSize > stillUnresolvedCount) {
      reasons.push(
        `GAP: "${series}" resolves to {${sorted.join(', ')}} — a gap of ${gapSize} with only ${stillUnresolvedCount} unresolved book(s) left to explain it; holding back this series' ${list.length} proposal(s)`,
      )
      for (const p of list) rejected.add(p.bookId)
    }
  }

  const finalAccepted = accepted.filter((p) => !rejected.has(p.bookId))
  finalAccepted.sort((a, b) => a.series.localeCompare(b.series) || a.number - b.number)

  console.log(`${reasons.length ? reasons.join('\n') + '\n' : ''}`)
  console.log('ACCEPTED:')
  for (const p of finalAccepted) console.log(`  ${p.series} #${p.number} — ${p.title} (${p.bookId})`)
  console.log(`\n${finalAccepted.length} of ${proposals.length} proposal(s) pass all checks and are safe to apply.`)
  console.log(`${rejected.size} rejected — left as missing rather than guessed.`)

  if (process.argv.includes('--apply')) {
    let applied = 0
    for (const p of finalAccepted) {
      const result = db
        .prepare("UPDATE books SET series_number = ?, series_number_source = 'manual' WHERE id = ? AND series_number IS NULL")
        .run(p.number, p.bookId)
      if (result.changes > 0) {
        applied++
        logActivity(p.bookId, p.title, null, 'metadata_updated', `Backfilled series number from Open Library: #${p.number}`)
      }
    }
    console.log(`\nApplied ${applied} update(s).`)
  }
}

main()
