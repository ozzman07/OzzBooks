import { Router } from 'express'
import { startEnrichment, getEnrichmentState } from '../../ingestion/enrichment/enrichmentStatus.js'

export const enrichmentRouter = Router()

// Fire-and-forget, mirroring sources.ts's POST /:id/scan — a real pass is
// rate-limited to ~1 request/second against Open Library and can run for
// minutes to tens of minutes, so this returns immediately rather than
// blocking. Poll GET /status for progress/result instead.
enrichmentRouter.post('/start', (_req, res) => {
  res.status(202).json(startEnrichment())
})

enrichmentRouter.get('/status', (_req, res) => {
  res.json(getEnrichmentState())
})
