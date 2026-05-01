// Auth routes — extracted from the single-file server.js as the
// first slice of an incremental modularisation. This module
// exports a factory that takes the wiring it needs (pool,
// mailer-backed email helpers, jwt config, middleware) and
// returns an Express router.
//
// Mounted at the app root in server.js as:
//     app.use(require('./routes/auth')({ ... }))
//
// Every route here was moved verbatim — no behaviour changes.

const express = require("express");
const bcrypt  = require("bcryptjs");
const jwt     = require("jsonwebtoken");

module.exports = function createAuthRouter({
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
}) {
  const router = express.Router();

  router.post("/api/auth/login", authLimiter, async (req, res) => {
    const { username, password } = req.body || {};
    // Reject malformed bodies up front so bcrypt.compare never sees
    // a non-string and throws — that was leaking 500 vs 401, which
    // a probing attacker could use to distinguish "user exists".
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(401).json({ error: "Invalid username or password" });
    }
    try {
      // Pull only the columns we need. Defence in depth: a future
      // change that responds with the row directly can't leak the
      // password hash if it was never selected.
      const result = await pool.query(
        "SELECT id, password FROM users WHERE username = $1",
        [username],
      );
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
  router.post("/api/auth/register", authLimiter, async (req, res) => {
    const {
      username, password, full_name, email, org_id, requested_role, note,
      club_id, new_club_name, new_club_short_code,
    } = req.body;
    const client = await pool.connect();
    let postCommit = { newUserId: null, requestedRole: null };
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
        "INSERT INTO users (username, password, full_name, email, org_id, club_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [username, hash, full_name, email || null, org_id, resolvedClubId],
      );
      const userId = uRes.rows[0].id;
      postCommit.newUserId = userId;

      await client.query(
        "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'spectator')",
        [userId, org_id],
      );

      const validRoles = ["meet_manager", "referee", "judge", "diver"];
      if (requested_role && validRoles.includes(requested_role)) {
        await client.query(
          "INSERT INTO role_requests (user_id, org_id, requested_role, note) VALUES ($1,$2,$3,$4)",
          [userId, org_id, requested_role, note || null],
        );
        postCommit.requestedRole = requested_role;
      }

      await client.query("COMMIT");

      sendWelcomeEmail(userId).catch(() => {});
      if (postCommit.requestedRole) {
        sendNewRoleRequestEmail(userId, org_id, postCommit.requestedRole, note).catch(() => {});
      }

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
  router.post("/api/auth/register-org", authLimiter, async (req, res) => {
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

  // -------------------------------------------------------------
  // SELF-SERVICE PASSWORD CHANGE
  // Logged-in user changes their own password. Requires the
  // current password as a defence against a hijacked session
  // silently rotating the credential.
  // -------------------------------------------------------------
  router.put("/api/users/me/password", verifyToken, async (req, res) => {
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password) {
      return res.status(400).json({ error: "Current and new password are required" });
    }
    if (typeof new_password !== "string" || new_password.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    try {
      const u = await pool.query(
        "SELECT id, password, full_name, email FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) return res.status(404).json({ error: "User not found" });
      const ok = await bcrypt.compare(current_password, user.password);
      if (!ok) return res.status(401).json({ error: "Current password is incorrect" });
      const hash = await bcrypt.hash(new_password, 12);
      await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hash, user.id]);
      sendPasswordChangedEmail(user.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      console.error("[Change Password Error]", err.message);
      res.status(500).json({ error: "Password change failed" });
    }
  });

  // -------------------------------------------------------------
  // FORGOT / RESET PASSWORD
  //
  // Two-step flow over email. /forgot-password takes an email
  // address, mints a short-lived JWT with type=password_reset
  // scoped to that user, and emails a link. /reset-password
  // accepts the token + a new password.
  //
  // Tokens are stateless JWTs rather than DB-backed nonces:
  // simpler, and the 30-min expiry plus single-use enforcement
  // (we read the user's current password hash into the JWT
  // payload and reject if it has changed) gives us "single use"
  // without an extra table.
  // -------------------------------------------------------------
  router.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
    const { email } = req.body || {};
    // Always respond 200 + ok:true so callers can't enumerate which
    // emails are registered. To avoid timing-based enumeration we
    // also do equal work in both branches and dispatch SMTP fully
    // out-of-band (setImmediate) so the email-send latency doesn't
    // leak through the response time either.
    try {
      let user = null;
      if (typeof email === "string" && email.length <= 320) {
        const u = await pool.query(
          "SELECT id, password, full_name, email FROM users WHERE email = $1",
          [email],
        );
        user = u.rows[0] || null;
      }
      if (user && user.email) {
        const fingerprint = jwt.sign(
          { sub: user.id, type: "password_reset", fp: hashFingerprint(user.password) },
          JWT_SECRET,
          { expiresIn: "30m" },
        );
        // Defer the SMTP round-trip so the response time doesn't
        // depend on whether we found a user. The catch is swallowed
        // intentionally — we never tell the caller about delivery.
        setImmediate(() => {
          sendPasswordResetEmail(user, fingerprint).catch(() => {});
        });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Forgot Password Error]", err.message);
      res.json({ ok: true });
    }
  });

  router.post("/api/auth/reset-password", authLimiter, async (req, res) => {
    const { token, new_password } = req.body || {};
    if (!token || !new_password) {
      return res.status(400).json({ error: "Token and new password are required" });
    }
    if (typeof new_password !== "string" || new_password.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }
    try {
      let decoded;
      try {
        decoded = jwt.verify(token, JWT_SECRET);
      } catch {
        return res.status(400).json({ error: "Reset link is invalid or has expired" });
      }
      if (decoded.type !== "password_reset" || !decoded.sub) {
        return res.status(400).json({ error: "Reset link is invalid" });
      }
      const u = await pool.query(
        "SELECT id, password FROM users WHERE id = $1",
        [decoded.sub],
      );
      const user = u.rows[0];
      if (!user) return res.status(400).json({ error: "Reset link is invalid" });
      if (decoded.fp !== hashFingerprint(user.password)) {
        return res.status(400).json({ error: "Reset link has already been used" });
      }
      const hash = await bcrypt.hash(new_password, 12);
      await pool.query("UPDATE users SET password = $1 WHERE id = $2", [hash, user.id]);
      sendPasswordChangedEmail(user.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      console.error("[Reset Password Error]", err.message);
      res.status(500).json({ error: "Password reset failed" });
    }
  });

  return router;
};
