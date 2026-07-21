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

// Gross up a portfolio sale for the CGT it triggers, so a shortfall shows
// the SALE actually needed rather than the net proceeds. To net `need`
// from a GIA disposal you must sell more, because part of the proceeds is
// a taxable gain: the run-off previously showed the net, understating the
// real drawdown. Model, deliberately simple and disclosed:
//   gain on a sale of S = S × gainFraction   (the portfolio's overall
//     unrealised-gain proportion — a blend, not per-lot matching, which
//     this view has no basis to do)
//   taxable = max(0, gain − allowance)       (annual exempt amount, per year)
//   tax = taxable × rate
//   net = S − tax = need   →   solve for S
// With gainFraction or rate at 0 (the default) this returns the input
// unchanged, so untaxed wrappers and "don't model tax" both cost nothing.
export function grossUpForCgt(need, { gainFraction = 0, rate = 0, allowance = 0 } = {}) {
  const g = Math.max(0, Math.min(1, +gainFraction || 0));
  const r = Math.max(0, +rate || 0);
  const a = Math.max(0, +allowance || 0);
  if (!(need > 0) || g === 0 || r === 0) return { gross: r2(Math.max(0, need)), tax: 0 };
  // Regime 1: the whole gain fits inside the allowance → no tax, sell = need.
  if (need * g <= a) return { gross: r2(need), tax: 0 };
  // Regime 2: gain exceeds the allowance. need = S(1 − g·r) + a·r.
  const gross = (need - a * r) / (1 - g * r);
  const tax = Math.max(0, gross * g - a) * r;
  return { gross: r2(gross), tax: r2(tax) };
}

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
  // CGT on the portfolio sales that cover a shortfall. All default to 0,
  // so the untaxed case is unchanged. gainFraction = the portfolio's
  // overall unrealised-gain proportion; cgtRate = the marginal CGT rate;
  // cgtAllowance = the annual exempt amount (applied per year).
  cgtGainFraction = 0,
  cgtRate = 0,
  cgtAllowance = 0,
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
    const cashBefore = cashBal;
    const fromDeferred = takeIncome(+deferredByYear[year] || 0);
    const fromRsu = takeIncome(+rsuByYear[year] || 0);
    const fromDividends = takeIncome(+annualDividends || 0);
    // Surplus income banked into the float this year — surfaced per-row so
    // a RISING "cash left" column is explainable at a glance rather than
    // looking like a bug (income received beyond the year's need doesn't
    // vanish; once paid out it IS cash).
    const surplusToCash = cashBal - cashBefore;

    // 6. whatever's left comes out of the portfolio. In a taxable wrapper
    // the real SALE is larger than the net need, because CGT is due on the
    // gain portion — surfaced so a shortfall isn't understated.
    const fromPortfolio = need;
    const { gross: portfolioGross, tax: cgtOnSale } = grossUpForCgt(need, {
      gainFraction: cgtGainFraction, rate: cgtRate, allowance: cgtAllowance,
    });

    rows.push({
      year, expense: r2(expense),
      fromGilts: r2(fromGilts), fromCash: r2(fromCash), fromDeferred: r2(fromDeferred),
      fromRsu: r2(fromRsu), fromDividends: r2(fromDividends), fromPortfolio: r2(fromPortfolio),
      portfolioGross: r2(portfolioGross), cgtOnSale: r2(cgtOnSale),
      surplusToCash: r2(surplusToCash), giltBankEnd: r2(giltBank), cashEnd: r2(cashBal),
      // GROSS inflows received this calendar year, regardless of whether
      // the waterfall needed them — the cash-flow view's positive bars.
      // (`from*` above is money USED; a covered year uses £0 of dividends
      // but still receives all of them.) balanceEnd = cash + gilt bank:
      // the total liquid float the year closes with.
      giltIn: r2(giltThisYear), deferredIn: r2(+deferredByYear[year] || 0),
      rsuIn: r2(+rsuByYear[year] || 0), divIn: r2(+annualDividends || 0),
      totalIn: r2(giltThisYear + (+deferredByYear[year] || 0) + (+rsuByYear[year] || 0) + (+annualDividends || 0)),
      // Net cash flow BEFORE any forced selling: positive years add to the
      // float, negative years draw it down. This is the number the
      // waterfall's `from*` columns obscure — a year can look "fully
      // funded" while quietly consuming £40k of accumulated float.
      net: r2(giltThisYear + (+deferredByYear[year] || 0) + (+rsuByYear[year] || 0) + (+annualDividends || 0) - expense),
      balanceEnd: r2(cashBal + giltBank),
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
      totalPortfolioGross: r2(rows.reduce((s, r) => s + r.portfolioGross, 0)),
      totalCgtOnSales: r2(rows.reduce((s, r) => s + r.cgtOnSale, 0)),
      cashExhaustedYear: rows.find((r) => r.cashEnd <= 0.005 && r.fromCash > 0)?.year ?? null,
      giltLadderEndsYear: giltYears.length ? Math.max(...giltYears) : null,
    },
  };
}
