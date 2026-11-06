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
