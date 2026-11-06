-- Spotify Remote: stores the Spotify link, catches the OAuth redirect and relays input actions to the UI app

local M = {}

local socket = require("socket.socket")
local url = require("socket.url")

local logTag = 'spotifyRemote'
local configFile = '/settings/spotifyremote_davidx3d.json'
local callbackHost = '127.0.0.1'
local callbackPort = 8899
local callbackTimeout = 300 -- seconds until the login window gives up
local redirectUri = 'http://' .. callbackHost .. ':' .. callbackPort .. '/callback'

local config = {
  clientId = '',
  refreshToken = '',
  visible = true,
  minimized = false,
}

local radioDefaults = {
  enabled = true,         -- play Spotify through the car
  volume = 0.8,            -- up to 2: above 1 the helper boosts the audio itself
  outsideVolume = 0.35,   -- relative volume when the camera is outside the car
  pauseWhenOff = true,    -- pause with the ignition off or on foot
  pauseWhenPaused = true, -- pause while the game is paused
  carEq = true,           -- car speaker sound
}
config.radio = deepcopy(radioDefaults)

local helperPort = 8898 -- spotifyremote-radio helper, runs outside the game's sandbox
local proxyPort = 8897  -- the helper's HTTP proxy to Spotify (the game UI is not allowed to make web requests)
local requestTimeout = 15
local requests = {}
local server
local serverStartTime
local authUrl

