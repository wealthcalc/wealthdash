import { test } from "node:test";
import assert from "node:assert/strict";
import { priceSanity, detectCorporateActions } from "../core/price-sanity.mjs";

test("ordinary market moves are NOT flagged — a warning you always see is one you ignore", () => {
  const { issues, clean } = priceSanity({
    prices: { A: 105, B: 92, C: 118 },
    previous: { A: 100, B: 100, C: 100 },
  });
  assert.equal(clean, true);
  assert.deepEqual(issues, []);
});

test("an implausible jump is flagged before it can land in a snapshot", () => {
  const { issues } = priceSanity({ prices: { X: 45 }, previous: { X: 100 } });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "jump");
  assert.equal(issues[0].changePct, -55);
  assert.match(issues[0].message, /Verify before this lands in a snapshot/);
});

test("a move on a tidy ratio is called out as a probable split, not a crash", () => {
  // The fix for a split is to adjust QUANTITY; the fix for a bad quote is to
  // re-fetch. Conflating them sends the user down the wrong path.
  const { issues } = priceSanity({ prices: { SPLIT: 25 }, previous: { SPLIT: 100 } });
  assert.equal(issues[0].type, "possible-split");
  assert.equal(issues[0].ratio, "4:1");
  assert.match(issues[0].message, /quantity needs adjusting/);

  // And the other direction (a reverse split multiplies the price).
  const rev = priceSanity({ prices: { REV: 1000 }, previous: { REV: 100 } });
  assert.equal(rev.issues[0].type, "possible-split");
  assert.match(rev.issues[0].message, /reverse share split/);
});

test("a live-feed price on a workplace fund is always wrong", () => {
  // The AVEM case: a real emerging-markets ETF shares the fund's code, so a
  // quote lookup returns a plausible price for the wrong security — in USD.
  const { issues } = priceSanity({
    prices: { AVEM: 71.4 },
    previous: { AVEM: 6.75 },
    priceMeta: { AVEM: { source: "Yahoo", ccy: "USD" } },
    secMeta: { AVEM: { kind: "fund" } },
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].type, "wrong-source");
  assert.match(issues[0].message, /different security with the same symbol/);
  assert.match(issues[0].message, /USD/);

  // A hand-entered or provider-supplied price on the same fund is fine.
  for (const source of ["manual", "manual-snapshot", "L&G"]) {
    const ok = priceSanity({
      prices: { AVEM: 6.9 }, previous: { AVEM: 6.75 },
      priceMeta: { AVEM: { source } }, secMeta: { AVEM: { kind: "fund" } },
    });
    assert.equal(ok.clean, true, `${source} must not be flagged`);
  }
});

test("zero, negative and unusable prices are caught", () => {
  const { issues } = priceSanity({ prices: { Z: 0, N: -5, S: "abc" }, previous: { Z: 10, N: 10, S: 10 } });
  assert.equal(issues.length, 3);
  assert.ok(issues.every((i) => i.type === "invalid"));
  assert.match(issues.find((i) => i.ticker === "Z").message, /zero/);
});

test("a first-ever price has nothing to compare against and isn't flagged", () => {
  const { clean } = priceSanity({ prices: { NEW: 500 }, previous: {} });
  assert.equal(clean, true);
});

test("corporate actions: a clean multiple is a split, an arbitrary difference isn't", () => {
  const actions = detectCorporateActions({
    reconcileRows: [
      { ticker: "SPLIT4", ledgerQty: 100, brokerQty: 400, status: "missing-in-ledger" },
      { ticker: "MISSING", ledgerQty: 100, brokerQty: 427, status: "missing-in-ledger" },
      { ticker: "FINE", ledgerQty: 100, brokerQty: 100, status: "match" },
    ],
  });
  assert.equal(actions.length, 1, "only the clean multiple is called a split");
  assert.equal(actions[0].ticker, "SPLIT4");
  assert.equal(actions[0].type, "split");
  assert.equal(actions[0].ratio, "4:1");
  assert.match(actions[0].message, /total cost is unchanged/i);
});

test("corporate actions: a reverse split is recognised too", () => {
  const actions = detectCorporateActions({
    reconcileRows: [{ ticker: "REV", ledgerQty: 1000, brokerQty: 100, status: "extra-in-ledger" }],
  });
  assert.equal(actions[0].type, "reverse-split");
  assert.equal(actions[0].ratio, "1:10");
});

test("corporate actions: holdings the broker doesn't report are never guessed at", () => {
  const actions = detectCorporateActions({
    reconcileRows: [{ ticker: "ELSEWHERE", ledgerQty: 100, brokerQty: 0, status: "not-at-broker" }],
  });
  assert.deepEqual(actions, []);
});

test("empty inputs are safe", () => {
  assert.equal(priceSanity({}).clean, true);
  assert.deepEqual(detectCorporateActions({}), []);
});
