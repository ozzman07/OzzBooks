# OzzBooks

An audiobook + ebook player PWA for iOS (and iPad), designed to stream and
download books from a home-hosted Synology NAS and cloud sources, with
cross-device sync, offline resilience, and a roadmap toward ebook sync and
AI-generated recaps.

No native App Store distribution — this is intentionally a PWA
("Add to Home Screen") to avoid requiring an Apple developer license.

## Architecture

| Layer | Choice |
|---|---|
| File storage | Synology NAS + cloud sources (Dropbox/Google Drive etc.), home-hosted |
| File-serving API | Runs on a Mac mini, exposed via **Tailscale + Tailscale Serve** (tailnet-only HTTPS — not publicly exposed) |
| Sync/auth layer | Cloud-hosted (e.g. Supabase/Railway-style Postgres), independent of home network uptime |
| Frontend | PWA — installable via Add to Home Screen, works offline via service worker |
| Playback | HTML5 `<audio>` element + Media Session API (lock-screen controls, AirPods/Bluetooth remote, artwork) |

**Why this split:** the Mac mini/NAS remain the source of truth for large
audio/ebook files (no reason to pay for cloud storage of files already
hosted at home). A small cloud-hosted layer handles accounts and sync state
(position, bookmarks, settings) so those stay available even if the home
network or Mac mini is temporarily down. Tailscale replaces a public tunnel
(e.g. Cloudflare Tunnel) since this is for family/friends, not the general
public — no public attack surface, access is gated at the network layer by
tailnet membership, plus app-level auth on top (see below).

