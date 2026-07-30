import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Position } from '../types'

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
}

let dbPromise: Promise<IDBPDatabase<OzzBooksDB>> | null = null

export function getDb(): Promise<IDBPDatabase<OzzBooksDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OzzBooksDB>('ozzbooks', 2, {
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
      },
    })
  }
  return dbPromise
}
