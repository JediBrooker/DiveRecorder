<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const judgeEvents = ref([])
const showJudgeSection = computed(() => auth.hasRole('judge'))

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
})
</script>

<template>
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
</template>

<style scoped>
.header-inner {
  display: flex; align-items: flex-start; justify-content: space-between;
  /* flex-wrap + gap so the Sign Out button drops below the
     welcome block on narrow viewports instead of forcing the
     row past the viewport edge. */
  flex-wrap: wrap;
  gap: 1rem;
  padding: 2.5rem 2rem 2rem; max-width: 1400px; margin: 0 auto;
  border-bottom: 1px solid var(--border);
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
