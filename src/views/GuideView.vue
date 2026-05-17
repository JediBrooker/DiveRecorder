<script setup>
/* GuideView — `/guide`. A single-page, no-login, plain-English
 * primer for someone who just landed in the app and needs a
 * sketch of "what is this and how do I use it."
 *
 * Deliberately NOT a wiki replacement — the wiki at
 * https://github.com/JediBrooker/DivingHQ/wiki carries the
 * exhaustive material. This page is the 5-minute orientation
 * that gets a new user from "I have no idea where to click" to
 * "OK, I know which screen to open."
 *
 * Linked from:
 *   • Home (`/`) hero CTAs + footer
 *   • Dashboard (`/dashboard`) footer + top-menu link
 *   • Sign-in page footer
 *
 * Structure (matches the journey of a first-time user):
 *   1. What is DivingHQ?
 *   2. "I'm a …" — role-by-role cards
 *   3. Common first questions (FAQ-lite, 6 items)
 *   4. Where to go from here — link out to the full wiki
 *
 * i18n: all prose is `$t('guide.*')`. Strings containing
 * <strong> use v-html (translation source is trusted — only
 * our own locale files); strings containing in-app links use
 * <i18n-t> with named slots so the RouterLink is preserved
 * but the wording stays translatable.
 */
import { RouterLink } from 'vue-router'

const WIKI = 'https://github.com/JediBrooker/DivingHQ/wiki'
</script>

