<script setup>
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

const events = ref([])
const allJudges = ref([])
const selectedEventId = ref('')
const currentEvent = ref(null)
const panel = ref([]) // array of judge objects or null
const judgeSearch = ref('')
const saveMsg = ref('')
const saveMsgType = ref('')

const panelSize = computed(() => currentEvent.value?.number_of_judges || 5)

const assignedCount = computed(() => panel.value.filter(Boolean).length)

const inPanelIds = computed(() => new Set(panel.value.filter(Boolean).map(j => j.id)))

const filteredJudges = computed(() => {
  const term = judgeSearch.value.toLowerCase()
  if (!term) return allJudges.value
  return allJudges.value.filter(j =>
    j.full_name.toLowerCase().includes(term) || j.username.toLowerCase().includes(term)
  )
})

async function onEventChange() {
  saveMsg.value = ''
  if (!selectedEventId.value) {
    currentEvent.value = null
    panel.value = []
    return
  }
  currentEvent.value = events.value.find(e => e.id == selectedEventId.value) || null
  if (!currentEvent.value) return

  panel.value = Array(panelSize.value).fill(null)

  try {
    const assigned = await auth.apiFetch(`/api/events/${selectedEventId.value}/judges`)
    assigned.forEach(a => {
      const judge = allJudges.value.find(j => j.id === a.judge_id)
      if (judge && a.judge_number >= 1 && a.judge_number <= panelSize.value) {
        panel.value[a.judge_number - 1] = judge
      }
    })
  } catch {
    panel.value = Array(panelSize.value).fill(null)
  }
}

function assignJudge(judge) {
  const emptyIdx = panel.value.findIndex(s => s === null)
  if (emptyIdx === -1) return
  panel.value[emptyIdx] = judge
}

function removeFromSlot(idx) {
  panel.value[idx] = null
}

function slotLabel(idx) {
  const j = panel.value[idx]
  return j ? j.full_name : null
}

function judgeSlotNum(judgeId) {
  return panel.value.findIndex(p => p?.id === judgeId)
}

async function savePanel() {
  saveMsg.value = ''
  const filled = panel.value.filter(Boolean).length
  if (filled !== panelSize.value) {
    saveMsg.value = `Panel requires exactly ${panelSize.value} judges. ${filled} assigned.`
    saveMsgType.value = 'error'
    return
  }
  try {
    await auth.apiFetch(`/api/events/${selectedEventId.value}/judges`, {
      method: 'POST',
      body: JSON.stringify({ judgeIds: panel.value.map(j => j.id) }),
    })
    saveMsg.value = `Panel saved. Judges numbered J1–J${panelSize.value}.`
    saveMsgType.value = 'success'
    setTimeout(() => { saveMsg.value = '' }, 3000)
  } catch (err) {
    saveMsg.value = err.message
    saveMsgType.value = 'error'
  }
}

onMounted(async () => {
  const [evs, jdgs] = await Promise.all([
    auth.apiFetch('/api/events'),
    auth.apiFetch('/api/judges'),
  ])
  events.value = evs
  allJudges.value = jdgs
})
</script>

