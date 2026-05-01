<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

// Side-by-side comparison of two divers. Reuses
// /api/divers/:id/profile for each side, so no new backend
// endpoint is needed — the view's value is purely in the layout
// and the diff calculation.

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()

const profileA = ref(null)
const profileB = ref(null)
const loadingA = ref(false)
const loadingB = ref(false)
const errorA = ref('')
const errorB = ref('')

// Org divers for the picker. Logged-in user's own org by default;
// system admins see across all orgs. Reuses the existing endpoint
// the user manager already calls.
const orgDivers = ref([])

const idA = computed(() => route.query.a || '')
const idB = computed(() => route.query.b || '')

async function loadOne(id, side) {
  if (!id) {
    if (side === 'a') { profileA.value = null; errorA.value = '' }
    else              { profileB.value = null; errorB.value = '' }
    return
  }
  const setLoading = (v) => side === 'a' ? loadingA.value = v : loadingB.value = v
  const setError   = (v) => side === 'a' ? errorA.value = v   : errorB.value = v
  setLoading(true)
  setError('')
  try {
    const data = await auth.apiFetch(`/api/divers/${id}/profile`)
    if (side === 'a') profileA.value = data
    else              profileB.value = data
  } catch (err) {
    setError(err.message || 'Failed to load profile')
    if (side === 'a') profileA.value = null
    else              profileB.value = null
  } finally {
    setLoading(false)
  }
}

