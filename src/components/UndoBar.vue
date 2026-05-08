<script setup>
// Global undo snackbar. Single instance mounted once at the
// top of App.vue. Reads from the shared composable's state ref
// so any view's call to showUndo() lands here without prop-
// drilling. See src/composables/useUndo.js for the API.
import { useUndoState, fireUndo, dismissUndo } from '@/composables/useUndo'

const state = useUndoState()
</script>

<template>
  <Transition name="undo-bar">
    <div
      v-if="state"
      :key="state.id"
      :class="['undo-bar', `undo-bar-${state.kind}`]"
      role="status"
      aria-live="polite"
    >
      <span class="undo-bar-message">{{ state.message }}</span>
      <button
        v-if="state.onUndo"
        class="undo-bar-action"
        @click="fireUndo"
        title="Reverse the last action"
      >Undo</button>
      <button
        class="undo-bar-close"
        @click="dismissUndo"
        title="Dismiss"
        aria-label="Dismiss"
      >✕</button>
    </div>
  </Transition>
</template>

<style scoped>
/* Bottom-centre snackbar — high z-index so it floats above
   modals and dropdowns, fixed to the viewport so it survives
   route changes inside the app shell. */
.undo-bar {
  position: fixed;
  left: 50%; bottom: 1.5rem;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex; align-items: center; gap: 0.85rem;
  padding: 0.7rem 1rem 0.7rem 1.1rem;
  background: var(--bg-2);
  border: 1px solid var(--border-2);
  border-radius: 999px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  font-family: var(--font-display);
  font-size: 12px; font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--text);
  max-width: calc(100vw - 2rem);
}
.undo-bar-danger { border-color: rgba(239, 68, 68, 0.5); }
.undo-bar-message {
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 60vw;
}
.undo-bar-action {
  background: transparent;
  border: 1px solid rgba(6, 182, 212, 0.5);
  color: var(--cyan);
  font-family: inherit; font-size: 11px; font-weight: 700;
  letter-spacing: 0.16em; text-transform: uppercase;
  padding: 0.3rem 0.85rem;
  border-radius: 999px; cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.undo-bar-action:hover { background: var(--cyan); color: var(--bg); }
.undo-bar-close {
  background: transparent; border: 0;
  color: var(--text-3); cursor: pointer;
  font-size: 14px; line-height: 1;
  padding: 0.2rem 0.4rem;
  transition: color 0.12s;
}
.undo-bar-close:hover { color: var(--text); }

.undo-bar-enter-active,
.undo-bar-leave-active {
  transition: opacity 0.18s, transform 0.18s;
}
.undo-bar-enter-from {
  opacity: 0;
  transform: translate(-50%, 12px);
}
.undo-bar-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
</style>
