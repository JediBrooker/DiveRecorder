<script setup>
import { ref, onMounted, computed } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const judgeEvents = ref([])
const showJudgeSection = computed(() => auth.hasRole('judge'))

const allTiles = [
  {
    id: 'diver',
    roles: ['diver'],
    to: '/competitor',
    colour: 'tile-green',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>`,
    title: 'Diver Portal',
    desc: 'Submit your dive list and verify DD requirements for the meet.',
    action: 'Submit Dive List',
  },
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
    id: 'scoreboard',
    roles: null, // always show
    to: '/scoreboard',
    colour: 'tile-red',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>`,
    title: 'Live Scoreboard',
    desc: 'View real-time standings and completed dive results.',
    action: 'View Scores',
  },
  {
    id: 'archive',
    roles: null, // always show
    to: '/archive',
    colour: 'tile-amber',
    icon: `<svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 7v13a1 1 0 001 1h14a1 1 0 001-1V7M4 7l1-3h14l1 3M4 7h16M9 11h6"/></svg>`,
    title: 'Results Archive',
    desc: 'Browse completed meets, view final results and export PDFs.',
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
  padding: 2.5rem 2rem 2rem; max-width: 1400px; margin: 0 auto;
  border-bottom: 1px solid var(--border);
}
.welcome-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
.welcome-name  { font-family: var(--font-display); font-size: 56px; font-weight: 900; font-style: italic; line-height: 1; color: var(--text); }
.role-line     { font-family: var(--font-display); font-size: 11px; font-weight: 600; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-top: 0.5rem; }

.main-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
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

.tile-title  { font-size: 26px; font-style: italic; color: var(--text); margin-bottom: 0.5rem; }
.tile-desc   { font-family: var(--font-mono); font-size: 12px; color: var(--text-3); line-height: 1.6; flex: 1; margin-bottom: 1.5rem; }
.tile-action {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--tc, var(--cyan));
  display: flex; align-items: center; gap: 0.5rem;
}
.tile-action::after { content: '→'; }

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
