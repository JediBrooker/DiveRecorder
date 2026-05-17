// Session-scheduler conflict detection — Phase 2.
//
// docs/session-scheduler.md §5 defines the algorithm:
//
//   A conflict is two blocks that overlap in time AND share a
//   resource. The resource types in v1 are judge / board / diver /
//   referee. Hard everywhere except for "same judge in blocks ≤ 15
//   min apart but not overlapping" which is soft.
//
// This module is a single function — `detectConflicts(meetId,
// pgClient)` — that returns an array of `Conflict` rows. The whole
// thing is one (largeish) SQL query: at meet-day cardinality the
// planner handles a self-join on a few hundred schedule_blocks +
// the per-resource joins without help, and keeping the work in one
// query keeps the round-trip cost flat as the timeline grows.
//
// We deliberately don't paginate / cap the result here — the
// timeline drawer wants the full list to bucket by severity, and a
// real meet day tops out somewhere around a dozen active warnings
// even after a chaotic morning. The route-level cache (see
// routes/sessions.js) absorbs repeated calls within a few seconds.
//
// CONFLICT SHAPE
// --------------
// {
//   block_a:        { id, label, starts_at, ends_at, session_id },
//   block_b:        { id, label, starts_at, ends_at, session_id },
//   resource_kind:  'judge' | 'board' | 'diver' | 'referee',
//   resource_ids:   string[],     // uuids (judge / diver / referee user_ids; board uuids)
//   resource_labels:string[],     // parallel to resource_ids, human names
//   severity:       'hard' | 'soft',
//   fingerprint:    sha256 of sorted resource_ids
//   dismissed:      boolean       // true when a dismissed_conflicts
//                                 // row exists AND its fingerprint
//                                 // still matches.
// }
//
// Phase 1 of the rollout intentionally leaves dismissal _writes_ to
// the API layer in routes/sessions.js — this module is read-only
// against the schema so it composes inside whatever transaction
// the caller is running.

const crypto = require("crypto");

// Soft-window for "judge changing panels too quickly". §5: same
// judge in blocks ≤ 15 min apart but not overlapping. Only applies
// to the `judge` resource kind — boards / divers / referee are
// either-or, no transit-time semantics.
const SOFT_JUDGE_GAP_MINUTES = 15;

// Stable sha256 of the resource membership at detection time. We
// sort the ids first so that {A,B} and {B,A} produce the same
// fingerprint — a dismissal of one is a dismissal of the other.
// Returned as a lowercase hex string, the same format the API
// layer stores in dismissed_conflicts.resource_fingerprint.
function fingerprint(resourceIds) {
  const sorted = (resourceIds || []).slice().sort();
  return crypto.createHash("sha256").update(sorted.join(",")).digest("hex");
}

