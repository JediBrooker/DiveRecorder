<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  coachData: { type: Object, default: null },
  icons:     { type: Object, required: true },
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
    <div class="panel-section">
      <div class="panel-section-label">Go to</div>
      <div class="goto-grid">
        <RouterLink to="/coach" class="goto-tile tile-purple">
          <div class="goto-icon" v-html="icons.coach"></div>
          <div class="goto-title">Coach Dashboard</div>
        </RouterLink>
        <RouterLink to="/compare" class="goto-tile tile-amber">
          <div class="goto-icon" v-html="icons.compare"></div>
          <div class="goto-title">Compare Divers</div>
        </RouterLink>
      </div>
    </div>
  </section>
</template>
