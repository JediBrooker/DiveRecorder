<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const judgeEvents = ref([])
const showJudgeSection = computed(() => auth.hasRole('judge'))

// "What needs your attention" action cards. Live events the
// operator can drive get top priority; nearest-deadline
// Upcoming events come next. Driven off /api/events which
// the user already has access to. The card grid below stays
// as the secondary navigation surface — this section is the
// "do this now" cue, the grid is "everywhere I can go".
const events = ref([])
const showActionCards = computed(() =>
  auth.hasAnyRole(['org_admin', 'meet_manager']),
)
function fmtCloses(iso) {
  if (!iso) return null
  const d = new Date(iso)
  const now = Date.now()
  const ms = d.getTime() - now
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
const actionCards = computed(() => {
  if (!showActionCards.value) return []
  const cards = []
  // Live events — single-tap return to the Control Room. Title
  // already carries "is LIVE" so meta stays empty in the
  // compact row layout (saves vertical space when an org is
  // running multiple meets simultaneously).
  for (const ev of events.value.filter(e => e.status === 'Live')) {
    cards.push({
      id: 'live-' + ev.id,
      kind: 'live',
      icon: '🔴',
      title: `${ev.name} is LIVE`,
      meta: null,
      to: `/control?event=${ev.id}`,
    })
  }
  // Upcoming events sorted by closest deadline first. No fixed
  // slice — the preview-cap below limits visible rows and the
  // Show-more toggle expands when an operator wants the full
  // list.
  const upcoming = events.value
    .filter(e => e.status === 'Upcoming')
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
  return cards
})

// Collapsible "what needs your attention" — when an org is
// running multiple meets, the full-card layout drowned the
// dashboard. New layout is single-line rows, capped at 5 by
// default with a "Show N more" toggle, and the whole section
// can be folded behind its header. State sticks via
// localStorage so an operator who hides it stays hidden across
// sessions.
const ATTENTION_KEY     = 'dashboard.attentionOpen.v1'
const ATTENTION_PREVIEW = 5
const attentionOpen     = ref(true)
const attentionShowAll  = ref(false)
try {
  if (typeof localStorage !== 'undefined'
      && localStorage.getItem(ATTENTION_KEY) === 'false') {
    attentionOpen.value = false
  }
} catch { /* localStorage may be blocked; default open */ }
function toggleAttention() {
  attentionOpen.value = !attentionOpen.value
  // Reset show-all whenever the section closes so reopening
  // starts at the friendly preview length again.
  if (!attentionOpen.value) attentionShowAll.value = false
  try { localStorage.setItem(ATTENTION_KEY, String(attentionOpen.value)) } catch {}
}
const liveCount = computed(() =>
  actionCards.value.filter(c => c.kind === 'live').length,
)
const upcomingCount = computed(() =>
  actionCards.value.filter(c => c.kind === 'upcoming').length,
)
const visibleAttentionCards = computed(() => {
  if (attentionShowAll.value) return actionCards.value
  return actionCards.value.slice(0, ATTENTION_PREVIEW)
})

// =========================================================
// Find Diver — global typeahead so anyone on the dashboard
// can jump to another diver's profile. Hits the existing
// /api/divers/search endpoint (verifyToken-gated, returns up
// to 20 matching divers) and routes to /profile/<id> on
// click. Min 2 chars before searching to keep the typeahead
// noise-free.
// =========================================================
const diverSearch    = ref('')
const diverResults   = ref([])
const diverSearching = ref(false)
const diverDropdown  = ref(false)
let   diverSearchT   = null
function onDiverSearchInput() {
  diverDropdown.value = true
  if (diverSearchT) clearTimeout(diverSearchT)
  const q = diverSearch.value.trim()
  if (q.length < 2) {
    diverResults.value = []
    return
  }
  // Debounce so the typeahead doesn't fire on every keystroke.
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
  // Delay so a click on a result registers before the dropdown
  // disappears. Mousedown fires before blur on the same
  // click — this gives the click handler 150ms to win.
  setTimeout(() => { diverDropdown.value = false }, 150)
}

const allTiles = [
  {
    id: 'profile',
    roles: ['diver'],
    to: '/profile',
    colour: 'tile-cyan',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 8a6 6 0 11-12 0 6 6 0 0112 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 22a9 9 0 0118 0H3z"/></svg>`,
    title: 'My Profile',
    desc: 'Personal bests, average DD, and your score progression across meets.',
    action: 'View Profile',
  },
  {
    id: 'diver',
    roles: ['diver'],
    to: '/competitor',
    colour: 'tile-green',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>`,
    title: 'Submit Dive Sheets',
    desc: 'Submit your dive list and verify DD requirements for the meet.',
    action: 'Submit Dive Sheets',
  },
  {
    id: 'coach',
    roles: ['coach'],
    to: '/coach',
    colour: 'tile-purple',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a4 4 0 00-3-3.87M9 20H4v-2a4 4 0 013-3.87m6-2a4 4 0 100-8 4 4 0 000 8zm6-4a4 4 0 100-8 4 4 0 000 8z"/></svg>`,
    title: 'My Divers',
    desc: 'See every diver you coach — jump straight into their PBs and score trends.',
    action: 'View Divers',
  },
  {
    id: 'compare',
    roles: ['org_admin', 'meet_manager', 'coach'],
    to: '/compare',
    colour: 'tile-amber',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 12l3-3m0 0l3 3m-3-3v12m9-12l3 3m0 0l-3 3m3-3H9"/></svg>`,
    title: 'Compare Divers',
    desc: 'Pick two divers to see headline stats and personal bests side by side.',
    action: 'Open Comparison',
  },
  {
    id: 'control',
    roles: ['org_admin', 'meet_manager', 'referee'],
    to: '/control',
    colour: 'tile-cyan',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>`,
    title: 'Control Room',
    desc: 'Manage the live meet — set active divers, monitor judge scoring.',
    action: 'Launch Control',
  },
  {
    id: 'manager',
    roles: ['org_admin', 'meet_manager'],
    to: '/manager',
    colour: 'tile-amber',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>`,
    title: 'Meet Manager',
    desc: 'Create and configure competition events, set panels and rounds.',
    action: 'Manage Meets',
  },
  {
    id: 'judges',
    roles: ['org_admin', 'meet_manager'],
    to: '/assign-judges',
    colour: 'tile-cyan',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"/></svg>`,
    title: 'Assign Judges',
    desc: 'Build scoring panels and assign judges to specific events.',
    action: 'Setup Panels',
  },
  {
    id: 'users',
    roles: ['org_admin'],
    to: '/users',
    colour: 'tile-purple',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>`,
    title: 'User Manager',
    desc: 'Review role requests and manage member access across your org.',
    action: 'Manage Users',
  },
  {
    id: 'clubs',
    roles: ['org_admin', 'meet_manager'],
    to: '/clubs',
    colour: 'tile-green',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 21v-1a4 4 0 014-4h4a4 4 0 014 4v1M21 21v-1a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75M9 11a4 4 0 100-8 4 4 0 000 8z"/></svg>`,
    title: 'Clubs',
    desc: 'Create, rename and manage clubs within your organisation.',
    action: 'Manage Clubs',
  },
  {
    id: 'teams',
    roles: ['org_admin', 'meet_manager'],
    to: '/teams',
    colour: 'tile-purple',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"/></svg>`,
    title: 'Teams',
    desc: 'Build teams of divers for FINA Team Event entries.',
    action: 'Manage Teams',
  },
  {
    // Unified scoreboard + archive — live broadcasts + completed
    // meet recaps live in the same browsable surface now.
    id: 'scoreboard',
    roles: null, // always show
    to: '/scoreboard',
    colour: 'tile-red',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`,
    title: 'Scoreboard & Results',
    desc: 'Watch live meets in progress or browse completed meet recaps with full dive breakdowns.',
    action: 'Browse Meets',
  },
  {
    // Dive Directory: catalog browser with custom-dive editor.
    // Visible to anyone signed in — coaches and divers want to
    // look up DDs, only org-admins / coaches will typically add
    // custom rows. Per-row management is gated server-side.
    id: 'dive-directory',
    roles: null, // always show
    to: '/dive-directory',
    colour: 'tile-cyan',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h7"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 17l2 2 4-4"/></svg>`,
    title: 'Dive Directory',
    desc: 'Browse the World Aquatics dive catalog and add your org\'s custom progression / poolside dives.',
    action: 'Open Directory',
  },
  {
    // Cut 3 referee sign-off code page. Referee-only — coaches
    // and divers don't need this surface.
    id: 'sign-off-codes',
    roles: ['referee'],
    to: '/sign-off-codes',
    colour: 'tile-amber',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 11c0-1.105.895-2 2-2s2 .895 2 2-.895 2-2 2-2-.895-2-2zM5 7a2 2 0 012-2h10a2 2 0 012 2v10a2 2 0 01-2 2H7a2 2 0 01-2-2V7z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10h.01M9 14h.01M13 14h.01"/></svg>`,
    title: 'Sign-Off Codes',
    desc: 'Type the 6-digit handoff code from a meet controller to approve a dive order.',
    action: 'Enter Code',
  },
]

const visibleTiles = computed(() =>
  allTiles.filter(t => t.roles === null || auth.hasAnyRole(t.roles))
)

const welcomeName = computed(() => auth.user?.full_name?.toUpperCase() || '—')
const roleLine = computed(() => auth.formatRoles(auth.user?.org_roles || []))

function logout() {
  auth.clearSession()
  router.push('/login')
}

onMounted(async () => {
  if (auth.hasRole('judge')) {
    try {
      judgeEvents.value = await auth.apiFetch('/api/judge/my-events')
    } catch { /* silent */ }
  }
  // Pull events for operator-class users so the "what needs
  // your attention" cards above the tile grid have something
  // to render. Same /api/events endpoint Meet Manager uses;
  // returns the events the caller's role can see.
  if (showActionCards.value) {
    try {
      events.value = await auth.apiFetch('/api/events')
    } catch { /* silent — the tile grid still works */ }
  }
})
</script>

<template>
  <div class="dashboard">
  <div class="header-inner">
    <div>
      <div class="welcome-label">Dive Recorder</div>
      <div class="welcome-name">{{ welcomeName }}</div>
      <div class="role-line">{{ roleLine }}</div>
    </div>
    <button class="btn btn-ghost" @click="logout">Sign Out</button>
  </div>

  <!-- Find Diver — type a name, click a result, jump to that
       diver's profile. Visible to everyone on the dashboard
       since any logged-in user can browse profiles. -->
  <div class="find-diver">
    <input
      class="input find-diver-input"
      type="text"
      v-model="diverSearch"
      @input="onDiverSearchInput"
      @focus="diverDropdown = true"
      @blur="onDiverSearchBlur"
      placeholder="Find a diver — type a name to view their profile"
      autocomplete="off"
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

  <div v-if="showJudgeSection" class="judge-section" style="padding-top:2rem">
    <div class="section-header">Your Assigned Events</div>
    <div v-if="!judgeEvents.length">
      <p style="color:var(--text-3);font-size:12px">No events assigned yet.</p>
    </div>
    <RouterLink
      v-for="ev in judgeEvents"
      :key="ev.id"
      :to="`/judge?event=${ev.id}`"
      class="event-card"
    >
      <div>
        <div class="event-card-name">{{ ev.name }}</div>
        <div class="event-card-meta">
          {{ ev.total_rounds }} rounds · {{ ev.number_of_judges }} judges ·
          <span :style="{ color: ev.status === 'Live' ? 'var(--green)' : 'var(--text-3)' }">{{ ev.status }}</span>
        </div>
      </div>
      <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/></svg>
    </RouterLink>
  </div>

  <!-- Action cards — "what needs your attention right now".
       Lives ABOVE the navigation tile grid for operator-class
       users so the dashboard's first answer is "do this next"
       rather than "here are all the screens you can open".
       Scoped to org_admin / meet_manager because they're the
       roles whose attention is split across multiple events;
       judges see their own assigned-events list higher up.

       Compact layout: each card is a single-line row, the
       header collapses the section entirely, and a 5-row cap
       with a Show-more toggle keeps the section quiet when an
       org is running many concurrent meets. -->
  <div v-if="actionCards.length" class="action-cards">
    <button
      type="button"
      class="action-cards-header"
      :aria-expanded="attentionOpen"
      :title="attentionOpen ? 'Click to collapse' : 'Click to expand'"
      @click="toggleAttention"
    >
      <span class="action-cards-label">What needs your attention</span>
      <span class="action-cards-summary">
        <span v-if="liveCount" class="acs-live">{{ liveCount }} LIVE</span>
        <span v-if="liveCount && upcomingCount" class="acs-sep">·</span>
        <span v-if="upcomingCount" class="acs-upcoming">{{ upcomingCount }} UPCOMING</span>
      </span>
      <span class="action-cards-toggle" :class="{ open: attentionOpen }" aria-hidden="true">▾</span>
    </button>

    <div v-if="attentionOpen" class="action-cards-list">
      <RouterLink
        v-for="(card, idx) in visibleAttentionCards"
        :key="card.id"
        :to="card.to"
        :class="['action-card', `action-card-${card.kind}`]"
        :style="{ animationDelay: `${Math.min(idx, 6) * 25}ms` }"
      >
        <span class="action-card-icon">{{ card.icon }}</span>
        <span class="action-card-title">{{ card.title }}</span>
        <span v-if="card.meta" class="action-card-meta">{{ card.meta }}</span>
        <span class="action-card-arrow" aria-hidden="true">→</span>
      </RouterLink>

      <button
        v-if="actionCards.length > ATTENTION_PREVIEW"
        type="button"
        class="action-cards-more"
        @click="attentionShowAll = !attentionShowAll"
      >
        {{ attentionShowAll
            ? 'Show fewer'
            : `Show ${actionCards.length - ATTENTION_PREVIEW} more` }}
      </button>
    </div>
  </div>

  <div class="main-grid">
    <RouterLink
      v-for="(tile, idx) in visibleTiles"
      :key="tile.id"
      :to="tile.to"
      :class="['tile', tile.colour]"
      :style="{ animationDelay: `${idx * 50}ms` }"
    >
      <div class="tile-icon" v-html="tile.icon"></div>
      <div class="tile-title">{{ tile.title }}</div>
      <div class="tile-desc">{{ tile.desc }}</div>
      <div class="tile-action">{{ tile.action }}</div>
    </RouterLink>
  </div>
  </div>
</template>

<style scoped>
/* Dashboard wrapper — clamps horizontal overflow at the page
   level so any descendant whose min-content is wider than the
   viewport (long welcome name in a chunky display font, an
   event card title, …) gets clipped by the wrapper rather than
   pushing the body wider than the viewport and triggering a
   horizontal scrollbar. */
.dashboard {
  overflow-x: hidden;
  width: 100%;
}

.header-inner {
  display: flex; align-items: flex-start; justify-content: space-between;
  /* flex-wrap + gap so the Sign Out button drops below the
     welcome block on narrow viewports instead of forcing the
     row past the viewport edge. */
  flex-wrap: wrap;
  gap: 1rem;
  padding: 2.5rem 2rem 2rem; max-width: 1400px; margin: 0 auto;
  border-bottom: 1px solid var(--border);
  /* Constrain min-width so a long full name doesn't push the
     header past the viewport. */
  min-width: 0;
}
.welcome-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.welcome-name  {
  font-family: var(--font-display); font-weight: 900; font-style: italic;
  line-height: 1; color: var(--text);
  /* Clamp so a long full name doesn't force the document
     wider than the viewport. */
  font-size: clamp(32px, 6vw, 56px);
  word-break: break-word;
}
.role-line     {
  font-family: var(--font-display); font-size: 11px; font-weight: 600;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  margin-top: 0.5rem;
  /* Roles are joined with " · " and can be a long single line
     ("MEET MANAGER · REFEREE · JUDGE · …"). Allow wrapping so
     the line doesn't push the page width past the viewport. */
  white-space: normal;
  word-break: break-word;
}

/* "What needs your attention" — compact, collapsible operator
   to-do strip above the tile grid. The previous design used
   tall stacked cards which drowned the dashboard the moment an
   org was running 3+ concurrent meets; the layout below is
   single-line rows with a fold-away header and a preview cap. */
.action-cards {
  /* Same content envelope as the find-diver bar and main tile
     grid so the section lines up with everything else and
     doesn't bleed past the page max-width. */
  max-width: 1400px;
  margin: 1.25rem auto 0;
  padding: 0 2rem;
}

/* Header is a button — click anywhere on the strip to fold the
   section away. Live / Upcoming counts stay visible even when
   collapsed so the operator always knows what's pending. */
.action-cards-header {
  display: flex; align-items: center; gap: 0.85rem;
  width: 100%;
  background: transparent; border: none;
  padding: 0.4rem 0;
  margin-bottom: 0.5rem;
  font: inherit; color: inherit;
  cursor: pointer;
  text-align: left;
}
.action-cards-header:hover .action-cards-label { color: var(--text-2); }
.action-cards-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--text-3);
  transition: color 0.15s;
}
.action-cards-summary {
  display: inline-flex; align-items: center; gap: 0.4rem;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
}
.acs-live     { color: var(--red);  font-weight: 700; letter-spacing: 0.05em; }
.acs-upcoming { color: var(--cyan); font-weight: 700; letter-spacing: 0.05em; }
.acs-sep      { color: var(--text-3); }
.action-cards-toggle {
  margin-left: auto;
  font-family: var(--font-display); font-size: 12px;
  color: var(--text-3);
  transition: transform 0.2s;
}
.action-cards-toggle.open { transform: rotate(180deg); }

