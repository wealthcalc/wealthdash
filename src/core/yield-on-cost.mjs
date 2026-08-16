/* ======================================================================
   YIELD ON COST + PROFIT DECOMPOSITION.

   Two views the app had all the inputs for and never assembled.

   1. YIELD ON COST. Every yield here was measured against CURRENT VALUE,
      which answers "what would I get if I bought this today". For a holding
      bought years ago that's the wrong question: a trust yielding 3.5% on
      today's price may be paying 9% on what you actually put in, and that
      second number is the one that decides whether a long-held income
      position is doing its job. Both are reported side by side, because the
      gap between them IS the story — it's price appreciation plus dividend
      growth, compounded.

   2. PROFIT BY SOURCE. Total profit was a single figure. Split into capital
      gain, income received, realised P&L and fees, it answers a different
      and more actionable question for an income-oriented portfolio: how much
      of the return is money that actually arrived, versus paper value that
      could evaporate. Fees are shown as the negative they are rather than
      being netted silently into the total.
   Pure and node-tested (yield-on-cost.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/* perHolding: from core/returns.mjs computeReturns().
   Uses `moneyIn` (what was actually paid, including fees) as the cost base
   for open positions. Closed positions are excluded — a yield on a holding
   you no longer own is meaningless. */
export function yieldOnCost({ perHolding = [], total = {} } = {}) {
  const open = perHolding.filter((h) => h && h.open);

  const rows = open.map((h) => {
    const cost = +h.moneyIn || 0;
    const value = +h.value || 0;
    // Forward income = what the current units are expected to pay over the
    // next year; trailing = what they actually paid over the last one.
    const fwd = +h.income?.forwardIncome || 0;
    const ttm = +h.income?.trailing12m || 0;
    return {
      ticker: h.ticker,
      wrapper: h.wrapper,
      cost: r2(cost),
      value: r2(value),
      forwardIncome: r2(fwd),
      trailingIncome: r2(ttm),
      // On COST: the return the original money is generating.
      yieldOnCost: cost > 0 ? r4(fwd / cost) : null,
      trailingYieldOnCost: cost > 0 ? r4(ttm / cost) : null,
      // On VALUE: what a buyer today would receive. The existing metric.
      yieldOnValue: value > 0 ? r4(fwd / value) : null,
      // How far the two have diverged — i.e. how much the holding has
      // re-rated since purchase.
      uplift: cost > 0 && value > 0 && fwd > 0 ? r4((fwd / cost) - (fwd / value)) : null,
      priced: !!h.priced,
    };
  }).filter((r) => r.forwardIncome > 0 || r.trailingIncome > 0)
    .sort((a, b) => (b.yieldOnCost ?? -1) - (a.yieldOnCost ?? -1));

  const totalCost = rows.reduce((s, r) => s + r.cost, 0);
  const totalValue = rows.reduce((s, r) => s + r.value, 0);
  const totalForward = rows.reduce((s, r) => s + r.forwardIncome, 0);
  const totalTrailing = rows.reduce((s, r) => s + r.trailingIncome, 0);

  return {
    rows,
    summary: {
      cost: r2(totalCost),
      value: r2(totalValue),
      forwardIncome: r2(totalForward),
      trailingIncome: r2(totalTrailing),
      yieldOnCost: totalCost > 0 ? r4(totalForward / totalCost) : null,
      yieldOnValue: totalValue > 0 ? r4(totalForward / totalValue) : null,
      // Portfolio-wide, the same divergence: income-producing holdings have
      // re-rated by this much since they were bought.
      uplift: totalCost > 0 && totalValue > 0
        ? r4((totalForward / totalCost) - (totalForward / totalValue)) : null,
      incomeHoldings: rows.length,
      // Money the whole portfolio put in, for context on how much of it is
      // actually working for income.
      portfolioMoneyIn: Number.isFinite(+total.moneyIn) ? r2(total.moneyIn) : null,
    },
  };
}

/* Split total profit into where it came from.

   Capital gain is DERIVED (value + proceeds − cost − income) rather than
   tracked separately, so the four parts always sum exactly to the profit
   figure shown elsewhere — a decomposition that doesn't reconcile is worse
   than none. */
export function profitBySource({ perHolding = [], total = {} } = {}) {
  const usable = perHolding.filter((h) => h && h.profit != null && Number.isFinite(h.profit));

  let income = 0, fees = 0, realised = 0, totalProfit = 0;
  for (const h of usable) {
    income += +h.incomeReceived || 0;
    fees += +h.fees || 0;
    // Realised P&L on the part already sold: proceeds less the cost of what
    // was sold. Only meaningful where the engine tracked a disposal.
    if (h.realisedPL != null && Number.isFinite(+h.realisedPL)) realised += +h.realisedPL;
    totalProfit += +h.profit || 0;
  }
  // Whatever the named sources don't explain is the unrealised move in the
  // holdings still owned.
  const capital = totalProfit - income - realised + fees;

  const parts = [
    { key: "capital", label: "Unrealised capital gain", value: r2(capital) },
    { key: "income", label: "Income received", value: r2(income) },
    ...(realised !== 0 ? [{ key: "realised", label: "Realised gains on sales", value: r2(realised) }] : []),
    ...(fees !== 0 ? [{ key: "fees", label: "Dealing costs", value: r2(-Math.abs(fees)) }] : []),
  ];

  const denom = Math.abs(totalProfit);
  return {
    parts: parts.map((p) => ({ ...p, share: denom > 1e-9 ? r4(p.value / totalProfit) : null })),
    total: r2(totalProfit),
    // The share of profit that is money actually banked rather than paper
    // value — the distinction an income investor cares about most.
    bankedShare: denom > 1e-9 ? r4((income + realised) / totalProfit) : null,
    excludedCount: perHolding.length - usable.length,
  };
}
