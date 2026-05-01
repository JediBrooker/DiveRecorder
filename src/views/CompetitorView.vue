<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const auth = useAuthStore()

const events = ref([])
const diveDirectory = ref([])
const selectedEventId = ref('')
const currentEvent = ref(null)
const selectedDives = ref([]) // array of null | dive object
const showModal = ref(false)
const activeSlot = ref(-1)
const searchInput = ref('')
const activeHeightFilter = ref(null)
const submitErr = ref('')
const loading = ref(false)

// Synchro support
const orgDivers = ref([])      // potential partners — fellow divers in your org
const partnerId = ref('')       // selected partner's user id, '' = none
const isSynchro = computed(() => currentEvent.value?.event_type === 'synchro_pair')

const activeEventHeight = computed(() => {
  if (!currentEvent.value?.height) return null
  return parseFloat(currentEvent.value.height)
})

const allHeights = computed(() =>
  [...new Set(diveDirectory.value.map(d => parseFloat(d.height)))].sort((a, b) => a - b)
)

const totalDD = computed(() =>
  selectedDives.value.reduce((sum, d) => sum + (d ? parseFloat(d.dd) : 0), 0).toFixed(1)
)

const searchResults = computed(() => {
  const term = searchInput.value.toLowerCase().trim()
  return diveDirectory.value.filter(d => {
    const combined = (d.dive_code + d.position).toLowerCase()
    const textMatch = !term || combined.includes(term) || d.description.toLowerCase().includes(term)
    const heightMatch = activeHeightFilter.value === null || parseFloat(d.height) === activeHeightFilter.value
    return textMatch && heightMatch
  }).slice(0, 15)
})

function onEventChange() {
  partnerId.value = ''
  if (!selectedEventId.value) {
    currentEvent.value = null
    selectedDives.value = []
    return
  }
  currentEvent.value = events.value.find(e => e.id == selectedEventId.value) || null
  if (!currentEvent.value) return
  selectedDives.value = Array(currentEvent.value.total_rounds || 6).fill(null)
}

function openModal(idx) {
  activeSlot.value = idx
  searchInput.value = ''
  if (activeEventHeight.value !== null) {
    activeHeightFilter.value = activeEventHeight.value
  } else {
    activeHeightFilter.value = null
  }
  showModal.value = true
}

function selectDive(dive) {
  selectedDives.value[activeSlot.value] = dive
  showModal.value = false
}

function setHeightFilter(h) {
  activeHeightFilter.value = h
}

