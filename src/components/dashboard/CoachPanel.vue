<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  coachData:      { type: Object, default: null },
  coachWorkbench: { type: Object, default: null },
  icons:          { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
    <div v-if="!coachData?.divers?.length" class="dashboard-panel-empty">
      <div class="empty-state-icon">🎓</div>
      <div class="empty-state-title">No divers linked yet</div>
      <div class="empty-state-body">
        Ask your org admin to link you to the divers you mentor. Once approved
        you'll see their profiles, PBs, and analytics here.
      </div>
    </div>
    <div v-if="coachData?.divers?.length" class="panel-section">
      <div class="panel-section-label">Your divers ({{ coachData.divers.length }})</div>
      <p class="panel-blurb">Open the Coach Dashboard for full per-diver analytics, score trends, and templates.</p>
    </div>

    <div v-if="coachWorkbench?.live?.length" class="panel-section">
      <div class="panel-section-label">Live squad</div>
      <RouterLink
        v-for="row in coachWorkbench.live.slice(0, 5)"
        :key="`live-${row.event_id}-${row.diver_id}`"
        :to="`/coach?event=${row.event_id}`"
        class="workflow-card workflow-card-live"
      >
        <span class="workflow-card-main">
          <span class="workflow-card-title">{{ row.diver_name }}</span>
          <span class="workflow-card-meta">{{ row.event_name }}</span>
        </span>
        <span class="workflow-card-count">Live</span>
      </RouterLink>
    </div>

    <div v-if="coachWorkbench?.incomplete_lists?.length || coachWorkbench?.closing_soon?.length" class="panel-section">
      <div class="panel-section-label">Dive list workbench</div>
      <RouterLink
        v-for="row in coachWorkbench.incomplete_lists.slice(0, 6)"
        :key="`missing-${row.event_id}-${row.diver_id}`"
        :to="`/coach?event=${row.event_id}`"
        class="workflow-card"
      >
        <span class="workflow-card-main">
          <span class="workflow-card-title">{{ row.diver_name }}</span>
          <span class="workflow-card-meta">
            {{ row.event_name }} · {{ row.rows_entered }}/{{ row.total_rounds }} rounds
          </span>
        </span>
        <span class="workflow-card-count">Fix list</span>
      </RouterLink>
      <RouterLink
        v-for="row in coachWorkbench.closing_soon.slice(0, 4)"
        :key="`closing-${row.event_id}-${row.diver_id}`"
        :to="`/coach?event=${row.event_id}`"
        class="workflow-card workflow-card-ready"
      >
        <span class="workflow-card-main">
          <span class="workflow-card-title">{{ row.diver_name }}</span>
          <span class="workflow-card-meta">{{ row.event_name }} · entries closing soon</span>
        </span>
        <span class="workflow-card-count">Review</span>
      </RouterLink>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Go to</div>
      <div class="goto-grid">
        <RouterLink to="/coach" class="goto-tile tile-purple">
          <div class="goto-icon" v-html="icons.coach"></div>
          <div class="goto-title">Coach Dashboard</div>
          <div class="goto-desc">Per-diver analytics, score trends, dive list templates.</div>
        </RouterLink>
        <RouterLink to="/compare" class="goto-tile tile-amber">
          <div class="goto-icon" v-html="icons.compare"></div>
          <div class="goto-title">Compare Divers</div>
          <div class="goto-desc">Two divers side-by-side — stats and PB diffs.</div>
        </RouterLink>
      </div>
    </div>
  </section>
</template>
