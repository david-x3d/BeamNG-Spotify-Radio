(function () {
  "use strict"

  const SCOPES = "user-read-playback-state user-modify-playback-state user-read-currently-playing"
  const POLL_EVERY_S = 3

  // --- PKCE helpers (pure JS, crypto.subtle is not guaranteed in the game UI) ---

  const SHA256_K = []
  const SHA256_H = []
  ;(function initSha256Constants() {
    const frac = x => ((x - Math.floor(x)) * 0x100000000) | 0
    for (let n = 2, found = 0; found < 64; n++) {
      let isPrime = true
      for (let d = 2; d * d <= n; d++) if (n % d === 0) { isPrime = false; break }
      if (!isPrime) continue
      if (found < 8) SHA256_H.push(frac(Math.sqrt(n)))
      SHA256_K.push(frac(Math.cbrt(n)))
      found++
    }
  })()

  function sha256(text) {
    const ror = (x, n) => (x >>> n) | (x << (32 - n))
    const bytes = new TextEncoder().encode(text)
    const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6)
    padded.set(bytes)
    padded[bytes.length] = 0x80
    const view = new DataView(padded.buffer)
    view.setUint32(padded.length - 4, bytes.length * 8)
    const h = SHA256_H.slice()
    const w = new Int32Array(64)
    for (let i = 0; i < padded.length; i += 64) {
      for (let t = 0; t < 16; t++) w[t] = view.getUint32(i + t * 4)
      for (let t = 16; t < 64; t++) {
        const s0 = ror(w[t - 15], 7) ^ ror(w[t - 15], 18) ^ (w[t - 15] >>> 3)
        const s1 = ror(w[t - 2], 17) ^ ror(w[t - 2], 19) ^ (w[t - 2] >>> 10)
        w[t] = w[t - 16] + s0 + w[t - 7] + s1
      }
      let [a, b, c, d, e, f, g, k] = h
      for (let t = 0; t < 64; t++) {
        const t1 = (k + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[t] + w[t]) | 0
        const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0
        k = g; g = f; f = e; e = (d + t1) | 0
        d = c; c = b; b = a; a = (t1 + t2) | 0
      }
      ;[a, b, c, d, e, f, g, k].forEach((v, j) => { h[j] = (h[j] + v) | 0 })
    }
    const out = new Uint8Array(32)
    const outView = new DataView(out.buffer)
    h.forEach((v, j) => outView.setUint32(j * 4, v >>> 0))
    return out
  }

  function base64url(bytes) {
    let bin = ""
    bytes.forEach(b => { bin += String.fromCharCode(b) })
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
  }

  function randomString(length) {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
    const rnd = new Uint8Array(length)
    crypto.getRandomValues(rnd)
    return Array.from(rnd, b => chars[b % chars.length]).join("")
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000))
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0")
  }

  class SpotifyError extends Error {
    constructor(status, message) {
      super(message)
      this.status = status
    }
  }

  const ICON_NOTE = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>'

  const TEMPLATE = `
<div class="sprdx" ng-show="state.visible">
  <style>
    .sprdx{width:100%;height:100%;color:#fff;font-size:12px;box-sizing:border-box}
    .sprdx *{box-sizing:border-box}
    .sprdx svg{fill:currentColor}
    .sprdx-card{width:100%;height:100%;background:rgba(18,18,18,.85);border-radius:10px;padding:8px 10px 10px;display:flex;flex-direction:column;overflow:hidden}
    .sprdx-head{display:flex;align-items:center;gap:4px;font-size:10px;letter-spacing:.1em;text-transform:uppercase;opacity:.65}
    .sprdx-head svg{width:12px;height:12px;fill:#1ed760}
    .sprdx-grow{flex:1;min-width:0}
    .sprdx-icon{width:24px;height:24px;border:0;border-radius:50%;background:transparent;color:#fff;display:flex;align-items:center;justify-content:center;cursor:pointer;padding:0;flex:none}
    .sprdx-icon:hover{background:rgba(255,255,255,.14)}
    .sprdx-icon svg{width:16px;height:16px}
    .sprdx-body{flex:1;display:flex;flex-direction:column;justify-content:center;gap:6px;min-height:0}
    .sprdx-main{display:flex;gap:10px;align-items:center}
    .sprdx-cover{width:54px;height:54px;border-radius:6px;background:#2a2a2a center/cover no-repeat;flex:none}
    .sprdx-title{font-weight:600;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sprdx-sub{opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sprdx-bar{height:3px;background:rgba(255,255,255,.2);border-radius:2px;margin-top:7px;overflow:hidden}
    .sprdx-bar div{height:100%;background:#1ed760}
    .sprdx-time{display:flex;justify-content:space-between;font-size:10px;opacity:.6;margin-top:3px}
    .sprdx-ctrl{display:flex;justify-content:center;align-items:center;gap:16px}
    .sprdx-play{width:32px;height:32px;background:#fff;color:#000}
    .sprdx-play:hover{background:#ddd}
    .sprdx-btn{border:0;border-radius:16px;background:#1ed760;color:#000;font-weight:700;padding:7px 16px;cursor:pointer;align-self:flex-start}
    .sprdx-btn:hover{background:#3be477}
    .sprdx-link{background:none;border:0;color:#fff;opacity:.6;text-decoration:underline;cursor:pointer;padding:0;font-size:11px;align-self:flex-start}
    .sprdx-input{width:100%;background:#2a2a2a;border:1px solid #444;color:#fff;border-radius:6px;padding:6px 8px;font-size:12px}
    .sprdx-hint{font-size:11px;opacity:.75;line-height:1.35}
    .sprdx-hint b{user-select:text}
    .sprdx-msg{font-size:11px;color:#ff8a95}
    .sprdx-pill{display:inline-flex;align-items:center;gap:6px;max-width:100%;background:rgba(18,18,18,.85);border-radius:14px;padding:5px 12px 5px 8px;cursor:pointer;white-space:nowrap;overflow:hidden}
    .sprdx-pill svg{width:14px;height:14px;fill:#1ed760;flex:none}
    .sprdx-pill span{overflow:hidden;text-overflow:ellipsis}
    .sprdx-pill .sprdx-chev{fill:#fff;opacity:.7}
    .sprdx-card{overflow-y:auto}
    .sprdx-vol{display:flex;align-items:center;gap:8px}
    .sprdx-vol svg{width:16px;height:16px;flex:none;opacity:.7}
    .sprdx-range{flex:1;accent-color:#1ed760;height:4px;cursor:pointer}
    .sprdx-set{display:flex;flex-direction:column;gap:7px;padding-top:4px}
    .sprdx-row{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .sprdx-row label{opacity:.85}
    .sprdx-row input[type=checkbox]{accent-color:#1ed760;width:16px;height:16px;cursor:pointer}
    .sprdx-row .sprdx-range{max-width:50%}
    .sprdx-status{font-size:11px;padding:5px 8px;border-radius:6px;background:rgba(255,255,255,.07)}
    .sprdx-status.ok{color:#1ed760}
    .sprdx-active{background:rgba(255,255,255,.14)}
  </style>

  <div class="sprdx-pill" ng-if="state.minimized" ng-click="setMinimized(false)" title="Expand">
    ${ICON_NOTE}<span class="sprdx-grow">{{ track ? track.name + ' · ' + track.artist : 'Spotify' }}</span>
    <svg class="sprdx-chev" viewBox="0 0 24 24"><path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg>
  </div>

  <div class="sprdx-card" ng-if="!state.minimized">
    <div class="sprdx-head">
      <span class="sprdx-grow"></span>
      <button class="sprdx-icon" ng-class="{'sprdx-active': view === 'settings'}" ng-click="toggleSettings()" title="Settings">
        <svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.7a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>
      </button>
      <button class="sprdx-icon" ng-click="setMinimized(true)" title="Collapse">
        <svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>
      </button>
    </div>

    <div class="sprdx-set" ng-if="view === 'settings'">
      <div class="sprdx-status" ng-class="{ok: state.radioStatus === 'receiving'}">{{ radioStatusText() }}</div>
      <div class="sprdx-row"><label>Car radio (sound through the car)</label>
        <input type="checkbox" ng-model="state.radio.enabled" ng-change="setRadio('enabled', state.radio.enabled)"></div>
      <div class="sprdx-row"><label>Volume {{ percent(state.radio.volume) }}</label>
        <input class="sprdx-range" type="range" min="0" max="2" step="0.01" ng-model="state.radio.volume" ng-change="setRadio('volume', state.radio.volume)"></div>
      <div class="sprdx-row"><label>Volume outside the car {{ percent(state.radio.outsideVolume) }}</label>
        <input class="sprdx-range" type="range" min="0" max="1" step="0.01" ng-model="state.radio.outsideVolume" ng-change="setRadio('outsideVolume', state.radio.outsideVolume)"></div>
      <div class="sprdx-row"><label>Car speaker sound (EQ)</label>
        <input type="checkbox" ng-model="state.radio.carEq" ng-change="setRadio('carEq', state.radio.carEq)"></div>
      <div class="sprdx-row"><label>Pause with ignition off / on foot</label>
        <input type="checkbox" ng-model="state.radio.pauseWhenOff" ng-change="setRadio('pauseWhenOff', state.radio.pauseWhenOff)"></div>
      <div class="sprdx-row"><label>Pause when the game is paused</label>
        <input type="checkbox" ng-model="state.radio.pauseWhenPaused" ng-change="setRadio('pauseWhenPaused', state.radio.pauseWhenPaused)"></div>
      <div class="sprdx-hint">Show/hide and play/pause can be bound to keys or wheel buttons under Options → Controls → General.</div>
      <button class="sprdx-link" ng-if="state.refreshToken" ng-click="logout()">Disconnect Spotify account</button>
      <button class="sprdx-link" ng-if="state.clientId" ng-click="resetClientId()">Change Client ID</button>
    </div>

    <div class="sprdx-body" ng-if="view !== 'settings' && !state.clientId">
      <div class="sprdx-hint">Create an app on <b>developer.spotify.com</b>, add <b>{{ state.redirectUri }}</b> as Redirect URI and paste its Client ID here:</div>
      <input class="sprdx-input" type="text" ng-model="form.clientId" placeholder="Client ID">
      <button class="sprdx-btn" ng-click="saveClientId()">Save</button>
    </div>

    <div class="sprdx-body" ng-if="view !== 'settings' && state.clientId && !state.refreshToken">
      <button class="sprdx-btn" ng-click="connect()">Connect with Spotify</button>
      <div class="sprdx-hint" ng-if="status">{{ status }}</div>
      <button class="sprdx-link" ng-if="status" ng-click="copyAuthUrl()">{{ copied ? 'Link copied, paste it into your browser' : 'Nothing opened? Copy the link' }}</button>
      <div class="sprdx-msg" ng-if="message">{{ message }}</div>
      <button class="sprdx-link" ng-click="resetClientId()">Change Client ID</button>
    </div>

    <div class="sprdx-body" ng-if="view !== 'settings' && state.clientId && state.refreshToken">
      <div class="sprdx-main">
        <div class="sprdx-cover" ng-style="track && track.image ? {'background-image': 'url(' + track.image + ')'} : {}"></div>
        <div class="sprdx-grow">
          <div class="sprdx-title">{{ track ? track.name : 'Nothing playing' }}</div>
          <div class="sprdx-sub">{{ track ? track.artist : 'Start some music in Spotify' }}</div>
          <div class="sprdx-bar"><div ng-style="{width: progressPercent() + '%'}"></div></div>
          <div class="sprdx-time"><span>{{ formatTime(progressMs()) }}</span><span>{{ formatTime(track ? track.duration : 0) }}</span></div>
        </div>
      </div>
      <div class="sprdx-ctrl">
        <button class="sprdx-icon" ng-click="previous()" title="Previous track">
          <svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>
        </button>
        <button class="sprdx-icon sprdx-play" ng-click="playPause()" title="Play/Pause">
          <svg ng-if="!(track && track.playing)" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
          <svg ng-if="track && track.playing" viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>
        </button>
        <button class="sprdx-icon" ng-click="next()" title="Next track">
          <svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>
        </button>
      </div>
      <div class="sprdx-vol" ng-if="state.radio.enabled" title="Car radio volume">
        <svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>
        <input class="sprdx-range" type="range" min="0" max="2" step="0.01" ng-model="state.radio.volume" ng-change="setRadio('volume', state.radio.volume)">
      </div>
      <div class="sprdx-msg" ng-if="message">{{ message }}</div>
    </div>
  </div>
</div>`

  angular.module("beamng.apps").directive("spotifyRemoteDavidx3d", [
    function () {
      return {
        template: TEMPLATE,
        replace: true,
        link: function (scope) {
          scope.state = { visible: true, minimized: false, clientId: "", refreshToken: "", redirectUri: "", radio: {}, radioStatus: "off" }
          scope.view = "player"
          scope.form = { clientId: "" }
          scope.track = null
          scope.status = ""
          scope.message = ""
          scope.formatTime = formatTime

          let accessToken = null
          let accessExpires = 0
          let pkce = null
          let pollIn = 0
          let polling = false
          let messageTimer = null
          let destroyed = false

          const apply = () => scope.$evalAsync()
          const lua = code => bngApi.engineLua(code)
          const isLinked = () => !!(scope.state.clientId && scope.state.refreshToken)

          function showMessage(text, sticky) {
            scope.message = text
            clearTimeout(messageTimer)
            if (text) console.warn("[SpotifyRemote] " + text)
            if (text && !sticky) messageTimer = setTimeout(() => { scope.message = ""; apply() }, 6000)
            apply()
          }

          // --- Spotify Web API ---

          // The game UI must not make web requests (BeamNG cancels them), so game Lua sends them
          // to the helper, which forwards them to Spotify. Resolves to a small fetch-like response.
          const pendingRequests = {}
          let requestId = 0
          function httpRequest(method, path, opts) {
            const id = ++requestId
            return new Promise(function (resolve, reject) {
              pendingRequests[id] = { resolve, reject }
              lua("spotifyRemote_main.httpRequest(" + bngApi.serializeToLua({
                id, method, path, headers: (opts && opts.headers) || {}, body: (opts && opts.body) || "",
              }) + ")")
            })
          }

          scope.$on("SpotifyRemoteHttp", function (event, data) {
            const pending = data && pendingRequests[data.id]
            if (!pending) return
            delete pendingRequests[data.id]
            if (data.error) {
              pending.reject(new TypeError(data.error))
              return
            }
            const text = data.body || ""
            pending.resolve({
              ok: data.status >= 200 && data.status < 300,
              status: data.status,
              headers: { get: name => (name.toLowerCase() === "retry-after" ? data.retryAfter || null : null) },
              text: async () => text,
              json: async () => JSON.parse(text),
            })
          })

          async function tokenRequest(params) {
            const res = await httpRequest("POST", "/accounts/api/token", {
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams(params).toString(),
            })
            const data = await res.json().catch(() => ({}))
            if (!res.ok) throw new SpotifyError(res.status, data.error_description || data.error || "HTTP " + res.status)
            accessToken = data.access_token
            accessExpires = Date.now() + ((data.expires_in || 3600) - 60) * 1000
            if (data.refresh_token && data.refresh_token !== scope.state.refreshToken) {
              scope.state.refreshToken = data.refresh_token
              lua("spotifyRemote_main.setRefreshToken(" + bngApi.serializeToLua(data.refresh_token) + ")")
            }
          }

          async function getAccessToken() {
            if (accessToken && Date.now() < accessExpires) return accessToken
            try {
              await tokenRequest({ grant_type: "refresh_token", refresh_token: scope.state.refreshToken, client_id: scope.state.clientId })
            } catch (err) {
              if (err.status === 400 || err.status === 401) {
                // refresh token revoked or expired: the user has to log in again
                accessToken = null
                scope.state.refreshToken = ""
                lua("spotifyRemote_main.logout()")
                showMessage("Spotify connection expired, please connect again.")
              }
              throw err
            }
            return accessToken
          }

          async function api(method, path, retried) {
            const token = await getAccessToken()
            const res = await httpRequest(method, "/api/v1" + path, {
              headers: { Authorization: "Bearer " + token },
            })
            if (res.status === 401 && !retried) {
              accessToken = null
              return api(method, path, true)
            }
            if (res.status === 429) {
              pollIn = Math.max(pollIn, parseInt(res.headers.get("Retry-After"), 10) || 10)
            }
            const text = await res.text()
            let data = null
            try { data = text ? JSON.parse(text) : null } catch (e) { data = null }
            if (!res.ok) throw new SpotifyError(res.status, (data && data.error && data.error.message) || "HTTP " + res.status)
            return data
          }

          function describeError(err) {
            if (err.status === 403) return "Controlling playback needs Spotify Premium."
            if (err.status === 404) return "No active device. Start some music in Spotify first."
            if (err.status === 429) return "Too many requests, wait a moment."
            if (err instanceof TypeError) return "No connection. Is the helper (spotifyremote-radio) running?"
            return "Spotify error: " + err.message
          }

          // covers come through the helper as base64 (the game UI may not load images from the web)
          const covers = {}
          const coverOrder = []
          function coverFor(url) {
            const match = url && url.match(/^https:\/\/i\.scdn\.co\/image\/([A-Za-z0-9]+)$/)
            if (!match) return null
            if (url in covers) return covers[url]
            covers[url] = null
            coverOrder.push(url)
            if (coverOrder.length > 20) delete covers[coverOrder.shift()]
            httpRequest("GET", "/image/" + match[1]).then(async function (res) {
              if (!res.ok || !(url in covers)) return
              covers[url] = "data:image/jpeg;base64," + (await res.text())
              if (scope.track && scope.track.imageUrl === url) {
                scope.track.image = covers[url]
                apply()
              }
            }).catch(function () { delete covers[url] })
            return null
          }

          async function refreshPlayer() {
            if (polling || !isLinked()) return
            polling = true
            try {
              const data = await api("GET", "/me/player?additional_types=episode")
              const item = data && data.item
              if (!item) {
                scope.track = null
              } else {
                const images = (item.album && item.album.images) || item.images || []
                scope.track = {
                  name: item.name,
                  artist: item.artists ? item.artists.map(a => a.name).join(", ") : (item.show ? item.show.name : ""),
                  imageUrl: images.length ? images[images.length > 1 ? 1 : 0].url : null,
                  duration: item.duration_ms || 0,
                  progress: data.progress_ms || 0,
                  progressAt: Date.now(),
                  playing: !!data.is_playing,
                  device: data.device ? data.device.name : "",
                }
                scope.track.image = coverFor(scope.track.imageUrl)
              }
            } catch (err) {
              if (isLinked()) showMessage(describeError(err))
            } finally {
              polling = false
              apply()
            }
          }

          async function control(method, path) {
            try {
              await api(method, path)
              pollIn = 0
              setTimeout(refreshPlayer, 350)
            } catch (err) {
              if (isLinked()) showMessage(describeError(err))
            }
          }

          scope.progressMs = function () {
            const t = scope.track
            if (!t) return 0
            const ms = t.playing ? t.progress + (Date.now() - t.progressAt) : t.progress
            return Math.min(ms, t.duration)
          }
          scope.progressPercent = function () {
            const t = scope.track
            return t && t.duration ? (scope.progressMs() / t.duration) * 100 : 0
          }

          scope.playPause = function () {
            if (!isLinked()) return
            const playing = scope.track && scope.track.playing
            if (scope.track) {
              scope.track.progress = scope.progressMs()
              scope.track.progressAt = Date.now()
              scope.track.playing = !playing
            }
            control("PUT", playing ? "/me/player/pause" : "/me/player/play")
          }
          scope.next = () => isLinked() && control("POST", "/me/player/next")
          scope.previous = () => isLinked() && control("POST", "/me/player/previous")

          // --- linking ---

          scope.saveClientId = function () {
            const id = (scope.form.clientId || "").trim()
            if (!id) return
            lua("spotifyRemote_main.setClientId(" + bngApi.serializeToLua(id) + ")")
          }

          scope.resetClientId = function () {
            scope.form.clientId = scope.state.clientId
            lua('spotifyRemote_main.setClientId("")')
          }

          scope.connect = function () {
            pkce = { verifier: randomString(64), state: randomString(16) }
            const params = new URLSearchParams({
              client_id: scope.state.clientId,
              response_type: "code",
              redirect_uri: scope.state.redirectUri,
              code_challenge_method: "S256",
              code_challenge: base64url(sha256(pkce.verifier)),
              scope: SCOPES,
              state: pkce.state,
            })
            scope.copied = false
            scope.status = "Opening your browser, please log in to Spotify …"
            showMessage("")
            lua("spotifyRemote_main.startAuth(" + bngApi.serializeToLua("https://accounts.spotify.com/authorize?" + params) + ")")
          }

          scope.copyAuthUrl = function () {
            lua("spotifyRemote_main.copyAuthUrl()")
            scope.copied = true
          }

          scope.logout = function () {
            accessToken = null
            scope.track = null
            lua("spotifyRemote_main.logout()")
          }

          // --- car radio settings ---

          const RADIO_STATUS = {
            off: "Car radio off: Spotify plays through your PC as usual.",
            idle: "Paused (ignition off, on foot or game paused).",
            waiting: "Waiting for sound. Are Spotify and the helper running on this PC?",
            receiving: "Playing through the car speakers.",
          }
          scope.radioStatusText = () => RADIO_STATUS[scope.state.radioStatus] || ""
          scope.percent = v => Math.round((parseFloat(v) || 0) * 100) + "%"
          scope.toggleSettings = function () {
            scope.view = scope.view === "settings" ? "player" : "settings"
          }
          scope.setRadio = function (key, value) {
            if (typeof value === "string") value = parseFloat(value)
            lua("spotifyRemote_main.setRadioSetting(" + bngApi.serializeToLua(key) + ", " + bngApi.serializeToLua(value) + ")")
          }

          scope.setMinimized = function (minimized) {
            scope.state.minimized = minimized
            lua("spotifyRemote_main.setMinimized(" + (minimized ? "true" : "false") + ")")
          }

          scope.$on("SpotifyRemoteAuthCode", async function (event, data) {
            if (!pkce) return
            const pending = pkce
            if (data && data.state && data.state !== pending.state) {
              // callback from an older login window: keep waiting for the current one
              showMessage("Login failed: this answer belongs to an older login window. Please use only the most recently opened one.", true)
              return
            }
            pkce = null
            scope.status = ""
            lua("spotifyRemote_main.stopAuth()")
            if (!data || data.error || !data.code) {
              showMessage("Login cancelled: " + ((data && data.error) || "no answer"), true)
              return
            }
            try {
              await tokenRequest({
                grant_type: "authorization_code",
                code: data.code,
                redirect_uri: scope.state.redirectUri,
                client_id: scope.state.clientId,
                code_verifier: pending.verifier,
              })
              pollIn = 0
              refreshPlayer()
            } catch (err) {
              showMessage(err instanceof TypeError
                ? "Login failed: no connection. Is the helper (spotifyremote-radio) running?"
                : "Login failed (" + err.status + "): " + err.message, true)
            }
            apply()
          })

          scope.$on("SpotifyRemoteState", function (event, data) {
            const wasLinked = isLinked()
            Object.assign(scope.state, data)
            if (!scope.form.clientId) scope.form.clientId = scope.state.clientId
            if (!isLinked()) {
              accessToken = null
              scope.track = null
            } else if (!wasLinked) {
              pollIn = 0
            }
            apply()
          })

          scope.$on("SpotifyRemoteCommand", function (event, name) {
            if (name === "playPause") scope.playPause()
            else if (name === "next") scope.next()
            else if (name === "previous") scope.previous()
          })

          // one tick per second: animates the progress bar and polls Spotify every few seconds
          const ticker = setInterval(function () {
            if (destroyed || !scope.state.visible || !isLinked()) return
            if (--pollIn <= 0) {
              pollIn = POLL_EVERY_S
              refreshPlayer()
            }
            if (scope.track && scope.track.playing) apply()
          }, 1000)

          scope.$on("$destroy", function () {
            destroyed = true
            clearInterval(ticker)
            clearTimeout(messageTimer)
          })

          lua("if spotifyRemote_main then spotifyRemote_main.requestState() end")
        },
      }
    },
  ])
})()
