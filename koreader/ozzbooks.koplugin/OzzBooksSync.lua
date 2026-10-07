--[[--
Reading-position (and bookmark) sync against OzzBooks' CLOUD API.

Position capture mirrors koreader core's own plugins/kosync.koplugin:
hook onPageUpdate, and for a reflowable document (EPUB — the only format
this plugin ever opens) read the current position via
self.ui.rolling:getLastProgress(), which returns KOReader's own internal
xpointer string. That is NOT an EPUB CFI — see OzzBooksApiClient's and
the project's Claude.md notes on this — so it's sent as
{type = "koreader-xpointer", value = xpointer}, a position type OzzBooks'
cloud API accepts but the PWA's own ebook reader doesn't try to resume
from (graceful no-op there, not an error).

book_id recovery: this plugin only ever opens a file from
OzzBooksCache's cache dir, named "<book_id>.epub" — so the id is
recovered from the open document's own file path rather than kept in a
separate mapping. Opening some unrelated EPUB (not from that cache dir)
means getCurrentBookId() returns nil and every hook below is a no-op —
this plugin only ever syncs OzzBooks books, never touches a document it
didn't hand out itself.
--]]--

local UIManager = require("ui/uimanager")
local NetworkMgr = require("ui/network/manager")
local Event = require("ui/event")
local logger = require("logger")

local ApiClient = require("OzzBooksApiClient")
local Settings = require("OzzBooksSettings")
local Cache = require("OzzBooksCache")

local OzzBooksSync = {
    -- Debounce handle so rapid page turns collapse into one push instead
    -- of one network request per page, same reasoning as the PWA
    -- EbookReader's own 2-second debounce on the network push half of
    -- its save (the local write there is immediate/undebounced; the
    -- Kindle has no local progress store of its own to mirror that with,
    -- so this debounces the whole thing).
    pending_push = nil,
    -- {book_id=, percent=} set by prepareRestore (called from
    -- OzzBooksLibrary:openBook, first-open-only — see its own comment),
    -- consumed once by consumeRestoreForCurrentDocument when
    -- onReaderReady fires for that same book. nil the rest of the time.
    pending_restore = nil,
}

local DEBOUNCE_SECONDS = 3

local function cloudHeaders()
    return { Authorization = "Bearer " .. Settings:get("cloud_token") }
end

