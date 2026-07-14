export interface Chapter {
  id: string
  bookId: string
  index: number
  title: string
  /** Offset in seconds within audioUrl's stream where this chapter starts. */
  startTime: number
  duration: number
  audioUrl: string
  /**
   * Identifies the underlying source file. M4B chapters share one file
   * (and one audioUrl target file, even though each chapter has its own
   * URL) — the player uses this to avoid reloading/re-buffering audio
   * when moving between chapters that are really the same stream.
   */
  sourceFileId: string
}

export type Position =
  | { type: 'timestamp'; value: number }
  | { type: 'cfi'; value: string }

export interface Book {
  id: string
  title: string
  author: string
  seriesName?: string
  seriesNumber?: number
  status: 'active' | 'missing'
  coverThumbUrl?: string
  coverFullUrl?: string
  totalDuration: number
  /** Set once at first ingestion, never touched again — drives the "Recently added" sort. */
  createdAt: string
  /** Only present on list-view books (from ApiBookListItem); used to derive
   * a lightweight "finished" status by comparing against synced progress,
   * without fetching every book's full chapter list. */
  lastChapterId?: string
  chapters: Chapter[]
  progress?: {
    position: Position
    chapterId: string
  }
}
