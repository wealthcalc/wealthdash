/* ======================================================================
   GUYTON-KLINGER DYNAMIC WITHDRAWAL SIMULATOR — pure and node-tested
   (guyton-klinger.test.mjs).

   The deterministic projection (`drawdown.mjs`'s `buildProjection()`) and
   the SWR solver (`swr.mjs`) both hold spending on a fixed, performance-
   blind path: `buildProjection()` follows a static age-based multiplier
   (`spendMult()`), and SWR's withdrawal grows with inflation no matter
   what the portfolio just did. Guyton-Klinger (Jonathan Guyton & William
   Klinger, 2006) is the classic alternative: an initial withdrawal RATE,
   then three "decision rules" applied every subsequent year based on how
   the CURRENT withdrawal rate (this year's planned £ draw / portfolio
   value) sits relative to guardrails around the initial rate:

     1. Capital preservation rule — if the current rate has drifted more
        than `guardrailPct` ABOVE the initial rate (the portfolio's fallen
        relative to spending), cut the withdrawal by `cutPct`.
     2. Prosperity rule — if the current rate has drifted more than
        `guardrailPct` BELOW the initial rate (the portfolio's grown),
        raise the withdrawal by `raisePct`.
     3. Inflation rule — skip that year's inflation uprate if the
        portfolio's TOTAL RETURN was negative the prior year (a real-terms
        pay freeze after a bad year, rather than compounding a spending cut
        with market losses).

   Simplification, stated plainly: the real Guyton-Klinger method has a
   fourth rule (portfolio management — reallocating between asset classes
   after large moves) which this app doesn't model (no dynamic asset
   allocation anywhere in the projection engine), and the two guardrail
   rules are conventionally NOT applied in the final `freezeLastYears` of
   retirement (avoids repeated whipsaw cuts/raises when there's little time
   left to recover) — implemented here as a straightforward cutoff.

   Like `swr.mjs`, this reuses the Monte Carlo primitives (`mulberry32`,
   `randn`) from `monte-carlo.mjs` rather than inventing a second random
   model, and accepts a `seed` so `runGuytonKlinger` and a fixed-withdrawal
   baseline (see `compareToFixed`) can be run on the SAME random paths —
   common random numbers, so a success-rate delta reflects the withdrawal
   RULE, not which paths happened to be drawn.
   ====================================================================== */

import { mulberry32, randn } from "./monte-carlo.mjs";

function percentile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[idx];
}

// One Guyton-Klinger path. `draws` is a pre-generated array of standard
// normal samples, one per year — letting the caller supply IDENTICAL
// draws to both a GK run and a fixed-withdrawal comparison run.
function simulateGKPath({
  startWealth, years, initialRate, growthPost, vol, inflation,
  guardrailPct, cutPct, raisePct, freezeLastYears, draws,
}) {
  const mu = growthPost / 100, sigma = vol / 100, infl = inflation / 100;
  const upper = initialRate * (1 + guardrailPct);
  const lower = initialRate * (1 - guardrailPct);
  let pot = startWealth;
  let withdrawal = startWealth * initialRate;
  let prevReturn = 0;
  let cuts = 0, raises = 0, freezes = 0;
  let survived = true;
  const incomeReal = [];
  let cumInfl = 1;
  for (let y = 0; y < years; y++) {
    if (y > 0) {
      if (prevReturn < 0) {
        freezes++; // inflation rule: no real-terms raise after a losing year
      } else {
        withdrawal *= 1 + infl;
      }
      const frozen = y >= years - freezeLastYears;
      if (!frozen) {
        const curRate = pot > 0 ? withdrawal / pot : Infinity;
        if (curRate > upper) { withdrawal *= 1 - cutPct; cuts++; }
        else if (curRate < lower) { withdrawal *= 1 + raisePct; raises++; }
      }
    }
    cumInfl *= y === 0 ? 1 : 1 + infl;
    incomeReal.push(withdrawal / cumInfl);
    pot -= withdrawal;
    if (pot <= 0) { survived = false; pot = 0; }
    const ret = mu + sigma * draws[y];
    prevReturn = ret;
    pot = pot * (1 + ret);
  }
  return { survived, finalWealth: pot, cuts, raises, freezes, incomeReal };
}

// One fixed-real-withdrawal path (no guardrails) — the baseline GK is
// conventionally compared against, on the SAME draws.
function simulateFixedPath({ startWealth, years, initialRate, growthPost, vol, inflation, draws }) {
  const mu = growthPost / 100, sigma = vol / 100, infl = inflation / 100;
  let pot = startWealth;
  let survived = true;
  for (let y = 0; y < years; y++) {
    const withdrawal = startWealth * initialRate * Math.pow(1 + infl, y);
    pot -= withdrawal;
    if (pot <= 0) { survived = false; pot = 0; break; }
    const ret = mu + sigma * draws[y];
    pot = pot * (1 + ret);
  }
  return { survived };
}

export function runGuytonKlinger({
  startWealth = 0, years = 30, initialRate = 0.05,
  growthPost = 0, vol = 0, inflation = 0,
  guardrailPct = 0.20, cutPct = 0.10, raisePct = 0.10, freezeLastYears = 15,
  runs = 400, seed = null,
} = {}) {
  const rng = seed != null ? mulberry32(seed) : Math.random;
  let gkSuccesses = 0, fixedSuccesses = 0;
  let totalCuts = 0, totalRaises = 0;
  const incomeCols = Array.from({ length: years }, () => []);
  const finalWealths = [];

  for (let r = 0; r < runs; r++) {
    const draws = Array.from({ length: years }, () => randn(rng));
    const gk = simulateGKPath({ startWealth, years, initialRate, growthPost, vol, inflation, guardrailPct, cutPct, raisePct, freezeLastYears, draws });
    const fixed = simulateFixedPath({ startWealth, years, initialRate, growthPost, vol, inflation, draws });
    if (gk.survived) gkSuccesses++;
    if (fixed.survived) fixedSuccesses++;
    totalCuts += gk.cuts;
    totalRaises += gk.raises;
    finalWealths.push(gk.finalWealth);
    gk.incomeReal.forEach((v, y) => incomeCols[y].push(v));
  }

  const incomeFan = incomeCols.map((c, y) => ({
    year: y,
    p10: percentile(c, 0.1), p50: percentile(c, 0.5), p90: percentile(c, 0.9),
  }));
  finalWealths.sort((a, b) => a - b);

  return {
    successRate: gkSuccesses / runs,
    fixedSuccessRate: fixedSuccesses / runs,
    successDelta: gkSuccesses / runs - fixedSuccesses / runs,
    avgCutsPerPath: totalCuts / runs,
    avgRaisesPerPath: totalRaises / runs,
    initialAnnualAmount: startWealth * initialRate,
    incomeFan,
    medianFinalWealth: percentile(finalWealths, 0.5),
    runs,
  };
}
