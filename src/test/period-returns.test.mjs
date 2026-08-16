import { test } from "node:test";
import assert from "node:assert/strict";
import { returnsByPeriod } from "../core/period-returns.mjs";
import { riskMetrics, portfolioBeta } from "../core/risk-metrics.mjs";

const P = (from, to, factor) => ({ from, to, factor });

test("yearly returns COMPOUND back to the overall return", () => {
  // A per-year view that disagrees with the headline is worse than none.
  const periods = [
    P("2024-01-01", "2024-06-30", 1.05),
    P("2024-06-30", "2024-12-31", 1.05),
    P("2024-12-31", "2025-06-30", 0.90),
    P("2025-06-30", "2025-12-31", 1.20),
  ];
  const { rows, summary } = returnsByPeriod({ periods, by: "year" });
  assert.deepEqual(rows.map((r) => r.key), ["2024", "2025"]);
  assert.ok(Math.abs(rows[0].return - 0.1025) < 1e-4, "1.05 × 1.05 − 1");
  assert.ok(Math.abs(rows[1].return - 0.08) < 1e-4, "0.90 × 1.20 − 1");

  const overall = periods.reduce((f, p) => f * p.factor, 1) - 1;
  assert.ok(Math.abs(summary.compounded - overall) < 1e-6, "the parts must rebuild the whole");
});

test("a bad year is visible instead of being averaged away", () => {
  const { rows, summary } = returnsByPeriod({
    periods: [P("2023-01-01", "2023-12-31", 1.2), P("2023-12-31", "2024-12-31", 0.75), P("2024-12-31", "2025-12-31", 1.3)],
    by: "year",
  });
  assert.equal(rows.length, 3);
  assert.equal(summary.worst.key, "2024");
  assert.ok(summary.worst.return < 0);
  assert.equal(summary.best.key, "2025");
  assert.equal(summary.positive, 2);
  assert.equal(summary.negative, 1);
});

test("the current period is flagged partial, not annualised into nonsense", () => {
  const { rows, summary } = returnsByPeriod({
    periods: [P("2025-01-01", "2025-12-31", 1.1), P("2025-12-31", "2026-01-20", 1.01)],
    by: "year", today: "2026-01-20",
  });
  const cur = rows.find((r) => r.key === "2026");
  assert.equal(cur.partial, true, "three weeks isn't a year's return");
  assert.equal(rows.find((r) => r.key === "2025").partial, false);
  // A part-year must not be eligible as best/worst against full years.
  assert.equal(summary.completeCount, 1);
  assert.equal(summary.best.key, "2025");
});

test("monthly grouping works, and £ moves come from the value series", () => {
  const { rows } = returnsByPeriod({
    periods: [P("2026-01-01", "2026-01-31", 1.02), P("2026-01-31", "2026-02-28", 0.99)],
    values: [
      { date: "2026-01-01", value: 100000 },
      { date: "2026-01-31", value: 102000 },
      { date: "2026-02-28", value: 101000 },
    ],
    by: "month",
  });
  assert.deepEqual(rows.map((r) => r.key), ["2026-01", "2026-02"]);
  assert.equal(rows[0].valueChange, 2000);
  assert.equal(rows[1].valueChange, -1000);
});

test("invalid periods are skipped rather than poisoning a year", () => {
  const { rows } = returnsByPeriod({
    periods: [P("2025-01-01", "2025-06-30", 1.1), P("2025-06-30", "2025-12-31", 0), P("2025-12-31", "2026-06-30", NaN)],
    by: "year",
  });
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].return - 0.1) < 1e-9);
});

test("empty input is safe", () => {
  const { rows, summary } = returnsByPeriod({});
  assert.deepEqual(rows, []);
  assert.equal(summary.best, null);
  assert.equal(summary.compounded, 0);
});

/* ----------------------------- risk metrics --------------------------- */

