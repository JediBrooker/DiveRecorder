// Shared fixtures for the e2e suite. Each test file requires
// these helpers to get an isolated org + admin + supporting
// users/events without re-implementing the same dance.
//
// Design choice: setup goes through a mix of the public API
// (so we exercise real code paths where it's cheap) and direct
// SQL writes (for the bits that are otherwise gated by
// out-of-band steps — email verification clicks, sysadmin org
// approvals — that would make every test 10× slower for no
// extra coverage). Same trade-off the integration test makes
// (see test/integration.test.js).
//
// Tests run in parallel — every helper that creates state uses
// a per-test random slug so two parallel tests never collide.

const crypto = require("node:crypto");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");
require("dotenv").config();

// Reuse the same DB the integration tests target. Falls back to
// libpq env vars (PGHOST/etc.) if DB_* aren't set, matching
// server.js + the rest of the codebase.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      user:     process.env.DB_USER     || process.env.PGUSER,
      host:     process.env.DB_HOST     || process.env.PGHOST,
      database: process.env.DB_DATABASE || process.env.PGDATABASE,
      password: process.env.DB_PASSWORD || process.env.PGPASSWORD,
      port:     process.env.DB_PORT     || process.env.PGPORT,
    });

// Constant password used for every synthetic user. Real e2e tests
// shouldn't be in the business of testing password strength —
// that's a unit-test concern. We just need a string ≥8 chars
// that bcrypt-compares cleanly.
const TEST_PASSWORD = "e2e-test-password-1234";

function rand() {
  return crypto.randomBytes(4).toString("hex");
}

// Register a fresh org via /api/auth/register-org, mark the org
// active + the founding admin email-verified (both gates would
// otherwise refuse login on a synthetic user with no real
// inbox), then log in via /api/auth/login. Returns everything
// the rest of a test needs to act as that org's admin.
async function createOrgAndAdmin(request) {
  const slug = `e2e-${rand()}`;
  const username = `e2e-admin-${slug}`;

  // 1. Create the org + founding admin via the public API.
  const reg = await request.post("/api/auth/register-org", {
    data: {
      org_name:     `E2E Org ${slug}`,
      country_code: "TST",
      slug,
      username,
      password:     TEST_PASSWORD,
      full_name:    "E2E Test Admin",
    },
  });
  if (reg.status() !== 201) {
    throw new Error(`register-org ${reg.status()}: ${await reg.text()}`);
  }
  const { org_id: orgId } = await reg.json();

  // 2. Sysadmin bypass: mark the org active + admin verified
  //    directly. The real flow needs a sysadmin to approve the
  //    org and the admin to click an email link; both are
  //    out-of-band for an e2e and would 10× the test runtime.
  await pool.query(
    "UPDATE organisations SET status = 'active' WHERE id = $1",
    [orgId],
  );
  const u = await pool.query(
    `UPDATE users SET email_verified_at = now()
     WHERE org_id = $1 AND username = $2 RETURNING id`,
    [orgId, username],
  );
  const adminId = u.rows[0].id;

  // 3. Log in via the public API to get a real session JWT.
  const login = await request.post("/api/auth/login", {
    data: { username, password: TEST_PASSWORD },
  });
  if (login.status() !== 200) {
    throw new Error(`login ${login.status()}: ${await login.text()}`);
  }
  const { token: adminToken } = await login.json();

  return { orgId, adminId, adminToken, slug, username };
}

