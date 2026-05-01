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
//   key   : the request URL string
//   value : { data, ts }   ts is Date.now() at write time
//
// 50 lines of plain DOM API — no dependency. Modern browsers
// have had stable IndexedDB support for a decade; the only
// branch is "indexedDB undefined" → fall back to no-cache.

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
  const cached = await idbGet(url)
  let returned = false
  let returnValue

  // Kick off the network revalidation regardless. If we have a
  // cache entry, return it now and let the network update on the
  // side; if not, await the network.
  const network = (async () => {
    try {
      const r = await fetch(url, fetchOptions)
      if (!r.ok) return null
      const body = await r.json()
      idbSet(url, body)            // fire and forget
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
