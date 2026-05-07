# Quick Start

This walks you from a fresh DiveRecorder install to running your first meet end-to-end. About **ten minutes** if you have a database ready and an SMTP account for outbound email (the email steps degrade gracefully if you don't, so you can skip SMTP for a local trial).

## 0. Prerequisites

You need a running DiveRecorder server — see the main [README](../../README.md) for installation. From here on we assume the app is reachable at `https://your-domain.example.com` (or `http://localhost:3000` locally).

## 1. Sign in or register your federation

![Login](../screenshots/login.png)

Go to `/login`. You have three options:

- **Sign in** — if your federation is already set up and an admin has given you an account.
- **Register here** — create a personal account inside an existing federation.
- **Register your org** — create a brand-new federation. Most first-time admins start here.

The system administrator (the person who set up the DiveRecorder server) needs to **approve the federation** before you can sign in. New federations land in `pending` status until then. If you self-host, the bootstrap `admin` account (created by `init.sql`, password `admin`) can approve it from `/users` → org filter.

> **Change the bootstrap admin password the moment you log in.** It's `admin / admin` by default and that's a strong invitation for anyone who knows the project.

## 2. Open the dashboard

![Dashboard](../screenshots/dashboard.png)

After signing in you land on `/dashboard`. The tile grid is **role-aware** — every user sees only the surfaces they're allowed to use. As an org admin you'll see the full set: Meet Manager, User Manager, Clubs, Teams, Score Audit, plus the diver-side Profile / Diver Portal tiles for your own account.

## 3. Add a few clubs (optional but realistic)

From the dashboard click **Clubs**. Create one or two clubs (e.g. "Capital Diving Club", "Coastal Aquatics"). Each gets a short code (3–6 chars, e.g. `NZL-1`) that surfaces as a cyan pill next to the club name on the scoreboard.

Clubs are optional — a federation can run a meet without any. They mostly matter for results archives and printed programs where the audience expects to see "who's representing whom".

## 4. Invite users (or let them self-register)

Two paths:

1. **Self-registration.** Send your federation's `/register` link to your divers and judges. They sign up; an admin approves their role from **User Manager**.
2. **Direct creation.** From `/users` click **+ New User**, fill in name + role + (optional) club. Send them their username + a temporary password.

For a quick trial, create at least:

- **5 judges** (panel size for a standard event)
- **3 – 4 divers**
- **1 referee** (used for the pre-meet sign-off)

See [Roles & Permissions](./Roles-and-Permissions.md) for what each role can do.

## 5. Build your first event

![Meet Manager](../screenshots/meet-manager.png)

Click **Meet Manager** from the dashboard. The left column is the **New Event** form; the right column lists your existing events.

Minimum to get an event running:

- **Event Name** — e.g. "Women 3 m Springboard"
- **Event Type** — Individual / Synchro Pair / Team
- **Gender** — Male / Female / Mixed (used for filters and headings)
- **Board / Platform Height** — 1 m, 3 m, 5 m, 7.5 m, 10 m
- **Judge Panel Size** — 5 for individual; **9 or 11** for synchro (FINA rule)
- **Number of Rounds** — typically 5 or 6 for a final, 3 for a trial

Optional but useful:

- **Meet** — bundle this event into a multi-event meet so they share a landing page and printable program.
- **Age Group** — free text (`U14`, `Open`, `Masters 30 – 34`).
- **Per-round DD limits** — common in junior events (rounds 1 – N capped to a max DD).
- **Save as Template** — once you've built a configuration you'll reuse, save it. Future events apply it with one click.

Click **Create Event**. The event lands in your Your Events list with status **Upcoming**.

## 6. Build the roster

From the event's row, click **Edit** and scroll down to the roster panel. Two ways to populate it:

- **Add divers individually** from your federation's user list.
- **Import from CSV** — paste a plain CSV (`username,round_number,dive_code,position`) and the server creates all the dive list rows in one transaction. Per-row errors are reported without failing the whole import.

Divers can also self-submit their lists from `/competitor` while the event is **Upcoming** and `entries_close_at` hasn't passed. See [Diver Portal](./Diver-Portal.md).

## 7. Assign the judging panel

From the event row click **Assign Judges**. Pick a panel from your federation's `judge` users — order matters because judge_number is assigned by position (Judge 1 = panel slot 1).

For synchro events, the panel positions map to roles:

| Panel size | Exec A | Exec B | Sync |
|---|---|---|---|
| 9 | 1 – 2 | 3 – 4 | 5 – 9 |
| 11 | 1 – 3 | 4 – 6 | 7 – 11 |

Judges see their assigned role on the JudgeView so they know which slot they're filling.

## 8. Pick a referee

Add at least one referee to your federation (`User Manager` → grant `referee` role). They don't need to do anything pre-meet, but they're required for the **Sign Off** step in the Control Room before the event can flip to Live.

## 9. Open the Control Room

From the dashboard or the event row, click **Control Room**. This is the operator's cockpit during the meet.

Pre-meet, the centre column shows a coloured workflow button that walks you through four states:

1. **Red — Check In Divers.** Opens the check-in modal; tick everyone present, click Continue.
2. **Orange — Randomise Dive Order.** Or skip if you've already manually arranged the order.
3. **Yellow — Referee Sign Off.** A referee enters their credentials (or taps the push notification) to confirm the panel is valid.
4. **Green — Start Event.** Flips status Upcoming → Live and broadcasts to all judges' phones.

See [Running a Meet](./Running-a-Meet.md) for the full operator playbook including hold/resume, score correction, late entries, and the auto-advance timer.

## 10. Watch the scoreboard

Open `/scoreboard/<event-id>` in another browser window (or another machine on the same network). This is the audience-facing live scoreboard — current performer, live judge scores, standings, catch-up math, Up Next list. Add `?broadcast=1` (or use the **Broadcast** button in the header) for a kiosk-style version that hides the chrome and scales fonts up for a venue projector.

For a phone-friendly spectator URL, the same `/scoreboard/<event-id>` route is responsive — it collapses to a single column on narrow screens.

## 11. After the meet

When the last dive of the last round is scored, the operator clicks **Finalise Event**. Status flips to Completed and:

- The scoreboard switches to a recap layout (podium spotlight, full standings, dive-by-dive breakdown).
- The event appears in the public **Results Archive** (`/scoreboard` with no event id).
- PDFs (program, start list, score sheet, results) are one click away.
- Per-diver profiles update with new PBs, score-trend sparklines, and any new records.

## Next steps

- [Setting Up a Meet](./Setting-Up-a-Meet.md) — deeper dive on event configuration: synchro events, team events, multi-stage progression (prelim → semi → final), event templates, multi-event meet bundles.
- [Running a Meet](./Running-a-Meet.md) — the full operator playbook.
- [Admin Tasks](./Admin-Tasks.md) — managing users, clubs, teams, audit logs.
