/* ======================================================================
   SEQUENCE-RISK HEATMAP — "would this plan have survived retiring in
   1929? In 1966? In every year since 1926?" Replays the plan's own
   withdrawal schedule through every rolling window of REAL history
   (core/market-history.mjs), one window per start year — the FIRECalc
   question, answered with this app's own decumulation numbers.

   Deliberately RAW history, unlike the Scenarios tab's replay (which
   rescales each sequence's mean to your growth assumption to isolate
   ORDER effects): the heatmap's question is historical, so returns are
   used as they were, minus your fee. Withdrawals are re-priced along
   each window's actual inflation (cumSim/cumDet — same mechanism as
   Monte Carlo v2), so 1970s windows hurt through BOTH falling markets
   and the withdrawal schedule inflating faster than planned.

   Windows that run past the end of recorded history fall back to the
   plan's own growth/inflation assumptions for the missing tail and are
   flagged `partial` with the count of historical years used; the summary
   success rate counts FULL windows only.
   Pure and node-tested (sequence-heatmap.test.mjs).
   ====================================================================== */
import { effInflation } from "./drawdown.mjs";
import { historyPairs } from "./market-history.mjs";

export const MIN_PARTIAL_YEARS = 15; // below this a "window" is mostly assumption — skip it

export function replayWindow(p, det, pairs, startIdx) {
  const gPostNet = (p.growthPost - p.fee) / 100;
  const baseInfl = effInflation(p) / 100;
  const feeFrac = (p.fee || 0) / 100;
  let pot = det.wealthAtRetire;
  let cumDet = 1, cumSim = 1, depletion = null, histYears = 0;
  for (let i = 0; i < det.withdrawSchedule.length; i++) {
    const age = p.retireAge + i;
    const pair = pairs[startIdx + i];
    const ret = pair ? pair.ret / 100 - feeFrac : gPostNet;
    const inflY = pair ? pair.infl / 100 : baseInfl;
    if (pair) histYears++;
    const w = (det.withdrawSchedule[i] || 0) * (cumSim / cumDet);
    pot = (pot - w) * (1 + ret);
    if (pot <= 0 && depletion === null && w > 0) depletion = age;
    pot = Math.max(0, pot);
    cumDet *= 1 + baseInfl;
    cumSim *= 1 + inflY;
  }
  return {
    startYear: pairs[startIdx] ? pairs[startIdx].year : null,
    depletion,
    lasts: depletion === null,
    finalReal: pot / cumSim,
    histYears,
    partial: histYears < det.withdrawSchedule.length,
  };
}

export function sequenceHeatmap(p, det, { pairs = historyPairs() } = {}) {
  const years = det.withdrawSchedule.length;
  if (!years || !(det.wealthAtRetire > 0)) return { windows: [], summary: null };

  const windows = [];
  for (let s = 0; s < pairs.length; s++) {
    const available = pairs.length - s;
    if (available < Math.min(years, MIN_PARTIAL_YEARS)) break;
    windows.push(replayWindow(p, det, pairs, s));
  }

  const full = windows.filter((w) => !w.partial);
  const failures = full.filter((w) => !w.lasts);
  const worst = failures.length
    ? failures.reduce((m, w) => (w.depletion < m.depletion ? w : m), failures[0])
    : null;
  return {
    windows,
    summary: {
      fullWindows: full.length,
      partialWindows: windows.length - full.length,
      successRate: full.length ? (full.length - failures.length) / full.length : null,
      failures: failures.length,
      worstStart: worst ? worst.startYear : null,
      worstDepletionAge: worst ? worst.depletion : null,
      horizonYears: years,
    },
  };
}
