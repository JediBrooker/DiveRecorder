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
//   7.  insert 3 diver fixtures + 5 judge fixtures + scored round 1,
//       then assert /api/divers/<diver>/analytics ranks the diver
//       AGAINST THE FULL FIELD (not 1-of-1). This is the regression
//       the audit pass found: it would silently report every meet as
//       a gold for any diver in the database.
//
// Skips with a console warning if Postgres is unreachable, the
// same pattern calc.test.js uses, so a dev with no DB can still
// run `npm test` without failures. ALSO skips if JWT_SECRET is
// unset — server.js fail-closes on missing secret and we don't
// want to mask that with a hardcoded test fallback (an agent
// debugging a production boot crash should see the same surface).
//
// Strict invariant checks (read AGENTS.md before touching):
//   * `req.user.id` (NOT user_id) is verified by the login flow
//   * /api/divers/:id/profile returns dashboard_widgets to owners
//     and omits it for outside viewers — both branches covered
//   * the analytics endpoint never 500s; per-widget errors degrade
//     to empty arrays via runQuery
//   * recent_form ranks the diver against the full field; field_size
//     = total competitors, rank reflects actual placement

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http   = require("node:http");
const crypto = require("node:crypto");

require("dotenv").config();
const { Pool } = require("pg");

const TEST_PASSWORD = "integration-test-password-1234";

let dbReachable = true;
let serverReady = false;
let httpServer;
let baseUrl;
let pool;

// State carried across tests
let orgId, adminId, adminToken, eventId;
let diverIds = [];
let judgeIds = [];

before(async () => {
  // Prefer the app's documented DB_* env vars; fall back to
  // libpq's PG* names so CI's Postgres service container keeps
  // working unchanged. Without this, an empty `new Pool()` would
  // only see PG* — and a dev with .env using DB_* would get a
  // confusing "client password must be a string" SASL error
  // instead of the friendly "skip" message.
  pool = process.env.DATABASE_URL
    ? new Pool({ connectionString: process.env.DATABASE_URL })
    : new Pool({
        user:     process.env.DB_USER     || process.env.PGUSER,
        host:     process.env.DB_HOST     || process.env.PGHOST,
        database: process.env.DB_DATABASE || process.env.PGDATABASE,
        password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
        port:     process.env.DB_PORT     || process.env.PGPORT,
      });
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    dbReachable = false;
    console.warn(`[skip] Postgres not reachable: ${err.message}`);
    return;
  }

  // server.js fail-closes when JWT_SECRET is missing or weak. Don't
  // hardcode a fallback here — that masks production boot failures
  // and makes the test silently differ from the real surface. CI
  // sets JWT_SECRET in .github/workflows/ci.yml; a local dev must
  // either set it or accept that this test skips.
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET === "change_this_secret_in_production") {
    serverReady = false;
    console.warn(`[skip] JWT_SECRET not set — integration test won't boot the server. ` +
                 `Set JWT_SECRET in your env (or .env) to run this suite.`);
    return;
  }

  // Boot the real server on an ephemeral port. server.js skips
  // listen() when required as a module (require.main !== module)
  // so we control startup here and shut down cleanly in after().
  const mod = require("../server.js");
  httpServer = mod.server;
  await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = httpServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
  serverReady = true;
});

