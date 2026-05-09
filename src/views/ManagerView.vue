<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { confirmAction } from '@/composables/useConfirm'
import { showSuccess, showError } from '@/composables/useNotify'
import StatusPill from '@/components/StatusPill.vue'

const auth = useAuthStore()

const events = ref([])
const meets = ref([])
const formErr = ref('')
const editErr = ref('')
const showCreateModal = ref(false)     // New Event form lives in a modal
const showEditModal = ref(false)

// Create form
const createName = ref('')
const createGender = ref('Female')
const createHeight = ref('')
const createJudges = ref(5)
const createType = ref('individual')
const createMeetId = ref('')           // optional — bundle this event into a meet

// Migration 039: operator-prescribed round dives. The "Number of
// Rounds" dropdown is gone; total rounds is derived from this
// array's length. Each entry: { dive_id|null, height|null }.
// Push a row via "+ Add Dive" or "Add N rounds" quick-add.
const createRoundDives = ref([])
function addRoundDive(slot) {
  const next = slot || { dive_id: null, height: null, _label: '' }
  createRoundDives.value.push(next)
}
function removeRoundDive(idx) {
  createRoundDives.value.splice(idx, 1)
}
function bulkAddRounds(n) {
  for (let i = 0; i < n; i++) addRoundDive()
}
// Derived total rounds. Existing template/code referencing
// `createRounds` keeps working without churn.
const createRounds = computed(() => createRoundDives.value.length)

// Dive directory + per-row autocomplete. Loaded once on mount;
// `divePickerOpenIdx` is the index of the round-row whose
// search popover is currently visible (-1 = none).
const diveDirectory     = ref([])
const divePickerOpenIdx = ref(-1)
const divePickerCtx     = ref(null)   // 'create' | 'edit'
const divePickerQuery   = ref('')

async function loadDiveDirectory() {
  try {
    diveDirectory.value = await auth.apiFetch('/api/dive-directory')
  } catch {
    diveDirectory.value = []
  }
}

function openDivePicker(idx, ctx) {
  divePickerOpenIdx.value = idx
  divePickerCtx.value     = ctx
  divePickerQuery.value   = ''
}
function closeDivePicker() {
  divePickerOpenIdx.value = -1
  divePickerCtx.value     = null
}

// Delayed close for @blur on the search input — gives a click on
// a result row time to fire its @mousedown.prevent first.
function onPickerBlur(idx, ctx) {
  setTimeout(() => {
    if (divePickerOpenIdx.value === idx && divePickerCtx.value === ctx) {
      closeDivePicker()
    }
  }, 150)
}

// Filter the dive directory to rows matching the picker's query
// AND, when the event has a fixed height, that height. Returns
// at most 25 rows so the dropdown stays usable.
const divePickerResults = computed(() => {
  const q = divePickerQuery.value.toLowerCase().trim()
  const isMixed = divePickerCtx.value === 'edit' ? !!editMixedHeight.value : !!createMixedHeight.value
  const fixedHeight = divePickerCtx.value === 'edit' ? editHeight.value : createHeight.value
  const slot = divePickerCtx.value === 'edit'
    ? editRoundDives.value[divePickerOpenIdx.value]
    : createRoundDives.value[divePickerOpenIdx.value]
  // For mixed-board events with a per-slot height override, only
  // dives at that height appear.
  const slotHeight = slot && slot.height != null && slot.height !== ''
    ? Number(slot.height)
    : null
  const heightMatch = (d) => {
    if (slotHeight != null) return Number(d.height) === slotHeight
    if (isMixed) return true
    if (!fixedHeight) return true
    const fh = parseFloat(fixedHeight)
    return Number(d.height) === fh
  }
  return diveDirectory.value
    .filter((d) => {
      if (!heightMatch(d)) return false
      if (!q) return true
      const combined = (d.dive_code + (d.position || '')).toLowerCase()
      return combined.includes(q)
        || (d.description || '').toLowerCase().includes(q)
    })
    .slice(0, 25)
})

function selectDiveForRow(dive) {
  const idx = divePickerOpenIdx.value
  if (idx < 0) return
  const target = divePickerCtx.value === 'edit'
    ? editRoundDives.value
    : createRoundDives.value
  target[idx].dive_id = dive.id
  target[idx]._label  = `${dive.dive_code}${dive.position || ''} · DD ${dive.dd}`
  target[idx]._meta   = {
    dive_code: dive.dive_code,
    position:  dive.position,
    dd:        dive.dd,
    height:    Number(dive.height),
    description: dive.description,
  }
  closeDivePicker()
}

function clearDiveForRow(idx, ctx) {
  const target = ctx === 'edit' ? editRoundDives.value : createRoundDives.value
  target[idx].dive_id = null
  target[idx]._label  = ''
  target[idx]._meta   = null
}

// "Add new dive" sub-modal — POSTs to /api/dive-directory and,
// on success, drops the new dive into the row that opened the
// picker.
const showCreateDiveModal = ref(false)
const newDiveCtx          = ref(null)   // remembers which row to fill on success
const newDiveRowIdx       = ref(-1)
const newDiveCode = ref('')
const newDiveHeight = ref('1m')
const newDivePosition = ref('B')
const newDiveDd = ref('')
const newDiveDescription = ref('')
const newDiveErr = ref('')
const newDiveBusy = ref(false)

function openCreateDiveModal(ctx, idx) {
  newDiveCtx.value    = ctx
  newDiveRowIdx.value = idx
  newDiveCode.value = ''
  // Seed height from the event's chosen height when available so
  // the operator doesn't have to re-pick it.
  const evHeight = ctx === 'edit' ? editHeight.value : createHeight.value
  newDiveHeight.value = evHeight || '1m'
  newDivePosition.value = 'B'
  newDiveDd.value = ''
  newDiveDescription.value = ''
  newDiveErr.value = ''
  showCreateDiveModal.value = true
}
function closeCreateDiveModal() {
  showCreateDiveModal.value = false
}

async function submitCreateDive() {
  newDiveErr.value = ''
  if (!newDiveCode.value || !newDiveDd.value) {
    newDiveErr.value = 'Dive code and DD are required'
    return
  }
  newDiveBusy.value = true
  try {
    const heightNumeric = parseFloat(newDiveHeight.value)
    const created = await auth.apiFetch('/api/dive-directory', {
      method: 'POST',
      body: JSON.stringify({
        dive_code: newDiveCode.value.trim(),
        height:    heightNumeric,
        position:  newDivePosition.value,
        dd:        parseFloat(newDiveDd.value),
        description: newDiveDescription.value || null,
      }),
    })
    // Append to the local cache so the picker sees it without
    // a full reload.
    diveDirectory.value = [...diveDirectory.value, created]
    // Drop it into the opener row.
    divePickerOpenIdx.value = newDiveRowIdx.value
    divePickerCtx.value     = newDiveCtx.value
    selectDiveForRow(created)
    showCreateDiveModal.value = false
  } catch (err) {
    newDiveErr.value = err.message || 'Failed to create dive'
  } finally {
    newDiveBusy.value = false
  }
}

// Migration 031: sign-off policy + multi-board flag.
const createEnforceSignoff = ref(false) // hard gate — push or credential only
const createMixedHeight    = ref(false) // event spans multiple boards
// Help-popover toggles
const showSignoffHelp     = ref(false)
const showMixedHeightHelp = ref(false)

// Migration 013 additions: age group, scheduled start, event
// format (final / preliminary), prelim/final link, advance count,
// per-round DD limits.
const createAgeGroup     = ref('')
const createScheduledAt  = ref('')      // datetime-local string, '' = unscheduled
const createEntriesCloseAt = ref('')    // datetime-local string, '' = no deadline
const createFormat       = ref('final') // 'final' | 'preliminary'
const createParentEventId = ref('')     // set on a 'final' to link its prelim
const createAdvanceCount = ref(12)      // FINA standard
const createDdLimitRounds = ref(0)      // 0 = no limit
const createDdLimitValue  = ref('')     // '' = no limit; numeric otherwise

// Round structure (migration 038). Empty array = legacy
// behaviour (use the dd_limit_* pair above). Populated = a list
// of sections, each with its own DD cap + min-distinct-groups
// rule. Mirrors real-world FINA / Diving Australia bulletins —
// e.g. "4 dives @ 7.6 from 4 different groups + 4 dives unlimited
// from 4 different groups" → two sections with rounds=4 each,
// dd_limit=7.6 and null, min_distinct_groups=4 on both.
//
// min_distinct_groups is independent of rounds, so an operator
// can also express "5 dives drawn from 4 different groups" (one
// group is allowed to repeat) or "1 dive from any group" (leave
// min_distinct_groups blank).
const createRoundSections = ref([])
function addRoundSection(preset) {
  const next = preset || {
    label: createRoundSections.value.length === 0 ? 'Voluntary' : 'Optional',
    rounds: 4,
    dd_limit: '',                     // '' = unlimited
    min_distinct_groups: '',          // '' = no group constraint
  }
  createRoundSections.value.push(next)
}
function removeRoundSection(idx) {
  createRoundSections.value.splice(idx, 1)
}
const sectionsRoundsTotal = computed(() =>
  createRoundSections.value.reduce((sum, s) => sum + (parseInt(s.rounds) || 0), 0),
)
function buildRoundRulesPayload() {
  // Empty array → null (legacy mode); non-empty → JSON object
  // shaped per migration 038 / lib/round-rules.js.
  if (!createRoundSections.value.length) return null
  return {
    sections: createRoundSections.value.map(s => ({
      label: s.label || null,
      rounds: parseInt(s.rounds) || 0,
      dd_limit: s.dd_limit === '' || s.dd_limit == null
        ? null
        : Number(parseFloat(s.dd_limit).toFixed(1)),
      min_distinct_groups: s.min_distinct_groups === '' || s.min_distinct_groups == null
        ? null
        : parseInt(s.min_distinct_groups) || null,
    })),
  }
}

// Event templates — saved form configurations the manager can
// apply to a fresh event with one click.
const eventTemplates = ref([])
const saveTemplateOpen = ref(false)
const saveTemplateName = ref('')
const saveTemplateBusy = ref(false)
const templateErr = ref('')

async function loadEventTemplates() {
  try {
    eventTemplates.value = await auth.apiFetch('/api/event-templates')
  } catch {
    eventTemplates.value = []
  }
}

function applyEventTemplate(t) {
  const c = t.config || {}
  // Name is intentionally NOT pulled in — the saved name is
  // usually a season-specific label that the manager wants to
  // re-write for the new event. Everything else fills.
  if (c.gender)            createGender.value = c.gender
  if (c.height !== undefined) createHeight.value = c.height || ''
  if (c.number_of_judges)  createJudges.value = c.number_of_judges
  if (c.total_rounds) {
    // Templates carry total_rounds (legacy); seed N free slots so
    // the operator can pin specific dives or leave the slots blank
    // for diver choice.
    createRoundDives.value = Array.from({ length: c.total_rounds }, () => ({
      dive_id: null, height: null, _label: '',
    }))
  }
  if (c.event_type)        createType.value = c.event_type
  if (c.age_group !== undefined)        createAgeGroup.value = c.age_group || ''
  if (c.event_format)      createFormat.value = c.event_format
  if (c.advance_count)     createAdvanceCount.value = c.advance_count
  if (c.dd_limit_rounds !== undefined)  createDdLimitRounds.value = c.dd_limit_rounds || 0
  if (c.dd_limit_value !== undefined)   createDdLimitValue.value = c.dd_limit_value ?? ''
  // Round structure (migration 038). When the template carries
  // round_rules, hydrate the editor; otherwise clear so the
  // form falls back to the legacy DD-limit pair.
  if (c.round_rules && Array.isArray(c.round_rules.sections)) {
    createRoundSections.value = c.round_rules.sections.map(s => ({
      label: s.label || '',
      rounds: s.rounds,
      dd_limit: s.dd_limit == null ? '' : String(s.dd_limit),
      min_distinct_groups: s.min_distinct_groups == null ? '' : String(s.min_distinct_groups),
    }))
  } else {
    createRoundSections.value = []
  }
}

