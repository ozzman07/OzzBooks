import { useCallback, useEffect, useRef, useState } from 'react'
import type { MouseEvent } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { comicPageUrl } from '../api/client'
import { fetchBookProgress, putProgress } from '../api/cloudClient'
import { useAuth } from '../auth/AuthContext'
import { useAppData } from '../data/AppDataContext'
import { loadReadingDirection, saveReadingDirection, type ReadingDirection } from '../reader/comicReaderPrefs'
import { getCachedComicPage, touchComicLastRead } from '../offline/comicPageStore'
import { downloadComicPage } from '../offline/downloadManager'

// How many pages ahead to silently cache while actively reading,
// independent of an explicit "download whole issue" action — same
// resilience-against-short-offline-gaps reasoning PlayerContext's own
// triggerPrefetch already applies to audio chapters.
const PREFETCH_AHEAD_PAGES = 2

// Auto-hide delay for the chrome (top bar + thumbnail strip) — "a couple
// seconds" per the addendum, matching a dedicated photo/comic viewer
// rather than the app's normal always-visible chrome.
const CHROME_HIDE_DELAY_MS = 2500

// Backoff schedule for a failed page fetch, per the addendum's "v1 gap"
// fix: check cache first (no offline comicPages store yet — that's a later
// step, see Ozzbooks_Addendum_Comics' Offline download experience section),
// then retry with backoff, only then show an explicit "couldn't load"
// state rather than a silent broken image.
const RETRY_DELAYS_MS = [1000, 2000, 4000]

// An <img> only ever fires onError for a definite failure (connection
// refused, 404, etc.) — a request that just hangs (a real Wi-Fi drop mid-
// request, not a clean failure) fires neither onLoad nor onError and would
// otherwise leave a blank page forever with no retry ever kicking in,
// exactly the silent-blank-page outcome the addendum's retry policy exists
// to prevent. This watchdog treats "still loading after N seconds" as a
// failure too, going through the same escalation path as a real onError.
const PAGE_LOAD_TIMEOUT_MS = 8000

type PageLoadStatus = 'loading' | 'loaded' | 'failed'
interface PageLoadState {
  page: number
  attempt: number
  status: PageLoadStatus
}

