--[[--
Library browsing: fetches the book list from OzzBooks' LOCAL
file-serving API (GET /api/books — the same endpoint the PWA's
Library/Store pages use), filters to ebook rows, and shows them in a
selectable Menu. Picking one downloads (if not already cached) and
opens it.

Filtered to format == 'epub' specifically, not "any book with a
companion ebook" — every ebook already has its own row with its own
title/author/series (see server/src/api/routes/books.ts), so there's no
need to also list audiobook-primary rows just because they happen to
have a linked ebook; that would just double-list the same work under a
different row id. This plugin never touches audio or comics at all, per
the stated goal — OzzBooks' own book list intermingles every format
in one response, so the filter below is doing real, necessary work, not
just being cautious.

VERIFY ON-DEVICE: the exact Menu widget constructor fields below
(title/item_table/onMenuSelect/close_callback) follow the common pattern
across KOReader's own bundled plugins, but Menu's API has shifted across
KOReader releases before — test this against your installed version
before relying on it.
--]]--

local Menu = require("ui/widget/menu")
local UIManager = require("ui/uimanager")
local InfoMessage = require("ui/widget/infomessage")
local ReaderUI = require("apps/reader/readerui")
local _ = require("gettext")

local ApiClient = require("ozzbooks.koplugin/OzzBooksApiClient")
local Settings = require("ozzbooks.koplugin/OzzBooksSettings")
local Cache = require("ozzbooks.koplugin/OzzBooksCache")

local OzzBooksLibrary = {}

local function localHeaders()
    return { Authorization = "Bearer " .. Settings:get("local_token") }
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

function OzzBooksLibrary:fetchBooks(on_done)
    local url = Settings:get("local_url") .. "/api/books?status=active"
    local ok, status, body = ApiClient.request("GET", url, localHeaders())
    if not ok or status ~= 200 or not body then
        on_done(false, "Couldn't reach OzzBooks at " .. Settings:get("local_url") .. " (status " .. tostring(status) .. ")")
        return
    end

    local epub_books = {}
    for _, book in ipairs(body) do
        if book.format == "epub" then
            table.insert(epub_books, book)
        end
    end
    on_done(true, epub_books)
end

function OzzBooksLibrary:openBook(book, on_error)
    local dest = Cache:pathFor(book.id)
    Cache:ensureDir()

    local function openCachedFile()
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
