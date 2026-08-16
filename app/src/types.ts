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
  synopsis?: string
  /** One of GENRE_OPTIONS (library/genreOptions.ts) — from Open Library
   * enrichment, from-file subject tags, or a manual edit. Undefined until
   * enriched/set, same as synopsis. */
  genre?: string
  /** Audiobooks only — from the composer/writer tag at ingestion, or a
   * manual edit. Frequently missing; real audio tagging is inconsistent
   * about this (see genreOptions.ts's sibling narrator doc comment
   * server-side). */
  narrator?: string
  status: 'active' | 'missing'
  /** True only for a 'missing' book that can never be relinked by a scan
   * (a pre-dedup-rule mobi conversion whose original folder isn't
   * tracked) — Needs Attention excludes these, since there's no action
   * the user could take that would ever bring one back. Always false for
   * an 'active' book. */
  isOrphanedConversion: boolean
  format: 'm4b' | 'mp3_folder' | 'epub'
  /** The linked audiobook/ebook counterpart's id, if any — see companionLink.ts
   * server-side. Together with `format`, this is what BookDetail uses to
   * decide whether to show a "Read" entry point alongside/instead of "Play". */
  companionBookId?: string
  coverThumbUrl?: string
  coverFullUrl?: string
  totalDuration: number
  /** Set once at first ingestion, never touched again — drives the "Recently added" sort. */
  createdAt: string
  /** Only present on list-view books (from ApiBookListItem); used to derive
   * a lightweight "finished" status by comparing against synced progress,
   * without fetching every book's full chapter list. */
  lastChapterId?: string
  /** The owning source's display name (e.g. "Jarrett's Drive") — present
   * on both list and detail books, driving both Book Detail's display and
   * the Library/Store Source filter facet. */
  sourceLabel?: string
  /** Only present on detail-view books (from ApiBookDetail). */
  sourceType?: string
  chapters: Chapter[]
  progress?: {
    position: Position
    chapterId: string
  }
}
