<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { cachedFetch, idbDelete } from '@/lib/idbCache'

const route = useRoute()
const auth = useAuthStore()

const profile = ref(null)
const loading = ref(false)
const error = ref('')
// True while we're rendering a stale (cached) copy and waiting
// for the network refresh to land. Surfaces as a small banner
// on the page so the diver knows the data is being verified.
const fromCache = ref(false)

// Analytics payload — populated alongside the profile via a
// separate /analytics call so the heavy aggregations don't block
// the main profile render.
const analytics = ref(null)
const analyticsLoading = ref(false)

// Self-serve dashboard. The diver picks which widgets to show on
// their profile; the choices persist via PUT /api/users/me/dashboard.
// Catalog is the source of truth for labels + descriptions; the
// backend validates against the same set of IDs.
const WIDGET_CATALOG = [
  { id: 'score_trend',       label: 'Score Trend',           desc: 'Total scores across meets over time, as a line chart.' },
  { id: 'personal_bests',    label: 'Personal Bests',        desc: 'Best dive total per (code + position + height).' },
  { id: 'recent_form',       label: 'Recent Form',           desc: 'Last 5 meets with finishing position and total.' },
  { id: 'placings',          label: 'Medal Counts',          desc: 'Lifetime tally of gold / silver / bronze + finalist appearances.' },
  { id: 'height_breakdown',  label: 'Height Breakdown',      desc: 'Average and best dive total per board height.' },
  { id: 'round_stamina',     label: 'Round-by-Round Form',   desc: 'Average score by round number — do you fade in later rounds?' },
  { id: 'quality_mix',       label: 'Score Quality Mix',     desc: 'Distribution of judge scores across the FINA categories.' },
  { id: 'dd_risk',           label: 'DD Risk Profile',       desc: 'Average + max DD attempted; how you score at the upper bound.' },
  { id: 'frequent_dives',    label: 'Go-To Dives',           desc: 'Top 5 most-attempted dives with avg / best totals.' },
  { id: 'streak',            label: 'Current Streak',        desc: 'Consecutive top-3 / top-1 finishes from your most recent meet.' },
  { id: 'compare_peers',     label: 'Compare to Peers',      desc: 'Your average DD and dive scores vs. the rest of your organisation.' },
  { id: 'event_type_splits', label: 'Synchro vs Individual', desc: 'Per-event-type split: meets, dive count, average + best totals.' },
  { id: 'year_over_year',    label: 'Year-over-Year',        desc: 'Calendar-year deltas: meets, average, best, podiums per year.' },
]
const customizing = ref(false)
const customizeSaving = ref(false)
const customizeErr = ref('')
// Index of the widget currently being dragged in the customize modal,
// or null when no drag is in progress. Used to drive the drop-target
// styling and to re-order on drop.
const dragIndex = ref(null)
const dragOverIndex = ref(null)
// Date-range filter state. Empty strings = "no filter on that side".
// The two inputs round-trip through query params on the analytics
// endpoint; the cache key in IndexedDB is the URL, so each distinct
// range gets its own cached payload.
const fromDate = ref('')
const toDate = ref('')

const enabledWidgets = computed(() =>
  Array.isArray(profile.value?.dashboard_widgets)
    ? profile.value.dashboard_widgets
    : ['score_trend', 'personal_bests', 'recent_form', 'placings'],
)
// Display order on the dashboard mirrors the saved order in
// dashboard_widgets, but only includes IDs that are still in the
// catalog (so a future widget removal doesn't leave a ghost entry).
const orderedEnabled = computed(() => {
  const known = new Set(WIDGET_CATALOG.map(w => w.id))
  return enabledWidgets.value.filter(id => known.has(id))
})
function isEnabled(id) { return enabledWidgets.value.includes(id) }
// Order index used by each widget card's inline `style="order: N"`
// so the dashboard reflects the saved drag order without repeating
// the entire template inside a v-for.
function widgetOrder(id) {
  const idx = orderedEnabled.value.indexOf(id)
  return idx === -1 ? 999 : idx
}
async function saveWidgets(next) {
  customizeSaving.value = true
  customizeErr.value = ''
  try {
    const r = await auth.apiFetch('/api/users/me/dashboard', {
      method: 'PUT',
      body: JSON.stringify({ widgets: next }),
    })
    profile.value.dashboard_widgets = r.widgets
  } catch (err) {
    customizeErr.value = err.message || 'Save failed'
  } finally {
    customizeSaving.value = false
  }
}
async function toggleWidget(id) {
  if (!isSelf.value) return
  const next = isEnabled(id)
    ? enabledWidgets.value.filter(w => w !== id)
    : [...enabledWidgets.value, id]
  await saveWidgets(next)
}

// Customize modal builds its own list (catalog order, with enabled
// items first in saved order, then disabled items in catalog order)
// so drag-to-reorder operates on a stable, complete list.
const customizeList = computed(() => {
  const enabledSet = new Set(enabledWidgets.value)
  // Enabled, in saved order; fall back to catalog order for any
  // saved IDs that aren't in the catalog (defensive).
  const enabledOrdered = enabledWidgets.value
    .filter(id => enabledSet.has(id))
    .map(id => WIDGET_CATALOG.find(w => w.id === id))
    .filter(Boolean)
  const disabled = WIDGET_CATALOG.filter(w => !enabledSet.has(w.id))
  return [...enabledOrdered, ...disabled]
})

