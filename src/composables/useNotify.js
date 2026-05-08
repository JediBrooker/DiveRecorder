// Global toast / notify composable. One snackbar visible at a
// time at the bottom of the viewport — any view can fire one
// without prop-drilling.
//
// Three flavours of API:
//
//   1. Convenience wrappers for the common cases:
//
//        showSuccess('Roster imported — 12 divers added')
//        showError('Failed to save: network unreachable')
//        showInfo('Late entry added — Avery Ueno scheduled in Round 1')
//        showWarning('Entries close in 1 hour')
//
//   2. Action-bearing toast (e.g. an Undo / Retry / View button):
//
//        showNotify({
//          message: 'Withdrew Avery Ueno from this round.',
//          kind:    'info',
//          actionLabel: 'Undo',
//          onAction:    () => reinstateDiver(...),
//          timeoutMs:   8000,
//        })
//
//   3. Legacy showUndo() kept as a sugar over showNotify so the
//      withdraw / finalise call sites that already use it don't
//      change. See useUndo.js for the back-compat exports.
//
// The component (UndoBar.vue) reads the same shared ref this
// module writes to, so a single global render covers every
// caller.

import { ref } from 'vue'

// Shared reactive payload — one toast at a time. A second call
// preempts the first (its action handle is dropped).
const notifyState = ref(null)
let timeoutHandle = null

// Kind → default auto-dismiss in ms. Errors stick around longer
// because the operator may need to read them; success toasts
// fade quickly so they don't hang around after a quick action.
const DEFAULT_TIMEOUTS = {
  success: 3500,
  info:    5000,
  warn:    6500,
  error:   8000,
  danger:  8000,        // legacy alias for error
}

/**
 * Fire a toast.
 *
 * @param {object}   opts
 * @param {string}   opts.message     — human-facing text
 * @param {string}   [opts.kind]      — 'success' | 'info' | 'warn' | 'error'
 * @param {string}   [opts.actionLabel] — e.g. 'Undo', 'Retry', 'View'
 * @param {Function} [opts.onAction]  — handler for the action button
 * @param {number}   [opts.timeoutMs] — ms before auto-dismiss; 0 = sticky
 */
export function showNotify(opts = {}) {
  const message = opts.message
  if (!message) return
  const kind = normaliseKind(opts.kind)
  const timeoutMs = Number.isFinite(opts.timeoutMs)
    ? opts.timeoutMs
    : DEFAULT_TIMEOUTS[kind] ?? 5000

  // A new toast preempts whatever's currently showing.
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
    timeoutHandle = null
  }
  notifyState.value = {
    message,
    kind,
    actionLabel: opts.actionLabel || null,
    onAction:    typeof opts.onAction === 'function' ? opts.onAction : null,
    id:          Date.now(),
  }
  if (timeoutMs > 0) {
    timeoutHandle = setTimeout(dismissNotify, timeoutMs)
  }
}

export function dismissNotify() {
  if (timeoutHandle) {
    clearTimeout(timeoutHandle)
    timeoutHandle = null
  }
  notifyState.value = null
}

// Read-only handle for the renderer to subscribe to.
export function useNotifyState() {
  return notifyState
}

/**
 * Run the stored action handler then dismiss. Errors surface as
 * a fresh error toast so the operator notices instead of
 * silently losing the click.
 */
export async function fireAction() {
  const state = notifyState.value
  if (!state || !state.onAction) return
  // Optimistically dismiss first so the operator doesn't see a
  // stuck "running…" state if the handler is async.
  dismissNotify()
  try {
    await state.onAction()
  } catch (err) {
    showNotify({
      message: `${state.actionLabel || 'Action'} failed: ${err?.message || 'Unknown error'}`,
      kind:    'error',
      timeoutMs: 6000,
    })
  }
}

// ---- Convenience wrappers --------------------------------

export function showSuccess(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'success' })
}
export function showError(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'error' })
}
export function showInfo(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'info' })
}
export function showWarning(message, opts = {}) {
  showNotify({ ...opts, message, kind: 'warn' })
}

// ---- Internals -------------------------------------------

function normaliseKind(kind) {
  if (!kind) return 'info'
  if (kind === 'danger') return 'error' // legacy alias
  if (['success', 'info', 'warn', 'error'].includes(kind)) return kind
  return 'info'
}
