import { test } from "node:test";
import assert from "node:assert/strict";
import { giltAnalytics, grossRedemptionYield } from "../core/gilts.mjs";
import {
  duration, netRedemptionYield, marginalSavingsRate, yieldOnCost, holdingExtras,
  portfolioYield, maturityProfile, yieldCurvePoints, gapSuggestions, yearsBetween,
} from "../core/gilt-portfolio.mjs";
import { buildGiltLadder } from "../core/gilt-ladder.mjs";
import { investmentIncomeTax } from "../core/uk-tax.mjs";

const DAY = "2026-09-18";
const TG30 = { kind: "gilt", coupon: 0.375, maturity: "2030-10-22", isin: "GB00BMGR2809" };
const TG35 = { kind: "gilt", coupon: 4.5, maturity: "2035-03-07", isin: "GB00BLPK7110" };
const TG36 = { kind: "gilt", coupon: 0.125, maturity: "2036-11-22", indexLinked: true, indexRatio: 1.5944, isin: "GB00BYZW3J87" };
const secMeta = { TG30, TG35, TG36 };
const buy = (ticker, qty, date = "2025-06-02", wrapper = "GIA", extra = {}) => ({ date, ticker, side: "BUY", quantity: qty, wrapper, ...extra });
// Clean per £1 (TG36 stored UPLIFTED, per the gilts.mjs convention).
const prices = { TG30: 0.8832, TG35: 1.0115, TG36: (84.02 * 1.5944) / 100 };

/* ------------------------------ duration ----------------------------- */
test("duration is shorter than time to maturity, and shortest for the high-coupon line", () => {
  const d30 = duration(TG30, 88.32, DAY), d35 = duration(TG35, 101.15, DAY);
  assert.ok(d30.macaulay > 3.5 && d30.macaulay < yearsBetween(DAY, TG30.maturity), `TG30 Macaulay ${d30.macaulay}`);
  assert.ok(d35.macaulay < yearsBetween(DAY, TG35.maturity) - 1, "a 4.5% coupon pulls duration well inside maturity");
  assert.ok(d30.modified < d30.macaulay);
  // A near-zero-coupon gilt's Macaulay duration is almost exactly its maturity.
  assert.ok(Math.abs(d30.macaulay - yearsBetween(DAY, TG30.maturity)) < 0.05);
  assert.equal(duration(TG30, 88, "2031-01-01").macaulay, null, "matured");
});

/* ------------------------- net redemption yield ---------------------- */
test("after tax, the low-coupon gilt beats the high-coupon one at the same gross yield", () => {
  // Pick prices so both have (about) the same gross GRY, then tax the coupons.
  const g30 = grossRedemptionYield(TG30, 88.32, DAY).semiAnnual;
  const g35 = grossRedemptionYield(TG35, 101.15, DAY).semiAnnual;
  const n30 = netRedemptionYield(TG30, 88.32, DAY, 0.4).semiAnnual;
  const n35 = netRedemptionYield(TG35, 101.15, DAY, 0.4).semiAnnual;
  assert.ok(g30 - n30 < 0.002, "0.375% coupon: tax costs under 20bp");
  assert.ok(g35 - n35 > 0.015, "4.5% coupon at 40%: tax costs over 150bp");
  assert.equal(netRedemptionYield(TG30, 88.32, DAY, 0).semiAnnual, g30, "0% rate = gross");
  assert.equal(netRedemptionYield(TG36, 84.02, DAY, 0.4).real, true, "a linker's net yield is still real");
});

test("marginal savings rate comes out of the tax engine at the stored salary", () => {
  assert.equal(marginalSavingsRate(investmentIncomeTax, { salary: 30000, interest: 5000, year: "2025/26" }), 0.2);
  assert.equal(marginalSavingsRate(investmentIncomeTax, { salary: 80000, interest: 5000, year: "2025/26" }), 0.4);
  assert.equal(marginalSavingsRate(investmentIncomeTax, { salary: 200000, interest: 5000, year: "2025/26" }), 0.45);
  assert.equal(marginalSavingsRate(investmentIncomeTax, { salary: 30000, interest: 0, year: "2025/26" }), 0, "inside the PSA");
  assert.equal(marginalSavingsRate(null), null);
});

