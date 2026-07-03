import { test } from "node:test";
import assert from "node:assert/strict";
import { matchWithPool, matchPortfolio, ukTaxYear, round4 } from "../core/cgt-engine.mjs";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const buy = (date, ticker, quantity, gbpAmount, id = date + ticker) => ({ id, date, ticker, side: "BUY", quantity, gbpAmount });
const sell = (date, ticker, quantity, gbpAmount, id = date + ticker + "S") => ({ id, date, ticker, side: "SELL", quantity, gbpAmount });
const eri = (date, ticker, gbpAmount) => ({ id: "e" + date, date, ticker, side: "ERI", quantity: 0, gbpAmount });

test("Section 104 pool: weighted-average cost on a straight buy/buy/sell", () => {
  const { results, poolQty, poolCost } = matchWithPool([
    buy("2020-01-01", "X", 100, 1000), // unit 10
    buy("2021-01-01", "X", 100, 2000), // unit 20 -> pool 200 @ 3000 (avg 15)
    sell("2022-01-01", "X", 100, 2500),
  ]);
  assert.equal(results.length, 1);
  assert.equal(results[0].legs[0].method, "SECTION_104");
  assert.ok(close(results[0].cost, 1500));
  assert.ok(close(results[0].gain, 1000));
  assert.ok(close(poolQty, 100));
  assert.ok(close(poolCost, 1500));
});

test("Same-day rule takes precedence over the pool", () => {
  const { results, poolQty, poolCost } = matchWithPool([
    buy("2020-01-01", "X", 100, 1000),          // pool lot, unit 10
    buy("2021-06-01", "X", 50, 1500, "sd-buy"), // same-day acquisition, unit 30
    sell("2021-06-01", "X", 50, 2000, "sd-sell"),
  ]);
  const leg = results[0].legs[0];
  assert.equal(leg.method, "SAME_DAY");
  assert.ok(close(leg.cost, 1500));  // matched against the £30 same-day lot, not the £10 pool
  assert.ok(close(results[0].gain, 500));
  assert.ok(close(poolQty, 100));    // original pool lot untouched
  assert.ok(close(poolCost, 1000));
});

test("30-day bed-&-breakfast: disposal matches a repurchase within 30 days", () => {
  const { results, poolQty, poolCost } = matchWithPool([
    buy("2020-01-01", "X", 100, 1000),           // pool, unit 10
    sell("2021-03-01", "X", 50, 1000, "s"),
    buy("2021-03-15", "X", 50, 600, "bb"),       // 14 days later, unit 12
  ]);
  const leg = results[0].legs[0];
  assert.equal(leg.method, "THIRTY_DAY");
  assert.ok(close(leg.cost, 600));
  assert.ok(close(results[0].gain, 400));
  assert.ok(close(poolQty, 100));
  assert.ok(close(poolCost, 1000));
});

test("30-day boundary: exactly 30 days matches, 31 does not", () => {
  const within = matchWithPool([
    buy("2020-01-01", "X", 100, 1000),
    sell("2021-01-01", "X", 50, 900, "s"),
    buy("2021-01-31", "X", 50, 800, "b"), // +30 days
  ]);
  assert.equal(within.results[0].legs[0].method, "THIRTY_DAY");

  const outside = matchWithPool([
    buy("2020-01-01", "X", 100, 1000),
    sell("2021-01-01", "X", 50, 900, "s"),
    buy("2021-02-01", "X", 50, 800, "b"), // +31 days -> pooled instead
  ]);
  assert.equal(outside.results[0].legs[0].method, "SECTION_104");
});

test("ERI uplifts the S104 pool cost on the distribution date", () => {
  const noEri = matchWithPool([
    buy("2020-01-01", "F", 100, 1000),
    sell("2021-06-01", "F", 100, 1200),
  ]);
  assert.ok(close(noEri.results[0].gain, 200));

  const withEri = matchWithPool([
    buy("2020-01-01", "F", 100, 1000),
    eri("2020-12-31", "F", 50),          // +£50 cost into the pool
    sell("2021-06-01", "F", 100, 1200),
  ]);
  assert.ok(close(withEri.results[0].gain, 150)); // 1200 - (1000 + 50)
});

test("ERI is ignored when the pool is empty", () => {
  const { poolQty, poolCost } = matchWithPool([
    eri("2019-01-01", "F", 50),          // no units held yet -> discarded
    buy("2020-01-01", "F", 100, 1000),
  ]);
  assert.ok(close(poolQty, 100));
  assert.ok(close(poolCost, 1000));      // uplift did not apply
});

test("Over-disposal throws", () => {
  assert.throws(() => matchWithPool([
    buy("2020-01-01", "X", 10, 100),
    sell("2021-01-01", "X", 20, 400),
  ]), /exceeds shares held/);
});

test("Fractional quantities pool without drift", () => {
  const { poolQty, poolCost } = matchWithPool([
    buy("2020-01-01", "X", 0.5, 5),
    buy("2020-02-01", "X", 0.25, 5),
  ]);
  assert.ok(close(poolQty, 0.75));
  assert.ok(close(poolCost, 10));
});

test("matchPortfolio groups independently by ticker", () => {
  const { disposals, pools } = matchPortfolio([
    buy("2020-01-01", "A", 100, 1000),
    sell("2021-01-01", "A", 50, 700),
    buy("2020-01-01", "B", 10, 500),
  ]);
  assert.equal(disposals.length, 1);
  assert.equal(disposals[0].ticker, "A");
  assert.ok(close(pools.A.qty, 50));
  assert.ok(close(pools.A.cost, 500));
  assert.ok(close(pools.B.qty, 10));
  assert.ok(close(pools.B.cost, 500));
});

test("ukTaxYear boundary is 6 April", () => {
  assert.equal(ukTaxYear("2024-04-05"), "2023/24");
  assert.equal(ukTaxYear("2024-04-06"), "2024/25");
  assert.equal(ukTaxYear("2025-12-31"), "2025/26");
  assert.equal(ukTaxYear("2025-01-01"), "2024/25");
});

test("round4 rounds to 4 dp", () => {
  assert.equal(round4(1.234567), 1.2346);
  assert.equal(round4(2), 2);
});
