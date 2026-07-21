/* ======================================================================
   SAVINGS RATE — the single most predictive number in accumulation, and
   one this app could always have computed but never did: it knows income
   (Income tab + salary) and now knows spending (Budget tab).

   The definitional trap, stated up front: "savings rate" means at least
   three different things and the differences are large enough to change
   decisions, so this returns ALL of them rather than picking one and
   hoping the user assumes the same definition:

     takeHomeRate  = (take-home − spending) / take-home
        What's left of the money that actually reaches your account. The
        number most people mean, and the one that answers "could I save
        more this month".
     grossRate     = (take-home − spending + all pension contributions)
                     / (gross salary + investment income)
        Includes pension saving (yours AND the employer's) against total
        income before tax. The number that matters for "how fast is
        wealth accumulating", and typically MUCH higher — for a higher-
        rate taxpayer with a decent employer match it can be double the
        take-home rate. Quoting one when you mean the other is how people
        conclude they're doing badly when they aren't.
     netWorthRate  = (take-home − spending + all pension contributions)
                     / (take-home + all pension contributions)
        Saving as a share of the money genuinely available to you.

   Employer pension contributions are counted as SAVING and as INCOME, in
   the definitions where that's coherent. They are compensation, they do
   increase wealth, and excluding them understates accumulation for
   anyone with a match — but they never appear in take-home, so including
   them there would be wrong.

   Investment income is treated as RECEIVED and available: dividends and
   interest that land in an ISA are income even though they never touch a
   current account. If they're reinvested rather than spent, they show up
   as saving, which is correct.

   Tax is computed with the app's own engines (uk-income-tax.mjs) rather
   than a flat assumption, so the take-home figure matches what the Plan
   tab uses. Salary sacrifice vs net-pay vs relief-at-source is NOT
   modelled: employee contributions are simply removed before tax, which
   matches salary sacrifice and net pay, and slightly understates
   take-home under relief at source. Disclosed rather than silently
   assumed.

   Pure and node-tested (savings-rate.test.mjs).
   ====================================================================== */
import { taxRUK, taxScot, employeeNI } from "./uk-income-tax.mjs";

const r2 = (x) => Math.round(x * 100) / 100;
const pct = (num, den) => (den > 0 ? r2((num / den) * 100) : null);

export function savingsRate({
  salary = 0,
  region = "ruk",
  empPct = 0,              // employee pension contribution, % of salary
  erPct = 0,               // employer contribution, % of salary
  annualSpend = 0,         // trailing-12m actual spending (Budget tab)
  investmentIncome = 0,    // trailing-12m dividends + interest received
} = {}) {
  const gross = Math.max(0, +salary || 0);
  const employeePension = gross * (Math.max(0, +empPct || 0) / 100);
  const employerPension = gross * (Math.max(0, +erPct || 0) / 100);
  const taxFn = region === "scotland" ? taxScot : taxRUK;

  // Contributions come out before tax (salary sacrifice / net pay).
  const taxable = Math.max(0, gross - employeePension);
  const tax = taxFn(taxable);
  // NI is NOT reduced by net-pay contributions in reality — only by
  // salary sacrifice. Using the post-contribution figure here would
  // overstate take-home for most people, so NI is charged on FULL salary:
  // the conservative choice, and wrong only for sacrifice arrangements.
  const ni = employeeNI(gross);

  const takeHome = Math.max(0, taxable - tax - ni) + Math.max(0, +investmentIncome || 0);
  const spend = Math.max(0, +annualSpend || 0);
  const savedFromTakeHome = takeHome - spend;
  const totalPension = employeePension + employerPension;
  const totalSaved = savedFromTakeHome + totalPension;
  const grossIncome = gross + employerPension + Math.max(0, +investmentIncome || 0);

  return {
    gross: r2(gross),
    investmentIncome: r2(Math.max(0, +investmentIncome || 0)),
    employeePension: r2(employeePension),
    employerPension: r2(employerPension),
    tax: r2(tax),
    ni: r2(ni),
    takeHome: r2(takeHome),
    spend: r2(spend),
    savedFromTakeHome: r2(savedFromTakeHome),
    totalSaved: r2(totalSaved),
    grossIncome: r2(grossIncome),
    takeHomeRate: pct(savedFromTakeHome, takeHome),
    grossRate: pct(totalSaved, grossIncome),
    netWorthRate: pct(totalSaved, takeHome + totalPension),
    // Spending more than reaches your account isn't automatically a
    // crisis (it can be a one-off funded from savings), but it is always
    // worth naming rather than showing a negative percentage unlabelled.
    overspending: savedFromTakeHome < 0,
  };
}
