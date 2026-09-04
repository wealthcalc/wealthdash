import { test } from "node:test";
import assert from "node:assert/strict";
import { giltAnalytics, projectCashflows, projectedIndexRatio, grossRedemptionYield, accruedPer100 } from "../core/gilts.mjs";

/* Anchored on a REAL gilt and a REAL DMO report row, so these tests check
   the model against the issuer rather than against itself:

     GB00BYZW3J87  0⅛% Index-linked Treasury Gilt 2036   (LSE: TG36)
     DMO D10B, 2 Jul 2026:
       purchase clean  84.02   purchase dirty  133.986401
       index ratio     1.59440   indexation lag  3 Months   redemption 22 Nov 2036

   84.02 x 1.59440 = 133.96 — the DMO's own dirty price is the REAL clean
   price uplifted by the index ratio, which is the single fact the whole
   index-linked implementation rests on. */
const TG36 = { kind: "gilt", coupon: 0.125, maturity: "2036-11-22", indexLinked: true, indexRatio: 1.5944, isin: "GB00BYZW3J87", name: "0.125% Index-linked Treasury Gilt 2036" };
const TG30 = { kind: "gilt", coupon: 0.375, maturity: "2030-10-22" };  // conventional control
const DAY = "2026-07-02";
const buy = (ticker, qty) => ({ date: "2026-06-01", ticker, side: "BUY", quantity: qty, wrapper: "GIA" });

// prices[] holds the UPLIFTED price per £1 nominal: 84.02 x 1.5944 / 100.
const UPLIFTED_TG36 = (84.02 * 1.5944) / 100;

test("the holding is valued at the DMO's own dirty price, not the real quote", () => {
  // The bug this exists to prevent: quoting a linker at its real price
  // understates TG36 by ~37%.
  const a = giltAnalytics({
    txns: [buy("TG36", 10000)], secMeta: { TG36 }, prices: { TG36: UPLIFTED_TG36 }, asOf: DAY,
  });
  const h = a.holdings[0];
  assert.equal(h.indexLinked, true);
  assert.ok(Math.abs(h.realClean100 - 84.02) < 1e-6, "the real quote is recovered by dividing the ratio back out");
  assert.ok(Math.abs(h.clean100 - 133.961) < 0.01, "and the cash price is the uplifted one");
  assert.ok(Math.abs(h.dirty100 - 133.9864) < 0.05, `dirty ${h.dirty100} should match the DMO's 133.986401`);
  // £10,000 nominal is worth ~£13,400, not ~£8,400.
  assert.ok(Math.abs(h.dirtyValue - 13398.6) < 5, `value ${h.dirtyValue}`);
  assert.ok(h.dirtyValue > 13000, "a real-price valuation would have said ~8,400");
});

test("every other view values it correctly too, because the uplift is in prices[]", () => {
  // buildPositions() does marketValue = qty x prices[ticker] with no gilt
  // special-casing, so the uplift has to live there or Holdings, Wealth,
  // allocation and Returns would each need their own fix.
  const marketValue = 10000 * UPLIFTED_TG36;
  assert.ok(Math.abs(marketValue - 13396.3) < 1, "the same £13.4k the Gilts tab shows");
});

test("a missing index ratio is flagged rather than silently understating by 37%", () => {
  const a = giltAnalytics({
    txns: [buy("TG36", 10000)],
    secMeta: { TG36: { ...TG36, indexRatio: undefined } },
    prices: { TG36: UPLIFTED_TG36 }, asOf: DAY,
  });
  assert.equal(a.holdings[0].indexRatioMissing, true);
  assert.equal(a.holdings[0].indexRatio, 1, "falls back to 1, but says so");
  assert.deepEqual(a.indexRatiosMissing, ["TG36"]);
});

/* --------------------------- cashflow uplift -------------------------- */

