// =============================================================
// DIVING APP — SERVER v2
// Express + Socket.IO + PostgreSQL
// Multi-tenant RBAC with org-scoped roles
// =============================================================

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
require("dotenv").config();

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

app.use(cors({ origin: CORS_ORIGIN }));
app.use(express.json());

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: "Too many attempts, please try again in 15 minutes." },
});

// =============================================================
// EMAIL
// =============================================================

const mailer = process.env.SMTP_HOST
  ? nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === "true",
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  : null;

async function sendRoleDecisionEmail(userId, decision, role) {
  if (!mailer) return;
  try {
    const u = await pool.query("SELECT email, full_name FROM users WHERE id = $1", [userId]);
    const user = u.rows[0];
    if (!user?.email) return;
    const subject = decision === "approved"
      ? `Your ${role} role has been approved`
      : `Your ${role} role request was not approved`;
    const text = decision === "approved"
      ? `Hi ${user.full_name},\n\nYour request for the "${role}" role has been approved. You can now sign in and access the ${role} area.\n\nDive Recorder`
      : `Hi ${user.full_name},\n\nYour request for the "${role}" role was not approved. Please contact your organisation admin if you have questions.\n\nDive Recorder`;
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject,
      text,
    });
  } catch (err) {
    console.error("[Email Error]", err.message);
  }
}

// Serve the built Vue app (run `npm run build` before starting the server)
app.use(express.static(path.join(__dirname, 'dist')))

const pool = new Pool({
  user: process.env.DB_USER,
  host: process.env.DB_HOST,
  database: process.env.DB_DATABASE,
  password: process.env.DB_PASSWORD,
  port: process.env.DB_PORT,
});

const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret_in_production";
const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

// =============================================================
// MIDDLEWARE
// =============================================================

// Decodes JWT and attaches req.user. Does not enforce roles.
const verifyToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];
  if (!token) return res.status(403).json({ error: "No token provided" });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(401).json({ error: "Invalid or expired token" });
    req.user = decoded;
    next();
  });
};

// Ensures the user holds at least one of the given org-level roles.
// system_admin always passes.
const requireOrgRole =
  (roles = []) =>
  (req, res, next) => {
    verifyToken(req, res, () => {
      if (req.user.is_system_admin) return next();
      const userRoles = req.user.org_roles || [];
      const ok = roles.length === 0 || roles.some((r) => userRoles.includes(r));
      if (!ok) return res.status(403).json({ error: "Insufficient role" });
      next();
    });
  };

// Ensures the user is in event_managers for the event.
// org_admin and system_admin always pass.
const requireEventManager = () => async (req, res, next) => {
  verifyToken(req, res, async () => {
    try {
      if (req.user.is_system_admin) return next();
      const orgRoles = req.user.org_roles || [];
      if (orgRoles.includes("org_admin")) return next();

      const eventId = req.params.id || req.body.eventId;
      if (!eventId) return res.status(400).json({ error: "Event ID required" });

      const result = await pool.query(
        "SELECT 1 FROM event_managers WHERE event_id = $1 AND user_id = $2",
        [eventId, req.user.id],
      );
      if (result.rows.length === 0)
        return res
          .status(403)
          .json({ error: "You are not a manager of this event" });
      next();
    } catch (err) {
      console.error("[requireEventManager]", err.message);
      res.status(500).json({ error: "Server error during authorisation" });
    }
  });
};

const requireSystemAdmin = (req, res, next) =>
  verifyToken(req, res, () => {
    if (!req.user.is_system_admin)
      return res.status(403).json({ error: "System admin access required" });
    next();
  });

// =============================================================
// HELPER — Build JWT payload
// =============================================================
async function buildTokenPayload(userId) {
  const u = await pool.query(
    "SELECT id, username, full_name, org_id, is_system_admin FROM users WHERE id = $1",
    [userId],
  );
  if (!u.rows.length) throw new Error("User not found");
  const user = u.rows[0];

  const r = await pool.query(
    "SELECT role FROM user_org_roles WHERE user_id = $1 AND org_id = $2",
    [user.id, user.org_id],
  );
  return {
    id: user.id,
    username: user.username,
    full_name: user.full_name,
    org_id: user.org_id,
    org_roles: r.rows.map((x) => x.role),
    is_system_admin: user.is_system_admin,
  };
}