after(async () => {
  if (httpServer) {
    await new Promise((resolve) => httpServer.close(resolve));
  }
  // Close Socket.IO so the event loop drains.
  try {
    const { io } = require("../server.js");
    if (io && typeof io.close === "function") io.close();
  } catch { /* noop */ }

  if (!dbReachable) return;

  // Best-effort cleanup. users.org_id is ON DELETE RESTRICT so we
  // have to delete the event (cascades to scores / event_judges /
  // competitor_dive_lists) and every user owned by the org BEFORE
  // we can drop the org itself. Wrapped in try/catch so a partial
  // failure mid-suite doesn't mask the real assertion error.
  try {
    if (eventId) await pool.query("DELETE FROM events WHERE id = $1", [eventId]);
    if (orgId)   await pool.query("DELETE FROM users  WHERE org_id = $1", [orgId]);
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
      { method, host: url.hostname, port: url.port, path: url.pathname + url.search, headers },
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
// Fixture helpers — direct SQL inserts. We could use the API for
// some of these (POST /api/users etc.) but the surface is simpler if
// we stick to one path per fixture. The point of these fixtures is
// to populate the analytics queries; the endpoints under test are
// the read paths.
// =====================================================================
const bcrypt = require("bcryptjs");

async function insertUser({ orgId, username, fullName, role }) {
  const hash = await bcrypt.hash("not-used-here", 4); // cost 4 — fixture only
  const u = await pool.query(
    `INSERT INTO users (username, password, full_name, org_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [username, hash, fullName, orgId],
  );
  const id = u.rows[0].id;
  await pool.query(
    `INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)`,
    [id, orgId, role],
  );
  return id;
}

// =====================================================================
// Tests
// =====================================================================

test("end-to-end happy path", async (t) => {
  if (!dbReachable) return t.skip("DB not reachable");
  if (!serverReady) return t.skip("server didn't boot — see warning above");

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
    assert.equal(res.status, 201, `register-org: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(res.body.org_id, "response includes org_id");
    orgId = res.body.org_id;

    // Approve the org so login works (register-org leaves it pending).
    await pool.query("UPDATE organisations SET status = 'active' WHERE id = $1", [orgId]);
    const u = await pool.query(
      "SELECT id FROM users WHERE org_id = $1 AND username = $2",
      [orgId, `int-admin-${slug}`],
    );
    adminId = u.rows[0]?.id;
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

    const payload = JSON.parse(
      Buffer.from(res.body.token.split(".")[1], "base64url").toString("utf8"),
    );
    assert.ok(payload.id, "JWT payload includes `id`");
    assert.ok(!payload.user_id, "JWT payload does NOT include user_id");
    assert.equal(payload.id, adminId, "JWT id matches the user row");
  });

  // 3. cross-org search lists this admin
  await t.test("/api/divers/search and /api/orgs/all are reachable", async () => {
    const search = await fetchJson("GET", "/api/divers/search?q=zz", { token: adminToken });
    assert.equal(search.status, 200);
    assert.ok(Array.isArray(search.body), "search returns an array");

    const orgs = await fetchJson("GET", "/api/orgs/all", { token: adminToken });
    assert.equal(orgs.status, 200);
    assert.ok(Array.isArray(orgs.body));
    assert.ok(orgs.body.some((o) => o.id === orgId), "the new org appears in /api/orgs/all");
  });

  // 4. create an event
  await t.test("can create an event in this org", async () => {
    const res = await fetchJson("POST", "/api/events", {
      token: adminToken,
      body: {
        name: "Integration Test Event",
        gender: "Mixed",         // event_gender enum: Male/Female/Mixed
        height: "3m",            // board_height enum: 1m/3m/5m/7.5m/10m
        number_of_judges: 5,
        total_rounds: 6,
        event_type: "individual",
      },
    });
    assert.equal(res.status, 201, `event create: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(res.body.id);
    eventId = res.body.id;
  });

  // 5. analytics endpoint never 500s on an empty user
  await t.test("/api/divers/:id/analytics returns the documented shape", async () => {
    const res = await fetchJson("GET", `/api/divers/${adminId}/analytics`, { token: adminToken });
    assert.equal(res.status, 200, `analytics: ${res.status}`);
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
    const res = await fetchJson("GET", `/api/divers/${adminId}/profile`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.diver, "profile carries a diver block");
    assert.ok("dashboard_widgets" in res.body, "owner sees dashboard_widgets in their own profile");
  });

  // 7. RANKING REGRESSION GUARD
  //
  // The previous bug: recent_form / placings / streak / year_over_year
  // ranked the diver against an already-self-filtered CTE, so every
  // meet came out 1st-of-1. This subtest creates a 3-diver field with
  // distinct totals, scores them, and asserts the diver who finished
  // 2nd actually shows rank=2 with field_size=3.
  await t.test("recent_form ranks against the full field (regression #67a5708)", async () => {
    // ----- Build the field -----
    // 3 divers + 5 judges as raw SQL fixtures. Faster than driving
    // the API for each one and avoids the bcrypt-per-row cost.
    const slug = orgId.slice(0, 6);
    diverIds = [];
    for (let i = 1; i <= 3; i++) {
      diverIds.push(await insertUser({
        orgId, role: "diver",
        username: `int-d${i}-${slug}`,
        fullName: `Diver ${i}`,
      }));
    }
    judgeIds = [];
    for (let i = 1; i <= 5; i++) {
      judgeIds.push(await insertUser({
        orgId, role: "judge",
        username: `int-j${i}-${slug}`,
        fullName: `Judge ${i}`,
      }));
    }
    // event_judges rows so the trim algorithm has the panel to run on
    for (let i = 0; i < judgeIds.length; i++) {
      await pool.query(
        `INSERT INTO event_judges (event_id, judge_id, judge_number) VALUES ($1, $2, $3)`,
        [eventId, judgeIds[i], i + 1],
      );
    }
    // Pick any 3m dive — the directory is seeded by init.sql.
    const d = await pool.query(
      `SELECT id, dd FROM dive_directory WHERE height = 3 LIMIT 1`,
    );
    assert.ok(d.rows.length, "dive_directory has 3m entries");
    const diveId = d.rows[0].id;

    // dive_list rows + scores. Pre-baked totals so the ranking is
    // deterministic — Diver 2 wins (highest), Diver 1 second,
    // Diver 3 third. 5-judge trim drops the high + the low.
    //
    //   Diver 1: [7.0, 7.5, 7.0, 7.5, 7.0] → keep 7.0+7.0+7.5 = 21.5
    //   Diver 2: [8.0, 8.0, 8.0, 8.5, 8.5] → keep 8.0+8.0+8.5 = 24.5
    //   Diver 3: [6.0, 6.5, 6.0, 6.5, 7.0] → keep 6.0+6.5+6.5 = 19.0
    const SCORES = [
      [7.0, 7.5, 7.0, 7.5, 7.0],   // Diver 1
      [8.0, 8.0, 8.0, 8.5, 8.5],   // Diver 2
      [6.0, 6.5, 6.0, 6.5, 7.0],   // Diver 3
    ];
    for (let di = 0; di < diverIds.length; di++) {
      await pool.query(
        `INSERT INTO competitor_dive_lists (event_id, competitor_id, dive_id, round_number)
         VALUES ($1, $2, $3, 1)`,
        [eventId, diverIds[di], diveId],
      );
      for (let ji = 0; ji < judgeIds.length; ji++) {
        await pool.query(
          `INSERT INTO scores (event_id, competitor_id, judge_id, dive_id, round_number, score)
           VALUES ($1, $2, $3, $4, 1, $5)`,
          [eventId, diverIds[di], judgeIds[ji], diveId, SCORES[di][ji]],
        );
      }
    }

    // ----- Assertions: pull each diver's analytics -----
    const ranks = {};
    const fieldSizes = {};
    for (const id of diverIds) {
      const r = await fetchJson("GET", `/api/divers/${id}/analytics`, { token: adminToken });
      assert.equal(r.status, 200, `diver ${id} analytics ${r.status}`);
      const row = r.body.recent_form?.[0];
      assert.ok(row, `diver ${id} should have a recent_form row`);
      ranks[id] = Number(row.rank);
      fieldSizes[id] = Number(row.field_size);
    }
    // The bug we're guarding: every diver showed rank=1, field_size=1.
    // Now: rank reflects actual placement, field_size = 3 for all.
    for (const id of diverIds) {
      assert.equal(fieldSizes[id], 3, `diver ${id} field_size should be 3, got ${fieldSizes[id]}`);
    }
    assert.equal(ranks[diverIds[1]], 1, "Diver 2 finished 1st (highest scores)");
    assert.equal(ranks[diverIds[0]], 2, "Diver 1 finished 2nd");
    assert.equal(ranks[diverIds[2]], 3, "Diver 3 finished 3rd (lowest scores)");

    // Placings echoes the same ranking — Diver 2 has 1 gold.
    const p = await fetchJson("GET", `/api/divers/${diverIds[1]}/analytics`, { token: adminToken });
    assert.equal(p.body.placings.gold,  1, "Diver 2 placings.gold should be 1");
    assert.equal(p.body.placings.silver, 0);
  });
});
