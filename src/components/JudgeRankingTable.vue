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

const props = defineProps({
  eventId: { type: [String, Number], required: true },
})

const emit = defineEmits(['loaded'])

const loading = ref(false)
const error = ref('')
const payload = ref(null)

async function load() {
  if (!props.eventId) return
  loading.value = true
  error.value = ''
  try {
    const res = await fetch(`/api/events/${props.eventId}/judge-ranking-analysis`)
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `Failed (${res.status})`)
    }
    payload.value = await res.json()
    emit('loaded', payload.value)
  } catch (err) {
    error.value = err.message || 'Failed to load judge ranking analysis'
  } finally {
    loading.value = false
  }
}

onMounted(load)
watch(() => props.eventId, load)

const judges = computed(() => payload.value?.judges || [])
const divers = computed(() => payload.value?.divers || [])

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
          {{ payload?.event?.event_type === 'team' ? 'team' :
             payload?.event?.event_type === 'synchro_pair' ? 'pair' :
             'diver' }} would hold if every judge had scored
          unanimously like that one judge. Cells where a judge
          disagrees with the actual rank are tinted — pale cyan for
          a single-position swap, bright cyan for two or more.
        </div>
      </div>
      <div class="jra-actions" v-if="payload && !error">
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

    <div v-else class="jra-scroll">
      <table class="jra-table">
        <thead>
          <tr>
            <th class="jra-th jra-th-diver">Diver</th>
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
                <!-- Individual or synchro lead diver → /profile link.
                     Team rows have no individual to link to. -->
                <RouterLink v-if="d.competitor_id && !d.team_id"
                            :to="`/profile/${d.competitor_id}`"
                            class="jra-diver-link">{{ d.full_name }}</RouterLink>
                <template v-else>{{ d.full_name }}</template>
                <!-- Synchro partner — same chip style as the
                     existing scoreboard. -->
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
.jra-th-diver { text-align: left; min-width: 180px; }
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
.jra-td-diver { text-align: left; }
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
  /* Two-line layout: rank on top in display font, hypothetical
     total beneath in a smaller mono font. Centring both vertically
     keeps the row height predictable across wide events. */
  line-height: 1.1;
}
.jra-cell-rank {
  display: block;
  font-size: 14px;
  font-weight: 700;
  color: inherit;
}
.jra-cell-total {
  display: block;
  font-family: var(--font-mono, monospace);
  font-size: 9px;
  font-weight: 400;
  color: var(--text-3, #94a3b8);
  margin-top: 0.15rem;
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
.jra-row:hover .jra-td { background: rgba(148, 163, 184, 0.05); }
.jra-row:hover .jra-outlier-mild { background: rgba(6, 182, 212, 0.14); }
.jra-row:hover .jra-outlier-strong { background: rgba(6, 182, 212, 0.28); }
</style>