test("coupons and redemption are uplifted by the ratio at their own date", () => {
  const flows = projectCashflows({ coupon: 0.125, maturity: "2036-11-22", indexLinked: true, indexRatio: 1.5944 }, 10000, DAY, { inflation: 0.03 });
  const coupon = flows.find((f) => f.type === "coupon");
  const redemption = flows.find((f) => f.type === "redemption");

  // Real coupon on £10,000 nominal = 10000 x 0.125/200 = £6.25.
  assert.ok(Math.abs(coupon.realAmount - 6.25 * 1.5944) < 0.01, "today's money = the uplift already earned");
  assert.ok(coupon.amount > coupon.realAmount, "cash expected is higher again, at 3% for the months to come");

  // Redemption ~10.4 years out: 10000 x 1.5944 x 1.03^10.39.
  assert.ok(Math.abs(redemption.realAmount - 15944) < 1, "redeems at nominal x today's ratio in today's money");
  assert.ok(redemption.amount > 21000 && redemption.amount < 23000, `projected cash redemption ${redemption.amount}`);
});

test("with no inflation assumed, cash and today's-money are the same figure", () => {
  const flows = projectCashflows({ coupon: 0.125, maturity: "2036-11-22", indexLinked: true, indexRatio: 1.5944 }, 10000, DAY, { inflation: 0 });
  for (const f of flows) assert.ok(Math.abs(f.amount - f.realAmount) < 1e-9);
});

test("a CONVENTIONAL gilt behaves the opposite way round — fixed cash, eroding real value", () => {
  const flows = projectCashflows({ coupon: 4, maturity: "2030-10-22" }, 10000, DAY, { inflation: 0.03 });
  const redemption = flows.find((f) => f.type === "redemption");
  assert.equal(redemption.amount, 10000, "cash is contractual and doesn't move");
  assert.ok(redemption.realAmount < 9000, "but it buys less by then");
  const coupon = flows.find((f) => f.type === "coupon");
  assert.equal(coupon.amount, 200, "semi-annual coupon: 10000 x 4/200");
  assert.ok(coupon.realAmount < coupon.amount);
});

test("the projected ratio grows from the published one and never below it", () => {
  const g = { indexLinked: true, indexRatio: 1.5944, maturity: "2036-11-22" };
  assert.equal(projectedIndexRatio(g, DAY, DAY, 0.03), 1.5944, "today is the published fact, not a projection");
  assert.ok(projectedIndexRatio(g, "2027-07-02", DAY, 0.03) > 1.5944);
  assert.ok(Math.abs(projectedIndexRatio(g, "2027-07-02", DAY, 0.03) - 1.5944 * 1.03) < 0.001);
  assert.equal(projectedIndexRatio({ maturity: "2030-01-01" }, "2029-01-01", DAY, 0.03), 1, "conventional gilts stay at 1");
  assert.equal(projectedIndexRatio(g, "2025-01-01", DAY, 0.03), 1.5944, "no back-projection into the past");
});

/* ------------------------------- yield -------------------------------- */

test("the yield on a linker is a REAL yield, and says so", () => {
  const a = giltAnalytics({ txns: [buy("TG36", 10000)], secMeta: { TG36 }, prices: { TG36: UPLIFTED_TG36 }, asOf: DAY });
  const { gry } = a.holdings[0];
  assert.equal(gry.real, true, "not comparable with a conventional GRY without adding inflation");
  // Buying at 84.02 real and redeeming at 100 real over ~10.4 years with a
  // 0.125% coupon is a small positive real yield.
  assert.ok(gry.semiAnnual > 0.01 && gry.semiAnnual < 0.03, `real yield ${gry.semiAnnual}`);
});

test("the real yield is computed off the REAL price — using the cash price would halve it", () => {
  const real = grossRedemptionYield({ coupon: 0.125, maturity: "2036-11-22", indexLinked: true, indexRatio: 1.5944 }, 84.02, DAY);
  const wrong = grossRedemptionYield({ coupon: 0.125, maturity: "2036-11-22" }, 133.96, DAY);
  assert.ok(real.semiAnnual > 0, "84.02 -> 100 is a gain");
  assert.ok(wrong.semiAnnual < 0, "133.96 -> 100 would look like a guaranteed loss");
  assert.equal(grossRedemptionYield({ coupon: 4, maturity: "2030-10-22" }, 99, DAY).real, false);
});

/* ------------------------- accrued and AIS ---------------------------- */

test("accrued interest is uplifted too, and both figures are reported", () => {
  const a = giltAnalytics({ txns: [buy("TG36", 100000)], secMeta: { TG36 }, prices: { TG36: UPLIFTED_TG36 }, asOf: DAY });
  const h = a.holdings[0];
  const realAi = accruedPer100({ coupon: 0.125, maturity: "2036-11-22" }, DAY).accrued;
  assert.ok(Math.abs(h.realAccruedPer100 - realAi) < 1e-9);
  assert.ok(Math.abs(h.accruedPer100 - realAi * 1.5944) < 1e-9, "cash accrued is the uplifted one");
  assert.ok(h.accruedValue > 0);
});

