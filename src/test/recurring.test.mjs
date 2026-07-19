import { test } from "node:test";
import assert from "node:assert/strict";
import {
  expandRecurring, statementCoverage, annualCommitment, addMonthsClamped, FREQUENCIES,
} from "../core/recurring.mjs";

const MOBILE = { id: "m", label: "Mobile", amount: 35, frequency: "monthly", startDate: "2026-01-15", categoryId: "util", account: "HSBC" };
const SERVICE = { id: "s", label: "Service charge", amount: 1200, frequency: "quarterly", startDate: "2026-01-01", categoryId: "home", account: "HSBC" };
const BUILDING = { id: "b", label: "Building insurance", amount: 900, frequency: "annual", startDate: "2026-03-01", categoryId: "ins", account: "HSBC" };

test("addMonthsClamped: a 31st direct debit doesn't skip February", () => {
  assert.equal(addMonthsClamped("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsClamped("2028-01-31", 1), "2028-02-29"); // leap
  assert.equal(addMonthsClamped("2026-01-15", 1), "2026-02-15");
  assert.equal(addMonthsClamped("2026-12-15", 1), "2027-01-15"); // year roll
  assert.equal(addMonthsClamped("2026-01-01", 12), "2027-01-01");
});

test("monthly/quarterly/annual expand on their real payment day", () => {
  const { rows } = expandRecurring({ definitions: [MOBILE], fromDate: "2026-01-01", toDate: "2026-04-30" });
  assert.deepEqual(rows.map((r) => r.date), ["2026-01-15", "2026-02-15", "2026-03-15", "2026-04-15"]);
  assert.equal(rows[0].amount, 35);
  assert.equal(rows[0].estimated, true);
  assert.equal(rows[0].categoryId, "util");

  const q = expandRecurring({ definitions: [SERVICE], fromDate: "2026-01-01", toDate: "2026-12-31" }).rows;
  assert.deepEqual(q.map((r) => r.date), ["2026-01-01", "2026-04-01", "2026-07-01", "2026-10-01"]);

  const a = expandRecurring({ definitions: [BUILDING], fromDate: "2026-01-01", toDate: "2028-12-31" }).rows;
  assert.deepEqual(a.map((r) => r.date), ["2026-03-01", "2027-03-01", "2028-03-01"]);
});

test("THE double-count guard: a month with imported statement rows suppresses the estimate", () => {
  // Statement imported for Jan and Feb on HSBC only.
  const imported = [
    { id: "t1", date: "2026-01-15", description: "MOBILE LTD DD", amount: 35, account: "HSBC" },
    { id: "t2", date: "2026-02-15", description: "MOBILE LTD DD", amount: 37, account: "HSBC" }, // price rise!
  ];
  const coverage = statementCoverage(imported);
  const { rows, suppressed } = expandRecurring({
    definitions: [MOBILE], fromDate: "2026-01-01", toDate: "2026-04-30", coverage,
  });
  // Jan/Feb come from the statement (which knows about the £37), so the
  // estimate is suppressed; Mar/Apr are not yet imported, so it fills in.
  assert.deepEqual(rows.map((r) => r.date), ["2026-03-15", "2026-04-15"]);
  assert.equal(suppressed.length, 2);
  assert.equal(suppressed[0].reason, "statement-covered");
});

test("coverage is per ACCOUNT — an Amex import doesn't suppress an HSBC direct debit", () => {
  const coverage = statementCoverage([
    { id: "a", date: "2026-01-04", description: "TESCO", amount: 40, account: "Amex" },
  ]);
  const { rows } = expandRecurring({ definitions: [MOBILE], fromDate: "2026-01-01", toDate: "2026-01-31", coverage });
  assert.equal(rows.length, 1, "HSBC commitment wrongly suppressed by an Amex statement");
});

test("estimated rows never contribute to coverage — estimates can't suppress estimates", () => {
  const cover = statementCoverage([
    { id: "r", date: "2026-01-15", amount: 35, account: "HSBC", estimated: true },
  ]);
  assert.equal(Object.keys(cover).length, 0);
});

test("alwaysInclude overrides suppression, for commitments genuinely absent from the statement", () => {
  const coverage = statementCoverage([{ id: "t", date: "2026-01-15", amount: 9, account: "HSBC" }]);
  const { rows } = expandRecurring({
    definitions: [{ ...MOBILE, alwaysInclude: true }], fromDate: "2026-01-01", toDate: "2026-01-31", coverage,
  });
  assert.equal(rows.length, 1);
});

test("endDate stops a finished commitment inflating future budgets", () => {
  const { rows } = expandRecurring({
    definitions: [{ ...MOBILE, endDate: "2026-03-01" }], fromDate: "2026-01-01", toDate: "2026-06-30",
  });
  assert.deepEqual(rows.map((r) => r.date), ["2026-01-15", "2026-02-15"]);
});

test("a commitment starting in the future doesn't backfill history", () => {
  const { rows } = expandRecurring({
    definitions: [{ ...MOBILE, startDate: "2026-06-15" }], fromDate: "2026-01-01", toDate: "2026-07-31",
  });
  assert.deepEqual(rows.map((r) => r.date), ["2026-06-15", "2026-07-15"]);
});

test("annualCommitment normalises every frequency to £/yr", () => {
  const { total, byCategory } = annualCommitment([MOBILE, SERVICE, BUILDING]);
  //       35×12 = 420        1200×4 = 4800      900×1 = 900
  assert.equal(total, 420 + 4800 + 900);
  assert.equal(byCategory.util, 420);
  assert.equal(byCategory.home, 4800);
  assert.equal(byCategory.ins, 900);
  // ended commitments drop out as at a date
  assert.equal(annualCommitment([{ ...MOBILE, endDate: "2026-05-01" }], { asOf: "2026-07-01" }).total, 0);
});

test("degenerate inputs and the frequency table", () => {
  assert.throws(() => expandRecurring({ definitions: [MOBILE] }), /fromDate/);
  assert.deepEqual(expandRecurring({ definitions: [], fromDate: "2026-01-01", toDate: "2026-12-31" }).rows, []);
  // no amount / no startDate are ignored rather than throwing (user input)
  assert.deepEqual(expandRecurring({ definitions: [{ id: "x", amount: 0, startDate: "2026-01-01" }], fromDate: "2026-01-01", toDate: "2026-12-31" }).rows, []);
  assert.deepEqual(expandRecurring({ definitions: [{ id: "y", amount: 10 }], fromDate: "2026-01-01", toDate: "2026-12-31" }).rows, []);
  assert.equal(FREQUENCIES.length, 4);
});
