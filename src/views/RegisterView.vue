<script setup>
import { ref, onMounted, watch } from 'vue'
import { useRouter, RouterLink } from 'vue-router'

const router = useRouter()

const fullName = ref('')
const username = ref('')
const password = ref('')
const orgId = ref('')
const requestedRole = ref('')
const note = ref('')
const orgs = ref([])

// Club state — populated whenever an org is picked. The club
// dropdown has three modes: pick existing, "I want to create a
// new club", or leave empty (independent diver).
const clubs = ref([])
const clubChoice = ref('')           // '' | 'new' | <club_id>
const newClubName = ref('')
const newClubCode = ref('')

const msg = ref('')
const msgType = ref('')
const loading = ref(false)

onMounted(async () => {
  try {
    const res = await fetch('/api/orgs/active')
    orgs.value = await res.json()
  } catch { /* leave empty */ }
})

watch(orgId, async (id) => {
  // Reset club state whenever the user changes org
  clubs.value = []
  clubChoice.value = ''
  newClubName.value = ''
  newClubCode.value = ''
  if (!id) return
  try {
    const r = await fetch(`/api/orgs/${id}/clubs`)
    const body = await r.json()
    clubs.value = Array.isArray(body) ? body : []
  } catch {
    clubs.value = []
  }
})

async function handleSubmit() {
  msg.value = ''
  msgType.value = ''
  loading.value = true
  try {
    const body = {
      full_name: fullName.value,
      username: username.value,
      password: password.value,
      org_id: orgId.value,
    }
    if (requestedRole.value) body.requested_role = requestedRole.value
    if (note.value) body.note = note.value
    if (clubChoice.value === 'new' && newClubName.value.trim()) {
      body.new_club_name = newClubName.value.trim()
      if (newClubCode.value.trim()) body.new_club_short_code = newClubCode.value.trim()
    } else if (clubChoice.value && clubChoice.value !== 'new') {
      body.club_id = clubChoice.value
    }

    const res = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    msg.value = data.message
    msgType.value = 'success'
    setTimeout(() => router.push('/login'), 2500)
  } catch (err) {
    msg.value = err.message
    msgType.value = 'error'
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <div class="login-mark">Dive Recorder</div>
    <h1>Register</h1>
    <p class="subtitle">Create your account</p>

    <form @submit.prevent="handleSubmit" class="form-stack">
      <div class="field">
        <label class="label">Full Name</label>
        <input class="input" type="text" v-model="fullName" required>
      </div>
      <div class="field">
        <label class="label">Username</label>
        <input class="input" type="text" v-model="username" autocomplete="username" required>
      </div>
      <div class="field">
        <label class="label">Password</label>
        <input class="input" type="password" v-model="password" autocomplete="new-password" required>
      </div>
      <div class="field">
        <label class="label">Organisation</label>
        <select class="select" v-model="orgId" required>
          <option value="">— Select your organisation —</option>
          <option v-for="org in orgs" :key="org.id" :value="org.id">
            {{ org.name }}{{ org.country_code ? ` (${org.country_code})` : '' }}
          </option>
        </select>
      </div>

      <!-- Club — only meaningful once an org is picked. Lets you
           pick an existing club, create a new one inline, or skip. -->
      <div class="field" v-if="orgId">
        <label class="label">Club</label>
        <select class="select" v-model="clubChoice">
          <option value="">— No club / independent —</option>
          <option v-for="c in clubs" :key="c.id" :value="c.id">
            {{ c.name }}<template v-if="c.short_code"> ({{ c.short_code }})</template>
          </option>
          <option value="new">+ Create a new club</option>
        </select>
        <p v-if="!clubs.length && clubChoice !== 'new'" class="hint-line">
          No clubs registered for this org yet. You can create one above.
        </p>
      </div>

      <!-- Inline new-club form — only when "Create a new club" is picked -->
      <div v-if="orgId && clubChoice === 'new'" class="field new-club-block">
        <div class="field">
          <label class="label">New Club Name</label>
          <input class="input" type="text" v-model="newClubName" placeholder="e.g. Sydney Springboard" required>
        </div>
        <div class="field">
          <label class="label">Short Code (optional)</label>
          <input class="input" type="text" v-model="newClubCode" placeholder="e.g. SYD" maxlength="20">
        </div>
      </div>

      <div class="field">
        <label class="label">I want to register as</label>
        <select class="select" v-model="requestedRole">
          <option value="">Spectator (default)</option>
          <option value="diver">Diver</option>
          <option value="judge">Judge</option>
          <option value="referee">Referee</option>
          <option value="meet_manager">Meet Manager</option>
        </select>
      </div>
      <div class="field" v-if="requestedRole">
        <label class="label">Note to org admin (optional)</label>
        <input class="input" type="text" v-model="note" placeholder="e.g. I competed at nationals last year">
      </div>
      <p class="note">
        All accounts start as <strong style="color:var(--text)">Spectator</strong>. If you request a role above,
        your org admin will review and approve it. You'll be able to log in immediately.
      </p>
      <div v-if="msg" :class="['msg', msgType === 'success' ? 'msg-success' : 'msg-error']">{{ msg }}</div>
      <button type="submit" class="btn btn-primary-lg" style="margin-top:0.25rem" :disabled="loading">
        {{ loading ? 'Creating...' : 'Create Account' }}
      </button>
    </form>
    <p class="footer-link">Already have an account? <RouterLink to="/login">Sign in</RouterLink></p>
  </div>
</template>

<style scoped>
:global(body) { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
.wrap { width: 100%; max-width: 460px; animation: fadeUp 0.4s ease; }
.login-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 2.5rem; display: flex; align-items: center; gap: 0.75rem;
}
.login-mark::before { content: ''; display: block; width: 24px; height: 2px; background: var(--cyan); }
h1 { font-size: 48px; font-style: italic; margin-bottom: 0.25rem; }
.subtitle { color: var(--text-3); font-size: 12px; letter-spacing: 0.15em; margin-bottom: 2.5rem; font-family: var(--font-display); font-weight: 600; text-transform: uppercase; }
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.footer-link { margin-top: 1.5rem; text-align: center; font-family: var(--font-display); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3); }
.footer-link a { color: var(--cyan); text-decoration: none; }
.note { font-size: 11px; color: var(--text-3); line-height: 1.6; padding: 0.75rem; background: var(--bg-3); border-radius: var(--radius-sm); border: 1px solid var(--border); }
.hint-line { margin-top: 0.4rem; font-size: 11px; color: var(--text-3); font-family: var(--font-mono); }
.new-club-block {
  display: flex; flex-direction: column; gap: 0.75rem;
  padding: 0.85rem;
  border: 1px dashed var(--cyan); border-radius: var(--radius-sm);
  background: var(--cyan-dim);
}
</style>
