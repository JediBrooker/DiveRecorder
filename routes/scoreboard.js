// Scoreboard routes — public endpoints that drive the live
// broadcast layout and the round-by-round leaderboard.
//
// /api/scoreboard/:eventId            standings + history + up next
// /api/scoreboard/:eventId/leaderboard cumulative rank with movement
//
// Mounted via:
//     app.use(require('./routes/scoreboard')({ pool }))

const express = require("express");

module.exports = function createScoreboardRouter({ pool }) {
  const router = express.Router();

  router.get("/api/scoreboard/:eventId", async (req, res) => {
    try {
      const [st, hi, up] = await Promise.all([
        // Standings: per-dive points (trimmed × DD × scaling) summed
        // across all of a competitor's dives in the event.
        pool.query(
          `WITH per_dive AS (
             SELECT s.competitor_id, cdl.team_id, s.round_number,
                    calc_event_dive_points(
                      array_agg(ej.judge_number ORDER BY ej.judge_number),
                      array_agg(s.score ORDER BY ej.judge_number),
                      e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
    ) AS dive_points
             FROM scores s
             JOIN events e ON e.id = s.event_id
             LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
             LEFT JOIN competitor_dive_lists cdl
               ON cdl.event_id = s.event_id
              AND cdl.competitor_id = s.competitor_id
              AND cdl.round_number = s.round_number
             LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
             WHERE s.event_id = $1
             GROUP BY s.competitor_id, cdl.team_id, s.round_number, e.number_of_judges, e.event_type
           ),
           /* Team-event branch: aggregate by team. dives_desc is
              the descending-sorted array of dive points used as the
              FINA tie-break key when two teams share a raw total.
              public_id is a per-event sha256 of (event_id || team_id)
              truncated to 12 hex chars — a stable handle the Control
              Room can match against the active diver's roster row
              without exposing internal UUIDs to spectators. */
           team_standings AS (
             SELECT t.name AS full_name,
                    NULL::char(3) AS country_code,
                    t.short_code AS club_name,
                    NULL::varchar AS partner_name,
                    NULL::char(3) AS partner_country,
                    SUM(pd.dive_points) AS total,
                    array_agg(pd.dive_points ORDER BY pd.dive_points DESC) AS dives_desc,
                    substr(encode(digest('team:' || $1::text || ':' || t.id::text, 'sha256'), 'hex'), 1, 12) AS public_id
             FROM per_dive pd
             JOIN teams t ON t.id = pd.team_id
             WHERE (SELECT event_type FROM events WHERE id = $1) = 'team'
             GROUP BY t.id, t.name, t.short_code
           ),
           /* Individual / synchro branch: aggregate by competitor */
           comp_standings AS (
             SELECT u.full_name, o.country_code, cl.name AS club_name,
                    pu.full_name AS partner_name, pl.country_code AS partner_country,
                    SUM(pd.dive_points) AS total,
                    array_agg(pd.dive_points ORDER BY pd.dive_points DESC) AS dives_desc,
                    substr(encode(digest('comp:' || $1::text || ':' || u.id::text, 'sha256'), 'hex'), 1, 12) AS public_id
             FROM per_dive pd
             JOIN users u ON u.id = pd.competitor_id
             JOIN organisations o ON o.id = u.org_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
             LEFT JOIN LATERAL (
               SELECT DISTINCT cdl.partner_id
               FROM competitor_dive_lists cdl
               WHERE cdl.event_id = $1 AND cdl.competitor_id = pd.competitor_id
                 AND cdl.partner_id IS NOT NULL
               LIMIT 1
             ) p ON true
             LEFT JOIN users pu ON pu.id = p.partner_id
             LEFT JOIN organisations pl ON pl.id = pu.org_id
             WHERE (SELECT event_type FROM events WHERE id = $1) <> 'team'
             GROUP BY u.id, u.full_name, o.country_code, cl.name, pu.full_name, pl.country_code
           ),
           merged AS (
             SELECT * FROM team_standings
             UNION ALL
             SELECT * FROM comp_standings
           )
           /* FINA tie-break ordering: total desc, then highest dive,
              then second-highest, etc. (Postgres element-wise array
              comparison gives that.) is_tied_on_total flags pairs
              that shared the raw total but were separated by the
              tie-break, so the UI can hint at why. */
           SELECT full_name, country_code, club_name,
                  partner_name, partner_country, total, public_id,
                  COUNT(*) OVER (PARTITION BY total) > 1 AS is_tied_on_total
           FROM merged
           ORDER BY total DESC, dives_desc DESC`,
          [req.params.eventId],
        ),
        // History: each row is a fully-judged dive with its
        // official dive points.
        pool.query(
          `SELECT s.competitor_id, u.full_name, o.country_code, cl.name AS club_name,
                  pu.full_name AS partner_name, pl.country_code AS partner_country,
                  t.id AS team_id, t.name AS team_name,
                  d.dive_code, d.position, d.description, d.dd, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score ORDER BY ej.judge_number),
                    e.number_of_judges, d.dd, e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
    ) AS total_dive_score,
                  STRING_AGG(s.score::text, ',' ORDER BY s.judge_id) AS judge_array
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
           LEFT JOIN organisations pl ON pl.id = pu.org_id
           LEFT JOIN teams t ON t.id = cdl.team_id
           WHERE s.event_id = $1
           GROUP BY s.competitor_id, u.full_name, o.country_code, cl.name,
                    pu.full_name, pl.country_code, t.id, t.name,
                    d.dive_code, d.position, d.description, d.dd,
                    s.round_number, e.number_of_judges, e.event_type
           ORDER BY MAX(s.created_at) DESC LIMIT 10`,
          [req.params.eventId],
        ),
        // Up Next: dive list rows that haven't been scored yet,
        // earliest round first. The scoreboard surfaces the first
        // few of these so the audience knows who's coming up.
        pool.query(
          `SELECT cdl.round_number, u.full_name, o.country_code,
                  cl.name AS club_name,
                  pu.full_name AS partner_name, pl.country_code AS partner_country,
                  t.name AS team_name,
                  d.dive_code, d.position, d.dd
           FROM competitor_dive_lists cdl
           JOIN users u ON u.id = cdl.competitor_id
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           LEFT JOIN users pu ON pu.id = cdl.partner_id
           LEFT JOIN organisations pl ON pl.id = pu.org_id
           LEFT JOIN teams t ON t.id = cdl.team_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.event_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM scores s
               WHERE s.event_id = cdl.event_id
                 AND s.competitor_id = cdl.competitor_id
                 AND s.round_number = cdl.round_number
             )
           ORDER BY cdl.round_number, u.full_name
           LIMIT 5`,
          [req.params.eventId],
        ),
      ]);
      res.json({ standings: st.rows, history: hi.rows, upcoming: up.rows });
    } catch (err) {
      console.error("[Scoreboard Error]", err.message);
      res.status(500).json({ standings: [], history: [], upcoming: [] });
    }
  });

  // Per-round leaderboard. Returns rankings for each round with
  // cumulative totals and the movement (change in rank) since the
  // previous round. Used by the scoreboard to render ↑/↓ arrows
  // next to the standings.
  router.get("/api/scoreboard/:eventId/leaderboard", async (req, res) => {
    try {
      const r = await pool.query(
        `WITH dive_totals AS (
           SELECT s.competitor_id, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
  ) AS round_total
           FROM scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE s.event_id = $1
           GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         ),
         cumulative AS (
           SELECT competitor_id, round_number, round_total,
                  SUM(round_total) OVER (
                    PARTITION BY competitor_id
                    ORDER BY round_number
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  ) AS cumulative_total
           FROM dive_totals
         ),
         ranked AS (
           SELECT *,
                  RANK() OVER (PARTITION BY round_number ORDER BY cumulative_total DESC) AS rnk
           FROM cumulative
         ),
         with_prev AS (
           SELECT r.*,
                  LAG(r.rnk) OVER (PARTITION BY r.competitor_id ORDER BY r.round_number) AS prev_rnk
           FROM ranked r
         )
         SELECT wp.competitor_id, u.full_name, o.country_code, cl.name AS club_name,
                wp.round_number,
                wp.round_total,
                wp.cumulative_total,
                wp.rnk         AS rank,
                wp.prev_rnk    AS prev_rank,
                CASE WHEN wp.prev_rnk IS NULL THEN NULL
                     ELSE (wp.prev_rnk - wp.rnk) END AS movement
         FROM with_prev wp
         JOIN users u ON u.id = wp.competitor_id
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         ORDER BY wp.round_number ASC, wp.rnk ASC`,
        [req.params.eventId],
      );

      const byRound = {};
      for (const row of r.rows) {
        const rn = row.round_number;
        if (!byRound[rn]) byRound[rn] = [];
        byRound[rn].push({
          competitor_id: row.competitor_id,
          full_name: row.full_name,
          country_code: row.country_code,
          club_name: row.club_name,
          round_total: Number(row.round_total),
          cumulative_total: Number(row.cumulative_total),
          rank: Number(row.rank),
          prev_rank: row.prev_rank == null ? null : Number(row.prev_rank),
          movement: row.movement == null ? null : Number(row.movement),
        });
      }
      const rounds = Object.keys(byRound)
        .map(Number)
        .sort((a, b) => a - b)
        .map((n) => ({ round_number: n, rankings: byRound[n] }));

      res.json({ rounds });
    } catch (err) {
      console.error("[Leaderboard Error]", err.message);
      res.status(500).json({ rounds: [] });
    }
  });

  return router;
};
