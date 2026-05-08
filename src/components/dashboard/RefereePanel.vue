<script setup>
import { RouterLink } from 'vue-router'

defineProps({
  icons: { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
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
        </RouterLink>
      </div>
    </div>
  </section>
</template>
