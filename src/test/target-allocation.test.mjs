import { test } from "node:test";
import assert from "node:assert/strict";
import { allocationState, planContribution } from "../core/target-allocation.mjs";

const pos = (ticker, marketValue) => ({ ticker, marketValue, priced: true });

const GROUPS = [
  { id: "eq", name: "Global equity", target: 60 },
  { id: "bond", name: "Bonds & gilts", target: 30 },
  { id: "alt", name: "Alternatives", target: 10 },
];
const ASSIGN = { VWRL: "eq", SWDA: "eq", TG31: "bond", GOLD: "alt" };

test("current weights and drift are measured against the target", () => {
  const s = allocationState({
    groups: GROUPS,
    assignments: ASSIGN,
    positions: [pos("VWRL", 70000), pos("TG31", 20000), pos("GOLD", 10000)],
  });
  assert.equal(s.total, 100000);
  const by = Object.fromEntries(s.rows.map((r) => [r.id, r]));
  assert.equal(by.eq.weight, 70);
  assert.equal(by.eq.drift, 10, "10 points over target");
  assert.equal(by.eq.driftValue, 10000, "and £10k over in money terms");
  assert.equal(by.bond.drift, -10);
  assert.equal(by.alt.drift, 0);
  assert.equal(s.targetsValid, true);
});

test("targets that don't total 100% are called out, not quietly rebased", () => {
  const s = allocationState({
    groups: [{ id: "a", name: "A", target: 50 }, { id: "b", name: "B", target: 30 }],
    assignments: { X: "a", Y: "b" },
    positions: [pos("X", 5000), pos("Y", 5000)],
  });
  assert.equal(s.targetSum, 80);
  assert.equal(s.targetsValid, false, "every drift figure would otherwise be measured against the wrong base");
});

test("unassigned holdings are surfaced, not dropped from the denominator", () => {
  const s = allocationState({
    groups: GROUPS, assignments: ASSIGN,
    positions: [pos("VWRL", 60000), pos("MYSTERY", 40000)],
  });
  assert.equal(s.hasUnassigned, true);
  assert.equal(s.total, 100000, "the unassigned holding still counts as wealth");
  const un = s.rows.find((r) => r.unassigned);
  assert.equal(un.value, 40000);
});

test("a contribution is allocated against the POST-contribution portfolio", () => {
  // The subtlety that matters: £20k into an £80k portfolio moves every
  // weight, so allocating against today's weights would overshoot.
  const s = allocationState({
    groups: GROUPS, assignments: ASSIGN,
    positions: [pos("VWRL", 60000), pos("TG31", 15000), pos("GOLD", 5000)],
  });
  const plan = planContribution({ state: s, amount: 20000 });
  assert.equal(plan.totalAfter, 100000);

  // Targets of a £100k portfolio: 60k / 30k / 10k. Equity is already there.
  const by = Object.fromEntries(plan.buys.map((b) => [b.groupId, b.amount]));
  assert.equal(by.eq, undefined, "equity needs nothing — it's already at target");
  assert.equal(by.bond, 15000);
  assert.equal(by.alt, 5000);
  assert.equal(plan.allocated, 20000);

  // And the result actually lands on target.
  const after = Object.fromEntries(plan.after.map((r) => [r.id, r]));
  assert.equal(after.eq.weight, 60);
  assert.equal(after.bond.weight, 30);
  assert.equal(after.alt.weight, 10);
});

test("a contribution too small to fix everything closes the widest gaps proportionally", () => {
  const s = allocationState({
    groups: GROUPS, assignments: ASSIGN,
    positions: [pos("VWRL", 80000), pos("TG31", 5000), pos("GOLD", 5000)],
  });
  const plan = planContribution({ state: s, amount: 10000 });
  assert.equal(plan.allocated <= 10000, true, "never allocates more than was given");
  const bond = plan.buys.find((b) => b.groupId === "bond");
  const alt = plan.buys.find((b) => b.groupId === "alt");
  assert.ok(bond.amount > alt.amount, "bonds are further behind, so they get more");
  assert.ok(!bond.closesGap, "and it's honest that the gap isn't fully closed");
});

test("an overweight a purchase cannot fix is named rather than implied away", () => {
  const s = allocationState({
    groups: GROUPS, assignments: ASSIGN,
    positions: [pos("VWRL", 95000), pos("TG31", 3000), pos("GOLD", 2000)],
  });
  const plan = planContribution({ state: s, amount: 5000 });
  assert.ok(plan.overweight.some((o) => o.id === "eq"), "equity stays over target — only selling fixes that");
});

test("tiny allocations are suppressed so dealing costs don't eat them", () => {
  const s = allocationState({
    groups: GROUPS, assignments: ASSIGN,
    positions: [pos("VWRL", 60000), pos("TG31", 29990), pos("GOLD", 10000)],
  });
  const plan = planContribution({ state: s, amount: 20, minTicket: 100 });
  assert.deepEqual(plan.buys, [], "a £14 purchase isn't worth a trade");
  assert.equal(plan.unallocated, 20);
});

test("buying never sells — the whole point is avoiding a disposal", () => {
  const s = allocationState({
    groups: GROUPS, assignments: ASSIGN,
    positions: [pos("VWRL", 90000), pos("TG31", 5000), pos("GOLD", 5000)],
  });
  const plan = planContribution({ state: s, amount: 10000 });
  assert.ok(plan.buys.every((b) => b.amount > 0), "no negative 'buys' that are really sales");
});

test("no contribution, or no state, degrades safely", () => {
  const s = allocationState({ groups: GROUPS, assignments: ASSIGN, positions: [pos("VWRL", 1000)] });
  assert.deepEqual(planContribution({ state: s, amount: 0 }).buys, []);
  assert.deepEqual(planContribution({ amount: 5000 }).buys, []);
  const empty = allocationState({});
  assert.equal(empty.total, 0);
  assert.deepEqual(empty.rows, []);
});

test("unpriced holdings are counted but kept out of the weights", () => {
  const s = allocationState({
    groups: GROUPS, assignments: ASSIGN,
    positions: [pos("VWRL", 10000), { ticker: "TG31", marketValue: null, priced: false }],
  });
  assert.equal(s.unpricedCount, 1);
  assert.equal(s.total, 10000);
});
