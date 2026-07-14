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
import { downloadChapter, isChapterCached } from '../offline/downloadManager'

export type SleepTimer = { kind: 'duration'; remainingSeconds: number } | { kind: 'end-of-chapter' }

// Stream-failure fallback per Claude.md: a live network stream failing
// mid-play (Mac mini asleep/restarting/unreachable) should retry a few
// times with backoff before surfacing a "can't reach your library" message
// — not hang silently forever, which is what happened before this existed.
const MAX_LOAD_RETRIES = 3
const RETRY_DELAYS_MS = [2000, 5000, 10000]
const LOAD_TIMEOUT_MS = 10000
// Matches the in-app scrubber's debounce (see NowPlaying.tsx) — applied
// specifically to Media Session's seekto, not to seek() itself, so a single
// deliberate seek (skip buttons, chapter nav) stays instant.
const SEEK_DEBOUNCE_MS = 200

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  /** True while a chapter's audio is being loaded/retried — no equivalent
   * UI existed before, so a stalled stream looked identical to nothing
   * happening at all. */
  isBuffering: boolean
  /** Set once retries are exhausted; user-facing "can't reach your
   * library" state. Cleared by any successful load or manual retry. */
  streamError: string | null
  /** True once playback reaches the end of the book's last chapter — lets
   * the UI say so instead of just freezing with no explanation. */
  finished: boolean
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
  /** Re-attempts the load that produced `streamError`, from the same
   * chapter/offset it originally failed at. */
  retryLoad: () => void
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
  const [isBuffering, setIsBuffering] = useState(false)
  const [streamError, setStreamError] = useState<string | null>(null)
  const [finished, setFinished] = useState(false)
  // What loadIntoAudio was last asked to load — lets retryLoad redo the
  // exact same attempt without the caller having to remember it.
  const pendingLoadRef = useRef<{ book: Book; target: Chapter; offset: number; autoplay: boolean } | null>(null)
  // Armed/re-armed whenever the audio element reports it's waiting for more
  // data outside of an active attemptLoadWithRetries cycle — covers
  // scrubbing, resuming from pause, and genuine mid-playback network stalls,
  // all of which set audio.currentTime/call play() directly with no
  // built-in error signal of their own. See seekWithinLoadedStream below.
  const seekWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True while attemptLoadWithRetries owns recovery for the current chapter
  // — the general waiting-event watchdog stands down during that window so
  // the two mechanisms can't both react to the same stall and race.
  const loadInProgressRef = useRef(false)
  // Debounces the OS-level lock-screen/Control Center scrubber (Media
  // Session's `seekto`), which some platforms fire continuously during a
  // drag just like the in-app <input type="range"> does — see the
  // seekto handler below for why that matters.
  const seekToDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  /** One attempt at loading `src` and seeking to `startAt` — resolves once
   * `loadedmetadata` fires, rejects on a load error or on exceeding
   * LOAD_TIMEOUT_MS (a stalled network request may never fire `error` at
   * all, which is why a timeout is needed as well as an error listener). */
  const attemptLoadOnce = useCallback((audio: HTMLAudioElement, src: string, startAt: number, autoplay: boolean) => {
    return new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        clearTimeout(timeoutId)
        audio.removeEventListener('loadedmetadata', onLoaded)
        audio.removeEventListener('error', onError)
      }
      const onLoaded = () => {
        if (settled) return
        settled = true
        cleanup()
        audio.currentTime = startAt
        if (autoplay) audio.play().catch(() => {}) // playback-policy rejection isn't a load failure
        resolve()
      }
      const onError = () => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('audio load error'))
      }
      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error('audio load timeout'))
      }, LOAD_TIMEOUT_MS)

      audio.addEventListener('loadedmetadata', onLoaded, { once: true })
      audio.addEventListener('error', onError, { once: true })
      audio.src = src
    })
  }, [])

  /** Resolves the src (cache or network) and attempts to load it, retrying
   * with backoff on failure. A cached chapter can't hit this retry path at
   * all — resolveAudioSrc only returns a network URL when there's no local
   * copy — so retries are specifically for the network-stream case Claude.md
   * calls out. Abandons itself if the user has since navigated elsewhere
   * (loadedSourceFileIdRef no longer matches), so a slow failing retry from
   * an old chapter can't clobber whatever the user moved on to. */
  const attemptLoadWithRetries = useCallback(
    async (audio: HTMLAudioElement, target: Chapter, chapterRelativeOffset: number, autoplay: boolean) => {
      loadInProgressRef.current = true
      setIsBuffering(true)
      try {
        for (let attempt = 0; attempt <= MAX_LOAD_RETRIES; attempt++) {
          try {
            const src = await resolveAudioSrc(target)
            if (loadedSourceFileIdRef.current !== target.sourceFileId) return
            await attemptLoadOnce(audio, src, target.startTime + chapterRelativeOffset, autoplay)
            if (loadedSourceFileIdRef.current !== target.sourceFileId) return
            setIsBuffering(false)
            setStreamError(null)
            return
          } catch {
            if (loadedSourceFileIdRef.current !== target.sourceFileId) return
            if (attempt < MAX_LOAD_RETRIES) {
              await sleep(RETRY_DELAYS_MS[attempt])
              if (loadedSourceFileIdRef.current !== target.sourceFileId) return
              continue
            }
            setIsBuffering(false)
            // "Can't reach your library" is actively wrong for a downloaded
            // chapter — there's no network involved in playing a cached
            // blob at all, so a failure there is a local playback/decode
            // problem, not a reachability one.
            const cached = await isChapterCached(target)
            setStreamError(
              cached
                ? "Trouble playing this downloaded chapter — try again, or remove and re-download it"
                : "Can't reach your library right now",
            )
          }
        }
      } finally {
        loadInProgressRef.current = false
      }
    },
    [resolveAudioSrc, attemptLoadOnce],
  )

  const clearSeekWatchdog = useCallback(() => {
    if (seekWatchdogRef.current) {
      clearTimeout(seekWatchdogRef.current)
      seekWatchdogRef.current = null
    }
  }, [])

  /** Loads a chapter's audio into the audio element and seeks to a
   * chapter-relative offset, retrying on failure (see attemptLoadWithRetries). */
  const loadIntoAudio = useCallback(
    (book: Book, target: Chapter, chapterRelativeOffset: number, autoplay: boolean) => {
      const audio = audioRef.current
      if (!audio) return
      clearSeekWatchdog() // a full reload supersedes any pending in-stream-seek recovery
      loadedSourceFileIdRef.current = target.sourceFileId
      setStreamError(null)
      setFinished(false)
      pendingLoadRef.current = { book, target, offset: chapterRelativeOffset, autoplay }
      triggerPrefetch(book, target)
      void attemptLoadWithRetries(audio, target, chapterRelativeOffset, autoplay)
    },
    [clearSeekWatchdog, triggerPrefetch, attemptLoadWithRetries],
  )

  const retryLoad = useCallback(() => {
    const audio = audioRef.current
    const pending = pendingLoadRef.current
    if (!audio || !pending) return
    void attemptLoadWithRetries(audio, pending.target, pending.offset, pending.autoplay)
  }, [attemptLoadWithRetries])

  /** (Re)starts the stall watchdog, falling back to a full reload-with-retry
   * of the last known target (pendingLoadRef) if nothing proves recovery
   * within LOAD_TIMEOUT_MS. Called both up front by seekWithinLoadedStream
   * and reactively by the `waiting` handler below, so a stall that develops
   * *after* a seek nominally succeeds (audio.currentTime updated, but not
   * yet enough data buffered to actually resume producing sound) still gets
   * caught — `seeked` alone isn't proof of recovery, only `playing` is. */
  const armSeekWatchdog = useCallback(() => {
    const pending = pendingLoadRef.current
    if (!pending) return
    clearSeekWatchdog()
    seekWatchdogRef.current = setTimeout(() => {
      loadIntoAudio(pending.book, pending.target, pending.offset, pending.autoplay)
    }, LOAD_TIMEOUT_MS)
  }, [clearSeekWatchdog, loadIntoAudio])

  /** Sets audio.currentTime directly to a file-absolute position — the fast
   * path for scrubbing within the already-loaded stream, or moving to a
   * same-file sibling chapter, neither of which need a full reload. Unlike
   * a src reload, a bare currentTime assignment has no built-in error
   * signal: if the byte range it needs isn't buffered and that fetch
   * stalls, the browser can just sit there indefinitely with no `error`
   * event and no feedback (this was the actual "scrubber does nothing"
   * bug — the retry logic added for chapter loads never covered this
   * separate code path at all). Arms the general stall watchdog immediately
   * as a baseline, which armSeekWatchdog also gets re-armed by if `waiting`
   * fires later (see the event wiring effect below).
   *
   * If streamError is currently set, the audio element was left in a
   * stuck/half-loaded state by exhausted retries — a bare currentTime
   * assignment on it isn't reliable (this was why skip/seek couldn't
   * escape the error banner: they kept nudging a broken element instead of
   * giving it a clean slate). Route through a full reload instead, and
   * treat the attempt as wanting to resume playing — the whole point of
   * seeking away from an error is to get past whatever the previous
   * position couldn't recover from. */
  const seekWithinLoadedStream = useCallback(
    (book: Book, target: Chapter, chapterRelativeOffset: number, autoplay: boolean) => {
      const audio = audioRef.current
      if (!audio) return
      if (streamError) {
        loadIntoAudio(book, target, chapterRelativeOffset, true)
        return
      }
      setStreamError(null)
      pendingLoadRef.current = { book, target, offset: chapterRelativeOffset, autoplay }
      audio.currentTime = target.startTime + chapterRelativeOffset
      if (autoplay) audio.play().catch(() => {})
      setIsBuffering(true)
      armSeekWatchdog()
    },
    [streamError, loadIntoAudio, armSeekWatchdog],
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
    setFinished(false)
    const audio = audioRef.current
    if (!audio || !book || !chapter) {
      audio?.play()
      return
    }
    // If a previous attempt exhausted its retries, the element may be
    // stuck in a half-loaded state — a bare play() on it isn't reliable
    // (same reasoning as seekWithinLoadedStream above). Give it a clean
    // reload from the current position instead.
    if (streamError) {
      loadIntoAudio(book, chapter, Math.max(0, audio.currentTime - chapter.startTime), true)
      return
    }
    // Keeps pendingLoadRef current so a stall while resuming from pause
    // (audio.play() can hang exactly like a seek can) has a valid fallback
    // target for the waiting-event watchdog to recover into.
    pendingLoadRef.current = {
      book,
      target: chapter,
      offset: Math.max(0, audio.currentTime - chapter.startTime),
      autoplay: true,
    }
    audio.play()
  }, [book, chapter, streamError, loadIntoAudio])

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
      if (!audio || !chapter || !book) return
      setFinished(false)
      const clamped = Math.max(0, Math.min(chapterRelativeTime, chapter.duration))
      seekWithinLoadedStream(book, chapter, clamped, isPlaying)
    },
    [book, chapter, isPlaying, seekWithinLoadedStream],
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

      setFinished(false)
      const wasPlaying = isPlaying
      setChapter(target)

      if (loadedSourceFileIdRef.current === target.sourceFileId) {
        seekWithinLoadedStream(book, target, chapterRelativeOffset, wasPlaying || autoplayIfPaused)
      } else {
        loadIntoAudio(book, target, chapterRelativeOffset, wasPlaying || autoplayIfPaused)
      }
    },
    [book, isPlaying, loadIntoAudio, seekWithinLoadedStream],
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
    // `seeked` only means the browser accepted the target time — it does
    // NOT mean there's enough data buffered to actually resume producing
    // sound. Clearing the watchdog here unconditionally was the actual bug:
    // a seek that "succeeds" but then needs to buffer (fires `waiting`)
    // left nothing watching once that buffering itself stalled. Only treat
    // `seeked` as done when nothing was expected to play afterward (a
    // paused seek) — an autoplaying one waits for genuine `playing` instead.
    const onSeeked = () => {
      if (!pendingLoadRef.current?.autoplay) {
        clearSeekWatchdog()
        setIsBuffering(false)
      }
    }
    // The authoritative "recovered" signal — audio is actually producing
    // sound again, not just that a seek/load nominally completed.
    const onPlaying = () => {
      clearSeekWatchdog()
      setIsBuffering(false)
      setStreamError(null)
    }
    // Fires whenever the element needs more data than it has — reactively
    // (re)arms the watchdog so a stall discovered *after* a seek/resume
    // nominally succeeded still gets caught. Stands down while
    // attemptLoadWithRetries already owns recovery for a fresh chapter load,
    // so the two mechanisms can't both react to the same stall.
    const onWaiting = () => {
      if (loadInProgressRef.current) return
      setIsBuffering(true)
      armSeekWatchdog()
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
      if (!book || chapterIndex >= book.chapters.length - 1) {
        // Reaching the end of the book's last chapter used to leave
        // nextChapter() silently no-op here — UI stayed frozen on the
        // finished chapter with no indication anything had happened.
        setFinished(true)
        return
      }
      nextChapter()
    }

    audio.addEventListener('play', onPlay)
    audio.addEventListener('pause', onPause)
    audio.addEventListener('seeked', onSeeked)
    audio.addEventListener('playing', onPlaying)
    audio.addEventListener('waiting', onWaiting)
    audio.addEventListener('stalled', onWaiting)
    audio.addEventListener('ended', onEnded)
    return () => {
      audio.removeEventListener('play', onPlay)
      audio.removeEventListener('pause', onPause)
      audio.removeEventListener('seeked', onSeeked)
      audio.removeEventListener('playing', onPlaying)
      audio.removeEventListener('waiting', onWaiting)
      audio.removeEventListener('stalled', onWaiting)
      audio.removeEventListener('ended', onEnded)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sleepTimer, nextChapter, pushProgress, book, chapterIndex, clearSeekWatchdog, armSeekWatchdog])

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
      // Keeps the stall-recovery fallback target tracking actual playback
      // progress, not just the position from the last explicit seek/play.
      // Without this, a stall discovered mid-playback (not right after a
      // seek) would recover by rewinding to wherever the chapter was
      // originally loaded/resumed from — repeatedly replaying the same
      // stretch and re-approaching (and re-hitting) the same trouble spot
      // instead of converging past it.
      if (pendingLoadRef.current) {
        pendingLoadRef.current = {
          ...pendingLoadRef.current,
          book,
          target: chapter,
          offset: Math.max(0, audio.currentTime - chapter.startTime),
        }
      }
      // timeupdate firing at all is unambiguous proof audio is genuinely
      // progressing — clear any pending stall watchdog here too, not just
      // on `playing`. This was the actual "loop on every scrub" bug: a
      // seek that resolves smoothly doesn't always get a *fresh* `playing`
      // event (the element may never have formally left the playing state
      // from the browser's point of view), so a watchdog that only listens
      // for `playing` can sit armed indefinitely after a perfectly healthy
      // seek and fire a needless reload ~10s later, regardless of how far
      // the seek actually was.
      clearSeekWatchdog()
      setIsBuffering(false)
    }

    audio.addEventListener('timeupdate', onTimeUpdate)
    return () => audio.removeEventListener('timeupdate', onTimeUpdate)
  }, [book, chapter, chapterIndex, clearSeekWatchdog])

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
    // Some platforms fire seekto continuously while the user drags the
    // lock-screen/Control Center scrubber, not just once on release — the
    // same rapid-fire-seeking issue the in-app scrubber had (see
    // NowPlaying.tsx), just via a different entry point into seek().
    navigator.mediaSession.setActionHandler('seekto', (details) => {
      if (details.seekTime === undefined) return
      const seekTime = details.seekTime
      if (seekToDebounceRef.current) clearTimeout(seekToDebounceRef.current)
      seekToDebounceRef.current = setTimeout(() => {
        seekToDebounceRef.current = null
        seek(seekTime)
      }, SEEK_DEBOUNCE_MS)
    })

    return () => {
      navigator.mediaSession.setActionHandler('play', null)
      navigator.mediaSession.setActionHandler('pause', null)
      navigator.mediaSession.setActionHandler('previoustrack', null)
      navigator.mediaSession.setActionHandler('nexttrack', null)
      navigator.mediaSession.setActionHandler('seekbackward', null)
      navigator.mediaSession.setActionHandler('seekforward', null)
      navigator.mediaSession.setActionHandler('seekto', null)
      if (seekToDebounceRef.current) clearTimeout(seekToDebounceRef.current)
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
    isBuffering,
    streamError,
    finished,
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
    retryLoad,
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
