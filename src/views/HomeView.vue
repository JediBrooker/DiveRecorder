<script setup>
import { onMounted } from 'vue'
import { useRouter, RouterLink } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import LocaleSwitcher from '@/components/LocaleSwitcher.vue'

const router = useRouter()
const auth = useAuthStore()

onMounted(() => {
  if (auth.isLoggedIn) router.push('/dashboard')
})
</script>

<template>
  <!-- Hero -->
  <section class="hero">
    <div class="hero-glow"></div>
    <!-- Top-right locale switcher. The chosen language is
         written to localStorage by setLocale() in src/i18n,
         so it carries to every other page automatically — both
         within the current SPA session (vue-i18n's locale ref is
         a global reactive) and across page reloads / sign-in. -->
    <div class="hero-locale">
      <LocaleSwitcher />
    </div>
    <div class="hero-mark">{{ $t('home.hero.mark') }}</div>
    <div class="hero-logo">DIVING<span>HQ</span></div>
    <p class="hero-tagline">{{ $t('home.hero.tagline') }}</p>
    <div class="hero-actions">
      <RouterLink to="/login" class="hero-btn-primary">{{ $t('home.hero.btn_sign_in') }}</RouterLink>
      <RouterLink to="/register" class="hero-btn-ghost">{{ $t('home.hero.btn_create_account') }}</RouterLink>
      <RouterLink to="/scoreboard" class="hero-btn-ghost">{{ $t('home.hero.btn_scoreboard') }}</RouterLink>
      <RouterLink to="/judges" class="hero-btn-ghost">{{ $t('home.hero.btn_judge_analysis') }}</RouterLink>
    </div>
    <!-- New-user primer link. Quiet by design — pitched to
         someone who's never seen the app and isn't sure where
         to start, without competing with the primary CTAs. -->
    <RouterLink to="/guide" class="hero-guide-link">
      {{ $t('home.hero.guide_link') }}
    </RouterLink>
  </section>

  <!-- Live strip -->
  <div class="live-strip">
    <div class="live-pill">{{ $t('home.live_strip.pill') }}</div>
    <span class="live-text">{{ $t('home.live_strip.text') }}</span>
    <RouterLink to="/scoreboard" class="btn btn-ghost btn-sm">{{ $t('home.live_strip.watch') }}</RouterLink>
  </div>

  <!-- Features -->
  <section class="features">
    <div class="section-label">{{ $t('home.features.section_label') }}</div>
    <div class="feature-grid">

      <div class="feat" style="border-color:rgba(16,185,129,0.15)">
        <div class="feat-icon" style="color:var(--green);background:var(--green-dim);border-color:rgba(16,185,129,0.25)">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2"/></svg>
        </div>
        <div class="feat-title">{{ $t('home.features.diver_portal_title') }}</div>
        <div class="feat-desc">{{ $t('home.features.diver_portal_desc') }}</div>
        <div class="feat-tags">
          <span class="feat-tag" style="color:var(--green);border-color:rgba(16,185,129,0.3);background:var(--green-dim)">{{ $t('role.diver') }}</span>
        </div>
      </div>

      <div class="feat" style="border-color:rgba(6,182,212,0.15)">
        <div class="feat-icon" style="color:var(--cyan);background:var(--cyan-dim);border-color:rgba(6,182,212,0.25)">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>
        </div>
        <div class="feat-title">{{ $t('home.features.control_room_title') }}</div>
        <div class="feat-desc">{{ $t('home.features.control_room_desc') }}</div>
        <div class="feat-tags">
          <span class="feat-tag" style="color:var(--red);border-color:rgba(239,68,68,0.3);background:var(--red-dim)">{{ $t('role.referee') }}</span>
          <span class="feat-tag" style="color:var(--amber);border-color:rgba(245,158,11,0.3);background:var(--amber-dim)">{{ $t('role.manager') }}</span>
        </div>
      </div>

      <div class="feat" style="border-color:rgba(6,182,212,0.15)">
        <div class="feat-icon" style="color:var(--cyan);background:var(--cyan-dim);border-color:rgba(6,182,212,0.25)">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z"/></svg>
        </div>
        <div class="feat-title">{{ $t('home.features.judge_terminal_title') }}</div>
        <div class="feat-desc">{{ $t('home.features.judge_terminal_desc') }}</div>
        <div class="feat-tags">
          <span class="feat-tag" style="color:var(--cyan);border-color:rgba(6,182,212,0.3);background:var(--cyan-dim)">{{ $t('role.judge') }}</span>
        </div>
      </div>

      <div class="feat" style="border-color:rgba(239,68,68,0.15)">
        <div class="feat-icon" style="color:var(--red);background:var(--red-dim);border-color:rgba(239,68,68,0.25)">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"/></svg>
        </div>
        <div class="feat-title">{{ $t('home.features.scoreboard_title') }}</div>
        <div class="feat-desc">{{ $t('home.features.scoreboard_desc') }}</div>
        <div class="feat-tags">
          <span class="feat-tag" style="color:var(--text-2);border-color:var(--border-2);background:var(--bg-3)">{{ $t('role.public') }}</span>
        </div>
      </div>

      <div class="feat" style="border-color:rgba(245,158,11,0.15)">
        <div class="feat-icon" style="color:var(--amber);background:var(--amber-dim);border-color:rgba(245,158,11,0.25)">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"/></svg>
        </div>
        <div class="feat-title">{{ $t('home.features.meet_manager_title') }}</div>
        <div class="feat-desc">{{ $t('home.features.meet_manager_desc') }}</div>
        <div class="feat-tags">
          <span class="feat-tag" style="color:var(--amber);border-color:rgba(245,158,11,0.3);background:var(--amber-dim)">{{ $t('role.manager') }}</span>
          <span class="feat-tag" style="color:#a78bfa;border-color:rgba(167,139,250,0.3);background:rgba(167,139,250,0.08)">{{ $t('role.admin') }}</span>
        </div>
      </div>

      <div class="feat" style="border-color:rgba(167,139,250,0.15)">
        <div class="feat-icon" style="color:#a78bfa;background:rgba(167,139,250,0.08);border-color:rgba(167,139,250,0.25)">
          <svg width="20" height="20" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z"/></svg>
        </div>
        <div class="feat-title">{{ $t('home.features.user_manager_title') }}</div>
        <div class="feat-desc">{{ $t('home.features.user_manager_desc') }}</div>
        <div class="feat-tags">
          <span class="feat-tag" style="color:#a78bfa;border-color:rgba(167,139,250,0.3);background:rgba(167,139,250,0.08)">{{ $t('role.admin') }}</span>
        </div>
      </div>

    </div>
  </section>

  <!-- How it works -->
  <section class="how">
    <div class="section-label">{{ $t('home.how.section_label') }}</div>
    <div class="how-steps">
      <div class="how-step">
        <div class="step-num">01</div>
        <div class="step-title">{{ $t('home.how.step01_title') }}</div>
        <div class="step-desc">{{ $t('home.how.step01_desc') }}</div>
      </div>
      <div class="how-step">
        <div class="step-num">02</div>
        <div class="step-title">{{ $t('home.how.step02_title') }}</div>
        <div class="step-desc">{{ $t('home.how.step02_desc') }}</div>
      </div>
      <div class="how-step">
        <div class="step-num">03</div>
        <div class="step-title">{{ $t('home.how.step03_title') }}</div>
        <div class="step-desc">{{ $t('home.how.step03_desc') }}</div>
      </div>
      <div class="how-step">
        <div class="step-num">04</div>
        <div class="step-title">{{ $t('home.how.step04_title') }}</div>
        <div class="step-desc">{{ $t('home.how.step04_desc') }}</div>
      </div>
    </div>
  </section>

  <!-- Footer -->
  <footer style="border-top:1px solid var(--border);padding:2rem;">
    <div style="max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:1rem">
      <RouterLink to="/" class="footer-logo">DIVING<span>HQ</span></RouterLink>
      <div class="footer-links">
        <RouterLink to="/login">{{ $t('home.footer.sign_in') }}</RouterLink>
        <RouterLink to="/register">{{ $t('home.footer.register') }}</RouterLink>
        <RouterLink to="/register-org">{{ $t('home.footer.register_federation') }}</RouterLink>
        <RouterLink to="/scoreboard">{{ $t('home.footer.scoreboard') }}</RouterLink>
        <!-- Plain-English new-user primer. Linked from both
             footer slots (home + dashboard) so a confused user
             always has the same entry point. -->
        <RouterLink to="/guide">{{ $t('home.footer.user_guide') }}</RouterLink>
        <!-- Public issue tracker. Pre-fills the title with
             "Bug:" + a bug label so the report lands tagged
             without the reporter having to know our taxonomy. -->
        <a href="https://github.com/JediBrooker/DivingHQ/issues/new?labels=bug&amp;title=Bug%3A%20"
           target="_blank"
           rel="noopener"
           class="footer-bug">{{ $t('home.footer.report_bug') }}</a>
      </div>
    </div>
  </footer>
