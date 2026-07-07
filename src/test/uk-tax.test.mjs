import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TAX_YEARS, cfgFor, aeaForYear, paFor,
  liabilityForYear, liabilityAllYears, sharesForTargetGain,
  investmentIncomeTax, nextTaxYear, optimiseDisposals,
} from "../core/uk-tax.mjs";

// Every expected figure below is hand-derived from GOV.UK rules for the year
// in question, NOT computed by running the engine — so a regression in the
// engine cannot silently rewrite its own expectations.

const D = (date, gain, taxYear, proceeds = Math.max(gain, 0) + 10000) =>
  ({ date, gain, taxYear, proceeds });

/* ------------------------------ CGT ---------------------------------- */

test("gain below the AEA is tax-free but still reported in the summary", () => {
  const r = liabilityForYear([D("2023-06-01", 5000, "2023/24")], { income: 30000 });
  assert.equal(r.tax, 0);
  assert.equal(r.net, 5000);
  assert.equal(r.taxable, 0);
  assert.equal(r.aea, 6000);
});

test("basic-rate taxpayer 2022/23: 10% within the remaining basic band", () => {
  // income 20,000 -> taxable income 7,430; band left 30,270.
  // gain 20,000 - AEA 12,300 = 7,700 all @10% = 770.
  const r = liabilityForYear([D("2022-09-01", 20000, "2022/23")], { income: 20000 });
  assert.equal(r.taxableIncome, 7430);
  assert.equal(r.taxable, 7700);
  assert.equal(r.atBasic, 7700);
  assert.equal(Math.round(r.tax), 770);
});

test("higher-rate taxpayer 2022/23: whole gain at 20%", () => {
  const r = liabilityForYear([D("2022-09-01", 20000, "2022/23")], { income: 60000 });
  assert.equal(r.atBasic, 0);
  assert.equal(r.atHigher, 7700);
  assert.equal(Math.round(r.tax), 1540);
});

test("gain straddles the basic-rate boundary 2022/23", () => {
  // income 45,000 -> taxable income 32,430 -> band left 5,270.
  // taxable gain 7,700: 5,270 @10% + 2,430 @20% = 527 + 486 = 1,013.
  const r = liabilityForYear([D("2022-09-01", 20000, "2022/23")], { income: 45000 });
  assert.equal(r.atBasic, 5270);
  assert.equal(r.atHigher, 2430);
  assert.equal(Math.round(r.tax), 1013);
});

test("2024/25 mid-year Budget: disposal date picks the rate", () => {
  // Higher-rate payer (income 100,000 keeps full PA — taper starts ABOVE 100k).
  // Taxable gain 10,000 - 3,000 AEA = 7,000.
  const before = liabilityForYear([D("2024-05-01", 10000, "2024/25")], { income: 100000 });
  assert.equal(Math.round(before.tax), 1400); // 7,000 @20% (pre 30 Oct 2024)
  const after = liabilityForYear([D("2024-12-01", 10000, "2024/25")], { income: 100000 });
  assert.equal(Math.round(after.tax), 1680); // 7,000 @24% (post 30 Oct 2024)
});

test("losses and AEA offset the HIGHEST-rate gains first (taxpayer-favourable)", () => {
  // 2024/25: 5,000 gain @20% era + 5,000 gain @24% era, 2,000 loss, income 100,000.
  // Reductions 2,000 + 3,000 AEA = 5,000 wipe the 24% gain entirely;
  // the 20% gain is fully taxable: 5,000 @20% = 1,000.
  const r = liabilityForYear([
    D("2024-05-01", 5000, "2024/25"),
    D("2024-12-01", 5000, "2024/25"),
    D("2024-06-01", -2000, "2024/25"),
  ], { income: 100000 });
  assert.equal(r.taxable, 5000);
  assert.equal(Math.round(r.tax), 1000);
});

test("brought-forward losses reduce net gains only down to the AEA", () => {
  // 2023/24: gains 10,000, carried 3,000 -> usable = min(10,000-6,000, 3,000) = 3,000.
  // Taxable = 10,000 - 3,000 - 6,000 = 1,000 @10% (income 0 -> basic band free).
  const r = liabilityForYear([D("2023-06-01", 10000, "2023/24")], { income: 0, carriedLosses: 3000 });
  assert.equal(r.usedCarried, 3000);
  assert.equal(r.taxable, 1000);
  assert.equal(Math.round(r.tax), 100);
});

