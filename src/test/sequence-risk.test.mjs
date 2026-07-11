import { test } from "node:test";
import assert from "node:assert/strict";
import { buildProjection, HIST } from "../core/drawdown.mjs";
import { rollingStressTest } from "../core/sequence-risk.mjs";

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

test("rollingStressTest: runs every offset for every HIST sequence, no more no less", () => {
  const det = buildProjection(BASE_P);
  const r = rollingStressTest(BASE_P, det);
  const expectedTotal = Object.values(HIST).reduce((s, h) => s + h.returns.length, 0);
  assert.equal(r.totalRuns, expectedTotal);
  assert.equal(Object.keys(r.bySequence).length, Object.keys(HIST).length);
  for (const key of Object.keys(HIST)) {
    assert.equal(r.bySequence[key].runs.length, HIST[key].returns.length);
  }
});

test("rollingStressTest: survivalRate is between 0 and 1 and consistent with worstDepletionAge presence", () => {
  const det = buildProjection(BASE_P);
  const r = rollingStressTest(BASE_P, det);
  assert.ok(r.survivalRate >= 0 && r.survivalRate <= 1);
  if (r.survivalRate < 1) {
    assert.ok(r.worstDepletionAge !== null);
    assert.ok(r.worstCase !== null);
  } else {
    assert.equal(r.worstDepletionAge, null);
    assert.equal(r.worstCase, null);
  }
});

test("rollingStressTest: a very well-funded plan (huge starting pot, low spend) survives every historical replay", () => {
  const richP = { ...BASE_P, startPot: 5000000, isaStart: 2000000, targetMode: "absolute", targetAbsolute: 20000 };
  const det = buildProjection(richP);
  const r = rollingStressTest(richP, det);
  assert.equal(r.survivalRate, 1);
  assert.equal(r.worstDepletionAge, null);
});

test("rollingStressTest: a badly underfunded plan (tiny pot, high spend) fails at least some historical replays", () => {
  const poorP = { ...BASE_P, startPot: 20000, isaStart: 5000, giaStart: 0, lisaStart: 0, includeState: false, targetMode: "absolute", targetAbsolute: 60000 };
  const det = buildProjection(poorP);
  const r = rollingStressTest(poorP, det);
  assert.ok(r.survivalRate < 1);
  assert.ok(r.worstDepletionAge !== null);
  assert.ok(r.worstDepletionAge >= poorP.retireAge);
});

test("rollingStressTest: worstCase depletion age equals the minimum depletion age across every failed run", () => {
  const poorP = { ...BASE_P, startPot: 20000, isaStart: 5000, giaStart: 0, lisaStart: 0, includeState: false, targetMode: "absolute", targetAbsolute: 60000 };
  const det = buildProjection(poorP);
  const r = rollingStressTest(poorP, det);
  const allDepletions = Object.values(r.bySequence).flatMap((s) => s.runs.filter((run) => !run.survived).map((run) => run.depletion));
  assert.equal(r.worstDepletionAge, Math.min(...allDepletions));
  assert.equal(r.worstCase.depletion, r.worstDepletionAge);
});
