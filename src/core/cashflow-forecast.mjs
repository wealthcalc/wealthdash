/* ======================================================================
   12-MONTH CASHFLOW FORECAST — income and spend on the same monthly axis.

   What existed before this: a forward INCOME calendar (income-calendar.mjs,
   dated events) and a single forward SPEND number (budget.mjs's
   forecastAnnualSpend: trailing average x one year of inflation). The
   Budget tab compared the two as annual totals. That answers "does income
   cover spend over a year" and nothing about WHEN — December, the
   insurance renewals, the month the car tax and the holiday land together.

   This module produces the monthly shape of both, so "am I cash-positive
   next March, and by how much?" has an answer.

   SPEND, per future month = COMMITTED + VARIABLE + GOALS
     committed — recurring definitions expanded onto their real dates
                 (a renewal lands in ITS month, not smeared over twelve)
     variable  — the median of the same CALENDAR month in history, after
                 removing what recurring commitments would have cost in
                 that month, uprated by inflation for the years ahead. Same
                 calendar month, because seasonality is the whole point: a
                 flat average puts a normal month's spend on December.
     goals     — the Plan tab's dated one-offs that fall inside the window.
   A P25–P75 BAND comes from the dispersion of historical variable months,
   so the estimate carries its own uncertainty instead of a false point.

   Double-counting guard: a historical month that a statement covers has the
   direct debits INSIDE its statement rows (the recurring expansion is
   suppressed for covered months). So "variable" history is computed by
   subtracting what recurring WOULD have cost that month — expanded with no
   coverage suppression — whether or not a statement happened to record it.

   INCOME per month is the calendar's events bucketed, split by certainty,
   with an optional net-of-tax pass over the GIA dividends and interest via
   an injected tax function (the app's uk-tax engine), so this stays pure.

   Pure and node-tested (cashflow-forecast.test.mjs).
   ====================================================================== */
import { expandRecurring } from "./recurring.mjs";

const r2 = (x) => Math.round(x * 100) / 100;
const monthOf = (iso) => String(iso || "").slice(0, 7);
const addMonths = (ym, n) => {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};
const lastDayOf = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const median = (xs) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q) => p - q); return a.length ? a[Math.floor(a.length / 2)] : null; };
const quantile = (xs, q) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, q2) => p - q2); if (!a.length) return null; const i = (a.length - 1) * q; const lo = Math.floor(i), hi = Math.ceil(i); return a[lo] + (a[hi] - a[lo]) * (i - lo); };

// The next `months` calendar months starting with the CURRENT one.
export function forecastMonths(today, months = 12) {
  const start = monthOf(today);
  return Array.from({ length: months }, (_, i) => addMonths(start, i));
}

