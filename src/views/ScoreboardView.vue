<script setup>
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useSocket } from '@/composables/useSocket'
import { annotatedScores, groupedSynchroScoresForDisplay } from '@/composables/useScoreCategories'

const socket = useSocket({ spectator: true })

const events = ref([])
const currentEventId = ref(null)
const currentEvent = computed(() => events.value.find(e => String(e.id) === String(currentEventId.value)) || null)
const historyItems = ref([])
const standings = ref([])
const leaderboardRounds = ref([])     // [{ round_number, rankings: [...] }]
const standingsTab = ref('final')     // 'final' | 'by-round'
const expandedRound = ref(null)       // currently expanded round in by-round view
const activeDiver = ref(null)
const showOverlay = ref(false)
const overlayScore = ref('0.0')
// Completed-event archive payload — only populated when the
// selected event has status === 'Completed'. Drives the dive
// breakdown, podium and event-stats panels.
const archiveResults = ref(null)

const isCompleted = computed(() => currentEvent.value?.status === 'Completed')

const latestRound = computed(() => {
  if (!leaderboardRounds.value.length) return null
  return leaderboardRounds.value[leaderboardRounds.value.length - 1]
})

const isTeamEvent = computed(() => archiveResults.value?.event?.event_type === 'team')

// Group the archive's flat dive list. For team events the group
// key is the team name (so the breakdown reads team-by-team with
// each member's dive listed inside). For individual / synchro
// events it stays per-diver as before.
const divesByDiver = computed(() => {
  if (!archiveResults.value) return []
  const teamMode = isTeamEvent.value
  const order = new Map()
  ;(archiveResults.value.standings || []).forEach((s, i) => order.set(s.full_name, i))

  const grouped = new Map()
  for (const d of archiveResults.value.dives || []) {
    const key = teamMode ? (d.team_name || 'Unattached') : d.full_name
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(d)
  }
  for (const arr of grouped.values()) {
    arr.sort((a, b) => a.round_number - b.round_number)
  }
  return [...grouped.entries()]
    .sort((a, b) => (order.get(a[0]) ?? 999) - (order.get(b[0]) ?? 999))
    .map(([key, dives]) => ({
      name: key,
      country: teamMode ? null : (dives[0]?.country_code || null),
      club: teamMode ? null : (dives[0]?.club_name || null),
      partner: teamMode ? null : (dives[0]?.partner_name || null),
      partner_country: teamMode ? null : (dives[0]?.partner_country || null),
      isTeam: teamMode,
      total: archiveResults.value.standings.find(s => s.full_name === key)?.total ?? null,
      rank: (order.get(key) ?? -1) + 1,
      dives,
    }))
})

const eventStats = computed(() => {
  if (!archiveResults.value) return null
  const dives = archiveResults.value.dives || []
  const standings = archiveResults.value.standings || []

  let highest = null
  let biggestDD = null
  let perfectTens = 0
  let totalRaw = 0
  let totalCount = 0

  for (const d of dives) {
    const total = parseFloat(d.total_dive_score)
    if (!Number.isNaN(total) && (!highest || total > highest.total)) {
      highest = {
        diver: d.full_name,
        round: d.round_number,
        code: [d.dive_code, d.position].filter(Boolean).join(''),
        total,
      }
    }
    const dd = parseFloat(d.dd)
    if (!Number.isNaN(dd) && (!biggestDD || dd > biggestDD.dd)) {
      biggestDD = {
        diver: d.full_name,
        round: d.round_number,
        code: [d.dive_code, d.position].filter(Boolean).join(''),
        dd,
      }
    }
    const scores = parseScores(d.judge_scores)
    perfectTens += scores.filter(s => s === 10).length
    totalRaw += scores.reduce((a, b) => a + b, 0)
    totalCount += scores.length
  }

  const avgJudgeScore = totalCount ? (totalRaw / totalCount) : null
  const margin = standings.length >= 2
    ? parseFloat(standings[0].total) - parseFloat(standings[1].total)
    : null

  return {
    highest,
    biggestDD,
    perfectTens,
    margin,
    avgJudgeScore,
    totalDives: dives.length,
    competitors: standings.length,
  }
})

function selectEvent(id) {
  currentEventId.value = id
  expandedRound.value = null
  // Clear any stale active-diver state from a previous event so
  // the panel correctly shows "Waiting..." until the server
  // confirms the current performer for this event.
  activeDiver.value = null
  refreshData()
  // Pull the current active diver from the server. socket.io
  // buffers the emit until the connection is up, so this works
  // whether the socket has already connected or not.
  socket.emit('get_active_diver', { event_id: id })
}

function resetToEventPicker() {
  currentEventId.value = null
  activeDiver.value = null
  historyItems.value = []
  standings.value = []
  leaderboardRounds.value = []
  expandedRound.value = null
  archiveResults.value = null
}

async function refreshData() {
  if (!currentEventId.value) return
  try {
    if (isCompleted.value) {
      const [archive, leaderboard] = await Promise.all([
        fetch(`/api/archive/${currentEventId.value}/results`).then(r => r.json()),
        fetch(`/api/scoreboard/${currentEventId.value}/leaderboard`).then(r => r.json()),
      ])
      archiveResults.value = archive
      standings.value = archive.standings || []
      historyItems.value = []
      leaderboardRounds.value = leaderboard.rounds || []
    } else {
      archiveResults.value = null
      const [scoreboard, leaderboard] = await Promise.all([
        fetch(`/api/scoreboard/${currentEventId.value}`).then(r => r.json()),
        fetch(`/api/scoreboard/${currentEventId.value}/leaderboard`).then(r => r.json()),
      ])
      historyItems.value = scoreboard.history || []
      standings.value = scoreboard.standings || []
      leaderboardRounds.value = leaderboard.rounds || []
    }
    if (expandedRound.value === null && leaderboardRounds.value.length) {
      expandedRound.value = leaderboardRounds.value[leaderboardRounds.value.length - 1].round_number
    }
  } catch (err) {
    console.error('Refresh error', err)
  }
}

