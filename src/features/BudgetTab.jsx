import React, { useState, useMemo, useRef } from "react";
import { Plus, Trash2, Upload, Sparkles, Check, AlertTriangle, Wand2 } from "lucide-react";
import { ResponsiveContainer, ComposedChart, Bar, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { monthlyBudget, annualBudget, spendByMonth, trailing12 } from "../core/budget.mjs";
import { categoriseAll, learnMerchants, uncategorisedGroups, suggestRule, normaliseMerchant } from "../core/categorise.mjs";
import { parseStatement, dedupeStatement, PROFILES } from "../core/statement-import.mjs";
import { store, gbp, gbp0, SubTabs, uid, todayISO, Field, Empty, Stat, useSort, sortRows, SortTh } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

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

export default function BudgetTab({ setTab }) {
  const categories = useAppStore((s) => s.budgetCategories), setCategories = useAppStore((s) => s.setBudgetCategories);
  const rules = useAppStore((s) => s.budgetRules), setRules = useAppStore((s) => s.setBudgetRules);
  const spendTxns = useAppStore((s) => s.spendTxns), setSpendTxns = useAppStore((s) => s.setSpendTxns);

  const [sub, setSub] = useState(() => store.get("cgt.budgetsubtab", "overview"));
  React.useEffect(() => store.set("cgt.budgetsubtab", sub), [sub]);
  const [month, setMonth] = useState(thisMonth);

  // Derived categorisation — see header. Merchant memory is learned from
  // the user's own manual decisions on every render, so one correction
  // teaches every future row without a save step.
  const merchantMap = useMemo(() => learnMerchants(spendTxns), [spendTxns]);
  const txns = useMemo(() => categoriseAll(spendTxns, { rules, merchantMap }), [spendTxns, rules, merchantMap]);

  const catById = useMemo(() => Object.fromEntries(categories.map((c) => [c.id, c])), [categories]);
  const seedStarter = () => setCategories(STARTER.map((c) => ({ id: uid(), name: c.name, monthly: c.monthly || 0, annual: c.annual || 0, essential: !!c.essential, transfer: !!c.transfer })));

  const setManual = (ids, categoryId) => {
    const set = new Set(Array.isArray(ids) ? ids : [ids]);
    setSpendTxns((p) => p.map((t) => (set.has(t.id) ? { ...t, manualCategoryId: categoryId || undefined } : t)));
  };

  return (
    <div className="space-y-5">
      <SubTabs
        tabs={[["overview", "Overview"], ["txns", "Transactions"], ["categories", "Categories & rules"], ["import", "Import statements"]]}
        active={sub} onChange={setSub}
      />

      {!categories.length && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-2">
          <div className="text-sm font-semibold">Start with a category set</div>
          <p className="text-xs text-[var(--muted)] max-w-2xl">Budgeting needs categories before anything else works. These eleven cover most UK households — rename, re-limit or delete any of them afterwards. "Card payment / transfer" is flagged as a transfer, so paying your Amex from HSBC doesn't get counted as a second pound of spending.</p>
          <button onClick={seedStarter} className="btn-accent"><Wand2 size={15} /> Create starter categories</button>
        </div>
      )}

      {sub === "overview" && <Overview {...{ categories, txns, month, setMonth, setSub }} />}
      {sub === "txns" && <Transactions {...{ categories, catById, txns, setManual, setSpendTxns, rules, setRules }} />}
      {sub === "categories" && <Categories {...{ categories, setCategories, rules, setRules, catById, txns }} />}
      {sub === "import" && <ImportStatements {...{ spendTxns, setSpendTxns, setSub }} />}
    </div>
  );
}

