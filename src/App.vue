<script setup>
// Global notification stack lives at the app root so it floats
// over every route. The component itself is auth-aware — anonymous
// tabs get nothing, signed-in tabs see banners as the push engine
// fires.
import NotificationCenter from '@/components/NotificationCenter.vue'
// Global "undo snackbar" — single instance for the whole SPA.
// Any view fires showUndo() from the composable; this renders.
// Used by destructive actions (withdraw diver, delete club /
// team / event, finalise event) so a misclick is one Undo
// click away from being reversed without an admin's help.
import UndoBar from '@/components/UndoBar.vue'
</script>

<template>
  <RouterView />
  <NotificationCenter />
  <UndoBar />
</template>
