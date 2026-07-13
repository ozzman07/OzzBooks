import type { NextFunction, Request, Response } from 'express'
import { config } from '../config.js'

/**
 * Lightweight token check as defense-in-depth beyond Tailscale network
 * gating (see Claude.md "Auth & security") — not a full user auth system,
 * that lives in the separate cloud sync/auth layer.
 *
 * Accepts the token via `Authorization: Bearer` (used by fetch-based JSON
 * calls) or a `?token=` query param (needed for <audio>/<img> src
 * attributes, which can't set custom headers).
 */
export function requireApiToken(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization')
  const headerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  const token = headerToken ?? (typeof req.query.token === 'string' ? req.query.token : null)

  if (token !== config.apiToken) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  next()
}
