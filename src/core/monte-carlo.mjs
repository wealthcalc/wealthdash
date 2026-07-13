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
// Default two-asset parameters (annual, %). Deliberately conservative,
// commonly-cited long-run figures — overridable per call. Correlation is
// mildly positive (post-2000 stock/bond correlation is regime-dependent;
// 0.1 neither banks on the diversification of the 2010s nor the pain of
// 2022).
export const TWO_ASSET_DEFAULTS = {
  equityMean: 6.5, equityVol: 16, bondMean: 3.5, bondVol: 7, correlation: 0.1,
};
export const STOCH_INFL_DEFAULTS = { vol: 1.5, persistence: 0.7 }; // AR(1)

// Bootstrap pairs: (portfolio return %, inflation %) drawn TOGETHER so a
// sampled year keeps its own return/inflation relationship. Sourced from
// the app's existing illustrative historical sequences (core/drawdown.mjs
// HIST — 2008 GFC, 1970s stagflation, 2000s lost decade) rather than a
// fabricated longer series; ~30 real-ish year-pairs including the fat
// left tail. Documented limitation: it's a small pool — this mode tests
// "years like these, reshuffled", not the full sweep of market history.
export function bootstrapPairs(HIST) {
  const pairs = [];
  for (const seq of Object.values(HIST)) {
    for (let i = 0; i < seq.returns.length; i++) {
      pairs.push({ ret: seq.returns[i], infl: seq.infl[i] ?? 2.5 });
    }
  }
  return pairs;
}

export function runMonteCarlo({
  startWealth = 0, accumYears = 0, wealthContribSchedule = [], withdrawSchedule = [],
  growthPre = 0, growthPost = 0, fee = 0, vol = 0, inflation = 0, currentAge = 0,
  runs = 600, seed = null, onProgress = null, progressEvery = 50,
  // --- Phase 2.7 extensions, all optional; defaults reproduce the legacy
  //     single-asset/fixed-inflation engine draw-for-draw. ---
  model = "single",            // "single" | "twoAsset" | "bootstrap"
  twoAsset = {},               // overrides for TWO_ASSET_DEFAULTS
  glidepath = null,            // { start, end } equity % across DECUMULATION
  stochasticInflation = false, // AR(1) inflation around `inflation`
  inflVol = STOCH_INFL_DEFAULTS.vol,
  inflPersistence = STOCH_INFL_DEFAULTS.persistence,
  histPairs = null,            // bootstrap pool; required for model="bootstrap"
} = {}) {
  const decYears = withdrawSchedule.length;
  const totalYears = accumYears + decYears;
  const volPre = vol / 100;
  const volPost = (vol * 0.7) / 100; // assume slightly tamer in drawdown
  const muPre = (growthPre - fee) / 100;
  const muPost = (growthPost - fee) / 100;
  const infl = inflation / 100;
  const rng = seed != null ? mulberry32(seed) : Math.random;

  const ta = { ...TWO_ASSET_DEFAULTS, ...twoAsset };
  const eqMu = ta.equityMean / 100, eqVol = ta.equityVol / 100;
  const bMu = ta.bondMean / 100, bVol = ta.bondVol / 100;
  const rho = Math.max(-1, Math.min(1, ta.correlation));
  const rhoC = Math.sqrt(1 - rho * rho);
  const feeFrac = fee / 100;
  // Equity share: glidepath.start through accumulation, then a straight
  // line to glidepath.end across the decumulation years (derisking
  // through retirement). Both in %, e.g. { start: 60, end: 40 }.
  const eqShareAt = (y) => {
    const gp = glidepath || { start: 60, end: 60 };
    if (y < accumYears || decYears <= 1) return gp.start / 100;
    const f = (y - accumYears) / (decYears - 1);
    return (gp.start + (gp.end - gp.start) * f) / 100;
  };
  const pool = model === "bootstrap" ? (histPairs && histPairs.length ? histPairs : null) : null;
  if (model === "bootstrap" && !pool) throw new Error("bootstrap mode needs histPairs (see bootstrapPairs()).");

  let successes = 0;
  const cols = Array.from({ length: totalYears }, () => []);
  const potAtRetireDist = [];

  for (let r = 0; r < runs; r++) {
    let pot = startWealth;
    let survived = true;
    // Per-run inflation state: cumDet tracks the DETERMINISTIC path the
    // nominal withdrawSchedule was built with; cumSim tracks this run's
    // simulated path. Withdrawals re-scale by cumSim/cumDet, so an
    // inflation shock raises the money the plan actually needs — the
    // mechanism that breaks retirements in the real world.
    let cumDet = 1, cumSim = 1, inflState = infl;
    for (let y = 0; y < totalYears; y++) {
      const real = pot / cumSim;
      cols[y].push(real);

      // This year's return and inflation, by model. Draw order within a
      // year is fixed so seeded runs are reproducible per model.
      let ret, inflY = infl;
      if (model === "bootstrap") {
        const pair = pool[Math.floor(rng() * pool.length)];
        ret = pair.ret / 100 - feeFrac;
        inflY = pair.infl / 100;
      } else if (model === "twoAsset") {
        const z1 = randn(rng), z2 = randn(rng);
        const re = eqMu + eqVol * z1;
        const rb = bMu + bVol * (rho * z1 + rhoC * z2);
        const share = eqShareAt(y);
        ret = share * re + (1 - share) * rb - feeFrac;
        if (stochasticInflation) { inflState = infl + inflPersistence * (inflState - infl) + (inflVol / 100) * randn(rng); inflY = inflState; }
      } else {
        ret = (y < accumYears ? muPre + volPre * randn(rng) : muPost + volPost * randn(rng));
        if (stochasticInflation) { inflState = infl + inflPersistence * (inflState - infl) + (inflVol / 100) * randn(rng); inflY = inflState; }
      }

      if (y < accumYears) {
        pot = pot * (1 + ret) + (wealthContribSchedule[y] || 0);
        if (y === accumYears - 1) potAtRetireDist.push(pot);
      } else {
        const di = y - accumYears;
        const w = (withdrawSchedule[di] || 0) * (cumSim / cumDet);
        pot = (pot - w) * (1 + ret);
        if (pot <= 0 && withdrawSchedule[di] > 0) survived = false;
      }
      cumDet *= 1 + infl;
      cumSim *= 1 + inflY;
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
