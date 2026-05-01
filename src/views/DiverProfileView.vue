<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const route = useRoute()
const auth = useAuthStore()

const profile = ref(null)
const loading = ref(false)
const error = ref('')

// :id route param is optional — fall back to the logged-in user.
const targetId = computed(() => route.params.id || auth.user?.id)
const isSelf = computed(() => targetId.value && targetId.value === auth.user?.id)

// Inline club edit state
const editing = ref(false)
const clubs = ref([])
const clubChoice = ref('')           // selected club_id or ''
const savingClub = ref(false)
const saveError = ref('')

const trendChart = computed(() => {
  if (!profile.value?.score_trend?.length) return null
  const points = profile.value.score_trend.map(t => Number(t.total_score))
  const max = Math.max(...points, 1)
  const min = Math.min(...points, 0)
  const range = max - min || 1
  const w = 600
  const h = 120
  const stepX = points.length > 1 ? w / (points.length - 1) : 0
  const coords = points.map((p, i) => {
    const x = i * stepX
    const y = h - ((p - min) / range) * (h - 16) - 8
    return { x, y, value: p }
  })
  const path = coords.map((c, i) => (i === 0 ? `M ${c.x} ${c.y}` : `L ${c.x} ${c.y}`)).join(' ')
  return { path, coords, w, h, max, min }
})