-- Recovers "<book_id>" from ".../ozzbooks_cache/<book_id>.epub", or nil
-- if the open document isn't one this plugin handed out.
local function getCurrentBookId(ui)
    if not ui or not ui.document or not ui.document.file then return nil end
    local file = ui.document.file
    -- Cache:pathFor("") is ".../ozzbooks_cache/.epub" — strip the
    -- trailing ".epub" to get the real directory-plus-slash prefix every
    -- file this plugin opens starts with.
    local prefix = Cache:pathFor(""):gsub("%.epub$", "")
    if file:sub(1, #prefix) ~= prefix then return nil end
    return file:sub(#prefix + 1, -(#".epub") - 1)
end

-- Persisted so an unsent position survives a crash/reboot, not just an
-- in-memory retry — same "durability shouldn't depend on a timer or a
-- lifecycle event firing correctly" reasoning as the PWA EbookReader's
-- own immediate local write (see its 'relocated' handler comment),
-- adapted for a device with no equivalent local progress store.
local function savePending(book_id, position, updated_at)
    local pending = Settings:get("pending_sync") or {}
    pending[book_id] = { position = position, updatedAt = updated_at }
    Settings:set("pending_sync", pending)
end

local function clearPending(book_id)
    local pending = Settings:get("pending_sync") or {}
    pending[book_id] = nil
    Settings:set("pending_sync", pending)
end

-- One attempt at pushing a single book's position. Returns true on a
-- confirmed server write (200) or a definitive server-side rejection
-- that retrying won't fix (anything else is left pending for a later
-- attempt — the local pending_sync entry is only cleared on success).
local function pushOne(book_id, position, updated_at)
    if not Settings:isConfigured() then return false end
    local url = Settings:get("cloud_url") .. "/sync/progress/" .. book_id
    local ok, status = ApiClient.request("PUT", url, cloudHeaders(), {
        position = position,
        chapterId = "",
        updatedAt = updated_at,
    })
    if ok and status == 200 then
        clearPending(book_id)
        return true
    end
    if status == 409 then
        -- A newer write already won server-side (e.g. synced from
        -- another device meanwhile) — this one is correctly superseded,
        -- not a failure to retry.
        clearPending(book_id)
        return true
    end
    logger.warn("OzzBooks: progress push failed, left pending", book_id, status)
    return false
end

-- Retries every still-pending position, e.g. after connectivity returns.
-- Safe to call opportunistically/often — a no-op when pending_sync is
-- empty.
function OzzBooksSync:flushPending()
    local pending = Settings:get("pending_sync") or {}
    for book_id, entry in pairs(pending) do
        pushOne(book_id, entry.position, entry.updatedAt)
    end
end

-- Public wrapper — main.lua's "Bookmark this page" menu action needs the
-- current book_id too, without duplicating the cache-path parsing above.
function OzzBooksSync:getCurrentBookId(ui)
    return getCurrentBookId(ui)
end

-- Step 7 of the original plan, kept deliberately minimal: a manual
-- "bookmark the page I'm on right now" action, not two-way sync with
-- KOReader's own native bookmark list (that would need hooking
-- KOReader's bookmark-add event directly, whose exact name/signature
-- this scaffold hasn't verified — a reasonable v2, not v1). Reuses the
-- same cloud bookmarks endpoint OzzBooks' PWA Book Detail already calls.
function OzzBooksSync:pushBookmark(ui, label)
    local book_id = getCurrentBookId(ui)
    if not book_id or not ui.rolling then return false, "not an OzzBooks book" end
    local xpointer = ui.rolling:getLastProgress()
    if not xpointer then return false, "no current position" end
    local percent_ok, percent = pcall(function() return ui.rolling:getLastPercent() end)

    local url = Settings:get("cloud_url") .. "/sync/bookmarks"
    local ok, status = ApiClient.request("POST", url, cloudHeaders(), {
        bookId = book_id,
        position = {
            type = "koreader-xpointer",
            value = xpointer,
            percent = (percent_ok and type(percent) == "number") and percent or nil,
        },
        label = label,
    })
    return ok and status == 201, status
end

-- Called immediately, outside the debounce window — the current
-- position is captured and persisted to pending_sync right away
-- (cheap, local), only the network push itself is debounced/async.
function OzzBooksSync:schedulePush(ui)
    local book_id = getCurrentBookId(ui)
    if not book_id then return end
    if not ui.rolling then return end -- paged (non-reflow) doc; never true for an EPUB, but a safe guard

    local xpointer = ui.rolling:getLastProgress()
    if not xpointer then return end

    -- percent (0-1, same scale OzzBooks' own epub.js-based reader
    -- computes) is the cross-device approximate-sync hint — this app's
    -- own xpointer only resumes within KOReader itself, but the PWA can
    -- use percent to land roughly in the right place instead of always
    -- starting over. pcall-guarded since getLastPercent's "scroll mode"
    -- branch is explicitly marked @fixme/not fully accurate upstream —
    -- a percent that's merely imprecise is fine (that's the nature of
    -- this hint), but this must never let a percent-computation hiccup
    -- break the actual position push itself.
    local percent_ok, percent = pcall(function() return ui.rolling:getLastPercent() end)
    local position = {
        type = "koreader-xpointer",
        value = xpointer,
        percent = (percent_ok and type(percent) == "number") and percent or nil,
    }
    local updated_at = os.date("!%Y-%m-%dT%H:%M:%SZ")
    savePending(book_id, position, updated_at)

    if self.pending_push then
        UIManager:unschedule(self.pending_push)
    end
    self.pending_push = function()
        self.pending_push = nil
        if NetworkMgr:isConnected() then
            pushOne(book_id, position, updated_at)
        end
        -- Whether or not *this* push succeeded, sweep anything else
        -- that's been waiting (a previous book's failed push, etc.).
        self:flushPending()
    end
    UIManager:scheduleIn(DEBOUNCE_SECONDS, self.pending_push)
end

-- Called from OzzBooksLibrary:openBook, before the document actually
-- opens, only the first time a given book is opened on this device (see
-- that call site's own comment on why: trusting KOReader's own native
-- resume on every subsequent open, rather than risking a stale cloud
-- snapshot regressing an already-ongoing Kindle reading session).
-- Fetches this book's latest cloud progress and stashes its percent (if
-- any) for consumeRestoreForCurrentDocument to apply once the document
-- is actually ready.
function OzzBooksSync:prepareRestore(book_id)
    self.pending_restore = nil
    if not Settings:isConfigured() then return end
    local url = Settings:get("cloud_url") .. "/sync/progress/" .. book_id
    local ok, status, body = ApiClient.request("GET", url, cloudHeaders())
    if ok and status == 200 and body and body.position and type(body.position.percent) == "number" then
        self.pending_restore = { book_id = book_id, percent = body.position.percent }
    end
end

-- Called from main.lua's onReaderReady hook. Only acts if the document
-- that just became ready is the same one prepareRestore fetched for —
-- guards against a stale pending_restore applying to the wrong book if,
-- somehow, a different book opened in between (shouldn't normally
-- happen given the call sequence, but cheap to guard regardless).
function OzzBooksSync:consumeRestoreForCurrentDocument(ui)
    local pending = self.pending_restore
    self.pending_restore = nil
    if not pending then return end
    if getCurrentBookId(ui) ~= pending.book_id then return end

    -- GotoPercent expects 0-100, not the 0-1 fraction this plugin stores
    -- and sends everywhere else (matching the PWA's own percent scale) —
    -- see ReaderRolling:onGotoPercent in koreader core.
    ui:handleEvent(Event:new("GotoPercent", pending.percent * 100))
end

-- Bypasses the debounce — called when the document is about to go away
-- (closing the book, suspending the device) so a position captured just
-- before that moment isn't lost waiting out the debounce window.
function OzzBooksSync:flushNow(ui)
    if self.pending_push then
        UIManager:unschedule(self.pending_push)
        self.pending_push()
    end
end

return OzzBooksSync
