--[[--
OzzBooks plugin entrypoint. Registered in both contexts KOReader
instantiates a WidgetContainer-based plugin in — FileManager (library
browsing lives here, since no document needs to be open) and ReaderUI
(the page-update/close/suspend hooks that drive progress sync live
here) — same pattern koreader core's own plugins/kosync.koplugin uses.
is_doc_only = false is what makes FileManager instantiate it too, not
just ReaderUI.

VERIFY ON-DEVICE: MultiInputDialog's exact field list is the one other
piece here (besides OzzBooksLibrary's Menu) most likely to need a small
adjustment for your exact KOReader version — everything else (menu
registration, onPageUpdate/onCloseDocument/onSuspend hooks, the HTTP
client) follows patterns taken directly from koreader core source.
--]]--

local WidgetContainer = require("ui/widget/container/widgetcontainer")
local UIManager = require("ui/uimanager")
local InfoMessage = require("ui/widget/infomessage")
local MultiInputDialog = require("ui/widget/multiinputdialog")
local _ = require("gettext")

local ApiClient = require("OzzBooksApiClient")
local Settings = require("OzzBooksSettings")
local Library = require("OzzBooksLibrary")
local Sync = require("OzzBooksSync")

local OzzBooks = WidgetContainer:extend{
    name = "ozzbooks",
    is_doc_only = false,
}

function OzzBooks:init()
    self.ui.menu:registerToMainMenu(self)
end

function OzzBooks:addToMainMenu(menu_items)
    menu_items.ozzbooks = {
        text = _("OzzBooks"),
        sorting_hint = "main",
        sub_item_table = {
            {
                text = _("Browse library"),
                callback = function() Library:show() end,
            },
            {
                text = _("Sync now"),
                callback = function()
                    Sync:flushPending()
                    UIManager:show(InfoMessage:new{ text = _("Synced."), timeout = 1 })
                end,
            },
            {
                text = _("Bookmark this page"),
                -- Only meaningful inside an open OzzBooks book — enable_hint
                -- decides whether this entry is tappable, not just whether
                -- it's visible, so greying it out elsewhere (not inside a
                -- book at all) is clearer than a callback that silently
                -- does nothing.
                enabled_func = function()
                    return self.ui and self.ui.document and Sync:getCurrentBookId(self.ui) ~= nil
                end,
                callback = function()
                    local ok, status = Sync:pushBookmark(self.ui, nil)
                    UIManager:show(InfoMessage:new{
                        text = ok and _("Bookmarked.") or (_("Bookmark failed (status ") .. tostring(status) .. ")"),
                        timeout = 2,
                    })
                end,
            },
            {
                text = _("Log in to OzzBooks"),
                callback = function() self:showLoginDialog() end,
            },
            {
                text = _("Server settings"),
                callback = function() self:showServerSettingsDialog() end,
            },
        },
    }
end

function OzzBooks:showServerSettingsDialog()
    local dialog
    dialog = MultiInputDialog:new{
        title = _("OzzBooks server settings"),
        fields = {
            {
                text = Settings:get("local_url"),
                hint = _("Local server URL (e.g. your Tailscale hostname)"),
            },
            {
                text = Settings:get("local_token"),
                hint = _("Local API token"),
                text_type = "password",
            },
            {
                text = Settings:get("cloud_url"),
                hint = _("Cloud server URL"),
            },
        },
        buttons = {{
            {
                text = _("Cancel"),
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Save"),
                callback = function()
                    local fields = dialog:getFields()
                    Settings:set("local_url", fields[1]:gsub("/+$", "")) -- no trailing slash
                    Settings:set("local_token", fields[2])
                    Settings:set("cloud_url", fields[3]:gsub("/+$", ""))
                    UIManager:close(dialog)
                    UIManager:show(InfoMessage:new{ text = _("Saved."), timeout = 1 })
                end,
            },
        }},
    }
    UIManager:show(dialog)
end

function OzzBooks:showLoginDialog()
    local dialog
    dialog = MultiInputDialog:new{
        title = _("Log in to OzzBooks"),
        fields = {
            { text = Settings:get("cloud_email"), hint = _("Email") },
            { text = "", hint = _("Password"), text_type = "password" },
        },
        buttons = {{
            {
                text = _("Cancel"),
                callback = function() UIManager:close(dialog) end,
            },
            {
                text = _("Log in"),
                callback = function()
                    local fields = dialog:getFields()
                    local email, password = fields[1], fields[2]
                    UIManager:close(dialog)
                    self:doLogin(email, password)
                end,
            },
        }},
    }
    UIManager:show(dialog)
end

function OzzBooks:doLogin(email, password)
    local url = Settings:get("cloud_url") .. "/auth/login"
    local ok, status, body = ApiClient.request("POST", url, {}, { email = email, password = password })
    if ok and status == 200 and body and body.token then
        Settings:set("cloud_token", body.token)
        Settings:set("cloud_email", email)
        UIManager:show(InfoMessage:new{ text = _("Logged in.") })
    else
        UIManager:show(InfoMessage:new{
            text = _("Login failed (status ") .. tostring(status) .. _("). Check your email/password and cloud server URL."),
        })
    end
end

-- ReaderUI-only hooks below — each is a no-op when the open document
-- isn't one this plugin handed out (see OzzBooksSync's getCurrentBookId).

-- Fires once the document has finished opening — koreader core's own
-- kosync.koplugin uses this exact hook for the same purpose (applying a
-- synced position once the reader is actually ready for it). Deferred a
-- tick, same as kosync, rather than acted on immediately inline.
function OzzBooks:onReaderReady()
    if not self.ui or not self.ui.document then return end
    UIManager:nextTick(function()
        Sync:consumeRestoreForCurrentDocument(self.ui)
    end)
end

function OzzBooks:onPageUpdate(page)
    if not self.ui or not self.ui.document then return end
    Sync:schedulePush(self.ui)
end

function OzzBooks:onCloseDocument()
    if not self.ui or not self.ui.document then return end
    Sync:flushNow(self.ui)
end

function OzzBooks:onSuspend()
    if not self.ui or not self.ui.document then return end
    Sync:flushNow(self.ui)
end

return OzzBooks
