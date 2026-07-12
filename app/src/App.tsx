import { Route, Routes } from 'react-router-dom'
import { PlayerProvider } from './player/PlayerContext'
import { BottomNav } from './components/BottomNav'
import { Library } from './pages/Library'
import { BookDetail } from './pages/BookDetail'
import { NowPlaying } from './pages/NowPlaying'
import { Settings } from './pages/Settings'

export default function App() {
  return (
    <PlayerProvider>
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <Routes>
          <Route path="/" element={<Library />} />
          <Route path="/book/:bookId" element={<BookDetail />} />
          <Route path="/now-playing" element={<NowPlaying />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
        <BottomNav />
      </div>
    </PlayerProvider>
  )
}
