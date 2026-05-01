<script setup>
import { ref, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

const events = ref([])
const formErr = ref('')
const editErr = ref('')
const showEditModal = ref(false)

// Create form
const createName = ref('')
const createGender = ref('Female')
const createHeight = ref('')
const createJudges = ref(5)
const createRounds = ref(6)
const createType = ref('individual')

// Edit form
const editId = ref('')
const editName = ref('')
const editGender = ref('Female')
const editHeight = ref('')
const editJudges = ref(5)
const editRounds = ref(6)
const editType = ref('individual')

const HEIGHT_LABELS = {
  '1m': '1m Springboard',
  '3m': '3m Springboard',
  '5m': '5m Platform',
  '7.5m': '7.5m Platform',
  '10m': '10m Platform',
}

const TYPE_LABELS = {
  individual:   'Individual',
  synchro_pair: 'Synchronised Pair',
  team:         'Team (coming soon)',
}

function statusColor(status) {
  if (status === 'Live') return 'var(--green)'
  if (status === 'Completed') return 'var(--text-3)'
  return 'var(--amber)'
}

async function loadEvents() {
  try {
    events.value = await auth.apiFetch('/api/events')
  } catch (err) {
    formErr.value = err.message
  }
}

async function createEvent() {
  formErr.value = ''
  // Synchro panels must be 9 or 11 — preempt the server error
  if (createType.value === 'synchro_pair' && ![9, 11].includes(parseInt(createJudges.value))) {
    formErr.value = 'Synchronised pair events require 9 or 11 judges'
    return
  }
  try {
    await auth.apiFetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        name: createName.value,
        gender: createGender.value,
        height: createHeight.value || null,
        number_of_judges: parseInt(createJudges.value),
        total_rounds: parseInt(createRounds.value),
        event_type: createType.value,
      }),
    })
    createName.value = ''
    createGender.value = 'Female'
    createHeight.value = ''
    createJudges.value = 5
    createRounds.value = 6
    createType.value = 'individual'
    await loadEvents()
  } catch (err) {
    formErr.value = err.message
  }
}

function openEdit(ev) {
  editId.value = ev.id
  editName.value = ev.name
  editGender.value = ev.gender
  editHeight.value = ev.height || ''
  editJudges.value = ev.number_of_judges
  editRounds.value = ev.total_rounds || 6
  editType.value = ev.event_type || 'individual'
  editErr.value = ''
  showEditModal.value = true
}