function fmtDate(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}


function movementClass(m) {
  if (m == null) return 'mv-new'
  if (m > 0) return 'mv-up'
  if (m < 0) return 'mv-down'
  return 'mv-flat'
}

function movementSymbol(m) {
  if (m == null) return '•'
  if (m > 0) return `▲${m}`
  if (m < 0) return `▼${Math.abs(m)}`
  return '–'
}

socket.on('state_update', data => {
  // Ignore broadcasts until the user has picked an event, and
  // ignore broadcasts for events other than the current one. This
  // prevents stale state from another event leaking into the
  // panel before the user has picked anything.
  if (!currentEventId.value) return
  if (data.event_id !== currentEventId.value) return
  activeDiver.value = data
})

// On (re)connect, re-request the current active diver if an
// event is already selected. Covers the case where the socket
// drops mid-session and the in-memory state was unchanged on
// the server but our local state went stale.
socket.on('connect', () => {
  if (currentEventId.value) {
    socket.emit('get_active_diver', { event_id: currentEventId.value })
  }
})

socket.on('final_score_announced', data => {
  overlayScore.value = typeof data.total === 'number' ? data.total.toFixed(1) : (data.total || '0.0')
  showOverlay.value = true
  setTimeout(() => {
    showOverlay.value = false
    refreshData()
  }, 4000)
})

function rankClass(i) {
  if (i === 0) return 'gold'
  if (i === 1) return 'silver'
  if (i === 2) return 'bronze'
  return ''
}

function parseScores(judgeArray) {
  if (!judgeArray) return []
  return judgeArray.split(',').map(s => parseFloat(s))
}

onMounted(async () => {
  try {
    events.value = await fetch('/api/events').then(r => r.json())
  } catch { events.value = [] }
})
</script>

