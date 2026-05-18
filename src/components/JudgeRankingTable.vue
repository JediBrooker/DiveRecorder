<script setup>
/* JudgeRankingTable — "what would the standings have been if every
 * judge had scored unanimously like one specific judge?"
 *
 * For a Completed event, renders a matrix:
 *   rows    = competing entities, ordered by their actual rank:
 *               individual events → divers
 *               synchro_pair      → pairs (lead + partner)
 *               team              → teams
 *   columns = Actual (rank + total) + one column per judge
 *   cells   = rank under that judge's hypothetical unanimous panel,
 *             with the hypothetical total on a second line so the
 *             magnitude is visible without hovering
 *
 * Outliers (any judge whose hypothetical rank differs from the
 * actual rank) are highlighted in cyan so a viewer can scan the
 * matrix and spot every disagreement at a glance. The v-tip
 * tooltip carries the same information plus context (delta from
 * actual + judge identity).
 *
 * The payload is fetched eagerly on mount. The parent
 * (ScoreboardView) consumes the same payload via the `loaded`
 * event to feed the chip-tooltip enhancement, so the endpoint
 * isn't hit twice.
 */
import { ref, onMounted, computed, watch } from 'vue'

// Two ways the component can get its data:
//
//   1. Parent passes `payload` as a prop (preferred — parent has
//      already fetched eagerly so the chip-tooltip data is
//      available on first paint of the page, regardless of
//      whether this section is expanded).
//   2. Parent omits the prop → fall back to fetching internally
//      (Control Room modal still works that way).
const props = defineProps({
  eventId: { type: [String, Number], required: true },
  payload: { type: Object, default: null },
})

const emit = defineEmits(['loaded'])

const loading = ref(false)
const error = ref('')
const localPayload = ref(null)
const payloadView = computed(() => props.payload || localPayload.value)

async function load() {
  // Skip the fetch entirely when the parent already supplied data.
  if (props.payload) {
    emit('loaded', props.payload)
    return
  }
  if (!props.eventId) return
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/events/${props.eventId}/judge-ranking-analysis`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Failed (${res.status})`)
    }
    localPayload.value = await res.json()
    emit('loaded', localPayload.value)
  } catch (err) {
    error.value = err.message || 'Failed to load judge ranking analysis'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.eventId, load)
watch(() => props.payload, (v) => { if (v) emit('loaded', v) })

const judges = computed(() => payloadView.value?.judges || [])
const divers = computed(() => payloadView.value?.divers || [])
const eventType = computed(() => payloadView.value?.event?.event_type || 'individual')
const numJudges = computed(() => payloadView.value?.event?.number_of_judges || judges.value.length)

// Synchro role assignment per WA Article 13. Mirrors
// src/composables/useScoreCategories.js synchroJudgeGroups so the
// table groups judges identically to how the scoreboard already
// renders synchro chip groups.
function synchroRoleFor(judgeNumber) {
  const n = numJudges.value
  if (eventType.value !== 'synchro_pair') return null
  if (n === 9) {
    if (judgeNumber <= 2) return 'a'
    if (judgeNumber <= 4) return 'b'
    return 'sync'
  }
  if (n === 11) {
    if (judgeNumber <= 3) return 'a'
    if (judgeNumber <= 6) return 'b'
    return 'sync'
  }
  return null
}

// Group judges by synchro role for the segregated sub-tables.
// Each segment renders its OWN matrix so the "what would the
// standings be if every judge had scored like J" comparison only
// pits same-role judges against same-role judges (Exec A judges
// only see Diver A's execution; the cross-role comparison the
// previous version surfaced was meaningless).
const synchroSegments = computed(() => {
  if (eventType.value !== 'synchro_pair') return null
  const groups = { a: [], b: [], sync: [] }
  for (const j of judges.value) {
    const r = synchroRoleFor(j.judge_number)
    if (r && groups[r]) groups[r].push(j)
  }
  return [
    { role: 'a',    label: 'Exec A — Diver A execution', judges: groups.a },
    { role: 'b',    label: 'Exec B — Diver B execution', judges: groups.b },
    { role: 'sync', label: 'Synchronisation',            judges: groups.sync },
  ].filter((g) => g.judges.length > 0)
})

