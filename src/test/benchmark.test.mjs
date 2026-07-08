import { test } from "node:test";
import assert from "node:assert/strict";
import { growthIndex, maxDrawdown, volatility, benchmarkCumulativeReturn, feeDrag } from "../core/benchmark.mjs";

/* ------------------------------ growth index ----------------------------- */

test("growthIndex: chains period factors from 100, one point per snapshot date", () => {
  const periods = [
    { from: "2026-01-01", to: "2026-02-01", factor: 1.10 },
    { from: "2026-02-01", to: "2026-03-01", factor: 0.90 },
  ];
  const idx = growthIndex(periods, "2026-01-01");
  assert.equal(idx.length, 3);
  assert.equal(idx[0].index, 100);
  assert.equal(Math.round(idx[1].index * 100) / 100, 110);
  assert.equal(Math.round(idx[2].index * 100) / 100, 99); // 110 * 0.9
});

test("growthIndex: no start date -> empty (nothing to anchor to)", () => {
  assert.deepEqual(growthIndex([{ from: "a", to: "b", factor: 1.1 }], null), []);
});

/* ------------------------------ max drawdown ------------------------------ */

test("maxDrawdown: finds the true peak-to-trough decline, not just first-to-last", () => {
  // 100 -> 120 (new peak) -> 90 (trough, -25% off 120) -> 130 (fresh high, recovers)
  const idx = [
    { date: "2026-01-01", index: 100 },
    { date: "2026-02-01", index: 120 },
    { date: "2026-03-01", index: 90 },
    { date: "2026-04-01", index: 130 },
  ];
  const dd = maxDrawdown(idx);
  assert.equal(Math.round(dd.maxDrawdown * 10000) / 10000, -0.25);
  assert.equal(dd.peakDate, "2026-02-01");
  assert.equal(dd.troughDate, "2026-03-01");
  assert.equal(dd.recovered, true);
  assert.equal(dd.recoveryDate, "2026-04-01");
});

test("maxDrawdown: never recovered -> recovered false, recoveryDate null", () => {
  const idx = [
    { date: "2026-01-01", index: 100 },
    { date: "2026-02-01", index: 150 },
    { date: "2026-03-01", index: 120 },
  ];
  const dd = maxDrawdown(idx);
  assert.equal(dd.recovered, false);
  assert.equal(dd.recoveryDate, null);
});

test("maxDrawdown: monotonically rising series -> zero drawdown", () => {
  const idx = [{ date: "2026-01-01", index: 100 }, { date: "2026-02-01", index: 110 }, { date: "2026-03-01", index: 120 }];
  const dd = maxDrawdown(idx);
  assert.equal(dd.maxDrawdown, 0);
});

test("maxDrawdown: fewer than 2 points -> not measurable", () => {
  assert.equal(maxDrawdown([{ date: "a", index: 100 }]).maxDrawdown, null);
  assert.equal(maxDrawdown([]).maxDrawdown, null);
});

/* -------------------------------- volatility ------------------------------ */

test("volatility: constant returns -> zero stdev, still returns an annualised figure", () => {
  const periods = [
    { from: "2026-01-01", to: "2026-02-01", factor: 1.01 },
    { from: "2026-02-01", to: "2026-03-01", factor: 1.01 },
    { from: "2026-03-01", to: "2026-04-01", factor: 1.01 },
  ];
  const v = volatility(periods);
  assert.equal(Math.round(v.periodStdev * 1e9), 0);
  assert.ok(v.annualisedVol === 0);
  assert.equal(v.sampleSize, 3);
});

test("volatility: needs at least 2 periods", () => {
  assert.equal(volatility([{ from: "2026-01-01", to: "2026-02-01", factor: 1.05 }]).annualisedVol, null);
  assert.equal(volatility([]).annualisedVol, null);
});

