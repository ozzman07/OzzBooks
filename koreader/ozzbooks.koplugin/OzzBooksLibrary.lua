--[[--
Library browsing: fetches the signed-in user's own "My Books" shelf
(not the whole shared catalog — see fetchBooks' own comment), shows
them in a selectable Menu, and downloads (if not already cached) +
opens whichever one is picked.

NOT YET CONFIRMED ON-DEVICE: the Menu widget itself (title/item_table/
onMenuSelect/close_callback) has never actually rendered successfully
yet — every attempt so far crashed before reaching it, for two
different real reasons, both instructive for anything added later:
OzzBooksApiClient originally misread LuaSocket's http.request return
shape (see its own comment), and the very first version of this file
fetched the *entire* shared catalog (13.8 MB / 8,023 rows on a real
library) and filtered client-side, which crashed KOReader outright on
this hardware's limited RAM. Always prefer a narrow, server-side-
filtered fetch over "fetch everything, filter here." Update this note
once Menu is confirmed actually working.
--]]--

local Menu = require("ui/widget/menu")
local UIManager = require("ui/uimanager")
local InfoMessage = require("ui/widget/infomessage")
local ReaderUI = require("apps/reader/readerui")
local _ = require("gettext")

local ApiClient = require("OzzBooksApiClient")
local Settings = require("OzzBooksSettings")
local Cache = require("OzzBooksCache")
local Sync = require("OzzBooksSync")

local OzzBooksLibrary = {}

local function localHeaders()
    return { Authorization = "Bearer " .. Settings:get("local_token") }
end

local function cloudHeaders()
    return { Authorization = "Bearer " .. Settings:get("cloud_token") }
end

local function formatItemText(book)
    local parts = { book.title }
    if book.author and book.author ~= "" then
        table.insert(parts, "— " .. book.author)
    end
    if book.series_name and book.series_name ~= "" then
        local series = book.series_name
        if book.series_number then series = series .. " #" .. tostring(book.series_number) end
        table.insert(parts, "(" .. series .. ")")
    end
    return table.concat(parts, " ")
end

-- Two-step, not one: the LOCAL server (shared catalog, no per-user auth —
-- see companionSync.ts-style notes in Claude.md) has no idea which books
-- are "mine"; that membership lives entirely in the CLOUD's library_items
-- table. So this fetches the user's own library membership from the
-- cloud first (small — just ids), then asks the local server for
-- epub-summary rows for just those ids, rather than fetching the whole
-- shared catalog and filtering client-side (the same class of mistake
-- that crashed KOReader in the first place — see epub-summary's own
-- comment in server/src/api/routes/books.ts).
function OzzBooksLibrary:fetchBooks(on_done)
    local library_url = Settings:get("cloud_url") .. "/sync/library"
    local lib_ok, lib_status, lib_body = ApiClient.request("GET", library_url, cloudHeaders())
    if not lib_ok or lib_status ~= 200 or not lib_body then
        on_done(false, "Couldn't reach OzzBooks cloud at " .. Settings:get("cloud_url") .. " (status " .. tostring(lib_status) .. ")")
        return
    end

    local ids = {}
    for _, item in ipairs(lib_body) do
        table.insert(ids, item.book_id)
    end
    if #ids == 0 then
        on_done(true, {})
        return
    end

    local url = Settings:get("local_url") .. "/api/books/epub-summary?ids=" .. table.concat(ids, ",")
    local ok, status, body = ApiClient.request("GET", url, localHeaders())
    if not ok or status ~= 200 or not body then
        on_done(false, "Couldn't reach OzzBooks at " .. Settings:get("local_url") .. " (status " .. tostring(status) .. ")")
        return
    end
    on_done(true, body)
end

function OzzBooksLibrary:openBook(book, on_error)
    local dest = Cache:pathFor(book.id)
    Cache:ensureDir()
    -- Captured before any download happens below — this is specifically
    -- "has this device ever had this book before", not "is it cached
    -- right now" (which would always be true by the time openCachedFile
    -- runs). Only on a genuine first-open do we ask the cloud for a
    -- percent to restore; every later open trusts KOReader's own native
    -- resume instead, so a stale cloud snapshot can never regress an
    -- already-ongoing Kindle reading session. See OzzBooksSync's
    -- prepareRestore/consumeRestoreForCurrentDocument for the other half
    -- of this.
    local is_first_open_on_this_device = not Cache:isCached(book.id)

    local function openCachedFile()
        if is_first_open_on_this_device then
            Sync:prepareRestore(book.id)
        end
        UIManager:scheduleIn(0.1, function()
            -- ReaderUI:showReader replaces the currently-focused UI (the
            -- library Menu, in this case) with the reader — same call
            -- the FileManager itself makes when you tap a file.
            ReaderUI:showReader(dest)
        end)
    end

    if Cache:isCached(book.id) then
        openCachedFile()
        return
    end

    UIManager:show(InfoMessage:new{ text = _("Downloading ") .. book.title .. "…", timeout = 2 })
    local url = Settings:get("local_url") .. "/api/books/" .. book.id .. "/epub"
    local ok, err = ApiClient.download(url, localHeaders(), dest)
    if not ok then
        on_error("Download failed: " .. tostring(err))
        return
    end
    openCachedFile()
end

-- Builds and shows the library Menu. `on_close` lets main.lua know when
-- the user backs out, so it can tear down any state it needs to.
function OzzBooksLibrary:show(on_close)
    if not Settings:isConfigured() then
        UIManager:show(InfoMessage:new{
            text = _("Set up OzzBooks first: OzzBooks menu → Settings."),
        })
        return
    end

    UIManager:show(InfoMessage:new{ text = _("Loading your library…"), timeout = 1 })

    self:fetchBooks(function(ok, result)
        if not ok then
            UIManager:show(InfoMessage:new{ text = result })
            return
        end

        local item_table = {}
        for _, book in ipairs(result) do
            table.insert(item_table, {
                text = formatItemText(book),
                book = book, -- stashed for onMenuSelect below
            })
        end

        local menu
        menu = Menu:new{
            title = _("OzzBooks Library"),
            item_table = item_table,
            is_borderless = true,
            is_popout = false,
            onMenuSelect = function(_self, item)
                UIManager:close(menu)
                self:openBook(item.book, function(err)
                    UIManager:show(InfoMessage:new{ text = err })
                end)
            end,
            close_callback = function()
                UIManager:close(menu)
                if on_close then on_close() end
            end,
        }
        UIManager:show(menu)
    end)
end

return OzzBooksLibrary
