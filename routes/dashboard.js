// Dashboard bundle endpoint.
//
// The dashboard view used to fan out 5–6 parallel API calls on
// mount: /api/events, /api/role-requests, /api/orgs (sysadmin),
// /api/audit/recent, /api/judge/my-events, /api/coach/dashboard.
// Each is its own auth check + route handler + Postgres query.
// Single user that's fine; 50 operators all hitting Refresh
// during a meet day = 50 × 6 = 300 round trips, plus the
// upstream connection pool churn.
//
// This single endpoint composes the same data on the server
// side via Promise.all and returns one response. Same auth, one
// round trip per dashboard mount.
//
//   GET /api/dashboard
//
//     {
//       events:           [...],   // filtered to roles the user can see
//       role_requests:    [...],   // org_admin only
//       pending_orgs:     [...],   // sysadmin only
//       recent_activity:  [...],   // org_admin only
//       judge_events:     [...],   // judge role only
//       coach:            { ... }, // coach role only — minimal slice
//     }
//
// Each slice is fetched only when the caller's roles authorise
// it, so a diver-only account gets a tiny payload.
//
// Rate limit / auth: verifyToken at the route level. Queries
// scope by req.user.org_id (or open for sysadmin where the
// upstream endpoint already does so).

const express = require("express");

