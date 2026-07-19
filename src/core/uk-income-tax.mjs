/* ======================================================================
   UK INCOME TAX ENGINE — 2025/26 bands. Pure and node-tested
   (uk-income-tax.test.mjs).

   Extracted out of PlanTab.jsx (where it lived as component-local
   functions, untested and unreachable from anywhere else) so the Phase 3
   "Drawdown strategy simulator" work has a real, importable, tested tax
   layer rather than logic embedded in a 2000-line React file. Behaviour
   is unchanged — this is a straight move, not a rewrite.

   This is a DIFFERENT, simpler engine than core/uk-tax.mjs's
   `investmentIncomeTax()`, which is about salary + interest + dividends
   stacking with PSA/dividend-allowance rules for the real Income tab.
   This module is "give me a single total-income figure (already net of
   whatever composition), tell me the tax" — the shape the retirement
   projection needs, where salary/pension/state-pension/DB/annuity/rental
   income all just get summed into one taxable total per year. Rather
   than force a false unification, both stay separate and honest about
   what they model.

   `f` (a "band-uprating factor") appears throughout: 1 = today's 2025/26
   thresholds, >1 = thresholds inflated for a future projection year. All
   the England/Wales/NI and Scottish bands below are frozen in *today's*
   money; multiplying by `f` is how the projection engine keeps "tax as a
   fraction of income" roughly constant in real terms across a 40-year
   plan instead of static thresholds silently pushing everyone into
   higher bands as nominal income rises with inflation.
   ====================================================================== */

export const PA_BASE = 12570;
export const PA_TAPER_FROM = 100000;

export function personalAllowance(income, f = 1) {
  const base = PA_BASE * f,
    from = PA_TAPER_FROM * f;
  if (income <= from) return base;
  return Math.max(0, base - (income - from) / 2);
}

// England / Wales / NI: band widths on TAXABLE income
export function taxRUK(income, f = 1) {
  if (income <= 0) return 0;
  const pa = personalAllowance(income, f);
  const taxable = Math.max(0, income - pa);
  const b20 = 37700 * f;
  const b40 = 125140 * f;
  let tax = 0;
  tax += Math.min(taxable, b20) * 0.2;
  tax += Math.max(0, Math.min(taxable, b40) - b20) * 0.4;
  tax += Math.max(0, taxable - b40) * 0.45;
  return tax;
}

// Scotland 2025/26
export function taxScot(income, f = 1) {
  if (income <= 0) return 0;
  const pa = personalAllowance(income, f);
  const taxable = Math.max(0, income - pa);
  const bands = [
    [2827, 0.19],
    [12093 - 2827, 0.2],
    [31092 - 12093, 0.21],
    [62430 - 31092, 0.42],
    [125140 - 62430, 0.45],
    [Infinity, 0.48],
  ];
  let tax = 0,
    rem = taxable;
  for (const [w, r] of bands) {
    const width = w === Infinity ? Infinity : w * f;
    const slice = Math.min(rem, width);
    if (slice <= 0) break;
    tax += slice * r;
    rem -= slice;
  }
  return tax;
}

// higher-rate threshold (total income) for the basic-rate-ceiling rule
export const HR_THRESHOLD = 50270;

export function employeeNI(salary) {
  const pt = 12570,
    uel = 50270;
  let ni = 0;
  ni += Math.max(0, Math.min(salary, uel) - pt) * 0.08;
  ni += Math.max(0, salary - uel) * 0.02;
  return ni;
}

// Net-of-tax value of EXTRA employment income (RSU vests, deferred-cash
// tranches) received on top of a base salary: marginal income-tax bands
// (including the PA taper the extra income can trigger) plus marginal
// employee NI — not a flat assumed rate. base = 0 models the same income
// arriving after employment ends (still employment income when paid, but
// no salary underneath it).
export function netEmploymentIncome(gross, { base = 0, region } = {}) {
  if (!(gross > 0)) return 0;
  const taxFn = region === "scotland" ? taxScot : taxRUK;
  const tax = taxFn(base + gross) - taxFn(base);
  const ni = employeeNI(base + gross) - employeeNI(base);
  return Math.max(0, gross - tax - ni);
}

// Annual Allowance with high-income taper (standard, non-MPAA case — see
// core/allowances.mjs's mpaaLimitedAA() for the reduced-AA-after-flexible-
// access case, which this function deliberately doesn't know about).
export function annualAllowance(adjustedIncome) {
  if (adjustedIncome <= 260000) return 60000;
  const reduced = 60000 - (adjustedIncome - 260000) / 2;
  return Math.max(10000, reduced);
}

// Solve gross pension drawdown whose INCREMENTAL net (on top of existing
// taxable income) equals the target — i.e. band-filling via bisection
// rather than closed-form band arithmetic, since the "incremental tax on
// the next £1" depends on wherever `otherTaxable` already sits relative
// to the PA taper / band edges. frac = taxable fraction of each
// withdrawal (0.75 under UFPLS, 1.0 once the 25% PCLS has already been
// removed).
export function grossForNetPension(targetIncrNet, otherTaxable, taxFn, f, frac, cap) {
  if (targetIncrNet <= 0 || cap <= 0) return 0;
  const baseTax = taxFn(otherTaxable, f);
  const incr = (g) => g - (taxFn(otherTaxable + g * frac, f) - baseTax);
  if (incr(cap) <= targetIncrNet) return cap;
  let lo = 0,
    hi = cap;
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    if (incr(m) < targetIncrNet) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
