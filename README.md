# DiveRecorder

A multi-tenant diving competition scoring app. Real-time judge scoring over WebSockets, World Aquatics-compliant point calculations, and a results archive that goes from "live broadcast" to "PDF export" without leaving the app.

Built around four audiences:

- **Divers** — Diver Portal for building and submitting dive lists per event (with World Aquatics DD lookup, height filter, synchro partner picker), plus a personal profile with PBs, score-trend sparkline, average DD, best single dive, and a single click to change clubs.
- **Meet operators** — control room view advances divers, broadcasts state to judges and the public scoreboard, finalises events. Aware of synchro pairs and team affiliations on the active-diver card.
- **Judges** — single-purpose phone-friendly view that submits scores back to the server in real time. Synchro panels see role hints (Exec A / Exec B / Sync) so they know which judging slot they're filling.
- **Spectators** — public scoreboard with current performer, live standings, per-round leaderboard with movement arrows, and an archive of completed meets.

---

## Screenshots

### Home

The public landing page. Anyone can sign in, create an account, watch a live meet, or browse the archive without logging in.

![Home](./docs/screenshots/home.png)

### Dashboard

Each user's role-based hub. Tiles surface only the areas the user has access to — divers see "My Profile" and "Diver Portal", admins additionally see User Manager, Clubs, etc.

![Dashboard](./docs/screenshots/dashboard.png)

### Live Scoreboard (completed meet recap)

When a meet is over, the Scoreboard switches to a recap layout: podium spotlight, full standings with club lines, and a per-diver dive-by-dive breakdown. Per-judge scores are colour-coded by FINA category (excellent → failed) with the trim rule visualised by struck-through dimmed scores.

![Scoreboard](./docs/screenshots/scoreboard.png)

### Results Archive

Browse every completed meet. Filter by country, year, height, club, or just search across event/org/country. Each event card shows competitor and club counts so you can see meet size at a glance, and PDFs are one click away.

![Results Archive](./docs/screenshots/results-archive.png)

### Diver Profile

Per-diver stats: meets entered, dives performed, average DD attempted, best single dive, an SVG sparkline of total scores across meets, and a personal-bests table keyed by dive code + position + height.

![Diver Profile](./docs/screenshots/diver-profile.png)

---

## Tech stack

