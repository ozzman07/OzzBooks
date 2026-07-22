import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'

export function Auth() {
  const auth = useAuth()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    try {
      if (mode === 'login') await auth.login(email, password)
      else await auth.signup(email, password)
    } catch {
      // auth.error is already set for display below
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-6">
      <h1 className="mb-1 text-center text-2xl font-semibold text-primary">OzzBooks</h1>
      <p className="mb-8 text-center text-sm text-muted">
        {mode === 'login' ? 'Log in to your library' : 'Create your account'}
      </p>

      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="rounded-lg border border-border-strong bg-surface px-4 py-3 text-primary placeholder:text-subtle"
        />
        <input
          type="password"
          required
          minLength={mode === 'signup' ? 8 : undefined}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="rounded-lg border border-border-strong bg-surface px-4 py-3 text-primary placeholder:text-subtle"
        />

        {auth.error && <p className="text-sm text-red-400">{auth.error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="mt-2 rounded-lg bg-amber-400 py-3 font-medium text-slate-950 disabled:opacity-40"
        >
          {mode === 'login' ? 'Log in' : 'Sign up'}
        </button>
      </form>

      <button
        onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}
        className="mt-4 text-center text-sm text-muted"
      >
        {mode === 'login' ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
      </button>
    </div>
  )
}
