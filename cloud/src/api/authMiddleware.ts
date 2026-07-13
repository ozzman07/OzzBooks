import type { NextFunction, Request, Response } from 'express'
import { verifyToken } from '../auth/tokens.js'

declare global {
  namespace Express {
    interface Request {
      userId?: string
    }
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization')
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null
  const payload = token ? verifyToken(token) : null

  if (!payload) {
    res.status(401).json({ error: 'unauthorized' })
    return
  }

  req.userId = payload.userId
  next()
}
