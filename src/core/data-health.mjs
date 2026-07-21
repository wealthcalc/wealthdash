/* ======================================================================
   DATA HEALTH — one place for "what does the app need from me to be
   accurate?", replacing seven warnings scattered across seven tabs.

   The distinction that makes this coherent: these are COMPLETENESS
   issues, not money decisions. "A holding has no price" and "your ISA
   allowance is unused" are different classes of message — the action
   queue owns the second, this owns the first. Mixing them (the state
   before this module) meant a stale-price nag could sit above a
   £20,000 allowance decision.

   Each issue carries a SEVERITY that reflects how much it distorts the
   numbers, not how loud it feels:
     high   — silently wrong figures (unpriced holdings understate net
              worth; unledgered vests mis-state the portfolio)
     medium — drifting or incomplete (stale prices, stale imports,
              uncategorised spend past a threshold)
     low    — worth tidying, changes little (a missing ISIN on a UK
              investment trust that will never owe ERI)

   The score is a blunt instrument by design: a single 0–100 number that
   only moves when something material is wrong, so "100%" means "trust the
   figures" and anything less has a named, jump-to reason. It is NOT
   weighted cleverly — a clever weighting nobody can predict is worse than
   a crude one everybody can, for a number whose whole job is trust.

   Pure and node-tested (data-health.test.mjs). The caller assembles the
   already-computed inputs (it does not recompute anything): unpriced
   count from the wealth model, stale tickers from price metadata,
   reconciliation flags from rsu.mjs, ERI gaps from the same check the
   Income tab runs, uncategorised £ from budget.mjs, import ages from the
   same map the action queue reads.
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;

// Severity → the score penalty each ISSUE of that kind costs, capped so
// one noisy category can't zero the whole score.
const PENALTY = { high: 22, medium: 9, low: 3 };
const CAP = { high: 55, medium: 30, low: 12 };

export function dataHealth({
  unpricedTickers = [],       // [ticker] with no current price
  unpricedValueKnown = true,  // false if we can't even estimate their value
  stalePriceTickers = [],     // [ticker] priced but >3 days old
  unledgeredVests = [],       // [{ticker, shares}] vested-but-not-in-ledger (rsu.mjs)
  eriGaps = [],               // [{ticker, years:[...]}] missing ERI entries
  uncategorisedSpend = 0,     // £ of spend with no category (trailing window)
  totalSpend = 0,             // £ total spend in the same window (for the %)
  staleImports = [],          // [{source, days}] broker feeds >45d old
  missingIsins = [],          // [ticker] held unsheltered with no ISIN on record
  today,
} = {}) {
  if (!today) throw new Error("dataHealth requires `today` — pure functions don't read the clock.");
  const issues = [];

  if (unpricedTickers.length) {
    issues.push({
      id: "unpriced", severity: "high", tab: "wealth",
      count: unpricedTickers.length, tickers: unpricedTickers,
      message: `${unpricedTickers.length} holding${unpricedTickers.length > 1 ? "s" : ""} with no price (${unpricedTickers.slice(0, 4).join(", ")}${unpricedTickers.length > 4 ? "…" : ""})`,
      detail: unpricedValueKnown
        ? "Excluded from market value, so net worth is understated."
        : "Value can't even be estimated — net worth is materially incomplete.",
    });
  }

  if (unledgeredVests.length) {
    const shares = unledgeredVests.reduce((s, v) => s + (+v.shares || 0), 0);
    issues.push({
      id: "unledgered-vests", severity: "high", tab: "rsu",
      count: unledgeredVests.length, shares: r2(shares),
      message: `${r2(shares)} vested share${shares === 1 ? "" : "s"} not in the ledger (${[...new Set(unledgeredVests.map((v) => v.ticker))].join(", ")})`,
      detail: "Vested RSUs missing from transactions understate the portfolio and its cost base.",
    });
  }

  if (stalePriceTickers.length) {
    issues.push({
      id: "stale-prices", severity: "medium", tab: "wealth",
      count: stalePriceTickers.length, tickers: stalePriceTickers,
      message: `${stalePriceTickers.length} price${stalePriceTickers.length > 1 ? "s" : ""} more than 3 days old`,
      detail: "Refresh for a current valuation — old prices drift furthest in volatile weeks.",
    });
  }

  const uncatPct = totalSpend > 0 ? (uncategorisedSpend / totalSpend) * 100 : 0;
  if (uncategorisedSpend > 0 && uncatPct > 5) {
    issues.push({
      id: "uncategorised-spend", severity: "medium", tab: "budget",
      amount: r2(uncategorisedSpend), pct: Math.round(uncatPct),
      message: `${Math.round(uncatPct)}% of spending uncategorised (${r2(uncategorisedSpend)})`,
      detail: "Missing from every budget total until categorised — and from the savings rate.",
    });
  }

  for (const f of staleImports) {
    if (!(f.days > 45)) continue;
    issues.push({
      id: `stale-import-${f.source}`, severity: "medium", tab: "import",
      source: f.source, days: Math.round(f.days),
      message: `${f.source} last imported ${Math.round(f.days)} days ago`,
      detail: "The ledger is drifting from your broker — re-import to catch up.",
    });
  }

  if (eriGaps.length) {
    const funds = eriGaps.length;
    issues.push({
      id: "eri-gaps", severity: "medium", tab: "income",
      count: funds, funds: eriGaps.map((g) => g.ticker),
      message: `${funds} offshore fund${funds > 1 ? "s" : ""} missing ERI entries`,
      detail: "Excess reportable income raises the pool cost — omitting it overstates the eventual gain.",
    });
  }

  if (missingIsins.length) {
    issues.push({
      id: "missing-isins", severity: "low", tab: "income",
      count: missingIsins.length, tickers: missingIsins,
      message: `${missingIsins.length} fund${missingIsins.length > 1 ? "s" : ""} with no ISIN on record`,
      detail: "Needed to check whether they owe ERI — most won't, but the app can't tell without it.",
    });
  }

  // Score: start at 100, subtract capped penalties per severity band.
  const bySeverity = { high: 0, medium: 0, low: 0 };
  for (const i of issues) bySeverity[i.severity] += PENALTY[i.severity];
  const deduction =
    Math.min(CAP.high, bySeverity.high) +
    Math.min(CAP.medium, bySeverity.medium) +
    Math.min(CAP.low, bySeverity.low);
  const score = Math.max(0, Math.min(100, 100 - deduction));

  // Order for display: severity first, then the natural order they were
  // pushed (which follows the "how wrong" reasoning above).
  const rank = { high: 0, medium: 1, low: 2 };
  issues.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return {
    score,
    issues,
    counts: {
      high: issues.filter((i) => i.severity === "high").length,
      medium: issues.filter((i) => i.severity === "medium").length,
      low: issues.filter((i) => i.severity === "low").length,
    },
    clean: issues.length === 0,
  };
}
