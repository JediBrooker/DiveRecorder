# DiveRecorder

A multi-tenant diving competition scoring app. Real-time judge scoring over WebSockets, World Aquatics-compliant point calculations, and a results archive that goes from "live broadcast" to "PDF export" without leaving the app.

Built around three audiences:

- **Meet operators** — control room view advances divers, broadcasts state to judges and the public scoreboard, finalises events.
- **Judges** — single-purpose phone-friendly view that submits scores back to the server in real time.
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

The PostgreSQL function `calc_dive_points(scores numeric[], num_judges int, dd numeric)` applies the official trim-and-multiply rules across panel sizes (3 / 5 / 7 / 9 / 11 judges) and normalises 9- and 11-judge totals so dive points stay comparable across panel sizes. Used by every standings, leaderboard, archive, and PDF query so totals are consistent across the app.

### Results archive

- Browse completed meets with filters: search, country, year, height, club.
- Each event card shows competitor and club counts derived from a `LATERAL` aggregate.
- Per-event detail view with podium spotlight, full standings, dive-by-dive breakdown grouped by diver (each dive showing per-judge scores with FINA-category colour coding and trim-rule indication).
- One-click PDF export with the same standings + dive breakdown.

### Diver profile

- Headline stats: meets entered, dives performed, average DD attempted, best single dive.
- SVG sparkline of score progression across meets.
- Personal best per (dive code + position + height) with attempts and "first set at" meet.

### Multi-tenant model

- Two levels of organisational nesting: **organisations** (country federations) → **clubs** (within an org).
- Users belong to one org and optionally one club within it.
- System admins see across all orgs; org admins / meet managers manage their own.

### Admin tooling

- **User Manager** (`/users`): search, role filter chips, org filter, group-by-org, bulk role apply, paginated table, click-row-to-edit drawer with role audit history.
- **Clubs** (`/clubs`): list, create, rename, delete with member counts.
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

### 3. Create the database

```bash
createdb diverecorder
psql -d diverecorder -f schema_v2.sql
psql -d diverecorder -f seed_dive_directory.sql
```

### 4. Run migrations

```bash
psql -d diverecorder -f migrations/001_score_audit_log.sql
psql -d diverecorder -f migrations/002_calc_dive_points.sql
psql -d diverecorder -f migrations/003_clubs_and_role_audit.sql
psql -d diverecorder -f migrations/004_event_types_and_synchro.sql
psql -d diverecorder -f migrations/005_teams.sql
psql -d diverecorder -f migrations/006_team_synchro_dives.sql
psql -d diverecorder -f migrations/007_team_fk_set_null.sql
```

### 5. (Optional) Seed test data

```bash
psql -d diverecorder -f seed_bulk_test_data.sql
psql -d diverecorder -f seed_synchro_team_events.sql
```

The first creates 20 country federations, 80 clubs, 1000 users, 50 individual events with full scoring data, and matching audit history. The second adds 20 synchronised pair events (11-judge panels with proper World Aquatics scoring) and 10 team events (3 teams of 4 members each) on top. All seeded users share the password `password123`. Useful for stress-testing the archive, scoreboard, and admin views.

### 6. Configure environment

```bash
cp .env.example .env
# edit .env with your local DB credentials and a JWT secret
```

### 7. Promote yourself to system admin (optional but useful)

After registering your first account through the app:

```sql
UPDATE users SET is_system_admin = true WHERE username = 'your_username';
```

Sign out and back in for the change to take effect (the JWT carries the flag).

### 8. Run

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
├── schema_v2.sql            # Bootstrap schema (run on a fresh DB)
├── seed_dive_directory.sql       # World Aquatics dive directory (DDs by code/height/position)
├── seed_bulk_test_data.sql       # 1000-user / 50-individual-event seed
├── seed_synchro_team_events.sql  # 20 synchro + 10 team events on top of the bulk seed
├── migrations/                   # Append-only schema changes
│   ├── 001_score_audit_log.sql
│   ├── 002_calc_dive_points.sql
│   ├── 003_clubs_and_role_audit.sql
│   ├── 004_event_types_and_synchro.sql
│   ├── 005_teams.sql
│   ├── 006_team_synchro_dives.sql
│   └── 007_team_fk_set_null.sql
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

System admin is set with a SQL `UPDATE` (no UI for it intentionally — it's a powerful flag).

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
