<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { diveDescription } from '@/composables/useDiveLabel'
import { showUndo } from '@/composables/useUndo'
import { showSuccess, showError, showInfo } from '@/composables/useNotify'
import { confirmAction } from '@/composables/useConfirm'
import DiverIdentity from '@/components/DiverIdentity.vue'
import StatusPill from '@/components/StatusPill.vue'
import {
  annotatedScores,
  annotatedSynchroScores,
  groupedSynchroScoresForDisplay,
  synchroJudgeGroups,
  synchroRoleForJudge,
  trimCount,
} from '@/composables/useScoreCategories'

const auth = useAuthStore()
const socket = useSocket()
const route = useRoute()

// Operator broadcast mode: /control?broadcast=1 hides the
// chrome (header buttons, queue controls) and renders a
// projection-friendly view of just the active diver, judge
// tiles, and current standings. Toggled via URL so an operator
// can flip a back-of-house screen without leaving the page.
const opsBroadcast = computed(() => route.query.broadcast === '1')

// Active diver status — auto-derived from real signals so the
// operator never has to remember to click anything:
//   READY    — announced & on the board, no scores yet, the
//              30-second WA shot clock is still running
//   DIVING   — shot clock has expired (per WA the diver MUST
//              have started by then), still no scores in
//   JUDGING  — at least one judge has submitted a score for
//              this round
//
// Surfaces in the spectator scoreboard via set_active_diver
// emissions; a watcher below this declaration pushes a new
// emission every time the derived status flips so the
// audience-facing strip stays in sync without polling.
const activeStatus = computed(() => {
  if (!currentActive.value) return 'ready'
  // JUDGING wins: even if a single judge has tapped a score,
  // the dive is over and the panel is entering scores.
  if (Object.keys(scoresThisRound.value).length > 0) return 'judging'
  // Shot clock has hit zero (or was paused at zero) → diver
  // has begun their dive (WA's 30-second rule guarantees it).
  if (shotClockExpired.value) return 'diving'
  return 'ready'
})

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
// Connection state lives on the singleton socket itself
// (`socket.isConnected`, a ref). A parallel `connStatus` ref
// would just shadow that state — and now that useSocket is a
// real singleton, two listeners on connect/disconnect (the
// composable's + this view's) would race.
const meetName = ref('')
const activeInfo = ref({ name: '—', code: '—', dd: 'DD —', desc: 'Select an event to begin.' })
const nextBtnDisabled = ref(true)
const nextBtnText = ref('Next Diver →')
const nextBtnComplete = ref(false)
// Finalise button state — driven by event status + whether
// the very last dive of the very last round has been scored.
// Was a pair of refs that an explicit updateFinaliseButton()
// kept in sync; now derived computeds so the visibility and
// label react automatically to (status, nextBtnComplete).
//
// Visibility rules:
//   - Upcoming     → hidden. "Finalise" makes no sense before
//                    the event has even started; the pre-meet
//                    workflow handles event start.
//   - Live mid-meet → hidden from the header chrome. The
//                    operator can still trigger an early
//                    finalise via the ⋯ menu's "Finalise event
//                    early" item (rare: postponement, cut
//                    short for safety, etc.). Centre column's
//                    Next Diver button is still the primary
//                    affordance to advance through the meet.
//   - Live + every dive scored → shown prominently. This is
//                    the natural finalise moment. The centre
//                    column's Next Diver button also morphs
//                    into "✓ Event Complete — Finalise & View
//                    Results" at the same time, so both
//                    affordances are available.
//   - Completed    → shown as "View Results" — opens the
//                    leaderboard modal.
const finaliseBtnShow = computed(() => {
  const ev = currentEvent.value
  if (!ev) return false
  if (ev.status === 'Completed') return true
  if (ev.status === 'Live' && nextBtnComplete.value) return true
  return false
})
const finaliseBtnText = computed(() =>
  currentEvent.value?.status === 'Completed' ? 'View Results' : 'Finalise Event ✓',
)
const finaliseBtnTitle = computed(() =>
  currentEvent.value?.status === 'Completed'
    ? 'View final standings'
    : 'Every dive is in — click to publish the recap and send the "results posted" emails.',
)
// "Finalise event early" menu item — only relevant during
// Live, before the natural completion moment.
const finaliseEarlyVisible = computed(() =>
  !!currentEvent.value
  && currentEvent.value.status === 'Live'
  && !nextBtnComplete.value,
)

// Explanatory tooltip for the Next Diver button so a new
// operator can see WHY the button is disabled rather than
// having to guess. Computes a rich reason from the current
// state (no active diver / waiting for N more judge scores)
// and falls back to a "what does this do + keyboard shortcut"
// hint when enabled. Wired as :title on the button.
const nextBtnTitle = computed(() => {
  if (!nextBtnDisabled.value) {
    return nextBtnComplete.value
      ? 'All rounds complete — finalise the event'
      : 'Advance to the next diver (→ or Space)'
  }
  if (!currentActive.value) {
    return 'Pick an active diver from the queue first'
  }
  const need = parseInt(currentEvent.value?.number_of_judges) || 5
  const have = Object.keys(scoresThisRound.value).length
  const remaining = Math.max(0, need - have)
  if (remaining === 0) return 'Loading…'
  return `Waiting for ${remaining} more judge score${remaining === 1 ? '' : 's'}`
})

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
      // Audible beep removed — pool decks already have a horn /
      // referee whistle that the operator listens for, and the
      // visual .shot-clock-expired flash gives the same signal
      // without competing with the venue audio. The shotClockExpired
      // flag still drives the colour change in the CSS.
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

// Push status changes out to the spectator scoreboard. The
// initial set_active_diver emission (in setActive() below)
// already includes the starting status; this watcher covers
// every transition after that — clock-expired flip from READY
// to DIVING, first-score flip from DIVING to JUDGING, etc.
// Without this the audience-facing pill would freeze on
// whatever status was true the moment the diver was announced.
watch(activeStatus, (newStatus) => {
  if (!currentActive.value) return
  socket.emit('set_active_diver', {
    ...currentActive.value,
    status: newStatus,
  })
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

// Live preview for the correction modal — recomputes the trim
// sum + dive points the moment the operator types a new score
// so they see the impact before clicking Save.
//
// The trim follows the same rule the live scoring uses
// (trimCount(numJudges)), and synchro pairs multiply by the WA
// 0.6 factor. Returns null when the input is invalid so the
// preview block hides cleanly until a usable score is in.
const correctPreview = computed(() => {
  const card = correctTarget.value
  if (!card || !Array.isArray(card.scores) || !card.scores.length) return null
  const newVal = parseFloat(correctNewScore.value)
  if (Number.isNaN(newVal) || newVal < 0 || newVal > 10 || ((newVal * 2) % 1) !== 0) {
    return null
  }
  const idx = correctJudgeIdx.value
  const oldScores = card.scores.map(s => parseFloat(s))
  if (idx < 0 || idx >= oldScores.length) return null
  const newScores = oldScores.slice()
  newScores[idx] = newVal

  const ev = currentEvent.value
  const numJudges = parseInt(ev?.number_of_judges) || oldScores.length
  const k = trimCount(numJudges)
  const factor = ev?.event_type === 'synchro_pair' ? 0.6 : 1
  const dd = parseFloat(card.dd) || 0

  function trimSum(scores) {
    const sorted = [...scores].sort((a, b) => a - b)
    const kept = k > 0 && sorted.length > k * 2
      ? sorted.slice(k, sorted.length - k)
      : sorted
    return kept.reduce((a, b) => a + b, 0)
  }

  const oldTrim   = trimSum(oldScores)
  const newTrim   = trimSum(newScores)
  const oldPoints = oldTrim * dd * factor
  const newPoints = newTrim * dd * factor
  const delta     = newPoints - oldPoints

  // Flag when the edit changes which judge gets dropped — e.g.,
  // pulling a 9.0 down to 5.0 means a different score is now
  // trimmed at the top end. Useful so the operator understands
  // why the trim sum moved more than they'd expect.
  const dropChanged = (() => {
    if (k <= 0) return false
    const oldSorted = [...oldScores].map((s, i) => ({ s, i }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
    const newSorted = [...newScores].map((s, i) => ({ s, i }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
    const oldDropped = new Set([
      ...oldSorted.slice(0, k).map(r => r.i),
      ...oldSorted.slice(-k).map(r => r.i),
    ])
    const newDropped = new Set([
      ...newSorted.slice(0, k).map(r => r.i),
      ...newSorted.slice(-k).map(r => r.i),
    ])
    if (oldDropped.size !== newDropped.size) return true
    for (const i of oldDropped) if (!newDropped.has(i)) return true
    return false
  })()

  return {
    judgeIdx: idx,
    oldScore: oldScores[idx],
    newScore: newVal,
    oldTrim, newTrim,
    oldPoints, newPoints,
    delta,
    dropChanged,
    dd,
    unchanged: oldScores[idx] === newVal,
  }
})

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
    // Same auto-advance contract as between dives: if the
    // operator has set a delay, fire announceRoundEnd after the
    // countdown so the meet keeps moving without a click.
    startAutoAdvance(announceRoundEnd)
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
  // Once round-end is dismissed, kick off the dive-advance
  // timer so the meet keeps rolling into round N+1's first
  // diver. Manual mode no-ops.
  cancelAutoAdvance()
  if (!nextBtnComplete.value) startAutoAdvance(nextDiver)
}

// =============================================================
// QUEUE MANAGEMENT — reorder, withdraw, late entry
// =============================================================

// =========================================================
// QUEUE LOCK — drag-reorder + ▲/▼ + randomise are only valid
// before the meet starts. Once the event flips out of
// 'Upcoming' the published start order is committed and any
// reshuffle would invalidate the spectator scoreboard. The
// server enforces this too (HTTP 409); the UI mirrors it so
// operators don't see a button that always errors.
// =========================================================
const canReorderQueue = computed(() =>
  currentEvent.value?.status === 'Upcoming',
)

// =========================================================
// DIVER START ORDER — the 1-based diving position shown in
// front of every name (active diver, completed-dive history
// cards, roster queue). The same diver keeps their order
// across all rounds, so a single competitor_id → number map
// is enough.
//
// Reads round_order (server-side ROW_NUMBER) ahead of
// display_order so an event randomised under the pre-fix SQL
// bug still shows clean 1..N labels rather than the stale
// values left in display_order. Falls back to display_order
// when the older response shape is in play.
// =========================================================
const competitorOrderMap = computed(() => {
  const map = new Map()
  for (const row of roster.value) {
    const pos = row.round_order ?? row.display_order
    if (pos != null && !map.has(row.competitor_id)) {
      map.set(row.competitor_id, pos)
    }
  }
  return map
})
function competitorOrder(competitorId) {
  if (!competitorId) return null
  return competitorOrderMap.value.get(competitorId) ?? null
}

// =========================================================
// SYNCHRO PANEL HELPERS
// Surface "is this a synchro event?" and the WA judge groupings
// once so every place that needs them — history cards, the live
// judge-tile grid, the dive-total calc — reads from the same
// source. groupedSynchroScoresForDisplay / synchroJudgeGroups
// live in the shared composable so the Scoreboard view's render
// stays byte-for-byte identical to ours.
// =========================================================
const isSynchroEvent = computed(() =>
  currentEvent.value?.event_type === 'synchro_pair',
)
// { a: [1,2,...], b: [...], sync: [...] } when synchro AND the
// panel size is 9 or 11 (WA-recognised); null otherwise. The
// centre grid groups its tiles via this; the history rendering
// uses groupedSynchroScoresForDisplay (which wraps the same
// helper) so the chips stay in WA order.
const liveSynchroGroups = computed(() => {
  if (!isSynchroEvent.value) return null
  return synchroJudgeGroups(parseInt(currentEvent.value?.number_of_judges) || 0)
})
// Tiles split by role for the centre judge grid. Returns null
// when not synchro so the template's v-if can fall back to the
// flat grid.
const judgeTilesByGroup = computed(() => {
  const groups = liveSynchroGroups.value
  if (!groups) return null
  const idx = (jn) => judgeTiles.value.find(t => t.judgeIndex === jn) || null
  return [
    { role: 'a',    label: 'Exec A', tiles: groups.a.map(idx).filter(Boolean) },
    { role: 'b',    label: 'Exec B', tiles: groups.b.map(idx).filter(Boolean) },
    { role: 'sync', label: 'Sync',   tiles: groups.sync.map(idx).filter(Boolean) },
  ]
})

// =========================================================
// LIVE DIVE TOTAL — once every judge tile is filled, show the
// official dive total (trim_sum × DD) under the judge grid so
// the operator can see the scored result immediately rather
// than waiting for the audience scoreboard to refresh. Returns
// null until the panel is complete; the template hides the row
// when null.
// =========================================================
const liveDiveTotal = computed(() => {
  const tiles = judgeTiles.value
  const need = parseInt(currentEvent.value?.number_of_judges) || 0
  if (!need || tiles.length < need) return null
  if (!tiles.every(t => t.scored)) return null
  const dd = parseFloat(currentActive.value?.dd)
  if (!dd || Number.isNaN(dd)) return null
  const csv = tiles
    .slice()
    .sort((a, b) => a.judgeIndex - b.judgeIndex)
    .map(t => parseFloat(t.score))
    .filter(v => !Number.isNaN(v))
    .join(',')
  // Synchro events trim WITHIN each judge group (Exec A drops
  // 1+1 from a 3-judge sub-panel, Sync drops 1+1 from 5, etc.)
  // — same rule the scoreboard + server-side calc use. Falls
  // back to the flat individual rule for non-synchro panels.
  const annotated = isSynchroEvent.value
    ? annotatedSynchroScores(csv, need)
    : annotatedScores(csv, need)
  const trimSum = annotated
    .filter(j => !j.dropped)
    .reduce((sum, j) => sum + j.value, 0)
  // Synchro multiplies the kept-execution contribution by 3/n_a
  // and the kept-sync contribution by 3/n_sync to get a 6-judge
  // equivalent before × DD. The scoreboard's
  // calc_event_dive_points handles this server-side; here we
  // approximate so the operator sees "≈" not "exact". Implement
  // the same scaling for parity. For 9-panel: a/b 1+1 → kept 1+1
  // (sum × 3 / 2 each) + sync 1+1+3 → kept 3 (sum × 3 / 3); the
  // scaling factor per group is 3/(group size − dropCount × 2).
  if (!isSynchroEvent.value) return trimSum * dd
  const groups = synchroJudgeGroups(need)
  if (!groups) return trimSum * dd
  // For each group, sum kept × scaleFactor where scaleFactor = 3
  // / count_kept. Mirrors the SQL in calc_event_dive_points.
  const arr = annotated   // index aligned to judge_number-1
  let scaled = 0
  for (const set of [groups.a, groups.b, groups.sync]) {
    const kept = set
      .map(jn => arr[jn - 1])
      .filter(j => j && !j.dropped)
    if (!kept.length) continue
    scaled += (kept.reduce((s, j) => s + j.value, 0) / kept.length) * 3
  }
  return scaled * dd
})

// =========================================================
// AUTO-ADVANCE — operator-configurable auto-progression. When
// non-zero, the queue advances to the next diver N seconds
// after the last judge submits, and the round-end "Announce
// standings" prompt auto-confirms after the same delay. Lets
// a manager run a meet without keeping a hand on the queue —
// the operator can step in any time to cancel, change scores,
// fire a referee action, etc.
//
// Persisted via localStorage so the operator's preferred mode
// survives reload. Default is Manual (0) — every meet starts
// in the safest state until the operator opts in.
// =========================================================
const AUTO_ADVANCE_KEY = 'dr_control_auto_advance_seconds'
const autoAdvanceSeconds = ref(
  parseInt(localStorage.getItem(AUTO_ADVANCE_KEY) || '0', 10) || 0,
)
watch(autoAdvanceSeconds, (s) => {
  try { localStorage.setItem(AUTO_ADVANCE_KEY, String(s)) } catch { /* private mode */ }
  // Editing the dropdown mid-countdown cancels the in-flight
  // timer so the operator's intent is respected immediately.
  cancelAutoAdvance()
})
const autoAdvanceCountdown = ref(0)   // remaining seconds; 0 = idle
let autoAdvanceTimer = null
let autoAdvanceFire   = null          // callback to run on completion
function cancelAutoAdvance() {
  if (autoAdvanceTimer) { clearInterval(autoAdvanceTimer); autoAdvanceTimer = null }
  autoAdvanceCountdown.value = 0
  autoAdvanceFire = null
}
function startAutoAdvance(callback) {
  cancelAutoAdvance()
  if (!autoAdvanceSeconds.value) return            // Manual mode
  // Don't kick off the countdown while a judge is flagging the
  // referee — the operator's eyes need to be on the dive
  // resolution, not racing a timer.
  if (signalingJudges.value.length > 0) return
  autoAdvanceCountdown.value = autoAdvanceSeconds.value
  autoAdvanceFire = callback
  autoAdvanceTimer = setInterval(() => {
    autoAdvanceCountdown.value--
    if (autoAdvanceCountdown.value <= 0) {
      const fire = autoAdvanceFire
      cancelAutoAdvance()
      if (typeof fire === 'function') fire()
    }
  }, 1000)
}

// =========================================================
// SIGNAL-REFEREE OVERLAY — a judge tapping their keypad's
// Signal Referee button raises a red flag on their tile (see
// .judge-tile.signaled) AND blocks the auto-advance timer
// until the signal clears. The operator sees a centred banner
// telling them which judge needs attention; clearing happens
// either when the judge submits a fresh score (server emits
// judge_signal {signaled: false} via the JudgeView client) or
// when the operator advances to the next diver.
// =========================================================
const signalingJudges = computed(() =>
  judgeTiles.value.filter(t => t.signaled).map(t => t.judgeIndex),
)
watch(signalingJudges, (now, prev) => {
  // Going from any → none: re-arm auto-advance if the panel
  // was already complete (next button enabled, not at finalise).
  if (prev && prev.length && now.length === 0
      && !nextBtnDisabled.value && !nextBtnComplete.value) {
    startAutoAdvance(nextDiver)
  }
  // Going from none → any: kill the in-flight countdown.
  if (now.length > 0) cancelAutoAdvance()
})

// =========================================================
// PRE-MEET WORKFLOW
//
// Four sequential states that one button cycles through before
// the event flips Live (red → orange → yellow → green):
//
//   1. CHECK-IN — operator confirms attendance is recorded.
//                 Click opens the check-in modal; the modal's
//                 "Confirm Check-in Complete" footer button
//                 stamps check_in_done_at and advances.
//   2. RANDOM   — randomise (or confirm) the start order.
//                 Click shuffles via the existing endpoint and
//                 stamps dive_order_randomised_at.
//   3. SIGN-OFF — referee approves the published order.
//                 Click stamps dive_order_signed_off_at + by.
//   4. START    — flip the event status from Upcoming → Live.
//
// Re-randomising clears the sign-off because the order has
// changed and the referee must re-approve. A small "↺ Reset"
// link next to the button calls the /reset endpoint to walk
// back to state 1 — clears every workflow stamp.
// =========================================================
const orderBusy = ref(false)

// Effective state of the workflow. Kept as a computed off
// currentEvent so an external mutation (another operator, page
// reload) reflects immediately. 'live' covers any event past
// the Upcoming gate; the button hides itself in that case.
const orderWorkflowState = computed(() => {
  const ev = currentEvent.value
  if (!ev) return null
  if (ev.status !== 'Upcoming') return 'live'
  if (!ev.check_in_done_at)         return 'check-in'
  if (!ev.dive_order_randomised_at) return 'random'
  if (!ev.dive_order_signed_off_at) return 'sign-off'
  return 'start'
})

// Stepper helper — classifies each pre-meet step as done /
// active / future relative to the current workflow state.
// Drives the four-pip indicator that renders ABOVE the action
// button so the operator sees the whole flow at a glance
// instead of having to remember the order red → orange →
// yellow → green carries.
const WORKFLOW_STEPS = ['check-in', 'random', 'sign-off', 'start']
function wfStepClass(stepName) {
  const cur = WORKFLOW_STEPS.indexOf(orderWorkflowState.value)
  const idx = WORKFLOW_STEPS.indexOf(stepName)
  if (cur === -1 || idx === -1) return 'wf-step-future'
  if (cur > idx) return 'wf-step-done'
  if (cur === idx) return 'wf-step-active'
  return 'wf-step-future'
}

// Replace the stamps on currentEvent (and the matching events
// list row) without re-fetching the whole list. Keeps the button
// in sync after every workflow step.
function patchCurrentEvent(patch) {
  if (!currentEvent.value) return
  Object.assign(currentEvent.value, patch)
  const row = events.value.find(e => e.id === currentEvent.value.id)
  if (row) Object.assign(row, patch)
}

async function randomizeStartOrder() {
  if (!currentEvent.value) return
  if (!canReorderQueue.value) {
    showInfo('The dive order is locked once the event has started.')
    return
  }
  const ev = currentEvent.value
  if (!await confirmAction({
    title: 'Randomise dive order?',
    body:  `Every diver's position in "${ev.name}" will be reshuffled across all rounds.`,
    consequences: [
      'You can re-run randomise as many times as you like before sign-off',
      'Manual reordering after this overrides the random order',
    ],
    confirmLabel: 'Randomise',
    confirmKind:  'warn',
  })) return
  orderBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${ev.id}/dive-lists/randomize`, {
      method: 'POST',
    })
    // Re-pull the roster so the new display_order takes effect.
    const fresh = await auth.apiFetch(`/api/events/${ev.id}/roster`)
    roster.value = fresh
    // currentIndex no longer points at a meaningful row; reset it
    // and let the operator re-pick the active diver.
    currentIndex.value = -1
    currentActive.value = null
    // Server stamped randomised_at + cleared signed_off — mirror
    // that on the local event so the button flips to yellow.
    patchCurrentEvent({
      dive_order_randomised_at: new Date().toISOString(),
      dive_order_signed_off_at: null,
      dive_order_signed_off_by: null,
    })
  } catch (err) {
    showError('Randomise failed: ' + err.message)
  } finally {
    orderBusy.value = false
  }
}

// "Skip randomise" path — operator already arranged the order
// manually (e.g. seeded from a prior round) and just wants to
// advance to sign-off.
async function confirmDiveOrder() {
  if (!currentEvent.value) return
  if (!await confirmAction({
    title: 'Use current dive order?',
    body:  `Skip randomise — lock in the order you've already arranged for "${currentEvent.value.name}" and advance to sign-off.`,
    confirmLabel: 'Use current order',
    confirmKind:  'primary',
  })) return
  orderBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${currentEvent.value.id}/dive-order/confirm`, {
      method: 'POST',
    })
    patchCurrentEvent({
      dive_order_randomised_at: new Date().toISOString(),
    })
  } catch (err) {
    showError('Failed: ' + err.message)
  } finally {
    orderBusy.value = false
  }
}

// Sign-off modal state — four tabs:
//   'push'         send a push notification to a chosen referee's
//                  device. Lives until the referee approves/denies
//                  or 5 minutes elapse.
//   'code'         Cut 3: server generates a 6-digit code, manager
//                  reads it to the referee, referee types it on
//                  their own /sign-off-codes page.
//   'credential'   referee enters their own username + password
//                  (+ TOTP) on this device. No JWT swap; the
//                  manager's session is untouched.
//   'manager'      manager attests on referee's behalf. Hidden +
//                  refused server-side when the event has
//                  enforce_referee_signoff = TRUE.
const signoffOpen        = ref(false)
const signoffMode        = ref('push')   // 'push' | 'code' | 'credential' | 'manager'
const signoffReferees    = ref([])
const signoffPickedRefId = ref('')
const signoffWaiting     = ref(null)     // push: { request_id, expires_at, referee_name }
const signoffCode        = ref(null)     // code: { request_id, code, expires_at, referee_name }
const signoffError       = ref('')
const credUsername       = ref('')
const credPassword       = ref('')
const credCode           = ref('')
const credNeedsTotp      = ref(false)

// Whether the simple manager-attests path is allowed for the
// current event. Server enforces too; this just hides the tab
// when the event was created with enforce_referee_signoff = TRUE.
const enforceSignoff = computed(() =>
  !!currentEvent.value?.enforce_referee_signoff
)
// Origin string for the code-handoff hint copy. window isn't
// available in the SSR-style template scope so we capture it via
// a computed wrapper.
const appOrigin = computed(() =>
  typeof window !== 'undefined' ? window.location.origin : ''
)

async function signOffDiveOrder() {
  if (!currentEvent.value) return
  signoffOpen.value = true
  signoffMode.value = 'push'
  signoffError.value = ''
  signoffWaiting.value = null
  signoffCode.value = null
  signoffPickedRefId.value = ''
  credUsername.value = ''
  credPassword.value = ''
  credCode.value = ''
  credNeedsTotp.value = false
  // Pull the referee list once when the modal opens. Best-effort —
  // if it fails the modal still works via the credential tab.
  try {
    signoffReferees.value = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/referees`,
    )
  } catch {
    signoffReferees.value = []
  }
}

function closeSignoffModal() {
  signoffOpen.value = false
  signoffWaiting.value = null
  signoffCode.value = null
  signoffError.value = ''
}

