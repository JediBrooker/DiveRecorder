<script setup>
defineProps({
  // { length, kind: 'win' | 'podium' }. From analytics.streak.
  // The widget renders nothing when there's no active streak so
  // the dashboard doesn't show a "no streak" pity card.
  data: { type: Object, default: null },
})
</script>

<template>
  <div v-if="data?.length" class="card streak-card">
    <div class="card-head">Current Streak</div>
    <div class="streak-body">
      <div class="streak-num">{{ data.length }}</div>
      <div class="streak-meta">
        <div class="streak-kind">
          {{ data.kind === 'win' ? '🥇 Consecutive wins' : '🥉 Consecutive podiums' }}
        </div>
        <div class="streak-hint">From your most recent meet backwards.</div>
      </div>
    </div>
  </div>
</template>

<style src="./widget-shared.css"></style>
<style scoped>
.streak-card { background: linear-gradient(135deg, rgba(245,158,11,0.06), transparent); }
.streak-body { display: flex; align-items: center; gap: 1rem; }
.streak-num {
  font-family: var(--font-display); font-size: 56px; font-weight: 900;
  font-style: italic; color: var(--amber); line-height: 1;
}
.streak-meta { display: flex; flex-direction: column; gap: 0.25rem; }
.streak-kind {
  font-family: var(--font-display); font-size: 14px; font-weight: 700;
  color: var(--text); letter-spacing: 0.05em;
}
.streak-hint {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
}
@media print {
  .streak-num { color: #000 !important; }
}
</style>