.action-cards-list {
  display: flex; flex-direction: column;
  gap: 0.4rem;
}

/* Compact one-line row — icon · title · meta · arrow. About
   half the height of the previous two-line card, so 8 events
   take ~280px instead of ~700px. */
.action-card {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.55rem 0.95rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-left-width: 4px;
  border-radius: var(--radius);
  text-decoration: none;
  transition: transform 0.15s, border-color 0.15s, background 0.15s;
  animation: fadeUp 0.25s ease both;
  /* Allow internal flex children to shrink past their content
     width so a long meet name + meta string can ellipsize
     instead of pushing the row wider than its container. */
  min-width: 0;
}
.action-card:hover {
  transform: translateX(2px);
  border-color: var(--border-2);
  background: rgba(6, 182, 212, 0.04);
}
.action-card-live {
  border-left-color: var(--red);
  background: rgba(239, 68, 68, 0.04);
}
.action-card-live:hover {
  background: rgba(239, 68, 68, 0.09);
  border-color: rgba(239, 68, 68, 0.4);
}
.action-card-upcoming { border-left-color: var(--cyan); }
.action-card-upcoming:hover { border-color: rgba(6, 182, 212, 0.4); }
.action-card-icon {
  font-size: 14px; line-height: 1;
  flex-shrink: 0;
}
.action-card-title {
  font-family: var(--font-display); font-size: 14px; font-weight: 800;
  font-style: italic; letter-spacing: 0.02em;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  /* Title gets to grow but is allowed to shrink; meta gets a
     bigger flex-shrink so when the row is tight, the meta
     ellipsizes first (deadline strings are forgiving — losing
     the diver/meet name is not). */
  flex: 1 1 auto; min-width: 0;
}
.action-card-meta {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  flex: 0 1 auto; min-width: 0;
}
.action-card-meta::before {
  content: '·';
  margin-right: 0.5rem;
  color: var(--text-3);
}
.action-card-arrow {
  font-family: var(--font-display); font-size: 16px;
  color: var(--text-3);
  margin-left: auto;
  padding-left: 0.5rem;
  transition: transform 0.15s, color 0.15s;
  flex-shrink: 0;
}
.action-card:hover .action-card-arrow {
  transform: translateX(3px);
  color: var(--cyan);
}
.action-card-live:hover .action-card-arrow { color: var(--red); }

