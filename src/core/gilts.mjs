/* ======================================================================
   GILT ENGINE (build step 4) — individual UK gilts as first-class
   instruments. Pure and React-free; see gilts.test.mjs.

   Conventions, verified against DMO / HMRC primary sources (2026-07):
   - Conventional gilts pay SEMI-ANNUAL coupons: half the annual rate on
     each coupon date, regardless of exact period length (periods run
     181–184 days). Quasi-coupon dates are the semi-annual cycle defined
     backwards from the maturity date. [DMO "About gilts"; yldeqns]
   - Accrued interest uses ACTUAL/ACTUAL (since 1 Nov 1998):
       AI per £100 = (coupon/2) x (days from prev coupon to settlement)
                                   / (days in the full coupon period)
     Entitlement follows SETTLEMENT date. [DMO convention-changes paper]
   - Ex-dividend: gilts go ex-div 7 BUSINESS days before the coupon date;
     a trade settling ON the ex-div date is still cum-div, AFTER it is
     ex-div, and accrued turns negative ("rebate interest"):
       AI per £100 = -(coupon/2) x (days from settlement to next coupon)
                                    / (days in period)
     [HMRC SAIM4020; DMO]. Business days here skip weekends only — UK bank
     holidays are NOT modelled, so an ex-div boundary that abuts a bank
     holiday can be off by a day or two. Flagged, not hidden.
   - Dirty price = clean price + accrued. Gilts redeem at par (£100 per
     £100 nominal) plus the final coupon on the maturity date.
   - CGT: individual gilts are exempt (TCGA 1992 s115 — enforced in
     portfolio.mjs); coupons are taxable savings income in taxable wrappers.
   - Accrued Income Scheme [HMRC HS343 / SAIM4020-4210, ACCA]:
       cum-div SELL -> accrued received is an accrued income PROFIT;
       cum-div BUY  -> accrued paid is RELIEF (a loss);
       ex-div  SELL -> rebate interest is RELIEF for the seller;
       ex-div  BUY  -> rebate interest is a PROFIT for the buyer.
     One sign rule covers all four: taxable = (SELL ? +1 : -1) x accrued.
     The event is taxed in the tax year in which the NEXT coupon after the
     transfer falls (interest-period end), profits and losses pooled per
     year. Exclusion: the scheme does not apply if total nominal held never
     exceeds £5,000 in that tax year or the preceding one.
   - Approximation: the ledger records TRADE dates, not settlement dates
     (gilts settle T+1). All settlement-based computations here use the
     trade date and say so. Near a coupon/ex-div boundary this can shift a
     figure by a day's accrual or flip cum/ex — check contract notes.

   Unit convention for the app: gilt `quantity` = £ nominal; prices are
   handled per £100 nominal inside this module, with the app's per-unit
   price being clean price / 100 (e.g. £94.23 per £100 -> 0.9423/unit).
   ====================================================================== */

import { MS, dUTC, ukTaxYear } from "./cgt-engine.mjs";
import { xirr } from "./returns.mjs";

const EPS = 1e-9;
const iso = (d) => d.toISOString().slice(0, 10);
const daysBetween = (aISO, bISO) => Math.round((dUTC(bISO) - dUTC(aISO)) / MS);

// Add n months to an ISO date, clamping to the target month's last day
// (31 May -6mo -> 30 Nov), matching how a coupon cycle anchored on a
// month-end maturity behaves.
export function addMonthsClamped(s, n) {
  const [y, m, d] = s.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return iso(target);
}

/* --------------------------- coupon schedule -------------------------- */
// The semi-annual quasi-coupon cycle, generated BACKWARDS from maturity so
// clamping is anchored on the maturity day-of-month.
export function couponDates(gilt, fromISO, toISO) {
  const out = [];
  const to = toISO || gilt.maturity;
  for (let i = 0; ; i++) {
    const d = addMonthsClamped(gilt.maturity, -6 * i);
    if (d < fromISO) break;
    if (d <= to) out.push(d);
    if (i > 400) break; // safety: 200 years
  }
  return out.reverse();
}

// Quasi-coupon dates straddling a settlement date: prev <= settlement < next.
export function prevNextCoupon(gilt, settlementISO) {
  let next = gilt.maturity, i = 0;
  for (;;) {
    const d = addMonthsClamped(gilt.maturity, -6 * i);
    if (d <= settlementISO) return { prev: d, next };
    next = d; i++;
    if (i > 400) return { prev: null, next };
  }
}

