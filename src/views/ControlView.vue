<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'

const auth = useAuthStore()
const socket = useSocket()

const events = ref([])
const selectedEventId = ref('')
const roster = ref([])
const currentIndex = ref(-1)
const currentActive = ref(null)
const currentEvent = ref(null)
const scoresThisRound = ref({})
const historyCards = ref([])
const judgeTiles = ref([])
const lbShow = ref(false)
const lbRows = ref([])
const connStatus = ref(false)
const meetName = ref('')
const activeInfo = ref({ name: '—', code: '—', dd: 'DD —', desc: 'Select an event to begin.' })
const nextBtnDisabled = ref(true)
const nextBtnText = ref('Next Diver →')
const nextBtnComplete = ref(false)
const finaliseBtnShow = ref(false)
const finaliseBtnText = ref('Finalise Event ✓')

// =============================================================
// SHOT CLOCK — 30-second WA rule timer.
// Starts when a new active diver is set; operator can pause /
// reset / extend. Plays an audible alert at 0 (browser allows
// once we've had a user gesture, which we always do here).
// =============================================================
const SHOT_CLOCK_DEFAULT = 30
const shotClock = ref(SHOT_CLOCK_DEFAULT)
const shotClockRunning = ref(false)
const shotClockExpired = ref(false)
let shotClockTimer = null

function startShotClock(seconds = SHOT_CLOCK_DEFAULT) {
  stopShotClock()
  shotClock.value = seconds
  shotClockRunning.value = true
  shotClockExpired.value = false
  shotClockTimer = setInterval(() => {
    shotClock.value--
    if (shotClock.value <= 0) {
      shotClock.value = 0
      shotClockExpired.value = true
      stopShotClock()
      // Beep — uses Web Audio API so we don't ship an mp3.
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.connect(gain); gain.connect(ctx.destination)
        osc.frequency.value = 880
        gain.gain.value = 0.15
        osc.start()
        setTimeout(() => { osc.stop(); ctx.close() }, 600)
      } catch { /* audio context blocked in some webviews — silent fail */ }
    }
  }, 1000)
}
function stopShotClock() {
  if (shotClockTimer) { clearInterval(shotClockTimer); shotClockTimer = null }
  shotClockRunning.value = false
}
function pauseShotClock() {
  if (shotClockRunning.value) stopShotClock()
  else if (shotClock.value > 0) {
    shotClockRunning.value = true
    shotClockTimer = setInterval(() => {
      shotClock.value--
      if (shotClock.value <= 0) { shotClock.value = 0; shotClockExpired.value = true; stopShotClock() }
    }, 1000)
  }
}
function resetShotClock() {
  stopShotClock()
  shotClock.value = SHOT_CLOCK_DEFAULT
  shotClockExpired.value = false
}
const shotClockClass = computed(() => {
  if (shotClockExpired.value) return 'shot-clock-expired'
  if (shotClock.value <= 5) return 'shot-clock-warn'
  if (shotClock.value <= 10) return 'shot-clock-amber'
  return ''
})

// =============================================================
// HOLD / RESUME — broadcast pause state to judges + scoreboard.
// =============================================================
const isHeld = ref(false)
const holdReason = ref('')
const holdPromptOpen = ref(false)
const holdReasonInput = ref('')

function openHoldPrompt() {
  holdReasonInput.value = ''
  holdPromptOpen.value = true
}
function confirmHold() {
  if (!currentEvent.value) return
  isHeld.value = true
  holdReason.value = holdReasonInput.value.trim()
  socket.emit('meet_hold', {
    event_id: currentEvent.value.id,
    reason: holdReason.value || null,
  })
  holdPromptOpen.value = false
  // Pause the shot clock — diver can't be "on the clock" during a hold
  if (shotClockRunning.value) stopShotClock()
}
function resumeMeet() {
  if (!currentEvent.value) return
  isHeld.value = false
  holdReason.value = ''
  socket.emit('meet_resume', { event_id: currentEvent.value.id })
}

// =============================================================
// SCORE CORRECTION — manager-amend on a finalised dive.
// =============================================================
const correctOpen = ref(false)
const correctTarget = ref(null)        // historyCard the operator clicked
const correctJudgeIdx = ref(0)
const correctNewScore = ref('')
const correctReason = ref('')
const correctBusy = ref(false)
const correctErr = ref('')

function openCorrection(card) {
  correctTarget.value = card
  correctJudgeIdx.value = 0
  correctNewScore.value = card.scores?.[0]?.toFixed?.(1) || ''
  correctReason.value = ''
  correctErr.value = ''
  correctOpen.value = true
}
function closeCorrection() {
  correctOpen.value = false
  correctTarget.value = null
}

async function submitCorrection() {
  correctErr.value = ''
  const newVal = parseFloat(correctNewScore.value)
  if (Number.isNaN(newVal) || newVal < 0 || newVal > 10 || ((newVal * 2) % 1) !== 0) {
    correctErr.value = 'Score must be 0–10 in 0.5 increments'
    return
  }
  if (!correctTarget.value?.score_ids?.[correctJudgeIdx.value]) {
    correctErr.value = 'Score id missing — refresh and try again'
    return
  }
  correctBusy.value = true
  try {
    await auth.apiFetch(`/api/scores/${correctTarget.value.score_ids[correctJudgeIdx.value]}`, {
      method: 'PUT',
      body: JSON.stringify({ score: newVal, reason: correctReason.value || null }),
    })
    // Update locally so the history pane reflects the change
    correctTarget.value.scores[correctJudgeIdx.value] = newVal
    correctTarget.value.total = correctTarget.value.scores
      .reduce((a, b) => a + b, 0).toFixed(1)
    closeCorrection()
  } catch (err) {
    correctErr.value = err.message
  } finally {
    correctBusy.value = false
  }
}

// =============================================================
// ROUND-END TRANSITION
// When the last dive of a round scores, prompt the operator to
// announce the standings. Watches the queue + history to detect
// "round N just completed".
// =============================================================
const roundEndPromptOpen = ref(false)
const roundEndForRound = ref(0)

function detectRoundEnd(justCompletedRound) {
  if (!roster.value.length || !justCompletedRound) return
  const completedInRound = historyCards.value.filter(
    h => h.round === justCompletedRound,
  ).length
  const expectedInRound = roster.value.filter(
    r => r.round_number === justCompletedRound,
  ).length
  if (completedInRound >= expectedInRound && expectedInRound > 0) {
    roundEndForRound.value = justCompletedRound
    roundEndPromptOpen.value = true
  }
}

async function announceRoundEnd() {
  if (!currentEvent.value) return
  try {
    const data = await auth.apiFetch(`/api/scoreboard/${currentEvent.value.id}`)
    socket.emit('announce_score', {
      standings: data.standings,
      eventId: currentEvent.value.id,
      round_completed: roundEndForRound.value,
    })
  } catch { /* best effort */ }
  roundEndPromptOpen.value = false
}

// =============================================================
// QUEUE MANAGEMENT — reorder, withdraw, late entry
// =============================================================

// Move a roster entry up or down within its round. Recomputes
// display_order locally first (optimistic) then persists. We
// pick a value halfway between the new neighbours so subsequent
// drags don't have to renumber the whole round.
async function reorderRosterRow(idx, dir) {
  const cur = roster.value[idx]
  if (!cur) return
  // Find the previous / next row in the SAME round
  const targetIdx = dir === 'up' ? idx - 1 : idx + 1
  const target = roster.value[targetIdx]
  if (!target || target.round_number !== cur.round_number) return

  // Swap their positions in the local array (optimistic)
  roster.value[idx] = target
  roster.value[targetIdx] = cur
  // currentIndex needs to follow the moved active diver
  if (currentIndex.value === idx)        currentIndex.value = targetIdx
  else if (currentIndex.value === targetIdx) currentIndex.value = idx

  // Persist by giving each row an explicit display_order value
  // (use array index — simple, monotonic, lets future moves
  // continue to compare correctly).
  try {
    await Promise.all([
      auth.apiFetch(`/api/dive-lists/${cur.dive_list_id}/order`, {
        method: 'PUT', body: JSON.stringify({ display_order: targetIdx }),
      }),
      auth.apiFetch(`/api/dive-lists/${target.dive_list_id}/order`, {
        method: 'PUT', body: JSON.stringify({ display_order: idx }),
      }),
    ])
  } catch (err) {
    alert('Failed to save order: ' + err.message)
    // Revert local swap on failure
    roster.value[idx] = cur
    roster.value[targetIdx] = target
  }
}