test("volatility: more dispersed returns give a higher stdev than steady ones", () => {
  const steady = [
    { from: "2026-01-01", to: "2026-02-01", factor: 1.01 },
    { from: "2026-02-01", to: "2026-03-01", factor: 1.01 },
    { from: "2026-03-01", to: "2026-04-01", factor: 1.01 },
  ];
  const choppy = [
    { from: "2026-01-01", to: "2026-02-01", factor: 1.10 },
    { from: "2026-02-01", to: "2026-03-01", factor: 0.92 },
    { from: "2026-03-01", to: "2026-04-01", factor: 1.08 },
  ];
  assert.ok(volatility(choppy).annualisedVol > volatility(steady).annualisedVol);
});

/* --------------------------- benchmark comparison -------------------------- */

test("benchmarkCumulativeReturn: buy-and-hold return between the closest prices on/before each date", () => {
  const prices = [
    { date: "2025-12-30", close: 100 },
    { date: "2026-01-02", close: 102 },
    { date: "2026-06-30", close: 110 },
    { date: "2026-07-08", close: 112 },
  ];
  const r = benchmarkCumulativeReturn(prices, "2026-01-05", "2026-07-08");
  // on-or-before 2026-01-05 -> 2026-01-02 close 102; on-or-before 2026-07-08 -> 112
  assert.equal(r.fromClose, 102);
  assert.equal(r.toClose, 112);
  assert.equal(Math.round(r.cumulativeReturn * 10000) / 10000, Math.round((112 / 102 - 1) * 10000) / 10000);
});

test("benchmarkCumulativeReturn: no price on/before a required date -> not available", () => {
  const prices = [{ date: "2026-06-01", close: 100 }];
  const r = benchmarkCumulativeReturn(prices, "2026-01-01", "2026-07-08");
  assert.equal(r.cumulativeReturn, null);
});

test("benchmarkCumulativeReturn: invalid date range rejected", () => {
  assert.equal(benchmarkCumulativeReturn([{ date: "2026-01-01", close: 100 }], "2026-07-08", "2026-01-01").cumulativeReturn, null);
});

/* ---------------------------------- fees ----------------------------------- */

test("feeDrag: asset-weighted OCF across open, priced holdings with a known OCF", () => {
  const holdings = [
    { ticker: "SWDA", wrapper: "GIA", open: true, marketValue: 10000 },
    { ticker: "EMIM", wrapper: "GIA", open: true, marketValue: 5000 },
    { ticker: "OLDCO", wrapper: "GIA", open: false, marketValue: 0 }, // closed, excluded
  ];
  const ocfByTicker = { SWDA: 0.2, EMIM: 0.18 };
  const f = feeDrag({ holdings, ocfByTicker });
  // weighted = (10000*0.002 + 5000*0.0018) / 15000 = (20 + 9) / 15000 = 0.19333...%
  assert.equal(Math.round(f.weightedOcf * 1000) / 1000, 0.193);
  assert.equal(Math.round(f.totalAnnualCost * 100) / 100, 29);
  assert.equal(f.knownValue, 15000);
  assert.equal(f.unknownValue, 0);
});

test("feeDrag: holdings with no recorded OCF are excluded from the average but still listed", () => {
  const holdings = [
    { ticker: "SWDA", wrapper: "GIA", open: true, marketValue: 10000 },
    { ticker: "MYSTERY", wrapper: "GIA", open: true, marketValue: 2000 },
  ];
  const f = feeDrag({ holdings, ocfByTicker: { SWDA: 0.2 } });
  assert.equal(f.rows.length, 2);
  assert.equal(f.rows.find((r) => r.ticker === "MYSTERY").ocf, null);
  assert.equal(f.unknownValue, 2000);
  assert.equal(f.knownValue, 10000);
  assert.equal(Math.round(f.weightedOcf * 1000) / 1000, 0.2);
});

test("feeDrag: no open holdings -> nulls, not NaN/crash", () => {
  const f = feeDrag({ holdings: [], ocfByTicker: {} });
  assert.equal(f.weightedOcf, null);
  assert.equal(f.totalAnnualCost, null);
});