/* ----------------------------- yield on cost ------------------------- */
test("yield on cost is the GRY at the price actually paid, nominal-weighted across BUYs", () => {
  const rows = [
    buy("TG30", 10000, "2025-06-02", "GIA", { nativeCurrency: "GBP", nativeAmount: 8400, gbpAmount: 8410, fees: 10 }),  // 84.00 clean
    buy("TG30", 10000, "2026-03-02", "GIA", { gbpAmount: 8610, fees: 10 }),                                            // 86.00 via gbpAmount − fees
    { ...buy("TG30", 5000, "2026-04-01"), side: "SELL", gbpAmount: 4400 },                                              // ignored
  ];
  const y = yieldOnCost(TG30, rows);
  assert.equal(y.purchases, 2);
  assert.equal(y.nominal, 20000);
  const a = grossRedemptionYield(TG30, 84, "2025-06-02").semiAnnual, b = grossRedemptionYield(TG30, 86, "2026-03-02").semiAnnual;
  assert.ok(Math.abs(y.semiAnnual - (a + b) / 2) < 1e-12);
  assert.ok(y.semiAnnual > grossRedemptionYield(TG30, 88.32, DAY).semiAnnual, "bought cheaper than today → locked in more");
  assert.equal(yieldOnCost(TG30, []).semiAnnual, null);
  // A per-£1 amount that can't be a per-£100 price is skipped, not averaged in.
  assert.equal(yieldOnCost(TG30, [buy("TG30", 10000, "2025-06-02", "GIA", { gbpAmount: 85 })]).purchases, 0);
  assert.equal(yieldOnCost(TG36, [buy("TG36", 10000, "2025-06-02", "GIA", { gbpAmount: 13396 })]).approx, true, "linker: today's ratio stands in for the historic one");
});

/* ----------------------------- holding extras ------------------------ */
test("holdingExtras: remaining return splits into taxable coupons and tax-free pull to par", () => {
  const txns = [buy("TG30", 20000, "2025-06-02", "GIA", { nativeCurrency: "GBP", nativeAmount: 17000 })];
  const a = giltAnalytics({ txns, secMeta, prices, asOf: DAY });
  const h = a.holdings[0];
  const x = holdingExtras(h, { asOf: DAY, rows: txns, taxRate: 0.4 });
  assert.ok(x.yearsToMaturity > 4 && x.yearsToMaturity < 4.2);
  assert.ok(x.remaining.capital > 2300 && x.remaining.capital < 2400, `pull to par on £20k at 88.32 ≈ £2,336, got ${x.remaining.capital}`);
  assert.ok(x.remaining.coupons > 250 && x.remaining.coupons < 320, `~£300 of coupons to come net of accrued, got ${x.remaining.coupons}`);
  assert.ok(Math.abs(x.remaining.total - (x.remaining.coupons + x.remaining.capital)) < 1e-6);
  assert.equal(x.remaining.taxable, true);
  assert.equal(x.taxRateApplied, 0.4);
  assert.ok(x.netYield.semiAnnual < h.gry.semiAnnual && x.netYield.semiAnnual > h.gry.semiAnnual - 0.002);
  assert.ok(x.valuePer1pct < 0 && Math.abs(x.valuePer1pct) > 600 && Math.abs(x.valuePer1pct) < 800, `£17.7k × ~4 modified ≈ −£700, got ${x.valuePer1pct}`);
  // Sheltered: no tax, net = gross.
  const isa = giltAnalytics({ txns: [buy("TG30", 20000, "2025-06-02", "ISA")], secMeta, prices, asOf: DAY }).holdings[0];
  const xi = holdingExtras(isa, { asOf: DAY, rows: [], taxRate: 0.4 });
  assert.equal(xi.taxRateApplied, 0);
  assert.equal(xi.netYield.semiAnnual, isa.gry.semiAnnual);
});