async function sendSignoffPush() {
  if (!currentEvent.value || !signoffPickedRefId.value) return
  signoffError.value = ''
  orderBusy.value = true
  try {
    const r = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/dive-order/sign-off/request`,
      {
        method: 'POST',
        body: JSON.stringify({ referee_id: signoffPickedRefId.value }),
      },
    )
    const refRow = signoffReferees.value.find(x => x.id === signoffPickedRefId.value)
    signoffWaiting.value = {
      request_id: r.request_id,
      expires_at: r.expires_at,
      referee_name: refRow?.full_name || 'the referee',
    }
  } catch (err) {
    signoffError.value = err.message
  } finally {
    orderBusy.value = false
  }
}

async function submitCredentialSignoff() {
  if (!currentEvent.value) return
  signoffError.value = ''
  orderBusy.value = true
  try {
    const body = {
      username: credUsername.value.trim(),
      password: credPassword.value,
    }
    if (credNeedsTotp.value && credCode.value) body.code = credCode.value.trim()
    await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/dive-order/sign-off/credential`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    // Server stamped the sign-off in the same transaction. Mirror
    // locally so the workflow button flips green immediately.
    patchCurrentEvent({
      dive_order_signed_off_at: new Date().toISOString(),
    })
    closeSignoffModal()
  } catch (err) {
    // Server signals "TOTP required" by returning needs_totp:true.
    // Surface the second-factor field rather than a vague 401.
    const msg = err.message || ''
    if (/totp/i.test(msg) || /code/i.test(msg)) {
      credNeedsTotp.value = true
      signoffError.value = credCode.value
        ? 'Invalid TOTP code'
        : 'TOTP code required'
    } else {
      signoffError.value = msg || 'Sign-off failed'
    }
  } finally {
    orderBusy.value = false
  }
}

// Listen for the response broadcast the server fires when the
// referee taps Approve/Deny on their device, AND when they
// type a Cut 3 handoff code on their own /sign-off-codes page
// (server fires the same broadcast). Wired in onMounted further
// down via socket.on('referee_signoff_response', ...).
function onRefereeSignoffResponse(data) {
  // Match against either the push-waiting request OR the code-
  // waiting request — both store request_id and only one is
  // active at a time per modal session.
  const waitingId = signoffWaiting.value?.request_id || signoffCode.value?.request_id
  if (!waitingId || data?.request_id !== waitingId) return
  if (data.decision === 'approved') {
    patchCurrentEvent({
      dive_order_signed_off_at: new Date().toISOString(),
      dive_order_signed_off_by: data.by_user_id,
    })
    closeSignoffModal()
  } else {
    const refereeName =
      signoffWaiting.value?.referee_name || signoffCode.value?.referee_name || 'The referee'
    signoffError.value = `${refereeName} declined the request.`
    signoffWaiting.value = null
    signoffCode.value = null
  }
}

// Cut 3: ask the server for a 6-digit handoff code for the
// chosen referee. Display it; the referee types it on their own
// /sign-off-codes page on their already-signed-in device.
async function generateSignoffCode() {
  if (!currentEvent.value || !signoffPickedRefId.value) return
  signoffError.value = ''
  orderBusy.value = true
  try {
    const r = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/dive-order/sign-off/code`,
      {
        method: 'POST',
        body: JSON.stringify({ referee_id: signoffPickedRefId.value }),
      },
    )
    const refRow = signoffReferees.value.find(x => x.id === signoffPickedRefId.value)
    signoffCode.value = {
      request_id:  r.request_id,
      code:        r.code,
      expires_at:  r.expires_at,
      qr_data_url: r.qr_data_url || null,
      deep_link:   r.deep_link   || null,
      referee_name: refRow?.full_name || 'the referee',
    }
  } catch (err) {
    signoffError.value = err.message
  } finally {
    orderBusy.value = false
  }
}

// Manager-attests path. Fires the simple endpoint (which the
// server refuses if the event has enforce_referee_signoff = TRUE).
// Hidden in the UI under the same condition; this is the
// belt-and-braces server-trip.
async function managerAttestSignoff() {
  if (!currentEvent.value) return
  if (!await confirmAction({
    title: 'Sign off as meet manager?',
    body:  `Use this fallback only when you've already confirmed the dive order with the referee verbally.`,
    consequences: [
      `Your name (${auth.user?.full_name || 'manager'}) is recorded against the event audit trail`,
      'The referee can countersign later if your federation requires it',
    ],
    confirmLabel: 'Attest sign-off',
    confirmKind:  'warn',
  })) return
  orderBusy.value = true
  try {
    const r = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/dive-order/sign-off`,
      { method: 'POST' },
    )
    patchCurrentEvent({
      dive_order_signed_off_at: r.dive_order_signed_off_at || new Date().toISOString(),
      dive_order_signed_off_by: r.dive_order_signed_off_by,
    })
    closeSignoffModal()
  } catch (err) {
    signoffError.value = err.message
  } finally {
    orderBusy.value = false
  }
}

// Pre-flight review modal — shown when the operator clicks the
// green "Start Event" workflow button. The four-step pre-meet
// stepper has already verified the procedural prerequisites
// (check-in, randomise, sign-off); this modal is the last-
// chance visual review of WHAT'S ABOUT TO GO LIVE — roster
// size, judge panel, referee status, plus a warnings list for
// anything that looks misconfigured (synchro on a 5-judge
// panel, divers with incomplete dive lists, etc.). Mirrors a
// pilot's pre-flight checklist before take-off.
const preFlightOpen = ref(false)
const preFlightSummary = computed(() => {
  const ev = currentEvent.value
  if (!ev) return null
  const totalRounds = parseInt(ev.total_rounds) || 0
  // Derive checked-in divers from the roster. Each row is one
  // diver-round, so group by competitor_id and count rounds.
  const byDiver = new Map()
  for (const row of roster.value) {
    if (row.withdrawn_at) continue
    const id = row.competitor_id || row.diver_id || row.dive_list_id
    if (!byDiver.has(id)) {
      byDiver.set(id, {
        id,
        name: row.full_name || row.diver_name || 'Diver',
        rows: 0,
        missingDive: 0,
      })
    }
    const e = byDiver.get(id)
    e.rows++
    if (!row.dive_code) e.missingDive++
  }
  const divers = [...byDiver.values()]
  const incompleteDivers = divers.filter(d =>
    d.rows < totalRounds || d.missingDive > 0,
  )
  // Warnings: anything that isn't an outright blocker but
  // deserves a second look before going Live.
  const warnings = []
  const judgeCount = parseInt(ev.number_of_judges) || 0
  if (ev.event_type === 'synchro_pair' && judgeCount < 9) {
    warnings.push(
      `Synchro panel size is ${judgeCount}; the World Aquatics rule expects 9 or 11 to fill the Exec A / Exec B / Sync sub-panels.`,
    )
  }
  if (incompleteDivers.length) {
    const n = incompleteDivers.length
    warnings.push(
      `${n} diver${n === 1 ? ' has' : 's have'} an incomplete dive list (missing rounds or dive codes).`,
    )
  }
  if (!ev.dive_order_signed_off_at) {
    warnings.push('Referee sign-off is missing.')
  }
  if (judgePanel.value.length < judgeCount) {
    warnings.push(
      `Only ${judgePanel.value.length} of ${judgeCount} judge slots are filled.`,
    )
  }
  return {
    eventName: ev.name,
    eventType: ev.event_type === 'synchro_pair' ? 'Synchro Pair'
             : ev.event_type === 'team'         ? 'Team'
             : 'Individual',
    height: ev.height,
    rounds: totalRounds,
    judgeCount,
    ageGroup: ev.age_group,
    diverCount: divers.length,
    incompleteDivers: incompleteDivers.slice(0, 5), // cap so the modal stays compact
    incompleteOverflow: Math.max(0, incompleteDivers.length - 5),
    judges: judgePanel.value.slice(0, 11),          // already capped at 11 in practice
    refereeSignedOff: !!ev.dive_order_signed_off_at,
    warnings,
  }
})

async function startEvent() {
  if (!currentEvent.value) return
  // Open the pre-flight review instead of the bare native
  // confirm. The modal's "Go Live" button calls
  // commitStartEvent() once the operator has reviewed.
  preFlightOpen.value = true
}

async function commitStartEvent() {
  if (!currentEvent.value) return
  preFlightOpen.value = false
  const evName = currentEvent.value.name
  orderBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${currentEvent.value.id}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Live' }),
    })
    patchCurrentEvent({ status: 'Live' })
    showSuccess(`"${evName}" is Live — scoreboards broadcasting.`)
  } catch (err) {
    showError(`Failed to start "${evName}": ${err.message}`)
  } finally {
    orderBusy.value = false
  }
}

async function resetDiveOrderWorkflow() {
  if (!currentEvent.value) return
  if (!await confirmAction({
    title: 'Reset pre-meet workflow?',
    body:  `Walk the four pre-meet steps again for "${currentEvent.value.name}".`,
    consequences: [
      'Check-in, randomise, and referee sign-off stamps will be cleared',
      'The roster + dive order itself stays intact — only the workflow stamps reset',
    ],
    confirmLabel: 'Reset workflow',
    confirmKind:  'warn',
  })) return
  orderBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${currentEvent.value.id}/dive-order/reset`, {
      method: 'POST',
    })
    patchCurrentEvent({
      check_in_done_at:        null,
      dive_order_randomised_at: null,
      dive_order_signed_off_at: null,
      dive_order_signed_off_by: null,
    })
  } catch (err) {
    showError('Reset failed: ' + err.message)
  } finally {
    orderBusy.value = false
  }
}

// State 1 click handler. Doesn't stamp on click — opens the
// check-in modal so the operator can mark each diver. The
// modal's "Confirm Check-in Complete" footer button (see
// confirmCheckInComplete below) is what stamps check_in_done_at
// and advances the workflow to state 2.
function startCheckInStep() {
  openCheckIn()
}

async function confirmCheckInComplete() {
  if (!currentEvent.value) return
  // Friendly nudge if no diver has been ticked off yet — the
  // operator can still proceed, but they're advancing on an
  // empty list which is usually a mistake.
  const anyMarked = (checkInRows.value || []).some(r => r.status)
  if (!anyMarked && !confirm(
    `No divers have been marked yet for "${currentEvent.value.name}". ` +
    `Confirm check-in complete anyway?`
  )) return
  orderBusy.value = true
  try {
    const r = await auth.apiFetch(`/api/events/${currentEvent.value.id}/check-in/confirm`, {
      method: 'POST',
    })
    patchCurrentEvent({
      check_in_done_at: r.check_in_done_at || new Date().toISOString(),
    })
    closeCheckIn()
  } catch (err) {
    showError('Failed to advance workflow: ' + err.message)
  } finally {
    orderBusy.value = false
  }
}

// =========================================================
// DRAG-AND-DROP REORDER — HTML5 drag/drop, falls back to the
// existing ▲/▼ arrows for keyboard / accessibility users. On
// drop we compute fresh display_order values for the entire
// round and persist them in a single bulk-reorder call.
// =========================================================
const dragRosterIdx = ref(null)
const dragOverRosterIdx = ref(null)

function onRosterDragStart(originalIdx, ev) {
  // Cancel the drag entirely if the queue is locked. preventDefault
  // here stops the browser from initiating the drag UI.
  if (!canReorderQueue.value) {
    ev.preventDefault?.()
    return
  }
  dragRosterIdx.value = originalIdx
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = 'move'
    try { ev.dataTransfer.setData('text/plain', String(originalIdx)) } catch { /* noop */ }
  }
}
function onRosterDragOver(originalIdx, ev) {
  if (dragRosterIdx.value == null) return
  // Only allow drop on rows in the same round
  const src = roster.value[dragRosterIdx.value]
  const tgt = roster.value[originalIdx]
  if (!src || !tgt || src.round_number !== tgt.round_number) return
  ev.preventDefault()
  dragOverRosterIdx.value = originalIdx
}
function onRosterDragLeave(originalIdx) {
  if (dragOverRosterIdx.value === originalIdx) dragOverRosterIdx.value = null
}
function onRosterDragEnd() {
  dragRosterIdx.value = null
  dragOverRosterIdx.value = null
}
async function onRosterDrop(originalIdx, ev) {
  ev.preventDefault()
  const from = dragRosterIdx.value
  dragRosterIdx.value = null
  dragOverRosterIdx.value = null
  if (from == null || from === originalIdx) return
  const src = roster.value[from]
  const tgt = roster.value[originalIdx]
  if (!src || !tgt || src.round_number !== tgt.round_number) return

  // Move src to tgt's slot in the local array (optimistic).
  const before = roster.value.slice()
  const moved = roster.value.splice(from, 1)[0]
  roster.value.splice(originalIdx, 0, moved)
  // Track currentIndex through the move so the active diver
  // pointer doesn't break.
  if (currentIndex.value === from) currentIndex.value = originalIdx
  else if (from < currentIndex.value && currentIndex.value <= originalIdx) currentIndex.value--
  else if (originalIdx <= currentIndex.value && currentIndex.value < from) currentIndex.value++

  // Recompute display_order for every row in the affected round.
  // We send all rounds' rows in a single bulk-reorder call so
  // the wire format is uniform and the server can be dumb.
  const round = src.round_number
  const rowsInRound = roster.value
    .map((r, i) => ({ row: r, idx: i }))
    .filter(p => p.row.round_number === round)
  const payload = rowsInRound.map((p, position) => ({
    id: p.row.dive_list_id,
    display_order: position,
  }))
  // Mirror locally too so a future re-render doesn't reorder.
  for (let i = 0; i < rowsInRound.length; i++) {
    rowsInRound[i].row.display_order = i
  }
  try {
    await auth.apiFetch(`/api/events/${currentEvent.value.id}/dive-lists/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ rows: payload }),
    })
  } catch (err) {
    showError('Failed to save order: ' + err.message)
    roster.value = before
  }
}

// Move a roster entry up or down within its round. Recomputes
// display_order locally first (optimistic) then persists. We
// pick a value halfway between the new neighbours so subsequent
// drags don't have to renumber the whole round.
async function reorderRosterRow(idx, dir) {
  if (!canReorderQueue.value) return
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
    showError('Failed to save order: ' + err.message)
    // Revert local swap on failure
    roster.value[idx] = cur
    roster.value[targetIdx] = target
  }
}

async function withdrawRosterRow(idx) {
  const row = roster.value[idx]
  if (!row) return
  const willWithdraw = !row.withdrawn_at
  // No confirm() dialog — fires immediately + offers Undo via
  // the snackbar. The reverse op is just calling the same
  // endpoint with the opposite withdrawn flag, so a misclick
  // is one tap away from being recovered without an admin.
  try {
    await auth.apiFetch(`/api/dive-lists/${row.dive_list_id}/withdraw`, {
      method: 'PUT', body: JSON.stringify({ withdrawn: willWithdraw }),
    })
    row.withdrawn_at = willWithdraw ? new Date().toISOString() : null
    // If the active diver got withdrawn, advance past them.
    if (willWithdraw && currentIndex.value === idx) {
      const next = roster.value.findIndex((r, i) => i > idx && !r.withdrawn_at)
      if (next >= 0) setActive(next)
    }
    showUndo({
      message: willWithdraw
        ? `Withdrew ${row.full_name} from round ${row.round_number}`
        : `Reinstated ${row.full_name} in round ${row.round_number}`,
      onUndo: async () => {
        await auth.apiFetch(`/api/dive-lists/${row.dive_list_id}/withdraw`, {
          method: 'PUT', body: JSON.stringify({ withdrawn: !willWithdraw }),
        })
        row.withdrawn_at = !willWithdraw ? new Date().toISOString() : null
      },
    })
  } catch (err) {
    showError('Failed: ' + err.message)
  }
}

// =============================================================
// LATE ENTRY — manager adds a diver from the Control Room.
//
// A late-arriving diver still has to compete every round of the
// event, so the modal asks for ALL rounds at once (matching the
// pattern in CompetitorView's submit-list flow). Each round gets
// an autocomplete input that accepts the full code+position
// concatenated (e.g. "5132D") — fast for an operator who knows
// the codes by heart, and validates against the dive directory at
// the event's height before the submit fires.
// =============================================================
const lateOpen = ref(false)
const lateBusy = ref(false)
const lateErr = ref('')
const lateDivers  = ref([])          // candidate divers in the org
const lateDiveDir = ref([])          // full dive directory (filtered to height in lateDiveOptions)
const latePartnerId = ref('')        // synchro-pair only
const lateTeamId    = ref('')        // team events only
const lateTeams     = ref([])        // teams enrolled in the event

// One slot per round. Each slot holds the typed input string
// (`text`) and the resolved dive directory entry (`dive`, may be
// null until the input matches a known code+position).
const lateRounds = ref([])
const lateActiveSlot = ref(-1)        // which slot's autocomplete dropdown is open

// =============================================================
// CHECK-IN PANEL (#2 from the feature roadmap)
// Pre-meet door pass: each unique diver in the event gets a
// Present / Late / DNS chip. Reduces start delays and lets the
// announcer call divers who are confirmed on the deck.
// =============================================================
const checkInOpen = ref(false)
const checkInRows = ref([])
const checkInLoading = ref(false)
const checkInErr = ref('')

async function openCheckIn() {
  if (!currentEvent.value) return
  checkInOpen.value = true
  await refreshCheckIn()
}
function closeCheckIn() { checkInOpen.value = false }

async function refreshCheckIn() {
  if (!currentEvent.value) return
  checkInLoading.value = true
  checkInErr.value = ''
  try {
    checkInRows.value = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/attendance`,
    )
  } catch (err) {
    checkInErr.value = err.message
    checkInRows.value = []
  } finally {
    checkInLoading.value = false
  }
}

// Set a diver's status. Optimistic — we update the local row
// then fire the PUT; on failure we revert and surface the error.
async function setAttendance(row, status) {
  const prev = row.status
  // Toggle: clicking the same chip twice clears the status.
  const next = prev === status ? null : status
  row.status = next
  try {
    const r = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/attendance/${row.competitor_id}`,
      { method: 'PUT', body: JSON.stringify({ status: next }) },
    )
    row.status = r.status   // server is source of truth
    row.set_at = r.set_at
  } catch (err) {
    row.status = prev
    checkInErr.value = err.message
  }
}

const checkInCounts = computed(() => {
  const out = { present: 0, late: 0, absent: 0, pending: 0 }
  for (const r of checkInRows.value) {
    if (r.status === 'present')      out.present++
    else if (r.status === 'late')    out.late++
    else if (r.status === 'absent')  out.absent++
    else                              out.pending++
  }
  return out
})

async function openLateEntry() {
  lateErr.value = ''
  lateBusy.value = false
  latePartnerId.value = ''
  lateTeamId.value = ''
  lateActiveSlot.value = -1
  // Build N empty slots based on the event's total_rounds. Default
  // to 6 if the event metadata hasn't loaded yet (rare).
  const totalRounds = Number(currentEvent.value?.total_rounds) || 6
  lateRounds.value = Array.from({ length: totalRounds }, () => ({ text: '', dive: null, competitorId: '' }))
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
  // Teams enrolled in this event — only used when event_type === 'team'
  if (currentEvent.value?.event_type === 'team' && !lateTeams.value.length) {
    try {
      lateTeams.value = await auth.apiFetch(`/api/events/${currentEvent.value.id}/teams`)
    } catch { lateTeams.value = [] }
  }
}

// The diver shown in the picker. Stored at the form level rather
// than per-round because all rounds belong to the same diver.
const lateCompetitorId = ref('')

// Dive directory filtered to the event's height. Re-used by every
// round's autocomplete; matching is on `dive_code + position` so
// "5132D" finds the dive even when the user hasn't typed a space.
const lateDiveOptions = computed(() => {
  const eventHeight = currentEvent.value?.height
  const heightNumeric = eventHeight ? parseFloat(eventHeight) : null
  return lateDiveDir.value.filter(d =>
    heightNumeric === null || parseFloat(d.height) === heightNumeric,
  )
})

// Autocomplete results for a single round's input. Caps at 8 so
// the dropdown never overflows the modal. Empty input = empty list.
function lateMatchesFor(idx) {
  const term = (lateRounds.value[idx]?.text || '').toLowerCase().trim()
  if (!term) return []
  return lateDiveOptions.value.filter(d => {
    const combined = (d.dive_code + d.position).toLowerCase()
    return combined.includes(term) || (d.description || '').toLowerCase().includes(term)
  }).slice(0, 8)
}

// Try to resolve the typed text directly against the directory
// (no dropdown needed). Used when the user tabs out — if they
// typed exactly "5132D" we silently lock it in. Returns the dive
// or null.
function resolveTypedDive(text) {
  if (!text) return null
  const norm = text.toUpperCase().trim()
  // Match against (dive_code + position) concatenated, OR just
  // dive_code if position is empty (rare for diving).
  return lateDiveOptions.value.find(d =>
    (d.dive_code + d.position).toUpperCase() === norm,
  ) || null
}

function lateOnInput(idx) {
  // Open this row's dropdown; close any other.
  lateActiveSlot.value = idx
  // If the typed text matches an entry exactly, lock it in. The
  // dropdown still shows in case the operator wants to pick a
  // similar one, but submit will already work.
  const slot = lateRounds.value[idx]
  slot.dive = resolveTypedDive(slot.text)
}

function latePickDive(idx, dive) {
  lateRounds.value[idx].dive = dive
  lateRounds.value[idx].text = `${dive.dive_code}${dive.position}`
  lateActiveSlot.value = -1
  // Move focus to the next empty round if there is one — fast
  // entry workflow for the operator typing through a list.
  const nextIdx = lateRounds.value.findIndex((s, i) => i > idx && !s.dive)
  if (nextIdx >= 0) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`#late-round-${nextIdx}`)
      if (el) el.focus()
    })
  }
}

function lateCloseDropdown(idx) {
  // setTimeout so a click on a result registers before blur tears
  // down the dropdown.
  setTimeout(() => {
    if (lateActiveSlot.value === idx) lateActiveSlot.value = -1
  }, 150)
}

const lateAllFilled = computed(() =>
  lateRounds.value.length > 0 && lateRounds.value.every(s => !!s.dive),
)
const lateTotalDD = computed(() =>
  lateRounds.value.reduce((sum, s) => sum + (s.dive ? Number(s.dive.dd) : 0), 0).toFixed(1),
)

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
// Operator toggle for the standings + projection panel. Persisted
// in localStorage so the controller's preference survives reload.
// The public scoreboard is unaffected — this only hides the panel
// inside the Control Room.
const SHOW_STANDINGS_KEY = 'dr.controlRoom.showStandings'
// Default to COLLAPSED — only the operators who explicitly want
// the Top 5 + catch-up math always in view will have flipped
// the localStorage flag. The catch-up math is also visible on
// the audience-facing scoreboard, so the operator's view doesn't
// HAVE to carry it; collapsed-by-default reduces the right
// column's resting noise level.
const showStandingsProjection = ref(
  (typeof localStorage !== 'undefined'
    ? localStorage.getItem(SHOW_STANDINGS_KEY)
    : null) === '1',
)
function toggleStandingsProjection() {
  showStandingsProjection.value = !showStandingsProjection.value
  try { localStorage.setItem(SHOW_STANDINGS_KEY, showStandingsProjection.value ? '1' : '0') }
  catch { /* private mode etc. — silent fail */ }
}

// Compressed-layout overflow menus — see the LAYOUT COMPRESSION
// pass below for the rationale (offload secondary chrome from
// the always-visible canvas). Each is a simple ref + a small
// outside-click handler that closes when the user clicks
// anywhere off the menu's wrapper.
const headerMenuOpen  = ref(false)   // Hold / Broadcast / Dashboard
const adjustMenuOpen  = ref(false)   // Failed Dive / Cap Score / Re-Dive
const autoNextMenuOpen = ref(false)  // Auto-next: Manual / 5s / 10s / …
const kbdHintsOpen    = ref(false)   // ? popover with all shortcuts
function closeOverflowMenus() {
  headerMenuOpen.value = false
  adjustMenuOpen.value = false
  autoNextMenuOpen.value = false
  kbdHintsOpen.value = false
}
// Toggle the named menu and close all the others — only one
// overflow popover open at a time keeps the canvas predictable.
function toggleMenu(which) {
  const map = {
    header:   headerMenuOpen,
    adjust:   adjustMenuOpen,
    autonext: autoNextMenuOpen,
    kbd:      kbdHintsOpen,
  }
  const target = map[which]
  if (!target) return
  const next = !target.value
  closeOverflowMenus()
  target.value = next
}
function onGlobalClick(e) {
  // Close any open overflow menu when the click is outside any
  // element with .dropdown-host. The menu's own toggle button
  // does its own state flip; we just defer to that.
  if (!e.target.closest?.('.dropdown-host')) closeOverflowMenus()
}

async function refreshStandingsPreview() {
  if (!currentEvent.value) return
  try {
    const data = await auth.apiFetch(`/api/scoreboard/${currentEvent.value.id}`)
    // Keep all standings rows so the projection logic can find the
    // active diver even if they're outside the top 5.
    standingsPreview.value = data.standings || []
  } catch { standingsPreview.value = [] }
}

// Top 5 visible rows — derived so the panel keeps the existing
// rendering shape while the full standings array drives the
// projection logic.
const standingsTop5 = computed(() => standingsPreview.value.slice(0, 5))

