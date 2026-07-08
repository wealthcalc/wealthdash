/* ======================================================================
   BENCHMARK COMPARISON, VOLATILITY/DRAWDOWN & FEE DRAG (Phase 2, step 5).

   Three independent, pure calculations, all built on data the app already
   has (valuation snapshots from returns.mjs's twrFromValuations, and
   secMeta for holding metadata) plus one new client-supplied series (a
   benchmark's historical closing prices, fetched via api/benchmark.mjs).

   1. growthIndex/maxDrawdown/volatility — read the PERIOD FACTORS already
      computed by twrFromValuations (each period's factor already has
      external cashflows netted out), not raw valuation snapshots. This
      matters: a portfolio that just received a big deposit isn't "up"
      in the performance sense, and one that just paid out a big
      withdrawal isn't "down" — using raw £ values for drawdown/volatility
      would conflate cash movements with actual investment performance.
   2. benchmarkCumulativeReturn — rebase a benchmark's own price series to
      the portfolio's snapshot span and compute its buy-and-hold return
      over the identical dates, so the comparison is apples-to-apples
      (same start, same end), not skewed by different measurement windows.
   3. feeDrag — asset-weighted ongoing-charge-figure (OCF) cost, from
      secMeta.ocf (user-entered, % per year) x current market value per
      open holding. This is today's ACTUAL cost given today's holdings,
      not the forward-looking hypothetical single-rate assumption already
      modelled in the Plan tab's retirement projection (deliberately kept
      separate — the two need not be reconciled since the Plan tab's `fee`
      is a planning assumption, not a measured, per-holding number).

   Pure and React-free; runs under node --test (see benchmark.test.mjs).
   ====================================================================== */

const EPS = 1e-9;

/* ------------------------------ growth index ---------------------------- */
// Chains twrFromValuations()'s `periods` (each { from, to, factor }) into a
// cumulative index starting at 100 on the first snapshot date. One point per
// snapshot date — exactly the dates flows/valuations were actually recorded.
export function growthIndex(periods, startDate) {
  if (!startDate) return [];
  const out = [{ date: startDate, index: 100 }];
  let level = 100;
  for (const p of periods || []) {
    if (!p || !p.to || !Number.isFinite(+p.factor)) continue;
    level *= p.factor;
    out.push({ date: p.to, index: level });
  }
  return out;
}

/* ------------------------------ max drawdown ----------------------------- */
// Peak-to-trough decline on a growth index (see growthIndex above) —
// performance-only, uncontaminated by contributions/withdrawals. Returns null
// stats when there's nothing to measure (fewer than 2 points).
export function maxDrawdown(indexSeries = []) {
  if (indexSeries.length < 2) return { maxDrawdown: null, reason: "needs >= 2 index points" };
  let peak = indexSeries[0], peakIdx = 0, worst = 0, worstPeakIdx = 0, worstTroughIdx = 0;
  for (let i = 1; i < indexSeries.length; i++) {
    const pt = indexSeries[i];
    if (pt.index > peak.index) { peak = pt; peakIdx = i; }
    const dd = (pt.index - peak.index) / peak.index; // <= 0
    if (dd < worst) { worst = dd; worstPeakIdx = peakIdx; worstTroughIdx = i; }
  }
  const peakPt = indexSeries[worstPeakIdx], troughPt = indexSeries[worstTroughIdx];
  // Recovered = index later regains the pre-drawdown peak level.
  let recoveryDate = null;
  for (let i = worstTroughIdx + 1; i < indexSeries.length; i++) {
    if (indexSeries[i].index >= peakPt.index) { recoveryDate = indexSeries[i].date; break; }
  }
  return {
    maxDrawdown: worst, peakDate: peakPt.date, troughDate: troughPt.date,
    recovered: recoveryDate != null, recoveryDate,
  };
}

