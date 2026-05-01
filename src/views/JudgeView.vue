<script setup>
import { ref, computed } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'

const route = useRoute()
const auth = useAuthStore()
const socket = useSocket()

const user = auth.user

const currentScore = ref(0)
const isHalf = ref(false)
const activeDiver = ref(null)
const judgeLabel = ref(user?.full_name || 'Judge')
const connStatus = ref(false)
const submitted = ref(false)
const judgeNumber = ref(null)
const pendingScore = ref(null)

const displayValue = computed(() => {
  const val = currentScore.value + (isHalf.value ? 0.5 : 0)
  return val % 1 === 0 ? val.toString() : val.toFixed(1)
})

const scoreIsZero = computed(() => (currentScore.value + (isHalf.value ? 0.5 : 0)) === 0)

// Synchro role — derived from this judge's position in the panel.
// Lets the judge see whether they should be scoring Diver A's
// execution, Diver B's execution, or the synchronisation.
const synchroRole = computed(() => {
  if (activeDiver.value?.event_type !== 'synchro_pair') return null
  const n = judgeNumber.value
  const total = activeDiver.value?.number_of_judges
  if (!n || !total) return null
  if (total === 9) {
    if (n <= 2) return { label: 'EXEC A', tone: 'a' }
    if (n <= 4) return { label: 'EXEC B', tone: 'b' }
    if (n <= 9) return { label: 'SYNCHRONISATION', tone: 'sync' }
  } else if (total === 11) {
    if (n <= 3) return { label: 'EXEC A', tone: 'a' }
    if (n <= 6) return { label: 'EXEC B', tone: 'b' }
    if (n <= 11) return { label: 'SYNCHRONISATION', tone: 'sync' }
  }
  return null
})

socket.on('connect', () => {
  connStatus.value = true
  if (pendingScore.value) {
    socket.emit('submit_score', pendingScore.value)
    pendingScore.value = null
  }
})
socket.on('disconnect', () => { connStatus.value = false })

socket.on('state_update', async (data) => {
  activeDiver.value = data
  resetScore()

  if (data.event_id) {
    try {
      const res = await fetch(`/api/events/${data.event_id}/my-judge-number`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      })
      if (res.ok) {
        const { judge_number } = await res.json()
        judgeNumber.value = judge_number
        activeDiver.value = { ...activeDiver.value, judge_number }
        judgeLabel.value = `${user?.full_name} — J${judge_number}`
      }
    } catch { /* show name only */ }
  }
})

function pressNumber(n) {
  currentScore.value = n
  if (n === 10) {
    isHalf.value = false
  }
}

function toggleHalf() {
  if (currentScore.value === 10) return
  isHalf.value = !isHalf.value
}

function resetScore() {
  currentScore.value = 0
  isHalf.value = false
  submitted.value = false
}

function submitScore() {
  if (!activeDiver.value) {
    alert('Waiting for an active diver — please wait for the control room to set the current diver.')
    return
  }
  const finalScore = currentScore.value + (isHalf.value ? 0.5 : 0)
  const payload = {
    event_id: activeDiver.value.event_id,
    competitor_id: activeDiver.value.competitor_id,
    round_number: activeDiver.value.round_number,
    dive_id: activeDiver.value.dive_id || null,
    judge_id: user?.id,
    judge_number: activeDiver.value.judge_number || null,
    score: finalScore,
  }
  if (socket.connected) {
    socket.emit('submit_score', payload)
  } else {
    pendingScore.value = payload
  }
  submitted.value = true
}

const submitLabel = computed(() => {
  if (pendingScore.value) return '⏳ Reconnecting — will send automatically'
  if (submitted.value) {
    const val = currentScore.value + (isHalf.value ? 0.5 : 0)
    return `✓ Submitted — ${val % 1 === 0 ? val : val.toFixed(1)}`
  }
  return 'Lock & Submit'
})
</script>

