// Reusable Web Push backend.
//
//   const push = require('./lib/push')({ pool, io });
//   await push.sendNotification([userId], {
//     category: 'referee_signoff',
//     title: 'Referee sign-off requested',
//     body: 'Approve dive order for 2024 CHN Winter Meet 3m',
//     data: { request_id, event_id, event_name },
//     action_url: '/control?signoff=...',
//     actions: [
//       { action: 'approve', title: 'Approve' },
//       { action: 'deny',    title: 'Deny'    },
//     ],
//     ttl_seconds: 300,
//   });
//
// Two delivery channels in parallel:
//   1. Web Push to every active subscription on the target user
//      (every browser/device they've registered).
//   2. Socket emit to the per-user room (`user:<id>`) so any
//      already-open SPA tab gets an in-app banner regardless of
//      push permission state.
//
// Both fall through to the `notifications` table — a single audit
// trail per dispatched notification, regardless of channel.
//
// VAPID keys come from env (VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY /
// VAPID_SUBJECT). When VAPID_PUBLIC_KEY is unset the push side
// silently no-ops; the socket side still fires so the SPA inbox
// stays functional. This keeps dev environments runnable without
// Web Push setup.

const webpush = require("web-push");

module.exports = function createPushEngine({ pool, io }) {
  if (!pool) throw new Error("createPushEngine requires { pool, io }");

  const VAPID_PUBLIC_KEY  = process.env.VAPID_PUBLIC_KEY  || "";
  const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
  const VAPID_SUBJECT     = process.env.VAPID_SUBJECT     || "mailto:ops@example.com";

  const pushEnabled = !!(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
  if (pushEnabled) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  } else {
    console.warn("[push] VAPID keys not configured — push notifications disabled. " +
                 "Run `node scripts/generate-vapid-keys.js` and add the output to .env.");
  }

  // ---------- Subscription management -----------------------------

  // Upsert a browser subscription. The same browser re-subscribing
  // (e.g. after permission was revoked + regranted) will hit the
  // endpoint UNIQUE and update the existing row rather than create
  // a duplicate.
  async function addSubscription(userId, sub, userAgent) {
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) {
      const err = new Error("subscription missing endpoint / keys");
      err.status = 400;
      throw err;
    }
    const r = await pool.query(
      `INSERT INTO push_subscriptions
         (user_id, endpoint, p256dh_key, auth_key, user_agent)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE
         SET user_id    = EXCLUDED.user_id,
             p256dh_key = EXCLUDED.p256dh_key,
             auth_key   = EXCLUDED.auth_key,
             user_agent = EXCLUDED.user_agent,
             revoked_at = NULL,
             last_used_at = now()
       RETURNING id`,
      [userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, userAgent || null],
    );
    return r.rows[0];
  }

  // Soft-delete: keeps audit pointers stable for any prior
  // notifications that referenced this subscription.
  async function removeSubscription(userId, endpoint) {
    await pool.query(
      `UPDATE push_subscriptions
       SET revoked_at = now()
       WHERE user_id = $1 AND endpoint = $2 AND revoked_at IS NULL`,
      [userId, endpoint],
    );
  }

  // ---------- Dispatch --------------------------------------------

  // Fan-out to push + socket, recording one notification row per
  // user. Returns { notification_ids, dispatched: { push, socket },
  // failed }. Never throws on a single sub failure — failures land
  // on the row's failure_reason and the rest continue.
  async function sendNotification(userIds, payload) {
    if (!Array.isArray(userIds) || !userIds.length) {
      return { notification_ids: [], dispatched: { push: 0, socket: 0 }, failed: 0 };
    }
    const {
      category,
      title,
      body = null,
      data = {},
      action_url = null,
      actions = null,
      ttl_seconds = null,
    } = payload || {};
    if (!category || !title) {
      throw new Error("sendNotification requires { category, title }");
    }
    const expiresAt = ttl_seconds
      ? new Date(Date.now() + ttl_seconds * 1000)
      : null;

    // Embed actions in the data jsonb so the service worker can
    // hand them to showNotification(). Keeps the schema generic —
    // different categories carry different action sets without
    // schema gymnastics.
    const fullData = { ...data };
    if (actions) fullData.actions = actions;

    const notificationIds = [];
    let pushDispatched = 0;
    let socketDispatched = 0;
    let failed = 0;

    for (const uid of userIds) {
      // Insert pending row first so even a complete delivery
      // failure leaves an audit trail + drives later retry logic.
      const ins = await pool.query(
        `INSERT INTO notifications
           (user_id, category, title, body, data, action_url, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         RETURNING id`,
        [uid, category, title, body, JSON.stringify(fullData), action_url, expiresAt],
      );
      const notificationId = ins.rows[0].id;
      notificationIds.push(notificationId);

      // ---- Channel 1: in-app socket emit -------------------------
      // Open SPA tabs catch this regardless of push permission, so
      // it's the most reliable channel for an active session.
      try {
        if (io) {
          io.to(`user:${uid}`).emit("notification", {
            id: notificationId,
            category, title, body,
            data: fullData,
            action_url,
            expires_at: expiresAt ? expiresAt.toISOString() : null,
            created_at: new Date().toISOString(),
          });
          socketDispatched++;
        }
      } catch (err) {
        console.error("[push] socket emit failed", err.message);
      }

      // ---- Channel 2: Web Push -----------------------------------
      if (!pushEnabled) {
        // No VAPID configured — mark sent (socket counts as
        // delivered for an active session) and continue.
        await pool.query(
          `UPDATE notifications SET status = 'sent', sent_at = now()
           WHERE id = $1`,
          [notificationId],
        );
        continue;
      }

      const subs = await pool.query(
        `SELECT id, endpoint, p256dh_key, auth_key
         FROM push_subscriptions
         WHERE user_id = $1 AND revoked_at IS NULL`,
        [uid],
      );

      if (!subs.rows.length) {
        // No registered devices — socket-only delivery. Mark sent
        // so the row is auditable; the SPA inbox will surface it
        // next time the user signs in.
        await pool.query(
          `UPDATE notifications SET status = 'sent', sent_at = now()
           WHERE id = $1`,
          [notificationId],
        );
        continue;
      }

      // Body the SW will receive. Keep it small — Web Push has a
      // 4 KB payload limit on most push services.
      const wpPayload = JSON.stringify({
        id: notificationId,
        category, title, body,
        data: fullData,
        action_url,
      });

      const opts = {};
      if (ttl_seconds != null) opts.TTL = ttl_seconds;

      let anySent = false;
      for (const s of subs.rows) {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh_key, auth: s.auth_key } },
            wpPayload,
            opts,
          );
          anySent = true;
          pushDispatched++;
          // Track activity so a future "unused for 90 days" sweep
          // can clean up dead subscriptions.
          pool.query(
            `UPDATE push_subscriptions SET last_used_at = now() WHERE id = $1`,
            [s.id],
          ).catch(() => {});
        } catch (err) {
          // 404 / 410 from a push service means the subscription
          // is permanently gone (uninstalled extension, revoked
          // permission). Soft-delete so we don't keep retrying.
          if (err.statusCode === 404 || err.statusCode === 410) {
            pool.query(
              `UPDATE push_subscriptions SET revoked_at = now() WHERE id = $1`,
              [s.id],
            ).catch(() => {});
          }
          console.error("[push] sendNotification fail",
                        s.endpoint.slice(0, 60), err.statusCode || err.message);
        }
      }

      if (anySent) {
        await pool.query(
          `UPDATE notifications SET status = 'sent', sent_at = now()
           WHERE id = $1`,
          [notificationId],
        );
      } else {
        failed++;
        await pool.query(
          `UPDATE notifications
           SET status = 'failed', failure_reason = 'all subscriptions failed'
           WHERE id = $1`,
          [notificationId],
        );
      }
    }

    return {
      notification_ids: notificationIds,
      dispatched: { push: pushDispatched, socket: socketDispatched },
      failed,
    };
  }

  // ---------- Acknowledgement -------------------------------------

  // Marks a notification as seen/actioned. Idempotent — repeating
  // the call after the row's already acknowledged is a no-op.
  // Returns true when the row was found and owned by the caller.
  async function acknowledgeNotification(notificationId, userId) {
    const r = await pool.query(
      `UPDATE notifications
       SET status = 'acknowledged', acknowledged_at = COALESCE(acknowledged_at, now())
       WHERE id = $1 AND user_id = $2
       RETURNING id`,
      [notificationId, userId],
    );
    return r.rowCount > 0;
  }

  // Sweep pending/sent rows past their expiry to 'expired'. Called
  // periodically; cheap thanks to the partial index on
  // (status, expires_at). Returns rowCount.
  async function expireOld() {
    const r = await pool.query(
      `UPDATE notifications
       SET status = 'expired'
       WHERE status IN ('pending','sent')
         AND expires_at IS NOT NULL
         AND expires_at < now()`,
    );
    return r.rowCount;
  }

  // ---------- SPA inbox -------------------------------------------

  // Pull recent notifications for the signed-in user. Used by the
  // SPA's "what did I miss" inbox banner on login. Excludes expired
  // rows — there's no point showing a sign-off request from yesterday.
  async function listForUser(userId, { limit = 20, sinceId = null } = {}) {
    const params = [userId, limit];
    let where = `user_id = $1 AND status <> 'expired'`;
    if (sinceId) {
      params.push(sinceId);
      where += ` AND id > $${params.length}`;
    }
    const r = await pool.query(
      `SELECT id, category, title, body, data, action_url,
              status, created_at, sent_at, acknowledged_at, expires_at
       FROM notifications
       WHERE ${where}
       ORDER BY created_at DESC
       LIMIT $2`,
      params,
    );
    return r.rows;
  }

  // Convenience: broadcast a non-notification event to the
  // existing `event:<id>` room so feature handlers don't have to
  // import the io instance separately. Used by the referee
  // sign-off respond handler to flip the manager's modal out of
  // "waiting" without spawning another notifications row.
  function emitEvent(eventId, name, payload) {
    if (!io || !eventId || !name) return;
    io.to(`event:${eventId}`).emit(name, payload);
  }
  // Direct emit to a single user across every open SPA tab they
  // have. Same `user:<id>` room the connection handler joins.
  function emitToUser(userId, name, payload) {
    if (!io || !userId || !name) return;
    io.to(`user:${userId}`).emit(name, payload);
  }

  return {
    pushEnabled,
    vapidPublicKey: () => VAPID_PUBLIC_KEY,
    addSubscription,
    removeSubscription,
    sendNotification,
    acknowledgeNotification,
    expireOld,
    listForUser,
    emitEvent,
    emitToUser,
    // Expose io for any feature that needs more direct access
    // (the referee sign-off respond handler peeks at this).
    io,
  };
};
