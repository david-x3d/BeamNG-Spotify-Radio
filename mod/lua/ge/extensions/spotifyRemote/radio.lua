-- Car radio: plays live Spotify audio segments (written by the spotifyremote-radio helper) back to back
-- through the game's sound engine, positioned in the cabin or at the car depending on the camera

local M = {}

local socket = require("socket.socket")

local logTag = 'spotifyRemoteRadio'
local segmentDir = '/temp/spotifyremote/'
local segmentLength = 0.5 -- seconds, must match the helper
-- both follow the game's master and music sliders
local profileInside = 'AudioMusic2D'  -- cabin: full stereo around the driver
local profileOutside = 'AudioMusic3D' -- outside: positioned at the car
local helperPort = 8898
local heartbeatInterval = 0.25
local volumeSmoothing = 6 -- 1/s
local receiveTimeout = 3 -- seconds without a new segment until the radio counts as silent
local fallbackSettings = {enabled = true, volume = 0.8, outsideVolume = 0.35, pauseWhenOff = true, pauseWhenPaused = true, carEq = true}

local udp
local heartbeatTimer = 0
local nextIndex      -- index of the next segment to start
local nextStartTime  -- wall clock time the next segment has to start
local sources = {}   -- playing sources: {id, endTime}
local volume = 0
local ignitionVehId
local lastSegmentTime = 0
local status = 'off' -- off | idle | waiting | receiving

local function segmentPath(i)
  return segmentDir .. 'seg_' .. i .. '.wav'
end

local function latestSegment()
  local latest
  for _, f in ipairs(FS:findFiles(segmentDir, 'seg_*.wav', 0, false, false) or {}) do
    local i = tonumber(f:match('seg_(%d+)%.wav$'))
    if i and (not latest or i > latest) then latest = i end
  end
  return latest
end

local function stopPlayback()
  for _, s in ipairs(sources) do
    local src = scenetree.findObjectById(s.id)
    if src then src:delete() end
  end
  sources = {}
  nextIndex = nil
end

local function setStatus(newStatus)
  if newStatus == status then return end
  status = newStatus
  if spotifyRemote_main then spotifyRemote_main.sendState() end
end

-- by default the radio plays while sitting in a vehicle with the ignition on and the game running
local function shouldPlay(veh, settings)
  if not veh then return false end
  if settings.pauseWhenPaused and simTimeAuthority.getPause() then return false end
  if not settings.pauseWhenOff then return true end
  if gameplay_walk and gameplay_walk.isWalking() then return false end
  local vehId = veh:getId()
  if ignitionVehId ~= vehId then
    core_vehicleBridge.registerValueChangeNotification(veh, 'ignitionLevel')
    ignitionVehId = vehId
  end
  local ignition = core_vehicleBridge.getCachedVehicleData(vehId, 'ignitionLevel')
  return ignition == nil or ignition >= 1
end

local function sendHeartbeat(on, play, eq, gain)
  if not udp then
    udp = socket.udp()
    udp:settimeout(0)
  end
  -- dir: where the helper writes the segments (the user folder differs per OS and install)
  udp:sendto(jsonEncode({on = on, play = play, eq = eq, gain = gain, dir = FS:getUserPath() .. 'temp/spotifyremote'}), '127.0.0.1', helperPort)
end

local function startSegment(i, late, inside, transform)
  local id = Engine.Audio.createSource(inside and profileInside or profileOutside, segmentPath(i))
  local src = id and id ~= 0 and scenetree.findObjectById(id)
  if not src then
    log('E', logTag, 'Unable to play segment ' .. i)
    return
  end
  src:setTransform(transform)
  src:setVolume(volume)
  src:play(-1)
  -- frames only hit the schedule roughly: skip the part we are late so the crossfade stays sample-aligned
  if late > 0 then src:setPosition(late) end
  lastSegmentTime = socket.gettime()
  table.insert(sources, {id = id, endTime = lastSegmentTime + segmentLength + 1})
end

local function onUpdate(dtReal)
  local now = socket.gettime()
  local settings = spotifyRemote_main and spotifyRemote_main.getRadioSettings() or fallbackSettings
  local veh = getPlayerVehicle(0)
  local play = settings.enabled and shouldPlay(veh, settings)

  heartbeatTimer = heartbeatTimer - dtReal
  if heartbeatTimer <= 0 then
    heartbeatTimer = heartbeatInterval
    -- game sounds cannot go louder than 1, so the helper boosts the audio for volumes above 100%
    sendHeartbeat(settings.enabled, play, settings.carEq, math.max(1, settings.volume))
  end

  if not play then
    if nextIndex or sources[1] then stopPlayback() end
    setStatus(settings.enabled and 'idle' or 'off')
    return
  end
  setStatus(now - lastSegmentTime < receiveTimeout and 'receiving' or 'waiting')

  -- inside: the sound fills the cabin, outside: it comes muffled from the car
  local inside = core_camera.isCameraInside(0, core_camera.getPosition()) == 1
  local transform = inside and getCameraTransform() or veh:getTransform()
  local targetVolume = settings.volume / math.max(1, settings.volume) * (inside and 1 or settings.outsideVolume)
  volume = volume + (targetVolume - volume) * math.min(1, dtReal * volumeSmoothing)

  for i = #sources, 1, -1 do
    local src = scenetree.findObjectById(sources[i].id)
    if not src or now > sources[i].endTime then
      if src then src:delete() end
      table.remove(sources, i)
    else
      if not inside then src:setTransform(transform) end
      src:setVolume(volume)
    end
  end

  if not nextIndex then
    local latest = latestSegment()
    if not latest or latest < 1 then return end
    nextIndex = latest - 1 -- one segment of safety margin
    nextStartTime = now
  end

  if now >= nextStartTime then
    if not FS:fileExists(segmentPath(nextIndex)) then
      nextIndex = nil -- helper restarted or fell behind: resync to the live position
      return
    end
    startSegment(nextIndex, now - nextStartTime, inside, transform)
    nextIndex = nextIndex + 1
    nextStartTime = nextStartTime + segmentLength
  end
end

local function onExtensionUnloaded()
  stopPlayback()
  if udp then
    sendHeartbeat(false, false, false, 1)
    udp:close()
    udp = nil
  end
  if ignitionVehId then
    local veh = scenetree.findObjectById(ignitionVehId)
    if veh then core_vehicleBridge.unregisterValueChangeNotification(veh, 'ignitionLevel') end
  end
end

local function getStatus()
  return status
end

M.onUpdate = onUpdate
M.getStatus = getStatus
M.onExtensionUnloaded = onExtensionUnloaded

return M
