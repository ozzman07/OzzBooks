# OzzBooks

OzzBooks is a personal library and playback app for audiobooks, ebooks, and comics/graphic novels. It is designed as an installable iOS/iPad PWA that streams from a home-hosted NAS and cloud sources, keeps progress synchronized across devices, and works well even when connectivity is intermittent.

This project is intentionally not distributed through the App Store; it is meant to run as a web app installed to the Home Screen to avoid needing an Apple developer account.

## What it supports

- Audiobooks
- Ebooks
- Comics / graphic novels (CBZ; CBR requires a manual conversion first)
- Home-hosted library sources (Synology NAS, local storage, cloud-synced folders)
- Offline playback and chapter-level cache for short network outages
- Cross-device sync of progress, bookmarks, and settings

## Core principles

- Keep the source-of-truth library at home on a NAS or local machine
- Use a small cloud layer only for account state and sync metadata
- Prefer resilient, self-healing behavior over brittle offline assumptions
- Optimize for iPhone/iPad PWA behavior rather than native app expectations

## Architecture

| Layer | Choice |
|---|---|
| File storage | Synology NAS + cloud sources (Dropbox, Google Drive, others) |
| File-serving API | Mac mini exposed via Tailscale + Tailscale Serve |
| Sync/auth layer | Cloud-hosted Postgres + API, independent of home network uptime |
| Frontend | PWA installed via Add to Home Screen |
| Playback | HTML5 audio for audiobooks; epub.js-based EPUB reader; page-image comic reader for CBZ |

## Key features

### Audiobooks and listening
- Play/pause, skip forward/back, scrub, chapter navigation
- Variable playback speed
- Sleep timer
- Skip silence toggle
- Lock-screen and Bluetooth remote controls via Media Session API
- Background prefetch of nearby chapters
- Offline playback from cached chapter blobs
- Download management and storage budgeting

### Ebook support
- Full EPUB reader (epub.js) with CFI-based position tracking and sync
- Reading themes (e-ink, dark, sepia), font size, and line spacing
- Table of contents navigation
- Planned: highlights/notes, and fine-grained CFI-level sync with the
  matching audiobook edition's position

### Comics and graphic novels
- CBZ is a first-class library format, with its own page-image reader
  separate from audiobook/ebook playback
- CBR is detected but not auto-converted — flagged as a scan issue
  asking for a manual CBZ conversion, not yet ingested automatically
- Comic-specific metadata (writer, penciller, publisher, story arc) read
  from ComicInfo.xml

### Library management
- Ingestion from multiple sources
- Metadata normalization and chapter extraction
- Duplicate detection across sources
- Cover artwork extraction and caching
- Search, sorting, series grouping, and filters
- Genre and narrator metadata management, with a manual-pin system so a
  correction survives future rescans instead of being silently
  overwritten
- Per-book online metadata lookup (Open Library) with a human-reviewed
  candidate picker
- Sagas: multi-series reading-order collections (e.g. an author's whole
  shared universe) layered on top of per-series ordering
- Audio/ebook companion linking, with shared metadata (title, author,
  series, genre, synopsis, cover) kept in sync between the two

### Sync and progress
- Position sync across devices
- Bookmarks (own table, user-labeled, separate from continuous position)
- Cloud-backed state, even if the home library is temporarily unavailable
- Self-healing re-fetch of missing cached content
- Highlights/notes are planned but not yet built (see Roadmap)

## Platform constraints and design decisions

OzzBooks is built around real-world constraints on iPhone and iPad:

- iOS uses WebKit for all browsers, including installed PWA apps
- File System Access APIs are limited in Safari, so offline storage relies on IndexedDB and app-private storage
- Storage is best-effort, not guaranteed forever, so the app is designed for short outages rather than months-long offline use
- CarPlay and some native-only behaviors are not available in a PWA
- The app intentionally avoids native wrappers to keep delivery simple and to stay outside the App Store model

## Repository structure

- `app/` — frontend PWA
- `server/` — library ingestion, streaming API, metadata processing, sync logic
- `cloud/` — cloud-hosted auth and sync services
- `Claude.md` — full project design notes, architecture rationale, and roadmap
- `Ozzbooks_Addendum_*` — detailed feature write-ups for migration, comics, Google Drive, playlists, and more

## Roadmap

Core listening, reading, and comics browsing are built. What's left:

- Multi-user support (real per-user permissions/ownership)
- Highlights and notes in the ebook reader
- Fine-grained, CFI-level sync between an audiobook and its matching
  ebook edition's position (today's audio↔ebook linking is companion-row
  level, not position level)
- Local transcription pipeline and recap generation, built on it
- Remote wake automation for home infrastructure
- Automatic CBR→CBZ conversion at ingestion (currently manual)

## Validation approach

This project emphasizes practical validation over broad test automation:

- Verify audiobook downloads and storage behavior on real iOS hardware
- Test background playback and lock-screen controls on actual devices
- Validate comics storage and reading behavior on real iOS hardware — a different storage shape than audio/ebook (many small page-image blobs instead of one or two large ones), not yet verified separately
- Keep automated tests focused on tricky ingestion and parsing logic

## Notes

This repository is a personal/family project, not a general-purpose commercial app. The design favors resilience, privacy, and simplicity over broad platform support or mass-market polish.

## License

No license file is currently included in this repository — it's a private, personal/family project, not published for reuse.
