// useDiverIdentity — normalises the many ways a "diver row"
// surfaces across the API (roster row, history row, standings
// row, scoreboard upcoming row, completed-dive recap row…) into
// a single shape the SPA renders consistently. Every place that
// shows "person + affiliation" — Control Room history cards,
// Up Next tiles, Dive Order roster, the Scoreboard's Completed
// Dives + Standings + Up Next — reads the SAME derived fields
// so a layout tweak only has to land in one component.
//
// Returned shape:
//   {
//     leadName,       // primary diver name (always present)
//     partnerName,    // synchro partner's name, or null
//     badge,          // lead's affiliation chip text:
//                     //   country_code → team_code → club_code
//                     // first non-null wins. null when none set.
//     partnerBadge,   // partner's affiliation chip — populated
//                     // ONLY for synchro pairs whose partner has
//                     // a different country / club from the lead
//                     // (e.g. an international synchro pairing).
//                     // null when same as the lead so the
//                     // template doesn't render a duplicate chip.
//     secondary,      // optional secondary line under the names:
//                     //   team_name → club_name (never both)
//                     // null for synchro pairs because the
//                     // partner already occupies that slot.
//   }
//
// Pure data extraction — no side effects. Safe to call from a
// computed without binding to component lifetime.

export function diverIdentity(row) {
  if (!row) {
    return {
      leadName: '', partnerName: null,
      badge: null, partnerBadge: null,
      secondary: null,
    }
  }
  // The lead's name surfaces under three different keys depending
  // on the call site:
  //   full_name      — roster + history + standings rows
  //   name           — Control Room's local history-card shape
  //                    (built by addHistoryCard)
  //   diverName      — Control Room's currentActive shape (the
  //                    set_active_diver socket payload)
  // Coalesce so consumers don't have to know which API gave
  // them the row.
  const leadName = row.full_name || row.name || row.diverName || ''
  const partnerName = row.partner_name || null

  // Affiliation chip fallback chain — country wins because most
  // events are international, then team_code (relevant in team
  // events), then club_code (used by club-only meets).
  const badge =
    row.country_code ||
    row.team_code ||
    row.club_code ||
    null

  // Partner's affiliation. The API exposes partner_country today;
  // partner_club_code is exposed where available too (history +
  // roster rows). For team events we don't show a partner chip
  // because both divers share the same team_code already pinned
  // as the lead's chip — would just be a duplicate.
  const partnerAffiliation = partnerName
    ? (row.partner_country || row.partner_club_code || null)
    : null
  // Only surface the partner chip when it actually differs from
  // the lead's (international synchro pair, or two divers from
  // different clubs in a club-only meet). Same chip on both
  // names is redundant — let the single chip carry both.
  const partnerBadge =
    partnerAffiliation && partnerAffiliation !== badge
      ? partnerAffiliation
      : null

  // Secondary line — only one ever, never duplicated. Synchro
  // pairs skip this entirely because the partner already takes
  // the second visual line beneath the lead's name.
  const secondary = partnerName
    ? null
    : (row.team_name || row.club_name || null)

  return { leadName, partnerName, badge, partnerBadge, secondary }
}
