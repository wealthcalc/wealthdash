import { test } from "node:test";
import assert from "node:assert/strict";
import { forecastMonths, forecastMonthlySpend, forecastMonthlyIncome, combineCashflow } from "../core/cashflow-forecast.mjs";

const TODAY = "2026-09-18";

// Two years of history as mergedSpend() would hand it over: £2,000 in a
// normal month, £4,000 every December, and every March carries the £600
// home-insurance direct debit INSIDE its total (a statement row, or the
// recurring expansion for an uncovered month — either way it's in there).
function history() {
  const rows = [];
  const amt = (m) => (m === 12 ? 4000 : m === 3 ? 2600 : 2000);
  for (const y of [2024, 2025]) {
    for (let m = 1; m <= 12; m++) rows.push({ date: `${y}-${String(m).padStart(2, "0")}-15`, amount: amt(m), categoryId: "c1" });
  }
  for (let m = 1; m <= 8; m++) rows.push({ date: `2026-${String(m).padStart(2, "0")}-15`, amount: amt(m), categoryId: "c1" });
  return rows;
}
const RECURRING = [{ id: "ins", label: "Home insurance", amount: 600, frequency: "annual", startDate: "2024-03-10", categoryId: "c1" }];
const CATS = [{ id: "c1", name: "Living", monthly: 2500 }, { id: "xfer", name: "Transfers", transfer: true }];

test("the forecast window starts with the current month", () => {
  const m = forecastMonths(TODAY, 12);
  assert.equal(m[0], "2026-09");
  assert.equal(m[11], "2027-08");
  assert.equal(m.length, 12);
});

test("December is forecast from Decembers, not from a flat average", () => {
  const f = forecastMonthlySpend({ spend: history(), categories: CATS, recurring: RECURRING, today: TODAY, inflationPct: 0 });
  const dec = f.months.find((r) => r.month === "2026-12");
  const oct = f.months.find((r) => r.month === "2026-10");
  assert.equal(dec.variable, 4000, "the median of the two Decembers");
  assert.equal(oct.variable, 2000);
  assert.equal(dec.seasonalSamples, 2);
  assert.equal(f.reliable, true);
});

test("a recurring renewal lands in ITS month as committed, and history isn't double-counted", () => {
  const f = forecastMonthlySpend({ spend: history(), categories: CATS, recurring: RECURRING, today: TODAY, inflationPct: 0 });
  const mar = f.months.find((r) => r.month === "2027-03");
  assert.equal(mar.committed, 600);
  assert.equal(mar.recurringItems[0].label, "Home insurance");
  // March history totals £2,600 WITH the renewal inside. Variable is that
  // minus what recurring would have cost (£600) = £2,000, and the £600 comes
  // back once, as committed — so the month forecasts £2,600, not £3,200.
  assert.equal(mar.variable, 2000);
  assert.equal(mar.total, 2600);
  const feb = f.months.find((r) => r.month === "2027-02");
  assert.equal(feb.committed, 0);
});

test("a month whose statements never showed the renewal still isn't charged for it twice", () => {
  // If the Marches in history were £2,000 flat (the DD came off another
  // account that was never imported), variable = 2,000 − 600 = 1,400 and the
  // committed £600 brings the forecast back to £2,000 — the same as the
  // history, which is the honest answer. Never negative.
  const spend = history().map((r) => (r.date.slice(5, 7) === "03" ? { ...r, amount: 2000 } : r));
  const f = forecastMonthlySpend({ spend, categories: CATS, recurring: RECURRING, today: TODAY, inflationPct: 0 });
  const mar = f.months.find((r) => r.month === "2027-03");
  assert.equal(mar.variable, 1400);
  assert.equal(mar.total, 2000);
  const huge = forecastMonthlySpend({ spend, categories: CATS, recurring: [{ ...RECURRING[0], amount: 9000 }], today: TODAY });
  assert.ok(huge.months.find((r) => r.month === "2027-03").variable >= 0, "clamped at zero, not negative");
});

test("inflation uprates the variable part for the years ahead, not the committed part", () => {
  const f = forecastMonthlySpend({ spend: history(), categories: CATS, recurring: RECURRING, today: TODAY, inflationPct: 12 });
  const mar = f.months.find((r) => r.month === "2027-03");
  assert.equal(mar.committed, 600, "a contracted amount is what it is");
  assert.ok(mar.variable > 2000 && mar.variable < 2300, `variable ${mar.variable} carries ~half a year of 12%`);
});

test("the band widens with historical dispersion and is empty for a flat history", () => {
  const flat = forecastMonthlySpend({ spend: history().map((r) => ({ ...r, amount: 2000 })), categories: CATS, recurring: [], today: TODAY });
  assert.equal(flat.months[0].low, flat.months[0].high, "no dispersion, no band");
  const lumpy = forecastMonthlySpend({ spend: history(), categories: CATS, recurring: [], today: TODAY });
  assert.ok(lumpy.months[0].high >= lumpy.months[0].total);
  assert.ok(lumpy.months[0].low <= lumpy.months[0].total);
});

