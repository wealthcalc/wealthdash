import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addMonthsClamped, couponDates, prevNextCoupon, businessDaysBefore,
  accruedPer100, cleanToDirty, projectCashflows, grossRedemptionYield,
  aisItems, giltAnalytics,
} from "../core/gilts.mjs";

const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// Verified real gilts (identifiers confirmed 2026-07 from multiple sources):
const TG31 = { coupon: 0.25, maturity: "2031-07-31" };  // GB00BMGR2809, 31 Jan / 31 Jul
const TN28 = { coupon: 0.125, maturity: "2028-01-31" }; // GB00BMBL1G81, 31 Jan / 31 Jul
const T26A = { coupon: 0.375, maturity: "2026-10-22" }; // GB00BNNGP668, 22 Apr / 22 Oct
// Synthetic 8% gilt, coupons 7 Jun / 7 Dec (HS343's example security):
const G8 = { coupon: 8, maturity: "2028-06-07" };

/* --------------------------- coupon schedule -------------------------- */
test("coupon cycle runs backwards from maturity, semi-annually", () => {
  const ds = couponDates(TG31, "2026-01-01", "2027-12-31");
  assert.deepEqual(ds, ["2026-01-31", "2026-07-31", "2027-01-31", "2027-07-31"]);
});

test("month-end clamping: 31 May maturity pairs with 30 Nov", () => {
  const g = { coupon: 1, maturity: "2030-05-31" };
  const ds = couponDates(g, "2028-11-01", "2029-06-30");
  assert.deepEqual(ds, ["2028-11-30", "2029-05-31"]);
});

test("prevNextCoupon straddles the settlement date; on-coupon-date has zero accrual", () => {
  assert.deepEqual(prevNextCoupon(TG31, "2026-07-04"), { prev: "2026-01-31", next: "2026-07-31" });
  assert.deepEqual(prevNextCoupon(TG31, "2026-07-31"), { prev: "2026-07-31", next: "2027-01-31" });
  assert.ok(close(accruedPer100(TG31, "2026-07-31").accrued, 0));
});

/* --------------------------- accrued interest ------------------------- */
test("accrued: DMO actual/actual — 8% gilt, 30 days into a 182-day period", () => {
  // Period 2026-12-07 -> 2027-06-07 is 182 days; settle 2027-01-06 (30 days in).
  // AI = 4 x 30/182 = 0.65934... per £100.
  const ai = accruedPer100(G8, "2027-01-06");
  assert.equal(ai.prev, "2026-12-07");
  assert.equal(ai.next, "2027-06-07");
  assert.equal(ai.periodDays, 182);
  assert.ok(close(ai.accrued, 4 * 30 / 182, 1e-12));
  assert.equal(ai.exDiv, false);
});

test("accrued on £10,000 nominal matches hand arithmetic", () => {
  const ai = accruedPer100(G8, "2027-01-06");
  assert.ok(close((ai.accrued * 10000) / 100, 65.93406593, 1e-6));
});

test("ex-div date is 7 business days before the coupon; on-the-date is cum-div", () => {
  // TG31 coupon Fri 2026-07-31. Business days back: 30,29,28,27 (Thu..Mon),
  // 24,23,22 (Fri..Wed) -> ex-div date 2026-07-22.
  const cum = accruedPer100(TG31, "2026-07-22");
  const ex = accruedPer100(TG31, "2026-07-23");
  assert.equal(businessDaysBefore("2026-07-31", 7), "2026-07-22");
  assert.equal(cum.exDiv, false);
  assert.ok(cum.accrued > 0);
  assert.equal(ex.exDiv, true);
  assert.ok(ex.accrued < 0);
  // Rebate: -(0.125) x (days 23 Jul -> 31 Jul = 8) / 181  (31 Jan -> 31 Jul 2026 = 181 days)
  assert.equal(ex.periodDays, 181);
  assert.ok(close(ex.accrued, -(0.25 / 2) * 8 / 181, 1e-12));
});

test("clean/dirty round trip", () => {
  const dirty = cleanToDirty(94.23, TN28, "2026-07-04");
  const ai = accruedPer100(TN28, "2026-07-04");
  assert.ok(close(dirty, 94.23 + ai.accrued, 1e-12));
  assert.ok(ai.accrued > 0); // mid-period, cum-div
});