function pickDiver(side, e) {
  const id = e.target.value
  const params = { ...route.query, [side]: id || undefined }
  if (!id) delete params[side]
  router.replace({ query: params })
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

// Diff helpers — colour the higher value cyan, the other dim.
// Returns 'a' | 'b' | 'tie'.
function winner(a, b) {
  if (a == null && b == null) return 'tie'
  if (a == null) return 'b'
  if (b == null) return 'a'
  const an = Number(a), bn = Number(b)
  if (Number.isNaN(an) && Number.isNaN(bn)) return 'tie'
  if (Number.isNaN(an)) return 'b'
  if (Number.isNaN(bn)) return 'a'
  if (an > bn) return 'a'
  if (bn > an) return 'b'
  return 'tie'
}

const statRows = computed(() => {
  const a = profileA.value?.stats
  const b = profileB.value?.stats
  if (!a && !b) return []
  return [
    { label: 'Meets Entered',     a: a?.total_meets,      b: b?.total_meets,      higherIsBetter: true  },
    { label: 'Dives Performed',   a: a?.total_dives,      b: b?.total_dives,      higherIsBetter: true  },
    { label: 'Avg DD Attempted',  a: a?.avg_dd,           b: b?.avg_dd,           higherIsBetter: true,  fixed: 2 },
    { label: 'Best Single Dive',  a: a?.best_single_dive, b: b?.best_single_dive, higherIsBetter: true,  fixed: 1 },
  ]
})

// Personal-best comparison: for each (dive_code + position +
// height) the union of A's and B's PBs, joined so we can show
// best vs best per dive.
const pbCompare = computed(() => {
  const aMap = new Map()
  const bMap = new Map()
  for (const pb of profileA.value?.personal_bests || []) {
    aMap.set(`${pb.dive_code}|${pb.position}|${pb.height}`, pb)
  }
  for (const pb of profileB.value?.personal_bests || []) {
    bMap.set(`${pb.dive_code}|${pb.position}|${pb.height}`, pb)
  }
  const keys = new Set([...aMap.keys(), ...bMap.keys()])
  return [...keys]
    .map(k => ({ key: k, a: aMap.get(k), b: bMap.get(k) }))
    .sort((x, y) => {
      const xa = x.a || x.b, ya = y.a || y.b
      return (xa.dive_code || '').localeCompare(ya.dive_code || '') || (xa.position || '').localeCompare(ya.position || '')
    })
})

watch(idA, (v) => loadOne(v, 'a'), { immediate: true })
watch(idB, (v) => loadOne(v, 'b'), { immediate: true })

onMounted(async () => {
  // Load divers from the user's org so the picker has options.
  // System admins could pick across orgs but for v1 we keep the
  // picker to just the user's own org — comparing across orgs is
  // a less common case.
  try {
    const orgId = auth.user?.org_id
    if (!orgId) return
    const list = await auth.apiFetch(`/api/orgs/${orgId}/divers`)
    orgDivers.value = Array.isArray(list) ? list : []
  } catch {
    orgDivers.value = []
  }
})
</script>

<template>
  <div class="compare-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Diver Comparison</div>
        <h1 class="page-title">Head-to-Head</h1>
        <div class="page-sub">Pick two divers in your organisation to compare stats and personal bests side by side.</div>
      </div>
      <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
    </div>

    <!-- Pickers -->
    <div class="picker-row">
      <div class="picker-side">
        <div class="picker-label-a">Diver A</div>
        <select class="select" :value="idA" @change="pickDiver('a', $event)">
          <option value="">— Choose a diver —</option>
          <option v-for="d in orgDivers" :key="d.id" :value="d.id">{{ d.full_name }}</option>
        </select>
      </div>
      <div class="picker-vs">VS</div>
      <div class="picker-side">
        <div class="picker-label-b">Diver B</div>
        <select class="select" :value="idB" @change="pickDiver('b', $event)">
          <option value="">— Choose a diver —</option>
          <option v-for="d in orgDivers" :key="d.id" :value="d.id">{{ d.full_name }}</option>
        </select>
      </div>
    </div>

    <!-- Loading / error states -->
    <div v-if="loadingA || loadingB" class="empty">Loading…</div>
    <div v-else-if="!profileA && !profileB" class="empty">
      Pick two divers above to see them head-to-head.
    </div>

    <!-- Comparison body -->
    <template v-else-if="profileA && profileB">
      <!-- Names -->
      <div class="names-row">
        <div class="name-card name-a">
          <div class="name-large">{{ profileA.diver.full_name }}</div>
          <div class="name-meta">
            {{ profileA.diver.org_name }}
            <span v-if="profileA.diver.country_code"> · {{ profileA.diver.country_code }}</span>
            <span v-if="profileA.diver.club_name"> · {{ profileA.diver.club_name }}</span>
          </div>
        </div>
        <div class="name-vs">VS</div>
        <div class="name-card name-b">
          <div class="name-large">{{ profileB.diver.full_name }}</div>
          <div class="name-meta">
            {{ profileB.diver.org_name }}
            <span v-if="profileB.diver.country_code"> · {{ profileB.diver.country_code }}</span>
            <span v-if="profileB.diver.club_name"> · {{ profileB.diver.club_name }}</span>
          </div>
        </div>
      </div>

      <!-- Headline stats -->
      <div class="stat-card">
        <div class="card-head">Headline Stats</div>
        <div v-for="row in statRows" :key="row.label" class="stat-row">
          <div :class="['stat-val', winner(row.a, row.b) === 'a' ? 'higher' : 'lower']">
            {{ row.a == null ? '—' : (row.fixed ? Number(row.a).toFixed(row.fixed) : row.a) }}
          </div>
          <div class="stat-label">{{ row.label }}</div>
          <div :class="['stat-val', winner(row.a, row.b) === 'b' ? 'higher' : 'lower']">
            {{ row.b == null ? '—' : (row.fixed ? Number(row.b).toFixed(row.fixed) : row.b) }}
          </div>
        </div>
      </div>

      <!-- Per-dive PB comparison -->
      <div v-if="pbCompare.length" class="stat-card">
        <div class="card-head">Personal Bests By Dive</div>
        <div class="pb-row pb-head">
          <div class="pb-cell pb-cell-a">Diver A</div>
          <div class="pb-cell pb-mid">Dive</div>
          <div class="pb-cell pb-cell-b">Diver B</div>
        </div>
        <div v-for="row in pbCompare" :key="row.key" class="pb-row">
          <div :class="['pb-cell', 'pb-cell-a', winner(row.a?.best_total, row.b?.best_total) === 'a' ? 'higher' : 'lower']">
            <span v-if="row.a">
              {{ Number(row.a.best_total).toFixed(1) }}
              <span class="pb-attempts">·  {{ row.a.attempts }} attempt{{ row.a.attempts === 1 ? '' : 's' }}</span>
            </span>
            <span v-else class="dim">—</span>
          </div>
          <div class="pb-cell pb-mid">
            <span class="pb-code">{{ (row.a || row.b).dive_code }} {{ (row.a || row.b).position }}</span>
            <span class="pb-height">{{ (row.a || row.b).height }}m</span>
          </div>
          <div :class="['pb-cell', 'pb-cell-b', winner(row.a?.best_total, row.b?.best_total) === 'b' ? 'higher' : 'lower']">
            <span v-if="row.b">
              {{ Number(row.b.best_total).toFixed(1) }}
              <span class="pb-attempts">·  {{ row.b.attempts }} attempt{{ row.b.attempts === 1 ? '' : 's' }}</span>
            </span>
            <span v-else class="dim">—</span>
          </div>
        </div>
      </div>
    </template>

    <!-- One side picked, other not yet -->
    <div v-else-if="profileA && !profileB" class="empty">
      Pick Diver B above to compare.
    </div>
    <div v-else-if="profileB && !profileA" class="empty">
      Pick Diver A above to compare.
    </div>

    <div v-if="errorA" class="msg msg-error">Diver A: {{ errorA }}</div>
    <div v-if="errorB" class="msg msg-error">Diver B: {{ errorB }}</div>
  </div>
</template>

<style scoped>
.compare-wrap { max-width: 1100px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.page-title { font-family: var(--font-display); font-size: 36px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.page-sub   { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; max-width: 600px; }

.picker-row {
  display: grid; grid-template-columns: 1fr auto 1fr;
  gap: 1rem; align-items: end;
  padding: 1rem 1.25rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); margin-bottom: 1.5rem;
}
.picker-side { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.picker-label-a, .picker-label-b {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase;
}
.picker-label-a { color: var(--cyan); }
.picker-label-b { color: var(--green); }
.picker-vs {
  font-family: var(--font-display); font-size: 22px; font-weight: 900;
  font-style: italic; color: var(--text-3); padding-bottom: 0.5rem;
}

.empty { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

.names-row {
  display: grid; grid-template-columns: 1fr auto 1fr;
  gap: 1rem; align-items: center; margin-bottom: 1.25rem;
}
.name-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.25rem 1.5rem;
}
.name-card.name-a { border-color: rgba(6,182,212,0.4);  background: rgba(6,182,212,0.05); }
.name-card.name-b { border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.05); }
.name-large { font-family: var(--font-display); font-size: 28px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1.1; }
.name-meta  { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); margin-top: 0.5rem; }
.name-vs    { font-family: var(--font-display); font-size: 28px; font-weight: 900; font-style: italic; color: var(--text-3); }

.stat-card {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.25rem 1.5rem;
  margin-bottom: 1.25rem;
}
.card-head {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 1rem;
}

.stat-row {
  display: grid; grid-template-columns: 1fr 200px 1fr;
  align-items: center; gap: 1rem; padding: 0.6rem 0;
  border-top: 1px solid var(--border);
}
.stat-row:first-of-type { border-top: none; }
.stat-val {
  font-family: var(--font-display); font-size: 28px; font-weight: 900;
  font-style: italic; line-height: 1; text-align: center;
}
.stat-val.higher { color: var(--cyan); }
.stat-val.lower  { color: var(--text-3); }
.stat-row > .stat-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  text-align: center;
}

