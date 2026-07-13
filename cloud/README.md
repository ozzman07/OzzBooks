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

## Deploy (Neon + Render, both free)

**1. Database — Neon**
1. Create a free account at neon.tech
2. Create a project (any name, e.g. `ozzbooks`)
3. On the project dashboard, copy the connection string it gives you —
   it looks like `postgres://user:pass@ep-xxx.neon.tech/neondb?sslmode=require`.
   Use the **full string, including `?sslmode=require`** — that's how it
   connects securely, and `pg` (this project's Postgres driver) reads it
   straight out of the box.

**2. API — Render**
1. Create a free account at render.com and connect your GitHub account
2. New → Web Service → pick the `ozzbooks` repo
3. Set:
   - **Root Directory**: `cloud`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: `npm start`
   - **Instance Type**: Free
4. Add environment variables (Render → your service → Environment):
   - `DATABASE_URL` — the Neon connection string from step 1
   - `OZZBOOKS_JWT_SECRET` — a random secret; generate one locally with
     `openssl rand -hex 32` and paste the result. This signs login
     sessions — keep it private, never commit it.
5. Deploy. First boot runs the database migration automatically (see
   `src/server.ts`) — no manual migration step needed.
6. Render gives you a public URL like `https://ozzbooks-cloud.onrender.com`
   — that's what the frontend's `VITE_CLOUD_API_BASE_URL` should point to.

**Heads up on the free tier**: Render's free web services spin down after
~15 minutes idle and take 30-60 seconds to wake up on the next request —
no action needed, it just resolves itself slowly. This is expected, not
a bug — see the "Open / accepted decisions" section in `../Claude.md` for
why this tradeoff was chosen over Supabase's alternative (which pauses
and needs a manual dashboard click to resume instead).

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
