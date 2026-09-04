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

   INDEX-LINKED GILTS (3-month lag, "new style", every linker issued since
   2005). Verified against DMO "Formulae for Calculating Gilt Prices from
   Yields" s.2 and the DMO's own daily D10B report:
   - Prices are quoted in REAL terms, per £100 of ORIGINAL nominal. The
     cash value is the real price x the INDEX RATIO:
       IR = RPI(reference date) / RPI(base), published daily by the DMO,
     and because the lag is 3 months the ratio for any date up to three
     months ahead is already KNOWN, not forecast.
     This is not a rounding detail: TG36's ratio is ~1.59, so treating the
     quoted real price as a cash price understates the holding by ~37%.
     Hence `prices[ticker]` for a linker holds the UPLIFTED price per £1
     nominal (real/100 x IR) — that way every other view in the app
     (Holdings, Wealth, allocation, Returns) values it correctly with no
     special-casing, since they all just multiply quantity by price.
   - Every cashflow is uplifted the same way: coupon = nominal x coupon/200
     x IR(coupon date), redemption = nominal x IR(maturity). Ratios beyond
     the known window depend on future RPI, so they are PROJECTED at an
     assumed inflation rate — an assumption, and labelled as one. Each
     cashflow therefore carries both `amount` (cash expected, uprated) and
     `realAmount` (today's purchasing power, i.e. uprating switched off).
     A conventional gilt has the two the other way round: its cash is
     fixed and its real value erodes, so `realAmount` there is the deflated
     figure. Same two columns, opposite behaviour — which is the whole
     point of holding both kinds.
   - The yield computed from real cashflows against the real dirty price is
     a REAL (after-inflation) yield, and is NOT comparable with a
     conventional gilt's GRY without adding inflation to it.
   - TAX: a linker is still CGT-exempt under TCGA 1992 s115, and the
     exemption covers the inflation uplift too — the whole capital uplift
     is tax-free, while the (small) coupon is taxable as savings income in
     an unsheltered wrapper.
   - NOT supported: pre-2005 EIGHT-month-lag linkers. They use a different
     formula (indexation applied to the coupon via published RPI values
     with rounding conventions, not a daily index ratio), so they are
     refused at registration rather than mismodelled.
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

/* ------------------------- index-linked uplift ------------------------ */
// The index ratio expected at `dateISO`, starting from the ratio the DMO
// publishes for today and growing at `inflation` (a decimal, e.g. 0.03).
// Conventional gilts return 1 at every date — the same code path, so a
// mixed ladder needs no branching downstream.
export function projectedIndexRatio(gilt, dateISO, fromISO, inflation = 0) {
  if (!gilt || !gilt.indexLinked) return 1;
  const base = Number.isFinite(+gilt.indexRatio) && +gilt.indexRatio > 0 ? +gilt.indexRatio : 1;
  if (!(inflation > 0) || !dateISO || !fromISO || dateISO <= fromISO) return base;
  return base * (1 + inflation) ** (daysBetween(fromISO, dateISO) / 365.25);
}

/* --------------------------- projected cashflows ---------------------- */
// Future cashflows for `nominal` (£ face) strictly after fromISO, to
// maturity: each coupon = nominal x coupon/200; redemption at par. For an
// index-linked gilt both are multiplied by the index ratio at their own
// date (see the header).
//
// Every flow carries TWO figures, because for a linker they answer
// different questions and neither alone is honest:
//   amount     — the cash expected to arrive, uplifted at `inflation`
//   realAmount — the same flow in TODAY's purchasing power
// For a conventional gilt `amount` is the contractual cash and
// `realAmount` is that cash deflated; for a linker it's the reverse.
export function projectCashflows(gilt, nominal, fromISO, { inflation = 0 } = {}) {
  const flows = [];
  const il = !!(gilt && gilt.indexLinked);
  const deflate = (d) => (inflation > 0 && d > fromISO ? (1 + inflation) ** -(daysBetween(fromISO, d) / 365.25) : 1);
  // For a linker, "today's money" means the uplift already earned (the
  // published ratio) with no further projection. For a conventional gilt it
  // means discounting the fixed cash back at the same inflation rate.
  const realFactor = (d) => (il ? projectedIndexRatio(gilt, d, fromISO, 0) : deflate(d));
  const cashFactor = (d) => (il ? projectedIndexRatio(gilt, d, fromISO, inflation) : 1);

  const push = (date, type, base) => flows.push({
    date, type,
    amount: base * cashFactor(date),
    realAmount: base * realFactor(date),
  });

  // couponDates includes dates >= fromISO; the <= skip below makes this
  // "strictly after fromISO" per the contract.
  for (const d of couponDates(gilt, fromISO, gilt.maturity)) {
    if (d <= fromISO) continue;
    push(d, "coupon", (nominal * gilt.coupon) / 200);
  }
  push(gilt.maturity, "redemption", nominal);
  return flows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.type === "coupon" ? -1 : 1));
}