async function load() {
  if (!targetId.value) return
  loading.value = true
  error.value = ''
  try {
    profile.value = await auth.apiFetch(`/api/divers/${targetId.value}/profile`)
  } catch (err) {
    error.value = err.message
    profile.value = null
  } finally {
    loading.value = false
  }
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function placeOrdinal(n) {
  if (n == null) return ''
  const s = ['th','st','nd','rd'], v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

async function openClubEditor() {
  saveError.value = ''
  editing.value = true
  clubChoice.value = profile.value?.diver?.club_id ?? ''
  // Lazy-load clubs only when the editor opens
  try {
    const orgId = profile.value?.diver?.org_id
    if (!orgId) { clubs.value = []; return }
    const r = await fetch(`/api/orgs/${orgId}/clubs`)
    const body = await r.json()
    clubs.value = Array.isArray(body) ? body : []
  } catch {
    clubs.value = []
  }
}

function closeClubEditor() {
  editing.value = false
  saveError.value = ''
}

async function saveClub() {
  savingClub.value = true
  saveError.value = ''
  try {
    await auth.apiFetch(`/api/users/${targetId.value}/club`, {
      method: 'PUT',
      body: JSON.stringify({ club_id: clubChoice.value || null }),
    })
    // Reflect new club in the local profile so the header updates
    if (clubChoice.value) {
      const c = clubs.value.find(c => c.id === clubChoice.value)
      profile.value.diver.club_id   = clubChoice.value
      profile.value.diver.club_name = c?.name ?? null
      profile.value.diver.club_code = c?.short_code ?? null
    } else {
      profile.value.diver.club_id   = null
      profile.value.diver.club_name = null
      profile.value.diver.club_code = null
    }
    editing.value = false
  } catch (err) {
    saveError.value = err.message
  } finally {
    savingClub.value = false
  }
}

function placeColor(n) {
  if (n === 1) return 'place-gold'
  if (n === 2) return 'place-silver'
  if (n === 3) return 'place-bronze'
  return ''
}

onMounted(load)
watch(targetId, load)
</script>

<template>
  <div class="profile-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Diver Profile</div>
        <h1 class="page-title">{{ profile?.diver?.full_name || 'Loading…' }}</h1>
        <div v-if="profile?.diver" class="page-sub">
          {{ profile.diver.org_name }}
          <span v-if="profile.diver.country_code"> · {{ profile.diver.country_code }}</span>
          <span v-if="profile.diver.club_name" class="page-sub-club">
            · {{ profile.diver.club_name }}<span v-if="profile.diver.club_code" class="club-code">{{ profile.diver.club_code }}</span>
          </span>
        </div>
      </div>
      <div style="display:flex;gap:0.5rem;align-items:center">
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="openClubEditor">
          Change Club
        </button>
        <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
      </div>
    </div>

    <div v-if="loading" class="empty">Loading profile…</div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>
    <div v-else-if="profile" class="content">
      <!-- Headline stats -->
      <div class="stats-row">
        <div class="stat">
          <div class="stat-num">{{ profile.stats.total_meets || 0 }}</div>
          <div class="stat-label">Meets Entered</div>
        </div>
        <div class="stat">
          <div class="stat-num">{{ profile.stats.total_dives || 0 }}</div>
          <div class="stat-label">Dives Performed</div>
        </div>
        <div class="stat">
          <div class="stat-num">
            {{ profile.stats.avg_dd != null ? Number(profile.stats.avg_dd).toFixed(2) : '—' }}
          </div>
          <div class="stat-label">Avg DD Attempted</div>
        </div>
        <div class="stat">
          <div class="stat-num">
            {{ profile.stats.best_single_dive != null ? Number(profile.stats.best_single_dive).toFixed(1) : '—' }}
          </div>
          <div class="stat-label">Best Single Dive</div>
        </div>
      </div>

      <!-- Score trend -->
      <div class="card">
        <div class="card-head">Score Trend</div>
        <div v-if="!profile.score_trend?.length" class="empty-mini">No completed meets yet.</div>
        <template v-else>
          <svg
            v-if="trendChart"
            :viewBox="`0 0 ${trendChart.w} ${trendChart.h}`"
            preserveAspectRatio="none"
            class="trend-chart"
          >
            <path :d="trendChart.path" fill="none" stroke="var(--cyan)" stroke-width="2" />
            <circle
              v-for="(c, i) in trendChart.coords"
              :key="i"
              :cx="c.x" :cy="c.y" r="3"
              fill="var(--cyan)"
            >
              <title>{{ profile.score_trend[i].event_name }} — {{ Number(c.value).toFixed(1) }}</title>
            </circle>
          </svg>
          <div class="trend-list">
            <div v-for="t in profile.score_trend" :key="t.event_id" class="trend-row">
              <span class="trend-date">{{ fmtDate(t.created_at) }}</span>
              <span class="trend-name">
                {{ t.event_name }}
                <span v-if="t.event_type === 'synchro_pair'" class="trend-synchro">SYNCHRO</span>
                <span v-else-if="t.event_type === 'team'" class="trend-team-badge">TEAM</span>
                <span v-if="t.partner_name" class="trend-partner">with {{ t.partner_name }}</span>
                <span v-if="t.team_name" class="trend-partner">on {{ t.team_name }}</span>
              </span>
              <span :class="['trend-place', placeColor(t.final_rank)]">{{ placeOrdinal(t.final_rank) }}</span>
              <span class="trend-total">{{ Number(t.total_score).toFixed(2) }}</span>
            </div>
          </div>
        </template>
      </div>

      <!-- Personal bests -->
      <div class="card">
        <div class="card-head">Personal Bests by Dive</div>
        <div v-if="!profile.personal_bests?.length" class="empty-mini">No dives recorded yet.</div>
        <table v-else class="pb-table">
          <thead>
            <tr>
              <th>Dive</th>
              <th>Pos</th>
              <th>Height</th>
              <th>DD</th>
              <th>Best</th>
              <th>Attempts</th>
              <th>At Meet</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="pb in profile.personal_bests" :key="pb.dive_code + pb.position + pb.height">
              <td class="mono strong">{{ pb.dive_code }}</td>
              <td class="mono">{{ pb.position }}</td>
              <td class="mono">{{ pb.height }}m</td>
              <td class="mono cyan">{{ Number(pb.dd).toFixed(1) }}</td>
              <td class="mono strong">{{ Number(pb.best_total).toFixed(1) }}</td>
              <td class="mono dim">{{ pb.attempts }}</td>
              <td class="dim">{{ pb.event_name }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Club edit modal -->
  <div v-if="editing" class="modal-backdrop" @click="closeClubEditor"></div>
  <div v-if="editing" class="modal" @click.stop>
    <div class="modal-head">
      <div class="modal-title">Change Club</div>
      <button class="btn btn-ghost btn-sm" @click="closeClubEditor">Close ✕</button>
    </div>
    <div class="modal-body">
      <div class="field">
        <label class="label">Club ({{ profile?.diver?.org_name || 'your organisation' }})</label>
        <select class="select" v-model="clubChoice">
          <option value="">— No club / independent —</option>
          <option v-for="c in clubs" :key="c.id" :value="c.id">
            {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
          </option>
        </select>
        <p v-if="!clubs.length" class="modal-hint">
          No clubs are registered for your organisation yet. Ask your org admin to create one,
          or <RouterLink to="/users">manage clubs from the User Manager</RouterLink> if you have access.
        </p>
      </div>
      <div v-if="saveError" class="msg msg-error">{{ saveError }}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" @click="closeClubEditor">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="savingClub" @click="saveClub">
          {{ savingClub ? 'Saving…' : 'Save' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.profile-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border);
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-title { font-family: var(--font-display); font-size: 40px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.page-sub { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; }
.page-sub-club { color: var(--text-2); }
.club-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-left: 0.4rem; vertical-align: middle;
}

.content { display: flex; flex-direction: column; gap: 1.5rem; }
.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }
.empty-mini { color: var(--text-3); padding: 1rem 0; font-family: var(--font-mono); font-size: 12px; }

.stats-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1rem;
}
.stat {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.25rem 1.5rem;
}
.stat-num {
  font-family: var(--font-display); font-size: 36px; font-weight: 900; font-style: italic;
  color: var(--cyan); line-height: 1;
}
.stat-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-top: 0.5rem; }

.card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.5rem;
}
.card-head { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3); margin-bottom: 1rem; }