/* ------------------------------ portfolio ---------------------------- */
test("portfolio YTM is one XIRR over the whole ladder, and matches the GRY for a single holding", () => {
  const txns = [buy("TG30", 20000)];
  const a = giltAnalytics({ txns, secMeta, prices, asOf: DAY });
  const p = portfolioYield({ holdings: a.holdings, cashflows: a.cashflows, asOf: DAY });
  assert.ok(Math.abs(p.semiAnnual - a.holdings[0].gry.semiAnnual) < 1e-6, `single holding: ${p.semiAnnual} vs ${a.holdings[0].gry.semiAnnual}`);
  assert.equal(p.kind, "nominal");
  assert.equal(p.count, 1);
  assert.ok(Math.abs(p.weightedGry - p.semiAnnual) < 1e-6);
  assert.ok(p.remainingGain > 0 && Math.abs(p.remainingGain - (p.cashToCome - p.totalDirty)) < 1e-9);
  assert.equal(p.finalMaturity, "2030-10-22");
});

test("two conventional gilts: portfolio YTM sits between the two GRYs and near the value-weighted average", () => {
  const txns = [buy("TG30", 20000), buy("TG35", 20000)];
  const a = giltAnalytics({ txns, secMeta, prices, asOf: DAY });
  const p = portfolioYield({ holdings: a.holdings, cashflows: a.cashflows, asOf: DAY, taxRate: 0.4 });
  const [lo, hi] = a.holdings.map((h) => h.gry.semiAnnual).sort((x, y) => x - y);
  assert.ok(p.semiAnnual >= lo - 1e-9 && p.semiAnnual <= hi + 1e-9, `${p.semiAnnual} within [${lo}, ${hi}]`);
  assert.ok(Math.abs(p.semiAnnual - p.weightedGry) < 0.003, "cross-check agrees to within 30bp");
  assert.ok(p.netSemiAnnual < p.semiAnnual, "GIA coupons taxed at 40% lower the net figure");
  assert.ok(p.modifiedDuration > 3 && p.modifiedDuration < 8);
  assert.ok(p.valuePer1pct < 0 && Math.abs(p.valuePer1pct) < p.totalDirty * 0.1);
  assert.ok(p.weightedMaturityYears > 4 && p.weightedMaturityYears < 8.5);
  assert.ok(p.taxableCoupons > 0);
});

test("a linker in the ladder: cash basis is 'nominal-projected', real basis is a real yield; unpriced lines are named", () => {
  const txns = [buy("TG30", 20000), buy("TG36", 10000)];
  const a = giltAnalytics({ txns, secMeta, prices, asOf: DAY, inflation: 0.03 });
  const cash = portfolioYield({ holdings: a.holdings, cashflows: a.cashflows, asOf: DAY, field: "amount" });
  const real = portfolioYield({ holdings: a.holdings, cashflows: a.cashflows, asOf: DAY, field: "realAmount" });
  assert.equal(cash.kind, "nominal-projected");
  assert.equal(real.kind, "real");
  assert.ok(cash.semiAnnual > real.semiAnnual, "nominal exceeds real by roughly the inflation assumption");
  assert.ok(cash.semiAnnual - real.semiAnnual > 0.02 && cash.semiAnnual - real.semiAnnual < 0.04);
  assert.equal(cash.weightedGry, giltAnalytics({ txns: [buy("TG30", 20000)], secMeta, prices, asOf: DAY }).holdings[0].gry.semiAnnual, "weighted GRY excludes the linker");
  const noPrice = giltAnalytics({ txns, secMeta, prices: { TG30: 0.8832 }, asOf: DAY });
  const p2 = portfolioYield({ holdings: noPrice.holdings, cashflows: noPrice.cashflows, asOf: DAY });
  assert.deepEqual(p2.unpriced, ["TG36"]);
  assert.equal(p2.count, 1);
  assert.equal(portfolioYield({ holdings: [], cashflows: [], asOf: DAY }).semiAnnual, null);
});

