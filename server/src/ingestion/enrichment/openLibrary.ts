import { mapToControlledGenre } from './genreOptions.js'

const SEARCH_ENDPOINT = 'https://openlibrary.org/search.json'
const COVERS_ENDPOINT = 'https://covers.openlibrary.org/b/id'
// Identifies the app per Open Library's stated policy (required for the
// higher 3 req/sec tier — this still throttles to 1 req/sec regardless,
// see paceRequest, to stay clearly inside "not hundreds of single-book
// requests" rather than maximizing the allowed rate).
const USER_AGENT = 'OzzBooks/1.0 (jim@osbornville.com)'
const MIN_REQUEST_INTERVAL_MS = 1000
// A real spot-check against Open Library's search endpoint (this session)
// consistently came back in well under 2 seconds. 8s is comfortably above
// any normal response — including a slightly slow one — while still
// bounding the worst case to a single short wait: enrichBooks stops after
// the *first* request that hits this, rather than letting a real outage
// or degradation run out the clock on every remaining book in the batch.
const REQUEST_TIMEOUT_MS = 8000

/** Thrown for a connectivity-level failure — timeout, network error, or a
 * non-2xx search response — as opposed to a normal "no match" outcome.
 * Callers (enrichBooks, run unattended as part of the nightly reindex)
 * use this to tell "Open Library isn't available right now" apart from
 * "this specific book has no confident match," so an outage stops the
 * batch early instead of grinding through the rest of a large backlog
 * with the same failure repeating on every remaining book. */
export class OpenLibraryUnavailableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'OpenLibraryUnavailableError'
  }
}

// Real case: a single timeout after 639 books had already been
// successfully processed stopped an entire ~6000-book overnight backfill
// dead, with nobody around to notice and restart it — enrichBooks (by
// design) treats any OpenLibraryUnavailableError as "stop the whole
// batch," which is the right call for a genuine sustained outage but far
// too costly for one transient blip. Retrying a few times with backoff
// here, underneath that policy, means only a real outage still stops the
// batch — a lone hiccup now just costs a few extra seconds on that one
// request instead of losing the rest of an unattended overnight run.
const MAX_RETRY_ATTEMPTS = 3
const BASE_RETRY_DELAY_MS = 2000

function retryDelayMs(attempt: number): number {
  const exponential = BASE_RETRY_DELAY_MS * 2 ** attempt
  return exponential + Math.random() * exponential * 0.5
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Retries only a transient OpenLibraryUnavailableError (timeout, network
 * error, non-2xx) — any other error is a bug in our own code, not
 * something backing off will fix, so it's rethrown immediately. After
 * MAX_RETRY_ATTEMPTS the error is still rethrown as-is, so a genuine
 * sustained outage correctly reaches enrichBooks as "stop the batch." */
async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < MAX_RETRY_ATTEMPTS; i++) {
    try {
      return await attempt()
    } catch (err) {
      lastErr = err
      if (!(err instanceof OpenLibraryUnavailableError) || i === MAX_RETRY_ATTEMPTS - 1) throw err
      const delay = retryDelayMs(i)
      console.warn(`Open Library request retry ${i + 1}/${MAX_RETRY_ATTEMPTS} after failure, waiting ${Math.round(delay)}ms:`, err)
      await sleep(delay)
    }
  }
  throw lastErr
}

// At least this many significant words (title + author combined) must
// match before a candidate is trusted — below this, skip rather than
// risk attaching a wrong genre/cover to a book.
const MIN_MATCH_SCORE = 2

// Same normalization approach as relink.ts's findRelinkCandidates —
// proven useful there for the same shape of problem (fuzzy string
// matching against real-world messy titles).
function normalizeWords(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 2)
}

// Module-level so both searchWork and fetchCover share one pacing gate —
// a single book can need both, and Open Library's rate limit is per
// request, not per book.
let lastRequestAt = 0

async function paceRequest(): Promise<void> {
  const elapsed = Date.now() - lastRequestAt
  if (elapsed < MIN_REQUEST_INTERVAL_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_REQUEST_INTERVAL_MS - elapsed))
  }
  lastRequestAt = Date.now()
}

// Open Library's own data is inconsistent about this field's shape across
// records — sometimes a plain string, sometimes a text-type object with a
// `value` — both are handled by normalizeDescription below.
type OpenLibraryDescription = string | { value?: string } | undefined

interface OpenLibrarySearchDoc {
  key?: string
  title?: string
  author_name?: string[]
  subject?: string[]
  cover_i?: number
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibrarySearchDoc[]
}

