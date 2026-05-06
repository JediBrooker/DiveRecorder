// Competitor self-service routes — diver submits their own
// dive list before a meet. Synchro events also resolve the
// partner here.
//
//   POST /api/competitor/submit-list
//
// Gated by:
//   * requireOrgRole(["diver"])     — only divers can self-submit
//   * loadEventForEntries           — event must still be Upcoming
//                                     and entries_close_at not yet
//                                     reached. Late additions are
//                                     a manager-only flow via the
//                                     Control Room late-entry add.
//   * bulkWriteLimiter              — caps abuse on the bulk write
//
// Mounted via:
//   app.use(require('./routes/competitor')({ … }))

const express = require("express");

module.exports = function createCompetitorRouter({
  pool,
  requireOrgRole,
  bulkWriteLimiter,
  loadEventForEntries,
}) {
  if (!pool) throw new Error("createCompetitorRouter requires { pool, … }");
  const router = express.Router();

  router.post(
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

  return router;
};