/* --------------------------- maturity profile ------------------------ */
test("maturity profile fills every year to final maturity and names what redeems", () => {
  const txns = [buy("TG30", 20000), buy("TG35", 10000)];
  const a = giltAnalytics({ txns, secMeta, prices, asOf: DAY });
  const prof = maturityProfile(a.cashflows);
  assert.equal(prof[0].year, 2026);
  assert.equal(prof[prof.length - 1].year, 2035);
  assert.equal(prof.length, 10, "no gaps: 2026…2035 inclusive");
  const y30 = prof.find((r) => r.year === 2030);
  assert.equal(y30.redemptions, 20000);
  assert.deepEqual(y30.redeeming, ["TG30"]);
  assert.ok(prof.find((r) => r.year === 2032).coupons > 0 && prof.find((r) => r.year === 2032).redemptions === 0);
});

/* ------------------------ yield curve + gap filling ------------------ */
const CATALOGUE = [
  { isin: "A", name: "0.375% Treasury Gilt 2030", coupon: 0.375, maturity: "2030-10-22", clean: 88.32, cashClean: 88.32, supported: true, indexLinked: false },
  { isin: "B", name: "4.5% Treasury Gilt 2035", coupon: 4.5, maturity: "2035-03-07", clean: 101.15, cashClean: 101.15, supported: true, indexLinked: false },
  { isin: "C", name: "0.125% Treasury Gilt 2028", coupon: 0.125, maturity: "2028-01-31", clean: 94.5, cashClean: 94.5, supported: true, indexLinked: false },
  { isin: "D", name: "0.125% Index-linked 2036", coupon: 0.125, maturity: "2036-11-22", clean: 84.02, cashClean: 133.96, indexRatio: 1.5944, supported: true, indexLinked: true },
  { isin: "E", name: "unsupported", coupon: 2, maturity: "2033-01-01", clean: 90, supported: false, indexLinked: true },
  { isin: "F", name: "matured", coupon: 2, maturity: "2020-01-01", clean: 100, supported: true },
  { isin: "G", name: "rump 2028", coupon: 9, maturity: "2028-06-01", clean: 130, cashClean: 130, supported: true, rump: true },
];

test("yield curve splits conventional (nominal) from index-linked (real) and skips what can't be priced", () => {
  const c = yieldCurvePoints(CATALOGUE, DAY);
  assert.deepEqual(c.conventional.map((p) => p.isin), ["C", "G", "A", "B"], "sorted by years to maturity");
  assert.deepEqual(c.indexLinked.map((p) => p.isin), ["D"]);
  assert.ok(c.conventional.filter((p) => !p.rump).every((p) => p.gry > 0.02 && p.gry < 0.08));
  assert.ok(c.indexLinked[0].gry < c.conventional[0].gry, "a real yield is lower than nominal ones");
});

test("gap suggestions name gilts maturing in each uncovered year with the nominal that would close it", () => {
  const txns = [buy("TG30", 20000)];
  const a = giltAnalytics({ txns, secMeta, prices, asOf: DAY });
  const ladder = buildGiltLadder({ cashflows: a.cashflows, targetAnnual: 10000 });
  const curve = yieldCurvePoints(CATALOGUE, DAY);
  const gaps = gapSuggestions({ ladderRows: ladder.rows, curve });
  assert.ok(gaps.length > 0);
  const y28 = gaps.find((g) => g.year === 2028);
  assert.ok(y28, "2028 has only £75 of coupons against £10k, so it's a gap");
  assert.equal(y28.shortfall, 9925);
  assert.deepEqual(y28.candidates.map((c) => c.isin), ["C"], "the rump stock is left out");
  assert.equal(y28.candidates[0].nominal, 10000, "£9,925 ÷ (1 + 0.0625%) rounds up to £10,000 nominal");
  assert.ok(Math.abs(y28.candidates[0].cost - 9450) < 1e-6, "at 94.50 clean");
  const y29 = gaps.find((g) => g.year === 2029);
  assert.deepEqual(y29.candidates, [], "nothing on the list matures in 2029");
  assert.equal(gaps.find((g) => g.year === 2030), undefined, "2030 is covered by TG30's redemption");
});
