<script setup>
import { ref, computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()

const events = ref([])
const meets = ref([])
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
const createMeetId = ref('')           // optional — bundle this event into a meet

// Meet management — separate from event create/edit. A meet is
// a bundle of events; org admins create them here so events
// can be filed under e.g. "2026 National Open".
const meetForm = ref({
  name: '', venue: '', start_date: '', end_date: '',
})
const meetFormErr = ref('')

// Edit form
const editId = ref('')
const editName = ref('')
const editGender = ref('Female')
const editHeight = ref('')
const editJudges = ref(5)
const editRounds = ref(6)
const editType = ref('individual')

// Team enrolment modal — open when "Teams" clicked on a team-event row
const teamsModalOpen = ref(false)
const teamsModalEvent = ref(null)
const teamsInEvent = ref([])
const orgTeams = ref([])
const teamToAdd = ref('')
const teamsBusy = ref(false)

// Roster import modal — opened from the per-event "Import
// Roster" button. Manager pastes a CSV; backend parses, looks
// up each diver by username, validates dives in the directory,
// and bulk-creates dive list rows. Per-row errors are reported
// without failing the whole import.
const rosterModalOpen = ref(false)
const rosterModalEvent = ref(null)
const rosterCsv = ref('')
const rosterBusy = ref(false)
const rosterResult = ref(null)   // { added, skipped, errors }
const rosterErr = ref('')

function openRosterImport(ev) {
  rosterModalEvent.value = ev
  rosterCsv.value = ''
  rosterResult.value = null
  rosterErr.value = ''
  rosterModalOpen.value = true
}

function closeRosterImport() {
  rosterModalOpen.value = false
  rosterModalEvent.value = null
}

async function submitRosterImport() {
  if (!rosterCsv.value.trim()) {
    rosterErr.value = 'Paste a CSV first'
    return
  }
  rosterBusy.value = true
  rosterErr.value = ''
  rosterResult.value = null
  try {
    rosterResult.value = await auth.apiFetch(
      `/api/events/${rosterModalEvent.value.id}/roster/import`,
      { method: 'POST', body: JSON.stringify({ csv: rosterCsv.value }) },
    )
  } catch (err) {
    rosterErr.value = err.message
  } finally {
    rosterBusy.value = false
  }
}

// Build a sample CSV header that matches the event's round count
// so the manager has a starting template.
function rosterTemplateHeader(ev) {
  if (!ev) return ''
  const rounds = ev.total_rounds || 6
  const cols = ['username']
  if (ev.event_type === 'synchro_pair') cols.push('partner_username')
  for (let n = 1; n <= rounds; n++) {
    cols.push(`round_${n}_code`, `round_${n}_pos`)
  }
  return cols.join(',')
}

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

async function loadMeets() {
  if (!auth.user?.org_id) return
  try {
    const r = await fetch(`/api/orgs/${auth.user.org_id}/meets`)
    const body = await r.json()
    meets.value = Array.isArray(body) ? body : []
  } catch {
    meets.value = []
  }
}

async function createMeet() {
  meetFormErr.value = ''
  if (!meetForm.value.name.trim()) {
    meetFormErr.value = 'Meet name is required'
    return
  }
  try {
    await auth.apiFetch('/api/meets', {
      method: 'POST',
      body: JSON.stringify({
        name:       meetForm.value.name.trim(),
        venue:      meetForm.value.venue.trim() || null,
        start_date: meetForm.value.start_date || null,
        end_date:   meetForm.value.end_date   || null,
      }),
    })
    meetForm.value = { name: '', venue: '', start_date: '', end_date: '' }
    await loadMeets()
  } catch (err) {
    meetFormErr.value = err.message
  }
}

async function deleteMeet(meet) {
  if (!confirm(
    `Delete meet "${meet.name}"?\n\nIts ${meet.event_count} event(s) will become standalone — they're not deleted.`,
  )) return
  try {
    await auth.apiFetch(`/api/meets/${meet.id}`, { method: 'DELETE' })
    await Promise.all([loadMeets(), loadEvents()])
  } catch (err) {
    alert('Failed to delete meet: ' + err.message)
  }
}

async function assignEventToMeet(event, meetId) {
  try {
    await auth.apiFetch(`/api/events/${event.id}/meet`, {
      method: 'PUT',
      body: JSON.stringify({ meet_id: meetId || null }),
    })
    event.meet_id = meetId || null
    // Refresh meet event-counts
    await loadMeets()
  } catch (err) {
    alert('Failed: ' + err.message)
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
        meet_id: createMeetId.value || null,
      }),
    })
    createName.value = ''
    createGender.value = 'Female'
    createHeight.value = ''
    createJudges.value = 5
    createRounds.value = 6
    createType.value = 'individual'
    createMeetId.value = ''
    await Promise.all([loadEvents(), loadMeets()])
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

