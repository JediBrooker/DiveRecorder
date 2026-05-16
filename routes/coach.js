// Coach routes — a coach picks up divers via coach_diver_links
// (created by an org admin in the User Manager). These endpoints
// power the coach's dashboard.
//
//   GET    /api/coach/dashboard            per-diver next-dive + rank + last-dive
//   GET    /api/coach/up-next              squad members in Live events,
//                                          sorted by "dives until you're up"
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
            ones. Also carries meet_id + meet_name so the frontend
            can group cards by meet (a coach at a multi-meet
            weekend gets one section per meet rather than one big
            mixed grid). */
         upcoming_raw AS (
           /* LEFT JOIN dive_directory — a dive_list row with a
              NULL or stale dive_id (diver hasn't filed their full
              list yet) shouldn't drop the diver entirely from the
              coach's dashboard. */
           SELECT cdl.competitor_id, cdl.event_id, cdl.round_number,
                  cdl.display_order,
                  e.name AS event_name, e.status, e.event_type,
                  e.height, e.number_of_judges,
                  e.meet_id,
                  m.name AS meet_name,
                  d.dive_code, d.position, d.dd, d.description
           FROM competitor_dive_lists cdl
           JOIN events e ON e.id = cdl.event_id
           LEFT JOIN meets m ON m.id = e.meet_id
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
                  meet_id, meet_name,
                  dive_code, position, dd, description,
                  display_order, judges_pending
           FROM upcoming_with_status
           WHERE judges_pending > 0
           ORDER BY competitor_id, event_id, round_number ASC
         ),
         /* Last completed dive — the most recent round where
            every judge has scored. We want this on the card so
            the coach can see "Tom just landed 78.40 on his 109C
            in round 3" without clicking through. Computed as
            the highest round_number for which judges_in equals
            number_of_judges, then joined back to the upcoming_raw
            row for that same competitor/event/round (carrying
            the dive_code + dd + description) plus the actual
            dive total from per_dive (computed below in the main
            chain). */
         last_completed_round AS (
           SELECT DISTINCT ON (competitor_id, event_id)
                  competitor_id, event_id, round_number,
                  dive_code, position, dd, description
           FROM upcoming_with_status
           WHERE judges_pending = 0
           ORDER BY competitor_id, event_id, round_number DESC
         ),
         /* Standings per event so we can attach a current rank.
            We carry round_number through so we can also surface
            the per-round dive total for the "last completed dive"
            display below. */
         per_dive AS (
           SELECT s.event_id, s.competitor_id, s.round_number,
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
                nd.meet_id, nd.meet_name,
                nd.round_number, nd.dive_code, nd.position, nd.dd, nd.description,
                nd.display_order,
                r.total::numeric(8,2)   AS current_total,
                r.rnk::int              AS current_rank,
                r.field_size,
                /* Most-recent completed dive — surfaced as
                   "Last: R3 109C → 78.40" on the card so the coach
                   sees what just landed without clicking through.
                   NULL when the diver hasn't competed yet. */
                lcr.round_number AS last_dive_round,
                lcr.dive_code    AS last_dive_code,
                lcr.position     AS last_dive_position,
                lcr.dd           AS last_dive_dd,
                lcr.description  AS last_dive_description,
                lpd.pts::numeric(8,2) AS last_dive_points
         FROM my_divers md
         LEFT JOIN next_dive nd ON nd.competitor_id = md.id
         LEFT JOIN ranked r
           ON r.event_id = nd.event_id AND r.competitor_id = md.id
         LEFT JOIN last_completed_round lcr
           ON lcr.event_id = nd.event_id AND lcr.competitor_id = md.id
         LEFT JOIN per_dive lpd
           ON lpd.event_id      = lcr.event_id
          AND lpd.competitor_id = lcr.competitor_id
          AND lpd.round_number  = lcr.round_number
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
  // GET /api/coach/up-next — the killer "your divers in the next
  // ~5 minutes" strip on the coach console. For every Live event
  // that has a current active diver (from event_live_state), find
  // every squad member whose display_order is AHEAD of the active
  // diver in the same round (or in a later round); compute "dives
  // until they're up" by walking through the dive_order; multiply
  // by the configurable seconds-per-dive to get an ETA. Results
  // sorted ETA ascending so the coach's eye lands on whoever's up
  // soonest first.
  //
  // Synchro-aware: in a synchro event each "dive slot" is one
  // pair, not two divers, so we DISTINCT-count pairs not bodies.
  //
  // Query string:
  //   seconds_per_dive  (optional, default 45, clamp 15..120)
  //   max_eta_minutes   (optional, default 20, clamp 1..60)
  // -------------------------------------------------------------
  router.get("/api/coach/up-next", verifyToken, async (req, res) => {
    const secondsPerDive = Math.max(
      15,
      Math.min(120, parseInt(req.query.seconds_per_dive, 10) || 45),
    );
    const maxEtaMinutes = Math.max(
      1,
      Math.min(60, parseInt(req.query.max_eta_minutes, 10) || 20),
    );
    const maxEtaSeconds = maxEtaMinutes * 60;
    try {
      const r = await pool.query(
        `WITH my_divers AS (
           SELECT u.id, u.full_name,
                  o.country_code,
                  cl.name AS club_name, cl.short_code AS club_code
           FROM coach_diver_links link
           JOIN users u           ON u.id = link.diver_id
           JOIN organisations o   ON o.id = u.org_id
           LEFT JOIN clubs cl     ON cl.id = u.club_id
           WHERE link.coach_id = $1
         ),
         /* Live events with a current active diver. The active
            payload carries the competitor_id + round_number, so
            we can look up the active diver's display_order in
            this event's dive list and walk forward from there. */
         live_active AS (
           SELECT els.event_id,
                  e.name        AS event_name,
                  e.event_type,
                  e.meet_id,
                  m.name        AS meet_name,
                  (els.active_diver_payload->>'competitor_id')::uuid AS active_competitor_id,
                  (els.active_diver_payload->>'round_number')::int   AS active_round
           FROM event_live_state els
           JOIN events e ON e.id = els.event_id
           LEFT JOIN meets m ON m.id = e.meet_id
           WHERE e.status = 'Live'
             AND els.active_diver_payload IS NOT NULL
             AND els.on_hold_reason IS NULL
         ),
         /* The active diver's display_order in their round. The
            squad members AHEAD of this number are "still to come"
            this round; everybody else is in later rounds (we add
            (total_in_round - active_order) + diver_order to get
            their position in the round-ordered queue). */
         active_position AS (
           SELECT la.*,
                  cdl.display_order AS active_display_order,
                  /* Total competitors in this round of this event.
                     Synchro pairs each have one dive_list row per
                     pair (the synchro lift in 042 collapses pairs
                     into one display_order slot), so this is
                     "slots per round" not "bodies per round". */
                  (SELECT COUNT(*) FROM competitor_dive_lists cdl2
                    WHERE cdl2.event_id = la.event_id
                      AND cdl2.round_number = la.active_round
                      AND cdl2.withdrawn_at IS NULL
                  ) AS slots_in_round
           FROM live_active la
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = la.event_id
            AND cdl.competitor_id = la.active_competitor_id
            AND cdl.round_number = la.active_round
         ),
         /* Every squad-member dive slot in a Live event that has
            an active diver. Walk to "dives until you're up": if
            same round and ahead by N → N dives; if later round →
            slots_remaining_in_current + slots_in_earlier_rounds +
            their_order_in_that_round. */
         squad_slots AS (
           SELECT cdl.competitor_id, cdl.event_id, cdl.round_number,
                  cdl.display_order,
                  ap.event_name, ap.event_type, ap.meet_id, ap.meet_name,
                  ap.active_round, ap.active_display_order, ap.slots_in_round,
                  md.full_name, md.country_code, md.club_name, md.club_code,
                  d.dive_code, d.position, d.dd, d.description
           FROM competitor_dive_lists cdl
           JOIN my_divers md ON md.id = cdl.competitor_id
           JOIN active_position ap ON ap.event_id = cdl.event_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.withdrawn_at IS NULL
             /* This round, AHEAD of active diver. Or any later round. */
             AND (
                  (cdl.round_number = ap.active_round
                   AND cdl.display_order > ap.active_display_order)
               OR cdl.round_number > ap.active_round
             )
         ),
         with_eta AS (
           SELECT *,
                  CASE
                    WHEN round_number = active_round
                      THEN display_order - active_display_order
                    ELSE
                      /* Dives left in the active round +
                         (round_number - active_round - 1) full rounds +
                         this slot's position in its round. */
                      (slots_in_round - active_display_order)
                      + (round_number - active_round - 1) * slots_in_round
                      + display_order
                  END AS dives_until
           FROM squad_slots
         )
         SELECT competitor_id AS diver_id, full_name, country_code,
                club_name, club_code,
                event_id, event_name, event_type, meet_id, meet_name,
                round_number, dive_code, position, dd, description,
                dives_until,
                (dives_until * $2)::int AS eta_seconds
         FROM with_eta
         WHERE dives_until > 0
           AND dives_until * $2 <= $3
         /* For a single diver across multiple Live events: keep
            both rows; the coach probably WANTS to see them in both
            strips. Just sort by ETA so the closest one shows first. */
         ORDER BY eta_seconds ASC, full_name ASC`,
        [req.user.id, secondsPerDive, maxEtaSeconds],
      );
      res.json({
        seconds_per_dive: secondsPerDive,
        max_eta_minutes: maxEtaMinutes,
        rows: r.rows,
      });
    } catch (err) {
      console.error("[Coach Up Next Error]", err.message);
      res.status(500).json({ seconds_per_dive: secondsPerDive, max_eta_minutes: maxEtaMinutes, rows: [] });
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
