import { test } from "node:test";
import assert from "node:assert/strict";
import { runGuytonKlinger } from "../core/guyton-klinger.mjs";

const BASE = { startWealth: 1000000, years: 30, initialRate: 0.05, growthPost: 5, vol: 12, inflation: 2.5, runs: 150, seed: 21 };

test("runGuytonKlinger: returns success rates in [0,1] and a positive initial withdrawal", () => {
  const r = runGuytonKlinger(BASE);
  assert.ok(r.successRate >= 0 && r.successRate <= 1);
  assert.ok(r.fixedSuccessRate >= 0 && r.fixedSuccessRate <= 1);
  assert.equal(r.initialAnnualAmount, BASE.startWealth * BASE.initialRate);
  assert.equal(r.incomeFan.length, BASE.years);
});

test("runGuytonKlinger: guardrails give GK a success rate at least as good as a fixed real withdrawal at the same initial rate", () => {
  // GK can cut spending when markets are bad — it should never do WORSE
  // than a rigid fixed-real schedule at the same starting rate (same
  // random paths, since both use common random numbers internally).
  const r = runGuytonKlinger(BASE);
  assert.ok(r.successRate >= r.fixedSuccessRate - 1e-9);
  assert.ok(Math.abs(r.successDelta - (r.successRate - r.fixedSuccessRate)) < 1e-9);
});

test("runGuytonKlinger: a higher initial withdrawal rate produces more capital-preservation cuts on average", () => {
  const modest = runGuytonKlinger({ ...BASE, initialRate: 0.035 });
  const aggressive = runGuytonKlinger({ ...BASE, initialRate: 0.08 });
  assert.ok(aggressive.avgCutsPerPath >= modest.avgCutsPerPath);
});

test("runGuytonKlinger: deterministic for a fixed seed", () => {
  const a = runGuytonKlinger(BASE);
  const b = runGuytonKlinger(BASE);
  assert.equal(a.successRate, b.successRate);
  assert.equal(a.avgCutsPerPath, b.avgCutsPerPath);
  assert.deepEqual(a.incomeFan, b.incomeFan);
});

test("runGuytonKlinger: freezeLastYears=years disables all guardrail adjustments (cuts/raises stay 0)", () => {
  const r = runGuytonKlinger({ ...BASE, freezeLastYears: BASE.years });
  assert.equal(r.avgCutsPerPath, 0);
  assert.equal(r.avgRaisesPerPath, 0);
});

test("runGuytonKlinger: a very low initial rate survives virtually every path (guardrails aside, cuts/raises just reshape income, not survival)", () => {
  const r = runGuytonKlinger({ ...BASE, initialRate: 0.02 });
  assert.ok(r.successRate >= 0.98);
});
