import { test } from "node:test";
import assert from "node:assert/strict";
import {
  xirr, unitsHeldAt, holdingFlows, holdingTWR, twrFromValuations,
  holdingIncome, computeReturns,
} from "../core/returns.mjs";

const close = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const buy = (wrapper, date, ticker, quantity, gbpAmount) =>
  ({ id: wrapper + date + ticker, date, ticker, side: "BUY", quantity, gbpAmount, wrapper });
const sell = (wrapper, date, ticker, quantity, gbpAmount) =>
  ({ id: wrapper + date + ticker + "S", date, ticker, side: "SELL", quantity, gbpAmount, wrapper });

// Independent NPV check: any accepted rate must zero the NPV (365-day count).
const npvAt = (flows, r) => {
  const fs = flows.map((f) => ({ t: Date.parse(f.date + "T00:00:00Z"), amount: +f.amount })).sort((a, b) => a.t - b.t);
  const t0 = fs[0].t;
  return fs.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.t - t0) / (365 * 86400000)), 0);
};

/* -------------------------------- XIRR ------------------------------- */
test("xirr: exactly one 365-day year, money doubles -> 100%", () => {
  const flows = [{ date: "2024-01-01", amount: -1000 }, { date: "2024-12-31", amount: 2000 }]; // 365 days
  const { rate } = xirr(flows);
  assert.ok(close(rate, 1.0, 1e-9));
});

test("xirr: +10% over exactly one year", () => {
  const flows = [{ date: "2023-03-01", amount: -100 }, { date: "2024-02-29", amount: 110 }]; // 365 days
  const { rate } = xirr(flows);
  assert.ok(close(rate, 0.10, 1e-9));
});

test("xirr: sub-year annualises — +10% in half a year -> (1.1)^2 - 1", () => {
  // 2024-01-01 + 182.5d isn't a date; use 73 days: (1.02)^(365/73)-1 = 1.02^5-1
  const flows = [{ date: "2024-01-01", amount: -100 }, { date: "2024-03-14", amount: 102 }]; // 73 days
  const { rate } = xirr(flows);
  assert.ok(close(rate, Math.pow(1.02, 5) - 1, 1e-9));
});

test("xirr: negative return, -50% over one year", () => {
  const flows = [{ date: "2024-01-01", amount: -100 }, { date: "2024-12-31", amount: 50 }];
  const { rate } = xirr(flows);
  assert.ok(close(rate, -0.5, 1e-9));
});

test("xirr: multi-flow solution zeroes the NPV (independent check)", () => {
  const flows = [
    { date: "2022-01-01", amount: -10000 },
    { date: "2022-06-15", amount: -5000 },
    { date: "2023-02-01", amount: 2750 },
    { date: "2023-09-20", amount: 4250 },
    { date: "2024-04-01", amount: 12000 },
  ];
  const { rate, converged } = xirr(flows);
  assert.ok(converged);
  assert.ok(Math.abs(npvAt(flows, rate)) < 1e-4); // pennies on £34k of flows
});

test("xirr: deep-loss case falls back cleanly and still zeroes NPV", () => {
  const flows = [{ date: "2024-01-01", amount: -10000 }, { date: "2024-12-31", amount: 100 }]; // 365 days
  const { rate } = xirr(flows); // about -99% — hostile for Newton from 0.1
  assert.ok(rate != null);
  assert.ok(Math.abs(npvAt(flows, rate)) < 1e-4);
  assert.ok(close(rate, 100 / 10000 - 1, 1e-6)); // one 365d year: r = 0.01 - 1
});

test("xirr: rejects one-sided or degenerate inputs with reasons", () => {
  assert.equal(xirr([{ date: "2024-01-01", amount: -100 }]).rate, null);
  assert.equal(xirr([{ date: "2024-01-01", amount: -100 }, { date: "2024-06-01", amount: -50 }]).rate, null);
  assert.equal(xirr([{ date: "2024-01-01", amount: -100 }, { date: "2024-01-01", amount: 110 }]).rate, null);
  assert.equal(xirr([]).rate, null);
});