async function saveEdit() {
  editErr.value = ''
  if (editType.value === 'synchro_pair' && ![9, 11].includes(parseInt(editJudges.value))) {
    editErr.value = 'Synchronised pair events require 9 or 11 judges'
    return
  }
  try {
    await auth.apiFetch(`/api/events/${editId.value}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: editName.value,
        gender: editGender.value,
        height: editHeight.value || null,
        number_of_judges: parseInt(editJudges.value),
        total_rounds: parseInt(editRounds.value),
        event_type: editType.value,
      }),
    })
    showEditModal.value = false
    await loadEvents()
  } catch (err) {
    editErr.value = err.message
  }
}

async function deleteEvent(id) {
  if (!confirm('Delete this event?')) return
  try {
    await auth.apiFetch(`/api/events/${id}`, { method: 'DELETE' })
    await loadEvents()
  } catch (err) {
    alert(err.message)
  }
}

onMounted(loadEvents)
</script>

<template>
  <div class="page-header">
    <h1 style="font-size:32px;font-style:italic">Meet Manager</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">← Dashboard</RouterLink>
  </div>

  <div class="main">
    <!-- Create form -->
    <div class="card">
      <h2 style="font-size:20px;font-style:italic;margin-bottom:1.5rem">New Event</h2>
      <form @submit.prevent="createEvent" class="form-stack">
        <div class="field">
          <label class="label">Event Name</label>
          <input class="input" v-model="createName" placeholder="e.g. Womens 10m Platform" required>
        </div>
        <div class="field">
          <label class="label">Event Type</label>
          <select class="select" v-model="createType">
            <option value="individual">Individual</option>
            <option value="synchro_pair">Synchronised Pair</option>
            <option value="team" disabled>Team (coming soon)</option>
          </select>
          <p v-if="createType === 'synchro_pair'" class="hint">
            Synchro: positions 1–2 (or 1–3) score Diver A's execution, 3–4 (or 4–6) score Diver B's execution, the rest score synchronisation. World Aquatics requires a 9- or 11-judge panel.
          </p>
        </div>
        <div class="field">
          <label class="label">Gender Category</label>
          <select class="select" v-model="createGender">
            <option value="Female">Female</option>
            <option value="Male">Male</option>
            <option value="Mixed">Mixed</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Board / Platform Height</label>
          <select class="select" v-model="createHeight">
            <option value="">— Select Height —</option>
            <option value="1m">1m Springboard</option>
            <option value="3m">3m Springboard</option>
            <option value="5m">5m Platform</option>
            <option value="7.5m">7.5m Platform</option>
            <option value="10m">10m Platform</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Judge Panel Size</label>
          <select class="select" v-model="createJudges">
            <option v-if="createType !== 'synchro_pair'" value="3">3 Judges</option>
            <option v-if="createType !== 'synchro_pair'" value="5">5 Judges</option>
            <option v-if="createType !== 'synchro_pair'" value="7">7 Judges</option>
            <option value="9">9 Judges</option>
            <option value="11">11 Judges</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Number of Rounds</label>
          <select class="select" v-model="createRounds">
            <option v-for="n in 12" :key="n" :value="n">{{ n }} Round{{ n > 1 ? 's' : '' }}</option>
          </select>
        </div>
        <div v-if="formErr" class="msg msg-error">{{ formErr }}</div>
        <button type="submit" class="btn btn-primary-lg" style="margin-top:0.25rem">Create Event</button>
      </form>
    </div>

    <!-- Events list -->
    <div>
      <h2 style="font-size:20px;font-style:italic;margin-bottom:1rem">Your Events</h2>
      <div class="events-list">
        <div v-if="!events.length" class="empty">No events yet. Create one to get started.</div>
        <div v-for="ev in events" :key="ev.id" class="event-item">
          <div style="flex:1;min-width:0">
            <div class="event-name">{{ ev.name }}</div>
            <div class="event-meta">
              <span v-if="ev.event_type === 'synchro_pair'" class="event-type-pill">Synchro</span>
              <span v-else-if="ev.event_type === 'team'" class="event-type-pill team">Team</span>
              <span>{{ ev.gender }}</span><span>·</span>
              <span>{{ ev.number_of_judges }} Judges</span><span>·</span>
              <span>{{ ev.total_rounds }} Rounds</span>
              <template v-if="ev.height">
                <span>·</span><span>{{ HEIGHT_LABELS[ev.height] || ev.height }}</span>
              </template>
              <span>·</span>
              <span :style="{ color: statusColor(ev.status) }">{{ ev.status }}</span>
            </div>
          </div>
          <div class="actions">
            <RouterLink :to="`/events/${ev.id}/audit`" class="btn btn-ghost btn-sm">Audit Log</RouterLink>
            <button class="btn btn-ghost btn-sm" @click="openEdit(ev)">Edit</button>
            <button class="btn btn-danger btn-sm" @click="deleteEvent(ev.id)">Delete</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- Edit modal -->
  <div v-if="showEditModal" class="modal-backdrop">
    <div class="modal">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.5rem">
        <h2 style="font-size:22px;font-style:italic">Edit Event</h2>
        <button class="btn btn-ghost btn-sm" @click="showEditModal = false">Cancel</button>
      </div>
      <form @submit.prevent="saveEdit" class="form-stack">
        <div class="field">
          <label class="label">Event Name</label>
          <input class="input" v-model="editName" required>
        </div>
        <div class="field">
          <label class="label">Event Type</label>
          <select class="select" v-model="editType">
            <option value="individual">Individual</option>
            <option value="synchro_pair">Synchronised Pair</option>
            <option value="team" disabled>Team (coming soon)</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Gender Category</label>
          <select class="select" v-model="editGender">
            <option value="Female">Female</option>
            <option value="Male">Male</option>
            <option value="Mixed">Mixed</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Board / Platform Height</label>
          <select class="select" v-model="editHeight">
            <option value="">— Select Height —</option>
            <option value="1m">1m Springboard</option>
            <option value="3m">3m Springboard</option>
            <option value="5m">5m Platform</option>
            <option value="7.5m">7.5m Platform</option>
            <option value="10m">10m Platform</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Judge Panel Size</label>
          <select class="select" v-model="editJudges">
            <option v-if="editType !== 'synchro_pair'" value="3">3 Judges</option>
            <option v-if="editType !== 'synchro_pair'" value="5">5 Judges</option>
            <option v-if="editType !== 'synchro_pair'" value="7">7 Judges</option>
            <option value="9">9 Judges</option>
            <option value="11">11 Judges</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Number of Rounds</label>
          <select class="select" v-model="editRounds">
            <option v-for="n in 12" :key="n" :value="n">{{ n }} Round{{ n > 1 ? 's' : '' }}</option>
          </select>
        </div>
        <div v-if="editErr" class="msg msg-error">{{ editErr }}</div>
        <button type="submit" class="btn btn-primary-lg">Save Changes</button>
      </form>
    </div>
  </div>
</template>

<style scoped>
.page-header { display:flex;align-items:center;justify-content:space-between;padding:1.5rem 2rem;border-bottom:1px solid var(--border);max-width:1400px;margin:0 auto; }
.main { max-width:1400px;margin:0 auto;padding:2rem;display:grid;grid-template-columns:380px 1fr;gap:2rem;align-items:start; }
@media(max-width:900px){.main{grid-template-columns:1fr;}}
.form-stack{display:flex;flex-direction:column;gap:1rem;}
.event-item{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.25rem;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);transition:border-color 0.2s;animation:fadeUp 0.25s ease;}
.event-item:hover{border-color:var(--border-2);}
.event-name{font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--text);}
.event-meta{font-size:11px;color:var(--text-3);margin-top:0.25rem;display:flex;gap:0.75rem;flex-wrap:wrap;}
.actions{display:flex;gap:0.5rem;flex-shrink:0;}
.events-list{display:flex;flex-direction:column;gap:0.75rem;}
.empty{color:var(--text-3);font-size:12px;text-align:center;padding:2rem;}
.event-type-pill {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.4); border-radius: 3px;
  padding: 0.1rem 0.4rem; margin-right: 0.2rem;
}
.event-type-pill.team { color: var(--amber); background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.4); }
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.6rem 0.75rem; margin-top: 0.4rem;
  background: var(--bg-3); border-left: 3px solid var(--cyan); border-radius: 3px;
}
</style>
