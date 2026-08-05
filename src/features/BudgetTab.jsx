import React, { useState, useMemo, useRef } from "react";
import { Plus, Trash2, Upload, Check, AlertTriangle, Wand2 } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell, Sector } from "recharts";
import { monthlyBudget, annualBudget, averageAnnualBudget, forecastAnnualSpend, spendByMonth, trailing12, mergedSpend, spendByCategory, withComparison, monthRange, yearOverlay, discretionaryRunway } from "../core/budget.mjs";
import { effInflation } from "../core/drawdown.mjs";
import { uncategorisedGroups, suggestRule, normaliseMerchant } from "../core/categorise.mjs";
import { detectRecurring, topMerchants } from "../core/detect-recurring.mjs";
import { parseStatement, dedupeStatement, PROFILES } from "../core/statement-import.mjs";
import { expandRecurring, statementCoverage, annualCommitment, FREQUENCIES } from "../core/recurring.mjs";
import { store, gbp, gbp0, SubTabs, SegmentedControl, uid, todayISO, Field, Empty, Stat, useSort, sortRows, SortTh } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";
import { removeWithUndo } from "../ui/undo.jsx";

/* ======================================================================
   BUDGET — planned vs actual spending, fed by bank/card statement
   imports. Three engines behind it, all pure and node-tested:
   core/budget.mjs (limits, roll-up, essential split), core/categorise.mjs
   (rules + merchant memory) and core/statement-import.mjs (CSV parsing).

   The one architectural decision worth stating here: categorisation is
   DERIVED at render time, never written into the stored rows. Editing a
   rule therefore re-categorises all history instantly — the alternative
   (stamping categoryId at import) makes rules retroactively useless.
   Only MANUAL decisions are persisted, on the row as manualCategoryId.
   ====================================================================== */

const CAT_BLANK = () => ({ id: uid(), name: "", monthly: "", annual: "", essential: false, transfer: false });
const OPS = [["contains", "contains"], ["startsWith", "starts with"], ["equals", "is exactly"], ["regex", "matches regex"], ["gt", "amount over"], ["lt", "amount under"]];

// A starting set most UK households recognise, so the tab isn't a blank
// page on first visit. Essential flags follow the "could I cut this in a
// bad year?" test the income floor cares about.
const STARTER = [
  { name: "Groceries", monthly: 600, essential: true },
  { name: "Utilities", monthly: 250, essential: true },
  { name: "Transport", monthly: 200, essential: true },
  { name: "Housing", monthly: 0, essential: true },
  { name: "Eating out", monthly: 250 },
  { name: "Shopping", monthly: 200 },
  { name: "Holidays", annual: 4000 },
  { name: "Insurance", annual: 1200, essential: true },
  { name: "Subscriptions", monthly: 60 },
  { name: "Health", monthly: 80, essential: true },
  { name: "Card payment / transfer", transfer: true },
];

const thisMonth = () => todayISO().slice(0, 7);
const prevMonth = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
};

export default function BudgetTab({ setTab, projectedIncome = 0 }) {
  const categories = useAppStore((s) => s.budgetCategories), setCategories = useAppStore((s) => s.setBudgetCategories);
  const rules = useAppStore((s) => s.budgetRules), setRules = useAppStore((s) => s.setBudgetRules);
  const spendTxns = useAppStore((s) => s.spendTxns), setSpendTxns = useAppStore((s) => s.setSpendTxns);
  const recurring = useAppStore((s) => s.recurringExpenses), setRecurring = useAppStore((s) => s.setRecurringExpenses);
  const incomeEntries = useAppStore((s) => s.incomeEntries);

  const [sub, setSub] = useState(() => store.get("cgt.budgetsubtab", "overview"));
  React.useEffect(() => store.set("cgt.budgetsubtab", sub), [sub]);
  const [month, setMonth] = useState(thisMonth);
  // Drill-down: clicking a category in the Overview opens Transactions
  // already filtered to it — "Groceries is £200 over" should be one click
  // from "…because of these transactions", not a manual re-filter.
  const [txnFilter, setTxnFilter] = useState("uncat");
  const drillTo = (categoryId) => { setTxnFilter(categoryId); setSub("txns"); };

  // Derived categorisation — see header. Merchant memory is learned from
  // the user's own manual decisions on every render, so one correction
  // teaches every future row without a save step.
  // The one spend list every view uses — imported/manual rows with
  // categories resolved, plus recurring commitments expanded into the
  // months no statement covers (core/budget.mjs's mergedSpend). Home and
  // Plan call the same function, so the three can't disagree.
  const txns = useMemo(
    () => mergedSpend({ spendTxns, rules, recurring, month: todayISO().slice(0, 7) }),
    [spendTxns, rules, recurring]
  );
  // The suppression detail is only needed by the Recurring sub-tab's
  // status column, so it's computed separately rather than widening
  // mergedSpend's return for one consumer.
  const recurringOut = useMemo(() => {
    if (!recurring?.length) return { rows: [], suppressed: [] };
    const y = +todayISO().slice(0, 4);
    return expandRecurring({
      definitions: recurring,
      fromDate: `${y - 2}-01-01`, toDate: `${y + 1}-12-31`,
      coverage: statementCoverage(spendTxns),
    });
  }, [recurring, spendTxns]);

  const catById = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, c])), [categories]);
  const seedStarter = () => setCategories(STARTER.map((c) => ({ id: uid(), name: c.name, monthly: c.monthly || 0, annual: c.annual || 0, essential: !!c.essential, transfer: !!c.transfer })));

  const setManual = (ids, categoryId) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    setSpendTxns((p) => p.map((t) => (set.has(t.id) ? { ...t, manualCategoryId: categoryId || undefined } : t)));
  };

  return (
    <div className="space-y-5">
      <SubTabs
        tabs={[["overview", "Overview"], ["txns", "Transactions"], ["recurring", "Recurring"], ["categories", "Categories & rules"], ["import", "Import statements"]]}
        active={sub} onChange={setSub}
      />

      {!categories.length && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-semibold">Start with a category set</div>
          <p className="text-xs text-[var(--muted)] max-w-2xl">Budgeting needs categories before anything else works. These eleven cover most UK households — rename, re-limit or delete any of them afterwards. "Card payment / transfer" is flagged as a transfer, so paying your Amex from HSBC doesn't get counted as a second pound of spending.</p>
          <button onClick={seedStarter} className="btn-accent"><Wand2 size={15} /> Create starter categories</button>
        </div>
      )}

      {sub === "overview" && <Overview {...{ categories, txns, month, setMonth, setSub, drillTo, incomeEntries, projectedIncome }} />}
      {sub === "txns" && <Transactions {...{ categories, catById, txns, spendTxns, setManual, setSpendTxns, rules, setRules, filter: txnFilter, setFilter: setTxnFilter }} />}
      {sub === "recurring" && <Recurring {...{ recurring, setRecurring, categories, catById, suppressed: recurringOut.suppressed, generated: recurringOut.rows, spendTxns }} />}
      {sub === "categories" && <Categories {...{ categories, setCategories, rules, setRules, catById, txns }} />}
      {sub === "import" && <ImportStatements {...{ spendTxns, setSpendTxns, setSub }} />}
    </div>
  );
}

