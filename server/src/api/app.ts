import express from 'express'
import { requireApiToken } from './auth.js'
import { healthRouter } from './routes/health.js'
import { sourcesRouter } from './routes/sources.js'
import { booksRouter } from './routes/books.js'
import { streamRouter } from './routes/stream.js'
import { artworkRouter } from './routes/artwork.js'

export function createApp() {
  const app = express()
  app.use(express.json())

  app.use('/health', healthRouter)

  app.use('/api', requireApiToken)
  app.use('/api/sources', sourcesRouter)
  app.use('/api/books', booksRouter)
  app.use('/api/books', artworkRouter)
  app.use('/api/chapters', streamRouter)

  return app
}
