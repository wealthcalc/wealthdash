/* ======================================================================
   CASH ACCOUNTS (Phase 2, build step 2) — named cash accounts (institution,
   rate, rate type, maturity date) layered on top of the existing per-
   wrapper manual cash figure, rather than replacing it. Pure and React-
   free; runs under node --test (see cash.test.mjs).

   Design choice: the pre-existing `cash` state (`{ wrapper: gbpBalance }`,
   edited via CurrencyInput on Wealth/Pension) keeps working completely
   unchanged — it becomes the "unallocated / other cash" bucket, exactly
   the same role the Pension tab's "LISA cash / unallocated" field already
   played before this module existed. `cashAccounts` is additive: a
   wrapper's TRUE cash total for the wealth model is the manual figure
   PLUS the sum of any named accounts under that wrapper — same "own
   array, own setter, derive the total" pattern as pension contribution
   cost-basis reconciliation (core/pension-import.mjs).
   ====================================================================== */

export function cashAccountsByWrapper(cashAccounts = []) {
  const out = {};
  for (const a of cashAccounts) {
    const w = a.wrapper || "GIA";
    out[w] = (out[w] || 0) + (+a.balance || 0);
  }
  return out;
}

// The map to feed into buildWealthModel's `cash` param: manual/unallocated
// figures plus every named account's balance, summed per wrapper.
export function effectiveCashByWrapper(manualCash = {}, cashAccounts = []) {
  const out = { ...manualCash };
  for (const [w, total] of Object.entries(cashAccountsByWrapper(cashAccounts))) {
    out[w] = (+out[w] || 0) + total;
  }
  return out;
}

export function totalCashAccounts(cashAccounts = []) {
  return cashAccounts.reduce((s, a) => s + (+a.balance || 0), 0);
}

// Balance-weighted average rate — the "what am I actually earning on cash"
// headline. Accounts with no rate entered are excluded from both the
// numerator and the weighting denominator (an unknown rate isn't a 0% rate).
export function weightedAverageRate(cashAccounts = []) {
  let weighted = 0, weight = 0;
  for (const a of cashAccounts) {
    if (a.rate == null || a.rate === "" || !Number.isFinite(+a.rate)) continue;
    const bal = +a.balance || 0;
    weighted += bal * (+a.rate);
    weight += bal;
  }
  return weight > 0 ? weighted / weight : null;
}

// Fixed-term accounts maturing soon (or already past maturity, presumably
// rolled to a lower easy-access rate) — the cash-accounts analogue of
// mortgagesEndingSoon (core/property.mjs). `today` is injected (ISO
// string), not read from Date.now(), so this stays pure and testable.
export function accountsMaturingSoon(cashAccounts = [], today, withinDays = 90) {
  const cutoff = new Date(today + "T00:00:00Z");
  cutoff.setUTCDate(cutoff.getUTCDate() + withinDays);
  const cutoffISO = cutoff.toISOString().slice(0, 10);
  return cashAccounts
    .filter((a) => a.rateType === "fixed" && a.maturityDate && a.maturityDate <= cutoffISO)
    .map((a) => ({ ...a, matured: a.maturityDate < today }))
    .sort((a, b) => (a.maturityDate < b.maturityDate ? -1 : 1));
}

// Simple forward interest estimate for the income calendar / projections:
// balance × rate, annualised, per account — a projection (today's rate and
// balance held constant), not a forecast of what will actually happen.
export function estimatedAnnualInterest(cashAccounts = []) {
  return cashAccounts.reduce((s, a) => {
    if (a.rate == null || a.rate === "" || !Number.isFinite(+a.rate)) return s;
    return s + (+a.balance || 0) * (+a.rate / 100);
  }, 0);
}
