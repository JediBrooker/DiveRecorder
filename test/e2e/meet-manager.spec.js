// Meet Manager — full end-to-end workflow.
//
// What this exercises, picking ONE event_type at random per run
// (override via MM_VARIANT=individual|synchro_pair|team and
// MM_HEIGHT=1m|3m|5m|7.5m|10m for repro):
//
//   1. Meet manager creates an event (random height + type)
//   2. Divers log in and submit dive lists
//        individual   → 3 divers, each posts /api/competitor/submit-list
//        synchro_pair → 3 pairs (6 divers); each pair's leader posts
//                       with partner_id
//        team         → 2 teams of 2 members; admin creates the
//                       teams, links them to the event, posts each
//                       team's dive list
//   3. Manager closes entries (entries_close_at = now)
//   4. Manager walks the 4-state pre-meet workflow button in the
//      Control Room:
//        red    Check In Divers     (opens check-in modal,
//                                   click footer Continue)
//        orange Randomise Dive Order
//        yellow Referee Sign Off
//        green  Start Event
//      Each click is fronted by a deliberate WORKFLOW_HOLD_MS
//      dwell so the colour transition is visible to a watching
//      human (CI overrides the dwell to ~200ms).
//   5. The Start Event click flips status Upcoming → Live in the
//      same place as the old setEventStatus API call did.
//   6. Judges connect via socket and submit scores while the
//      manager browser sits on /control. Scores stream in
//      round-major; manager emits set_active_diver / announce_score
//   7. Manager flips status Live → Completed; recap renders
//
// Designed to be diagnostic: prints the variant + height it
// picked at the top so a failed run can be re-run with the
// matching env vars.

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

const VARIANTS = ["individual", "synchro_pair", "team"];
const VARIANT  = process.env.MM_VARIANT
  || VARIANTS[Math.floor(Math.random() * VARIANTS.length)];

// Synchro panels are 9 or 11 (FINA gate); everything else is 5.
// Synchro defaults to 11 so the bigger panel layout (Exec A 1-3,
// Exec B 4-6, Sync 7-11) is exercised on every run — the 9-panel
// shape is structurally a strict subset.
const NUM_JUDGES = VARIANT === "synchro_pair" ? 11 : 5;

// Random board height. The dive directory has 101/201/301 at
// every height with positions A/B/C, so any height works for
// our 3-round programme.
const HEIGHTS  = ["1m", "3m", "5m", "7.5m", "10m"];
const HEIGHT   = process.env.MM_HEIGHT
  || HEIGHTS[Math.floor(Math.random() * HEIGHTS.length)];
const HEIGHT_NUMERIC = parseFloat(HEIGHT);

const TOTAL_ROUNDS = 3;
// Per-round dive picks. Forward / Back / Reverse, all in pike,
// to keep DDs in a realistic spread.
const DIVE_PICKS = [
  { dive_code: "101", position: "B" },
  { dive_code: "201", position: "B" },
  { dive_code: "301", position: "B" },
];

// Pacing knobs. Defaults are tuned for human watching (--headed)
// — the scoring loop takes ~1 minute end-to-end at these
// values. CI overrides them down via env vars to ~5x faster.
//
// Quick speed-up for a CI / smoke pass:
//   MM_PRE_DIVE_MS=200 MM_PER_SCORE_MS=50 MM_POST_DIVE_MS=200 \
//   MM_LOGIN_HOLD_MS=200 MM_FINAL_HOLD_MS=200 MM_WORKFLOW_HOLD_MS=200
const PRE_DIVE_MS    = Number(process.env.MM_PRE_DIVE_MS    ?? 1200);
const PER_SCORE_MS   = Number(process.env.MM_PER_SCORE_MS   ?? 250);
const POST_DIVE_MS   = Number(process.env.MM_POST_DIVE_MS   ?? 900);
const LOGIN_HOLD_MS  = Number(process.env.MM_LOGIN_HOLD_MS  ?? 1500);
const FINAL_HOLD_MS  = Number(process.env.MM_FINAL_HOLD_MS  ?? 4000);
// Slow-mo dwell between the four pre-meet workflow steps
// (Check In → Randomise → Sign Off → Start). Defaults to 2.5s so
// a watching human can see the button shift colour from red →
// orange → yellow → green; CI shrinks it to 200ms via the env
// override above.
const WORKFLOW_HOLD_MS = Number(process.env.MM_WORKFLOW_HOLD_MS ?? 2500);

