// Offline support: app code is network-first (deploys show up immediately), heavy static assets
// (Stockfish, data, textures, pieces, fonts) are cache-first. VERSION is stamped by the build.
const VERSION = "__BUILD_HASH__";
const CACHE = "chess3d-" + VERSION;
const SHELL = ["./", "./index.html", "./app.css", "./game.js", "./manifest.webmanifest", "./assets/favicon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith("chess3d-") && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const isCode = (url) => /\/(index\.html|app\.css|game\.js|manifest\.webmanifest)?$/.test(url.pathname) || url.pathname.endsWith("/");

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  const fonts = url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com";
  if (!sameOrigin && !fonts) return;

  if (sameOrigin && isCode(url)) {
    // network-first, falling back to the cached shell when offline
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match("./index.html"))));
    return;
  }
  // cache-first for everything else we serve (and Google Fonts)
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok || res.type === "opaque") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
    return res;
  })));
});
