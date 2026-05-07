# Diver Portal & Profile

DiveRecorder has two diver-facing surfaces:

- **Competitor view** (`/competitor`) — submit a dive list for an upcoming event, save and re-use templates, watch the live scoreboard for events you're in.
- **Diver Profile** (`/profile/<id>`) — a public-ish dashboard with your career stats, personal bests, score-trend sparkline, and a customisable analytics panel.

Both work on phone (most divers use phones) or desktop.

## Submitting a dive list

From the dashboard, tap **Diver Portal**. You'll see a list of every event you're eligible for — events in your federation that are `Upcoming` and haven't passed `entries_close_at`.

Pick one. The dive list builder shows:

- **One row per round** — round 1, round 2, …, round N
- **Dive picker per row** — autocomplete on the dive code (101, 105B, 5132D, …) filtered to the event's board height
- **DD column** — auto-populated from the dive directory once you pick a code
- **Description column** — the human label ("Forward 2½ Somersaults Pike")

Type the first few characters of a dive code (e.g. `103`) and the autocomplete shows matching dives at the event's height. Pick one with the keyboard or tap. The DD and description fill in automatically.

### Per-round DD limits

If the event has per-round DD caps (common in junior events: "rounds 1 and 2 capped to DD 2.0"), a chip shows the cap above the row. Picking a dive that exceeds the cap is blocked — the row stays red until you change it.

### Synchro entries

For synchro events, the form includes a **Synchro Partner** picker at the top. Type the partner's name; the autocomplete filters to fellow divers in your federation. Pick one and the partner_id is bound to every dive list row you submit.

The partner doesn't have to also submit a list — your submission carries both names. They WILL need an account in your federation though; they show up as the partner_id on every diver-round row.

### Submitting

Click **Submit Dive List**. The form validates:

- Every round has a dive
- Every DD respects the per-round cap
- The partner_id (if synchro) is a valid diver in your org

Once submitted, your name appears in the event's roster on the operator's Control Room. You can re-submit any time before the event goes Live (or before `entries_close_at` for fully gated events) — the new list overwrites the previous one.

## Templates

Once you've built a list, click **Save as Template**. Pick a name (e.g. `"3m Optionals — 2026"`). For your next event, the template appears in the **Apply Template** drop-down at the top of the form — apply it, tweak round-by-round if needed, submit.

Templates are scoped per board height — a 3 m template won't appear when you're entering a 10 m event. They're saved per-user, so your teammates don't see your templates.

A coach role can also save and load templates on behalf of their linked divers.

## Diver Profile

![Diver Profile](../screenshots/diver-profile.png)

The diver profile (`/profile/<id>`) is **publicly viewable** by default — anyone with the URL can see your career stats. URLs use an opaque slug (not a numeric id), so they're not enumerable from outside.

### Headline stats

The top of the profile shows:

- **Meets entered** — total events you've competed in
- **Dives performed** — across every meet
- **Average DD attempted** — arithmetic mean of your dive lists' DD
- **Best single dive** — your highest-ever dive points (judges trimmed × DD)
- **Score-trend sparkline** — SVG line of total scores across meets

### Personal bests

A table keyed by `(dive_code, position, board_height)`. Each row:

- Best dive points you've achieved on that combination
- Number of attempts at that combination
- "First set at" — the meet where you first hit that PB

This is the raw form — the analytics dashboard below has prettier widgets that draw from the same data.

### Self-serve analytics dashboard

Click **Customize** to pick which widgets show up. Catalog:

- **Score Trend** — line chart of meet totals over time
- **Personal Bests** — same data as the table above, formatted as cards
- **Recent Form** — last 5 meets with your rank "/ of N"
- **Medal Counts** — gold / silver / bronze / finalist / 9th+ totals across your career
- **Height Breakdown** — average + best score per board height, with bars
- **Round-by-Round Form** — per-round average score, with an automatic insight ("you finish strong" / "you fade" / "even pacing")
- **Score Quality Mix** — distribution of your dives across FINA categories (excellent / very good / good / satisfactory / deficient / unsatisfactory / failed)
- **DD Risk Profile** — average + max DD attempted, with how you score at the top end
- **Go-To Dives** — most-attempted dives with avg + best
- **Current Streak** — consecutive podiums or wins (auto-hides when you don't have one)
- **Compare-to-Peers** — your stats vs the org average (anonymous aggregate)
- **Event-Type Splits** — individual vs synchro vs team performance
- **Year-over-Year** — this season vs last

Each widget pulls live data — no caching, no manual refresh. Drag widgets to reorder them in the Customize modal; the order persists per-user.

### Date range filter

The top of the dashboard has a **From / To** date filter that applies to **every widget** simultaneously. Useful for "show me my last 3 months" or "season 2024 only".

### Export Dashboard PDF

Cmd-P / Ctrl-P opens a **print-friendly view** of the dashboard with widget tiles laid out on letter-sized pages. Save as PDF — useful for coach reviews, college recruiting, or sponsor reports.

## Compare two divers

`/compare?a=<diver-id-a>&b=<diver-id-b>` shows two divers side-by-side:

- Headline stats per diver, in two columns
- Per-dive PB diff — for every dive code + position both divers have attempted, who has the better PB and by how much
- Score-trend overlays on a single chart

Useful before national selections or for coaches comparing rivals. Both divers' profiles must be public (default) for the compare view to render.

## Public sharing

A diver's profile URL is shareable with anyone — sponsors, college coaches, family. The URL contains an **opaque slug** (not a numeric id), so:

- People can't enumerate `/profile/1`, `/profile/2`, … to harvest profiles
- The slug isn't your username, so it doesn't expose your login

If you want your profile **private** (visible only to you, your coach, and the org admin), there's a privacy toggle in your account settings — coming in a future release.

## Coach access

If a coach is linked to you (via `coach_diver_links`, approved by your org admin), they see:

- Your full profile + analytics dashboard
- Per-judge breakdowns of every score you received (the panel-by-panel detail isn't public)
- Your saved templates — and they can save new ones to your account

The coach link is bidirectional and visible in your account settings. You can request an unlink at any time.

## Cross-org browse

The **Diver Search** at `/divers` lets anyone (logged in or not) find a diver by name across every federation on the platform. Click a result to land on their public profile. Useful for finding a diver whose federation slug you don't know.
