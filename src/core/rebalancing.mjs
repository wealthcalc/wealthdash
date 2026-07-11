/* ======================================================================
   TAX-AWARE REBALANCING (Phase 2, step 6).

   Takes the full, all-wrapper valued position list already computed by
   buildWealthModel() (core/portfolio.mjs — `wealthModel.positions`) plus a
   user-set TARGET split between exactly two buckets — Bonds/gilts vs
   Equities — and works out:
     1. the drift between current and target weight in each bucket,
     2. WHICH SPECIFIC HOLDINGS to trim to close an overweight, ranked so the
        tax cost of doing so is minimised, and
     3. which existing holdings could absorb new money for the underweight
        bucket (never invents a new fund to buy — this app has no basis to
        recommend a specific product).

   Deliberately just two buckets, not the finer equity/fund/investment_trust/
   gilt/bond_fund split the Wealth tab's allocation view uses — rebalancing
   is a bonds-vs-equities risk decision, not a "how many different fund
   wrappers do I hold" question:
     BOND bucket    — kind "gilt" or "bond_fund"
     EQUITY bucket  — kind "equity", "fund", or "investment_trust"
   Anything else (cash-classified instruments, unrecognised kinds) doesn't
   fit either side of that decision and is excluded from every total here,
   the same way VCTs are (see below) — silently forcing it into a bucket
   would misrepresent both the percentages and the plan.

   VCT holdings are EXCLUDED ENTIRELY, in every function below, regardless
   of bucket — Venture Capital Trust shares must be held 5 years to keep
   their income-tax relief (sell earlier and it's clawed back), and even
   past that they're thin, illiquid secondary markets where a "just sell
   some" suggestion is a much bigger ask than it is for an ISA/GIA ETF. A
   rebalancing tool that casually suggested trimming a VCT would be
   actively bad advice, so they never enter the candidate pool at all.

   Tax-aware ranking for sells (cheapest-to-sell first):
     rank 0 — sheltered wrapper (ISA/SIPP/LISA) or CGT-exempt (individual
              gilts, TCGA 1992 s115): selling costs nothing in tax, ever.
     rank 1 — GIA holding sitting at a loss or breakeven: no CGT is due, and
              realising the loss is a genuine tax asset (banks a loss against
              other gains this year, or carries forward).
     rank 2 — GIA holding with an unrealised gain: ranked by GAIN FRACTION
              ascending (smallest % gain first), since Section 104 pooling
              means a partial disposal realises gain STRICTLY pro-rata to the
              fraction of the pool sold — so the smallest-gain-fraction
              holdings raise the most cash per pound of AEA consumed.
   A single, portfolio-wide AEA budget (`aeaLeft`) is drawn down across both
   buckets' sells together (CGT allowance isn't per asset class), same
   modelling choice as bedAndIsaPlan() in core/allowances.mjs.

   Pure and React-free; runs under node --test (see rebalancing.test.mjs).
   ====================================================================== */

const EPS = 1e-9;
const SHELTERED = new Set(["ISA", "SIPP", "LISA"]);
const round2 = (x) => Math.round(x * 100) / 100;

export const BOND_KINDS = new Set(["gilt", "bond_fund"]);
export const EQUITY_KINDS = new Set(["equity", "fund", "investment_trust"]);
export const BUCKETS = ["bonds", "equities"];
export const BUCKET_LABEL = { bonds: "Bonds & gilts", equities: "Equities" };

// kind -> "bonds" | "equities" | null (excluded from rebalancing entirely).
export function bucketOf(kind) {
  if (BOND_KINDS.has(kind)) return "bonds";
  if (EQUITY_KINDS.has(kind)) return "equities";
  return null;
}

// Positions eligible for rebalancing at all: priced, valued, not VCT-wrapped,
// and classified into one of the two buckets. Every function below starts
// from this same filtered list, so "excluded" behaves identically everywhere.
function eligiblePositions(positions) {
  const out = [];
  for (const p of positions) {
    if (!p || !p.priced || !(p.marketValue > 0)) continue;
    if (String(p.wrapper).toUpperCase() === "VCT") continue;
    const bucket = bucketOf(p.kind);
    if (!bucket) continue;
    out.push({ ...p, bucket });
  }
  return out;
}

