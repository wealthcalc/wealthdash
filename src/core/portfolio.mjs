/* ======================================================================
   WEALTH CORE — the unified portfolio model (build step 1).

   Promotes `wrapper` from a CGT tax-filter flag to a first-class data
   dimension. Every holding belongs to a (wrapper, ticker) pool; the model
   rolls up ACROSS wrappers (total wealth) or WITHIN one, with tax logic
   gated to where it applies:
     - GIA (unsheltered): CGT on disposals + income tax on dividends/interest
     - ISA / SIPP / LISA (sheltered): no CGT, no income tax
     - individual gilts (any wrapper): CGT-EXEMPT (TCGA 1992 s115), but the
       coupon is taxable as savings income where the wrapper is taxable.

   Tax facts verified against GOV.UK / HMRC (CG54900, TCGA92/S115) and
   current guidance, 2026-07. Gilt *funds* are NOT exempt — only individual
   gilts — so exemption is driven by explicit instrument classification,
   never inferred from an ISIN.

   Pure and React-free: reuses the single tested CGT matching engine for
   pooling, so a GIA holding's book cost is identical to what a future S104
   disposal leg would use. Runs under `node --test`; see portfolio.test.mjs.
   ====================================================================== */

import { matchWithPool } from "./cgt-engine.mjs";

const EPS = 1e-9;

/* ----------------------------- wrappers ----------------------------- */
// taxable = subject to UK CGT and income tax on this wrapper's returns.
// Unknown wrappers default to taxable (conservative: never silently drop tax).
export const WRAPPER_META = {
  GIA: { label: "General Investment Account", taxable: true, sheltered: false },
  ISA: { label: "Individual Savings Account", taxable: false, sheltered: true },
  SIPP: { label: "Self-Invested Personal Pension", taxable: false, sheltered: true },
  LISA: { label: "Lifetime ISA", taxable: false, sheltered: true },
};
export const WRAPPERS = ["GIA", "ISA", "SIPP", "LISA"];

export const normWrapper = (w) => (w == null || w === "" ? "GIA" : String(w).toUpperCase());
export const wrapperMeta = (w) => WRAPPER_META[normWrapper(w)] || { label: normWrapper(w), taxable: true, sheltered: false };
export const isWrapperTaxable = (w) => wrapperMeta(w).taxable;

/* ------------------------ instrument classification ----------------- */
// secMeta row shape (superset of the existing seed): { isin, name, domicile,
// eri, kind?, bondFund? }. `kind` is authoritative when present; otherwise a
// safe default is inferred. Recognised kinds:
//   equity | fund | investment_trust | gilt | cash
// - cgtExempt: individual gilts only (kind === "gilt"), or explicit cgtExempt.
//   NOT gilt funds / bond funds (those follow normal CGT rules).
// - incomeKind: "interest" for gilts, bond funds, and cash; else "dividend".
export function classifyInstrument(ticker, secMeta = {}) {
  const m = secMeta[ticker] || {};
  const kind = m.kind || (m.eri ? "fund" : "equity");
  const isGilt = kind === "gilt";
  const isBondFund = kind === "bond_fund" || m.bondFund === true;
  const cgtExempt = m.cgtExempt === true || isGilt;
  const incomeKind = m.incomeKind || (isGilt || isBondFund || kind === "cash" ? "interest" : "dividend");
  return {
    ticker,
    isin: m.isin || "",
    name: m.name || ticker,
    domicile: m.domicile || "",
    kind,
    eri: m.eri === true,
    bondFund: isBondFund,
    cgtExempt,
    incomeKind,
  };
}

// Whether a disposal of this instrument in this wrapper is within CGT scope.
export function isDisposalTaxable(wrapper, ticker, secMeta = {}) {
  return isWrapperTaxable(wrapper) && !classifyInstrument(ticker, secMeta).cgtExempt;
}
// Whether income (dividend/interest/coupon) in this wrapper is within scope.
export function isIncomeTaxable(wrapper) {
  return isWrapperTaxable(wrapper);
}