<template>
  <div class="sb-layout">
    <!-- Header -->
    <div class="sb-header">
      <div style="display:flex;align-items:center;gap:1rem">
        <div v-if="isCompleted" class="status-badge done-badge">FINAL</div>
        <div v-else class="status-badge live-badge">LIVE</div>
        <span style="font-family:var(--font-display);font-size:16px;font-weight:900;font-style:italic;color:var(--text)">
          {{ isCompleted ? 'Event Recap' : 'Broadcast Feed' }}
        </span>
      </div>
      <select
        class="event-sel"
        :value="currentEventId || ''"
        @change="e => { const v = e.target.value; v ? selectEvent(v) : resetToEventPicker() }"
      >
        <option value="">— Select Event —</option>
        <option v-for="ev in events" :key="ev.id" :value="ev.id">{{ ev.name }}{{ ev.status === 'Completed' ? '  (final)' : '' }}</option>
      </select>
      <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
    </div>

    <!-- Body — Live or pre-event picker -->
    <div class="sb-body" v-if="!isCompleted">
      <!-- Left: History -->
      <div class="sb-col">
        <div class="col-head">Completed Dives</div>
        <div class="col-body">
          <p v-if="!historyItems.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No scores yet</p>
          <div v-for="(h, idx) in historyItems" :key="idx" class="hist-card">
            <div class="hist-round">Round {{ h.round_number }}{{ currentEvent?.total_rounds ? ` / ${currentEvent.total_rounds}` : '' }}</div>
            <div class="hist-header">
              <div class="hist-name">{{ h.full_name }}<span v-if="h.country_code" class="hist-country">{{ h.country_code }}</span></div>
              <div class="hist-total">{{ parseFloat(h.total_dive_score).toFixed(1) }}</div>
            </div>
            <div class="hist-dive-line">
              <span class="hist-code">{{ h.dive_code ? `${h.dive_code}${h.position || ''}` : '—' }}</span>
              <span v-if="h.dd != null" class="hist-dd">DD {{ parseFloat(h.dd).toFixed(1) }}</span>
            </div>
            <div v-if="h.description" class="hist-desc">{{ h.description }}</div>
            <div v-if="h.judge_array" class="hist-scores">
              <template v-if="currentEvent?.event_type === 'synchro_pair'">
                <div v-for="g in (groupedSynchroScoresForDisplay(h.judge_array, currentEvent.number_of_judges) || [])"
                     :key="g.role"
                     :class="['judge-group', `judge-group-${g.role}`]">
                  <span class="judge-group-label">{{ g.label }}</span>
                  <span v-for="(j, si) in g.scores" :key="si"
                        :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                        :title="j.dropped ? 'Dropped by trim rule' : ''">
                    {{ j.value.toFixed(1) }}
                  </span>
                </div>
              </template>
              <template v-else>
                <span v-for="(j, si) in annotatedScores(h.judge_array, currentEvent?.number_of_judges)" :key="si"
                      :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                      :title="j.dropped ? 'Dropped by trim rule' : ''">
                  {{ j.value.toFixed(1) }}
                </span>
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Centre: Active or event picker -->
      <div class="sb-col active-centre">
        <!-- No event selected: picker -->
        <div v-if="!currentEventId" id="no-event-view">
          <div class="picker-label">Select an Event to Follow</div>
          <div class="event-grid">
            <p v-if="!events.length" style="color:var(--text-3);font-size:13px">No events available</p>
            <div
              v-for="ev in events"
              :key="ev.id"
              class="event-card"
              @click="selectEvent(ev.id)"
            >
              <div class="event-card-name">{{ ev.name }}</div>
              <div class="event-card-meta">{{ ev.status || 'Active' }}</div>
            </div>
          </div>
        </div>

        <!-- Event selected -->
        <div v-else style="width:100%;text-align:center">
          <div v-if="activeDiver?.round_number" class="sb-round-pill">
            Round {{ activeDiver.round_number }}<span v-if="currentEvent?.total_rounds"> / {{ currentEvent.total_rounds }}</span>
          </div>
          <div class="sb-label">Current Performer</div>
          <div class="sb-name" :style="{ opacity: activeDiver ? '1' : '0.2' }">
            <template v-if="activeDiver?.partner_name">
              {{ activeDiver.diverName }}
              <span class="sb-name-amp">&amp;</span>
              {{ activeDiver.partner_name }}
            </template>
            <template v-else>
              {{ activeDiver?.diverName || 'Waiting...' }}
            </template>
          </div>
          <div v-if="activeDiver?.country_code || activeDiver?.club_name || activeDiver?.team_name"
               class="sb-country-line" :style="{ opacity: activeDiver ? '1' : '0.2' }">
            <span v-if="activeDiver.country_code">{{ activeDiver.country_code }}</span>
            <span v-if="activeDiver.team_name" class="sb-team-line">{{ activeDiver.team_name }}</span>
            <span v-if="activeDiver.club_name && !activeDiver.team_name" class="sb-club-line">{{ activeDiver.club_name }}</span>
          </div>
          <div class="sb-badges" :style="{ opacity: activeDiver ? '1' : '0.2' }">
            <div class="sb-code">{{ activeDiver?.diveCode || '—' }}</div>
            <div class="sb-dd">{{ activeDiver?.dd ? `DD ${activeDiver.dd}` : 'DD —' }}</div>
          </div>
          <div v-if="activeDiver?.description" class="sb-desc">{{ activeDiver.description }}</div>
        </div>
      </div>

      <!-- Right: Standings -->
      <div class="sb-col">
        <div class="col-head">
          <span>Standings</span>
          <div class="tabs">
            <button
              :class="['tab', standingsTab === 'final' ? 'tab-active' : '']"
              @click="standingsTab = 'final'"
            >Final</button>
            <button
              :class="['tab', standingsTab === 'by-round' ? 'tab-active' : '']"
              @click="standingsTab = 'by-round'"
            >By Round</button>
          </div>
        </div>
        <div class="col-body">
          <!-- Final view (existing) — augmented with movement vs previous round -->
          <template v-if="standingsTab === 'final'">
            <p v-if="!standings.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No standings yet</p>
            <div v-for="(s, i) in standings" :key="i" class="standing">
              <div :class="['standing-rank', rankClass(i)]">{{ i + 1 }}</div>
              <div class="standing-id">
                <div class="standing-name">
                  {{ s.full_name }}<span v-if="s.country_code" class="standing-country">{{ s.country_code }}</span>
                </div>
                <div v-if="s.partner_name" class="standing-partner">
                  &amp; {{ s.partner_name }}<span v-if="s.partner_country" class="standing-country">{{ s.partner_country }}</span>
                </div>
                <div v-if="s.club_name" class="standing-club">{{ s.club_name }}</div>
              </div>
              <div class="standing-score">{{ parseFloat(s.total).toFixed(1) }}</div>
            </div>
          </template>

          <!-- Round-by-round view: cumulative rank with movement arrows -->
          <template v-else>
            <p v-if="!leaderboardRounds.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No rounds completed yet</p>
            <div v-for="round in leaderboardRounds" :key="round.round_number" class="round-block">
              <button
                class="round-head"
                @click="expandedRound = expandedRound === round.round_number ? null : round.round_number"
              >
                <span>Round {{ round.round_number }}</span>
                <span class="round-caret">{{ expandedRound === round.round_number ? '▾' : '▸' }}</span>
              </button>
              <div v-if="expandedRound === round.round_number" class="round-body">
                <div v-for="r in round.rankings" :key="r.competitor_id" class="lb-row">
                  <div :class="['lb-rank', rankClass(r.rank - 1)]">{{ r.rank }}</div>
                  <div :class="['lb-mv', movementClass(r.movement)]">
                    {{ movementSymbol(r.movement) }}
                  </div>
                  <div class="lb-name">
                    {{ r.full_name }}<span v-if="r.country_code" class="standing-country">{{ r.country_code }}</span>
                  </div>
                  <div class="lb-cum">{{ r.cumulative_total.toFixed(1) }}</div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Body — Completed event recap -->
    <div class="sb-completed" v-else>
      <!-- Top metadata strip -->
      <div class="meta-strip">
        <div class="meta-left">
          <div class="meta-name">{{ currentEvent?.name }}</div>
          <div class="meta-tags">
            <span v-if="archiveResults?.event?.org_name" class="meta-tag meta-org">{{ archiveResults.event.org_name }}</span>
            <span v-if="currentEvent?.gender" class="meta-tag">{{ currentEvent.gender }}</span>
            <span v-if="currentEvent?.height" class="meta-tag">{{ currentEvent.height }}</span>
            <span v-if="currentEvent?.total_rounds" class="meta-tag">{{ currentEvent.total_rounds }} rounds</span>
            <span v-if="currentEvent?.number_of_judges" class="meta-tag">{{ currentEvent.number_of_judges }} judges</span>
            <span v-if="currentEvent?.created_at" class="meta-tag meta-date">{{ fmtDate(currentEvent.created_at) }}</span>
          </div>
        </div>
        <a :href="`/api/events/${currentEventId}/results.pdf`"
           target="_blank" rel="noopener"
           class="btn btn-ghost btn-sm">Export PDF</a>
      </div>

      <!-- Two-column body: standings + dive breakdown -->
      <div class="completed-grid">
        <!-- Left: Podium → Standings → Stats -->
        <div class="completed-col">
          <div class="col-head">
            <span>Standings</span>
            <div class="tabs">
              <button
                :class="['tab', standingsTab === 'final' ? 'tab-active' : '']"
                @click="standingsTab = 'final'"
              >Final</button>
              <button
                :class="['tab', standingsTab === 'by-round' ? 'tab-active' : '']"
                @click="standingsTab = 'by-round'"
              >By Round</button>
            </div>
          </div>
          <div class="col-body">
            <p v-if="!standings.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No results recorded</p>

            <template v-if="standingsTab === 'final'">
              <!-- Podium spotlight: top 3 with bigger treatment -->
              <div v-if="standings.length >= 3" class="podium">
                <div class="podium-step podium-2">
                  <div class="podium-medal silver">2</div>
                  <div class="podium-name">{{ standings[1].full_name }}</div>
                  <div class="podium-country">{{ standings[1].country_code || '' }}</div>
                  <div class="podium-total">{{ parseFloat(standings[1].total).toFixed(1) }}</div>
                </div>
                <div class="podium-step podium-1">
                  <div class="podium-medal gold">1</div>
                  <div class="podium-name">{{ standings[0].full_name }}</div>
                  <div class="podium-country">{{ standings[0].country_code || '' }}</div>
                  <div class="podium-total">{{ parseFloat(standings[0].total).toFixed(1) }}</div>
                </div>
                <div class="podium-step podium-3">
                  <div class="podium-medal bronze">3</div>
                  <div class="podium-name">{{ standings[2].full_name }}</div>
                  <div class="podium-country">{{ standings[2].country_code || '' }}</div>
                  <div class="podium-total">{{ parseFloat(standings[2].total).toFixed(1) }}</div>
                </div>
              </div>

              <!-- Full standings list -->
              <div class="standings-list">
                <div v-for="(s, i) in standings" :key="i" class="standing">
                  <div :class="['standing-rank', rankClass(i)]">{{ i + 1 }}</div>
                  <div class="standing-name">{{ s.full_name }}<span v-if="s.country_code" class="standing-country">{{ s.country_code }}</span></div>
                  <div class="standing-score">{{ parseFloat(s.total).toFixed(1) }}</div>
                </div>
              </div>

              <!-- Event stats panel -->
              <div v-if="eventStats" class="stats-panel">
                <div class="stats-head">Meet Highlights</div>
                <div v-if="eventStats.margin != null" class="stat-row">
                  <span class="stat-label">Margin of victory</span>
                  <span class="stat-value">{{ eventStats.margin.toFixed(2) }}</span>
                </div>
                <div v-if="eventStats.highest" class="stat-row">
                  <span class="stat-label">Highest dive total</span>
                  <span class="stat-value">{{ eventStats.highest.total.toFixed(1) }}</span>
                </div>
                <div v-if="eventStats.highest" class="stat-sub">
                  {{ eventStats.highest.diver }} · R{{ eventStats.highest.round }} · {{ eventStats.highest.code }}
                </div>
                <div v-if="eventStats.biggestDD" class="stat-row">
                  <span class="stat-label">Biggest DD attempted</span>
                  <span class="stat-value">{{ eventStats.biggestDD.dd.toFixed(1) }}</span>
                </div>
                <div v-if="eventStats.biggestDD" class="stat-sub">
                  {{ eventStats.biggestDD.diver }} · R{{ eventStats.biggestDD.round }} · {{ eventStats.biggestDD.code }}
                </div>
                <div class="stat-row">
                  <span class="stat-label">Perfect 10s awarded</span>
                  <span class="stat-value">{{ eventStats.perfectTens }}</span>
                </div>
                <div v-if="eventStats.avgJudgeScore != null" class="stat-row">
                  <span class="stat-label">Avg judge score</span>
                  <span class="stat-value">{{ eventStats.avgJudgeScore.toFixed(2) }}</span>
                </div>
                <div class="stat-row">
                  <span class="stat-label">Competitors / dives</span>
                  <span class="stat-value">{{ eventStats.competitors }} / {{ eventStats.totalDives }}</span>
                </div>
              </div>
            </template>

            <!-- Round-by-round leaderboard with movement arrows -->
            <template v-else>
              <p v-if="!leaderboardRounds.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No round data available</p>
              <div v-for="round in leaderboardRounds" :key="round.round_number" class="round-block">
                <button
                  class="round-head"
                  @click="expandedRound = expandedRound === round.round_number ? null : round.round_number"
                >
                  <span>Round {{ round.round_number }}</span>
                  <span class="round-caret">{{ expandedRound === round.round_number ? '▾' : '▸' }}</span>
                </button>
                <div v-if="expandedRound === round.round_number" class="round-body">
                  <div v-for="r in round.rankings" :key="r.competitor_id" class="lb-row">
                    <div :class="['lb-rank', rankClass(r.rank - 1)]">{{ r.rank }}</div>
                    <div :class="['lb-mv', movementClass(r.movement)]">
                      {{ movementSymbol(r.movement) }}
                    </div>
                    <div class="lb-id">
                      <div class="lb-name">
                        {{ r.full_name }}<span v-if="r.country_code" class="standing-country">{{ r.country_code }}</span>
                      </div>
                      <div v-if="r.club_name" class="lb-club">{{ r.club_name }}</div>
                    </div>
                    <div class="lb-cum">{{ r.cumulative_total.toFixed(1) }}</div>
                  </div>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- Right: Dive breakdown grouped by diver -->
        <div class="completed-col">
          <div class="col-head"><span>Dive Breakdown</span></div>
          <div class="col-body">
            <p v-if="!divesByDiver.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No dive data</p>
            <div v-for="block in divesByDiver" :key="block.name" class="diver-block">
              <div class="diver-head">
                <div class="diver-rank-badge" :class="rankClass(block.rank - 1)">{{ block.rank }}</div>
                <div class="diver-id">
                  <div class="diver-id-row">
                    <div class="diver-name">
                      {{ block.name }}<span v-if="block.country" class="diver-country">{{ block.country }}</span>
                      <template v-if="block.partner">
                        <span class="diver-amp">&amp;</span>
                        {{ block.partner }}<span v-if="block.partner_country" class="diver-country">{{ block.partner_country }}</span>
                      </template>
                    </div>
                    <div class="diver-total" v-if="block.total != null">{{ parseFloat(block.total).toFixed(1) }} pts</div>
                  </div>
                  <div v-if="block.club" class="diver-club">{{ block.club }}</div>
                </div>
              </div>
              <div class="dive-table">
                <div class="dive-row dive-head-row">
                  <div class="dr-round">Rd</div>
                  <div class="dr-code">Dive</div>
                  <div class="dr-dd">DD</div>
                  <div class="dr-judges">Judge Scores</div>
                  <div class="dr-total">Total</div>
                </div>
                <div v-for="d in block.dives" :key="d.round_number + (d.full_name || '')" class="dive-row">
                  <div class="dr-round">R{{ d.round_number }}</div>
                  <div class="dr-code">
                    <span v-if="block.isTeam" class="dr-team-member">{{ d.full_name }}</span>
                    <span class="dr-code-main">{{ [d.dive_code, d.position].filter(Boolean).join(' ') }}</span>
                    <span v-if="d.description" class="dr-code-desc">{{ d.description }}</span>
                  </div>
                  <div class="dr-dd">{{ d.dd != null ? parseFloat(d.dd).toFixed(1) : '—' }}</div>
                  <div class="dr-judges">
                    <template v-if="currentEvent?.event_type === 'synchro_pair'">
                      <div v-for="g in (groupedSynchroScoresForDisplay(d.judge_scores, currentEvent.number_of_judges) || [])"
                           :key="g.role"
                           :class="['judge-group', `judge-group-${g.role}`]">
                        <span class="judge-group-label">{{ g.label }}</span>
                        <span v-for="(j, si) in g.scores" :key="si"
                              :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                              :title="j.dropped ? 'Dropped by trim rule' : ''">
                          {{ j.value.toFixed(1) }}
                        </span>
                      </div>
                    </template>
                    <template v-else>
                      <span v-for="(j, si) in annotatedScores(d.judge_scores, currentEvent?.number_of_judges)" :key="si"
                            :class="['j-score', `j-${j.category}`, j.dropped ? 'j-dropped' : '']"
                            :title="j.dropped ? 'Dropped by trim rule' : ''">
                        {{ j.value.toFixed(1) }}
                      </span>
                    </template>
                  </div>
                  <div class="dr-total">{{ parseFloat(d.total_dive_score).toFixed(1) }}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Score overlay -->
    <div v-if="showOverlay" class="score-overlay">
      <div class="overlay-score">{{ overlayScore }}</div>
      <div class="overlay-label">Points Awarded</div>
    </div>
  </div>
