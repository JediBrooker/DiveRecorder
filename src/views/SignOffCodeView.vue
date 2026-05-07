<script setup>
// Cut 3 of the referee sign-off plan — the page where a referee
// types the 6-digit handoff code the meet manager generated on
// their screen.
//
// The route is referee-only (router meta gate) but the credential
// is on the user's existing JWT — no separate auth dance. Server
// matches (target_referee_id = req.user.id, code) so a code
// generated for one referee can't be used by another.
//
// On success we patch the local notification banner (server fires
// the same referee_signoff_response broadcast as the push respond
// path, so any open Control Room tab updates too) and surface a
// "Signed off ✓" confirmation.
import { ref, computed } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const auth = useAuthStore()
const router = useRouter()

const code = ref('')
const busy = ref(false)
const errorMsg = ref('')
const successMsg = ref('')

const digits = computed(() => code.value.replace(/\D/g, '').slice(0, 6))

async function submit() {
  errorMsg.value = ''
  successMsg.value = ''
  if (digits.value.length !== 6) {
    errorMsg.value = 'Code must be 6 digits.'
    return
  }
  busy.value = true
  try {
    await auth.apiFetch('/api/sign-off/code/verify', {
      method: 'POST',
      body: JSON.stringify({ code: digits.value }),
    })
    successMsg.value = 'Signed off ✓ — the meet controller has been notified.'
    code.value = ''
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    busy.value = false
  }
}

function paste(text) {
  // Convenience for the pasted-from-meet-controller-screen case.
  // Strips anything non-digit and caps at 6 so a stray space or
  // dash doesn't confuse the input.
  code.value = String(text || '').replace(/\D/g, '').slice(0, 6)
}
</script>

<template>
  <div class="page-header">
    <h1 class="page-title">Sign-Off Code</h1>
    <RouterLink to="/dashboard" class="btn btn-ghost">← Dashboard</RouterLink>
  </div>

  <div class="main">
    <p class="page-sub">
      A meet controller has asked you to sign off on the dive order for an
      event. Read the 6-digit code from their screen and type it here. Codes
      expire 5 minutes after they're generated.
    </p>

    <form class="code-form" @submit.prevent="submit">
      <label class="code-label">Enter the 6-digit code</label>
      <input
        class="code-input"
        type="text"
        inputmode="numeric"
        autocomplete="one-time-code"
        maxlength="6"
        :value="digits"
        :disabled="busy || !!successMsg"
        autofocus
        placeholder="123456"
        @input="paste($event.target.value)">
      <button type="submit" class="btn btn-primary btn-lg"
              :disabled="busy || digits.length !== 6 || !!successMsg">
        {{ busy ? 'Verifying…' : 'Sign off' }}
      </button>

      <div v-if="errorMsg" class="msg msg-error">{{ errorMsg }}</div>
      <div v-if="successMsg" class="msg msg-success">{{ successMsg }}</div>
    </form>
  </div>
</template>

<style scoped>
.page-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1.5rem 2rem; border-bottom: 1px solid var(--border);
  max-width: 720px; margin: 0 auto;
}
.page-title { font-size: 32px; font-style: italic; }
.page-sub {
  max-width: 720px; margin: 0 auto; padding: 0 2rem;
  color: var(--text-3); font-size: 13px; line-height: 1.6;
}
.main {
  max-width: 720px; margin: 0 auto; padding: 1rem 2rem 3rem;
}
.code-form {
  display: flex; flex-direction: column; gap: 1rem;
  background: var(--bg-2); border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 2rem; margin-top: 1.5rem;
}
.code-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.18em; text-transform: uppercase; color: var(--text-3);
}
.code-input {
  font-family: var(--font-mono); font-size: 48px; font-weight: 700;
  letter-spacing: 0.25em; text-align: center;
  background: var(--bg); border: 1px solid var(--border);
  border-radius: 4px; padding: 1.2rem 0.5rem;
  color: var(--cyan);
}
.code-input:focus { outline: none; border-color: var(--cyan); }
.code-input:disabled { opacity: 0.6; }
.btn-lg { padding: 0.75rem 1rem; font-size: 14px; }
.msg {
  padding: 0.7rem 0.9rem; border-radius: 4px; font-size: 13px;
}
.msg-error {
  background: rgba(239, 68, 68, 0.08); color: var(--red);
  border: 1px solid rgba(239, 68, 68, 0.4);
}
.msg-success {
  background: rgba(16, 185, 129, 0.08); color: var(--green);
  border: 1px solid rgba(16, 185, 129, 0.4);
}
</style>
