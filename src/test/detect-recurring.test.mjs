import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRecurring } from "../core/detect-recurring.mjs";

// Build N monthly charges for a merchant, starting at `start`, at `amount`
// (optionally ramping by `step` each month for a price rise).
function monthly(desc, start, amount, n, step = 0) {
  const out = [];
  let [y, m] = start.split("-").map(Number);
  for (let i = 0; i < n; i++) {
    out.push({ date: `${y}-${String(m).padStart(2, "0")}-15`, description: `${desc} ${1000 + i}`, amount: amount + step * i });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

test("detects a steady monthly subscription; ignores an irregular shop", () => {
  const txns = [
    ...monthly("NETFLIX.COM", "2025-01", 10.99, 12),
    // a supermarket at wildly varying amounts and irregular dates — NOT a sub
    { date: "2025-01-03", description: "TESCO 3155", amount: 42 },
    { date: "2025-01-19", description: "TESCO 6241", amount: 120 },
    { date: "2025-02-08", description: "TESCO 0092", amount: 8 },
    { date: "2025-03-02", description: "TESCO 3155", amount: 210 },
  ];
  const s = detectRecurring(txns);
  assert.equal(s.length, 1);
  assert.equal(s[0].label, "Netflix Com");
  assert.equal(s[0].frequency, "monthly");
  assert.equal(s[0].amount, 10.99);
  assert.equal(s[0].charges, 12);
  assert.ok(Math.abs(s[0].annualEstimate - 131.88) < 0.5);
  assert.equal(s[0].priceRose, false);
});

test("flags a subscription whose price crept up, with the £/yr increase", () => {
  // Realistic: 9.99 for 6 months, then a step up to 12.99 — a single price
  // rise, not a monthly ramp. Both sit within tolerance of the median, so
  // it's recognised as one subscription AND flagged as risen.
  const txns = [
    ...monthly("SPOTIFY", "2025-01", 9.99, 6),
    ...monthly("SPOTIFY", "2025-07", 12.99, 6),
  ];
  const s = detectRecurring(txns);
  assert.equal(s.length, 1);
  assert.equal(s[0].priceRose, true);
  assert.equal(s[0].priceFrom, 9.99);
  assert.equal(s[0].priceTo, 12.99);
  assert.ok(s[0].annualIncrease > 30); // (12.99 − 9.99) × 12 = 36
});

test("needs a real pattern — too few charges or too short a span is ignored", () => {
  assert.equal(detectRecurring(monthly("X", "2025-01", 5, 2)).length, 0); // 2 charges
  // 3 charges but within a single month span → too short
  const tight = [
    { date: "2025-01-05", description: "Y 1", amount: 5 },
    { date: "2025-01-15", description: "Y 2", amount: 5 },
    { date: "2025-01-25", description: "Y 3", amount: 5 },
  ];
  assert.equal(detectRecurring(tight).length, 0);
});

test("quarterly and annual cadences are recognised", () => {
  const quarterly = [
    { date: "2024-01-10", description: "WATER CO 1", amount: 120 },
    { date: "2024-04-10", description: "WATER CO 2", amount: 120 },
    { date: "2024-07-10", description: "WATER CO 3", amount: 122 },
    { date: "2024-10-10", description: "WATER CO 4", amount: 121 },
  ];
  const s = detectRecurring(quarterly);
  assert.equal(s.length, 1);
  assert.equal(s[0].frequency, "quarterly");
  assert.ok(Math.abs(s[0].annualEstimate - 484) < 5); // ~121 × 4
});

test("already-declared merchants aren't re-suggested", () => {
  const txns = monthly("AMAZON PRIME", "2025-01", 8.99, 12);
  const s = detectRecurring(txns, { existingKeys: new Set(["amazon prime"]) });
  assert.equal(s.length, 0);
});

test("refund-only or zero rows produce nothing", () => {
  assert.deepEqual(detectRecurring([]), []);
  assert.deepEqual(detectRecurring(monthly("REFUND", "2025-01", -5, 12)), []);
});

test("topMerchants aggregates by normalised merchant, nets refunds, excludes transfers", async () => {
  const { topMerchants } = await import("../core/detect-recurring.mjs");
  const txns = [
    { date: "2026-01-01", description: "TESCO 3155", amount: 100 },
    { date: "2026-01-15", description: "TESCO 6241 LONDON", amount: 60 },
    { date: "2026-01-20", description: "TESCO 3155", amount: -20 }, // refund nets off
    { date: "2026-01-02", description: "AMAZON 402", amount: 50 },
    { date: "2026-01-03", description: "CARD PAYMENT", amount: 500, categoryId: "xfer" }, // transfer excluded
  ];
  const { rows, total, merchantCount } = topMerchants(txns, { transferIds: new Set(["xfer"]) });
  assert.equal(merchantCount, 2);              // tesco + amazon (transfer gone)
  assert.equal(rows[0].label, "Tesco");
  assert.equal(rows[0].total, 140);            // 100 + 60 − 20
  assert.equal(rows[0].count, 3);
  assert.equal(total, 190);                    // 140 + 50
  assert.equal(rows[0].weight, r2(140 / 190 * 100));
});
const r2 = (x) => Math.round(x * 100) / 100;
