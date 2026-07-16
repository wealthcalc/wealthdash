/* ======================================================================
   EXPENSE RUN-OFF — "if I need £X/year, where does it actually come from,
   year by year, before I have to sell anything?" A funding WATERFALL by
   ASSET CLASS, in strict priority order:

     1. Gilt ladder (coupons + maturing principal, contractual)
        — with the one new mechanic here: a year's gilt proceeds beyond
          that year's need BANK into a carry-forward balance that funds
          LATER years, still ahead of cash. A ladder front-loaded with a
          big maturity shouldn't look wasted because the money arrived a
          year early.
     2. Cash (manual balances + named accounts, as an opening float)
     3. Deferred cash compensation (tranches by schedule, contractual)
     4. RSU vests
     5. Recurring dividends
     6. Only then: portfolio disposals (the "cliff" this view exists to
        locate)

   This is a DIFFERENT question from the two related engines: the Plan
   tab's income floor (core/income-floor.mjs) is a binary guaranteed-vs-
   essential coverage check with no waterfall and no banking; drawdown.mjs's
   STRATEGY waterfall orders WRAPPERS (tax question), not asset classes.

   Modelling decisions, stated plainly (the module's honesty contract):
   - NOMINAL £ throughout: gilt/deferred-cash flows are contractual nominal
     amounts, so the expense is uprated to nominal at the caller's
     inflation assumption rather than deflating everything else.
   - Cash and the gilt bank earn NOTHING here. A run-off asks "how long
     does the float last", and crediting interest would quietly extend the
     runway with a rate assumption; core/cash.mjs knows real rates, and a
     future version could accept them explicitly.
   - RSUs mean SELL-ON-VEST: future SCHEDULED vests valued at TODAY'S
     price (no price forecast — same rule as rsu.mjs valuing held shares).
     Vested-and-held shares are deliberately NOT a source: they already
     sit inside the investable portfolio this view is trying to protect,
     and counting them here too would double-count.
   - Dividends: one flat £/yr figure (the caller's trailing/forward
     estimate) held constant for the horizon. Two disclosed distortions
     pull opposite ways: no dividend growth (understates), and no
     shrinkage as later disposals eat the portfolio (overstates) — the
     circularity of disposals reducing dividends is deliberately not
     modelled rather than half-modelled.
   - Surplus from sources 3–5 in a year (a vest bigger than the remaining
     need) becomes CASH — once paid out it IS cash — so it tops up the
     float rather than vanishing. Gilt surplus stays in its own bank so
     the ladder's contribution remains auditable.
   Pure and node-tested (runoff-model.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;

export function buildRunoff({
  annualExpense = 0,      // today's £/yr
  inflation = 0,          // %/yr — uprates the expense (pass effInflation(p))
  startYear,              // first calendar year
  years = 30,
  giltNominalByYear = {}, // { calendarYear: £ } — giltIncomeByYear() output
  cashStart = 0,          // opening cash float (manual + named accounts)
  deferredByYear = {},    // { calendarYear: £ } — scheduled tranches
  rsuByYear = {},         // { calendarYear: £ } — scheduled vests × today's price
  annualDividends = 0,    // flat recurring-dividend estimate, £/yr
} = {}) {
  if (!startYear) throw new Error("buildRunoff requires startYear — pure functions don't read the clock.");
  if (!(annualExpense > 0)) return { rows: [], summary: null };

  const infl = (+inflation || 0) / 100;
  const rows = [];
  let giltBank = 0;
  let cashBal = Math.max(0, +cashStart || 0);

  for (let i = 0; i < years; i++) {
    const year = startYear + i;
    const expense = annualExpense * Math.pow(1 + infl, i);
    let need = expense;

    // 1. gilt ladder: this year's cashflow plus anything banked earlier
    const giltThisYear = +giltNominalByYear[year] || 0;
    const giltAvail = giltThisYear + giltBank;
    const fromGilts = Math.min(need, giltAvail);
    giltBank = giltAvail - fromGilts;
    need -= fromGilts;

    // 2. cash float
    const fromCash = Math.min(need, cashBal);
    cashBal -= fromCash;
    need -= fromCash;

    // 3–5. income received this year; any surplus beyond the remaining
    // need becomes cash (it's been paid out — it IS cash now).
    const takeIncome = (received) => {
      const used = Math.min(need, received);
      need -= used;
      cashBal += received - used;
      return used;
    };
    const fromDeferred = takeIncome(+deferredByYear[year] || 0);
    const fromRsu = takeIncome(+rsuByYear[year] || 0);
    const fromDividends = takeIncome(+annualDividends || 0);

    // 6. whatever's left comes out of the portfolio
    const fromPortfolio = need;

    rows.push({
      year, expense: r2(expense),
      fromGilts: r2(fromGilts), fromCash: r2(fromCash), fromDeferred: r2(fromDeferred),
      fromRsu: r2(fromRsu), fromDividends: r2(fromDividends), fromPortfolio: r2(fromPortfolio),
      giltBankEnd: r2(giltBank), cashEnd: r2(cashBal),
      covered: fromPortfolio <= 0.005,
    });
  }

  const firstDisposalYear = rows.find((r) => !r.covered)?.year ?? null;
  // "Every year from here needs disposals" — a late gilt maturity or vest
  // can rescue a year after the first breach, so the permanent cliff is
  // computed from the tail (same honesty rule as income-floor's
  // permanentFromAge).
  let permanentDisposalFrom = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!rows[i].covered) permanentDisposalFrom = rows[i].year; else break;
  }
  const giltYears = Object.keys(giltNominalByYear).map(Number).filter((y) => (+giltNominalByYear[y] || 0) > 0);
  return {
    rows,
    summary: {
      firstDisposalYear,
      permanentDisposalFrom,
      coveredYears: rows.filter((r) => r.covered).length,
      totalYears: rows.length,
      totalFromPortfolio: r2(rows.reduce((s, r) => s + r.fromPortfolio, 0)),
      cashExhaustedYear: rows.find((r) => r.cashEnd <= 0.005 && r.fromCash > 0)?.year ?? null,
      giltLadderEndsYear: giltYears.length ? Math.max(...giltYears) : null,
    },
  };
}
