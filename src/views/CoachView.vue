<script setup>
// Coach dashboard. Lists every diver the logged-in coach is
// linked to via the coach_diver_links table. Each diver tile
// links into the existing /profile/:id view, which already
// renders PB tables, score trends, etc.
//
// Org admins manage the actual links from the User Manager —
// this view is read-only for the coach themselves.

import { ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const divers = ref([])
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await auth.apiFetch('/api/coach/divers')
    divers.value = Array.isArray(data) ? data : []
  } catch (err) {
    error.value = err.message
    divers.value = []
  } finally {
    loading.value = false
  }
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

onMounted(load)
</script>

<template>
  <div class="coach-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Coach Dashboard</div>
        <h1 class="page-title">My Divers</h1>
        <div class="page-sub">
          Click any diver to see their profile, personal bests, and score trend.
          Ask your org admin to add or remove links from the User Manager.
        </div>
      </div>
      <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
    </div>

    <div v-if="loading" class="empty">Loading your divers…</div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>
    <div v-else-if="!divers.length" class="empty">
      No divers linked to your account yet.
      <br>
      <span style="font-size:11px">Ask your org admin to link your divers from the User Manager.</span>
    </div>

    <div v-else class="diver-grid">
      <RouterLink
        v-for="d in divers"
        :key="d.id"
        :to="`/profile/${d.id}`"
        class="diver-card"
      >
        <div class="diver-card-head">
          <span class="diver-card-name">{{ d.full_name }}</span>
          <span v-if="d.country_code" class="diver-card-ctry">{{ d.country_code }}</span>
        </div>
        <div v-if="d.club_name" class="diver-card-club">
          {{ d.club_name }}<span v-if="d.club_code" class="diver-card-code">{{ d.club_code }}</span>
        </div>
        <div v-if="d.note" class="diver-card-note">{{ d.note }}</div>
        <div class="diver-card-foot">
          <span>Linked {{ fmtDate(d.linked_at) }}</span>
          <span class="diver-card-cta">View profile →</span>
        </div>
      </RouterLink>
    </div>

    <div v-if="divers.length" class="actions-row">
      <RouterLink to="/compare" class="btn btn-ghost btn-sm">
        Compare two divers head-to-head →
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.coach-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-title { font-family: var(--font-display); font-size: 36px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.page-sub   { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; max-width: 600px; line-height: 1.6; }

.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

.diver-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.875rem;
}
.diver-card {
  display: flex; flex-direction: column; gap: 0.5rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.1rem 1.25rem;
  text-decoration: none; color: inherit;
  transition: all 0.15s; min-width: 0;
}
.diver-card:hover {
  border-color: var(--cyan); background: rgba(6,182,212,0.04);
  transform: translateY(-1px);
}

.diver-card-head { display: flex; align-items: baseline; gap: 0.5rem; }
.diver-card-name {
  font-family: var(--font-display); font-size: 18px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.1;
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.diver-card-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.4rem;
}

.diver-card-club {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.diver-card-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.05rem 0.3rem; margin-left: 0.4rem;
}
.diver-card-note { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); font-style: italic; }
.diver-card-foot {
  display: flex; align-items: center; justify-content: space-between;
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  margin-top: 0.25rem;
}
.diver-card-cta {
  font-family: var(--font-display); font-weight: 700;
  letter-spacing: 0.15em; color: var(--cyan); text-transform: uppercase;
}

.actions-row {
  display: flex; justify-content: center; margin-top: 1.5rem;
}

@media (max-width: 720px) {
  .coach-wrap { padding: 1rem; }
  .diver-grid { grid-template-columns: 1fr; }
}
</style>
