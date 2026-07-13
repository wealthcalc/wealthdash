/* ======================================================================
   DRAWDOWN TAX-OPTIMISER — runs the deterministic projection across every
   withdrawal-ordering strategy × tax-free-cash mode (5 × 2 = 10 combos)
   and quantifies what each choice costs in LIFETIME TAX (today's money,
   `totalTaxReal` from core/drawdown.mjs — income tax + GIA CGT + BTL sale
   CGT, all already computed per year by the engine this reuses verbatim).

   Ranking policy, in order — because "less tax" is worthless if the plan
   fails sooner:
     1. plan survival: lasts to planAge beats depleting; later depletion
        beats earlier;
     2. among equal survival: lower lifetime tax (real);
     3. tie-break: larger final estate (real).
   The headline the UI shows is the SAVING: current combo's lifetime tax
   minus the best combo's — a quantified "switching to X saves £Y over
   the plan" rather than an unexplained recommendation. Deterministic
   engine only (10 runs is instant); Monte Carlo robustness of the chosen
   strategy remains the Monte Carlo tab's job.
   Pure and node-tested (drawdown-optimiser.test.mjs).
   ====================================================================== */
import { buildProjection, STRATEGY, STRATEGY_LABELS } from "./drawdown.mjs";

export const TFC_LABELS = { ufpls: "UFPLS (25% of each withdrawal)", pcls: "PCLS (25% up front)" };

// candidate ordering: survives longer > less lifetime tax > bigger estate
export function compareCandidates(a, b) {
  const aDep = a.depletionAge ?? Infinity, bDep = b.depletionAge ?? Infinity;
  if (aDep !== bDep) return bDep - aDep > 0 ? 1 : -1; // later depletion wins
  if (Math.abs(a.lifetimeTaxReal - b.lifetimeTaxReal) > 0.005) return a.lifetimeTaxReal - b.lifetimeTaxReal;
  return b.estateReal - a.estateReal;
}

export function optimiseDrawdown(p, { tfcModes = ["ufpls", "pcls"], build = buildProjection } = {}) {
  const candidates = [];
  for (const strategy of Object.keys(STRATEGY)) {
    for (const tfcMode of tfcModes) {
      const det = build({ ...p, drawStrategy: strategy, tfcMode });
      candidates.push({
        strategy, tfcMode,
        label: STRATEGY_LABELS[strategy] || strategy,
        lifetimeTaxReal: det.totalTaxReal ?? 0,
        depletionAge: det.depletionAge ?? null,
        estateReal: det.estateReal ?? 0,
        firstYearNet: det.firstYearNet ?? null,
      });
    }
  }
  candidates.sort(compareCandidates);
  const best = candidates[0];
  const currentKey = `${p.drawStrategy || "taxopt"}|${p.tfcMode || "ufpls"}`;
  const current = candidates.find((c) => `${c.strategy}|${c.tfcMode}` === currentKey) || null;
  const taxSaving = current ? current.lifetimeTaxReal - best.lifetimeTaxReal : null;
  return {
    candidates,
    best,
    current,
    // £ of lifetime tax (today's money) the best combo saves vs the
    // current pick; 0 when the current pick IS the best. Can be negative
    // only if the current combo beats "best" on tax while losing on
    // survival — the ranking's whole point, so surface it as-is.
    taxSaving,
    alreadyOptimal: current ? compareCandidates(current, best) <= 0 || (current.strategy === best.strategy && current.tfcMode === best.tfcMode) : false,
  };
}
