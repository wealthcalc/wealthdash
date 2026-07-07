/* ======================================================================
   ALLOWANCES ENGINE — ISA/LISA subscription tracking, pension annual
   allowance (with taper + 3-year carry-forward), realised-CGT headroom,
   and the Bed-and-ISA transfer solver. Pure and node-tested
   (allowances.test.mjs).

   Honesty notes (stated in the UI too):
   - ISA "subscriptions" are derived from BUY rows in ISA/LISA wrappers.
     That is an UPPER BOUND on new money: a purchase funded by a sale
     inside the same ISA is not a new subscription. A manual override
     always wins where the user knows better.
   - Pension annual allowance testing uses total contributions recorded in
     the app (provider statements usually include employer rows). The
     taper needs ADJUSTED income (salary + employer contributions, etc.);
     we use the app's income figure as a proxy and say so.
   ====================================================================== */

import { ukTaxYear } from "./cgt-engine.mjs";
import { classifyInstrument } from "./portfolio.mjs";

export const ISA_LIMIT = 20000;   // 2026/27 (LISA's £4,000 counts within it)
export const LISA_LIMIT = 4000;

/* ------------------------- ISA subscriptions -------------------------- */
// { taxYear: { ISA, LISA, total } } from BUY rows in ISA/LISA wrappers.
export function isaSubscriptionsByYear(txns = []) {
  const out = {};
  for (const t of txns) {
    if (!t || t.side !== "BUY" || !t.date) continue;
    const w = String(t.wrapper || "").toUpperCase();
    if (w !== "ISA" && w !== "LISA") continue;
    const amt = +t.gbpAmount;
    if (!Number.isFinite(amt) || amt <= 0) continue;
    const y = ukTaxYear(t.date);
    (out[y] ||= { ISA: 0, LISA: 0, total: 0 });
    out[y][w] += amt;
    out[y].total += amt;
  }
  return out;
}

/* ---------------------- pension annual allowance ---------------------- */
// AA by tax year (standard, before taper). 2016/17+ only — older years are
// out of carry-forward reach anyway.
const AA_BY_YEAR = (y) => {
  const start = Number(y.split("/")[0]);
  return start >= 2023 ? 60000 : 40000;
};
// Taper: 2023/24+ — £1 off per £2 of adjusted income over £260k, floor £10k.
// 2020/21–2022/23 — over £240k, floor £4k. (2016/17–2019/20 £150k threshold
// not modelled; flagged `approx` when it would matter.)
export function taperedAA(year, adjustedIncome = 0) {
  const start = Number(year.split("/")[0]);
  const base = AA_BY_YEAR(year);
  const [from, floor] = start >= 2023 ? [260000, 10000] : [240000, 4000];
  if (adjustedIncome <= from) return base;
  return Math.max(floor, base - Math.floor((adjustedIncome - from) / 2));
}

// { taxYear: grossContributions } from the pension cashflow ledger.
export function pensionContributionsByYear(cashflows = []) {
  const out = {};
  for (const c of cashflows) {
    if (!c || !c.date) continue;
    const amt = +c.gbpAmount;
    if (!Number.isFinite(amt) || amt <= 0) continue;
    out[ukTaxYear(c.date)] = (out[ukTaxYear(c.date)] || 0) + amt;
  }
  return out;
}

const prevTaxYear = (y) => {
  const a = Number(y.split("/")[0]) - 1;
  return `${a}/${String(a + 1).slice(-2)}`;
};

// Full AA position for `year`: this year's tapered allowance, contributions
// used, and carry-forward from the three preceding years (earliest first,
// which is also the order HMRC uses it in).
export function pensionAllowanceStatus({ cashflows = [], year, adjustedIncome = 0 } = {}) {
  const byYear = pensionContributionsByYear(cashflows);
  const aa = taperedAA(year, adjustedIncome);
  const used = byYear[year] || 0;
  const carry = [];
  let y = year;
  for (let i = 0; i < 3; i++) {
    y = prevTaxYear(y);
    const allowance = taperedAA(y, adjustedIncome); // proxy: same income each year
    const yUsed = byYear[y] || 0;
    carry.unshift({ year: y, allowance, used: yUsed, unused: Math.max(0, allowance - yUsed) });
  }
  const carryTotal = carry.reduce((s, c) => s + c.unused, 0);
  return {
    year, aa, used,
    tapered: aa < AA_BY_YEAR(year),
    headroom: Math.max(0, aa - used),
    carry, carryTotal,
    totalAvailable: Math.max(0, aa - used) + carryTotal,
    overBy: Math.max(0, used - aa - carryTotal),
  };
}

