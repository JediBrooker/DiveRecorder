<script setup>
// Role-aware dashboard.
//
// Layout:
//   1. Header (welcome + sign-out)
//   2. Find Diver typeahead
//   3. Pulse strip — always-visible cross-role digest
//      ("3 LIVE · 2 UPCOMING · 5 PENDING · entries close 14d")
//   4. Tab strip — one tab per role the user holds + an Other
//      tab for utility surfaces (Dive Directory, Scoreboard,
//      Compare). Each tab carries an optional badge count.
//   5. Active panel — content scoped to the active tab.
//
// Smart-pick picks the initial tab on first mount:
//   1. If any LIVE event AND user has org_admin/meet_manager →
//      that operator tab.
//   2. Else if user is a diver with entries close < 7 days →
//      diver tab.
//   3. Else if a localStorage stamp from a previous visit is
//      still a valid tab for this user → that tab.
//   4. Else fallback to most-privileged role.
//
// Each tab loads its own data lazily on first activation; once
// loaded, switches are instant. Pulse data loads up front
// because it's needed for the strip and for the smart-pick
// computation.
//
// Brand-new org admins (zero clubs + zero events + no
// dismiss/complete stamp) still get the auto-redirect to
// /setup — happens before the tab logic runs.
import { ref, onMounted, computed, watch } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

// ---- Tabs ---------------------------------------------------
// Order matters: tabs render in this order (left → right).
const TABS = [
  { id: 'org_admin',    label: 'Org Admin',    role: 'org_admin'    },
  { id: 'meet_manager', label: 'Meet Manager', role: 'meet_manager' },
  { id: 'referee',      label: 'Referee',      role: 'referee'      },
  { id: 'judge',        label: 'Judge',        role: 'judge'        },
  { id: 'coach',        label: 'Coach',        role: 'coach'        },
  { id: 'diver',        label: 'Diver',        role: 'diver'        },
  { id: 'other',        label: 'Other',        role: null           },
]
const visibleTabs = computed(() => {
  // is_system_admin sees every role-scoped tab in addition to
  // their own concerns.
  return TABS.filter((t) => {
    if (t.role === null) return true
    if (auth.user?.is_system_admin) return true
    return auth.hasRole(t.role)
  })
})

const STORAGE_KEY = 'dashboard.activeTab.v1'
const activeTab = ref('org_admin')   // overridden in onMounted via smart-pick

function readStoredTab() {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    return v || null
  } catch { return null }
}
function writeStoredTab(id) {
  try { localStorage.setItem(STORAGE_KEY, id) } catch { /* ignore */ }
}
function setTab(id) {
  activeTab.value = id
  writeStoredTab(id)
  // Lazy-load data for the new tab if we haven't yet.
  ensureTabDataLoaded(id)
}

// ---- Pulse + per-tab data refs -----------------------------
// Loaded lazily; first hit triggers fetch, then cached. The
// `loaded` map prevents double-fetch on re-tab visits.
const events             = ref([])     // /api/events — used by org_admin + meet_manager + diver
const roleRequests       = ref([])     // /api/role-requests
const pendingOrgs        = ref([])     // /api/orgs filtered to pending (sysadmin)
const recentActivity     = ref([])     // /api/audit/recent
const judgeEvents        = ref([])     // /api/judge/my-events
const coachData          = ref(null)   // /api/coach/dashboard
const tabsLoaded         = ref(new Set())  // tab ids whose data is loaded

// Pulse derived from currently-loaded data. Each entry is
// optional (zero / null for users who don't have that role).
const liveCount = computed(() =>
  events.value.filter((e) => e.status === 'Live').length,
)
const upcomingCount = computed(() =>
  events.value.filter((e) => e.status === 'Upcoming').length,
)
const pendingCount = computed(() => {
  let n = roleRequests.value.length
  if (auth.user?.is_system_admin) n += pendingOrgs.value.length
  return n
})
// Diver-side: number of days until the soonest entries-close
// the diver would actually care about (events the diver is
// entered in OR all upcoming events as a fallback). Returns
// null when there's nothing approaching.
const diverEntryCloseDays = computed(() => {
  // Heuristic v1: closest entries_close_at across upcoming events.
  // Refinement: filter to events the diver is entered in once
  // we have that data — but this is good enough for the smart-
  // pick + pulse signal.
  const now = Date.now()
  let nearest = Infinity
  for (const ev of events.value) {
    if (ev.status !== 'Upcoming' || !ev.entries_close_at) continue
    const t = +new Date(ev.entries_close_at)
    if (t > now && t - now < nearest) nearest = t - now
  }
  if (!Number.isFinite(nearest)) return null
  return Math.max(0, Math.round(nearest / 86_400_000))
})

// ---- Smart-pick --------------------------------------------
// Called after the initial pulse fetch. Returns a tab id that
// the user should see first.
function pickInitialTab() {
  const roles = auth.user?.org_roles || []
  const visible = new Set(visibleTabs.value.map((t) => t.id))
  const has = (r) => visible.has(r) || (auth.user?.is_system_admin && TABS.some((t) => t.id === r))

  // 1. Any LIVE event for an operator → the operator tab.
  if (liveCount.value > 0) {
    if (has('org_admin'))    return 'org_admin'
    if (has('meet_manager')) return 'meet_manager'
  }
  // 2. Diver with entries close < 7 days → diver tab.
  if (diverEntryCloseDays.value != null && diverEntryCloseDays.value < 7 && has('diver')) {
    return 'diver'
  }
  // 3. Pending governance work for org_admin → org_admin tab.
  if (pendingCount.value > 0 && has('org_admin')) {
    return 'org_admin'
  }
  // 4. localStorage preference if still a valid tab.
  const stored = readStoredTab()
  if (stored && visible.has(stored)) return stored
  // 5. Fallback: most-privileged role the user has.
  for (const r of ['org_admin', 'meet_manager', 'referee', 'judge', 'coach', 'diver']) {
    if (has(r)) return r
  }
  return 'other'
}