async function saveAsEventTemplate() {
  templateErr.value = ''
  const name = saveTemplateName.value.trim()
  if (!name) {
    templateErr.value = 'Pick a template name'
    return
  }
  saveTemplateBusy.value = true
  try {
    // Build the config snapshot from the current form state.
    // event-specific fields like meet_id and parent_event_id are
    // intentionally excluded — a template should be re-usable
    // across meets.
    const config = {
      gender: createGender.value,
      height: createHeight.value || null,
      number_of_judges: parseInt(createJudges.value),
      total_rounds: parseInt(createRounds.value),
      event_type: createType.value,
      age_group: createAgeGroup.value || null,
      event_format: createFormat.value,
      advance_count: parseInt(createAdvanceCount.value) || 12,
      dd_limit_rounds: parseInt(createDdLimitRounds.value) || 0,
      dd_limit_value: createDdLimitValue.value
        ? parseFloat(createDdLimitValue.value)
        : null,
      round_rules: buildRoundRulesPayload(),
    }
    const saved = await auth.apiFetch('/api/event-templates', {
      method: 'POST',
      body: JSON.stringify({ name, config }),
    })
    // Replace any prior entry by name (server upserts).
    eventTemplates.value = [
      saved,
      ...eventTemplates.value.filter(t => t.name !== saved.name),
    ].sort((a, b) => a.name.localeCompare(b.name))
    saveTemplateOpen.value = false
    saveTemplateName.value = ''
  } catch (err) {
    templateErr.value = err.message
  } finally {
    saveTemplateBusy.value = false
  }
}

