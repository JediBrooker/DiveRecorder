// Event routes — CRUD + status transitions.
//
//   GET    /api/events            list (anon → Live/Completed only)
//   POST   /api/events            create (org_admin only)
//   PUT    /api/events/:id        update (event manager / org_admin)
//   DELETE /api/events/:id        remove (org_admin only)
//   PUT    /api/events/:id/status flip Upcoming/Live/Completed
//
// Adjacent concerns — judges, managers, roster, advance, dive
// templates, event-judges plumbing — live in their own routes
// modules (extraction in progress; many still in server.js as of
// the Phase-4 split). loadEventForEntries — used by the
// diver-portal and team dive-list submit handlers — moved into
// lib/middleware.js so it can be imported once and reused by
// both consumers.
//
// Mounted via:
//   app.use(require('./routes/events')({ … }))

const express = require("express");
const jwt = require("jsonwebtoken");
const { recordAudit, auditFromReq } = require("../lib/audit");

// Migration 039: shape-check operator-prescribed round_dives. We
// only validate structure here (round numbering 1..N contiguous,
// dive_id is a string-or-null, height is numeric-or-null); FK
// validity is enforced by Postgres on INSERT.
function validateRoundDivesShape(round_dives) {
  if (round_dives == null) return { valid: true };
  if (!Array.isArray(round_dives)) {
    return { valid: false, error: "round_dives must be an array" };
  }
  if (round_dives.length > 12) {
    return { valid: false, error: "round_dives can have at most 12 rounds" };
  }
  const seen = new Set();
  for (let i = 0; i < round_dives.length; i++) {
    const slot = round_dives[i];
    if (!slot || typeof slot !== "object") {
      return { valid: false, error: `round_dives[${i}]: not an object` };
    }
    const rn = Number(slot.round_number);
    if (!Number.isInteger(rn) || rn < 1) {
      return { valid: false, error: `round_dives[${i}]: round_number must be a positive integer` };
    }
    if (seen.has(rn)) {
      return { valid: false, error: `round_dives[${i}]: duplicate round_number ${rn}` };
    }
    seen.add(rn);
    if (slot.dive_id != null && typeof slot.dive_id !== "string") {
      return { valid: false, error: `round_dives[${i}]: dive_id must be a uuid string or null` };
    }
    if (slot.height != null && slot.height !== "") {
      const h = Number(slot.height);
      if (!Number.isFinite(h) || h < 0 || h > 20) {
        return { valid: false, error: `round_dives[${i}]: height must be between 0 and 20 metres` };
      }
    }
  }
  // Round numbers must be contiguous 1..N (no gaps, since the
  // section/round-rules walker assumes this).
  for (let r = 1; r <= round_dives.length; r++) {
    if (!seen.has(r)) {
      return { valid: false, error: `round_dives missing round_number ${r}` };
    }
  }
  return { valid: true };
}

