<script setup>
// Promise-based confirm modal. Single instance mounted at the
// top of App.vue. Reads from useConfirm's shared state; any
// view's confirmAction() call lands here.
//
// Replaces native window.confirm() — which can't render a
// rich consequences list, can't be styled, and trains
// operators to dismiss-by-instinct.
import { onBeforeUnmount, watch, nextTick, ref } from 'vue'
import { useConfirmState, resolveConfirm } from '@/composables/useConfirm'

const state = useConfirmState()
const confirmBtnRef = ref(null)

function onConfirm() { resolveConfirm(true) }
function onCancel()  { resolveConfirm(false) }

// Esc closes the modal as a cancel. Listener mounted only when
// a confirm is active so it doesn't fight other Esc handlers
// when dormant.
function onKey(e) {
  if (!state.value) return
  if (e.key === 'Escape') {
    e.preventDefault()
    onCancel()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    onConfirm()
  }
}

// Track when the modal opens so we can move keyboard focus to
// the primary button — Enter key then commits, matching native
// confirm() behaviour.
watch(state, async (next) => {
  if (next) {
    document.addEventListener('keydown', onKey)
    await nextTick()
    confirmBtnRef.value?.focus()
  } else {
    document.removeEventListener('keydown', onKey)
  }
})
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Transition name="confirm-modal">
    <div
      v-if="state"
      :key="state.id"
      class="confirm-backdrop"
      role="dialog"
      aria-modal="true"
      :aria-labelledby="`confirm-title-${state.id}`"
      @mousedown.self="onCancel"
    >
      <div class="confirm-modal" :class="`confirm-modal-${state.confirmKind}`">
        <div :id="`confirm-title-${state.id}`" class="confirm-title">
          {{ state.title }}
        </div>
        <p v-if="state.body" class="confirm-body">{{ state.body }}</p>
        <ul v-if="state.consequences.length" class="confirm-consequences">
          <li v-for="(c, i) in state.consequences" :key="i">{{ c }}</li>
        </ul>
        <div class="confirm-actions">
          <button
            type="button"
            class="confirm-btn confirm-btn-cancel"
            @click="onCancel"
          >{{ state.cancelLabel }}</button>
          <button
            ref="confirmBtnRef"
            type="button"
            :class="['confirm-btn', `confirm-btn-${state.confirmKind}`]"
            @click="onConfirm"
          >{{ state.confirmLabel }}</button>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.confirm-backdrop {
  position: fixed; inset: 0;
  z-index: 1100;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center;
  padding: 1.5rem;
}
.confirm-modal {
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-top: 4px solid var(--cyan);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.5);
  width: 100%; max-width: 460px;
  padding: 1.5rem 1.6rem 1.25rem;
  /* Defensive: clip any horizontal overflow from a long
     consequence line so the modal stays in-frame on narrow
     phones. */
  overflow-x: clip;
}
.confirm-modal-danger { border-top-color: var(--red); }
.confirm-modal-warn   { border-top-color: var(--amber); }

.confirm-title {
  font-family: var(--font-display);
  font-size: 16px; font-weight: 800; font-style: italic;
  letter-spacing: 0.04em; text-transform: uppercase;
  color: var(--text);
  margin-bottom: 0.6rem;
}
.confirm-body {
  font-family: var(--font-mono);
  font-size: 13px; line-height: 1.55;
  color: var(--text-2);
  margin: 0 0 0.85rem;
  white-space: pre-line;
}
.confirm-consequences {
  margin: 0 0 1.1rem;
  padding-inline-start: 1.1rem;
  font-family: var(--font-mono);
  font-size: 12px; line-height: 1.6;
  color: var(--text-3);
}
.confirm-consequences li { margin-bottom: 0.15rem; }

.confirm-actions {
  display: flex; justify-content: flex-end; gap: 0.55rem;
  margin-top: 0.8rem;
}
.confirm-btn {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase;
  padding: 0.55rem 1.1rem;
  border-radius: var(--radius-sm);
  border: 1px solid;
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.confirm-btn-cancel {
  background: transparent;
  color: var(--text-2);
  border-color: var(--border-2);
}
.confirm-btn-cancel:hover {
  background: var(--bg-3);
  color: var(--text);
}
.confirm-btn-primary {
  background: var(--cyan);
  color: var(--bg);
  border-color: var(--cyan);
}
.confirm-btn-primary:hover { filter: brightness(1.08); }
.confirm-btn-danger {
  background: var(--red);
  color: var(--bg);
  border-color: var(--red);
}
.confirm-btn-danger:hover { filter: brightness(1.08); }
.confirm-btn-warn {
  background: var(--amber);
  color: var(--bg);
  border-color: var(--amber);
}
.confirm-btn-warn:hover { filter: brightness(1.08); }
.confirm-btn:focus-visible {
  outline: 2px solid var(--cyan);
  outline-offset: 2px;
}

.confirm-modal-enter-active,
.confirm-modal-leave-active { transition: opacity 0.18s; }
.confirm-modal-enter-active .confirm-modal,
.confirm-modal-leave-active .confirm-modal {
  transition: transform 0.18s, opacity 0.18s;
}
.confirm-modal-enter-from,
.confirm-modal-leave-to { opacity: 0; }
.confirm-modal-enter-from .confirm-modal {
  transform: translateY(8px) scale(0.98); opacity: 0;
}
.confirm-modal-leave-to .confirm-modal {
  transform: translateY(0) scale(0.98); opacity: 0;
}
</style>
