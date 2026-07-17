/* ======================================================================
   RETURNS & INCOME ANALYTICS ENGINE (build step 3).

   Pure and React-free; runs under `node --test` (see returns.test.mjs).

   What's exact vs. what isn't — stated up front:
   - XIRR (money-weighted return): EXACT at holding / wrapper / total level.
     Cashflows are fully known from the ledger; terminal value from live
     prices. Annualised, 365-day count (the Excel XIRR convention).
   - Per-holding TWR: EXACT over the current holding episode. Every trade
     implies the unit price on its date, so sub-period returns chain without
     needing external price history. Distributions are treated as reinvested
     on the payment date (standard total-return convention).
   - Wrapper / total TWR: needs the whole portfolio valued at each flow date,
     which we do NOT have historically. `twrFromValuations` computes it
     EXACTLY from a snapshot series; the app records snapshots whenever all
     holdings are priced. Until >= 2 snapshots exist, portfolio TWR is
     honestly unavailable rather than approximated with stale prices.

   Conventions (documented, tested):
   - XIRR cashflow signs are from the investor's pocket: BUY negative,
     SELL / income positive, terminal market value positive.
   - ERI is NOT a cashflow (no cash moves; it accrues inside the fund and is
     already in the price) but it IS income for yield purposes.
   - Cash balances are outside return computations (no flow history for them).
   - Returns are pre-tax in every wrapper.
   ====================================================================== */

import { MS, dUTC, feeOf } from "./cgt-engine.mjs";
import { normWrapper } from "./portfolio.mjs";

const DAY_YEAR = 365;
const EPS = 1e-9;

const _num = (x) => (x === null || x === undefined || x === "" ? NaN : +x);
const _usableTrade = (t) =>
  t && t.ticker && (t.side === "BUY" || t.side === "SELL") &&
  Number.isFinite(_num(t.gbpAmount)) && _num(t.quantity) > 0;

/* -------------------------------- XIRR ------------------------------- */
// flows: [{ date: "YYYY-MM-DD", amount }] — investor-pocket signs.
// Returns { rate, spanDays, converged, method } with rate=null + reason when
// not computable. Newton from 0.1; grid-bracketed bisection fallback.
// Note: sign-alternating flow patterns can have multiple IRR roots; typical
// invest-then-receive patterns have exactly one, which is what this finds.
export function xirr(flows, { maxIter = 100, tol = 1e-10 } = {}) {
  const fs = (flows || [])
    .filter((f) => f && f.date && Number.isFinite(_num(f.amount)) && _num(f.amount) !== 0)
    .map((f) => ({ t: dUTC(f.date).getTime(), amount: _num(f.amount) }))
    .sort((a, b) => a.t - b.t);
  if (fs.length < 2) return { rate: null, reason: "needs at least two non-zero cashflows" };
  if (!fs.some((f) => f.amount > 0) || !fs.some((f) => f.amount < 0))
    return { rate: null, reason: "needs both money in and money out" };

  const t0 = fs[0].t;
  const yrs = fs.map((f) => (f.t - t0) / (DAY_YEAR * MS));
  const spanDays = Math.round((fs[fs.length - 1].t - t0) / MS);
  if (spanDays === 0) return { rate: null, reason: "all cashflows fall on the same day", spanDays };

  const scale = fs.reduce((s, f) => s + Math.abs(f.amount), 0);
  const npv = (r) => { let s = 0; for (let i = 0; i < fs.length; i++) s += fs[i].amount / Math.pow(1 + r, yrs[i]); return s; };
  const dnpv = (r) => { let s = 0; for (let i = 0; i < fs.length; i++) s += (-yrs[i] * fs[i].amount) / Math.pow(1 + r, yrs[i] + 1); return s; };
  const ok = (r) => Number.isFinite(r) && r > -1 && Math.abs(npv(r)) <= 1e-7 * scale;

  // Newton–Raphson
  let r = 0.1;
  for (let i = 0; i < maxIter; i++) {
    const f = npv(r), d = dnpv(r);
    if (!Number.isFinite(f) || !Number.isFinite(d) || d === 0) break;
    let rn = r - f / d;
    if (!Number.isFinite(rn)) break;
    if (rn <= -1) rn = (r - 1) / 2; // stay in the domain
    if (Math.abs(rn - r) < tol) { r = rn; break; }
    r = rn;
  }
  if (ok(r)) return { rate: r, spanDays, converged: true, method: "newton" };

  // Bisection fallback over a bracketing grid
  const grid = [-0.999999, -0.99, -0.9, -0.5, -0.2, 0, 0.2, 0.5, 1, 2, 5, 10, 50, 1000];
  let lo = null, hi = null;
  for (let i = 0; i < grid.length - 1; i++) {
    const a = npv(grid[i]), b = npv(grid[i + 1]);
    if (Number.isFinite(a) && Number.isFinite(b) && a * b <= 0) { lo = grid[i]; hi = grid[i + 1]; break; }
  }
  if (lo === null) return { rate: null, reason: "no rate solves the cashflows in (-100%, +100000%)", spanDays };
  for (let i = 0; i < 300; i++) {
    const mid = (lo + hi) / 2, fm = npv(mid);
    if (Math.abs(fm) <= 1e-9 * scale || hi - lo < 1e-12) { lo = hi = mid; break; }
    if (npv(lo) * fm <= 0) hi = mid; else lo = mid;
  }
  r = (lo + hi) / 2;
  if (ok(r)) return { rate: r, spanDays, converged: true, method: "bisection" };
  return { rate: null, reason: "solver did not converge", spanDays };
}

