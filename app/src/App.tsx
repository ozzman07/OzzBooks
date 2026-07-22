import { Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './theme/ThemeContext'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { PlayerProvider } from './player/PlayerContext'
import { LibraryViewProvider } from './library/LibraryViewContext'
import { BottomNav } from './components/BottomNav'
import { UpdatePrompt } from './components/UpdatePrompt'
import { Auth } from './pages/Auth'
import { Library } from './pages/Library'
import { BookDetail } from './pages/BookDetail'
import { RelinkBook } from './pages/RelinkBook'
import { NowPlaying } from './pages/NowPlaying'
import { Settings } from './pages/Settings'
import { Playlists } from './pages/Playlists'
import { PlaylistDetail } from './pages/PlaylistDetail'

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

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <UpdatePrompt />
        <AuthGate>
          <PlayerProvider>
            <LibraryViewProvider>
              <div className="min-h-screen bg-app pt-[env(safe-area-inset-top)] text-primary">
                <Routes>
                  <Route path="/" element={<Library />} />
                  <Route path="/book/:bookId" element={<BookDetail />} />
                  <Route path="/book/:bookId/relink" element={<RelinkBook />} />
                  <Route path="/playlists" element={<Playlists />} />
                  <Route path="/playlists/:playlistId" element={<PlaylistDetail />} />
                  <Route path="/now-playing" element={<NowPlaying />} />
                  <Route path="/settings" element={<Settings />} />
                </Routes>
                <BottomNav />
              </div>
            </LibraryViewProvider>
          </PlayerProvider>
        </AuthGate>
      </AuthProvider>
    </ThemeProvider>
  )
}
