// Event-staff routes — managers (people who can drive an event)
// and judges (panel members) for a specific event, plus the
// per-judge "what events am I on?" lookup.
//
//   GET    /api/events/:id/managers             list event managers
//   POST   /api/events/:id/managers             add manager
//   DELETE /api/events/:id/managers/:userId     remove manager
//   GET    /api/events/:eventId/judges          panel for this event
//   POST   /api/events/:id/judges               replace panel (ordered)
//   GET    /api/events/:eventId/my-judge-number this judge's panel position
//   GET    /api/judge/my-events                 events this judge sits on
//
// Mounted via:
//   app.use(require('./routes/event-staff')({ … }))

const express = require("express");

module.exports = function createEventStaffRouter({
  pool,
  requireOrgRole,
  requireMeetEditor,
  requireEventManager,
  ensureEventOrgGate,
  isInSameOrg,
}) {
  if (!pool) throw new Error("createEventStaffRouter requires { pool, … }");
  const router = express.Router();

  // -------- Event managers --------
  router.get("/api/events/:id/managers", requireMeetEditor, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT u.id, u.full_name, u.username, em.added_at
         FROM event_managers em JOIN users u ON em.user_id = u.id
         WHERE em.event_id = $1`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/events/:id/managers", requireEventManager(), async (req, res) => {
    const { user_id } = req.body || {};
    try {
      // The user being added must be in the same org as the event.
      // Prevents a meet manager from elevating a foreign-org user
      // into a managerial role on this event.
      if (!(await isInSameOrg(pool, req.event.org_id, user_id, "users"))) {
        return res.status(400).json({ error: "User is not in this event's organisation" });
      }
      await pool.query(
        "INSERT INTO event_managers (event_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [req.params.id, user_id, req.user.id],
      );
      res.json({ message: "Manager added" });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/events/:id/managers/:userId", requireEventManager(), async (req, res) => {
    try {
      await pool.query(
        "DELETE FROM event_managers WHERE event_id=$1 AND user_id=$2",
        [req.params.id, req.params.userId],
      );
      res.json({ message: "Manager removed" });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------- Judge panel --------
  // Tuple repeated 1× here, but stays explicit since we don't use
  // it elsewhere in this file.
  const requireMeetController = requireOrgRole(["org_admin", "meet_manager", "referee"]);

  router.get("/api/events/:eventId/judges", requireMeetController, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "eventId"))) return;
      // Joined to users so the Control Room can label each judge
      // tile with the actual person's name (helps the meet
      // referee chase a slow submitter without checking the
      // org panel separately).
      const r = await pool.query(
        `SELECT ej.judge_id, ej.judge_number, u.full_name
         FROM event_judges ej
         JOIN users u ON u.id = ej.judge_id
         WHERE ej.event_id = $1
         ORDER BY ej.judge_number ASC`,
        [req.params.eventId],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Replace the entire panel for an event. Body: { judgeIds: [<uuid>, …] }
  // The position of each judge in the array becomes their 1-based
  // judge_number. Atomic — partial replacements would leave the
  // panel in an unknown shape.
  router.post("/api/events/:id/judges", requireEventManager(), async (req, res) => {
    const { judgeIds } = req.body || {};
    if (!Array.isArray(judgeIds)) {
      return res.status(400).json({ error: "judgeIds must be an array" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Every judge must belong to the event's org. One foreign judge
      // means we reject the whole assignment — easier to surface the
      // error than to silently drop part of the panel.
      for (const jid of judgeIds) {
        if (!(await isInSameOrg(client, req.event.org_id, jid, "users"))) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "All judges must belong to the event's organisation" });
        }
      }
      await client.query("DELETE FROM event_judges WHERE event_id = $1", [
        req.params.id,
      ]);
      for (let i = 0; i < judgeIds.length; i++) {
        await client.query(
          "INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1,$2,$3)",
          [req.params.id, judgeIds[i], i + 1], // 1-based judge number
        );
      }
      await client.query("COMMIT");
      res.json({ message: "Judges assigned" });
    } catch (err) {
      await client.query("ROLLBACK");
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------- Per-judge views --------
  // Returns this judge's assigned number for a specific event.
  router.get("/api/events/:eventId/my-judge-number", requireOrgRole(["judge"]), async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT judge_number FROM event_judges WHERE event_id = $1 AND judge_id = $2",
        [req.params.eventId, req.user.id],
      );
      if (!r.rows.length)
        return res.status(404).json({ error: "Not assigned to this event" });
      res.json({ judge_number: r.rows[0].judge_number });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.get("/api/judge/my-events", requireOrgRole(["judge"]), async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT e.id, e.name, e.number_of_judges, e.total_rounds, e.status
         FROM events e JOIN event_judges ej ON e.id = ej.event_id
         WHERE ej.judge_id = $1 ORDER BY e.created_at DESC`,
        [req.user.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
