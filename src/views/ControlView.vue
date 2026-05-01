<script setup>
import { ref, onMounted, onUnmounted } from 'vue'
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

// Socket connection
socket.on('connect', () => { connStatus.value = true })
socket.on('disconnect', () => { connStatus.value = false })

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
    updateNextButton(true)
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

  historyCards.value.unshift({ name, country, dive_code, position, dd, desc, round: data.round_number, total_rounds, scores, total })
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

  const [rosterData, histData] = await Promise.all([
    auth.apiFetch(`/api/events/${selectedEventId.value}/roster`),
    auth.apiFetch(`/api/events/${selectedEventId.value}/history`),
  ])
  roster.value = rosterData

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
    })
  })

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
        <RouterLink to="/dashboard" class="btn-back">← Dashboard</RouterLink>
        <button
          v-if="finaliseBtnShow"
          class="btn-finalise"
          @click="currentEvent?.status === 'Completed' ? showLeaderboard() : finaliseEvent()"
        >{{ finaliseBtnText }}</button>
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
        <div class="panel-body">
          <div v-for="(card, idx) in historyCards" :key="idx" class="hist-card">
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
          <div class="active-label">
            Currently on Board<span v-if="activeInfo.round_number" class="active-round">— Round {{ activeInfo.round_number }}</span>
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
              >
                <div class="judge-tile-label">J{{ tile.judgeIndex }}</div>
                <div class="judge-tile-score">{{ tile.score }}</div>
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
        <div class="panel-head" style="display:flex;justify-content:space-between">
          <span>Diver Queue</span>
          <span class="roster-count">{{ roster.length ? currentIndex + 1 : 0 }}/{{ roster.length }}</span>
        </div>
        <div class="panel-body">
          <template v-for="(item, idx) in roster" :key="idx">
            <!-- Round divider when round_number changes -->
            <div v-if="idx === 0 || roster[idx - 1].round_number !== item.round_number"
                 class="round-divider">
              Round {{ item.round_number }}
            </div>
            <div
              :class="['roster-item', idx === currentIndex ? 'active' : '']"
              @click="setActive(idx)"
            >
              <div class="roster-name">
                {{ item.full_name }}<span v-if="item.country_code" class="roster-country">{{ item.country_code }}</span>
                <template v-if="item.partner_name">
                  <span class="roster-amp">&amp;</span>
                  {{ item.partner_name }}
                </template>
              </div>
              <div v-if="item.team_name" class="roster-team">{{ item.team_name }}</div>
              <div class="roster-meta">
                <span>{{ item.dive_code }}{{ item.position }}</span>
                <span>DD {{ item.dd }}</span>
              </div>
            </div>
          </template>
        </div>
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
