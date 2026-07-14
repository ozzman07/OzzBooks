import { Route, Routes } from 'react-router-dom'
import { AuthProvider, useAuth } from './auth/AuthContext'
import { PlayerProvider } from './player/PlayerContext'
import { LibraryViewProvider } from './library/LibraryViewContext'
import { BottomNav } from './components/BottomNav'
import { UpdatePrompt } from './components/UpdatePrompt'
import { Auth } from './pages/Auth'
import { Library } from './pages/Library'
import { BookDetail } from './pages/BookDetail'
import { NowPlaying } from './pages/NowPlaying'
import { Settings } from './pages/Settings'

function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth()

  if (auth.status === 'loading') {
    return <div className="flex min-h-screen items-center justify-center text-slate-400">Loading…</div>
  }
  if (auth.status === 'unauthenticated') {
    return <Auth />
  }
  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <UpdatePrompt />
      <AuthGate>
        <PlayerProvider>
          <LibraryViewProvider>
            <div className="min-h-screen bg-slate-950 text-slate-100">
              <Routes>
                <Route path="/" element={<Library />} />
                <Route path="/book/:bookId" element={<BookDetail />} />
                <Route path="/now-playing" element={<NowPlaying />} />
                <Route path="/settings" element={<Settings />} />
              </Routes>
              <BottomNav />
            </div>
          </LibraryViewProvider>
        </PlayerProvider>
      </AuthGate>
    </AuthProvider>
  )
}
