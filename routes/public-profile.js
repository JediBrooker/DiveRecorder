// Public diver profile — share-friendly read-only page.
//
//   GET /api/public/divers/:public_slug
//       JSON payload (the SPA route /diver/:slug consumes this)
//
//   GET /diver/:public_slug
//       Server-rendered HTML when a social-network crawler asks
//       (Twitterbot, FacebookExternalHit, LinkedInBot, etc) so
//       the unfurled link card looks right. Browsers fall through
//       to the SPA's index.html.
//
//   GET /api/public/divers/:public_slug/og-card.png
//       (left as a TODO — static fallback used for now)
//
// Permission model: completely public. The profile shows only
// data already visible on the live scoreboard / archive — name,
// org, country, club, headline meet stats, recent placings.
// Internal fields (email, dashboard_widgets, judge assignments)
// are never included.
//
// Mounted via:
//   app.use(require('./routes/public-profile')({ … }))

const express = require("express");

// Crawler UA detection. Matched anywhere in the User-Agent
// string. Conservative — we'd rather mis-serve OG-tagged HTML
// to a curl probe than fail to unfurl on a real Twitter card.
const CRAWLER_UA_RE = /(twitterbot|facebookexternalhit|linkedinbot|slackbot|discordbot|whatsapp|telegrambot|googlebot|bingbot|duckduckbot|pinterestbot|redditbot)/i;

