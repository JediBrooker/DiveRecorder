<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  refereeDesk: { type: Object, default: null },
  icons: { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
    <div v-if="refereeDesk?.pending_signoffs?.length" class="panel-section">
      <div class="panel-section-label">Waiting for you</div>
      <RouterLink
        v-for="req in refereeDesk.pending_signoffs"
        :key="req.request_id"
        :to="`/control?signoff_request=${req.request_id}`"
        class="workflow-card workflow-card-ready"
      >
        <span class="workflow-card-main">
          <span class="workflow-card-title">{{ req.event_name }}</span>
          <span class="workflow-card-meta">
            Sign off requested by {{ req.requested_by_name || 'meet manager' }}
          </span>
        </span>
        <span class="workflow-card-count">Sign off</span>
      </RouterLink>
    </div>

    <div v-if="refereeDesk?.live_events?.length" class="panel-section">
      <div class="panel-section-label">Live now</div>
      <RouterLink
        v-for="ev in refereeDesk.live_events"
        :key="ev.event_id"
        :to="`/control?event=${ev.event_id}`"
        class="event-row event-row-live"
      >
        <span class="event-row-status evrs-live">LIVE</span>
        <span class="event-row-name">{{ ev.event_name }}</span>
        <span class="event-row-meta">Open Control Room</span>
        <span class="event-row-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">As a referee</div>
      <p class="panel-blurb">
        Meet managers send sign-off requests to your device when their pre-meet
        workflow reaches the yellow Sign Off step. You can also enter a 6-digit
        handoff code on your own device via the link below.
      </p>
    </div>
    <div class="panel-section">
      <div class="panel-section-label">Go to</div>
      <div class="goto-grid">
        <RouterLink to="/sign-off-codes" class="goto-tile tile-amber">
          <div class="goto-icon" v-html="icons.signOff"></div>
          <div class="goto-title">Sign-Off Codes</div>
          <div class="goto-desc">Enter the meet manager's 6-digit handoff code to confirm Cut 3.</div>
        </RouterLink>
      </div>
    </div>
  </section>
</template>