function onDragStart(idx, ev) {
  dragIndex.value = idx
  // Required for Firefox drag init.
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    try { ev.dataTransfer.setData('text/plain', String(idx)) } catch { /* ignore */ }
  }
}
function onDragOver(idx, ev) {
  if (dragIndex.value == null) return
  ev.preventDefault()  // allow drop
  dragOverIndex.value = idx
}
function onDragLeave(idx) {
  if (dragOverIndex.value === idx) dragOverIndex.value = null
}
async function onDrop(idx, ev) {
  ev.preventDefault()
  const from = dragIndex.value
  dragIndex.value = null
  dragOverIndex.value = null
  if (from == null || from === idx) return
  // Apply the move to a copy of the customize list, then derive the
  // new enabled-only order from it (drag works across enabled +
  // disabled rows; only enabled IDs get persisted to the server).
  const list = customizeList.value.slice()
  const [moved] = list.splice(from, 1)
  list.splice(idx, 0, moved)
  const enabledSet = new Set(enabledWidgets.value)
  const next = list.map(w => w.id).filter(id => enabledSet.has(id))
  await saveWidgets(next)
}
function onDragEnd() {
  dragIndex.value = null
  dragOverIndex.value = null
}

// Apply the date-range filter — re-fetches profile + analytics with
// the new query params. Triggered by the Apply button so a half-typed
// date doesn't fire a request mid-keystroke.
async function applyDateFilter() {
  await load()
}
function clearDateFilter() {
  fromDate.value = ''
  toDate.value = ''
  load()
}

// Build the query string for /profile and /analytics. Empty when no
// filter is set, otherwise leading "?".
function dateQS() {
  const parts = []
  if (fromDate.value) parts.push(`from_date=${encodeURIComponent(fromDate.value)}`)
  if (toDate.value)   parts.push(`to_date=${encodeURIComponent(toDate.value)}`)
  return parts.length ? `?${parts.join('&')}` : ''
}

// Print / "save as PDF" — relies on the browser's print dialog and
// our @media print stylesheet, which hides headers, buttons, and
// modals so the dashboard cards print cleanly across pages.
function exportPDF() {
  // Add a body class so print CSS can also kick in if the dialog is
  // dismissed (e.g. user takes a screenshot). Removed on afterprint.
  document.body.classList.add('printing-dashboard')
  const cleanup = () => {
    document.body.classList.remove('printing-dashboard')
    window.removeEventListener('afterprint', cleanup)
  }
  window.addEventListener('afterprint', cleanup)
  // Defer to next frame so the class lands before the print snapshot.
  requestAnimationFrame(() => window.print())
}

// :id route param is optional — fall back to the logged-in user.
const targetId = computed(() => route.params.id || auth.user?.id)
const isSelf = computed(() => targetId.value && targetId.value === auth.user?.id)

// Inline club edit state
const editing = ref(false)
const clubs = ref([])
const clubChoice = ref('')           // selected club_id or ''
const savingClub = ref(false)
const saveError = ref('')

// Password change state
const pwEditing  = ref(false)
const pwCurrent  = ref('')
const pwNew      = ref('')
const pwConfirm  = ref('')
const pwSaving   = ref(false)
const pwError    = ref('')
const pwSuccess  = ref(false)

function openPasswordEditor() {
  pwEditing.value = true
  pwCurrent.value = ''
  pwNew.value = ''
  pwConfirm.value = ''
  pwError.value = ''
  pwSuccess.value = false
}
function closePasswordEditor() {
  pwEditing.value = false
  pwError.value = ''
}
async function savePassword() {
  pwError.value = ''
  if (pwNew.value.length < 6) {
    pwError.value = 'New password must be at least 6 characters'
    return
  }
  if (pwNew.value !== pwConfirm.value) {
    pwError.value = 'New passwords don\'t match'
    return
  }
  pwSaving.value = true
  try {
    await auth.apiFetch('/api/users/me/password', {
      method: 'PUT',
      body: JSON.stringify({
        current_password: pwCurrent.value,
        new_password:     pwNew.value,
      }),
    })
    pwSuccess.value = true
    setTimeout(() => { pwEditing.value = false; pwSuccess.value = false }, 1200)
  } catch (err) {
    pwError.value = err.message || 'Password change failed'
  } finally {
    pwSaving.value = false
  }
}

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
  const url = `/api/divers/${targetId.value}/profile${dateQS()}`
  loading.value = true
  error.value = ''
  fromCache.value = false
  try {
    // Stale-while-revalidate via IndexedDB. If we have a cached
    // copy from a previous load it shows instantly; the network
    // call updates it underneath. Critical for diver phones on
    // poolside wifi: the app stays usable when the network
    // momentarily drops.
    const result = await cachedFetch(
      url,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        },
        credentials: 'same-origin',
      },
      {
        onUpdate(fresh) {
          profile.value = fresh
          fromCache.value = false
        },
      },
    )
    if (result.data) {
      profile.value = result.data
      fromCache.value = result.fromCache
    } else if (!profile.value) {
      error.value = 'Offline and no cached profile yet'
    }
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
  // Analytics in parallel — separate endpoint so it doesn't
  // block the headline-stats / personal-bests / score-trend
  // render. Cached too, so a return visit feels instant.
  loadAnalytics()
}

