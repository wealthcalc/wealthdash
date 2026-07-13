import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjection } from "../core/drawdown.mjs";

// Same DEFAULTS-shaped plan the optimiser tests use.
const P = {
  region: "ruk", currentAge: 55, retireAge: 60, spaAge: 67, accessAge: 57, planAge: 90,
  sex: "male", healthy: true,
  salary: 90000, salaryGrowth: 2.5, startPot: 600000, empPct: 8, erPct: 5, fixedContrib: 0,
  growthPre: 5.5, growthPost: 4.5, inflation: 2.5, inflMode: "cpi", rpiWedge: 1, fee: 0.4, vol: 13,
  includeState: true, statePension: 11973, tripleLock: true, earningsGrowth: 3.5,
  targetMode: "absolute", targetAbsolute: 40000, replacementRatio: 67, essentialPct: 65,
  tfcMode: "ufpls", drawStrategy: "taxopt", postAccessContrib: 0,
  isaStart: 150000, isaContrib: 10000, giaStart: 100000, giaContrib: 0,
  lisaStart: 0, lisaContrib: 0, otherNetWorthStart: 0,
  spendProfile: "flat", goGoUntil: 75, slowGoUntil: 85, goGoPct: 110, slowGoPct: 90, noGoPct: 80,
  dbEnabled: false, dbPension: 0, dbIndex: "cpi", dbFixedRate: 3,
  annuityEnabled: false, annuityAge: 70, annuityPortion: 30, annuityEscalation: "level",
  btlEnabled: false,
};

test("no goals (absent, empty, or disabled) is byte-identical to baseline", () => {
  const base = buildProjection(P);
  for (const goals of [undefined, [], [{ label: "off", age: 57, amount: 50000, enabled: false }]]) {
    const det = buildProjection({ ...P, goals });
    assert.equal(det.wealthAtRetire, base.wealthAtRetire);
    assert.equal(det.totalTaxReal, base.totalTaxReal);
    assert.equal(det.depletionAge, base.depletionAge);
    assert.deepEqual(det.withdrawSchedule, base.withdrawSchedule);
  }
  assert.deepEqual(buildProjection(P).goalEvents, []);
});

test("a pre-retirement goal is funded from liquid pots and shrinks retirement wealth", () => {
  const base = buildProjection(P);
  const det = buildProjection({ ...P, goals: [{ label: "House deposit", age: 57, amount: 60000, enabled: true }] });
  const ev = det.goalEvents[0];
  assert.equal(ev.phase, "accum");
  assert.equal(ev.shortfallNominal, 0, "ISA+GIA comfortably cover it");
  // nominal at age 57 (i=2, funded at year-end) = 60000 × 1.025²; it then
  // misses the remaining TWO growth years (i=3, i=4) before retirement.
  const nominal = 60000 * Math.pow(1.025, 2);
  assert.ok(Math.abs(ev.fundedNominal - nominal) < 1);
  const expectedGap = nominal * Math.pow(1 + (5.5 - 0.4) / 100, 2);
  const gap = base.wealthAtRetire - det.wealthAtRetire;
  assert.ok(Math.abs(gap - expectedGap) < expectedGap * 0.02, `gap ${gap} vs ${expectedGap}`);
});

test("an unfundable pre-access goal reports shortfall and NEVER touches the pension", () => {
  const skint = { ...P, isaStart: 10000, giaStart: 5000, isaContrib: 0 };
  const base = buildProjection(skint);
  const det = buildProjection({ ...skint, goals: [{ label: "Too big", age: 56, amount: 100000, enabled: true }] });
  const ev = det.goalEvents[0];
  assert.ok(ev.shortfallNominal > 0);
  assert.ok(ev.shortfallReal > 80000, "most of it unfundable");
  // pension path unchanged — compare the pension component at retirement
  assert.equal(det.pensionAtRetire, base.pensionAtRetire);
});

test("a retirement-phase goal raises that year's withdrawal and worsens the outcome", () => {
  const base = buildProjection(P);
  const det = buildProjection({ ...P, goals: [{ label: "Gift", age: 70, amount: 80000, enabled: true }] });
  const i = 70 - P.retireAge;
  assert.ok(det.withdrawSchedule[i] > base.withdrawSchedule[i] + 50000, "goal joins that year's draw");
  assert.equal(det.goalEvents[0].phase, "decum");
  // NOTE: lifetime tax is NOT asserted to rise — a big goal can deplete
  // the pot early, and a dead pot pays no tax in the years it no longer
  // funds. The honest invariant is the OUTCOME worsening: less estate,
  // or earlier depletion.
  const worse = det.estateReal < base.estateReal ||
    (base.depletionAge === null ? det.depletionAge !== null : det.depletionAge < base.depletionAge);
  assert.ok(worse, `estate ${det.estateReal} vs ${base.estateReal}, depletion ${det.depletionAge} vs ${base.depletionAge}`);
});

test("LISA can fund goals only from age 60", () => {
  const lisaOnly = { ...P, isaStart: 0, isaContrib: 0, giaStart: 0, lisaStart: 50000 };
  const early = buildProjection({ ...lisaOnly, goals: [{ label: "Pre-60", age: 58, amount: 20000, enabled: true }] });
  assert.ok(early.goalEvents[0].shortfallNominal > 0, "LISA locked before 60 — goal unfunded");
  const later = buildProjection({ ...lisaOnly, retireAge: 62, goals: [{ label: "At 60", age: 60, amount: 20000, enabled: true }] });
  assert.equal(later.goalEvents[0].shortfallNominal, 0, "LISA available at 60");
});
