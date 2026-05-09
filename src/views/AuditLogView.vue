<script setup>
// Federation-wide audit log. Three tabs:
//
//   1. Recent activity — the last 7 days of score + role events
//      interleaved chronologically. Lets an admin glance at
//      "what happened recently" without picking a target up
//      front.
//   2. Score corrections — every score insert / update / delete
//      across the federation, filterable by event, action,
//      reason text, and date range. Click a row to jump to the
//      per-event audit view (which also surfaces IP / UA).
//   3. Role changes — every role grant / revoke across the
//      federation, filterable by role, action, and target user.
//
// Sysadmin gets a fourth control: an org filter dropdown that
// scopes every tab to a specific federation. Default leaves it
// "all orgs" so a sysadmin's investigation starts wide.
//
// Rows are paginated server-side via limit + offset; the page
// shows 100 at a time with a Show more button. CSV export
// dumps the currently-filtered rows so an org admin can attach
// the file to a dispute resolution email.

import { ref, computed, onMounted, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showError } from '@/composables/useNotify'

const auth = useAuthStore()
const router = useRouter()
const isSysAdmin = computed(() => !!auth.user?.is_system_admin)

// ----- Tab state -----
const TABS = [
  { id: 'recent',   label: 'Recent activity' },
  { id: 'scores',   label: 'Score corrections' },
  { id: 'roles',    label: 'Role changes' },
  { id: 'activity', label: 'Event & admin actions' },
]
const activeTab = ref('recent')

// ----- Org filter (sysadmin only) -----
const orgs = ref([])
const orgFilter = ref('')   // '' = all orgs (sysadmin only)

// ----- Recent tab state -----
const recentDays = ref(7)
const recentRows = ref([])
const recentBusy = ref(false)

// ----- Score audit tab state -----
const scoreFilters = ref({
  action: 'all',     // 'all' | 'insert' | 'update' | 'delete'
  q:      '',
  from:   '',
  to:     '',
})
const scoreRows = ref([])
const scoreBusy = ref(false)
const scoreOffset = ref(0)
const scoreHasMore = ref(false)
const PAGE = 100

// ----- Role audit tab state -----
const roleFilters = ref({
  action: 'all',     // 'all' | 'granted' | 'revoked'
  role:   'all',     // org_role enum
  from:   '',
  to:     '',
})
const roleRows = ref([])
const roleBusy = ref(false)
const roleOffset = ref(0)
const roleHasMore = ref(false)

const ORG_ROLES = ['org_admin', 'meet_manager', 'referee', 'judge', 'coach', 'diver']

// ----- Activity (event + admin actions) tab state -----
const activityFilters = ref({
  action_prefix: 'all', // 'all' | 'event' | 'roster' | 'org' | 'club' | 'team'
  from:          '',
  to:            '',
})
const activityRows = ref([])
const activityBusy = ref(false)
const activityOffset = ref(0)
const activityHasMore = ref(false)
const ACTIVITY_PREFIXES = [
  { value: 'all',    label: 'All' },
  { value: 'event',  label: 'Event lifecycle' },
  { value: 'roster', label: 'Roster (late entry / withdraw)' },
  { value: 'org',    label: 'Org governance' },
  { value: 'club',   label: 'Club deletes' },
  { value: 'team',   label: 'Team deletes' },
]

// ----- Data loaders -----
async function loadOrgs() {
  if (!isSysAdmin.value) return
  try {
    orgs.value = await auth.apiFetch('/api/orgs')
  } catch { /* silent */ }
}

function orgQueryParam() {
  if (!isSysAdmin.value) return ''
  return orgFilter.value ? `&org_id=${encodeURIComponent(orgFilter.value)}` : ''
}

async function loadRecent() {
  recentBusy.value = true
  try {
    recentRows.value = await auth.apiFetch(
      `/api/audit/recent?days=${recentDays.value}&limit=${PAGE}${orgQueryParam()}`,
    )
  } catch (err) {
    showError(`Failed to load recent activity: ${err.message}`)
  } finally {
    recentBusy.value = false
  }
}

