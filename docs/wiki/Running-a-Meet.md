# Running a Meet (Control Room)

The Control Room (`/control`) is the operator's cockpit during a live meet. It's where the meet manager picks the active diver, advances rounds, fires referee actions, holds and resumes the meet for video review, and corrects scores after the fact.

This page covers the full eight-hour day. If you're new, do the [Quick Start](./Quick-Start.md) first to set up an event, then come back here.

## Layout

The Control Room is a three-column layout:

- **Left column — Completed Dives.** Every scored dive in the event so far. Each card shows the diver's name + country chip, club affiliation, dive code + DD + description, and the per-judge scores with FINA category colour-coding. Click any card to open the **score correction** modal.
- **Centre column — Currently on Board.** The active diver (or "On Deck" preview if you haven't picked one yet). Big diver name, country chip, dive code + DD + description, the live judge tiles, and the **catch-up projection** for the active diver below the rank line.
- **Right column — Diver Queue.** Up Next (next 5 by default, expandable), the full Dive Order panel, and the Top 5 Right Now standings preview with podium-target catch-up math.

The header carries the event picker, connection status pill, and three nav buttons: **Broadcast** (kiosk-mode operator view for venue projectors), **Stream Overlay** (a transparent overlay for OBS), and **Dashboard** (back).

## The pre-meet workflow button

Before the event flips to Live, the centre column shows a single big button that walks through four states. Each click waits a deliberate dwell before progressing — so a watcher can see the colour change.

| Colour | Step | What it does |
|---|---|---|
| **Red** | Check In Divers | Opens the check-in modal. Tick everyone present, click Continue. Uncheck anyone who didn't show up — they're hidden from the start list. |
| **Orange** | Randomise Dive Order | Writes a random `display_order` per diver. Skip if you've already manually arranged the order. |
| **Yellow** | Referee Sign Off | Opens the sign-off modal. Referee types their password or taps an approved push notification. |
| **Green** | Start Event | Flips status Upcoming → Live, broadcasts `state_update` to all judges' phones. |

Each click is **idempotent** — re-clicking just re-runs the step. You can re-check in divers (a late arrival) and re-randomise as many times as you want, until the event goes Live.

## During scoring

### Setting the active diver

Click any row in the **Diver Queue** (right column) to make that diver the active diver. The centre column updates immediately, judges' phones receive the new `state_update`, and the audience-facing scoreboard shows the new performer.

You can also use **keyboard shortcuts** (full list at [Keyboard Shortcuts](./Keyboard-Shortcuts.md)):

- **←** / **→** or **Space** — previous / next diver
- **1 – 9** — jump to roster position N

### The shot clock

A 30-second shot clock auto-starts when a new active diver is set. The big timer in the top-right of the centre column counts down. Click the face to **pause / resume**, click ↻ to **reset**, or press **T**.

The clock turns amber at 10 s, red at 5 s, and flashes when it hits 0. Per WA rules, the diver must have begun their dive by then — the operator should typically not need to intervene.

### Active diver status

The pill below the diver name auto-cycles based on what's happening:

| Status | When it shows |
|---|---|
| READY | Diver is on the board, no scores yet, shot clock still ticking |
| DIVING | Shot clock has expired; the diver must have started |
| JUDGING | At least one judge has submitted a score for this round |

The status broadcasts to the audience-facing scoreboard so the spectator strip ticks through the same phases.

### Auto-advance

The drop-down in the centre header (`Auto-next: Manual / 5s / 10s / …`) controls whether the next diver is picked automatically once the panel is full. Manual is the default — operator clicks **Next Diver** themselves. Pick a delay if you want the meet to flow without input (typically 10 – 15 s for the audience to applaud and the next diver to walk up).

The same delay governs the round-end **announce standings** prompt — once the last diver of a round scores, you get a few seconds before the auto-advance fires the standings overlay.

### Hold / Resume

If you need to pause the meet (video review, referee discussion, equipment failure), press **H** or click the **Hold** chip. A modal asks for an optional reason. Once held:

- An amber banner appears on the spectator scoreboard with the reason text.
- Judge submit buttons are disabled.
- The shot clock pauses.
- Auto-advance is cancelled.

Press **H** again or click **Resume** to lift the hold.

### Referee actions

The three coloured buttons under the active diver block:

| Button | Effect |
|---|---|
| **Failed Dive** (red) | All judges' scores for this round set to 0. The audit log records the actor + reason. |
| **Cap Score (Max 2.0)** (amber) | Same as above but capped to 2.0 — used for "balk" or partial-attempt rules. |
| **Re-Dive** (cyan) | Wipes the current round's scores; the diver redives. The original attempt is preserved in the audit log with an "amended" marker. |

These also broadcast the action to judges' phones so the panel knows the dive was officially failed / capped / redived.

You can also hit **F** for failed and **R** for redive without leaving the keyboard.

## Correcting a score

Click any completed dive card in the left column. The **Score Correction** modal opens with:

- The list of judges and their original scores
- An editable score field per judge
- A **Reason** text field (required)

Pick a judge, edit their score, type a reason, click Apply. The change is **audit-logged** with:

- Old value + new value
- Actor (your user)
- Reason text
- IP + user agent
- Timestamp

The audit row is visible to org admins, referees, and system admins via `/events/<id>/audit` (also accessible from the **Audit Log** button on the event row in Meet Manager).

The diver's totals + standings + records all recompute on the fly. The recap PDFs and archive views update automatically.

## Late entries

If a diver shows up after entries have closed, click **+ Add** at the top of the Diver Queue panel. The late-entry modal lets you:

1. Pick a diver from your federation's user list (or create a new account on the fly)
2. Enter their dive list for each round (defaults to the most popular dive for that round and panel)

The diver lands in the queue at the end of the current round. They keep all scoring rights and appear in standings + archive normally.

## Withdrawing or scratching a diver

Click the **⋯** menu on the diver's queue row → **Withdraw**. The diver is hidden from the active queue but their existing scores stay in the audit log + history. Click again to **Reinstate**.

Use **Scratch** for a diver who never started — they're removed from the standings entirely.

## Synchro events

The Control Room shows synchro pairs as a single row with both names: *"1. Lead Name & Partner Name"* with two country chips when the divers are from different countries (international synchro). The judge tiles split into Exec A / Exec B / Sync sub-panels, each labelled with its role.

The history cards in the left column also show the pair as one entry with grouped per-judge scores: Exec A scores, Exec B scores, Sync scores.

## Team events

For team events (`event_type: team`), each team has a **bulk dive list** rather than individual lists. Click the team's row in the queue → **Edit Team List** to:

- See every team member's per-round dive
- Swap dives between rounds (drag-and-drop)
- Sub a member off and another on for a specific round
- Add or remove a synchro pair within the team's roster

The roster panel shows each team grouped together; advancing through the queue dives in the order the bulk list specifies.

## Round-end behaviour

Once the last diver of a round scores their last judge, the operator gets a prompt: **"Announce standings for Round N?"**. Click yes and the spectator scoreboard flashes a full-screen leaderboard for ~6 seconds (per the auto-advance delay). The announcement event is captured in the audit log.

You can preview the leaderboard at any time with **L** or by clicking the **Top 5 Right Now** chip.

## Finalising the event

When the last round is complete, the **Next Diver** button changes to **Finalise Event ✓**. Click it to:

- Flip status Live → Completed
- Re-run the records check (`checkAndApplyRecords`) — any new personal best, club record, or federation record is stamped
- Switch the public scoreboard to recap mode (podium spotlight + full standings + dive-by-dive)
- Make the event visible in the public Results Archive
- Send the *"Results posted"* email to every competitor (if SMTP is configured)

Finalising is **reversible** by an org admin (open the event in Meet Manager → set status back to Live), but reversing means the audience-facing recap disappears until you re-finalise.

## Operator tips

- **Use Broadcast mode for the back-of-house projector.** Open `/control?broadcast=1` in a separate browser window on the projector machine. The chrome is hidden and fonts scale up. Same controls though — the operator drives from their laptop, the projector mirrors the centre + queue.
- **Check the connection pill** (top-left, next to the event picker). If wifi is patchy and the pill flips to red, scoring will queue locally but won't reach the server. Don't keep scoring during a disconnect — wait for the pill to go green.
- **The Top 5 Right Now panel updates after every dive.** Scan it between divers to spot whoever's catching up; the **catch-up math** below it tells you the average judge score the active diver needs to overtake the leaders. Numbers are rounded UP to the next 0.5 since judges only score in halves (so "needs avg 5.5" not "needs avg 5.2").
- **Keyboard shortcuts beat clicking** for everything except the queue. Memorise ←/→ (advance), T (reset clock), H (hold), F (fail), R (redive), L (leaderboard) and you'll never reach for the mouse during a fast round.

## Next steps

- [Judging](./Judging.md) — what judges see while you're driving the meet
- [Scoreboard](./Scoreboard.md) — what the audience sees
- [Keyboard Shortcuts](./Keyboard-Shortcuts.md) — the cheat sheet
