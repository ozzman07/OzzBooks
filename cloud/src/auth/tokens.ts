import jwt from 'jsonwebtoken'
import { config } from '../config.js'

export interface TokenPayload {
  userId: string
}

// Long-lived on purpose — this is a family app, not a bank; the "no
// repeated logins" experience already established for Tailscale (see
// Claude.md "User access model") should hold for app-level auth too.
const EXPIRY = '90d'

export function signToken(payload: TokenPayload): string {
  return jwt.sign(payload, config.jwtSecret, { expiresIn: EXPIRY })
}

export function verifyToken(token: string): TokenPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as TokenPayload
  } catch {
    return null
  }
}
