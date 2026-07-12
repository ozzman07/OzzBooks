import type { Book } from '../types'

// Placeholder audio for local dev/testing — see scripts/gen-demo-audio.mjs.
// Real chapter audio comes from ingestion once the file-serving API exists.
const DEMO_AUDIO_URL = '/audio/demo-chapter.wav'

function chapters(bookId: string, titles: string[], chapterLength: number) {
  return titles.map((title, index) => ({
    id: `${bookId}-ch${index + 1}`,
    bookId,
    index,
    title,
    startTime: index * chapterLength,
    duration: chapterLength,
    audioUrl: DEMO_AUDIO_URL,
  }))
}

export const mockBooks: Book[] = [
  {
    id: 'b1',
    title: 'The Fellowship of the Ring',
    author: 'J.R.R. Tolkien',
    seriesName: 'The Lord of the Rings',
    seriesNumber: 1,
    status: 'active',
    totalDuration: 19 * 3600,
    chapters: chapters(
      'b1',
      ['A Long-Expected Party', 'The Shadow of the Past', 'Three Is Company', 'A Short Cut to Mushrooms'],
      3600 * 2,
    ),
    progress: {
      position: { type: 'timestamp', value: 5400 },
      chapterId: 'b1-ch2',
    },
  },
  {
    id: 'b2',
    title: 'Project Hail Mary',
    author: 'Andy Weir',
    status: 'active',
    totalDuration: 16 * 3600,
    chapters: chapters('b2', ['Chapter 1', 'Chapter 2', 'Chapter 3'], 3600),
  },
  {
    id: 'b3',
    title: 'Mistborn: The Final Empire',
    author: 'Brandon Sanderson',
    seriesName: 'Mistborn',
    seriesNumber: 1,
    status: 'active',
    totalDuration: 24 * 3600,
    chapters: chapters('b3', ['Prologue', 'Chapter 1', 'Chapter 2'], 3600),
  },
  {
    id: 'b4',
    title: 'The Fifth Season',
    author: 'N.K. Jemisin',
    seriesName: 'The Broken Earth',
    seriesNumber: 1,
    status: 'missing',
    totalDuration: 12 * 3600,
    chapters: chapters('b4', ['Chapter 1', 'Chapter 2'], 3600),
  },
]
