import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFxConversion, partitionFxConversions, nearDuplicateGroups, crossCheckPositions,
} from "../core/import-hygiene.mjs";
import { reconcilePositions, mergeBrokerCoverage } from "../core/position-reconcile.mjs";

const trade = (date, ticker, side, quantity, gbpAmount) => ({ date, ticker, side, quantity, gbpAmount, wrapper: "GIA" });

/* ------------------------------ FX rows ------------------------------- */

test("currency conversions are not positions", () => {
  assert.equal(isFxConversion("GBP.USD"), true);
  assert.equal(isFxConversion("EUR.GBP"), true);
  // Real tickers that contain a dot must survive — this is why the pattern
  // is strict rather than "contains a dot".
  assert.equal(isFxConversion("AV."), false);
  assert.equal(isFxConversion("VOD.L"), false);
  assert.equal(isFxConversion("BRK.B"), false);
  assert.equal(isFxConversion(""), false);
  assert.equal(isFxConversion(null), false);
});

test("FX rows are set aside and counted, not silently dropped", () => {
  const { trades, fxConversions } = partitionFxConversions([
    trade("2026-07-14", "GBP.USD", "SELL", 4815.71, 4821.85),
    trade("2026-07-14", "MNTNL", "BUY", 3150, 4825.32),
    trade("2026-03-13", "GBP.USD", "BUY", 0.0529, 0.05),
    trade("2026-06-30", "AV.", "BUY", 700, 3541.82),
  ]);
  assert.deepEqual(trades.map((t) => t.ticker), ["MNTNL", "AV."], "AV. is a real holding, not a currency pair");
  assert.equal(fxConversions.length, 2);
});

/* -------------------------- near-duplicates --------------------------- */

test("one trade reported three times with slightly different money is grouped", () => {
  // The real case: same date, ticker, side and quantity; amounts £8 apart
  // because each Flex section nets commission and accrued differently. An
  // exact-match key sails straight past this.
  const groups = nearDuplicateGroups([
    trade("2026-09-02", "TG36", "BUY", 10000, 13355.50),
    trade("2026-09-02", "TG36", "BUY", 10000, 13347.00),
    trade("2026-09-02", "TG36", "BUY", 10000, 13349.83),
    trade("2026-06-30", "AIAG", "BUY", 118, 3541.82),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].ticker, "TG36");
  assert.equal(groups[0].count, 3);
  assert.ok(groups[0].spreadPct < 0.1, "0.06% apart");
  assert.equal(groups[0].identical, false);
  assert.deepEqual(groups[0].rows.map((r) => r.index), [0, 1, 2], "row positions, so the UI can point at them");
});

test("genuinely different fills are left alone", () => {
  // Same day, same stock, materially different money: two real trades.
  const groups = nearDuplicateGroups([
    trade("2026-06-30", "DFEU", "BUY", 550, 2378.78),
    trade("2026-06-30", "DFEU", "BUY", 600, 2591.76),
  ]);
  assert.deepEqual(groups, [], "different quantities are different trades");

  const priced = nearDuplicateGroups([
    trade("2026-06-30", "X", "BUY", 100, 1000),
    trade("2026-06-30", "X", "BUY", 100, 1200),
  ]);
  assert.deepEqual(priced, [], "20% apart is a price move, not a duplicate");
});

test("penny-identical repeats are called out as the strongest signal", () => {
  const [g] = nearDuplicateGroups([
    trade("2026-09-02", "TG36", "BUY", 10000, 13350),
    trade("2026-09-02", "TG36", "BUY", 10000, 13350),
  ]);
  assert.equal(g.identical, true, "two independent fills don't price to the same penny");
});

test("a single row is never a group, and empty input is safe", () => {
  assert.deepEqual(nearDuplicateGroups([trade("2026-09-02", "TG36", "BUY", 10000, 13350)]), []);
  assert.deepEqual(nearDuplicateGroups([]), []);
  assert.deepEqual(nearDuplicateGroups(), []);
});

/* --------------------- statement self-consistency --------------------- */