export interface OpenLibraryMatch {
  genre: string | null
  coverId: number | null
  synopsis: string | null
  series: string | null
}

// Open Library sometimes tags a work's subject list with its series
// (confirmed live: "series:Dungeon Crawler Carl", "Series:Six-of-Crows" —
// casing of the "series:" prefix itself is inconsistent, hence /i). This
// is best-effort, NOT comprehensive — confirmed live that plenty of very
// real series (The Hunger Games, Jim Butcher's Dresden Files) have no
// series-tagged subject at all, so this only ever fills in a subset.
// First match wins when a work lists more than one (e.g. a duology's own
// series alongside its parent universe, "Six-of-Crows" +
// "Grishaverse") — no principled way to prefer one over the other from
// this data alone, and guessing wrong once already cost real data
// correctness today (see ozzbooks-google-drive-chapter-merge-fix memory)
// — so this takes whichever the source lists first rather than adding a
// new heuristic. Hyphens are only converted to spaces when the whole tag
// has no spaces of its own ("Six-of-Crows" -> "Six of Crows") — a tag
// that already mixes hyphens and spaces is left as-is rather than
// guessing which hyphens are word separators.
const SERIES_SUBJECT_RE = /^series:(.+)$/i

function extractSeries(subjects: string[] | undefined): string | null {
  if (!subjects) return null
  for (const subject of subjects) {
    const match = SERIES_SUBJECT_RE.exec(subject.trim())
    if (!match) continue
    const raw = match[1].trim()
    if (!raw) continue
    return raw.includes(' ') ? raw : raw.replace(/-/g, ' ')
  }
  return null
}

function normalizeDescription(description: OpenLibraryDescription): string | null {
  if (typeof description === 'string') return description.trim() || null
  if (description && typeof description.value === 'string') return description.value.trim() || null
  return null
}

function matchScore(queryTitle: string, queryAuthor: string, doc: OpenLibrarySearchDoc): number {
  const targetWords = new Set([...normalizeWords(queryTitle), ...normalizeWords(queryAuthor)])
  const candidateWords = new Set([
    ...normalizeWords(doc.title ?? ''),
    ...normalizeWords((doc.author_name ?? []).join(' ')),
  ])
  let score = 0
  for (const w of targetWords) if (candidateWords.has(w)) score++
  return score
}

/**
 * Searches Open Library by (cleaned) title + author and returns the
 * best-scoring candidate, or null if nothing meets MIN_MATCH_SCORE —
 * Open Library's own relevance ranking doesn't know our match-confidence
 * rules, so every returned doc is scored, not just the first.
 */
