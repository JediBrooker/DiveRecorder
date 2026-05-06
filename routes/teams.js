// Team routes — the parallel grouping to clubs, used for FINA
// Team Event entries. A diver can belong to multiple teams over
// time; a team enrols in events via event_teams.
//
//   GET    /api/orgs/:id/teams                              list with member counts
//   POST   /api/orgs/:id/teams                              create
//   PUT    /api/teams/:id                                   rename / re-code
//   DELETE /api/teams/:id                                   non-destructive
//   GET    /api/teams/:id/events                            events the team is in
//   POST   /api/teams/:teamId/dive-lists                    bulk dive list
//   GET    /api/teams/:teamId/events/:eventId/dive-list     read for editor
//   GET    /api/teams/:id/members                           list members
//   POST   /api/teams/:id/members                           add member
//   DELETE /api/teams/:id/members/:userId                   remove member
//   GET    /api/events/:id/teams                            teams in an event
//   POST   /api/events/:id/teams                            enrol team
//   DELETE /api/events/:id/teams/:teamId                    detach
//
// Mounted via:
//   app.use(require('./routes/teams')({ … }))

const express = require("express");

module.exports = function createTeamsRouter({
  pool,
  requireMeetEditor,
  requireEventManager,
  bulkWriteLimiter,
  ensureEventOrgGate,
  isInSameOrg,
  loadEventForEntries,
}) {
  if (!pool) throw new Error("createTeamsRouter requires { pool, … }");
  const router = express.Router();

  // Teams in an org with member counts.
  router.get("/api/orgs/:id/teams", requireMeetEditor, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot list teams in other organisations" });
    }
    try {
      const r = await pool.query(
        `SELECT t.id, t.name, t.short_code, t.created_at,
                COALESCE(stat.member_count, 0)::int AS member_count
         FROM teams t
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS member_count FROM team_members WHERE team_id = t.id
         ) stat ON true
         WHERE t.org_id = $1
         ORDER BY t.name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Teams List Error]", err.message);
      res.status(500).json([]);
    }
  });

  router.post("/api/orgs/:id/teams", requireMeetEditor, async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot create teams in other organisations" });
    }
    const { name, short_code } = req.body || {};
    if (!name || !name.trim())
      return res.status(400).json({ error: "Team name is required" });
    try {
      const r = await pool.query(
        `INSERT INTO teams (org_id, name, short_code)
         VALUES ($1, $2, $3)
         RETURNING id, name, short_code`,
        [req.params.id, name.trim(), short_code?.trim() || null],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Create Team Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/teams/:id", requireMeetEditor, async (req, res) => {
    const { name, short_code } = req.body || {};
    if (!name || !name.trim())
      return res.status(400).json({ error: "Team name is required" });
    try {
      const target = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot edit teams in other organisations" });
      }
      const r = await pool.query(
        `UPDATE teams SET name = $1, short_code = $2 WHERE id = $3
         RETURNING id, name, short_code`,
        [name.trim(), short_code?.trim() || null, req.params.id],
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Team Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete("/api/teams/:id", requireMeetEditor, async (req, res) => {
    try {
      const target = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot delete teams in other organisations" });
      }
      // Impact summary before deletion so the client can show
      // what it just severed.
      const impact = await pool.query(
        `SELECT
           (SELECT COUNT(*)::int FROM team_members WHERE team_id = $1) AS members,
           (SELECT COUNT(*)::int FROM event_teams  WHERE team_id = $1) AS events,
           (SELECT COUNT(*)::int FROM competitor_dive_lists WHERE team_id = $1) AS dives`,
        [req.params.id],
      );
      await pool.query("DELETE FROM teams WHERE id = $1", [req.params.id]);
      res.json({
        message: "Team deleted",
        ...impact.rows[0],
      });
    } catch (err) {
      console.error("[Delete Team Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Events the team is currently entered in — drives the "Edit
  // dive list" links inside the TeamsView drawer.
  router.get("/api/teams/:id/events", requireMeetEditor, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT e.id, e.name, e.gender, e.height, e.event_type::text AS event_type,
                e.total_rounds, e.number_of_judges, e.status,
                et.added_at
         FROM event_teams et
         JOIN events e ON e.id = et.event_id
         WHERE et.team_id = $1
         ORDER BY e.created_at DESC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json([]);
    }
  });

  // Bulk-set a team's dive list for one event. Each row can be
  // individual (no partner_id) or synchro (partner_id pointing at
  // another team member). Replaces any existing rows for that
  // (team, event) pair.
  router.post(
    "/api/teams/:teamId/dive-lists",
    bulkWriteLimiter,
    requireMeetEditor,
    async (req, res) => {
      const { event_id, dives } = req.body || {};
      if (!event_id || !Array.isArray(dives) || !dives.length) {
        return res.status(400).json({ error: "event_id and dives[] required" });
      }
      const client = await pool.connect();
      try {
        const target = await client.query(
          "SELECT org_id FROM teams WHERE id = $1",
          [req.params.teamId],
        );
        if (!target.rows.length)
          return res.status(404).json({ error: "Team not found" });
        if (
          !req.user.is_system_admin &&
          target.rows[0].org_id !== req.user.org_id
        ) {
          return res
            .status(403)
            .json({ error: "Cannot manage teams in other organisations" });
        }

        // Gate on event lifecycle / entries deadline. Same rule as the
        // individual-diver submit endpoint: once the event has gone
        // Live or the manager-set deadline has passed, the team's
        // dive list is locked. Late additions go through the
        // controller's late-entry feature instead.
        const gate = await loadEventForEntries(client, event_id);
        if (gate.error) {
          return res.status(gate.status).json({ error: gate.error });
        }

        // All competitor_id and partner_id values must belong to
        // this team. Pull the membership once.
        const m = await client.query(
          "SELECT user_id FROM team_members WHERE team_id = $1",
          [req.params.teamId],
        );
        const memberIds = new Set(m.rows.map((row) => row.user_id));
        for (const d of dives) {
          if (!d.competitor_id || !memberIds.has(d.competitor_id)) {
            return res
              .status(400)
              .json({ error: "Every dive must be assigned to a team member" });
          }
          if (d.partner_id && !memberIds.has(d.partner_id)) {
            return res
              .status(400)
              .json({ error: "Synchro partners must also be team members" });
          }
          if (d.partner_id && d.partner_id === d.competitor_id) {
            return res
              .status(400)
              .json({ error: "A diver can't pair with themselves" });
          }
          if (!d.dive_id || !d.round_number) {
            return res
              .status(400)
              .json({ error: "Each dive needs a dive_id and round_number" });
          }
        }

        await client.query("BEGIN");
        // Replace existing rows for this (team, event)
        await client.query(
          `DELETE FROM competitor_dive_lists
           WHERE team_id = $1 AND event_id = $2`,
          [req.params.teamId, event_id],
        );
        for (const d of dives) {
          await client.query(
            `INSERT INTO competitor_dive_lists
               (event_id, competitor_id, partner_id, team_id, dive_id, round_number)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [
              event_id,
              d.competitor_id,
              d.partner_id || null,
              req.params.teamId,
              d.dive_id,
              d.round_number,
            ],
          );
        }
        // Make sure the team is enrolled in the event
        await client.query(
          `INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [event_id, req.params.teamId],
        );
        await client.query("COMMIT");
        res.json({ message: "Team dive list saved", count: dives.length });
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        console.error("[Team Dive List Error]", err.message);
        res.status(500).json({ error: err.detail || err.message });
      } finally {
        client.release();
      }
    },
  );

  // Read the current team dive list for one event so the editor
  // can pre-populate.
  router.get(
    "/api/teams/:teamId/events/:eventId/dive-list",
    requireMeetEditor,
    async (req, res) => {
      try {
        const r = await pool.query(
          `SELECT cdl.round_number, cdl.competitor_id, cdl.partner_id, cdl.dive_id,
                  u.full_name AS competitor_name,
                  pu.full_name AS partner_name,
                  d.dive_code, d.position, d.height, d.dd, d.description
           FROM competitor_dive_lists cdl
           JOIN users u ON u.id = cdl.competitor_id
           LEFT JOIN users pu ON pu.id = cdl.partner_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.team_id = $1 AND cdl.event_id = $2
           ORDER BY cdl.round_number ASC`,
          [req.params.teamId, req.params.eventId],
        );
        res.json(r.rows);
      } catch (err) {
        res.status(500).json([]);
      }
    },
  );

  router.get("/api/teams/:id/members", requireMeetEditor, async (req, res) => {
    try {
      const target = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot view teams in other organisations" });
      }
      const r = await pool.query(
        `SELECT u.id, u.username, u.full_name, tm.added_at
         FROM team_members tm
         JOIN users u ON u.id = tm.user_id
         WHERE tm.team_id = $1
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json([]);
    }
  });

  router.post("/api/teams/:id/members", requireMeetEditor, async (req, res) => {
    const { user_id } = req.body || {};
    try {
      const target = await pool.query(
        "SELECT org_id FROM teams WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Team not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot modify teams in other organisations" });
      }
      // Member must be a user in the same org as the team
      const u = await pool.query(
        "SELECT 1 FROM users WHERE id = $1 AND org_id = $2",
        [user_id, target.rows[0].org_id],
      );
      if (!u.rows.length)
        return res
          .status(400)
          .json({ error: "User must belong to the team's organisation" });
      await pool.query(
        `INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, user_id],
      );
      res.json({ message: "Member added" });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.delete(
    "/api/teams/:id/members/:userId",
    requireMeetEditor,
    async (req, res) => {
      try {
        const target = await pool.query(
          "SELECT org_id FROM teams WHERE id = $1",
          [req.params.id],
        );
        if (!target.rows.length)
          return res.status(404).json({ error: "Team not found" });
        if (
          !req.user.is_system_admin &&
          target.rows[0].org_id !== req.user.org_id
        ) {
          return res
            .status(403)
            .json({ error: "Cannot modify teams in other organisations" });
        }
        await pool.query(
          "DELETE FROM team_members WHERE team_id = $1 AND user_id = $2",
          [req.params.id, req.params.userId],
        );
        res.json({ message: "Member removed" });
      } catch (err) {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  // -------- Teams ↔ Events --------
  router.get("/api/events/:id/teams", requireMeetEditor, async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT t.id, t.name, t.short_code, et.added_at
         FROM event_teams et
         JOIN teams t ON t.id = et.team_id
         WHERE et.event_id = $1
         ORDER BY t.name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json([]);
    }
  });

  router.post("/api/events/:id/teams", requireEventManager(), async (req, res) => {
    const { team_id } = req.body || {};
    try {
      if (!(await isInSameOrg(pool, req.event.org_id, team_id, "teams"))) {
        return res.status(400).json({ error: "Team is not in this event's organisation" });
      }
      await pool.query(
        `INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, team_id],
      );
      res.json({ message: "Team added to event" });
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Remove a team from an event. Doesn't touch competitor_dive_lists
  // — the FK is ON DELETE SET NULL so historical dives stay; the
  // team just isn't an active enrolment any more.
  router.delete(
    "/api/events/:id/teams/:teamId",
    requireEventManager(),
    async (req, res) => {
      try {
        await pool.query(
          "DELETE FROM event_teams WHERE event_id = $1 AND team_id = $2",
          [req.params.id, req.params.teamId],
        );
        res.json({ message: "Team removed from event" });
      } catch (err) {
        res.status(500).json({ error: "Internal server error" });
      }
    },
  );

  return router;
};
