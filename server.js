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
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// [SECTION: BOOTSTRAP]
const app = express();

// Trust the immediate reverse proxy (Cloudflare / Nginx / etc).
// Without this:
//   * express-rate-limit warns "X-Forwarded-For is set but trust
//     proxy is false" on every request and rate-limits all users
//     by the proxy IP (= one shared bucket).
//   * req.ip is the proxy address, not the real client.
// `1` trusts ONE hop — exactly what's wanted behind a single
// edge proxy. Override via TRUST_PROXY env if you need more
// hops (or set to 'false' for a no-proxy setup).
const TRUST_PROXY = process.env.TRUST_PROXY ?? "1";
app.set("trust proxy", TRUST_PROXY === "false" ? false
  : /^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY)
  : TRUST_PROXY);

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
// Every send-* helper lives in lib/email.js. Built lazily after
// the pool is ready (see below) so the factory has its dependency.

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
  socketCanManageEvent,
  isValidScore,
  parseDateRange,
  bumpTokenVersion,
  invalidateTokenVersion,
  isTokenVersionCurrent,
  loadEventForEntries,
} = require("./lib/middleware")({ pool, JWT_SECRET });

// Convenience aliases — defined once so a typo can't drift the
// role tuple across 20+ route mountings. Used throughout.
const requireMeetEditor = requireOrgRole(["org_admin", "meet_manager"]);
const requireOrgAdmin   = requireOrgRole(["org_admin"]);

// Email helpers — moved into lib/email.js. Factory takes the pool
// so the test runner can swap it. Every helper is best-effort and
// silently no-ops when SMTP_HOST isn't set (dev-mode default).
const {
  hashFingerprint,
  sendRoleDecisionEmail,
  sendPasswordResetEmail,
  sendVerifyEmailEmail,
  sendPasswordChangedEmail,
  sendWelcomeEmail,
  sendNewRoleRequestEmail,
  sendEventStartedEmails,
  sendEventResultsEmails,
} = require("./lib/email")({ pool });

// Scoreboard cache — short-TTL bucket per eventId. The HTTP
// scoreboard route reads/writes via .get/.set; the socket
// submit_score handler and the HTTP score-correction handler
// both invalidate the bucket on commit so the next reader
// rebuilds. Without this, every connected scoreboard re-runs
// the same 7-table standings query after every score event.
// Defined here (before any route mount) so both consumers can
// take it via dependency injection.
const scoreboardCache = require("./lib/scoreboard-cache")();

// Live in-memory state — activeDivers (current performer per
// event) + meetHolds (per-event hold reason). Shared by
// routes/events.js (PUT /:id/status clears them on Completed),
// routes/socket.js (set/get from set_active_diver, meet_hold),
// and any future handler that needs to read live state.
const { activeDivers, meetHolds } = require("./lib/live-state");

// =============================================================
// HELPER — Build JWT payload
// [SECTION: TOKEN PAYLOAD]
// =============================================================
async function buildTokenPayload(userId) {
  const u = await pool.query(
    "SELECT id, username, full_name, org_id, is_system_admin, token_version FROM users WHERE id = $1",
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
    // Stamped on every issued JWT. verifyToken (lib/middleware.js)
    // rejects any token whose `tv` is older than the current row.
    // Bumping users.token_version invalidates every outstanding
    // session for that user — used by role grant/revoke and the
    // password change flow (Migration 021).
    tv: user.token_version,
  };
}

