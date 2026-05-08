<script setup>
import { RouterLink } from 'vue-router'

const props = defineProps({
  operatorEvents: { type: Array, default: () => [] },
  fmtCloses:      { type: Function, required: true },
  icons:          { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
    <div v-if="!operatorEvents.length" class="dashboard-panel-empty">
      <div class="empty-state-icon">📅</div>
      <div class="empty-state-title">No events yet</div>
      <div class="empty-state-body">
        Build your first event in <strong>Meet Manager</strong>. The pre-meet
        workflow walks you through check-in, randomise, sign-off, and start.
      </div>
    </div>

    <div v-if="operatorEvents.length" class="panel-section">
      <div class="panel-section-label">Your events</div>
      <RouterLink
        v-for="ev in operatorEvents"
        :key="ev.id"
        :to="ev.status === 'Completed' ? `/scoreboard/${ev.id}` : `/control?event=${ev.id}`"
        :class="['event-row', `event-row-${ev.status.toLowerCase()}`]"
      >
        <span :class="['event-row-status', `evrs-${ev.status.toLowerCase()}`]">
          {{ ev.status === 'Live' ? '🔴 LIVE' : ev.status === 'Upcoming' ? '📅' : '✓' }}
        </span>
        <span class="event-row-name">{{ ev.name }}</span>
        <span v-if="ev.status === 'Upcoming' && ev.entries_close_at" class="event-row-meta">
          {{ fmtCloses(ev.entries_close_at) }}
        </span>
        <span v-else-if="ev.status === 'Completed'" class="event-row-meta">Completed</span>
        <span v-else-if="ev.status === 'Live'" class="event-row-meta">Open Control Room</span>
        <span class="event-row-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Go to</div>
      <div class="goto-grid">
        <RouterLink to="/manager" class="goto-tile tile-amber">
          <div class="goto-icon" v-html="icons.manager"></div>
          <div class="goto-title">Meet Manager</div>
        </RouterLink>
        <RouterLink to="/control" class="goto-tile tile-cyan">
          <div class="goto-icon" v-html="icons.control"></div>
          <div class="goto-title">Control Room</div>
        </RouterLink>
        <RouterLink to="/assign-judges" class="goto-tile tile-cyan">
          <div class="goto-icon" v-html="icons.judges"></div>
          <div class="goto-title">Assign Judges</div>
        </RouterLink>
      </div>
    </div>
  </section>
</template>