// Reserves panel state (migration 040 + DD 9.1 / 9.2 reserve
// replacement). Loaded from /api/events/:id/reserves on event
// change + after each promote. Operator picks a withdrawn or
// active primary to replace from the per-row dropdown — the
// reserve inherits that primary's display_order so the dive
// sequence stays intact.
const reserves            = ref([])
const reservesWithdrawn   = ref([])
const reservesActive      = ref([])
const reservesOpen        = ref(true)
const reservesPromoting   = ref(null)   // competitor_id mid-flight
const reservesReplaceChoice = ref({})   // competitor_id → replaces_id

async function loadReserves() {
  if (!currentEvent.value) {
    reserves.value = []
    reservesWithdrawn.value = []
    reservesActive.value = []
    return
  }
  try {
    const r = await auth.apiFetch(`/api/events/${currentEvent.value.id}/reserves`)
    reserves.value          = Array.isArray(r.reserves)  ? r.reserves  : []
    reservesWithdrawn.value = Array.isArray(r.withdrawn) ? r.withdrawn : []
    reservesActive.value    = Array.isArray(r.active)    ? r.active    : []
  } catch {
    reserves.value = []
    reservesWithdrawn.value = []
    reservesActive.value = []
  }
}

async function promoteReserve(competitorId) {
  if (!currentEvent.value) return
  reservesPromoting.value = competitorId
  try {
    const replaces = reservesReplaceChoice.value[competitorId] || null
    const result = await auth.apiFetch(
      `/api/events/${currentEvent.value.id}/reserves/${competitorId}/promote`,
      {
        method: 'POST',
        body: JSON.stringify(replaces ? { replaces_competitor_id: replaces } : {}),
      },
    )
    if (result.replaced_name) {
      showSuccess(`Promoted reserve to slot #${result.display_order}, replacing ${result.replaced_name}.`)
    } else {
      showSuccess(`Promoted reserve to slot #${result.display_order}.`)
    }
    delete reservesReplaceChoice.value[competitorId]
    // Refresh reserves + the active roster (the dive-order +
    // queue both need to pick up the new display_order).
    await loadReserves()
    await onEventChange()
  } catch (err) {
    showError(`Failed to promote: ${err.message}`)
  } finally {
    reservesPromoting.value = null
  }
}

// "Anna Smith & Bella Jones" for a synchro pair, just the lead's
// full name otherwise. Used everywhere a standings row needs a
// human-readable label so synchro pairs aren't represented by
// only one of their names.
function pairLabel(row) {
  if (!row) return ''
  if (row.partner_name) return `${row.full_name} & ${row.partner_name}`
  return row.full_name || ''
}

// Effective "judges that contribute to the dive total" count for
// the current panel. Drives the per-dive max contribution when
// every judge gives the same score X. For individual events this
// is just the post-trim kept count. For synchro 9 / 11 the
// rescale that calc_event_dive_points applies (3 / kept_in_group)
// reduces every panel size to a 9-equivalent.
function panelMultiplier(numJudges, isSynchro) {
  if (isSynchro) return 9
  const drop = trimCount(numJudges)
  return Math.max(1, (parseInt(numJudges) || 5) - 2 * drop)
}

// Catch-up panel — replaces the old "+N pts; #/dive (~#/judge)"
// blob with a target-by-target table:
//
//   Catch-up — 4 dives left
//   1st (Anna Smith & Bella Jones)    avg 8.5
//   2nd (Carla Doe & Eve Smith)       avg 7.2
//   3rd (Felix Liu)                   avg 6.0
//
// When even all-10s would not catch a target the row reads
// "Not possible — even straight 10s falls short". For the leader
// the table flips to "would need to overtake you" framed at #2's
// avg score.
const projectedLine = computed(() => {
  const active = currentActive.value
  const standings = standingsPreview.value
  if (!active || !standings.length) return null

  // Primary match: the per-event public_id hash. See earlier
  // comment for the matching fallback chain.
  const activePublic =
    (active.event_type === 'team' && active.team_public_id) ||
    active.public_id ||
    null
  let idx = -1
  if (activePublic) {
    idx = standings.findIndex(s => s.public_id === activePublic)
  }
  if (idx === -1) {
    const matchKey = (s) =>
      `${s.full_name || ''}|${s.country_code || ''}|${s.partner_name || ''}`
    const activeKey = matchKey({
      full_name: active.full_name,
      country_code: active.country_code,
      partner_name: active.partner_name,
    })
    idx = standings.findIndex(s => matchKey(s) === activeKey)
  }

  const leader = standings[0]
  if (!leader) return null
  if (idx === -1) {
    return {
      kind: 'pre',
      activeName: pairLabel({ full_name: active.full_name, partner_name: active.partner_name }),
      leaderName: pairLabel(leader),
      leaderTotal: Number(leader.total || 0),
    }
  }

  const me = standings[idx]
  const myTotal = Number(me.total || 0)
  const totalRounds = parseInt(currentEvent.value?.total_rounds) || 0
  const numJudges  = parseInt(currentEvent.value?.number_of_judges) || 5
  const isSynchro  = currentEvent.value?.event_type === 'synchro_pair'
  const ddProxy    = parseFloat(active.dd) || null
  const remaining  = totalRounds
    ? totalRounds - (parseInt(active.round_number) || 1) + 1
    : 0
  const mult = panelMultiplier(numJudges, isSynchro)

  // Average judge score X needed across `remaining` dives, given
  // the points gap and a DD proxy. Returns null when remaining/DD
  // are unavailable — the table row will fall back to a points
  // figure only.
  //
  // Derivation: per-dive contribution if every judge scores X is
  // X × mult × DD. So gap G across R dives at avg DD D solves to
  // X = G / (mult × D × R). 10 is the ceiling — any X > 10 means
  // even straight 10s wouldn't close the gap.
  //
  // The displayed value rounds UP to the next 0.5 — judges score
  // in half-point increments, so rounding to one decimal would
  // suggest unattainable targets like 5.2. The smallest achievable
  // panel-wide average that mathematically guarantees closing the
  // gap is `Math.ceil(x * 2) / 2`. The `possible` flag still
  // checks the raw x against 10 so a raw of 9.6 (rounds to 10.0
  // — straight 10s, achievable) doesn't flip to "not possible".
  function avgJudgeForGap(gap) {
    if (gap <= 0)              return { score: 0,    possible: true  }
    if (remaining <= 0 || !ddProxy) return { score: null, possible: null  }
    const raw = gap / (mult * ddProxy * remaining)
    const rounded = Math.ceil(raw * 2) / 2
    return { score: rounded, possible: raw <= 10 }
  }

  // Self-referential preface for both kinds.
  const myLabel = pairLabel(me)

  if (idx === 0) {
    // Active diver is leading. Build the chase view from #2's
    // perspective — what they'd need to overtake. If there's no
    // #2, surface the unopposed cue.
    const second = standings[1]
    if (!second) {
      return { kind: 'unopposed', activeName: myLabel }
    }
    const gap = myTotal - Number(second.total || 0)
    const { score, possible } = avgJudgeForGap(gap)
    return {
      kind: 'lead',
      activeName: myLabel,
      runnerUp: pairLabel(second),
      gap,
      remaining,
      avgJudge: score,
      possible,
    }
  }

  // Active diver is chasing. Build a target row for every rank
  // strictly above them — capped to 1st / 2nd / 3rd because rows
  // beyond that aren't podium-relevant and the panel gets dense.
  const targets = []
  const targetRanks = [0, 1, 2].filter(r => r < idx)
  for (const r of targetRanks) {
    const opponent = standings[r]
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
// UP NEXT (right-panel hero) — the next divers in roster
// order, starting AFTER the currently-active diver. Withdrawn
// rows are excluded so the operator never queues a scratched
// diver into a "next" slot.
//
// Resting view shows the next 3; click "Show N more ↓"
// (rendered INSIDE the list after the 3rd row) to expand to
// the full set. The same anchored-toggle pattern the history
// columns + scoreboard Up Next use, so the button doesn't
// jump down off the operator's eye-line on click.
//
// Drives the panel that replaces the old Diver Queue as the
// primary right-panel surface; the full searchable roster lives
// in a collapsed-by-default "Dive Order" panel underneath.
// =============================================================
const UP_NEXT_DEFAULT_LIMIT = 3
const upNextShowAll = ref(false)
const upNextDives = computed(() => {
  if (!roster.value.length) return []
  // Start one past the active row. When no row is active (pre-
  // meet, or just after a randomise), start from the beginning.
  const start = currentIndex.value >= 0 ? currentIndex.value + 1 : 0
  const tail = []
  for (let i = start; i < roster.value.length; i++) {
    if (roster.value[i].withdrawn_at) continue
    tail.push({ ...roster.value[i], originalIdx: i })
    if (!upNextShowAll.value && tail.length >= UP_NEXT_DEFAULT_LIMIT) break
  }
  return tail
})

// Total non-withdrawn dives still ahead — drives the "Show all
// (N)" copy on the toggle so the operator knows how much they're
// expanding into.
const upNextTotal = computed(() => {
  if (!roster.value.length) return 0
  const start = currentIndex.value >= 0 ? currentIndex.value + 1 : 0
  let n = 0
  for (let i = start; i < roster.value.length; i++) {
    if (!roster.value[i].withdrawn_at) n++
  }
  return n
})

// Collapsed-by-default "Dive Order" panel — holds the search +
// round chips + reorderable roster that used to live at the top
// of the right panel. Operators only need it during pre-meet
// setup or for a manual jump; live scoring leans on Up Next.
const diveOrderOpen = ref(false)

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

// Compressed-layout pass: only the most-recent 3 cards show
// at rest; the operator clicks "Show more" to expand. The full
// list is one click away but the resting left column stays a
// short, scannable strip. The audience-facing scoreboard
// uses a slightly larger 5-card preview because spectators
// can't fall back on memory of "what just happened" the way
// the operator can. Reset on filter change so a "View all"
// expansion doesn't carry over to a freshly filtered view.
// historyPreview / historyRest split: the toggle button sits
// AFTER the preview cards, with the rest dropping down BELOW
// the button when expanded. Without this split, clicking the
// button would push it down off the user's eye line as the
// list grew.
const HISTORY_PREVIEW_COUNT = 3
const historyShowAll = ref(false)
const historyPreview = computed(() =>
  filteredHistory.value.slice(0, HISTORY_PREVIEW_COUNT),
)
const historyRest = computed(() =>
  filteredHistory.value.slice(HISTORY_PREVIEW_COUNT),
)
watch([historyDiverFilter, historyRoundFilter], () => {
  historyShowAll.value = false
})

const historyDivers = computed(() => {
  const set = new Set(historyCards.value.map(h => h.name))
  return [...set].sort()
})

async function submitLateEntry() {
  lateErr.value = ''
  if (!lateCompetitorId.value) { lateErr.value = 'Pick a diver'; return }

  // Re-resolve any rows where the operator typed but didn't click
  // a result — gives them one last chance before we error.
  for (const slot of lateRounds.value) {
    if (!slot.dive && slot.text) slot.dive = resolveTypedDive(slot.text)
  }
  const missing = lateRounds.value
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => !s.dive)
  if (missing.length) {
    lateErr.value = `Missing dive for round${missing.length > 1 ? 's' : ''} ` +
      missing.map(m => m.i + 1).join(', ')
    return
  }
  // Synchro events need a partner; team events need a team.
  if (currentEvent.value?.event_type === 'synchro_pair' && !latePartnerId.value) {
    lateErr.value = 'Synchronised events need a partner.'
    return
  }
  if (currentEvent.value?.event_type === 'team' && !lateTeamId.value) {
    lateErr.value = 'Team events need a team.'
    return
  }

  lateBusy.value = true
  try {
    // POST one row per round. The endpoint upserts on
    // (event_id, competitor_id, round_number) so a re-run after
    // a partial failure is safe — the operator just clicks Add
    // again and we backfill the missing rows.
    for (let i = 0; i < lateRounds.value.length; i++) {
      const slot = lateRounds.value[i]
      await auth.apiFetch(`/api/events/${currentEvent.value.id}/roster`, {
        method: 'POST',
        body: JSON.stringify({
          competitor_id: lateCompetitorId.value,
          dive_id:       slot.dive.id,
          round_number:  i + 1,
          partner_id:    latePartnerId.value || null,
          team_id:       lateTeamId.value    || null,
        }),
      })
    }
    // Re-pull roster so the new rows appear in the queue with
    // their dive_list_ids and display order.
    const fresh = await auth.apiFetch(`/api/events/${currentEvent.value.id}/roster`)
    roster.value = fresh
    lateOpen.value = false
  } catch (err) {
    lateErr.value = err.message
  } finally {
    lateBusy.value = false
  }
}

// Connection state is exposed by the composable as
// socket.isConnected — no parallel listeners here.

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
      club_name: currentActive.value.club_name,
      club_code: currentActive.value.club_code,
      partner_name: currentActive.value.partner_name,
      partner_country: currentActive.value.partner_country,
      team_name: currentActive.value.team_name,
      team_code: currentActive.value.team_code,
      competitor_id: currentActive.value.competitor_id,
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
    // of the round. detectRoundEnd surfaces a prompt if so —
    // it'll also kick off the auto-advance timer for the round-
    // end announcement (see watcher on roundEndPromptOpen).
    detectRoundEnd(currentActive.value.round_number)
    // Refresh the inline standings preview so the operator
    // sees totals shift as dives complete.
    refreshStandingsPreview()
    // Auto-advance: only kick off the timer if we're NOT at a
    // round-end (the round-end modal owns that flow) and NOT
    // at the final dive (Finalise should always be a manual
    // confirm — auto-firing finalise would be destructive).
    if (!roundEndPromptOpen.value && !nextBtnComplete.value) {
      startAutoAdvance(nextDiver)
    }
  }
})

socket.on('live_result_calculated', (data) => {
  addHistoryCard(data)
  resetJudgeTiles()
})

// judge_signal — judge tapped "Signal Referee" on their
// keypad (or tapped again to clear). Match to the active dive
// + judge_number, flip the tile's signaled flag. The tile
// renders a red ring when the flag is on.
socket.on('judge_signal', (data) => {
  if (!currentActive.value) return
  if (data.event_id      !== currentActive.value.event_id)      return
  if (data.competitor_id !== currentActive.value.competitor_id) return
  if (Number(data.round_number) !== Number(currentActive.value.round_number)) return
  const tile = judgeTiles.value.find(t => t.judgeIndex === parseInt(data.judge_number))
  if (tile) tile.signaled = !!data.signaled
})

function initJudgeTiles(n) {
  judgeTiles.value = []
  for (let i = 1; i <= n; i++) {
    // signaled flag → red ring on the tile when this judge has
    // tapped "Signal Referee" on their keypad. Cleared on every
    // setActive() / resetJudgeTiles() pass.
    judgeTiles.value.push({ judgeIndex: i, judgeId: null, score: '—', scored: false, signaled: false })
  }
}

function resetJudgeTiles() {
  judgeTiles.value.forEach(t => {
    t.scored = false
    t.judgeId = null
    t.score = '—'
    t.signaled = false
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
  const club_name = data.club_name || null
  const club_code = data.club_code || null
  // Synchro pair fields. Both the live card path (built from
  // currentActive.value when all judges submit) and the post-
  // refresh /history path carry these now, so the rendered
  // card surfaces both names + the partner's country in the
  // affiliation badge fallback.
  const partner_name = data.partner_name || null
  const partner_country = data.partner_country || null
  const team_name = data.team_name || null
  const team_code = data.team_code || null
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
    name, country,
    partner_name, partner_country,
    club_name, club_code,
    team_name, team_code,
    dive_code, position, dd, desc,
    round: data.round_number, total_rounds, scores, total,
    score_ids, event_id, competitor_id,
  })
}

function setActive(idx) {
  if (idx < 0 || idx >= roster.value.length) return
  // Any manual jump cancels an in-flight auto-advance — the
  // operator chose this diver, don't override them with the
  // timer.
  cancelAutoAdvance()
  currentIndex.value = idx
  currentActive.value = roster.value[idx]
  scoresThisRound.value = {}
  // Run the description through diveDescription so the position
  // word ("Pike", "Tuck", etc.) appends to the action — e.g.
  // "Forward Dive Pike" instead of just "Forward Dive". The
  // operator (and the broadcast feed) sees the full audience-
  // facing label without doing the mental composition.
  activeInfo.value = {
    name: currentActive.value.full_name,
    country: currentActive.value.country_code || null,
    code: `${currentActive.value.dive_code}${currentActive.value.position}`,
    dd: `DD ${currentActive.value.dd}`,
    desc: diveDescription(currentActive.value) || '—',
    team_name: currentActive.value.team_name || null,
    partner_name: currentActive.value.partner_name || null,
    partner_country: currentActive.value.partner_country || null,
    round_number: currentActive.value.round_number,
    // Club details — surfaced in the active-diver block so the
    // operator can verify identity at a glance and the audience
    // (via broadcast mode) sees who's representing whom.
    club_name: currentActive.value.club_name || null,
    club_code: currentActive.value.club_code || null,
  }
  socket.emit('set_active_diver', {
    ...currentActive.value,
    diverName: currentActive.value.full_name,
    country_code: currentActive.value.country_code || null,
    club_name: currentActive.value.club_name || null,
    club_code: currentActive.value.club_code || null,
    diveCode: `${currentActive.value.dive_code}${currentActive.value.position}`,
    // description is the dive_directory action ("Forward Dive",
    // "Back 2½ Somersaults", …); position is the World Aquatics letter
    // (A/B/C/D). Audience views recompose them via
    // diveDescription() — pass null instead of '—' for missing
    // values so the v-if hides the line cleanly when the row is
    // incomplete.
    description: currentActive.value.description || null,
    position:    currentActive.value.position    || null,
    // Profile-link IDs surfaced explicitly: the spectator
    // scoreboard wraps both diverName and partner_name in
    // /profile/<id> RouterLinks. The spread above already
    // carries these from the roster query, but listing them
    // by name documents the contract and survives any future
    // refactor that changes how currentActive is shaped.
    competitor_id: currentActive.value.competitor_id || null,
    partner_id:    currentActive.value.partner_id    || null,
    eventName: currentEvent.value?.name || '—',
  })
  resetJudgeTiles()
  updateNextButton(false)
  // Reset + auto-start the 30-second shot clock for this diver.
  // Operator can pause / extend if needed (warm-up, equipment).
  // activeStatus is a computed that derives off scoresThisRound +
  // shotClockExpired — both reset above, so the status falls
  // back to 'ready' on its own without an explicit assignment.
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
  // A referee action mid-countdown means the dive needs review
  // — kill the timer so the operator can finish what they're
  // doing without racing the auto-advance.
  cancelAutoAdvance()
  const payload = {
    event_id: currentActive.value.event_id,
    competitor_id: currentActive.value.competitor_id,
    round_number: currentActive.value.round_number,
  }
  if (type === 'failed') socket.emit('referee_failed_dive', payload)
  if (type === 'cap') socket.emit('referee_cap_scores', { ...payload, cap_value: 2.0 })
  if (type === 'redive') socket.emit('referee_redive', payload)
}

async function nextDiver() {
  // Cancel any in-flight auto-advance — whether the operator
  // clicked Next manually OR the timer fired, the timer needs
  // to be gone before setActive() so it doesn't race a fresh
  // countdown that's about to start for the next diver.
  cancelAutoAdvance()
  // Guard against accidental skip when scores are partial. Once
  // a referee action (cap, redive, failed) has fired, the next
  // button leaves "disabled" state — but the score map can be
  // incomplete. Require a confirm so a fat-fingered space-bar
  // doesn't lose data.
  const totalJudges = parseInt(currentEvent.value?.number_of_judges) || 0
  const scoresIn = Object.keys(scoresThisRound.value).length
  const partial = totalJudges > 0 && scoresIn > 0 && scoresIn < totalJudges
  if (!nextBtnComplete.value && partial) {
    if (!await confirmAction({
      title: 'Skip ahead with partial scores?',
      body: `Only ${scoresIn} of ${totalJudges} judges have submitted for this dive.`,
      consequences: [
        'The dive will close with whatever scores arrived',
        'Missing judges can still amend via score correction afterwards',
      ],
      confirmLabel: 'Move on',
      confirmKind: 'warn',
    })) return
  }
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
    case ' ':                 // space = advance — same muscle memory as a remote
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
    case 'h':
    case 'H':                 // hold / resume
      e.preventDefault()
      isHeld.value ? resumeMeet() : openHoldPrompt()
      break
    case 'r':
    case 'R':                 // re-dive
      e.preventDefault()
      refAction('redive')
      break
    case 'f':
    case 'F':                 // failed dive
      e.preventDefault()
      refAction('failed')
      break
    case 't':
    case 'T':                 // reset shot clock
      e.preventDefault()
      resetShotClock()
      break
    default:
      // Number keys 1-9 jump to roster position N (within
      // visible filtered roster, so search + jump compose).
      if (/^[1-9]$/.test(e.key)) {
        const n = parseInt(e.key, 10) - 1
        const target = filteredRoster.value[n]
        if (target) {
          e.preventDefault()
          setActive(target.originalIdx)
        }
      }
  }
}

async function showLeaderboard() {
  const data = await auth.apiFetch(`/api/scoreboard/${currentEvent.value.id}`)
  lbRows.value = data.standings || []
  lbShow.value = true
  socket.emit('announce_score', { standings: data.standings, eventId: currentEvent.value.id })
}