/* --------------------------- units & flows --------------------------- */
test("unitsHeldAt tracks buys minus sells to date", () => {
  const rows = [buy("GIA", "2024-01-01", "X", 100, 1000), sell("GIA", "2024-06-01", "X", 40, 600)];
  assert.equal(unitsHeldAt(rows, "2024-01-01"), 100);
  assert.equal(unitsHeldAt(rows, "2024-05-31"), 100);
  assert.equal(unitsHeldAt(rows, "2024-06-01"), 60);
});

test("holdingFlows: investor-pocket signs, terminal value appended", () => {
  const rows = [buy("GIA", "2024-01-01", "X", 100, 1000), sell("GIA", "2024-06-01", "X", 40, 600)];
  const flows = holdingFlows({ rows, incomeEvents: [{ date: "2024-03-01", amount: 20 }], marketValue: 900, asOf: "2024-12-31" });
  assert.deepEqual(flows.map((f) => f.amount), [-1000, 600, 20, 900]);
  assert.equal(flows[3].terminal, true);
});

/* ---------------------- per-holding time-weighted -------------------- */
test("holdingTWR: pure price move, single buy", () => {
  const rows = [buy("GIA", "2024-01-01", "X", 100, 1000)]; // unit 10
  const { twr, spanDays } = holdingTWR({ rows, currentPrice: 12, asOf: "2024-12-31" });
  assert.ok(close(twr, 0.2)); // 10 -> 12
  assert.equal(spanDays, 365);
});

test("holdingTWR: ignores cashflow timing (that's the point of TWR)", () => {
  // Price path 10 -> 20 -> 10. An investor who buys big at the top has an
  // ugly XIRR but TWR must be 0% either way.
  const small = [buy("GIA", "2024-01-01", "X", 10, 100)];
  const topup = [buy("GIA", "2024-01-01", "X", 10, 100), buy("GIA", "2024-06-01", "X", 100, 2000)];
  const a = holdingTWR({ rows: small, currentPrice: 10, asOf: "2024-12-31" });
  const b = holdingTWR({ rows: topup, currentPrice: 10, asOf: "2024-12-31" });
  assert.ok(close(a.twr, 0, 1e-9));
  assert.ok(close(b.twr, 0, 1e-9)); // (20/10) * (10/20) = 1 despite the top-up
});

test("holdingTWR: distribution counts as reinvested on payment date", () => {
  // Buy at 10; price still 10 at asOf; £1/unit paid mid-way -> +10% TWR.
  const rows = [buy("GIA", "2024-01-01", "X", 100, 1000)];
  const { twr } = holdingTWR({ rows, incomeEvents: [{ date: "2024-06-01", amount: 100 }], currentPrice: 10, asOf: "2024-12-31" });
  assert.ok(close(twr, 0.1, 1e-9));
});

test("holdingTWR: episode restarts after a full close", () => {
  // Episode 1: 10 -> 20 (sold out, +100%). Episode 2: 40 -> current 44 (+10%).
  // TWR must report the CURRENT episode only: +10%.
  const rows = [
    buy("GIA", "2023-01-01", "X", 100, 1000),
    sell("GIA", "2023-06-01", "X", 100, 2000),
    buy("GIA", "2024-01-01", "X", 50, 2000), // unit 40
  ];
  const { twr, episodeStart } = holdingTWR({ rows, currentPrice: 44, asOf: "2024-12-31" });
  assert.equal(episodeStart, "2024-01-01");
  assert.ok(close(twr, 0.1, 1e-9));
});

test("holdingTWR: open + unpriced is honestly null", () => {
  const rows = [buy("GIA", "2024-01-01", "X", 100, 1000)];
  const r = holdingTWR({ rows, currentPrice: null, asOf: "2024-12-31" });
  assert.equal(r.twr, null);
  assert.match(r.reason, /no current price/);
});

test("holdingTWR: closed position uses its final sale as the endpoint", () => {
  const rows = [buy("GIA", "2024-01-01", "X", 100, 1000), sell("GIA", "2024-07-01", "X", 100, 1500)];
  const { twr, open } = holdingTWR({ rows, asOf: "2024-12-31" });
  assert.equal(open, false);
  assert.ok(close(twr, 0.5, 1e-9));
});