// Per-segment ranking: for each diver row, within a given synchro
// role, the "actual rank" is recomputed from the trimmed sum of
// that role's per_judge totals (so Exec A only judges Exec A's
// view of the pairs). Ranks are stable across re-renders because
// the JS sort is stable + we tie-break by diver display order.
function segmentRows(segment) {
  const segJudges = segment.judges
  // Build per-diver role total = sum of segment judges' j_total.
  const withTotals = divers.value.map((d) => {
    let total = 0
    for (const sj of segJudges) {
      const pj = d.per_judge.find((p) => p.judge_id === sj.judge_id)
      if (pj?.judge_total != null) total += Number(pj.judge_total)
    }
    return { diver: d, segment_total: total }
  })
  // Rank by segment_total (DESC). Stable: secondary key is the
  // diver's actual_rank so equal totals fall back to the official
  // ordering rather than DB row order.
  const sorted = [...withTotals].sort((a, b) =>
    b.segment_total - a.segment_total
    || a.diver.actual_rank - b.diver.actual_rank,
  )
  // Assign segment_actual_rank with proper ties (RANK semantics).
  let prev = null
  let prevRank = 0
  sorted.forEach((row, idx) => {
    if (prev != null && Math.abs(row.segment_total - prev) < 1e-9) {
      row.segment_actual_rank = prevRank
    } else {
      row.segment_actual_rank = idx + 1
      prevRank = idx + 1
    }
    prev = row.segment_total
  })
  // Return in actual_rank order (the rows match the table) but
  // tag each with its segment-actual rank for the Actual column.
  const bySeg = new Map(sorted.map((r) => [r.diver.competitor_id, r]));
  return divers.value.map((d) => {
    const hit = bySeg.get(d.competitor_id)
    return {
      diver: d,
      segment_actual_rank: hit?.segment_actual_rank ?? null,
      segment_actual_total: hit?.segment_total ?? 0,
    }
  })
}

// Outlier = any judge whose hypothetical rank disagrees with the
// actual rank. A 1-rank swap is a real signal in this format —
// every disagreement gets flagged so the viewer can scan the
// matrix and see exactly where judges disagreed. Use the cell's
// background tone (light cyan for ±1, deep cyan for ≥2) so the
// strength of the disagreement is visible at a glance.
function isOutlier(pj, actualRank) {
  if (pj?.rank == null) return false
  return pj.rank !== actualRank
}
function outlierStrength(pj, actualRank) {
  if (pj?.rank == null) return ''
  const delta = Math.abs(pj.rank - actualRank)
  if (delta === 0) return ''
  return delta >= 2 ? 'jra-outlier-strong' : 'jra-outlier-mild'
}

// Composite label for a row's competing entity — handles all
// three event types so the table doesn't need branches in the
// template. Individual → diver name. Synchro pair → "Lead &
// Partner". Team → team name (already in full_name from the
// server side).
function entityLabel(d) {
  if (d.partner_name) return `${d.full_name} & ${d.partner_name}`
  return d.full_name
}

// Per-judge cell lookup for the synchro sub-tables. The single-
// matrix branch uses index-aligned per_judge[idx]; the segmented
// branch picks judges by id (since each segment only includes a
// subset of the panel).
function perJudgeOf(diver, judge) {
  if (!diver || !judge) return null
  return diver.per_judge.find((p) => p.judge_id === judge.judge_id) || null
}

