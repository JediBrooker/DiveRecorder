// Tiny in-memory cache for /api/scoreboard/:eventId payloads.
//
// Live meets see 5–20 connected scoreboards, all rendering off
// the same query (standings + history + up-next). Without a
// cache, a single score submission triggers re-fetches from
// every viewer in parallel — and the standings query joins
// across scores, event_judges, competitor_dive_lists,
// dive_directory, users, clubs, organisations and runs the
// trim-and-multiply UDF per dive. ~150ms × N viewers per
// score event chews through pool slots fast.
//
// Strategy: cache the rendered payload per eventId with a
// short TTL (default 5s) AND expose explicit invalidate() so
// the socket layer can flush the bucket the moment a new score
// commits. That gives us:
//   * Hot path: cache hit, ~1ms response
//   * After a score: the score handler invalidates → next
//     /api/scoreboard call rebuilds and re-caches
//   * Failsafe: TTL expires even if the invalidation hook is
//     ever dropped, so staleness is bounded
//
// IMPORTANT: this is a single-process design (matches the
// activeDivers / meetHolds invariant in lib/live-state.js).
// Clustering would split-brain the cache; either move to Redis
// or stay single-instance.

const DEFAULT_TTL_MS = 5_000;

module.exports = function createScoreboardCache({ ttlMs = DEFAULT_TTL_MS } = {}) {
  // eventId → { payload, expiresAt }
  const store = new Map();

  function get(eventId) {
    if (!eventId) return null;
    const hit = store.get(eventId);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      store.delete(eventId);
      return null;
    }
    return hit.payload;
  }

  function set(eventId, payload) {
    if (!eventId || payload == null) return;
    store.set(eventId, { payload, expiresAt: Date.now() + ttlMs });
  }

  function invalidate(eventId) {
    if (!eventId) return;
    store.delete(eventId);
  }

  // Periodic sweep so events that go quiet (last score 10 minutes
  // ago, no more reads) don't pin their payload forever. ~half
  // the TTL is plenty of resolution.
  setInterval(() => {
    const now = Date.now();
    for (const [eventId, entry] of store.entries()) {
      if (entry.expiresAt <= now) store.delete(eventId);
    }
  }, Math.max(ttlMs / 2, 1000)).unref?.();

  // For diagnostics: how many events are cached right now.
  function size() { return store.size; }

  return { get, set, invalidate, size };
};