async function loadScores({ append = false } = {}) {
  scoreBusy.value = true
  try {
    const f = scoreFilters.value
    const params = new URLSearchParams()
    if (f.action !== 'all') params.set('action', f.action)
    if (f.q.trim())         params.set('q',      f.q.trim())
    if (f.from)             params.set('from',   f.from)
    if (f.to)               params.set('to',     f.to)
    params.set('limit',  PAGE)
    params.set('offset', append ? scoreOffset.value : 0)
    if (isSysAdmin.value && orgFilter.value) params.set('org_id', orgFilter.value)
    const rows = await auth.apiFetch(`/api/audit/scores?${params.toString()}`)
    if (append) {
      scoreRows.value = [...scoreRows.value, ...rows]
    } else {
      scoreRows.value = rows
      scoreOffset.value = 0
    }
    scoreOffset.value += rows.length
    scoreHasMore.value = rows.length === PAGE
  } catch (err) {
    showError(`Failed to load score audit: ${err.message}`)
  } finally {
    scoreBusy.value = false
  }
}

async function loadRoles({ append = false } = {}) {
  roleBusy.value = true
  try {
    const f = roleFilters.value
    const params = new URLSearchParams()
    if (f.action !== 'all') params.set('action', f.action)
    if (f.role !== 'all')   params.set('role',   f.role)
    if (f.from)             params.set('from',   f.from)
    if (f.to)               params.set('to',     f.to)
    params.set('limit',  PAGE)
    params.set('offset', append ? roleOffset.value : 0)
    if (isSysAdmin.value && orgFilter.value) params.set('org_id', orgFilter.value)
    const rows = await auth.apiFetch(`/api/audit/roles?${params.toString()}`)
    if (append) {
      roleRows.value = [...roleRows.value, ...rows]
    } else {
      roleRows.value = rows
      roleOffset.value = 0
    }
    roleOffset.value += rows.length
    roleHasMore.value = rows.length === PAGE
  } catch (err) {
    showError(`Failed to load role audit: ${err.message}`)
  } finally {
    roleBusy.value = false
  }
}

async function loadActivity({ append = false } = {}) {
  activityBusy.value = true
  try {
    const f = activityFilters.value
    const params = new URLSearchParams()
    if (f.action_prefix !== 'all') params.set('action_prefix', f.action_prefix)
    if (f.from)                    params.set('from',          f.from)
    if (f.to)                      params.set('to',            f.to)
    params.set('limit',  PAGE)
    params.set('offset', append ? activityOffset.value : 0)
    if (isSysAdmin.value && orgFilter.value) params.set('org_id', orgFilter.value)
    const rows = await auth.apiFetch(`/api/audit/activity?${params.toString()}`)
    if (append) {
      activityRows.value = [...activityRows.value, ...rows]
    } else {
      activityRows.value = rows
      activityOffset.value = 0
    }
    activityOffset.value += rows.length
    activityHasMore.value = rows.length === PAGE
  } catch (err) {
    showError(`Failed to load activity audit: ${err.message}`)
  } finally {
    activityBusy.value = false
  }
}

// Re-load whichever tab is active when its filters change. Each
// filter watcher hits its own loader so switching between tabs
// is cheap (loader runs once, cached in the row ref).
watch(() => activeTab.value, (next) => {
  if (next === 'recent'   && !recentRows.value.length)   loadRecent()
  if (next === 'scores'   && !scoreRows.value.length)    loadScores()
  if (next === 'roles'    && !roleRows.value.length)     loadRoles()
  if (next === 'activity' && !activityRows.value.length) loadActivity()
})
watch(() => orgFilter.value, () => {
  // Org filter is global — refetch whichever tab is visible.
  if (activeTab.value === 'recent')   loadRecent()
  if (activeTab.value === 'scores')   loadScores()
  if (activeTab.value === 'roles')    loadRoles()
  if (activeTab.value === 'activity') loadActivity()
})
watch(() => recentDays.value, () => {
  if (activeTab.value === 'recent') loadRecent()
})
// Score / role filter changes — debounce-free; if the operator
// types fast in the search box they'll hit Enter or blur to fire
// a refetch via a button. Action / date / role are select boxes
// so a change-event reload is fine.
watch(() => [scoreFilters.value.action, scoreFilters.value.from, scoreFilters.value.to], () => {
  if (activeTab.value === 'scores') loadScores()
})
watch(() => [roleFilters.value.action, roleFilters.value.role, roleFilters.value.from, roleFilters.value.to], () => {
  if (activeTab.value === 'roles') loadRoles()
})
watch(() => [activityFilters.value.action_prefix, activityFilters.value.from, activityFilters.value.to], () => {
  if (activeTab.value === 'activity') loadActivity()
})

