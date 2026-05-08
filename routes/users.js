// User & role management routes.
//
//   GET  /api/users                  list (org_admin within org;
//                                    sysadmin sees every org)
//   PUT  /api/users/:id/roles        replace user's role set
//                                    (atomically diffs + audits)
//   GET  /api/role-requests          pending requests
//   POST /api/role-requests/:id/review  approve / reject
//   PUT  /api/users/:id/club         self-clear OR admin-set club
//   GET  /api/users/:id/role-audit   per-user audit history
//   GET  /api/judges                 list judges in caller's org
//
// Both writes that change a user's privilege set call
// bumpTokenVersion inside the same transaction so a rollback
// rolls back the bump too — the freshly-revoked role takes effect
// on the user's next request without waiting for their JWT to
// expire (Migration 021).
//
// Mounted via:
//   app.use(require('./routes/users')({ … }))

const express = require("express");

// Enum values from init.sql's CREATE TYPE org_role. system_admin
// is intentionally NOT in this set — it's a column on users, not
// a role assignable here. Keeping this in sync with init.sql is
// flagged in AGENTS.md.
const VALID_ORG_ROLES = new Set([
  "org_admin", "meet_manager", "referee",
  "judge", "diver", "coach", "spectator",
]);

module.exports = function createUsersRouter({
  pool,
  verifyToken,
  requireOrgAdmin,
  requireMeetEditor,
  bumpTokenVersion,
  sendRoleDecisionEmail,
}) {
  if (!pool) throw new Error("createUsersRouter requires { pool, … }");
  const router = express.Router();

  router.get("/api/users", requireOrgAdmin, async (req, res) => {
    try {
      // System admins see every user across every org; org_admins
      // see only their own org. Org name + country code are
      // returned so the system-admin UI can group/filter by org.
      //
      // r.role is the org_role enum. node-postgres only auto-parses
      // arrays of built-in types, so we cast each role to text to
      // get a real string[] back instead of a raw "{judge,...}"
      // string the frontend would silently mishandle.
      const isSysAdmin = !!req.user.is_system_admin;
      const r = await pool.query(
        `SELECT u.id, u.username, u.full_name, u.is_system_admin,
                u.org_id,  o.name AS org_name,  o.country_code, o.slug AS org_slug,
                u.club_id, c.name AS club_name, c.short_code AS club_code,
                COALESCE(
                  ARRAY_AGG(r.role::text ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL),
                  ARRAY[]::text[]
                ) AS org_roles
         FROM users u
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs c ON c.id = u.club_id
         LEFT JOIN user_org_roles r ON u.id = r.user_id AND r.org_id = u.org_id
         WHERE ($2::boolean OR u.org_id = $1)
         GROUP BY u.id, u.username, u.full_name, u.is_system_admin,
                  u.org_id, o.name, o.country_code, o.slug,
                  u.club_id, c.name, c.short_code
         ORDER BY o.name ASC, u.full_name ASC`,
        [req.user.org_id, isSysAdmin],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Users List Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.put("/api/users/:id/roles", requireOrgAdmin, async (req, res) => {
    const { roles } = req.body || {};
    // Validate up front: roles must be an array of strings, every
    // element must be a known org_role. Without this, a malformed
    // body (string, object, role typo) cascades to a 500 from the
    // INSERT enum cast, which is bad UX and gives an attacker a
    // clean signal that they hit a real endpoint.
    if (!Array.isArray(roles)) {
      return res.status(400).json({ error: "roles must be an array of role strings" });
    }
    const invalid = roles.filter((r) => typeof r !== "string" || !VALID_ORG_ROLES.has(r));
    if (invalid.length) {
      return res.status(400).json({
        error: `Invalid role(s): ${invalid.join(", ")}. ` +
               `Valid: ${[...VALID_ORG_ROLES].join(", ")}.`,
      });
    }
    const client = await pool.connect();
    try {
      // Apply roles in the target user's own org — not the
      // caller's. For org_admins these match by definition (with
      // a check below); for system_admins editing users across
      // orgs, this is what makes the cross-org case work.
      const target = await client.query(
        "SELECT org_id FROM users WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "User not found" });
      const targetOrgId = target.rows[0].org_id;

      if (!req.user.is_system_admin && targetOrgId !== req.user.org_id) {
        return res
          .status(403)
          .json({ error: "Cannot modify users in other organisations" });
      }

      await client.query("BEGIN");

      // Diff against existing so the audit log records only the
      // actual grant / revoke events (not the full delete + insert).
      const existing = await client.query(
        "SELECT role::text FROM user_org_roles WHERE user_id = $1 AND org_id = $2",
        [req.params.id, targetOrgId],
      );
      const before = new Set(existing.rows.map((row) => row.role));
      const after = new Set(roles);
      const granted = roles.filter((r) => !before.has(r));
      const revoked = [...before].filter((r) => !after.has(r));

      await client.query(
        "DELETE FROM user_org_roles WHERE user_id = $1 AND org_id = $2",
        [req.params.id, targetOrgId],
      );
      for (const role of roles) {
        await client.query(
          "INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1,$2,$3,$4)",
          [req.params.id, targetOrgId, role, req.user.id],
        );
      }

      // Best-effort audit writes — same pattern as the score
      // audit log: don't let an audit failure roll back the
      // legitimate role change (e.g. before the migration ran).
      try {
        for (const role of granted) {
          await client.query(
            `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id)
             VALUES ($1, $2, $3, 'granted', $4)`,
            [req.params.id, targetOrgId, role, req.user.id],
          );
        }
        for (const role of revoked) {
          await client.query(
            `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id)
             VALUES ($1, $2, $3, 'revoked', $4)`,
            [req.params.id, targetOrgId, role, req.user.id],
          );
        }
      } catch (auditErr) {
        console.error("[Role Audit Skipped]", auditErr.message);
      }

      // Invalidate the target user's existing JWTs (Migration 021).
      // Granting OR revoking changes the privilege set, so the
      // currently-circulating token is no longer accurate. The
      // helper bumps users.token_version + clears the in-memory
      // cache; the next request from any of their devices forces
      // a fresh login.
      if (granted.length > 0 || revoked.length > 0) {
        await bumpTokenVersion(client, req.params.id);
      }

      await client.query("COMMIT");
      res.json({ message: "Roles updated" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Role Update Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  router.get("/api/role-requests", requireOrgAdmin, async (req, res) => {
    try {
      const isSysAdmin = !!req.user.is_system_admin;
      const r = await pool.query(
        `SELECT rr.id, rr.requested_role, rr.status, rr.note, rr.created_at,
                rr.org_id, o.name AS org_name, o.country_code,
                u.id AS user_id, u.username, u.full_name
         FROM role_requests rr
         JOIN users u ON rr.user_id = u.id
         JOIN organisations o ON rr.org_id = o.id
         WHERE rr.status = 'pending' AND ($2::boolean OR rr.org_id = $1)
         ORDER BY o.name ASC, rr.created_at ASC`,
        [req.user.org_id, isSysAdmin],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  router.post("/api/role-requests/:id/review", requireOrgAdmin, async (req, res) => {
    const { decision } = req.body || {}; // 'approved' | 'rejected'
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Match by id only; verify the caller can act on this
      // request after we know which org it belongs to. Granting
      // the role uses rq.org_id, not the caller's org_id, so
      // system admins approving cross-org requests work too.
      const rqRes = await client.query(
        "SELECT * FROM role_requests WHERE id = $1 AND status = 'pending'",
        [req.params.id],
      );
      if (!rqRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Request not found" });
      }
      const rq = rqRes.rows[0];

      if (!req.user.is_system_admin && rq.org_id !== req.user.org_id) {
        await client.query("ROLLBACK");
        return res
          .status(403)
          .json({ error: "Cannot review requests in other organisations" });
      }

      await client.query(
        "UPDATE role_requests SET status=$1, reviewed_by=$2, reviewed_at=now() WHERE id=$3",
        [decision, req.user.id, req.params.id],
      );

      if (decision === "approved") {
        await client.query(
          "INSERT INTO user_org_roles (user_id, org_id, role, granted_by) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
          [rq.user_id, rq.org_id, rq.requested_role, req.user.id],
        );
        try {
          await client.query(
            `INSERT INTO role_audit_log (user_id, org_id, role, action, actor_id, note)
             VALUES ($1, $2, $3, 'granted', $4, $5)`,
            [
              rq.user_id,
              rq.org_id,
              rq.requested_role,
              req.user.id,
              "approved from role request",
            ],
          );
        } catch (auditErr) {
          console.error("[Role Audit Skipped]", auditErr.message);
        }
        // Bump token_version so the freshly-granted role takes
        // effect on the user's next request without waiting for
        // their current JWT to expire.
        await bumpTokenVersion(client, rq.user_id);
      }

      await client.query("COMMIT");
      sendRoleDecisionEmail(rq.user_id, decision, rq.requested_role);
      res.json({ message: `Request ${decision}` });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Review Request Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    } finally {
      client.release();
    }
  });

  // Update a user's club. Two flows allowed:
  //   * Self-edit can ONLY clear the club. A club is meaningful for
  //     visibility scoping (rosters, coach links), so a malicious
  //     diver self-assigning into a rival club would be a tenancy
  //     gap. Switching club is org_admin-only.
  //   * Admin (org_admin in target's org / system_admin) can set or
  //     clear any user's club to one in the target's own org.
  router.put("/api/users/:id/club", verifyToken, async (req, res) => {
    const targetId = req.params.id;
    const { club_id } = req.body || {};
    try {
      const target = await pool.query(
        "SELECT org_id FROM users WHERE id = $1",
        [targetId],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "User not found" });
      const targetOrgId = target.rows[0].org_id;

      const isSelf = req.user.id === targetId;
      const orgRoles = req.user.org_roles || [];
      const isAdmin =
        req.user.is_system_admin ||
        (orgRoles.includes("org_admin") && targetOrgId === req.user.org_id);

      if (!isSelf && !isAdmin) {
        return res
          .status(403)
          .json({ error: "Cannot change another user's club" });
      }
      // Migration 021: tighten self-edit. Diver can drop their club
      // (e.g. they left it) but can't move into a different one
      // without an admin signing off — otherwise a roster of "Club
      // Foo divers" can be polluted by anyone in the org.
      if (isSelf && !isAdmin && club_id) {
        return res.status(403).json({
          error: "Switching clubs requires an org admin. You can clear your club yourself.",
        });
      }

      // Only allow assigning a club that belongs to the target's
      // org. Empty/null clears the club.
      if (club_id) {
        const club = await pool.query(
          "SELECT id FROM clubs WHERE id = $1 AND org_id = $2",
          [club_id, targetOrgId],
        );
        if (!club.rows.length)
          return res
            .status(400)
            .json({ error: "Club not in your organisation" });
      }

      await pool.query("UPDATE users SET club_id = $1 WHERE id = $2", [
        club_id || null,
        targetId,
      ]);
      res.json({ message: "Club updated" });
    } catch (err) {
      console.error("[Update Club Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Per-user role audit history. Visible to org_admin within the
  // user's own org, or to system_admin across all orgs.
  router.get("/api/users/:id/role-audit", requireOrgAdmin, async (req, res) => {
    try {
      const target = await pool.query(
        "SELECT org_id FROM users WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "User not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot view users in other organisations" });
      }

      const r = await pool.query(
        `SELECT a.id,
                a.role::text   AS role,
                a.action::text AS action,
                a.note,
                a.created_at,
                a.actor_id,
                actor.full_name AS actor_name,
                actor.username  AS actor_username
         FROM role_audit_log a
         LEFT JOIN users actor ON actor.id = a.actor_id
         WHERE a.user_id = $1
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 200`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Role Audit Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // Judges within the current user's org. Drop username — the
  // judge picker uses id + full_name; username is the credential
  // identifier and the meet_manager-gate isn't a high enough bar
  // to justify spraying it across every responder.
  router.get("/api/judges", requireMeetEditor, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name
         FROM users u
         JOIN user_org_roles r ON u.id = r.user_id
         WHERE r.org_id = $1 AND r.role = 'judge'
         ORDER BY u.full_name ASC`,
        [req.user.org_id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: "Internal server error" });
    }
  });

  return router;
};
