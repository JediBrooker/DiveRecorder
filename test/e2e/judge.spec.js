// Judge persona — full end-to-end workflow.
//
// What this exercises, picking ONE event_type at random per run
// (override with J_VARIANT=individual|synchro_pair and
// J_HEIGHT=1m|3m|5m|7.5m|10m for repro):
//
//   1. Judge logs in via the SPA login form
//   2. The dashboard's "Your Assigned Events" section surfaces
//      the event we just placed them on — the visual notification
//      that the meet director has put them on a panel
//   3. Judge clicks the event card → /judge?event=<id>
//   4. Browser waits for the active diver to land via socket,
//      then clicks numbers on the keypad and hits Submit
//   5. Three rounds × three divers / pairs, judged round-major
//   6. Variant determines panel size + role:
//        individual    5 judges, test judge gets a random 1-5
//        synchro_pair  9 judges, test judge gets a random 1-9 —
//                       so they're randomly Exec A (1-2),
//                       Exec B (3-4), or Synchronisation (5-9)
//
// Designed to be watched live when E2E_DEMO=1. The default
// suite excludes this spec; E2E_FULL=1 runs it with fast pacing.
// Override the pacing knobs (J_PRE_DIVE_MS, etc.) for exact
// repro timing.

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

const VARIANTS = ["individual", "synchro_pair"];
const VARIANT  = process.env.J_VARIANT
  || VARIANTS[Math.floor(Math.random() * VARIANTS.length)];

const HEIGHTS  = ["1m", "3m", "5m", "7.5m", "10m"];
const HEIGHT   = process.env.J_HEIGHT
  || HEIGHTS[Math.floor(Math.random() * HEIGHTS.length)];
const HEIGHT_NUMERIC = parseFloat(HEIGHT);

// Synchro must be 9 or 11 judges (World Aquatics gate). Individual stays 5.
// Synchro defaults to 11 so the bigger panel layout (Exec A 1-3,
// Exec B 4-6, Sync 7-11) is exercised on every run — the 9-panel
// shape is structurally a strict subset.
const NUM_JUDGES = VARIANT === "synchro_pair" ? 11 : 5;
const TOTAL_ROUNDS = 3;

// Test judge's panel position. The judge_number is assigned by
// position in the array passed to assignJudges, so we put our
// test judge at the chosen index. Random per run so the variety
// of synchro roles (Exec A / Exec B / Sync) all get exercised
// across full/demo runs.
const TEST_JUDGE_NUMBER = Number(process.env.J_NUMBER)
  || Math.floor(Math.random() * NUM_JUDGES) + 1;

// Score values the test judge will tap on the keypad. One per
// dive in roster order; cycle if we run out.
const SCORE_SEQUENCE = [
  { whole: 8, half: false },
  { whole: 7, half: true  },
  { whole: 8, half: true  },
  { whole: 7, half: false },
  { whole: 9, half: false },
  { whole: 6, half: true  },
  { whole: 8, half: false },
  { whole: 7, half: true  },
  { whole: 8, half: true  },
];

// 3 dives per diver — Forward / Back / Reverse, all pike — so the
// DDs vary realistically.
const DIVE_PICKS = [
  { dive_code: "101", position: "B" },
  { dive_code: "201", position: "B" },
  { dive_code: "301", position: "B" },
];

// Pacing. Default is fast for `E2E_FULL=1`; `E2E_DEMO=1`
// restores the human-watchable values used by headed demos.
const DEMO_PACING = process.env.E2E_DEMO === "1";
const pace = (name, fastMs, demoMs) => Number(process.env[name] ?? (DEMO_PACING ? demoMs : fastMs));
const LOGIN_HOLD_MS   = pace("J_LOGIN_HOLD_MS", 0, 1500);
const PRE_DIVE_MS     = pace("J_PRE_DIVE_MS", 50, 1500);
const PER_KEYPRESS_MS = pace("J_PER_KEYPRESS_MS", 10, 350);
const POST_SUBMIT_MS  = pace("J_POST_SUBMIT_MS", 50, 1000);
const POST_DIVE_MS    = pace("J_POST_DIVE_MS", 50, 700);
const FINAL_HOLD_MS   = pace("J_FINAL_HOLD_MS", 0, 3000);

