/* Dive Recorder service worker.
 *
 * Goal: a minimal offline shell so a judge's phone keeps the app
 * UI rendering when poolside wifi drops mid-meet. The actual
 * /api/* and /socket.io/* paths are NEVER served from cache —
 * those need to round-trip to the server, and a cached score
 * submission is worse than no submission.
 *
 * Strategy:
 *   - Static SPA assets (/, /index.html, /assets/*, /css/*,
 *     /icon.svg, /manifest.webmanifest) → cache-first, falling
 *     back to network on miss.
 *   - Anything else (API, sockets, PDFs, etc.) → network only.
 *   - Navigation requests fall back to a cached /index.html so
 *     refreshing inside a route still boots the SPA shell.
 *
 * The cache name is versioned; bumping CACHE drops every prior
 * cached asset on activate.
 */

const CACHE = "diverecorder-shell-v1";
const SHELL = ["/", "/index.html", "/icon.svg", "/manifest.webmanifest"];

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

  // SPA navigation — cache-first against /index.html so deep
  // links keep working when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      caches.match("/index.html").then(
        (cached) => cached || fetch(request),
      ),
    );
    return;
  }

  // Everything else (assets, css, manifest, icon): cache-first.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((res) => {
        // Tuck successful responses into the cache so a second
        // load is fast / offline-safe.
        if (res.ok && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(request, clone)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