module.exports = function createEventsRouter({
  pool,
  JWT_SECRET,
  io,
  verifyToken,
  requireOrgAdmin,
  requireEventManager,
  sendEventStartedEmails,
  sendEventResultsEmails,
  activeDivers,
  meetHolds,
  // Optional — when supplied, the Completed-status cleanup
  // also drops the matching event_live_state row so the
  // table doesn't accumulate dead state.
  persistClearAll,
  // Optional. Used by the international-invite flow to notify
  // every org_admin of a newly-invited federation. Falls back
  // to a silent skip if the push engine isn't wired (the
  // notification row will simply not be created).
  push,
}) {
  if (!pool || !JWT_SECRET) {
    throw new Error("createEventsRouter requires { pool, JWT_SECRET, … }");
  }
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/events — list events visible to the caller.
  //
  //   * anonymous   → Live/Completed only
  //   * sysadmin    → every event in every org
  //   * regular user → events in caller's org
  //
  // 401-on-bad-JWT (rather than silent downgrade to public)
  // landed in Migration 021 — if the caller sent a bad token they
  // meant to be authed, so the SPA needs the signal to prompt
  // re-login.
  // -------------------------------------------------------------
  router.get("/api/events", async (req, res) => {
    try {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      let result;
      // participating_orgs_count > 0 → international event (the
       // SPA renders a 🌐 chip and the federations modal pre-loads
       // the invited list). Subselect rather than LEFT JOIN +
       // GROUP BY so the rest of the query stays readable.
      const SELECT = `
        SELECT e.*, o.name AS org_name, o.country_code, o.slug AS org_slug,
               COALESCE(
                 (SELECT COUNT(*) FROM event_participating_orgs epo
                   WHERE epo.event_id = e.id),
                 0
               )::int AS participating_orgs_count
        FROM events e
        JOIN organisations o ON o.id = e.org_id
      `;
      if (token) {
        let decoded;
        try {
          decoded = jwt.verify(token, JWT_SECRET);
        } catch {
          return res.status(401).json({ error: "Token expired or invalid; please sign in again" });
        }
        if (decoded.is_system_admin) {
          result = await pool.query(`${SELECT} ORDER BY e.created_at DESC`);
        } else {
          // Show events the caller's org hosts OR events that
          // explicitly invited the caller's org via
          // event_participating_orgs. The EXISTS subquery is
          // short-circuited by the OR — domestic-only orgs pay
          // no extra cost. Sysadmin already bypassed above.
          result = await pool.query(
            `${SELECT}
             WHERE e.org_id = $1
                OR EXISTS (
                  SELECT 1 FROM event_participating_orgs epo
                   WHERE epo.event_id = e.id AND epo.org_id = $1
                )
             ORDER BY e.created_at DESC`,
            [decoded.org_id],
          );
        }
      } else {
        result = await pool.query(
          `${SELECT} WHERE e.status IN ('Live','Completed') ORDER BY e.created_at DESC`,
        );
      }
      res.json(result.rows);
    } catch (err) {
      console.error("[Events List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/events — create an event in caller's org.
  //
  // org_admin only (no event_managers fallback because the event
  // doesn't exist yet — there's no row to be a manager of).
  // -------------------------------------------------------------
  router.post("/api/events", requireOrgAdmin, async (req, res) => {
    const {
      name, gender, number_of_judges, total_rounds, height, event_type, meet_id,
      age_group, scheduled_at, event_format, parent_event_id, advance_count,
      dd_limit_rounds, dd_limit_value,
      // Migration 020: optional registration deadline.
      entries_close_at,
      // Migration 031:
      //   enforce_referee_signoff — gate the simple manager-attests
      //                             sign-off path; force push or
      //                             credential entry by the named
      //                             referee.
      //   is_mixed_height         — multi-board event; the picker
      //                             widens to the full directory.
      enforce_referee_signoff, is_mixed_height,
      // Migration 038: structured round-by-round dive-list rules.
      // Optional — when null the legacy (dd_limit_rounds,
      // dd_limit_value) flat constraint applies. See
      // lib/round-rules.js for the shape + validator.
      round_rules,
      // Migration 039: operator-prescribed round dives. Array of
      // { round_number, dive_id|null, height|null }. Length, when
      // present, becomes the canonical total_rounds and overrides
      // any total_rounds field in the body.
      round_dives,
    } = req.body || {};

    // Validate round_dives shape + derive effective total_rounds.
    const rdCheck = validateRoundDivesShape(round_dives);
    if (!rdCheck.valid) {
      return res.status(400).json({ error: rdCheck.error });
    }
    const effectiveTotalRounds =
      Array.isArray(round_dives) && round_dives.length
        ? round_dives.length
        : (total_rounds || 6);

    // Validate round_rules shape if supplied — use the EFFECTIVE
    // total so the section-sum check sees the actual round count
    // when round_dives drove it.
    if (round_rules != null) {
      const rrCheck = require("../lib/round-rules")
        .validateRoundRules(round_rules, effectiveTotalRounds);
      if (!rrCheck.valid) {
        return res.status(400).json({ error: rrCheck.error });
      }
    }

    // Synchronised pairs require 9 or 11 judges (the only panel
    // sizes World Aquatics defines exec/sync judge groups for).
    const type = event_type || "individual";
    if (type === "synchro_pair" && ![9, 11].includes(number_of_judges)) {
      return res.status(400).json({
        error: "Synchronised pair events require 9 or 11 judges",
      });
    }
    // Validate event_format. Three valid stages, in order:
    //   preliminary → semifinal → final
    // 'final' is the default.
    const fmt = event_format || "final";
    if (!["preliminary", "semifinal", "final"].includes(fmt)) {
      return res
        .status(400)
        .json({ error: "event_format must be 'preliminary', 'semifinal' or 'final'" });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Validate meet_id if provided — must belong to the same org.
      if (meet_id) {
        const m = await client.query(
          "SELECT id FROM meets WHERE id = $1 AND org_id = $2",
          [meet_id, req.user.org_id],
        );
        if (!m.rows.length) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Meet not found in this organisation" });
        }
      }
      // Validate parent_event_id if this event is downstream of
      // another stage. Allowed parent shapes:
      //   semifinal → parent must be a 'preliminary'
      //   final     → parent may be a 'preliminary' OR a 'semifinal'
      //   preliminary → must NOT have a parent (it's the source)
      if (parent_event_id) {
        if (fmt === "preliminary") {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Preliminary events can't have a parent stage" });
        }
        const p = await client.query(
          "SELECT id, event_format, org_id FROM events WHERE id = $1",
          [parent_event_id],
        );
        if (!p.rows.length || p.rows[0].org_id !== req.user.org_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Parent event not found in this org" });
        }
        const parentFmt = p.rows[0].event_format;
        const allowedParents = fmt === "semifinal"
          ? ["preliminary"]
          : ["preliminary", "semifinal"];
        if (!allowedParents.includes(parentFmt)) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: `A ${fmt} can only feed from ${allowedParents.join(' or ')} (got '${parentFmt}')`,
          });
        }
      }
      const evRes = await client.query(
        `INSERT INTO events
           (name, gender, age_group, number_of_judges, total_rounds, height,
            event_type, event_format, parent_event_id, advance_count,
            dd_limit_rounds, dd_limit_value, scheduled_at, entries_close_at,
            org_id, meet_id,
            enforce_referee_signoff, is_mixed_height,
            round_rules)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
         RETURNING *`,
        [
          name,
          gender,
          age_group || null,
          number_of_judges || 5,
          effectiveTotalRounds,
          // For mixed-board events the column is informational
          // only — store NULL so any "filter dives by height"
          // logic that didn't get the is_mixed_height memo just
          // returns nothing rather than the wrong subset.
          is_mixed_height ? null : (height || null),
          type,
          fmt,
          parent_event_id || null,
          advance_count || 12,
          dd_limit_rounds || 0,
          dd_limit_value || null,
          scheduled_at || null,
          entries_close_at || null,
          req.user.org_id,
          meet_id || null,
          !!enforce_referee_signoff,
          !!is_mixed_height,
          round_rules ? JSON.stringify(round_rules) : null,
        ],
      );
      const event = evRes.rows[0];
      // Persist any operator-prescribed round dives (migration 039).
      if (Array.isArray(round_dives) && round_dives.length) {
        for (const slot of round_dives) {
          await client.query(
            `INSERT INTO event_round_dives (event_id, round_number, dive_id, height)
             VALUES ($1, $2, $3, $4)`,
            [
              event.id,
              slot.round_number,
              slot.dive_id || null,
              slot.height == null || slot.height === ""
                ? null
                : Number(slot.height),
            ],
          );
        }
      }
      // Creator becomes the first event manager automatically.
      await client.query(
        "INSERT INTO event_managers (event_id, user_id, added_by) VALUES ($1,$2,$2)",
        [event.id, req.user.id],
      );
      // Audit the create. metadata captures the headline config
      // an admin would want to see when reviewing later — full
      // event row is available via /events/:id if more detail
      // is needed.
      await recordAudit(client, {
        ...auditFromReq(req),
        org_id:      req.user.org_id,
        entity_type: "event",
        entity_id:   event.id,
        entity_name: event.name,
        action:      "event.created",
        metadata: {
          event_type: event.event_type,
          height:     event.height,
          number_of_judges: event.number_of_judges,
          total_rounds:     event.total_rounds,
          gender:     event.gender,
          age_group:  event.age_group,
          meet_id:    event.meet_id,
        },
      });
      await client.query("COMMIT");
      res.status(201).json(event);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Create Event Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // PUT /api/events/:id — partial update. Every COALESCE-able
  // field is treated as "leave alone if not sent". The
  // entries_close_at column uses tri-state semantics (undefined =
  // untouched, null/'' = clear, string = set) since "no value
  // sent" and "explicitly cleared" mean different things on a
  // nullable timestamp.
  // -------------------------------------------------------------
  router.put("/api/events/:id", requireEventManager(), async (req, res) => {
    const {
      name, gender, number_of_judges, total_rounds, height, event_type,
      age_group, scheduled_at, event_format, parent_event_id, advance_count,
      dd_limit_rounds, dd_limit_value,
      entries_close_at,
      // Migration 031 — see POST handler for the rationale.
      enforce_referee_signoff, is_mixed_height,
      // Migration 038 — structured round rules. Tri-state:
      //   undefined → leave untouched
      //   null      → clear, fall back to legacy dd_limit_*
      //   {sections}→ set
      round_rules,
      // Migration 039 — operator-prescribed round dives. Tri-state:
      //   undefined → leave untouched
      //   []        → clear all prescribed dives for this event
      //   [...slots]→ replace the existing rows
      round_dives,
    } = req.body || {};
    if (event_type === "synchro_pair" && ![9, 11].includes(number_of_judges)) {
      return res.status(400).json({
        error: "Synchronised pair events require 9 or 11 judges",
      });
    }
    if (event_format && !["preliminary", "semifinal", "final"].includes(event_format)) {
      return res
        .status(400)
        .json({ error: "event_format must be 'preliminary', 'semifinal' or 'final'" });
    }
    // Validate round_dives shape if supplied. When round_dives is
    // a non-empty array, it becomes the canonical total_rounds.
    const rdShape = validateRoundDivesShape(round_dives);
    if (!rdShape.valid) {
      return res.status(400).json({ error: rdShape.error });
    }
    const effectiveTotalRoundsForRules =
      Array.isArray(round_dives) && round_dives.length
        ? round_dives.length
        : total_rounds;
    if (round_rules != null) {
      const rrCheck = require("../lib/round-rules")
        .validateRoundRules(round_rules, effectiveTotalRoundsForRules);
      if (!rrCheck.valid) {
        return res.status(400).json({ error: rrCheck.error });
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // entries_close_at uses tri-state semantics. Pass a boolean
      // sentinel + the actual value so the SQL can express both
      // "leave untouched" and "set to NULL" in one statement.
      const closeUntouched = entries_close_at === undefined;
      const closeValue = closeUntouched ? null : (entries_close_at || null);
      // Tri-state on the two new boolean flags too: undefined =
      // leave untouched, true/false = set explicitly. Done with
      // CASE so a partial PUT body doesn't accidentally flip a
      // flag back to its default.
      const enforceUntouched = enforce_referee_signoff === undefined;
      const mixedUntouched   = is_mixed_height          === undefined;
      // total_rounds: when round_dives is a non-empty array its
      // length wins; an empty array (`[]` = clear) reverts to the
      // body's total_rounds (or untouched if neither is set).
      const totalRoundsForUpdate =
        Array.isArray(round_dives) && round_dives.length
          ? round_dives.length
          : (total_rounds || null);
      const r = await client.query(
        `UPDATE events SET
           name             = COALESCE($1, name),
           gender           = COALESCE($2, gender),
           number_of_judges = COALESCE($3, number_of_judges),
           total_rounds     = COALESCE($4, total_rounds),
           height           = $5,
           event_type       = COALESCE($6, event_type),
           age_group        = $7,
           event_format     = COALESCE($8, event_format),
           parent_event_id  = $9,
           advance_count    = COALESCE($10, advance_count),
           dd_limit_rounds  = COALESCE($11, dd_limit_rounds),
           dd_limit_value   = $12,
           scheduled_at     = $13,
           entries_close_at = CASE WHEN $14::boolean THEN entries_close_at ELSE $15::timestamptz END,
           enforce_referee_signoff = CASE WHEN $19::boolean THEN enforce_referee_signoff ELSE $20::boolean END,
           is_mixed_height         = CASE WHEN $21::boolean THEN is_mixed_height         ELSE $22::boolean END,
           round_rules             = CASE WHEN $23::boolean THEN round_rules ELSE $24::jsonb END
         WHERE id=$16 AND ($17::boolean OR org_id=$18) RETURNING *`,
        [
          name || null,
          gender || null,
          number_of_judges || null,
          totalRoundsForUpdate,
          // Mixed-board: clobber height to NULL even if the
          // caller sent a value, so the column doesn't lie.
          is_mixed_height ? null : (height || null),
          event_type || null,
          age_group ?? null,
          event_format || null,
          parent_event_id ?? null,
          advance_count || null,
          dd_limit_rounds ?? null,
          dd_limit_value ?? null,
          scheduled_at ?? null,
          closeUntouched,
          closeValue,
          req.params.id,
          !!req.user.is_system_admin,
          req.user.org_id,
          enforceUntouched, !!enforce_referee_signoff,
          mixedUntouched,   !!is_mixed_height,
          // Tri-state: undefined → leave alone, null → clear,
          // {sections} → JSON-stringify and set.
          round_rules === undefined,
          round_rules === undefined || round_rules === null
            ? null
            : JSON.stringify(round_rules),
        ],
      );
      if (!r.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Event not found" });
      }

      // Replace prescribed round_dives if the caller sent the key.
      // undefined → leave alone; [] → clear; non-empty → replace.
      if (round_dives !== undefined) {
        await client.query(
          "DELETE FROM event_round_dives WHERE event_id = $1",
          [req.params.id],
        );
        if (Array.isArray(round_dives) && round_dives.length) {
          for (const slot of round_dives) {
            await client.query(
              `INSERT INTO event_round_dives (event_id, round_number, dive_id, height)
               VALUES ($1, $2, $3, $4)`,
              [
                req.params.id,
                slot.round_number,
                slot.dive_id || null,
                slot.height == null || slot.height === ""
                  ? null
                  : Number(slot.height),
              ],
            );
          }
        }
      }
      await client.query("COMMIT");
      res.json(r.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Update Event Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // -------------------------------------------------------------
  // DELETE /api/events/:id — org_admin only. CASCADE down to
  // dive lists, judges, scores etc. via FKs in init.sql.
  // -------------------------------------------------------------
  router.delete("/api/events/:id", requireOrgAdmin, async (req, res) => {
    try {
      // Read the row first so the audit row carries the
      // (post-delete-orphaned) name + org. RETURNING * inside the
      // DELETE itself would also work but a separate SELECT is
      // clearer for readers.
      const prior = await pool.query(
        "SELECT id, name, org_id, status FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!prior.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const ev = prior.rows[0];
      // Refuse delete once any score has landed. The event's audit
      // trail and result history are evidentiary; deleting the row
      // would orphan score_audit rows (SET NULL post-035) and lose
      // the parent context. Sysadmins can still force the delete by
      // passing ?force=1, recorded in the audit metadata.
      const force = req.query.force === "1" || req.query.force === "true";
      const scoreCount = await pool.query(
        "SELECT COUNT(*)::int AS n FROM scores WHERE event_id = $1",
        [ev.id],
      );
      if (scoreCount.rows[0].n > 0 && !(force && req.user.is_system_admin)) {
        return res.status(409).json({
          error: `Refusing to delete: event has ${scoreCount.rows[0].n} recorded scores. Cancel or finalise the event instead.`,
          score_count: scoreCount.rows[0].n,
        });
      }
      await pool.query("DELETE FROM events WHERE id = $1", [ev.id]);
      // Audit. status preserved in metadata so a sysadmin
      // investigation can spot "this event was deleted while
      // it was Live" patterns.
      await recordAudit(pool, {
        ...auditFromReq(req),
        org_id:      ev.org_id,
        entity_type: "event",
        entity_id:   ev.id,
        entity_name: ev.name,
        action:      "event.deleted",
        metadata: { previous_status: ev.status },
      });
      res.json({ message: "Event deleted" });
    } catch (err) {
      console.error("[Delete Event Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PUT /api/events/:id/status — Upcoming → Live → Completed.
  // Fires notifications on the meaningful transitions and frees
  // the in-memory state when an event finalises.
  // -------------------------------------------------------------
  router.put("/api/events/:id/status", requireEventManager(), async (req, res) => {
    const { status } = req.body || {};
    const validStatuses = ["Upcoming", "Live", "Completed"];
    if (!validStatuses.includes(status)) {
      return res
        .status(400)
        .json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
    }
    try {
      // Read the previous status before the update so we know
      // which notification (if any) to fire.
      const prior = await pool.query(
        "SELECT status FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      const previousStatus = prior.rows[0]?.status;

      const r = await pool.query(
        "UPDATE events SET status = $1 WHERE id = $2 AND ($3::boolean OR org_id = $4) RETURNING *",
        [status, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!r.rows.length)
        return res.status(404).json({ error: "Event not found" });

      // Notify competitors on the meaningful transitions.
      // Best-effort, never blocks the response.
      if (previousStatus !== status) {
        if (status === "Live")      sendEventStartedEmails(r.rows[0]).catch(() => {});
        if (status === "Completed") sendEventResultsEmails(r.rows[0]).catch(() => {});

        // Real-time push for the dashboard pulse strip — emit
        // globally so any connected dashboard tab can refetch
        // its pulse data and update the LIVE / UPCOMING /
        // COMPLETED counts immediately. Cheap broadcast (no
        // sensitive data); recipients filter by what they're
        // authorised to see via their existing API gates.
        if (io && typeof io.emit === "function") {
          try {
            io.emit("event_status_changed", {
              event_id: r.rows[0].id,
              org_id:   r.rows[0].org_id,
              from:     previousStatus,
              to:       status,
            });
          } catch (_e) { /* ignore — best-effort */ }
        }

        // Audit the status flip. Specific actions for the
        // meaningful transitions ('event.started',
        // 'event.finalised', 'event.unfinalised') so the audit
        // view can colour-code or filter on them — falls back
        // to a generic 'event.status_changed' for the unusual
        // hops (e.g. Live → Upcoming for a workflow re-do).
        let action = "event.status_changed";
        if (previousStatus === "Upcoming" && status === "Live")      action = "event.started";
        else if (previousStatus === "Live"     && status === "Completed") action = "event.finalised";
        else if (previousStatus === "Completed" && status === "Live") action = "event.unfinalised";
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id:      r.rows[0].org_id,
          entity_type: "event",
          entity_id:   r.rows[0].id,
          entity_name: r.rows[0].name,
          action,
          metadata: { from: previousStatus, to: status },
        });
      }

      // Free up the in-memory state for finished events.
      // activeDivers and meetHolds are keyed by event_id and
      // would otherwise accumulate as meets pile up. Also
      // clear the persisted row in event_live_state so a
      // restart doesn't rehydrate dead state.
      if (status === "Completed") {
        delete activeDivers[r.rows[0].id];
        delete meetHolds[r.rows[0].id];
        if (typeof persistClearAll === "function") {
          persistClearAll(r.rows[0].id);
        }
      }

      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Status Update Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PARTICIPATING ORGS — opt-in list of OTHER federations whose
  // divers can self-enter this event. Host-org_admin manages.
  //
  //   GET    /api/events/:id/participating-orgs
  //   POST   /api/events/:id/participating-orgs   { org_id }
  //   DELETE /api/events/:id/participating-orgs/:org_id
  //
  // Empty list = domestic-only event (host-org divers only). Any
  // populated row makes this an international event in practice.
  // The host org is NEVER inserted here — events.org_id is the
  // source of truth for the host. See migration 036.
  // -------------------------------------------------------------

  // -------------------------------------------------------------
  // GET /api/events/:id/round-dives — operator-prescribed round
  // dives for a single event (migration 039). Returned as an
  // ordered array enriched with the dive's directory fields so
  // the diver portal can render the locked rows without a second
  // round-trip. Empty array when no rows exist.
  //
  // Public for Live/Completed events; authed scope for Upcoming
  // (mirrors the GET /api/events visibility contract — operators
  // shouldn't have their pre-meet bulletin leaked).
  // -------------------------------------------------------------
  router.get("/api/events/:id/round-dives", async (req, res) => {
    try {
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      let callerOrgId = null;
      let callerIsSys = false;
      if (token) {
        try {
          const decoded = require("jsonwebtoken").verify(token, JWT_SECRET);
          callerOrgId = decoded.org_id;
          callerIsSys = !!decoded.is_system_admin;
        } catch { /* anonymous */ }
      }
      const ev = await pool.query(
        "SELECT org_id, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const evRow = ev.rows[0];
      const isAuthScope =
        callerIsSys || (callerOrgId && callerOrgId === evRow.org_id);
      if (!isAuthScope && !["Live", "Completed"].includes(evRow.status)) {
        return res.status(404).json({ error: "Event not found" });
      }
      const rows = await pool.query(
        `SELECT erd.round_number, erd.dive_id, erd.height,
                d.dive_code, d.position, d.dd, d.description,
                d.height AS dive_height
           FROM event_round_dives erd
           LEFT JOIN dive_directory d ON d.id = erd.dive_id
          WHERE erd.event_id = $1
          ORDER BY erd.round_number ASC`,
        [req.params.id],
      );
      res.json(rows.rows);
    } catch (err) {
      console.error("[Round Dives Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Public read — the meet's public landing page wants to render
  // "participating: AUS / NZL / FIJ" badges, so this endpoint is
  // open to anonymous spectators. Mirrors the privacy contract
  // of /api/events itself: anonymous callers only see Live or
  // Completed events. An Upcoming event's participating list is
  // the host's competitive intelligence and stays private until
  // the event flips Live (the same moment the public listing
  // reveals the event itself). Authed callers in the host org
  // (or sysadmin) bypass the status filter so the Federations
  // modal works pre-meet.
  router.get("/api/events/:id/participating-orgs", async (req, res) => {
    try {
      // Inline auth peek — no shared optionalAuth helper here,
      // and we don't need a full JWT verify for this gate; just
      // identifying the caller's org is enough.
      const authHeader = req.headers["authorization"];
      const token = authHeader && authHeader.split(" ")[1];
      let callerOrgId = null;
      let callerIsSys = false;
      if (token) {
        try {
          const decoded = require("jsonwebtoken").verify(token, JWT_SECRET);
          callerOrgId = decoded.org_id;
          callerIsSys = !!decoded.is_system_admin;
        } catch { /* anonymous */ }
      }
      const ev = await pool.query(
        "SELECT org_id, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const { org_id: hostOrgId, status } = ev.rows[0];
      const callerIsHostOrParticipant = callerIsSys
        || callerOrgId === hostOrgId;
      if (!callerIsHostOrParticipant && status !== "Live" && status !== "Completed") {
        return res.json([]);
      }
      const r = await pool.query(
        `SELECT epo.org_id, epo.added_at,
                o.name AS org_name, o.country_code, o.slug AS org_slug
           FROM event_participating_orgs epo
           JOIN organisations o ON o.id = epo.org_id
          WHERE epo.event_id = $1
          ORDER BY o.name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Participating Orgs List Error]", err.message);
      res.status(500).json([]);
    }
  });

  // Add — host org_admin only (or sysadmin). Same gate as POST
  // /api/events. The event is loaded first so the response can
  // confirm host-org match.
  router.post("/api/events/:id/participating-orgs", requireOrgAdmin, async (req, res) => {
    const { org_id } = req.body || {};
    if (!org_id) return res.status(400).json({ error: "org_id is required" });
    try {
      const ev = await pool.query(
        "SELECT id, org_id, name, status FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      // Only the HOST org's admin (or sysadmin) can grant
      // entry to other federations. requireOrgAdmin already
      // confirmed `org_admin` somewhere; tighten to "this event's
      // host org".
      if (!req.user.is_system_admin && ev.rows[0].org_id !== req.user.org_id) {
        return res.status(403).json({ error: "You don't host this event" });
      }
      // Refuse on already-finalised events — inviting a federation
      // post-Completed sends a stale "your divers can now self-
      // enter" notification (the entry-gate middleware would
      // reject every actual submit) AND opens a way to spam
      // foreign admins by toggling Completed → Upcoming and back.
      if (ev.rows[0].status === "Completed") {
        return res.status(409).json({
          error: "Event is already Completed — re-open it before inviting more federations",
        });
      }
      // Disallow listing the host's own org — that's the implicit
      // entry path, not a participating-org row.
      if (org_id === ev.rows[0].org_id) {
        return res.status(400).json({
          error: "Host org is implicit — don't list it as a participating org",
        });
      }
      // Active orgs only — pending/rejected/suspended can't
      // participate.
      const target = await pool.query(
        "SELECT id, name, status FROM organisations WHERE id = $1",
        [org_id],
      );
      if (!target.rows.length) return res.status(404).json({ error: "Target org not found" });
      if (target.rows[0].status !== "active") {
        return res.status(409).json({
          error: `${target.rows[0].name} is ${target.rows[0].status}; only active orgs can participate`,
        });
      }
      const inserted = await pool.query(
        `INSERT INTO event_participating_orgs (event_id, org_id, added_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (event_id, org_id) DO NOTHING
         RETURNING event_id`,
        [req.params.id, org_id, req.user.id],
      );
      // Audit row so the host federation has a clean record of
      // who invited whom.
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          org_id:      ev.rows[0].org_id,
          entity_type: "event",
          entity_id:   ev.rows[0].id,
          entity_name: ev.rows[0].name,
          action:      "event.participating_org.added",
          metadata: { participating_org_id: org_id, participating_org_name: target.rows[0].name },
        });
      } catch (auditErr) {
        console.error("[Participating Org Audit Skipped]", auditErr.message);
      }
      // Fire an in-app notification to every org_admin of the
      // newly-invited federation. They land in /inbox and on
      // the dashboard pulse strip's incoming-feed; if web push
      // is wired they also buzz the admin's phone. ON CONFLICT
      // returning empty = the row already existed (re-add of an
      // already-invited org); skip the notification spam.
      if (inserted.rows.length && push && typeof push.sendNotification === "function") {
        try {
          // Find every user with org_admin in the invited org —
          // gate on user_org_roles.role alone, NOT on
          // users.org_id matching. A user can hold org_admin in
          // an org that isn't their primary; the previous
          // r.org_id = u.org_id predicate silently dropped those
          // admins from the fan-out.
          const admins = await pool.query(
            `SELECT DISTINCT u.id
               FROM user_org_roles r
               JOIN users u ON u.id = r.user_id
              WHERE r.org_id = $1 AND r.role = 'org_admin'`,
            [org_id],
          );
          const adminIds = admins.rows.map(r => r.id);
          if (adminIds.length) {
            const hostOrg = await pool.query(
              "SELECT name FROM organisations WHERE id = $1",
              [ev.rows[0].org_id],
            );
            await push.sendNotification(adminIds, {
              category:  "international_invite",
              title:     `${hostOrg.rows[0]?.name || "A host federation"} invited you to "${ev.rows[0].name}"`,
              body:      "Your divers can now self-enter this event. Open Meet Manager to see who's competing.",
              data:      { event_id: ev.rows[0].id, host_org_id: ev.rows[0].org_id },
              action_url: `/manager?event=${ev.rows[0].id}`,
            });
          }
        } catch (notifErr) {
          console.error("[Invite Notification Skipped]", notifErr.message);
        }
      }
      res.status(201).json({ ok: true });
    } catch (err) {
      console.error("[Add Participating Org Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove — host org_admin removes ANY federation, OR a visiting
  // federation's own org_admin self-withdraws their participation.
  // The visiting-side path lets a country pull out without
  // pinging the host (e.g. funding cut, travel ban, schedule
  // clash) — existing roster entries stay intact (the diver
  // gates only block NEW entries) so no in-flight competition
  // is destabilised.
  router.delete("/api/events/:id/participating-orgs/:org_id", requireOrgAdmin, async (req, res) => {
    try {
      // Defense-in-depth: lowercase the URL-supplied UUIDs so a
      // mixed-case path (e.g. uppercase pasted from a copy-out)
      // doesn't fail the equality check below for a legitimate
      // self-withdraw, and so the audit row's metadata always
      // records the canonical lowercase form (audit search-by-
      // org-id stays consistent).
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const eventId = (req.params.id || "").toLowerCase();
      const orgId   = (req.params.org_id || "").toLowerCase();
      if (!UUID_RE.test(eventId) || !UUID_RE.test(orgId)) {
        return res.status(400).json({ error: "Invalid event_id or org_id (must be UUID)" });
      }
      const ev = await pool.query(
        "SELECT id, org_id, name FROM events WHERE id = $1",
        [eventId],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const isSysAdmin = !!req.user.is_system_admin;
      const isHostAdmin = ev.rows[0].org_id === req.user.org_id;
      const isSelfWithdraw = orgId === (req.user.org_id || "").toLowerCase();
      if (!isSysAdmin && !isHostAdmin && !isSelfWithdraw) {
        return res.status(403).json({
          error: "Only the host federation can remove other federations, and only the visiting federation can withdraw itself",
        });
      }
      const r = await pool.query(
        "DELETE FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2 RETURNING org_id",
        [eventId, orgId],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Not on the participating list" });
      try {
        await recordAudit(pool, {
          ...auditFromReq(req),
          // Audit row lands on the host org's books — that's where
          // the event lives and where compliance reads for it.
          // The metadata captures whether this was host-removal
          // or self-withdrawal so the trail reads correctly.
          org_id:      ev.rows[0].org_id,
          entity_type: "event",
          entity_id:   ev.rows[0].id,
          entity_name: ev.rows[0].name,
          action:      "event.participating_org.removed",
          metadata: {
            participating_org_id: orgId,
            removed_by_self: isSelfWithdraw && !isHostAdmin,
          },
        });
      } catch (auditErr) {
        console.error("[Participating Org Audit Skipped]", auditErr.message);
      }
      // Notify the host's org admins when a federation
      // self-withdraws — they need to know their roster expectation
      // changed. (Host-driven removal doesn't need this — the host
      // initiated it.)
      if (isSelfWithdraw && !isHostAdmin && push && typeof push.sendNotification === "function") {
        try {
          // Same multi-org-admin fix as the invite-fanout: gate
          // on r.role alone, not on r.org_id = u.org_id.
          const hostAdmins = await pool.query(
            `SELECT DISTINCT u.id
               FROM user_org_roles r
               JOIN users u ON u.id = r.user_id
              WHERE r.org_id = $1 AND r.role = 'org_admin'`,
            [ev.rows[0].org_id],
          );
          const adminIds = hostAdmins.rows.map(r => r.id);
          if (adminIds.length) {
            const leavingOrg = await pool.query(
              "SELECT name FROM organisations WHERE id = $1",
              [orgId],
            );
            await push.sendNotification(adminIds, {
              category:  "international_invite",
              title:     `${leavingOrg.rows[0]?.name || "A federation"} withdrew from "${ev.rows[0].name}"`,
              body:      "Their divers will no longer be able to enter new dive lists. Existing entries stay intact.",
              data:      { event_id: ev.rows[0].id, withdrawing_org_id: orgId },
              action_url: `/manager?event=${ev.rows[0].id}`,
            });
          }
        } catch (notifErr) {
          console.error("[Withdraw Notification Skipped]", notifErr.message);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Remove Participating Org Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Eligible divers for an event — host org's divers + every
  // participating org's divers. Used by the synchro-partner
  // picker and the late-entry roster lookup so a meet manager
  // can find foreign divers without hitting the org-scoped
  // /api/orgs/:id/divers endpoint.
  //
  // The previous gate was `verifyToken` only — any signed-in
  // user (including a freshly-registered spectator in any
  // federation) could enumerate full diver rosters of every
  // event in the system. Tightened to require either:
  //   1. event-staff for THIS event (requireEventManager),
  //      which covers the meet manager's late-entry use case;
  //   2. OR a diver/coach whose own org is on the event's
  //      eligibility list, which covers the synchro-partner
  //      picker for visiting federations.
  router.get("/api/events/:id/eligible-divers", verifyToken, async (req, res) => {
    try {
      // Org-eligibility check first (cheap). Sysadmins bypass.
      const evRow = await pool.query(
        "SELECT org_id FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!evRow.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const eventOrgId = evRow.rows[0].org_id;
      const isSysAdmin   = !!req.user.is_system_admin;
      const isHostOrg    = req.user.org_id === eventOrgId;
      let isEligibleOrg  = isHostOrg;
      if (!isSysAdmin && !isEligibleOrg) {
        const part = await pool.query(
          "SELECT 1 FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2",
          [req.params.id, req.user.org_id],
        );
        isEligibleOrg = part.rows.length > 0;
      }
      if (!isSysAdmin && !isEligibleOrg) {
        return res.status(403).json({
          error: "Your federation is not eligible for this event",
        });
      }
      const r = await pool.query(
        `SELECT u.id, u.full_name,
                u.org_id, o.name AS org_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code
           FROM users u
           JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
           JOIN organisations o  ON o.id = u.org_id
           LEFT JOIN clubs cl    ON cl.id = u.club_id
          WHERE u.org_id IN (
                  SELECT org_id FROM events WHERE id = $1
                  UNION
                  SELECT org_id FROM event_participating_orgs WHERE event_id = $1
                )
          ORDER BY o.name ASC, u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Eligible Divers Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -------------------------------------------------------------
  // Stage progression — prelim → semi → final.
  //
  //   GET  /api/events/:id/advance/preview
  //   POST /api/events/:id/advance
  //
  // :id is the PARENT event (the prelim or semifinal). The child
  // event is the one whose `parent_event_id` points at :id.
  //
  // Preview returns the WA tie-break ranking of the parent's
  // divers so the modal can show "who would advance" before the
  // operator commits.
  //
  // POST commits: it copies each chosen diver's per-round dives
  // into the child event's competitor_dive_lists, sets is_reserve
  // on the trailing N reserves, and assigns display_order per the
  // chosen mode:
  //
  //   'inherit' — copy the parent's display_order, drop non-
  //               progressors, re-number 1..N (default for semi).
  //   'reverse' — top diver dives LAST (default for finals).
  //   'random'  — randomise the primaries.
  //
  // Reserves get is_reserve=true + reserve_position 1..M and no
  // display_order. The Control Room can later promote a reserve
  // (flipping the flag + assigning the next open display_order)
  // when a primary withdraws.
  // -------------------------------------------------------------
  async function rankedDiversForAdvance(client, parentEventId) {
    // Re-uses the same WA tie-break the live scoreboard does
    // (cumulative_total DESC, dives_so_far_desc DESC). Returns one
    // row per diver with their final cumulative rank, dive_id by
    // round, and display_order from the parent event so the
    // 'inherit' dive-order mode can carry it forward.
    const r = await client.query(
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
         SELECT competitor_id,
                SUM(round_total) AS total,
                array_agg(round_total ORDER BY round_total DESC, round_number) AS dives_desc
         FROM dive_totals
         GROUP BY competitor_id
       ),
       ranked AS (
         SELECT competitor_id, total,
                RANK() OVER (ORDER BY total DESC, dives_desc DESC) AS rnk
         FROM cumulative
       )
       SELECT r.competitor_id, r.total, r.rnk,
              u.full_name, u.username,
              MIN(cdl.display_order) AS parent_display_order,
              array_agg(json_build_object(
                'round_number', cdl.round_number,
                'dive_id',      cdl.dive_id
              ) ORDER BY cdl.round_number) FILTER (WHERE cdl.dive_id IS NOT NULL) AS dives
         FROM ranked r
         JOIN users u ON u.id = r.competitor_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = $1
          AND cdl.competitor_id = r.competitor_id
          AND cdl.withdrawn_at IS NULL
        GROUP BY r.competitor_id, r.total, r.rnk, u.full_name, u.username
        ORDER BY r.rnk ASC, u.full_name ASC`,
      [parentEventId],
    );
    return r.rows;
  }

  // Look up the child event of :id — the next stage that points
  // back at us via parent_event_id. Returns null if none exists.
  async function childEvent(client, parentEventId) {
    const r = await client.query(
      `SELECT id, event_format, total_rounds, status
         FROM events
        WHERE parent_event_id = $1
        ORDER BY created_at ASC
        LIMIT 1`,
      [parentEventId],
    );
    return r.rows[0] || null;
  }

  router.get(
    "/api/events/:id/advance/preview",
    requireEventManager(),
    async (req, res) => {
      const client = await pool.connect();
      try {
        const parent = await client.query(
          "SELECT id, event_format, status, advance_count, total_rounds FROM events WHERE id = $1",
          [req.params.id],
        );
        if (!parent.rows.length) {
          return res.status(404).json({ error: "Event not found" });
        }
        const ev = parent.rows[0];
        if (!["preliminary", "semifinal"].includes(ev.event_format)) {
          return res.status(400).json({ error: "Only preliminary or semifinal events advance" });
        }
        const child = await childEvent(client, ev.id);
        const ranked = await rankedDiversForAdvance(client, ev.id);
        res.json({
          parent: {
            id: ev.id,
            format: ev.event_format,
            status: ev.status,
            total_rounds: ev.total_rounds,
            advance_count: ev.advance_count,
          },
          child: child
            ? { id: child.id, format: child.event_format, total_rounds: child.total_rounds, status: child.status }
            : null,
          ranked,
        });
      } catch (err) {
        console.error("[Advance Preview Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  router.post(
    "/api/events/:id/advance",
    requireEventManager(),
    async (req, res) => {
      const {
        top_n,
        reserves = 0,
        dive_order, // 'inherit' | 'reverse' | 'random'
        // World Aquatics DD 7.4 / 7.5: divers must submit the
        // next stage's list within 30 min of the prior stage's
        // results being announced. Configurable per-advance,
        // 0 = no auto-lock (operator wants no time pressure).
        lock_minutes = 30,
      } = req.body || {};
      const topN = parseInt(top_n);
      const resN = parseInt(reserves) || 0;
      const lockMin = Number.isFinite(parseInt(lock_minutes))
        ? Math.max(0, Math.min(parseInt(lock_minutes), 24 * 60))
        : 30;
      if (!Number.isInteger(topN) || topN < 1) {
        return res.status(400).json({ error: "top_n must be a positive integer" });
      }
      if (resN < 0 || resN > 50) {
        return res.status(400).json({ error: "reserves must be between 0 and 50" });
      }
      const orderMode = ['inherit', 'reverse', 'random'].includes(dive_order)
        ? dive_order
        : 'inherit';

      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const parentRes = await client.query(
          "SELECT id, event_format, status, total_rounds FROM events WHERE id = $1",
          [req.params.id],
        );
        if (!parentRes.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Event not found" });
        }
        const parent = parentRes.rows[0];
        if (!['preliminary', 'semifinal'].includes(parent.event_format)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Only preliminary or semifinal events advance" });
        }
        if (parent.status !== 'Completed') {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Parent event must be Completed before advancing divers",
          });
        }
        const child = await childEvent(client, parent.id);
        if (!child) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "No downstream event linked to this one — create the next stage first",
          });
        }
        if (child.status !== 'Upcoming') {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Child event must be Upcoming to seed its roster",
          });
        }
        const ranked = await rankedDiversForAdvance(client, parent.id);
        if (!ranked.length) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "Parent event has no scored divers to advance",
          });
        }
        const primaries = ranked.slice(0, topN);
        const reserveRows = ranked.slice(topN, topN + resN);

        // Compute display_order for primaries per the chosen mode.
        // 'inherit' — copy parent_display_order, then re-number 1..N
        //              so gaps from non-progressors close up.
        // 'reverse' — top diver dives last → rank 1 gets order topN,
        //              rank topN gets order 1.
        // 'random'  — Fisher-Yates a copy of [1..topN] and assign.
        const primaryOrder = primaries.map((r, i) => ({ idx: i, sort: r.parent_display_order ?? r.rnk }));
        if (orderMode === 'inherit') {
          primaryOrder.sort((a, b) =>
            (a.sort == null ? Infinity : a.sort) - (b.sort == null ? Infinity : b.sort),
          );
        } else if (orderMode === 'reverse') {
          // Already in rank order ascending — reverse so worst dives first, top last.
          primaryOrder.reverse();
        } else if (orderMode === 'random') {
          for (let i = primaryOrder.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [primaryOrder[i], primaryOrder[j]] = [primaryOrder[j], primaryOrder[i]];
          }
        }
        // Build a competitor_id → display_order map (1-indexed).
        const displayOrderByCompetitor = new Map();
        primaryOrder.forEach((o, position) => {
          displayOrderByCompetitor.set(primaries[o.idx].competitor_id, position + 1);
        });

        // Pre-load any prescribed round dives for the child so we
        // can override the inherited dive_ids when the operator
        // pinned specific dives at the child level.
        const prescribedRes = await client.query(
          "SELECT round_number, dive_id FROM event_round_dives WHERE event_id = $1 AND dive_id IS NOT NULL",
          [child.id],
        );
        const prescribedByRound = new Map(
          prescribedRes.rows.map((r) => [r.round_number, r.dive_id]),
        );

        // Wipe any existing roster on the child — re-running advance
        // is a "redo" not an append. Score-bearing rows would have
        // status != Upcoming so we already short-circuited above.
        await client.query(
          "DELETE FROM competitor_dive_lists WHERE event_id = $1",
          [child.id],
        );

        const childRounds = child.total_rounds;
        async function insertDiverRows(diver, { isReserve, reservePos, displayOrder }) {
          const dives = Array.isArray(diver.dives) ? diver.dives : [];
          const byRound = new Map(dives.map((d) => [d.round_number, d.dive_id]));
          for (let r = 1; r <= childRounds; r++) {
            const diveId = prescribedByRound.has(r)
              ? prescribedByRound.get(r)
              : (byRound.get(r) || null);
            await client.query(
              `INSERT INTO competitor_dive_lists
                (event_id, competitor_id, dive_id, round_number,
                 display_order, is_reserve, reserve_position)
               VALUES ($1, $2, $3, $4, $5, $6, $7)`,
              [
                child.id,
                diver.competitor_id,
                diveId,
                r,
                isReserve ? null : displayOrder,
                isReserve,
                isReserve ? reservePos : null,
              ],
            );
          }
        }

        for (const diver of primaries) {
          await insertDiverRows(diver, {
            isReserve: false,
            reservePos: null,
            displayOrder: displayOrderByCompetitor.get(diver.competitor_id),
          });
        }
        for (let i = 0; i < reserveRows.length; i++) {
          await insertDiverRows(reserveRows[i], {
            isReserve: true,
            reservePos: i + 1,
            displayOrder: null,
          });
        }

        // Stamp the dive-list lock on the child event. WA DD 7.4
        // / 7.5: divers have 30 min after the prior stage's
        // official results are announced to submit / confirm
        // the next stage's list. Operator can override the
        // window (or disable with lock_minutes=0).
        let lockAtIso = null;
        if (lockMin > 0) {
          const lockRes = await client.query(
            `UPDATE events
                SET dive_list_locks_at = NOW() + ($2::int || ' minutes')::interval
              WHERE id = $1
              RETURNING dive_list_locks_at`,
            [child.id, lockMin],
          );
          lockAtIso = lockRes.rows[0]?.dive_list_locks_at?.toISOString() || null;
        } else {
          // Explicit 0 means "no auto-lock" — clear any stale
          // value left from a prior advance.
          await client.query(
            "UPDATE events SET dive_list_locks_at = NULL WHERE id = $1",
            [child.id],
          );
        }

        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   child.id,
          entity_name: null,
          action:      "event.advanced",
          metadata: {
            parent_event_id: parent.id,
            top_n: topN,
            reserves: resN,
            dive_order: orderMode,
            lock_minutes: lockMin,
            dive_list_locks_at: lockAtIso,
          },
        });

        await client.query("COMMIT");

        // Push notifications to advanced primaries + reserves so
        // they see "you've advanced — confirm or edit by [time]"
        // in the inbox. Best-effort; if the push engine isn't
        // wired the rows just skip notification.
        if (push && typeof push.sendNotification === "function") {
          try {
            const advancedIds = [
              ...primaries.map((d) => d.competitor_id),
              ...reserveRows.map((d) => d.competitor_id),
            ];
            const evNameRes = await pool.query(
              "SELECT name FROM events WHERE id = $1",
              [child.id],
            );
            const childName = evNameRes.rows[0]?.name || "the next stage";
            const lockHint = lockAtIso
              ? ` Locks at ${new Date(lockAtIso).toLocaleString()}.`
              : "";
            await push.sendNotification(advancedIds, {
              category:  "dive_list_advanced",
              title:     `You've advanced to "${childName}"`,
              body:      `Your dive list carried over from the previous stage.${lockHint} Tap to confirm or edit before then.`,
              data:      {
                event_id: child.id,
                parent_event_id: parent.id,
                lock_at: lockAtIso,
              },
              action_url: `/competitor?event=${child.id}`,
            });
          } catch (notifErr) {
            console.error("[Advance Notification Skipped]", notifErr.message);
          }
        }

        res.json({
          advanced: primaries.length,
          reserves: reserveRows.length,
          dive_order: orderMode,
          child_event_id: child.id,
          dive_list_locks_at: lockAtIso,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Advance Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  // -------------------------------------------------------------
  // GET /api/events/:id/reserves — list reserves on an event with
  // their dive-list preview (round + dive_code/dd) so the Control
  // Room reserves panel can render rich rows + "promote" buttons.
  // Visible to event managers.
  // -------------------------------------------------------------
  router.get(
    "/api/events/:id/reserves",
    requireEventManager(),
    async (req, res) => {
      try {
        const r = await pool.query(
          `SELECT cdl.competitor_id,
                  cdl.reserve_position,
                  u.full_name,
                  cl.short_code AS club_code,
                  cl.name       AS club_name,
                  array_agg(json_build_object(
                    'round_number', cdl.round_number,
                    'dive_code',    d.dive_code,
                    'position',     d.position,
                    'dd',           d.dd,
                    'description',  d.description
                  ) ORDER BY cdl.round_number) AS dives
             FROM competitor_dive_lists cdl
             JOIN users u   ON u.id = cdl.competitor_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
             LEFT JOIN dive_directory d ON d.id = cdl.dive_id
            WHERE cdl.event_id = $1 AND cdl.is_reserve = TRUE
            GROUP BY cdl.competitor_id, cdl.reserve_position,
                     u.full_name, cl.short_code, cl.name
            ORDER BY cdl.reserve_position ASC NULLS LAST, u.full_name ASC`,
          [req.params.id],
        );

        // Also surface withdrawn primaries so the Control Room
        // can offer a "Replace [withdrawn diver] →" picker on
        // each reserve. Per WA DD 9.1 the reserve inherits the
        // withdrawn diver's start order.
        const w = await pool.query(
          `SELECT DISTINCT ON (cdl.competitor_id)
                  cdl.competitor_id,
                  u.full_name,
                  cl.short_code AS club_code,
                  cdl.withdrawn_at,
                  cdl.display_order
             FROM competitor_dive_lists cdl
             JOIN users u   ON u.id = cdl.competitor_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
            WHERE cdl.event_id = $1
              AND cdl.is_reserve = FALSE
              AND cdl.withdrawn_at IS NOT NULL
            ORDER BY cdl.competitor_id, cdl.round_number ASC`,
          [req.params.id],
        );

        // Active primaries — used by the Control Room to offer
        // "Replace …" against any active diver too (e.g. the
        // operator pre-emptively swaps before official Live
        // start, when the diver gives advance notice).
        const a = await pool.query(
          `SELECT DISTINCT ON (cdl.competitor_id)
                  cdl.competitor_id,
                  u.full_name,
                  cl.short_code AS club_code,
                  cdl.display_order
             FROM competitor_dive_lists cdl
             JOIN users u   ON u.id = cdl.competitor_id
             LEFT JOIN clubs cl ON cl.id = u.club_id
            WHERE cdl.event_id = $1
              AND cdl.is_reserve = FALSE
              AND cdl.withdrawn_at IS NULL
            ORDER BY cdl.competitor_id, cdl.display_order ASC NULLS LAST`,
          [req.params.id],
        );

        res.json({
          reserves:  r.rows,
          withdrawn: w.rows,
          active:    a.rows,
        });
      } catch (err) {
        console.error("[Reserves List Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // Promote a reserve to active. Flips is_reserve=false on every
  // row for that competitor in the event, clears reserve_position,
  // assigns the next open display_order so they slot into the
  // back of the queue (for filling an empty slot in the
  // semi-final / final).
  //
  // Body (optional):
  //   replaces_competitor_id — when set, the operator is using
  //                            this reserve to replace a primary
  //                            who has withdrawn. Per WA Rule
  //                            DD 9.1 / 9.2, the reserve takes
  //                            the withdrawn diver's start
  //                            position so the original dive
  //                            order is preserved. The replaced
  //                            diver gets withdrawn_at stamped
  //                            (if not already), display_order
  //                            cleared, and is moved out of the
  //                            active queue.
  router.post(
    "/api/events/:id/reserves/:competitorId/promote",
    requireEventManager(),
    async (req, res) => {
      const { id: eventId, competitorId } = req.params;
      const { replaces_competitor_id } = req.body || {};
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        // Verify the row exists + is currently a reserve.
        const r = await client.query(
          `SELECT 1 FROM competitor_dive_lists
             WHERE event_id = $1 AND competitor_id = $2 AND is_reserve = TRUE
             LIMIT 1`,
          [eventId, competitorId],
        );
        if (!r.rows.length) {
          await client.query("ROLLBACK");
          return res.status(404).json({ error: "Reserve not found" });
        }

        // Replacement path — WA DD 9.1 / 9.2: reserve inherits
        // the withdrawn diver's start position. We grab the
        // withdrawn diver's display_order, withdraw them (if
        // not already), then assign that order to the reserve
        // so the dive sequence is preserved.
        let inheritedOrder = null;
        let replacedName = null;
        if (replaces_competitor_id) {
          const withdraw = await client.query(
            `SELECT MIN(display_order) AS dorder, MIN(u.full_name) AS name
               FROM competitor_dive_lists cdl
               JOIN users u ON u.id = cdl.competitor_id
              WHERE cdl.event_id = $1
                AND cdl.competitor_id = $2
                AND cdl.is_reserve = FALSE`,
            [eventId, replaces_competitor_id],
          );
          if (!withdraw.rows.length || withdraw.rows[0].dorder == null) {
            await client.query("ROLLBACK");
            return res.status(404).json({
              error: "Diver to replace not found in active roster",
            });
          }
          inheritedOrder = withdraw.rows[0].dorder;
          replacedName = withdraw.rows[0].name;
          // Withdraw the original diver: stamp withdrawn_at if
          // not already + clear display_order so they don't
          // appear in the active queue. Their dive_id rows stay
          // in place for the audit trail.
          await client.query(
            `UPDATE competitor_dive_lists
                SET withdrawn_at = COALESCE(withdrawn_at, NOW()),
                    display_order = NULL
              WHERE event_id = $1 AND competitor_id = $2`,
            [eventId, replaces_competitor_id],
          );
        }

        const targetOrder = inheritedOrder != null
          ? inheritedOrder
          : (await client.query(
              `SELECT COALESCE(MAX(display_order), 0) + 1 AS next
                 FROM competitor_dive_lists
                WHERE event_id = $1 AND is_reserve = FALSE`,
              [eventId],
            )).rows[0].next;

        await client.query(
          `UPDATE competitor_dive_lists
              SET is_reserve = FALSE,
                  reserve_position = NULL,
                  display_order = $3
            WHERE event_id = $1 AND competitor_id = $2`,
          [eventId, competitorId, targetOrder],
        );

        // Audit trail — replacements are evidentiary; the
        // operator may need to defend why a reserve dived
        // ahead of someone else later.
        await recordAudit(client, {
          ...auditFromReq(req),
          org_id:      req.user.org_id,
          entity_type: "event",
          entity_id:   eventId,
          entity_name: null,
          action:      replaces_competitor_id ? "reserve.replaced_diver" : "reserve.promoted",
          metadata: {
            reserve_competitor_id: competitorId,
            replaces_competitor_id: replaces_competitor_id || null,
            replaced_name: replacedName,
            display_order: targetOrder,
          },
        });

        await client.query("COMMIT");
        res.json({
          promoted: true,
          display_order: targetOrder,
          replaced_competitor_id: replaces_competitor_id || null,
          replaced_name: replacedName,
        });
      } catch (err) {
        await client.query("ROLLBACK");
        console.error("[Promote Reserve Error]", err.message);
        res.status(500).json({ error: "Internal server error" });
      } finally {
        client.release();
      }
    },
  );

  return router;
};
