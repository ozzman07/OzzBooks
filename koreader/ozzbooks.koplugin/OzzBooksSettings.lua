--[[--
Persisted plugin configuration: the two OzzBooks server URLs, the shared
local-server API token, and the cloud JWT obtained from a one-time login.

Two separate backends, two separate credentials — this mirrors OzzBooks'
own architecture (see the project's Claude.md "Auth & security" section),
not an accident of this plugin's design:
  - the LOCAL file-serving API (Mac mini, reached over Tailscale) uses one
    shared static bearer token, the same for every device/user
  - the CLOUD sync API (Render + Postgres) has real per-user accounts —
    login once with email/password, store the resulting long-lived (90
    day) JWT, never store the password itself
--]]--

local DataStorage = require("datastorage")
local LuaSettings = require("luasettings")

local SETTINGS_FILE = DataStorage:getSettingsDir() .. "/ozzbooks.lua"

local OzzBooksSettings = {
    store = LuaSettings:open(SETTINGS_FILE),
}

local DEFAULTS = {
    local_url = "", -- e.g. "https://jims-mac-mini.tail8b131b.ts.net"
    local_token = "",
    cloud_url = "https://ozzbooks.onrender.com",
    cloud_token = "",
    cloud_email = "", -- remembered only so the login dialog can pre-fill it
}

function OzzBooksSettings:get(key)
    return self.store:readSetting(key) or DEFAULTS[key]
end

function OzzBooksSettings:set(key, value)
    self.store:saveSetting(key, value)
    self.store:flush()
end

-- True once both servers are configured and a cloud login has actually
-- happened — gates the library/sync menu entries so they fail fast with
-- a clear "set up OzzBooks first" message instead of a confusing network
-- error from an empty URL.
function OzzBooksSettings:isConfigured()
    return self:get("local_url") ~= "" and self:get("local_token") ~= "" and self:get("cloud_token") ~= ""
end

return OzzBooksSettings
