import React, { useState, useMemo, useRef } from "react";
import { Plus, Trash2, Upload, Check, AlertTriangle, Wand2 } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip, PieChart, Pie, Cell, Sector } from "recharts";
import { monthlyBudget, annualBudget, spendByMonth, trailing12, mergedSpend, spendByCategory, withComparison, monthRange } from "../core/budget.mjs";
import { uncategorisedGroups, suggestRule } from "../core/categorise.mjs";
import { parseStatement, dedupeStatement, PROFILES } from "../core/statement-import.mjs";
import { expandRecurring, statementCoverage, annualCommitment, FREQUENCIES } from "../core/recurring.mjs";
import { store, gbp, gbp0, SubTabs, uid, todayISO, Field, Empty, Stat, useSort, sortRows, SortTh } from "../ui/shared.jsx";
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

export default function BudgetTab({ setTab }) {
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

      {sub === "overview" && <Overview {...{ categories, txns, month, setMonth, setSub, drillTo, incomeEntries }} />}
      {sub === "txns" && <Transactions {...{ categories, catById, txns, spendTxns, setManual, setSpendTxns, rules, setRules, filter: txnFilter, setFilter: setTxnFilter }} />}
      {sub === "recurring" && <Recurring {...{ recurring, setRecurring, categories, catById, suppressed: recurringOut.suppressed, generated: recurringOut.rows, spendTxns }} />}
      {sub === "categories" && <Categories {...{ categories, setCategories, rules, setRules, catById, txns }} />}
      {sub === "import" && <ImportStatements {...{ spendTxns, setSpendTxns, setSub }} />}
    </div>
  );
}

