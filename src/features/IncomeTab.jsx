import React, { useState, useMemo, useCallback, useRef } from "react";
import { Plus, Trash2, AlertTriangle, Check } from "lucide-react";
import { ukTaxYear } from "../core/cgt-engine.mjs";
import { WRAPPERS, isWrapperTaxable } from "../core/portfolio.mjs";
import { investmentIncomeTax } from "../core/uk-tax.mjs";
import { addMonthsISO } from "../core/ishares-eri.mjs";
import { summariseBySource } from "../core/income-calendar.mjs";
import { store, unitsHeldAt, gbp, SubTabs, num, uid, todayISO, fxToGBP, Field, Empty, useSort, sortRows, SortTh } from "../ui/shared.jsx";

/* ----------------------------- Income tab --------------------------- */
const DIV_BLANK = () => ({ id: uid(), date: todayISO(), ticker: "", kind: "dividend", amount: "" });
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

function IncomeTab({ incomeEntries, setIncomeEntries, eriEntries, setEriEntries, eriTxns, incomeByYear, incomeAllWrappers = {}, income, setIncome, txns, secMeta, setSecMeta, incomeCalendar = [] }) {
  const [dv, setDv] = useState(DIV_BLANK());
  const [er, setEr] = useState(ERI_BLANK());
  const [fxBusy, setFxBusy] = useState(false);
  const [divSort, toggleDivSort] = useSort("date", "desc");
  const [eriSort, toggleEriSort] = useSort("distributionDate", "desc");
  const [sub, setSub] = useState(() => store.get("cgt.incomesubtab", "byyear"));
  React.useEffect(() => store.set("cgt.incomesubtab", sub), [sub]);
  const years = Object.keys(incomeByYear).sort().reverse();
  const allYears = Object.keys(incomeAllWrappers).sort().reverse();
  const presentWrappers = useMemo(() => {
    const set = new Set();
    for (const y of allYears) for (const w of Object.keys(incomeAllWrappers[y])) set.add(w);
    return WRAPPERS.filter((w) => set.has(w));
  }, [allYears, incomeAllWrappers]);
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
      <div className="flex items-end gap-3 flex-wrap">
        <Field label="Employment / other income (£)"><input type="number" value={income} onChange={(e) => setIncome(+e.target.value || 0)} className="input num w-48" /></Field>
        <p className="text-xs text-[var(--muted)] pb-2 max-w-md">Dividends and interest are stacked on top of this income for the tax calculation. The tax table counts only taxable (GIA) income; the all-wrapper overview shows your full income including tax-free ISA/SIPP/LISA/VCT.</p>
      </div>

      <SubTabs
        tabs={[["byyear", "Tax by year"], ["divint", "Dividends & interest"], ["eri", "ERI"], ["calendar", "Calendar"]]}
        active={sub} onChange={setSub}
      />

      {sub === "byyear" && (
        <div className="space-y-6">
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
              <div className="rounded-xl border border-[var(--border)] overflow-hidden">
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
              <p className="text-xs text-[var(--muted)]">{isWrapperTaxable(incWrapper) ? `${incWrapper} is taxable` : `${incWrapper} is tax-free`} — only GIA income feeds the tax calculation below; ISA, SIPP, LISA and VCT income is tax-free (VCT dividends are exempt under ITA 2007 Part 6).</p>
            </div>
          ) : null}

          {/* Per-year income tax (taxable only) */}
          {years.length ? (
            <div className="space-y-2">
              <h3 className="font-semibold text-sm">Taxable investment income tax by year <span className="font-normal text-[var(--muted)]">(GIA only)</span></h3>
              <div className="rounded-xl border border-[var(--border)] overflow-hidden">
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
              <p className="text-xs text-[var(--muted)]">Dividend allowance and Personal Savings Allowance are applied automatically by year and band. Figures marked * use assumed (latest) rates for years not in the table.</p>
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
            <Field label="Amount (£, GBP)"><input type="number" value={dv.amount} onChange={(e) => setDv({ ...dv, amount: e.target.value })} className="input num w-32" placeholder="0.00" /></Field>
            <button onClick={addDiv} className="btn-accent"><Plus size={15} /> Add</button>
          </div>
          {incomeEntries.length > 0 && (
            <div className="rounded-xl border border-[var(--border)] overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                  <tr>
                    <SortTh id="date" label="Date" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="ticker" label="Ticker" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="kind" label="Type" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="taxYear" label="Tax year" sort={divSort} onSort={toggleDivSort} className="py-2 px-3 font-medium" />
                    <SortTh id="amount" label="Amount" sort={divSort} onSort={toggleDivSort} align="right" className="py-2 px-3 font-medium" />
                    <th className="py-2 px-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {sortRows(incomeEntries, divSort, {
                    date: (e) => e.date, ticker: (e) => e.ticker || "", kind: (e) => e.kind,
                    taxYear: (e) => ukTaxYear(e.date), amount: (e) => +e.amount || 0,
                  }).map((e) => (
                    <tr key={e.id}>
                      <td className="py-2 px-3 num text-[var(--muted)]">{e.date}</td>
                      <td className="py-2 px-3">{e.ticker || "—"}</td>
                      <td className="py-2 px-3 capitalize">{e.kind}</td>
                      <td className="py-2 px-3 num">{ukTaxYear(e.date)}</td>
                      <td className="py-2 px-3 text-right num">{gbp(+e.amount)}</td>
                      <td className="py-2 px-3 text-right"><button onClick={() => setIncomeEntries((p) => p.filter((x) => x.id !== e.id))} className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} /></button></td>
                    </tr>
                  ))}
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
          <div className="grid gap-2 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))" }}>
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
            <div className="rounded-xl border border-[var(--border)] overflow-hidden">
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
                        <td className={"py-2 px-3 text-" + ERI_COLS[7].align}><button onClick={() => setEriEntries((p) => p.filter((x) => x.id !== e.id))} className="text-[var(--muted)] hover:text-[var(--loss)]"><Trash2 size={15} /></button></td>
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
          <p className="text-xs text-[var(--muted)] max-w-3xl">Gilt coupons/redemptions and fixed-term cash maturities are contractual dates ("Scheduled"). Dividends, interest and pension contributions are forecast from at least two historical payments at a detected cadence, at the recent average amount ("Estimated") — nothing is forecast for a fully sold holding.</p>
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
  "pension-contribution": "Pension contribution",
};

