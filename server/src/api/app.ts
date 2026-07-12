import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import cors from 'cors'
import { requireApiToken } from './auth.js'
import { healthRouter } from './routes/health.js'
import { sourcesRouter } from './routes/sources.js'
import { booksRouter } from './routes/books.js'
import { streamRouter } from './routes/stream.js'
import { artworkRouter } from './routes/artwork.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// server/src/api -> repo root -> app/dist
const frontendDist = path.resolve(__dirname, '../../../app/dist')

export function createApp() {
  const app = express()
  app.use(express.json())
  // Same-origin in production (this server serves the built frontend too —
  // see below), but the dev frontend runs on a different port, so JSON
  // fetch() calls need CORS. Token auth still gates actual data access.
  app.use(cors())

  app.use('/health', healthRouter)

  app.use('/api', requireApiToken)
  app.use('/api/sources', sourcesRouter)
  app.use('/api/books', booksRouter)
  app.use('/api/books', artworkRouter)
  app.use('/api/chapters', streamRouter)

  // Serves the built PWA from the same origin as the API when present, so
  // the whole app is one Tailscale Serve endpoint in production — no CORS
  // or separate base-URL config needed. Absent during backend-only dev.
  if (existsSync(frontendDist)) {
    app.use(express.static(frontendDist))
    app.use((req, res, next) => {
      if (req.method !== 'GET') return next()
      res.sendFile(path.join(frontendDist, 'index.html'))
    })
  }

  return app
}
