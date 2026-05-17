<script setup>
// Session Scheduler — Phases 1 & 2.
//
// Phase 1 (already shipped): vertical timeline (30-min gridlines)
// with one column per board, blocks anchored to their windows by
// absolute positioning. Read-only — no drag, no resize, no insert.
//
// Phase 2 (this revision): conflict overlay + drawer.
//   * Blocks participating in an active (non-dismissed) conflict
//     pick up a coloured outline (red for hard, amber for soft)
//     and a ⚠ marker, matching docs/session-scheduler.md §4.1.
//   * Collapsible drawer on the right lists conflicts grouped
//     by severity. Each entry has Jump-to-block, Dismiss
//     (with optional reason), and (when "show dismissed" is on)
//     Un-dismiss. Drawer open-state + show-dismissed toggle
//     persist per-user in localStorage.
//   * Subscribes to the `schedule:conflict_dismissed` socket
//     event and refetches /conflicts on receipt so multi-tab
//     dismissals propagate live.
//
// Phases 3-4 (drag-to-edit, duplicate-session, live re-flow)
// continue to extend this same file — the read-only positioning
// in Phase 1 + 2 doesn't change in Phase 3 (only the affordances
// on top of it do).

import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'

const route = useRoute()
const { t } = useI18n()
const auth = useAuthStore()
const socket = useSocket({ spectator: true })

const meetId = computed(() => route.params.meetId)

const loading = ref(false)
const error = ref('')
const sessions = ref([])
const boards = ref([])

// Phase 2 — conflict state.
const conflicts = ref([])           // raw response from /conflicts
const conflictsLoading = ref(false)
const conflictsError = ref('')
const drawerOpen = ref(false)
const showDismissed = ref(false)
const dismissingId = ref(null)      // composite key of the row currently
                                    // in the "type a reason" inline form
const dismissReason = ref('')
const dismissPending = ref(false)
const dismissError = ref('')
const highlightBlockId = ref(null)  // block to flash when "Jump to block"
                                    // is clicked — cleared after the
                                    // animation lands.

// Visual constants. Pixels per minute defines how tall each block
// renders; the 30-minute gridline cadence and column widths come
// off of it. Tweak these together — the gridline drawer assumes
// MINUTES_PER_GRIDLINE × PIXELS_PER_MINUTE = the row height.
const PIXELS_PER_MINUTE = 1.6
const MINUTES_PER_GRIDLINE = 30
const GRIDLINE_HEIGHT = PIXELS_PER_MINUTE * MINUTES_PER_GRIDLINE

// LocalStorage keys for the QoL prefs. Mirrors the locale-switcher
// pattern in src/i18n/index.js — a single namespace, one key per
// preference, JSON-encoded so we can extend later without a
// migration. Read once at mount, written on toggle.
const LS_DRAWER_OPEN = 'scheduler.drawerOpen'
const LS_SHOW_DISMISSED = 'scheduler.showDismissed'

function readPref(key, fallback) {
  if (typeof window === 'undefined') return fallback
  try {
    const raw = window.localStorage.getItem(key)
    if (raw == null) return fallback
    return JSON.parse(raw)
  } catch { return fallback }
}
function writePref(key, value) {
  if (typeof window === 'undefined') return
  try { window.localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore quota */ }
}
watch(drawerOpen, (v) => writePref(LS_DRAWER_OPEN, v))
watch(showDismissed, (v) => writePref(LS_SHOW_DISMISSED, v))

async function load() {
  if (!meetId.value) return
  loading.value = true
  error.value = ''
  try {
    const r = await fetch(`/api/meets/${meetId.value}/sessions`)
    const body = await r.json().catch(() => null)
    if (!r.ok) throw new Error(body?.error || `Server returned ${r.status}`)
    sessions.value = Array.isArray(body?.sessions) ? body.sessions : []
    boards.value = Array.isArray(body?.boards) ? body.boards : []
  } catch (err) {
    error.value = err.message || t('scheduler.load_failed')
  } finally {
    loading.value = false
  }
  // Conflicts are independent of /sessions but always paired with
  // it in the UI — fire them after we have block ids to map
  // against.
  await loadConflicts()
}

async function loadConflicts() {
  if (!meetId.value) return
  conflictsLoading.value = true
  conflictsError.value = ''
  try {
    const r = await fetch(`/api/meets/${meetId.value}/conflicts`)
    const body = await r.json().catch(() => null)
    if (!r.ok) throw new Error(body?.error || `Server returned ${r.status}`)
    conflicts.value = Array.isArray(body?.conflicts) ? body.conflicts : []
  } catch (err) {
    conflictsError.value = err.message || t('scheduler.conflicts.load_failed')
  } finally {
    conflictsLoading.value = false
  }
}