// Phase 1 of the addendum's own staged build order for this component
// ("single-page fit-height first, then spread mode and pinch-zoom, then
// the reading-direction toggle... " — reading-direction included here
// too since it's cheap and self-contained): single-page fit-to-screen
// reading, three-way tap zones, auto-hiding chrome, position tracking,
// page-load retry, jump-to-page thumbnail strip, reading-direction
// toggle. Pinch-zoom/double-tap-zoom and spread mode are deliberately
// NOT built yet — new gesture handling with nothing to reuse from
// EbookReader, left for a follow-up pass per the addendum's own ordering.
export function ComicReader() {
  const { bookId } = useParams()
  const navigate = useNavigate()
  const auth = useAuth()
  const data = useAppData()
  const containerRef = useRef<HTMLDivElement>(null)

  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [title, setTitle] = useState('')
  const [pageCount, setPageCount] = useState(0)
  const [currentPage, setCurrentPage] = useState(0)
  const [direction, setDirection] = useState<ReadingDirection>(loadReadingDirection)
  const [showChrome, setShowChrome] = useState(true)
  const [pageLoad, setPageLoad] = useState<PageLoadState>({ page: 0, attempt: 0, status: 'loading' })
  const [resolvedSrc, setResolvedSrc] = useState<string | undefined>(undefined)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const chromeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // The most recent blob: URL handed to the <img>, if the current page
  // came from the offline cache — revoked on the next resolution/unmount,
  // same pattern PlayerContext's objectUrlRef uses for cached audio.
  const objectUrlRef = useRef<string | null>(null)
  // Guards against escalating the same page+attempt twice — a real onError
  // and the watchdog timeout below can both fire for the same stalled
  // request (the timeout fires, schedules a retry; the browser's own
  // error for that same original request arrives moments later).
  const escalatedRef = useRef<string | null>(null)
  // Applies the synced position exactly once, the moment it arrives — see
  // the progress-restoration effect below for why this can't just check
  // "is currentPage still 0".
  const progressAppliedRef = useRef(false)

  // Title/pageCount come from AppDataContext's already-loaded, offline-
  // cached catalog (see catalogCacheStore.ts) rather than this component's
  // own fetchBook call — confirmed live that a plain fetchBook here hangs
  // forever with the network unreachable, even for a comic whose pages are
  // fully downloaded and ready to serve from IndexedDB. Same fix as
  // BookReaderRoute's own dispatch logic.
  useEffect(() => {
    if (!bookId) return
    if (data.status === 'loading') return
    const book = data.books.find((b) => b.id === bookId)
    if (!book) {
      setStatus('error')
      return
    }
    setTitle(book.title)
    setPageCount(book.pageCount ?? 0)
    setStatus('ready')
  }, [bookId, data.books, data.status])

  // Position restore is best-effort and non-blocking — a slow or failed
  // progress fetch (e.g. offline, cloud service unreachable) must never
  // keep the reader stuck on "Loading…"; it only ever adjusts the current
  // page if it resolves, applied exactly once on the initial load rather
  // than re-applying (and yanking the reader backward) on every re-render.
  useEffect(() => {
    if (status !== 'ready' || !auth.token || !bookId || progressAppliedRef.current) return
    let cancelled = false
    fetchBookProgress(auth.token, bookId)
      .then((progress) => {
        if (cancelled || progressAppliedRef.current) return
        progressAppliedRef.current = true
        if (progress?.position.type === 'page') {
          setCurrentPage(Math.min(Math.max(progress.position.value, 0), Math.max(pageCount - 1, 0)))
        }
      })
      .catch(() => {
        progressAppliedRef.current = true
      })
    return () => {
      cancelled = true
    }
    // pageCount deliberately excluded — it's only used to clamp a value
    // that arrives asynchronously later, not something this effect should
    // re-run for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, auth.token, bookId])

  // Fresh load-tracking every time the target page changes — cancels any
  // retry timer left over from the previous page so a slow-to-fail old
  // request can't bump the wrong page's attempt count after the reader has
  // already moved on.
  useEffect(() => {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    setPageLoad({ page: currentPage, attempt: 0, status: 'loading' })
  }, [currentPage])

  // Cache-first-unconditionally page resolution — same pattern
  // PlayerContext/EbookReader already use for their own content: check
  // IndexedDB first, fall back to the network URL, regardless of
  // connectivity state. Re-runs on a retry (pageLoad.attempt changing)
  // too, though a genuine cache hit never needs one — a local blob URL
  // doesn't fail the way a network request can.
  useEffect(() => {
    if (!bookId || pageCount === 0) {
      setResolvedSrc(undefined)
      return
    }
    let cancelled = false

    async function resolve() {
      const cached = await getCachedComicPage(bookId!, currentPage)
      if (cancelled) return
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current)
        objectUrlRef.current = null
      }
      if (cached) {
        void touchComicLastRead(bookId!, new Date().toISOString())
        const url = URL.createObjectURL(cached.blob)
        objectUrlRef.current = url
        setResolvedSrc(url)
      } else {
        setResolvedSrc(`${comicPageUrl(bookId!, currentPage)}&attempt=${pageLoad.attempt}`)
      }
    }

    void resolve()
    return () => {
      cancelled = true
    }
  }, [bookId, currentPage, pageCount, pageLoad.attempt])

  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current)
    },
    [],
  )

  // Opportunistic pre-fetch while actively reading, independent of the
  // explicit "download whole issue" action — silently caches the next
  // couple of pages so a short offline gap doesn't interrupt reading, same
  // resilience goal PlayerContext's triggerPrefetch already serves for
  // audio. Fire-and-forget: a failed pre-fetch is invisible, never surfaced
  // as a reader error (the normal per-page load/retry path still owns
  // that when the reader actually turns to an uncached page).
  useEffect(() => {
    if (!bookId || pageCount === 0) return
    for (let offset = 1; offset <= PREFETCH_AHEAD_PAGES; offset++) {
      const target = currentPage + offset
      if (target >= pageCount) break
      downloadComicPage(bookId, target, pageCount).catch(() => {})
    }
  }, [bookId, currentPage, pageCount])

  // Debounced position sync — same 2s debounce EbookReader uses for CFIs,
  // just with a page index instead.
  useEffect(() => {
    if (status !== 'ready' || !auth.token || !bookId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    const token = auth.token
    saveTimerRef.current = setTimeout(() => {
      void putProgress(token, bookId, {
        position: { type: 'page', value: currentPage },
        chapterId: null,
        updatedAt: new Date().toISOString(),
      })
    }, 2000)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [currentPage, status, auth.token, bookId])

  const bumpChromeTimer = useCallback(() => {
    if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    chromeTimerRef.current = setTimeout(() => setShowChrome(false), CHROME_HIDE_DELAY_MS)
  }, [])

  useEffect(() => {
    if (status !== 'ready') return
    bumpChromeTimer()
    return () => {
      if (chromeTimerRef.current) clearTimeout(chromeTimerRef.current)
    }
  }, [status, bumpChromeTimer])

  useEffect(
    () => () => {
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    },
    [],
  )

  function goPrev() {
    setCurrentPage((p) => Math.max(0, p - 1))
  }
  function goNext() {
    setCurrentPage((p) => Math.min(pageCount - 1, p + 1))
  }
  function toggleChrome() {
    setShowChrome((s) => {
      const next = !s
      if (next) bumpChromeTimer()
      return next
    })
  }

  // Left third / right third for prev/next, center third summons the
  // chrome — reversed under RTL, where "next" reads right-to-left.
  function handleZoneClick(e: MouseEvent<HTMLDivElement>) {
    if (!containerRef.current) return
    if (showChrome) bumpChromeTimer()
    const rect = containerRef.current.getBoundingClientRect()
    const fraction = (e.clientX - rect.left) / rect.width
    if (fraction < 1 / 3) {
      if (direction === 'ltr') goPrev()
      else goNext()
    } else if (fraction > 2 / 3) {
      if (direction === 'ltr') goNext()
      else goPrev()
    } else {
      toggleChrome()
    }
  }

  function handlePageError() {
    setPageLoad((pl) => {
      if (pl.page !== currentPage) return pl
      const key = `${pl.page}:${pl.attempt}`
      if (escalatedRef.current === key) return pl // already escalated by the other path (see escalatedRef)
      escalatedRef.current = key

      const nextAttempt = pl.attempt + 1
      if (nextAttempt > RETRY_DELAYS_MS.length) {
        return { ...pl, status: 'failed' }
      }
      const targetPage = currentPage
      retryTimerRef.current = setTimeout(() => {
        setPageLoad((current) => (current.page === targetPage ? { ...current, attempt: nextAttempt } : current))
      }, RETRY_DELAYS_MS[nextAttempt - 1])
      return pl // stays 'loading' while the retry is pending
    })
  }

  function handlePageLoaded() {
    if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current)
    setPageLoad((pl) => (pl.page === currentPage ? { ...pl, status: 'loaded' } : pl))
  }

  // Watchdog for a request that neither loads nor errors (a genuine
  // network stall, not a clean failure) — see PAGE_LOAD_TIMEOUT_MS above.
  useEffect(() => {
    if (pageLoad.status !== 'loading') return
    loadTimeoutRef.current = setTimeout(handlePageError, PAGE_LOAD_TIMEOUT_MS)
    return () => {
      if (loadTimeoutRef.current) clearTimeout(loadTimeoutRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageLoad.page, pageLoad.attempt, pageLoad.status])

  function manualRetry() {
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current)
    escalatedRef.current = null // allow this fresh attempt-0 cycle to escalate again if it also fails
    setPageLoad({ page: currentPage, attempt: 0, status: 'loading' })
  }

  function toggleDirection() {
    setDirection((d) => {
      const next = d === 'ltr' ? 'rtl' : 'ltr'
      saveReadingDirection(next)
      return next
    })
  }

  if (status === 'loading') {
    return <div className="fixed inset-0 flex items-center justify-center bg-black text-sm text-white">Loading…</div>
  }
  if (status === 'error') {
    return (
      <div className="fixed inset-0 flex flex-col items-center justify-center gap-3 bg-black text-sm text-white">
        <p>Couldn't load this comic.</p>
        <button onClick={() => navigate(-1)} className="underline">
          ← Back
        </button>
      </div>
    )
  }

  const isRetrying = pageLoad.status === 'loading' && pageLoad.attempt > 0

  return (
    <div
      className="fixed inset-0 flex flex-col bg-black"
      style={{ paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      {showChrome && (
        <div className="z-10 flex items-center justify-between gap-2 bg-black/70 px-4 py-2 text-white">
          <button onClick={() => navigate(-1)} className="shrink-0 text-sm underline">
            ← Back
          </button>
          <p className="min-w-0 flex-1 truncate text-center text-sm font-medium">{title}</p>
          <button
            onClick={toggleDirection}
            aria-label="Toggle reading direction"
            title={direction === 'ltr' ? 'Left-to-right (tap to switch to right-to-left)' : 'Right-to-left (tap to switch to left-to-right)'}
            className="shrink-0 text-xs underline"
          >
            {direction === 'ltr' ? 'LTR' : 'RTL'}
          </button>
        </div>
      )}

      <div ref={containerRef} className="relative flex-1 select-none" onClick={handleZoneClick}>
        {pageCount === 0 && (
          <p className="absolute inset-0 flex items-center justify-center text-sm text-white">This comic has no pages.</p>
        )}
        {resolvedSrc && pageLoad.status !== 'failed' && (
          <img
            key={`${currentPage}-${pageLoad.attempt}`}
            src={resolvedSrc}
            alt={`Page ${currentPage + 1}`}
            className="absolute inset-0 h-full w-full object-contain"
            onLoad={handlePageLoaded}
            onError={handlePageError}
            draggable={false}
          />
        )}
        {isRetrying && (
          <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-white/70">Retrying…</p>
        )}
        {pageLoad.status === 'failed' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm text-white">
            <p>Couldn't load this page.</p>
            <button
              onClick={(e) => {
                e.stopPropagation()
                manualRetry()
              }}
              className="underline"
            >
              Retry
            </button>
          </div>
        )}
        {showChrome && pageCount > 0 && (
          <p className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs text-white/70">
            Page {currentPage + 1} of {pageCount}
          </p>
        )}
      </div>

      {showChrome && pageCount > 1 && (
        <div
          className="z-10 flex gap-1 overflow-x-auto bg-black/70 px-2 py-2"
          dir={direction === 'rtl' ? 'rtl' : 'ltr'}
        >
          {Array.from({ length: pageCount }, (_, i) => i).map((i) => (
            <button
              key={i}
              onClick={(e) => {
                e.stopPropagation()
                setCurrentPage(i)
                bumpChromeTimer()
              }}
              aria-label={`Jump to page ${i + 1}`}
              className="shrink-0 overflow-hidden rounded border-2"
              style={{ borderColor: i === currentPage ? 'white' : 'rgba(255,255,255,0.25)' }}
            >
              <img
                src={comicPageUrl(bookId!, i)}
                alt=""
                className="h-16 w-12 object-cover"
                loading="lazy"
                draggable={false}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
