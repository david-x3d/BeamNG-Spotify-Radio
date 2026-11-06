// Harness: runs the BeamNG UI app's link function with stubbed angular/bngApi/fetch
const fs = require("fs")
const crypto = require("crypto")
const assert = require("assert")

const appPath = process.argv[2]
let factory
global.angular = { module: () => ({ directive: (name, arr) => { factory = arr[arr.length - 1] } }) }
const luaCalls = []
// game Lua forwards spotifyRemote_main.httpRequest to the helper; here it goes to the fetch stub
global.bngApi = {
  engineLua: code => {
    const m = code.match(/^spotifyRemote_main\.httpRequest\((.*)\)$/)
    if (!m) return luaCalls.push(code)
    const req = JSON.parse(m[1])
    global.fetch("http://127.0.0.1:8897" + req.path, { method: req.method, headers: req.headers, body: req.body })
      .then(async res => emit("SpotifyRemoteHttp", { id: req.id, status: res.status, body: await res.text() }))
      .catch(err => emit("SpotifyRemoteHttp", { id: req.id, error: String(err) }))
  },
  serializeToLua: v => JSON.stringify(v),
}
const fetchCalls = []
let fetchHandler = null
global.fetch = async (url, opts) => {
  fetchCalls.push({ url, opts })
  return fetchHandler(url, opts)
}
function response(status, body) {
  const text = body === undefined ? "" : JSON.stringify(body)
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => text, json: async () => JSON.parse(text) }
}

eval(fs.readFileSync(appPath, "utf8"))
const def = factory()
assert(def.template.includes("sprdx-card"))

const listeners = {}
const scope = {
  $on: (ev, fn) => { listeners[ev] = fn },
  $evalAsync: () => {},
}
def.link(scope)
const emit = (ev, data) => listeners[ev]({}, data)
const tick = ms => new Promise(r => setTimeout(r, ms))

