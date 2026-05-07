# Setting Up a Meet

A "meet" in DiveRecorder is a bundle of one or more **events**. The terminology mirrors World Aquatics:

- **Meet** — the calendar fixture (e.g. *"2026 New Zealand Nationals — 10–12 March"*). Has a name, dates, venue, optional sponsor logo, and zero or more events.
- **Event** — a single board-height + gender + format combination (e.g. *"Women 3 m Springboard"*). Has its own roster, panel, rounds, and scoring.

You can run a one-event "meet" by simply not creating a meet record and leaving the event as standalone — the scoreboard and archive both work either way. But for a multi-event championship, bundling them gives you a single landing page and a single printable program.

![Meet Manager](../screenshots/meet-manager.png)

## Creating a meet (the bundle)

From the dashboard, click **Meet Manager** → look for the **Meets** sub-tab (or go to `/manager` directly). Click **New Meet**.

Required:

- **Name** — `2026 NZL National Championships`
- **Start date / End date** — used by the public landing page and notification emails

Optional:

- **Venue / location** — free text
- **Sponsor name + logo URL + link** — surfaces in the meet's hero on the public landing page

A meet can stay empty — you'll attach events to it next. The meet's public landing page is at `/meet/<id>`.

## Creating events

The **New Event** form (left column of Meet Manager) has the following fields:

### Required

- **Event Name** — *"Women 3 m Springboard — Final"*. Shown in the scoreboard header and the printable program.
- **Event Type** — see *Event types* below.
- **Gender** — Male / Female / Mixed. Used in filters and headings.
- **Board / Platform Height** — 1 m, 3 m, 5 m, 7.5 m, 10 m. Filters the dive directory so divers can't pick a 5132D off the 1 m springboard.
- **Judge Panel Size** — 5 (individual default) or **9 / 11** (synchro). The number of rounds the panel scores does **not** depend on this — every round goes through the same panel.
- **Number of Rounds** — typically 5 – 6 for a senior final, 3 – 5 for a junior or trial event.

### Optional

- **Meet** — drop-down listing your federation's meets. Pick one to bundle this event into a meet. Leave as "Standalone (no meet)" for one-off events.
- **Age Group / Division** — free text. Use whatever your federation calls it: `U14`, `Open`, `Masters 30 – 34`, `Para`. Surfaces in the scoreboard header and the printable program.
- **Mixed-board event** — check if a single event mixes platform heights (rare but supported, e.g. a "Skills Trial" with one round each at 1 m / 3 m / 5 m). Each diver-round row gets its own height.
- **Per-round DD limits** — common in junior events. Cap rounds 1 – N to a max DD (e.g. "rounds 1 and 2 capped to DD 2.0"). Diver-side validation refuses lists that exceed the caps.
- **Scheduled start time** — feeds the meet schedule view and the "Meet went Live" email notifications.
- **Entries close at** — registration deadline. Past this point divers can't submit lists themselves; the meet manager has to use the **late-entry** override.

### Event types

| Type | Panel | Notes |
|---|---|---|
| **Individual** | 5 / 7 / 9 / 11 | Standard event. Each diver dives once per round. |
| **Synchro Pair** | 9 or 11 | World Aquatics synchro rule — exec A / exec B / sync sub-panels (see below). Two divers per entry. |
| **Team** | 5 / 7 / 9 / 11 | FINA Team Event — multiple members per team, mix of individual and synchro dives across rounds. |

#### Synchro panels

The 9 or 11 judges split into three sub-panels:

| Panel size | Exec A (Diver A's execution) | Exec B (Diver B's execution) | Sync (synchronisation) |
|---|---|---|---|
| 9 | Judges 1 – 2 | Judges 3 – 4 | Judges 5 – 9 |
| 11 | Judges 1 – 3 | Judges 4 – 6 | Judges 7 – 11 |

Judges see their assigned role (Exec A / Exec B / Sync) on the JudgeView so they know which slot they're filling. The Control Room and scoreboard display the three sub-panel groups visually.

DD multipliers are applied per the WA rule: synchro dive points = `(trimmed sum) × DD × 0.6`, normalised across panel sizes so dives stay comparable.

#### Team events