/* --------------------------- projected cashflows ---------------------- */
test("projectCashflows: TG31 from 2026-07-04 — 11 coupons then par + final coupon", () => {
  const flows = projectCashflows(TG31, 10000, "2026-07-04");
  const coupons = flows.filter((f) => f.type === "coupon");
  const redemption = flows.filter((f) => f.type === "redemption");
  // Coupon dates: 2026-07-31, then 31 Jan/31 Jul each year to 2031-07-31 = 11.
  assert.equal(coupons.length, 11);
  assert.ok(coupons.every((f) => close(f.amount, 10000 * 0.25 / 200))); // £12.50 each
  assert.equal(redemption.length, 1);
  assert.equal(redemption[0].date, "2031-07-31");
  assert.ok(close(redemption[0].amount, 10000));
  // final day carries coupon THEN redemption in sort order
  const last2 = flows.slice(-2);
  assert.equal(last2[0].type, "coupon");
  assert.equal(last2[1].type, "redemption");
});

/* ------------------------ gross redemption yield ---------------------- */
test("GRY: internal consistency with XIRR and price/yield direction", () => {
  const atPar = grossRedemptionYield(TG31, 100, "2026-07-04");
  const below = grossRedemptionYield(TG31, 80, "2026-07-04");
  assert.ok(atPar.effectiveAnnual != null && below.effectiveAnnual != null);
  // At par, yield is near the coupon (within a few bps; accrued/timing effects).
  assert.ok(Math.abs(atPar.effectiveAnnual - 0.0025) < 0.001);
  // Discounted price -> materially higher yield, and semi-annual < effective.
  assert.ok(below.effectiveAnnual > 0.04);
  assert.ok(below.semiAnnual < below.effectiveAnnual);
  // Conversion identity: (1 + y_semi/2)^2 = 1 + r
  assert.ok(close(Math.pow(1 + below.semiAnnual / 2, 2), 1 + below.effectiveAnnual, 1e-12));
});

test("GRY: ex-div settlement excludes the next coupon and nets rebate off the dirty price", () => {
  const cum = grossRedemptionYield(TG31, 80, "2026-07-22"); // cum-div boundary
  const ex = grossRedemptionYield(TG31, 80, "2026-07-23");  // ex-div
  assert.ok(cum.dirty > 80);         // positive accrued added
  assert.ok(ex.dirty < 80);          // rebate deducted
  assert.ok(cum.effectiveAnnual != null && ex.effectiveAnnual != null);
  // Same clean price, one coupon fewer but cheaper dirty — yields land close.
  assert.ok(Math.abs(cum.effectiveAnnual - ex.effectiveAnnual) < 0.005);
});

test("GRY: matured gilt is honestly null", () => {
  assert.equal(grossRedemptionYield(T26A, 99, "2026-10-22").effectiveAnnual, null);
});

/* ------------------------ Accrued Income Scheme ----------------------- */
test("AIS sign matrix: all four HMRC cases from one rule", () => {
  const cumBuy = aisItems(G8, [{ date: "2027-01-06", side: "BUY", quantity: 10000 }])[0];
  const cumSell = aisItems(G8, [{ date: "2027-01-06", side: "SELL", quantity: 10000 }])[0];
  assert.ok(cumBuy.taxable < 0);                       // relief
  assert.ok(close(cumBuy.taxable, -65.93406593, 1e-6));
  assert.ok(cumSell.taxable > 0);                      // profit
  assert.ok(close(cumSell.taxable, 65.93406593, 1e-6));

  // Ex-div window for the 2027-06-07 (Mon) coupon: 7 business days back
  const exDate = businessDaysBefore("2027-06-07", 7);
  const dayAfterEx = new Date(Date.parse(exDate + "T00:00:00Z") + 86400000).toISOString().slice(0, 10);
  const exSell = aisItems(G8, [{ date: dayAfterEx, side: "SELL", quantity: 10000 }])[0];
  const exBuy = aisItems(G8, [{ date: dayAfterEx, side: "BUY", quantity: 10000 }])[0];
  assert.equal(exSell.exDiv, true);
  assert.ok(exSell.taxable < 0); // seller keeps coupon -> relief for rebate
  assert.ok(exBuy.taxable > 0);  // buyer taxed on rebate interest
});

test("AIS timing: taxed in the tax year of the NEXT coupon, not the trade", () => {
  // Trade 2027-02-15 (tax year 2026/27); next G8 coupon 2027-06-07 -> 2027/28.
  const item = aisItems(G8, [{ date: "2027-02-15", side: "SELL", quantity: 10000 }])[0];
  assert.equal(item.couponDate, "2027-06-07");
  assert.equal(item.taxYear, "2027/28");
});

test("AIS: redemption is not a transfer", () => {
  assert.equal(aisItems(T26A, [{ date: "2026-10-22", side: "SELL", quantity: 10000 }]).length, 0);
});