watch(() => route.params.meetId, () => load(), { immediate: true })
onMounted(() => {
  drawerOpen.value = readPref(LS_DRAWER_OPEN, false)
  showDismissed.value = readPref(LS_SHOW_DISMISSED, false)
  if (meetId.value) load()
})

// Socket subscription — refetch on schedule:conflict_dismissed for
// any meet we care about. Filtered to our meet to avoid
// gratuitous refetches when a different meet's dismissal
// broadcasts through the shared socket pool.
function onConflictDismissed(payload) {
  if (!payload || !meetId.value) return
  if (payload.meet_id && payload.meet_id !== meetId.value) return
  loadConflicts()
}
socket.on('schedule:conflict_dismissed', onConflictDismissed)
onUnmounted(() => {
  socket.off('schedule:conflict_dismissed', onConflictDismissed)
})

// The .ics URL is a same-origin path so the browser can hand it
// off to the OS calendar client. We expose it both as a plain
// link (download / open in browser) and as a webcal:// link
// (subscribe in the OS calendar so re-flow updates propagate).
const icsUrl = computed(() => (meetId.value ? `/api/meets/${meetId.value}/schedule.ics` : '#'))
const webcalUrl = computed(() => {
  if (!meetId.value) return '#'
  // Strip the scheme so the OS calendar treats the link as a
  // subscription rather than a one-shot download. window may be
  // undefined during SSR — the SchedulerView isn't SSR'd today,
  // but the guard costs nothing.
  if (typeof window === 'undefined') return '#'
  const { host } = window.location
  return `webcal://${host}/api/meets/${meetId.value}/schedule.ics`
})

// Per-session render scaffolding. We compute the day window
// (earliest block start → latest block end), snap it out to the
// nearest 30-min boundary on each end, and use that as the
// timeline's vertical extent.
function sessionWindow(session) {
  const all = session.blocks || []
  if (!all.length) return null
  let minMs = Infinity
  let maxMs = -Infinity
  for (const b of all) {
    const s = new Date(b.starts_at).getTime()
    const e = new Date(b.ends_at).getTime()
    if (s < minMs) minMs = s
    if (e > maxMs) maxMs = e
  }
  // Snap to MINUTES_PER_GRIDLINE boundaries so the first / last
  // gridline labels land on round times.
  const snap = MINUTES_PER_GRIDLINE * 60 * 1000
  minMs = Math.floor(minMs / snap) * snap
  maxMs = Math.ceil(maxMs / snap) * snap
  return { start: new Date(minMs), end: new Date(maxMs) }
}

function gridlinesForSession(session) {
  const win = sessionWindow(session)
  if (!win) return []
  const out = []
  for (
    let t = win.start.getTime();
    t <= win.end.getTime();
    t += MINUTES_PER_GRIDLINE * 60 * 1000
  ) {
    out.push(new Date(t))
  }
  return out
}

function timelineHeight(session) {
  const win = sessionWindow(session)
  if (!win) return 0
  const minutes = (win.end.getTime() - win.start.getTime()) / 60000
  return minutes * PIXELS_PER_MINUTE
}

// Per-block geometry. board_ids is a uuid[]; we resolve each id
// to a column index and render the block spanning that column.
// Blocks with no board (ceremonies, breaks) get a 'no-column'
// pseudo-column that spans the full width — visually distinct
// so the operator can see they're meet-wide.
function blockStyle(block, session) {
  const win = sessionWindow(session)
  if (!win) return {}
  const offsetMin = (new Date(block.starts_at).getTime() - win.start.getTime()) / 60000
  const durMin = (new Date(block.ends_at).getTime() - new Date(block.starts_at).getTime()) / 60000
  const top = offsetMin * PIXELS_PER_MINUTE
  const height = Math.max(durMin * PIXELS_PER_MINUTE, 18)

  const boardIds = Array.isArray(block.board_ids) ? block.board_ids : []
  if (!boardIds.length) {
    // Full-width band for meet-wide blocks.
    return {
      top: `${top}px`,
      height: `${height}px`,
      left: '0',
      right: '0',
    }
  }
  const cols = boards.value
  if (!cols.length) {
    return { top: `${top}px`, height: `${height}px`, left: '0', right: '0' }
  }
  const indices = boardIds
    .map((id) => cols.findIndex((b) => b.id === id))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b)
  if (!indices.length) {
    return { top: `${top}px`, height: `${height}px`, left: '0', right: '0' }
  }
  const first = indices[0]
  const last = indices[indices.length - 1]
  const colWidthPct = 100 / cols.length
  const leftPct = first * colWidthPct
  const widthPct = (last - first + 1) * colWidthPct
  return {
    top: `${top}px`,
    height: `${height}px`,
    left: `${leftPct}%`,
    width: `${widthPct}%`,
  }
}

