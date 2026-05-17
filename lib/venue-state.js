// Venue scoreboard state — the canonical payload a local bridge
// service translates into Daktronics RTD packets, Colorado Time
// Systems CTS-5, OmegaTiming OSM7, ALGE Timy, or any vendor-
// specific LED-board protocol.
//
// Philosophy: DivingHQ stays vendor-agnostic. We emit a stable,
// well-documented JSON event over the existing Socket.IO transport;
// venue bridges run on a laptop in the building and translate to
// whatever serial/TCP protocol the venue hardware speaks. Federations
// can write their own bridge for any other vendor by subscribing
// to the same socket room.
//
// Wire shape (event name: `venue.scoreboard_state`):
//
//   {
//     "schema_version": 1,
//     "sequence": 42,                           // monotonic per event_id
//     "emitted_at": "2026-05-17T13:42:31Z",
//     "event_id": "uuid",
//     "event": {
//       "id": "uuid", "name": "Women's 3m Springboard",
//       "height": 3, "event_type": "individual" | "synchro_pair" | "team",
//       "status": "Live" | "Upcoming" | "Completed",
//       "round": 4,                             // current round being scored
//       "total_rounds": 6,
//       "on_hold": false,
//       "on_hold_reason": null
//     },
//     "active_diver": {                         // null when no diver on board
//       "competitor_id": "uuid",
//       "name": "Tom Daley",
//       "partner_name": null,                   // synchro: pair partner
//       "country_code": "GBR",
//       "club_code": "PLY",
//       "lane": null,                           // future hardware integration
//       "display_order": 5                      // position in the start list
//     },
//     "active_dive": {                          // null when no dive picked
//       "code": "109C",
//       "position": "",
//       "dd": 3.5,
//       "description": "Forward 4 1/2 Somersault Tuck"
//     },
//     "scores": [8.5, 8.0, 9.0, 8.5, 8.0],     // pending judges → null
//     "dive_total": 89.25,                      // null until final
//     "running_total": 312.50,
//     "current_rank": 1,
//     "field_size": 14,
//     "leaderboard": [                          // top N per top_n option
//       { "rank": 1, "name": "…", "country_code": "GBR", "total": 312.50 },
//       …
//     ]
//   }
//
// Sequence number resets on server restart (the bridge should
// re-sync from scratch via a one-shot fetch when it detects a
// sequence regression). Schema version bumps when the wire shape
// changes incompatibly.

const SCHEMA_VERSION = 1;

// Per-event monotonic sequence counters. In-memory — process
// restart resets to zero. A bridge that sees a sequence decrease
// should treat it as a re-sync signal.
const sequenceCounters = new Map(); // event_id → number

function nextSequence(eventId) {
  const n = (sequenceCounters.get(eventId) || 0) + 1;
  sequenceCounters.set(eventId, n);
  return n;
}

