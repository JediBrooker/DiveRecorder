// Tiny IndexedDB wrapper for offline API caching.
//
// Why not the Cache API (used in the service worker)?
//   - SW Cache API is keyed by Request, awkward for headers/auth.
//   - We want to expose entries from the page side too (so the
//     UI can show "stale data — refreshing" while the network
//     call is in flight). IndexedDB works in both contexts.
//
// Schema:
//   db    : 'dive-recorder-cache'
//   store : 'api'
//   key   : <user-fingerprint>:<url>
//   value : { data, ts }   ts is Date.now() at write time
//
// The user-fingerprint prefix matters for security: previously the
// key was just the URL, which meant after user A logged out, user B
// logging in on the same browser would see A's cached responses
// flash up before the network call landed (real PII leak on shared
// poolside devices). Each user now has their own keyspace; logout
// also wipes the store via clearSessionCache().

const DB_NAME = 'dive-recorder-cache'
const STORE   = 'api'
const VERSION = 1

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  if (typeof indexedDB === 'undefined') {
    return Promise.resolve(null)
  }
  dbPromise = new Promise((resolve) => {
    const req = indexedDB.open(DB_NAME, VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror   = () => resolve(null)   // never reject — caller falls back
  })
  return dbPromise
}

export async function idbGet(key) {
  const db = await openDb()
  if (!db) return null
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result || null)
    req.onerror   = () => resolve(null)
  })
}

export async function idbSet(key, data) {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put({ data, ts: Date.now() }, key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => resolve()
  })
}

export async function idbDelete(key) {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).delete(key)
    tx.oncomplete = () => resolve()
    tx.onerror    = () => resolve()
  })
}

// Wipe every cached API response. Call from logout so user B doesn't
// inherit user A's cached payloads on a shared device.
export async function idbClear() {
  const db = await openDb()
  if (!db) return
  return new Promise((resolve) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).clear()
    tx.oncomplete = () => resolve()
    tx.onerror    = () => resolve()
  })
}

// Cheap, deterministic per-user prefix derived from the JWT. We
// don't need a cryptographic mapping — we just need a stable
// fingerprint that changes on logout/login. Slicing the JWT's
// payload segment (the middle dot-separated chunk) gives us that
// without pulling in a crypto dependency. Returns 'anon' when no
// token is present.
function userFingerprint(token) {
  if (!token) return 'anon'
  const parts = String(token).split('.')
  if (parts.length < 2) return 'anon'
  // 24 chars of the payload is more than enough for collision
  // resistance across realistic numbers of users on one device.
  return parts[1].slice(0, 24)
}

function keyFor(token, url) {
  return `${userFingerprint(token)}:${url}`
}

// Stale-while-revalidate fetch helper. Returns:
//   { data, fromCache, age }
// where data is the parsed JSON, fromCache is true when served
// from IDB (with a network revalidation fired in the background),
// and age is the cache entry's age in ms (0 if fresh from network).
//
// onUpdate is called when the background revalidation lands, so
// the caller can swap the displayed data once the network catches
// up. Failures are swallowed — if both cache and network are
// unavailable, returns { data: null }.
export async function cachedFetch(url, fetchOptions = {}, { onUpdate } = {}) {
  // Derive the per-user cache key from the Authorization header so
  // user A's cached responses are invisible to user B. Falls back
  // to 'anon' when there's no auth header (public endpoints).
  const authHeader =
    (fetchOptions.headers && (fetchOptions.headers.Authorization
      || fetchOptions.headers.authorization)) || ''
  const token = String(authHeader).replace(/^Bearer\s+/i, '')
  const key = keyFor(token, url)
  const cached = await idbGet(key)
  let returned = false
  let returnValue

  // Kick off the network revalidation regardless. If we have a
  // cache entry, return it now and let the network update on the
  // side; if not, await the network.
  const network = (async () => {
    try {
      const r = await fetch(url, fetchOptions)
      // Auth failures invalidate the cache — never serve a stale
      // response after the user has lost access.
      if (r.status === 401 || r.status === 403) {
        idbDelete(key)
        return null
      }
      if (!r.ok) return null
      const body = await r.json()
      idbSet(key, body)            // fire and forget
      return body
    } catch {
      return null
    }
  })()

  if (cached) {
    returned = true
    returnValue = { data: cached.data, fromCache: true, age: Date.now() - cached.ts }
    network.then((fresh) => {
      if (fresh && onUpdate) onUpdate(fresh)
    })
  }

  if (!returned) {
    const fresh = await network
    if (fresh) returnValue = { data: fresh, fromCache: false, age: 0 }
    else       returnValue = { data: null,  fromCache: false, age: 0 }
  }

  return returnValue
}