.pb-row {
  display: grid; grid-template-columns: 1fr 200px 1fr;
  gap: 1rem; padding: 0.55rem 0;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.pb-row:first-of-type { border-top: none; }
.pb-head { font-family: var(--font-display); font-size: 9px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3); }
.pb-cell { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
.pb-cell-a { justify-content: flex-end; font-family: var(--font-mono); }
.pb-cell-b { font-family: var(--font-mono); }
.pb-cell-a.higher, .pb-cell-b.higher { color: var(--cyan); font-weight: 700; }
.pb-cell-a.lower,  .pb-cell-b.lower  { color: var(--text-3); }
.pb-mid { justify-content: center; text-align: center; }
.pb-code { font-family: var(--font-mono); font-weight: 700; color: var(--text); }
.pb-height { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.pb-attempts { font-size: 10px; color: var(--text-3); font-weight: 400; }

.dim { color: var(--text-3); }

@media (max-width: 720px) {
  .compare-wrap { padding: 1rem; }
  .picker-row, .names-row, .stat-row, .pb-row {
    grid-template-columns: 1fr;
  }
  .picker-vs, .name-vs { display: none; }
  .stat-row > .stat-label { order: -1; }
  .stat-val { font-size: 22px; text-align: left; }
  .pb-cell-a, .pb-cell-b { justify-content: flex-start; }
  .pb-mid { text-align: left; }
}
</style>
