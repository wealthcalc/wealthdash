import { test } from "node:test";
import assert from "node:assert/strict";
import { dataHealth } from "../core/data-health.mjs";

const TODAY = "2026-07-20";

test("a clean dataset scores 100 with no issues", () => {
  const h = dataHealth({ today: TODAY });
  assert.equal(h.score, 100);
  assert.equal(h.clean, true);
  assert.deepEqual(h.issues, []);
});

test("severity reflects how much a thing distorts the numbers, not volume", () => {
  // One unpriced holding (high) must outweigh several low-severity ISINs.
  const oneHigh = dataHealth({ today: TODAY, unpricedTickers: ["VWRL"] });
  const manyLow = dataHealth({ today: TODAY, missingIsins: ["A", "B", "C", "D"] });
  assert.ok(oneHigh.score < manyLow.score, `${oneHigh.score} vs ${manyLow.score}`);
  assert.equal(oneHigh.issues[0].severity, "high");
  assert.equal(manyLow.issues[0].severity, "low");
});

test("issues sort high → medium → low regardless of push order", () => {
  const h = dataHealth({
    today: TODAY,
    missingIsins: ["X"],                       // low
    stalePriceTickers: ["A"],                  // medium
    unpricedTickers: ["B"],                    // high
  });
  assert.deepEqual(h.issues.map((i) => i.severity), ["high", "medium", "low"]);
  assert.equal(h.counts.high, 1);
  assert.equal(h.counts.medium, 1);
  assert.equal(h.counts.low, 1);
});

test("uncategorised spend only flags past a 5% threshold", () => {
  // 3% is noise
  assert.equal(dataHealth({ today: TODAY, uncategorisedSpend: 300, totalSpend: 10000 }).clean, true);
  // 12% is a real gap
  const h = dataHealth({ today: TODAY, uncategorisedSpend: 1200, totalSpend: 10000 });
  assert.equal(h.issues[0].id, "uncategorised-spend");
  assert.equal(h.issues[0].pct, 12);
});

test("stale imports flag per source, only past 45 days", () => {
  const h = dataHealth({ today: TODAY, staleImports: [{ source: "IBKR", days: 60 }, { source: "Fidelity", days: 10 }] });
  const ids = h.issues.map((i) => i.id);
  assert.ok(ids.includes("stale-import-IBKR"));
  assert.ok(!ids.includes("stale-import-Fidelity"));
});

test("unledgered vests report the share count and are high severity", () => {
  const h = dataHealth({ today: TODAY, unledgeredVests: [{ ticker: "WFC", shares: 200 }, { ticker: "WFC", shares: 127 }] });
  assert.equal(h.issues[0].severity, "high");
  assert.equal(h.issues[0].shares, 327);
  assert.match(h.issues[0].message, /327/);
});

test("score is floored at 0 and one noisy band can't sink everything", () => {
  // Many medium issues: capped, so the score can't be driven below the
  // cap by volume alone.
  const h = dataHealth({
    today: TODAY,
    stalePriceTickers: Array.from({ length: 40 }, (_, i) => `T${i}`),
    staleImports: [{ source: "A", days: 99 }, { source: "B", days: 99 }, { source: "C", days: 99 }],
  });
  assert.ok(h.score >= 100 - 30 - 0, `medium band capped: ${h.score}`);
  assert.ok(h.score < 100);
  // pile on every band and it floors at 0, never negative
  const wrecked = dataHealth({
    today: TODAY,
    unpricedTickers: Array.from({ length: 20 }, (_, i) => `U${i}`),
    unledgeredVests: Array.from({ length: 20 }, (_, i) => ({ ticker: `V${i}`, shares: 1 })),
    stalePriceTickers: Array.from({ length: 20 }, (_, i) => `S${i}`),
    missingIsins: Array.from({ length: 20 }, (_, i) => `I${i}`),
  });
  assert.ok(wrecked.score >= 0);
});

test("requires today", () => {
  assert.throws(() => dataHealth({}), /today/);
});
