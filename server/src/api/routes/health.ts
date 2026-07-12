import { Router } from 'express'

export const healthRouter = Router()

// Deliberately unauthenticated — this is what a health-check/alerting probe
// (see Claude.md operational notes) hits to distinguish "reachable" from
// "asleep/down," without needing the API token.
healthRouter.get('/', (_req, res) => {
  res.json({ status: 'ok' })
})