/* ---------------------------- allocation drift ---------------------------- */
// `targets`: { bonds: targetPercent, equities: targetPercent }. Always
// returns exactly two rows (bonds, equities), even at £0, so the UI has a
// stable shape to render rather than a variable-length list. `total` is the
// bonds+equities pool only — VCTs and anything outside the two buckets are
// excluded from the denominator too, not just left out of the split, so the
// percentages describe "of the money this tool can actually act on."
export function allocationDrift({ positions = [], targets = {} } = {}) {
  const eligible = eligiblePositions(positions);
  const byBucket = { bonds: 0, equities: 0 };
  let total = 0;
  for (const p of eligible) { byBucket[p.bucket] += p.marketValue; total += p.marketValue; }

  const rows = BUCKETS.map((bucket) => {
    const currentValue = byBucket[bucket];
    const currentPct = total > EPS ? (currentValue / total) * 100 : 0;
    const targetPct = Number.isFinite(+targets[bucket]) ? +targets[bucket] : 0;
    const targetValue = total > EPS ? (targetPct / 100) * total : 0;
    const driftValue = currentValue - targetValue; // positive = overweight, sell; negative = underweight, buy
    return {
      bucket, currentValue: round2(currentValue), currentPct, targetPct,
      targetValue: round2(targetValue), driftValue: round2(driftValue), driftPct: currentPct - targetPct,
    };
  });
  const targetTotalPct = BUCKETS.reduce((s, b) => s + (Number.isFinite(+targets[b]) ? +targets[b] : 0), 0);
  return { total: round2(total), rows, targetTotalPct: round2(targetTotalPct), targetsSumTo100: Math.abs(targetTotalPct - 100) < 0.5 };
}

/* ------------------------------ sell suggestions --------------------------- */
export function sellSuggestions({ positions = [], driftRows = [], aeaLeft = 0 } = {}) {
  const needed = new Map();
  for (const r of driftRows) if (r.driftValue > EPS) needed.set(r.bucket, r.driftValue);
  if (!needed.size) return { rows: [], aeaUsed: 0, aeaLeftAfter: round2(Math.max(0, aeaLeft)) };

  const candidates = [];
  for (const p of eligiblePositions(positions)) {
    if (!needed.has(p.bucket)) continue;
    const sheltered = SHELTERED.has(String(p.wrapper).toUpperCase()) || p.cgtExempt === true;
    const gainFrac = Number.isFinite(p.unrealisedPct) ? p.unrealisedPct : 0;
    const rank = sheltered ? 0 : (gainFrac <= 0 ? 1 : 2);
    candidates.push({ ...p, sheltered, gainFrac, rank });
  }
  candidates.sort((a, b) => a.rank - b.rank || a.gainFrac - b.gainFrac);

  let aea = Math.max(0, aeaLeft);
  let aeaUsed = 0;
  const rows = [];
  for (const c of candidates) {
    const need = needed.get(c.bucket);
    if (!(need > EPS)) continue;
    const sellValue = Math.min(c.marketValue, need);
    // Section 104 pooling: a partial disposal realises gain strictly
    // pro-rata to the fraction of the pool sold.
    const gain = sellValue * (c.gainFrac > 0 ? c.gainFrac : 0);

    let taxImpact, gainCoveredByAea = 0;
    if (c.sheltered) {
      taxImpact = "tax-free (sheltered wrapper or CGT-exempt gilt)";
    } else if (c.gainFrac <= 0) {
      taxImpact = "loss or breakeven — no CGT, banks a loss";
    } else if (gain <= aea + EPS) {
      taxImpact = "gain within your remaining AEA — no CGT"; gainCoveredByAea = gain; aea -= gain; aeaUsed += gain;
    } else if (aea > EPS) {
      taxImpact = `gain of ${round2(gain)} only partly covered by your remaining AEA (${round2(aea)} left) — the rest is taxable`;
      gainCoveredByAea = aea; aeaUsed += aea; aea = 0;
    } else {
      taxImpact = "gain exceeds your remaining AEA — will trigger CGT at your marginal rate";
    }

    rows.push({
      wrapper: c.wrapper, ticker: c.ticker, kind: c.kind, bucket: c.bucket,
      marketValue: round2(c.marketValue), sellValue: round2(sellValue),
      gainFrac: c.gainFrac, estGain: round2(gain), gainCoveredByAea: round2(gainCoveredByAea),
      wholePosition: sellValue >= c.marketValue - EPS,
      taxImpact,
    });
    needed.set(c.bucket, need - sellValue);
  }
  return { rows, aeaUsed: round2(aeaUsed), aeaLeftAfter: round2(Math.max(0, aea)) };
}

/* ------------------------------- buy suggestions ---------------------------- */
// Never invents a new fund — only surfaces existing holdings of the
// underweight bucket (if any) that new money could go into, sorted largest
// first (adding to an established position, not fragmenting further).
export function buySuggestions({ positions = [], driftRows = [] } = {}) {
  const eligible = eligiblePositions(positions);
  return driftRows
    .filter((r) => r.driftValue < -EPS)
    .map((r) => {
      const existing = eligible
        .filter((p) => p.bucket === r.bucket)
        .sort((a, b) => b.marketValue - a.marketValue)
        .map((p) => ({ wrapper: p.wrapper, ticker: p.ticker, marketValue: round2(p.marketValue) }));
      return { bucket: r.bucket, amountNeeded: round2(-r.driftValue), existingHoldings: existing };
    });
}

/* --------------------------------- orchestrator ----------------------------- */
export function rebalancePlan({ positions = [], targets = {}, aeaLeft = 0 } = {}) {
  const drift = allocationDrift({ positions, targets });
  const sells = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft });
  const buys = buySuggestions({ positions, driftRows: drift.rows });
  return { ...drift, sells, buys };
}
