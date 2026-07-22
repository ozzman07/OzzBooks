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
| Sync/auth layer | Cloud-hosted: Postgres on **Neon** + API on **Render** (both free tier), independent of home network uptime |
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

**Onboarding a new family member (one-time, in order):**
1. Admin sends a Tailscale invite (from the Tailscale admin console) to
   the new person's email
2. They install the Tailscale app on their phone and accept the invite —
   one-time login, runs in the background afterward
3. Admin creates (or sends an invite link for) their app-level account,
   independent of Tailscale
4. They open the app URL in Safari and use "Add to Home Screen" to
   install the PWA, then log into their app account
5. Steps 1–4 are one-time setup only; nothing here repeats per session

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
- **No Split View / Slide Over / Stage Manager for the installed PWA.**
  iOS treats a Home Screen web app as a "Web Clip," and Apple doesn't
  allow those into any iPadOS multitasking window mode — only true native
  or App Store apps qualify, and there's no capability a web app can
  declare to opt in. Using the same URL in a regular Safari tab instead
  (not installed) supports Split View fine, since that's Safari's own
  window being resized, not the page's. Accepted platform gap for the
  installed-icon case, not something fixable in this codebase.
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

## Testing strategy

This is a personal/family project, not a commercial product — don't build
a full automated test suite. Scope automated tests to the one area
that's genuinely fiddly and easy to silently break: **ingestion and
chapter-parsing logic** (M4B chapter atom extraction, MP3-folder chapter
inference, duplicate-across-sources detection). That's where edge cases
hide and where a regression is hardest to notice by eye.

Everything else (playback controls, scrubbing, UI behavior) is fine to
verify by hand via the Validation tasks above and normal manual
click-through — not worth automating at this scale.

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
- Stream-failure fallback: if a live network stream fails mid-play (Mac
  mini asleep/restarting/unreachable), first check IndexedDB for that
  chapter — the existing background pre-fetch means the current chapter
  is usually already cached, so this should silently resume from the
  local copy rather than interrupting playback. Only show a
  user-facing "can't reach your library right now, retry" message (with
  a few automatic retries + backoff first) when no local copy exists

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
- Queued to sync to the cloud layer whenever connectivity is available,
  with retry + backoff on failed sync attempts (separate concern from the
  last-write-wins conflict policy below — this is about delivery, not
  conflicting values)
- Cross-device conflict handling: **last-write-wins** (accepted as
  sufficient for now; revisit only if it becomes a real problem)
- Bookmarks are a **separate, deliberate** action from continuous
  position — own table, user-labeled

### Ingestion & library
- Ingestion scans Synology + cloud sources, normalizes into a consistent
  internal book model (handles mixed M4B / MP3-folder formats)
- DRM-encumbered formats (e.g. Audible `.aax`/`.aaxc`) are explicitly
  **out of scope** — DRM-free audio only (M4B, MP3, etc.)
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
- `sources.credentials` (cloud source OAuth tokens/API keys) must be
  encrypted at rest, not stored as plaintext — this is the one place the
  data model holds third-party secrets
- Cloud source OAuth tokens need a refresh flow (expiry detection +
  re-auth) so ingestion scans don't silently start failing when a token
  lapses

### PWA platform concerns
- Service worker update strategy: explicit "update available, tap to
  refresh" UX — don't assume updates land silently and safely
- Accessibility: explicit VoiceOver support — audiobooks are a
  naturally accessibility-relevant use case, don't leave this implicit
- Confirm device scope: iPad is in scope by default (PWA behaves
  identically) unless explicitly restricted to iPhone
