import { test } from "node:test";
import assert from "node:assert/strict";
import { solveSWR } from "../core/swr.mjs";

test("solveSWR: zero starting wealth or zero years returns a trivial zero-rate result", () => {
  const a = solveSWR({ startWealth: 0, years: 30 });
  assert.equal(a.rate, 0);
  assert.equal(a.annualAmount, 0);
  const b = solveSWR({ startWealth: 500000, years: 0 });
  assert.equal(b.rate, 0);
});

test("solveSWR: solved rate clears the target success threshold (within search precision)", () => {
  const r = solveSWR({
    startWealth: 1000000, years: 30, growthPost: 5, vol: 12, inflation: 2.5, fee: 0.5,
    targetSuccess: 0.9, runs: 150, seed: 11, iterations: 16,
  });
  assert.ok(r.rate > 0 && r.rate < 0.12);
  assert.ok(r.successRate >= 0.9 - 0.06); // small slack for MC sampling noise near the boundary
  assert.ok(Math.abs(r.annualAmount - r.rate * 1000000) < 1);
});

test("solveSWR: a higher target success rate never yields a higher (or equal, deterministically checked loosely) withdrawal rate", () => {
  const opts = { startWealth: 1000000, years: 30, growthPost: 5, vol: 12, inflation: 2.5, fee: 0.5, runs: 150, seed: 11, iterations: 16 };
  const loose = solveSWR({ ...opts, targetSuccess: 0.7 });
  const strict = solveSWR({ ...opts, targetSuccess: 0.97 });
  assert.ok(strict.rate <= loose.rate + 1e-9);
});

test("solveSWR: a longer retirement horizon never yields a higher sustainable rate (same confidence)", () => {
  const opts = { startWealth: 1000000, growthPost: 5, vol: 12, inflation: 2.5, fee: 0.5, targetSuccess: 0.85, runs: 150, seed: 11, iterations: 16 };
  const short = solveSWR({ ...opts, years: 20 });
  const long = solveSWR({ ...opts, years: 40 });
  assert.ok(long.rate <= short.rate + 1e-9);
});

test("solveSWR: same seed is deterministic across repeated calls", () => {
  const opts = { startWealth: 800000, years: 25, growthPost: 4.5, vol: 13, inflation: 3, fee: 0.5, targetSuccess: 0.9, runs: 120, seed: 99, iterations: 14 };
  const a = solveSWR(opts);
  const b = solveSWR(opts);
  assert.equal(a.rate, b.rate);
  assert.equal(a.successRate, b.successRate);
});

test("solveSWR: flags atFloor when even the lowest searched rate can't clear the target", () => {
  const r = solveSWR({
    startWealth: 1000000, years: 40, growthPost: -2, vol: 25, inflation: 5, fee: 2,
    targetSuccess: 0.99, runs: 80, seed: 3, rateLow: 0.03, rateHigh: 0.12, iterations: 10,
  });
  assert.ok(r.atFloor);
  assert.equal(r.rate, 0.03);
});