/* ------------------------------- spend -------------------------------- */
export function forecastMonthlySpend({
  spend = [],            // mergedSpend() rows: { date, amount, categoryId, recurringId? }
  categories = [],
  recurring = [],        // recurring definitions
  goals = [],            // Plan goals: { label, age, amount, enabled } (age-based)
  currentAge = null,
  today, months = 12, inflationPct = 0,
} = {}) {
  if (!today) throw new Error("forecastMonthlySpend requires `today` — pure functions don't read the clock.");
  const future = forecastMonths(today, months);
  const thisMonth = monthOf(today);
  const transfer = new Set(categories.filter((c) => c && c.transfer).map((c) => c.id));

  // Historical totals by month (statement rows + recurring expansions that
  // mergedSpend added for uncovered months), transfers and refunds-as-
  // negatives left in place — a refund genuinely reduces the month.
  const totalBy = new Map();
  for (const t of spend) {
    if (!t || !t.date) continue;
    const m = monthOf(t.date);
    if (m >= thisMonth) continue;                       // history only
    if (t.categoryId && transfer.has(t.categoryId)) continue;
    totalBy.set(m, (totalBy.get(m) || 0) + (+t.amount || 0));
  }
  const histMonths = [...totalBy.keys()].sort();
  if (!histMonths.length) {
    return { months: future.map((month) => ({ month, committed: 0, variable: 0, goals: 0, total: 0, low: 0, high: 0, recurringItems: [], goalItems: [] })),
      monthsWithData: 0, reliable: false, totals: { total: 0, low: 0, high: 0, committed: 0, variable: 0, goals: 0 } };
  }

  // What recurring WOULD have cost each month, past and future, with no
  // statement-coverage suppression — the double-counting guard.
  const committedBy = new Map();
  const itemsBy = new Map();
  const { rows: rec } = expandRecurring({ definitions: recurring, fromDate: `${histMonths[0]}-01`, toDate: lastDayOf(future[future.length - 1]), coverage: {} });
  for (const r of rec) {
    const m = monthOf(r.date);
    committedBy.set(m, (committedBy.get(m) || 0) + (+r.amount || 0));
    if (m >= thisMonth) (itemsBy.get(m) || itemsBy.set(m, []).get(m)).push({ label: r.description, amount: +r.amount || 0, date: r.date });
  }

  // Variable history = total − committed, per month; grouped by calendar month.
  const variableBy = new Map();
  const byCal = new Map();
  for (const m of histMonths) {
    const v = Math.max(0, (totalBy.get(m) || 0) - (committedBy.get(m) || 0));
    variableBy.set(m, v);
    const cal = m.slice(5);
    (byCal.get(cal) || byCal.set(cal, []).get(cal)).push(v);
  }
  const allVariable = [...variableBy.values()];
  const overallMedian = median(allVariable) ?? 0;
  const p25 = quantile(allVariable, 0.25) ?? overallMedian, p75 = quantile(allVariable, 0.75) ?? overallMedian;
  // Band expressed as multipliers of the median so it scales with each
  // month's own seasonal level rather than being one fixed width.
  const lowMult = overallMedian > 0 ? p25 / overallMedian : 1, highMult = overallMedian > 0 ? p75 / overallMedian : 1;

  // Goals: age-based in the Plan; convert to a month using the current age.
  const goalItemsBy = new Map();
  if (Number.isFinite(+currentAge)) {
    for (const g of goals || []) {
      if (!g || g.enabled === false || !(+g.amount > 0) || !Number.isFinite(+g.age)) continue;
      const yearsAhead = Math.round(+g.age) - Math.round(+currentAge);
      const m = addMonths(thisMonth, yearsAhead * 12);
      if (future.includes(m)) (goalItemsBy.get(m) || goalItemsBy.set(m, []).get(m)).push({ label: g.label || "Goal", amount: +g.amount });
    }
  }

  const infl = Math.max(0, +inflationPct || 0) / 100;
  const rows = future.map((month, i) => {
    const cal = month.slice(5);
    const seasonal = byCal.has(cal) ? median(byCal.get(cal)) : overallMedian;
    const uplift = (1 + infl) ** ((i + 1) / 12);
    const variable = r2(seasonal * uplift);
    const committed = r2(committedBy.get(month) || 0);
    const goalsSum = r2((goalItemsBy.get(month) || []).reduce((s, g) => s + g.amount, 0));
    return {
      month, committed, variable, goals: goalsSum,
      total: r2(committed + variable + goalsSum),
      low: r2(committed + variable * lowMult + goalsSum),
      high: r2(committed + variable * highMult + goalsSum),
      seasonalSamples: byCal.has(cal) ? byCal.get(cal).length : 0,
      recurringItems: (itemsBy.get(month) || []).sort((a, b) => b.amount - a.amount),
      goalItems: goalItemsBy.get(month) || [],
    };
  });
  const sum = (k) => r2(rows.reduce((s, r) => s + r[k], 0));
  return {
    months: rows,
    monthsWithData: histMonths.length,
    reliable: histMonths.length >= 3,
    seasonalCoverage: rows.filter((r) => r.seasonalSamples > 0).length,
    totals: { total: sum("total"), low: sum("low"), high: sum("high"), committed: sum("committed"), variable: sum("variable"), goals: sum("goals") },
  };
}