// ---- Loaders -----------------------------------------------
// Each loader is idempotent — `tabsLoaded` set prevents
// re-fetch on re-tab visits. Errors swallowed; the panel
// renders an empty state if its data is missing.
async function loadOperatorEvents() {
  if (events.value.length || tabsLoaded.value.has('events')) return
  try {
    events.value = await auth.apiFetch('/api/events')
  } catch { /* silent */ }
  tabsLoaded.value.add('events')
}
async function loadRoleRequests() {
  if (tabsLoaded.value.has('role-requests')) return
  if (!auth.hasRole('org_admin')) return
  try {
    roleRequests.value = await auth.apiFetch('/api/role-requests')
  } catch { /* silent */ }
  tabsLoaded.value.add('role-requests')
}
async function loadPendingOrgs() {
  if (tabsLoaded.value.has('pending-orgs')) return
  if (!auth.user?.is_system_admin) return
  try {
    const orgs = await auth.apiFetch('/api/orgs')
    pendingOrgs.value = (orgs || []).filter((o) => o.status === 'pending')
  } catch { /* silent */ }
  tabsLoaded.value.add('pending-orgs')
}
async function loadRecentActivity() {
  if (tabsLoaded.value.has('activity')) return
  if (!auth.hasRole('org_admin')) return
  try {
    recentActivity.value = await auth.apiFetch('/api/audit/recent?limit=10&days=7')
  } catch { /* silent */ }
  tabsLoaded.value.add('activity')
}
async function loadJudgeEvents() {
  if (tabsLoaded.value.has('judge')) return
  if (!auth.hasRole('judge')) return
  try {
    judgeEvents.value = await auth.apiFetch('/api/judge/my-events')
  } catch { /* silent */ }
  tabsLoaded.value.add('judge')
}
async function loadCoachData() {
  if (tabsLoaded.value.has('coach')) return
  if (!auth.hasRole('coach')) return
  try {
    coachData.value = await auth.apiFetch('/api/coach/dashboard')
  } catch { /* silent */ }
  tabsLoaded.value.add('coach')
}

// Per-tab dispatcher. Org admin wants events + role requests +
// pending orgs (sysadmin) + recent activity. Meet manager
// reuses events. Judge / Coach are independent.
async function ensureTabDataLoaded(tab) {
  if (tab === 'org_admin') {
    await Promise.all([
      loadOperatorEvents(),
      loadRoleRequests(),
      loadPendingOrgs(),
      loadRecentActivity(),
    ])
  } else if (tab === 'meet_manager') {
    await loadOperatorEvents()
  } else if (tab === 'judge') {
    await loadJudgeEvents()
  } else if (tab === 'coach') {
    await loadCoachData()
  } else if (tab === 'diver') {
    await loadOperatorEvents()  // for "your next meet" — heuristic
  }
  // 'referee' and 'other' need no extra data right now.
}

// ---- Find Diver typeahead (preserved) -----------------------
const diverSearch    = ref('')
const diverResults   = ref([])
const diverSearching = ref(false)
const diverDropdown  = ref(false)
let   diverSearchT   = null
function onDiverSearchInput() {
  diverDropdown.value = true
  if (diverSearchT) clearTimeout(diverSearchT)
  const q = diverSearch.value.trim()
  if (q.length < 2) { diverResults.value = []; return }
  diverSearchT = setTimeout(async () => {
    diverSearching.value = true
    try {
      diverResults.value = await auth.apiFetch(
        `/api/divers/search?q=${encodeURIComponent(q)}`,
      )
    } catch {
      diverResults.value = []
    } finally {
      diverSearching.value = false
    }
  }, 200)
}
function openDiverProfile(id) {
  diverDropdown.value = false
  diverSearch.value = ''
  diverResults.value = []
  router.push(`/profile/${id}`)
}
function onDiverSearchBlur() {
  setTimeout(() => { diverDropdown.value = false }, 150)
}

