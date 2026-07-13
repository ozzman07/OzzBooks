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
}

let dbPromise: Promise<IDBPDatabase<OzzBooksDB>> | null = null

export function getDb(): Promise<IDBPDatabase<OzzBooksDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OzzBooksDB>('ozzbooks', 1, {
      upgrade(db) {
        db.createObjectStore('progress', { keyPath: 'bookId' })

        const audioFiles = db.createObjectStore('audioFiles', { keyPath: 'sourceFileId' })
        audioFiles.createIndex('bookId', 'bookId')
        audioFiles.createIndex('lastPlayedAt', 'lastPlayedAt')
      },
    })
  }
  return dbPromise
}
