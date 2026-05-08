// Promise-based confirm dialog composable. Replaces native
// window.confirm() with a styled modal that can:
//
//   - Show a richer body (consequences, side effects)
//   - Render a list of "what will happen" bullet points
//   - Configure the confirm button label + variant
//   - Be dismissed via Esc or outside-click
//
// Usage:
//
//   import { confirmAction } from '@/composables/useConfirm'
//
//   if (!await confirmAction({
//         title: 'Withdraw diver?',
//         body:  `Avery Ueno will be hidden from the active dive
//                  order. Their existing scores stay in the audit
//                  log + history.`,
//         consequences: [
//           'They will be skipped in subsequent rounds',
//           'Standings recompute without their scores',
//         ],
//         confirmLabel: 'Withdraw',
//         confirmKind:  'danger',     // 'primary' | 'danger' | 'warn'
//       })) return
//
// Single modal at a time — opening a second one while the first
// is open replaces it (the prior await rejects with 'preempted').

import { ref } from 'vue'

const confirmState = ref(null)
let pending = null      // { resolve, reject }

/**
 * Open a confirm modal. Resolves true if the user confirms,
 * false if they cancel / press Esc / click outside.
 *
 * @param {object}   opts
 * @param {string}   opts.title           — modal heading
 * @param {string}   [opts.body]          — descriptive paragraph
 * @param {string[]} [opts.consequences]  — bullet list of what'll happen
 * @param {string}   [opts.confirmLabel]  — primary button text
 * @param {string}   [opts.cancelLabel]   — cancel button text
 * @param {string}   [opts.confirmKind]   — 'primary' | 'danger' | 'warn'
 * @returns {Promise<boolean>}
 */
export function confirmAction(opts = {}) {
  // Preempt any open dialog — its awaiter resolves false so the
  // caller treats it as a cancel.
  if (pending) {
    try { pending.resolve(false) } catch { /* ignore */ }
    pending = null
  }
  return new Promise((resolve) => {
    pending = { resolve }
    confirmState.value = {
      title:        opts.title || 'Confirm',
      body:         opts.body || '',
      consequences: Array.isArray(opts.consequences) ? opts.consequences : [],
      confirmLabel: opts.confirmLabel || 'Confirm',
      cancelLabel:  opts.cancelLabel  || 'Cancel',
      confirmKind:  opts.confirmKind  || 'primary',
      id:           Date.now(),
    }
  })
}

export function useConfirmState() { return confirmState }

export function resolveConfirm(value) {
  const p = pending
  pending = null
  confirmState.value = null
  if (p) p.resolve(!!value)
}
