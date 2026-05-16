<script setup>
import { ref, onMounted } from 'vue'
import { useRouter, useRoute, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const route = useRoute()
const auth = useAuthStore()

const username = ref('')
const password = ref('')
const errorMsg = ref('')
const loading = ref(false)

// Post-login destination — defaults to the dashboard, but if
// the router guard bounced the user here from a protected
// route we honour the `next` query param so they land where
// they were aiming. Validated as same-origin (must start with
// "/" and NOT "//", which would be a protocol-relative URL
// pointing at an attacker's host) so an attacker can't craft
// a /login?next=https://evil.example link via email and ride
// the legitimate session through.
function safeNextPath() {
  const raw = route.query.next
  if (typeof raw !== 'string' || !raw) return '/dashboard'
  // Reject anything that isn't a clean local path. Same-origin
  // check covers absolute URLs (http://…), protocol-relative
  // URLs (//evil.example), and javascript: schemes — every
  // attacker-controllable target starts with a non-"/" or with
  // "//".
  if (!raw.startsWith('/') || raw.startsWith('//')) return '/dashboard'
  return raw
}

onMounted(() => {
  if (auth.isLoggedIn) router.push(safeNextPath())
})

async function handleSubmit() {
  errorMsg.value = ''
  loading.value = true
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.value, password: password.value }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Login failed')
    auth.saveSession(data)
    router.push(safeNextPath())
  } catch (err) {
    errorMsg.value = err.message
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="login-wrap">
    <div class="login-mark">DIVING<span>HQ</span></div>
    <h1>Sign In</h1>
    <p class="subtitle">Official competition portal</p>

    <form @submit.prevent="handleSubmit" class="form-stack">
      <div class="field">
        <label class="label">Username</label>
        <input class="input" type="text" v-model="username" autocomplete="username" required>
      </div>
      <div class="field">
        <label class="label">Password</label>
        <input class="input" type="password" v-model="password" autocomplete="current-password" required>
      </div>
      <div v-if="errorMsg" class="msg msg-error">{{ errorMsg }}</div>
      <button type="submit" class="btn btn-primary-lg" style="margin-top:0.5rem" :disabled="loading">
        {{ loading ? 'Signing in...' : 'Sign In' }}
      </button>
    </form>

    <div class="footer-links">
      <RouterLink to="/forgot-password">Forgot your password? <span>Reset it</span></RouterLink>
      <RouterLink to="/register">No account? <span>Register here</span></RouterLink>
      <RouterLink to="/register-org">Registering a new federation? <span>Register your org</span></RouterLink>
      <!-- User guide link — many users land directly on /login
           and treat it as the home page; the guide link on the
           actual home (`/`) is invisible to them. Same target
           as the Home + Dashboard footer links. -->
      <RouterLink to="/guide">New here? <span>Read the user guide</span></RouterLink>
      <!-- Bug report — same pre-filled GitHub issue URL as the
           Home + Dashboard footers, with the `bug` label + a
           "Bug: " title prefix so reports land tagged without
           the reporter knowing the taxonomy. -->
      <a href="https://github.com/JediBrooker/DivingHQ/issues/new?labels=bug&title=Bug%3A%20"
         target="_blank"
         rel="noopener">Found a bug? <span>🐛 Report it on GitHub</span></a>
    </div>
  </div>
</template>

<style scoped>
:global(body) {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 100vh;
  padding: 1.5rem;
}
.login-wrap {
  width: 100%;
  max-width: 420px;
  animation: fadeUp 0.4s ease;
}
.login-mark {
  font-family: var(--font-display);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.3em;
  text-transform: uppercase;
  /* DIVING white, HQ cyan — match the public home page hero
     mark's colour rhythm. The cyan accent on HQ keeps the
     brand recognisable at a glance while the white DIVING
     reads cleanly against the dark page. */
  color: var(--text);
  margin-bottom: 2.5rem;
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.login-mark span { color: var(--cyan); }
.login-mark::before {
  content: '';
  display: block;
  width: 24px;
  height: 2px;
  background: var(--cyan);
}
h1 {
  font-size: 52px;
  color: var(--text);
  margin-bottom: 0.25rem;
  font-style: italic;
}
.subtitle {
  color: var(--text-3);
  font-size: 12px;
  letter-spacing: 0.15em;
  margin-bottom: 2.5rem;
  font-family: var(--font-display);
  font-weight: 600;
  text-transform: uppercase;
}
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.footer-links {
  margin-top: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  text-align: center;
}
.footer-links a {
  font-family: var(--font-display);
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--text-3);
  text-decoration: none;
  transition: color 0.15s;
}
.footer-links a:hover { color: var(--cyan); }
.footer-links a span { color: var(--cyan); }
</style>