/* --------------------------- units & flows --------------------------- */
// Units held at end of `dateStr` within one (wrapper, ticker) row set.
export function unitsHeldAt(rows, dateStr) {
  let u = 0;
  for (const t of rows) if (_usableTrade(t) && t.date <= dateStr) u += t.side === "BUY" ? +t.quantity : -+t.quantity;
  return u;
}

// XIRR cashflows for one holding: trades + income received + terminal value.
// `incomeEvents`: [{ date, amount }] cash actually received (NOT ERI).
// Fees (separately-recorded dealing costs — see cgt-engine's feeOf) are
// money out of pocket: a BUY costs gbpAmount + fees, a SELL returns
// gbpAmount − fees, so XIRR is net of dealing costs.
export function holdingFlows({ rows, incomeEvents = [], marketValue = null, asOf }) {
  const flows = [];
  for (const t of rows) if (_usableTrade(t))
    flows.push({ date: t.date, amount: t.side === "BUY" ? -(+t.gbpAmount + feeOf(t)) : +t.gbpAmount - feeOf(t) });
  for (const e of incomeEvents) if (e && e.date && Number.isFinite(_num(e.amount)) && _num(e.amount) > 0)
    flows.push({ date: e.date, amount: _num(e.amount) });
  if (marketValue != null && Number.isFinite(marketValue) && marketValue > EPS && asOf)
    flows.push({ date: asOf, amount: marketValue, terminal: true });
  return flows;
}