// Insert a user with a single org_role directly. Bypasses the
// public registration flow because we don't need to exercise it
// in every test — just need a user with the role set up.
async function insertUser({ orgId, role, fullName }) {
  const username = `e2e-${role}-${rand()}`;
  // bcrypt cost 4 — fine for a fixture user nobody will brute
  // force; default 12 would add ~150ms per insertion.
  const hash = await bcrypt.hash(TEST_PASSWORD, 4);
  const r = await pool.query(
    `INSERT INTO users (username, password, full_name, org_id, email_verified_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [username, hash, fullName || `E2E ${role}`, orgId],
  );
  const userId = r.rows[0].id;
  await pool.query(
    "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1, $2, $3)",
    [userId, orgId, role],
  );
  return { userId, username, password: TEST_PASSWORD };
}

// Log in via the public API. Wraps the JSON response shape so a
// caller can pull out the token without re-implementing the
// boilerplate.
async function loginAs(request, username, password = TEST_PASSWORD) {
  const r = await request.post("/api/auth/login", {
    data: { username, password },
  });
  if (r.status() !== 200) {
    throw new Error(`login ${username}: ${r.status()} ${await r.text()}`);
  }
  return await r.json();   // { token, ... } OR { needs_totp, totp_token }
}

// Create an event via the public API. Caller passes the admin
// token; the event is created in the admin's org.
async function createEvent(request, { adminToken, ...overrides }) {
  const r = await request.post("/api/events", {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: {
      name: `E2E Event ${rand()}`,
      gender: "Female",
      number_of_judges: 5,
      total_rounds: 3,
      height: "3m",
      event_type: "individual",
      ...overrides,
    },
  });
  if (r.status() !== 201) {
    throw new Error(`create event: ${r.status()} ${await r.text()}`);
  }
  return await r.json();   // full event row
}

// Replace the panel for an event. Order matters — judge_number
// is assigned by position in the array.
async function assignJudges(request, { adminToken, eventId, judgeIds }) {
  const r = await request.post(`/api/events/${eventId}/judges`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { judgeIds },
  });
  if (r.status() !== 200) {
    throw new Error(`assign judges: ${r.status()} ${await r.text()}`);
  }
}

// Pre-populate a competitor's dive list directly. Bypasses
// /api/competitor/submit-list because that endpoint requires
// the competitor to be logged in as themselves AND the event to
// be Upcoming AND entries_close_at not reached — fine for the
// competitor-flow test that exercises that path explicitly,
// overhead for every other test.
async function insertDiveList({ eventId, competitorId, dives }) {
  for (const { round_number, dive_id } of dives) {
    await pool.query(
      `INSERT INTO competitor_dive_lists (event_id, competitor_id, round_number, dive_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (event_id, competitor_id, round_number)
       DO UPDATE SET dive_id = EXCLUDED.dive_id`,
      [eventId, competitorId, round_number, dive_id],
    );
  }
}

// Look up a real dive_id from the directory. The directory is
// loaded by init.sql with ~830 World Aquatics dives — pick one
// matching the height + position so it composes sanely with
// calc_event_dive_points.
async function pickDiveId({ height = 3.0, dive_code = "101", position = "B" } = {}) {
  // dive_directory.height is numeric (e.g. 3.0, 10.0), distinct
  // from events.height which is the board_height enum ("3m",
  // "10m"). The two carry the same information; the enum is
  // for human-friendly UI labels.
  const r = await pool.query(
    `SELECT id FROM dive_directory
     WHERE height = $1::numeric AND dive_code = $2 AND position = $3::dive_position
     LIMIT 1`,
    [height, dive_code, position],
  );
  if (!r.rows.length) {
    throw new Error(`no dive_directory row for ${height}m ${dive_code}${position}`);
  }
  return r.rows[0].id;
}

// Set the event status by URL. Used to flip Upcoming → Live so
// scoring routes accept submissions.
async function setEventStatus(request, { adminToken, eventId, status }) {
  const r = await request.put(`/api/events/${eventId}/status`, {
    headers: { Authorization: `Bearer ${adminToken}` },
    data: { status },
  });
  if (r.status() !== 200) {
    throw new Error(`set status: ${r.status()} ${await r.text()}`);
  }
}

// Direct DB cleanup for a parallel-safe per-test teardown.
// Cascades through the FKs (events, dive lists, scores, etc),
// EXCEPT for users.org_id which is ON DELETE RESTRICT to keep a
// stray data-integrity bug from silently dropping a real org's
// roster in production. Delete users explicitly first so the
// downstream cascade can take care of everything else.
async function deleteOrg(orgId) {
  await pool.query("DELETE FROM users WHERE org_id = $1", [orgId]);
  await pool.query("DELETE FROM organisations WHERE id = $1", [orgId]);
}

// =============================================================
// HEADED-WATCHER HELPERS
// Small UX shims that make a --headed e2e run easier to follow
// for a human watching over the operator's shoulder. Both gated
// behind env vars so CI runs are unaffected by default.
//
//   installDialogDelay(page)
//     Wraps page.on('dialog') with a configurable dwell so
//     window.confirm() popups (Randomise, Finalise, Reset…) stay
//     visible long enough to read. Set E2E_DIALOG_HOLD_MS=5000
//     for a leisurely demo; default 0 = instant accept (CI).
//
//   installClickHighlight(page)
//     Adds an init script that draws a brief animated cyan ring
//     at every pointerdown so the watcher can see where each
//     click lands. Default ON; set E2E_HIGHLIGHT=0 to disable
//     (e.g. for screenshot-comparison tests).
// =============================================================

const DIALOG_HOLD_MS = Number(process.env.E2E_DIALOG_HOLD_MS ?? 0);
async function installDialogDelay(page) {
  page.on("dialog", async (d) => {
    if (DIALOG_HOLD_MS > 0) {
      await new Promise((r) => setTimeout(r, DIALOG_HOLD_MS));
    }
    try { await d.accept(); }
    catch { /* dialog may already be dismissed if test moved on */ }
  });
}

const HIGHLIGHT_ENABLED = process.env.E2E_HIGHLIGHT !== "0";
async function installClickHighlight(page) {
  if (!HIGHLIGHT_ENABLED) return;

  // Surface every captured click in the Playwright stdout
  // (along with x,y) so a watching human can see in the test
  // log whether the listener is actually firing. Useful when
  // the visual marker is somehow being clipped / hidden by an
  // SPA modal — confirms the click was caught even if the
  // ring isn't visible on the screenshot/video.
  page.on("console", (msg) => {
    const t = msg.text();
    if (t.startsWith("[e2e-")) {
      process.stdout.write(`  ${t}\n`);
    }
  });

  await page.addInitScript(() => {
    // ----- 0. Init-script heartbeat ----------------------------
    // Fires before any DOM exists. If this log doesn't show up
    // in the test runner stdout, addInitScript isn't being
    // applied to this page (e.g. page was closed and a new one
    // opened without re-installing the helper). Everything else
    // depends on this firing — debug from here first.
    try { console.log(`[e2e-init] script loaded @ ${location.href}`); }
    catch { /* console may not exist yet at document_start */ }
    document.addEventListener("DOMContentLoaded", () => {
      try { console.log(`[e2e-init] DOMContentLoaded @ ${location.href}`); }
      catch { /* ignore */ }
    });
    // ----- 1. Click listeners (DOM-free, attach NOW) -----------
    // These hang off `window` + `document`, both of which exist
    // at document_start before any HTML is parsed. Attach first
    // so even if the DOM-painting code below throws (e.g.
    // documentElement is null this early), we still log every
    // click that happens on the page.
    let lastTs = 0;
    const STYLE_ID = "__e2e-click-style";
    const handler = (e) => {
      if (e.timeStamp - lastTs < 80) return;
      lastTs = e.timeStamp;
      paintMarker(e.clientX, e.clientY);
    };
    for (const target of [window, document]) {
      for (const evt of ["pointerdown", "mousedown", "click"]) {
        target.addEventListener(evt, handler, true);
      }
    }

    // ----- 2. Visible "I am alive" banner ----------------------
    // Pinned-top-right pill that proves the init script is
    // running on the current document. If you don't see this in
    // headed mode, the script never loaded — debug from there
    // rather than chasing the click handler.
    function ensureBanner() {
      if (!document.body) return;
      if (document.getElementById("__e2e-banner")) return;
      const b = document.createElement("div");
      b.id = "__e2e-banner";
      b.textContent = "● E2E click-highlight active";
      b.style.cssText = [
        "position:fixed", "top:8px", "right:8px",
        "z-index:2147483647", "pointer-events:none",
        "background:#ff2dd6", "color:#fff",
        "font:700 11px/1 system-ui,sans-serif",
        "letter-spacing:0.08em",
        "padding:6px 10px", "border-radius:999px",
        "box-shadow:0 0 12px rgba(255,45,214,0.7)",
      ].join(";");
      document.body.appendChild(b);
    }

    // ----- 3. Stylesheet --------------------------------------
    // Defer attachment until something exists to attach to. At
    // document_start neither documentElement nor head are
    // present yet, so installing the <style> immediately throws
    // and would silently truncate the rest of the init script.
    function ensureStyle() {
      if (document.getElementById(STYLE_ID)) return;
      const host = document.head || document.documentElement;
      if (!host) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = `
        @keyframes e2eClickRing {
          0%   { transform: scale(0.15); opacity: 1;    }
          25%  { transform: scale(1.0);  opacity: 0.95; }
          100% { transform: scale(3.5);  opacity: 0;    }
        }
        @keyframes e2eClickFlash {
          0%   { opacity: 0.40; }
          100% { opacity: 0;    }
        }
        @keyframes e2eClickDot {
          0%, 70%   { opacity: 1;   transform: scale(1);   }
          100%      { opacity: 0;   transform: scale(0.6); }
        }
        .__e2e-click-flash {
          position: fixed; inset: 0;
          z-index: 2147483646; pointer-events: none;
          background: radial-gradient(circle at var(--cx, 50%) var(--cy, 50%),
                                      rgba(255,45,214,0.55) 0%,
                                      rgba(255,45,214,0.0) 35%);
          animation: e2eClickFlash 0.45s ease-out forwards;
        }
        .__e2e-click-marker {
          position: fixed; z-index: 2147483647; pointer-events: none;
          width: 96px; height: 96px;
          margin-left: -48px; margin-top: -48px;
        }
        .__e2e-click-marker .ring {
          position: absolute; inset: 0;
          border: 6px solid #ff2dd6;
          border-radius: 50%;
          box-shadow:
            0 0 24px rgba(255, 45, 214, 1),
            0 0 48px rgba(255, 45, 214, 0.7),
            inset 0 0 16px rgba(255, 45, 214, 0.6);
          animation: e2eClickRing 1.6s cubic-bezier(0.2,0.6,0.3,1) forwards;
        }
        .__e2e-click-marker .core {
          position: absolute; left: 50%; top: 50%;
          width: 22px; height: 22px;
          margin-left: -11px; margin-top: -11px;
          background: #ff2dd6;
          border: 3px solid #fff;
          border-radius: 50%;
          box-shadow: 0 0 14px #fff, 0 0 28px rgba(255,45,214,0.9);
          animation: e2eClickDot 2.0s ease-out forwards;
        }
        /* Plus-sign crosshair through the dot — exact pixel. */
        .__e2e-click-marker .core::before,
        .__e2e-click-marker .core::after {
          content: ""; position: absolute; background: #fff;
          box-shadow: 0 0 6px rgba(255,255,255,0.9);
        }
        .__e2e-click-marker .core::before {
          left: 50%; top: -14px; bottom: -14px;
          width: 3px; margin-left: -1.5px;
        }
        .__e2e-click-marker .core::after {
          top: 50%; left: -14px; right: -14px;
          height: 3px; margin-top: -1.5px;
        }
      `;
      host.appendChild(style);
    }

    // ----- 4. paintMarker — used by the listener attached in §1
    function paintMarker(x, y) {
      ensureStyle();
      ensureBanner();
      const target = document.body;
      if (!target) {
        // No body yet (click before HTML parsed?). Just log so
        // the test runner can still see the listener fired.
        try { console.log(`[e2e-click] ${Math.round(x)},${Math.round(y)} (no body)`); } catch {}
        return;
      }
      // Full-screen tint flash.
      const flash = document.createElement("div");
      flash.className = "__e2e-click-flash";
      flash.style.setProperty("--cx", x + "px");
      flash.style.setProperty("--cy", y + "px");
      target.appendChild(flash);
      setTimeout(() => flash.remove(), 500);
      // Pointer marker with ring + dot + crosshair.
      const wrap = document.createElement("div");
      wrap.className = "__e2e-click-marker";
      wrap.style.left = x + "px";
      wrap.style.top  = y + "px";
      wrap.innerHTML = '<div class="ring"></div><div class="core"></div>';
      target.appendChild(wrap);
      setTimeout(() => wrap.remove(), 2100);
      // Log so the test runner can confirm the listener fired.
      try { console.log(`[e2e-click] ${Math.round(x)},${Math.round(y)}`); }
      catch { /* console may be muted */ }
    }

    // ----- 5. Run banner + style installation when DOM is ready
    if (document.body) { ensureStyle(); ensureBanner(); }
    document.addEventListener("DOMContentLoaded", () => {
      ensureStyle();
      ensureBanner();
    });
  });
}

module.exports = {
  pool,
  TEST_PASSWORD,
  rand,
  createOrgAndAdmin,
  insertUser,
  loginAs,
  createEvent,
  assignJudges,
  insertDiveList,
  pickDiveId,
  setEventStatus,
  deleteOrg,
  installDialogDelay,
  installClickHighlight,
};
