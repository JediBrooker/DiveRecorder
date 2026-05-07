# Admin Tasks

This page covers everything an org admin (or system admin) does when they're NOT actively running a meet — managing users, clubs, teams, audit logs, and federation records.

## User Manager

`/users` — the central screen for managing your federation's users.

### What you see

- **Search box** at the top — matches on full name or username
- **Role filter chips** — Diver, Coach, Judge, Referee, Meet Manager, Org Admin (multi-select)
- **Org filter** (system admins only) — pick a federation to see only its users
- **Group by org** toggle (system admins only) — collapses the list into per-federation sections
- **Bulk role apply** — tick rows, click a role chip in the bulk bar, all ticked users get that role

### Click-row-to-edit

Click any user's row to open the **edit drawer** on the right. The drawer shows:

- **Profile** — full name, username, email, club assignment
- **Roles** — current roles in this org, with grant/revoke buttons
- **Role audit history** — every grant/revoke ever applied to this user, with actor + timestamp
- **Coach links** (for divers) — list of coaches linked to this diver, with approve/revoke buttons (system admin or org admin)
- **Linked divers** (for coaches) — same shape, the other direction

### Granting and revoking roles

Tick the role chip → grant. Untick → revoke. Both write to the role audit log automatically. The user's JWT becomes invalid the moment a role changes (token version is bumped); they're forced to sign in again, picking up the new role.

### Coach ↔ Diver links

Coach role users can request to be linked to a diver from their own dashboard. The request lands as a pending row in the diver's User Manager record; an org admin approves or rejects. Once linked, the coach sees the diver's full profile + analytics + templates.

A diver can have multiple coaches over time; a coach can mentor multiple divers. The link is bidirectional but **gated on org-admin approval** — divers can't be silently surveilled by anyone who claims to be their coach.

## Clubs

`/clubs` — the federation's club registry.

- **List** — every club in your org, with member counts derived from `users.club_id`
- **+ New Club** — name + short code (3 – 6 chars; surfaces as the cyan pill in scoreboards)
- **Edit** — rename, change short code
- **Delete** — non-destructive; clubs with members can't be deleted (prevents orphaning users)

The short code matters more than you'd think — it's the cyan pill that shows next to the diver's name on the scoreboard, history cards, and Up Next tile. Pick something distinctive (e.g. `NZL-WLG` for "NZ Wellington" instead of just `WLG`).

## Teams

`/teams` — for FINA Team Event entries.

- **List** — every team in your org, with member counts and a list of events the team is enrolled in
- **+ New Team** — name + optional short code
- **Edit** — rename, change short code, manage members via the inline drawer
- **Delete** — non-destructive (preserves history); a deleted team's existing dive lists keep referencing the team via `ON DELETE SET NULL`

The members drawer lets you add or remove divers, with a search across your federation's users. A diver can belong to multiple teams over time (e.g. an Auckland senior who later moves to a Christchurch club).

Team names show as a **purple chip** in history cards and the active-diver block — it's the visual signal that this is a team event entry.

## Score Audit Log

`/events/<id>/audit` — every score insert, update, and delete for one event.

You can also reach this from the event row in Meet Manager via the **Audit Log** button.

### What it logs

For every score event:

- Action — `insert` / `update` / `delete`
- Actor — which user triggered it (judge submitting, meet manager correcting)
- Old value + new value (for updates)
- Reason text (for corrections — required field)
- Timestamp
- IP address + user agent

### Who can read it

- System admins — across every event, every org
- Org admins — events in their own federation
- Referees — events they're assigned to
- Meet managers — events they manage

Divers and judges **cannot** read the audit log — it's an integrity tool for officials.

### Retention

Audit rows are kept for 30 days by default (configurable via `purge_audit_logs(retention_days)` which runs on server boot). After the retention window, scoreboards and standings still work normally — only the per-row "who edited what when" history is pruned.

## Role Audit Log

The role audit log lives **inside the User Manager drawer** — click any user's row, scroll down to the role audit history section.

For every role grant or revoke:

- Action — granted / revoked
- Role — the specific role (judge / coach / etc.)
- Actor — which admin made the change
- Timestamp

System admins can also query the table directly via `role_audit_log` if needed for cross-org analytics.

## Federation records

`/records/<federation-slug>` — the public records book for your federation.

Records are tracked at three levels:

- **Personal** — per-diver, per `(dive_code, position, board_height)`. Auto-set on every score insert via `checkAndApplyRecords`.
- **Club** — per-club; auto-set when a member breaks the club's existing best
- **Federation** — same shape but federation-wide; **requires org admin sign-off** before it goes public

A new federation record lands in `pending_federation_records` until an org admin approves it from the records page. This prevents a panel error or a one-off score correction from immediately publishing a "new national record" the audience would later see retracted.

## System admin tasks

The system admin (set via `is_system_admin = true` in the DB) has a few extra surfaces:

### Approving new federations

When someone clicks "Register your org" on the login page, their federation lands in `pending` status. The system admin sees pending orgs from User Manager → org filter → status = pending. Click → review name + country code + admin's contact email → approve or reject.

Approved orgs are immediately usable; rejected orgs send a notification email and stay in the database in `rejected` status (for audit purposes).

### Approving system-wide records

Some records (e.g. cross-federation continental records) are approved at the system-admin level. The same pending → approve flow as federation records, but visible only to system admins.

### Cross-org user lookup

System admins can see every user across every federation via the User Manager. Useful when:

- A user is locked out and the org admin can't reach them
- A judge appears on a panel for a federation they don't belong to (data error or fraud — the audit log will show)
- Migrating a user between federations

### Resetting a password

Click any user → the drawer has a **Force Password Reset** button. The user's existing token is invalidated; they're emailed a single-use reset link (or, if SMTP isn't configured, the system admin sees the reset URL in the response and can deliver it manually).

### Migrations

System admins are the only ones who run database migrations — see the main [README](../../README.md) for the deploy script. The `/api/health` endpoint reports the current `schema_version`; an outdated version blocks new code paths.

## Bulk operations

A few bulk paths worth knowing about:

- **CSV roster import** (per-event) — paste a CSV, the server creates dive list rows in one transaction
- **CSV results export** (federation-wide) — Results Archive → Filter → Export CSV
- **Bulk role apply** — User Manager → tick rows → click a role chip
- **PDF program export** — meet landing page → Print Program

Anything more bespoke (mass user import from a federation database, CSV-driven event creation) needs to go through the API directly. See the API documentation in the main README.

## Notifications

Email notifications fire automatically (best-effort, never block the response):

| Trigger | Recipient |
|---|---|
| User registers | The new user (welcome email) |
| Role request | All org admins |
| Role decision | The applicant |
| Password changed | The user |
| Password reset link | The user |
| Meet went Live | Every competitor in any event of the meet |
| Results posted | Every competitor in the finalised event |

Without `SMTP_HOST` configured, all email helpers silently no-op. Registrations + password changes still work; just no email.

## Common admin pitfalls

- **Promoting a meet manager too late.** Until they have the role, they can't open the Control Room. Promote them at least the day before.
- **Forgetting the referee.** The Sign Off step in the Control Room blocks Start Event without one — no referee, no Live event.
- **Deleting a club mid-meet.** The UI prevents this (members must be reassigned first), but a direct API call could orphan users. Don't.
- **Suspending an org during an active meet.** The org status flip is immediate — judges and the scoreboard would lose access mid-event. Wait for the meet to complete.
