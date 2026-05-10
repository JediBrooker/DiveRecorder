// Judge Ranking Analysis — "what would the standings have been if
// every judge had scored unanimously like one specific judge?"
//
//   GET /api/events/:id/judge-ranking-analysis        JSON payload
//   GET /api/events/:id/judge-ranking-analysis.csv    CSV export
//   GET /api/events/:id/judge-ranking-analysis.pdf    PDF export
//
// For each judge J on the panel and each diver D in the event the
// endpoint computes:
//
//     judge_total[J][D] = SUM over rounds R of ( J's score(D, R) × dive DD )
//     rank[J][D]        = RANK() OVER (PARTITION BY J ORDER BY judge_total DESC)
//
// alongside the diver's ACTUAL (panel-trimmed, World Aquatics tie-
// break aware) total + rank. The frontend renders the result as a
// "diver × judge" matrix so a viewer can see at a glance which
// judge's scoring pattern would have re-shuffled the podium.
//
// Per-dive judge rank is also computed (rank within a single round,
// for each judge) so the score-chip tooltip on the scoreboard can
// say "J3 ranked this diver 2nd of 12 in round 1".
//
// Permission: PUBLIC read. Every input (per-judge per-dive score)
// is already visible on the existing scoreboard / archive / judge
// profile pages. Re-aggregating into a hypothetical ranking surfaces
// no new private data — it just visualises a pattern that was
// already in plain sight.
//
// Synchro / team scope: v1 is INDIVIDUAL events only. The
// hypothetical "single-judge unanimous panel" doesn't map cleanly
// to a synchro 9-judge / 11-judge panel split (Exec A / Exec B /
// Sync) without picking arbitrary sub-panel substitutions. Returns
// HTTP 400 with a clear message for synchro_pair / team — same
// precedent as the seed-semi mixed-gender refusal.
//
// SQL discipline (audit-fix bar from commit cde3e40):
//   * Per-judge per-competitor scores are pre-aggregated in a
//     dedicated CTE before any join onto cdl / dive_directory, so
//     a missing-dd row never explodes into a Cartesian fan-out.
//   * COALESCE(dd, 1.0) treats a missing DD as a neutral multiplier
//     rather than zeroing the whole dive — same approach as the
//     existing CSV export.

const express = require("express");
const PDFDocument = require("pdfkit");

