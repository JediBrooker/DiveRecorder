// Coach routes — a coach picks up divers via coach_diver_links
// (created by an org admin in the User Manager). These endpoints
// power the coach's dashboard.
//
//   GET    /api/coach/dashboard            per-diver next-dive + rank
//   GET    /api/coach/divers               linked-divers tile list
//   GET    /api/orgs/:id/coach-links       admin link admin view
//   POST   /api/orgs/:id/coach-links       grant link
//   DELETE /api/coach-links/:id            revoke link
//
// Mounted via:
//   app.use(require('./routes/coach')({ … }))

const express = require("express");

module.exports = function createCoachRouter({
  pool,
  verifyToken,
  requireOrgAdmin,
}) {
  if (!pool) throw new Error("createCoachRouter requires { pool, … }");
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/coach/dashboard — for every linked diver, return the
  // next dive they have in any Live event (round, dive code, DD)
  // plus their current rank in that event's standings, plus a
  // summary of their last dive's total. Powers the dedicated
  // /coach view; reuses coach_diver_links + per_dive aggregates.
  //
  // Schema-wise nothing new — this is just a join across the
  // existing pieces. Heavy enough that we don't want it in the
  // page-load critical path of the regular dashboard.
  // -------------------------------------------------------------
  router.get("/api/coach/dashboard", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `WITH my_divers AS (
           SELECT u.id, u.full_name, u.username,
                  o.country_code,
                  cl.name AS club_name, cl.short_code AS club_code,
                  link.note, link.created_at AS linked_at
           FROM coach_diver_links link
           JOIN users u           ON u.id = link.diver_id
           JOIN organisations o   ON o.id = u.org_id
           LEFT JOIN clubs cl     ON cl.id = u.club_id
           WHERE link.coach_id = $1
         ),
         /* Every dive the linked divers have on a non-completed
            event, with the event's status so we can filter live
            ones. */
         upcoming_raw AS (
           /* LEFT JOIN dive_directory — a dive_list row with a
              NULL or stale dive_id (diver hasn't filed their full
              list yet) shouldn't drop the diver entirely from the
              coach's dashboard. */
           SELECT cdl.competitor_id, cdl.event_id, cdl.round_number,
                  cdl.display_order,
                  e.name AS event_name, e.status, e.event_type,
                  e.height, e.number_of_judges,
                  d.dive_code, d.position, d.dd, d.description
           FROM competitor_dive_lists cdl
           JOIN events e ON e.id = cdl.event_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.competitor_id IN (SELECT id FROM my_divers)
             AND cdl.withdrawn_at IS NULL
             AND e.status IN ('Live', 'Upcoming')
         ),
         /* Pick the diver's next round in each event — the lowest
            round_number that doesn't yet have all judges' scores. */
         scored_rounds AS (
           SELECT s.event_id, s.competitor_id, s.round_number,
                  COUNT(*) AS judges_in
           FROM scores s
           WHERE s.competitor_id IN (SELECT id FROM my_divers)
           GROUP BY s.event_id, s.competitor_id, s.round_number
         ),
         upcoming_with_status AS (
           SELECT ur.*,
                  COALESCE(sr.judges_in, 0) AS judges_in,
                  ur.number_of_judges - COALESCE(sr.judges_in, 0) AS judges_pending
           FROM upcoming_raw ur
           LEFT JOIN scored_rounds sr
             ON sr.event_id      = ur.event_id
            AND sr.competitor_id = ur.competitor_id
            AND sr.round_number  = ur.round_number
         ),
         next_dive AS (
           SELECT DISTINCT ON (competitor_id, event_id)
                  competitor_id, event_id, round_number,
                  event_name, status, event_type, height,
                  dive_code, position, dd, description,
                  judges_pending
           FROM upcoming_with_status
           WHERE judges_pending > 0
           ORDER BY competitor_id, event_id, round_number ASC
         ),
         /* Standings per event so we can attach a current rank. */
         per_dive AS (
           SELECT s.event_id, s.competitor_id,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS pts
           FROM scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE s.event_id IN (SELECT event_id FROM upcoming_raw)
           GROUP BY s.event_id, s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         ),
         totals AS (
           SELECT event_id, competitor_id, SUM(pts)::numeric(8,2) AS total
           FROM per_dive GROUP BY event_id, competitor_id
         ),
         ranked AS (
           SELECT *, RANK() OVER (PARTITION BY event_id ORDER BY total DESC) AS rnk,
                  COUNT(*) OVER (PARTITION BY event_id)::int AS field_size
           FROM totals
         )
         SELECT md.id AS diver_id, md.full_name, md.username,
                md.country_code, md.club_name, md.club_code,
                md.note,
                nd.event_id, nd.event_name, nd.status AS event_status,
                nd.event_type, nd.height,
                nd.round_number, nd.dive_code, nd.position, nd.dd, nd.description,
                r.total::numeric(8,2)   AS current_total,
                r.rnk::int              AS current_rank,
                r.field_size
         FROM my_divers md
         LEFT JOIN next_dive nd ON nd.competitor_id = md.id
         LEFT JOIN ranked r
           ON r.event_id = nd.event_id AND r.competitor_id = md.id
         ORDER BY
           /* Live events first, then upcoming, then divers with no
              upcoming dive at all */
           CASE WHEN nd.status = 'Live' THEN 0
                WHEN nd.status = 'Upcoming' THEN 1
                ELSE 2 END,
           md.full_name ASC`,
        [req.user.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Coach Dashboard Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // GET /api/coach/divers — coaches see their own linked divers,
  // minimal fields, enough to build a dashboard tile + click
  // through to each diver's profile (which already exists at
  // /profile/:id).
  // -------------------------------------------------------------
  router.get("/api/coach/divers", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name, u.username,
                cl.name AS club_name, cl.short_code AS club_code,
                o.country_code,
                link.created_at AS linked_at,
                link.note
         FROM coach_diver_links link
         JOIN users u ON u.id = link.diver_id
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE link.coach_id = $1
         ORDER BY u.full_name ASC`,
        [req.user.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Coach Divers Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // Coach-link administration (org admins)
  // -------------------------------------------------------------
  router.get("/api/orgs/:id/coach-links", requireOrgAdmin, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot read coach links in other organisations" });
    }
    try {
      const r = await pool.query(
        `SELECT link.id, link.coach_id, link.diver_id, link.created_at, link.note,
                c.full_name AS coach_name, d.full_name AS diver_name
         FROM coach_diver_links link
         JOIN users c ON c.id = link.coach_id
         JOIN users d ON d.id = link.diver_id
         WHERE link.org_id = $1
         ORDER BY c.full_name, d.full_name`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Coach Links List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.post("/api/orgs/:id/coach-links", requireOrgAdmin, async (req, res) => {
    const { coach_id, diver_id, note } = req.body || {};
    if (!coach_id || !diver_id) {
      return res.status(400).json({ error: "coach_id and diver_id are required" });
    }
    if (coach_id === diver_id) {
      return res.status(400).json({ error: "Coach and diver must be different users" });
    }
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot link users in other organisations" });
    }
    try {
      // Sanity check: both users belong to the target org.
      const usersRes = await pool.query(
        `SELECT id, org_id FROM users WHERE id = ANY($1)`,
        [[coach_id, diver_id]],
      );
      if (usersRes.rows.length !== 2) {
        return res.status(400).json({ error: "Coach or diver not found" });
      }
      for (const u of usersRes.rows) {
        if (u.org_id !== req.params.id) {
          return res
            .status(400)
            .json({ error: "Both users must belong to the target organisation" });
        }
      }
      const r = await pool.query(
        `INSERT INTO coach_diver_links (coach_id, diver_id, org_id, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (coach_id, diver_id) DO UPDATE SET note = EXCLUDED.note
         RETURNING id, coach_id, diver_id, note, created_at`,
        [coach_id, diver_id, req.params.id, note || null],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Coach Link Create Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/coach-links/:id", requireOrgAdmin, async (req, res) => {
    try {
      const r = await pool.query(
        "DELETE FROM coach_diver_links WHERE id = $1 AND org_id = $2 RETURNING id",
        [req.params.id, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Link not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Coach Link Delete Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