// ---- Team enrolment ----------------------------------------

async function openTeamsModal(ev) {
  teamsModalEvent.value = ev
  teamsModalOpen.value = true
  teamToAdd.value = ''
  teamsBusy.value = true
  try {
    const [entered, available] = await Promise.all([
      auth.apiFetch(`/api/events/${ev.id}/teams`),
      auth.apiFetch(`/api/orgs/${ev.org_id || auth.user?.org_id}/teams`),
    ])
    teamsInEvent.value = entered
    orgTeams.value = available
  } catch (err) {
    teamsInEvent.value = []
    orgTeams.value = []
  } finally {
    teamsBusy.value = false
  }
}

function closeTeamsModal() {
  teamsModalOpen.value = false
  teamsModalEvent.value = null
  teamsInEvent.value = []
  orgTeams.value = []
}

const addableTeams = computed(() => {
  const have = new Set(teamsInEvent.value.map(t => t.id))
  return orgTeams.value.filter(t => !have.has(t.id))
})

async function addTeamToEvent() {
  if (!teamToAdd.value || !teamsModalEvent.value) return
  teamsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${teamsModalEvent.value.id}/teams`, {
      method: 'POST',
      body: JSON.stringify({ team_id: teamToAdd.value }),
    })
    teamsInEvent.value = await auth.apiFetch(`/api/events/${teamsModalEvent.value.id}/teams`)
    teamToAdd.value = ''
  } catch (err) {
    alert(err.message)
  } finally {
    teamsBusy.value = false
  }
}

async function removeTeamFromEvent(team) {
  if (!confirm(`Remove "${team.name}" from this event? Their dive list (if any) will lose its team attribution but the dive results stay intact.`)) return
  teamsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${teamsModalEvent.value.id}/teams/${team.id}`, {
      method: 'DELETE',
    })
    teamsInEvent.value = teamsInEvent.value.filter(t => t.id !== team.id)
  } catch (err) {
    alert(err.message)
  } finally {
    teamsBusy.value = false
  }
}