/* --------------------- portfolio TWR from snapshots ------------------ */
test("twrFromValuations: flows at period end, chained factors", () => {
  // V=1000; snapshot on the +500 flow date shows 1600: (1600-500)/1000 = 1.1
  // then 1760/1600 = 1.1 -> 21% total.
  const r = twrFromValuations({
    snapshots: [
      { date: "2024-01-01", value: 1000 },
      { date: "2024-05-01", value: 1600 },
      { date: "2024-09-01", value: 1760 },
    ],
    flows: [{ date: "2024-05-01", amount: 500 }],
  });
  assert.ok(close(r.twr, 0.21, 1e-9));
  assert.equal(r.periods.length, 2);
});

test("twrFromValuations: withdrawal (negative flow) handled symmetrically", () => {
  // V 1000 -> withdraw 200 -> snapshot 900: (900 - (-200))/1000 = 1.1
  const r = twrFromValuations({
    snapshots: [{ date: "2024-01-01", value: 1000 }, { date: "2024-06-01", value: 900 }],
    flows: [{ date: "2024-06-01", amount: -200 }],
  });
  assert.ok(close(r.twr, 0.1, 1e-9));
});

test("twrFromValuations: needs two snapshots, dedupes by date (last wins)", () => {
  assert.equal(twrFromValuations({ snapshots: [{ date: "2024-01-01", value: 1000 }] }).twr, null);
  const r = twrFromValuations({
    snapshots: [
      { date: "2024-01-01", value: 999 },
      { date: "2024-01-01", value: 1000 }, // same-day re-record wins
      { date: "2024-12-31", value: 1100 },
    ],
  });
  assert.ok(close(r.twr, 0.1, 1e-9));
});

/* ---------------------------- income yields -------------------------- */
test("holdingIncome: trailing vs forward when the position doubled mid-year", () => {
  // 100 units at the May payment (£50 -> £0.50/unit), then buy 100 more.
  // Trailing cash = £50; forward applies £0.50/unit to 200 units = £100.
  const rows = [buy("GIA", "2024-01-01", "X", 100, 1000), buy("GIA", "2024-08-01", "X", 100, 1200)];
  const inc = holdingIncome({
    rows,
    incomeEvents: [{ date: "2024-05-01", amount: 50 }],
    qty: 200, marketValue: 2400, asOf: "2024-12-31",
  });
  assert.ok(close(inc.trailing12m, 50));
  assert.ok(close(inc.actualYield, 50 / 2400));
  assert.ok(close(inc.forwardIncome, 100));
  assert.ok(close(inc.forwardYield, 100 / 2400));
  assert.equal(inc.skippedPayments, 0);
});

test("holdingIncome: payments outside the trailing window are excluded", () => {
  const rows = [buy("GIA", "2022-01-01", "X", 100, 1000)];
  const inc = holdingIncome({
    rows,
    incomeEvents: [{ date: "2023-05-01", amount: 40 }, { date: "2024-11-01", amount: 60 }],
    qty: 100, marketValue: 2000, asOf: "2024-12-31",
  });
  assert.ok(close(inc.trailing12m, 60));
  assert.ok(close(inc.forwardIncome, 60)); // 0.6/unit x 100
});