test("reporting flag trips on proceeds above the threshold even with no tax", () => {
  const r = liabilityForYear([D("2023-06-01", 1000, "2023/24", 60000)], { income: 30000 });
  assert.equal(r.tax, 0);
  assert.equal(r.reporting, true); // 2023/24 threshold £50,000
});

test("liabilityAllYears chains loss carry-forward across years", () => {
  const all = liabilityAllYears([
    D("2022-09-01", -5000, "2022/23"),
    D("2023-09-01", 10000, "2023/24"),
  ], { incomeByYear: { "2023/24": 0 } });
  assert.equal(all.results["2022/23"].carriedOut, 5000);
  // 2023/24: usable carried = min(10,000-6,000, 5,000) = 4,000 -> taxable 0.
  assert.equal(all.results["2023/24"].usedCarried, 4000);
  assert.equal(all.results["2023/24"].tax, 0);
  assert.equal(all.carriedForward, 1000);
});

test("empty disposal list returns the zero object", () => {
  const r = liabilityForYear([]);
  assert.equal(r.tax, 0);
  assert.equal(r.reporting, false);
  assert.deepEqual(r.breakdown, []);
});

test("helpers: aeaForYear, paFor taper, nextTaxYear, sharesForTargetGain", () => {
  assert.equal(aeaForYear("2020/21"), 12300);
  assert.equal(aeaForYear("2026/27"), 3000);
  assert.equal(cfgFor("2099/00").assumed, true); // unknown year falls back, flagged
  assert.equal(paFor(12570, 100000), 12570);
  assert.equal(paFor(12570, 110000), 7570);   // £1 lost per £2 over £100k
  assert.equal(paFor(12570, 130000), 0);      // fully tapered by £125,140
  assert.equal(nextTaxYear("2024/25"), "2025/26");
  assert.equal(nextTaxYear("2029/30"), "2030/31");
  // 100 shares, cost 1,000 (avg 10), price 15 -> £5/share of gain; £50 target -> 10 shares.
  assert.equal(sharesForTargetGain(100, 1000, 15, 50), 10);
  // No gain per share -> sell everything (can't reach a positive target).
  assert.equal(sharesForTargetGain(100, 2000, 15, 50), 100);
});

/* ------------------------ investment income tax ----------------------- */

test("basic-rate 2024/25: PSA covers interest; dividends above £500 at 8.75%", () => {
  const r = investmentIncomeTax({ salary: 30000, interest: 1000, dividends: 1000, year: "2024/25" });
  assert.equal(r.band, "basic");
  assert.equal(r.interestTax, 0);           // £1,000 PSA (basic) covers it
  assert.equal(r.dividendTax, 43.75);       // (1,000 - 500) @8.75%
  assert.equal(r.tax, 43.75);
});

test("higher-rate 2024/25: £500 PSA, 40% savings, 33.75% dividends", () => {
  const r = investmentIncomeTax({ salary: 60000, interest: 1000, dividends: 5000, year: "2024/25" });
  assert.equal(r.band, "higher");
  assert.equal(r.interestTax, 200);         // (1,000 - 500 PSA) @40%
  assert.equal(r.dividendTax, 1518.75);     // (5,000 - 500 allowance) @33.75%
});

test("additional-rate 2024/25: no PSA, dividends at 39.35%, PA fully tapered", () => {
  const r = investmentIncomeTax({ salary: 150000, interest: 0, dividends: 1000, year: "2024/25" });
  assert.equal(r.band, "addl");
  assert.equal(r.personalAllowance, 0);
  assert.equal(r.psa, 0);
  assert.equal(r.dividendTax, 196.75);      // (1,000 - 500) @39.35%
});

test("starting rate for savings shelters low-salary interest entirely", () => {
  // Salary 10,000 sits inside the PA; taxable salary 0 -> £5,000 starting
  // rate + £1,000 PSA cover the £3,430 of taxable interest.
  const r = investmentIncomeTax({ salary: 10000, interest: 6000, dividends: 0, year: "2024/25" });
  assert.equal(r.interestTax, 0);
});