// Tooltip composer for a per-judge cell. v-tip renders \n as
// newlines (white-space: pre-line in src/styles/app.css).
function cellTip(diver, judge, pj) {
  if (!pj || pj.rank == null) return `J${judge.judge_number} — no score for this entity`
  const parts = []
  parts.push(`J${judge.judge_number}${judge.full_name ? ` — ${judge.full_name}` : ''}`)
  parts.push(`Would rank ${entityLabel(diver)} ${ordinal(pj.rank)}`)
  parts.push(`Hypothetical total: ${Number(pj.judge_total).toFixed(2)}`)
  if (isOutlier(pj, diver.actual_rank)) {
    const delta = Math.abs(pj.rank - diver.actual_rank)
    parts.push(`(differs from actual by ${delta} position${delta === 1 ? '' : 's'})`)
  }
  return parts.join('\n')
}

// Tooltip for the Actual column — explains it's the official total.
function actualTip(diver) {
  return `Official rank: ${ordinal(diver.actual_rank)}\n`
    + `Panel-trimmed total: ${Number(diver.actual_total).toFixed(2)}`
}

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

// URLs for the export buttons. The CSV / PDF endpoints share the
// same path prefix with .csv / .pdf suffixes — same convention as
// the existing /api/events/:id/results.csv / .pdf.
const csvHref = computed(() => `/api/events/${props.eventId}/judge-ranking-analysis.csv`)
const pdfHref = computed(() => `/api/events/${props.eventId}/judge-ranking-analysis.pdf`)
</script>

