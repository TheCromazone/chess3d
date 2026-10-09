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
  // live data (the social API, game rooms) always goes to the network
  if (sameOrigin && /\/(api|ws)\//.test(url.pathname)) return;

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

// ---- notifications when the app is closed (web push) ----
// A push carries no data: the worker asks the social API what's new, with the key the page left
// in a small cache, and shows the newest thing. A click opens the right screen.
const AUTH = "c3d-auth";
self.addEventListener("push", (e) => { e.waitUntil(showLatest()); });

async function showLatest() {
  let note = { title: "Chess 3D", body: "You have something new.", url: "./#/social", tag: "c3d" };
  try {
    const hit = await (await caches.open(AUTH)).match(new URL("__social", self.registration.scope).href);
    const auth = hit && await hit.json();
    if (auth) {
      const res = await fetch(auth.api + "/notes", { headers: { Authorization: "Bearer " + auth.secret }, cache: "no-store" });
      const d = await res.json();
      const items = [];
      for (const m of d.messages || []) {
        let c = {};
        if (m.kind === "challenge") { try { c = JSON.parse(m.body); } catch { /* plain */ } }
        items.push(m.kind === "challenge"
          ? { at: m.created, title: `${m.sender_name} challenges you`, body: c.mode === "daily" ? "To a daily game" : `To a ${c.tc} game`, url: "./#/social/chat/" + m.sender, tag: "msg-" + m.sender }
          : { at: m.created, title: m.sender_name, body: m.body, url: "./#/social/chat/" + m.sender, tag: "msg-" + m.sender });
      }
      if (d.request) items.push({ at: d.request.created, title: "Friend request", body: `${d.request.name} wants to be your friend`, url: "./#/social/friends", tag: "request" });
      for (const n of d.notes || []) {
        let b = {};
        try { b = JSON.parse(n.body); } catch { /* skip */ }
        items.push({ at: n.created, title: `Your move vs ${b.from || "your opponent"}`, body: b.san ? `They played ${b.san}.` : "In your daily game", url: "./#/daily", tag: "move-" + b.room });
      }
      items.sort((a, b) => b.at - a.at);
      if (items[0]) note = items[0];
    }
  } catch { /* fall back to the generic notice */ }
  return self.registration.showNotification(note.title, { body: note.body, tag: note.tag, icon: "./assets/favicon.png", data: { url: note.url } });
}

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    for (const c of list) if (c.url.startsWith(self.registration.scope) && "focus" in c) { c.navigate(url); return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
