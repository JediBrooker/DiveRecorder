# DiveRecorder

A multi-tenant diving competition scoring app. Real-time judge scoring over WebSockets, World Aquatics-compliant point calculations, prelim → semi → final progression, role-based dashboards (diver / coach / referee / meet manager), self-serve analytics, and a printable program / results pipeline that goes from "live broadcast" to "PDF export" without leaving the app.

Built around five audiences:

- **Divers** — Diver Portal for building and submitting dive lists per event (with World Aquatics DD lookup, height filter, synchro partner autocomplete), plus a personal profile with PBs, score-trend sparkline, average DD, best single dive, and a customisable analytics dashboard with 10+ widgets.
- **Coaches** — A `coach` role with a per-coach roster of linked divers and one-click access to each diver's profile.
- **Meet operators** — Control room view advances divers, broadcasts state to judges and the public scoreboard, finalises events. 30-second shot clock, hold/resume, score correction, queue reorder, late entry, audit-logged referee actions.
- **Judges** — Single-purpose phone-friendly view that submits scores back to the server in real time. Synchro panels see role hints (Exec A / Exec B / Sync) so they know which judging slot they're filling.
- **Spectators** — Public scoreboard with current performer, live standings, per-round leaderboard with movement arrows, public meet landing pages, and an archive of completed meets.

---

## Screenshots

### Home

The public landing page. Anyone can sign in, create an account, watch a live meet, or browse the archive without logging in.

![Home](./docs/screenshots/home.png)

### Dashboard

Each user's role-based hub. Tiles surface only the areas the user has access to — divers see "My Profile" and "Diver Portal", admins additionally see User Manager, Clubs, Teams, etc.

![Dashboard](./docs/screenshots/dashboard.png)

### Live Scoreboard (completed meet recap)

When a meet is over, the Scoreboard switches to a recap layout: podium spotlight, full standings with club lines, and a per-diver dive-by-dive breakdown. Per-judge scores are colour-coded by FINA category (excellent → failed) with the trim rule visualised by struck-through dimmed scores.

![Scoreboard](./docs/screenshots/scoreboard.png)

### Results Archive (now part of the unified Scoreboard)

Browse every completed meet. Filter by country, year, height, club, or just search across event/org/country. Each event card shows competitor and club counts so you can see meet size at a glance, and PDFs are one click away.

![Results Archive](./docs/screenshots/results-archive.png)

### Diver Profile

Per-diver stats: meets entered, dives performed, average DD attempted, best single dive, an SVG sparkline of total scores across meets, and a personal-bests table keyed by dive code + position + height. Each diver picks which of 10+ analytics widgets to show via a "Customize" modal — the choices persist per-user.

![Diver Profile](./docs/screenshots/diver-profile.png)

---

## Tech stack

