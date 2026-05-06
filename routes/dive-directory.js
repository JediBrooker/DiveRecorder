// Dive directory — the World Aquatics dive catalog (~830 rows)
// loaded by init.sql. Read-only at runtime; auth-required so the
// payload doesn't get scraped from anonymous traffic. Used by
// the Competitor and Team dive-list editors as their
// autocomplete source.
//
//   GET /api/dive-directory
//
// Mounted via:
//   app.use(require('./routes/dive-directory')({ pool, verifyToken }))

const express = require("express");

module.exports = function createDiveDirectoryRouter({ pool, verifyToken }) {
  if (!pool) throw new Error("createDiveDirectoryRouter requires { pool, verifyToken }");
  const router = express.Router();

  router.get("/api/dive-directory", verifyToken, async (req, res) => {
    try {
      const r = await pool.query(
        "SELECT * FROM dive_directory ORDER BY dive_code ASC, height ASC",
      );
      res.json(r.rows);
    } catch (err) {
      console.error("[Dive Directory Error]", err.message);
      res.status(500).json([]);
    }
  });

  return router;
};
