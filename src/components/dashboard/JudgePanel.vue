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
