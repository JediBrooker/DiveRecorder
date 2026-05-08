// Tiny global "undo snackbar" composable. Lets any action in
// the SPA fire a confirmation toast with an Undo button:
//
//   import { showUndo } from '@/composables/useUndo'
//   await deleteThing()
//   showUndo({
//     message: 'Deleted "Capital Diving Club".',
//     onUndo:  () => restoreThing(),
//   })
//
// One snackbar visible at a time — calling showUndo() while one
// is already open replaces it (the old one's undo handle is
// dropped). Auto-dismisses after timeoutMs (default 8s); the
// user can also dismiss manually via the ✕.
//
// The component (UndoBar.vue) is rendered once at the top of
// App.vue and reads from the same shared ref this composable
// writes to, so any view's call lands on the same snackbar
// without prop-drilling.

import { ref } from 'vue'

// Shared reactive state — single snackbar at a time.
const undoState = ref(null)
let timeoutHandle = null

export function showUndo({ message, onUndo, timeoutMs = 8000, kind = 'info' } = {}) {
  if (!message) return
  // Clear any pending auto-dismiss; a new toast preempts the old.
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
    timeoutHandle = null
  }
  undoState.value = {
    message,
    onUndo: typeof onUndo === 'function' ? onUndo : null,
    kind,                  // 'info' | 'danger' for visual tint
    id: Date.now(),        // re-trigger animation if same message fires twice
  }
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(dismissUndo, timeoutMs)
  }
}

export function dismissUndo() {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
    timeoutHandle = null
  }
  undoState.value = null
}

// Read-only handle for the UndoBar component to render from.
// Returned as a ref so the consumer can use `.value`.
export function useUndoState() {
  return undoState
}

// Trigger the stored callback then dismiss. Any error is caught
// + surfaced as a fresh "Undo failed" snackbar so the operator
// notices instead of silently losing their attempt.
export async function fireUndo() {
  const state = undoState.value
  if (!state || !state.onUndo) return
  // Optimistically dismiss the toast first so the operator
  // doesn't see "undoing…" double-state.
  dismissUndo()
  try {
    await state.onUndo()
  } catch (err) {
    showUndo({
      message: `Undo failed: ${err?.message || 'Unknown error'}`,
      kind: 'danger',
      timeoutMs: 6000,
    })
  }
}