test("personal allowance taper flows through at £110k salary", () => {
  const r = investmentIncomeTax({ salary: 110000, interest: 0, dividends: 0, year: "2024/25" });
  assert.equal(r.personalAllowance, 7570);
});

test("dividend allowance history: £2,000 in 2021/22, £500 from 2024/25", () => {
  assert.equal(investmentIncomeTax({ salary: 30000, dividends: 2000, year: "2021/22" }).dividendTax, 0);
  const r = investmentIncomeTax({ salary: 30000, dividends: 2000, year: "2024/25" });
  assert.equal(r.dividendTax, Math.round(1500 * 0.0875 * 100) / 100);
});

/* -------------------------- AEA optimiser ----------------------------- */

const H = (ticker, qty, cost, price) => ({ ticker, qty, cost, price });

test("embedded gain inside one AEA clears in year one, tax-free", () => {
  const r = optimiseDisposals({ holdings: [H("AAA", 100, 1000, 15)], startYear: "2025/26", income: 50000 });
  assert.equal(r.startEmbedded, 500);
  assert.equal(r.yearsToClear, 1);
  assert.equal(r.totalWashed, 500);
  assert.equal(r.schedule[0].tax, 0);
  assert.equal(r.remainingAfter, 0);
});

test("larger gain staged across successive £3,000 AEAs", () => {
  // Embedded 9,000; AEA-only budget 3,000/yr from 2025/26 -> 3 years.
  const r = optimiseDisposals({ holdings: [H("AAA", 100, 1000, 100)], startYear: "2025/26", income: 50000, years: 10 });
  assert.equal(r.startEmbedded, 9000);
  assert.equal(r.yearsToClear, 3);
  assert.equal(r.totalWashed, 9000);
  assert.ok(r.schedule.every((y) => y.tax === 0));
});

test("useBasicBand spends band room at the basic CGT rate", () => {
  // Income 0 -> full basic band available; embedded 9,000 clears in year 1:
  // 3,000 in the AEA, 6,000 at 18% (2025/26 basic) = 1,080.
  const r = optimiseDisposals({ holdings: [H("AAA", 100, 1000, 100)], startYear: "2025/26", income: 0, useBasicBand: true });
  assert.equal(r.yearsToClear, 1);
  assert.equal(r.schedule[0].bandGain, 6000);
  assert.equal(r.schedule[0].tax, 1080);
});

test("highest gain-per-share holdings are harvested first", () => {
  const r = optimiseDisposals({
    holdings: [H("LOW", 100, 1000, 11), H("HIGH", 100, 1000, 40)],
    startYear: "2025/26", income: 50000,
  });
  assert.equal(r.schedule[0].sells[0].ticker, "HIGH");
});

test("loss-making and unpriced holdings are ignored", () => {
  const r = optimiseDisposals({
    holdings: [H("LOSS", 100, 2000, 10), H("NOPX", 100, 1000, NaN)],
    startYear: "2025/26", income: 50000,
  });
  assert.equal(r.startEmbedded, 0);
  assert.equal(r.totalWashed, 0);
});

test("growth compounds unsold prices between years", () => {
  // qty 100, avg cost 10, price 50 -> embedded 4,000. Year 1 washes 3,000
  // (avg cost blends to 40), leaving 1,000 embedded. 100% growth doubles the
  // price to 100 before year 2 -> embedded balloons to 6,000, so year 2
  // harvests a full 3,000 again rather than just the leftover 1,000.
  const r = optimiseDisposals({ holdings: [H("AAA", 100, 1000, 50)], startYear: "2025/26", income: 50000, growth: 1.0, years: 2 });
  assert.equal(r.schedule[0].gainRealised, 3000);
  assert.equal(r.schedule[0].remainingUnrealised, 1000);
  assert.equal(r.schedule[1].gainRealised, 3000); // > the 1,000 left pre-growth
  assert.equal(r.schedule[1].remainingUnrealised, 3000);
});

/* ------------------------------ data table ---------------------------- */

test("TAX_YEARS table spot checks against GOV.UK", () => {
  assert.equal(TAX_YEARS["2023/24"].aea, 6000);
  assert.equal(TAX_YEARS["2024/25"].rates.length, 2); // Budget split year
  assert.equal(TAX_YEARS["2025/26"].rates[0].basic, 0.18);
  assert.equal(TAX_YEARS["2025/26"].rates[0].higher, 0.24);
});
