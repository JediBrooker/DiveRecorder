// Meet routes — a meet bundles multiple events. Public-readable
// (any spectator can browse meets) but write-restricted to
// org_admin / meet_manager.
//
//   GET    /api/orgs/:id/meets       list meets in an org (public)
//   GET    /api/meets/:id            public detail (meet + events)
//   POST   /api/meets                create
//   PUT    /api/meets/:id            update
//   DELETE /api/meets/:id            remove (events become standalone)
//   PUT    /api/events/:id/meet      assign / re-assign / detach
//
// Mounted via:
//   app.use(require('./routes/meets')({ … }))

const express = require("express");

module.exports = function createMeetsRouter({
  pool,
  requireMeetEditor,
  requireEventManager,
}) {
  if (!pool) throw new Error("createMeetsRouter requires { pool, … }");
  const router = express.Router();

  // List meets in an organisation. Public — used by the
  // Scoreboard list to group events by meet.
  router.get("/api/orgs/:id/meets", async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT m.*,
                COUNT(e.id)::int AS event_count,
                COUNT(e.id) FILTER (WHERE e.status = 'Live')::int      AS live_count,
                COUNT(e.id) FILTER (WHERE e.status = 'Completed')::int AS completed_count
         FROM meets m
         LEFT JOIN events e ON e.meet_id = m.id
         WHERE m.org_id = $1
         GROUP BY m.id
         ORDER BY COALESCE(m.start_date, m.created_at) DESC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[List Meets Error]", err.message);
      res.status(500).json([]);
    }
  });

  // Public meet detail — meet metadata + every event nested
  // inside, in a shape suitable for the public landing page.
  router.get("/api/meets/:id", async (req, res) => {
    try {
      const meetRes = await pool.query(
        `SELECT m.*, o.name AS org_name, o.country_code, o.id AS org_id
         FROM meets m
         JOIN organisations o ON o.id = m.org_id
         WHERE m.id = $1`,
        [req.params.id],
      );
      if (!meetRes.rows.length)
        return res.status(404).json({ error: "Meet not found" });
      const eventsRes = await pool.query(
        `SELECT e.id, e.name, e.gender, e.height, e.total_rounds,
                e.number_of_judges, e.event_type, e.status, e.created_at,
                COALESCE(stat.competitor_count, 0)::int AS competitor_count
         FROM events e
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT s.competitor_id) AS competitor_count
           FROM scores s WHERE s.event_id = e.id
         ) stat ON true
         WHERE e.meet_id = $1
         ORDER BY
           CASE e.status
             WHEN 'Live'      THEN 0
             WHEN 'Upcoming'  THEN 1
             WHEN 'Completed' THEN 2
           END,
           e.created_at ASC`,
        [req.params.id],
      );
      res.json({ meet: meetRes.rows[0], events: eventsRes.rows });
    } catch (err) {
      console.error("[Meet Detail Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/meets", requireMeetEditor, async (req, res) => {
    const {
      name, venue, start_date, end_date, description,
      sponsor_name, sponsor_logo_url, sponsor_link_url,
    } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Meet name is required" });
    }
    try {
      const r = await pool.query(
        `INSERT INTO meets
           (org_id, name, venue, start_date, end_date, description,
            sponsor_name, sponsor_logo_url, sponsor_link_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          req.user.org_id, name.trim(), venue || null,
          start_date || null, end_date || null, description || null,
          sponsor_name || null, sponsor_logo_url || null, sponsor_link_url || null,
        ],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Create Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/meets/:id", requireMeetEditor, async (req, res) => {
    const {
      name, venue, start_date, end_date, description,
      sponsor_name, sponsor_logo_url, sponsor_link_url,
    } = req.body || {};
    try {
      const r = await pool.query(
        `UPDATE meets SET
           name = COALESCE($1, name),
           venue = $2,
           start_date = $3,
           end_date = $4,
           description = $5,
           sponsor_name = $6,
           sponsor_logo_url = $7,
           sponsor_link_url = $8
         WHERE id = $9 AND org_id = $10
         RETURNING *`,
        [
          name?.trim() || null, venue || null,
          start_date || null, end_date || null, description || null,
          sponsor_name || null, sponsor_logo_url || null, sponsor_link_url || null,
          req.params.id, req.user.org_id,
        ],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Meet not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/meets/:id", requireMeetEditor, async (req, res) => {
    try {
      const r = await pool.query(
        "DELETE FROM meets WHERE id = $1 AND org_id = $2 RETURNING id",
        [req.params.id, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Meet not found" });
      // ON DELETE SET NULL on events.meet_id means the events
      // survive and become standalone — no separate cleanup
      // needed.
      res.json({ ok: true });
    } catch (err) {
      console.error("[Delete Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Assign / re-assign an event to a meet (or detach with
  // meet_id = null). Manager-only — both meet and event must
  // already exist in the same org.
  router.put("/api/events/:id/meet", requireEventManager(), async (req, res) => {
    const { meet_id } = req.body || {};
    try {
      // For non-sysadmin the meet must live in their own org.
      // sysadmin can move events between meets across any org.
      if (meet_id) {
        const m = await pool.query(
          "SELECT id, org_id FROM meets WHERE id = $1",
          [meet_id],
        );
        if (!m.rows.length) {
          return res.status(400).json({ error: "Meet not found" });
        }
        if (!req.user.is_system_admin && m.rows[0].org_id !== req.user.org_id) {
          return res
            .status(400)
            .json({ error: "Meet not found in this organisation" });
        }
      }
      const r = await pool.query(
        "UPDATE events SET meet_id = $1 WHERE id = $2 AND ($3::boolean OR org_id = $4) RETURNING *",
        [meet_id || null, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Event not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Assign Event Meet Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
