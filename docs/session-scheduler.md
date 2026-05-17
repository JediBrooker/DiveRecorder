# Session Scheduler — design

> **Status:** draft for review. Nothing in this doc is built yet.
> Author: Christian Brooker (with Claude). Last updated: 2026-05-17.

## 1. Problem

A diving championship day is not a flat list of events. It's a
choreographed sequence of warmups, event starts, breaks, victory
ceremonies, and the occasional weather/medical delay — usually across
two or three boards running concurrently. Today the app models the
atomic event (and its `scheduled_at` start time), but nothing above it:

- Operators can't see "what's happening at 14:30 on Saturday."
- Judges get assigned to events independently; nothing flags Anna
  being on the 3m panel at 14:00 AND the platform panel at 14:15.
- When an event runs 20 minutes late, every downstream estimate is
  silently wrong — the printed program is the source of truth and
  it's stale by lunch.
- Coaches and divers chasing call-time information rely on the
  paper schedule + word of mouth.

The scheduler is the layer that turns the existing
`events.scheduled_at` field into something the meet actually runs on.

## 2. Scope

### In scope

- A first-class **session** = ordered timeline of **blocks** on a
  given day at a given pool, anchored to a `meet_id`.
- Block types: `warmup`, `event_start`, `break`, `ceremony`, `custom`.
- Per-block **resources**: which board(s) it uses, which judges, which
  events are running in it.
- **Conflict detection** at save time and at render time:
  - judge double-booking across overlapping blocks
  - board double-booking (same board, overlapping windows)
  - diver double-booking (entered in two concurrent events)
  - referee assigned to two parallel sessions
- **Live re-flow** — when an event runs late (estimated end > scheduled
  end), downstream blocks slip by the delta. Operator confirms or
  overrides each shift; nothing moves silently.
- Read access for everyone (public schedule page); write access for
  same-org org admins and meet managers.
