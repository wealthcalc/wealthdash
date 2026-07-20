import { test } from "node:test";
import assert from "node:assert/strict";
import { savingsRate } from "../core/savings-rate.mjs";
import { taxRUK, employeeNI } from "../core/uk-income-tax.mjs";

test("take-home is built from the app's own tax engines, not a flat rate", () => {
  const r = savingsRate({ salary: 100000, empPct: 5, annualSpend: 40000 });
  const taxable = 100000 - 5000;
  assert.equal(r.employeePension, 5000);
  assert.equal(r.tax, Math.round(taxRUK(taxable) * 100) / 100);
  // NI on FULL salary — only salary sacrifice reduces it, so this is the
  // conservative choice (see module header).
  assert.equal(r.ni, Math.round(employeeNI(100000) * 100) / 100);
  assert.equal(r.takeHome, Math.round((taxable - taxRUK(taxable) - employeeNI(100000)) * 100) / 100);
});

test("THE definition trap: gross rate is far higher than take-home rate", () => {
  // Higher-rate taxpayer with a decent match. Quoting one figure when you
  // mean the other is how people conclude they're saving badly.
  const r = savingsRate({ salary: 100000, empPct: 8, erPct: 10, annualSpend: 40000 });
  assert.ok(r.grossRate > r.takeHomeRate, `${r.grossRate} vs ${r.takeHomeRate}`);
  // pension saving is counted in the gross rate but absent from take-home
  assert.equal(r.employeePension, 8000);
  assert.equal(r.employerPension, 10000);
  assert.equal(r.totalSaved, r.savedFromTakeHome + 18000);
  assert.equal(r.grossIncome, 100000 + 10000);
});

test("investment income counts as received and available", () => {
  const without = savingsRate({ salary: 60000, annualSpend: 30000 });
  const with_ = savingsRate({ salary: 60000, annualSpend: 30000, investmentIncome: 12000 });
  assert.ok(Math.abs(with_.takeHome - without.takeHome - 12000) < 1e-6);
  assert.ok(Math.abs(with_.savedFromTakeHome - without.savedFromTakeHome - 12000) < 1e-6);
  assert.ok(with_.takeHomeRate > without.takeHomeRate);
});

test("overspending is named, not shown as a bare negative percentage", () => {
  const r = savingsRate({ salary: 40000, annualSpend: 45000 });
  assert.equal(r.overspending, true);
  assert.ok(r.savedFromTakeHome < 0);
  assert.ok(r.takeHomeRate < 0);
  // and the healthy case is not flagged
  assert.equal(savingsRate({ salary: 40000, annualSpend: 20000 }).overspending, false);
});

test("Scotland uses Scottish bands", () => {
  const ruk = savingsRate({ salary: 80000, annualSpend: 30000 });
  const scot = savingsRate({ salary: 80000, annualSpend: 30000, region: "scotland" });
  assert.ok(scot.tax > ruk.tax);
  assert.ok(scot.takeHome < ruk.takeHome);
  assert.ok(scot.takeHomeRate < ruk.takeHomeRate);
});

test("degenerate inputs return nulls rather than NaN or Infinity", () => {
  const zero = savingsRate({});
  assert.equal(zero.takeHome, 0);
  assert.equal(zero.takeHomeRate, null);
  assert.equal(zero.grossRate, null);
  assert.equal(zero.netWorthRate, null);
  // negative inputs are clamped, not propagated
  const neg = savingsRate({ salary: -100, annualSpend: -50, empPct: -5 });
  assert.equal(neg.gross, 0);
  assert.equal(neg.spend, 0);
  assert.equal(neg.employeePension, 0);
});

test("no spending data yet: a 100% rate is arithmetically true and useless — caller must gate", () => {
  // Documenting the boundary rather than hiding it: with zero recorded
  // spend the engine honestly reports "you saved everything". The UI is
  // responsible for not showing that until the budget has real data
  // (planSpendFromBudget's readiness check does this job).
  const r = savingsRate({ salary: 50000, annualSpend: 0 });
  assert.equal(r.takeHomeRate, 100);
});
