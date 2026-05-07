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

const logger = require("./lib/logger");
const metrics = require("./lib/metrics");

const CORS_ORIGIN = process.env.CORS_ORIGIN || "http://localhost:3000";

// [SECTION: BOOTSTRAP]
const app = express();

// Time every request and emit a Prometheus histogram + counter.
// Mounted FIRST so it captures even helmet/cors short-circuits.
app.use(metrics.httpMetricsMiddleware);

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

// Rate-limit bypass for the e2e + integration suites. Both run
// every request from 127.0.0.1, which under the production
// settings (20 auth requests / 15 min / IP) trips the limiter
// after a handful of register/login calls and leaves the rest of
// the suite seeing 429s. Setting RATE_LIMIT_DISABLED=true in the
// test webServer env disables the limiters at module load — no
// effect on the deployed app where the env var is unset.
const RATE_LIMIT_DISABLED = process.env.RATE_LIMIT_DISABLED === "true";
const skipWhenDisabled = () => RATE_LIMIT_DISABLED;

// 20 requests / 15 min / IP for auth + password flows. Tight enough
// to slow brute-force, loose enough that a real user fat-fingering
// their password a couple of times isn't locked out.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  message: { error: "Too many attempts, please try again in 15 minutes." },
  skip: skipWhenDisabled,
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
  skip: skipWhenDisabled,
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
// `application_name` is propagated to pg_stat_activity. Setting
// distinct values on the writer + reader pools lets an operator
// tell from a `SELECT application_name FROM pg_stat_activity`
// query which side of the wiring served any given connection —
// invaluable when verifying read-replica routing.
const POOL_APP_NAME_WRITER = "dive-recorder-writer";
const POOL_APP_NAME_READER = "dive-recorder-reader";

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      application_name: POOL_APP_NAME_WRITER,
    })
  : new Pool({
      user:     process.env.DB_USER     || process.env.PGUSER,
      host:     process.env.DB_HOST     || process.env.PGHOST,
      database: process.env.DB_DATABASE || process.env.PGDATABASE,
      password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
      port:     process.env.DB_PORT     || process.env.PGPORT,
      application_name: POOL_APP_NAME_WRITER,
    });

// -------------------------------------------------------------
// Optional read replica
// -------------------------------------------------------------
// When DATABASE_READ_URL is set, heavy read paths (analytics,
// archive listing, per-event recap) route to a Postgres streaming
// replica so they don't contend with live writes on the primary.
// Live-scoring reads (scoreboard, attendance, queue) intentionally
// stay on the primary — replication lag (typically <1s but
// variable) is acceptable for "what was the diver's PB last year"
// but not for "did my score just land?"
//
// Falls back to the primary when DATABASE_READ_URL isn't set, so
// single-node deployments keep working with no config change. The
// factory pattern means a route's code is identical regardless of
// whether the dep is the writer or a replica.
const readPool = process.env.DATABASE_READ_URL
  ? new Pool({
      connectionString: process.env.DATABASE_READ_URL,
      application_name: POOL_APP_NAME_READER,
    })
  : pool;
if (readPool !== pool) {
  logger.info({ host: new URL(process.env.DATABASE_READ_URL).host },
    "read replica configured");
}

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
  requireTotpForPrivilegedRoles,
} = require("./lib/middleware")({ pool, JWT_SECRET });