// HTML-escape a free-text field before splicing it into a meta
// tag. The values come from the DB (full_name, org_name, club
// name) which we sanitised on the way in (Migration 021), but
// defence in depth — a missed code path that lets a bad string
// land would otherwise pop a meta tag attribute.
function htmlEscape(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

module.exports = function createPublicProfileRouter({ pool, readPool }) {
  if (!pool) throw new Error("createPublicProfileRouter requires { pool, … }");
  const reads = readPool || pool;
  const router = express.Router();

  // -------------------------------------------------------------
  // GET /api/public/divers/:public_slug — JSON payload.
  //
  // Returns:
  //   diver:           id (opaque slug, NOT user_id), full_name,
  //                    org name + country, club name + code
  //   stats:           total meets, total dives, best single
  //                    dive total, average DD attempted (all
  //                    over the diver's full history, so the
  //                    page has something to say even for a
  //                    diver who just wrapped one event)
  //   recent_meets:    last 5 events with placing + score
  //
  // No PII (no email, no internal id, no dashboard layout).
  // -------------------------------------------------------------
  router.get("/api/public/divers/:public_slug", async (req, res) => {
    try {
      const slug = req.params.public_slug;
      // Cheap shape check — public_slug is 32 hex chars (16 bytes
      // of randomness, base16-encoded). Reject anything else with
      // a 404 to avoid filling the logs with junk.
      if (!/^[0-9a-f]{32}$/i.test(slug)) {
        return res.status(404).json({ error: "Diver not found" });
      }
      const diverRes = await reads.query(
        `SELECT u.id, u.full_name,
                u.org_id, o.name AS org_name, o.country_code,
                u.club_id, cl.name AS club_name, cl.short_code AS club_code
         FROM users u
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.public_slug = $1`,
        [slug],
      );
      if (!diverRes.rows.length) {
        return res.status(404).json({ error: "Diver not found" });
      }
      const diver = diverRes.rows[0];

      // Stats query — same shape as /api/divers/:id/profile but
      // without the date filter (public profile is "all time").
      const stats = await reads.query(
        `WITH dive_totals AS (
           SELECT s.event_id, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS dive_total,
                  MAX(d.dd) AS dd
           FROM scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE s.competitor_id = $1
           GROUP BY s.event_id, s.round_number, e.number_of_judges, e.event_type
         )
         SELECT
           COUNT(DISTINCT event_id)::int AS total_meets,
           COUNT(*)::int                 AS total_dives,
           AVG(dd)::numeric(4,2)         AS avg_dd,
           MAX(dive_total)::numeric(6,2) AS best_single_dive
         FROM dive_totals`,
        [diver.id],
      );

      // Last 5 meets ranked against the full field. Same FULL_FIELD
      // ranking shape as the analytics dashboard's recent_form,
      // simplified for public consumption.
      const recent = await reads.query(
        `WITH per_dive AS (
           SELECT s.event_id, s.competitor_id, s.round_number,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS pts
           FROM scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE s.event_id IN (
             SELECT DISTINCT event_id FROM scores WHERE competitor_id = $1
           )
           GROUP BY s.event_id, s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         ),
         totals AS (
           SELECT event_id, competitor_id, SUM(pts) AS total
           FROM per_dive GROUP BY event_id, competitor_id
         ),
         ranked AS (
           SELECT *, RANK() OVER (PARTITION BY event_id ORDER BY total DESC) AS rnk,
                  COUNT(*) OVER (PARTITION BY event_id)::int AS field_size
           FROM totals
         )
         SELECT e.id AS event_id, e.name AS event_name, e.created_at,
                e.event_type::text AS event_type, e.height,
                ranked.total::numeric(8,2) AS total,
                ranked.rnk::int AS rank,
                ranked.field_size
         FROM ranked
         JOIN events e ON e.id = ranked.event_id
         WHERE ranked.competitor_id = $1
         ORDER BY e.created_at DESC
         LIMIT 5`,
        [diver.id],
      );

      res.json({
        diver: {
          public_slug: slug,
          full_name:   diver.full_name,
          org_name:    diver.org_name,
          country_code: diver.country_code,
          club_name:   diver.club_name,
          club_code:   diver.club_code,
        },
        stats: stats.rows[0] || {
          total_meets: 0, total_dives: 0,
          avg_dd: null, best_single_dive: null,
        },
        recent_meets: recent.rows,
      });
    } catch (err) {
      console.error("[Public Profile Error]", err.message);
      res.status(500).json({ error: "Couldn't load public profile" });
    }
  });

  // -------------------------------------------------------------
  // GET /diver/:public_slug — server-rendered HTML for crawlers,
  // SPA fallthrough for browsers.
  //
  // Detection: User-Agent is checked against CRAWLER_UA_RE. If
  // it matches, we return a tiny HTML document with OG + Twitter
  // card meta tags so the unfurled link looks good. Browsers
  // (everything not matching) fall through (next()) to the
  // existing SPA history-API rewrite, which serves index.html
  // and the Vue router takes over.
  //
  // The route is mounted BEFORE the SPA fallback in server.js so
  // the next() above hits the SPA middleware naturally.
  // -------------------------------------------------------------
  router.get("/diver/:public_slug", async (req, res, next) => {
    const ua = req.headers["user-agent"] || "";
    if (!CRAWLER_UA_RE.test(ua)) return next();

    const slug = req.params.public_slug;
    if (!/^[0-9a-f]{32}$/i.test(slug)) return next();

    try {
      const r = await reads.query(
        `SELECT u.full_name, o.name AS org_name, o.country_code, cl.name AS club_name
         FROM users u
         JOIN organisations o ON u.org_id = o.id
         LEFT JOIN clubs cl ON cl.id = u.club_id
         WHERE u.public_slug = $1`,
        [slug],
      );
      if (!r.rows.length) return next();
      const d = r.rows[0];

      const base = process.env.APP_BASE_URL || `${req.protocol}://${req.get("host")}`;
      const url = `${base}/diver/${slug}`;
      const title = `${d.full_name} — Dive Recorder`;
      const subline = [d.org_name, d.country_code, d.club_name]
        .filter(Boolean).join(" · ");
      const description = subline
        ? `${subline}. View competitive history, personal bests, and recent meet placings.`
        : "View competitive history, personal bests, and recent meet placings.";
      const ogImage = `${base}/icon-512.png`; // TODO: dynamic OG card per diver

      // Inline HTML — no template engine. Just Open Graph +
      // Twitter card meta. The body is intentionally near-empty:
      // crawlers only read the head, and a human who somehow
      // lands here without JS gets a graceful redirect.
      res
        .status(200)
        .set("Content-Type", "text/html; charset=utf-8")
        .end(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>${htmlEscape(title)}</title>
<meta name="description" content="${htmlEscape(description)}">
<meta property="og:type" content="profile">
<meta property="og:url" content="${htmlEscape(url)}">
<meta property="og:title" content="${htmlEscape(title)}">
<meta property="og:description" content="${htmlEscape(description)}">
<meta property="og:image" content="${htmlEscape(ogImage)}">
<meta property="og:site_name" content="Dive Recorder">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${htmlEscape(title)}">
<meta name="twitter:description" content="${htmlEscape(description)}">
<meta name="twitter:image" content="${htmlEscape(ogImage)}">
<meta http-equiv="refresh" content="0; url=${htmlEscape(url)}">
</head><body>
<noscript><a href="${htmlEscape(url)}">${htmlEscape(title)}</a></noscript>
</body></html>`);
    } catch (err) {
      console.error("[Public Profile HTML Error]", err.message);
      next();   // fall through to SPA on DB error
    }
  });

  return router;
};