// One detector query. The bulk of the work is the four UNION ALL
// arms — one per resource_kind — each computing the resource
// intersection between two overlapping blocks. The outer SELECT
// hauls in the human-readable labels (block labels, names, etc.)
// once per row, then left-joins dismissed_conflicts so callers can
// flag dismissed entries client-side.
//
// SOFT-WINDOW NOTE
// ----------------
// For judges only, we widen the overlap test to "or within
// SOFT_JUDGE_GAP_MINUTES of touching." A row is then marked 'hard'
// vs 'soft' based on whether the two blocks actually overlap in
// time. This keeps the planner happy (one set of pair candidates)
// at the cost of a slightly bigger join on the judge arm.
const DETECTOR_SQL = /* sql */ `
WITH pairs AS (
  SELECT
    a.id          AS a_id,
    a.session_id  AS a_session_id,
    a.label       AS a_label,
    a.starts_at   AS a_starts_at,
    a.ends_at     AS a_ends_at,
    a.board_ids   AS a_board_ids,
    a.event_id    AS a_event_id,
    b.id          AS b_id,
    b.session_id  AS b_session_id,
    b.label       AS b_label,
    b.starts_at   AS b_starts_at,
    b.ends_at     AS b_ends_at,
    b.board_ids   AS b_board_ids,
    b.event_id    AS b_event_id,
    sa.referee_user_id AS a_referee_id,
    sb.referee_user_id AS b_referee_id,
    (a.starts_at < b.ends_at AND b.starts_at < a.ends_at) AS overlaps
  FROM schedule_blocks a
  JOIN sessions sa ON sa.id = a.session_id
  JOIN schedule_blocks b ON b.id <> a.id AND b.id > a.id
  JOIN sessions sb ON sb.id = b.session_id
  WHERE sa.meet_id = $1
    AND sb.meet_id = $1
    -- Either the blocks overlap (the standard hard-conflict
    -- predicate), or they're within the judge soft-window. The
    -- per-arm filters below decide which conflict kinds actually
    -- fire — board / diver / referee are skipped for non-overlapping
    -- pairs by their own WHERE clauses.
    AND (
      (a.starts_at < b.ends_at AND b.starts_at < a.ends_at)
      OR (b.starts_at >= a.ends_at
          AND (b.starts_at - a.ends_at) <= ($2 || ' minutes')::interval)
      OR (a.starts_at >= b.ends_at
          AND (a.starts_at - b.ends_at) <= ($2 || ' minutes')::interval)
    )
),
judge_conflicts AS (
  -- Same judge on both blocks' event panels. Only applies to
  -- event_start blocks with non-null event_id.
  SELECT
    p.a_id, p.b_id, 'judge'::text AS resource_kind,
    array_agg(DISTINCT ej_a.judge_id) FILTER (WHERE ej_a.judge_id IS NOT NULL) AS resource_ids,
    array_agg(DISTINCT COALESCE(u.full_name, u.username)) FILTER (WHERE u.id IS NOT NULL) AS resource_labels,
    p.overlaps
  FROM pairs p
  JOIN event_judges ej_a ON ej_a.event_id = p.a_event_id
  JOIN event_judges ej_b ON ej_b.event_id = p.b_event_id
                         AND ej_b.judge_id = ej_a.judge_id
  LEFT JOIN users u ON u.id = ej_a.judge_id
  WHERE p.a_event_id IS NOT NULL AND p.b_event_id IS NOT NULL
  GROUP BY p.a_id, p.b_id, p.overlaps
),
board_conflicts AS (
  -- Array intersection on board_ids. Only meaningful when the
  -- blocks actually overlap (a board can't be double-booked when
  -- it's free between them).
  SELECT
    p.a_id, p.b_id, 'board'::text AS resource_kind,
    array_agg(DISTINCT bid) AS resource_ids,
    array_agg(DISTINCT COALESCE(bd.label, bd.height::text)) AS resource_labels,
    p.overlaps
  FROM pairs p
  CROSS JOIN LATERAL unnest(p.a_board_ids) AS bid
  LEFT JOIN boards bd ON bd.id = bid
  WHERE p.overlaps = TRUE
    AND p.a_board_ids IS NOT NULL
    AND p.b_board_ids IS NOT NULL
    AND bid = ANY(p.b_board_ids)
  GROUP BY p.a_id, p.b_id, p.overlaps
),
diver_conflicts AS (
  -- Active dive-list entries for both blocks' events. The Phase 1
  -- schema (init.sql) uses withdrawn_at + is_reserve rather than
  -- the design-doc's hypothetical 'status' enum — both convey
  -- "this entry doesn't claim a slot in the running event," which
  -- is what we care about for double-booking.
  SELECT
    p.a_id, p.b_id, 'diver'::text AS resource_kind,
    array_agg(DISTINCT dl_a.competitor_id) FILTER (WHERE dl_a.competitor_id IS NOT NULL) AS resource_ids,
    array_agg(DISTINCT COALESCE(u.full_name, u.username)) FILTER (WHERE u.id IS NOT NULL) AS resource_labels,
    p.overlaps
  FROM pairs p
  JOIN competitor_dive_lists dl_a
    ON dl_a.event_id = p.a_event_id
   AND dl_a.withdrawn_at IS NULL
   AND dl_a.is_reserve = FALSE
   AND dl_a.competitor_id IS NOT NULL
  JOIN competitor_dive_lists dl_b
    ON dl_b.event_id = p.b_event_id
   AND dl_b.withdrawn_at IS NULL
   AND dl_b.is_reserve = FALSE
   AND dl_b.competitor_id = dl_a.competitor_id
  LEFT JOIN users u ON u.id = dl_a.competitor_id
  WHERE p.overlaps = TRUE
    AND p.a_event_id IS NOT NULL
    AND p.b_event_id IS NOT NULL
  GROUP BY p.a_id, p.b_id, p.overlaps
),
referee_conflicts AS (
  -- Same referee_user_id on the two parent sessions. Sessions are
  -- per-day-per-pool, so two parallel sessions for the same meet
  -- can legitimately share a referee on paper — but if their
  -- blocks overlap in time, the human can't be in both places.
  SELECT
    p.a_id, p.b_id, 'referee'::text AS resource_kind,
    ARRAY[p.a_referee_id]::uuid[] AS resource_ids,
    ARRAY[COALESCE(u.full_name, u.username)]::text[] AS resource_labels,
    p.overlaps
  FROM pairs p
  LEFT JOIN users u ON u.id = p.a_referee_id
  WHERE p.overlaps = TRUE
    AND p.a_referee_id IS NOT NULL
    AND p.b_referee_id IS NOT NULL
    AND p.a_referee_id = p.b_referee_id
    AND p.a_session_id <> p.b_session_id
),
all_conflicts AS (
  SELECT * FROM judge_conflicts WHERE resource_ids IS NOT NULL AND cardinality(resource_ids) > 0
  UNION ALL
  SELECT * FROM board_conflicts WHERE resource_ids IS NOT NULL AND cardinality(resource_ids) > 0
  UNION ALL
  SELECT * FROM diver_conflicts WHERE resource_ids IS NOT NULL AND cardinality(resource_ids) > 0
  UNION ALL
  SELECT * FROM referee_conflicts WHERE resource_ids IS NOT NULL AND cardinality(resource_ids) > 0
)
SELECT
  c.a_id, c.b_id, c.resource_kind, c.resource_ids, c.resource_labels,
  -- §5: same judge in blocks ≤ 15 min apart but not overlapping
  -- is soft; everything else is hard. The non-judge arms already
  -- filter to overlaps=TRUE so their severity is always 'hard'.
  CASE
    WHEN c.resource_kind = 'judge' AND c.overlaps = FALSE THEN 'soft'
    ELSE 'hard'
  END AS severity,
  a.label AS a_label, a.starts_at AS a_starts_at, a.ends_at AS a_ends_at,
  a.session_id AS a_session_id, a.block_type AS a_block_type, a.event_id AS a_event_id,
  ea.name AS a_event_name,
  sa.name AS a_session_name,
  b.label AS b_label, b.starts_at AS b_starts_at, b.ends_at AS b_ends_at,
  b.session_id AS b_session_id, b.block_type AS b_block_type, b.event_id AS b_event_id,
  eb.name AS b_event_name,
  sb.name AS b_session_name,
  dc.id           AS dismissal_id,
  dc.resource_fingerprint AS dismissed_fingerprint,
  dc.dismissed_at AS dismissed_at,
  dc.reason       AS dismissed_reason
FROM all_conflicts c
JOIN schedule_blocks a ON a.id = c.a_id
JOIN sessions sa ON sa.id = a.session_id
LEFT JOIN events ea ON ea.id = a.event_id
JOIN schedule_blocks b ON b.id = c.b_id
JOIN sessions sb ON sb.id = b.session_id
LEFT JOIN events eb ON eb.id = b.event_id
LEFT JOIN dismissed_conflicts dc
  ON dc.block_a_id = c.a_id
 AND dc.block_b_id = c.b_id
 AND dc.resource_kind = c.resource_kind
ORDER BY a.starts_at ASC, b.starts_at ASC, c.resource_kind ASC;
`;

