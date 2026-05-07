// UI-driven version of the scoring pipeline test, paced like a
// real meet: 3 divers × 3 rounds = 9 dives, with the active-diver
// banner pushed to the scoreboard a moment BEFORE the judges'
// scores land, so a watching human can see who's up, watch the
// scores come in, and watch the standings shift.
//
// The headless scoring.spec.js verifies the same pipeline as fast
// as possible. This spec optimises for *visibility*, not speed —
// don't run it in CI.
//
// Run it headed to watch:
//   npx playwright test test/e2e/scoreboard-ui.spec.js --headed --workers=1
//
// Tunable timings — env-overridable so you can speed it up or
// slow it down without editing the file:
//   PW_PRE_DIVE_MS    delay between active-diver banner appearing
//                     and the first judge's score (default 1500)
//   PW_PER_SCORE_MS   delay between consecutive judges (default 250)
//   PW_POST_DIVE_MS   delay after a diver's last score before the
//                     next diver gets the active banner (default 1200)
//   PW_FINAL_HOLD_MS  hold on the final standings before teardown
//                     (default 5000)

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

const PRE_DIVE_MS    = Number(process.env.PW_PRE_DIVE_MS    ?? 1500);
const PER_SCORE_MS   = Number(process.env.PW_PER_SCORE_MS   ?? 250);
// Pause AFTER the dive's last score lands so the watcher can
// read the inline pills + Dive Total + ranking line before the
// next diver is announced (which would clear them).
const POST_DIVE_MS   = Number(process.env.PW_POST_DIVE_MS   ?? 2500);
const FINAL_HOLD_MS  = Number(process.env.PW_FINAL_HOLD_MS  ?? 5000);

test.describe.configure({ mode: "serial" });

