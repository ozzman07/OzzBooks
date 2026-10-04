import { deleteDB, openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Book, Position } from '../types'
import { logPlayerEvent } from '../player/playerDebugLog'

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
//
// Metadata only — the actual audio bytes live chunked in the Cache Storage
// bucket audioChunkStore.ts manages, never as one big Blob anywhere. Two
// prior, reverted attempts each crashed the phone with an out-of-memory
// kill from some single operation materializing an entire (~800MB+) file
// at once — a Blob URL for playback, or a whole-file read/write during a
// storage migration. Chunking throughout (download, migration, and
// serving — see audioChunkStore.ts, offlineAudioRange.ts,
// migrateLegacyAudio.ts) means no operation ever touches more than a
// handful of ~8MB pieces.
export interface CachedAudioFileEntry {
  sourceFileId: string
  bookId: string
  sizeBytes: number
  chunkCount: number
  downloadedAt: string
  lastPlayedAt: string
}

/** Only ever seen on a row written before the chunked-storage migration
 * above — a real IndexedDB row from that era still has `blob` on it at
 * runtime even though CachedAudioFileEntry no longer declares it
 * (IndexedDB has no schema; old rows keep their old shape until
 * rewritten). See migrateLegacyAudio.ts. */
export interface LegacyCachedAudioFileEntry extends CachedAudioFileEntry {
  blob?: Blob
}

/** Tracks an in-progress chunked write (fresh download or legacy
 * migration) so a crash partway through resumes near where it left off
 * instead of restarting — and potentially crashing again — from scratch.
 * Read/written only from page context (downloadManager.ts,
 * migrateLegacyAudio.ts), never the service worker. */
export interface AudioTransferProgressEntry {
  sourceFileId: string
  bookId: string
  chunksWritten: number
  chunkCount: number
  totalSize: number
  mimeType: string
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
  audioTransferProgress: {
    key: string // sourceFileId
    value: AudioTransferProgressEntry
  }
}

let dbPromise: Promise<IDBPDatabase<OzzBooksDB>> | null = null

// Real bug, reported live: after the PWA sat backgrounded for a long
// time (long background audio session, or just left open), the IndexedDB
// connection above can come back unusable — WebKit is known to zombie a
// background tab's IndexedDB connection, where reads/writes against it
// either reject or simply hang forever with no error at all. Every
// getDb() call before this reused the one cached `dbPromise` for the
// entire page lifetime, so once that happened every local-storage read
// (Library's Continue Listening shelf, keyed off getAllLocalProgress)
// and write (the player's own progress saves) silently stopped working —
// matching exactly what was reported: the In Progress shelf not
// repopulating, and a resumed book coming back several minutes behind,
// both only fixed by fully restarting the app (a fresh page load gets a
// fresh connection). Discarding the cached promise whenever the page
// regains visibility — rather than only on an explicit 'close' event,
// which the hung-forever case never fires — means the next getDb() call
// always opens a brand-new connection instead of risking reuse of a dead
// one. The old connection (if genuinely zombied) is simply abandoned, not
// explicitly closed: IndexedDB supports multiple simultaneous connections
// to the same database, and calling close() on a connection that's
// already stuck could itself hang.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    if (!dbPromise) {
      logPlayerEvent('db:visible (no connection held)')
      return
    }
    logPlayerEvent('db:reconnect (discarding on visible)')
    // Fire-and-forget: close() itself never hangs (it just schedules the
    // connection to close once any of its own pending transactions settle,
    // per spec), so this is safe even against a connection that's
    // otherwise stuck. Not awaited — the reset below must happen
    // synchronously regardless of whether/when this resolves.
    dbPromise.then((db) => db.close()).catch(() => {})
    dbPromise = null
  })
}

export function getDb(): Promise<IDBPDatabase<OzzBooksDB>> {
  if (!dbPromise) {
    logPlayerEvent('db:open')
    dbPromise = openDB<OzzBooksDB>('ozzbooks', 6, {
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
        if (!db.objectStoreNames.contains('audioTransferProgress')) {
          db.createObjectStore('audioTransferProgress', { keyPath: 'sourceFileId' })
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
