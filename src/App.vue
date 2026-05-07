<script setup>
// Global notification stack lives at the app root so it floats
// over every route. The component itself is auth-aware — anonymous
// tabs get nothing, signed-in tabs see banners as the push engine
// fires.
import NotificationCenter from '@/components/NotificationCenter.vue'
</script>

<template>
  <RouterView />
  <NotificationCenter />
</template>
