import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Epub from 'epubjs'
import type Rendition from 'epubjs/types/rendition'
import { fetchBook, fetchEpubBytes } from '../api/client'
import { adaptBookDetail } from '../api/adapter'
import { reconcileProgress } from '../offline/reconcile'
import { trySync } from '../offline/syncEngine'
import { putLocalProgress } from '../offline/progressStore'
import { getCachedEpubFile, touchEpubLastRead } from '../offline/epubFileStore'
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

// Module-level (survives unmount, shared across every EbookReader
// instance) — every genuine relocate fires an immediate, un-debounced
// local write via `void putLocalProgress(...)` (see the 'relocated'
// handler below), deliberately not awaited so the event handler returns
// immediately. Reopening the same book right after closing it can
// otherwise start reading local storage before that write actually
// lands — local IndexedDB writes aren't instantaneous, even when
// started right away. Tracked per book id so the next mount for that
// same book can await it before reconciling, without making an
// unrelated book's open wait on anything.
const pendingFlushes = new Map<string, Promise<void>>()

// REMOVED (real bug, caught live): a localStorage-based "last known
// position" mirror used to live here, meant to survive a quit/OS-suspend
// interrupting the regular async save. It backfired badly — deleting a
// book's progress (Library's "Remove from In Progress") only ever cleared
// the real local/cloud records, never knew this separate layer existed at
// all, so a stale value here could silently resurrect itself forever:
// confirmed live, deleting progress and reopening immediately still
// landed on the old page, before any new activity that session. Worse,
// there was no clear evidence it ever reliably won a genuine race in the
// first place. Removed entirely rather than patched, since the debounced
// save plus its three flush points (visibilitychange, pagehide, unmount —
// see pendingFlushes above and the 'relocated' handler below) already
// cover the same ground without a second, unmanaged persistence layer.
//
// Runs once, the first time this module loads in a session — purges
// whatever got stuck under the old key prefix while that mechanism
// existed, for every book, not just the one being opened right now. A
// plain module-level statement rather than a per-mount effect: this only
// ever needs to happen once per app load, not once per book opened.
const LAST_POSITION_STORAGE_PREFIX = 'ozzbooks_ebook_last_position_'
try {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const key = localStorage.key(i)
    if (key?.startsWith(LAST_POSITION_STORAGE_PREFIX)) localStorage.removeItem(key)
  }
} catch {
  // Best-effort — private browsing/storage-disabled can throw; nothing to
  // clean up in that case anyway.
}

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
  // Captured the moment relocate fires, not when the debounced save (or a
  // much-later flush of a stale backgrounded tab) actually dispatches —
  // last-write-wins on the server compares this timestamp, so it must
  // reflect when the reader was genuinely at this position, not whenever
  // the network request happened to go out. Getting this wrong is exactly
  // how a stale tab's delayed flush can stamp an old page with a fresh
  // "now" and clobber real, more recent progress from another device.
  const currentCfiCapturedAtRef = useRef<string | undefined>(undefined)
  // A timestamp (not a single-consume boolean — see below) set just
  // before a programmatic display()/resize() call this component makes on
  // the reader's own behalf (restoring saved progress, the
  // reflow-correction re-display, a live prefs change re-paginating, or
  // epub.js's own internal window-resize redisplay). Every 'relocated'
  // event that fires before this deadline is treated as a side effect of
  // that programmatic call, not a real page turn, and skips scheduling a
  // save. Restoring a CFI can resolve to a very slightly different
  // paginated position than where it was originally saved (epub.js
  // snapping to the nearest page boundary is not perfectly stable across
  // re-renders) — without this guard, simply *reopening* the book fires a
  // real relocate for that resolved position and schedules a save for it,
  // quietly regressing progress by a page or two even though the user
  // never touched anything. Genuine page turns (next()/prev()/tap
  // navigation) never touch this, so they save normally.
  //
  // Real bug caught live: this used to be a boolean consumed (reset) by
  // the very next 'relocated' event. That worked for a single display()
  // call, but epub.js's own internal resize handling — confirmed in its
  // source, see the window-resize listener below and the showSettings
  // effect further down — does its own clear() *then* a separate
  // re-display, firing 'relocated' twice for one logical resize: once for
  // the transitional clear() (correctly suppressed and consuming the
  // flag), then again once the reflow actually settles, at a
  // recalculated position a column-width change can land earlier than
  // intended. With a single-consume flag, that second event was
  // completely unprotected and got saved as if it were a genuine page
  // turn. A time window that stays open for every event in that stretch,
  // rather than clearing after the first, covers both.
  const suppressUntilRef = useRef(0)
  const suppressNextSave = useCallback(() => {
    suppressUntilRef.current = Date.now() + 500
  }, [])
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
  // True for the duration of epub.locations.generate() (see the
  // background-indexing block below) — this build of epub.js drives the
  // real, visible Rendition through the whole book to measure it, firing
  // a genuine 'relocated' for every step. The relocated handler checks
  // this first and ignores those events entirely (not just skipping the
  // save — see its own comment for why).
  const indexingLocationsRef = useRef(false)
  // True once a genuine (non-suppressed, non-indexing) 'relocated' has
  // fired since this book's own load() started — i.e. the reader has
  // actually turned a page since opening, as opposed to just having
  // *resolved* its initial display(startCfi) call. Reset at the top of
  // every load(). See the 800ms reflow-correction setTimeout further down
  // for why this, not a raw CFI comparison, is what that correction needs
  // to check.
  const hasNavigatedSinceLoadRef = useRef(false)
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
    hasNavigatedSinceLoadRef.current = false
    let cancelled = false
    let rendition: Rendition | null = null
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    let removeVisibilityListeners: (() => void) | null = null

    async function load() {
      try {
        // Waits for this exact book's own still-in-flight close-time save
        // (if any) to actually finish writing to local storage before this
        // new session reads from it — see pendingFlushes' own comment for
        // why that write isn't awaited at the point it's fired.
        await pendingFlushes.get(bookId!)
        // Cache-first, unconditionally (not gated on navigator.onLine) —
        // same pattern as PlayerContext's audio resolution: if it's
        // downloaded, use it, regardless of connectivity.
        const cached = await getCachedEpubFile(bookId!)
        if (cached) void touchEpubLastRead(bookId!, new Date().toISOString())
        const [detail, bytes, progress] = await Promise.all([
          fetchBook(bookId!).then(adaptBookDetail),
          cached ? cached.blob.arrayBuffer() : fetchEpubBytes(bookId!),
          // reconcileProgress (local-vs-cloud, newer wins), not a raw
          // cloud fetch — see the 'relocated' handler's local-write switch
          // below for why: a fetch straight from the cloud could race ahead of this same
          // book's *own* still-in-flight background sync from the
          // session that just closed (close book, reopen it right away —
          // the debounced/flush PUT from a moment ago hadn't necessarily
          // reached the server yet), silently restoring a stale position
          // a page or two behind where the reader actually left off.
          // reconcileProgress checks local IndexedDB first, which that
          // same just-closed session already wrote to synchronously, so
          // a same-device reopen never has to win a race against the
          // network at all.
          reconcileProgress(auth.token, bookId!),
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
            const displayed = location.start?.displayed
            if (indexingLocationsRef.current) {
              // epub.locations.generate() (see the background-indexing
              // block further down) doesn't parse sections headlessly in
              // this build — it drives the real, visible Rendition
              // through the entire book from the start to measure it,
              // which fires a genuine 'relocated' event for every step of
              // that walk. Nothing about this reflects where the reader
              // actually is, so it must not touch
              // currentCfiRef/pageInfo/percent either (a later flush —
              // pagehide, unmount — could otherwise pick up the scan's
              // position instead of the real one), not just skip the save.
              return
            }
            currentCfiRef.current = cfi
            currentCfiCapturedAtRef.current = new Date().toISOString()
            if (displayed?.page && displayed.total) {
              setPageInfo({ page: displayed.page, total: displayed.total })
            }
            if (locationsReadyRef.current) {
              setPercent(Math.round(epub.locations.percentageFromCfi(cfi) * 100))
            }
            if (Date.now() < suppressUntilRef.current) {
              return
            }
            hasNavigatedSinceLoadRef.current = true
            // Real bug caught live: the whole save — including the local
            // IndexedDB write, not just the network push — used to sit
            // behind this same 2-second debounce. An abrupt PWA quit
            // (swiped away in the app switcher, not a graceful
            // backgrounding) doesn't reliably fire visibilitychange or
            // pagehide in time to flush it, so a page turn followed
            // quickly by quitting could lose the local write entirely —
            // reopening then restored whatever the *last actually-saved*
            // position was, several pages behind. The local write below
            // is now immediate and undebounced on every genuine relocate —
            // it's cheap, and durability shouldn't depend on a timer or a
            // lifecycle event firing correctly. Only the network push
            // (syncing every page turn would spam the cloud API for no
            // benefit) stays debounced, further down.
            const capturedAt = currentCfiCapturedAtRef.current
            const flushPromise: Promise<void> = putLocalProgress({
              bookId: bookId!,
              chapterId: '',
              position: { type: 'cfi', value: cfi },
              updatedAt: capturedAt,
              synced: false,
            }).finally(() => {
              if (pendingFlushes.get(bookId!) === flushPromise) pendingFlushes.delete(bookId!)
            })
            pendingFlushes.set(bookId!, flushPromise)

            if (saveTimer) clearTimeout(saveTimer)
            saveTimer = setTimeout(() => {
              saveTimer = null
              void trySync(auth.token)
            }, 2000)
          },
        )

        const flushPendingSave = () => {
          if (!saveTimer) return
          clearTimeout(saveTimer)
          saveTimer = null
          // The local write itself already happened synchronously above,
          // on the relocate itself — this only needs to push it to the
          // cloud without waiting out the rest of the debounce window.
          void trySync(auth.token)
        }
        const onVisibilityChange = () => {
          if (document.visibilityState === 'hidden') flushPendingSave()
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        // pagehide covers iOS discarding the page outright while
        // backgrounded (no visibilitychange guaranteed in that case) —
        // belt and suspenders for the same flush.
        window.addEventListener('pagehide', flushPendingSave)
        // Real bug caught live: epub.js wires its own window 'resize'
        // listener internally (see the showSettings effect's comment
        // below) — completely separately from this component's own
        // explicit rendition.resize() calls, which are the only ones
        // guarded by suppressNextSave(). On iOS Safari, the toolbar
        // auto-hiding/showing as the page scrolls fires a genuine
        // window resize event, which trips epub.js's *own* internal
        // handler: it re-measures the column width and re-displays at
        // its last-known location on its own, with no way for this
        // component to tell that redisplay apart from a real page
        // turn. In two-column (spread) layout that re-pagination can
        // land the "current" CFI on the previous screen's worth of
        // text — a genuinely different, earlier position — which then
        // gets saved immediately as if the reader had turned back a
        // page. Treating every window resize as a potential
        // programmatic re-display, exactly like this component's own
        // resize() calls, closes that gap.
        const onWindowResize = () => suppressNextSave()
        window.addEventListener('resize', onWindowResize)
        removeVisibilityListeners = () => {
          document.removeEventListener('visibilitychange', onVisibilityChange)
          window.removeEventListener('pagehide', flushPendingSave)
          window.removeEventListener('resize', onWindowResize)
        }

        const startCfi = progress?.position.type === 'cfi' ? progress.position.value : undefined
        if (startCfi) suppressNextSave()
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
          // calculation against the final layout. Guarded on the reader
          // not having genuinely turned a page in the meantime, so this
          // can't yank them back if they have.
          //
          // Real bug caught live, and the actual source of the "goes back
          // several pages" regression: this used to compare
          // currentCfiRef.current against startCfi instead of checking
          // hasNavigatedSinceLoadRef. That looks equivalent but isn't —
          // currentCfiRef.current is updated by the *initial*
          // display(startCfi) call's own (suppressed-from-saving, but
          // not from updating state) relocate too. When that first
          // resolve was itself imprecise — exactly the reflow/column-
          // width-timing problem this correction exists to fix — it left
          // currentCfiRef pointing at the wrong, already-regressed
          // position, which then never equals startCfi, so the
          // comparison silently concluded "the user already navigated,
          // leave it alone" and skipped the very correction meant to fix
          // that regressed position — every time it happened. Checking
          // whether the reader has genuinely navigated (a real,
          // unsuppressed relocate) instead of comparing CFIs correctly
          // still protects a real page turn in this window, without
          // being fooled by the initial resolve's own imprecision.
          setTimeout(() => {
            if (cancelled || !renditionRef.current) return
            if (hasNavigatedSinceLoadRef.current) return
            suppressNextSave()
            void renditionRef.current.display(startCfi)
          }, 800)
        }
        setStatus('ready')

        // Whole-book percentage — fire-and-forget, never blocks the
        // reader from opening. Cached locations restore near-instantly;
        // a fresh generate() is several seconds (walks the whole book's
        // text), so this can easily still be running while the reader is
        // already showing pages. The resulting percentage is still valid
        // regardless of font-size/line-height changes (it's a character
        // count under the hood) — but real bug caught live: generate()
        // itself is NOT the headless, rendition-independent parse that
        // implies. In this build it drives the actual visible Rendition
        // through the entire book to measure it, from the very start —
        // see indexingLocationsRef below and the relocated handler above
        // for how that's kept from being saved as real reading progress.
        void (async () => {
          try {
            const cachedLocations = await getCachedLocations(bookId!)
            if (cancelled) return
            if (cachedLocations) {
              epub.locations.load(cachedLocations.locations)
            } else {
              // See indexingLocationsRef's own comment and the relocated
              // handler above — generate() drives the visible Rendition
              // through the whole book, so the reader's real position
              // (currentCfiRef) must be untouched by that walk's own
              // 'relocated' events, and the walk itself visibly leaves
              // the rendition wherever it happened to finish. Both are
              // repaired below once it's done.
              const realCfiBeforeIndexing = currentCfiRef.current
              indexingLocationsRef.current = true
              try {
                await epub.locations.generate(150)
              } finally {
                indexingLocationsRef.current = false
              }
              if (cancelled) return
              if (realCfiBeforeIndexing && renditionRef.current) {
                suppressNextSave()
                void renditionRef.current.display(realCfiBeforeIndexing)
              }
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
      // The local write already happened synchronously on the 'relocated'
      // handler itself, not deferred to here — this only needs to push
      // whatever's pending to the cloud rather than waiting out the rest
      // of the debounce window.
      if (saveTimer) {
        clearTimeout(saveTimer)
        void trySync(auth.token)
      }
      removeVisibilityListeners?.()
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
    if (currentCfiRef.current) {
      suppressNextSave()
      void rendition.display(currentCfiRef.current)
    }
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
    // resize() re-displays internally at the current cfi when it detects a
    // size change (see the comment above) — that re-display fires
    // 'relocated' just like a real page turn, so it needs the same
    // not-a-real-navigation guard as the other programmatic display()
    // calls in this component.
    suppressNextSave()
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
