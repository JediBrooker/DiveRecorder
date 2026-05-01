// useOfflineApi — small composable that caches read-only API
// responses in IndexedDB and serves them via stale-while-
// revalidate. Lets the diver profile, meet list, and other
// read-mostly surfaces work offline (or on a flaky connection
// at a noisy pool deck) and feel instant on a return visit.
//
// Usage:
//   const { data, isStale, age, refresh } = useOfflineApi(
//     '/api/divers/abc/profile'
//   )
//
// `data` is reactive and starts null. The composable:
//   1. Reads the cached entry (instant, may be stale).
//   2. Fires the network request in the background.
//   3. Updates `data` to the fresh value when the network lands.
//   `isStale` is true while we're showing a cached value AND
//   waiting for the network to revalidate; false once the
//   freshest value is in `data`. `age` is the cache age in ms
//   on first paint.
//
// Auth: prepends the auth store's bearer token. Uses pinia
// lazily so the composable is callable from any setup() block.

import { ref, watch, isRef } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { cachedFetch, idbDelete } from '@/lib/idbCache'

export function useOfflineApi(urlOrRef, options = {}) {
  const data = ref(null)
  const isStale = ref(false)
  const age = ref(0)
  const error = ref(null)
  const loading = ref(false)
  const auth = useAuthStore()

  function buildHeaders() {
    const h = { 'Content-Type': 'application/json' }
    if (auth.token) h.Authorization = `Bearer ${auth.token}`
    return h
  }

  async function refresh(force = false) {
    const url = isRef(urlOrRef) ? urlOrRef.value : urlOrRef
    if (!url) return
    loading.value = true
    error.value = null
    try {
      if (force) await idbDelete(url)
      const result = await cachedFetch(
        url,
        { headers: buildHeaders(), credentials: 'same-origin' },
        {
          onUpdate(fresh) {
            data.value = fresh
            isStale.value = false
          },
        },
      )
      if (result.data == null) {
        // Both cache and network failed.
        if (data.value == null) error.value = 'Offline and no cached copy yet'
      } else {
        data.value = result.data
        age.value = result.age
        isStale.value = result.fromCache
      }
    } catch (err) {
      error.value = err.message || 'Fetch failed'
    } finally {
      loading.value = false
    }
  }

  if (options.immediate !== false) refresh()

  if (isRef(urlOrRef)) {
    watch(urlOrRef, () => refresh())
  }

  return { data, isStale, age, error, loading, refresh }
}