// =============================================================
// =============================================================
// HEALTH CHECK
// [SECTION: ROUTES — HEALTH]
// =============================================================
// Cheap public-readable health probe used by deploy.sh and any
// external uptime monitor. Confirms two things:
//   * the process is up and serving HTTP
//   * the DB pool can issue a trivial query (catches the case
//     where the process bound a port but Postgres is wedged or
//     unreachable, which a port-only liveness check would miss).
//
// 200 + { ok: true, schema_version } when both pass. 503 + { ok:
// false } if the DB query throws — the deploy script can refuse
// to advance past restart on that signal. No auth: monitors and
// load balancers shouldn't need a credential.
app.get("/api/health", async (_req, res) => {
  try {
    const r = await pool.query(
      "SELECT version FROM public.schema_meta WHERE id = 1",
    );
    res.json({
      ok: true,
      schema_version: r.rows[0]?.version ?? null,
    });
  } catch {
    res.status(503).json({ ok: false });
  }
});

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
    sendVerifyEmailEmail,
    sendNewRoleRequestEmail,
    sendPasswordChangedEmail,
    sendPasswordResetEmail,
    bumpTokenVersion,
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
    res.status(500).json({ error: "Internal server error" });
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
    res.status(500).json({ error: "Internal server error" });
  }
});