// Detect every active (and dismissed-but-still-valid) conflict for
// a meet. Accepts either a pg pool or a single pg client — both
// expose .query, which is all we need.
async function detectConflicts(meetId, pgClient) {
  if (!meetId) return [];
  if (!pgClient || typeof pgClient.query !== "function") {
    throw new Error("detectConflicts requires a pg client / pool with .query");
  }
  const result = await pgClient.query(DETECTOR_SQL, [
    meetId,
    String(SOFT_JUDGE_GAP_MINUTES),
  ]);

  return result.rows.map((row) => {
    const resourceIds = (row.resource_ids || []).map(String);
    const resourceLabels = (row.resource_labels || []).map((v) =>
      v == null ? "" : String(v),
    );
    const fp = fingerprint(resourceIds);
    // A dismissal counts only when both (a) a row exists and (b)
    // its stored fingerprint still matches what we just computed.
    // §5: stale fingerprints resurface as fresh conflicts.
    const dismissed = Boolean(
      row.dismissal_id && row.dismissed_fingerprint === fp,
    );
    return {
      block_a: {
        id: row.a_id,
        label: row.a_label,
        starts_at: row.a_starts_at,
        ends_at: row.a_ends_at,
        session_id: row.a_session_id,
        session_name: row.a_session_name,
        block_type: row.a_block_type,
        event_id: row.a_event_id,
        event_name: row.a_event_name,
      },
      block_b: {
        id: row.b_id,
        label: row.b_label,
        starts_at: row.b_starts_at,
        ends_at: row.b_ends_at,
        session_id: row.b_session_id,
        session_name: row.b_session_name,
        block_type: row.b_block_type,
        event_id: row.b_event_id,
        event_name: row.b_event_name,
      },
      resource_kind: row.resource_kind,
      resource_ids: resourceIds,
      resource_labels: resourceLabels,
      severity: row.severity,
      fingerprint: fp,
      dismissed,
      dismissal: dismissed
        ? {
            id: row.dismissal_id,
            at: row.dismissed_at,
            reason: row.dismissed_reason,
          }
        : null,
    };
  });
}