/* Show-more / Show-fewer toggle when the list exceeds the
   preview cap. Dashed border so it reads as ancillary not
   primary affordance. */
.action-cards-more {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--text-3);
  font-family: var(--font-mono); font-size: 11px;
  letter-spacing: 0.05em;
  padding: 0.45rem 0.5rem;
  border-radius: var(--radius);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  margin-top: 0.15rem;
}
.action-cards-more:hover {
  color: var(--cyan);
  border-color: var(--cyan);
}

.main-grid {
  display: grid;
  /* minmax 240px (was 300) so the auto-fill packs more columns
     onto narrow viewports without overflowing. min(100%, …) on
     the min track stops a single tile from forcing the grid
     wider than its container at very narrow widths. */
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 240px), 1fr));
  gap: 1.5rem;
  padding: 2.5rem 2rem;
  max-width: 1400px;
  margin: 0 auto;
}

.tile {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 2rem;
  text-decoration: none;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  /* Grid items default to min-width: auto (= min-content). With
     a 26px italic tile-title, "Compare Divers" / "Meet Manager"
     etc. measure ~280px min-content, which overrides the grid's
     minmax(240px, 1fr) and pushes the whole grid wider than its
     container. min-width: 0 lets the cell shrink below the
     title's natural width and the title wraps via the
     break-word rule below. */
  min-width: 0;
  transition: border-color 0.2s, transform 0.2s;
  animation: fadeUp 0.3s ease both;
}
.tile:hover { transform: translateY(-2px); }
.tile::before {
  content: '';
  position: absolute;
  top: 0; right: 0;
  width: 120px; height: 120px;
  border-radius: 50%;
  opacity: 0.06;
  transition: opacity 0.2s;
}
.tile:hover::before { opacity: 0.12; }

