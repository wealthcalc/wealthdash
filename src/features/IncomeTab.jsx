import React, { useState, useMemo, useCallback, useRef } from "react";
import { Plus, Trash2, AlertTriangle, Check } from "lucide-react";
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from "recharts";
import { ukTaxYear } from "../core/cgt-engine.mjs";
import { WRAPPERS, isWrapperTaxable, normWrapper } from "../core/portfolio.mjs";
import { investmentIncomeTax } from "../core/uk-tax.mjs";
import { addMonthsISO } from "../core/ishares-eri.mjs";
import { summariseBySource } from "../core/income-calendar.mjs";
import { store, unitsHeldAt, gbp, SubTabs, num, uid, todayISO, fxToGBP, Field, Empty, useSort, sortRows, SortTh, CurrencyInput, downloadText } from "../ui/shared.jsx";
import { taxSummaryText } from "../core/export-csv.mjs";
import useAppStore from "../state/appStore.js";
import { removeWithUndo } from "../ui/undo.jsx";

// Fixed wrapper → colour mapping so the same wrapper reads as the same
// colour everywhere this chart appears — unlike AllocBar's index-based
// palette (fine for an arbitrary breakdown), a stacked year-on-year chart
// needs the same wrapper to keep its colour as bars are added/removed
// across years. Reuses the app's existing CSS custom-property palette
// (the --m-* variables are otherwise used for CGT matching-rule badges).
const WRAPPER_COLOR = { GIA: "var(--accent)", ISA: "var(--gain)", SIPP: "var(--m-same)", LISA: "var(--m-pool)", VCT: "var(--m-bb)" };
const wrapperColor = (w) => WRAPPER_COLOR[w] || "var(--muted)";

// Custom tooltip for the stacked income charts — recharts' built-in
// Tooltip only lists each series' own value; hovering a bar naturally also
// wants "what did this year/month add up to across every wrapper", so this
// sums the visible payload (whatever segments are actually stacked in that
// bar) and appends it as a bold total row rather than requiring a separate
// invisible "total" series just to get a number into the tooltip.
function StackedTotalTooltip({ active, payload, label, labelPrefix = "" }) {
  if (!active || !payload || !payload.length) return null;
  const total = payload.reduce((s, p) => s + (+p.value || 0), 0);
  return (
    <div style={{ background: "var(--panel)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, padding: "8px 10px", minWidth: 140 }}>
      <div style={{ fontWeight: 600, marginBottom: 4 }}>{labelPrefix}{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
          <span style={{ color: p.color }}>{p.name}</span><span className="num">{gbp(p.value)}</span>
        </div>
      ))}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, borderTop: "1px solid var(--border)", marginTop: 4, paddingTop: 4, fontWeight: 600 }}>
        <span>Total</span><span className="num">{gbp(total)}</span>
      </div>
    </div>
  );
}

/* ----------------------------- Income tab --------------------------- */
const DIV_BLANK = () => ({ id: uid(), date: todayISO(), ticker: "", kind: "dividend", amount: "", wrapper: "GIA" });
const ERI_BLANK = () => ({ id: uid(), ticker: "", periodEnd: "", distributionDate: "", perShare: "", currency: "GBp", fxRate: 1, treatment: "dividend" });
const ERI_COLS = [
  { label: "Fund", align: "left" },
  { label: "Period end", align: "left" },
  { label: "Dist. date", align: "left" },
  { label: "Units", align: "right" },
  { label: "ERI (GBP)", align: "right" },
  { label: "Taxed as", align: "left" },
  { label: "Tax year", align: "left" },
  { label: "", align: "right" },
];

