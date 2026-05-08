<script setup>
// Global notification stack lives at the app root so it floats
// over every route. The component itself is auth-aware — anonymous
// tabs get nothing, signed-in tabs see banners as the push engine
// fires.
import NotificationCenter from '@/components/NotificationCenter.vue'
// Global notify snackbar — single instance for the whole SPA.
// Any view fires showSuccess / showError / showInfo / showUndo
// from the composable; this renders. Used for async-action
// feedback (roster imported, score saved, …) and destructive
// actions with Undo (withdraw diver, finalise event, …).
import UndoBar from '@/components/UndoBar.vue'
// Global confirm modal — single instance. Replaces native
// window.confirm() with a styled modal that can spell out
// consequences. Any view calls confirmAction() from
// @/composables/useConfirm; this renders the dialog.
import ConfirmModal from '@/components/ConfirmModal.vue'
// Cmd-K command palette. Single global instance; opens on
// ⌘K / Ctrl-K from anywhere, or via window.__openCommandPalette()
// for header buttons that want a click-to-open affordance.
import CommandPalette from '@/components/CommandPalette.vue'
// First-login per-role tour. The setup wizard onboards fresh
// org admins; this fills the gap for the more common arrival
// path — a coach/judge/diver handed an invite. Auto-starts on
// the first dashboard mount per role; replay via Cmd-K.
import RoleTour from '@/components/RoleTour.vue'
</script>

<template>
  <RouterView />
  <NotificationCenter />
  <UndoBar />
  <ConfirmModal />
  <CommandPalette />
  <RoleTour />
</template>
