import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Book, Position } from '../types'

export interface LocalProgressEntry {
  bookId: string
  chapterId: string
  position: Position
  updatedAt: string
  synced: boolean
}

// Keyed by sourceFileId, not chapterId: M4B chapters share one underlying
// file (see Chapter.sourceFileId in ../types.ts), so caching per-chapter
// would silently re-download the same bytes under every chapter of the
// same book. Downloading any one chapter of an M4B book makes the whole
// book playable offline, which is also the behaviorally correct outcome.
export interface CachedAudioFileEntry {
  sourceFileId: string
  bookId: string
  blob: Blob
  sizeBytes: number
  downloadedAt: string
  lastPlayedAt: string
}

// One row per epub book id — unlike audio, an epub is a single file with
// no chapter/source-file split, so there's nothing to key this any finer
// than the book itself.
export interface CachedEpubFileEntry {
  bookId: string
  blob: Blob
  sizeBytes: number
  downloadedAt: string
  // Added alongside the generalized storage budget (see downloadManager.ts)
  // so an epub can participate in the same globally-least-recently-used
  // eviction audio already uses, instead of never being evicted at all.
  // Optional, not required: a real cached entry written by the app before
  // this field existed has no lastReadAt at all (IndexedDB enforces no
  // schema — old rows keep their old shape until rewritten) — eviction
  // code must fall back to downloadedAt for those rather than assume this
  // is always present.
  lastReadAt?: string
}

// A comic page is small enough on its own that keying per-page (not per-
// book like epub) is the natural fit — but eviction is still whole-issue
// (see CachedComicDownloadEntry below), never per-page.
export interface CachedComicPageEntry {
  key: string // `${bookId}:${pageIndex}`
  bookId: string
  pageIndex: number
  blob: Blob
  sizeBytes: number
  downloadedAt: string
}

// The per-book metadata a comic's pages don't carry themselves: whether an
// explicit "download whole issue" ever completed (stored explicitly, never
// inferred from a blob count — a download that dies partway through
// otherwise looks identical to "fully downloaded, just fewer pages"; see
// Ozzbooks_Addendum_Comics' Offline download experience section), and the
// book-level lastReadAt eviction evicts by — a comic's cached pages are
// evicted together as one unit, never partially, so there's one shared
// timestamp per book rather than one per page.
export interface CachedComicDownloadEntry {
  bookId: string
  pageCount: number
  complete: boolean
  startedAt: string
  lastReadAt: string
}

// epub.js's book.locations.generate() indexes the whole book's text into
// fixed-size CFI breakpoints — several seconds of work for a typical
// novel, but built from raw character counts, not visual layout, so it
// never needs regenerating for a font-size/line-height change. `locations`
// is the opaque string book.locations.save() returns, round-tripped
// straight into book.locations.load() on the next open to skip
// regenerating entirely. See EbookReader.tsx.
export interface CachedBookLocationsEntry {
  bookId: string
  locations: string
  savedAt: string
}

// A single row, not one-per-book — this is AppDataContext's whole shared
// catalog/shelf snapshot, persisted so a cold PWA launch while offline has
// something to show immediately instead of an empty list with nothing to
// fall back to. See AppDataContext.tsx.
export interface CachedCatalogEntry {
  id: 'catalog'
  books: Book[]
  myLibraryIds: string[]
  fetchedAt: string
}

// The *full* per-book detail (chapters included), as opposed to
// AppDataContext's list-item-shaped catalog entries above — this is what
// actually makes a downloaded audiobook playable offline, since
// PlayerContext.loadBook() needs real chapter/sourceFileId data that the
// list-item shape doesn't carry. See BookDetail.tsx.
export interface CachedBookDetailEntry {
  bookId: string
  book: Book
  fetchedAt: string
}

interface OzzBooksDB extends DBSchema {
  // No index on `synced` — IndexedDB keys can't be booleans, and the
  // number of in-flight progress rows is small enough that a full-table
  // getAll() + JS filter is simpler and plenty fast.
  progress: {
    key: string // bookId
    value: LocalProgressEntry
  }
  audioFiles: {
    key: string // sourceFileId
    value: CachedAudioFileEntry
    indexes: { bookId: string; lastPlayedAt: string }
  }
  epubFiles: {
    key: string // bookId
    value: CachedEpubFileEntry
  }
  bookLocations: {
    key: string // bookId
    value: CachedBookLocationsEntry
  }
  catalogCache: {
    key: string // always 'catalog' — singleton row
    value: CachedCatalogEntry
  }
  bookDetailCache: {
    key: string // bookId
    value: CachedBookDetailEntry
  }
  comicPages: {
    key: string // `${bookId}:${pageIndex}`
    value: CachedComicPageEntry
    indexes: { bookId: string }
  }
  comicDownloads: {
    key: string // bookId
    value: CachedComicDownloadEntry
  }
}

let dbPromise: Promise<IDBPDatabase<OzzBooksDB>> | null = null

export function getDb(): Promise<IDBPDatabase<OzzBooksDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OzzBooksDB>('ozzbooks', 5, {
      upgrade(db) {
        if (!db.objectStoreNames.contains('progress')) {
          db.createObjectStore('progress', { keyPath: 'bookId' })
        }
        if (!db.objectStoreNames.contains('audioFiles')) {
          const audioFiles = db.createObjectStore('audioFiles', { keyPath: 'sourceFileId' })
          audioFiles.createIndex('bookId', 'bookId')
          audioFiles.createIndex('lastPlayedAt', 'lastPlayedAt')
        }
        if (!db.objectStoreNames.contains('epubFiles')) {
          db.createObjectStore('epubFiles', { keyPath: 'bookId' })
        }
        if (!db.objectStoreNames.contains('comicPages')) {
          const comicPages = db.createObjectStore('comicPages', { keyPath: 'key' })
          comicPages.createIndex('bookId', 'bookId')
        }
        if (!db.objectStoreNames.contains('comicDownloads')) {
          db.createObjectStore('comicDownloads', { keyPath: 'bookId' })
        }
        if (!db.objectStoreNames.contains('bookLocations')) {
          db.createObjectStore('bookLocations', { keyPath: 'bookId' })
        }
        if (!db.objectStoreNames.contains('catalogCache')) {
          db.createObjectStore('catalogCache', { keyPath: 'id' })
        }
        if (!db.objectStoreNames.contains('bookDetailCache')) {
          db.createObjectStore('bookDetailCache', { keyPath: 'bookId' })
        }
      },
    })
  }
  return dbPromise
}

/** Test-only — closes and deletes the database so the next getDb() call
 * opens a genuinely fresh one. Real app code never calls this; there's no
 * legitimate reason to delete a user's offline cache at runtime. Exists so
 * offline/*.test.ts files can start each test from clean IndexedDB state
 * instead of accumulating rows across tests in the same file. */
export async function resetDbForTests(): Promise<void> {
  const db = await getDb()
  db.close()
  dbPromise = null
  await deleteDB('ozzbooks')
}
