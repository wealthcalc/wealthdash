/* ======================================================================
   RETURN ATTRIBUTION — which holdings actually produced the return.

   The Returns tab could tell you the portfolio made X%, and it could tell
   you each holding's own return, but not the question in between: which
   positions DROVE the number. A 40% gain on 1% of the money is a rounding
   error; a 6% gain on half of it is the whole story. Without that,
   concentration warnings have nowhere to land — the app could say "your top
   holding is 30% of the portfolio" but never "and it produced 60% of your
   profit".

   What this computes, and what it deliberately doesn't:

   Contribution = holding profit ÷ TOTAL money invested. Chosen because it's
   exact and it ADDS UP: the contributions sum precisely to the portfolio's
   own simple (money-weighted) return, so the decomposition can be shown
   beside the headline without a reconciling fudge.

   This is NOT Brinson attribution and doesn't claim to be. True
   time-weighted attribution needs each holding's value at every period
   boundary; the app stores portfolio-level valuation history, not
   per-holding, so an allocation/selection split would have to be invented.
   A money-weighted decomposition from data that actually exists is the
   honest version, and it's labelled as such in the UI.

   Unpriced open holdings are EXCLUDED, not counted as zero. Their profit is
   genuinely unknown, and treating unknown as nil would quietly credit the
   rest of the portfolio with their performance.
   Pure and node-tested (attribution.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 1e4) / 1e4;

/* perHolding / total: straight from core/returns.mjs computeReturns().
   `by` groups the output: "ticker" (default) or "wrapper". */
export function returnAttribution({ perHolding = [], total = {}, by = "ticker" } = {}) {
  const usable = perHolding.filter((h) => h && h.profit != null && Number.isFinite(h.profit));
  const excluded = perHolding.filter((h) => !h || h.profit == null || !Number.isFinite(h.profit));

  // Denominator is the whole portfolio's invested money, so every row is
  // measured against the same base and the parts sum to the whole.
  const totalMoneyIn = Number.isFinite(total.moneyIn) && total.moneyIn > 0
    ? total.moneyIn
    : usable.reduce((s, h) => s + (+h.moneyIn || 0), 0);

  const groups = new Map();
  for (const h of usable) {
    const key = by === "wrapper" ? (h.wrapper || "—") : h.ticker;
    const g = groups.get(key) || { key, ticker: h.ticker, wrapper: h.wrapper, profit: 0, moneyIn: 0, value: 0, income: 0, positions: 0 };
    g.profit += +h.profit || 0;
    g.moneyIn += +h.moneyIn || 0;
    g.value += +h.value || 0;
    g.income += +h.incomeReceived || 0;
    g.positions += 1;
    if (by === "wrapper") g.ticker = null;
    groups.set(key, g);
  }

  const totalProfit = usable.reduce((s, h) => s + (+h.profit || 0), 0);

  const rows = [...groups.values()].map((g) => ({
    ...g,
    profit: r2(g.profit),
    moneyIn: r2(g.moneyIn),
    value: r2(g.value),
    income: r2(g.income),
    // Share of the money that was put to work — the "size of the bet".
    weight: totalMoneyIn > 0 ? r4(g.moneyIn / totalMoneyIn) : 0,
    // The holding's own return on its own money — how well the bet did.
    ownReturn: g.moneyIn > 0 ? r4(g.profit / g.moneyIn) : null,
    // Size × performance: what it added to the PORTFOLIO's return. These sum
    // to the portfolio return exactly.
    contribution: totalMoneyIn > 0 ? r4(g.profit / totalMoneyIn) : 0,
    // Share of total profit. Meaningless when the portfolio is ~flat, so
    // it's null there rather than a wild number from a tiny denominator.
    shareOfProfit: Math.abs(totalProfit) > 1e-9 ? r4(g.profit / totalProfit) : null,
  })).sort((a, b) => b.contribution - a.contribution);

  const winners = rows.filter((r) => r.profit > 0);
  const losers = rows.filter((r) => r.profit < 0);
  const portfolioReturn = totalMoneyIn > 0 ? r4(totalProfit / totalMoneyIn) : null;

  return {
    rows,
    winners,
    losers: [...losers].sort((a, b) => a.contribution - b.contribution),
    summary: {
      totalProfit: r2(totalProfit),
      totalMoneyIn: r2(totalMoneyIn),
      portfolioReturn,
      // The decomposition's own check: contributions must reconstruct the
      // portfolio return. Surfaced so a future change can't break it quietly.
      contributionSum: r4(rows.reduce((s, r) => s + r.contribution, 0)),
      excludedCount: excluded.length,
      excludedTickers: excluded.map((h) => h?.ticker).filter(Boolean),
      // How much of the gain came from the few biggest contributors — the
      // number that answers "is my concentration earning its risk?".
      top3Share: rows.length && Math.abs(totalProfit) > 1e-9
        ? r4(rows.slice(0, 3).reduce((s, r) => s + r.profit, 0) / totalProfit)
        : null,
    },
  };
}
