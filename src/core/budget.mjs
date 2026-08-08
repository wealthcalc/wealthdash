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

import { categoriseAll, learnMerchants } from "./categorise.mjs";
import { expandRecurring, statementCoverage } from "./recurring.mjs";

const r2 = (x) => Math.round(x * 100) / 100;
const monthOf = (iso) => (iso || "").slice(0, 7);

// THE spend list every consumer must use: imported/manual transactions
// with categories resolved, PLUS recurring commitments expanded into the
// months no statement covers.
//
// This exists because assembling it by hand was duplicated across the
// Budget tab, the Home action queue and the Plan tab — and they diverged:
// Plan omitted recurring commitments, so its "your actual spend is £X"
// prefill silently under-stated every direct debit on an unimported
// account and disagreed with the Budget tab's own total. One function, so
// the three views cannot drift apart again.
export function mergedSpend({ spendTxns = [], rules = [], recurring = [], month } = {}) {
  if (!month) throw new Error("mergedSpend requires a month (YYYY-MM) — pure functions don't read the clock.");
  const year = +month.slice(0, 4);
  return [
    ...categoriseAll(spendTxns, { rules, merchantMap: learnMerchants(spendTxns) }),
    ...expandRecurring({
      definitions: recurring,
      fromDate: `${year - 2}-01-01`,
      toDate: `${year + 1}-12-31`,
      coverage: statementCoverage(spendTxns),
    }).rows,
  ];
}

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
    // Both limits pro-rate to the window length: a monthly limit × the
    // number of months, and an annual-only limit × (months / 12). For a
    // full 12-month window this is the whole annual figure (12/12); for a
    // part-year window like Year-to-date it's the elapsed share, so the
    // budget you're compared against matches the period actually spent —
    // otherwise a 7-month YTD would show a full year's annual budgets and
    // always look under.
    const limit = c.annual > 0 && !(c.monthly > 0)
      ? +c.annual * (window.length / 12)
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

// The distinct months (YYYY-MM) that actually have spend data, up to and
// including `toMonth`. The basis for the "average 12 months" view, which
// normalises across ALL available history rather than just the last 12 —
// so 30 months of data smooth out a one-off expensive year that a plain
// trailing-12m would carry at full weight.
export function dataMonths(txns = [], toMonth) {
  const set = new Set();
  for (const t of txns) {
    if (!t || !t.date) continue;
    const m = monthOf(t.date);
    if (!toMonth || m <= toMonth) set.add(m);
  }
  return [...set].sort();
}

// A representative 12-MONTH view built from the AVERAGE across every month
// with data — the annual figure you'd expect in a typical year, with
// lumpy one-offs diluted by the length of history. Actuals are the total
// over all data-months × 12 / monthsWithData; limits are the true annual
// budget (monthly × 12, or the annual figure). `monthsWithData` is
// surfaced so the UI can say how much history the average rests on — an
// average over 3 months means little, over 30 means a lot.
export function averageAnnualBudget({ categories = [], txns = [], toMonth } = {}) {
  const months = dataMonths(txns, toMonth);
  const n = months.length;
  if (!n) return { rows: [], summary: { monthsWithData: 0, totalActual: 0, totalLimit: 0, variance: 0, essentialActual: 0, discretionaryActual: 0, essentialPct: null, uncategorised: 0, transfers: 0, monthsCovered: 12 } };
  const scale = 12 / n; // total-over-history → representative year
  const inWindow = new Set(months);
  const spend = new Map();
  let uncategorised = 0, transfers = 0;
  for (const t of txns) {
    if (!t || !inWindow.has(monthOf(t.date))) continue;
    const amt = +t.amount || 0;
    if (!t.categoryId) { uncategorised += amt; continue; }
    spend.set(t.categoryId, (spend.get(t.categoryId) || 0) + amt);
  }
  const rows = [];
  let totalActual = 0, totalLimit = 0, essentialActual = 0;
  for (const c of categories) {
    const raw = spend.get(c.id) || 0;
    if (c.transfer) { transfers += raw * scale; continue; }
    const actual = raw * scale;
    const limit = c.annual > 0 && !(c.monthly > 0) ? +c.annual : (+c.monthly || 0) * 12;
    rows.push({
      id: c.id, name: c.name, essential: !!c.essential,
      annualOnly: c.annual > 0 && !(c.monthly > 0),
      actual: r2(actual), limit: r2(limit), variance: r2(limit - actual),
      pctUsed: limit ? r2((actual / limit) * 100) : null,
      over: actual > limit,
    });
    totalActual += actual; totalLimit += limit;
    if (c.essential) essentialActual += actual;
  }
  rows.sort((a, b) => b.actual - a.actual);
  return {
    months, rows,
    summary: {
      monthsWithData: n,
      totalActual: r2(totalActual), totalLimit: r2(totalLimit), variance: r2(totalLimit - totalActual),
      essentialActual: r2(essentialActual), discretionaryActual: r2(totalActual - essentialActual),
      essentialPct: totalActual > 0 ? r2((essentialActual / totalActual) * 100) : null,
      uncategorised: r2(uncategorised * scale), transfers: r2(transfers),
      monthsCovered: 12,
      overCount: rows.filter((r) => r.over).length,
    },
  };
}