</template>

<style scoped>
.sb-layout { overflow: hidden; height: 100vh; display: flex; flex-direction: column; }

.sb-header {
  background: var(--bg-2); border-bottom: 1px solid var(--border);
  padding: 0.875rem 1.5rem; display: flex; align-items: center;
  justify-content: space-between; flex-shrink: 0;
}
.status-badge {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.2em; padding: 0.25rem 0.75rem;
  border-radius: 4px; color: white;
}
.live-badge { background: var(--red); animation: pulse-red 2s infinite; }
.done-badge { background: var(--text-2); color: var(--bg); }
@keyframes pulse-red { 0%,100%{opacity:1} 50%{opacity:0.7} }

.sb-body { flex: 1; display: grid; grid-template-columns: 380px 1fr 300px; overflow: hidden; }
.sb-col { display: flex; flex-direction: column; overflow: hidden; }
.sb-col:not(:last-child) { border-right: 1px solid var(--border); }
.col-head {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  padding: 1rem 1.25rem; border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.col-body { flex: 1; overflow-y: auto; padding: 1rem; }

.active-centre {
  display: flex; flex-direction: column; align-items: center;
  justify-content: flex-start; padding: 2rem; text-align: center;
  background: var(--bg-2); overflow-y: auto;
}
.sb-round-pill {
  display: inline-block;
  font-family: var(--font-display);
  font-size: 12px; font-weight: 900; font-style: italic;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--cyan);
  background: var(--cyan-dim);
  border: 1px solid rgba(6, 182, 212, 0.4);
  border-radius: 999px;
  padding: 0.3rem 0.9rem;
  margin-bottom: 1.25rem;
}
.sb-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.4em; text-transform: uppercase; color: var(--cyan); margin-bottom: 1rem; }
.sb-name { font-family: var(--font-display); font-size: clamp(36px,6vw,72px); font-weight: 900; font-style: italic; color: var(--text); line-height: 1; margin-bottom: 1.5rem; }
.sb-badges { display: flex; justify-content: center; gap: 1.5rem; margin-bottom: 1rem; }
.sb-code { font-family: var(--font-mono); font-size: clamp(24px,4vw,36px); color: var(--text); }
.sb-dd { font-family: var(--font-display); font-size: clamp(18px,3vw,28px); font-weight: 700; color: var(--cyan); }
.sb-desc { font-family: var(--font-mono); font-size: clamp(13px,1.8vw,18px); color: var(--text-3); margin-top: 1rem; }
.sb-country-line { font-family: var(--font-mono); font-size: clamp(14px,2vw,20px); font-weight: 700; letter-spacing: 0.15em; color: var(--text-3); margin-bottom: 1.5rem; }

