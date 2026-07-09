import { test } from "node:test";
import assert from "node:assert/strict";
import { randn, mulberry32, runMonteCarlo, runScenarioAB } from "../core/monte-carlo.mjs";

/* -------------------------------- randn ------------------------------------ */

test("randn: deterministic given a seeded rng, varies with different seeds", () => {
  const a1 = randn(mulberry32(1));
  const a2 = randn(mulberry32(1));
  const b1 = randn(mulberry32(2));
  assert.equal(a1, a2);
  assert.notEqual(a1, b1);
});

test("mulberry32: same seed reproduces the exact same sequence", () => {
  const seq = (seed) => { const r = mulberry32(seed); return [r(), r(), r()]; };
  assert.deepEqual(seq(7), seq(7));
});

/* ---------------------------- runMonteCarlo --------------------------------- */

const baseInputs = () => ({
  startWealth: 100000, accumYears: 10, decYears: 20,
  wealthContribSchedule: Array(10).fill(10000),
  withdrawSchedule: Array(20).fill(20000),
  growthPre: 6, growthPost: 4, fee: 0.5, vol: 12, inflation: 2.5, currentAge: 40,
});

test("runMonteCarlo: identical seed produces identical output (reproducible)", () => {
  const r1 = runMonteCarlo({ ...baseInputs(), runs: 200, seed: 123 });
  const r2 = runMonteCarlo({ ...baseInputs(), runs: 200, seed: 123 });
  assert.deepEqual(r1, r2);
});

test("runMonteCarlo: different seeds generally produce different outcomes", () => {
  const r1 = runMonteCarlo({ ...baseInputs(), runs: 200, seed: 1 });
  const r2 = runMonteCarlo({ ...baseInputs(), runs: 200, seed: 2 });
  assert.notEqual(r1.medianRetire, r2.medianRetire);
});

test("runMonteCarlo: zero volatility collapses every run to the same deterministic path", () => {
  const r = runMonteCarlo({ ...baseInputs(), vol: 0, runs: 50, seed: 5 });
  // p10/p50/p90 identical at every age when there's no randomness to spread them
  for (const row of r.fan) {
    assert.equal(row.p10, row.p50);
    assert.equal(row.p50, row.p90);
  }
});

test("runMonteCarlo: higher volatility widens the p10-p90 spread at a given age", () => {
  const lowVol = runMonteCarlo({ ...baseInputs(), vol: 3, runs: 400, seed: 9 });
  const highVol = runMonteCarlo({ ...baseInputs(), vol: 25, runs: 400, seed: 9 });
  const spreadAt = (r, age) => { const row = r.fan.find((x) => x.age === age); return row.p90 - row.p10; };
  assert.ok(spreadAt(highVol, 55) > spreadAt(lowVol, 55));
});

test("runMonteCarlo: no withdrawals ever due -> 100% success regardless of returns", () => {
  const r = runMonteCarlo({
    startWealth: 100000, accumYears: 5, wealthContribSchedule: Array(5).fill(5000),
    withdrawSchedule: Array(5).fill(0), growthPre: 5, growthPost: 5, vol: 20, inflation: 2,
    currentAge: 50, runs: 100, seed: 3,
  });
  assert.equal(r.successRate, 1);
});

test("runMonteCarlo: huge withdrawals against a tiny pot mostly fail", () => {
  const r = runMonteCarlo({
    startWealth: 1000, accumYears: 0, wealthContribSchedule: [],
    withdrawSchedule: Array(20).fill(50000), growthPre: 5, growthPost: 5, vol: 10, inflation: 2,
    currentAge: 65, runs: 200, seed: 11,
  });
  assert.ok(r.successRate < 0.05);
});

test("runMonteCarlo: fan is keyed by age starting at currentAge, one row per simulated year", () => {
  const r = runMonteCarlo({ ...baseInputs(), runs: 50, seed: 4 });
  assert.equal(r.fan.length, 30); // accumYears 10 + decYears 20
  assert.equal(r.fan[0].age, 40);
  assert.equal(r.fan[29].age, 69);
});

test("runMonteCarlo: onProgress fires and reaches 1 on the final run", () => {
  const seen = [];
  runMonteCarlo({ ...baseInputs(), runs: 120, seed: 1, progressEvery: 50, onProgress: (f) => seen.push(f) });
  assert.ok(seen.length > 0);
  assert.equal(seen[seen.length - 1], 1);
});

/* ----------------------------- runScenarioAB --------------------------------- */

test("runScenarioAB: same inputs for both sides -> zero deltas (common random numbers)", () => {
  const inputs = { ...baseInputs(), runs: 150 };
  const res = runScenarioAB(inputs, inputs, { seed: 42 });
  assert.equal(res.successDelta, 0);
  assert.equal(res.medianRetireDelta, 0);
});

test("runScenarioAB: a strictly worse B (lower growth) never outperforms A given common random numbers", () => {
  const a = { ...baseInputs(), runs: 300 };
  const b = { ...baseInputs(), runs: 300, growthPre: 1, growthPost: 1 };
  const res = runScenarioAB(a, b, { seed: 7 });
  assert.ok(res.medianRetireDelta < 0);
  assert.equal(res.b.medianRetire < res.a.medianRetire, true);
});
