# DiveRecorder Wiki

User guide for DiveRecorder — how to actually use the app for a meet. For setup, deployment, and architecture see the main [project README](../../README.md).

## Pages

1. [**Home**](./Home.md) — what DiveRecorder is, how it's organised, where to start
2. [**Quick Start**](./Quick-Start.md) — sign up your federation and run your first meet
3. [**Roles & Permissions**](./Roles-and-Permissions.md) — who can do what
4. [**Setting Up a Meet**](./Setting-Up-a-Meet.md) — events, panels, rosters, templates
5. [**Running a Meet**](./Running-a-Meet.md) — the operator's playbook in the Control Room
6. [**Judging**](./Judging.md) — what judges see + how scoring works
7. [**Scoreboard**](./Scoreboard.md) — live broadcast + recap + Results Archive
8. [**Diver Portal & Profile**](./Diver-Portal.md) — dive lists, templates, analytics
9. [**Admin Tasks**](./Admin-Tasks.md) — users, clubs, teams, audit logs, records
10. [**Keyboard Shortcuts**](./Keyboard-Shortcuts.md) — Control Room hotkeys
11. [**FAQ & Troubleshooting**](./FAQ.md) — common questions + glossary

## Reading order

If you're brand new to DiveRecorder:

1. Read [Home](./Home.md) for the 5-minute overview
2. Skim [Roles & Permissions](./Roles-and-Permissions.md) to find your role
3. Read your role's page (Quick Start, Running a Meet, Judging, or Diver Portal)
4. Bookmark [FAQ](./FAQ.md) for when something looks weird

If you're standing up DiveRecorder for a federation, the **[Quick Start](./Quick-Start.md)** is the right entry point — it's a complete walk-through from "register your federation" to "run your first meet" in about ten minutes.

## Mirroring this to GitHub Wiki

This wiki currently lives in `docs/wiki/` so it's version-controlled with the code. If you'd rather host it on GitHub's native Wiki feature (separate `repo.wiki.git`):

1. On your GitHub repo, create the first wiki page through the UI (any content). This initialises the wiki repo.
2. Clone it locally: `git clone https://github.com/JediBrooker/DiveRecorder.wiki.git`
3. Copy each `.md` from `docs/wiki/` into the wiki clone (file names become page titles automatically — e.g. `Quick-Start.md` → "Quick Start" page).
4. Adjust internal links — GitHub Wiki uses bare names without `.md` (e.g. `[Quick Start](Quick-Start)` rather than `[Quick Start](./Quick-Start.md)`).
5. `git push` the wiki repo.

The screenshots in `docs/screenshots/` reference paths like `../screenshots/home.png` from inside `docs/wiki/`. If you mirror to GitHub Wiki, copy the screenshots into the wiki repo too and adjust the paths.
