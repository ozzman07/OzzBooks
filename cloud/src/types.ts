export interface UserRow {
  id: string
  email: string
  password_hash: string
  created_at: string
}

export type Position = { type: 'timestamp'; value: number } | { type: 'cfi'; value: string }

export interface ProgressRow {
  user_id: string
  book_id: string
  position: Position
  chapter_id: string | null
  updated_at: string
}

export interface BookmarkRow {
  id: string
  user_id: string
  book_id: string
  position: Position
  label: string | null
  created_at: string
}

export interface DownloadRow {
  user_id: string
  book_id: string
  chapter_id: string
  downloaded_at: string
  last_played_at: string | null
  size_bytes: number | null
}

export interface UserSettingsRow {
  user_id: string
  storage_budget_mb: number
  playback_speed: number
  skip_silence_enabled: boolean
  updated_at: string
}
