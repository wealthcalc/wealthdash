import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isaSubscriptionsByYear, taperedAA, pensionContributionsByYear,
  pensionAllowanceStatus, realisedForYear, bedAndIsaPlan,
} from "../core/allowances.mjs";

/* ------------------------- ISA subscriptions -------------------------- */

test("ISA subscriptions: BUYs in ISA/LISA count, sells and GIA don't", () => {
  const by = isaSubscriptionsByYear([
    { side: "BUY", wrapper: "ISA", date: "2026-05-01", gbpAmount: 5000 },
    { side: "BUY", wrapper: "LISA", date: "2026-06-01", gbpAmount: 2000 },
    { side: "SELL", wrapper: "ISA", date: "2026-07-01", gbpAmount: 1000 },
    { side: "BUY", wrapper: "GIA", date: "2026-05-01", gbpAmount: 9999 },
    { side: "BUY", wrapper: "ISA", date: "2026-03-01", gbpAmount: 700 }, // prior tax year
  ]);
  assert.equal(by["2026/27"].ISA, 5000);
  assert.equal(by["2026/27"].LISA, 2000);
  assert.equal(by["2026/27"].total, 7000);
  assert.equal(by["2025/26"].ISA, 700); // 1 Mar 2026 is still 2025/26
});

/* --------------------------- pension AA ------------------------------- */

test("taperedAA: £60k standard, £1 per £2 over £260k, £10k floor (2023/24+)", () => {
  assert.equal(taperedAA("2026/27", 200000), 60000);
  assert.equal(taperedAA("2026/27", 260000), 60000);
  assert.equal(taperedAA("2026/27", 300000), 40000); // 60k - 40k/2
  assert.equal(taperedAA("2026/27", 500000), 10000); // floored
  assert.equal(taperedAA("2022/23", 300000), 10000); // 40k - 60k/2 -> above £4k floor
  assert.equal(taperedAA("2022/23", 200000), 40000); // pre-2023 base
});

test("pensionAllowanceStatus: carry-forward from three prior years", () => {
  const cashflows = [
    { date: "2026-06-01", gbpAmount: 20000 }, // 2026/27
    { date: "2025-06-01", gbpAmount: 50000 }, // 2025/26 -> 10k unused
    { date: "2024-06-01", gbpAmount: 60000 }, // 2024/25 -> 0 unused
    // 2023/24: nothing -> 60k unused
  ];
  const s = pensionAllowanceStatus({ cashflows, year: "2026/27", adjustedIncome: 100000 });
  assert.equal(s.aa, 60000);
  assert.equal(s.used, 20000);
  assert.equal(s.headroom, 40000);
  assert.deepEqual(s.carry.map((c) => c.unused), [60000, 0, 10000]); // 23/24, 24/25, 25/26
  assert.equal(s.carryTotal, 70000);
  assert.equal(s.totalAvailable, 110000);
  assert.equal(s.overBy, 0);
});

test("pensionAllowanceStatus: overshoot beyond AA + carry-forward is flagged", () => {
  const s = pensionAllowanceStatus({
    cashflows: [
      { date: "2026-06-01", gbpAmount: 200000 },
      { date: "2025-06-01", gbpAmount: 60000 },
      { date: "2024-06-01", gbpAmount: 60000 },
      { date: "2023-06-01", gbpAmount: 60000 },
    ],
    year: "2026/27", adjustedIncome: 100000,
  });
  assert.equal(s.carryTotal, 0);
  assert.equal(s.overBy, 140000);
});

test("pension contributions ignore non-positive and undated rows", () => {
  const by = pensionContributionsByYear([
    { date: "2026-06-01", gbpAmount: 1000 },
    { date: "2026-06-02", gbpAmount: null }, // needs FX -> excluded
    { gbpAmount: 500 },
  ]);
  assert.deepEqual(by, { "2026/27": 1000 });
});

/* --------------------------- CGT headroom ----------------------------- */

