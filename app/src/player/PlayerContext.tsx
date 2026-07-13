import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import type { Book, Chapter } from '../types'
import { useSkipSilence } from './useSkipSilence'
import { useAuth } from '../auth/AuthContext'
import { recordProgress } from '../offline/syncEngine'
import { getCachedAudioFile, touchLastPlayed } from '../offline/audioFileStore'
import { downloadChapter } from '../offline/downloadManager'

export type SleepTimer = { kind: 'duration'; remainingSeconds: number } | { kind: 'end-of-chapter' }

interface PlayerState {
  book: Book | null
  chapter: Chapter | null
  isPlaying: boolean
  /** Seconds elapsed within the current chapter (not the underlying file). */
  currentTime: number
  /** Current chapter's own duration (not the underlying file's, which may
   * span several chapters for M4B books). */
  duration: number
  playbackRate: number
  skipSilenceEnabled: boolean
  sleepTimer: SleepTimer | null
}

interface PlayerContextValue extends PlayerState {
  loadBook: (book: Book, chapterId?: string, resumeAt?: number) => void
  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (chapterRelativeTime: number) => void
  skip: (deltaSeconds: number) => void
  nextChapter: () => void
  prevChapter: () => void
  setPlaybackRate: (rate: number) => void
  toggleSkipSilence: () => void
  startSleepTimer: (timer: SleepTimer | null) => void
}

const PlayerContext = createContext<PlayerContextValue | null>(null)

