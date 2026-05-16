<script setup>
import { ref } from 'vue'
import { RouterLink } from 'vue-router'

// Step 1 of the password-reset flow. The server always responds
// 200 OK regardless of whether the email matches a real user
// (prevents account enumeration), so the success message here
// is intentionally vague: "if an account exists, we sent a link".

const email = ref('')
const sending = ref(false)
const sent = ref(false)
const error = ref('')

async function submit() {
  if (!email.value.trim()) {
    error.value = 'Enter the email address on your account'
    return
  }
  error.value = ''
  sending.value = true
  try {
    const r = await fetch('/api/auth/forgot-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.value.trim() }),
    })
    if (!r.ok) {
      const body = await r.json().catch(() => ({}))
      throw new Error(body.error || 'Request failed')
    }
    sent.value = true
  } catch (err) {
    error.value = err.message
  } finally {
    sending.value = false
  }
}
</script>

<template>
  <div class="reset-wrap">
    <div class="reset-mark">DIVING<span>HQ</span></div>
    <h1>Reset Password</h1>
    <p class="subtitle">We'll email you a link</p>

    <template v-if="sent">
      <div class="msg msg-success">
        If an account exists for that address, a reset link is on its way. The link expires in 30 minutes.
      </div>
      <RouterLink to="/login" class="btn btn-ghost btn-sm" style="margin-top:1.25rem">← Back to sign in</RouterLink>
    </template>

    <form v-else @submit.prevent="submit" class="form-stack">
      <div class="field">
        <label class="label">Account email</label>
        <input
          class="input"
          type="email"
          v-model="email"
          autocomplete="email"
          placeholder="you@example.com"
          required
        >
      </div>
      <div v-if="error" class="msg msg-error">{{ error }}</div>
      <button type="submit" class="btn btn-primary-lg" :disabled="sending" style="margin-top:0.5rem">
        {{ sending ? 'Sending…' : 'Send Reset Link' }}
      </button>
      <RouterLink to="/login" class="back-link">← Back to sign in</RouterLink>
    </form>
  </div>
</template>

<style scoped>
:global(body) {
  display: flex; align-items: center; justify-content: center;
  min-height: 100vh; padding: 1.5rem;
}
.reset-wrap { width: 100%; max-width: 420px; animation: fadeUp 0.4s ease; }
.reset-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center; gap: 0.75rem;
}
.reset-mark span { color: var(--cyan); }
.reset-mark::before {
  content: ''; display: block; width: 24px; height: 2px; background: var(--cyan);
}
h1 { font-size: 44px; color: var(--text); margin-bottom: 0.25rem; font-style: italic; }
.subtitle {
  color: var(--text-3); font-size: 12px; letter-spacing: 0.15em;
  margin-bottom: 2rem; font-family: var(--font-display);
  font-weight: 600; text-transform: uppercase;
}
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.back-link {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase; color: var(--text-3);
  text-decoration: none; text-align: center; margin-top: 0.5rem;
}
.back-link:hover { color: var(--cyan); }
</style>