/* ---------------------- per-holding time-weighted -------------------- */
// TWR over the CURRENT holding episode (since units last rose from zero) —
// or the final episode for a closed position. Unit prices come from the
// trades themselves (gbpAmount / quantity, quantity-weighted within a day);
// distributions are added to the end-of-period price and thus treated as
// reinvested (total-return convention). Open positions need `currentPrice`.
export function holdingTWR({ rows, incomeEvents = [], currentPrice = null, asOf }) {
  const trades = rows.filter(_usableTrade).slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (!trades.length) return { twr: null, reason: "no trades" };

  // Find the start of the current/last episode: last date units went 0 -> >0.
  let units = 0, episodeStartIdx = 0;
  for (let i = 0; i < trades.length; i++) {
    const before = units;
    units += trades[i].side === "BUY" ? +trades[i].quantity : -+trades[i].quantity;
    if (before <= EPS && units > EPS) episodeStartIdx = i;
  }
  const open = units > EPS;
  const ep = trades.slice(episodeStartIdx);

  // One valuation point per trade date: quantity-weighted unit price.
  const byDate = new Map();
  for (const t of ep) {
    const d = byDate.get(t.date) || { qty: 0, gbp: 0 };
    d.qty += +t.quantity; d.gbp += +t.gbpAmount;
    byDate.set(t.date, d);
  }
  const points = [...byDate.entries()]
    .map(([date, { qty, gbp }]) => ({ date, price: gbp / qty }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (open) {
    if (!Number.isFinite(currentPrice)) return { twr: null, reason: "open position with no current price" };
    if (!asOf) return { twr: null, reason: "asOf required for an open position" };
    if (asOf > points[points.length - 1].date) points.push({ date: asOf, price: currentPrice });
    else points[points.length - 1] = { date: points[points.length - 1].date, price: currentPrice };
  }
  if (points.length < 2) return { twr: null, reason: "single valuation point", spanDays: 0 };

  // Chain sub-period factors, folding in per-unit distributions.
  const inc = incomeEvents.filter((e) => e && e.date && _num(e.amount) > 0);
  let factor = 1;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    let perUnit = 0;
    for (const e of inc) {
      if (e.date > a.date && e.date <= b.date) {
        const u = unitsHeldAt(rows, e.date);
        if (u > EPS) perUnit += _num(e.amount) / u;
      }
    }
    if (a.price <= 0) return { twr: null, reason: "non-positive valuation point" };
    factor *= (b.price + perUnit) / a.price;
  }
  const spanDays = Math.round((dUTC(points[points.length - 1].date) - dUTC(points[0].date)) / MS);
  const twr = factor - 1;
  const annualised = spanDays > 0 ? Math.pow(1 + twr, DAY_YEAR / spanDays) - 1 : null;
  return { twr, annualised, spanDays, episodeStart: points[0].date, open };
}

/* --------------------- portfolio TWR from snapshots ------------------ */
// snapshots: [{ date, value }] portfolio (securities-only) valuations, one
// per date. flows: [{ date, amount }] where amount > 0 is external money INTO
// the securities portfolio (a BUY), negative is money out (SELL, income paid
// to cash). Flows within a period are applied at period END:
//   factor_i = (V_{i+1} - F_i) / V_i
// This is exact when snapshots coincide with flow dates (which they do when
// a snapshot is recorded on every trading/pricing day the app is used).
export function twrFromValuations({ snapshots = [], flows = [] } = {}) {
  const snaps = snapshots
    .filter((s) => s && s.date && Number.isFinite(_num(s.value)))
    .reduce((m, s) => m.set(s.date, _num(s.value)), new Map());
  const pts = [...snaps.entries()].map(([date, value]) => ({ date, value }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (pts.length < 2) return { twr: null, reason: `needs >= 2 valuation snapshots (have ${pts.length})` };

  let factor = 1;
  const periods = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (a.value <= EPS) return { twr: null, reason: `zero valuation on ${a.date}` };
    let F = 0;
    for (const f of flows) if (f && f.date > a.date && f.date <= b.date && Number.isFinite(_num(f.amount))) F += _num(f.amount);
    const p = (b.value - F) / a.value;
    periods.push({ from: a.date, to: b.date, flow: F, factor: p });
    factor *= p;
  }
  const spanDays = Math.round((dUTC(pts[pts.length - 1].date) - dUTC(pts[0].date)) / MS);
  const twr = factor - 1;
  const annualised = spanDays > 0 ? Math.pow(1 + twr, DAY_YEAR / spanDays) - 1 : null;
  return { twr, annualised, spanDays, periods, from: pts[0].date, to: pts[pts.length - 1].date };
}

/* ---------------------------- income yields -------------------------- */
// For one open holding:
//   trailing12m  = income received (incl. ERI, gross) in (asOf - 365d, asOf]
//   actualYield  = trailing12m / marketValue
//   forward      = sum of per-unit distributions in the trailing year,
//                  applied to the CURRENT unit count (so a position you've
//                  doubled shows double the forward income, not the trailing
//                  cash you happened to receive)
//   forwardYield = forward / marketValue
// Payments made while holding zero units can't produce a per-unit figure and
// are counted in `skippedPayments` rather than silently dropped.
const addDaysISO = (s, n) => new Date(dUTC(s).getTime() + n * MS).toISOString().slice(0, 10);

export function holdingIncome({ rows, incomeEvents = [], qty, marketValue = null, asOf }) {
  const from = addDaysISO(asOf, -DAY_YEAR);
  let trailing = 0, perUnit = 0, skipped = 0;
  for (const e of incomeEvents) {
    if (!e || !e.date || !(_num(e.amount) > 0)) continue;
    if (e.date <= from || e.date > asOf) continue;
    trailing += _num(e.amount);
    const u = unitsHeldAt(rows, e.date);
    if (u > EPS) perUnit += _num(e.amount) / u; else skipped++;
  }
  const forward = perUnit * (qty || 0);
  const priced = marketValue != null && Number.isFinite(marketValue) && marketValue > EPS;
  return {
    trailing12m: trailing,
    actualYield: priced ? trailing / marketValue : null,
    forwardIncome: forward,
    forwardYield: priced ? forward / marketValue : null,
    skippedPayments: skipped,
  };
}

/* --------------------------- the orchestrator ------------------------ */
// One call the Returns view reads from. Inputs mirror buildWealthModel plus
// the valuation snapshot series. Closed positions are included in per-holding
// results (their XIRR is complete and final) and in wrapper/total flows.
export function computeReturns({
  txns = [], incomeEntries = [], eriTxns = [], prices = {}, valuations = [], asOf,
  // secMeta identifies SNAPSHOT-ONLY holdings (pension funds tagged with a
  // `provider`): their single consolidated ledger row is dated whenever it
  // was last edited, not when money was invested, so its "flow dates" are
  // meaningless for money-weighted return. The per-fund display already
  // suppresses their XIRR for exactly this reason — but the TOTAL used to
  // ingest those flows anyway, which inflated it wildly (found on a real
  // portfolio: a £550k pension snapshot "contributed" 11 days before its
  // valuation pushed total XIRR from 11.1% to 23.5%). Total money-weighted
  // return now EXCLUDES snapshot-only tickers' flows AND value; their real
  // XIRR lives in pensionXirrByWrapper() below, from true contribution
  // dates. total.xirrScope reports what was excluded so the UI can say so.
  secMeta = {},
} = {}) {
  const day = asOf || new Date().toISOString().slice(0, 10);

  // group trades by (wrapper, ticker)
  const groups = new Map();
  for (const t of txns) {
    if (!_usableTrade(t)) continue;
    const w = normWrapper(t.wrapper), key = `${w}\u0000${t.ticker}`;
    if (!groups.has(key)) groups.set(key, { wrapper: w, ticker: t.ticker, rows: [] });
    groups.get(key).rows.push(t);
  }
  // cash income received, by (wrapper, ticker) — ERI excluded (not cash)
  const cashIncome = new Map();
  for (const e of incomeEntries) {
    if (!e || !e.date || !(_num(e.amount) > 0) || !e.ticker) continue;
    const key = `${normWrapper(e.wrapper)}\u0000${e.ticker}`;
    (cashIncome.get(key) || cashIncome.set(key, []).get(key)).push({ date: e.date, amount: _num(e.amount) });
  }
  // ERI (notional, for yields only) — GIA by construction
  const eriIncome = new Map();
  for (const t of eriTxns) {
    if (!t || !t.date || !t.ticker || !(_num(t._gbp) > 0)) continue;
    const key = `${normWrapper(t.wrapper || "GIA")}\u0000${t.ticker}`;
    (eriIncome.get(key) || eriIncome.set(key, []).get(key)).push({ date: t.date, amount: _num(t._gbp) });
  }

  const perHolding = [];
  const wrapperFlows = new Map();   // XIRR flows per wrapper
  // Ledger-dated flows only (snapshot-only pension tickers excluded) —
  // the honest input set for the TOTAL money-weighted return.
  const ledgerFlows = [];
  let ledgerValue = 0, ledgerUnpriced = 0, snapshotOnlyCount = 0, snapshotOnlyValue = 0;
  const wrapperAgg = new Map();
  const addAgg = (w) => wrapperAgg.get(w) || wrapperAgg.set(w, {
    moneyIn: 0, moneyOut: 0, income: 0, value: 0, openPositions: 0, unpricedOpen: 0,
    trailing12m: 0, forwardIncome: 0, pricedValue: 0,
  }).get(w);

  for (const { wrapper, ticker, rows } of groups.values()) {
    const key = `${wrapper}\u0000${ticker}`;
    const qty = unitsHeldAt(rows, day);
    const open = qty > EPS;
    const price = prices[ticker];
    const priced = Number.isFinite(price);
    const marketValue = open && priced ? qty * price : open ? null : 0;

    const cashInc = cashIncome.get(key) || [];
    const eriInc = eriIncome.get(key) || [];
    const flows = holdingFlows({ rows, incomeEvents: cashInc, marketValue: open ? marketValue : null, asOf: day });

    const moneyIn = rows.filter((t) => _usableTrade(t) && t.side === "BUY").reduce((s, t) => s + +t.gbpAmount + feeOf(t), 0);
    const moneyOut = rows.filter((t) => _usableTrade(t) && t.side === "SELL").reduce((s, t) => s + +t.gbpAmount - feeOf(t), 0);
    const incomeReceived = cashInc.reduce((s, e) => s + e.amount, 0);
    const profit = (open && !priced) ? null : moneyOut + incomeReceived + (marketValue || 0) - moneyIn;

    const x = (open && !priced)
      ? { rate: null, reason: "open position with no current price" }
      : xirr(flows);
    const t = holdingTWR({ rows, incomeEvents: [...cashInc, ...eriInc], currentPrice: priced ? price : null, asOf: day });
    const inc = open
      ? holdingIncome({ rows, incomeEvents: [...cashInc, ...eriInc], qty, marketValue, asOf: day })
      : { trailing12m: 0, actualYield: null, forwardIncome: 0, forwardYield: null, skippedPayments: 0 };

    perHolding.push({
      wrapper, ticker, open, qty, marketValue, priced: open ? priced : true,
      firstDate: rows.reduce((m, r) => (_usableTrade(r) && (!m || r.date < m) ? r.date : m), null),
      moneyIn, moneyOut, incomeReceived, profit,
      simpleReturn: profit != null && moneyIn > 0 ? profit / moneyIn : null,
      xirr: x, twr: t, income: inc,
    });

    // wrapper aggregation
    if (!wrapperFlows.has(wrapper)) wrapperFlows.set(wrapper, []);
    wrapperFlows.get(wrapper).push(...flows.filter((f) => !f.terminal));
    // total-XIRR input set: ledger-dated holdings only (see header note)
    if (secMeta[ticker]?.provider) {
      snapshotOnlyCount += 1;
      if (open && priced) snapshotOnlyValue += marketValue;
    } else {
      ledgerFlows.push(...flows.filter((f) => !f.terminal));
      if (open && priced) ledgerValue += marketValue;
      if (open && !priced) ledgerUnpriced += 1;
    }
    const agg = addAgg(wrapper);
    agg.moneyIn += moneyIn; agg.moneyOut += moneyOut; agg.income += incomeReceived;
    if (open) {
      agg.openPositions += 1;
      if (priced) { agg.value += marketValue; agg.pricedValue += marketValue; agg.trailing12m += inc.trailing12m; agg.forwardIncome += inc.forwardIncome; }
      else agg.unpricedOpen += 1;
    }
  }

  const byWrapper = {};
  const totalFlows = [];
  const total = { moneyIn: 0, moneyOut: 0, income: 0, value: 0, openPositions: 0, unpricedOpen: 0, trailing12m: 0, forwardIncome: 0, pricedValue: 0 };
  for (const [w, agg] of wrapperAgg) {
    const flows = wrapperFlows.get(w).slice();
    if (agg.value > EPS) flows.push({ date: day, amount: agg.value, terminal: true });
    const x = agg.unpricedOpen > 0
      ? { rate: null, reason: `${agg.unpricedOpen} open holding(s) without a price` }
      : xirr(flows);
    const profit = agg.unpricedOpen > 0 ? null : agg.moneyOut + agg.income + agg.value - agg.moneyIn;
    byWrapper[w] = {
      ...agg, profit,
      simpleReturn: profit != null && agg.moneyIn > 0 ? profit / agg.moneyIn : null,
      xirr: x,
      actualYield: agg.pricedValue > EPS ? agg.trailing12m / agg.pricedValue : null,
      forwardYield: agg.pricedValue > EPS ? agg.forwardIncome / agg.pricedValue : null,
    };
    totalFlows.push(...wrapperFlows.get(w));
    for (const k of ["moneyIn", "moneyOut", "income", "value", "openPositions", "unpricedOpen", "trailing12m", "forwardIncome", "pricedValue"]) total[k] += agg[k];
  }
  if (total.value > EPS) totalFlows.push({ date: day, amount: total.value, terminal: true });
  // Total money-weighted return from LEDGER-DATED flows only — snapshot-
  // only pension tickers excluded (their value too, or the solver would
  // see value with no matching cost and inflate the other way).
  if (ledgerValue > EPS) ledgerFlows.push({ date: day, amount: ledgerValue, terminal: true });
  const totalX = ledgerUnpriced > 0
    ? { rate: null, reason: `${ledgerUnpriced} open holding(s) without a price` }
    : xirr(ledgerFlows);
  totalX.xirrScope = { snapshotOnlyExcluded: snapshotOnlyCount, excludedValue: snapshotOnlyValue };
  const totalProfit = total.unpricedOpen > 0 ? null : total.moneyOut + total.income + total.value - total.moneyIn;

  // Portfolio TWR from the snapshot series; flows into the securities
  // portfolio: BUY positive, SELL negative, cash income negative. Fees are
  // included in the flow (money committed was gbpAmount + fees) so TWR is
  // net of dealing costs — the fee shows up as the drag it really is,
  // consistent with the XIRR treatment above.
  const twrFlows = [];
  for (const t of txns) if (_usableTrade(t)) twrFlows.push({ date: t.date, amount: t.side === "BUY" ? +t.gbpAmount + feeOf(t) : -(+t.gbpAmount - feeOf(t)) });
  for (const e of incomeEntries) if (e && e.date && _num(e.amount) > 0) twrFlows.push({ date: e.date, amount: -_num(e.amount) });
  const portfolioTWR = twrFromValuations({ snapshots: valuations, flows: twrFlows });

  perHolding.sort((a, b) => (a.open === b.open ? (a.wrapper + a.ticker).localeCompare(b.wrapper + b.ticker) : a.open ? -1 : 1));
  return {
    asOf: day,
    perHolding,
    byWrapper,
    total: {
      ...total, profit: totalProfit,
      simpleReturn: totalProfit != null && total.moneyIn > 0 ? totalProfit / total.moneyIn : null,
      xirr: totalX,
      actualYield: total.pricedValue > EPS ? total.trailing12m / total.pricedValue : null,
      forwardYield: total.pricedValue > EPS ? total.forwardIncome / total.pricedValue : null,
    },
    portfolioTWR,
  };
}

/* --------------------- pension XIRR by wrapper ------------------------ */
// Combined money-weighted return for the SIPP/LISA wrappers from REAL
// contribution dates (pensionCashflows), not the transaction ledger — the
// ledger only holds one consolidated snapshot per pension fund, not a
// purchase history, so computeReturns() above rightly shows nothing for
// them. This is the aggregation the Pension tab's per-provider XIRRs
// can't provide on their own: ALL providers' contribution flows for a
// wrapper are combined into ONE xirr() call with a single terminal value
// (the wrapper's current market value), which is the correct way to blend
// money-weighted returns — averaging per-provider rates would weight them
// wrongly. Zero providers → key absent; rows without a resolved GBP
// amount are excluded (an unresolved FX row isn't a £0 contribution),
// their count reported as `excludedFx`.
// Extracted from ReturnsTab (Fable pass, item 4) so Home's wrapper strip
// and the Returns tab share one tested implementation.
export function pensionXirrByWrapper({ txns = [], secMeta = {}, pensionCashflows = [], valueByWrapper = {}, today } = {}) {
  if (!today) throw new Error("pensionXirrByWrapper requires `today` — pure functions don't read the clock.");
  const out = {};
  for (const w of ["SIPP", "LISA"]) {
    // A provider belongs to this wrapper if any of its funds (secMeta
    // provider tag) has ledger rows in the wrapper.
    const providers = new Set(
      Object.entries(secMeta)
        .filter(([tk, m]) => m && m.provider && txns.some((t) => t.ticker === tk && normWrapper(t.wrapper) === w))
        .map(([, m]) => m.provider)
    );
    if (!providers.size) continue;
    const all = pensionCashflows.filter((c) => providers.has(c.provider));
    const usable = all.filter((c) => c.gbpAmount != null);
    if (!usable.length) continue;
    const flows = usable.map((c) => ({ date: c.date, amount: -Math.abs(c.gbpAmount) }));
    const currentValue = +valueByWrapper[w] || 0;
    if (currentValue > 0) flows.push({ date: today, amount: currentValue });
    out[w] = { ...xirr(flows), providers: providers.size, nCashflows: usable.length, excludedFx: all.length - usable.length };
  }
  return out;
}
