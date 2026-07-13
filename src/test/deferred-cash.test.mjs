import { test } from "node:test";
import assert from "node:assert/strict";
import {
  awardTranches, vestingSchedule, awardSummary, deferredCashTotals, deferredCashCalendar,
} from "../core/deferred-cash.mjs";
import { buildIncomeCalendar } from "../core/income-calendar.mjs";

// Fixed clock so vested/unvested splits are deterministic.
const TODAY = "2025-07-13";

const AWARDS = [
  { id: "a1", label: "2024 bonus", awardDate: "2024-03-01" },
  { id: "a2", label: "2025 bonus", awardDate: "2025-03-01" },
];
const TRANCHES = [
  // a1: one already paid, two still to come
  { id: "t1", awardId: "a1", date: "2024-09-01", amount: 10000 },
  { id: "t2", awardId: "a1", date: "2025-09-01", amount: 10000 },
  { id: "t3", awardId: "a1", date: "2026-09-01", amount: 10000 },
  // a2: both still to come (one inside the 12-month horizon, one outside)
  { id: "t4", awardId: "a2", date: "2025-08-01", amount: 5000 },
  { id: "t5", awardId: "a2", date: "2026-08-01", amount: 5000 },
];

test("awardTranches filters by award id", () => {
  assert.deepEqual(awardTranches("a1", TRANCHES).map((t) => t.id), ["t1", "t2", "t3"]);
  assert.deepEqual(awardTranches("a2", TRANCHES).map((t) => t.id), ["t4", "t5"]);
  assert.deepEqual(awardTranches("nope", TRANCHES), []);
});

test("vestingSchedule: sorted, vested flag by date, running cumulative", () => {
  const sched = vestingSchedule(AWARDS[0], TRANCHES, TODAY);
  assert.deepEqual(sched.map((r) => r.date), ["2024-09-01", "2025-09-01", "2026-09-01"]);
  assert.deepEqual(sched.map((r) => r.vested), [true, false, false]);
  assert.deepEqual(sched.map((r) => r.cumulativeAmount), [10000, 20000, 30000]);
});

test("awardSummary: total, vested (paid) vs outstanding (net-worth figure), next payout", () => {
  const s1 = awardSummary(AWARDS[0], TRANCHES, TODAY);
  assert.equal(s1.totalAmount, 30000);
  assert.equal(s1.vestedAmount, 10000);       // 2024-09-01 already paid
  assert.equal(s1.outstanding, 20000);        // the two future tranches
  assert.equal(s1.trancheCount, 3);
  assert.deepEqual(s1.nextVest, { date: "2025-09-01", amount: 10000 });

  const s2 = awardSummary(AWARDS[1], TRANCHES, TODAY);
  assert.equal(s2.vestedAmount, 0);
  assert.equal(s2.outstanding, 10000);
  assert.deepEqual(s2.nextVest, { date: "2025-08-01", amount: 5000 });
});

test("awardSummary: an award fully paid out has zero outstanding and no next payout", () => {
  const past = [{ id: "p", awardId: "a1", date: "2024-01-01", amount: 7000 }];
  const s = awardSummary(AWARDS[0], past, TODAY);
  assert.equal(s.outstanding, 0);
  assert.equal(s.vestedAmount, 7000);
  assert.equal(s.nextVest, null);
});

test("deferredCashTotals: aggregates, and `outstanding` is unvested-only", () => {
  const t = deferredCashTotals(AWARDS, TRANCHES, TODAY);
  assert.equal(t.totalAmount, 40000);
  assert.equal(t.vestedAmount, 10000);
  assert.equal(t.outstanding, 30000); // 20000 (a1) + 10000 (a2) — the net-worth contribution
  // soonest next payout first: a2's 2025-08-01 precedes a1's 2025-09-01
  assert.deepEqual(t.rows.map((r) => r.award.id), ["a2", "a1"]);
});

test("deferredCashTotals: empty input is all zeros, no rows", () => {
  const t = deferredCashTotals([], [], TODAY);
  assert.deepEqual(t, { rows: [], totalAmount: 0, vestedAmount: 0, outstanding: 0 });
});

test("deferredCashCalendar: only future tranches within the horizon, sorted, labelled", () => {
  const cal = deferredCashCalendar(AWARDS, TRANCHES, TODAY, 365); // horizon 2026-07-13
  assert.deepEqual(cal, [
    { date: "2025-08-01", amount: 5000, label: "2025 bonus", awardId: "a2" },
    { date: "2025-09-01", amount: 10000, label: "2024 bonus", awardId: "a1" },
  ]);
  // the 2026-08/09 tranches fall outside the 12-month window; the 2024-09 one is already paid
});

test("integration: deferred-cash payouts flow into the income calendar as scheduled events", () => {
  const events = buildIncomeCalendar({
    today: TODAY, horizonDays: 365,
    deferredCash: deferredCashCalendar(AWARDS, TRANCHES, TODAY, 365),
  });
  const dc = events.filter((e) => e.source === "deferred-cash");
  assert.equal(dc.length, 2);
  assert.ok(dc.every((e) => e.certainty === "scheduled"));
  assert.deepEqual(dc.map((e) => e.amount), [5000, 10000]);
  assert.equal(dc[0].label, "2025 bonus");
});
