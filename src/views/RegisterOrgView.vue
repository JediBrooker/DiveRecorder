<script setup>
import { ref, watch } from 'vue'
import { RouterLink } from 'vue-router'

const orgName = ref('')
const countryCode = ref('')
const slug = ref('')
const fullName = ref('')
const username = ref('')
const password = ref('')
const msg = ref('')
const msgType = ref('')
const loading = ref(false)
const slugManuallyEdited = ref(false)

watch(orgName, (val) => {
  if (!slugManuallyEdited.value) {
    slug.value = val.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  }
})

function onSlugInput() {
  slugManuallyEdited.value = true
}

async function handleSubmit() {
  msg.value = ''
  msgType.value = ''
  loading.value = true
  try {
    const body = {
      org_name: orgName.value,
      slug: slug.value,
      full_name: fullName.value,
      username: username.value,
      password: password.value,
    }
    if (countryCode.value) body.country_code = countryCode.value.toUpperCase()

    const res = await fetch('/api/auth/register-org', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || 'Registration failed')
    msg.value = data.message
    msgType.value = 'success'
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
    <div class="login-mark">DIVING<span>HQ</span></div>
    <h1>Register Organisation</h1>
    <p class="subtitle">Get your federation on the platform</p>

    <form @submit.prevent="handleSubmit" class="form-stack">
      <div class="section">
        <div class="section-label">Organisation Details</div>
        <div class="field">
          <label class="label">Federation Name</label>
          <input class="input" type="text" v-model="orgName" placeholder="e.g. Swimming Australia" required>
        </div>
        <div class="grid-2">
          <div class="field">
            <label class="label">Country Code (ISO)</label>
            <input class="input" type="text" v-model="countryCode" placeholder="AUS" maxlength="3" style="text-transform:uppercase">
          </div>
          <div class="field">
            <label class="label">URL Slug</label>
            <input class="input" type="text" v-model="slug" @input="onSlugInput" placeholder="swimming-aus" required>
            <div class="slug-preview">divedmeet.com/org/<span>{{ slug || '—' }}</span></div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-label">Your Admin Account</div>
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
      </div>

      <p class="note">
        Your organisation will be reviewed and activated by a platform administrator before
        you can log in. You'll receive access once approved.
      </p>

      <div v-if="msg" :class="['msg', msgType === 'success' ? 'msg-success' : 'msg-error']">{{ msg }}</div>
      <button type="submit" class="btn btn-primary-lg" :disabled="loading">
        {{ loading ? 'Submitting...' : 'Submit Registration' }}
      </button>
    </form>
    <p class="footer-link">Already registered? <RouterLink to="/login">Sign in</RouterLink></p>
  </div>
</template>

<style scoped>
:global(body) { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 1.5rem; }
.wrap { width: 100%; max-width: 520px; animation: fadeUp 0.4s ease; }
.login-mark {
  font-family: var(--font-display); font-size: 13px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase; color: var(--text);
  margin-bottom: 2.5rem; display: flex; align-items: center; gap: 0.75rem;
}
.login-mark span { color: var(--cyan); }
.login-mark::before { content: ''; display: block; width: 24px; height: 2px; background: var(--cyan); }
h1 { font-size: 44px; font-style: italic; margin-bottom: 0.25rem; }
.subtitle { color: var(--text-3); font-size: 12px; letter-spacing: 0.15em; margin-bottom: 2.5rem; font-family: var(--font-display); font-weight: 600; text-transform: uppercase; }
.section-label {
  font-family: var(--font-display); font-size: 11px; font-weight: 700;
  letter-spacing: 0.2em; text-transform: uppercase; color: var(--cyan);
  margin-bottom: 0.75rem; padding-bottom: 0.5rem; border-bottom: 1px solid var(--border);
}
.form-stack { display: flex; flex-direction: column; gap: 1rem; }
.section { display: flex; flex-direction: column; gap: 1rem; margin-bottom: 1.5rem; }
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
.footer-link { margin-top: 1.5rem; text-align: center; font-family: var(--font-display); font-size: 12px; font-weight: 600; letter-spacing: 0.1em; text-transform: uppercase; color: var(--text-3); }
.footer-link a { color: var(--cyan); text-decoration: none; }
.note { font-size: 11px; color: var(--text-3); line-height: 1.6; padding: 0.75rem; background: var(--bg-3); border-radius: var(--radius-sm); border: 1px solid var(--border); }
.slug-preview { font-size: 11px; color: var(--text-3); margin-top: 0.25rem; font-family: var(--font-mono); }
.slug-preview span { color: var(--cyan); }
</style>
