export type SourceType = 'local' | 'synology' | 'dropbox' | 'google_drive'
export type BookFormat = 'm4b' | 'mp3_folder'
export type BookStatus = 'active' | 'missing'

export interface SourceRow {
  id: string
  type: SourceType
  label: string
  path_scope: string
  credentials: string | null
  created_at: string
}

export interface BookRow {
  id: string
  source_id: string
  file_path: string
  format: BookFormat
  title: string
  author: string | null
  series_name: string | null
  series_number: number | null
  status: BookStatus
  artwork_thumb_path: string | null
  artwork_full_path: string | null
  volume_normalization_gain: number | null
  content_hash: string | null
  updated_at: string
}

export interface ChapterRow {
  id: string
  book_id: string
  idx: number
  title: string
  start_time: number
  duration: number
  file_path: string
}
