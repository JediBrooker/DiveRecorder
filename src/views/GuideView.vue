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
 *   • Dashboard (`/dashboard`) footer alongside the bug-report link
 *
 * Structure (matches the journey of a first-time user):
 *   1. What is DivingHQ?
 *   2. "I'm a …" — role-by-role cards
 *   3. Common first questions (FAQ-lite, 4 items)
 *   4. Where to go from here — link out to the full wiki
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
         v-tip="'Detailed user guide on GitHub'">
        {{ $t('guide.open_wiki') }}
      </a>
    </div>

    <!-- Hero -->
    <section class="guide-hero">
      <div class="guide-eyebrow">{{ $t('guide.title') }}</div>
      <h1 class="guide-title">Welcome to <span class="guide-title-brand">Diving<span>HQ</span></span></h1>
      <p class="guide-lede">
        A platform for running diving meets — divers submit dive sheets,
        judges score on phones, the operator drives the meet from a
        Control Room, and the audience watches the scoreboard live.
        This page is the five-minute primer. Pick your role below for the
        path that fits.
      </p>
    </section>

    <!-- "I'm a …" — role cards -->
    <section class="guide-section">
      <h2 class="guide-h2">{{ $t('guide.section_roles') }}</h2>

      <div class="guide-roles">
        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🏊</div>
          <h3 class="role-name">Diver</h3>
          <p class="role-desc">
            You compete. You'll submit a dive sheet (which dives you'll
            do, by round) before each event's entry deadline, then check
            <strong>Meet Day View</strong> on the day to see your queue
            position and what you need to score.
          </p>
          <ol class="role-steps">
            <li>Sign in or accept the invite from your federation admin</li>
            <li>Open <strong>Submit Dive Sheets</strong> and pick your dives per round</li>
            <li>On meet day, open <strong>Meet Day View</strong> on your phone</li>
            <li>Your scores + analytics live on <strong>My Profile</strong></li>
          </ol>
          <a :href="`${WIKI}/Diver-Portal`" target="_blank" rel="noopener"
             class="role-cta">Diver guide ↗</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🧑‍⚖️</div>
          <h3 class="role-name">Judge</h3>
          <p class="role-desc">
            You score dives on a phone. The active-diver name pops onto
            your screen automatically; you tap in the score in
            half-point increments and the result lands on the live
            scoreboard within a second.
          </p>
          <ol class="role-steps">
            <li>Sign in on your phone before the meet starts</li>
            <li>Pick the active event from the dropdown</li>
            <li>Wait for the active-diver banner; tap your score (0.0 – 10.0 in 0.5 steps)</li>
            <li>If your wifi drops, scores queue locally and sync when it's back</li>
          </ol>
          <a :href="`${WIKI}/Judging`" target="_blank" rel="noopener"
             class="role-cta">Judging guide ↗</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🎓</div>
          <h3 class="role-name">Coach</h3>
          <p class="role-desc">
            You see your divers' history, analytics, and PBs in one
            place. Divers grant you read-only access from their profile;
            once linked, they show up on your Coach Dashboard.
          </p>
          <ol class="role-steps">
            <li>Ask each diver to add you as their coach (from their profile settings)</li>
            <li>Open <strong>Coach Dashboard</strong> — every linked diver appears</li>
            <li>Use <strong>Compare Divers</strong> to put two side-by-side</li>
            <li>Save dive list templates and share them with your athletes</li>
          </ol>
          <a :href="`${WIKI}/Diver-Portal#coach-access`" target="_blank" rel="noopener"
             class="role-cta">Coach guide ↗</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🎮</div>
          <h3 class="role-name">Meet Manager</h3>
          <p class="role-desc">
            You run the meet. Create events, build the roster, seat the
            judging panel, then drive scoring from the
            <strong>Control Room</strong> on the day — set the active
            diver, run the shot clock, hold the meet, correct scores
            when needed.
          </p>
          <ol class="role-steps">
            <li>Open <strong>Meet Manager</strong> — create the meet + events</li>
            <li>Import the roster (CSV) or invite divers individually</li>
            <li>Seat judges via <strong>Assign Judges</strong> + pick a referee</li>
            <li>On the day, drive scoring from <strong>Control Room</strong></li>
          </ol>
          <a :href="`${WIKI}/Running-a-Meet`" target="_blank" rel="noopener"
             class="role-cta">Control Room guide ↗</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🏛️</div>
          <h3 class="role-name">Org Admin</h3>
          <p class="role-desc">
            You set up the federation. Manage clubs, teams, users, and
            roles. Every meet a meet manager creates rolls up to your
            federation; you can also host international meets and
            invite visiting federations.
          </p>
          <ol class="role-steps">
            <li>Register your federation at <RouterLink to="/register-org">/register-org</RouterLink></li>
            <li>Walk through the <strong>Setup Wizard</strong> — clubs, invites, first event</li>
            <li>Grant roles in <strong>User Manager</strong> as your team grows</li>
            <li>Check the <strong>Audit Log</strong> for any federation-wide activity</li>
          </ol>
          <a :href="`${WIKI}/Quick-Start`" target="_blank" rel="noopener"
             class="role-cta">Quick start ↗</a>
        </article>

        <article class="role-card">
          <div class="role-icon" aria-hidden="true">🌐</div>
          <h3 class="role-name">Spectator</h3>
          <p class="role-desc">
            You watch. No login needed. Anyone can browse the
            scoreboard, watch a live meet, dig into a diver's history,
            or check whether a judge has scored your country higher
            than the panel.
          </p>
          <ol class="role-steps">
            <li>Open <RouterLink to="/scoreboard">Scoreboard &amp; Results</RouterLink></li>
            <li>Pick any live event for the broadcast layout, or any completed meet for the recap</li>
            <li>Tap any judge score chip → opens that judge's public analysis</li>
            <li>Add to Home Screen (iOS / Android) for a faster, chromeless view</li>
          </ol>
          <a :href="`${WIKI}/Scoreboard`" target="_blank" rel="noopener"
             class="role-cta">Scoreboard guide ↗</a>
        </article>
      </div>
    </section>

    <!-- FAQ-lite -->
    <section class="guide-section">
      <h2 class="guide-h2">{{ $t('guide.section_first_time') }}</h2>

      <dl class="guide-faq">
        <dt>I just registered, but I can't sign in yet.</dt>
        <dd>
          Email verification first — click the link in the welcome email.
          For non-diver roles (judge, coach, meet manager) your federation
          admin also needs to approve you. Both should happen within
          minutes; if you don't see the email after 10 minutes, check
          spam, then ask your admin to confirm your account is active.
        </dd>

        <dt>I'm a judge — what device should I use?</dt>
        <dd>
          Any modern phone with a browser works. iPhone 12 / Pixel 6
          and newer is ideal. The view is mobile-first; you'll spend
          the meet tapping numbers, so a phone you can grip
          comfortably in one hand is the right call. WiFi is
          preferred over 4G if the venue has it — your scores still
          sync over 4G but the network round trip is noticeably
          longer.
        </dd>

        <dt>How does scoring work?</dt>
        <dd>
          Each judge scores a dive from <strong>0.0 to 10.0</strong>
          in half-point steps. With a 5-judge panel, the highest and
          lowest are dropped and the middle three are kept (the
          "trim"). The kept scores are multiplied by the dive's
          <strong>DD</strong> (Degree of Difficulty) to get the
          dive's points. For synchro, three sub-panels score
          different aspects (Exec A, Exec B, Sync) and the math
          combines them per World Aquatics Article 8.
        </dd>

        <dt>How do I report a bug?</dt>
        <dd>
          Click the <strong>🐛 Report a bug</strong> link at the bottom
          of the home page or your dashboard. It opens a pre-filled
          GitHub issue ready for you to describe the problem. Screenshots
          help a lot.
        </dd>
      </dl>
    </section>

    <!-- Where to next -->
    <section class="guide-section guide-next">
      <h2 class="guide-h2">{{ $t('guide.section_finding') }}</h2>
      <p class="guide-next-lede">
        Need the deep-dive version? The
        <a :href="WIKI" target="_blank" rel="noopener">full wiki</a>
        covers every screen, every role, every World Aquatics rule the
        app encodes. The pages most worth bookmarking:
      </p>
      <ul class="guide-next-list">
        <li>
          <a :href="`${WIKI}/Features`" target="_blank" rel="noopener">Features by role</a>
          — every feature in the app, indexed by who uses it
        </li>
        <li>
          <a :href="`${WIKI}/Quick-Start`" target="_blank" rel="noopener">Quick Start (10 min)</a>
          — register a federation and run your first meet
        </li>
        <li>
          <a :href="`${WIKI}/Roles-and-Permissions`" target="_blank" rel="noopener">Roles &amp; permissions</a>
          — what each role can and can't do
        </li>
        <li>
          <a :href="`${WIKI}/FAQ`" target="_blank" rel="noopener">FAQ &amp; troubleshooting</a>
          — answers to "why is this greyed out / not showing"
        </li>
        <li>
          <a :href="`${WIKI}/Keyboard-Shortcuts`" target="_blank" rel="noopener">Keyboard shortcuts</a>
          — ← / → / Space / T / F / R / H / L for the Control Room
        </li>
      </ul>

      <div class="guide-cta-row">
        <RouterLink to="/register" class="btn btn-primary">Create an account</RouterLink>
        <RouterLink to="/scoreboard" class="btn btn-ghost">Browse scoreboard →</RouterLink>
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
