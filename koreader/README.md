# OzzBooks for KOReader

A KOReader plugin that turns a jailbroken Kindle into a dedicated EPUB
reader for your OzzBooks library: browse your books, download EPUBs over
Tailscale, and sync reading position and manual bookmarks back to
OzzBooks' cloud API.

## Scope

EPUB only, on purpose — no audio, no comics. If you later want those on
a Kindle too, they'd need their own, very different plugins (Kindle
hardware has no meaningful audio path, and KOReader's own CBZ/CBR
support could read comics directly without needing OzzBooks involved at
all).

## The one real architectural limitation: position formats don't match

KOReader's EPUB engine (CREngine) tracks position as its own internal
"xpointer" string (e.g.
`/body/DocFragment[13]/body/div/p[35]/text().0`) — not an EPUB CFI, the
format OzzBooks' PWA reader (epub.js) uses. These are two different,
incompatible coordinate systems with no cheap translation between them —
exact, pixel-perfect cross-device resume isn't attempted.

What's built instead (2026-10-06): both sides also send an optional
`percent` (0-1 through the whole book) alongside their native position —
`ReaderRolling:getLastPercent()` here, `epub.locations.percentageFromCfi`
on the PWA. Each side can use the other's percent to land roughly in the
right spot via `GotoPercent`/`epub.locations.cfiFromPercentage` even
though it can't resolve the other's native format directly — approximate
(could be off by a page or so), not exact, but real cross-device
continuity rather than always starting over.

On the Kindle specifically, this only applies **the first time a book is
opened on this device** — every later open trusts KOReader's own native
per-device resume instead (see `OzzBooksLibrary:openBook`'s
`is_first_open_on_this_device` guard), so a cloud snapshot can never
regress an already-ongoing Kindle reading session.

Last-write-wins still works correctly at the *row* level (whichever
device synced most recently is what `GET /progress/:bookId` returns) —
it's specifically *cross-format resume* that doesn't work yet.

## What's verified vs. what needs on-device testing

Everything in `ozzbooks.koplugin/` is syntactically valid Lua (checked
with `luac -p`) and every KOReader API it calls was cross-checked
against real KOReader core source (`plugins/kosync.koplugin`,
`frontend/socketutil.lua`, `plugins/hello.koplugin`) — not guessed from
memory. Two things specifically could not be verified without a real
device/emulator and are worth testing first:

- **`Menu` widget construction** (`OzzBooksLibrary.lua`) — the
  `title`/`item_table`/`onMenuSelect`/`close_callback` shape follows the
  common pattern across KOReader's bundled plugins, but `Menu`'s exact
  API has shifted across KOReader releases before.
- **`MultiInputDialog`** (`main.lua`'s settings/login dialogs) — same
  caveat, less central to the plugin's core purpose (library browsing +
  sync still work via `Settings:set(...)` called directly if this needs
  a quick manual workaround during testing).

Everything else (plugin registration, `onPageUpdate`/`onCloseDocument`/
`onSuspend` hooks, `self.ui.rolling:getLastProgress()`, the
`socket.http`/`ltn12`/`socketutil` HTTP pattern, `ReaderUI:showReader()`,
`DataStorage`/`LuaSettings`) mirrors real koreader core usage directly.

## Install

1. Copy the whole `ozzbooks.koplugin/` folder onto the Kindle, into
   KOReader's `koreader/plugins/` directory (exact path depends on your
   jailbreak setup — typically
   `/mnt/us/koreader/plugins/ozzbooks.koplugin/`).
2. Restart KOReader.
3. From the file manager or a book, open the menu → **OzzBooks** →
   **Server settings**. Enter:
   - **Local server URL** — your Mac mini's Tailscale hostname, e.g.
     `https://jims-mac-mini.tail8b131b.ts.net` (no trailing slash,
     matches the production URL already in use elsewhere in this
     project).
   - **Local API token** — the same `OZZBOOKS_API_TOKEN` value the
     server process runs with (one shared token, not per-user — see
     `server/src/api/auth.ts`).
   - **Cloud server URL** — defaults to `https://ozzbooks.onrender.com`.
4. **OzzBooks → Log in to OzzBooks** with your existing OzzBooks email
   and password (same account the PWA uses). The resulting token is
   long-lived (90 days, same as the PWA — see `cloud/src/auth/tokens.ts`)
   and doesn't need re-entering every session.
5. **OzzBooks → Browse library** to download and open a book.

## Folder structure

```
ozzbooks.koplugin/
  _meta.lua              -- name/description KOReader's plugin manager reads
  main.lua                -- entrypoint: menu registration, reader lifecycle hooks
  OzzBooksApiClient.lua    -- generic HTTP client (local + cloud, both backends)
  OzzBooksSettings.lua     -- persisted config (server URLs, tokens) via LuaSettings
  OzzBooksCache.lua        -- local EPUB file cache (keep-forever, manual clear)
  OzzBooksLibrary.lua      -- library list fetch + browsing Menu + download/open flow
  OzzBooksSync.lua         -- position/bookmark push, debounce, offline retry queue
```

## Offline / retry behavior

Every position change is written to a small persisted `pending_sync`
table (via `LuaSettings`, survives a crash or reboot) before the network
push is even attempted — the debounced push just decides *when* to try
sending it, not whether the position is remembered. A failed push (no
network, server unreachable) leaves the entry in `pending_sync`; it's
retried opportunistically on the next push cycle and from **OzzBooks →
Sync now**. There's no exponential backoff timer running in the
background — this is deliberately simple (retry-on-next-activity, same
philosophy as OzzBooks' own NAS-mount watchdog: cheap and good enough
for a personal device, not a distributed-systems retry policy).

## Not built (deferred)

- **Two-way bookmark sync** — this plugin can push a new bookmark
  (**OzzBooks → Bookmark this page**) but doesn't pull existing OzzBooks
  bookmarks into KOReader's own bookmark list, and doesn't hook
  KOReader's native "add bookmark" action directly (that would need its
  exact event name/signature verified on-device first).
- **Cover thumbnails in the library browser** — plain text list
  (title — author — series #N) for v1; a cover-grid view is possible
  but is real additional complexity (KOReader's CoverBrowser-style
  plugins), not attempted here.
- **Automatic cache eviction** — EPUBs are cached forever until a
  manual clear; see `OzzBooksCache.lua`'s own comment for why that's a
  deliberate simplification, not an oversight.
- **Exact xpointer ↔ CFI translation** — see the limitation above; the
  percent-based *approximate* cross-device sync is built, exact
  position-for-position resume is not.
