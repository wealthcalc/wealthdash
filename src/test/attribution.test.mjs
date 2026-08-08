import { test } from "node:test";
import assert from "node:assert/strict";
import { returnAttribution } from "../core/attribution.mjs";

const H = (ticker, wrapper, moneyIn, profit, extra = {}) => ({
  ticker, wrapper, moneyIn, profit, value: moneyIn + profit, incomeReceived: 0, open: true, priced: true, ...extra,
});

test("contributions sum EXACTLY to the portfolio return — the decomposition must reconcile", () => {
  const perHolding = [H("A", "GIA", 50000, 5000), H("B", "ISA", 30000, -1500), H("C", "GIA", 20000, 4000)];
  const total = { moneyIn: 100000 };
  const { rows, summary } = returnAttribution({ perHolding, total });

  assert.equal(summary.totalProfit, 7500);
  assert.equal(summary.portfolioReturn, 0.075);
  assert.equal(summary.contributionSum, summary.portfolioReturn, "parts must add to the whole");
  assert.equal(rows.reduce((s, r) => s + r.profit, 0), 7500);
});

test("size and performance are separated — a big modest holding can beat a small spectacular one", () => {
  // This is the whole point: 60% on 1% of the money is noise; 10% on half of
  // it is the actual story.
  const perHolding = [
    H("BIG", "GIA", 500000, 50000),   // 10% on half the portfolio
    H("MOON", "GIA", 10000, 6000),    // 60% on a tiny position
  ];
  const { rows } = returnAttribution({ perHolding, total: { moneyIn: 1000000 } });
  const big = rows.find((r) => r.ticker === "BIG");
  const moon = rows.find((r) => r.ticker === "MOON");

  assert.equal(moon.ownReturn, 0.6, "MOON had the better return...");
  assert.ok(big.ownReturn < moon.ownReturn);
  assert.ok(big.contribution > moon.contribution, "...but BIG drove the portfolio");
  assert.equal(rows[0].ticker, "BIG", "ranked by what actually moved the number");
  assert.equal(big.weight, 0.5);
});

test("losers are reported as clearly as winners, worst first", () => {
  const perHolding = [H("UP", "GIA", 10000, 2000), H("DOWN", "GIA", 20000, -5000), H("WORSE", "GIA", 30000, -9000)];
  const { winners, losers, summary } = returnAttribution({ perHolding, total: { moneyIn: 60000 } });
  assert.deepEqual(winners.map((r) => r.ticker), ["UP"]);
  assert.deepEqual(losers.map((r) => r.ticker), ["WORSE", "DOWN"], "biggest drag first");
  assert.equal(summary.totalProfit, -12000);
  assert.ok(summary.portfolioReturn < 0);
});

test("unpriced holdings are EXCLUDED, not silently counted as zero profit", () => {
  // Treating unknown as nil would credit the rest of the portfolio with
  // performance that simply hasn't been measured.
  const perHolding = [
    H("KNOWN", "GIA", 50000, 5000),
    { ticker: "UNPRICED", wrapper: "GIA", moneyIn: 50000, profit: null, open: true, priced: false },
  ];
  const { rows, summary } = returnAttribution({ perHolding, total: { moneyIn: 100000 } });
  assert.equal(rows.length, 1);
  assert.equal(summary.excludedCount, 1);
  assert.deepEqual(summary.excludedTickers, ["UNPRICED"]);
});

test("grouping by wrapper aggregates holdings and still reconciles", () => {
  const perHolding = [
    H("A", "GIA", 40000, 4000), H("B", "GIA", 10000, 1000),
    H("C", "ISA", 50000, 2500),
  ];
  const { rows, summary } = returnAttribution({ perHolding, total: { moneyIn: 100000 }, by: "wrapper" });
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(rows.length, 2);
  assert.equal(byKey.GIA.profit, 5000);
  assert.equal(byKey.GIA.positions, 2);
  assert.equal(byKey.ISA.profit, 2500);
  assert.equal(summary.contributionSum, summary.portfolioReturn);
});

test("share of profit is withheld when the portfolio is flat — a tiny denominator lies", () => {
  const perHolding = [H("A", "GIA", 50000, 5000), H("B", "GIA", 50000, -5000)];
  const { rows, summary } = returnAttribution({ perHolding, total: { moneyIn: 100000 } });
  assert.equal(summary.totalProfit, 0);
  assert.equal(rows[0].shareOfProfit, null, "no 'A produced 8000% of the profit'");
  assert.equal(summary.top3Share, null);
  assert.equal(rows[0].contribution, 0.05, "contribution still works — it's on a stable base");
});

test("top-3 share answers whether concentration is earning its risk", () => {
  const perHolding = [
    H("A", "GIA", 10000, 6000), H("B", "GIA", 10000, 3000), H("C", "GIA", 10000, 1000),
    H("D", "GIA", 10000, 100), H("E", "GIA", 10000, -100),
  ];
  const { summary } = returnAttribution({ perHolding, total: { moneyIn: 50000 } });
  assert.equal(summary.totalProfit, 10000);
  assert.equal(summary.top3Share, 1, "the top three produced all of it");
});

test("empty and degenerate inputs are safe", () => {
  const empty = returnAttribution({});
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.summary.totalProfit, 0);
  assert.equal(empty.summary.portfolioReturn, null);

  // No money in (e.g. a gifted holding) must not divide by zero.
  const zero = returnAttribution({ perHolding: [H("X", "GIA", 0, 500)], total: { moneyIn: 0 } });
  assert.equal(zero.rows[0].ownReturn, null);
  assert.equal(zero.rows[0].contribution, 0);
});
