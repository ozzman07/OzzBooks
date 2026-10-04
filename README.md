# OzzBooks

OzzBooks is a personal library and playback app for audiobooks, ebooks, and comics/graphic novels. It is designed as an installable iOS/iPad PWA that streams from a home-hosted NAS and cloud sources, keeps progress synchronized across devices, and works well even when connectivity is intermittent.

This project is intentionally not distributed through the App Store; it is meant to run as a web app installed to the Home Screen to avoid needing an Apple developer account.

## What it supports

- Audiobooks
- Ebooks
- Comics / graphic novels / CBR-CBZ content
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
| Playback | HTML5 audio for audiobooks; future EPUB and comic readers for text and image content |

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
- EPUB and book-position tracking
- CFI-based position synchronization
- Planned enhancement for richer ebook reading UX and fine-grained sync

### Comics and graphic novels
- Planned/active support for comic and graphic novel libraries
- Handles CBR/CBZ-style content as a first-class library category
- Separate reading flow from audiobook and ebook playback
- Supports page-image browsing for comics and graphic novels

### Library management
- Ingestion from multiple sources
- Metadata normalization and chapter extraction
- Duplicate detection across sources
- Cover artwork extraction and caching
- Search, sorting, series grouping, and filters
- Genre and narrator metadata management

### Sync and progress
- Position sync across devices
- Bookmarks and user annotations
- Cloud-backed state, even if the home library is temporarily unavailable
- Self-healing re-fetch of missing cached content

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

The project is currently focused on the core listening experience, but the design already anticipates future expansion:

- Multi-user support
- Better metadata cleanup and enrichment
- EPUB integration and sync with audio position
- Comics reader and page-based navigation
- Transcription and recap generation
- Remote wake automation for home infrastructure

## Validation approach

This project emphasizes practical validation over broad test automation:

- Verify audiobook downloads and storage behavior on real iOS hardware
- Test background playback and lock-screen controls on actual devices
- Validate comics storage and reading behavior once those flows are in place
- Keep automated tests focused on tricky ingestion and parsing logic

## Notes

This repository is a personal/family project, not a general-purpose commercial app. The design favors resilience, privacy, and simplicity over broad platform support or mass-market polish.

## License

See the repository license file for usage details.
