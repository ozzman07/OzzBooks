import type { ApiBook, ApiBookDetail, ApiBookListItem, ApiChapter } from './client'
import { artworkUrl, streamUrl } from './client'
import type { Book, Chapter } from '../types'

function adaptChapter(chapter: ApiChapter): Chapter {
  return {
    id: chapter.id,
    bookId: chapter.book_id,
    index: chapter.idx,
    title: chapter.title,
    startTime: chapter.start_time,
    duration: chapter.duration,
    audioUrl: streamUrl(chapter.id),
    sourceFileId: chapter.file_path,
  }
}

// Progress/bookmarks live in the separate cloud sync layer (see Claude.md
// architecture), which doesn't exist yet — so `progress` is always absent
// for now rather than faked. The Library's "Continue Listening" shelf will
// come back once that layer is wired up.
function adaptBookFields(book: ApiBook): Omit<Book, 'chapters' | 'totalDuration'> {
  return {
    id: book.id,
    title: book.title,
    author: book.author ?? 'Unknown author',
    seriesName: book.series_name ?? undefined,
    seriesNumber: book.series_number ?? undefined,
    synopsis: book.synopsis ?? undefined,
    status: book.status,
    coverThumbUrl: book.artwork_thumb_path ? artworkUrl(book.id, 'thumb') : undefined,
    coverFullUrl: book.artwork_full_path ? artworkUrl(book.id, 'full') : undefined,
    createdAt: book.created_at,
  }
}

export function adaptBookListItem(book: ApiBookListItem): Book {
  return {
    ...adaptBookFields(book),
    chapters: [],
    totalDuration: book.total_duration,
    lastChapterId: book.last_chapter_id ?? undefined,
  }
}

export function adaptBookDetail(book: ApiBookDetail): Book {
  const chapters = book.chapters.map(adaptChapter)
  return {
    ...adaptBookFields(book),
    chapters,
    totalDuration: chapters.reduce((sum, c) => sum + c.duration, 0),
    sourceLabel: book.source_label,
    sourceType: book.source_type,
  }
}