</template>

<style scoped>
.hero {
  /* dvh: see LoginView for the iOS Safari rationale — the
     landing hero CTA buttons sit at the bottom on small
     phones and 100vh hides them under the address bar. */
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 6rem 2rem 4rem;
  position: relative;
  overflow: hidden;
}
.hero-locale {
  position: absolute;
  top: 1.25rem;
  inset-inline-end: 1.25rem;
  z-index: 2;
}
@media (max-width: 720px) {
  .hero-locale { top: 0.75rem; inset-inline-end: 0.75rem; }
}
.hero-glow {
  position: absolute;
  top: 40%;
  inset-inline-start: 50%;
  transform: translate(-50%, -50%);
  width: 800px;
  height: 600px;
  background: radial-gradient(ellipse, rgba(6,182,212,0.10) 0%, transparent 65%);
  pointer-events: none;
}
.hero-mark {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.4em;
  text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 2.5rem;
  display: flex;
  align-items: center;
  gap: 1rem;
  animation: fadeUp 0.5s ease both;
}
.hero-mark::before,
.hero-mark::after {
  content: '';
  display: block;
  width: 40px;
  height: 1px;
  background: var(--cyan);
  opacity: 0.4;
}
.hero-logo {
  font-family: var(--font-display);
  font-size: clamp(80px, 16vw, 168px);
  font-weight: 900;
  font-style: italic;
  line-height: 0.88;
  color: var(--text);
  margin-bottom: 2rem;
  animation: fadeUp 0.5s 0.05s ease both;
}
.hero-logo span { display: block; color: var(--cyan); }
.hero-tagline {
  font-family: var(--font-mono);
  font-size: clamp(13px, 2vw, 16px);
  color: var(--text-3);
  max-width: 560px;
  line-height: 1.75;
  margin-bottom: 3rem;
  animation: fadeUp 0.5s 0.1s ease both;
}
.hero-actions {
  display: flex;
  gap: 0.875rem;
  flex-wrap: wrap;
  justify-content: center;
  animation: fadeUp 0.5s 0.15s ease both;
}
.hero-guide-link {
  display: inline-block;
  margin-top: 1.25rem;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-3);
  text-decoration: none;
  border-bottom: 1px dashed transparent;
  transition: color 0.15s, border-color 0.15s;
  animation: fadeUp 0.5s 0.2s ease both;
}
.hero-guide-link:hover {
  color: var(--cyan);
  border-bottom-color: var(--cyan);
}
.hero-btn-primary {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  background: var(--cyan);
  color: var(--bg);
  padding: 1rem 2.25rem;
  border-radius: var(--radius-lg);
  text-decoration: none;
  transition: all 0.15s;
}
.hero-btn-primary:hover { background: #0891b2; box-shadow: var(--cyan-glow); }
.hero-btn-ghost {
  display: inline-flex;
  align-items: center;
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  background: transparent;
  color: var(--text-2);
  border: 1px solid var(--border);
  padding: 1rem 2.25rem;
  border-radius: var(--radius-lg);
  text-decoration: none;
  transition: all 0.15s;
}
.hero-btn-ghost:hover { border-color: var(--cyan); color: var(--cyan); }

.live-strip {
  background: var(--bg-2);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  padding: 1.25rem 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 1.25rem;
  flex-wrap: wrap;
}
.live-pill {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 900;
  letter-spacing: 0.2em;
  padding: 0.25rem 0.75rem;
  background: var(--red);
  color: white;
  border-radius: 4px;
  animation: pulse-red 2s infinite;
  flex-shrink: 0;
}
@keyframes pulse-red { 0%,100%{opacity:1} 50%{opacity:0.65} }
.live-text {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 600;
  color: var(--text-2);
}

.features {
  padding: 5rem 2rem 4rem;
  max-width: 1200px;
  margin: 0 auto;
}
.section-label {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.35em;
  text-transform: uppercase;
  color: var(--text-3);
  text-align: center;
  margin-bottom: 3rem;
}
.feature-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.25rem;
}
.feat {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 2rem;
  transition: border-color 0.2s, transform 0.2s;
}
.feat:hover { transform: translateY(-2px); }
.feat-icon {
  width: 44px;
  height: 44px;
  border-radius: var(--radius);
  border: 1px solid;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.5rem;
}
.feat-title {
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 900;
  font-style: italic;
  color: var(--text);
  margin-bottom: 0.5rem;
  line-height: 1;
}
.feat-desc {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.75;
  margin-bottom: 1.25rem;
}
.feat-tags { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.feat-tag {
  font-family: var(--font-display);
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  border: 1px solid;
}

.how {
  padding: 4rem 2rem 5rem;
  max-width: 900px;
  margin: 0 auto;
}
.how-steps {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 1.5rem;
  margin-top: 3rem;
}
.how-step {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.step-num {
  font-family: var(--font-display);
  font-size: 48px;
  font-weight: 900;
  font-style: italic;
  color: var(--border-2);
  line-height: 1;
}
.step-title {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
}
.step-desc {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-3);
  line-height: 1.7;
}

.footer-logo {
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 900;
  font-style: italic;
  /* DIVING white, HQ cyan — match the hero wordmark so the
     brand reads identically across the page. */
  color: var(--text);
  text-decoration: none;
}
.footer-logo span { color: var(--cyan); }
.footer-links {
  display: flex;
  gap: 1.5rem;
  flex-wrap: wrap;
}
.footer-links a {
  font-family: var(--font-display);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.15em;
  text-transform: uppercase;
  color: var(--text-3);
  text-decoration: none;
  transition: color 0.15s;
}
.footer-links a:hover { color: var(--cyan); }

/* ── Phone & small-tablet ───────────────────────────────────── */
@media (max-width: 720px) {
  .hero { padding: 4rem 1rem 2.5rem; min-height: auto; }
  .hero-glow { width: 100%; height: 400px; }
  .hero-mark { font-size: 10px; letter-spacing: 0.3em; margin-bottom: 1.25rem; gap: 0.6rem; }
  .hero-mark::before, .hero-mark::after { width: 24px; }
  .hero-logo  { margin-bottom: 1.25rem; }
  .hero-tagline { font-size: 13px; line-height: 1.65; margin-bottom: 1.75rem; padding: 0 0.5rem; }

  /* 4 buttons stacked at full padding push content off the
     fold — shrink them so two fit per row. */
  .hero-actions { gap: 0.5rem; }
  .hero-btn-primary,
  .hero-btn-ghost {
    font-size: 12px;
    padding: 0.7rem 1.1rem;
    border-radius: var(--radius);
  }

  .live-strip { padding: 1rem 1rem; gap: 0.75rem; }
  .live-text  { font-size: 13px; text-align: center; }

  .features { padding: 3rem 1rem 2.5rem; }
  .section-label { font-size: 10px; letter-spacing: 0.25em; margin-bottom: 1.5rem; }
  .feature-grid { grid-template-columns: 1fr; gap: 0.875rem; }
  .feat { padding: 1.25rem; border-radius: var(--radius-lg); }
  .feat-icon { width: 36px; height: 36px; margin-bottom: 1rem; }
  .feat-title { font-size: 20px; }
  .feat-desc  { font-size: 11.5px; line-height: 1.65; }

  .how { padding: 2.5rem 1rem 3rem; }
  .how-steps { grid-template-columns: 1fr; gap: 1.25rem; margin-top: 1.75rem; }
  .step-num { font-size: 36px; }
  .step-title { font-size: 16px; }

  .footer-links { gap: 0.875rem; }
  .footer-links a { font-size: 10px; letter-spacing: 0.12em; }
}
</style>
