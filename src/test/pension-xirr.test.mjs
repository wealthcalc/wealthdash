import { test } from "node:test";
import assert from "node:assert/strict";
import { pensionXirrByWrapper, xirr } from "../core/returns.mjs";

const TODAY = "2026-07-12";
// Two SIPP providers (funds tagged via secMeta.provider, ledger rows in
// SIPP) and one LISA provider.
const SECMETA = {
  LGF1: { provider: "L&G", kind: "fund" },
  AVF1: { provider: "Aviva", kind: "fund" },
  LIF1: { provider: "AJ Bell LISA", kind: "fund" },
};
const TXNS = [
  { ticker: "LGF1", wrapper: "SIPP", side: "BUY", date: "2024-01-01", quantity: 100, gbpAmount: 1 },
  { ticker: "AVF1", wrapper: "SIPP", side: "BUY", date: "2024-01-01", quantity: 100, gbpAmount: 1 },
  { ticker: "LIF1", wrapper: "LISA", side: "BUY", date: "2024-01-01", quantity: 100, gbpAmount: 1 },
];
const CASHFLOWS = [
  { provider: "L&G", date: "2022-07-12", gbpAmount: 10000 },
  { provider: "L&G", date: "2024-07-12", gbpAmount: 10000 },
  { provider: "Aviva", date: "2023-07-12", gbpAmount: 20000 },
  { provider: "AJ Bell LISA", date: "2024-07-12", gbpAmount: 4000 },
  { provider: "Aviva", date: "2024-01-01", gbpAmount: null }, // unresolved FX — excluded
];

test("combines ALL of a wrapper's providers into one xirr call", () => {
  const r = pensionXirrByWrapper({
    txns: TXNS, secMeta: SECMETA, pensionCashflows: CASHFLOWS,
    valueByWrapper: { SIPP: 52000, LISA: 5000 }, today: TODAY,
  });
  assert.equal(r.SIPP.providers, 2);
  assert.equal(r.SIPP.nCashflows, 3);
  assert.equal(r.SIPP.excludedFx, 1);
  // equals a hand-built combined flow set — not an average of two rates
  const expected = xirr([
    { date: "2022-07-12", amount: -10000 },
    { date: "2024-07-12", amount: -10000 },
    { date: "2023-07-12", amount: -20000 },
    { date: TODAY, amount: 52000 },
  ]);
  assert.equal(r.SIPP.rate, expected.rate);
  // LISA aggregates separately
  assert.equal(r.LISA.providers, 1);
  assert.ok(r.LISA.rate > 0);
});

test("the combined rate sits between the two providers' individual rates", () => {
  const one = (provider, value) => xirr([
    ...CASHFLOWS.filter((c) => c.provider === provider && c.gbpAmount != null).map((c) => ({ date: c.date, amount: -c.gbpAmount })),
    { date: TODAY, amount: value },
  ]).rate;
  // Give each provider its share of the £52k (L&G 24k, Aviva 28k) so the
  // per-provider rates straddle the combined one.
  const lg = one("L&G", 24000), av = one("Aviva", 28000);
  const combined = pensionXirrByWrapper({
    txns: TXNS, secMeta: SECMETA, pensionCashflows: CASHFLOWS,
    valueByWrapper: { SIPP: 52000 }, today: TODAY,
  }).SIPP.rate;
  assert.ok(combined > Math.min(lg, av) && combined < Math.max(lg, av),
    `combined ${combined} should sit between ${lg} and ${av}`);
});

test("wrappers with no tagged providers or no usable cashflows are absent", () => {
  assert.deepEqual(pensionXirrByWrapper({ txns: [], secMeta: {}, pensionCashflows: CASHFLOWS, valueByWrapper: {}, today: TODAY }), {});
  const noCfs = pensionXirrByWrapper({ txns: TXNS, secMeta: SECMETA, pensionCashflows: [], valueByWrapper: { SIPP: 1 }, today: TODAY });
  assert.equal(noCfs.SIPP, undefined);
  assert.throws(() => pensionXirrByWrapper({}), /today/);
});

test("total XIRR excludes snapshot-only (provider-tagged) tickers — the 23.5% bug", async () => {
  const { computeReturns } = await import("../core/returns.mjs");
  const txns = [
    // real ledger holding: bought 2 years ago, doubled
    { id: "a", ticker: "VWRL", wrapper: "GIA", side: "BUY", date: "2024-07-12", quantity: 100, gbpAmount: 10000 },
    // pension snapshot: £200k "bought" 10 days ago at roughly current value
    { id: "b", ticker: "LGF1", wrapper: "SIPP", side: "BUY", date: "2026-07-02", quantity: 1000, gbpAmount: 200000 },
  ];
  const prices = { VWRL: 200, LGF1: 201 };
  const secMeta = { LGF1: { provider: "L&G", kind: "fund" } };
  const withMeta = computeReturns({ txns, prices, secMeta, asOf: "2026-07-12" });
  const withoutMeta = computeReturns({ txns, prices, asOf: "2026-07-12" });
  // ~41.4%/yr for a clean doubling over 2 years
  assert.ok(Math.abs(withMeta.total.xirr.rate - (Math.sqrt(2) - 1)) < 0.001,
    `clean total ${withMeta.total.xirr.rate}`);
  assert.equal(withMeta.total.xirr.xirrScope.snapshotOnlyExcluded, 1);
  assert.equal(withMeta.total.xirr.xirrScope.excludedValue, 201000);
  // without secMeta the snapshot row poisons the total (the old behaviour)
  assert.ok(Math.abs(withoutMeta.total.xirr.rate - withMeta.total.xirr.rate) > 0.005,
    "snapshot row should distort the unscoped total — that distortion is what the fix removes");
  // per-wrapper and profit aggregates unchanged by the exclusion
  assert.equal(withMeta.total.moneyIn, 210000);
  assert.ok(withMeta.byWrapper.SIPP);
});
