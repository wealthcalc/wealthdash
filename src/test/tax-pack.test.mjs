import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTaxPack, renderTaxPackHTML } from "../core/tax-pack.mjs";

const DISPOSALS = [
  { taxYear: "2025/26", date: "2025-06-01", ticker: "ABC", quantity: 100, proceeds: 1492, cost: 1012, gain: 480, legs: [{ method: "SECTION_104", quantity: 100, proceeds: 1492, cost: 1012, gain: 480 }] },
  { taxYear: "2025/26", date: "2025-09-01", ticker: "DEF", quantity: 10, proceeds: 500, cost: 700, gain: -200, legs: [] },
  { taxYear: "2024/25", date: "2024-09-01", ticker: "OLD", quantity: 1, proceeds: 1, cost: 1, gain: 0, legs: [] },
];
const INCOME = [
  { date: "2025-07-01", wrapper: "GIA", kind: "dividend", ticker: "VHYL", amount: 505.99 },
  { date: "2025-07-02", wrapper: "GIA", kind: "interest", ticker: "", amount: 10 },
  { date: "2025-07-03", wrapper: "ISA", kind: "dividend", ticker: "SMT", amount: 99 },   // sheltered — excluded
  { date: "2024-07-01", wrapper: "GIA", kind: "dividend", ticker: "KO", amount: 33 },     // wrong year
];
const ERI = [{ ticker: "SWDA", distributionDate: "2025-06-30", periodEnd: "2025-03-31", perShare: 0.12, currency: "USD", treatment: "dividends" }];
const LIAB = { aea: 3000, taxable: 0, tax: 0, lossesUsed: 200, carriedForward: 0 };

test("pack scopes to the year, GIA only, with correct totals", () => {
  const p = buildTaxPack({ year: "2025/26", disposals: DISPOSALS, liability: LIAB, incomeEntries: INCOME, eriEntries: ERI, carried: 150 });
  assert.equal(p.cgt.disposalCount, 2);
  assert.equal(p.cgt.gains, 480);
  assert.equal(p.cgt.losses, 200);
  assert.equal(p.cgt.lossesBroughtForward, 150);
  assert.equal(p.dividends.total, 505.99);      // ISA and prior-year rows excluded
  assert.equal(p.interest.total, 10);
  assert.equal(p.eri.length, 1);
  assert.equal(p.cgt.liability.aea, 3000);
  assert.throws(() => buildTaxPack({}), /tax year/);
});

test("HTML render carries the landmark sections and figures", () => {
  const html = renderTaxPackHTML(buildTaxPack({ year: "2025/26", disposals: DISPOSALS, liability: LIAB, incomeEntries: INCOME, eriEntries: ERI }));
  for (const s of ["Tax pack — 2025/26", "Capital gains summary", "Disposal schedule", "Dividends (GIA", "Excess reportable income", "not tax advice", "S.104 pool", "£505.99", "SWDA"]) {
    assert.ok(html.includes(s), s);
  }
  assert.ok(!html.includes("<script"), "no scripts in a document people will open blind");
});

test("user-entered strings are HTML-escaped in the render", () => {
  const nasty = buildTaxPack({
    year: "2025/26",
    disposals: [{ taxYear: "2025/26", date: "2025-06-01", ticker: "<img src=x onerror=alert(1)>", quantity: 1, proceeds: 1, cost: 1, gain: 0, legs: [] }],
  });
  const html = renderTaxPackHTML(nasty);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(html.includes("&lt;img"));
});