function applyScoreSearch() {
  // Manual trigger so a fast-typing operator doesn't hit the
  // server every keystroke for the reason text search.
  if (activeTab.value === 'scores') loadScores()
}

// ----- Helpers -----
function fmtTime(iso) {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
}
// Friendlier label for each audit action. Score + role audits
// store short enums (insert / update / delete / granted /
// revoked); the activity log uses dotted verbs ('event.created',
// 'roster.late_entry_added') — both shapes feed in here.
const ACTIVITY_LABELS = {
  'event.created':           'Event created',
  'event.deleted':           'Event deleted',
  'event.started':           'Event went Live',
  'event.finalised':         'Event finalised',
  'event.unfinalised':       'Event un-finalised',
  'event.status_changed':    'Event status changed',
  'event.workflow_reset':    'Pre-meet workflow reset',
  'org.created':             'Org created',
  'org.status_changed':      'Org status changed',
  'club.deleted':            'Club deleted',
  'team.deleted':            'Team deleted',
  'roster.withdrew':         'Diver withdrawn',
  'roster.reinstated':       'Diver reinstated',
  'roster.late_entry_added': 'Late entry added',
}
function actionLabel(a) {
  if (a === 'insert')  return 'Submitted'
  if (a === 'update')  return 'Edited'
  if (a === 'delete')  return 'Deleted'
  if (a === 'granted') return 'Granted'
  if (a === 'revoked') return 'Revoked'
  if (ACTIVITY_LABELS[a]) return ACTIVITY_LABELS[a]
  return a
}
function actionClass(a) {
  if (a === 'insert' || a === 'granted')   return 'act-pos'
  if (a === 'update')                      return 'act-warn'
  if (a === 'delete' || a === 'revoked')   return 'act-neg'
  // Activity-log actions: positive (created / reinstated /
  // started), warn (status_changed / workflow_reset / late_entry),
  // negative (deleted / withdrew / unfinalised).
  if (a.endsWith('.created'))    return 'act-pos'
  if (a.endsWith('.started'))    return 'act-pos'
  if (a.endsWith('.finalised'))  return 'act-pos'
  if (a.endsWith('.reinstated')) return 'act-pos'
  if (a.endsWith('.deleted'))    return 'act-neg'
  if (a.endsWith('.withdrew'))   return 'act-neg'
  if (a.endsWith('.unfinalised')) return 'act-neg'
  return 'act-warn'
}

// Compose a one-line "what happened" for an activity row. The
// metadata jsonb's shape varies by action so a switch is
// clearer than a generic JSON.stringify.
function activitySummary(r) {
  if (!r) return ''
  const m = r.metadata || {}
  if (r.action === 'event.created') {
    const bits = []
    if (m.event_type) bits.push(m.event_type)
    if (m.height)     bits.push(m.height)
    if (m.total_rounds) bits.push(`${m.total_rounds} rounds`)
    if (m.number_of_judges) bits.push(`${m.number_of_judges}-judge panel`)
    return bits.join(' · ')
  }
  if (r.action === 'event.deleted') {
    return m.previous_status ? `was ${m.previous_status}` : ''
  }
  if (r.action === 'event.started')      return 'Upcoming → Live'
  if (r.action === 'event.finalised')    return 'Live → Completed'
  if (r.action === 'event.unfinalised')  return 'Completed → Live'
  if (r.action === 'event.status_changed') return `${m.from} → ${m.to}`
  if (r.action === 'org.status_changed')   return `${m.from} → ${m.to}`
  if (r.action === 'roster.late_entry_added') {
    return `Round ${m.round_number} of ${m.event_name || 'event'}`
  }
  if (r.action === 'roster.withdrew' || r.action === 'roster.reinstated') {
    return m.event_name || ''
  }
  if (r.action === 'club.deleted') {
    const n = m.unassigned_members
    return n ? `${n} member${n === 1 ? ' unassigned' : 's unassigned'}` : ''
  }
  if (r.action === 'team.deleted') {
    return [m.members_unbound && `${m.members_unbound} members`,
            m.events_detached && `${m.events_detached} events`,
           ].filter(Boolean).join(' · ')
  }
  return ''
}

