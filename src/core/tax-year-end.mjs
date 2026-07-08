/* ======================================================================
   TAX-YEAR-END MODE (Phase 2, step 7b).

   A single orchestrating function over allowances/CGT engines that already
   exist (core/allowances.mjs, core/uk-tax.mjs) — nothing here computes a
   NEW tax rule, it just asks "how much of each use-it-or-lose-it allowance
   is still unused this tax year" and turns the answers into a prioritised
   checklist of raw data (id, £ amount, which tab to jump to). Formatting
   and wording live in the UI layer, same convention as every other core
   module in this app — this stays pure data.

   "Use it or lose it" allowances covered:
     - ISA/LISA subscription headroom (doesn't carry forward at all)
     - CGT annual exempt amount (AEA) — harvestable gains this year
     - Dividend allowance / Personal Savings Allowance
     - Pension annual allowance carry-forward — specifically the OLDEST of
       the three carried-forward years, since that year's unused amount
       permanently drops out of reach once the current tax year closes
       (carry-forward only reaches back three years).

   Pure and React-free; runs under node --test (see tax-year-end.test.mjs).
   ====================================================================== */

import { ukTaxYear } from "./cgt-engine.mjs";
import { aeaForYear, investmentIncomeTax } from "./uk-tax.mjs";
import { ISA_LIMIT, isaSubscriptionsByYear, pensionAllowanceStatus, realisedForYear } from "./allowances.mjs";

const DAY_MS = 86400000;

// Days remaining until this tax year's 5 April end (0 on/after the day itself).
export function daysToTaxYearEnd(todayISO) {
  const [y, m, d] = todayISO.split("-").map(Number);
  const endYear = (m > 4 || (m === 4 && d > 5)) ? y + 1 : y;
  const end = Date.UTC(endYear, 3, 5);
  const now = Date.UTC(y, m - 1, d);
  return Math.max(0, Math.round((end - now) / DAY_MS));
}

const round2 = (x) => Math.round(x * 100) / 100;

export function taxYearEndChecklist({
  txns = [], pensionCashflows = [], incomeEntries = [], eriTxns = [],
  taxableDisposals = [], income = 0, today, activeWithinDays = 60,
} = {}) {
  if (!today) throw new Error("taxYearEndChecklist requires `today` (ISO date) — pure functions don't read the clock themselves.");
  const year = ukTaxYear(today);
  const daysLeft = daysToTaxYearEnd(today);
  const items = [];

  // --- ISA / LISA ---
  const isaUsed = (isaSubscriptionsByYear(txns)[year] || { total: 0 }).total;
  const isaLeft = Math.max(0, ISA_LIMIT - isaUsed);
  if (isaLeft > 1) items.push({ id: "isa", tab: "allowances", amount: round2(isaLeft) });

  // --- CGT AEA ---
  const aea = aeaForYear(year);
  const realised = realisedForYear(taxableDisposals, year, aea);
  if (realised.aeaLeft > 1) items.push({ id: "aea", tab: "cgt", amount: round2(realised.aeaLeft) });

  // --- Dividend allowance / PSA (GIA-taxable income only, this year) ---
  let dividends = 0, interest = 0;
  for (const e of incomeEntries) {
    if (!e || !e.date || !e.amount || ukTaxYear(e.date) !== year) continue;
    if ((e.wrapper || "GIA") !== "GIA") continue;
    if (e.kind === "interest") interest += +e.amount; else dividends += +e.amount;
  }
  for (const t of eriTxns) {
    if (!t || !t.date || ukTaxYear(t.date) !== year) continue;
    if (t._eri?.treatment === "interest") interest += t._gbp || 0; else dividends += t._gbp || 0;
  }
  const incomeTax = investmentIncomeTax({ salary: income, interest, dividends, year });
  const divLeft = Math.max(0, incomeTax.divAllow - dividends);
  if (divLeft > 1) items.push({ id: "dividend-allowance", tab: "income", amount: round2(divLeft) });
  const psaLeft = Math.max(0, incomeTax.psa - interest);
  if (psaLeft > 1 && incomeTax.psa > 0) items.push({ id: "psa", tab: "income", amount: round2(psaLeft) });

  // --- Pension annual allowance carry-forward: the OLDEST carried year ---
  const pension = pensionAllowanceStatus({ cashflows: pensionCashflows, year, adjustedIncome: income });
  const oldest = pension.carry[0]; // earliest-first, per pensionAllowanceStatus
  if (oldest && oldest.unused > 1) {
    items.push({ id: "pension-carry-forward", tab: "allowances", amount: round2(oldest.unused), expiringYear: oldest.year });
  }

  items.sort((a, b) => b.amount - a.amount);
  return { year, daysLeft, active: daysLeft <= activeWithinDays, items };
}