async function withdrawRosterRow(idx) {
  const row = roster.value[idx]
  if (!row) return
  const willWithdraw = !row.withdrawn_at
  const verb = willWithdraw ? 'Withdraw' : 'Reinstate'
  if (!confirm(`${verb} ${row.full_name} from round ${row.round_number}?`)) return
  try {
    await auth.apiFetch(`/api/dive-lists/${row.dive_list_id}/withdraw`, {
      method: 'PUT', body: JSON.stringify({ withdrawn: willWithdraw }),
    })
    row.withdrawn_at = willWithdraw ? new Date().toISOString() : null
    // If the active diver got withdrawn, advance past them
    if (willWithdraw && currentIndex.value === idx) {
      const next = roster.value.findIndex((r, i) => i > idx && !r.withdrawn_at)
      if (next >= 0) setActive(next)
    }
  } catch (err) {
    alert('Failed: ' + err.message)
  }
}

// =============================================================
// LATE ENTRY — manager adds a diver from the Control Room
// =============================================================
const lateOpen = ref(false)
const lateBusy = ref(false)
const lateErr = ref('')
const lateDivers = ref([])           // candidate divers in the org
const lateDiveDir = ref([])          // dive directory at the event's height
const lateForm = ref({ competitor_id: '', round_number: 1, dive_code: '', position: '' })

async function openLateEntry() {
  lateErr.value = ''
  lateBusy.value = false
  lateForm.value = { competitor_id: '', round_number: 1, dive_code: '', position: '' }
  lateOpen.value = true
  // Lazy-load org divers + dive directory once per session
  if (!lateDivers.value.length) {
    try {
      lateDivers.value = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/divers`)
    } catch { lateDivers.value = [] }
  }
  if (!lateDiveDir.value.length) {
    try {
      lateDiveDir.value = await auth.apiFetch('/api/dive-directory')
    } catch { lateDiveDir.value = [] }
  }
}

const lateDiveOptions = computed(() => {
  const eventHeight = currentEvent.value?.height
  const heightNumeric = eventHeight ? parseFloat(eventHeight) : null
  return lateDiveDir.value.filter(d =>
    heightNumeric === null || parseFloat(d.height) === heightNumeric,
  )
})

// =============================================================
// JUDGE PANEL — names + ids loaded once per event so the tile
// in the centre column can show "J3 — Sarah Chen" instead of a
// faceless number when scores are missing.
// =============================================================
const judgePanel = ref([])         // [{ judge_id, judge_number, full_name }]
const judgeNameByNumber = computed(() => {
  const m = {}
  for (const j of judgePanel.value) m[j.judge_number] = j.full_name
  return m
})

// =============================================================
// STANDINGS PREVIEW — top 5 visible inline so the meet referee
// always knows the running state without opening the modal.
// =============================================================
const standingsPreview = ref([])
async function refreshStandingsPreview() {
  if (!currentEvent.value) return
  try {
    const data = await auth.apiFetch(`/api/scoreboard/${currentEvent.value.id}`)
    standingsPreview.value = (data.standings || []).slice(0, 5)
  } catch { standingsPreview.value = [] }
}

// =============================================================
// QUEUE SEARCH + JUMP-TO-ROUND
// =============================================================
const queueSearch = ref('')
const queueRoundFilter = ref(null)   // null = all rounds

const filteredRoster = computed(() => {
  const term = queueSearch.value.trim().toLowerCase()
  return roster.value
    .map((r, originalIdx) => ({ ...r, originalIdx }))
    .filter(r => {
      if (queueRoundFilter.value && r.round_number !== queueRoundFilter.value) return false
      if (!term) return true
      const haystack = [
        r.full_name, r.partner_name, r.team_name, r.club_name,
        r.dive_code, `${r.dive_code}${r.position}`,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(term)
    })
})

const availableRounds = computed(() => {
  const set = new Set(roster.value.map(r => r.round_number))
  return [...set].sort((a, b) => a - b)
})

// =============================================================
// HISTORY FILTER — by diver, by round
// =============================================================
const historyDiverFilter = ref('')   // full_name, '' = all
const historyRoundFilter = ref(null) // round, null = all

const filteredHistory = computed(() => {
  return historyCards.value.filter(h => {
    if (historyDiverFilter.value && h.name !== historyDiverFilter.value) return false
    if (historyRoundFilter.value && h.round !== historyRoundFilter.value) return false
    return true
  })
})

const historyDivers = computed(() => {
  const set = new Set(historyCards.value.map(h => h.name))
  return [...set].sort()
})

async function submitLateEntry() {
  lateErr.value = ''
  if (!lateForm.value.competitor_id) { lateErr.value = 'Pick a diver'; return }
  if (!lateForm.value.dive_code || !lateForm.value.position) {
    lateErr.value = 'Pick a dive'
    return
  }
  // Resolve dive_code + position to a dive_directory id
  const dive = lateDiveDir.value.find(d =>
    d.dive_code === lateForm.value.dive_code &&
    d.position === lateForm.value.position &&
    (!currentEvent.value?.height || parseFloat(d.height) === parseFloat(currentEvent.value.height)),
  )
  if (!dive) { lateErr.value = 'Dive not found in the directory at this height'; return }
  lateBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${currentEvent.value.id}/roster`, {
      method: 'POST',
      body: JSON.stringify({
        competitor_id: lateForm.value.competitor_id,
        dive_id: dive.id,
        round_number: parseInt(lateForm.value.round_number, 10) || 1,
      }),
    })
    // Re-pull roster so the new row appears in the queue with
    // its dive_list_id.
    const fresh = await auth.apiFetch(`/api/events/${currentEvent.value.id}/roster`)
    roster.value = fresh
    lateOpen.value = false
  } catch (err) {
    lateErr.value = err.message
  } finally {
    lateBusy.value = false
  }
}

// Socket connection
socket.on('connect', () => { connStatus.value = true })
socket.on('disconnect', () => { connStatus.value = false })

// Hold-state sync — for multi-operator setups + late-joining
// Control Room sessions. The server replays meet_held when we
// ask for it.
socket.on('meet_held', (data) => {
  if (currentEvent.value && data.event_id === currentEvent.value.id) {
    isHeld.value = true
    holdReason.value = data.reason || ''
  }
})
socket.on('meet_resumed', (data) => {
  if (currentEvent.value && data.event_id === currentEvent.value.id) {
    isHeld.value = false
    holdReason.value = ''
  }
})

