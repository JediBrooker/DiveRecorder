<script setup>
// Notifications inbox.
//
// Until now, push notifications were transient — once a user
// dismissed the system toast (or had their phone off when one
// fired), it was gone. This view is the persistent record:
// every notification the push engine wrote to the
// `notifications` table for this user, sorted newest-first,
// with a "mark read" button.
//
// Backed by the existing endpoints:
//   GET  /api/notifications/me                  — list
//   POST /api/notifications/:id/acknowledge     — mark read
//
// Categories so far: signoff_request, role_decision,
// event_started, event_results_posted, generic. Each row
// carries a title + body + optional action_url; clicking the
// row opens action_url (in-app via RouterLink when local,
// otherwise window.open) AND marks the row acknowledged.
//
// Filter chips: All / Unread / By category. Pagination via
// ?since_id=<uuid>.
import { ref, computed, onMounted } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { showError, showSuccess } from '@/composables/useNotify'

const auth = useAuthStore()
const router = useRouter()

const rows         = ref([])
const loading      = ref(false)
const showRead     = ref(false)
const categoryFilter = ref('all')

async function load() {
  loading.value = true
  try {
    rows.value = await auth.apiFetch('/api/notifications/me?limit=100')
  } catch (err) {
    showError(`Failed to load inbox: ${err.message}`)
  } finally {
    loading.value = false
  }
}

const categories = computed(() => {
  const seen = new Map()
  for (const r of rows.value) {
    if (!seen.has(r.category)) seen.set(r.category, 0)
    seen.set(r.category, seen.get(r.category) + 1)
  }
  return [...seen.entries()].map(([cat, n]) => ({ id: cat, count: n }))
})

const filtered = computed(() => {
  let list = rows.value
  if (!showRead.value) {
    list = list.filter((r) => r.status !== 'acknowledged')
  }
  if (categoryFilter.value !== 'all') {
    list = list.filter((r) => r.category === categoryFilter.value)
  }
  return list
})

const unreadCount = computed(() =>
  rows.value.filter((r) => r.status !== 'acknowledged').length,
)

async function markRead(row) {
  if (row.status === 'acknowledged') return
  // Optimistic.
  row.status = 'acknowledged'
  row.acknowledged_at = new Date().toISOString()
  try {
    await auth.apiFetch(`/api/notifications/${row.id}/acknowledge`, { method: 'POST' })
  } catch {
    row.status = 'sent'
    row.acknowledged_at = null
    showError('Failed to mark as read')
  }
}

async function markAllRead() {
  const unread = rows.value.filter((r) => r.status !== 'acknowledged')
  if (!unread.length) return
  unread.forEach((r) => {
    r.status = 'acknowledged'
    r.acknowledged_at = new Date().toISOString()
  })
  try {
    await Promise.all(
      unread.map((r) =>
        auth.apiFetch(`/api/notifications/${r.id}/acknowledge`, { method: 'POST' }),
      ),
    )
    showSuccess(`Marked ${unread.length} notification${unread.length === 1 ? '' : 's'} read`)
  } catch {
    showError('Some acknowledgements failed — refresh to see latest state')
  }
}

function clickRow(row) {
  markRead(row)
  if (!row.action_url) return
  // Internal links use the router; external URLs open in a
  // new tab.
  if (row.action_url.startsWith('/')) {
    router.push(row.action_url)
  } else {
    window.open(row.action_url, '_blank', 'noopener')
  }
}

function fmtTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const ms = Date.now() - d.getTime()
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const dy = Math.round(hr / 24)
  if (dy < 7) return `${dy}d ago`
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function categoryLabel(cat) {
  const map = {
    signoff_request:        'Sign-off',
    role_decision:          'Role',
    role_request:           'Role request',
    event_started:          'Event',
    event_results_posted:   'Results',
    generic:                'Notice',
  }
  return map[cat] || cat
}

onMounted(load)
</script>

