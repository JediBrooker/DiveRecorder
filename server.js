// =============================================================
// DIVING APP — SERVER v2
// Express + Socket.IO + PostgreSQL
// Multi-tenant RBAC with org-scoped roles
//
// AGENT NAVIGATION
// ----------------
// Each section is tagged with [SECTION: NAME] so an agent can jump
// to it via Cmd-F / grep. Order below mirrors the file's reading
// flow top-to-bottom. Read AGENTS.md alongside this file for the
// invariants (JWT shape, sysadmin bypass, org-resource cross-checks).
//
//   [SECTION: BOOTSTRAP]              app + io setup, helmet, limiters
//   [SECTION: EMAIL]                  nodemailer + send-* helpers
//   [SECTION: DB POOL & JWT_SECRET]   pool config, fail-closed secret
//   [SECTION: MIDDLEWARE]             verifyToken, requireOrgRole,
//                                     requireEventManager, requireSystemAdmin,
//                                     ensureEventOrgGate, isInSameOrg,
//                                     parseDateRange, isValidScore
//   [SECTION: TOKEN PAYLOAD]          buildTokenPayload (JWT shape)
//   [SECTION: ROUTES — ORGANISATIONS] /api/orgs/*, /api/clubs/*
//   [SECTION: ROUTES — TEAMS]         /api/teams/*, /api/events/:id/teams
//   [SECTION: ROUTES — COACH]         /api/coach/*
//   [SECTION: ROUTES — USERS]         /api/users/*, /api/role-requests/*
//   [SECTION: ROUTES — MEETS]         /api/meets/*
//   [SECTION: ROUTES — EVENTS]        /api/events (CRUD + status)
//   [SECTION: ROUTES — STAGE ADVANCE] /api/events/:id/advance (top-N)
//   [SECTION: ROUTES — TEMPLATES]     /api/orgs/:id/event-templates
//   [SECTION: ROUTES — JUDGES]        /api/events/:id/judges
//   [SECTION: ROUTES — CONTROL ROOM]  /api/events/:id/roster + reorder + DNS
//   [SECTION: ROUTES — SCOREBOARD]    public scoreboard, score corrections
//   [SECTION: MEET HOLD STATE]        in-memory hold map
//   [SECTION: ROUTES — DIVE TEMPLATES] /api/dive-list-templates/*
//   [SECTION: ROUTES — COMPETITOR]    /api/competitor/submit-list
//   [SECTION: ROUTES — DIVE DIRECTORY] /api/dive-directory
//   [SECTION: ROUTES — DIVER PROFILE] /api/divers/:id/profile, /analytics
//   [SECTION: ROUTES — AUDIT LOG]     /api/events/:id/score-audit
//   [SECTION: SOCKET ENGINE]          io.use, submit_score, referee_*,
//                                     meet_hold/resume, set_active_diver
//   [SECTION: ROUTES — ARCHIVE]       /api/archive
//   [SECTION: ROUTES — PDF EXPORT]    /api/events/:id/results.pdf, /program.pdf
//   [SECTION: SPA FALLBACK]           static + history-API rewrite
//   [SECTION: START]                  server.listen (skipped under require())
// =============================================================

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const { Pool } = require("pg");
const cors = require("cors");
const helmet = require("helmet");
const { PER_DIVE: SHARED_PER_DIVE, FULL_FIELD_RANKING } = require("./db/queries");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
const PDFDocument = require("pdfkit");
const nodemailer = require("nodemailer");
require("dotenv").config();

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// [SECTION: BOOTSTRAP]
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: CORS_ORIGIN } });

// Standard HTTP-security headers. CSP is left at helmet's defaults
// for the API; the SPA bundle is served via the same origin so
// the header set is fine for both.
app.use(helmet({
  // Disable CSP for now — the SPA inlines a small bootstrap and
  // we'd otherwise have to maintain a hash list. Revisit when the
  // app shell is fully external. The other helmet defaults
  // (HSTS, X-Frame-Options, X-Content-Type-Options, etc.) stay on.
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));
app.use(cors({ origin: CORS_ORIGIN }));
// Bound the JSON body size — the largest legitimate payload is the
// CSV roster import, which never approaches 256kb. Anything bigger
// is either a bug or an abuse attempt.
app.use(express.json({ limit: "256kb" }));

// 20 requests / 15 min / IP for auth + password flows. Tight enough
// to slow brute-force, loose enough that a real user fat-fingering
// their password a couple of times isn't locked out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: "Too many attempts, please try again in 15 minutes." },
});

// Heavier limiter for the bulk-write endpoints (CSV roster import,
// dive-list submission). Mostly to prevent a logged-in but malicious
// user from looping these to lock tables.
const bulkWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many bulk-write attempts, please slow down." },
});

// =============================================================
// EMAIL
// [SECTION: EMAIL]
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

// Short, deterministic fingerprint of a bcrypt hash. Used as a
// "single-use" guard for password-reset JWTs: when the user's
// password column changes, this fingerprint changes too, which
// invalidates any in-flight reset token without needing a
// nonce-tracking table.
const crypto = require("crypto");
function hashFingerprint(bcryptHash) {
  return crypto.createHash("sha256").update(bcryptHash || "").digest("hex").slice(0, 16);
}

// "We received a password-reset request" email. Includes a
// 30-min link that hits POST /api/auth/reset-password.
async function sendPasswordResetEmail(user, token) {
  if (!mailer || !user?.email) return;
  const base = process.env.APP_BASE_URL || "";
  const link = `${base}/reset-password?token=${encodeURIComponent(token)}`;
  try {
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: "Reset your Dive Recorder password",
      text: `Hi ${user.full_name},\n\nWe received a request to reset your password. Click the link below to choose a new one — it expires in 30 minutes.\n\n${link}\n\nIf you didn't request this, you can ignore this message safely.\n\nDive Recorder`,
    });
  } catch (err) {
    console.error("[Reset Email Error]", err.message);
  }
}

// "Your password was just changed" hygiene email. Fires after
// any successful password change (self-service or via reset).
async function sendPasswordChangedEmail(userId) {
  if (!mailer) return;
  try {
    const u = await pool.query(
      "SELECT email, full_name FROM users WHERE id = $1",
      [userId],
    );
    const user = u.rows[0];
    if (!user?.email) return;
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: "Your Dive Recorder password was changed",
      text: `Hi ${user.full_name},\n\nThis is a confirmation that your password was just changed. If you didn't do this, contact your organisation admin and reset your password immediately.\n\nDive Recorder`,
    });
  } catch (err) {
    console.error("[Hygiene Email Error]", err.message);
  }
}

// "Welcome to Dive Recorder" email. Fires once on registration.
async function sendWelcomeEmail(userId) {
  if (!mailer) return;
  try {
    const u = await pool.query(
      `SELECT u.email, u.full_name, o.name AS org_name
       FROM users u JOIN organisations o ON o.id = u.org_id
       WHERE u.id = $1`,
      [userId],
    );
    const user = u.rows[0];
    if (!user?.email) return;
    const base = process.env.APP_BASE_URL || "";
    await mailer.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: user.email,
      subject: `Welcome to Dive Recorder — ${user.org_name}`,
      text: `Hi ${user.full_name},\n\nThanks for registering with ${user.org_name} on Dive Recorder. You can sign in at ${base || "your Dive Recorder instance"} with your username and password.\n\nIf you requested a role (diver, judge, etc.), your organisation admin will review and approve it. Until then your account has spectator access — you can already browse meets and watch live broadcasts.\n\nDive Recorder`,
    });
  } catch (err) {
    console.error("[Welcome Email Error]", err.message);
  }
}

// "A new role request landed" email to every org_admin in the
// target org. Helps admins act on requests promptly without
// polling the User Manager queue.
async function sendNewRoleRequestEmail(userId, orgId, role, note) {
  if (!mailer) return;
  try {
    const userRes = await pool.query(
      "SELECT full_name FROM users WHERE id = $1",
      [userId],
    );
    const requester = userRes.rows[0];
    if (!requester) return;

    const adminRes = await pool.query(
      `SELECT u.email, u.full_name
       FROM users u
       JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id
       WHERE u.org_id = $1 AND r.role = 'org_admin' AND u.email IS NOT NULL`,
      [orgId],
    );
    if (!adminRes.rows.length) return;

    const base = process.env.APP_BASE_URL || "";
    const subject = `New ${role} role request from ${requester.full_name}`;
    const text = `${requester.full_name} requested the "${role}" role.${note ? `\n\nNote: ${note}` : ""}\n\nReview pending requests in the User Manager: ${base}/users\n\nDive Recorder`;

    await Promise.all(
      adminRes.rows.map((admin) =>
        mailer.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: admin.email,
          subject,
          text,
        }),
      ),
    );
  } catch (err) {
    console.error("[Role Request Notify Error]", err.message);
  }
}

// "The meet you registered for just went live" email. Sends to
// every diver with a dive list in the event (including synchro
// partners — they're flagged via partner_id on the dive list).
async function sendEventStartedEmails(event) {
  if (!mailer || !event) return;
  try {
    const audience = await pool.query(
      `SELECT DISTINCT u.email, u.full_name
       FROM competitor_dive_lists cdl
       JOIN users u ON u.id IN (cdl.competitor_id, cdl.partner_id)
       WHERE cdl.event_id = $1 AND u.email IS NOT NULL`,
      [event.id],
    );
    const base = process.env.APP_BASE_URL || "";
    const link = `${base}/scoreboard/${event.id}`;
    await Promise.all(
      audience.rows.map((u) =>
        mailer.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: u.email,
          subject: `${event.name} is live — good luck!`,
          text: `Hi ${u.full_name},\n\n"${event.name}" has just started. Watch the live scoreboard or check in for your turn:\n\n${link}\n\nDive Recorder`,
        }),
      ),
    );
  } catch (err) {
    console.error("[Event Live Notify Error]", err.message);
  }
}

// "Results are posted" email — fires when a meet flips to
// Completed. Same audience as the live notification.
async function sendEventResultsEmails(event) {
  if (!mailer || !event) return;
  try {
    const audience = await pool.query(
      `SELECT DISTINCT u.email, u.full_name
       FROM competitor_dive_lists cdl
       JOIN users u ON u.id IN (cdl.competitor_id, cdl.partner_id)
       WHERE cdl.event_id = $1 AND u.email IS NOT NULL`,
      [event.id],
    );
    const base = process.env.APP_BASE_URL || "";
    const link = `${base}/scoreboard/${event.id}`;
    await Promise.all(
      audience.rows.map((u) =>
        mailer.sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: u.email,
          subject: `Results posted — ${event.name}`,
          text: `Hi ${u.full_name},\n\nResults for "${event.name}" are now available. View the full recap and dive breakdown:\n\n${link}\n\nDive Recorder`,
        }),
      ),
    );
  } catch (err) {
    console.error("[Event Results Notify Error]", err.message);
  }
}

// Serve the built Vue app (run `npm run build` before starting the server)
app.use(express.static(path.join(__dirname, 'dist')))

// [SECTION: DB POOL & JWT_SECRET]
//
// Connection precedence:
//   1. DATABASE_URL  (preferred for hosted Postgres / single-string envs)
//   2. DB_*          (the app's documented vars in .env.example)
//   3. PG*           (libpq standard, used by CI's Postgres service)
//
// node-postgres falls back to libpq env vars when a config field is
// undefined, so the explicit DB_*-then-PG* coalesce below is mostly
// belt-and-braces — but it makes the precedence visible to anyone
// debugging a connection error.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      user:     process.env.DB_USER     || process.env.PGUSER,
      host:     process.env.DB_HOST     || process.env.PGHOST,
      database: process.env.DB_DATABASE || process.env.PGDATABASE,
      password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
      port:     process.env.DB_PORT     || process.env.PGPORT,
    });

// Refuse to boot with no JWT secret or the well-known placeholder —
// either case means tokens are trivially forgeable. We DON'T fail on
// short-but-unique secrets: existing deployments may have a working
// 12-20 char string set, and crashing those on upgrade is worse than
// nudging them to rotate. We do print a loud warning so it shows up
// in PM2 logs and the operator can fix it on their next pass.
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === "change_this_secret_in_production") {
  console.error(
    "FATAL: JWT_SECRET must be set in the environment to a strong random value. Refusing to start.",
  );
  process.exit(1);
}
if (JWT_SECRET.length < 32) {
  console.warn(
    `[security] JWT_SECRET is only ${JWT_SECRET.length} chars. Rotate to ≥32 random chars when convenient — short secrets are easier to brute force.`,
  );
}
const JWT_EXPIRY = process.env.JWT_EXPIRY || "8h";

// =============================================================
// MIDDLEWARE
// [SECTION: MIDDLEWARE]
//
// All middleware + security helpers live in lib/middleware.js so
// the auth/RBAC perimeter can be reviewed as a single unit. See
// AGENTS.md for the invariants. Don't add new gates inline here —
// add them to lib/middleware.js and re-export.
// =============================================================
const {
  verifyToken,
  requireOrgRole,
  requireSystemAdmin,
  requireEventManager,
  ensureEventOrgGate,
  ensureEventPreMeet,
  isInSameOrg,
  socketRequireRole,
  isValidScore,
  parseDateRange,
} = require("./lib/middleware")({ pool, JWT_SECRET });

// =============================================================
// HELPER — Build JWT payload
// [SECTION: TOKEN PAYLOAD]
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
// =============================================================
// AUTH ROUTES
// Moved into routes/auth.js. The factory pattern lets this slice
// live in its own file without forcing every other slice (events,
// users, scoreboard, archive…) to be extracted at the same time.
// Subsequent batches can follow the same shape.
// =============================================================

app.use(
  require("./routes/auth")({
    pool,
    authLimiter,
    verifyToken,
    buildTokenPayload,
    hashFingerprint,
    sendWelcomeEmail,
    sendNewRoleRequestEmail,
    sendPasswordChangedEmail,
    sendPasswordResetEmail,
    JWT_SECRET,
    JWT_EXPIRY,
  }),
);

// =============================================================
// ORGANISATION ROUTES
// [SECTION: ROUTES — ORGANISATIONS]
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
  },
);

app.post(
  "/api/events/:id/teams",
  requireEventManager(),
  async (req, res) => {
    const { team_id } = req.body;
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
      res.status(500).json({ error: err.message });
    }
  },
);

// Remove a team from an event. Doesn't touch competitor_dive_lists
// — the FK is ON DELETE SET NULL so historical dives stay; the
// team just isn't an active enrolment any more.
app.delete(
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
      res.status(500).json({ error: err.message });
    }
  },
);

// Divers in an organisation. Authenticated and scoped to the
// caller's own org (system admins see any). Used by the
// CompetitorView's synchro partner picker.
// =============================================================
// COACH ROUTES
// [SECTION: ROUTES — COACH]
// A coach picks up divers via coach_diver_links (created by an
// org admin in the User Manager). These endpoints power the
// coach's dashboard.
// =============================================================

