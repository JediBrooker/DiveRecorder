import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { idbClear } from '@/lib/idbCache'

const TOKEN_KEY = 'olympic_token'

export const useAuthStore = defineStore('auth', () => {
  const token = ref(sessionStorage.getItem(TOKEN_KEY))

  const user = computed(() => {
    if (!token.value) return null
    try { return JSON.parse(atob(token.value.split('.')[1])) }
    catch { return null }
  })

  const isLoggedIn = computed(() => !!token.value && !!user.value)

  function saveSession(data) {
    // Wipe any cached responses owned by the previous identity
    // before swapping in the new token. Even though cache keys are
    // per-user-fingerprint now, an explicit clear keeps disk usage
    // bounded across many sign-in/out cycles on the same device.
    idbClear().catch(() => {})
    token.value = data.token
    sessionStorage.setItem(TOKEN_KEY, data.token)
  }

  function clearSession() {
    token.value = null
    sessionStorage.clear()
    // Belt-and-braces: drop every cached API payload. Without this,
    // the next user on a shared device could be served the previous
    // user's cached profile / dashboard / club lists.
    idbClear().catch(() => {})
  }

  function hasRole(role) {
    if (!user.value) return false
    if (user.value.is_system_admin) return true
    return (user.value.org_roles ?? []).includes(role)
  }

  function hasAnyRole(roles) {
    return roles.some(r => hasRole(r))
  }

  function getHeaders() {
    return {
      'Authorization': `Bearer ${token.value}`,
      'Content-Type': 'application/json',
    }
  }

  async function apiFetch(url, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: { ...getHeaders(), ...(options.headers ?? {}) },
    })
    // 401 = token expired or revoked. Clear the session so the
    // router guard sends the user back to /login, instead of every
    // page just throwing red errors with a stale-but-present token.
    if (res.status === 401) {
      clearSession()
      // Best-effort hash-route redirect. Direct router import would
      // create a circular import in the SPA bundle, so we go through
      // window.location which is fine for a hard "your session ended".
      if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || res.statusText)
    }
    return res.json()
  }

  function formatRoles(roles = []) {
    const LABELS = { org_admin:'Org Admin', meet_manager:'Meet Manager', referee:'Referee', judge:'Judge', diver:'Diver', spectator:'Spectator' }
    return roles.map(r => LABELS[r] ?? r).join(' · ')
  }

  return { token, user, isLoggedIn, saveSession, clearSession, hasRole, hasAnyRole, getHeaders, apiFetch, formatRoles }
})
