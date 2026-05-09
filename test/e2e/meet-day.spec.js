// Diver meet-day view — focused phone-deck experience.
//
// What this test exercises end-to-end:
//   1. Org + admin set up via /api/auth/register-org
//   2. Event created (5 rounds, 3m, 5 judges)
//   3. Five judges + three divers
//   4. Each diver gets a 5-round dive list pre-populated
//   5. Round 1: all five judges score every diver. Picked
//      scores so the standings come out: subjectDiver in 2nd.
//   6. Sign in as the subject diver in the browser
//   7. Hit /me/meet/<eventId>
//   8. Assert each block:
//        - "Your next dive" shows R2's dive code + DD
//        - "Current standing" shows 2nd of 3
//        - "What you need" renders gold/silver/bronze rows
//   9. AuthZ probe: a diver NOT entered in the event hitting
//      /api/events/:id/me-meet-day → 403.
//
// Headed mode is the same Playwright flag as everywhere else:
//
//   npx playwright test test/e2e/meet-day.spec.js --headed
//
// Slowing the run down for visual debugging:
//
//   npx playwright test test/e2e/meet-day.spec.js --headed --slow-mo=500
//
// The spec doesn't gate on E2E_HEADED — it works in either mode.
// Use the --headed flag interactively when you want to see the
// browser drive through; CI runs headless.

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("diver meet-day view: dive list, standing, and target math", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(90_000);

  // ---- Org + event + roster ---------------------------------
  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Meet Day Spec",
    number_of_judges: 5,
    total_rounds: 5,
    height: "3m",
  });
  const eventId = event.id;

  // Three divers — one is "us", the other two pad the standings
  // so the rank/target math is non-trivial.
  const subject = await setup.insertUser({
    orgId, role: "diver", fullName: "Subject Diver",
  });
  const subjectLogin = await setup.loginAs(request, subject.username);
  const otherA = await setup.insertUser({
    orgId, role: "diver", fullName: "Diver Alpha",
  });
  const otherB = await setup.insertUser({
    orgId, role: "diver", fullName: "Diver Bravo",
  });

  // Five judges
  const judges = [];
  for (let i = 1; i <= 5; i++) {
    const j = await setup.insertUser({
      orgId, role: "judge", fullName: `Judge ${i}`,
    });
    const login = await setup.loginAs(request, j.username);
    judges.push({ ...j, token: login.token });
  }
  await setup.assignJudges(request, {
    adminToken,
    eventId,
    judgeIds: judges.map(j => j.userId),
  });

  // Five rounds of dive list per diver. Different dives per
  // round so the directory join works; round-1 picks something
  // we can compute the DD for in our head.
  const diveR1 = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const diveR2 = await setup.pickDiveId({ height: 3.0, dive_code: "201", position: "B" });
  const diveR3 = await setup.pickDiveId({ height: 3.0, dive_code: "301", position: "B" });
  const diveR4 = await setup.pickDiveId({ height: 3.0, dive_code: "401", position: "B" });
  const diveR5 = await setup.pickDiveId({ height: 3.0, dive_code: "5132", position: "D" });
  const fullList = [
    { round_number: 1, dive_id: diveR1 },
    { round_number: 2, dive_id: diveR2 },
    { round_number: 3, dive_id: diveR3 },
    { round_number: 4, dive_id: diveR4 },
    { round_number: 5, dive_id: diveR5 },
  ];
  for (const u of [subject, otherA, otherB]) {
    await setup.insertDiveList({
      eventId,
      competitorId: u.userId,
      dives: fullList,
    });
  }

  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });

  // ---- Round 1 scores ---------------------------------------
  // Spread judge scores per diver so standings come out as
  // Alpha > Subject > Bravo. trim drops the high + low on a
  // 5-panel, so the median 3 sum × DD × 1 = round 1 total.
  //   Alpha:   8 8 8 8 8  → trim leaves 8+8+8 = 24
  //   Subject: 7 7 7 7 7  → 7+7+7 = 21
  //   Bravo:   6 6 6 6 6  → 6+6+6 = 18
  // 101B from 3m DD ≈ 1.6, so totals scale roughly:
  //   Alpha ~38, Subject ~34, Bravo ~29.
  async function emitRound1(diver, perJudgeScore) {
    for (let i = 0; i < judges.length; i++) {
      const j = judges[i];
      const sock = io(baseURL, {
        auth: { token: j.token },
        transports: ["websocket"],
        reconnection: false,
      });
      await new Promise((resolve, reject) => {
        sock.on("connect", resolve);
        sock.on("connect_error", reject);
        setTimeout(() => reject(new Error(`socket connect timeout (judge ${i+1})`)), 5000);
      });
      sock.emit("subscribe_event", { event_id: eventId });
      const ack = new Promise((resolve, reject) => {
        sock.on("score_received", resolve);
        sock.on("score_rejected", (m) =>
          reject(new Error(`score rejected: ${JSON.stringify(m)}`)));
        setTimeout(() => reject(new Error(`no ack from judge ${i+1}`)), 5000);
      });
      sock.emit("submit_score", {
        event_id: eventId,
        competitor_id: diver.userId,
        round_number: 1,
        score: perJudgeScore,
        dive_id: diveR1,
      });
      await ack;
      sock.disconnect();
    }
  }
  await emitRound1(otherA,  8);
  await emitRound1(subject, 7);
  await emitRound1(otherB,  6);

  // ---- AuthZ probe: outsider can't read the meet-day bundle ----
  // Build a stranger in a different (active) org and confirm the
  // endpoint refuses them with 403. Tests the entry-list gate in
  // routes/competitor.js.
  const stranger = await setup.createOrgAndAdmin(request, {
    orgName: "E2E Stranger Org",
    countryCode: "STR",
  });
  const strangerProbe = await request.get(`/api/events/${eventId}/me-meet-day`, {
    headers: { Authorization: `Bearer ${stranger.adminToken}` },
  });
  expect(strangerProbe.status()).toBe(403);

  // ---- API check before driving the UI ----------------------
  const apiRes = await request.get(`/api/events/${eventId}/me-meet-day`, {
    headers: { Authorization: `Bearer ${subjectLogin.token}` },
  });
  expect(apiRes.status()).toBe(200);
  const bundle = await apiRes.json();

  // Subject completed 1 of 5 dives; next dive is round 2.
  expect(bundle.completed_dives).toBe(1);
  expect(bundle.remaining_dives).toBe(4);
  expect(bundle.next_dive).toBeTruthy();
  expect(bundle.next_dive.round_number).toBe(2);
  expect(bundle.next_dive.dive_code).toBe("201");
  expect(bundle.next_dive.position).toBe("B");

  // Standing: Subject is 2nd of 3 with Alpha (8s) above and
  // Bravo (6s) below. Total ≈ 21 × DD; assert the order
  // rather than the exact figure (DD comes from the directory
  // and shifts if WA tweaks the catalog).
  expect(bundle.standing.total_competitors).toBe(3);
  expect(bundle.standing.rank).toBe(2);
  expect(bundle.standing.total).toBeGreaterThan(0);
  expect(bundle.standing.behind_leader).toBeGreaterThan(0);

  // Targets: gold reachable but requires a higher avg than
  // silver (already achieved — Subject IS silver). bronze
  // achieved (Subject is ahead of bronze).
  expect(bundle.targets.silver.achieved).toBe(true);
  expect(bundle.targets.bronze.achieved).toBe(true);
  expect(bundle.targets.gold.achieved).toBe(false);
  expect(bundle.targets.gold.needs_avg).not.toBeNull();

  // ---- Sign the subject diver into the browser --------------
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(subject.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  // Login lands on /dashboard.
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });

  // ---- Drive the meet-day view directly ---------------------
  // (We don't depend on the dashboard CTA card here; the URL
  // is the contract.)
  await page.goto(`/me/meet/${eventId}`);
  await page.waitForURL(new RegExp(`/me/meet/${eventId}$`), { timeout: 10_000 });

  // Header — meet name visible.
  await expect(page.getByRole("heading", { name: "E2E Meet Day Spec" }))
    .toBeVisible({ timeout: 10_000 });

  // Block 1: next dive shows R2's dive code (201B).
  await expect(page.getByText("201B")).toBeVisible();

  // Round pip — "R2/5".
  await expect(page.getByText("R2/5")).toBeVisible();

  // Block 2: rank "2nd" and standing labels visible. Use the
  // class selector — the rank's text node is whitespace-wrapped
  // by Vue's interpolation, so anchored regexes (/^2nd$/) miss.
  await expect(page.locator('.md-rank').first()).toContainText('2nd');
  await expect(page.locator('.md-rank-sub').first()).toContainText(/place/i);
  await expect(page.locator('.md-total-sub').first()).toContainText(/points/i);

  // Block 3: target rows. The labels come from formatTarget —
  // expect at least Gold + Silver to be on the page (Bronze
  // achieved is also rendered).
  await expect(page.getByText("Gold")).toBeVisible();
  await expect(page.getByText("Silver")).toBeVisible();
  // Silver is achieved; the body says so.
  await expect(page.getByText(/already achieved/i).first()).toBeVisible();

  // ---- Cleanup ----------------------------------------------
  await setup.deleteOrg(orgId);
  await setup.deleteOrg(stranger.orgId);
});