// CSV escaping + spreadsheet-formula-injection guard. Identical to
// the helpers in routes/pdf.js — kept inline rather than extracted
// into a shared module so this file stays self-contained until the
// pattern crops up a third time.
function csvCell(s) {
  if (s == null) return "";
  let text = String(s);
  const dangerous = /^[=+\-@\t\r]/.test(text);
  if (dangerous) text = "'" + text;
  if (/[",\n\r]/.test(text) || dangerous) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}
function csvRow(cells) { return cells.map(csvCell).join(",") + "\n"; }

// Filename slug — matches the existing PDF/CSV exports.
function slugify(s) {
  return String(s || "event")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

// Build the analysis payload. Extracted so the JSON, CSV, and PDF
// endpoints can share a single source of truth — adding a column
// in one place ripples through all three exports automatically.
async function buildAnalysis(pool, eventId) {
  const evRes = await pool.query(
    `SELECT e.id, e.name, e.gender, e.height, e.event_type::text AS event_type,
            e.total_rounds, e.number_of_judges, e.status::text AS status,
            e.created_at,
            o.name AS org_name, o.country_code
       FROM events e
       JOIN organisations o ON o.id = e.org_id
      WHERE e.id = $1`,
    [eventId],
  );
  if (!evRes.rows.length) return { notFound: true };
  const event = evRes.rows[0];

  if (event.event_type !== "individual") {
    return {
      badRequest:
        "Judge Ranking Analysis is not yet available for synchro_pair or team events",
    };
  }

  // Panel for this event — judge_number + identity. Used both as
  // the column headers in the rendered table and to join back onto
  // the per-judge totals below.
  const panelRes = await pool.query(
    `SELECT ej.judge_id, ej.judge_number,
            u.full_name,
            o.country_code,
            o.name        AS org_name,
            cl.name       AS club_name,
            cl.short_code AS club_code
       FROM event_judges ej
       JOIN users u         ON u.id = ej.judge_id
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN clubs cl   ON cl.id = u.club_id
      WHERE ej.event_id = $1
      ORDER BY ej.judge_number ASC`,
    [eventId],
  );
  const judges = panelRes.rows;

  // Pre-aggregate per (judge, competitor) judge_total and per
  // (judge, competitor, round) per-round dive points in a single
  // CTE pipeline. The cdl join is by (event_id, competitor_id,
  // round_number) so a missing dive list row drops the dive_dd to
  // NULL → COALESCE keeps the row alive with a neutral 1.0
  // multiplier rather than zeroing it (same fallback the existing
  // CSV export uses for DD = NULL rows).
  const totalsRes = await pool.query(
    `WITH per_dive AS (
       SELECT s.competitor_id,
              s.judge_id,
              s.round_number,
              s.score,
              COALESCE(d.dd, 1.0) AS dd,
              (s.score * COALESCE(d.dd, 1.0))::numeric AS judge_dive_points
         FROM scores s
         LEFT JOIN competitor_dive_lists cdl
           ON  cdl.event_id      = s.event_id
           AND cdl.competitor_id = s.competitor_id
           AND cdl.round_number  = s.round_number
         LEFT JOIN dive_directory d
           ON d.id = COALESCE(s.dive_id, cdl.dive_id)
        WHERE s.event_id = $1
     ),
     per_judge_total AS (
       SELECT competitor_id, judge_id,
              SUM(judge_dive_points)::numeric(10,3) AS judge_total
         FROM per_dive
        GROUP BY competitor_id, judge_id
     ),
     per_judge_ranked AS (
       SELECT competitor_id, judge_id, judge_total,
              RANK() OVER (PARTITION BY judge_id ORDER BY judge_total DESC)::int AS rank
         FROM per_judge_total
     ),
     per_dive_ranked AS (
       SELECT competitor_id, judge_id, round_number, judge_dive_points,
              RANK() OVER (
                PARTITION BY judge_id, round_number
                ORDER BY judge_dive_points DESC
              )::int AS rank,
              COUNT(*) OVER (PARTITION BY judge_id, round_number)::int AS total_in_round
         FROM per_dive
     )
     SELECT 'judge'::text AS kind,
            competitor_id, judge_id,
            NULL::int       AS round_number,
            judge_total     AS judge_total_or_points,
            rank,
            NULL::int       AS total_in_round
       FROM per_judge_ranked
     UNION ALL
     SELECT 'dive'::text,
            competitor_id, judge_id,
            round_number,
            judge_dive_points,
            rank,
            total_in_round
       FROM per_dive_ranked`,
    [eventId],
  );

  // Pre-aggregate the actual standings using the same WA tie-break
  // the scoreboard / archive uses: total DESC, then per-dive
  // descending-sorted array DESC. calc_event_dive_points handles
  // the panel-trim + scaling for the official total.
  const standingsRes = await pool.query(
    `WITH per_dive AS (
       SELECT s.competitor_id, s.round_number,
              calc_event_dive_points(
                array_agg(ej.judge_number ORDER BY ej.judge_number),
                array_agg(s.score        ORDER BY ej.judge_number),
                e.number_of_judges, MAX(d.dd), e.event_type,
                BOOL_OR(cdl.partner_id IS NOT NULL)
              ) AS dive_points
         FROM scores s
         JOIN events e ON e.id = s.event_id
         LEFT JOIN event_judges ej
           ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
         LEFT JOIN competitor_dive_lists cdl
           ON  cdl.event_id      = s.event_id
           AND cdl.competitor_id = s.competitor_id
           AND cdl.round_number  = s.round_number
         LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
        WHERE s.event_id = $1
        GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
     ),
     totals AS (
       SELECT competitor_id,
              SUM(dive_points)::numeric(10,2) AS total,
              array_agg(dive_points ORDER BY dive_points DESC) AS dives_desc
         FROM per_dive
        GROUP BY competitor_id
     )
     SELECT u.id AS competitor_id,
            u.full_name,
            o.country_code,
            cl.name AS club_name,
            t.total AS actual_total,
            RANK() OVER (ORDER BY t.total DESC, t.dives_desc DESC)::int AS actual_rank
       FROM totals t
       JOIN users u ON u.id = t.competitor_id
       JOIN organisations o ON o.id = u.org_id
       LEFT JOIN clubs cl ON cl.id = u.club_id
      ORDER BY actual_rank ASC, u.full_name ASC`,
    [eventId],
  );

  // Index the per-(judge, competitor) and per-(judge, competitor,
  // round) rows for O(1) lookup while building the per-diver
  // arrays.
  const judgeTotals = new Map();        // key = `${judge_id}:${competitor_id}`
  const perDiveRanks = {};              // key = `${judge_id}:${competitor_id}:${round_number}`
  for (const row of totalsRes.rows) {
    if (row.kind === "judge") {
      judgeTotals.set(`${row.judge_id}:${row.competitor_id}`, {
        judge_total: Number(row.judge_total_or_points),
        rank: row.rank,
      });
    } else {
      perDiveRanks[`${row.judge_id}:${row.competitor_id}:${row.round_number}`] = {
        rank: row.rank,
        judge_dive_points: Number(row.judge_total_or_points),
        total_in_round: row.total_in_round,
      };
    }
  }

  const divers = standingsRes.rows.map((row) => ({
    competitor_id: row.competitor_id,
    full_name: row.full_name,
    country_code: row.country_code,
    club_name: row.club_name,
    actual_rank: row.actual_rank,
    actual_total: Number(row.actual_total),
    per_judge: judges.map((j) => {
      const hit = judgeTotals.get(`${j.judge_id}:${row.competitor_id}`);
      return {
        judge_id: j.judge_id,
        judge_number: j.judge_number,
        judge_total: hit ? hit.judge_total : 0,
        rank: hit ? hit.rank : null,
      };
    }),
  }));

  return {
    event: {
      id: event.id,
      name: event.name,
      gender: event.gender,
      height: event.height,
      event_type: event.event_type,
      total_rounds: event.total_rounds,
      number_of_judges: event.number_of_judges,
      status: event.status,
      created_at: event.created_at,
      org_name: event.org_name,
      country_code: event.country_code,
    },
    judges,
    divers,
    per_dive_ranks: perDiveRanks,
  };
}

module.exports = function createJudgeRankingRouter({ pool }) {
  if (!pool) throw new Error("createJudgeRankingRouter requires { pool }");
  const router = express.Router();

  // -------------------------------------------------------------
  // JSON payload — drives the in-page JudgeRankingTable + the
  // scoreboard's chip-tooltip enhancement (per_dive_ranks).
  // -------------------------------------------------------------
  router.get("/api/events/:id/judge-ranking-analysis", async (req, res) => {
    try {
      const result = await buildAnalysis(pool, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Event not found" });
      if (result.badRequest) return res.status(400).json({ error: result.badRequest });
      res.json(result);
    } catch (err) {
      console.error("[Judge Ranking Analysis Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // CSV export — one row per diver, with the Actual column +
  // per-judge (rank, total) columns. Federation operators paste
  // this into central record-keeping systems; the formula-injection
  // guard (csvCell) is essential.
  // -------------------------------------------------------------
  router.get("/api/events/:id/judge-ranking-analysis.csv", async (req, res) => {
    try {
      const result = await buildAnalysis(pool, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Event not found" });
      if (result.badRequest) return res.status(400).json({ error: result.badRequest });
      const { event, judges, divers } = result;
      const slug = slugify(event.name);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}_judge_ranking.csv"`,
      );

      const header = ["diver", "country", "club", "actual_rank", "actual_total"];
      for (const j of judges) {
        header.push(`J${j.judge_number}_rank`, `J${j.judge_number}_total`);
      }
      res.write(csvRow(header));

      for (const d of divers) {
        const cells = [
          d.full_name,
          d.country_code,
          d.club_name,
          d.actual_rank,
          Number(d.actual_total).toFixed(2),
        ];
        for (const pj of d.per_judge) {
          cells.push(
            pj.rank == null ? "" : pj.rank,
            pj.judge_total == null ? "" : Number(pj.judge_total).toFixed(2),
          );
        }
        res.write(csvRow(cells));
      }
      res.end();
    } catch (err) {
      console.error("[Judge Ranking CSV Error]", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PDF export — landscape A4 table, mirrors the on-screen layout.
  // -------------------------------------------------------------
  router.get("/api/events/:id/judge-ranking-analysis.pdf", async (req, res) => {
    try {
      const result = await buildAnalysis(pool, req.params.id);
      if (result.notFound) return res.status(404).json({ error: "Event not found" });
      if (result.badRequest) return res.status(400).json({ error: result.badRequest });
      const { event, judges, divers } = result;
      const slug = slugify(event.name);

      const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${slug}_judge_ranking.pdf"`,
      );
      doc.pipe(res);

      // ---------- Header ----------
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#06b6d4")
        .text(
          (event.org_name || "").toUpperCase() +
            (event.country_code ? `  ·  ${event.country_code}` : ""),
          { align: "center", characterSpacing: 2 },
        );
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(18).fillColor("#0f172a")
        .text(event.name, { align: "center" });
      doc.font("Helvetica").fontSize(10).fillColor("#475569")
        .text("Judge Ranking Analysis", { align: "center" });
      const meta = [
        event.gender, event.height,
        `${event.total_rounds} rounds`, `${event.number_of_judges} judges`,
      ].filter(Boolean).join("  ·  ");
      doc.font("Helvetica").fontSize(9).fillColor("#64748b")
        .text(meta, { align: "center" });
      doc.moveDown(0.4);
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(40, doc.y).lineTo(802, doc.y).stroke();
      doc.moveDown(0.5);

      if (!divers.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No scored dives for this event yet.", { align: "center" });
        doc.end();
        return;
      }

      // ---------- Table ----------
      // Column layout: Diver (200) | Actual (60) | J1..JN evenly.
      const startX = 40;
      const nameCol = 200;
      const actualCol = 80;
      const remaining = 802 - startX - nameCol - actualCol - 10;
      const judgeColWidth = Math.max(38, Math.floor(remaining / Math.max(judges.length, 1)));

      function drawHeader() {
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#06b6d4");
        let x = startX;
        const headerY = doc.y;
        doc.text("DIVER", x, headerY, { width: nameCol });
        x += nameCol;
        doc.text("ACTUAL", x, headerY, { width: actualCol, align: "center" });
        x += actualCol;
        for (const j of judges) {
          doc.text(`J${j.judge_number}`, x, headerY, {
            width: judgeColWidth, align: "center",
          });
          x += judgeColWidth;
        }
        doc.moveDown(0.5);
        doc.lineWidth(0.5).strokeColor("#cbd5e1")
          .moveTo(startX, doc.y)
          .lineTo(startX + nameCol + actualCol + judgeColWidth * judges.length, doc.y)
          .stroke();
        doc.moveDown(0.3);
        doc.fillColor("#0f172a");
      }
      drawHeader();

      for (const d of divers) {
        if (doc.y > 540) {
          doc.addPage({ size: "A4", layout: "landscape", margin: 40 });
          drawHeader();
        }
        const rowY = doc.y;
        let x = startX;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a");
        const nameLine = d.full_name + (d.country_code ? `  ${d.country_code}` : "");
        doc.text(nameLine, x, rowY, { width: nameCol });
        if (d.club_name) {
          doc.font("Helvetica").fontSize(8).fillColor("#64748b")
            .text(d.club_name, x, doc.y, { width: nameCol });
        }
        x += nameCol;
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#0f172a")
          .text(`${d.actual_rank} (${Number(d.actual_total).toFixed(1)})`,
            x, rowY, { width: actualCol, align: "center" });
        x += actualCol;
        for (const pj of d.per_judge) {
          // Highlight outliers — judges whose rank differs from
          // actual by 2+ positions. Same threshold the frontend
          // applies for the cyan accent.
          const isOutlier = pj.rank != null
            && Math.abs(pj.rank - d.actual_rank) >= 2;
          doc.font(isOutlier ? "Helvetica-Bold" : "Helvetica")
            .fontSize(10)
            .fillColor(isOutlier ? "#06b6d4" : "#0f172a")
            .text(pj.rank == null ? "—" : String(pj.rank),
              x, rowY, { width: judgeColWidth, align: "center" });
          x += judgeColWidth;
        }
        doc.moveDown(0.5);
        doc.lineWidth(0.3).strokeColor("#e2e8f0")
          .moveTo(startX, doc.y)
          .lineTo(startX + nameCol + actualCol + judgeColWidth * judges.length, doc.y)
          .stroke();
        doc.moveDown(0.2);
      }

      doc.moveDown(0.8);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(
          `Generated ${new Date().toLocaleString()} via Dive Recorder.  ` +
          "Each judge column shows the rank this diver would hold if every " +
          "judge had scored unanimously like that judge.",
          { align: "center" },
        );

      doc.end();
    } catch (err) {
      console.error("[Judge Ranking PDF Error]", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate PDF" });
    }
  });

  return router;
};
