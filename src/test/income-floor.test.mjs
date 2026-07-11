import { test } from "node:test";
import assert from "node:assert/strict";
import { buildIncomeFloor } from "../core/income-floor.mjs";

// Hand-built projection stub — real timeline rows carry more fields; the
// floor module must only depend on the ones stubbed here.
const P = { currentAge: 60, inflation: 3, inflMode: "cpi", rpiWedge: 1 };
const row = (age, state, db, annuity, spend) => ({
  age, phase: "decum", stateReal: state, dbReal: db, annuityReal: annuity, spendReal: spend,
});
const DET = {
  timeline: [
    { age: 64, phase: "accum", potReal: 500000 },       // accum rows ignored
    row(65, 0, 5000, 0, 30000),                          // pre-SP: DB only
    row(66, 0, 5000, 0, 30000),
    row(67, 12000, 5000, 0, 30000),                      // SP starts
    row(68, 12000, 5000, 3000, 30000),                   // annuity joins
  ],
};

test("stacks real components and computes coverage against essential spend", () => {
  const { rows, summary } = buildIncomeFloor({ det: DET, p: P, currentYear: 2026, essentialPct: 50 });
  assert.equal(rows.length, 4); // accum row dropped
  assert.equal(rows[0].age, 65);
  assert.equal(rows[0].guaranteed, 5000);
  assert.equal(rows[0].essential, 15000);
  assert.ok(Math.abs(rows[0].coverage - 5000 / 15000) < 1e-9);
  assert.equal(rows[0].covered, false);
  // age 67: 12000 + 5000 = 17000 vs 15000 essential -> covered, as is 68
  assert.equal(rows[2].covered, true);
  assert.equal(rows[3].covered, true);
  assert.equal(summary.coveredYears, 2);
  assert.equal(summary.firstCoveredAge, 67);
  assert.equal(summary.permanentFromAge, 67);
  assert.equal(summary.worstAge, 65);
});

test("gilt cashflows are mapped by calendar year and deflated to real terms", () => {
  // age 65 is elapsed 5 -> calendar 2031. Nominal £1000 at 3% CPI for 5y
  // deflates to ~£862.61 in today's money.
  const { rows } = buildIncomeFloor({
    det: DET, p: P, currentYear: 2026, essentialPct: 50,
    giltNominalByYear: { 2031: 1000 },
  });
  const expected = 1000 / Math.pow(1.03, 5);
  assert.ok(Math.abs(rows[0].gilt - expected) < 1e-6);
  assert.ok(Math.abs(rows[0].guaranteed - (5000 + expected)) < 1e-6);
  assert.equal(rows[1].gilt, 0); // no cashflow that year
});

test("RPI mode deflates with the wedge, matching the projection's own inflation", () => {
  const p = { ...P, inflMode: "rpi" }; // 3 + 1 = 4%
  const { rows } = buildIncomeFloor({
    det: DET, p, currentYear: 2026, giltNominalByYear: { 2031: 1000 },
  });
  assert.ok(Math.abs(rows[0].gilt - 1000 / Math.pow(1.04, 5)) < 1e-6);
});

test("a ladder that covers early years then runs out is not 'permanently covered'", () => {
  const det = {
    timeline: [
      row(65, 0, 0, 0, 20000),
      row(66, 0, 0, 0, 20000),
      row(67, 12000, 0, 0, 20000),
    ],
  };
  // Huge gilt cashflow in year 1 only.
  const { summary } = buildIncomeFloor({
    det, p: P, currentYear: 2026, essentialPct: 50,
    giltNominalByYear: { 2031: 50000 },
  });
  assert.equal(summary.firstCoveredAge, 65);
  assert.equal(summary.coveredYears, 2); // 65 (gilt) and 67 (SP)
  assert.equal(summary.permanentFromAge, 67); // 66 breaks the run
  assert.equal(summary.giltYearsCounted, 1);
});

test("degenerate inputs return an empty result, not a crash", () => {
  assert.deepEqual(buildIncomeFloor({}), { rows: [], summary: null });
  assert.equal(buildIncomeFloor({ det: { timeline: [] }, p: P, currentYear: 2026 }).summary, null);
});

test("essentialPct is clamped and zero essential counts as covered", () => {
  const { rows } = buildIncomeFloor({ det: DET, p: P, currentYear: 2026, essentialPct: 0 });
  assert.equal(rows[0].essential, 0);
  assert.equal(rows[0].coverage, null);
  assert.equal(rows[0].covered, true);
  const clamped = buildIncomeFloor({ det: DET, p: P, currentYear: 2026, essentialPct: 250 });
  assert.equal(clamped.rows[0].essential, clamped.rows[0].spend);
});
