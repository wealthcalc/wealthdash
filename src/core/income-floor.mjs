/* ======================================================================
   GUARANTEED-INCOME FLOOR — for each retirement year, how much income
   arrives REGARDLESS of what markets do (State Pension + DB pension +
   annuity + the gilt ladder's contractual cashflows), stacked against
   the essential ("needs, not wants") share of target spending. The
   flooring question — "could I keep the lights on if the portfolio
   halved?" — is different from the Monte Carlo's "will the portfolio
   last?", and neither answers the other.

   Everything is expressed in TODAY'S £ (real), reusing the deterministic
   projection's own timeline rows (`stateReal`/`dbReal`/`annuityReal`,
   already deflated by the engine) so this module can never disagree with
   the Decumulation tab. Gilt cashflows arrive NOMINAL by calendar year
   (core/gilt-ladder.mjs's giltIncomeByYear) and are deflated here with
   the same effective inflation the projection used.

   Honesty decisions, stated once:
   - BTL rent is EXCLUDED from the floor. Voids, arrears and repairs make
     rental income contingent in exactly the way this view exists to
     screen out; it stays visible on the Buy-to-let tab.
   - Gilt cashflows include maturing principal, not just coupons — in a
     ladder, redemption proceeds ARE that year's spending money. They are
     also FINITE: the ladder runs out when the last gilt matures, and the
     chart should show that cliff, not smooth it.
   - Only gilts held today are counted. No assumed reinvestment.
   Pure and node-tested (income-floor.test.mjs).
   ====================================================================== */

import { effInflation } from "./drawdown.mjs";

// det: buildProjection() result (uses .timeline decum rows)
// p: plan inputs (currentAge, essentialPct via caller default)
// giltNominalByYear: { calendarYear: nominal £ } from giltIncomeByYear()
// currentYear: this calendar year (pure functions don't read the clock)
export function buildIncomeFloor({ det, p, giltNominalByYear = {}, currentYear, essentialPct = 65 } = {}) {
  if (!det || !Array.isArray(det.timeline) || !p) return { rows: [], summary: null };
  const infl = effInflation(p) / 100;
  const pct = Math.min(100, Math.max(0, +essentialPct || 0)) / 100;

  const rows = det.timeline
    .filter((r) => r.phase === "decum")
    .map((r) => {
      const elapsed = r.age - p.currentAge;
      const year = currentYear != null ? currentYear + elapsed : null;
      const giltNominal = year != null ? (giltNominalByYear[year] || 0) : 0;
      const gilt = giltNominal / Math.pow(1 + infl, Math.max(0, elapsed));
      const state = r.stateReal || 0, db = r.dbReal || 0, annuity = r.annuityReal || 0;
      const guaranteed = state + db + annuity + gilt;
      const essential = (r.spendReal || 0) * pct;
      return {
        age: r.age, year,
        state, db, annuity, gilt,
        guaranteed,
        essential,
        spend: r.spendReal || 0,
        coverage: essential > 0 ? guaranteed / essential : null,
        covered: essential > 0 ? guaranteed >= essential - 1e-9 : true,
      };
    });

  if (!rows.length) return { rows, summary: null };

  const coveredYears = rows.filter((r) => r.covered).length;
  const firstCovered = rows.find((r) => r.covered) || null;
  // "Permanently covered from": the first age after which EVERY later year
  // is covered (a gilt ladder can cover early years then run out — a
  // first-covered age alone would overstate the floor).
  let permanentFrom = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].covered) permanentFrom = rows[i].age; else break;
  }
  const worst = rows.reduce((w, r) => (r.coverage != null && (w == null || r.coverage < w.coverage) ? r : w), null);

  return {
    rows,
    summary: {
      essentialPct: pct * 100,
      coveredYears,
      totalYears: rows.length,
      firstCoveredAge: firstCovered ? firstCovered.age : null,
      permanentFromAge: permanentFrom,
      worstAge: worst ? worst.age : null,
      worstCoverage: worst ? worst.coverage : null,
      giltYearsCounted: rows.filter((r) => r.gilt > 0).length,
    },
  };
}