/* ------------------------------- volatility ------------------------------ */
// Annualised volatility from twrFromValuations() periods, using LOG returns
// (ln(factor)) so multi-period compounding is additive, and the SAMPLE stdev
// (n-1) since periods are a sample of the portfolio's return process, not the
// whole population. Snapshot spacing is irregular in this app (recorded
// whenever all holdings are priced, not on a fixed calendar), so this scales
// by the ACTUAL average periods-per-year implied by the data rather than
// assuming daily/monthly — a defensible, stated approximation, not a silent
// one. Needs >= 2 periods (3 snapshots) for a meaningful sample stdev.
export function volatility(periods = []) {
  const valid = periods.filter((p) => p && Number.isFinite(+p.factor) && p.factor > 0);
  if (valid.length < 2) return { annualisedVol: null, reason: `needs >= 2 periods (have ${valid.length})` };
  const logReturns = valid.map((p) => Math.log(p.factor));
  const mean = logReturns.reduce((a, b) => a + b, 0) / logReturns.length;
  const variance = logReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (logReturns.length - 1);
  const periodStdev = Math.sqrt(variance);
  const spanDays = valid.reduce((s, p) => {
    const days = (new Date(p.to) - new Date(p.from)) / 86400000;
    return s + (Number.isFinite(days) && days > 0 ? days : 0);
  }, 0);
  const avgPeriodDays = spanDays / valid.length;
  const periodsPerYear = avgPeriodDays > 0 ? 365 / avgPeriodDays : null;
  const annualisedVol = periodsPerYear ? periodStdev * Math.sqrt(periodsPerYear) : null;
  return { annualisedVol, periodStdev, periodsPerYear, sampleSize: valid.length };
}

/* --------------------------- benchmark comparison ------------------------ */
// `benchmarkPrices`: [{ date, close }] ascending, any frequency (daily is
// typical from the Yahoo proxy). Finds the closing price on-or-before `from`
// and on-or-before `to` and returns the buy-and-hold return between them —
// the same convention as a "how did the index do over my holding period"
// comparison, not a risk-adjusted alpha (that would need a full return
// series aligned to the portfolio's own periods, which daily benchmark data
// against irregular snapshot dates can't honestly support here).
function closeOnOrBefore(prices, dateStr) {
  let best = null;
  for (const p of prices) {
    if (!p || !p.date || !Number.isFinite(+p.close)) continue;
    if (p.date <= dateStr && (!best || p.date > best.date)) best = p;
  }
  return best;
}

export function benchmarkCumulativeReturn(benchmarkPrices = [], fromDate, toDate) {
  if (!fromDate || !toDate || fromDate >= toDate) return { cumulativeReturn: null, reason: "needs a valid from < to date range" };
  const start = closeOnOrBefore(benchmarkPrices, fromDate);
  const end = closeOnOrBefore(benchmarkPrices, toDate);
  if (!start || !end) return { cumulativeReturn: null, reason: "no benchmark price on or before the required date(s)" };
  if (start.close <= EPS) return { cumulativeReturn: null, reason: "non-positive starting price" };
  return {
    cumulativeReturn: end.close / start.close - 1,
    fromDate: start.date, toDate: end.date, fromClose: start.close, toClose: end.close,
  };
}

/* --------------------------------- fees ---------------------------------- */
// Asset-weighted OCF across currently-open, priced holdings. `ocfByTicker` is
// a plain { TICKER: percentPerYear } map (from secMeta.ocf, user-entered —
// there's no free, reliable, machine-readable source of fund OCFs this app
// verified, unlike prices/FX/gilts/HPI, so this is deliberately manual input
// rather than a guessed or scraped figure). Holdings without a recorded OCF
// are excluded from the weighted average (treated as "unknown", not "0%")
// but still listed by the caller so the gap is visible, not hidden.
export function feeDrag({ holdings = [], ocfByTicker = {} } = {}) {
  let weightedValue = 0, totalAnnualCost = 0, knownValue = 0, unknownValue = 0;
  const rows = [];
  for (const h of holdings) {
    if (!h || !h.open || !Number.isFinite(+h.marketValue) || h.marketValue <= 0) continue;
    const ocf = ocfByTicker[h.ticker];
    const known = Number.isFinite(+ocf) && +ocf >= 0;
    const annualCost = known ? h.marketValue * (+ocf / 100) : null;
    if (known) { weightedValue += h.marketValue; totalAnnualCost += annualCost; knownValue += h.marketValue; }
    else unknownValue += h.marketValue;
    rows.push({ ticker: h.ticker, wrapper: h.wrapper, marketValue: h.marketValue, ocf: known ? +ocf : null, annualCost });
  }
  return {
    rows,
    knownValue, unknownValue,
    weightedOcf: weightedValue > EPS ? (totalAnnualCost / weightedValue) * 100 : null,
    totalAnnualCost: weightedValue > EPS ? totalAnnualCost : null,
  };
}
