<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import { useSocket } from '@/composables/useSocket'
import { annotatedScores, groupedSynchroScoresForDisplay, trimCount } from '@/composables/useScoreCategories'
import { diveDescription } from '@/composables/useDiveLabel'
import { cachedFetch } from '@/lib/idbCache'
import DiverIdentity from '@/components/DiverIdentity.vue'

const route  = useRoute()
const router = useRouter()
const socket = useSocket({ spectator: true })

// Broadcast / kiosk mode: when the URL ends in /broadcast we
// hide the page chrome (header, dashboard link) so a venue
// projector shows just the standings and active diver. Toggled
// purely via the URL so a meet operator can switch a screen
// into kiosk mode without leaving the page.
const broadcastMode = computed(() => route.params.mode === 'broadcast')

// Stream-overlay mode: ?overlay=1 puts the page into a minimal,
// chroma-key-friendly layout for OBS / streaming software. Hides
// every background colour, header, and panel chrome — just the
// active diver block + a compact top-3. Chroma-key colour is set
// by ?bg=<hex>; defaults to a vivid green (#00ff44) which is the
// standard OBS chroma colour. Operators can pick e.g. ?bg=ff00ff
// for magenta if their lighting pushes a green spill.
const overlayMode = computed(() => route.query.overlay === '1' || route.query.overlay === 'true')
const overlayBg   = computed(() => {
  const raw = String(route.query.bg || '').replace(/^#/, '').trim()
  return /^[0-9a-fA-F]{6}$/.test(raw) ? `#${raw}` : '#00ff44'
})

// Browsable list of every Live + Completed meet. Used as the
// landing state of the page; the user picks one and we pivot
// into either the live broadcast layout or the recap layout.
const events = ref([])
const clubsList = ref([])
const loadingList = ref(false)
const meetsFromCache = ref(false)

const currentEventId = ref(null)
const currentEvent = computed(() => events.value.find(e => String(e.id) === String(currentEventId.value)) || null)

// Filters drive the meets list when no event is selected.
const searchTerm    = ref('')
const countryFilter = ref('')
const yearFilter    = ref('')
const heightFilter  = ref('')
const clubFilter    = ref('')
const statusFilter  = ref('')      // '' | 'Live' | 'Completed'

const liveEvents = computed(() => events.value.filter(e => e.status === 'Live'))

// Up Next: filter the server's queue to skip the current active
// diver (so they don't appear as both "current performer" and
// "up next"). Returns the FULL remaining queue — the panel below
// scrolls when the list overflows ~10 rows. Empty array → panel
// hides.
//
// Also drops the head-of-queue when the centre block is rendering
// it as the "On Deck" placeholder (no live active diver yet) so
// the same diver doesn't appear in both spots.
const upcomingDisplay = computed(() => {
  if (!upcoming.value?.length) return []
  const active = activeDiver.value?.diverName
  const round  = activeDiver.value?.round_number
  let list = upcoming.value
  // Active diver currently mid-dive — exclude their queue row.
  if (active) {
    list = list.filter(u => !(u.full_name === active && u.round_number === round))
  } else {
    // No active diver — the head of the queue is being shown in
    // the centre as "On Deck", so drop it from this list.
    list = list.slice(1)
  }
  return list
})

// Centre-block performer: the live active diver when one is
// announced, otherwise the head of the upcoming queue rendered
// as "On Deck". Keeps the spectator scoreboard from sitting on
// "Waiting..." mid-meet — between rounds, or before the operator
// has clicked Next Diver, the audience can still see who's about
// to dive. Normalised to the shape activeDiver carries so the
// downstream template doesn't branch on data source.
const centrePerformer = computed(() => {
  if (activeDiver.value) {
    return { kind: 'active', ...activeDiver.value }
  }
  const next = upcoming.value?.[0]
  if (next) {
    return {
      kind: 'next',
      round_number: next.round_number,
      competitor_id: next.competitor_id || null,
      partner_id:    next.partner_id    || null,
      diverName:     next.full_name,
      partner_name:  next.partner_name  || null,
      country_code:  next.country_code  || null,
      club_name:     next.club_name     || null,
      team_name:     next.team_name     || null,
      diveCode:      next.dive_code ? `${next.dive_code}${next.position || ''}` : null,
      dd:            next.dd ?? null,
      description:   next.description || null,
      position:      next.position || null,
    }
  }
  return null
})

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
  for (const e of events.value) if (e.created_at) set.add(new Date(e.created_at).getFullYear())
  return [...set].sort((a, b) => b - a)
})

const heights = computed(() => {
  const set = new Set()
  for (const e of events.value) if (e.height) set.add(e.height)
  return [...set]
})

// Cascade: when a country is picked, only show its clubs in the
// dropdown. With no country selected we show every club and
// prefix each name with its country code.
const visibleClubs = computed(() => {
  if (!countryFilter.value) return clubsList.value
  return clubsList.value.filter(c => c.country_code === countryFilter.value)
})