// Convenience aliases — defined once so a typo can't drift the
// role tuple across 20+ route mountings. Used throughout.
//
// Each is an array of middleware (Express accepts arrays anywhere
// a single function is accepted, so the call sites that take
// these as factory deps don't need to know). The TOTP gate is
// pre-wired but no-ops unless TOTP_REQUIRED_FOR_ADMINS=true is
// set in the env — see lib/middleware.js for the rollout
// rationale.
const requireMeetEditor = [
  requireOrgRole(["org_admin", "meet_manager"]),
  requireTotpForPrivilegedRoles,
];
const requireOrgAdmin = [
  requireOrgRole(["org_admin"]),
  requireTotpForPrivilegedRoles,
];

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
// METRICS — Prometheus scrape target
// =============================================================
// `text/plain; version=0.0.4` (the prom-client default) is the
// content-type Prometheus expects. No auth gate — the payload
// contains operational counters only (no PII), and access should
// be restricted at the firewall / reverse proxy if you don't want
// it public. lib/metrics.js documents the cardinality discipline
// each metric follows.
app.get("/metrics", async (_req, res) => {
  try {
    metrics.collectPoolStats(pool);
    res.set("Content-Type", metrics.registry.contentType);
    res.end(await metrics.registry.metrics());
  } catch (err) {
    logger.error({ err }, "metrics scrape failed");
    res.status(500).end();
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
// ORGANISATION + CLUBS ROUTES
// [SECTION: ROUTES — ORGANISATIONS]
// /api/orgs/* and /api/clubs/* extracted into routes/orgs.js.
// /api/orgs/:id/divers (used by the synchro-partner picker)
// also lives there since it's a per-org listing.
// =============================================================
app.use(require("./routes/orgs")({
  pool,
  verifyToken,
  requireSystemAdmin,
  requireMeetEditor,
}));

// =============================================================
// TEAM ROUTES
// [SECTION: ROUTES — TEAMS]
// /api/orgs/:id/teams, /api/teams/*, team_members,
// /api/teams/:id/dive-lists, and the event_teams routes
// (/api/events/:id/teams[/...]) extracted into routes/teams.js.
// =============================================================
app.use(require("./routes/teams")({
  pool,
  requireMeetEditor,
  requireEventManager,
  bulkWriteLimiter,
  ensureEventOrgGate,
  isInSameOrg,
  loadEventForEntries,
}));

// =============================================================
// COACH ROUTES
// [SECTION: ROUTES — COACH]
// /api/coach/dashboard, /api/coach/divers, /api/orgs/:id/coach-links,
// /api/coach-links/:id extracted into routes/coach.js.
// =============================================================
app.use(require("./routes/coach")({
  pool,
  verifyToken,
  requireOrgAdmin,
}));

// Cross-org diver search + browse + orgs/all live in routes/
// diver-search.js — extracted to keep server.js manageable. See
// AGENTS.md for the modularisation plan.
app.use(require("./routes/diver-search")({ pool, verifyToken }));

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
// /api/orgs/:id/meets, /api/meets/*, /api/events/:id/meet
// extracted into routes/meets.js.
// =============================================================
app.use(require("./routes/meets")({
  pool,
  requireMeetEditor,
  requireEventManager,
}));

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

// =============================================================
// EVENT STAFF — managers + judges + per-judge views
// [SECTION: ROUTES — EVENT STAFF]
// /api/events/:id/managers (CRUD), /api/events/:id/judges (panel
// CRUD), /api/events/:eventId/my-judge-number, /api/judge/my-events
// extracted into routes/event-staff.js.
// =============================================================
app.use(require("./routes/event-staff")({
  pool,
  requireOrgRole,
  requireMeetEditor,
  requireEventManager,
  ensureEventOrgGate,
  isInSameOrg,
}));

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

app.use(require("./routes/scoreboard")({ pool, scoreboardCache, metrics }));

// =============================================================
// SCORE CORRECTION + AUDIT LOG
// [SECTION: ROUTES — SCORE CORRECTION]
// PUT /api/scores/:id (manager / referee amends a score) and
// GET /api/events/:id/score-audit (audit trail) extracted into
// routes/score-correction.js. The HTTP correction handler also
// invalidates scoreboardCache and broadcasts a `score_corrected`
// socket event to the event's room — needs both io and the
// cache as factory deps.
// =============================================================
app.use(require("./routes/score-correction")({
  pool,
  io,
  scoreboardCache,
  requireOrgRole,
  requireEventManager,
}));

// =============================================================
// LIVE STATE — activeDivers + meetHolds
// [SECTION: LIVE STATE]
// activeDivers + meetHolds are imported earlier in the file (just
// after the email helpers) because the events router mounts before
// this point and needs the references at module-load time. Re-exposed
// in this section header for grep-ability.
// =============================================================


// =============================================================
// DIVE LIST TEMPLATES
// [SECTION: ROUTES — DIVE TEMPLATES]
// Per-diver saved combinations (CompetitorView load/save)
// extracted into routes/templates.js.
// =============================================================
app.use(require("./routes/templates")({ pool, verifyToken }));

// =============================================================
// COMPETITOR ROUTES
// [SECTION: ROUTES — COMPETITOR]
// /api/competitor/submit-list extracted into routes/competitor.js.
// =============================================================
app.use(require("./routes/competitor")({
  pool,
  requireOrgRole,
  bulkWriteLimiter,
  loadEventForEntries,
}));

// =============================================================
// DIVE DIRECTORY
// [SECTION: ROUTES — DIVE DIRECTORY]
// /api/dive-directory extracted into routes/dive-directory.js.
// =============================================================
app.use(require("./routes/dive-directory")({ pool, verifyToken }));

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
  readPool,
  verifyToken,
  parseDateRange,
}));

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
  metrics,
});

// =============================================================
// RESULTS ARCHIVE
// [SECTION: ROUTES — ARCHIVE]
// /api/archive, /api/archive/clubs, /api/archive/:eventId/results
// extracted into routes/archive.js.
// =============================================================
app.use(require("./routes/archive")({ pool, readPool }));

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
// PUBLIC DIVER PROFILE
// [SECTION: ROUTES — PUBLIC PROFILE]
// /api/public/divers/:public_slug (JSON) and /diver/:public_slug
// (server-rendered OG-tagged HTML for social-network crawlers,
// SPA fall-through for browsers). Mounted BEFORE the SPA static
// fallback so the crawler path can next() into it.
// =============================================================
app.use(require("./routes/public-profile")({ pool, readPool }));

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
      logger.info(
        { schema_version: v.rows[0].version, applied_at: v.rows[0].applied_at },
        "schema_meta loaded",
      );
    } else {
      logger.warn("schema_meta has no rows — run migration 008");
    }
  } catch (err) {
    logger.warn({ err: err.message }, "couldn't read schema_meta");
  }
  try {
    const purge = await pool.query("SELECT * FROM purge_audit_logs(30)");
    const total = purge.rows.reduce((sum, r) => sum + Number(r.deleted_rows), 0);
    if (total > 0) logger.info({ deleted_rows: total }, "purged audit log");
  } catch (err) {
    logger.warn({ err: err.message }, "purge_audit_logs failed (run migration 008?)");
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
    logger.info({ port: PORT }, "diving app started");
    bootChecks();
  });
}

module.exports = { app, server, pool, io };