/* Propose budget limits from what you ACTUALLY spend.

   Setting a budget from scratch is the tedious part, and a budget invented
   out of optimism is worse than none — every category reads as overspent,
   so the whole view gets ignored. The app already knows the honest number:
   the representative annual spend per category.

   `uplift` defaults to 0 — the proposal is what you actually spend, not a
   softened version. A caller wanting headroom can ask for it explicitly.
   Categories with no history are returned with `suggested: null` rather
   than zero, since "spend nothing on this" is a decision, not a default.
   Nothing is applied: this returns a proposal for the user to accept. */
export function suggestBudgetsFromHistory({ categories = [], txns = [], toMonth, uplift = 0 } = {}) {
  const avg = averageAnnualBudget({ categories, txns, toMonth });
  const byId = new Map(avg.rows.map((r) => [r.id, r]));
  const f = 1 + (+uplift || 0) / 100;

  const rows = categories.filter((c) => !c.transfer).map((c) => {
    const actual = byId.get(c.id)?.actual ?? 0;
    const annualOnly = c.annual > 0 && !(c.monthly > 0);
    const currentAnnual = annualOnly ? +c.annual || 0 : (+c.monthly || 0) * 12;
    const hasHistory = actual > 0;
    const suggestedAnnual = hasHistory ? r2(actual * f) : null;
    return {
      id: c.id, name: c.name, essential: !!c.essential, annualOnly,
      currentAnnual: r2(currentAnnual),
      // Monthly categories are proposed as a monthly figure, matching how
      // they're entered — a yearly number would have to be divided by hand.
      suggested: suggestedAnnual == null ? null : (annualOnly ? suggestedAnnual : r2(suggestedAnnual / 12)),
      suggestedAnnual,
      delta: suggestedAnnual == null ? null : r2(suggestedAnnual - currentAnnual),
      hasHistory,
    };
  }).sort((a, b) => (b.suggestedAnnual ?? -1) - (a.suggestedAnnual ?? -1));

  return {
    rows,
    monthsOfHistory: avg.summary.monthsWithData,
    // Below a few months, an average is noise rather than a pattern.
    reliable: avg.summary.monthsWithData >= 3,
    totalSuggestedAnnual: r2(rows.reduce((s, r) => s + (r.suggestedAnnual || 0), 0)),
    totalCurrentAnnual: r2(rows.reduce((s, r) => s + r.currentAnnual, 0)),
  };
}

// Forward annual spend FORECAST — a data-driven alternative to the planned
// budget for "what will I actually spend over the next 12 months". Takes the
// representative annual ACTUAL spend (averaged across all history via
// averageAnnualBudget, so a single expensive year doesn't dominate) and uprates
// it by one year of general inflation. A blanket uplift, not per-category:
// simple and honest, and the inflation % is the plan's own assumption so the
// app carries one number. `monthsWithData` lets the caller warn when there's
// too little history to trust the average. Pure, node-tested.
export function forecastAnnualSpend({ categories = [], txns = [], toMonth, inflationPct = 0 } = {}) {
  const avg = averageAnnualBudget({ categories, txns, toMonth });
  const infl = Math.max(0, +inflationPct || 0);
  const f = 1 + infl / 100;
  return {
    total: r2(avg.summary.totalActual * f),
    essential: r2(avg.summary.essentialActual * f),
    baseTotal: r2(avg.summary.totalActual),
    baseEssential: r2(avg.summary.essentialActual),
    monthsWithData: avg.summary.monthsWithData,
    inflationPct: r2(infl),
  };
}