test("the decisive check: the statement's own positions contradict its trade rows", () => {
  // Three TG36 buys of 10,000 in a statement that also says the position is
  // 10,000. That isn't a judgement about the Flex config — it's the pull
  // disagreeing with itself, which is a fact.
  const { conflicts, clean } = crossCheckPositions({
    trades: [
      trade("2026-09-02", "TG36", "BUY", 10000, 13355.50),
      trade("2026-09-02", "TG36", "BUY", 10000, 13347.00),
      trade("2026-09-02", "TG36", "BUY", 10000, 13349.83),
    ],
    brokerPositions: [{ ticker: "TG36", qty: 10000 }],
    existingQty: {},
  });
  assert.equal(clean, false);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].ticker, "TG36");
  assert.equal(conflicts[0].wouldBe, 30000);
  assert.equal(conflicts[0].brokerQty, 10000);
  assert.equal(conflicts[0].over, 20000);
});

test("existing ledger rows count towards the total, since import ADDS to them", () => {
  const { conflicts } = crossCheckPositions({
    trades: [trade("2026-09-02", "TG36", "BUY", 10000, 13350)],
    brokerPositions: [{ ticker: "TG36", qty: 10000 }],
    existingQty: { TG36: 10000 },
  });
  assert.equal(conflicts[0].wouldBe, 20000, "10,000 already held plus 10,000 imported");
  assert.equal(conflicts[0].over, 10000);
});

test("an import that lands exactly on the broker's position is silent", () => {
  const r = crossCheckPositions({
    trades: [trade("2026-08-21", "TG30", "BUY", 18000, 15261.42)],
    brokerPositions: [{ ticker: "TG30", qty: 18000 }, { ticker: "XNAQ", qty: 362 }],
    existingQty: {},
  });
  assert.equal(r.clean, true);
  assert.deepEqual(r.conflicts, []);
});

test("sells reduce the implied position", () => {
  const { conflicts } = crossCheckPositions({
    trades: [trade("2026-08-01", "VOD.L", "BUY", 1000, 700), trade("2026-08-02", "VOD.L", "SELL", 400, 290)],
    brokerPositions: [{ ticker: "VOD.L", qty: 600 }],
    existingQty: {},
  });
  assert.deepEqual(conflicts, []);
});

test("holdings the statement doesn't report are not judged", () => {
  // Another broker's holding says nothing about this statement.
  const r = crossCheckPositions({
    trades: [trade("2026-08-01", "BNKR", "BUY", 5187, 30000)],
    brokerPositions: [{ ticker: "TG30", qty: 18000 }],
    existingQty: {},
  });
  assert.equal(r.clean, true);
});

test("an exact multiple of the broker's position names the cause", () => {
  // 3 rows of 10,000 against a 10,000 position is exactly 3x. That doesn't
  // happen by coincidence, so it can be stated rather than guessed at.
  const three = crossCheckPositions({
    trades: [
      trade("2026-09-02", "TG36", "BUY", 10000, 13355.50),
      trade("2026-09-02", "TG36", "BUY", 10000, 13347.00),
      trade("2026-09-02", "TG36", "BUY", 10000, 13349.83),
    ],
    brokerPositions: [{ ticker: "TG36", qty: 10000 }], existingQty: {},
  });
  assert.equal(three.conflicts[0].repeatFactor, 3, "the same trade three times over");
  assert.equal(three.conflicts[0].looksLikeRepeatedRows, true);

  // An excess that ISN'T a clean multiple is a different problem (a genuine
  // missing sale, say) and must not be labelled as repeated rows.
  const odd = crossCheckPositions({
    trades: [trade("2026-09-02", "TG36", "BUY", 3000, 4000)],
    brokerPositions: [{ ticker: "TG36", qty: 10000 }], existingQty: {},
  });
  assert.equal(odd.conflicts[0].repeatFactor, null);
  assert.equal(odd.conflicts[0].looksLikeRepeatedRows, false);
});

test("dismissed tickers are skipped by the cross-check too", () => {
  const r = crossCheckPositions({
    trades: [trade("2026-08-01", "TG36", "BUY", 99999, 1)],
    brokerPositions: [{ ticker: "TG36", qty: 10000 }],
    existingQty: {}, skipTickers: ["TG36"],
  });
  assert.equal(r.clean, true);
});

/* ------------- reconciliation scope: the second-broker problem -------- */