socket.on('score_received', (data) => {
  if (!currentActive.value) return
  if (data.event_id !== currentActive.value.event_id) return
  if (data.competitor_id !== currentActive.value.competitor_id) return
  if (data.round_number !== currentActive.value.round_number) return

  if (data.judge_id) scoresThisRound.value[data.judge_id] = parseFloat(data.score)

  // Update judge tile
  let tile = data.judge_number
    ? judgeTiles.value.find(t => t.judgeIndex === parseInt(data.judge_number))
    : judgeTiles.value.find(t => t.judgeId === data.judge_id)
  if (!tile) tile = judgeTiles.value.find(t => !t.scored)
  if (tile) {
    tile.judgeId = data.judge_id
    tile.scored = true
    tile.score = parseFloat(data.score).toFixed(1)
  }

  const totalJudges = parseInt(currentEvent.value?.number_of_judges) || 0
  const scoresIn = Object.keys(scoresThisRound.value).length
  const allScoresIn = totalJudges > 0 && scoresIn >= totalJudges

  if (allScoresIn) {
    const scoreValues = Object.values(scoresThisRound.value)
    addHistoryCard({
      diverName: currentActive.value.full_name,
      country_code: currentActive.value.country_code,
      round_number: currentActive.value.round_number,
      dive_code: currentActive.value.dive_code,
      position: currentActive.value.position,
      dd: currentActive.value.dd,
      description: currentActive.value.description,
      judge_scores: scoreValues,
      total_points: scoreValues.reduce((a, b) => a + b, 0),
    })
    stopShotClock()                                    // dive complete — clock irrelevant
    updateNextButton(true)
    // Round-end detection: this might have been the final dive
    // of the round. detectRoundEnd surfaces a prompt if so.
    detectRoundEnd(currentActive.value.round_number)
    // Refresh the inline standings preview so the operator
    // sees totals shift as dives complete.
    refreshStandingsPreview()
  }
})

socket.on('live_result_calculated', (data) => {
  addHistoryCard(data)
  resetJudgeTiles()
})

function initJudgeTiles(n) {
  judgeTiles.value = []
  for (let i = 1; i <= n; i++) {
    judgeTiles.value.push({ judgeIndex: i, judgeId: null, score: '—', scored: false })
  }
}

function resetJudgeTiles() {
  judgeTiles.value.forEach(t => {
    t.scored = false
    t.judgeId = null
    t.score = '—'
  })
}

function addHistoryCard(data) {
  let scores = []
  if (Array.isArray(data.judge_scores)) {
    scores = data.judge_scores.map(s => parseFloat(s))
  } else if (typeof data.judge_scores === 'string') {
    try { scores = JSON.parse(data.judge_scores).map(s => parseFloat(s)) } catch { scores = [] }
  } else if (typeof data.judge_array === 'string') {
    scores = data.judge_array.split(',').map(s => parseFloat(s))
  }

  const total = scores.length
    ? scores.reduce((a, b) => a + b, 0).toFixed(1)
    : data.total_points != null ? parseFloat(data.total_points).toFixed(1) : '—'

  const name = data.diverName || data.full_name || '—'
  const country = data.country_code || null
  const dive_code = data.dive_code || null
  const position = data.position || null
  const dd = data.dd != null ? parseFloat(data.dd) : null
  const desc = data.description || null
  const total_rounds = data.total_rounds || currentEvent.value?.total_rounds || null
  // Capture score row ids if the source provided them — used by
  // the correction modal to PUT /api/scores/:id. Live cards
  // built from socket events don't have ids yet (the upsert
  // happens server-side); the history endpoint includes them.
  const score_ids = Array.isArray(data.score_ids) ? data.score_ids : []
  // Stash event_id + competitor_id so the modal can refetch ids
  // if needed.
  const event_id = data.event_id || currentEvent.value?.id || null
  const competitor_id = data.competitor_id || null

  historyCards.value.unshift({
    name, country, dive_code, position, dd, desc,
    round: data.round_number, total_rounds, scores, total,
    score_ids, event_id, competitor_id,
  })
}

function setActive(idx) {
  if (idx < 0 || idx >= roster.value.length) return
  currentIndex.value = idx
  currentActive.value = roster.value[idx]
  scoresThisRound.value = {}
  activeInfo.value = {
    name: currentActive.value.full_name,
    country: currentActive.value.country_code || null,
    code: `${currentActive.value.dive_code}${currentActive.value.position}`,
    dd: `DD ${currentActive.value.dd}`,
    desc: currentActive.value.description || '—',
    team_name: currentActive.value.team_name || null,
    partner_name: currentActive.value.partner_name || null,
    partner_country: currentActive.value.partner_country || null,
    round_number: currentActive.value.round_number,
  }
  socket.emit('set_active_diver', {
    ...currentActive.value,
    diverName: currentActive.value.full_name,
    country_code: currentActive.value.country_code || null,
    diveCode: `${currentActive.value.dive_code}${currentActive.value.position}`,
    description: currentActive.value.description || '—',
    eventName: currentEvent.value?.name || '—',
  })
  resetJudgeTiles()
  updateNextButton(false)
  // Reset + auto-start the 30-second shot clock for this diver.
  // Operator can pause / extend if needed (warm-up, equipment).
  startShotClock()
}

function updateNextButton(allScoresIn) {
  const isLast = currentIndex.value >= roster.value.length - 1
  if (!allScoresIn) {
    nextBtnDisabled.value = true
    nextBtnText.value = 'Next Diver →'
    nextBtnComplete.value = false
    return
  }
  if (isLast) {
    nextBtnDisabled.value = false
    nextBtnText.value = '✓ Event Complete — Finalise & View Results'
    nextBtnComplete.value = true
  } else {
    nextBtnDisabled.value = false
    nextBtnText.value = 'Next Diver →'
    nextBtnComplete.value = false
  }
}

function refAction(type) {
  if (!currentActive.value) return
  const payload = {
    event_id: currentActive.value.event_id,
    competitor_id: currentActive.value.competitor_id,
    round_number: currentActive.value.round_number,
  }
  if (type === 'failed') socket.emit('referee_failed_dive', payload)
  if (type === 'cap') socket.emit('referee_cap_scores', { ...payload, cap_value: 2.0 })
  if (type === 'redive') socket.emit('referee_redive', payload)
}

function nextDiver() {
  if (nextBtnComplete.value) {
    finaliseEvent()
  } else {
    setActive(currentIndex.value + 1)
  }
}

// Keyboard shortcuts for the Control Room — meet referees often
// run the queue with one hand on the keyboard. Only fire when
// the focus is somewhere outside an input/textarea so typing
// into a search box doesn't accidentally advance the queue.
function isTypingTarget(el) {
  if (!el) return false
  const tag = (el.tagName || '').toLowerCase()
  return tag === 'input' || tag === 'textarea' || tag === 'select' || el.isContentEditable
}

function onKeydown(e) {
  if (isTypingTarget(e.target)) return
  if (!currentEvent.value) return
  // Avoid stomping on browser navigation (alt-arrow / cmd-arrow)
  if (e.altKey || e.metaKey || e.ctrlKey) return

  switch (e.key) {
    case 'ArrowRight':
    case ' ':           // space = advance — same muscle memory as a remote
      e.preventDefault()
      nextDiver()
      break
    case 'ArrowLeft':
      if (currentIndex.value > 0) {
        e.preventDefault()
        setActive(currentIndex.value - 1)
      }
      break
    case 'l':
    case 'L':
      e.preventDefault()
      showLeaderboard()
      break
  }
}

function updateFinaliseButton() {
  if (!currentEvent.value) { finaliseBtnShow.value = false; return }
  finaliseBtnShow.value = true
  finaliseBtnText.value = currentEvent.value.status === 'Completed' ? 'View Results' : 'Finalise Event ✓'
}

async function showLeaderboard() {
  const data = await auth.apiFetch(`/api/scoreboard/${currentEvent.value.id}`)
  lbRows.value = data.standings || []
  lbShow.value = true
  socket.emit('announce_score', { standings: data.standings, eventId: currentEvent.value.id })
}

