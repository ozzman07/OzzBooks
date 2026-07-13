import { openDB, type DBSchema, type IDBPDatabase } from 'idb'
import type { Position } from '../types'

export interface LocalProgressEntry {
  bookId: string
  chapterId: string
  position: Position
  updatedAt: string
  synced: boolean
}

export interface CachedChapterEntry {
  chapterId: string
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
  chapters: {
    key: string // chapterId
    value: CachedChapterEntry
    indexes: { bookId: string; lastPlayedAt: string }
  }
}

let dbPromise: Promise<IDBPDatabase<OzzBooksDB>> | null = null

export function getDb(): Promise<IDBPDatabase<OzzBooksDB>> {
  if (!dbPromise) {
    dbPromise = openDB<OzzBooksDB>('ozzbooks', 1, {
      upgrade(db) {
        db.createObjectStore('progress', { keyPath: 'bookId' })

        const chapters = db.createObjectStore('chapters', { keyPath: 'chapterId' })
        chapters.createIndex('bookId', 'bookId')
        chapters.createIndex('lastPlayedAt', 'lastPlayedAt')
      },
    })
  }
  return dbPromise
}