// Compute a fingerprint for an arbitrary block pair + resource
// kind — used by the dismissal API to derive the value server-side
// rather than trusting whatever the client posted. The query
// reaches into the same tables the detector does so the membership
// snapshot matches.
async function computeResourceFingerprint(
  pgClient,
  { blockAId, blockBId, resourceKind },
) {
  if (!pgClient || typeof pgClient.query !== "function") {
    throw new Error("computeResourceFingerprint requires a pg client");
  }
  const ids = await resourceIdsForPair(pgClient, {
    blockAId,
    blockBId,
    resourceKind,
  });
  return fingerprint(ids);
}

// Resource-id lookup per kind. Mirrors the detector's per-arm
// logic so the fingerprint reflects what the user would see in the
// drawer — not the raw union of every member of every panel.
async function resourceIdsForPair(
  pgClient,
  { blockAId, blockBId, resourceKind },
) {
  switch (resourceKind) {
    case "judge": {
      const r = await pgClient.query(
        `SELECT DISTINCT ej_a.judge_id AS id
           FROM schedule_blocks a
           JOIN schedule_blocks b ON b.id = $2
           JOIN event_judges ej_a ON ej_a.event_id = a.event_id
           JOIN event_judges ej_b ON ej_b.event_id = b.event_id
                                  AND ej_b.judge_id = ej_a.judge_id
          WHERE a.id = $1`,
        [blockAId, blockBId],
      );
      return r.rows.map((row) => row.id);
    }
    case "board": {
      const r = await pgClient.query(
        `SELECT DISTINCT bid AS id
           FROM schedule_blocks a, schedule_blocks b,
                LATERAL unnest(a.board_ids) AS bid
          WHERE a.id = $1 AND b.id = $2
            AND bid = ANY(b.board_ids)`,
        [blockAId, blockBId],
      );
      return r.rows.map((row) => row.id);
    }
    case "diver": {
      const r = await pgClient.query(
        `SELECT DISTINCT dl_a.competitor_id AS id
           FROM schedule_blocks a
           JOIN schedule_blocks b ON b.id = $2
           JOIN competitor_dive_lists dl_a
             ON dl_a.event_id = a.event_id
            AND dl_a.withdrawn_at IS NULL
            AND dl_a.is_reserve = FALSE
            AND dl_a.competitor_id IS NOT NULL
           JOIN competitor_dive_lists dl_b
             ON dl_b.event_id = b.event_id
            AND dl_b.withdrawn_at IS NULL
            AND dl_b.is_reserve = FALSE
            AND dl_b.competitor_id = dl_a.competitor_id
          WHERE a.id = $1`,
        [blockAId, blockBId],
      );
      return r.rows.map((row) => row.id);
    }
    case "referee": {
      const r = await pgClient.query(
        `SELECT sa.referee_user_id AS id
           FROM schedule_blocks a
           JOIN sessions sa ON sa.id = a.session_id
           JOIN schedule_blocks b ON b.id = $2
           JOIN sessions sb ON sb.id = b.session_id
          WHERE a.id = $1
            AND sa.referee_user_id IS NOT NULL
            AND sa.referee_user_id = sb.referee_user_id`,
        [blockAId, blockBId],
      );
      return r.rows
        .map((row) => row.id)
        .filter((v) => v != null);
    }
    default:
      return [];
  }
}

module.exports = {
  detectConflicts,
  computeResourceFingerprint,
  fingerprint,
  SOFT_JUDGE_GAP_MINUTES,
};
