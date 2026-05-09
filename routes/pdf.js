// PDF + CSV exports — printable artefacts for officials and
// federations. Five public endpoints (data is already exposed via
// the live scoreboard / archive, no auth gate):
//
//   GET /api/meets/:id/program.pdf                       meet program
//   GET /api/events/:id/start-list.pdf                   pin-to-deck pre-meet
//   GET /api/events/:id/divers/:diverId/score-sheet.pdf  per-diver recap
//   GET /api/events/:id/results.csv                      one row per dive
//   GET /api/events/:id/results.pdf                      final standings + dives
//
// Each handler streams the bytes straight back via doc.pipe(res)
// (or res.write for CSV) so a 500-row meet doesn't buffer in
// memory before sending. PDFKit comes with the standard
// Helvetica family bundled, so there's no font-installation
// dependency on the host.
//
// Mounted via:
//   app.use(require('./routes/pdf')({ pool }))

const express = require("express");
const PDFDocument = require("pdfkit");

// CSV escaping + spreadsheet-formula-injection guard.
//
// RFC 4180 quoting handles commas, quotes, newlines. The
// leading-character guard handles the Excel/Google Sheets
// "if the cell starts with =, +, -, @, tab, or CR, evaluate
// it as a formula" foot-gun — a diver registering with
// full_name = "=cmd|'/c calc'!A0" would otherwise execute on
// every operator's machine when they open the exported CSV.
// Prepending a single quote forces Excel to treat the cell as
// literal text; the apostrophe doesn't render in the cell but
// is still valid CSV.
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