async function deleteEventTemplate(t) {
  if (!await confirmAction({
    title: `Delete template "${t.name}"?`,
    body:  'Templates are scoped to your federation. Existing events keyed off this template are not affected.',
    confirmLabel: 'Delete template',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/event-templates/${t.id}`, { method: 'DELETE' })
    eventTemplates.value = eventTemplates.value.filter(x => x.id !== t.id)
    showSuccess(`Deleted template "${t.name}"`)
  } catch (err) {
    showError(`Failed to delete: ${err.message}`)
  }
}

// True if some other event in the visible list points at `ev`
// as its parent_event_id. Used to decide whether to render the
// "Advance Top N" button on a feeder stage.
function eventHasNextStage(ev) {
  return events.value.some(other => other.parent_event_id === ev.id)
}

async function advanceToNextStage(ev) {
  // Friendly label for the confirm dialog. Looks up what kind
  // of event the source feeds into so the operator sees
  // "advance to semi-final" vs "advance to final" rather than
  // a generic "next stage."
  const downstream = events.value.find(other => other.parent_event_id === ev.id)
  const targetLabel = downstream
    ? (downstream.event_format === 'semifinal' ? 'semi-final'
       : downstream.event_format === 'final'   ? 'final'
       : 'next stage')
    : 'next stage'
  if (!await confirmAction({
    title: `Advance top ${ev.advance_count || 12} to ${targetLabel}?`,
    body:  `Seeds "${targetLabel}" with the top ${ev.advance_count || 12} divers from "${ev.name}" plus their dive lists.`,
    consequences: [
      `Divers can edit their dive lists before the ${targetLabel} goes Live (subject to entries-close)`,
      'Re-running after a score correction is safe — existing rows for these divers are overwritten (idempotent)',
    ],
    confirmLabel: `Advance to ${targetLabel}`,
    confirmKind:  'primary',
  })) return
  try {
    const result = await auth.apiFetch(`/api/events/${ev.id}/advance`, {
      method: 'POST',
    })
    showSuccess(`Advanced ${result.advanced} diver${result.advanced === 1 ? '' : 's'} to the ${targetLabel}.`)
    await loadEvents()
  } catch (err) {
    showError(`Failed to advance: ${err.message}`)
  }
}

// Meet management — separate from event create/edit. A meet is
// a bundle of events; org admins create them here so events
// can be filed under e.g. "2026 National Open".
const meetForm = ref({
  name: '', venue: '', start_date: '', end_date: '',
})
const meetFormErr = ref('')

// Sysadmin-only org filter for the events list. The /api/events
// endpoint returns every org's events when called with a
// sysadmin token; this filter narrows the displayed view
// without re-fetching.
const orgFilter = ref('')

// Free-text search over the events list — matches event name,
// venue name (when present), age group, and the linked meet
// name. Pure client-side; the events array is already in
// memory after the initial /api/events fetch.
const eventSearch = ref('')

// Status filter chips — null = "show all", or one of the event
// status values. Lets an operator focus on whatever lifecycle
// stage they're currently working on (live runs first, post-
// meet recap browsing second, etc.).
const eventStatusFilter = ref(null)
const STATUS_CHIPS = [
  { value: null,        label: 'All' },
  { value: 'Upcoming',  label: 'Upcoming' },
  { value: 'Live',      label: 'Live' },
  { value: 'Completed', label: 'Completed' },
]
function statusChipCount(value) {
  // Count is org-aware so the sysadmin's All-orgs view doesn't
  // misreport when an org filter is active.
  const base = orgFilter.value
    ? events.value.filter(e => e.org_id === orgFilter.value)
    : events.value
  if (value === null) return base.length
  return base.filter(e => e.status === value).length
}

const uniqueOrgs = computed(() => {
  const map = new Map()
  for (const ev of events.value) {
    if (!ev.org_id) continue
    if (!map.has(ev.org_id)) {
      map.set(ev.org_id, {
        id: ev.org_id,
        name: ev.org_name || 'Unknown',
        country_code: ev.country_code || null,
        count: 0,
      })
    }
    map.get(ev.org_id).count++
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name))
})
const uniqueOrgCount = computed(() => uniqueOrgs.value.length)

const filteredManagerEvents = computed(() => {
  let list = events.value
  // 1. Org filter (sysadmin only).
  if (orgFilter.value) {
    list = list.filter(ev => ev.org_id === orgFilter.value)
  }
  // 2. Status chip.
  if (eventStatusFilter.value) {
    list = list.filter(ev => ev.status === eventStatusFilter.value)
  }
  // 3. Free-text search across name + age group + venue + meet
  //    name. Substring match (case-insensitive); the input is
  //    debounced via Vue's reactivity granularity already, no
  //    explicit timer needed for an in-memory list.
  const q = eventSearch.value.trim().toLowerCase()
  if (q) {
    list = list.filter((ev) => {
      const haystack = [
        ev.name,
        ev.age_group,
        ev.venue,
        ev.meet_name,
        ev.org_name,
      ].filter(Boolean).join(' ').toLowerCase()
      return haystack.includes(q)
    })
  }
  return list
})

// Candidate parent events for the prelim → semi → final chain.
// A 'semifinal' can only feed from a 'preliminary'; a 'final'
// can feed from either. Cross-org pairing isn't permitted.
const parentCandidates = computed(() => {
  const allowedParentFormats =
    createFormat.value === 'semifinal' ? ['preliminary']
    : createFormat.value === 'final'    ? ['preliminary', 'semifinal']
    : []
  return events.value
    .filter(ev =>
      allowedParentFormats.includes(ev.event_format) &&
      (!auth.user?.is_system_admin
        ? true   // non-sysadmin only sees own org via /api/events
        : ev.org_id === auth.user?.org_id),
    )
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
})

// Default advance counts mirroring World Aquatics individual rules.
// Operators can override per event.
const defaultAdvanceCount = computed(() => {
  // prelim → semi (default 18); prelim → final or semi → final (default 12)
  if (createFormat.value !== 'final' && createFormat.value !== 'semifinal') return 18
  // For a final, look at what the parent is to suggest a default.
  const parent = parentCandidates.value.find(p => p.id === createParentEventId.value)
  if (parent?.event_format === 'preliminary' && createFormat.value === 'semifinal') return 18
  return 12
})

// Edit form
const editId = ref('')
const editName = ref('')
const editGender = ref('Female')
const editHeight = ref('')
const editJudges = ref(5)
const editType = ref('individual')
const editEntriesCloseAt = ref('')   // datetime-local string, '' = no deadline
const editEnforceSignoff = ref(false)
const editMixedHeight    = ref(false)
// Migration 039: prescribed round dives mirrored into the Edit
// modal. Same shape as createRoundDives — each entry is
// { dive_id|null, height|null, _label, _meta }.
const editRoundDives    = ref([])
const editRounds        = computed(() => editRoundDives.value.length)
// Migration 038: round structure (sections). Edit modal previously
// couldn't touch round_rules at all — fixed here.
const editRoundSections = ref([])
function addEditRoundSection() {
  editRoundSections.value.push({
    label: editRoundSections.value.length === 0 ? 'Voluntary' : 'Optional',
    rounds: 4,
    dd_limit: '',
    min_distinct_groups: '',
  })
}
function removeEditRoundSection(idx) {
  editRoundSections.value.splice(idx, 1)
}
const editSectionsRoundsTotal = computed(() =>
  editRoundSections.value.reduce((sum, s) => sum + (parseInt(s.rounds) || 0), 0),
)
function buildEditRoundRulesPayload() {
  if (!editRoundSections.value.length) return null
  return {
    sections: editRoundSections.value.map(s => ({
      label: s.label || null,
      rounds: parseInt(s.rounds) || 0,
      dd_limit: s.dd_limit === '' || s.dd_limit == null
        ? null
        : Number(parseFloat(s.dd_limit).toFixed(1)),
      min_distinct_groups: s.min_distinct_groups === '' || s.min_distinct_groups == null
        ? null
        : parseInt(s.min_distinct_groups) || null,
    })),
  }
}
function addEditRoundDive(slot) {
  const next = slot || { dive_id: null, height: null, _label: '', _meta: null }
  editRoundDives.value.push(next)
}
function removeEditRoundDive(idx) {
  editRoundDives.value.splice(idx, 1)
}
function bulkAddEditRounds(n) {
  for (let i = 0; i < n; i++) addEditRoundDive()
}

// Team enrolment modal — open when "Teams" clicked on a team-event row
const teamsModalOpen = ref(false)
const teamsModalEvent = ref(null)
const teamsInEvent = ref([])
const orgTeams = ref([])
const teamToAdd = ref('')
const teamsBusy = ref(false)

// Participating-orgs modal — open when "Federations" clicked on
// any event row by an org admin. Lists OTHER federations whose
// divers can self-enter the event. Empty list = domestic-only.
// All endpoints live in routes/events.js (migration 036).
const partOrgsModalOpen  = ref(false)
const partOrgsModalEvent = ref(null)
const partOrgsInEvent    = ref([])    // currently invited
const partOrgsAvailable  = ref([])    // active orgs not yet invited (excl. host)
const partOrgsToAdd      = ref('')
const partOrgsBusy       = ref(false)

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
  // 0m is the poolside / pool-deck progression — sit-dives, kneel-
  // dives, standing falls. Surfaces in the same height select the
  // 1m..10m boards use so a coach can run a beginner session in
  // DiveRecorder without faking a 1m event.
  '0m': 'Poolside (0m)',
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
    const body = await auth.apiFetch(`/api/orgs/${auth.user.org_id}/meets`)
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
  if (!await confirmAction({
    title: `Delete meet "${meet.name}"?`,
    body:  `The meet bundle is removed but its ${meet.event_count} event${meet.event_count === 1 ? ' stays' : 's stay'} intact.`,
    consequences: [
      `${meet.event_count} event${meet.event_count === 1 ? '' : 's'} will become standalone (no meet attribution)`,
      'Public meet landing page (/meet/<id>) becomes 404',
      'Existing scores, audit log, and recap PDFs are unaffected',
    ],
    confirmLabel: 'Delete meet',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/meets/${meet.id}`, { method: 'DELETE' })
    await Promise.all([loadMeets(), loadEvents()])
    showSuccess(`Deleted meet "${meet.name}"`)
  } catch (err) {
    showError(`Failed to delete meet: ${err.message}`)
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
    showError('Failed: ' + err.message)
  }
}

async function createEvent() {
  formErr.value = ''
  // Synchro panels must be 9 or 11 — preempt the server error
  if (createType.value === 'synchro_pair' && ![9, 11].includes(parseInt(createJudges.value))) {
    formErr.value = 'Synchronised pair events require 9 or 11 judges'
    return
  }
  if (!createRoundDives.value.length) {
    formErr.value = 'Add at least one dive (or free slot) so the event has rounds'
    return
  }
  try {
    await auth.apiFetch('/api/events', {
      method: 'POST',
      body: JSON.stringify({
        name: createName.value,
        gender: createGender.value,
        // Mixed-board events leave the height column NULL — the
        // server does the same coercion server-side, but pre-
        // emptively clearing it here means the dive picker that
        // reads form state during validation doesn't see a stale
        // height pinned in.
        height: createMixedHeight.value ? null : (createHeight.value || null),
        number_of_judges: parseInt(createJudges.value),
        // total_rounds is now derived server-side from round_dives
        // length. Send it anyway so legacy code paths (no slots)
        // still work — the server prefers round_dives when both
        // are present.
        total_rounds: createRoundDives.value.length,
        round_dives: createRoundDives.value.map((slot, i) => ({
          round_number: i + 1,
          dive_id: slot.dive_id || null,
          height: slot.height == null || slot.height === ''
            ? null
            : Number(slot.height),
        })),
        event_type: createType.value,
        meet_id: createMeetId.value || null,
        age_group: createAgeGroup.value || null,
        scheduled_at: createScheduledAt.value || null,
        entries_close_at: createEntriesCloseAt.value || null,
        event_format: createFormat.value,
        // Parent link is meaningful for downstream stages —
        // semifinals always feed from a preliminary; finals may
        // feed from either (or none, when standalone).
        parent_event_id: createFormat.value !== 'preliminary' && createParentEventId.value
          ? createParentEventId.value
          : null,
        advance_count: parseInt(createAdvanceCount.value) || 12,
        dd_limit_rounds: parseInt(createDdLimitRounds.value) || 0,
        dd_limit_value: createDdLimitValue.value
          ? parseFloat(createDdLimitValue.value)
          : null,
        round_rules: buildRoundRulesPayload(),
        enforce_referee_signoff: createEnforceSignoff.value,
        is_mixed_height:         createMixedHeight.value,
      }),
    })
    createName.value = ''
    createGender.value = 'Female'
    createHeight.value = ''
    createJudges.value = 5
    createRoundDives.value = []
    createType.value = 'individual'
    createMeetId.value = ''
    createAgeGroup.value = ''
    createScheduledAt.value = ''
    createEntriesCloseAt.value = ''
    createFormat.value = 'final'
    createParentEventId.value = ''
    createAdvanceCount.value = 12
    createDdLimitRounds.value = 0
    createDdLimitValue.value = ''
    createRoundSections.value = []
    createEnforceSignoff.value = false
    createMixedHeight.value = false
    showCreateModal.value = false
    await Promise.all([loadEvents(), loadMeets()])
  } catch (err) {
    formErr.value = err.message
  }
}

async function openEdit(ev) {
  editId.value = ev.id
  editName.value = ev.name
  editGender.value = ev.gender
  editHeight.value = ev.height || ''
  editJudges.value = ev.number_of_judges
  editType.value = ev.event_type || 'individual'
  editEnforceSignoff.value = !!ev.enforce_referee_signoff
  editMixedHeight.value    = !!ev.is_mixed_height
  // entries_close_at comes back as an ISO string from the server.
  // <input type="datetime-local"> wants 'YYYY-MM-DDTHH:mm' in local
  // time, no zone, no seconds — so format it for display.
  if (ev.entries_close_at) {
    const d = new Date(ev.entries_close_at)
    const pad = (n) => String(n).padStart(2, '0')
    editEntriesCloseAt.value =
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
      `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  } else {
    editEntriesCloseAt.value = ''
  }
  editErr.value = ''
  // Hydrate round_rules sections from the event row.
  if (ev.round_rules && Array.isArray(ev.round_rules.sections)) {
    editRoundSections.value = ev.round_rules.sections.map((s) => ({
      label: s.label || '',
      rounds: s.rounds,
      dd_limit: s.dd_limit == null ? '' : String(s.dd_limit),
      min_distinct_groups: s.min_distinct_groups == null ? '' : String(s.min_distinct_groups),
    }))
  } else {
    editRoundSections.value = []
  }
  // Hydrate prescribed round_dives. The event row's `total_rounds`
  // is the source of truth for slot count when no rows exist; we
  // fetch the enriched array from the dedicated endpoint so each
  // pre-filled row carries its dive metadata for the picker label.
  editRoundDives.value = []
  try {
    const rd = await auth.apiFetch(`/api/events/${ev.id}/round-dives`)
    if (Array.isArray(rd) && rd.length) {
      editRoundDives.value = rd.map((row) => ({
        dive_id: row.dive_id || null,
        height:  row.height  ?? null,
        _label:  row.dive_id
          ? `${row.dive_code}${row.position || ''} · DD ${row.dd}`
          : '',
        _meta:   row.dive_id ? {
          dive_code: row.dive_code,
          position:  row.position,
          dd:        row.dd,
          height:    Number(row.dive_height ?? row.height ?? 0),
          description: row.description,
        } : null,
      }))
    } else {
      // No prescribed rows yet — synthesise free slots matching
      // the event's stored total_rounds so the editor isn't empty.
      const n = ev.total_rounds || 0
      editRoundDives.value = Array.from({ length: n }, () => ({
        dive_id: null, height: null, _label: '', _meta: null,
      }))
    }
  } catch {
    editRoundDives.value = Array.from({ length: ev.total_rounds || 0 }, () => ({
      dive_id: null, height: null, _label: '', _meta: null,
    }))
  }
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
        height: editMixedHeight.value ? null : (editHeight.value || null),
        number_of_judges: parseInt(editJudges.value),
        total_rounds: editRoundDives.value.length || null,
        event_type: editType.value,
        // Send '' as null so the server clears the deadline; an
        // ISO string sets it. Server treats undefined (absent key)
        // as "leave untouched" — but we always send the field
        // because the user may have just blanked it.
        entries_close_at: editEntriesCloseAt.value || null,
        enforce_referee_signoff: editEnforceSignoff.value,
        is_mixed_height:         editMixedHeight.value,
        // Migration 038/039: round_rules + round_dives are
        // editable here too. round_dives = [] clears all
        // prescriptions; non-empty replaces them atomically.
        round_rules: buildEditRoundRulesPayload(),
        round_dives: editRoundDives.value.map((slot, i) => ({
          round_number: i + 1,
          dive_id: slot.dive_id || null,
          height: slot.height == null || slot.height === ''
            ? null
            : Number(slot.height),
        })),
      }),
    })
    showEditModal.value = false
    await loadEvents()
  } catch (err) {
    editErr.value = err.message
  }
}

async function deleteEvent(id) {
  const ev = events.value.find(e => e.id === id)
  if (!await confirmAction({
    title: `Delete "${ev?.name || 'this event'}"?`,
    body:  'Removes the event entirely — roster, dive lists, scores, and any record entries derived from it.',
    consequences: [
      'All dives, scores, and the audit log for this event are deleted',
      'Personal bests / club records keyed off this event are recomputed from remaining data',
      'This is not undoable',
    ],
    confirmLabel: 'Delete event',
    confirmKind:  'danger',
  })) return
  try {
    await auth.apiFetch(`/api/events/${id}`, { method: 'DELETE' })
    await loadEvents()
    showSuccess(`Deleted "${ev?.name || 'event'}"`)
  } catch (err) {
    showError(err.message)
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

// ---- Participating orgs (international event support) ------
async function openPartOrgsModal(ev) {
  partOrgsModalEvent.value = ev
  partOrgsModalOpen.value  = true
  partOrgsToAdd.value      = ''
  partOrgsBusy.value       = true
  try {
    const [invited, allOrgs] = await Promise.all([
      auth.apiFetch(`/api/events/${ev.id}/participating-orgs`),
      auth.apiFetch(`/api/orgs/active`),
    ])
    partOrgsInEvent.value = invited
    // Available = every active org except the host and any
    // already invited.
    const invitedSet = new Set(invited.map(o => o.org_id))
    partOrgsAvailable.value = (Array.isArray(allOrgs) ? allOrgs : [])
      .filter(o => o.id !== ev.org_id && !invitedSet.has(o.id))
  } catch (err) {
    showError(err.message)
    partOrgsInEvent.value = []
    partOrgsAvailable.value = []
  } finally {
    partOrgsBusy.value = false
  }
}

function closePartOrgsModal() {
  partOrgsModalOpen.value  = false
  partOrgsModalEvent.value = null
  partOrgsInEvent.value    = []
  partOrgsAvailable.value  = []
  partOrgsToAdd.value      = ''
}

// Patch the participating_orgs_count on a single event row in
// `events.value` so the 🌐 International (N) chip stays in sync
// after add/remove without a full loadEvents() refetch.
function bumpParticipatingCount(eventId, newCount) {
  const row = events.value.find(e => e.id === eventId)
  if (row) row.participating_orgs_count = newCount
}

async function addPartOrg() {
  if (!partOrgsToAdd.value || !partOrgsModalEvent.value) return
  const ev = partOrgsModalEvent.value
  partOrgsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${ev.id}/participating-orgs`, {
      method: 'POST',
      body: JSON.stringify({ org_id: partOrgsToAdd.value }),
    })
    partOrgsInEvent.value = await auth.apiFetch(`/api/events/${ev.id}/participating-orgs`)
    const invitedSet = new Set(partOrgsInEvent.value.map(o => o.org_id))
    partOrgsAvailable.value = partOrgsAvailable.value.filter(o => !invitedSet.has(o.id))
    partOrgsToAdd.value = ''
    // Patch the event row in-place so the 🌐 International (N)
    // chip count stays in lockstep with the modal. A full
    // loadEvents() round-trip would also work, but this is
    // cheap and doesn't blow away the rest of the events list.
    bumpParticipatingCount(ev.id, partOrgsInEvent.value.length)
    showSuccess('Federation invited to participate')
  } catch (err) {
    showError(err.message)
  } finally {
    partOrgsBusy.value = false
  }
}

