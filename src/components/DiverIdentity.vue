<script setup>
// Shared identity block — renders a diver / synchro pair / team
// entrant the same way wherever it shows up in the SPA. Both
// the Control Room and the Scoreboard mount this on their
// history cards, Up Next tiles, standings rows, and active-
// diver hero blocks. Layout choices (typography size, padding,
// click affordances) come from the surrounding parent's CSS;
// this component is just the inner shape.
//
// Visual contract:
//   ┌────────────────────────────────────────────┐
//   │ {rank.}  Lead Diver Name              [TST] │
//   │          & Partner Name                    │   ← synchro
//   │             OR                             │
//   │          Team / Club secondary line         │   ← non-synchro
//   └────────────────────────────────────────────┘
//
// The affiliation chip pins to the top-right of the names
// column; the lead + partner stack equal-weight (synchro is
// two equal performers, not a hero with a sidekick); the
// secondary line dims a level (club / team affiliation, not a
// co-performer).
//
// Slots:
//   trailing — anything that should sit alongside the badge on
//              the right edge (a score total, a dive total
//              chip, etc.). Renders inside .di-trailing.
//
// Profile links: the SPA links lead and partner names through
// to /profile/<id> when their ids are passed in. Anonymous
// surfaces (e.g. score broadcast strip) just leave the props
// undefined and the names render as plain text.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { diverIdentity } from '@/composables/useDiverIdentity'

const props = defineProps({
  // Any "row" shape — roster row, history row, standings row,
  // active-diver socket payload — the composable handles the
  // field-name variance.
  row: { type: Object, default: () => ({}) },
  // Optional 1-based rank prefix shown in front of the lead
  // diver's name. null/undefined = no prefix.
  rank: { type: [Number, String], default: null },
  // Profile-link ids. When non-null and `linkProfiles` is true
  // the names render as RouterLinks to /profile/<id>.
  competitorId: { type: String, default: null },
  partnerId:    { type: String, default: null },
  linkProfiles: { type: Boolean, default: false },
})

const id = computed(() => diverIdentity(props.row))
</script>

<template>
  <div class="di-row">
    <div class="di-names">
      <div class="di-name di-name-lead">
        <span v-if="rank != null" class="di-rank">{{ rank }}.</span>
        <RouterLink
          v-if="linkProfiles && competitorId"
          :to="`/profile/${competitorId}`"
          class="di-link"
          @click.stop
        >{{ id.leadName }}</RouterLink>
        <template v-else>{{ id.leadName }}</template>
      </div>
      <div v-if="id.partnerName" class="di-name di-name-partner">
        <span class="di-amp">&amp;</span>
        <RouterLink
          v-if="linkProfiles && partnerId"
          :to="`/profile/${partnerId}`"
          class="di-link"
          @click.stop
        >{{ id.partnerName }}</RouterLink>
        <template v-else>{{ id.partnerName }}</template>
      </div>
      <div v-else-if="id.secondary" class="di-secondary">
        {{ id.secondary }}
      </div>
    </div>
    <!-- Right-side grouping. Badge first, then any trailing
         content the parent slotted in. align-self: start anchors
         the chip to the top of the names column even when a
         synchro pair pushes the names down to two lines. -->
    <div class="di-trailing">
      <span v-if="id.badge" class="di-badge">{{ id.badge }}</span>
      <slot name="trailing"></slot>
    </div>
  </div>
</template>

<style scoped>
.di-row {
  display: flex; align-items: flex-start; gap: 0.5rem;
  min-width: 0;
}
.di-names {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 0.05rem;
  line-height: 1.25;
}
/* Lead + partner share the same colour, weight, size — synchro
   pairs are two equal performers. The cyan ampersand still
   reads as a connector so the eye groups them as one entry. */
.di-name {
  font-family: var(--font-display); font-weight: 700;
  font-size: inherit; color: var(--text);
  word-break: break-word;
}
.di-rank {
  display: inline-block;
  margin-right: 0.25rem;
  color: var(--cyan);
  font-family: var(--font-mono); font-weight: 700;
}
.di-amp {
  color: var(--cyan); margin-right: 0.25em;
  font-weight: 400;
}
.di-link { color: inherit; text-decoration: none; }
.di-link:hover { text-decoration: underline; text-decoration-color: var(--cyan); }
/* Team / club secondary line — only shown for non-synchro rows
   (synchro uses partner-name for the second line instead). One
   step down in weight + colour because affiliation is metadata,
   not a co-performer. */
.di-secondary {
  font-family: var(--font-mono); font-size: 0.85em;
  color: var(--text-3); font-weight: 400;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.di-trailing {
  display: flex; align-items: center; gap: 0.4rem;
  flex-shrink: 0; align-self: flex-start;
}
.di-badge {
  font-family: var(--font-display); font-size: 0.75em; font-weight: 700;
  letter-spacing: 0.08em; color: var(--text-3);
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 3px; padding: 0.1rem 0.4rem;
  white-space: nowrap;
}
</style>