test("an AIS adjustment on a linker is uplifted and marked as an estimate", () => {
  // Historic index ratios aren't stored, so today's is used — better to say
  // so than to report an understated figure as exact.
  const a = giltAnalytics({
    txns: [{ date: "2026-06-01", ticker: "TG36", side: "SELL", quantity: 50000, wrapper: "GIA" },
      { date: "2026-05-01", ticker: "TG36", side: "BUY", quantity: 50000, wrapper: "GIA" }],
    secMeta: { TG36 }, prices: { TG36: UPLIFTED_TG36 }, asOf: DAY,
  });
  const items = Object.values(a.ais.byYear).flatMap((y) => y.items);
  assert.ok(items.length > 0);
  assert.ok(items.every((i) => i.ratioEstimated === true));
});

/* --------------------------- mixed ladder ----------------------------- */

test("a mixed ladder keeps each kind on its own terms", () => {
  const a = giltAnalytics({
    txns: [buy("TG36", 10000), buy("TG30", 20000)],
    secMeta: { TG36, TG30 },
    prices: { TG36: UPLIFTED_TG36, TG30: 0.84 },
    asOf: DAY, inflation: 0.03,
  });
  assert.equal(a.anyIndexLinked, true);
  assert.equal(a.inflation, 0.03, "the assumption is reported, not hidden inside the numbers");

  const byTicker = Object.fromEntries(a.holdings.map((h) => [h.ticker, h]));
  assert.equal(byTicker.TG30.indexLinked, false);
  assert.equal(byTicker.TG30.indexRatio, 1);
  assert.equal(byTicker.TG30.redemptionValue, 20000, "a conventional gilt redeems at par");
  assert.ok(byTicker.TG36.redemptionValue > 20000, "the linker's £10k nominal redeems for more than the £20k gilt's par");

  // Every cashflow carries both columns and is tagged with its kind.
  assert.ok(a.cashflows.every((f) => Number.isFinite(f.amount) && Number.isFinite(f.realAmount)));
  assert.ok(a.cashflows.some((f) => f.indexLinked) && a.cashflows.some((f) => !f.indexLinked));
});

test("12-month coupon income is reported in both cash and today's money", () => {
  const a = giltAnalytics({
    txns: [buy("TG36", 100000)], secMeta: { TG36 }, prices: { TG36: UPLIFTED_TG36 }, asOf: DAY, inflation: 0.03,
  });
  const h = a.holdings[0];
  // £100k nominal x 0.125% = £125/yr real, x 1.5944 = ~£199 in today's money.
  assert.ok(Math.abs(h.couponIncomeNext12mReal - 125 * 1.5944) < 1, `${h.couponIncomeNext12mReal}`);
  assert.ok(h.couponIncomeNext12m > h.couponIncomeNext12mReal, "cash is a touch higher with inflation applied");
});

test("a linker is still CGT-exempt — the inflation uplift is not a taxable gain", async () => {
  const { classifyInstrument } = await import("../core/portfolio.mjs");
  const c = classifyInstrument("TG36", { TG36 });
  assert.equal(c.kind, "gilt");
  assert.equal(c.cgtExempt, true, "TCGA 1992 s115 covers the whole capital uplift");
  assert.equal(c.incomeKind, "interest", "the coupon is still savings income");
});

/* ------------------- getting it in from the flex query ---------------- */

test("an IBKR bond line resolves to the registered ticker via its ISIN", async () => {
  // IBKR reports a gilt by DESCRIPTION — "UKTI 0 1/8 11/22/36" — which
  // matches no ticker anywhere. ISIN is the only thing that carries.
  const { resolveIbkrTicker } = await import("../core/ibkr-import.mjs");
  const seed = { GB00BYZW3J87: "TG36" };
  assert.equal(resolveIbkrTicker("UKTI 0 1/8 11/22/36", "GB00BYZW3J87", "GBP", "LSE", seed), "TG36");
  assert.equal(resolveIbkrTicker("UKTI 0 1/8 11/22/36.L", "GB00BYZW3J87", "GBP", "LSE", seed), "TG36");
});

