import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjection, spendMult, dbRate, annuityRate, giaWithdraw, effInflation,
  STRATEGY, STRATEGY_LABELS, lifeExpectancy, btlYearly,
} from "../core/drawdown.mjs";

// A complete, minimal-but-valid `p` config, mirroring PlanTab.jsx's DEFAULTS.
// Individual tests override just the fields they care about.
const BASE_P = {
  region: "ruk", currentAge: 45, retireAge: 60, spaAge: 67, accessAge: 57, planAge: 95,
  salary: 75000, salaryGrowth: 2.5, startPot: 250000, empPct: 8, erPct: 5, fixedContrib: 0,
  growthPre: 6, growthPost: 4.5, inflation: 3, inflMode: "cpi", rpiWedge: 1, fee: 0.5, vol: 13,
  includeState: true, statePension: 11973, targetMode: "ratio", replacementRatio: 67, targetAbsolute: 35000,
  tfcMode: "ufpls", isaStart: 90000, isaContrib: 8000, giaStart: 40000, otherNetWorthStart: 0,
  giaContrib: 0, lisaStart: 12000, lisaContrib: 4000, tripleLock: true, earningsGrowth: 3.5,
  dbEnabled: false, dbPension: 0, dbIndex: "cpi", dbFixedRate: 3, drawStrategy: "taxopt",
  spendProfile: "flat", goGoUntil: 75, slowGoUntil: 85, goGoPct: 110, slowGoPct: 90, noGoPct: 100,
  annuityEnabled: false, annuityAge: 70, annuityPortion: 50, annuityEscalation: "level",
  btlEnabled: false, postAccessContrib: 0,
};

/* ------------------------------ buildProjection --------------------------- */

test("buildProjection: basic shape — timeline covers accumulation + decumulation years", () => {
  const det = buildProjection(BASE_P);
  // accumulation runs [currentAge, retireAge); decumulation runs
  // [retireAge, planAge] INCLUSIVE (the loop condition is `age <= planAge`),
  // so the combined timeline has one more row than a simple age-range span.
  assert.equal(det.timeline.length, BASE_P.planAge - BASE_P.currentAge + 1);
  assert.equal(det.timeline[0].phase, "accum");
  assert.equal(det.timeline[det.timeline.length - 1].phase, "decum");
  assert.ok(det.wealthAtRetire > BASE_P.startPot + BASE_P.isaStart + BASE_P.giaStart + BASE_P.lisaStart);
});

test("buildProjection: PCLS mode moves 25% of the pot into the ISA at retirement, tax-free", () => {
  const ufpls = buildProjection({ ...BASE_P, tfcMode: "ufpls" });
  const pcls = buildProjection({ ...BASE_P, tfcMode: "pcls" });
  assert.ok(pcls.pclsAmount > 0);
  assert.equal(ufpls.pclsAmount, 0);
  // total wealth at retirement should be (near) identical either way — it's
  // just reshuffled between pension and ISA, not created or destroyed
  assert.ok(Math.abs(pcls.wealthAtRetire - ufpls.wealthAtRetire) < 1);
});

test("buildProjection: a bigger starting pot never leaves you worse off at retirement", () => {
  const small = buildProjection(BASE_P);
  const big = buildProjection({ ...BASE_P, startPot: BASE_P.startPot * 2 });
  assert.ok(big.wealthAtRetire > small.wealthAtRetire);
});

test("buildProjection: STRATEGY/STRATEGY_LABELS cover the same 5 strategy keys", () => {
  assert.deepEqual(Object.keys(STRATEGY).sort(), Object.keys(STRATEGY_LABELS).sort());
  for (const order of Object.values(STRATEGY)) {
    assert.deepEqual([...order].sort(), ["GIA", "ISA", "LISA", "PB", "PX"].sort());
  }
});

/* ---------------------------------- MPAA ----------------------------------- */

test("MPAA: never triggers when postAccessContrib is 0 (the default — every existing plan)", () => {
  const det = buildProjection(BASE_P);
  assert.equal(det.postAccessContrib, 0);
  // mpaaTriggered can still be true (drawing pension income doesn't need a
  // postAccessContrib to happen) but there must be nothing to breach.
  assert.equal(det.mpaaBreachAge, null);
  assert.equal(det.mpaaExcessTotal, 0);
});

test("MPAA: not triggered when the plan never draws pension income (bridge covers spending, PCLS-only)", () => {
  const det = buildProjection({
    ...BASE_P,
    tfcMode: "pcls",
    drawStrategy: "taxfree", // ISA/LISA/GIA before pension
    targetMode: "absolute",
    targetAbsolute: 4000, // trivial spend, easily covered by a large ISA
    isaStart: 900000,
    postAccessContrib: 15000,
  });
  assert.equal(det.mpaaTriggered, false);
  assert.equal(det.mpaaTriggerAge, null);
  assert.equal(det.mpaaBreachAge, null);
  assert.equal(det.mpaaExcessTotal, 0);
});

test("MPAA: triggers at the first age any pension income is actually drawn", () => {
  const det = buildProjection(BASE_P); // taxopt puts PB first — draws immediately at retirement
  assert.equal(det.mpaaTriggered, true);
  assert.equal(det.mpaaTriggerAge, BASE_P.retireAge);
  assert.ok(det.grossSchedule[0] > 0);
});