#no-event-view { display: flex; flex-direction: column; align-items: center; width: 100%; max-width: 700px; }
.picker-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3); margin-bottom: 2rem; }
.event-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(200px,1fr)); gap: 1rem; width: 100%; }
.event-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; cursor: pointer; transition: all 0.15s; text-align: left; }
.event-card:hover { border-color: var(--cyan); background: var(--cyan-dim); }
.event-card-name { font-family: var(--font-display); font-size: 16px; font-weight: 900; font-style: italic; color: var(--text); margin-bottom: 0.375rem; line-height: 1.2; }
.event-card-meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.event-card:hover .event-card-name { color: var(--cyan); }

.score-overlay {
  position: fixed; inset: 0; background: var(--cyan); z-index: 300;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.overlay-score { font-family: var(--font-display); font-size: clamp(100px,25vw,200px); font-weight: 900; line-height: 1; color: var(--bg); }
.overlay-label { font-family: var(--font-display); font-size: 14px; font-weight: 700; letter-spacing: 0.5em; text-transform: uppercase; color: rgba(3,7,18,0.6); margin-top: 1rem; }

.hist-card { padding: 0.875rem 1rem; border-left: 2px solid var(--cyan); background: var(--bg-3); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; margin-bottom: 0.5rem; }
.hist-round { font-size: 10px; color: var(--text-3); margin-bottom: 0.3rem; font-family: var(--font-mono); }
.hist-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.3rem; }
.hist-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text); }
.hist-total { font-family: var(--font-mono); font-size: 16px; font-weight: 500; color: var(--cyan); flex-shrink: 0; margin-left: 0.5rem; }
.hist-dive-line { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.3rem; }
.hist-code { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--text); }
.hist-dd { font-family: var(--font-display); font-size: 11px; font-weight: 700; color: var(--cyan); }
.hist-desc { font-size: 10px; color: var(--text-3); margin-bottom: 0.4rem; }
.hist-country { font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: var(--text-3); background: var(--bg-2); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.4rem; vertical-align: middle; }
.hist-scores { display: flex; flex-wrap: wrap; gap: 0.3rem; }