async function loadAnalytics() {
  if (!targetId.value) return
  analyticsLoading.value = true
  try {
    const result = await cachedFetch(
      `/api/divers/${targetId.value}/analytics${dateQS()}`,
      {
        headers: {
          'Content-Type': 'application/json',
          ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        },
        credentials: 'same-origin',
      },
      {
        onUpdate(fresh) { analytics.value = fresh },
      },
    )
    if (result.data) analytics.value = result.data
  } finally {
    analyticsLoading.value = false
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

// Bar-width helper for the height-breakdown + round-stamina
// widgets. Scales each row to the max value in the same set so
// the visual emphasises *relative* performance (10m being lower
// than 1m on average is fine — the chart shows the difference).
function barWidth(value, list, key) {
  if (!list?.length) return 0
  const max = Math.max(...list.map(r => Number(r[key]) || 0))
  if (!max) return 0
  return Math.max(4, (Number(value) / max) * 100)
}

// FINA category buckets in display order. Mirrors the colour
// classes used by the live scoreboard chips. Driven from the
// analytics payload so the legend stays consistent.
const qualityBuckets = computed(() => {
  const q = analytics.value?.quality_mix || {}
  return [
    { id: 'failed',         label: 'Failed (0)',           count: q.failed         || 0 },
    { id: 'deficient',      label: 'Deficient (≤2.0)',     count: q.deficient      || 0 },
    { id: 'unsatisfactory', label: 'Unsat. (≤4.5)',        count: q.unsatisfactory || 0 },
    { id: 'satisfactory',   label: 'Satisfactory (≤6.0)',  count: q.satisfactory   || 0 },
    { id: 'good',           label: 'Good (≤8.0)',          count: q.good           || 0 },
    { id: 'very_good',      label: 'Very Good (≤9.5)',     count: q.very_good      || 0 },
    { id: 'excellent',      label: 'Excellent (10)',       count: q.excellent      || 0 },
  ]
})

// One-line insight derived from round_stamina — flag if scores
// drop in later rounds (a common diver question).
const staminaInsight = computed(() => {
  const r = analytics.value?.round_stamina || []
  if (r.length < 2) return ''
  const first = Number(r[0].avg_score) || 0
  const last  = Number(r[r.length - 1].avg_score) || 0
  if (first === 0) return ''
  const delta = ((last - first) / first) * 100
  if (delta > 5)  return `📈 You finish strong: round ${r[r.length - 1].round_number} averages ${delta.toFixed(0)}% higher than round 1.`
  if (delta < -5) return `📉 You fade in later rounds: round ${r[r.length - 1].round_number} averages ${Math.abs(delta).toFixed(0)}% below round 1.`
  return `Even pacing across rounds (Δ ${delta.toFixed(1)}% from R1 to R${r[r.length - 1].round_number}).`
})

function placeColor(n) {
  if (n === 1) return 'place-gold'
  if (n === 2) return 'place-silver'
  if (n === 3) return 'place-bronze'
  return ''
}

// Year-over-year delta — compares row[i] to row[i+1] (since the
// list is sorted newest first). Returns "+12.3%" / "-4.5%" / "—".
function yoyDelta(list, i) {
  const cur  = Number(list[i]?.avg_meet_total)
  const prev = Number(list[i + 1]?.avg_meet_total)
  if (!cur || !prev) return null
  return ((cur - prev) / prev) * 100
}
function yoyDeltaText(list, i) {
  const d = yoyDelta(list, i)
  if (d == null) return '—'
  const sign = d >= 0 ? '+' : ''
  return `${sign}${d.toFixed(1)}%`
}
function yoyDeltaClass(list, i) {
  const d = yoyDelta(list, i)
  if (d == null) return 'dim'
  if (d > 1) return 'yoy-up'
  if (d < -1) return 'yoy-down'
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
      <div class="header-actions">
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="customizing = true">
          ⚙ Customize
        </button>
        <button v-if="profile" class="btn btn-ghost btn-sm" @click="exportPDF" title="Open print dialog — choose 'Save as PDF' to export.">
          📄 Export PDF
        </button>
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="openClubEditor">
          Change Club
        </button>
        <button v-if="profile && isSelf" class="btn btn-ghost btn-sm" @click="openPasswordEditor">
          Change Password
        </button>
        <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
      </div>
    </div>

    <!-- Date-range filter strip. Applies to every aggregate widget;
         empty fields = no filter on that side. The Apply button
         deliberately requires a click so partial input doesn't fire
         a request mid-edit. -->
    <div v-if="profile" class="filter-strip no-print">
      <span class="filter-label">Date range</span>
      <input type="date" class="filter-input" v-model="fromDate" :max="toDate || undefined" aria-label="From date">
      <span class="filter-sep">→</span>
      <input type="date" class="filter-input" v-model="toDate" :min="fromDate || undefined" aria-label="To date">
      <button class="btn btn-primary btn-sm" @click="applyDateFilter" :disabled="loading">
        Apply
      </button>
      <button v-if="fromDate || toDate" class="btn btn-ghost btn-sm" @click="clearDateFilter">
        Clear
      </button>
      <span v-if="fromDate || toDate" class="filter-active">
        Showing {{ fromDate || '…' }} → {{ toDate || 'today' }}
      </span>
    </div>

    <div v-if="loading && !profile" class="empty">Loading profile…</div>
    <div v-else-if="fromCache" class="cache-banner">
      <span class="cache-dot"></span>
      Showing your last saved copy — refreshing in the background
    </div>
    <div v-else-if="error" class="msg msg-error">{{ error }}</div>
    <div v-else-if="profile" class="content">
      <!-- Headline stats — always pinned to the top via order: -1 -->
      <div class="stats-row" :style="{ order: -1 }">
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
      <div v-if="isEnabled('score_trend')" class="card" :style="{ order: widgetOrder('score_trend') }">
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
      <div v-if="isEnabled('personal_bests')" class="card" :style="{ order: widgetOrder('personal_bests') }">
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

      <!-- Recent form — last 5 meets with rank inline. The
           field_size suffix gives context ("3rd of 18" reads
           differently than "3rd of 4"). -->
      <div v-if="isEnabled('recent_form')" class="card" :style="{ order: widgetOrder('recent_form') }">
        <div class="card-head">Recent Form</div>
        <div v-if="analyticsLoading && !analytics" class="empty-mini">Loading…</div>
        <div v-else-if="!analytics?.recent_form?.length" class="empty-mini">No completed meets yet.</div>
        <div v-else class="trend-list">
          <div v-for="r in analytics.recent_form" :key="r.event_id" class="trend-row">
            <span class="trend-date">{{ fmtDate(r.created_at) }}</span>
            <span class="trend-name">{{ r.event_name }}</span>
            <span :class="['trend-place', placeColor(r.rank)]">
              {{ placeOrdinal(r.rank) }} <span class="dim">/ {{ r.field_size }}</span>
            </span>
            <span class="trend-total">{{ Number(r.total).toFixed(1) }}</span>
          </div>
        </div>
      </div>

      <!-- Medal counts -->
      <div v-if="isEnabled('placings')" class="card" :style="{ order: widgetOrder('placings') }">
        <div class="card-head">Medals &amp; Placings</div>
        <div v-if="!analytics" class="empty-mini">Loading…</div>
        <div v-else class="placings-row">
          <div class="placing-cell place-gold">
            <div class="placing-num">{{ analytics.placings.gold }}</div>
            <div class="placing-lbl">🥇 Gold</div>
          </div>
          <div class="placing-cell place-silver">
            <div class="placing-num">{{ analytics.placings.silver }}</div>
            <div class="placing-lbl">🥈 Silver</div>
          </div>
          <div class="placing-cell place-bronze">
            <div class="placing-num">{{ analytics.placings.bronze }}</div>
            <div class="placing-lbl">🥉 Bronze</div>
          </div>
          <div class="placing-cell">
            <div class="placing-num">{{ analytics.placings.finalist }}</div>
            <div class="placing-lbl">Finalist (4–8)</div>
          </div>
          <div class="placing-cell">
            <div class="placing-num">{{ analytics.placings.further }}</div>
            <div class="placing-lbl">9th+</div>
          </div>
        </div>
      </div>

      <!-- Height breakdown — average + best dive total per board.
           Bar widths normalised to the highest avg in the set. -->
      <div v-if="isEnabled('height_breakdown')" class="card" :style="{ order: widgetOrder('height_breakdown') }">
        <div class="card-head">Height Breakdown</div>
        <div v-if="!analytics" class="empty-mini">Loading…</div>
        <div v-else-if="!analytics.height_breakdown.length" class="empty-mini">No dives by height yet.</div>
        <div v-else class="bar-list">
          <div v-for="h in analytics.height_breakdown" :key="h.height" class="bar-row">
            <span class="bar-label">{{ h.height }}m</span>
            <div class="bar-track">
              <div class="bar-fill" :style="{
                width: barWidth(h.avg_score, analytics.height_breakdown, 'avg_score') + '%',
              }"></div>
            </div>
            <span class="bar-value">avg {{ Number(h.avg_score).toFixed(1) }}</span>
            <span class="bar-meta">best {{ Number(h.best_score).toFixed(1) }} · {{ h.dive_count }} dives</span>
          </div>
        </div>
      </div>

      <!-- Round-by-round form -->
      <div v-if="isEnabled('round_stamina')" class="card" :style="{ order: widgetOrder('round_stamina') }">
        <div class="card-head">Round-by-Round Form</div>
        <div v-if="!analytics" class="empty-mini">Loading…</div>
        <div v-else-if="!analytics.round_stamina.length" class="empty-mini">No rounds completed yet.</div>
        <div v-else class="bar-list">
          <div v-for="r in analytics.round_stamina" :key="r.round_number" class="bar-row">
            <span class="bar-label">Round {{ r.round_number }}</span>
            <div class="bar-track">
              <div class="bar-fill" :style="{
                width: barWidth(r.avg_score, analytics.round_stamina, 'avg_score') + '%',
              }"></div>
            </div>
            <span class="bar-value">{{ Number(r.avg_score).toFixed(1) }}</span>
            <span class="bar-meta">{{ r.dive_count }} dives</span>
          </div>
        </div>
        <p v-if="analytics?.round_stamina.length > 1" class="widget-hint">
          {{ staminaInsight }}
        </p>
      </div>

      <!-- Score quality mix — distribution across FINA categories,
           rendered as a horizontal stacked bar with category
           colours matching the live scoreboard chips. -->
      <div v-if="isEnabled('quality_mix')" class="card" :style="{ order: widgetOrder('quality_mix') }">
        <div class="card-head">Score Quality Mix</div>
        <div v-if="!analytics || !analytics.quality_mix.total" class="empty-mini">No judge scores yet.</div>
        <template v-else>
          <div class="quality-bar">
            <div v-for="b in qualityBuckets" :key="b.id"
                 :class="['quality-seg', `quality-${b.id}`]"
                 :style="{ width: (b.count / analytics.quality_mix.total * 100) + '%' }"
                 :title="`${b.label}: ${b.count} (${(b.count / analytics.quality_mix.total * 100).toFixed(1)}%)`"></div>
          </div>
          <div class="quality-legend">
            <div v-for="b in qualityBuckets" :key="b.id" class="quality-legend-row">
              <span :class="['quality-dot', `quality-${b.id}`]"></span>
              <span class="quality-name">{{ b.label }}</span>
              <span class="quality-count">{{ b.count }}</span>
              <span class="quality-pct">{{ analytics.quality_mix.total ? (b.count / analytics.quality_mix.total * 100).toFixed(1) : 0 }}%</span>
            </div>
          </div>
        </template>
      </div>

      <!-- DD risk profile -->
      <div v-if="isEnabled('dd_risk')" class="card" :style="{ order: widgetOrder('dd_risk') }">
        <div class="card-head">DD Risk Profile</div>
        <div v-if="!analytics?.dd_risk?.avg_dd" class="empty-mini">Not enough data yet.</div>
        <div v-else class="dd-risk-row">
          <div class="dd-cell">
            <div class="dd-num">{{ Number(analytics.dd_risk.avg_dd).toFixed(2) }}</div>
            <div class="dd-lbl">Avg DD attempted</div>
          </div>
          <div class="dd-cell">
            <div class="dd-num cyan">{{ Number(analytics.dd_risk.max_dd).toFixed(1) }}</div>
            <div class="dd-lbl">Max DD attempted</div>
          </div>
          <div class="dd-cell">
            <div class="dd-num">
              {{ analytics.dd_risk.avg_score_at_highest_dd != null
                 ? Number(analytics.dd_risk.avg_score_at_highest_dd).toFixed(1)
                 : '—' }}
            </div>
            <div class="dd-lbl">Avg score at top DDs</div>
            <div class="dd-meta" v-if="analytics.dd_risk.attempts_at_highest_dd">
              {{ analytics.dd_risk.attempts_at_highest_dd }} attempts ≥ {{ Number(analytics.dd_risk.max_dd - 0.3).toFixed(1) }}
            </div>
          </div>
        </div>
      </div>

      <!-- Frequent (go-to) dives -->
      <div v-if="isEnabled('frequent_dives')" class="card" :style="{ order: widgetOrder('frequent_dives') }">
        <div class="card-head">Go-To Dives</div>
        <div v-if="!analytics?.frequent_dives?.length" class="empty-mini">No dives recorded yet.</div>
        <table v-else class="pb-table">
          <thead>
            <tr>
              <th>Dive</th>
              <th>Pos</th>
              <th>Height</th>
              <th>Attempts</th>
              <th>Avg</th>
              <th>Best</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in analytics.frequent_dives" :key="f.dive_code + f.position + f.height">
              <td class="mono strong">{{ f.dive_code }}</td>
              <td class="mono">{{ f.position }}</td>
              <td class="mono">{{ f.height }}m</td>
              <td class="mono dim">{{ f.attempts }}</td>
              <td class="mono">{{ Number(f.avg_score).toFixed(1) }}</td>
              <td class="mono strong cyan">{{ Number(f.best_score).toFixed(1) }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Current streak — only renders when there's an active
           podium / win run. Otherwise hides itself to avoid
           a "no streak" pity widget. -->
      <div v-if="isEnabled('streak') && analytics?.streak?.length" class="card streak-card" :style="{ order: widgetOrder('streak') }">
        <div class="card-head">Current Streak</div>
        <div class="streak-body">
          <div class="streak-num">{{ analytics.streak.length }}</div>
          <div class="streak-meta">
            <div class="streak-kind">
              {{ analytics.streak.kind === 'win' ? '🥇 Consecutive wins' : '🥉 Consecutive podiums' }}
            </div>
            <div class="streak-hint">From your most recent meet backwards.</div>
          </div>
        </div>
      </div>

      <!-- Compare to peers — diver vs. org averages. The bars are
           normalised to the larger of (me, peer) so a glance shows
           who's higher. Hidden when there are no peer dives in the
           current date window. -->
      <div v-if="isEnabled('compare_peers') && analytics?.compare_peers" class="card" :style="{ order: widgetOrder('compare_peers') }">
        <div class="card-head">Compare to Peers ({{ profile.diver.org_name }})</div>
        <div v-if="!analytics.compare_peers.peer_dives" class="empty-mini">
          No peer dives in this date range yet.
        </div>
        <div v-else class="compare-grid">
          <div class="compare-row">
            <span class="compare-lbl">Avg DD attempted</span>
            <div class="compare-bars">
              <div class="compare-bar compare-me"
                   :style="{ width: barWidth(analytics.compare_peers.my_avg_dd, [
                     { v: analytics.compare_peers.my_avg_dd },
                     { v: analytics.compare_peers.peer_avg_dd }
                   ], 'v') + '%' }"></div>
              <div class="compare-bar compare-peer"
                   :style="{ width: barWidth(analytics.compare_peers.peer_avg_dd, [
                     { v: analytics.compare_peers.my_avg_dd },
                     { v: analytics.compare_peers.peer_avg_dd }
                   ], 'v') + '%' }"></div>
            </div>
            <span class="compare-vals">
              <span class="compare-me-text">You {{ analytics.compare_peers.my_avg_dd != null ? Number(analytics.compare_peers.my_avg_dd).toFixed(2) : '—' }}</span>
              <span class="compare-peer-text">Peers {{ analytics.compare_peers.peer_avg_dd != null ? Number(analytics.compare_peers.peer_avg_dd).toFixed(2) : '—' }}</span>
            </span>
          </div>
          <div class="compare-row">
            <span class="compare-lbl">Avg dive total</span>
            <div class="compare-bars">
              <div class="compare-bar compare-me"
                   :style="{ width: barWidth(analytics.compare_peers.my_avg_score, [
                     { v: analytics.compare_peers.my_avg_score },
                     { v: analytics.compare_peers.peer_avg_score }
                   ], 'v') + '%' }"></div>
              <div class="compare-bar compare-peer"
                   :style="{ width: barWidth(analytics.compare_peers.peer_avg_score, [
                     { v: analytics.compare_peers.my_avg_score },
                     { v: analytics.compare_peers.peer_avg_score }
                   ], 'v') + '%' }"></div>
            </div>
            <span class="compare-vals">
              <span class="compare-me-text">You {{ analytics.compare_peers.my_avg_score != null ? Number(analytics.compare_peers.my_avg_score).toFixed(1) : '—' }}</span>
              <span class="compare-peer-text">Peers {{ analytics.compare_peers.peer_avg_score != null ? Number(analytics.compare_peers.peer_avg_score).toFixed(1) : '—' }}</span>
            </span>
          </div>
          <div class="compare-row">
            <span class="compare-lbl">Max DD attempted</span>
            <div class="compare-bars">
              <div class="compare-bar compare-me"
                   :style="{ width: barWidth(analytics.compare_peers.my_max_dd, [
                     { v: analytics.compare_peers.my_max_dd },
                     { v: analytics.compare_peers.peer_max_dd }
                   ], 'v') + '%' }"></div>
              <div class="compare-bar compare-peer"
                   :style="{ width: barWidth(analytics.compare_peers.peer_max_dd, [
                     { v: analytics.compare_peers.my_max_dd },
                     { v: analytics.compare_peers.peer_max_dd }
                   ], 'v') + '%' }"></div>
            </div>
            <span class="compare-vals">
              <span class="compare-me-text">You {{ analytics.compare_peers.my_max_dd != null ? Number(analytics.compare_peers.my_max_dd).toFixed(1) : '—' }}</span>
              <span class="compare-peer-text">Peers {{ analytics.compare_peers.peer_max_dd != null ? Number(analytics.compare_peers.peer_max_dd).toFixed(1) : '—' }}</span>
            </span>
          </div>
        </div>
        <p class="widget-hint">
          Sample: {{ analytics.compare_peers.my_dives }} of your dives vs. {{ analytics.compare_peers.peer_dives }} peer dives.
        </p>
      </div>

      <!-- Event-type splits — synchro vs individual vs team. Each
           row is one event_type with meets, dive count, averages.
           The label maps the SQL enum to a human-friendly name. -->
      <div v-if="isEnabled('event_type_splits')" class="card" :style="{ order: widgetOrder('event_type_splits') }">
        <div class="card-head">Synchro vs Individual</div>
        <div v-if="!analytics?.event_type_splits?.length" class="empty-mini">
          No events to compare yet.
        </div>
        <table v-else class="pb-table">
          <thead>
            <tr>
              <th>Event type</th>
              <th>Meets</th>
              <th>Dives</th>
              <th>Avg dive</th>
              <th>Best dive</th>
              <th>Avg meet</th>
              <th>Best meet</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in analytics.event_type_splits" :key="r.event_type">
              <td class="strong">
                {{ r.event_type === 'synchro_pair' ? 'Synchro'
                 : r.event_type === 'team' ? 'Team'
                 : r.event_type === 'individual' ? 'Individual'
                 : r.event_type }}
              </td>
              <td class="mono dim">{{ r.meets }}</td>
              <td class="mono dim">{{ r.dives }}</td>
              <td class="mono">{{ r.avg_dive_score != null ? Number(r.avg_dive_score).toFixed(1) : '—' }}</td>
              <td class="mono cyan strong">{{ r.best_single_dive != null ? Number(r.best_single_dive).toFixed(1) : '—' }}</td>
              <td class="mono">{{ r.avg_meet_total != null ? Number(r.avg_meet_total).toFixed(1) : '—' }}</td>
              <td class="mono cyan strong">{{ r.best_meet_total != null ? Number(r.best_meet_total).toFixed(1) : '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- Year-over-year — one row per calendar year with the
           headline numbers. Sorted newest first; the "Δ" column
           is the year-on-year change in average meet total. -->
      <div v-if="isEnabled('year_over_year')" class="card" :style="{ order: widgetOrder('year_over_year') }">
        <div class="card-head">Year-over-Year</div>
        <div v-if="!analytics?.year_over_year?.length" class="empty-mini">
          Need at least one completed meet.
        </div>
        <table v-else class="pb-table">
          <thead>
            <tr>
              <th>Year</th>
              <th>Meets</th>
              <th>Avg meet</th>
              <th>Best meet</th>
              <th>Wins</th>
              <th>Podiums</th>
              <th>Δ vs prev</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(y, i) in analytics.year_over_year" :key="y.year">
              <td class="mono strong">{{ y.year }}</td>
              <td class="mono dim">{{ y.meets }}</td>
              <td class="mono">{{ y.avg_meet_total != null ? Number(y.avg_meet_total).toFixed(1) : '—' }}</td>
              <td class="mono cyan strong">{{ y.best_meet_total != null ? Number(y.best_meet_total).toFixed(1) : '—' }}</td>
              <td class="mono">{{ y.wins }}</td>
              <td class="mono">{{ y.podiums }}</td>
              <td class="mono" :class="yoyDeltaClass(analytics.year_over_year, i)">
                {{ yoyDeltaText(analytics.year_over_year, i) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- Customize Dashboard modal — toggle on/off + drag-to-reorder.
       Order is taken from `customizeList`: enabled widgets first
       (in saved order), then disabled widgets. Dragging a row
       commits a new order through PUT /api/users/me/dashboard. -->
  <div v-if="customizing" class="modal-backdrop" @click="customizing = false"></div>
  <div v-if="customizing" class="modal customize-modal" @click.stop>
    <div class="modal-head">
      <div class="modal-title">Customize Dashboard</div>
      <button class="btn btn-ghost btn-sm" @click="customizing = false">Done</button>
    </div>
    <div class="modal-body">
      <p class="modal-hint" style="margin-top:0">
        Toggle widgets on or off. Drag the ⋮⋮ handle to re-order.
        Changes save automatically.
      </p>
      <div class="widget-toggles" @dragend="onDragEnd">
        <div
          v-for="(w, idx) in customizeList"
          :key="w.id"
          :class="['widget-toggle',
                   { 'is-dragging': dragIndex === idx,
                     'is-drop-target': dragOverIndex === idx && dragIndex !== idx,
                     'is-disabled': !isEnabled(w.id) }]"
          :draggable="isSelf"
          @dragstart="onDragStart(idx, $event)"
          @dragover="onDragOver(idx, $event)"
          @dragleave="onDragLeave(idx)"
          @drop="onDrop(idx, $event)"
        >
          <span class="drag-handle" :title="isSelf ? 'Drag to re-order' : ''">⋮⋮</span>
          <input type="checkbox"
                 :checked="isEnabled(w.id)"
                 :disabled="customizeSaving || !isSelf"
                 @change="toggleWidget(w.id)">
          <div class="widget-toggle-text">
            <div class="widget-toggle-label">{{ w.label }}</div>
            <div class="widget-toggle-desc">{{ w.desc }}</div>
          </div>
        </div>
      </div>
      <div v-if="customizeErr" class="msg msg-error">{{ customizeErr }}</div>
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

  <!-- Password change modal -->
  <div v-if="pwEditing" class="modal-backdrop" @click="closePasswordEditor"></div>
  <div v-if="pwEditing" class="modal" @click.stop>
    <div class="modal-head">
      <div class="modal-title">Change Password</div>
      <button class="btn btn-ghost btn-sm" @click="closePasswordEditor">Close ✕</button>
    </div>
    <div class="modal-body">
      <div v-if="pwSuccess" class="msg msg-success">Password updated</div>
      <template v-else>
        <div class="field">
          <label class="label">Current password</label>
          <input class="input" type="password" autocomplete="current-password" v-model="pwCurrent">
        </div>
        <div class="field">
          <label class="label">New password</label>
          <input class="input" type="password" autocomplete="new-password" v-model="pwNew">
        </div>
        <div class="field">
          <label class="label">Confirm new password</label>
          <input class="input" type="password" autocomplete="new-password" v-model="pwConfirm">
        </div>
        <div v-if="pwError" class="msg msg-error">{{ pwError }}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost btn-sm" @click="closePasswordEditor">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="pwSaving" @click="savePassword">
            {{ pwSaving ? 'Saving…' : 'Save Password' }}
          </button>
        </div>
      </template>
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

/* "Showing cached" banner — small, unobtrusive, sits above the
   profile content while a network refresh is in flight. */
.cache-banner {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono); font-size: 11px; color: var(--amber);
  background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.7rem; margin-bottom: 1rem;
}
.cache-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--amber); animation: cachePulse 1.2s infinite;
}
@keyframes cachePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
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