const filteredEvents = computed(() => {
  const term = searchTerm.value.trim().toLowerCase()
  return events.value.filter(e => {
    if (statusFilter.value && e.status !== statusFilter.value) return false
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

const activeFilterCount = computed(() => {
  let n = 0
  if (searchTerm.value.trim()) n++
  if (countryFilter.value)     n++
  if (yearFilter.value)        n++
  if (heightFilter.value)      n++
  if (clubFilter.value)        n++
  if (statusFilter.value)      n++
  return n
})

function clearFilters() {
  searchTerm.value    = ''
  countryFilter.value = ''
  yearFilter.value    = ''
  heightFilter.value  = ''
  clubFilter.value    = ''
  statusFilter.value  = ''
}

// CSV export of the currently-filtered meets list. Useful for
// federations doing year-end reporting — pick a year + status
// in the filter, click Export.
function exportMeetsCsv() {
  const headers = [
    'Name', 'Org', 'Country', 'Status', 'Date',
    'Gender', 'Height', 'Type', 'Rounds', 'Judges',
    'Competitors', 'Clubs',
  ]
  const escape = (v) => {
    const s = v == null ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = filteredEvents.value.map(e => [
    e.name,
    e.org_name,
    e.country_code || '',
    e.status,
    e.created_at ? new Date(e.created_at).toISOString().slice(0, 10) : '',
    e.gender || '',
    e.height || '',
    e.event_type || 'individual',
    e.total_rounds,
    e.number_of_judges,
    e.competitor_count || 0,
    e.club_count || 0,
  ].map(escape).join(','))
  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `dive-recorder-meets-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Drop the club filter if the user picks a country whose clubs
// don't include the currently-selected club.
watch(countryFilter, (val) => {
  if (!val || !clubFilter.value) return
  const club = clubsList.value.find(c => c.id === clubFilter.value)
  if (club && club.country_code !== val) clubFilter.value = ''
})

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
const historyItems = ref([])
const standings = ref([])
const upcoming = ref([])         // next ≤5 dives queued, populated for Live events

// Show-more pagination — Completed Dives defaults to 5 cards
// (most-recent round of a 5-judge meet usually fits a single
// round of dives in view), Up Next stays at a tighter 3-row
// preview because the audience really only needs to see "who's
// next + on deck". Both have a toggle to expand to the full set.
//
// preview / rest split: the toggle button is rendered INSIDE
// the v-for after the last preview entry so it stays at a
// fixed visual position when the list expands — extra entries
// drop down below the button instead of pushing it off-screen.
const HISTORY_PREVIEW_COUNT  = 5
const UP_NEXT_PREVIEW_COUNT  = 3
const historyShowAll = ref(false)
const upNextShowAll  = ref(false)
const historyPreview = computed(() =>
  historyItems.value.slice(0, HISTORY_PREVIEW_COUNT),
)
const upcomingPreview = computed(() =>
  upcomingDisplay.value.slice(0, UP_NEXT_PREVIEW_COUNT),
)
const leaderboardRounds = ref([])     // [{ round_number, rankings: [...] }]
const standingsTab = ref('final')     // 'final' | 'by-round'
const expandedRound = ref(null)       // currently expanded round in by-round view
const activeDiver = ref(null)
// Per-judge scores arriving live for the active diver, in
// judge_number order. Pushed by score_received, cleared whenever
// state_update broadcasts a new active diver/round. Renders as
// the inline pills under the Current Performer block, replacing
// the older fullscreen score-overlay UX.
const liveJudgeScores = ref([])
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
    .map(([key, dives]) => {
      // Pull partner_id off the matching standings row (the
      // archive standings query exposes it for synchro events).
      // Falls back to scanning the dive rows if standings doesn't
      // surface it for some reason — partner_id from competitor
      // _dive_lists rides on every dive of that diver.
      const standRow = archiveResults.value.standings
        .find(s => s.full_name === key)
      return {
        name: key,
        country: teamMode ? null : (dives[0]?.country_code || null),
        club: teamMode ? null : (dives[0]?.club_name || null),
        partner: teamMode ? null : (dives[0]?.partner_name || null),
        partner_id: teamMode ? null : (standRow?.partner_id || dives.find(d => d.partner_id)?.partner_id || null),
        partner_country: teamMode ? null : (dives[0]?.partner_country || null),
        isTeam: teamMode,
        total: standRow?.total ?? null,
        rank: (order.get(key) ?? -1) + 1,
        dives,
      }
    })
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

// Hold state for the active event — set by Control Room via
// the meet_hold socket event. Surfaces a banner across the top
// of the page while in effect.
const isHeld = ref(false)
const holdReason = ref('')

function selectEvent(id, { pushUrl = true } = {}) {
  currentEventId.value = id
  expandedRound.value = null
  // Clear any stale active-diver state from a previous event so
  // the panel correctly shows "Waiting..." until the server
  // confirms the current performer for this event.
  activeDiver.value = null
  isHeld.value = false
  holdReason.value = ''
  // Reset the show-more pagination state so a freshly opened
  // event lands in the calmer 3-row preview rather than
  // inheriting a previous event's expanded view.
  historyShowAll.value = false
  upNextShowAll.value  = false
  refreshData()
  // Pull the current active diver from the server. socket.io
  // buffers the emit until the connection is up, so this works
  // whether the socket has already connected or not.
  socket.emit('get_active_diver', { event_id: id })
  // Pull the current hold state too — covers the case where the
  // page loads after a hold has already been set.
  socket.emit('get_meet_hold', { event_id: id })
  // Reflect the selection in the URL so the meet is shareable
  // and back-button works. pushUrl=false avoids loops when this
  // is being driven *by* a URL change.
  if (pushUrl && route.params.eventId !== id) {
    router.push({ path: `/scoreboard/${id}` })
  }
}

function resetToEventPicker({ pushUrl = true } = {}) {
  currentEventId.value = null
  activeDiver.value = null
  historyItems.value = []
  standings.value = []
  upcoming.value = []
  leaderboardRounds.value = []
  expandedRound.value = null
  archiveResults.value = null
  if (pushUrl && route.params.eventId) {
    router.push({ path: '/scoreboard' })
  }
}

// Drive the view from the URL. If someone deep-links to
// /scoreboard/<id> or hits Back/Forward, we sync state to match
// without reflecting back into the URL (which would loop).
watch(() => route.params.eventId, (newId) => {
  const id = newId || null
  if (id === currentEventId.value) return
  if (id) selectEvent(id, { pushUrl: false })
  else    resetToEventPicker({ pushUrl: false })
}, { immediate: false })

// Refresh when the current event's status flips. The events
// list arrives via cachedFetch (stale-while-revalidate); the
// initial selectEvent runs against whatever's in IndexedDB,
// which may still say Live for an event that's actually
// Completed by the time the page loads. When the fresh
// /api/archive response lands and rewrites currentEvent.status,
// re-fetch so the SPA swaps from the live broadcast layout into
// the recap (or vice versa) rather than staying on the cached
// view.
watch(() => currentEvent.value?.status, (status, prev) => {
  if (!currentEventId.value) return
  if (status && prev && status !== prev) refreshData()
})

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
      upcoming.value = scoreboard.upcoming || []
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

// Record-broken toasts (PB / club / federation) used to pop in
// the top-right of the scoreboard on each new record. Removed —
// they distracted from the live standings panel they overlapped.
// The server still fires record_broken; we just don't render it
// here. If a quieter celebration UX is wanted later, re-listen
// for record_broken and pick a presentation that doesn't sit on
// top of the standings.

socket.on('state_update', data => {
  // Ignore broadcasts until the user has picked an event, and
  // ignore broadcasts for events other than the current one. This
  // prevents stale state from another event leaking into the
  // panel before the user has picked anything.
  if (!currentEventId.value) return
  if (data.event_id !== currentEventId.value) return
  // Clear the per-judge live pills when the active diver/round
  // changes — the new diver hasn't been scored yet, and the old
  // diver's pills would visually carry over otherwise.
  const sameDive = activeDiver.value
    && activeDiver.value.competitor_id === data.competitor_id
    && Number(activeDiver.value.round_number) === Number(data.round_number)
  if (!sameDive) liveJudgeScores.value = []
  activeDiver.value = data
})

// Per-judge live score updates. Each judge's submit_score is
// broadcast as score_received to every subscriber on the event
// room. We collect them in judge_number order so the SPA's
// inline-under-active-diver display can show the lights coming
// in one at a time and (once the panel is full) shade the high
// + low as dropped under FINA trim rules.
socket.on('score_received', data => {
  if (!currentEventId.value) return
  if (data.event_id !== currentEventId.value) return
  if (!activeDiver.value) return
  if (data.competitor_id !== activeDiver.value.competitor_id) return
  if (Number(data.round_number) !== Number(activeDiver.value.round_number)) return
  // Same judge resubmitting (rare — referee correction path)
  // overwrites their pill rather than adding a 6th.
  const idx = liveJudgeScores.value.findIndex(s => s.judge_number === data.judge_number)
  const next = { value: Number(data.score), judge_number: data.judge_number }
  if (idx >= 0) liveJudgeScores.value[idx] = next
  else liveJudgeScores.value = [...liveJudgeScores.value, next]
  liveJudgeScores.value.sort((a, b) => a.judge_number - b.judge_number)
})

// On (re)connect, re-request the current active diver if an
// event is already selected. Covers the case where the socket
// drops mid-session and the in-memory state was unchanged on
// the server but our local state went stale.
socket.on('connect', () => {
  if (currentEventId.value) {
    socket.emit('get_active_diver', { event_id: currentEventId.value })
    socket.emit('get_meet_hold',    { event_id: currentEventId.value })
  }
})

// Hold-state propagation. The Control Room dispatches meet_hold
// + meet_resume; we set a banner accordingly. Per-event check so
// a hold on a different meet doesn't bleed into this scoreboard.
socket.on('meet_held', (data) => {
  if (data.event_id !== currentEventId.value) return
  isHeld.value = true
  holdReason.value = data.reason || ''
})
socket.on('meet_resumed', (data) => {
  if (data.event_id !== currentEventId.value) return
  isHeld.value = false
  holdReason.value = ''
})

// Score corrections fired by the Control Room: re-pull the
// scoreboard so totals reflect the amendment. Cheap full-pull
// is fine — score corrections are rare events.
socket.on('score_corrected', (data) => {
  if (data.event_id !== currentEventId.value) return
  refreshData()
})

socket.on('final_score_announced', () => {
  // Was a 4-second fullscreen overlay. The audience now sees
  // the dive total inline under the active-diver block (computed
  // from the score_received pills × DD), so just trigger a
  // standings refresh and let the inline UI carry the spotlight.
  refreshData()
})

function rankClass(i) {
  if (i === 0) return 'gold'
  if (i === 1) return 'silver'
  if (i === 2) return 'bronze'
  return ''
}

// English ordinal for a 1-based rank (1 → "1st", 2 → "2nd", …).
// Used by the "Currently Nth" line under the active diver.
function ordinal(n) {
  if (n == null) return ''
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

// Per-judge pills for the current active diver, annotated with
// scoreCategory + dropped-under-trim flag. Reuses the same helper
// the Completed-Dives panel uses, so the chip styling is identical.
const liveAnnotatedScores = computed(() => {
  if (!liveJudgeScores.value.length) return []
  const csv = liveJudgeScores.value.map(s => s.value).join(',')
  return annotatedScores(csv, currentEvent.value?.number_of_judges)
})

// Stable-layout placeholders — generates an array of `number_of_judges`
// tiles ALWAYS (even when no scores have arrived), so the live-judges
// row's height stays constant from the moment a diver becomes active.
// Without this the row started at 0px, then jumped to ~50px the
// instant the first score landed, shoving the catch-up + Up Next
// blocks below it down. Each slot either carries a populated score
// (with FINA category + dropped flag) or renders as a dim "—"
// placeholder; either way the tile dimensions are identical.
const liveJudgeSlots = computed(() => {
  const numJudges = Number(currentEvent.value?.number_of_judges) || 5
  const annotated = liveAnnotatedScores.value
  const slots = []
  for (let i = 0; i < numJudges; i++) {
    const filled = annotated[i]
    if (filled) {
      slots.push({
        filled: true,
        value: filled.value,
        category: filled.category,
        dropped: filled.dropped,
      })
    } else {
      slots.push({ filled: false })
    }
  }
  return slots
})

// Dive total for the active diver — only populated once the full
// panel is in (otherwise we'd be flashing partial sums). Computed
// as (sum of non-dropped scores) × DD.
const liveDiveTotal = computed(() => {
  const annotated = liveAnnotatedScores.value
  const need = Number(currentEvent.value?.number_of_judges) || 5
  if (annotated.length < need) return null
  const dd = parseFloat(activeDiver.value?.dd)
  if (!dd || Number.isNaN(dd)) return null
  const trimSum = annotated
    .filter(j => !j.dropped)
    .reduce((sum, j) => sum + j.value, 0)
  return trimSum * dd
})

// 1-based rank of the active diver in the current standings, or
// null if we can't find them (e.g. before the first refresh).
// Matches by the diverName field that set_active_diver carries.
const activeDiverRank = computed(() => {
  if (!activeDiver.value || !standings.value.length) return null
  const target = activeDiver.value.full_name || activeDiver.value.diverName
  if (!target) return null
  const idx = standings.value.findIndex(s => s.full_name === target)
  return idx >= 0 ? idx + 1 : null
})

// Catch-up projection — mirrors the Control Room indicator. For
// the active diver, computes:
//   * gap to leader (or to runner-up if leading)
//   * average dive total they need across remaining dives
//   * average judge score per kept score those dives need
// DD proxy is the active diver's current dive (we don't have
// the full upcoming roster on the audience scoreboard, just the
// state_update payload that drives the active block). Catch-up
// table mirrors the Control Room — surfaces the average judge
// score needed across the remaining dives to reach 1st / 2nd /
// 3rd, with "not possible" for targets that even straight 10s
// wouldn't catch.
function pairLabel(row) {
  if (!row) return ''
  if (row.partner_name) return `${row.full_name} & ${row.partner_name}`
  return row.full_name || ''
}

function panelMultiplier(numJudges, isSynchro) {
  // Synchro 9/11 collapse to a 9-judge equivalent after the
  // calc_event_dive_points 3/n_kept rescale; individual events
  // multiply by the post-trim kept count.
  if (isSynchro) return 9
  const drop = trimCount(numJudges)
  return Math.max(1, (parseInt(numJudges) || 5) - 2 * drop)
}

const activeProjection = computed(() => {
  // Subject — the diver the projection table is computed FOR.
  // We use the active diver when one is on the board, and fall
  // back to the on-deck (next-up) performer otherwise so the
  // catch-up table stays visible BEFORE the diver is officially
  // on the board too. Same shape covers both: round_number, dd,
  // full_name / diverName all come through on each.
  const subject = activeDiver.value
    || (centrePerformer.value?.kind === 'next' ? centrePerformer.value : null)
  if (!subject || !standings.value.length) return null
  const target = subject.full_name || subject.diverName
  if (!target) return null
  const idx = standings.value.findIndex(s => s.full_name === target)
  const leader = standings.value[0]
  if (!leader) return null
  const totalRounds = parseInt(currentEvent.value?.total_rounds) || 0
  const numJudges   = parseInt(currentEvent.value?.number_of_judges) || 5
  const isSynchro   = currentEvent.value?.event_type === 'synchro_pair'
  const ddProxy     = parseFloat(subject.dd) || null
  const remaining   = totalRounds
    ? totalRounds - (parseInt(subject.round_number) || 1) + 1
    : 0
  const mult = panelMultiplier(numJudges, isSynchro)

  // Per-dive contribution if every judge scores X is X × mult ×
  // DD. So gap G across R dives at avg DD D solves to
  // X = G / (mult × D × R). 10 is the ceiling — any X > 10 means
  // straight 10s wouldn't close the gap.
  //
  // The displayed score rounds UP to the next 0.5 because judges
  // can only score in half-point increments — 5.2 isn't a
  // possible judge score, but 5.5 is. Rounded value is what the
  // diver would need from EVERY judge on every remaining dive to
  // mathematically guarantee closing the gap. `possible` stays
  // tied to the raw value so a raw of 9.6 (rounds to 10.0 —
  // straight 10s, achievable) doesn't flip to "not possible".
  function avgJudgeForGap(gap) {
    if (gap <= 0)                   return { score: 0,    possible: true  }
    if (remaining <= 0 || !ddProxy) return { score: null, possible: null  }
    const raw = gap / (mult * ddProxy * remaining)
    const rounded = Math.ceil(raw * 2) / 2
    return { score: rounded, possible: raw <= 10 }
  }

  if (idx === -1) {
    return {
      kind: 'pre',
      activeName: target,
      leaderName: pairLabel(leader),
      leaderTotal: Number(leader.total || 0),
    }
  }

  const me = standings.value[idx]
  const myTotal = Number(me.total || 0)
  const myLabel = pairLabel(me)

  if (idx === 0) {
    const second = standings.value[1]
    if (!second) return { kind: 'unopposed', activeName: myLabel }
    const gap = myTotal - Number(second.total || 0)
    const { score, possible } = avgJudgeForGap(gap)
    return {
      kind: 'lead',
      activeName: myLabel,
      runnerUp: pairLabel(second),
      gap, remaining,
      avgJudge: score, possible,
    }
  }

  // Chase: build a row for each podium rank above the active
  // diver (max 1st / 2nd / 3rd). Beyond #3 the panel gets dense
  // and the spectator-facing scoreboard is supposed to skim, not
  // read deeply.
  const targets = []
  for (const r of [0, 1, 2].filter(r => r < idx)) {
    const opponent = standings.value[r]
    const gap = Number(opponent.total || 0) - myTotal
    const { score, possible } = avgJudgeForGap(gap)
    targets.push({
      rank: r + 1,
      name: pairLabel(opponent),
      gap,
      avgJudge: score,
      possible,
    })
  }
  return {
    kind: 'chase',
    activeName: myLabel,
    currentRank: idx + 1,
    remaining,
    targets,
  }
})

function parseScores(judgeArray) {
  if (!judgeArray) return []
  return judgeArray.split(',').map(s => parseFloat(s))
}

onMounted(async () => {
  loadingList.value = true
  meetsFromCache.value = false
  try {
    // Stale-while-revalidate via IndexedDB. Spectators landing
    // on /scoreboard get an instant render from cache (if they've
    // visited before) and the network refresh updates the list
    // when it lands. Works offline for browsing past meets even
    // if the network is gone — only live state stays unavailable.
    const [evs, cls] = await Promise.all([
      cachedFetch('/api/archive', { credentials: 'same-origin' }, {
        onUpdate(fresh) {
          if (Array.isArray(fresh)) { events.value = fresh; meetsFromCache.value = false }
        },
      }),
      cachedFetch('/api/archive/clubs', { credentials: 'same-origin' }, {
        onUpdate(fresh) { if (Array.isArray(fresh)) clubsList.value = fresh },
      }),
    ])
    if (Array.isArray(evs.data)) {
      events.value = evs.data
      meetsFromCache.value = evs.fromCache
    }
    if (Array.isArray(cls.data)) {
      clubsList.value = cls.data
    }
  } finally {
    loadingList.value = false
  }
  // Bootstrap from a deep-link URL (e.g. /scoreboard/<id>) once
  // the events list has loaded, so currentEvent resolves.
  const initial = route.params.eventId
  if (initial) selectEvent(initial, { pushUrl: false })
})
</script>

<template>
  <div class="sb-layout"
       :class="{ 'broadcast-mode': broadcastMode, 'overlay-mode': overlayMode }"
       :style="overlayMode ? { background: overlayBg } : null">
    <!-- Floating exit button when in broadcast mode — small,
         positioned in the corner, nearly invisible until hover.
         Lets an operator drop back into the normal layout
         without retyping the URL. -->
    <RouterLink
      v-if="broadcastMode && currentEventId"
      :to="`/scoreboard/${currentEventId}`"
      class="broadcast-exit"
      title="Exit broadcast mode"
    >✕</RouterLink>
    <!-- Connection banner — visible whenever the spectator
         socket has dropped. Live event watchers won't see new
         dives until reconnect, so it's worth surfacing. -->
    <div v-if="!socket.isConnected.value && currentEventId && !isCompleted" class="conn-banner">
      <span class="conn-dot"></span>
      Reconnecting to live feed…
    </div>

    <!-- Meet-hold banner — surfaces when the Control Room has
         paused the meet (video review, judge consultation,
         technical issue). Visible across all spectator devices
         so the audience knows why nothing's happening. -->
    <div v-if="isHeld && currentEventId" class="hold-banner">
      <span class="hold-pulse">⏸ MEET ON HOLD</span>
      <span v-if="holdReason" class="hold-reason">{{ holdReason }}</span>
    </div>
    <!-- Header — adapts to list mode (browsing) vs detail mode
         (a single event selected). The detail header doubles as a
         breadcrumb so the user can jump back to the list. Hidden
         entirely in broadcast mode so a venue projector shows
         only the live scoring content. -->
    <div v-if="!broadcastMode" class="sb-header">
      <template v-if="!currentEventId">
        <div class="header-left">
          <span class="sb-page-title">Scoreboard &amp; Results</span>
          <span v-if="events.length" class="sb-page-sub">
            <span v-if="liveEvents.length" class="sb-page-sub-live">{{ liveEvents.length }} live now</span>
            <span v-if="liveEvents.length"> · </span>
            {{ events.length - liveEvents.length }} archived
          </span>
        </div>
      </template>
      <template v-else>
        <div class="header-left">
          <button @click="resetToEventPicker" class="btn btn-ghost btn-sm" style="margin-right:0.5rem">← All Meets</button>
          <div v-if="isCompleted" class="status-badge done-badge">FINAL</div>
          <div v-else class="status-badge live-badge">LIVE</div>
          <span class="sb-event-name">{{ currentEvent?.name || (isCompleted ? 'Event Recap' : 'Broadcast Feed') }}</span>
        </div>
      </template>
      <div style="display:flex;gap:0.4rem;align-items:center">
        <!-- Broadcast / kiosk mode toggle. Visible only when an
             event is selected; flips into a chromeless layout
             suitable for a venue projector. -->
        <RouterLink
          v-if="currentEventId && !isCompleted"
          :to="`/scoreboard/${currentEventId}/broadcast`"
          class="btn btn-ghost btn-sm"
          title="Open in broadcast / kiosk mode (no page chrome)"
        >📺 Broadcast</RouterLink>
        <a
          v-if="currentEventId && !isCompleted"
          :href="`/scoreboard/${currentEventId}?overlay=1`"
          target="_blank" rel="noopener"
          class="btn btn-ghost btn-sm"
          title="Open the chroma-key overlay (for OBS / streaming). Append &bg=ff00ff for a magenta key colour."
        >🎬 Stream overlay</a>
        <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">Dashboard</RouterLink>
      </div>
    </div>

    <!-- =========================================================
         LIST MODE — no event selected. Browses every Live and
         Completed meet with the same filter controls the old
         ArchiveView used.
         ========================================================= -->
    <div v-if="!currentEventId" class="meets-mode">
      <!-- Cache banner — visible while the meets list was served
           from IndexedDB and the network refresh is in flight.
           Disappears the moment fresh data arrives. -->
      <div v-if="meetsFromCache" class="cache-banner">
        <span class="cache-dot"></span>
        Showing your last cached meets list — refreshing in the background
      </div>

      <!-- Live banner: only visible when at least one meet is in
           progress. Each card jumps straight into the live
           broadcast layout for that event. -->
      <div v-if="liveEvents.length" class="live-banner">
        <div class="live-banner-head">
          <div class="live-pulse">LIVE NOW</div>
          <span class="live-banner-sub">
            {{ liveEvents.length }} {{ liveEvents.length === 1 ? 'meet is' : 'meets are' }} broadcasting
          </span>
        </div>
        <div class="live-banner-cards">
          <button v-for="ev in liveEvents" :key="ev.id" class="live-event-card" @click="selectEvent(ev.id)">
            <div class="live-event-name">{{ ev.name }}</div>
            <div class="live-event-meta">
              {{ ev.org_name }}<span v-if="ev.country_code" class="live-event-ctry">{{ ev.country_code }}</span>
              <span v-if="ev.height"> · {{ ev.height }}</span>
              <span> · {{ ev.total_rounds }} rounds</span>
            </div>
            <!-- Round + most-recent diver from /api/archive's
                 LATERAL join. Only shows once at least one dive
                 has scored — before that we keep the generic
                 "Watch live" CTA. -->
            <div v-if="ev.current_round" class="live-event-now">
              Round {{ ev.current_round }} / {{ ev.total_rounds }}
              <span v-if="ev.last_diver_name"> · {{ ev.last_diver_name }} just scored</span>
            </div>
            <div class="live-event-watch">Watch live →</div>
          </button>
        </div>
      </div>

      <!-- Filter bar -->
      <div v-if="events.length" class="filter-bar">
        <input class="input" type="text" v-model="searchTerm"
               placeholder="Search meet, host org, country…">
        <select class="select" v-model="statusFilter">
          <option value="">All statuses</option>
          <option value="Live">Live now</option>
          <option value="Completed">Completed</option>
        </select>
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
        <button v-if="activeFilterCount" class="btn btn-ghost btn-sm" @click="clearFilters">Clear filters</button>
        <button
          v-if="filteredEvents.length"
          class="btn btn-ghost btn-sm"
          @click="exportMeetsCsv"
          title="Download the currently-filtered list as CSV"
        >Export CSV</button>
        <span class="result-count">
          {{ filteredEvents.length.toLocaleString() }} of {{ events.length.toLocaleString() }} meets
        </span>
      </div>

      <!-- Meet cards grid -->
      <div v-if="loadingList" class="meets-empty">Loading meets…</div>
      <div v-else-if="!events.length" class="meets-empty">No meets yet — check back when one starts.</div>
      <div v-else-if="!filteredEvents.length" class="meets-empty">
        No meets match these filters.
        <button class="btn btn-ghost btn-sm" style="margin-left:0.5rem" @click="clearFilters">Clear</button>
      </div>
      <div v-else class="meets-grid">
        <button v-for="ev in filteredEvents" :key="ev.id" class="meet-card" @click="selectEvent(ev.id)">
          <div class="meet-card-head">
            <span class="meet-card-name">{{ ev.name }}</span>
            <span v-if="ev.status === 'Live'" class="meet-card-status live">LIVE</span>
            <span v-else class="meet-card-status final">FINAL</span>
          </div>
          <div class="meet-card-org">
            {{ ev.org_name }}<span v-if="ev.country_code" class="meet-card-ctry">{{ ev.country_code }}</span>
          </div>
          <!-- Meet badge — appears for events that belong to a
               multi-event meet bundle. Tapping the badge stops
               the card click and opens the meet landing page. -->
          <RouterLink
            v-if="ev.meet_id"
            :to="`/meet/${ev.meet_id}`"
            class="meet-card-meetlink"
            @click.stop
            :title="`Part of ${ev.meet_name}`"
          >📅 {{ ev.meet_name }}</RouterLink>
          <div class="meet-card-tags">
            <span v-if="ev.gender" class="meet-tag">{{ ev.gender }}</span>
            <span v-if="ev.height" class="meet-tag">{{ ev.height }}</span>
            <span class="meet-tag">{{ ev.total_rounds }} rds</span>
            <span class="meet-tag">{{ ev.number_of_judges }}j</span>
            <span v-if="ev.event_type === 'synchro_pair'" class="meet-tag meet-tag-cyan">Synchro</span>
            <span v-else-if="ev.event_type === 'team'" class="meet-tag meet-tag-cyan">Team</span>
          </div>
          <div class="meet-card-stats">
            <span v-if="ev.competitor_count">
              {{ ev.competitor_count }} {{ ev.competitor_count === 1 ? 'diver' : 'divers' }}
            </span>
            <span v-if="ev.club_count">
              · {{ ev.club_count }} {{ ev.club_count === 1 ? 'club' : 'clubs' }}
            </span>
            <span class="meet-card-date">{{ fmtDate(ev.created_at) }}</span>
          </div>
        </button>
      </div>
    </div>

    <!-- Body — Live broadcast layout (only when an event is selected
         and it's not completed). The completed branch is handled by
         the <div class="sb-completed"> below. -->
    <div class="sb-body" v-else-if="!isCompleted">
      <!-- Left: History -->
      <div class="sb-col">
        <div class="col-head">Completed Dives</div>
        <div class="col-body">
          <p v-if="!historyItems.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No scores yet</p>
          <!-- Preview cards (always visible) + toggle button +
               rest cards (visible when expanded) — wrapped in a
               single v-for over either the preview or the full
               list, with the toggle injected after the
               (HISTORY_PREVIEW_COUNT)th card. Keeps the toggle
               anchored at a fixed visual position; clicking
               drops the rest of the list down BELOW the
               button. -->
          <template v-for="(h, idx) in (historyShowAll ? historyItems : historyPreview)"
                    :key="`${h.competitor_id}-${h.round_number}`">
          <div class="hist-card">
            <div class="hist-round">Round {{ h.round_number }}{{ currentEvent?.total_rounds ? ` / ${currentEvent.total_rounds}` : '' }}</div>
            <!-- Shared identity block — same source of truth as
                 the Control Room. Lead + synchro partner stack
                 equal-weight, team / club secondary line for
                 non-synchro rows, country / team / club chip top-
                 right alongside the dive total. -->
            <DiverIdentity
              :row="h"
              :competitor-id="h.competitor_id"
              :partner-id="h.partner_id"
              link-profiles
              variant="split"
              class="hist-identity">
              <template #trailing>
                <div class="hist-total">{{ parseFloat(h.total_dive_score).toFixed(1) }}</div>
              </template>
            </DiverIdentity>
            <!-- Dive header: code + DD + description in a single
                 row. Mirrors the Control Room's history card so
                 the audience and the operator see the same shape. -->
            <div class="hist-dive-line">
              <span class="hist-code">{{ h.dive_code ? `${h.dive_code}${h.position || ''}` : '—' }}</span>
              <span v-if="h.dd != null" class="hist-dd">DD {{ parseFloat(h.dd).toFixed(1) }}</span>
              <span v-if="h.description" class="hist-desc">{{ diveDescription(h) }}</span>
            </div>
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
          <!-- Toggle button rendered INSIDE the v-for after the
               last preview card. Stays at a fixed position when
               clicked: expanding renders the rest of the list
               BELOW the button, not above it. -->
          <button
            v-if="idx === HISTORY_PREVIEW_COUNT - 1
                  && historyItems.length > HISTORY_PREVIEW_COUNT"
            class="hist-toggle"
            @click="historyShowAll = !historyShowAll"
          >
            {{ historyShowAll
                ? `Show fewer ↑`
                : `Show ${historyItems.length - HISTORY_PREVIEW_COUNT} more ↓` }}
          </button>
          </template>
        </div>
      </div>

      <!-- Centre: Active diver. The list of meets is now the page's
           landing state, so we no longer render a separate picker
           here — by the time we render this branch, currentEventId
           is guaranteed to be set. -->
      <div class="sb-col active-centre">
        <div style="width:100%;text-align:center">
          <div v-if="centrePerformer?.round_number" class="sb-round-pill">
            Round {{ centrePerformer.round_number }}<span v-if="currentEvent?.total_rounds"> / {{ currentEvent.total_rounds }}</span>
          </div>
          <!-- Label flips between live ("Current Performer") and
               on-deck ("On Deck — Up Next") so the audience knows
               whether the named diver is actively performing or
               just queued. -->
          <div class="sb-label">
            <template v-if="centrePerformer?.kind === 'active'">Current Performer</template>
            <template v-else-if="centrePerformer?.kind === 'next'">On Deck — Up Next</template>
            <template v-else>Current Performer</template>
          </div>
          <div :class="['sb-name', centrePerformer?.kind === 'next' ? 'sb-name-next' : '']"
               :style="{ opacity: centrePerformer ? (centrePerformer.kind === 'next' ? '0.7' : '1') : '0.2' }">
            <template v-if="centrePerformer?.partner_name">
              <RouterLink v-if="centrePerformer?.competitor_id" :to="`/profile/${centrePerformer.competitor_id}`" class="diver-link">{{ centrePerformer.diverName }}</RouterLink>
              <template v-else>{{ centrePerformer.diverName }}</template>
              <span class="sb-name-amp">&amp;</span>
              <RouterLink v-if="centrePerformer?.partner_id" :to="`/profile/${centrePerformer.partner_id}`" class="diver-link">{{ centrePerformer.partner_name }}</RouterLink>
              <template v-else>{{ centrePerformer.partner_name }}</template>
            </template>
            <template v-else>
              <RouterLink v-if="centrePerformer?.competitor_id" :to="`/profile/${centrePerformer.competitor_id}`" class="diver-link">{{ centrePerformer.diverName }}</RouterLink>
              <template v-else>{{ centrePerformer?.diverName || 'Waiting...' }}</template>
            </template>
          </div>
          <div v-if="centrePerformer?.country_code || centrePerformer?.club_name || centrePerformer?.team_name"
               class="sb-country-line" :style="{ opacity: centrePerformer ? (centrePerformer.kind === 'next' ? '0.7' : '1') : '0.2' }">
            <span v-if="centrePerformer.country_code">{{ centrePerformer.country_code }}</span>
            <span v-if="centrePerformer.team_name" class="sb-team-line">{{ centrePerformer.team_name }}</span>
            <span v-if="centrePerformer.club_name && !centrePerformer.team_name" class="sb-club-line">{{ centrePerformer.club_name }}</span>
          </div>
          <!-- Dive code · DD · description on a single row.
               Was previously two rows (badges + a separate
               .sb-desc beneath); collapsed to one to save a
               row of vertical space and to keep the centre
               column tighter. -->
          <div class="sb-badges" :style="{ opacity: centrePerformer ? (centrePerformer.kind === 'next' ? '0.7' : '1') : '0.2' }">
            <div class="sb-code">{{ centrePerformer?.diveCode || '—' }}</div>
            <div class="sb-dd">{{ centrePerformer?.dd ? `DD ${centrePerformer.dd}` : 'DD —' }}</div>
            <div v-if="centrePerformer?.description" class="sb-desc">{{ diveDescription(centrePerformer) }}</div>
          </div>

          <!-- Live judges' scores for the active diver. Pills are
               styled with the same .j-score / .j-dropped classes
               the Completed-Dives panel uses, so the visual
               vocabulary is consistent. Once the panel is full,
               the high + low pills shade out via .j-dropped and
               the Dive Total appears below.
               STABLE LAYOUT: every block here renders for ANY
               centrePerformer (active OR on-deck) so the layout
               is identical between "On Deck — Diver Alpha" and
               "Current Performer — Diver Alpha (mid-dive)". The
               judge tiles are placeholder "—" pills until scores
               arrive; the dive-total wrapper has a reserved
               min-height; the rank line wraps in a slot div with
               a min-height so its eventual appearance doesn't
               push the catch-up + Up Next blocks below it down. -->
          <div v-if="centrePerformer" class="sb-live-judges">
            <span v-for="(slot, i) in liveJudgeSlots" :key="i"
                  :class="['j-score',
                           slot.filled ? `j-${slot.category}` : 'j-empty',
                           slot.dropped ? 'j-dropped' : '']"
                  :title="slot.dropped ? 'Dropped by trim rule' : ''">
              {{ slot.filled ? slot.value.toFixed(1) : '—' }}
            </span>
          </div>
          <div v-if="centrePerformer" class="sb-live-total-slot">
            <div v-show="liveDiveTotal != null" class="sb-live-total">
              <span class="sb-live-total-label">Dive Total</span>
              <span class="sb-live-total-value">{{ liveDiveTotal != null ? liveDiveTotal.toFixed(1) : '' }}</span>
            </div>
          </div>
          <div v-if="centrePerformer" class="sb-live-rank-slot">
            <div v-show="activeDiver && activeDiverRank" class="sb-live-rank">
              Currently <strong>{{ activeDiverRank ? ordinal(activeDiverRank) : '' }}</strong>
            </div>
          </div>
          <!-- Catch-up projection — table per podium target with
               the average judge score the active diver needs over
               the remaining dives. Caps at 10 (anything above
               reads "Not possible"). Mirrors the Control Room
               panel so the audience and the operator see the
               same chase math. -->
          <div v-if="activeProjection" :class="['sb-projection', `sb-projection-${activeProjection.kind}`]">
            <template v-if="activeProjection.kind === 'chase'">
              <div class="sb-projection-head">
                Catch-up — <strong>{{ activeProjection.remaining }}</strong>
                {{ activeProjection.remaining === 1 ? 'dive' : 'dives' }} left
                · currently {{ ordinal(activeProjection.currentRank) }}
              </div>
              <div v-for="t in activeProjection.targets" :key="t.rank" class="sb-catchup-row">
                <span class="sb-catchup-rank">{{ ordinal(t.rank) }}</span>
                <span class="sb-catchup-name">{{ t.name }}</span>
                <span :class="['sb-catchup-target', t.possible === false ? 'sb-catchup-impossible' : '']">
                  <template v-if="t.avgJudge == null">
                    +{{ t.gap.toFixed(1) }} pts
                  </template>
                  <template v-else-if="t.possible === false">
                    not possible
                  </template>
                  <template v-else-if="t.avgJudge === 0">
                    already there
                  </template>
                  <template v-else>
                    avg {{ t.avgJudge.toFixed(1) }}
                  </template>
                </span>
              </div>
            </template>
            <template v-else-if="activeProjection.kind === 'lead'">
              <div class="sb-projection-head">
                Leading by <strong>+{{ activeProjection.gap.toFixed(1) }}</strong>
              </div>
              <div class="sb-catchup-row">
                <span class="sb-catchup-rank">2nd</span>
                <span class="sb-catchup-name">{{ activeProjection.runnerUp }}</span>
                <span :class="['sb-catchup-target', activeProjection.possible === false ? 'sb-catchup-impossible' : '']">
                  <template v-if="activeProjection.avgJudge == null">
                    +{{ activeProjection.gap.toFixed(1) }} pts
                  </template>
                  <template v-else-if="activeProjection.possible === false">
                    can't overtake
                  </template>
                  <template v-else>
                    needs avg {{ activeProjection.avgJudge.toFixed(1) }}
                  </template>
                </span>
              </div>
            </template>
            <template v-else-if="activeProjection.kind === 'pre'">
              No completed dives yet. {{ activeProjection.leaderName }} leads at
              <strong>{{ activeProjection.leaderTotal.toFixed(1) }}</strong>.
            </template>
            <template v-else-if="activeProjection.kind === 'unopposed'">
              {{ activeProjection.activeName }} unopposed — only diver entered.
            </template>
          </div>

          <!-- Up Next: each row reads
                 R# · order-in-round · Name · TST · 103B · DD 1.6 · Forward 1½ Somersaults Pike
               so a spectator scanning the panel knows exactly
               who's up, what they're doing, and how hard it is.
               Hidden when the queue is empty (end-of-meet) so we
               don't dangle a blank panel. Filters out the current
               active diver so they're not double-shown.
               At rest only the next 3 dives render — keeps the
               centre column light. A "Show N more" toggle below
               expands to the full upcoming list. -->
          <div v-if="upcomingDisplay.length" class="up-next">
            <div class="up-next-label">
              Up Next · {{ upcomingDisplay.length }} remaining
            </div>
            <div class="up-next-scroll">
              <!-- Same anchored-toggle pattern as the history
                   columns: render the v-for over preview-or-all,
                   inject the toggle button INSIDE the loop after
                   the last preview row so it stays at a fixed
                   position when expanded. -->
              <template v-for="(u, i) in (upNextShowAll ? upcomingDisplay : upcomingPreview)"
                        :key="`${u.competitor_id || u.full_name}-${u.round_number}-${u.round_order || i}`">
              <div class="up-next-row">
                <span class="up-next-rd">R{{ u.round_number }}</span>
                <span class="up-next-pos">{{ u.round_order }}</span>
                <span class="up-next-name">
                  <RouterLink v-if="u.competitor_id"
                              :to="`/profile/${u.competitor_id}`"
                              class="diver-link">{{ u.full_name }}</RouterLink>
                  <template v-else>{{ u.full_name }}</template>
                  <span v-if="u.country_code" class="up-next-ctry">{{ u.country_code }}</span>
                  <template v-if="u.partner_name">
                    <span class="up-next-amp">&amp;</span>
                    <RouterLink v-if="u.partner_id"
                                :to="`/profile/${u.partner_id}`"
                                class="diver-link">{{ u.partner_name }}</RouterLink>
                    <template v-else>{{ u.partner_name }}</template>
                  </template>
                  <span v-if="u.club_name && !u.country_code" class="up-next-club">{{ u.club_name }}</span>
                </span>
                <span v-if="u.dive_code" class="up-next-code">
                  {{ u.dive_code }}<span class="up-next-letter">{{ u.position }}</span>
                </span>
                <span v-if="u.dd" class="up-next-dd">DD {{ parseFloat(u.dd).toFixed(1) }}</span>
                <span v-if="u.description || u.position" class="up-next-desc">
                  {{ diveDescription(u) }}
                </span>
              </div>
              <button
                v-if="i === UP_NEXT_PREVIEW_COUNT - 1
                      && upcomingDisplay.length > UP_NEXT_PREVIEW_COUNT"
                class="up-next-toggle"
                @click="upNextShowAll = !upNextShowAll"
              >
                {{ upNextShowAll
                    ? `Show fewer ↑`
                    : `Show ${upcomingDisplay.length - UP_NEXT_PREVIEW_COUNT} more ↓` }}
              </button>
              </template>
            </div>
          </div>
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
                  <RouterLink v-if="s.competitor_id"
                              :to="`/profile/${s.competitor_id}`"
                              class="diver-link">{{ s.full_name }}</RouterLink>
                  <template v-else>{{ s.full_name }}</template>
                  <span v-if="s.country_code" class="standing-country">{{ s.country_code }}</span>
                </div>
                <div v-if="s.partner_name" class="standing-partner">
                  &amp;
                  <RouterLink v-if="s.partner_id"
                              :to="`/profile/${s.partner_id}`"
                              class="diver-link">{{ s.partner_name }}</RouterLink>
                  <template v-else>{{ s.partner_name }}</template>
                  <span v-if="s.partner_country" class="standing-country">{{ s.partner_country }}</span>
                </div>
                <div v-if="s.club_name" class="standing-club">{{ s.club_name }}</div>
              </div>
              <div class="standing-score">
                <!-- "=" marker when two divers shared the raw total
                     but were separated by the FINA tie-break rule
                     (highest single dive, then second-highest, …).
                     Spectators and coaches see this and understand
                     why two identical totals weren't a literal tie. -->
                <span v-if="s.is_tied_on_total" class="tie-marker"
                      title="Tied on total — separated by FINA tie-break (highest single dive, then second-highest, etc.)">=</span>
                {{ parseFloat(s.total).toFixed(1) }}
              </div>
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
                    <RouterLink v-if="r.competitor_id"
                                :to="`/profile/${r.competitor_id}`"
                                class="diver-link">{{ r.full_name }}</RouterLink>
                    <template v-else>{{ r.full_name }}</template>
                    <span v-if="r.country_code" class="standing-country">{{ r.country_code }}</span>
                  </div>
                  <div class="lb-cum">{{ r.cumulative_total.toFixed(1) }}</div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>

    <!-- Body — Completed event recap (only when an event is
         selected and it has finished). Sits next to the live
         body branch above; the v-if chain is:
           !currentEventId  → list mode
           !isCompleted      → live broadcast
           else              → recap below -->
    <div class="sb-completed" v-else-if="isCompleted">
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
        <div class="export-actions">
          <a :href="`/api/events/${currentEventId}/results.pdf`"
             target="_blank" rel="noopener"
             class="btn btn-ghost btn-sm">PDF</a>
          <a :href="`/api/events/${currentEventId}/results.csv`"
             class="btn btn-ghost btn-sm">CSV</a>
          <a :href="`/api/events/${currentEventId}/start-list.pdf`"
             target="_blank" rel="noopener"
             class="btn btn-ghost btn-sm">Start list</a>
        </div>
      </div>

      <!-- End-of-event recap. One centred column so the
           leaderboard sits dead centre on the page rather than
           being flanked by sidebars. Stack order: podium spotlight
           (top 3) → tabbed leaderboard (per-diver dives or
           round-by-round) → meet highlights. -->
      <div class="completed-recap">
        <!-- Podium spotlight: top 3, slightly elevated treatment.
             Each podium-name is a /profile/<id> link when we have
             a competitor_id for that row (individual + synchro
             events). Team rows have NULL competitor_id so the
             team name renders as plain text. -->
        <div v-if="standings.length >= 3" class="podium">
          <div class="podium-step podium-2">
            <div class="podium-medal silver">2</div>
            <div class="podium-name">
              <RouterLink v-if="standings[1].competitor_id"
                          :to="`/profile/${standings[1].competitor_id}`"
                          class="diver-link">{{ standings[1].full_name }}</RouterLink>
              <template v-else>{{ standings[1].full_name }}</template>
            </div>
            <div class="podium-country">{{ standings[1].country_code || '' }}</div>
            <div class="podium-total">{{ parseFloat(standings[1].total).toFixed(1) }}</div>
          </div>
          <div class="podium-step podium-1">
            <div class="podium-medal gold">1</div>
            <div class="podium-name">
              <RouterLink v-if="standings[0].competitor_id"
                          :to="`/profile/${standings[0].competitor_id}`"
                          class="diver-link">{{ standings[0].full_name }}</RouterLink>
              <template v-else>{{ standings[0].full_name }}</template>
            </div>
            <div class="podium-country">{{ standings[0].country_code || '' }}</div>
            <div class="podium-total">{{ parseFloat(standings[0].total).toFixed(1) }}</div>
          </div>
          <div class="podium-step podium-3">
            <div class="podium-medal bronze">3</div>
            <div class="podium-name">
              <RouterLink v-if="standings[2].competitor_id"
                          :to="`/profile/${standings[2].competitor_id}`"
                          class="diver-link">{{ standings[2].full_name }}</RouterLink>
              <template v-else>{{ standings[2].full_name }}</template>
            </div>
            <div class="podium-country">{{ standings[2].country_code || '' }}</div>
            <div class="podium-total">{{ parseFloat(standings[2].total).toFixed(1) }}</div>
          </div>
        </div>

        <!-- Leaderboard card: every diver in rank order with their
             per-dive breakdown (judges' scores, dive code, position,
             DD, dive total). Final tab is the per-diver view; the
             By-Round tab keeps the older round-by-round leaderboard
             with movement arrows. -->
        <div class="recap-card">
          <div class="col-head">
            <span>Final Leaderboard</span>
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
            <template v-if="standingsTab === 'final'">
              <p v-if="!divesByDiver.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:2rem">No dive data recorded</p>
              <div v-for="block in divesByDiver" :key="block.name" class="diver-block">
                <div class="diver-head">
                  <div class="diver-rank-badge" :class="rankClass(block.rank - 1)">{{ block.rank }}</div>
                  <div class="diver-id">
                    <div class="diver-id-row">
                      <div class="diver-name">
                        <!-- For team-mode blocks the name is the
                             team, not a single diver — skip the
                             link. For individual + synchro the
                             leader's competitor_id sits on every
                             one of their dive rows. -->
                        <RouterLink v-if="!block.isTeam && block.dives[0]?.competitor_id"
                                    :to="`/profile/${block.dives[0].competitor_id}`"
                                    class="diver-link">{{ block.name }}</RouterLink>
                        <template v-else>{{ block.name }}</template>
                        <span v-if="block.country" class="diver-country">{{ block.country }}</span>
                        <template v-if="block.partner">
                          <span class="diver-amp">&amp;</span>
                          <RouterLink v-if="block.partner_id"
                                      :to="`/profile/${block.partner_id}`"
                                      class="diver-link">{{ block.partner }}</RouterLink>
                          <template v-else>{{ block.partner }}</template>
                          <span v-if="block.partner_country" class="diver-country">{{ block.partner_country }}</span>
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
                      <span v-if="block.isTeam" class="dr-team-member">
                        <!-- Per-dive team-member name links to
                             that diver's profile so the recap
                             reads as a navigable scoresheet. -->
                        <RouterLink v-if="d.competitor_id"
                                    :to="`/profile/${d.competitor_id}`"
                                    class="diver-link">{{ d.full_name }}</RouterLink>
                        <template v-else>{{ d.full_name }}</template>
                      </span>
                      <span class="dr-code-main">{{ [d.dive_code, d.position].filter(Boolean).join(' ') }}</span>
                      <span v-if="d.description" class="dr-code-desc">{{ diveDescription(d) }}</span>
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
                        <RouterLink v-if="r.competitor_id"
                                    :to="`/profile/${r.competitor_id}`"
                                    class="diver-link">{{ r.full_name }}</RouterLink>
                        <template v-else>{{ r.full_name }}</template>
                        <span v-if="r.country_code" class="standing-country">{{ r.country_code }}</span>
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

        <!-- Meet highlights — sits below the leaderboard so it
             doesn't compete for attention with the per-diver
             results. -->
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
      </div>
    </div>

    <!-- Score overlay removed — the inline pills + dive total +
         "currently Nth" line under the active diver carry the
         spotlight now. The fullscreen flash was disorienting
         because it hid the rest of the scoreboard for 4s on every
         dive. -->

  </div>
</template>

<style scoped>
/* Default: natural document flow — page scrolls if content
   exceeds the viewport. Broadcast + overlay modes (kiosk /
   projector / OBS) opt back into the locked-to-viewport
   layout below. */
.sb-layout { min-height: 100vh; display: flex; flex-direction: column; }
.sb-layout.broadcast-mode,
.sb-layout.overlay-mode {
  overflow: hidden;
  height: 100vh;
  min-height: 100vh;
}

/* Broadcast / kiosk mode — header is hidden via v-if, but we
   also nudge font sizes up so the venue projector reads
   cleanly from the back of a pool deck. */
.sb-layout.broadcast-mode .sb-name      { font-size: clamp(48px, 9vw, 110px); }
.sb-layout.broadcast-mode .sb-code      { font-size: clamp(28px, 5vw, 56px); }
.sb-layout.broadcast-mode .sb-dd        { font-size: clamp(20px, 3.5vw, 40px); }
.sb-layout.broadcast-mode .standing-name,
.sb-layout.broadcast-mode .standing-score { font-size: 18px; }
.sb-layout.broadcast-mode .col-head     { font-size: 12px; padding: 1.2rem 1.4rem; }

.broadcast-exit {
  position: fixed; top: 1rem; right: 1rem; z-index: 90;
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4); color: var(--text-3);
  border: 1px solid var(--border); border-radius: 50%;
  font-family: var(--font-mono); font-size: 16px; font-weight: 700;
  text-decoration: none;
  opacity: 0.25; transition: opacity 0.2s;
}
.broadcast-exit:hover { opacity: 1; color: var(--cyan); border-color: var(--cyan); }

/* Meet-hold banner — solid amber across the top whenever the
   Control Room has paused the meet. Same shape on every
   surface (Scoreboard, Control, Judge). */
.hold-banner {
  display: flex; align-items: center; gap: 0.875rem;
  padding: 0.5rem 1.5rem;
  background: var(--amber); color: var(--bg);
  flex-shrink: 0;
  animation: slideHold 0.18s ease;
}
@keyframes slideHold { from { transform: translateY(-100%); } to { transform: translateY(0); } }
.hold-pulse {
  font-family: var(--font-display); font-size: 13px; font-weight: 900;
  letter-spacing: 0.2em;
}
.hold-reason {
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  opacity: 0.8;
}

/* Connection-lost banner — same look as the judge view. */
.conn-banner {
  background: var(--amber); color: var(--bg);
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.5rem 1rem; flex-shrink: 0;
  display: flex; align-items: center; gap: 0.6rem;
  animation: connSlide 0.18s ease;
}
.conn-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--bg); animation: connPulse 1s infinite;
}
@keyframes connSlide { from { transform: translateY(-100%); } to { transform: translateY(0); } }
@keyframes connPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }

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

.header-left {
  display: flex; align-items: center; gap: 0.75rem;
  min-width: 0; flex: 1;
}
.sb-page-title {
  font-family: var(--font-display); font-size: 18px; font-weight: 900;
  font-style: italic; color: var(--text); white-space: nowrap;
}
.sb-page-sub {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.sb-page-sub-live {
  color: var(--red); font-weight: 700;
}
.sb-event-name {
  font-family: var(--font-display); font-size: 16px; font-weight: 900;
  font-style: italic; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}

/* List mode (browsable meets) — no special handling needed
   anymore; .sb-layout defaults to natural document flow. The
   :has(.meets-mode) override is gone with the height:100vh lock
   that required it. */
.meets-mode {
  flex: 1;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  padding: 1.5rem 1.5rem 4rem;
  display: flex; flex-direction: column; gap: 1.25rem;
}

/* Live banner — only when at least one meet is in progress. */
.live-banner {
  background: linear-gradient(135deg, rgba(239,68,68,0.10), rgba(239,68,68,0.02));
  border: 1px solid rgba(239,68,68,0.35);
  border-radius: var(--radius-lg);
  padding: 1rem 1.25rem;
  display: flex; flex-direction: column; gap: 0.75rem;
}
.live-banner-head {
  display: flex; align-items: center; gap: 0.6rem;
}
.live-pulse {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.2em; padding: 0.25rem 0.75rem;
  background: var(--red); color: white; border-radius: 4px;
  animation: pulse-red 2s infinite;
}
.live-banner-sub {
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-2);
}
.live-banner-cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.75rem;
}
.live-event-card {
  text-align: left; cursor: pointer;
  background: var(--surface);
  border: 1px solid rgba(239,68,68,0.3);
  border-radius: var(--radius);
  padding: 0.875rem 1rem;
  display: flex; flex-direction: column; gap: 0.4rem;
  transition: all 0.15s; min-width: 0;
}
.live-event-card:hover {
  border-color: var(--red);
  box-shadow: 0 0 16px rgba(239,68,68,0.2);
  transform: translateY(-1px);
}
.live-event-name {
  font-family: var(--font-display); font-size: 15px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.15;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.live-event-meta {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.live-event-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-left: 0.4rem; vertical-align: middle;
}
.live-event-watch {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase; color: var(--red);
  margin-top: 0.1rem;
}
.live-event-now {
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  color: var(--text);
  background: rgba(239,68,68,0.08); border-left: 2px solid var(--red);
  padding: 0.35rem 0.5rem; border-radius: 0 3px 3px 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

/* Filter bar */
.filter-bar {
  display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  padding: 0.75rem 1rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius);
}
.filter-bar .input  { flex: 1 1 200px; max-width: 280px; font-size: 13px; padding: 0.55rem 0.75rem; }
.filter-bar .select { flex: 0 1 160px; max-width: 200px; font-size: 13px; padding: 0.55rem 0.75rem; }
.result-count {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  margin-left: auto;
}

/* Meet card grid — like the live cards but neutral colour. */
.meets-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 0.875rem;
}
.meet-card {
  text-align: left; cursor: pointer;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1rem 1.125rem;
  display: flex; flex-direction: column; gap: 0.5rem;
  transition: all 0.15s; min-width: 0;
}
.meet-card:hover {
  border-color: var(--cyan);
  background: rgba(6,182,212,0.04);
  transform: translateY(-1px);
}
.meet-card-head {
  display: flex; align-items: flex-start; justify-content: space-between;
  gap: 0.5rem;
}
.meet-card-name {
  font-family: var(--font-display); font-size: 16px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1.15;
  flex: 1; min-width: 0;
}
.meet-card-status {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; padding: 0.15rem 0.45rem; border-radius: 3px;
  flex-shrink: 0;
}
.meet-card-status.live { background: var(--red); color: white; animation: pulse-red 2s infinite; }
.meet-card-status.final { background: var(--bg-3); color: var(--text-3); border: 1px solid var(--border); }
.meet-card-org {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meet-card-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.35rem;
  margin-left: 0.4rem; vertical-align: middle;
}
.meet-card-tags {
  display: flex; flex-wrap: wrap; gap: 0.3rem;
}
.meet-tag {
  font-family: var(--font-mono); font-size: 10px;
  color: var(--text-3); background: var(--bg-3);
  border: 1px solid var(--border); border-radius: 3px;
  padding: 0.1rem 0.4rem;
}
.meet-tag-cyan {
  color: var(--cyan); border-color: rgba(6,182,212,0.3);
  background: var(--cyan-dim);
}
.meet-card-stats {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  display: flex; gap: 0.4rem; flex-wrap: wrap; align-items: baseline;
}
.meet-card-date { margin-left: auto; }
.meet-card-meetlink {
  display: inline-flex; align-items: center; gap: 0.3rem;
  align-self: flex-start;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.15rem 0.5rem; text-decoration: none;
  max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.meet-card-meetlink:hover { background: var(--cyan); color: var(--bg); }

.meets-empty {
  font-family: var(--font-mono); font-size: 13px; color: var(--text-3);
  text-align: center; padding: 3rem 1rem;
  background: var(--bg-2); border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
}

/* Stale-cache banner shared with DiverProfileView. */
.cache-banner {
  display: flex; align-items: center; gap: 0.5rem;
  font-family: var(--font-mono); font-size: 11px; color: var(--amber);
  background: rgba(245,158,11,0.08); border: 1px solid rgba(245,158,11,0.25);
  border-radius: var(--radius-sm);
  padding: 0.4rem 0.7rem; margin-bottom: 0.5rem;
}
.cache-dot {
  display: inline-block; width: 6px; height: 6px; border-radius: 50%;
  background: var(--amber); animation: cachePulse 1.2s infinite;
}
@keyframes cachePulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

/* 3-column live layout. In normal browsing the page scrolls
   naturally so we don't need overflow locks here; broadcast +
   overlay modes get them back via the .sb-layout.* selectors
   above (which then need .sb-body to flex-fill). */
/* 1fr in the middle let the centre column balloon on wide
   screens, leaving an awkward gap between the Up Next box
   (max-width 720px, centred) and the Standings column. Capping
   the centre at minmax(0, 800px) plus justify-content: center on
   the grid distributes any leftover horizontal space as equal
   gutters on the outer edges instead. */
.sb-body { display: grid; grid-template-columns: 380px minmax(0, 800px) 300px; justify-content: center; }
.sb-layout.broadcast-mode .sb-body,
.sb-layout.overlay-mode .sb-body {
  flex: 1; overflow: hidden; grid-template-rows: minmax(0, 1fr);
}
.sb-col { display: flex; flex-direction: column; }
.sb-layout.broadcast-mode .sb-col,
.sb-layout.overlay-mode .sb-col { overflow: hidden; min-height: 0; }
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
/* Mid-meet "On Deck — Up Next" placeholder. Slightly desaturated
   so the audience reads it as queued-not-diving without losing
   the visual prominence of the centre block. */
.sb-name.sb-name-next { color: var(--text-2); }
.sb-badges {
  display: flex; justify-content: center; align-items: baseline;
  gap: 1.25rem; margin-bottom: 1rem;
  flex-wrap: wrap;
}
.sb-code { font-family: var(--font-mono); font-size: clamp(24px,4vw,36px); color: var(--text); }
.sb-dd { font-family: var(--font-display); font-size: clamp(18px,3vw,28px); font-weight: 700; color: var(--cyan); }
/* Description now sits inline alongside the code + DD as the
   third item in the badges row (was a separate row beneath).
   Lower font size + muted colour keeps it as supporting info
   without competing with the code or DD pip. */
.sb-desc { font-family: var(--font-mono); font-size: clamp(13px,1.8vw,18px); color: var(--text-3); }

/* Live per-judge pills under the active diver. The .j-score
   classes (already styled globally for the Completed-Dives panel)
   carry the colour-by-category + dropped-out behaviour; we just
   set the row layout + sizing here so they read as a row of
   "judge lights". */
.sb-live-judges {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 1.25rem;
}
.sb-live-judges .j-score {
  font-family: var(--font-display);
  font-size: clamp(18px, 2.5vw, 26px);
  font-weight: 700;
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius);
  min-width: 3ch;
}
/* Empty placeholder tile — same dimensions as a populated
   .j-score so the row's height stays constant from the
   moment the diver becomes active. Dim border + dash glyph
   tells the audience "judge slot, no score yet" without
   competing for visual weight. */
.sb-live-judges .j-empty {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--text-3);
  opacity: 0.55;
}
/* Reserved-height wrapper for the dive-total. Without this
   the catch-up + Up Next blocks below would shift down by
   ~52px the instant the panel completes and the total
   appears. Inner div uses v-show so it's measurable but
   invisible until the value lands. */
.sb-live-total-slot {
  margin-top: 1rem;
  min-height: clamp(32px, 5vw, 52px);
  display: flex; align-items: center; justify-content: center;
}
.sb-live-total {
  display: flex; align-items: baseline; justify-content: center;
  gap: 0.6rem;
}
.sb-live-total-label {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text-3);
}
.sb-live-total-value {
  font-family: var(--font-display);
  font-size: clamp(28px, 4.5vw, 44px);
  font-weight: 900;
  color: var(--cyan);
}
/* Reserved-height wrapper for the "Currently Nth" line. The
   inner div uses v-show so its eventual appearance (which lags
   activeDiver by however long the standings query takes to
   refresh) doesn't shift the catch-up + Up Next blocks below
   it down. Same pattern as .sb-live-total-slot. */
.sb-live-rank-slot {
  margin-top: 0.5rem;
  min-height: clamp(20px, 2.2vw, 26px);
  display: flex; align-items: center; justify-content: center;
}
.sb-live-rank {
  font-family: var(--font-mono);
  font-size: clamp(13px, 1.8vw, 18px);
  color: var(--text-3);
}
.sb-live-rank strong {
  color: var(--text);
  font-weight: 700;
}

/* Catch-up projection — sits between the current performer
   block and Up Next. Cyan-tinted block (gold when leading) with
   a confident font size + chunky border so it reads clearly
   from across a pool deck, not just the front row. */
/* Reserved min-height absorbs the projection's natural variance
   between kinds (pre / chase / lead / unopposed each have a
   different number of rows) so the Up Next list below doesn't
   shift when the projection updates. The chunkiest case — chase
   with three podium rows + the head line — is ~6 lines × 1.45
   line-height + 0.7rem×2 padding ≈ 11rem at the desktop end of
   the clamp. We reserve a slightly smaller floor (8rem) since
   most actual states are smaller; the chase-with-3-targets case
   pushes the block taller naturally without shifting things
   below it because Up Next sits in the normal flow. */
.sb-projection {
  margin: 1rem auto 0.5rem;
  padding: 0.7rem 1rem;
  border-radius: var(--radius-sm);
  border-left-width: 4px;
  font-family: var(--font-mono);
  font-size: clamp(14px, 1.7vw, 18px);
  line-height: 1.45;
  display: inline-block;
  max-width: 100%;
  text-align: left;
  min-height: clamp(5.5rem, 9vw, 8rem);
  box-sizing: border-box;
}
.sb-projection strong { color: var(--text); font-weight: 700; }
.sb-projection-lead {
  background: rgba(234,179,8,0.06); border: 1px solid rgba(234,179,8,0.3);
  color: var(--text-2);
}
.sb-projection-lead strong { color: #f59e0b; }
.sb-projection-chase {
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  color: var(--text-2);
}
.sb-projection-chase strong { color: var(--cyan); }
.sb-projection-detail {
  font-size: clamp(10px, 1.2vw, 13px);
  color: var(--text-3);
  margin-top: 0.25rem;
}
.sb-projection-detail strong { color: var(--text-2); }
/* Catch-up table — one row per podium target showing the
   average judge score the active diver needs over the remaining
   dives. Layout matches the Control Room (rank | name | target)
   so the audience and the operator read the same shape. */
.sb-projection-head {
  font-size: clamp(12px, 1.4vw, 14px);
  color: var(--text-3);
  margin-bottom: 0.5rem;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  font-weight: 700;
}
.sb-catchup-row {
  display: grid;
  grid-template-columns: clamp(28px, 4vw, 40px) 1fr auto;
  align-items: baseline; gap: 0.6rem;
  padding: 0.25rem 0;
  font-size: clamp(12px, 1.4vw, 16px);
}
.sb-catchup-rank {
  font-family: var(--font-display); font-weight: 800; font-style: italic;
  color: var(--text-2); letter-spacing: 0.04em;
}
.sb-catchup-name {
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
.sb-catchup-target {
  font-family: var(--font-display); font-weight: 800; font-style: italic;
  color: var(--cyan);
}
.sb-catchup-target.sb-catchup-impossible {
  color: var(--red); font-weight: 700; font-style: italic;
}

/* Up Next panel — sits below the active diver block. Contains
   every remaining dive in the meet, scrollable when the list
   exceeds ~10 rows. Each row is laid out as a horizontal flex
   strip: round / order / name / dive code / DD / description so
   a spectator scanning the panel can read what's coming without
   having to parse a dense list. Width-capped so it doesn't
   stretch full-screen on big monitors. */
.up-next {
  margin-top: 2rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius);
  text-align: left;
  width: 100%; max-width: 720px;
  overflow: hidden;     /* clip the scroll-child's corners */
}
.up-next-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3);
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--border);
}
/* The scroll container. Caps height at roughly 10 rows so a
   long meet doesn't push the rest of the centre column off
   screen. With the description on its own grid row each row is
   ~55px including padding + border; 500px shows ~9 fully + a
   hint of the 10th to telegraph that the list scrolls. */
.up-next-scroll {
  max-height: 500px;
  overflow-y: auto;
}

/* Show-more toggle — sits below the Up Next list (and below the
   Completed Dives column). Same compact display-font styling
   the other "Show all" toggles in the SPA use, so the eye
   recognises it as a list-expansion control. Full-width inside
   its container; clicks expand the preview to the full set. */
.up-next-toggle,
.hist-toggle {
  display: block; width: 100%;
  background: transparent; border: 0;
  border-top: 1px solid var(--border);
  cursor: pointer;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
  padding: 0.7rem 1rem;
  transition: color 0.15s, background 0.15s;
}
.up-next-toggle:hover,
.hist-toggle:hover {
  color: var(--cyan); background: var(--bg-3);
}
.up-next-row {
  display: grid;
  grid-template-columns: 32px 28px 1fr auto auto auto;
  align-items: baseline; gap: 0.6rem;
  padding: 0.45rem 1rem;
  border-top: 1px solid var(--border);
  font-size: 12px;
}
.up-next-row:first-of-type { border-top: none; }
.up-next-rd {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  font-weight: 700;
}
.up-next-pos {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  text-align: right;
}
.up-next-name {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
.up-next-amp { color: var(--cyan); margin: 0 0.25em; font-weight: 400; }
.up-next-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--text-3);
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.3rem;
  margin-left: 0.4rem; vertical-align: middle;
}
.up-next-club {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  margin-left: 0.4rem;
}
.up-next-code {
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  color: var(--text);
  white-space: nowrap;
}
.up-next-letter {
  color: var(--cyan); margin-left: 0.25em;
}
.up-next-dd {
  font-family: var(--font-mono); font-size: 11px; color: var(--cyan);
  white-space: nowrap;
}
.up-next-desc {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
  /* Description gets pushed onto its own row when the panel is
     narrow — see media query below. */
  grid-column: 3 / -1;
}
@media (max-width: 720px) {
  .up-next-row {
    grid-template-columns: 28px 24px 1fr auto;
    row-gap: 0.2rem;
  }
  .up-next-dd, .up-next-code { grid-column: auto; }
  .up-next-desc { font-size: 10.5px; }
}
.sb-country-line { font-family: var(--font-mono); font-size: clamp(14px,2vw,20px); font-weight: 700; letter-spacing: 0.15em; color: var(--text-3); margin-bottom: 1.5rem; }

#no-event-view { display: flex; flex-direction: column; align-items: center; width: 100%; max-width: 700px; }
.picker-label { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--text-3); margin-bottom: 2rem; }
.event-grid { display: grid; grid-template-columns: repeat(auto-fill,minmax(200px,1fr)); gap: 1rem; width: 100%; }
.event-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.5rem; cursor: pointer; transition: all 0.15s; text-align: left; }
.event-card:hover { border-color: var(--cyan); background: var(--cyan-dim); }
.event-card-name { font-family: var(--font-display); font-size: 16px; font-weight: 900; font-style: italic; color: var(--text); margin-bottom: 0.375rem; line-height: 1.2; }
.event-card-meta { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.event-card:hover .event-card-name { color: var(--cyan); }

.hist-card { padding: 0.875rem 1rem; border-left: 2px solid var(--cyan); background: var(--bg-3); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; margin-bottom: 0.5rem; }
.hist-round { font-size: 10px; color: var(--text-3); margin-bottom: 0.3rem; font-family: var(--font-mono); }
/* Identity block font-size base — DiverIdentity inherits this
   and resolves badge / secondary-line sizes off it. */
.hist-identity { font-size: 13px; margin-bottom: 0.3rem; }

/* Diver-name links — clickable diver names everywhere they
   appear, jumping to /profile/<id>. Inherits the surrounding
   font / size / colour so the underline-on-hover is the only
   visual cue at rest. */
.diver-link {
  color: inherit;
  text-decoration: none;
  border-bottom: 1px dashed transparent;
  transition: color 0.12s, border-color 0.12s;
}
.diver-link:hover {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
}
.hist-total { font-family: var(--font-mono); font-size: 16px; font-weight: 500; color: var(--cyan); flex-shrink: 0; margin-left: 0.5rem; }
.hist-dive-line { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.4rem; min-width: 0; }
.hist-code { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--text); flex-shrink: 0; }
.hist-dd { font-family: var(--font-display); font-size: 11px; font-weight: 700; color: var(--cyan); flex-shrink: 0; }
/* Description now inlines next to code + DD. Ellipsis when the
   column is narrow keeps each card to one header line. */
.hist-desc { font-size: 10px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
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
/* End-of-event branch. Scrolls vertically when the recap
   overflows the viewport — moved up from .completed-recap so the
   whole recap content (podium, leaderboard, stats) participates
   in one scroll context rather than being clipped inside a
   nested scroller. */
/* Completed-event branch. In normal mode the page scrolls
   naturally so this is just a flex container. Broadcast +
   overlay modes re-enable the overflow lock. */
.sb-completed { display: flex; flex-direction: column; }
.sb-layout.broadcast-mode .sb-completed,
.sb-layout.overlay-mode .sb-completed {
  flex: 1; overflow-y: auto; overflow-x: hidden;
}

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

/* Result export buttons (PDF / CSV / start list) — sit in the
   recap header next to the event title. Wrap on narrow screens. */
.export-actions { display: flex; gap: 0.4rem; flex-wrap: wrap; }

/* "=" marker for FINA tie-break disambiguation. Cyan accent so
   it reads as informational, not error. */
.tie-marker {
  display: inline-block;
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  color: var(--cyan); margin-right: 0.25rem;
  cursor: help;
}

/* =========================================================
   Live-stream overlay (?overlay=1) — chroma-key-friendly view
   for OBS. Strips every background colour and panel chrome so
   the streaming software can key out the bg colour cleanly.
   Activated by adding `?overlay=1` to the scoreboard URL; the
   chroma colour is set inline on .sb-layout via ?bg=<hex>.
   ========================================================= */
.sb-layout.overlay-mode { color: #fff; min-height: 100vh; padding: 1.5rem; }
.sb-layout.overlay-mode .sb-header,
.sb-layout.overlay-mode .sb-controls,
.sb-layout.overlay-mode .sb-footer,
.sb-layout.overlay-mode .meta-strip,
.sb-layout.overlay-mode .conn-banner,
.sb-layout.overlay-mode .meet-hold-banner,
.sb-layout.overlay-mode .filter-bar,
.sb-layout.overlay-mode .sb-event-list,
.sb-layout.overlay-mode .export-actions,
.sb-layout.overlay-mode .archive-wrap,
.sb-layout.overlay-mode .archive-controls { display: none !important; }
/* Keep only the active diver tile and a compact top-3 visible.
   Style them with text-shadow for readability against any chroma
   colour the operator picks. */
.sb-layout.overlay-mode .sb-body,
.sb-layout.overlay-mode .sb-completed,
.sb-layout.overlay-mode .sb-col,
.sb-layout.overlay-mode .completed-recap,
.sb-layout.overlay-mode .recap-card {
  background: transparent !important; border: none !important;
  box-shadow: none !important;
}
.sb-layout.overlay-mode .active-diver-tile,
.sb-layout.overlay-mode .standings-card,
.sb-layout.overlay-mode .col-head,
.sb-layout.overlay-mode .standings-row {
  background: rgba(0, 0, 0, 0.55) !important;
  border-radius: 8px;
  color: #fff !important;
  text-shadow: 0 1px 2px rgba(0,0,0,0.6);
  padding: 0.6rem 0.9rem;
}
.sb-layout.overlay-mode .standings-row {
  margin-bottom: 0.25rem; padding: 0.4rem 0.7rem;
}
.sb-layout.overlay-mode .standings-card { padding: 0.4rem; }
.sb-layout.overlay-mode .standings-card .standings-row:nth-child(n+5) { display: none; }
.sb-layout.overlay-mode .col-head { font-size: 13px; letter-spacing: 0.2em; }

/* End-of-event recap is a single centred column. Was a 2-col
   grid (standings sidebar + dive breakdown); the dive breakdown
   absorbed the rank / total info that the standings list was
   carrying so the sidebar became redundant. Centring makes the
   leaderboard the focal element when a meet wraps up. */
.completed-recap {
  padding: 1.25rem 1.5rem 2rem;
  max-width: 1100px;
  width: 100%;
  margin: 0 auto;
  box-sizing: border-box;
  display: flex; flex-direction: column;
  gap: 1.25rem;
}
.recap-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  display: flex; flex-direction: column;
}
.recap-card .col-body {
  /* Don't lock height — let the recap-card grow with content
     since the parent .completed-recap already scrolls. The
     .col-body default of overflow:auto + flex:1 would otherwise
     clip the diver-blocks list to one screen-height. */
  overflow: visible;
  flex: 0 0 auto;
}

/* Podium spotlight: gold in middle + slightly elevated, silver left, bronze right */
.podium {
  display: grid; grid-template-columns: 1fr 1.1fr 1fr; gap: 0.5rem;
  align-items: end; padding: 1rem 0.5rem 1.25rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
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
  .completed-recap { padding: 0.75rem 0.875rem 1.5rem; gap: 1rem; }
  .dive-row { grid-template-columns: 32px 1fr 44px 1fr 52px; }
}

/* Phone — collapse the live 3-column layout (history / centre /
   standings) into a single scrolling stack so the active diver
   stays the hero, with history above and standings below. */
@media (max-width: 720px) {
  /* List mode: tighter outer padding + single-column meet cards */
  .meets-mode { padding: 1rem 1rem 3rem; gap: 0.875rem; }
  .live-banner { padding: 0.75rem 0.875rem; }
  .live-banner-cards { grid-template-columns: 1fr; }
  .meets-grid { grid-template-columns: 1fr; gap: 0.625rem; }
  .meet-card { padding: 0.875rem 1rem; }
  .meet-card-name { font-size: 15px; }

  .filter-bar { padding: 0.625rem 0.75rem; gap: 0.4rem; }
  .filter-bar .input,
  .filter-bar .select { max-width: none; flex: 1 1 100%; }
  .result-count { margin-left: 0; }

  /* Header bits */
  .sb-page-title { font-size: 15px; }
  .sb-page-sub   { font-size: 10px; }
  .sb-event-name { font-size: 14px; }
  .header-left   { gap: 0.5rem; }

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

  /* Recap dive table — same root cause as the Archive view's
     vertical-stacking: the desktop 5-column grid (round / code /
     DD / judges / total) gives judges only ~75px on a phone, so
     synchro groups (and even flat j-score chips) fall into a
     vertical column.

     Restructure into a 4-column, 2-row grid: the meta line keeps
     round/code/DD/total on row 1, judges drop onto row 2 with the
     full row width to lay out horizontally. */
  .dive-row {
    grid-template-columns: 28px minmax(0, 1fr) 36px 50px;
    grid-template-rows: auto auto;
    gap: 0.3rem 0.5rem;
    padding: 0.55rem 0.25rem;
    align-items: baseline;
  }
  .dr-round  { grid-column: 1; grid-row: 1; }
  .dr-code   { grid-column: 2; grid-row: 1; min-width: 0; overflow: hidden; }
  .dr-dd     { grid-column: 3; grid-row: 1; }
  .dr-total  { grid-column: 4; grid-row: 1; }
  .dr-judges {
    grid-column: 1 / -1;
    grid-row: 2;
    /* Indent under the dive code so the chip strip lines up
       visually with what scored, not with the round number. */
    padding-left: 32px;
    gap: 0.3rem;
  }
  /* Hide the column-header row entirely — its labels (especially
     "Judge Scores") don't map onto a 2-row layout, and the
     colour-coded chips below speak for themselves. */
  .dive-head-row { display: none; }

  /* Dive description ("Forward Dive Pike") was inline next to
     the code on desktop; let it sit under the code on a phone
     so a long description doesn't push DD off-row. */
  .dr-code-desc {
    display: block;
    margin-left: 0;
    margin-top: 0.15rem;
  }
  .dr-team-member { display: block; margin-right: 0; margin-bottom: 0.1rem; }

  /* Synchro group blocks within dr-judges: pad tighter so two
     fit per row instead of one. */
  .dr-judges .judge-group { padding: 0.2rem 0.35rem; gap: 0.2rem; }
}
</style>
