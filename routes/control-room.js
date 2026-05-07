// Control-Room routes — everything the operator hits from the
// pre-meet roster screen and during-meet queue management.
//
//   GET    /api/events/:id/roster                roster + dive lists
//   PUT    /api/dive-lists/:id/order             single-row reorder
//   PUT    /api/events/:id/dive-lists/reorder    bulk drag-and-drop
//   POST   /api/events/:id/dive-lists/randomize  shuffle pre-meet
//   PUT    /api/dive-lists/:id/withdraw          scratch / reinstate
//   GET    /api/events/:id/attendance            check-in list
//   PUT    /api/events/:id/attendance/:competitorId  set status
//   POST   /api/events/:id/roster                late-entry add
//   POST   /api/events/:id/roster/import         CSV bulk import
//   GET    /api/events/:id/history               public dive history
//
// Reorder + randomize are locked once an event flips out of
// 'Upcoming'; operators withdraw scratchers instead. Late-entry
// is the manager-only override that intentionally works after
// entries close (the diver showed up; we can't say "you're too
// late" once the meet is running).
//
// Mounted via:
//   app.use(require('./routes/control-room')({ … }))

const express = require("express");
const { publicId } = require("../lib/public-id");

// Light CSV parser. Handles "quoted, fields", "doubled""quotes"
// inside quoted fields, and trailing/leading whitespace. Doesn't
// pull a dependency for what's a 30-line job; the input is
// always small (a meet roster, not a database export).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuoted = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuoted = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        if (field.length || row.length) { row.push(field); rows.push(row); }
        row = []; field = "";
      } else {
        field += ch;
      }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

