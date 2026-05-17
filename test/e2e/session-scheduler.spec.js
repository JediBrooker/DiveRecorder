const { test, expect } = require("@playwright/test");
const setup = require("./_setup");

function auth(token) {
  return { Authorization: `Bearer ${token}` };
}

test("session scheduler scopes editor writes and detects synchro participant conflicts", async ({ request }) => {
  const orgA = await setup.createOrgAndAdmin(request, {
    orgName: "Scheduler E2E A",
    countryCode: "AUS",
  });
  const orgB = await setup.createOrgAndAdmin(request, {
    orgName: "Scheduler E2E B",
    countryCode: "NZL",
  });

  try {
    const meetRes = await request.post("/api/meets", {
      headers: auth(orgA.adminToken),
      data: {
        name: "Scheduler E2E Meet",
        venue: "Test Pool",
        start_date: "2026-07-01",
        end_date: "2026-07-01",
      },
    });
    expect(meetRes.status()).toBe(201);
    const meet = await meetRes.json();

    const startsAt = "2026-07-01T09:00:00.000Z";
    const synchroEvent = await setup.createEvent(request, {
      adminToken: orgA.adminToken,
      meet_id: meet.id,
      name: "Synchro 7m",
      event_type: "synchro_pair",
      number_of_judges: 7,
      height: "3m",
      scheduled_at: startsAt,
      total_rounds: 1,
    });
    expect(synchroEvent.number_of_judges).toBe(7);

    const individualEvent = await setup.createEvent(request, {
      adminToken: orgA.adminToken,
      meet_id: meet.id,
      name: "Individual clash",
      event_type: "individual",
      number_of_judges: 5,
      height: "3m",
      scheduled_at: startsAt,
      total_rounds: 1,
    });

    const lead = await setup.insertUser({
      orgId: orgA.orgId,
      role: "diver",
      fullName: "Scheduler Lead",
    });
    const partner = await setup.insertUser({
      orgId: orgA.orgId,
      role: "diver",
      fullName: "Scheduler Partner",
    });
    const diveId = await setup.pickDiveId({ height: 3.0, dive_code: "101", position: "B" });
    await setup.pool.query(
      `INSERT INTO competitor_dive_lists
         (event_id, competitor_id, partner_id, round_number, dive_id)
       VALUES ($1, $2, $3, 1, $4)`,
      [synchroEvent.id, lead.userId, partner.userId, diveId],
    );
    await setup.insertDiveList({
      eventId: individualEvent.id,
      competitorId: partner.userId,
      dives: [{ round_number: 1, dive_id: diveId }],
    });

    const publicBefore = await request.get(`/api/meets/${meet.id}/sessions`);
    expect(publicBefore.status()).toBe(200);
    expect((await publicBefore.json()).sessions).toHaveLength(0);

    const seeded = await request.get(`/api/meets/${meet.id}/sessions`, {
      headers: auth(orgA.adminToken),
    });
    expect(seeded.status()).toBe(200);
    const seededBody = await seeded.json();
    expect(seededBody.sessions.length).toBeGreaterThan(0);
    expect(seededBody.events.map((e) => e.id)).toEqual(
      expect.arrayContaining([synchroEvent.id, individualEvent.id]),
    );

    const blocks = seededBody.sessions.flatMap((s) => s.blocks || []);
    const eventBlock = blocks.find((b) => b.event_id === synchroEvent.id);
    const warmupBlock = blocks.find((b) => b.block_type === "warmup" && b.label.includes("Synchro"));
    expect(eventBlock).toBeTruthy();
    expect(warmupBlock).toBeTruthy();
    expect(new Date(eventBlock.starts_at).getTime() - new Date(warmupBlock.starts_at).getTime())
      .toBe(45 * 60 * 1000);

    const publicConflicts = await request.get(`/api/meets/${meet.id}/conflicts`);
    expect([401, 403]).toContain(publicConflicts.status());

    const foreignWrite = await request.put(`/api/blocks/${eventBlock.id}`, {
      headers: auth(orgB.adminToken),
      data: { label: "Cross-org edit attempt" },
    });
    expect(foreignWrite.status()).toBe(403);

    const foreignReflow = await request.post("/api/blocks/reflow", {
      headers: auth(orgB.adminToken),
      data: {
        meet_id: meet.id,
        delta_seconds: 600,
        block_ids: [warmupBlock.id],
      },
    });
    expect(foreignReflow.status()).toBe(403);

    const conflictsRes = await request.get(`/api/meets/${meet.id}/conflicts`, {
      headers: auth(orgA.adminToken),
    });
    expect(conflictsRes.status()).toBe(200);
    const conflicts = (await conflictsRes.json()).conflicts;
    const diverConflict = conflicts.find((c) =>
      c.resource_kind === "diver" && c.resource_ids.includes(partner.userId),
    );
    expect(diverConflict, "synchro partner should be treated as a booked diver").toBeTruthy();

    const foreignDismiss = await request.post("/api/conflicts/dismiss", {
      headers: auth(orgB.adminToken),
      data: {
        block_a_id: diverConflict.block_a.id,
        block_b_id: diverConflict.block_b.id,
        resource_kind: "diver",
      },
    });
    expect(foreignDismiss.status()).toBe(403);

    const dismiss = await request.post("/api/conflicts/dismiss", {
      headers: auth(orgA.adminToken),
      data: {
        block_a_id: diverConflict.block_a.id,
        block_b_id: diverConflict.block_b.id,
        resource_kind: "diver",
        reason: "Known staggered deck movement",
      },
    });
    expect(dismiss.status()).toBe(200);
    const dismissal = (await dismiss.json()).dismissal;
    expect(dismissal.resource_kind).toBe("diver");

    const audit = await setup.pool.query(
      `SELECT action, note
         FROM audit_log
        WHERE org_id = $1
          AND entity_type = 'schedule_conflict'
          AND action = 'schedule.conflict_dismissed'
        ORDER BY created_at DESC
        LIMIT 1`,
      [orgA.orgId],
    );
    expect(audit.rows[0]?.note).toBe("Known staggered deck movement");

    const reflow = await request.post("/api/blocks/reflow", {
      headers: auth(orgA.adminToken),
      data: {
        meet_id: meet.id,
        delta_seconds: 600,
        block_ids: [warmupBlock.id],
        reason: "Late shuttle arrival",
      },
    });
    expect(reflow.status()).toBe(200);
    const shifted = await reflow.json();
    expect(shifted.delta_seconds).toBe(600);
    expect(shifted.shifted.map((b) => b.id)).toContain(warmupBlock.id);

    const shiftAudit = await setup.pool.query(
      `SELECT action, note, metadata
         FROM audit_log
        WHERE org_id = $1
          AND entity_type = 'meet'
          AND action = 'schedule.shifted'
        ORDER BY created_at DESC
        LIMIT 1`,
      [orgA.orgId],
    );
    expect(shiftAudit.rows[0]?.note).toBe("Late shuttle arrival");
    expect(shiftAudit.rows[0]?.metadata?.block_ids).toContain(warmupBlock.id);
  } finally {
    await setup.deleteOrg(orgA.orgId);
    await setup.deleteOrg(orgB.orgId);
  }
});
