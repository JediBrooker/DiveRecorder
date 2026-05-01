/* Dive Recorder service worker.
 *
 * Goal: a minimal offline shell so a judge's phone keeps the app
 * UI rendering when poolside wifi drops mid-meet. The actual
 * /api/* and /socket.io/* paths are NEVER served from cache —
 * those need to round-trip to the server, and a cached score
 * submission is worse than no submission.
 *
 * Strategy:
 *   - Navigation (the HTML shell): NETWORK-FIRST. We always try
 *     the live server, and only fall back to cached /index.html
 *     if the network actually fails. This means a fresh deploy
 *     reaches users immediately rather than being shadowed by
 *     a stale cache entry that points at vanished asset hashes.
 *   - Static SPA assets (/assets/*, /css/*, /icon.svg,
 *     /manifest.webmanifest, etc.): CACHE-FIRST. Asset URLs are
 *     content-hashed, so it's safe to keep them around — once
 *     the new index.html lands, it asks for new hashes that the
 *     SW just hasn't seen yet (they go through to network and
 *     get cached on the way back).
 *   - Anything else (API, sockets, PDFs): NETWORK ONLY.
 *
 * The cache name is versioned; bumping CACHE drops every prior
 * cached asset on activate. v3 = navigation switched from
 * cache-first to network-first to fix the "white page after
 * deploy" issue.
 */

const CACHE = "diverecorder-shell-v3";
const SHELL = [
  "/",
  "/index.html",
  "/icon.svg",
  "/icon-192.png",
  "/icon-512.png",
  "/manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only — don't intercept third-party fonts, etc.
  if (url.origin !== self.location.origin) return;

  // Skip API + sockets entirely. These must never be cached.
  if (url.pathname.startsWith("/api/")) return;
  if (url.pathname.startsWith("/socket.io/")) return;

  // SPA navigation — NETWORK-FIRST. Critical for deploy hygiene:
  // a freshly-deployed index.html reaches users immediately
  // rather than being shadowed by a stale cache entry pointing
  // at vanished asset hashes. We update the cache copy in the
  // background so a future offline visit still has *something*
  // to serve.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put("/index.html", clone)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match("/index.html").then((cached) => cached || Response.error())),
    );
    return;
  }

  // Everything else (assets, css, manifest, icon): cache-first.
  // Asset URLs are content-hashed so it's safe to keep stale
  // ones around — they're never asked for again once the new
  // index.html lands.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        if (res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
