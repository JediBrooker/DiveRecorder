// Shared dive-list submission helper.
//
// Extracted from routes/competitor.js so the diver-self path
// (POST /api/competitor/submit-list) and the coach-on-behalf-of
// path (POST /api/coach/dive-lists/:diver_id) can share every
// validation + the same UPSERT. Without the extraction, the
// coach endpoint would either duplicate ~150 lines of validation
// or silently skip some of it.
//
// Shape:
//   await submitDiveList({
//     client,       // pg client INSIDE a transaction (caller owns BEGIN/COMMIT)
//     event,        // row from loadEventForEntries(...).event
//     actor,        // { id, org_id, is_system_admin } — who is hitting the endpoint
//     competitorId, // who the list is FOR (=actor.id for self-submit, =linked diver for coach)
//     competitorOrgId, // the competitor's own org (used for participating-orgs check)
//     partnerId,    // optional synchro partner user id
//     dives,        // [{ dive_id, round_number }]
//   })
//
// Returns: { ok: true }
// Throws:  Error with .status (HTTP code) and optionally .violations.
//
// The caller is responsible for the transaction boundary AND for
// emitting the audit log entry (which differs between paths —
// the coach path includes "coach_id" extra context).
//
// Resubmit semantics: BEFORE the UPSERT loop we DELETE any
// non-withdrawn rows for this (event, competitor) whose
// round_number is NOT in the new `dives` array. So if a previously-
// submitted round isn't in the new list it gets removed —
// otherwise re-submitting with fewer rounds left ghost rounds
// behind that the operator would still see in the live queue.
// Withdrawn rows (withdrawn_at IS NOT NULL) are preserved — the
// withdraw flow already marks them and we don't want to silently
// un-withdraw on resubmit.

