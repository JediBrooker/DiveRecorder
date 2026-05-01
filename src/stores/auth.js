import { defineStore } from 'pinia'
import { ref, computed } from 'vue'

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
    token.value = data.token
    sessionStorage.setItem(TOKEN_KEY, data.token)
  }

  function clearSession() {
    token.value = null
    sessionStorage.clear()
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
