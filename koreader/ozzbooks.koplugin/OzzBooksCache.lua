--[[--
Local EPUB cache. Deliberately keep-forever, no automatic LRU eviction —
unlike OzzBooks' own audio storage-budget design (chapter blobs can be
large and a book has many), a whole library's worth of EPUBs is still
small relative to a Kindle's storage, so a manual "clear cache" menu
action is enough for v1. Revisit with real eviction only if that turns
out to be wrong in practice.
--]]--

local DataStorage = require("datastorage")
local lfs = require("libs/libkoreader-lfs")

local OzzBooksCache = {}

local CACHE_DIR = DataStorage:getDataDir() .. "/ozzbooks_cache"

function OzzBooksCache:ensureDir()
    if lfs.attributes(CACHE_DIR, "mode") ~= "directory" then
        lfs.mkdir(CACHE_DIR)
    end
end

function OzzBooksCache:pathFor(book_id)
    -- book_id is a UUID from OzzBooks, already filesystem-safe as-is.
    return CACHE_DIR .. "/" .. book_id .. ".epub"
end

function OzzBooksCache:isCached(book_id)
    return lfs.attributes(self:pathFor(book_id), "mode") == "file"
end

function OzzBooksCache:clear()
    if lfs.attributes(CACHE_DIR, "mode") ~= "directory" then return end
    for name in lfs.dir(CACHE_DIR) do
        if name ~= "." and name ~= ".." then
            os.remove(CACHE_DIR .. "/" .. name)
        end
    end
end

return OzzBooksCache
