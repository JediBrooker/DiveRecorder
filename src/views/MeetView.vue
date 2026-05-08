<script setup>
// Public meet landing page. Shows the meet's metadata (host org,
// venue, dates, sponsor) plus every event nested inside, grouped
// by status. Each event card jumps into the existing
// /scoreboard/:eventId surface for live broadcast or completed
// recap.

import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'

const route = useRoute()

const meet = ref(null)
const events = ref([])
const participatingOrgs = ref([])
const loading = ref(false)
const error = ref('')

async function load(id) {
  loading.value = true
  error.value = ''
  meet.value = null
  events.value = []
  try {
    const r = await fetch(`/api/meets/${id}`)
    const body = await r.json().catch(() => null)
    if (!r.ok) throw new Error(body?.error || `Server returned ${r.status}`)
    meet.value = body.meet
    events.value = Array.isArray(body.events) ? body.events : []
    participatingOrgs.value = Array.isArray(body.participating_orgs) ? body.participating_orgs : []
  } catch (err) {
    error.value = err.message || 'Failed to load meet'
  } finally {
    loading.value = false
  }
}

const liveCount = computed(() => events.value.filter(e => e.status === 'Live').length)
const completedCount = computed(() => events.value.filter(e => e.status === 'Completed').length)
const upcomingCount = computed(() => events.value.filter(e => e.status === 'Upcoming').length)

const liveEvents = computed(() => events.value.filter(e => e.status === 'Live'))
const upcomingEvents = computed(() => events.value.filter(e => e.status === 'Upcoming'))
const completedEvents = computed(() => events.value.filter(e => e.status === 'Completed'))

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

const dateRange = computed(() => {
  if (!meet.value) return ''
  const s = meet.value.start_date
  const e = meet.value.end_date
  if (s && e && s !== e) return `${fmtDate(s)} – ${fmtDate(e)}`
  return fmtDate(s || e)
})

watch(() => route.params.id, (id) => { if (id) load(id) }, { immediate: true })
onMounted(() => { if (route.params.id) load(route.params.id) })
</script>

