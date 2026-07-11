import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationDrift, sellSuggestions, buySuggestions, rebalancePlan, bucketOf } from "../core/rebalancing.mjs";

const pos = (over) => ({
  wrapper: "GIA", ticker: "X", kind: "equity", priced: true, marketValue: 1000, unrealisedPct: 0, cgtExempt: false,
  ...over,
});

/* -------------------------------- bucketOf ---------------------------------- */

test("bucketOf: maps kinds to exactly bonds/equities/null", () => {
  assert.equal(bucketOf("gilt"), "bonds");
  assert.equal(bucketOf("bond_fund"), "bonds");
  assert.equal(bucketOf("equity"), "equities");
  assert.equal(bucketOf("fund"), "equities");
  assert.equal(bucketOf("investment_trust"), "equities");
  assert.equal(bucketOf("cash"), null);
  assert.equal(bucketOf("unknown"), null);
});

/* ------------------------------ allocation drift --------------------------- */

test("allocationDrift: computes current vs target weight and drift value, grouped into two buckets", () => {
  const positions = [
    pos({ ticker: "EQ1", kind: "equity", marketValue: 8000 }),
    pos({ ticker: "BF1", kind: "bond_fund", marketValue: 2000 }),
  ];
  const d = allocationDrift({ positions, targets: { equities: 60, bonds: 40 } });
  assert.equal(d.total, 10000);
  assert.equal(d.rows.length, 2); // always exactly two rows, bonds + equities
  const eq = d.rows.find((r) => r.bucket === "equities");
  const bo = d.rows.find((r) => r.bucket === "bonds");
  assert.equal(eq.currentPct, 80);
  assert.equal(eq.targetPct, 60);
  assert.equal(eq.driftValue, 2000); // overweight by £2000
  assert.equal(bo.currentPct, 20);
  assert.equal(bo.driftValue, -2000); // underweight by £2000
  assert.equal(d.targetsSumTo100, true);
});

test("allocationDrift: VCT holdings are excluded entirely, even from the total", () => {
  const positions = [
    pos({ ticker: "EQ1", kind: "equity", marketValue: 8000 }),
    pos({ ticker: "VCT1", kind: "equity", wrapper: "VCT", marketValue: 5000 }),
  ];
  const d = allocationDrift({ positions, targets: { equities: 100, bonds: 0 } });
  assert.equal(d.total, 8000); // VCT never counted
  const eq = d.rows.find((r) => r.bucket === "equities");
  assert.equal(eq.currentValue, 8000);
});

test("allocationDrift: kinds outside the two buckets (e.g. cash) are excluded, not folded in", () => {
  const positions = [
    pos({ ticker: "EQ1", kind: "equity", marketValue: 8000 }),
    pos({ ticker: "CASH1", kind: "cash", marketValue: 5000 }),
  ];
  const d = allocationDrift({ positions, targets: { equities: 100, bonds: 0 } });
  assert.equal(d.total, 8000);
});

test("allocationDrift: flags when targets don't sum to 100", () => {
  const d = allocationDrift({ positions: [pos({ marketValue: 100 })], targets: { equities: 50 } });
  assert.equal(d.targetsSumTo100, false);
  assert.equal(d.targetTotalPct, 50);
});

test("allocationDrift: unpriced positions are excluded from the total", () => {
  const positions = [pos({ marketValue: 1000 }), pos({ ticker: "Y", priced: false, marketValue: null })];
  const d = allocationDrift({ positions, targets: { equities: 100 } });
  assert.equal(d.total, 1000);
});

/* ------------------------------ sell suggestions ---------------------------- */

