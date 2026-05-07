# Keyboard Shortcuts

DiveRecorder is built for fast operator hands. Most of the Control Room's flow control has a single-key binding so a meet manager can drive a fast round without reaching for the mouse.

## Control Room (`/control`)

| Key | Action |
|---|---|
| **←** | Previous diver |
| **→** or **Space** | Next diver |
| **1 – 9** | Jump to roster position N (within the current filter) |
| **T** | Reset shot clock to 30s |
| **F** | Failed dive — all judges' scores set to 0 for the current round |
| **R** | Re-dive — wipes the current round's scores; the diver redives |
| **H** | Hold / Resume — pauses the meet, broadcasts an amber banner |
| **L** | Leaderboard — flashes a full-screen top-5 standings overlay |

The shortcuts only fire when you're **not** typing in a text field — type in the search box and arrow keys still navigate the box, not the queue.

The hint chips at the bottom of the centre column document the same set so a new operator doesn't have to memorise them.

## What changed recently

Earlier versions of the Control Room had an `S` shortcut that **cycled the active-diver status** (READY → DIVING → JUDGING) manually. That's now [auto-cycled](./Running-a-Meet.md#active-diver-status) based on the shot clock + judge submissions, so the `S` key is no longer bound. The status pill is display-only.

## Scoreboard / Diver views

The audience-facing scoreboard, the diver portal, and the diver profile don't currently use keyboard shortcuts — they're built for touch and mouse. If you need keyboard navigation for accessibility, the standard browser shortcuts work (Tab, Enter, arrows in form controls).

## Browser-level shortcuts worth knowing

These work in any view, not just DiveRecorder, but they pair nicely with specific surfaces:

| Shortcut | Used for |
|---|---|
| **Cmd-P / Ctrl-P** | Export the diver-profile dashboard or any scoreboard view to PDF |
| **F11** | Full-screen the browser — turns any view into a kiosk |
| **Cmd-Shift-T / Ctrl-Shift-T** | Reopen the last closed tab — useful if you accidentally close the Control Room mid-meet |

For projector / venue use, **Broadcast mode** (`?broadcast=1` on `/control` or `/scoreboard/<id>`) hides the chrome automatically — F11 isn't needed.