async function finaliseEvent() {
  if (!currentEvent.value) return
  const ev = currentEvent.value
  // Compose competitor count for the consequences text — N
  // unique non-withdrawn divers in the roster.
  const diverIds = new Set()
  for (const r of roster.value) {
    if (r.withdrawn_at) continue
    diverIds.add(r.competitor_id || r.diver_id || r.dive_list_id)
  }
  const n = diverIds.size
  if (!await confirmAction({
    title: 'Finalise event?',
    body:  `"${ev.name}" will flip to Completed and the recap publishes.`,
    consequences: [
      'Public scoreboard switches to recap mode (podium + full standings)',
      'Event lands in the public Results Archive',
      n ? `"Results posted" emails go out to ${n} competitor${n === 1 ? '' : 's'} (if SMTP is configured)` : '"Results posted" emails go out to every competitor (if SMTP is configured)',
      'Reversible by an org admin via Meet Manager → set status back to Live',
    ],
    confirmLabel: 'Finalise & publish',
    confirmKind:  'primary',
  })) return
  try {
    const evId = currentEvent.value.id
    const evName = currentEvent.value.name
    await auth.apiFetch(`/api/events/${evId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status: 'Completed' }),
    })
    currentEvent.value.status = 'Completed'
    // finaliseBtnText is computed off currentEvent.status, so
    // flipping the status above also flips the label to
    // "View Results" without an explicit assignment here.
    await showLeaderboard()
    // Offer an Undo. Finalising flips status Live → Completed,
    // which is fully reversible by an org admin via the same
    // status endpoint. Common misclick recovery — the operator
    // hits Finalise expecting "Next Diver" or vice versa.
    showUndo({
      message: `Finalised "${evName}" — results published.`,
      timeoutMs: 12000,
      onUndo: async () => {
        await auth.apiFetch(`/api/events/${evId}/status`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'Live' }),
        })
        if (currentEvent.value && currentEvent.value.id === evId) {
          currentEvent.value.status = 'Live'
          // Computed labels reset automatically — no manual
          // finaliseBtnText assignment needed here.
          lbShow.value = false
        }
      },
    })
  } catch (err) {
    showError('Failed to finalise: ' + err.message)
  }
}

async function onEventChange() {
  if (!selectedEventId.value) return
  // Modal/state reset — switching events shouldn't carry over
  // half-typed score corrections, an unconfirmed sign-off
  // dialog, or a stale round-end prompt from the prior event.
  // Each helper is a no-op when the modal isn't open.
  closeCorrection()
  if (typeof closeSignoffModal === 'function') closeSignoffModal()
  holdPromptOpen.value = false
  roundEndPromptOpen.value = false
  // Reset score-correction draft fields too — the modal is gone
  // but their refs would otherwise pre-populate the next dialog
  // with the previous event's score values.
  correctNewScore.value = ''
  correctReason.value = ''
  correctJudgeIdx.value = -1

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
  // Reserves panel — only meaningful on advanced events
  // (semi-final / final), but the endpoint just returns []
  // when none exist so we always call.
  loadReserves()

  ;[...histData].reverse().forEach(h => {
    addHistoryCard({
      diverName: h.diverName || h.full_name,
      country_code: h.country_code,
      club_name: h.club_name,
      club_code: h.club_code,
      partner_name: h.partner_name,
      partner_country: h.partner_country,
      team_name: h.team_name,
      team_code: h.team_code,
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
  // finaliseBtnShow / finaliseBtnText are now computed off
  // currentEvent.status + nextBtnComplete — no manual refresh
  // needed when the event changes.
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
  // Honour /control?event=<id> so deep-links from Meet Manager
  // (the per-event "Open Control Room" primary button) land on
  // the right event preselected, instead of dumping the
  // operator on the picker. Falls through silently if the id
  // doesn't match any event the caller can see.
  const preselectId = route.query.event
  if (preselectId && events.value.some(e => e.id === preselectId)) {
    selectedEventId.value = preselectId
    await onEventChange()
  }
  window.addEventListener('keydown', onKeydown)
  // Capture-phase mousedown so a click on the Adjust / kbd-? /
  // header-⋯ trigger fires its own toggle BEFORE this listener
  // sees the event and would otherwise close the menu it just
  // opened. The trigger buttons stop propagation explicitly.
  window.addEventListener('mousedown', onGlobalClick, true)
  // Cut 2 — listen for the server's response broadcast when the
  // referee taps Approve/Deny on their device. Lives on the same
  // event-room subscription the rest of the Control Room uses;
  // the manager's socket joins the room when an event is
  // selected via subscribe_event.
  socket.on('referee_signoff_response', onRefereeSignoffResponse)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousedown', onGlobalClick, true)
  cancelAutoAdvance()
  socket.off('referee_signoff_response', onRefereeSignoffResponse)
})
</script>

<template>
  <div :class="['ctrl-layout', opsBroadcast ? 'ctrl-broadcast' : '']">
    <!-- Floating exit out of operator broadcast mode. -->
    <RouterLink
      v-if="opsBroadcast"
      to="/control"
      class="ops-broadcast-exit"
      title="Exit broadcast mode"
    >✕</RouterLink>
    <!-- Header -->
    <div class="ctrl-header">
      <div style="display:flex;align-items:center;gap:1.5rem">
        <RouterLink to="/dashboard" class="app-logo" style="font-size:16px">DIVE<span>RECORDER</span></RouterLink>
        <select class="event-select-sm" v-model="selectedEventId" @change="onEventChange">
          <option value="">— Select Event —</option>
          <option v-for="ev in events" :key="ev.id" :value="ev.id">{{ ev.name }}</option>
        </select>
        <span class="conn-badge"
              :title="socket.isConnected.value
                ? 'Live socket connection healthy — score events are streaming in real time'
                : 'Re-establishing socket connection — incoming scores are queued until this turns green'">
          <span class="status-dot" :class="{ connected: socket.isConnected.value }"></span>
          <span>{{ socket.isConnected.value ? 'Connected' : 'Connecting' }}</span>
        </span>
      </div>
      <!-- Header context — meet name centred. Page-chrome
           secondary actions (Hold / Broadcast / Dashboard) move
           into the ⋯ overflow menu on the right so the resting
           header reads: logo · event picker · connection · meet
           · ⋯ · Finalise(when applicable). Hold gets a separate
           visible status pill when active so the operator can
           see at a glance the meet is paused without opening the
           menu. -->
      <div class="ctrl-header-ctx">
        <span class="ctx-meet">{{ meetName }}</span>
        <!-- Event status pill — same colour vocabulary as the
             dashboard pulse strip so an operator never has to
             ask "what stage is this in?". Hidden until an event
             is selected; the picker on the left is the prompt
             when none is. -->
        <StatusPill v-if="currentEvent?.status" :status="currentEvent.status" size="sm" />
      </div>
      <div class="ctrl-header-right">
        <!-- Hold-active glance pill: shows ONLY while held. Click
             resumes immediately; the rest of the time Hold is
             reachable via the ⋯ menu so the resting header isn't
             cluttered with a button the operator clicks ~once
             per meet. -->
        <button
          v-if="isHeld"
          class="btn-hold btn-hold-active"
          @click="resumeMeet"
          title="Resume the meet (H)"
        >▶ Resume</button>
        <!-- Overflow menu — secondary chrome that the operator
             touches infrequently. Clicking the ⋯ toggles a small
             popover; the global mousedown listener closes it on
             outside-click. Each item closes the menu after firing
             so a re-click opens, click-once-action closes. -->
        <div class="dropdown-host header-menu-host">
          <button
            class="btn-back btn-icon"
            @click.stop="toggleMenu('header')"
            :aria-expanded="headerMenuOpen"
            title="More actions"
          >⋯</button>
          <div v-if="headerMenuOpen" class="dropdown-menu header-menu">
            <button
              v-if="currentEvent && currentEvent.status !== 'Completed' && !isHeld"
              class="dropdown-item"
              @click="openHoldPrompt(); headerMenuOpen = false"
            >⏸ Hold meet</button>
            <RouterLink
              v-if="currentEvent && !opsBroadcast"
              to="/control?broadcast=1"
              class="dropdown-item"
              @click="headerMenuOpen = false"
            >📺 Broadcast mode</RouterLink>
            <!-- Finalise event early — only relevant during a
                 Live meet that hasn't reached its last dive. The
                 prominent header "Finalise Event ✓" button only
                 appears at the natural completion moment, but
                 occasionally an operator needs to cut a meet
                 short (postponement, equipment failure, safety).
                 Amber hover treatment so the operator pauses
                 before clicking; finaliseEvent() already wraps
                 the action in a confirm() dialog. -->
            <button
              v-if="finaliseEarlyVisible"
              class="dropdown-item dropdown-item-amber"
              @click="finaliseEvent(); headerMenuOpen = false"
              title="Finalise the meet now even though dives are still pending. Use sparingly — postponement, equipment failure, etc."
            >✓ Finalise event early…</button>
            <RouterLink to="/dashboard" class="dropdown-item"
                        @click="headerMenuOpen = false">← Dashboard</RouterLink>
          </div>
        </div>
        <button
          v-if="finaliseBtnShow"
          class="btn-finalise"
          :title="finaliseBtnTitle"
          @click="currentEvent?.status === 'Completed' ? showLeaderboard() : finaliseEvent()"
        >{{ finaliseBtnText }}</button>
      </div>
    </div>

    <!-- Hold banner — visible whenever the meet is on hold. -->
    <div v-if="isHeld" class="hold-banner">
      <span class="hold-pulse">⏸ MEET ON HOLD</span>
      <span v-if="holdReason" class="hold-reason">{{ holdReason }}</span>
    </div>

    <!-- Pre-flight review modal — final visual check before
         flipping the event Live. The four-step pre-meet stepper
         already verified the procedural prerequisites; this
         modal summarises the actual state (roster, panel,
         referee) plus any warnings worth a second look. -->
    <div v-if="preFlightOpen && preFlightSummary" class="lb-backdrop preflight-backdrop"
         @mousedown.self="preFlightOpen = false">
      <div class="preflight-modal" role="dialog" aria-modal="true" aria-labelledby="preflight-title">
        <div class="preflight-head">
          <div id="preflight-title" class="preflight-title">Pre-Flight Review</div>
          <div class="preflight-subtitle">{{ preFlightSummary.eventName }}</div>
        </div>

        <div class="preflight-grid">
          <div class="preflight-section">
            <div class="preflight-label">Event</div>
            <div class="preflight-row">
              <span class="preflight-pill">{{ preFlightSummary.eventType }}</span>
              <span v-if="preFlightSummary.height" class="preflight-pill">
                {{ preFlightSummary.height }}
              </span>
              <span v-if="preFlightSummary.ageGroup" class="preflight-pill">{{ preFlightSummary.ageGroup }}</span>
              <span class="preflight-pill">{{ preFlightSummary.rounds }} rounds</span>
            </div>
          </div>

          <div class="preflight-section">
            <div class="preflight-label">Roster</div>
            <div class="preflight-row preflight-strong">
              <span :class="['preflight-tick', preFlightSummary.diverCount ? 'ok' : 'warn']">
                {{ preFlightSummary.diverCount ? '✓' : '⚠' }}
              </span>
              {{ preFlightSummary.diverCount }} diver{{ preFlightSummary.diverCount === 1 ? '' : 's' }} checked in
            </div>
            <ul v-if="preFlightSummary.incompleteDivers.length" class="preflight-detail-list">
              <li v-for="d in preFlightSummary.incompleteDivers" :key="d.id">
                {{ d.name }} — {{ d.rows }} / {{ preFlightSummary.rounds }} rounds<span v-if="d.missingDive">, {{ d.missingDive }} dive code{{ d.missingDive === 1 ? '' : 's' }} missing</span>
              </li>
              <li v-if="preFlightSummary.incompleteOverflow" class="preflight-overflow">
                + {{ preFlightSummary.incompleteOverflow }} more
              </li>
            </ul>
          </div>

          <div class="preflight-section">
            <div class="preflight-label">Panel</div>
            <div class="preflight-row preflight-strong">
              <span :class="['preflight-tick', preFlightSummary.judges.length === preFlightSummary.judgeCount ? 'ok' : 'warn']">
                {{ preFlightSummary.judges.length === preFlightSummary.judgeCount ? '✓' : '⚠' }}
              </span>
              {{ preFlightSummary.judges.length }} of {{ preFlightSummary.judgeCount }} judges seated
            </div>
            <div v-if="preFlightSummary.judges.length" class="preflight-judges">
              <span v-for="(j, i) in preFlightSummary.judges" :key="j.id || j.user_id || i" class="preflight-judge-pill">
                J{{ i + 1 }} {{ (j.full_name || j.name || 'Judge').split(' ').slice(-1)[0] }}
              </span>
            </div>
          </div>

          <div class="preflight-section">
            <div class="preflight-label">Referee</div>
            <div class="preflight-row preflight-strong">
              <span :class="['preflight-tick', preFlightSummary.refereeSignedOff ? 'ok' : 'warn']">
                {{ preFlightSummary.refereeSignedOff ? '✓' : '⚠' }}
              </span>
              {{ preFlightSummary.refereeSignedOff ? 'Signed off' : 'Not signed off' }}
            </div>
          </div>
        </div>

        <div v-if="preFlightSummary.warnings.length" class="preflight-warnings">
          <div class="preflight-warnings-head">⚠ Worth a second look</div>
          <ul>
            <li v-for="(w, i) in preFlightSummary.warnings" :key="i">{{ w }}</li>
          </ul>
        </div>

        <div class="preflight-actions">
          <button type="button" class="btn btn-ghost preflight-cancel" @click="preFlightOpen = false">
            Not yet
          </button>
          <button type="button" class="btn btn-primary preflight-go" @click="commitStartEvent" :disabled="orderBusy">
            {{ orderBusy ? '▶ …' : '▶ Go Live' }}
          </button>
        </div>
      </div>
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
          <!-- Preview cards (always visible) + toggle button +
               rest cards (visible when expanded) — wrapped in
               a single v-for over either the preview or the
               full list, with the toggle injected after the
               (HISTORY_PREVIEW_COUNT)th card. This keeps the
               toggle anchored at a fixed visual position so a
               click expands the list DOWN-WARD rather than
               pushing the button off the operator's eye-line. -->
          <template v-for="(card, idx) in (historyShowAll ? filteredHistory : historyPreview)"
                    :key="card.score_ids?.[0] || `${card.competitor_id}-${card.round}`">
          <div
            :class="['hist-card', card.score_ids?.length ? 'hist-card-correctable' : '']"
            :title="card.score_ids?.length ? 'Click to amend a score' : ''"
            @click="card.score_ids?.length && openCorrection(card)"
          >
            <div class="hist-round">Round {{ card.round }}{{ card.total_rounds ? ` / ${card.total_rounds}` : '' }}</div>
            <!-- Shared identity block: lead + partner stacked at
                 equal weight for synchro, team / club secondary
                 line for non-synchro rows, country / team / club
                 chip pinned top-right, dive total slotted next to
                 it. The composable maps card.{name,partner_name,
                 country,team_code,club_code,team_name,club_name}
                 into the same shape every other surface uses. -->
            <DiverIdentity
              :row="{
                name: card.name,
                partner_name: card.partner_name,
                country_code: card.country,
                team_code: card.team_code,
                team_name: card.team_name,
                club_code: card.club_code,
                club_name: card.club_name,
              }"
              :rank="competitorOrder(card.competitor_id)"
              variant="split"
              class="hist-identity"
            >
              <template #trailing>
                <div class="hist-total">{{ card.total }}</div>
              </template>
            </DiverIdentity>
            <!-- Dive header line: code + DD + description on a
                 single row so the card is one line shorter and
                 the eye picks up "what was the dive" without
                 jumping. Description gets ellipsis on overflow
                 so a long name (e.g. "Inward 3½ Tuck") still
                 keeps the row to one line. -->
            <div class="hist-dive-line">
              <span class="hist-code">{{ card.dive_code ? `${card.dive_code}${card.position || ''}` : '—' }}</span>
              <span v-if="card.dd != null" class="hist-dd">DD {{ card.dd.toFixed(1) }}</span>
              <span v-if="card.desc" class="hist-desc">{{ card.desc }}</span>
            </div>
            <div v-if="card.scores.length" class="hist-scores">
              <!-- Synchro: group scores into Exec A / Exec B / Sync
                   using the same shared helper the Scoreboard view
                   uses. Falls back to flat chips for individual /
                   team events. -->
              <template v-if="isSynchroEvent">
                <div v-for="g in (groupedSynchroScoresForDisplay(card.scores.join(','), currentEvent?.number_of_judges) || [])"
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
                <span v-for="(s, si) in card.scores" :key="si" class="hist-score">{{ s.toFixed(1) }}</span>
              </template>
            </div>
          </div>
          <!-- Toggle button injected INSIDE the v-for, after the
               last preview card. Stays visually anchored when
               clicked: expanding renders the rest of the list
               BELOW the button rather than shoving the button
               down. Only renders when there are extra cards to
               reveal. Filter changes collapse via the watch. -->
          <button
            v-if="idx === HISTORY_PREVIEW_COUNT - 1
                  && filteredHistory.length > HISTORY_PREVIEW_COUNT"
            class="hist-toggle"
            @click.stop="historyShowAll = !historyShowAll"
          >
            {{ historyShowAll
                ? `Show fewer ↑`
                : `Show ${filteredHistory.length - HISTORY_PREVIEW_COUNT} more ↓` }}
          </button>
          </template>
        </div>
      </div>

      <!-- Centre: Active diver -->
      <div class="ctrl-centre">
        <!-- The Now / Next / On-deck strip used to live here as
             a quick-glance ribbon for the announcer. Removed —
             the right panel's Up Next list (next 5, expandable)
             plus the centre's own active-diver block carry the
             same information without duplicating the same names
             three different ways across two columns. -->
        <div class="active-zone">
          <!-- Compressed header strip — a single muted pre-line
               carrying the round + diver counters, with the
               shot-clock anchored to the right. Replaces the
               three-row stack of "Currently on Board" label +
               ctx pills + auto-next select + status pill +
               shot-clock that used to live here. The status
               pill folds into the diver name row below; the
               auto-next picker moves to a split-button on Next
               Diver where it's adjacent to the action it
               governs. -->
          <div v-if="currentActive || activeInfo.round_number" class="active-meta">
            <span class="active-meta-text">
              <span v-if="activeInfo.round_number">
                Round <strong>{{ activeInfo.round_number }}</strong> / {{ currentEvent?.total_rounds || '?' }}
              </span>
              <span v-if="roster.length" class="active-meta-sep">·</span>
              <span v-if="roster.length">
                Diver <strong>{{ currentIndex + 1 }}</strong> / {{ roster.length }}
              </span>
            </span>
            <div v-if="currentActive" :class="['shot-clock', shotClockClass]">
              <button class="shot-clock-face" @click="pauseShotClock"
                      :title="shotClockRunning
                        ? '30-second WA shot clock — click to pause'
                        : (shotClockExpired
                          ? 'Shot clock expired — diver should have begun by now'
                          : '30-second WA shot clock — click to resume')">
                <span class="shot-clock-num">{{ shotClock }}</span>
                <span class="shot-clock-unit">s</span>
              </button>
              <button class="shot-clock-reset" @click="resetShotClock" title="Reset to 30s (T)">↻</button>
            </div>
          </div>
          <!-- Referee-signal banner — appears the moment any
               judge taps Signal Referee on their keypad. Calls
               out which judges, halts auto-advance, sticks
               around until the judge submits a fresh score (or
               toggles their flag off). -->
          <div v-if="signalingJudges.length" class="referee-signal-banner">
            <div class="referee-signal-icon">🚩</div>
            <div class="referee-signal-body">
              <div class="referee-signal-title">Referee Signal</div>
              <div class="referee-signal-judges">
                <template v-if="signalingJudges.length === 1">
                  Judge {{ signalingJudges[0] }} flagged the referee — auto-advance paused.
                </template>
                <template v-else>
                  Judges {{ signalingJudges.join(', ') }} flagged the referee — auto-advance paused.
                </template>
              </div>
              <div class="referee-signal-hint">
                Resolves when the judge submits a fresh score.
              </div>
            </div>
          </div>

          <div class="active-name">
            <!-- Diver's start-order number ("1.") prefixes the
                 name so the operator sees their canonical
                 position at a glance — same number that shows on
                 the roster queue and the completed-dives cards.
                 The status pill (READY / DIVING / JUDGING) sits
                 inline at the end of the name row rather than in
                 a separate top-bar widget — keeps every piece
                 of "what's happening with this diver right now"
                 on one line. -->
            <span v-if="competitorOrder(currentActive?.competitor_id) != null" class="active-order">{{ competitorOrder(currentActive.competitor_id) }}.</span>
            <template v-if="activeInfo.partner_name">
              {{ activeInfo.name }}<span v-if="activeInfo.country" class="active-country">{{ activeInfo.country }}</span>
              <span class="active-amp">&amp;</span>
              {{ activeInfo.partner_name }}<span v-if="activeInfo.partner_country" class="active-country">{{ activeInfo.partner_country }}</span>
            </template>
            <template v-else>
              {{ activeInfo.name }}<span v-if="activeInfo.country" class="active-country">{{ activeInfo.country }}</span>
            </template>
            <span
              v-if="currentActive"
              :class="['status-pill', `status-${activeStatus}`, 'status-pill-inline']"
              :title="activeStatus === 'ready'
                ? 'READY — diver is on the board, shot clock running. Auto-advances to DIVING when the clock expires.'
                : activeStatus === 'diving'
                ? 'DIVING — shot clock has expired, the dive is happening. Auto-advances to JUDGING when the first score lands.'
                : 'JUDGING — the panel is scoring. Stays here until the next diver is set.'"
            >
              {{ activeStatus.toUpperCase() }}
            </span>
          </div>
          <div v-if="activeInfo.team_name" class="active-team">{{ activeInfo.team_name }}</div>
          <!-- Club affiliation. Hidden when team_name is set
               (team events surface that instead) so we don't
               show two competing identities. -->
          <div v-if="activeInfo.club_name && !activeInfo.team_name" class="active-club">
            {{ activeInfo.club_name }}<span v-if="activeInfo.club_code" class="active-club-code">{{ activeInfo.club_code }}</span>
          </div>
          <div class="active-badges">
            <div class="active-code">{{ activeInfo.code }}</div>
            <div class="active-dd">{{ activeInfo.dd }}</div>
          </div>
          <div class="active-desc">{{ activeInfo.desc }}</div>

          <div class="judge-block">
            <div style="font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-3);margin-bottom:0.625rem">Judge Scores</div>
            <!-- Synchro: split the live judge tiles into the WA
                 panel groups (Exec A / Exec B / Sync) so the
                 operator sees who's scoring what role at a glance.
                 Each group gets a labelled column; the tiles
                 themselves are unchanged so Score-by-judge wiring
                 (signal flag, scored class, name tooltip) stays
                 identical with the flat layout. -->
            <div v-if="judgeTilesByGroup" class="judge-groups-grid">
              <div v-for="g in judgeTilesByGroup"
                   :key="g.role"
                   :class="['judge-group-col', `judge-group-${g.role}`]">
                <div class="judge-group-col-label">{{ g.label }}</div>
                <div class="judge-group-col-tiles">
                  <div
                    v-for="tile in g.tiles"
                    :key="tile.judgeIndex"
                    :class="[
                      'judge-tile',
                      tile.scored ? 'scored' : '',
                      tile.signaled ? 'signaled' : '',
                    ]"
                    :title="tile.signaled
                      ? `${judgeNameByNumber[tile.judgeIndex] || 'Judge'} ${tile.judgeIndex} — wants the referee`
                      : (judgeNameByNumber[tile.judgeIndex] || `Judge ${tile.judgeIndex}`)"
                  >
                    <div class="judge-tile-label">J{{ tile.judgeIndex }}</div>
                    <div class="judge-tile-score">{{ tile.score }}</div>
                    <div v-if="judgeNameByNumber[tile.judgeIndex]" class="judge-tile-name">
                      {{ judgeNameByNumber[tile.judgeIndex].split(' ').slice(-1)[0] }}
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <div v-else class="judge-grid">
              <div
                v-for="tile in judgeTiles"
                :key="tile.judgeIndex"
                :class="[
                  'judge-tile',
                  tile.scored ? 'scored' : '',
                  tile.signaled ? 'signaled' : '',
                ]"
                :title="tile.signaled
                  ? `${judgeNameByNumber[tile.judgeIndex] || 'Judge'} ${tile.judgeIndex} — wants the referee`
                  : (judgeNameByNumber[tile.judgeIndex] || `Judge ${tile.judgeIndex}`)"
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
            <!-- Reserved slot for the computed dive total. Always
                 present so the controls below it never shift; the
                 inner row uses v-show so it stays measurable but
                 invisible until every tile is in. -->
            <div class="active-dive-total-slot">
              <div v-show="liveDiveTotal != null" class="active-dive-total">
                <span class="active-dive-total-label">Dive Total</span>
                <span class="active-dive-total-value">{{ liveDiveTotal != null ? liveDiveTotal.toFixed(1) : '' }}</span>
              </div>
            </div>
          </div>

          <!-- Bottom controls — pinned to the bottom of the centre
               column via margin-top: auto so the layout uses the
               full screen height regardless of how much active-
               diver content is above. The operator's eye learns
               that the action buttons live at the bottom edge.
               Compressed-layout pass: Prev / Next dominate; ref
               actions (Failed / Cap / Re-Dive) collapse into a
               single Adjust ▾ menu since they're occasional;
               auto-next picker rides as a ▾ split-button on
               Next Diver; keyboard hints retreat behind a ?
               icon. Net effect: one primary button + two
               trailing affordances, instead of three rows. -->
          <div class="active-bottom">
            <div class="nav-btns">
              <button class="btn btn-ghost"
                      @click="setActive(currentIndex - 1)"
                      :disabled="currentIndex <= 0"
                      :title="currentIndex <= 0
                        ? 'Already at the first diver in the queue'
                        : 'Step back to the previous diver (←)'">← Prev</button>
              <!-- Adjust ▾ — Failed Dive / Cap Score / Re-Dive
                   collapsed into a single dropdown. F/R keyboard
                   shortcuts still work via onKeydown. -->
              <div class="dropdown-host">
                <button
                  class="btn btn-ghost"
                  :disabled="!currentActive"
                  @click.stop="toggleMenu('adjust')"
                  :aria-expanded="adjustMenuOpen"
                  :title="!currentActive
                    ? 'Pick an active diver from the queue first'
                    : 'Failed dive, cap score, or re-dive'"
                >Adjust ▾</button>
                <div v-if="adjustMenuOpen" class="dropdown-menu adjust-menu">
                  <button class="dropdown-item dropdown-item-danger"
                          @click="refAction('failed'); adjustMenuOpen = false">
                    Failed Dive <span class="dropdown-item-hint"><kbd>F</kbd></span>
                  </button>
                  <button class="dropdown-item dropdown-item-amber"
                          @click="refAction('cap'); adjustMenuOpen = false">
                    Cap Score <span class="dropdown-item-aside">max 2.0</span>
                  </button>
                  <button class="dropdown-item dropdown-item-cyan"
                          @click="refAction('redive'); adjustMenuOpen = false">
                    Re-Dive <span class="dropdown-item-hint"><kbd>R</kbd></span>
                  </button>
                </div>
              </div>
              <!-- Next Diver as a split-button: the wide button
                   advances the queue, the trailing ▾ opens a
                   menu of Auto-next intervals (Manual / 5s / …).
                   Co-locating the picker with the action it
                   governs keeps the operator's eye in one place
                   instead of jumping to a top-bar dropdown. -->
              <div class="split-button dropdown-host">
                <button
                  :class="['btn', 'split-button-main',
                    nextBtnComplete ? 'btn-complete' : 'btn-primary',
                    autoAdvanceCountdown > 0 ? 'btn-counting' : '']"
                  :disabled="nextBtnDisabled"
                  :title="nextBtnTitle"
                  @click="nextDiver"
                >
                  {{ nextBtnText }}
                  <span v-if="autoAdvanceCountdown > 0" class="auto-advance-pill">
                    {{ autoAdvanceCountdown }}s
                  </span>
                </button>
                <!-- The ▾ aside is intentionally NOT gated on
                     nextBtnDisabled — the operator should be able
                     to set the Auto-next preference at any point
                     (before the first diver, mid-round, while
                     waiting on scores), even when Next Diver
                     itself can't fire yet. -->
                <button
                  :class="['btn', 'split-button-aside',
                    nextBtnComplete ? 'btn-complete' : 'btn-primary']"
                  @click.stop="toggleMenu('autonext')"
                  :aria-expanded="autoNextMenuOpen"
                  :title="`Auto-next: ${autoAdvanceSeconds === 0 ? 'Manual' : autoAdvanceSeconds + 's'}`"
                >▾</button>
                <div v-if="autoNextMenuOpen" class="dropdown-menu autonext-menu">
                  <div class="dropdown-section">Auto-next after the panel completes</div>
                  <button v-for="opt in [
                            { v: 0,  label: 'Manual' },
                            { v: 5,  label: '5 seconds' },
                            { v: 10, label: '10 seconds' },
                            { v: 15, label: '15 seconds' },
                            { v: 20, label: '20 seconds' },
                            { v: 25, label: '25 seconds' },
                            { v: 30, label: '30 seconds' },
                          ]"
                          :key="opt.v"
                          :class="['dropdown-item', autoAdvanceSeconds === opt.v ? 'dropdown-item-active' : '']"
                          @click="autoAdvanceSeconds = opt.v; autoNextMenuOpen = false">
                    <span>{{ opt.label }}</span>
                    <span v-if="autoAdvanceSeconds === opt.v" class="dropdown-item-tick">✓</span>
                  </button>
                </div>
              </div>
              <!-- Keyboard-shortcut popover. Only operators who
                   want a refresher tap the ?; the canvas isn't
                   bombarded with chip text otherwise. The
                   hotkeys themselves stay live regardless. -->
              <div class="dropdown-host kbd-hints-host">
                <button
                  class="btn btn-ghost btn-icon"
                  @click.stop="toggleMenu('kbd')"
                  :aria-expanded="kbdHintsOpen"
                  title="Keyboard shortcuts"
                >?</button>
                <div v-if="kbdHintsOpen" class="dropdown-menu kbd-menu">
                  <div class="dropdown-section">Keyboard shortcuts</div>
                  <div class="kbd-row"><kbd>←</kbd><span>Previous diver</span></div>
                  <div class="kbd-row"><kbd>→</kbd><span class="kbd-row-or">/</span><kbd>Space</kbd><span>Next diver</span></div>
                  <div class="kbd-row"><kbd>1</kbd>–<kbd>9</kbd><span>Jump to roster position</span></div>
                  <div class="kbd-row"><kbd>T</kbd><span>Reset shot clock</span></div>
                  <div class="kbd-row"><kbd>F</kbd><span>Failed dive</span></div>
                  <div class="kbd-row"><kbd>R</kbd><span>Re-dive</span></div>
                  <div class="kbd-row"><kbd>H</kbd><span>Hold / resume meet</span></div>
                  <div class="kbd-row"><kbd>L</kbd><span>Open leaderboard</span></div>
                </div>
              </div>
            </div>
            <!-- Cancel-the-countdown affordance. Sits below the
                 Next Diver row only while the auto-advance timer
                 is running — clicking it stops the timer without
                 advancing, returning the queue to manual control
                 until the operator clicks Next. -->
            <button
              v-if="autoAdvanceCountdown > 0"
              class="btn btn-ghost auto-advance-cancel"
              @click="cancelAutoAdvance"
              title="Stop the auto-advance timer for this dive"
            >✕ Cancel auto-advance</button>
          </div>
        </div>
      </div>

      <!-- Right: Dive Order column. Houses the Up Next preview,
           the (collapsed) Top 5 + full Dive Order panels, and
           the workflow stepper + late-entry button. We say
           "Dive Order" everywhere instead of "Queue" / "Roster"
           — three terms for the same concept fragmented the
           operator's mental model. -->
      <div class="ctrl-panel">
        <!-- Pre-Meet panel — houses the four-step pre-meet
             workflow stepper + the colour-cycling action button
             that drives it (Check In Divers → Randomise → Sign
             Off → Start). The "Dive Order" / "1/48" count chip
             that used to live here was duplicate signal — the
             collapsible Dive Order panel near the bottom of this
             column is the canonical roster view, and the centre
             column already shows "Diver N / Total" in its meta
             strip. The 🔒 Order-locked badge (which only appears
             after the event flips Live and reordering is no
             longer allowed) was moved to the Dive Order accordion
             header below, where the operator would actually try
             to reorder a row.

             Class is `pre-meet-head` (not `dive-order-head`)
             because the lower accordion already owns
             `.dive-order-head`; the duplicate name was shadowing
             its layout rules. -->
        <div class="panel-head pre-meet-head">
          <div class="pre-meet-title">Pre-Meet</div>
          <!-- Pre-meet workflow stepper — shows all four steps
               with the current one highlighted and completed
               ones ticked. Renders ABOVE the action button so
               a new operator sees the full flow at a glance
               instead of having to remember that red →
               orange → yellow → green is "step 1 of 4". -->
          <div v-if="currentEvent && roster.length && orderWorkflowState && orderWorkflowState !== 'live'"
               class="wf-stepper"
               :title="`Pre-meet step ${WORKFLOW_STEPS.indexOf(orderWorkflowState) + 1} of 4`">
            <div :class="['wf-step', wfStepClass('check-in')]">
              <span class="wf-step-num">{{ wfStepClass('check-in') === 'wf-step-done' ? '✓' : '1' }}</span>
              <span class="wf-step-label">Check-in</span>
            </div>
            <div :class="['wf-step-divider', wfStepClass('check-in') === 'wf-step-done' ? 'wf-divider-done' : '']"></div>
            <div :class="['wf-step', wfStepClass('random')]">
              <span class="wf-step-num">{{ wfStepClass('random') === 'wf-step-done' ? '✓' : '2' }}</span>
              <span class="wf-step-label">Randomise</span>
            </div>
            <div :class="['wf-step-divider', wfStepClass('random') === 'wf-step-done' ? 'wf-divider-done' : '']"></div>
            <div :class="['wf-step', wfStepClass('sign-off')]">
              <span class="wf-step-num">{{ wfStepClass('sign-off') === 'wf-step-done' ? '✓' : '3' }}</span>
              <span class="wf-step-label">Sign Off</span>
            </div>
            <div :class="['wf-step-divider', wfStepClass('sign-off') === 'wf-step-done' ? 'wf-divider-done' : '']"></div>
            <div :class="['wf-step', wfStepClass('start')]">
              <span class="wf-step-num">4</span>
              <span class="wf-step-label">Start</span>
            </div>
          </div>
          <!-- Action row: pre-meet workflow button (one button
               cycles through four sequential states before the
               event flips Live — red Check In → orange Randomise
               → yellow Referee Sign Off → green Start), plus the
               Adjust check-in / + Add utility actions. State
               lives on the event row (check_in_done_at,
               dive_order_randomised_at, dive_order_signed_off_at)
               so a page reload picks up where the operator left
               off. The small "↺ Reset" link backtracks to state 1.
               The standalone "Check-in" ghost button is gone —
               clicking the red state-1 button opens the same
               modal. -->
          <div class="pre-meet-actions">
            <template v-if="currentEvent && roster.length && orderWorkflowState && orderWorkflowState !== 'live'">
              <button v-if="orderWorkflowState === 'check-in'"
                      class="btn btn-sm wf-btn wf-btn-red"
                      :disabled="orderBusy"
                      @click="startCheckInStep"
                      title="Open the check-in modal. Mark each diver present / late / DNS, then confirm to advance.">
                ✓ Check In Divers
              </button>
              <button v-else-if="orderWorkflowState === 'random'"
                      class="btn btn-sm wf-btn wf-btn-orange"
                      :disabled="orderBusy || !canReorderQueue"
                      @click="randomizeStartOrder"
                      title="Shuffle the diver start order across every round.">
                {{ orderBusy ? '🎲 …' : '🎲 Randomise Dive Order' }}
              </button>
              <button v-else-if="orderWorkflowState === 'sign-off'"
                      class="btn btn-sm wf-btn wf-btn-yellow"
                      :disabled="orderBusy"
                      @click="signOffDiveOrder"
                      title="Referee approves the published dive order.">
                {{ orderBusy ? '📋 …' : '📋 Referee Sign Off' }}
              </button>
              <button v-else-if="orderWorkflowState === 'start'"
                      class="btn btn-sm wf-btn wf-btn-green"
                      :disabled="orderBusy"
                      @click="startEvent"
                      title="Flip the event to Live. The order is then locked.">
                {{ orderBusy ? '▶ …' : '▶ Start Event' }}
              </button>
              <!-- Skip-randomise affordance: if the operator has
                   already arranged the order manually they can
                   advance straight to sign-off. Hidden outside
                   state 2. -->
              <button v-if="orderWorkflowState === 'random'"
                      class="btn btn-ghost btn-sm wf-skip"
                      :disabled="orderBusy"
                      @click="confirmDiveOrder"
                      title="Skip randomise — keep the current order and advance to sign-off.">
                Use current order →
              </button>
              <!-- Reset link: clears every workflow stamp so the
                   operator can walk all four steps again. Hidden in
                   state 1 (nothing to reset). -->
              <button v-if="orderWorkflowState !== 'check-in'"
                      class="btn btn-ghost btn-sm wf-reset"
                      :disabled="orderBusy"
                      @click="resetDiveOrderWorkflow"
                      title="Clear all workflow stamps and walk the four steps again.">
                ↺ Reset
              </button>
            </template>
            <span v-else-if="currentEvent && currentEvent.status !== 'Upcoming'"
                  class="wf-live-badge"
                  :title="`Event is ${currentEvent.status}`">
              {{ currentEvent.status === 'Live' ? '● Live' : '✓ Done' }}
            </span>
            <!-- Check-in is reachable from inside the workflow's
                 state-1 button. After advance, expose a quiet "Re-
                 open check-in" link so the operator can still adjust
                 attendance mid-meet (someone arrives late, etc.). -->
            <button v-if="currentEvent && roster.length
                          && orderWorkflowState !== 'check-in'
                          && orderWorkflowState !== 'live'"
                    class="btn btn-ghost btn-sm wf-skip" @click="openCheckIn"
                    title="Reopen the check-in list to adjust attendance.">
              Adjust check-in
            </button>
            <button v-if="currentEvent" class="btn btn-ghost btn-sm" @click="openLateEntry"
                    title="Add a late-arriving diver">+ Add</button>
          </div>
        </div>

        <!-- Up Next — primary right-panel surface during live
             scoring. Shows the next 3 divers / pairs by default;
             a "Show N more ↓" toggle rendered INSIDE the list
             after row 3 expands to the full set without moving
             the toggle off-screen. Withdrawn rows are skipped
             server-side via the upNextDives computed. Click a
             row to jump-set the active diver, same as a Dive
             Order row click. -->
        <div v-if="upNextDives.length" class="up-next-panel">
          <div class="up-next-panel-head">
            <span class="up-next-panel-label">Up Next</span>
          </div>
          <div class="up-next-list">
            <template v-for="(row, idx) in upNextDives"
                      :key="row.dive_list_id || row.originalIdx">
            <button
              :class="['up-next-row-btn']"
              :disabled="!!row.withdrawn_at"
              @click="setActive(row.originalIdx)"
              title="Jump to this diver"
            >
              <!-- Two-column layout: R# label pinned to the
                   LEFT, everything else (names, club, dive code
                   + DD + description) stacked in the right
                   column so the dive header line indents to
                   align with the name + club above it. -->
              <div class="up-next-row-grid">
                <span class="up-next-row-rd">R{{ row.round_number }}</span>
                <div class="up-next-row-stack">
                  <DiverIdentity :row="row"
                                 :rank="row.round_order ?? row.display_order"
                                 class="up-next-identity" />
                  <div v-if="row.dive_code || row.dd != null || row.description"
                       class="up-next-row-bot">
                    <span v-if="row.dive_code" class="up-next-row-code">
                      {{ row.dive_code }}{{ row.position || '' }}
                    </span>
                    <span v-if="row.dd != null" class="up-next-row-dd">DD {{ parseFloat(row.dd).toFixed(1) }}</span>
                    <span v-if="row.description || row.position" class="up-next-row-desc">
                      {{ diveDescription(row) }}
                    </span>
                  </div>
                </div>
              </div>
            </button>
            <!-- Anchored toggle — rendered INSIDE the v-for
                 after the 3rd row so it stays at a fixed
                 visual position when expanded. Extra rows
                 drop down BELOW it. Only renders when there
                 are more upcoming rows than the preview limit
                 (so the button never appears with nothing to
                 reveal). -->
            <button
              v-if="idx === UP_NEXT_DEFAULT_LIMIT - 1
                    && upNextTotal > UP_NEXT_DEFAULT_LIMIT"
              class="up-next-anchor-toggle"
              @click="upNextShowAll = !upNextShowAll"
              :title="upNextShowAll
                ? `Show only the next ${UP_NEXT_DEFAULT_LIMIT}`
                : `Show all ${upNextTotal} remaining`"
            >
              {{ upNextShowAll
                  ? `Show fewer ↑`
                  : `Show ${upNextTotal - UP_NEXT_DEFAULT_LIMIT} more ↓` }}
            </button>
            </template>
          </div>
        </div>

        <!-- Reserves panel — surfaces when the meet manager
             advanced from a prelim/semi with reserves. Per
             World Aquatics DD 9.1 / 9.2, a reserve replacing
             a withdrawing primary INHERITS that primary's
             start position so the dive order is preserved.
             The "Replace…" picker (only shown when there's
             at least one active or already-withdrawn primary)
             promotes the reserve into that exact slot;
             clicking just "Promote" slots them at the back
             of the queue. -->
        <div v-if="reserves.length" class="reserves-panel">
          <button class="reserves-head"
                  @click="reservesOpen = !reservesOpen"
                  :title="reservesOpen ? 'Collapse' : 'Expand'">
            <span class="reserves-head-label">Reserves</span>
            <span class="reserves-head-count">{{ reserves.length }}</span>
            <span class="reserves-head-chevron">{{ reservesOpen ? '▴' : '▾' }}</span>
          </button>
          <div v-if="reservesOpen" class="reserves-list">
            <div v-for="r in reserves" :key="r.competitor_id" class="reserves-row">
              <div class="reserves-row-head">
                <span class="reserves-row-pos">R{{ r.reserve_position }}</span>
                <span class="reserves-row-name">{{ r.full_name }}</span>
                <span v-if="r.club_code" class="reserves-row-club">{{ r.club_code }}</span>
              </div>
              <div class="reserves-row-actions">
                <select v-model="reservesReplaceChoice[r.competitor_id]" class="select reserves-row-select">
                  <option value="">Slot at back of queue</option>
                  <optgroup v-if="reservesWithdrawn.length" label="Replace withdrawn">
                    <option v-for="w in reservesWithdrawn" :key="w.competitor_id" :value="w.competitor_id">
                      {{ w.full_name }}{{ w.club_code ? ' · ' + w.club_code : '' }}
                    </option>
                  </optgroup>
                  <optgroup v-if="reservesActive.length" label="Replace active (will withdraw them)">
                    <option v-for="a in reservesActive" :key="a.competitor_id" :value="a.competitor_id">
                      {{ a.full_name }}{{ a.club_code ? ' · ' + a.club_code : '' }} (#{{ a.display_order }})
                    </option>
                  </optgroup>
                </select>
                <button type="button"
                        class="btn btn-primary btn-sm"
                        :disabled="reservesPromoting === r.competitor_id"
                        @click="promoteReserve(r.competitor_id)">
                  {{ reservesPromoting === r.competitor_id ? 'Promoting…' : 'Promote' }}
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Standings + projected leader — top 5 inline so the
             meet referee always knows the running state. Mirrors
             the Dive Order pattern below: clickable header with
             a caret + count toggles the body open / closed.
             Stays expanded by default; collapse preference saved
             per browser via toggleStandingsProjection. -->
        <div v-if="standingsTop5.length" class="standings-preview">
          <button class="standings-head"
                  @click="toggleStandingsProjection"
                  :aria-expanded="showStandingsProjection">
            <span class="standings-caret">{{ showStandingsProjection ? '▾' : '▸' }}</span>
            <span class="standings-title">Top 5 right now</span>
            <span class="standings-count">{{ standingsTop5.length }}</span>
          </button>
          <div v-if="showStandingsProjection" class="standings-body">
          <div v-for="(s, i) in standingsTop5" :key="i" class="sp-row">
            <span :class="['sp-rank', i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '']">
              {{ i + 1 }}
            </span>
            <span class="sp-name">
              {{ s.full_name }}
              <template v-if="s.partner_name">
                <span class="sp-amp">&amp;</span>{{ s.partner_name }}
              </template>
            </span>
            <span class="sp-total">{{ parseFloat(s.total).toFixed(1) }}</span>
          </div>
          <!-- Catch-up panel. Replaces the old "+N pts; #/dive
               (~#/judge)" blob with a target-by-target table that
               surfaces the average judge score the active diver
               needs across the remaining dives to reach 1st / 2nd
               / 3rd. Caps at 10 — anything above and the row
               reads "Not possible". For the leader the table
               flips to "what #2 would need to overtake". -->
          <div v-if="projectedLine" :class="['projection-line', `projection-${projectedLine.kind}`]">
            <template v-if="projectedLine.kind === 'chase'">
              <div class="projection-head">
                Catch-up — <strong>{{ projectedLine.remaining }}</strong>
                {{ projectedLine.remaining === 1 ? 'dive' : 'dives' }} left
                · currently {{ projectedLine.currentRank }}
              </div>
              <div v-for="t in projectedLine.targets" :key="t.rank" class="catchup-row">
                <span class="catchup-rank">{{ t.rank }}{{ ['st','nd','rd'][t.rank - 1] || 'th' }}</span>
                <span class="catchup-name">{{ t.name }}</span>
                <span :class="['catchup-target', t.possible === false ? 'catchup-impossible' : '']">
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
            <template v-else-if="projectedLine.kind === 'lead'">
              <div class="projection-head">
                🏆 <strong>{{ projectedLine.activeName }}</strong> leading
                by <strong>+{{ projectedLine.gap.toFixed(1) }}</strong>
              </div>
              <div class="catchup-row">
                <span class="catchup-rank">2nd</span>
                <span class="catchup-name">{{ projectedLine.runnerUp }}</span>
                <span :class="['catchup-target', projectedLine.possible === false ? 'catchup-impossible' : '']">
                  <template v-if="projectedLine.avgJudge == null">
                    +{{ projectedLine.gap.toFixed(1) }} pts
                  </template>
                  <template v-else-if="projectedLine.possible === false">
                    can't overtake
                  </template>
                  <template v-else>
                    needs avg {{ projectedLine.avgJudge.toFixed(1) }}
                  </template>
                </span>
              </div>
            </template>
            <template v-else-if="projectedLine.kind === 'pre'">
              No completed dives yet. {{ projectedLine.leaderName }} leads at
              <strong>{{ projectedLine.leaderTotal.toFixed(1) }}</strong>.
            </template>
            <template v-else-if="projectedLine.kind === 'unopposed'">
              {{ projectedLine.activeName }} unopposed — only diver entered.
            </template>
          </div>
          </div>
        </div>

        <!-- Dive Order — collapsed-by-default panel housing the
             full roster (search, round chips, reorder controls).
             During live scoring the operator only needs Up Next
             above; this panel is for pre-meet setup and the
             occasional manual jump. Header click toggles. -->
        <div v-if="roster.length" class="dive-order-panel">
          <button class="dive-order-head"
                  @click="diveOrderOpen = !diveOrderOpen"
                  :aria-expanded="diveOrderOpen">
            <span class="dive-order-caret">{{ diveOrderOpen ? '▾' : '▸' }}</span>
            <span class="dive-order-title">Dive Order</span>
            <span class="dive-order-count">{{ roster.length }}</span>
            <!-- Once the event flips out of 'Upcoming' the start
                 order is locked. Lives on this accordion header
                 (rather than the Pre-Meet panel above) because
                 this is where the operator interacts with the
                 order itself — drag-reorder, jump-to-row — so the
                 chip explains why those affordances are dimmed
                 right next to them. -->
            <span v-if="currentEvent && !canReorderQueue"
                  class="queue-lock-badge dive-order-lock-badge"
                  :title="`Start order locked — event is ${currentEvent.status}. Withdraw a diver instead if they need to be skipped.`"
                  @click.stop>
              🔒 Order locked
            </span>
          </button>
          <div v-if="diveOrderOpen" class="dive-order-body">
            <!-- Search + jump-to-round chips -->
            <div class="queue-filters">
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
                dragRosterIdx === item.originalIdx ? 'is-dragging' : '',
                dragOverRosterIdx === item.originalIdx ? 'is-drop-target' : '',
                !canReorderQueue ? 'is-locked' : '',
              ]"
              :draggable="canReorderQueue && !item.withdrawn_at"
              @dragstart="onRosterDragStart(item.originalIdx, $event)"
              @dragover="onRosterDragOver(item.originalIdx, $event)"
              @dragleave="onRosterDragLeave(item.originalIdx)"
              @dragend="onRosterDragEnd"
              @drop="onRosterDrop(item.originalIdx, $event)"
            >
              <div class="roster-row-head">
                <span v-if="canReorderQueue"
                      class="roster-grip"
                      title="Drag to reorder within round">⋮⋮</span>
                <span v-else class="roster-grip roster-grip-locked"
                      title="Start order locked — event has started">🔒</span>
                <button
                  class="roster-jump"
                  :disabled="!!item.withdrawn_at"
                  @click="setActive(item.originalIdx)"
                >
                  <div class="roster-name">
                    <!-- Same round_order-with-display_order-fallback
                         as the Up Next row above. -->
                    <span v-if="(item.round_order ?? item.display_order) != null"
                          class="roster-order">{{ item.round_order ?? item.display_order }}.</span>
                    {{ item.full_name }}<span v-if="item.country_code" class="roster-country">{{ item.country_code }}</span>
                    <template v-if="item.partner_name">
                      <span class="roster-amp">&amp;</span>
                      {{ item.partner_name }}
                    </template>
                    <span v-if="item.withdrawn_at" class="roster-wd-badge">WITHDRAWN</span>
                  </div>
                  <div v-if="item.team_name" class="roster-team">{{ item.team_name }}</div>
                  <div v-if="item.club_name && !item.team_name" class="roster-club">
                    {{ item.club_name }}<span v-if="item.club_code" class="roster-club-code">{{ item.club_code }}</span>
                  </div>
                  <div class="roster-meta">
                    <!-- dive_code / position / dd can be null when
                         the diver hasn't filed their full list yet
                         (LEFT JOIN dive_directory in the roster
                         query). Show a dash instead of "undefined". -->
                    <span>{{ item.dive_code ? `${item.dive_code}${item.position || ''}` : '—' }}</span>
                    <span>DD {{ item.dd != null ? item.dd : '—' }}</span>
                  </div>
                </button>
                <!-- Reorder + withdraw controls. Use originalIdx
                     so reorder targets the correct unfiltered slot. -->
                <div class="roster-controls">
                  <button class="roster-ctrl"
                          :disabled="!canReorderQueue || item.originalIdx === 0 || roster[item.originalIdx - 1].round_number !== item.round_number"
                          @click.stop="reorderRosterRow(item.originalIdx, 'up')"
                          :title="canReorderQueue ? 'Move up within round' : 'Order locked — event has started'">▲</button>
                  <button class="roster-ctrl"
                          :disabled="!canReorderQueue || item.originalIdx >= roster.length - 1 || roster[item.originalIdx + 1].round_number !== item.round_number"
                          @click.stop="reorderRosterRow(item.originalIdx, 'down')"
                          :title="canReorderQueue ? 'Move down within round' : 'Order locked — event has started'">▼</button>
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
      <!-- Live preview of the correction's impact. Recomputes
           on every keystroke so the operator sees how the edit
           moves the trim sum + dive points BEFORE clicking
           Save. -->
      <div v-if="correctPreview" class="correct-preview"
           :class="{ 'correct-preview-noop': correctPreview.unchanged }">
        <div class="correct-preview-row">
          <span class="correct-preview-label">Judge {{ correctPreview.judgeIdx + 1 }}</span>
          <span class="correct-preview-old">{{ correctPreview.oldScore.toFixed(1) }}</span>
          <span class="correct-preview-arrow">→</span>
          <span class="correct-preview-new">{{ correctPreview.newScore.toFixed(1) }}</span>
        </div>
        <div class="correct-preview-row">
          <span class="correct-preview-label">Trim sum</span>
          <span class="correct-preview-old">{{ correctPreview.oldTrim.toFixed(1) }}</span>
          <span class="correct-preview-arrow">→</span>
          <span class="correct-preview-new">{{ correctPreview.newTrim.toFixed(1) }}</span>
        </div>
        <div class="correct-preview-row preview-points">
          <span class="correct-preview-label">Dive points <span class="correct-preview-dd">× DD {{ correctPreview.dd.toFixed(1) }}</span></span>
          <span class="correct-preview-old">{{ correctPreview.oldPoints.toFixed(2) }}</span>
          <span class="correct-preview-arrow">→</span>
          <span class="correct-preview-new">{{ correctPreview.newPoints.toFixed(2) }}</span>
          <span v-if="!correctPreview.unchanged"
                :class="['correct-preview-delta',
                         correctPreview.delta > 0 ? 'pos'
                       : correctPreview.delta < 0 ? 'neg' : '']">
            {{ correctPreview.delta > 0 ? '+' : '' }}{{ correctPreview.delta.toFixed(2) }}
          </span>
        </div>
        <div v-if="correctPreview.dropChanged" class="correct-preview-note">
          ↻ The trim selection changes — a different judge's score is now dropped.
        </div>
        <div v-if="correctPreview.unchanged" class="correct-preview-note">
          No change — score matches the existing value.
        </div>
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

  <!-- Check-in / accreditation modal -->
  <div v-if="checkInOpen" class="lb-backdrop" @click="closeCheckIn"></div>
  <div v-if="checkInOpen" class="lb-modal checkin-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Check-in</div>
        <div class="lb-event">
          {{ currentEvent?.name }}
          <span class="checkin-tally">
            <span class="tally-present">✓ {{ checkInCounts.present }}</span>
            <span class="tally-late">⏱ {{ checkInCounts.late }}</span>
            <span class="tally-absent">✕ {{ checkInCounts.absent }}</span>
            <span class="tally-pending">— {{ checkInCounts.pending }}</span>
          </span>
        </div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="closeCheckIn">Close ✕</button>
    </div>
    <div class="lb-body">
      <p class="hint" style="margin-bottom: 0.6rem">
        Tap a chip to set the diver's status. Clicking the same chip again clears it
        (back to pending). Updates persist instantly and broadcast to other operators.
      </p>
      <div v-if="checkInLoading" class="empty-mini">Loading…</div>
      <div v-else-if="!checkInRows.length" class="empty-mini">
        No divers entered for this event yet.
      </div>
      <div v-else class="checkin-list">
        <div v-for="row in checkInRows" :key="row.competitor_id"
             :class="['checkin-row', `checkin-${row.status || 'pending'}`]">
          <div class="checkin-name">
            {{ row.full_name }}
            <span v-if="row.country_code" class="checkin-country">{{ row.country_code }}</span>
            <div v-if="row.club_name" class="checkin-club">
              {{ row.club_name }}<span v-if="row.club_code" class="checkin-club-code">{{ row.club_code }}</span>
            </div>
          </div>
          <div class="checkin-chips">
            <button :class="['chip', 'chip-present', row.status === 'present' ? 'is-active' : '']"
                    @click="setAttendance(row, 'present')"
                    title="Mark present">✓ Present</button>
            <button :class="['chip', 'chip-late', row.status === 'late' ? 'is-active' : '']"
                    @click="setAttendance(row, 'late')"
                    title="Mark late">⏱ Late</button>
            <button :class="['chip', 'chip-absent', row.status === 'absent' ? 'is-active' : '']"
                    @click="setAttendance(row, 'absent')"
                    title="Mark absent / DNS">✕ DNS</button>
          </div>
        </div>
      </div>
      <div v-if="checkInErr" class="msg msg-error">{{ checkInErr }}</div>
    </div>
    <!-- Footer: confirm-and-advance button when the workflow is
         on state 1 (no check_in_done_at stamp yet). After confirm
         the modal closes and the workflow button flips to orange
         "Randomise". When the operator reopens the modal mid-meet
         to adjust attendance, this footer is hidden because the
         workflow has already moved past check-in. -->
    <div v-if="orderWorkflowState === 'check-in'" class="lb-footer">
      <span class="checkin-footer-hint">
        Mark each diver, then confirm to advance the workflow.
      </span>
      <button class="btn btn-sm wf-btn wf-btn-red"
              :disabled="orderBusy || checkInLoading"
              @click="confirmCheckInComplete"
              title="Stamp check-in complete and advance to Randomise.">
        ✓ Check-in Complete — Continue
      </button>
    </div>
  </div>

  <!-- Referee sign-off modal (Cut 2). Two paths: send a push
       notification to a chosen referee's device (the primary
       flow), or have the referee enter their own credentials
       on the manager's device when the push isn't viable
       (no notification permission, no registered device). -->
  <div v-if="signoffOpen" class="lb-backdrop" @click="closeSignoffModal"></div>
  <div v-if="signoffOpen" class="lb-modal signoff-modal" @click.stop>
    <div class="lb-header">
      <div>
        <div class="lb-title">Referee Sign-Off</div>
        <div class="lb-event">{{ currentEvent?.name }}</div>
      </div>
      <button class="btn btn-ghost btn-sm" @click="closeSignoffModal">Close ✕</button>
    </div>
    <div class="lb-body">
      <!-- Enforcement banner: visible when the event was created
           with enforce_referee_signoff = TRUE so the operator
           understands why the manager-attests tab isn't there. -->
      <div v-if="enforceSignoff" class="signoff-enforced-banner">
        🔒 Referee sign-off is enforced for this event. Only the
        referee's own approval — push, code, or credential — counts.
      </div>

      <!-- Tab strip — push (primary), Cut 3 code, credential
           (fallback at this device), and the manager-attests
           shortcut (hidden when sign-off is enforced). -->
      <div class="signoff-tabs">
        <button :class="['signoff-tab', signoffMode === 'push' ? 'is-active' : '']"
                @click="signoffMode = 'push'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode"
                :title="(!!signoffWaiting || !!signoffCode)
                  ? 'A request is already pending — close it (Cancel) before switching modes'
                  : 'Push a notification to the referee’s phone for them to approve'">
          📱 Send to referee's device
        </button>
        <button :class="['signoff-tab', signoffMode === 'code' ? 'is-active' : '']"
                @click="signoffMode = 'code'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode"
                :title="(!!signoffWaiting || !!signoffCode)
                  ? 'A request is already pending — close it (Cancel) before switching modes'
                  : 'Generate a 6-digit code + QR for the referee to enter on their phone'">
          🔢 Code on referee's device
        </button>
        <button :class="['signoff-tab', signoffMode === 'credential' ? 'is-active' : '']"
                @click="signoffMode = 'credential'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode"
                :title="(!!signoffWaiting || !!signoffCode)
                  ? 'A request is already pending — close it (Cancel) before switching modes'
                  : 'Hand the laptop to the referee — they sign in with their own credentials'">
          🔐 Sign at this device
        </button>
        <button v-if="!enforceSignoff"
                :class="['signoff-tab', signoffMode === 'manager' ? 'is-active' : '']"
                @click="signoffMode = 'manager'; signoffError = ''"
                :disabled="!!signoffWaiting || !!signoffCode">
          ✓ I'll attest
        </button>
      </div>

      <!-- Push path -->
      <div v-if="signoffMode === 'push'" class="signoff-pane">
        <p class="hint">
          Pick the referee — they'll get a push notification on their phone /
          laptop with Approve / Deny buttons. The request times out after 5
          minutes. If they can't get the notification, switch to the other
          tab to sign on this device.
        </p>
        <template v-if="!signoffWaiting">
          <div v-if="!signoffReferees.length" class="empty-mini">
            No referees in this org yet. Use the credential tab instead.
          </div>
          <select v-else class="select" v-model="signoffPickedRefId" :disabled="orderBusy">
            <option value="">— Pick a referee —</option>
            <option v-for="r in signoffReferees" :key="r.id" :value="r.id">
              {{ r.full_name }}
            </option>
          </select>
          <div class="signoff-actions">
            <button class="btn btn-primary"
                    :disabled="orderBusy || !signoffPickedRefId"
                    :title="!signoffPickedRefId ? 'Select a referee from the list above first' : ''"
                    @click="sendSignoffPush">
              {{ orderBusy ? 'Sending…' : 'Send sign-off request' }}
            </button>
          </div>
        </template>
        <div v-else class="signoff-waiting">
          <div class="signoff-waiting-pulse">●</div>
          Waiting for {{ signoffWaiting.referee_name }} to approve…
          <div class="signoff-waiting-hint">
            Or switch tabs and have them sign here on this device.
          </div>
        </div>
      </div>

      <!-- Code path (Cut 3) -->
      <div v-else-if="signoffMode === 'code'" class="signoff-pane">
        <p class="hint">
          Pick the referee. Server generates a 6-digit code; read it to
          the referee, who types it on their own device at
          <code>/sign-off-codes</code>. The code is good for 5 minutes.
        </p>
        <template v-if="!signoffCode">
          <div v-if="!signoffReferees.length" class="empty-mini">
            No referees in this org yet.
          </div>
          <select v-else class="select" v-model="signoffPickedRefId" :disabled="orderBusy">
            <option value="">— Pick a referee —</option>
            <option v-for="r in signoffReferees" :key="r.id" :value="r.id">
              {{ r.full_name }}
            </option>
          </select>
          <div class="signoff-actions">
            <button class="btn btn-primary"
                    :disabled="orderBusy || !signoffPickedRefId"
                    :title="!signoffPickedRefId ? 'Select a referee from the list above first' : ''"
                    @click="generateSignoffCode">
              {{ orderBusy ? 'Generating…' : 'Generate code' }}
            </button>
          </div>
        </template>
        <div v-else class="signoff-code-display">
          <div class="signoff-code-label">Show this to {{ signoffCode.referee_name }}</div>
          <!-- Two-column hand-off: QR on the left, typeable code
               on the right. Whichever the referee can use first
               wins — both feed the same /sign-off/code/verify
               endpoint, so this panel updates the moment either
               path completes. The QR encodes the same code as a
               deep link into /sign-off-codes; scan-then-tap is
               faster than dictating six digits across a venue. -->
          <div class="signoff-code-grid">
            <div v-if="signoffCode.qr_data_url" class="signoff-code-qr-block">
              <img
                class="signoff-code-qr"
                :src="signoffCode.qr_data_url"
                alt="QR code for referee sign-off"
              />
              <div class="signoff-code-qr-caption">Scan to sign off</div>
            </div>
            <div class="signoff-code-divider" v-if="signoffCode.qr_data_url">or</div>
            <div class="signoff-code-text-block">
              <div class="signoff-code-value">{{ signoffCode.code }}</div>
              <div class="signoff-code-text-caption">Enter at <code>/sign-off-codes</code></div>
            </div>
          </div>
          <div class="signoff-code-hint">
            This panel updates the moment {{ signoffCode.referee_name }} confirms — by scan or
            by code.
          </div>
        </div>
      </div>

      <!-- Manager-attests path. Hidden in template when enforced;
           server gate refuses too. -->
      <div v-else-if="signoffMode === 'manager'" class="signoff-pane">
        <p class="hint">
          You're attesting that you've already confirmed the dive order
          with the referee verbally. Your name is what gets stamped on
          the audit trail — pick this only when you've genuinely got
          the referee's go-ahead.
        </p>
        <div class="signoff-actions">
          <button class="btn btn-primary"
                  :disabled="orderBusy"
                  @click="managerAttestSignoff">
            {{ orderBusy ? 'Recording…' : "I'll attest — sign off" }}
          </button>
        </div>
      </div>

      <!-- Credential path -->
      <div v-else class="signoff-pane">
        <p class="hint">
          Hand the laptop to the referee. They sign in with their own
          username + password (and TOTP if enabled). Your manager session
          stays put.
        </p>
        <div class="cred-fields">
          <div class="field">
            <label class="label">Referee username</label>
            <input class="input" type="text" v-model="credUsername"
                   autocomplete="off" :disabled="orderBusy">
          </div>
          <div class="field">
            <label class="label">Password</label>
            <input class="input" type="password" v-model="credPassword"
                   autocomplete="new-password" :disabled="orderBusy">
          </div>
          <div v-if="credNeedsTotp" class="field">
            <label class="label">TOTP / recovery code</label>
            <input class="input" type="text" v-model="credCode"
                   autocomplete="one-time-code" inputmode="numeric"
                   :disabled="orderBusy">
          </div>
        </div>
        <div class="signoff-actions">
          <button class="btn btn-primary"
                  :disabled="orderBusy || !credUsername.trim() || !credPassword"
                  :title="!credUsername.trim() ? 'Enter the referee’s username'
                    : (!credPassword ? 'Enter the referee’s password' : '')"
                  @click="submitCredentialSignoff">
            {{ orderBusy ? 'Verifying…' : 'Sign off' }}
          </button>
        </div>
      </div>

      <div v-if="signoffError" class="msg msg-error">{{ signoffError }}</div>
    </div>
  </div>

  <!-- Late-entry modal — N autocomplete inputs, one per round.
       The diver competes in every round of the event, so the
       operator types the full code+position (e.g. "5132D") into
       each row. The dive directory is filtered to the event's
       height before matching. Same submit pattern as the diver
       portal's CompetitorView, just with inline autocompletes
       instead of click-to-open modals. -->
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
        <select class="select" v-model="lateCompetitorId">
          <option value="">— Pick a diver —</option>
          <option v-for="d in lateDivers" :key="d.id" :value="d.id">{{ d.full_name }}</option>
        </select>
      </div>

      <!-- Synchro pair partner picker — only shown for synchro_pair events. -->
      <div v-if="currentEvent?.event_type === 'synchro_pair'" class="field">
        <label class="label">Partner</label>
        <select class="select" v-model="latePartnerId">
          <option value="">— Pick partner —</option>
          <option v-for="d in lateDivers"
                  :key="d.id"
                  :value="d.id"
                  :disabled="d.id === lateCompetitorId">
            {{ d.full_name }}
          </option>
        </select>
      </div>

      <!-- Team picker — only shown for team events. -->
      <div v-if="currentEvent?.event_type === 'team'" class="field">
        <label class="label">Team</label>
        <select class="select" v-model="lateTeamId">
          <option value="">— Pick team —</option>
          <option v-for="t in lateTeams" :key="t.id" :value="t.id">
            {{ t.name }}<span v-if="t.short_code"> ({{ t.short_code }})</span>
          </option>
        </select>
      </div>

      <div class="late-rounds">
        <div class="late-rounds-head">
          <span class="late-rounds-label">
            {{ lateRounds.length }}-round dive list
            <span v-if="currentEvent?.height" class="late-rounds-height">{{ currentEvent.height }} board</span>
          </span>
          <span class="late-rounds-dd">Total DD <strong>{{ lateTotalDD }}</strong></span>
        </div>
        <div
          v-for="(slot, idx) in lateRounds"
          :key="idx"
          class="late-row"
        >
          <span class="late-row-num">{{ idx + 1 }}</span>
          <div class="late-row-input-wrap">
            <input
              class="input"
              type="text"
              :id="`late-round-${idx}`"
              v-model="slot.text"
              :placeholder="`e.g. 5132D`"
              autocomplete="off"
              maxlength="8"
              @input="lateOnInput(idx)"
              @focus="lateActiveSlot = idx"
              @blur="lateCloseDropdown(idx)"
            >
            <span v-if="slot.dive" class="late-row-resolved" title="Dive matched in directory">✓</span>
            <ul v-if="lateActiveSlot === idx && lateMatchesFor(idx).length"
                class="late-autocomplete">
              <li v-for="d in lateMatchesFor(idx)"
                  :key="d.id"
                  class="late-autocomplete-item"
                  @mousedown.prevent="latePickDive(idx, d)">
                <span class="late-ac-code">{{ d.dive_code }}<span class="late-ac-pos">{{ d.position }}</span></span>
                <span class="late-ac-desc">{{ diveDescription(d) }}</span>
                <span class="late-ac-dd">DD {{ d.dd }}</span>
              </li>
            </ul>
          </div>
          <span class="late-row-meta">
            <template v-if="slot.dive">
              <span class="late-row-desc">{{ diveDescription(slot.dive) }}</span>
              <span class="late-row-dd">DD {{ slot.dive.dd }}</span>
            </template>
            <template v-else>
              <span class="dim">—</span>
            </template>
          </span>
        </div>
      </div>

      <p class="hint" v-if="lateDiveOptions.length">
        {{ lateDiveOptions.length }} dives available at {{ currentEvent?.height }}. Type a dive code + position (e.g. <strong>5132D</strong>) and pick from the list, or hit ✓ when an exact match auto-resolves.
      </p>
      <div v-if="lateErr" class="msg msg-error">{{ lateErr }}</div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
        <button class="btn btn-ghost btn-sm" @click="lateOpen = false">Cancel</button>
        <button class="btn btn-primary btn-sm"
                :disabled="lateBusy || !lateAllFilled || !lateCompetitorId"
                :title="!lateCompetitorId ? 'Pick a diver from the list above first'
                  : (!lateAllFilled ? 'Fill in a dive for every round before submitting' : '')"
                @click="submitLateEntry">
          {{ lateBusy ? 'Adding…' : `Add ${lateRounds.length}-round list` }}
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
      <div v-if="autoAdvanceCountdown > 0"
           style="font-family:var(--font-mono);font-size:12px;color:var(--cyan);margin-bottom:0.75rem">
        Auto-announcing in {{ autoAdvanceCountdown }}s
        <button class="btn btn-ghost btn-sm" style="margin-left:0.5rem" @click="cancelAutoAdvance">✕ Cancel</button>
      </div>
      <div style="display:flex;justify-content:flex-end;gap:0.5rem">
        <button class="btn btn-ghost btn-sm" @click="roundEndPromptOpen = false; cancelAutoAdvance()">Skip</button>
        <button class="btn btn-primary btn-sm" @click="announceRoundEnd">📣 Announce standings</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctrl-layout {
  /* Natural document flow — page scrolls if content exceeds the
     viewport. No 100vh / overflow:hidden lock; the operator can
     scroll like any other page. */
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
.ctrl-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.875rem 1.5rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-2);
  flex-shrink: 0;
  /* Anchor for the absolutely-positioned .ctrl-header-ctx so
     the meet name sits at the viewport's horizontal centre,
     not the centre of the leftover space between the left and
     right groups (which would shift left when the right group
     was empty, e.g. mid-meet when no Finalise button was
     showing). */
  position: relative;
}
.ctrl-body {
  flex: 1;                              /* fill the layout vertically */
  display: grid;
  /* Left + right side panels widened from 280px → 350px (+25%)
     so the history cards and Up Next tiles aren't cramped on a
     1440-class display. Centre stays 1fr — it gets whatever's
     left over and is internally min-width: 0 so the active-
     diver block can shrink past the badge column when a window
     is narrow. */
  grid-template-columns: 350px 1fr 350px;
  grid-template-rows: 1fr;              /* row fills the grid container's height */
}
.ctrl-panel {
  display: flex;
  flex-direction: column;
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
/* Pre-Meet panel head — vertical stack variant. The section
   title sits at the top; the stepper and action buttons centre-
   align below it. The previous side-by-side flex layout (label
   LEFT / contents RIGHT) was making the title wrap to two lines
   and cramping the stepper because it had to share the row with
   a 4-pip stepper + workflow button.

   Class is `pre-meet-head` (not `dive-order-head`) because the
   collapsible Dive Order accordion further down the column
   already owns the `.dive-order-head` selector; reusing the
   name here was shadowing its row-flex layout rules. */
.pre-meet-head {
  display: flex; flex-direction: column;
  align-items: center;
  gap: 0.55rem;
  text-align: center;
}
.pre-meet-actions {
  display: flex; align-items: center; justify-content: center;
  gap: 0.5rem; flex-wrap: wrap;
}
/* The stepper has its own bottom margin for non-stack contexts.
   Inside the centred stack the parent's row gap already handles
   spacing — neutralise the extra margin so the rhythm stays
   consistent. */
.pre-meet-head .wf-stepper { margin-bottom: 0; }
.panel-body {
  padding: 1rem;
}

.ctrl-centre {
  display: flex;
  flex-direction: column;
}
.active-zone {
  display: flex;
  flex-direction: column;
  padding: 1rem 1.25rem;
  background: var(--bg-2);
}
.active-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan); margin-bottom: 0.5rem; }
/* Active diver name. Significantly smaller than the original
   72px max — even on a 1440-wide monitor a 5vw clamp pushed
   the name + DD badges past a screen-height of layout. The
   active block is information dense; let it look that way. */
.active-name { font-family: var(--font-display); font-size: clamp(22px, 2.6vw, 36px); font-weight: 900; font-style: italic; color: var(--text); line-height: 1.05; margin-bottom: 0.5rem; }
/* Diving start-order ("1.") prefix in front of the active
   diver's name. Cyan + slightly smaller so the name itself
   stays the hero, but the position number is unmissable. */
.active-order {
  color: var(--cyan);
  font-style: normal;
  margin-right: 0.35em;
}
.active-badges { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.6rem; }
.active-code { font-family: var(--font-mono); font-size: 18px; font-weight: 500; padding: 0.3rem 0.65rem; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); }
.active-dd { font-family: var(--font-display); font-size: 14px; font-weight: 700; padding: 0.3rem 0.65rem; background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3); border-radius: var(--radius); color: var(--cyan); }
.active-desc { font-size: 12px; color: var(--text-3); line-height: 1.5; min-height: 22px; margin-bottom: 0.6rem; }

.judge-grid { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 0.5rem; }

/* Synchro variant of the judge grid — three labelled columns
   (Exec A / Exec B / Sync) so the operator sees who's scoring
   what role at a glance. Border colour echoes the per-group
   accents the Scoreboard view uses for its score chips, so the
   visual vocabulary stays consistent between the two surfaces. */
.judge-groups-grid {
  display: flex; gap: 0.5rem; margin-bottom: 0.5rem;
  flex-wrap: wrap;
}
.judge-group-col {
  flex: 1 1 auto; min-width: 0;
  padding: 0.35rem 0.5rem 0.45rem;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-2);
}
.judge-group-col-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.3rem;
}
.judge-group-col-tiles {
  display: flex; flex-wrap: wrap; gap: 0.35rem;
}
.judge-group-col.judge-group-a    { border-color: rgba(139, 92,246,0.35); }
.judge-group-col.judge-group-b    { border-color: rgba(245,158, 11,0.35); }
.judge-group-col.judge-group-sync { border-color: rgba( 16,185,129,0.35); }
.judge-group-col.judge-group-a    .judge-group-col-label { color: #c4b5fd; }
.judge-group-col.judge-group-b    .judge-group-col-label { color: #fbbf24; }
.judge-group-col.judge-group-sync .judge-group-col-label { color: #34d399; }
.judge-tile {
  width: 48px; height: 44px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  transition: all 0.15s;
}
.judge-tile.scored { background: var(--green-dim); border-color: var(--green); box-shadow: 0 0 12px rgba(16,185,129,0.2); }
/* Judge has tapped Signal Referee on their keypad. Bright red
   ring around the tile + pulsing glow draws the operator's eye
   regardless of what's currently scored / unscored on the
   panel. Wins over .scored when both are set (a judge can
   submit AND signal — e.g. they want a video review of the
   dive they just judged). */
.judge-tile.signaled {
  border-color: var(--red);
  box-shadow: 0 0 0 2px var(--red), 0 0 18px rgba(239,68,68,0.5);
  animation: judgeSignalPulse 1.4s ease-in-out infinite;
}
@keyframes judgeSignalPulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--red), 0 0 18px rgba(239,68,68,0.5); }
  50%      { box-shadow: 0 0 0 2px var(--red), 0 0 6px  rgba(239,68,68,0.2); }
}
.judge-tile.signaled .judge-tile-label,
.judge-tile.signaled .judge-tile-score { color: var(--red); }

/* Referee-signal banner — appears in the centre column the
   moment any judge taps "Signal Referee" on their keypad.
   Bright-red bar with the judge number(s) so the operator
   reads the alert without having to scan the judge tiles
   below. Pulses subtly so a quick glance still catches it. */
.referee-signal-banner {
  display: flex; align-items: flex-start; gap: 0.75rem;
  padding: 0.75rem 1rem;
  margin-bottom: 1rem;
  background: var(--red-dim);
  border: 1px solid var(--red);
  border-left-width: 4px;
  border-radius: var(--radius-sm);
  box-shadow: 0 0 18px rgba(239,68,68,0.25);
  animation: refereeSignalPulse 1.4s ease-in-out infinite;
  text-align: left;
}
@keyframes refereeSignalPulse {
  0%, 100% { box-shadow: 0 0 18px rgba(239,68,68,0.25); }
  50%      { box-shadow: 0 0 6px  rgba(239,68,68,0.10); }
}
.referee-signal-icon { font-size: 22px; line-height: 1.1; }
.referee-signal-body { flex: 1; min-width: 0; }
.referee-signal-title {
  font-family: var(--font-display); font-size: 11px; font-weight: 900;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--red);
  margin-bottom: 0.2rem;
}
.referee-signal-judges {
  font-family: var(--font-mono); font-size: 13px; font-weight: 700;
  color: var(--text);
  line-height: 1.4;
}
.referee-signal-hint {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  margin-top: 0.25rem;
  font-style: italic;
}
.judge-tile-label { font-family: var(--font-display); font-size: 8px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); text-transform: uppercase; }
.judge-tile.scored .judge-tile-label { color: var(--green); }
.judge-tile-score { font-family: var(--font-mono); font-size: 14px; font-weight: 500; color: var(--text-3); }
.judge-tile.scored .judge-tile-score { color: var(--text); }

/* Wrapper around the judge grid + the reserved dive-total
   slot. Kept as a single block so the bottom controls (pinned
   via .active-bottom margin-top:auto) reliably sit beneath. */
.judge-block {
  margin-bottom: 0.4rem;
}

/* Reserved slot for the live dive total. The slot is always
   present in the layout so its appearance/disappearance never
   shifts the buttons below it — the operator's eye learns the
   stable position of FAILED / CAP / RE-DIVE / NEXT. */
.active-dive-total-slot {
  min-height: 36px;
  display: flex;
  align-items: stretch;
  margin-top: 0.3rem;
}
.active-dive-total {
  flex: 1;
  display: flex; align-items: baseline; justify-content: flex-end;
  gap: 0.6rem;
  padding: 0.3rem 0.6rem;
  background: var(--green-dim);
  border: 1px solid var(--green);
  border-radius: var(--radius-sm);
}
.active-dive-total-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--text-3);
}
.active-dive-total-value {
  font-family: var(--font-display); font-size: 20px; font-weight: 900;
  font-style: italic; color: var(--green);
  line-height: 1;
}

/* Bottom controls — ref actions, nav buttons, kbd hints. */
.active-bottom {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.6rem;
}

/* (.ref-actions / .ref-btn removed — Failed Dive / Cap Score /
    Re-Dive collapsed into the Adjust ▾ dropdown next to Prev.
    F / R keyboard shortcuts still wired in onKeydown.) */

/* Bottom action row — Prev · Adjust · Next(split) · ?. Next
   takes the dominant width so it remains the primary visual
   target. Adjust + ? are auto-width pills bookending the row. */
.nav-btns {
  display: flex; align-items: stretch; gap: 0.5rem;
  width: 100%;
}
.nav-btns > * { display: flex; }
.nav-btns .split-button { flex: 1; }
.nav-btns > .btn,
.nav-btns .dropdown-host > .btn { white-space: nowrap; }

/* Split-button: wide main action + narrow ▾ aside that opens
   the auto-next picker. The two halves share a colour family
   (primary / complete) and lock visually via tightened border
   radii so they read as one component. */
.split-button {
  display: flex; align-items: stretch; min-width: 0;
}
.split-button-main {
  flex: 1; min-width: 0;
  border-top-right-radius: 0; border-bottom-right-radius: 0;
  border-right: 1px solid rgba(0, 0, 0, 0.18);
}
.split-button-aside {
  flex: 0 0 auto; padding-left: 0.7rem; padding-right: 0.7rem;
  border-top-left-radius: 0; border-bottom-left-radius: 0;
}

/* Generic overflow-menu styling for the four ⋯ / Adjust ▾ /
   ▾ / ? popovers. The host is the relative-positioned wrapper;
   the menu itself is absolutely positioned underneath. */
.dropdown-host { position: relative; }
.dropdown-menu {
  position: absolute; z-index: 50; top: calc(100% + 0.4rem);
  min-width: 200px;
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  padding: 0.3rem;
  display: flex; flex-direction: column;
  font-family: var(--font-display); font-size: 12px;
}
/* Different anchors per host — Adjust opens DOWN-and-LEFT from
   its trigger (Prev side); the autonext-, kbd-, and header-
   menus open DOWN-and-RIGHT (anchored to the right side of the
   host). bottom: 100% on the kbd menu so it pops UP rather
   than off the bottom of the viewport. */
.header-menu      { right: 0; }
.adjust-menu      { left: 0;  bottom: calc(100% + 0.4rem); top: auto; }
.autonext-menu    { right: 0; bottom: calc(100% + 0.4rem); top: auto; }
.kbd-menu         { right: 0; bottom: calc(100% + 0.4rem); top: auto; min-width: 240px; }
.dropdown-section {
  font-size: 9px; font-weight: 700; letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--text-3);
  padding: 0.4rem 0.6rem 0.2rem;
}
.dropdown-item {
  background: transparent; border: 0; cursor: pointer;
  padding: 0.55rem 0.7rem; border-radius: 4px;
  font-family: inherit; font-size: 12px; font-weight: 600;
  letter-spacing: 0.04em; color: var(--text-2);
  text-align: left; text-decoration: none;
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.6rem;
  transition: background 0.12s, color 0.12s;
}
.dropdown-item:hover { background: var(--bg-3); color: var(--text); }
.dropdown-item-active { background: var(--cyan-dim); color: var(--cyan); }
.dropdown-item-tick { color: var(--cyan); font-weight: 700; }
.dropdown-item-hint kbd {
  font-family: var(--font-mono); font-size: 10px;
  padding: 0.05rem 0.35rem;
  background: var(--bg); color: var(--text-3);
  border: 1px solid var(--border); border-radius: 3px;
}
.dropdown-item-aside {
  font-size: 10px; color: var(--text-3);
  font-family: var(--font-mono); letter-spacing: 0;
}
/* Coloured Adjust items — visually echo the original tri-button
   row: red for Failed, amber for Cap, cyan for Re-Dive. The
   colour appears on hover so the resting state stays uniform. */
.dropdown-item-danger:hover { background: var(--red-dim); color: var(--red); }
.dropdown-item-amber:hover  { background: var(--amber-dim); color: var(--amber); }
.dropdown-item-cyan:hover   { background: var(--cyan-dim); color: var(--cyan); }
/* ? popover keyboard-hint rows — full reference vs the prior
   inline chip strip. Same content, just hidden until requested. */
.kbd-row {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.3rem 0.7rem;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-2);
}
.kbd-row kbd {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  padding: 0.1rem 0.4rem;
  background: var(--bg-3); color: var(--text-2);
  border: 1px solid var(--border); border-radius: 3px;
  box-shadow: inset 0 -1px 0 var(--border-2);
  flex-shrink: 0;
}
.kbd-row-or { color: var(--text-3); margin: 0 0.1rem; }
.kbd-hints-host { margin-left: auto; }
/* Round trigger button styling for the icon-only ⋯ / ? buttons. */
.btn-icon {
  font-size: 14px; font-weight: 700;
  padding: 0.5rem 0.8rem; line-height: 1;
}

/* Header right-side cluster. */
.ctrl-header-right {
  display: flex; align-items: center; gap: 0.5rem;
}
.header-menu-host { display: flex; }

/* Auto-advance countdown affordances. Pill on the Next button
   shows the countdown without changing the button's main label
   (so the operator's eye still sees "Next Diver →" — the pill
   reads as a small "and we'll do it in 5s" badge). The button
   gets a subtle pulse so the countdown is impossible to miss.
   The Cancel button below the nav row appears only while a
   countdown is running. */
.btn-counting {
  position: relative;
  animation: btnPulse 1s ease-in-out infinite;
}
@keyframes btnPulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(6, 182, 212, 0.5); }
  50%      { box-shadow: 0 0 0 6px rgba(6, 182, 212, 0); }
}
.auto-advance-pill {
  display: inline-block;
  margin-left: 0.6rem;
  padding: 0.1rem 0.5rem;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 999px;
  font-family: var(--font-mono); font-size: 12px; font-weight: 700;
  vertical-align: middle;
}
.auto-advance-cancel {
  margin-top: 0.5rem;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3);
  align-self: stretch;
}
.auto-advance-cancel:hover { color: var(--amber); border-color: var(--amber); }
.btn-complete {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  background: var(--amber); color: var(--bg);
  padding: 0.875rem 1.5rem; border-radius: var(--radius-sm);
  border: none; cursor: pointer; transition: all 0.15s;
  grid-column: span 2;
}
.btn-complete:hover { background: #d97706; }

/* Diver Queue rows — condensed (~50% the previous vertical
   footprint). The right column gets twice as many rows in view
   at once, which is what an operator scanning what's-up-next
   actually wants. Padding halved + font sizes pulled in. */
.roster-item { padding: 0.4rem 0.6rem; background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm); cursor: pointer; transition: border-color 0.15s; margin-bottom: 0.3rem; }
.roster-item:hover { border-color: var(--border-2); }
.roster-item.active { background: var(--cyan-dim); border-color: var(--cyan); }
.roster-name { font-family: var(--font-display); font-size: 12px; font-weight: 700; color: var(--text); line-height: 1.2; }
.roster-order {
  /* Same diving-position chip as the active diver + history
     cards, sized to fit the queue row. Cyan so the eye treats
     it as a position number rather than part of the name. */
  display: inline-block;
  color: var(--cyan);
  font-family: var(--font-mono); font-weight: 700;
  margin-right: 0.3rem;
}
.roster-item.active .roster-name { color: var(--cyan); }
.roster-meta { display: flex; justify-content: space-between; font-size: 9px; color: var(--text-3); margin-top: 0.1rem; font-family: var(--font-mono); }
.roster-team {
  font-family: var(--font-mono); font-size: 9px; color: #c4b5fd;
  margin-top: 0.1rem; font-weight: 700; letter-spacing: 0.05em;
}
.roster-amp { color: var(--cyan); margin: 0 0.35em; font-weight: 400; }
.round-divider {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin: 0.75rem 0 0.5rem; padding: 0.4rem 0; border-bottom: 1px solid var(--border);
}
.round-divider:first-child { margin-top: 0; }

.active-amp { color: var(--cyan); margin: 0 0.4em; font-weight: 400; }
.active-team {
  display: inline-block; margin-bottom: 1rem;
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: #c4b5fd;
  background: rgba(139,92,246,0.10); border: 1px solid rgba(139,92,246,0.45);
  border-radius: 4px; padding: 0.3rem 0.7rem;
}

/* Club affiliations — surfaced under the diver's name in the
   active block, queue rows, and history cards. Sized down by
   tier so the active diver's club reads largest. */
.active-club {
  font-family: var(--font-mono); font-size: 14px; color: var(--text-2);
  margin-bottom: 1rem;
}
.active-club-code {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.1rem 0.4rem;
  margin-left: 0.5rem; vertical-align: middle;
}
.roster-club {
  font-family: var(--font-mono); font-size: 9px; color: var(--text-3);
  margin-top: 0.05rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.roster-club-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--cyan); margin-left: 0.4rem;
}
/* (.hist-club / .hist-club-code removed — the shared
    DiverIdentity "split" variant now renders the club line
    itself via .di-club / .di-club-code, keeping the rendering
    in one place across Control + Scoreboard.) */

.country-badge { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); background: var(--bg-3); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.5rem; vertical-align: middle; }
/* Affiliation chip in the top-right of a history card. No
   margin-left because it now sits in its own .hist-header-right
   column gap'd from the .hist-total — wedging a margin in here
   would push it off-balance. */
.hist-country { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; vertical-align: middle; }
.active-country { font-family: var(--font-display); font-size: 14px; font-weight: 700; letter-spacing: 0.15em; color: var(--text-3); background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; padding: 0.15rem 0.5rem; margin-left: 0.75rem; vertical-align: middle; }
.roster-country { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.1em; color: var(--text-3); background: var(--bg); border: 1px solid var(--border); border-radius: 3px; padding: 0.1rem 0.35rem; margin-left: 0.4rem; vertical-align: middle; }
/* Completed-Dives history cards — condensed (~50% the previous
   vertical footprint). The left column gets twice as many cards
   in view at once, which is what an operator scanning recent
   results actually wants. */
.hist-card { padding: 0.4rem 0.6rem; border-left: 2px solid var(--cyan); background: var(--bg-3); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; margin-bottom: 0.3rem; }
/* Show-more toggle for the history column. Sits beneath the
   visible cards; the resting state is a 3-card preview, click
   to expand to the full list. Same display-font styling as the
   other "Show all" toggles in the SPA so the eye recognises it
   as a list-expansion control. */
.hist-toggle {
  display: block; width: 100%;
  background: transparent; border: 1px dashed var(--border);
  color: var(--text-3); cursor: pointer;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  padding: 0.55rem 0.7rem; border-radius: var(--radius-sm);
  margin-top: 0.4rem;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.hist-toggle:hover {
  color: var(--cyan); border-color: var(--cyan);
  background: var(--cyan-dim);
}
.hist-round { font-size: 9px; color: var(--text-3); margin-bottom: 0.1rem; font-family: var(--font-mono); }
/* History card identity block — set the font-size base so the
   <DiverIdentity> component's `inherit`-based typography
   resolves to the right value (badge font-size is 0.75em of
   this, secondary line is 0.85em). */
.hist-identity { font-size: 12px; margin-bottom: 0.1rem; }

.hist-order {
  /* Diving start-order prefix (e.g. "3.") in front of the diver
     name. Cyan + condensed so it reads as a position chip
     without competing with the name itself. */
  display: inline-block;
  margin-right: 0.25rem;
  color: var(--cyan);
  font-family: var(--font-mono); font-weight: 700;
}
.hist-total { font-family: var(--font-mono); font-size: 14px; font-weight: 500; color: var(--cyan); flex-shrink: 0; }
.hist-dive-line { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.2rem; min-width: 0; }
.hist-code { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text); flex-shrink: 0; }
.hist-dd { font-family: var(--font-display); font-size: 10px; font-weight: 700; color: var(--cyan); flex-shrink: 0; }
/* Description sits inline alongside code + DD now. min-width:0
   on .hist-dive-line lets the description ellipsis when the
   card is narrow rather than overflow the column. */
.hist-desc { font-size: 9px; color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.hist-scores { display: flex; flex-wrap: wrap; gap: 0.2rem; margin-top: 0.15rem; }
.hist-score { font-family: var(--font-mono); font-size: 9px; padding: 0.1rem 0.3rem; background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.2); border-radius: 3px; color: var(--cyan); }

.conn-badge { display: flex; align-items: center; gap: 0.4rem; font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; }
.event-select-sm { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.4rem 0.75rem; font-family: var(--font-mono); font-size: 13px; color: var(--text); outline: none; cursor: pointer; }

.btn-back { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.5rem 1.1rem; border-radius: 6px; border: 1px solid var(--border); background: transparent; color: var(--text-2); text-decoration: none; transition: all 0.15s; }
.btn-back:hover { background: var(--bg-3); }
.btn-finalise { font-family: var(--font-display); font-size: 11px; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; padding: 0.5rem 1.1rem; border-radius: var(--radius-sm); border: 1px solid rgba(245,158,11,0.4); background: var(--amber-dim); color: var(--amber); cursor: pointer; transition: all 0.15s; }
.btn-finalise:hover { background: var(--amber); color: var(--bg); }

.lb-backdrop { position: fixed; inset: 0; background: rgba(3,7,18,0.95); backdrop-filter: blur(12px); z-index: 300; }

/* =========================================================
   Pre-flight review modal — last-chance summary before the
   event flips Live. Roster / panel / referee / warnings.
   ========================================================= */
.preflight-backdrop { background: rgba(3, 7, 18, 0.85); }
.preflight-modal {
  position: fixed; top: 50%; left: 50%;
  transform: translate(-50%, -50%);
  z-index: 301;
  width: calc(100% - 3rem); max-width: 560px; max-height: 90vh;
  overflow-y: auto;
  background: var(--surface);
  border: 1px solid var(--border-2);
  border-top: 4px solid var(--green);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.6);
  animation: fadeUp 0.25s ease;
  padding: 1.6rem 1.75rem 1.4rem;
}
.preflight-head { margin-bottom: 1.1rem; }
.preflight-title {
  font-family: var(--font-display);
  font-size: 12px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--green);
  margin-bottom: 0.35rem;
}
.preflight-subtitle {
  font-family: var(--font-display);
  font-size: 22px; font-weight: 800; font-style: italic;
  letter-spacing: 0.02em;
  color: var(--text);
}

.preflight-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.1rem 1.25rem;
}
@media (max-width: 520px) {
  .preflight-grid { grid-template-columns: 1fr; }
}
.preflight-section { min-width: 0; }
.preflight-label {
  font-family: var(--font-display);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.45rem;
}
.preflight-row {
  display: flex; align-items: center; gap: 0.45rem;
  flex-wrap: wrap;
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text-2);
  line-height: 1.4;
}
.preflight-strong {
  font-family: var(--font-display);
  font-size: 14px; font-weight: 700; font-style: italic;
  color: var(--text);
}
.preflight-tick {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px;
  border-radius: 50%;
  font-size: 11px; font-weight: 800;
}
.preflight-tick.ok { background: var(--green-dim); color: var(--green); }
.preflight-tick.warn { background: var(--amber-dim); color: var(--amber); }

.preflight-pill {
  display: inline-block;
  font-family: var(--font-display);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0.12em; text-transform: uppercase;
  padding: 0.18rem 0.5rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-2);
}

.preflight-detail-list {
  margin: 0.45rem 0 0;
  padding-left: 1rem;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.55;
}
.preflight-detail-list li { margin-bottom: 0.1rem; }
.preflight-overflow { color: var(--text-3); font-style: italic; }

.preflight-judges {
  display: flex; flex-wrap: wrap; gap: 0.3rem;
  margin-top: 0.45rem;
}
.preflight-judge-pill {
  font-family: var(--font-mono);
  font-size: 10.5px;
  padding: 0.1rem 0.45rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  color: var(--text-3);
}

.preflight-warnings {
  margin-top: 1.1rem;
  padding: 0.7rem 0.9rem;
  background: rgba(245, 158, 11, 0.07);
  border: 1px solid rgba(245, 158, 11, 0.3);
  border-radius: var(--radius-sm);
}
.preflight-warnings-head {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  color: var(--amber);
  margin-bottom: 0.4rem;
}
.preflight-warnings ul {
  margin: 0; padding-left: 1.1rem;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.55;
}

.preflight-actions {
  display: flex; justify-content: flex-end; gap: 0.55rem;
  margin-top: 1.4rem;
  padding-top: 1rem;
  border-top: 1px solid var(--border);
}
.preflight-go {
  background: var(--green);
  color: var(--bg);
  border: 1px solid var(--green);
  font-weight: 800; font-style: italic; letter-spacing: 0.06em;
  padding: 0.55rem 1.4rem;
}
.preflight-go:hover:not(:disabled) { filter: brightness(1.08); }
.preflight-go:disabled { opacity: 0.6; cursor: not-allowed; }
.preflight-cancel {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
}
/* Modal renders as a sibling of the backdrop in the DOM, so it
   needs its own fixed positioning + a higher z-index. The previous
   rule had no position/z-index, which buried the modal behind the
   backdrop and produced a black-screen result for late-entry,
   meet-hold, and round-end prompts. */
.lb-modal {
  position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
  z-index: 301;
  background: var(--surface); border: 1px solid var(--border-2); border-radius: 28px;
  width: calc(100% - 3rem); max-width: 560px; max-height: 90vh;
  overflow-y: auto; animation: fadeUp 0.3s ease;
  box-shadow: 0 30px 60px rgba(0,0,0,0.55);
}
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
/* Compressed centre-top meta strip — single muted line carrying
   the round + diver counters with the shot-clock anchored to
   the right. Replaces the prior three-element label-row stack
   (label + ctx pills + auto-next + status pill + clock) which
   was the busiest area of the canvas. */
.active-meta {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.75rem; margin-bottom: 0.6rem;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3); letter-spacing: 0.04em;
}
.active-meta-text strong {
  color: var(--cyan); font-weight: 700;
}
.active-meta-sep {
  margin: 0 0.4rem; color: var(--border);
}
/* Status pill that now sits inline at the end of the diver
   name row. Smaller than its old standalone form; relies on the
   diver-name's own large type to anchor visually. */
.status-pill-inline {
  font-size: 9px; padding: 0.18rem 0.5rem;
  vertical-align: middle; margin-left: 0.6rem;
  position: relative; top: -0.18em;
}
.active-label-row {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.75rem; gap: 0.75rem;
  flex-wrap: wrap;
}
.active-label-left {
  display: flex; align-items: baseline; gap: 0.6rem;
  flex-wrap: wrap;
}
.active-label-right {
  display: flex; align-items: center; gap: 0.5rem;
  flex-wrap: wrap;
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

/* Score-correction live preview — refreshes on every keystroke
   so the operator can see the impact of the edit (trim-sum
   shift, dive-points delta) before clicking Save. */
.correct-preview {
  margin-top: 0.85rem;
  padding: 0.85rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-left: 3px solid var(--cyan);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-2);
}
.correct-preview-noop {
  border-left-color: var(--text-3);
  opacity: 0.75;
}
.correct-preview-row {
  display: grid;
  grid-template-columns: 1fr auto auto auto auto;
  align-items: baseline;
  gap: 0.55rem;
  padding: 0.25rem 0;
}
.correct-preview-row.preview-points {
  font-family: var(--font-display);
  font-size: 13px; font-weight: 700;
  color: var(--text);
  border-top: 1px dashed var(--border);
  margin-top: 0.3rem;
  padding-top: 0.5rem;
}
.correct-preview-label {
  color: var(--text-3);
  font-family: var(--font-display);
  font-size: 11px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.correct-preview-dd {
  color: var(--text-3);
  font-weight: 500; letter-spacing: 0.04em;
  text-transform: none;
  font-size: 10px;
  margin-left: 0.3rem;
}
.correct-preview-old { color: var(--text-3); }
.correct-preview-arrow { color: var(--text-3); }
.correct-preview-new { color: var(--text); font-weight: 700; }
.correct-preview-delta {
  display: inline-block;
  min-width: 56px;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 0.1rem 0.45rem;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.correct-preview-delta.pos { color: var(--green); background: var(--green-dim); }
.correct-preview-delta.neg { color: var(--red);   background: var(--red-dim); }
.correct-preview-note {
  margin-top: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px dashed var(--border);
  font-size: 11.5px;
  color: var(--text-3);
  line-height: 1.45;
}

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
  font-size: 9px; padding: 0 0.3rem; line-height: 1;
  color: var(--text-3); transition: all 0.1s;
  min-width: 18px;
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

/* =========================================================
   Drag-to-reorder visual cues. The grip handle on the left of
   each row is the affordance; while a row is being dragged the
   source dims and the hover target gets a cyan inset highlight.
   ========================================================= */
.roster-grip {
  display: inline-block;
  font-family: var(--font-mono); font-weight: 700; font-size: 14px;
  color: var(--text-3); cursor: grab; user-select: none;
  letter-spacing: -2px; padding: 0 0.4rem 0 0.1rem;
  align-self: center;
}
.roster-grip:active { cursor: grabbing; }
/* Locked state — show a padlock icon instead of the grip and
   default the cursor so the operator doesn't think drag would
   work. The whole row also gets .is-locked which removes the
   hover-only border-colour pulse. */
.roster-grip-locked {
  cursor: not-allowed; font-size: 12px; color: var(--text-3);
  letter-spacing: normal;
}
.roster-item.is-locked {
  /* Make the locked rows feel slightly less interactive. */
  opacity: 0.95;
}

/* Lock badge in the queue panel header — small amber chip the
   controller sees once an event flips to Live/Completed. */
.queue-lock-badge {
  font-family: var(--font-mono); font-size: 10.5px; font-weight: 700;
  color: var(--amber); background: rgba(245,158,11,0.08);
  border: 1px solid rgba(245,158,11,0.4);
  border-radius: 3px; padding: 0.15rem 0.45rem;
  letter-spacing: 0.05em; cursor: help;
}

/* Pre-meet workflow stepper — four-pip indicator that
   renders ABOVE the action button so a new operator can
   read the whole flow at a glance instead of having to
   remember red → orange → yellow → green is "step 1 of 4".
   Done steps tick green; the active step glows cyan; future
   steps stay muted grey. The connecting dividers brighten
   too as the operator advances.

   Layout: pips inline horizontally with labels stacked
   directly under each pip. Labels-next-to-pips overflowed
   the 350px Dive Order column (≈520px content width); the
   stacked-label layout lets each step claim only
   max(pip_width, label_width) so the full stepper fits in
   ~240px. */
.wf-stepper {
  display: flex; align-items: flex-start;
  gap: 0;
  font-family: var(--font-display);
  font-size: 9.5px; font-weight: 700;
  letter-spacing: 0.05em; text-transform: uppercase;
  /* Don't grow past the parent — if a future translation
     widens labels, the stepper will scroll inside its row
     rather than push the dive-order-head off-axis. */
  max-width: 100%;
}
.wf-step {
  display: flex; flex-direction: column; align-items: center;
  gap: 4px;
  white-space: nowrap;
  /* Each step claims the natural width of pip OR label,
     whichever is larger — typically ~50px for the longest
     label ("Randomise"). */
  flex-shrink: 0;
}
.wf-step-num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px;
  border-radius: 50%;
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  letter-spacing: 0;
  border: 1.5px solid;
  flex-shrink: 0;
}
/* Done — green tick, faded label so completed steps recede. */
.wf-step.wf-step-done .wf-step-num {
  background: var(--green-dim); color: var(--green); border-color: var(--green);
}
.wf-step.wf-step-done .wf-step-label { color: var(--text-3); }
/* Active — cyan ring + bold label so the eye lands here. */
.wf-step.wf-step-active .wf-step-num {
  background: var(--cyan-dim); color: var(--cyan); border-color: var(--cyan);
  box-shadow: 0 0 0 3px rgba(6, 182, 212, 0.18);
}
.wf-step.wf-step-active .wf-step-label { color: var(--cyan); }
/* Future — quiet grey so they read as "coming up". */
.wf-step.wf-step-future .wf-step-num {
  background: transparent; color: var(--text-3); border-color: var(--border);
}
.wf-step.wf-step-future .wf-step-label { color: var(--text-3); }
/* Connecting line between pips. Lights up green for the
   transitions that have already happened. With the column
   stepper layout (pip on top, label below) the parent uses
   align-items: flex-start, so the divider gets a top margin
   equal to half the pip height (22 / 2 - 1 ≈ 10 px) to sit
   horizontally aligned with the pip centres. */
.wf-step-divider {
  flex: 0 0 auto; width: 16px; height: 2px;
  background: var(--border);
  margin: 10px 4px 0;
  border-radius: 1px;
  transition: background 0.2s;
}
.wf-step-divider.wf-divider-done { background: var(--green); }

/* Pre-meet 3-state workflow button — the same control cycles
   through randomise (red) → referee sign-off (yellow) → start
   event (green) so the operator only ever has one obvious next
   action. Solid backgrounds (not the usual ghost) so the colour
   carries the meaning even in a noisy header. */
.wf-btn {
  font-family: var(--font-display); font-weight: 800; font-style: italic;
  letter-spacing: 0.06em; text-transform: uppercase;
  border-radius: 4px; padding: 0.35rem 0.85rem;
  border: 1px solid; color: var(--bg);
  cursor: pointer; transition: filter 0.15s ease;
}
.wf-btn:hover:not(:disabled) { filter: brightness(1.08); }
.wf-btn:disabled { opacity: 0.55; cursor: not-allowed; }
.wf-btn-red    { background: var(--red);   border-color: var(--red); }
/* Orange — sits between red (check-in) and yellow (referee
   gate) on the spectrum so the operator reads the workflow as a
   gradient progressing toward green. No global --orange var, so
   inlined here. */
.wf-btn-orange { background: #fb923c;      border-color: #fb923c;     }
.wf-btn-yellow { background: var(--amber); border-color: var(--amber); }
.wf-btn-green  { background: var(--green); border-color: var(--green); }
/* Ghost-link affordances — Skip-randomise (state 1) and Reset
   (states 2/3). Smaller / quieter than the main button so the
   primary action stays the focus. */
.wf-skip, .wf-reset {
  font-size: 11px; color: var(--text-3);
  padding: 0.25rem 0.55rem;
}
.wf-live-badge {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--green); background: rgba(34,197,94,0.08);
  border: 1px solid rgba(34,197,94,0.5);
  border-radius: 3px; padding: 0.18rem 0.55rem;
  letter-spacing: 0.05em;
}
.roster-item.is-dragging   { opacity: 0.4; }
.roster-item.is-drop-target {
  border-color: var(--cyan);
  box-shadow: 0 0 0 1px var(--cyan) inset;
}
.roster-row-head {
  display: flex; align-items: stretch; gap: 0.25rem;
}


.late-modal { max-width: 600px; }

/* =========================================================
   Check-in modal — pre-meet door pass list. Each row has the
   diver's name + chip group. The chip colour leans on the
   status semantics (cyan = present, amber = late, red = DNS).
   ========================================================= */
.checkin-modal { max-width: 720px; }
.signoff-modal { max-width: 540px; }
.signoff-tabs {
  display: flex; gap: 0.4rem; margin-bottom: 1rem;
  border-bottom: 1px solid var(--border);
}
.signoff-tab {
  flex: 1; padding: 0.6rem 0.8rem; cursor: pointer;
  background: transparent; border: none;
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  letter-spacing: 0.06em; color: var(--text-3);
  border-bottom: 2px solid transparent; margin-bottom: -1px;
  transition: color 0.15s ease, border-color 0.15s ease;
}
.signoff-tab:hover:not(:disabled) { color: var(--text-2); }
.signoff-tab.is-active { color: var(--cyan); border-bottom-color: var(--cyan); }
.signoff-tab:disabled { opacity: 0.5; cursor: not-allowed; }
.signoff-pane { padding: 0.4rem 0; }
.signoff-pane .hint { color: var(--text-3); font-size: 12.5px; line-height: 1.6; margin-bottom: 1rem; }
.signoff-pane .select { width: 100%; }
.cred-fields { display: flex; flex-direction: column; gap: 0.7rem; margin-bottom: 1rem; }
.signoff-actions { display: flex; justify-content: flex-end; margin-top: 1rem; }
.signoff-waiting {
  text-align: center; padding: 2rem 1rem; color: var(--amber);
  font-family: var(--font-display); font-size: 14px; font-style: italic;
}
.signoff-waiting-pulse {
  font-size: 28px; line-height: 1;
  animation: signoff-pulse 1.5s ease-in-out infinite;
  margin-bottom: 0.5rem;
}
.signoff-waiting-hint {
  margin-top: 0.7rem; font-size: 11.5px; color: var(--text-3);
  font-style: normal;
}
/* Cut 3 code display — QR on the left, big monospace digits on
   the right. Two-column flex with a vertical "or" divider in
   between; collapses to a vertical stack on narrow modals. */
.signoff-code-display {
  text-align: center; padding: 1.2rem 0.5rem;
}
.signoff-code-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.9rem;
}
.signoff-code-grid {
  display: flex; align-items: center; justify-content: center;
  gap: 1.2rem; flex-wrap: wrap;
  margin-bottom: 1rem;
}
.signoff-code-qr-block,
.signoff-code-text-block {
  display: flex; flex-direction: column; align-items: center;
  gap: 0.4rem;
}
/* The QR <img> is rendered server-side at 256×256 px; constrain
   here so it sits comfortably inside the modal but stays large
   enough to scan from across a venue. White background keeps
   the QR contrast readable on the modal's dark surface. */
.signoff-code-qr {
  width: 180px; height: 180px;
  background: #fff; padding: 8px;
  border-radius: 6px;
  box-shadow: 0 0 0 1px var(--border);
}
.signoff-code-qr-caption,
.signoff-code-text-caption {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.14em; text-transform: uppercase; color: var(--text-3);
}
.signoff-code-text-caption code {
  background: var(--bg-3); padding: 0.05rem 0.35rem;
  border-radius: 3px; font-size: 10px;
  font-family: var(--font-mono); color: var(--text-2);
  letter-spacing: 0;
}
.signoff-code-divider {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
  padding: 0 0.5rem;
}
.signoff-code-value {
  font-family: var(--font-mono); font-size: 44px; font-weight: 800;
  letter-spacing: 0.18em; color: var(--cyan); line-height: 1;
}
.signoff-code-hint {
  font-size: 11.5px; color: var(--text-3); line-height: 1.5;
}
.signoff-code-hint code {
  background: var(--bg-3); padding: 0.05rem 0.35rem;
  border-radius: 3px; font-size: 11px;
}
.signoff-enforced-banner {
  background: rgba(245, 158, 11, 0.08);
  border: 1px solid rgba(245, 158, 11, 0.4);
  color: var(--amber);
  border-radius: 4px; padding: 0.6rem 0.8rem;
  font-size: 12.5px; line-height: 1.45;
  margin-bottom: 0.8rem;
}
@keyframes signoff-pulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50%      { opacity: 1;   transform: scale(1.15); }
}
.lb-footer {
  display: flex; align-items: center; justify-content: space-between;
  gap: 1rem; padding: 1rem 2rem; border-top: 1px solid var(--border);
  background: var(--surface); position: sticky; bottom: 0;
}
.checkin-footer-hint { font-size: 12px; color: var(--text-3); }
.checkin-tally {
  display: inline-flex; gap: 0.6rem; margin-left: 0.8rem;
  font-family: var(--font-mono); font-size: 11px; font-weight: 400;
  vertical-align: middle;
}
.checkin-tally .tally-present { color: #06b6d4; }
.checkin-tally .tally-late    { color: #f59e0b; }
.checkin-tally .tally-absent  { color: #ef4444; }
.checkin-tally .tally-pending { color: var(--text-3); }

.checkin-list {
  display: flex; flex-direction: column; gap: 0.4rem;
  max-height: 60vh; overflow-y: auto;
}
.checkin-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.6rem; padding: 0.55rem 0.7rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.checkin-row.checkin-present { border-color: rgba(6,182,212,0.4);  background: rgba(6,182,212,0.05); }
.checkin-row.checkin-late    { border-color: rgba(245,158,11,0.4); background: rgba(245,158,11,0.05); }
.checkin-row.checkin-absent  { border-color: rgba(239,68,68,0.4);  background: rgba(239,68,68,0.05); opacity: 0.75; }
.checkin-name {
  font-family: var(--font-display); font-weight: 700; color: var(--text);
  font-size: 13px; min-width: 0;
}
.checkin-country {
  font-family: var(--font-mono); font-size: 10px; font-weight: 400;
  color: var(--text-3); margin-left: 0.4rem;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.05rem 0.35rem;
  vertical-align: middle;
}
.checkin-club {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
  font-weight: 400; margin-top: 0.15rem;
}
.checkin-club-code {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.05rem 0.3rem; margin-left: 0.3rem;
}
.checkin-chips { display: flex; gap: 0.3rem; flex-shrink: 0; }
.checkin-chips .chip {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  padding: 0.3rem 0.55rem;
  background: var(--surface); border: 1px solid var(--border);
  color: var(--text-3); border-radius: var(--radius-sm);
  cursor: pointer; transition: all 0.1s;
}
.checkin-chips .chip:hover { border-color: var(--text-2); color: var(--text-2); }
.checkin-chips .chip.chip-present.is-active {
  background: rgba(6,182,212,0.15); border-color: rgba(6,182,212,0.5); color: #06b6d4;
}
.checkin-chips .chip.chip-late.is-active {
  background: rgba(245,158,11,0.15); border-color: rgba(245,158,11,0.5); color: #f59e0b;
}
.checkin-chips .chip.chip-absent.is-active {
  background: rgba(239,68,68,0.15); border-color: rgba(239,68,68,0.5); color: #ef4444;
}

@media (max-width: 720px) {
  .checkin-row { flex-direction: column; align-items: stretch; }
  .checkin-chips { justify-content: space-between; }
}
.late-modal .hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.5rem 0.7rem; margin-top: 0.4rem;
  background: var(--bg-3); border-left: 3px solid var(--cyan); border-radius: 3px;
}
.late-modal .hint strong { color: var(--cyan); font-family: var(--font-mono); }

/* Per-round dive list inside the late-entry modal. One row per
   round of the event; each row has a number gutter, an autocomplete
   text input, and a resolved-dive description on the right. */
.late-rounds {
  display: flex; flex-direction: column; gap: 0.4rem;
  margin-top: 0.75rem;
}
.late-rounds-head {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 0.4rem;
}
.late-rounds-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.22em; text-transform: uppercase; color: var(--text-3);
}
.late-rounds-height {
  font-family: var(--font-mono); font-size: 10px; font-weight: 400;
  letter-spacing: 0.05em; color: var(--cyan); margin-left: 0.5rem;
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.4);
  border-radius: 3px; padding: 0.05rem 0.4rem; vertical-align: middle;
}
.late-rounds-dd {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.late-rounds-dd strong { color: var(--cyan); font-weight: 700; margin-left: 0.25rem; }

.late-row {
  display: grid; grid-template-columns: 28px 140px 1fr;
  align-items: center; gap: 0.6rem;
  padding: 0.4rem 0.5rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.late-row-num {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--cyan); text-align: center;
}
.late-row-input-wrap { position: relative; }
.late-row-input-wrap > .input {
  font-family: var(--font-mono); font-size: 13px; padding-right: 1.6rem;
  text-transform: uppercase;
}
.late-row-resolved {
  position: absolute; right: 0.6rem; top: 50%; transform: translateY(-50%);
  color: var(--cyan); font-weight: 700; font-size: 12px; pointer-events: none;
}
.late-row-meta {
  display: flex; align-items: baseline; gap: 0.5rem; min-width: 0;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2);
}
.late-row-desc {
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.late-row-dd { color: var(--cyan); flex-shrink: 0; }

.late-autocomplete {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 5;
  margin: 0.3rem 0 0; padding: 0;
  background: var(--surface); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 12px 28px rgba(0,0,0,0.5);
  max-height: 240px; overflow-y: auto; list-style: none;
}
.late-autocomplete-item {
  display: grid; grid-template-columns: 70px 1fr auto;
  align-items: center; gap: 0.6rem;
  padding: 0.5rem 0.7rem;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
  font-family: var(--font-mono); font-size: 12px;
}
.late-autocomplete-item:last-child { border-bottom: none; }
.late-autocomplete-item:hover { background: var(--bg-3); }
.late-ac-code { font-weight: 700; color: var(--text); }
.late-ac-pos  { color: var(--cyan); margin-left: 0.1rem; }
.late-ac-desc { color: var(--text-2);
                white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.late-ac-dd   { color: var(--cyan); font-weight: 700; }

@media (max-width: 720px) {
  .late-modal { max-width: calc(100vw - 1.5rem); }
  .late-row { grid-template-columns: 24px 1fr; }
  .late-row-meta {
    grid-column: 1 / -1; padding-left: 30px;
    font-size: 11px;
  }
}

/* =========================================================
   Up Next — primary right-panel surface during live scoring.
   Sits above the standings preview + the collapsed Dive Order
   panel. Renders the next 3 (or all) divers as click-to-jump
   button rows, mirroring the spectator scoreboard's Up Next
   panel layout so the operator + audience read the same shape.
   ========================================================= */
.up-next-panel {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  background: var(--bg-3);
  flex-shrink: 0;
}
.up-next-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 0.5rem; gap: 0.5rem;
}
.up-next-panel-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--cyan);
}
/* (.up-next-toggle in the panel head retired — the toggle now
    lives INSIDE the list as .up-next-anchor-toggle, anchored
    after the (UP_NEXT_DEFAULT_LIMIT)th row so expanding the
    list drops extra rows DOWN-WARD rather than shoving the
    toggle off the operator's eye-line.) */
.up-next-list {
  display: flex; flex-direction: column; gap: 0.3rem;
}
/* Anchored toggle — same visual language as .hist-toggle.
   Fits inside the .up-next-list flex column so the row gap
   spacing is preserved. Dashed border + display-font copy
   reads as "list-expansion control" without competing with
   the row buttons above. */
.up-next-anchor-toggle {
  display: block; width: 100%;
  background: transparent; border: 1px dashed var(--border);
  color: var(--text-3); cursor: pointer;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  padding: 0.55rem 0.7rem; border-radius: var(--radius-sm);
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.up-next-anchor-toggle:hover {
  color: var(--cyan); border-color: var(--cyan);
  background: var(--cyan-dim);
}
.up-next-row-btn {
  display: flex; flex-direction: column; gap: 0.2rem;
  padding: 0.45rem 0.6rem;
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer; transition: border-color 0.15s;
  text-align: left; color: var(--text);
  font-family: inherit; font-size: 12px;
  width: 100%;
}
.up-next-row-btn:hover:not(:disabled) {
  border-color: var(--cyan);
  background: var(--cyan-dim);
}
.up-next-row-btn:disabled { cursor: default; opacity: 0.5; }
/* Up Next tile is two columns: R# label on the LEFT, the
   identity stack (names + club + dive header line) on the
   right. By nesting the dive header inside the same right
   column as DiverIdentity, the dive code aligns with the
   name + club above it instead of starting at the tile's
   left edge under R#. Inheritable font-size sets the identity
   block's baseline to 12px (badge resolves to 9px, secondary
   line ~10px). */
.up-next-row-grid {
  display: flex; align-items: flex-start; gap: 0.4rem;
  font-size: 12px;
}
.up-next-row-stack {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 0.2rem;
}
.up-next-identity { flex: 1; min-width: 0; }
/* Bottom row: dive code + DD anchored to the LEFT, dive
   description filling the remaining space to the right. The
   description gets min-width:0 + ellipsis so a long action
   ("Reverse Flying 2½ Somersaults") doesn't push the row
   wider than the column or wrap onto a new line. */
.up-next-row-bot {
  display: flex; gap: 0.6rem;
  justify-content: flex-start;
  align-items: baseline;
  min-width: 0;
}
.up-next-row-rd {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.04em; color: var(--text-3);
  line-height: 1.25;
}
.up-next-row-code {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-2);
  flex-shrink: 0;
}
.up-next-row-dd {
  font-family: var(--font-display); font-size: 10px; color: var(--cyan);
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.up-next-row-desc {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}

/* =========================================================
   Dive Order — the collapsed-by-default full roster panel
   that lives below Up Next. Pre-meet setup + manual jumps
   only; live scoring leans on Up Next above.
   ========================================================= */
.dive-order-panel {
  display: flex; flex-direction: column; min-height: 0;
}
.dive-order-head {
  display: flex; align-items: center; gap: 0.5rem;
  width: 100%;
  background: var(--bg-3); border: none;
  border-bottom: 1px solid var(--border);
  padding: 0.7rem 1rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-2);
  cursor: pointer; text-align: left;
  transition: background 0.15s;
}
.dive-order-head:hover { background: var(--bg-2); color: var(--text); }
.dive-order-caret {
  display: inline-block; width: 12px;
  color: var(--text-3); font-size: 10px;
}
.dive-order-title { flex: 1; }
/* Lock badge variant when nested in this header — the base
   .queue-lock-badge styles still carry the colour + chip look;
   this rule just keeps the chip from picking up the parent
   header's letter-spacing / uppercase / display-font, since the
   badge already has its own typography. */
.dive-order-lock-badge {
  font-family: var(--font-mono);
  letter-spacing: 0.05em;
  text-transform: none;
}
.dive-order-count {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  letter-spacing: 0;
}
.dive-order-body {
  display: flex; flex-direction: column; min-height: 0;
}

/* =========================================================
   Standings preview — top 5 inline above the dive order panel.
   Collapsible header mirrors the .dive-order-head pattern below
   so both bottom-half right-panel sections feel the same. The
   panel is expanded by default; a click on the header toggles
   showStandingsProjection (persisted per browser).
   ========================================================= */
/* Reserves panel — surfaces between Up Next and Standings on
   advanced events (semi-final / final) when the operator
   advanced with reserves. Subtle amber accent so it reads as
   secondary to Up Next but more prominent than Standings. */
.reserves-panel {
  display: flex; flex-direction: column;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 200, 87, 0.04);
  flex-shrink: 0;
}
.reserves-head {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.5rem 0.85rem;
  background: transparent; border: none; cursor: pointer;
  font: inherit; text-align: left; color: #ffc857;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.08em; text-transform: uppercase;
}
.reserves-head:hover { background: rgba(255, 200, 87, 0.08); }
.reserves-head-label { flex: 1; }
.reserves-head-count {
  font-family: var(--font-mono); font-size: 10px; font-weight: normal;
  letter-spacing: 0; color: #ffc857;
  background: rgba(255, 200, 87, 0.12);
  padding: 0.1rem 0.45rem; border-radius: 999px;
}
.reserves-head-chevron { color: var(--text-3); font-size: 12px; }
.reserves-list {
  display: flex; flex-direction: column; gap: 0.4rem;
  padding: 0 0.6rem 0.6rem;
}
.reserves-row {
  border: 1px solid rgba(255, 200, 87, 0.25);
  border-radius: var(--radius-sm);
  padding: 0.45rem 0.6rem;
  background: var(--bg-3);
}
.reserves-row-head {
  display: flex; align-items: center; gap: 0.5rem;
  margin-bottom: 0.4rem;
  font-family: var(--font-mono); font-size: 12px;
}
.reserves-row-pos {
  color: #ffc857;
  font-weight: bold;
  background: rgba(255, 200, 87, 0.12);
  padding: 0.1rem 0.4rem; border-radius: 4px;
  font-size: 11px;
}
.reserves-row-name { flex: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.reserves-row-club {
  color: var(--text-3); font-size: 10px;
  background: rgba(255,255,255,0.04);
  padding: 0.1rem 0.4rem; border-radius: 4px;
}
.reserves-row-actions {
  display: flex; gap: 0.4rem; align-items: center;
}
.reserves-row-select {
  flex: 1; font-size: 11px; padding: 0.3rem 0.5rem;
}

.standings-preview {
  display: flex; flex-direction: column;
  border-bottom: 1px solid var(--border);
  background: var(--bg-3);
  flex-shrink: 0;
}
.standings-head {
  display: flex; align-items: center; gap: 0.5rem;
  width: 100%;
  background: transparent; border: none;
  padding: 0.7rem 1rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-2);
  cursor: pointer; text-align: left;
  transition: background 0.15s;
}
.standings-head:hover { background: var(--bg-2); color: var(--text); }
.standings-caret {
  display: inline-block; width: 12px;
  color: var(--text-3); font-size: 10px;
}
.standings-title { flex: 1; }
.standings-count {
  font-family: var(--font-mono); font-size: 10px; color: var(--text-3);
  letter-spacing: 0;
}
.standings-body {
  padding: 0 1rem 0.75rem;
}

/* Projected-leader hint under the standings preview. */
.projection-line {
  font-family: var(--font-mono); font-size: 11.5px;
  color: var(--text-2); line-height: 1.45;
  margin-top: 0.5rem; padding: 0.4rem 0.6rem;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.projection-line strong { color: var(--text); }
.projection-line.projection-lead {
  background: rgba(234,179,8,0.06); border-color: rgba(234,179,8,0.3);
}
.projection-line.projection-lead strong { color: #f59e0b; }
.projection-line.projection-chase {
  background: var(--cyan-dim); border-color: rgba(6,182,212,0.3);
}
.projection-line.projection-chase strong { color: var(--cyan); }
.projection-line.projection-pre,
.projection-line.projection-unopposed {
  color: var(--text-3); font-style: italic;
}
/* Per-dive / per-judge breakdown line beneath the headline gap. */
.projection-detail {
  font-family: var(--font-mono); font-size: 10.5px;
  color: var(--text-3); margin-top: 0.25rem;
  letter-spacing: 0.02em;
}
.projection-detail strong {
  color: var(--text-2);
  font-weight: 700;
}
/* Catch-up table — one row per podium target with the average
   judge score the active diver needs across the remaining dives.
   Layout is rank | name | target so the eye reads "1st (Anna &
   Bella) avg 8.5" left to right at a glance. */
.projection-head {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3); margin-bottom: 0.4rem;
  letter-spacing: 0.02em;
}
.catchup-row {
  display: grid;
  grid-template-columns: 28px 1fr auto;
  align-items: baseline; gap: 0.5rem;
  padding: 0.2rem 0; font-size: 12px;
}
.catchup-rank {
  font-family: var(--font-display); font-weight: 800; font-style: italic;
  font-size: 11px; letter-spacing: 0.04em; color: var(--text-2);
}
.catchup-name {
  color: var(--text); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
  min-width: 0;
}
.catchup-target {
  font-family: var(--font-mono); font-size: 11px; font-weight: 700;
  color: var(--cyan);
}
.catchup-target.catchup-impossible {
  color: var(--red); font-weight: 600; font-style: italic;
}
.sp-amp { color: var(--cyan); margin: 0 0.25em; font-weight: 400; }
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
   Judge tile fine-tuning + name label under each. The base
   .judge-tile rule sets the box at 48×44; this block adds the
   submitter name (truncated) underneath and a position:relative
   for the signal-active ring overlay.
   ========================================================= */
.judge-tile {
  position: relative;
}
.judge-tile-name {
  font-family: var(--font-mono); font-size: 8px;
  color: var(--text-3); margin-top: 0.05rem;
  max-width: 44px;
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

/* =========================================================
   Header context — meet name + round/diver position badges
   ========================================================= */
.ctrl-header-ctx {
  /* Absolutely centred on the header so the meet name's
     horizontal position is anchored to the viewport, not to
     the gap between the left and right header groups.
     Previously was flex: 1 + justify-content: center, which
     centred the name between the groups — visually off-axis
     whenever the two groups had different content widths
     (left group is fixed: logo + picker + connection chip;
     right group toggles between empty / one button / two
     buttons). */
  position: absolute;
  left: 50%; top: 50%;
  transform: translate(-50%, -50%);
  display: flex; align-items: center; gap: 0.6rem;
  /* Cap so a very long meet name truncates via the ellipsis
     on .ctx-meet rather than overlapping the side groups. */
  max-width: min(50vw, 600px);
  /* Header chrome lives behind / around the centred name; let
     mouse events pass through the empty space of the ctx box
     to anything beneath. The text itself re-enables pointer
     events so a future :hover tooltip still works. */
  pointer-events: none;
}
.ctx-meet {
  font-family: var(--font-display); font-size: 16px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3);
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  pointer-events: auto;
}
.ctx-badge {
  font-family: var(--font-display); font-size: 10px; font-weight: 900;
  letter-spacing: 0.18em; text-transform: uppercase;
  padding: 0.2rem 0.5rem; border-radius: 3px;
  background: var(--bg-3); border: 1px solid var(--border); color: var(--text-2);
  flex-shrink: 0;
}

/* =========================================================
   Active-diver status pill (READY / DIVING / JUDGING)
   ========================================================= */
.status-pill {
  font-family: var(--font-display); font-size: 11px; font-weight: 900;
  letter-spacing: 0.2em; padding: 0.35rem 0.7rem;
  border-radius: 3px; cursor: pointer; border: 1px solid transparent;
  transition: all 0.1s;
}
.status-pill.status-ready   { background: var(--bg-3); color: var(--text-2); border-color: var(--border); }
.status-pill.status-diving  { background: var(--cyan); color: var(--bg); animation: pulse-cyan 1s infinite; }
.status-pill.status-judging { background: var(--amber); color: var(--bg); }
@keyframes pulse-cyan { 0%,100% { opacity: 1; } 50% { opacity: 0.6; } }

/* =========================================================
   Operator broadcast mode — chromeless projector layout
   /control?broadcast=1 hides the queue + history columns and
   leaves just the active-diver centre column at full size,
   suitable for a back-of-house screen.
   ========================================================= */
.ctrl-broadcast .ctrl-header,
.ctrl-broadcast .hold-banner { display: none; }
.ctrl-broadcast .ctrl-body {
  grid-template-columns: 1fr;        /* drop side panels */
}
.ctrl-broadcast .ctrl-panel { display: none; }
.ctrl-broadcast .active-zone { padding: 3rem; }
.ctrl-broadcast .active-name { font-size: clamp(56px, 9vw, 140px); }
.ctrl-broadcast .judge-tile  { width: 110px; height: 110px; }
.ctrl-broadcast .judge-tile-score { font-size: 32px; }
.ctrl-broadcast .ref-actions,
.ctrl-broadcast .nav-btns,
.ctrl-broadcast .kbd-hints { display: none; }

.ops-broadcast-exit {
  position: fixed; top: 1rem; right: 1rem; z-index: 90;
  width: 36px; height: 36px;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0,0,0,0.4); color: var(--text-3);
  border: 1px solid var(--border); border-radius: 50%;
  font-family: var(--font-mono); font-size: 16px; font-weight: 700;
  text-decoration: none;
  opacity: 0.25; transition: opacity 0.2s;
}
.ops-broadcast-exit:hover { opacity: 1; color: var(--cyan); border-color: var(--cyan); }

/* (.kbd-hints / .kbd-hints kbd removed — the inline chip strip
    that used to live below the Next Diver row is gone. The same
    information is available from the ? popover next to Next
    Diver via .kbd-row, which renders only on demand.) */


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