.tile-cyan   { --tc: var(--cyan);  } .tile-cyan::before   { background: var(--cyan);  }
.tile-amber  { --tc: var(--amber); } .tile-amber::before  { background: var(--amber); }
.tile-green  { --tc: var(--green); } .tile-green::before  { background: var(--green); }
.tile-red    { --tc: var(--red);   } .tile-red::before    { background: var(--red);   }
.tile-purple { --tc: #a78bfa;      } .tile-purple::before { background: #a78bfa;      }

.tile:hover { border-color: var(--tc, var(--cyan)); }

.tile-icon {
  width: 44px; height: 44px;
  background: rgba(255,255,255,0.04);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex; align-items: center; justify-content: center;
  margin-bottom: 1.5rem;
  color: var(--tc, var(--text-2));
  transition: background 0.2s, border-color 0.2s;
}
.tile:hover .tile-icon { background: var(--tc, var(--cyan)); color: var(--bg); border-color: transparent; }

.tile-title  {
  font-size: 26px; font-style: italic; color: var(--text);
  margin-bottom: 0.5rem;
  /* Lets long titles ("Compare Divers", "Meet Manager") wrap
     to a second line on narrow tiles instead of forcing the
     cell wider than the column. */
  word-break: break-word;
}
.tile-desc   { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); line-height: 1.6; flex: 1; margin-bottom: 1.5rem; }
.tile-action {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--tc, var(--cyan));
  display: flex; align-items: center; gap: 0.5rem;
}
.tile-action::after { content: '→'; }

