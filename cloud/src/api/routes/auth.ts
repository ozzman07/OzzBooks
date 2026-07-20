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
  await getPool().query("INSERT INTO playlists (owner_id, name, is_reserved) VALUES ($1, 'Up Next', true)", [
    user.id,
  ])

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

// No password-reset/email flow exists (no mail-sending infra in this
// project) — this is the self-service alternative: change either while
// still logged in and able to prove you know the current password. Tokens
// only encode userId, not email/password, so an existing session stays
// valid across either change — no forced re-login.
authRouter.patch('/password', requireAuth, async (req, res) => {
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : null
  const newPassword = typeof req.body?.newPassword === 'string' ? req.body.newPassword : null

  if (!currentPassword || !newPassword || newPassword.length < 8) {
    res.status(400).json({ error: 'current password and a new password of at least 8 characters are required' })
    return
  }

  const result = await getPool().query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId])
  const user = result.rows[0]
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    res.status(401).json({ error: 'current password is incorrect' })
    return
  }

  const newHash = await hashPassword(newPassword)
  await getPool().query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, req.userId])
  res.status(204).end()
})

authRouter.patch('/email', requireAuth, async (req, res) => {
  const newEmail = normalizeEmail(req.body?.newEmail)
  const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : null

  if (!newEmail || !currentPassword) {
    res.status(400).json({ error: 'a valid new email and current password are required' })
    return
  }

  const result = await getPool().query<UserRow>('SELECT * FROM users WHERE id = $1', [req.userId])
  const user = result.rows[0]
  if (!user || !(await verifyPassword(currentPassword, user.password_hash))) {
    res.status(401).json({ error: 'current password is incorrect' })
    return
  }

  try {
    const updated = await getPool().query<UserRow>('UPDATE users SET email = $1 WHERE id = $2 RETURNING id, email', [
      newEmail,
      req.userId,
    ])
    res.json({ id: updated.rows[0].id, email: updated.rows[0].email })
  } catch (err) {
    if ((err as { code?: string }).code === '23505') {
      // Postgres unique_violation
      res.status(409).json({ error: 'an account with that email already exists' })
      return
    }
    throw err
  }
})