module.exports = function createDashboardRouter({ pool, verifyToken }) {
  if (!pool || !verifyToken) {
    throw new Error("createDashboardRouter requires { pool, verifyToken }");
  }
  const router = express.Router();

  router.get("/api/dashboard", verifyToken, async (req, res) => {
    const user = req.user;
    const roles = user.org_roles || [];
    const isSysAdmin = !!user.is_system_admin;
    const has = (r) => roles.includes(r) || isSysAdmin;

    const tasks = {};

    // ---- Events (operators + divers + meet managers) ----
    if (has("org_admin") || has("meet_manager") || has("diver")) {
      // Mirrors what /api/events returns. Org admin / meet
      // manager / diver see their org's events PLUS any event
      // their org has been invited to via event_participating_orgs
      // (commit 48fa8d5). Without the EXISTS clause, the
      // dashboard pulse strip's 🌐 INVITED chip silently never
      // fires for visiting federations because their bundle
      // ships zero foreign events.
      tasks.events = pool.query(
        `SELECT e.id, e.name, e.status, e.event_type::text AS event_type,
                e.gender, e.height, e.age_group,
                e.total_rounds, e.number_of_judges,
                e.scheduled_at, e.entries_close_at,
                e.org_id, e.meet_id, e.parent_event_id,
                e.event_format::text AS event_format,
                o.name AS org_name, o.country_code,
                m.name AS meet_name
         FROM events e
         LEFT JOIN organisations o ON o.id = e.org_id
         LEFT JOIN meets m ON m.id = e.meet_id
         WHERE $1::boolean
            OR e.org_id = $2
            OR EXISTS (
                 SELECT 1 FROM event_participating_orgs epo
                  WHERE epo.event_id = e.id AND epo.org_id = $2
               )
         ORDER BY e.created_at DESC
         LIMIT 100`,
        [isSysAdmin, user.org_id],
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Role requests (org_admin / sysadmin) ----
    if (has("org_admin")) {
      tasks.role_requests = pool.query(
        `SELECT rr.id, rr.requested_role, rr.status, rr.note, rr.created_at,
                rr.org_id, o.name AS org_name, o.country_code,
                u.id AS user_id, u.username, u.full_name
         FROM role_requests rr
         JOIN users u           ON rr.user_id = u.id
         JOIN organisations o   ON rr.org_id = o.id
         WHERE rr.status = 'pending' AND ($2::boolean OR rr.org_id = $1)
         ORDER BY o.name ASC, rr.created_at ASC`,
        [user.org_id, isSysAdmin],
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Pending org registrations (sysadmin only) ----
    if (isSysAdmin) {
      tasks.pending_orgs = pool.query(
        `SELECT id, name, country_code, status, created_at
         FROM organisations
         WHERE status = 'pending'
         ORDER BY created_at DESC`,
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Recent activity feed (org_admin only) ----
    // Mirrors /api/audit/recent but inlined here so we
    // don't pay the extra HTTP round trip. 7-day window,
    // top 10 across score + role + activity logs.
    if (has("org_admin")) {
      const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
      const orgScope = isSysAdmin ? null : user.org_id;
      tasks.recent_activity = (async () => {
        const scoreSql = `
          SELECT a.id, a.created_at, a.action::text AS action,
                 a.competitor_id, comp.full_name AS competitor_name,
                 a.judge_id, jud.full_name AS judge_name,
                 a.actor_user_id, act.full_name AS actor_name,
                 a.event_id, e.name AS event_name,
                 a.round_number, a.old_score, a.new_score, a.reason,
                 e.org_id, o.name AS org_name
          FROM score_audit_log a
          JOIN events e        ON e.id = a.event_id
          LEFT JOIN organisations o ON o.id = e.org_id
          LEFT JOIN users comp ON comp.id = a.competitor_id
          LEFT JOIN users jud  ON jud.id  = a.judge_id
          LEFT JOIN users act  ON act.id  = a.actor_user_id
          WHERE a.created_at >= $1
            AND ($2::uuid IS NULL OR e.org_id = $2::uuid)
          ORDER BY a.created_at DESC
          LIMIT 10`;
        const roleSql = `
          SELECT a.id, a.created_at, a.action::text AS action,
                 a.user_id, target.full_name AS target_name,
                 a.actor_id, actor.full_name AS actor_name,
                 a.role::text AS role, a.note,
                 a.org_id, o.name AS org_name
          FROM role_audit_log a
          JOIN organisations o ON o.id = a.org_id
          LEFT JOIN users target ON target.id = a.user_id
          LEFT JOIN users actor  ON actor.id  = a.actor_id
          WHERE a.created_at >= $1
            AND ($2::uuid IS NULL OR a.org_id = $2::uuid)
          ORDER BY a.created_at DESC
          LIMIT 10`;
        const activitySql = `
          SELECT a.id, a.created_at, a.action,
                 a.entity_type, a.entity_id, a.entity_name,
                 a.metadata, a.note,
                 a.actor_id, actor.full_name AS actor_name,
                 a.org_id, o.name AS org_name
          FROM audit_log a
          LEFT JOIN organisations o ON o.id = a.org_id
          LEFT JOIN users actor     ON actor.id = a.actor_id
          WHERE a.created_at >= $1
            AND ($2::uuid IS NULL OR a.org_id = $2::uuid)
          ORDER BY a.created_at DESC
          LIMIT 10`;
        try {
          const [s, ro, ac] = await Promise.all([
            pool.query(scoreSql,    [since, orgScope]),
            pool.query(roleSql,     [since, orgScope]),
            pool.query(activitySql, [since, orgScope]),
          ]);
          return [
            ...s.rows .map((r) => ({ kind: "score",    ...r })),
            ...ro.rows.map((r) => ({ kind: "role",     ...r })),
            ...ac.rows.map((r) => ({ kind: "activity", ...r })),
          ].sort(
            (a, b) => new Date(b.created_at) - new Date(a.created_at),
          ).slice(0, 10);
        } catch {
          return [];
        }
      })();
    }

    // ---- Judge events (judge role only) ----
    if (has("judge")) {
      tasks.judge_events = pool.query(
        `SELECT e.id, e.name, e.status, e.event_type::text AS event_type,
                e.height, e.total_rounds, e.number_of_judges,
                e.scheduled_at,
                ej.judge_number
         FROM event_judges ej
         JOIN events e ON e.id = ej.event_id
         WHERE ej.judge_id = $1
           AND e.status IN ('Upcoming', 'Live')
         ORDER BY e.scheduled_at NULLS LAST, e.created_at DESC
         LIMIT 25`,
        [user.id],
      ).then((r) => r.rows).catch(() => []);
    }

    // ---- Coach slice (coach role only) ----
    // Minimal — divers list with names + clubs. Full coach
    // dashboard data still goes via /api/coach/dashboard
    // when the user actually opens the Coach tab; this is
    // just enough for the pulse chip + tab badge.
    if (has("coach")) {
      tasks.coach = pool.query(
        `SELECT u.id, u.full_name, u.username,
                cl.name AS club_name, cl.short_code AS club_code
         FROM coach_diver_links link
         JOIN users u       ON u.id = link.diver_id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE link.coach_id = $1
         ORDER BY u.full_name ASC
         LIMIT 50`,
        [user.id],
      ).then((r) => ({ divers: r.rows })).catch(() => ({ divers: [] }));
    }

    try {
      // Resolve every authorised slice in parallel.
      const keys = Object.keys(tasks);
      const values = await Promise.all(keys.map((k) => tasks[k]));
      const out = {};
      keys.forEach((k, i) => { out[k] = values[i]; });
      res.json(out);
    } catch (err) {
      console.error("[dashboard bundle] error:", err.message);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  });

  return router;
};