- **Frontend**: Vue 3 (Composition API, `<script setup>`), Vite 6, Vue Router, Pinia
- **Backend**: Node 18+, Express 5, Socket.IO 4, [`pg`](https://node-postgres.com/), `pdfkit`, `nodemailer`
- **Auth**: JSON Web Tokens, bcrypt password hashing
- **Database**: PostgreSQL 14+ with `uuid-ossp`

The project intentionally avoids a build-time framework like Nuxt or Next — the SPA is plain Vite, and the server is a single `server.js` Express app. Easier to read end-to-end.

---

## Features

### Live scoring

- Operator picks the active diver in the Control Room → judges' phones receive a `state_update` socket event → judges submit scores → control room advances to the next diver.
- Score persistence + best-effort audit logging on every submission (judge id, IP, user agent).
- Spectator-only Scoreboard view with no auth, broadcast feed badge, big-display Current Performer panel, and a "round X / Y" pill so audiences know where the meet is at.

### World Aquatics scoring

A small set of PostgreSQL functions does all the scoring so totals are consistent across every standings, leaderboard, archive, and PDF query:

- `calc_dive_points(scores, num_judges, dd)` — official trim-and-multiply rules across panel sizes (3 / 5 / 7 / 9 / 11 judges); 9- and 11-judge totals are normalised so dive points stay comparable.
- `calc_synchro_dive_points(judge_numbers, scores, num_judges, dd)` — World Aquatics synchronised rule: judges 1–2 (or 1–3 on an 11-panel) score Diver A execution, the next group score Diver B execution, the rest score sync. Trimmed and multiplied by `× DD × 0.6` to keep magnitude comparable to individual dives.
- `calc_event_dive_points(...)` — dispatches to the right rule per dive, including the FINA Team Event case where a single event mixes individual and synchro dives.

### Synchronised pairs

- Event type `synchro_pair` with appropriate panel sizes (typically 9 or 11 judges).
- Divers pick a partner from their organisation in the Diver Portal — both members are linked via `partner_id` on a single dive list, so one diver submits for the pair.
- Scoreboard, archive, and PDF all show the partner alongside the primary diver.
- Per-judge scores in the Scoreboard and Archive are grouped by role (Exec A / Exec B / Sync) so the audience can read the panel at a glance.

### Team events

- Event type `team` with a teams registry per organisation (`/teams`) — create, rename, set short codes, manage rosters, see which events each team is in.
- A team event's dive list is built per-team in [TeamDiveListView.vue](src/views/TeamDiveListView.vue): each round is either an individual dive (one team member) or a synchro dive (two team members). Mixed individual + synchro within the same event is the FINA Team Event format.
- Standings aggregate by team for team events; for individual / synchro events, scoring stays per-competitor.
- Deleting a team is non-destructive — historical dive list rows survive with `team_id = NULL` so meet results remain intact.
- The Control Room shows the team name on the active-diver card during a team event.

### Results archive

- Browse completed meets with filters: search, country, year, height, club.
- Each event card shows competitor and club counts derived from a `LATERAL` aggregate.
- Per-event detail view with podium spotlight, full standings, dive-by-dive breakdown grouped by diver (each dive showing per-judge scores with FINA-category colour coding and trim-rule indication; synchro events show role-grouped panels).
- One-click PDF export with the same standings + dive breakdown.
- Resilient detail loading — a backend error on a single event no longer blanks the page.

### Diver profile

- Headline stats: meets entered, dives performed, average DD attempted, best single dive.
- SVG sparkline of score progression across meets.
- Personal best per (dive code + position + height) with attempts and "first set at" meet.
- Inline "Change Club" editor so divers can correct their own club affiliation without bothering an admin.

### Multi-tenant model

- Two levels of organisational nesting: **organisations** (country federations) → **clubs** (within an org).
- Teams sit alongside clubs as a separate grouping for FINA Team Event entries (a diver can belong to multiple teams over time).
- Users belong to one org and optionally one club within it.
- System admins see across all orgs; org admins / meet managers manage their own.

### Admin tooling

- **User Manager** (`/users`): search, role filter chips, org filter, group-by-org, bulk role apply, paginated table, click-row-to-edit drawer with role audit history.
- **Clubs** (`/clubs`): list, create, rename, delete with member counts.
- **Teams** (`/teams`): list, create, rename, delete (non-destructive), inline member drawer, see which events each team is enrolled in.
- **Score Audit Log** (`/events/:id/audit`): per-event timeline of every score insert/update/delete with actor, IP, user agent.
- Role grants/revokes write to a `role_audit_log` table; the User Manager drawer surfaces the per-user history.
- CSV export of any current Member Manager filter.

---

## Local setup

### 1. Prerequisites

- **Node 18 or newer** (Vite 6 requires it)
- **PostgreSQL 14+** running locally
- The `uuid-ossp` and `pgcrypto` extensions (PostgreSQL ships with them; the schema enables `uuid-ossp`)

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

`init.sql` is the single bootstrap script — it creates every table, enum, function and index, loads the full World Aquatics dive directory (~830 dives), and creates a system-admin account so you can sign in immediately.

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
├── server.js                # Single-file Express app (auth, REST, sockets, PDF)
├── init.sql                 # One-shot bootstrap: schema + dive directory + admin user
├── seed_test_data.sql       # Optional test-data seed (orgs, users, events, scores)
├── src/
│   ├── views/               # One Vue component per route
│   ├── stores/auth.js       # Pinia auth store (JWT in sessionStorage)
│   ├── composables/         # useSocket etc.
│   ├── router/              # vue-router config
│   └── main.js, App.vue
└── public/css/app.css       # Shared design tokens (one stylesheet)
```

---

## Roles

| Role | Granted to | What they can do |
|---|---|---|
| `spectator` | every user, by default | Read public events and standings |
| `diver` | competitors | Submit dive lists, view own profile |
| `judge` | scoring panel members | Submit scores during live events |
| `referee` | meet officials | Trigger failed-dive / cap / re-dive actions |
| `meet_manager` | event organisers | Create/edit events, manage panels |
| `org_admin` | federation administrators | Approve role requests, manage members |
| `system_admin` (boolean flag) | platform operators | Cross-org access |

System admin is set with a SQL `UPDATE` (no UI for it intentionally — it's a powerful flag):

```sql
UPDATE users SET is_system_admin = true WHERE username = 'your_username';
```

Sign out and back in for the change to take effect (the JWT carries the flag). The bootstrap `admin` user already has the flag set.

---

## Scripts

| Command | What it does |
|---|---|
| `npm install` | Install dependencies |
| `npm run dev` | Vite dev server on :5173 with HMR; proxies `/api` and `/socket.io` to :3000 |
| `npm run build` | Build SPA to `dist/` |
| `npm run preview` | Vite preview of the built bundle |
| `npm start` | Run the Express server (serves `dist/` if built; serves the API and WebSocket on :3000) |

---

## Contributing

Fork it, branch from `main`, send a PR. CI builds on push and PR — green build is a precondition for merging.

---

## License

MIT — see [LICENSE](./LICENSE).
