import { test } from "node:test";
import assert from "node:assert/strict";
import { locationPlan, giaDragPct, marginalRates, KIND_ASSUMPTIONS } from "../core/asset-location.mjs";

const pos = (ticker, wrapper, marketValue, kind, extra = {}) => ({ ticker, wrapper, marketValue, kind, priced: true, ...extra });

test("marginal rates by band", () => {
  assert.deepEqual(marginalRates(30000), { dividend: 0.0875, interest: 0.20, cgt: 0.18 });
  assert.deepEqual(marginalRates(90000), { dividend: 0.3375, interest: 0.40, cgt: 0.24 });
  assert.equal(marginalRates(200000).interest, 0.45);
});

test("drag ordering for a higher-rate taxpayer: bond funds > par gilts > equity funds; low-coupon gilts cheapest", () => {
  const rates = marginalRates(90000);
  const bond = giaDragPct(pos("BND", "GIA", 1, "bond_fund"), {}, rates);       // 4%×40% + 0.5%×24%×0.5 = 1.66%
  const eq = giaDragPct(pos("VWRL", "GIA", 1, "fund"), {}, rates);             // 2%×33.75% + 5%×24%×0.5 = 1.275%
  const gilt = giaDragPct(pos("TN28", "GIA", 1, "gilt"), {}, rates);           // 3.5%×40% = 1.40% (CGT-exempt)
  const lowGilt = giaDragPct(pos("TN31", "GIA", 1, "gilt"), { TN31: { yieldPct: 0.25 } }, rates); // 0.10%
  assert.ok(bond > gilt && gilt > eq, `expected bond ${bond} > gilt ${gilt} > equity fund ${eq}`);
  assert.ok(lowGilt < eq, "the LOW-COUPON gilt is the classic cheap-to-hold-outside asset");
  // gilt drag = coupon × interest rate only (no capital term — s115 exempt)
  assert.ok(Math.abs(gilt - (KIND_ASSUMPTIONS.gilt.incomeYield / 100) * rates.interest) < 1e-12);
});

test("secMeta yieldPct overrides the kind default", () => {
  const rates = marginalRates(90000);
  const low = giaDragPct(pos("TN31", "GIA", 1, "gilt"), { TN31: { yieldPct: 0.25 } }, rates);
  assert.ok(Math.abs(low - 0.0025 * 0.40) < 1e-12); // low-coupon gilt: near-zero drag
});

test("plan: shelters the highest-drag assets first and quantifies the saving", () => {
  // Genuinely backwards: a near-zero-drag low-coupon gilt hogs the ISA
  // while the high-drag bond fund sits taxable.
  const plan = locationPlan({
    positions: [
      pos("BND", "GIA", 100000, "bond_fund"),
      pos("TN31", "ISA", 100000, "gilt"),
    ],
    secMeta: { TN31: { yieldPct: 0.25 } },
    income: 90000,
  });
  assert.ok(plan.currentDrag > plan.minimalDrag);
  assert.ok(plan.savingPerYear > 0);
  // shelter the bond fund; the low-coupon gilt is the classic release
  assert.deepEqual(plan.moves.map((m) => [m.ticker, m.direction]), [["BND", "shelter"], ["TN31", "release"]]);
  // saving ≈ (1.66% − 0.10%) × £100k
  assert.ok(Math.abs(plan.savingPerYear - (0.0166 - 0.001) * 100000) < 1);
});

test("an already-optimal portfolio reports ~zero saving and no moves", () => {
  const plan = locationPlan({
    positions: [
      pos("BND", "SIPP", 100000, "bond_fund"),                 // highest drag, sheltered
      pos("TN31", "GIA", 100000, "gilt"),                       // cheapest, outside
    ],
    secMeta: { TN31: { yieldPct: 0.25 } },
    income: 90000,
  });
  assert.ok(plan.savingPerYear < 0.01, String(plan.savingPerYear));
  assert.equal(plan.moves.length, 0);
});

test("no shelter capacity -> minimal equals current, everything stays put", () => {
  const plan = locationPlan({ positions: [pos("VWRL", "GIA", 50000, "fund")], income: 30000 });
  assert.equal(plan.currentDrag, plan.minimalDrag);
  assert.equal(plan.moves.length, 0);
  assert.equal(plan.savingPerYear, 0);
});
