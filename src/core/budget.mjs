/* ======================================================================
   BUDGET — planned spending per category vs what actually left the
   account, on a monthly and annual basis.

   The category model has TWO shapes, because household spending has two
   shapes and forcing one into the other is what makes most budget tools
   feel wrong:

   - MONTHLY categories (groceries, transport, utilities): a £/month
     limit. The natural comparison is this month's actual vs that limit.
   - ANNUAL-ONLY categories (car insurance, TV licence, that one holiday):
     a £/year limit for costs that land in one or two months. Dividing
     them by 12 would show a phantom overspend in the month they hit and
     phantom headroom in the other eleven, so they are EXCLUDED from the
     monthly view's limits entirely and reconciled over the year. Their
     actual spend still appears in the month it happened — it's the LIMIT
     that doesn't get spread, not the money.

   Each category also carries `essential` (needs vs wants). That flag is
   what lets trailing actuals feed the retirement plan: total spend sets
   the Run-off/Plan annual figure, and the essential share sets the income
   floor's essential percentage — two numbers previously guessed at.

   Sign convention: spend transactions are stored POSITIVE (a £42 grocery
   shop is 42). Refunds and credits are NEGATIVE, so they net off the
   category they came from — a returned jumper should reduce Clothing, not
   appear as income. Statement parsers are responsible for normalising
   into this convention (core/statement-import.mjs).

   Transfers and card payments are NOT spending: paying the Amex from the
   HSBC current account is one pound of spend, not two, and would be
   double-counted if both statements are imported. Categories flagged
   `transfer: true` are excluded from every total here.

   Pure and node-tested (budget.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;
const monthOf = (iso) => (iso || "").slice(0, 7);

// Months from `fromMonth` to `toMonth` inclusive, as "YYYY-MM".
export function monthRange(fromMonth, toMonth) {
  const out = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}

// The 12 months ending with `month` (inclusive) — the trailing-year window.
export function trailing12(month) {
  const [y, m] = month.split("-").map(Number);
  const startM = m === 12 ? 1 : m + 1;
  const startY = m === 12 ? y : y - 1;
  return monthRange(`${startY}-${String(startM).padStart(2, "0")}`, month);
}

// categories: [{ id, name, monthly, annual, essential, transfer }]
//   monthly — £/month limit (annual-only categories leave it 0/undefined)
//   annual  — £/yr limit for annual-only categories
// txns: [{ id, date, description, amount, categoryId, account }]
//
// Returns the month view: per-category actual vs limit, with variance.
export function monthlyBudget({ categories = [], txns = [], month } = {}) {
  if (!month) throw new Error("monthlyBudget requires a month (YYYY-MM) — pure functions don't read the clock.");
  const spend = new Map();
  let uncategorised = 0, transfers = 0;
  for (const t of txns) {
    if (!t || monthOf(t.date) !== month) continue;
    const amt = +t.amount || 0;
    if (!t.categoryId) { uncategorised += amt; continue; }
    spend.set(t.categoryId, (spend.get(t.categoryId) || 0) + amt);
  }

  const rows = [];
  let totalActual = 0, totalLimit = 0, essentialActual = 0;
  for (const c of categories) {
    const actual = spend.get(c.id) || 0;
    if (c.transfer) { transfers += actual; continue; }
    // Annual-only categories have no monthly limit to compare against —
    // `limit: null` tells the UI to render a dash, not "£0 budget,
    // £340 spent, 100% over".
    const limit = c.annual > 0 && !(c.monthly > 0) ? null : (+c.monthly || 0);
    rows.push({
      id: c.id, name: c.name, essential: !!c.essential, annualOnly: limit === null,
      actual: r2(actual), limit: limit === null ? null : r2(limit),
      variance: limit === null ? null : r2(limit - actual),
      pctUsed: limit ? r2((actual / limit) * 100) : null,
      over: limit != null && actual > limit,
    });
    totalActual += actual;
    if (limit != null) totalLimit += limit;
    if (c.essential) essentialActual += actual;
  }
  rows.sort((a, b) => b.actual - a.actual);
  return {
    month, rows,
    summary: {
      totalActual: r2(totalActual), totalLimit: r2(totalLimit),
      variance: r2(totalLimit - totalActual),
      essentialActual: r2(essentialActual),
      discretionaryActual: r2(totalActual - essentialActual),
      uncategorised: r2(uncategorised),
      transfers: r2(transfers),
      overCount: rows.filter((r) => r.over).length,
    },
  };
}

// Annual view over `months` (default: the 12 ending at `month`). Monthly
// categories are compared against limit × months-in-window; annual-only
// against their annual figure directly.
export function annualBudget({ categories = [], txns = [], month, months = null } = {}) {
  if (!month && !months) throw new Error("annualBudget requires month or months.");
  const window = months || trailing12(month);
  const inWindow = new Set(window);
  const spend = new Map();
  let uncategorised = 0, transfers = 0;
  for (const t of txns) {
    if (!t || !inWindow.has(monthOf(t.date))) continue;
    const amt = +t.amount || 0;
    if (!t.categoryId) { uncategorised += amt; continue; }
    spend.set(t.categoryId, (spend.get(t.categoryId) || 0) + amt);
  }

  const rows = [];
  let totalActual = 0, totalLimit = 0, essentialActual = 0, essentialLimit = 0;
  for (const c of categories) {
    const actual = spend.get(c.id) || 0;
    if (c.transfer) { transfers += actual; continue; }
    const limit = c.annual > 0 && !(c.monthly > 0)
      ? +c.annual
      : (+c.monthly || 0) * window.length;
    rows.push({
      id: c.id, name: c.name, essential: !!c.essential,
      annualOnly: c.annual > 0 && !(c.monthly > 0),
      actual: r2(actual), limit: r2(limit), variance: r2(limit - actual),
      pctUsed: limit ? r2((actual / limit) * 100) : null,
      over: actual > limit,
    });
    totalActual += actual; totalLimit += limit;
    if (c.essential) { essentialActual += actual; essentialLimit += limit; }
  }
  rows.sort((a, b) => b.actual - a.actual);
  return {
    months: window, rows,
    summary: {
      totalActual: r2(totalActual), totalLimit: r2(totalLimit),
      variance: r2(totalLimit - totalActual),
      essentialActual: r2(essentialActual), essentialLimit: r2(essentialLimit),
      discretionaryActual: r2(totalActual - essentialActual),
      // The share the income floor cares about. Computed from ACTUALS
      // (what you really spend), not limits (what you hoped to).
      essentialPct: totalActual > 0 ? r2((essentialActual / totalActual) * 100) : null,
      uncategorised: r2(uncategorised),
      transfers: r2(transfers),
      monthsCovered: window.length,
    },
  };
}

// Per-month totals across a window — the spend trend chart's data, with
// the budget line to compare against.
//
// `spreadAnnual` chooses between the two honest ways to read a lumpy year,
// and the caller must pick one deliberately because they answer different
// questions:
//   false (CASH VIEW, the default) — money is shown in the month it
//     actually left. True to your bank balance; the £900 insurance month
//     towers over the others. `limit` is monthly categories only, since
//     spreading a limit the spending didn't follow would invent an
//     overspend in that month and phantom headroom in the rest.
//   true (SMOOTHED VIEW) — annual-only categories are averaged across the
//     window, so the underlying run-rate is legible. `limit` then ALSO
//     includes annual budgets ÷ months, because comparing smoothed
//     spending against unsmoothed limits is the exact inconsistency the
//     cash view avoids.
// Either way `annualOnlyActual` is broken out so a spike (or the absence
// of one) is explainable rather than looking like an overspend.
export function spendByMonth({ categories = [], txns = [], months = [], spreadAnnual = false } = {}) {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const isAnnualOnly = (c) => c.annual > 0 && !(c.monthly > 0);
  const n = Math.max(1, months.length);
  const monthlyLimit = categories.reduce(
    (s, c) => s + (c.transfer || isAnnualOnly(c) ? 0 : (+c.monthly || 0)), 0
  );
  const annualLimitPerMonth = spreadAnnual
    ? categories.reduce((s, c) => s + (!c.transfer && isAnnualOnly(c) ? (+c.annual || 0) / 12 : 0), 0)
    : 0;
  const limit = r2(monthlyLimit + annualLimitPerMonth);

  const map = new Map(months.map((m) => [m, { month: m, actual: 0, essential: 0, discretionary: 0, annualOnlyActual: 0, uncategorised: 0, limit }]));
  // Annual-only spend is held back when smoothing, then redistributed.
  let annualEssential = 0, annualDiscretionary = 0;
  for (const t of txns) {
    const row = map.get(monthOf(t?.date));
    if (!row) continue;
    const amt = +t.amount || 0;
    const c = t.categoryId ? byId.get(t.categoryId) : null;
    if (!c) { row.uncategorised += amt; continue; }
    if (c.transfer) continue;
    const annualOnly = isAnnualOnly(c);
    if (annualOnly && spreadAnnual) {
      if (c.essential) annualEssential += amt; else annualDiscretionary += amt;
      continue;
    }
    row.actual += amt;
    if (c.essential) row.essential += amt; else row.discretionary += amt;
    if (annualOnly) row.annualOnlyActual += amt;
  }
  if (spreadAnnual && (annualEssential || annualDiscretionary)) {
    const e = annualEssential / n, d = annualDiscretionary / n;
    for (const row of map.values()) {
      row.essential += e; row.discretionary += d;
      row.actual += e + d;
      row.annualOnlyActual += e + d;
    }
  }
  return [...map.values()].map((r) => ({
    ...r,
    actual: r2(r.actual), essential: r2(r.essential), discretionary: r2(r.discretionary),
    annualOnlyActual: r2(r.annualOnlyActual), uncategorised: r2(r.uncategorised),
  }));
}

// What the Plan/Run-off tabs consume: trailing-12m actual spend and the
// essential share, plus the data-quality caveats that decide whether the
// prefill should be offered at all. Deliberately returns `ready: false`
// with a reason rather than a confident number the user shouldn't trust —
// a plan built on two months of half-categorised data is worse than one
// built on an honest guess.
export function planSpendFromBudget({ categories = [], txns = [], month } = {}) {
  const a = annualBudget({ categories, txns, month });
  const window = trailing12(month);
  const monthsWithData = new Set(
    txns.filter((t) => window.includes(monthOf(t?.date))).map((t) => monthOf(t.date))
  ).size;
  const uncatPct = a.summary.totalActual + a.summary.uncategorised > 0
    ? (a.summary.uncategorised / (a.summary.totalActual + a.summary.uncategorised)) * 100
    : 0;
  const reasons = [];
  if (monthsWithData < 6) reasons.push(`only ${monthsWithData} month(s) of spending data — needs 6+ to be representative`);
  if (uncatPct > 10) reasons.push(`${Math.round(uncatPct)}% of spend is uncategorised`);
  return {
    annualSpend: a.summary.totalActual,
    essentialPct: a.summary.essentialPct,
    monthsWithData,
    uncategorisedPct: r2(uncatPct),
    ready: reasons.length === 0 && a.summary.totalActual > 0,
    reasons,
  };
}