/* ------------------------------ positions --------------------------- */
// Build one open position per (wrapper, ticker) by running the shared CGT
// engine within each (wrapper, ticker) group. ERI cost-uplifts are applied
// only to the wrapper they belong to (GIA in practice — ERI is irrelevant in
// sheltered wrappers). Rows without a usable GBP amount/quantity are skipped
// so a half-entered ledger row can't poison a pool with NaN.
const _wt = (t) => `${normWrapper(t.wrapper)}\u0000${t.ticker}`;
// Coerce to a number, but treat null / undefined / "" as "no value" (NaN),
// since +null and +"" are 0 — which would silently let a half-entered ledger
// row (blank amount) count as a real £0 trade.
const _num = (x) => (x === null || x === undefined || x === "" ? NaN : +x);
const _usableTrade = (t) =>
  t && t.ticker && (t.side === "BUY" || t.side === "SELL") &&
  Number.isFinite(_num(t.gbpAmount)) && _num(t.quantity) > 0;
const _usableEri = (t) =>
  t && t.ticker && t.side === "ERI" && Number.isFinite(_num(t.gbpAmount));

export function buildPositions({ txns = [], eriTxns = [], secMeta = {} } = {}) {
  const groups = new Map();
  const push = (t) => {
    const key = _wt(t);
    if (!groups.has(key)) groups.set(key, { wrapper: normWrapper(t.wrapper), ticker: t.ticker, rows: [] });
    groups.get(key).rows.push({ ...t, quantity: +t.quantity || 0, gbpAmount: +t.gbpAmount || 0 });
  };
  for (const t of txns) if (_usableTrade(t)) push(t);
  // ERI synthetic rows default to the GIA wrapper (they only exist for GIA).
  for (const t of eriTxns) if (_usableEri(t)) push({ ...t, wrapper: normWrapper(t.wrapper || "GIA") });

  const positions = [];
  for (const { wrapper, ticker, rows } of groups.values()) {
    const { poolQty, poolCost } = matchWithPool(rows);
    if (poolQty <= EPS) continue; // closed position — not a current holding
    const info = classifyInstrument(ticker, secMeta);
    positions.push({
      wrapper, ticker,
      isin: info.isin, name: info.name, domicile: info.domicile,
      kind: info.kind, eri: info.eri, cgtExempt: info.cgtExempt, incomeKind: info.incomeKind,
      qty: poolQty,
      bookCost: poolCost,
      avgCost: poolQty > 0 ? poolCost / poolQty : 0,
    });
  }
  positions.sort((a, b) => a.wrapper.localeCompare(b.wrapper) || a.ticker.localeCompare(b.ticker));
  return positions;
}

/* ------------------------------ valuation --------------------------- */
// prices: { ticker: gbpPricePerUnit } (already normalised to GBP upstream).
// Unpriced holdings carry marketValue = null and priced = false so views can
// value what they can and flag the rest rather than silently under-counting.
export function valuePositions(positions, prices = {}) {
  return positions.map((p) => {
    const price = prices[p.ticker];
    const priced = Number.isFinite(price);
    const marketValue = priced ? p.qty * price : null;
    const unrealised = priced ? marketValue - p.bookCost : null;
    const unrealisedPct = priced && p.bookCost > 0 ? unrealised / p.bookCost : null;
    return { ...p, price: priced ? price : null, priced, marketValue, unrealised, unrealisedPct };
  });
}

/* ------------------------------ roll-ups ---------------------------- */
const _blankAgg = () => ({
  marketValue: 0, bookCost: 0, bookCostPriced: 0, unrealised: 0,
  positions: 0, priced: 0, unpriced: 0, unpricedTickers: [], cash: 0, total: 0,
});
function _fold(agg, p) {
  agg.positions += 1;
  agg.bookCost += p.bookCost;
  if (p.priced) {
    agg.priced += 1;
    agg.marketValue += p.marketValue;
    agg.bookCostPriced += p.bookCost;
    agg.unrealised += p.unrealised;
  } else {
    agg.unpriced += 1;
    agg.unpricedTickers.push(p.ticker);
  }
}

// Per-wrapper subtotals. `cash` is an optional { wrapper: gbpBalance } map so
// total wealth includes uninvested balances, not just priced holdings.
export function rollupByWrapper(valued, cash = {}) {
  const out = {};
  for (const p of valued) {
    const w = normWrapper(p.wrapper);
    (out[w] ||= _blankAgg());
    _fold(out[w], p);
  }
  const norm = {};
  for (const [w, c] of Object.entries(cash)) norm[normWrapper(w)] = (norm[normWrapper(w)] || 0) + (+c || 0);
  for (const w of new Set([...Object.keys(out), ...Object.keys(norm)])) {
    const agg = (out[w] ||= _blankAgg());
    agg.cash = norm[w] || 0;
    agg.total = agg.marketValue + agg.cash;
    agg.taxable = isWrapperTaxable(w);
    agg.label = wrapperMeta(w).label;
  }
  return out;
}

