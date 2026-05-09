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
