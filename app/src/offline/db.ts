import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
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
}

let dbPromise: Promise<IDBPDatabase<OzzBooksDB>> | null = null

export function getDb(): Promise<IDBPDatabase<OzzBooksDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OzzBooksDB>('ozzbooks', 4, {
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