// =============================================================
// AUTH ROUTES
// =============================================================

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: "Invalid username or password" });

    const payload = await buildTokenPayload(user.id);
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
    res.json({ token, ...payload });
  } catch (err) {
    console.error("[Login Error]", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

// Self-register as a user within an existing org
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const {
    username, password, full_name, org_id, requested_role, note,
    club_id, new_club_name, new_club_short_code,
  } = req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const org = await client.query(
      "SELECT id FROM organisations WHERE id = $1 AND status = 'active'",
      [org_id],
    );
    if (!org.rows.length) {
      await client.query("ROLLBACK");
      return res
        .status(400)
        .json({ error: "Organisation not found or not yet active" });
    }

    // Resolve the user's club for this org. Either pick an
    // existing one, create a new one, or skip (NULL — independent
    // diver).
    let resolvedClubId = null;
    if (club_id) {
      const club = await client.query(
        "SELECT id FROM clubs WHERE id = $1 AND org_id = $2",
        [club_id, org_id],
      );
      if (!club.rows.length) {
        await client.query("ROLLBACK");
        return res
          .status(400)
          .json({ error: "Selected club doesn't belong to that organisation" });
      }
      resolvedClubId = club_id;
    } else if (new_club_name && new_club_name.trim()) {
      const cnew = await client.query(
        `INSERT INTO clubs (org_id, name, short_code)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [org_id, new_club_name.trim(), new_club_short_code?.trim() || null],
      );
      resolvedClubId = cnew.rows[0].id;
    }

    const hash = await bcrypt.hash(password, 12);
    const uRes = await client.query(
      "INSERT INTO users (username, password, full_name, org_id, club_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
      [username, hash, full_name, org_id, resolvedClubId],
    );
    const userId = uRes.rows[0].id;

    // Everyone starts as spectator
    await client.query(
      "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'spectator')",
      [userId, org_id],
    );

    // Optional role request
    const validRoles = ["meet_manager", "referee", "judge", "diver"];
    if (requested_role && validRoles.includes(requested_role)) {
      await client.query(
        "INSERT INTO role_requests (user_id, org_id, requested_role, note) VALUES ($1,$2,$3,$4)",
        [userId, org_id, requested_role, note || null],
      );
    }

    await client.query("COMMIT");
    res
      .status(201)
      .json({
        message:
          "Registration successful. Your role request is pending approval.",
      });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Register Error]", err.message);
    res.status(500).json({ error: err.detail || "Registration failed" });
  } finally {
    client.release();
  }
});

// Register a new organisation + its founding org_admin
app.post("/api/auth/register-org", authLimiter, async (req, res) => {
  const { org_name, country_code, slug, username, password, full_name } =
    req.body;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const orgRes = await client.query(
      "INSERT INTO organisations (name, country_code, slug, status) VALUES ($1,$2,$3,'pending') RETURNING id",
      [org_name, country_code || null, slug],
    );
    const orgId = orgRes.rows[0].id;

    const hash = await bcrypt.hash(password, 12);
    const uRes = await client.query(
      "INSERT INTO users (username, password, full_name, org_id) VALUES ($1,$2,$3,$4) RETURNING id",
      [username, hash, full_name, orgId],
    );
    const userId = uRes.rows[0].id;

    await client.query(
      "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'org_admin')",
      [userId, orgId],
    );

    await client.query("COMMIT");
    res
      .status(201)
      .json({
        message: "Organisation registered and pending approval.",
        org_id: orgId,
      });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Register Org Error]", err.message);
    if (err.constraint === "organisations_slug_key")
      return res
        .status(400)
        .json({ error: "That organisation slug is already taken" });
    res
      .status(500)
      .json({ error: err.detail || "Organisation registration failed" });
  } finally {
    client.release();
  }
});

// =============================================================
// ORGANISATION ROUTES
// =============================================================

app.get("/api/orgs", requireSystemAdmin, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM organisations ORDER BY created_at DESC",
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List active orgs — used by register form to populate the org picker
app.get("/api/orgs/active", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT id, name, country_code, slug FROM organisations WHERE status = 'active' ORDER BY name ASC",
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/orgs/:id/status", requireSystemAdmin, async (req, res) => {
  const { status } = req.body;
  try {
    const r = await pool.query(
      "UPDATE organisations SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id],
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// TEAMS
// =============================================================

// Teams in an org with member counts. Auth required, org_admin
// or meet_manager only.
app.get(
  "/api/orgs/:id/teams",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
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
  },
);

app.post(
  "/api/orgs/:id/teams",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot create teams in other organisations" });
    }
    const { name, short_code } = req.body;
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
      res.status(500).json({ error: err.message });
    }
  },
);

app.put(
  "/api/teams/:id",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const { name, short_code } = req.body;
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
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete(
  "/api/teams/:id",
  requireOrgRole(["org_admin", "meet_manager"]),
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
      res.status(500).json({ error: err.message });
    }
  },
);

// Events the team is currently entered in — drives the "Edit
// dive list" links inside the TeamsView drawer.
app.get(
  "/api/teams/:id/events",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
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
  },
);

// Bulk-set a team's dive list for one event. Each row can be
// individual (no partner_id) or synchro (partner_id pointing at
// another team member). Replaces any existing rows for that
// (team, event) pair.
app.post(
  "/api/teams/:teamId/dive-lists",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const { event_id, dives } = req.body;
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
app.get(
  "/api/teams/:teamId/events/:eventId/dive-list",
  requireOrgRole(["org_admin", "meet_manager"]),
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

app.get(
  "/api/teams/:id/members",
  requireOrgRole(["org_admin", "meet_manager"]),
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
  },
);

app.post(
  "/api/teams/:id/members",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const { user_id } = req.body;
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
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete(
  "/api/teams/:id/members/:userId",
  requireOrgRole(["org_admin", "meet_manager"]),
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
      res.status(500).json({ error: err.message });
    }
  },
);

// Teams entered in an event
app.get(
  "/api/events/:id/teams",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
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
  },
);

app.post(
  "/api/events/:id/teams",
  requireEventManager(),
  async (req, res) => {
    const { team_id } = req.body;
    try {
      await pool.query(
        `INSERT INTO event_teams (event_id, team_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [req.params.id, team_id],
      );
      res.json({ message: "Team added to event" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// Divers in an organisation. Authenticated and scoped to the
// caller's own org (system admins see any). Used by the
// CompetitorView's synchro partner picker.
app.get("/api/orgs/:id/divers", verifyToken, async (req, res) => {
  if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
    return res
      .status(403)
      .json({ error: "Cannot list divers in other organisations" });
  }
  try {
    const r = await pool.query(
      `SELECT u.id, u.full_name, u.username, cl.name AS club_name, cl.short_code AS club_code
       FROM users u
       JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
       LEFT JOIN clubs cl ON cl.id = u.club_id
       WHERE u.org_id = $1
       ORDER BY u.full_name ASC`,
      [req.params.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[Org Divers Error]", err.message);
    res.status(500).json([]);
  }
});

// Clubs in an organisation. Public — used by the registration
// form's club picker before the user has an account.
app.get("/api/orgs/:id/clubs", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, short_code
       FROM clubs WHERE org_id = $1
       ORDER BY name ASC`,
      [req.params.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[Org Clubs Error]", err.message);
    res.status(500).json([]);
  }
});

// Listing for the dedicated Clubs management screen. System
// admins see every club across all orgs; org_admin / meet_manager
// see only their own org's. Each row carries a live member count
// so admins can spot empty clubs.
app.get(
  "/api/clubs",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const isSysAdmin = !!req.user.is_system_admin;
      const r = await pool.query(
        `SELECT cl.id, cl.name, cl.short_code, cl.created_at,
                cl.org_id, o.name AS org_name, o.country_code,
                COALESCE(stat.member_count, 0)::int AS member_count
         FROM clubs cl
         JOIN organisations o ON o.id = cl.org_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS member_count
           FROM users WHERE club_id = cl.id
         ) stat ON true
         WHERE ($2::boolean OR cl.org_id = $1)
         ORDER BY o.name ASC, cl.name ASC`,
        [req.user.org_id, isSysAdmin],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Clubs List Error]", err.message);
      res.status(500).json([]);
    }
  },
);

// Rename / re-code a club. Same scope rules as create.
app.put(
  "/api/clubs/:id",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const { name, short_code } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: "Club name is required" });
    try {
      const target = await pool.query(
        "SELECT org_id FROM clubs WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Club not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot edit clubs in other organisations" });
      }
      const r = await pool.query(
        `UPDATE clubs SET name = $1, short_code = $2
         WHERE id = $3
         RETURNING id, name, short_code`,
        [name.trim(), short_code?.trim() || null, req.params.id],
      );
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Club Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Delete a club. users.club_id is ON DELETE SET NULL, so members
// keep their accounts but become "no club" until reassigned. We
// surface the affected member count in the response so the UI
// can confirm what just happened.
app.delete(
  "/api/clubs/:id",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const target = await pool.query(
        "SELECT org_id FROM clubs WHERE id = $1",
        [req.params.id],
      );
      if (!target.rows.length)
        return res.status(404).json({ error: "Club not found" });
      if (
        !req.user.is_system_admin &&
        target.rows[0].org_id !== req.user.org_id
      ) {
        return res
          .status(403)
          .json({ error: "Cannot delete clubs in other organisations" });
      }
      const memberCount = await pool.query(
        "SELECT COUNT(*)::int AS n FROM users WHERE club_id = $1",
        [req.params.id],
      );
      await pool.query("DELETE FROM clubs WHERE id = $1", [req.params.id]);
      res.json({
        message: "Club deleted",
        unassigned_members: memberCount.rows[0].n,
      });
    } catch (err) {
      console.error("[Delete Club Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Create a club in an organisation. Authenticated org_admin or
// meet_manager (or system_admin) only — keeps spam off the table.
// During registration, /api/auth/register has its own path that
// can create a club for the new user without prior auth.
app.post(
  "/api/orgs/:id/clubs",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot create clubs in other organisations" });
    }
    const { name, short_code } = req.body;
    if (!name || !name.trim())
      return res.status(400).json({ error: "Club name is required" });
    try {
      const r = await pool.query(
        `INSERT INTO clubs (org_id, name, short_code)
         VALUES ($1, $2, $3)
         RETURNING id, name, short_code`,
        [req.params.id, name.trim(), short_code?.trim() || null],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Create Club Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// =============================================================
// USER & ROLE MANAGEMENT ROUTES
// =============================================================

app.get("/api/users", requireOrgRole(["org_admin"]), async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});

app.put(
  "/api/users/:id/roles",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
    const { roles } = req.body;
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

      await client.query("COMMIT");
      res.json({ message: "Roles updated" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Role Update Error]", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  },
);

app.get(
  "/api/role-requests",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
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
      res.status(500).json({ error: err.message });
    }
  },
);

app.post(
  "/api/role-requests/:id/review",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
    const { decision } = req.body; // 'approved' | 'rejected'
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
      }

      await client.query("COMMIT");
      sendRoleDecisionEmail(rq.user_id, decision, rq.requested_role);
      res.json({ message: `Request ${decision}` });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Review Request Error]", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  },
);

// Update a user's club. Self-edit allowed (any logged-in user
// can change their own club to one in their own org, or unset
// it). Admin override (org_admin in target's org / system_admin)
// can change anyone in their org.
app.put("/api/users/:id/club", verifyToken, async (req, res) => {
  const targetId = req.params.id;
  const { club_id } = req.body;
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
    res.status(500).json({ error: err.message });
  }
});

// Per-user role audit history. Visible to org_admin within the
// user's own org, or to system_admin across all orgs.
app.get(
  "/api/users/:id/role-audit",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
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
      res.status(500).json({ error: err.message });
    }
  },
);

// Judges within the current user's org
app.get(
  "/api/judges",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name, u.username
       FROM users u
       JOIN user_org_roles r ON u.id = r.user_id
       WHERE r.org_id = $1 AND r.role = 'judge'
       ORDER BY u.full_name ASC`,
        [req.user.org_id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// =============================================================
// EVENT ROUTES
// =============================================================

app.get("/api/events", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    let result;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        result = await pool.query(
          "SELECT * FROM events WHERE org_id = $1 ORDER BY created_at DESC",
          [decoded.org_id],
        );
      } catch {
        result = await pool.query(
          "SELECT * FROM events WHERE status IN ('Live','Completed') ORDER BY created_at DESC",
        );
      }
    } else {
      result = await pool.query(
        "SELECT * FROM events WHERE status IN ('Live','Completed') ORDER BY created_at DESC",
      );
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/events", requireOrgRole(["org_admin"]), async (req, res) => {
  const { name, gender, number_of_judges, total_rounds, height, event_type } =
    req.body;
  // Synchronised pairs require 9 or 11 judges (the only panel
  // sizes World Aquatics defines exec/sync judge groups for).
  // Reject anything else early so standings later make sense.
  const type = event_type || "individual";
  if (type === "synchro_pair" && ![9, 11].includes(number_of_judges)) {
    return res.status(400).json({
      error: "Synchronised pair events require 9 or 11 judges",
    });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const evRes = await client.query(
      `INSERT INTO events (name, gender, number_of_judges, total_rounds, height, event_type, org_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [
        name,
        gender,
        number_of_judges || 5,
        total_rounds || 6,
        height || null,
        type,
        req.user.org_id,
      ],
    );
    const event = evRes.rows[0];
    // Creator becomes the first event manager automatically
    await client.query(
      "INSERT INTO event_managers (event_id, user_id, added_by) VALUES ($1,$2,$2)",
      [event.id, req.user.id],
    );
    await client.query("COMMIT");
    res.status(201).json(event);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[Create Event Error]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

app.put("/api/events/:id", requireEventManager(), async (req, res) => {
  const { name, gender, number_of_judges, total_rounds, height, event_type } =
    req.body;
  if (event_type === "synchro_pair" && ![9, 11].includes(number_of_judges)) {
    return res.status(400).json({
      error: "Synchronised pair events require 9 or 11 judges",
    });
  }
  try {
    const r = await pool.query(
      `UPDATE events SET name=$1, gender=$2, number_of_judges=$3, total_rounds=$4,
                         height=$5, event_type=COALESCE($6, event_type)
       WHERE id=$7 AND org_id=$8 RETURNING *`,
      [
        name,
        gender,
        number_of_judges,
        total_rounds,
        height || null,
        event_type || null,
        req.params.id,
        req.user.org_id,
      ],
    );
    if (!r.rows.length)
      return res.status(404).json({ error: "Event not found" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("[Update Event Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete(
  "/api/events/:id",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
    try {
      await pool.query("DELETE FROM events WHERE id=$1 AND org_id=$2", [
        req.params.id,
        req.user.org_id,
      ]);
      res.json({ message: "Event deleted" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// Update event status — meet_manager or org_admin only
app.put("/api/events/:id/status", requireEventManager(), async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["Upcoming", "Live", "Completed"];
  if (!validStatuses.includes(status)) {
    return res
      .status(400)
      .json({ error: `Status must be one of: ${validStatuses.join(", ")}` });
  }
  try {
    const r = await pool.query(
      "UPDATE events SET status = $1 WHERE id = $2 AND org_id = $3 RETURNING *",
      [status, req.params.id, req.user.org_id],
    );
    if (!r.rows.length)
      return res.status(404).json({ error: "Event not found" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error("[Status Update Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Event manager management
app.get(
  "/api/events/:id/managers",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id, u.full_name, u.username, em.added_at
       FROM event_managers em JOIN users u ON em.user_id = u.id
       WHERE em.event_id = $1`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post(
  "/api/events/:id/managers",
  requireEventManager(),
  async (req, res) => {
    const { user_id } = req.body;
    try {
      await pool.query(
        "INSERT INTO event_managers (event_id, user_id, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [req.params.id, user_id, req.user.id],
      );
      res.json({ message: "Manager added" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete(
  "/api/events/:id/managers/:userId",
  requireEventManager(),
  async (req, res) => {
    try {
      await pool.query(
        "DELETE FROM event_managers WHERE event_id=$1 AND user_id=$2",
        [req.params.id, req.params.userId],
      );
      res.json({ message: "Manager removed" });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// =============================================================
// JUDGE ASSIGNMENT ROUTES
// =============================================================

app.get(
  "/api/events/:eventId/judges",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT judge_id, judge_number FROM event_judges WHERE event_id = $1 ORDER BY judge_number ASC",
        [req.params.eventId],
      );
      res.json(r.rows); // [{ judge_id, judge_number }, ...]
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post("/api/events/:id/judges", requireEventManager(), async (req, res) => {
  const { judgeIds } = req.body; // ordered array — position = judge number
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM event_judges WHERE event_id = $1", [
      req.params.id,
    ]);
    for (let i = 0; i < judgeIds.length; i++) {
      await client.query(
        "INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1,$2,$3)",
        [req.params.id, judgeIds[i], i + 1], // 1-based judge number
      );
    }
    await client.query("COMMIT");
    res.json({ message: "Judges assigned" });
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Returns this judge's assigned number for a specific event
app.get(
  "/api/events/:eventId/my-judge-number",
  requireOrgRole(["judge"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT judge_number FROM event_judges WHERE event_id = $1 AND judge_id = $2",
        [req.params.eventId, req.user.id],
      );
      if (!r.rows.length)
        return res.status(404).json({ error: "Not assigned to this event" });
      res.json({ judge_number: r.rows[0].judge_number });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.get("/api/judge/my-events", requireOrgRole(["judge"]), async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT e.id, e.name, e.number_of_judges, e.total_rounds, e.status
       FROM events e JOIN event_judges ej ON e.id = ej.event_id
       WHERE ej.judge_id = $1 ORDER BY e.created_at DESC`,
      [req.user.id],
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// CONTROL ROOM ROUTES
// =============================================================

app.get(
  "/api/events/:id/roster",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT u.id AS competitor_id, u.full_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                cdl.partner_id, pu.full_name AS partner_name, po.country_code AS partner_country,
                cdl.team_id, t.name AS team_name, t.short_code AS team_code,
                cdl.event_id, cdl.round_number, cdl.dive_id,
                d.dive_code, d.description, d.dd, d.position,
                e.event_type, e.number_of_judges
         FROM users u
         JOIN competitor_dive_lists cdl ON u.id = cdl.competitor_id
         JOIN dive_directory d ON cdl.dive_id = d.id
         JOIN organisations o ON u.org_id = o.id
         JOIN events e ON e.id = cdl.event_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         LEFT JOIN organisations po ON po.id = pu.org_id
         LEFT JOIN teams t ON t.id = cdl.team_id
         WHERE cdl.event_id = $1
         ORDER BY cdl.round_number ASC, t.name ASC NULLS LAST, u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Roster Error]", err.message);
      res.status(500).json([]);
    }
  },
);

app.get("/api/events/:id/history", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.full_name AS "diverName", o.country_code, cl.name AS club_name,
              pu.full_name AS partner_name,
              s.round_number,
              d.dive_code, d.position, d.dd, d.description,
              calc_event_dive_points(
                array_agg(ej.judge_number ORDER BY ej.judge_number),
                array_agg(s.score ORDER BY ej.judge_number),
                e.number_of_judges, d.dd, e.event_type,
                BOOL_OR(cdl.partner_id IS NOT NULL)
) AS total_points,
              JSON_AGG(s.score ORDER BY s.judge_id) AS judge_scores
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
       WHERE s.event_id = $1
       GROUP BY u.full_name, o.country_code, cl.name, pu.full_name,
                s.round_number, d.dive_code, d.position, d.dd, d.description,
                e.number_of_judges, e.event_type
       ORDER BY s.round_number ASC, u.full_name ASC`,
      [req.params.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[History Error]", err.message);
    res.status(500).json([]);
  }
});

// =============================================================
// SCOREBOARD — public
// =============================================================

app.get("/api/scoreboard/:eventId", async (req, res) => {
  try {
    const [st, hi] = await Promise.all([
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
         /* Team-event branch: aggregate by team */
         team_standings AS (
           SELECT t.name AS full_name,
                  NULL::char(3) AS country_code,
                  t.short_code AS club_name,
                  NULL::varchar AS partner_name,
                  NULL::char(3) AS partner_country,
                  SUM(pd.dive_points) AS total
           FROM per_dive pd
           JOIN teams t ON t.id = pd.team_id
           WHERE (SELECT event_type FROM events WHERE id = $1) = 'team'
           GROUP BY t.id, t.name, t.short_code
         ),
         /* Individual / synchro branch: aggregate by competitor */
         comp_standings AS (
           SELECT u.full_name, o.country_code, cl.name AS club_name,
                  pu.full_name AS partner_name, pl.country_code AS partner_country,
                  SUM(pd.dive_points) AS total
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
           GROUP BY u.full_name, o.country_code, cl.name, pu.full_name, pl.country_code
         )
         SELECT * FROM team_standings
         UNION ALL
         SELECT * FROM comp_standings
         ORDER BY total DESC`,
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
    ]);
    res.json({ standings: st.rows, history: hi.rows });
  } catch (err) {
    console.error("[Scoreboard Error]", err.message);
    res.status(500).json({ standings: [], history: [] });
  }
});

// =============================================================
// COMPETITOR ROUTES
// =============================================================

app.post(
  "/api/competitor/submit-list",
  requireOrgRole(["diver"]),
  async (req, res) => {
    const { event_id, dives, partner_id } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // For synchro events, validate the partner exists, isn't
      // the user themselves, and is a diver in the same org.
      let resolvedPartnerId = null;
      const evRes = await client.query(
        "SELECT event_type FROM events WHERE id = $1",
        [event_id],
      );
      const eventType = evRes.rows[0]?.event_type || "individual";
      if (eventType === "synchro_pair") {
        if (!partner_id || partner_id === req.user.id) {
          await client.query("ROLLBACK");
          return res.status(400).json({
            error: "A different partner is required for synchronised events",
          });
        }
        const p = await client.query(
          `SELECT u.id FROM users u
           JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
           WHERE u.id = $1 AND u.org_id = $2`,
          [partner_id, req.user.org_id],
        );
        if (!p.rows.length) {
          await client.query("ROLLBACK");
          return res
            .status(400)
            .json({ error: "Partner must be a diver in your organisation" });
        }
        resolvedPartnerId = partner_id;
      }

      for (const dive of dives) {
        await client.query(
          `INSERT INTO competitor_dive_lists (competitor_id, partner_id, event_id, dive_id, round_number)
           VALUES ($1,$2,$3,$4,$5)`,
          [
            req.user.id,
            resolvedPartnerId,
            event_id,
            dive.dive_id,
            dive.round_number,
          ],
        );
      }
      await client.query("COMMIT");
      res.json({ message: "Dive list submitted" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Submit List Error]", err.message);
      res
        .status(500)
        .json({ error: err.detail || "Failed to submit dive list" });
    } finally {
      client.release();
    }
  },
);

// =============================================================
// DIVE DIRECTORY
// =============================================================

app.get("/api/dive-directory", verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM dive_directory ORDER BY dive_code ASC, height ASC",
    );
    res.json(r.rows);
  } catch (err) {
    res.status(500).json([]);
  }
});

// =============================================================
// PER-ROUND LEADERBOARD — public
// Returns rankings for each round with cumulative totals and the
// movement (change in rank) since the previous round. Used by the
// scoreboard to render ↑/↓ arrows next to the standings.
// =============================================================

app.get("/api/scoreboard/:eventId/leaderboard", async (req, res) => {
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

    // Group rows by round so the client can render one section per round
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

// =============================================================
// DIVER PROFILE & HISTORY
// Stats compiled from the diver's score history across all events
// in the directory: personal best per dive, average DD attempted,
// recent meets and a chronological score trend.
//
// Visible to the diver themself, to org_admin/meet_manager within
// the diver's org, and to system_admin.
// =============================================================

async function canViewDiverProfile(viewer, diverRow) {
  if (!viewer) return false;
  if (viewer.is_system_admin) return true;
  if (viewer.id === diverRow.id) return true;
  if (viewer.org_id !== diverRow.org_id) return false;
  const roles = viewer.org_roles || [];
  return roles.includes("org_admin") || roles.includes("meet_manager");
}

app.get("/api/divers/:id/profile", verifyToken, async (req, res) => {
  try {
    const diverRes = await pool.query(
      `SELECT u.id, u.full_name, u.org_id, o.name AS org_name, o.country_code,
              u.club_id, cl.name AS club_name, cl.short_code AS club_code
       FROM users u
       JOIN organisations o ON u.org_id = o.id
       LEFT JOIN clubs cl ON cl.id = u.club_id
       WHERE u.id = $1`,
      [req.params.id],
    );
    if (!diverRes.rows.length)
      return res.status(404).json({ error: "Diver not found" });
    const diver = diverRes.rows[0];

    if (!(await canViewDiverProfile(req.user, diver)))
      return res.status(403).json({ error: "Not permitted to view this profile" });

    // Top-level stats: total events the diver has scored in,
    // total dives performed, average DD across all dives attempted.
    const stats = await pool.query(
      `WITH dive_totals AS (
         SELECT s.event_id, s.round_number,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score ORDER BY ej.judge_number),
                  e.number_of_judges, MAX(d.dd), e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
) AS dive_total,
                MAX(d.dd) AS dd
         FROM scores s
         JOIN events e ON e.id = s.event_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = s.event_id
          AND cdl.competitor_id = s.competitor_id
          AND cdl.round_number = s.round_number
         LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
         WHERE s.competitor_id = $1
         GROUP BY s.event_id, s.round_number, e.number_of_judges, e.event_type
       )
       SELECT
         COUNT(DISTINCT event_id)::int AS total_meets,
         COUNT(*)::int                 AS total_dives,
         AVG(dd)::numeric(4,2)         AS avg_dd,
         MAX(dive_total)::numeric(6,2) AS best_single_dive
       FROM dive_totals`,
      [req.params.id],
    );

    // Personal best per dive: highest dive points the diver has
    // ever earned for a given dive (code + position + height),
    // computed under World Aquatics trim + DD rules.
    const pb = await pool.query(
      `WITH dive_totals AS (
         SELECT s.event_id, s.round_number,
                d.dive_code, d.position, d.height, d.dd, d.description,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score ORDER BY ej.judge_number),
                  e.number_of_judges, d.dd, e.event_type,
                BOOL_OR(cdl.partner_id IS NOT NULL)
  ) AS dive_total
         FROM scores s
         JOIN events e ON e.id = s.event_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         JOIN competitor_dive_lists cdl
           ON cdl.event_id = s.event_id
          AND cdl.competitor_id = s.competitor_id
          AND cdl.round_number = s.round_number
         JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
         WHERE s.competitor_id = $1
         GROUP BY s.event_id, s.round_number,
                  d.dive_code, d.position, d.height, d.dd, d.description, e.number_of_judges, e.event_type
       ),
       ranked AS (
         SELECT dt.*, e.name AS event_name, e.created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY dt.dive_code, dt.position, dt.height
                  ORDER BY dt.dive_total DESC, e.created_at DESC
                ) AS rn
         FROM dive_totals dt
         JOIN events e ON e.id = dt.event_id
       )
       SELECT dive_code, position, height, dd, description,
              dive_total AS best_total,
              event_name, event_id, created_at,
              (SELECT COUNT(*) FROM dive_totals dt2
                WHERE dt2.dive_code = ranked.dive_code
                  AND dt2.position = ranked.position
                  AND dt2.height   = ranked.height) AS attempts
       FROM ranked
       WHERE rn = 1
       ORDER BY dive_code ASC, position ASC`,
      [req.params.id],
    );

    // Score trend: per-event total + final placing, oldest first
    // so a chart can plot it as a line. Both totals and rankings
    // use World Aquatics dive points (trimmed × DD × scaling).
    const trend = await pool.query(
      `WITH diver_events AS (
         SELECT DISTINCT s.event_id
         FROM scores s
         WHERE s.competitor_id = $1
       ),
       per_dive AS (
         SELECT s.event_id, s.competitor_id, s.round_number,
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
         WHERE s.event_id IN (SELECT event_id FROM diver_events)
         GROUP BY s.event_id, s.competitor_id, s.round_number, e.number_of_judges, e.event_type
       ),
       all_event_totals AS (
         SELECT event_id, competitor_id, SUM(dive_points) AS total
         FROM per_dive
         GROUP BY event_id, competitor_id
       ),
       ranked AS (
         SELECT *, RANK() OVER (PARTITION BY event_id ORDER BY total DESC) AS rnk
         FROM all_event_totals
       )
       SELECT e.id AS event_id, e.name AS event_name, e.height,
              e.gender, e.status, e.created_at,
              e.event_type::text AS event_type,
              ranked.total::numeric(8,2) AS total_score,
              ranked.rnk::int AS final_rank,
              partner.full_name AS partner_name,
              tm.name AS team_name
       FROM ranked
       JOIN events e ON e.id = ranked.event_id
       LEFT JOIN LATERAL (
         SELECT DISTINCT cdl.partner_id
         FROM competitor_dive_lists cdl
         WHERE cdl.event_id = e.id
           AND cdl.competitor_id = $1
           AND cdl.partner_id IS NOT NULL
         LIMIT 1
       ) p ON true
       LEFT JOIN users partner ON partner.id = p.partner_id
       LEFT JOIN LATERAL (
         SELECT DISTINCT cdl.team_id
         FROM competitor_dive_lists cdl
         WHERE cdl.event_id = e.id
           AND cdl.competitor_id = $1
           AND cdl.team_id IS NOT NULL
         LIMIT 1
       ) tlink ON e.event_type = 'team'
       LEFT JOIN teams tm ON tm.id = tlink.team_id
       WHERE ranked.competitor_id = $1
       ORDER BY e.created_at ASC`,
      [req.params.id],
    );

    res.json({
      diver: {
        id: diver.id,
        full_name: diver.full_name,
        org_id: diver.org_id,
        org_name: diver.org_name,
        country_code: diver.country_code,
        club_id: diver.club_id,
        club_name: diver.club_name,
        club_code: diver.club_code,
      },
      stats: stats.rows[0] || {
        total_meets: 0,
        total_dives: 0,
        avg_dd: null,
        best_single_dive: null,
      },
      personal_bests: pb.rows,
      score_trend: trend.rows,
    });
  } catch (err) {
    console.error("[Diver Profile Error]", err.message);
    res.status(500).json({ error: "Failed to load diver profile" });
  }
});

// =============================================================
// SCORE AUDIT LOG — meet manager / org_admin / system_admin
// Returns the chronological audit trail for an event so disputes
// can be resolved with a complete record of who submitted what.
// =============================================================

app.get(
  "/api/events/:id/score-audit",
  requireEventManager(),
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT a.id, a.score_id, a.round_number, a.action,
                a.old_score, a.new_score,
                a.ip_address::text AS ip_address,
                a.user_agent, a.created_at,
                a.competitor_id, comp.full_name AS competitor_name,
                a.judge_id,      jud.full_name  AS judge_name,
                ej.judge_number,
                a.actor_user_id, act.full_name  AS actor_name
         FROM score_audit_log a
         LEFT JOIN users comp ON comp.id = a.competitor_id
         LEFT JOIN users jud  ON jud.id  = a.judge_id
         LEFT JOIN users act  ON act.id  = a.actor_user_id
         LEFT JOIN event_judges ej
           ON ej.event_id = a.event_id AND ej.judge_id = a.judge_id
         WHERE a.event_id = $1
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 1000`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Audit Log Error]", err.message);
      res.status(500).json({ error: "Failed to load audit log" });
    }
  },
);

// =============================================================
// SOCKET ENGINE
// =============================================================

// In-memory store of the current active diver per event.
// Keyed by event_id so multiple simultaneous events are supported.
const activeDivers = {};

// Soft JWT verification at handshake. We don't reject — spectators
// connect with no token — but if a valid token is present we stash
// the user id on the socket so privileged events (like score
// submission) can be attributed to a verified user rather than
// trusting the client-supplied judge_id. This is what makes the
// audit log meaningful.
io.use((socket, next) => {
  const raw = socket.handshake.auth?.token;
  if (raw && raw !== "spectator") {
    try {
      const decoded = jwt.verify(raw, JWT_SECRET);
      socket.userId = decoded.id;
      socket.userIsSystemAdmin = !!decoded.is_system_admin;
      socket.userOrgRoles = decoded.org_roles || [];
    } catch {
      // Invalid token — treat as anonymous (spectator). Don't reject.
    }
  }
  next();
});

function clientIp(socket) {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return socket.handshake.address || null;
}

io.on("connection", (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // When a new client connects, immediately send them the current
  // active diver state for any events that are already running.
  // This prevents judges who load after the control room has
  // already set a diver from seeing "Waiting for diver...".
  if (Object.keys(activeDivers).length > 0) {
    Object.values(activeDivers).forEach((state) => {
      socket.emit("state_update", state);
    });
  }

  socket.on("set_active_diver", (data) => {
    // Persist the state server-side so late-joining clients get it
    if (data.event_id) activeDivers[data.event_id] = data;
    io.emit("state_update", data);
  });

  // On-demand pull. The scoreboard requests this when the user
  // picks an event from the dropdown so it can show the current
  // performer immediately, even if the operator set them before
  // this socket connected and the initial connect-broadcast no
  // longer applies (e.g. user picked a different event first).
  socket.on("get_active_diver", (data) => {
    if (!data?.event_id) return;
    const state = activeDivers[data.event_id];
    if (state) socket.emit("state_update", state);
  });

  socket.on("submit_score", async (data) => {
    try {
      // Prefer the verified socket user over the client-supplied id.
      // Falls back to data.judge_id for backwards compatibility with
      // older clients that haven't picked up auth on the socket.
      const judgeId = socket.userId || data.judge_id;
      if (!judgeId) {
        console.warn("[Score] Submission without identifiable judge");
        return;
      }

      let judgeNumber = data.judge_number || null;
      if (!judgeNumber && data.event_id) {
        const jnRes = await pool.query(
          "SELECT judge_number FROM event_judges WHERE event_id = $1 AND judge_id = $2",
          [data.event_id, judgeId],
        );
        if (jnRes.rows.length) judgeNumber = jnRes.rows[0].judge_number;
      }

      // Read the prior row (if any) so we know whether this write is
      // an insert or an update, and can capture the previous score
      // for the audit log. Done outside any transaction — the audit
      // log is best-effort and must not block the score write itself.
      const prior = await pool.query(
        `SELECT id, score FROM scores
         WHERE event_id=$1 AND competitor_id=$2 AND round_number=$3 AND judge_id=$4`,
        [data.event_id, data.competitor_id, data.round_number, judgeId],
      );
      const existing = prior.rows[0] || null;

      const upsert = await pool.query(
        `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, competitor_id, round_number, judge_id)
         DO UPDATE SET score = EXCLUDED.score, status = 'active'
         RETURNING id`,
        [
          data.event_id,
          data.competitor_id,
          judgeId,
          data.dive_id || null,
          data.round_number,
          data.score,
        ],
      );
      const scoreId = upsert.rows[0].id;

      // Best-effort audit. We swallow errors here so a missing audit
      // table (e.g. before the operator runs the migration) does not
      // break live scoring. The error is logged so the operator
      // notices and applies the migration.
      const newScore = Number(data.score);
      const oldScore = existing ? Number(existing.score) : null;
      if (!existing || oldScore !== newScore) {
        try {
          await pool.query(
            `INSERT INTO score_audit_log
               (score_id, event_id, competitor_id, judge_id, round_number,
                action, old_score, new_score, actor_user_id, ip_address, user_agent)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
            [
              scoreId,
              data.event_id,
              data.competitor_id,
              judgeId,
              data.round_number,
              existing ? "update" : "insert",
              oldScore,
              newScore,
              socket.userId || judgeId,
              clientIp(socket),
              socket.handshake.headers["user-agent"] || null,
            ],
          );
        } catch (auditErr) {
          console.error("[Audit Log Skipped]", auditErr.message);
        }
      }

      io.emit("score_received", {
        ...data,
        judge_id: judgeId,
        judge_number: judgeNumber,
      });
    } catch (err) {
      console.error("[Score Persist Error]", err.message);
      // Still broadcast even if DB write fails so UI stays live
      io.emit("score_received", data);
    }
  });
  socket.on("announce_score", (data) => io.emit("final_score_announced", data));
  socket.on("referee_failed_dive", (data) =>
    io.emit("referee_action_failed", data),
  );
  socket.on("referee_cap_scores", (data) =>
    io.emit("referee_action_cap", data),
  );
  socket.on("referee_redive", (data) => io.emit("referee_action_redive", data));
  socket.on("disconnect", () =>
    console.log(`[Socket] Disconnected: ${socket.id}`),
  );
});

// =============================================================
// RESULTS ARCHIVE — public list of completed events
// =============================================================

app.get("/api/archive", async (req, res) => {
  try {
    // Each event row gains a competitor count, a club count, and
    // the list of distinct club ids that participated. The list
    // is what powers the client-side "filter by club" dropdown
    // without an extra round trip per filter change.
    const events = await pool.query(
      `SELECT e.id, e.name, e.gender, e.height, e.total_rounds, e.number_of_judges,
              e.created_at, o.id AS org_id, o.name AS org_name, o.country_code,
              COALESCE(stat.competitor_count, 0)::int AS competitor_count,
              COALESCE(stat.club_count, 0)::int       AS club_count,
              COALESCE(stat.club_ids, ARRAY[]::text[]) AS club_ids
       FROM events e
       JOIN organisations o ON e.org_id = o.id
       LEFT JOIN LATERAL (
         SELECT
           COUNT(DISTINCT s.competitor_id) AS competitor_count,
           COUNT(DISTINCT u.club_id) FILTER (WHERE u.club_id IS NOT NULL) AS club_count,
           ARRAY_AGG(DISTINCT u.club_id::text)
             FILTER (WHERE u.club_id IS NOT NULL) AS club_ids
         FROM scores s
         JOIN users u ON u.id = s.competitor_id
         WHERE s.event_id = e.id
       ) stat ON true
       WHERE e.status = 'Completed'
       ORDER BY e.created_at DESC`,
    );
    res.json(events.rows);
  } catch (err) {
    console.error("[Archive Error]", err.message);
    res.status(500).json([]);
  }
});

// Distinct clubs that have appeared in any completed meet.
// Drives the club filter dropdown on the archive view.
app.get("/api/archive/clubs", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT cl.id, cl.name, cl.short_code,
              cl.org_id, o.name AS org_name, o.country_code
       FROM clubs cl
       JOIN users u ON u.club_id = cl.id
       JOIN scores s ON s.competitor_id = u.id
       JOIN events e ON e.id = s.event_id AND e.status = 'Completed'
       JOIN organisations o ON o.id = cl.org_id
       ORDER BY o.country_code ASC, cl.name ASC`,
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[Archive Clubs Error]", err.message);
    res.status(500).json([]);
  }
});

app.get("/api/archive/:eventId/results", async (req, res) => {
  try {
    const [ev, standings, history] = await Promise.all([
      pool.query("SELECT e.name, e.gender, e.height, e.total_rounds, e.number_of_judges, e.event_type, o.name AS org_name FROM events e JOIN organisations o ON e.org_id = o.id WHERE e.id = $1", [req.params.eventId]),
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
         team_standings AS (
           SELECT t.name AS full_name,
                  NULL::char(3) AS country_code,
                  t.short_code AS club_name,
                  NULL::varchar AS partner_name,
                  NULL::char(3) AS partner_country,
                  SUM(pd.dive_points) AS total
           FROM per_dive pd
           JOIN teams t ON t.id = pd.team_id
           WHERE (SELECT event_type FROM events WHERE id = $1) = 'team'
           GROUP BY t.id, t.name, t.short_code
         ),
         comp_standings AS (
           SELECT u.full_name, o.country_code, cl.name AS club_name,
                  pu.full_name AS partner_name, pl.country_code AS partner_country,
                  SUM(pd.dive_points) AS total
           FROM per_dive pd
           JOIN users u ON u.id = pd.competitor_id
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           LEFT JOIN LATERAL (
             SELECT DISTINCT cdl.partner_id FROM competitor_dive_lists cdl
             WHERE cdl.event_id = $1 AND cdl.competitor_id = pd.competitor_id
               AND cdl.partner_id IS NOT NULL LIMIT 1
           ) p ON true
           LEFT JOIN users pu ON pu.id = p.partner_id
           LEFT JOIN organisations pl ON pl.id = pu.org_id
           WHERE (SELECT event_type FROM events WHERE id = $1) <> 'team'
           GROUP BY u.full_name, o.country_code, cl.name, pu.full_name, pl.country_code
         )
         SELECT * FROM team_standings
         UNION ALL
         SELECT * FROM comp_standings
         ORDER BY total DESC`,
        [req.params.eventId],
      ),
      pool.query(
        `SELECT u.full_name, o.country_code, cl.name AS club_name,
                pu.full_name AS partner_name, pl.country_code AS partner_country,
                t.id AS team_id, t.name AS team_name,
                s.round_number,
                d.dive_code, d.position, d.description, d.dd,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score ORDER BY ej.judge_number),
                  e.number_of_judges, d.dd, e.event_type,
                BOOL_OR(cdl.partner_id IS NOT NULL)
  ) AS total_dive_score,
                STRING_AGG(s.score::text, ',' ORDER BY s.judge_id) AS judge_scores
         FROM scores s
         JOIN events e ON e.id = s.event_id
         JOIN users u ON s.competitor_id = u.id
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl
           ON s.competitor_id = cdl.competitor_id AND s.event_id = cdl.event_id AND s.round_number = cdl.round_number
         LEFT JOIN dive_directory d ON COALESCE(s.dive_id, cdl.dive_id) = d.id
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         LEFT JOIN organisations pl ON pl.id = pu.org_id
         LEFT JOIN teams t ON t.id = cdl.team_id
         WHERE s.event_id = $1
         GROUP BY u.full_name, o.country_code, cl.name, pu.full_name, pl.country_code,
                  t.id, t.name,
                  s.round_number, d.dive_code, d.position, d.description, d.dd,
                  e.number_of_judges, e.event_type
         ORDER BY u.full_name ASC, s.round_number ASC`,
        [req.params.eventId],
      ),
    ]);
    if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
    res.json({ event: ev.rows[0], standings: standings.rows, dives: history.rows });
  } catch (err) {
    console.error("[Archive Results Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PDF EXPORT
// =============================================================

app.get("/api/events/:id/results.pdf", async (req, res) => {
  try {
    const [ev, standings, dives] = await Promise.all([
      pool.query(
        "SELECT e.name, e.gender, e.height, e.total_rounds, e.number_of_judges, o.name AS org_name FROM events e JOIN organisations o ON e.org_id = o.id WHERE e.id = $1",
        [req.params.id],
      ),
      pool.query(
        `WITH per_dive AS (
           SELECT s.competitor_id, s.round_number,
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
           GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         )
         SELECT u.full_name, o.country_code, cl.name AS club_name,
                pu.full_name AS partner_name,
                SUM(pd.dive_points) AS total
         FROM per_dive pd
         JOIN users u ON u.id = pd.competitor_id
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN LATERAL (
           SELECT DISTINCT cdl.partner_id FROM competitor_dive_lists cdl
           WHERE cdl.event_id = $1 AND cdl.competitor_id = pd.competitor_id
             AND cdl.partner_id IS NOT NULL LIMIT 1
         ) p ON true
         LEFT JOIN users pu ON pu.id = p.partner_id
         GROUP BY u.full_name, o.country_code, cl.name, pu.full_name
         ORDER BY total DESC`,
        [req.params.id],
      ),
      pool.query(
        `SELECT u.full_name, cl.name AS club_name, pu.full_name AS partner_name,
                s.round_number, d.dive_code, d.position, d.dd,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score ORDER BY ej.judge_number),
                  e.number_of_judges, d.dd, e.event_type,
                BOOL_OR(cdl.partner_id IS NOT NULL)
  ) AS total_dive_score,
                STRING_AGG(s.score::text, ', ' ORDER BY s.judge_id) AS judge_scores
         FROM scores s
         JOIN events e ON e.id = s.event_id
         JOIN users u ON s.competitor_id = u.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl ON s.competitor_id = cdl.competitor_id AND s.event_id = cdl.event_id AND s.round_number = cdl.round_number
         LEFT JOIN dive_directory d ON COALESCE(s.dive_id, cdl.dive_id) = d.id
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         WHERE s.event_id = $1
         GROUP BY u.full_name, cl.name, pu.full_name,
                  s.round_number, d.dive_code, d.position, d.dd,
                  e.number_of_judges, e.event_type
         ORDER BY u.full_name ASC, s.round_number ASC`,
        [req.params.id],
      ),
    ]);

    if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
    const event = ev.rows[0];
    const slug = event.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_results.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(20).font("Helvetica-Bold").text("DIVE RECORDER", { align: "center" });
    doc.fontSize(10).font("Helvetica").text(event.org_name, { align: "center" });
    doc.moveDown(0.5);
    doc.fontSize(16).font("Helvetica-Bold").text(event.name, { align: "center" });
    const meta = [event.gender, event.height, `${event.total_rounds} rounds`, `${event.number_of_judges} judges`].filter(Boolean).join("  ·  ");
    doc.fontSize(9).font("Helvetica").fillColor("#666").text(meta, { align: "center" });
    doc.fillColor("#000").moveDown(1);

    // Standings
    doc.fontSize(13).font("Helvetica-Bold").text("Final Standings");
    doc.moveDown(0.3);
    standings.rows.forEach((row, i) => {
      const rank = i + 1;
      const total = Number(row.total).toFixed(2);
      doc.fontSize(10).font(rank <= 3 ? "Helvetica-Bold" : "Helvetica")
        .text(`${rank}.  ${row.full_name}${row.country_code ? "  " + row.country_code : ""}`, 50, doc.y, { continued: true, width: 350 })
        .font("Helvetica-Bold").text(total, { align: "right" });
      if (row.club_name) {
        doc.fontSize(8).font("Helvetica").fillColor("#666")
          .text(`     ${row.club_name}`, 50);
        doc.fillColor("#000");
      }
    });
    doc.moveDown(1);

    // Dive-by-dive breakdown
    doc.fontSize(13).font("Helvetica-Bold").text("Dive Results");
    doc.moveDown(0.3);

    // Group rows by diver while keeping the first row's club_name
    // for the section header.
    const byDiver = new Map();
    dives.rows.forEach((row) => {
      if (!byDiver.has(row.full_name)) {
        byDiver.set(row.full_name, { club: row.club_name || null, rows: [] });
      }
      byDiver.get(row.full_name).rows.push(row);
    });

    for (const [diver, group] of byDiver) {
      if (doc.y > 680) doc.addPage();
      doc.fontSize(11).font("Helvetica-Bold").fillColor("#000").text(diver);
      if (group.club) {
        doc.fontSize(9).font("Helvetica").fillColor("#666").text(group.club);
        doc.fillColor("#000");
      }
      group.rows.forEach((r) => {
        const code = [r.dive_code, r.position].filter(Boolean).join(" ");
        const dd = r.dd ? `DD ${Number(r.dd).toFixed(1)}` : "";
        const scores = r.judge_scores || "";
        const total = Number(r.total_dive_score).toFixed(2);
        doc.fontSize(9).font("Helvetica")
          .text(`  R${r.round_number}  ${code}  ${dd}    Judges: ${scores}    Total: ${total}`);
      });
      doc.moveDown(0.5);
    }

    doc.end();
  } catch (err) {
    console.error("[PDF Error]", err.message);
    if (!res.headersSent) res.status(500).json({ error: "Failed to generate PDF" });
  }
});

// =============================================================
// SPA FALLBACK — must come after all API routes
//
// Hard-refreshing /dashboard (or any client-side route) hits
// Express, not the Vue router. We send index.html so the SPA
// can boot and take over the route client-side. /api and
// /socket.io paths fall through so unknown API requests get a
// proper 404 below instead of an HTML page.
//
// (Express 5 dropped support for `app.get('*', ...)` in
// path-to-regexp v8, so we use middleware here.)
// =============================================================

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path.startsWith('/socket.io/')) return next();
  res.sendFile(path.join(__dirname, 'dist', 'index.html'), (err) => {
    if (err) next(err);
  });
});

// Final 404 for unmatched /api/* and non-GET requests, so they
// don't quietly succeed with HTML or a Vite dev page.
app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.status(404).send('Not found');
});

// =============================================================
// START
// =============================================================

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Diving App v2 on port ${PORT}`));
