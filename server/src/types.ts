export type SourceType = 'local' | 'synology' | 'dropbox' | 'google_drive'
export type BookFormat = 'm4b' | 'mp3_folder'
export type BookStatus = 'active' | 'missing'
export type CredentialsStatus = 'ok' | 'needs_reconnect'

export interface SourceRow {
  id: string
  type: SourceType
  label: string
  path_scope: string
  credentials: string | null
  credentials_expires_at: string | null
  credentials_status: CredentialsStatus
  credentials_account_label: string | null
  created_at: string
  last_scanned_at: string | null
  last_scan_found: number | null
  last_scan_created: number | null
  last_scan_updated: number | null
  last_scan_failed: number | null
  last_scan_skipped_duplicates: number | null
}

export interface ScanIssueRow {
  id: string
  source_id: string
  file_path: string
  error: string
  occurred_at: string
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
  genre: string | null
  metadata_enrichment_attempted_at: string | null
  created_at: string
  updated_at: string
}

export interface BookListRow extends BookRow {
  total_duration: number
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

export interface AppSettingsRow {
  id: number
  nightly_rescan_enabled: number // SQLite INTEGER 0/1, not a JS boolean
  nightly_rescan_time: string
  nightly_rescan_last_run_date: string | null
  updated_at: string
}
