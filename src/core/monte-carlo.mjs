/* ======================================================================
   MONTE CARLO RETIREMENT SIMULATOR — randomised-return stress test for the
   Plan tab's deterministic projection. Extracted out of PlanTab.jsx (where
   it used to live as a same-file `runMonteCarlo()`/`randn()` pair, run
   SYNCHRONOUSLY on the main thread inside a `setTimeout(...,30)` hack just
   to let the "running" spinner paint before blocking) so it can run
   IDENTICALLY inside a Web Worker (workers/monteCarloWorker.js) — the
   whole point being a 1000+-run simulation no longer freezes the UI.
   Pure and React-free; runs under node --test.

   Each run walks year-by-year: during accumulation, the pot grows at a
   randomised return and takes in that year's contribution; during
   drawdown, that year's withdrawal comes out first, then the (tamer,
   post-retirement) randomised return applies. A run "succeeds" if the pot
   never goes negative while a withdrawal was still due. The RNG is
   injectable (mulberry32, seeded) so:
     (a) node tests can assert deterministic output for a fixed seed, and
     (b) runScenarioAB can compare two parameter sets against the SAME
         sequence of random draws ("common random numbers") — the standard
         variance-reduction technique so a success-rate/median-wealth
         DELTA between scenario A and B reflects the parameter change,
         not which random path each side happened to draw.
   ====================================================================== */

// Box-Muller standard normal sample from an injectable uniform RNG
// (defaults to Math.random — non-deterministic, matches the app's
// previous behaviour when no seed is supplied).
export function randn(rng = Math.random) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// mulberry32 — a small, fast, deterministic PRNG. Not cryptographic (no
// need to be); only used to make simulated market paths reproducible.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(arr, q) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1))));
  return s[idx];
}

// One full Monte Carlo simulation. `onProgress(fraction)` fires every
// `progressEvery` runs (and on the last run) — the Web Worker wrapper
// relays this back to the UI as a real progress percentage, unlike the
// old fake `setTimeout` spinner delay.
export function runMonteCarlo({
  startWealth = 0, accumYears = 0, wealthContribSchedule = [], withdrawSchedule = [],
  growthPre = 0, growthPost = 0, fee = 0, vol = 0, inflation = 0, currentAge = 0,
  runs = 600, seed = null, onProgress = null, progressEvery = 50,
} = {}) {
  const decYears = withdrawSchedule.length;
  const totalYears = accumYears + decYears;
  const volPre = vol / 100;
  const volPost = (vol * 0.7) / 100; // assume slightly tamer in drawdown
  const muPre = (growthPre - fee) / 100;
  const muPost = (growthPost - fee) / 100;
  const infl = inflation / 100;
  const rng = seed != null ? mulberry32(seed) : Math.random;

  let successes = 0;
  const cols = Array.from({ length: totalYears }, () => []);
  const potAtRetireDist = [];

  for (let r = 0; r < runs; r++) {
    let pot = startWealth;
    let survived = true;
    for (let y = 0; y < totalYears; y++) {
      const real = pot / Math.pow(1 + infl, y);
      cols[y].push(real);
      if (y < accumYears) {
        const ret = muPre + volPre * randn(rng);
        pot = pot * (1 + ret) + (wealthContribSchedule[y] || 0);
        if (y === accumYears - 1) potAtRetireDist.push(pot);
      } else {
        const di = y - accumYears;
        const ret = muPost + volPost * randn(rng);
        pot = (pot - (withdrawSchedule[di] || 0)) * (1 + ret);
        if (pot <= 0 && withdrawSchedule[di] > 0) survived = false;
      }
    }
    if (survived && pot >= 0) successes++;
    if (onProgress && (r % progressEvery === 0 || r === runs - 1)) onProgress((r + 1) / runs);
  }

  const fan = cols.map((c, i) => ({
    age: currentAge + i,
    p10: Math.max(0, percentile(c, 0.1)),
    p25: Math.max(0, percentile(c, 0.25)),
    p50: Math.max(0, percentile(c, 0.5)),
    p75: Math.max(0, percentile(c, 0.75)),
    p90: Math.max(0, percentile(c, 0.9)),
  }));
  potAtRetireDist.sort((a, b) => a - b);
  return {
    successRate: successes / runs,
    fan,
    medianRetire: percentile(potAtRetireDist, 0.5),
    p10Retire: percentile(potAtRetireDist, 0.1),
    p90Retire: percentile(potAtRetireDist, 0.9),
    runs,
  };
}

// Scenario A/B — runs two input sets through the SAME random seed (common
// random numbers) so the comparison isolates the parameter change. If the
// two scenarios have a different total year count (e.g. a different
// retirement or plan age), the draw sequences necessarily diverge once the
// shorter one ends — still the same "same draws until they can't be" rule
// a shared seed gives you.
export function runScenarioAB(inputsA, inputsB, { seed = 42, runs } = {}) {
  const a = runMonteCarlo({ ...inputsA, seed, ...(runs ? { runs } : {}) });
  const b = runMonteCarlo({ ...inputsB, seed, ...(runs ? { runs } : {}) });
  return {
    a, b,
    successDelta: b.successRate - a.successRate,
    medianRetireDelta: b.medianRetire - a.medianRetire,
  };
}
