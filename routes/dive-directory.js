// Dive directory — the World Aquatics dive catalog (~830 rows)
// loaded by init.sql, plus org-specific custom rows added through
// the SPA's Dive Directory page.
//
//   GET    /api/dive-directory          full catalog (core + custom)
//   POST   /api/dive-directory          add a custom row
//   PUT    /api/dive-directory/:id      update a custom row
//   DELETE /api/dive-directory/:id      delete a custom row
//
// Core rows (is_custom = false) are immutable through the API.
// Custom rows can only be edited/deleted by a user in the same
// org that originally created them. Both gates fall through to
// 403 / 404 so the API doesn't double as an enumeration tool.
//
// Mounted via:
//   app.use(require('./routes/dive-directory')({ pool, verifyToken }))

const express = require("express");

// Whitelist of dive_position enum values — has to match the
// dive_position enum in init.sql. A typo here would silently let
// the DB reject the insert with a less helpful error message.
const DIVE_POSITIONS = new Set(["A", "B", "C", "D"]);
// board_height enum (matches init.sql's board_height ENUM). Used
// to validate the height string before the cast — the height
// column on dive_directory itself is numeric(3,1), but events use
// the enum, so we keep the strings aligned.
const HEIGHT_LABELS = new Set(["0m", "1m", "3m", "5m", "7.5m", "10m"]);

// Convert a height string like "7.5m" / "10m" / "0m" to its
// numeric value (the dive_directory.height column is numeric).
function heightToNumber(s) {
  if (typeof s !== "string") return NaN;
  return parseFloat(s.replace(/m$/i, ""));
}

// Range guard for DD. World Aquatics tariffs sit between 1.0
// and ~4.8; coaches inventing poolside drills can use lower
// numbers (0.5 for a sit-dive isn't unreasonable). 0.1 floor is
// the minimum granularity calc_event_dive_points expects.
function isValidDD(dd) {
  const n = Number(dd);
  return Number.isFinite(n) && n >= 0.1 && n <= 9.9;
}

// dive_code is "<group><somersaults><twists?><flying?>" — 2–6
// alphanumeric chars. Strict regex so a "FORWARD" or empty string
// can't bypass and end up as a label that the autocomplete won't
// match.
function isValidDiveCode(code) {
  return typeof code === "string" && /^[0-9A-Za-z]{2,6}$/.test(code);
}