- **Frontend**: Vue 3 (Composition API, `<script setup>`), Vite 6, Vue Router, Pinia
- **Backend**: Node 18+, Express 5, Socket.IO 4, [`pg`](https://node-postgres.com/), `pdfkit`, `nodemailer`
- **Auth**: JSON Web Tokens, bcrypt password hashing, password-reset email flow with single-use tokens
- **Database**: PostgreSQL 14+ with `uuid-ossp` and `pgcrypto`
- **PWA**: service worker (network-first navigation + cache-first assets), web app manifest, IndexedDB-backed offline caching

The project intentionally avoids a build-time framework like Nuxt or Next — the SPA is plain Vite, the server is a single Express app split into thin route modules. Easier to read end-to-end.

---

## Features

### Live scoring & operations

- Operator picks the active diver in the Control Room → judges' phones receive a `state_update` socket event → judges submit scores → control room advances to the next diver.
- **30-second shot clock** auto-starts when a diver is set; pause/reset; visual amber/red countdown; audible alert at 0.
- **Hold / resume** the meet (video review, judge consultation) — broadcasts an amber banner to the spectator scoreboard and disables the judge submit button. Reason text shown publicly.
- **Score correction** — click any completed dive in the Control Room history; modal lets the manager pick a judge, edit the value, and provide a reason. Audit-logged with old/new values, actor, IP, user agent.
- **Round-end transition** — when the last diver of a round scores their last judge, the operator gets a prompt to announce standings to the audience.
- **Referee actions** — failed dive, cap score, redive — broadcast and persisted in the score audit log.
- **Score persistence + audit logging** on every submission (judge id, IP, user agent). Per-judge socket rate limit (60 submissions/min) blocks abuse.
- **Connection-lost banners** on Judge + Scoreboard views so a flaky pool-deck wifi is visible immediately.

### World Aquatics scoring

A small set of PostgreSQL functions does all the scoring so totals are consistent across every standings, leaderboard, archive, and PDF query:

- `calc_dive_points(scores, num_judges, dd)` — official trim-and-multiply rules across panel sizes (3 / 5 / 7 / 9 / 11 judges); 9- and 11-judge totals are normalised so dive points stay comparable.
- `calc_synchro_dive_points(judge_numbers, scores, num_judges, dd)` — World Aquatics synchronised rule: judges 1–2 (or 1–3 on an 11-panel) score Diver A execution, the next group score Diver B execution, the rest score sync. Trimmed and multiplied by `× DD × 0.6` to keep magnitude comparable to individual dives.
- `calc_event_dive_points(...)` — dispatches to the right rule per dive, including the FINA Team Event case where a single event mixes individual and synchro dives.

### Event configuration

Events flex for almost any meet format:

- **Three-stage progression** — Preliminary (all entrants) → Semi-Final (top 18) → Final (top 12). The chain length is operator-defined per event (synchro and team meets typically skip the semi). One-click "Advance Top N →" pulls top-rank divers and seeds the next stage with their dive lists. Idempotent — safe to re-run after a score correction.
- **Age groups / divisions** — free text so any federation's naming works (`U14`, `Open`, `Masters 30-34`, `Para`).
- **Scheduled start time** — feeds the meet schedule view and notifications.
- **Per-round DD limits** — common in junior events (rounds 1–N capped to a max DD).
- **Event templates** — save a fully-built event configuration once, apply to a new event with one click. Per-org, name-keyed.
- **CSV roster import** — paste a roster, server creates all the dive list rows in one transaction; per-row errors reported without failing the whole import.

### Multi-event meets

A meet bundles multiple events ("2026 National Open" → 1m M/F, 3m M/F, 10m M/F, synchro, team).

- Public meet landing page at `/meet/:id` with hero (org, dates, venue, sponsor), live/upcoming/completed status counts, and event grid.
- One-click **printable program PDF** with the full schedule, format, judges, age group, competitor counts.
- Optional sponsor branding on the meet record (logo URL + link).

### Results archive

- Browse completed meets with filters: search, country, year, height, club, status.
- Each event card shows competitor and club counts derived from a `LATERAL` aggregate.
- Per-event detail view with podium spotlight, full standings, dive-by-dive breakdown grouped by diver. Synchro events show role-grouped panels.
- One-click PDF export with the same standings + dive breakdown.
- CSV export of the filtered meets list for federation reporting.

### Diver profile + analytics

- Headline stats: meets entered, dives performed, average DD attempted, best single dive.
- SVG sparkline of score progression across meets.
- Personal best per (dive code + position + height) with attempts and "first set at" meet.
- **Self-serve analytics dashboard** — each diver picks which widgets to show via a "Customize" modal. Catalog includes:
  - Score Trend, Personal Bests
  - Recent Form (last 5 meets with rank "/of N")
  - Medal Counts (gold / silver / bronze / finalist / 9th+)
  - Height Breakdown (avg + best per board height, with bars)
  - Round-by-Round Form (with stamina insight: "you finish strong" / "you fade" / "even pacing")
  - Score Quality Mix (FINA category distribution)
  - DD Risk Profile (avg / max DD + scoring at top DDs)
  - Go-To Dives (most-attempted with avg / best)
  - Current Streak (consecutive podiums / wins, self-hides when none)
  - Compare-to-Peers (your stats vs the org average)
  - Event-Type Splits (individual vs synchro vs team performance)
  - Year-over-Year (this season vs last)
- **Date range filter** at the top of the dashboard — every widget respects it.
- **Export Dashboard PDF** — Cmd-P / Ctrl-P opens a print-friendly view that saves to PDF in one step.
- **Drag-to-reorder** widgets in the Customize modal.
- **Compare two divers** head-to-head at `/compare?a=&b=` — side-by-side stats and per-dive PB diff.

### Multi-tenant model

- Two levels of organisational nesting: **organisations** (country federations) → **clubs** (within an org).
- **Teams** sit alongside clubs as a separate grouping for FINA Team Event entries (a diver can belong to multiple teams over time).
- **Coach ↔ Diver links** — a coach can mentor multiple divers; a diver may have multiple coaches over time. Org admins manage the links from the User Manager drawer.
- Users belong to one org and optionally one club within it.
- System admins see across all orgs; org admins / meet managers manage their own.

### Auth & accounts

- JWT auth with bcrypt password hashing.
- **Self-service password change** with current-password verification.
- **Forgot-password flow** — email link with 30-min single-use JWT (single-use enforced via a password-hash fingerprint, no nonce table).
- Hygiene email on every successful password change.
- Welcome email on registration.
- Org admin notified by email when a new role request lands.

### Notifications

Email triggers (best-effort, never block the response):

- Welcome on registration
- Role-request landing → org admins
- Role-decision (approved / rejected) → applicant
- Password changed → user
- Password reset link → user
- Meet went Live → every competitor
- Results posted → every competitor

### Admin tooling

- **User Manager** (`/users`): search, role filter chips, org filter, group-by-org, bulk role apply, paginated table, click-row-to-edit drawer with role audit history, club editor, **coach link manager**.
- **Clubs** (`/clubs`): list, create, rename, delete with member counts.
- **Teams** (`/teams`): list, create, rename, delete (non-destructive), inline member drawer, see which events each team is enrolled in.
- **Score Audit Log** (`/events/:id/audit`): per-event timeline of every score insert/update/delete with actor, IP, user agent.
- Role grants/revokes write to a `role_audit_log` table; the User Manager drawer surfaces the per-user history.
- 30-day audit log retention via `purge_audit_logs(retention_days)` — runs on server boot, configurable.
- Schema version stamp logged on boot so an operator can confirm at-a-glance which version is deployed.

### Operator surfaces

- **Broadcast / kiosk mode** — `/scoreboard/:eventId/broadcast` (spectator) and `/control?broadcast=1` (operator) hide page chrome for venue projectors; fonts and tile sizes scale up to read from the back of a pool deck.
- **Operator keyboard shortcuts** in Control Room — ←/→/Space to advance, 1–9 to jump to roster position, S to cycle status (READY → DIVING → JUDGING), T to reset shot clock, F failed, R redive, H hold, L leaderboard.
- **Up Next preview** in the live scoreboard centre column.

### PWA / offline

- Web app manifest + 192/512 PNG icons + SVG icon — installs to home screen on iOS / Android / desktop.
- Service worker: network-first for navigation (deploys reach users immediately), cache-first for hashed assets.
- IndexedDB-backed stale-while-revalidate caching on the diver profile and meets list — return visits feel instant, the diver profile keeps working when wifi is gone.

---

## Local setup

### 1. Prerequisites

- **Node 18 or newer** (Vite 6 requires it)
- **PostgreSQL 14+** running locally
- The `uuid-ossp` and `pgcrypto` extensions (PostgreSQL ships with them; `init.sql` enables both)

### 2. Clone and install

```bash
git clone https://github.com/JediBrooker/DiveRecorder.git
cd DiveRecorder
npm install
```

### 3. Create and initialise the database

```bash
createdb diverecorder
psql -d diverecorder -f init.sql
```

`init.sql` is the single bootstrap script — it creates every table, enum, function and index, loads the full World Aquatics dive directory (~830 dives), and creates a system-admin account so you can sign in immediately. Schema version is logged on server boot.

### 4. (Optional) Seed test data

```bash
psql -d diverecorder -f seed_test_data.sql
```

Adds 20 country federations, 80 clubs, 1000 users, 50 individual events, 20 synchronised pair events (11-judge panels with proper World Aquatics scoring) and 10 team events (3 teams of 4 members each), all with dive lists, judge scores, and matching audit history. Useful for stress-testing the archive, scoreboard, and admin views. Idempotent — safe to re-run; deletes the prior seed before re-inserting.

### 5. Configure environment

```bash
cp .env.example .env
# edit .env with your local DB credentials and a JWT secret
```

For password-reset and notification emails to actually send, also configure SMTP:

```
APP_BASE_URL=https://your-domain.example.com
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Dive Recorder <noreply@your-domain.example.com>"
```

Without `SMTP_HOST` set, every email helper silently no-ops — registrations and password changes work, just no email is dispatched. `APP_BASE_URL` is used to build the reset-password link.

### 6. Sign in

| Account | Username | Password |
|---|---|---|
| System administrator (created by `init.sql`) | `admin` | `admin` |
| Any seeded test user (created by `seed_test_data.sql`) | `bulk_user_0001` … `bulk_user_1000` | `password123` |

Change the `admin` password from the User Manager once you're in.

### 7. Run

In two terminals:

```bash
# Terminal 1 — backend on :3000
npm start

# Terminal 2 — Vite dev server on :5173 (proxies /api and /socket.io to :3000)
npm run dev
```

For a production-ish single-process build:

```bash
npm run build      # builds the SPA into dist/
npm start          # Express serves the API and the dist/ SPA together
```

Open `http://localhost:5173` (dev) or `http://localhost:3000` (built).

---

## Project structure

```
.
├── server.js                # Express app — auth + REST + sockets + PDF
├── routes/
│   ├── auth.js              # /api/auth/* (login, register, password reset)
│   └── scoreboard.js        # /api/scoreboard/:eventId + /leaderboard
├── init.sql                 # One-shot bootstrap: schema + dive directory + admin user
├── seed_test_data.sql       # Optional test-data seed (orgs, users, events, scores)
├── migrations/              # Append-only schema changes since v1
├── src/
│   ├── views/               # One Vue component per route
│   ├── lib/
│   │   └── idbCache.js      # IndexedDB stale-while-revalidate helper
│   ├── stores/auth.js       # Pinia auth store (JWT in sessionStorage)
│   ├── composables/         # useSocket, useOfflineApi, useScoreCategories
│   ├── router/              # vue-router config
│   └── main.js, App.vue
├── public/
│   ├── css/app.css          # Shared design tokens (one stylesheet)
│   ├── icon.svg / icon-*.png# PWA icons
│   ├── manifest.webmanifest # Web app manifest
│   └── sw.js                # Service worker (network-first nav)
├── test/
│   ├── calc.test.js         # World Aquatics scoring tests vs Postgres
│   └── syntax.test.js       # No-DB sanity (server.js parses, init.sql exists)
└── .github/
    ├── workflows/ci.yml     # Lint + build + Postgres test matrix
    └── ISSUE_TEMPLATE/
        └── bug_report.md    # Bug report template
```

---

## Roles

DiveRecorder has eight role personas — seven values in the `org_role` enum plus the `is_system_admin` boolean flag. Each persona below describes the role's context and the things that role can actually do in the app.

### `is_system_admin` — Platform operator

The platform operator runs DiveRecorder as a multi-tenant SaaS — the only person who sees across every federation on the system. They're the last line of defence when something goes wrong, whether that's a stuck migration, a suspicious score change, or an org admin who's locked themselves out the morning of a national championship. Their authority is orthogonal to `org_role`: not "in" any single org, but above all of them.

**What they can do:**
- Approve or reject new federation sign-ups (`/api/orgs/pending`)
- Run database migrations and inspect `schema_meta` to confirm the deployed version
- Read `score_audit_log` and `role_audit_log` across every org
- See every event in every org via `/api/events` (no org filter)
- Override the org filter on read endpoints (e.g. edit any event regardless of `org_id`)
- Reset passwords and unlock accounts for any user

### `org_admin` — Federation administrator

Top of the food chain inside one federation — the person whose name is on the records book. They don't typically run meets themselves, but they decide who does: promoting meet managers, certifying judges, approving coach-diver links. They care about the integrity of the records and the credibility of the scoreboard when sponsors look at it.

**What they can do:**
- Create events and meets (`POST /api/events`, `POST /api/meets`)
- Promote, demote, and remove org roles within their federation
- Approve or reject coach⇄diver linking requests
- Edit or delete any event in their org
- Set `entries_close_at` on events to enforce registration deadlines
- Sign off federation records (`records_federation`)
- Manage clubs and teams within the federation

### `meet_manager` — Meet organiser

The person actually running the meet on the day. They live in ControlView for those eight hours: starting every event on time, keeping the queue clean, and surviving the inevitable late-arriving diver without the controller crashing.

**What they can do:**
- Schedule events (`scheduled_at`) and set the registration deadline (`entries_close_at`)
- Import the roster from CSV (`POST /api/events/:id/roster/import`)
- Lock the dive order, drag-reorder before the event starts, randomise starts
- Drive ControlView during the meet — advance divers round-by-round
- Flip event status: `Upcoming → Live → Completed`
- Add a late-arriving diver via the late-entry override (works after entries close)
- Edit a team's bulk dive list (`POST /api/teams/:teamId/dive-lists`)
- Withdraw or scratch divers mid-event

### `referee` — Meet official

The licensed official on deck. They don't score dives themselves — they supervise the panel that does. They confirm the right number of judges are seated, watch the scoreboard for anomalies during the meet (a judge drifting two points low across the panel, a missed drop), and adjudicate when a coach challenges a score.

**What they can do:**
- View the live ScoreboardView for any event they're assigned to
- Read the per-event `score_audit_log` to see who entered or changed each score
- Authorise a score correction (the audit row records them as the actor)
- Confirm synchro panels have valid exec/sync subgroups (9 or 11 judges)
- See the full panel composition in `event_judges` before the event starts

### `judge` — Scoring panel member

Part-time scoring staff who work meet by meet. Usually on a phone in landscape — watching the diver, tapping a score, moving on. The app's single job for them is to make scoring frictionless.

**What they can do:**
- Log into JudgeView on phone for any event they're assigned to (`event_judges`)
- See the current diver, their dive code, position, and DD as it changes round by round
- Tap a half-point score (0.0 → 10.0) on the dial
- Submit the score over the socket (rate-limited per-judge to prevent double-taps)
- See their own submitted score reflected immediately

### `coach` — Diver mentor

Works most closely with individual diver data. Spotting trends — a 5132D drifting two judges down over three meets — comparing two divers head-to-head before nationals, and saving dive-list templates so a 3m optionals list isn't retyped every weekend.

**What they can do:**
- Request to be linked to a diver via `coach_diver_links` (subject to org admin approval)
- View each linked diver's full profile: recent form, judges' individual scores, PB by board height
- Compare two divers head-to-head in CompareView
- Save and re-use dive-list templates, scoped per board height
- See historical scores at the dive-code-and-position level (e.g. their last ten 105Bs)

### `diver` — Athlete

Phone-native and impatient — the app needs to get out of their way. The night before each meet they submit their list; during the meet they watch their own scoreboard between rounds and review judges' scores after each round to calibrate against the panel.

**What they can do:**
- Submit a dive list for an event (`POST /api/competitor/submit-list`) — only while the event is `Upcoming` *and* `entries_close_at` hasn't passed
- Save the current list as a named template, scoped to the event's board height
- Load a saved template and tweak before submitting
- Pick a synchro partner via the autocomplete (filters fellow divers in the org)
- Watch the live ScoreboardView for any event they're in
- Review own profile: recent form, individual judges' scores, PBs by board height

### `spectator` — Public viewer

Friends, family, sponsors. Often anonymous — no account, no token. Frequently watching from a phone on patchy 4G. The app's job for them is zero-friction live spectating.

**What they can do:**
- Open the public scoreboard URL with no login required
- Watch scores update live over the socket as judges submit
- See only events in `Live` or `Completed` status (anonymous filter on `/api/events`)
- See published records (`records_personal`, `records_club`, `records_federation`)
- *Cannot* see anyone's dive list before the event goes Live — that's locked to authenticated users

### Summary

| Role enum | Tenancy | Primary surface | Headline capability |
|---|---|---|---|
| `is_system_admin` | Cross-org | Admin console + audit logs | Operate the platform across every federation |
| `org_admin` | One org, full control | ManagerView | Run the federation: events, roles, records, deadlines |
| `meet_manager` | Events they manage | ManagerView + ControlView | Run the meet on the day, including late-entry override |
| `referee` | Per-event assignment | ScoreboardView + audit log | Defend panel integrity, authorise score edits |
| `judge` | Per-event assignment | JudgeView (phone) | Score dives over the socket |
| `coach` | Linked divers | DiverProfileView + CompareView | Track diver form, compare divers, manage templates |
| `diver` | Self + linked coach | CompetitorView | Submit dive lists, manage templates, watch own results |
| `spectator` / anonymous | Public | ScoreboardView | Zero-friction live spectating |

System admin is set with a SQL `UPDATE` (no UI for it intentionally — it's a powerful flag):

```sql
UPDATE users SET is_system_admin = true WHERE username = 'your_username';
```

Sign out and back in for the change to take effect (the JWT carries the flag). The bootstrap `admin` user already has the flag set.

---

## Reporting a bug

Bug reports go through GitHub Issues. The repo has a template that prompts for the details that actually help debug — please fill in everything you can.

**To file a bug:**

1. Open https://github.com/JediBrooker/DiveRecorder/issues/new/choose
2. Pick the **Bug report** template.
3. Fill in the sections (steps to reproduce, expected vs actual, environment).
4. **Don't paste passwords, JWTs, or other secrets.** If a JWT helps the diagnosis, redact the signature segment.

**Before filing**, a quick triage that solves most issues:

- **White page after a deploy?** Hard refresh (Cmd-Shift-R / Ctrl-Shift-R) once. The service worker is now network-first so subsequent deploys reach you on a normal refresh.
- **Schema-version errors?** On the server, check the boot log for `📊 Schema version N`. If `N` is lower than the current migration count under `migrations/`, run the missing migrations in order.
- **Email not sending?** `SMTP_HOST` must be set in the env. Without it, every email helper silently no-ops.
- **Live scoring not updating?** Check the **Connection-lost banner** at the top of the Judge / Scoreboard view — if it's showing, the socket is disconnected.

If you're a paying customer or running a production federation, urgent issues can be flagged via email — see `SUPPORT.md` (if present) for the escalation path; otherwise the issue tracker is the canonical channel.

---

## Scripts

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Vite dev server on :5173 with HMR; proxies `/api` and `/socket.io` to :3000 |
| `npm run build` | Build SPA to `dist/` |
| `npm run preview` | Vite preview of the built bundle |
| `npm start` | Run the Express server (serves `dist/` if built; serves the API and WebSocket on :3000) |
| `npm run lint` | Syntax-check `server.js` |
| `npm test` | Node's built-in test runner against `test/*.test.js` |

---

## Contributing

Fork it, branch from `main`, send a PR. CI builds + lints + runs the test suite (against a Postgres service container) on push and PR — green CI is a precondition for merging.

Branch protection on `main` is enforced via a ruleset: deletions blocked, force-pushes blocked, status checks required.

---

## License

MIT — see [LICENSE](./LICENSE).
