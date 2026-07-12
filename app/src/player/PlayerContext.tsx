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

export type SleepTimer = { kind: 'duration'; remainingSeconds: number } | { kind: 'end-of-chapter' }

interface PlayerState {
  book: Book | null
  chapter: Chapter | null
  isPlaying: boolean
  currentTime: number
  duration: number
  playbackRate: number
  skipSilenceEnabled: boolean
  sleepTimer: SleepTimer | null
}

interface PlayerContextValue extends PlayerState {
  loadBook: (book: Book, chapterId?: string) => void
  play: () => void
  pause: () => void
  togglePlay: () => void
  seek: (time: number) => void
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
  const [book, setBook] = useState<Book | null>(null)
  const [chapter, setChapter] = useState<Chapter | null>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [playbackRate, setPlaybackRateState] = useState(1)
  const [skipSilenceEnabled, setSkipSilenceEnabled] = useState(false)
  const [sleepTimer, setSleepTimer] = useState<SleepTimer | null>(null)

  useSkipSilence(audioRef, skipSilenceEnabled)

  const chapterIndex = useMemo(() => {
    if (!book || !chapter) return -1
    return book.chapters.findIndex((c) => c.id === chapter.id)
  }, [book, chapter])

  const loadBook = useCallback((nextBook: Book, chapterId?: string) => {
    const target =
      nextBook.chapters.find((c) => c.id === chapterId) ??
      nextBook.chapters.find((c) => c.id === nextBook.progress?.chapterId) ??
      nextBook.chapters[0]
    setBook(nextBook)
    setChapter(target ?? null)
    if (target && audioRef.current) {
      audioRef.current.src = target.audioUrl
      audioRef.current.playbackRate = playbackRate
      if (
        nextBook.progress?.chapterId === target.id &&
        nextBook.progress.position.type === 'timestamp'
      ) {
        audioRef.current.currentTime = nextBook.progress.position.value - target.startTime
      }
    }
  }, [playbackRate])

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

  const seek = useCallback((time: number) => {
    if (audioRef.current) audioRef.current.currentTime = time
  }, [])

  const goToChapter = useCallback(
    (index: number, autoplayFromStart: boolean, startAt?: number) => {
      if (!book) return
      const target = book.chapters[index]
      if (!target || !audioRef.current) return
      const wasPlaying = isPlaying
      setChapter(target)
      audioRef.current.src = target.audioUrl
      const applyStart = () => {
        if (startAt !== undefined && audioRef.current) {
          audioRef.current.currentTime = startAt
        }
        if (wasPlaying || autoplayFromStart) audioRef.current?.play()
      }
      audioRef.current.addEventListener('loadedmetadata', applyStart, { once: true })
    },
    [book, isPlaying],
  )

  const nextChapter = useCallback(() => {
    if (chapterIndex < 0) return
    goToChapter(chapterIndex + 1, true)
  }, [chapterIndex, goToChapter])

  const prevChapter = useCallback(() => {
    if (chapterIndex < 0) return
    goToChapter(chapterIndex - 1, true)
  }, [chapterIndex, goToChapter])

  const skip = useCallback(
    (deltaSeconds: number) => {
      const audio = audioRef.current
      if (!audio || !chapter) return
      const target = audio.currentTime + deltaSeconds
      if (target < 0 && chapterIndex > 0) {
        goToChapter(chapterIndex - 1, true, Math.max(0, chapter.duration + target))
        return
      }
      if (target > chapter.duration && book && chapterIndex < book.chapters.length - 1) {
        goToChapter(chapterIndex + 1, true, target - chapter.duration)
        return
      }
      audio.currentTime = Math.max(0, Math.min(target, chapter.duration))
    },
    [chapter, chapterIndex, book, goToChapter],
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
    const onPause = () => setIsPlaying(false)
    const onTimeUpdate = () => setCurrentTime(audio.currentTime)
    const onLoadedMetadata = () => setDuration(audio.duration)
    const onEnded = () => {
      if (sleepTimer?.kind === 'end-of-chapter') {
        setSleepTimer(null)
        return
      }
      nextChapter()
    }

    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('timeupdate', onTimeUpdate)
    audio.addEventListener('loadedmetadata', onLoadedMetadata)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('timeupdate', onTimeUpdate)
      audio.removeEventListener('loadedmetadata', onLoadedMetadata)
      audio.removeEventListener('ended', onEnded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepTimer, nextChapter])

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
