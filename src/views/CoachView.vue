<script setup>
// Coach dashboard. Lists every diver the logged-in coach is
// linked to via coach_diver_links. For divers with a Live or
// Upcoming event, the card shows their NEXT dive (round + code +
// DD) and current rank in the standings — so a coach with 8
// divers across 3 events can see at a glance who's where.
//
// Data comes from /api/coach/dashboard, which joins
// coach_diver_links → competitor_dive_lists → events → standings
// in a single rollup. See server.js [SECTION: ROUTES — COACH].

import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { diveDescription } from '@/composables/useDiveLabel'

const auth = useAuthStore()
const rows = ref([])
const loading = ref(false)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await auth.apiFetch('/api/coach/dashboard')
    rows.value = Array.isArray(data) ? data : []
  } catch (err) {
    error.value = err.message
    rows.value = []
  } finally {
    loading.value = false
  }
}

function fmtRank(n) {
  if (n == null) return ''
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
function placeColor(n) {
  if (n === 1) return 'place-gold'
  if (n === 2) return 'place-silver'
  if (n === 3) return 'place-bronze'
  return ''
}

// Group rows by event status: live first (most useful), then
// upcoming, then divers without an active event.
const grouped = computed(() => {
  const live = [], upcoming = [], idle = []
  for (const r of rows.value) {
    if (r.event_status === 'Live')          live.push(r)
    else if (r.event_status === 'Upcoming') upcoming.push(r)
    else                                     idle.push(r)
  }
  return { live, upcoming, idle }
})

onMounted(load)
</script>

<template>
  <div class="coach-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Coach Dashboard</div>
        <h1 class="page-title">My Divers</h1>
        <div class="page-sub">
          For each linked diver: their next dive, current rank, and a one-click link
          to their full profile. Ask your org admin to add or remove links from the
          User Manager.
        </div>
      </div>
      <div class="header-actions">
        <button class="btn btn-ghost btn-sm" @click="load" :disabled="loading">
          {{ loading ? '↻ Refreshing' : '↻ Refresh' }}
        </button>
        <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
      </div>
    </div>

    <div v-if="loading && !rows.length" class="empty">Loading your divers…</div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>
    <div v-else-if="!rows.length" class="empty-state-card">
      <div class="empty-state-icon">🤝</div>
      <div class="empty-state-title">No divers linked yet</div>
      <div class="empty-state-body">
        Once your org admin links you to the divers you coach, their
        events, results, and analytics will appear here. Ask your
        federation's admin to open <strong>User Manager → your row →
        Coach Links</strong> and add the divers you mentor.
      </div>
    </div>

    <template v-else>
      <!-- LIVE — biggest cards, brightest accent -->
      <section v-if="grouped.live.length" class="diver-section">
        <div class="section-head">
          <span class="section-label">🔴 Diving Now</span>
          <span class="section-count">{{ grouped.live.length }}</span>
        </div>
        <div class="diver-grid">
          <RouterLink v-for="r in grouped.live"
                      :key="r.diver_id + r.event_id"
                      :to="`/profile/${r.diver_id}`"
                      class="diver-card live-card">
            <div class="diver-card-head">
              <span class="diver-card-name">{{ r.full_name }}</span>
              <span v-if="r.country_code" class="diver-card-ctry">{{ r.country_code }}</span>
              <span v-if="r.current_rank" :class="['diver-card-rank', placeColor(r.current_rank)]">
                {{ fmtRank(r.current_rank) }}<span class="dim"> / {{ r.field_size }}</span>
              </span>
            </div>
            <div v-if="r.club_name" class="diver-card-club">
              {{ r.club_name }}<span v-if="r.club_code" class="diver-card-code">{{ r.club_code }}</span>
            </div>
            <div class="diver-card-event">
              <span class="event-name">{{ r.event_name }}</span>
              <span v-if="r.event_type === 'synchro_pair'" class="event-type">SYNCHRO</span>
              <span v-else-if="r.event_type === 'team'" class="event-type">TEAM</span>
            </div>
            <div class="diver-card-next">
              <span class="next-label">Next</span>
              <span class="next-round">R{{ r.round_number }}</span>
              <span class="next-code">{{ r.dive_code }}{{ r.position }}</span>
              <span class="next-dd">DD {{ Number(r.dd).toFixed(1) }}</span>
            </div>
            <div v-if="r.description" class="diver-card-desc">{{ diveDescription(r) }}</div>
            <div class="diver-card-foot">
              <span v-if="r.current_total != null">Running {{ Number(r.current_total).toFixed(1) }}</span>
              <span class="diver-card-cta">View profile →</span>
            </div>
          </RouterLink>
        </div>
      </section>

      <!-- UPCOMING — same shape, dimmer accent -->
      <section v-if="grouped.upcoming.length" class="diver-section">
        <div class="section-head">
          <span class="section-label">📅 Upcoming</span>
          <span class="section-count">{{ grouped.upcoming.length }}</span>
        </div>
        <div class="diver-grid">
          <RouterLink v-for="r in grouped.upcoming"
                      :key="r.diver_id + r.event_id"
                      :to="`/profile/${r.diver_id}`"
                      class="diver-card upcoming-card">
            <div class="diver-card-head">
              <span class="diver-card-name">{{ r.full_name }}</span>
              <span v-if="r.country_code" class="diver-card-ctry">{{ r.country_code }}</span>
            </div>
            <div v-if="r.club_name" class="diver-card-club">
              {{ r.club_name }}<span v-if="r.club_code" class="diver-card-code">{{ r.club_code }}</span>
            </div>
            <div class="diver-card-event">
              <span class="event-name">{{ r.event_name }}</span>
            </div>
            <div class="diver-card-next">
              <span class="next-label">Round 1</span>
              <span class="next-code">{{ r.dive_code }}{{ r.position }}</span>
              <span class="next-dd">DD {{ Number(r.dd).toFixed(1) }}</span>
            </div>
            <div class="diver-card-foot">
              <span class="diver-card-cta">View profile →</span>
            </div>
          </RouterLink>
        </div>
      </section>

      <!-- IDLE — divers with no active event -->
      <section v-if="grouped.idle.length" class="diver-section">
        <div class="section-head">
          <span class="section-label">💤 No active event</span>
          <span class="section-count">{{ grouped.idle.length }}</span>
        </div>
        <div class="diver-grid">
          <RouterLink v-for="r in grouped.idle"
                      :key="r.diver_id"
                      :to="`/profile/${r.diver_id}`"
                      class="diver-card idle-card">
            <div class="diver-card-head">
              <span class="diver-card-name">{{ r.full_name }}</span>
              <span v-if="r.country_code" class="diver-card-ctry">{{ r.country_code }}</span>
            </div>
            <div v-if="r.club_name" class="diver-card-club">
              {{ r.club_name }}<span v-if="r.club_code" class="diver-card-code">{{ r.club_code }}</span>
            </div>
            <div v-if="r.note" class="diver-card-note">{{ r.note }}</div>
            <div class="diver-card-foot">
              <span class="diver-card-cta">View profile →</span>
            </div>
          </RouterLink>
        </div>
      </section>

      <div class="actions-row">
        <RouterLink to="/compare" class="btn btn-ghost btn-sm">
          Compare two divers head-to-head →
        </RouterLink>
      </div>
    </template>
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
.header-actions { display: flex; gap: 0.5rem; align-items: center; }

.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

.diver-section { margin-bottom: 2rem; }
.section-head {
  display: flex; align-items: center; gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.section-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--text-2);
}
.section-count {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.4rem;
}

