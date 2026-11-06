(function () {
  "use strict"

  // needed for the home view (playlists, liked songs, recently played, top items)
  const LIBRARY_SCOPES = ["user-read-recently-played", "user-top-read", "user-library-read", "playlist-read-private", "playlist-read-collaborative"]
  const SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"].concat(LIBRARY_SCOPES).join(" ")
  const POLL_EVERY_S = 3
  const HOME_MAX_AGE_MS = 5 * 60 * 1000
  const MAX_COVERS = 400
  const MAX_COVER_LOADS = 6

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

  // --- Spotify objects -> cards and tracks for the home view ---

  // smallest image that is at least `min` pixels wide
  function pickImage(images, min) {
    const list = (images || []).filter(i => i && i.url)
    if (!list.length) return null
    if (list.some(i => !i.width)) return list[0].url
    const sorted = list.slice().sort((a, b) => a.width - b.width)
    return (sorted.find(i => i.width >= (min || 200)) || sorted[sorted.length - 1]).url
  }

  const names = list => (list || []).map(a => a && a.name).filter(Boolean).join(", ")

  function playlistCard(p) {
    if (!p || !p.uri) return null
    const owner = p.owner && p.owner.display_name
    return { type: "playlist", id: p.id, uri: p.uri, name: p.name, owner, sub: "Playlist" + (owner ? " · " + owner : ""), imageUrl: pickImage(p.images) }
  }

  function albumCard(a) {
    if (!a || !a.uri) return null
    return { type: "album", id: a.id, uri: a.uri, name: a.name, sub: names(a.artists) || "Album", imageUrl: pickImage(a.images), year: (a.release_date || "").slice(0, 4) }
  }

  function artistCard(a) {
    if (!a || !a.uri) return null
    return { type: "artist", id: a.id, uri: a.uri, name: a.name, sub: "Artist", imageUrl: pickImage(a.images) }
  }

  const likedCard = () => ({ type: "liked", uri: "liked", name: "Liked Songs", sub: "Playlist" })

  function trackOf(t) {
    if (!t || !t.uri || t.is_local || (t.type && t.type !== "track" && t.type !== "episode")) return null
    const images = (t.album && t.album.images) || t.images
    return {
      type: "track", uri: t.uri, name: t.name,
      sub: names(t.artists) || (t.show && t.show.name) || "",
      album: (t.album && t.album.name) || "",
      duration: t.duration_ms || 0,
      imageUrl: pickImage(images), thumbUrl: pickImage(images, 48),
    }
  }

  function uniqueBy(list, key) {
    const seen = {}
    return list.filter(x => x && !seen[x[key]] && (seen[x[key]] = true))
  }

  const section = (title, items) => ({ title, items: (items || []).filter(Boolean), all: false })

  // cover urls -> path on the helper's image proxy
  function imagePath(url) {
    let m = url && url.match(/^https:\/\/i\.scdn\.co\/image\/([A-Za-z0-9]+)$/)
    if (m) return "/image/" + m[1]
    m = url && url.match(/^https:\/\/mosaic\.scdn\.co\/\d+\/([A-Za-z0-9]+)$/)
    if (m) return "/mosaic/300/" + m[1]
    m = url && url.match(/^https:\/\/image-cdn-(ak|fa)\.spotifycdn\.com\/image\/([A-Za-z0-9]+)$/)
    if (m) return "/imagecdn-" + m[1] + "/" + m[2]
    return null
  }

  const ICON_NOTE = '<svg viewBox="0 0 24 24"><path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/></svg>'
  const ICON_PLAY = '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>'
  const ICON_PAUSE = '<svg viewBox="0 0 24 24"><path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>'
  const ICON_PREV = '<svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg>'
  const ICON_NEXT = '<svg viewBox="0 0 24 24"><path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z"/></svg>'
  const ICON_VOLUME = '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4z"/></svg>'
  const ICON_GRID = '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="3.5" width="7.5" height="7.5" rx="1.5"/><rect x="3.5" y="13" width="7.5" height="7.5" rx="1.5"/><rect x="13" y="13" width="7.5" height="7.5" rx="1.5"/></svg>'
  const ICON_HEART = '<svg viewBox="0 0 24 24"><path d="M12 21s-7.5-4.6-9.6-9.3C.9 8.3 3 4.5 6.7 4.5c2.1 0 3.6 1.1 4.3 2.3h2c.7-1.2 2.2-2.3 4.3-2.3 3.7 0 5.8 3.8 4.3 7.2C19.5 16.4 12 21 12 21z"/></svg>'

  // a row of cards; `list` is an expression for {title, items, all}
  const CARDS = list => `
      <div class="sprdx-h2" ng-if="${list}.items.length">{{ ${list}.title }}
        <button class="sprdx-more" ng-if="${list}.items.length > 4" ng-click="${list}.all = !${list}.all">{{ ${list}.all ? 'Show less' : 'Show all' }}</button>
      </div>
      <div class="sprdx-cards" ng-class="{all: ${list}.all}">
        <div class="sprdx-ci" ng-repeat="c in ${list}.items" ng-click="openCard(c, ${list}.items)" title="{{ c.name }}">
          <div class="sprdx-art" ng-class="{round: c.type === 'artist', 'sprdx-liked': c.type === 'liked'}" ng-style="bg(c.imageUrl)">
            <span ng-if="c.type === 'liked'">${ICON_HEART}</span>
            <span class="sprdx-noart" ng-if="c.type !== 'liked' && !hasCover(c.imageUrl)">${ICON_NOTE}</span>
            <button class="sprdx-fab" ng-click="$event.stopPropagation(); playCard(c, ${list}.items)" title="Play">${ICON_PLAY}</button>
          </div>
          <div class="sprdx-cname">{{ c.name }}</div>
          <div class="sprdx-csub">{{ c.sub }}</div>
        </div>
      </div>`

  const TEMPLATE = `
<div class="sprdx" ng-show="state.visible" ng-class="{'sprdx-big': expanded && !state.minimized}">
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
    .sprdx-icon[disabled]{opacity:.35;cursor:default;background:transparent}
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

    /* big home view: moved to <body> while open, above BeamNG's full screen layer (z 0) and
       the pause button (10), below loading screens (50) and popups (12000) */
    .sprdx-big{position:fixed;left:7vw;right:7vw;top:6vh;bottom:6vh;width:auto;height:auto;z-index:20;font-size:13px}
    .sprdx-big .sprdx-card{background:#121212;border-radius:12px;padding:0;overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,.65)}
    .sprdx-top{display:flex;align-items:center;gap:8px;padding:12px 16px;background:#0b0b0b}
    .sprdx-top .sprdx-icon{width:34px;height:34px;background:#1f1f1f}
    .sprdx-top .sprdx-icon:hover{background:#2a2a2a}
    .sprdx-top .sprdx-icon svg{width:19px;height:19px}
    .sprdx-top .sprdx-icon.sprdx-on{color:#1ed760}
    .sprdx-search{display:flex;align-items:center;gap:8px;background:#1f1f1f;border-radius:20px;padding:0 14px;height:38px;width:min(380px,45%);border:1px solid transparent}
    .sprdx-search:focus-within{border-color:#fff}
    .sprdx-search svg{width:18px;height:18px;opacity:.7;flex:none}
    .sprdx-search input{flex:1;min-width:0;background:none;border:0;outline:0;color:#fff;font-size:13px}
    .sprdx-scroll{flex:1;min-height:0;overflow-y:auto;padding:8px 22px 24px;background:linear-gradient(#1d3527 0,#121212 260px)}
    .sprdx-scroll::-webkit-scrollbar{width:12px}
    .sprdx-scroll::-webkit-scrollbar-track{background:transparent}
    .sprdx-scroll::-webkit-scrollbar-thumb{background:rgba(255,255,255,.22);border:3px solid transparent;background-clip:padding-box;border-radius:6px}
    .sprdx-scroll::-webkit-scrollbar-thumb:hover{background-color:rgba(255,255,255,.4)}
    .sprdx-hello{font-size:26px;font-weight:700;margin:8px 0 16px}
    .sprdx-note{display:flex;align-items:center;gap:14px;flex-wrap:wrap;background:rgba(255,255,255,.08);border-radius:8px;padding:12px 14px;margin-bottom:16px;line-height:1.4}
    .sprdx-note .sprdx-btn{align-self:center}
    .sprdx-quick{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;margin-bottom:10px}
    .sprdx-qt{display:flex;align-items:center;gap:12px;height:56px;background:rgba(255,255,255,.08);border-radius:5px;overflow:hidden;cursor:pointer;font-weight:700}
    .sprdx-qt:hover{background:rgba(255,255,255,.17)}
    .sprdx-qt .sprdx-art{width:56px;height:56px;border-radius:0;flex:none;box-shadow:none}
    .sprdx-qt .sprdx-art svg{width:24px;height:24px}
    .sprdx-qt .sprdx-cname{margin:0;flex:1}
    .sprdx-qt .sprdx-fab{position:static;width:34px;height:34px;margin-right:10px;flex:none}
    .sprdx-qt .sprdx-fab svg{width:18px;height:18px}
    .sprdx-h2{font-size:19px;font-weight:700;margin:20px 0 6px;display:flex;align-items:baseline;gap:10px}
    .sprdx-more{margin-left:auto;font-size:12px;opacity:.65;background:none;border:0;color:#fff;cursor:pointer;font-weight:700}
    .sprdx-more:hover{opacity:1;text-decoration:underline}
    .sprdx-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));grid-template-rows:auto;grid-auto-rows:0;overflow:hidden;margin:0 -10px}
    .sprdx-cards.all{grid-auto-rows:auto}
    .sprdx-ci{padding:10px;border-radius:8px;cursor:pointer;min-width:0}
    .sprdx-ci:hover{background:rgba(255,255,255,.08)}
    .sprdx-art{position:relative;width:100%;padding-top:100%;border-radius:6px;background:#2a2a2a center/cover no-repeat;box-shadow:0 6px 18px rgba(0,0,0,.45)}
    .sprdx-qt .sprdx-art{padding-top:0}
    .sprdx-art.round{border-radius:50%}
    .sprdx-art>span{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
    .sprdx-art>span svg{width:38%;height:38%}
    .sprdx-noart svg{opacity:.35}
    .sprdx-liked{background:linear-gradient(135deg,#450af5,#8e8ee5 55%,#c4efd9)}
    .sprdx-fab{position:absolute;right:8px;bottom:8px;width:44px;height:44px;border-radius:50%;background:#1ed760;color:#000;border:0;display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .15s;cursor:pointer;box-shadow:0 6px 14px rgba(0,0,0,.45);padding:0}
    .sprdx-fab svg{width:22px;height:22px}
    .sprdx-fab:hover{background:#3be477}
    .sprdx-ci:hover .sprdx-fab,.sprdx-qt:hover .sprdx-fab{opacity:1}
    .sprdx-cname{font-weight:600;margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sprdx-csub{opacity:.65;font-size:12px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sprdx-hero{display:flex;align-items:flex-end;gap:22px;margin:12px 0 18px}
    .sprdx-heroart{width:180px;height:180px;padding-top:0;flex:none}
    .sprdx-herotxt{min-width:0;flex:1}
    .sprdx-kind{font-size:12px;font-weight:600}
    .sprdx-h1{font-size:36px;font-weight:800;line-height:1.1;margin:6px 0 10px;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .sprdx-bigplay{width:54px;height:54px;border-radius:50%;border:0;background:#1ed760;color:#000;display:flex;align-items:center;justify-content:center;cursor:pointer;margin-top:14px;padding:0}
    .sprdx-bigplay:hover{background:#3be477}
    .sprdx-bigplay svg{width:28px;height:28px}
    .sprdx-tr{display:grid;grid-template-columns:30px minmax(0,1fr) minmax(0,.7fr) 54px;align-items:center;gap:14px;padding:6px 10px;border-radius:5px;cursor:pointer}
    .sprdx-tr:hover{background:rgba(255,255,255,.1)}
    .sprdx-tr.now .sprdx-tname,.sprdx-tr.now .sprdx-tnum{color:#1ed760}
    .sprdx-tnum{opacity:.65;text-align:right;display:flex;justify-content:flex-end}
    .sprdx-tnum svg{width:16px;height:16px;display:none}
    .sprdx-tr:hover .sprdx-tnum span{display:none}
    .sprdx-tr:hover .sprdx-tnum svg{display:block}
    .sprdx-tmain{display:flex;align-items:center;gap:12px;min-width:0}
    .sprdx-tart{width:40px;height:40px;border-radius:4px;flex:none;background:#2a2a2a center/cover no-repeat}
    .sprdx-tname{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sprdx-talb,.sprdx-tdur{opacity:.65;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sprdx-tdur{text-align:right}
    .sprdx-loading{opacity:.6;padding:10px 0}
    .sprdx-loadmore{margin:14px 10px 0}
    .sprdx-nowbar{display:flex;align-items:center;gap:18px;padding:10px 16px;background:#000;border-top:1px solid #1f1f1f}
    .sprdx-nowleft{display:flex;align-items:center;gap:12px;width:30%;min-width:0}
    .sprdx-nowleft .sprdx-cover{width:52px;height:52px;border-radius:4px}
    .sprdx-nowmid{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;min-width:0}
    .sprdx-nowmid .sprdx-ctrl{gap:20px}
    .sprdx-nowprog{display:flex;align-items:center;gap:8px;width:100%;max-width:520px;font-size:11px;opacity:.85}
    .sprdx-nowprog .sprdx-bar{flex:1;margin:0;height:4px}
    .sprdx-nowright{width:25%;display:flex;flex-direction:column;align-items:flex-end;gap:4px}
    .sprdx-nowright .sprdx-vol{width:100%;max-width:170px}
  </style>

  <div class="sprdx-pill" ng-if="state.minimized" ng-click="setMinimized(false)" title="Expand">
    ${ICON_NOTE}<span class="sprdx-grow">{{ track ? track.name + ' · ' + track.artist : 'Spotify' }}</span>
    <svg class="sprdx-chev" viewBox="0 0 24 24"><path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg>
  </div>

  <div class="sprdx-card" ng-if="!state.minimized">
    <div class="sprdx-head" ng-if="!expanded">
      <span class="sprdx-grow"></span>
      <button class="sprdx-icon" ng-if="linked()" ng-click="toggleHome()" title="Home: your music">${ICON_GRID}</button>
      <button class="sprdx-icon" ng-class="{'sprdx-active': view === 'settings'}" ng-click="toggleSettings()" title="Settings">
        <svg viewBox="0 0 24 24"><path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7 7 0 0 0-1.7-1L15 3h-4l-.4 2.7a7 7 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7 7 0 0 0 1.7 1L11 21h4l.4-2.7a7 7 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/></svg>
      </button>
      <button class="sprdx-icon" ng-click="setMinimized(true)" title="Collapse">
        <svg viewBox="0 0 24 24"><path d="M7.4 8.6 12 13.2l4.6-4.6L18 10l-6 6-6-6z"/></svg>
      </button>
    </div>

    <div class="sprdx-set" ng-if="!expanded && view === 'settings'">
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

    <div class="sprdx-body" ng-if="!expanded && view !== 'settings' && !state.clientId">
      <div class="sprdx-hint">Create an app on <b>developer.spotify.com</b>, add <b>{{ state.redirectUri }}</b> as Redirect URI and paste its Client ID here:</div>
      <input class="sprdx-input" type="text" ng-model="form.clientId" placeholder="Client ID">
      <button class="sprdx-btn" ng-click="saveClientId()">Save</button>
    </div>

    <div class="sprdx-body" ng-if="!expanded && view !== 'settings' && state.clientId && !state.refreshToken">
      <button class="sprdx-btn" ng-click="connect()">Connect with Spotify</button>
      <div class="sprdx-hint" ng-if="status">{{ status }}</div>
      <button class="sprdx-link" ng-if="status" ng-click="copyAuthUrl()">{{ copied ? 'Link copied, paste it into your browser' : 'Nothing opened? Copy the link' }}</button>
      <div class="sprdx-msg" ng-if="message">{{ message }}</div>
      <button class="sprdx-link" ng-click="resetClientId()">Change Client ID</button>
    </div>

    <div class="sprdx-body" ng-if="!expanded && view !== 'settings' && state.clientId && state.refreshToken">
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
        <button class="sprdx-icon" ng-click="previous()" title="Previous track">${ICON_PREV}</button>
        <button class="sprdx-icon sprdx-play" ng-click="playPause()" title="Play/Pause">
          <span ng-if="!(track && track.playing)">${ICON_PLAY}</span>
          <span ng-if="track && track.playing">${ICON_PAUSE}</span>
        </button>
        <button class="sprdx-icon" ng-click="next()" title="Next track">${ICON_NEXT}</button>
      </div>
      <div class="sprdx-vol" ng-if="state.radio.enabled" title="Car radio volume">
        ${ICON_VOLUME}
        <input class="sprdx-range" type="range" min="0" max="2" step="0.01" ng-model="state.radio.volume" ng-change="setRadio('volume', state.radio.volume)">
      </div>
      <div class="sprdx-msg" ng-if="message">{{ message }}</div>
    </div>

    <!-- big home view -->
    <div class="sprdx-top" ng-if="expanded">
      <button class="sprdx-icon" ng-click="goBack()" ng-disabled="!page" title="Back">
        <svg viewBox="0 0 24 24"><path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4-4.6-4.6z"/></svg>
      </button>
      <button class="sprdx-icon" ng-class="{'sprdx-on': !page}" ng-click="goHome()" title="Home">
        <svg viewBox="0 0 24 24"><path d="M12 3 3 10.5V21h6.5v-6h5v6H21V10.5z"/></svg>
      </button>
      <div class="sprdx-search">
        <svg viewBox="0 0 24 24"><path d="M15.5 14h-.8l-.3-.3A6.5 6.5 0 1 0 14 15.5l.3.3v.8l5 5 1.5-1.5-5-5zm-6 0a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9z"/></svg>
        <input type="text" ng-model="search.q" ng-change="searchChanged()" ng-keyup="$event.keyCode === 13 && runSearch()" placeholder="What do you want to play?">
      </div>
      <span class="sprdx-grow"></span>
      <button class="sprdx-icon sprdx-on" ng-click="toggleHome()" title="Back to the small player">${ICON_GRID}</button>
    </div>

    <div class="sprdx-scroll" ng-if="expanded">
      <div ng-if="!page">
        <div class="sprdx-hello">{{ greeting() }}</div>
        <div class="sprdx-note" ng-if="home.needsReconnect">
          <span class="sprdx-grow">Spotify needs a few more permissions to show your playlists and library.</span>
          <button class="sprdx-btn" ng-click="connect()">Reconnect Spotify</button>
          <span class="sprdx-hint" ng-if="status">{{ status }}
            <button class="sprdx-link" ng-click="copyAuthUrl()">{{ copied ? 'Link copied, paste it into your browser' : 'Nothing opened? Copy the link' }}</button>
          </span>
        </div>
        <div class="sprdx-loading" ng-if="home.loading && !home.loadedAt">Loading your music …</div>
        <div class="sprdx-msg" ng-if="home.error">{{ home.error }}</div>
        <div class="sprdx-quick" ng-if="home.quick.length">
          <div class="sprdx-qt" ng-repeat="c in home.quick" ng-click="openCard(c, home.quick)" title="{{ c.name }}">
            <div class="sprdx-art" ng-class="{'sprdx-liked': c.type === 'liked'}" ng-style="bg(c.imageUrl)">
              <span ng-if="c.type === 'liked'">${ICON_HEART}</span>
              <span class="sprdx-noart" ng-if="c.type !== 'liked' && !hasCover(c.imageUrl)">${ICON_NOTE}</span>
            </div>
            <div class="sprdx-cname">{{ c.name }}</div>
            <button class="sprdx-fab" ng-click="$event.stopPropagation(); playCard(c, home.quick)" title="Play">${ICON_PLAY}</button>
          </div>
        </div>
        <div ng-repeat="sec in home.sections">${CARDS("sec")}
        </div>
      </div>

      <div ng-if="page">
        <div class="sprdx-hero" ng-if="page.type !== 'search'">
          <div class="sprdx-art sprdx-heroart" ng-class="{round: page.type === 'artist', 'sprdx-liked': page.type === 'liked'}" ng-style="bg(page.imageUrl)">
            <span ng-if="page.type === 'liked'">${ICON_HEART}</span>
            <span class="sprdx-noart" ng-if="page.type !== 'liked' && !hasCover(page.imageUrl)">${ICON_NOTE}</span>
          </div>
          <div class="sprdx-herotxt">
            <div class="sprdx-kind">{{ page.kind }}</div>
            <div class="sprdx-h1">{{ page.name }}</div>
            <div class="sprdx-sub">{{ page.sub }}</div>
            <button class="sprdx-bigplay" ng-click="playPage()" title="Play">${ICON_PLAY}</button>
          </div>
        </div>
        <div class="sprdx-h2" ng-if="page.type === 'search' && page.tracks.length">Songs</div>
        <div class="sprdx-tr" ng-repeat="t in page.tracks" ng-class="{now: isCurrent(t)}" ng-click="playTrackOnPage($index)">
          <div class="sprdx-tnum"><span>{{ $index + 1 }}</span>${ICON_PLAY}</div>
          <div class="sprdx-tmain">
            <div class="sprdx-tart" ng-if="page.type !== 'album'" ng-style="bg(t.thumbUrl)"></div>
            <div style="min-width:0">
              <div class="sprdx-tname">{{ t.name }}</div>
              <div class="sprdx-csub">{{ t.sub }}</div>
            </div>
          </div>
          <div class="sprdx-talb">{{ page.type === 'album' ? '' : t.album }}</div>
          <div class="sprdx-tdur">{{ formatTime(t.duration) }}</div>
        </div>
        <button class="sprdx-btn sprdx-loadmore" ng-if="page.more && !page.loading" ng-click="loadMore()">Load more</button>
        <div class="sprdx-loading" ng-if="page.loading">Loading …</div>
        <div class="sprdx-hint" ng-if="page.note">{{ page.note }}</div>
        <div ng-repeat="sec in page.sections">${CARDS("sec")}
        </div>
      </div>
    </div>

    <div class="sprdx-nowbar" ng-if="expanded">
      <div class="sprdx-nowleft">
        <div class="sprdx-cover" ng-style="track && track.image ? {'background-image': 'url(' + track.image + ')'} : {}"></div>
        <div style="min-width:0">
          <div class="sprdx-title">{{ track ? track.name : 'Nothing playing' }}</div>
          <div class="sprdx-sub">{{ track ? track.artist : 'Pick something to play' }}</div>
        </div>
      </div>
      <div class="sprdx-nowmid">
        <div class="sprdx-ctrl">
          <button class="sprdx-icon" ng-click="previous()" title="Previous track">${ICON_PREV}</button>
          <button class="sprdx-icon sprdx-play" ng-click="playPause()" title="Play/Pause">
            <span ng-if="!(track && track.playing)">${ICON_PLAY}</span>
            <span ng-if="track && track.playing">${ICON_PAUSE}</span>
          </button>
          <button class="sprdx-icon" ng-click="next()" title="Next track">${ICON_NEXT}</button>
        </div>
        <div class="sprdx-nowprog">
          <span>{{ formatTime(progressMs()) }}</span>
          <div class="sprdx-bar"><div ng-style="{width: progressPercent() + '%'}"></div></div>
          <span>{{ formatTime(track ? track.duration : 0) }}</span>
        </div>
      </div>
      <div class="sprdx-nowright">
        <div class="sprdx-vol" ng-if="state.radio.enabled" title="Car radio volume">
          ${ICON_VOLUME}
          <input class="sprdx-range" type="range" min="0" max="2" step="0.01" ng-model="state.radio.volume" ng-change="setRadio('volume', state.radio.volume)">
        </div>
        <div class="sprdx-msg" ng-if="message">{{ message }}</div>
      </div>
    </div>
  </div>
</div>`

  angular.module("beamng.apps").directive("spotifyRemoteDavidx3d", [
    function () {
      return {
        template: TEMPLATE,
        replace: true,
        link: function (scope, element) {
          scope.state = { visible: true, minimized: false, clientId: "", refreshToken: "", redirectUri: "", radio: {}, radioStatus: "off" }
          scope.view = "player"
          scope.form = { clientId: "" }
          scope.track = null
          scope.status = ""
          scope.message = ""
          scope.formatTime = formatTime
          scope.expanded = false
          scope.page = null
          scope.search = { q: "" }

          let accessToken = null
          let accessExpires = 0
          let pkce = null
          let pollIn = 0
          let polling = false
          let messageTimer = null
          let destroyed = false
          let grantedScopes = null
          let pageHistory = []
          let homeLoad = null
          let searchTimer = null

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
            if (typeof data.scope === "string") {
              grantedScopes = data.scope.split(" ")
              if (missingScopes()) scope.home.needsReconnect = true
            }
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

          // opts: {body} is sent as JSON
          async function api(method, path, opts) {
            opts = opts || {}
            const token = await getAccessToken()
            const headers = { Authorization: "Bearer " + token }
            let body = ""
            if (opts.body) {
              headers["Content-Type"] = "application/json"
              body = JSON.stringify(opts.body)
            }
            const res = await httpRequest(method, "/api/v1" + path, { headers, body })
            if (res.status === 401 && !opts.retried) {
              accessToken = null
              return api(method, path, Object.assign({}, opts, { retried: true }))
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

          // covers come through the helper as base64 (the game UI may not load images from the web);
          // value: data url, null while loading, false when it failed
          const covers = {}
          const coverOrder = []
          const coverQueue = []
          let coverLoads = 0
          function coverFor(url) {
            if (!url) return null
            if (url in covers) return covers[url] || null
            covers[url] = imagePath(url) ? null : false
            coverOrder.push(url)
            if (coverOrder.length > MAX_COVERS) delete covers[coverOrder.shift()]
            if (covers[url] === null) {
              coverQueue.push(url)
              loadCovers()
            }
            return null
          }
          function loadCovers() {
            while (coverLoads < MAX_COVER_LOADS && coverQueue.length) {
              const url = coverQueue.shift()
              if (covers[url] !== null) continue
              coverLoads++
              httpRequest("GET", imagePath(url)).then(async function (res) {
                if (!(url in covers)) return
                covers[url] = res.ok ? "data:image/jpeg;base64," + (await res.text()) : false
                if (covers[url] && scope.track && scope.track.imageUrl === url) scope.track.image = covers[url]
                apply()
              }).catch(function () {
                // helper not reachable: try again later
                covers[url] = false
                setTimeout(() => { if (covers[url] === false) delete covers[url] }, 30000)
              }).finally(function () {
                coverLoads--
                loadCovers()
              })
            }
          }
          scope.hasCover = url => !!coverFor(url)
          scope.bg = function (url) {
            const data = coverFor(url)
            return data ? { "background-image": "url(" + data + ")" } : {}
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
                  uri: item.uri,
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

          // --- home view: your music, like the start page of the Spotify app ---

          const missingScopes = () => !!grantedScopes && LIBRARY_SCOPES.some(s => grantedScopes.indexOf(s) < 0)
          const isScopeError = err => err && (err.status === 401 || err.status === 403)
          const loadError = err => err instanceof TypeError
            ? "No connection. Is the helper (spotifyremote-radio) running?"
            : "Could not load this from Spotify: " + err.message

          function resetLibrary() {
            scope.home = { loading: false, loadedAt: 0, quick: [], sections: [], needsReconnect: missingScopes(), error: "" }
            scope.page = null
            pageHistory = []
          }

          scope.linked = isLinked

          scope.greeting = function () {
            const h = new Date().getHours()
            return h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 18 ? "Good afternoon" : "Good evening"
          }

          scope.toggleHome = function () {
            scope.expanded = !scope.expanded
            if (scope.expanded) {
              scope.view = "player"
              loadHome()
            }
          }

          function loadHome(force) {
            if (homeLoad || !isLinked()) return homeLoad
            const home = scope.home
            if (!force && home.loadedAt && Date.now() - home.loadedAt < HOME_MAX_AGE_MS) return null
            home.loading = true
            homeLoad = buildHome(home)
              .catch(err => { home.error = loadError(err) })
              .finally(() => {
                homeLoad = null
                home.loading = false
                apply()
              })
            apply()
            return homeLoad
          }

          async function buildHome(home) {
            const get = path => api("GET", path).then(data => ({ data }), err => ({ err }))
            const results = await Promise.all([
              get("/me/player/recently-played?limit=50"),
              get("/me/playlists?limit=50"),
              get("/me/top/tracks?limit=20&time_range=short_term"),
              get("/me/top/artists?limit=20&time_range=medium_term"),
              get("/me/albums?limit=20"),
            ])
            const [recent, lists, topTracks, topArtists, albums] = results
            const failed = results.filter(r => r.err)
            home.needsReconnect = missingScopes() || failed.some(r => isScopeError(r.err))
            if (failed.length === results.length) {
              if (home.needsReconnect) return
              throw failed[0].err
            }
            const items = r => (r.data && r.data.items) || []

            const playlists = items(lists).map(playlistCard)
            const recentItems = items(recent)
            const recentTracks = uniqueBy(recentItems.map(i => trackOf(i && i.track)), "uri")
            const contexts = await recentContexts(recentItems, playlists)

            home.quick = uniqueBy([likedCard()].concat(contexts, playlists), "uri").slice(0, 8)
            home.sections = [
              section("Recently played", contexts),
              section("Your top songs", items(topTracks).map(trackOf)),
              section("Recently played songs", recentTracks.slice(0, 20)),
              section("Your playlists", playlists),
              section("Your top artists", items(topArtists).map(artistCard)),
              section("Saved albums", items(albums).map(i => albumCard(i && i.album))),
            ].filter(s => s.items.length)
            home.loadedAt = Date.now()
            home.error = ""
          }

          // playlists, albums and artists you listened to recently, newest first
          async function recentContexts(items, playlists) {
            const seen = {}
            const picked = []
            for (const it of items) {
              const ctx = it && it.context
              if (!ctx || !ctx.uri || seen[ctx.uri]) continue
              seen[ctx.uri] = true
              picked.push({ ctx, track: it.track })
              if (picked.length >= 10) break
            }
            const cards = await Promise.all(picked.map(async function ({ ctx, track }) {
              const id = ctx.uri.split(":").pop()
              try {
                if (ctx.type === "collection" || /:collection$/.test(ctx.uri)) return likedCard()
                if (ctx.type === "album" && track && track.album && track.album.uri === ctx.uri) return albumCard(track.album)
                if (ctx.type === "album") return albumCard(await api("GET", "/albums/" + id))
                if (ctx.type === "playlist") {
                  return playlists.find(p => p && p.uri === ctx.uri) ||
                    playlistCard(await api("GET", "/playlists/" + id + "?fields=id,uri,name,images,owner(display_name)"))
                }
                if (ctx.type === "artist") return artistCard(await api("GET", "/artists/" + id))
              } catch (err) {
                // not available (for example a Spotify-made playlist): just leave it out
              }
              return null
            }))
            return uniqueBy(cards, "uri")
          }

          // --- pages: playlist, album, artist, liked songs, search ---

          // While big, the app moves to <body>: in its own slot it sits below BeamNG's invisible full
          // screen layer, which would swallow every click outside the app's normal box.
          const root = element && element[0]
          let portal = null
          const isBig = () => !!(scope.expanded && !scope.state.minimized && scope.state.visible)
          function placeRoot(big) {
            if (!root) return
            if (big && !portal && root.parentNode) {
              portal = { parent: root.parentNode, next: root.nextSibling }
              document.body.appendChild(root)
            } else if (!big && portal) {
              const next = portal.next && portal.next.parentNode === portal.parent ? portal.next : null
              portal.parent.insertBefore(root, next)
              portal = null
            }
          }
          if (scope.$watch) scope.$watch(isBig, placeRoot)

          // close the big view when a menu opens or the game hides the apps, so it never covers them
          const closeBig = function () {
            if (!scope.expanded) return
            scope.expanded = false
            apply()
          }
          scope.$on("SpotifyRemoteUiState", (event, toState) => { if (toState !== "play") closeBig() })
          scope.$on("ShowApps", (event, shown) => { if (shown === false) closeBig() })

          function scrollToTop() {
            setTimeout(function () {
              const el = root && root.querySelector(".sprdx-scroll")
              if (el) el.scrollTop = 0
            }, 0)
          }

          function showPage(page) {
            if (scope.page) pageHistory.push(scope.page)
            scope.page = page
            scrollToTop()
            apply()
          }

          scope.goBack = function () {
            scope.page = pageHistory.pop() || null
            if (!scope.page) loadHome()
            scrollToTop()
          }

          scope.goHome = function () {
            pageHistory = []
            scope.page = null
            scope.search.q = ""
            loadHome()
            scrollToTop()
          }

          const KINDS = { playlist: "Playlist", album: "Album", artist: "Artist", liked: "Playlist" }

          scope.openCard = function (card, list) {
            if (card.type === "track") return scope.playCard(card, list)
            const page = {
              type: card.type, card, kind: KINDS[card.type], name: card.name, sub: card.sub, imageUrl: card.imageUrl,
              uri: card.type === "liked" ? null : card.uri, tracks: [], sections: [], offset: 0, more: false, loading: false, note: "",
            }
            showPage(page)
            loadPage(page)
          }

          scope.loadMore = () => scope.page && loadPage(scope.page)

          async function loadPage(page) {
            page.loading = true
            apply()
            try {
              if (page.type === "playlist") {
                const data = await api("GET", "/playlists/" + page.card.id + "/items?limit=100&offset=" + page.offset)
                addTracks(page, data, i => i && (i.item || i.track))
                page.sub = [page.card.owner, data && data.total ? data.total + " songs" : ""].filter(Boolean).join(" · ")
                if (!page.tracks.length && !page.more) page.note = "This playlist has no songs that can be played here."
              } else if (page.type === "liked") {
                const data = await api("GET", "/me/tracks?limit=50&offset=" + page.offset)
                addTracks(page, data, i => i && i.track)
                page.sub = ((data && data.total) || 0) + " songs"
              } else if (page.type === "album") {
                const album = await api("GET", "/albums/" + page.card.id)
                const tracks = (album.tracks && album.tracks.items) || []
                page.tracks = tracks.map(t => trackOf(Object.assign({ album: { name: album.name, images: album.images } }, t))).filter(Boolean)
                page.imageUrl = pickImage(album.images) || page.imageUrl
                page.sub = [names(album.artists), (album.release_date || "").slice(0, 4), tracks.length + " songs"].filter(Boolean).join(" · ")
              } else if (page.type === "artist") {
                const data = await api("GET", "/artists/" + page.card.id + "/albums?include_groups=album,single&limit=20")
                page.sections = [section("Albums and singles", ((data && data.items) || []).map(albumCard))]
              }
            } catch (err) {
              page.note = page.type === "playlist" && (err.status === 403 || err.status === 404)
                ? "Spotify only lists the songs of playlists you own or follow as a collaborator. You can still play it."
                : loadError(err)
            } finally {
              page.loading = false
              apply()
            }
          }

          function addTracks(page, data, pick) {
            const items = (data && data.items) || []
            page.tracks = page.tracks.concat(items.map(i => trackOf(pick(i))).filter(Boolean))
            page.offset += items.length
            page.more = !!(data && data.next)
          }

          scope.searchChanged = function () {
            clearTimeout(searchTimer)
            searchTimer = setTimeout(scope.runSearch, 450)
          }

          scope.runSearch = async function () {
            clearTimeout(searchTimer)
            const q = (scope.search.q || "").trim()
            let page = scope.page && scope.page.type === "search" ? scope.page : null
            if (!q) {
              if (page) scope.goBack()
              apply()
              return
            }
            if (page && page.q === q) return
            if (!page) {
              page = { type: "search", kind: "Search", tracks: [], sections: [], loading: false, note: "" }
              showPage(page)
            }
            page.q = q
            page.loading = true
            apply()
            try {
              const data = await api("GET", "/search?type=track,artist,album,playlist&limit=10&q=" + encodeURIComponent(q))
              if (page.q !== q) return
              const found = type => (data && data[type] && data[type].items) || []
              page.tracks = found("tracks").map(trackOf).filter(Boolean)
              page.sections = [
                section("Artists", found("artists").map(artistCard)),
                section("Albums", found("albums").map(albumCard)),
                section("Playlists", found("playlists").map(playlistCard)),
              ].filter(s => s.items.length)
              page.note = page.tracks.length || page.sections.length ? "" : "Nothing found for “" + q + "”."
            } catch (err) {
              if (page.q === q) page.note = loadError(err)
            } finally {
              if (page.q === q) page.loading = false
              apply()
            }
          }

          // --- starting playback ---

          async function play(body) {
            try {
              await api("PUT", "/me/player/play", { body })
            } catch (err) {
              if (err.status !== 404) throw err
              // no active device: wake up the Spotify app on this PC
              const data = await api("GET", "/me/player/devices")
              const devices = (data && data.devices) || []
              const device = devices.find(d => d.is_active) || devices.find(d => d.type === "Computer") || devices[0]
              if (!device) throw err
              await api("PUT", "/me/player/play?device_id=" + encodeURIComponent(device.id), { body })
            }
          }

          async function startPlayback(body) {
            if (!isLinked()) return
            try {
              await play(body)
              pollIn = 0
              setTimeout(refreshPlayer, 500)
            } catch (err) {
              if (isLinked()) showMessage(describeError(err))
            }
          }

          function playTracks(tracks, index) {
            const playable = tracks.filter(t => t && t.type === "track")
            const at = Math.max(0, playable.indexOf(tracks[index]))
            const start = Math.max(0, at - 20)
            const uris = playable.slice(start, start + 100).map(t => t.uri)
            if (uris.length) startPlayback({ uris, offset: { position: at - start } })
          }

          async function playLiked() {
            try {
              const data = await api("GET", "/me/tracks?limit=50")
              playTracks(((data && data.items) || []).map(i => trackOf(i && i.track)).filter(Boolean), 0)
            } catch (err) {
              showMessage(loadError(err))
            }
          }

          scope.playCard = function (card, list) {
            if (card.type === "track") playTracks(list, list.indexOf(card))
            else if (card.type === "liked") playLiked()
            else startPlayback({ context_uri: card.uri })
          }

          scope.playPage = function () {
            const page = scope.page
            if (!page) return
            if (page.type === "liked") return page.tracks.length ? playTracks(page.tracks, 0) : playLiked()
            if (page.uri) startPlayback({ context_uri: page.uri })
          }

          scope.playTrackOnPage = function (index) {
            const page = scope.page
            const t = page && page.tracks[index]
            if (!t) return
            if (page.uri && (page.type === "playlist" || page.type === "album")) startPlayback({ context_uri: page.uri, offset: { uri: t.uri } })
            else playTracks(page.tracks, index)
          }

          scope.isCurrent = t => !!(scope.track && t && scope.track.uri === t.uri)

          resetLibrary()

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
            grantedScopes = null
            scope.track = null
            scope.expanded = false
            resetLibrary()
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
            if (minimized) scope.expanded = false
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
              // the new login may have granted the library permissions
              scope.home.loadedAt = 0
              if (scope.expanded) loadHome(true)
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
              grantedScopes = null
              scope.track = null
              scope.expanded = false
              if (wasLinked) resetLibrary()
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
            clearTimeout(searchTimer)
            if (portal && root) root.remove()
          })

          lua("if spotifyRemote_main then spotifyRemote_main.requestState() end")
        },
      }
    },
  ])
})()