onMounted(async () => { await Promise.all([loadEvents(), loadMeets()]) })
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
            <option value="team">Team (FINA)</option>
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
        <!-- Optional meet bundle. Defaults to standalone; pick a
             meet to file this event under "2026 National Open"
             etc. so the public meet page surfaces it. -->
        <div class="field">
          <label class="label">Meet (optional)</label>
          <select class="select" v-model="createMeetId">
            <option value="">— Standalone (no meet) —</option>
            <option v-for="m in meets" :key="m.id" :value="m.id">{{ m.name }}</option>
          </select>
          <p class="hint">
            Bundle this event into a multi-event meet. Manage meets below.
          </p>
        </div>
        <div v-if="formErr" class="msg msg-error">{{ formErr }}</div>
        <button type="submit" class="btn btn-primary-lg" style="margin-top:0.25rem">Create Event</button>
      </form>

      <!-- Meet management — separate from event create. Lists
           existing meets with their event counts plus an inline
           create form. Sponsor + description fields are
           managed via the API for now. -->
      <h2 style="font-size:20px;font-style:italic;margin:2rem 0 0.75rem">Meets</h2>
      <div class="meet-list">
        <div v-if="!meets.length" class="hint">
          No meets yet. Create one below to bundle multiple events.
        </div>
        <div v-for="m in meets" :key="m.id" class="meet-row">
          <div class="meet-row-id">
            <RouterLink :to="`/meet/${m.id}`" class="meet-row-name">{{ m.name }}</RouterLink>
            <div class="meet-row-meta">
              {{ m.event_count }} event{{ m.event_count === 1 ? '' : 's' }}
              <span v-if="m.live_count" class="meet-live">· {{ m.live_count }} live</span>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" @click="deleteMeet(m)">Delete</button>
        </div>
      </div>

      <form @submit.prevent="createMeet" class="form-stack" style="margin-top:1rem">
        <div class="field">
          <label class="label">New Meet Name</label>
          <input class="input" v-model="meetForm.name" placeholder="e.g. 2026 National Open" required>
        </div>
        <div class="field">
          <label class="label">Venue (optional)</label>
          <input class="input" v-model="meetForm.venue" placeholder="e.g. Sydney Olympic Aquatic Centre">
        </div>
        <div class="field" style="display:flex;gap:0.5rem">
          <div style="flex:1">
            <label class="label">Start Date</label>
            <input class="input" type="date" v-model="meetForm.start_date">
          </div>
          <div style="flex:1">
            <label class="label">End Date</label>
            <input class="input" type="date" v-model="meetForm.end_date">
          </div>
        </div>
        <div v-if="meetFormErr" class="msg msg-error">{{ meetFormErr }}</div>
        <button type="submit" class="btn btn-primary btn-sm" style="align-self:flex-start">
          Create Meet
        </button>
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
            <button v-if="ev.event_type === 'team'"
                    class="btn btn-ghost btn-sm"
                    @click="openTeamsModal(ev)">Teams</button>
            <button class="btn btn-ghost btn-sm" @click="openRosterImport(ev)">
              Import Roster
            </button>
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
            <option value="team">Team (FINA)</option>
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

  <!-- Team enrolment modal -->
  <div v-if="teamsModalOpen" class="modal-backdrop" @click="closeTeamsModal"></div>
  <div v-if="teamsModalOpen" class="modal teams-modal" @click.stop>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
      <h2 style="font-size:20px;font-style:italic">
        Teams in <span style="color:var(--cyan)">{{ teamsModalEvent?.name }}</span>
      </h2>
      <button class="btn btn-ghost btn-sm" @click="closeTeamsModal">Close ✕</button>
    </div>

    <div class="teams-section-label">Currently enrolled ({{ teamsInEvent.length }})</div>
    <ul v-if="teamsInEvent.length" class="enrolled-list">
      <li v-for="t in teamsInEvent" :key="t.id" class="enrolled-row">
        <span class="enrolled-name">
          {{ t.name }}<span v-if="t.short_code" class="enrolled-code">{{ t.short_code }}</span>
        </span>
        <button class="btn btn-danger btn-sm" :disabled="teamsBusy"
                @click="removeTeamFromEvent(t)">Remove</button>
      </li>
    </ul>
    <div v-else class="enrolled-empty">No teams enrolled yet.</div>

    <div class="teams-section-label" style="margin-top:1.25rem">Add a team</div>
    <div class="add-team-row">
      <select class="select" v-model="teamToAdd">
        <option value="">— Select a team —</option>
        <option v-for="t in addableTeams" :key="t.id" :value="t.id">
          {{ t.name }}{{ t.short_code ? ' (' + t.short_code + ')' : '' }}{{ t.member_count != null ? ' · ' + t.member_count + ' members' : '' }}
        </option>
      </select>
      <button class="btn btn-primary btn-sm"
              :disabled="!teamToAdd || teamsBusy"
              @click="addTeamToEvent">Add</button>
    </div>
    <p v-if="!addableTeams.length && !teamsBusy" class="hint-line">
      No more teams available — every team in the org is already enrolled, or the org has no teams. Create teams from
      <RouterLink to="/teams" style="color:var(--cyan)">/teams</RouterLink>.
    </p>
  </div>

  <!-- Roster CSV import modal -->
  <div v-if="rosterModalOpen" class="modal-backdrop" @click="closeRosterImport"></div>
  <div v-if="rosterModalOpen" class="modal roster-modal" @click.stop>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
      <div>
        <div class="teams-section-label">Import Roster</div>
        <h2 style="font-size:20px;font-style:italic;line-height:1">{{ rosterModalEvent?.name }}</h2>
      </div>
      <button class="btn btn-ghost btn-sm" @click="closeRosterImport">Close</button>
    </div>

    <p class="hint" style="margin-bottom:0.75rem">
      Paste a CSV with one diver per row. First row must be a header.
      Required columns: <code>username</code>,
      <code>round_1_code</code>, <code>round_1_pos</code>, …
      <span v-if="rosterModalEvent?.event_type === 'synchro_pair'">
        Synchro events also accept <code>partner_username</code>.
      </span>
      Existing dive list rows for the same diver + round are
      overwritten (idempotent re-runs).
    </p>

    <div class="field">
      <label class="label">Template header for this event</label>
      <input class="input mono"
             type="text"
             :value="rosterTemplateHeader(rosterModalEvent)"
             readonly
             style="font-size:11px"
             title="Click to select; copy as the first row of your CSV">
    </div>

    <div class="field">
      <label class="label">CSV</label>
      <textarea
        class="input mono"
        v-model="rosterCsv"
        rows="10"
        style="font-size:12px"
        placeholder="username,round_1_code,round_1_pos,round_2_code,round_2_pos&#10;phoenix.patel,5132,D,107,B&#10;..."
      ></textarea>
    </div>

    <div v-if="rosterErr" class="msg msg-error">{{ rosterErr }}</div>

    <div v-if="rosterResult" class="roster-result">
      <div class="msg msg-success">
        Added / updated rosters for <strong>{{ rosterResult.added }}</strong>
        diver{{ rosterResult.added === 1 ? '' : 's' }}<span v-if="rosterResult.skipped">, skipped {{ rosterResult.skipped }}</span>.
      </div>
      <div v-if="rosterResult.errors?.length" class="roster-errors">
        <div class="teams-section-label" style="margin-top:0.6rem">{{ rosterResult.errors.length }} row error(s)</div>
        <ul class="roster-error-list">
          <li v-for="(e, i) in rosterResult.errors" :key="i">
            <strong>{{ e.username }}</strong>: {{ e.error }}
          </li>
        </ul>
      </div>
    </div>

    <div style="display:flex;justify-content:flex-end;gap:0.5rem;margin-top:1rem">
      <button class="btn btn-ghost btn-sm" @click="closeRosterImport">Done</button>
      <button class="btn btn-primary btn-sm"
              :disabled="rosterBusy || !rosterCsv.trim()"
              @click="submitRosterImport">
        {{ rosterBusy ? 'Importing…' : 'Import' }}
      </button>
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
.hint-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-top: 0.5rem; }

