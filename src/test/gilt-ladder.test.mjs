import { test } from "node:test";
import assert from "node:assert/strict";
import { giltIncomeByYear, buildGiltLadder } from "../core/gilt-ladder.mjs";

const CASHFLOWS = [
  { date: "2026-06-07", type: "coupon", amount: 500, ticker: "T1", wrapper: "GIA" },
  { date: "2026-12-07", type: "coupon", amount: 500, ticker: "T1", wrapper: "GIA" },
  { date: "2027-06-07", type: "coupon", amount: 500, ticker: "T1", wrapper: "GIA" },
  { date: "2027-12-07", type: "coupon", amount: 500, ticker: "T1", wrapper: "GIA" },
  { date: "2027-12-07", type: "redemption", amount: 20000, ticker: "T1", wrapper: "GIA" },
  { date: "2028-03-15", type: "coupon", amount: 300, ticker: "T2", wrapper: "ISA" },
];

test("giltIncomeByYear: sums coupon + redemption amounts per calendar year", () => {
  const by = giltIncomeByYear(CASHFLOWS);
  assert.equal(by[2026], 1000);
  assert.equal(by[2027], 500 + 500 + 20000);
  assert.equal(by[2028], 300);
});

test("giltIncomeByYear: ignores malformed rows without throwing", () => {
  const by = giltIncomeByYear([{ date: "2026-01-01", amount: 100 }, null, { amount: 50 }, { date: "bad" }]);
  assert.equal(by[2026], 100);
});

test("buildGiltLadder: a year with gilt income >= target is marked covered", () => {
  const ladder = buildGiltLadder({ cashflows: CASHFLOWS, targetAnnual: 900, fromYear: 2026, toYear: 2028 });
  const y2026 = ladder.rows.find((r) => r.year === 2026);
  assert.equal(y2026.covered, true);
  assert.ok(Math.abs(y2026.surplus - 100) < 1e-9);
});

test("buildGiltLadder: a year with gilt income below target is a gap, flagged as firstGapYear", () => {
  const ladder = buildGiltLadder({ cashflows: CASHFLOWS, targetAnnual: 900, fromYear: 2026, toYear: 2028 });
  const y2028 = ladder.rows.find((r) => r.year === 2028);
  assert.equal(y2028.covered, false);
  assert.equal(ladder.firstGapYear, 2028); // 2026 and 2027 are both covered, 2028 (£300 < £900) is the first gap
  assert.equal(ladder.fullyCovered, false);
});

test("buildGiltLadder: zero target means every year counts as covered", () => {
  const ladder = buildGiltLadder({ cashflows: CASHFLOWS, targetAnnual: 0, fromYear: 2026, toYear: 2028 });
  assert.equal(ladder.fullyCovered, true);
  assert.equal(ladder.yearsFullyCovered, 3);
});

test("buildGiltLadder: totalShortfall sums only the years that fell short", () => {
  const ladder = buildGiltLadder({ cashflows: CASHFLOWS, targetAnnual: 900, fromYear: 2026, toYear: 2028 });
  assert.ok(Math.abs(ladder.totalShortfall - 600) < 1e-9); // 2028: 900-300
});

test("buildGiltLadder: with no cashflows at all, every requested year is an uncovered gap (if target > 0)", () => {
  const ladder = buildGiltLadder({ cashflows: [], targetAnnual: 1000, fromYear: 2026, toYear: 2028 });
  assert.equal(ladder.yearsFullyCovered, 0);
  assert.equal(ladder.firstGapYear, 2026);
  assert.equal(ladder.totalGiltIncome, 0);
});

test("buildGiltLadder: infers fromYear/toYear from the cashflows when not supplied", () => {
  const ladder = buildGiltLadder({ cashflows: CASHFLOWS, targetAnnual: 100 });
  assert.equal(ladder.fromYear, 2026);
  assert.equal(ladder.toYear, 2028);
});