test("sellSuggestions: sheltered wrapper holdings are sold first, tax-free", () => {
  const positions = [
    pos({ ticker: "GIA_GAIN", wrapper: "GIA", marketValue: 5000, unrealisedPct: 0.5 }),
    pos({ ticker: "ISA_HOLD", wrapper: "ISA", marketValue: 3000, unrealisedPct: 0.9 }),
  ];
  const drift = allocationDrift({ positions, targets: { equities: 0 } }); // fully overweight, sell everything
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 3000 });
  assert.equal(s.rows[0].ticker, "ISA_HOLD");
  assert.equal(s.rows[0].taxImpact, "tax-free (sheltered wrapper or CGT-exempt gilt)");
});

test("sellSuggestions: VCT holdings never appear as candidates, even when the bucket is overweight", () => {
  const positions = [
    pos({ ticker: "VCT1", wrapper: "VCT", kind: "equity", marketValue: 5000, unrealisedPct: 0.9 }),
    pos({ ticker: "EQ1", wrapper: "GIA", kind: "equity", marketValue: 3000, unrealisedPct: 0.1 }),
  ];
  const drift = allocationDrift({ positions, targets: { equities: 0 } });
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 3000 });
  assert.ok(s.rows.every((r) => r.ticker !== "VCT1"));
  assert.equal(s.rows[0].ticker, "EQ1");
});

test("sellSuggestions: CGT-exempt gilts rank alongside sheltered wrappers", () => {
  const positions = [
    pos({ ticker: "GILT1", wrapper: "GIA", kind: "gilt", cgtExempt: true, marketValue: 2000, unrealisedPct: 0.1 }),
    pos({ ticker: "BOND1", wrapper: "GIA", kind: "gilt", cgtExempt: false, marketValue: 2000, unrealisedPct: 0.05 }),
  ];
  const drift = allocationDrift({ positions, targets: { bonds: 0 } });
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 0 });
  assert.equal(s.rows[0].ticker, "GILT1");
  assert.equal(s.rows[0].taxImpact, "tax-free (sheltered wrapper or CGT-exempt gilt)");
});

test("sellSuggestions: losses are sold before gains even with zero AEA left", () => {
  const positions = [
    pos({ ticker: "LOSS1", wrapper: "GIA", marketValue: 2000, unrealisedPct: -0.2 }),
    pos({ ticker: "GAIN1", wrapper: "GIA", marketValue: 2000, unrealisedPct: 0.3 }),
  ];
  const drift = allocationDrift({ positions, targets: { equities: 0 } });
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 0 });
  assert.equal(s.rows[0].ticker, "LOSS1");
  assert.equal(s.rows[0].taxImpact, "loss or breakeven — no CGT, banks a loss");
  assert.equal(s.rows[1].ticker, "GAIN1");
  assert.equal(s.rows[1].taxImpact, "gain exceeds your remaining AEA — will trigger CGT at your marginal rate");
});

test("sellSuggestions: among taxable gains, smallest gain fraction is sold first", () => {
  const positions = [
    pos({ ticker: "BIGGAIN", wrapper: "GIA", marketValue: 2000, unrealisedPct: 0.5 }),
    pos({ ticker: "SMALLGAIN", wrapper: "GIA", marketValue: 2000, unrealisedPct: 0.1 }),
  ];
  const drift = allocationDrift({ positions, targets: { equities: 0 } });
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 10000 });
  assert.equal(s.rows[0].ticker, "SMALLGAIN");
  assert.equal(s.rows[1].ticker, "BIGGAIN");
});

test("sellSuggestions: gain realised is pro-rata to the fraction of the pool sold (Section 104)", () => {
  // Overweight by only £1000 of a £2000 holding with a 40% pool gain fraction
  // -> selling half the holding realises exactly half the pool's gain.
  const positions = [pos({ ticker: "HALF", wrapper: "GIA", marketValue: 2000, unrealisedPct: 0.4 })];
  const drift = allocationDrift({ positions, targets: { equities: 50 } }); // total=2000, target 50% -> targetValue 1000, drift 1000
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 10000 });
  assert.equal(s.rows[0].sellValue, 1000);
  assert.equal(s.rows[0].estGain, 400); // 1000 * 0.4
  assert.equal(s.rows[0].wholePosition, false);
});

