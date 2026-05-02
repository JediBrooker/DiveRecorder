// Auth + RBAC + payload validation perimeter.
//
// Every gate the API uses to reject a request lives here, in one
// file, so an agent reviewing security can read the whole surface
// in one pass. AGENTS.md links to this file as the security
// perimeter; if you add a new gate, add it here, not inline in a
// route handler.
//
// Factory pattern (passed `pool` + `JWT_SECRET`) so the test
// runner can swap them when needed without monkey-patching.
//
// Exports:
//   verifyToken            — decode JWT into req.user
//   requireOrgRole(roles)  — at least one of the listed roles
//   requireSystemAdmin     — sysadmin only
//   requireEventManager    — manager-or-admin OR event_managers row,
//                            scoped to the event's own org
//   ensureEventOrgGate     — confirm the URL event is in the caller's org
//   isInSameOrg            — confirm a user/team belongs to the event's org
//   socketRequireRole      — analogue of requireOrgRole for Socket.IO
//   isValidScore           — 0–10, half-point increments
//   parseDateRange         — parse from_date/to_date query params
//
// Invariants — see AGENTS.md before changing:
//   * req.user.id is the canonical UUID; never user_id / userId.
//   * Every org-scoped query uses the sysadmin-bypass pattern
//       WHERE … AND ($N::boolean OR org_id = $M)
//     with params […, !!req.user.is_system_admin, req.user.org_id].
//   * requireEventManager fetches the event row and stashes it on
//     req.event so handlers can reuse it without a second query.

const jwt = require("jsonwebtoken");

