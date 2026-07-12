import { test } from "node:test";
import assert from "node:assert/strict";
import { optimiseDrawdown, compareCandidates } from "../core/drawdown-optimiser.mjs";
import { STRATEGY } from "../core/drawdown.mjs";

// A realistic plan where ordering matters: meaningful pension AND GIA AND
// ISA, spending high enough that tax bands bite. Uses the same DEFAULTS
// shape PlanTab feeds buildProjection (extra keys beyond what the engine
// reads are harmless).
// Field names mirror PlanTab's DEFAULTS exactly (empPct/salaryGrowth etc —
// a wrong key here silently NaNs the projection, which test 1 would catch).
const P = {
  region: "ruk", currentAge: 55, retireAge: 60, spaAge: 67, accessAge: 57, planAge: 90,
  sex: "male", healthy: true,
  salary: 90000, salaryGrowth: 2.5, startPot: 600000, empPct: 8, erPct: 5, fixedContrib: 0,
  growthPre: 5.5, growthPost: 4.5, inflation: 2.5, inflMode: "cpi", rpiWedge: 1, fee: 0.4, vol: 13,
  includeState: true, statePension: 11973, tripleLock: true, earningsGrowth: 3.5,
  targetMode: "absolute", targetAbsolute: 48000, replacementRatio: 67, essentialPct: 65,
  tfcMode: "ufpls", drawStrategy: "giafirst", postAccessContrib: 0,
  isaStart: 200000, isaContrib: 10000, giaStart: 250000, giaContrib: 0,
  lisaStart: 0, lisaContrib: 0, otherNetWorthStart: 0,
  spendProfile: "flat", goGoUntil: 75, slowGoUntil: 85, goGoPct: 110, slowGoPct: 90, noGoPct: 80,
  dbEnabled: false, dbPension: 0, dbIndex: "cpi", dbFixedRate: 3,
  annuityEnabled: false, annuityAge: 70, annuityPortion: 30, annuityEscalation: "level",
  btlEnabled: false,
  mcModel: "single", mcEqStart: 60, mcEqEnd: 40, mcStochInfl: false,
};

test("evaluates all strategy × TFC combos and identifies the current one", () => {
  const r = optimiseDrawdown(P);
  assert.equal(r.candidates.length, Object.keys(STRATEGY).length * 2);
  assert.ok(r.current);
  assert.equal(r.current.strategy, "giafirst");
  assert.equal(r.current.tfcMode, "ufpls");
  assert.ok(r.best);
  // every candidate carries the fields the UI table shows
  for (const c of r.candidates) {
    assert.ok(Number.isFinite(c.lifetimeTaxReal), c.strategy);
    assert.ok(Number.isFinite(c.estateReal), c.strategy);
    assert.ok(typeof c.label === "string");
  }
});

test("ranking prefers survival over tax, then less tax, then bigger estate", () => {
  const lastsCheap = { depletionAge: null, lifetimeTaxReal: 100, estateReal: 50 };
  const lastsDear = { depletionAge: null, lifetimeTaxReal: 200, estateReal: 500 };
  const dies85 = { depletionAge: 85, lifetimeTaxReal: 0, estateReal: 0 };
  const dies80 = { depletionAge: 80, lifetimeTaxReal: 0, estateReal: 0 };
  assert.ok(compareCandidates(lastsCheap, dies85) < 0);       // survival first
  assert.ok(compareCandidates(dies85, dies80) < 0);            // later depletion
  assert.ok(compareCandidates(lastsCheap, lastsDear) < 0);     // then tax
  const tieA = { depletionAge: null, lifetimeTaxReal: 100, estateReal: 900 };
  assert.ok(compareCandidates(tieA, lastsCheap) < 0);          // then estate
});

test("the saving is current-minus-best and non-trivial when the current pick is poor", () => {
  const r = optimiseDrawdown(P); // giafirst is rarely optimal for this shape
  assert.ok(Math.abs(r.taxSaving - (r.current.lifetimeTaxReal - r.best.lifetimeTaxReal)) < 1e-9);
  // sanity, not tautology: lifetime tax differs across strategies at all
  const taxes = new Set(r.candidates.map((c) => Math.round(c.lifetimeTaxReal)));
  assert.ok(taxes.size > 1, "strategies should produce different lifetime tax");
});

test("when the current pick is the best, alreadyOptimal is true and saving is 0", () => {
  const r0 = optimiseDrawdown(P);
  const adopted = { ...P, drawStrategy: r0.best.strategy, tfcMode: r0.best.tfcMode };
  const r1 = optimiseDrawdown(adopted);
  assert.equal(r1.alreadyOptimal, true);
  assert.ok(Math.abs(r1.taxSaving) < 0.01);
});

test("determinism: same plan, same result", () => {
  const a = optimiseDrawdown(P), b = optimiseDrawdown(P);
  assert.deepEqual(a.candidates, b.candidates);
});
