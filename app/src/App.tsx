import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { ThemeProvider } from './theme/ThemeContext'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { PlayerProvider } from './player/PlayerContext'
import { LibraryViewProvider } from './library/LibraryViewContext'
import { BottomNav } from './components/BottomNav'
import { UpdatePrompt } from './components/UpdatePrompt'
import { useAsync } from './hooks/useAsync'
import { fetchMyLibrary } from './api/cloudClient'
import { Auth } from './pages/Auth'
import { Library } from './pages/Library'
import { BookDetail } from './pages/BookDetail'
import { RelinkBook } from './pages/RelinkBook'
import { NowPlaying } from './pages/NowPlaying'
import { Settings } from './pages/Settings'
import { ActivityLog } from './pages/ActivityLog'
import { NeedsAttention } from './pages/NeedsAttention'
import { Playlists } from './pages/Playlists'
import { PlaylistDetail } from './pages/PlaylistDetail'

// Lazy-loaded — epub.js (+jszip, lodash, xmldom) adds well over 100KB
// gzipped, entirely dead weight for anyone who never opens an ebook. This
// keeps that cost out of the main bundle, fetched only when the route is
// actually visited.
const EbookReader = lazy(() => import('./pages/EbookReader').then((m) => ({ default: m.EbookReader })))

// The PWA's start_url is '/' (see vite.config.ts's manifest) — this is
// what actually opens on a cold launch. Landing on an empty My Library
// with no hint of the Store tab isn't a useful first screen, so this
// picks the more useful of the two based on whether the shelf has
// anything on it yet, then hands off to the real /library or /store
// route. Doesn't fight manual bottom-nav taps — those go straight to
// their own route and never pass through here again.
function RootRedirect() {
  const auth = useAuth()
  const result = useAsync(async () => {
    if (!auth.token) return true
    const items = await fetchMyLibrary(auth.token)
    return items.length === 0
  }, [])
  if (result.status === 'loading') {
    return <div className="pt-24 text-center text-muted">Loading…</div>
  }
  // On a failed fetch, default to the normal Library landing rather than
  // stranding the user on a blank screen — they can still reach Store
  // from the bottom nav.
  const isEmpty = result.status === 'success' && result.data
  return <Navigate replace to={isEmpty ? '/store' : '/library'} />
}

function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth()

  if (auth.status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-muted">Loading…</div>
  }
  if (auth.status === 'unauthenticated') {
    return <Auth />
  }
  return <>{children}</>
}

// The reader is deliberately full-screen/immersive (its own fixed e-ink
// background covering the whole viewport, see EbookReader.tsx) — the
// bottom tab bar floating on top of a page would break that and get in
// the way of the left/right tap-to-turn-page zones near the screen edges.
function AppShell() {
  const location = useLocation()
  const isReading = /^\/book\/[^/]+\/read$/.test(location.pathname)

  return (
    <div className="min-h-screen bg-app pt-[env(safe-area-inset-top)] text-primary">
      <Routes>
        <Route path="/" element={<RootRedirect />} />
        <Route path="/library" element={<Library />} />
        <Route path="/store" element={<Library />} />
        <Route path="/book/:bookId" element={<BookDetail />} />
        <Route path="/book/:bookId/relink" element={<RelinkBook />} />
        <Route
          path="/book/:bookId/read"
          element={
            <Suspense
              fallback={
                <div className="fixed inset-0 flex items-center justify-center text-sm" style={{ background: '#F2F0E9', color: '#1A1A1A' }}>
                  Loading…
                </div>
              }
            >
              <EbookReader />
            </Suspense>
          }
        />
        <Route path="/playlists" element={<Playlists />} />
        <Route path="/playlists/:playlistId" element={<PlaylistDetail />} />
        <Route path="/now-playing" element={<NowPlaying />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/activity-log" element={<ActivityLog />} />
        <Route path="/needs-attention" element={<NeedsAttention />} />
      </Routes>
      {!isReading && <BottomNav />}
    </div>
  )
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <UpdatePrompt />
        <AuthGate>
          <PlayerProvider>
            <LibraryViewProvider>
              <AppShell />
            </LibraryViewProvider>
          </PlayerProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  )
}
