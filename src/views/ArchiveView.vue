<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { annotatedScores } from '@/composables/useScoreCategories'

const events = ref([])
const clubsList = ref([])           // distinct clubs that have competed in any archived meet
const selected = ref(null)
const results = ref(null)
const loading = ref(false)
const loadingResults = ref(false)

// Filter state — drives the event list at the top of the page
const searchTerm = ref('')
const countryFilter = ref('')        // ISO-3 code, '' = all
const yearFilter   = ref('')         // YYYY, '' = all
const heightFilter = ref('')         // '1m'..'10m', '' = all
const clubFilter   = ref('')         // club id, '' = all

const countries = computed(() => {
  const seen = new Map()
  for (const e of events.value) {
    if (!e.country_code) continue
    if (!seen.has(e.country_code)) {
      seen.set(e.country_code, { code: e.country_code, org_name: e.org_name })
    }
  }
  return [...seen.values()].sort((a, b) => a.code.localeCompare(b.code))
})

const years = computed(() => {
  const set = new Set()
  for (const e of events.value) {
    if (e.created_at) set.add(new Date(e.created_at).getFullYear())
  }
  return [...set].sort((a, b) => b - a)
})

const heights = computed(() => {
  const set = new Set()
  for (const e of events.value) if (e.height) set.add(e.height)
  return [...set]
})

// Visible clubs in the dropdown — cascades from the country
// selection so a long club list (80+ in the seeded bulk data)
// stays manageable. With no country selected we show every club
// and prefix each name with its country code.
const visibleClubs = computed(() => {
  if (!countryFilter.value) return clubsList.value
  return clubsList.value.filter(c => c.country_code === countryFilter.value)
})

const filteredEvents = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  return events.value.filter(e => {
    if (countryFilter.value && e.country_code !== countryFilter.value) return false
    if (yearFilter.value && new Date(e.created_at).getFullYear() !== Number(yearFilter.value)) return false
    if (heightFilter.value && e.height !== heightFilter.value) return false
    if (clubFilter.value && !(e.club_ids || []).includes(clubFilter.value)) return false
    if (!term) return true
    return (
      (e.name || '').toLowerCase().includes(term) ||
      (e.org_name || '').toLowerCase().includes(term) ||
      (e.country_code || '').toLowerCase().includes(term)
    )
  })
})

function clearFilters() {
  searchTerm.value = ''
  countryFilter.value = ''
  yearFilter.value = ''
  heightFilter.value = ''
  clubFilter.value = ''
}

// If the user picks a country and the currently-selected club
// belongs to a different country, drop the club selection so the
// two filters stay coherent.
watch(countryFilter, (val) => {
  if (!val || !clubFilter.value) return
  const club = clubsList.value.find(c => c.id === clubFilter.value)
  if (club && club.country_code !== val) clubFilter.value = ''
})

const activeFilterCount = computed(() => {
  let n = 0
  if (searchTerm.value.trim()) n++
  if (countryFilter.value)     n++
  if (yearFilter.value)        n++
  if (heightFilter.value)      n++
  if (clubFilter.value)        n++
  return n
})

// Returns a JSON array, or [] if the request fails or the body
// isn't an array. Without this, a 500 response body of
// {error: "…"} ends up as `events.value` and the .filter() in a
// computed below throws during render → blank page.
async function fetchJsonArray(url) {
  try {
    const r = await fetch(url)
    if (!r.ok) return []
    const body = await r.json()
    return Array.isArray(body) ? body : []
  } catch {
    return []
  }
}

onMounted(async () => {
  loading.value = true
  try {
    const [evs, cls] = await Promise.all([
      fetchJsonArray('/api/archive'),
      fetchJsonArray('/api/archive/clubs'),
    ])
    events.value = evs
    clubsList.value = cls
  } finally {
    loading.value = false
  }
})

async function openEvent(ev) {
  if (selected.value?.id === ev.id) { selected.value = null; results.value = null; return }
  selected.value = ev
  results.value = null
  loadingResults.value = true
  try {
    results.value = await fetch(`/api/archive/${ev.id}/results`).then(r => r.json())
  } finally {
    loadingResults.value = false
  }
}

function downloadPdf(ev) {
  window.open(`/api/events/${ev.id}/results.pdf`, '_blank')
}

function byDiver(dives) {
  // Group dives by diver, preserving country / club / partner
  // from the first row in the group.
  const map = new Map()
  for (const d of dives) {
    if (!map.has(d.full_name)) {
      map.set(d.full_name, {
        name: d.full_name,
        country: d.country_code || null,
        club: d.club_name || null,
        partner: d.partner_name || null,
        partner_country: d.partner_country || null,
        dives: [],
      })
    }
    map.get(d.full_name).dives.push(d)
  }
  return [...map.values()]
}

function fmtDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}
</script>