<template>
  <div class="inbox-wrap">
    <div class="page-header">
      <div>
        <div class="page-label">Inbox</div>
        <h1 class="page-title">Notifications</h1>
        <div class="page-sub">
          Every push notification + in-app banner sent to your account, kept
          for the retention window so a missed phone push isn't lost.
          <span v-if="unreadCount" class="page-sub-strong"> · {{ unreadCount }} unread</span>
        </div>
      </div>
      <div class="header-actions">
        <button v-if="unreadCount" type="button" class="btn btn-ghost btn-sm" @click="markAllRead">
          Mark all read
        </button>
        <RouterLink to="/dashboard" class="btn btn-ghost btn-sm">← Dashboard</RouterLink>
      </div>
    </div>

    <div class="filters">
      <div class="field-inline">
        <span class="filter-label">Show</span>
        <button type="button"
                :class="['chip', !showRead ? 'chip-active' : '']"
                @click="showRead = false">
          Unread <span class="chip-count">{{ unreadCount }}</span>
        </button>
        <button type="button"
                :class="['chip', showRead ? 'chip-active' : '']"
                @click="showRead = true">
          All <span class="chip-count">{{ rows.length }}</span>
        </button>
      </div>
      <div v-if="categories.length > 1" class="field-inline">
        <span class="filter-label">Category</span>
        <button type="button"
                :class="['chip', categoryFilter === 'all' ? 'chip-active' : '']"
                @click="categoryFilter = 'all'">
          All
        </button>
        <button v-for="c in categories" :key="c.id"
                type="button"
                :class="['chip', categoryFilter === c.id ? 'chip-active' : '']"
                @click="categoryFilter = c.id">
          {{ categoryLabel(c.id) }} <span class="chip-count">{{ c.count }}</span>
        </button>
      </div>
    </div>

    <div v-if="loading && !rows.length" class="empty">Loading…</div>
    <div v-else-if="!filtered.length" class="empty">
      <span v-if="!rows.length">Quiet across the board — no notifications yet.</span>
      <span v-else-if="!showRead && !unreadCount">All caught up — nothing unread.</span>
      <span v-else>No notifications match the current filters.</span>
    </div>

    <ul v-else class="inbox-list">
      <li v-for="r in filtered" :key="r.id"
          :class="['inbox-row', r.status === 'acknowledged' ? 'is-read' : '', r.action_url ? 'is-clickable' : '']"
          @click="clickRow(r)">
        <div class="inbox-row-bar" :data-cat="r.category"></div>
        <div class="inbox-row-body">
          <div class="inbox-row-head">
            <span class="inbox-row-cat">{{ categoryLabel(r.category) }}</span>
            <span class="inbox-row-time">{{ fmtTime(r.created_at) }}</span>
            <span v-if="r.status !== 'acknowledged'" class="inbox-unread-dot" aria-label="Unread"></span>
          </div>
          <div class="inbox-row-title">{{ r.title }}</div>
          <div v-if="r.body" class="inbox-row-text">{{ r.body }}</div>
          <div v-if="r.action_url" class="inbox-row-action">{{ r.action_url.startsWith('/') ? `Open ${r.action_url}` : 'Open' }} →</div>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.inbox-wrap { max-width: 900px; margin: 0 auto; padding: 2rem; }

.page-header {
  display: flex; align-items: flex-start; justify-content: space-between;
  margin-bottom: 1.5rem; padding-bottom: 1.5rem;
  border-bottom: 1px solid var(--border);
  gap: 1rem; flex-wrap: wrap;
}
.page-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.5rem;
}
.page-title {
  font-family: var(--font-display); font-size: 32px; font-weight: 900;
  font-style: italic; color: var(--text); line-height: 1;
}
.page-sub {
  font-family: var(--font-mono); font-size: 12px; color: var(--text-3);
  margin-top: 0.4rem; max-width: 640px;
}
.page-sub-strong { color: var(--cyan); font-weight: 700; }
.header-actions { display: flex; gap: 0.5rem; flex-wrap: wrap; }

.filters {
  display: flex; align-items: center; gap: 1.4rem; flex-wrap: wrap;
  margin-bottom: 1rem;
}
.field-inline { display: flex; align-items: center; gap: 0.4rem; }
.filter-label {
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--text-3);
}
.chip {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.4rem 0.75rem;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--text-3);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.chip:hover { color: var(--text-2); border-color: var(--border-2); }
.chip-active {
  background: var(--cyan-dim);
  color: var(--cyan);
  border-color: var(--cyan);
}
.chip-count {
  font-family: var(--font-mono); font-size: 10px;
  letter-spacing: 0;
  padding: 0.05rem 0.4rem;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
}

.empty {
  color: var(--text-3); padding: 3rem 0; text-align: center;
  font-family: var(--font-mono); font-size: 13px;
}

.inbox-list { list-style: none; margin: 0; padding: 0; }
.inbox-row {
  display: flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 0.6rem;
  overflow: hidden;
  transition: border-color 0.15s, transform 0.15s;
}
.inbox-row.is-clickable { cursor: pointer; }
.inbox-row.is-clickable:hover {
  border-color: var(--border-2);
  transform: translateX(2px);
}
.inbox-row.is-read .inbox-row-title,
.inbox-row.is-read .inbox-row-text {
  color: var(--text-3);
}
.inbox-row.is-read .inbox-row-cat { opacity: 0.6; }

.inbox-row-bar {
  flex-shrink: 0; width: 4px;
  background: var(--cyan);
}
.inbox-row-bar[data-cat="signoff_request"]      { background: var(--amber); }
.inbox-row-bar[data-cat="role_decision"]        { background: var(--green); }
.inbox-row-bar[data-cat="role_request"]         { background: #a78bfa; }
.inbox-row-bar[data-cat="event_started"]        { background: var(--red); }
.inbox-row-bar[data-cat="event_results_posted"] { background: var(--green); }

.inbox-row-body {
  flex: 1; min-width: 0;
  padding: 0.85rem 1.1rem;
  display: flex; flex-direction: column; gap: 0.25rem;
}
.inbox-row-head {
  display: flex; align-items: center; gap: 0.55rem;
  flex-wrap: wrap;
  font-family: var(--font-display); font-size: 10px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase;
  color: var(--text-3);
}
.inbox-row-cat { color: var(--cyan); }
.inbox-row-time {
  font-family: var(--font-mono); letter-spacing: 0.04em;
  text-transform: none; font-weight: 500; font-size: 11px;
}
.inbox-unread-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: var(--cyan);
  margin-left: auto;
}
.inbox-row-title {
  font-family: var(--font-display); font-size: 15px; font-weight: 800;
  font-style: italic; color: var(--text);
  letter-spacing: 0.02em;
}
.inbox-row-text {
  font-family: var(--font-mono); font-size: 13px; line-height: 1.5;
  color: var(--text-2);
}
.inbox-row-action {
  font-family: var(--font-mono); font-size: 11px;
  color: var(--cyan);
  margin-top: 0.2rem;
}
</style>