// Phase 2.8 de-drilling: raw state from the store; derived data (eriTxns,
// incomeByYear, incomeAllWrappers, GIA-scoped txns, incomeCalendar) stays
// props from the shell.
function IncomeTab({ eriTxns, incomeByYear, incomeAllWrappers = {}, txns, incomeCalendar = [] }) {
  const incomeEntries = useAppStore((s) => s.incomeEntries), setIncomeEntries = useAppStore((s) => s.setIncomeEntries);
  const eriEntries = useAppStore((s) => s.eriEntries), setEriEntries = useAppStore((s) => s.setEriEntries);
  const income = useAppStore((s) => s.income), setIncome = useAppStore((s) => s.setIncome);
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const [dv, setDv] = useState(DIV_BLANK());
  const [er, setEr] = useState(ERI_BLANK());
  const [fxBusy, setFxBusy] = useState(false);
  const [divSort, toggleDivSort] = useSort("date", "desc");
  const [eriSort, toggleEriSort] = useSort("distributionDate", "desc");
  // Sub-tab order tells the story in time: what's COMING (calendar), what
  // you've RECEIVED and where (by wrapper), the raw LEDGER (div & int),
  // what it COSTS (tax, GIA-only), then the ERI edge case last. Default is
  // the calendar — the forward look is the everyday visit; tax is the
  // January visit.
  const [sub, setSub] = useState(() => store.get("cgt.incomesubtab", "calendar"));
  React.useEffect(() => store.set("cgt.incomesubtab", sub), [sub]);
  const years = Object.keys(incomeByYear).sort().reverse();
  const allYears = Object.keys(incomeAllWrappers).sort().reverse();
  const presentWrappers = useMemo(() => {
    const set = new Set();
    for (const y of allYears) for (const w of Object.keys(incomeAllWrappers[y])) set.add(w);
    return WRAPPERS.filter((w) => set.has(w));
  }, [allYears, incomeAllWrappers]);
  // Year-on-year total income by wrapper — one stacked bar per tax year,
  // one coloured segment per wrapper, ascending left-to-right so it reads
  // as a timeline (the table above sorts newest-first, which is right for
  // scanning a table but backwards for a trend chart).
  const yoyChartData = useMemo(() => {
    return [...allYears].sort().map((y) => {
      const row = { year: y };
      for (const w of presentWrappers) {
        const d = incomeAllWrappers[y]?.[w];
        row[w] = d ? Math.round((d.dividends + d.interest) * 100) / 100 : 0;
      }
      return row;
    });
  }, [allYears, presentWrappers, incomeAllWrappers]);
  const [incWrapper, setIncWrapper] = useState(() => store.get("cgt.income.wrapper", "GIA"));
  React.useEffect(() => store.set("cgt.income.wrapper", incWrapper), [incWrapper]);
  React.useEffect(() => { if (presentWrappers.length && !presentWrappers.includes(incWrapper)) setIncWrapper(presentWrappers[0]); }, [presentWrappers]);

  const addDiv = () => { if (!dv.date || !(+dv.amount)) return; setIncomeEntries((p) => [...p, { ...dv, amount: +dv.amount }]); setDv(DIV_BLANK()); };
  const setEriF = (k, v) => setEr((e) => { const n = { ...e, [k]: v }; if (k === "periodEnd") n.distributionDate = addMonthsISO(v, 6); if (k === "currency" && (v === "GBP" || v === "GBp")) n.fxRate = 1; return n; });
  const addEri = () => { if (!er.ticker || !er.periodEnd || !er.distributionDate || !(+er.perShare)) return; setEriEntries((p) => [...p, { ...er, ticker: er.ticker.toUpperCase(), perShare: +er.perShare, fxRate: +er.fxRate || 0 }]); setEr(ERI_BLANK()); };
  const fetchEriFx = async () => {
    if (er.currency === "GBP" || er.currency === "GBp") return;
    setFxBusy(true);
    try { const fx = await fxToGBP(er.currency); if (fx) setEr((e) => ({ ...e, fxRate: +fx.toFixed(6) })); } catch { /* ignore */ }
    setFxBusy(false);
  };
  const eriPreview = (() => {
    const units = unitsHeldAt(txns, er.periodEnd || "9999-12-31", er.ticker);
    const native = units * (+er.perShare || 0);
    const g = er.currency === "GBp" ? native / 100 : er.currency === "GBP" ? native : native * (+er.fxRate || 0);
    return { units, g };
  })();

  return (
    <div className="space-y-5">
      <SubTabs
        tabs={[["calendar", "Calendar"], ["bywrapper", "Income by wrapper"], ["divint", "Dividends & interest"], ["byyear", "Tax by year"], ["eri", "ERI"]]}
        active={sub} onChange={setSub}
      />

      {sub === "bywrapper" && (
        <div className="space-y-6">
          {/* Year-on-year total income by wrapper, stacked bars coloured by wrapper */}
          {yoyChartData.length ? (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Income by wrapper, year on year</h3>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={yoyChartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="year" tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
                    <YAxis tickFormatter={(v) => gbp(v)} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={64} />
                    <Tooltip content={<StackedTotalTooltip labelPrefix="Tax year " />} />
                    {presentWrappers.map((w) => (
                      <Bar key={w} dataKey={w} stackId="income" fill={wrapperColor(w)} name={w} radius={presentWrappers[presentWrappers.length - 1] === w ? [3, 3, 0, 0] : undefined} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
                <div className="flex flex-wrap gap-3 mt-2">
                  {presentWrappers.map((w) => (
                    <span key={w} className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
                      <span className="w-2 h-2 rounded-full inline-block" style={{ background: wrapperColor(w) }} />{w}
                    </span>
                  ))}
                </div>
              </div>
              <p className="text-xs text-[var(--muted)]">Dividends + interest combined, gross of tax, by tax year and wrapper. ISA/SIPP/LISA income is tax-free; VCT dividends are exempt; only GIA feeds the Tax by year sub-tab.</p>
            </div>
          ) : null}

          {/* All-wrapper income overview (taxable + sheltered), one wrapper at a time */}
          {allYears.length ? (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">All investment income by wrapper</h3>
              <div className="flex flex-wrap gap-1.5">
                {presentWrappers.map((w) => (
                  <button key={w} onClick={() => setIncWrapper(w)}
                    className={"text-xs font-medium px-2.5 py-1 rounded-full border transition " +
                      (incWrapper === w ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
                    {w}
                  </button>
                ))}
              </div>
              <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                    <tr>{["Tax year", "Dividends", "Interest", "Total"].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
                    {allYears.filter((y) => incomeAllWrappers[y][incWrapper]).map((y) => {
                      const d = incomeAllWrappers[y][incWrapper];
                      return (
                        <tr key={y} className="hover:bg-[var(--panel2)]">
                          <td className="py-2 px-3 font-medium">{y}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.dividends)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.interest)}</td>
                          <td className="py-2 px-3 text-right num font-medium">{gbp(d.dividends + d.interest)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-[var(--muted)]">{isWrapperTaxable(incWrapper) ? `${incWrapper} is taxable` : `${incWrapper} is tax-free`} — only GIA income feeds the Tax by year sub-tab; ISA, SIPP, LISA and VCT income is tax-free (VCT dividends are exempt under ITA 2007 Part 6).</p>
            </div>
          ) : <Empty msg="No investment income recorded yet. Add dividends and interest on the Dividends & interest sub-tab (or import them) to see the wrapper breakdown." />}
        </div>
      )}

      {sub === "byyear" && (
        <div className="space-y-6">
          <div className="flex items-end gap-3 flex-wrap">
            <Field label="Employment / other income (£)"><CurrencyInput value={income} onChange={setIncome} className="w-48" /></Field>
            <p className="text-xs text-[var(--muted)] pb-2 max-w-md">Taxable (GIA) dividends and interest are stacked on top of this income to work out the tax. Tax-free wrapper income (ISA/SIPP/LISA/VCT) is on the Income by wrapper sub-tab.</p>
          </div>

          {/* Per-year income tax (taxable only) */}
          {years.length ? (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Taxable investment income tax by year <span className="font-normal text-[var(--muted)]">(GIA only, includes ERI)</span></h3>
              <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-[var(--panel2)] text-[var(--muted)]">
                    <tr>{["Tax year", "Dividends", "Interest", "Dividend tax", "Interest tax", "Total"].map((h, i) => <th key={i} className={"py-2 px-3 font-medium " + (i ? "text-right" : "text-left")}>{h}</th>)}</tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border)]">
                    {years.map((y) => {
                      const d = incomeByYear[y], r = investmentIncomeTax({ salary: income, interest: d.interest, dividends: d.dividends, year: y });
                      return (
                        <tr key={y}>
                          <td className="py-2 px-3 font-medium">{y}{r.assumed ? " *" : ""}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.dividends)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(d.interest)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(r.dividendTax)}</td>
                          <td className="py-2 px-3 text-right num">{gbp(r.interestTax)}</td>
                          <td className="py-2 px-3 text-right num font-semibold text-[var(--loss)]">{gbp(r.tax)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-[var(--muted)]">Export a plain-text summary for a return:</span>
                {years.map((y) => (
                  <button key={y} onClick={() => {
                    const d = incomeByYear[y], r = investmentIncomeTax({ salary: income, interest: d.interest, dividends: d.dividends, year: y });
                    downloadText(
                      taxSummaryText({ taxYear: y, generatedOn: todayISO(), income: { dividends: d.dividends, interest: d.interest, dividendTax: r.dividendTax, interestTax: r.interestTax } }),
                      `income-tax-summary-${y.replace("/", "-")}.txt`
                    );
                  }} className="text-xs px-2 py-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)]">{y}</button>
                ))}
              </div>
              <p className="text-xs text-[var(--muted)]">Dividend allowance and Personal Savings Allowance are applied automatically by year and band. Figures marked * use assumed (latest) rates for years not in the table. "Dividends" here includes excess reportable income (ERI) from offshore reporting funds — a non-cash distribution taxed on the fund's distribution date under UK offshore-fund rules, folded in alongside cash dividends actually received, not a separate line.</p>
            </div>
          ) : <Empty msg="No dividends, interest or ERI recorded yet. Add them on the Dividends & Interest or ERI tab to see the income-tax position." />}
        </div>
      )}

      {sub === "divint" && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm">Dividends & interest</h3>
          <div className="flex items-end gap-2 flex-wrap rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
            <Field label="Date"><input type="date" value={dv.date} onChange={(e) => setDv({ ...dv, date: e.target.value })} className="input num" /></Field>
            <Field label="Ticker (optional)"><input value={dv.ticker} onChange={(e) => setDv({ ...dv, ticker: e.target.value.toUpperCase() })} className="input num w-24" placeholder="—" /></Field>
            <Field label="Type"><select value={dv.kind} onChange={(e) => setDv({ ...dv, kind: e.target.value })} className="input"><option value="dividend">Dividend</option><option value="interest">Interest</option></select></Field>
            <Field label="Wrapper"><select value={dv.wrapper} onChange={(e) => setDv({ ...dv, wrapper: e.target.value })} className="input">{WRAPPERS.map((w) => <option key={w}>{w}</option>)}</select></Field>
            <Field label="Amount (£, GBP)"><input type="number" value={dv.amount} onChange={(e) => setDv({ ...dv, amount: e.target.value })} className="input num w-32" placeholder="0.00" /></Field>
            <button onClick={addDiv} className="btn-accent"><Plus size={15} /> Add</button>
          </div>
          {incomeEntries.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                  <tr>
                    <SortTh id="date" label="Date" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="ticker" label="Ticker" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="kind" label="Type" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="wrapper" label="Wrapper" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="taxYear" label="Tax year" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="amount" label="Amount" sort={divSort} onSort={toggleDivSort} align="right" className="py-2 px-3 font-medium" />
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {(() => {
                    const sorted = sortRows(incomeEntries, divSort, {
                      date: (e) => e.date, ticker: (e) => e.ticker || "", kind: (e) => e.kind,
                      wrapper: (e) => normWrapper(e.wrapper), taxYear: (e) => ukTaxYear(e.date), amount: (e) => +e.amount || 0,
                    });
                    const row = (e) => (
                      <tr key={e.id}>
                        <td className="py-2 px-3 num text-[var(--muted)]">{e.date}</td>
                        <td className="py-2 px-3">{e.ticker || "—"}</td>
                        <td className="py-2 px-3 capitalize">{e.kind}</td>
                        <td className="py-2 px-3">{normWrapper(e.wrapper)}</td>
                        <td className="py-2 px-3 num">{ukTaxYear(e.date)}</td>
                        <td className="py-2 px-3 text-right num">{gbp(+e.amount)}</td>
                        <td className="py-2 px-3 text-right"><button onClick={() => removeWithUndo({ list: incomeEntries, setList: setIncomeEntries, id: e.id, label: `${e.kind} ${gbp(+e.amount)}` })} aria-label={`Delete ${e.kind} entry: ${e.date}${e.ticker ? ` ${e.ticker}` : ""}`} title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button></td>
                      </tr>
                    );
                    // Tax-year subtotal rows — the broker-statement
                    // reconciliation aid — only when rows are grouped
                    // contiguously by year (date or tax-year sort); any
                    // other sort interleaves years and a "subtotal" row
                    // would be summing a fiction.
                    if (divSort.key !== "date" && divSort.key !== "taxYear") return sorted.map(row);
                    const out = [];
                    for (let i = 0; i < sorted.length; i++) {
                      out.push(row(sorted[i]));
                      const ty = ukTaxYear(sorted[i].date);
                      if (i + 1 === sorted.length || ukTaxYear(sorted[i + 1].date) !== ty) {
                        const group = sorted.filter((e) => ukTaxYear(e.date) === ty);
                        const div = group.reduce((s, e) => s + (e.kind === "interest" ? 0 : +e.amount || 0), 0);
                        const int = group.reduce((s, e) => s + (e.kind === "interest" ? +e.amount || 0 : 0), 0);
                        out.push(
                          <tr key={`sub-${ty}`} className="bg-[var(--panel2)]">
                            <td colSpan={5} className="py-1.5 px-3 text-xs font-medium text-[var(--muted)]">
                              {ty} · {group.length} payment{group.length === 1 ? "" : "s"} — dividends {gbp(div)} · interest {gbp(int)}
                            </td>
                            <td className="py-1.5 px-3 text-right num text-xs font-semibold">{gbp(div + int)}</td>
                            <td />
                          </tr>
                        );
                      }
                    }
                    return out;
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {sub === "eri" && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm">Excess reportable income (offshore reporting funds)</h3>
          <p className="text-xs text-[var(--muted)] max-w-3xl">For accumulating ETFs and other offshore reporting funds. Enter the reportable income per share from the fund's report and its reporting-period end. It's taxed on the fund distribution date (period end + 6 months), in that tax year, as dividend (equity funds) or interest (bond funds &gt;60% debt) — and the taxed amount is added to the Section 104 pool, lowering the gain on later disposals.</p>
          <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", alignItems: "end" }}>
            <Field label="Ticker"><input value={er.ticker} onChange={(e) => setEriF("ticker", e.target.value.toUpperCase())} className="input num w-full" placeholder="e.g. XNAQ" /></Field>
            <Field label="Reporting period end"><input type="date" value={er.periodEnd} onChange={(e) => setEriF("periodEnd", e.target.value)} className="input num w-full" /></Field>
            <Field label="Fund distribution date"><input type="date" value={er.distributionDate} onChange={(e) => setEriF("distributionDate", e.target.value)} className="input num w-full" /></Field>
            <Field label="Reportable income / share"><input type="number" value={er.perShare} onChange={(e) => setEriF("perShare", e.target.value)} className="input num w-full" placeholder="0.00" /></Field>
            <Field label="Currency"><select value={er.currency} onChange={(e) => setEriF("currency", e.target.value)} className="input w-full">{["GBp", "GBP", "USD", "EUR"].map((c) => <option key={c} value={c}>{c}</option>)}</select></Field>
            <Field label="FX → GBP">
              <div className="flex gap-1"><input type="number" value={er.fxRate} onChange={(e) => setEriF("fxRate", e.target.value)} disabled={er.currency === "GBP" || er.currency === "GBp"} className="input num w-full disabled:opacity-50" />
                {er.currency !== "GBP" && er.currency !== "GBp" && <button onClick={fetchEriFx} disabled={fxBusy} className="text-[var(--accent)] px-1" title="Fetch latest FX">{fxBusy ? "…" : "↻"}</button>}</div>
            </Field>
            <Field label="Taxed as"><select value={er.treatment} onChange={(e) => setEriF("treatment", e.target.value)} className="input w-full"><option value="dividend">Dividend</option><option value="interest">Interest</option></select></Field>
            <div className="flex items-end"><button onClick={addEri} className="btn-accent w-full justify-center"><Plus size={15} /> Add</button></div>
          </div>
          {er.ticker && er.periodEnd && (
            <p className="text-xs text-[var(--muted)] num">Preview: {num(eriPreview.units, eriPreview.units % 1 ? 4 : 0)} units held at {er.periodEnd} → ERI {gbp(eriPreview.g || 0)} taxed in {er.distributionDate ? ukTaxYear(er.distributionDate) : "—"}.</p>
          )}
          {eriEntries.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--panel2)] text-[var(--muted)]">
                  <tr>
                    <SortTh id="ticker" label="Fund" sort={eriSort} onSort={toggleEriSort} className="py-2 px-3 font-medium" />
                    <SortTh id="periodEnd" label="Period end" sort={eriSort} onSort={toggleEriSort} className="py-2 px-3 font-medium" />
                    <SortTh id="distributionDate" label="Dist. date" sort={eriSort} onSort={toggleEriSort} className="py-2 px-3 font-medium" />
                    <SortTh id="units" label="Units" sort={eriSort} onSort={toggleEriSort} align="right" className="py-2 px-3 font-medium" />
                    <SortTh id="gbp" label="ERI (GBP)" sort={eriSort} onSort={toggleEriSort} align="right" className="py-2 px-3 font-medium" />
                    <SortTh id="treatment" label="Taxed as" sort={eriSort} onSort={toggleEriSort} className="py-2 px-3 font-medium" />
                    <SortTh id="taxYear" label="Tax year" sort={eriSort} onSort={toggleEriSort} className="py-2 px-3 font-medium" />
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {sortRows(eriEntries, eriSort, {
                    ticker: (e) => e.ticker, periodEnd: (e) => e.periodEnd, distributionDate: (e) => e.distributionDate,
                    units: (e) => eriTxns.find((x) => x.id === "eri-" + e.id)?._units ?? null,
                    gbp: (e) => eriTxns.find((x) => x.id === "eri-" + e.id)?._gbp ?? null,
                    treatment: (e) => e.treatment, taxYear: (e) => ukTaxYear(e.distributionDate),
                  }).map((e) => {
                    const t = eriTxns.find((x) => x.id === "eri-" + e.id);
                    return (
                      <tr key={e.id}>
                        <td className={"py-2 px-3 font-medium text-" + ERI_COLS[0].align}>{e.ticker}</td>
                        <td className={"py-2 px-3 num text-[var(--muted)] text-" + ERI_COLS[1].align}>{e.periodEnd}</td>
                        <td className={"py-2 px-3 num text-[var(--muted)] text-" + ERI_COLS[2].align}>{e.distributionDate}</td>
                        <td className={"py-2 px-3 num text-" + ERI_COLS[3].align}>{t ? num(t._units, t._units % 1 ? 4 : 0) : "—"}</td>
                        <td className={"py-2 px-3 num text-" + ERI_COLS[4].align}>{gbp(t ? t._gbp : 0)}</td>
                        <td className={"py-2 px-3 capitalize text-" + ERI_COLS[5].align}>{e.treatment}</td>
                        <td className={"py-2 px-3 num text-" + ERI_COLS[6].align}>{ukTaxYear(e.distributionDate)}</td>
                        <td className={"py-2 px-3 text-" + ERI_COLS[7].align}><button onClick={() => removeWithUndo({ list: eriEntries, setList: setEriEntries, id: e.id, label: `ERI entry ${e.ticker}` })} aria-label={`Delete ERI entry: ${e.ticker} ${e.periodEnd}`} title="Delete" className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} aria-hidden="true" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-[var(--muted)]">The base-cost uplift shows up automatically in Holdings and the CGT summary. ERI is added to the pool on the distribution date, so it only reduces gains on disposals after that date.</p>

          <EriCoverage {...{ txns, eriEntries, secMeta, setSecMeta }} />
        </div>
      )}

      {sub === "calendar" && (
        <div className="space-y-2">
          <h3 className="font-semibold text-sm">Income calendar <span className="font-normal text-[var(--muted)]">— next 12 months</span></h3>
          <p className="text-xs text-[var(--muted)] max-w-3xl">Gilt coupons/redemptions and fixed-term cash maturities are contractual dates ("Scheduled"). Dividends and interest are forecast from at least two historical payments at a detected cadence, at the recent average amount ("Estimated") — nothing is forecast for a fully sold holding, or for a holding with fewer than two payments recorded yet (a recently-acquired position, for instance). Pension contributions are deliberately excluded — they're money going into the pension pot, not income received.</p>
          <IncomeCalendarView events={incomeCalendar} />
        </div>
      )}
    </div>
  );
}

/* ------------------------- Income calendar view ------------------------ */
const SOURCE_LABELS = {
  "gilt-coupon": "Gilt coupon",
  "gilt-redemption": "Gilt redemption",
  dividend: "Dividend",
  interest: "Interest",
  "cash-maturity": "Cash maturity",
  "deferred-cash": "Deferred cash",
  "rsu-vest": "RSU vest (est. at today's price)",
};
// Fixed per-source colour mapping for the forecast chart below (same "fixed
// mapping, not an index-based palette" reasoning as WRAPPER_COLOR above —
// a source keeps its colour as bars are added/removed month to month).
const SOURCE_COLOR = { dividend: "var(--accent)", interest: "var(--gain)", "gilt-coupon": "var(--m-same)", "gilt-redemption": "var(--m-pool)", "cash-maturity": "var(--m-bb)", "deferred-cash": "color-mix(in srgb, var(--accent) 45%, var(--m-pool))", "rsu-vest": "var(--gain)" };
const SOURCE_ORDER = ["dividend", "interest", "gilt-coupon", "gilt-redemption", "cash-maturity", "deferred-cash", "rsu-vest"];
const sourceColor = (s) => SOURCE_COLOR[s] || "var(--muted)";

// Tax-treatment badge for a calendar row — wrapper name + taxed/tax-free/
// tax-exempt, e.g. "GIA (taxed)", "ISA (tax-free)", "VCT (tax-exempt)" (VCT
// dividends are exempt under ITA 2007 Part 6, a different statutory basis
// than an ISA/SIPP/LISA's tax-free wrapper status, hence the distinct
// wording, same rule as the byyear table above). Redemptions and cash
// maturities return null: they're capital coming back (individual gilts are
// CGT-exempt; a maturing balance is principal), not income, so an
// income-tax label doesn't apply. Un-attributed interest (no ticker, so no
// reliable wrapper on record) reads "Interest (taxed)" rather than guessing
// a wrapper — interest defaults to taxed unless it's known to sit in a
// sheltered account.
function taxTag(e) {
  // Deferred cash is employment income taxed via PAYE at payment, not
  // wrapper-based investment income — no GIA/ISA-style badge applies.
  if (e.source === "gilt-redemption" || e.source === "cash-maturity" || e.source === "deferred-cash" || e.source === "rsu-vest") return null;
  const taxed = isWrapperTaxable(e.wrapper);
  const wrapperNorm = normWrapper(e.wrapper);
  // "Interest" with no ticker attached (un-attributed cash interest) has no
  // reliable wrapper on record — label it by kind rather than guessing GIA.
  const label = (e.source === "interest" && e.label === "Interest") ? "Interest" : wrapperNorm;
  const status = taxed ? "taxed" : (wrapperNorm === "VCT" ? "tax-exempt" : "tax-free");
  return { text: `${label} (${status})`, taxed };
}

function IncomeCalendarView({ events: allEvents }) {
  const [calSort, toggleCalSort] = useSort("date", "asc");
  // Wrapper filter — "what's my tax-free ISA income stream?" is a one-tap
  // question. Pills only show wrappers that actually have forward events.
  // Deferred cash carries wrapper:null (employment income, not investment
  // income in a wrapper) so it appears under All only.
  const [calWrap, setCalWrap] = useState(() => store.get("cgt.income.calwrap", "ALL"));
  React.useEffect(() => store.set("cgt.income.calwrap", calWrap), [calWrap]);
  const calWrappers = useMemo(() => {
    const set = new Set(allEvents.filter((e) => e.wrapper).map((e) => normWrapper(e.wrapper)));
    return WRAPPERS.filter((w) => set.has(w));
  }, [allEvents]);
  React.useEffect(() => { if (calWrap !== "ALL" && !calWrappers.includes(calWrap)) setCalWrap("ALL"); }, [calWrappers, calWrap]);
  const events = useMemo(
    () => calWrap === "ALL" ? allEvents : allEvents.filter((e) => e.wrapper && normWrapper(e.wrapper) === calWrap),
    [allEvents, calWrap]
  );
  const summary = useMemo(() => summariseBySource(events), [events]);
  const total = events.reduce((s, e) => s + (+e.amount || 0), 0);
  // Same events as the table below, grouped by calendar month and stacked
  // by source — the forward-looking analogue of the historical "by wrapper"
  // charts on the Tax by year sub-tab, but broken down by source (Gilt
  // coupon/redemption, Dividend, Interest, Cash maturity) rather than
  // wrapper, since that's the more meaningful split for "what's coming and
  // when" (a gilt redemption isn't about wrapper tax treatment, it's
  // capital coming back). Never needs a 24-month cap like the historical
  // chart — buildIncomeCalendar() already bounds this to a 12-month horizon.
  const monthlyData = useMemo(() => {
    const map = new Map();
    for (const e of events) {
      if (!e.date || !e.amount) continue;
      const m = e.date.slice(0, 7);
      if (!map.has(m)) map.set(m, { month: m });
      const row = map.get(m);
      row[e.source] = Math.round(((row[e.source] || 0) + (+e.amount || 0)) * 100) / 100;
    }
    return [...map.values()].sort((a, b) => (a.month < b.month ? -1 : 1));
  }, [events]);
  const monthlySources = useMemo(() => {
    const set = new Set();
    for (const row of monthlyData) for (const k of Object.keys(row)) if (k !== "month") set.add(k);
    return SOURCE_ORDER.filter((s) => set.has(s));
  }, [monthlyData]);

  if (!allEvents.length) {
    return <Empty msg="No forward income scheduled or forecast in the next 12 months. Dividend/interest forecasts need at least two historical payments on an open holding; gilt coupons and cash maturities show automatically once you hold them." />;
  }

  return (
    <div className="space-y-3">
      {calWrappers.length > 1 && (
        <div className="flex flex-wrap gap-1.5">
          {["ALL", ...calWrappers].map((w) => (
            <button key={w} onClick={() => setCalWrap(w)}
              className={"text-xs font-medium px-2.5 py-1 rounded-full border transition " +
                (calWrap === w ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
              {w === "ALL" ? "All" : w}
            </button>
          ))}
        </div>
      )}
      {!events.length ? <Empty msg={`No forward income in ${calWrap} in the next 12 months.`} /> : (<>
      <div className="flex flex-wrap gap-2">
        {Object.entries(summary).map(([source, s]) => (
          <div key={source} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs">
            <div className="text-[var(--muted)]">{SOURCE_LABELS[source] || source}</div>
            <div className="font-semibold num">{gbp(s.total)} <span className="text-[var(--muted)] font-normal">({s.count})</span></div>
          </div>
        ))}
        <div className="rounded-lg border border-[var(--accent)] bg-[var(--panel)] px-3 py-2 text-xs">
          <div className="text-[var(--muted)]">Total{calWrap !== "ALL" ? ` (${calWrap})` : ""}, next 12 months</div>
          <div className="font-semibold num">{gbp(total)}</div>
        </div>
      </div>

      {monthlyData.length > 1 && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="text-xs font-medium text-[var(--muted)] mb-1.5">By month</div>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={monthlyData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="month" tick={{ fontSize: 10, fill: "var(--muted)" }} tickLine={false} axisLine={{ stroke: "var(--border)" }} />
              <YAxis tickFormatter={(v) => gbp(v)} tick={{ fontSize: 11, fill: "var(--muted)" }} tickLine={false} axisLine={false} width={64} />
              <Tooltip content={<StackedTotalTooltip />} />
              {monthlySources.map((s) => (
                <Bar key={s} dataKey={s} stackId="cal" fill={sourceColor(s)} name={SOURCE_LABELS[s] || s} radius={monthlySources[monthlySources.length - 1] === s ? [3, 3, 0, 0] : undefined} />
              ))}
            </BarChart>
          </ResponsiveContainer>
          <div className="flex flex-wrap gap-3 mt-2">
            {monthlySources.map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <span className="w-2 h-2 rounded-full inline-block" style={{ background: sourceColor(s) }} />{SOURCE_LABELS[s] || s}
              </span>
            ))}
          </div>
        </div>
      )}
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <SortTh id="date" label="Date" sort={calSort} onSort={toggleCalSort} className="py-2 px-3 font-medium" />
              <SortTh id="source" label="Source" sort={calSort} onSort={toggleCalSort} className="py-2 px-3 font-medium" />
              <SortTh id="label" label="Holding / account" sort={calSort} onSort={toggleCalSort} className="py-2 px-3 font-medium" />
              <SortTh id="amount" label="Amount" sort={calSort} onSort={toggleCalSort} align="right" className="py-2 px-3 font-medium" />
              <th className="py-2 px-3 text-left font-medium">Tax treatment</th>
              <th className="py-2 px-3 text-left font-medium">Certainty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {sortRows(events, calSort, {
              date: (e) => e.date, source: (e) => e.source, label: (e) => e.label || "", amount: (e) => +e.amount || 0,
            }).map((e, i) => {
              const tag = taxTag(e);
              return (
                <tr key={`${e.date}-${e.source}-${e.label}-${i}`}>
                  <td className="py-2 px-3 num text-[var(--muted)]">{e.date}</td>
                  <td className="py-2 px-3">{SOURCE_LABELS[e.source] || e.source}</td>
                  <td className="py-2 px-3">{e.label || "—"}{e.cadence ? <span className="text-[var(--muted)]"> · {e.cadence}</span> : null}</td>
                  <td className="py-2 px-3 text-right num">{gbp(e.amount)}</td>
                  <td className="py-2 px-3">
                    {tag ? <span className={tag.taxed ? "text-[var(--loss)]" : "text-[var(--gain)]"}>{tag.text}</span> : <span className="text-[var(--muted)]">—</span>}
                  </td>
                  <td className="py-2 px-3">
                    {e.certainty === "scheduled"
                      ? <span className="text-[var(--gain)]">Scheduled</span>
                      : <span className="text-[var(--muted)]">Estimated</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)]">Amounts are gross, before any tax. Dividend/interest/pension figures use the average of the last 3 payments at the detected cadence — a cut, special dividend or change in payment schedule will move the actual date/amount away from this estimate.</p>
      </>)}
    </div>
  );
}

// For each fund ever held in the GIA (open or fully closed), shows the
// holding window and which calendar years have a recorded ERI entry —
// closed positions are included, since a fund owes ERI for every accounting
// period that fell inside the time it was actually held, not just while
// still open. Funds with no ISIN on record (so ERI-relevance is unknown)
// are flagged for review rather than silently skipped.
function EriCoverage({ txns, eriEntries, secMeta, setSecMeta }) {
  const rows = useMemo(() => {
    const byTicker = {};
    for (const t of txns) {
      if (t.side !== "BUY" && t.side !== "SELL") continue;
      (byTicker[t.ticker] ||= []).push(t);
    }
    const today = todayISO();
    return Object.entries(byTicker).map(([ticker, list]) => {
      list.sort((a, b) => (a.date < b.date ? -1 : 1));
      let qty = 0, firstBuy = null, lastZero = null;
      for (const t of list) {
        if (firstBuy === null && t.side === "BUY") firstBuy = t.date;
        qty += (t.side === "BUY" ? 1 : -1) * t.quantity;
        if (Math.abs(qty) < 1e-6) lastZero = t.date;
      }
      const open = qty > 1e-6;
      const endDate = open ? today : (lastZero || list[list.length - 1].date);
      const startYear = +firstBuy.slice(0, 4), endYear = +endDate.slice(0, 4);
      const years = []; for (let y = startYear; y <= endYear; y++) years.push(y);
      const sec = secMeta[ticker];
      const eriYears = new Set(eriEntries.filter((e) => e.ticker === ticker && e.periodEnd).map((e) => +e.periodEnd.slice(0, 4)));
      const missing = sec?.eri === true ? years.filter((y) => !eriYears.has(y)) : [];
      return { ticker, firstBuy, endDate, open, years, eriYears: [...eriYears].sort(), missing, sec };
    }).sort((a, b) => a.ticker.localeCompare(b.ticker));
  }, [txns, eriEntries, secMeta]);

  const setISIN = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], isin: v.toUpperCase().trim() } }));
  const setEri = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], eri: v } }));

  if (!rows.length) return null;
  const flagged = rows.filter((r) => r.missing.length > 0 || !r.sec).length;

  return (
    <div className="space-y-3 pt-2">
      <h3 className="text-sm font-semibold flex items-center gap-2"><AlertTriangle size={15} /> ERI coverage check</h3>
      <p className="text-xs text-[var(--muted)]">
        Every fund ever held unsheltered — open and fully closed positions — with the years held and which have a recorded ERI entry. A closed position still owes ERI for any accounting period that fell inside the time it was held.
        {flagged > 0 && ` ${flagged} fund${flagged === 1 ? "" : "s"} need${flagged === 1 ? "s" : ""} a look.`}
      </p>
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-[var(--panel2)] text-[var(--muted)]">
            <tr>{["Fund", "ISIN", "Held", "Years covered", "Status"].map((h, i) => <th key={i} className="py-2 px-3 font-medium text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((r) => (
              <tr key={r.ticker}>
                <td className="py-2 px-3 font-medium">{r.ticker}</td>
                <td className="py-2 px-3">
                  <input value={r.sec?.isin || ""} onChange={(e) => setISIN(r.ticker, e.target.value)} placeholder="IE00… (unknown)" className="input font-mono text-[11px] w-32 py-1" />
                </td>
                <td className="py-2 px-3 num text-[var(--muted)]">{r.firstBuy} → {r.open ? "now" : r.endDate}</td>
                <td className="py-2 px-3 num text-[var(--muted)]">{r.eriYears.length ? r.eriYears.join(", ") : "none"}</td>
                <td className="py-2 px-3">
                  {!r.sec ? (
                    <span className="inline-flex items-center gap-1 text-[var(--loss)]"><AlertTriangle size={12} /> No ISIN on record — add it to check ERI relevance</span>
                  ) : r.sec.eri === false ? (
                    <span className="text-[var(--muted)]">Not an offshore fund — no ERI</span>
                  ) : r.missing.length ? (
                    <span className="inline-flex items-center gap-1 text-[var(--loss)]"><AlertTriangle size={12} /> Missing: {r.missing.join(", ")}</span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[var(--gain)]"><Check size={12} /> Covered</span>
                  )}
                  {r.sec && (
                    <button onClick={() => setEri(r.ticker, !r.sec.eri)} className="ml-2 text-[var(--accent)] underline decoration-dotted">
                      {r.sec.eri ? "mark not ERI-relevant" : "mark ERI-relevant"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)]">
        "Years covered" matches by calendar year of each entry's period end, since fund accounting periods rarely align to UK tax years — it's a coverage indicator, not a substitute for checking each issuer's actual report. UK investment trusts (e.g. investment companies you hold as ordinary shares) never generate ERI; only offshore reporting funds (most Irish/Luxembourg-domiciled ETFs) do.
      </p>
    </div>
  );
}

/* ----------------------------- CGT tab ------------------------------ */
// Groups the four CGT tools (Summary, Planning, Report, What-if) under one
// top-level tab as sub-tabs, since they're all views over the same GIA-only
// CGT computation rather than separate concerns.

export default IncomeTab;