/* ------------------------------- income ------------------------------- */
// Bucket the income calendar's events by month. `taxFn` (optional) takes
// { interest, dividends } annual GIA totals and returns { interestTax,
// dividendTax } — the app passes uk-tax's investmentIncomeTax bound to the
// salary and year; this module never imports tax rules itself.
const INVESTMENT = new Set(["dividend", "interest", "gilt-coupon"]);
export function forecastMonthlyIncome({ events = [], today, months = 12, taxFn = null, includeCapital = false } = {}) {
  if (!today) throw new Error("forecastMonthlyIncome requires `today`.");
  const future = forecastMonths(today, months);
  const idx = new Map(future.map((m, i) => [m, i]));
  const rows = future.map((month) => ({ month, scheduled: 0, estimated: 0, total: 0, taxable: 0, tax: 0, net: 0, bySource: {} }));
  let giaInterest = 0, giaDividends = 0;
  for (const e of events) {
    if (!e || !e.date) continue;
    const i = idx.get(monthOf(e.date));
    if (i == null) continue;
    const capital = e.source === "gilt-redemption" || e.source === "cash-maturity";
    if (capital && !includeCapital) continue;
    const amt = +e.amount || 0;
    const row = rows[i];
    if (e.certainty === "scheduled") row.scheduled += amt; else row.estimated += amt;
    row.total += amt;
    row.bySource[e.source] = (row.bySource[e.source] || 0) + amt;
    if (INVESTMENT.has(e.source) && (e.wrapper || "GIA") === "GIA") {
      row.taxable += amt;
      if (e.source === "dividend") giaDividends += amt; else giaInterest += amt;
    }
  }
  // Tax: annual engine result apportioned to months by their taxable share.
  let tax = { interestTax: 0, dividendTax: 0 };
  if (taxFn && (giaInterest > 0 || giaDividends > 0)) {
    const t = taxFn({ interest: giaInterest, dividends: giaDividends }) || {};
    tax = { interestTax: +t.interestTax || 0, dividendTax: +t.dividendTax || 0 };
  }
  const totalTax = tax.interestTax + tax.dividendTax;
  const taxableTotal = rows.reduce((s, r) => s + r.taxable, 0);
  for (const r of rows) {
    r.tax = taxableTotal > 0 ? r2((r.taxable / taxableTotal) * totalTax) : 0;
    r.net = r2(r.total - r.tax);
    r.scheduled = r2(r.scheduled); r.estimated = r2(r.estimated); r.total = r2(r.total); r.taxable = r2(r.taxable);
  }
  const sum = (k) => r2(rows.reduce((s, r) => s + r[k], 0));
  return { months: rows, totals: { total: sum("total"), scheduled: sum("scheduled"), estimated: sum("estimated"), taxable: sum("taxable"), tax: r2(totalTax), net: sum("net") }, tax };
}

/* ------------------------------ combine ------------------------------- */
export function combineCashflow({ income, spend, netOfTax = false } = {}) {
  const months = (spend?.months || []).map((s, i) => {
    const inc = income?.months?.[i] || { total: 0, net: 0, scheduled: 0, estimated: 0 };
    const incomeAmt = netOfTax ? inc.net : inc.total;
    const net = r2(incomeAmt - s.total);
    return { month: s.month, income: r2(incomeAmt), incomeScheduled: inc.scheduled, incomeEstimated: inc.estimated, spend: s.total, spendLow: s.low, spendHigh: s.high, net, netLow: r2(incomeAmt - s.high), netHigh: r2(incomeAmt - s.low) };
  });
  let cum = 0;
  for (const m of months) { cum = r2(cum + m.net); m.cumulative = cum; }
  const shortfall = months.filter((m) => m.net < 0);
  const worst = shortfall.length ? shortfall.reduce((w, m) => (m.net < w.net ? m : w)) : null;
  return {
    months,
    totals: { income: r2(months.reduce((s, m) => s + m.income, 0)), spend: r2(months.reduce((s, m) => s + m.spend, 0)), net: cum },
    shortfallMonths: shortfall.map((m) => m.month),
    worstMonth: worst,
    coveragePct: months.reduce((s, m) => s + m.spend, 0) > 0 ? r2((months.reduce((s, m) => s + m.income, 0) / months.reduce((s, m) => s + m.spend, 0)) * 100) : null,
  };
}
