export interface Chapter {
  id: string
  bookId: string
  index: number
  title: string
  startTime: number
  duration: number
  audioUrl: string
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
  chapters: Chapter[]
  progress?: {
    position: Position
    chapterId: string
  }
}
