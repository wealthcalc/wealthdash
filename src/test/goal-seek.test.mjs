import { test } from "node:test";
import assert from "node:assert/strict";
import { goalSeek, goalSeekAll, planSucceeds, LEVERS } from "../core/goal-seek.mjs";

/* A toy projection with the same monotonicity as the real engine: the pot
   survives when contributions + growth cover spending. Using a model rather
   than buildProjection keeps these tests about the SOLVER — that it finds
   the boundary, respects direction, and refuses to fake an answer. */
const toyProject = (p) => {
  const years = (p.planAge ?? 95) - (p.retireAge ?? 60);
  const accum = (p.retireAge ?? 60) - (p.currentAge ?? 45);
  const pot = (p.startPot ?? 0) * (1 + (p.growthPre ?? 5) / 100) ** accum
    + (p.fixedContrib ?? 0) * accum;
  const need = (p.targetAbsolute ?? 40000) * years;
  return { depletionAge: pot >= need ? null : (p.retireAge ?? 60) + 5 };
};

const BASE = {
  currentAge: 45, retireAge: 60, planAge: 95,
  startPot: 250000, fixedContrib: 0, growthPre: 5, growthPost: 4.5, targetAbsolute: 40000,
};

test("solves for the contribution that makes a failing plan work", () => {
  assert.equal(planSucceeds(toyProject(BASE)), false, "the base plan fails");

  const r = goalSeek({ inputs: BASE, project: toyProject, lever: "contribution" });
  assert.equal(r.reachable, true);
  assert.equal(r.alreadyOk, false);
  assert.equal(r.direction, "increase");
  assert.ok(r.solution > 0);

  // The answer must be the BOUNDARY: it works, and meaningfully less doesn't.
  assert.equal(planSucceeds(toyProject({ ...BASE, fixedContrib: r.solution })), true);
  assert.equal(planSucceeds(toyProject({ ...BASE, fixedContrib: r.solution - LEVERS.contribution.tol * 2 })), false);
});

test("solves a lever where LESS is better — spending", () => {
  const r = goalSeek({ inputs: BASE, project: toyProject, lever: "spend" });
  assert.equal(r.reachable, true);
  assert.equal(r.direction, "decrease", "you'd have to spend less, not more");
  assert.ok(r.solution < BASE.targetAbsolute);
  assert.equal(planSucceeds(toyProject({ ...BASE, targetAbsolute: r.solution })), true);
  assert.equal(planSucceeds(toyProject({ ...BASE, targetAbsolute: r.solution + LEVERS.spend.tol * 2 })), false);
});

test("solves for retirement age and returns a whole year", () => {
  const r = goalSeek({ inputs: BASE, project: toyProject, lever: "retireAge" });
  assert.equal(r.reachable, true);
  assert.equal(r.solution, Math.round(r.solution), "you can't retire on a fraction of a year");
  assert.equal(planSucceeds(toyProject({ ...BASE, retireAge: r.solution })), true);
});

test("solves for the growth the plan is implicitly relying on", () => {
  const r = goalSeek({ inputs: BASE, project: toyProject, lever: "growth" });
  assert.equal(r.reachable, true);
  assert.ok(r.solution > BASE.growthPre, "the base plan needs more than it assumes");
  assert.equal(planSucceeds(toyProject({ ...BASE, growthPre: r.solution })), true);
});

test("an unreachable goal is reported as unreachable, never as the range's edge", () => {
  // Spending so extreme that no contribution inside the search range saves it.
  const hopeless = { ...BASE, targetAbsolute: 5000000 };
  const r = goalSeek({ inputs: hopeless, project: toyProject, lever: "contribution" });
  assert.equal(r.reachable, false);
  assert.equal(r.solution, undefined, "no number that would read as an answer");
  assert.ok(r.triedTo > 0);
  assert.match(r.message, /Not achievable/);
});

test("a plan that already works reports headroom rather than a demand", () => {
  const comfortable = { ...BASE, startPot: 5000000 };
  const r = goalSeek({ inputs: comfortable, project: toyProject, lever: "spend" });
  assert.equal(r.alreadyOk, true, "today's inputs already succeed");
  assert.equal(r.reachable, true);
  assert.ok(r.solution > comfortable.targetAbsolute, "it's how much MORE could be spent");
  assert.equal(r.direction, "increase");
});

test("goalSeekAll offers the alternatives side by side", () => {
  const all = goalSeekAll({ inputs: BASE, project: toyProject });
  assert.equal(all.length, Object.keys(LEVERS).length);
  for (const r of all) {
    assert.ok(r.label && r.unit, "each answer is self-describing");
    assert.ok(typeof r.reachable === "boolean");
  }
  // They're alternatives, not a combination — each solves the goal alone.
  const contrib = all.find((r) => r.lever === "contribution");
  assert.equal(planSucceeds(toyProject({ ...BASE, fixedContrib: contrib.solution })), true);
});

test("a projection that throws is treated as failure, not a crash", () => {
  const exploding = (p) => { if ((p.fixedContrib ?? 0) < 10000) throw new Error("boom"); return { depletionAge: null }; };
  const r = goalSeek({ inputs: BASE, project: exploding, lever: "contribution" });
  assert.equal(r.reachable, true);
  assert.ok(r.solution >= 10000);
});

test("guards its inputs", () => {
  assert.throws(() => goalSeek({ inputs: BASE, project: toyProject, lever: "nonsense" }), /Unknown lever/);
  assert.throws(() => goalSeek({ inputs: BASE }), /project/);
});
