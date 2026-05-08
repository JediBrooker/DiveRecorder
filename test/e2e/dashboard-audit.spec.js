// Dashboard + audit + wizard coverage.
//
// Three features that landed without dedicated e2e specs:
//
//   1. /api/dashboard bundle endpoint — replaces 5–6 fan-out
//      API calls with a single round trip.
//   2. /api/audit/* federation-wide audit endpoints + the
//      streaming CSV export.
//   3. The first-run setup wizard at /setup.
//
// Each is a quick API/UI test, not a full lifecycle drive.
// The meet-manager spec already covers the score-correction
// path that produces audit rows; this file just verifies the
// new endpoints can read them back and the wizard's redirect
// logic fires for fresh org admins.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

// =============================================================
// 1. /api/dashboard bundle endpoint
// =============================================================
test("dashboard bundle endpoint returns role-scoped slices", async ({ request }) => {
  test.setTimeout(30_000);

  const { adminToken } = await setup.createOrgAndAdmin(request);

  const res = await request.get("/api/dashboard", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(res.status()).toBe(200);
  const body = await res.json();

  // Org admin should see events + role_requests + recent_activity
  // (sysadmin-only slices like pending_orgs aren't in this
  // user's scope).
  expect(Array.isArray(body.events)).toBe(true);
  expect(Array.isArray(body.role_requests)).toBe(true);
  expect(Array.isArray(body.recent_activity)).toBe(true);
  // Fresh org has nothing yet — but the keys must be present.
});

// =============================================================
// 2. /api/audit/* — federation-wide audit endpoints
// =============================================================
test("audit endpoints expose role + event lifecycle activity", async ({ request }) => {
  test.setTimeout(30_000);

  const { adminToken } = await setup.createOrgAndAdmin(request);

  // Trigger an event-lifecycle audit row by creating an event.
  await setup.createEvent(request, {
    adminToken,
    name: "E2E Audit Spec Event",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 2,
  });

  // /api/audit/activity should now include the create row.
  const r1 = await request.get("/api/audit/activity?limit=20", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(r1.status()).toBe(200);
  const activity = await r1.json();
  // Find the event.created row we just produced.
  const created = activity.find((row) =>
    row.action === "event.created" && row.entity_name === "E2E Audit Spec Event",
  );
  expect(created, "event.created audit row").toBeDefined();
  expect(created.entity_type).toBe("event");

  // /api/audit/recent should interleave it with whatever else.
  const r2 = await request.get("/api/audit/recent?limit=20&days=1", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(r2.status()).toBe(200);
  const recent = await r2.json();
  const inRecent = recent.find((row) =>
    row.kind === "activity" && row.action === "event.created",
  );
  expect(inRecent, "recent feed picks up activity rows").toBeDefined();

  // /api/audit/export.csv streams CSV. Header line + at least
  // one data row for the activity we just produced.
  const r3 = await request.get("/api/audit/export.csv?kind=activity", {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  expect(r3.status()).toBe(200);
  expect(r3.headers()["content-type"]).toContain("text/csv");
  const csv = await r3.text();
  expect(csv.split("\n")[0]).toContain("time,action,entity_type");
  expect(csv).toContain("event.created");
});

// =============================================================
// 3. First-run setup wizard
// =============================================================
test("fresh org admin is redirected to /setup wizard", async ({
  request, page, baseURL,
}) => {
  test.setTimeout(60_000);

  // createOrgAndAdmin gives us a fresh org with NO events and
  // NO clubs. The dashboard's onMounted should detect this and
  // router.replace('/setup').
  const { username } = await setup.createOrgAndAdmin(request);

  await page.goto("/login");
  await page.locator('input[autocomplete="username"]').fill(username);
  await page.locator('input[autocomplete="current-password"]').fill(setup.TEST_PASSWORD);
  await page.getByRole("button", { name: /Sign In/i }).click();

  // Login redirects to /dashboard, dashboard's onMounted then
  // bounces to /setup. Wait for the wizard URL.
  await page.waitForURL(/\/setup$/, { timeout: 10_000 });
  // Confirm the wizard rendered — step 1's heading.
  await expect(page.getByRole("heading", {
    name: /Welcome — let's get you set up/i,
  })).toBeVisible({ timeout: 5_000 });

  // Click the "Skip setup" link in the header — should land
  // back on /dashboard and the localStorage stamp should
  // prevent another redirect.
  await page.getByRole("button", { name: /Skip setup/i }).click();
  await page.waitForURL(/\/dashboard$/, { timeout: 5_000 });
});
