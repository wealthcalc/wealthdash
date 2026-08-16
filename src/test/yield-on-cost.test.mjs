import { test } from "node:test";
import assert from "node:assert/strict";
import { yieldOnCost, profitBySource } from "../core/yield-on-cost.mjs";

const H = (ticker, { moneyIn, value, fwd = 0, ttm = 0, open = true, profit = null, incomeReceived = 0, fees = 0, realisedPL = null }) => ({
  ticker, wrapper: "GIA", moneyIn, value, open, priced: true,
  income: { forwardIncome: fwd, trailing12m: ttm },
  profit, incomeReceived, fees, realisedPL,
});

test("yield on COST differs from yield on VALUE, and the gap is the point", () => {
  // A trust bought at £10k now worth £30k, paying £900/yr: 3% to a buyer
  // today, 9% on the money actually invested. The second is the one that
  // decides whether a long-held income position is doing its job.
  const { rows, summary } = yieldOnCost({
    perHolding: [H("CTY", { moneyIn: 10000, value: 30000, fwd: 900, ttm: 880 })],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].yieldOnCost, 0.09);
  assert.equal(rows[0].yieldOnValue, 0.03);
  assert.equal(rows[0].uplift, 0.06, "how far the holding has re-rated since purchase");
  assert.equal(summary.yieldOnCost, 0.09);
});

test("holdings that pay nothing, and closed positions, are excluded", () => {
  const { rows, summary } = yieldOnCost({
    perHolding: [
      H("CTY", { moneyIn: 10000, value: 12000, fwd: 500 }),
      H("GROWTH", { moneyIn: 20000, value: 25000, fwd: 0, ttm: 0 }),      // no income
      H("SOLD", { moneyIn: 5000, value: 0, fwd: 300, open: false }),       // no longer held
    ],
  });
  assert.deepEqual(rows.map((r) => r.ticker), ["CTY"]);
  assert.equal(summary.incomeHoldings, 1);
  assert.equal(summary.cost, 10000, "a yield on shares you don't own is meaningless");
});

test("ranked by yield on cost, so the best long-term income earners lead", () => {
  const { rows } = yieldOnCost({
    perHolding: [
      H("LOW", { moneyIn: 10000, value: 10000, fwd: 200 }),    // 2%
      H("HIGH", { moneyIn: 10000, value: 40000, fwd: 1200 }),  // 12% on cost
      H("MID", { moneyIn: 10000, value: 10000, fwd: 600 }),    // 6%
    ],
  });
  assert.deepEqual(rows.map((r) => r.ticker), ["HIGH", "MID", "LOW"]);
});

test("zero-cost holdings don't divide by zero", () => {
  const { rows } = yieldOnCost({ perHolding: [H("GIFT", { moneyIn: 0, value: 5000, fwd: 150 })] });
  assert.equal(rows[0].yieldOnCost, null);
  assert.equal(rows[0].yieldOnValue, 0.03);
});

/* ------------------------- profit decomposition ------------------------ */

test("the parts sum EXACTLY to total profit", () => {
  const perHolding = [
    H("A", { moneyIn: 10000, value: 13000, profit: 3500, incomeReceived: 500 }),
    H("B", { moneyIn: 20000, value: 19000, profit: -800, incomeReceived: 200, fees: 50 }),
  ];
  const d = profitBySource({ perHolding });
  assert.equal(d.total, 2700);
  const sum = d.parts.reduce((s, p) => s + p.value, 0);
  assert.ok(Math.abs(sum - d.total) < 0.01, "a decomposition that doesn't reconcile is worse than none");
});

test("income and realised gains are separated from paper value", () => {
  // The distinction an income investor cares about: money that arrived
  // versus value that could still evaporate.
  const perHolding = [
    H("A", { moneyIn: 50000, value: 60000, profit: 15000, incomeReceived: 4000, realisedPL: 1000 }),
  ];
  const d = profitBySource({ perHolding });
  const by = Object.fromEntries(d.parts.map((p) => [p.key, p.value]));
  assert.equal(by.income, 4000);
  assert.equal(by.realised, 1000);
  assert.equal(by.capital, 10000, "the remainder is unrealised");
  // bankedShare is rounded to 4dp for display, so compare at that precision.
  assert.ok(Math.abs(d.bankedShare - (5000 / 15000)) < 1e-4);
});

test("fees appear as the negative they are, not netted away silently", () => {
  const perHolding = [H("A", { moneyIn: 10000, value: 11000, profit: 900, incomeReceived: 0, fees: 100 })];
  const d = profitBySource({ perHolding });
  const fees = d.parts.find((p) => p.key === "fees");
  assert.ok(fees, "dealing costs are shown");
  assert.ok(fees.value < 0);
  assert.equal(d.parts.reduce((s, p) => s + p.value, 0), 900);
});

test("unpriced holdings are excluded and counted, never treated as zero profit", () => {
  const d = profitBySource({
    perHolding: [
      H("KNOWN", { moneyIn: 10000, value: 12000, profit: 2000 }),
      { ticker: "UNPRICED", moneyIn: 10000, profit: null, open: true },
    ],
  });
  assert.equal(d.total, 2000);
  assert.equal(d.excludedCount, 1);
});

test("a flat portfolio withholds shares rather than dividing by ~zero", () => {
  const d = profitBySource({ perHolding: [H("A", { moneyIn: 10000, value: 10000, profit: 0 })] });
  assert.equal(d.total, 0);
  assert.equal(d.bankedShare, null);
  assert.ok(d.parts.every((p) => p.share === null));
});

test("empty inputs are safe", () => {
  assert.deepEqual(yieldOnCost({}).rows, []);
  assert.equal(profitBySource({}).total, 0);
});