**User access model:** each user installs the Tailscale app once and is
invited to the tailnet. After that it runs in the background — no repeated
logins. The PWA itself still needs its own login (see "App-level
authentication" below) since Tailscale only gates network access, not
which user is using the app.

## Platform constraints that shaped these decisions (read before "fixing" things)

- **iOS forces all browsers to use WebKit.** Switching browsers doesn't
  change any storage or capability behavior — Safari, Chrome-on-iOS, etc.
  are all WebKit under the hood.
- **No File System Access API on iOS Safari.** `showSaveFilePicker` /
  `showDirectoryPicker` are Chromium-only. A PWA cannot write to or read
  back from the visible Files app automatically. This is why offline
  storage uses IndexedDB (app-private, but reliably read/writable) rather
  than trying to save into a user-visible folder.
- **iOS Cache API / IndexedDB storage is eviction-prone.** Reported limits
  and eviction windows vary (sometimes cited as ~50MB for Cache API,
  larger for IndexedDB, with eviction after ~7 days of disuse in some
  cases). Treat all offline storage as **best-effort persistent, not
  guaranteed** — always verify and self-heal rather than assuming data
  survives indefinitely.
- **No CarPlay support.** CarPlay integration is native-app-only; there's
  no path into it from a PWA. Bluetooth audio to a car stereo still works
  fine via Media Session — this is specifically about the CarPlay
  screen/UI. This is an accepted platform gap, not something to solve.
- **Design priority: short offline gaps, not extended offline.** The
  target scenario is "connection available most of the time, occasional
  brief gaps" (subway, dead zone, Mac mini restart) — not "usable for
  weeks with no connectivity at all." This shapes storage/caching
  decisions throughout: prefer self-healing background sync over building
  for bulletproof long-term offline.
- **A native wrapper (e.g. Capacitor) is an explicit non-goal for now.**
  It would solve storage/CarPlay/etc. completely but reopens the
  App Store/dev-license question this project is deliberately avoiding.
  Only reconsider if real-device testing shows the PWA approach is
  genuinely unworkable.

## Validation tasks — do these early, before deep feature work

1. **Storage test:** download a full-size real audiobook file (hundreds of
   MB) to an installed iOS PWA and confirm actual behavior — quota, and
   whether/when it gets evicted under normal daily use. Don't trust any
   single source's numbers; verify on a real device.
2. **Background playback test:** confirm lock-screen/background audio via
   Media Session survives realistic session lengths (not just a minute or
   two) without the OS killing it.

## Phase 1 (current focus)

### Playback
- Play/pause, skip forward/back (15s/30s), scrub/seek, previous/next chapter
- Variable playback speed (0.5x–3x, fine increments)
- Sleep timer (fixed durations + "end of chapter")
- Skip silence (toggle)
- Full Media Session API integration: lock-screen controls, Control
  Center, artwork, scrubbing via `setPositionState`, Bluetooth/AirPods
  remote buttons

### Streaming & offline
- Streaming by default; chapter-level download for offline persistence
  (not whole-file-only — chunking limits the blast radius of any single
  eviction/re-fetch)
- Playback source resolution per chapter: local IndexedDB blob if cached,
  network stream otherwise
- Background pre-fetch: keep current + next 1–2 chapters cached
  automatically for actively-playing books, so short offline gaps are
  covered without explicit user action
- Explicit "download whole book" action available for planned offline use
  (e.g. flights)
- `navigator.storage.persist()` requested each session to reduce eviction
  risk
- Self-heal: on connectivity, verify cached chapters still exist in
  IndexedDB, silently re-fetch anything missing

### Download cleanup
- Manual delete, per book/chapter, always available
- Storage-budget model (user-configurable `storage_budget_mb`) with LRU
  eviction (by `last_played_at`) as the primary automatic mechanism
- Optional auto-cleanup-on-finish per book (off by default)
- Storage usage visibility screen via `navigator.storage.estimate()`

### Position & sync
- Position stored as `{type: 'timestamp' | 'cfi', value}` — generic from
  day one even though `cfi` (ebook position) isn't used until Phase 3
- Written to local storage immediately (small, low eviction risk) on
  every pause / every N seconds during playback
- Queued to sync to the cloud layer whenever connectivity is available
- Cross-device conflict handling: **last-write-wins** (accepted as
  sufficient for now; revisit only if it becomes a real problem)
- Bookmarks are a **separate, deliberate** action from continuous
  position — own table, user-labeled

### Ingestion & library
- Ingestion scans Synology + cloud sources, normalizes into a consistent
  internal book model (handles mixed M4B / MP3-folder formats)
- Chapter extraction: M4B embedded chapter atoms; MP3 folders infer
  chapters from file/track order or ID3 chapter frames if present
- Trigger: manual "rescan now" + scheduled nightly scan
- Duplicate detection across sources (same book present on NAS and in a
  cloud source should not create two library entries / split progress)
- Metadata editing: manual correction of title/author/series after
  ingestion (especially needed for messy MP3 tag data)
- Series metadata (name + number) — feeds library grouping now, recap
  generation later (Phase 5)
- Volume normalization: basic loudness normalization or replay-gain-style
  gain metadata computed at ingestion, applied at playback, to avoid
  jarring volume jumps between books/narrators
- Library browsing: search by title/author, sort by recent/in-progress,
  series grouping, "continue listening" shelf
- Offline library metadata: titles/authors/chapter lists cached for full
  offline browsing (not just artwork — see below)

### Source connection management
- Sources (Synology, cloud) are **editable in place** — credentials,
  path/scope, display label — never require delete+recreate
- `books.source_id` is a stable reference; editing a source must never
  cascade-delete books
- If a previously-indexed file can't be found after an edit/rescan, mark
  the book `status: 'missing'` — **do not delete** — progress, downloads,
  bookmarks, annotations all stay intact
- "Needs attention" view surfaces missing books
- Manual relink flow: user picks a source + browses/selects the correct
  file, or triggers a targeted re-scan
- Auto-suggested matches on relink via file hash / filename / size
  heuristics
- Sanity check on relink (compare duration/chapter count) to catch
  mismatches (e.g. relinking to the wrong book in a series) before
  committing

### Cover artwork
- Extracted once at ingestion: embedded art from M4B, EPUB cover image, or
  `cover.jpg` / `folder.jpg` in the source folder; generic placeholder if
  none found
- Generated in multiple sizes at ingestion (thumbnail for library grid,
  full-size for now-playing screen)
- Cached in IndexedDB in its own small object store, keyed by `book_id` —
  **not** subject to the same LRU eviction as audio chapters
- Default: cache art for the **entire library**, independent of audio
  download status, so the library looks/feels complete offline

### Auth & security
- Real app-level authentication from day one, independent of Tailscale
  (Tailscale gates network access; it does not identify which user is
  using the app — this matters once Phase 2 multi-user lands)
- Lightweight token check on the file-serving API itself as
  defense-in-depth beyond Tailscale network gating

### PWA platform concerns
- Service worker update strategy: explicit "update available, tap to
  refresh" UX — don't assume updates land silently and safely
- Accessibility: explicit VoiceOver support — audiobooks are a
  naturally accessibility-relevant use case, don't leave this implicit
- Confirm device scope: iPad is in scope by default (PWA behaves
  identically) unless explicitly restricted to iPhone

## Operational notes (not code, but required for the system to work)

- Mac mini sleep/power settings must prevent the file-serving API from
  going dark (disable sleep or schedule wake) — Tailscale itself staying
  up doesn't help if the machine behind it is asleep
- Periodic backup of the ingestion database (metadata, extracted artwork,
  match/relink history) — the source files on the NAS are already safe,
  but curation work (matches, edits, relinks) lives only in this database

## Data model (current, Phase 1 scope)

```
sources
  id, type, label, credentials, path_scope

books
  id, source_id, file_path, audio_source, epub_source,
  status ('active' | 'missing'),
  series_name, series_number,
  artwork_thumb_path, artwork_full_path,
  volume_normalization_gain

users
  id, ... (auth fields)

progress
  user_id, book_id, position { type: 'timestamp' | 'cfi', value }

bookmarks
  user_id, book_id, position, label, created_at

downloads
  user_id, book_id, chapter_id, downloaded_at, last_played_at, size_bytes

user_settings
  user_id, storage_budget_mb, playback_speed, skip_silence_enabled, ...

annotations        -- stubbed now, used starting Phase 4
  user_id, book_id, cfi_range, note_text, created_at

reading_prefs       -- stubbed now, used starting Phase 4
  user_id, theme ('e-ink' | 'light' | 'dark' | 'sepia'), font, margins

book_position_map   -- reserved now, used starting Phase 3c
  book_id, audio_timestamp, epub_cfi
```

Several tables/fields above are intentionally scaffolded ahead of the
phase that uses them (multi-user shape, position map, annotations,
reading prefs) — this is deliberate, to avoid schema migrations later.
Don't remove them for being "unused."

## Future phases (context for design decisions now, not current build targets)

- **Phase 2 — Multi-user:** UI/permissions layer on top of the
  already-scoped data model (everything above is already
  `user_id`-scoped)
- **Phase 3a — Ebook integration:** chapter-level audio↔ebook sync, basic
  EPUB rendering (epub.js is the likely library — it produces CFIs, the
  standard EPUB position format)
- **Phase 3b — Transcription pipeline:** Whisper, run locally on the Mac
  mini — shared infrastructure for both fine-grained sync (3c) and recap
  generation (Phase 5)
- **Phase 3c — Fine-grained ebook sync:** align Whisper transcript to
  EPUB text, populate `book_position_map`, enable true CFI-level
  audio↔ebook position translation
- **Phase 3d — Streaming bandwidth handling:** evaluate whether ingestion
  should transcode large/lossless sources for reasonable cellular
  streaming
- **Phase 4 — Full e-reader UX:** themes (including an e-ink-style theme:
  warm off-white background e.g. `#F2F0E9`, soft charcoal text e.g.
  `#1A1A1A`, serif font default, flat/no-gloss rendering, minimal/no page
  transition animation), highlights, notes, TOC navigation, reading
  preferences
- **Phase 5 — Recap generation:** "story so far" recaps per book and per
  series, built on the Phase 3b transcription infrastructure and series
  metadata. Exact approach TBD — pending input from a related project a
  family member is separately exploring. Don't over-design this yet.

## Open / accepted decisions (don't relitigate without new information)

- Cross-device simultaneous playback: last-write-wins on position sync —
  accepted as sufficient
- CarPlay: unsupported, accepted platform limitation
- Extended offline (weeks, no connectivity): explicitly out of scope;
  short-gap resilience is the actual target
- Native wrapper (Capacitor etc.): explicit non-goal unless Phase 1
  validation testing proves the PWA approach unworkable