<template>
  <div class="meet-wrap">
    <!-- Top nav -->
    <div class="meet-nav">
      <RouterLink to="/scoreboard" class="btn btn-ghost btn-sm">← All Meets</RouterLink>
      <a v-if="meet"
         :href="`/api/meets/${meet.id}/program.pdf`"
         target="_blank" rel="noopener"
         class="btn btn-ghost btn-sm"
         title="Download a printable schedule of every event in this meet">
        📄 Program PDF
      </a>
    </div>

    <div v-if="loading" class="empty">Loading meet…</div>
    <div v-else-if="error" class="msg msg-error">Couldn't load meet: {{ error }}</div>

    <template v-else-if="meet">
      <!-- Hero -->
      <div class="hero">
        <div class="hero-org">
          {{ meet.org_name }}<span v-if="meet.country_code" class="hero-ctry">{{ meet.country_code }}</span>
        </div>
        <h1 class="hero-title">{{ meet.name }}</h1>
        <div class="hero-meta">
          <span v-if="dateRange">{{ dateRange }}</span>
          <span v-if="meet.venue && dateRange"> · </span>
          <span v-if="meet.venue">{{ meet.venue }}</span>
        </div>
        <p v-if="meet.description" class="hero-desc">{{ meet.description }}</p>

        <!-- Status counts strip -->
        <div class="status-strip">
          <div v-if="liveCount" class="status-cell status-live">
            <span class="status-num">{{ liveCount }}</span>
            <span class="status-lbl">Live now</span>
          </div>
          <div v-if="upcomingCount" class="status-cell status-upcoming">
            <span class="status-num">{{ upcomingCount }}</span>
            <span class="status-lbl">Upcoming</span>
          </div>
          <div v-if="completedCount" class="status-cell status-done">
            <span class="status-num">{{ completedCount }}</span>
            <span class="status-lbl">Completed</span>
          </div>
        </div>

        <!-- 🌐 International strip — surfaces every other federation
             that has divers competing in any event of this meet.
             Only renders when there's at least one. The host's own
             country is shown elsewhere (.hero-ctry); this is the
             VISITING countries. -->
        <div v-if="participatingOrgs.length" class="participating-strip">
          <span class="participating-pulse">🌐 International</span>
          <span class="participating-sub">
            Hosted by {{ meet.org_name
              }}<template v-if="meet.country_code"> ({{ meet.country_code }})</template>
            · Visiting:
          </span>
          <span class="participating-list">
            <span v-for="o in participatingOrgs" :key="o.org_id" class="participating-chip"
                  :title="o.org_name">
              {{ o.country_code || o.org_name }}
            </span>
          </span>
        </div>

        <!-- Sponsor strip — optional headline sponsor for the meet. -->
        <a v-if="meet.sponsor_logo_url || meet.sponsor_name"
           :href="meet.sponsor_link_url || '#'"
           :target="meet.sponsor_link_url ? '_blank' : '_self'"
           rel="noopener"
           class="sponsor-strip">
          <span class="sponsor-prefix">Powered by</span>
          <img v-if="meet.sponsor_logo_url" :src="meet.sponsor_logo_url" :alt="meet.sponsor_name || 'Sponsor'" class="sponsor-logo">
          <span v-else class="sponsor-name">{{ meet.sponsor_name }}</span>
        </a>
      </div>

      <!-- Live events -->
      <section v-if="liveEvents.length" class="event-section live-section">
        <div class="section-head">
          <span class="live-pulse">LIVE NOW</span>
          <span class="section-title">In progress</span>
        </div>
        <div class="event-grid">
          <RouterLink v-for="ev in liveEvents" :key="ev.id"
                      :to="`/scoreboard/${ev.id}`" class="event-card event-card-live">
            <div class="event-card-name">{{ ev.name }}</div>
            <div class="event-card-tags">
              <span v-if="ev.gender" class="ev-tag">{{ ev.gender }}</span>
              <span v-if="ev.height" class="ev-tag">{{ ev.height }}</span>
              <span class="ev-tag">{{ ev.total_rounds }} rds</span>
              <span v-if="ev.event_type === 'synchro_pair'" class="ev-tag ev-tag-cyan">Synchro</span>
              <span v-else-if="ev.event_type === 'team'" class="ev-tag ev-tag-cyan">Team</span>
            </div>
            <div class="event-card-cta">Watch live →</div>
          </RouterLink>
        </div>
      </section>

      <!-- Upcoming events -->
      <section v-if="upcomingEvents.length" class="event-section">
        <div class="section-head">
          <span class="section-title">Upcoming</span>
        </div>
        <div class="event-grid">
          <div v-for="ev in upcomingEvents" :key="ev.id" class="event-card event-card-upcoming">
            <div class="event-card-name">{{ ev.name }}</div>
            <div class="event-card-tags">
              <span v-if="ev.gender" class="ev-tag">{{ ev.gender }}</span>
              <span v-if="ev.height" class="ev-tag">{{ ev.height }}</span>
              <span class="ev-tag">{{ ev.total_rounds }} rds</span>
              <span v-if="ev.event_type === 'synchro_pair'" class="ev-tag ev-tag-cyan">Synchro</span>
              <span v-else-if="ev.event_type === 'team'" class="ev-tag ev-tag-cyan">Team</span>
            </div>
            <div class="event-card-cta dim">Not started</div>
          </div>
        </div>
      </section>

      <!-- Completed events -->
      <section v-if="completedEvents.length" class="event-section">
        <div class="section-head">
          <span class="section-title">Results</span>
        </div>
        <div class="event-grid">
          <RouterLink v-for="ev in completedEvents" :key="ev.id"
                      :to="`/scoreboard/${ev.id}`" class="event-card event-card-done">
            <div class="event-card-name">{{ ev.name }}</div>
            <div class="event-card-tags">
              <span v-if="ev.gender" class="ev-tag">{{ ev.gender }}</span>
              <span v-if="ev.height" class="ev-tag">{{ ev.height }}</span>
              <span class="ev-tag">{{ ev.total_rounds }} rds</span>
              <span v-if="ev.competitor_count" class="ev-tag">
                {{ ev.competitor_count }} {{ ev.competitor_count === 1 ? 'diver' : 'divers' }}
              </span>
            </div>
            <div class="event-card-cta">View recap →</div>
          </RouterLink>
        </div>
      </section>

      <div v-if="!events.length" class="empty">
        No events scheduled for this meet yet.
      </div>
    </template>
  </div>
</template>

<style scoped>
.meet-wrap { max-width: 1100px; margin: 0 auto; padding: 1.5rem; }
.meet-nav  { margin-bottom: 1rem; display: flex; gap: 0.5rem; flex-wrap: wrap; }
.empty     { color: var(--text-3); padding: 3rem 0; text-align: center; font-family: var(--font-mono); font-size: 13px; }