function formatTime(d) {
  return new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
function formatDate(d) {
  return new Date(d).toLocaleDateString([], {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })
}
function formatRelative(d) {
  if (!d) return ''
  const date = new Date(d)
  return date.toLocaleString([], {
    day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
  })
}

function boardLabel(board) {
  if (board.label) return `${board.height} · ${board.label}`
  return board.height
}

// block_type → tone class on the card. Maps to a small CSS
// palette below; the design doc's mock uses colour to distinguish
// at-a-glance which kind of block you're looking at.
function blockToneClass(block) {
  return `block-${block.block_type || 'custom'}`
}

// -----------------------------------------------------------------
// Conflict derivations
// -----------------------------------------------------------------

// Active conflicts (not dismissed) — what the marker / outline /
// counter use. Dismissed ones land in the drawer's "Dismissed"
// section only when the toggle is on.
const activeConflicts = computed(() =>
  conflicts.value.filter((c) => !c.dismissed),
)
const dismissedConflicts = computed(() =>
  conflicts.value.filter((c) => c.dismissed),
)
const hardConflicts = computed(() =>
  activeConflicts.value.filter((c) => c.severity === 'hard'),
)
const softConflicts = computed(() =>
  activeConflicts.value.filter((c) => c.severity === 'soft'),
)

// Map of blockId → 'hard' | 'soft' for fast lookup at render
// time. Hard wins over soft (a block with both gets the red
// outline, not the amber).
const blockConflictMap = computed(() => {
  const out = new Map()
  for (const c of activeConflicts.value) {
    for (const blockId of [c.block_a.id, c.block_b.id]) {
      const existing = out.get(blockId)
      if (existing === 'hard') continue
      out.set(blockId, c.severity)
    }
  }
  return out
})

function conflictSeverityForBlock(blockId) {
  return blockConflictMap.value.get(blockId) || null
}

function conflictKey(c) {
  return `${c.block_a.id}|${c.block_b.id}|${c.resource_kind}`
}

function isEditing(c) {
  return dismissingId.value === conflictKey(c)
}

function kindLabel(kind) {
  return t(`scheduler.conflicts.kind_${kind}`)
}

function conflictNames(c) {
  return (c.resource_labels || [])
    .filter((s) => s && s.trim())
    .join(', ') || '—'
}

function blockHeading(b) {
  return b.label || b.event_name || t(`scheduler.block_type.${b.block_type}`)
}

// "Jump to block": scroll the matching block card into view, then
// flash a highlight ring. The watch on highlightBlockId clears it
// after a short window so a second click on the same row re-fires
// the animation.
function jumpToBlock(blockId) {
  if (!blockId) return
  nextTick(() => {
    const el = document.querySelector(`[data-block-id="${blockId}"]`)
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
    highlightBlockId.value = blockId
    setTimeout(() => {
      if (highlightBlockId.value === blockId) highlightBlockId.value = null
    }, 1800)
  })
}

function openDismissForm(c) {
  dismissingId.value = conflictKey(c)
  dismissReason.value = ''
  dismissError.value = ''
}
function cancelDismiss() {
  dismissingId.value = null
  dismissReason.value = ''
  dismissError.value = ''
}

async function confirmDismiss(c) {
  dismissPending.value = true
  dismissError.value = ''
  try {
    await auth.apiFetch('/api/conflicts/dismiss', {
      method: 'POST',
      body: JSON.stringify({
        block_a_id: c.block_a.id,
        block_b_id: c.block_b.id,
        resource_kind: c.resource_kind,
        reason: dismissReason.value.trim() || undefined,
      }),
    })
    cancelDismiss()
    // The socket emit will refetch on every tab; do an immediate
    // refetch here too in case sockets are still reconnecting.
    await loadConflicts()
  } catch (err) {
    dismissError.value = err.message || t('scheduler.conflicts.load_failed')
  } finally {
    dismissPending.value = false
  }
}

async function undismiss(c) {
  if (!c.dismissal?.id) return
  try {
    await auth.apiFetch(`/api/conflicts/dismiss/${c.dismissal.id}`, {
      method: 'DELETE',
    })
    await loadConflicts()
  } catch (err) {
    conflictsError.value = err.message || t('scheduler.conflicts.load_failed')
  }
}
</script>

<template>
  <div class="scheduler-wrap" :class="{ 'has-drawer': drawerOpen }">
    <div class="scheduler-nav">
      <RouterLink :to="`/meet/${meetId}`" class="btn btn-ghost btn-sm">
        {{ $t('scheduler.back_to_meet') }}
      </RouterLink>
      <div class="scheduler-nav-right">
        <button
          type="button"
          class="btn btn-ghost btn-sm scheduler-drawer-toggle"
          :class="{ 'has-warnings': activeConflicts.length > 0 }"
          @click="drawerOpen = !drawerOpen"
        >
          <span v-if="activeConflicts.length">
            {{ $t('scheduler.conflicts.open_drawer', { n: activeConflicts.length }) }}
          </span>
          <span v-else>
            {{ $t('scheduler.conflicts.open_drawer_clean') }}
          </span>
        </button>
        <div class="scheduler-ics">
          <a :href="webcalUrl" class="btn btn-ghost btn-sm">
            {{ $t('scheduler.subscribe_ics') }}
          </a>
          <a :href="icsUrl" class="scheduler-ics-download" target="_blank" rel="noopener">
            {{ $t('scheduler.download_ics') }}
          </a>
        </div>
      </div>
    </div>

    <h1 class="scheduler-title">{{ $t('scheduler.title') }}</h1>
    <p class="scheduler-sub">{{ $t('scheduler.subtitle') }}</p>

    <div v-if="loading" class="scheduler-status">{{ $t('common.loading') }}</div>
    <div v-else-if="error" class="scheduler-status scheduler-error">{{ error }}</div>
    <div v-else-if="!sessions.length" class="scheduler-status">
      {{ $t('scheduler.empty') }}
    </div>

    <section v-for="session in sessions" :key="session.id" class="scheduler-session">
      <div class="scheduler-session-head">
        <div class="scheduler-session-title">{{ session.name }}</div>
        <div class="scheduler-session-meta">
          {{ formatDate(session.session_date) }}
          <span v-if="session.pool"> · {{ session.pool }}</span>
        </div>
      </div>

      <div v-if="!session.blocks || !session.blocks.length" class="scheduler-status">
        {{ $t('scheduler.no_blocks') }}
      </div>

      <div v-else class="scheduler-timeline-wrap">
        <!-- Time column on the left, with a row label per gridline. -->
        <div class="scheduler-time-col">
          <div class="scheduler-col-head">&nbsp;</div>
          <div
            v-for="g in gridlinesForSession(session)"
            :key="`g-${g.getTime()}`"
            class="scheduler-time-row"
            :style="{ height: `${GRIDLINE_HEIGHT}px` }"
          >
            <span class="scheduler-time-label">{{ formatTime(g) }}</span>
          </div>
        </div>

        <!-- Board columns + absolutely-positioned block layer. -->
        <div class="scheduler-grid">
          <div class="scheduler-grid-head">
            <div
              v-for="b in boards"
              :key="b.id"
              class="scheduler-col-head"
            >
              {{ boardLabel(b) }}
            </div>
            <div v-if="!boards.length" class="scheduler-col-head">
              {{ $t('scheduler.no_boards_column') }}
            </div>
          </div>

          <div
            class="scheduler-grid-body"
            :style="{ height: `${timelineHeight(session)}px` }"
          >
            <!-- Gridlines: one absolutely-positioned hairline per
                 30-min boundary so the operator can eyeball any
                 block's start time without checking the left rail. -->
            <div
              v-for="(g, idx) in gridlinesForSession(session)"
              :key="`gline-${g.getTime()}`"
              class="scheduler-gridline"
              :style="{ top: `${idx * GRIDLINE_HEIGHT}px` }"
            ></div>

            <!-- Column dividers — one per board boundary. -->
            <div
              v-for="(b, i) in boards"
              :key="`colsep-${b.id}`"
              v-show="i > 0"
              class="scheduler-colsep"
              :style="{ left: `${(i / boards.length) * 100}%` }"
            ></div>

            <!-- The blocks themselves. -->
            <div
              v-for="block in session.blocks"
              :key="block.id"
              :data-block-id="block.id"
              :class="[
                'scheduler-block',
                blockToneClass(block),
                conflictSeverityForBlock(block.id) === 'hard' ? 'has-conflict-hard' : '',
                conflictSeverityForBlock(block.id) === 'soft' ? 'has-conflict-soft' : '',
                highlightBlockId === block.id ? 'is-highlighted' : '',
              ]"
              :style="blockStyle(block, session)"
              v-tip="block.notes || ''"
            >
              <div class="scheduler-block-time">
                {{ formatTime(block.starts_at) }} – {{ formatTime(block.ends_at) }}
              </div>
              <div class="scheduler-block-label">
                <span
                  v-if="conflictSeverityForBlock(block.id)"
                  class="scheduler-block-warn"
                  :title="conflictSeverityForBlock(block.id) === 'hard'
                    ? $t('scheduler.conflicts.marker_tooltip_hard')
                    : $t('scheduler.conflicts.marker_tooltip_soft')"
                >⚠</span>
                {{ block.label || $t(`scheduler.block_type.${block.block_type}`) }}
              </div>
              <div v-if="block.event_name && block.event_name !== block.label" class="scheduler-block-sub">
                {{ block.event_name }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- =========================================================
         Conflicts drawer — Phase 2.
         Mounted at the page level (not inside .scheduler-session)
         so it stays visible while the operator scrolls between
         sessions on a multi-day meet.
         ========================================================= -->
    <aside v-if="drawerOpen" class="scheduler-drawer">
      <div class="scheduler-drawer-head">
        <div class="scheduler-drawer-title">
          {{ $t('scheduler.conflicts.drawer_title') }}
          <span v-if="activeConflicts.length" class="scheduler-drawer-count">
            ({{ activeConflicts.length }})
          </span>
        </div>
        <div class="scheduler-drawer-controls">
          <label class="scheduler-drawer-toggle-label">
            <input type="checkbox" v-model="showDismissed">
            {{ showDismissed ? $t('scheduler.conflicts.hide_dismissed') : $t('scheduler.conflicts.show_dismissed') }}
          </label>
          <button
            type="button"
            class="btn btn-ghost btn-sm"
            @click="drawerOpen = false"
            :aria-label="$t('scheduler.conflicts.close_drawer')"
          >✕</button>
        </div>
      </div>

      <div class="scheduler-drawer-body">
        <div v-if="conflictsLoading" class="scheduler-status">
          {{ $t('scheduler.conflicts.loading') }}
        </div>
        <div v-else-if="conflictsError" class="scheduler-status scheduler-error">
          {{ conflictsError }}
        </div>

        <template v-else>
          <!-- Hard conflicts -->
          <div v-if="hardConflicts.length" class="scheduler-drawer-section">
            <div class="scheduler-drawer-section-head section-hard">
              {{ $t('scheduler.conflicts.section_hard') }} ({{ hardConflicts.length }})
            </div>
            <div
              v-for="c in hardConflicts"
              :key="conflictKey(c)"
              class="scheduler-conflict-card severity-hard"
            >
              <div class="scheduler-conflict-kind">{{ kindLabel(c.resource_kind) }}</div>
              <div class="scheduler-conflict-resource">
                {{ $t('scheduler.conflicts.resource_label', { kind: kindLabel(c.resource_kind), names: conflictNames(c) }) }}
              </div>
              <div class="scheduler-conflict-blocks">
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_a) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_a.session_name || '' }) }}
                    · {{ formatTime(c.block_a.starts_at) }}–{{ formatTime(c.block_a.ends_at) }}
                  </div>
                </div>
                <div class="scheduler-conflict-arrow">{{ $t('scheduler.conflicts.pair_separator') }}</div>
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_b) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_b.session_name || '' }) }}
                    · {{ formatTime(c.block_b.starts_at) }}–{{ formatTime(c.block_b.ends_at) }}
                  </div>
                </div>
              </div>
              <div v-if="!isEditing(c)" class="scheduler-conflict-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_a.id)">
                  {{ $t('scheduler.conflicts.jump_to_a') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_b.id)">
                  {{ $t('scheduler.conflicts.jump_to_b') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="openDismissForm(c)">
                  {{ $t('scheduler.conflicts.dismiss') }}
                </button>
              </div>
              <div v-else class="scheduler-conflict-dismiss-form">
                <textarea
                  class="input"
                  rows="2"
                  :placeholder="$t('scheduler.conflicts.dismiss_reason_placeholder')"
                  v-model="dismissReason"
                  :disabled="dismissPending"
                ></textarea>
                <div v-if="dismissError" class="msg msg-error">{{ dismissError }}</div>
                <div class="scheduler-conflict-actions">
                  <button type="button" class="btn btn-ghost btn-sm" @click="cancelDismiss" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_cancel') }}
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" @click="confirmDismiss(c)" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_confirm') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <!-- Soft warnings -->
          <div v-if="softConflicts.length" class="scheduler-drawer-section">
            <div class="scheduler-drawer-section-head section-soft">
              {{ $t('scheduler.conflicts.section_soft') }} ({{ softConflicts.length }})
            </div>
            <div
              v-for="c in softConflicts"
              :key="conflictKey(c)"
              class="scheduler-conflict-card severity-soft"
            >
              <div class="scheduler-conflict-kind">{{ kindLabel(c.resource_kind) }}</div>
              <div class="scheduler-conflict-resource">
                {{ $t('scheduler.conflicts.resource_label', { kind: kindLabel(c.resource_kind), names: conflictNames(c) }) }}
              </div>
              <div class="scheduler-conflict-blocks">
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_a) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_a.session_name || '' }) }}
                    · {{ formatTime(c.block_a.starts_at) }}–{{ formatTime(c.block_a.ends_at) }}
                  </div>
                </div>
                <div class="scheduler-conflict-arrow">{{ $t('scheduler.conflicts.pair_separator') }}</div>
                <div>
                  <div class="scheduler-conflict-block-label">{{ blockHeading(c.block_b) }}</div>
                  <div class="scheduler-conflict-block-sub">
                    {{ $t('scheduler.conflicts.session_label', { name: c.block_b.session_name || '' }) }}
                    · {{ formatTime(c.block_b.starts_at) }}–{{ formatTime(c.block_b.ends_at) }}
                  </div>
                </div>
              </div>
              <div v-if="!isEditing(c)" class="scheduler-conflict-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_a.id)">
                  {{ $t('scheduler.conflicts.jump_to_a') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_b.id)">
                  {{ $t('scheduler.conflicts.jump_to_b') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="openDismissForm(c)">
                  {{ $t('scheduler.conflicts.dismiss') }}
                </button>
              </div>
              <div v-else class="scheduler-conflict-dismiss-form">
                <textarea
                  class="input"
                  rows="2"
                  :placeholder="$t('scheduler.conflicts.dismiss_reason_placeholder')"
                  v-model="dismissReason"
                  :disabled="dismissPending"
                ></textarea>
                <div v-if="dismissError" class="msg msg-error">{{ dismissError }}</div>
                <div class="scheduler-conflict-actions">
                  <button type="button" class="btn btn-ghost btn-sm" @click="cancelDismiss" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_cancel') }}
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" @click="confirmDismiss(c)" :disabled="dismissPending">
                    {{ $t('scheduler.conflicts.dismiss_confirm') }}
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div
            v-if="!hardConflicts.length && !softConflicts.length"
            class="scheduler-status"
          >
            {{ $t('scheduler.conflicts.none_active') }}
          </div>

          <!-- Dismissed (toggle) -->
          <div v-if="showDismissed" class="scheduler-drawer-section">
            <div class="scheduler-drawer-section-head section-dismissed">
              {{ $t('scheduler.conflicts.section_dismissed') }} ({{ dismissedConflicts.length }})
            </div>
            <div v-if="!dismissedConflicts.length" class="scheduler-status">
              {{ $t('scheduler.conflicts.none_dismissed') }}
            </div>
            <div
              v-for="c in dismissedConflicts"
              :key="conflictKey(c) + '-dismissed'"
              class="scheduler-conflict-card severity-dismissed"
            >
              <div class="scheduler-conflict-kind">{{ kindLabel(c.resource_kind) }}</div>
              <div class="scheduler-conflict-resource">
                {{ $t('scheduler.conflicts.resource_label', { kind: kindLabel(c.resource_kind), names: conflictNames(c) }) }}
              </div>
              <div class="scheduler-conflict-blocks">
                <div>{{ blockHeading(c.block_a) }} · {{ formatTime(c.block_a.starts_at) }}–{{ formatTime(c.block_a.ends_at) }}</div>
                <div class="scheduler-conflict-arrow">{{ $t('scheduler.conflicts.pair_separator') }}</div>
                <div>{{ blockHeading(c.block_b) }} · {{ formatTime(c.block_b.starts_at) }}–{{ formatTime(c.block_b.ends_at) }}</div>
              </div>
              <div v-if="c.dismissal" class="scheduler-conflict-dismissed-meta">
                <div>{{ $t('scheduler.conflicts.dismissed_by_at', { when: formatRelative(c.dismissal.at) }) }}</div>
                <div v-if="c.dismissal.reason">
                  {{ $t('scheduler.conflicts.dismissed_reason', { reason: c.dismissal.reason }) }}
                </div>
              </div>
              <div class="scheduler-conflict-actions">
                <button type="button" class="btn btn-ghost btn-sm" @click="jumpToBlock(c.block_a.id)">
                  {{ $t('scheduler.conflicts.jump_to_a') }}
                </button>
                <button type="button" class="btn btn-ghost btn-sm" @click="undismiss(c)">
                  {{ $t('scheduler.conflicts.undismiss') }}
                </button>
              </div>
            </div>
          </div>
        </template>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.scheduler-wrap {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.5rem 1rem 4rem;
}

.scheduler-nav {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}
.scheduler-nav-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.scheduler-ics {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.scheduler-ics-download {
  font-size: 12px;
  color: var(--muted, #888);
  text-decoration: underline;
}

.scheduler-drawer-toggle.has-warnings {
  border-color: var(--red, #c33);
  color: var(--red, #c33);
}

.scheduler-title {
  font-size: 28px;
  margin: 0 0 0.25rem;
}
.scheduler-sub {
  margin: 0 0 1.5rem;
  color: var(--muted, #888);
  font-style: italic;
}

.scheduler-status {
  padding: 1rem;
  border: 1px dashed var(--border, #444);
  border-radius: 6px;
  text-align: center;
  color: var(--muted, #888);
  margin: 1rem 0;
}
.scheduler-error { color: var(--red, #c33); border-color: var(--red, #c33); }

.scheduler-session {
  margin-bottom: 2.5rem;
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  background: var(--panel, #1a1a1a);
  overflow: hidden;
}

.scheduler-session-head {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border, #333);
  background: var(--panel-elev, #222);
}
.scheduler-session-title {
  font-size: 18px;
  font-weight: 600;
}
.scheduler-session-meta {
  font-size: 13px;
  color: var(--muted, #888);
  margin-top: 0.15rem;
}

.scheduler-timeline-wrap {
  display: flex;
  align-items: flex-start;
}

.scheduler-time-col {
  flex: 0 0 64px;
  border-right: 1px solid var(--border, #333);
}
.scheduler-time-row {
  position: relative;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.05));
}
.scheduler-time-label {
  position: absolute;
  top: -8px;
  right: 6px;
  font-size: 11px;
  color: var(--muted, #888);
  background: var(--panel, #1a1a1a);
  padding: 0 4px;
}

.scheduler-grid {
  flex: 1 1 auto;
  position: relative;
}
.scheduler-grid-head {
  display: flex;
}
.scheduler-col-head {
  flex: 1 1 0;
  text-align: center;
  font-size: 12px;
  font-weight: 600;
  padding: 0.5rem 0.25rem;
  color: var(--muted, #ccc);
  border-right: 1px solid var(--border, #333);
  background: var(--panel-elev, #222);
}
.scheduler-col-head:last-child { border-right: none; }

.scheduler-grid-body {
  position: relative;
  background: var(--panel, #1a1a1a);
}

.scheduler-gridline {
  position: absolute;
  left: 0;
  right: 0;
  border-top: 1px dashed var(--border-subtle, rgba(255,255,255,0.07));
  pointer-events: none;
}
.scheduler-colsep {
  position: absolute;
  top: 0;
  bottom: 0;
  border-left: 1px solid var(--border, #333);
  pointer-events: none;
}

.scheduler-block {
  position: absolute;
  padding: 4px 6px;
  border-radius: 4px;
  font-size: 12px;
  overflow: hidden;
  border-left: 3px solid var(--cyan, #4cb);
  background: rgba(76, 187, 204, 0.15);
  color: var(--fg, #eee);
  box-sizing: border-box;
  transition: outline-color 0.2s, box-shadow 0.2s;
  outline: 2px solid transparent;
  outline-offset: -2px;
}
.scheduler-block-time {
  font-size: 10px;
  color: var(--muted, #ccc);
  margin-bottom: 1px;
}
.scheduler-block-label {
  font-weight: 600;
  line-height: 1.15;
}
.scheduler-block-warn {
  display: inline-block;
  margin-right: 2px;
  color: var(--red, #c33);
  font-weight: 700;
}
.has-conflict-soft .scheduler-block-warn { color: var(--amber, #d90); }
.scheduler-block-sub {
  font-size: 11px;
  color: var(--muted, #aaa);
  margin-top: 2px;
}

/* Block-type palette. Each tone gets its own border + tinted
   background so a glance at the timeline reads as colour-coded
   by category, matching the design-doc mock. */
.block-warmup     { border-left-color: #6ab; background: rgba(106, 170, 187, 0.15); }
.block-event_start{ border-left-color: #d83; background: rgba(216, 136, 51, 0.18); }
.block-break      { border-left-color: #888; background: rgba(136, 136, 136, 0.15); }
.block-ceremony   { border-left-color: #c6a; background: rgba(204, 102, 170, 0.18); }
.block-custom     { border-left-color: #6c6; background: rgba(102, 204, 102, 0.15); }

/* Conflict outlines. Hard wins over soft via specificity order. */
.scheduler-block.has-conflict-soft {
  outline-color: var(--amber, #d90);
}
.scheduler-block.has-conflict-hard {
  outline-color: var(--red, #c33);
  outline-width: 2px;
}
.scheduler-block.is-highlighted {
  box-shadow: 0 0 0 3px var(--cyan, #4cb), 0 0 16px 4px rgba(76, 187, 204, 0.6);
}

/* ----- Drawer ----- */
.scheduler-drawer {
  position: fixed;
  top: 70px;
  right: 12px;
  width: 360px;
  max-width: calc(100vw - 24px);
  max-height: calc(100vh - 90px);
  background: var(--panel-elev, #222);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  z-index: 50;
}
.scheduler-drawer-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid var(--border, #333);
  background: var(--panel, #1a1a1a);
}
.scheduler-drawer-title {
  font-weight: 700;
  font-size: 14px;
}
.scheduler-drawer-count {
  margin-left: 0.25rem;
  color: var(--red, #c33);
  font-weight: 700;
}
.scheduler-drawer-controls {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
.scheduler-drawer-toggle-label {
  font-size: 11px;
  color: var(--muted, #aaa);
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  cursor: pointer;
  user-select: none;
}
.scheduler-drawer-body {
  overflow-y: auto;
  flex: 1 1 auto;
}
.scheduler-drawer-section {
  border-bottom: 1px solid var(--border, #333);
}
.scheduler-drawer-section-head {
  padding: 0.4rem 0.85rem;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted, #aaa);
  background: var(--panel, #1a1a1a);
}
.section-hard       { color: var(--red, #c33); }
.section-soft       { color: var(--amber, #d90); }
.section-dismissed  { color: var(--muted, #888); }

.scheduler-conflict-card {
  padding: 0.6rem 0.85rem;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.05));
}
.scheduler-conflict-card.severity-hard      { border-left-color: var(--red, #c33); }
.scheduler-conflict-card.severity-soft      { border-left-color: var(--amber, #d90); }
.scheduler-conflict-card.severity-dismissed {
  border-left-color: var(--muted, #555);
  opacity: 0.75;
}
.scheduler-conflict-kind {
  font-size: 10px;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted, #888);
  margin-bottom: 2px;
}
.scheduler-conflict-resource {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 0.4rem;
}
.scheduler-conflict-blocks {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 12px;
  color: var(--muted, #ccc);
  margin-bottom: 0.5rem;
}
.scheduler-conflict-block-label {
  font-weight: 600;
  color: var(--fg, #eee);
}
.scheduler-conflict-block-sub {
  font-size: 11px;
  color: var(--muted, #888);
}
.scheduler-conflict-arrow {
  color: var(--muted, #666);
  font-size: 12px;
  text-align: center;
}
.scheduler-conflict-actions {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}
.scheduler-conflict-dismiss-form {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-top: 0.3rem;
}
.scheduler-conflict-dismiss-form .input {
  font-size: 12px;
  padding: 0.35rem 0.45rem;
  width: 100%;
  box-sizing: border-box;
}
.scheduler-conflict-dismissed-meta {
  font-size: 11px;
  color: var(--muted, #888);
  margin: 0.25rem 0 0.5rem;
}

@media (max-width: 900px) {
  .scheduler-drawer {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100%;
    max-width: 100%;
    max-height: 60vh;
    border-radius: 8px 8px 0 0;
  }
}
</style>
