import { test } from "node:test";
import assert from "node:assert/strict";
import { dividendChanges, incomeConcentration } from "../core/income-analysis.mjs";

const TODAY = "2026-07-24";

test("dividendChanges flags cuts and growth year-on-year", () => {
  const inc = [
    // HFEL: prior 12m £1000, recent 12m £850 → cut
    { date: "2025-01-15", ticker: "HFEL", amount: 500, wrapper: "ISA" },
    { date: "2025-03-15", ticker: "HFEL", amount: 500, wrapper: "ISA" },
    { date: "2026-01-15", ticker: "HFEL", amount: 425, wrapper: "ISA" },
    { date: "2026-03-15", ticker: "HFEL", amount: 425, wrapper: "ISA" },
    // CTY: prior £200, recent £240 → grown
    { date: "2025-06-01", ticker: "CTY", amount: 200, wrapper: "ISA" },
    { date: "2026-06-01", ticker: "CTY", amount: 240, wrapper: "ISA" },
  ];
  const { rows, cuts, grown } = dividendChanges({ incomeEntries: inc, today: TODAY });
  const hfel = rows.find((r) => r.ticker === "HFEL");
  assert.equal(hfel.status, "cut");
  assert.equal(hfel.recent, 850);
  assert.equal(hfel.prior, 1000);
  assert.equal(hfel.changePct, -15);
  const cty = rows.find((r) => r.ticker === "CTY");
  assert.equal(cty.status, "grown");
  assert.equal(cty.changePct, 20);
  assert.equal(cuts[0].ticker, "HFEL");   // cuts ranked first
  assert.equal(grown[0].ticker, "CTY");
});

test("dividendChanges: a holding with income in only one window is new/lapsed, not a fake %", () => {
  const inc = [
    { date: "2026-02-01", ticker: "NEW", amount: 100 },   // recent only
    { date: "2025-02-01", ticker: "GONE", amount: 100 },  // prior only
  ];
  const { rows } = dividendChanges({ incomeEntries: inc, today: TODAY });
  assert.equal(rows.find((r) => r.ticker === "NEW").status, "new");
  assert.equal(rows.find((r) => r.ticker === "NEW").changePct, null);
  assert.equal(rows.find((r) => r.ticker === "GONE").status, "lapsed");
});

test("interest is excluded from dividend-change analysis", () => {
  const inc = [
    { date: "2025-01-01", ticker: "", kind: "interest", amount: 500 },
    { date: "2026-01-01", ticker: "", kind: "interest", amount: 200 },
  ];
  assert.equal(dividendChanges({ incomeEntries: inc, today: TODAY }).rows.length, 0);
});

test("incomeConcentration: shares, top-N weight, effective-N", () => {
  const inc = [
    { date: "2026-01-01", ticker: "UAV", amount: 600 },
    { date: "2026-02-01", ticker: "CTY", amount: 300 },
    { date: "2026-03-01", ticker: "MYI", amount: 100 },
  ];
  const c = incomeConcentration({ incomeEntries: inc, today: TODAY, topN: 2 });
  assert.equal(c.total, 1000);
  assert.equal(c.top1.ticker, "UAV");
  assert.equal(c.top1.weight, 60);
  assert.equal(c.topNWeight, 90);            // UAV 60 + CTY 30
  // effective-N: 1 / (0.36 + 0.09 + 0.01) = 1/0.46 ≈ 2.17
  assert.ok(Math.abs(c.effectiveN - 2.17) < 0.05);
});

test("incomeConcentration pools unattributed interest and handles empty", () => {
  const c = incomeConcentration({ incomeEntries: [{ date: "2026-05-01", ticker: "", kind: "interest", amount: 50 }], today: TODAY });
  assert.equal(c.rows[0].ticker, "(cash interest)");
  assert.equal(incomeConcentration({ incomeEntries: [], today: TODAY }).total, 0);
});