<template>
  <div class="page-header">
    <h1 style="font-size:32px;font-style:italic">Assign Judges</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">← Dashboard</RouterLink>
  </div>

  <div class="main">
    <!-- Step 1: select event -->
    <div class="card">
      <label class="label" style="margin-bottom:0.75rem;display:block">Step 1 — Select Event</label>
      <select class="select" v-model="selectedEventId" @change="onEventChange">
        <option value="">— Choose Event —</option>
        <option v-for="ev in events" :key="ev.id" :value="ev.id">{{ ev.name }}</option>
      </select>
    </div>

    <!-- Step 2: build panel -->
    <div v-if="currentEvent">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;flex-wrap:wrap;gap:1rem">
          <div>
            <h2 style="font-size:20px;font-style:italic;margin-bottom:0.25rem">Step 2 — Build Panel</h2>
            <div style="font-family:var(--font-display);font-size:12px;font-weight:700;color:var(--text-3);letter-spacing:0.1em">
              <span style="color:var(--cyan)">{{ assignedCount }}</span> of {{ panelSize }} judges assigned
            </div>
          </div>
          <div style="display:flex;gap:0.75rem;align-items:center">
            <div v-if="saveMsg" :class="['msg', saveMsgType === 'success' ? 'msg-success' : 'msg-error']">{{ saveMsg }}</div>
            <button class="btn btn-primary" @click="savePanel">Save Panel</button>
          </div>
        </div>

        <div class="assign-grid">
          <!-- Left: available judges -->
          <div>
            <div class="col-label">Available Judges</div>
            <div class="search-wrap">
              <input class="input" type="text" v-model="judgeSearch" placeholder="Search judges...">
            </div>
            <div class="judge-list">
              <div v-if="!filteredJudges.length" class="empty">No judges found</div>
              <div
                v-for="j in filteredJudges"
                :key="j.id"
                :class="['judge-item', inPanelIds.has(j.id) ? 'in-panel' : '']"
                @click="!inPanelIds.has(j.id) && assignJudge(j)"
              >
                <div>
                  <div class="judge-item-name">{{ j.full_name }}</div>
                  <div class="judge-item-user">@{{ j.username }}</div>
                </div>
                <span v-if="inPanelIds.has(j.id)" style="margin-left:auto;font-family:var(--font-display);font-size:10px;font-weight:700;letter-spacing:0.1em;color:var(--cyan)">
                  J{{ judgeSlotNum(j.id) + 1 }} ✓
                </span>
                <svg v-else class="add-icon" width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
              </div>
            </div>
          </div>

          <!-- Right: panel slots -->
          <div>
            <div class="col-label">Panel Slots — click a judge to assign</div>
            <div class="panel-slots">
              <div
                v-for="(judge, idx) in panel"
                :key="idx"
                :class="['slot', judge ? 'filled' : '']"
              >
                <div class="slot-num" :style="judge ? {} : { color: 'var(--border-2)' }">J{{ idx + 1 }}</div>
                <div v-if="judge" style="flex:1">
                  <div class="slot-label">Judge {{ idx + 1 }}</div>
                  <div class="slot-name">{{ judge.full_name }}</div>
                </div>
                <div v-else class="slot-empty">Empty — click a judge to assign to this slot</div>
                <button v-if="judge" class="slot-remove" @click="removeFromSlot(idx)">✕</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 2rem;
  border-bottom: 1px solid var(--border);
  max-width: 1100px;
  margin: 0 auto;
}
.main {
  max-width: 1100px;
  margin: 0 auto;
  padding: 2rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.assign-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
}
@media (max-width: 720px) {
  .assign-grid { grid-template-columns: 1fr; }
}

.col-label {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.75rem;
}

.judge-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  max-height: 440px;
  overflow-y: auto;
}
.judge-item {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s;
  user-select: none;
}
.judge-item:hover { border-color: var(--border-2); }
.judge-item.in-panel { opacity: 0.4; cursor: not-allowed; pointer-events: none; }
.judge-item-name { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text); }
.judge-item-user { font-size: 11px; color: var(--text-3); }
.add-icon { margin-left: auto; color: var(--cyan); flex-shrink: 0; opacity: 0.6; }
.judge-item:hover .add-icon { opacity: 1; }

.panel-slots { display: flex; flex-direction: column; gap: 0.5rem; }
.slot {
  display: flex;
  align-items: center;
  gap: 0.875rem;
  padding: 0.875rem 1rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-height: 58px;
  transition: border-color 0.15s;
}
.slot.filled { border-color: var(--cyan); background: var(--cyan-dim); }
.slot-num { font-family: var(--font-display); font-size: 20px; font-weight: 900; color: var(--text-3); width: 32px; text-align: center; flex-shrink: 0; }
.slot.filled .slot-num { color: var(--cyan); }
.slot-label { font-family: var(--font-display); font-size: 10px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3); margin-bottom: 0.1rem; }
.slot-name { font-family: var(--font-display); font-size: 15px; font-weight: 700; color: var(--text); }
.slot-empty { font-size: 12px; color: var(--text-3); font-style: italic; }
.slot-remove { margin-left: auto; background: none; border: none; color: var(--text-3); cursor: pointer; font-size: 16px; padding: 0.25rem; line-height: 1; transition: color 0.1s; flex-shrink: 0; }
.slot-remove:hover { color: var(--red); }

.search-wrap { margin-bottom: 0.75rem; }
.empty { color: var(--text-3); font-size: 12px; text-align: center; padding: 2rem; }
</style>