// Build the canonical scoreboard_state payload for one event.
// All DB reads are scoped to the single event; ~3 queries total,
// safe to call on every state change.
async function buildScoreboardState({ pool, eventId, activePayload, onHoldReason = null }) {
  const ev = await pool.query(
    `SELECT id, name, height, event_type, status, total_rounds, number_of_judges
       FROM events WHERE id = $1`,
    [eventId],
  );
  if (!ev.rows.length) return null;
  const event = ev.rows[0];

  // Active diver block. The payload from event_live_state carries
  // round + competitor + dive info; we look up display_order +
  // country/club for the venue board's lane/chip rendering.
  let activeDiver = null;
  let activeDive = null;
  let activeRound = activePayload?.round_number || null;
  let scores = [];
  let diveTotal = null;
  let currentRank = null;
  let runningTotal = null;
  let fieldSize = null;

  if (activePayload && activePayload.competitor_id) {
    const dRes = await pool.query(
      `SELECT u.id, u.full_name, o.country_code,
              cl.short_code AS club_code,
              cdl.display_order, cdl.partner_id,
              pu.full_name AS partner_name,
              d.dive_code, d.position, d.dd, d.description
         FROM users u
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = $1
          AND cdl.competitor_id = u.id
          AND cdl.round_number = $2
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         LEFT JOIN dive_directory d ON d.id = cdl.dive_id
        WHERE u.id = $3`,
      [eventId, activeRound, activePayload.competitor_id],
    );
    if (dRes.rows.length) {
      const row = dRes.rows[0];
      activeDiver = {
        competitor_id: row.id,
        name: row.full_name,
        partner_name: row.partner_name || null,
        country_code: row.country_code || null,
        club_code: row.club_code || null,
        lane: null,
        display_order: row.display_order,
      };
      if (row.dive_code) {
        activeDive = {
          code: row.dive_code,
          position: row.position || "",
          dd: row.dd != null ? Number(row.dd) : null,
          description: row.description || null,
        };
      }

      // Current judges' scores for this active dive. NULL slots
      // (pending judges) keep the array dense at panel-size so
      // venue displays render a fixed-width N-judge strip.
      const scoreRes = await pool.query(
        `SELECT ej.judge_number, s.score
           FROM event_judges ej
           LEFT JOIN scores s
             ON s.event_id = ej.event_id
            AND s.judge_id = ej.judge_id
            AND s.competitor_id = $2
            AND s.round_number = $3
          WHERE ej.event_id = $1
          ORDER BY ej.judge_number ASC`,
        [eventId, activePayload.competitor_id, activeRound],
      );
      scores = scoreRes.rows.map(r => r.score != null ? Number(r.score) : null);

      // Dive total — present only when every judge has scored.
      // The full scoring pipeline (calc_event_dive_points) is in
      // SQL; we delegate to it so we don't drift from the rest of
      // the app's totals.
      const allIn = scores.length && scores.every(s => s != null);
      if (allIn) {
        const total = await pool.query(
          `SELECT calc_event_dive_points(
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
            WHERE s.event_id = $1
              AND s.competitor_id = $2
              AND s.round_number = $3
            GROUP BY e.number_of_judges, e.event_type`,
          [eventId, activePayload.competitor_id, activeRound],
        );
        diveTotal = total.rows[0]?.pts != null ? Number(total.rows[0].pts) : null;
      }

      // Running total + rank for this diver across the whole event.
      const rankRes = await pool.query(
        `WITH per_dive AS (
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
            WHERE s.event_id = $1
            GROUP BY s.event_id, s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         ),
         totals AS (
           SELECT competitor_id, SUM(pts)::numeric(8,2) AS total
             FROM per_dive GROUP BY competitor_id
         ),
         ranked AS (
           SELECT competitor_id, total,
                  RANK() OVER (ORDER BY total DESC) AS rnk,
                  COUNT(*) OVER () AS field
             FROM totals
         )
         SELECT total, rnk::int AS rnk, field::int FROM ranked
          WHERE competitor_id = $2`,
        [eventId, activePayload.competitor_id],
      );
      if (rankRes.rows.length) {
        runningTotal = rankRes.rows[0].total != null ? Number(rankRes.rows[0].total) : null;
        currentRank = rankRes.rows[0].rnk;
        fieldSize = rankRes.rows[0].field;
      }
    }
  }

  // Top-8 leaderboard regardless of active diver — venue boards
  // typically show a persistent top-N panel + a per-dive splash.
  const lbRes = await pool.query(
    `WITH per_dive AS (
       SELECT s.competitor_id,
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
        WHERE s.event_id = $1
        GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
     ),
     totals AS (
       SELECT pd.competitor_id, SUM(pd.pts)::numeric(8,2) AS total
         FROM per_dive pd GROUP BY pd.competitor_id
     )
     SELECT u.full_name AS name,
            o.country_code,
            t.total
       FROM totals t
       JOIN users u ON u.id = t.competitor_id
       JOIN organisations o ON o.id = u.org_id
      ORDER BY t.total DESC
      LIMIT 8`,
    [eventId],
  );
  const leaderboard = lbRes.rows.map((row, i) => ({
    rank: i + 1,
    name: row.name,
    country_code: row.country_code || null,
    total: row.total != null ? Number(row.total) : null,
  }));

  return {
    schema_version: SCHEMA_VERSION,
    sequence: nextSequence(eventId),
    emitted_at: new Date().toISOString(),
    event_id: eventId,
    event: {
      id: event.id,
      name: event.name,
      height: event.height != null ? Number(event.height) : null,
      event_type: event.event_type,
      status: event.status,
      round: activeRound,
      total_rounds: event.total_rounds,
      on_hold: !!onHoldReason,
      on_hold_reason: onHoldReason || null,
    },
    active_diver: activeDiver,
    active_dive: activeDive,
    scores,
    dive_total: diveTotal,
    running_total: runningTotal,
    current_rank: currentRank,
    field_size: fieldSize,
    leaderboard,
  };
}

// Fan out the scoreboard state to the venue room. Wrapped in
// try/catch so a build error in one event can't break the score
// path or break other emits.
async function emitVenueState({ io, pool, eventId, activePayload, onHoldReason }) {
  if (!io || !pool || !eventId) return;
  try {
    const state = await buildScoreboardState({ pool, eventId, activePayload, onHoldReason });
    if (!state) return;
    io.to(`venue:${eventId}`).emit('venue.scoreboard_state', state);
  } catch (err) {
    console.error('[venue-state] emit failed', err.message);
  }
}

// Test helper.
function resetSequenceForTest() {
  sequenceCounters.clear();
}

module.exports = {
  SCHEMA_VERSION,
  buildScoreboardState,
  emitVenueState,
  resetSequenceForTest,
};