test("Plan goals inside the window are added in their month", () => {
  const f = forecastMonthlySpend({
    spend: history(), categories: CATS, recurring: [], today: TODAY,
    goals: [{ label: "New car", age: 46, amount: 25000, enabled: true }, { label: "Far away", age: 50, amount: 99999, enabled: true }, { label: "Off", age: 46, amount: 1, enabled: false }],
    currentAge: 45,
  });
  const sep27 = f.months.find((r) => r.month === "2027-09");
  assert.equal(sep27, undefined, "12 months from Sep 2026 ends Aug 2027 — a goal 'next year' at age 46 lands in the month of the anniversary…");
  // age 46 − 45 = 1 year → 2027-09, which is OUTSIDE a 12-month window
  // starting 2026-09. Extend to 13 months to see it.
  const f13 = forecastMonthlySpend({ spend: history(), categories: CATS, recurring: [], today: TODAY, months: 13, goals: [{ label: "New car", age: 46, amount: 25000, enabled: true }], currentAge: 45 });
  const hit = f13.months.find((r) => r.month === "2027-09");
  assert.equal(hit.goals, 25000);
  assert.equal(hit.goalItems[0].label, "New car");
  assert.equal(f.totals.goals, 0, "nothing else is in range, disabled goals never are");
});

test("transfers are not spend; no history degrades safely", () => {
  const spend = [...history(), { date: "2026-05-01", amount: 50000, categoryId: "xfer" }];
  const f = forecastMonthlySpend({ spend, categories: CATS, recurring: [], today: TODAY });
  assert.equal(f.months.find((r) => r.month === "2027-05").variable, 2000, "the £50k transfer didn't poison May");
  const empty = forecastMonthlySpend({ spend: [], categories: CATS, today: TODAY });
  assert.equal(empty.reliable, false);
  assert.equal(empty.months.length, 12);
  assert.equal(empty.totals.total, 0);
});

/* ------------------------------- income ------------------------------- */

const EVENTS = [
  { date: "2026-10-22", source: "gilt-coupon", amount: 187.5, certainty: "scheduled", wrapper: "GIA" },
  { date: "2026-10-22", source: "gilt-redemption", amount: 20000, certainty: "scheduled", wrapper: "GIA" },
  { date: "2026-11-15", source: "dividend", amount: 300, certainty: "estimated", wrapper: "GIA" },
  { date: "2026-11-15", source: "dividend", amount: 500, certainty: "estimated", wrapper: "ISA" },
  { date: "2026-09-30", source: "interest", amount: 200, certainty: "estimated", wrapper: "GIA" },
  { date: "2028-01-01", source: "dividend", amount: 999, certainty: "estimated", wrapper: "GIA" },   // outside
];

test("income is bucketed by month and split by certainty; capital flows are excluded by default", () => {
  const f = forecastMonthlyIncome({ events: EVENTS, today: TODAY });
  const oct = f.months.find((m) => m.month === "2026-10");
  assert.equal(oct.scheduled, 187.5);
  assert.equal(oct.total, 187.5, "the £20k redemption is capital, not income");
  const withCap = forecastMonthlyIncome({ events: EVENTS, today: TODAY, includeCapital: true });
  assert.equal(withCap.months.find((m) => m.month === "2026-10").total, 20187.5);
  const nov = f.months.find((m) => m.month === "2026-11");
  assert.equal(nov.estimated, 800);
  assert.equal(nov.taxable, 300, "the ISA dividend isn't taxable income");
  assert.equal(f.totals.total, 1187.5);
});

test("net of tax uses the injected engine on GIA totals and apportions by month", () => {
  const taxFn = ({ interest, dividends }) => ({ interestTax: interest * 0.4, dividendTax: dividends * 0.3375 });
  const f = forecastMonthlyIncome({ events: EVENTS, today: TODAY, taxFn });
  // GIA: interest 200 + coupon 187.5 = 387.5 → 155 tax; dividends 300 → 101.25
  assert.ok(Math.abs(f.totals.tax - 256.25) < 0.01);
  assert.ok(Math.abs(f.totals.net - (1187.5 - 256.25)) < 0.01);
  const nov = f.months.find((m) => m.month === "2026-11");
  assert.ok(nov.tax > 0 && nov.net < nov.total);
  const gross = forecastMonthlyIncome({ events: EVENTS, today: TODAY });
  assert.equal(gross.totals.tax, 0, "no engine, no tax");
});

/* ------------------------------ combine ------------------------------- */

test("combining gives net and cumulative per month and names the tight months", () => {
  const income = forecastMonthlyIncome({ events: EVENTS, today: TODAY });
  const spend = forecastMonthlySpend({ spend: history(), categories: CATS, recurring: RECURRING, today: TODAY });
  const c = combineCashflow({ income, spend });
  assert.equal(c.months.length, 12);
  assert.ok(c.shortfallMonths.includes("2026-12"), "December's £4k against little income");
  assert.equal(c.worstMonth.month, "2026-12");
  assert.equal(c.months[11].cumulative, c.totals.net);
  assert.ok(c.coveragePct < 100);
  const net = combineCashflow({ income: forecastMonthlyIncome({ events: EVENTS, today: TODAY, taxFn: () => ({ interestTax: 100, dividendTax: 100 }) }), spend, netOfTax: true });
  assert.ok(net.totals.income < c.totals.income, "net-of-tax income is lower");
});
