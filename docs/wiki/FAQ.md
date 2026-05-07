# FAQ & Troubleshooting

Common questions, error states, and "why is X happening" answers, plus a glossary of terms used elsewhere in the wiki.

## Setup

### "I just registered my federation, but I can't sign in"

New federations land in `pending` status. The system administrator (the person running the DiveRecorder server) needs to approve it. If you self-host, the bootstrap `admin` account can approve from User Manager → org filter → status = pending.

### "Where do I get the system admin account?"

`init.sql` creates one on first install: username `admin`, password `admin`. **Change the password immediately** from User Manager. If you've lost it, a sysadmin with database access can reset:

```sql
UPDATE users
SET password = crypt('new-password', gen_salt('bf'))
WHERE username = 'admin';
```

### "Email isn't sending — registration didn't get a welcome message"

Without `SMTP_HOST` set in `.env`, the email helpers silently no-op. Configure SMTP if you want welcomes / password resets / meet notifications:

```
SMTP_HOST=smtp.your-provider.com
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_FROM="Dive Recorder <noreply@your-domain>"
```

`APP_BASE_URL` also needs to be set so reset-password links point at the right host.

## Running a meet

### "The Start Event button is greyed out"

You're missing one of the four pre-meet steps. The button is gated on:

1. Check-in modal completed (red → orange)
2. Dive order randomised or manually set (orange → yellow)
3. Referee sign-off (yellow → green)

If you've skipped one (e.g. randomise) the workflow button stays the colour of the missing step. Click it to advance.

### "I can't add a diver — entries closed"

Past `entries_close_at`, divers can't self-submit lists. The meet manager has the **late-entry override** at the top of the Diver Queue panel (**+ Add**). It works after entries close.

### "A judge isn't seeing the active diver update"

Check their connection pill (top of the judge view). If it's amber for more than a few seconds, they've lost the socket. Common causes:

- Phone went to sleep — keep the screen on or use the PWA-installed app
- Wifi flake — try mobile data or a different access point
- Two devices logged in for the same judge — one will be kicked, ask them to use only one

If their pill is green but they're not seeing updates, the meet manager can verify the panel assignment is correct (the judge might be on the wrong event).

### "A score landed wrong — how do I fix it?"

In the Control Room, click the dive's history card on the left column. The **Score Correction** modal opens with editable per-judge scores and a required reason field. Enter the correct value + reason, click Apply. The change is audit-logged.

### "An entire round needs to be re-done"

Click **Re-Dive** (or press R) on the active diver block. Wipes the current round's scores; the diver redives. The original attempt stays in the audit log with an "amended" marker.

For a whole panel mistake (wrong judges seated, wrong dive code), open the audit log and contact your org admin — bigger corrections need a paper trail.

### "The shot clock is wrong / running too long"

It auto-starts at 30s when a new diver is set. Click the face to pause/resume, click ↻ to reset, or press T. If divers consistently need more time (warm-up between rounds, equipment), the operator can pause manually.

## Synchro events

### "Why does my synchro event need 9 or 11 judges?"

World Aquatics rule. The panel splits into three sub-groups: Exec A (Diver A's execution), Exec B (Diver B's execution), Sync (synchronisation). Mathematically you need at least 2 + 2 + 5 = 9 judges to fill all three groups with the right roles.

A 5-judge synchro panel doesn't have the role split — you'd just get five generic judges and the WA scoring formula won't work correctly. The Create Event form lets you pick 5 for synchro, but it's effectively misconfigured.

### "Synchro pair from two countries — only one country chip showing"

The composable shows a second chip only when the partner's country differs from the lead's. If both divers are flagged the same country in your DB, only one chip renders (intentional — it'd be a duplicate). Check the partner's account — their `country_code` (org-level) should differ.

## Records

### "I broke a record but it's not showing on the federation page"

Federation records require **org admin sign-off** before publishing. They land in `pending_federation_records` and stay there until an org admin approves them on the records page. Personal and club records auto-publish without sign-off.

### "An old record didn't update — my new score was higher"

`checkAndApplyRecords` runs on every score insert AND on event finalise. Both paths compare against the current record. If neither updated:

- Was the score actually higher than the existing record? Check the records page for the current value.
- Was the dive at the same `(dive_code, position, board_height)`? Records are keyed on all three.
- Did the event's height match the records page? A 3 m record only updates from 3 m dives.

If all three check out and it's still wrong, the system admin can re-run the records check via SQL — contact them.

## Authentication

### "I forgot my password"

Click **Reset it** on the login page. Enter your username + email; you'll get a single-use link valid for 30 minutes. Use it from any device.

### "The reset link doesn't work / says 'expired'"

The link is single-use AND time-limited. Causes of failure:

- 30 minutes have passed → request a new link
- Someone else (or you, on another device) already used the link → request a new one
- Your password was changed via another path between request and click → request a new one (the bcrypt fingerprint guard kicks in)

### "I need to log out everywhere"

Change your password from your account settings. Every existing JWT for your user becomes invalid (token version is bumped server-side); every session is forced to re-login.

The system admin can also force a logout for any user from User Manager — useful if a phone is lost.

### "Two-factor authentication?"

DiveRecorder doesn't currently support TOTP/2FA. Org admins can mitigate with strong passwords and the email-verified gate (a new account can't log in until the email is verified). 2FA is planned for a future release.