// Year-overlay data: each calendar year's spend accumulated month by
// month (Jan..Dec), so the years can be drawn on top of one another and
// the current year's running total read against prior years — the "am I
// tracking above or below trend?" view. Returns { years: [2024,2025,...],
// rows: [{ monthIndex:1..12, month:"Jan", [2024]:cum, [2025]:cum, ... }] }.
// Transfers excluded; uncategorised INCLUDED (it's real money out, and the
// question is total spend, not budgeted spend). The current (partial) year
// simply stops accumulating after the latest month with data, so its line
// ends partway across — which is exactly what makes "ahead/behind" legible.
export function yearOverlay({ categories = [], txns = [] } = {}) {
  const transferIds = new Set(categories.filter((c) => c.transfer).map((c) => c.id));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  // year -> month(0-11) -> summed spend
  const byYear = new Map();
  for (const t of txns) {
    if (!t || !t.date) continue;
    if (t.categoryId && transferIds.has(t.categoryId)) continue;
    const y = +t.date.slice(0, 4), mo = +t.date.slice(5, 7) - 1;
    if (!Number.isFinite(y) || mo < 0 || mo > 11) continue;
    if (!byYear.has(y)) byYear.set(y, new Array(12).fill(0));
    byYear.get(y)[mo] += +t.amount || 0;
  }
  const nowY = +String(new Date().toISOString().slice(0, 4));
  const nowM = new Date().getMonth(); // 0-11, the latest month that can have data this year
  // Only COMPLETE prior years form the trend baseline, plus the current
  // (partial) year. A first year with data starting mid-way (e.g. Jan-Dec
  // coverage began in August) understates every month before its first
  // record, and a future year is noise — both would mislead the "above or
  // below trend?" read. A year counts as complete if it has spend in its
  // first AND last month (a light, data-driven proxy for full coverage).
  const complete = (y) => {
    const arr = byYear.get(y);
    return (arr[0] || 0) !== 0 && (arr[11] || 0) !== 0;
  };
  const years = [...byYear.keys()]
    .filter((y) => y <= nowY && (y === nowY || complete(y)))
    .sort();
  if (!years.length) return { years: [], rows: [] };
  const rows = MONTHS.map((label, i) => {
    const row = { monthIndex: i + 1, month: label };
    for (const y of years) {
      const arr = byYear.get(y);
      // Cumulative to month i. The current year stops at the present month
      // (later months get null, so the line ends rather than dropping to a
      // flat plateau that would read as "spending stopped").
      if (y === nowY && i > nowM) { row[y] = null; continue; }
      let cum = 0;
      for (let k = 0; k <= i; k++) cum += arr[k] || 0;
      row[y] = r2(cum);
    }
    return row;
  });
  return { years, rows, currentYear: years.includes(nowY) ? nowY : null };
}

// Per-category spend for an arbitrary set of months — the primitive
// behind the "vs previous / vs average" comparison. Returns a Map of
// categoryId -> £ (transfers excluded, uncategorised ignored: a category
// comparison over rows with no category is meaningless).
export function spendByCategory({ categories = [], txns = [], months = [] } = {}) {
  const inWindow = new Set(months);
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out = new Map();
  for (const t of txns) {
    if (!t || !t.categoryId || !inWindow.has(monthOf(t.date))) continue;
    const c = byId.get(t.categoryId);
    if (!c || c.transfer) continue;
    out.set(t.categoryId, (out.get(t.categoryId) || 0) + (+t.amount || 0));
  }
  return out;
}

// Attach a per-category comparison to a set of budget rows: this period's
// actual against a BASELINE (the previous equal-length window, or the
// per-month average scaled to the window). Baseline choice is the
// caller's — "vs last month" and "vs typical month" answer different
// questions and this computes whichever it's handed.
export function withComparison(rows, { baseline, label }) {
  return rows.map((r) => {
    const base = baseline.get(r.id) || 0;
    const delta = r.actual - base;
    return {
      ...r,
      baseline: r2(base),
      delta: r2(delta),
      deltaPct: base > 0 ? r2((delta / base) * 100) : null,
      baselineLabel: label,
    };
  });
}

