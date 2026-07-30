import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Epub from 'epubjs'
import type Rendition from 'epubjs/types/rendition'
import { fetchBook, fetchEpubBytes } from '../api/client'
import { adaptBookDetail } from '../api/adapter'
import { fetchBookProgress, putProgress } from '../api/cloudClient'
import { getCachedEpubFile } from '../offline/epubFileStore'
import { getCachedLocations, putCachedLocations } from '../offline/bookLocationsStore'
import { useAuth } from '../auth/AuthContext'
import {
  loadReaderPrefs,
  saveReaderPrefs,
  READER_THEMES,
  LINE_HEIGHT_OPTIONS,
  FONT_SIZE_MIN,
  FONT_SIZE_MAX,
  FONT_SIZE_STEP,
  type ReaderPrefs,
  type ReaderThemeName,
} from '../reader/readerPrefs'

const FONT_STACK = 'Georgia, "Times New Roman", Times, serif'
const READER_THEME_NAME = 'reader'

// A single theme (name never changes — only its rules do), applied via
// the object-rules API (register/registerRules), not registerCss. Two
// things this deliberately avoids, both found the hard way:
// - registerCss stores the theme as `serialized` CSS text, but epub.js's
//   own inject() hook — which auto-applies the current theme to any
//   *newly created* content view (e.g. the one its internal resize()
//   handling recreates) — only checks for `theme.rules`/`theme.url`, not
//   `theme.serialized`. A registerCss theme silently never gets applied
//   to a view epub.js creates on its own, only to views this component
//   explicitly re-applies it to itself.
// - Registering 3 separately-named themes and switching via select() runs
//   into the same issue from a different angle: select() toggles a CSS
//   class, but the actual rules it injects use plain unscoped selectors
//   (body, not .dark body), so which theme visually wins depends on
//   injected <style>-tag order across separate stylesheets — this didn't
//   reliably apply to already-rendered content in practice.
// One rules-based theme, re-registered under the same name on every
// preference change, sidesteps both: inject() picks it up automatically
// on any view epub.js creates, and there's never more than one candidate
// stylesheet to order against.
function buildThemeRules(bg: string, fg: string, lineHeight: number) {
  return {
    body: {
      background: `${bg} !important`,
      color: `${fg} !important`,
      'font-family': `${FONT_STACK} !important`,
      'line-height': `${lineHeight} !important`,
    },
    p: { 'font-family': `${FONT_STACK} !important` },
    a: { color: `${fg} !important` },
    // Some publishers (calibre's default cover page, notably) wrap the
    // cover in an <svg width="100%" height="100%"> full-bleed image. Left
    // unconstrained, that percentage height makes epub.js's column-
    // pagination measurement blow up — it reads the section as spanning
    // many internal "pages" instead of one, so next()/prev() appear stuck
    // cycling through slivers of the same cover instead of reaching
    // chapter 1. Capping image/svg size to the viewport keeps that
    // measurement sane.
    img: {
      'max-width': '100% !important',
      'max-height': '100vh !important',
      'object-fit': 'contain !important',
    },
    svg: {
      'max-width': '100% !important',
      'max-height': '100vh !important',
      height: 'auto !important',
    },
  }
}

