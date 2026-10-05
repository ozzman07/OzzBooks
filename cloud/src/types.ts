export interface UserRow {
  id: string
  email: string
  password_hash: string
  created_at: string
}

export type Position =
  | { type: 'timestamp'; value: number }
  | { type: 'cfi'; value: string }
  | { type: 'page'; value: number }
  // KOReader's CREngine position format for EPUB (e.g.
  // "/body/DocFragment[13]/body/div/p[35]/text().0") — structurally
  // unrelated to epub.js's CFI syntax, no cheap translation between them.
  // A reader that only understands 'cfi' (the PWA's EbookReader) safely
  // ignores a position of this type rather than erroring, same as it
  // already does for any other type it doesn't handle.
  | { type: 'koreader-xpointer'; value: string }

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

export interface PlaylistRow {
  id: string
  owner_id: string
  name: string
  is_reserved: boolean
  created_at: string
  updated_at: string
}

export interface PlaylistItemRow {
  id: string
  playlist_id: string
  book_id: string
  position: number
  added_at: string
}

export interface LibraryItemRow {
  user_id: string
  book_id: string
  added_at: string
}