<template>
  <div class="archive-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Results Archive</div>
        <h1 class="page-title">Completed Meets</h1>
      </div>
      <RouterLink to="/" class="btn btn-ghost btn-sm">← Home</RouterLink>
    </div>

    <!-- Filter bar -->
    <div v-if="events.length" class="filter-bar">
      <input class="input" type="text" v-model="searchTerm"
             placeholder="Search event, host org, country…">
      <select class="select" v-model="countryFilter">
        <option value="">All countries ({{ countries.length }})</option>
        <option v-for="c in countries" :key="c.code" :value="c.code">
          {{ c.code }} — {{ c.org_name }}
        </option>
      </select>
      <select class="select" v-model="yearFilter">
        <option value="">All years</option>
        <option v-for="y in years" :key="y" :value="y">{{ y }}</option>
      </select>
      <select class="select" v-model="heightFilter">
        <option value="">All heights</option>
        <option v-for="h in heights" :key="h" :value="h">{{ h }}</option>
      </select>
      <select class="select" v-model="clubFilter">
        <option value="">All clubs ({{ visibleClubs.length }})</option>
        <option v-for="c in visibleClubs" :key="c.id" :value="c.id">
          {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template><template v-if="!countryFilter"> · {{ c.country_code }}</template>
        </option>
      </select>
      <button v-if="activeFilterCount" class="btn btn-ghost btn-sm" @click="clearFilters">
        Clear filters
      </button>
      <span class="result-count">
        {{ filteredEvents.length.toLocaleString() }} of {{ events.length.toLocaleString() }} meets
      </span>
    </div>

    <div class="content">
      <div v-if="loading" class="empty">Loading…</div>
      <div v-else-if="!events.length" class="empty">No completed meets yet.</div>
      <div v-else-if="!filteredEvents.length" class="empty">
        No meets match these filters.
        <button class="btn btn-ghost btn-sm" style="margin-left:0.5rem" @click="clearFilters">Clear</button>
      </div>

      <div v-for="ev in filteredEvents" :key="ev.id" class="event-block">
        <div class="event-row" @click="openEvent(ev)">
          <div style="flex:1;min-width:0">
            <div class="event-name">{{ ev.name }}</div>
            <div class="event-meta">
              <span class="event-org">
                {{ ev.org_name }}<span v-if="ev.country_code" class="event-ctry">{{ ev.country_code }}</span>
              </span>
              <span v-if="ev.gender">· {{ ev.gender }}</span>
              <span v-if="ev.height">· {{ ev.height }}</span>
              <span>· {{ ev.total_rounds }} rounds</span>
              <span v-if="ev.competitor_count" class="event-stat">
                · {{ ev.competitor_count }} {{ ev.competitor_count === 1 ? 'diver' : 'divers' }}
              </span>
              <span v-if="ev.club_count" class="event-stat">
                · {{ ev.club_count }} {{ ev.club_count === 1 ? 'club' : 'clubs' }}
              </span>
              <span class="event-date">{{ fmtDate(ev.created_at) }}</span>
            </div>
          </div>
          <div class="event-actions" @click.stop>
            <button class="btn btn-ghost btn-sm" @click="downloadPdf(ev)">Export PDF</button>
            <button class="btn btn-ghost btn-sm" @click="openEvent(ev)">
              {{ selected?.id === ev.id ? 'Close' : 'View Results' }}
            </button>
          </div>
        </div>

        <div v-if="selected?.id === ev.id" class="results-panel">
          <div v-if="loadingResults" class="empty">Loading results…</div>
          <template v-else-if="results">
            <!-- Standings -->
            <div class="section-label">Final Standings</div>
            <div class="standings">
              <div
                v-for="(row, i) in results.standings"
                :key="row.full_name"
                :class="['standing-row', i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '']"
              >
                <span class="rank">{{ i + 1 }}</span>
                <div class="sname-col">
                  <div class="sname-line">
                    <span class="sname">{{ row.full_name }}</span>
                    <span v-if="row.country_code" class="ctry">{{ row.country_code }}</span>
                  </div>
                  <div v-if="row.partner_name" class="partner-line">
                    &amp; {{ row.partner_name }}<span v-if="row.partner_country" class="ctry">{{ row.partner_country }}</span>
                  </div>
                  <div v-if="row.club_name" class="club-line">{{ row.club_name }}</div>
                </div>
                <span class="total">{{ Number(row.total).toFixed(2) }}</span>
              </div>
            </div>

            <!-- Dive breakdown -->
            <div class="section-label" style="margin-top:1.5rem">Dive Breakdown</div>
            <div v-for="b in byDiver(results.dives)" :key="b.name" class="diver-block">
              <div class="diver-head">
                <div class="diver-name">
                  {{ b.name }}<span v-if="b.country" class="ctry">{{ b.country }}</span>
                  <template v-if="b.partner">
                    <span class="archive-amp">&amp;</span>
                    {{ b.partner }}<span v-if="b.partner_country" class="ctry">{{ b.partner_country }}</span>
                  </template>
                </div>
                <div v-if="b.club" class="diver-club">{{ b.club }}</div>
              </div>
              <div v-for="d in b.dives" :key="d.round_number" class="dive-row">
                <span class="round-num">R{{ d.round_number }}</span>
                <span class="dive-code">{{ [d.dive_code, d.position].filter(Boolean).join(' ') }}</span>
                <span v-if="d.dd" class="dd-pill">DD {{ Number(d.dd).toFixed(1) }}</span>
                <span class="judge-scores">
                  <span v-for="(j, si) in annotatedScores(d.judge_scores, results.event?.number_of_judges)" :key="si"
                        :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                        :title="j.dropped ? 'Dropped by trim rule' : ''">
                    {{ j.value.toFixed(1) }}
                  </span>
                </span>
                <span class="dive-total">{{ Number(d.total_dive_score).toFixed(2) }}</span>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.archive-wrap { max-width: 900px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid var(--border);
}
.page-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem;
}
.page-title {
  font-family: var(--font-display); font-size: 40px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}