module.exports = function createControlRoomRouter({
  pool,
  requireOrgRole,
  requireMeetEditor,
  bulkWriteLimiter,
  ensureEventOrgGate,
}) {
  if (!pool) throw new Error("createControlRoomRouter requires { pool, … }");
  const router = express.Router();

  // Tuple repeated 7× across the original section. Build it once
  // here so a typo can't drift one route's role gate.
  const requireMeetController = requireOrgRole(["org_admin", "meet_manager", "referee"]);

  // -------------------------------------------------------------
  // GET /api/events/:id/roster — full dive list + diver metadata
  // for the Control Room queue. Withdrawn rows are returned but
  // flagged so the UI can render scratched divers separately.
  // -------------------------------------------------------------
  router.get("/api/events/:id/roster", requireMeetController, async (req, res) => {
    try {
      // Cross-org gate. requireOrgRole only checks the caller HAS
      // a role; it doesn't check the event in :id is in their org.
      // Without this any meet_manager could enumerate roster +
      // dive lists for any other org's events by guessing UUIDs.
      if (!(await ensureEventOrgGate(req, res, "id"))) return;

      const r = await pool.query(
        `SELECT cdl.id AS dive_list_id,
                cdl.display_order, cdl.withdrawn_at,
                u.id AS competitor_id, u.full_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                cdl.partner_id, pu.full_name AS partner_name, po.country_code AS partner_country,
                cdl.team_id, t.name AS team_name, t.short_code AS team_code,
                /* public_id + team_public_id used to be computed
                   inline with pgcrypto's digest() — but pgcrypto
                   isn't enabled on every postgres install, and a
                   missing extension threw the whole query. We now
                   compute them in Node after the result lands
                   (see publicId() below). */
                cdl.event_id, cdl.round_number, cdl.dive_id,
                d.dive_code, d.description, d.dd, d.position,
                e.event_type, e.number_of_judges
         FROM users u
         JOIN competitor_dive_lists cdl ON u.id = cdl.competitor_id
         /* LEFT JOIN dive_directory — a competitor_dive_lists row
            with cdl.dive_id IS NULL (diver hasn't filed their
            full list yet) or pointing at a deleted directory
            entry would otherwise drop the diver from the queue
            entirely. INNER JOIN here was previously rendering
            an empty 0/0 queue for any event with a single bad
            row. The frontend handles NULL dive_code/dd gracefully. */
         LEFT JOIN dive_directory d ON cdl.dive_id = d.id
         JOIN organisations o ON u.org_id = o.id
         JOIN events e ON e.id = cdl.event_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         LEFT JOIN organisations po ON po.id = pu.org_id
         LEFT JOIN teams t ON t.id = cdl.team_id
         WHERE cdl.event_id = $1
         ORDER BY cdl.round_number ASC,
                  t.name ASC NULLS LAST,
                  cdl.display_order ASC NULLS LAST,
                  u.full_name ASC`,
        [req.params.id],
      );
      const enriched = r.rows.map((row) => ({
        ...row,
        public_id:      publicId("comp", row.event_id, row.competitor_id),
        team_public_id: row.team_id
          ? publicId("team", row.event_id, row.team_id)
          : null,
      }));
      res.json(enriched);
    } catch (err) {
      console.error("[Roster Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // PUT /api/dive-lists/:id/order — single-row reorder. Body:
  // { display_order: int | null }. Locked once status != Upcoming.
  // -------------------------------------------------------------
  router.put("/api/dive-lists/:id/order", requireMeetController, async (req, res) => {
    const { display_order } = req.body || {};
    if (display_order != null && !Number.isInteger(display_order)) {
      return res.status(400).json({ error: "display_order must be an integer or null" });
    }
    try {
      const owner = await pool.query(
        `SELECT e.id, e.status, e.name, e.org_id
         FROM competitor_dive_lists cdl
         JOIN events e ON e.id = cdl.event_id
         WHERE cdl.id = $1`,
        [req.params.id],
      );
      if (!owner.rows.length) {
        return res.status(404).json({ error: "Dive list row not found" });
      }
      const ev = owner.rows[0];
      if (!req.user.is_system_admin && ev.org_id !== req.user.org_id) {
        return res.status(403).json({ error: "Event is not in your organisation" });
      }
      if (ev.status !== "Upcoming") {
        return res.status(409).json({
          error:
            `Cannot change the dive order once "${ev.name}" has started ` +
            `(status is ${ev.status}). Withdraw a diver instead if they ` +
            `need to be skipped.`,
          event_status: ev.status,
        });
      }
      const r = await pool.query(
        `UPDATE competitor_dive_lists cdl
         SET display_order = $1
         WHERE cdl.id = $2
         RETURNING cdl.id, cdl.display_order`,
        [display_order ?? null, req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Dive list row not found" });
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Reorder Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/events/:id/dive-lists/reorder — bulk drag-and-drop.
  // Atomic against partial failures. Cap of 500 rows / request.
  // -------------------------------------------------------------
  router.put("/api/events/:id/dive-lists/reorder", requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }
    if (rows.length > 500) {
      return res.status(413).json({ error: "Too many rows in one request" });
    }
    for (const r of rows) {
      if (!r || typeof r.id !== "string"
          || !Number.isInteger(r.display_order)) {
        return res.status(400).json({ error: "Each row needs id (uuid) + integer display_order" });
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const ev = await client.query(
        "SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Event not found" });
      }
      if (ev.rows[0].status !== "Upcoming") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            `Cannot re-order divers once "${ev.rows[0].name}" has started ` +
            `(status is ${ev.rows[0].status}). Withdraw a diver instead if they ` +
            `need to be skipped.`,
          event_status: ev.rows[0].status,
        });
      }
      let updated = 0;
      for (const r of rows) {
        const u = await client.query(
          `UPDATE competitor_dive_lists
           SET display_order = $1
           WHERE id = $2 AND event_id = $3`,
          [r.display_order, r.id, eventId],
        );
        updated += u.rowCount;
      }
      await client.query("COMMIT");
      res.json({ ok: true, updated });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Bulk Reorder Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-lists/randomize — pre-meet shuffle.
  // Each unique competitor gets one random position applied to
  // every round they're in, so "Diver Z dives 1st" stays
  // consistent across rounds.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-lists/randomize", requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        "SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error:
            `Cannot randomise the start order once "${ev.rows[0].name}" has started ` +
            `(status is ${ev.rows[0].status}). The published order is now fixed.`,
          event_status: ev.rows[0].status,
        });
      }

      // Pick a random ordering of the unique competitors, then
      // apply that ordering across every round in one UPDATE.
      // Withdrawn rows are excluded from the shuffle pool but
      // still get a display_order assigned via the JOIN — they
      // just sort to the end of their slot when reinstated.
      const r = await pool.query(
        `WITH shuffled AS (
           SELECT DISTINCT competitor_id,
                  ROW_NUMBER() OVER (ORDER BY random()) AS pos
           FROM competitor_dive_lists
           WHERE event_id = $1 AND withdrawn_at IS NULL
         )
         UPDATE competitor_dive_lists cdl
         SET display_order = sh.pos
         FROM shuffled sh
         WHERE cdl.event_id = $1
           AND cdl.competitor_id = sh.competitor_id
         RETURNING cdl.id`,
        [eventId],
      );

      // Pre-meet workflow: the order has changed, so stamp
      // randomised_at and clear any prior sign-off — the referee
      // signs off on the FINAL order, not a previous shuffle.
      await pool.query(
        `UPDATE events
         SET dive_order_randomised_at = now(),
             dive_order_signed_off_at = NULL,
             dive_order_signed_off_by = NULL
         WHERE id = $1`,
        [eventId],
      );

      res.json({ ok: true, updated: r.rowCount });
    } catch (err) {
      console.error("[Randomize Order Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-order/sign-off — referee approves
  // the published order. Records who signed off + when. The
  // Control Room's 3-state button reads this back via the events
  // payload and turns green ("Start Event") once the timestamp
  // is set.
  //
  // Role gate is the same requireMeetController used by the
  // reorder endpoints — meet_managers, referees and org_admins
  // can sign off. The recorded signed_off_by user_id is whoever
  // was logged in at that moment, so the audit trail still names
  // the actual person regardless of which staff role they hold.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-order/sign-off", requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name, dive_order_randomised_at
         FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot sign off — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      const r = await pool.query(
        `UPDATE events
         SET dive_order_signed_off_at = now(),
             dive_order_signed_off_by = $1
         WHERE id = $2
         RETURNING dive_order_signed_off_at, dive_order_signed_off_by`,
        [req.user.id, eventId],
      );
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Dive Order Sign-Off Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/check-in/confirm — operator confirms
  // pre-meet check-in is complete and the workflow can advance
  // to the randomise step. Stamps check_in_done_at on the event.
  // The actual per-diver attendance rows live in event_attendance
  // and are unaffected; this is just the gate signal.
  // -------------------------------------------------------------
  router.post("/api/events/:id/check-in/confirm", requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot confirm check-in — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      const r = await pool.query(
        `UPDATE events
         SET check_in_done_at = COALESCE(check_in_done_at, now())
         WHERE id = $1
         RETURNING check_in_done_at`,
        [eventId],
      );
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Check-In Confirm Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-order/reset — clears every pre-meet
  // workflow stamp (check-in confirmation, randomise, sign-off)
  // so the operator can walk the four states again from the top.
  // Used by the "↺ Reset" affordance next to the workflow button.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-order/reset", requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot reset workflow — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      await pool.query(
        `UPDATE events
         SET check_in_done_at         = NULL,
             dive_order_randomised_at = NULL,
             dive_order_signed_off_at = NULL,
             dive_order_signed_off_by = NULL
         WHERE id = $1`,
        [eventId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[Dive Order Reset Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/dive-order/confirm — operator chose to
  // skip the randomise step (e.g. the order was already arranged
  // manually) and wants to advance to sign-off. Just stamps
  // randomised_at without touching display_order.
  // -------------------------------------------------------------
  router.post("/api/events/:id/dive-order/confirm", requireMeetController, async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        `SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error: `Cannot advance workflow — event "${ev.rows[0].name}" is ${ev.rows[0].status}.`,
        });
      }
      await pool.query(
        `UPDATE events
         SET dive_order_randomised_at = COALESCE(dive_order_randomised_at, now())
         WHERE id = $1`,
        [eventId],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error("[Dive Order Confirm Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/dive-lists/:id/withdraw — scratch / reinstate. Body:
  // { withdrawn: bool }. Standings still attribute prior dives;
  // the active queue excludes them from upcoming rounds.
  // -------------------------------------------------------------
  router.put("/api/dive-lists/:id/withdraw", requireMeetController, async (req, res) => {
    const { withdrawn } = req.body || {};
    try {
      const r = await pool.query(
        `UPDATE competitor_dive_lists cdl
         SET withdrawn_at = CASE WHEN $1::boolean THEN now() ELSE NULL END
         FROM events e
         WHERE cdl.id = $2 AND cdl.event_id = e.id
           AND ($3::boolean OR e.org_id = $4)
         RETURNING cdl.id, cdl.withdrawn_at`,
        [!!withdrawn, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Dive list row not found" });
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Withdraw Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // CHECK-IN / ATTENDANCE (Migration 016)
  // Operators flip a Present / Late / Absent chip per diver.
  // Status is per-(event, competitor); the absence of a row means
  // "not yet checked in" so the operator can see who hasn't been
  // ticked off.
  // -------------------------------------------------------------
  router.get("/api/events/:id/attendance", requireMeetController, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT u.id AS competitor_id, u.full_name,
                o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                ea.status::text  AS status,
                ea.set_at,
                actor.full_name  AS set_by_name
         FROM (
           SELECT DISTINCT competitor_id
           FROM competitor_dive_lists WHERE event_id = $1
         ) entry
         JOIN users u           ON u.id = entry.competitor_id
         JOIN organisations o   ON o.id = u.org_id
         LEFT JOIN clubs cl     ON cl.id = u.club_id
         LEFT JOIN event_attendance ea
           ON ea.event_id = $1 AND ea.competitor_id = u.id
         LEFT JOIN users actor  ON actor.id = ea.set_by
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Attendance List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/events/:id/attendance/:competitorId", requireMeetController, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const { status } = req.body || {};
      const VALID = new Set(["present", "late", "absent"]);
      if (status != null && !VALID.has(status)) {
        return res.status(400).json({ error: "status must be present | late | absent | null" });
      }
      if (status == null) {
        await pool.query(
          `DELETE FROM event_attendance
           WHERE event_id = $1 AND competitor_id = $2`,
          [req.params.id, req.params.competitorId],
        );
        return res.json({ ok: true, status: null });
      }
      const r = await pool.query(
        `INSERT INTO event_attendance (event_id, competitor_id, status, set_by)
         VALUES ($1, $2, $3::attendance_status, $4)
         ON CONFLICT (event_id, competitor_id)
         DO UPDATE SET status = EXCLUDED.status,
                       set_at = now(),
                       set_by = EXCLUDED.set_by
         RETURNING status::text AS status, set_at`,
        [req.params.id, req.params.competitorId, status, req.user.id],
      );
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Attendance Set Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/roster — late-entry add. Used when a
  // diver shows up but didn't pre-submit a list. Single-row
  // version of the CSV import.
  // -------------------------------------------------------------
  router.post("/api/events/:id/roster", requireMeetEditor, async (req, res) => {
    const { competitor_id, dive_id, round_number, partner_id, team_id } = req.body || {};
    if (!competitor_id || !dive_id || !round_number) {
      return res.status(400).json({
        error: "competitor_id, dive_id, and round_number are required",
      });
    }
    try {
      const ev = await pool.query(
        "SELECT id, org_id FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const eventOrgId = ev.rows[0].org_id;

      const u = await pool.query(
        "SELECT id, org_id FROM users WHERE id = $1",
        [competitor_id],
      );
      if (!u.rows.length || u.rows[0].org_id !== eventOrgId) {
        return res.status(400).json({ error: "Competitor must belong to this organisation" });
      }

      const r = await pool.query(
        `INSERT INTO competitor_dive_lists
           (event_id, competitor_id, dive_id, round_number, partner_id, team_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, competitor_id, round_number)
         DO UPDATE SET dive_id = EXCLUDED.dive_id,
                       partner_id = EXCLUDED.partner_id,
                       team_id = EXCLUDED.team_id,
                       withdrawn_at = NULL
         RETURNING id`,
        [req.params.id, competitor_id, dive_id, round_number, partner_id || null, team_id || null],
      );
      res.status(201).json({ ok: true, dive_list_id: r.rows[0].id });
    } catch (err) {
      console.error("[Late Entry Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events/:id/roster/import — CSV bulk import.
  // Header: username,partner_username,round_1_code,round_1_pos,…
  // Per-row errors are returned without failing the whole import.
  // bulkWriteLimiter caps abuse — the parser itself caps input at
  // 200KB.
  // -------------------------------------------------------------
  router.post("/api/events/:id/roster/import",
    bulkWriteLimiter,
    requireMeetEditor,
    async (req, res) => {
      const { csv } = req.body || {};
      if (typeof csv !== "string" || !csv.trim()) {
        return res.status(400).json({ error: "csv body field is required" });
      }
      if (csv.length > 200_000) {
        return res.status(413).json({ error: "CSV is too large (max ~200KB / a few thousand rows)." });
      }
      const client = await pool.connect();
      try {
        const ev = await client.query(
          "SELECT id, org_id, height, total_rounds, event_type FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
          [req.params.id, !!req.user.is_system_admin, req.user.org_id],
        );
        if (!ev.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        const event = ev.rows[0];
        const heightNumeric = event.height ? parseFloat(event.height) : null;

        const rows = parseCsv(csv);
        if (!rows.length) {
          return res.status(400).json({ error: "CSV had no data rows" });
        }
        const header = rows.shift().map((h) => h.trim().toLowerCase());
        const userIdx     = header.indexOf("username");
        const partnerIdx  = header.indexOf("partner_username");
        if (userIdx < 0) {
          return res
            .status(400)
            .json({ error: 'CSV must include a "username" column' });
        }
        const roundCols = [];
        for (let n = 1; n <= 12; n++) {
          const ci = header.indexOf(`round_${n}_code`);
          const pi = header.indexOf(`round_${n}_pos`);
          if (ci >= 0 && pi >= 0) roundCols.push({ round: n, codeIdx: ci, posIdx: pi });
        }
        if (!roundCols.length) {
          return res
            .status(400)
            .json({ error: 'CSV must include at least one round_N_code + round_N_pos pair' });
        }

        const stats = { added: 0, skipped: 0, errors: [] };
        await client.query("BEGIN");

        for (const row of rows) {
          const username = (row[userIdx] || "").trim();
          if (!username) { stats.skipped++; continue; }
          try {
            const u = await client.query(
              "SELECT id FROM users WHERE username = $1 AND org_id = $2",
              [username, event.org_id],
            );
            if (!u.rows.length) {
              stats.errors.push({ username, error: "User not found in this org" });
              continue;
            }
            const competitorId = u.rows[0].id;

            let partnerId = null;
            if (partnerIdx >= 0) {
              const partnerName = (row[partnerIdx] || "").trim();
              if (partnerName) {
                const p = await client.query(
                  "SELECT id FROM users WHERE username = $1 AND org_id = $2",
                  [partnerName, event.org_id],
                );
                if (!p.rows.length) {
                  stats.errors.push({ username, error: `Partner ${partnerName} not found` });
                  continue;
                }
                partnerId = p.rows[0].id;
              }
            }

            for (const { round, codeIdx, posIdx } of roundCols) {
              const code = (row[codeIdx] || "").trim();
              const pos  = (row[posIdx]  || "").trim().toUpperCase();
              if (!code || !pos) continue;
              const d = await client.query(
                `SELECT id FROM dive_directory
                 WHERE dive_code = $1 AND position = $2::dive_position
                   AND ($3::numeric IS NULL OR height = $3::numeric)`,
                [code, pos, heightNumeric],
              );
              if (!d.rows.length) {
                stats.errors.push({
                  username,
                  error: `Round ${round}: ${code}${pos} not in directory${heightNumeric ? ` for ${event.height}` : ""}`,
                });
                continue;
              }
              await client.query(
                `INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (event_id, competitor_id, round_number)
                 DO UPDATE SET dive_id = EXCLUDED.dive_id, partner_id = EXCLUDED.partner_id`,
                [event.id, competitorId, partnerId, d.rows[0].id, round],
              );
            }
            stats.added++;
          } catch (rowErr) {
            stats.errors.push({ username, error: rowErr.message });
          }
        }

        await client.query("COMMIT");
        res.json(stats);
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Roster Import Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------
  // GET /api/events/:id/history — public dive-by-dive recap. Used
  // by the live scoreboard and the post-meet recap. No auth: the
  // data is already public via the scoreboard endpoint.
  // -------------------------------------------------------------
  router.get("/api/events/:id/history", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.full_name AS "diverName", o.country_code, cl.name AS club_name,
                pu.full_name AS partner_name,
                s.competitor_id, s.event_id, s.round_number,
                d.dive_code, d.position, d.dd, d.description,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score ORDER BY ej.judge_number),
                  e.number_of_judges, d.dd, e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
                ) AS total_points,
                /* Three parallel arrays — same ordering across all
                   three so consumers can zip them. ej.judge_number
                   (panel position 1..N) gives the canonical order;
                   s.judge_id (UUID) does not. */
                JSON_AGG(s.score        ORDER BY ej.judge_number) AS judge_scores,
                JSON_AGG(s.id           ORDER BY ej.judge_number) AS score_ids,
                JSON_AGG(ej.judge_number ORDER BY ej.judge_number) AS judge_numbers
         FROM scores s
         JOIN events e ON e.id = s.event_id
         JOIN users u ON s.competitor_id = u.id
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl
           ON s.competitor_id = cdl.competitor_id
          AND s.event_id = cdl.event_id
          AND s.round_number = cdl.round_number
         LEFT JOIN dive_directory d ON COALESCE(s.dive_id, cdl.dive_id) = d.id
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         WHERE s.event_id = $1
         GROUP BY u.full_name, o.country_code, cl.name, pu.full_name,
                  s.competitor_id, s.event_id, s.round_number,
                  d.dive_code, d.position, d.dd, d.description,
                  e.number_of_judges, e.event_type
         ORDER BY s.round_number ASC, u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[History Error]", err.message);
      res.status(500).json([]);
    }
  });

  return router;
};
