// Helpers for rendering per-judge scores as colour-coded chips.
// Used by the Scoreboard and Archive views — keep them in sync so
// dive breakdowns look identical wherever they appear.

// FINA judge score categories. Each maps to a colour class in
// public/css/app.css (.j-failed, .j-deficient, etc).
export function scoreCategory(s) {
  if (s == null || Number.isNaN(s)) return null
  if (s === 0)   return 'failed'
  if (s <= 2.0)  return 'deficient'
  if (s <= 4.5)  return 'unsatisfactory'
  if (s <= 6.0)  return 'satisfactory'
  if (s <= 8.0)  return 'good'
  if (s <= 9.5)  return 'very-good'
  return 'excellent'   // 10
}

// Standard FINA trim rules for an individual diving panel:
//   3 judges  → keep all
//   5 judges  → drop high + low
//   7 judges  → drop 2 high + 2 low
//   9 judges  → drop 2 high + 2 low
//  11 judges  → drop 3 high + 3 low
export function trimCount(numJudges) {
  if (!numJudges || numJudges <= 3) return 0
  if (numJudges === 5)  return 1
  if (numJudges === 7)  return 2
  if (numJudges === 9)  return 2
  if (numJudges === 11) return 3
  return 0
}

// Parses a comma-separated score string and annotates each value
// with its category and whether the trim rule would drop it.
// Ties are broken by original index, matching how the lowest
// judge id is treated as the "first" of a tied pair.
export function annotatedScores(scoresStr, numJudges) {
  const values = (scoresStr || '')
    .split(',')
    .map(s => parseFloat(s))
    .filter(n => !Number.isNaN(n))
  const drop = trimCount(numJudges)
  const dropped = new Set()
  if (drop > 0 && values.length > drop * 2) {
    const indexed = values.map((v, i) => ({ v, i }))
    indexed.sort((a, b) => a.v - b.v || a.i - b.i)
    indexed.slice(0, drop).forEach(x => dropped.add(x.i))
    indexed.slice(indexed.length - drop).forEach(x => dropped.add(x.i))
  }
  return values.map((v, i) => ({
    value: v,
    dropped: dropped.has(i),
    category: scoreCategory(v),
  }))
}
