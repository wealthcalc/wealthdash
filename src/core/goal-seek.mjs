/* ======================================================================
   GOAL-SEEK — the plan, run backwards.

   Everything else in the planner runs forwards: given your inputs, here is
   the outcome. But the question people actually arrive with is the inverse —
   "I want to retire at 58; what would have to be true?" Answering that by
   hand means dragging a slider, re-reading the depletion age, and repeating,
   which is both tedious and easy to fool yourself with.

   This solves for ONE input at a time, holding everything else fixed, and
   reports the answer in the units of that input: an extra £X a year of
   contributions, or £Y less annual spending, or the growth rate the plan is
   implicitly relying on.

   Method: bisection on a monotonic pass/fail, not a clever optimiser.
   Bisection is chosen deliberately —
   - The success test ("does the pot last to plan age") is a step function,
     not a smooth curve, so gradient methods have nothing to descend.
   - It cannot diverge, and it terminates in a fixed number of iterations,
     which matters because this runs synchronously in the browser on every
     input change.
   - It only requires the projection to be MONOTONIC in the variable being
     solved (more contributions never hurt; more spending never helps),
     which is true for all four levers here.

   Honesty: if the goal is unreachable within the searched range, that is
   reported as unreachable with the bound that was tried. Returning the
   range's endpoint as though it were a solution would tell someone their
   plan works when it doesn't.
   Pure and node-tested (goal-seek.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;

// The plan succeeds when the pot is never exhausted before plan age.
export const planSucceeds = (proj) => !proj || proj.depletionAge == null;

/* The levers we can solve for. Each says how to apply a candidate value to
   the inputs, and which direction is "more likely to succeed" — bisection
   needs to know which way is up. */
export const LEVERS = {
  contribution: {
    key: "fixedContrib",
    label: "Extra annual contribution",
    unit: "£/yr",
    higherIsBetter: true,
    apply: (p, v) => ({ ...p, fixedContrib: v }),
    lo: 0, hi: 200000, tol: 50,
  },
  spend: {
    key: "targetAbsolute",
    label: "Annual retirement spending",
    unit: "£/yr",
    higherIsBetter: false,       // spending LESS is what makes a plan work
    apply: (p, v) => ({ ...p, targetMode: "absolute", targetAbsolute: v }),
    lo: 0, hi: 300000, tol: 50,
  },
  retireAge: {
    key: "retireAge",
    label: "Retirement age",
    unit: "years",
    higherIsBetter: true,        // working longer helps
    apply: (p, v) => ({ ...p, retireAge: Math.round(v) }),
    lo: 40, hi: 75, tol: 1,
  },
  growth: {
    key: "growthPre",
    label: "Required investment growth",
    unit: "%/yr",
    higherIsBetter: true,
    // Solving for growth means the RETURN THE PLAN DEPENDS ON — moving pre-
    // and post-retirement together, since a plan that needs 9% before and
    // 4% after isn't a coherent assumption.
    apply: (p, v) => ({ ...p, growthPre: v, growthPost: Math.max(0, v - (p.growthPre - p.growthPost)) }),
    lo: 0, hi: 20, tol: 0.05,
  },
};

/* Solve for `lever` such that the plan succeeds.

   `project` is buildProjection (injected so this module stays free of the
   drawdown engine and its own tests can use a toy model).
   `succeeds` lets a caller define success differently — e.g. "leaves an
   estate of at least £X" rather than merely "doesn't run out". */
export function goalSeek({
  inputs, project, lever = "contribution", succeeds = planSucceeds, maxIter = 40,
} = {}) {
  const L = LEVERS[lever];
  if (!L) throw new Error(`Unknown lever "${lever}".`);
  if (typeof project !== "function") throw new Error("goalSeek requires a `project` function.");

  const test = (v) => {
    try { return !!succeeds(project(L.apply(inputs, v))); }
    catch { return false; }
  };

  const current = inputs?.[L.key];
  const alreadyOk = test(current ?? (L.higherIsBetter ? L.lo : L.hi));

  // Orientation: `good` is the end of the range known to succeed, `bad` the
  // end known to fail. Bisection then closes the gap between them.
  let good = L.higherIsBetter ? L.hi : L.lo;
  let bad = L.higherIsBetter ? L.lo : L.hi;

  if (!test(good)) {
    // Even the most favourable value in range doesn't rescue the plan. Say
    // so — returning `good` would read as "this is what you need", and it
    // isn't enough.
    return {
      lever, label: L.label, unit: L.unit, reachable: false,
      triedTo: r2(good), current: current != null ? r2(current) : null,
      alreadyOk,
      message: `Not achievable by ${L.label.toLowerCase()} alone, even at ${L.unit === "£/yr" ? `£${Math.round(good).toLocaleString("en-GB")}` : `${good}${L.unit === "%/yr" ? "%" : ""}`}.`,
    };
  }

  for (let i = 0; i < maxIter && Math.abs(good - bad) > L.tol; i++) {
    const mid = (good + bad) / 2;
    if (test(mid)) good = mid; else bad = mid;
  }

  // `good` is the answer: the least favourable value that still works. (For
  // an age, round UP to a whole year — you can't retire on a fraction.)
  const solution = L.tol >= 1 ? Math.ceil(good) : r2(good);
  const delta = current != null ? r2(solution - current) : null;

  return {
    lever, label: L.label, unit: L.unit,
    reachable: true,
    solution,
    current: current != null ? r2(current) : null,
    delta,
    // Whether today's inputs ALREADY work — in which case the solution is
    // the headroom available, not a demand.
    alreadyOk,
    direction: delta == null ? null : delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged",
  };
}

/* Solve every lever at once — "here are all the ways to get there", which is
   more useful than a single answer because the levers are alternatives, not
   a combination. Each figure assumes the OTHERS stay as they are. */
export function goalSeekAll({ inputs, project, levers = Object.keys(LEVERS), succeeds = planSucceeds } = {}) {
  return levers.map((lever) => goalSeek({ inputs, project, lever, succeeds }));
}
