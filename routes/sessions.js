// Sessions / Schedule routes — Phase 1 (read-only timeline + iCal).
//
//   GET    /api/meets/:meetId/sessions       sessions + inlined blocks
//   GET    /api/meets/:meetId/schedule.ics   iCal feed (public)
//
// Phase 1 deliberately ships read-only. Conflict detection
// (phase 2), drag-to-edit and the duplicate-session action
// (phase 3), and live re-flow (phase 4) all extend this same
// route file when their turn comes; the data model is already in
// place for them — see migration 049 and docs/session-scheduler.md.
//
// SEEDING
// -------
// Both boards and sessions are seeded *lazily* on the first GET
// rather than backfilled by the migration. Federations that
// never look at the scheduler pay no schema cost and don't get
// surprise rows. The seed runs inside a single transaction per
// request; if two managers hit the page simultaneously, the
// SELECT-then-INSERT race is harmless — the second writer just
// finds the same rows already there (boards are unique by
// (org, pool, height, label); sessions de-dupe by checking COUNT
// before inserting, and a re-seed after a prior partial would
// add another session row, which the operator can delete in
// phase 3 — Phase 1 has no edit affordance for that, but no
// running meet ever hits this code path twice).
//
// EVENT-DURATION ESTIMATE
// -----------------------
// total_rounds × competitor_count × 90 seconds. Falls back to
// 90 minutes when an event has no competitors yet (the common
// case before sign-ups close). Crude, but the operator can drag
// in phase 3 — the seed is a starting point, not a constraint.
//
// Mounted via:
//   app.use(require('./routes/sessions')({ pool, optionalAuth }))

const express = require("express");

// Default warmup length the WA rulebook expects in front of
// every competition event. Editable per-block in phase 3 — for
// now it's the auto-seed value.
const WARMUP_MINUTES = 45;

// Fallback when an event has zero competitor_dive_lists rows
// (sign-ups haven't closed yet, or it's a draft event). 90 min
// matches a typical 6-round individual event with ~6 divers.
const FALLBACK_EVENT_MINUTES = 90;

// Per-dive seconds used in the duration heuristic. Matches the
// rule-of-thumb commentators use: ~1.5 minutes per dive once
// you bake in walk-up + replay + judge entry.
const SECONDS_PER_DIVE = 90;

// Heights the auto-seed creates boards for in "Main pool".
// Skips '0m' (poolside / non-board events) — those are the
// outlier and the operator can add a board manually later.
const SEEDED_BOARD_HEIGHTS = ["1m", "3m", "5m", "7.5m", "10m"];