.standing { display: flex; align-items: center; gap: 0.75rem; padding: 0.75rem 0; border-bottom: 1px solid var(--border); }
.standing:last-child { border-bottom: none; }
.standing-rank { font-family: var(--font-mono); font-size: 13px; color: var(--text-3); width: 24px; flex-shrink: 0; text-align: right; }
.standing-rank.gold { color: #f59e0b; }
.standing-rank.silver { color: #94a3b8; }
.standing-rank.bronze { color: #92400e; }
.standing-id { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 0.1rem; }
.standing-name { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text); }
.standing-club { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.standing-partner { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text-2); }
.sb-name-amp { color: var(--cyan); margin: 0 0.4em; font-weight: 400; }
.diver-amp { color: var(--cyan); margin: 0 0.35em; font-weight: 400; }
.standing-country { font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: var(--text-3); background: var(--bg-2); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.4rem; vertical-align: middle; }
.standing-score { font-family: var(--font-mono); font-size: 15px; font-weight: 500; color: var(--text); }
.sb-club-line { font-family: var(--font-mono); font-size: clamp(11px,1.4vw,14px); color: var(--text-3); margin-left: 0.6rem; }
.sb-team-line { font-family: var(--font-display); font-size: clamp(13px,1.7vw,18px); font-weight: 700; color: var(--cyan); margin-left: 0.7rem; }

.event-sel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.4rem 0.75rem; font-family: var(--font-mono); font-size: 13px; color: var(--text); outline: none; cursor: pointer; }

/* Standings panel head — title plus Final/By Round tabs */
.col-head { display: flex; align-items: center; justify-content: space-between; }
.tabs { display: flex; gap: 0.25rem; }
.tab {
  font-family: var(--font-mono); font-size: 10px; letter-spacing: 0.1em;
  text-transform: uppercase; padding: 0.25rem 0.5rem; cursor: pointer;
  background: transparent; border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--text-3);
}
.tab:hover { color: var(--text-2); border-color: var(--border-2); }
.tab-active { background: var(--cyan-dim); border-color: var(--cyan); color: var(--cyan); }

/* Round-by-round leaderboard */
.round-block { border-bottom: 1px solid var(--border); }
.round-block:last-child { border-bottom: none; }
.round-head {
  width: 100%; display: flex; align-items: center; justify-content: space-between;
  padding: 0.6rem 0; background: transparent; border: none; cursor: pointer;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-2);
}
.round-head:hover { color: var(--cyan); }
.round-caret { font-size: 12px; color: var(--text-3); }
.round-body { padding: 0.25rem 0 0.6rem; }

