import { test } from "node:test";
import assert from "node:assert/strict";
import { vctHoldings } from "../core/vct.mjs";

const TODAY = "2026-07-24";

test("each VCT subscription gets its own 5-year clock and relief-at-risk", () => {
  const txns = [
    { ticker: "GHV1", side: "BUY", wrapper: "VCT", date: "2023-02-15", quantity: 1000, gbpAmount: 5000 },
    { ticker: "GHV1", side: "BUY", wrapper: "VCT", date: "2020-02-15", quantity: 1000, gbpAmount: 4000 }, // >5yr ago
  ];
  const { lots, summary } = vctHoldings({ txns, today: TODAY });
  assert.equal(lots.length, 2);
  // sorted by clawback date: the 2020 sub cleared, the 2023 one is locked
  const cleared = lots.find((l) => l.subscribedDate === "2020-02-15");
  const locked = lots.find((l) => l.subscribedDate === "2023-02-15");
  assert.equal(cleared.cleared, true);
  assert.equal(cleared.reliefAtRisk, 0);
  assert.equal(locked.cleared, false);
  assert.equal(locked.clawbackDate, "2028-02-15");
  assert.equal(locked.reliefAtRisk, 1500); // 30% of £5000
  assert.equal(summary.reliefAtRisk, 1500);
  assert.equal(summary.lockedCount, 1);
});

test("a partial sale (FIFO) reduces the surviving lot's cost and relief", () => {
  const txns = [
    { ticker: "MIG1", side: "BUY", wrapper: "VCT", date: "2024-01-10", quantity: 1000, gbpAmount: 10000 },
    { ticker: "MIG1", side: "SELL", wrapper: "VCT", date: "2025-06-01", quantity: 400, gbpAmount: 4200 },
  ];
  const { lots } = vctHoldings({ txns, today: TODAY });
  assert.equal(lots.length, 1);
  assert.equal(lots[0].qtyRemaining, 600);
  assert.equal(lots[0].costRemaining, 6000);       // 60% of £10k
  assert.equal(lots[0].reliefAtRisk, 1800);        // 30% of £6000
});

test("a fully-sold lot drops out", () => {
  const txns = [
    { ticker: "X", side: "BUY", wrapper: "VCT", date: "2024-01-10", quantity: 500, gbpAmount: 5000 },
    { ticker: "X", side: "SELL", wrapper: "VCT", date: "2025-01-10", quantity: 500, gbpAmount: 5200 },
  ];
  assert.equal(vctHoldings({ txns, today: TODAY }).lots.length, 0);
});

test("summary flags what clears within a year and the soonest to clear", () => {
  const txns = [
    { ticker: "A", side: "BUY", wrapper: "VCT", date: "2021-12-01", quantity: 100, gbpAmount: 1000 }, // clears 2026-12-01, within a year
    { ticker: "B", side: "BUY", wrapper: "VCT", date: "2024-06-01", quantity: 100, gbpAmount: 2000 }, // clears 2029-06-01
  ];
  const { summary } = vctHoldings({ txns, today: TODAY });
  assert.equal(summary.clearingWithinYear, 1);
  assert.equal(summary.nextClears.ticker, "A");
  assert.equal(summary.nextClears.clawbackDate, "2026-12-01");
});

test("non-VCT holdings are ignored; secMeta can also mark a VCT", () => {
  const txns = [
    { ticker: "VWRL", side: "BUY", wrapper: "ISA", date: "2024-01-10", quantity: 100, gbpAmount: 9000 },
    { ticker: "FOO", side: "BUY", wrapper: "GIA", date: "2024-01-10", quantity: 100, gbpAmount: 1000 },
  ];
  assert.equal(vctHoldings({ txns, today: TODAY }).lots.length, 0);
  const withMeta = vctHoldings({ txns, secMeta: { FOO: { kind: "vct" } }, today: TODAY });
  assert.equal(withMeta.lots.length, 1);
  assert.equal(withMeta.lots[0].ticker, "FOO");
});

test("requires today", () => {
  assert.throws(() => vctHoldings({ txns: [] }), /today/);
});