// Consolidated total across every wrapper + cash.
export function totalWealth(valued, cash = {}) {
  const byWrapper = rollupByWrapper(valued, cash);
  const total = _blankAgg();
  for (const agg of Object.values(byWrapper)) {
    total.marketValue += agg.marketValue;
    total.bookCost += agg.bookCost;
    total.bookCostPriced += agg.bookCostPriced;
    total.unrealised += agg.unrealised;
    total.positions += agg.positions;
    total.priced += agg.priced;
    total.unpriced += agg.unpriced;
    total.unpricedTickers.push(...agg.unpricedTickers);
    total.cash += agg.cash;
  }
  total.total = total.marketValue + total.cash;
  return { byWrapper, total };
}

/* ------------------------------- income ----------------------------- */
// incomeEntries: { date, ticker, kind: "dividend"|"interest", amount(GBP), wrapper }.
// eriTxns: synthetic ERI rows carrying { _eri: { treatment }, _gbp, wrapper? }.
// Income is taxable only where the wrapper is taxable (GIA); sheltered wrappers
// still show gross income for the "see everything" view but contribute £0 tax.
export function incomeByWrapper({ incomeEntries = [], eriTxns = [] } = {}) {
  const blank = () => ({
    dividends: 0, interest: 0, total: 0,
    taxableDividends: 0, taxableInterest: 0, taxableTotal: 0,
  });
  const out = {};
  const add = (wrapper, kind, amt) => {
    const w = normWrapper(wrapper);
    const a = +amt || 0;
    if (!a) return;
    const bucket = (out[w] ||= blank());
    const k = kind === "interest" ? "interest" : "dividends";
    bucket[k] += a;
    bucket.total += a;
    if (isWrapperTaxable(w)) {
      bucket[k === "interest" ? "taxableInterest" : "taxableDividends"] += a;
      bucket.taxableTotal += a;
    }
  };
  for (const e of incomeEntries) if (e && e.date && e.amount) add(e.wrapper, e.kind, +e.amount);
  for (const t of eriTxns) if (t && t.date && t._eri) add(t.wrapper || "GIA", t._eri.treatment, t._gbp);

  const total = blank();
  for (const b of Object.values(out)) for (const k of Object.keys(total)) total[k] += b[k];
  return { byWrapper: out, total };
}

/* ---------------------------- allocation ---------------------------- */
// Break down priced market value by a dimension. Supported: "assetClass"
// (instrument kind), "geography" (domicile), "wrapper". Returns sorted
// buckets with a share of the priced total.
const _dimKey = {
  assetClass: (p) => p.kind || "unknown",
  geography: (p) => p.domicile || "unknown",
  wrapper: (p) => normWrapper(p.wrapper),
};
export function allocation(valued, dimension = "assetClass") {
  const keyOf = _dimKey[dimension] || _dimKey.assetClass;
  const buckets = new Map();
  let total = 0;
  for (const p of valued) {
    if (!p.priced) continue;
    const k = keyOf(p);
    buckets.set(k, (buckets.get(k) || 0) + p.marketValue);
    total += p.marketValue;
  }
  return [...buckets.entries()]
    .map(([key, marketValue]) => ({ key, marketValue, pct: total > 0 ? marketValue / total : 0 }))
    .sort((a, b) => b.marketValue - a.marketValue);
}

/* ------------------------- the unified model ------------------------ */
// One call the whole app reads from: positions, per-wrapper + consolidated
// roll-ups, income (with tax gating), and allocation primitives.
export function buildWealthModel({
  txns = [], eriTxns = [], incomeEntries = [], secMeta = {}, prices = {}, cash = {},
} = {}) {
  const positions = valuePositions(buildPositions({ txns, eriTxns, secMeta }), prices);
  const { byWrapper, total } = totalWealth(positions, cash);
  const income = incomeByWrapper({ incomeEntries, eriTxns });
  return {
    positions,
    byWrapper,
    total,
    cash,
    income,
    allocation: {
      assetClass: allocation(positions, "assetClass"),
      geography: allocation(positions, "geography"),
      wrapper: allocation(positions, "wrapper"),
    },
  };
}