## Performance

### "The scoreboard feels sluggish"

The scoreboard is PWA-installable — install it for faster reloads, service-worker caching, and offline resilience. On iOS / Android Chrome, look for "Add to Home Screen" / "Install".

If install isn't available and the live broadcast is consistently slow, check:

- Your network — websockets need stable bandwidth, not just throughput
- The number of events open simultaneously — each subscribes to its own room, ten tabs is heavy
- Browser memory — Safari especially throttles backgrounded tabs aggressively

### "My dive list submission keeps timing out"

Per-round DD validation runs server-side. If the validation hits a slow path (e.g. recomputing every dive's points across 10 rounds), it can hit the 30s default timeout. Solutions:

- Submit fewer rounds at a time (the form doesn't enforce all-or-nothing)
- For very long lists (12+ rounds), the meet manager has a CSV import that's much faster

### "PDF export taking forever"

The bigger PDFs (meet program with 80 events, results PDF for a 200-diver meet) can take 5 – 10 seconds. The download starts only when the server has finished generating; if your browser shows nothing happening, give it a minute. If it's truly stuck, check `/api/health` to see if the server is up.

## Glossary

### DD (Degree of Difficulty)

A multiplier specific to each dive at each board height. Higher DD = harder dive. From the dive directory — DiveRecorder ships with all ~830 World Aquatics dives.

### Trim rule

For panels of 5+, the highest and lowest scores are dropped before summing. For 9+, the top 2 and bottom 2 are dropped. For 11, top 3 and bottom 3. This is the FINA rule — it limits a single rogue judge's influence on a dive's points.

### Synchro sub-panels

The 9 or 11 judge panel splits into three groups: Exec A (judges scoring Diver A's execution), Exec B (judges scoring Diver B's execution), and Sync (judges scoring how well the pair stayed together). See [Setting Up a Meet](./Setting-Up-a-Meet.md).

### Per-round DD limit

A cap on the maximum DD a diver can pick for round N. Common in junior events to prevent unsafe-for-age dives. Set per event in the Create Event form.

### Personal Best (PB)

Your highest dive points on a specific `(dive_code, position, board_height)` combination. Auto-set on score insert via `checkAndApplyRecords`.

### Catch-up math

The cyan-tinted block on the live scoreboard that tells the audience what the active diver needs from the panel to overtake the leaders. Rounded up to the next 0.5 because judges only score in halves. See [Scoreboard](./Scoreboard.md).

### FINA category

The colour-coded score buckets the audience sees on per-judge tiles:

| Score | Category |
|---|---|
| 10.0 | Excellent |
| 8.5 – 9.5 | Very good |
| 7.0 – 8.0 | Good |
| 5.0 – 6.5 | Satisfactory |
| 2.5 – 4.5 | Deficient |
| 0.5 – 2.0 | Unsatisfactory |
| 0.0 | Failed |

The boundaries match the official WA judging guidelines so the colour treatment matches what an experienced spectator expects.

### Token version

A small integer on each user's record. The current value is signed into every JWT. When the user changes their password or an admin grants/revokes a role, the version increments — every existing token becomes invalid the next request, forcing re-login. The "log them out everywhere" hammer.

### Audit log

A row inserted on every score change (insert / update / delete) and every role change (grant / revoke). Captures the actor, IP, user agent, old + new value, and a reason field. 30-day retention by default. See [Admin Tasks](./Admin-Tasks.md).

### Event status

`Upcoming` (lists open), `Live` (judges scoring), `Completed` (recap published). The meet manager flips status; the rest of the app reacts.

### Sign-off (referee)

A pre-meet step where the licensed referee authorises the panel. Required before the event can flip to Live. Either a password or an approved push notification on the referee's phone — both write the same audit row.