// Smoke: pre-event state — diver entered in an Upcoming event
// gets a meaningful page (no dives complete yet, no standing
// yet). Cheaper than the full live-event spec above.
test("diver meet-day view: pre-event renders without scores", async ({
  request, page,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);
  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Meet Day Pre",
    number_of_judges: 5,
    total_rounds: 3,
    height: "3m",
  });
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Pre-event Diver",
  });
  const login = await setup.loginAs(request, diver.username);

  const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  await setup.insertDiveList({
    eventId: event.id,
    competitorId: diver.userId,
    dives: [
      { round_number: 1, dive_id: diveId },
      { round_number: 2, dive_id: diveId },
      { round_number: 3, dive_id: diveId },
    ],
  });

  // Event still Upcoming — don't flip to Live.
  const apiRes = await request.get(`/api/events/${event.id}/me-meet-day`, {
    headers: { Authorization: `Bearer ${login.token}` },
  });
  expect(apiRes.status()).toBe(200);
  const bundle = await apiRes.json();

  // No scores anywhere → rank null, total 0, all 3 dives pending.
  expect(bundle.standing.rank).toBeNull();
  expect(bundle.standing.total).toBe(0);
  expect(bundle.completed_dives).toBe(0);
  expect(bundle.remaining_dives).toBe(3);
  expect(bundle.next_dive.round_number).toBe(1);

  // Drive the UI — assert the pre-meet hint shows up.
  await setup.installClickHighlight(page);
  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(diver.username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard/, { timeout: 10_000 });
  await page.goto(`/me/meet/${event.id}`);
  await expect(page.getByText(/this event hasn't started yet/i)).toBeVisible({ timeout: 10_000 });
  // R1's dive still renders so the diver knows what's first.
  await expect(page.getByText("R1/3")).toBeVisible();

  await setup.deleteOrg(orgId);
});