// n business days (weekends skipped; bank holidays NOT modelled) before a date.
export function businessDaysBefore(dateISO, n) {
  let d = dUTC(dateISO), left = n;
  while (left > 0) {
    d = new Date(d.getTime() - MS);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return iso(d);
}

/* --------------------------- accrued interest ------------------------- */
// Accrued per £100 nominal at a settlement date (trade date used as a T+1
// proxy by callers — see header). Negative during the ex-div period.
export function accruedPer100(gilt, settlementISO, { exDivBusinessDays = 7 } = {}) {
  if (settlementISO >= gilt.maturity) return { accrued: 0, prev: gilt.maturity, next: null, exDiv: false, periodDays: 0 };
  const { prev, next } = prevNextCoupon(gilt, settlementISO);
  const periodDays = daysBetween(prev, next);
  const half = gilt.coupon / 2;
  const exDivDate = businessDaysBefore(next, exDivBusinessDays);
  const exDiv = settlementISO > exDivDate; // ON the ex-div date is still cum-div
  const accrued = exDiv
    ? -half * (daysBetween(settlementISO, next) / periodDays)
    : half * (daysBetween(prev, settlementISO) / periodDays);
  return { accrued, prev, next, exDiv, exDivDate, periodDays };
}

export const cleanToDirty = (clean100, gilt, settlementISO, opts) => clean100 + accruedPer100(gilt, settlementISO, opts).accrued;
export const dirtyToClean = (dirty100, gilt, settlementISO, opts) => dirty100 - accruedPer100(gilt, settlementISO, opts).accrued;

/* --------------------------- projected cashflows ---------------------- */
// Future cashflows for `nominal` (£ face) strictly after fromISO, to
// maturity: each coupon = nominal x coupon/200; redemption at par.
export function projectCashflows(gilt, nominal, fromISO) {
  const flows = [];
  // couponDates includes dates >= fromISO; the <= skip below makes this
  // "strictly after fromISO" per the contract.
  for (const d of couponDates(gilt, fromISO, gilt.maturity)) {
    if (d <= fromISO) continue;
    flows.push({ date: d, type: "coupon", amount: (nominal * gilt.coupon) / 200 });
  }
  flows.push({ date: gilt.maturity, type: "redemption", amount: nominal });
  return flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === "coupon" ? -1 : 1));
}

/* ------------------------ gross redemption yield ---------------------- */
// GRY from a CLEAN price per £100: pay the dirty price today, receive the
// remaining coupons (excluding the next one if settling ex-div) and par.
// Solved with the tested XIRR engine, so this is the EFFECTIVE ANNUAL yield
// (365-day, annual compounding); `semiAnnual` converts to the street/DMO
// semi-annual-compounding convention: y_semi = 2((1+r)^(1/2) - 1).
export function grossRedemptionYield(gilt, clean100, settlementISO, opts = {}) {
  if (settlementISO >= gilt.maturity) return { effectiveAnnual: null, semiAnnual: null, reason: "matured" };
  const ai = accruedPer100(gilt, settlementISO, opts);
  const dirty = clean100 + ai.accrued;
  const flows = [{ date: settlementISO, amount: -dirty }];
  for (const f of projectCashflows(gilt, 100, settlementISO)) {
    if (f.type === "coupon" && ai.exDiv && f.date === ai.next) continue; // ex-div: next coupon goes to the seller
    flows.push({ date: f.date, amount: f.amount });
  }
  const r = xirr(flows);
  if (r.rate == null) return { effectiveAnnual: null, semiAnnual: null, reason: r.reason, dirty };
  return { effectiveAnnual: r.rate, semiAnnual: 2 * (Math.sqrt(1 + r.rate) - 1), dirty, accrued: ai.accrued, spanDays: r.spanDays };
}

/* ------------------------ Accrued Income Scheme ----------------------- */
// AIS items for one gilt's trades (quantity = £ nominal; trade date used as
// settlement proxy). taxable = (SELL ? +1 : -1) x accrued-value — this single
// rule reproduces HMRC's four cases (see header). Taxed in the tax year of
// the next coupon after the transfer; pooled per year by the caller.
export function aisItems(gilt, rows, opts = {}) {
  const items = [];
  for (const t of rows) {
    if (!t || !t.date || !(t.side === "BUY" || t.side === "SELL") || !(+t.quantity > 0)) continue;
    if (t.date >= gilt.maturity) continue; // redemption is not a transfer
    const ai = accruedPer100(gilt, t.date, opts);
    const accruedValue = (ai.accrued * +t.quantity) / 100;
    const taxable = (t.side === "SELL" ? 1 : -1) * accruedValue;
    items.push({
      date: t.date, side: t.side, nominal: +t.quantity,
      accruedPer100: ai.accrued, accruedValue, exDiv: ai.exDiv,
      taxable, taxYear: ukTaxYear(ai.next), couponDate: ai.next,
    });
  }
  return items;
}

