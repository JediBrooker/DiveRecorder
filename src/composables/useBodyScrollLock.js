// Body-scroll-lock composable for modals.
//
// Why this exists:
//
//   iOS Safari does not respect `document.body.style.overflow =
//   'hidden'` reliably. With a fixed-position modal open, the
//   user can still drag on the backdrop area (or on the safe-area
//   gutter above a small modal) and the underlying page will
//   scroll behind it. When they close the modal, they're left in
//   a different scroll position than they started — disorienting
//   on a Dashboard that drifted ten event-rows during a confirm
//   dialog.
//
//   The robust pattern (used by react-bottom-sheet, body-scroll-
//   lock-upgrade, vant, naive-ui, etc.) is:
//
//     onLock:
//       1. Read the current window scrollY.
//       2. Set body { position: fixed; top: -scrollY; left: 0;
//                    right: 0; width: 100%; }
//       3. Body's content is now locked at the user's previous
//          position. Touches on the backdrop have nowhere to
//          scroll.
//     onUnlock:
//       1. Read back the saved scrollY.
//       2. Clear all the body styles we set.
//       3. window.scrollTo(0, scrollY) to restore the position.
//
//   This is iOS Safari's only reliable scroll-lock approach.
//   It works on every other browser too (Chrome / Firefox /
//   desktop Safari are all fine with the same pattern), so a
//   single code path covers all platforms.
//
// Reference counting:
//
//   Multiple modals can be open at once (e.g. a Confirm dialog
//   on top of an open Drawer). A naive boolean lock would unlock
//   the body when the *inner* modal closes, even if the outer
//   is still open. Instead we keep a counter: lock() increments,
//   unlock() decrements, the lock only releases when the counter
//   hits zero. Modals that never call unlock (component unmounts
//   without onClose firing) are handled by the auto-cleanup
//   onUnmounted hook returned by useBodyScrollLock().
//
// Usage:
//
//   import { useBodyScrollLock } from '@/composables/useBodyScrollLock'
//   const { lock, unlock } = useBodyScrollLock()
//   watch(isOpen, v => v ? lock() : unlock())
//   // OR, declaratively:
//   const { lockWhile } = useBodyScrollLock()
//   lockWhile(isOpen)
//
// SSR safety:
//
//   All DOM access is gated behind a `typeof document !==
//   'undefined'` check at module level. Vite's SSR pre-renders
//   would otherwise crash on import.

import { onUnmounted, watch } from 'vue'

// Module-level state. One lock counter for the whole app — the
// same body element is locked or it isn't.
let lockCount = 0
let savedScrollY = 0
// We stash the styles we OVERWRITE so the unlock can restore the
// original values (the body has its own design styles that we
// must not nuke). Only populated when transitioning from 0 -> 1.
let savedBodyStyles = null

function isBrowser() {
  return typeof document !== 'undefined' && typeof window !== 'undefined'
}

function applyLock() {
  // Only act on the 0 -> 1 transition. Nested locks are no-ops
  // at the DOM level; just bump the counter.
  if (!isBrowser()) return
  if (lockCount > 0) {
    lockCount++
    return
  }
  lockCount = 1

  savedScrollY = window.scrollY || window.pageYOffset || 0
  const body = document.body
  savedBodyStyles = {
    position: body.style.position,
    top:      body.style.top,
    left:     body.style.left,
    right:    body.style.right,
    width:    body.style.width,
    // Belt-and-braces: also pin overflow on the html element,
    // which catches the small number of layouts where body's
    // overflow isn't the scroll container.
    htmlOverflow: document.documentElement.style.overflow,
  }
  body.style.position = 'fixed'
  body.style.top      = `-${savedScrollY}px`
  body.style.left     = '0'
  body.style.right    = '0'
  body.style.width    = '100%'
  document.documentElement.style.overflow = 'hidden'
}

function applyUnlock() {
  if (!isBrowser()) return
  if (lockCount <= 0) {
    // Already unlocked. Don't underflow.
    return
  }
  lockCount--
  if (lockCount > 0) {
    // Outer modal still open. Leave the lock in place.
    return
  }

  // 1 -> 0 transition. Restore body + scroll.
  const body = document.body
  if (savedBodyStyles) {
    body.style.position = savedBodyStyles.position
    body.style.top      = savedBodyStyles.top
    body.style.left     = savedBodyStyles.left
    body.style.right    = savedBodyStyles.right
    body.style.width    = savedBodyStyles.width
    document.documentElement.style.overflow = savedBodyStyles.htmlOverflow
    savedBodyStyles = null
  }
  // Use scrollTo with the saved offset. window.scroll() would
  // animate on some browsers if scroll-behavior: smooth is set
  // globally — restore is supposed to be instant.
  window.scrollTo(0, savedScrollY)
}

/**
 * useBodyScrollLock — returns helpers and auto-cleans up on
 * component unmount. Safe to call without arguments; arguments
 * are sugar.
 *
 * @returns {{
 *   lock: () => void,
 *   unlock: () => void,
 *   lockWhile: (ref) => void,   // declarative wrapper around watch()
 * }}
 */
export function useBodyScrollLock() {
  // Per-instance counter so we can clean up exactly the locks
  // we placed, even if the component is torn down mid-modal.
  let instanceLocks = 0

  function lock() {
    instanceLocks++
    applyLock()
  }

  function unlock() {
    if (instanceLocks <= 0) return
    instanceLocks--
    applyUnlock()
  }

  function lockWhile(isOpen) {
    watch(isOpen, (v) => {
      if (v) lock()
      else unlock()
    }, { immediate: true })
  }

  // Belt-and-braces: if the component unmounts while it still
  // holds locks (e.g. router-pushed away with a modal open),
  // release them so the next page isn't frozen.
  onUnmounted(() => {
    while (instanceLocks > 0) unlock()
  })

  return { lock, unlock, lockWhile }
}

// Test-only exports — read internals to assert in unit tests.
// Not part of the public API; do not import from app code.
export const __internal = {
  getLockCount: () => lockCount,
  reset: () => {
    lockCount = 0
    savedScrollY = 0
    savedBodyStyles = null
  },
}
