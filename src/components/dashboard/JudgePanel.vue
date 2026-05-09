<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  judgeEvents: { type: Array, default: () => [] },
  icons:       { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
    <div v-if="!judgeEvents.length" class="dashboard-panel-empty">
      <div class="empty-state-icon">⚖️</div>
      <div class="empty-state-title">No events assigned yet</div>
      <div class="empty-state-body">
        The meet manager will add you to a panel ahead of the next event.
        You'll see assignments here when that happens.
      </div>
    </div>

    <!-- Self-service Judge Analysis link — surfaces independently of
         live assignments so a judge can review their tracking
         between meets. The metrics on /judge-profile compare each
         award against the panel-kept mean (post World Aquatics trim,
         PART FOUR Article 13). -->
    <div class="panel-section">
      <div class="panel-section-label">Your tools</div>
      <RouterLink to="/judge-profile" class="judge-tool-row">
        <span class="judge-tool-icon">📊</span>
        <span class="judge-tool-text">
          <span class="judge-tool-title">Judge Analysis</span>
          <span class="judge-tool-desc">
            See how you track against the panel-kept mean — bias,
            drop rate, per-country / club / height / dive group.
          </span>
        </span>
        <span class="event-row-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>

    <div v-if="judgeEvents.length" class="panel-section">
      <div class="panel-section-label">Your assigned events</div>
      <RouterLink
        v-for="ev in judgeEvents"
        :key="ev.id"
        :to="`/judge?event=${ev.id}`"
        :class="['event-row', `event-row-${ev.status.toLowerCase()}`]"
      >
        <span :class="['event-row-status', `evrs-${ev.status.toLowerCase()}`]">
          {{ ev.status === 'Live' ? '🔴 LIVE' : ev.status === 'Upcoming' ? '📅' : '✓' }}
        </span>
        <span class="event-row-name">{{ ev.name }}</span>
        <span class="event-row-meta">
          {{ ev.total_rounds }} rounds · {{ ev.number_of_judges }} judges
        </span>
        <span class="event-row-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>
  </section>
</template>

<style scoped>
.judge-tool-row {
  display: grid;
  grid-template-columns: 32px 1fr 24px;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  background: var(--bg-2, #0f172a);
  border: 1px solid var(--border, rgba(148,163,184,0.18));
  border-radius: var(--radius);
  text-decoration: none;
  transition: all 0.15s;
}
.judge-tool-row:hover {
  border-color: var(--cyan, #06b6d4);
  background: rgba(6,182,212,0.06);
}
.judge-tool-icon { font-size: 22px; line-height: 1; }
.judge-tool-text { display: flex; flex-direction: column; gap: 0.15rem; min-width: 0; }
.judge-tool-title {
  font-family: var(--font-display); font-size: 13px; font-weight: 800;
  color: var(--text); letter-spacing: 0.05em;
}
.judge-tool-desc {
  font-family: var(--font-mono); font-size: 11px; color: var(--text-3);
  line-height: 1.35;
}
</style>