app.put("/api/orgs/:id/status", requireSystemAdmin, async (req, res) => {
  const { status } = req.body || {};
  try {
    const r = await pool.query(
      "UPDATE organisations SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id],
    );
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// TEAMS
// =============================================================

// Teams in an org with member counts. Auth required, org_admin
// or meet_manager only.
app.get(
  "/api/orgs/:id/teams",
  requireMeetEditor,
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
  requireMeetEditor,
  async (req, res) => {
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
  },
);

app.put(
  "/api/teams/:id",
  requireMeetEditor,
  async (req, res) => {
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
  },
);

app.delete(
  "/api/teams/:id",
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
  },
);

// Events the team is currently entered in — drives the "Edit
// dive list" links inside the TeamsView drawer.
app.get(
  "/api/teams/:id/events",
  requireMeetEditor,
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
app.get(
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

app.get(
  "/api/teams/:id/members",
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
  requireMeetEditor,
  async (req, res) => {
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
  },
);

app.delete(
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

// Teams entered in an event
app.get(
  "/api/events/:id/teams",
  requireMeetEditor,
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
      res.status(500).json({ error: "Internal server error" });
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
         /* LEFT JOIN dive_directory — a dive_list row with a
            NULL or stale dive_id (diver hasn't filed their full
            list yet) shouldn't drop the diver entirely from the
            coach's dashboard. */
         SELECT cdl.competitor_id, cdl.event_id, cdl.round_number,
                cdl.display_order,
                e.name AS event_name, e.status, e.event_type,
                e.height, e.number_of_judges,
                d.dive_code, d.position, d.dd, d.description
         FROM competitor_dive_lists cdl
         JOIN events e ON e.id = cdl.event_id
         LEFT JOIN dive_directory d ON d.id = cdl.dive_id
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
  requireOrgAdmin,
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
  requireOrgAdmin,
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.delete(
  "/api/coach-links/:id",
  requireOrgAdmin,
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
      res.status(500).json({ error: "Internal server error" });
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
  requireMeetEditor,
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
  requireMeetEditor,
  async (req, res) => {
    const { name, short_code } = req.body || {};
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// Delete a club. users.club_id is ON DELETE SET NULL, so members
// keep their accounts but become "no club" until reassigned. We
// surface the affected member count in the response so the UI
// can confirm what just happened.
app.delete(
  "/api/clubs/:id",
  requireMeetEditor,
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// Create a club in an organisation. Authenticated org_admin or
// meet_manager (or system_admin) only — keeps spam off the table.
// During registration, /api/auth/register has its own path that
// can create a club for the new user without prior auth.
app.post(
  "/api/orgs/:id/clubs",
  requireMeetEditor,
  async (req, res) => {
    if (!req.user.is_system_admin && req.params.id !== req.user.org_id) {
      return res
        .status(403)
        .json({ error: "Cannot create clubs in other organisations" });
    }
    const { name, short_code } = req.body || {};
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// =============================================================
// USER & ROLE MANAGEMENT ROUTES
// [SECTION: ROUTES — USERS]
// All seven endpoints + the role-mutation/token-bump plumbing
// extracted into routes/users.js.
// =============================================================
app.use(require("./routes/users")({
  pool,
  verifyToken,
  requireOrgAdmin,
  requireMeetEditor,
  bumpTokenVersion,
  sendRoleDecisionEmail,
}));

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
    res.status(500).json({ error: "Internal server error" });
  }
});

app.post(
  "/api/meets",
  requireMeetEditor,
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.put(
  "/api/meets/:id",
  requireMeetEditor,
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.delete(
  "/api/meets/:id",
  requireMeetEditor,
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
      res.status(500).json({ error: "Internal server error" });
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// =============================================================
// EVENT ROUTES
// [SECTION: ROUTES — EVENTS]
// CRUD + status transitions extracted into routes/events.js.
// loadEventForEntries (used here AND by the team dive-list +
// diver-portal submit handlers) lives in lib/middleware.js so a
// single helper is shared by all three callers.
// =============================================================
app.use(require("./routes/events")({
  pool,
  JWT_SECRET,
  requireOrgAdmin,
  requireEventManager,
  sendEventStartedEmails,
  sendEventResultsEmails,
  activeDivers,
  meetHolds,
}));

// Event manager management
app.get(
  "/api/events/:id/managers",
  requireMeetEditor,
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.post(
  "/api/events/:id/managers",
  requireEventManager(),
  async (req, res) => {
    const { user_id } = req.body || {};
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
      res.status(500).json({ error: "Internal server error" });
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
      res.status(500).json({ error: "Internal server error" });
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

app.post("/api/events/:id/judges", requireEventManager(), async (req, res) => {
  const { judgeIds } = req.body || {}; // ordered array — position = judge number
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
    res.status(500).json({ error: "Internal server error" });
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
      res.status(500).json({ error: "Internal server error" });
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
    res.status(500).json({ error: "Internal server error" });
  }
});

// =============================================================
// CONTROL ROOM ROUTES
// [SECTION: ROUTES — CONTROL ROOM]
// 10 endpoints — roster + reorder + randomise + check-in +
// late-entry + CSV import + public history — extracted into
// routes/control-room.js along with the local parseCsv helper.
// =============================================================
app.use(require("./routes/control-room")({
  pool,
  requireOrgRole,
  requireMeetEditor,
  bulkWriteLimiter,
  ensureEventOrgGate,
}));

// =============================================================
// SCOREBOARD — public
// [SECTION: ROUTES — SCOREBOARD]
// Endpoints (/api/scoreboard/:eventId and /leaderboard) moved
// to routes/scoreboard.js. The dive-list-templates section
// below sits between the two original mounts and is kept here
// since it's per-diver state, not scoreboard-related.
// =============================================================

app.use(require("./routes/scoreboard")({ pool, scoreboardCache }));

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
        // The `reason` column was added in migration 018. Cap the
        // free-text length so a malicious / accidentally-pasted
        // multi-MB blob can't bloat the audit table.
        const trimmedReason = typeof reason === "string"
          ? reason.trim().slice(0, 500)
          : null;
        await pool.query(
          `INSERT INTO score_audit_log
             (score_id, event_id, competitor_id, judge_id, round_number,
              action, old_score, new_score, actor_user_id, ip_address,
              user_agent, reason)
           VALUES ($1,$2,$3,$4,$5,'update',$6,$7,$8,$9,$10,$11)`,
          [
            existing.id, existing.event_id, existing.competitor_id,
            existing.judge_id, existing.round_number,
            oldScore, newScore, req.user.id,
            req.ip, req.headers["user-agent"] || null,
            trimmedReason || null,
          ],
        );
      } catch (auditErr) {
        console.error("[Score Correction Audit Skipped]", auditErr.message);
      }

      // Flush the cached scoreboard payload so the next
      // re-pull rebuilds with the corrected score. Without this
      // the broadcast below tells viewers to re-fetch but the
      // first ~5s of those fetches would hit the stale cache.
      scoreboardCache.invalidate(existing.event_id);

      // Broadcast so live consumers re-pull standings. Spectators
      // viewing the recap or live scoreboard will see the
      // corrected total without a manual refresh.
      io.to(`event:${existing.event_id}`).emit("score_corrected", {
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
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

// =============================================================
// LIVE STATE — activeDivers + meetHolds
// [SECTION: LIVE STATE]
// activeDivers + meetHolds are imported earlier in the file (just
// after the email helpers) because the events router mounts before
// this point and needs the references at module-load time. Re-exposed
// in this section header for grep-ability.
// =============================================================


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
    res.status(500).json({ error: "Internal server error" });
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
    res.status(500).json({ error: "Internal server error" });
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
    const { event_id, dives, partner_id } = req.body || {};
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // First confirm the event exists, belongs to the diver's own
      // organisation, AND is still accepting entries (not started,
      // not past its entries_close_at deadline). Without the org
      // check a diver could submit against any event ID they can
      // guess and pollute another org's roster; without the
      // accepting-entries check a diver could keep editing their
      // list mid-event or after the manager closed registration.
      const gate = await loadEventForEntries(client, event_id);
      if (gate.error) {
        await client.query("ROLLBACK");
        return res.status(gate.status).json({ error: gate.error });
      }
      const evRow = gate.event;
      if (evRow.org_id !== req.user.org_id && !req.user.is_system_admin) {
        await client.query("ROLLBACK");
        return res.status(403).json({ error: "Event is not in your organisation" });
      }
      const eventType = evRow.event_type || "individual";
      const totalRounds = Number(evRow.total_rounds) || null;

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
// /api/divers/:id/profile, /analytics, and /api/users/me/dashboard
// extracted into routes/diver-profile.js along with the local
// canViewDiverProfile / canViewDiverPrivate helpers and the
// KNOWN_WIDGETS whitelist.
// =============================================================
app.use(require("./routes/diver-profile")({
  pool,
  verifyToken,
  parseDateRange,
}));

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
                a.user_agent, a.reason, a.created_at,
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
// RECORDS
// [SECTION: RECORDS]
// Moved into lib/records.js (Phase 2 of the server.js split).
// The factory exposes both checkAndApplyRecords (called from the
// socket submit_score handler when a dive completes) and a tiny
// Express router with the public GET /api/records endpoint. We
// destructure both here and mount the router immediately.
// =============================================================
const { checkAndApplyRecords, router: recordsRouter } =
  require("./lib/records")({ pool, verifyToken });
app.use(recordsRouter);

// =============================================================
// SOCKET ENGINE
// [SECTION: SOCKET ENGINE]
// Every io.use / socket.on handler lives in routes/socket.js.
// We hand it the dependencies it needs — pool, JWT_SECRET, the
// auth helpers, isValidScore, the records helper, and the shared
// activeDivers / meetHolds maps from lib/live-state.
// =============================================================
require("./routes/socket")({
  io,
  pool,
  JWT_SECRET,
  socketRequireRole,
  socketCanManageEvent,
  isValidScore,
  isTokenVersionCurrent,
  checkAndApplyRecords,
  activeDivers,
  meetHolds,
  scoreboardCache,
});

// =============================================================
// RESULTS ARCHIVE
// [SECTION: ROUTES — ARCHIVE]
// /api/archive, /api/archive/clubs, /api/archive/:eventId/results
// extracted into routes/archive.js.
// =============================================================
app.use(require("./routes/archive")({ pool }));

// =============================================================
// PDF + CSV EXPORT
// [SECTION: ROUTES — PDF EXPORT]
// 4 PDFs (program, start-list, score-sheet, results) + 1 CSV
// (per-dive results) extracted into routes/pdf.js along with
// the local csvCell / csvRow helpers and the FINA trim
// annotation used by the score sheet.
// =============================================================
app.use(require("./routes/pdf")({ pool }));

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
