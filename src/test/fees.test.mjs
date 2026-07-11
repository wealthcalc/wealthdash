import { test } from "node:test";
import assert from "node:assert/strict";
import { matchPortfolio, feeOf } from "../core/cgt-engine.mjs";
import { buildPositions } from "../core/portfolio.mjs";
import { holdingFlows } from "../core/returns.mjs";

/* Fees (s38 incidental costs) recorded separately from consideration:
   BUY allowable cost = gbpAmount + fees; SELL net proceeds = gbpAmount −
   fees. Rows without a fees field behave EXACTLY as before — the whole
   existing ledger is fee-less and must not move by a penny. */

const buy = (over = {}) => ({ id: "b1", side: "BUY", ticker: "ABC", date: "2024-01-10", quantity: 100, gbpAmount: 1000, ...over });
const sell = (over = {}) => ({ id: "s1", side: "SELL", ticker: "ABC", date: "2025-06-10", quantity: 100, gbpAmount: 1500, ...over });

test("feeOf: absent, zero, negative and junk fees are all £0", () => {
  assert.equal(feeOf({}), 0);
  assert.equal(feeOf({ fees: 0 }), 0);
  assert.equal(feeOf({ fees: -5 }), 0);
  assert.equal(feeOf({ fees: "junk" }), 0);
  assert.equal(feeOf({ fees: "12.5" }), 12.5);
});

test("no fees -> identical result to the legacy engine", () => {
  const { disposals } = matchPortfolio([buy(), sell()]);
  assert.equal(disposals[0].proceeds, 1500);
  assert.equal(disposals[0].cost, 1000);
  assert.equal(disposals[0].gain, 500);
});

test("buy fees increase allowable cost, sell fees reduce net proceeds", () => {
  const { disposals } = matchPortfolio([buy({ fees: 12 }), sell({ fees: 8 })]);
  assert.ok(Math.abs(disposals[0].cost - 1012) < 1e-9);
  assert.ok(Math.abs(disposals[0].proceeds - 1492) < 1e-9);
  assert.ok(Math.abs(disposals[0].gain - 480) < 1e-9);
});

test("partial disposal pro-rates the seller's fee across the sold fraction", () => {
  const { disposals, pools } = matchPortfolio([buy({ fees: 12 }), sell({ quantity: 50, gbpAmount: 750, fees: 8 })]);
  // net proceeds = 750 - 8 = 742 for the 50 sold; pool keeps half the fee-inclusive cost
  assert.ok(Math.abs(disposals[0].proceeds - 742) < 1e-9);
  assert.ok(Math.abs(disposals[0].cost - 506) < 1e-9); // (1000+12)/2
  assert.ok(Math.abs(pools.ABC.cost - 506) < 1e-9);
});

test("book cost in positions includes buy fees (same engine)", () => {
  const positions = buildPositions({ txns: [buy({ fees: 12 })] });
  assert.ok(Math.abs(positions[0].bookCost - 1012) < 1e-9);
});

test("XIRR flows are net of dealing costs on both sides", () => {
  const flows = holdingFlows({ rows: [buy({ fees: 12 }), sell({ fees: 8 })], asOf: "2025-06-11" });
  assert.equal(flows[0].amount, -1012);
  assert.equal(flows[1].amount, 1492);
});