// DISCRETIONARY RUNWAY — the forward budget question: "I've spent £X so
// far this year; my essential costs for the rest of the year are roughly
// £Y; against my ceiling, how much is left for non-essentials?"
//
// The pieces, each stated so the number is trustworthy:
//   - SPENT YTD is actual (Jan..now), split essential/discretionary, with
//     uncategorised shown separately (it's real money out but of unknown
//     kind, so it isn't quietly called discretionary).
//   - REMAINING ESSENTIAL is projected from the BUDGET, not a run-rate:
//     monthly-essential limits × the whole months left, plus each annual-
//     only essential's UNPAID remainder (its annual figure minus what's
//     already gone out this year — so an insurance premium already paid
//     isn't double-counted). Budget-based because essentials are
//     commitments you can't easily flex; a run-rate would understate a
//     lumpy bill still to come.
//   - CEILING defaults to the full-year budget (every category's annual
//     figure) but the caller can pass an affordability ceiling instead
//     (e.g. income-derived). Headroom = ceiling − spentYTD − remaining
//     essential; per-month is that spread over the whole months left.
// A negative headroom means committed spend already exceeds the ceiling —
// surfaced honestly, not floored to zero.
export function discretionaryRunway({ categories = [], txns = [], month, ceiling = null } = {}) {
  if (!month) throw new Error("discretionaryRunway requires a month (YYYY-MM).");
  const [year, mo] = month.split("-").map(Number);
  const ytdMonthsSet = new Set(monthRange(`${year}-01`, month));
  const elapsedMonths = mo;            // Jan..current inclusive
  const wholeMonthsLeft = 12 - mo;     // full months after the current one
  const byId = new Map(categories.map((c) => [c.id, c]));
  const isAnnualOnly = (c) => c.annual > 0 && !(c.monthly > 0);

  // Actual spend this year so far.
  let ytdTotal = 0, ytdEssential = 0, ytdDiscretionary = 0, ytdUncategorised = 0;
  const spentThisYear = new Map(); // categoryId -> £ (for annual-only remainder)
  for (const t of txns) {
    if (!t || !ytdMonthsSet.has(monthOf(t.date))) continue;
    const amt = +t.amount || 0;
    const c = t.categoryId ? byId.get(t.categoryId) : null;
    if (!c) { ytdUncategorised += amt; continue; }
    if (c.transfer) continue;
    spentThisYear.set(c.id, (spentThisYear.get(c.id) || 0) + amt);
    ytdTotal += amt;
    if (c.essential) ytdEssential += amt; else ytdDiscretionary += amt;
  }

  // Essential costs still to come this year, from the budget.
  let remainingEssential = 0;
  for (const c of categories) {
    if (c.transfer || !c.essential) continue;
    if (isAnnualOnly(c)) {
      remainingEssential += Math.max(0, (+c.annual || 0) - (spentThisYear.get(c.id) || 0));
    } else {
      remainingEssential += (+c.monthly || 0) * wholeMonthsLeft;
    }
  }

  const totalBudget = categories.reduce((s, c) => s + (c.transfer ? 0 : isAnnualOnly(c) ? (+c.annual || 0) : (+c.monthly || 0) * 12), 0);
  const cap = ceiling != null && ceiling > 0 ? +ceiling : totalBudget;
  const committed = ytdTotal + ytdUncategorised + remainingEssential;
  const headroom = cap - committed;
  return {
    month, elapsedMonths, wholeMonthsLeft,
    ytdTotal: r2(ytdTotal),
    ytdEssential: r2(ytdEssential),
    ytdDiscretionary: r2(ytdDiscretionary),
    ytdUncategorised: r2(ytdUncategorised),
    remainingEssential: r2(remainingEssential),
    totalBudget: r2(totalBudget),
    ceiling: r2(cap),
    usedDefaultCeiling: !(ceiling != null && ceiling > 0),
    committed: r2(committed),
    headroom: r2(headroom),
    perMonthHeadroom: wholeMonthsLeft > 0 ? r2(headroom / wholeMonthsLeft) : r2(headroom),
    overCommitted: headroom < 0,
  };
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