test("realisedForYear nets gains and losses; AEA floor at zero", () => {
  const disposals = [
    { taxYear: "2026/27", gain: 2000 },
    { taxYear: "2026/27", gain: -500 },
    { taxYear: "2025/26", gain: 9999 },
  ];
  const r = realisedForYear(disposals, "2026/27", 3000);
  assert.equal(r.net, 1500);
  assert.equal(r.aeaLeft, 1500);
  const over = realisedForYear([{ taxYear: "2026/27", gain: 5000 }], "2026/27", 3000);
  assert.equal(over.aeaLeft, 0);
});

/* ----------------------------- Bed & ISA ------------------------------ */
// Two pools: A gps £5 on £15 price (33% gain), B gps £2 on £20 (10% gain).
const POOLS = { A: { qty: 100, cost: 1000 }, B: { qty: 100, cost: 1800 } };
const PRICES = { A: 15, B: 20 };

test("mode 'value' shelters the most value: low-gain holding first", () => {
  const p = bedAndIsaPlan({ pools: POOLS, prices: PRICES, aeaLeft: 400, isaLeft: 3000, mode: "value", spreadPct: 0, stampPct: 0 });
  assert.deepEqual(p.rows.map((r) => r.ticker), ["B", "A"]);
  assert.equal(p.rows[0].value, 2000); // all 100 B (gain 200)
  assert.equal(p.rows[1].shares, 40);  // A capped by remaining £200 AEA / £5 gps
  assert.equal(p.totalValue, 2600);
  assert.equal(p.totalGain, 400);
  assert.equal(p.aeaLeftAfter, 0);
});

test("mode 'gain' washes the most gain: high-gain holding first", () => {
  const p = bedAndIsaPlan({ pools: POOLS, prices: PRICES, aeaLeft: 400, isaLeft: 3000, mode: "gain", spreadPct: 0, stampPct: 0 });
  assert.equal(p.rows[0].ticker, "A");
  assert.equal(p.rows[0].shares, 80); // 400 AEA / £5 gps
  assert.equal(p.totalGain, 400);
  assert.equal(p.totalValue, 1200);   // less value moved than 'value' mode — by design
});

test("ISA allowance caps the transfer even with AEA to spare", () => {
  const p = bedAndIsaPlan({ pools: POOLS, prices: PRICES, aeaLeft: 1e9, isaLeft: 300, mode: "value", spreadPct: 0, stampPct: 0 });
  assert.equal(p.totalValue, 300);
  assert.equal(p.rows[0].shares, 15); // 300 / £20 of B
});

test("loss-making, unpriced, and empty pools are excluded", () => {
  const p = bedAndIsaPlan({
    pools: { L: { qty: 100, cost: 3000 }, U: { qty: 50, cost: 100 }, Z: { qty: 0, cost: 0 }, A: { qty: 100, cost: 1000 } },
    prices: { L: 10, A: 15 }, aeaLeft: 1000, isaLeft: 100000,
  });
  assert.deepEqual(p.rows.map((r) => r.ticker), ["A"]);
});

test("stamp duty only on shares/investment trusts; spread on everything", () => {
  const secMeta = { IT: { kind: "investment_trust" }, ETF: { eri: true } }; // eri -> fund
  const p = bedAndIsaPlan({
    pools: { IT: { qty: 10, cost: 0 }, ETF: { qty: 10, cost: 0 } },
    prices: { IT: 100, ETF: 100 }, secMeta,
    aeaLeft: 1e9, isaLeft: 1e9, spreadPct: 0.001, stampPct: 0.005,
  });
  const it = p.rows.find((r) => r.ticker === "IT"), etf = p.rows.find((r) => r.ticker === "ETF");
  assert.equal(it.stamp, 5);    // 0.5% of £1,000
  assert.equal(etf.stamp, 0);   // funds exempt
  assert.equal(it.spread, 1);
  assert.equal(etf.spread, 1);
});

test("whole-position moves are marked (contract-note convenience)", () => {
  const p = bedAndIsaPlan({ pools: { A: { qty: 100, cost: 1000 } }, prices: { A: 15 }, aeaLeft: 1e9, isaLeft: 1e9 });
  assert.equal(p.rows[0].wholePosition, true);
});
