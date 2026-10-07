// One-off password reset — run with: npx tsx scripts/reset-password.ts <email> <newPassword>
// Uses the app's own hashPassword() (bcryptjs, same SALT_ROUNDS as signup/login)
// so the result is fully compatible with the normal login route — not a raw
// hand-rolled hash.
import { Pool } from 'pg'
import { hashPassword } from '../src/auth/passwords.js'

async function main() {
  const [email, newPassword] = process.argv.slice(2)
  if (!email || !newPassword || newPassword.length < 8) {
    console.error('Usage: npx tsx scripts/reset-password.ts <email> <newPassword (min 8 chars)>')
    process.exit(1)
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const existing = await pool.query('SELECT id, email FROM users WHERE email = $1', [email.toLowerCase()])
  if (existing.rows.length === 0) {
    console.error(`No user found with email ${email}`)
    await pool.end()
    process.exit(1)
  }

  const newHash = await hashPassword(newPassword)
  await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [newHash, email.toLowerCase()])
  console.log(`Password reset for ${email}.`)
  await pool.end()
}

void main()
