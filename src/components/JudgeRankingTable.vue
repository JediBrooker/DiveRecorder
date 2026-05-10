<script setup>
/* JudgeRankingTable — "what would the standings have been if every
 * judge had scored unanimously like one specific judge?"
 *
 * For a Completed event, renders a matrix:
 *   rows    = divers, ordered by their ACTUAL panel-trimmed rank
 *   columns = Actual rank + total, followed by one column per judge
 *   cells   = the diver's rank under that judge's hypothetical
 *             unanimous panel
 *
 * Outliers (a judge whose rank differs from actual by 2+ positions)
 * are highlighted in cyan so a viewer can scan the matrix and spot
 * the column that would have re-shuffled the podium. Hovering a cell
 * shows the underlying judge_total in a v-tip bubble.
 *
 * Data is loaded lazily on mount via
 * /api/events/:eventId/judge-ranking-analysis. The same payload
 * also carries `per_dive_ranks` which the parent (ScoreboardView)
 * uses for the chip-tooltip enhancement; we expose it via a
 * `loaded` event so the parent doesn't have to hit the endpoint a
 * second time.
 *
 * v1 individual-only. For synchro_pair / team events the API
 * returns 400; we render a friendly explanation instead of the
 * matrix.
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

// Highlight threshold — a judge column whose rank differs from the
// diver's actual rank by 2+ positions is flagged as an outlier.
// 1-rank disagreements happen all the time in tight fields; 2+
// would have meaningfully re-shuffled the standings.
function isOutlier(pj, actualRank) {
  if (pj?.rank == null) return false
  return Math.abs(pj.rank - actualRank) >= 2
}

// Tooltip composer for a per-judge cell. v-tip renders \n as
// newlines (white-space: pre-line in src/styles/app.css).
function cellTip(diver, judge, pj) {
  if (!pj || pj.rank == null) return `J${judge.judge_number} — no score for this diver`
  const parts = []
  parts.push(`J${judge.judge_number}${judge.full_name ? ` — ${judge.full_name}` : ''}`)
  parts.push(`Would rank ${diver.full_name} ${ordinal(pj.rank)}`)
  parts.push(`Hypothetical total: ${Number(pj.judge_total).toFixed(2)}`)
  if (isOutlier(pj, diver.actual_rank)) {
    parts.push(`(differs from actual rank by ${Math.abs(pj.rank - diver.actual_rank)})`)
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
          Each column shows the rank each diver would hold if every
          judge had scored unanimously like that one judge. Cyan
          cells differ from the actual rank by 2 or more positions.
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
          <tr v-for="d in divers" :key="d.competitor_id" class="jra-row">
            <td class="jra-td jra-td-diver">
              <div class="jra-diver-name">
                <RouterLink v-if="d.competitor_id"
                            :to="`/profile/${d.competitor_id}`"
                            class="jra-diver-link">{{ d.full_name }}</RouterLink>
                <template v-else>{{ d.full_name }}</template>
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
              :class="['jra-td', 'jra-td-cell', isOutlier(pj, d.actual_rank) ? 'jra-outlier' : '']"
              v-tip="cellTip(d, judges[idx], pj)">
              {{ pj?.rank ?? '—' }}
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
}
.jra-outlier {
  background: rgba(6, 182, 212, 0.15);
  color: var(--cyan, #06b6d4);
  font-weight: 700;
}
.jra-row:hover .jra-td { background: rgba(148, 163, 184, 0.05); }
.jra-row:hover .jra-outlier { background: rgba(6, 182, 212, 0.22); }
</style>
