import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { usePlayer } from '../player/PlayerContext'
import { CoverArt } from '../components/CoverArt'
import { formatClock, formatDuration } from '../lib/format'

const SLEEP_OPTIONS_MIN = [15, 30, 45, 60]
// A dragged <input type="range"> fires onChange continuously — many times
// per second, not just on release. Calling player.seek() on every one of
// those was setting audio.currentTime dozens of times in rapid succession,
// which is exactly the kind of thrashing that can overwhelm a media
// element's decode pipeline and produce a stuck/looping state (this was
// the actual cause of the "scrubbing gets stuck in a loop" bug — the skip
// buttons only ever call seek() once, which is why they never triggered
// it). Debouncing so the real seek only fires once the value settles fixes
// it at the source, for every input method (drag, keyboard) at once.
const SCRUB_DEBOUNCE_MS = 200

export function NowPlaying() {
  const player = usePlayer()
  const [showSleepMenu, setShowSleepMenu] = useState(false)
  const [scrubValue, setScrubValue] = useState<number | null>(null)
  const { book, chapter, isBuffering, streamError, finished } = player

  useEffect(() => {
    if (scrubValue === null) return
    const id = setTimeout(() => {
      player.seek(scrubValue)
      setScrubValue(null)
    }, SCRUB_DEBOUNCE_MS)
    return () => clearTimeout(id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubValue])

  const bookRemaining = (() => {
    if (!book || !chapter) return null
    const chapterIdx = book.chapters.findIndex((c) => c.id === chapter.id)
    const elapsedBeforeChapter = book.chapters.slice(0, chapterIdx).reduce((sum, c) => sum + c.duration, 0)
    return Math.max(0, book.totalDuration - (elapsedBeforeChapter + (scrubValue ?? player.currentTime)))
  })()

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
      <Link
        to={`/book/${book.id}`}
        className="mb-4 inline-flex items-center gap-1 rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300"
      >
        <span aria-hidden="true">‹</span> Book details &amp; downloads
      </Link>

      <div className="mx-auto w-56">
        <CoverArt title={book.title} coverUrl={book.coverFullUrl} />
      </div>

      <div className="mt-6 text-center">
        <p className="text-lg font-semibold text-slate-50">{book.title}</p>
        <p className="text-sm text-slate-400">{book.author}</p>
        <p className="mt-1 text-sm text-amber-400">{chapter.title}</p>
      </div>

      {isBuffering && (
        <p className="mt-3 text-center text-xs text-slate-400" role="status">
          Loading…
        </p>
      )}

      {streamError && (
        <div className="mt-3 rounded-lg border border-red-900/60 bg-red-900/20 px-3 py-2 text-center">
          <p className="text-xs text-red-300">{streamError}</p>
          <button onClick={player.retryLoad} className="mt-1 text-xs font-medium text-amber-400 underline">
            Retry
          </button>
        </div>
      )}

      {finished && (
        <p className="mt-3 text-center text-xs text-slate-400" role="status">
          You've finished this book.
        </p>
      )}

      <div className="mt-6">
        <input
          type="range"
          min={0}
          max={player.duration || 0}
          value={scrubValue ?? player.currentTime}
          onChange={(e) => setScrubValue(Number(e.target.value))}
          className="w-full accent-amber-400"
          aria-label="Seek"
        />
        <div className="flex justify-between text-xs text-slate-400">
          <span>{formatClock(scrubValue ?? player.currentTime)}</span>
          <span>{formatClock(player.duration)}</span>
        </div>
        {book.chapters.length > 1 && bookRemaining !== null && (
          <p className="mt-1 text-center text-xs text-slate-500">{formatDuration(bookRemaining)} left in book</p>
        )}
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