test("watch a 3-diver, 3-round meet end-to-end with realistic pacing", async ({
  request, page, baseURL,
}) => {
  // Plenty of head-room: 9 dives × ~3.5s per dive = ~32s, plus
  // setup + final hold + teardown.
  test.setTimeout(180_000);

  // ============================================================
  // PHASE 1 — silent API setup (no UI). 3 divers, 3 rounds, a
  // different dive each round so the DDs (and therefore totals)
  // vary realistically.
  // ============================================================
  const { orgId, username: adminUsername, adminToken } =
    await setup.createOrgAndAdmin(request);

  const TOTAL_ROUNDS = 3;
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Live Meet — 3 divers × 3 rounds",
    number_of_judges: 5,
    total_rounds: TOTAL_ROUNDS,
    height: "3m",
  });
  const eventId = event.id;

  const divers = [];
  for (const name of ["Diver Alpha", "Diver Bravo", "Diver Charlie"]) {
    const d = await setup.insertUser({ orgId, role: "diver", fullName: name });
    divers.push({ ...d, fullName: name });
  }

  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({
      orgId, role: "judge", fullName: `Judge ${i}`,
    });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, {
    adminToken, eventId, judgeIds: judges.map((j) => j.userId),
  });

  // Three dives the dive_directory has at 3m / position B. Mix of
  // groups so the DDs aren't identical — Front, Back, Reverse.
  // The hard-coded DDs match what the directory ships in init.sql
  // (101B=1.5, 201B=1.8, 301B=1.9 at 3m); we use them to compute
  // the per-dive total client-side so we can flash it on the
  // SPA's score-overlay via announce_score.
  const diveCodes = [
    { dive_code: "101", position: "B", dd: 1.5 },   // Forward 1½ pike
    { dive_code: "201", position: "B", dd: 1.8 },   // Back 1½ pike
    { dive_code: "301", position: "B", dd: 1.9 },   // Reverse 1½ pike
  ];
  const dives = [];
  for (const dc of diveCodes) {
    dives.push(await setup.pickDiveId({
      height: 3.0, dive_code: dc.dive_code, position: dc.position,
    }));
  }

  // Each diver gets the same 3 dives across the 3 rounds. Real
  // meets vary by diver — fine for a demo.
  for (const d of divers) {
    await setup.insertDiveList({
      eventId,
      competitorId: d.userId,
      dives: dives.map((dive_id, i) => ({ round_number: i + 1, dive_id })),
    });
  }

  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });

  // ============================================================
  // PHASE 2 — drive the SPA. THIS is what shows on screen.
  // ============================================================
  // Cyan ring at every pointerdown so a headed-mode watcher can
  // see where the test is clicking. Off in CI via E2E_HIGHLIGHT=0.
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(adminUsername);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/);
  await page.goto(`/scoreboard/${eventId}`);

  // Wait for the scoreboard SPA to mount + connect its socket so
  // the state_update broadcasts we're about to fire actually
  // reach a subscribed client. The .sb-name placeholder ("Waiting...")
  // is rendered as soon as the view mounts, before any data arrives.
  await expect(page.locator(".sb-name")).toBeVisible({ timeout: 10_000 });

  // The Up Next panel + the centre On-Deck slot together show
  // every remaining dive. With no active diver yet, the centre
  // hoists the head of the queue into its own block (labelled
  // "On Deck — Up Next") and the row list excludes that diver,
  // so we see 8 rows here + Diver Alpha in the centre block.
  // 3 divers × 3 rounds = 9 total upcoming.
  const upNextRows = page.locator(".up-next-row");
  await expect(upNextRows).toHaveCount(8, { timeout: 5_000 });
  // Centre on-deck block should show Diver Alpha (alphabetical
  // first since display_order is unset in the fixture) along
  // with the 101 B dive at DD 1.5.
  const centreLabel = page.locator(".sb-label");
  await expect(centreLabel).toContainText(/On Deck/i);
  const centreName = page.locator(".sb-name");
  await expect(centreName).toContainText("Diver Alpha");
  await expect(page.locator(".sb-code").first()).toContainText("101");
  await expect(page.locator(".sb-dd").first()).toContainText("1.5");
  // First Up-Next row is the SECOND in the queue — Diver Bravo
  // R1 dive 2.
  await expect(upNextRows.nth(0)).toContainText("R1");
  await expect(upNextRows.nth(0).locator(".up-next-pos")).toHaveText("2");
  await expect(upNextRows.nth(0).locator(".up-next-name")).toContainText("Diver Bravo");

  // Screenshot the live view so a watching human can compare the
  // up-next panel against the eventual recap. Saved alongside
  // the post-completion screenshot below.
  await page.screenshot({
    path: `test-results/scoreboard-live-${eventId}.png`,
    fullPage: true,
  });

  // ============================================================
  // PHASE 3 — simulate the meet. Round-major order (round 1 for
  // every diver, then round 2, …) — that's how real meets run.
  // ============================================================
  //
  // We need:
  //   * one admin socket to emit set_active_diver (gated to
  //     org_admin / meet_manager / referee role)
  //   * five judge sockets to submit scores
  //
  // Open them once up front, reuse across rounds. Pulling them
  // up into outer scope also lets us close them cleanly at the
  // end.
  async function adminLogin() {
    const r = await setup.loginAs(request, adminUsername);
    return r.token;
  }
  const freshAdminToken = await adminLogin();

  function openSocket(token) {
    return new Promise((resolve, reject) => {
      const sock = io(baseURL, {
        auth: { token },
        transports: ["websocket"],
        reconnection: false,
      });
      sock.on("connect", () => resolve(sock));
      sock.on("connect_error", reject);
      setTimeout(() => reject(new Error("connect timeout")), 5000);
    });
  }

  const adminSocket = await openSocket(freshAdminToken);
  adminSocket.emit("subscribe_event", { event_id: eventId });

  const judgeSockets = [];
  for (const j of judges) {
    const s = await openSocket(j.token);
    s.emit("subscribe_event", { event_id: eventId });
    judgeSockets.push(s);
  }

  // Score profiles per diver — different "skill levels" so the
  // standings actually have a meaningful order. Diver Bravo wins,
  // Alpha is mid-pack, Charlie struggles.
  const scoreProfiles = {
    "Diver Alpha":   [7.0, 7.5, 8.0, 7.5, 7.0],   // sum trim = 22.5
    "Diver Bravo":   [8.5, 9.0, 9.0, 8.5, 9.0],   // sum trim = 26.5 (wins)
    "Diver Charlie": [5.5, 6.0, 6.5, 6.0, 5.5],   // sum trim = 17.5
  };

  function scoreReceivedOnce(sock) {
    return new Promise((resolve, reject) => {
      const onAck = () => {
        sock.off("score_received", onAck);
        sock.off("score_rejected", onRej);
        resolve();
      };
      const onRej = (m) => {
        sock.off("score_received", onAck);
        sock.off("score_rejected", onRej);
        reject(new Error(`rejected: ${JSON.stringify(m)}`));
      };
      sock.on("score_received", onAck);
      sock.on("score_rejected", onRej);
      setTimeout(() => {
        sock.off("score_received", onAck);
        sock.off("score_rejected", onRej);
        reject(new Error("no ack"));
      }, 5000);
    });
  }

  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    for (const diver of divers) {
      // 1. Push the active-diver banner. The SPA's .sb-name
      //    updates from "Waiting..." to "Diver Alpha" (etc.)
      //    and the round pill shows "Round 1 / 3". The
      //    description + position fields drive the audience-
      //    facing dive label ("Forward Dive Pike") via
      //    diveDescription(), so we send both — same shape the
      //    real Control Room emits.
      const dive = diveCodes[round - 1];
      // Match the dive_directory.description column verbatim so
      // the SPA renders the same string a real meet would.
      const diveAction = ({
        "101": "Forward Dive",
        "201": "Back Dive",
        "301": "Reverse Dive",
      })[dive.dive_code];
      adminSocket.emit("set_active_diver", {
        event_id:      eventId,
        competitor_id: diver.userId,
        diverName:     diver.fullName,
        full_name:     diver.fullName,
        round_number:  round,
        diveCode:      `${dive.dive_code}${dive.position}`,
        dd:            dive.dd,
        description:   diveAction,
        position:      dive.position,
        eventName:     event.name,
      });

      // Wait for the SPA to paint the new active diver, plus a
      // human-pacing pause so a watcher sees "Diver X is up"
      // before the scores start flying in.
      await expect(page.locator(".sb-name")).toContainText(diver.fullName, {
        timeout: 5000,
      });
      await page.waitForTimeout(PRE_DIVE_MS);

      // 2. Five judges submit, one at a time with a tiny gap
      //    between each so the watcher can SEE the scores
      //    accumulating rather than landing in one frame.
      const profile = scoreProfiles[diver.fullName];
      for (let i = 0; i < judges.length; i++) {
        const ack = scoreReceivedOnce(judgeSockets[i]);
        judgeSockets[i].emit("submit_score", {
          event_id:      eventId,
          competitor_id: diver.userId,
          round_number:  round,
          score:         profile[i],
          dive_id:       dives[round - 1],
        });
        await ack;
        await page.waitForTimeout(PER_SCORE_MS);
      }

      // 3. Announce the dive. In the new UX this just triggers a
      //    standings re-pull — no fullscreen overlay. The dive
      //    total is already visible inline under the active diver
      //    (computed live from the score_received pills × DD), so
      //    the announce is purely a "refresh standings" signal.
      adminSocket.emit("announce_score", {
        event_id:      eventId,
        competitor_id: diver.userId,
        round_number:  round,
        diverName:     diver.fullName,
      });

      // Tiny grace window for refreshData() round-trip + DOM
      // update, then a watchable pause before the next diver.
      await page.waitForTimeout(POST_DIVE_MS);
    }
  }

  // ============================================================
  // PHASE 4 — assert standings, then flip to Completed and
  // verify the centred recap leaderboard renders. Hold on the
  // recap view so a watching human can read it.
  // ============================================================
  // After 3 rounds, Bravo should be ranked 1, Alpha 2, Charlie 3.
  // Assert via the API first to keep the data check deterministic.
  const sb = await request.get(`/api/scoreboard/${eventId}?cache=skip`);
  const sbData = await sb.json();
  expect(sbData.standings).toHaveLength(3);
  expect(sbData.standings[0].full_name).toBe("Diver Bravo");
  expect(sbData.standings[1].full_name).toBe("Diver Alpha");
  expect(sbData.standings[2].full_name).toBe("Diver Charlie");

  // Sanity-check the live-mode standings DOM still matches before
  // we flip to Completed.
  const liveRows = page.locator(".standing");
  await expect(liveRows).toHaveCount(3, { timeout: 5000 });
  await expect(liveRows.nth(0).locator(".standing-name")).toContainText("Diver Bravo");

  // Flip the event to Completed. This is what the meet operator
  // does at the end of a real meet. The SPA polls the events list
  // every few seconds and re-renders into the .sb-completed branch
  // when the status flips.
  await setup.setEventStatus(request, {
    adminToken, eventId, status: "Completed",
  });

  // Reload the page so the SPA re-fetches and lands on the
  // completed branch immediately rather than waiting on its poll.
  // (The poll-driven path works too but adds 5–10s of waiting.)
  await page.reload();

  // Assert the recap renders: 3 diver-blocks in rank order, each
  // with their per-dive table showing dive code, DD, judges'
  // scores, and dive total.
  const blocks = page.locator(".diver-block");
  await expect(blocks).toHaveCount(3, { timeout: 10_000 });
  await expect(blocks.nth(0).locator(".diver-name")).toContainText("Diver Bravo");
  await expect(blocks.nth(0).locator(".diver-rank-badge")).toHaveText("1");
  await expect(blocks.nth(0).locator(".diver-total")).toContainText("137.8");

  await expect(blocks.nth(1).locator(".diver-name")).toContainText("Diver Alpha");
  await expect(blocks.nth(2).locator(".diver-name")).toContainText("Diver Charlie");

  // Each diver-block has 1 header row + 3 dive rows (3 rounds).
  const bravoRows = blocks.nth(0).locator(".dive-row:not(.dive-head-row)");
  await expect(bravoRows).toHaveCount(3);
  await expect(bravoRows.nth(0)).toContainText("R1");
  await expect(bravoRows.nth(0)).toContainText("101 B");
  await expect(bravoRows.nth(0).locator(".dr-dd")).toContainText("1.5");
  // Five judge pills per dive.
  await expect(bravoRows.nth(0).locator(".j-score")).toHaveCount(5);

  // Podium spotlight should have all three steps.
  await expect(page.locator(".podium-step")).toHaveCount(3);

  await page.screenshot({
    path: `test-results/scoreboard-${eventId}.png`,
    fullPage: true,
  });

  // Hold on the recap view so a watching human can read it.
  await page.waitForTimeout(FINAL_HOLD_MS);

  // ============================================================
  // Cleanup.
  // ============================================================
  for (const s of judgeSockets) s.disconnect();
  adminSocket.disconnect();
  await setup.deleteOrg(orgId);
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker — the second hit a
// closed pool. node-postgres handles process exit gracefully.