// ---- Helpers -----------------------------------------------
function fmtCloses(iso) {
  if (!iso) return null
  const d = new Date(iso)
  const ms = d.getTime() - Date.now()
  if (ms < 0) return 'entries already closed'
  const day = 86_400_000
  if (ms < day) {
    const hr = Math.max(1, Math.round(ms / 3_600_000))
    return `entries close in ${hr}h`
  }
  if (ms < 7 * day) {
    const dy = Math.round(ms / day)
    return `entries close in ${dy} day${dy === 1 ? '' : 's'}`
  }
  return `entries close ${d.toLocaleString(undefined, { month: 'short', day: 'numeric' })}`
}
function fmtRelative(iso) {
  if (!iso) return ''
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const dy = Math.round(hr / 24)
  if (dy < 7) return `${dy}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

// ---- Tile catalog (now role-scoped per panel) --------------
// The flat allTiles config of the previous layout is gone; each
// panel renders its own role-scoped "GO TO" group. The Other
// tab carries the utility surfaces that don't belong to any
// single role. SVG icons from the old config preserved as-is so
// the visual language stays familiar.
const ICONS = {
  manager:        '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>',
  control:        '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>',
  judges:         '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>',
  users:          '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>',
  audit:          '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/></svg>',
  clubs:          '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21v-1a4 4 0 014-4h4a4 4 0 014 4v1M21 21v-1a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75M9 11a4 4 0 100-8 4 4 0 000 8z"/></svg>',
  teams:          '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>',
  scoreboard:     '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>',
  diveDir:        '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 17l2 2 4-4"/></svg>',
  signOff:        '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 11c0-1.105.895-2 2-2s2 .895 2 2-.895 2-2 2-2-.895-2-2zM5 7a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10h.01M9 14h.01M13 14h.01"/></svg>',
  profile:        '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 8a6 6 0 11-12 0 6 6 0 0112 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 22a9 9 0 0118 0H3z"/></svg>',
  diver:          '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>',
  coach:          '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-2a4 4 0 100-8 4 4 0 000 8zm6-4a4 4 0 100-8 4 4 0 000 8z"/></svg>',
  compare:        '<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l3-3m0 0l3 3m-3-3v12m9-12l3 3m0 0l-3 3m3-3H9"/></svg>',
}

// ---- Static data ------------------------------------------
const welcomeName = computed(() => auth.user?.full_name?.toUpperCase() || '—')
const roleLine    = computed(() => auth.formatRoles(auth.user?.org_roles || []))

function logout() {
  auth.clearSession()
  router.push('/login')
}

// Org-admin's "what needs your attention" cards — preserved
// from the old action-strip but now scoped inside the org_admin
// panel. Each card is one row.
const attentionCards = computed(() => {
  const cards = []
  for (const ev of events.value.filter((e) => e.status === 'Live')) {
    cards.push({
      id: 'live-' + ev.id,
      kind: 'live',
      icon: '🔴',
      title: `${ev.name} is LIVE`,
      meta: null,
      to: `/control?event=${ev.id}`,
    })
  }
  const upcoming = events.value
    .filter((e) => e.status === 'Upcoming')
    .sort((a, b) => {
      const ad = a.entries_close_at ? +new Date(a.entries_close_at) : Infinity
      const bd = b.entries_close_at ? +new Date(b.entries_close_at) : Infinity
      return ad - bd
    })
  for (const ev of upcoming) {
    cards.push({
      id: 'upcoming-' + ev.id,
      kind: 'upcoming',
      icon: '📅',
      title: `Prepare ${ev.name}`,
      meta: fmtCloses(ev.entries_close_at) || 'Walk through the pre-meet workflow',
      to: `/control?event=${ev.id}`,
    })
  }
  if (roleRequests.value.length) {
    const n = roleRequests.value.length
    cards.push({
      id:    'pending-roles',
      kind:  'pending',
      icon:  '👥',
      title: `${n} role request${n === 1 ? '' : 's'} waiting`,
      meta:  'Review role requests in User Manager',
      to:    '/users',
    })
  }
  if (auth.user?.is_system_admin && pendingOrgs.value.length) {
    const n = pendingOrgs.value.length
    cards.push({
      id:    'pending-orgs',
      kind:  'pending',
      icon:  '🏛',
      title: `${n} federation${n === 1 ? '' : 's'} awaiting approval`,
      meta:  'Review in User Manager → org filter',
      to:    '/users',
    })
  }
  return cards
})

// Meet Manager events — same /api/events fetch but presented
// as compact rows instead of attention cards.
const operatorEvents = computed(() => {
  // Sorted: live first, then upcoming by entries_close_at, then completed by date desc.
  const live = events.value.filter((e) => e.status === 'Live')
  const upcoming = events.value
    .filter((e) => e.status === 'Upcoming')
    .sort((a, b) => {
      const ad = a.entries_close_at ? +new Date(a.entries_close_at) : Infinity
      const bd = b.entries_close_at ? +new Date(b.entries_close_at) : Infinity
      return ad - bd
    })
  const completed = events.value
    .filter((e) => e.status === 'Completed')
    .sort((a, b) => +new Date(b.scheduled_at || 0) - +new Date(a.scheduled_at || 0))
    .slice(0, 3)
  return [...live, ...upcoming, ...completed]
})

// Diver next-meet heuristic — closest upcoming event by entries
// close. v1 doesn't filter to events the diver is actually
// entered in (we'd need a per-diver-event-list endpoint); the
// generic upcoming list is good enough.
const diverNextMeet = computed(() => {
  const upcoming = events.value
    .filter((e) => e.status === 'Upcoming')
    .sort((a, b) => {
      const ad = a.entries_close_at ? +new Date(a.entries_close_at) : Infinity
      const bd = b.entries_close_at ? +new Date(b.entries_close_at) : Infinity
      return ad - bd
    })
  return upcoming[0] || null
})

// Per-tab badge counts for the tab strip.
function badgeFor(id) {
  if (id === 'org_admin') {
    const n = liveCount.value + upcomingCount.value + pendingCount.value
    return n || null
  }
  if (id === 'meet_manager') {
    const n = liveCount.value + upcomingCount.value
    return n || null
  }
  if (id === 'judge') return judgeEvents.value.length || null
  if (id === 'coach') {
    const n = coachData.value?.divers?.length
    return n || null
  }
  return null
}

// ---- Mount -------------------------------------------------
onMounted(async () => {
  // First-run wizard auto-redirect (preserved). Triggers BEFORE
  // we touch tab logic, so a fresh org admin doesn't briefly
  // see the empty dashboard before bouncing.
  if (auth.hasRole('org_admin')) {
    let dismissed = false, completed = false
    try {
      dismissed = localStorage.getItem('setup.wizardDismissed.v1') === '1'
      completed = localStorage.getItem('setup.wizardCompleted.v1') === '1'
    } catch { /* localStorage blocked */ }
    if (!dismissed && !completed) {
      // Need event count to decide; load events first.
      await loadOperatorEvents()
      if (events.value.length === 0) {
        let clubCount = 0
        try {
          const clubs = await auth.apiFetch('/api/clubs')
          clubCount = (clubs || []).length
        } catch { /* leave 0 */ }
        if (clubCount === 0) {
          router.replace('/setup')
          return
        }
      }
    }
  }

  // Pulse data — fire all the cross-role fetches in parallel
  // so the strip and the smart-pick have something to chew on
  // ASAP. Only fetches the bits the user's roles authorise.
  await Promise.all([
    auth.hasAnyRole(['org_admin', 'meet_manager']) ? loadOperatorEvents() : Promise.resolve(),
    auth.hasRole('org_admin')   ? loadRoleRequests() : Promise.resolve(),
    auth.user?.is_system_admin  ? loadPendingOrgs()  : Promise.resolve(),
    auth.hasRole('judge')       ? loadJudgeEvents()  : Promise.resolve(),
    // Activity + coach are tab-on-demand; diver-leaning users
    // benefit from events fetched too for the "next meet" panel.
    auth.hasRole('diver')       ? loadOperatorEvents() : Promise.resolve(),
  ])

  // Now smart-pick has the signals it needs.
  activeTab.value = pickInitialTab()
  // Make sure the picked tab's data is fully loaded (some need
  // fetches the pulse step skipped, e.g. recent activity).
  await ensureTabDataLoaded(activeTab.value)
})
</script>

<template>
  <div class="dashboard">
    <div class="header-inner">
      <div class="header-welcome">
        <div class="welcome-label">Dive Recorder</div>
        <div class="welcome-name">{{ welcomeName }}</div>
        <div class="role-line">{{ roleLine }}</div>
      </div>
      <!-- Top-right account area: diver search + My Profile +
           Sign Out. Search lives here because users hunt for
           people the same way they hunt for their own profile —
           top-right "account / find someone" pattern. The
           dropdown is anchored to the input wrapper, so it
           drops below the input regardless of how the header
           wraps on narrow viewports. -->
      <div class="header-account">
        <div class="find-diver-wrapper">
          <input
            class="input find-diver-input"
            type="text"
            v-model="diverSearch"
            @input="onDiverSearchInput"
            @focus="diverDropdown = true"
            @blur="onDiverSearchBlur"
            placeholder="Search divers…"
            autocomplete="off"
            aria-label="Search divers"
          >
          <div v-if="diverDropdown && (diverResults.length || diverSearching || diverSearch.trim().length >= 2)"
               class="find-diver-dropdown">
            <div v-if="diverSearching" class="find-diver-empty">Searching…</div>
            <div v-else-if="!diverResults.length" class="find-diver-empty">
              No divers match that.
            </div>
            <button
              v-for="r in diverResults"
              :key="r.id"
              type="button"
              class="find-diver-row"
              @mousedown.prevent="openDiverProfile(r.id)"
            >
              <span class="find-diver-name">{{ r.full_name }}</span>
              <span v-if="r.country_code" class="find-diver-country">{{ r.country_code }}</span>
              <span v-if="r.club_name" class="find-diver-club">
                {{ r.club_name }}<span v-if="r.club_code" class="find-diver-club-code">{{ r.club_code }}</span>
              </span>
            </button>
          </div>
        </div>
        <RouterLink to="/profile" class="btn btn-ghost">My Profile</RouterLink>
        <button class="btn btn-ghost" @click="logout">Sign Out</button>
      </div>
    </div>

    <!-- Pulse strip — always-visible cross-role digest. -->
    <div class="pulse-strip">
      <span v-if="liveCount" class="pulse-bit pulse-live">
        <span class="pulse-num">{{ liveCount }}</span> LIVE
      </span>
      <span v-if="upcomingCount" class="pulse-bit pulse-upcoming">
        <span class="pulse-num">{{ upcomingCount }}</span> UPCOMING
      </span>
      <span v-if="pendingCount" class="pulse-bit pulse-pending">
        <span class="pulse-num">{{ pendingCount }}</span> PENDING
      </span>
      <span v-if="diverEntryCloseDays != null && auth.hasRole('diver')" class="pulse-bit pulse-diver">
        entries close in
        <span class="pulse-num">{{ diverEntryCloseDays }}</span> day{{ diverEntryCloseDays === 1 ? '' : 's' }}
      </span>
      <span v-if="judgeEvents.length && auth.hasRole('judge')" class="pulse-bit pulse-judge">
        <span class="pulse-num">{{ judgeEvents.length }}</span>
        judging assignment{{ judgeEvents.length === 1 ? '' : 's' }}
      </span>
      <span v-if="!liveCount && !upcomingCount && !pendingCount && diverEntryCloseDays == null && !judgeEvents.length"
            class="pulse-quiet">
        All quiet — nothing pending.
      </span>
    </div>

    <!-- Tab strip — one tab per visible role + Other. -->
    <div class="tab-strip" role="tablist">
      <button
        v-for="t in visibleTabs"
        :key="t.id"
        type="button"
        :class="['tab', activeTab === t.id ? 'tab-active' : '']"
        :aria-selected="activeTab === t.id"
        @click="setTab(t.id)"
      >
        {{ t.label }}
        <span v-if="badgeFor(t.id)" class="tab-badge">{{ badgeFor(t.id) }}</span>
      </button>
    </div>

    <!-- ===========================================
         Active panels — one v-if per tab.
         =========================================== -->

    <!-- ORG ADMIN -->
    <section v-if="activeTab === 'org_admin'" class="panel">
      <div v-if="!attentionCards.length && !recentActivity.length" class="empty-state-card">
        <div class="empty-state-icon">📊</div>
        <div class="empty-state-title">All quiet</div>
        <div class="empty-state-body">
          No live events, no upcoming meets within the entries-close window,
          and no role requests waiting. Use the GO TO links below to dive in.
        </div>
      </div>

      <div v-if="attentionCards.length" class="panel-section">
        <div class="panel-section-label">What needs your attention</div>
        <RouterLink
          v-for="card in attentionCards"
          :key="card.id"
          :to="card.to"
          :class="['action-card', `action-card-${card.kind}`]"
        >
          <span class="action-card-icon">{{ card.icon }}</span>
          <span class="action-card-title">{{ card.title }}</span>
          <span v-if="card.meta" class="action-card-meta">{{ card.meta }}</span>
          <span class="action-card-arrow" aria-hidden="true">→</span>
        </RouterLink>
      </div>

      <div v-if="recentActivity.length" class="panel-section">
        <div class="panel-section-label">Recent activity (7 days)</div>
        <ul class="activity-list">
          <li v-for="r in recentActivity" :key="`${r.kind}-${r.id}`" class="activity-item">
            <span class="activity-time">{{ fmtRelative(r.created_at) }}</span>
            <span class="activity-text">
              <template v-if="r.kind === 'score'">
                <strong>{{ r.competitor_name || 'Competitor' }}</strong>
                {{ r.action === 'update' ? 'score amended in' : r.action === 'delete' ? 'score deleted in' : 'score in' }}
                {{ r.event_name }}<template v-if="r.round_number"> · R{{ r.round_number }}</template>
              </template>
              <template v-else-if="r.kind === 'role'">
                <strong>{{ r.role }}</strong> {{ r.action }} {{ r.action === 'granted' ? 'to' : 'from' }} <strong>{{ r.target_name }}</strong>
              </template>
              <template v-else>
                <strong>{{ r.entity_name || r.entity_type }}</strong> · {{ r.action.replace(/^[a-z_]+\./, '').replace(/_/g, ' ') }}
              </template>
            </span>
          </li>
        </ul>
        <RouterLink to="/audit" class="panel-section-link">View full audit log →</RouterLink>
      </div>

      <div class="panel-section">
        <div class="panel-section-label">Go to</div>
        <div class="goto-grid">
          <RouterLink to="/manager" class="goto-tile tile-amber">
            <div class="goto-icon" v-html="ICONS.manager"></div>
            <div class="goto-title">Meet Manager</div>
          </RouterLink>
          <RouterLink to="/control" class="goto-tile tile-cyan">
            <div class="goto-icon" v-html="ICONS.control"></div>
            <div class="goto-title">Control Room</div>
          </RouterLink>
          <RouterLink to="/users" class="goto-tile tile-purple">
            <div class="goto-icon" v-html="ICONS.users"></div>
            <div class="goto-title">User Manager</div>
          </RouterLink>
          <RouterLink to="/audit" class="goto-tile tile-amber">
            <div class="goto-icon" v-html="ICONS.audit"></div>
            <div class="goto-title">Audit Log</div>
          </RouterLink>
          <RouterLink to="/clubs" class="goto-tile tile-green">
            <div class="goto-icon" v-html="ICONS.clubs"></div>
            <div class="goto-title">Clubs</div>
          </RouterLink>
          <RouterLink to="/teams" class="goto-tile tile-purple">
            <div class="goto-icon" v-html="ICONS.teams"></div>
            <div class="goto-title">Teams</div>
          </RouterLink>
          <RouterLink to="/assign-judges" class="goto-tile tile-cyan">
            <div class="goto-icon" v-html="ICONS.judges"></div>
            <div class="goto-title">Assign Judges</div>
          </RouterLink>
        </div>
      </div>
    </section>

    <!-- MEET MANAGER -->
    <section v-else-if="activeTab === 'meet_manager'" class="panel">
      <div v-if="!operatorEvents.length" class="empty-state-card">
        <div class="empty-state-icon">📅</div>
        <div class="empty-state-title">No events yet</div>
        <div class="empty-state-body">
          Build your first event in <strong>Meet Manager</strong>. The pre-meet
          workflow walks you through check-in, randomise, sign-off, and start.
        </div>
      </div>

      <div v-if="operatorEvents.length" class="panel-section">
        <div class="panel-section-label">Your events</div>
        <RouterLink
          v-for="ev in operatorEvents"
          :key="ev.id"
          :to="ev.status === 'Completed' ? `/scoreboard/${ev.id}` : `/control?event=${ev.id}`"
          :class="['event-row', `event-row-${ev.status.toLowerCase()}`]"
        >
          <span :class="['event-row-status', `evrs-${ev.status.toLowerCase()}`]">
            {{ ev.status === 'Live' ? '🔴 LIVE' : ev.status === 'Upcoming' ? '📅' : '✓' }}
          </span>
          <span class="event-row-name">{{ ev.name }}</span>
          <span v-if="ev.status === 'Upcoming' && ev.entries_close_at" class="event-row-meta">
            {{ fmtCloses(ev.entries_close_at) }}
          </span>
          <span v-else-if="ev.status === 'Completed'" class="event-row-meta">Completed</span>
          <span v-else-if="ev.status === 'Live'" class="event-row-meta">Open Control Room</span>
          <span class="event-row-arrow" aria-hidden="true">→</span>
        </RouterLink>
      </div>

      <div class="panel-section">
        <div class="panel-section-label">Go to</div>
        <div class="goto-grid">
          <RouterLink to="/manager" class="goto-tile tile-amber">
            <div class="goto-icon" v-html="ICONS.manager"></div>
            <div class="goto-title">Meet Manager</div>
          </RouterLink>
          <RouterLink to="/control" class="goto-tile tile-cyan">
            <div class="goto-icon" v-html="ICONS.control"></div>
            <div class="goto-title">Control Room</div>
          </RouterLink>
          <RouterLink to="/assign-judges" class="goto-tile tile-cyan">
            <div class="goto-icon" v-html="ICONS.judges"></div>
            <div class="goto-title">Assign Judges</div>
          </RouterLink>
        </div>
      </div>
    </section>

    <!-- REFEREE -->
    <section v-else-if="activeTab === 'referee'" class="panel">
      <div class="panel-section">
        <div class="panel-section-label">As a referee</div>
        <p class="panel-blurb">
          Meet managers send sign-off requests to your device when their pre-meet
          workflow reaches the yellow Sign Off step. You can also enter a 6-digit
          handoff code on your own device via the link below.
        </p>
      </div>
      <div class="panel-section">
        <div class="panel-section-label">Go to</div>
        <div class="goto-grid">
          <RouterLink to="/sign-off-codes" class="goto-tile tile-amber">
            <div class="goto-icon" v-html="ICONS.signOff"></div>
            <div class="goto-title">Sign-Off Codes</div>
          </RouterLink>
        </div>
      </div>
    </section>

    <!-- JUDGE -->
    <section v-else-if="activeTab === 'judge'" class="panel">
      <div v-if="!judgeEvents.length" class="empty-state-card">
        <div class="empty-state-icon">⚖️</div>
        <div class="empty-state-title">No events assigned yet</div>
        <div class="empty-state-body">
          The meet manager will add you to a panel ahead of the next event.
          You'll see assignments here when that happens.
        </div>
      </div>
      <div v-if="judgeEvents.length" class="panel-section">
        <div class="panel-section-label">Your assigned events</div>
        <RouterLink
          v-for="ev in judgeEvents"
          :key="ev.id"
          :to="`/judge?event=${ev.id}`"
          :class="['event-row', `event-row-${ev.status.toLowerCase()}`]"
        >
          <span :class="['event-row-status', `evrs-${ev.status.toLowerCase()}`]">
            {{ ev.status === 'Live' ? '🔴 LIVE' : ev.status === 'Upcoming' ? '📅' : '✓' }}
          </span>
          <span class="event-row-name">{{ ev.name }}</span>
          <span class="event-row-meta">
            {{ ev.total_rounds }} rounds · {{ ev.number_of_judges }} judges
          </span>
          <span class="event-row-arrow" aria-hidden="true">→</span>
        </RouterLink>
      </div>
    </section>

    <!-- COACH -->
    <section v-else-if="activeTab === 'coach'" class="panel">
      <div v-if="!coachData?.divers?.length" class="empty-state-card">
        <div class="empty-state-icon">🎓</div>
        <div class="empty-state-title">No divers linked yet</div>
        <div class="empty-state-body">
          Ask your org admin to link you to the divers you mentor. Once approved
          you'll see their profiles, PBs, and analytics here.
        </div>
      </div>
      <div v-if="coachData?.divers?.length" class="panel-section">
        <div class="panel-section-label">Your divers ({{ coachData.divers.length }})</div>
        <p class="panel-blurb">Open the Coach Dashboard for full per-diver analytics, score trends, and templates.</p>
      </div>
      <div class="panel-section">
        <div class="panel-section-label">Go to</div>
        <div class="goto-grid">
          <RouterLink to="/coach" class="goto-tile tile-purple">
            <div class="goto-icon" v-html="ICONS.coach"></div>
            <div class="goto-title">Coach Dashboard</div>
          </RouterLink>
          <RouterLink to="/compare" class="goto-tile tile-amber">
            <div class="goto-icon" v-html="ICONS.compare"></div>
            <div class="goto-title">Compare Divers</div>
          </RouterLink>
        </div>
      </div>
    </section>

    <!-- DIVER -->
    <section v-else-if="activeTab === 'diver'" class="panel">
      <div v-if="diverNextMeet" class="panel-section">
        <div class="panel-section-label">Your next meet</div>
        <RouterLink :to="`/competitor`" class="diver-next-card">
          <div class="diver-next-name">{{ diverNextMeet.name }}</div>
          <div class="diver-next-meta">
            {{ fmtCloses(diverNextMeet.entries_close_at) || 'Walk through the dive list builder' }}
          </div>
          <div class="diver-next-arrow" aria-hidden="true">→</div>
        </RouterLink>
      </div>
      <div v-else class="empty-state-card">
        <div class="empty-state-icon">🤿</div>
        <div class="empty-state-title">No upcoming meets</div>
        <div class="empty-state-body">
          When your federation lists an upcoming event, it'll show up here with
          an "entries close in" countdown. Open the Diver Portal to see all
          events your federation is running.
        </div>
      </div>

      <div class="panel-section">
        <div class="panel-section-label">Go to</div>
        <div class="goto-grid">
          <RouterLink to="/competitor" class="goto-tile tile-green">
            <div class="goto-icon" v-html="ICONS.diver"></div>
            <div class="goto-title">Submit Dive Sheets</div>
          </RouterLink>
          <RouterLink to="/profile" class="goto-tile tile-cyan">
            <div class="goto-icon" v-html="ICONS.profile"></div>
            <div class="goto-title">My Profile</div>
          </RouterLink>
          <RouterLink to="/compare" class="goto-tile tile-amber">
            <div class="goto-icon" v-html="ICONS.compare"></div>
            <div class="goto-title">Compare Divers</div>
          </RouterLink>
        </div>
      </div>
    </section>

    <!-- OTHER — utility surfaces. Always available. -->
    <section v-else-if="activeTab === 'other'" class="panel">
      <div class="panel-section">
        <div class="panel-section-label">Other surfaces</div>
        <div class="goto-grid">
          <RouterLink to="/scoreboard" class="goto-tile tile-red">
            <div class="goto-icon" v-html="ICONS.scoreboard"></div>
            <div class="goto-title">Scoreboard &amp; Results</div>
            <div class="goto-desc">Watch live meets or browse completed-meet recaps.</div>
          </RouterLink>
          <RouterLink to="/dive-directory" class="goto-tile tile-cyan">
            <div class="goto-icon" v-html="ICONS.diveDir"></div>
            <div class="goto-title">Dive Directory</div>
            <div class="goto-desc">Look up DDs across the World Aquatics catalog.</div>
          </RouterLink>
          <RouterLink to="/compare" class="goto-tile tile-amber">
            <div class="goto-icon" v-html="ICONS.compare"></div>
            <div class="goto-title">Compare Divers</div>
            <div class="goto-desc">Two divers side-by-side — stats and PB diffs.</div>
          </RouterLink>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* Dashboard wrapper — clamps horizontal overflow at the page
   level. */
.dashboard {
  overflow-x: hidden;
  width: 100%;
  padding-bottom: 4rem;
}

.header-inner {
  display: flex; align-items: flex-start; justify-content: space-between;
  flex-wrap: wrap; gap: 1rem;
  padding: 2.5rem 2rem 2rem;
  max-width: 1400px; margin: 0 auto;
  border-bottom: 1px solid var(--border);
  min-width: 0;
}
.header-welcome {
  /* Allow the welcome block to shrink so the account area on
     the right has room for the search box without forcing the
     whole header wider than the viewport. */
  min-width: 0;
  flex: 1 1 auto;
}
.welcome-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.welcome-name  {
  font-family: var(--font-display); font-weight: 900; font-style: italic;
  line-height: 1; color: var(--text);
  font-size: clamp(32px, 6vw, 56px);
  word-break: break-word;
}
.role-line {
  font-family: var(--font-display); font-size: 11px; font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.5rem;
  white-space: normal; word-break: break-word;
}

/* Account-area buttons (and the diver-search input) in the
   top-right of the header. Search + My Profile + Sign Out stay
   on a single line within this block; the parent .header-inner
   wraps the whole block below the welcome on narrow viewports
   if needed. */
.header-account {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}
.header-account .btn { text-decoration: none; white-space: nowrap; }

/* Find Diver — typeahead lives in the top-right account row.
   Wrapper provides the relative-positioning anchor for the
   absolutely-positioned dropdown so the suggestion list drops
   immediately below the input regardless of where the header
   wraps to on narrow viewports. */
.find-diver-wrapper {
  position: relative;
  /* Fixed-ish width: takes 240px when there's room, can shrink
     down to 160px on narrow viewports before the parent
     .header-inner wraps the whole .header-account block below
     the welcome name. */
  flex: 0 1 240px;
  min-width: 160px;
}
.find-diver-input {
  width: 100%;
  font-size: 13px;
  padding: 0.55rem 0.85rem;
}
.find-diver-dropdown {
  position: absolute;
  top: calc(100% + 0.25rem);
  /* Anchor to the input's right edge and grow leftward — keeps
     the dropdown on-screen even though the input is squeezed
     into the right side of the header. The dropdown is wider
     than the input so club/country chips fit comfortably. */
  right: 0; left: auto;
  min-width: 320px;
  max-width: min(420px, 90vw);
  z-index: 50;
  background: var(--surface); border: 1px solid var(--border-2);
  border-radius: var(--radius);
  box-shadow: 0 16px 36px rgba(0,0,0,0.45);
  max-height: 320px; overflow-y: auto;
}
.find-diver-empty {
  padding: 0.75rem 1rem;
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  font-style: italic;
}
.find-diver-row {
  display: flex; align-items: baseline; gap: 0.5rem;
  width: 100%; text-align: left;
  padding: 0.6rem 1rem;
  background: transparent; border: none;
  border-bottom: 1px solid var(--border);
  cursor: pointer; color: var(--text);
  font-family: var(--font-mono); transition: background 0.1s;
}
.find-diver-row:last-child { border-bottom: none; }
.find-diver-row:hover { background: var(--bg-3); }
.find-diver-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text);
}
.find-diver-country {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.3rem;
}
.find-diver-club { font-size: 11px; color: var(--text-3); margin-left: auto;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.find-diver-club-code { font-weight: 700; color: var(--cyan); margin-left: 0.4rem; }

/* Pulse strip — always-visible cross-role digest. Sits above
   the tabs so a multi-role user sees activity in roles other
   than their active tab without switching. Width math: the
   strip's outer edges align with the inner-content edges of
   the surrounding sections (which use `padding: 0 2rem` inside
   a 1400px max-width). 1400 - (2 × 2rem) = 1400px - 4rem. */
.pulse-strip {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 0.45rem 1.1rem;
  width: calc(100% - 4rem);
  max-width: calc(1400px - 4rem);
  margin: 1.25rem auto 0;
  padding: 0.75rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--text-3);
}
.pulse-bit {
  display: inline-flex; align-items: center; gap: 0.4rem;
}
.pulse-num {
  font-family: var(--font-mono);
  font-size: 13px; font-weight: 800;
  letter-spacing: 0;
  padding: 0.05rem 0.5rem;
  border-radius: 3px;
  background: var(--bg-2);
  border: 1px solid var(--border);
}
.pulse-live    .pulse-num { color: var(--red);   border-color: rgba(239,68,68,0.4);   background: rgba(239,68,68,0.08); }
.pulse-upcoming .pulse-num { color: var(--cyan);  border-color: rgba(6,182,212,0.4);   background: rgba(6,182,212,0.08); }
.pulse-pending .pulse-num { color: #a78bfa;      border-color: rgba(167,139,250,0.4); background: rgba(167,139,250,0.08); }
.pulse-diver   .pulse-num { color: var(--green); border-color: rgba(16,185,129,0.4);  background: rgba(16,185,129,0.08); }
.pulse-judge   .pulse-num { color: var(--amber); border-color: rgba(245,158,11,0.4);  background: rgba(245,158,11,0.08); }
.pulse-quiet {
  font-family: var(--font-mono); font-size: 12px; font-weight: 500;
  letter-spacing: 0.04em; text-transform: none; color: var(--text-3);
  font-style: italic;
}

/* Tab strip — primary navigation, so styled with the same
   display-italic typography the rest of the dashboard uses
   for "important things". Active tab gets a subtle cyan tint
   + thicker bottom border to read as the current section,
   not a button. Hover paints a hint so the strip feels
   interactive even before any click. */
.tab-strip {
  display: flex; align-items: stretch; gap: 0.15rem;
  flex-wrap: wrap;
  max-width: 1400px; margin: 1.5rem auto 0;
  padding: 0 2rem;
  border-bottom: 1px solid var(--border);
}
.tab {
  background: transparent; border: 0;
  padding: 0.95rem 1.4rem;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 800;
  font-style: italic;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--text-3);
  cursor: pointer;
  border-bottom: 3px solid transparent;
  margin-bottom: -1px;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
  display: inline-flex; align-items: center; gap: 0.55rem;
  border-radius: 6px 6px 0 0;
}
.tab:hover {
  color: var(--text);
  background: var(--bg-3);
}
.tab-active {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
  background: rgba(6, 182, 212, 0.06);
}
.tab-active:hover {
  /* Don't darken the active tab on hover — it should read as
     "you are here", not "you can click this". */
  background: rgba(6, 182, 212, 0.06);
}
.tab-badge {
  font-family: var(--font-mono);
  font-size: 11px; font-weight: 700;
  font-style: normal;        /* override the parent italic */
  letter-spacing: 0;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: var(--bg-3);
  border: 1px solid var(--border);
  color: inherit;
}
.tab-active .tab-badge {
  background: var(--cyan-dim);
  border-color: var(--cyan);
}

/* Panel container */
.panel {
  max-width: 1400px;
  margin: 1.5rem auto 0;
  padding: 0 2rem;
}
.panel-section { margin-bottom: 2.25rem; }
.panel-section-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--text-3); margin-bottom: 0.85rem;
}
.panel-section-link {
  display: inline-block; margin-top: 0.5rem;
  font-family: var(--font-mono); font-size: 12px;
  color: var(--cyan); text-decoration: none;
}
.panel-section-link:hover { text-decoration: underline; }
.panel-blurb {
  font-family: var(--font-mono); font-size: 13px; line-height: 1.6;
  color: var(--text-2);
  max-width: 640px;
  margin: 0;
}

/* Action cards (org admin attention list) */
.action-card {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.6rem 0.95rem;
  margin-bottom: 0.4rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-radius: var(--radius);
  text-decoration: none;
  transition: transform 0.15s, border-color 0.15s, background 0.15s;
}
.action-card:hover { transform: translateX(2px); border-color: var(--border-2); }
.action-card-live    { border-left-color: var(--red);  background: rgba(239,68,68,0.04); }
.action-card-live:hover    { background: rgba(239,68,68,0.09); border-color: rgba(239,68,68,0.4); }
.action-card-upcoming{ border-left-color: var(--cyan); }
.action-card-upcoming:hover{ border-color: rgba(6,182,212,0.4); }
.action-card-pending { border-left-color: #a78bfa; background: rgba(167,139,250,0.04); }
.action-card-pending:hover { border-color: rgba(167,139,250,0.5); background: rgba(167,139,250,0.08); }

.action-card-icon { font-size: 14px; line-height: 1; flex-shrink: 0; }
.action-card-title {
  font-family: var(--font-display); font-size: 14px; font-weight: 800;
  font-style: italic; letter-spacing: 0.02em;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 1 1 auto; min-width: 0;
}
.action-card-meta {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 0 1 auto; min-width: 0;
}
.action-card-meta::before { content: '·'; margin-right: 0.5rem; color: var(--text-3); }
.action-card-arrow {
  font-family: var(--font-display); font-size: 16px;
  color: var(--text-3);
  margin-left: auto;
  transition: transform 0.15s, color 0.15s;
  flex-shrink: 0;
}
.action-card:hover .action-card-arrow { transform: translateX(3px); color: var(--cyan); }

/* Activity list (org admin recent feed) */
.activity-list {
  list-style: none; padding: 0; margin: 0;
}
.activity-item {
  display: flex; gap: 0.85rem;
  padding: 0.5rem 0;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 13px; color: var(--text-2);
  line-height: 1.5;
}
.activity-item:last-child { border-bottom: none; }
.activity-time {
  flex-shrink: 0;
  width: 90px;
  font-size: 11px;
  color: var(--text-3);
  letter-spacing: 0.04em;
}
.activity-text { min-width: 0; }
.activity-text strong { font-family: var(--font-display); font-style: italic; color: var(--text); }

/* Event rows (meet manager + judge) */
.event-row {
  display: flex; align-items: center; gap: 0.85rem;
  padding: 0.7rem 1rem;
  margin-bottom: 0.45rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  text-decoration: none;
  transition: border-color 0.15s, transform 0.15s;
}
.event-row:hover { transform: translateX(2px); border-color: var(--border-2); }
.event-row-status {
  font-family: var(--font-display); font-size: 10.5px; font-weight: 800;
  letter-spacing: 0.12em;
  flex-shrink: 0;
  min-width: 60px;
}
.evrs-live { color: var(--red); }
.evrs-upcoming { color: var(--cyan); }
.evrs-completed { color: var(--text-3); }
.event-row-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text);
  flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.event-row-meta {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  flex-shrink: 0;
}
.event-row-arrow { color: var(--text-3); font-size: 16px; }
.event-row:hover .event-row-arrow { color: var(--cyan); }

/* Diver next meet card */
.diver-next-card {
  display: flex; flex-direction: column;
  gap: 0.4rem;
  padding: 1.4rem 1.5rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-left: 4px solid var(--green);
  border-radius: var(--radius-lg);
  text-decoration: none;
  position: relative;
  transition: border-color 0.15s, transform 0.15s;
}
.diver-next-card:hover { transform: translateX(2px); border-color: var(--green); }
.diver-next-name {
  font-family: var(--font-display); font-size: 22px; font-weight: 800;
  font-style: italic; color: var(--text); letter-spacing: 0.02em;
}
.diver-next-meta {
  font-family: var(--font-mono); font-size: 13px; color: var(--green);
}
.diver-next-arrow {
  position: absolute; top: 50%; right: 1.4rem;
  transform: translateY(-50%);
  font-size: 22px; color: var(--text-3);
  transition: color 0.15s, transform 0.15s;
}
.diver-next-card:hover .diver-next-arrow { color: var(--green); transform: translate(3px, -50%); }

/* GO TO tiles — small grid per panel */
.goto-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 220px), 1fr));
  gap: 0.85rem;
}
.goto-tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.25rem 1.4rem;
  text-decoration: none;
  display: flex; flex-direction: column;
  gap: 0.55rem;
  transition: border-color 0.15s, transform 0.15s;
}
.goto-tile:hover { transform: translateY(-1px); border-color: var(--tc, var(--cyan)); }
.tile-cyan   { --tc: var(--cyan);  }
.tile-amber  { --tc: var(--amber); }
.tile-green  { --tc: var(--green); }
.tile-red    { --tc: var(--red);   }
.tile-purple { --tc: #a78bfa;      }

.goto-icon {
  width: 36px; height: 36px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex; align-items: center; justify-content: center;
  color: var(--tc, var(--text-2));
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}
.goto-tile:hover .goto-icon { background: var(--tc, var(--cyan)); color: var(--bg); border-color: transparent; }
.goto-title {
  font-family: var(--font-display); font-size: 16px; font-weight: 800;
  font-style: italic; letter-spacing: 0.02em; color: var(--text);
}
.goto-desc {
  font-family: var(--font-mono); font-size: 11.5px;
  color: var(--text-3); line-height: 1.5;
}

/* Empty-state cards (per panel) — same shape as the global
   empty state used elsewhere in the app. Local copy because
   this view doesn't pull the global app.css class. */
.empty-state-card {
  background: var(--surface);
  border: 1px dashed var(--border-2);
  border-radius: var(--radius-lg);
  padding: 2rem;
  text-align: center;
  margin-bottom: 1.5rem;
  max-width: 640px;
}
.empty-state-icon {
  font-size: 28px; margin-bottom: 0.75rem;
}
.empty-state-title {
  font-family: var(--font-display); font-size: 16px; font-weight: 800;
  font-style: italic; color: var(--text); margin-bottom: 0.5rem;
}
.empty-state-body {
  font-family: var(--font-mono); font-size: 13px; line-height: 1.55;
  color: var(--text-3);
}
</style>