test.describe.configure({ mode: "serial" });

test("judge full E2E (random variant)", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(180_000);
  console.log(
    `[judge] variant=${VARIANT} height=${HEIGHT} ` +
    `judges=${NUM_JUDGES} test-judge=#${TEST_JUDGE_NUMBER}`,
  );

  // ============================================================
  // PHASE 1 — Setup (API). Org, admin, event, divers, dive lists,
  // and a panel of NUM_JUDGES with our test judge sitting at the
  // chosen index.
  // ============================================================
  const { orgId, username: adminUsername, adminToken, countryCode } =
    await setup.createOrgAndAdmin(request, {
      // Realistic federation so the country chip on the judge
      // view's active-diver block + scoreboard history reads
      // like a live meet.
      countryCode: "AUS",
      orgName:     "Diving Australia",
    });

  // Two clubs under the federation. Divers (and synchro pair
  // members) round-robin so the active-diver block + history
  // card show varied club_name + short_code lines (AUS-1 /
  // AUS-2) instead of a single homogenous affiliation.
  const clubs = [
    await setup.insertClub({ orgId, name: "AUS Capital Diving Club", shortCode: "AUS-1" }),
    await setup.insertClub({ orgId, name: "AUS Coastal Aquatics",    shortCode: "AUS-2" }),
  ];

  const event = await setup.createEvent(request, {
    adminToken,
    name: `E2E Judge ${VARIANT} ${HEIGHT}`,
    gender: "Female",
    number_of_judges: NUM_JUDGES,
    total_rounds: TOTAL_ROUNDS,
    height: HEIGHT,
    event_type: VARIANT,
    entries_close_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });
  const eventId = event.id;

  const diveIds = [];
  // Per-dive DD pulled fresh from dive_directory so the
  // set_active_diver payload carries the real number — the
  // SPA reads activeDiver.dd directly, no server-side enrich.
  const diveDDs = [];
  for (const dp of DIVE_PICKS) {
    diveIds.push(await setup.pickDiveId({
      height: HEIGHT_NUMERIC, dive_code: dp.dive_code, position: dp.position,
    }));
    const ddRow = await setup.pool.query(
      `SELECT dd FROM dive_directory
       WHERE height = $1::numeric AND dive_code = $2 AND position = $3::dive_position`,
      [HEIGHT_NUMERIC, dp.dive_code, dp.position],
    );
    diveDDs.push(parseFloat(ddRow.rows[0]?.dd) || 0);
  }

  // ---- Divers / pairs ----
  // Each entry in `competitors` is a { competitor_id, fullName }
  // tuple ready for set_active_diver / submit_score calls.
  const competitors = [];

  if (VARIANT === "individual") {
    for (const [idx, name] of ["Alpha", "Bravo", "Charlie"].entries()) {
      const club = clubs[idx % clubs.length];
      const d = await setup.insertUser({
        orgId, role: "diver", fullName: `Diver ${name}`, clubId: club.clubId,
      });
      await setup.insertDiveList({
        eventId,
        competitorId: d.userId,
        dives: diveIds.map((dive_id, i) => ({ round_number: i + 1, dive_id })),
      });
      competitors.push({ userId: d.userId, fullName: `Diver ${name}` });
    }
  } else {
    // Synchro: 3 pairs (6 divers). The leader posts the dive
    // list with partner_id; the audience-facing scoreboard
    // treats the pair as one row but renders both names.
    const pairs = [
      ["Alpha",   "Aurora"],
      ["Bravo",   "Beatrix"],
      ["Charlie", "Catalina"],
    ];
    for (const [pairIdx, [leader, partner]] of pairs.entries()) {
      // Lead + partner share a club within a pair (realistic
      // synchro setup); pairs themselves rotate across clubs so
      // the history shows multiple affiliations.
      const club = clubs[pairIdx % clubs.length];
      const lead = await setup.insertUser({
        orgId, role: "diver", fullName: `Diver ${leader}`, clubId: club.clubId,
      });
      const part = await setup.insertUser({
        orgId, role: "diver", fullName: `Diver ${partner}`, clubId: club.clubId,
      });
      // Direct insert with partner_id — _setup.insertDiveList
      // doesn't support partner_id today but it's a thin wrapper.
      for (let i = 0; i < diveIds.length; i++) {
        await setup.pool.query(
          `INSERT INTO competitor_dive_lists
             (event_id, competitor_id, partner_id, round_number, dive_id)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (event_id, competitor_id, round_number)
           DO UPDATE SET dive_id = EXCLUDED.dive_id,
                         partner_id = EXCLUDED.partner_id`,
          [eventId, lead.userId, part.userId, i + 1, diveIds[i]],
        );
      }
      competitors.push({
        userId: lead.userId,
        partnerId: part.userId,
        fullName: `Diver ${leader}`,
      });
    }
  }

  // ---- Judges ----
  // Build the panel array such that our test judge sits at index
  // (TEST_JUDGE_NUMBER - 1). Other judges fill the remaining
  // slots. assignJudges assigns judge_number by position.
  const testJudge = await setup.insertUser({
    orgId, role: "judge", fullName: "Judge On Test",
  });
  const otherJudges = [];
  for (let i = 1; i <= NUM_JUDGES - 1; i++) {
    const j = await setup.insertUser({
      orgId, role: "judge", fullName: `Judge ${i}`,
    });
    const login = await setup.loginAs(request, j.username);
    otherJudges.push({ ...j, token: login.token });
  }
  // Insert the test judge at the requested index of the panel.
  // panelIds is the SAME LENGTH as NUM_JUDGES.
  const panelIds = [];
  let otherIdx = 0;
  for (let pos = 1; pos <= NUM_JUDGES; pos++) {
    if (pos === TEST_JUDGE_NUMBER) {
      panelIds.push(testJudge.userId);
    } else {
      panelIds.push(otherJudges[otherIdx].userId);
      otherIdx++;
    }
  }
  await setup.assignJudges(request, {
    adminToken, eventId, judgeIds: panelIds,
  });

  // ---- Flip Live so submit_score is accepted. ----
  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });

  // ============================================================
  // PHASE 2 — Test judge logs in via the SPA. The dashboard
  // surfaces the event under "Your Assigned Events" — that's
  // the in-product notification the user wanted.
  // ============================================================
  // Cyan ring at every pointerdown so a headed-mode watcher can
  // track where each click lands. Off in CI via E2E_HIGHLIGHT=0.
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(testJudge.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/);

  // The Judge tab's "Your assigned events" list — RouterLink
  // rows pointing at /judge?event=<id>. The dashboard now uses
  // a tabbed layout; smart-pick lands on the Judge tab when
  // judging assignments are the only signal, but for safety we
  // also click into the tab in case smart-pick chose Other.
  const judgeTab = page.getByRole("button", { name: /^Judge\s/i });
  if (await judgeTab.isVisible().catch(() => false)) {
    await judgeTab.click();
  }
  const eventCard = page
    .locator(".event-row")
    .filter({ hasText: event.name })
    .first();
  await expect(eventCard).toBeVisible({ timeout: 10_000 });
  // Linger so a watching human sees the dashboard + notification
  // before the click that follows.
  await page.waitForTimeout(LOGIN_HOLD_MS);

  // ============================================================
  // PHASE 3 — Click the notification → /judge?event=<id>
  // ============================================================
  await eventCard.click();
  await page.waitForURL(/\/judge\?event=/);
  // Initial Waiting-for-diver state: keypad visible, diver name
  // placeholder. Confirm the keypad rendered before we let the
  // admin start setting active divers.
  await expect(page.locator(".keypad")).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(LOGIN_HOLD_MS);

  // ============================================================
  // PHASE 4 — Scoring loop. The admin (separate socket) drives
  // set_active_diver; the test judge taps the keypad in the
  // browser; the OTHER judges submit via direct socket
  // connections so the dive completes for each diver.
  // ============================================================
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
  const adminToken2 = (await setup.loginAs(request, adminUsername)).token;
  const adminSocket = await openSocket(adminToken2);
  adminSocket.emit("subscribe_event", { event_id: eventId });
  const otherJudgeSockets = [];
  for (const j of otherJudges) {
    const s = await openSocket(j.token);
    s.emit("subscribe_event", { event_id: eventId });
    otherJudgeSockets.push(s);
  }

  // Map keypad button labels back to roles for assertions. WA
  // synchro panels:
  //    9-judge → A {1,2}    B {3,4}    Sync {5..9}
  //   11-judge → A {1,2,3}  B {4,5,6}  Sync {7..11}
  const synchroRoleForJudge = (n) => {
    if (VARIANT !== "synchro_pair") return null;
    if (NUM_JUDGES === 9) {
      if (n <= 2) return "EXEC A";
      if (n <= 4) return "EXEC B";
      return "SYNCHRONISATION";
    }
    if (NUM_JUDGES === 11) {
      if (n <= 3) return "EXEC A";
      if (n <= 6) return "EXEC B";
      return "SYNCHRONISATION";
    }
    return null;
  };
  const expectedRole = synchroRoleForJudge(TEST_JUDGE_NUMBER);

  let scoreIdx = 0;
  for (let round = 1; round <= TOTAL_ROUNDS; round++) {
    for (let cIdx = 0; cIdx < competitors.length; cIdx++) {
      const c = competitors[cIdx];
      const dive = DIVE_PICKS[round - 1];
      const diveId = diveIds[round - 1];
      const diveAction = ({
        "101": "Forward Dive", "201": "Back Dive", "301": "Reverse Dive",
      })[dive.dive_code];

      // 1. Admin pushes the active diver. The judge SPA receives
      //    state_update via its socket and re-renders the diver
      //    block + fetches /my-judge-number.
      adminSocket.emit("set_active_diver", {
        event_id:      eventId,
        competitor_id: c.userId,
        diverName:     c.fullName,
        full_name:     c.fullName,
        partner_name:  c.partnerName || null,
        round_number:  round,
        diveCode:      `${dive.dive_code}${dive.position}`,
        dd:            diveDDs[round - 1],
        description:   diveAction,
        position:      dive.position,
        eventName:     event.name,
        event_type:    VARIANT,
        number_of_judges: NUM_JUDGES,
      });

      // 2. Wait for the diver name to land in the JudgeView header.
      await expect(page.locator(".diver-name")).toContainText(c.fullName, {
        timeout: 10_000,
      });
      // For synchro, the role badge ("EXEC A" / "EXEC B" /
      // "SYNCHRONISATION") appears once /my-judge-number lands.
      // Assert the expected role is showing. Only on the first
      // dive — re-asserting per dive would just re-check the
      // same DOM.
      if (expectedRole && round === 1 && cIdx === 0) {
        await expect(page.locator(".synchro-role"))
          .toContainText(expectedRole, { timeout: 10_000 });
      }
      await page.waitForTimeout(PRE_DIVE_MS);

      // 3. Signal-Referee scenario — once per run, on the
      //    SECOND dive. Judge taps Signal Referee BEFORE
      //    submitting, holds the signal long enough for a
      //    watching human to see the red flash + the locked-
      //    out auto-advance, then submits a score (which auto-
      //    clears the signal server-side).
      const isSignalScenario = (round === 1 && cIdx === 1);
      if (isSignalScenario) {
        await page.locator(".signal-btn").click();
        await expect(page.locator(".signal-btn")).toHaveClass(/signal-btn-on/);
        // Hold the signal so the human eye catches the alert.
        await page.waitForTimeout(PRE_DIVE_MS * 2);
      }

      // 3b. Other-judge-signals scenario — once per run, on
      //     the THIRD dive. A different panel member emits
      //     judge_signal {true} via socket; this judge SHOULD
      //     see the .judge-panel-alert banner appear above the
      //     dive panel. After a beat the other judge clears.
      const isOtherSignalScenario = (round === 1 && cIdx === 2);
      if (isOtherSignalScenario) {
        otherJudgeSockets[0].emit("judge_signal", {
          event_id:      eventId,
          competitor_id: c.userId,
          round_number:  round,
          signaled:      true,
        });
        await expect(page.locator(".judge-panel-alert"))
          .toBeVisible({ timeout: 5000 });
        await page.waitForTimeout(PRE_DIVE_MS * 2);
        otherJudgeSockets[0].emit("judge_signal", {
          event_id:      eventId,
          competitor_id: c.userId,
          round_number:  round,
          signaled:      false,
        });
        await expect(page.locator(".judge-panel-alert"))
          .toBeHidden({ timeout: 5000 });
      }

      // 4. Test judge taps a score on the keypad. Pick from
      //    the cycling SCORE_SEQUENCE so the user sees variety.
      const score = SCORE_SEQUENCE[scoreIdx % SCORE_SEQUENCE.length];
      scoreIdx++;
      await page.locator(`.keypad .key:has-text("${score.whole}")`).first().click();
      await page.waitForTimeout(PER_KEYPRESS_MS);
      if (score.half) {
        await page.locator(".key-half").click();
        await page.waitForTimeout(PER_KEYPRESS_MS);
      }
      // Verify the .score-number reflects the typed value before
      // hitting Submit.
      const expectedDisplay = score.half
        ? (score.whole + 0.5).toFixed(1)
        : String(score.whole);
      await expect(page.locator(".score-number")).toHaveText(expectedDisplay);
      await page.waitForTimeout(PER_KEYPRESS_MS);
      await page.locator(".submit-btn").click();
      // Submit-btn shows "✓ Submitted — N" once the socket round-
      // trip lands. Wait for the lock state to confirm.
      await expect(page.locator(".submit-btn"))
        .toContainText(/Submitted/i, { timeout: 5000 });
      // The signal should auto-clear once the judge submits a
      // fresh score — server-side propagation happens from the
      // SPA's submitScore handler emitting judge_signal {false}.
      if (isSignalScenario) {
        await expect(page.locator(".signal-btn")).not.toHaveClass(/signal-btn-on/);
      }

      // 4. Other judges submit their scores via direct socket so
      //    the dive completes (5 / 9 lights). Vary scores ±0.5
      //    around 7.5 so each dive gets a realistic spread.
      for (let i = 0; i < otherJudges.length; i++) {
        const baseline = 7.5;
        const otherScore = Math.max(
          5.0,
          Math.min(9.5, baseline + ((i % 3) - 1) * 0.5),
        );
        otherJudgeSockets[i].emit("submit_score", {
          event_id:      eventId,
          competitor_id: c.userId,
          round_number:  round,
          score:         otherScore,
          dive_id:       diveId,
        });
      }

      await page.waitForTimeout(POST_SUBMIT_MS);
      await page.waitForTimeout(POST_DIVE_MS);
    }
  }

  // ============================================================
  // PHASE 5 — Final hold so a watching human can see the last
  // submitted state, then teardown.
  // ============================================================
  await page.waitForTimeout(FINAL_HOLD_MS);

  await page.screenshot({
    path: `test-results/judge-${VARIANT}-j${TEST_JUDGE_NUMBER}.png`,
    fullPage: true,
  });

  for (const s of otherJudgeSockets) s.disconnect();
  adminSocket.disconnect();
  await setup.deleteOrg(orgId);
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker — the second hit a
// closed pool. node-postgres handles process exit gracefully.
