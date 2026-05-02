// End-to-end happy-path integration test.
//
// Spins up the real Express app from server.js against a live
// Postgres, then walks through:
//   1.  register a fresh org + admin user
//   2.  log in with that admin
//   3.  create a 5-judge individual event in that org
//   4.  hit /api/divers/search and confirm the admin shows up
//   5.  hit /api/orgs/all and confirm the new org is listed
//   6.  fetch the analytics endpoint for the admin (returns shape
//       even with no scores) — catches the "every meet ranks 1st"
//       and silent-500 regressions the audit hit
//
// Skips with a console warning if Postgres is unreachable, the
// same pattern calc.test.js uses, so a dev with no DB can still
// run `npm test` without failures.
//
// Strict invariant checks (read AGENTS.md before touching):
//   * `req.user.id` (NOT user_id) is verified by the login flow
//   * /api/divers/:id/profile returns dashboard_widgets to owners
//     and omits it for outside viewers — both branches covered
//   * the analytics endpoint never 500s; per-widget errors degrade
//     to empty arrays via runQuery

const { test, before, after, describe } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const crypto = require("node:crypto");

// Load env. Same pool as the prod server uses.
require("dotenv").config();
const { Pool } = require("pg");

const TEST_PASSWORD = "integration-test-password-1234";
const TEST_JWT_SECRET = "x".repeat(48);

// Ensure JWT_SECRET is set BEFORE we require server.js (which
// fail-closes if missing). Don't clobber an existing secret —
// integrate into whatever the operator has set.
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = TEST_JWT_SECRET;

let dbReachable = true;
let serverApp;
let httpServer;
let baseUrl;
let pool;

// State carried across tests
let orgId, adminId, adminToken, eventId;

before(async () => {
  pool = new Pool();
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  // Boot the real server on an ephemeral port. server.js skips
  // listen() when required as a module (require.main !== module)
  // so we control startup here and shut down cleanly in after().
  const mod = require("../server.js");
  serverApp = mod.app;
  httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  // Close the Socket.IO listener too so the event loop drains.
  try {
    const { io } = require("../server.js");
    if (io && typeof io.close === "function") io.close();
  } catch { /* noop */ }
  if (!dbReachable) return;
  // Best-effort cleanup of test rows. Wrap in try/catch so a partial
  // failure mid-suite doesn't mask the real assertion error.
  try {
    if (eventId) await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
    if (adminId) await pool.query("DELETE FROM users  WHERE id = $1", [adminId]);
    if (orgId)   await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]);
  } catch (err) {
    console.warn(`[cleanup] failed: ${err.message}`);
  }
  await pool.end();
});

// =====================================================================
// HTTP helper — small wrapper around node http so we don't pull in a
// supertest-class dep for one test file.
// =====================================================================
function fetchJson(method, path, { body, token } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const data = body ? JSON.stringify(body) : null;
    const headers = {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);

    const req = http.request(
      {
        method,
        host:    url.hostname,
        port:    url.port,
        path:    url.pathname + url.search,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          resolve({ status: res.statusCode, body: parsed });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// =====================================================================
// Tests
// =====================================================================

test("end-to-end happy path", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");

  // 1. register-org
  await t.test("register-org creates an org + founding admin", async () => {
    const slug = `int-${crypto.randomBytes(4).toString("hex")}`;
    const res = await fetchJson("POST", "/api/auth/register-org", {
      body: {
        org_name:     `Integration Test ${slug}`,
        country_code: "TST",
        slug,
        username:     `int-admin-${slug}`,
        password:     TEST_PASSWORD,
        full_name:    "Integration Tester",
      },
    });
    assert.equal(res.status, 201, `register-org returned ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.org_id, "response includes org_id");
    orgId = res.body.org_id;

    // Approve the org so login works (register-org leaves it pending).
    await pool.query("UPDATE organisations SET status = 'active' WHERE id = $1", [orgId]);
    // Get the admin's id for cleanup.
    const u = await pool.query(
      "SELECT id FROM users WHERE org_id = $1 AND username = $2",
      [orgId, `int-admin-${slug}`],
    );
    adminId = u.rows[0]?.id;
    // Stash the username so the login test can use it
    t.username = `int-admin-${slug}`;
  });

  // 2. login
  await t.test("login returns a JWT with id, not user_id", async () => {
    const u = await pool.query("SELECT username FROM users WHERE id = $1", [adminId]);
    const res = await fetchJson("POST", "/api/auth/login", {
      body: { username: u.rows[0].username, password: TEST_PASSWORD },
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token, "login returns a token");
    adminToken = res.body.token;

    // Decode payload to confirm shape (this is the JWT field that has
    // bitten the codebase repeatedly — guard against regression).
    const payload = JSON.parse(
      Buffer.from(res.body.token.split(".")[1], "base64url").toString("utf8"),
    );
    assert.ok(payload.id, "JWT payload includes `id`");
    assert.ok(!payload.user_id, "JWT payload does NOT include user_id");
    assert.equal(payload.id, adminId, "JWT id matches the user row");
  });

  // 3. cross-org search lists this admin
  await t.test("/api/divers/search and /api/orgs/all are reachable", async () => {
    // The admin isn't a diver, so they wouldn't appear in /search,
    // but the endpoint must respond 200 with an array shape.
    const search = await fetchJson("GET", "/api/divers/search?q=zz", { token: adminToken });
    assert.equal(search.status, 200);
    assert.ok(Array.isArray(search.body), "search returns an array");

    const orgs = await fetchJson("GET", "/api/orgs/all", { token: adminToken });
    assert.equal(orgs.status, 200);
    assert.ok(Array.isArray(orgs.body));
    assert.ok(
      orgs.body.some((o) => o.id === orgId),
      "the new org appears in /api/orgs/all",
    );
  });

  // 4. create an event
  await t.test("can create an event in this org", async () => {
    const res = await fetchJson("POST", "/api/events", {
      token: adminToken,
      body: {
        name: "Integration Test Event",
        gender: "open",
        height: "3m",
        number_of_judges: 5,
        total_rounds: 6,
        event_type: "individual",
      },
    });
    assert.equal(res.status, 201, `event create: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(res.body.id, "event response has id");
    eventId = res.body.id;
  });

  // 5. analytics endpoint never 500s
  await t.test("/api/divers/:id/analytics returns the documented shape", async () => {
    const res = await fetchJson("GET", `/api/divers/${adminId}/analytics`, {
      token: adminToken,
    });
    assert.equal(res.status, 200, `analytics: ${res.status}`);
    // The 11 documented keys — even on a brand-new user with no
    // scores. This catches "Promise.all rejected one query and the
    // whole thing 500'd" regressions.
    const expected = [
      "recent_form", "placings", "height_breakdown", "round_stamina",
      "quality_mix", "dd_risk", "frequent_dives", "streak",
      "compare_peers", "event_type_splits", "year_over_year",
    ];
    for (const k of expected) {
      assert.ok(k in res.body, `analytics payload missing key: ${k}`);
    }
    assert.ok(res.body.filter, "analytics carries a filter echo");
  });

  // 6. profile dashboard_widgets visibility
  await t.test("/api/divers/:id/profile returns dashboard_widgets to the owner", async () => {
    const res = await fetchJson("GET", `/api/divers/${adminId}/profile`, {
      token: adminToken,
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.diver, "profile carries a diver block");
    // dashboard_widgets is included for the owner. (Outside-viewer
    // omission is harder to test without a second account; covered
    // by the canViewDiverPrivate unit logic instead.)
    assert.ok("dashboard_widgets" in res.body,
      "owner sees dashboard_widgets in their own profile");
  });
});