/* ------------------------------- Overview ---------------------------- */
function Overview({ categories, txns, month, setMonth, setSub }) {
  const [view, setView] = useState("month");
  const m = useMemo(() => monthlyBudget({ categories, txns, month }), [categories, txns, month]);
  const a = useMemo(() => annualBudget({ categories, txns, month }), [categories, txns, month]);
  const trend = useMemo(() => spendByMonth({ categories, txns, months: trailing12(month) }), [categories, txns, month]);
  const cur = view === "month" ? m : a;
  const s = cur.summary;

  if (!txns.length) {
    return <Empty msg="No spending imported yet. Use the Import statements sub-tab to load an Amex or HSBC CSV export, then categorise the rows." />;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="Month"><input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="input num" /></Field>
        <div className="flex gap-1.5 pb-0.5">
          {[["month", "This month"], ["year", "Trailing 12 months"]].map(([k, label]) => (
            <button key={k} onClick={() => setView(k)}
              className={"text-xs font-medium px-2.5 py-1.5 rounded-full border transition " +
                (view === k ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))" }}>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><Stat label="Spent" value={gbp0(s.totalActual)} sub={view === "month" ? month : `${s.monthsCovered} months`} /></div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3"><Stat label="Budget" value={gbp0(s.totalLimit)} sub={view === "month" ? "monthly limits only" : "incl. annual categories"} /></div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Stat label={s.variance >= 0 ? "Under budget" : "Over budget"} value={gbp0(Math.abs(s.variance))} tone={s.variance >= 0 ? "green" : "red"} sub={`${s.overCount ?? cur.rows.filter((r) => r.over).length} categor${(s.overCount ?? 0) === 1 ? "y" : "ies"} over`} />
        </div>
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <Stat label="Essential share" value={view === "year" && s.essentialPct != null ? `${Math.round(s.essentialPct)}%` : gbp0(s.essentialActual)} sub={`discretionary ${gbp0(s.discretionaryActual)}`} />
        </div>
      </div>

      {s.uncategorised > 0 && (
        <button onClick={() => setSub("txns")} className="w-full text-left rounded-xl border border-[var(--m-bb)] bg-[var(--panel)] p-3 text-xs flex items-start gap-2 hover:bg-[var(--panel2)] transition">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
          <span><strong>{gbp(s.uncategorised)}</strong> of spending isn't categorised{view === "month" ? " this month" : " over the year"}, so it's missing from every figure above. Categorise it →</span>
        </button>
      )}

      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        <div className="text-xs font-medium text-[var(--muted)] mb-1.5">Spend by month vs monthly budget</div>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="month" tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
            <YAxis tickFormatter={gbp0} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={60} />
            <Tooltip contentStyle={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
              formatter={(v, n) => [gbp(v), { essential: "Essential", discretionary: "Discretionary", limit: "Monthly budget", uncategorised: "Uncategorised" }[n] || n]} />
            <Bar dataKey="essential" stackId="s" fill="var(--accent)" name="essential" />
            <Bar dataKey="discretionary" stackId="s" fill="var(--m-pool)" name="discretionary" />
            <Bar dataKey="uncategorised" stackId="s" fill="var(--muted)" fillOpacity={0.5} name="uncategorised" />
            <Line type="stepAfter" dataKey="limit" stroke="var(--fg)" strokeWidth={1.5} strokeDasharray="5 4" dot={false} name="limit" />
          </ComposedChart>
        </ResponsiveContainer>
        <p className="text-xs text-[var(--muted)] mt-1.5">The budget line is MONTHLY limits only — annual categories (insurance, holidays) aren't spread across months, so the month they land in will overshoot the line by design rather than by overspending.</p>
      </div>

      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Category", "Spent", "Budget", "Left", "", ""].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i === 0 ? "text-left" : i > 3 ? "text-left" : "text-right")}>{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {cur.rows.map((r) => (
              <tr key={r.id} className="hover:bg-[var(--panel2)]">
                <td className="py-2 px-3">
                  {r.name}
                  {r.essential && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--muted)]">essential</span>}
                  {r.annualOnly && <span className="ml-1.5 text-[10px] uppercase tracking-wide text-[var(--m-pool)]">annual</span>}
                </td>
                <td className="py-2 px-3 text-right num">{gbp(r.actual)}</td>
                <td className="py-2 px-3 text-right num text-[var(--muted)]">{r.limit == null ? "—" : gbp(r.limit)}</td>
                <td className={"py-2 px-3 text-right num " + (r.variance == null ? "text-[var(--muted)]" : r.variance < 0 ? "text-[var(--loss)]" : "text-[var(--gain)]")}>
                  {r.variance == null ? "—" : gbp(r.variance)}
                </td>
                <td className="py-2 px-3" style={{ width: 120 }}>
                  {r.pctUsed != null && (
                    <div className="h-1.5 rounded-full bg-[var(--panel2)] overflow-hidden" title={`${Math.round(r.pctUsed)}% of budget`}>
                      <div className="h-full rounded-full" style={{ width: `${Math.min(100, r.pctUsed)}%`, background: r.over ? "var(--loss)" : "var(--gain)" }} />
                    </div>
                  )}
                </td>
                <td className="py-2 px-3 text-xs text-[var(--muted)] num">{r.pctUsed != null ? `${Math.round(r.pctUsed)}%` : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------------- Transactions -------------------------- */
function Transactions({ categories, catById, txns, setManual, setSpendTxns, rules, setRules }) {
  const [sort, toggleSort] = useSort("date", "desc");
  const [filter, setFilter] = useState("uncat");
  const groups = useMemo(() => uncategorisedGroups(txns), [txns]);
  const shown = useMemo(() => {
    if (filter === "uncat") return txns.filter((t) => !t.categoryId);
    if (filter === "all") return txns;
    return txns.filter((t) => t.categoryId === filter);
  }, [txns, filter]);

  const [busyAi, setBusyAi] = useState(false);
  const [aiMsg, setAiMsg] = useState("");
  const suggestWithAi = async () => {
    setBusyAi(true); setAiMsg("");
    try {
      const top = groups.slice(0, 40).map((g) => g.sample);
      const res = await fetch("/api/categorise", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ descriptions: top, categories: categories.filter((c) => !c.transfer).map((c) => c.name) }),
      });
      const data = await res.json();
      if (!res.ok) {
        // Surface the endpoint's env diagnostics inline — a setup problem
        // the user can only fix in the Vercel dashboard shouldn't require
        // opening DevTools to read.
        const d = data.diagnostics;
        throw new Error(data.error + (d?.matchingNames?.length ? ` Names seen: ${d.matchingNames.join(", ")}.` : ""));
      }
      // Map suggested category NAMES back to ids; ignore anything that
      // doesn't match a real category rather than inventing one.
      const byName = new Map(categories.map((c) => [c.name.toLowerCase(), c.id]));
      let applied = 0;
      const assignments = [];
      for (const [desc, name] of Object.entries(data.suggestions || {})) {
        const id = byName.get(String(name).toLowerCase());
        if (!id) continue;
        const key = normaliseMerchant(desc);
        const g = groups.find((x) => x.key === key);
        if (!g) continue;
        assignments.push([g.ids, id]); applied += g.count;
      }
      setSpendTxns((p) => {
        const map = new Map();
        for (const [ids, id] of assignments) for (const i of ids) map.set(i, id);
        return p.map((t) => (map.has(t.id) ? { ...t, manualCategoryId: map.get(t.id) } : t));
      });
      setAiMsg(applied ? `Suggested categories for ${applied} transaction(s) — they're applied as your own choices, so review and correct any that look wrong.` : "No confident suggestions came back.");
    } catch (e) { setAiMsg(e.message); }
    setBusyAi(false);
  };

  const addRuleFromGroup = (g, categoryId) => {
    const r = suggestRule(g, categoryId);
    if (!r) return;
    setRules((p) => [...p, { ...r, id: uid() }]);
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <select value={filter} onChange={(e) => setFilter(e.target.value)} className="input">
          <option value="uncat">Uncategorised ({txns.filter((t) => !t.categoryId).length})</option>
          <option value="all">All ({txns.length})</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {groups.length > 0 && categories.length > 0 && (
          <button onClick={suggestWithAi} disabled={busyAi} className="btn-accent disabled:opacity-60">
            <Sparkles size={15} /> {busyAi ? "Asking…" : "Suggest categories with AI"}
          </button>
        )}
      </div>
      {aiMsg && <div role="status" className="text-xs rounded-lg border border-[var(--border)] bg-[var(--panel2)] px-3 py-2">{aiMsg}</div>}
      {groups.length > 0 && categories.length > 0 && (
        <p className="text-xs text-[var(--muted)] max-w-3xl">AI suggestions send only the merchant descriptions (no amounts, dates, account numbers or balances) to this app's own serverless endpoint, and only when you press the button. Suggestions are applied as manual choices you can correct — and each correction teaches the merchant memory, so the same shop categorises itself next time.</p>
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
                  <td className="py-2 px-3">{t.description}</td>
                  <td className="py-2 px-3 text-[var(--muted)]">{t.account || "—"}</td>
                  <td className={"py-2 px-3 text-right num " + (t.amount < 0 ? "text-[var(--gain)]" : "")}>{gbp(t.amount)}</td>
                  <td className="py-2 px-3">
                    <select className="input text-xs" value={t.categoryId || ""} onChange={(e) => setManual(t.id, e.target.value)}>
                      <option value="">— none —</option>
                      {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </td>
                  <td className="py-2 px-3 text-xs text-[var(--muted)]">
                    {t.categorisedVia === "manual" ? "you" : t.categorisedVia === "rule" ? "rule" : t.categorisedVia === "merchant" ? "learned" : "—"}
                  </td>
                  <td className="py-2 px-3 text-right">
                    <button onClick={() => setSpendTxns((p) => p.filter((x) => x.id !== t.id))} aria-label={`Delete transaction ${t.date} ${t.description}`} title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button>
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
                    <td className="py-1.5 px-3 text-right"><button onClick={() => setCategories((p) => p.filter((y) => y.id !== x.id))} aria-label={`Delete category ${x.name}`} title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button></td>
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
                    <td className="py-1.5 px-3 text-right"><button onClick={() => setRules((p) => p.filter((y) => y.id !== x.id))} aria-label="Delete rule" title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button></td>
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
