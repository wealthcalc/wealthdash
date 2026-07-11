import { test } from "node:test";
import assert from "node:assert/strict";
import { runMonteCarlo, bootstrapPairs, TWO_ASSET_DEFAULTS } from "../core/monte-carlo.mjs";
import { HIST } from "../core/drawdown.mjs";

const BASE = {
  startWealth: 500000, accumYears: 5,
  wealthContribSchedule: [20000, 20000, 20000, 20000, 20000],
  withdrawSchedule: Array.from({ length: 25 }, (_, i) => 30000 * Math.pow(1.03, i + 5)),
  growthPre: 6, growthPost: 4.5, fee: 0.5, vol: 13, inflation: 3, currentAge: 55,
  runs: 400, seed: 7,
};

test("default mode reproduces the legacy engine exactly (same seed, same numbers)", () => {
  const a = runMonteCarlo(BASE);
  const b = runMonteCarlo({ ...BASE, model: "single", stochasticInflation: false });
  assert.equal(a.successRate, b.successRate);
  assert.deepEqual(a.fan[10], b.fan[10]);
  assert.equal(a.medianRetire, b.medianRetire);
});

test("two-asset mode runs, is seed-reproducible, and glidepath derisking changes the tails", () => {
  const flat = runMonteCarlo({ ...BASE, model: "twoAsset", glidepath: { start: 80, end: 80 } });
  const flat2 = runMonteCarlo({ ...BASE, model: "twoAsset", glidepath: { start: 80, end: 80 } });
  assert.equal(flat.successRate, flat2.successRate); // reproducible
  const derisked = runMonteCarlo({ ...BASE, model: "twoAsset", glidepath: { start: 80, end: 20 } });
  const lastFlat = flat.fan[flat.fan.length - 1];
  const lastDr = derisked.fan[derisked.fan.length - 1];
  // Derisking narrows the terminal distribution (p90 − p10 spread shrinks).
  assert.ok((lastDr.p90 - lastDr.p10) < (lastFlat.p90 - lastFlat.p10));
});

test("an all-bond glidepath has a tighter fan than all-equity", () => {
  const eq = runMonteCarlo({ ...BASE, model: "twoAsset", glidepath: { start: 100, end: 100 } });
  const bonds = runMonteCarlo({ ...BASE, model: "twoAsset", glidepath: { start: 0, end: 0 } });
  const spread = (mc) => { const l = mc.fan[mc.fan.length - 1]; return l.p90 - l.p10; };
  assert.ok(spread(bonds) < spread(eq));
});

test("stochastic inflation lowers success for a HEALTHY plan (withdrawals re-scale with the simulated path)", () => {
  // Direction discovered while writing this test, worth recording: the
  // effect of inflation volatility is ASYMMETRIC around the success rate.
  // For a marginal plan (~35% success) it can RAISE success — failing
  // paths can't fail twice, while low-inflation paths rescue marginal
  // ones. For a healthy plan (the realistic case someone actually
  // retires on) the conversion runs the other way: inflation shocks
  // convert successes to failures. So the assertion uses a healthy plan.
  const healthy = { ...BASE, withdrawSchedule: Array.from({ length: 25 }, (_, i) => 20000 * Math.pow(1.03, i + 5)), runs: 1500 };
  const fixed = runMonteCarlo(healthy);
  const stoch = runMonteCarlo({ ...healthy, stochasticInflation: true, inflVol: 3 });
  assert.ok(fixed.successRate > 0.7, `baseline should be healthy, got ${fixed.successRate}`);
  assert.ok(stoch.successRate < fixed.successRate,
    `stochastic ${stoch.successRate} should sit below fixed ${fixed.successRate} for a healthy plan`);
});

test("bootstrap draws paired return+inflation years from HIST and is reproducible", () => {
  const pairs = bootstrapPairs(HIST);
  assert.ok(pairs.length >= 25);
  assert.ok(pairs.every((p) => Number.isFinite(p.ret) && Number.isFinite(p.infl)));
  // the pool includes the 2008-style left tail
  assert.ok(Math.min(...pairs.map((p) => p.ret)) <= -30);
  const a = runMonteCarlo({ ...BASE, model: "bootstrap", histPairs: pairs });
  const b = runMonteCarlo({ ...BASE, model: "bootstrap", histPairs: pairs });
  assert.equal(a.successRate, b.successRate);
  assert.ok(a.successRate > 0 && a.successRate <= 1);
  assert.throws(() => runMonteCarlo({ ...BASE, model: "bootstrap" }), /histPairs/);
});

test("two-asset defaults are sane and exported for the UI to display", () => {
  assert.ok(TWO_ASSET_DEFAULTS.equityVol > TWO_ASSET_DEFAULTS.bondVol);
  assert.ok(TWO_ASSET_DEFAULTS.equityMean > TWO_ASSET_DEFAULTS.bondMean);
  assert.ok(Math.abs(TWO_ASSET_DEFAULTS.correlation) <= 1);
});