/* ------------------------------- Overview ---------------------------- */
function Overview({ categories, txns, month, setMonth, setSub, drillTo, incomeEntries = [], projectedIncome = 0 }) {
  // Trailing 12 months is the DEFAULT because it's the honest picture: a
  // single month is noisy (annual bills, holidays, a quiet fortnight) and
  // the year is what the retirement plan actually consumes. This/Last
  // month are one tap away for "did I overspend recently?".
  const [view, setView] = useState(() => store.get("cgt.budget.view", "year"));
  React.useEffect(() => store.set("cgt.budget.view", view), [view]);
  // Basis for the FORWARD spend estimate on the projected-coverage line:
  // "budget" = the planned annual budget; "forecast" = representative annual
  // actual spend (all history, averaged) uprated by the plan's inflation.
  const [spendBasis, setSpendBasis] = useState(() => store.get("cgt.budget.spendbasis", "budget"));
  React.useEffect(() => store.set("cgt.budget.spendbasis", spendBasis), [spendBasis]);
  const planInputs = useAppStore((st) => st.planInputs) || {};
  const inflPct = Number.isFinite(+planInputs.inflation)
    ? effInflation({ inflation: +planInputs.inflation, inflMode: planInputs.inflMode || "cpi", rpiWedge: +planInputs.rpiWedge || 0 })
    : 3; // sensible default when the plan hasn't been set up yet
  const forecast = useMemo(() => forecastAnnualSpend({ categories, txns, toMonth: month, inflationPct: inflPct }), [categories, txns, month, inflPct]);
  const m = useMemo(() => monthlyBudget({ categories, txns, month }), [categories, txns, month]);
  const a = useMemo(() => annualBudget({ categories, txns, month }), [categories, txns, month]);
  // "avg" view: representative 12 months from ALL history (dilutes one-off
  // years), vs "year" which is strictly the last 12 months.
  const avg = useMemo(() => averageAnnualBudget({ categories, txns, toMonth: month }), [categories, txns, month]);
  // Year to date: 1 Jan of the current year to now. Limits scale to the
  // elapsed months (annualBudget's `months` window), so "spent vs budget
  // so far this year" is a like-for-like — not the full-year budget.
  const ytdMonths = useMemo(() => { const now = thisMonth(); return monthRange(`${now.slice(0, 4)}-01`, now); }, []);
  const ytd = useMemo(() => annualBudget({ categories, txns, months: ytdMonths }), [categories, txns, ytdMonths]);
  const [spreadAnnual, setSpreadAnnual] = useState(() => store.get("cgt.budget.spread", true));
  React.useEffect(() => store.set("cgt.budget.spread", spreadAnnual), [spreadAnnual]);
  const trend = useMemo(
    () => spendByMonth({ categories, txns, months: trailing12(month), spreadAnnual }),
    [categories, txns, month, spreadAnnual]
  );
  // Per-category comparison against a baseline: the previous month (month
  // view) or the prior 12 months' average (year view). Makes drift
  // visible — a static period says nothing about whether a category is
  // creeping up.
  const baseResult = view === "month" ? m : view === "avg" ? avg : view === "ytd" ? ytd : a;
  const compared = useMemo(() => {
    const rowsIn = baseResult.rows;
    if (view === "month") {
      const baseline = spendByCategory({ categories, txns, months: [prevMonth(month)] });
      return withComparison(rowsIn, { baseline, label: "vs prev month" });
    }
    if (view === "avg") {
      // Average view compares each category against the trailing 12 months,
      // so you can see whether the RECENT year is running above or below
      // your long-run typical.
      const baseline = spendByCategory({ categories, txns, months: trailing12(month) });
      return withComparison(rowsIn, { baseline, label: "vs last 12m" });
    }
    if (view === "ytd") {
      // YTD compares against the SAME months last year — the only honest
      // like-for-like for a partial year (comparing 7 months to a full 12
      // would always look "under").
      const priorYtd = ytdMonths.map((mm) => { const [yy, mo] = mm.split("-"); return `${+yy - 1}-${mo}`; });
      const baseline = spendByCategory({ categories, txns, months: priorYtd });
      return withComparison(rowsIn, { baseline, label: "vs same period last yr" });
    }
    // year view: average of the 12 months BEFORE this window
    const [y, mo] = month.split("-").map(Number);
    const priorEnd = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
    const priorMonths = monthRange(monthRange(`${y - 2}-01`, priorEnd).slice(-12)[0], priorEnd);
    const spent = spendByCategory({ categories, txns, months: priorMonths });
    return withComparison(rowsIn, { baseline: spent, label: "vs prior 12m" });
  }, [view, baseResult, categories, txns, month]);
  const cur = { ...baseResult, rows: compared };
  const s = cur.summary;
  const tm = thisMonth();
  // Any month other than the current one is reached through the picker
  // rather than a button, so it gets no highlighted pill.
  const activePeriod = view === "avg" ? "avg" : view === "ytd" ? "ytd" : view === "year" ? "year" : month === tm ? "this" : "month";

  if (!txns.length) {
    return <Empty msg="No spending imported yet. Use the Import statements sub-tab to load an Amex or HSBC CSV export, then categorise the rows." />;
  }

  return (
    <div className="space-y-4">
      {/* Three fixed periods, all anchored to now — no month picker (its
          appearing/disappearing made the row jump, and browsing an
          arbitrary past month added little the three views don't). */}
      <div className="flex gap-1.5 flex-wrap">
        {[
          ["year", "Trailing 12 months", "The last 12 calendar months to today.", () => { setView("year"); setMonth(tm); }],
          ["avg", `Average year${avg.summary.monthsWithData ? ` (${avg.summary.monthsWithData}m)` : ""}`, "A representative 12 months, averaged across all your history — dilutes a one-off expensive year.", () => setView("avg")],
          ["ytd", `Year to date${ytdMonths.length ? ` (${ytdMonths.length}m)` : ""}`, "1 January this year to now, with the budget scaled to the elapsed months.", () => setView("ytd")],
          ["this", "This month", "Spending so far this calendar month.", () => { setView("month"); setMonth(tm); }],
        ].map(([k, label, tip, onClick]) => (
          <button key={k} onClick={onClick} title={tip}
            className={"text-xs font-medium px-2.5 py-1.5 rounded-full border transition " +
              (activePeriod === k ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
            {label}
          </button>
        ))}
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><Stat label={view === "avg" ? "Spent (avg year)" : view === "ytd" ? "Spent (YTD)" : "Spent"} value={gbp0(s.totalActual)} sub={view === "month" ? month : view === "avg" ? `averaged over ${s.monthsWithData} months` : view === "ytd" ? `${ytdMonths[0]} to now` : `12 months to ${month}`} /></div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><Stat label="Budget" value={gbp0(s.totalLimit)} sub={view === "month" ? "monthly limits only" : "incl. annual categories"} /></div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Stat label={s.variance >= 0 ? "Under budget" : "Over budget"} value={gbp0(Math.abs(s.variance))} tone={s.variance >= 0 ? "green" : "red"} sub={`${s.overCount ?? cur.rows.filter((r) => r.over).length} categor${(s.overCount ?? 0) === 1 ? "y" : "ies"} over`} />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Stat label="Essential share" value={view !== "month" && s.essentialPct != null ? `${Math.round(s.essentialPct)}%` : gbp0(s.essentialActual)} sub={`discretionary ${gbp0(s.discretionaryActual)}`} />
        </div>
      </div>

      {view === "ytd" && <DiscretionaryRunway categories={categories} txns={txns} month={thisMonth()} />}

      {/* INCOME ↔ SPENDING — the two adjacent halves of a household finally
          on one line. Investment income comes from the Income tab's ledger
          (dividends + interest received in the window); spending is this
          view's own total. It answers "does what comes in cover what goes
          out?" without hopping between tabs. */}
      {(() => {
        const window = view === "month" ? [month] : view === "ytd" ? ytdMonths : trailing12(month);
        const inWin = new Set(window);
        const invIncome = incomeEntries.reduce((sum, e) => sum + (e && e.date && inWin.has(e.date.slice(0, 7)) ? (+e.amount || 0) : 0), 0);
        if (invIncome <= 0) return null;
        const covers = invIncome / (s.totalActual || 1) * 100;
        // Essentials are the spend that must be met even in a bad year, so
        // "does passive income cover the essentials?" is the more meaningful
        // question than total spend — it's the flooring test the retirement
        // plan cares about, applied to today.
        const coversEssential = s.essentialActual > 0 ? invIncome / s.essentialActual * 100 : null;
        return (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel2)] px-3 py-2 text-xs text-[var(--muted)]">
            Investment income received {view === "month" ? "this month" : "over the year"}: <strong className="text-[var(--gain)]">{gbp0(invIncome)}</strong> — covers <strong className="text-[var(--fg)]">{Math.round(covers)}%</strong> of your {gbp0(s.totalActual)} total spend{coversEssential != null && <>, and <strong className={coversEssential >= 100 ? "text-[var(--gain)]" : "text-[var(--fg)]"}>{Math.round(coversEssential)}%</strong> of the {gbp0(s.essentialActual)} essential</>}. <span className="text-[10px]">(dividends + interest from the Income tab; salary not included)</span>
          </div>
        );
      })()}

      {/* FORWARD companion to the line above — projected next-12m investment
          income (income calendar: forecast dividends + interest + gilt coupons)
          vs projected annual spend (both forward, so apples-to-apples). Spend
          basis is switchable: the planned budget, or a data-driven forecast
          (representative annual actual spend × the plan's inflation). Answers
          "will passive income cover it?" alongside the "did it?" above.
          View-independent — always the next-12-months projection. */}
      {(() => {
        if (!(projectedIncome > 0)) return null;
        const enoughHistory = forecast.monthsWithData >= 3;
        const useForecast = spendBasis === "forecast" && enoughHistory;
        const projSpend = useForecast ? forecast.total : a.summary.totalLimit;
        const projEssential = useForecast ? forecast.essential : a.summary.essentialLimit;
        if (!(projSpend > 0)) return null;
        const covers = projectedIncome / projSpend * 100;
        const coversEssential = projEssential > 0 ? projectedIncome / projEssential * 100 : null;
        const effBasis = useForecast ? "forecast" : "budget";
        return (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--muted)] space-y-1.5">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <span>Projected investment income (next 12 months): <strong className="text-[var(--gain)]">{gbp0(projectedIncome)}</strong> — expected to cover <strong className="text-[var(--fg)]">{Math.round(covers)}%</strong> of your {gbp0(projSpend)} projected spend{coversEssential != null && <>, and <strong className={coversEssential >= 100 ? "text-[var(--gain)]" : "text-[var(--fg)]"}>{Math.round(coversEssential)}%</strong> of the {gbp0(projEssential)} essential</>}.</span>
              <span className="shrink-0">
                <SegmentedControl size="xs" ariaLabel="Projected spend basis" value={effBasis} onChange={setSpendBasis}
                  options={[
                    ["budget", "Planned budget"],
                    ["forecast", "History + inflation", { disabled: !enoughHistory, title: enoughHistory ? "" : "Needs at least 3 months of spending history to average" }],
                  ]} />
              </span>
            </div>
            <div className="text-[10px] leading-relaxed">{useForecast
              ? <>Spend = your representative annual spend of {gbp0(forecast.baseTotal)} (averaged across {forecast.monthsWithData} months of history) uprated {forecast.inflationPct}% for inflation (from your plan). Income forecast from current holdings. Dashed box = estimate, not actuals.</>
              : <>Spend = your planned annual budget. Income forecast from current holdings. {enoughHistory ? "Switch to “History + inflation” for a data-driven spend estimate. " : ""}Dashed box = estimate, not actuals.</>}</div>
          </div>
        );
      })()}

      {s.uncategorised > 0 && (
        <button onClick={() => setSub("txns")} className="w-full text-left rounded-xl border border-[var(--m-bb)] bg-[var(--panel)] p-3 text-xs flex items-start gap-2 hover:bg-[var(--panel2)] transition">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
          <span><strong>{gbp(s.uncategorised)}</strong> of spending isn't categorised{view === "month" ? " this month" : " over the year"}, so it's missing from every figure above. Categorise it →</span>
        </button>
      )}

      <YearOverlayChart categories={categories} txns={txns} />

      <CategoryPie rows={cur.rows} total={s.totalActual} onSlice={drillTo}
        periodLabel={view === "month" ? month : view === "avg" ? "average year" : view === "ytd" ? "year to date" : `12 months to ${month}`} />

      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Category", "Spent", "Budget", "Left", cur.rows[0]?.baselineLabel || "vs prev", ""].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i === 0 ? "text-left" : i === 5 ? "text-left" : "text-right")}>{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {cur.rows.map((r) => (
              <tr key={r.id} className="hover:bg-[var(--panel2)]">
                <td className="py-2 px-3">
                  <button onClick={() => drillTo(r.id)} className="underline decoration-dotted underline-offset-2 hover:text-[var(--accent)]"
                    title={`Show ${r.name} transactions`}>
                    {r.name}
                  </button>
                  {r.essential && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">essential</span>}
                  {r.annualOnly && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--m-pool)]">annual</span>}
                </td>
                <td className="py-2 px-3 text-right num">{gbp(r.actual)}</td>
                <td className="py-2 px-3 text-right num text-[var(--muted)]">{r.limit == null ? "—" : gbp(r.limit)}</td>
                <td className={"py-2 px-3 text-right num " + (r.variance == null ? "text-[var(--muted)]" : r.variance < 0 ? "text-[var(--loss)]" : "text-[var(--gain)]")}>
                  {r.variance == null ? "—" : gbp(r.variance)}
                </td>
                {/* vs baseline — higher spending than the comparison period
                    is red (worse), lower is green. Direction, not just a
                    number, so drift reads at a glance. */}
                <td className="py-2 px-3 text-right num" title={r.baseline != null ? `Was ${gbp(r.baseline)}` : undefined}>
                  {r.baseline > 0 || r.delta !== 0 ? (
                    <span className={r.delta > 0 ? "text-[var(--loss)]" : r.delta < 0 ? "text-[var(--gain)]" : "text-[var(--muted)]"}>
                      {r.delta > 0 ? "▲" : r.delta < 0 ? "▼" : ""}{gbp(Math.abs(r.delta))}
                      {r.deltaPct != null && <span className="text-[var(--muted)] text-xs"> {r.deltaPct > 0 ? "+" : ""}{Math.round(r.deltaPct)}%</span>}
                    </span>
                  ) : <span className="text-[var(--muted)] text-xs">new</span>}
                </td>
                <td className="py-2 px-3" style={{ width: 90 }}>
                  {r.pctUsed != null && (
                    <div className="h-1.5 rounded-full bg-[var(--panel2)] overflow-hidden" title={`${Math.round(r.pctUsed)}% of budget`}>
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, r.pctUsed)}%`, background: r.over ? "var(--loss)" : "var(--gain)" }} />
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <TopMerchantsPanel categories={categories} txns={txns} view={view} month={month} ytdMonths={ytdMonths} />

      {/* Moved to the bottom: the per-month essential/discretionary bars vs
          the budget line — detail you drill into after the headline views
          above, not the first thing you scan. */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-1.5">
          <div className="text-xs font-medium text-[var(--muted)]">Spend by month vs budget</div>
          <div className="flex gap-1.5">
            {[["spread", "Annual costs spread"], ["cash", "As actually paid"]].map(([k, label]) => (
              <button key={k} onClick={() => setSpreadAnnual(k === "spread")}
                className={"text-xs font-medium px-2.5 py-1 rounded-full border transition " +
                  ((spreadAnnual ? "spread" : "cash") === k ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
                {label}
              </button>
            ))}
          </div>
        </div>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
            <YAxis tickFormatter={gbp0} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={60} />
            <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              formatter={(v, n) => [gbp(v), { essential: "Essential", discretionary: "Discretionary", limit: "Monthly budget", uncategorised: "Uncategorised" }[n] || n]} />
            <Bar dataKey="essential" stackId="s" fill="var(--accent)" name="essential" />
            <Bar dataKey="discretionary" stackId="s" fill="var(--m-bb)" name="discretionary" />
            <Bar dataKey="uncategorised" stackId="s" fill="var(--muted)" fillOpacity={0.5} name="uncategorised" radius={[3, 3, 0, 0]} />
            <Line type="stepAfter" dataKey="limit" stroke="var(--fg)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="limit" />
          </ComposedChart>
        </ResponsiveContainer>
        <div className="flex flex-wrap gap-3 mt-2">
          {[["var(--accent)", "Essential"], ["var(--m-bb)", "Discretionary"], ["var(--muted)", "Uncategorised"]].map(([c, t]) => (
            <span key={t} className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
              <span className="w-2 h-2 rounded-full inline-block" style={{ background: c }} />{t}
            </span>
          ))}
          <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className="inline-block" style={{ width: 12, borderTop: "2px dashed var(--fg)" }} />Budget
          </span>
        </div>
        <p className="text-xs text-[var(--muted)] mt-1.5">
          {spreadAnnual
            ? "Annual costs (insurance, holidays) are averaged across the 12 months so the underlying run-rate is readable — and the budget line includes annual budgets ÷ 12 to match. The money didn't actually leave evenly: switch to \"As actually paid\" for the cash-flow truth."
            : "Money is shown in the month it actually left your account, so an annual bill towers over its neighbours. The budget line is monthly limits only — that spike is by design, not an overspend."}
        </p>
      </div>
    </div>
  );
}

/* ------------------------ Discretionary runway ----------------------- */
// The forward question: spent so far this year + committed essentials for
// the rest of the year → how much is left for non-essentials. Shown in the
// Year-to-date view. Ceiling defaults to the full-year budget; the user
// can set an affordability ceiling of their own (e.g. income-based).
function DiscretionaryRunway({ categories, txns, month }) {
  const [ceiling, setCeiling] = useState(() => store.get("cgt.budget.ceiling", ""));
  React.useEffect(() => store.set("cgt.budget.ceiling", ceiling), [ceiling]);
  const r = useMemo(
    () => discretionaryRunway({ categories, txns, month, ceiling: +ceiling || null }),
    [categories, txns, month, ceiling]
  );
  const hasEssential = categories.some((c) => c.essential && !c.transfer);
  if (!hasEssential && r.ytdTotal === 0) return null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="text-sm font-semibold">Rest-of-year headroom for non-essentials</div>
        <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
          Annual ceiling
          <input type="number" value={ceiling} onChange={(e) => setCeiling(e.target.value)} placeholder={gbp0(r.totalBudget)} className="input num w-28 py-1" title="What you're willing/able to spend across the whole year. Blank = your total budget." />
        </label>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel2)] p-3"><div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Spent so far</div><div className="text-lg font-semibold num">{gbp0(r.ytdTotal)}</div><div className="text-[10px] text-[var(--muted)] num">{gbp0(r.ytdEssential)} ess · {gbp0(r.ytdDiscretionary)} disc{r.ytdUncategorised > 0 ? ` · ${gbp0(r.ytdUncategorised)} uncat` : ""}</div></div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel2)] p-3"><div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Essentials still to come</div><div className="text-lg font-semibold num">{gbp0(r.remainingEssential)}</div><div className="text-[10px] text-[var(--muted)]">{r.wholeMonthsLeft} months left</div></div>
        <div className="rounded-lg border border-[var(--border)] bg-[var(--panel2)] p-3"><div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">Ceiling</div><div className="text-lg font-semibold num">{gbp0(r.ceiling)}</div><div className="text-[10px] text-[var(--muted)]">{r.usedDefaultCeiling ? "your total budget" : "your figure"}</div></div>
        <div className={"rounded-lg border p-3 " + (r.overCommitted ? "border-[var(--loss)] bg-[var(--panel2)]" : "border-[var(--gain)] bg-[var(--panel2)]")}><div className="text-[11px] uppercase tracking-wide text-[var(--muted)]">{r.overCommitted ? "Over ceiling by" : "Left for non-essentials"}</div><div className={"text-lg font-semibold num " + (r.overCommitted ? "text-[var(--loss)]" : "text-[var(--gain)]")}>{gbp0(Math.abs(r.headroom))}</div><div className="text-[10px] text-[var(--muted)] num">{r.wholeMonthsLeft > 0 && !r.overCommitted ? `${gbp0(r.perMonthHeadroom)}/month` : ""}</div></div>
      </div>
      <p className="text-xs text-[var(--muted)]">
        {r.overCommitted
          ? `Your spend so far plus committed essentials already exceed the ceiling by ${gbp0(-r.headroom)} — non-essential spending for the rest of the year comes out of savings unless something gives.`
          : `After what you've spent and the essentials still due (projected from your budget), ${gbp0(r.headroom)} is free for non-essentials over the remaining ${r.wholeMonthsLeft} month${r.wholeMonthsLeft === 1 ? "" : "s"} — about ${gbp0(r.perMonthHeadroom)} a month.`}
        {" "}Essentials are projected from their budget (monthly limits × months left, plus any unpaid annual bills), so it holds even for lumpy costs still to come.
      </p>
    </div>
  );
}