;(async () => {
  assert(luaCalls.pop().includes("requestState"))

  // state without refresh token -> connect
  emit("SpotifyRemoteState", { clientId: "cid123", refreshToken: "", visible: true, minimized: false, redirectUri: "http://127.0.0.1:8899/callback" })
  assert.strictEqual(scope.form.clientId, "cid123")
  scope.connect()
  const authCall = luaCalls.pop()
  const authUrl = new URL(JSON.parse(authCall.match(/startAuth\((.*)\)$/)[1]))
  const q = authUrl.searchParams
  assert.strictEqual(q.get("client_id"), "cid123")
  assert.strictEqual(q.get("code_challenge_method"), "S256")
  assert.strictEqual(q.get("redirect_uri"), "http://127.0.0.1:8899/callback")

  // wrong state is rejected
  emit("SpotifyRemoteAuthCode", { code: "x", state: "wrong" })
  assert(scope.message.includes("older login window"))
  assert.strictEqual(fetchCalls.length, 0)

  // proper flow: the pending login survives the stale callback
  const q2pending = q
  void q2pending
  const q2 = q
  fetchHandler = async (url, opts) => {
    if (url.includes("/api/token")) return response(200, { access_token: "AT1", expires_in: 3600, refresh_token: "RT1" })
    if (url.includes("/me/player?")) return response(200, {
      is_playing: true, progress_ms: 30000, device: { name: "PC" },
      item: { name: "Song", duration_ms: 200000, artists: [{ name: "A" }, { name: "B" }], album: { images: [{ url: "https://i.scdn.co/image/big" }, { url: "https://i.scdn.co/image/mid" }, { url: "https://i.scdn.co/image/small" }] } },
    })
    if (url.endsWith("/image/mid")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "QUJD" }
    if (url.endsWith("/me/player/pause")) return response(204)
    if (url.endsWith("/me/player/next")) return response(403, { error: { status: 403, message: "Premium required" } })
    throw new Error("unexpected " + url)
  }
  await listeners["SpotifyRemoteAuthCode"]({}, { code: "CODE", state: q2.get("state") })
  const tokenBody = new URLSearchParams(fetchCalls[0].opts.body)
  assert.strictEqual(tokenBody.get("code"), "CODE")
  const verifier = tokenBody.get("code_verifier")
  assert(/^[A-Za-z0-9\-._~]{64}$/.test(verifier))
  const expected = crypto.createHash("sha256").update(verifier).digest("base64url")
  assert.strictEqual(q2.get("code_challenge"), expected, "PKCE challenge mismatch")
  assert(luaCalls.some(c => c === 'spotifyRemote_main.setRefreshToken("RT1")'))
  emit("SpotifyRemoteState", { clientId: "cid123", refreshToken: "RT1" })

  await tick(20)
  assert(scope.track, "track loaded")
  assert.strictEqual(scope.track.artist, "A, B")
  assert.strictEqual(scope.track.imageUrl, "https://i.scdn.co/image/mid")
  assert.strictEqual(scope.track.image, "data:image/jpeg;base64,QUJD")
  assert.strictEqual(fetchCalls.find(c => c.url.includes("/me/player?")).opts.headers.Authorization, "Bearer AT1")

  // play/pause via input action
  emit("SpotifyRemoteCommand", "playPause")
  await tick(20)
  assert(fetchCalls.some(c => c.url.endsWith("/me/player/pause") && c.opts.method === "PUT"))
  assert.strictEqual(scope.track.playing, false)

  // premium error
  emit("SpotifyRemoteCommand", "next")
  await tick(20)
  assert(scope.message.includes("Premium"), scope.message)

  // home view: grid button loads your music
  const img = id => [{ url: "https://i.scdn.co/image/" + id + "640", width: 640 }, { url: "https://i.scdn.co/image/" + id + "300", width: 300 }, { url: "https://i.scdn.co/image/" + id + "64", width: 64 }]
  const tr = (id, album) => ({ uri: "spotify:track:" + id, name: "T" + id, type: "track", duration_ms: 1000, artists: [{ name: "Art" }], album: album || { uri: "spotify:album:al1", name: "Al", images: img("al") } })
  fetchCalls.length = 0
  fetchHandler = async (url, opts) => {
    const path = url.replace("http://127.0.0.1:8897/api/v1", "")
    if (url.includes("/image/") || url.includes("/mosaic/")) return { ok: true, status: 200, headers: { get: () => null }, text: async () => "IMG" }
    if (path.startsWith("/me/player/recently-played")) return response(200, { items: [
      { track: tr("1"), context: { type: "playlist", uri: "spotify:playlist:pl1" } },
      { track: tr("2"), context: { type: "album", uri: "spotify:album:al1" } },
      { track: tr("1"), context: { type: "artist", uri: "spotify:artist:ar1" } },
      { track: tr("3"), context: { type: "playlist", uri: "spotify:playlist:editorial" } },
    ] })
    if (path.startsWith("/me/playlists")) return response(200, { items: [
      { id: "pl1", uri: "spotify:playlist:pl1", name: "Mine", owner: { display_name: "me" }, images: [{ url: "https://mosaic.scdn.co/640/abc", width: null }] },
    ] })
    if (path.startsWith("/me/top/tracks")) return response(200, { items: [tr("4"), tr("5"), { uri: "spotify:local:x", is_local: true, type: "track" }] })
    if (path.startsWith("/me/top/artists")) return response(200, { items: [{ id: "ar2", uri: "spotify:artist:ar2", name: "Top", images: img("ar2") }] })
    if (path.startsWith("/me/albums")) return response(200, { items: [] })
    if (path === "/artists/ar1") return response(200, { id: "ar1", uri: "spotify:artist:ar1", name: "Artist1", images: [] })
    if (path.startsWith("/playlists/editorial")) return response(404, { error: { message: "not found" } })
    if (path.startsWith("/playlists/pl1/items")) return response(200, { total: 2, next: null, items: [{ item: tr("6") }, { track: tr("7") }, { item: null }] })
    if (path.startsWith("/search")) return response(200, { tracks: { items: [tr("8")] }, artists: { items: [null] }, albums: { items: [] }, playlists: { items: [null, { id: "pl9", uri: "spotify:playlist:pl9", name: "Found", images: [] }] } })
    if (path === "/me/player/play" && !opts.__seen404) return response(404, { error: { message: "no active device" } })
    if (path === "/me/player/devices") return response(200, { devices: [{ id: "phone", type: "Smartphone" }, { id: "pc", type: "Computer" }] })
    if (path.startsWith("/me/player/play?device_id=")) return response(204)
    if (path.startsWith("/me/player?")) return response(200, { is_playing: true, progress_ms: 0, item: tr("6") })
    throw new Error("unexpected " + url)
  }
  scope.toggleHome()
  assert.strictEqual(scope.expanded, true)
  await tick(40)
  const home = scope.home
  assert(home.loadedAt, "home loaded: " + home.error)
  assert.strictEqual(home.needsReconnect, false)
  assert.deepStrictEqual(home.quick.map(c => c.name), ["Liked Songs", "Mine", "Al", "Artist1"])
  const secs = Object.fromEntries(home.sections.map(s => [s.title, s.items]))
  assert.deepStrictEqual(secs["Your top songs"].map(t => t.uri), ["spotify:track:4", "spotify:track:5"], "local files are left out")
  assert.deepStrictEqual(secs["Recently played songs"].map(t => t.name), ["T1", "T2", "T3"])
  assert.strictEqual(secs["Your top artists"][0].imageUrl, "https://i.scdn.co/image/ar2300")
  assert(!secs["Saved albums"], "empty sections are hidden")
  // covers of all kinds go through the helper
  assert.strictEqual(scope.bg("https://mosaic.scdn.co/640/abc")["background-image"], undefined)
  await tick(20)
  assert.strictEqual(scope.bg("https://mosaic.scdn.co/640/abc")["background-image"], "url(data:image/jpeg;base64,IMG)")
  assert(fetchCalls.some(c => c.url.endsWith("/mosaic/300/abc")))
  assert.deepStrictEqual(scope.bg("https://example.com/x.jpg"), {})

  // open a playlist and play a song in it: no active device -> wakes the PC
  scope.openCard(home.quick[1], home.quick)
  await tick(20)
  assert.strictEqual(scope.page.type, "playlist")
  assert.deepStrictEqual(scope.page.tracks.map(t => t.name), ["T6", "T7"])
  fetchCalls.length = 0
  scope.playTrackOnPage(1)
  await tick(20)
  const playCall = fetchCalls.find(c => c.url.includes("device_id=pc"))
  assert(playCall, fetchCalls.map(c => c.url).join("\n"))
  assert.strictEqual(playCall.opts.method, "PUT")
  assert.strictEqual(playCall.opts.headers["Content-Type"], "application/json")
  assert.deepStrictEqual(JSON.parse(playCall.opts.body), { context_uri: "spotify:playlist:pl1", offset: { uri: "spotify:track:7" } })

  // track cards play the list they are in
  fetchCalls.length = 0
  scope.goBack()
  assert.strictEqual(scope.page, null)
  scope.openCard(secs["Your top songs"][1], secs["Your top songs"])
  await tick(20)
  assert.deepStrictEqual(JSON.parse(fetchCalls.find(c => c.url.includes("device_id")).opts.body), { uris: ["spotify:track:4", "spotify:track:5"], offset: { position: 1 } })

  // search
  scope.search.q = "hello world"
  await scope.runSearch()
  assert.strictEqual(scope.page.type, "search")
  assert(fetchCalls.some(c => c.url.includes("/search?") && c.url.includes("q=hello%20world")))
  assert.deepStrictEqual(scope.page.tracks.map(t => t.name), ["T8"])
  assert.deepStrictEqual(scope.page.sections.map(s => s.title + ":" + s.items.length), ["Playlists:1"])
  scope.search.q = ""
  await scope.runSearch()
  assert.strictEqual(scope.page, null, "clearing the search goes back")

  // grid button again -> small player, collapse still works
  scope.toggleHome()
  assert.strictEqual(scope.expanded, false)
  scope.toggleHome()
  scope.setMinimized(true)
  assert.strictEqual(scope.expanded, false)
  scope.setMinimized(false)

  // old login without library permissions -> reconnect hint
  fetchHandler = async url => url.includes("/api/token") ? response(200, { access_token: "AT3", expires_in: 3600, scope: "user-read-playback-state user-modify-playback-state" }) : response(403, { error: { message: "Insufficient client scope" } })
  listeners["SpotifyRemoteState"]({}, { clientId: "cid123", refreshToken: "" })
  emit("SpotifyRemoteState", { clientId: "cid123", refreshToken: "RT1" })
  assert.strictEqual(scope.home.loadedAt, 0, "logout clears the library")
  scope.connect()
  const p3 = new URL(JSON.parse(luaCalls.pop().match(/startAuth\((.*)\)$/)[1])).searchParams
  assert(p3.get("scope").includes("playlist-read-private"))
  await listeners["SpotifyRemoteAuthCode"]({}, { code: "c", state: p3.get("state") })
  scope.toggleHome()
  await tick(20)
  assert.strictEqual(scope.home.needsReconnect, true)
  assert.strictEqual(scope.home.error, "")
  scope.toggleHome()

  // expired access token -> refresh with refresh token
  fetchCalls.length = 0
  let first = true
  fetchHandler = async (url, opts) => {
    if (url.includes("/api/token")) return response(200, { access_token: "AT2", expires_in: 3600 })
    if (first) { first = false; return response(401, { error: { message: "expired" } }) }
    return response(204)
  }
  scope.previous()
  await tick(20)
  const tokenCall = fetchCalls.find(c => c.url.includes("/api/token"))
  assert.strictEqual(new URLSearchParams(tokenCall.opts.body).get("grant_type"), "refresh_token")
  assert.strictEqual(new URLSearchParams(tokenCall.opts.body).get("refresh_token"), "RT1")
  assert(fetchCalls.some(c => c.url.endsWith("/previous") && c.opts.headers.Authorization === "Bearer AT2"))

  // revoked refresh token -> logout
  fetchHandler = async url => url.includes("/api/token") ? response(400, { error: "invalid_grant" }) : response(401, {})
  luaCalls.length = 0
  scope.next()
  await tick(20)
  assert(luaCalls.includes("spotifyRemote_main.logout()"), luaCalls.join("\n"))
  assert(scope.message.includes("expired"))

  // many random PKCE values against node's sha256
  for (let i = 0; i < 300; i++) {
    scope.connect()
    const p = new URL(JSON.parse(luaCalls.pop().match(/startAuth\((.*)\)$/)[1])).searchParams
    fetchCalls.length = 0
    fetchHandler = async () => response(200, { access_token: "x", expires_in: 3600 })
    await listeners["SpotifyRemoteAuthCode"]({}, { code: "c", state: p.get("state") })
    const v = new URLSearchParams(fetchCalls[0].opts.body).get("code_verifier")
    assert.strictEqual(p.get("code_challenge"), crypto.createHash("sha256").update(v).digest("base64url"))
  }
  listeners["$destroy"]()
  console.log("all tests passed")
  process.exit(0)
})().catch(e => { console.error(e); process.exit(1) })