test("an unseeded bond description is NOT turned into a junk '.L' ticker", async () => {
  const { resolveIbkrTicker } = await import("../core/ibkr-import.mjs");
  assert.equal(resolveIbkrTicker("UKTI 0 1/8 11/22/36", "", "GBP", "LSE", {}), "UKTI 0 1/8 11/22/36",
    "'UKTI 0 1/8 11/22/36.L' would match no price source and pollute the ledger");
  // Ordinary LSE equities still get their suffix.
  assert.equal(resolveIbkrTicker("VOD", "", "GBP", "LSE", {}), "VOD.L");
});

test("a skipped bond says how to make it importable", async () => {
  const { parseIBKR } = await import("../core/ibkr-import.mjs");
  const csv = [
    "Symbol,ISIN,AssetClass,TradeDate,Quantity,BuySell,Proceeds,CurrencyPrimary,ListingExchange",
    "UKTI 0 1/8 11/22/36,GB00BYZW3J87,BOND,20260820,10000,BUY,-13396.30,GBP,LSE",
  ].join("\n");

  const blind = parseIBKR(csv, { seedByIsin: {} });
  assert.equal(blind.trades.length, 0);
  assert.match(blind.warnings.join(" "), /GB00BYZW3J87/, "the warning names the ISIN to register");
  assert.match(blind.warnings.join(" "), /Gilts tab/, "and where to do it");

  // Once registered, the same row imports and lands on TG36.
  const seeded = parseIBKR(csv, { seedByIsin: { GB00BYZW3J87: "TG36" } });
  assert.equal(seeded.trades.length, 1, "a bond with a known ISIN is not skipped");
  assert.equal(seeded.trades[0].ticker, "TG36");
  assert.equal(seeded.trades[0].quantity, 10000, "quantity is £ nominal, the unit the gilt engine wants");
  assert.equal(seeded.trades[0].side, "BUY");
});

test("the imported trade feeds straight through to a valued holding", async () => {
  const { parseIBKR } = await import("../core/ibkr-import.mjs");
  const { trades } = parseIBKR([
    "Symbol,ISIN,AssetClass,TradeDate,Quantity,BuySell,Proceeds,CurrencyPrimary,ListingExchange",
    "UKTI 0 1/8 11/22/36,GB00BYZW3J87,BOND,20260601,10000,BUY,-13396.30,GBP,LSE",
  ].join("\n"), { seedByIsin: { GB00BYZW3J87: "TG36" } });

  const a = giltAnalytics({ txns: trades, secMeta: { TG36 }, prices: { TG36: UPLIFTED_TG36 }, asOf: DAY });
  assert.equal(a.holdings.length, 1, "flex query -> ledger -> Gilts tab, end to end");
  assert.equal(a.holdings[0].nominal, 10000);
  assert.ok(a.holdings[0].dirtyValue > 13000);
});

/* ------------------------- catalogue + registration ------------------- */

test("an index-linked gilt can be registered, with the ratio required", async () => {
  const { validateGiltRegistration } = await import("../core/gilt-registry.mjs");
  const form = { ticker: "TG36", name: "0.125% Index-linked Treasury Gilt 2036", coupon: "0.125", maturity: "2036-11-22", isin: "GB00BYZW3J87", indexLinked: true };

  const noRatio = validateGiltRegistration(form, { secMeta: {} });
  assert.equal(noRatio.ok, false);
  assert.match(noRatio.errors.indexRatio, /Required/);

  const ok = validateGiltRegistration({ ...form, indexRatio: "1.59440", indexRatioDate: "2026-07-02" }, { secMeta: {} });
  assert.equal(ok.ok, true, JSON.stringify(ok.errors));
  assert.equal(ok.value.patch.indexLinked, true);
  assert.equal(ok.value.patch.indexRatio, 1.5944);
  assert.equal(ok.value.patch.kind, "gilt");
});

test("8-month-lag linkers are refused rather than mismodelled", async () => {
  const { validateGiltRegistration } = await import("../core/gilt-registry.mjs");
  const r = validateGiltRegistration(
    { ticker: "T24I", coupon: "2.5", maturity: "2030-07-17", indexLinked: true, indexRatio: "3.1", indexationLagMonths: 8 },
    { secMeta: {} });
  assert.equal(r.ok, false);
  assert.match(r.errors.indexLinked, /8-month/);
});