/* ------------------------ gross redemption yield ---------------------- */
// GRY from a CLEAN price per £100: pay the dirty price today, receive the
// remaining coupons (excluding the next one if settling ex-div) and par.
// Solved with the tested XIRR engine, so this is the EFFECTIVE ANNUAL yield
// (365-day, annual compounding); `semiAnnual` converts to the street/DMO
// semi-annual-compounding convention: y_semi = 2((1+r)^(1/2) - 1).
// For an INDEX-LINKED gilt this is fed the REAL clean price and the index
// ratio cancels out of both sides (price and every cashflow), so what comes
// back is a REAL yield: the return above inflation, whatever inflation
// turns out to be. That is not comparable with a conventional gilt's GRY
// without adding expected inflation to it, so it's labelled `real: true`
// rather than quietly presented in the same column.
export function grossRedemptionYield(gilt, clean100, settlementISO, opts = {}) {
  if (settlementISO >= gilt.maturity) return { effectiveAnnual: null, semiAnnual: null, reason: "matured" };
  const ai = accruedPer100(gilt, settlementISO, opts);
  const dirty = clean100 + ai.accrued;
  const flows = [{ date: settlementISO, amount: -dirty }];
  // Uplift is deliberately switched off on both sides: a real price against
  // real cashflows.
  for (const f of projectCashflows({ ...gilt, indexLinked: false }, 100, settlementISO)) {
    if (f.type === "coupon" && ai.exDiv && f.date === ai.next) continue; // ex-div: next coupon goes to the seller
    flows.push({ date: f.date, amount: f.amount });
  }
  const r = xirr(flows);
  const real = !!gilt.indexLinked;
  if (r.rate == null) return { effectiveAnnual: null, semiAnnual: null, reason: r.reason, dirty, real };
  return { effectiveAnnual: r.rate, semiAnnual: 2 * (Math.sqrt(1 + r.rate) - 1), dirty, accrued: ai.accrued, spanDays: r.spanDays, real };
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
    // For a linker the accrued actually paid was uplifted by the index
    // ratio ON THE TRADE DATE. The app doesn't keep historic ratios, so
    // today's is used and the item says it's an estimate rather than
    // presenting an understated figure as exact.
    const ratio = gilt.indexLinked && Number.isFinite(+gilt.indexRatio) && +gilt.indexRatio > 0 ? +gilt.indexRatio : 1;
    const accruedValue = (ai.accrued * ratio * +t.quantity) / 100;
    const taxable = (t.side === "SELL" ? 1 : -1) * accruedValue;
    items.push({
      date: t.date, side: t.side, nominal: +t.quantity,
      accruedPer100: ai.accrued * ratio, accruedValue, exDiv: ai.exDiv,
      taxable, taxYear: ukTaxYear(ai.next), couponDate: ai.next,
      ratioEstimated: !!gilt.indexLinked,
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

// `inflation` (decimal) only affects INDEX-LINKED gilts' projected cash and
// conventional gilts' real-terms column; every figure it touches is
// reported alongside an untouched one, so nothing depends on it silently.
export function giltAnalytics({ txns = [], secMeta = {}, prices = {}, asOf, inflation = 0 } = {}) {
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
    const indexLinked = !!m.indexLinked;
    // The published ratio is a FACT (3-month lag means it's already known);
    // 1 for a conventional gilt, and 1 for a linker whose ratio hasn't been
    // fetched yet — which understates it, so `indexRatioMissing` says so
    // rather than letting the figure pass as complete.
    const indexRatio = indexLinked && Number.isFinite(+m.indexRatio) && +m.indexRatio > 0 ? +m.indexRatio : 1;
    const gilt = { coupon: +m.coupon, maturity: m.maturity, indexLinked, indexRatio };
    let nominal = 0;
    const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    let running = 0, peak = 0;
    for (const t of sorted) { running += t.side === "BUY" ? +t.quantity : -+t.quantity; peak = Math.max(peak, running); }
    nominal = running;
    if (wrapper === "GIA") maxNominalGIA += peak; // conservative upper bound across gilts

    const matured = day >= gilt.maturity;
    // prices[] holds the UPLIFTED price per £1 nominal for a linker (see
    // the header), so the REAL price the market quotes — and which the
    // yield must be computed against — is recovered by dividing it back out.
    const pricePerUnit = prices[ticker];
    const cashClean100 = Number.isFinite(pricePerUnit) ? pricePerUnit * 100 : null;
    const clean100 = cashClean100 == null ? null : cashClean100 / indexRatio;
    const ai = matured ? null : accruedPer100(gilt, day);
    const gry = !matured && clean100 != null ? grossRedemptionYield(gilt, clean100, day) : null;
    const future = nominal > EPS && !matured ? projectCashflows(gilt, nominal, day, { inflation }) : [];
    const in12m = addMonthsClamped(day, 12);
    const coupons12m = future.filter((f) => f.type === "coupon" && f.date <= in12m);
    const next12m = coupons12m.reduce((s, f) => s + f.amount, 0);
    const next12mReal = coupons12m.reduce((s, f) => s + f.realAmount, 0);
    for (const f of future) allCashflows.push({ ...f, ticker, wrapper, indexLinked });

    // Accrued and value are CASH figures: the real accrual uplifted by the
    // ratio, matching what the DMO's own dirty price shows for a linker.
    const accruedCash100 = ai ? ai.accrued * indexRatio : 0;
    holdings.push({
      wrapper, ticker, isin: m.isin || "", name: m.name || ticker,
      coupon: gilt.coupon, maturity: gilt.maturity, matured,
      nominal,
      indexLinked, indexRatio,
      indexRatioMissing: indexLinked && !(Number.isFinite(+m.indexRatio) && +m.indexRatio > 0),
      realClean100: clean100,
      clean100: cashClean100, accruedPer100: accruedCash100,
      realAccruedPer100: ai ? ai.accrued : 0,
      dirty100: cashClean100 != null && ai ? cashClean100 + accruedCash100 : null,
      dirtyValue: cashClean100 != null && ai && nominal > EPS ? ((cashClean100 + accruedCash100) * nominal) / 100 : null,
      accruedValue: ai && nominal > EPS ? (accruedCash100 * nominal) / 100 : 0,
      exDiv: ai ? ai.exDiv : false,
      nextCoupon: ai ? { date: ai.next, amount: ((nominal * gilt.coupon) / 200) * projectedIndexRatio(gilt, ai.next, day, inflation) } : null,
      gry,
      couponIncomeNext12m: next12m,
      couponIncomeNext12mReal: next12mReal,
      // Par at maturity is only "par" for a conventional gilt; a linker
      // redeems at nominal x the ratio then, which is the number that
      // actually matters for a ladder.
      redemptionValue: nominal > EPS && !matured ? nominal * projectedIndexRatio(gilt, gilt.maturity, day, inflation) : nominal,
      redemptionValueReal: nominal > EPS && !matured ? nominal * (indexLinked ? indexRatio : 1) : nominal,
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
    // What the projection assumed, so the UI never has to guess whether the
    // "cash" column contains a forecast.
    inflation,
    anyIndexLinked: holdings.some((h) => h.indexLinked),
    indexRatiosMissing: holdings.filter((h) => h.indexRatioMissing).map((h) => h.ticker),
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