/* --------------------------- Top merchants --------------------------- */
// Where the money actually goes, by shop — a different lens from category.
// Scoped to the current period so it agrees with the totals above.
function TopMerchantsPanel({ categories, txns, view, month, ytdMonths }) {
  const windowTxns = useMemo(() => {
    if (view === "avg") return txns; // all history
    const months = new Set(view === "month" ? [month] : view === "ytd" ? ytdMonths : trailing12(month));
    return txns.filter((t) => t.date && months.has(t.date.slice(0, 7)));
  }, [txns, view, month, ytdMonths]);
  const transferIds = useMemo(() => new Set(categories.filter((c) => c.transfer).map((c) => c.id)), [categories]);
  const { rows, total } = useMemo(() => topMerchants(windowTxns, { transferIds, limit: 12 }), [windowTxns, transferIds]);
  if (!rows.length) return null;
  const max = rows[0].total;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="text-xs font-medium text-[var(--muted)] mb-2">Top merchants — where the money goes</div>
      <div className="space-y-1">
        {rows.map((r) => (
          <div key={r.key} className="flex items-center gap-2 text-xs">
            <span className="w-40 truncate" title={r.sample}>{r.label}</span>
            <span className="flex-1 h-2 rounded-full bg-[var(--panel2)] overflow-hidden">
              <span className="block h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.max(2, (r.total / max) * 100)}%` }} />
            </span>
            <span className="num w-20 text-right">{gbp0(r.total)}</span>
            <span className="num w-10 text-right text-[var(--muted)]">{Math.round(r.weight)}%</span>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-[var(--muted)] mt-2">Grouped by merchant (store-number noise collapsed), refunds netted, transfers excluded — {gbp0(total)} across the top {rows.length}.</p>
    </div>
  );
}

/* --------------------------- Year overlay ---------------------------- */
// Each calendar year's spend accumulated Jan→Dec, drawn on top of one
// another, so the current year's running total reads against prior years:
// above the pack = spending faster than usual, below = slower. A dotted
// projection extends the current year at its run-rate to a full-year
// estimate. core/budget.mjs's yearOverlay does the accumulation.
const OVERLAY_PALETTE = ["#9aa4b2", "#7c8aa0", "#5f8fbf", "#4E9A8F", "#B0884E"];
function YearOverlayChart({ categories, txns }) {
  const o = useMemo(() => yearOverlay({ categories, txns }), [categories, txns]);
  const projected = useMemo(() => {
    // Extend the current year's cumulative at its average monthly run-rate.
    if (!o.currentYear) return { data: o.rows, endEstimate: null };
    const cy = o.currentYear;
    // Latest month index (0-11) with a real cumulative value this year.
    let last = -1;
    for (let i = 0; i < o.rows.length; i++) if (typeof o.rows[i][cy] === "number") last = i;
    if (last < 0) return { data: o.rows, endEstimate: null };
    const cumSoFar = o.rows[last][cy];
    const runRate = cumSoFar / (last + 1); // £/month elapsed
    const endEstimate = r2ui(runRate * 12);
    const data = o.rows.map((row, i) => {
      const r = { ...row };
      // Dotted line: joins the last real point, then projects to December.
      if (i === last) r.proj = cumSoFar;
      else if (i > last) r.proj = r2ui(runRate * (i + 1));
      else r.proj = null;
      return r;
    });
    return { data, endEstimate, runRate };
  }, [o]);

  if (o.years.length < 1 || !o.rows.some((r) => o.years.some((y) => typeof r[y] === "number"))) {
    return null;
  }
  const cy = o.currentYear;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="flex items-baseline justify-between gap-3 flex-wrap mb-1.5">
        <div className="text-xs font-medium text-[var(--muted)]">Cumulative spend by year — is {cy || "this year"} above or below trend?</div>
        {projected.endEstimate != null && (
          <div className="text-xs text-[var(--muted)]">At this pace, {cy} ends near <strong className="text-[var(--fg)] num">{gbp0(projected.endEstimate)}</strong></div>
        )}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={projected.data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="var(--border)" vertical={false} />
          <XAxis dataKey="month" tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
          <YAxis tickFormatter={gbp0} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={60} />
          <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
            formatter={(v, n) => [gbp(v), n === "proj" ? `${cy} projected` : n]} />
          {/* Prior years, muted; the current year bold on top; the dotted
              projection last so it sits above everything. */}
          {o.years.filter((y) => y !== cy).map((y, idx) => (
            <Line key={y} type="monotone" dataKey={y} name={String(y)} stroke={OVERLAY_PALETTE[idx % OVERLAY_PALETTE.length]} strokeWidth={1.4} dot={false} connectNulls />
          ))}
          {cy && <Line type="monotone" dataKey={cy} name={String(cy)} stroke="var(--accent)" strokeWidth={2.4} dot={false} connectNulls />}
          {cy && <Line type="monotone" dataKey="proj" stroke="var(--accent)" strokeWidth={1.6} strokeDasharray="4 4" dot={false} connectNulls />}
        </ComposedChart>
      </ResponsiveContainer>
      <div className="flex flex-wrap gap-3 mt-2">
        {o.years.filter((y) => y !== cy).map((y, idx) => (
          <span key={y} className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: OVERLAY_PALETTE[idx % OVERLAY_PALETTE.length] }} />{y}
          </span>
        ))}
        {cy && <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--fg)]"><span className="w-2 h-2 rounded-full inline-block" style={{ background: "var(--accent)" }} />{cy}</span>}
        {cy && projected.endEstimate != null && <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]"><span className="inline-block" style={{ width: 12, borderTop: "2px dashed var(--accent)" }} />projected full year</span>}
      </div>
      <p className="text-xs text-[var(--muted)] mt-1.5">Each line is a calendar year's total spend accumulating month by month (all categories, transfers excluded). Only COMPLETE prior years are drawn — a partial first year would read artificially low — plus the current year in bold. Running above the others means you're spending faster than in prior years; the dotted line extends the current year at its year-to-date pace.</p>
    </div>
  );
}
const r2ui = (x) => Math.round(x * 100) / 100;

