import { useState } from 'react'
import { usePlayer } from '../player/PlayerContext'
import { CoverArt } from '../components/CoverArt'
import { formatClock } from '../lib/format'

const SLEEP_OPTIONS_MIN = [15, 30, 45, 60]

export function NowPlaying() {
  const player = usePlayer()
  const [showSleepMenu, setShowSleepMenu] = useState(false)
  const { book, chapter } = player

  if (!book || !chapter) {
    return (
      <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-2 px-4 pb-24 pt-24 text-center text-slate-400">
        <p className="text-lg">Nothing playing</p>
        <p className="text-sm">Pick a book from your library to get started.</p>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-md px-6 pb-28 pt-8">
      <div className="mx-auto w-56">
        <CoverArt title={book.title} coverUrl={book.coverFullUrl} />
      </div>

      <div className="mt-6 text-center">
        <p className="text-lg font-semibold text-slate-50">{book.title}</p>
        <p className="text-sm text-slate-400">{book.author}</p>
        <p className="mt-1 text-sm text-amber-400">{chapter.title}</p>
      </div>

      <div className="mt-6">
        <input
          type="range"
          min={0}
          max={player.duration || 0}
          value={player.currentTime}
          onChange={(e) => player.seek(Number(e.target.value))}
          className="w-full accent-amber-400"
          aria-label="Seek"
        />
        <div className="flex justify-between text-xs text-slate-400">
          <span>{formatClock(player.currentTime)}</span>
          <span>{formatClock(player.duration)}</span>
        </div>
      </div>

      <div className="mt-6 flex items-center justify-center gap-6">
        <button
          onClick={player.prevChapter}
          className="text-2xl text-slate-300"
          aria-label="Previous chapter"
        >
          ⏮
        </button>
        <button onClick={() => player.skip(-15)} className="text-xl text-slate-300" aria-label="Back 15 seconds">
          15↺
        </button>
        <button
          onClick={player.togglePlay}
          className="flex h-16 w-16 items-center justify-center rounded-full bg-amber-400 text-2xl text-slate-950"
          aria-label={player.isPlaying ? 'Pause' : 'Play'}
        >
          {player.isPlaying ? '⏸' : '▶'}
        </button>
        <button onClick={() => player.skip(30)} className="text-xl text-slate-300" aria-label="Forward 30 seconds">
          30↻
        </button>
        <button onClick={player.nextChapter} className="text-2xl text-slate-300" aria-label="Next chapter">
          ⏭
        </button>
      </div>

      <div className="mt-8 flex flex-col gap-4">
        <label className="flex items-center justify-between text-sm text-slate-300">
          <span>Speed</span>
          <span className="tabular-nums text-slate-400">{player.playbackRate.toFixed(2)}x</span>
        </label>
        <input
          type="range"
          min={0.5}
          max={3}
          step={0.05}
          value={player.playbackRate}
          onChange={(e) => player.setPlaybackRate(Number(e.target.value))}
          className="w-full accent-amber-400"
          aria-label="Playback speed"
        />

        <label className="flex items-center justify-between text-sm text-slate-300">
          <span>Skip silence</span>
          <input
            type="checkbox"
            checked={player.skipSilenceEnabled}
            onChange={player.toggleSkipSilence}
            className="h-5 w-5 accent-amber-400"
          />
        </label>

        <div className="relative">
          <button
            onClick={() => setShowSleepMenu((v) => !v)}
            className="w-full rounded-lg border border-slate-700 py-2 text-sm text-slate-300"
          >
            Sleep timer
            {player.sleepTimer?.kind === 'duration' &&
              ` — ${Math.ceil(player.sleepTimer.remainingSeconds / 60)}m left`}
            {player.sleepTimer?.kind === 'end-of-chapter' && ' — end of chapter'}
          </button>
          {showSleepMenu && (
            <div className="absolute inset-x-0 z-20 mt-2 rounded-lg border border-slate-700 bg-slate-900 p-2 shadow-lg">
              {SLEEP_OPTIONS_MIN.map((min) => (
                <button
                  key={min}
                  className="block w-full rounded px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
                  onClick={() => {
                    player.startSleepTimer({ kind: 'duration', remainingSeconds: min * 60 })
                    setShowSleepMenu(false)
                  }}
                >
                  {min} minutes
                </button>
              ))}
              <button
                className="block w-full rounded px-3 py-2 text-left text-sm text-slate-200 hover:bg-slate-800"
                onClick={() => {
                  player.startSleepTimer({ kind: 'end-of-chapter' })
                  setShowSleepMenu(false)
                }}
              >
                End of chapter
              </button>
              <button
                className="block w-full rounded px-3 py-2 text-left text-sm text-red-400 hover:bg-slate-800"
                onClick={() => {
                  player.startSleepTimer(null)
                  setShowSleepMenu(false)
                }}
              >
                Off
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