module.exports = function createSessionsRouter({ pool, optionalAuth }) {
  if (!pool) throw new Error("createSessionsRouter requires { pool, … }");
  const router = express.Router();
  const maybeAuth = optionalAuth || ((req, _res, next) => next());

  // -------------------------------------------------------------
  // Seed helpers — both idempotent in the sense that they no-op
  // when their target rows already exist for the org / meet.
  // -------------------------------------------------------------

  async function ensureBoardsForOrg(client, orgId) {
    const existing = await client.query(
      `SELECT 1 FROM boards
        WHERE org_id = $1 AND archived_at IS NULL
        LIMIT 1`,
      [orgId],
    );
    if (existing.rowCount) return;
    // One board per seeded height in "Main pool". display_order
    // mirrors SEEDED_BOARD_HEIGHTS so the timeline columns render
    // shallowest → deepest left-to-right, matching the way
    // venues label boards.
    for (let i = 0; i < SEEDED_BOARD_HEIGHTS.length; i++) {
      const h = SEEDED_BOARD_HEIGHTS[i];
      await client.query(
        `INSERT INTO boards (org_id, pool_name, height, display_order)
         VALUES ($1, 'Main pool', $2, $3)
         ON CONFLICT (org_id, pool_name, height, label) DO NOTHING`,
        [orgId, h, i],
      );
    }
  }

  // Estimate the duration of a single event_start block in ms.
  // Falls back to FALLBACK_EVENT_MINUTES when competitor_count
  // is zero (no dive lists submitted yet).
  function estimateEventDurationMs(totalRounds, competitorCount) {
    if (!competitorCount || competitorCount <= 0) {
      return FALLBACK_EVENT_MINUTES * 60 * 1000;
    }
    const rounds = totalRounds && totalRounds > 0 ? totalRounds : 6;
    return rounds * competitorCount * SECONDS_PER_DIVE * 1000;
  }

  async function seedSessionsForMeet(client, meetId, orgId) {
    // Are there any events in this meet with a scheduled_at?
    // No scheduled_at → nothing for the seed to anchor against;
    // we leave the meet without sessions and the GET returns
    // [] until the operator stamps times.
    const eventsRes = await client.query(
      `SELECT e.id, e.name, e.height, e.total_rounds, e.scheduled_at,
              e.board_id,
              COALESCE((
                SELECT COUNT(DISTINCT competitor_id)
                FROM competitor_dive_lists
                WHERE event_id = e.id AND withdrawn_at IS NULL
              ), 0)::int AS competitor_count
         FROM events e
        WHERE e.meet_id = $1 AND e.scheduled_at IS NOT NULL
        ORDER BY e.scheduled_at ASC`,
      [meetId],
    );
    if (!eventsRes.rowCount) return;

    // Distinct days the meet covers, in UTC. The session-row
    // name uses the event-day in UTC; the front-end re-renders
    // in the viewer's locale. Discrete dates is the right grain
    // here — a one-day session "Saturday morning, 3m" on top of
    // a UTC instant matches how operators talk about the meet.
    const dayBuckets = new Map(); // ISO date -> sessionId (created below)
    for (const ev of eventsRes.rows) {
      const dayKey = ev.scheduled_at.toISOString().slice(0, 10);
      if (!dayBuckets.has(dayKey)) {
        const sessRes = await client.query(
          `INSERT INTO sessions (meet_id, name, session_date, pool)
           VALUES ($1, $2, $3::date, 'Main pool')
           RETURNING id`,
          [meetId, `Session — ${dayKey}`, dayKey],
        );
        dayBuckets.set(dayKey, sessRes.rows[0].id);
      }
    }

    // Look up the seeded "Main pool" boards once. Matching is
    // by enum height; events.board_id (if the operator already
    // pinned one) wins over the height lookup. Heights with no
    // matching board (e.g. a 0m exhibition event) drop through
    // with an empty board_ids array — the block still renders,
    // just not in a specific column.
    const boardsRes = await client.query(
      `SELECT id, height
         FROM boards
        WHERE org_id = $1 AND pool_name = 'Main pool' AND archived_at IS NULL`,
      [orgId],
    );
    const boardByHeight = new Map();
    for (const b of boardsRes.rows) boardByHeight.set(b.height, b.id);

    for (const ev of eventsRes.rows) {
      const sessionId = dayBuckets.get(ev.scheduled_at.toISOString().slice(0, 10));
      const startsAt = new Date(ev.scheduled_at);
      const endsAt = new Date(
        startsAt.getTime() +
          estimateEventDurationMs(ev.total_rounds, ev.competitor_count),
      );
      const warmupStarts = new Date(startsAt.getTime() - WARMUP_MINUTES * 60 * 1000);
      const boardId = ev.board_id || (ev.height ? boardByHeight.get(ev.height) : null);
      const boardArray = boardId ? [boardId] : [];

      await client.query(
        `INSERT INTO schedule_blocks
           (session_id, block_type, label, starts_at, ends_at, board_ids, event_id)
         VALUES ($1, 'warmup', $2, $3, $4, $5::uuid[], NULL)`,
        [sessionId, `Warmup — ${ev.name}`, warmupStarts, startsAt, boardArray],
      );
      await client.query(
        `INSERT INTO schedule_blocks
           (session_id, block_type, label, starts_at, ends_at, board_ids, event_id)
         VALUES ($1, 'event_start', $2, $3, $4, $5::uuid[], $6)`,
        [sessionId, ev.name, startsAt, endsAt, boardArray, ev.id],
      );
    }
  }

  // -------------------------------------------------------------
  // GET /api/meets/:meetId/sessions
  //
  // Returns [{ ...session, blocks: [...] }] with blocks inlined
  // (avoids N+1 on render). On the first call for a meet that
  // has events with scheduled_at but no sessions, the boards
  // and sessions are seeded inside a transaction.
  // -------------------------------------------------------------
  router.get("/api/meets/:meetId/sessions", maybeAuth, async (req, res) => {
    const { meetId } = req.params;
    let client;
    try {
      client = await pool.connect();
      await client.query("BEGIN");

      const meetRes = await client.query(
        `SELECT id, org_id FROM meets WHERE id = $1`,
        [meetId],
      );
      if (!meetRes.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Meet not found" });
      }
      const orgId = meetRes.rows[0].org_id;

      // Boards are an org-level concept. Seed them first so the
      // session seed can resolve event.height → board_id.
      await ensureBoardsForOrg(client, orgId);

      const have = await client.query(
        `SELECT 1 FROM sessions WHERE meet_id = $1 LIMIT 1`,
        [meetId],
      );
      if (!have.rowCount) {
        await seedSessionsForMeet(client, meetId, orgId);
      }

      // Read back. Sessions ordered by session_date so the UI
      // can render top-down; blocks ordered by starts_at so the
      // front-end doesn't have to re-sort.
      const sessionsRes = await client.query(
        `SELECT s.id, s.meet_id, s.name, s.session_date, s.pool,
                s.referee_user_id, s.created_at, s.updated_at
           FROM sessions s
          WHERE s.meet_id = $1
          ORDER BY s.session_date ASC, s.created_at ASC`,
        [meetId],
      );
      const sessionIds = sessionsRes.rows.map((r) => r.id);
      let blocks = [];
      if (sessionIds.length) {
        const blocksRes = await client.query(
          `SELECT b.id, b.session_id, b.block_type, b.label,
                  b.starts_at, b.ends_at, b.board_ids, b.event_id,
                  b.actual_start_at, b.actual_end_at, b.notes,
                  b.created_at, b.updated_at,
                  e.name AS event_name, e.height AS event_height
             FROM schedule_blocks b
             LEFT JOIN events e ON e.id = b.event_id
            WHERE b.session_id = ANY($1::uuid[])
            ORDER BY b.starts_at ASC, b.created_at ASC`,
          [sessionIds],
        );
        blocks = blocksRes.rows;
      }

      // Boards for the org so the front-end can render columns
      // without a second round trip. Filtered to non-archived.
      const boardsRes = await client.query(
        `SELECT id, pool_name, height, label, display_order
           FROM boards
          WHERE org_id = $1 AND archived_at IS NULL
          ORDER BY pool_name ASC, display_order ASC, height ASC`,
        [orgId],
      );

      await client.query("COMMIT");

      const blocksBySession = new Map();
      for (const b of blocks) {
        if (!blocksBySession.has(b.session_id)) blocksBySession.set(b.session_id, []);
        blocksBySession.get(b.session_id).push(b);
      }
      const sessions = sessionsRes.rows.map((s) => ({
        ...s,
        blocks: blocksBySession.get(s.id) || [],
      }));
      res.json({ sessions, boards: boardsRes.rows });
    } catch (err) {
      if (client) {
        try { await client.query("ROLLBACK"); } catch { /* swallow */ }
      }
      console.error("[GET sessions]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      if (client) client.release();
    }
  });

  // -------------------------------------------------------------
  // GET /api/meets/:meetId/schedule.ics
  //
  // Public iCal feed — one VEVENT per schedule_block. Coaches
  // subscribe in Apple Calendar / Outlook / Google Calendar and
  // re-fetch on their client's cadence; later phases' re-flow
  // shifts propagate automatically without push.
  //
  // No auth (parity with the public schedule page surface, which
  // ships in a later phase). The endpoint never emits anything
  // that wasn't already on the public scoreboard, so there's no
  // info leak.
  // -------------------------------------------------------------
  router.get("/api/meets/:meetId/schedule.ics", async (req, res) => {
    const { meetId } = req.params;
    try {
      const meetRes = await pool.query(
        `SELECT m.id, m.name, m.venue, o.name AS org_name
           FROM meets m
           JOIN organisations o ON o.id = m.org_id
          WHERE m.id = $1`,
        [meetId],
      );
      if (!meetRes.rowCount) {
        return res.status(404).type("text/plain").send("Meet not found");
      }
      const meet = meetRes.rows[0];

      // Pull blocks with their session, plus the human-readable
      // board labels concatenated server-side so the iCal writer
      // doesn't need a second query per row.
      const blocksRes = await pool.query(
        `SELECT b.id, b.block_type, b.label,
                b.starts_at, b.ends_at, b.notes,
                s.name AS session_name, s.pool AS session_pool,
                COALESCE((
                  SELECT string_agg(
                    COALESCE(bd.label, bd.height::text), ', '
                    ORDER BY bd.display_order
                  )
                  FROM boards bd
                  WHERE bd.id = ANY(b.board_ids)
                ), '') AS board_labels
           FROM schedule_blocks b
           JOIN sessions s ON s.id = b.session_id
          WHERE s.meet_id = $1
          ORDER BY b.starts_at ASC`,
        [meetId],
      );

      // Host fragment for the UID. RFC 5545 requires UIDs be
      // globally unique; "blockid@host" is the standard pattern.
      const host = req.get("host") || "divinghq.local";
      const ics = renderIcs({ meet, blocks: blocksRes.rows, host });

      res.set("Content-Type", "text/calendar; charset=utf-8");
      res.set(
        "Content-Disposition",
        `inline; filename="meet-${meetId}.ics"`,
      );
      // Calendar clients re-fetch on their own cadence; tell
      // shared caches not to hold the doc for long.
      res.set("Cache-Control", "public, max-age=60");
      res.send(ics);
    } catch (err) {
      console.error("[GET schedule.ics]", err.message);
      res.status(500).type("text/plain").send("Internal server error");
    }
  });

  return router;
};

// -----------------------------------------------------------------
// iCal serializer.
//
// Hand-written rather than dragging in an npm dep — the format
// is small enough that the standards work fits in a screen:
//   * CRLF line endings (RFC 5545 §3.1)
//   * 75-octet line folding (continuation = CRLF + space)
//   * Escape: backslash, comma, semicolon, newline
//   * DTSTAMP / DTSTART / DTEND in UTC basic format (Z suffix)
// -----------------------------------------------------------------
function renderIcs({ meet, blocks, host }) {
  const lines = [];
  lines.push("BEGIN:VCALENDAR");
  lines.push("VERSION:2.0");
  lines.push("PRODID:-//DivingHQ//Session Scheduler//EN");
  lines.push("CALSCALE:GREGORIAN");
  lines.push("METHOD:PUBLISH");
  lines.push(foldLine(`X-WR-CALNAME:${escapeText(meet.name)}`));
  if (meet.venue) {
    lines.push(foldLine(`X-WR-CALDESC:${escapeText(meet.venue)}`));
  }

  const stamp = formatIcsUtc(new Date());
  for (const b of blocks) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:block-${b.id}@${host}`);
    lines.push(`DTSTAMP:${stamp}`);
    lines.push(`DTSTART:${formatIcsUtc(b.starts_at)}`);
    lines.push(`DTEND:${formatIcsUtc(b.ends_at)}`);
    lines.push(foldLine(`SUMMARY:${escapeText(blockSummary(b))}`));
    const descParts = [];
    if (b.session_name) descParts.push(`Session: ${b.session_name}`);
    if (b.board_labels) descParts.push(`Board: ${b.board_labels}`);
    if (b.session_pool) descParts.push(`Pool: ${b.session_pool}`);
    if (b.notes) descParts.push(b.notes);
    if (descParts.length) {
      lines.push(foldLine(`DESCRIPTION:${escapeText(descParts.join("\n"))}`));
    }
    if (meet.venue) {
      lines.push(foldLine(`LOCATION:${escapeText(meet.venue)}`));
    }
    lines.push(`CATEGORIES:${b.block_type.toUpperCase()}`);
    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

function blockSummary(b) {
  // Prefer the operator-set label; fall back to a sensible
  // default per block_type so a row with no label is still
  // useful when it lands in a coach's calendar.
  if (b.label && b.label.trim()) return b.label.trim();
  switch (b.block_type) {
    case "warmup":      return "Warmup";
    case "event_start": return "Event";
    case "break":       return "Break";
    case "ceremony":    return "Ceremony";
    default:            return "Scheduled block";
  }
}

// RFC 5545 escape rules — order matters: backslash first so it
// doesn't double-escape the others.
function escapeText(value) {
  if (value == null) return "";
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

// 20251231T235959Z — basic-format UTC, no separators.
function formatIcsUtc(value) {
  const d = value instanceof Date ? value : new Date(value);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mi = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${yyyy}${mm}${dd}T${hh}${mi}${ss}Z`;
}

// RFC 5545 §3.1 — lines must not exceed 75 octets. Continuation
// lines start with a single space (CRLF + space). We chunk on
// byte length, not character length, since multibyte UTF-8
// characters count toward the limit. Splitting inside a
// multibyte sequence is avoided by walking codepoints and
// flushing whenever the next character would push us past 75.
function foldLine(line) {
  const encoded = Buffer.from(line, "utf8");
  if (encoded.length <= 75) return line;
  const out = [];
  let chunk = "";
  let chunkBytes = 0;
  // Iterate over codepoints (so emoji etc. don't get sliced).
  for (const ch of line) {
    const charBytes = Buffer.byteLength(ch, "utf8");
    // First chunk has no leading space, continuation chunks do
    // (1 octet for the space), so the budget tightens after the
    // first line.
    const budget = out.length === 0 ? 75 : 74;
    if (chunkBytes + charBytes > budget) {
      out.push(chunk);
      chunk = ch;
      chunkBytes = charBytes;
    } else {
      chunk += ch;
      chunkBytes += charBytes;
    }
  }
  if (chunk) out.push(chunk);
  return out.map((p, i) => (i === 0 ? p : " " + p)).join("\r\n");
}

module.exports.__test__ = { renderIcs, escapeText, formatIcsUtc, foldLine };
