import express from 'express'
import cors from 'cors'
import { authRouter } from './routes/auth.js'
import { progressRouter } from './routes/progress.js'
import { bookmarksRouter } from './routes/bookmarks.js'
import { settingsRouter } from './routes/settings.js'
import { downloadsRouter } from './routes/downloads.js'
import { playlistsRouter } from './routes/playlists.js'
import { libraryRouter } from './routes/library.js'

export function createApp() {
  const app = express()
  app.use(cors())
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  // Every response here is live per-user state (progress, settings,
  // playlists) — never let a browser's HTTP cache serve a stale copy
  // across requests. Missing until now (the local Mac mini API already
  // does this for its own /api/* routes) — a real, found-in-practice gap:
  // an ebook reader's saved position appearing to jump backward after
  // backgrounding/reopening is exactly the symptom a stale cached GET
  // /sync/progress/:bookId response would produce, since without this
  // header a plain fetch() has no signal telling it not to reuse one.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store')
    next()
  })

  app.use('/auth', authRouter)
  app.use('/sync/progress', progressRouter)
  app.use('/sync/bookmarks', bookmarksRouter)
  app.use('/sync/settings', settingsRouter)
  app.use('/sync/downloads', downloadsRouter)
  app.use('/sync/playlists', playlistsRouter)
  app.use('/sync/library', libraryRouter)

  return app
}
