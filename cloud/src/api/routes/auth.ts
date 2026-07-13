import { Router } from 'express'
import { getPool } from '../../db/index.js'
import { hashPassword, verifyPassword } from '../../auth/passwords.js'
import { signToken } from '../../auth/tokens.js'
import type { UserRow } from '../../types.js'
import { requireAuth } from '../authMiddleware.js'

export const authRouter = Router()

function normalizeEmail(email: unknown): string | null {
  if (typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  return trimmed.includes('@') ? trimmed : null
}

authRouter.post('/signup', async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const password = typeof req.body?.password === 'string' ? req.body.password : null

  if (!email || !password || password.length < 8) {
    res.status(400).json({ error: 'a valid email and a password of at least 8 characters are required' })
    return
  }

  const existing = await getPool().query<UserRow>('SELECT id FROM users WHERE email = $1', [email])
  if (existing.rows.length > 0) {
    res.status(409).json({ error: 'an account with that email already exists' })
    return
  }

  const passwordHash = await hashPassword(password)
  const result = await getPool().query<UserRow>(
    'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
    [email, passwordHash],
  )
  const user = result.rows[0]

  await getPool().query('INSERT INTO user_settings (user_id) VALUES ($1)', [user.id])

  res.status(201).json({ token: signToken({ userId: user.id }), user: { id: user.id, email: user.email } })
})

authRouter.post('/login', async (req, res) => {
  const email = normalizeEmail(req.body?.email)
  const password = typeof req.body?.password === 'string' ? req.body.password : null
  if (!email || !password) {
    res.status(400).json({ error: 'email and password are required' })
    return
  }

  const result = await getPool().query<UserRow>('SELECT * FROM users WHERE email = $1', [email])
  const user = result.rows[0]
  // Same error for "no such user" and "wrong password" — don't leak which
  // one it was.
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    res.status(401).json({ error: 'invalid email or password' })
    return
  }

  res.json({ token: signToken({ userId: user.id }), user: { id: user.id, email: user.email } })
})

authRouter.get('/me', requireAuth, async (req, res) => {
  const result = await getPool().query<UserRow>('SELECT id, email, created_at FROM users WHERE id = $1', [
    req.userId,
  ])
  const user = result.rows[0]
  if (!user) {
    res.status(404).json({ error: 'user not found' })
    return
  }
  res.json({ id: user.id, email: user.email, createdAt: user.created_at })
})
