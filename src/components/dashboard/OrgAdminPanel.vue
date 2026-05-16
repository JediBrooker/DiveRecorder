<script setup>
// Org Admin tab panel. Lifted out of DashboardView so the
// chunk loads only when the user activates this tab. Shared
// CSS lives in public/css/app.css (panel/, action-card/,
// activity-/ etc.).
import { RouterLink } from 'vue-router'

const props = defineProps({
  attentionCards:  { type: Array, default: () => [] },
  recentActivity:  { type: Array, default: () => [] },
  fmtRelative:     { type: Function, required: true },
  icons:           { type: Object, required: true },
})
</script>

<template>
  <section class="panel">
    <div v-if="!attentionCards.length && !recentActivity.length" class="dashboard-panel-empty">
      <div class="empty-state-icon">📊</div>
      <div class="empty-state-title">All quiet</div>
      <div class="empty-state-body">
        No live events, no upcoming meets within the entries-close window,
        and no role requests waiting. Use the GO TO links below to dive in.
      </div>
    </div>

    <div v-if="attentionCards.length" class="panel-section">
      <div class="panel-section-label">What needs your attention</div>
      <RouterLink
        v-for="card in attentionCards"
        :key="card.id"
        :to="card.to"
        :class="['action-card', `action-card-${card.kind}`]"
      >
        <span class="action-card-icon">{{ card.icon }}</span>
        <span class="action-card-title">{{ card.title }}</span>
        <span v-if="card.meta" class="action-card-meta">{{ card.meta }}</span>
        <span class="action-card-arrow" aria-hidden="true">→</span>
      </RouterLink>
    </div>

    <div v-if="recentActivity.length" class="panel-section">
      <div class="panel-section-label">Recent activity (7 days)</div>
      <ul class="activity-list">
        <li v-for="r in recentActivity" :key="`${r.kind}-${r.id}`" class="activity-item">
          <span class="activity-time">{{ fmtRelative(r.created_at) }}</span>
          <span class="activity-text">
            <template v-if="r.kind === 'score'">
              <strong>{{ r.competitor_name || 'Competitor' }}</strong>
              {{ r.action === 'update' ? 'score amended in' : r.action === 'delete' ? 'score deleted in' : 'score in' }}
              {{ r.event_name }}<template v-if="r.round_number"> · R{{ r.round_number }}</template>
            </template>
            <template v-else-if="r.kind === 'role'">
              <strong>{{ r.role }}</strong> {{ r.action }} {{ r.action === 'granted' ? 'to' : 'from' }} <strong>{{ r.target_name }}</strong>
            </template>
            <template v-else>
              <strong>{{ r.entity_name || r.entity_type }}</strong> · {{ r.action.replace(/^[a-z_]+\./, '').replace(/_/g, ' ') }}
            </template>
          </span>
        </li>
      </ul>
      <RouterLink to="/audit" class="panel-section-link">View full audit log →</RouterLink>
    </div>

    <div class="panel-section">
      <div class="panel-section-label">Go to</div>
      <div class="goto-grid">
        <RouterLink to="/manager" class="goto-tile tile-amber">
          <div class="goto-icon" v-html="icons.manager"></div>
          <div class="goto-title">Meet Manager</div>
          <div class="goto-desc">Create meets and events, set the panel, build rosters.</div>
        </RouterLink>
        <RouterLink to="/control" class="goto-tile tile-cyan">
          <div class="goto-icon" v-html="icons.control"></div>
          <div class="goto-title">Control Room</div>
          <div class="goto-desc">Drive scoring on the day — active diver, shot clock, holds.</div>
        </RouterLink>
        <RouterLink to="/users" class="goto-tile tile-purple">
          <div class="goto-icon" v-html="icons.users"></div>
          <div class="goto-title">User Manager</div>
          <div class="goto-desc">Grant roles, link coaches to divers, manage accounts.</div>
        </RouterLink>
        <RouterLink to="/audit" class="goto-tile tile-amber">
          <div class="goto-icon" v-html="icons.audit"></div>
          <div class="goto-title">Audit Log</div>
          <div class="goto-desc">Federation-wide activity — scores, role changes, edits.</div>
        </RouterLink>
        <RouterLink to="/clubs" class="goto-tile tile-green">
          <div class="goto-icon" v-html="icons.clubs"></div>
          <div class="goto-title">Clubs</div>
          <div class="goto-desc">Manage the clubs in your federation.</div>
        </RouterLink>
        <RouterLink to="/teams" class="goto-tile tile-purple">
          <div class="goto-icon" v-html="icons.teams"></div>
          <div class="goto-title">Teams</div>
          <div class="goto-desc">Set up team-event rosters and per-team dive lists.</div>
        </RouterLink>
        <RouterLink to="/assign-judges" class="goto-tile tile-cyan">
          <div class="goto-icon" v-html="icons.judges"></div>
          <div class="goto-title">Assign Judges</div>
          <div class="goto-desc">Seat panels onto events ahead of the meet.</div>
        </RouterLink>
      </div>
    </div>
  </section>
</template>
