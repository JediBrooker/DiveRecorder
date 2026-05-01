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

// Partner autocomplete state. Keeps the rendering simple — no
// dependency, no popper. The dropdown overlays absolutely
// beneath the input and re-uses the same option labels the old
// <select> used.
const partnerSearch = ref('')      // what's currently in the input
const partnerOpen   = ref(false)   // dropdown visible?
const partnerActive = ref(0)       // keyboard-highlighted index in matches

// Filter the org's divers by the search term — case-insensitive
// against the full name + club_code. Empty term returns the
// whole list (capped at 30 to avoid drawing 1000 rows).
const partnerMatches = computed(() => {
  const term = partnerSearch.value.trim().toLowerCase()
  const list = orgDivers.value.filter((d) => {
    if (!term) return true
    const haystack = [d.full_name, d.club_code, d.club_name]
      .filter(Boolean).join(' ').toLowerCase()
    return haystack.includes(term)
  })
  return list.slice(0, 30)
})

// Selected partner's display name — shown in the input when
// closed. Looks up by id so re-selecting from the list shows
// the canonical name even if the user typed only a fragment.
const selectedPartnerLabel = computed(() => {
  if (!partnerId.value) return ''
  const p = orgDivers.value.find((d) => d.id === partnerId.value)
  if (!p) return ''
  return p.club_code ? `${p.full_name} (${p.club_code})` : p.full_name
})

function partnerLabel(d) {
  return d.club_code ? `${d.full_name} (${d.club_code})` : d.full_name
}

function focusPartner() {
  partnerOpen.value = true
  partnerActive.value = 0
  // If a partner is already chosen, clear the input on focus so
  // the user can search again. Re-selecting reverts the label.
  if (partnerId.value && partnerSearch.value === selectedPartnerLabel.value) {
    partnerSearch.value = ''
  }
}

function blurPartner() {
  // Delay close so a click on a list item registers before the
  // dropdown un-mounts.
  setTimeout(() => {
    partnerOpen.value = false
    if (!partnerId.value) {
      // No selection made — reset typed text
      partnerSearch.value = ''
    } else if (!partnerSearch.value.trim()) {
      // Restore the canonical label if the user blanked it
      partnerSearch.value = selectedPartnerLabel.value
    }
  }, 150)
}

function pickPartner(d) {
  partnerId.value = d.id
  partnerSearch.value = partnerLabel(d)
  partnerOpen.value = false
}

function clearPartner() {
  partnerId.value = ''
  partnerSearch.value = ''
  partnerActive.value = 0
}

function partnerKey(e) {
  if (!partnerOpen.value) {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      partnerOpen.value = true
      partnerActive.value = 0
    }
    return
  }
  const n = partnerMatches.value.length
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    partnerActive.value = (partnerActive.value + 1) % Math.max(n, 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    partnerActive.value = (partnerActive.value - 1 + n) % Math.max(n, 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    const pick = partnerMatches.value[partnerActive.value]
    if (pick) pickPartner(pick)
  } else if (e.key === 'Escape') {
    partnerOpen.value = false
  }
}

// Saved dive list templates. Persists per-diver across meets so
// a 6-dive 3m optionals list doesn't have to be retyped every
// month. Filtered to the active event's height when one is
// loaded so the picker only shows compatible templates.
const templates = ref([])
const saveTemplateName = ref('')
const saveTemplateOpen = ref(false)
const saveTemplateBusy = ref(false)
const templateError = ref('')

const matchingTemplates = computed(() => {
  if (!templates.value.length) return []
  if (!currentEvent.value?.height) return templates.value
  return templates.value.filter(
    t => !t.height || t.height === currentEvent.value.height,
  )
})

async function loadTemplates() {
  try {
    templates.value = await auth.apiFetch('/api/templates')
  } catch {
    templates.value = []
  }
}

