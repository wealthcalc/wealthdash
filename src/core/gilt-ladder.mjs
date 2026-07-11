/* ======================================================================
   GILT LADDER BUILDER — pure and node-tested (gilt-ladder.test.mjs).

   `gilts.mjs`'s `giltAnalytics()` already projects every held gilt's
   future cashflows (coupons + redemption) and returns them pooled and
   date-sorted as `cashflows`. The Gilts tab's "Gilt ladder" label was
   previously just cosmetic — the sum of holdings, sorted by maturity, with
   no actual matching against a spending need. This module does the actual
   matching: given those projected cashflows and a flat target annual
   income need, it groups cashflows by calendar year and reports, year by
   year, whether the ladder covers the need, and by how much it falls short
   or overshoots.

   Deliberately scoped to gilts the user ALREADY holds (see gilts.mjs's
   header — there's no browsable universe of every UK gilt in this app to
   suggest NEW purchases from; DMO's daily report only covers registered
   ISINs). This is "does my existing ladder cover my needs, year by year",
   not "here's what to buy" — an honest boundary given what data exists.
   ====================================================================== */

// Group cashflows by calendar year (from each flow's `date`), summing
// coupon + redemption amounts landing in that year.
export function giltIncomeByYear(cashflows = []) {
  const byYear = {};
  for (const f of cashflows) {
    if (!f || !f.date || !Number.isFinite(+f.amount)) continue;
    const y = +f.date.slice(0, 4);
    byYear[y] = (byYear[y] || 0) + f.amount;
  }
  return byYear;
}

// Build the year-by-year ladder-vs-need table from `fromYear` (inclusive)
// to `toYear` (inclusive). `targetAnnual` is a flat £/yr income need (no
// inflation uprating — the ladder itself is nominal, fixed-coupon cash,
// so comparing it to a flat nominal target is the honest like-for-like;
// the caller can pass an already-inflated target per year via
// `targetByYear` to override the flat figure for specific years).
export function buildGiltLadder({ cashflows = [], targetAnnual = 0, fromYear, toYear, targetByYear = {} } = {}) {
  const byYear = giltIncomeByYear(cashflows);
  const years = Object.keys(byYear).map(Number);
  const from = fromYear ?? (years.length ? Math.min(...years) : new Date().getUTCFullYear());
  const to = toYear ?? (years.length ? Math.max(...years) : from);

  const rows = [];
  let totalGiltIncome = 0, totalShortfall = 0, yearsFullyCovered = 0;
  let firstGapYear = null;
  for (let y = from; y <= to; y++) {
    const giltIncome = byYear[y] || 0;
    const target = targetByYear[y] ?? targetAnnual;
    const surplus = giltIncome - target;
    const covered = target <= 0 || giltIncome >= target;
    if (covered) yearsFullyCovered++;
    else if (firstGapYear === null) firstGapYear = y;
    totalGiltIncome += giltIncome;
    totalShortfall += Math.max(0, -surplus);
    rows.push({
      year: y, giltIncome, target,
      coverage: target > 0 ? Math.min(1, giltIncome / target) : 1,
      surplus, covered,
    });
  }

  return {
    rows,
    fromYear: from, toYear: to,
    totalGiltIncome, totalShortfall, yearsFullyCovered,
    totalYears: rows.length,
    firstGapYear,
    fullyCovered: firstGapYear === null && rows.length > 0,
  };
}
