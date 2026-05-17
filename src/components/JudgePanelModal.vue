<script setup>
// Inline judge-panel picker for the Control Room readiness checklist.
// Same data model and endpoints as AssignJudgesView, just framed as
// a modal so the operator can seat the panel without leaving Control.
//
// Opens when the parent flips `open` to true; emits `saved` after a
// successful POST so the parent can refresh its judgePanel ref and
// the readiness check ticks green.

import { ref, computed, watch } from 'vue'
import { useAuthStore } from '@/stores/auth'

const props = defineProps({
  open:      { type: Boolean, required: true },
  eventId:   { type: [Number, String], default: null },
  panelSize: { type: Number, default: 5 },
  eventName: { type: String, default: '' },
})

const emit = defineEmits(['close', 'saved'])

const auth = useAuthStore()

const allJudges = ref([])       // eligible judges (event-scoped if available)
const panel     = ref([])       // length = panelSize, slots are judge objects or null
const judgeSearch = ref('')
const loading   = ref(false)
const saving    = ref(false)
const errorMsg  = ref('')

const assignedCount = computed(() => panel.value.filter(Boolean).length)
const inPanelIds    = computed(() => new Set(panel.value.filter(Boolean).map(j => j.id)))
const canSave       = computed(() => assignedCount.value === props.panelSize && !saving.value)

const filteredJudges = computed(() => {
  const term = judgeSearch.value.trim().toLowerCase()
  if (!term) return allJudges.value
  return allJudges.value.filter(j => {
    const hay = [j.full_name, j.org_name, j.country_code].filter(Boolean).join(' ').toLowerCase()
    return hay.includes(term)
  })
})

async function loadData() {
  if (!props.eventId) return
  loading.value = true
  errorMsg.value = ''
  panel.value = Array(props.panelSize).fill(null)
  try {
    // Org-scoped judges first as the always-available baseline; the
    // event-scoped eligible list (which adds participating-federation
    // judges on international meets) replaces it if it succeeds.
    const orgJudges = await auth.apiFetch('/api/judges').catch(() => [])
    allJudges.value = Array.isArray(orgJudges) ? orgJudges : []
    const eligible = await auth.apiFetch(`/api/events/${props.eventId}/eligible-judges`).catch(() => null)
    if (Array.isArray(eligible) && eligible.length) {
      allJudges.value = eligible
    }
    const assigned = await auth.apiFetch(`/api/events/${props.eventId}/judges`).catch(() => [])
    if (Array.isArray(assigned)) {
      assigned.forEach(a => {
        const judge = allJudges.value.find(j => j.id === a.judge_id)
        if (judge && a.judge_number >= 1 && a.judge_number <= props.panelSize) {
          panel.value[a.judge_number - 1] = judge
        }
      })
    }
  } catch (err) {
    errorMsg.value = err.message || 'Failed to load judges.'
  } finally {
    loading.value = false
  }
}

// Re-fetch each time the modal opens so a panel change made
// elsewhere (e.g. AssignJudgesView in another tab) is picked up.
watch(() => props.open, async (now) => {
  if (now) {
    judgeSearch.value = ''
    await loadData()
  }
})

function assignJudge(judge) {
  if (inPanelIds.value.has(judge.id)) return
  const emptyIdx = panel.value.findIndex(s => s === null)
  if (emptyIdx === -1) return
  panel.value[emptyIdx] = judge
}

function removeFromSlot(idx) {
  panel.value[idx] = null
}

function judgeSlotNum(judgeId) {
  return panel.value.findIndex(p => p?.id === judgeId)
}

function close() {
  if (saving.value) return
  emit('close')
}