<template>
  <div class="judge-layout">
    <!-- Connection banner — flips on whenever the socket is
         disconnected. Critical for poolside wifi reliability:
         judges need to know if a tap actually sent. -->
    <div v-if="!socket.isConnected.value" class="conn-banner">
      <span class="conn-dot"></span>
      Reconnecting… your last score may not have sent
    </div>
    <!-- Header -->
    <div class="judge-header">
      <div class="header-top">
        <div>
          <div class="event-name">{{ activeDiver?.eventName || '—' }}</div>
          <div class="diver-name">
            <template v-if="activeDiver?.partner_name">
              {{ activeDiver.diverName }}<span v-if="activeDiver?.country_code" class="diver-country">{{ activeDiver.country_code }}</span>
              <span class="diver-amp">&amp;</span>
              {{ activeDiver.partner_name }}<span v-if="activeDiver?.partner_country" class="diver-country">{{ activeDiver.partner_country }}</span>
            </template>
            <template v-else>
              {{ activeDiver?.diverName || 'Waiting for diver...' }}<span v-if="activeDiver?.country_code" class="diver-country">{{ activeDiver.country_code }}</span>
            </template>
          </div>
          <div v-if="activeDiver?.team_name" class="judge-team-line">
            Team: <strong>{{ activeDiver.team_name }}</strong>
          </div>
          <div v-if="synchroRole" :class="['synchro-role', `role-${synchroRole.tone}`]">
            You are scoring: <strong>{{ synchroRole.label }}</strong>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem">
          <div class="judge-id">
            <span class="status-dot" :class="{ connected: connStatus }"></span>
            <span>{{ judgeLabel }}</span>
          </div>
          <RouterLink to="/dashboard" class="btn-back-judge">← Dashboard</RouterLink>
        </div>
      </div>
      <div class="dive-info-row">
        <span class="dive-pill code">{{ activeDiver?.diveCode || '—' }}</span>
        <span class="dive-pill dd">{{ activeDiver?.dd ? `DD ${activeDiver.dd}` : 'DD —' }}</span>
      </div>
      <div class="dive-desc">{{ activeDiver?.description || '—' }}</div>
    </div>

    <!-- Score display -->
    <div class="score-zone">
      <div :class="['score-number', scoreIsZero ? 'zero' : '']">{{ displayValue }}</div>
      <div class="score-hint">Current Score Entry</div>
    </div>

    <!-- Keypad -->
    <div class="keypad">
      <!-- 1-9 -->
      <button v-for="n in 9" :key="n" class="key" @click="pressNumber(n)">{{ n }}</button>
      <!-- ½ -->
      <button :class="['key', 'key-half', isHalf ? 'active' : '']" @click="toggleHalf">½</button>
      <!-- 0 -->
      <button class="key key-zero" @click="pressNumber(0)">0</button>
      <!-- 10 -->
      <button class="key key-ten" @click="pressNumber(10)">10</button>
      <!-- Clear -->
      <button class="key key-clear" @click="resetScore">Clear</button>
    </div>

    <!-- Submit -->
    <div class="submit-footer">
      <button
        :class="['submit-btn', submitted ? 'locked' : '']"
        :disabled="submitted"
        @click="submitScore"
      >{{ submitLabel }}</button>
    </div>
  </div>
</template>

<style scoped>
/* Connection banner — sticky at top of viewport so a judge
   can't miss it. Animates in from above on disconnect. */
.conn-banner {
  position: sticky; top: 0; z-index: 50;
  background: var(--amber); color: var(--bg);
  font-family: var(--font-display); font-size: 12px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  padding: 0.55rem 1rem;
  display: flex; align-items: center; gap: 0.6rem;
  border-bottom: 1px solid rgba(0,0,0,0.2);
  animation: connSlide 0.18s ease;
}
.conn-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  background: var(--bg); animation: connPulse 1s infinite;
}
@keyframes connSlide { from { transform: translateY(-100%); } to { transform: translateY(0); } }
@keyframes connPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }


.judge-layout {
  overflow: hidden;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  touch-action: manipulation;
  user-select: none;
}

.btn-back-judge {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-3);
  text-decoration: none;
  transition: color 0.15s;
}
.btn-back-judge:hover { color: var(--text); }

