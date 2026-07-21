/* ======================================================================
   PLAN vs ACTUAL — "am I on track?", which is the question the whole app
   exists to answer and the one it has never asked.

   The pieces already existed and were never joined: daily household
   net-worth snapshots (net-worth-series.mjs) and a deterministic
   projection (drawdown.mjs's timeline). This compares them.

   THE COMPARABILITY PROBLEM, which is why this is a module and not three
   lines in a component:

   1. DIFFERENT QUANTITIES. The projection's `potNominal` is INVESTABLE
      wealth — pension + ISA + GIA + LISA. Household net worth also
      includes property equity, private holdings, RSUs and deferred cash,
      minus mortgages and other debt. Comparing the two directly would
      show a permanent, meaningless "ahead of plan" the size of your
      house. So the caller must supply the investable component of each
      snapshot, and this module refuses to guess.

   2. DIFFERENT TIME AXES. The projection is indexed by AGE, snapshots by
      DATE. Anchoring requires knowing which calendar date corresponds to
      `currentAge`; that's the plan's own start, i.e. today when the plan
      was last recomputed. Passed in explicitly.

   3. THE PLAN MOVES. Edit a contribution and the whole projected path
      shifts, so "behind plan" can mean "the plan got more ambitious"
      rather than "I saved less". This is disclosed, not solved — there
      is no honest way to detect it without versioning every plan edit,
      and a wrong attribution would be worse than none.

   Real vs nominal: comparison happens in NOMINAL £, because snapshots are
   nominal and deflating them would require assuming the inflation path
   actually experienced rather than the one the plan assumed.

   Pure and node-tested (plan-tracking.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const yearOf = (iso) => +String(iso || "").slice(0, 4);

// Linear interpolation of the projected pot at a fractional age — the
// projection has one row per year, snapshots land mid-year, and stepping
// to the nearest row would create a sawtooth in the variance that looks
// like real volatility.
export function projectedAt(timeline, age) {
  if (!Array.isArray(timeline) || !timeline.length) return null;
  const first = timeline[0], last = timeline[timeline.length - 1];
  if (age <= first.age) return first.potNominal;
  if (age >= last.age) return last.potNominal;
  for (let i = 0; i < timeline.length - 1; i++) {
    const a = timeline[i], b = timeline[i + 1];
    if (age >= a.age && age <= b.age) {
      const t = (age - a.age) / (b.age - a.age || 1);
      return a.potNominal + (b.potNominal - a.potNominal) * t;
    }
  }
  return last.potNominal;
}

// snapshots: [{ date, investable }] — the INVESTABLE component only (see
//   header note 1). The caller derives it; this module won't guess.
// timeline: buildProjection().timeline
// anchorDate / currentAge: the calendar date at which the plan's
//   `currentAge` applies.
export function trackPlan({ snapshots = [], timeline = [], anchorDate, currentAge, minPoints = 2 } = {}) {
  if (!anchorDate || !Number.isFinite(currentAge)) {
    throw new Error("trackPlan requires anchorDate and currentAge — the projection is age-indexed and snapshots are date-indexed.");
  }
  if (!timeline.length) return { rows: [], summary: null };

  const anchorMs = Date.parse(anchorDate);
  const rows = [];
  for (const s of snapshots) {
    // `investable == null` must be rejected BEFORE the finite check:
    // +null is 0, which is finite, so a missing value would otherwise be
    // silently read as "net worth of zero" — the worst possible default.
    if (!s || !s.date || s.investable == null || !Number.isFinite(+s.investable)) continue;
    const ms = Date.parse(s.date);
    if (!Number.isFinite(ms)) continue;
    const age = currentAge + (ms - anchorMs) / (365.25 * 86400000);
    const projected = projectedAt(timeline, age);
    if (projected == null) continue;
    const actual = +s.investable;
    rows.push({
      date: s.date, age: Math.round(age * 100) / 100,
      actual: r2(actual), projected: r2(projected),
      variance: r2(actual - projected),
      variancePct: projected > 0 ? r2(((actual - projected) / projected) * 100) : null,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : 1));
  if (rows.length < minPoints) {
    return { rows, summary: null, reason: `only ${rows.length} comparable snapshot(s) — needs ${minPoints}+` };
  }

  const latest = rows[rows.length - 1];
  const first = rows[0];
  // Is the gap widening or closing? Compared as a PERCENTAGE, since an
  // absolute gap naturally grows with the pot even when tracking is
  // perfect.
  const trend = latest.variancePct != null && first.variancePct != null
    ? r2(latest.variancePct - first.variancePct)
    : null;
  return {
    rows,
    summary: {
      latest,
      spanDays: Math.round((Date.parse(latest.date) - Date.parse(first.date)) / 86400000),
      points: rows.length,
      trendPct: trend,
      // "On track" is a band, not a point: a projection carrying growth,
      // inflation and contribution assumptions is not accurate to the
      // pound, and flagging a 2% gap as failure would train the user to
      // ignore the signal.
      onTrack: latest.variancePct != null && Math.abs(latest.variancePct) <= 10,
      ahead: latest.variance > 0,
      yearsTracked: r2((Date.parse(latest.date) - Date.parse(first.date)) / (365.25 * 86400000)),
      startYear: yearOf(first.date),
    },
  };
}