async function finaliseEvent() {
  if (!currentEvent.value) return
  if (!confirm(`Finalise "${currentEvent.value.name}" and show the leaderboard?`)) return
  try {
    await auth.apiFetch(`/api/events/${currentEvent.value.id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Completed' }),
    })
    currentEvent.value.status = 'Completed'
    finaliseBtnText.value = 'View Results'
    await showLeaderboard()
  } catch (err) {
    alert('Failed to finalise: ' + err.message)
  }
}

async function onEventChange() {
  if (!selectedEventId.value) return
  currentEvent.value = events.value.find(e => e.id == selectedEventId.value) || null
  if (!currentEvent.value) return
  meetName.value = currentEvent.value.name
  historyCards.value = []
  initJudgeTiles(currentEvent.value.number_of_judges)

  const [rosterData, histData, judgesData] = await Promise.all([
    auth.apiFetch(`/api/events/${selectedEventId.value}/roster`),
    auth.apiFetch(`/api/events/${selectedEventId.value}/history`),
    auth.apiFetch(`/api/events/${selectedEventId.value}/judges`).catch(() => []),
  ])
  roster.value = rosterData
  judgePanel.value = Array.isArray(judgesData) ? judgesData : []
  // Top-5 standings preview alongside the queue.
  refreshStandingsPreview()

  ;[...histData].reverse().forEach(h => {
    addHistoryCard({
      diverName: h.diverName || h.full_name,
      country_code: h.country_code,
      round_number: h.round_number,
      dive_code: h.dive_code,
      position: h.position,
      dd: h.dd,
      description: h.description,
      judge_scores: h.judge_scores,
      total_points: h.total_points,
      // Pass through ids + ownership so the score-correction
      // modal can target the right rows.
      score_ids: h.score_ids,
      event_id: h.event_id,
      competitor_id: h.competitor_id,
    })
  })

  // Hold state — re-pull on event switch in case a hold was set
  // from another Control Room instance before we connected.
  isHeld.value = false
  holdReason.value = ''
  socket.emit('get_meet_hold', { event_id: selectedEventId.value })

  if (roster.value.length) {
    setActive(0)
  } else {
    activeInfo.value = { name: 'No divers registered', code: '—', dd: 'DD —', desc: 'No competitors have submitted dive lists.' }
  }
  updateFinaliseButton()
}

function rankClass(i) {
  if (i === 0) return 'gold'
  if (i === 1) return 'silver'
  if (i === 2) return 'bronze'
  return ''
}
const medals = ['🥇', '🥈', '🥉']

onMounted(async () => {
  events.value = await auth.apiFetch('/api/events')
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="ctrl-layout">
    <!-- Header -->
    <div class="ctrl-header">
      <div style="display:flex;align-items:center;gap:1.5rem">
        <RouterLink to="/dashboard" class="app-logo" style="font-size:16px">DIVE<span>RECORDER</span></RouterLink>
        <select class="event-select-sm" v-model="selectedEventId" @change="onEventChange">
          <option value="">— Select Event —</option>
          <option v-for="ev in events" :key="ev.id" :value="ev.id">{{ ev.name }}</option>
        </select>
        <span class="conn-badge">
          <span class="status-dot" :class="{ connected: connStatus }"></span>
          <span>{{ connStatus ? 'Connected' : 'Connecting' }}</span>
        </span>
      </div>
      <span style="font-family:var(--font-display);font-size:16px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--text-3)">{{ meetName }}</span>
      <div style="display:flex;align-items:center;gap:0.75rem">
        <!-- Hold / Resume — broadcasts a paused state to judges
             + spectator scoreboard. Cyan when running, amber
             when held. -->
        <button
          v-if="currentEvent && currentEvent.status !== 'Completed'"
          :class="['btn-hold', isHeld ? 'btn-hold-active' : '']"
          @click="isHeld ? resumeMeet() : openHoldPrompt()"
          title="Pause / resume the meet"
        >
          {{ isHeld ? '▶ Resume' : '⏸ Hold' }}
        </button>
        <RouterLink to="/dashboard" class="btn-back">← Dashboard</RouterLink>
        <button
          v-if="finaliseBtnShow"
          class="btn-finalise"
          @click="currentEvent?.status === 'Completed' ? showLeaderboard() : finaliseEvent()"
        >{{ finaliseBtnText }}</button>
      </div>
    </div>

    <!-- Hold banner — visible whenever the meet is on hold. -->
    <div v-if="isHeld" class="hold-banner">
      <span class="hold-pulse">⏸ MEET ON HOLD</span>
      <span v-if="holdReason" class="hold-reason">{{ holdReason }}</span>
    </div>

    <!-- Leaderboard modal -->
    <div v-if="lbShow" class="lb-backdrop">
      <div class="lb-modal">
        <div class="lb-header">
          <div>
            <div class="lb-title">Final Results</div>
            <div class="lb-event">{{ currentEvent?.name || '—' }}</div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="lbShow = false">Close</button>
        </div>
        <div class="lb-body">
          <p v-if="!lbRows.length" style="color:var(--text-3);text-align:center;padding:2rem;font-size:13px">No scores recorded for this event.</p>
          <div
            v-for="(s, i) in lbRows"
            :key="i"
            :class="['lb-row', i === 0 ? 'lb-winner' : '']"
          >
            <div :class="['lb-rank', rankClass(i)]">{{ i + 1 }}</div>
            <div class="lb-medal">{{ medals[i] || '' }}</div>
            <div class="lb-name">{{ s.full_name }}</div>
            <div class="lb-score">{{ parseFloat(s.total).toFixed(1) }}</div>
          </div>
        </div>
      </div>
    </div>

    <!-- Body -->
    <div class="ctrl-body">
      <!-- Left: History -->
      <div class="ctrl-panel">
        <div class="panel-head">Completed Dives</div>
        <div v-if="historyCards.length" class="hist-filters">
          <select class="select hist-filter-select" v-model="historyDiverFilter">
            <option value="">All divers</option>
            <option v-for="n in historyDivers" :key="n" :value="n">{{ n }}</option>
          </select>
          <select class="select hist-filter-select" v-model="historyRoundFilter">
            <option :value="null">All rounds</option>
            <option v-for="n in availableRounds" :key="n" :value="n">Round {{ n }}</option>
          </select>
        </div>
        <div class="panel-body">
          <div
            v-for="(card, idx) in filteredHistory"
            :key="idx"
            :class="['hist-card', card.score_ids?.length ? 'hist-card-correctable' : '']"
            :title="card.score_ids?.length ? 'Click to amend a score' : ''"
            @click="card.score_ids?.length && openCorrection(card)"
          >
            <div class="hist-round">Round {{ card.round }}{{ card.total_rounds ? ` / ${card.total_rounds}` : '' }}</div>
            <div class="hist-header">
              <div class="hist-name">{{ card.name }}<span v-if="card.country" class="hist-country">{{ card.country }}</span></div>
              <div class="hist-total">{{ card.total }}</div>
            </div>
            <div class="hist-dive-line">
              <span class="hist-code">{{ card.dive_code ? `${card.dive_code}${card.position || ''}` : '—' }}</span>
              <span v-if="card.dd != null" class="hist-dd">DD {{ card.dd.toFixed(1) }}</span>
            </div>
            <div v-if="card.desc" class="hist-desc">{{ card.desc }}</div>
            <div v-if="card.scores.length" class="hist-scores">
              <span v-for="(s, si) in card.scores" :key="si" class="hist-score">{{ s.toFixed(1) }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Centre: Active diver -->
      <div style="display:flex;flex-direction:column;overflow:hidden">
        <div class="active-zone" style="flex:1;overflow-y:auto">
          <div class="active-label-row">
            <span class="active-label">
              Currently on Board<span v-if="activeInfo.round_number" class="active-round">— Round {{ activeInfo.round_number }}</span>
            </span>
            <!-- Shot clock — 30-second WA rule. Auto-starts when
                 a new diver is set; click face to pause/resume,
                 ↻ to reset. -->
            <div v-if="currentActive" :class="['shot-clock', shotClockClass]">
              <button class="shot-clock-face" @click="pauseShotClock" title="Pause / resume">
                <span class="shot-clock-num">{{ shotClock }}</span>
                <span class="shot-clock-unit">s</span>
              </button>
              <button class="shot-clock-reset" @click="resetShotClock" title="Reset to 30s">↻</button>
            </div>
          </div>
          <div class="active-name">
            <template v-if="activeInfo.partner_name">
              {{ activeInfo.name }}<span v-if="activeInfo.country" class="active-country">{{ activeInfo.country }}</span>
              <span class="active-amp">&amp;</span>
              {{ activeInfo.partner_name }}<span v-if="activeInfo.partner_country" class="active-country">{{ activeInfo.partner_country }}</span>
            </template>
            <template v-else>
              {{ activeInfo.name }}<span v-if="activeInfo.country" class="active-country">{{ activeInfo.country }}</span>
            </template>
          </div>
          <div v-if="activeInfo.team_name" class="active-team">{{ activeInfo.team_name }}</div>
          <div class="active-badges">
            <div class="active-code">{{ activeInfo.code }}</div>
            <div class="active-dd">{{ activeInfo.dd }}</div>
          </div>
          <div class="active-desc">{{ activeInfo.desc }}</div>

          <div style="margin-bottom:0.75rem">
            <div style="font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-3);margin-bottom:0.625rem">Judge Scores</div>
            <div class="judge-grid">
              <div
                v-for="tile in judgeTiles"
                :key="tile.judgeIndex"
                :class="['judge-tile', tile.scored ? 'scored' : '']"
                :title="judgeNameByNumber[tile.judgeIndex] || `Judge ${tile.judgeIndex}`"
              >
                <div class="judge-tile-label">J{{ tile.judgeIndex }}</div>
                <div class="judge-tile-score">{{ tile.score }}</div>
                <!-- Judge name surfaces under the tile so a slow
                     submitter is identifiable at a glance. -->
                <div v-if="judgeNameByNumber[tile.judgeIndex]" class="judge-tile-name">
                  {{ judgeNameByNumber[tile.judgeIndex].split(' ').slice(-1)[0] }}
                </div>
              </div>
            </div>
          </div>

          <div class="ref-actions" style="margin-bottom:1.25rem">
            <button class="ref-btn" style="background:var(--red-dim);color:var(--red);border-color:rgba(239,68,68,0.3)" @click="refAction('failed')">Failed Dive</button>
            <button class="ref-btn" style="background:var(--amber-dim);color:var(--amber);border-color:rgba(245,158,11,0.3);line-height:1.2" @click="refAction('cap')">Cap Score<br><span style="font-size:9px">Max 2.0</span></button>
            <button class="ref-btn" style="background:var(--cyan-dim);color:var(--cyan);border-color:rgba(6,182,212,0.3)" @click="refAction('redive')">Re-Dive</button>
          </div>

          <div class="nav-btns">
            <button class="btn btn-ghost" @click="setActive(currentIndex - 1)" :disabled="currentIndex <= 0">← Prev</button>
            <button
              :class="['btn', nextBtnComplete ? 'btn-complete' : 'btn-primary']"
              :disabled="nextBtnDisabled"
              @click="nextDiver"
            >{{ nextBtnText }}</button>
          </div>

          <!-- Discoverability hint for the keyboard shortcuts.
               The hotkeys are wired in onKeydown above. -->
          <div class="kbd-hints">
            <span><kbd>←</kbd> prev</span>
            <span><kbd>→</kbd> / <kbd>Space</kbd> next</span>
            <span><kbd>L</kbd> leaderboard</span>
          </div>
        </div>
      </div>

      <!-- Right: Queue -->
      <div class="ctrl-panel">
        <div class="panel-head" style="display:flex;justify-content:space-between;align-items:center">
          <span>Diver Queue</span>
          <div style="display:flex;align-items:center;gap:0.5rem">
            <span class="roster-count">{{ roster.length ? currentIndex + 1 : 0 }}/{{ roster.length }}</span>
            <button v-if="currentEvent" class="btn btn-ghost btn-sm" @click="openLateEntry"
                    title="Add a late-arriving diver">+ Add</button>
          </div>
        </div>

        <!-- Standings preview — top 5 inline so the meet referee
             always knows the running state. -->
        <div v-if="standingsPreview.length" class="standings-preview">
          <div class="standings-preview-label">Top 5 right now</div>
          <div v-for="(s, i) in standingsPreview" :key="i" class="sp-row">
            <span :class="['sp-rank', i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '']">
              {{ i + 1 }}
            </span>
            <span class="sp-name">{{ s.full_name }}</span>
            <span class="sp-total">{{ parseFloat(s.total).toFixed(1) }}</span>
          </div>
        </div>

        <!-- Search + jump-to-round chips -->
        <div v-if="roster.length" class="queue-filters">
          <input
            class="input queue-search"
            type="text"
            v-model="queueSearch"
            placeholder="Search name, dive code…"
          >
          <div class="round-chips">
            <button :class="['round-chip', queueRoundFilter === null ? 'active' : '']"
                    @click="queueRoundFilter = null">All</button>
            <button v-for="n in availableRounds" :key="n"
                    :class="['round-chip', queueRoundFilter === n ? 'active' : '']"
                    @click="queueRoundFilter = n">R{{ n }}</button>
          </div>
        </div>

        <div class="panel-body">
          <!-- filteredRoster is the search-filtered view of the
               full roster, but each item carries originalIdx so
               clicking still maps back to the right slot in
               roster[] — keeps reorder/withdraw logic correct. -->
          <template v-for="(item, listIdx) in filteredRoster" :key="item.dive_list_id || listIdx">
            <!-- Round divider when round_number changes between
                 visible rows. Compare to the previous filtered
                 row, not the unfiltered roster. -->
            <div v-if="listIdx === 0 || filteredRoster[listIdx - 1].round_number !== item.round_number"
                 class="round-divider">
              Round {{ item.round_number }}
            </div>
            <div
              :class="[
                'roster-item',
                item.originalIdx === currentIndex ? 'active' : '',
                item.withdrawn_at ? 'withdrawn' : '',
              ]"
            >
              <div class="roster-row-head">
                <button
                  class="roster-jump"
                  :disabled="!!item.withdrawn_at"
                  @click="setActive(item.originalIdx)"
                >
                  <div class="roster-name">
                    {{ item.full_name }}<span v-if="item.country_code" class="roster-country">{{ item.country_code }}</span>
                    <template v-if="item.partner_name">
                      <span class="roster-amp">&amp;</span>
                      {{ item.partner_name }}
                    </template>
                    <span v-if="item.withdrawn_at" class="roster-wd-badge">WITHDRAWN</span>
                  </div>
                  <div v-if="item.team_name" class="roster-team">{{ item.team_name }}</div>
                  <div class="roster-meta">
                    <span>{{ item.dive_code }}{{ item.position }}</span>
                    <span>DD {{ item.dd }}</span>
                  </div>
                </button>
                <!-- Reorder + withdraw controls. Use originalIdx
                     so reorder targets the correct unfiltered slot. -->
                <div class="roster-controls">
                  <button class="roster-ctrl"
                          :disabled="item.originalIdx === 0 || roster[item.originalIdx - 1].round_number !== item.round_number"
                          @click.stop="reorderRosterRow(item.originalIdx, 'up')"
                          title="Move up within round">▲</button>
                  <button class="roster-ctrl"
                          :disabled="item.originalIdx >= roster.length - 1 || roster[item.originalIdx + 1].round_number !== item.round_number"
                          @click.stop="reorderRosterRow(item.originalIdx, 'down')"
                          title="Move down within round">▼</button>
                  <button :class="['roster-ctrl', item.withdrawn_at ? 'roster-reinstate' : 'roster-withdraw']"
                          @click.stop="withdrawRosterRow(item.originalIdx)"
                          :title="item.withdrawn_at ? 'Reinstate' : 'Withdraw / scratch'">
                    {{ item.withdrawn_at ? '↻' : '✕' }}
                  </button>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </div>

  <!-- Hold-reason prompt -->
  <div v-if="holdPromptOpen" class="lb-backdrop" @click="holdPromptOpen = false"></div>
  <div v-if="holdPromptOpen" class="lb-modal hold-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Pause Meet</div>
        <div class="lb-event">Spectators + judges will see a "meet on hold" banner</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="holdPromptOpen = false">Cancel</button>
    </div>
    <div class="lb-body">
      <div class="field">
        <label class="label">Reason (optional, shown publicly)</label>
        <input class="input" type="text" v-model="holdReasonInput"
               placeholder='e.g. "Video review" or "Judges deliberating"'
               @keyup.enter="confirmHold">
      </div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-ghost btn-sm" @click="holdPromptOpen = false">Cancel</button>
        <button class="btn btn-primary btn-sm" @click="confirmHold">⏸ Hold meet</button>
      </div>
    </div>
  </div>

  <!-- Score correction modal -->
  <div v-if="correctOpen" class="lb-backdrop" @click="closeCorrection"></div>
  <div v-if="correctOpen && correctTarget" class="lb-modal correct-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Amend Score</div>
        <div class="lb-event">{{ correctTarget.name }} · Round {{ correctTarget.round }} · {{ correctTarget.dive_code }}{{ correctTarget.position }}</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="closeCorrection">Cancel</button>
    </div>
    <div class="lb-body">
      <div class="field">
        <label class="label">Judge</label>
        <select class="select" v-model="correctJudgeIdx">
          <option v-for="(s, i) in correctTarget.scores" :key="i" :value="i">
            J{{ i + 1 }} — currently {{ s.toFixed(1) }}
          </option>
        </select>
      </div>
      <div class="field">
        <label class="label">New score (0–10, 0.5 increments)</label>
        <input class="input" type="number" min="0" max="10" step="0.5"
               v-model="correctNewScore"
               @keyup.enter="submitCorrection">
      </div>
      <div class="field">
        <label class="label">Reason (logged in audit trail)</label>
        <input class="input" type="text" v-model="correctReason"
               placeholder='e.g. "Judge typo — verified with video"'>
      </div>
      <div v-if="correctErr" class="msg msg-error">{{ correctErr }}</div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-ghost btn-sm" @click="closeCorrection">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="correctBusy" @click="submitCorrection">
          {{ correctBusy ? 'Saving…' : 'Save correction' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Late-entry modal -->
  <div v-if="lateOpen" class="lb-backdrop" @click="lateOpen = false"></div>
  <div v-if="lateOpen" class="lb-modal late-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Add Late Diver</div>
        <div class="lb-event">{{ currentEvent?.name }}</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="lateOpen = false">Cancel</button>
    </div>
    <div class="lb-body">
      <div class="field">
        <label class="label">Diver</label>
        <select class="select" v-model="lateForm.competitor_id">
          <option value="">— Pick a diver —</option>
          <option v-for="d in lateDivers" :key="d.id" :value="d.id">{{ d.full_name }}</option>
        </select>
      </div>
      <div class="field" style="display:flex;gap:0.5rem">
        <div style="flex:1">
          <label class="label">Round</label>
          <select class="select" v-model="lateForm.round_number">
            <option v-for="n in (currentEvent?.total_rounds || 6)" :key="n" :value="n">
              Round {{ n }}
            </option>
          </select>
        </div>
        <div style="flex:1">
          <label class="label">Dive code</label>
          <input class="input" type="text" v-model="lateForm.dive_code"
                 placeholder="e.g. 5132" maxlength="10">
        </div>
        <div style="flex:0 0 80px">
          <label class="label">Position</label>
          <select class="select" v-model="lateForm.position">
            <option value="">—</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
            <option value="D">D</option>
          </select>
        </div>
      </div>
      <p class="hint" v-if="lateDiveOptions.length">
        {{ lateDiveOptions.length }} dives available at {{ currentEvent?.height }}.
      </p>
      <div v-if="lateErr" class="msg msg-error">{{ lateErr }}</div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-ghost btn-sm" @click="lateOpen = false">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="lateBusy" @click="submitLateEntry">
          {{ lateBusy ? 'Adding…' : 'Add to queue' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Round-end transition prompt -->
  <div v-if="roundEndPromptOpen" class="lb-backdrop" @click="roundEndPromptOpen = false"></div>
  <div v-if="roundEndPromptOpen" class="lb-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Round Complete</div>
        <div class="lb-event">Round {{ roundEndForRound }} of {{ currentEvent?.total_rounds }} finished</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="roundEndPromptOpen = false">Skip</button>
    </div>
    <div class="lb-body">
      <p style="font-family:var(--font-mono);font-size:13px;color:var(--text-2);line-height:1.6;margin-bottom:1rem">
        Show the running standings to the audience? Triggers the
        score-reveal overlay on the live scoreboard.
      </p>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem">
        <button class="btn btn-ghost btn-sm" @click="roundEndPromptOpen = false">Skip</button>
        <button class="btn btn-primary btn-sm" @click="announceRoundEnd">📣 Announce standings</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctrl-layout {
  overflow: hidden;
  height: 100vh;
  display: flex;
  flex-direction: column;
}
.ctrl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
  flex-shrink: 0;
}
.ctrl-body {
  flex: 1;
  display: grid;
  grid-template-columns: 280px 1fr 280px;
  overflow: hidden;
}
.ctrl-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-right: 1px solid var(--border);
}
.ctrl-panel:last-child {
  border-right: none;
  border-left: 1px solid var(--border);
}
.panel-head {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--text-3);
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.panel-body {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
}

.active-zone {
  display: flex;
  flex-direction: column;
  padding: 1.5rem;
  background: var(--bg-2);
}
.active-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.75rem; }
.active-name { font-family: var(--font-display); font-size: clamp(36px, 5vw, 72px); font-weight: 900; font-style: italic; color: var(--text); line-height: 1; margin-bottom: 1rem; }
.active-badges { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.active-code { font-family: var(--font-mono); font-size: 28px; font-weight: 500; padding: 0.5rem 1rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.active-dd { font-family: var(--font-display); font-size: 20px; font-weight: 700; padding: 0.5rem 1rem; background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3); border-radius: var(--radius); color: var(--cyan); }
.active-desc { font-size: 13px; color: var(--text-3); line-height: 1.6; min-height: 40px; margin-bottom: 1.5rem; }

.judge-grid { display: flex; flex-wrap: wrap; gap: 0.625rem; margin-bottom: 1.25rem; }
.judge-tile {
  width: 60px; height: 60px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.judge-tile.scored { background: var(--green-dim); border-color: var(--green); box-shadow: 0 0 12px rgba(16,185,129,0.2); }
.judge-tile-label { font-family: var(--font-display); font-size: 9px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); text-transform: uppercase; }
.judge-tile.scored .judge-tile-label { color: var(--green); }
.judge-tile-score { font-family: var(--font-mono); font-size: 16px; font-weight: 500; color: var(--text-3); }
.judge-tile.scored .judge-tile-score { color: var(--text); }

.ref-actions { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.5rem; }
.ref-btn {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.75rem 0.5rem; border-radius: var(--radius-sm); border: 1px solid;
  cursor: pointer; transition: all 0.15s; text-align: center; line-height: 1.3;
}

.nav-btns { display: grid; grid-template-columns: 1fr 2fr; gap: 0.75rem; }
.btn-complete {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  background: var(--amber); color: var(--bg);
  padding: 0.875rem 1.5rem; border-radius: var(--radius-sm);
  border: none; cursor: pointer; transition: all 0.15s;
  grid-column: span 2;
}
.btn-complete:hover { background: #d97706; }

.roster-item { padding: 0.875rem 1rem; background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: border-color 0.15s; margin-bottom: 0.5rem; }
.roster-item:hover { border-color: var(--border-2); }
.roster-item.active { background: var(--cyan-dim); border-color: var(--cyan); }
.roster-name { font-family: var(--font-display); font-size: 14px; font-weight: 700; color: var(--text); }
.roster-item.active .roster-name { color: var(--cyan); }
.roster-meta { display: flex; justify-content: space-between; font-size: 10px; color: var(--text-3); margin-top: 0.2rem; font-family: var(--font-mono); }
.roster-team {
  font-family: var(--font-mono); font-size: 10px; color: #c4b5fd;
  margin-top: 0.2rem; font-weight: 700; letter-spacing: 0.05em;
}
.roster-amp { color: var(--cyan); margin: 0 0.35em; font-weight: 400; }
.round-divider {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin: 0.75rem 0 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--border);
}
.round-divider:first-child { margin-top: 0; }

.active-round { color: var(--text-3); margin-left: 0.5rem; letter-spacing: 0.15em; }
.active-amp { color: var(--cyan); margin: 0 0.4em; font-weight: 400; }
.active-team {
  display: inline-block; margin-bottom: 1rem;
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: #c4b5fd;
  background: rgba(139,92,246,0.10); border: 1px solid rgba(139,92,246,0.45);
  border-radius: 4px; padding: 0.3rem 0.7rem;
}

.country-badge { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); background: var(--bg-3); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.5rem; vertical-align: middle; }
.hist-country { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.5rem; vertical-align: middle; }
.active-country { font-family: var(--font-display); font-size: 14px; font-weight: 700; letter-spacing: 0.15em; color: var(--text-3); background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; padding: 0.15rem 0.5rem; margin-left: 0.75rem; vertical-align: middle; }
.roster-country { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.4rem; vertical-align: middle; }
.hist-card { padding: 0.875rem 1rem; border-left: 2px solid var(--cyan); background: var(--bg-3); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; margin-bottom: 0.5rem; }
.hist-round { font-size: 10px; color: var(--text-3); margin-bottom: 0.3rem; font-family: var(--font-mono); }
.hist-header { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 0.3rem; }
.hist-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text); }
.hist-total { font-family: var(--font-mono); font-size: 16px; font-weight: 500; color: var(--cyan); flex-shrink: 0; margin-left: 0.5rem; }
.hist-dive-line { display: flex; align-items: baseline; gap: 0.6rem; margin-bottom: 0.3rem; }
.hist-code { font-family: var(--font-mono); font-size: 14px; font-weight: 700; color: var(--text); }
.hist-dd { font-family: var(--font-display); font-size: 11px; font-weight: 700; color: var(--cyan); }
.hist-desc { font-size: 10px; color: var(--text-3); margin-bottom: 0.4rem; }
.hist-scores { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.3rem; }
.hist-score { font-family: var(--font-mono); font-size: 10px; padding: 0.15rem 0.4rem; background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.2); border-radius: 3px; color: var(--cyan); }

.conn-badge { display: flex; align-items: center; gap: 0.4rem; font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
.event-select-sm { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.4rem 0.75rem; font-family: var(--font-mono); font-size: 13px; color: var(--text); outline: none; cursor: pointer; }
.roster-count { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }

.btn-back { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.5rem 1.1rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-2); text-decoration: none; transition: all 0.15s; }
.btn-back:hover { background: var(--bg-3); }
.btn-finalise { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.5rem 1.1rem; border-radius: var(--radius-sm); border: 1px solid rgba(245,158,11,0.4); background: var(--amber-dim); color: var(--amber); cursor: pointer; transition: all 0.15s; }
.btn-finalise:hover { background: var(--amber); color: var(--bg); }

.lb-backdrop { position: fixed; inset: 0; background: rgba(3,7,18,0.95); backdrop-filter: blur(12px); z-index: 300; display: flex; align-items: center; justify-content: center; padding: 1.5rem; }
.lb-modal { background: var(--surface); border: 1px solid var(--border-2); border-radius: 28px; width: 100%; max-width: 560px; max-height: 90vh; overflow-y: auto; animation: fadeUp 0.3s ease; }
.lb-header { padding: 2rem 2rem 1.25rem; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--surface); display: flex; align-items: flex-start; justify-content: space-between; }
.lb-title { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.25em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.4rem; }
.lb-event { font-family: var(--font-display); font-size: 26px; font-weight: 900; font-style: italic; color: var(--text); line-height: 1; }
.lb-body { padding: 1.5rem 2rem 2rem; }
.lb-row { display: flex; align-items: center; gap: 1rem; padding: 1rem 0; border-bottom: 1px solid var(--border); }
.lb-row:last-child { border-bottom: none; }
.lb-rank { font-family: var(--font-display); font-size: 28px; font-weight: 900; width: 44px; text-align: right; flex-shrink: 0; color: var(--text-3); }
.lb-rank.gold { color: #f59e0b; }
.lb-rank.silver { color: #94a3b8; }
.lb-rank.bronze { color: #b45309; }
.lb-medal { font-size: 20px; flex-shrink: 0; }
.lb-name { font-family: var(--font-display); font-size: 20px; font-weight: 700; color: var(--text); flex: 1; }
.lb-score { font-family: var(--font-mono); font-size: 22px; font-weight: 500; color: var(--cyan); flex-shrink: 0; }
.lb-winner { background: linear-gradient(135deg, rgba(245,158,11,0.08), rgba(245,158,11,0.03)); border-radius: var(--radius); padding: 0 0.75rem; margin: 0 -0.75rem; }

/* =========================================================
   Hold / Resume — header button + persistent banner
   ========================================================= */
.btn-hold {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.5rem 0.875rem; border-radius: var(--radius-sm);
  border: 1px solid var(--border); background: var(--bg-3);
  color: var(--text-2); cursor: pointer; transition: all 0.15s;
}
.btn-hold:hover { border-color: var(--amber); color: var(--amber); }
.btn-hold-active {
  background: var(--amber); color: var(--bg); border-color: var(--amber);
  animation: pulse-amber 2s infinite;
}
.btn-hold-active:hover { background: var(--amber); color: var(--bg); }
@keyframes pulse-amber { 0%,100% { opacity: 1; } 50% { opacity: 0.75; } }

.hold-banner {
  display: flex; align-items: center; gap: 0.875rem;
  padding: 0.625rem 1.5rem;
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

/* =========================================================
   Shot clock — counts down from 30s when active diver is set
   ========================================================= */
.active-label-row {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.75rem; gap: 0.75rem;
}
.shot-clock {
  display: flex; align-items: center; gap: 0.4rem;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0.25rem 0.4rem 0.25rem 0.6rem;
  transition: all 0.15s;
}
.shot-clock-face {
  background: transparent; border: none; cursor: pointer;
  display: flex; align-items: baseline; gap: 0.15rem;
  font-family: var(--font-display); color: var(--text);
  padding: 0;
}
.shot-clock-num { font-size: 22px; font-weight: 900; font-style: italic; line-height: 1; }
.shot-clock-unit { font-size: 11px; font-weight: 700; color: var(--text-3); letter-spacing: 0.1em; }
.shot-clock-reset {
  background: transparent; border: none; cursor: pointer;
  font-size: 14px; color: var(--text-3);
  padding: 0 0.25rem; line-height: 1;
}
.shot-clock-reset:hover { color: var(--cyan); }

.shot-clock.shot-clock-amber { border-color: var(--amber); }
.shot-clock.shot-clock-amber .shot-clock-num { color: var(--amber); }
.shot-clock.shot-clock-warn { border-color: var(--red); background: rgba(239,68,68,0.06); }
.shot-clock.shot-clock-warn .shot-clock-num { color: var(--red); animation: shotPulse 0.5s infinite; }
.shot-clock.shot-clock-expired {
  border-color: var(--red); background: var(--red);
}
.shot-clock.shot-clock-expired .shot-clock-num,
.shot-clock.shot-clock-expired .shot-clock-unit { color: var(--bg); }
@keyframes shotPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.55; } }

/* =========================================================
   Modals — score correction + hold prompt + round-end
   Reuses .lb-modal styling but swaps max-width.
   ========================================================= */
.hold-modal { max-width: 480px; }
.correct-modal { max-width: 520px; }

/* Make completed-dive cards visually clickable when correctable. */
.hist-card-correctable { cursor: pointer; transition: border-color 0.15s; }
.hist-card-correctable:hover { border-color: var(--cyan); }

/* =========================================================
   Queue rows — reorder + withdraw controls
   ========================================================= */
.roster-row-head {
  display: flex; align-items: stretch;
}
.roster-jump {
  flex: 1; min-width: 0; text-align: left;
  background: transparent; border: none; padding: 0; cursor: pointer;
  color: inherit; font-family: inherit;
}
.roster-jump:disabled { cursor: default; opacity: 0.5; }
.roster-controls {
  display: flex; flex-direction: column; gap: 0.15rem;
  margin-left: 0.4rem; flex-shrink: 0;
}
.roster-ctrl {
  background: transparent; border: 1px solid var(--border);
  border-radius: 3px; cursor: pointer;
  font-size: 10px; padding: 0.05rem 0.4rem; line-height: 1.2;
  color: var(--text-3); transition: all 0.1s;
  min-width: 22px;
}
.roster-ctrl:hover:not(:disabled) {
  border-color: var(--cyan); color: var(--cyan);
}
.roster-ctrl:disabled { opacity: 0.3; cursor: default; }
.roster-withdraw:hover { border-color: var(--red); color: var(--red); }
.roster-reinstate {
  border-color: rgba(245,158,11,0.4); color: var(--amber);
}

.roster-item.withdrawn { opacity: 0.45; }
.roster-item.withdrawn .roster-name { text-decoration: line-through; }
.roster-wd-badge {
  font-family: var(--font-display); font-size: 8px; font-weight: 900;
  letter-spacing: 0.2em; color: var(--red);
  background: var(--red-dim); border: 1px solid rgba(239,68,68,0.4);
  border-radius: 3px; padding: 0.05rem 0.35rem;
  margin-left: 0.4rem; vertical-align: middle;
}

.late-modal { max-width: 480px; }
.late-modal .hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.5rem 0.7rem; margin-top: 0.4rem;
  background: var(--bg-3); border-left: 3px solid var(--cyan); border-radius: 3px;
}

/* =========================================================
   Standings preview — top 5 inline above the diver queue
   ========================================================= */
.standings-preview {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-3);
  flex-shrink: 0;
}
.standings-preview-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.5rem;
}
.sp-row {
  display: flex; align-items: baseline; gap: 0.5rem;
  padding: 0.2rem 0; font-size: 12px;
}
.sp-rank {
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  color: var(--text-3); width: 16px; text-align: right; flex-shrink: 0;
}
.sp-rank.gold   { color: #f59e0b; }
.sp-rank.silver { color: #94a3b8; }
.sp-rank.bronze { color: #b45309; }
.sp-name {
  font-family: var(--font-display); font-weight: 700; color: var(--text);
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.sp-total {
  font-family: var(--font-mono); font-weight: 700; color: var(--cyan);
  flex-shrink: 0;
}

/* =========================================================
   Queue search + jump-to-round chips
   ========================================================= */
.queue-filters {
  padding: 0.625rem 0.875rem; border-bottom: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 0.5rem; flex-shrink: 0;
  background: var(--bg-2);
}
.queue-search {
  font-size: 12px; padding: 0.4rem 0.6rem;
}
.round-chips {
  display: flex; gap: 0.25rem; flex-wrap: wrap;
}
.round-chip {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.2rem 0.45rem; border-radius: 3px;
  background: var(--bg-3); border: 1px solid var(--border); color: var(--text-3);
  cursor: pointer; transition: all 0.1s;
}
.round-chip:hover { border-color: var(--cyan); color: var(--cyan); }
.round-chip.active {
  background: var(--cyan-dim); border-color: var(--cyan); color: var(--cyan);
}

/* =========================================================
   History pane filters
   ========================================================= */
.hist-filters {
  display: flex; gap: 0.4rem; padding: 0.625rem 0.875rem;
  border-bottom: 1px solid var(--border); background: var(--bg-2);
  flex-shrink: 0;
}
.hist-filter-select {
  flex: 1; font-size: 11px; padding: 0.35rem 0.5rem;
}

/* =========================================================
   Bigger judge tiles + name labels under each
   ========================================================= */
.judge-tile {
  width: 76px; height: 76px;                             /* up from 60×60 */
  position: relative;
}
.judge-tile-score { font-size: 20px; }                   /* bigger score */
.judge-tile-name {
  font-family: var(--font-mono); font-size: 9px;
  color: var(--text-3); margin-top: 0.1rem;
  max-width: 70px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.judge-tile.scored .judge-tile-name { color: var(--green); }
/* When a score lands, briefly pulse the tile so the operator
   sees incoming submissions even from across the deck. */
.judge-tile.scored {
  animation: tilePulse 0.4s ease-out;
}
@keyframes tilePulse {
  0%   { transform: scale(1); box-shadow: 0 0 0 rgba(16,185,129,0); }
  50%  { transform: scale(1.06); box-shadow: 0 0 18px rgba(16,185,129,0.5); }
  100% { transform: scale(1); box-shadow: 0 0 12px rgba(16,185,129,0.2); }
}

.kbd-hints {
  display: flex; gap: 1rem; flex-wrap: wrap;
  margin-top: 0.75rem;
  font-family: var(--font-mono); font-size: 10px;
  color: var(--text-3);
}
.kbd-hints kbd {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  padding: 0.1rem 0.35rem;
  background: var(--bg-3); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 3px;
  box-shadow: inset 0 -1px 0 var(--border-2);
}

/* ── Tablet & phone ─────────────────────────────────────────
   The control room is primarily a desktop view, but a meet
   manager occasionally needs to advance the queue from a tablet
   or phone — collapse the 3-column layout onto a single
   scrolling column so it stays usable. */
@media (max-width: 900px) {
  .ctrl-body {
    grid-template-columns: 1fr;
    overflow: visible;
  }
  .ctrl-panel {
    overflow: visible;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .ctrl-panel:last-child {
    border-left: none;
    border-bottom: none;
  }
  .panel-body { overflow-y: visible; }
}

@media (max-width: 720px) {
  .active-zone { padding: 1rem; }
  .active-name { font-size: clamp(28px, 8vw, 44px); margin-bottom: 0.75rem; }
  .active-code { font-size: 20px; padding: 0.4rem 0.75rem; }
  .active-dd   { font-size: 16px; padding: 0.4rem 0.75rem; }

  /* Judge-tile grid: 60×60 tiles wrap fine but reducing them
     a touch lets a 7- or 11-judge panel land on one row. */
  .judge-tile { width: 52px; height: 52px; }

  /* Referee actions: 3 buttons → 2-up + 1 below to fit narrow widths. */
  .ref-actions { grid-template-columns: 1fr 1fr; }
  .ref-actions > :nth-child(3) { grid-column: span 2; }

  /* Leaderboard modal */
  .lb-modal   { max-height: 95vh; border-radius: var(--radius-lg); }
  .lb-header  { padding: 1.25rem 1.25rem 1rem; }
  .lb-event   { font-size: 22px; }
  .lb-body    { padding: 1rem 1.25rem 1.5rem; }
  .lb-row     { padding: 0.75rem 0; gap: 0.75rem; }
  .lb-rank    { font-size: 22px; width: 32px; }
  .lb-name    { font-size: 16px; }
  .lb-score   { font-size: 18px; }
}
</style>
