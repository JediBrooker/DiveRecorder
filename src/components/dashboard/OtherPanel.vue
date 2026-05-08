<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  icons: { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
    <div class="panel-section">
      <div class="panel-section-label">Other surfaces</div>
      <div class="goto-grid">
        <RouterLink to="/scoreboard" class="goto-tile tile-red">
          <div class="goto-icon" v-html="icons.scoreboard"></div>
          <div class="goto-title">Scoreboard &amp; Results</div>
          <div class="goto-desc">Watch live meets or browse completed-meet recaps.</div>
        </RouterLink>
        <RouterLink to="/dive-directory" class="goto-tile tile-cyan">
          <div class="goto-icon" v-html="icons.diveDir"></div>
          <div class="goto-title">Dive Directory</div>
          <div class="goto-desc">Look up DDs across the World Aquatics catalog.</div>
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