- **iCal export** per meet so operators, coaches, and federations
  can subscribe in Outlook / Apple Calendar / Google Calendar. Re-flow
  events propagate automatically (a calendar subscription re-fetches
  on its own cadence; we don't have to push).

### Out of scope (v1)

- Optimisation / auto-scheduling (constraint solver). Operators
  arrange blocks manually; we flag conflicts but don't resolve them.
- Travel-time logic between venues (single-venue assumption).
- Judge work-hour limits, breaks, fatigue scoring.
- Meal-break enforcement, hospitality coordination.
- Spectator-facing push notifications for re-flowed times (v2 — needs
  per-meet opt-in + an unsubscribe flow first).

### Phasing (proposal — open for discussion)

The user picked the full timeline + live re-flow scope. That's
real, but it's also a 4-6 week build. Phasing makes it shippable
in slices, each useful on its own:

- **Phase 1 — Read-only schedule view + iCal (≈1-1.5 weeks).**
  Data model lands (sessions, blocks, boards, dismissed-conflicts).
  UI is a single page per meet-day showing blocks on a vertical
  timeline. Blocks are seeded from `events.scheduled_at` plus
  default warmup windows (45-min warmup before each event, editable
  in phase 3). Public `.ics` endpoint
  ships with this phase so coaches can subscribe immediately.
- **Phase 2 — Conflict detection (≈1 week).**
  Add judge/board/diver conflict warnings on the timeline view and at
  the judge-assignment screen, plus per-conflict dismissal. Still
  read-only on the schedule itself.
- **Phase 3 — Manual editing + duplicate-session (≈1-2 weeks).**
  Drag-to-reorder, drag-edge-to-resize, insert/delete blocks. Saves
  generate conflict warnings inline. Judge assignment becomes
  schedule-aware (filter to "available in this block"). "Duplicate
  to next day" action lifts the whole session forward 24 h —
  championship days share a shape, this saves the operator from
  rebuilding the timeline every morning.
- **Phase 4 — Live re-flow (≈1 week).**
  When the control room marks an event Complete, compute the delta
  vs scheduled end. If delta > 5 min, present a "Reschedule downstream"
  modal listing the proposed shifts. Operator confirms; we re-stamp
  the affected blocks and notify subscribed clients via the existing
  socket layer.

Each phase ships independently. Cancel after any phase and what's
shipped is still useful (read-only schedule alone is a meaningful
upgrade over nothing).

## 3. Data model

Three new tables (sessions, schedule_blocks, boards) plus two
ledgers (block_shifts, dismissed_conflicts). All meet-scoped via the
parent `meets` row.

### 3.0 Boards — first-class resource

Boards become a real table now rather than the `board_height` enum
the rest of the app uses today. The enum is fine when a meet is one
pool × one board per height, but championship venues run two pools
or multiple boards of the same height (warmup vs competition), and
the scheduler has to be able to say "Anna is on 3m board A in pool 1
while the 3m board B in pool 2 is open."

```sql
CREATE TABLE public.boards (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES public.organisations(id) ON DELETE CASCADE,
  pool_name   varchar(80) NOT NULL,             -- "Main pool", "Warmup pool"
  height      board_height NOT NULL,            -- reuses the existing enum
  label       varchar(60),                      -- "Board A", "South-end", optional
  display_order integer NOT NULL DEFAULT 0,
  archived_at timestamptz,                      -- soft delete; preserves history
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, pool_name, height, label)
);
CREATE INDEX idx_boards_org_active ON public.boards (org_id)
  WHERE archived_at IS NULL;
```

`events.height` (enum) stays as the source of truth for the dive
picker. `events` also gets an optional `board_id` so the scheduler
can pin an event to a specific physical board; until that's set, the
scheduler matches by height within the meet's pool. This is a
non-breaking additive change — existing events keep working without
ever picking a board.

### 3.1 Sessions and blocks

```sql
CREATE TABLE public.sessions (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  meet_id     uuid NOT NULL REFERENCES public.meets(id) ON DELETE CASCADE,
  name        varchar(120) NOT NULL,           -- "Saturday morning, 3m"
  session_date date NOT NULL,                  -- the day this session covers
  pool        varchar(80),                     -- "Main pool" — free text for v1
  -- Optional referee assigned for the whole session. Per-block
  -- assignments can override but most sessions inherit one referee.
  referee_user_id uuid REFERENCES public.users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_sessions_meet_date ON public.sessions (meet_id, session_date);

CREATE TYPE schedule_block_type AS ENUM (
  'warmup',         -- pool open for athletes, no scoring
  'event_start',    -- a competition event runs here
  'break',          -- pool closed, scoreboard idle
  'ceremony',       -- medals / opening / closing
  'custom'          -- free-form for whatever the operator needs
);

CREATE TABLE public.schedule_blocks (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id  uuid NOT NULL REFERENCES public.sessions(id) ON DELETE CASCADE,
  block_type  schedule_block_type NOT NULL,
  label       varchar(160),                    -- "Warmup — Men's 3m"
  -- Time window. Both required; the timeline is fully discrete in v1.
  starts_at   timestamptz NOT NULL,
  ends_at     timestamptz NOT NULL,
  CONSTRAINT block_window_valid CHECK (ends_at > starts_at),
  -- The board(s) this block occupies. Array so a warmup can claim
  -- multiple boards at once. Empty / NULL = doesn't claim a board
  -- (ceremony, announcements). FK array into `boards`.
  board_ids   uuid[] NOT NULL DEFAULT '{}',
  -- For event_start blocks: the event this block runs. NULL for
  -- non-event blocks. ON DELETE SET NULL so deleting an event
  -- doesn't blow away the schedule slot — the operator sees an
  -- orphaned block and decides what to do with it.
  event_id    uuid REFERENCES public.events(id) ON DELETE SET NULL,
  -- Live re-flow state. When the operator confirms a shift,
  -- starts_at + ends_at are updated and a row is appended to
  -- schedule_block_shifts (below). actual_start_at / actual_end_at
  -- track the *observed* times — what really happened — so we can
  -- diff plan vs reality after the meet.
  actual_start_at timestamptz,
  actual_end_at   timestamptz,
  notes       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_schedule_blocks_session ON public.schedule_blocks (session_id, starts_at);
CREATE INDEX idx_schedule_blocks_event   ON public.schedule_blocks (event_id) WHERE event_id IS NOT NULL;
```

### Why not extend `events` directly?

The temptation is to add `warmup_starts_at`, `break_after`, etc. to
`events`. Three reasons against:

1. Non-event blocks (medals, opening ceremony, weather delay) have
   no event to attach to. They need a first-class row.
2. Warmups can span multiple events ("all 3m warmup at 8am, then
   prelim, semi, final back-to-back"). One-to-many would force
   either denormalisation or a junction table — once you have a
   junction table you've reinvented `schedule_blocks`.
3. The existing `events.scheduled_at` stays as a denormalised
   convenience for things that don't need the full schedule
   (.ics export, "next event" hint on the homepage). The scheduler
   is the system of record; `scheduled_at` is a cached view of it.

### Shifts ledger (optional, phase 4)

```sql
CREATE TABLE public.schedule_block_shifts (
  id            uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  block_id      uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
  shifted_at    timestamptz NOT NULL DEFAULT now(),
  shifted_by    uuid REFERENCES public.users(id) ON DELETE SET NULL,
  old_starts_at timestamptz NOT NULL,
  new_starts_at timestamptz NOT NULL,
  reason        text                              -- "Event 3 ran 20m long"
);
```

Audit-only — never read by the running app. Lets us debrief
"why did Sunday afternoon collapse" after a meet.

### Dismissed conflicts ledger (phase 2)

Per-conflict dismissals only — see §5 for the rationale. A
dismissal is keyed on the exact triple `(block_a, block_b, resource)`
plus a hash of the resource members at dismissal time. If either
block's window changes or its resource membership shifts, the hash
mismatches and the conflict resurfaces. This is the "safer, noisier"
behaviour: every materially new conflict surfaces, even if it
involves the same pair of blocks the operator dismissed yesterday.

```sql
CREATE TABLE public.dismissed_conflicts (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  meet_id     uuid NOT NULL REFERENCES public.meets(id) ON DELETE CASCADE,
  -- The two blocks involved. Sorted so (a, b) and (b, a) collapse
  -- to one row; saves a noisy index and de-dupes the lookup.
  block_a_id  uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
  block_b_id  uuid NOT NULL REFERENCES public.schedule_blocks(id) ON DELETE CASCADE,
  CONSTRAINT block_pair_sorted CHECK (block_a_id < block_b_id),
  -- The resource type the conflict was about. The detector
  -- generates one row per overlapping resource, so a single
  -- block-pair can have multiple dismissals (e.g., share a board
  -- AND a judge — both dismissed independently).
  resource_kind text NOT NULL
    CHECK (resource_kind IN ('judge','board','diver','referee')),
  -- Hash of the resource members at dismissal time. If the
  -- relevant set changes (judges added to a panel, board swap),
  -- the hash differs and the conflict resurfaces.
  resource_fingerprint text NOT NULL,
  dismissed_by uuid REFERENCES public.users(id) ON DELETE SET NULL,
  dismissed_at timestamptz NOT NULL DEFAULT now(),
  reason       text,
  UNIQUE (block_a_id, block_b_id, resource_kind)
);
```

## 4. UX surfaces

Three views, all reachable from the Manager → Schedule entry point.
Edit access: meet managers, referees, and meet controllers. Read
access: everyone.

### 4.1 Day timeline (read + edit)

Vertical timeline, one column per board, 30-minute gridlines.
Blocks render as cards anchored to their window. Conflicts get a
red outline + tooltip. Drag a card vertically to shift; drag its
bottom edge to resize. Inserting a new block: "+" button between
adjacent blocks creates an empty block, click to fill in.

```
                  ┌─ Saturday, 18 May 2026 ──── Main pool ──┐
                  │  3m board     │  5m platform │ 10m plat │
        09:00 ────│  Warmup       │              │          │
        09:30 ────│   ↓           │              │          │
        10:00 ────│  Women 3m PRE │  Warmup      │          │
              ⚠   │  J: A,B,C,D,E │   ↓          │          │
        10:30 ────│   ↓           │ Men 5m PRE   │          │
                  │   ↓           │ J: B,F,G,H,I │          │
        11:00 ────│  Break        │   ↓          │          │
                  │               │ Break        │          │
        11:30 ────│  Women 3m SF  │              │          │
```

The ⚠ marker = Judge B is on both the 3m panel and the 5m panel
between 10:00 and 10:30. Click for details, including a "dismiss"
action (per-conflict only — see §5).

Warmup blocks are auto-seeded when a session is created: for every
event scheduled in the session, a 45-min warmup block is inserted
immediately before its `scheduled_at`, on the same board(s). The
operator can drag, resize, or delete any auto-seeded block — they're
a starting point, not a constraint.

### 4.2 Conflicts drawer

Side panel on the timeline view. Lists every active conflict with
"Jump to block" links and a suggested resolution where it's
unambiguous (e.g., "Swap Judge B out of the 5m panel — Judge K is
free in this window").

### 4.3 Public schedule

Simple read-only mobile-friendly view per meet, linked from the
homepage. Lists blocks chronologically, no board columns; meant
for spectators/divers/coaches checking when their event runs.
Updates over the existing socket channel when blocks shift.

## 5. Conflict detection

A conflict is two blocks that overlap in time AND share a resource.
The resource types in v1:

| Resource           | Where it comes from                                        |
| ------------------ | ---------------------------------------------------------- |
| Judge              | `event_judges` for `event_start` blocks                    |
| Board              | `schedule_blocks.boards`                                   |
| Diver              | `competitor_dive_lists` for the block's event              |
| Referee            | `sessions.referee_user_id` on the parent session           |

### Algorithm

For a target block B, find every other block B' in the same meet
where `B.starts_at < B'.ends_at AND B'.starts_at < B.ends_at`, then
for each, intersect the resource sets. Any non-empty intersection
is a conflict.

In SQL this is a self-join on `schedule_blocks` with the standard
interval-overlap predicate, joined to `event_judges` and
`competitor_dive_lists`. Cheap enough at meet-day cardinality
(few hundred blocks tops); index on `(session_id, starts_at)`
keeps the planner happy.

### Severity

- **Hard** (red): same resource, same time. Can be dismissed per
  conflict if the operator has a known-good reason ("Anna swaps at
  the break"), but never silently — the dismissal is recorded in
  `dismissed_conflicts` and audit-visible.
- **Soft** (amber): same judge in blocks ≤ 15 min apart but not
  overlapping (no time for them to switch panels). Same dismissal
  flow.

### Dismissal scope (per-conflict)

A dismissal is keyed on the exact `(block_a, block_b, resource_kind)`
triple plus a fingerprint of the resource members at dismissal time.
The conflict resurfaces automatically when:

- either block's time window changes,
- the resource membership changes (judge added to a panel, board
  swapped, diver newly entered in the event), or
- a third block enters the overlap.

Rule-based suppression ("ignore all conflicts involving Judge X")
was considered and rejected — the click savings don't justify the
risk of a genuinely new conflict being silently swallowed.

## 6. Live re-flow

The trigger is `events.completed_at` being stamped (which already
happens when the operator hits Complete in the Control Room — see
`migrations/030_referee_signoff_requests.sql` and the `event_status`
enum). On stamp:

1. Find the `schedule_blocks.event_id = <completed event>` row;
   compute `delta = NOW() - schedule_blocks.ends_at`.
2. If `|delta| < 5 minutes`, do nothing. Sub-5-min noise isn't
   worth interrupting the operator.
3. Otherwise, gather all blocks in the same session with
   `starts_at >= completed_block.ends_at`. These are the candidates
   for shift.
4. Render a "Reschedule downstream" modal: list of candidates with
   their old start time, proposed new start time (old + delta), and
   a per-row checkbox. Default: all checked.
5. On confirm, update `starts_at` and `ends_at` for the checked
   rows by delta, append rows to `schedule_block_shifts`, and emit
   `schedule:shifted` over the socket so public-schedule clients
   refresh.

Live re-flow only ever shifts later, never earlier. If an event
finishes 10 min early, we don't push the next warmup up — most
divers haven't arrived yet.

## 7. API surface

```
GET    /api/meets/:meetId/sessions
       — list sessions for a meet, with all blocks inlined
       (avoids N+1; payload is small)

POST   /api/meets/:meetId/sessions
PUT    /api/sessions/:id
DELETE /api/sessions/:id
       — CRUD on sessions. requireMeetEditor.

POST   /api/sessions/:sessionId/blocks
PUT    /api/blocks/:id
DELETE /api/blocks/:id
       — CRUD on blocks. Returns the saved row plus any conflicts
         it now participates in.

GET    /api/meets/:meetId/conflicts
       — editor-only full conflict report for the meet. Used by the
         conflicts drawer; includes judge/diver/referee labels and is
         not exposed to anonymous public schedule viewers.

POST   /api/blocks/:id/reflow
       — triggered when an event completes. Body: {delta_seconds,
         block_ids: [...]}. Atomically shifts the listed blocks and
         appends to the shifts ledger.

POST   /api/conflicts/dismiss
       — body: {block_a_id, block_b_id, resource_kind, reason?}.
         Server computes the resource fingerprint at the moment of
         dismissal so the conflict resurfaces when membership changes.
DELETE /api/conflicts/dismiss/:id
       — un-dismiss a conflict.

POST   /api/sessions/:id/duplicate
       — body: {target_date}. Clones the session and all its blocks
         forward to target_date, preserving board assignments and
         relative ordering. Event references on event_start blocks
         clear (the new day's events haven't been created yet).

GET    /api/meets/:meetId/schedule.ics
       — iCal export. One VEVENT per schedule_block; subscribers
         re-fetch on their client's cadence so re-flow shifts
         propagate without push. Public endpoint — same visibility
         as the public schedule page.

Socket events: schedule:block_updated, schedule:shifted,
schedule:conflict_dismissed
```

## 8. Resolved decisions

All six open questions were resolved in design review on 2026-05-17.
Recording them here so the rationale isn't lost between this doc and
the eventual implementation:

1. **Boards: real table, not enum.** Modelled now (§3.0). The enum
   stays in place for `events.height` and the dive picker; the new
   `boards` table is additive. Worth the extra v1 cost — re-fitting
   later would be a painful migration.
2. **Edit access.** Same-org org admins and meet managers can create
   and edit schedules. Everyone else can use the public timeline and
   iCal feed.
3. **Warmup defaults: auto-seed + editable.** 45-min warmup block
   inserted before every event when a session is created. Operator
   can drag, resize, or delete any of them. Described in §4.1.
4. **Duplicate-session-to-next-day.** Shipping in phase 3 (§2). New
   endpoint `POST /api/sessions/:id/duplicate` in §7.
5. **Conflict dismissal: per-conflict only.** Rule-based suppression
   ("ignore Judge X for this meet") was rejected — the click savings
   don't justify the risk of a genuinely new conflict being silently
   swallowed. Each dismissal is fingerprinted on the resource set
   at dismissal time so the warning resurfaces when membership
   changes. Detailed in §3 (dismissed_conflicts table) and §5.
6. **iCal export.** In scope for phase 1. One `VEVENT` per
   `schedule_block`, public endpoint, subscribers re-fetch on their
   client's cadence so re-flow shifts propagate without push.

## 9. Out of scope (explicitly)

These are the "but what about…" features I'm consciously *not*
building, even in v2, unless a concrete user asks:

- Constraint-solver auto-scheduling. The day's shape is judgment;
  computers don't know that the Slovak team's bus is always late.
- Multi-venue support beyond a free-text `pool` column.
- Per-judge availability windows ("Anna can only work mornings").
  Solved socially today; modelling it adds calendar UX overhead.
- A booking workflow for spectators ("reserve a seat for the
  final"). Different product.
