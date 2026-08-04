import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMPTIONS, ASSUMPTION_GROUPS, resolveAssumptions, coerceAssumption,
  isOverridden, overriddenCount, kindAssumptionsFrom,
} from "../core/assumptions.mjs";
import { giaDragPct, marginalRates, locationPlan } from "../core/asset-location.mjs";

test("registry is well-formed: unique ids, every entry has a label, group and drives", () => {
  const ids = ASSUMPTIONS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length, "ids must be unique");
  for (const a of ASSUMPTIONS) {
    assert.ok(a.label, `${a.id} needs a label`);
    assert.ok(a.group, `${a.id} needs a group`);
    assert.ok(Array.isArray(a.drives) && a.drives.length, `${a.id} must say what it drives`);
    assert.ok(a.def !== undefined, `${a.id} needs a default`);
    assert.ok(["assumptions", "plan"].includes(a.home), `${a.id} needs a valid home`);
    if (a.home === "plan") assert.ok(a.planKey, `${a.id} must name its plan key`);
  }
  assert.ok(ASSUMPTION_GROUPS.length >= 3);
});

test("resolve: defaults when nothing overridden; overrides win; plan entries read planInputs", () => {
  const base = resolveAssumptions({}, {});
  assert.equal(base["yield.equity"], 2);
  assert.equal(base["realisationFactor"], 0.5);
  assert.equal(base["plan.inflation"], 3);           // registry default when plan is empty

  const r = resolveAssumptions({ "yield.equity": 4.2 }, { inflation: 2.5, growthPre: 7 });
  assert.equal(r["yield.equity"], 4.2);
  assert.equal(r["yield.investment_trust"], 3.5);     // untouched default
  assert.equal(r["plan.inflation"], 2.5);             // from planInputs, not the registry
  assert.equal(r["plan.growthPre"], 7);
});

test("coerce: clamps to range, rejects NaN, trims text", () => {
  assert.equal(coerceAssumption("yield.equity", 99), 15);    // max
  assert.equal(coerceAssumption("yield.equity", -5), 0);     // min
  assert.equal(coerceAssumption("yield.equity", "abc"), 2);  // falls back to default
  assert.equal(coerceAssumption("realisationFactor", 0.75), 0.75);
  assert.equal(coerceAssumption("benchmark.symbol", "  VUSA.L "), "VUSA.L");
  assert.equal(coerceAssumption("benchmark.symbol", ""), "VWRL.L"); // blank -> default
  assert.equal(coerceAssumption("nope.missing", 1), undefined);
});

test("override tracking ignores plan-owned entries and values equal to the default", () => {
  assert.equal(isOverridden("yield.equity", { "yield.equity": 2 }), false, "same as default isn't an override");
  assert.equal(isOverridden("yield.equity", { "yield.equity": 3 }), true);
  assert.equal(isOverridden("plan.inflation", { "plan.inflation": 9 }), false, "plan owns this, not the registry");
  assert.equal(overriddenCount({ "yield.equity": 3, "growth.equity": 6, "yield.gilt": 3.5 }), 2);
});

test("kindAssumptionsFrom shapes the map asset-location consumes, honouring overrides", () => {
  const ka = kindAssumptionsFrom(resolveAssumptions({ "yield.equity": 3, "growth.equity": 8 }, {}));
  assert.equal(ka.equity.incomeYield, 3);
  assert.equal(ka.fund.growth, 8);                 // fund mirrors equity
  assert.equal(ka.gilt.cgtExempt, true);           // structural facts survive overrides
  assert.equal(ka.gilt.growth, 0);
  assert.equal(ka.bond_fund.incomeKind, "interest");
});

test("overrides actually change the location drag they claim to drive", () => {
  const rates = marginalRates(90000);
  const p = { ticker: "VWRL", kind: "fund", marketValue: 10000, priced: true };
  const base = giaDragPct(p, {}, rates);
  const ka = kindAssumptionsFrom(resolveAssumptions({ "yield.equity": 4 }, {}));
  const raised = giaDragPct(p, {}, rates, { kindAssumptions: ka });
  assert.ok(raised > base, "doubling the assumed yield must raise the drag");

  // realisation factor: 0 removes the capital half entirely
  const noCapital = giaDragPct(p, {}, rates, { realisationFactor: 0 });
  assert.ok(noCapital < base);

  // and it flows through locationPlan
  const plan = locationPlan({ positions: [p], income: 90000, kindAssumptions: ka });
  assert.ok(plan.rows[0].dragPct > base);
});