A team event is a single event entry where multiple members share a team. Each round, members take turns diving — sometimes individually, sometimes as a synchro pair. Setup:

1. Create the event with `event_type: team`.
2. From the event row, click **Manage Teams** → create one or more teams in the federation (or pick existing ones from `/teams`).
3. Link each team to the event via **Add Team to Event**.
4. Submit each team's bulk dive list — see [Running a Meet → Team events](./Running-a-Meet.md#team-events).

## Event templates

If you run the same event format every weekend (junior 1 m, U14 3 m, etc.), save the configuration as a **template**.

- From the New Event form, fill in all the fields, then click **Save as Template** before clicking Create. You'll be prompted for a template name.
- For future events, pick the template from the **Apply Template** drop-down at the top of the New Event form. Every field except the name pre-fills.

Templates are scoped per-org and keyed by name (overwrite-by-name, not append).

## Multi-stage progression

For championships that run a Preliminary → Semi-Final → Final chain, create the **prelim event first**. After it completes, click **Advance Top N →** on the event row. You'll be prompted for:

- **Stage** — Semi-Final or Final
- **Top N** — typically 18 for semi, 12 for final
- **New event name** — defaults to `<prelim name> — Semi-Final`

The server creates a new event with the same panel and rounds but a roster pulled from the top N of the prelim. The new event's dive lists carry forward from the prelim too — divers can edit them before the new event goes Live (subject to the deadline). The advance is **idempotent** — safe to re-run after a score correction.

The chain length is operator-defined. Synchro and team meets typically skip the semi.

## Mixed-board events

Tick **Mixed-board event** in the New Event form and the per-diver-round rows accept a height column. Each round has its own height per diver. Used in:

- Skills trials (one round at each board)
- Multi-round judging certifications (judges score across heights)
- Custom fixtures that don't fit the single-height pattern

The dive directory filter applies per-row — pick a 1 m height for round 1 and the dive search filters to 1 m dives only.

## CSV roster import

If you have your roster in a spreadsheet, click **Import Roster** on the event row and paste a CSV. Format:

```
username,round_number,dive_code,position
diver_alpha,1,101,B
diver_alpha,2,201,B
diver_alpha,3,301,B
diver_bravo,1,103,C
…
```

The server creates all the dive list rows in one transaction. Per-row errors (unknown username, invalid dive code, DD over the per-round cap) are reported back with line numbers; the rest of the import succeeds.

For mixed-board events, add a `height` column.

## Setting up the panel

From the event row, click **Assign Judges** → pick judges from your federation's user list. Order matters: the first judge you pick becomes Judge 1, the second Judge 2, etc. — this maps to the synchro sub-panel slots above.

The same pattern works for **referees**, but a referee isn't on the panel — they're the supervising official. Add at least one referee to your federation (from User Manager); the **Sign Off** step in the Control Room workflow needs one to authorise the event going Live.

## Pre-meet checklist

Before flipping the event to Live, the Control Room enforces a four-step pre-meet workflow:

1. **Red — Check In Divers** — opens the check-in modal so the operator can mark who actually showed up.
2. **Orange — Randomise Dive Order** — operator can skip if they manually re-ordered; otherwise this writes a random `display_order` per diver.
3. **Yellow — Referee Sign Off** — referee enters credentials (or taps a push notification) to confirm the panel is valid.
4. **Green — Start Event** — flips status Upcoming → Live and broadcasts to all judges' phones.

See [Running a Meet](./Running-a-Meet.md) for the operator's perspective.

## Common pitfalls

- **Forgetting to set the panel size for synchro.** A 5-judge synchro panel doesn't have an Exec A / Exec B / Sync split — the WA rule needs 9 or 11 judges. The Create Event form doesn't enforce this; you'll see judges scoring without role hints if you misconfigure.
- **Setting `entries_close_at` in the past.** Divers can't submit. Meet manager has to use the late-entry override for every diver. Just leave it null while testing.
- **Mixing teams across federations in a Team event.** All teams in a team event must belong to the same org. The UI filters this for you, but a direct API call won't.
- **Forgetting the referee.** The yellow Sign Off step blocks Start Event until a referee authorises. Set them up before the meet day.