export function PlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null)
  // Which chapter's audioUrl is actually loaded into the <audio> element —
  // distinct from `chapter`, which tracks which chapter is *playing right
  // now* and can move to a same-file sibling without a reload (see the
  // timeupdate handler below).
  const loadedSourceFileIdRef = useRef<string | null>(null)
  // The object URL currently assigned to audio.src, when playing from a
  // cached blob — tracked so it can be revoked once no longer needed.
  const objectUrlRef = useRef<string | null>(null)

  const [book, setBook] = useState<Book | null>(null)
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [fileTime, setFileTime] = useState(0) // audio.currentTime, file-absolute
  const [playbackRate, setPlaybackRateState] = useState(1)
  const [skipSilenceEnabled, setSkipSilenceEnabled] = useState(false)
  const [sleepTimer, setSleepTimer] = useState<SleepTimer | null>(null)

  useSkipSilence(audioRef, skipSilenceEnabled)

  const auth = useAuth()
  // Refs so pushProgress can read fresh state without re-subscribing
  // listeners/intervals every time position changes.
  const latestRef = useRef({ book, chapter, fileTime, token: auth.token })
  useEffect(() => {
    latestRef.current = { book, chapter, fileTime, token: auth.token }
  })

  const chapterIndex = useMemo(() => {
    if (!book || !chapter) return -1
    return book.chapters.findIndex((c) => c.id === chapter.id)
  }, [book, chapter])

  const currentTime = chapter ? Math.max(0, fileTime - chapter.startTime) : 0
  const duration = chapter?.duration ?? 0

  // Downloads the given chapter (if not already cached) plus the next one
  // in the book, for actively-playing books — "keep current + next 1-2
  // chapters cached" from Claude.md. Best-effort: a failure just means
  // playback keeps using the network stream.
  const triggerPrefetch = useCallback((book: Book, current: Chapter) => {
    const idx = book.chapters.findIndex((c) => c.id === current.id)
    const toPreload = [current, book.chapters[idx + 1]].filter((c): c is Chapter => Boolean(c))
    for (const ch of toPreload) {
      downloadChapter(ch).catch(() => {})
    }
  }, [])

  /** Resolves the actual audio.src to use: a local object URL if this
   * chapter's underlying file is already cached (offline-capable, and the
   * stream-failure fallback from Claude.md — a cached chapter just can't
   * fail to load from the network in the first place), the network stream
   * otherwise. */
  const resolveAudioSrc = useCallback(async (target: Chapter): Promise<string> => {
    const cached = await getCachedAudioFile(target.sourceFileId)
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current)
      objectUrlRef.current = null
    }
    if (!cached) return target.audioUrl
    void touchLastPlayed(target.sourceFileId, new Date().toISOString())
    const url = URL.createObjectURL(cached.blob)
    objectUrlRef.current = url
    return url
  }, [])

  /** Loads a chapter's audio into the audio element and seeks to a
   * chapter-relative offset, waiting for metadata if needed. */
  const loadIntoAudio = useCallback(
    (book: Book, target: Chapter, chapterRelativeOffset: number, autoplay: boolean) => {
      const audio = audioRef.current
      if (!audio) return
      loadedSourceFileIdRef.current = target.sourceFileId
      void resolveAudioSrc(target).then((src) => {
        audio.src = src
        const applyStart = () => {
          audio.currentTime = target.startTime + chapterRelativeOffset
          if (autoplay) audio.play()
        }
        audio.addEventListener('loadedmetadata', applyStart, { once: true })
      })
      triggerPrefetch(book, target)
    },
    [resolveAudioSrc, triggerPrefetch],
  )

  const loadBook = useCallback(
    (nextBook: Book, chapterId?: string, resumeAt = 0) => {
      const target = nextBook.chapters.find((c) => c.id === chapterId) ?? nextBook.chapters[0]
      setBook(nextBook)
      setChapter(target ?? null)
      if (target && audioRef.current) {
        audioRef.current.playbackRate = playbackRate
        loadIntoAudio(nextBook, target, resumeAt, false)
      }
    },
    [playbackRate, loadIntoAudio],
  )

  const play = useCallback(() => {
    audioRef.current?.play()
  }, [])

  const pause = useCallback(() => {
    audioRef.current?.pause()
  }, [])

  const togglePlay = useCallback(() => {
    if (isPlaying) pause()
    else play()
  }, [isPlaying, play, pause])

  const seek = useCallback(
    (chapterRelativeTime: number) => {
      const audio = audioRef.current
      if (!audio || !chapter) return
      const clamped = Math.max(0, Math.min(chapterRelativeTime, chapter.duration))
      audio.currentTime = chapter.startTime + clamped
    },
    [chapter],
  )

  /** Moves to a chapter at `index`, starting `chapterRelativeOffset` seconds
   * into it. Reuses the already-loaded stream (no reload/re-buffer) when
   * the target chapter shares the current audio source. */
  const moveToChapter = useCallback(
    (index: number, chapterRelativeOffset: number, autoplayIfPaused: boolean) => {
      if (!book) return
      const target = book.chapters[index]
      const audio = audioRef.current
      if (!target || !audio) return

      const wasPlaying = isPlaying
      setChapter(target)

      if (loadedSourceFileIdRef.current === target.sourceFileId) {
        audio.currentTime = target.startTime + chapterRelativeOffset
        if (wasPlaying || autoplayIfPaused) audio.play()
      } else {
        loadIntoAudio(book, target, chapterRelativeOffset, wasPlaying || autoplayIfPaused)
      }
    },
    [book, isPlaying, loadIntoAudio],
  )

  const nextChapter = useCallback(() => {
    if (chapterIndex < 0) return
    moveToChapter(chapterIndex + 1, 0, true)
  }, [chapterIndex, moveToChapter])

  const prevChapter = useCallback(() => {
    if (chapterIndex < 0) return
    moveToChapter(chapterIndex - 1, 0, true)
  }, [chapterIndex, moveToChapter])

  const skip = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current
      if (!audio || !chapter || !book) return
      const target = currentTime + deltaSeconds

      if (target < 0 && chapterIndex > 0) {
        const prev = book.chapters[chapterIndex - 1]
        moveToChapter(chapterIndex - 1, Math.max(0, prev.duration + target), true)
        return
      }
      if (target > chapter.duration && chapterIndex < book.chapters.length - 1) {
        moveToChapter(chapterIndex + 1, target - chapter.duration, true)
        return
      }
      seek(Math.max(0, Math.min(target, chapter.duration)))
    },
    [chapter, chapterIndex, book, currentTime, moveToChapter, seek],
  )

  const setPlaybackRate = useCallback((rate: number) => {
    setPlaybackRateState(rate)
    if (audioRef.current) audioRef.current.playbackRate = rate
  }, [])

  const toggleSkipSilence = useCallback(() => {
    setSkipSilenceEnabled((v) => !v)
  }, [])

  const startSleepTimer = useCallback((timer: SleepTimer | null) => {
    setSleepTimer(timer)
  }, [])

  // Writes to the local IndexedDB outbox immediately (always succeeds,
  // no network dependency) and kicks off a best-effort sync — see
  // src/offline/syncEngine.ts for the retry/backoff queue.
  const pushProgress = useCallback(() => {
    const { book, chapter, fileTime, token } = latestRef.current
    if (!book || !chapter) return
    void recordProgress(
      token,
      book.id,
      chapter.id,
      { type: 'timestamp', value: Math.max(0, fileTime - chapter.startTime) },
      new Date().toISOString(),
    )
  }, [])

  // Push periodically while playing, matching "every N seconds during
  // playback" from Claude.md's position-sync design.
  useEffect(() => {
    if (!isPlaying) return
    const id = setInterval(pushProgress, 20_000)
    return () => clearInterval(id)
  }, [isPlaying, pushProgress])

  // Sleep timer countdown for fixed-duration timers
  useEffect(() => {
    if (!sleepTimer || sleepTimer.kind !== 'duration') return
    if (sleepTimer.remainingSeconds <= 0) {
      pause()
      setSleepTimer(null)
      return
    }
    const id = setTimeout(() => {
      setSleepTimer({ kind: 'duration', remainingSeconds: sleepTimer.remainingSeconds - 1 })
    }, 1000)
    return () => clearTimeout(id)
  }, [sleepTimer, pause])

  // Audio element event wiring
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onPlay = () => setIsPlaying(true)
    const onPause = () => {
      setIsPlaying(false)
      pushProgress()
    }
    const onEnded = () => {
      if (sleepTimer?.kind === 'end-of-chapter') {
        setSleepTimer(null)
        return
      }
      // The loaded stream itself finished (true for mp3-folder chapters,
      // and for the last chapter of an M4B). Same-file M4B chapters ahead
      // of this one are handled by onTimeUpdate below without ever
      // reaching this event.
      nextChapter()
    }

    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('ended', onEnded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepTimer, nextChapter, pushProgress])

  // Tracks file-absolute playback position, and — for M4B books where
  // several chapters share one continuously-playing file — advances the
  // displayed "current chapter" as playback crosses each chapter's
  // start_time boundary, with no src reload or seek involved.
  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    const onTimeUpdate = () => {
      setFileTime(audio.currentTime)
      if (!book || !chapter) return
      const next = book.chapters[chapterIndex + 1]
      if (next && next.sourceFileId === chapter.sourceFileId && audio.currentTime >= next.startTime) {
        setChapter(next)
      }
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    return () => audio.removeEventListener('timeupdate', onTimeUpdate)
  }, [book, chapter, chapterIndex])

  // Media Session API integration
  useEffect(() => {
    if (!('mediaSession' in navigator) || !book || !chapter) return

    navigator.mediaSession.metadata = new MediaMetadata({
      title: chapter.title,
      artist: book.author,
      album: book.title,
      artwork: book.coverFullUrl
        ? [{ src: book.coverFullUrl, sizes: '512x512', type: 'image/png' }]
        : undefined,
    })

    navigator.mediaSession.setActionHandler('play', play)
    navigator.mediaSession.setActionHandler('pause', pause)
    navigator.mediaSession.setActionHandler('previoustrack', prevChapter)
    navigator.mediaSession.setActionHandler('nexttrack', nextChapter)
    navigator.mediaSession.setActionHandler('seekbackward', () => skip(-15))
    navigator.mediaSession.setActionHandler('seekforward', () => skip(30))
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime !== undefined) seek(details.seekTime)
    })

    return () => {
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
      navigator.mediaSession.setActionHandler('seekto', null)
    }
  }, [book, chapter, play, pause, prevChapter, nextChapter, skip, seek])

  useEffect(() => {
    if (!('mediaSession' in navigator) || !duration) return
    try {
      navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'
      navigator.mediaSession.setPositionState({
        duration,
        playbackRate,
        position: Math.min(currentTime, duration),
      })
    } catch {
      // setPositionState can throw if duration/position are momentarily out of sync
      // during a chapter transition — safe to ignore, next tick corrects it.
    }
  }, [duration, currentTime, playbackRate, isPlaying])

  const value: PlayerContextValue = {
    book,
    chapter,
    isPlaying,
    currentTime,
    duration,
    playbackRate,
    skipSilenceEnabled,
    sleepTimer,
    loadBook,
    play,
    pause,
    togglePlay,
    seek,
    skip,
    nextChapter,
    prevChapter,
    setPlaybackRate,
    toggleSkipSilence,
    startSleepTimer,
  }

  return (
    <PlayerContext.Provider value={value}>
      {children}
      <audio ref={audioRef} />
    </PlayerContext.Provider>
  )
}

export function usePlayer() {
  const ctx = useContext(PlayerContext)
  if (!ctx) throw new Error('usePlayer must be used within a PlayerProvider')
  return ctx
}