test("a holding at ANOTHER broker is out of scope, not a disagreement", () => {
  // The complaint this fixes: "11 of 27 GIA holdings disagree with your
  // broker", where 11 of them simply weren't at that broker at all.
  const { rows, summary } = reconcilePositions({
    broker: [{ ticker: "TG30", qty: 18000 }],
    positions: [
      { ticker: "TG30", wrapper: "GIA", qty: 18000 },
      { ticker: "BNKR", wrapper: "GIA", qty: 5187 },
      { ticker: "SMT", wrapper: "GIA", qty: 2280 },
    ],
  });
  assert.equal(summary.discrepancies, 0);
  assert.equal(summary.clean, true, "nothing here is evidence of a missing transaction");
  assert.equal(summary.notAtBroker, 2);
  assert.equal(summary.checked, 1, "one line the statement can actually speak to");
  assert.deepEqual(rows.filter((r) => r.status === "not-at-broker").map((r) => r.ticker).sort(), ["BNKR", "SMT"]);
});

test("dismissing a holding as held elsewhere removes it from the list for good", () => {
  const { rows, summary } = reconcilePositions({
    broker: [{ ticker: "TG30", qty: 18000 }],
    positions: [
      { ticker: "TG30", wrapper: "GIA", qty: 18000 },
      { ticker: "BNKR", wrapper: "GIA", qty: 5187 },
    ],
    excluded: ["BNKR"],
  });
  assert.ok(!rows.some((r) => r.ticker === "BNKR"), "gone from the table entirely");
  assert.equal(summary.excludedCount, 1);
  assert.deepEqual(summary.excludedTickers, ["BNKR"]);
  assert.equal(summary.clean, true);
});

test("a holding this broker HAS reported before, now absent, is a real flag", () => {
  // The distinction that makes remembering coverage worth the storage: an
  // omitted line and a line that was never there are identical in a single
  // statement, but mean completely different things.
  const { rows, summary } = reconcilePositions({
    broker: [{ ticker: "TG30", qty: 18000 }],
    positions: [
      { ticker: "TG30", wrapper: "GIA", qty: 18000 },
      { ticker: "SOLD", wrapper: "GIA", qty: 500 },
      { ticker: "ELSEWHERE", wrapper: "GIA", qty: 100 },
    ],
    seenAtBroker: ["TG30", "SOLD"],
  });
  const by = Object.fromEntries(rows.map((r) => [r.ticker, r.status]));
  assert.equal(by.SOLD, "closed-at-broker", "it was here last time — a sale may be unrecorded");
  assert.equal(by.ELSEWHERE, "not-at-broker");
  assert.equal(summary.discrepancies, 1, "only the one that means something");
  assert.equal(summary.closedAtBroker, 1);
  assert.equal(summary.clean, false);
});

test("an exclusion cannot hide a holding the statement actually reports", () => {
  // Otherwise a dismissal made once would suppress a real discrepancy for ever.
  const { rows } = reconcilePositions({
    broker: [{ ticker: "WFC", qty: 327 }],
    positions: [{ ticker: "WFC", wrapper: "GIA", qty: 0 }],
    excluded: ["WFC"],
  });
  assert.equal(rows[0].status, "missing-in-ledger");
});

test("coverage accumulates across imports and never forgets", () => {
  const first = mergeBrokerCoverage([], [{ ticker: "TG30" }, { ticker: "XNAQ" }]);
  assert.deepEqual(first, ["TG30", "XNAQ"]);
  // TG30 sold and gone from the next statement — still remembered, which is
  // exactly what turns its absence into a flag instead of a shrug.
  const second = mergeBrokerCoverage(first, [{ ticker: "XNAQ" }, { ticker: "TG36" }]);
  assert.deepEqual(second, ["TG30", "TG36", "XNAQ"]);
  assert.deepEqual(mergeBrokerCoverage(), []);
});

test("data health counts only real discrepancies", async () => {
  const { dataHealth } = await import("../core/data-health.mjs");
  const { summary } = reconcilePositions({
    broker: [{ ticker: "TG30", qty: 18000 }],
    positions: [{ ticker: "TG30", wrapper: "GIA", qty: 18000 }, { ticker: "BNKR", wrapper: "GIA", qty: 5187 }],
  });
  const health = dataHealth({ today: "2026-09-04", positionDrift: summary });
  assert.ok(!health.issues.some((i) => i.id === "position-drift"),
    "another broker's holdings must not raise a high-severity data-health alert");
});
