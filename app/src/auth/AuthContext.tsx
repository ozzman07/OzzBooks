import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import * as cloud from '../api/cloudClient'

const TOKEN_STORAGE_KEY = 'ozzbooks_auth_token'

type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated'

interface AuthContextValue {
  status: AuthStatus
  user: cloud.AuthUser | null
  token: string | null
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<void>
  logout: () => void
  error: string | null
  /** Throws cloud.CloudApiError on failure (e.g. wrong current password) —
   * left for the caller to catch and display locally, unlike login/signup's
   * shared `error` state, since these are used from a settings form rather
   * than the auth screen. */
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>
  changeEmail: (newEmail: string, currentPassword: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading')
  const [user, setUser] = useState<cloud.AuthUser | null>(null)
  const [token, setToken] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY)
    if (!stored) {
      setStatus('unauthenticated')
      return
    }
    // Optimistically authenticated the instant a stored token exists,
    // rather than blocking the whole app behind a "Loading…" screen for
    // however long the cloud round-trip takes to confirm it — the cloud
    // service's free tier can take 30-60s to wake from idle (accepted
    // tradeoff, see Claude.md), and can even return a transient error on
    // that first wake-up request. fetchMe() still runs, just in the
    // background: it populates `user` once it succeeds, and a genuine
    // 401 (token actually invalid/expired) still logs out — just
    // asynchronously instead of blocking first paint on confirming
    // validity. Any other failure (cloud unreachable, cold-start
    // hiccup) is left alone, matching the existing "don't log out just
    // because the cloud is briefly unreachable" principle, just applied
    // from the start instead of only after a failed round-trip.
    setToken(stored)
    setStatus('authenticated')
    cloud
      .fetchMe(stored)
      .then((me) => setUser(me))
      .catch((err) => {
        if (err instanceof cloud.CloudApiError && err.status === 401) {
          localStorage.removeItem(TOKEN_STORAGE_KEY)
          setToken(null)
          setUser(null)
          setStatus('unauthenticated')
        }
      })
  }, [])

  const applyAuthResponse = useCallback((res: cloud.AuthResponse) => {
    localStorage.setItem(TOKEN_STORAGE_KEY, res.token)
    setToken(res.token)
    setUser(res.user)
    setStatus('authenticated')
  }, [])

  const login = useCallback(
    async (email: string, password: string) => {
      setError(null)
      try {
        applyAuthResponse(await cloud.login(email, password))
      } catch (err) {
        setError(err instanceof cloud.CloudApiError ? err.message : 'Could not reach the server')
        throw err
      }
    },
    [applyAuthResponse],
  )

  const signup = useCallback(
    async (email: string, password: string) => {
      setError(null)
      try {
        applyAuthResponse(await cloud.signup(email, password))
      } catch (err) {
        setError(err instanceof cloud.CloudApiError ? err.message : 'Could not reach the server')
        throw err
      }
    },
    [applyAuthResponse],
  )

  const logout = useCallback(() => {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    setToken(null)
    setUser(null)
    setStatus('unauthenticated')
  }, [])

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (!token) throw new Error('not authenticated')
      await cloud.changePassword(token, currentPassword, newPassword)
    },
    [token],
  )

  const changeEmail = useCallback(
    async (newEmail: string, currentPassword: string) => {
      if (!token) throw new Error('not authenticated')
      const updated = await cloud.changeEmail(token, newEmail, currentPassword)
      setUser(updated)
    },
    [token],
  )

  return (
    <AuthContext.Provider
      value={{ status, user, token, login, signup, logout, error, changePassword, changeEmail }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