<template>
  <div class="guide-wrap">
    <!-- Top nav -->
    <div class="guide-nav">
      <RouterLink to="/" class="btn btn-ghost btn-sm">{{ $t('guide.back_to_home') }}</RouterLink>
      <a :href="WIKI" target="_blank" rel="noopener"
         class="btn btn-ghost btn-sm"
         v-tip="$t('guide.open_wiki_tip')">
        {{ $t('guide.open_wiki') }}
      </a>
    </div>

    <!-- Hero -->
    <section class="guide-hero">
      <div class="guide-eyebrow">{{ $t('guide.title') }}</div>
      <h1 class="guide-title">{{ $t('guide.hero_welcome_prefix') }}
        <span class="guide-title-brand">Diving<span>HQ</span></span>
      </h1>
      <p class="guide-lede">{{ $t('guide.hero_lede') }}</p>
    </section>

    <!-- "I'm a …" — role cards -->
    <section class="guide-section">
      <h2 class="guide-h2">{{ $t('guide.section_roles') }}</h2>

      <div class="guide-roles">
        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🏊</div>
          <h3 class="role-name">{{ $t('guide.role.diver.name') }}</h3>
          <p class="role-desc" v-html="$t('guide.role.diver.desc')"></p>
          <ol class="role-steps">
            <li v-html="$t('guide.role.diver.step_1')"></li>
            <li v-html="$t('guide.role.diver.step_2')"></li>
            <li v-html="$t('guide.role.diver.step_3')"></li>
            <li v-html="$t('guide.role.diver.step_4')"></li>
          </ol>
          <a :href="`${WIKI}/Diver-Portal`" target="_blank" rel="noopener"
             class="role-cta">{{ $t('guide.role.diver.cta') }}</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🧑‍⚖️</div>
          <h3 class="role-name">{{ $t('guide.role.judge.name') }}</h3>
          <p class="role-desc" v-html="$t('guide.role.judge.desc')"></p>
          <ol class="role-steps">
            <li v-html="$t('guide.role.judge.step_1')"></li>
            <li v-html="$t('guide.role.judge.step_2')"></li>
            <li v-html="$t('guide.role.judge.step_3')"></li>
            <li v-html="$t('guide.role.judge.step_4')"></li>
          </ol>
          <a :href="`${WIKI}/Judging`" target="_blank" rel="noopener"
             class="role-cta">{{ $t('guide.role.judge.cta') }}</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🎓</div>
          <h3 class="role-name">{{ $t('guide.role.coach.name') }}</h3>
          <p class="role-desc" v-html="$t('guide.role.coach.desc')"></p>
          <ol class="role-steps">
            <li v-html="$t('guide.role.coach.step_1')"></li>
            <li v-html="$t('guide.role.coach.step_2')"></li>
            <li v-html="$t('guide.role.coach.step_3')"></li>
            <li v-html="$t('guide.role.coach.step_4')"></li>
            <li v-html="$t('guide.role.coach.step_5')"></li>
          </ol>
          <a :href="`${WIKI}/Diver-Portal#coach-access`" target="_blank" rel="noopener"
             class="role-cta">{{ $t('guide.role.coach.cta') }}</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🎮</div>
          <h3 class="role-name">{{ $t('guide.role.meet_manager.name') }}</h3>
          <p class="role-desc" v-html="$t('guide.role.meet_manager.desc')"></p>
          <ol class="role-steps">
            <li v-html="$t('guide.role.meet_manager.step_1')"></li>
            <li v-html="$t('guide.role.meet_manager.step_2')"></li>
            <li v-html="$t('guide.role.meet_manager.step_3')"></li>
            <li v-html="$t('guide.role.meet_manager.step_4')"></li>
            <li v-html="$t('guide.role.meet_manager.step_5')"></li>
          </ol>
          <a :href="`${WIKI}/Running-a-Meet`" target="_blank" rel="noopener"
             class="role-cta">{{ $t('guide.role.meet_manager.cta') }}</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🏛️</div>
          <h3 class="role-name">{{ $t('guide.role.org_admin.name') }}</h3>
          <p class="role-desc" v-html="$t('guide.role.org_admin.desc')"></p>
          <ol class="role-steps">
            <i18n-t keypath="guide.role.org_admin.step_1" tag="li">
              <template #link>
                <RouterLink to="/register-org">/register-org</RouterLink>
              </template>
            </i18n-t>
            <li v-html="$t('guide.role.org_admin.step_2')"></li>
            <li v-html="$t('guide.role.org_admin.step_3')"></li>
            <li v-html="$t('guide.role.org_admin.step_4')"></li>
          </ol>
          <a :href="`${WIKI}/Quick-Start`" target="_blank" rel="noopener"
             class="role-cta">{{ $t('guide.role.org_admin.cta') }}</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🌐</div>
          <h3 class="role-name">{{ $t('guide.role.spectator.name') }}</h3>
          <p class="role-desc" v-html="$t('guide.role.spectator.desc')"></p>
          <ol class="role-steps">
            <i18n-t keypath="guide.role.spectator.step_1" tag="li">
              <template #link>
                <RouterLink to="/scoreboard">{{ $t('guide.role.spectator.step_1_link') }}</RouterLink>
              </template>
            </i18n-t>
            <li v-html="$t('guide.role.spectator.step_2')"></li>
            <li v-html="$t('guide.role.spectator.step_3')"></li>
            <li v-html="$t('guide.role.spectator.step_4')"></li>
          </ol>
          <a :href="`${WIKI}/Scoreboard`" target="_blank" rel="noopener"
             class="role-cta">{{ $t('guide.role.spectator.cta') }}</a>
        </article>
      </div>
    </section>

    <!-- FAQ-lite -->
    <section class="guide-section">
      <h2 class="guide-h2">{{ $t('guide.section_first_time') }}</h2>

      <dl class="guide-faq">
        <dt>{{ $t('guide.faq.register_q') }}</dt>
        <dd v-html="$t('guide.faq.register_a')"></dd>

        <dt>{{ $t('guide.faq.judge_device_q') }}</dt>
        <dd v-html="$t('guide.faq.judge_device_a')"></dd>

        <dt>{{ $t('guide.faq.scoring_q') }}</dt>
        <dd v-html="$t('guide.faq.scoring_a')"></dd>

        <dt>{{ $t('guide.faq.broadcast_q') }}</dt>
        <i18n-t keypath="guide.faq.broadcast_a" tag="dd">
          <template #broadcast_all_link>
            <RouterLink to="/broadcast/all">/broadcast/all</RouterLink>
          </template>
        </i18n-t>

        <dt>{{ $t('guide.faq.schedule_q') }}</dt>
        <dd v-html="$t('guide.faq.schedule_a')"></dd>

        <dt>{{ $t('guide.faq.bug_q') }}</dt>
        <dd v-html="$t('guide.faq.bug_a')"></dd>
      </dl>
    </section>

    <!-- Where to next -->
    <section class="guide-section guide-next">
      <h2 class="guide-h2">{{ $t('guide.section_finding') }}</h2>
      <i18n-t keypath="guide.next.lede" tag="p" class="guide-next-lede">
        <template #wiki_link>
          <a :href="WIKI" target="_blank" rel="noopener">{{ $t('guide.next.wiki_link_label') }}</a>
        </template>
      </i18n-t>
      <ul class="guide-next-list">
        <li>
          <a :href="`${WIKI}/Features`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_features') }}</a>
          — {{ $t('guide.next.bookmark_features_desc') }}
        </li>
        <li>
          <a :href="`${WIKI}/Quick-Start`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_quickstart') }}</a>
          — {{ $t('guide.next.bookmark_quickstart_desc') }}
        </li>
        <li>
          <a :href="`${WIKI}/Roles-and-Permissions`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_roles') }}</a>
          — {{ $t('guide.next.bookmark_roles_desc') }}
        </li>
        <li>
          <a :href="`${WIKI}/FAQ`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_faq') }}</a>
          — {{ $t('guide.next.bookmark_faq_desc') }}
        </li>
        <li>
          <a :href="`${WIKI}/Keyboard-Shortcuts`" target="_blank" rel="noopener">{{ $t('guide.next.bookmark_shortcuts') }}</a>
          — {{ $t('guide.next.bookmark_shortcuts_desc') }}
        </li>
      </ul>

      <div class="guide-cta-row">
        <RouterLink to="/register" class="btn btn-primary">{{ $t('guide.next.cta_register') }}</RouterLink>
        <RouterLink to="/scoreboard" class="btn btn-ghost">{{ $t('guide.next.cta_scoreboard') }}</RouterLink>
      </div>
    </section>
  </div>
</template>

