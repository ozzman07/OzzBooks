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
    cloud
      .fetchMe(stored)
      .then((me) => {
        setToken(stored)
        setUser(me)
        setStatus('authenticated')
      })
      .catch((err) => {
        // Only an actual 401 means the token is invalid/expired — clear it.
        // A network error (cloud unreachable — status 0, or any other
        // failure) must NOT log the user out just because the cloud
        // service is briefly unreachable; that would defeat the whole
        // point of short-gap offline resilience. Stay optimistically
        // authenticated with the stored token; auth.user just won't be
        // populated until a call to the cloud succeeds.
        if (err instanceof cloud.CloudApiError && err.status === 401) {
          localStorage.removeItem(TOKEN_STORAGE_KEY)
          setStatus('unauthenticated')
        } else {
          setToken(stored)
          setStatus('authenticated')
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

  return (
    <AuthContext.Provider value={{ status, user, token, login, signup, logout, error }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
