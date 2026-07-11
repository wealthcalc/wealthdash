/* ======================================================================
   CREDIT CARDS (Wealth tab) — named revolving-debt balances, subtracted
   from net worth. Deliberately its own small concern rather than folded
   into core/property.mjs's "Other liabilities" (a car loan or a personal
   guarantee reads as a property-adjacent debt; a credit card balance is a
   day-to-day, no-collateral thing most people think of on the Wealth tab
   alongside cash — same reasoning as cash accounts living there rather
   than on Property). Record shape: { id, label, issuer, balance, notes }.
   No rate/APR modelling — same "store what was entered, don't project"
   principle as core/property.mjs's mortgages (no amortisation schedule).
   Pure and React-free; runs under node --test.
   ====================================================================== */
export function totalCreditCardDebt(cards = []) {
  return cards.reduce((s, c) => s + Math.max(0, +c.balance || 0), 0);
}