.trend-chart { width: 100%; height: 120px; display: block; margin-bottom: 1rem; }

.trend-list { display: flex; flex-direction: column; }
.trend-row {
  display: grid; grid-template-columns: 110px 1fr auto auto;
  align-items: center; gap: 0.75rem; padding: 0.5rem 0;
  border-top: 1px solid var(--border); font-size: 13px;
}
.trend-row:first-child { border-top: none; }
.trend-date { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.trend-name { font-family: var(--font-display); color: var(--text); font-weight: 500; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.trend-synchro {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.4);
  border-radius: 3px; padding: 0.1rem 0.4rem; margin-left: 0.4rem;
}
.trend-team-badge {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; color: #c4b5fd;
  background: rgba(139,92,246,0.10); border: 1px solid rgba(139,92,246,0.45);
  border-radius: 3px; padding: 0.1rem 0.4rem; margin-left: 0.4rem;
}
.trend-partner { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-left: 0.4rem; }
.trend-place { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 0.1rem 0.4rem; border-radius: 3px; border: 1px solid var(--border); background: var(--bg-2); }
.trend-place.place-gold   { color: #f59e0b; border-color: rgba(234,179,8,0.4); background: rgba(234,179,8,0.06); }
.trend-place.place-silver { color: #94a3b8; border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.trend-place.place-bronze { color: #92400e; border-color: rgba(180,83,9,0.4); background: rgba(180,83,9,0.06); }
.trend-total { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--cyan); }

.pb-table { width: 100%; border-collapse: collapse; }
.pb-table th, .pb-table td {
  padding: 0.55rem 0.5rem; border-bottom: 1px solid var(--border);
  text-align: left; font-size: 13px;
}
.pb-table th {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.pb-table td.mono { font-family: var(--font-mono); }
.pb-table td.strong { color: var(--text); font-weight: 700; }
.pb-table td.cyan { color: var(--cyan); }
.pb-table td.dim { color: var(--text-3); }

/* Club edit modal */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 90;
  background: rgba(3, 7, 18, 0.55);
  backdrop-filter: blur(2px);
}
.modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 100;
  width: min(440px, calc(100vw - 2rem));
  background: var(--surface);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: 0 30px 60px rgba(0, 0, 0, 0.45);
  display: flex; flex-direction: column; overflow: hidden;
}
.modal-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 1.25rem; border-bottom: 1px solid var(--border);
}
.modal-title {
  font-family: var(--font-display); font-size: 18px; font-weight: 900;
  font-style: italic; color: var(--text);
}
.modal-body { padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
.modal-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 0.5rem; }
.modal-hint {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-top: 0.4rem;
}
.modal-hint a { color: var(--cyan); }
</style>
