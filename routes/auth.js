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
const totp    = require("../lib/totp");

// Pre-computed dummy bcrypt hash used by the login flow to keep
// the timing constant when the username doesn't exist. Without
// this, an attacker can enumerate usernames by measuring the
// response delay (no-user ≈ 5ms, bad-password ≈ 150ms). Computed
// once at module load — same cost factor (12) bcrypt.hash() uses
// for real passwords.
//
// The plaintext "*" is never a valid password; bcrypt.compare
// against this hash always returns false. We just want the
// CPU-time profile of a real comparison.
const DUMMY_BCRYPT_HASH = bcrypt.hashSync(
  // Long unguessable nonsense so that even if an attacker tried
  // this exact string they couldn't authenticate.
  Math.random().toString(36) + Date.now() + Math.random().toString(36),
  12,
);

module.exports = function createAuthRouter({
  pool,
  io,
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
        "SELECT id, password, email_verified_at, totp_enabled_at FROM users WHERE username = $1",
        [username],
      );
      const user = result.rows[0];
      // Always run bcrypt.compare — against the user's hash if we
      // found them, against a dummy hash otherwise — so the
      // response time is the same in both branches. Stops timing-
      // based username enumeration.
      const hashToCheck = user?.password || DUMMY_BCRYPT_HASH;
      const passwordOk = await bcrypt.compare(password, hashToCheck);
      if (!user || !passwordOk)
        return res.status(401).json({ error: "Invalid username or password" });

      // Migration 021: registrations must verify their email
      // before they can sign in. Existing users were grandfathered
      // (backfilled to created_at) so this only blocks accounts
      // created after the deploy that haven't clicked the link.
      if (user.email_verified_at == null) {
        return res.status(403).json({
          error: "Please verify your email — check your inbox for the link we sent at sign-up.",
          code: "email_not_verified",
        });
      }

      // Migration 022: if 2FA is enabled, the password check is
      // only the first factor. Mint a short-lived "step-up" token
      // scoped to the second-factor exchange and hand it back —
      // the client posts it with a TOTP / recovery code to
      // /api/auth/login/totp to get a real session JWT.
      if (user.totp_enabled_at != null) {
        const totp_token = jwt.sign(
          { sub: user.id, type: "totp_pending" },
          JWT_SECRET,
          { expiresIn: "5m" },
        );
        return res.json({ needs_totp: true, totp_token });
      }

      const payload = await buildTokenPayload(user.id);
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      res.json({ token, ...payload });
    } catch (err) {
      console.error("[Login Error]", err.message);
      res.status(500).json({ error: "Login failed" });
    }
  });

  // -------------------------------------------------------------
  // POST /api/auth/login/totp — second-factor exchange.
  //
  // Body: { totp_token, code }
  //   totp_token: the 5-min JWT minted by /api/auth/login above.
  //   code:       6-digit TOTP from the authenticator app, OR a
  //               10-char recovery code (with or without dash).
  //
  // Returns the same shape as /api/auth/login on success: { token,
  // ...payload }. Recovery codes are one-time — on success the
  // matched hash is removed from the user's stored array.
  // -------------------------------------------------------------
  router.post("/api/auth/login/totp", authLimiter, async (req, res) => {
    const { totp_token, code } = req.body || {};
    if (!totp_token || !code) {
      return res.status(400).json({ error: "totp_token and code are required" });
    }
    let decoded;
    try {
      decoded = jwt.verify(totp_token, JWT_SECRET);
    } catch {
      return res.status(401).json({ error: "TOTP step-up token is invalid or expired" });
    }
    if (decoded.type !== "totp_pending" || !decoded.sub) {
      return res.status(401).json({ error: "TOTP step-up token is invalid" });
    }
    try {
      const u = await pool.query(
        `SELECT id, totp_secret, totp_enabled_at, totp_recovery_codes
         FROM users WHERE id = $1`,
        [decoded.sub],
      );
      const user = u.rows[0];
      if (!user || user.totp_enabled_at == null) {
        return res.status(401).json({ error: "TOTP not enabled for this user" });
      }

      // Try TOTP first (six digits). Fall back to recovery code
      // matching only when the input doesn't look like a code.
      const looksLikeTotp = typeof code === "string" && /^\d{6}$/.test(code);
      let accepted = false;
      let consumedRecovery = false;
      if (looksLikeTotp) {
        accepted = totp.verifyToken(user.totp_secret, code);
      }
      if (!accepted) {
        const { matched, remainingHashes } = await totp.consumeRecoveryCode(
          user.totp_recovery_codes || [],
          code,
        );
        if (matched) {
          accepted = true;
          consumedRecovery = true;
          await pool.query(
            "UPDATE users SET totp_recovery_codes = $1::jsonb WHERE id = $2",
            [JSON.stringify(remainingHashes), user.id],
          );
        }
      }
      if (!accepted) {
        return res.status(401).json({ error: "Invalid TOTP / recovery code" });
      }

      const payload = await buildTokenPayload(user.id);
      const token = jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRY });
      res.json({
        token,
        ...payload,
        ...(consumedRecovery
          ? { warning: "Recovery code consumed. Re-generate your recovery codes when convenient." }
          : {}),
      });
    } catch (err) {
      console.error("[Login TOTP Error]", err.message);
      res.status(500).json({ error: "TOTP login failed" });
    }
  });

  // -------------------------------------------------------------
  // 2FA enable / disable / regenerate-recovery flow
  //
  // Three endpoints, all behind verifyToken:
  //
  //   POST /api/auth/2fa/setup   — mints a fresh secret, returns
  //                                 the QR + base32 + provisional
  //                                 recovery codes. Saves the secret
  //                                 to users.totp_secret but DOES
  //                                 NOT enable 2FA yet (totp_enabled_at
  //                                 stays NULL). User must verify a
  //                                 code via /confirm before login is
  //                                 gated.
  //
  //   POST /api/auth/2fa/confirm — { code }. Verifies a TOTP code
  //                                 against the pending secret and
  //                                 stamps totp_enabled_at + saves
  //                                 the recovery code hashes from
  //                                 the setup response. Bumps
  //                                 token_version to invalidate
  //                                 every existing session for this
  //                                 user (Migration 021 plumbing).
  //
  //   POST /api/auth/2fa/disable — { password, code? }. Requires
  //                                 the password (proof of access)
  //                                 + a current TOTP / recovery code.
  //                                 Clears all three columns.
  //
  //   GET  /api/auth/2fa/status  — { enabled: bool, recovery_codes_remaining: int|null }.
  //                                 Lets the SPA's Profile page show
  //                                 the right Enable/Disable affordance
  //                                 without trying setup first.
  // -------------------------------------------------------------
  router.get("/api/auth/2fa/status", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT totp_enabled_at,
                jsonb_array_length(COALESCE(totp_recovery_codes, '[]'::jsonb)) AS rc
         FROM users WHERE id = $1`,
        [req.user.id],
      );
      const row = r.rows[0] || {};
      res.json({
        enabled: !!row.totp_enabled_at,
        recovery_codes_remaining: row.totp_enabled_at ? Number(row.rc) || 0 : null,
      });
    } catch (err) {
      console.error("[2FA Status Error]", err.message);
      res.status(500).json({ error: "Couldn't load 2FA status" });
    }
  });

  router.post("/api/auth/2fa/setup", verifyToken, async (req, res) => {
    try {
      const u = await pool.query(
        "SELECT username, totp_enabled_at FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.totp_enabled_at != null) {
        return res.status(409).json({
          error: "2FA is already enabled. Disable it first if you want to re-set it up.",
        });
      }
      const { base32, otpauth_url, qr_data_url } = await totp.generateSecret(user.username);
      const { plain, hashes } = totp.generateRecoveryCodes(10);
      // Save the secret + provisional recovery hashes. We DON'T
      // set totp_enabled_at — until the user verifies a code via
      // /confirm, login still bypasses 2FA. This means a half-
      // finished setup (browser tab closed at the QR screen)
      // doesn't lock the user out.
      await pool.query(
        `UPDATE users
         SET totp_secret = $1,
             totp_recovery_codes = $2::jsonb,
             totp_enabled_at = NULL
         WHERE id = $3`,
        [base32, JSON.stringify(hashes), req.user.id],
      );
      res.json({
        base32,
        otpauth_url,
        qr_data_url,
        recovery_codes: plain,    // shown ONCE; re-generated via /confirm if lost
      });
    } catch (err) {
      console.error("[2FA Setup Error]", err.message);
      res.status(500).json({ error: "Couldn't start 2FA setup" });
    }
  });

  router.post("/api/auth/2fa/confirm", authLimiter, verifyToken, async (req, res) => {
    const { code } = req.body || {};
    if (typeof code !== "string" || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ error: "code must be the 6-digit TOTP from your authenticator" });
    }
    try {
      const u = await pool.query(
        "SELECT totp_secret, totp_enabled_at FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user || !user.totp_secret) {
        return res.status(400).json({ error: "Run /api/auth/2fa/setup first" });
      }
      if (user.totp_enabled_at != null) {
        return res.status(409).json({ error: "2FA already enabled" });
      }
      if (!totp.verifyToken(user.totp_secret, code)) {
        return res.status(401).json({ error: "Code didn't verify against the new secret. Check your authenticator clock and try again." });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "UPDATE users SET totp_enabled_at = now() WHERE id = $1",
          [req.user.id],
        );
        // Bump token_version so every device this user is signed
        // in on is forced through the new 2FA flow on next request.
        if (typeof bumpTokenVersion === "function") {
          await bumpTokenVersion(client, req.user.id);
        }
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      res.json({ ok: true, message: "2FA enabled. You'll be asked for a code on your next login." });
    } catch (err) {
      console.error("[2FA Confirm Error]", err.message);
      res.status(500).json({ error: "Couldn't confirm 2FA" });
    }
  });

  router.post("/api/auth/2fa/disable", authLimiter, verifyToken, async (req, res) => {
    const { password, code } = req.body || {};
    if (typeof password !== "string" || !password) {
      return res.status(400).json({ error: "Password is required to disable 2FA" });
    }
    try {
      const u = await pool.query(
        `SELECT password, totp_secret, totp_enabled_at, totp_recovery_codes
         FROM users WHERE id = $1`,
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) return res.status(404).json({ error: "User not found" });
      if (user.totp_enabled_at == null) {
        return res.status(409).json({ error: "2FA isn't enabled" });
      }
      const passwordOk = await bcrypt.compare(password, user.password);
      if (!passwordOk) {
        return res.status(401).json({ error: "Password is incorrect" });
      }
      // Require a TOTP or recovery code as proof of authenticator
      // access. Without this, anyone with a hijacked session +
      // password could disable the second factor.
      const looksLikeTotp = typeof code === "string" && /^\d{6}$/.test(code);
      let codeOk = false;
      if (looksLikeTotp) {
        codeOk = totp.verifyToken(user.totp_secret, code);
      } else {
        const { matched } = await totp.consumeRecoveryCode(
          user.totp_recovery_codes || [],
          code || "",
        );
        codeOk = matched;
      }
      if (!codeOk) {
        return res.status(401).json({
          error: "Provide a current 6-digit TOTP or a recovery code to disable 2FA",
        });
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `UPDATE users
           SET totp_secret = NULL,
               totp_enabled_at = NULL,
               totp_recovery_codes = NULL
           WHERE id = $1`,
          [req.user.id],
        );
        // Bump token_version: a session with the disabled 2FA flag
        // baked in is no different from one without, but bumping
        // is the consistent posture after every privilege change.
        if (typeof bumpTokenVersion === "function") {
          await bumpTokenVersion(client, req.user.id);
        }
        await client.query("COMMIT");
      } catch (txErr) {
        await client.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      res.json({ ok: true, message: "2FA disabled. Re-enable from your account settings any time." });
    } catch (err) {
      console.error("[2FA Disable Error]", err.message);
      res.status(500).json({ error: "Couldn't disable 2FA" });
    }
  });

  // Strip control chars + cap length on free-text user input. Used
  // on full_name + new_club_name during registration so a malicious
  // user can't smuggle CR/LF (header/email-body injection) or
  // multi-megabyte payloads through the form.
  function safeText(input, maxLen = 100) {
    if (typeof input !== "string") return null;
    // Strip all control chars (incl. CR, LF, tab, BOM) and trim.
    const cleaned = input.replace(/[ -​-‏﻿]/g, "").trim();
    if (!cleaned) return null;
    return cleaned.slice(0, maxLen);
  }

  // Self-register as a user within an existing org. Email
  // verification (Migration 021) is now mandatory: the user is
  // created with email_verified_at = NULL and login is blocked
  // until they click the link in the verification email.
  router.post("/api/auth/register", authLimiter, async (req, res) => {
    const {
      username, password, email, org_id, requested_role, note,
      club_id, new_club_name, new_club_short_code,
    } = req.body || {};

    const fullName = safeText(req.body?.full_name, 100);
    const cleanClubName = safeText(new_club_name, 80);
    if (!fullName) {
      return res.status(400).json({ error: "Full name is required" });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required for verification" });
    }

    const client = await pool.connect();
    let newUserId = null;
    let requestedRoleSaved = null;
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
      } else if (cleanClubName) {
        const cnew = await client.query(
          `INSERT INTO clubs (org_id, name, short_code)
           VALUES ($1, $2, $3)
           RETURNING id`,
          [org_id, cleanClubName, safeText(new_club_short_code, 8) || null],
        );
        resolvedClubId = cnew.rows[0].id;
      }

      const hash = await bcrypt.hash(password, 12);
      // email_verified_at left NULL on purpose: gates login until
      // the user clicks the verification link.
      const uRes = await client.query(
        "INSERT INTO users (username, password, full_name, email, org_id, club_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
        [username, hash, fullName, email, org_id, resolvedClubId],
      );
      newUserId = uRes.rows[0].id;

      await client.query(
        "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'spectator')",
        [newUserId, org_id],
      );

      const validRoles = ["meet_manager", "referee", "judge", "diver"];
      if (requested_role && validRoles.includes(requested_role)) {
        await client.query(
          "INSERT INTO role_requests (user_id, org_id, requested_role, note) VALUES ($1,$2,$3,$4)",
          [newUserId, org_id, requested_role, safeText(note, 500)],
        );
        requestedRoleSaved = requested_role;
        // Real-time push for the dashboard pulse strip — let any
        // connected org admin's dashboard tab refetch its pending
        // count immediately. Best-effort.
        if (io && typeof io.emit === "function") {
          try {
            io.emit("role_request_created", {
              org_id,
              requested_role,
            });
          } catch (_e) { /* ignore */ }
        }
      }

      await client.query("COMMIT");

      // Email verification is the gate; welcome message goes out
      // alongside it. Both are best-effort.
      const verifyToken = jwt.sign(
        { sub: newUserId, type: "email_verify" },
        JWT_SECRET,
        { expiresIn: "7d" },
      );
      if (typeof sendVerifyEmailEmail === "function") {
        sendVerifyEmailEmail(newUserId, verifyToken).catch(() => {});
      }
      sendWelcomeEmail(newUserId).catch(() => {});
      if (requestedRoleSaved) {
        sendNewRoleRequestEmail(newUserId, org_id, requestedRoleSaved,
                                 safeText(note, 500)).catch(() => {});
      }

      res.status(201).json({
        message:
          "Registration successful. Check your email for a verification link before signing in.",
      });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[Register Error]", err.message);
      res.status(500).json({ error: err.detail || "Registration failed" });
    } finally {
      client.release();
    }
  });

  // Verify email — clicked from the link sent at registration.
  // Single-use via the email_verified_at column: once stamped,
  // re-presenting the same token has no effect.
  router.post("/api/auth/verify-email", authLimiter, async (req, res) => {
    const { token } = req.body || {};
    if (!token) return res.status(400).json({ error: "Verification token required" });
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch {
      return res.status(400).json({ error: "Verification link is invalid or has expired" });
    }
    if (decoded.type !== "email_verify" || !decoded.sub) {
      return res.status(400).json({ error: "Verification link is invalid" });
    }
    try {
      const r = await pool.query(
        `UPDATE users SET email_verified_at = COALESCE(email_verified_at, now())
         WHERE id = $1 RETURNING email_verified_at`,
        [decoded.sub],
      );
      if (!r.rows.length) {
        return res.status(400).json({ error: "Verification link is invalid" });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error("[Verify Email Error]", err.message);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  // Register a new organisation + its founding org_admin
  router.post("/api/auth/register-org", authLimiter, async (req, res) => {
    const { org_name, country_code, slug, username, password, full_name, email } =
      req.body || {};

    // Apply the same input validation we run on /api/auth/register.
    // Without these checks the org-founding flow accepted blank
    // passwords, missing emails, and CR/LF-laced names — every
    // pending org seeded a row that a sysadmin clicking Approve
    // turned into a 0-character-password active account.
    const cleanOrgName  = safeText(org_name, 100);
    const cleanFullName = safeText(full_name, 100);
    const cleanSlug     = safeText(slug, 60);
    const cleanUsername = safeText(username, 60);
    if (!cleanOrgName)  return res.status(400).json({ error: "Organisation name is required" });
    if (!cleanFullName) return res.status(400).json({ error: "Full name is required" });
    if (!cleanSlug)     return res.status(400).json({ error: "Slug is required" });
    // Slug shows up in public URLs (organisations.slug). Require
    // a URL-safe shape so `/`, `..`, percent-bytes, and HTML-ish
    // payloads can't smuggle through the SPA's escaping in some
    // future deep-link.
    if (!/^[a-z0-9-]{2,60}$/.test(cleanSlug)) {
      return res.status(400).json({
        error: "slug must be 2-60 chars of lowercase letters, digits, or hyphens",
      });
    }
    if (!cleanUsername) return res.status(400).json({ error: "Username is required" });
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }
    // Email max-length: users.email is varchar(254) in init.sql;
    // exceeding that produces a noisy 500. Cap here so the 400
    // is returned with a clear error instead.
    if (typeof email !== "string"
        || email.length > 254
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: "A valid email address is required" });
    }
    if (country_code != null && !/^[A-Z]{2,3}$/.test(country_code)) {
      return res.status(400).json({ error: "country_code must be a 2-3 letter ISO code" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const orgRes = await client.query(
        "INSERT INTO organisations (name, country_code, slug, status) VALUES ($1,$2,$3,'pending') RETURNING id",
        [cleanOrgName, country_code || null, cleanSlug],
      );
      const orgId = orgRes.rows[0].id;

      const hash = await bcrypt.hash(password, 12);
      const uRes = await client.query(
        "INSERT INTO users (username, password, full_name, email, org_id) VALUES ($1,$2,$3,$4,$5) RETURNING id",
        [cleanUsername, hash, cleanFullName, email, orgId],
      );
      const userId = uRes.rows[0].id;

      await client.query(
        "INSERT INTO user_org_roles (user_id, org_id, role) VALUES ($1,$2,'org_admin')",
        [userId, orgId],
      );

      await client.query("COMMIT");

      // Mint + send the email-verification token, same flow as
      // /api/auth/register. The previous register-org omitted
      // this step, which left the founding org_admin permanently
      // unable to log in (the login gate at line 82-87 refuses
      // bcrypt-correct credentials when email_verified_at IS
      // NULL). The operational workaround was for a sysadmin to
      // UPDATE-stamp email_verified_at directly — bypassing
      // proof-of-inbox-control on the highest-privilege account
      // in a fresh tenant.
      const verifyToken = jwt.sign(
        { sub: userId, type: "email_verify" },
        JWT_SECRET,
        { expiresIn: "7d" },
      );
      if (typeof sendVerifyEmailEmail === "function") {
        sendVerifyEmailEmail(userId, verifyToken).catch(() => {});
      }

      res
        .status(201)
        .json({
          message: "Organisation registered. Check your email for a verification link before signing in.",
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
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const u = await client.query(
        "SELECT id, password, full_name, email FROM users WHERE id = $1",
        [req.user.id],
      );
      const user = u.rows[0];
      if (!user) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "User not found" });
      }
      const ok = await bcrypt.compare(current_password, user.password);
      if (!ok) {
        await client.query("ROLLBACK");
        return res.status(401).json({ error: "Current password is incorrect" });
      }
      const hash = await bcrypt.hash(new_password, 12);
      await client.query("UPDATE users SET password = $1 WHERE id = $2", [hash, user.id]);
      // Migration 021: invalidate every other session this user
      // has open on other devices. The current session's JWT is
      // already accurate at the new tv (we're issuing nothing
      // here), but other tabs/devices need to log in again.
      if (typeof bumpTokenVersion === "function") {
        await bumpTokenVersion(client, user.id);
      }
      await client.query("COMMIT");
      sendPasswordChangedEmail(user.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      console.error("[Change Password Error]", err.message);
      res.status(500).json({ error: "Password change failed" });
    } finally {
      client.release();
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
      // Bump token_version atomically with the password write so a
      // racing reset can't end with the password rotated but stale
      // JWTs still valid.
      const client2 = await pool.connect();
      try {
        await client2.query("BEGIN");
        await client2.query("UPDATE users SET password = $1 WHERE id = $2", [hash, user.id]);
        if (typeof bumpTokenVersion === "function") {
          await bumpTokenVersion(client2, user.id);
        }
        await client2.query("COMMIT");
      } catch (txErr) {
        await client2.query("ROLLBACK").catch(() => {});
        throw txErr;
      } finally {
        client2.release();
      }
      sendPasswordChangedEmail(user.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      console.error("[Reset Password Error]", err.message);
      res.status(500).json({ error: "Password reset failed" });
    }
  });

  return router;
};