async function save() {
  if (!canSave.value || !props.eventId) return
  saving.value = true
  errorMsg.value = ''
  try {
    await auth.apiFetch(`/api/events/${props.eventId}/judges`, {
      method: 'POST',
      body:   JSON.stringify({ judgeIds: panel.value.map(j => j.id) }),
    })
    emit('saved')
    emit('close')
  } catch (err) {
    errorMsg.value = err.message || 'Failed to save panel.'
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div v-if="open" class="modal-backdrop" @mousedown.self="close">
    <div class="modal judge-panel-modal" @mousedown.stop>
      <div class="jpm-header">
        <div>
          <h2 class="jpm-title">Seat the judge panel</h2>
          <div class="jpm-subtitle">
            <span v-if="eventName">{{ eventName }} — </span>
            <span :class="assignedCount === panelSize ? 'jpm-count-ok' : 'jpm-count-warn'">
              {{ assignedCount }}
            </span>
            of {{ panelSize }} seats filled
          </div>
        </div>
        <button type="button" class="btn btn-ghost btn-sm" @click="close" :disabled="saving">
          Cancel ✕
        </button>
      </div>

      <div v-if="errorMsg" class="msg msg-error jpm-error">{{ errorMsg }}</div>
      <div v-if="loading" class="jpm-loading">Loading judges…</div>

      <div v-else class="jpm-grid">
        <!-- Left: available judges -->
        <div>
          <div class="jpm-col-label">Available judges</div>
          <input
            class="input jpm-search"
            type="text"
            v-model="judgeSearch"
            placeholder="Search judges…"
          >
          <div class="jpm-judge-list">
            <div v-if="!filteredJudges.length" class="jpm-empty">No judges found</div>
            <div
              v-for="j in filteredJudges"
              :key="j.id"
              :class="['jpm-judge-item', inPanelIds.has(j.id) ? 'in-panel' : '']"
              @click="assignJudge(j)"
            >
              <div class="jpm-judge-info">
                <div class="jpm-judge-name">
                  {{ j.full_name }}
                  <span v-if="j.country_code" class="jpm-judge-country">{{ j.country_code }}</span>
                </div>
                <div v-if="j.org_name" class="jpm-judge-org">{{ j.org_name }}</div>
              </div>
              <span v-if="inPanelIds.has(j.id)" class="jpm-seated">
                J{{ judgeSlotNum(j.id) + 1 }} ✓
              </span>
              <span v-else class="jpm-add-hint">＋</span>
            </div>
          </div>
        </div>

        <!-- Right: panel slots -->
        <div>
          <div class="jpm-col-label">Panel — click to assign in order</div>
          <div class="jpm-slots">
            <div
              v-for="(judge, idx) in panel"
              :key="idx"
              :class="['jpm-slot', judge ? 'filled' : '']"
            >
              <div class="jpm-slot-num">J{{ idx + 1 }}</div>
              <div v-if="judge" class="jpm-slot-body">
                <div class="jpm-slot-label">Judge {{ idx + 1 }}</div>
                <div class="jpm-slot-name">{{ judge.full_name }}</div>
              </div>
              <div v-else class="jpm-slot-empty">Empty</div>
              <button
                v-if="judge"
                type="button"
                class="jpm-slot-remove"
                @click="removeFromSlot(idx)"
                aria-label="Remove judge"
              >✕</button>
            </div>
          </div>
        </div>
      </div>

      <div class="jpm-actions">
        <button type="button" class="btn btn-ghost" @click="close" :disabled="saving">Cancel</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="!canSave"
          @click="save"
        >
          {{ saving ? 'Saving…' : `Save panel (${assignedCount}/${panelSize})` }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.judge-panel-modal {
  max-width: 880px;
  padding: 1.75rem;
}

.jpm-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}
.jpm-title {
  font-size: 22px;
  font-style: italic;
  margin: 0;
}
.jpm-subtitle {
  margin-top: 0.25rem;
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--text-3);
  text-transform: uppercase;
}
.jpm-count-ok   { color: var(--green, #10b981); }
.jpm-count-warn { color: var(--cyan); }

.jpm-error   { margin-bottom: 1rem; }
.jpm-loading { color: var(--text-3); padding: 2rem 0; text-align: center; }

.jpm-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.25rem;
}
@media (max-width: 720px) {
  .jpm-grid { grid-template-columns: 1fr; }
}

.jpm-col-label {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-3);
  margin-bottom: 0.6rem;
}

.jpm-search { margin-bottom: 0.6rem; width: 100%; }

.jpm-judge-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 360px;
  overflow-y: auto;
  padding-right: 0.25rem;
}
.jpm-judge-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
  user-select: none;
}
.jpm-judge-item:hover { border-color: var(--cyan); }
.jpm-judge-item.in-panel {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}
.jpm-judge-info { flex: 1; min-width: 0; }
.jpm-judge-name {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}
.jpm-judge-country {
  font-family: var(--font-mono);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--text-3);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 0.05rem 0.35rem;
}
.jpm-judge-org { font-size: 11px; color: var(--text-3); margin-top: 0.15rem; }
.jpm-seated {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--cyan);
  flex-shrink: 0;
}
.jpm-add-hint {
  color: var(--cyan);
  font-size: 18px;
  font-weight: 700;
  opacity: 0.6;
  flex-shrink: 0;
}
.jpm-judge-item:hover .jpm-add-hint { opacity: 1; }
.jpm-empty {
  color: var(--text-3);
  font-size: 12px;
  text-align: center;
  padding: 1.5rem;
}

.jpm-slots {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  max-height: 360px;
  overflow-y: auto;
  padding-right: 0.25rem;
}
.jpm-slot {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.65rem 0.85rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  min-height: 54px;
  transition: border-color 0.15s, background 0.15s;
}
.jpm-slot.filled {
  border-color: var(--cyan);
  background: var(--cyan-dim, rgba(6,182,212,0.08));
}
.jpm-slot-num {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  color: var(--text-3);
  width: 30px;
  text-align: center;
  flex-shrink: 0;
}
.jpm-slot.filled .jpm-slot-num { color: var(--cyan); }
.jpm-slot-body { flex: 1; min-width: 0; }
.jpm-slot-label {
  font-family: var(--font-display);
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--text-3);
}
.jpm-slot-name {
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 700;
  color: var(--text);
  margin-top: 0.05rem;
}
.jpm-slot-empty { color: var(--text-3); font-size: 12px; font-style: italic; }
.jpm-slot-remove {
  margin-left: auto;
  background: none;
  border: none;
  color: var(--text-3);
  cursor: pointer;
  font-size: 14px;
  padding: 0.2rem 0.4rem;
  line-height: 1;
  transition: color 0.1s;
  flex-shrink: 0;
}
.jpm-slot-remove:hover { color: var(--red); }

.jpm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 1.25rem;
}
</style>
