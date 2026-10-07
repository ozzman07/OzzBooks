--[[--
Thin HTTP client for both OzzBooks backends (local file-serving API over
Tailscale, cloud sync API on Render). Deliberately plain LuaSocket +
socketutil + ltn12, the same primitives koreader core's own plugins
(e.g. plugins/kosync.koplugin) are built on — no need for KOReader's
heavier Spore/API-spec framework (that exists to describe a *generic*
REST API from a JSON spec file; this client only ever talks to one API
we fully control, so a spec layer buys nothing here).

NOTE: verify require("json") resolves to a real JSON module on your
KOReader build before relying on this — it's bundled on real device
builds but has been flaky in some emulator setups.
--]]--

local http = require("socket.http")
local ltn12 = require("ltn12")
local socketutil = require("socketutil")
local json = require("json")
local logger = require("logger")

local OzzBooksApiClient = {}

-- Generous but bounded — the Mac mini is reached over Tailscale, which
-- can have real latency spikes (sleep/wake, Wi-Fi roaming) worse than a
-- LAN; a hung request must still eventually give up rather than freeze
-- the UI. request() (short JSON calls) and download() (a whole EPUB,
-- which can be tens of MB) intentionally use different budgets.
local REQUEST_TIMEOUT = { block = 5, total = 15 }
local DOWNLOAD_TIMEOT = { block = 10, total = 120 }

-- method: "GET" | "POST" | "PUT" | "DELETE"
-- headers: plain table of header-name -> value (Authorization already included by callers)
-- body: a Lua table to JSON-encode, or nil for no body
-- Returns: ok (boolean), status_or_error (number on success, string on failure), decoded_body (table, or nil)
function OzzBooksApiClient.request(method, url, headers, body)
    local body_json = body and json.encode(body) or nil
    local request_headers = headers or {}
    if body_json then
        request_headers["Content-Type"] = "application/json"
        request_headers["Content-Length"] = tostring(#body_json)
    end

    local response_chunks = {}
    socketutil:set_timeout(REQUEST_TIMEOUT.block, REQUEST_TIMEOUT.total)
    -- Real bug found live: LuaSocket's http.request (generic/table form)
    -- returns (ok, code, headers, status_line) — ok is the literal number
    -- 1 on a successful connection, nil on a genuine connection failure
    -- (DNS, refused, timeout), with the real HTTP status code as the
    -- SECOND return value, not the first. pcall forwards every return
    -- value of the wrapped function, so capturing only one of them here
    -- (the old `local ok, status_or_err = pcall(...)`) silently threw
    -- away the actual status and kept the useless "1" instead — every
    -- request, success or failure alike, read back as status 1.
    local pcall_ok, conn_ok, code_or_err = pcall(function()
        return http.request({
            url = url,
            method = method,
            headers = request_headers,
            source = body_json and ltn12.source.string(body_json) or nil,
            sink = ltn12.sink.table(response_chunks),
        })
    end)
    socketutil:reset_timeout()

    if not pcall_ok then
        logger.warn("OzzBooks: request errored", url, conn_ok)
        return false, tostring(conn_ok), nil
    end
    if not conn_ok then
        -- A genuine connection-level failure — code_or_err is LuaSocket's
        -- error string here (e.g. "connection refused"), not a status.
        logger.warn("OzzBooks: connection failed", url, code_or_err)
        return false, tostring(code_or_err), nil
    end

    local response_body = table.concat(response_chunks)
    -- code_or_err is the real HTTP status code now that conn_ok confirmed
    -- the connection itself succeeded. A 4xx/5xx is still a "successful
    -- request, unsuccessful outcome" — callers decide what counts as ok
    -- based on the status, not this function.
    local status = code_or_err
    local decoded = nil
    if #response_body > 0 then
        local decode_ok, result = pcall(json.decode, response_body)
        if decode_ok then decoded = result end
    end

    return type(status) == "number" and status < 500, status, decoded
end

-- Streams the response body straight to a file instead of buffering it
-- in memory — an EPUB can be tens of MB, and this runs on an e-ink
-- Kindle with limited RAM.
function OzzBooksApiClient.download(url, headers, dest_path)
    local file, open_err = io.open(dest_path .. ".part", "wb")
    if not file then
        return false, "could not open destination file: " .. tostring(open_err)
    end

    socketutil:set_timeout(DOWNLOAD_TIMEOT.block, DOWNLOAD_TIMEOT.total)
    -- Same fix as request() above — capture conn_ok/code_or_err
    -- separately rather than losing the real status behind LuaSocket's
    -- literal-1 success sentinel.
    local pcall_ok, conn_ok, code_or_err = pcall(function()
        return http.request({
            url = url,
            method = "GET",
            headers = headers,
            sink = ltn12.sink.file(file),
        })
    end)
    socketutil:reset_timeout()

    if not pcall_ok or not conn_ok or code_or_err ~= 200 then
        os.remove(dest_path .. ".part")
        return false, tostring(pcall_ok and code_or_err or conn_ok)
    end

    -- Rename only on full success — a partial/aborted download never
    -- shows up as a usable cached file under the real name.
    os.rename(dest_path .. ".part", dest_path)
    return true
end

return OzzBooksApiClient
