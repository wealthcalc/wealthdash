/* ======================================================================
   RISK-ADJUSTED RETURN — Sharpe, Sortino, Beta.

   The app already reported volatility and max drawdown, which describe how
   bumpy the ride was but never whether the destination justified it. A 12%
   return at 20% volatility and a 12% return at 6% volatility are the same
   number and completely different portfolios.

   Three measures, each answering something the others don't:
   - SHARPE: excess return per unit of total volatility. The standard, and
     the one that penalises upside swings as well as downside — which is
     arguably unfair to a portfolio that mostly surprises on the upside.
   - SORTINO: the same idea but dividing only by DOWNSIDE deviation, so
     volatility that made you money isn't counted against you. Usually the
     more honest of the two for a long-only portfolio.
   - BETA: sensitivity to the market. Below 1 means the portfolio moves less
     than the index; above 1, more. Distinct from volatility because it
     measures CO-movement — a portfolio can be very volatile with a low beta
     if its swings are unrelated to the market's.

   Every figure is annualised from the observed periods so it can be read
   against the return, and every one refuses to compute on too little data
   rather than emitting a number from four points. The risk-free rate is an
   input, not a hardcoded guess — it changes materially over time and the
   Sharpe ratio is sensitive to it.
   Pure and node-tested (risk-metrics.test.mjs).
   ====================================================================== */

const r3 = (x) => Math.round(x * 1000) / 1000;
const MIN_PERIODS = 8;   // below this, a standard deviation is noise

// Periods per year implied by the observed spacing — so weekly, monthly and
// daily series all annualise correctly instead of assuming a frequency.
function periodsPerYear(periods) {
  const spans = periods
    .map((p) => (Date.parse(p.to) - Date.parse(p.from)) / 86400000)
    .filter((d) => Number.isFinite(d) && d > 0);
  if (!spans.length) return 12;
  const sorted = [...spans].sort((a, b) => a - b);
  const medianDays = sorted[Math.floor(sorted.length / 2)];
  return 365 / Math.max(1, medianDays);
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

/* periods: [{ from, to, factor }] — the same TWR periods used elsewhere.
   riskFreeRate: annual decimal (0.045 = 4.5%). Defaults to 0 with the
   consequence stated in the result rather than silently assumed away. */
export function riskMetrics({ periods = [], riskFreeRate = 0 } = {}) {
  const valid = periods.filter((p) => p && Number.isFinite(+p.factor) && p.factor > 0);
  if (valid.length < MIN_PERIODS) {
    return { sharpe: null, sortino: null, reason: `needs at least ${MIN_PERIODS} periods (have ${valid.length})` };
  }

  const ppy = periodsPerYear(valid);
  // Log returns for the statistics: they're additive over time, so the
  // annualisation is a multiplication rather than an approximation.
  const rs = valid.map((p) => Math.log(p.factor));
  const m = mean(rs);
  const variance = rs.reduce((s, r) => s + (r - m) ** 2, 0) / (rs.length - 1);
  const vol = Math.sqrt(variance) * Math.sqrt(ppy);
  const annualReturn = Math.expm1(m * ppy);

  const excess = annualReturn - riskFreeRate;

  // Downside deviation: only periods BELOW the risk-free hurdle count. A
  // portfolio isn't penalised for the weeks it rose.
  const hurdlePerPeriod = Math.log1p(riskFreeRate) / ppy;
  const below = rs.filter((r) => r < hurdlePerPeriod).map((r) => (r - hurdlePerPeriod) ** 2);
  const downside = below.length
    ? Math.sqrt(below.reduce((a, b) => a + b, 0) / rs.length) * Math.sqrt(ppy)
    : 0;

  return {
    periods: valid.length,
    periodsPerYear: r3(ppy),
    annualReturn: r3(annualReturn),
    annualisedVol: r3(vol),
    riskFreeRate,
    sharpe: vol > 0 ? r3(excess / vol) : null,
    // No down periods at all: the ratio is undefined rather than infinite,
    // and saying so is more useful than printing ∞.
    sortino: downside > 0 ? r3(excess / downside) : null,
    downsideDeviation: r3(downside),
    sortinoReason: downside > 0 ? null : "no periods below the risk-free rate — downside risk is undefined, not zero",
    riskFreeAssumed: riskFreeRate === 0 ? "0% — set a rate for a meaningful Sharpe" : null,
  };
}

/* Beta and correlation against a benchmark.

   Both series must be aligned to the SAME period boundaries; the caller
   passes matched arrays. Beta = covariance(portfolio, market) / variance
   (market), the standard regression slope.

   R² is returned alongside because beta without it misleads: a beta of 1.4
   on a portfolio that barely tracks the index at all is a number, not a
   relationship. */
export function portfolioBeta({ portfolioFactors = [], benchmarkFactors = [] } = {}) {
  const n = Math.min(portfolioFactors.length, benchmarkFactors.length);
  if (n < MIN_PERIODS) return { beta: null, reason: `needs at least ${MIN_PERIODS} aligned periods (have ${n})` };

  const p = [], b = [];
  for (let i = 0; i < n; i++) {
    const pf = +portfolioFactors[i], bf = +benchmarkFactors[i];
    if (!(pf > 0) || !(bf > 0)) continue;
    p.push(Math.log(pf)); b.push(Math.log(bf));
  }
  if (p.length < MIN_PERIODS) return { beta: null, reason: "not enough usable aligned periods" };

  const mp = mean(p), mb = mean(b);
  let cov = 0, varB = 0, varP = 0;
  for (let i = 0; i < p.length; i++) {
    cov += (p[i] - mp) * (b[i] - mb);
    varB += (b[i] - mb) ** 2;
    varP += (p[i] - mp) ** 2;
  }
  if (varB <= 0) return { beta: null, reason: "the benchmark didn't move — beta is undefined" };

  const beta = cov / varB;
  const r2 = varP > 0 ? (cov * cov) / (varB * varP) : 0;
  return {
    beta: r3(beta),
    rSquared: r3(r2),
    periods: p.length,
    // Below roughly 0.5, the portfolio and the index simply aren't moving
    // together and beta shouldn't be read as a sensitivity.
    reliable: r2 >= 0.5,
    note: r2 >= 0.5 ? null : "the portfolio tracks this benchmark loosely, so beta is a weak description of its market sensitivity",
  };
}
