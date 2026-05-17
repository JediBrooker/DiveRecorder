<script setup>
// Session Scheduler — Phase 1, read-only.
//
// Renders the day-timeline mock from docs/session-scheduler.md §4.1:
// a vertical timeline (30-min gridlines) with one column per board,
// blocks anchored to their windows by absolute positioning. Nothing
// here is editable — no drag, no resize, no insert. The only
// affordance beyond viewing is the "Subscribe (.ics)" link, which
// hands the public iCal feed to the operating-system calendar
// client.
//
// Phases 2-4 (conflicts overlay, drag-to-edit, live re-flow modal)
// will extend this same view rather than spawning new ones —
// keeps the spectator-facing route URL stable.

import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'

const route = useRoute()
const { t } = useI18n()

const meetId = computed(() => route.params.meetId)

const loading = ref(false)
const error = ref('')
const sessions = ref([])
const boards = ref([])

// Visual constants. Pixels per minute defines how tall each block
// renders; the 30-minute gridline cadence and column widths come
// off of it. Tweak these together — the gridline drawer assumes
// MINUTES_PER_GRIDLINE × PIXELS_PER_MINUTE = the row height.
const PIXELS_PER_MINUTE = 1.6
const MINUTES_PER_GRIDLINE = 30
const GRIDLINE_HEIGHT = PIXELS_PER_MINUTE * MINUTES_PER_GRIDLINE

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
}

watch(() => route.params.meetId, () => load(), { immediate: true })
onMounted(() => { if (meetId.value) load() })

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
</script>

<template>
  <div class="scheduler-wrap">
    <div class="scheduler-nav">
      <RouterLink :to="`/meet/${meetId}`" class="btn btn-ghost btn-sm">
        {{ $t('scheduler.back_to_meet') }}
      </RouterLink>
      <div class="scheduler-ics">
        <a :href="webcalUrl" class="btn btn-ghost btn-sm">
          {{ $t('scheduler.subscribe_ics') }}
        </a>
        <a :href="icsUrl" class="scheduler-ics-download" target="_blank" rel="noopener">
          {{ $t('scheduler.download_ics') }}
        </a>
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
              :class="['scheduler-block', blockToneClass(block)]"
              :style="blockStyle(block, session)"
              v-tip="block.notes || ''"
            >
              <div class="scheduler-block-time">
                {{ formatTime(block.starts_at) }} – {{ formatTime(block.ends_at) }}
              </div>
              <div class="scheduler-block-label">
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
</style>
