// Round-rules validator + helpers.
//
// Models the FINA / Diving Australia "voluntary + optional"
// dive-sheet structure that real youth meets use:
//
//   "4 dives @ 7.6 + 4 dives unlimited" (8 rounds total)
//        └─ sum DD ≤ 7.6 across these 4 rounds, each from a
//           different group
//                              └─ no DD cap, but each from a
//                                 different group
//
// `events.round_rules` is a JSON column (migration 038) shaped:
//
//   {
//     "sections": [
//       { "label": "Voluntary",  "rounds": 4, "dd_limit": 7.6,
//         "require_different_groups": true },
//       { "label": "Optional",   "rounds": 4, "dd_limit": null,
//         "require_different_groups": true }
//     ]
//   }
//
// NULL round_rules → legacy (dd_limit_rounds + dd_limit_value)
// behaviour, validated separately. Populated → run through
// validateDiveList here.
//
// Functions exported:
//   * groupForDiveCode(code)  — 'forward' | 'back' | 'reverse'
//                               | 'inward' | 'twist' | 'armstand'
//   * validateRoundRules(rr, totalRounds) — sanity-check the
//     rules themselves; returns {valid, error?}
//   * validateDiveList(rr, dives, dives_dd_by_round) — check a
//     diver's submitted list; returns {valid, errors[]}.

const GROUPS = {
  "1": "forward",
  "2": "back",
  "3": "reverse",
  "4": "inward",
  "5": "twist",
  "6": "armstand",
};

const GROUP_LABELS = {
  forward:  "Forward",
  back:     "Back",
  reverse:  "Reverse",
  inward:   "Inward",
  twist:    "Twist",
  armstand: "Armstand",
};

// Pull the leading digit off a dive_code and map to a group
// name. Returns null on a code with a non-digit prefix or an
// out-of-range first digit.
function groupForDiveCode(code) {
  if (typeof code !== "string" || !code.length) return null;
  const c = code[0];
  return GROUPS[c] || null;
}

// Sanity-check the rule shape itself. Catch the operator
// mis-configuring the event before any diver hits a confusing
// validation error during list submission.
function validateRoundRules(rr, totalRounds) {
  if (rr == null) return { valid: true };
  if (typeof rr !== "object" || !Array.isArray(rr.sections)) {
    return { valid: false, error: "round_rules must be { sections: [...] }" };
  }
  if (!rr.sections.length) {
    return { valid: false, error: "round_rules.sections must not be empty" };
  }
  let total = 0;
  for (let i = 0; i < rr.sections.length; i++) {
    const s = rr.sections[i];
    if (!s || typeof s !== "object") {
      return { valid: false, error: `Section ${i + 1}: not an object` };
    }
    if (!Number.isInteger(s.rounds) || s.rounds < 1) {
      return { valid: false, error: `Section ${i + 1}: rounds must be a positive integer` };
    }
    if (s.dd_limit != null) {
      const dd = Number(s.dd_limit);
      if (!Number.isFinite(dd) || dd <= 0 || dd > 50) {
        return { valid: false, error: `Section ${i + 1}: dd_limit must be a positive number ≤ 50` };
      }
    }
    if (s.label != null && typeof s.label !== "string") {
      return { valid: false, error: `Section ${i + 1}: label must be a string` };
    }
    if (s.require_different_groups != null
        && typeof s.require_different_groups !== "boolean") {
      return { valid: false, error: `Section ${i + 1}: require_different_groups must be a boolean` };
    }
    total += s.rounds;
  }
  if (totalRounds != null && total !== totalRounds) {
    return {
      valid: false,
      error: `Section round counts sum to ${total}, but the event has total_rounds = ${totalRounds}`,
    };
  }
  return { valid: true };
}

// Map round_number → section index. Returns -1 when the round
// falls outside any section (over-the-end roster).
function sectionForRound(rr, roundNumber) {
  let cursor = 0;
  for (let i = 0; i < rr.sections.length; i++) {
    cursor += rr.sections[i].rounds;
    if (roundNumber <= cursor) return i;
  }
  return -1;
}

/**
 * Validate a diver's submitted dive list against the event's
 * round_rules.
 *
 * @param {object|null} rr        — the rules object (NULL = no
 *                                   structured rules; pass the
 *                                   legacy validator separately)
 * @param {Array}       dives     — { round_number, dive_id, dd,
 *                                   dive_code } per round
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateDiveList(rr, dives) {
  if (rr == null) return { valid: true, errors: [] };
  const ruleCheck = validateRoundRules(rr);
  if (!ruleCheck.valid) {
    return { valid: false, errors: [`Event rules misconfigured: ${ruleCheck.error}`] };
  }

  const errors = [];

  // Bucket dives by section index based on round_number.
  const byRound = new Map();
  for (const d of dives) byRound.set(Number(d.round_number), d);

  for (let i = 0; i < rr.sections.length; i++) {
    const section = rr.sections[i];
    const label = section.label || `Section ${i + 1}`;
    // Find rounds that belong to this section.
    let cursorStart = 0;
    for (let k = 0; k < i; k++) cursorStart += rr.sections[k].rounds;
    const sectionDives = [];
    for (let r = 1; r <= section.rounds; r++) {
      const round = cursorStart + r;
      const d = byRound.get(round);
      if (d) sectionDives.push({ ...d, _round: round });
    }
    if (sectionDives.length < section.rounds) {
      errors.push(
        `${label}: ${sectionDives.length} of ${section.rounds} dives submitted`,
      );
      // Continue with the rules we CAN check on the rounds the
      // diver has so far — the operator might be staging a
      // partial save in a future flow.
    }

    // DD-sum constraint.
    if (section.dd_limit != null) {
      let sum = 0;
      for (const d of sectionDives) {
        const dd = Number(d.dd);
        if (Number.isFinite(dd)) sum += dd;
      }
      // 0.001 tolerance — DDs are stored as numeric(3,1) so the
      // sum should be exact, but defensive against bigint /
      // string cast quirks.
      if (sum > section.dd_limit + 0.001) {
        errors.push(
          `${label}: total DD ${sum.toFixed(1)} exceeds the ${section.dd_limit.toFixed(1)} limit`,
        );
      }
    }

    // "Different groups" constraint.
    if (section.require_different_groups) {
      const seen = new Map();   // group → first round_number we saw it
      for (const d of sectionDives) {
        const g = groupForDiveCode(d.dive_code);
        if (!g) continue;        // bad code — skip; the dive_id
                                 // existence check elsewhere will
                                 // reject invalid codes
        if (seen.has(g)) {
          errors.push(
            `${label}: round ${d._round} repeats the ${GROUP_LABELS[g]} group (already used in round ${seen.get(g)})`,
          );
        } else {
          seen.set(g, d._round);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// Convenience wrapper for callers that just want a yes/no.
function isDiveListValid(rr, dives) {
  return validateDiveList(rr, dives).valid;
}

module.exports = {
  GROUPS,
  GROUP_LABELS,
  groupForDiveCode,
  sectionForRound,
  validateRoundRules,
  validateDiveList,
  isDiveListValid,
};