test.describe.configure({ mode: "serial" });

// Test title stays static — Playwright's worker uses the title
// to find a test on retry, and a dynamic title (e.g. "[synchro
// @ 10m]") would 404 the second worker. The variant lives in
// the console.log + screenshot filename below.
test("meet-manager full E2E (random variant)", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(180_000);
  // Print the chosen variant up front so a failed CI run can be
  // reproduced with MM_VARIANT=… MM_HEIGHT=… on a developer box.
  console.log(`[meet-manager] variant=${VARIANT} height=${HEIGHT} judges=${NUM_JUDGES}`);

  // ============================================================
  // PHASE 1 — Meet manager creates the event.
  // ============================================================
  const { orgId, username: adminUsername, adminToken, countryCode } =
    await setup.createOrgAndAdmin(request, {
      // Realistic federation so the country chip on history /
      // Up Next / scoreboard surfaces reads like a live meet.
      countryCode: "DEU",
      orgName:     "Deutscher Schwimm-Verband",
    });

  // A pair of clubs under the federation. Divers (and synchro
  // pair members) round-robin across these so the history card
  // shows varied club_name + club_code lines (DEU-1 / DEU-2)
  // rather than a single homogenous affiliation.
  const clubs = [
    await setup.insertClub({ orgId, name: "DEU Capital Diving Club", shortCode: "DEU-1" }),
    await setup.insertClub({ orgId, name: "DEU Coastal Aquatics",    shortCode: "DEU-2" }),
  ];

  const event = await setup.createEvent(request, {
    adminToken,
    name: `E2E ${VARIANT} ${HEIGHT}`,
    gender: "Female",
    number_of_judges: NUM_JUDGES,
    total_rounds: TOTAL_ROUNDS,
    height: HEIGHT,
    event_type: VARIANT,
    // Future deadline — divers can still submit until we close it
    // explicitly in PHASE 3.
    entries_close_at: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
  });
  const eventId = event.id;

  // Per-round dive_id resolution off the directory.
  const diveIds = [];
  for (const dp of DIVE_PICKS) {
    diveIds.push(await setup.pickDiveId({
      height: HEIGHT_NUMERIC,
      dive_code: dp.dive_code,
      position:  dp.position,
    }));
  }

  // ============================================================
  // PHASE 2 — Divers / teams submit dive lists. Branches by
  // event_type — see the variant table at the top of the file.
  //
  // Each branch ends with `competitors[]` populated as the list
  // of (competitor_id, partner_id?, fullName, teamId?) tuples
  // we'll later use to drive set_active_diver + submit_score.
  // ============================================================
  const competitors = [];

  if (VARIANT === "individual") {
    for (const [idx, name] of ["Alpha", "Bravo", "Charlie"].entries()) {
      // Round-robin clubs so the history card shows two
      // different club lines (DEU Capital Diving Club / DEU
      // Coastal Aquatics) — mirrors a real meet where a panel
      // of divers come from multiple clubs.
      const club = clubs[idx % clubs.length];
      const d = await setup.insertUser({
        orgId, role: "diver", fullName: `Diver ${name}`, clubId: club.clubId,
      });
      const login = await setup.loginAs(request, d.username);
      // Each diver posts their own list via the public submit-list API.
      const submit = await request.post("/api/competitor/submit-list", {
        headers: { Authorization: `Bearer ${login.token}` },
        data: {
          event_id: eventId,
          dives: diveIds.map((dive_id, i) => ({ round_number: i + 1, dive_id })),
        },
      });
      expect(submit.status(), `${name} submit-list`).toBe(200);
      competitors.push({
        userId:   d.userId,
        fullName: `Diver ${name}`,
      });
    }
  }

  else if (VARIANT === "synchro_pair") {
    // 3 pairs × 2 = 6 divers. The "leader" of each pair posts
    // the dive list with partner_id pointing at the other diver;
    // the audience-facing scoreboard treats the pair as one
    // competitor (leader's id) but renders both names.
    const pairs = [
      ["Alpha", "Aurora"],
      ["Bravo", "Beatrix"],
      ["Charlie", "Catalina"],
    ];
    for (const [pairIdx, [leader, partner]] of pairs.entries()) {
      // Round-robin pairs across clubs so the synchro history
      // shows two different club affiliations (DEU-1 / DEU-2).
      // The lead + partner share a club within a pair — a
      // realistic synchro setup where pairs train together.
      const club = clubs[pairIdx % clubs.length];
      const lead = await setup.insertUser({
        orgId, role: "diver", fullName: `Diver ${leader}`, clubId: club.clubId,
      });
      const part = await setup.insertUser({
        orgId, role: "diver", fullName: `Diver ${partner}`, clubId: club.clubId,
      });
      const leadLogin = await setup.loginAs(request, lead.username);
      const submit = await request.post("/api/competitor/submit-list", {
        headers: { Authorization: `Bearer ${leadLogin.token}` },
        data: {
          event_id:   eventId,
          partner_id: part.userId,
          dives: diveIds.map((dive_id, i) => ({ round_number: i + 1, dive_id })),
        },
      });
      expect(submit.status(), `${leader}+${partner} submit-list`).toBe(200);
      competitors.push({
        userId:    lead.userId,
        partnerId: part.userId,
        fullName:  `Diver ${leader}`,
      });
    }
  }

  else if (VARIANT === "team") {
    // 2 teams × 2 members. Admin creates each team, adds members
    // via /api/teams/:id/members, then posts the team's dive list
    // via /api/teams/:teamId/dive-lists. Each member dives once
    // per round for their team.
    const teamSpecs = [
      { name: "Team Aurora",  members: ["Alpha",  "Aurora"]   },
      { name: "Team Bravo",   members: ["Bravo",  "Beatrix"]  },
    ];
    for (const [teamIdx, spec] of teamSpecs.entries()) {
      // Each team's members are rooted in one club so the
      // history card shows BOTH the purple team chip (team_name)
      // AND the muted club line beneath it — proving the
      // split-variant layout works end-to-end with both rows
      // populated.
      const club = clubs[teamIdx % clubs.length];

      // Create the team.
      const teamRes = await request.post(`/api/orgs/${orgId}/teams`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { name: spec.name, short_code: spec.name.split(" ")[1].slice(0, 3).toUpperCase() },
      });
      expect(teamRes.status(), `create ${spec.name}`).toBe(201);
      const team = await teamRes.json();

      // Make the members + add to the team.
      const memberRows = [];
      for (const memberName of spec.members) {
        const m = await setup.insertUser({
          orgId, role: "diver", fullName: `Diver ${memberName}`, clubId: club.clubId,
        });
        const addRes = await request.post(`/api/teams/${team.id}/members`, {
          headers: { Authorization: `Bearer ${adminToken}` },
          data: { user_id: m.userId },
        });
        expect(addRes.status(), `add ${memberName} to ${spec.name}`).toBe(200);
        memberRows.push({ userId: m.userId, fullName: `Diver ${memberName}` });
      }

      // Link the team to the event so it appears in the roster.
      const linkRes = await request.post(`/api/events/${eventId}/teams`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { team_id: team.id },
      });
      // POST /api/events/:id/teams returns 200 OK (idempotent
       // upsert), not 201 — accept either to keep the assertion
       // future-proof.
      expect(linkRes.status(), `link ${spec.name} to event`).toBeLessThan(300);

      // Post the team's dive list — every member dives once per
      // round, so 2 members × 3 rounds = 6 rows per team.
      const teamDives = [];
      for (let round = 1; round <= TOTAL_ROUNDS; round++) {
        for (const mem of memberRows) {
          teamDives.push({
            competitor_id: mem.userId,
            dive_id:       diveIds[round - 1],
            round_number:  round,
          });
        }
      }
      const submit = await request.post(`/api/teams/${team.id}/dive-lists`, {
        headers: { Authorization: `Bearer ${adminToken}` },
        data: { event_id: eventId, dives: teamDives },
      });
      expect(submit.status(), `${spec.name} dive-list`).toBe(200);

      for (const mem of memberRows) {
        competitors.push({
          userId:   mem.userId,
          fullName: mem.fullName,
          teamId:   team.id,
          teamName: spec.name,
        });
      }
    }
  }

  // ============================================================
  // PHASE 2.5 — Judges + a referee. Same flow regardless of
  // variant; the referee is used by Phase 4b's yellow Sign-Off
  // step (the modal's credential tab verifies a real referee
  // user before stamping signed_off_at).
  // ============================================================
  const judges = [];
  for (let i = 1; i <= NUM_JUDGES; i++) {
    const j = await setup.insertUser({
      orgId, role: "judge", fullName: `Judge ${i}`,
    });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, {
    adminToken, eventId,
    judgeIds: judges.map((j) => j.userId),
  });
  // Create a referee in the same org. Used by the credential-path
  // sign-off in Phase 4b. We don't bother giving them a push
  // subscription — the headless test exercises the fallback
  // because that's the path that doesn't need a service worker
  // round-trip to function.
  const referee = await setup.insertUser({
    orgId, role: "referee", fullName: "Test Referee",
  });

  // ============================================================
  // PHASE 3 — Manager closes entries (deadline → past) via API.
  // The SPA has no UI for this — managers either let the
  // entries_close_at deadline pass naturally or flip event
  // status. Here we just push the deadline into the past so the
  // dive lists are locked.
  // ============================================================
  await setup.pool.query(
    "UPDATE events SET entries_close_at = now() - interval '1 minute' WHERE id = $1",
    [eventId],
  );

  // ============================================================
  // PHASE 4 — Manager opens Chrome, logs in, and walks through
  // the Control Room workflow:
  //   * pick the event from the dropdown (auto-loads roster +
  //     calls setActive(0))
  //   * walk the 3-state pre-meet button (red randomise → yellow
  //     referee sign-off → green start event) with WORKFLOW_HOLD_MS
  //     dwell between each step so a watching human sees the
  //     colour transition
  //   * click the first roster row to re-pick the active diver
  //     (randomise reset currentActive in the SPA)
  // ============================================================
  // Auto-accept any window.confirm() the SPA pops up — Randomise
  // and Finalise both ask "are you sure?" via confirm(), and
  // Playwright suspends the page until a dialog is dismissed.
  // E2E_DIALOG_HOLD_MS=5000 leaves the popup visible for a
  // watching human; default 0 = instant accept for CI.
  await setup.installDialogDelay(page);
  // Cyan ring at every pointerdown so a headed-mode watcher can
  // track where each click lands. Off in CI via E2E_HIGHLIGHT=0.
  await setup.installClickHighlight(page);

  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(adminUsername);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/);
  // Linger on the dashboard so a watching human sees the
  // transition before the manager hops into Control Room.
  await page.waitForTimeout(LOGIN_HOLD_MS);
  await page.goto("/control");

  // The Control Room renders the event-picker <select> at the
  // top. Wait for our event's <option> to appear, then choose it.
  // Two .event-select-sm dropdowns now live in the header: the
  // event picker and the auto-advance picker. Pick the one that
  // is NOT the auto-advance select.
  const eventSelect = page.locator(".event-select-sm:not(.auto-advance-select)");
  await expect(eventSelect).toBeVisible({ timeout: 10_000 });
  await expect(
    eventSelect.locator(`option[value="${eventId}"]`),
  ).toBeAttached({ timeout: 10_000 });
  await page.waitForTimeout(LOGIN_HOLD_MS);
  await eventSelect.selectOption(eventId);

  // onEventChange fires: roster + judges load, setActive(0)
  // auto-runs (so the centre column shows the first diver). Wait
  // for the right panel to populate. The Up Next block is the
  // primary surface now — the full Dive Order panel below it
  // collapses by default, so .roster-jump won't be in the DOM
  // until an operator opens it.
  await expect(page.locator(".up-next-row-btn").first()).toBeVisible({
    timeout: 10_000,
  });
  await page.waitForTimeout(LOGIN_HOLD_MS);

  // ============================================================
  // PHASE 4b — Pre-meet 4-state workflow.
  //
  // The Control Room owns a single button that walks the operator
  // through four sequential states before the event flips Live.
  // We exercise all four in headed Chrome so a watching human
  // sees the colour shift red → orange → yellow → green:
  //
  //   1. Red    — "✓ Check In Divers" (opens modal)
  //   2. Orange — "🎲 Randomise Dive Order"
  //   3. Yellow — "📋 Referee Sign Off"
  //   4. Green  — "▶ Start Event"
  //
  // The dwell between steps is WORKFLOW_HOLD_MS (default 2.5s in
  // headed mode, 200ms in CI). Each step resolves an explicit
  // .wf-btn-* selector so the test fails loudly if a future
  // refactor breaks the colour ↔ state mapping.
  // ============================================================

  // STATE 1 — Red "Check In Divers" button. Click opens the
  // modal; the modal's "✓ Check-in Complete — Continue" footer
  // button stamps check_in_done_at and closes back to the queue
  // header where the button has flipped to orange.
  const wfRedBtn = page.locator(".wf-btn.wf-btn-red").first();
  await expect(wfRedBtn).toBeVisible({ timeout: 5000 });
  await expect(wfRedBtn).toHaveText(/Check In Divers/i);
  await page.waitForTimeout(WORKFLOW_HOLD_MS);
  await wfRedBtn.click();

  // Check-in modal: surface the footer "Continue" button and
  // click it. We don't bother marking divers — the confirm pop-up
  // is auto-accepted by the global dialog handler.
  const checkinContinueBtn = page.locator(".lb-footer .wf-btn.wf-btn-red");
  await expect(checkinContinueBtn).toBeVisible({ timeout: 5000 });
  await expect(checkinContinueBtn).toHaveText(/Check-in Complete/i);
  await page.waitForTimeout(WORKFLOW_HOLD_MS);
  await checkinContinueBtn.click();

  // STATE 2 — Orange randomise button. Click opens a confirm
  // modal (cut from native confirm() to a styled modal that
  // spells out the consequences); click the modal's Randomise
  // primary button to actually run the shuffle.
  const wfOrangeBtn = page.locator(".wf-btn.wf-btn-orange");
  await expect(wfOrangeBtn).toBeVisible({ timeout: 5000 });
  await expect(wfOrangeBtn).toHaveText(/Randomise Dive Order/i);
  await page.waitForTimeout(WORKFLOW_HOLD_MS);
  await wfOrangeBtn.click();
  const randomiseConfirm = page.locator(".confirm-modal .confirm-btn-warn", {
    hasText: /Randomise/i,
  });
  await expect(randomiseConfirm).toBeVisible({ timeout: 5000 });
  await randomiseConfirm.click();

  // STATE 3 — Yellow referee sign-off button.
  // Cut 2: clicking the yellow button now opens a modal with two
  // tabs (push to referee's device / sign at this device). We
  // exercise the credential-fallback path because it doesn't
  // need a service worker round-trip — the push tab is verified
  // separately by the lib/push tests.
  const wfYellowBtn = page.locator(".wf-btn.wf-btn-yellow");
  await expect(wfYellowBtn).toBeVisible({ timeout: 5000 });
  await expect(wfYellowBtn).toHaveText(/Referee Sign Off/i);
  await page.waitForTimeout(WORKFLOW_HOLD_MS);
  await wfYellowBtn.click();

  // Modal opens. Switch to the credential tab + sign in as the
  // referee user we created in Phase 2.5.
  const signoffModal = page.locator(".signoff-modal");
  await expect(signoffModal).toBeVisible({ timeout: 5000 });
  await signoffModal.locator(".signoff-tab", { hasText: /Sign at this device/i }).click();
  await signoffModal.locator('input[autocomplete="off"]').fill(referee.username);
  await signoffModal.locator('input[autocomplete="new-password"]').fill(referee.password);
  await page.waitForTimeout(WORKFLOW_HOLD_MS);
  await signoffModal.locator(".btn-primary", { hasText: /Sign off/i }).click();
  // Modal closes once the credential path stamps signed_off_at;
  // the workflow button flips to green automatically.

  // STATE 4 — Green start-event button. Click opens the
  // Pre-Flight Review modal (roster / panel / referee / warnings
  // summary); clicking ▶ Go Live in the modal then flips
  // Upcoming → Live. Two-step pattern so the operator gets a
  // last-chance review before broadcasting to spectator
  // scoreboards — see commit history for context.
  const wfGreenBtn = page.locator(".wf-btn.wf-btn-green");
  await expect(wfGreenBtn).toBeVisible({ timeout: 5000 });
  await expect(wfGreenBtn).toHaveText(/Start Event/i);
  await page.waitForTimeout(WORKFLOW_HOLD_MS);
  await wfGreenBtn.click();

  // Pre-Flight Review modal — wait for it, then click ▶ Go Live.
  const preflightGo = page.getByRole("button", { name: /Go Live/i });
  await expect(preflightGo).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(WORKFLOW_HOLD_MS);
  await preflightGo.click();

  // Once Live, the workflow button hides and the small "● Live"
  // badge takes its place — assert that so we know the status
  // flip actually landed before we hand off to the scoring loop.
  await expect(page.locator(".wf-live-badge")).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(LOGIN_HOLD_MS);

  // Re-pick the first diver via the Up Next row click — the SPA
  // cleared currentActive when Randomise reshuffled the order.
  // Up Next is the primary right-panel surface now; clicking a
  // row jump-sets the active diver same as the old roster-jump.
  await page.locator(".up-next-row-btn").first().click();
  await page.waitForTimeout(PRE_DIVE_MS);

  // ============================================================
  // PHASE 6 — Scoring loop, manager-driven. The Control Room
  // owns set_active_diver (emitted from setActive() — called
  // either by the initial event-pick or by clicking the "Next
  // Diver →" button). This test only owns the JUDGE sockets;
  // each judge submits a score and the SPA's score_received
  // listener lights up the matching judge tile in the centre
  // column.
  //
  // Once all 5 (or NUM_JUDGES) tiles are filled, the SPA enables
  // the "Next Diver →" button. We click it to advance and
  // setActive emits the next diver to all subscribers.
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
  function ackOnce(sock) {
    return new Promise((resolve, reject) => {
      const onAck = () => { cleanup(); resolve(); };
      const onRej = (m) => { cleanup(); reject(new Error(`rejected: ${JSON.stringify(m)}`)); };
      function cleanup() {
        sock.off("score_received", onAck);
        sock.off("score_rejected", onRej);
      }
      sock.on("score_received", onAck);
      sock.on("score_rejected", onRej);
      setTimeout(() => { cleanup(); reject(new Error("no ack")); }, 5000);
    });
  }
  const judgeSockets = [];
  for (const j of judges) {
    const s = await openSocket(j.token);
    s.emit("subscribe_event", { event_id: eventId });
    judgeSockets.push(s);
  }

  // Pull the post-randomise roster so the test knows the (event,
  // competitor, round, dive_id) tuples needed for submit_score.
  // The Control Room's local roster has the same shape; pulling
  // again here keeps the test independent of SPA internals.
  const rosterRes = await request.get(
    `/api/events/${eventId}/roster`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  const roster = await rosterRes.json();
  expect(roster.length).toBeGreaterThan(0);

  const nextBtn = page.getByRole("button", { name: /Next Diver|Event Complete/i });
  const finaliseBtn = page.locator(".btn-finalise");

  for (let i = 0; i < roster.length; i++) {
    const row = roster[i];

    // Signal-Referee scenario — once per run, on the SECOND
    // dive. Judge 1 emits judge_signal {true} BEFORE the panel
    // submits, the operator sees the bright-red banner appear
    // in the centre column, the test holds long enough for a
    // watching human to see the alert + the auto-advance
    // countdown getting cancelled (when set), then the judge
    // emits judge_signal {false} and we proceed with normal
    // scoring. Demonstrates the full pause / resume contract.
    const isSignalScenario = (i === 1);
    if (isSignalScenario) {
      judgeSockets[0].emit("judge_signal", {
        event_id:      eventId,
        competitor_id: row.competitor_id,
        round_number:  row.round_number,
        signaled:      true,
      });
      await expect(page.locator(".referee-signal-banner"))
        .toBeVisible({ timeout: 5000 });
      // Hold the alert visible — long enough for the user to
      // notice both the banner and the red ring on judge tile 1.
      await page.waitForTimeout(POST_DIVE_MS * 4);
      judgeSockets[0].emit("judge_signal", {
        event_id:      eventId,
        competitor_id: row.competitor_id,
        round_number:  row.round_number,
        signaled:      false,
      });
      await expect(page.locator(".referee-signal-banner"))
        .toBeHidden({ timeout: 5000 });
    }

    // Score profile: judges vary by ±0.5 around a per-diver
    // baseline; each diver gets a slightly lower baseline by
    // roster index so totals separate cleanly. All values stay
    // on 0.5 increments — submit_score rejects anything off the
    // half-step grid.
    const baseline = 8.0 - ((i % roster.length) * 0.5);
    for (let j = 0; j < judges.length; j++) {
      const score = Math.max(
        5.0,
        Math.min(9.5, baseline + ((j % 3) - 1) * 0.5),
      );
      const ack = ackOnce(judgeSockets[j]);
      judgeSockets[j].emit("submit_score", {
        event_id:      eventId,
        competitor_id: row.competitor_id,
        round_number:  row.round_number,
        score,
        dive_id:       row.dive_id,
      });
      await ack;
      // Pause between judges so the human watcher sees each
      // tile light up in sequence rather than all five flashing
      // on at once.
      await page.waitForTimeout(PER_SCORE_MS);
    }

    // The Control Room pops a "Round Complete" modal at the end
    // of every round (detectRoundEnd → roundEndPromptOpen).
    // Dismiss it before reaching for the Next button — its
    // backdrop intercepts clicks. We click "📣 Announce
    // standings" which both closes the modal AND emits
    // announce_score so audience scoreboards know the round is
    // done; matches what a real meet manager would do.
    const roundEndModal = page.locator(".lb-modal");
    if (await roundEndModal.isVisible().catch(() => false)) {
      await page.waitForTimeout(POST_DIVE_MS);
      await page.getByRole("button", { name: /Announce standings/i }).click();
      await page.waitForTimeout(PRE_DIVE_MS);
    }

    // Wait for the SPA to enable the Next button (all N scores
    // processed, history card pushed, judge tiles all .scored).
    await expect(nextBtn).toBeEnabled({ timeout: 10_000 });
    // Hold so the watcher can read the just-completed dive in
    // the history panel before we advance.
    await page.waitForTimeout(POST_DIVE_MS);

    if (i < roster.length - 1) {
      // Click "Next Diver →" — setActive(currentIndex + 1) emits
      // set_active_diver to all subscribers and clears the tiles.
      await nextBtn.click();
      await page.waitForTimeout(PRE_DIVE_MS);
    }
  }

  // ============================================================
  // PHASE 7 — Manager clicks "Finalise" (button text now reads
  // "Event Complete — Finalise & View Results"). The SPA flips
  // status to Completed and pops the in-room leaderboard.
  // ============================================================
  // The Next button morphs into a Finalise variant; clicking it
  // calls finaliseEvent() which now opens a confirm modal listing
  // the consequences (recap publishes, results emails go out,
  // …). Click the modal's primary "Finalise & publish" button to
  // actually flip the status.
  await nextBtn.click();
  const finaliseConfirm = page.locator(".confirm-modal .confirm-btn-primary", {
    hasText: /Finalise/i,
  });
  await expect(finaliseConfirm).toBeVisible({ timeout: 5000 });
  await finaliseConfirm.click();
  // The Control Room's lbShow modal opens; the underlying status
  // flip propagates so the audience scoreboard's recap is ready.
  await page.waitForTimeout(LOGIN_HOLD_MS);

  // ============================================================
  // PHASE 8 — Switch to the audience-facing recap view to verify
  // the leaderboard rendered.
  // ============================================================
  await page.goto(`/scoreboard/${eventId}`);

  // Recap should show one diver-block per "competitor" — but
  // the SPA's divesByDiver groups differently per event_type:
  //   individual   → 1 block per diver  (3 blocks)
  //   synchro_pair → 1 block per pair leader (3 blocks)
  //   team         → 1 block per TEAM, every member's dives
  //                  rolled up under the team name (2 blocks)
  const expectedBlocks =
    VARIANT === "individual"   ? 3 :
    VARIANT === "synchro_pair" ? 3 :
    /* team */                   2;
  await expect(page.locator(".diver-block")).toHaveCount(expectedBlocks, {
    timeout: 10_000,
  });

  // Per-dive table rows. For team events each team-block rolls
  // up every member's dives, so a 2-member team across 3 rounds
  // shows 6 rows. Individual + synchro show one row per round.
  const expectedDiveRows =
    VARIANT === "team"
      ? 2 /* members per team */ * TOTAL_ROUNDS
      : TOTAL_ROUNDS;
  const firstBlock = page.locator(".diver-block").first();
  await expect(firstBlock.locator(".dive-row:not(.dive-head-row)"))
    .toHaveCount(expectedDiveRows);
  // NUM_JUDGES pills on the first dive row.
  await expect(firstBlock.locator(".dive-row").nth(1).locator(".j-score"))
    .toHaveCount(NUM_JUDGES);

  await page.screenshot({
    path: `test-results/meet-manager-${VARIANT}-${HEIGHT}.png`,
    fullPage: true,
  });

  // Hold on the recap so a watching human can read the result
  // before the org gets torn down.
  await page.waitForTimeout(FINAL_HOLD_MS);

  // ============================================================
  // Cleanup.
  // ============================================================
  for (const s of judgeSockets) s.disconnect();
  await setup.deleteOrg(orgId);
});

// pool teardown left to process exit (Playwright tears down the
// worker process anyway). Calling pool.end() here was a foot-gun
// when two specs landed in the same worker — the second hit a
// closed pool. node-postgres handles process exit gracefully.
