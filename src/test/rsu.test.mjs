import { test } from "node:test";
import assert from "node:assert/strict";
import { grantEvents, vestingSchedule, grantSummary, rsuTotals } from "../core/rsu.mjs";

const g = (over) => ({ id: "g1", ticker: "WFC", grantDate: "2023-01-01", note: "2023 grant", ...over });

/* -------------------------------- events ---------------------------------- */

test("grantEvents: filters to just the given grant", () => {
  const events = [
    { grantId: "g1", type: "vest", date: "2024-01-01", shares: 10 },
    { grantId: "g2", type: "vest", date: "2024-01-01", shares: 5 },
  ];
  assert.equal(grantEvents("g1", events).length, 1);
});

/* ----------------------------- vestingSchedule ------------------------------ */

test("vestingSchedule: sorts by date, tags vested/unvested, running total", () => {
  const events = [
    { grantId: "g1", type: "vest", date: "2025-01-01", shares: 25 },
    { grantId: "g1", type: "vest", date: "2024-01-01", shares: 25 },
    { grantId: "g1", type: "vest", date: "2026-01-01", shares: 25 },
  ];
  const sched = vestingSchedule(g(), events, "2025-06-01");
  assert.deepEqual(sched.map((s) => s.date), ["2024-01-01", "2025-01-01", "2026-01-01"]);
  assert.deepEqual(sched.map((s) => s.vested), [true, true, false]);
  assert.deepEqual(sched.map((s) => s.cumulativeShares), [25, 50, 75]);
});

test("vestingSchedule: ignores sale events entirely", () => {
  const events = [
    { grantId: "g1", type: "vest", date: "2024-01-01", shares: 25 },
    { grantId: "g1", type: "sale", date: "2024-06-01", shares: 10, priceNative: 50, fxRate: 0.8 },
  ];
  assert.equal(vestingSchedule(g(), events, "2025-01-01").length, 1);
});

/* ------------------------------ grantSummary -------------------------------- */

test("grantSummary: nothing vested yet — all figures zero/null, next vest surfaced", () => {
  const events = [{ grantId: "g1", type: "vest", date: "2026-01-01", shares: 100 }];
  const s = grantSummary(g(), events, { WFC: 45 }, "2025-01-01");
  assert.equal(s.vestedShares, 0);
  assert.equal(s.unvestedShares, 100);
  assert.equal(s.heldShares, 0);
  assert.equal(s.currentValueGBP, 0); // heldShares 0 * price
  assert.deepEqual(s.nextVest, { date: "2026-01-01", shares: 100 });
});

test("grantSummary: fully vested, unpriced ticker — currentValue/unrealised are null, not 0", () => {
  const events = [{ grantId: "g1", type: "vest", date: "2024-01-01", shares: 100, priceNative: 40, fxRate: 0.8 }];
  const s = grantSummary(g(), events, {}, "2025-01-01");
  assert.equal(s.priced, false);
  assert.equal(s.currentValueGBP, null);
  assert.equal(s.unrealisedGBP, null);
  assert.equal(s.heldShares, 100);
  assert.equal(s.vestValueGBP, 3200); // 100 * 40 * 0.8
});

test("grantSummary: priced holding computes unrealised gain against vest-date FMV cost basis", () => {
  const events = [{ grantId: "g1", type: "vest", date: "2024-01-01", shares: 100, priceNative: 40, fxRate: 0.8 }]; // cost 3200 GBP, 32/share
  const s = grantSummary(g(), events, { WFC: 50 }, "2025-01-01"); // now worth 50/share GBP
  assert.equal(s.currentValueGBP, 5000);
  assert.equal(s.unrealisedGBP, 1800); // 5000 - 3200
});

test("grantSummary: partial sale reduces held shares and computes a realised gain informationally", () => {
  const events = [
    { grantId: "g1", type: "vest", date: "2024-01-01", shares: 100, priceNative: 40, fxRate: 0.8 }, // cost 32/share GBP
    { grantId: "g1", type: "sale", date: "2024-06-01", shares: 30, priceNative: 55, fxRate: 0.79 }, // sale proceeds 30*55*0.79=1303.5
  ];
  const s = grantSummary(g(), events, { WFC: 50 }, "2025-01-01");
  assert.equal(s.soldShares, 30);
  assert.equal(s.heldShares, 70);
  assert.equal(s.saleValueGBP, 1303.5);
  assert.equal(s.realizedGBP, round2(1303.5 - 30 * 32)); // proceeds - cost of shares sold
  assert.equal(s.currentValueGBP, 3500); // 70 * 50
});

function round2(x) { return Math.round(x * 100) / 100; }

test("grantSummary: multiple vest tranches average correctly for cost basis", () => {
  const events = [
    { grantId: "g1", type: "vest", date: "2023-01-01", shares: 50, priceNative: 30, fxRate: 0.8 }, // 1200 GBP
    { grantId: "g1", type: "vest", date: "2024-01-01", shares: 50, priceNative: 50, fxRate: 0.8 }, // 2000 GBP
  ];
  const s = grantSummary(g(), events, { WFC: 40 }, "2025-01-01");
  assert.equal(s.vestedShares, 100);
  assert.equal(s.vestValueGBP, 3200);
  assert.equal(s.avgCostPerShare, 32);
  assert.equal(s.currentValueGBP, 4000); // 100 * 40
  assert.equal(s.unrealisedGBP, 800);
});

/* ------------------------------- rsuTotals ---------------------------------- */

test("rsuTotals: sums across multiple grants, sorted by soonest next vest", () => {
  const grants = [g({ id: "g1" }), g({ id: "g2", ticker: "MSFT" })];
  const events = [
    { grantId: "g1", type: "vest", date: "2024-01-01", shares: 100, priceNative: 40, fxRate: 0.8 },
    { grantId: "g1", type: "vest", date: "2026-06-01", shares: 50 },
    { grantId: "g2", type: "vest", date: "2024-01-01", shares: 20, priceNative: 300, fxRate: 0.78 },
    { grantId: "g2", type: "vest", date: "2025-06-01", shares: 20 },
  ];
  const t = rsuTotals(grants, events, { WFC: 50, MSFT: 350 }, "2025-01-01");
  assert.equal(t.rows.length, 2);
  assert.equal(t.rows[0].grant.id, "g2"); // next vest 2025-06-01 < g1's 2026-06-01
  assert.equal(t.heldShares, 120); // 100 (g1) + 20 (g2)
  assert.equal(t.currentValueGBP, 100 * 50 + 20 * 350);
});

test("rsuTotals: empty portfolio is all-zero, not NaN", () => {
  const t = rsuTotals([], [], {}, "2025-01-01");
  assert.equal(t.totalShares, 0);
  assert.equal(t.currentValueGBP, 0);
  assert.deepEqual(t.rows, []);
});

test("rsuTotals: flags unpriced grants that still have shares held", () => {
  const grants = [g({ id: "g1" })];
  const events = [{ grantId: "g1", type: "vest", date: "2024-01-01", shares: 10, priceNative: 40, fxRate: 0.8 }];
  const t = rsuTotals(grants, events, {}, "2025-01-01");
  assert.equal(t.unpriced, 1);
});
