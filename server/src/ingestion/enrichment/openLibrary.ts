const SEARCH_ENDPOINT = 'https://openlibrary.org/search.json'
const COVERS_ENDPOINT = 'https://covers.openlibrary.org/b/id'
// Identifies the app per Open Library's stated policy (required for the
// higher 3 req/sec tier — this still throttles to 1 req/sec regardless,
// see paceRequest, to stay clearly inside "not hundreds of single-book
// requests" rather than maximizing the allowed rate).
const USER_AGENT = 'OzzBooks/1.0 (jim@osbornville.com)'
const MIN_REQUEST_INTERVAL_MS = 1000
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

interface OpenLibrarySearchDoc {
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
  const params = new URLSearchParams({ q: title, limit: '5', fields: 'title,author_name,subject,cover_i' })
  if (author) params.set('author', author)

  const res = await fetch(`${SEARCH_ENDPOINT}?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) {
    throw new Error(`Open Library search failed: ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as OpenLibrarySearchResponse
  return body.docs ?? []
}

export async function searchWork(title: string, author: string | null): Promise<OpenLibraryMatch | null> {
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

  return {
    genre: best.doc.subject?.[0] ?? null,
    coverId: best.doc.cover_i ?? null,
  }
}

/** Returns null (rather than throwing) on a missing/failed cover fetch —
 * a book can still get its genre backfilled even if the cover download
 * fails, these are independent outcomes. */
export async function fetchCover(coverId: number): Promise<Buffer | null> {
  await paceRequest()

  const res = await fetch(`${COVERS_ENDPOINT}/${coverId}-L.jpg`, {
    headers: { 'User-Agent': USER_AGENT },
  })
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}