function ReaderSettingsPanel({
  prefs,
  onChange,
  fg,
  bg,
}: {
  prefs: ReaderPrefs
  onChange: (partial: Partial<ReaderPrefs>) => void
  fg: string
  bg: string
}) {
  return (
    <div className="space-y-3 border-b px-4 py-3 text-sm" style={{ background: bg, color: fg, borderColor: `${fg}33` }}>
      <div className="flex items-center justify-between">
        <span>Text size</span>
        <div className="flex items-center gap-3">
          <button
            onClick={() => onChange({ fontSizePct: Math.max(FONT_SIZE_MIN, prefs.fontSizePct - FONT_SIZE_STEP) })}
            disabled={prefs.fontSizePct <= FONT_SIZE_MIN}
            aria-label="Decrease text size"
            className="h-7 w-7 rounded border text-xs disabled:opacity-40"
            style={{ borderColor: `${fg}55` }}
          >
            A-
          </button>
          <span className="w-10 text-center text-xs tabular-nums">{prefs.fontSizePct}%</span>
          <button
            onClick={() => onChange({ fontSizePct: Math.min(FONT_SIZE_MAX, prefs.fontSizePct + FONT_SIZE_STEP) })}
            disabled={prefs.fontSizePct >= FONT_SIZE_MAX}
            aria-label="Increase text size"
            className="h-7 w-7 rounded border text-sm disabled:opacity-40"
            style={{ borderColor: `${fg}55` }}
          >
            A+
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span>Line spacing</span>
        <div className="flex overflow-hidden rounded border" style={{ borderColor: `${fg}55` }}>
          {LINE_HEIGHT_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => onChange({ lineHeight: opt.value })}
              className="px-2 py-1 text-xs"
              style={prefs.lineHeight === opt.value ? { background: fg, color: bg } : undefined}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <span>Theme</span>
        <div className="flex gap-2">
          {(Object.entries(READER_THEMES) as [ReaderThemeName, (typeof READER_THEMES)[ReaderThemeName]][]).map(
            ([key, t]) => (
              <button
                key={key}
                onClick={() => onChange({ theme: key })}
                aria-label={t.label}
                title={t.label}
                className="h-7 w-7 rounded-full border-2"
                style={{ background: t.bg, borderColor: prefs.theme === key ? fg : 'transparent' }}
              />
            ),
          )}
        </div>
      </div>
    </div>
  )
}