/* ----------------------------- orchestrator --------------------------- */
// Everything the Gilts view needs. Inputs:
//   txns      — full ledger (any wrapper); gilt rows selected by secMeta kind
//   secMeta   — { ticker: { kind: "gilt", coupon, maturity, isin, name } }
//   prices    — { ticker: CLEAN price per £1 nominal (i.e. clean100 / 100) }
//   asOf      — valuation date
// AIS is computed for GIA rows only (sheltered wrappers owe no income tax).
const isGiltMeta = (m) => m && m.kind === "gilt" && Number.isFinite(+m.coupon) && typeof m.maturity === "string" && /^\d{4}-\d{2}-\d{2}$/.test(m.maturity);

export function giltAnalytics({ txns = [], secMeta = {}, prices = {}, asOf } = {}) {
  const day = asOf || iso(new Date());
  const holdings = [];
  const groups = new Map();
  for (const t of txns) {
    if (!t || !t.ticker || !(t.side === "BUY" || t.side === "SELL") || !(+t.quantity > 0)) continue;
    const m = secMeta[t.ticker];
    if (!isGiltMeta(m)) continue;
    const w = (t.wrapper || "GIA").toUpperCase();
    const key = `${w}\u0000${t.ticker}`;
    if (!groups.has(key)) groups.set(key, { wrapper: w, ticker: t.ticker, rows: [] });
    groups.get(key).rows.push(t);
  }

  const allCashflows = [];
  const aisByYear = {};
  let maxNominalGIA = 0; // rough small-holdings signal: peak GIA gilt nominal ever held

  for (const { wrapper, ticker, rows } of groups.values()) {
    const m = secMeta[ticker];
    const gilt = { coupon: +m.coupon, maturity: m.maturity };
    let nominal = 0;
    const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    let running = 0, peak = 0;
    for (const t of sorted) { running += t.side === "BUY" ? +t.quantity : -+t.quantity; peak = Math.max(peak, running); }
    nominal = running;
    if (wrapper === "GIA") maxNominalGIA += peak; // conservative upper bound across gilts

    const matured = day >= gilt.maturity;
    const pricePerUnit = prices[ticker];
    const clean100 = Number.isFinite(pricePerUnit) ? pricePerUnit * 100 : null;
    const ai = matured ? null : accruedPer100(gilt, day);
    const gry = !matured && clean100 != null ? grossRedemptionYield(gilt, clean100, day) : null;
    const future = nominal > EPS && !matured ? projectCashflows(gilt, nominal, day) : [];
    const next12m = future.filter((f) => f.type === "coupon" && f.date <= addMonthsClamped(day, 12)).reduce((s, f) => s + f.amount, 0);
    for (const f of future) allCashflows.push({ ...f, ticker, wrapper });

    holdings.push({
      wrapper, ticker, isin: m.isin || "", name: m.name || ticker,
      coupon: gilt.coupon, maturity: gilt.maturity, matured,
      nominal,
      clean100, accruedPer100: ai ? ai.accrued : 0,
      dirty100: clean100 != null && ai ? clean100 + ai.accrued : null,
      dirtyValue: clean100 != null && ai && nominal > EPS ? ((clean100 + ai.accrued) * nominal) / 100 : null,
      accruedValue: ai && nominal > EPS ? (ai.accrued * nominal) / 100 : 0,
      exDiv: ai ? ai.exDiv : false,
      nextCoupon: ai ? { date: ai.next, amount: (nominal * gilt.coupon) / 200 } : null,
      gry,
      couponIncomeNext12m: next12m,
    });

    if (wrapper === "GIA") {
      for (const item of aisItems(gilt, sorted)) {
        (aisByYear[item.taxYear] ||= { net: 0, items: [] });
        aisByYear[item.taxYear].net += item.taxable;
        aisByYear[item.taxYear].items.push({ ...item, ticker });
      }
    }
  }

  allCashflows.sort((a, b) => (a.date < b.date ? -1 : 1));
  holdings.sort((a, b) => (a.maturity < b.maturity ? -1 : 1));
  return {
    asOf: day,
    holdings,
    cashflows: allCashflows,
    ais: {
      byYear: aisByYear,
      // Exclusion heuristic only: the statutory test is nominal held on any
      // day in the interest-period tax year or the preceding one; peak-ever
      // GIA nominal is a conservative signal the UI explains, not a ruling.
      smallHoldingsLikelyExcluded: maxNominalGIA <= 5000,
      maxNominalGIA,
    },
  };
}
