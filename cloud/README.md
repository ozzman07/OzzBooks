# OzzBooks cloud sync/auth layer

Hosted independently of the home network (see `../Claude.md` architecture)
— e.g. Supabase/Railway/Neon-style managed Postgres, anywhere reachable
over the public internet. This is deliberately a separate deployable
service from `../server` (the Mac mini file-serving API): it owns
accounts, playback position, bookmarks, and settings, and stays available
even if the home network or Mac mini is down.

## Requires

- Node 20+
- A Postgres database (14+)

## Develop

```bash
npm install
cp .env.example .env.local   # fill in DATABASE_URL and OZZBOOKS_JWT_SECRET
npm run dev                  # runs migrations automatically on startup
```

Or run migrations standalone: `npm run migrate`.

## API

- `POST /auth/signup` `{ email, password }` → `{ token, user }`
- `POST /auth/login` `{ email, password }` → `{ token, user }`
- `GET /auth/me` — resolve the current user from the token

All `/sync/*` routes require `Authorization: Bearer <token>`:

- `GET /sync/progress` — all progress rows (Library's Continue Listening shelf)
- `GET /sync/progress/:bookId` / `PUT /sync/progress/:bookId` `{ position, chapterId, updatedAt }`
  — last-write-wins by `updatedAt` (the position's on-device capture time,
  not server receive time); a stale write gets `409` with the current
  (newer) row so the client can reconcile
- `GET /sync/bookmarks?bookId=` / `POST /sync/bookmarks` / `DELETE /sync/bookmarks/:id`
  — a deliberate, separate action from continuous progress, never
  overwritten by a progress sync
- `GET /sync/settings` / `PUT /sync/settings`
- `GET /sync/downloads` / `PUT /sync/downloads/:bookId/:chapterId` / `DELETE /sync/downloads/:bookId/:chapterId`
  — cross-device record; local IndexedDB (`last_played_at`) is the actual
  LRU eviction driver per Claude.md, this is a mirror

`annotations`, `reading_prefs`, and `book_position_map` tables exist in
the schema (scaffolded ahead of Phase 4/3c per Claude.md) but have no
endpoints yet — don't remove them for being unused.

## Test

```bash
npm test
```

Runs against a real Postgres database
(`postgres://ozzbooks:ozzbooks_dev@localhost:5432/ozzbooks_cloud_test` by
default), truncating tables first — not mocked.