function applyTemplate(t) {
  // Resolve each saved {dive_code, position} to its directory
  // entry at the event's height. Unknown dives are skipped with
  // a warning so a template applied at the wrong height still
  // partly populates.
  templateError.value = ''
  const eventHeight = activeEventHeight.value
  const newSelection = Array(selectedDives.value.length).fill(null)
  let missing = 0
  for (const item of (t.dives || [])) {
    const round = item.round_number
    if (!round || round < 1 || round > newSelection.length) continue
    const match = diveDirectory.value.find(d =>
      d.dive_code === item.dive_code &&
      d.position  === item.position &&
      (eventHeight === null || parseFloat(d.height) === eventHeight),
    )
    if (match) newSelection[round - 1] = match
    else missing++
  }
  selectedDives.value = newSelection
  if (missing) {
    templateError.value = `Loaded — ${missing} dive(s) skipped (not in directory at this height).`
  }
}

async function saveAsTemplate() {
  templateError.value = ''
  const name = saveTemplateName.value.trim()
  if (!name) {
    templateError.value = 'Pick a name first'
    return
  }
  saveTemplateBusy.value = true
  try {
    const dives = selectedDives.value
      .map((d, i) => d ? {
        round_number: i + 1,
        dive_code: d.dive_code,
        position:  d.position,
      } : null)
      .filter(Boolean)
    const saved = await auth.apiFetch('/api/templates', {
      method: 'POST',
      body: JSON.stringify({
        name,
        height: currentEvent.value?.height || null,
        dives,
      }),
    })
    // Replace if it already existed (server upserts on name).
    templates.value = [
      saved,
      ...templates.value.filter(t => t.name !== saved.name),
    ]
    saveTemplateName.value = ''
    saveTemplateOpen.value = false
  } catch (err) {
    templateError.value = err.message
  } finally {
    saveTemplateBusy.value = false
  }
}

async function deleteTemplate(t) {
  if (!confirm(`Delete template "${t.name}"?`)) return
  try {
    await auth.apiFetch(`/api/templates/${t.id}`, { method: 'DELETE' })
    templates.value = templates.value.filter(x => x.id !== t.id)
  } catch (err) {
    alert('Failed to delete: ' + err.message)
  }
}

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
  partnerSearch.value = ''
  partnerOpen.value = false
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
    loadTemplates(),
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

    <!-- Synchro partner picker — autocomplete typeahead. Replaces
         a flat <select> that became unwieldy in orgs with 100+
         divers. Filters as the user types; arrow keys + enter
         navigate the dropdown. -->
    <div v-if="isSynchro" class="card">
      <label class="label" style="margin-bottom:0.75rem;display:block">
        Step 1.5 — Pick Your Synchro Partner
      </label>
      <div class="partner-typeahead">
        <input
          class="input"
          type="text"
          autocomplete="off"
          :placeholder="orgDivers.length ? 'Search by name…' : 'No other divers in your org yet'"
          :disabled="!orgDivers.length"
          v-model="partnerSearch"
          @focus="focusPartner"
          @blur="blurPartner"
          @keydown="partnerKey"
        >
        <button v-if="partnerId || partnerSearch"
                type="button"
                class="partner-clear"
                @mousedown.prevent="clearPartner"
                title="Clear">✕</button>
        <ul v-if="partnerOpen && partnerMatches.length" class="partner-dropdown">
          <li v-for="(d, i) in partnerMatches" :key="d.id"
              :class="['partner-row', i === partnerActive ? 'partner-row-active' : '', d.id === partnerId ? 'partner-row-selected' : '']"
              @mousedown.prevent="pickPartner(d)"
              @mouseenter="partnerActive = i">
            <span class="partner-name">{{ d.full_name }}</span>
            <span v-if="d.club_code" class="partner-club">{{ d.club_code }}</span>
          </li>
        </ul>
        <div v-else-if="partnerOpen && !partnerMatches.length && partnerSearch.trim()"
             class="partner-dropdown partner-empty">
          No divers match "{{ partnerSearch }}".
        </div>
      </div>
      <p v-if="!orgDivers.length" class="hint-line" style="margin-top:0.5rem">
        No other divers found in your organisation yet. Ask your partner to register first.
      </p>
      <p v-else class="hint-line" style="margin-top:0.5rem">
        Both you and your partner perform the same dive list — you only submit it from one account.
      </p>
    </div>

    <div v-if="currentEvent">
      <!-- Templates strip — shows only when at least one saved
           template matches the active event's height. Tapping
           a template fills the dive slots; the diver can then
           tweak before submitting. -->
      <div v-if="matchingTemplates.length || templates.length" class="card template-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:0.75rem;gap:0.5rem;flex-wrap:wrap">
          <label class="label" style="margin:0">Saved templates</label>
          <button class="btn btn-ghost btn-sm" @click="saveTemplateOpen = !saveTemplateOpen">
            {{ saveTemplateOpen ? 'Cancel' : 'Save current as template' }}
          </button>
        </div>

        <div v-if="!matchingTemplates.length" class="hint-line">
          No templates for this height yet. Build a list, then save it.
        </div>
        <div v-else class="template-list">
          <div v-for="t in matchingTemplates" :key="t.id" class="template-row">
            <div class="template-id">
              <span class="template-name">{{ t.name }}</span>
              <span v-if="t.height" class="template-height">{{ t.height }}</span>
              <span class="template-count">{{ (t.dives || []).length }} dive{{ (t.dives || []).length === 1 ? '' : 's' }}</span>
            </div>
            <div class="template-actions">
              <button class="btn btn-ghost btn-sm" @click="applyTemplate(t)">Load</button>
              <button class="btn btn-ghost btn-sm" @click="deleteTemplate(t)" title="Delete template">✕</button>
            </div>
          </div>
        </div>

        <div v-if="saveTemplateOpen" class="template-save-form">
          <input
            class="input"
            type="text"
            v-model="saveTemplateName"
            placeholder='Name (e.g. "3m optionals 2026")'
            @keyup.enter="saveAsTemplate"
          >
          <button class="btn btn-primary btn-sm"
                  :disabled="saveTemplateBusy"
                  @click="saveAsTemplate">
            {{ saveTemplateBusy ? 'Saving…' : 'Save' }}
          </button>
        </div>
        <div v-if="templateError" class="msg msg-error" style="margin-top:0.6rem">{{ templateError }}</div>
      </div>

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