module.exports = function createMiddleware({ pool, JWT_SECRET }) {
  if (!pool || !JWT_SECRET) {
    throw new Error("createMiddleware requires { pool, JWT_SECRET }");
  }

  // Decode JWT and attach req.user. Does not enforce roles.
  function verifyToken(req, res, next) {
    const authHeader = req.headers["authorization"];
    const token = authHeader && authHeader.split(" ")[1];
    if (!token) return res.status(403).json({ error: "No token provided" });
    jwt.verify(token, JWT_SECRET, (err, decoded) => {
      if (err) return res.status(401).json({ error: "Invalid or expired token" });
      req.user = decoded;
      next();
    });
  }

  // Ensures the user holds at least one of the given org-level roles.
  // system_admin always passes.
  const requireOrgRole = (roles = []) => (req, res, next) => {
    verifyToken(req, res, () => {
      if (req.user.is_system_admin) return next();
      const userRoles = req.user.org_roles || [];
      const ok = roles.length === 0 || roles.some((r) => userRoles.includes(r));
      if (!ok) return res.status(403).json({ error: "Insufficient role" });
      next();
    });
  };

  function requireSystemAdmin(req, res, next) {
    verifyToken(req, res, () => {
      if (!req.user.is_system_admin)
        return res.status(403).json({ error: "System admin access required" });
      next();
    });
  }

  // Ensures the user can manage the event in the URL.
  //
  // system_admin always passes. Otherwise we fetch the event's
  // org_id and require either:
  //   * org_admin role in *that same org*, or
  //   * event_managers membership for the specific event.
  //
  // Stashes the event row on req.event so handlers can reuse it.
  const requireEventManager = () => async (req, res, next) => {
    verifyToken(req, res, async () => {
      try {
        const eventId = req.params.id || req.body.eventId;
        if (!eventId) return res.status(400).json({ error: "Event ID required" });

        const ev = await pool.query(
          "SELECT id, org_id FROM events WHERE id = $1",
          [eventId],
        );
        if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
        req.event = ev.rows[0];

        if (req.user.is_system_admin) return next();

        const sameOrg = req.event.org_id === req.user.org_id;
        const orgRoles = req.user.org_roles || [];
        if (sameOrg && orgRoles.includes("org_admin")) return next();

        const result = await pool.query(
          "SELECT 1 FROM event_managers WHERE event_id = $1 AND user_id = $2",
          [eventId, req.user.id],
        );
        if (result.rows.length === 0)
          return res.status(403).json({ error: "You are not a manager of this event" });
        next();
      } catch (err) {
        console.error("[requireEventManager]", err.message);
        res.status(500).json({ error: "Server error during authorisation" });
      }
    });
  };

  // Express helper: confirms the event in :id (or the named param)
  // is in the calling user's org. system_admin bypasses. Returns
  // false on missing/wrong-org and writes the response. On success
  // stashes req.event for the handler.
  async function ensureEventOrgGate(req, res, paramName = "id") {
    const id = req.params[paramName];
    if (!id) { res.status(400).json({ error: "Event id required" }); return false; }
    const r = await pool.query("SELECT id, org_id FROM events WHERE id = $1", [id]);
    if (!r.rows.length) { res.status(404).json({ error: "Event not found" }); return false; }
    req.event = r.rows[0];
    if (req.user.is_system_admin) return true;
    if (r.rows[0].org_id !== req.user.org_id) {
      res.status(403).json({ error: "Event is not in your organisation" });
      return false;
    }
    return true;
  }

  // Confirms a target user/team belongs to the same org as the
  // event the request targets. Returns true/false. Accepts either
  // a pool or a transaction client (so it composes inside an open
  // transaction).
  async function isInSameOrg(db, eventOrgId, id, kind = "users") {
    if (!id || !eventOrgId) return false;
    const table = kind === "teams" ? "teams" : "users";
    const r = await db.query(`SELECT org_id FROM ${table} WHERE id = $1`, [id]);
    return r.rows[0]?.org_id === eventOrgId;
  }

  // Authorisation gate for privileged socket events. Returns true
  // when the connection has a verified user and (optionally) one
  // of the listed org_roles, or is a system admin. Emits
  // "unauthorized" and returns false otherwise.
  function socketRequireRole(socket, roles = null) {
    if (!socket.userId) {
      socket.emit("unauthorized", { reason: "not_authenticated" });
      return false;
    }
    if (!roles || socket.userIsSystemAdmin) return true;
    const userRoles = socket.userOrgRoles || [];
    if (!roles.some((r) => userRoles.includes(r))) {
      socket.emit("unauthorized", { reason: "insufficient_role" });
      return false;
    }
    return true;
  }

  // Validate a score from the wire (HTTP or socket). 0–10 in
  // 0.5-point increments. Used by the socket submit_score handler
  // and the HTTP /api/scores/:id correction route.
  function isValidScore(s) {
    const n = Number(s);
    if (!Number.isFinite(n)) return false;
    if (n < 0 || n > 10) return false;
    return Math.round(n * 2) === n * 2;       // half-points only
  }

  // Confirms the event is still in the pre-meet 'Upcoming' phase.
  // Used to gate operations that should only be possible before
  // the first dive (start-order randomise, drag-reorder, etc.).
  // Once status flips to 'Live' or 'Completed' these endpoints
  // return 409 Conflict with a clear message; the frontend mirrors
  // the rule by hiding/disabling the controls but the server is
  // the source of truth.
  //
  // Pass `client` (a transaction client) when you're already inside
  // a BEGIN; otherwise pass `pool`. Returns true if pre-meet (and
  // stashes the row on req.event); writes 409 + returns false
  // otherwise.
  async function ensureEventPreMeet(req, res, eventId, db = pool) {
    const r = await db.query(
      "SELECT id, status, name FROM events WHERE id = $1",
      [eventId],
    );
    if (!r.rows.length) {
      res.status(404).json({ error: "Event not found" });
      return false;
    }
    req.event = r.rows[0];
    if (r.rows[0].status !== "Upcoming") {
      res.status(409).json({
        error:
          `Cannot change the dive order once "${r.rows[0].name}" has started ` +
          `(status is ${r.rows[0].status}). Withdraw a diver instead if they ` +
          `need to be skipped.`,
        event_status: r.rows[0].status,
      });
      return false;
    }
    return true;
  }

  // Parse + normalise the optional ?from_date / ?to_date query
  // params used by /profile and /analytics. Returns { from, to }
  // where each is YYYY-MM-DD or null. Throws a 400-shaped Error
  // on invalid input.
  function parseDateRange(query) {
    const norm = (raw) => {
      if (!raw) return null;
      const s = String(raw).trim();
      if (!s) return null;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const e = new Error("from_date / to_date must be YYYY-MM-DD");
        e.status = 400; throw e;
      }
      const t = Date.parse(s + "T00:00:00Z");
      if (Number.isNaN(t)) {
        const e = new Error("from_date / to_date is not a real date");
        e.status = 400; throw e;
      }
      return s;
    };
    return { from: norm(query.from_date), to: norm(query.to_date) };
  }

  return {
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
  };
};