// Visiting org self-withdraws from a foreign-hosted event. Used
// in the per-event overflow menu when the event's host org is
// not the caller's own. Different from removePartOrg above
// (which the HOST uses to evict a federation) — this is the
// guest's exit door.
async function selfWithdrawFromEvent(ev) {
  if (!await confirmAction({
    title: `Withdraw your federation from "${ev.name}"?`,
    body: 'Existing dive list entries from your divers stay intact — only NEW entries are blocked. The host federation will be notified.',
    consequences: [
      'Your divers already entered keep their entries',
      `${ev.org_name || 'The host'} sees a notification that you withdrew`,
      'You can re-join only if the host invites you again',
    ],
    confirmLabel: 'Withdraw',
    confirmKind: 'danger',
  })) return
  try {
    await auth.apiFetch(`/api/events/${ev.id}/participating-orgs/${auth.user.org_id}`, {
      method: 'DELETE',
    })
    showSuccess(`Withdrew from ${ev.name}`)
    // Refresh the events list so the withdrawn event no longer
    // shows up in the manager.
    await loadEvents()
  } catch (err) {
    showError(err.message)
  }
}

async function removePartOrg(org) {
  if (!await confirmAction({
    title: `Remove ${org.org_name} from this event?`,
    body:  `Divers from ${org.country_code || org.org_name} can no longer self-enter. Existing dive list rows from their divers stay intact.`,
    consequences: [
      'Their divers stay on the roster if already entered',
      'New entries from this federation will be rejected after removal',
    ],
    confirmLabel: 'Remove federation',
    confirmKind:  'danger',
  })) return
  const ev = partOrgsModalEvent.value
  partOrgsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${ev.id}/participating-orgs/${org.org_id}`, {
      method: 'DELETE',
    })
    partOrgsInEvent.value = partOrgsInEvent.value.filter(o => o.org_id !== org.org_id)
    // Make the org re-selectable in the dropdown.
    partOrgsAvailable.value = [
      ...partOrgsAvailable.value,
      { id: org.org_id, name: org.org_name, country_code: org.country_code },
    ].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    bumpParticipatingCount(ev.id, partOrgsInEvent.value.length)
    showSuccess(`Removed ${org.org_name}`)
  } catch (err) {
    showError(err.message)
  } finally {
    partOrgsBusy.value = false
  }
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
    showError(err.message)
  } finally {
    teamsBusy.value = false
  }
}

async function removeTeamFromEvent(team) {
  if (!await confirmAction({
    title: `Remove "${team.name}" from this event?`,
    body:  'Unlinks the team from the event roster.',
    consequences: [
      'Existing dive list rows lose their team attribution',
      'Per-dive scores and history stay intact — only the team grouping is removed',
    ],
    confirmLabel: 'Remove team',
    confirmKind:  'danger',
  })) return
  teamsBusy.value = true
  try {
    await auth.apiFetch(`/api/events/${teamsModalEvent.value.id}/teams/${team.id}`, {
      method: 'DELETE',
    })
    teamsInEvent.value = teamsInEvent.value.filter(t => t.id !== team.id)
    showSuccess(`Removed "${team.name}" from event`)
  } catch (err) {
    showError(err.message)
  } finally {
    teamsBusy.value = false
  }
}

// Per-event ⋯ overflow menu — Edit / Audit Log / Import
// Roster / Delete moved here so the row's primary affordance
// (status-aware: Open Control Room / View Results) is the
// dominant button rather than fighting four equal-weight
// siblings. Only one menu is open at a time, identified by
// the event id; null means closed.
const overflowOpenEventId = ref(null)
function toggleOverflow(id) {
  overflowOpenEventId.value = overflowOpenEventId.value === id ? null : id
}
function onOutsideClick(e) {
  if (!e.target.closest?.('.dropdown-host')) overflowOpenEventId.value = null
}

onMounted(async () => {
  await Promise.all([loadEvents(), loadMeets(), loadEventTemplates(), loadDiveDirectory()])
  // Capture-phase mousedown closes the overflow menu when the
  // user clicks anywhere outside its wrapper. Capture phase
  // matters so the row's own ⋯ trigger still fires its toggle
  // before this listener runs.
  window.addEventListener('mousedown', onOutsideClick, true)
})
onUnmounted(() => {
  window.removeEventListener('mousedown', onOutsideClick, true)
})
</script>

<template>
  <div class="page-header">
    <h1 style="font-size:32px;font-style:italic">Meet Manager</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">← Dashboard</RouterLink>
  </div>

  <div class="main">
    <!-- New Event modal trigger — the form itself is in a modal
         below to give the operator real screen real-estate for
         the dive-slot list. -->
    <div class="manager-toolbar">
      <button type="button" class="btn btn-primary"
              @click="showCreateModal = true">
        + New Event
      </button>
    </div>

    <!-- Create form (modal). The whole card is gated on
         showCreateModal so the inline page can use the full
         width for the events list. -->
    <div v-if="showCreateModal" class="modal-backdrop" @click.self="showCreateModal = false">
    <div class="modal modal-create-event" @click.stop>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:1rem;flex-wrap:wrap">
        <h2 style="font-size:22px;font-style:italic">New Event</h2>
        <div style="display:flex;gap:0.5rem">
          <button type="button"
                  class="btn btn-ghost btn-sm"
                  @click="saveTemplateOpen = !saveTemplateOpen">
            {{ saveTemplateOpen ? 'Cancel' : '＋ Save as template' }}
          </button>
          <button type="button" class="btn btn-ghost btn-sm" @click="showCreateModal = false">Cancel ✕</button>
        </div>
      </div>

      <!-- Template strip — apply a saved configuration with one
           click. Templates are per-org; saving upserts by name. -->
      <div v-if="eventTemplates.length || saveTemplateOpen" class="event-templates">
        <div v-if="eventTemplates.length" class="event-templates-list">
          <div v-for="t in eventTemplates" :key="t.id" class="event-template-row">
            <button type="button" class="event-template-apply" @click="applyEventTemplate(t)">
              <span class="event-template-name">{{ t.name }}</span>
              <span class="event-template-config">
                {{ t.config?.event_type || 'individual' }}{{ t.config?.height ? ' · ' + t.config.height : '' }}{{ t.config?.gender ? ' · ' + t.config.gender : '' }}{{ t.config?.age_group ? ' · ' + t.config.age_group : '' }}
              </span>
            </button>
            <button type="button" class="btn btn-ghost btn-sm event-template-del"
                    @click="deleteEventTemplate(t)" title="Delete template">✕</button>
          </div>
        </div>

        <div v-if="saveTemplateOpen" class="event-template-save">
          <input class="input"
                 type="text"
                 v-model="saveTemplateName"
                 placeholder='Template name (e.g. "FINA U16 Womens 3m")'
                 @keyup.enter="saveAsEventTemplate">
          <button type="button" class="btn btn-primary btn-sm"
                  :disabled="saveTemplateBusy"
                  @click="saveAsEventTemplate">
            {{ saveTemplateBusy ? 'Saving…' : 'Save' }}
          </button>
        </div>
        <div v-if="templateErr" class="msg msg-error" style="margin-top:0.5rem">{{ templateErr }}</div>
      </div>

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
          <select class="select" v-model="createHeight"
                  :disabled="createMixedHeight">
            <option value="">— Select Height —</option>
            <option value="0m">Poolside (0m)</option>
            <option value="1m">1m Springboard</option>
            <option value="3m">3m Springboard</option>
            <option value="5m">5m Platform</option>
            <option value="7.5m">7.5m Platform</option>
            <option value="10m">10m Platform</option>
          </select>
          <label class="checkbox-row">
            <input type="checkbox" v-model="createMixedHeight">
            Mixed-board event
            <button type="button" class="help-pill"
                    @click.prevent="showMixedHeightHelp = !showMixedHeightHelp"
                    title="What is this?">?</button>
          </label>
          <div v-if="showMixedHeightHelp" class="help-popover">
            Use this for events that span more than one board — e.g. an
            "Open Mixed" exhibition with 1m + 3m + 5m + 10m dives. The
            height field above is ignored and divers can pick any height
            on each of their dives.
          </div>
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
        <!-- Round dives (migration 039). Each row is one round in
             the event. Pinning a dive to a row makes it a
             "prescribed" dive — the diver must submit exactly that
             dive in that round. Leaving the dive blank lets the
             diver pick freely. The count of rows == total_rounds. -->
        <div class="field rd-editor">
          <label class="label" style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
            <span>Round dives</span>
            <span class="rd-total">{{ createRoundDives.length }} round{{ createRoundDives.length === 1 ? '' : 's' }}</span>
          </label>
          <p class="hint" v-if="!createRoundDives.length" style="margin:0 0 0.5rem">
            Click <strong>+ Add Dive</strong> for each round. Pin a specific
            dive (operator-prescribed), or leave it blank for the diver
            to pick. <strong>Quick add</strong> stamps several free rounds
            in one go.
          </p>

          <div v-for="(slot, idx) in createRoundDives" :key="idx" class="rd-row">
            <div class="rd-row-num">R{{ idx + 1 }}</div>
            <div class="rd-row-pick">
              <input v-if="divePickerOpenIdx !== idx || divePickerCtx !== 'create'"
                     class="input rd-pick-input"
                     :value="slot._label || (slot.dive_id ? '(loading…)' : '')"
                     :placeholder="slot.dive_id ? '' : 'Diver picks · click to pin a dive'"
                     readonly
                     @click="openDivePicker(idx, 'create')">
              <input v-else
                     class="input rd-pick-input"
                     v-model="divePickerQuery"
                     placeholder="Search dive code, position, or description…"
                     autofocus
                     @blur="onPickerBlur(idx, 'create')">

              <div v-if="divePickerOpenIdx === idx && divePickerCtx === 'create'"
                   class="rd-pick-popover">
                <div v-if="!divePickerResults.length" class="rd-pick-empty">
                  No dives match. Adjust the search or
                  <button type="button" class="rd-pick-create-link"
                          @mousedown.prevent="openCreateDiveModal('create', idx)">
                    add a new dive →
                  </button>
                </div>
                <div v-for="d in divePickerResults" :key="d.id"
                     class="rd-pick-result"
                     @mousedown.prevent="selectDiveForRow(d)">
                  <span class="rd-pick-code">{{ d.dive_code }}{{ d.position }}</span>
                  <span class="rd-pick-meta">{{ d.height }}m · DD {{ d.dd }}</span>
                  <span class="rd-pick-desc">{{ d.description }}</span>
                </div>
                <div v-if="divePickerResults.length" class="rd-pick-footer">
                  <button type="button" class="rd-pick-create-link"
                          @mousedown.prevent="openCreateDiveModal('create', idx)">
                    + Add a new dive…
                  </button>
                </div>
              </div>
            </div>

            <!-- Mixed-board events expose a per-slot height
                 selector: an operator can leave the dive free
                 but pin the round to a particular board. Hidden
                 when the event uses a single fixed height. -->
            <select v-if="createMixedHeight" class="select rd-row-height" v-model="slot.height">
              <option :value="null">— Any board —</option>
              <option value="0">0m</option>
              <option value="1">1m</option>
              <option value="3">3m</option>
              <option value="5">5m</option>
              <option value="7.5">7.5m</option>
              <option value="10">10m</option>
            </select>

            <button type="button" class="btn btn-ghost btn-sm rd-row-clear"
                    v-if="slot.dive_id"
                    @click="clearDiveForRow(idx, 'create')"
                    title="Unpin this dive (slot becomes free)">↺</button>
            <button type="button" class="btn btn-ghost btn-sm rd-row-remove"
                    @click="removeRoundDive(idx)" title="Remove this round">✕</button>
          </div>

          <div class="rd-actions">
            <button type="button" class="btn btn-primary btn-sm" @click="addRoundDive()">
              + Add Dive
            </button>
            <span class="rd-bulk">
              <span class="hint" style="margin:0">or quick add</span>
              <button type="button" class="btn btn-ghost btn-sm" @click="bulkAddRounds(5)">+ 5 rounds</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="bulkAddRounds(6)">+ 6 rounds</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="bulkAddRounds(8)">+ 8 rounds</button>
            </span>
          </div>
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

        <!-- Age group / division. Free text so any federation's
             naming works ("U14", "Open", "Masters 30-34", "Para
             Class 1"). Empty for un-bracketed events. -->
        <div class="field">
          <label class="label">Age Group / Division (optional)</label>
          <input class="input" v-model="createAgeGroup"
                 placeholder="e.g. U14, Open, Masters 30-34, Para">
        </div>

        <!-- Scheduled start. Powers the meet schedule view,
             notifications, and (later) calendar export. -->
        <div class="field">
          <label class="label">Scheduled Start (optional)</label>
          <input class="input" type="datetime-local" v-model="createScheduledAt">
          <p class="hint" v-if="createScheduledAt">
            Notifications will fire 1 hour before this time when a competitor's dive list is in.
          </p>
        </div>

        <!-- Entries-close deadline. When set, divers can't submit
             (or change) their dive list past this moment, even
             though the event is still 'Upcoming'. Blank = the
             event accepts entries up until status flips to 'Live'. -->
        <div class="field">
          <label class="label">Entries Close (optional)</label>
          <input class="input" type="datetime-local" v-model="createEntriesCloseAt">
          <p class="hint" v-if="createEntriesCloseAt">
            Divers can submit until this moment. After it passes, their portal hides the event.
          </p>
          <p class="hint" v-else>
            Leave blank to keep entries open until the event goes Live.
          </p>
        </div>

        <!-- Event format — three stages, in order:
             preliminary → semifinal → final. World Aquatics
             individual events use all three; synchro and team
             events typically skip the semi (or are standalone).
             The chain is operator-defined per event. -->
        <div class="field">
          <label class="label">Event Format</label>
          <select class="select" v-model="createFormat" @change="createParentEventId = ''">
            <option value="final">Final (standalone or terminal stage)</option>
            <option value="preliminary">Preliminary (feeds a semi or final)</option>
            <option value="semifinal">Semi-Final (top N from prelim → final)</option>
          </select>
          <p class="hint" v-if="createFormat === 'preliminary'">
            Build the prelim, run it, then create a Semi-Final or Final and use "Advance Top N" on this row to seed the next stage.
          </p>
          <p class="hint" v-else-if="createFormat === 'semifinal'">
            Pick the preliminary it feeds from below. After running the semi, "Advance Top N" pushes the leaders into the final.
          </p>
        </div>

        <!-- Parent picker. For a 'semifinal' the parent must be
             a 'preliminary'; for a 'final' it may be either.
             Listed candidates come from the user's org
             (cross-org linking is rejected). -->
        <div class="field"
             v-if="createFormat !== 'preliminary' && parentCandidates.length">
          <label class="label">
            {{ createFormat === 'semifinal' ? 'Feeds From Preliminary' : 'Feeds From (optional)' }}
          </label>
          <select class="select" v-model="createParentEventId">
            <option value="">
              — {{ createFormat === 'semifinal' ? 'Pick the preliminary' : 'Standalone final (no feeder)' }} —
            </option>
            <option v-for="ev in parentCandidates" :key="ev.id" :value="ev.id">
              {{ ev.name }} <template v-if="ev.event_format !== 'preliminary'">({{ ev.event_format }})</template>
            </option>
          </select>
        </div>

        <!-- Advance count — only relevant on a feeder stage
             (preliminary or semifinal). World Aquatics defaults:
             prelim → semi = 18, semi → final or prelim → final = 12. -->
        <div class="field" v-if="createFormat !== 'final'">
          <label class="label">Advance Top N to Next Stage</label>
          <input class="input" type="number" min="1" max="50" v-model="createAdvanceCount">
          <p class="hint">
            World Aquatics: prelim → semi = 18, semi → final = 12.
            Synchro/team meets often use smaller cuts.
          </p>
        </div>

        <!-- Per-round DD limit. Common in junior events: rounds
             1–N capped to a max DD; later rounds open. Both
             columns nullable; UI clears them in tandem.
             Hidden once the operator switches to the structured
             "Round structure" editor below — that supersedes
             this flat constraint. -->
        <div class="field" v-if="!createRoundSections.length">
          <label class="label">DD Limit (optional)</label>
          <div style="display:flex;gap:0.5rem">
            <input class="input" type="number" min="0" max="12" step="1"
                   v-model="createDdLimitRounds"
                   placeholder="Rounds (0 = no limit)" style="flex:1">
            <input class="input" type="number" min="0" max="5" step="0.1"
                   v-model="createDdLimitValue"
                   placeholder="Max DD (e.g. 1.8)" style="flex:1">
          </div>
          <p class="hint" v-if="parseInt(createDdLimitRounds) > 0 && createDdLimitValue">
            First {{ createDdLimitRounds }} round{{ parseInt(createDdLimitRounds) === 1 ? '' : 's' }} capped to DD ≤ {{ createDdLimitValue }}.
          </p>
        </div>

        <!-- Round structure (migration 038) — for events whose
             dive list breaks into sections with their own DD-sum
             cap and group-distinctness rule. Mirrors real bulletins
             like "4 dives @ 7.6 + 4 dives unlimited" (each section
             from different groups). When at least one section is
             defined, the flat "DD Limit" field above hides and this
             takes over. -->
        <div class="field rr-editor">
          <label class="label" style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
            <span>Round structure (optional)</span>
            <span v-if="createRoundSections.length" class="rr-total"
                  :class="{ 'rr-total-mismatch': sectionsRoundsTotal !== parseInt(createRounds) }">
              {{ sectionsRoundsTotal }} / {{ createRounds }} rounds
            </span>
          </label>
          <p class="hint" v-if="!createRoundSections.length" style="margin-bottom:0.5rem">
            For events that need per-section dive rules — e.g.
            "4 dives @ 7.6 from 4 different groups, then 4 dives
            unlimited from 4 groups". Add a section below;
            otherwise the flat DD Limit above applies.
          </p>

          <div v-for="(s, i) in createRoundSections" :key="i" class="rr-section">
            <div class="rr-section-row">
              <input class="input rr-label" type="text" v-model="s.label" placeholder="Section name (e.g. Voluntary)">
              <button type="button" class="btn btn-ghost btn-sm rr-remove"
                      @click="removeRoundSection(i)" title="Remove section">✕</button>
            </div>
            <div class="rr-section-row">
              <label class="rr-cell">
                <span class="rr-cell-label">Rounds</span>
                <input class="input" type="number" min="1" max="12" v-model="s.rounds">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">DD limit (sum)</span>
                <input class="input" type="number" min="0" max="50" step="0.1"
                       v-model="s.dd_limit"
                       placeholder="Unlimited">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">Min different groups</span>
                <input class="input" type="number" min="1" max="6"
                       v-model="s.min_distinct_groups"
                       placeholder="—">
              </label>
            </div>
            <p class="hint" style="margin-top:0.4rem; margin-bottom:0">
              <span v-if="s.min_distinct_groups">
                {{ s.rounds || '?' }} dive{{ parseInt(s.rounds) === 1 ? '' : 's' }} drawn from at least
                <strong>{{ s.min_distinct_groups }}</strong> different group{{ parseInt(s.min_distinct_groups) === 1 ? '' : 's' }}
                (forward / back / reverse / inward / twist / armstand).
              </span>
              <span v-else style="opacity:0.65">
                Leave "Min different groups" blank for no group constraint.
              </span>
            </p>
          </div>

          <div class="rr-actions">
            <button type="button" class="btn btn-ghost btn-sm" @click="addRoundSection()">
              + Add section
            </button>
          </div>
          <p class="hint hint-warn"
             v-if="createRoundSections.length && sectionsRoundsTotal !== parseInt(createRounds)">
            Section round counts ({{ sectionsRoundsTotal }}) don't match total_rounds ({{ createRounds }}). Adjust the rounds-per-section above or change Total Rounds.
          </p>
        </div>

        <div class="field">
          <label class="checkbox-row">
            <input type="checkbox" v-model="createEnforceSignoff">
            Enforce referee sign-off
            <button type="button" class="help-pill"
                    @click.prevent="showSignoffHelp = !showSignoffHelp"
                    title="What is this?">?</button>
          </label>
          <div v-if="showSignoffHelp" class="help-popover">
            <strong>What this does</strong>
            <p>
              Locks the pre-meet workflow's referee sign-off step so the
              actual referee has to approve the dive order — either by
              tapping the push notification on their device, by entering
              their username + password on the meet controller's screen,
              or by typing a 6-digit handoff code on their own device.
            </p>
            <strong>What changes</strong>
            <p>
              The "Manager attests on referee's behalf" tab in the sign-off
              modal disappears, and the underlying API refuses any soft
              attest. The referee's user-id is what gets stamped on the
              event's audit trail.
            </p>
            <strong>When to use it</strong>
            <p>
              Sanctioned meets, anything with formal results that need
              proper attribution. For training / club nights, leave it off
              and the meet controller can sign off after a verbal nod.
            </p>
          </div>
        </div>

        <div v-if="formErr" class="msg msg-error">{{ formErr }}</div>
        <button type="submit" class="btn btn-primary-lg" style="margin-top:0.25rem">Create Event</button>
      </form>
    </div>
    </div>
    <!-- /modal-create-event -->

    <!-- Meet management — separate inline card. Operators rarely
         need to look at meets while creating an event, so it lives
         here as its own pane rather than inside the event-creation
         modal. -->
    <div class="card">
      <h2 style="font-size:20px;font-style:italic;margin:0 0 0.75rem">Meets</h2>
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
      <h2 style="font-size:20px;font-style:italic;margin-bottom:1rem">
        {{ auth.user?.is_system_admin ? 'All Events' : 'Your Events' }}
        <span v-if="auth.user?.is_system_admin && events.length" class="events-subcount">
          · {{ events.length }} across {{ uniqueOrgCount }} org{{ uniqueOrgCount === 1 ? '' : 's' }}
        </span>
      </h2>
      <!-- Org filter — only useful for sysadmin who sees every
           org's events. Default 'all' shows the full list. -->
      <div v-if="auth.user?.is_system_admin && uniqueOrgs.length > 1" class="org-filter">
        <label class="label">Filter by org</label>
        <select class="select" v-model="orgFilter">
          <option value="">All organisations ({{ events.length }})</option>
          <option v-for="o in uniqueOrgs" :key="o.id" :value="o.id">
            {{ o.name }}{{ o.country_code ? ` (${o.country_code})` : '' }} ({{ o.count }})
          </option>
        </select>
      </div>

      <!-- Search + status filter chips. Hidden when there are
           fewer than 4 events — at that scale the list is
           already easy to scan and the controls are noise. -->
      <div v-if="events.length >= 4" class="events-toolbar">
        <input
          class="input events-search"
          type="search"
          v-model="eventSearch"
          placeholder="Search events…"
          aria-label="Search events"
        >
        <div class="events-status-chips">
          <button
            v-for="chip in STATUS_CHIPS"
            :key="chip.label"
            type="button"
            :class="['status-chip', { active: eventStatusFilter === chip.value }]"
            @click="eventStatusFilter = chip.value"
            :title="`Show ${chip.label.toLowerCase()} events`"
          >
            {{ chip.label }}
            <span class="status-chip-count">{{ statusChipCount(chip.value) }}</span>
          </button>
        </div>
      </div>

      <div class="events-list">
        <!-- Empty state — first visit shows a richer card with a
             pointer at the New Event form on the left; an
             active filter shows a smaller "no matches" line so
             the operator clears the filter without confusion. -->
        <div v-if="!filteredManagerEvents.length && !events.length" class="empty-state-card">
          <div class="empty-state-icon">📅</div>
          <div class="empty-state-title">No events yet</div>
          <div class="empty-state-body">
            Events are the heart of a meet — they hold the judges, the rounds,
            the dive lists, and the scoring. Build your first one using the
            <strong>New Event</strong> form on the left.
          </div>
        </div>
        <div v-else-if="!filteredManagerEvents.length" class="empty">
          <span>No events match the current filters.</span>
          <button
            v-if="eventSearch || eventStatusFilter || orgFilter"
            type="button"
            class="link-btn"
            @click="eventSearch = ''; eventStatusFilter = null; orgFilter = ''"
          >Clear filters</button>
        </div>
        <div v-for="ev in filteredManagerEvents" :key="ev.id" class="event-item">
          <div style="flex:1;min-width:0">
            <div class="event-name">
              <StatusPill :status="ev.status" size="sm" />
              <span>{{ ev.name }}</span>
            </div>
            <div class="event-meta">
              <!-- Org badge — visible to sysadmin so they know
                   which federation each event belongs to. -->
              <span v-if="auth.user?.is_system_admin && ev.org_name" class="org-badge">
                {{ ev.org_name }}<span v-if="ev.country_code" class="org-badge-ctry">{{ ev.country_code }}</span>
              </span>
              <span v-if="ev.event_type === 'synchro_pair'" class="event-type-pill">Synchro</span>
              <span v-else-if="ev.event_type === 'team'" class="event-type-pill team">Team</span>
              <!-- 🌐 International chip: visible when one or more
                   other federations are on the participating list.
                   Click jumps straight into the Federations modal. -->
              <button
                v-if="ev.participating_orgs_count > 0"
                type="button"
                class="event-type-pill intl-pill"
                @click.stop="openPartOrgsModal(ev)"
                :title="`${ev.participating_orgs_count} federation${ev.participating_orgs_count === 1 ? '' : 's'} invited — click to manage`"
              >🌐 International ({{ ev.participating_orgs_count }})</button>
              <!-- Format badges — distinguish prelim/semi/final
                   at a glance so an operator linking events can
                   find the right pair. -->
              <span v-if="ev.event_format === 'preliminary'" class="event-type-pill prelim">Prelim</span>
              <span v-else-if="ev.event_format === 'semifinal'" class="event-type-pill semi-pill">Semi-Final</span>
              <span v-else-if="ev.parent_event_id" class="event-type-pill final-pill">Final</span>
              <span v-if="ev.age_group" class="event-type-pill age">{{ ev.age_group }}</span>
              <span>{{ ev.gender }}</span><span>·</span>
              <span>{{ ev.number_of_judges }} Judges</span><span>·</span>
              <span>{{ ev.total_rounds }} Rounds</span>
              <template v-if="ev.height">
                <span>·</span><span>{{ HEIGHT_LABELS[ev.height] || ev.height }}</span>
              </template>
              <template v-if="ev.scheduled_at">
                <span>·</span><span>{{ new Date(ev.scheduled_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}</span>
              </template>
              <template v-if="ev.entries_close_at">
                <span>·</span>
                <span :title="`Entries close at ${new Date(ev.entries_close_at).toLocaleString()}`"
                      :style="{ color: new Date(ev.entries_close_at) <= new Date() ? 'var(--text-3)' : 'var(--cyan)' }">
                  {{ new Date(ev.entries_close_at) <= new Date() ? 'entries closed' : 'entries close ' + new Date(ev.entries_close_at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }}
                </span>
              </template>
            </div>
          </div>
          <!-- Actions — restructured into:
                 [optional secondaries] [primary action] [⋯]
               so the operator sees ONE dominant call-to-action
               per event. Primary is status-aware:
                 Upcoming  → "Open Control Room →"  (drive pre-meet workflow)
                 Live      → "🔴 LIVE — Open"        (jump back into the meet)
                 Completed → "View Results"          (ghost; recap is the action)
               Edit / Audit Log / Import Roster / Delete demote
               into the ⋯ overflow menu so they don't compete
               with the primary affordance. -->
          <div class="actions">
            <!-- Optional context-specific secondaries — only
                 surface when relevant to this event. -->
            <button v-if="ev.event_type === 'team'"
                    class="btn btn-ghost btn-sm"
                    @click="openTeamsModal(ev)">Teams</button>
            <button v-if="(ev.event_format === 'preliminary' || ev.event_format === 'semifinal') && eventHasNextStage(ev)"
                    class="btn btn-ghost btn-sm advance-btn"
                    @click="advanceToNextStage(ev)"
                    title="Pull the top-N divers from this stage into the next stage's roster">
              Advance Top {{ ev.advance_count || 12 }} →
            </button>
            <!-- Status-aware primary action. Each path deep-
                 links into the screen the operator's most
                 likely to want next. -->
            <RouterLink v-if="ev.status === 'Upcoming'"
                        :to="`/control?event=${ev.id}`"
                        class="btn btn-primary btn-sm"
                        title="Open the Control Room with this event preselected — drive check-in, randomise, sign-off, and start the meet">
              Open Control Room →
            </RouterLink>
            <RouterLink v-else-if="ev.status === 'Live'"
                        :to="`/control?event=${ev.id}`"
                        class="btn btn-live btn-sm"
                        title="Live — drop back into the Control Room">
              🔴 LIVE — Open
            </RouterLink>
            <RouterLink v-else
                        :to="`/scoreboard/${ev.id}`"
                        class="btn btn-ghost btn-sm"
                        title="View the recap — podium, full standings, dive-by-dive">
              View Results
            </RouterLink>
            <!-- ⋯ overflow — secondary maintenance actions the
                 operator only touches occasionally. Edit /
                 Audit Log / Import Roster / Delete all live
                 here so the row reads as a single primary
                 action at rest. -->
            <div class="dropdown-host">
              <button class="btn btn-ghost btn-sm btn-icon"
                      :aria-expanded="overflowOpenEventId === ev.id"
                      title="More actions"
                      @click.stop="toggleOverflow(ev.id)">⋯</button>
              <div v-if="overflowOpenEventId === ev.id" class="event-overflow-menu">
                <!-- Host-side actions (event belongs to caller's
                     org or sysadmin). Visiting orgs see only the
                     "Withdraw participation" item since they
                     can't edit, delete, or import roster on a
                     foreign-hosted event. -->
                <template v-if="auth.user?.is_system_admin || ev.org_id === auth.user?.org_id">
                  <button class="dropdown-item"
                          @click="openEdit(ev); overflowOpenEventId = null">
                    Edit event
                  </button>
                  <RouterLink :to="`/events/${ev.id}/audit`"
                              class="dropdown-item"
                              @click="overflowOpenEventId = null">
                    Audit log
                  </RouterLink>
                  <button class="dropdown-item"
                          @click="openRosterImport(ev); overflowOpenEventId = null">
                    Import roster…
                  </button>
                  <button class="dropdown-item"
                          @click="openPartOrgsModal(ev); overflowOpenEventId = null"
                          title="Invite other federations' divers to enter this event">
                    Federations…
                  </button>
                  <button class="dropdown-item dropdown-item-danger"
                          @click="deleteEvent(ev.id); overflowOpenEventId = null">
                    Delete event
                  </button>
                </template>
                <template v-else>
                  <!-- Visiting federation overflow — single
                       destructive action: withdraw our
                       participation. The event belongs to a
                       different host so we can't edit or delete
                       it. -->
                  <div class="dropdown-item-static">
                    Hosted by {{ ev.org_name || 'another federation' }}
                  </div>
                  <button class="dropdown-item dropdown-item-danger"
                          @click="selfWithdrawFromEvent(ev); overflowOpenEventId = null"
                          title="Stop your divers entering this event. Existing entries stay intact.">
                    Withdraw participation
                  </button>
                </template>
              </div>
            </div>
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
          <select class="select" v-model="editHeight" :disabled="editMixedHeight">
            <option value="">— Select Height —</option>
            <option value="0m">Poolside (0m)</option>
            <option value="1m">1m Springboard</option>
            <option value="3m">3m Springboard</option>
            <option value="5m">5m Platform</option>
            <option value="7.5m">7.5m Platform</option>
            <option value="10m">10m Platform</option>
          </select>
          <label class="checkbox-row">
            <input type="checkbox" v-model="editMixedHeight">
            Mixed-board event
          </label>
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
          <label class="checkbox-row">
            <input type="checkbox" v-model="editEnforceSignoff">
            Enforce referee sign-off
          </label>
          <p class="hint">
            When on, only the referee can sign off — via push, code,
            or credential entry.
          </p>
        </div>
        <!-- Round dives — same editor as the New Event modal,
             pre-populated from /api/events/:id/round-dives so the
             operator can re-pin or unpin dives, add/remove rounds,
             or override per-slot board heights for mixed events. -->
        <div class="field rd-editor">
          <label class="label" style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
            <span>Round dives</span>
            <span class="rd-total">{{ editRoundDives.length }} round{{ editRoundDives.length === 1 ? '' : 's' }}</span>
          </label>

          <div v-for="(slot, idx) in editRoundDives" :key="idx" class="rd-row">
            <div class="rd-row-num">R{{ idx + 1 }}</div>
            <div class="rd-row-pick">
              <input v-if="divePickerOpenIdx !== idx || divePickerCtx !== 'edit'"
                     class="input rd-pick-input"
                     :value="slot._label || (slot.dive_id ? '(loading…)' : '')"
                     :placeholder="slot.dive_id ? '' : 'Diver picks · click to pin a dive'"
                     readonly
                     @click="openDivePicker(idx, 'edit')">
              <input v-else
                     class="input rd-pick-input"
                     v-model="divePickerQuery"
                     placeholder="Search dive code, position, or description…"
                     autofocus
                     @blur="onPickerBlur(idx, 'edit')">

              <div v-if="divePickerOpenIdx === idx && divePickerCtx === 'edit'"
                   class="rd-pick-popover">
                <div v-if="!divePickerResults.length" class="rd-pick-empty">
                  No dives match. Adjust the search or
                  <button type="button" class="rd-pick-create-link"
                          @mousedown.prevent="openCreateDiveModal('edit', idx)">
                    add a new dive →
                  </button>
                </div>
                <div v-for="d in divePickerResults" :key="d.id"
                     class="rd-pick-result"
                     @mousedown.prevent="selectDiveForRow(d)">
                  <span class="rd-pick-code">{{ d.dive_code }}{{ d.position }}</span>
                  <span class="rd-pick-meta">{{ d.height }}m · DD {{ d.dd }}</span>
                  <span class="rd-pick-desc">{{ d.description }}</span>
                </div>
                <div v-if="divePickerResults.length" class="rd-pick-footer">
                  <button type="button" class="rd-pick-create-link"
                          @mousedown.prevent="openCreateDiveModal('edit', idx)">
                    + Add a new dive…
                  </button>
                </div>
              </div>
            </div>

            <select v-if="editMixedHeight" class="select rd-row-height" v-model="slot.height">
              <option :value="null">— Any board —</option>
              <option value="0">0m</option>
              <option value="1">1m</option>
              <option value="3">3m</option>
              <option value="5">5m</option>
              <option value="7.5">7.5m</option>
              <option value="10">10m</option>
            </select>

            <button type="button" class="btn btn-ghost btn-sm rd-row-clear"
                    v-if="slot.dive_id"
                    @click="clearDiveForRow(idx, 'edit')"
                    title="Unpin (slot becomes free)">↺</button>
            <button type="button" class="btn btn-ghost btn-sm rd-row-remove"
                    @click="removeEditRoundDive(idx)" title="Remove this round">✕</button>
          </div>

          <div class="rd-actions">
            <button type="button" class="btn btn-primary btn-sm" @click="addEditRoundDive()">
              + Add Dive
            </button>
            <span class="rd-bulk">
              <span class="hint" style="margin:0">or quick add</span>
              <button type="button" class="btn btn-ghost btn-sm" @click="bulkAddEditRounds(5)">+ 5 rounds</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="bulkAddEditRounds(6)">+ 6 rounds</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="bulkAddEditRounds(8)">+ 8 rounds</button>
            </span>
          </div>
        </div>

        <!-- Round structure (sections) — was missing from the
             Edit modal entirely; added in migration 039 alongside
             the prescribed-dives editor so an operator can change
             DD limits / min-distinct-groups after the fact. -->
        <div class="field rr-editor">
          <label class="label" style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem">
            <span>Round structure (optional)</span>
            <span v-if="editRoundSections.length" class="rr-total"
                  :class="{ 'rr-total-mismatch': editSectionsRoundsTotal !== editRoundDives.length }">
              {{ editSectionsRoundsTotal }} / {{ editRoundDives.length }} rounds
            </span>
          </label>
          <p class="hint" v-if="!editRoundSections.length" style="margin-bottom:0.5rem">
            Add a section to split the rounds into per-section DD
            sums or "different groups" rules.
          </p>
          <div v-for="(s, i) in editRoundSections" :key="i" class="rr-section">
            <div class="rr-section-row">
              <input class="input rr-label" type="text" v-model="s.label" placeholder="Section name (e.g. Voluntary)">
              <button type="button" class="btn btn-ghost btn-sm rr-remove"
                      @click="removeEditRoundSection(i)" title="Remove section">✕</button>
            </div>
            <div class="rr-section-row">
              <label class="rr-cell">
                <span class="rr-cell-label">Rounds</span>
                <input class="input" type="number" min="1" max="12" v-model="s.rounds">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">DD limit (sum)</span>
                <input class="input" type="number" min="0" max="50" step="0.1"
                       v-model="s.dd_limit" placeholder="Unlimited">
              </label>
              <label class="rr-cell">
                <span class="rr-cell-label">Min different groups</span>
                <input class="input" type="number" min="1" max="6"
                       v-model="s.min_distinct_groups" placeholder="—">
              </label>
            </div>
          </div>
          <div class="rr-actions">
            <button type="button" class="btn btn-ghost btn-sm" @click="addEditRoundSection()">
              + Add section
            </button>
          </div>
          <p class="hint hint-warn"
             v-if="editRoundSections.length && editSectionsRoundsTotal !== editRoundDives.length">
            Section round counts ({{ editSectionsRoundsTotal }}) don't match the
            event's total rounds ({{ editRoundDives.length }}).
          </p>
        </div>

        <!-- Entries-close deadline. Blank to clear, otherwise
             divers can't submit past this moment. -->
        <div class="field">
          <label class="label">Entries Close (optional)</label>
          <input class="input" type="datetime-local" v-model="editEntriesCloseAt">
          <p class="hint" v-if="editEntriesCloseAt">
            Divers can submit until this moment. Clear the field to re-open entries.
          </p>
          <p class="hint" v-else>
            No deadline set — entries close when the event goes Live.
          </p>
        </div>
        <div v-if="editErr" class="msg msg-error">{{ editErr }}</div>
        <button type="submit" class="btn btn-primary-lg">Save Changes</button>
      </form>
    </div>
  </div>

  <!-- Create Dive sub-modal — opened from a round-dive picker
       when the operator types a search that doesn't match any
       existing directory entry. Mirrors the create form on
       /dive-directory but inline so the operator never leaves
       event creation. -->
  <div v-if="showCreateDiveModal" class="modal-backdrop"
       @click.self="closeCreateDiveModal" style="z-index:1100">
    <div class="modal modal-create-dive" @click.stop style="max-width:480px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1.25rem">
      <h2 style="font-size:20px;font-style:italic">Add a new dive</h2>
      <button class="btn btn-ghost btn-sm" @click="closeCreateDiveModal">Cancel ✕</button>
    </div>
    <p class="hint" style="margin-bottom:1rem">
      The dive will be added to your federation's custom directory and
      become available to every event. Use the canonical FINA dive
      code (e.g. <code>5132</code>) for cross-federation matching.
    </p>
    <form @submit.prevent="submitCreateDive" class="form-stack">
      <div class="field" style="display:flex;gap:0.5rem">
        <div style="flex:1">
          <label class="label">Dive Code</label>
          <input class="input" v-model="newDiveCode" placeholder="e.g. 5132" maxlength="6" required>
        </div>
        <div style="flex:1">
          <label class="label">Position</label>
          <select class="select" v-model="newDivePosition">
            <option value="A">A — Straight</option>
            <option value="B">B — Pike</option>
            <option value="C">C — Tuck</option>
            <option value="D">D — Free</option>
          </select>
        </div>
      </div>
      <div class="field" style="display:flex;gap:0.5rem">
        <div style="flex:1">
          <label class="label">Height</label>
          <select class="select" v-model="newDiveHeight">
            <option value="0m">0m — Poolside</option>
            <option value="1m">1m</option>
            <option value="3m">3m</option>
            <option value="5m">5m</option>
            <option value="7.5m">7.5m</option>
            <option value="10m">10m</option>
          </select>
        </div>
        <div style="flex:1">
          <label class="label">Degree of Difficulty (DD)</label>
          <input class="input" type="number" min="0.1" max="9.9" step="0.1"
                 v-model="newDiveDd" placeholder="e.g. 2.4" required>
        </div>
      </div>
      <div class="field">
        <label class="label">Description (optional)</label>
        <input class="input" v-model="newDiveDescription"
               placeholder="e.g. Forward 1½ Som with 1 Twist" maxlength="280">
      </div>
      <div v-if="newDiveErr" class="msg msg-error">{{ newDiveErr }}</div>
      <button type="submit" class="btn btn-primary" :disabled="newDiveBusy">
        {{ newDiveBusy ? 'Saving…' : 'Add dive + use it for this round' }}
      </button>
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

  <!-- Participating-orgs modal — invite OTHER federations'
       divers to enter this event. Empty list = domestic-only.
       Endpoints in routes/events.js (migration 036). -->
  <div v-if="partOrgsModalOpen" class="modal-backdrop" @click="closePartOrgsModal"></div>
  <div v-if="partOrgsModalOpen" class="modal teams-modal" @click.stop>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
      <div>
        <div class="teams-section-label">Participating Federations</div>
        <h2 style="font-size:20px;font-style:italic;line-height:1.1">
          {{ partOrgsModalEvent?.name }}
        </h2>
      </div>
      <button class="btn btn-ghost btn-sm" @click="closePartOrgsModal">Close ✕</button>
    </div>
    <p class="hint" style="margin-bottom:1rem;line-height:1.5">
      Listing a federation here lets its divers self-enter this event without a shadow account. Their results count toward <strong>their home federation's</strong> records, not yours. The host federation ({{ partOrgsModalEvent?.org_name || 'this org' }}) is implicit — don't add it.
    </p>

    <div class="teams-section-label">Currently participating ({{ partOrgsInEvent.length }})</div>
    <ul v-if="partOrgsInEvent.length" class="enrolled-list">
      <li v-for="o in partOrgsInEvent" :key="o.org_id" class="enrolled-row">
        <span class="enrolled-name">
          {{ o.org_name }}
          <span v-if="o.country_code" class="enrolled-code">{{ o.country_code }}</span>
        </span>
        <button class="btn btn-danger btn-sm" :disabled="partOrgsBusy"
                @click="removePartOrg(o)">Remove</button>
      </li>
    </ul>
    <div v-else class="enrolled-empty">
      Domestic-only event — only {{ partOrgsModalEvent?.org_name || 'host' }} divers can enter.
    </div>

    <div class="teams-section-label" style="margin-top:1.25rem">Invite a federation</div>
    <div class="add-team-row">
      <select class="select" v-model="partOrgsToAdd" :disabled="partOrgsBusy">
        <option value="">— Select a federation —</option>
        <option v-for="o in partOrgsAvailable" :key="o.id" :value="o.id">
          {{ o.name }}{{ o.country_code ? ` (${o.country_code})` : '' }}
        </option>
      </select>
      <button class="btn btn-primary btn-sm"
              :disabled="!partOrgsToAdd || partOrgsBusy"
              @click="addPartOrg">Invite</button>
    </div>
    <p v-if="!partOrgsAvailable.length && !partOrgsBusy" class="hint-line">
      Every active federation is already participating, or there are no other federations on this server.
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
/* Single-column layout — the New Event form lives in a modal
   now (migration 039). Inline page hosts the events list + meets
   list stacked vertically. */
.main { max-width:1100px;margin:0 auto;padding:2rem;display:grid;grid-template-columns:1fr;gap:2rem;align-items:start; }

.manager-toolbar { display:flex; justify-content:flex-end; gap:0.5rem; }

.modal-create-event { max-width:720px; max-height:calc(100vh - 4rem); overflow-y:auto; }
.modal-create-dive  { max-width:480px; }

/* Round-dives editor (migration 039) — one row per round, with a
   click-to-search dive picker, optional per-slot height for
   mixed-board events, and quick-clear / remove buttons. */
.rd-editor { display:flex; flex-direction:column; gap:0.5rem; }
.rd-total {
  font-size:11px; letter-spacing:0.08em; text-transform:uppercase;
  color:var(--text-2);
  background:rgba(0, 224, 255, 0.08); padding:0.2rem 0.6rem; border-radius:999px;
}
.rd-row {
  display:grid;
  grid-template-columns: 38px 1fr auto auto auto;
  align-items:center; gap:0.5rem;
  padding:0.4rem; border:1px solid var(--border); border-radius:var(--radius);
  background:rgba(255,255,255,0.02);
}
.rd-row-num {
  font-family:var(--font-mono); font-weight:bold; color:var(--cyan);
  text-align:center;
  background:rgba(0,224,255,0.06); border-radius:6px; padding:0.4rem 0;
}
.rd-row-pick { position:relative; min-width:0; }
.rd-pick-input { font-size:13px; padding:0.5rem 0.75rem; }
.rd-pick-popover {
  position:absolute; top:calc(100% + 4px); left:0; right:0; z-index:10;
  background:var(--bg-2); border:1px solid var(--border); border-radius:var(--radius);
  max-height:280px; overflow-y:auto;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
}
.rd-pick-empty {
  padding:0.75rem; font-size:13px; color:var(--text-2);
  display:flex; flex-direction:column; gap:0.5rem;
}
.rd-pick-result {
  padding:0.5rem 0.75rem; font-size:13px;
  border-top:1px solid var(--border); cursor:pointer;
  display:grid; grid-template-columns: 60px 90px 1fr; gap:0.5rem; align-items:center;
}
.rd-pick-result:first-child { border-top:none; }
.rd-pick-result:hover { background:rgba(0, 224, 255, 0.06); }
.rd-pick-code { font-family:var(--font-mono); font-weight:bold; color:var(--cyan); }
.rd-pick-meta { font-family:var(--font-mono); color:var(--text-2); font-size:12px; }
.rd-pick-desc { color:var(--text-2); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.rd-pick-footer {
  border-top:1px solid var(--border); padding:0.4rem 0.75rem;
}
.rd-pick-create-link {
  background:none; border:none; padding:0;
  color:var(--cyan); font-size:12px; cursor:pointer; font-family:var(--font-mono);
}
.rd-pick-create-link:hover { text-decoration:underline; }
.rd-row-height { max-width:120px; font-size:13px; padding:0.5rem 0.75rem; }
.rd-row-clear, .rd-row-remove { padding:0.3rem 0.55rem; }
.rd-actions {
  display:flex; align-items:center; gap:0.75rem; flex-wrap:wrap; margin-top:0.4rem;
}
.rd-bulk { display:flex; align-items:center; gap:0.4rem; flex-wrap:wrap; }
.form-stack{display:flex;flex-direction:column;gap:1rem;}
.event-item{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1.25rem;background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius);transition:border-color 0.2s;animation:fadeUp 0.25s ease;}
.event-item:hover{border-color:var(--border-2);}
.event-name{font-family:var(--font-display);font-size:18px;font-weight:700;color:var(--text);display:flex;align-items:center;gap:0.6rem;flex-wrap:wrap;}
.event-meta{font-size:11px;color:var(--text-3);margin-top:0.25rem;display:flex;gap:0.75rem;flex-wrap:wrap;align-items:center;}
.org-badge {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: #c4b5fd;
  background: rgba(139,92,246,0.10); border: 1px solid rgba(139,92,246,0.4);
  border-radius: 3px; padding: 0.15rem 0.5rem;
}
.org-badge-ctry {
  font-family: var(--font-mono); font-size: 9px; font-weight: 700;
  color: var(--text-3); margin-left: 0.4rem;
}
.events-subcount {
  font-family: var(--font-mono); font-size: 12px; font-weight: 400;
  color: var(--text-3); font-style: normal;
}
.org-filter {
  display: flex; align-items: center; gap: 0.6rem;
  margin-bottom: 0.75rem;
}
.org-filter .label { margin: 0; flex-shrink: 0; }
.org-filter .select { max-width: 320px; }

/* Event template strip — saved form configurations the manager
   re-applies with one click. Sits above the form fields. */
.event-templates {
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 0.625rem 0.75rem;
  margin-bottom: 1rem;
}
.event-templates-list { display: flex; flex-direction: column; gap: 0.35rem; }
.event-template-row {
  display: flex; align-items: center; gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.event-template-apply {
  flex: 1; min-width: 0; text-align: left;
  background: transparent; border: none; padding: 0; cursor: pointer;
  display: flex; flex-direction: column; gap: 0.1rem;
}
.event-template-name {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  color: var(--text);
}
.event-template-apply:hover .event-template-name { color: var(--cyan); }
.event-template-config {
  font-family: var(--font-mono); font-size: 10.5px; color: var(--text-3);
}
.event-template-del { padding: 0.2rem 0.5rem; min-width: auto; }
.event-template-del:hover { color: var(--red); border-color: var(--red); }
.event-template-save {
  display: flex; gap: 0.5rem; margin-top: 0.5rem;
}
.event-template-save .input { flex: 1; font-size: 12px; padding: 0.4rem 0.6rem; }

/* Advance-to-final action — green to suggest "promote".
   Visible only on preliminary rows whose final exists. */
.advance-btn {
  color: var(--green) !important;
  border-color: rgba(16,185,129,0.4) !important;
  background: var(--green-dim) !important;
}
.advance-btn:hover {
  background: var(--green) !important;
  color: var(--bg) !important;
}
.actions{display:flex;gap:0.5rem;flex-shrink:0;align-items:center;}

/* "🔴 LIVE — Open" — Live primary action. Same dimensions as
   the other btn-sm pills, but red-tinted so the operator can
   spot a running event at a glance from the Meet Manager
   list. The pulse is subtle (opacity only — no movement) so
   it doesn't compete with the audience-facing scoreboard's
   own LIVE badge. */
.btn-live {
  background: rgba(239, 68, 68, 0.16);
  color: var(--red);
  border: 1px solid rgba(239, 68, 68, 0.45);
  font-family: var(--font-display); font-weight: 700;
  letter-spacing: 0.06em; text-transform: uppercase;
  padding: 0.45rem 0.95rem; border-radius: var(--radius-sm);
  text-decoration: none;
  animation: pulse-live 2.4s ease-in-out infinite;
}
.btn-live:hover {
  background: rgba(239, 68, 68, 0.26);
  border-color: var(--red);
}
@keyframes pulse-live {
  0%, 100% { opacity: 0.95; }
  50%      { opacity: 0.7; }
}

/* ⋯ overflow menu on the event row. Same visual language as
   the dropdown menus in the Control Room (header overflow,
   Adjust ▾, Auto-next ▾) — small popover anchored under the
   trigger, items as full-width buttons with hover tint. The
   "delete" item gets the red:hover treatment so a destructive
   action is colour-coded but doesn't dominate the list. */
.btn-icon {
  font-weight: 700; font-size: 16px; line-height: 1;
  padding: 0.4rem 0.7rem;
}
.dropdown-host { position: relative; }
.event-overflow-menu {
  position: absolute; z-index: 50;
  top: calc(100% + 0.4rem); right: 0;
  min-width: 200px;
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
  padding: 0.3rem;
  display: flex; flex-direction: column;
  font-family: var(--font-display); font-size: 12px;
}
.event-overflow-menu .dropdown-item {
  background: transparent; border: 0; cursor: pointer;
  padding: 0.55rem 0.7rem; border-radius: 4px;
  font-family: inherit; font-size: 12px; font-weight: 600;
  letter-spacing: 0.04em; color: var(--text-2);
  text-align: left; text-decoration: none;
  transition: background 0.12s, color 0.12s;
}
.event-overflow-menu .dropdown-item:hover {
  background: var(--bg-3); color: var(--text);
}
.event-overflow-menu .dropdown-item-danger:hover {
  background: rgba(239, 68, 68, 0.12); color: var(--red);
}
/* Static label inside the overflow menu — used for the "Hosted by
   X" hint a visiting federation sees. Not interactive. */
.event-overflow-menu .dropdown-item-static {
  padding: 0.55rem 0.7rem;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-3);
  border-bottom: 1px solid var(--border);
  margin-bottom: 0.25rem;
}
.events-list{display:flex;flex-direction:column;gap:0.75rem;}
.empty{
  color:var(--text-3);font-size:12px;text-align:center;padding:2rem;
  display:flex;flex-direction:column;align-items:center;gap:0.6rem;
}
.link-btn {
  background: transparent; border: 0;
  font-family: var(--font-mono); font-size: 11px;
  color: var(--cyan); cursor: pointer;
  padding: 0.3rem 0.5rem; border-radius: var(--radius-sm);
  text-decoration: underline; text-underline-offset: 3px;
  transition: color 0.12s, background 0.12s;
}
.link-btn:hover { color: var(--text); background: rgba(6,182,212,0.08); }

/* Search + status-chip toolbar above the events list. Search
   takes the available width; chips align to the right at wide
   widths and wrap to a second row on narrow viewports so the
   list never has to fight the toolbar for space. */
.events-toolbar {
  display: flex; align-items: center; gap: 0.85rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.events-search {
  flex: 1 1 220px;
  min-width: 0;
}
.events-status-chips {
  display: inline-flex; gap: 0.35rem;
  flex-wrap: wrap;
}
.status-chip {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.status-chip:hover { color: var(--text-2); border-color: var(--border-2); }
.status-chip.active {
  background: var(--cyan-dim);
  color: var(--cyan);
  border-color: var(--cyan);
}
.status-chip-count {
  font-family: var(--font-mono);
  font-size: 10px; font-weight: 700;
  letter-spacing: 0;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
}
.status-chip.active .status-chip-count {
  background: rgba(6, 182, 212, 0.18);
}
.event-type-pill {
  font-family: var(--font-display); font-size: 9px; font-weight: 900;
  letter-spacing: 0.18em; text-transform: uppercase;
  color: var(--cyan); background: var(--cyan-dim);
  border: 1px solid rgba(6,182,212,0.4); border-radius: 3px;
  padding: 0.1rem 0.4rem; margin-right: 0.2rem;
}
.event-type-pill.team { color: var(--amber); background: rgba(245,158,11,0.08); border-color: rgba(245,158,11,0.4); }
.event-type-pill.prelim {
  color: var(--text-2); background: var(--bg-2); border-color: var(--border-2);
}
.event-type-pill.semi-pill {
  color: var(--amber); background: var(--amber-dim); border-color: rgba(245,158,11,0.4);
}
.event-type-pill.final-pill {
  color: var(--green); background: var(--green-dim); border-color: rgba(16,185,129,0.4);
}
.event-type-pill.age {
  color: #c4b5fd; background: rgba(139,92,246,0.08); border-color: rgba(139,92,246,0.4);
}
/* International chip: clickable button styled like the other
   pills. Lights up cyan on hover so it reads as actionable. */
.event-type-pill.intl-pill {
  color: #67e8f9; background: rgba(34,211,238,0.12); border-color: rgba(34,211,238,0.45);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.event-type-pill.intl-pill:hover {
  background: rgba(34,211,238,0.22);
  border-color: var(--cyan);
  color: var(--text);
}
.hint {
  font-size: 11px; color: var(--text-3); line-height: 1.5;
  padding: 0.6rem 0.75rem; margin-top: 0.4rem;
  background: var(--bg-3); border-left: 3px solid var(--cyan); border-radius: 3px;
}
.hint-line { font-family: var(--font-mono); font-size: 11px; color: var(--text-3); margin-top: 0.5rem; }
.hint-warn  {
  border-left-color: var(--amber);
  background: rgba(245,158,11,0.08);
  color: var(--amber);
}

/* Round-rules editor (migration 038). Each section is a small
   panel inside the event-create form: label + rounds + DD-sum
   cap + groups checkbox + remove button. */
.rr-editor { margin-top: 0.5rem; }
.rr-total {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--text-3); letter-spacing: 0.04em;
}
.rr-total-mismatch { color: var(--amber); }
.rr-section {
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.65rem;
  margin-bottom: 0.5rem;
  display: flex; flex-direction: column; gap: 0.35rem;
}
.rr-section-row {
  display: flex; gap: 0.5rem; align-items: flex-end;
}
.rr-section-row .input { font-size: 12px; padding: 0.45rem 0.6rem; }
.rr-label { flex: 1 1 auto; }
.rr-cell { flex: 1 1 0; display: flex; flex-direction: column; gap: 0.2rem; }
.rr-cell-label {
  font-family: var(--font-display); font-size: 9px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
}
.rr-remove { color: var(--text-3); flex-shrink: 0; }
.rr-remove:hover { color: var(--red); }
.rr-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

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

/* Field-bottom checkbox row + a small help pill that toggles a
   nearby explainer block. Used by the Migration 031 sign-off
   policy + mixed-board flags. */
.checkbox-row {
  display: flex; align-items: center; gap: 0.5rem;
  margin-top: 0.5rem; font-size: 13px;
  cursor: pointer; user-select: none;
}
.checkbox-row input[type="checkbox"] { margin: 0; }
.help-pill {
  display: inline-flex; align-items: center; justify-content: center;
  width: 18px; height: 18px; border-radius: 50%;
  background: var(--bg-3); border: 1px solid var(--border);
  color: var(--text-3); font-size: 11px; font-weight: 700;
  cursor: pointer; padding: 0;
}
.help-pill:hover { color: var(--text); border-color: var(--cyan); }
.help-popover {
  margin-top: 0.5rem; padding: 0.7rem 0.9rem;
  background: var(--bg-3); border: 1px solid var(--border);
  border-left: 3px solid var(--amber);
  border-radius: 4px; font-size: 12.5px; line-height: 1.55;
  color: var(--text-2);
}
.help-popover strong { display: block; margin-top: 0.4rem; color: var(--text); }
.help-popover strong:first-child { margin-top: 0; }
.help-popover p { margin: 0.2rem 0 0.5rem; }
</style>