// No page-turn animation, minimal chrome — epub.js's default paginated
// flow doesn't animate transitions on its own, so simply not adding any
// custom transition/animation CSS already satisfies that part of the spec.
export function EbookReader() {
  const { bookId } = useParams()
  const navigate = useNavigate()
  const auth = useAuth()
  const containerRef = useRef<HTMLDivElement>(null)
  const renditionRef = useRef<Rendition | null>(null)
  const currentCfiRef = useRef<string | undefined>(undefined)
  // Guards the live-prefs effect below against firing a redundant, racing
  // display() call the moment status first flips to 'ready' — that effect
  // is keyed on [prefs, status], and the initial ready transition would
  // otherwise re-trigger it immediately after the mount effect's own
  // first display() already applied the current prefs correctly.
  const skipNextPrefsApplyRef = useRef(true)
  // Same guard, same reason, for the settings-panel resize effect further
  // below — also keyed on `status`, also fires spuriously on the initial
  // ready transition (see that effect's comment for why that one actually
  // corrupts the freshly-restored reading position, not just wastes work).
  const skipNextResizeRef = useRef(true)
  // book.locations (the whole-book percentage index) loads/generates in
  // the background after the reader's already showing a page — this
  // tracks whether it's ready yet, checked inside the relocated handler
  // below. A ref, not state: it's only ever read inside that handler, and
  // flipping it shouldn't itself trigger a re-render.
  const locationsReadyRef = useRef(false)
  const [title, setTitle] = useState('')
  const [status, setStatus] = useState<'loading' | 'error' | 'ready'>('loading')
  const [showSettings, setShowSettings] = useState(false)
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadReaderPrefs)
  // Page N of M within the current chapter — epub.js's paginated layout
  // computes this for free on every relocate, no locations index needed.
  const [pageInfo, setPageInfo] = useState<{ page: number; total: number } | null>(null)
  // Percentage through the *whole book* — needs book.locations (see
  // locationsReadyRef above), null until that's ready.
  const [percent, setPercent] = useState<number | null>(null)

  useEffect(() => {
    if (!bookId || !containerRef.current) return
    skipNextPrefsApplyRef.current = true
    skipNextResizeRef.current = true
    let cancelled = false
    let rendition: Rendition | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null

    async function load() {
      try {
        // Cache-first, unconditionally (not gated on navigator.onLine) —
        // same pattern as PlayerContext's audio resolution: if it's
        // downloaded, use it, regardless of connectivity.
        const cached = await getCachedEpubFile(bookId!)
        const [detail, bytes, progress] = await Promise.all([
          fetchBook(bookId!).then(adaptBookDetail),
          cached ? cached.blob.arrayBuffer() : fetchEpubBytes(bookId!),
          auth.token ? fetchBookProgress(auth.token, bookId!) : Promise.resolve(null),
        ])
        if (cancelled) return
        setTitle(detail.title)

        const epub = Epub(bytes)
        const newRendition = epub.renderTo(containerRef.current!, { width: '100%', height: '100%' })
        if (cancelled) {
          // The effect was already cleaned up while renderTo (synchronous,
          // no await) ran — React 18/19 StrictMode's dev-mode double-invoke
          // (mount -> cleanup -> mount) fires cleanup before this async
          // function reaches this point, so the returned cleanup closure
          // never had a rendition to destroy. Tear this one down directly
          // instead of leaving an orphaned iframe in the shared container
          // for the second (live) instance to render alongside. No-op in
          // production, where effects only ever run once.
          newRendition.destroy()
          return
        }
        rendition = newRendition
        renditionRef.current = rendition

        const initialColors = READER_THEMES[prefs.theme]
        rendition.themes.register(READER_THEME_NAME, buildThemeRules(initialColors.bg, initialColors.fg, prefs.lineHeight))
        rendition.themes.select(READER_THEME_NAME)
        rendition.themes.fontSize(`${prefs.fontSizePct}%`)

        // Registered before the first display() call (not after) so it
        // also catches the very first page's location — relocated fires
        // on every displayed page, including the initial one, and
        // currentCfiRef needs a real value from the start so a preference
        // change made before the reader's first page-turn still has
        // somewhere valid to re-paginate from (see the prefs effect below).
        rendition.on(
          'relocated',
          (location: { start?: { cfi?: string; displayed?: { page?: number; total?: number } } }) => {
            const cfi = location?.start?.cfi
            if (!cfi) return
            currentCfiRef.current = cfi
            const displayed = location.start?.displayed
            if (displayed?.page && displayed.total) {
              setPageInfo({ page: displayed.page, total: displayed.total })
            }
            if (locationsReadyRef.current) {
              setPercent(Math.round(epub.locations.percentageFromCfi(cfi) * 100))
            }
            if (!auth.token) return
            // Debounced — relocated fires on every page turn, syncing
            // every single one would spam the cloud API for no benefit
            // over just capturing where the reader settles.
            if (saveTimer) clearTimeout(saveTimer)
            saveTimer = setTimeout(() => {
              void putProgress(auth.token!, bookId!, {
                position: { type: 'cfi', value: cfi },
                chapterId: null,
                updatedAt: new Date().toISOString(),
              })
            }, 2000)
          },
        )

        const startCfi = progress?.position.type === 'cfi' ? progress.position.value : undefined
        try {
          await rendition.display(startCfi)
        } catch {
          // A saved CFI from a prior broken session (e.g. captured while
          // pagination was still miscalculating on this exact section —
          // see the img/svg cover-pagination fix above) can point at a
          // location epub.js can no longer resolve. Don't strand the
          // reader on that — fall back to the very beginning instead of
          // leaving it stuck loading.
          if (startCfi) await rendition.display()
        }
        if (cancelled) return
        if (startCfi) {
          // display(cfi) resolves the section, then separately computes a
          // pixel offset and scrolls to it (epub.js's DefaultViewManager)
          // — it never re-runs that scroll if the section reflows *after*
          // (a late-loading image, a web font swap, a ResizeObserver
          // correction all trigger a silent re-layout with no re-scroll).
          // The scroll position then points past — or between — the
          // reflowed content, landing on a blank paginated "page" even
          // though the section itself rendered fine (hence the theme/
          // background color still showing). Re-issuing display() at the
          // same CFI once things have settled re-does that offset
          // calculation against the final layout. Guarded on the current
          // location still being where we left it, so this can't yank the
          // reader back if they've already turned a page in the meantime.
          setTimeout(() => {
            if (cancelled || !renditionRef.current) return
            if (currentCfiRef.current !== startCfi) return
            void renditionRef.current.display(startCfi)
          }, 800)
        }
        setStatus('ready')

        // Whole-book percentage — fire-and-forget, never blocks the
        // reader from opening. Cached locations restore near-instantly;
        // a fresh generate() is several seconds (walks the whole book's
        // text), so this can easily still be running while the reader is
        // already showing pages. Character-count-based, not layout-based,
        // so it's valid regardless of font-size/line-height changes.
        void (async () => {
          try {
            const cachedLocations = await getCachedLocations(bookId!)
            if (cancelled) return
            if (cachedLocations) {
              epub.locations.load(cachedLocations.locations)
            } else {
              await epub.locations.generate(150)
              if (cancelled) return
              void putCachedLocations(bookId!, epub.locations.save())
            }
            if (cancelled) return
            locationsReadyRef.current = true
            // Compute for the *current* position right away, rather than
            // waiting for the next page turn — generate() can finish
            // while the reader is sitting still, and relocated won't fire
            // again until the next prev()/next().
            if (currentCfiRef.current) {
              setPercent(Math.round(epub.locations.percentageFromCfi(currentCfiRef.current) * 100))
            }
          } catch {
            // Soft-fail — the percentage is a nice-to-have; a malformed
            // book failing to index isn't worth surfacing as a reader
            // error when everything else about it works fine.
          }
        })()
      } catch {
        if (!cancelled) setStatus('error')
      }
    }

    void load()
    return () => {
      cancelled = true
      if (saveTimer) clearTimeout(saveTimer)
      rendition?.destroy()
      renditionRef.current = null
    }
    // Deliberately excludes `prefs` — this effect creates the rendition
    // fresh once per book; live preference changes are applied to the
    // existing rendition by the effect below instead of tearing this one
    // down and losing the reader's current page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId])

  // Applies preference changes live, without recreating the rendition
  // (which would reset scroll/page position). Skipped until the initial
  // mount effect above has actually registered the themes to select from.
  useEffect(() => {
    saveReaderPrefs(prefs)
    const rendition = renditionRef.current
    if (!rendition || status !== 'ready') return
    if (skipNextPrefsApplyRef.current) {
      // The mount effect already applied these exact prefs before its own
      // first display() call — this run is just this effect reacting to
      // status flipping to 'ready', not an actual preference change, so
      // there's nothing new to (re-)apply.
      skipNextPrefsApplyRef.current = false
      return
    }
    const colors = READER_THEMES[prefs.theme]
    // register() re-registers the same theme name with fresh rules, then
    // update() re-applies it to the content already on screen — inject()
    // (epub.js's own auto-apply-on-new-view hook, see buildThemeRules'
    // comment above) picks up this same registered theme on its own for
    // any view epub.js creates later without this component's involvement.
    rendition.themes.register(READER_THEME_NAME, buildThemeRules(colors.bg, colors.fg, prefs.lineHeight))
    rendition.themes.update(READER_THEME_NAME)
    rendition.themes.fontSize(`${prefs.fontSizePct}%`)
    // epub.js's paginated column layout computes page-break boundaries
    // once, at display() time — changing font-size/line-height afterward
    // changes how much text a "page" actually holds without epub.js
    // re-measuring those boundaries on its own, so the bottom of the
    // current page ends up clipping content that no longer fits. Forcing
    // a fresh display() at the same CFI makes it re-paginate from here
    // with the new styles already applied, rather than reusing stale ones.
    if (currentCfiRef.current) void rendition.display(currentCfiRef.current)
  }, [prefs, status])

  // The settings panel taking/giving back vertical space is a pure
  // flexbox layout change — epub.js only re-measures its container on the
  // browser window's own resize event (confirmed in its source: it wires
  // window.addEventListener('resize', ...), not a ResizeObserver on the
  // container), so it never notices this on its own. Without an explicit
  // resize() call here, opening the panel, changing a setting, then
  // closing it again leaves the content paginated to the shrunken height
  // — the newly-reclaimed space at the bottom just stays blank.
  useEffect(() => {
    const rendition = renditionRef.current
    if (!rendition || status !== 'ready') return
    if (skipNextResizeRef.current) {
      // Same spurious-refire issue as skipNextPrefsApplyRef above — this
      // effect is keyed on `status` too, so the initial loading->ready
      // transition fires it right after the mount effect's own
      // display(startCfi) already established the correct position.
      // resize() isn't a no-op read-only measurement: per epub.js's
      // internals, if it detects any size difference it calls clear() and
      // re-displays internally at `this.location.start.cfi` — running
      // that this early, before the just-set location has settled, was
      // corrupting a freshly-restored reading position into a blank page
      // (reported as "reopening an ebook shows a blank page, colors but
      // no content"). Only genuine showSettings toggles after mount
      // should trigger this.
      skipNextResizeRef.current = false
      return
    }
    // epubjs's own type declarations wrongly mark width/height as
    // required — the real implementation treats no-args as "measure the
    // container's current size", which is exactly what's needed here.
    ;(rendition.resize as unknown as () => void)()
  }, [showSettings, status])

  function updatePrefs(partial: Partial<ReaderPrefs>) {
    setPrefs((p) => ({ ...p, ...partial }))
  }

  const { bg, fg } = READER_THEMES[prefs.theme]

  return (
    <div
      className="fixed inset-0 flex flex-col"
      style={{ background: bg, paddingTop: 'env(safe-area-inset-top)', paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-center justify-between gap-2 px-4 py-2" style={{ color: fg }}>
        <button onClick={() => navigate(-1)} className="shrink-0 text-sm underline">
          ← Back
        </button>
        <p className="min-w-0 flex-1 truncate text-center text-sm font-medium">{title}</p>
        <div className="flex shrink-0 items-center gap-3">
          {status === 'ready' && (
            <button
              onClick={() => void renditionRef.current?.display()}
              className="text-xs underline"
              title="Jump back to the first page — useful if a saved position from an earlier session left you stuck"
            >
              Start over
            </button>
          )}
          <button
            onClick={() => setShowSettings((s) => !s)}
            aria-label="Reading settings"
            aria-pressed={showSettings}
            className="text-sm font-medium underline"
          >
            Aa
          </button>
        </div>
      </div>

      {showSettings && <ReaderSettingsPanel prefs={prefs} onChange={updatePrefs} fg={fg} bg={bg} />}

      {/* The epub container below must always be the sole flex-1 child of
          the outer column — epub.renderTo() measures it synchronously
          while status is still 'loading' (setStatus('ready') only happens
          after display() resolves), so a sibling that also claims flex-1
          space during loading would make epub.js paginate against half
          the real height. Loading/error text is an absolute overlay on
          top of the (still-empty) container instead, same pattern as the
          prev/next buttons below. */}
      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {status === 'loading' && (
          <p className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: fg }}>
            Loading…
          </p>
        )}
        {status === 'error' && (
          <p className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: fg }}>
            Couldn't load this book.
          </p>
        )}
        {status === 'ready' && (
          <>
            <button
              aria-label="Previous page"
              onClick={() => void renditionRef.current?.prev()}
              className="absolute left-0 top-0 h-full w-1/5"
            />
            <button
              aria-label="Next page"
              onClick={() => void renditionRef.current?.next()}
              className="absolute right-0 top-0 h-full w-1/5"
            />
            {pageInfo && (
              <p
                className="pointer-events-none absolute inset-x-0 bottom-2 text-center text-xs opacity-70"
                style={{ color: fg }}
              >
                Page {pageInfo.page} of {pageInfo.total}
                {percent !== null && ` · ${percent}%`}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