<style scoped>
.guide-wrap {
  max-width: 980px;
  margin: 0 auto;
  padding: 2rem;
}
.guide-nav {
  display: flex; gap: 0.5rem; flex-wrap: wrap;
  margin-bottom: 1.5rem;
}

/* Hero */
.guide-hero {
  padding: 2.25rem 0 2.5rem;
  border-bottom: 1px solid var(--border);
  margin-bottom: 2.25rem;
}
.guide-eyebrow {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.3em; text-transform: uppercase;
  color: var(--cyan);
  margin-bottom: 0.75rem;
}
.guide-title {
  font-family: var(--font-display);
  font-size: clamp(32px, 5vw, 52px);
  font-weight: 900; font-style: italic;
  color: var(--text); line-height: 1.05;
  margin: 0 0 1rem;
}
/* "Welcome to DivingHQ" — the brand mark sits inside the
   sentence. Outer span is the bold-italic brand wrap; inner
   span splits HQ into cyan so the colour rhythm matches the
   home-page hero (DIVING white, HQ cyan). */
.guide-title-brand { color: var(--text); }
.guide-title-brand span { color: var(--cyan); }
.guide-lede {
  font-family: var(--font-mono);
  font-size: 14px; line-height: 1.7;
  color: var(--text-2);
  max-width: 680px;
  margin: 0;
}

.guide-section { margin-bottom: 2.75rem; }
.guide-h2 {
  font-family: var(--font-display);
  font-size: 20px; font-weight: 800; font-style: italic;
  color: var(--text);
  margin: 0 0 1.25rem;
}

/* Role cards */
.guide-roles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 320px), 1fr));
  gap: 1rem;
}
.role-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 1.25rem 1.35rem 1.1rem;
  display: flex; flex-direction: column; gap: 0.65rem;
  transition: border-color 0.15s, transform 0.15s;
}
.role-card:hover {
  border-color: rgba(6, 182, 212, 0.45);
  transform: translateY(-1px);
}
.role-icon { font-size: 28px; line-height: 1; }
.role-name {
  font-family: var(--font-display);
  font-size: 18px; font-weight: 900; font-style: italic;
  color: var(--text); margin: 0;
}
.role-desc {
  font-family: var(--font-mono);
  font-size: 12px; line-height: 1.6;
  color: var(--text-3); margin: 0;
}
.role-desc strong { color: var(--text-2); font-weight: 600; }
.role-steps {
  font-family: var(--font-mono);
  font-size: 12px; line-height: 1.55;
  color: var(--text-2);
  margin: 0; padding-left: 1.2rem;
  display: flex; flex-direction: column; gap: 0.3rem;
}
.role-steps strong {
  color: var(--cyan);
  font-weight: 700;
  font-family: var(--font-display);
  letter-spacing: 0.03em;
}
.role-steps a { color: var(--cyan); text-decoration: none; }
.role-steps a:hover { text-decoration: underline; }
.role-cta {
  font-family: var(--font-display);
  font-size: 11px; font-weight: 700;
  letter-spacing: 0.15em; text-transform: uppercase;
  color: var(--cyan); text-decoration: none;
  margin-top: 0.35rem;
  align-self: flex-start;
  transition: color 0.12s, transform 0.12s;
}
.role-cta:hover { color: var(--text); transform: translateX(2px); }

/* FAQ */
.guide-faq {
  margin: 0;
  display: flex; flex-direction: column; gap: 1.1rem;
}
.guide-faq dt {
  font-family: var(--font-display);
  font-size: 14px; font-weight: 800; font-style: italic;
  color: var(--text);
  margin-bottom: 0.35rem;
}
.guide-faq dd {
  font-family: var(--font-mono);
  font-size: 12.5px; line-height: 1.7;
  color: var(--text-2);
  margin: 0; padding-left: 1rem;
  border-left: 2px solid var(--border);
}
.guide-faq dd strong { color: var(--text); font-weight: 600; }
.guide-faq dd a { color: var(--cyan); text-decoration: none; }
.guide-faq dd a:hover { text-decoration: underline; }

/* Where-to-next */
.guide-next-lede {
  font-family: var(--font-mono);
  font-size: 13px; line-height: 1.7;
  color: var(--text-2);
  margin: 0 0 0.85rem;
}
.guide-next-lede a {
  color: var(--cyan); text-decoration: none; font-weight: 600;
}
.guide-next-lede a:hover { text-decoration: underline; }
.guide-next-list {
  margin: 0 0 1.5rem; padding-left: 1.2rem;
  display: flex; flex-direction: column; gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 12.5px; line-height: 1.6;
  color: var(--text-2);
}
.guide-next-list a {
  color: var(--cyan); text-decoration: none; font-weight: 600;
}
.guide-next-list a:hover { text-decoration: underline; }
.guide-cta-row {
  display: flex; gap: 0.75rem; flex-wrap: wrap;
  margin-top: 1rem;
}

@media (max-width: 600px) {
  .guide-roles { grid-template-columns: 1fr; }
  .role-card { padding: 1rem 1rem 0.9rem; }
}
</style>