async function runSearch(title: string, author: string | null): Promise<OpenLibrarySearchDoc[]> {
  await paceRequest()

  // The fielded `title=` param does a strict/near-exact match against Open
  // Library's title field — it 404s-to-empty on perfectly real titles that
  // carry any extra text (e.g. a series-number prefix baked into the
  // filename-derived title, "Dark Tower VI: Song Of Susannah" finds
  // nothing, but the general-purpose `q=` param finds "Song of Susannah"
  // immediately). `q=` is used for the title text for this reason; author
  // stays a separate fielded param rather than folded into `q=` — Open
  // Library's search backend treats a leading `-` in a query token as an
  // exclusion operator, so appending raw " - Author Name" text into one
  // combined query string (as this used to do) could silently exclude the
  // correct result. `subject` isn't returned by default, hence `fields=`.
  //
  // `description` is deliberately NOT requested here — confirmed live
  // (2026-09-12) that Open Library's search.json 500s whenever `description`
  // is combined with any other field in `fields=` (it's fine completely
  // alone, just not mixed in) — a live bug on their side, not a client
  // request-shape issue, but one that was silently aborting every single
  // nightly enrichment run before this was found (every book's search hit
  // this 500, treated as "Open Library unavailable," so metadata
  // enrichment had never successfully processed a single book). `key` is
  // requested instead — searchWork uses it for a separate, working
  // follow-up request (fetchWorkDescription) to get the synopsis only for
  // the one confirmed best-matching doc, not for all 5 candidates.
  const params = new URLSearchParams({
    q: title,
    limit: '5',
    fields: 'key,title,author_name,subject,cover_i',
  })
  if (author) params.set('author', author)

  const body = await withRetry(async () => {
    let res: Response
    try {
      res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (err) {
      throw new OpenLibraryUnavailableError('Open Library search request failed or timed out', { cause: err })
    }
    if (!res.ok) {
      // A 4xx means Open Library rejected the request itself — real case
      // found in production: cleanTitleForSearch's series-prefix-stripping
      // heuristic can, for a pathological box-set title ("...Books 1 - 4
      // (... Box Sets) (Unabridged)"), reduce the query down to a bare "4",
      // which Open Library's search 422s on deterministically, every time.
      // Retrying or waiting never fixes a 4xx the way it can a 5xx/timeout,
      // and treating it as "unavailable" would permanently deadlock the
      // entire rest of the enrichment queue behind this one unmatchable
      // book forever, since OpenLibraryUnavailableError is deliberately
      // never stamped as attempted and this book is always first in line.
      // Log it for visibility, but let searchWork treat it exactly like a
      // legitimate "no results" response instead.
      if (res.status >= 400 && res.status < 500) {
        console.warn(`Open Library rejected the search request (${res.status} for "${title}"), treating as no match`)
        return { docs: [] }
      }
      throw new OpenLibraryUnavailableError(`Open Library search failed: ${res.status} ${res.statusText}`)
    }
    return (await res.json()) as OpenLibrarySearchResponse
  })
  return body.docs ?? []
}

/** Shared by searchWork and lookupSeriesNumber — runs the search (retrying
 * title-only if an author-filtered search comes back empty, see the retry
 * comment inline) and picks the best-scoring candidate, or null if nothing
 * meets MIN_MATCH_SCORE. */
async function findBestMatch(title: string, author: string | null): Promise<OpenLibrarySearchDoc | null> {
  let docs = await runSearch(title, author)

  // Unlike a normal ranking signal, Open Library's `author` param is a
  // strict filter — it zeroes out results entirely rather than just
  // de-prioritizing a mismatch. Found live against real library data: a
  // book whose (folder-derived) "author" field was actually the genre
  // "History" returned nothing with author set, but the exact same title
  // alone found the correct book immediately. Retry title-only rather
  // than give up — the match-confidence check below still guards against
  // a wrong book being accepted.
  if (docs.length === 0 && author) {
    docs = await runSearch(title, null)
  }
  if (docs.length === 0) return null

  let best: { doc: OpenLibrarySearchDoc; score: number } | null = null
  for (const doc of docs) {
    const score = matchScore(title, author ?? '', doc)
    if (!best || score > best.score) best = { doc, score }
  }
  if (!best || best.score < MIN_MATCH_SCORE) return null
  return best.doc
}

export async function searchWork(title: string, author: string | null): Promise<OpenLibraryMatch | null> {
  const doc = await findBestMatch(title, author)
  if (!doc) return null

  return {
    // Was doc.subject?.[0] — the raw top subject string ("Fiction",
    // "franchise:Red Rising", "Xanth (Imaginary place)" — see Claude.md
    // Phase 2b note, 2026-08-16). Mapped through the controlled genre list
    // now, scored against the *whole* subject array rather than just
    // whichever one Open Library happened to list first.
    genre: mapToControlledGenre(doc.subject),
    coverId: doc.cover_i ?? null,
    synopsis: doc.key ? await fetchWorkDescription(doc.key) : null,
    series: extractSeries(doc.subject),
  }
}

interface OpenLibraryEditionsResponse {
  entries?: { series?: string[] }[]
}

/** Lenient like fetchWorkDescription — returns [] on any failure rather
 * than throwing, since a missing editions list just means "no number
 * found," not an outage worth aborting a whole backfill batch over. */
async function fetchEditionSeriesTags(workKey: string): Promise<string[]> {
  try {
    await paceRequest()
    const body = await withRetry(async () => {
      let res: Response
      try {
        res = await fetch(`https://openlibrary.org${workKey}/editions.json?limit=50`, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        throw new OpenLibraryUnavailableError('Open Library editions request failed or timed out', { cause: err })
      }
      if (!res.ok) throw new OpenLibraryUnavailableError(`Open Library editions request failed: ${res.status} ${res.statusText}`)
      return (await res.json()) as OpenLibraryEditionsResponse
    })
    return (body.entries ?? []).flatMap((e) => e.series ?? [])
  } catch {
    return []
  }
}

// Real tag shapes confirmed live against Open Library edition records:
// "The Dresden Files #1", "Dresden Files (1)", "Dresden files ; bk. 1",
// "Huan xiang cang shu ge -- 16" — the number is always the last digit
// group in the tag, whatever the surrounding punctuation.
const SERIES_TAG_NUMBER_RE = /(\d+(?:\.\d+)?)(?!.*\d)/

// A tag needs at least one significant word in common with our own
// series_name before its number is trusted — an edition can list more than
// one series (a duology's own series alongside its parent universe), and
// without this a number meant for the WRONG one could get attached.
// Requires 2+ shared significant words, or the shorter side's whole word
// set contained in the longer one's (same threshold companionLink.ts's
// hasTitleOverlap already uses for the same reason) — a bare single-word
// overlap is too weak once a common word like "Bond" is involved. Real
// case caught before this shipped: a book whose (garbage, pre-existing
// data issue) author field forced the title-only search fallback matched
// an unrelated Young Bond novel, whose edition tag shared only the single
// word "bond" with our series name "James Bond - Raymond Benson" — enough
// to falsely pass a plain single-word-overlap check.
function seriesTagMatchesOurSeries(tag: string, ourSeriesName: string): boolean {
  const tagWords = new Set(normalizeWords(tag))
  const ourWords = new Set(normalizeWords(ourSeriesName))
  if (tagWords.size === 0 || ourWords.size === 0) return false
  const overlap = [...ourWords].filter((w) => tagWords.has(w)).length
  if (overlap >= 2) return true
  const [smaller, larger] = ourWords.size <= tagWords.size ? [ourWords, tagWords] : [tagWords, ourWords]
  return [...smaller].every((w) => larger.has(w))
}

/**
 * Looks up this book's position within `seriesName` from Open Library
 * edition records — a separate, best-effort lookup from searchWork's own
 * series-name backfill (which only reads a work's "series:" subject tag,
 * never a number). Returns null whenever there's any ambiguity: no
 * confident title/author match, no edition series tag naming our series,
 * or edition tags naming our series but disagreeing on the number — never
 * guesses.
 */
export async function lookupSeriesNumber(title: string, author: string | null, seriesName: string): Promise<number | null> {
  const doc = await findBestMatch(title, author)
  if (!doc?.key) return null

  const tags = await fetchEditionSeriesTags(doc.key)
  const numbers = new Set<number>()
  for (const tag of tags) {
    if (!seriesTagMatchesOurSeries(tag, seriesName)) continue
    const match = SERIES_TAG_NUMBER_RE.exec(tag)
    if (match) numbers.add(Number(match[1]))
  }
  return numbers.size === 1 ? [...numbers][0] : null
}

interface OpenLibraryWorkResponse {
  description?: OpenLibraryDescription
}

/**
 * A second, separate request for the one confirmed best-matching doc's
 * synopsis — see runSearch's comment on why `description` can no longer be
 * requested inline in the search call. Deliberately lenient: returns null
 * once retries are exhausted (network, timeout, non-2xx) rather than
 * throwing OpenLibraryUnavailableError like every other request in this
 * module — synopsis is bonus data on top of an already-confirmed match
 * (genre and cover are already decided by this point), so this shouldn't
 * discard the rest of that match or abort the whole enrichment batch the
 * way a genuine search-endpoint outage should. Still goes through the
 * same withRetry as everything else first, so a lone transient blip still
 * resolves to a real synopsis instead of giving up on the first try.
 */
async function fetchWorkDescription(workKey: string): Promise<string | null> {
  try {
    await paceRequest()
    const body = await withRetry(async () => {
      let res: Response
      try {
        res = await fetch(`https://openlibrary.org${workKey}.json`, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (err) {
        throw new OpenLibraryUnavailableError('Open Library work request failed or timed out', { cause: err })
      }
      if (!res.ok) {
        throw new OpenLibraryUnavailableError(`Open Library work request failed: ${res.status} ${res.statusText}`)
      }
      return (await res.json()) as OpenLibraryWorkResponse
    })
    return normalizeDescription(body.description)
  } catch {
    return null
  }
}

/** Returns null (rather than throwing) on a missing/failed cover fetch —
 * a book can still get its genre backfilled even if the cover download
 * fails, these are independent outcomes. Still throws OpenLibraryUnavailableError
 * on a timeout/network failure though — that's a connectivity problem, not
 * "this one cover doesn't exist," and callers need to tell the two apart. */
export async function fetchCover(coverId: number): Promise<Buffer | null> {
  await paceRequest()

  // Only the network/timeout path is retried — a non-ok response here is a
  // real, stable "no cover at this id" (typically 404), not a transient
  // failure, so retrying it would just waste the backoff delay.
  const res = await withRetry(() =>
    fetch(`${COVERS_ENDPOINT}/${coverId}-L.jpg`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch((err) => {
      throw new OpenLibraryUnavailableError('Open Library cover request failed or timed out', { cause: err })
    }),
  )
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}
