/* ======================================================================
   ROLLING SEQUENCE-RISK STRESS TEST — pure and node-tested
   (sequence-risk.test.mjs).

   `drawdown.mjs`'s `replayDecum(p, det, key, offset)` already replays ONE
   historical return/inflation sequence starting `offset` years into
   retirement, normalised so its geometric-mean return/inflation matches
   the user's own assumptions (so the only thing that differs from the
   base plan is the ORDER returns arrive in — pure sequence risk). The
   Plan tab's "Historical replay" UI exposes exactly one (sequence, offset)
   pair at a time, picked from a small fixed menu (3 sequences × 3 offsets
   = 9 combinations) — useful for "show me 2008 specifically", but no
   aggregate view of "how exposed is this plan to sequence risk overall".

   This module runs EVERY valid offset (0 through the sequence's own
   length - 1 — i.e. every possible point within the historical decade at
   which retirement's bad-sequence risk could have started) across all
   three built-in sequences, and aggregates: how many of those historical
   entry points depleted the plan before `planAge`, and how bad the worst
   case was. It reuses `replayDecum`/`HIST` directly rather than
   reinventing sequence replay — this is purely an aggregation layer over
   an existing, tested primitive.
   ====================================================================== */

import { HIST, replayDecum } from "./drawdown.mjs";

// Runs every (sequence, offset) combination across the three built-in
// historical sequences and returns per-sequence and overall summaries.
// `det` must be a `buildProjection()` result (needs `.withdrawSchedule`,
// `.wealthAtRetire`); `p` needs `.retireAge`, `.planAge`, `.growthPost`,
// `.fee`, `.inflation`/`.inflMode`/`.rpiWedge`.
export function rollingStressTest(p, det) {
  const bySequence = {};
  const all = [];
  for (const [key, h] of Object.entries(HIST)) {
    const n = h.returns.length;
    const runs = [];
    for (let offset = 0; offset < n; offset++) {
      const { depletion, label } = replayDecum(p, det, key, offset);
      const survived = depletion === null;
      const run = { key, label, offset, depletion, survived };
      runs.push(run);
      all.push(run);
    }
    const survivedCount = runs.filter((r) => r.survived).length;
    const depletions = runs.filter((r) => !r.survived).map((r) => r.depletion);
    bySequence[key] = {
      label: h.label,
      runs,
      survivalRate: survivedCount / runs.length,
      worstDepletion: depletions.length ? Math.min(...depletions) : null,
    };
  }
  const survivedCount = all.filter((r) => r.survived).length;
  const depletions = all.filter((r) => !r.survived).map((r) => r.depletion);
  const worst = depletions.length
    ? all.filter((r) => !r.survived).reduce((m, r) => (r.depletion < m.depletion ? r : m))
    : null;
  return {
    bySequence,
    totalRuns: all.length,
    survivalRate: survivedCount / all.length,
    worstCase: worst, // { key, label, offset, depletion } | null
    worstDepletionAge: depletions.length ? Math.min(...depletions) : null,
  };
}
