import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'

const THEME_STORAGE_KEY = 'ozzbooks_theme_preference'

export type ThemePreference = 'light' | 'dark' | 'system'
type ResolvedTheme = 'light' | 'dark'

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)'
const THEME_COLOR_META = { light: '#ffffff', dark: '#1e293b' } as const

function systemPrefersDark(): boolean {
  return window.matchMedia(DARK_MEDIA_QUERY).matches
}

function resolve(pref: ThemePreference): ResolvedTheme {
  return pref === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : pref
}

function readStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_STORAGE_KEY)
  return stored === 'light' || stored === 'dark' || stored === 'system' ? stored : 'system'
}

function applyResolvedTheme(resolved: ResolvedTheme): void {
  document.documentElement.classList.toggle('dark', resolved === 'dark')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR_META[resolved])
}

interface ThemeContextValue {
  preference: ThemePreference
  resolvedTheme: ResolvedTheme
  setPreference: (pref: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference)
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolve(preference))

  useEffect(() => {
    applyResolvedTheme(resolvedTheme)
  }, [resolvedTheme])

  // Only listens while "system" is active — a live OS theme change should
  // follow along, but an explicit light/dark choice shouldn't be disturbed
  // by the OS switching underneath it.
  useEffect(() => {
    if (preference !== 'system') return
    const mql = window.matchMedia(DARK_MEDIA_QUERY)
    const onChange = () => setResolvedTheme(systemPrefersDark() ? 'dark' : 'light')
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [preference])

  const setPreference = useCallback((pref: ThemePreference) => {
    localStorage.setItem(THEME_STORAGE_KEY, pref)
    setPreferenceState(pref)
    // Applied synchronously (not left to the effect above) so clicking the
    // Appearance toggle updates the page on the same frame, no lag.
    setResolvedTheme(resolve(pref))
  }, [])

  return (
    <ThemeContext.Provider value={{ preference, resolvedTheme, setPreference }}>{children}</ThemeContext.Provider>
  )
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