<template>
  <div class="jra-root">
    <div class="jra-header">
      <div class="jra-title-block">
        <div class="jra-title">Judge Ranking Analysis</div>
        <div class="jra-subtitle">
          Each column shows the rank each
          {{ eventType === 'team' ? 'team' :
             eventType === 'synchro_pair' ? 'pair' :
             'diver' }} would hold if every judge had scored
          unanimously like that one judge. Cells where a judge
          disagrees with the actual rank are tinted — pale cyan for
          a single-position swap, bright cyan for two or more.
        </div>
      </div>
      <div class="jra-actions" v-if="payloadView && !error">
        <a class="jra-btn" :href="csvHref" v-tip="'Download CSV'">CSV</a>
        <a class="jra-btn" :href="pdfHref" v-tip="'Download PDF'">PDF</a>
      </div>
    </div>

    <div v-if="loading" class="jra-skeleton" aria-live="polite">
      Loading judge ranking analysis…
    </div>

    <div v-else-if="error" class="jra-error">
      {{ error }}
    </div>

    <div v-else-if="!divers.length || !judges.length" class="jra-empty">
      No scored dives to analyse.
    </div>

    <!-- Synchro: three sub-tables, one per WA role group (Exec A
         / Exec B / Sync). Same-role judges only compared to
         same-role judges; each sub-table's "Actual" column is
         the rank derived from that role's totals alone. -->
    <template v-else-if="synchroSegments && synchroSegments.length">
      <div v-for="seg in synchroSegments" :key="seg.role"
           :class="['jra-segment', `jra-segment-${seg.role}`]">
        <div class="jra-segment-head">{{ seg.label }}</div>
        <div class="jra-scroll">
          <table class="jra-table">
            <thead>
              <tr>
                <th class="jra-th jra-th-diver">Pair</th>
                <th class="jra-th jra-th-actual"
                    v-tip="`Rank by this sub-panel's trimmed total — ${seg.label}`">Actual</th>
                <th v-for="j in seg.judges" :key="j.judge_id"
                    class="jra-th jra-th-judge"
                    v-tip="`J${j.judge_number} — ${j.full_name || ''}${j.country_code ? ' · ' + j.country_code : ''}`">
                  <span class="jra-judge-num">J{{ j.judge_number }}</span>
                  <span class="jra-judge-name">{{ j.full_name || '' }}</span>
                  <span v-if="j.country_code" class="jra-judge-cc">{{ j.country_code }}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in segmentRows(seg)"
                  :key="(row.diver.team_id || row.diver.competitor_id) + '-' + seg.role"
                  class="jra-row">
                <td class="jra-td jra-td-diver">
                  <div class="jra-diver-name">
                    <RouterLink v-if="row.diver.competitor_id"
                                :to="`/profile/${row.diver.competitor_id}`"
                                class="jra-diver-link">{{ row.diver.full_name }}</RouterLink>
                    <template v-if="row.diver.partner_name">
                      <span class="jra-diver-amp">&amp;</span>
                      <RouterLink v-if="row.diver.partner_id"
                                  :to="`/profile/${row.diver.partner_id}`"
                                  class="jra-diver-link">{{ row.diver.partner_name }}</RouterLink>
                      <template v-else>{{ row.diver.partner_name }}</template>
                    </template>
                    <span v-if="row.diver.country_code" class="jra-diver-cc">{{ row.diver.country_code }}</span>
                  </div>
                  <div v-if="row.diver.club_name" class="jra-diver-club">{{ row.diver.club_name }}</div>
                </td>
                <td class="jra-td jra-td-actual">
                  <span class="jra-actual-rank">{{ row.segment_actual_rank ?? '—' }}</span>
                  <span class="jra-actual-total">{{ Number(row.segment_actual_total || 0).toFixed(1) }}</span>
                </td>
                <td v-for="j in seg.judges" :key="j.judge_id"
                    :class="['jra-td', 'jra-td-cell',
                             outlierStrength(perJudgeOf(row.diver, j), row.segment_actual_rank ?? row.diver.actual_rank)]"
                    v-tip="cellTip(row.diver, j, perJudgeOf(row.diver, j))">
                  <span class="jra-cell-rank">{{ perJudgeOf(row.diver, j)?.rank ?? '—' }}</span>
                  <span v-if="perJudgeOf(row.diver, j)?.judge_total != null"
                        class="jra-cell-total">{{ Number(perJudgeOf(row.diver, j).judge_total).toFixed(1) }}</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <!-- Individual / team / synchro-without-recognised-panel —
         single matrix. -->
    <div v-else class="jra-scroll">
      <table class="jra-table">
        <thead>
          <tr>
            <th class="jra-th jra-th-diver">{{
              eventType === 'team' ? 'Team' :
              eventType === 'synchro_pair' ? 'Pair' : 'Diver'
            }}</th>
            <th class="jra-th jra-th-actual" v-tip="'Official panel-trimmed standings'">Actual</th>
            <th
              v-for="j in judges"
              :key="j.judge_id"
              class="jra-th jra-th-judge"
              v-tip="`J${j.judge_number} — ${j.full_name || ''}${j.country_code ? ' · ' + j.country_code : ''}`">
              <span class="jra-judge-num">J{{ j.judge_number }}</span>
              <span class="jra-judge-name">{{ j.full_name || '' }}</span>
              <span v-if="j.country_code" class="jra-judge-cc">{{ j.country_code }}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="d in (divers || [])"
              :key="d.team_id || d.competitor_id"
              class="jra-row">
            <td class="jra-td jra-td-diver">
              <div class="jra-diver-name">
                <RouterLink v-if="d.competitor_id && !d.team_id"
                            :to="`/profile/${d.competitor_id}`"
                            class="jra-diver-link">{{ d.full_name }}</RouterLink>
                <template v-else>{{ d.full_name }}</template>
                <template v-if="d.partner_name">
                  <span class="jra-diver-amp">&amp;</span>
                  <RouterLink v-if="d.partner_id"
                              :to="`/profile/${d.partner_id}`"
                              class="jra-diver-link">{{ d.partner_name }}</RouterLink>
                  <template v-else>{{ d.partner_name }}</template>
                </template>
                <span v-if="d.country_code" class="jra-diver-cc">{{ d.country_code }}</span>
              </div>
              <div v-if="d.club_name" class="jra-diver-club">{{ d.club_name }}</div>
            </td>
            <td class="jra-td jra-td-actual" v-tip="actualTip(d)">
              <span class="jra-actual-rank">{{ d.actual_rank }}</span>
              <span class="jra-actual-total">{{ Number(d.actual_total).toFixed(1) }}</span>
            </td>
            <td
              v-for="(pj, idx) in d.per_judge"
              :key="judges[idx]?.judge_id || idx"
              :class="['jra-td', 'jra-td-cell',
                       outlierStrength(pj, d.actual_rank)]"
              v-tip="cellTip(d, judges[idx], pj)">
              <span class="jra-cell-rank">{{ pj?.rank ?? '—' }}</span>
              <span v-if="pj?.judge_total != null"
                    class="jra-cell-total">{{ Number(pj.judge_total).toFixed(1) }}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.jra-root {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.jra-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.jra-title-block { display: flex; flex-direction: column; gap: 0.25rem; flex: 1 1 320px; }
.jra-title {
  font-family: var(--font-display, inherit);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--cyan, #06b6d4);
}
.jra-subtitle {
  font-size: 12px;
  color: var(--text-3, #94a3b8);
  line-height: 1.4;
  max-width: 60ch;
}
.jra-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
.jra-btn {
  font-family: var(--font-display, inherit);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 0.4rem 0.9rem;
  border-radius: var(--radius-sm, 4px);
  border: 1px solid rgba(6, 182, 212, 0.4);
  background: rgba(6, 182, 212, 0.08);
  color: var(--cyan, #06b6d4);
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}
.jra-btn:hover {
  background: var(--cyan, #06b6d4);
  color: var(--bg, #0f172a);
}
.jra-skeleton, .jra-error, .jra-empty {
  padding: 1rem;
  text-align: center;
  font-size: 13px;
  color: var(--text-3, #94a3b8);
  background: rgba(15, 23, 42, 0.4);
  border-radius: var(--radius-sm, 4px);
}
.jra-error { color: var(--amber, #f59e0b); }
.jra-scroll {
  /* Wide events (11-judge panels) overflow a narrow viewport;
     allow horizontal scroll rather than collapsing the table or
     wrapping cells unreadably. */
  overflow-x: auto;
  border: 1px solid rgba(148, 163, 184, 0.18);
  border-radius: var(--radius-sm, 4px);
}
.jra-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
.jra-th, .jra-td {
  padding: 0.5rem 0.6rem;
  text-align: center;
  vertical-align: middle;
  border-bottom: 1px solid rgba(148, 163, 184, 0.12);
}
.jra-th {
  font-family: var(--font-display, inherit);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--cyan, #06b6d4);
  background: rgba(15, 23, 42, 0.6);
  position: sticky;
  top: 0;
}
.jra-th-diver { text-align: start; min-width: 180px; }
.jra-th-actual { min-width: 70px; }
.jra-th-judge {
  display: table-cell;
  min-width: 56px;
  line-height: 1.2;
}
.jra-judge-num { display: block; color: var(--cyan, #06b6d4); font-size: 11px; }
.jra-judge-name {
  display: block;
  font-size: 9px;
  font-weight: 400;
  color: var(--text-3, #94a3b8);
  letter-spacing: 0.03em;
  text-transform: none;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12ch;
}
.jra-judge-cc {
  display: block;
  font-size: 9px;
  color: var(--text-4, #64748b);
  letter-spacing: 0.05em;
}
.jra-td-diver { text-align: start; }
.jra-diver-name {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
  font-weight: 600;
  color: var(--text-1, #f1f5f9);
}
.jra-diver-link { color: inherit; text-decoration: none; }
.jra-diver-link:hover { color: var(--cyan, #06b6d4); }
.jra-diver-cc {
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--text-3, #94a3b8);
}
.jra-diver-club {
  font-size: 10px;
  color: var(--text-4, #64748b);
  margin-top: 0.1rem;
}
.jra-td-actual {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: 0.4rem;
  font-weight: 600;
  color: var(--text-1, #f1f5f9);
}
.jra-actual-rank { font-size: 14px; }
.jra-actual-total {
  font-size: 10px;
  color: var(--text-3, #94a3b8);
  font-weight: 400;
}
.jra-td-cell {
  font-weight: 500;
  color: var(--text-2, #cbd5e1);
  cursor: default;
  /* Match the Actual column exactly: rank + total on the SAME
     baseline, total small + muted. The earlier two-line layout
     made the matrix feel busier than the standings panel
     beneath. Now the cells read like compact "rank (total)"
     pairs identical to the Actual column. */
  display: inline-flex;
  align-items: baseline;
  justify-content: center;
  gap: 0.35rem;
}
.jra-cell-rank {
  font-size: 14px;
  font-weight: 700;
  color: inherit;
}
.jra-cell-total {
  font-size: 10px;
  font-weight: 400;
  color: var(--text-3, #94a3b8);
}
/* Outliers: a pale tint for ±1 (a real-but-routine disagreement)
   and a brighter cyan for ≥2 (the kind that re-shuffles the
   podium). Both keep the rank legible — only the background
   changes weight. */
.jra-outlier-mild {
  background: rgba(6, 182, 212, 0.08);
  color: var(--cyan, #06b6d4);
}
.jra-outlier-strong {
  background: rgba(6, 182, 212, 0.20);
  color: var(--cyan, #06b6d4);
  font-weight: 700;
}
.jra-outlier-mild .jra-cell-total,
.jra-outlier-strong .jra-cell-total {
  color: rgba(6, 182, 212, 0.65);
}
.jra-diver-amp { color: var(--cyan, #06b6d4); margin: 0 0.2em; font-weight: 400; }

/* Synchro-segmented sub-tables. Each role gets its own card
   with a coloured heading so the viewer can scan the three
   sub-panels at a glance. */
.jra-segment {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  margin-bottom: 0.9rem;
}
.jra-segment-head {
  font-family: var(--font-display, inherit);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 0.4rem 0.6rem;
  border-inline-start: 3px solid var(--cyan, #06b6d4);
  background: rgba(6, 182, 212, 0.08);
  color: var(--text-1, #f1f5f9);
}
.jra-segment-a .jra-segment-head    { border-color: #c4b5fd; background: rgba(139, 92, 246, 0.10); color: #ddd6fe; }
.jra-segment-b .jra-segment-head    { border-color: #fbbf24; background: rgba(245, 158, 11, 0.10); color: #fde68a; }
.jra-segment-sync .jra-segment-head { border-color: #34d399; background: rgba(16, 185, 129, 0.10); color: #6ee7b7; }
.jra-row:hover .jra-td { background: rgba(148, 163, 184, 0.05); }
.jra-row:hover .jra-outlier-mild { background: rgba(6, 182, 212, 0.14); }
.jra-row:hover .jra-outlier-strong { background: rgba(6, 182, 212, 0.28); }

/* =========================================================
   Mobile — sticky pair column + tighter cells.

   The matrix has one column per judge (typically 5, 7, 9, or
   11), which can't all fit on a phone. With overflow-x: auto
   already in place, the table is horizontally scrollable —
   but if the user can't see the row label (pair / diver) while
   they scroll judges, the data is meaningless.

   Stick the first two columns (PAIR + ACTUAL) to the left
   edge so they stay visible while the user swipes through the
   judge columns. Same pattern Google Sheets / Numbers uses for
   wide spreadsheets on phones.
   ========================================================= */
@media (max-width: 720px) {
  /* CRITICAL: restore `display: table-cell` on the rank cells.
     Desktop uses `display: flex` / `inline-flex` on .jra-td-actual
     and .jra-td-cell to centre the rank + total pair on a single
     baseline. That worked at laptop widths but collides with the
     new `position: sticky` columns on phones — the flex td drops
     out of the table-row column flow and the four cells in a row
     end up stacked vertically inside one visual column.
     Switch the cells back to native table-cell layout on mobile
     and recreate the "rank + small muted total" inline pair with
     plain text-align + inline-block spans. */
  .jra-td-actual,
  .jra-td-cell {
    display: table-cell;
    text-align: center;
    vertical-align: middle;
  }
  .jra-actual-rank,
  .jra-cell-rank   { display: inline; margin-inline-end: 0.3rem; }
  .jra-actual-total,
  .jra-cell-total  { display: inline; }

  .jra-scroll {
    /* Hint at scrollable content with a subtle shadow on the
       right edge that fades as the user scrolls. */
    background-image:
      linear-gradient(to right, var(--surface, #0f172a) 30%, rgba(15, 23, 42, 0)),
      linear-gradient(to left,  var(--surface, #0f172a) 30%, rgba(15, 23, 42, 0)),
      linear-gradient(to right, rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0)),
      linear-gradient(to left,  rgba(0, 0, 0, 0.3), rgba(0, 0, 0, 0));
    background-position: left center, right center, left center, right center;
    background-repeat: no-repeat;
    background-color: var(--surface, #0f172a);
    background-size: 20px 100%, 20px 100%, 8px 100%, 8px 100%;
    background-attachment: local, local, scroll, scroll;
    -webkit-overflow-scrolling: touch;
  }
  .jra-table {
    font-size: 11px;
    /* border-collapse: collapse breaks `position: sticky` on
       table cells in Chrome and Safari (the sticky cells lose
       their borders and sometimes don't repaint on scroll).
       Switch to separate + zero spacing on mobile — visually
       identical, but sticky behaves. */
    border-collapse: separate;
    border-spacing: 0;
  }
  .jra-th, .jra-td {
    padding: 0.4rem 0.45rem;
    /* With border-collapse: separate we need to put the
       horizontal border on each cell rather than the table. */
    border-bottom: 1px solid rgba(148, 163, 184, 0.12);
  }

  /* Pair / diver column — pinned to the left edge so the row
     label is always visible during horizontal scroll. */
  .jra-th-diver,
  .jra-td-diver {
    position: sticky;
    inset-inline-start: 0;
    z-index: 2;
    background: var(--surface, #0f172a);
    min-width: 130px;
    max-width: 140px;
    box-shadow: 2px 0 6px rgba(0, 0, 0, 0.35);
  }
  /* Header row is also vertically sticky already; combine both
     sticky positions on the corner cell. */
  thead .jra-th-diver { z-index: 3; }

  /* ACTUAL column — pinned right after PAIR so the user sees
     both "who" and "official rank" before the per-judge cells.
     left value matches PAIR's min-width above. */
  .jra-th-actual,
  .jra-td-actual {
    position: sticky;
    inset-inline-start: 130px;
    z-index: 2;
    background: var(--surface, #0f172a);
    min-width: 54px;
    box-shadow: 2px 0 6px rgba(0, 0, 0, 0.35);
  }
  thead .jra-th-actual { z-index: 3; }

  /* Judge columns — give back some space taken by the wider
     pair column. */
  .jra-th-judge { min-width: 48px; }
  .jra-judge-name { font-size: 8px; max-width: 8ch; }
  .jra-judge-cc   { font-size: 8px; }
  .jra-judge-num  { font-size: 10px; }
  .jra-actual-rank { font-size: 12px; }
  .jra-actual-total,
  .jra-cell-total { font-size: 9px; }

  /* Tighten the pair name so it stays inside the 140px column.
     Names wrap rather than truncate — the user needs the full
     name visible to read the row. */
  .jra-diver-name {
    flex-wrap: wrap;
    gap: 0.2rem;
    font-size: 11px;
    line-height: 1.2;
  }
  .jra-diver-club { display: none; }
  .jra-diver-cc   { font-size: 9px; }
}

/* Even tighter on iPhone-SE class viewports — drop the pair
   column to 110px and pull ACTUAL in alongside. */
@media (max-width: 400px) {
  .jra-th-diver,
  .jra-td-diver { min-width: 110px; max-width: 120px; }
  .jra-th-actual,
  .jra-td-actual { inset-inline-start: 110px; min-width: 46px; }
}
</style>