/* Hero */
.hero {
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-xl); padding: 2rem 2.25rem;
  margin-bottom: 2rem;
}
.hero-org {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.5rem;
}
.hero-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-left: 0.4rem; vertical-align: middle;
}
.hero-title {
  font-family: var(--font-display); font-size: clamp(28px, 4.5vw, 48px); font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.05;
  margin-bottom: 0.75rem;
}
.hero-meta {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-2);
}
.hero-desc {
  font-family: var(--font-mono); font-size: 13px; color: var(--text-3);
  line-height: 1.6; margin-top: 1rem; max-width: 720px;
}

.status-strip {
  display: flex; gap: 0.75rem; flex-wrap: wrap;
  margin-top: 1.5rem;
}
.status-cell {
  display: flex; align-items: baseline; gap: 0.5rem;
  padding: 0.6rem 1rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.status-cell.status-live    { border-color: rgba(239,68,68,0.4); background: rgba(239,68,68,0.06); }
.status-cell.status-upcoming{ border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.06); }
.status-cell.status-done    { border-color: rgba(6,182,212,0.4);  background: rgba(6,182,212,0.04); }
.status-num {
  font-family: var(--font-display); font-size: 24px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.status-cell.status-live    .status-num { color: var(--red);   }
.status-cell.status-upcoming .status-num { color: var(--amber); }
.status-cell.status-done    .status-num { color: var(--cyan);  }
.status-lbl {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}

/* International strip — visiting countries badge above the
   sponsor block on the public meet page. Only renders when at
   least one foreign federation is participating. */
.participating-strip {
  display: flex; align-items: center; flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  margin-top: 1.25rem;
  padding: 0.55rem 0.85rem;
  background: rgba(34,211,238,0.08);
  border: 1px solid rgba(34,211,238,0.35);
  border-radius: var(--radius);
}
.participating-pulse {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: #67e8f9;
  flex-shrink: 0;
}
.participating-sub {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  flex-shrink: 0;
}
.participating-list { display: inline-flex; gap: 0.4rem; flex-wrap: wrap; }
.participating-chip {
  font-family: var(--font-display); font-size: 11px; font-weight: 800;
  letter-spacing: 0.08em;
  color: var(--text);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.2rem 0.6rem;
}

.sponsor-strip {
  display: inline-flex; align-items: center; gap: 0.6rem;
  margin-top: 1.25rem; padding: 0.45rem 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  text-decoration: none; color: inherit;
}
.sponsor-prefix {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3);
}
.sponsor-logo  { height: 28px; max-width: 160px; object-fit: contain; }
.sponsor-name  { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--text); }

/* Event sections */
.event-section { margin-bottom: 2rem; }
.section-head {
  display: flex; align-items: center; gap: 0.75rem;
  margin-bottom: 1rem;
}
.section-title {
  font-family: var(--font-display); font-size: 14px; font-weight: 900;
  font-style: italic; letter-spacing: 0.05em; color: var(--text);
}
.live-pulse {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.2em; padding: 0.25rem 0.65rem;
  background: var(--red); color: white; border-radius: 4px;
  animation: pulse-red 2s infinite;
}
@keyframes pulse-red { 0%,100% { opacity: 1; } 50% { opacity: 0.7; } }

.event-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.875rem;
}
.event-card {
  display: flex; flex-direction: column; gap: 0.4rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg); padding: 1rem 1.125rem;
  text-decoration: none; color: inherit;
  transition: all 0.15s; min-width: 0;
}
.event-card-live      { border-color: rgba(239,68,68,0.35); }
.event-card-live:hover { border-color: var(--red); background: rgba(239,68,68,0.04); transform: translateY(-1px); }
.event-card-done:hover { border-color: var(--cyan); background: rgba(6,182,212,0.04); transform: translateY(-1px); }
.event-card-upcoming  { opacity: 0.85; }

.event-card-name {
  font-family: var(--font-display); font-size: 16px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.15;
}
.event-card-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.ev-tag {
  font-family: var(--font-mono); font-size: 10px;
  color: var(--text-3); background: var(--bg-3);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 0.1rem 0.4rem;
}
.ev-tag-cyan {
  color: var(--cyan); border-color: rgba(6,182,212,0.3);
  background: var(--cyan-dim);
}
.event-card-cta {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase; color: var(--cyan);
  margin-top: 0.2rem;
}
.event-card-cta.dim { color: var(--text-3); }
.event-card-live .event-card-cta { color: var(--red); }

@media (max-width: 720px) {
  .meet-wrap { padding: 1rem; }
  .hero { padding: 1.25rem; border-radius: var(--radius-lg); }
  .event-grid { grid-template-columns: 1fr; }
}
</style>