// 24 monthly periods with a mild upward drift and real variation.
const monthly = Array.from({ length: 24 }, (_, i) => {
  const from = new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(2024, i + 1, 1)).toISOString().slice(0, 10);
  const wobble = [0.03, -0.02, 0.01, 0.04, -0.03, 0.02][i % 6];
  return P(from, to, 1 + wobble);
});

test("Sharpe and Sortino are computed, annualised, and respect the risk-free rate", () => {
  const zero = riskMetrics({ periods: monthly, riskFreeRate: 0 });
  assert.ok(zero.sharpe != null && Number.isFinite(zero.sharpe));
  assert.ok(zero.sortino != null);
  assert.ok(Math.abs(zero.periodsPerYear - 12) < 0.5, "monthly spacing detected, not assumed");

  // A higher hurdle must reduce the Sharpe ratio — it's excess return.
  const hurdle = riskMetrics({ periods: monthly, riskFreeRate: 0.045 });
  assert.ok(hurdle.sharpe < zero.sharpe, "a risk-free rate raises the bar");
  assert.equal(zero.riskFreeAssumed?.includes("0%"), true, "a 0% assumption is disclosed, not hidden");
});

test("Sortino exceeds Sharpe when the volatility is mostly upside", () => {
  // Many small gains, few small losses: total volatility overstates the risk.
  const skewed = Array.from({ length: 24 }, (_, i) => {
    const from = new Date(Date.UTC(2024, i, 1)).toISOString().slice(0, 10);
    const to = new Date(Date.UTC(2024, i + 1, 1)).toISOString().slice(0, 10);
    return P(from, to, i % 6 === 0 ? 0.99 : 1.03);
  });
  const m = riskMetrics({ periods: skewed, riskFreeRate: 0 });
  assert.ok(m.sortino > m.sharpe, "punishing upside swings understates this portfolio");
});

test("too little data refuses to produce a number", () => {
  const few = monthly.slice(0, 4);
  const m = riskMetrics({ periods: few });
  assert.equal(m.sharpe, null);
  assert.match(m.reason, /at least/);
});

test("a portfolio that never fell has UNDEFINED downside risk, not infinite", () => {
  const onlyUp = Array.from({ length: 12 }, (_, i) => P(`2025-${String(i + 1).padStart(2, "0")}-01`, `2025-${String(i + 2).padStart(2, "0")}-01`, 1.02));
  const m = riskMetrics({ periods: onlyUp, riskFreeRate: 0 });
  assert.equal(m.sortino, null);
  assert.match(m.sortinoReason, /undefined, not zero/);
});

test("beta measures co-movement, and reports how well it actually fits", () => {
  // Portfolio moves exactly twice the benchmark: beta 2, perfect fit.
  const bench = [1.01, 0.99, 1.02, 0.98, 1.03, 0.97, 1.01, 1.02, 0.99, 1.01];
  const twice = bench.map((b) => Math.exp(Math.log(b) * 2));
  const r = portfolioBeta({ portfolioFactors: twice, benchmarkFactors: bench });
  assert.ok(Math.abs(r.beta - 2) < 1e-6);
  assert.ok(r.rSquared > 0.99);
  assert.equal(r.reliable, true);

  // Unrelated movement: beta is reported but flagged as a weak description.
  const noise = [1.05, 1.04, 0.94, 1.06, 0.95, 1.05, 0.96, 1.04, 0.95, 1.06];
  const weak = portfolioBeta({ portfolioFactors: noise, benchmarkFactors: bench });
  assert.ok(weak.rSquared < 0.5);
  assert.equal(weak.reliable, false);
  assert.match(weak.note, /loosely/);
});

test("beta guards its inputs", () => {
  assert.equal(portfolioBeta({ portfolioFactors: [1.1], benchmarkFactors: [1.1] }).beta, null);
  const flat = portfolioBeta({
    portfolioFactors: Array(10).fill(1.01),
    benchmarkFactors: Array(10).fill(1),
  });
  assert.equal(flat.beta, null);
  assert.match(flat.reason, /didn't move/);
});
