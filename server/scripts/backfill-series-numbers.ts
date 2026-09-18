// One-off backfill: fills in books.series_number for books that already
// have a confirmed series_name (from folder/tag derivation) but no number,
// by looking up their position within that series from Open Library
// edition records (see lookupSeriesNumber in openLibrary.ts) — something
// the regular nightly enrichment pass never attempts, since series_number
// isn't one of the fields enrichBooks.ts's candidate query or write path
// touches at all.
//
// Comics are excluded (same reasoning as enrichBooks.ts: Open Library is a
// prose-book search API, a comic title could easily match an unrelated
// novel) and any book already series_number_source = 'manual' is left
// alone, whether that's a literal user edit or an earlier programmatic
// pin (see this session's Alien Invasion / Cornwell fixes, which use the
// same convention: 'manual' means "trust this, don't let a future scan or
// backfill touch it").
//
// Defaults to a dry run — prints every proposed (book, series, number)
// without writing anything. Pass --apply to actually write. Run with:
//   OZZBOOKS_DATA_DIR=/Users/jimosborn/OzzBooksData npx tsx scripts/backfill-series-numbers.ts [--apply] [--limit N]
import { getDb } from '../src/db/index.js'
import { logActivity } from '../src/db/activityLog.js'
import { lookupSeriesNumber, OpenLibraryUnavailableError } from '../src/ingestion/enrichment/openLibrary.js'
import { cleanTitleForSearch } from '../src/ingestion/enrichment/enrichBooks.js'
import type { BookRow } from '../src/types.js'

const COMICS_SOURCE_ID = '263e4746-2f84-4c23-9709-d76ee247e9cb'

async function main() {
  const args = process.argv.slice(2)
  const apply = args.includes('--apply')
  const limitArg = args.find((a) => a.startsWith('--limit='))
  const limit = limitArg ? Number(limitArg.split('=')[1]) : undefined

  const db = getDb()
  let candidates = db
    .prepare(
      `SELECT * FROM books
       WHERE status = 'active'
         AND format != 'cbz'
         AND source_id != ?
         AND series_name IS NOT NULL
         AND series_number IS NULL
       ORDER BY series_name, title`,
    )
    .all(COMICS_SOURCE_ID) as BookRow[]

  if (limit) candidates = candidates.slice(0, limit)

  console.log(`${apply ? 'APPLYING' : 'DRY RUN'} — ${candidates.length} candidate(s)\n`)

  let found = 0
  let noMatch = 0
  let failed = 0
  let aborted = false

  for (const book of candidates) {
    try {
      const number = await lookupSeriesNumber(cleanTitleForSearch(book.title), book.author, book.series_name!)
      if (number === null) {
        noMatch++
        continue
      }
      found++
      console.log(`${book.series_name} #${number} — ${book.title} (${book.id})`)
      if (apply) {
        const result = db
          .prepare("UPDATE books SET series_number = ?, series_number_source = 'manual' WHERE id = ? AND series_number IS NULL")
          .run(number, book.id)
        if (result.changes > 0) {
          logActivity(book.id, book.title, book.author, 'metadata_updated', `Backfilled series number from Open Library: #${number}`)
        }
      }
    } catch (err) {
      if (err instanceof OpenLibraryUnavailableError) {
        console.warn(`Open Library appears unavailable, stopping early (${found + noMatch + failed} processed):`, err)
        aborted = true
        break
      }
      failed++
      console.warn(`Failed for ${book.title} (${book.id}):`, err)
    }
  }

  console.log(`\nDone. found=${found} noMatch=${noMatch} failed=${failed} aborted=${aborted}`)
}

void main()
