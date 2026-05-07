// UI-driven version of the scoring pipeline test. The other
// scoring spec (scoring.spec.js) verifies the API + socket
// pipeline as fast as possible — this one drives the actual SPA
// so you can WATCH the result render.
//
// Run it headed to see Chrome open and click through:
//   npx playwright test test/e2e/scoreboard-ui.spec.js --headed --workers=1
//   npx playwright test test/e2e/scoreboard-ui.spec.js --ui
//
// Or with slow-mo so each action is visible:
//   npx playwright test test/e2e/scoreboard-ui.spec.js --headed --workers=1 --project=chromium
//   PWDEBUG=1 npx playwright test test/e2e/scoreboard-ui.spec.js
//
// What you'll see on screen:
//   1. Browser opens to /login
//   2. Username + password get typed in field-by-field
//   3. Sign In button is clicked, page redirects to /dashboard
//   4. Page navigates to /scoreboard/<eventId>
//   5. Diver A's name + total appear in the standings panel
//   6. (Pause briefly so you can read it before cleanup.)

const { test, expect } = require("@playwright/test");
const { io } = require("socket.io-client");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("watch a meet end-to-end: login → scoreboard renders Diver A's total", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(90_000);

  // ============================================================
  // PHASE 1 — silent API setup (no UI). Same fixtures as the
  // headless scoring test, just so we have something for the SPA
  // to render in PHASE 2.
  // ============================================================
  const { orgId, username: adminUsername, adminToken } =
    await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Live Scoreboard Demo",
    number_of_judges: 5,
    total_rounds: 1,
    height: "3m",
  });
  const eventId = event.id;

  const diverA = await setup.insertUser({
    orgId, role: "diver", fullName: "Diver A",
  });

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

  const diveId = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });
  await setup.insertDiveList({
    eventId,
    competitorId: diverA.userId,
    dives: [{ round_number: 1, dive_id: diveId }],
  });

  await setup.setEventStatus(request, { adminToken, eventId, status: "Live" });

  // 5 judges submit via sockets. Same pattern as scoring.spec.js
  // — see comments there for why we wire the listeners before
  // emitting the score.
  const scoreValues = [7.0, 7.5, 8.0, 8.5, 9.0];
  for (let i = 0; i < judges.length; i++) {
    const sock = io(baseURL, {
      auth: { token: judges[i].token },
      transports: ["websocket"],
      reconnection: false,
    });
    await new Promise((resolve, reject) => {
      sock.on("connect", resolve);
      sock.on("connect_error", reject);
      setTimeout(() => reject(new Error(`connect timeout judge ${i}`)), 5000);
    });
    sock.emit("subscribe_event", { event_id: eventId });
    const ack = new Promise((resolve, reject) => {
      sock.on("score_received", resolve);
      sock.on("score_rejected", (m) =>
        reject(new Error(`rejected judge ${i}: ${JSON.stringify(m)}`)));
      setTimeout(() => reject(new Error(`no ack judge ${i}`)), 5000);
    });
    sock.emit("submit_score", {
      event_id: eventId,
      competitor_id: diverA.userId,
      round_number: 1,
      score: scoreValues[i],
      dive_id: diveId,
    });
    await ack;
    sock.disconnect();
  }

  // ============================================================
  // PHASE 2 — drive the actual UI. THIS is what shows on screen.
  // ============================================================

  // 1. Open the login page.
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign In" })).toBeVisible();

  // 2. Fill username + password. The <label>s in the SPA aren't
  //    associated to the inputs via for=/aria-labelledby, so
  //    getByLabel can't find them — use the autocomplete-attribute
  //    selectors that the markup already carries.
  await page.locator('input[autocomplete="username"]').fill(adminUsername);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);

  // 3. Click the Sign In button. The SPA POSTs /api/auth/login,
  //    saves the JWT into the auth store (localStorage under the
  //    hood), then routes to /dashboard.
  await page.getByRole("button", { name: /Sign In/i }).click();
  await page.waitForURL(/\/dashboard$/);
  await expect(page).toHaveURL(/\/dashboard$/);

  // 4. Navigate to the scoreboard for our event. The SPA pulls
  //    /api/scoreboard/:id on mount and renders the standings.
  await page.goto(`/scoreboard/${eventId}`);

  // 5. The standings row should appear with Diver A's name + a
  //    total in the 20–60 range (after high/low trim of 7+9, the
  //    median three sum to 24, multiplied by the 101B DD ≈ 40+).
  const firstStanding = page.locator(".standing").first();
  await expect(firstStanding).toBeVisible({ timeout: 10_000 });
  await expect(firstStanding.locator(".standing-name")).toContainText("Diver A");

  const scoreText = await firstStanding.locator(".standing-score").innerText();
  // The score cell may also include a "=" tie-marker prefix; just
  // pull the first decimal number out of the text.
  const total = Number((scoreText.match(/[\d.]+/) || [])[0]);
  expect(total).toBeGreaterThan(20);
  expect(total).toBeLessThan(60);

  // 6. Save a screenshot so you have a record to look at after
  //    the test exits (the org gets cleaned up below).
  await page.screenshot({
    path: `test-results/scoreboard-${eventId}.png`,
    fullPage: true,
  });

  // Pause so a watching human can read the screen before the
  // teardown wipes the org. Skip when running in CI — there's no
  // human to watch and CI sets E2E_HEADED=false (or unset).
  if (process.env.PWDEBUG || process.env.PW_PAUSE) {
    await page.waitForTimeout(5000);
  }

  // ============================================================
  // Cleanup.
  // ============================================================
  await setup.deleteOrg(orgId);
});

test.afterAll(async () => {
  await setup.pool.end();
});