// Coach dashboard rollup — for every linked diver, return the
// next dive they have in any Live event (round, dive code, DD)
// plus their current rank in that event's standings, plus a
// summary of their last dive's total. Powers the dedicated
// /coach view; reuses coach_diver_links + per_dive aggregates.
//
// Schema-wise nothing new — this is just a join across the
// existing pieces. Heavy enough that we don't want it in the
// page-load critical path of the regular dashboard.
app.get("/api/coach/dashboard", verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `WITH my_divers AS (
         SELECT u.id, u.full_name, u.username,
                o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                link.note, link.created_at AS linked_at
         FROM coach_diver_links link
         JOIN users u           ON u.id = link.diver_id
         JOIN organisations o   ON o.id = u.org_id
         LEFT JOIN clubs cl     ON cl.id = u.club_id
         WHERE link.coach_id = $1
       ),
       /* Every dive the linked divers have on a non-completed
          event, with the event's status so we can filter live
          ones. */
       upcoming_raw AS (
         SELECT cdl.competitor_id, cdl.event_id, cdl.round_number,
                cdl.display_order,
                e.name AS event_name, e.status, e.event_type,
                e.height, e.number_of_judges,
                d.dive_code, d.position, d.dd, d.description
         FROM competitor_dive_lists cdl
         JOIN events e ON e.id = cdl.event_id
         JOIN dive_directory d ON d.id = cdl.dive_id
         WHERE cdl.competitor_id IN (SELECT id FROM my_divers)
           AND cdl.withdrawn_at IS NULL
           AND e.status IN ('Live', 'Upcoming')
       ),
       /* Pick the diver's next round in each event — the lowest
          round_number that doesn't yet have all judges' scores. */
       scored_rounds AS (
         SELECT s.event_id, s.competitor_id, s.round_number,
                COUNT(*) AS judges_in
         FROM scores s
         WHERE s.competitor_id IN (SELECT id FROM my_divers)
         GROUP BY s.event_id, s.competitor_id, s.round_number
       ),
       upcoming_with_status AS (
         SELECT ur.*,
                COALESCE(sr.judges_in, 0) AS judges_in,
                ur.number_of_judges - COALESCE(sr.judges_in, 0) AS judges_pending
         FROM upcoming_raw ur
         LEFT JOIN scored_rounds sr
           ON sr.event_id      = ur.event_id
          AND sr.competitor_id = ur.competitor_id
          AND sr.round_number  = ur.round_number
       ),
       next_dive AS (
         SELECT DISTINCT ON (competitor_id, event_id)
                competitor_id, event_id, round_number,
                event_name, status, event_type, height,
                dive_code, position, dd, description,
                judges_pending
         FROM upcoming_with_status
         WHERE judges_pending > 0
         ORDER BY competitor_id, event_id, round_number ASC
       ),
       /* Standings per event so we can attach a current rank. */
       per_dive AS (
         SELECT s.event_id, s.competitor_id,
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
         WHERE s.event_id IN (SELECT event_id FROM upcoming_raw)
         GROUP BY s.event_id, s.competitor_id, s.round_number, e.number_of_judges, e.event_type
       ),
       totals AS (
         SELECT event_id, competitor_id, SUM(pts)::numeric(8,2) AS total
         FROM per_dive GROUP BY event_id, competitor_id
       ),
       ranked AS (
         SELECT *, RANK() OVER (PARTITION BY event_id ORDER BY total DESC) AS rnk,
                COUNT(*) OVER (PARTITION BY event_id)::int AS field_size
         FROM totals
       )
       SELECT md.id AS diver_id, md.full_name, md.username,
              md.country_code, md.club_name, md.club_code,
              md.note,
              nd.event_id, nd.event_name, nd.status AS event_status,
              nd.event_type, nd.height,
              nd.round_number, nd.dive_code, nd.position, nd.dd, nd.description,
              r.total::numeric(8,2)   AS current_total,
              r.rnk::int              AS current_rank,
              r.field_size
       FROM my_divers md
       LEFT JOIN next_dive nd ON nd.competitor_id = md.id
       LEFT JOIN ranked r
         ON r.event_id = nd.event_id AND r.competitor_id = md.id
       ORDER BY
         /* Live events first, then upcoming, then divers with no
            upcoming dive at all */
         CASE WHEN nd.status = 'Live' THEN 0
              WHEN nd.status = 'Upcoming' THEN 1
              ELSE 2 END,
         md.full_name ASC`,
      [req.user.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[Coach Dashboard Error]", err.message);
    res.status(500).json([]);
  }
});

// Coaches see their own linked divers — minimal fields, enough
// to build a dashboard tile + click through to each diver's
// profile (which already exists at /profile/:id).
app.get("/api/coach/divers", verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.id, u.full_name, u.username,
              cl.name AS club_name, cl.short_code AS club_code,
              o.country_code,
              link.created_at AS linked_at,
              link.note
       FROM coach_diver_links link
       JOIN users u ON u.id = link.diver_id
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN clubs cl ON cl.id = u.club_id
       WHERE link.coach_id = $1
       ORDER BY u.full_name ASC`,
      [req.user.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[Coach Divers Error]", err.message);
    res.status(500).json([]);
  }
});

// Org admins manage coach ↔ diver links from the User Manager.
// GET returns every link in the org (for the admin view).
app.get(
  "/api/orgs/:id/coach-links",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot read coach links in other organisations" });
    }
    try {
      const r = await pool.query(
        `SELECT link.id, link.coach_id, link.diver_id, link.created_at, link.note,
                c.full_name AS coach_name, d.full_name AS diver_name
         FROM coach_diver_links link
         JOIN users c ON c.id = link.coach_id
         JOIN users d ON d.id = link.diver_id
         WHERE link.org_id = $1
         ORDER BY c.full_name, d.full_name`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Coach Links List Error]", err.message);
      res.status(500).json([]);
    }
  },
);

app.post(
  "/api/orgs/:id/coach-links",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
    const { coach_id, diver_id, note } = req.body || {};
    if (!coach_id || !diver_id) {
      return res.status(400).json({ error: "coach_id and diver_id are required" });
    }
    if (coach_id === diver_id) {
      return res.status(400).json({ error: "Coach and diver must be different users" });
    }
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot link users in other organisations" });
    }
    try {
      // Sanity check: both users belong to the target org.
      const usersRes = await pool.query(
        `SELECT id, org_id FROM users WHERE id = ANY($1)`,
        [[coach_id, diver_id]],
      );
      if (usersRes.rows.length !== 2) {
        return res.status(400).json({ error: "Coach or diver not found" });
      }
      for (const u of usersRes.rows) {
        if (u.org_id !== req.params.id) {
          return res
            .status(400)
            .json({ error: "Both users must belong to the target organisation" });
        }
      }
      const r = await pool.query(
        `INSERT INTO coach_diver_links (coach_id, diver_id, org_id, note)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (coach_id, diver_id) DO UPDATE SET note = EXCLUDED.note
         RETURNING id, coach_id, diver_id, note, created_at`,
        [coach_id, diver_id, req.params.id, note || null],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Coach Link Create Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete(
  "/api/coach-links/:id",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        "DELETE FROM coach_diver_links WHERE id = $1 AND org_id = $2 RETURNING id",
        [req.params.id, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Link not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Coach Link Delete Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Cross-org diver search + browse + orgs/all live in routes/
// diver-search.js — extracted to keep server.js manageable. See
// AGENTS.md for the modularisation plan.
app.use(require("./routes/diver-search")({ pool, verifyToken }));

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
// [SECTION: ROUTES — USERS]
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

// Enum values from init.sql's CREATE TYPE org_role. system_admin
// is intentionally NOT in this set — it's a column on users, not
// a role assignable here. Keeping this in sync with init.sql is
// flagged in AGENTS.md.
const VALID_ORG_ROLES = new Set([
  "org_admin", "meet_manager", "referee",
  "judge", "diver", "coach", "spectator",
]);

app.put(
  "/api/users/:id/roles",
  requireOrgRole(["org_admin"]),
  async (req, res) => {
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
// MEET ROUTES
// [SECTION: ROUTES — MEETS]
// A meet bundles multiple events. Public-readable (any spectator
// can browse meets) but write-restricted to org_admin /
// meet_manager.
// =============================================================

// List meets in an organisation. Public — used by the
// Scoreboard list to group events by meet.
app.get("/api/orgs/:id/meets", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT m.*,
              COUNT(e.id)::int AS event_count,
              COUNT(e.id) FILTER (WHERE e.status = 'Live')::int      AS live_count,
              COUNT(e.id) FILTER (WHERE e.status = 'Completed')::int AS completed_count
       FROM meets m
       LEFT JOIN events e ON e.meet_id = m.id
       WHERE m.org_id = $1
       GROUP BY m.id
       ORDER BY COALESCE(m.start_date, m.created_at) DESC`,
      [req.params.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[List Meets Error]", err.message);
    res.status(500).json([]);
  }
});