/* ----------------------------- orchestrator --------------------------- */
const SEC = {
  TG31: { kind: "gilt", coupon: 0.25, maturity: "2031-07-31", isin: "GB00BMGR2809", name: "0¼% Treasury Gilt 2031" },
  TN28: { kind: "gilt", coupon: 0.125, maturity: "2028-01-31", isin: "GB00BMBL1G81", name: "0⅛% Treasury Gilt 2028" },
  CSP1: { isin: "IE00B5BMR087", eri: true }, // not a gilt — must be ignored
};

test("giltAnalytics: ladder holdings, cashflow calendar, AIS pooling", () => {
  const txns = [
    { id: "1", date: "2026-05-01", ticker: "TG31", side: "BUY", quantity: 10000, gbpAmount: 7800, wrapper: "GIA" },
    { id: "2", date: "2026-06-01", ticker: "TN28", side: "BUY", quantity: 20000, gbpAmount: 18850, wrapper: "GIA" },
    { id: "3", date: "2026-06-01", ticker: "TN28", side: "BUY", quantity: 5000, gbpAmount: 4712, wrapper: "ISA" },
    { id: "4", date: "2026-01-10", ticker: "CSP1", side: "BUY", quantity: 10, gbpAmount: 4000, wrapper: "GIA" },
  ];
  const g = giltAnalytics({ txns, secMeta: SEC, prices: { TG31: 0.80, TN28: 0.9423 }, asOf: "2026-07-04" });

  assert.equal(g.holdings.length, 3); // GIA TG31, GIA TN28, ISA TN28 — CSP1 ignored
  const tg31 = g.holdings.find((h) => h.ticker === "TG31");
  assert.ok(close(tg31.clean100, 80));
  assert.ok(tg31.accruedPer100 > 0);
  assert.equal(tg31.nextCoupon.date, "2026-07-31");
  assert.ok(close(tg31.nextCoupon.amount, 12.5)); // 10000 x 0.25/200
  assert.ok(close(tg31.couponIncomeNext12m, 25)); // Jul 2026 + Jan 2027
  assert.ok(tg31.gry.semiAnnual > 0.04);          // deep discount

  // ladder sorted by maturity: TN28 rows before TG31
  assert.equal(g.holdings[0].maturity, "2028-01-31");

  // cashflow calendar includes both wrappers' coupons and both redemptions
  assert.ok(g.cashflows.some((f) => f.ticker === "TN28" && f.wrapper === "ISA" && f.type === "coupon"));
  assert.equal(g.cashflows.filter((f) => f.type === "redemption").length, 3);

  // AIS: GIA only (2 buys mid-period -> relief), pooled into the coupon year
  const years = Object.keys(g.ais.byYear);
  assert.equal(years.length, 1);
  assert.equal(years[0], "2026/27"); // next coupons Jul 2026 & Jul 2026... TN28 next coupon 2026-07-31, TG31 2026-07-31
  assert.ok(g.ais.byYear["2026/27"].net < 0); // both buys = relief
  assert.equal(g.ais.byYear["2026/27"].items.length, 2); // ISA row excluded
  assert.equal(g.ais.smallHoldingsLikelyExcluded, false); // £30k GIA nominal
});

test("giltAnalytics: fully sold gilt shows zero nominal but keeps AIS history", () => {
  const txns = [
    { id: "1", date: "2026-05-01", ticker: "TG31", side: "BUY", quantity: 10000, gbpAmount: 7800, wrapper: "GIA" },
    { id: "2", date: "2026-06-15", ticker: "TG31", side: "SELL", quantity: 10000, gbpAmount: 7900, wrapper: "GIA" },
  ];
  const g = giltAnalytics({ txns, secMeta: SEC, prices: {}, asOf: "2026-07-04" });
  assert.ok(close(g.holdings[0].nominal, 0));
  assert.equal(g.cashflows.length, 0); // nothing held -> nothing projected
  const items = g.ais.byYear["2026/27"].items;
  assert.equal(items.length, 2);
  // buy relief < 0, sell profit > 0; sell accrued (45d) exceeds buy accrued (90d)? No:
  // buy 2026-05-01 is 90 days after 31 Jan; sell 2026-06-15 is 135 days after.
  // Net = (135 - 90)/181 x 0.125 x 100 = +£3.107 (profit).
  assert.ok(close(g.ais.byYear["2026/27"].net, ((135 - 90) / 181) * (0.25 / 2) * 100, 1e-6));
});
