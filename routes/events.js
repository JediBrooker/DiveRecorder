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

module.exports = function createEventsRouter({
  pool,
  JWT_SECRET,
  requireOrgAdmin,
  requireEventManager,
  sendEventStartedEmails,
  sendEventResultsEmails,
  activeDivers,
  meetHolds,
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
      const SELECT = `
        SELECT e.*, o.name AS org_name, o.country_code, o.slug AS org_slug
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
          result = await pool.query(
            `${SELECT} WHERE e.org_id = $1 ORDER BY e.created_at DESC`,
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
    } = req.body || {};

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
            enforce_referee_signoff, is_mixed_height)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          name,
          gender,
          age_group || null,
          number_of_judges || 5,
          total_rounds || 6,
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
        ],
      );
      const event = evRes.rows[0];
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
    try {
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
      const r = await pool.query(
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
           is_mixed_height         = CASE WHEN $21::boolean THEN is_mixed_height         ELSE $22::boolean END
         WHERE id=$16 AND ($17::boolean OR org_id=$18) RETURNING *`,
        [
          name || null,
          gender || null,
          number_of_judges || null,
          total_rounds || null,
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
        ],
      );
      if (!r.rows.length)
        return res.status(404).json({ error: "Event not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Event Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
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
      // would otherwise accumulate as meets pile up.
      if (status === "Completed") {
        delete activeDivers[r.rows[0].id];
        delete meetHolds[r.rows[0].id];
      }

      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Status Update Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