// ----- CSV export -----
function exportCsv(rows, kind) {
  if (!rows.length) return
  let header, body
  if (kind === 'score') {
    header = ['Time','Action','Event','Org','Round','Competitor','Judge','Old','New','Actor','Reason']
    body = rows.map(r => [
      r.created_at, r.action, r.event_name || '', r.org_name || '', r.round_number,
      r.competitor_name || '', r.judge_name || '', r.old_score ?? '', r.new_score ?? '',
      r.actor_name || '', r.reason || '',
    ])
  } else if (kind === 'role') {
    header = ['Time','Action','Role','Target','Org','Actor','Note']
    body = rows.map(r => [
      r.created_at, r.action, r.role, r.target_name || '',
      r.org_name || '', r.actor_name || '', r.note || '',
    ])
  } else if (kind === 'activity') {
    header = ['Time','Action','Entity','Name','Org','Actor','Detail','Metadata']
    body = rows.map(r => [
      r.created_at, r.action, r.entity_type, r.entity_name || '',
      r.org_name || '', r.actor_name || '',
      activitySummary(r),
      r.metadata ? JSON.stringify(r.metadata) : '',
    ])
  } else {
    // recent (mixed)
    header = ['Time','Kind','Action','Subject','Org','Actor','Detail']
    body = rows.map(r => {
      let subject = ''
      let detail  = ''
      if (r.kind === 'score') {
        subject = r.competitor_name || ''
        detail  = `${r.event_name || ''} · R${r.round_number} · ${r.old_score ?? ''}→${r.new_score ?? ''}${r.reason ? ` · ${r.reason}` : ''}`
      } else if (r.kind === 'role') {
        subject = r.target_name || ''
        detail  = `${r.role}${r.note ? ` · ${r.note}` : ''}`
      } else {
        // activity
        subject = r.entity_name || r.entity_type
        detail  = activitySummary(r)
      }
      return [r.created_at, r.kind, r.action, subject, r.org_name || '', r.actor_name || '', detail]
    })
  }
  const csv = [header, ...body]
    .map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','))
    .join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `audit_${kind}_${new Date().toISOString().slice(0, 10)}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

// ----- Mount -----
onMounted(async () => {
  await loadOrgs()
  await loadRecent()
})
</script>

<template>
  <div class="audit-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Audit Log</div>
        <h1 class="page-title">Federation activity</h1>
        <div class="page-sub">
          Every score correction and role change across
          {{ isSysAdmin ? 'all federations' : 'your federation' }} —
          searchable, filterable, exportable.
          <span class="page-sub-dim">Retention: 30 days.</span>
        </div>
      </div>
      <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
    </div>

    <!-- Sysadmin org scope. Default 'all orgs' so a sysadmin's
         investigation starts wide; org admins don't see this
         control. -->
    <div v-if="isSysAdmin" class="org-scope">
      <span class="filter-label">Org scope</span>
      <select class="select select-sm" v-model="orgFilter">
        <option value="">All organisations</option>
        <option v-for="o in orgs" :key="o.id" :value="o.id">
          {{ o.name }}{{ o.country_code ? ` (${o.country_code})` : '' }}
        </option>
      </select>
    </div>

    <!-- Tab strip -->
    <div class="tabs" role="tablist">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        :class="['tab', activeTab === t.id ? 'tab-active' : '']"
        :aria-selected="activeTab === t.id"
        @click="activeTab = t.id"
      >{{ t.label }}</button>
    </div>

    <!-- Recent activity -->
    <section v-if="activeTab === 'recent'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">Last</span>
          <select class="select select-sm" v-model.number="recentDays">
            <option :value="1">24 hours</option>
            <option :value="7">7 days</option>
            <option :value="14">14 days</option>
            <option :value="30">30 days</option>
            <option :value="90">90 days</option>
          </select>
        </div>
        <span class="result-count">{{ recentRows.length }} entries</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!recentRows.length"
                @click="exportCsv(recentRows, 'mixed')">
          Export CSV
        </button>
      </div>

      <div v-if="recentBusy && !recentRows.length" class="empty">Loading…</div>
      <div v-else-if="!recentRows.length" class="empty">
        Quiet around here — no audit activity in the selected window.
      </div>
      <table v-else class="audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>What happened</th>
            <th v-if="isSysAdmin && !orgFilter">Org</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in recentRows" :key="`${r.kind}-${r.id}`">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td>
              <span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span>
              <span class="kind-pill" :class="`kind-${r.kind}`">
                {{ r.kind === 'score' ? 'Score' : r.kind === 'role' ? 'Role' : 'Activity' }}
              </span>
            </td>
            <td>
              <template v-if="r.kind === 'score'">
                <strong>{{ r.competitor_name || 'Competitor' }}</strong>
                <span class="dim"> in </span>
                <RouterLink :to="`/events/${r.event_id}/audit`" class="event-link">
                  {{ r.event_name || 'event' }}
                </RouterLink>
                <span class="dim"> · R{{ r.round_number }}</span>
                <span v-if="r.old_score != null || r.new_score != null" class="score-shift">
                  {{ r.old_score ?? '—' }} <span class="arr">→</span> <strong>{{ r.new_score ?? '—' }}</strong>
                </span>
                <div v-if="r.reason" class="reason">"{{ r.reason }}"</div>
              </template>
              <template v-else-if="r.kind === 'role'">
                <strong>{{ r.role }}</strong>
                {{ r.action === 'granted' ? 'granted to' : 'revoked from' }}
                <strong>{{ r.target_name || 'user' }}</strong>
                <div v-if="r.note" class="reason">"{{ r.note }}"</div>
              </template>
              <template v-else>
                <!-- activity -->
                <strong>{{ r.entity_name || r.entity_type }}</strong>
                <span v-if="activitySummary(r)" class="dim"> — {{ activitySummary(r) }}</span>
              </template>
            </td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Score corrections -->
    <section v-if="activeTab === 'scores'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">Action</span>
          <select class="select select-sm" v-model="scoreFilters.action">
            <option value="all">All</option>
            <option value="insert">Submitted</option>
            <option value="update">Edited</option>
            <option value="delete">Deleted</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">From</span>
          <input type="date" class="input input-sm" v-model="scoreFilters.from">
        </div>
        <div class="field-inline">
          <span class="filter-label">To</span>
          <input type="date" class="input input-sm" v-model="scoreFilters.to">
        </div>
        <div class="field-inline filter-search">
          <input type="text" class="input input-sm" v-model="scoreFilters.q"
                 placeholder='Search reason ("video", "typo", …)'
                 @keyup.enter="applyScoreSearch">
          <button type="button" class="btn btn-ghost btn-sm" @click="applyScoreSearch">Search</button>
        </div>
        <span class="result-count">{{ scoreRows.length }} entries</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!scoreRows.length"
                @click="exportCsv(scoreRows, 'score')">
          Export CSV
        </button>
      </div>

      <div v-if="scoreBusy && !scoreRows.length" class="empty">Loading…</div>
      <div v-else-if="!scoreRows.length" class="empty">
        No score audit entries match the current filters.
      </div>
      <table v-else class="audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Event</th>
            <th v-if="isSysAdmin && !orgFilter">Org</th>
            <th>Round</th>
            <th>Competitor</th>
            <th>Judge</th>
            <th>Old → New</th>
            <th>Actor</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in scoreRows" :key="r.id">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td><span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span></td>
            <td>
              <RouterLink :to="`/events/${r.event_id}/audit`" class="event-link">
                {{ r.event_name || '—' }}
              </RouterLink>
            </td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">R{{ r.round_number }}</td>
            <td>{{ r.competitor_name || '—' }}</td>
            <td>
              <span v-if="r.judge_number" class="judge-num">J{{ r.judge_number }}</span>
              {{ r.judge_name || '—' }}
            </td>
            <td class="mono">
              <span class="old">{{ r.old_score ?? '—' }}</span>
              <span class="arr">→</span>
              <span class="new">{{ r.new_score ?? '—' }}</span>
            </td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
            <td class="reason-cell" v-tip="r.reason || ''">{{ r.reason || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="scoreHasMore" class="more-row">
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="scoreBusy"
                @click="loadScores({ append: true })">
          {{ scoreBusy ? 'Loading…' : `Show ${PAGE} more` }}
        </button>
      </div>
    </section>

    <!-- Role changes -->
    <section v-if="activeTab === 'roles'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">Action</span>
          <select class="select select-sm" v-model="roleFilters.action">
            <option value="all">All</option>
            <option value="granted">Granted</option>
            <option value="revoked">Revoked</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">Role</span>
          <select class="select select-sm" v-model="roleFilters.role">
            <option value="all">All</option>
            <option v-for="r in ORG_ROLES" :key="r" :value="r">{{ r }}</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">From</span>
          <input type="date" class="input input-sm" v-model="roleFilters.from">
        </div>
        <div class="field-inline">
          <span class="filter-label">To</span>
          <input type="date" class="input input-sm" v-model="roleFilters.to">
        </div>
        <span class="result-count">{{ roleRows.length }} entries</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!roleRows.length"
                @click="exportCsv(roleRows, 'role')">
          Export CSV
        </button>
      </div>

      <div v-if="roleBusy && !roleRows.length" class="empty">Loading…</div>
      <div v-else-if="!roleRows.length" class="empty">
        No role audit entries match the current filters.
      </div>
      <table v-else class="audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Role</th>
            <th>Target user</th>
            <th v-if="isSysAdmin && !orgFilter">Org</th>
            <th>Actor</th>
            <th>Note</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in roleRows" :key="r.id">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td><span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span></td>
            <td class="mono">{{ r.role }}</td>
            <td>
              {{ r.target_name || '—' }}
              <span v-if="r.target_username" class="dim mono"> · {{ r.target_username }}</span>
            </td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
            <td class="reason-cell" v-tip="r.note || ''">{{ r.note || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="roleHasMore" class="more-row">
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="roleBusy"
                @click="loadRoles({ append: true })">
          {{ roleBusy ? 'Loading…' : `Show ${PAGE} more` }}
        </button>
      </div>
    </section>

    <!-- Event & admin actions -->
    <section v-if="activeTab === 'activity'">
      <div class="filters">
        <div class="field-inline">
          <span class="filter-label">Domain</span>
          <select class="select select-sm" v-model="activityFilters.action_prefix">
            <option v-for="p in ACTIVITY_PREFIXES" :key="p.value" :value="p.value">{{ p.label }}</option>
          </select>
        </div>
        <div class="field-inline">
          <span class="filter-label">From</span>
          <input type="date" class="input input-sm" v-model="activityFilters.from">
        </div>
        <div class="field-inline">
          <span class="filter-label">To</span>
          <input type="date" class="input input-sm" v-model="activityFilters.to">
        </div>
        <span class="result-count">{{ activityRows.length }} entries</span>
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="!activityRows.length"
                @click="exportCsv(activityRows, 'activity')">
          Export CSV
        </button>
      </div>

      <div v-if="activityBusy && !activityRows.length" class="empty">Loading…</div>
      <div v-else-if="!activityRows.length" class="empty">
        No activity audit entries match the current filters.
      </div>
      <table v-else class="audit-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Subject</th>
            <th>Detail</th>
            <th v-if="isSysAdmin && !orgFilter">Org</th>
            <th>Actor</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in activityRows" :key="r.id">
            <td class="mono dim">{{ fmtTime(r.created_at) }}</td>
            <td><span :class="['action-pill', actionClass(r.action)]">{{ actionLabel(r.action) }}</span></td>
            <td>
              <strong>{{ r.entity_name || '—' }}</strong>
              <span class="dim"> · {{ r.entity_type }}</span>
            </td>
            <td class="reason-cell" v-tip="activitySummary(r)">{{ activitySummary(r) || '—' }}</td>
            <td v-if="isSysAdmin && !orgFilter" class="dim mono">{{ r.org_name || '—' }}</td>
            <td class="mono">{{ r.actor_name || '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div v-if="activityHasMore" class="more-row">
        <button type="button" class="btn btn-ghost btn-sm"
                :disabled="activityBusy"
                @click="loadActivity({ append: true })">
          {{ activityBusy ? 'Loading…' : `Show ${PAGE} more` }}
        </button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.audit-wrap { max-width: 1300px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase;
  color: var(--cyan); margin-bottom: 0.5rem;
}
.page-title {
  font-family: var(--font-display); font-size: 32px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.page-sub {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--text-3); margin-top: 0.4rem;
  max-width: 640px;
}
.page-sub-dim { opacity: 0.7; }

.org-scope {
  display: flex; align-items: center; gap: 0.6rem;
  margin-bottom: 1rem;
}

.tabs {
  display: flex; align-items: center; gap: 0.25rem;
  margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent; border: 0;
  padding: 0.7rem 1.1rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.12s, border-color 0.12s;
}
.tab:hover { color: var(--text-2); }
.tab-active {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
}

.filters {
  display: flex; align-items: center; gap: 0.85rem; flex-wrap: wrap;
  padding: 0.875rem 1rem; margin-bottom: 1rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.field-inline { display: flex; align-items: center; gap: 0.4rem; }
.filter-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.select-sm { padding: 0.3rem 0.5rem; font-size: 12px; min-width: 110px; }
.input-sm { padding: 0.3rem 0.5rem; font-size: 12px; min-width: 130px; }
.filter-search {
  flex: 1 1 220px; min-width: 0;
  max-width: 360px;
}
.filter-search .input-sm { flex: 1; min-width: 0; }
.result-count {
  margin-left: auto;
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}

.empty {
  color: var(--text-3); padding: 3rem 0; text-align: center;
  font-family: var(--font-mono); font-size: 13px;
}

.audit-table {
  width: 100%; border-collapse: collapse;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); overflow: hidden;
}
.audit-table th, .audit-table td {
  padding: 0.55rem 0.75rem;
  border-bottom: 1px solid var(--border);
  text-align: left; font-size: 13px; vertical-align: middle;
}
.audit-table th {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  background: var(--bg-2);
}
.audit-table tbody tr:hover { background: var(--bg-2); }
.audit-table tbody tr:last-child td { border-bottom: none; }

.mono  { font-family: var(--font-mono); }
.dim   { color: var(--text-3); }

.action-pill {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.2rem 0.5rem; border-radius: 3px;
  border: 1px solid var(--border); background: var(--bg-2); color: var(--text-3);
  white-space: nowrap;
}
.action-pill.act-pos  { color: var(--green); border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); }
.action-pill.act-warn { color: var(--amber); border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.08); }
.action-pill.act-neg  { color: var(--red);   border-color: rgba(239,68,68,0.4);  background: rgba(239,68,68,0.08); }

.kind-pill {
  font-family: var(--font-mono); font-size: 9.5px; font-weight: 700;
  letter-spacing: 0.05em;
  margin-left: 0.4rem;
  padding: 0.1rem 0.4rem;
  border-radius: 3px;
  background: var(--bg);
  color: var(--text-3);
  border: 1px solid var(--border);
}
.kind-score    { color: var(--cyan); border-color: rgba(6,182,212,0.4); }
.kind-role     { color: #a78bfa;     border-color: rgba(167,139,250,0.4); }
.kind-activity { color: var(--amber); border-color: rgba(245,158,11,0.4); }

.judge-num {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  color: var(--cyan); border: 1px solid rgba(6,182,212,0.3);
  background: var(--cyan-dim); padding: 0.1rem 0.35rem; border-radius: 3px;
  margin-right: 0.4rem;
}
.event-link {
  color: var(--cyan); text-decoration: none;
  border-bottom: 1px dashed transparent;
  transition: border-color 0.12s;
}
.event-link:hover { border-bottom-color: var(--cyan); }

.score-shift {
  font-family: var(--font-mono);
  margin-left: 0.5rem;
  color: var(--text-3);
}
.old { color: var(--text-3); }
.new { color: var(--text); font-weight: 700; }
.arr { color: var(--text-3); margin: 0 0.4rem; }
.reason {
  font-family: var(--font-mono); font-size: 11.5px;
  color: var(--text-3);
  font-style: italic;
  margin-top: 0.2rem;
  max-width: 520px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.reason-cell {
  font-family: var(--font-mono); font-size: 12px;
  color: var(--text-3);
  max-width: 280px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.more-row {
  display: flex; justify-content: center;
  margin-top: 0.85rem;
}
</style>
