# Scoreboard

The scoreboard is the audience-facing view. It works **anonymously** — no login, no token — so a spectator can open the URL on their phone, drop in halfway through a meet, and immediately see what's happening. It also drives the back-of-house projector via Broadcast mode and overlays an OBS feed via Stream mode.

![Live scoreboard](../screenshots/scoreboard.png)

## Two URLs

| Path | What you get |
|---|---|
| `/scoreboard` | Federation index. Live + Upcoming + Completed events listed; click into any. |
| `/scoreboard/<event-id>` | The live broadcast for one event. |

For a multi-event meet, the **meet landing page** at `/meet/<id>` is a better entry point — it lists every event in the meet with its status, and clicks through to the per-event scoreboard.

## Live broadcast layout

A three-column layout while the event is `Live`:

- **Left column — Completed Dives.** Every scored dive in the event so far. Each card shows the diver, country chip, club affiliation (with team chip when in a team event), dive code + DD + description, and the per-judge scores with FINA category colour-coding. Synchro events show role-grouped panels (Exec A / Exec B / Sync). Filter by diver or round at the top.
- **Centre column — Current Performer.** The active diver. Big diver name, country chip, dive code + DD + description, the live judge tile strip (each judge's score appears as it lands), the dive total when the panel completes, the **catch-up projection** (what the diver needs to overtake the leaders), and the Up Next list.
- **Right column — Standings.** Live rankings; tabs to switch between **Final** (running totals) and **By Round** (per-round leader, with up/down movement arrows between rounds).

When no diver is on the board (between divers, pre-meet) the centre flips to an **On Deck** preview showing the next-up performer with the same shape.

## Recap layout (completed events)

Once the meet manager finalises the event, the layout switches to a recap:

- **Podium spotlight** — top three with diver name, club, total score, country chip
- **Full standings** — every diver, their final total, club, podium medals
- **Dive-by-dive breakdown** — grouped by diver, every dive with all judge scores, FINA-category coloured, dropped scores struck through

PDFs (program, start list, score sheet, results) and a CSV export are one click away from the recap header.

## Catch-up projection

The cyan-tinted block in the centre column tells the audience and the diver themselves what they need to overtake the leaders.

- **Chasing** — `Catch-up — N dives left · currently 3rd` with a row per podium target: `1st  Lead Name  avg 7.5`. The "avg" is the **average judge score** the diver needs across the remaining dives to close the gap, **rounded up to the next achievable half-point** (judges only score in halves, so 5.2 isn't a possible target — 5.5 is). When the math is impossible (would need straight 10s and still come up short), the row reads "not possible".
- **Leading** — `Leading by +X.X` with the runner-up's catch-up math: what they'd need to overtake.
- **Pre** — `No completed dives yet. Lead Diver leads at X.X` — shown for the first diver of the meet.

## Per-round leaderboard pop

When the last diver of a round finishes, the operator can fire an **announce standings** prompt. The scoreboard flashes a full-screen overlay with the per-round leader, top 5, and movement arrows from the previous round. About 6 seconds, then back to the normal layout.

## Hold / Resume banner

If the operator holds the meet (video review, equipment failure, judge discussion), an amber banner spans the top with the reason text. The judge tiles dim slightly. The banner clears automatically when the operator resumes.

## Connection-lost banner

The scoreboard subscribes to the live socket; if your wifi or 4G drops, a red banner appears at the top: *"Connection lost — reconnecting…"*. It clears automatically when the socket comes back. The view freezes on the last-known state during a disconnect — you won't see incremental updates, but you also won't see stale data go silently wrong.

## Broadcast mode (venue projector)

For a back-of-house projector, append `?mode=broadcast` to the scoreboard URL or click **Broadcast** in the header. This:

- Hides the page chrome (header, footer, navigation)
- Scales fonts up so a back-row spectator can read everything
- Tints the background a deeper black for high-contrast projection

Same content, optimised for distance viewing. The Control Room has its own broadcast toggle (`/control?broadcast=1`) for an operator's back-of-house view.

## Stream Overlay (for OBS)

The header's **Stream Overlay** button gives you a transparent-background overlay perfect for compositing into a video feed:

- Lower-third strip with current performer + dive code + live judge scores
- Auto-fades when no performer is on the board
- Full-screen transitions for podium announcements

Drop the URL into an OBS Browser Source layer and key out the transparent regions.

## Public meet landing page

If the event is part of a multi-event meet, the meet's public page at `/meet/<id>` shows:

- **Meet hero** — name, dates, venue, federation logo, optional sponsor branding
- **Live / Upcoming / Completed counts** — at-a-glance status of how the meet is progressing
- **Event grid** — every event in the meet, status pill, click-through to its scoreboard
- **Printable program PDF** — one-click download of the full schedule, format, judges, age groups

## Results Archive

`/scoreboard` (with no event id) is also the **Results Archive** — a browseable index of every completed meet across the entire DiveRecorder install. Filters at the top:

![Results Archive](../screenshots/results-archive.png)

- **Search** — across event name, org name, country
- **Country** — list of every federation that's run a meet
- **Year** — chronological filter
- **Height** — 1 m / 3 m / 5 m / 7.5 m / 10 m
- **Club** — every club that's had a diver in any meet
- **Status** — Completed (default) / Live / Upcoming

Each event card shows the **competitor count** and **club count** so you can see meet size at a glance. PDFs are one click away.

A CSV export of the filtered list is available too — useful for federation reporting.

## Spectator-side performance

The scoreboard is **PWA-installable**. On iOS / Android / desktop Chrome, look for "Add to Home Screen" / "Install" — the page becomes a standalone app with a service-worker cache. Effects:

- **Faster reloads.** Cached assets serve instantly while the network update fetches in the background.
- **Resilient on flaky 4G.** A drop doesn't blank the page — the last good state stays painted.
- **No browser chrome.** Full-screen scoreboard on phones.

The scoreboard intentionally never asks for location, contacts, camera, or any other permission — installation is purely about caching and the chromeless launch experience.

## What spectators can NOT see

- Dive lists for events that aren't yet Live (locked to authenticated users — divers don't want their game plan public the day before)
- The score audit log (visible to org admins, referees, system admins via the Audit Log button)
- Pending records still under federation review
- Any data from a meet whose org status is `pending` or `suspended`

Everything else — every score, every standing, every PDF — is openly viewable without an account.
