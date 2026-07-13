# OzzBooks file-serving API

Runs on the Mac mini (see `../Claude.md`). Scans configured sources
(Synology NAS, cloud folders), builds a local ingestion database
(sources/books/chapters), and serves library metadata + audio streams —
exposed to devices over Tailscale, not the public internet.

This is **not** the cloud sync/auth layer (users, progress, bookmarks,
downloads) — that's a separate, cloud-hosted service per the architecture
in Claude.md. This service only owns the ingestion side.

## Requires

- Node 20+
- `ffmpeg`/`ffprobe` on PATH (used for M4B duration + chapter extraction;
  `brew install ffmpeg` on macOS)

## Develop

```bash
npm install
npm run dev
```

Env vars (see `src/config.ts`):

- `PORT` — default 4100
- `OZZBOOKS_DATA_DIR` — where the SQLite ingestion DB + extracted artwork
  live, default `./data`
- `OZZBOOKS_API_TOKEN` — required in production; every `/api/*` request
  must send `Authorization: Bearer <token>` (defense-in-depth beyond
  Tailscale network gating — see Claude.md "Auth & security")

## API

- `GET /health` — unauthenticated, for uptime/wake-on-LAN health checks
- `POST /api/sources` `{ type, label, pathScope }` — register a source
- `PATCH /api/sources/:id` `{ label?, pathScope? }` — edit in place
- `POST /api/sources/:id/scan` — scan/rescan that source
- `GET /api/books` / `GET /api/books/:id` — library listing / detail with chapters
- `GET /api/chapters/:id/stream` — audio bytes, supports HTTP Range
- `GET /api/books/:id/artwork/:size` — `thumb` or `full`, 404 if none extracted

Auth token can also be passed as `?token=` (needed for `<audio>`/`<img>`
elements, which can't set custom headers) — see `src/api/auth.ts`.

## Serving the frontend

If `../app/dist` exists (i.e. you've run `npm run build` in `../app`),
this server serves it directly as static files with an SPA fallback, so
the whole thing is one origin/one Tailscale Serve endpoint in production.
No `dist` there yet → this is skipped, useful for backend-only dev.

## Test

```bash
npm test
```

Tests build real MP3/M4B fixtures with `ffmpeg` (including embedded M4B
chapter markers) and exercise ingestion + the HTTP API end-to-end —
no mocked file formats.