function IncomeCalendarView({ events }) {
  const [calSort, toggleCalSort] = useSort("date", "asc");
  const summary = useMemo(() => summariseBySource(events), [events]);
  const total = events.reduce((s, e) => s + (+e.amount || 0), 0);

  if (!events.length) {
    return <Empty msg="No forward income scheduled or forecast in the next 12 months. Dividend/interest forecasts need at least two historical payments on an open holding; gilt coupons and cash maturities show automatically once you hold them." />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {Object.entries(summary).map(([source, s]) => (
          <div key={source} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs">
            <div className="text-[var(--muted)]">{SOURCE_LABELS[source] || source}</div>
            <div className="font-semibold num">{gbp(s.total)} <span className="text-[var(--muted)] font-normal">({s.count})</span></div>
          </div>
        ))}
        <div className="rounded-lg border border-[var(--accent)] bg-[var(--panel)] px-3 py-2 text-xs">
          <div className="text-[var(--muted)]">Total, next 12 months</div>
          <div className="font-semibold num">{gbp(total)}</div>
        </div>
      </div>
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <SortTh id="date" label="Date" sort={calSort} onSort={toggleCalSort} className="py-2 px-3 font-medium" />
              <SortTh id="source" label="Source" sort={calSort} onSort={toggleCalSort} className="py-2 px-3 font-medium" />
              <SortTh id="label" label="Holding / account" sort={calSort} onSort={toggleCalSort} className="py-2 px-3 font-medium" />
              <SortTh id="amount" label="Amount" sort={calSort} onSort={toggleCalSort} align="right" className="py-2 px-3 font-medium" />
              <th className="py-2 px-3 text-left font-medium">Certainty</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {sortRows(events, calSort, {
              date: (e) => e.date, source: (e) => e.source, label: (e) => e.label || "", amount: (e) => +e.amount || 0,
            }).map((e, i) => (
              <tr key={`${e.date}-${e.source}-${e.label}-${i}`}>
                <td className="py-2 px-3 num text-[var(--muted)]">{e.date}</td>
                <td className="py-2 px-3">{SOURCE_LABELS[e.source] || e.source}</td>
                <td className="py-2 px-3">{e.label || "—"}{e.cadence ? <span className="text-[var(--muted)]"> · {e.cadence}</span> : null}</td>
                <td className="py-2 px-3 text-right num">{gbp(e.amount)}</td>
                <td className="py-2 px-3">
                  {e.certainty === "scheduled"
                    ? <span className="text-[var(--gain)]">Scheduled</span>
                    : <span className="text-[var(--muted)]">Estimated</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)]">Amounts are gross, before any tax. Dividend/interest/pension figures use the average of the last 3 payments at the detected cadence — a cut, special dividend or change in payment schedule will move the actual date/amount away from this estimate.</p>
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
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-[var(--panel2)] text-[var(--muted)]">
            <tr>{["Fund", "ISIN", "Held", "Years covered", "Status"].map((h, i) => <th key={i} className="py-2 px-3 font-medium text-left">{h}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((r) => (
              <tr key={r.ticker}>
                <td className="py-2 px-3 font-medium">{r.ticker}</td>
                <td className="py-2 px-3">
                  <input value={r.sec?.isin || ""} onChange={(e) => setISIN(r.ticker, e.target.value)} placeholder="IE00… (unknown)" className="input font-mono text-[10px] w-32 py-1" />
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
