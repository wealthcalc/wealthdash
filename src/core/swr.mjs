/* ======================================================================
   SAFE WITHDRAWAL RATE (SWR) SOLVER — pure and node-tested (swr.test.mjs).

   This answers a DIFFERENT question than `monte-carlo.mjs`'s
   `runMonteCarlo()`. That function tells you whether THIS SPECIFIC plan's
   already-computed £-schedule of withdrawals (from `buildProjection()`,
   shaped by the retirement-smile spend profile, state pension, DB income,
   etc) survives under randomised markets. The classic "safe withdrawal
   rate" question (Bengen's 4%, the Trinity Study, cFIREsim) is the inverse:
   given a starting pot and a target confidence, what's the highest FLAT,
   inflation-adjusted annual withdrawal RATE (as a % of the starting pot)
   that survives `years` of retirement at that confidence? It deliberately
   ignores the plan's specific income sources/spend profile — it's a
   portfolio-only, "what would the textbook answer be" sanity check to sit
   alongside the plan-specific Monte Carlo result.

   Implementation: reuses `runMonteCarlo()` directly (rather than a second
   simulation loop) with `accumYears: 0` and a synthetic
   `withdrawSchedule` that grows the FIRST year's withdrawal with the same
   `inflation` assumption every subsequent year (the standard SWR
   definition: real spending held constant) — then binary-searches the
   withdrawal rate for the highest one whose `successRate` still clears
   `targetSuccess`. Success rate is monotonically non-increasing in the
   withdrawal rate (a higher draw can only ever hurt survival odds, never
   help it), so binary search is exact up to `iterations` precision.

   Every trial in the search uses the SAME seed (common random numbers) —
   otherwise sampling noise between trials could make the "monotonically
   decreasing" assumption the binary search relies on flicker near the
   answer.
   ====================================================================== */

import { runMonteCarlo } from "./monte-carlo.mjs";

// Success rate for one candidate withdrawal RATE (fraction of startWealth,
// year 1; grows with `inflation` thereafter — the standard SWR shape).
function successAtRate(rate, { startWealth, years, growthPost, vol, inflation, fee, runs, seed }) {
  const withdrawSchedule = Array.from({ length: years }, (_, i) => startWealth * rate * Math.pow(1 + inflation / 100, i));
  return runMonteCarlo({
    startWealth, accumYears: 0, wealthContribSchedule: [], withdrawSchedule,
    growthPre: growthPost, growthPost, fee, vol, inflation, currentAge: 0, runs, seed,
  }).successRate;
}

// Binary-search the highest withdrawal rate whose Monte Carlo success rate
// is still >= targetSuccess. Returns the rate (fraction, e.g. 0.04) plus
// the achieved success rate at that rate, and the £ amount it implies for
// `startWealth`.
export function solveSWR({
  startWealth = 0, years = 30, growthPost = 0, vol = 0, inflation = 0, fee = 0,
  targetSuccess = 0.9, runs = 400, seed = 7,
  rateLow = 0.005, rateHigh = 0.12, iterations = 22,
} = {}) {
  if (startWealth <= 0 || years <= 0) {
    return { rate: 0, annualAmount: 0, successRate: 1, targetSuccess, runs };
  }
  const ctx = { startWealth, years, growthPost, vol, inflation, fee, runs, seed };
  // If even the lowest rate can't clear the target, that's the honest
  // answer (a very poor market/vol assumption) — return it rather than
  // pretending 0 is "safe" when even trivial spending isn't at 90%+.
  let lo = rateLow, hi = rateHigh;
  const successHi = successAtRate(hi, ctx);
  if (successHi >= targetSuccess) {
    // even the top of the search range clears the bar — the "true" max is
    // outside what we searched; report the range ceiling honestly.
    return { rate: hi, annualAmount: startWealth * hi, successRate: successHi, targetSuccess, runs, atCeiling: true };
  }
  const successLo = successAtRate(lo, ctx);
  if (successLo < targetSuccess) {
    return { rate: lo, annualAmount: startWealth * lo, successRate: successLo, targetSuccess, runs, atFloor: true };
  }
  for (let k = 0; k < iterations; k++) {
    const mid = (lo + hi) / 2;
    const s = successAtRate(mid, ctx);
    if (s >= targetSuccess) lo = mid; else hi = mid;
  }
  const finalRate = lo;
  const finalSuccess = successAtRate(finalRate, ctx);
  return { rate: finalRate, annualAmount: startWealth * finalRate, successRate: finalSuccess, targetSuccess, runs };
}