test("sellSuggestions: AEA budget is shared across both buckets, not per-bucket", () => {
  const positions = [
    pos({ ticker: "EQ_GAIN", wrapper: "GIA", kind: "equity", marketValue: 3000, unrealisedPct: 0.5 }),
    pos({ ticker: "BOND_GAIN", wrapper: "GIA", kind: "bond_fund", marketValue: 3000, unrealisedPct: 0.5 }),
  ];
  const drift = allocationDrift({ positions, targets: { equities: 0, bonds: 0 } });
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 1000 });
  // total need = 6000, only 1000 of AEA to go around both buckets
  assert.equal(s.aeaUsed, 1000);
  assert.equal(s.aeaLeftAfter, 0);
});

test("sellSuggestions: nothing overweight -> no suggestions", () => {
  const positions = [pos({ marketValue: 1000 })];
  const drift = allocationDrift({ positions, targets: { equities: 100 } });
  const s = sellSuggestions({ positions, driftRows: drift.rows, aeaLeft: 3000 });
  assert.equal(s.rows.length, 0);
});

/* ------------------------------- buy suggestions ---------------------------- */

test("buySuggestions: lists existing holdings of an underweight bucket, largest first, never invents a new fund", () => {
  const positions = [
    pos({ ticker: "SMALL_BOND", wrapper: "GIA", kind: "bond_fund", marketValue: 500 }),
    pos({ ticker: "BIG_BOND", wrapper: "ISA", kind: "bond_fund", marketValue: 1500 }),
    pos({ ticker: "EQ1", kind: "equity", marketValue: 8000 }),
  ];
  const drift = allocationDrift({ positions, targets: { equities: 60, bonds: 40 } });
  const b = buySuggestions({ positions, driftRows: drift.rows });
  assert.equal(b.length, 1);
  assert.equal(b[0].bucket, "bonds");
  assert.equal(b[0].existingHoldings[0].ticker, "BIG_BOND");
  assert.equal(b[0].existingHoldings[1].ticker, "SMALL_BOND");
});

test("buySuggestions: never suggests adding to a VCT holding", () => {
  const positions = [
    pos({ ticker: "VCT1", wrapper: "VCT", kind: "equity", marketValue: 5000 }),
    pos({ ticker: "BOND1", wrapper: "GIA", kind: "gilt", marketValue: 1000 }),
  ];
  const drift = allocationDrift({ positions, targets: { equities: 80, bonds: 20 } });
  const b = buySuggestions({ positions, driftRows: drift.rows });
  const eqRow = b.find((r) => r.bucket === "equities");
  assert.ok(!eqRow || eqRow.existingHoldings.every((h) => h.ticker !== "VCT1"));
});

test("buySuggestions: an underweight bucket with no existing holdings still gets a row (empty holdings list)", () => {
  const positions = [pos({ marketValue: 1000 })];
  const drift = allocationDrift({ positions, targets: { equities: 50, bonds: 50 } });
  const b = buySuggestions({ positions, driftRows: drift.rows });
  const bondRow = b.find((r) => r.bucket === "bonds");
  assert.ok(bondRow);
  assert.deepEqual(bondRow.existingHoldings, []);
});

/* --------------------------------- orchestrator ----------------------------- */

test("rebalancePlan: combines drift, sells and buys into one result", () => {
  const positions = [
    pos({ ticker: "EQ1", kind: "equity", wrapper: "ISA", marketValue: 9000 }),
    pos({ ticker: "BOND1", kind: "bond_fund", wrapper: "GIA", marketValue: 1000 }),
  ];
  const plan = rebalancePlan({ positions, targets: { equities: 50, bonds: 50 }, aeaLeft: 3000 });
  assert.ok(plan.rows.length === 2);
  assert.equal(plan.sells.rows[0].ticker, "EQ1"); // overweight equities, sheltered, sells first
  assert.equal(plan.buys[0].bucket, "bonds");
});