module.exports = function createDiveDirectoryRouter({ pool, verifyToken }) {
  if (!pool) throw new Error("createDiveDirectoryRouter requires { pool, verifyToken }");
  const router = express.Router();

  // -----------------------------------------------------------
  // GET /api/dive-directory — full catalog. is_custom + created_by
  // + created_org_id surface so the SPA can show edit/delete
  // controls for the rows the current org owns.
  // -----------------------------------------------------------
  router.get("/api/dive-directory", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, dive_code, height, position, dd, description,
                is_custom, created_by, created_org_id, created_at
         FROM dive_directory
         ORDER BY is_custom ASC, dive_code ASC, height ASC`,
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Dive Directory Error]", err.message);
      res.status(500).json([]);
    }
  });

  // -----------------------------------------------------------
  // POST /api/dive-directory — add a custom row. Body:
  //   { dive_code, height, position, dd, description? }
  // height accepts the enum string ("3m") and converts to numeric
  // for the dive_directory.height column.
  // -----------------------------------------------------------
  router.post("/api/dive-directory", verifyToken, async (req, res) => {
    if (!req.user?.org_id && !req.user?.is_system_admin) {
      return res.status(403).json({ error: "An org membership is required to add custom dives" });
    }
    const { dive_code, height, position, dd, description } = req.body || {};
    if (!isValidDiveCode(dive_code)) {
      return res.status(400).json({ error: "dive_code must be 2–6 alphanumeric characters" });
    }
    if (!HEIGHT_LABELS.has(String(height))) {
      return res.status(400).json({ error: "height must be one of 0m / 1m / 3m / 5m / 7.5m / 10m" });
    }
    if (!DIVE_POSITIONS.has(String(position))) {
      return res.status(400).json({ error: "position must be A / B / C / D" });
    }
    if (!isValidDD(dd)) {
      return res.status(400).json({ error: "dd must be a number between 0.1 and 9.9" });
    }
    const desc = typeof description === "string"
      ? description.trim().slice(0, 280)
      : null;
    try {
      const r = await pool.query(
        `INSERT INTO dive_directory
           (dive_code, height, position, dd, description,
            is_custom, created_by, created_org_id)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7)
         RETURNING id, dive_code, height, position, dd, description,
                   is_custom, created_by, created_org_id, created_at`,
        [
          dive_code,
          heightToNumber(height),
          position,
          Number(dd),
          desc,
          req.user.id || null,
          req.user.org_id || null,
        ],
      );
      res.status(201).json(r.rows[0]);
    } catch (err) {
      // 23505 = unique_violation on (dive_code, height, position).
      // Surface a friendly message rather than the raw DB error.
      if (err.code === "23505") {
        return res.status(409).json({
          error: `A dive with code ${dive_code} at ${height} in position ${position} already exists`,
        });
      }
      console.error("[Dive Directory Insert Error]", err.message);
      res.status(500).json({ error: "Failed to add custom dive" });
    }
  });

  // -----------------------------------------------------------
  // PUT /api/dive-directory/:id — update an existing custom row.
  // Core rows (is_custom = false) refuse — they're the protected
  // World Aquatics catalog. Cross-org edits also refuse so an org
  // can't tamper with another's drill list.
  // -----------------------------------------------------------
  router.put("/api/dive-directory/:id", verifyToken, async (req, res) => {
    const id = req.params.id;
    const { dive_code, height, position, dd, description } = req.body || {};
    if (dive_code != null && !isValidDiveCode(dive_code)) {
      return res.status(400).json({ error: "dive_code must be 2–6 alphanumeric characters" });
    }
    if (height != null && !HEIGHT_LABELS.has(String(height))) {
      return res.status(400).json({ error: "height must be one of 0m / 1m / 3m / 5m / 7.5m / 10m" });
    }
    if (position != null && !DIVE_POSITIONS.has(String(position))) {
      return res.status(400).json({ error: "position must be A / B / C / D" });
    }
    if (dd != null && !isValidDD(dd)) {
      return res.status(400).json({ error: "dd must be a number between 0.1 and 9.9" });
    }
    try {
      // Single round-trip: gate AND update, returning rows iff
      // both the row exists and the gate passes. NULL row → 404
      // path; gate fail → 403 path.
      const owner = await pool.query(
        `SELECT is_custom, created_org_id FROM dive_directory WHERE id = $1`,
        [id],
      );
      if (!owner.rows.length) return res.status(404).json({ error: "Dive not found" });
      if (!owner.rows[0].is_custom) {
        return res.status(403).json({ error: "Core dives cannot be edited" });
      }
      if (
        !req.user.is_system_admin
        && owner.rows[0].created_org_id !== req.user.org_id
      ) {
        return res.status(403).json({ error: "Custom dive belongs to another org" });
      }
      const desc = typeof description === "string"
        ? description.trim().slice(0, 280)
        : description;
      const r = await pool.query(
        `UPDATE dive_directory SET
           dive_code   = COALESCE($1, dive_code),
           height      = COALESCE($2, height),
           position    = COALESCE($3, position),
           dd          = COALESCE($4, dd),
           description = COALESCE($5, description)
         WHERE id = $6
         RETURNING id, dive_code, height, position, dd, description,
                   is_custom, created_by, created_org_id, created_at`,
        [
          dive_code ?? null,
          height != null ? heightToNumber(height) : null,
          position ?? null,
          dd != null ? Number(dd) : null,
          desc ?? null,
          id,
        ],
      );
      res.json(r.rows[0]);
    } catch (err) {
      if (err.code === "23505") {
        return res.status(409).json({
          error: "A dive with that code + height + position already exists",
        });
      }
      console.error("[Dive Directory Update Error]", err.message);
      res.status(500).json({ error: "Failed to update custom dive" });
    }
  });

  // -----------------------------------------------------------
  // DELETE /api/dive-directory/:id — remove a custom row. Core
  // rows refuse. Cross-org refuses. Rows referenced by an
  // existing competitor_dive_lists row will fail the FK from
  // that side — surface a friendly 409 so the operator knows
  // why.
  // -----------------------------------------------------------
  router.delete("/api/dive-directory/:id", verifyToken, async (req, res) => {
    const id = req.params.id;
    try {
      const owner = await pool.query(
        `SELECT is_custom, created_org_id FROM dive_directory WHERE id = $1`,
        [id],
      );
      if (!owner.rows.length) return res.status(404).json({ error: "Dive not found" });
      if (!owner.rows[0].is_custom) {
        return res.status(403).json({ error: "Core dives cannot be deleted" });
      }
      if (
        !req.user.is_system_admin
        && owner.rows[0].created_org_id !== req.user.org_id
      ) {
        return res.status(403).json({ error: "Custom dive belongs to another org" });
      }
      await pool.query("DELETE FROM dive_directory WHERE id = $1", [id]);
      res.status(204).end();
    } catch (err) {
      // 23503 = foreign_key_violation. The row is in use by a
      // competitor_dive_lists row somewhere; deleting it would
      // orphan that diver's filed dive list. Tell the operator to
      // remove the dive from those lists first.
      if (err.code === "23503") {
        return res.status(409).json({
          error: "This custom dive is in use on a diver's list — remove it from there first",
        });
      }
      console.error("[Dive Directory Delete Error]", err.message);
      res.status(500).json({ error: "Failed to delete custom dive" });
    }
  });

  return router;
};