/* Saved-template strip */
.template-card { padding: 1rem 1.25rem; }
.template-list { display: flex; flex-direction: column; gap: 0.4rem; margin-bottom: 0.5rem; }
.template-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem; padding: 0.5rem 0.7rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.template-id { display: flex; align-items: baseline; gap: 0.5rem; min-width: 0; }
.template-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.template-height {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  letter-spacing: 0.05em; color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.05rem 0.35rem;
}
.template-count {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
.template-actions { display: flex; gap: 0.3rem; flex-shrink: 0; }

.template-save-form {
  display: flex; gap: 0.5rem; margin-top: 0.5rem;
}
.template-save-form .input { flex: 1; }

/* =========================================================
   Synchro partner typeahead
   ========================================================= */
.partner-typeahead { position: relative; }
.partner-typeahead .input { padding-right: 2.4rem; }
.partner-clear {
  position: absolute; top: 50%; right: 0.5rem;
  transform: translateY(-50%);
  width: 24px; height: 24px;
  display: flex; align-items: center; justify-content: center;
  background: transparent; border: none; cursor: pointer;
  color: var(--text-3); font-size: 14px;
  border-radius: 50%; transition: all 0.1s;
}
.partner-clear:hover { color: var(--red); background: var(--bg-3); }

.partner-dropdown {
  position: absolute; top: calc(100% + 4px); left: 0; right: 0;
  z-index: 50; max-height: 280px; overflow-y: auto;
  background: var(--surface); border: 1px solid var(--border-2);
  border-radius: var(--radius);
  list-style: none; padding: 0.25rem; margin: 0;
  box-shadow: 0 10px 30px rgba(0,0,0,0.45);
}
.partner-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 0.5rem; padding: 0.5rem 0.7rem;
  border-radius: var(--radius-sm); cursor: pointer;
}
.partner-row + .partner-row { margin-top: 0.1rem; }
.partner-row-active { background: var(--cyan-dim); }
.partner-row-selected .partner-name { color: var(--cyan); }
.partner-name {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text);
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.partner-club {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.3); border-radius: 3px;
  padding: 0.1rem 0.4rem;
}
.partner-empty {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  padding: 0.7rem 0.8rem; font-style: italic;
}
</style>