/* Find Diver — typeahead bar + dropdown, full-width capped at
   the dashboard's content max-width so it lines up with the
   tile grid below. */
.find-diver {
  position: relative;
  padding: 1.25rem 2rem 0;
  max-width: 1400px;
  margin: 0 auto;
}
.find-diver-input {
  width: 100%;
  font-size: 14px;
  padding: 0.75rem 1rem;
}
.find-diver-dropdown {
  position: absolute;
  top: calc(100% - 0.25rem);
  left: 2rem;
  right: 2rem;
  z-index: 50;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-radius: var(--radius);
  box-shadow: 0 16px 36px rgba(0,0,0,0.45);
  max-height: 320px;
  overflow-y: auto;
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
  cursor: pointer;
  color: var(--text);
  font-family: var(--font-mono);
  transition: background 0.1s;
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
.find-diver-club {
  font-size: 11px; color: var(--text-3);
  margin-left: auto;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.find-diver-club-code {
  font-weight: 700; color: var(--cyan); margin-left: 0.4rem;
}

.judge-section { padding: 0 2rem 0; max-width: 1400px; margin: 0 auto; }
.section-header {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 1rem; padding-bottom: 0.75rem; border-bottom: 1px solid var(--border);
}
.event-card {
  display: flex; align-items: center; justify-content: space-between;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1.25rem 1.5rem;
  text-decoration: none; transition: border-color 0.2s;
  margin-bottom: 0.75rem;
}
.event-card:hover { border-color: var(--cyan); }
.event-card-name { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--text); }
.event-card-meta { font-size: 11px; color: var(--text-3); margin-top: 0.2rem; }
</style>