local resultPage = [[<!DOCTYPE html><html><head><meta charset="utf-8"><title>Spotify Remote</title>
<style>body{background:#121212;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
div{text-align:center}h1{color:%s}</style></head><body><div><h1>%s</h1><p>%s</p></div></body></html>]]

local function saveConfig()
  jsonWriteFile(configFile, config, true)
end

local function loadConfig()
  local data = jsonReadFile(configFile)
  if type(data) == 'table' then
    local radio = type(data.radio) == 'table' and data.radio or {}
    data.radio = nil
    tableMerge(config, data)
    for k, v in pairs(radioDefaults) do
      if type(radio[k]) == type(v) then config.radio[k] = radio[k] end
    end
  end
end

local function sendState()
  guihooks.trigger('SpotifyRemoteState', {
    clientId = config.clientId,
    refreshToken = config.refreshToken,
    visible = config.visible,
    minimized = config.minimized,
    redirectUri = redirectUri,
    radio = config.radio,
    radioStatus = spotifyRemote_radio and spotifyRemote_radio.getStatus() or 'off',
  })
end

local function stopServer()
  if server then
    server:close()
    server = nil
  end
end

local function startServer()
  stopServer()
  local s, err = socket.bind(callbackHost, callbackPort)
  if not s then
    log('E', logTag, 'Unable to start login callback server on port ' .. callbackPort .. ': ' .. tostring(err))
    return false
  end
  s:settimeout(0)
  server = s
  serverStartTime = socket.gettime()
  return true
end

local function parseQuery(query)
  local res = {}
  for pair in string.gmatch(query or '', '[^&]+') do
    local k, v = pair:match('^([^=]*)=?(.*)$')
    if k then
      res[url.unescape(k)] = url.unescape((v:gsub('%+', ' ')))
    end
  end
  return res
end

local function respond(client, status, body)
  client:send('HTTP/1.1 ' .. status .. '\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ' .. #body .. '\r\nConnection: close\r\n\r\n' .. body)
end

local function handleClient(client)
  client:settimeout(0.5)
  local line = client:receive('*l')
  local target = line and line:match('^GET%s+(%S+)')
  local parsed = target and url.parse(target)

  if parsed and parsed.path == '/callback' then
    local q = parseQuery(parsed.query)
    if q.code then
      respond(client, '200 OK', string.format(resultPage, '#1ed760', 'Connected!', 'You can close this window and go back to the game.'))
    else
      respond(client, '200 OK', string.format(resultPage, '#e22134', 'Not connected', 'Spotify says: ' .. tostring(q.error or 'unknown error')))
    end
    client:close()
    -- keep listening: the callback may belong to an older login window, the UI app calls stopAuth when done
    guihooks.trigger('SpotifyRemoteAuthCode', {code = q.code, state = q.state, error = q.error})
    return
  end

  respond(client, '404 Not Found', 'Not found')
  client:close()
end

-- called from the UI app

local function requestState()
  sendState()
end

local function setClientId(clientId)
  config.clientId = tostring(clientId or ''):match('^%s*(.-)%s*$')
  config.refreshToken = ''
  saveConfig()
  sendState()
end

-- the game runs inside Steam's container where it cannot launch a browser, so the helper opens the link
local function sendToHelper(msg)
  local udp = socket.udp()
  udp:sendto(jsonEncode(msg), '127.0.0.1', helperPort)
  udp:close()
end

-- Spotify requests from the UI app: sent to the helper's proxy without blocking the game,
-- the answer goes back to the UI as SpotifyRemoteHttp {id, status, body, retryAfter} or {id, error}

local function httpRequest(req)
  if type(req) ~= 'table' or type(req.path) ~= 'string' then return end
  local function fail(err)
    guihooks.trigger('SpotifyRemoteHttp', {id = req.id, error = tostring(err)})
  end
  local tcp = socket.tcp()
  tcp:settimeout(0.2) -- local connection, returns immediately
  local ok, err = tcp:connect('127.0.0.1', proxyPort)
  if not ok then
    tcp:close()
    return fail(err)
  end
  local body = type(req.body) == 'string' and req.body or ''
  local lines = {(req.method or 'GET') .. ' ' .. req.path .. ' HTTP/1.0', 'Host: 127.0.0.1', 'Content-Length: ' .. #body}
  for k, v in pairs(type(req.headers) == 'table' and req.headers or {}) do
    table.insert(lines, tostring(k) .. ': ' .. tostring(v))
  end
  ok, err = tcp:send(table.concat(lines, '\r\n') .. '\r\n\r\n' .. body)
  if not ok then
    tcp:close()
    return fail(err)
  end
  tcp:settimeout(0)
  table.insert(requests, {id = req.id, tcp = tcp, chunks = {}, started = socket.gettime()})
end

local function finishRequest(r)
  r.tcp:close()
  local raw = table.concat(r.chunks)
  local head, body = raw:match('^(.-)\r\n\r\n(.*)$')
  local status = head and tonumber(head:match('^HTTP/%d%.%d (%d+)'))
  if not status then
    guihooks.trigger('SpotifyRemoteHttp', {id = r.id, error = 'invalid response from helper'})
    return
  end
  guihooks.trigger('SpotifyRemoteHttp', {id = r.id, status = status, body = body, retryAfter = head:match('\n[Rr]etry%-[Aa]fter:%s*(%d+)')})
end

local function updateRequests()
  for i = #requests, 1, -1 do
    local r = requests[i]
    local data, err, partial = r.tcp:receive(65536)
    local chunk = data or partial
    if chunk and #chunk > 0 then table.insert(r.chunks, chunk) end
    if err == 'closed' then
      table.remove(requests, i)
      finishRequest(r)
    elseif err and err ~= 'timeout' then
      table.remove(requests, i)
      r.tcp:close()
      guihooks.trigger('SpotifyRemoteHttp', {id = r.id, error = err})
    elseif socket.gettime() - r.started > requestTimeout then
      table.remove(requests, i)
      r.tcp:close()
      guihooks.trigger('SpotifyRemoteHttp', {id = r.id, error = 'timeout'})
    end
  end
end

local function startAuth(link)
  if not startServer() then
    guihooks.trigger('SpotifyRemoteAuthCode', {error = 'Port ' .. callbackPort .. ' is already in use'})
    return
  end
  authUrl = link
  sendToHelper({open = link})
end

local function copyAuthUrl()
  if not authUrl then return end
  setClipboard(authUrl)
  sendToHelper({copy = authUrl}) -- the game's clipboard does not reach the desktop under Wayland
end

local function setRefreshToken(token)
  config.refreshToken = token or ''
  saveConfig()
end

local function logout()
  config.refreshToken = ''
  saveConfig()
  sendState()
end

local function setMinimized(minimized)
  config.minimized = minimized == true
  saveConfig()
  sendState()
end

local function setRadioSetting(key, value)
  if radioDefaults[key] == nil or type(value) ~= type(radioDefaults[key]) then return end
  if type(value) == 'number' then value = clamp(value, 0, key == 'volume' and 2 or 1) end
  config.radio[key] = value
  saveConfig()
  sendState()
end

local function getRadioSettings()
  return config.radio
end

-- called from input actions

local function toggleVisible()
  config.visible = not config.visible
  saveConfig()
  sendState()
end

local function command(name)
  guihooks.trigger('SpotifyRemoteCommand', name)
end

-- extension hooks

local function onUpdate()
  if requests[1] then updateRequests() end
  if not server then return end
  local client = server:accept()
  if client then
    handleClient(client)
  elseif socket.gettime() - serverStartTime > callbackTimeout then
    log('W', logTag, 'Spotify login timed out')
    stopServer()
  end
end

-- the UI app closes its big home view when a menu opens
local function onUiChangedState(toState)
  guihooks.trigger('SpotifyRemoteUiState', toState)
end

local function onExtensionLoaded()
  loadConfig()
end

local function onExtensionUnloaded()
  stopServer()
  for _, r in ipairs(requests) do r.tcp:close() end
  requests = {}
end

M.requestState = requestState
M.setClientId = setClientId
M.startAuth = startAuth
M.stopAuth = stopServer
M.copyAuthUrl = copyAuthUrl
M.httpRequest = httpRequest
M.setRefreshToken = setRefreshToken
M.logout = logout
M.setMinimized = setMinimized
M.setRadioSetting = setRadioSetting
M.getRadioSettings = getRadioSettings
M.sendState = sendState
M.toggleVisible = toggleVisible
M.command = command

M.onUpdate = onUpdate
M.onUiChangedState = onUiChangedState
M.onExtensionLoaded = onExtensionLoaded
M.onExtensionUnloaded = onExtensionUnloaded

return M