.lb-row {
  display: grid; grid-template-columns: 24px 36px 1fr auto;
  align-items: center; gap: 0.5rem; padding: 0.45rem 0;
  border-top: 1px solid var(--border);
}
.lb-row:first-child { border-top: none; }
.lb-rank {
  font-family: var(--font-mono); font-size: 13px; color: var(--text-3);
  text-align: right;
}
.lb-rank.gold   { color: #f59e0b; font-weight: 700; }
.lb-rank.silver { color: #94a3b8; font-weight: 700; }
.lb-rank.bronze { color: #92400e; font-weight: 700; }

.lb-mv {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  text-align: center; padding: 0.1rem 0.25rem; border-radius: 3px;
  border: 1px solid var(--border); background: var(--bg-2);
  color: var(--text-3);
}
.lb-mv.mv-up   { color: var(--green); border-color: rgba(16,185,129,0.4); background: rgba(16,185,129,0.08); }
.lb-mv.mv-down { color: var(--red);   border-color: rgba(239,68,68,0.4);  background: rgba(239,68,68,0.08); }
.lb-mv.mv-flat { color: var(--text-3); }
.lb-mv.mv-new  { color: var(--cyan);  border-color: rgba(6,182,212,0.4);  background: var(--cyan-dim); }

.lb-id   { display: flex; flex-direction: column; gap: 0.1rem; min-width: 0; }
.lb-name { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.lb-club { font-family: var(--font-mono); font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lb-cum  { font-family: var(--font-mono); font-size: 14px; font-weight: 500; color: var(--cyan); flex-shrink: 0; }

/* =========================================================
   Completed-event layout
   ========================================================= */
.sb-completed { flex: 1; display: flex; flex-direction: column; overflow: hidden; }

.meta-strip {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 0.75rem 1.5rem;
  background: var(--bg-2); border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.meta-left { display: flex; flex-direction: column; gap: 0.4rem; min-width: 0; }
.meta-name {
  font-family: var(--font-display); font-size: 22px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.meta-tags { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.meta-tag {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 0.15rem 0.45rem; background: var(--bg-3);
}
.meta-tag.meta-org { color: var(--cyan); border-color: rgba(6,182,212,0.3); background: var(--cyan-dim); }
.meta-tag.meta-date { color: var(--text-2); }

.completed-grid {
  flex: 1; display: grid; grid-template-columns: 380px 1fr; overflow: hidden;
}
.completed-col { display: flex; flex-direction: column; overflow: hidden; }
.completed-col:first-child { border-right: 1px solid var(--border); }

/* Podium spotlight: gold in middle + slightly elevated, silver left, bronze right */
.podium {
  display: grid; grid-template-columns: 1fr 1.1fr 1fr; gap: 0.5rem;
  align-items: end; padding: 1rem 0.5rem 1.25rem;
  border-bottom: 1px solid var(--border);
}
.podium-step {
  display: flex; flex-direction: column; align-items: center;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 0.6rem 0.4rem; text-align: center; min-width: 0;
}
.podium-1 { padding: 0.85rem 0.4rem; border-color: rgba(234,179,8,0.4); background: rgba(234,179,8,0.06); }
.podium-2 { border-color: rgba(148,163,184,0.35); background: rgba(148,163,184,0.05); }
.podium-3 { border-color: rgba(180,83,9,0.35);    background: rgba(180,83,9,0.05); }
.podium-medal {
  width: 28px; height: 28px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-size: 14px; font-weight: 900;
  color: var(--bg); margin-bottom: 0.4rem;
}
.podium-medal.gold   { background: #f59e0b; }
.podium-medal.silver { background: #94a3b8; }
.podium-medal.bronze { background: #b45309; }
.podium-name {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text); line-height: 1.15;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%;
}
.podium-country { font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.05em; color: var(--text-3); margin-top: 0.15rem; }
.podium-total { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--cyan); margin-top: 0.35rem; }

.standings-list { padding: 0.25rem 0; }

/* Event stats panel */
.stats-panel {
  margin-top: 1rem; padding: 0.75rem 0.875rem;
  border: 1px solid var(--border); border-radius: var(--radius);
  background: var(--bg-3);
}
.stats-head {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.5rem;
}
.stat-row {
  display: flex; justify-content: space-between; align-items: baseline;
  padding: 0.25rem 0; font-size: 12px;
}
.stat-label { color: var(--text-3); font-family: var(--font-mono); }
.stat-value { font-family: var(--font-mono); font-weight: 700; color: var(--text); }
.stat-sub {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  margin-top: -0.1rem; margin-bottom: 0.25rem;
}

/* Right column: dive breakdown by diver */
.diver-block {
  border-bottom: 1px solid var(--border);
  padding: 0.85rem 0;
}
.diver-block:first-child { padding-top: 0.5rem; }
.diver-block:last-child { border-bottom: none; }
.diver-head {
  display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.5rem;
}
.diver-rank-badge {
  width: 28px; height: 28px; border-radius: var(--radius-sm);
  display: flex; align-items: center; justify-content: center;
  font-family: var(--font-display); font-size: 13px; font-weight: 900;
  background: var(--bg-3); border: 1px solid var(--border); color: var(--text-3);
  flex-shrink: 0;
}
.diver-rank-badge.gold   { color: #f59e0b; border-color: rgba(234,179,8,0.5); background: rgba(234,179,8,0.08); }
.diver-rank-badge.silver { color: #94a3b8; border-color: rgba(148,163,184,0.5); background: rgba(148,163,184,0.08); }
.diver-rank-badge.bronze { color: #b45309; border-color: rgba(180,83,9,0.5); background: rgba(180,83,9,0.08); }
.diver-id { display: flex; flex-direction: column; gap: 0.15rem; flex: 1; min-width: 0; }
.diver-id-row { display: flex; align-items: baseline; gap: 0.6rem; }
.diver-name {
  font-family: var(--font-display); font-size: 16px; font-weight: 700;
  color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.diver-club {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.diver-country {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700; letter-spacing: 0.05em;
  color: var(--text-3); background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.4rem; vertical-align: middle;
}
.diver-total { font-family: var(--font-mono); font-size: 13px; font-weight: 700; color: var(--cyan); margin-left: auto; flex-shrink: 0; }

.dive-table { display: flex; flex-direction: column; }
.dive-row {
  display: grid;
  grid-template-columns: 36px 1fr 48px 1fr 56px;
  align-items: center; gap: 0.6rem;
  padding: 0.4rem 0.25rem; font-size: 12px;
  border-top: 1px solid var(--border);
}
.dive-row:first-child { border-top: none; }
.dive-head-row {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  padding: 0.25rem 0.25rem 0.35rem;
}
.dr-round { font-family: var(--font-mono); color: var(--text-3); }
.dr-code-main { font-family: var(--font-mono); font-weight: 700; color: var(--text); }
.dr-code-desc { font-size: 10px; color: var(--text-3); margin-left: 0.4rem; }
.dr-team-member { font-family: var(--font-display); font-size: 11px; font-weight: 700; color: var(--text-2); margin-right: 0.5rem; }
.dr-dd {
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  color: var(--cyan); text-align: right;
}
.dr-judges { display: flex; gap: 0.25rem; flex-wrap: wrap; min-width: 0; }
/* .j-score (FINA category chips) styles are global in
   public/css/app.css — shared with the Archive view. */
.dr-total {
  font-family: var(--font-mono); font-size: 13px; font-weight: 700;
  color: var(--text); text-align: right;
}

/* Tighter screens */
@media (max-width: 1100px) {
  .completed-grid { grid-template-columns: 1fr; }
  .completed-col:first-child { border-right: none; border-bottom: 1px solid var(--border); }
  .dive-row { grid-template-columns: 32px 1fr 44px 1fr 52px; }
}

/* Phone — collapse the live 3-column layout (history / centre /
   standings) into a single scrolling stack so the active diver
   stays the hero, with history above and standings below. */
@media (max-width: 720px) {
  .sb-body {
    display: flex;
    flex-direction: column;
    overflow: visible;
  }
  .sb-col {
    overflow: visible;
    border-right: none !important;
    border-bottom: 1px solid var(--border);
  }
  .sb-col:last-child { border-bottom: none; }
  .col-body { padding: 0.75rem 1rem; max-height: 360px; }
  .active-centre { padding: 1.5rem 1rem; }

  /* Big "current diver" name dominates the centre column on
     desktop, but on a phone it has to fit a 320–414px width.
     The clamp() already handles it, but tighten the floor. */
  .sb-name { font-size: clamp(28px, 9vw, 48px); margin-bottom: 1rem; }
  .sb-badges { gap: 1rem; margin-bottom: 0.75rem; flex-wrap: wrap; }

  /* Picker grid for "no live event" state */
  .event-grid { grid-template-columns: 1fr; }
  .event-card { padding: 1.1rem; }

  /* Score overlay — keep it dramatic but stop the score from
     overflowing on tiny viewports. */
  .overlay-score { font-size: clamp(72px, 28vw, 140px); }
  .overlay-label { font-size: 11px; letter-spacing: 0.35em; }

  /* Standings rows: pack tighter so they don't wrap awkwardly */
  .standing { padding: 0.6rem 0; gap: 0.5rem; }
  .standing-name { font-size: 14px; }
  .standing-score { font-size: 14px; }

  /* =========================================================
     Completed-event recap — phone-specific fixes
     ========================================================= */

  /* The header is a single-row flex on desktop. On a phone the
     event-sel dropdown gets pushed off-screen — let it wrap onto
     its own full-width row, tighten everything else. */
  .sb-header {
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.625rem 0.875rem;
  }
  .sb-header > div:first-child { gap: 0.6rem !important; }
  .sb-header > div:first-child > span {
    font-size: 13px !important;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .event-sel {
    flex: 1 1 100%;
    min-width: 0;
    order: 3;            /* drop below the FINAL/LIVE pill row */
    font-size: 13px;
    padding: 0.5rem 0.65rem;
  }
  .status-badge { padding: 0.2rem 0.55rem; font-size: 9px; }

  /* Meta-strip: tighten event name + reflow tags */
  .meta-strip { padding: 0.6rem 0.875rem; gap: 0.6rem; flex-wrap: wrap; }
  .meta-name  { font-size: 17px; line-height: 1.15; }
  .meta-tag   { font-size: 9.5px; padding: 0.1rem 0.4rem; }

  /* Hide the podium spotlight on mobile. The full standings list
     immediately below already shows the top three with gold /
     silver / bronze rank colours, so the podium is pure
     duplication that eats vertical space. */
  .podium { display: none; }

  /* Tabs cluster (Final / By Round) needs to fit alongside the
     "Standings" col-head label without bleeding. */
  .col-head { padding: 0.65rem 0.875rem; gap: 0.5rem; flex-wrap: wrap; }

  /* Stats panel — keep but compact. It's "nice to have" data
     that historically pushed the dive breakdown below the fold. */
  .stats-panel { margin-top: 0.6rem; padding: 0.6rem 0.7rem; }
  .stats-head  { font-size: 9px; letter-spacing: 0.2em; margin-bottom: 0.35rem; }
  .stat-row    { font-size: 11px; padding: 0.15rem 0; }

  /* Diver breakdown blocks: pull tighter so more dives fit. */
  .diver-block { padding: 0.6rem 0; }
  .diver-name  { font-size: 14px; }
  .diver-total { font-size: 12px; }
  .diver-rank-badge { width: 24px; height: 24px; font-size: 11px; }
}
</style>
