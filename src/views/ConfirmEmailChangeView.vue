<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

// Step 2 of the email-change flow (Migration 044). The link in
// the verification email is /confirm-email-change?token=<64-hex>.
// We POST that token to /api/auth/confirm-email-change; the
// server hashes it, looks up the pending row, swaps users.email,
// clears the pending columns, and bumps token_version so every
// session (including this one, if the user is signed in on the
// new device) re-authenticates.
//
// We deliberately fire the POST automatically on mount so the
// user lands on a finished page. No password re-entry is needed
// here — proof-of-inbox-control IS the second factor, mirroring
// the registration-verification flow.

const route  = useRoute()
const router = useRouter()
const auth   = useAuthStore()

const token = computed(() => route.query.token || '')
const submitting = ref(true)
const done = ref(false)
const error = ref('')

async function confirm() {
  if (!token.value) {
    error.value = "This page needs to be opened from the link in your confirmation email."
    submitting.value = false
    return
  }
  try {
    const r = await fetch('/api/auth/confirm-email-change', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.value }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(body.error || 'Email change confirmation failed')
    done.value = true
    // Sign out locally — the server bumped token_version so the
    // current JWT is dead anyway. Best to drop it now so the next
    // navigation isn't a forced /login redirect from a 401.
    auth.clearSession()
    setTimeout(() => router.push('/login'), 2500)
  } catch (err) {
    error.value = err.message
  } finally {
    submitting.value = false
  }
}

onMounted(confirm)
</script>

<template>
  <div class="confirm-wrap">
    <div class="confirm-mark">Dive Recorder</div>
    <h1>Confirm Email</h1>
    <p class="subtitle">Verifying your new address</p>

    <template v-if="submitting">
      <div class="msg msg-info">Confirming…</div>
    </template>

    <template v-else-if="done">
      <div class="msg msg-success">
        Email updated. Redirecting you to sign in with the new address…
      </div>
    </template>

    <template v-else>
      <div class="msg msg-error">{{ error || 'Confirmation failed.' }}</div>
      <RouterLink to="/login" class="btn btn-ghost btn-sm" style="margin-top:1.25rem">
        Back to sign in
      </RouterLink>
    </template>
  </div>
</template>

<style scoped>
:global(body) {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh; padding: 1.5rem;
}
.confirm-wrap { width: 100%; max-width: 420px; animation: fadeUp 0.4s ease; }
.confirm-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 2.5rem; display: flex; align-items: center; gap: 0.75rem;
}
.confirm-mark::before {
  content: ''; display: block; width: 24px; height: 2px; background: var(--cyan);
}
h1 { font-size: 44px; color: var(--text); margin-bottom: 0.25rem; font-style: italic; }
.subtitle {
  color: var(--text-3); font-size: 12px; letter-spacing: 0.15em;
  margin-bottom: 2rem; font-family: var(--font-display);
  font-weight: 600; text-transform: uppercase;
}
</style>