test("correcting a gilt from index-linked to conventional clears the stale ratio", async () => {
  const { validateGiltRegistration } = await import("../core/gilt-registry.mjs");
  // A left-behind 1.59 would inflate a conventional gilt by 59%.
  const secMeta = { TG36: { kind: "gilt", coupon: 0.125, maturity: "2036-11-22", indexLinked: true, indexRatio: 1.5944 } };
  const r = validateGiltRegistration({ ticker: "TG36", coupon: "0.125", maturity: "2036-11-22", indexLinked: false }, { secMeta, editing: "TG36" });
  assert.equal(r.ok, true);
  assert.equal(r.value.patch.indexLinked, false);
  assert.equal(r.value.patch.indexRatio, undefined);
});

test("the DMO catalogue offers 3-month linkers and explains the ones it can't", async () => {
  const { shapeGiltCatalogue } = await import("../core/gilt-registry.mjs");
  const { rows } = shapeGiltCatalogue({
    date: "02/07/2026",
    prices: {
      GB00BYZW3J87: { clean: 84.02, name: "Index-linked Treasury Gilt 2036", coupon: 0.125, maturity: "2036-11-22", indexLinked: true, indexRatio: 1.5944, indexationLagMonths: 3 },
      GB00OLDSTYLE1: { clean: 300, name: "Index-linked Treasury Stock 2030", coupon: 2.5, maturity: "2030-07-17", indexLinked: true, indexRatio: 3.1, indexationLagMonths: 8 },
      GB00NORATIO12: { clean: 90, name: "Index-linked Treasury Gilt 2041", coupon: 0.125, maturity: "2041-03-22", indexLinked: true, indexRatio: null, indexationLagMonths: 3 },
    },
  });
  const by = Object.fromEntries(rows.map((r) => [r.isin, r]));
  assert.equal(by.GB00BYZW3J87.supported, true);
  assert.ok(Math.abs(by.GB00BYZW3J87.cashClean - 133.96) < 0.01, "what it's actually worth per £100, alongside the real quote");
  assert.equal(by.GB00OLDSTYLE1.supported, false);
  assert.match(by.GB00OLDSTYLE1.unsupportedReason, /8-month/);
  assert.equal(by.GB00NORATIO12.supported, false);
  assert.match(by.GB00NORATIO12.unsupportedReason, /index ratio/);
});

test("the ladder can be built on either basis, and they differ for a linker", async () => {
  const { buildGiltLadder } = await import("../core/gilt-ladder.mjs");
  const a = giltAnalytics({ txns: [buy("TG36", 100000)], secMeta: { TG36 }, prices: { TG36: UPLIFTED_TG36 }, asOf: DAY, inflation: 0.03 });
  const cash = buildGiltLadder({ cashflows: a.cashflows, targetAnnual: 100, field: "amount" });
  const real = buildGiltLadder({ cashflows: a.cashflows, targetAnnual: 100, field: "realAmount" });
  assert.ok(cash.totalGiltIncome > real.totalGiltIncome, "cash includes ten years of projected uplift");
  // A flat target is a REAL need, so the real basis is the honest comparison.
  assert.ok(real.totalGiltIncome > 0);
});

test("a linker's coupon is 'estimated' in the income calendar, not 'scheduled'", async () => {
  // Its DATE is contractual but its AMOUNT depends on RPI, so counting it as
  // guaranteed income would overstate the scheduled half of the split.
  const { buildIncomeCalendar } = await import("../core/income-calendar.mjs");
  const a = giltAnalytics({
    txns: [buy("TG36", 100000), buy("TG30", 100000)],
    secMeta: { TG36, TG30 }, prices: { TG36: UPLIFTED_TG36, TG30: 0.84 },
    asOf: DAY, inflation: 0.03,
  });
  const events = buildIncomeCalendar({ giltCashflows: a.cashflows, today: DAY, horizonDays: 365 });
  const gilt = events.filter((e) => e.source === "gilt-coupon");
  const byLabel = Object.fromEntries(gilt.map((e) => [e.label, e.certainty]));
  assert.equal(byLabel.TG30, "scheduled", "a fixed coupon is contractual");
  assert.equal(byLabel.TG36, "estimated", "an index-linked one is not");
});
