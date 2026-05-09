// Stage progression — prelim → semi → final advance flow
// (migration 040 + the matching POST /api/events/:id/advance
// + GET /api/events/:id/advance/preview endpoints).
//
// The test exercises the API contract end-to-end:
//
//   1. Create a prelim + final event (final.parent_event_id =
//      prelim.id).
//   2. Hit the preview endpoint — returns the child event's
//      handle and an empty `ranked` array (no scores yet).
//   3. Hit advance on a non-Completed parent — rejected with
//      `400 Parent event must be Completed`.
//   4. Flip the prelim to Completed without scoring → advance
//      now passes the status gate but rejects with
//      `400 Parent event has no scored divers`.
//   5. Insert a synthetic reserve row + hit the promote
//      endpoint — flag flips, display_order is assigned at the
//      back of the queue.
//
// Note: a "real" advance (top divers actually picked from a
// scored prelim) requires inserting score rows + judges + the
// calc_event_dive_points stored proc to produce ranks. The
// meet-manager spec already exercises that end-to-end flow on
// a single event; this spec focuses on the API contract for
// the new advance + promote endpoints.

const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

test.describe.configure({ mode: "serial" });

test("advance: preview + status gates + promote", async ({ request }) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // ---- Build the two-stage chain --------------------------
  const prelim = await setup.createEvent(request, {
    adminToken,
    name: "E2E Prelim",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "preliminary",
  });
  const finalEv = await setup.createEvent(request, {
    adminToken,
    name: "E2E Final",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 3,
    event_format: "final",
    parent_event_id: prelim.id,
  });

  // ---- Preview returns child + empty ranked list ----------
  const previewRes = await request.get(
    `/api/events/${prelim.id}/advance/preview`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  expect(previewRes.status()).toBe(200);
  const preview = await previewRes.json();
  expect(preview.child).toBeTruthy();
  expect(preview.child.id).toBe(finalEv.id);
  expect(preview.child.format).toBe("final");
  expect(Array.isArray(preview.ranked)).toBe(true);
  expect(preview.ranked).toHaveLength(0);

  // ---- ADVANCE on a non-Completed parent → 400 ------------
  const earlyRes = await request.post(
    `/api/events/${prelim.id}/advance`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { top_n: 12, reserves: 0, dive_order: "inherit" },
    },
  );
  expect(earlyRes.status()).toBe(400);
  expect((await earlyRes.json()).error).toMatch(/Completed/i);

  // ---- Flip prelim to Completed, but no scores → 400 ------
  // setEventStatus walks Upcoming → Live → Completed; the
  // server allows Completed directly (Live requires sign-off).
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Live",
  });
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Completed",
  });
  const noScoresRes = await request.post(
    `/api/events/${prelim.id}/advance`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { top_n: 12, reserves: 0, dive_order: "inherit" },
    },
  );
  expect(noScoresRes.status()).toBe(400);
  expect((await noScoresRes.json()).error).toMatch(/no scored divers/i);

  // ---- PROMOTE a synthetic reserve ------------------------
  // Insert a reserve row directly so we can exercise the
  // /reserves/:competitorId/promote endpoint without needing
  // the full advance flow.
  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Reserve Test Diver",
  });
  const fwd = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });
  // Manual reserve row — bypass the public API since
  // submit-list won't write is_reserve.
  await setup.pool.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, dive_id, round_number, is_reserve, reserve_position)
     VALUES ($1, $2, $3, 1, TRUE, 1)`,
    [finalEv.id, diver.userId, fwd],
  );

  const promoteRes = await request.post(
    `/api/events/${finalEv.id}/reserves/${diver.userId}/promote`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  expect(promoteRes.status()).toBe(200);
  const promoteBody = await promoteRes.json();
  expect(promoteBody.promoted).toBe(true);
  expect(promoteBody.display_order).toBe(1); // first/only active diver

  // Verify the row is no longer flagged as reserve.
  const verify = await setup.pool.query(
    `SELECT is_reserve, reserve_position, display_order
       FROM competitor_dive_lists
      WHERE event_id = $1 AND competitor_id = $2
      LIMIT 1`,
    [finalEv.id, diver.userId],
  );
  expect(verify.rows[0].is_reserve).toBe(false);
  expect(verify.rows[0].reserve_position).toBeNull();
  expect(Number(verify.rows[0].display_order)).toBe(1);

  // Promoting an already-active diver returns 404.
  const repromoteRes = await request.post(
    `/api/events/${finalEv.id}/reserves/${diver.userId}/promote`,
    { headers: { Authorization: `Bearer ${adminToken}` } },
  );
  expect(repromoteRes.status()).toBe(404);

  await setup.deleteOrg(orgId);
});

// Migration 041: post-advance dive-list lock (WA DD 7.4 / 7.5)
// + confirm-list endpoint. Verifies:
//   * the advance endpoint stamps dive_list_locks_at on the
//     child event (and respects lock_minutes from the body)
//   * loadEventForEntries treats a past lock as a 409 with the
//     "dive list locked" message
//   * /api/competitor/confirm-list stamps confirmed_at
//   * a re-submit via /api/competitor/submit-list upserts the
//     existing rows + stamps confirmed_at

test("advance: dive-list lock + confirm-list endpoint", async ({ request }) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  // Build a prelim → final pair, populate prelim with a single
  // diver + one synthetic score row so the advance has someone
  // to rank.
  const prelim = await setup.createEvent(request, {
    adminToken,
    name: "E2E Lock Prelim",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "preliminary",
  });
  const finalEv = await setup.createEvent(request, {
    adminToken,
    name: "E2E Lock Final",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "final",
    parent_event_id: prelim.id,
  });

  const diver = await setup.insertUser({
    orgId, role: "diver", fullName: "Lock Diver",
  });
  const fwd = await setup.pickDiveId({
    height: 3.0, dive_code: "101", position: "B",
  });
  await setup.insertDiveList({
    eventId: prelim.id,
    competitorId: diver.userId,
    dives: [{ round_number: 1, dive_id: fwd }],
  });

  // Synthetic 5-judge panel + scores. Each judge_user gets a
  // judge_id assigned via event_judges; scores rows reference
  // both. calc_event_dive_points trims high+low + sums × DD.
  const judges = await Promise.all(Array.from({ length: 5 }, () =>
    setup.insertUser({ orgId, role: "judge", fullName: "Lock Judge" }),
  ));
  for (let i = 0; i < judges.length; i++) {
    await setup.pool.query(
      `INSERT INTO event_judges (event_id, judge_id, judge_number)
       VALUES ($1, $2, $3)`,
      [prelim.id, judges[i].userId, i + 1],
    );
    await setup.pool.query(
      `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
       VALUES ($1, $2, $3, $4, 1, 7.0)`,
      [prelim.id, diver.userId, judges[i].userId, fwd],
    );
  }

  // Flip prelim to Completed.
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Live",
  });
  await setup.setEventStatus(request, {
    adminToken, eventId: prelim.id, status: "Completed",
  });

  // Advance with lock_minutes: 30 (default) — verify the lock
  // timestamp is stamped on the final.
  const advanceRes = await request.post(`/api/events/${prelim.id}/advance`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { top_n: 1, reserves: 0, dive_order: "inherit", lock_minutes: 30 },
  });
  expect(advanceRes.status()).toBe(200);
  const advance = await advanceRes.json();
  expect(advance.advanced).toBe(1);
  expect(advance.dive_list_locks_at).toBeTruthy();

  // The lock timestamp on events.dive_list_locks_at should be ~30
  // minutes in the future.
  const lockRow = await setup.pool.query(
    "SELECT dive_list_locks_at FROM events WHERE id = $1",
    [finalEv.id],
  );
  const lockAt = new Date(lockRow.rows[0].dive_list_locks_at);
  const now = new Date();
  const minutesAhead = (lockAt - now) / 60000;
  expect(minutesAhead).toBeGreaterThan(28);
  expect(minutesAhead).toBeLessThan(32);

  // confirm-list endpoint stamps confirmed_at.
  const diverLogin = await setup.loginAs(request, diver.username);
  const confirmRes = await request.post("/api/competitor/confirm-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: { event_id: finalEv.id },
  });
  expect(confirmRes.status()).toBe(200);
  expect((await confirmRes.json()).confirmed).toBe(true);

  const confirmedRow = await setup.pool.query(
    `SELECT confirmed_at FROM competitor_dive_lists
       WHERE event_id = $1 AND competitor_id = $2 LIMIT 1`,
    [finalEv.id, diver.userId],
  );
  expect(confirmedRow.rows[0].confirmed_at).not.toBeNull();

  // Push the lock into the past + verify the entries gate fires.
  await setup.pool.query(
    "UPDATE events SET dive_list_locks_at = NOW() - interval '5 minutes' WHERE id = $1",
    [finalEv.id],
  );
  const lateSubmit = await request.post("/api/competitor/submit-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: {
      event_id: finalEv.id,
      dives: [{ round_number: 1, dive_id: fwd }],
    },
  });
  expect(lateSubmit.status()).toBe(409);
  expect((await lateSubmit.json()).error).toMatch(/locked/i);

  // Confirm-list still works post-lock (it's a no-op on the
  // dive_id, just re-stamps the timestamp).
  const lateConfirm = await request.post("/api/competitor/confirm-list", {
    headers: { Authorization: `Bearer ${diverLogin.token}` },
    data: { event_id: finalEv.id },
  });
  expect(lateConfirm.status()).toBe(200);

  await setup.deleteOrg(orgId);
});

// Reserve replacement — World Aquatics rule DD 9.1 / 9.2: when
// a primary withdraws before the event starts, the reserve takes
// the WITHDRAWN diver's start position so the dive order is
// preserved (vs. just being slotted at the back of the queue).
//
// Test:
//   1. Create an event with 2 primaries (display_order 1, 2)
//      and 1 reserve (reserve_position=1, no display_order).
//   2. Hit promote with `replaces_competitor_id` = primary 1.
//   3. Verify primary 1 is now withdrawn (withdrawn_at stamped,
//      display_order cleared) AND the reserve has primary 1's
//      original display_order=1.
//   4. List endpoint should now return 0 reserves + 1 withdrawn.

test("advance: reserve replaces a withdrawn primary, inherits start order", async ({
  request,
}) => {
  test.setTimeout(45_000);

  const { orgId, adminToken } = await setup.createOrgAndAdmin(request);

  const event = await setup.createEvent(request, {
    adminToken,
    name: "E2E Reserve Replace",
    height: "3m",
    number_of_judges: 5,
    total_rounds: 1,
    event_format: "final",
  });

  // Insert two primaries (display_order 1 + 2) and one reserve.
  const fwd = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
  const primaryA = await setup.insertUser({ orgId, role: "diver", fullName: "Primary A" });
  const primaryB = await setup.insertUser({ orgId, role: "diver", fullName: "Primary B" });
  const reserve  = await setup.insertUser({ orgId, role: "diver", fullName: "Reserve One" });

  await setup.pool.query(
    `INSERT INTO competitor_dive_lists
       (event_id, competitor_id, dive_id, round_number, display_order, is_reserve, reserve_position)
     VALUES
       ($1, $2, $3, 1, 1, FALSE, NULL),
       ($1, $4, $3, 1, 2, FALSE, NULL),
       ($1, $5, $3, 1, NULL, TRUE, 1)`,
    [event.id, primaryA.userId, fwd, primaryB.userId, reserve.userId],
  );

  // Sanity: reserves list shows 1 reserve + 0 withdrawn + 2 active.
  const before = await request.get(`/api/events/${event.id}/reserves`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const beforeBody = await before.json();
  expect(beforeBody.reserves).toHaveLength(1);
  expect(beforeBody.withdrawn).toHaveLength(0);
  expect(beforeBody.active).toHaveLength(2);

  // Replace primary A with the reserve.
  const promoteRes = await request.post(
    `/api/events/${event.id}/reserves/${reserve.userId}/promote`,
    {
      headers: { Authorization: `Bearer ${adminToken}` },
      data: { replaces_competitor_id: primaryA.userId },
    },
  );
  expect(promoteRes.status()).toBe(200);
  const promoteBody = await promoteRes.json();
  expect(promoteBody.promoted).toBe(true);
  // The reserve takes primary A's display_order, NOT the back
  // of the queue (which would be 3).
  expect(promoteBody.display_order).toBe(1);
  expect(promoteBody.replaced_competitor_id).toBe(primaryA.userId);
  expect(promoteBody.replaced_name).toBe("Primary A");

  // Verify the data flipped correctly.
  const verify = await setup.pool.query(
    `SELECT competitor_id, display_order, is_reserve, withdrawn_at
       FROM competitor_dive_lists
      WHERE event_id = $1
      ORDER BY display_order NULLS LAST`,
    [event.id],
  );
  // Reserve now has display_order=1, is_reserve=false.
  const reserveRow = verify.rows.find(r => r.competitor_id === reserve.userId);
  expect(Number(reserveRow.display_order)).toBe(1);
  expect(reserveRow.is_reserve).toBe(false);
  expect(reserveRow.withdrawn_at).toBeNull();
  // Primary A is now withdrawn with cleared display_order.
  const aRow = verify.rows.find(r => r.competitor_id === primaryA.userId);
  expect(aRow.display_order).toBeNull();
  expect(aRow.withdrawn_at).not.toBeNull();
  // Primary B unchanged at display_order=2.
  const bRow = verify.rows.find(r => r.competitor_id === primaryB.userId);
  expect(Number(bRow.display_order)).toBe(2);

  // Reserves list now shows 0 reserves + 1 withdrawn + 2 active
  // (primary B + the just-promoted reserve).
  const after = await request.get(`/api/events/${event.id}/reserves`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const afterBody = await after.json();
  expect(afterBody.reserves).toHaveLength(0);
  expect(afterBody.withdrawn).toHaveLength(1);
  expect(afterBody.withdrawn[0].full_name).toBe("Primary A");
  expect(afterBody.active).toHaveLength(2);

  // Diver-side list-status: the promoted reserve is now NOT a
  // reserve.
  const reserveLogin = await setup.loginAs(request, reserve.username);
  const status = await request.get(
    `/api/competitor/list-status?event_id=${event.id}`,
    { headers: { Authorization: `Bearer ${reserveLogin.token}` } },
  );
  expect(status.status()).toBe(200);
  const statusBody = await status.json();
  expect(statusBody.entered).toBe(true);
  expect(statusBody.is_reserve).toBe(false);

  await setup.deleteOrg(orgId);
});