module.exports = function createPdfRouter({ pool }) {
  if (!pool) throw new Error("createPdfRouter requires { pool }");
  const router = express.Router();

  // -------------------------------------------------------------
  // Public meet program PDF — full schedule, every event in the
  // bundle, competitor count per event, sponsor strip on the
  // cover. No auth required (public meet pages already expose
  // this data via /meet/:id).
  // -------------------------------------------------------------
  router.get("/api/meets/:id/program.pdf", async (req, res) => {
    try {
      const [meetRes, eventsRes] = await Promise.all([
        pool.query(
          `SELECT m.*, o.name AS org_name, o.country_code
           FROM meets m
           JOIN organisations o ON o.id = m.org_id
           WHERE m.id = $1`,
          [req.params.id],
        ),
        pool.query(
          `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                  e.total_rounds, e.number_of_judges, e.event_type,
                  e.event_format, e.parent_event_id, e.scheduled_at,
                  e.dd_limit_rounds, e.dd_limit_value, e.status,
                  COALESCE(stat.competitor_count, 0)::int AS competitor_count
           FROM events e
           LEFT JOIN LATERAL (
             SELECT COUNT(DISTINCT cdl.competitor_id) AS competitor_count
             FROM competitor_dive_lists cdl
             WHERE cdl.event_id = e.id AND cdl.withdrawn_at IS NULL
           ) stat ON true
           WHERE e.meet_id = $1
           ORDER BY
             e.scheduled_at NULLS LAST,
             CASE e.event_format WHEN 'preliminary' THEN 0 ELSE 1 END,
             e.created_at ASC`,
          [req.params.id],
        ),
      ]);

      if (!meetRes.rows.length) {
        return res.status(404).json({ error: "Meet not found" });
      }
      const meet = meetRes.rows[0];
      const events = eventsRes.rows;

      const slug = (meet.name || "meet")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "");
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_program.pdf"`);
      doc.pipe(res);

      // ---------- Cover ----------
      doc.font("Helvetica-Bold").fontSize(11)
        .fillColor("#06b6d4")
        .text((meet.org_name || "").toUpperCase() +
              (meet.country_code ? `  ·  ${meet.country_code}` : ""),
              { align: "center" });
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(28).fillColor("#0f172a")
        .text(meet.name, { align: "center" });
      doc.moveDown(0.3);

      if (meet.start_date || meet.end_date) {
        const fmt = (d) => d
          ? new Date(d).toLocaleDateString(undefined, {
              year: "numeric", month: "long", day: "numeric",
            })
          : "";
        const range = meet.start_date && meet.end_date && meet.start_date !== meet.end_date
          ? `${fmt(meet.start_date)} – ${fmt(meet.end_date)}`
          : fmt(meet.start_date || meet.end_date);
        doc.font("Helvetica").fontSize(13).fillColor("#334155")
          .text(range, { align: "center" });
      }
      if (meet.venue) {
        doc.moveDown(0.2);
        doc.font("Helvetica").fontSize(12).fillColor("#64748b")
          .text(meet.venue, { align: "center" });
      }
      if (meet.description) {
        doc.moveDown(0.6);
        doc.font("Helvetica-Oblique").fontSize(10).fillColor("#475569")
          .text(meet.description, { align: "center", width: 480 });
      }
      if (meet.sponsor_name) {
        doc.moveDown(1.5);
        doc.font("Helvetica").fontSize(9).fillColor("#94a3b8")
          .text("POWERED BY", { align: "center", characterSpacing: 3 });
        doc.font("Helvetica-Bold").fontSize(14).fillColor("#0f172a")
          .text(meet.sponsor_name, { align: "center" });
      }

      doc.moveDown(2);

      // ---------- Schedule list ----------
      doc.font("Helvetica-Bold").fontSize(11)
        .fillColor("#06b6d4")
        .text("EVENT SCHEDULE", { characterSpacing: 3 });
      doc.moveDown(0.4);
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.6);

      if (!events.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No events scheduled for this meet yet.");
      }

      for (const ev of events) {
        // Page break if we're running off the page
        if (doc.y > 720) doc.addPage();

        const time = ev.scheduled_at
          ? new Date(ev.scheduled_at).toLocaleString(undefined, {
              month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
            })
          : "TBA";

        doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
          .text(ev.name, { continued: false });
        doc.font("Helvetica").fontSize(10).fillColor("#64748b");

        const tags = [];
        if (ev.event_type === "synchro_pair") tags.push("SYNCHRO");
        else if (ev.event_type === "team")    tags.push("TEAM");
        if (ev.event_format === "preliminary") tags.push("PRELIM");
        else if (ev.parent_event_id)           tags.push("FINAL");
        if (ev.age_group) tags.push(ev.age_group);
        tags.push(ev.gender);
        if (ev.height) tags.push(ev.height);
        tags.push(`${ev.total_rounds} rounds`);
        tags.push(`${ev.number_of_judges} judges`);
        if (ev.dd_limit_rounds && ev.dd_limit_value) {
          tags.push(`DD ≤ ${ev.dd_limit_value} for first ${ev.dd_limit_rounds}`);
        }

        doc.text(tags.join("  ·  "));

        doc.font("Helvetica").fontSize(10).fillColor("#475569");
        const meta = [];
        meta.push(time);
        if (ev.competitor_count) {
          meta.push(`${ev.competitor_count} ${ev.competitor_count === 1 ? "diver" : "divers"}`);
        }
        meta.push(ev.status);
        doc.text(meta.join("  ·  "));

        doc.moveDown(0.7);
        doc.lineWidth(0.3).strokeColor("#e2e8f0")
          .moveTo(50, doc.y - 4).lineTo(545, doc.y - 4).stroke();
      }

      doc.moveDown(1);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(
          `Generated ${new Date().toLocaleString()} via Dive Recorder.`,
          { align: "center" },
        );

      doc.end();
    } catch (err) {
      console.error("[Meet Program PDF Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // START LIST PDF — pinned-to-wall pre-meet sheet showing every
  // diver in start-order with their per-round dives. Operators
  // print this and pin it to the deck so divers know when they're
  // up. Reuses the program PDF's PDFKit setup but the body is a
  // per-diver dive-list table sorted by display_order then name.
  // -------------------------------------------------------------
  router.get("/api/events/:id/start-list.pdf", async (req, res) => {
    try {
      const [evRes, rosterRes] = await Promise.all([
        pool.query(
          `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                  e.total_rounds, e.number_of_judges, e.event_type,
                  e.event_format, e.scheduled_at,
                  o.name AS org_name, o.country_code
           FROM events e
           JOIN organisations o ON o.id = e.org_id
           WHERE e.id = $1`,
          [req.params.id],
        ),
        pool.query(
          `SELECT u.id AS competitor_id, u.full_name, o.country_code,
                  cl.name AS club_name, cl.short_code AS club_code,
                  pu.full_name AS partner_name,
                  tm.name AS team_name,
                  cdl.round_number, cdl.display_order, cdl.withdrawn_at,
                  d.dive_code, d.position, d.dd
           FROM users u
           JOIN competitor_dive_lists cdl ON u.id = cdl.competitor_id
           JOIN organisations o ON u.org_id = o.id
           LEFT JOIN clubs cl  ON cl.id = u.club_id
           LEFT JOIN users pu  ON pu.id = cdl.partner_id
           LEFT JOIN teams tm  ON tm.id = cdl.team_id
           LEFT JOIN dive_directory d ON d.id = cdl.dive_id
           WHERE cdl.event_id = $1
           ORDER BY cdl.display_order ASC NULLS LAST,
                    u.full_name ASC, cdl.round_number ASC`,
          [req.params.id],
        ),
      ]);
      if (!evRes.rows.length) return res.status(404).json({ error: "Event not found" });
      const event = evRes.rows[0];

      // Reshape: one row per diver with an array of N dives
      // indexed by round (1-based). Reflects the layout PDFKit
      // will render.
      const byDiver = new Map();
      for (const r of rosterRes.rows) {
        if (!byDiver.has(r.competitor_id)) {
          byDiver.set(r.competitor_id, {
            full_name: r.full_name,
            country_code: r.country_code,
            club_name: r.club_name,
            club_code: r.club_code,
            partner_name: r.partner_name,
            team_name: r.team_name,
            withdrawn: !!r.withdrawn_at,
            dives: Array.from({ length: event.total_rounds }, () => null),
          });
        }
        const diver = byDiver.get(r.competitor_id);
        if (r.round_number >= 1 && r.round_number <= event.total_rounds) {
          diver.dives[r.round_number - 1] = {
            code: r.dive_code,
            position: r.position,
            dd: r.dd,
          };
        }
      }
      const divers = [...byDiver.values()];

      const slug = (event.name || "event")
        .toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const doc = new PDFDocument({ margin: 40, size: "A4", layout: "landscape" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_start_list.pdf"`);
      doc.pipe(res);

      // ---------- Header ----------
      doc.font("Helvetica-Bold").fontSize(11).fillColor("#06b6d4")
        .text((event.org_name || "").toUpperCase()
          + (event.country_code ? `  ·  ${event.country_code}` : ""),
          { align: "center", characterSpacing: 2 });
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a")
        .text(event.name, { align: "center" });
      doc.font("Helvetica").fontSize(10).fillColor("#475569");
      const tags = [];
      if (event.event_type === "synchro_pair") tags.push("SYNCHRO");
      else if (event.event_type === "team")    tags.push("TEAM");
      if (event.event_format && event.event_format !== "final") {
        tags.push(event.event_format.toUpperCase());
      }
      if (event.age_group) tags.push(event.age_group);
      tags.push(event.gender);
      if (event.height) tags.push(event.height);
      tags.push(`${event.total_rounds} rounds · ${event.number_of_judges} judges`);
      doc.text(tags.join("  ·  "), { align: "center" });
      doc.moveDown(0.6);
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(40, doc.y).lineTo(802, doc.y).stroke();
      doc.moveDown(0.4);

      if (!divers.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No divers entered for this event yet.", { align: "center" });
        doc.end();
        return;
      }

      // ---------- Table header ----------
      // Column layout: # | Name + Club | R1 .. Rn
      const startX  = 40;
      const numCol  = 20;
      const nameCol = 200;
      const totalRounds = event.total_rounds;
      const roundColWidth = Math.max(50, Math.floor((802 - startX - numCol - nameCol - 10) / totalRounds));

      function drawTableHeader() {
        doc.font("Helvetica-Bold").fontSize(8).fillColor("#06b6d4");
        let x = startX;
        doc.text("#", x, doc.y, { width: numCol, align: "center" });
        x += numCol;
        doc.text("DIVER", x, doc.y, { width: nameCol });
        x += nameCol;
        const headerY = doc.y;
        for (let r = 1; r <= totalRounds; r++) {
          doc.text(`R${r}`, x, headerY, { width: roundColWidth, align: "center" });
          x += roundColWidth;
        }
        doc.moveDown(0.4);
        doc.lineWidth(0.5).strokeColor("#cbd5e1")
          .moveTo(startX, doc.y).lineTo(startX + numCol + nameCol + roundColWidth * totalRounds, doc.y).stroke();
        doc.moveDown(0.3);
        doc.fillColor("#0f172a");
      }
      drawTableHeader();

      divers.forEach((d, idx) => {
        // Page break
        if (doc.y > 540) {
          doc.addPage({ size: "A4", layout: "landscape", margin: 40 });
          drawTableHeader();
        }
        const rowY = doc.y;
        let x = startX;
        // Number column
        doc.font("Helvetica").fontSize(10).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
        doc.text(String(idx + 1), x, rowY, { width: numCol, align: "center" });
        x += numCol;
        // Name + meta column
        doc.font("Helvetica-Bold").fontSize(10).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
        const nameLine = d.full_name + (d.country_code ? `  ${d.country_code}` : "")
          + (d.partner_name ? `  &  ${d.partner_name}` : "")
          + (d.withdrawn ? "  (WITHDRAWN)" : "");
        doc.text(nameLine, x, rowY, { width: nameCol });
        // Club / team subline
        const subline = d.team_name
          ? d.team_name
          : (d.club_name ? d.club_name + (d.club_code ? `  (${d.club_code})` : "") : "");
        if (subline) {
          doc.font("Helvetica").fontSize(8).fillColor("#64748b");
          doc.text(subline, x, doc.y, { width: nameCol });
        }
        x += nameCol;
        // Round columns
        const cellTopY = rowY;
        doc.font("Helvetica").fontSize(9).fillColor(d.withdrawn ? "#cbd5e1" : "#0f172a");
        for (let r = 0; r < totalRounds; r++) {
          const dive = d.dives[r];
          const cellText = dive
            ? `${dive.code || ""}${dive.position || ""}\nDD ${Number(dive.dd ?? 0).toFixed(1)}`
            : "—";
          doc.text(cellText, x, cellTopY, { width: roundColWidth, align: "center" });
          x += roundColWidth;
        }
        doc.moveDown(0.4);
        doc.lineWidth(0.3).strokeColor("#e2e8f0")
          .moveTo(startX, doc.y).lineTo(startX + numCol + nameCol + roundColWidth * totalRounds, doc.y).stroke();
        doc.moveDown(0.2);
      });

      doc.moveDown(1);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(`Generated ${new Date().toLocaleString()} via Dive Recorder.`, { align: "center" });

      doc.end();
    } catch (err) {
      console.error("[Start List PDF Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // PER-DIVER SCORE SHEET PDF — every diver wants their own
  // report after a meet. Reuses the dive-with-judges shape we
  // already build for Recent Form: per-round dive metadata + each
  // judge's raw score (with the dropped scores marked under World Aquatics
  // trim rules, the same way the live scoreboard renders them).
  // -------------------------------------------------------------
  router.get("/api/events/:id/divers/:diverId/score-sheet.pdf", async (req, res) => {
    try {
      const eventId = req.params.id;
      const diverId = req.params.diverId;

      const [evRes, diverRes, divesRes, totalRes] = await Promise.all([
        pool.query(
          `SELECT e.id, e.name, e.gender, e.age_group, e.height,
                  e.total_rounds, e.number_of_judges, e.event_type,
                  e.created_at,
                  o.name AS org_name, o.country_code
           FROM events e
           JOIN organisations o ON o.id = e.org_id
           WHERE e.id = $1`,
          [eventId],
        ),
        pool.query(
          `SELECT u.id, u.full_name, o.country_code,
                  cl.name AS club_name, cl.short_code AS club_code
           FROM users u
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           WHERE u.id = $1`,
          [diverId],
        ),
        pool.query(
          `SELECT s.round_number,
                  d.dive_code, d.position, d.height, d.dd, d.description,
                  e.number_of_judges, e.event_type::text AS event_type,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
                    e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS dive_total,
                  array_agg(json_build_object(
                    'judge_number', ej.judge_number,
                    'score',        s.score
                  ) ORDER BY ej.judge_number) AS judges_json
           FROM scores s
           JOIN events e ON e.id = s.event_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE s.event_id = $1 AND s.competitor_id = $2
           GROUP BY s.round_number, d.dive_code, d.position, d.height, d.dd, d.description,
                    e.number_of_judges, e.event_type
           ORDER BY s.round_number ASC`,
          [eventId, diverId],
        ),
        // Final placing — full-field rank query identical to the
        // analytics rollup, kept inline since it's a one-off here.
        pool.query(
          `WITH per_dive AS (
             SELECT s.competitor_id,
                    calc_event_dive_points(
                      array_agg(ej.judge_number ORDER BY ej.judge_number),
                      array_agg(s.score        ORDER BY ej.judge_number),
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
             WHERE s.event_id = $1
             GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
           ),
           totals AS (
             SELECT competitor_id, SUM(pts) AS total
             FROM per_dive GROUP BY competitor_id
           ),
           ranked AS (
             SELECT *, RANK() OVER (ORDER BY total DESC) AS rnk,
                    COUNT(*) OVER ()::int AS field_size
             FROM totals
           )
           SELECT total, rnk, field_size FROM ranked WHERE competitor_id = $2`,
          [eventId, diverId],
        ),
      ]);
      if (!evRes.rows.length)    return res.status(404).json({ error: "Event not found" });
      if (!diverRes.rows.length) return res.status(404).json({ error: "Diver not found" });
      const event = evRes.rows[0];
      const diver = diverRes.rows[0];
      const dives = divesRes.rows;
      const totals = totalRes.rows[0] || {};

      // World Aquatics trim — apply the same algorithm the frontend uses
      // (lib/score-trim semantics) so the dropped marks line up.
      function trimCount(n) {
        if (!n || n <= 3) return 0;
        if (n === 5)  return 1;
        if (n === 7)  return 2;
        if (n === 9)  return 2;
        if (n === 11) return 3;
        return 0;
      }
      function annotateDrops(judges, n /*, eventType */) {
        // For synchro 9/11 we'd need the sub-panel logic. For the
        // score sheet we keep things simple — the canonical
        // dive_total comes from the SQL function, and we just need
        // the visual "what was dropped" markup. Fall back to
        // individual trim for synchro panels we don't fully model
        // here.
        const flagged = judges.map((j) => ({ ...j, dropped: false }));
        const k = trimCount(n);
        if (!k || flagged.length <= k * 2) return flagged;
        const sorted = flagged
          .map((j, i) => ({ idx: i, score: Number(j.score), jn: j.judge_number }))
          .sort((a, b) => a.score - b.score || a.jn - b.jn);
        for (let i = 0; i < k; i++) {
          flagged[sorted[i].idx].dropped = true;
          flagged[sorted[sorted.length - 1 - i].idx].dropped = true;
        }
        return flagged;
      }

      const slug = (diver.full_name || "diver").toLowerCase()
        .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
      const doc = new PDFDocument({ margin: 50, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_score_sheet.pdf"`);
      doc.pipe(res);

      // ---------- Header ----------
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#06b6d4")
        .text(event.org_name.toUpperCase()
          + (event.country_code ? `  ·  ${event.country_code}` : ""),
          { align: "center", characterSpacing: 2 });
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(20).fillColor("#0f172a")
        .text(diver.full_name + (diver.country_code ? `  ${diver.country_code}` : ""), { align: "center" });
      if (diver.club_name) {
        doc.font("Helvetica").fontSize(11).fillColor("#475569")
          .text(diver.club_name + (diver.club_code ? `  (${diver.club_code})` : ""), { align: "center" });
      }
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a")
        .text(event.name, { align: "center" });
      const meta = [
        event.gender, event.height, `${event.total_rounds} rounds`, `${event.number_of_judges} judges`,
        event.created_at ? new Date(event.created_at).toLocaleDateString() : "",
      ].filter(Boolean).join("  ·  ");
      doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(meta, { align: "center" });
      doc.moveDown(0.8);

      // ---------- Headline result tile ----------
      if (totals.rnk) {
        const rank = Number(totals.rnk);
        const total = Number(totals.total).toFixed(2);
        const fieldSize = Number(totals.field_size);
        const ord = (n) => {
          const s = ["th", "st", "nd", "rd"], v = n % 100;
          return n + (s[(v - 20) % 10] || s[v] || s[0]);
        };
        doc.font("Helvetica-Bold").fontSize(28).fillColor(
          rank === 1 ? "#ca8a04" : rank === 2 ? "#475569" : rank === 3 ? "#92400e" : "#0f172a",
        ).text(`${ord(rank)} of ${fieldSize}`, { align: "center" });
        doc.font("Helvetica").fontSize(12).fillColor("#475569")
          .text(`Total: ${total}`, { align: "center" });
        doc.moveDown(0.8);
      }

      if (!dives.length) {
        doc.font("Helvetica-Oblique").fontSize(11).fillColor("#64748b")
          .text("No dives recorded for this diver yet.");
        doc.end();
        return;
      }

      // ---------- Per-dive breakdown ----------
      doc.lineWidth(0.5).strokeColor("#cbd5e1")
        .moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.4);
      doc.font("Helvetica-Bold").fontSize(10).fillColor("#06b6d4")
        .text("DIVE-BY-DIVE BREAKDOWN", { characterSpacing: 2 });
      doc.moveDown(0.4);

      for (const d of dives) {
        if (doc.y > 720) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(11).fillColor("#0f172a")
          .text(`Round ${d.round_number}  ·  ${d.dive_code || "—"}${d.position || ""}`,
            { continued: true });
        doc.font("Helvetica").fontSize(10).fillColor("#475569")
          .text(`   DD ${Number(d.dd ?? 0).toFixed(1)}   Total ${Number(d.dive_total).toFixed(2)}`,
            { align: "right" });
        if (d.description) {
          doc.font("Helvetica-Oblique").fontSize(9).fillColor("#64748b")
            .text(d.description);
        }
        doc.moveDown(0.2);

        const annotated = annotateDrops(d.judges_json || [], d.number_of_judges, d.event_type);
        const lineParts = annotated.map((j) =>
          j.dropped
            ? `[${Number(j.score).toFixed(1)}]`     // brackets = dropped
            : Number(j.score).toFixed(1),
        );
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a")
          .text("Judges: " + lineParts.join("  "), { indent: 10 });
        doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
          .text("(dropped scores shown in brackets)", { indent: 10 });

        doc.moveDown(0.6);
      }

      doc.moveDown(0.4);
      doc.font("Helvetica-Oblique").fontSize(8).fillColor("#94a3b8")
        .text(`Generated ${new Date().toLocaleString()} via Dive Recorder.`, { align: "center" });
      doc.end();
    } catch (err) {
      console.error("[Score Sheet PDF Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // CSV EXPORT — federation operators copy results into the
  // federation's central record-keeping system. Same data as the
  // results PDF, formatted as a single CSV with one row per dive
  // so downstream pivot tables work cleanly.
  // -------------------------------------------------------------
  router.get("/api/events/:id/results.csv", async (req, res) => {
    try {
      const [evRes, divesRes] = await Promise.all([
        pool.query(
          "SELECT e.name, e.gender, e.height, e.event_type, o.name AS org_name FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = $1",
          [req.params.id],
        ),
        pool.query(
          `SELECT u.id AS competitor_id, u.full_name AS diver_name, o.country_code,
                  cl.name AS club_name, cl.short_code AS club_code,
                  pu.full_name AS partner_name, tm.name AS team_name,
                  s.round_number, d.dive_code, d.position, d.dd,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
                    e.number_of_judges, d.dd, e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
                  ) AS dive_total,
                  STRING_AGG(s.score::text, ' ' ORDER BY ej.judge_number) AS judge_scores
           FROM scores s
           JOIN events e ON e.id = s.event_id
           JOIN users u  ON u.id = s.competitor_id
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl  ON cl.id = u.club_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl
             ON cdl.event_id = s.event_id
            AND cdl.competitor_id = s.competitor_id
            AND cdl.round_number = s.round_number
           LEFT JOIN users pu ON pu.id = cdl.partner_id
           LEFT JOIN teams tm ON tm.id = cdl.team_id
           LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
           WHERE s.event_id = $1
           GROUP BY u.id, u.full_name, o.country_code, cl.name, cl.short_code,
                    pu.full_name, tm.name,
                    s.round_number, d.dive_code, d.position, d.dd,
                    e.number_of_judges, e.event_type
           ORDER BY u.full_name ASC, u.id ASC, s.round_number ASC`,
          [req.params.id],
        ),
      ]);
      if (!evRes.rows.length) return res.status(404).json({ error: "Event not found" });
      const event = evRes.rows[0];
      const slug = (event.name || "event").toLowerCase()
        .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_results.csv"`);

      // Compute final placings up front so the CSV's per-dive rows
      // can carry both the dive total and the diver's final rank.
      // Keyed by competitor_id (not full_name) so two same-named
      // divers don't collide; World Aquatics tie-break applied via dives_desc.
      const totalsRes = await pool.query(
        `WITH per_dive AS (
           SELECT s.competitor_id,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score        ORDER BY ej.judge_number),
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
           WHERE s.event_id = $1
           GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
         ),
         totals AS (
           SELECT competitor_id, SUM(pts)::numeric(8,2) AS total,
                  array_agg(pts ORDER BY pts DESC) AS dives_desc
           FROM per_dive GROUP BY competitor_id
         )
         SELECT u.id AS competitor_id, u.full_name AS diver_name,
                t.total,
                RANK() OVER (ORDER BY t.total DESC, t.dives_desc DESC) AS final_rank
         FROM totals t
         JOIN users u ON u.id = t.competitor_id`,
        [req.params.id],
      );
      const placingById = new Map(
        totalsRes.rows.map((r) => [r.competitor_id, { total: r.total, rank: r.final_rank }]),
      );

      res.write(csvRow([
        "diver_name", "country", "club_name", "club_code",
        "partner_name", "team_name",
        "round", "dive_code", "position", "dd",
        "judge_scores", "dive_total",
        "final_total", "final_rank",
      ]));
      for (const r of divesRes.rows) {
        const placing = placingById.get(r.competitor_id) || {};
        res.write(csvRow([
          r.diver_name, r.country_code,
          r.club_name, r.club_code,
          r.partner_name, r.team_name,
          r.round_number, r.dive_code, r.position, r.dd,
          r.judge_scores, r.dive_total,
          placing.total, placing.rank,
        ]));
      }
      res.end();
    } catch (err) {
      console.error("[Results CSV Error]", err.message);
      res.status(500).json({ error: "Internal server error" });
    }
  });

  // -------------------------------------------------------------
  // RESULTS PDF — final standings + dive-by-dive grouped by
  // diver. Synchro events regroup the judge chips into A / B /
  // Sync sub-panels so the printed page matches the on-screen
  // layout the audience saw.
  // -------------------------------------------------------------
  router.get("/api/events/:id/results.pdf", async (req, res) => {
    try {
      const [ev, standings, dives] = await Promise.all([
        pool.query(
          "SELECT e.name, e.gender, e.height, e.total_rounds, e.number_of_judges, e.event_type, o.name AS org_name FROM events e JOIN organisations o ON e.org_id = o.id WHERE e.id = $1",
          [req.params.id],
        ),
        pool.query(
          `WITH per_dive AS (
             SELECT s.competitor_id, s.round_number,
                    calc_event_dive_points(
                      array_agg(ej.judge_number ORDER BY ej.judge_number),
                      array_agg(s.score ORDER BY ej.judge_number),
                      e.number_of_judges, MAX(d.dd), e.event_type,
                    BOOL_OR(cdl.partner_id IS NOT NULL)
    ) AS dive_points
             FROM scores s
             JOIN events e ON e.id = s.event_id
             LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
             LEFT JOIN competitor_dive_lists cdl
               ON cdl.event_id = s.event_id
              AND cdl.competitor_id = s.competitor_id
              AND cdl.round_number = s.round_number
             LEFT JOIN dive_directory d ON d.id = COALESCE(s.dive_id, cdl.dive_id)
             WHERE s.event_id = $1
             GROUP BY s.competitor_id, s.round_number, e.number_of_judges, e.event_type
           )
           /* Group by u.id (not u.full_name) so two divers with the
              same full name don't collapse into one row with summed
              totals. Prior versions of this query merged "Sarah
              Williams" + "Sarah Williams" into a single PDF line
              with double points. */
           SELECT u.full_name, o.country_code, cl.name AS club_name,
                  pu.full_name AS partner_name,
                  SUM(pd.dive_points) AS total,
                  array_agg(pd.dive_points ORDER BY pd.dive_points DESC) AS dives_desc
           FROM per_dive pd
           JOIN users u ON u.id = pd.competitor_id
           JOIN organisations o ON o.id = u.org_id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           LEFT JOIN LATERAL (
             SELECT DISTINCT cdl.partner_id FROM competitor_dive_lists cdl
             WHERE cdl.event_id = $1 AND cdl.competitor_id = pd.competitor_id
               AND cdl.partner_id IS NOT NULL LIMIT 1
           ) p ON true
           LEFT JOIN users pu ON pu.id = p.partner_id
           GROUP BY u.id, u.full_name, o.country_code, cl.name, pu.full_name
           /* World Aquatics tie-break: highest single dive, then second-
              highest, etc. Element-wise array DESC ordering. */
           ORDER BY total DESC, dives_desc DESC`,
          [req.params.id],
        ),
        pool.query(
          /* Group by u.id (not u.full_name). The PDF renders "Dive
             Results" grouped by diver — without the id, two divers
             with the same name merged into a single section with
             inflated dive totals. STRING_AGG also now orders by
             judge_number, not judge_id (UUID), so the chip order on
             the page matches the panel order. */
          `SELECT u.id AS competitor_id, u.full_name, cl.name AS club_name,
                  pu.full_name AS partner_name,
                  s.round_number, d.dive_code, d.position, d.dd,
                  calc_event_dive_points(
                    array_agg(ej.judge_number ORDER BY ej.judge_number),
                    array_agg(s.score ORDER BY ej.judge_number),
                    e.number_of_judges, d.dd, e.event_type,
                  BOOL_OR(cdl.partner_id IS NOT NULL)
    ) AS total_dive_score,
                  STRING_AGG(s.score::text, ', ' ORDER BY ej.judge_number) AS judge_scores
           FROM scores s
           JOIN events e ON e.id = s.event_id
           JOIN users u ON s.competitor_id = u.id
           LEFT JOIN clubs cl ON cl.id = u.club_id
           LEFT JOIN event_judges ej ON ej.event_id = s.event_id AND ej.judge_id = s.judge_id
           LEFT JOIN competitor_dive_lists cdl ON s.competitor_id = cdl.competitor_id AND s.event_id = cdl.event_id AND s.round_number = cdl.round_number
           LEFT JOIN dive_directory d ON COALESCE(s.dive_id, cdl.dive_id) = d.id
           LEFT JOIN users pu ON pu.id = cdl.partner_id
           WHERE s.event_id = $1
           GROUP BY u.id, u.full_name, cl.name, pu.full_name,
                    s.round_number, d.dive_code, d.position, d.dd,
                    e.number_of_judges, e.event_type
           ORDER BY u.full_name ASC, u.id ASC, s.round_number ASC`,
          [req.params.id],
        ),
      ]);

      if (!ev.rows.length) return res.status(404).json({ error: "Event not found" });
      const event = ev.rows[0];
      const slug = event.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

      const doc = new PDFDocument({ margin: 50, size: "A4" });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${slug}_results.pdf"`);
      doc.pipe(res);

      // Header
      doc.fontSize(20).font("Helvetica-Bold").text("DIVE RECORDER", { align: "center" });
      doc.fontSize(10).font("Helvetica").text(event.org_name, { align: "center" });
      doc.moveDown(0.5);
      doc.fontSize(16).font("Helvetica-Bold").text(event.name, { align: "center" });
      const meta = [event.gender, event.height, `${event.total_rounds} rounds`, `${event.number_of_judges} judges`].filter(Boolean).join("  ·  ");
      doc.fontSize(9).font("Helvetica").fillColor("#666").text(meta, { align: "center" });
      doc.fillColor("#000").moveDown(1);

      // Standings
      doc.fontSize(13).font("Helvetica-Bold").text("Final Standings");
      doc.moveDown(0.3);
      standings.rows.forEach((row, i) => {
        const rank = i + 1;
        const total = Number(row.total).toFixed(2);
        doc.fontSize(10).font(rank <= 3 ? "Helvetica-Bold" : "Helvetica")
          .text(`${rank}.  ${row.full_name}${row.country_code ? "  " + row.country_code : ""}`, 50, doc.y, { continued: true, width: 350 })
          .font("Helvetica-Bold").text(total, { align: "right" });
        if (row.club_name) {
          doc.fontSize(8).font("Helvetica").fillColor("#666")
            .text(`     ${row.club_name}`, 50);
          doc.fillColor("#000");
        }
      });
      doc.moveDown(1);

      // Dive-by-dive breakdown
      doc.fontSize(13).font("Helvetica-Bold").text("Dive Results");
      doc.moveDown(0.3);

      // Group rows by competitor_id (not full_name) so two divers
      // with the same name don't collapse into one section. The
      // section header still shows full_name for readability.
      const byDiver = new Map();
      dives.rows.forEach((row) => {
        const key = row.competitor_id;
        if (!byDiver.has(key)) {
          byDiver.set(key, {
            name: row.full_name,
            club: row.club_name || null,
            rows: [],
          });
        }
        byDiver.get(key).rows.push(row);
      });

      // For synchro events, regroup judge scores into A / B / Sync
      // blocks so the PDF reflects the same grouping the web UI does.
      const isSynchro = event.event_type === "synchro_pair";
      const numJudges = event.number_of_judges;
      const formatSynchroScores = (scoresStr) => {
        const parts = (scoresStr || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        if (numJudges === 9 && parts.length === 9) {
          return `A: ${parts.slice(0, 2).join(",")}  B: ${parts.slice(2, 4).join(",")}  Sync: ${parts.slice(4, 9).join(",")}`;
        }
        if (numJudges === 11 && parts.length === 11) {
          return `A: ${parts.slice(0, 3).join(",")}  B: ${parts.slice(3, 6).join(",")}  Sync: ${parts.slice(6, 11).join(",")}`;
        }
        return scoresStr;
      };

      for (const [, group] of byDiver) {
        if (doc.y > 680) doc.addPage();
        doc.fontSize(11).font("Helvetica-Bold").fillColor("#000").text(group.name);
        if (group.club) {
          doc.fontSize(9).font("Helvetica").fillColor("#666").text(group.club);
          doc.fillColor("#000");
        }
        group.rows.forEach((r) => {
          const code = [r.dive_code, r.position].filter(Boolean).join(" ");
          const dd = r.dd ? `DD ${Number(r.dd).toFixed(1)}` : "";
          const scores = isSynchro
            ? formatSynchroScores(r.judge_scores)
            : (r.judge_scores || "");
          const total = Number(r.total_dive_score).toFixed(2);
          doc.fontSize(9).font("Helvetica")
            .text(`  R${r.round_number}  ${code}  ${dd}    Judges: ${scores}    Total: ${total}`);
        });
        doc.moveDown(0.5);
      }

      doc.end();
    } catch (err) {
      console.error("[PDF Error]", err.message);
      if (!res.headersSent) res.status(500).json({ error: "Failed to generate PDF" });
    }
  });

  return router;
};