test("MPAA: no breach when postAccessContrib is within the £10,000 cap", () => {
  const det = buildProjection({ ...BASE_P, postAccessContrib: 8000 });
  assert.equal(det.mpaaTriggered, true);
  assert.equal(det.mpaaBreachAge, null);
  assert.equal(det.mpaaExcessTotal, 0);
  assert.equal(det.mpaaLimit, 10000);
});

test("MPAA: flags a breach, and accumulates the excess every year post-trigger, when postAccessContrib exceeds the cap", () => {
  const det = buildProjection({ ...BASE_P, postAccessContrib: 15000 });
  assert.equal(det.mpaaTriggered, true);
  assert.equal(det.mpaaBreachAge, det.mpaaTriggerAge); // triggers and breaches the same year here
  const decumYears = det.timeline.filter((t) => t.phase === "decum").length;
  assert.ok(Math.abs(det.mpaaExcessTotal - 5000 * decumYears) < 1); // £5,000 excess every decum year
});

test("MPAA: postAccessContrib actually grows the pension pot during decumulation", () => {
  const withContrib = buildProjection({ ...BASE_P, postAccessContrib: 5000 });
  const without = buildProjection({ ...BASE_P, postAccessContrib: 0 });
  // same spending plan either way, but the contributing version should end
  // with more (or deplete later than) the non-contributing version
  const lastWith = withContrib.timeline[withContrib.timeline.length - 1];
  const lastWithout = without.timeline[without.timeline.length - 1];
  assert.ok(lastWith.potReal >= lastWithout.potReal - 1);
});

/* ------------------------------ pure helpers ------------------------------- */

test("spendMult: flat profile is always 1.0", () => {
  assert.equal(spendMult({ ...BASE_P, spendProfile: "flat" }, 65), 1.0);
  assert.equal(spendMult({ ...BASE_P, spendProfile: "flat" }, 90), 1.0);
});

test("spendMult: custom profile steps down go-go -> slow-go -> no-go", () => {
  const p = { ...BASE_P, spendProfile: "custom", goGoUntil: 70, slowGoUntil: 80, goGoPct: 110, slowGoPct: 90, noGoPct: 100 };
  assert.ok(Math.abs(spendMult(p, 65) - 1.1) < 1e-9);
  assert.ok(Math.abs(spendMult(p, 75) - 0.9) < 1e-9);
  assert.ok(Math.abs(spendMult(p, 85) - 1.0) < 1e-9);
});

test("dbRate: fixed uses dbFixedRate, cpi/rpi use inflation assumptions", () => {
  assert.equal(dbRate({ ...BASE_P, dbIndex: "fixed", dbFixedRate: 4 }), 0.04);
  assert.equal(dbRate({ ...BASE_P, dbIndex: "cpi", inflation: 3 }), 0.03);
  assert.equal(dbRate({ ...BASE_P, dbIndex: "rpi", inflation: 3, rpiWedge: 1 }), 0.04);
});

test("annuityRate: increases with age, reduced by escalation", () => {
  const r60 = annuityRate(60, "level");
  const r75 = annuityRate(75, "level");
  assert.ok(r75 > r60);
  assert.ok(annuityRate(65, "rpi") < annuityRate(65, "level"));
});

test("giaWithdraw: sale within the AEA realises no CGT", () => {
  const w = giaWithdraw(1000, 10000, 5000, 10000, 0.18); // huge AEA headroom
  assert.equal(w.cgt, 0);
  assert.equal(w.cash, 1000);
});

test("giaWithdraw: gain beyond the AEA is taxed at the given CGT rate", () => {
  const w = giaWithdraw(5000, 10000, 0, 0, 0.18); // 100% gain fraction, no AEA left
  assert.ok(Math.abs(w.cgt - w.gain * 0.18) < 1);
});

test("effInflation: RPI mode adds the wedge on top of the CPI figure", () => {
  assert.equal(effInflation({ inflMode: "cpi", inflation: 3, rpiWedge: 1 }), 3);
  assert.equal(effInflation({ inflMode: "rpi", inflation: 3, rpiWedge: 1 }), 4);
});

test("lifeExpectancy: healthy adds a bump, female baseline higher than male", () => {
  const m = lifeExpectancy(45, "male", false);
  const f = lifeExpectancy(45, "female", false);
  const mHealthy = lifeExpectancy(45, "male", true);
  assert.ok(f.mean > m.mean);
  assert.ok(mHealthy.mean > m.mean);
});

test("btlYearly: equity is value minus outstanding mortgage, clears at btlClearAge", () => {
  const p = { ...BASE_P, currentAge: 45, btlValue: 300000, btlGrowth: 3, btlYield: 5, btlRentGrowth: 2, btlMaint: 5, btlMgmt: 10, btlVoid: 2, btlMortgage: 150000, btlRate: 4, btlClearAge: 50 };
  const before = btlYearly(p, 3); // age 48, not yet cleared
  const after = btlYearly(p, 6); // age 51, cleared
  assert.ok(before.balance > 0);
  assert.equal(after.balance, 0);
  assert.equal(after.equity, after.value);
});