async function submitList() {
  submitErr.value = ''
  const eventId = selectedEventId.value
  const filled = selectedDives.value.filter(Boolean)
  if (!eventId || filled.length < selectedDives.value.length) {
    submitErr.value = `Please select all ${selectedDives.value.length} dives before submitting.`
    return
  }
  if (isSynchro.value && !partnerId.value) {
    submitErr.value = 'Synchronised events require a partner. Pick one above.'
    return
  }
  loading.value = true
  try {
    const body = {
      event_id: eventId,
      dives: selectedDives.value.map((d, i) => ({ dive_id: d.id, round_number: i + 1 })),
    }
    if (isSynchro.value) body.partner_id = partnerId.value
    await auth.apiFetch('/api/competitor/submit-list', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    router.push('/dashboard')
  } catch (err) {
    submitErr.value = err.message || 'Submission failed. You may have already submitted for this event.'
  } finally {
    loading.value = false
  }
}

onMounted(async () => {
  const [evs, dir] = await Promise.all([
    auth.apiFetch('/api/events'),
    auth.apiFetch('/api/dive-directory'),
  ])
  events.value = evs
  diveDirectory.value = dir
})

// When the event changes and it's synchro, fetch potential
// partners — other divers in the user's org.
watch(currentEvent, async (ev) => {
  if (!ev || ev.event_type !== 'synchro_pair') {
    orgDivers.value = []
    return
  }
  try {
    const r = await fetch(`/api/orgs/${auth.user.org_id}/divers`, {
      headers: { Authorization: `Bearer ${auth.token}` },
    })
    const body = await r.json()
    orgDivers.value = (Array.isArray(body) ? body : [])
      .filter(u => u.id !== auth.user.id)
  } catch {
    orgDivers.value = []
  }
})
</script>

<template>
  <div class="page-header">
    <h1 style="font-size:32px;font-style:italic">Submit Dive List</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">← Dashboard</RouterLink>
  </div>

  <div class="main">
    <div class="card">
      <label class="label" style="margin-bottom:0.75rem;display:block">Step 1 — Select Event</label>
      <select class="select" v-model="selectedEventId" @change="onEventChange">
        <option value="">— Choose Active Event —</option>
        <option v-for="ev in events" :key="ev.id" :value="ev.id">
          {{ ev.name }}{{ ev.event_type === 'synchro_pair' ? ' (Synchro)' : '' }}
        </option>
      </select>
    </div>

    <!-- Synchro partner picker -->
    <div v-if="isSynchro" class="card">
      <label class="label" style="margin-bottom:0.75rem;display:block">
        Step 1.5 — Pick Your Synchro Partner
      </label>
      <select class="select" v-model="partnerId">
        <option value="">— Select a partner —</option>
        <option v-for="d in orgDivers" :key="d.id" :value="d.id">
          {{ d.full_name }}{{ d.club_code ? ' (' + d.club_code + ')' : '' }}
        </option>
      </select>
      <p v-if="!orgDivers.length" class="hint-line" style="margin-top:0.5rem">
        No other divers found in your organisation yet. Ask your partner to register first.
      </p>
      <p v-else class="hint-line" style="margin-top:0.5rem">
        Both you and your partner perform the same dive list — you only submit it from one account.
      </p>
    </div>

    <div v-if="currentEvent">
      <div class="card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem">
          <h2 style="font-size:20px;font-style:italic">Step 2 — Your Dive List</h2>
          <div class="total-bar" style="padding:0.5rem 1rem;background:transparent;border:none">
            <div>
              <div class="total-value">{{ totalDD }}</div>
              <div class="total-label">Total DD</div>
            </div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:0.5rem">
          <div
            v-for="(dive, idx) in selectedDives"
            :key="idx"
            :class="['dive-row', dive ? 'filled' : '']"
            @click="openModal(idx)"
          >
            <div :class="['row-num', dive ? 'filled-num' : '']">{{ idx + 1 }}</div>
            <div class="row-info" v-if="dive">
              <div class="row-code">{{ dive.dive_code }}<span class="result-pos">{{ dive.position }}</span></div>
              <div class="row-desc">{{ dive.description }}</div>
            </div>
            <div class="row-info" v-else>
              <div class="row-placeholder">Tap to select dive...</div>
            </div>
            <div v-if="dive" class="row-dd">DD {{ dive.dd }}</div>
            <svg v-else width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24" style="color:var(--text-3)"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>
          </div>
        </div>
        <div v-if="submitErr" class="msg msg-error" style="margin-top:1rem">{{ submitErr }}</div>
        <button class="btn btn-primary-lg" style="margin-top:1.5rem" @click="submitList" :disabled="loading">
          {{ loading ? 'Submitting...' : 'Finalise & Submit List' }}
        </button>
      </div>
    </div>
  </div>

  <!-- Search modal -->
  <div v-if="showModal" class="modal-backdrop">
    <div class="modal" style="max-width:560px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.25rem">
        <div style="display:flex;align-items:center;gap:0.75rem">
          <h3 style="font-size:20px;font-style:italic">Find Dive</h3>
          <span v-if="activeEventHeight !== null" class="lock-badge">{{ activeEventHeight }}m board</span>
        </div>
        <button class="btn btn-ghost btn-sm" @click="showModal = false">Cancel</button>
      </div>
      <div class="search-input-wrap" style="margin-bottom:1rem">
        <svg class="search-icon" width="14" height="14" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35" stroke-linecap="round"/></svg>
        <input class="input" type="text" v-model="searchInput" placeholder="Search code or description (e.g. 101C)..." style="padding-left:2.5rem">
      </div>
      <div v-if="activeEventHeight === null" class="height-pills">
        <button
          :class="['pill', activeHeightFilter === null ? 'active' : '']"
          @click="setHeightFilter(null)"
        >All</button>
        <button
          v-for="h in allHeights"
          :key="h"
          :class="['pill', activeHeightFilter === h ? 'active' : '']"
          @click="setHeightFilter(h)"
        >{{ h }}m</button>
      </div>
      <div style="max-height:340px;overflow-y:auto">
        <p v-if="!searchResults.length" style="color:var(--text-3);font-size:12px;text-align:center;padding:1.5rem">No dives found</p>
        <div
          v-for="d in searchResults"
          :key="d.id"
          class="result-item"
          @click="selectDive(d)"
        >
          <div>
            <div class="result-code">{{ d.dive_code }}<span class="result-pos">{{ d.position }}</span></div>
            <div class="result-desc">{{ d.description }}</div>
          </div>
          <div class="result-right">
            <div class="result-dd">DD {{ d.dd }}</div>
            <div class="result-height">{{ d.height }}m</div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-header{display:flex;align-items:center;justify-content:space-between;padding:1.5rem 2rem;border-bottom:1px solid var(--border);max-width:900px;margin:0 auto;}
.main{max-width:900px;margin:0 auto;padding:2rem;display:flex;flex-direction:column;gap:1.5rem;}

.dive-row{
  display:flex;align-items:center;gap:1rem;padding:1rem 1.25rem;
  background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);
  cursor:pointer;transition:border-color 0.15s;
}
.dive-row:hover{border-color:var(--border-2);}
.dive-row.filled{border-color:var(--cyan);background:var(--cyan-dim);}
.row-num{
  font-family:var(--font-display);font-size:13px;font-weight:700;
  color:var(--text-3);width:28px;flex-shrink:0;text-align:center;
}
.filled-num{color:var(--cyan);}
.row-info{flex:1;}
.row-code{font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--text);}
.row-desc{font-size:11px;color:var(--text-3);margin-top:0.1rem;}
.row-placeholder{font-size:12px;color:var(--text-3);font-style:italic;}
.row-dd{font-family:var(--font-mono);font-size:14px;font-weight:500;color:var(--cyan);flex-shrink:0;}

