# DiveRecorder — User Guide

DiveRecorder is a multi-tenant diving competition app. It runs the whole flow of a real meet: divers submit dive lists, judges score on phones, the operator drives the meet from a Control Room view, and the audience watches a live scoreboard. After the meet, the same data drives a public archive, per-diver analytics dashboards, and printable PDF programs / results.

This wiki is the **user guide** — how to use the app for a meet. For setup, deployment, and architecture see the main [README](../../README.md).

![Home page](../screenshots/home.png)

## I just want to…

| Goal | Page |
|---|---|
| Sign up my federation and run my first meet | [Quick Start](./Quick-Start.md) |
| Understand who can do what in the app | [Roles & Permissions](./Roles-and-Permissions.md) |
| Configure events, panels, and rosters before a meet | [Setting Up a Meet](./Setting-Up-a-Meet.md) |
| Drive scoring on the day | [Running a Meet (Control Room)](./Running-a-Meet.md) |
| Judge dives from a phone | [Judging](./Judging.md) |
| Watch a meet live (or on a venue projector) | [Scoreboard](./Scoreboard.md) |
| Submit a dive list / view my analytics as a diver | [Diver Portal & Profile](./Diver-Portal.md) |
| Manage users, clubs, teams, audit logs | [Admin Tasks](./Admin-Tasks.md) |
| Look up a keyboard shortcut | [Keyboard Shortcuts](./Keyboard-Shortcuts.md) |
| Diagnose something that looks wrong | [FAQ & Troubleshooting](./FAQ.md) |

## How DiveRecorder is organised

A meet is a bundle of **events** (e.g. *"2026 National Open"* contains 1 m M/F, 3 m M/F, 10 m M/F, synchro, team). Each event has its own dive lists, judges, and scoring, but they share the meet's landing page, results archive, and printable program.

```
Meet ─── Event ─── Roster (divers)
          │   └─── Panel  (judges + a referee)
          │   └─── Rounds (2 – 12)
          │
          └─── Event ─── …
```

A user belongs to **one organisation** (a country federation, a school, etc.) and optionally **one club** within it. Their role inside that org decides which screens they can open: divers see the diver portal, judges see the judging screen, meet managers see the operator dashboard, and so on. See [Roles & Permissions](./Roles-and-Permissions.md) for the full picture.

## The meet lifecycle

Every event goes through three statuses, and the UI you see depends on which one you're in:

- **Upcoming** — divers can still submit lists; the operator can edit the roster, randomise the start order, assign judges. Spectators can't see dive lists yet.
- **Live** — judges score over the socket; the audience-facing scoreboard is open; lists are frozen.
- **Completed** — results are public, podium is fixed, PDFs are downloadable.

A meet manager flips the status from the Control Room when it's time to start, and again at the end. There's no "edit history" mode — corrections after a dive use the [score-correction modal](./Running-a-Meet.md#correcting-a-score).

## Where to start

If you're an **org admin** standing up DiveRecorder for your federation for the first time, jump to the **[Quick Start](./Quick-Start.md)** — it walks you from "register your federation" to "run your first meet" in about ten minutes.

If you're a **diver, judge, or spectator** invited to an existing meet, your federation admin will have set up your account already; skip to your role's page in the table above.