/* ------------------------------- Overview ---------------------------- */
function Overview({ categories, txns, month, setMonth, setSub, drillTo, incomeEntries = [] }) {
  // Trailing 12 months is the DEFAULT because it's the honest picture: a
  // single month is noisy (annual bills, holidays, a quiet fortnight) and
  // the year is what the retirement plan actually consumes. This/Last
  // month are one tap away for "did I overspend recently?".
  const [view, setView] = useState(() => store.get("cgt.budget.view", "year"));
  React.useEffect(() => store.set("cgt.budget.view", view), [view]);
  const m = useMemo(() => monthlyBudget({ categories, txns, month }), [categories, txns, month]);
  const a = useMemo(() => annualBudget({ categories, txns, month }), [categories, txns, month]);
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
  const compared = useMemo(() => {
    const base = view === "month" ? prevMonth(month) : null;
    const rowsIn = (view === "month" ? m : a).rows;
    if (view === "month") {
      const baseline = spendByCategory({ categories, txns, months: [base] });
      return withComparison(rowsIn, { baseline, label: "vs prev month" });
    }
    // year view: average of the 12 months BEFORE this window
    const [y, mo] = month.split("-").map(Number);
    const priorEnd = mo === 1 ? `${y - 1}-12` : `${y}-${String(mo - 1).padStart(2, "0")}`;
    const priorMonths = monthRange(monthRange(`${y - 2}-01`, priorEnd).slice(-12)[0], priorEnd);
    const spent = spendByCategory({ categories, txns, months: priorMonths });
    const avg = new Map([...spent].map(([k, v]) => [k, v])); // prior-year total = comparable annual baseline
    return withComparison(rowsIn, { baseline: avg, label: "vs prior 12m" });
  }, [view, m, a, categories, txns, month]);
  const cur = { ...(view === "month" ? m : a), rows: compared };
  const s = cur.summary;
  const tm = thisMonth();
  // Any month other than the current one is reached through the picker
  // rather than a button, so it gets no highlighted pill.
  const activePeriod = view === "year" ? "year" : month === tm ? "this" : "month";

  if (!txns.length) {
    return <Empty msg="No spending imported yet. Use the Import statements sub-tab to load an Amex or HSBC CSV export, then categorise the rows." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex gap-1.5">
          {[
            ["year", "Trailing 12 months", () => setView("year")],
            ["this", "This month", () => { setView("month"); setMonth(tm); }],
          ].map(([k, label, onClick]) => (
            <button key={k} onClick={onClick}
              className={"text-xs font-medium px-2.5 py-1.5 rounded-full border transition " +
                (activePeriod === k ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
              {label}
            </button>
          ))}
        </div>
        <Field label={view === "year" ? "12 months ending" : "Month"}>
          <input type="month" value={month} onChange={(e) => { setMonth(e.target.value); }} className="input num" />
        </Field>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><Stat label="Spent" value={gbp0(s.totalActual)} sub={view === "month" ? month : `12 months to ${month}`} /></div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><Stat label="Budget" value={gbp0(s.totalLimit)} sub={view === "month" ? "monthly limits only" : "incl. annual categories"} /></div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Stat label={s.variance >= 0 ? "Under budget" : "Over budget"} value={gbp0(Math.abs(s.variance))} tone={s.variance >= 0 ? "green" : "red"} sub={`${s.overCount ?? cur.rows.filter((r) => r.over).length} categor${(s.overCount ?? 0) === 1 ? "y" : "ies"} over`} />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Stat label="Essential share" value={view === "year" && s.essentialPct != null ? `${Math.round(s.essentialPct)}%` : gbp0(s.essentialActual)} sub={`discretionary ${gbp0(s.discretionaryActual)}`} />
        </div>
      </div>

      {/* INCOME ↔ SPENDING — the two adjacent halves of a household finally
          on one line. Investment income comes from the Income tab's ledger
          (dividends + interest received in the window); spending is this
          view's own total. It answers "does what comes in cover what goes
          out?" without hopping between tabs. */}
      {(() => {
        const window = view === "month" ? [month] : trailing12(month);
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

      {s.uncategorised > 0 && (
        <button onClick={() => setSub("txns")} className="w-full text-left rounded-xl border border-[var(--m-bb)] bg-[var(--panel)] p-3 text-xs flex items-start gap-2 hover:bg-[var(--panel2)] transition">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
          <span><strong>{gbp(s.uncategorised)}</strong> of spending isn't categorised{view === "month" ? " this month" : " over the year"}, so it's missing from every figure above. Categorise it →</span>
        </button>
      )}

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
            {/* Essential vs discretionary must read apart at a glance, so
                they're indigo vs amber. NOT --accent/--m-pool, which are
                the SAME hex (#4338ca) in light mode and two shades of
                indigo in dark — invisible as a distinction. */}
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

      <CategoryPie rows={cur.rows} total={s.totalActual} onSlice={drillTo}
        periodLabel={view === "month" ? month : `12 months to ${month}`} />

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
    </div>
  );
}

/* ----------------------------- Transactions -------------------------- */
function Transactions({ categories, catById, txns, spendTxns, setManual, setSpendTxns, rules, setRules, filter, setFilter }) {
  const [sort, toggleSort] = useSort("date", "desc");
  const groups = useMemo(() => uncategorisedGroups(txns), [txns]);
  const shown = useMemo(() => {
    if (filter === "uncat") return txns.filter((t) => !t.categoryId);
    if (filter === "all") return txns;
    return txns.filter((t) => t.categoryId === filter);
  }, [txns, filter]);

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
                  <td className="py-2 px-3 num text-[var(--muted)]">{t.date}</td>
                  <td className="py-2 px-3">
                    {t.description}
                    {t.estimated && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--m-bb)]" title="Generated from a recurring commitment — not from a statement">est</span>}
                  </td>
                  <td className="py-2 px-3 text-[var(--muted)]">{t.account || "—"}</td>
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
          {shown.length > 400 && <p className="text-xs text-[var(--muted)] p-2">Showing the first 400 of {shown.length} — narrow with the filter above.</p>}
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

  const add = () => {
    if (!r.label.trim() || !(+r.amount) || !r.startDate) return;
    setRecurring((p) => [...p, { ...r, label: r.label.trim(), amount: +r.amount }]);
    setR(REC_BLANK());
  };
  const patch = (id, k, v) => setRecurring((p) => p.map((x) => (x.id === id ? { ...x, [k]: v } : x)));

  return (
    <div className="space-y-3">
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
function ImportStatements({ spendTxns, setSpendTxns, setSub }) {
  const [profile, setProfile] = useState("auto");
  const [account, setAccount] = useState("");
  const [parsed, setParsed] = useState(null);
  const [flip, setFlip] = useState(false);
  const fileRef = useRef(null);

  const onFile = async (f) => {
    if (!f) return;
    const text = await f.text();
    const res = parseStatement(text, { profile, account: account || undefined });
    setParsed({ ...res, fileName: f.name });
    setFlip(false);
  };

  const rows = useMemo(() => {
    if (!parsed?.rows?.length) return [];
    return flip ? parsed.rows.map((r) => ({ ...r, amount: -r.amount })) : parsed.rows;
  }, [parsed, flip]);
  const dedup = useMemo(() => (rows.length ? dedupeStatement(rows, spendTxns) : null), [rows, spendTxns]);

  const commit = () => {
    if (!dedup?.rows.length) return;
    setSpendTxns((p) => [...p, ...dedup.rows.map((r) => ({ ...r, id: uid() }))]);
    setParsed(null);
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
              <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                    <tr>{["Date", "Description", "Amount", ""].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i === 2 ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                    {rows.slice(0, 12).map((r, i) => {
                      const dupe = dedup.duplicates.some((d) => d.date === r.date && d.description === r.description && d.amount === r.amount);
                      return (
                        <tr key={i} className={dupe ? "opacity-45" : ""}>
                          <td className="py-1.5 px-3 num text-[var(--muted)]">{r.date}</td>
                          <td className="py-1.5 px-3">{r.description}</td>
                          <td className={"py-1.5 px-3 text-right num " + (r.amount < 0 ? "text-[var(--gain)]" : "")}>{gbp(r.amount)}</td>
                          <td className="py-1.5 px-3 text-xs text-[var(--muted)]">{dupe ? "already imported" : ""}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <button onClick={commit} disabled={!dedup.rows.length} className="btn-accent disabled:opacity-50">
                <Upload size={15} /> Import {dedup.rows.length} transaction{dedup.rows.length === 1 ? "" : "s"}
              </button>
            </>
          )}
        </div>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)] space-y-1.5">
        <div className="font-medium text-[var(--fg)] flex items-center gap-1.5"><Check size={13} /> Getting the CSV</div>
        <p><strong>Amex</strong>: Statements → choose a period → Download → CSV. <strong>HSBC</strong>: Online banking → account → Download transactions → CSV (headerless exports are handled).</p>
        <p>The parser detects columns from the header, or by position when there isn't one, and works out the sign convention from the balance of debits to credits — then shows you what it decided before anything is saved. If a bank's format defeats it, the warnings above say what was missing rather than importing a half-read file.</p>
      </div>
    </div>
  );
}
