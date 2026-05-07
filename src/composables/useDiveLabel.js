// Dive description / position helpers — every place in the SPA
// that shows a dive's human-readable description should go
// through these so the same dive looks the same everywhere.
//
// dive_directory.description holds only the action ("Forward
// Dive", "Back 2½ Somersaults", …) and dive_directory.position
// holds the FINA letter code (A/B/C/D). Audiences expect the
// position word ("Pike", "Tuck", …) appended — dive numbers
// don't mean anything to a casual viewer without it.

// FINA / World Aquatics position codes:
//   A = Straight   (legs locked, body fully extended)
//   B = Pike       (legs straight, hips bent)
//   C = Tuck       (knees + hips bent, body folded)
//   D = Free       (combination, common in twisting groups)
const POSITION_LABELS = {
  A: "Straight",
  B: "Pike",
  C: "Tuck",
  D: "Free",
};

export function positionLabel(position) {
  if (typeof position !== "string") return "";
  return POSITION_LABELS[position.trim().toUpperCase()] || "";
}

// Combine description + position into a single audience-readable
// string. Tolerant of either field being absent — returns the
// pieces it has rather than an empty string, so a partially
// loaded row doesn't render as blank.
//
// Examples:
//   { description: "Forward Dive",     position: "B" } → "Forward Dive Pike"
//   { description: "Back 2½ Somersaults", position: "C" } → "Back 2½ Somersaults Tuck"
//   { description: "Forward Dive",     position: null } → "Forward Dive"
//   { description: null,               position: "B" } → "Pike"
//   { description: null,               position: null } → ""
export function diveDescription(row) {
  if (!row) return "";
  const desc = (row.description || "").trim();
  const pos  = positionLabel(row.position);
  if (desc && pos) return `${desc} ${pos}`;
  return desc || pos;
}