.diver-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.875rem;
}
.diver-card {
  display: flex; flex-direction: column; gap: 0.45rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1rem 1.1rem;
  text-decoration: none; color: inherit;
  transition: all 0.15s; min-width: 0;
}
.diver-card:hover {
  border-color: var(--cyan); background: rgba(6,182,212,0.04);
  transform: translateY(-1px);
}
.diver-card.live-card {
  border-color: rgba(6,182,212,0.4);
  background: rgba(6,182,212,0.05);
  box-shadow: 0 4px 12px rgba(6,182,212,0.08);
}
.diver-card.upcoming-card {
  background: var(--surface);
}
.diver-card.idle-card {
  opacity: 0.85;
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
.diver-card-rank {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--text); padding: 0.1rem 0.4rem;
  border: 1px solid var(--border); border-radius: 3px;
  background: var(--bg-3);
}
.diver-card-rank.place-gold   { color: #f59e0b; border-color: rgba(234,179,8,0.4);   background: rgba(234,179,8,0.06); }
.diver-card-rank.place-silver { color: #94a3b8; border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.diver-card-rank.place-bronze { color: #b45309; border-color: rgba(180,83,9,0.4);    background: rgba(180,83,9,0.06); }
.diver-card-rank .dim { color: var(--text-3); font-weight: 400; }

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
.diver-card-event {
  display: flex; align-items: baseline; gap: 0.4rem;
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text); padding-top: 0.2rem;
  border-top: 1px solid var(--border);
}
.event-name {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.event-type {
  font-family: var(--font-display); font-size: 8px; font-weight: 900;
  letter-spacing: 0.18em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.4);
  border-radius: 3px; padding: 0.1rem 0.4rem;
}
.diver-card-next {
  display: flex; align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 12px;
  padding: 0.4rem 0.5rem;
  background: var(--bg-3); border-radius: var(--radius-sm);
}
.next-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
}
.next-round {
  font-family: var(--font-mono); font-size: 11px; color: var(--cyan);
  font-weight: 700;
}
.next-code { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--text); }
.next-dd   { font-family: var(--font-mono); font-size: 11px; color: var(--cyan); margin-left: auto; }

.diver-card-desc {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  font-style: italic; line-height: 1.4;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
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