/* ----------------------- realised CGT headroom ------------------------ */
// Net realised position for one tax year from (already gilt-filtered)
// disposals: how much AEA is left for harvesting/bed-and-ISA.
export function realisedForYear(disposals = [], year, aea = 3000) {
  let gains = 0, losses = 0;
  for (const d of disposals) {
    if (!d || d.taxYear !== year) continue;
    if (d.gain > 0) gains += d.gain; else losses += -d.gain;
  }
  const net = gains - losses;
  return { year, gains, losses, net, aea, aeaLeft: Math.max(0, aea - Math.max(0, net)) };
}

/* ---------------------------- Bed & ISA ------------------------------- */
// Greedy fill: move as much GIA value as possible into the ISA without the
// realised gain exceeding `aeaLeft` or the cost exceeding `isaLeft`.
//   mode "value": lowest gain-per-£ first  -> maximises value sheltered
//   mode "gain":  highest gain-per-£ first -> maximises gain washed (base
//                 cost reset), the classic year-end harvesting objective.
// Costs are estimates: 0.5% stamp duty on the ISA repurchase for UK shares
// and investment trusts (ETFs/funds/gilts exempt), plus a user-set spread.
// The 30-day rule does NOT bite: a repurchase inside an ISA is not matched
// against the GIA disposal — that is the entire point of the manoeuvre.
export function bedAndIsaPlan({
  pools = {}, prices = {}, secMeta = {},
  aeaLeft = 0, isaLeft = 0, mode = "value",
  spreadPct = 0.0025, stampPct = 0.005,
} = {}) {
  const candidates = [];
  for (const [ticker, p] of Object.entries(pools)) {
    const qty = +p.qty, cost = +p.cost;
    const price = +prices[ticker];
    if (!(qty > 1e-9) || !Number.isFinite(price) || price <= 0) continue;
    const gps = price - cost / qty; // gain per share
    if (gps <= 0) continue;        // losses/no-gain: sell freely, no AEA needed
    candidates.push({ ticker, qty, price, gps, gainFrac: gps / price });
  }
  candidates.sort((a, b) => (mode === "gain" ? b.gainFrac - a.gainFrac : a.gainFrac - b.gainFrac));

  const rows = [];
  let aea = Math.max(0, aeaLeft), isa = Math.max(0, isaLeft);
  for (const c of candidates) {
    if (aea <= 1e-9 || isa <= 1e-9) break;
    const shares = Math.min(c.qty, aea / c.gps, isa / c.price);
    if (shares <= 1e-9) continue;
    const value = shares * c.price;
    const gain = shares * c.gps;
    const kind = classifyInstrument(c.ticker, secMeta).kind;
    const stampable = kind === "equity" || kind === "investment_trust";
    const stamp = stampable ? value * stampPct : 0;
    const spread = value * spreadPct;
    rows.push({
      ticker: c.ticker, kind,
      shares: Math.round(shares * 1e4) / 1e4,
      price: c.price,
      value: Math.round(value * 100) / 100,
      gain: Math.round(gain * 100) / 100,
      wholePosition: shares >= c.qty - 1e-9,
      stamp: Math.round(stamp * 100) / 100,
      spread: Math.round(spread * 100) / 100,
      costs: Math.round((stamp + spread) * 100) / 100,
    });
    aea -= gain; isa -= value;
  }
  const sum = (k) => Math.round(rows.reduce((s, r) => s + r[k], 0) * 100) / 100;
  return {
    rows, mode,
    totalValue: sum("value"), totalGain: sum("gain"), totalCosts: sum("costs"),
    aeaLeftAfter: Math.round(Math.max(0, aea) * 100) / 100,
    isaLeftAfter: Math.round(Math.max(0, isa) * 100) / 100,
  };
}
