<script setup>
// Floating notification banner — shows category-aware in-app
// banners regardless of system push permission. The composable
// (usePush) is the source of truth; this component renders + lets
// the user dismiss / act.
//
// Categories with action buttons (referee_signoff is the first;
// judge_call etc. will follow) wire those actions through to the
// component-defined handler map. Everything else renders as a
// passive "click to open" banner.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { usePush } from '@/composables/usePush'
import { useAuthStore } from '@/stores/auth'
import { useSocket } from '@/composables/useSocket'
import { showError } from '@/composables/useNotify'

const router = useRouter()
const auth = useAuthStore()

// One socket per logged-in tab — used for live notification
// receipt + the notification:ack emit. Anonymous tabs don't get
// a socket here (auth gate).
let socket = null
if (auth.isLoggedIn) {
  socket = useSocket()
}

const { notifications, ack } = usePush({ socket })

// Newest 3 in the floating banner stack — anything older lives
// in the inbox the user can open from the nav (future feature).
const visible = computed(() => notifications.value.slice(0, 3))

async function onActionClick(n, action) {
  // Approve / Deny on a referee sign-off banner. The endpoint is
  // category-specific so we dispatch by category.
  if (n.category === 'referee_signoff' && (action === 'approve' || action === 'deny')) {
    try {
      const eventId = n.data?.event_id
      const requestId = n.data?.request_id
      if (!eventId || !requestId) throw new Error('missing event/request')
      await auth.apiFetch(`/api/events/${eventId}/dive-order/sign-off/respond`, {
        method: 'POST',
        body: JSON.stringify({ request_id: requestId, decision: action }),
      })
      await ack(n.id)
    } catch (err) {
      showError(`Could not record ${action}: ${err.message}`)
    }
    return
  }
  // Generic: ack + open the action URL.
  await ack(n.id)
  if (n.action_url) router.push(n.action_url)
}

async function onBannerClick(n) {
  await ack(n.id)
  if (n.action_url) router.push(n.action_url)
}

async function onDismiss(n, ev) {
  ev.stopPropagation()
  await ack(n.id)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="visible.length" class="notif-stack">
      <div v-for="n in visible" :key="n.id"
           :class="['notif-card', `notif-${n.category}`]"
           @click="onBannerClick(n)">
        <button class="notif-dismiss" @click="onDismiss(n, $event)" v-tip="'Dismiss'">✕</button>
        <div class="notif-title">{{ n.title }}</div>
        <div v-if="n.body" class="notif-body">{{ n.body }}</div>
        <div v-if="Array.isArray(n.data?.actions) && n.data.actions.length" class="notif-actions">
          <button v-for="a in n.data.actions" :key="a.action"
                  :class="['notif-action', `notif-action-${a.action}`]"
                  @click.stop="onActionClick(n, a.action)">
            {{ a.title }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.notif-stack {
  position: fixed; inset-inline-end: 1.5rem; bottom: 1.5rem;
  display: flex; flex-direction: column; gap: 0.6rem;
  z-index: 9999; max-width: 360px;
  pointer-events: none;
}
.notif-card {
  pointer-events: auto;
  background: var(--surface, #1a1f2e);
  color: var(--text, #f1f5f9);
  border: 1px solid var(--border, #334155);
  border-inline-start: 4px solid var(--cyan, #06b6d4);
  border-radius: 8px;
  padding: 0.85rem 1rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
  position: relative;
  animation: notif-slide-in 0.25s ease-out;
}
.notif-card:hover { border-inline-start-color: var(--cyan, #06b6d4); }
.notif-referee_signoff { border-inline-start-color: var(--amber, #f59e0b); }
.notif-judge_call      { border-inline-start-color: var(--red, #ef4444); }
.notif-dismiss {
  position: absolute; top: 0.4rem; inset-inline-end: 0.5rem;
  background: transparent; border: none; cursor: pointer;
  font-size: 13px; color: var(--text-3, #64748b);
  padding: 0.2rem 0.4rem; line-height: 1;
}
.notif-dismiss:hover { color: var(--text, #f1f5f9); }
.notif-title {
  font-family: var(--font-display, sans-serif);
  font-weight: 800; font-style: italic;
  font-size: 14px; margin-bottom: 0.25rem; padding-inline-end: 1.5rem;
}
.notif-body {
  font-size: 12.5px; color: var(--text-2, #cbd5e1);
  line-height: 1.45;
}
.notif-actions {
  display: flex; gap: 0.4rem; margin-top: 0.7rem;
}
.notif-action {
  flex: 1; padding: 0.4rem 0.7rem;
  font-family: var(--font-display, sans-serif);
  font-weight: 700; font-size: 11.5px;
  letter-spacing: 0.06em; text-transform: uppercase;
  border-radius: 4px; border: 1px solid;
  cursor: pointer; transition: filter 0.15s ease;
}
.notif-action:hover { filter: brightness(1.1); }
.notif-action-approve {
  background: var(--green, #10b981); border-color: var(--green, #10b981);
  color: var(--bg, #0a0e1a);
}
.notif-action-deny {
  background: transparent; border-color: var(--red, #ef4444);
  color: var(--red, #ef4444);
}
@keyframes notif-slide-in {
  from { opacity: 0; transform: translateX(20px); }
  to   { opacity: 1; transform: translateX(0); }
}
</style>