.meet-list { display: flex; flex-direction: column; gap: 0.5rem; }
.meet-row {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.6rem 0.85rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.meet-row-id   { display: flex; flex-direction: column; gap: 0.2rem; min-width: 0; }
.meet-row-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  font-style: italic; color: var(--text); text-decoration: none;
}
.meet-row-name:hover { color: var(--cyan); }
.meet-row-meta {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.meet-live { color: var(--red); font-weight: 700; margin-left: 0.4rem; }

.roster-modal { max-width: 720px; }
.roster-modal .mono { font-family: var(--font-mono); }
.roster-modal textarea { resize: vertical; min-height: 180px; }
.roster-modal .hint code {
  font-family: var(--font-mono); font-size: 10.5px;
  background: var(--bg-2); border: 1px solid var(--border);
  padding: 0.05rem 0.3rem; border-radius: 3px;
  color: var(--cyan);
}

.roster-result { margin-top: 0.75rem; }
.roster-errors {
  margin-top: 0.4rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-left: 3px solid var(--amber); border-radius: 3px;
  padding: 0.6rem 0.8rem;
}
.roster-error-list {
  list-style: disc; padding-left: 1.25rem; margin: 0;
  font-family: var(--font-mono); font-size: 11.5px; color: var(--text-2);
  max-height: 200px; overflow-y: auto;
}
.roster-error-list li { margin: 0.15rem 0; }

.teams-modal { max-width: 560px; }
.teams-section-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.25em; text-transform: uppercase; color: var(--text-3);
  margin-bottom: 0.6rem;
}
.enrolled-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
.enrolled-row {
  display: flex; align-items: center; justify-content: space-between; gap: 0.6rem;
  padding: 0.5rem 0.75rem;
  background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.enrolled-name { font-family: var(--font-display); font-size: 13px; font-weight: 700; color: var(--text); }
.enrolled-code {
  font-family: var(--font-mono); font-size: 10px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan);
  background: var(--cyan-dim); border: 1px solid rgba(6,182,212,0.3);
  border-radius: 3px; padding: 0.1rem 0.4rem; margin-left: 0.5rem;
}
.enrolled-empty { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); padding: 0.4rem 0; font-style: italic; }
.add-team-row { display: flex; gap: 0.5rem; align-items: center; }
.add-team-row .select { flex: 1; }
</style>