/* =========================================================
   Customize-dashboard modal — list of toggleable widgets
   ========================================================= */
.customize-modal { width: min(560px, calc(100vw - 2rem)); }
.widget-toggles {
  display: flex; flex-direction: column; gap: 0.4rem;
  max-height: 480px; overflow-y: auto;
}
.widget-toggle {
  display: flex; gap: 0.6rem; align-items: flex-start;
  padding: 0.6rem 0.7rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer; transition: border-color 0.1s;
}
.widget-toggle:hover { border-color: var(--cyan); }
.widget-toggle input { accent-color: var(--cyan); margin-top: 0.2rem; }
.widget-toggle-text { flex: 1; min-width: 0; }
.widget-toggle-label {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text); letter-spacing: 0.05em;
}
.widget-toggle-desc {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  line-height: 1.5; margin-top: 0.15rem;
}

/* =========================================================
   Analytics widgets — placings, bars, quality mix, etc.
   ========================================================= */
.placings-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
  gap: 0.6rem;
}
.placing-cell {
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0.7rem 0.875rem;
  text-align: center;
}
.placing-cell.place-gold   { border-color: rgba(234,179,8,0.4);  background: rgba(234,179,8,0.06);  }
.placing-cell.place-silver { border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.placing-cell.place-bronze { border-color: rgba(180,83,9,0.4);   background: rgba(180,83,9,0.06);   }
.placing-num {
  font-family: var(--font-display); font-size: 28px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.placing-cell.place-gold   .placing-num { color: #f59e0b; }
.placing-cell.place-silver .placing-num { color: #94a3b8; }
.placing-cell.place-bronze .placing-num { color: #b45309; }
.placing-lbl {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.4rem;
}

/* Generic horizontal bar list — used by height_breakdown
   and round_stamina. */
.bar-list { display: flex; flex-direction: column; gap: 0.5rem; }
.bar-row {
  display: grid;
  grid-template-columns: 70px 1fr 80px 100px;
  align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 12px;
}
.bar-label {
  font-family: var(--font-display); font-weight: 700;
  color: var(--text-2); letter-spacing: 0.1em;
}
.bar-track {
  height: 16px; background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 4px; overflow: hidden;
}
.bar-fill {
  height: 100%; background: linear-gradient(90deg, var(--cyan), #0891b2);
  transition: width 0.2s;
}
.bar-value { color: var(--text); font-weight: 700; }
.bar-meta  { color: var(--text-3); font-size: 11px; }
.widget-hint {
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2);
  margin-top: 0.75rem; padding: 0.5rem 0.7rem;
  background: var(--bg-3); border-left: 2px solid var(--cyan); border-radius: 3px;
}

/* Score-quality mix — stacked bar + colour-coded legend
   (matches the live scoreboard's chip categories). */
.quality-bar {
  display: flex; height: 28px; border-radius: var(--radius-sm);
  overflow: hidden; border: 1px solid var(--border);
}
.quality-seg { transition: width 0.2s; min-width: 1px; }
.quality-seg.quality-failed         { background: #ef4444; }
.quality-seg.quality-deficient      { background: #fb923c; }
.quality-seg.quality-unsatisfactory { background: #fbbf24; }
.quality-seg.quality-satisfactory   { background: #475569; }
.quality-seg.quality-good           { background: #06b6d4; }
.quality-seg.quality-very_good      { background: #10b981; }
.quality-seg.quality-excellent      { background: #ec4899; }

.quality-legend { display: flex; flex-direction: column; gap: 0.25rem; margin-top: 0.75rem; }
.quality-legend-row {
  display: grid; grid-template-columns: 14px 1fr auto auto;
  align-items: center; gap: 0.6rem;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2);
}
.quality-dot {
  display: inline-block; width: 10px; height: 10px; border-radius: 2px;
}
.quality-dot.quality-failed         { background: #ef4444; }
.quality-dot.quality-deficient      { background: #fb923c; }
.quality-dot.quality-unsatisfactory { background: #fbbf24; }
.quality-dot.quality-satisfactory   { background: #475569; }
.quality-dot.quality-good           { background: #06b6d4; }
.quality-dot.quality-very_good      { background: #10b981; }
.quality-dot.quality-excellent      { background: #ec4899; }
.quality-name  { color: var(--text-2); }
.quality-count { font-weight: 700; color: var(--text); }
.quality-pct   { color: var(--text-3); width: 48px; text-align: right; }

/* DD risk profile — three big metric tiles */
.dd-risk-row {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 0.6rem;
}
.dd-cell {
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0.875rem 1rem;
  text-align: center;
}
.dd-num {
  font-family: var(--font-display); font-size: 32px; font-weight: 900;
  font-style: italic; line-height: 1; color: var(--text);
}
.dd-num.cyan { color: var(--cyan); }
.dd-lbl {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.4rem;
}
.dd-meta {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  margin-top: 0.3rem;
}

/* Streak card — small accent that only renders when active */
.streak-card { background: linear-gradient(135deg, rgba(245,158,11,0.06), transparent); }
.streak-body { display: flex; align-items: center; gap: 1rem; }
.streak-num {
  font-family: var(--font-display); font-size: 56px; font-weight: 900;
  font-style: italic; color: var(--amber); line-height: 1;
}
.streak-meta { display: flex; flex-direction: column; gap: 0.25rem; }
.streak-kind {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text); letter-spacing: 0.05em;
}
.streak-hint {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}

.header-actions {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
}

/* =========================================================
   Date-range filter strip
   ========================================================= */
.filter-strip {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.6rem 0.875rem;
  margin-bottom: 1.25rem;
  font-family: var(--font-mono); font-size: 12px;
}
.filter-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.filter-input {
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text); border-radius: 4px;
  padding: 0.35rem 0.5rem; font-family: var(--font-mono); font-size: 12px;
  color-scheme: dark;
}
.filter-input:focus { outline: 1px solid var(--cyan); border-color: var(--cyan); }
.filter-sep { color: var(--text-3); }
.filter-active {
  color: var(--cyan); font-size: 11px;
  margin-left: auto;
}

/* =========================================================
   Compare-to-peers bars — diver in cyan, peers in slate
   ========================================================= */
.compare-grid { display: flex; flex-direction: column; gap: 0.7rem; }
.compare-row {
  display: grid;
  grid-template-columns: 140px 1fr 200px;
  align-items: center; gap: 0.6rem;
}
.compare-lbl {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3);
}
.compare-bars {
  display: flex; flex-direction: column; gap: 3px;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 4px; padding: 4px; min-height: 28px;
}
.compare-bar { height: 8px; border-radius: 3px; transition: width 0.2s; min-width: 1px; }
.compare-bar.compare-me   { background: linear-gradient(90deg, var(--cyan), #0891b2); }
.compare-bar.compare-peer { background: linear-gradient(90deg, #64748b, #475569); }
.compare-vals {
  display: flex; flex-direction: column; gap: 2px;
  font-family: var(--font-mono); font-size: 11px;
}
.compare-me-text   { color: var(--cyan); font-weight: 700; }
.compare-peer-text { color: var(--text-3); }

/* =========================================================
   Drag-to-reorder visual cues in customize modal
   ========================================================= */
.widget-toggle .drag-handle {
  display: inline-block;
  font-family: var(--font-mono); font-weight: 700; font-size: 14px;
  color: var(--text-3); cursor: grab; user-select: none;
  letter-spacing: -2px; padding: 0 0.2rem;
}
.widget-toggle.is-dragging   { opacity: 0.4; }
.widget-toggle.is-drop-target {
  border-color: var(--cyan); box-shadow: 0 0 0 1px var(--cyan) inset;
}
.widget-toggle.is-disabled .widget-toggle-label { color: var(--text-3); }

/* =========================================================
   Year-over-year delta colours
   ========================================================= */
.yoy-up   { color: #10b981; font-weight: 700; }
.yoy-down { color: #ef4444; font-weight: 700; }

/* =========================================================
   Print / "save as PDF" support. Hides chrome (header buttons,
   modals, filter strip) so the dashboard prints cleanly across
   pages. Triggered by the .printing-dashboard class on <body>
   that exportPDF() adds for the duration of window.print().
   ========================================================= */
@media print {
  .no-print, .header-actions, .modal-backdrop, .modal { display: none !important; }
  .profile-wrap { padding: 0.5rem; }
  .page-header { border-bottom: 2px solid #000; }
  .page-title { color: #000; }
  .card, .stat {
    break-inside: avoid; page-break-inside: avoid;
    background: #fff !important; border: 1px solid #ccc !important;
    color: #000 !important;
  }
  .stat-num, .placing-num, .dd-num, .streak-num { color: #000 !important; }
  .card-head, .stat-label, .placing-lbl, .dd-lbl { color: #555 !important; }
  .trend-place, .trend-total, .compare-me-text, .pb-table td.cyan { color: #000 !important; }
  .bar-fill { background: #555 !important; }
  .quality-seg.quality-failed         { background: #c0392b !important; }
  .quality-seg.quality-deficient      { background: #e67e22 !important; }
  .quality-seg.quality-unsatisfactory { background: #f1c40f !important; }
  .quality-seg.quality-satisfactory   { background: #7f8c8d !important; }
  .quality-seg.quality-good           { background: #16a085 !important; }
  .quality-seg.quality-very_good      { background: #27ae60 !important; }
  .quality-seg.quality-excellent      { background: #8e44ad !important; }
}
</style>