.filter-bar {
  display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap;
  padding: 0.875rem 1rem; margin-bottom: 1rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}
.filter-bar .input  { flex: 1 1 220px; max-width: 320px; }
.filter-bar .select { flex: 0 1 180px; max-width: 220px; }
.result-count {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-left: auto;
}

.content { display: flex; flex-direction: column; gap: 0.75rem; }

.empty { color: var(--text-3); font-family: var(--font-mono); font-size: 13px; padding: 2rem 0; }
.event-org { color: var(--text-2); font-weight: 600; }
.event-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-left: 0.4rem; vertical-align: middle;
}
.event-stat { color: var(--cyan); }

.event-block {
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  background: var(--surface); overflow: hidden;
  transition: border-color 0.2s; animation: fadeUp 0.25s ease;
}
.event-block:hover { border-color: var(--border-2); }

.event-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 1.25rem 1.5rem; cursor: pointer;
}
.event-name {
  font-family: var(--font-display); font-size: 18px; font-weight: 700;
  font-style: italic; color: var(--text);
}
.event-meta {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-top: 0.2rem; display: flex; gap: 0.5rem; flex-wrap: wrap;
}
.event-date { color: var(--text-3); margin-left: 0.5rem; }
.event-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }

.results-panel {
  border-top: 1px solid var(--border); padding: 1.5rem;
  background: var(--bg-2);
}

.section-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3); margin-bottom: 0.75rem;
}

.standings { display: flex; flex-direction: column; gap: 0.4rem; }
.standing-row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.6rem 0.875rem; border-radius: var(--radius);
  background: var(--bg-3); border: 1px solid var(--border);
  font-family: var(--font-display);
}
.standing-row.gold   { border-color: rgba(234,179,8,0.4);  background: rgba(234,179,8,0.06);  }
.standing-row.silver { border-color: rgba(148,163,184,0.4); background: rgba(148,163,184,0.06); }
.standing-row.bronze { border-color: rgba(180,83,9,0.4);   background: rgba(180,83,9,0.06);   }
.rank { font-size: 12px; font-weight: 700; color: var(--text-3); width: 1.5rem; }
.sname-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
.sname-line { display: flex; align-items: baseline; gap: 0.4rem; flex-wrap: wrap; }
.sname { font-size: 15px; font-weight: 700; color: var(--text); }
.ctry {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  padding: 0.1rem 0.4rem; border-radius: 3px;
  margin-left: 0.4rem; vertical-align: middle;
}
.club-line {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.partner-line {
  font-family: var(--font-display); font-size: 13px; font-weight: 600;
  color: var(--text-2);
}
.archive-amp { color: var(--cyan); margin: 0 0.35em; font-weight: 400; }
.total { font-size: 15px; font-weight: 900; color: var(--cyan); }

.diver-block { margin-bottom: 1rem; }
.diver-head { margin-bottom: 0.35rem; }
.diver-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text-2);
}
.diver-club {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-top: 0.15rem;
}
.dive-row {
  display: flex; align-items: center; gap: 0.75rem;
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  padding: 0.3rem 0; border-bottom: 1px solid var(--border);
}
.round-num { color: var(--text-3); width: 2rem; flex-shrink: 0; }
.dive-code { color: var(--text); font-weight: 500; min-width: 5rem; }
.dd-pill {
  color: var(--cyan); border: 1px solid rgba(6,182,212,0.3);
  background: var(--cyan-dim); border-radius: 3px;
  padding: 0.1rem 0.4rem; font-size: 10px; flex-shrink: 0;
}
.judge-scores {
  flex: 1; color: var(--text-3);
  display: flex; flex-wrap: wrap; gap: 0.25rem; min-width: 0;
}
.dive-total { font-weight: 700; color: var(--text); flex-shrink: 0; }
</style>