module.exports = async function submitDiveList({
  client,
  event,
  actor,
  competitorId,
  competitorOrgId,
  partnerId,
  dives,
}) {
  if (!client) throw httpErr(500, "submitDiveList: client required");
  if (!event)  throw httpErr(400, "submitDiveList: event required");
  if (!competitorId) throw httpErr(400, "submitDiveList: competitor required");

  // Multi-federation entry gate. The event's host org is always
  // allowed; a sysadmin can act anywhere; otherwise the
  // competitor's org must be on the participating list.
  if (event.org_id !== competitorOrgId && !actor.is_system_admin) {
    const part = await client.query(
      `SELECT 1 FROM event_participating_orgs
        WHERE event_id = $1 AND org_id = $2`,
      [event.id, competitorOrgId],
    );
    if (!part.rows.length) {
      throw httpErr(403, "Your federation isn't on this event's participating list");
    }
  }
  const eventType = event.event_type || "individual";
  const totalRounds = Number(event.total_rounds) || null;

  // Sanity-check the dives array — must be a non-empty list of
  // {dive_id, round_number} with no duplicate rounds and round
  // numbers within range.
  if (!Array.isArray(dives) || !dives.length) {
    throw httpErr(400, "dives must be a non-empty array");
  }
  const seenRounds = new Set();
  for (const d of dives) {
    const rn = Number(d?.round_number);
    if (!Number.isInteger(rn) || rn < 1) {
      throw httpErr(400, "Each dive needs an integer round_number ≥ 1");
    }
    if (totalRounds && rn > totalRounds) {
      throw httpErr(400, `round_number ${rn} exceeds total_rounds ${totalRounds}`);
    }
    if (seenRounds.has(rn)) {
      throw httpErr(400, `Duplicate round_number ${rn}`);
    }
    seenRounds.add(rn);
    if (!d.dive_id) {
      throw httpErr(400, "Each dive needs a dive_id");
    }
  }

  // Validate every dive_id against the directory at the event's
  // height. Pulls dive_code + dd so the round-rules validator
  // can compute group + DD-sum below.
  const ids = dives.map(d => d.dive_id);
  const heightVal = event.height ? parseFloat(event.height) : null;
  const validIds = await client.query(
    `SELECT id, dive_code, dd, height FROM dive_directory
     WHERE id = ANY($1::uuid[])
       AND ($2::numeric IS NULL OR height = $2)`,
    [ids, heightVal],
  );
  const okMap = new Map(validIds.rows.map(r => [r.id, r]));
  for (const d of dives) {
    if (!okMap.has(d.dive_id)) {
      throw httpErr(400, `dive_id ${d.dive_id} is not in the dive directory at this event's height`);
    }
  }

  // Prescribed round dives (migration 039).
  const prescribed = await client.query(
    `SELECT round_number, dive_id, height
       FROM event_round_dives
      WHERE event_id = $1`,
    [event.id],
  );
  if (prescribed.rows.length) {
    const byRound = new Map();
    for (const slot of prescribed.rows) byRound.set(slot.round_number, slot);
    const violations = [];
    for (const d of dives) {
      const slot = byRound.get(d.round_number);
      if (!slot) continue;
      if (slot.dive_id && slot.dive_id !== d.dive_id) {
        violations.push(`Round ${d.round_number} is operator-prescribed; submit the assigned dive only`);
        continue;
      }
      if (!slot.dive_id && slot.height != null) {
        const dir = okMap.get(d.dive_id);
        if (dir && Number(dir.height) !== Number(slot.height)) {
          violations.push(`Round ${d.round_number} requires a ${slot.height}m board dive`);
        }
      }
    }
    if (violations.length) {
      const err = httpErr(400, "Dive list violates the event's prescribed dives");
      err.violations = violations;
      throw err;
    }
  }

  // Round-rules validation (migration 038).
  if (event.round_rules) {
    const { validateDiveList } = require("./round-rules");
    const enriched = dives.map(d => {
      const dir = okMap.get(d.dive_id);
      return {
        round_number: d.round_number,
        dive_id:      d.dive_id,
        dive_code:    dir?.dive_code,
        dd:           dir?.dd,
      };
    });
    const check = validateDiveList(event.round_rules, enriched);
    if (!check.valid) {
      const err = httpErr(400, "Dive list violates the event's round rules");
      err.violations = check.errors;
      throw err;
    }
  }

  // Synchro partner validation. Partner can come from any
  // federation that's been opted onto the event.
  let resolvedPartnerId = null;
  if (eventType === "synchro_pair") {
    if (!partnerId || partnerId === competitorId) {
      throw httpErr(400, "A different partner is required for synchronised events");
    }
    const p = await client.query(
      `SELECT u.id FROM users u
       JOIN user_org_roles r ON r.user_id = u.id AND r.org_id = u.org_id AND r.role = 'diver'
       WHERE u.id = $1 AND u.org_id IN (
               SELECT org_id FROM events WHERE id = $2
               UNION
               SELECT org_id FROM event_participating_orgs WHERE event_id = $2
             )`,
      [partnerId, event.id],
    );
    if (!p.rows.length) {
      throw httpErr(400, "Partner must be a diver in a federation that's eligible to enter this event");
    }
    resolvedPartnerId = partnerId;
  }

  // Clear stale rounds. If a previous submission had R1..R6 and
  // the diver now submits R1..R5, R6 would linger as a ghost dive
  // in the operator's queue without this. We only delete rows
  // whose round_number isn't in the new array AND that aren't
  // already withdrawn — withdrawn rows stay marked so the audit
  // trail and operator banner survive the resubmit.
  const newRounds = dives.map((d) => Number(d.round_number));
  await client.query(
    `DELETE FROM competitor_dive_lists
      WHERE event_id      = $1
        AND competitor_id = $2
        AND withdrawn_at  IS NULL
        AND round_number  <> ALL($3::int[])`,
    [event.id, competitorId, newRounds],
  );

  // UPSERT each dive row. Migration 041: confirmed_at stamps when
  // the diver (or their coach, with this change) actively
  // submitted the list.
  for (const dive of dives) {
    await client.query(
      `INSERT INTO competitor_dive_lists
          (competitor_id, partner_id, event_id, dive_id, round_number, confirmed_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (event_id, competitor_id, round_number)
       DO UPDATE SET
          dive_id      = EXCLUDED.dive_id,
          partner_id   = EXCLUDED.partner_id,
          confirmed_at = NOW()`,
      [
        competitorId,
        resolvedPartnerId,
        event.id,
        dive.dive_id,
        dive.round_number,
      ],
    );
  }

  return { ok: true };
};

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
