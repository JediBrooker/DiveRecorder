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
</script>

<template>
  <RouterView />
  <NotificationCenter />
  <UndoBar />
  <ConfirmModal />
</template>