.judge-header {
  background: var(--bg-2);
  border-bottom: 1px solid var(--border);
  padding: 0.875rem 1.25rem;
  flex-shrink: 0;
}
.header-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 0.625rem;
}
.event-name {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 0.25rem;
}
.diver-name {
  font-family: var(--font-display);
  font-size: clamp(18px, 4vw, 26px);
  font-weight: 900;
  font-style: italic;
  color: var(--text);
  line-height: 1;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.diver-country {
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 700;
  font-style: normal;
  letter-spacing: 0.05em;
  color: var(--text-3);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.15rem 0.4rem;
  vertical-align: middle;
}
.diver-amp { color: var(--cyan); margin: 0 0.4em; font-weight: 400; }
.synchro-role {
  display: inline-block;
  margin-top: 0.6rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.35rem 0.75rem; border-radius: 4px;
  border: 1px solid var(--border); background: var(--bg-3); color: var(--text-2);
}
.synchro-role strong { color: var(--text); }
.synchro-role.role-a    { color: #c4b5fd; border-color: rgba(139,92,246,0.45); background: rgba(139,92,246,0.10); }
.synchro-role.role-b    { color: #fbbf24; border-color: rgba(245,158,11,0.45); background: rgba(245,158,11,0.10); }
.synchro-role.role-sync { color: #34d399; border-color: rgba(16,185,129,0.45); background: rgba(16,185,129,0.10); }
.judge-team-line {
  display: inline-block; margin-top: 0.5rem; margin-right: 0.5rem;
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  padding: 0.3rem 0.7rem; border-radius: 4px;
  border: 1px solid rgba(139,92,246,0.45); background: rgba(139,92,246,0.10); color: #c4b5fd;
}
.judge-team-line strong { color: var(--text); }
.judge-id {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-3);
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.dive-info-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.dive-pill {
  font-family: var(--font-mono);
  font-size: 12px;
  padding: 0.2rem 0.625rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--text-2);
}
.dive-pill.code { color: var(--text); font-weight: 500; font-size: 13px; }
.dive-pill.dd { color: var(--cyan); border-color: rgba(6,182,212,0.3); background: var(--cyan-dim); }
.dive-desc { font-size: 11px; color: var(--text-3); margin-top: 0.35rem; font-family: var(--font-mono); }

.score-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.75rem 1rem;
  flex-shrink: 0;
  background: var(--bg);
}
.score-number {
  font-family: var(--font-display);
  font-size: clamp(72px, 20vw, 110px);
  font-weight: 900;
  line-height: 1;
  color: var(--text);
  transition: color 0.1s;
  letter-spacing: -0.02em;
}
.score-number.zero { color: var(--text-3); }
.score-hint {
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-top: 0.25rem;
}

.keypad {
  flex: 1;
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: repeat(4, 1fr);
  gap: 0.4rem;
  padding: 0.5rem 0.75rem;
  min-height: 0;
}
.key {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-family: var(--font-display);
  font-size: clamp(18px, 5vw, 26px);
  font-weight: 700;
  color: var(--text);
  cursor: pointer;
  transition: all 0.08s;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
}
.key:active { background: var(--cyan); color: var(--bg); border-color: var(--cyan); transform: scale(0.94); }
.key-half { font-size: clamp(14px, 4vw, 18px); color: var(--cyan); border-color: rgba(6,182,212,0.3); }
.key-half.active { background: var(--cyan); color: var(--bg); border-color: var(--cyan); }
.key-clear {
  grid-column: span 3;
  font-size: 12px;
  letter-spacing: 0.2em;
  color: var(--red);
  border-color: rgba(239,68,68,0.25);
  background: var(--red-dim);
  font-family: var(--font-display);
  font-weight: 700;
  text-transform: uppercase;
}
.key-clear:active { background: var(--red); color: white; }

.submit-footer {
  padding: 0.625rem 0.75rem 0.875rem;
  flex-shrink: 0;
}
.submit-btn {
  width: 100%;
  background: var(--cyan);
  color: var(--bg);
  font-family: var(--font-display);
  font-size: clamp(15px, 4vw, 19px);
  font-weight: 900;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 1.1rem;
  border: none;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all 0.15s;
}
.submit-btn:hover:not(:disabled) { background: #0891b2; }
.submit-btn:active:not(:disabled) { transform: scale(0.98); }
.submit-btn:disabled,
.submit-btn.locked { background: var(--surface); color: var(--text-3); border: 1px solid var(--border); cursor: not-allowed; }
</style>