- Light/dark theme (2026-07-21): the install splash screen and OS chrome
  color before JS runs always use the manifest's baked-in dark-slate
  `theme_color`/`background_color` (`vite.config.ts`'s `VitePWA` config),
  regardless of the user's in-app theme choice — `vite-plugin-pwa`
  generates one static manifest at build time, no dual-manifest support.
  Only the runtime `<meta name="theme-color">` (wired to `ThemeContext`)
  reflects the live theme after first paint. Not worth solving.

## Operational notes (not code, but required for the system to work)

- Mac mini sleep/power settings must prevent the file-serving API from
  going dark during expected-use hours (disable sleep, or schedule sleep
  only for known-idle overnight hours) — this is the accepted primary
  mechanism (see decision below), not remote Wake-on-LAN
- Health-check/alerting on the file-serving API (a simple uptime ping is
  fine) so an unexpected outage is noticed rather than discovered when a
  user complains
- Periodic backup of the ingestion database (metadata, extracted artwork,
  match/relink history) — the source files on the NAS are already safe,
  but curation work (matches, edits, relinks) lives only in this database
- Periodically verify backups are actually restorable, not just taken —
  restore the latest backup into a scratch copy and spot-check it opens
  with sane data (e.g. row counts, a few known records). An untested
  backup can fail silently for months and only get discovered when
  actually needed; a quarterly manual check is enough at this scale

## Data model (current, Phase 1 scope)

```
sources
  id, type, label, credentials, path_scope

books
  id, source_id, file_path, audio_source, epub_source,
  status ('active' | 'missing'),
  series_name, series_number,  -- denormalized onto books rather than a
                                -- separate series table; accepted for now,
                                -- means series naming consistency across a
                                -- book's entries is a manual/ingestion
                                -- concern, not enforced by the schema
  artwork_thumb_path, artwork_full_path,
  volume_normalization_gain

chapters
  id, book_id, index, title, start_time, duration
  -- required by chapter-level downloads/position/navigation
  -- (downloads.chapter_id and progress at chapter granularity both
  -- reference this)

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
  `user_id`-scoped). When onboarding each family member, remember the PWA
  update gotcha found during initial deployment (2026-07-13): an installed
  Home Screen icon is its own service-worker context, separate from a
  Safari tab on the same device — if someone's installed app ever looks
  stuck on an old version, force-quitting Safari doesn't fix it, they need
  to swipe the installed app away from the app switcher and reopen it. The
  in-app "update available" banner (`UpdatePrompt.tsx`) should make this
  mostly moot going forward, but only once a device has loaded a version
  that includes that banner in the first place — a device stuck on a
  pre-`UpdatePrompt` build has to be manually unstuck once, the same way
  the Mac mini and the first iPad were.
- **Phase 2b — Metadata cleanup & online enrichment:** two-part project,
  in order (part 2 depends on part 1):
  1. Title/author cleaning: parse a canonical title + author out of messy
     source strings — leading track numbers, trailing `- Author - Year`
     suffixes, raw filename fragments (`01_light_of_other_days`). Same
     category of heuristic work as the M4B multi-part grouping and
     folder-derived author fixes already shipped in Phase 1. This is the
     harder and more valuable half — worth doing even without part 2, since
     it also cleans up remaining display-title messiness that
     folder-derived author didn't touch.
  2. Online lookup using the *cleaned* title/author to backfill genre and
     series data, both currently unreliable: `series_name`/`series_number`
     are scaffolded in the schema but ingestion never actually populates
     them (always null today); embedded genre tags were usable on well
     under 20% of a sampled 60-book set, the rest either missing or just
     saying "Audiobook"/"Unabridged" (not a real genre). Unblocks an actual
     Genre browse mode and a real Series browse view, both deferred earlier
     for lack of usable data.

     Research already done (see conversation from 2026-07-13, worth
     re-reading before starting): Open Library's search API matches
     reliably but only against a genuinely clean title/author — a raw
     messy title returns zero results, not a degraded fuzzy match, which
     is why part 1 is a hard prerequisite rather than optional polish.
     Google Books hit an anonymous-quota wall (needs a free API key to be
     usable). Audnexus has by far the best genre/category taxonomy (it's
     Audible's own) but turned out to be ASIN-only — no title/author search
     endpoint exists — so it only works as a later enrichment step once an
     ASIN is known some other way, not as the primary matcher.
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
- **Phase 6 — Remote wake automation:** on-demand Wake-on-LAN for the Mac
  mini, so it can sleep freely instead of being kept awake on a schedule.
  Requires an always-on device on the home network capable of running
  Tailscale to act as the local WoL relay (the current Synology DS413j
  can't — see accepted decision below). Blocked on acquiring that
  hardware; not worth building until then.
- **Speculative, not committed — native Mac apps:** brainstormed idea (see
  `Ozzbooks_Addendum` in the repo root for the original writeup): a
  Mac-mini "pseudo server" app plus a separate MacBook client app using
  `AVQueuePlayer`, additive to the existing Node API (no backend changes
  required), iOS stays PWA-only regardless (that platform constraint
  doesn't change). Originally motivated partly as a diagnostic tool for
  the recurring "playback loop" bug — that rationale is largely moot now:
  the loop was root-caused and fixed directly in the PWA (2026-07-14
  session — a scrubber/stall-watchdog logic bug, not a WebKit/PWA
  environment issue). What's left is a genuine "make the Mac experience
  feel more native" desire, but a lot of that gap (update-available
  banner, in-app navigation back to book details, download status
  visibility) is closeable through continued PWA polish at far lower
  ongoing cost than maintaining a second codebase in a different
  language/ecosystem. Hold off unless a concrete, specific need for
  native-level audio (not just "feels nicer") shows up, or PWA polish
  demonstrably hits a ceiling.

## Open / accepted decisions (don't relitigate without new information)

- Cross-device simultaneous playback: last-write-wins on position sync —
  accepted as sufficient
- CarPlay: unsupported, accepted platform limitation
- Extended offline (weeks, no connectivity): explicitly out of scope;
  short-gap resilience is the actual target
- Remote/on-demand Wake-on-LAN trigger for the Mac mini: **descoped**.
  The only other always-on home device is a Synology DS413j, which is
  too old (single-core, 256MB RAM, no DSM version that supports
  Tailscale or Docker) to act as a remote WoL relay without exposing it
  to the public internet — which defeats the Tailscale-only security
  model. Accepted approach instead: prevent Mac mini sleep during
  expected-use hours (or schedule sleep only overnight). WoL stays
  enabled on the mini as a manual, same-network fallback only. Revisit
  as **Phase 6** if always-on hardware capable of running Tailscale is
  added.
- Native wrapper (Capacitor etc.): explicit non-goal unless Phase 1
  validation testing proves the PWA approach unworkable
- DRM-encumbered audiobooks (e.g. Audible): out of scope. This is a
  DRM-free library only
- Cloud sync/auth hosting: **Neon (Postgres) + Render (API)**, both free
  tier — chosen over Railway (no longer free) and Supabase (free, but a
  project pauses after 7 days idle and needs a manual dashboard click to
  resume). Render's free web service spins down after ~15 min idle and
  takes 30-60s to wake on the next request — no action needed, it
  resolves itself automatically. Preferred over Supabase's pause
  specifically because it self-heals without requiring anyone to notice
  and intervene, consistent with this project's general preference for
  self-healing behavior over mechanisms that need manual attention.
  Revisit only if the cold-start delay becomes a real nuisance.
  **Update (2026-07-18): this happened** — the cold-start delay was
  blocking the whole app on open, at one point even returning a
  transient error (HTTP 520). A client-side fix shipped first
  (`AuthContext.tsx` now authenticates optimistically from the stored
  token instead of blocking on the cloud round-trip). A full migration
  of `cloud/` off Render+Neon onto the Mac mini is planned as the
  root-cause fix if the client-side mitigation isn't enough — see
  `Ozzbooks_Addendum_CloudMigration` for the full plan, not yet started.

- **Google Drive folder picker (2026-07-20, planned, not started).** The
  shipped Google Drive integration always auto-creates a fixed
  "OzzBooks Audiobooks" folder as the scan location, since the
  deliberately narrow `drive.file` OAuth scope (chosen to avoid Google's
  paid app-verification review) can't browse a user's existing Drive
  structure. Letting someone pick an *existing* folder instead requires
  Google's Picker API (which grants `drive.file` access to whatever gets
  picked, without a broader scope) — a real feature, not a small tweak:
  a new client-side widget integration, and a deliberate one-endpoint
  exception to "the Drive access token never reaches the browser" to
  hand Picker a short-lived token. See
  `Ozzbooks_Addendum_GoogleDrivePicker` for the full plan.
