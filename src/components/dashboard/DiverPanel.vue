<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  diverNextMeet: { type: Object, default: null },
  /* The Live event (if any) — when present we render the
     meet-day CTA card at the top of the panel, deep-linking to
     /me/meet/:eventId. The endpoint 403s for divers who aren't
     entered, so this card hiding itself for non-entrants
     happens server-side rather than via a client predicate. */
  diverLiveMeet: { type: Object, default: null },
  fmtCloses:     { type: Function, required: true },
  icons:         { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
    <!-- Meet day card — visible whenever a Live event is on.
         The diver opens this from the warm-up area or the deck
         and gets a focused "next dive / rank / what to score"
         view that beats refreshing the public scoreboard. -->
    <div v-if="diverLiveMeet" class="panel-section">
      <div class="panel-section-label">Meet day · live now</div>
      <RouterLink :to="`/me/meet/${diverLiveMeet.id}`" class="diver-next-card md-cta">
        <div class="diver-next-name">{{ diverLiveMeet.name }}</div>
        <div class="diver-next-meta">
          Tap to see your next dive, current rank, and what you need to score
        </div>
        <div class="diver-next-arrow" aria-hidden="true">→</div>
      </RouterLink>
    </div>

    <div v-if="diverNextMeet" class="panel-section">
      <div class="panel-section-label">Your next meet</div>
      <RouterLink to="/competitor" class="diver-next-card">
        <div class="diver-next-name">{{ diverNextMeet.name }}</div>
        <div class="diver-next-meta">
          {{ fmtCloses(diverNextMeet.entries_close_at) || 'Walk through the dive list builder' }}
        </div>
        <div class="diver-next-arrow" aria-hidden="true">→</div>
      </RouterLink>
    </div>
    <div v-else-if="!diverLiveMeet" class="dashboard-panel-empty">
      <div class="empty-state-icon">🤿</div>
      <div class="empty-state-title">No upcoming meets</div>
      <div class="empty-state-body">
        When your federation lists an upcoming event, it'll show up here with
        an "entries close in" countdown. Open the Diver Portal to see all
        events your federation is running.
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Go to</div>
      <div class="goto-grid">
        <RouterLink to="/competitor" class="goto-tile tile-green">
          <div class="goto-icon" v-html="icons.diver"></div>
          <div class="goto-title">Submit Dive Sheets</div>
        </RouterLink>
        <RouterLink to="/profile" class="goto-tile tile-cyan">
          <div class="goto-icon" v-html="icons.profile"></div>
          <div class="goto-title">My Profile</div>
        </RouterLink>
        <RouterLink to="/compare" class="goto-tile tile-amber">
          <div class="goto-icon" v-html="icons.compare"></div>
          <div class="goto-title">Compare Divers</div>
        </RouterLink>
      </div>
    </div>
  </section>
</template>