.total-bar{
  display:flex;align-items:center;justify-content:space-between;
  background:var(--surface);border:1px solid var(--border);
  border-radius:var(--radius);padding:1rem 1.25rem;
}
.total-label{font-family:var(--font-display);font-size:11px;font-weight:700;letter-spacing:0.2em;text-transform:uppercase;color:var(--text-3);}
.total-value{font-family:var(--font-display);font-size:32px;font-weight:900;color:var(--cyan);}

.search-input-wrap{position:relative;}
.search-icon{position:absolute;left:0.875rem;top:50%;transform:translateY(-50%);color:var(--text-3);}

.height-pills{display:flex;flex-wrap:wrap;gap:0.5rem;margin-bottom:1rem;}
.pill{
  font-family:var(--font-display);font-size:11px;font-weight:700;
  letter-spacing:0.1em;text-transform:uppercase;
  padding:0.35rem 0.875rem;border-radius:20px;border:1px solid var(--border);
  background:var(--bg-3);color:var(--text-3);cursor:pointer;transition:all 0.15s;
}
.pill.active,.pill:hover{background:var(--cyan-dim);border-color:var(--cyan);color:var(--cyan);}

.result-item{
  display:flex;align-items:center;justify-content:space-between;
  padding:0.875rem 1rem;background:var(--bg-3);border:1px solid var(--border);
  border-radius:var(--radius);cursor:pointer;transition:border-color 0.15s;margin-bottom:0.5rem;
}
.result-item:hover{border-color:var(--cyan);}
.result-code{font-family:var(--font-display);font-size:16px;font-weight:700;}
.result-pos{color:var(--cyan);}
.result-desc{font-size:11px;color:var(--text-3);margin-top:0.15rem;}
.result-right{text-align:right;flex-shrink:0;}
.result-dd{font-family:var(--font-mono);font-size:14px;color:var(--cyan);}
.result-height{font-size:10px;color:var(--text-3);margin-top:0.15rem;}

.hint-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); }
.lock-badge{
  display:inline-flex;align-items:center;gap:0.4rem;
  font-family:var(--font-display);font-size:10px;font-weight:700;
  letter-spacing:0.15em;text-transform:uppercase;
  padding:0.25rem 0.625rem;border-radius:4px;
  background:var(--cyan-dim);color:var(--cyan);border:1px solid rgba(6,182,212,0.3);
}
</style>