/* ----------------------------- Transactions -------------------------- */
function Transactions({ categories, catById, txns, spendTxns, setManual, setSpendTxns, rules, setRules, filter, setFilter }) {
  const [sort, toggleSort] = useSort("date", "desc");
  const [year, setYear] = useState("all"); // calendar-year filter
  const groups = useMemo(() => uncategorisedGroups(txns), [txns]);
  // Every calendar year present, newest first — the filter that lets a
  // long history be seen a year at a time instead of only the newest 400.
  const years = useMemo(
    () => [...new Set(txns.filter((t) => t.date).map((t) => t.date.slice(0, 4)))].sort().reverse(),
    [txns]
  );
  const shown = useMemo(() => {
    let rows = filter === "uncat" ? txns.filter((t) => !t.categoryId)
      : filter === "all" ? txns
        : txns.filter((t) => t.categoryId === filter);
    if (year !== "all") rows = rows.filter((t) => t.date && t.date.slice(0, 4) === year);
    return rows;
  }, [txns, filter, year]);

  const [nw, setNw] = useState(() => ({ date: todayISO(), description: "", amount: "", account: "", manualCategoryId: "" }));
  const addOneOff = () => {
    if (!nw.date || !(+nw.amount)) return;
    setSpendTxns((p) => [...p, {
      id: uid(), date: nw.date, description: nw.description.trim() || "Manual entry",
      amount: +nw.amount, account: nw.account.trim(),
      ...(nw.manualCategoryId ? { manualCategoryId: nw.manualCategoryId } : {}),
    }]);
    setNw({ date: nw.date, description: "", amount: "", account: nw.account, manualCategoryId: "" });
  };

  const addRuleFromGroup = (g, categoryId) => {
    const r = suggestRule(g, categoryId);
    if (!r) return;
    setRules((p) => [...p, { ...r, id: uid() }]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <Field label="Date"><input type="date" value={nw.date} onChange={(e) => setNw({ ...nw, date: e.target.value })} className="input num" /></Field>
        <Field label="Description"><input value={nw.description} onChange={(e) => setNw({ ...nw, description: e.target.value })} className="input w-44" placeholder="e.g. Plumber" /></Field>
        <Field label="Amount (£)"><input type="number" value={nw.amount} onChange={(e) => setNw({ ...nw, amount: e.target.value })} className="input num w-28" placeholder="0.00" /></Field>
        <Field label="Account"><input value={nw.account} onChange={(e) => setNw({ ...nw, account: e.target.value })} className="input w-32" placeholder="optional" /></Field>
        <Field label="Category">
          <select value={nw.manualCategoryId} onChange={(e) => setNw({ ...nw, manualCategoryId: e.target.value })} className="input">
            <option value="">— none —</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <button onClick={addOneOff} className="btn-accent"><Plus size={15} /> Add spend</button>
        <p className="text-xs text-[var(--muted)] w-full">One-off cash or card spending that isn't in any statement you import. Enter the amount as a positive number; use a negative for a refund. For anything that repeats, use the Recurring sub-tab instead.</p>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="input">
          <option value="uncat">Uncategorised ({txns.filter((t) => !t.categoryId).length})</option>
          <option value="all">All ({txns.length})</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {years.length > 1 && (
          <select value={year} onChange={(e) => setYear(e.target.value)} className="input" title="Filter to one calendar year — the list shows the newest 400 rows, so pick a year to reach older transactions">
            <option value="all">All years</option>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        )}
      </div>
      {groups.length > 0 && categories.length > 0 && (
        <p className="text-xs text-[var(--muted)] max-w-3xl">Categorise a merchant group once and every past and future transaction from that merchant follows it — the "+ rule…" column also writes a rule, so the match survives a change of card or a reworded description.</p>
      )}

      {groups.length > 0 && filter === "uncat" && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Uncategorised, grouped by merchant <span className="font-normal text-[var(--muted)]">— biggest first</span></h3>
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["Merchant", "Count", "Total", "Categorise all", ""].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i === 1 || i === 2 ? "text-right" : "text-left")}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {groups.slice(0, 30).map((g) => (
                  <tr key={g.key}>
                    <td className="py-2 px-3">{g.sample || g.key}</td>
                    <td className="py-2 px-3 text-right num text-[var(--muted)]">{g.count}</td>
                    <td className="py-2 px-3 text-right num">{gbp(g.total)}</td>
                    <td className="py-2 px-3">
                      <select className="input text-xs" value="" onChange={(e) => e.target.value && setManual(g.ids, e.target.value)}>
                        <option value="">Choose…</option>
                        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </td>
                    <td className="py-2 px-3">
                      {g.count >= 3 && (
                        <select className="input text-xs" value="" onChange={(e) => { if (e.target.value) { setManual(g.ids, e.target.value); addRuleFromGroup(g, e.target.value); } }} title="Categorise these and create a rule so future imports match automatically">
                          <option value="">+ rule…</option>
                          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {shown.length === 0 ? (
        <Empty msg={filter === "uncat" ? "Nothing uncategorised — every transaction has a category." : "No transactions match this filter."} />
      ) : (
        <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
              <tr>
                <SortTh id="date" label="Date" sort={sort} onSort={toggleSort} className="py-2 px-3 font-medium" />
                <SortTh id="description" label="Description" sort={sort} onSort={toggleSort} className="py-2 px-3 font-medium" />
                <SortTh id="account" label="Account" sort={sort} onSort={toggleSort} className="py-2 px-3 font-medium" />
                <SortTh id="amount" label="Amount" sort={sort} onSort={toggleSort} align="right" className="py-2 px-3 font-medium" />
                <th className="py-2 px-3 text-left font-medium">Category</th>
                <th className="py-2 px-3 text-left font-medium">Via</th>
                <th className="py-2 px-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {sortRows(shown, sort, {
                date: (t) => t.date, description: (t) => t.description || "", account: (t) => t.account || "", amount: (t) => +t.amount || 0,
              }).slice(0, 400).map((t) => (
                <tr key={t.id}>
                  <td className="py-2 px-3 num text-[var(--muted)] whitespace-nowrap">{t.date}</td>
                  <td className="py-2 px-3">
                    {t.description}
                    {t.estimated && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--m-bb)]" title="Generated from a recurring commitment — not from a statement">est</span>}
                  </td>
                  <td className="py-2 px-3 text-[var(--muted)] whitespace-nowrap">{t.account || "—"}</td>
                  <td className={"py-2 px-3 text-right num " + (t.amount < 0 ? "text-[var(--gain)]" : "")}>{gbp(t.amount)}</td>
                  <td className="py-2 px-3">
                    <select className="input text-xs" value={t.categoryId || ""} disabled={t.estimated}
                      title={t.estimated ? "Set the category on the Recurring sub-tab" : undefined}
                      onChange={(e) => setManual(t.id, e.target.value)}>
                      <option value="">— none —</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="py-2 px-3 text-xs text-[var(--muted)]">
                    {t.estimated ? "recurring" : t.categorisedVia === "manual" ? "you" : t.categorisedVia === "rule" ? "rule" : t.categorisedVia === "merchant" ? "learned" : "—"}
                  </td>
                  <td className="py-2 px-3 text-right">
                    {/* Estimated rows are DERIVED from a recurring definition —
                        deleting one here would do nothing (it regenerates on
                        the next render), so the affordance shouldn't exist. */}
                    {!t.estimated && (
                      <button onClick={() => removeWithUndo({ list: spendTxns, setList: setSpendTxns, id: t.id, label: `${t.description || "transaction"} (${gbp(t.amount)})` })} aria-label={`Delete transaction ${t.date} ${t.description}`} title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {shown.length > 400 && <p className="text-xs text-[var(--muted)] p-2">Showing the first 400 of {shown.length} — filter by category or year above to reach the rest.</p>}
        </div>
      )}
    </div>
  );
}

/* --------------------------- Category pie ----------------------------- */
// Distinct hues rather than a gradient: a pie is read by matching colour
// to label, which a single-hue ramp makes impossible past three slices.
const PIE_COLORS = [
  "var(--accent)", "var(--m-bb)", "var(--gain)", "var(--m-same)", "#7A5C9E",
  "#C2705A", "#4E9A8F", "#B0884E", "#8E6FA8", "#5F8FBF", "#A8615F", "#6B8E4E",
];

// The active slice grows slightly and gains an outer ring — hover feedback
// that survives colour-blindness, unlike a colour shift alone.
const renderActiveSlice = (p) => {
  const { cx, cy, innerRadius, outerRadius, startAngle, endAngle, fill } = p;
  return (
    <g>
      <Sector cx={cx} cy={cy} innerRadius={innerRadius} outerRadius={outerRadius + 5} startAngle={startAngle} endAngle={endAngle} fill={fill} />
      <Sector cx={cx} cy={cy} innerRadius={outerRadius + 7} outerRadius={outerRadius + 9} startAngle={startAngle} endAngle={endAngle} fill={fill} opacity={0.5} />
    </g>
  );
};

function CategoryPie({ rows, total, onSlice, periodLabel }) {
  const [active, setActive] = useState(-1);
  // Only positive spend can be a slice: a category in net refund for the
  // period has no meaningful share of a total, and rendering a negative
  // slice would silently distort every other percentage.
  const data = useMemo(() => rows.filter((r) => r.actual > 0).map((r, i) => ({
    ...r, value: r.actual, fill: PIE_COLORS[i % PIE_COLORS.length],
  })), [rows]);
  const refunded = rows.filter((r) => r.actual < 0);
  if (!data.length) return null;
  const shown = active >= 0 ? data[active] : null;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="text-xs font-medium text-[var(--muted)] mb-1.5">Where the money goes — {periodLabel}</div>
      <div className="flex flex-wrap items-center gap-4">
        <div style={{ width: 240, height: 240, position: "relative" }}>
          <ResponsiveContainer width="100%" height="100%">
            <PieChart>
              <Pie
                data={data} dataKey="value" nameKey="name"
                cx="50%" cy="50%" innerRadius={62} outerRadius={95}
                paddingAngle={1.5} stroke="none"
                activeIndex={active >= 0 ? active : undefined}
                activeShape={renderActiveSlice}
                onMouseEnter={(_, i) => setActive(i)}
                onMouseLeave={() => setActive(-1)}
                onClick={(_, i) => onSlice(data[i].id)}
                isAnimationActive={false}
                style={{ cursor: "pointer", outline: "none" }}
              >
                {data.map((d) => <Cell key={d.id} fill={d.fill} />)}
              </Pie>
            </PieChart>
          </ResponsiveContainer>
          {/* Centre label: the hovered slice, or the total when idle —
              so the doughnut hole earns its space instead of being a hole. */}
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none", textAlign: "center", padding: "0 42px" }}>
            <div className="text-[10px] uppercase tracking-wide text-[var(--muted)] truncate w-full">{shown ? shown.name : "Total"}</div>
            <div className="text-sm font-semibold num">{gbp0(shown ? shown.actual : total)}</div>
            {shown && total > 0 && <div className="text-[11px] text-[var(--muted)] num">{((shown.actual / total) * 100).toFixed(1)}%</div>}
          </div>
        </div>

        <div className="flex-1 min-w-[200px] space-y-0.5">
          {data.map((d, i) => (
            <button key={d.id}
              onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(-1)}
              onClick={() => onSlice(d.id)}
              className={"w-full flex items-center gap-2 text-xs px-1.5 py-1 rounded transition text-left " + (active === i ? "bg-[var(--panel2)]" : "")}
              title={`Show ${d.name} transactions`}>
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: d.fill }} />
              <span className="truncate flex-1">{d.name}</span>
              {d.essential && <span className="text-[9px] uppercase tracking-wide text-[var(--muted)] shrink-0">ess</span>}
              <span className="num shrink-0">{gbp0(d.actual)}</span>
              <span className="num text-[var(--muted)] shrink-0 w-11 text-right">{total > 0 ? `${((d.actual / total) * 100).toFixed(1)}%` : ""}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="text-xs text-[var(--muted)] mt-2">
        Click a slice or a row to see its transactions.
        {refunded.length > 0 && ` ${refunded.map((r) => r.name).join(", ")} ${refunded.length === 1 ? "is" : "are"} net negative for this period (refunds exceeded spending), so ${refunded.length === 1 ? "it isn't" : "they aren't"} shown — a negative slice would distort every other share.`}
      </p>
    </div>
  );
}

/* ----------------------------- Recurring ------------------------------ */
const REC_BLANK = () => ({ id: uid(), label: "", amount: "", frequency: "monthly", startDate: todayISO(), endDate: "", categoryId: "", account: "", alwaysInclude: false });

function Recurring({ recurring, setRecurring, categories, catById, suppressed, generated, spendTxns }) {
  const [r, setR] = useState(REC_BLANK());
  const annual = useMemo(() => annualCommitment(recurring, { asOf: todayISO() }), [recurring]);
  // Accounts already seen in imported statements — offered as suggestions
  // so the account label MATCHES, which is what drives suppression.
  const knownAccounts = useMemo(
    () => [...new Set(spendTxns.map((t) => t.account).filter(Boolean))].sort(),
    [spendTxns]
  );
  const suppressedBy = useMemo(() => {
    const m = new Map();
    for (const s of suppressed) m.set(s.recurringId, (m.get(s.recurringId) || 0) + 1);
    return m;
  }, [suppressed]);
  const generatedBy = useMemo(() => {
    const m = new Map();
    for (const g of generated) m.set(g.recurringId, (m.get(g.recurringId) || 0) + 1);
    return m;
  }, [generated]);

  // Auto-detect subscriptions/direct debits in the imported rows the user
  // hasn't already declared. Merchant keys of existing commitments are
  // passed so the same thing isn't re-suggested.
  const [dismissed, setDismissed] = useState(() => new Set());
  const detected = useMemo(() => {
    const existing = new Set(recurring.map((x) => normaliseMerchant(x.label)));
    return detectRecurring(spendTxns, { existingKeys: existing }).filter((d) => !dismissed.has(d.key));
  }, [spendTxns, recurring, dismissed]);
  const addDetected = (d) => {
    setRecurring((p) => [...p, {
      id: uid(), label: d.label, amount: d.amount, frequency: d.frequency,
      startDate: d.startDate, endDate: "", categoryId: d.categoryId || "", account: d.account || "", alwaysInclude: false,
    }]);
    setDismissed((s) => new Set(s).add(d.key));
  };

  const add = () => {
    if (!r.label.trim() || !(+r.amount) || !r.startDate) return;
    setRecurring((p) => [...p, { ...r, label: r.label.trim(), amount: +r.amount }]);
    setR(REC_BLANK());
  };
  const patch = (id, k, v) => setRecurring((p) => p.map((x) => (x.id === id ? { ...x, [k]: v } : x)));

  return (
    <div className="space-y-3">
      {detected.length > 0 && (
        <div className="rounded-xl border border-[var(--accent)] bg-[var(--panel)] p-3 space-y-2">
          <div className="text-sm font-semibold flex items-center gap-1.5"><Wand2 size={15} className="text-[var(--accent)]" /> {detected.length} possible recurring payment{detected.length > 1 ? "s" : ""} found in your imports</div>
          <div className="space-y-1.5">
            {detected.slice(0, 8).map((d) => (
              <div key={d.key} className="flex items-center gap-2 flex-wrap text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">
                <span className="font-medium text-[var(--fg)]">{d.label}</span>
                <span className="text-[var(--muted)]">{gbp(d.amount)} {d.frequency} · {d.charges} charges · ~{gbp0(d.annualEstimate)}/yr{d.account ? ` · ${d.account}` : ""}</span>
                {d.priceRose && <span className="text-[var(--m-bb)]" title={`Rose from ${gbp(d.priceFrom)} to ${gbp(d.priceTo)} — about +${gbp0(d.annualIncrease)}/yr`}>▲ price up {gbp(d.priceFrom)}→{gbp(d.priceTo)}</span>}
                <span className="ml-auto flex gap-2">
                  <button onClick={() => addDetected(d)} className="text-[var(--accent)] font-medium hover:underline">Add</button>
                  <button onClick={() => setDismissed((s) => new Set(s).add(d.key))} className="text-[var(--muted)] hover:text-[var(--fg)]">Dismiss</button>
                </span>
              </div>
            ))}
          </div>
          <p className="text-[11px] text-[var(--muted)]">Detected from same-merchant, regular-cadence, consistent-amount charges. Adding one creates a commitment you can edit below; it auto-suppresses in months your statement already covers.</p>
        </div>
      )}

      <h3 className="text-sm font-semibold">Recurring commitments</h3>
      <p className="text-xs text-[var(--muted)] max-w-3xl">
        Fixed outgoings you know about without reading a statement — direct debits, quarterly service charges, annual building insurance. Each one generates dated transactions automatically, so an account you never import still shows up in the budget.
      </p>
      <p className="text-xs text-[var(--muted)] max-w-3xl">
        <strong className="text-[var(--fg)]">No double counting:</strong> name the account each payment leaves from, and for any month where that account HAS imported statement rows, the estimate is suppressed — the statement wins, because it knows about the price rise you forgot. Estimates fill only the gaps: months you haven't imported, and the future.
      </p>

      <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))" }}>
        <Field label="What"><input value={r.label} onChange={(e) => setR({ ...r, label: e.target.value })} className="input w-full" placeholder="e.g. Mobile" /></Field>
        <Field label="Amount (£)"><input type="number" value={r.amount} onChange={(e) => setR({ ...r, amount: e.target.value })} className="input num w-full" placeholder="0.00" /></Field>
        <Field label="How often"><select value={r.frequency} onChange={(e) => setR({ ...r, frequency: e.target.value })} className="input w-full">{FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="First / next payment"><input type="date" value={r.startDate} onChange={(e) => setR({ ...r, startDate: e.target.value })} className="input num w-full" /></Field>
        <Field label="Ends (optional)"><input type="date" value={r.endDate} onChange={(e) => setR({ ...r, endDate: e.target.value })} className="input num w-full" /></Field>
        <Field label="Category"><select value={r.categoryId} onChange={(e) => setR({ ...r, categoryId: e.target.value })} className="input w-full"><option value="">Choose…</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Paid from">
          <input list="rec-accounts" value={r.account} onChange={(e) => setR({ ...r, account: e.target.value })} className="input w-full" placeholder="e.g. HSBC current" />
          <datalist id="rec-accounts">{knownAccounts.map((a) => <option key={a} value={a} />)}</datalist>
        </Field>
        <div className="flex items-end"><button onClick={add} className="btn-accent w-full justify-center"><Plus size={15} /> Add</button></div>
      </div>

      {recurring.length === 0 ? (
        <Empty msg="No recurring commitments yet. Add the direct debits and standing payments that don't arrive via a statement you import — mobile, broadband, council tax, service charge, building insurance." />
      ) : (
        <>
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["What", "Amount", "How often", "£/yr", "Category", "Paid from", "Status", ""].map((h, i) => (
                  <th key={i} className={"py-2 px-3 font-medium " + (i === 1 || i === 3 ? "text-right" : "text-left")}>{h}</th>
                ))}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {recurring.map((x) => {
                  const perYear = (+x.amount || 0) * (12 / (FREQUENCIES.find(([k]) => k === x.frequency) || FREQUENCIES[0])[2]);
                  const supp = suppressedBy.get(x.id) || 0, gen = generatedBy.get(x.id) || 0;
                  return (
                    <tr key={x.id}>
                      <td className="py-1.5 px-3"><input value={x.label} onChange={(e) => patch(x.id, "label", e.target.value)} className="input w-36 py-1" /></td>
                      <td className="py-1.5 px-3 text-right"><input type="number" value={x.amount} onChange={(e) => patch(x.id, "amount", +e.target.value || 0)} className="input num w-24 py-1 text-right" /></td>
                      <td className="py-1.5 px-3"><select value={x.frequency} onChange={(e) => patch(x.id, "frequency", e.target.value)} className="input py-1 text-xs">{FREQUENCIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></td>
                      <td className="py-1.5 px-3 text-right num">{gbp0(perYear)}</td>
                      <td className="py-1.5 px-3">
                        <select value={x.categoryId || ""} onChange={(e) => patch(x.id, "categoryId", e.target.value)} className="input py-1 text-xs">
                          <option value="">— none —</option>
                          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </td>
                      <td className="py-1.5 px-3 text-xs text-[var(--muted)]">{x.account || "—"}</td>
                      <td className="py-1.5 px-3 text-xs">
                        {supp > 0
                          ? <span className="text-[var(--muted)]" title={`${supp} month(s) already covered by an imported statement for ${x.account || "(no account)"} — using the statement instead`}>{gen} est · {supp} from statement</span>
                          : <span className="text-[var(--gain)]">{gen} estimated</span>}
                        {x.alwaysInclude && <span className="ml-1 text-[var(--m-bb)]" title="Suppression disabled — you're responsible for avoiding a double count">always</span>}
                      </td>
                      <td className="py-1.5 px-3 text-right">
                        <button onClick={() => removeWithUndo({ list: recurring, setList: setRecurring, id: x.id, label: x.label || "commitment" })} aria-label={`Delete ${x.label}`} title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-xs flex flex-wrap gap-x-6 gap-y-1">
            <span>Fixed commitments: <strong className="num">{gbp0(annual.total)}</strong>/yr — <span className="text-[var(--muted)]">{gbp0(annual.total / 12)}/month before any variable spending</span></span>
            {suppressed.length > 0 && <span className="text-[var(--muted)]">{suppressed.length} estimated payment(s) hidden where a statement already covers the month.</span>}
          </div>
        </>
      )}
    </div>
  );
}

/* -------------------------- Categories & rules ------------------------ */
function Categories({ categories, setCategories, rules, setRules, catById, txns }) {
  const [c, setC] = useState(CAT_BLANK());
  const [r, setR] = useState({ field: "description", op: "contains", value: "", categoryId: "" });
  const usage = useMemo(() => {
    const m = new Map();
    for (const t of txns) if (t.categorisedByRule) m.set(t.categorisedByRule, (m.get(t.categorisedByRule) || 0) + 1);
    return m;
  }, [txns]);

  const addCat = () => {
    if (!c.name.trim()) return;
    setCategories((p) => [...p, { ...c, name: c.name.trim(), monthly: +c.monthly || 0, annual: +c.annual || 0 }]);
    setC(CAT_BLANK());
  };
  const patchCat = (id, k, v) => setCategories((p) => p.map((x) => (x.id === id ? { ...x, [k]: v } : x)));
  const addRule = () => {
    if (!r.value || !r.categoryId) return;
    setRules((p) => [...p, { ...r, id: uid(), enabled: true }]);
    setR({ field: "description", op: "contains", value: "", categoryId: "" });
  };
  const move = (i, d) => setRules((p) => {
    const n = [...p], j = i + d;
    if (j < 0 || j >= n.length) return p;
    [n[i], n[j]] = [n[j], n[i]];
    return n;
  });

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Categories</h3>
        <p className="text-xs text-[var(--muted)] max-w-3xl">Give a category EITHER a monthly limit or an annual one. Annual-only categories (insurance, holidays, one big trip) are excluded from monthly budget comparisons and reconciled over the year instead — spreading them across 12 months would invent an overspend in the month they land and phantom headroom in the other eleven. "Essential" marks needs over wants: that split is what the retirement plan's income floor uses.</p>
        <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Field label="Name"><input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} className="input w-40" placeholder="e.g. Groceries" /></Field>
          <Field label="£ / month"><input type="number" value={c.monthly} onChange={(e) => setC({ ...c, monthly: e.target.value, annual: "" })} className="input num w-28" placeholder="0" /></Field>
          <Field label="or £ / year"><input type="number" value={c.annual} onChange={(e) => setC({ ...c, annual: e.target.value, monthly: "" })} className="input num w-28" placeholder="0" /></Field>
          <label className="flex items-center gap-1.5 text-xs pb-2"><input type="checkbox" checked={c.essential} onChange={(e) => setC({ ...c, essential: e.target.checked })} /> Essential</label>
          <label className="flex items-center gap-1.5 text-xs pb-2" title="Transfers and card payments aren't spending — excluded from every total"><input type="checkbox" checked={c.transfer} onChange={(e) => setC({ ...c, transfer: e.target.checked })} /> Transfer</label>
          <button onClick={addCat} className="btn-accent"><Plus size={15} /> Add</button>
        </div>
        {categories.length > 0 && (
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["Category", "£/month", "£/year", "Essential", "Transfer", ""].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i === 1 || i === 2 ? "text-right" : "text-left")}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {categories.map((x) => (
                  <tr key={x.id}>
                    <td className="py-1.5 px-3"><input value={x.name} onChange={(e) => patchCat(x.id, "name", e.target.value)} className="input w-40 py-1" /></td>
                    <td className="py-1.5 px-3 text-right"><input type="number" value={x.monthly || ""} onChange={(e) => patchCat(x.id, "monthly", +e.target.value || 0)} className="input num w-24 py-1 text-right" placeholder="—" /></td>
                    <td className="py-1.5 px-3 text-right"><input type="number" value={x.annual || ""} onChange={(e) => patchCat(x.id, "annual", +e.target.value || 0)} className="input num w-24 py-1 text-right" placeholder="—" /></td>
                    <td className="py-1.5 px-3"><input type="checkbox" checked={!!x.essential} onChange={(e) => patchCat(x.id, "essential", e.target.checked)} /></td>
                    <td className="py-1.5 px-3"><input type="checkbox" checked={!!x.transfer} onChange={(e) => patchCat(x.id, "transfer", e.target.checked)} /></td>
                    <td className="py-1.5 px-3 text-right"><button onClick={() => removeWithUndo({ list: categories, setList: setCategories, id: x.id, label: `category ${x.name}` })} aria-label={`Delete category ${x.name}`} title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-sm font-semibold">Rules</h3>
        <p className="text-xs text-[var(--muted)] max-w-3xl">Checked in order, first match wins — drag the important ones up with the arrows. Rules apply to ALL history the moment you save them, not just future imports, so fixing a rule fixes the past too. Anything you categorise by hand always beats a rule.</p>
        <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Field label="When description"><select value={r.op} onChange={(e) => setR({ ...r, op: e.target.value })} className="input">{OPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Value"><input value={r.value} onChange={(e) => setR({ ...r, value: e.target.value })} className="input w-44" placeholder="e.g. TESCO" /></Field>
          <Field label="Category"><select value={r.categoryId} onChange={(e) => setR({ ...r, categoryId: e.target.value })} className="input"><option value="">Choose…</option>{categories.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <button onClick={addRule} className="btn-accent"><Plus size={15} /> Add rule</button>
        </div>
        {rules.length === 0 ? (
          <Empty msg="No rules yet. The fastest way to make them: go to Transactions, categorise a merchant group, and use the '+ rule…' column — it writes the rule for you." />
        ) : (
          <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                <tr>{["#", "Rule", "Category", "Matches", "On", ""].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i === 3 ? "text-right" : "text-left")}>{h}</th>)}</tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                {rules.map((x, i) => (
                  <tr key={x.id}>
                    <td className="py-1.5 px-3 num text-[var(--muted)] whitespace-nowrap">
                      {i + 1}
                      <button onClick={() => move(i, -1)} disabled={i === 0} className="ml-1 disabled:opacity-30 hover:text-[var(--fg)]" aria-label="Move rule up">↑</button>
                      <button onClick={() => move(i, 1)} disabled={i === rules.length - 1} className="ml-0.5 disabled:opacity-30 hover:text-[var(--fg)]" aria-label="Move rule down">↓</button>
                    </td>
                    <td className="py-1.5 px-3 text-xs">{(OPS.find(([v]) => v === x.op) || [])[1]} <span className="font-mono">{x.value}</span></td>
                    <td className="py-1.5 px-3">{catById[x.categoryId]?.name || <span className="text-[var(--loss)]">deleted category</span>}</td>
                    <td className="py-1.5 px-3 text-right num text-[var(--muted)]">{usage.get(x.id) || 0}</td>
                    <td className="py-1.5 px-3"><input type="checkbox" checked={x.enabled !== false} onChange={(e) => setRules((p) => p.map((y) => (y.id === x.id ? { ...y, enabled: e.target.checked } : y)))} /></td>
                    <td className="py-1.5 px-3 text-right"><button onClick={() => removeWithUndo({ list: rules, setList: setRules, id: x.id, label: "rule" })} aria-label="Delete rule" title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* --------------------------- Import statements ------------------------ */
const rowKey = (r) => `${r.date}|${r.description}|${r.amount}`;

function ImportStatements({ spendTxns, setSpendTxns, setSub }) {
  const [profile, setProfile] = useState("auto");
  const [account, setAccount] = useState("");
  const [fxRate, setFxRate] = useState(1);      // Revolut foreign-currency conversion
  const [fileText, setFileText] = useState(null);
  const [fileName, setFileName] = useState("");
  const [flip, setFlip] = useState(false);
  const [excluded, setExcluded] = useState(() => new Set()); // rows the user removed
  const fileRef = useRef(null);

  const onFile = async (f) => {
    if (!f) return;
    setFileText(await f.text());
    setFileName(f.name);
    setFlip(false);
    setExcluded(new Set());
  };
  // Re-parse whenever the file, profile, account or FX rate changes — so
  // changing the Revolut rate updates the preview live.
  const parsed = useMemo(() => {
    if (!fileText) return null;
    return parseStatement(fileText, { profile, account: account || undefined, fxRate: +fxRate || 1 });
  }, [fileText, profile, account, fxRate]);

  const rows = useMemo(() => {
    if (!parsed?.rows?.length) return [];
    const base = flip ? parsed.rows.map((r) => ({ ...r, amount: -r.amount })) : parsed.rows;
    return base.filter((r) => !excluded.has(rowKey(r)));
  }, [parsed, flip, excluded]);
  const dedup = useMemo(() => (rows.length ? dedupeStatement(rows, spendTxns) : null), [rows, spendTxns]);

  const commit = () => {
    if (!dedup?.rows.length) return;
    setSpendTxns((p) => [...p, ...dedup.rows.map((r) => ({ ...r, id: uid() }))]);
    setFileText(null); setFileName(""); setExcluded(new Set());
    if (fileRef.current) fileRef.current.value = "";
    setSub("txns");
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold">Import a statement</h3>
      <p className="text-xs text-[var(--muted)] max-w-3xl">
        CSV exports from your bank or card provider. Everything is parsed and stored ON THIS DEVICE — statement data never leaves the browser except through your own encrypted sync or backup file. Re-importing an overlapping period is safe: identical rows are detected and skipped.
      </p>

      <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <Field label="Format"><select value={profile} onChange={(e) => setProfile(e.target.value)} className="input">{Object.entries(PROFILES).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}</select></Field>
        <Field label="Account label (optional)"><input value={account} onChange={(e) => setAccount(e.target.value)} className="input w-40" placeholder="e.g. Amex Gold" /></Field>
        {profile === "revolut" && (
          <Field label="FX → GBP (foreign rows)"><input type="number" step="0.01" value={fxRate} onChange={(e) => setFxRate(e.target.value)} className="input num w-28" title="Revolut exports each transaction in its own currency. Set the £-per-unit rate for the statement period (e.g. 0.86 for EUR); GBP rows are unaffected." /></Field>
        )}
        <Field label="CSV file"><input ref={fileRef} type="file" accept=".csv,text/csv" onChange={(e) => onFile(e.target.files?.[0])} className="input text-xs py-1.5" /></Field>
      </div>

      {parsed && (
        <div className="space-y-2">
          {parsed.warnings?.map((w, i) => (
            <div key={i} className="text-xs rounded-lg border border-[var(--m-bb)] bg-[var(--panel)] px-3 py-2 flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />{w}
            </div>
          ))}
          {!rows.length ? null : (
            <>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-xs space-y-2">
                <div className="flex flex-wrap gap-x-5 gap-y-1">
                  <span><strong>{parsed.meta.count}</strong> rows · {parsed.meta.dateRange?.[0]} → {parsed.meta.dateRange?.[1]}</span>
                  <span className="text-[var(--muted)]">{dedup.rows.length} new, {dedup.duplicates.length} already imported</span>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[var(--muted)]">Read as: spending is <strong>{parsed.meta.signConvention === "spend-positive" ? "positive" : "negative"}</strong> in this file.</span>
                  <button onClick={() => setFlip((f) => !f)} className="underline decoration-dotted text-[var(--accent)]">
                    {flip ? "undo flip" : "the preview looks inverted — flip it"}
                  </button>
                </div>
                <p className="text-[var(--muted)]">Check a few rows below: normal purchases should show as POSITIVE amounts, refunds and salary/payments as negative.</p>
              </div>
              {/* ALL rows are shown (scrollable), each removable — so you
                  can drop the odd row you don't want before importing,
                  rather than only previewing the first few. */}
              <div className="rounded-xl border border-[var(--border)] overflow-auto" style={{ maxHeight: 420 }}>
                <table className="w-full text-sm">
                  <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide sticky top-0">
                    <tr>{["Date", "Description", "Amount", "", ""].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i === 2 ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                    {rows.map((r) => {
                      const dupe = dedup.duplicates.some((d) => d.date === r.date && d.description === r.description && d.amount === r.amount);
                      return (
                        <tr key={rowKey(r)} className={dupe ? "opacity-45" : ""}>
                          <td className="py-1.5 px-3 num text-[var(--muted)] whitespace-nowrap">{r.date}</td>
                          <td className="py-1.5 px-3">{r.description}</td>
                          <td className={"py-1.5 px-3 text-right num " + (r.amount < 0 ? "text-[var(--gain)]" : "")}>{gbp(r.amount)}</td>
                          <td className="py-1.5 px-3 text-xs text-[var(--muted)] whitespace-nowrap">{dupe ? "already imported" : ""}</td>
                          <td className="py-1.5 px-3 text-right">
                            <button onClick={() => setExcluded((s) => new Set(s).add(rowKey(r)))} aria-label={`Remove ${r.description} from this import`} title="Remove from this import" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={14} aria-hidden="true" /></button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                <button onClick={commit} disabled={!dedup.rows.length} className="btn-accent disabled:opacity-50">
                  <Upload size={15} /> Import {dedup.rows.length} transaction{dedup.rows.length === 1 ? "" : "s"}
                </button>
                {excluded.size > 0 && <button onClick={() => setExcluded(new Set())} className="text-xs text-[var(--accent)] underline underline-offset-2">restore {excluded.size} removed</button>}
                <span className="text-xs text-[var(--muted)]">Showing all {rows.length} rows{excluded.size ? ` (${excluded.size} removed)` : ""} — remove any you don't want with the bin icon.</span>
              </div>
            </>
          )}
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)] space-y-1.5">
        <div className="font-medium text-[var(--fg)] flex items-center gap-1.5"><Check size={13} /> Getting the CSV</div>
        <p><strong>Amex</strong>: Statements → choose a period → Download → CSV. <strong>HSBC</strong>: Online banking → account → Download transactions → CSV (headerless exports are handled). <strong>Revolut</strong>: app or web → Statement → Excel/CSV; exchanges, top-ups and pending rows are skipped automatically, and foreign-currency rows are converted at the FX rate you set.</p>
        <p>The parser detects columns from the header, or by position when there isn't one, and works out the sign convention from the balance of debits to credits — then shows you what it decided before anything is saved. If a bank's format defeats it, the warnings above say what was missing rather than importing a half-read file.</p>
      </div>
    </div>
  );
}