// Public meet detail — meet metadata + every event nested
// inside, in a shape suitable for the public landing page.
app.get("/api/meets/:id", async (req, res) => {
  try {
    const meetRes = await pool.query(
      `SELECT m.*, o.name AS org_name, o.country_code, o.id AS org_id
       FROM meets m
       JOIN organisations o ON o.id = m.org_id
       WHERE m.id = $1`,
      [req.params.id],
    );
    if (!meetRes.rows.length)
      return res.status(404).json({ error: "Meet not found" });
    const eventsRes = await pool.query(
      `SELECT e.id, e.name, e.gender, e.height, e.total_rounds,
              e.number_of_judges, e.event_type, e.status, e.created_at,
              COALESCE(stat.competitor_count, 0)::int AS competitor_count
       FROM events e
       LEFT JOIN LATERAL (
         SELECT COUNT(DISTINCT s.competitor_id) AS competitor_count
         FROM scores s WHERE s.event_id = e.id
       ) stat ON true
       WHERE e.meet_id = $1
       ORDER BY
         CASE e.status
           WHEN 'Live'      THEN 0
           WHEN 'Upcoming'  THEN 1
           WHEN 'Completed' THEN 2
         END,
         e.created_at ASC`,
      [req.params.id],
    );
    res.json({ meet: meetRes.rows[0], events: eventsRes.rows });
  } catch (err) {
    console.error("[Meet Detail Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post(
  "/api/meets",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const {
      name, venue, start_date, end_date, description,
      sponsor_name, sponsor_logo_url, sponsor_link_url,
    } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Meet name is required" });
    }
    try {
      const r = await pool.query(
        `INSERT INTO meets
           (org_id, name, venue, start_date, end_date, description,
            sponsor_name, sponsor_logo_url, sponsor_link_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [
          req.user.org_id, name.trim(), venue || null,
          start_date || null, end_date || null, description || null,
          sponsor_name || null, sponsor_logo_url || null, sponsor_link_url || null,
        ],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Create Meet Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

app.put(
  "/api/meets/:id",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const {
      name, venue, start_date, end_date, description,
      sponsor_name, sponsor_logo_url, sponsor_link_url,
    } = req.body || {};
    try {
      const r = await pool.query(
        `UPDATE meets SET
           name = COALESCE($1, name),
           venue = $2,
           start_date = $3,
           end_date = $4,
           description = $5,
           sponsor_name = $6,
           sponsor_logo_url = $7,
           sponsor_link_url = $8
         WHERE id = $9 AND org_id = $10
         RETURNING *`,
        [
          name?.trim() || null, venue || null,
          start_date || null, end_date || null, description || null,
          sponsor_name || null, sponsor_logo_url || null, sponsor_link_url || null,
          req.params.id, req.user.org_id,
        ],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Meet not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Update Meet Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete(
  "/api/meets/:id",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        "DELETE FROM meets WHERE id = $1 AND org_id = $2 RETURNING id",
        [req.params.id, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Meet not found" });
      // ON DELETE SET NULL on events.meet_id means the events
      // survive and become standalone — no separate cleanup
      // needed.
      res.json({ ok: true });
    } catch (err) {
      console.error("[Delete Meet Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Assign / re-assign an event to a meet (or detach with
// meet_id = null). Manager-only — both meet and event must
// already exist in the same org.
app.put(
  "/api/events/:id/meet",
  requireEventManager(),
  async (req, res) => {
    const { meet_id } = req.body || {};
    try {
      // For non-sysadmin the meet must live in their own org.
      // sysadmin can move events between meets across any org.
      if (meet_id) {
        const m = await pool.query(
          "SELECT id, org_id FROM meets WHERE id = $1",
          [meet_id],
        );
        if (!m.rows.length) {
          return res.status(400).json({ error: "Meet not found" });
        }
        if (!req.user.is_system_admin && m.rows[0].org_id !== req.user.org_id) {
          return res
            .status(400)
            .json({ error: "Meet not found in this organisation" });
        }
      }
      const r = await pool.query(
        "UPDATE events SET meet_id = $1 WHERE id = $2 AND ($3::boolean OR org_id = $4) RETURNING *",
        [meet_id || null, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Event not found" });
      res.json(r.rows[0]);
    } catch (err) {
      console.error("[Assign Event Meet Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// =============================================================
// EVENT ROUTES
// [SECTION: ROUTES — EVENTS]
// =============================================================

app.get("/api/events", async (req, res) => {
  try {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    let result;
    // Joined to organisations so sysadmin context can see which
    // event belongs to which org. Non-sysadmin views ignore those
    // columns; anonymous users get the same shape minus the
    // restriction that they only see Live/Completed.
    const SELECT = `
      SELECT e.*, o.name AS org_name, o.country_code, o.slug AS org_slug
      FROM events e
      JOIN organisations o ON o.id = e.org_id
    `;
    if (token) {
      try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.is_system_admin) {
          // System admin sees every event across every org. The
          // frontend can group/filter by org_name.
          result = await pool.query(`${SELECT} ORDER BY e.created_at DESC`);
        } else {
          result = await pool.query(
            `${SELECT} WHERE e.org_id = $1 ORDER BY e.created_at DESC`,
            [decoded.org_id],
          );
        }
      } catch {
        result = await pool.query(
          `${SELECT} WHERE e.status IN ('Live','Completed') ORDER BY e.created_at DESC`,
        );
      }
    } else {
      result = await pool.query(
        `${SELECT} WHERE e.status IN ('Live','Completed') ORDER BY e.created_at DESC`,
      );
    }
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// STAGE ADVANCEMENT — top-N from one stage to the next
// [SECTION: ROUTES — STAGE ADVANCE]
// (preliminary → semifinal, semifinal → final, or
// preliminary → final when the meet skips the semi). The
// downstream event's roster is built from scratch; existing
// rows for the advancing competitors are wiped first so the
// action is idempotent and re-runnable after a score
// correction shifts the cutoff.
// =============================================================

app.post(
  "/api/events/:id/advance",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const client = await pool.connect();
    try {
      // Source event must exist, be in the caller's org (or
      // sysadmin), and be a feeder stage ('preliminary' or
      // 'semifinal' — only 'final' can't advance further).
      const evRes = await client.query(
        `SELECT id, org_id, event_format, advance_count
         FROM events
         WHERE id = $1 AND ($2::boolean OR org_id = $3)`,
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!evRes.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const source = evRes.rows[0];
      if (!["preliminary", "semifinal"].includes(source.event_format)) {
        return res
          .status(400)
          .json({ error: "Only preliminary or semifinal events can advance to a later stage" });
      }

      // Find the downstream event — exactly one event must
      // reference this source via parent_event_id. For a prelim
      // that's typically a 'semifinal' (or a 'final' if the
      // meet skips the semi). For a 'semifinal' it'll be a
      // 'final'.
      const nextRes = await client.query(
        "SELECT id, event_format FROM events WHERE parent_event_id = $1 LIMIT 1",
        [source.id],
      );
      if (!nextRes.rows.length) {
        const expected = source.event_format === "preliminary"
          ? "semifinal or final"
          : "final";
        return res.status(400).json({
          error: `No ${expected} event is linked to this ${source.event_format} yet`,
        });
      }
      const finalId = nextRes.rows[0].id;

      // Pull standings using the same dispatcher that drives the
      // live scoreboard — keeps "top N" identical to what the
      // audience saw at the end of the source stage.
      const standingsRes = await client.query(
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
         , event_totals AS (
           SELECT competitor_id,
                  SUM(dive_points) AS total,
                  array_agg(dive_points ORDER BY dive_points DESC) AS dives_desc
           FROM per_dive
           GROUP BY competitor_id
         )
         /* FINA tie-break in stage advancement.
            Primary key: total DESC.
            Secondary: dives_desc DESC — element-wise array
            comparison gives "highest single dive, then second-
            highest, then …" exactly as FINA prescribes.
            RANK() means two divers tied even after the tie-break
            both advance (the cutoff includes everyone at rnk=N). */
         SELECT competitor_id, total
         FROM (
           SELECT competitor_id, total, dives_desc,
                  RANK() OVER (
                    ORDER BY total DESC, dives_desc DESC
                  ) AS rnk
           FROM event_totals
         ) ranked
         WHERE rnk <= $2
         ORDER BY total DESC, dives_desc DESC, competitor_id ASC`,
        [source.id, source.advance_count || 12],
      );

      const advancing = standingsRes.rows;
      if (!advancing.length) {
        return res.status(400).json({
          error: `${source.event_format} has no scored dives yet — nothing to advance`,
        });
      }

      // Pull each advancing diver's source-stage dive list so we
      // can seed the next stage with the same dives by default.
      // The manager / divers can edit them before that stage
      // starts.
      const diveListRes = await client.query(
        `SELECT competitor_id, partner_id, team_id, dive_id, round_number
         FROM competitor_dive_lists
         WHERE event_id = $1 AND competitor_id = ANY($2::uuid[])
           AND withdrawn_at IS NULL`,
        [source.id, advancing.map((r) => r.competitor_id)],
      );

      // Idempotent re-run: wipe the final's existing dive list
      // rows for these competitors before re-inserting.
      await client.query("BEGIN");
      await client.query(
        `DELETE FROM competitor_dive_lists
         WHERE event_id = $1 AND competitor_id = ANY($2::uuid[])`,
        [finalId, advancing.map((r) => r.competitor_id)],
      );
      for (const row of diveListRes.rows) {
        await client.query(
          `INSERT INTO competitor_dive_lists
             (event_id, competitor_id, partner_id, team_id, dive_id, round_number)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            finalId,
            row.competitor_id,
            row.partner_id,
            row.team_id,
            row.dive_id,
            row.round_number,
          ],
        );
      }
      await client.query("COMMIT");

      res.json({
        ok: true,
        advanced: advancing.length,
        final_event_id: finalId,
        // Useful for the UI's confirmation message.
        leaders: advancing.slice(0, 3).map((r) => r.competitor_id),
      });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Advance Error]", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  },
);

// =============================================================
// EVENT TEMPLATES — saved configurations a manager can apply
// [SECTION: ROUTES — TEMPLATES]
// to a new event. config is the full form state as JSON.
// =============================================================

app.get(
  "/api/event-templates",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, name, config, created_at, updated_at
         FROM event_templates
         WHERE org_id = $1
         ORDER BY name ASC`,
        [req.user.org_id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Templates List Error]", err.message);
      res.status(500).json([]);
    }
  },
);

app.post(
  "/api/event-templates",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const { name, config } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ error: "Template name is required" });
    }
    if (!config || typeof config !== "object") {
      return res.status(400).json({ error: "config must be an object" });
    }
    try {
      // Upsert by (org_id, name) — re-saving overwrites the
      // existing config, lets a manager iterate without
      // duplicating templates.
      const r = await pool.query(
        `INSERT INTO event_templates (org_id, name, config, created_by, updated_at)
         VALUES ($1, $2, $3::jsonb, $4, now())
         ON CONFLICT (org_id, name)
         DO UPDATE SET
           config     = EXCLUDED.config,
           updated_at = now()
         RETURNING id, name, config, created_at, updated_at`,
        [req.user.org_id, name.trim(), JSON.stringify(config), req.user.id],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      console.error("[Template Save Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

app.delete(
  "/api/event-templates/:id",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    try {
      const r = await pool.query(
        "DELETE FROM event_templates WHERE id = $1 AND org_id = $2 RETURNING id",
        [req.params.id, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Template not found" });
      res.json({ ok: true });
    } catch (err) {
      console.error("[Template Delete Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

app.post("/api/events", requireOrgRole(["org_admin"]), async (req, res) => {
  const {
    name, gender, number_of_judges, total_rounds, height, event_type, meet_id,
    // New fields (migration 013):
    age_group, scheduled_at, event_format, parent_event_id, advance_count,
    dd_limit_rounds, dd_limit_value,
  } = req.body;
  // Synchronised pairs require 9 or 11 judges (the only panel
  // sizes World Aquatics defines exec/sync judge groups for).
  // Reject anything else early so standings later make sense.
  const type = event_type || "individual";
  if (type === "synchro_pair" && ![9, 11].includes(number_of_judges)) {
    return res.status(400).json({
      error: "Synchronised pair events require 9 or 11 judges",
    });
  }
  // Validate event_format. Three valid stages, in order:
  //   preliminary → semifinal → final
  // 'final' is the default (covers standalone events with no
  // feeder, plus the terminal stage of any chain). 'semifinal'
  // is World Aquatics' intermediate top-18 cut for individual
  // events; synchro and team meets typically skip it.
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
        : ["preliminary", "semifinal"];   // final
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
          dd_limit_rounds, dd_limit_value, scheduled_at,
          org_id, meet_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
      [
        name,
        gender,
        age_group || null,
        number_of_judges || 5,
        total_rounds || 6,
        height || null,
        type,
        fmt,
        parent_event_id || null,
        advance_count || 12,
        dd_limit_rounds || 0,
        dd_limit_value || null,
        scheduled_at || null,
        req.user.org_id,
        meet_id || null,
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
  const {
    name, gender, number_of_judges, total_rounds, height, event_type,
    age_group, scheduled_at, event_format, parent_event_id, advance_count,
    dd_limit_rounds, dd_limit_value,
  } = req.body;
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
    // System admins can edit events in any org — the boolean
    // short-circuits the org filter without losing the index
    // on org_id for normal traffic.
    // COALESCE on the new fields means undefined inputs leave
    // the existing column untouched, so partial PUTs (e.g. just
    // updating the schedule) keep working.
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
         scheduled_at     = $13
       WHERE id=$14 AND ($15::boolean OR org_id=$16) RETURNING *`,
      [
        name || null,
        gender || null,
        number_of_judges || null,
        total_rounds || null,
        height || null,
        event_type || null,
        age_group ?? null,
        event_format || null,
        parent_event_id ?? null,
        advance_count || null,
        dd_limit_rounds ?? null,
        dd_limit_value ?? null,
        scheduled_at ?? null,
        req.params.id,
        !!req.user.is_system_admin,
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
      // sysadmin bypasses the org filter; org_admin scoped to own org
      await pool.query(
        "DELETE FROM events WHERE id=$1 AND ($2::boolean OR org_id=$3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
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
    // Read the previous status before the update so we know which
    // notification (if any) to fire. sysadmin sees every org's events.
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

    // Notify competitors on the meaningful transitions:
    //   * → Live      = "your meet just started"
    //   * → Completed = "results are posted"
    // Best-effort, so they never block the response.
    if (previousStatus !== status) {
      if (status === "Live")      sendEventStartedEmails(r.rows[0]).catch(() => {});
      if (status === "Completed") sendEventResultsEmails(r.rows[0]).catch(() => {});
    }

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
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
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
      // The user being added must be in the same org as the event.
      // Prevents a meet manager from elevating a foreign-org user
      // into a managerial role on this event.
      if (!(await isInSameOrg(pool, req.event.org_id, user_id, "users"))) {
        return res.status(400).json({ error: "User is not in this event's organisation" });
      }
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
// [SECTION: ROUTES — JUDGES]
// =============================================================

app.get(
  "/api/events/:eventId/judges",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "eventId"))) return;
      // Joined to users so the Control Room can label each judge
      // tile with the actual person's name (helps the meet
      // referee chase a slow submitter without checking the
      // org panel separately).
      const r = await pool.query(
        `SELECT ej.judge_id, ej.judge_number, u.full_name
         FROM event_judges ej
         JOIN users u ON u.id = ej.judge_id
         WHERE ej.event_id = $1
         ORDER BY ej.judge_number ASC`,
        [req.params.eventId],
      );
      res.json(r.rows); // [{ judge_id, judge_number, full_name }, ...]
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

app.post("/api/events/:id/judges", requireEventManager(), async (req, res) => {
  const { judgeIds } = req.body; // ordered array — position = judge number
  if (!Array.isArray(judgeIds)) {
    return res.status(400).json({ error: "judgeIds must be an array" });
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Every judge must belong to the event's org. One foreign judge
    // means we reject the whole assignment — easier to surface the
    // error than to silently drop part of the panel.
    for (const jid of judgeIds) {
      if (!(await isInSameOrg(client, req.event.org_id, jid, "users"))) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "All judges must belong to the event's organisation" });
      }
    }
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
// [SECTION: ROUTES — CONTROL ROOM]
// =============================================================

app.get(
  "/api/events/:id/roster",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    try {
      // Returns the dive list rows with each row's id (so the
      // operator can target it for reorder / withdraw),
      // display_order (used for sort), and withdrawn_at (so the
      // UI can render scratched divers separately).
      // Withdrawn rows are returned but flagged — Control Room
      // hides them from the active queue while the manager can
      // still see + reinstate them.
      const r = await pool.query(
        `SELECT cdl.id AS dive_list_id,
                cdl.display_order, cdl.withdrawn_at,
                u.id AS competitor_id, u.full_name, o.country_code,
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
         ORDER BY cdl.round_number ASC,
                  t.name ASC NULLS LAST,
                  cdl.display_order ASC NULLS LAST,
                  u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Roster Error]", err.message);
      res.status(500).json([]);
    }
  },
);

// Reorder a dive list row within its round. Body: { display_order: int }
// The operator either nudges with arrows (compute next/prev) or
// drags. We don't normalise the whole round on every move — the
// roster query orders by display_order NULLS LAST so non-reordered
// rows just float to the bottom of the round in name order.
app.put(
  "/api/dive-lists/:id/order",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    const { display_order } = req.body || {};
    if (display_order != null && !Number.isInteger(display_order)) {
      return res.status(400).json({ error: "display_order must be an integer or null" });
    }
    try {
      // Look up the row's event so we can both gate on org and on
      // pre-meet status. Reorder is locked once the event flips
      // out of 'Upcoming' — operators withdraw scratchers instead.
      const owner = await pool.query(
        `SELECT e.id, e.status, e.name, e.org_id
         FROM competitor_dive_lists cdl
         JOIN events e ON e.id = cdl.event_id
         WHERE cdl.id = $1`,
        [req.params.id],
      );
      if (!owner.rows.length) {
        return res.status(404).json({ error: "Dive list row not found" });
      }
      const ev = owner.rows[0];
      if (!req.user.is_system_admin && ev.org_id !== req.user.org_id) {
        return res.status(403).json({ error: "Event is not in your organisation" });
      }
      if (ev.status !== "Upcoming") {
        return res.status(409).json({
          error:
            `Cannot change the dive order once "${ev.name}" has started ` +
            `(status is ${ev.status}). Withdraw a diver instead if they ` +
            `need to be skipped.`,
          event_status: ev.status,
        });
      }
      const r = await pool.query(
        `UPDATE competitor_dive_lists cdl
         SET display_order = $1
         WHERE cdl.id = $2
         RETURNING cdl.id, cdl.display_order`,
        [display_order ?? null, req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Dive list row not found" });
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Reorder Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Bulk reorder — drag-and-drop in the Control Room sends the entire
// new ordering for one round in a single request. Cheaper than N
// per-row PUTs and atomic against partial failures.
//
// Body: { rows: [{ id: <uuid>, display_order: <int> }, ...] }
// Each id must belong to the event in the URL; rows from other
// events are silently rejected. Sysadmin bypass on org match.
app.put(
  "/api/events/:id/dive-lists/reorder",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    const eventId = req.params.id;
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rows || !rows.length) {
      return res.status(400).json({ error: "rows must be a non-empty array" });
    }
    if (rows.length > 500) {
      return res.status(413).json({ error: "Too many rows in one request" });
    }
    for (const r of rows) {
      if (!r || typeof r.id !== "string"
          || !Number.isInteger(r.display_order)) {
        return res.status(400).json({ error: "Each row needs id (uuid) + integer display_order" });
      }
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Confirm the event exists in the caller's org and is still
      // pre-meet. Once status flips to Live/Completed the start
      // order is fixed — operators withdraw divers instead.
      const ev = await client.query(
        "SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Event not found" });
      }
      if (ev.rows[0].status !== "Upcoming") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error:
            `Cannot re-order divers once "${ev.rows[0].name}" has started ` +
            `(status is ${ev.rows[0].status}). Withdraw a diver instead if they ` +
            `need to be skipped.`,
          event_status: ev.rows[0].status,
        });
      }
      let updated = 0;
      for (const r of rows) {
        const u = await client.query(
          `UPDATE competitor_dive_lists
           SET display_order = $1
           WHERE id = $2 AND event_id = $3`,
          [r.display_order, r.id, eventId],
        );
        updated += u.rowCount;
      }
      await client.query("COMMIT");
      res.json({ ok: true, updated });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Bulk Reorder Error]", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  },
);

// Randomise start order — shuffles every diver's position before
// the event starts. Each unique competitor gets one random position
// applied to every round they're in, so "Diver Z dives 1st" stays
// consistent across rounds. Operators can re-run as many times as
// they like until they're happy. Locked once the event flips to
// Live/Completed — at that point the published start order is
// committed and shuffling would invalidate scoreboards.
app.post(
  "/api/events/:id/dive-lists/randomize",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    const eventId = req.params.id;
    try {
      const ev = await pool.query(
        "SELECT id, status, name FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [eventId, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      if (ev.rows[0].status !== "Upcoming") {
        return res.status(409).json({
          error:
            `Cannot randomise the start order once "${ev.rows[0].name}" has started ` +
            `(status is ${ev.rows[0].status}). The published order is now fixed.`,
          event_status: ev.rows[0].status,
        });
      }

      // Pick a random ordering of the unique competitors, then
      // apply that ordering across every round in one UPDATE.
      // Withdrawn rows are excluded from the shuffle pool but
      // still get a display_order assigned via the JOIN — they
      // just sort to the end of their slot when reinstated.
      const r = await pool.query(
        `WITH shuffled AS (
           SELECT DISTINCT competitor_id,
                  ROW_NUMBER() OVER (ORDER BY random()) AS pos
           FROM competitor_dive_lists
           WHERE event_id = $1 AND withdrawn_at IS NULL
         )
         UPDATE competitor_dive_lists cdl
         SET display_order = sh.pos
         FROM shuffled sh
         WHERE cdl.event_id = $1
           AND cdl.competitor_id = sh.competitor_id
         RETURNING cdl.id`,
        [eventId],
      );
      res.json({ ok: true, updated: r.rowCount });
    } catch (err) {
      console.error("[Randomize Order Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Withdraw / reinstate a dive list row. Sets withdrawn_at = now()
// or NULL. Standings still attribute prior dives to the diver,
// but the active queue excludes them from upcoming rounds.
app.put(
  "/api/dive-lists/:id/withdraw",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    const { withdrawn } = req.body || {};
    try {
      const r = await pool.query(
        `UPDATE competitor_dive_lists cdl
         SET withdrawn_at = CASE WHEN $1::boolean THEN now() ELSE NULL END
         FROM events e
         WHERE cdl.id = $2 AND cdl.event_id = e.id
           AND ($3::boolean OR e.org_id = $4)
         RETURNING cdl.id, cdl.withdrawn_at`,
        [!!withdrawn, req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!r.rows.length) return res.status(404).json({ error: "Dive list row not found" });
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Withdraw Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// =============================================================
// CHECK-IN / ATTENDANCE — pre-meet door pass (migration 016).
// Operators flip a Present / Late / Absent chip per diver. Status
// is per-(event, competitor); the absence of a row means "not yet
// checked in" so the operator can see who hasn't been ticked off.
// =============================================================

// List every distinct competitor in the event with their current
// attendance status. Joined to the competitor_dive_lists so we
// don't have to maintain a separate "entry" table.
app.get(
  "/api/events/:id/attendance",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const r = await pool.query(
        `SELECT u.id AS competitor_id, u.full_name,
                o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                ea.status::text  AS status,
                ea.set_at,
                actor.full_name  AS set_by_name
         FROM (
           SELECT DISTINCT competitor_id
           FROM competitor_dive_lists WHERE event_id = $1
         ) entry
         JOIN users u           ON u.id = entry.competitor_id
         JOIN organisations o   ON o.id = u.org_id
         LEFT JOIN clubs cl     ON cl.id = u.club_id
         LEFT JOIN event_attendance ea
           ON ea.event_id = $1 AND ea.competitor_id = u.id
         LEFT JOIN users actor  ON actor.id = ea.set_by
         ORDER BY u.full_name ASC`,
        [req.params.id],
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Attendance List Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Set / clear a diver's attendance status. PUT body { status }
// where status ∈ {present, late, absent} or null to clear. Audit-
// stamped via set_at + set_by.
app.put(
  "/api/events/:id/attendance/:competitorId",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    try {
      if (!(await ensureEventOrgGate(req, res, "id"))) return;
      const { status } = req.body || {};
      const VALID = new Set(["present", "late", "absent"]);
      if (status != null && !VALID.has(status)) {
        return res.status(400).json({ error: "status must be present | late | absent | null" });
      }
      if (status == null) {
        await pool.query(
          `DELETE FROM event_attendance
           WHERE event_id = $1 AND competitor_id = $2`,
          [req.params.id, req.params.competitorId],
        );
        return res.json({ ok: true, status: null });
      }
      const r = await pool.query(
        `INSERT INTO event_attendance (event_id, competitor_id, status, set_by)
         VALUES ($1, $2, $3::attendance_status, $4)
         ON CONFLICT (event_id, competitor_id)
         DO UPDATE SET status = EXCLUDED.status,
                       set_at = now(),
                       set_by = EXCLUDED.set_by
         RETURNING status::text AS status, set_at`,
        [req.params.id, req.params.competitorId, status, req.user.id],
      );
      res.json({ ok: true, ...r.rows[0] });
    } catch (err) {
      console.error("[Attendance Set Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Late-entry: add a dive list row from the Control Room. Used
// when a diver shows up but didn't pre-submit. Single-row
// version of the existing CSV import — pick competitor + dive
// + round, server inserts.
app.post(
  "/api/events/:id/roster",
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const { competitor_id, dive_id, round_number, partner_id, team_id } = req.body || {};
    if (!competitor_id || !dive_id || !round_number) {
      return res.status(400).json({
        error: "competitor_id, dive_id, and round_number are required",
      });
    }
    try {
      // Org guard: event must be in the caller's org (or any org
      // for sysadmin). Competitor must belong to the event's org
      // — sysadmin still has to keep divers org-scoped to keep
      // standings sane.
      const ev = await pool.query(
        "SELECT id, org_id FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const eventOrgId = ev.rows[0].org_id;

      const u = await pool.query(
        "SELECT id, org_id FROM users WHERE id = $1",
        [competitor_id],
      );
      if (!u.rows.length || u.rows[0].org_id !== eventOrgId) {
        return res.status(400).json({ error: "Competitor must belong to this organisation" });
      }

      const r = await pool.query(
        `INSERT INTO competitor_dive_lists
           (event_id, competitor_id, dive_id, round_number, partner_id, team_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id, competitor_id, round_number)
         DO UPDATE SET dive_id = EXCLUDED.dive_id,
                       partner_id = EXCLUDED.partner_id,
                       team_id = EXCLUDED.team_id,
                       withdrawn_at = NULL
         RETURNING id`,
        [req.params.id, competitor_id, dive_id, round_number, partner_id || null, team_id || null],
      );
      res.status(201).json({ ok: true, dive_list_id: r.rows[0].id });
    } catch (err) {
      console.error("[Late Entry Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// Roster CSV import. Manager pastes a CSV with one diver per
// row plus a column per round (dive_code + position). The
// server parses, validates each diver exists in the org, looks
// up each dive in the directory, and inserts dive list rows in
// a single transaction. Per-row errors are returned without
// failing the whole import.
//
// Expected CSV shape (header row required):
//   username,partner_username,round_1_code,round_1_pos,round_2_code,round_2_pos,...
// partner_username is optional (only used for synchro events).
app.post(
  "/api/events/:id/roster/import",
  bulkWriteLimiter,
  requireOrgRole(["org_admin", "meet_manager"]),
  async (req, res) => {
    const { csv } = req.body || {};
    if (typeof csv !== "string" || !csv.trim()) {
      return res.status(400).json({ error: "csv body field is required" });
    }
    // Hard cap on CSV size — anything past this is either a bug or
    // an attempt to lock the table inside the import transaction.
    if (csv.length > 200_000) {
      return res.status(413).json({ error: "CSV is too large (max ~200KB / a few thousand rows)." });
    }
    const client = await pool.connect();
    try {
      // Look up the event so we know its height + total_rounds
      // before parsing — both feed into dive lookup. sysadmin
      // can import rosters into any org's event.
      const ev = await client.query(
        "SELECT id, org_id, height, total_rounds, event_type FROM events WHERE id = $1 AND ($2::boolean OR org_id = $3)",
        [req.params.id, !!req.user.is_system_admin, req.user.org_id],
      );
      if (!ev.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      const event = ev.rows[0];
      const heightNumeric = event.height ? parseFloat(event.height) : null;

      const rows = parseCsv(csv);
      if (!rows.length) {
        return res.status(400).json({ error: "CSV had no data rows" });
      }
      const header = rows.shift().map((h) => h.trim().toLowerCase());
      const userIdx     = header.indexOf("username");
      const partnerIdx  = header.indexOf("partner_username");
      if (userIdx < 0) {
        return res
          .status(400)
          .json({ error: 'CSV must include a "username" column' });
      }
      // Round columns: round_N_code + round_N_pos pairs.
      const roundCols = [];
      for (let n = 1; n <= 12; n++) {
        const ci = header.indexOf(`round_${n}_code`);
        const pi = header.indexOf(`round_${n}_pos`);
        if (ci >= 0 && pi >= 0) roundCols.push({ round: n, codeIdx: ci, posIdx: pi });
      }
      if (!roundCols.length) {
        return res
          .status(400)
          .json({ error: 'CSV must include at least one round_N_code + round_N_pos pair' });
      }

      const stats = { added: 0, skipped: 0, errors: [] };
      await client.query("BEGIN");

      for (const row of rows) {
        const username = (row[userIdx] || "").trim();
        if (!username) { stats.skipped++; continue; }
        try {
          const u = await client.query(
            "SELECT id FROM users WHERE username = $1 AND org_id = $2",
            [username, event.org_id],
          );
          if (!u.rows.length) {
            stats.errors.push({ username, error: "User not found in this org" });
            continue;
          }
          const competitorId = u.rows[0].id;

          let partnerId = null;
          if (partnerIdx >= 0) {
            const partnerName = (row[partnerIdx] || "").trim();
            if (partnerName) {
              const p = await client.query(
                "SELECT id FROM users WHERE username = $1 AND org_id = $2",
                [partnerName, event.org_id],
              );
              if (!p.rows.length) {
                stats.errors.push({ username, error: `Partner ${partnerName} not found` });
                continue;
              }
              partnerId = p.rows[0].id;
            }
          }

          // Resolve each round's dive in the directory.
          for (const { round, codeIdx, posIdx } of roundCols) {
            const code = (row[codeIdx] || "").trim();
            const pos  = (row[posIdx]  || "").trim().toUpperCase();
            if (!code || !pos) continue;
            const d = await client.query(
              `SELECT id FROM dive_directory
               WHERE dive_code = $1 AND position = $2::dive_position
                 AND ($3::numeric IS NULL OR height = $3::numeric)`,
              [code, pos, heightNumeric],
            );
            if (!d.rows.length) {
              stats.errors.push({
                username,
                error: `Round ${round}: ${code}${pos} not in directory${heightNumeric ? ` for ${event.height}` : ""}`,
              });
              continue;
            }
            await client.query(
              `INSERT INTO competitor_dive_lists (event_id, competitor_id, partner_id, dive_id, round_number)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (event_id, competitor_id, round_number)
               DO UPDATE SET dive_id = EXCLUDED.dive_id, partner_id = EXCLUDED.partner_id`,
              [event.id, competitorId, partnerId, d.rows[0].id, round],
            );
          }
          stats.added++;
        } catch (rowErr) {
          stats.errors.push({ username, error: rowErr.message });
        }
      }

      await client.query("COMMIT");
      res.json(stats);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Roster Import Error]", err.message);
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  },
);

// Light CSV parser. Handles "quoted, fields", "doubled""quotes"
// inside quoted fields, and trailing/leading whitespace. Doesn't
// pull a dependency for what's a 30-line job; the input is
// always small (a meet roster, not a database export).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuoted = false;
      } else {
        field += ch;
      }
    } else {
      if (ch === '"') {
        inQuoted = true;
      } else if (ch === ",") {
        row.push(field); field = "";
      } else if (ch === "\n" || ch === "\r") {
        if (ch === "\r" && text[i + 1] === "\n") i++;
        if (field.length || row.length) { row.push(field); rows.push(row); }
        row = []; field = "";
      } else {
        field += ch;
      }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ""));
}

app.get("/api/events/:id/history", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT u.full_name AS "diverName", o.country_code, cl.name AS club_name,
              pu.full_name AS partner_name,
              s.competitor_id, s.event_id, s.round_number,
              d.dive_code, d.position, d.dd, d.description,
              calc_event_dive_points(
                array_agg(ej.judge_number ORDER BY ej.judge_number),
                array_agg(s.score ORDER BY ej.judge_number),
                e.number_of_judges, d.dd, e.event_type,
                BOOL_OR(cdl.partner_id IS NOT NULL)
) AS total_points,
              JSON_AGG(s.score ORDER BY s.judge_id) AS judge_scores,
              JSON_AGG(s.id    ORDER BY s.judge_id) AS score_ids,
              JSON_AGG(ej.judge_number ORDER BY s.judge_id) AS judge_numbers
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
                s.competitor_id, s.event_id, s.round_number,
                d.dive_code, d.position, d.dd, d.description,
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
// [SECTION: ROUTES — SCOREBOARD]
// Endpoints (/api/scoreboard/:eventId and /leaderboard) moved
// to routes/scoreboard.js. The dive-list-templates section
// below sits between the two original mounts and is kept here
// since it's per-diver state, not scoreboard-related.
// =============================================================

app.use(require("./routes/scoreboard")({ pool }));

// =============================================================
// SCORE CORRECTION
// [SECTION: ROUTES — SCOREBOARD]
// Manager / referee amends a previously-submitted score (judge
// typo, scoring dispute resolution). Goes through the same
// score_audit_log plumbing the live submit path uses, then
// broadcasts a `score_corrected` socket event so any live
// scoreboard / Control Room re-fetches the standings.
// =============================================================

app.put(
  "/api/scores/:id",
  requireOrgRole(["org_admin", "meet_manager", "referee"]),
  async (req, res) => {
    const { score, reason } = req.body || {};
    const newScore = Number(score);
    if (Number.isNaN(newScore) || newScore < 0 || newScore > 10) {
      return res.status(400).json({ error: "Score must be between 0 and 10" });
    }
    if (((newScore * 2) % 1) !== 0) {
      return res.status(400).json({ error: "Score must be in 0.5 increments" });
    }
    try {
      const prior = await pool.query(
        "SELECT id, score, event_id, competitor_id, judge_id, round_number FROM scores WHERE id = $1",
        [req.params.id],
      );
      if (!prior.rows.length) {
        return res.status(404).json({ error: "Score not found" });
      }
      const existing = prior.rows[0];

      // Org guard: the score must belong to an event in the
      // caller's org. sysadmin can correct scores in any org.
      const ev = await pool.query(
        "SELECT org_id FROM events WHERE id = $1",
        [existing.event_id],
      );
      if (!ev.rows.length) {
        return res.status(404).json({ error: "Event not found" });
      }
      if (!req.user.is_system_admin && ev.rows[0].org_id !== req.user.org_id) {
        return res.status(403).json({ error: "Cannot correct scores in other organisations" });
      }

      const oldScore = Number(existing.score);
      if (oldScore === newScore) {
        return res.json({ ok: true, unchanged: true });
      }

      await pool.query("UPDATE scores SET score = $1 WHERE id = $2", [newScore, existing.id]);
      try {
        await pool.query(
          `INSERT INTO score_audit_log
             (score_id, event_id, competitor_id, judge_id, round_number,
              action, old_score, new_score, actor_user_id, ip_address, user_agent)
           VALUES ($1,$2,$3,$4,$5,'update',$6,$7,$8,$9,$10)`,
          [
            existing.id, existing.event_id, existing.competitor_id,
            existing.judge_id, existing.round_number,
            oldScore, newScore, req.user.id,
            req.ip, req.headers["user-agent"] || null,
          ],
        );
      } catch (auditErr) {
        console.error("[Score Correction Audit Skipped]", auditErr.message);
      }

      // Broadcast so live consumers re-pull standings. Spectators
      // viewing the recap or live scoreboard will see the
      // corrected total without a manual refresh.
      io.emit("score_corrected", {
        event_id: existing.event_id,
        competitor_id: existing.competitor_id,
        round_number: existing.round_number,
        score_id: existing.id,
        old_score: oldScore,
        new_score: newScore,
        reason: reason || null,
        actor_user_id: req.user.id,
      });

      res.json({ ok: true, old_score: oldScore, new_score: newScore });
    } catch (err) {
      console.error("[Score Correction Error]", err.message);
      res.status(500).json({ error: err.message });
    }
  },
);

// =============================================================
// MEET HOLD STATE
// [SECTION: MEET HOLD STATE]
// In-memory map: event_id → { reason, since }. The Control
// Room toggles it via socket events; the Scoreboard and
// Judge views render a banner while held. Cleared on
// 'meet_resume' or when the event finalises.
// =============================================================
const meetHolds = {};


// =============================================================
// DIVE LIST TEMPLATES — per-diver saved combinations
// [SECTION: ROUTES — DIVE TEMPLATES]
// =============================================================

app.get("/api/templates", verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, height, dives, created_at, updated_at
       FROM dive_list_templates
       WHERE user_id = $1
       ORDER BY updated_at DESC`,
      [req.user.id],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[Templates List Error]", err.message);
    res.status(500).json([]);
  }
});

app.post("/api/templates", verifyToken, async (req, res) => {
  const { name, height, dives } = req.body || {};
  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Template name is required" });
  }
  if (!Array.isArray(dives)) {
    return res.status(400).json({ error: "dives must be an array" });
  }
  try {
    const r = await pool.query(
      `INSERT INTO dive_list_templates (user_id, name, height, dives, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, now())
       ON CONFLICT (user_id, name)
       DO UPDATE SET
         height     = EXCLUDED.height,
         dives      = EXCLUDED.dives,
         updated_at = now()
       RETURNING id, name, height, dives, created_at, updated_at`,
      [req.user.id, name.trim(), height || null, JSON.stringify(dives)],
    );
    res.status(201).json(r.rows[0]);
  } catch (err) {
    console.error("[Template Save Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/templates/:id", verifyToken, async (req, res) => {
  try {
    const r = await pool.query(
      "DELETE FROM dive_list_templates WHERE id = $1 AND user_id = $2 RETURNING id",
      [req.params.id, req.user.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: "Template not found" });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Template Delete Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// COMPETITOR ROUTES
// [SECTION: ROUTES — COMPETITOR]
// =============================================================

app.post(
  "/api/competitor/submit-list",
  bulkWriteLimiter,
  requireOrgRole(["diver"]),
  async (req, res) => {
    const { event_id, dives, partner_id } = req.body;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // First confirm the event exists and belongs to the diver's
      // own organisation. Without this, a diver could submit a list
      // against any event ID they can guess and pollute another
      // org's roster.
      const evRes = await client.query(
        "SELECT event_type, org_id, total_rounds FROM events WHERE id = $1",
        [event_id],
      );
      if (!evRes.rows.length) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Event not found" });
      }
      if (evRes.rows[0].org_id !== req.user.org_id && !req.user.is_system_admin) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Event is not in your organisation" });
      }
      const eventType = evRes.rows[0].event_type || "individual";
      const totalRounds = Number(evRes.rows[0].total_rounds) || null;

      // Sanity-check the dives array — must be a non-empty list of
      // {dive_id, round_number} with no duplicate rounds and round
      // numbers within range.
      if (!Array.isArray(dives) || !dives.length) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "dives must be a non-empty array" });
      }
      const seenRounds = new Set();
      for (const d of dives) {
        const rn = Number(d?.round_number);
        if (!Number.isInteger(rn) || rn < 1) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Each dive needs an integer round_number ≥ 1" });
        }
        if (totalRounds && rn > totalRounds) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `round_number ${rn} exceeds total_rounds ${totalRounds}` });
        }
        if (seenRounds.has(rn)) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: `Duplicate round_number ${rn}` });
        }
        seenRounds.add(rn);
        if (!d.dive_id) {
          await client.query("ROLLBACK");
          return res.status(400).json({ error: "Each dive needs a dive_id" });
        }
      }

      // For synchro events, validate the partner exists, isn't
      // the user themselves, and is a diver in the same org.
      let resolvedPartnerId = null;
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
// [SECTION: ROUTES — DIVE DIRECTORY]
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
// DIVER PROFILE & HISTORY
// [SECTION: ROUTES — DIVER PROFILE]
// Stats compiled from the diver's score history across all events
// in the directory: personal best per dive, average DD attempted,
// recent meets and a chronological score trend.
//
// Visible to the diver themself, to org_admin/meet_manager within
// the diver's org, and to system_admin.
// =============================================================

async function canViewDiverProfile(viewer, diverRow) {
  // Any authenticated user can view another diver's competitive
  // profile — the data (per-meet totals, personal bests, dive
  // history) is already publicly listed on the meet scoreboards
  // and the archive. Cross-org comparison was the explicit user
  // request that drove this loosening.
  return !!viewer;
}

// True when the viewer can see diver-private fields (UI preferences,
// dashboard layout, etc.) on top of the public competitive history.
// This is the OLD canViewDiverProfile rule; we apply it inline in
// the handler to redact `dashboard_widgets` for outside viewers.
function canViewDiverPrivate(viewer, diverRow) {
  if (!viewer) return false;
  if (viewer.is_system_admin) return true;
  if (viewer.id === diverRow.id) return true;
  if (viewer.org_id !== diverRow.org_id) return false;
  const roles = viewer.org_roles || [];
  return roles.includes("org_admin") || roles.includes("meet_manager") || roles.includes("coach");
}

// parseDateRange lives in lib/middleware.js — imported at the top.

app.get("/api/divers/:id/profile", verifyToken, async (req, res) => {
  try {
    let dateRange;
    try { dateRange = parseDateRange(req.query); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    const { from: fromDate, to: toDate } = dateRange;

    const diverRes = await pool.query(
      `SELECT u.id, u.full_name, u.org_id, o.name AS org_name, o.country_code,
              u.club_id, cl.name AS club_name, cl.short_code AS club_code,
              u.dashboard_widgets
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

    // Date-range filter pushed into every aggregate. $2/$3 are nullable;
    // when null the AND clause is a no-op so unfiltered callers still work.
    const DATE_FILTER = `
      AND ($2::date IS NULL OR e.created_at >= $2::date)
      AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')`;

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
         ${DATE_FILTER}
         GROUP BY s.event_id, s.round_number, e.number_of_judges, e.event_type
       )
       SELECT
         COUNT(DISTINCT event_id)::int AS total_meets,
         COUNT(*)::int                 AS total_dives,
         AVG(dd)::numeric(4,2)         AS avg_dd,
         MAX(dive_total)::numeric(6,2) AS best_single_dive
       FROM dive_totals`,
      [req.params.id, fromDate, toDate],
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
         ${DATE_FILTER}
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
      [req.params.id, fromDate, toDate],
    );

    // Score trend: per-event total + final placing, oldest first
    // so a chart can plot it as a line. Both totals and rankings
    // use World Aquatics dive points (trimmed × DD × scaling).
    const trend = await pool.query(
      `WITH diver_events AS (
         SELECT DISTINCT s.event_id
         FROM scores s
         JOIN events e ON e.id = s.event_id
         WHERE s.competitor_id = $1
         ${DATE_FILTER}
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
      [req.params.id, fromDate, toDate],
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
      // Only return the diver's saved dashboard layout to viewers
      // who own it (or sit above them in the same org). To outside
      // viewers it's irrelevant noise that also leaks a UI
      // preference, so we omit the key entirely.
      ...(canViewDiverPrivate(req.user, diver)
        ? {
            dashboard_widgets: diver.dashboard_widgets ||
              ["score_trend", "personal_bests", "recent_form", "placings"],
          }
        : {}),
    });
  } catch (err) {
    console.error("[Diver Profile Error]", err.message);
    res.status(500).json({ error: "Failed to load diver profile" });
  }
});

// =============================================================
// DIVER ANALYTICS — composable widgets the diver enables on
// [SECTION: ROUTES — DIVER PROFILE]
// their own profile. Each query is a small rollup of existing
// scores; computed in parallel and returned as a single payload
// so the frontend just toggles which widget renders.
// =============================================================

app.get("/api/divers/:id/analytics", verifyToken, async (req, res) => {
  try {
    let dateRange;
    try { dateRange = parseDateRange(req.query); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
    const { from: fromDate, to: toDate } = dateRange;

    const diverRes = await pool.query(
      "SELECT id, org_id FROM users WHERE id = $1",
      [req.params.id],
    );
    if (!diverRes.rows.length) {
      return res.status(404).json({ error: "Diver not found" });
    }
    if (!(await canViewDiverProfile(req.user, diverRes.rows[0]))) {
      return res.status(403).json({ error: "Not permitted to view this profile" });
    }
    const id = req.params.id;
    const orgId = diverRes.rows[0].org_id;

    // CTE used by every widget: per-dive totals via the official
    // calc function. Building it once and reusing in WITH would
    // be ideal, but pg can't reuse CTEs across separate queries,
    // and inlining keeps each rollup independent and cheap.
    //
    // $1 = competitor_id, $2 = from_date (nullable), $3 = to_date (nullable).
    // The CTE itself lives in db/queries.js so a fix to the dive-points
    // logic only has to land in one place.
    const PER_DIVE = SHARED_PER_DIVE;

    // Wrap each rollup so one bad query doesn't take down the whole
    // payload. Anything that throws is logged with its label and
    // returns []; the response then renders empty for that widget
    // and the rest of the dashboard still works. This used to be a
    // straight Promise.all which meant a syntax issue in any one
    // query produced a 500 with all 10 widgets stuck on "Loading…".
    const runQuery = async (label, sql, params) => {
      try {
        const r = await pool.query(sql, params);
        return r.rows;
      } catch (err) {
        console.error(`[Analytics ${label}]`, err.message);
        return [];
      }
    };

    const queries = await Promise.all([
      // RECENT FORM — last 5 meets the diver competed in, with
      // their final placing AGAINST THE FULL FIELD. The previous
      // version ranked over event_totals built from a CTE that
      // was already filtered to just this diver, so rank came out
      // 1 every time and field_size was always 1. We now build a
      // separate per_dive that includes every competitor in the
      // diver's events, rank within that, then filter to the
      // diver at the very end. Same fix applied to year_over_year.
      runQuery("recent_form",
        `WITH ${FULL_FIELD_RANKING}
         SELECT e.id AS event_id, e.name AS event_name, e.created_at,
                r.total, r.rank,
                (SELECT COUNT(DISTINCT competitor_id) FROM event_totals et2
                 WHERE et2.event_id = e.id) AS field_size
         FROM ranked r
         JOIN events e ON e.id = r.event_id
         WHERE r.competitor_id = $1
         ORDER BY e.created_at DESC
         LIMIT 5`,
        [id, fromDate, toDate],
      ),

      // PLACINGS — counts of medals + finalist + further-back
      // results. As with recent_form, ranks against the full field
      // via FULL_FIELD_RANKING; the previous self-filtered version
      // claimed every meet was a gold.
      runQuery("placings",
        `WITH ${FULL_FIELD_RANKING}
         SELECT
           COUNT(*) FILTER (WHERE rank = 1)::int AS gold,
           COUNT(*) FILTER (WHERE rank = 2)::int AS silver,
           COUNT(*) FILTER (WHERE rank = 3)::int AS bronze,
           COUNT(*) FILTER (WHERE rank BETWEEN 4 AND 8)::int  AS finalist,
           COUNT(*) FILTER (WHERE rank > 8)::int              AS further,
           COUNT(*)::int                                      AS total_meets
         FROM ranked WHERE competitor_id = $1`,
        [id, fromDate, toDate],
      ),

      // HEIGHT BREAKDOWN — avg + best dive total per board height
      runQuery("height_breakdown",
        `WITH per_dive AS (${PER_DIVE})
         SELECT height,
                COUNT(*)::int                    AS dive_count,
                AVG(dive_total)::numeric(6,2)    AS avg_score,
                MAX(dive_total)::numeric(6,2)    AS best_score
         FROM per_dive
         WHERE competitor_id = $1 AND height IS NOT NULL
         GROUP BY height
         ORDER BY height ASC`,
        [id, fromDate, toDate],
      ),

      // ROUND STAMINA — average dive total by round number.
      // Tells the diver whether they fade in later rounds.
      runQuery("round_stamina",
        `WITH per_dive AS (${PER_DIVE})
         SELECT round_number,
                COUNT(*)::int                  AS dive_count,
                AVG(dive_total)::numeric(6,2)  AS avg_score
         FROM per_dive
         WHERE competitor_id = $1
         GROUP BY round_number
         ORDER BY round_number ASC`,
        [id, fromDate, toDate],
      ),

      // QUALITY MIX — distribution of individual judge scores
      // bucketed into FINA categories. Mirrors the colour
      // categories used on the live scoreboard chips. Joined to
      // events so the date-range filter applies the same way.
      runQuery("quality_mix",
        `SELECT
           COUNT(*) FILTER (WHERE s.score = 0)::int                       AS failed,
           COUNT(*) FILTER (WHERE s.score > 0   AND s.score <= 2.0)::int AS deficient,
           COUNT(*) FILTER (WHERE s.score > 2.0 AND s.score <= 4.5)::int AS unsatisfactory,
           COUNT(*) FILTER (WHERE s.score > 4.5 AND s.score <= 6.0)::int AS satisfactory,
           COUNT(*) FILTER (WHERE s.score > 6.0 AND s.score <= 8.0)::int AS good,
           COUNT(*) FILTER (WHERE s.score > 8.0 AND s.score <= 9.5)::int AS very_good,
           COUNT(*) FILTER (WHERE s.score > 9.5)::int                     AS excellent,
           COUNT(*)::int                                                  AS total
         FROM scores s
         JOIN events e ON e.id = s.event_id
         WHERE s.competitor_id = $1
           AND ($2::date IS NULL OR e.created_at >= $2::date)
           AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')`,
        [id, fromDate, toDate],
      ),

      // DD RISK PROFILE — average DD attempted, max DD, average
      // dive total at the highest-DD bucket. Helps a diver gauge
      // whether bigger-DD dives pay off vs. lower-DD safer ones.
      runQuery("dd_risk",
        `WITH per_dive AS (${PER_DIVE})
         SELECT
           AVG(dd)::numeric(4,2)         AS avg_dd,
           MAX(dd)::numeric(4,2)         AS max_dd,
           AVG(dive_total)::numeric(6,2) AS avg_score,
           AVG(dive_total) FILTER (WHERE dd >= (SELECT MAX(dd) - 0.3 FROM per_dive WHERE competitor_id = $1))::numeric(6,2)
                                         AS avg_score_at_highest_dd,
           COUNT(*) FILTER (WHERE dd >= (SELECT MAX(dd) - 0.3 FROM per_dive WHERE competitor_id = $1))::int
                                         AS attempts_at_highest_dd
         FROM per_dive
         WHERE competitor_id = $1 AND dd IS NOT NULL`,
        [id, fromDate, toDate],
      ),

      // FREQUENT DIVES — the diver's go-to dives, ordered by
      // attempt count. Ties broken by avg score (better first).
      runQuery("frequent_dives",
        `WITH per_dive AS (${PER_DIVE})
         SELECT dive_code, position, height,
                COUNT(*)::int                    AS attempts,
                AVG(dive_total)::numeric(6,2)    AS avg_score,
                MAX(dive_total)::numeric(6,2)    AS best_score
         FROM per_dive
         WHERE competitor_id = $1 AND dive_code IS NOT NULL
         GROUP BY dive_code, position, height
         ORDER BY attempts DESC, avg_score DESC
         LIMIT 5`,
        [id, fromDate, toDate],
      ),

      // STREAK — current run of consecutive top-3 / top-1 finishes
      // (looking back from the most recent meet). Same full-field
      // ranking pattern as recent_form/placings — otherwise every
      // meet ranks the diver 1st and the streak is meaningless.
      runQuery("streak",
        `WITH ${FULL_FIELD_RANKING},
         streak_rows AS (
           SELECT r.event_id, r.rank, e.created_at
           FROM ranked r JOIN events e ON e.id = r.event_id
           WHERE r.competitor_id = $1
         )
         SELECT event_id, rank, created_at
         FROM streak_rows
         ORDER BY created_at DESC`,
        [id, fromDate, toDate],
      ),

      // COMPARE TO PEERS — diver vs. org-wide stats over the same
      // date window. Two simple sub-queries combined at the SELECT
      // level: cleaner than a single aggregate with a boolean
      // partition expression in GROUP BY (which we found to be
      // brittle in some pg versions). Each sub-query reuses the
      // existing PER_DIVE shape, just with a different competitor
      // filter — `=` for "me", `<>` joined on org for "peers".
      runQuery("compare_peers",
        `WITH me_dives AS (${PER_DIVE}),
         peer_dives AS (
           SELECT s.event_id, s.competitor_id, s.round_number, d.dd,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS dive_total
           FROM scores s
           JOIN users u ON u.id = s.competitor_id
           JOIN events e ON e.id = s.event_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE u.org_id = $4
             AND s.competitor_id <> $1
             AND ($2::date IS NULL OR e.created_at >= $2::date)
             AND ($3::date IS NULL OR e.created_at < $3::date + INTERVAL '1 day')
           GROUP BY s.event_id, s.competitor_id, s.round_number,
                    d.dd, e.number_of_judges, e.event_type
         )
         SELECT
           (SELECT AVG(dd)::numeric(4,2)         FROM me_dives)   AS my_avg_dd,
           (SELECT AVG(dd)::numeric(4,2)         FROM peer_dives) AS peer_avg_dd,
           (SELECT MAX(dd)::numeric(4,2)         FROM me_dives)   AS my_max_dd,
           (SELECT MAX(dd)::numeric(4,2)         FROM peer_dives) AS peer_max_dd,
           (SELECT AVG(dive_total)::numeric(6,2) FROM me_dives)   AS my_avg_score,
           (SELECT AVG(dive_total)::numeric(6,2) FROM peer_dives) AS peer_avg_score,
           (SELECT COUNT(*)::int                 FROM me_dives)   AS my_dives,
           (SELECT COUNT(*)::int                 FROM peer_dives) AS peer_dives`,
        [id, fromDate, toDate, orgId],
      ),

      // EVENT TYPE SPLITS — meets, dives, avg + best dive total
      // per event_type (individual / synchro_pair / team). Computed
      // in two stages so the meet-level averages aren't weighted by
      // the number of dives in each meet. The dive-level numbers
      // come from per_dive directly; the meet-level numbers come
      // from event_totals where each meet contributes once.
      runQuery("event_type_splits",
        `WITH per_dive AS (${PER_DIVE}),
         event_totals AS (
           SELECT event_id, competitor_id, event_type,
                  SUM(dive_total) AS total
           FROM per_dive
           GROUP BY event_id, competitor_id, event_type
         ),
         dive_stats AS (
           SELECT event_type,
                  COUNT(*)::int                  AS dives,
                  AVG(dive_total)::numeric(6,2)  AS avg_dive_score,
                  MAX(dive_total)::numeric(6,2)  AS best_single_dive
           FROM per_dive
           GROUP BY event_type
         ),
         meet_stats AS (
           SELECT event_type,
                  COUNT(*)::int                  AS meets,
                  AVG(total)::numeric(8,2)       AS avg_meet_total,
                  MAX(total)::numeric(8,2)       AS best_meet_total
           FROM event_totals
           GROUP BY event_type
         )
         SELECT m.event_type,
                m.meets, d.dives,
                d.avg_dive_score, d.best_single_dive,
                m.avg_meet_total, m.best_meet_total
         FROM meet_stats m
         LEFT JOIN dive_stats d USING (event_type)
         ORDER BY m.meets DESC`,
        [id, fromDate, toDate],
      ),

      // YEAR-OVER-YEAR — per calendar year (of e.created_at) headline
      // numbers, plus this diver's rank in each meet so we can count
      // wins and podiums. The previous version partitioned RANK on
      // a CTE that was already pre-filtered to the diver, so every
      // rank came out 1; now we rank against ALL competitors in
      // those events and then filter to the diver in `my_events`.
      // GROUP BY uses the full EXTRACT expression rather than the
      // alias `year` to dodge any keyword-resolution oddities.
      runQuery("year_over_year",
        `WITH ${FULL_FIELD_RANKING},
         my_events AS (
           SELECT r.event_id, r.total, r.rank, e.created_at
           FROM ranked r
           JOIN events e ON e.id = r.event_id
           WHERE r.competitor_id = $1
         )
         SELECT EXTRACT(YEAR FROM created_at)::int    AS year,
                COUNT(DISTINCT event_id)::int         AS meets,
                AVG(total)::numeric(8,2)              AS avg_meet_total,
                MAX(total)::numeric(8,2)              AS best_meet_total,
                COUNT(*) FILTER (WHERE rank = 1)::int  AS wins,
                COUNT(*) FILTER (WHERE rank <= 3)::int AS podiums
         FROM my_events
         GROUP BY EXTRACT(YEAR FROM created_at)
         ORDER BY year DESC`,
        [id, fromDate, toDate],
      ),
    ]);

    // runQuery already unpacks .rows, so the array of arrays
    // destructures cleanly without an extra .map().
    const [recent, placings, heights, rounds, quality, ddRisk, frequent, streak,
           comparePeers, eventTypeSplits, yearOverYear] = queries;

    // Recent Form expansion — for each meet returned, fetch every
    // dive the diver did with the per-judge raw scores. The widget
    // shows a click-to-expand panel where the diver can see the
    // judges' actual marks (the trim algorithm is then applied
    // client-side: the highest k and lowest k by score render with
    // a strike-through chip).
    if (recent.length) {
      const eventIds = recent.map((r) => r.event_id);
      const diveDetails = await runQuery("recent_form_dives",
        `SELECT s.event_id, s.round_number,
                d.dive_code, d.position, d.height, d.dd, d.description,
                e.number_of_judges, e.event_type::text AS event_type,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score ORDER BY ej.judge_number),
                  e.number_of_judges, MAX(d.dd), e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
                ) AS dive_total,
                json_agg(
                  json_build_object(
                    'judge_number', ej.judge_number,
                    'score',        s.score
                  ) ORDER BY ej.judge_number
                ) AS judges
         FROM scores s
         JOIN events e ON e.id = s.event_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = s.event_id
          AND cdl.competitor_id = s.competitor_id
          AND cdl.round_number = s.round_number
         LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
         WHERE s.competitor_id = $1
           AND s.event_id = ANY($2::uuid[])
         GROUP BY s.event_id, s.round_number,
                  d.dive_code, d.position, d.height, d.dd, d.description,
                  e.number_of_judges, e.event_type
         ORDER BY s.round_number ASC`,
        [id, eventIds],
      );
      const byEvent = new Map();
      for (const row of diveDetails) {
        const arr = byEvent.get(row.event_id) || [];
        arr.push(row);
        byEvent.set(row.event_id, arr);
      }
      for (const r of recent) {
        r.dives = byEvent.get(r.event_id) || [];
      }
    }

    // Streak post-processing — count consecutive top-3 from the
    // most recent meet backwards.
    let streakLen = 0;
    let streakKind = null;
    for (const row of streak) {
      const r = Number(row.rank);
      if (r === 1) {
        if (streakKind === "podium" || streakKind === "win" || streakKind === null) {
          streakKind = streakKind === "podium" ? "podium" : "win";
          streakLen++;
        } else break;
      } else if (r <= 3) {
        if (streakKind === null || streakKind === "podium") {
          streakKind = "podium";
          streakLen++;
        } else if (streakKind === "win") {
          // Win streak broken; switch to podium streak count
          streakKind = "podium";
          streakLen++;
        } else break;
      } else break;
    }

    res.json({
      recent_form: recent,
      placings: placings[0] || {
        gold: 0, silver: 0, bronze: 0,
        finalist: 0, further: 0, total_meets: 0,
      },
      height_breakdown: heights,
      round_stamina: rounds,
      quality_mix: quality[0] || {
        failed: 0, deficient: 0, unsatisfactory: 0, satisfactory: 0,
        good: 0, very_good: 0, excellent: 0, total: 0,
      },
      dd_risk: ddRisk[0] || {
        avg_dd: null, max_dd: null, avg_score: null,
        avg_score_at_highest_dd: null, attempts_at_highest_dd: 0,
      },
      frequent_dives: frequent,
      streak: { kind: streakKind, length: streakLen },
      compare_peers: comparePeers[0] || {
        my_avg_dd: null, peer_avg_dd: null,
        my_max_dd: null, peer_max_dd: null,
        my_avg_score: null, peer_avg_score: null,
        my_dives: 0, peer_dives: 0,
      },
      event_type_splits: eventTypeSplits,
      year_over_year: yearOverYear,
      filter: { from_date: fromDate, to_date: toDate },
    });
  } catch (err) {
    console.error("[Diver Analytics Error]", err.message);
    res.status(500).json({ error: "Failed to load analytics" });
  }
});

// Save the calling user's dashboard widget selection. Validated
// against the known catalog so a typo can't poison the store.
const KNOWN_WIDGETS = new Set([
  "score_trend", "personal_bests", "recent_form", "placings",
  "height_breakdown", "round_stamina", "quality_mix", "dd_risk",
  "frequent_dives", "streak",
  // Added with the date-range filter pass:
  "compare_peers", "event_type_splits", "year_over_year",
]);

app.put("/api/users/me/dashboard", verifyToken, async (req, res) => {
  const { widgets } = req.body || {};
  if (!Array.isArray(widgets)) {
    return res.status(400).json({ error: "widgets must be an array of widget IDs" });
  }
  // Filter out unknown / duplicate IDs so storage stays clean.
  const cleaned = [];
  const seen = new Set();
  for (const w of widgets) {
    if (typeof w !== "string") continue;
    if (!KNOWN_WIDGETS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    cleaned.push(w);
  }
  try {
    const r = await pool.query(
      `UPDATE users SET dashboard_widgets = $1::jsonb
       WHERE id = $2
       RETURNING dashboard_widgets`,
      [JSON.stringify(cleaned), req.user.id],
    );
    if (!r.rows.length) return res.status(404).json({ error: "User not found" });
    res.json({ ok: true, widgets: r.rows[0].dashboard_widgets });
  } catch (err) {
    console.error("[Dashboard Save Error]", err.message);
    res.status(500).json({ error: err.message });
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
// =============================================================
// RECORDS — personal / club / federation best per (height,
// dive_code, position). Called from the socket submit_score
// handler when a dive completes (every judge has submitted).
//
// We treat each scope separately so a dive can break a club
// record and a personal record at the same time. The records
// table holds the CURRENT best; the previous holder is archived
// in records_history before we UPDATE.
// [SECTION: RECORDS]
// =============================================================

// Returns an array of {scope, scope_id, height, dive_code,
// position, score, prev_score?, prev_holder_name?} describing
// every record this dive set. Empty array = nothing broken.
async function checkAndApplyRecords({ eventId, competitorId, roundNumber }) {
  try {
    // Fetch the dive's metadata + the diver's club / org so we
    // can match against the right scope_ids. One round-trip.
    const ctx = await pool.query(
      `SELECT u.id  AS user_id,
              u.club_id,
              u.org_id,
              cl.name AS club_name,
              o.name  AS org_name,
              u.full_name AS holder_name,
              e.height, e.event_type, e.number_of_judges,
              d.dive_code, d.position, d.dd, d.description,
              calc_event_dive_points(
                array_agg(ej.judge_number ORDER BY ej.judge_number),
                array_agg(s.score        ORDER BY ej.judge_number),
                e.number_of_judges, d.dd, e.event_type,
                BOOL_OR(cdl.partner_id IS NOT NULL)
              ) AS dive_total,
              COUNT(s.score)::int AS judges_in
       FROM scores s
       JOIN events e ON e.id = s.event_id
       JOIN users u  ON u.id = s.competitor_id
       LEFT JOIN clubs cl ON cl.id = u.club_id
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
       LEFT JOIN competitor_dive_lists cdl
         ON cdl.event_id = s.event_id
        AND cdl.competitor_id = s.competitor_id
        AND cdl.round_number = s.round_number
       LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
       WHERE s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3
       GROUP BY u.id, u.club_id, u.org_id, cl.name, o.name, u.full_name,
                e.height, e.event_type, e.number_of_judges,
                d.dive_code, d.position, d.dd, d.description`,
      [eventId, competitorId, roundNumber],
    );
    if (!ctx.rows.length) return [];
    const c = ctx.rows[0];

    // Skip if the dive isn't complete yet (some judges still to
    // submit), or if we couldn't resolve the dive metadata (rare
    // — happens when the dive_directory row is missing).
    if (c.judges_in < c.number_of_judges) return [];
    if (!c.dive_code || !c.position || !c.height) return [];
    if (c.dive_total == null) return [];

    const score = Number(c.dive_total);
    const broken = [];

    // Personal + (optionally) club + federation scopes.
    const scopes = [
      { scope: "personal",   scope_id: c.user_id,  scope_name: c.holder_name },
      ...(c.club_id ? [{ scope: "club",       scope_id: c.club_id, scope_name: c.club_name }] : []),
      { scope: "federation", scope_id: c.org_id,   scope_name: c.org_name },
    ];

    for (const s of scopes) {
      // Read existing record (if any) for this scope tuple.
      const existing = await pool.query(
        `SELECT id, score, holder_id,
                (SELECT full_name FROM users WHERE id = records.holder_id) AS holder_name
         FROM records
         WHERE scope = $1::record_scope AND scope_id = $2
           AND height = $3::board_height
           AND dive_code = $4 AND position = $5::dive_position`,
        [s.scope, s.scope_id, c.height, c.dive_code, c.position],
      );
      const prev = existing.rows[0];
      // No existing record OR new score strictly greater. Strict
      // greater so equal totals don't displace the original holder.
      if (!prev || score > Number(prev.score)) {
        if (prev) {
          // Archive old holder before overwriting.
          await pool.query(
            `INSERT INTO records_history
               (scope, scope_id, height, dive_code, position,
                score, holder_id, event_id, set_at)
             SELECT scope, scope_id, height, dive_code, position,
                    score, holder_id, event_id, set_at
             FROM records WHERE id = $1`,
            [prev.id],
          );
        }
        await pool.query(
          `INSERT INTO records
             (scope, scope_id, height, dive_code, position,
              score, holder_id, event_id, set_at)
           VALUES ($1::record_scope, $2, $3::board_height, $4, $5::dive_position,
                   $6, $7, $8, now())
           ON CONFLICT (scope, scope_id, height, dive_code, position)
           DO UPDATE SET score = EXCLUDED.score,
                         holder_id = EXCLUDED.holder_id,
                         event_id = EXCLUDED.event_id,
                         set_at = now()`,
          [s.scope, s.scope_id, c.height, c.dive_code, c.position,
            score, c.user_id, eventId],
        );
        broken.push({
          scope:        s.scope,
          scope_id:     s.scope_id,
          scope_name:   s.scope_name,
          height:       c.height,
          dive_code:    c.dive_code,
          position:     c.position,
          score,
          holder_id:    c.user_id,
          holder_name:  c.holder_name,
          prev_score:   prev ? Number(prev.score) : null,
          prev_holder_name: prev ? prev.holder_name : null,
          event_id:     eventId,
        });
      }
    }
    return broken;
  } catch (err) {
    // Non-fatal — records are best-effort. The scoreboard still
    // works without them.
    console.error("[Records Check Error]", err.message);
    return [];
  }
}

// Public read endpoints.
// GET /api/records?scope=personal&scope_id=<uuid>
// GET /api/records?event_id=<uuid>   → records broken at this event
app.get("/api/records", verifyToken, async (req, res) => {
  try {
    const scope    = req.query.scope || null;
    const scopeId  = req.query.scope_id || null;
    const eventId  = req.query.event_id || null;
    if (!scopeId && !eventId) {
      return res.status(400).json({ error: "Pass scope+scope_id or event_id" });
    }
    // Validate the scope enum so an invalid value (e.g. ?scope=foo)
    // doesn't cascade to a 500 from the postgres enum cast — clean
    // 400 instead and a discoverable error message.
    const VALID_RECORD_SCOPES = new Set(["personal", "club", "federation"]);
    if (scope != null && !VALID_RECORD_SCOPES.has(scope)) {
      return res.status(400).json({
        error: `Invalid scope. Valid: ${[...VALID_RECORD_SCOPES].join(", ")}.`,
      });
    }
    // UUID shape check on scope_id and event_id — same reason.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (scopeId && !UUID_RE.test(scopeId)) {
      return res.status(400).json({ error: "scope_id must be a UUID" });
    }
    if (eventId && !UUID_RE.test(eventId)) {
      return res.status(400).json({ error: "event_id must be a UUID" });
    }
    const r = await pool.query(
      `SELECT r.id, r.scope::text AS scope, r.scope_id,
              r.height::text AS height, r.dive_code, r.position::text AS position,
              r.score, r.set_at,
              r.holder_id, h.full_name AS holder_name,
              r.event_id, e.name AS event_name
       FROM records r
       LEFT JOIN users h ON h.id = r.holder_id
       LEFT JOIN events e ON e.id = r.event_id
       WHERE ($1::text IS NULL OR r.scope = $1::record_scope)
         AND ($2::uuid IS NULL OR r.scope_id = $2::uuid)
         AND ($3::uuid IS NULL OR r.event_id = $3::uuid)
       ORDER BY r.height, r.dive_code, r.position`,
      [scope, scopeId, eventId],
    );
    res.json(r.rows);
  } catch (err) {
    console.error("[Records List Error]", err.message);
    res.status(500).json([]);
  }
});

// SOCKET ENGINE
// [SECTION: SOCKET ENGINE]
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

// socketRequireRole + isValidScore live in lib/middleware.js —
// imported at the top alongside the HTTP gates so the auth
// perimeter (socket and HTTP) sits in one place.

function clientIp(socket) {
  const fwd = socket.handshake.headers["x-forwarded-for"];
  if (fwd) return fwd.split(",")[0].trim();
  return socket.handshake.address || null;
}

// Per-judge rate limit on score submissions. The HTTP rate limit
// middleware doesn't reach socket events, so we track a sliding
// window in memory: at most SCORE_LIMIT submissions per judge per
// SCORE_WINDOW_MS. A typical judge taps a dive 1–2× per minute,
// so 60/min is well above legitimate use and well below "rogue
// script spamming the wire".
const SCORE_LIMIT = 60;
const SCORE_WINDOW_MS = 60 * 1000;
const scoreSubmissions = new Map();   // judgeId → array of timestamps

function judgeIsRateLimited(judgeId) {
  if (!judgeId) return false;
  const now = Date.now();
  const cutoff = now - SCORE_WINDOW_MS;
  const arr = (scoreSubmissions.get(judgeId) || []).filter((t) => t > cutoff);
  if (arr.length >= SCORE_LIMIT) {
    scoreSubmissions.set(judgeId, arr);
    return true;
  }
  arr.push(now);
  scoreSubmissions.set(judgeId, arr);
  return false;
}

// Periodic cleanup so the map doesn't grow forever as judges come
// and go. Runs every 5 minutes; drops entries with no submissions
// inside the window.
setInterval(() => {
  const cutoff = Date.now() - SCORE_WINDOW_MS;
  for (const [judgeId, arr] of scoreSubmissions.entries()) {
    const fresh = arr.filter((t) => t > cutoff);
    if (fresh.length === 0) scoreSubmissions.delete(judgeId);
    else scoreSubmissions.set(judgeId, fresh);
  }
}, 5 * 60 * 1000).unref?.();

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
    // Mutates server-side state — must come from a meet manager,
    // referee, or org admin (or sysadmin). Anonymous spectators
    // pulling state via get_active_diver still work.
    if (!socketRequireRole(socket, ["meet_manager", "referee", "org_admin"])) return;
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
      // Authentication: must be a verified user. We deliberately do
      // NOT fall back to data.judge_id any more — the previous fallback
      // let an unauthenticated client emit submit_score with whatever
      // judge_id they liked, attributing scores to other people.
      if (!socket.userId) {
        socket.emit("score_rejected", {
          reason: "not_authenticated",
          message: "You must be signed in to submit scores.",
        });
        return;
      }
      const judgeId = socket.userId;

      // Authorisation: judge or referee role (or sysadmin).
      const roles = socket.userOrgRoles || [];
      if (!socket.userIsSystemAdmin
          && !roles.includes("judge")
          && !roles.includes("referee")) {
        socket.emit("score_rejected", { reason: "insufficient_role" });
        return;
      }

      // Payload sanity. event_id, competitor_id, round_number, score
      // are all required; score must be in [0, 10] in 0.5 increments.
      if (!data?.event_id || !data?.competitor_id) {
        socket.emit("score_rejected", { reason: "bad_payload" });
        return;
      }
      const round = Number(data.round_number);
      if (!Number.isInteger(round) || round < 1) {
        socket.emit("score_rejected", { reason: "bad_round" });
        return;
      }
      if (!isValidScore(data.score)) {
        socket.emit("score_rejected", {
          reason: "bad_score",
          message: "Score must be between 0 and 10 in 0.5 increments.",
        });
        return;
      }

      if (judgeIsRateLimited(judgeId)) {
        console.warn(`[Score] Rate limit exceeded for judge ${judgeId}`);
        socket.emit("score_rejected", {
          reason: "rate_limited",
          message: "Slow down — too many submissions in the last minute.",
        });
        return;
      }

      // Confirm this user is on the panel for this event. This is
      // both an authorisation check (a judge from event A can't
      // post into event B's scores) and the source of judge_number,
      // which the trim algorithm needs.
      let judgeNumber = data.judge_number || null;
      const jnRes = await pool.query(
        "SELECT judge_number FROM event_judges WHERE event_id = $1 AND judge_id = $2",
        [data.event_id, judgeId],
      );
      if (!jnRes.rows.length && !socket.userIsSystemAdmin) {
        socket.emit("score_rejected", {
          reason: "not_on_panel",
          message: "You're not on the judging panel for this event.",
        });
        return;
      }
      if (jnRes.rows.length) judgeNumber = jnRes.rows[0].judge_number;

      // Read the prior row (if any) so we know whether this write is
      // an insert or an update, and can capture the previous score
      // for the audit log. Done outside any transaction — the audit
      // log is best-effort and must not block the score write itself.
      // Use the validated `round` (not the unvalidated data.round_number)
      // and the coerced numeric score, so a string "8.5" stores as 8.5
      // and not as text in the numeric column.
      const score = Number(data.score);

      const prior = await pool.query(
        `SELECT id, score FROM scores
         WHERE event_id=$1 AND competitor_id=$2 AND round_number=$3 AND judge_id=$4`,
        [data.event_id, data.competitor_id, round, judgeId],
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
          round,
          score,
        ],
      );
      const scoreId = upsert.rows[0].id;

      // Best-effort audit. We swallow errors here so a missing audit
      // table (e.g. before the operator runs the migration) does not
      // break live scoring. The error is logged so the operator
      // notices and applies the migration.
      const newScore = score;
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
              round,
              existing ? "update" : "insert",
              oldScore,
              newScore,
              socket.userId,
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

      // Records check — runs only on the score that COMPLETES the
      // dive (the helper bails when judges_in < number_of_judges).
      // Best-effort and async so a slow records lookup doesn't
      // block the score broadcast. Each broken record fans out a
      // dedicated `record_broken` event the scoreboard listens for.
      checkAndApplyRecords({
        eventId:      data.event_id,
        competitorId: data.competitor_id,
        roundNumber:  round,
      }).then((broken) => {
        for (const b of broken) {
          io.emit("record_broken", b);
        }
      }).catch((e) => console.error("[Records broadcast]", e.message));
    } catch (err) {
      console.error("[Score Persist Error]", err.message);
      // Still broadcast even if DB write fails so UI stays live
      io.emit("score_received", data);
    }
  });
  socket.on("announce_score", (data) => {
    if (!socketRequireRole(socket, ["meet_manager", "referee", "org_admin"])) return;
    io.emit("final_score_announced", data);
  });

  // Referee actions — broadcast to clients AND persist to the
  // score_audit_log so a post-meet dispute investigation has a
  // record. We log the action as 'update' on every score row
  // for that (event, competitor, round) tuple so the audit
  // timeline shows exactly what was changed.
  async function logRefereeAction(action, data, actorUserId) {
    if (!data?.event_id || !data?.competitor_id || !data?.round_number) return;
    try {
      await pool.query(
        `INSERT INTO score_audit_log
           (score_id, event_id, competitor_id, judge_id, round_number,
            action, old_score, new_score, actor_user_id, ip_address, user_agent)
         SELECT s.id, s.event_id, s.competitor_id, s.judge_id, s.round_number,
                'update', s.score,
                CASE WHEN $5 = 'failed' THEN 0
                     WHEN $5 = 'cap'    THEN LEAST(s.score, $6::numeric)
                     ELSE s.score END,
                $7, $8, $9
         FROM scores s
         WHERE s.event_id = $1 AND s.competitor_id = $2 AND s.round_number = $3
           AND $4::boolean IS true`,
        [
          data.event_id, data.competitor_id, data.round_number,
          true, action, data.cap_value || 2.0,
          actorUserId || null,
          clientIp(socket),
          socket.handshake.headers["user-agent"] || null,
        ],
      );
    } catch (err) {
      console.error("[Referee Audit Skipped]", err.message);
    }
  }

  socket.on("referee_failed_dive", async (data) => {
    if (!socketRequireRole(socket, ["referee", "meet_manager", "org_admin"])) return;
    await logRefereeAction("failed", data, socket.userId);
    io.emit("referee_action_failed", data);
  });
  socket.on("referee_cap_scores", async (data) => {
    if (!socketRequireRole(socket, ["referee", "meet_manager", "org_admin"])) return;
    await logRefereeAction("cap", data, socket.userId);
    io.emit("referee_action_cap", data);
  });
  socket.on("referee_redive", async (data) => {
    if (!socketRequireRole(socket, ["referee", "meet_manager", "org_admin"])) return;
    await logRefereeAction("redive", data, socket.userId);
    io.emit("referee_action_redive", data);
  });

  // Hold / resume the meet. The Control Room dispatches these;
  // judges + scoreboard listen and display a banner while the
  // hold is active. Per-event so multiple meets can run in
  // parallel without interfering.
  socket.on("meet_hold", (data) => {
    if (!socketRequireRole(socket, ["meet_manager", "referee", "org_admin"])) return;
    if (!data?.event_id) return;
    meetHolds[data.event_id] = {
      reason: data.reason || null,
      since: Date.now(),
    };
    io.emit("meet_held", { event_id: data.event_id, ...meetHolds[data.event_id] });
  });
  socket.on("meet_resume", (data) => {
    if (!socketRequireRole(socket, ["meet_manager", "referee", "org_admin"])) return;
    if (!data?.event_id) return;
    delete meetHolds[data.event_id];
    io.emit("meet_resumed", { event_id: data.event_id });
  });
  // Clients that connect after a hold has been set ask for the
  // current state on demand — same on-demand pull pattern as
  // get_active_diver.
  socket.on("get_meet_hold", (data) => {
    if (!data?.event_id) return;
    const state = meetHolds[data.event_id];
    if (state) socket.emit("meet_held", { event_id: data.event_id, ...state });
  });
  socket.on("disconnect", () =>
    console.log(`[Socket] Disconnected: ${socket.id}`),
  );
});

// =============================================================
// RESULTS ARCHIVE — public list of completed events
// [SECTION: ROUTES — ARCHIVE]
// =============================================================

app.get("/api/archive", async (req, res) => {
  try {
    // Each event row gains a competitor count, a club count, and
    // the list of distinct club ids that participated. The list
    // is what powers the client-side "filter by club" dropdown
    // without an extra round trip per filter change.
    //
    // Returns Live + Completed events so the unified Scoreboard
    // page can show both in the same browsable list. The status
    // column lets the client render a "LIVE NOW" badge / banner
    // for in-progress meets.
    //
    // For Live events we additionally fold in the current round
    // (= max round_number with any score recorded) and the
    // most-recent diver to score. The "LIVE NOW" banner uses
    // these to read "Round 3 · Phoenix Patel diving" instead of
    // a generic placeholder, which is far more compelling for a
    // spectator deciding whether to tap in.
    const events = await pool.query(
      `SELECT e.id, e.name, e.gender, e.height, e.total_rounds, e.number_of_judges,
              e.event_type, e.status,
              e.created_at, o.id AS org_id, o.name AS org_name, o.country_code,
              e.meet_id, m.name AS meet_name,
              m.start_date AS meet_start_date, m.end_date AS meet_end_date,
              COALESCE(stat.competitor_count, 0)::int AS competitor_count,
              COALESCE(stat.club_count, 0)::int       AS club_count,
              COALESCE(stat.club_ids, ARRAY[]::text[]) AS club_ids,
              live.current_round,
              live.last_diver_name
       FROM events e
       JOIN organisations o ON e.org_id = o.id
       LEFT JOIN meets m ON m.id = e.meet_id
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
       LEFT JOIN LATERAL (
         SELECT
           MAX(s.round_number) AS current_round,
           (SELECT u2.full_name
            FROM scores s2
            JOIN users u2 ON u2.id = s2.competitor_id
            WHERE s2.event_id = e.id
            ORDER BY s2.created_at DESC
            LIMIT 1) AS last_diver_name
         FROM scores s
         WHERE s.event_id = e.id
       ) live ON e.status = 'Live'
       WHERE e.status IN ('Live', 'Completed')
       ORDER BY
         CASE e.status WHEN 'Live' THEN 0 ELSE 1 END,    -- live meets float to the top
         e.created_at DESC`,
    );
    res.json(events.rows);
  } catch (err) {
    console.error("[Archive Error]", err.message);
    res.status(500).json([]);
  }
});

// Distinct clubs that have appeared in any live or completed meet.
// Drives the club filter dropdown on the unified Scoreboard.
app.get("/api/archive/clubs", async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT DISTINCT cl.id, cl.name, cl.short_code,
              cl.org_id, o.name AS org_name, o.country_code
       FROM clubs cl
       JOIN users u ON u.club_id = cl.id
       JOIN scores s ON s.competitor_id = u.id
       JOIN events e ON e.id = s.event_id AND e.status IN ('Live', 'Completed')
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
// [SECTION: ROUTES — PDF EXPORT]
// =============================================================

// Public meet program PDF — full schedule, every event in
// the bundle, competitor count per event, sponsor strip on
// the cover. No auth required (public meet pages already
// expose this data via /meet/:id).
app.get("/api/meets/:id/program.pdf", async (req, res) => {
  try {
    const [meetRes, eventsRes] = await Promise.all([
      pool.query(
        `SELECT m.*, o.name AS org_name, o.country_code
         FROM meets m
         JOIN organisations o ON o.id = m.org_id
         WHERE m.id = $1`,
        [req.params.id],
      ),
      pool.query(
        `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                e.total_rounds, e.number_of_judges, e.event_type,
                e.event_format, e.parent_event_id, e.scheduled_at,
                e.dd_limit_rounds, e.dd_limit_value, e.status,
                COALESCE(stat.competitor_count, 0)::int AS competitor_count
         FROM events e
         LEFT JOIN LATERAL (
           SELECT COUNT(DISTINCT cdl.competitor_id) AS competitor_count
           FROM competitor_dive_lists cdl
           WHERE cdl.event_id = e.id AND cdl.withdrawn_at IS NULL
         ) stat ON true
         WHERE e.meet_id = $1
         ORDER BY
           e.scheduled_at NULLS LAST,
           CASE e.event_format WHEN 'preliminary' THEN 0 ELSE 1 END,
           e.created_at ASC`,
        [req.params.id],
      ),
    ]);

    if (!meetRes.rows.length) {
      return res.status(404).json({ error: "Meet not found" });
    }
    const meet = meetRes.rows[0];
    const events = eventsRes.rows;

    const slug = (meet.name || "meet")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_program.pdf"`);
    doc.pipe(res);

    // ---------- Cover ----------
    doc.font("Helvetica-Bold").fontSize(11)
      .fillColor("#06b6d4")
      .text((meet.org_name || "").toUpperCase() +
            (meet.country_code ? `  ·  ${meet.country_code}` : ""),
            { align: "center" });
    doc.moveDown(0.5);
    doc.font("Helvetica-Bold").fontSize(28).fillColor("#0f172a")
      .text(meet.name, { align: "center" });
    doc.moveDown(0.3);

    if (meet.start_date || meet.end_date) {
      const fmt = (d) => d
        ? new Date(d).toLocaleDateString(undefined, {
            year: "numeric", month: "long", day: "numeric",
          })
        : "";
      const range = meet.start_date && meet.end_date && meet.start_date !== meet.end_date
        ? `${fmt(meet.start_date)} – ${fmt(meet.end_date)}`
        : fmt(meet.start_date || meet.end_date);
      doc.font("Helvetica").fontSize(13).fillColor("#334155")
        .text(range, { align: "center" });
    }
    if (meet.venue) {
      doc.moveDown(0.2);
      doc.font("Helvetica").fontSize(12).fillColor("#64748b")
        .text(meet.venue, { align: "center" });
    }
    if (meet.description) {
      doc.moveDown(0.6);
      doc.font("Helvetica-Oblique").fontSize(10).fillColor("#475569")
        .text(meet.description, { align: "center", width: 480 });
    }
    if (meet.sponsor_name) {
      doc.moveDown(1.5);
      doc.font("Helvetica").fontSize(9).fillColor("#94a3b8")
        .text("POWERED BY", { align: "center", characterSpacing: 3 });
      doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a")
        .text(meet.sponsor_name, { align: "center" });
    }

    doc.moveDown(2);

    // ---------- Schedule list ----------
    doc.font("Helvetica-Bold").fontSize(11)
      .fillColor("#06b6d4")
      .text("EVENT SCHEDULE", { characterSpacing: 3 });
    doc.moveDown(0.4);
    doc.lineWidth(0.5).strokeColor("#cbd5e1")
      .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.6);

    if (!events.length) {
      doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
        .text("No events scheduled for this meet yet.");
    }

    for (const ev of events) {
      // Page break if we're running off the page
      if (doc.y > 720) doc.addPage();

      const time = ev.scheduled_at
        ? new Date(ev.scheduled_at).toLocaleString(undefined, {
            month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
          })
        : "TBA";

      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
        .text(ev.name, { continued: false });
      doc.font("Helvetica").fontSize(10).fillColor("#64748b");

      const tags = [];
      if (ev.event_type === "synchro_pair") tags.push("SYNCHRO");
      else if (ev.event_type === "team")    tags.push("TEAM");
      if (ev.event_format === "preliminary") tags.push("PRELIM");
      else if (ev.parent_event_id)           tags.push("FINAL");
      if (ev.age_group) tags.push(ev.age_group);
      tags.push(ev.gender);
      if (ev.height) tags.push(ev.height);
      tags.push(`${ev.total_rounds} rounds`);
      tags.push(`${ev.number_of_judges} judges`);
      if (ev.dd_limit_rounds && ev.dd_limit_value) {
        tags.push(`DD ≤ ${ev.dd_limit_value} for first ${ev.dd_limit_rounds}`);
      }

      doc.text(tags.join("  ·  "));

      doc.font("Helvetica").fontSize(10).fillColor("#475569");
      const meta = [];
      meta.push(time);
      if (ev.competitor_count) {
        meta.push(`${ev.competitor_count} ${ev.competitor_count === 1 ? "diver" : "divers"}`);
      }
      meta.push(ev.status);
      doc.text(meta.join("  ·  "));

      doc.moveDown(0.7);
      // Light divider between events
      doc.lineWidth(0.3).strokeColor("#e2e8f0")
        .moveTo(50, doc.y - 4).lineTo(545, doc.y - 4).stroke();
    }

    doc.moveDown(1);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
      .text(
        `Generated ${new Date().toLocaleString()} via Dive Recorder.`,
        { align: "center" },
      );

    doc.end();
  } catch (err) {
    console.error("[Meet Program PDF Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// START LIST PDF — pinned-to-wall pre-meet sheet showing every
// diver in start-order with their per-round dives. Operators
// print this and pin it to the deck so divers know when they're
// up. Reuses the program PDF's PDFKit setup but the body is a
// per-diver dive-list table sorted by display_order then name.
// =============================================================
app.get("/api/events/:id/start-list.pdf", async (req, res) => {
  try {
    const [evRes, rosterRes] = await Promise.all([
      pool.query(
        `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                e.total_rounds, e.number_of_judges, e.event_type,
                e.event_format, e.scheduled_at,
                o.name AS org_name, o.country_code
         FROM events e
         JOIN organisations o ON o.id = e.org_id
         WHERE e.id = $1`,
        [req.params.id],
      ),
      pool.query(
        `SELECT u.id AS competitor_id, u.full_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                pu.full_name AS partner_name,
                tm.name AS team_name,
                cdl.round_number, cdl.display_order, cdl.withdrawn_at,
                d.dive_code, d.position, d.dd
         FROM users u
         JOIN competitor_dive_lists cdl ON u.id = cdl.competitor_id
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl  ON cl.id = u.club_id
         LEFT JOIN users pu  ON pu.id = cdl.partner_id
         LEFT JOIN teams tm  ON tm.id = cdl.team_id
         LEFT JOIN dive_directory d ON d.id = cdl.dive_id
         WHERE cdl.event_id = $1
         ORDER BY cdl.display_order ASC NULLS LAST,
                  u.full_name ASC, cdl.round_number ASC`,
        [req.params.id],
      ),
    ]);
    if (!evRes.rows.length) return res.status(404).json({ error: "Event not found" });
    const event = evRes.rows[0];

    // Reshape: one row per diver with an array of N dives indexed
    // by round (1-based). Reflects the layout PDFKit will render.
    const byDiver = new Map();
    for (const r of rosterRes.rows) {
      if (!byDiver.has(r.competitor_id)) {
        byDiver.set(r.competitor_id, {
          full_name: r.full_name,
          country_code: r.country_code,
          club_name: r.club_name,
          club_code: r.club_code,
          partner_name: r.partner_name,
          team_name: r.team_name,
          withdrawn: !!r.withdrawn_at,
          dives: Array.from({ length: event.total_rounds }, () => null),
        });
      }
      const diver = byDiver.get(r.competitor_id);
      if (r.round_number >= 1 && r.round_number <= event.total_rounds) {
        diver.dives[r.round_number - 1] = {
          code: r.dive_code,
          position: r.position,
          dd: r.dd,
        };
      }
    }
    const divers = [...byDiver.values()];

    const slug = (event.name || "event")
      .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_start_list.pdf"`);
    doc.pipe(res);

    // ---------- Header ----------
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#06b6d4")
      .text((event.org_name || "").toUpperCase()
        + (event.country_code ? `  ·  ${event.country_code}` : ""),
        { align: "center", characterSpacing: 2 });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a")
      .text(event.name, { align: "center" });
    doc.font("Helvetica").fontSize(10).fillColor("#475569");
    const tags = [];
    if (event.event_type === "synchro_pair") tags.push("SYNCHRO");
    else if (event.event_type === "team")    tags.push("TEAM");
    if (event.event_format && event.event_format !== "final") {
      tags.push(event.event_format.toUpperCase());
    }
    if (event.age_group) tags.push(event.age_group);
    tags.push(event.gender);
    if (event.height) tags.push(event.height);
    tags.push(`${event.total_rounds} rounds · ${event.number_of_judges} judges`);
    doc.text(tags.join("  ·  "), { align: "center" });
    doc.moveDown(0.6);
    doc.lineWidth(0.5).strokeColor("#cbd5e1")
      .moveTo(40, doc.y).lineTo(802, doc.y).stroke();
    doc.moveDown(0.4);

    if (!divers.length) {
      doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
        .text("No divers entered for this event yet.", { align: "center" });
      doc.end();
      return;
    }

    // ---------- Table header ----------
    // Column layout: # | Name + Club | R1 .. Rn
    const startX  = 40;
    const numCol  = 20;
    const nameCol = 200;
    const totalRounds = event.total_rounds;
    const roundColWidth = Math.max(50, Math.floor((802 - startX - numCol - nameCol - 10) / totalRounds));

    function drawTableHeader() {
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#06b6d4");
      let x = startX;
      doc.text("#", x, doc.y, { width: numCol, align: "center" });
      x += numCol;
      doc.text("DIVER", x, doc.y, { width: nameCol });
      x += nameCol;
      const headerY = doc.y;
      for (let r = 1; r <= totalRounds; r++) {
        doc.text(`R${r}`, x, headerY, { width: roundColWidth, align: "center" });
        x += roundColWidth;
      }
      doc.moveDown(0.4);
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(startX, doc.y).lineTo(startX + numCol + nameCol + roundColWidth * totalRounds, doc.y).stroke();
      doc.moveDown(0.3);
      doc.fillColor("#0f172a");
    }
    drawTableHeader();

    divers.forEach((d, idx) => {
      // Page break
      if (doc.y > 540) {
        doc.addPage({ size: "A4", layout: "landscape", margin: 40 });
        drawTableHeader();
      }
      const rowY = doc.y;
      let x = startX;
      // Number column
      doc.font("Helvetica").fontSize(10).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
      doc.text(String(idx + 1), x, rowY, { width: numCol, align: "center" });
      x += numCol;
      // Name + meta column
      doc.font("Helvetica-Bold").fontSize(10).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
      const nameLine = d.full_name + (d.country_code ? `  ${d.country_code}` : "")
        + (d.partner_name ? `  &  ${d.partner_name}` : "")
        + (d.withdrawn ? "  (WITHDRAWN)" : "");
      doc.text(nameLine, x, rowY, { width: nameCol });
      // Club / team subline
      const subline = d.team_name
        ? d.team_name
        : (d.club_name ? d.club_name + (d.club_code ? `  (${d.club_code})` : "") : "");
      if (subline) {
        doc.font("Helvetica").fontSize(8).fillColor("#64748b");
        doc.text(subline, x, doc.y, { width: nameCol });
      }
      x += nameCol;
      // Round columns
      const cellTopY = rowY;
      doc.font("Helvetica").fontSize(9).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
      for (let r = 0; r < totalRounds; r++) {
        const dive = d.dives[r];
        const cellText = dive
          ? `${dive.code || ""}${dive.position || ""}\nDD ${Number(dive.dd ?? 0).toFixed(1)}`
          : "—";
        doc.text(cellText, x, cellTopY, { width: roundColWidth, align: "center" });
        x += roundColWidth;
      }
      // Move y to whichever consumed more vertical space (the
      // sub-line beneath the name, or the dive cells).
      doc.moveDown(0.4);
      doc.lineWidth(0.3).strokeColor("#e2e8f0")
        .moveTo(startX, doc.y).lineTo(startX + numCol + nameCol + roundColWidth * totalRounds, doc.y).stroke();
      doc.moveDown(0.2);
    });

    doc.moveDown(1);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
      .text(`Generated ${new Date().toLocaleString()} via Dive Recorder.`, { align: "center" });

    doc.end();
  } catch (err) {
    console.error("[Start List PDF Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// PER-DIVER SCORE SHEET PDF — every diver wants their own report
// after a meet. Reuses the dive-with-judges shape we already
// build for Recent Form: per-round dive metadata + each judge's
// raw score (with the dropped scores marked under FINA trim
// rules, the same way the live scoreboard renders them).
// =============================================================
app.get("/api/events/:id/divers/:diverId/score-sheet.pdf", async (req, res) => {
  try {
    const eventId = req.params.id;
    const diverId = req.params.diverId;

    const [evRes, diverRes, divesRes, totalRes] = await Promise.all([
      pool.query(
        `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                e.total_rounds, e.number_of_judges, e.event_type,
                e.created_at,
                o.name AS org_name, o.country_code
         FROM events e
         JOIN organisations o ON o.id = e.org_id
         WHERE e.id = $1`,
        [eventId],
      ),
      pool.query(
        `SELECT u.id, u.full_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code
         FROM users u
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.id = $1`,
        [diverId],
      ),
      pool.query(
        `SELECT s.round_number,
                d.dive_code, d.position, d.height, d.dd, d.description,
                e.number_of_judges, e.event_type::text AS event_type,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score        ORDER BY ej.judge_number),
                  e.number_of_judges, MAX(d.dd), e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
                ) AS dive_total,
                array_agg(json_build_object(
                  'judge_number', ej.judge_number,
                  'score',        s.score
                ) ORDER BY ej.judge_number) AS judges_json
         FROM scores s
         JOIN events e ON e.id = s.event_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = s.event_id
          AND cdl.competitor_id = s.competitor_id
          AND cdl.round_number = s.round_number
         LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
         WHERE s.event_id = $1 AND s.competitor_id = $2
         GROUP BY s.round_number, d.dive_code, d.position, d.height, d.dd, d.description,
                  e.number_of_judges, e.event_type
         ORDER BY s.round_number ASC`,
        [eventId, diverId],
      ),
      // Final placing — full-field rank query identical to the
      // analytics rollup, kept inline since it's a one-off here.
      pool.query(
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
           SELECT competitor_id, SUM(pts) AS total
           FROM per_dive GROUP BY competitor_id
         ),
         ranked AS (
           SELECT *, RANK() OVER (ORDER BY total DESC) AS rnk,
                  COUNT(*) OVER ()::int AS field_size
           FROM totals
         )
         SELECT total, rnk, field_size FROM ranked WHERE competitor_id = $2`,
        [eventId, diverId],
      ),
    ]);
    if (!evRes.rows.length)    return res.status(404).json({ error: "Event not found" });
    if (!diverRes.rows.length) return res.status(404).json({ error: "Diver not found" });
    const event = evRes.rows[0];
    const diver = diverRes.rows[0];
    const dives = divesRes.rows;
    const totals = totalRes.rows[0] || {};

    // FINA trim — apply the same algorithm the frontend uses
    // (lib/score-trim semantics) so the dropped marks line up.
    function trimCount(n) {
      if (!n || n <= 3) return 0;
      if (n === 5)  return 1;
      if (n === 7)  return 2;
      if (n === 9)  return 2;
      if (n === 11) return 3;
      return 0;
    }
    function annotateDrops(judges, n, eventType) {
      // For synchro 9/11 we'd need the sub-panel logic. For the
      // score sheet we keep things simple — the canonical
      // dive_total comes from the SQL function, and we just need
      // the visual "what was dropped" markup. Fall back to
      // individual trim for synchro panels we don't fully model
      // here.
      const flagged = judges.map((j) => ({ ...j, dropped: false }));
      const k = trimCount(n);
      if (!k || flagged.length <= k * 2) return flagged;
      const sorted = flagged
        .map((j, i) => ({ idx: i, score: Number(j.score), jn: j.judge_number }))
        .sort((a, b) => a.score - b.score || a.jn - b.jn);
      for (let i = 0; i < k; i++) {
        flagged[sorted[i].idx].dropped = true;
        flagged[sorted[sorted.length - 1 - i].idx].dropped = true;
      }
      return flagged;
    }

    const slug = (diver.full_name || "diver").toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const doc = new PDFDocument({ margin: 50, size: "A4" });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_score_sheet.pdf"`);
    doc.pipe(res);

    // ---------- Header ----------
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#06b6d4")
      .text(event.org_name.toUpperCase()
        + (event.country_code ? `  ·  ${event.country_code}` : ""),
        { align: "center", characterSpacing: 2 });
    doc.moveDown(0.3);
    doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a")
      .text(diver.full_name + (diver.country_code ? `  ${diver.country_code}` : ""), { align: "center" });
    if (diver.club_name) {
      doc.font("Helvetica").fontSize(11).fillColor("#475569")
        .text(diver.club_name + (diver.club_code ? `  (${diver.club_code})` : ""), { align: "center" });
    }
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
      .text(event.name, { align: "center" });
    const meta = [
      event.gender, event.height, `${event.total_rounds} rounds`, `${event.number_of_judges} judges`,
      event.created_at ? new Date(event.created_at).toLocaleDateString() : "",
    ].filter(Boolean).join("  ·  ");
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(meta, { align: "center" });
    doc.moveDown(0.8);

    // ---------- Headline result tile ----------
    if (totals.rnk) {
      const rank = Number(totals.rnk);
      const total = Number(totals.total).toFixed(2);
      const fieldSize = Number(totals.field_size);
      const ord = (n) => {
        const s = ["th", "st", "nd", "rd"], v = n % 100;
        return n + (s[(v - 20) % 10] || s[v] || s[0]);
      };
      doc.font("Helvetica-Bold").fontSize(28).fillColor(
        rank === 1 ? "#ca8a04" : rank === 2 ? "#475569" : rank === 3 ? "#92400e" : "#0f172a",
      ).text(`${ord(rank)} of ${fieldSize}`, { align: "center" });
      doc.font("Helvetica").fontSize(12).fillColor("#475569")
        .text(`Total: ${total}`, { align: "center" });
      doc.moveDown(0.8);
    }

    if (!dives.length) {
      doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
        .text("No dives recorded for this diver yet.");
      doc.end();
      return;
    }

    // ---------- Per-dive breakdown ----------
    doc.lineWidth(0.5).strokeColor("#cbd5e1")
      .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.4);
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#06b6d4")
      .text("DIVE-BY-DIVE BREAKDOWN", { characterSpacing: 2 });
    doc.moveDown(0.4);

    for (const d of dives) {
      if (doc.y > 720) doc.addPage();
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a")
        .text(`Round ${d.round_number}  ·  ${d.dive_code || "—"}${d.position || ""}`,
          { continued: true });
      doc.font("Helvetica").fontSize(10).fillColor("#475569")
        .text(`   DD ${Number(d.dd ?? 0).toFixed(1)}   Total ${Number(d.dive_total).toFixed(2)}`,
          { align: "right" });
      if (d.description) {
        doc.font("Helvetica-Oblique").fontSize(9).fillColor("#64748b")
          .text(d.description);
      }
      doc.moveDown(0.2);

      const annotated = annotateDrops(d.judges_json || [], d.number_of_judges, d.event_type);
      const lineParts = annotated.map((j) =>
        j.dropped
          ? `[${Number(j.score).toFixed(1)}]`     // brackets = dropped
          : Number(j.score).toFixed(1),
      );
      doc.font("Helvetica").fontSize(10).fillColor("#0f172a")
        .text("Judges: " + lineParts.join("  "), { indent: 10 });
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text("(dropped scores shown in brackets)", { indent: 10 });

      doc.moveDown(0.6);
    }

    doc.moveDown(0.4);
    doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
      .text(`Generated ${new Date().toLocaleString()} via Dive Recorder.`, { align: "center" });
    doc.end();
  } catch (err) {
    console.error("[Score Sheet PDF Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// =============================================================
// CSV EXPORT — federation operators copy results into the
// federation's central record-keeping system. Same data as the
// results PDF, formatted as a single CSV with one row per dive
// so downstream pivot tables work cleanly.
// =============================================================
function csvCell(s) {
  if (s == null) return "";
  const text = String(s);
  // Quote-and-escape if the cell contains a comma, quote, or newline.
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
function csvRow(cells) { return cells.map(csvCell).join(",") + "\n"; }

app.get("/api/events/:id/results.csv", async (req, res) => {
  try {
    const [evRes, divesRes] = await Promise.all([
      pool.query(
        "SELECT e.name, e.gender, e.height, e.event_type, o.name AS org_name FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = $1",
        [req.params.id],
      ),
      pool.query(
        `SELECT u.full_name AS diver_name, o.country_code,
                cl.name AS club_name, cl.short_code AS club_code,
                pu.full_name AS partner_name, tm.name AS team_name,
                s.round_number, d.dive_code, d.position, d.dd,
                calc_event_dive_points(
                  array_agg(ej.judge_number ORDER BY ej.judge_number),
                  array_agg(s.score        ORDER BY ej.judge_number),
                  e.number_of_judges, d.dd, e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
                ) AS dive_total,
                STRING_AGG(s.score::text, ' ' ORDER BY ej.judge_number) AS judge_scores
         FROM scores s
         JOIN events e ON e.id = s.event_id
         JOIN users u  ON u.id = s.competitor_id
         JOIN organisations o ON o.id = u.org_id
         LEFT JOIN clubs cl  ON cl.id = u.club_id
         LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl
           ON cdl.event_id = s.event_id
          AND cdl.competitor_id = s.competitor_id
          AND cdl.round_number = s.round_number
         LEFT JOIN users pu ON pu.id = cdl.partner_id
         LEFT JOIN teams tm ON tm.id = cdl.team_id
         LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
         WHERE s.event_id = $1
         GROUP BY u.full_name, o.country_code, cl.name, cl.short_code,
                  pu.full_name, tm.name,
                  s.round_number, d.dive_code, d.position, d.dd,
                  e.number_of_judges, e.event_type
         ORDER BY u.full_name ASC, s.round_number ASC`,
        [req.params.id],
      ),
    ]);
    if (!evRes.rows.length) return res.status(404).json({ error: "Event not found" });
    const event = evRes.rows[0];
    const slug = (event.name || "event").toLowerCase()
      .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${slug}_results.csv"`);

    // Compute final placings up front so the CSV's per-dive rows
    // can carry both the dive total and the diver's final rank.
    const totalsRes = await pool.query(
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
       )
       SELECT u.full_name AS diver_name, SUM(pts)::numeric(8,2) AS total,
              RANK() OVER (ORDER BY SUM(pts) DESC) AS final_rank
       FROM per_dive pd
       JOIN users u ON u.id = pd.competitor_id
       GROUP BY u.full_name`,
      [req.params.id],
    );
    const placingByName = new Map(
      totalsRes.rows.map((r) => [r.diver_name, { total: r.total, rank: r.final_rank }]),
    );

    res.write(csvRow([
      "diver_name", "country", "club_name", "club_code",
      "partner_name", "team_name",
      "round", "dive_code", "position", "dd",
      "judge_scores", "dive_total",
      "final_total", "final_rank",
    ]));
    for (const r of divesRes.rows) {
      const placing = placingByName.get(r.diver_name) || {};
      res.write(csvRow([
        r.diver_name, r.country_code,
        r.club_name, r.club_code,
        r.partner_name, r.team_name,
        r.round_number, r.dive_code, r.position, r.dd,
        r.judge_scores, r.dive_total,
        placing.total, placing.rank,
      ]));
    }
    res.end();
  } catch (err) {
    console.error("[Results CSV Error]", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/events/:id/results.pdf", async (req, res) => {
  try {
    const [ev, standings, dives] = await Promise.all([
      pool.query(
        "SELECT e.name, e.gender, e.height, e.total_rounds, e.number_of_judges, e.event_type, o.name AS org_name FROM events e JOIN organisations o ON e.org_id = o.id WHERE e.id = $1",
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

    // For synchro events, regroup judge scores into A / B / Sync
    // blocks so the PDF reflects the same grouping the web UI does.
    const isSynchro = event.event_type === "synchro_pair";
    const numJudges = event.number_of_judges;
    const formatSynchroScores = (scoresStr) => {
      const parts = (scoresStr || "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      if (numJudges === 9 && parts.length === 9) {
        return `A: ${parts.slice(0, 2).join(",")}  B: ${parts.slice(2, 4).join(",")}  Sync: ${parts.slice(4, 9).join(",")}`;
      }
      if (numJudges === 11 && parts.length === 11) {
        return `A: ${parts.slice(0, 3).join(",")}  B: ${parts.slice(3, 6).join(",")}  Sync: ${parts.slice(6, 11).join(",")}`;
      }
      return scoresStr;
    };

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
        const scores = isSynchro
          ? formatSynchroScores(r.judge_scores)
          : (r.judge_scores || "");
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
// [SECTION: SPA FALLBACK]
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

// Log schema version + run audit-log retention sweep at boot.
// Both queries are best-effort: a failure (e.g. running against
// an old DB that pre-dates migration 008) just logs a warning.
async function bootChecks() {
  try {
    const v = await pool.query("SELECT version, applied_at FROM schema_meta WHERE id = 1");
    if (v.rows[0]) {
      console.log(`📊 Schema version ${v.rows[0].version} (applied ${new Date(v.rows[0].applied_at).toISOString()})`);
    } else {
      console.warn("[Boot] schema_meta has no rows — run migration 008");
    }
  } catch (err) {
    console.warn("[Boot] Couldn't read schema_meta:", err.message);
  }
  try {
    const purge = await pool.query("SELECT * FROM purge_audit_logs(30)");
    const total = purge.rows.reduce((sum, r) => sum + Number(r.deleted_rows), 0);
    if (total > 0) console.log(`🧹 Purged ${total} audit-log row(s) older than 30 days`);
  } catch (err) {
    console.warn("[Boot] purge_audit_logs failed (run migration 008?):", err.message);
  }
}

// [SECTION: START]
const PORT = process.env.PORT || 3000;

// Only bind the port when this file is the entry point (i.e. node
// server.js or pm2 start server.js). When server.js is required by
// the integration test runner we skip listen() and instead export
// the app + server so the test can drive it without a side-effect
// listener that the process never closes.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`🚀 Diving App v2 on port ${PORT}`);
    bootChecks();
  });
}

module.exports = { app, server, pool, io };