/* --------------------------- the orchestrator ------------------------ */
test("computeReturns: end-to-end with open, closed and multi-wrapper holdings", () => {
  const txns = [
    buy("GIA", "2024-01-01", "AAA", 100, 1000),   // open, priced at 15 -> value 1500
    buy("ISA", "2024-01-01", "AAA", 50, 500),      // open, same price -> 750
    buy("GIA", "2023-01-01", "BBB", 10, 500),      // closed at a gain
    sell("GIA", "2023-12-31", "BBB", 10, 600),
  ];
  const incomeEntries = [
    { id: "i1", date: "2024-06-01", ticker: "AAA", kind: "dividend", amount: 30, wrapper: "GIA" },
  ];
  const r = computeReturns({ txns, incomeEntries, prices: { AAA: 15 }, asOf: "2024-12-31" });

  assert.equal(r.perHolding.length, 3);
  const giaAAA = r.perHolding.find((h) => h.wrapper === "GIA" && h.ticker === "AAA");
  const bbb = r.perHolding.find((h) => h.ticker === "BBB");
  assert.equal(giaAAA.open, true);
  assert.ok(close(giaAAA.profit, 1500 + 30 - 1000)); // 530
  assert.ok(giaAAA.xirr.rate > 0);
  assert.equal(bbb.open, false);
  assert.ok(close(bbb.profit, 100));
  // closed-position XIRR: 500 -> 600 over 364 days, slightly above 20%
  assert.ok(bbb.xirr.rate > 0.19 && bbb.xirr.rate < 0.22);

  // wrapper roll-up: GIA includes the closed BBB flows
  assert.ok(close(r.byWrapper.GIA.moneyIn, 1500));
  assert.ok(close(r.byWrapper.GIA.value, 1500));
  assert.ok(close(r.byWrapper.GIA.profit, 600 + 30 + 1500 - 1500)); // 630
  assert.ok(r.byWrapper.GIA.xirr.rate != null);
  assert.ok(close(r.byWrapper.ISA.profit, 250));

  // total
  assert.ok(close(r.total.profit, 630 + 250));
  assert.ok(r.total.xirr.rate != null);
  // yields: trailing GIA AAA £30 on £1500; ISA AAA none
  assert.ok(close(r.total.trailing12m, 30));
  assert.ok(close(r.total.actualYield, 30 / 2250));
});

test("computeReturns: unpriced open holding nulls the roll-up XIRR with a reason", () => {
  const txns = [buy("GIA", "2024-01-01", "AAA", 100, 1000)];
  const r = computeReturns({ txns, prices: {}, asOf: "2024-12-31" });
  assert.equal(r.perHolding[0].xirr.rate, null);
  assert.equal(r.byWrapper.GIA.xirr.rate, null);
  assert.match(r.byWrapper.GIA.xirr.reason, /without a price/);
  assert.equal(r.total.xirr.rate, null);
  assert.equal(r.total.profit, null); // not silently zero
});

test("computeReturns: ERI boosts yield but is not an XIRR cashflow", () => {
  const txns = [buy("GIA", "2024-01-01", "FND", 100, 1000)];
  const eriTxns = [{ id: "e1", ticker: "FND", side: "ERI", date: "2024-07-01", wrapper: "GIA", _eri: { treatment: "dividend" }, _gbp: 20 }];
  const withEri = computeReturns({ txns, eriTxns, prices: { FND: 10 }, asOf: "2024-12-31" });
  const without = computeReturns({ txns, prices: { FND: 10 }, asOf: "2024-12-31" });
  const h1 = withEri.perHolding[0], h0 = without.perHolding[0];
  assert.ok(close(h1.income.trailing12m, 20));          // yield sees ERI
  assert.ok(close(h0.income.trailing12m, 0));
  assert.ok(close(h1.xirr.rate, h0.xirr.rate, 1e-12));  // XIRR does not
  // TWR treats ERI as an accrued distribution: (10 + 0.2)/10 = +2%
  assert.ok(close(h1.twr.twr, 0.02, 1e-9));
});

test("computeReturns: portfolio TWR comes from snapshots and flags when absent", () => {
  const txns = [buy("GIA", "2024-01-01", "AAA", 100, 1000)];
  const none = computeReturns({ txns, prices: { AAA: 12 }, asOf: "2024-12-31" });
  assert.equal(none.portfolioTWR.twr, null);
  const withSnaps = computeReturns({
    txns, prices: { AAA: 12 }, asOf: "2024-12-31",
    valuations: [
      { date: "2024-01-01", value: 1000 }, // snapshot on the buy date, post-buy
      { date: "2024-12-31", value: 1200 },
    ],
  });
  // flow +1000 on 2024-01-01 is NOT in (2024-01-01, 2024-12-31] window start?
  // it falls ON the first snapshot date -> excluded (period is (a, b]), so
  // factor = 1200/1000 = 1.2.
  assert.ok(close(withSnaps.portfolioTWR.twr, 0.2, 1e-9));
});
