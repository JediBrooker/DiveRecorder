// Shared SQL CTE templates for diver analytics.
//
// The analytics endpoint runs ~10 small rollups, several of which
// share the same "compute per-dive points" or "rank against the
// full field" shape. Keeping the CTEs in one place means a fix to
// the calculation logic (e.g. a synchro edge case) lands in every
// query at once instead of needing four parallel edits.
//
// IMPORTANT: each helper documents which $N parameters it expects
// from the caller. The caller is responsible for binding those
// params in the right order. The helpers don't choose param
// numbers themselves because pg-style positional parameters mean
// outer queries that compose multiple CTEs need to control the
// numbering. See server.js' /api/divers/:id/analytics for usage.

// =====================================================================
// PER_DIVE — one row per dive the diver performed.
//
// Filters to a single competitor and (optionally) a date range.
// Columns:
//   event_id, competitor_id, round_number,
//   dive_code, position, height, dd, description,
//   event_type::text AS event_type, created_at,
//   dive_total, avg_judge_score
//
// Required params:
//   $1 = competitor_id (uuid)
//   $2 = from_date (date or null)
//   $3 = to_date   (date or null)
// =====================================================================
const PER_DIVE = `
  SELECT s.event_id, s.competitor_id, s.round_number,
         d.dive_code, d.position, d.height, d.dd, d.description,
         e.event_type::text AS event_type, e.created_at,
         calc_event_dive_points(
           array_agg(ej.judge_number ORDER BY ej.judge_number),
           array_agg(s.score        ORDER BY ej.judge_number),
           e.number_of_judges, MAX(d.dd), e.event_type,
           BOOL_OR(cdl.partner_id IS NOT NULL)
         ) AS dive_total,
         AVG(s.score) AS avg_judge_score
  FROM scores s
  JOIN events e ON e.id = s.event_id
  LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
  LEFT JOIN competitor_dive_lists cdl
    ON cdl.event_id = s.event_id
   AND cdl.competitor_id = s.competitor_id
   AND cdl.round_number = s.round_number
  LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
  WHERE s.competitor_id = $1
    AND ($2::date IS NULL OR e.created_at >= $2::date)
    AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')
  GROUP BY s.event_id, s.competitor_id, s.round_number,
           d.dive_code, d.position, d.height, d.dd, d.description,
           e.number_of_judges, e.event_type, e.created_at
`;

// =====================================================================
// FULL_FIELD_RANKING — for queries that need the diver's RANK against
// every competitor in their events (recent_form, placings, streak,
// year_over_year). Returns a chain of CTEs you splice into a parent
// WITH clause:
//
//   WITH ${FULL_FIELD_RANKING}
//   SELECT … FROM my_events WHERE …
//
// CTE chain:
//   diver_events  — { event_id }   the events the diver competed in
//   all_per_dive  — every dive in those events, by every competitor
//   event_totals  — per-(event, competitor) sum of dive points + a
//                   `dives_desc` array of the diver's dive points
//                   sorted descending (used as the tie-break key)
//   ranked        — event_totals + RANK over the FINA ordering:
//                     ORDER BY total DESC, dives_desc DESC
//                   plus an `is_tied_on_total` flag for UI hints
//                   when two divers share a raw total but the
//                   secondary criterion separates them.
//
// Required params:
//   $1 = competitor_id (uuid) — the diver of interest
//   $2 = from_date (date or null)
//   $3 = to_date   (date or null)
//
// FINA tie-break: when two divers have the same total, the higher
// finish goes to whoever has the highest single dive; if those tie,
// the second-highest; and so on. Postgres element-wise array
// comparison on `dives_desc DESC` implements that exactly —
// [9,8,7] > [9,8,6] > [9,8,5]. RANK() with that ordering gives the
// correct FINA placement for free.
// =====================================================================
const FULL_FIELD_RANKING = `
  diver_events AS (
    SELECT DISTINCT s.event_id
    FROM scores s
    JOIN events e ON e.id = s.event_id
    WHERE s.competitor_id = $1
      AND ($2::date IS NULL OR e.created_at >= $2::date)
      AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')
  ),
  all_per_dive AS (
    SELECT s.event_id, s.competitor_id, s.round_number,
           calc_event_dive_points(
             array_agg(ej.judge_number ORDER BY ej.judge_number),
             array_agg(s.score        ORDER BY ej.judge_number),
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
    WHERE s.event_id IN (SELECT event_id FROM diver_events)
    GROUP BY s.event_id, s.competitor_id, s.round_number,
             e.number_of_judges, e.event_type
  ),
  event_totals AS (
    SELECT event_id, competitor_id,
           SUM(dive_points) AS total,
           array_agg(dive_points ORDER BY dive_points DESC) AS dives_desc
    FROM all_per_dive
    GROUP BY event_id, competitor_id
  ),
  ranked AS (
    SELECT et.*,
           RANK() OVER (
             PARTITION BY et.event_id
             ORDER BY et.total DESC, et.dives_desc DESC
           ) AS rank,
           /* True when 2+ rows in this event share the SAME total
              — UI shows an "=" marker so spectators understand why
              two divers with identical totals were separated. */
           COUNT(*) OVER (
             PARTITION BY et.event_id, et.total
           ) > 1 AS is_tied_on_total,
           /* field_size precomputed here (not in the outer SELECT)
              because outer queries filter to the diver via
              WHERE competitor_id = $1; window functions run AFTER
              WHERE so a window in the outer query would see only
              the one row and return 1. Computing it inside the
              CTE lets recent_form and friends just select it. */
           COUNT(*) OVER (PARTITION BY et.event_id)::int AS field_size
    FROM event_totals et
  )
`;

module.exports = { PER_DIVE, FULL_FIELD_RANKING };
