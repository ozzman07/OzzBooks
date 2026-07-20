import express from 'express'
import cors from 'cors'
import { authRouter } from './routes/auth.js'
import { progressRouter } from './routes/progress.js'
import { bookmarksRouter } from './routes/bookmarks.js'
import { settingsRouter } from './routes/settings.js'
import { downloadsRouter } from './routes/downloads.js'
import { playlistsRouter } from './routes/playlists.js'

export function createApp() {
  const app = express()
  app.use(cors())
  app.use(express.json())

  app.get('/health', (_req, res) => res.json({ status: 'ok' }))

  app.use('/auth', authRouter)
  app.use('/sync/progress', progressRouter)
  app.use('/sync/bookmarks', bookmarksRouter)
  app.use('/sync/settings', settingsRouter)
  app.use('/sync/downloads', downloadsRouter)
  app.use('/sync/playlists', playlistsRouter)

  return app
}
