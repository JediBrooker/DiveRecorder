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

  // Public read — the meet's public landing page wants to render
  // "participating: AUS / NZL / FIJ" badges, so this endpoint is
  // open to anonymous spectators (consistent with /api/events
  // listing live + completed publicly).
  router.get("/api/events/:id/participating-orgs", async (req, res) => {
    try {
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
        "SELECT id, org_id, name FROM events WHERE id = $1",
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
          const admins = await pool.query(
            `SELECT u.id
               FROM users u
               JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id
              WHERE u.org_id = $1 AND r.role = 'org_admin'`,
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
      const ev = await pool.query(
        "SELECT id, org_id, name FROM events WHERE id = $1",
        [req.params.id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const isSysAdmin = !!req.user.is_system_admin;
      const isHostAdmin = ev.rows[0].org_id === req.user.org_id;
      const isSelfWithdraw = req.params.org_id === req.user.org_id;
      if (!isSysAdmin && !isHostAdmin && !isSelfWithdraw) {
        return res.status(403).json({
          error: "Only the host federation can remove other federations, and only the visiting federation can withdraw itself",
        });
      }
      const r = await pool.query(
        "DELETE FROM event_participating_orgs WHERE event_id = $1 AND org_id = $2 RETURNING org_id",
        [req.params.id, req.params.org_id],
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
            participating_org_id: req.params.org_id,
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
          const hostAdmins = await pool.query(
            `SELECT u.id
               FROM users u
               JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id
              WHERE u.org_id = $1 AND r.role = 'org_admin'`,
            [ev.rows[0].org_id],
          );
          const adminIds = hostAdmins.rows.map(r => r.id);
          if (adminIds.length) {
            const leavingOrg = await pool.query(
              "SELECT name FROM organisations WHERE id = $1",
              [req.params.org_id],
            );
            await push.sendNotification(adminIds, {
              category:  "international_invite",
              title:     `${leavingOrg.rows[0]?.name || "A federation"} withdrew from "${ev.rows[0].name}"`,
              body:      "Their divers will no longer be able to enter new dive lists. Existing entries stay intact.",
              data:      { event_id: ev.rows[0].id, withdrawing_org_id: req.params.org_id },
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
  // /api/orgs/:id/divers endpoint. Authenticated; org-scoping
  // happens via the JOIN against event_participating_orgs.
  router.get("/api/events/:id/eligible-divers", verifyToken, async (req, res) => {
    try {
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

  return router;
};
