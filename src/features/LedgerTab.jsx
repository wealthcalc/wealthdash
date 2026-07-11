import React, { useState, useMemo, useCallback, useRef } from "react";
import { Plus, Wand2, RefreshCw } from "lucide-react";
import { WRAPPERS, normWrapper } from "../core/portfolio.mjs";
import { store, num, NumberInput, uid, todayISO, Field, fxToGBP, gbp, useSort, sortRows, SortTh, TwoStepDelete } from "../ui/shared.jsx";

const BLANK = () => ({ id: uid(), date: todayISO(), ticker: "", side: "BUY", quantity: "", nativeCurrency: "GBP", nativeAmount: "", fxRate: 1, gbpAmount: "", wrapper: "GIA", note: "" });
function LedgerTab({ txns, setTxns }) {
  const [draft, setDraft] = useState(BLANK());
  const [fxBusy, setFxBusy] = useState(false);

  const set = (k, v) => setDraft((d) => {
    const next = { ...d, [k]: v };
    if (["nativeAmount", "fxRate"].includes(k)) {
      const na = +next.nativeAmount || 0, fx = +next.fxRate || 0;
      if (na && fx) next.gbpAmount = +(na * fx).toFixed(2);
    }
    if (k === "nativeCurrency" && v === "GBP") { next.fxRate = 1; if (next.nativeAmount) next.gbpAmount = +next.nativeAmount; }
    return next;
  });

  const fetchFx = async () => {
    if (draft.nativeCurrency === "GBP") return;
    setFxBusy(true);
    try {
      const res = await fetch(`https://api.frankfurter.dev/v1/${draft.date}?from=${draft.nativeCurrency}&to=GBP`);
      const j = await res.json();
      const rate = j?.rates?.GBP;
      if (rate) set("fxRate", +rate.toFixed(6));
    } catch { /* offline / blocked — keep manual */ }
    setFxBusy(false);
  };

  const add = () => {
    if (!draft.ticker || !draft.date || !(+draft.quantity > 0)) return;
    const t = { ...draft, ticker: draft.ticker.toUpperCase().trim(), quantity: +draft.quantity, nativeAmount: +draft.nativeAmount || 0, fxRate: +draft.fxRate || 1, gbpAmount: +draft.gbpAmount || 0 };
    setTxns((p) => [...p, t]); setDraft(BLANK());
  };
  // Editing a transaction recomputes gbpAmount from native × fx when either
  // changes (same rule as the add-row form), unless gbpAmount itself was the
  // field just edited — keeps both paths (typing GBP directly, or typing
  // native+fx) working without one silently overwriting the other.
  const updateTxn = (id, patch) => setTxns((all) => all.map((t) => {
    if (t.id !== id) return t;
    const next = { ...t, ...patch };
    if ("nativeAmount" in patch || "fxRate" in patch) {
      const na = +next.nativeAmount || 0, fx = +next.fxRate || 0;
      if (na && fx) next.gbpAmount = +(na * fx).toFixed(2);
    }
    if (patch.nativeCurrency === "GBP") { next.fxRate = 1; if (next.nativeAmount) next.gbpAmount = +next.nativeAmount; }
    return next;
  }));
  const [sort, toggleSort] = useSort("date", "desc");
  const SORT_ACCESSORS = {
    date: (t) => t.date, ticker: (t) => t.ticker, side: (t) => t.side,
    quantity: (t) => +t.quantity || 0, nativeCurrency: (t) => t.nativeCurrency || "",
    nativeAmount: (t) => +t.nativeAmount || 0, fxRate: (t) => +t.fxRate || 0, gbpAmount: (t) => +t.gbpAmount || 0,
  };
  const [filterWrapper, setFilterWrapper] = useState(() => store.get("cgt.ledger.wrapper", "All"));
  React.useEffect(() => store.set("cgt.ledger.wrapper", filterWrapper), [filterWrapper]);
  const wrapperCounts = useMemo(() => {
    const m = {};
    for (const t of txns) { const w = normWrapper(t.wrapper); m[w] = (m[w] || 0) + 1; }
    return m;
  }, [txns]);
  const scopedTxns = filterWrapper === "All" ? txns : txns.filter((t) => normWrapper(t.wrapper) === filterWrapper);
  const filteredRows = useMemo(() => sortRows(scopedTxns, sort, SORT_ACCESSORS), [scopedTxns, sort]);
  // Adding a transaction while filtered to one wrapper should land in that
  // wrapper by default — switching the filter re-defaults the add-form too,
  // without fighting a manual override mid-edit.
  React.useEffect(() => { if (filterWrapper !== "All") setDraft((d) => ({ ...d, wrapper: filterWrapper })); }, [filterWrapper]);

  return (
    <div className="space-y-4">
      {/* wrapper filter — replaces the per-row Wrapper column */}
      <div className="flex flex-wrap gap-1.5">
        {["All", ...WRAPPERS].filter((w) => w === "All" || wrapperCounts[w]).map((w) => (
          <button key={w} onClick={() => setFilterWrapper(w)}
            className={"text-xs font-medium px-2.5 py-1 rounded-full border transition " +
              (filterWrapper === w ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
            {w}{w !== "All" ? ` (${wrapperCounts[w] || 0})` : ` (${txns.length})`}
          </button>
        ))}
      </div>

      {/* add row */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        {/* Date gets a wider track than its 8 siblings (1.3fr vs 1fr each) —
            "yyyy-mm-dd" plus the native date-picker icon needs more room than
            an equal 1/9 share gives it. */}
        <div className="grid grid-cols-2 sm:grid-cols-[1.3fr_repeat(8,1fr)] gap-2 items-end">
          <Field label="Date"><input type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} className="input num w-full" /></Field>
          <Field label="Ticker"><input value={draft.ticker} onChange={(e) => set("ticker", e.target.value)} placeholder="WFC" className="input w-full" /></Field>
          <Field label="Side">
            <select value={draft.side} onChange={(e) => set("side", e.target.value)} className="input w-full"><option>BUY</option><option>SELL</option></select>
          </Field>
          <Field label="Wrapper">
            <select value={draft.wrapper} onChange={(e) => set("wrapper", e.target.value)} className="input w-full">{WRAPPERS.map((w) => <option key={w}>{w}</option>)}</select>
          </Field>
          <Field label="Quantity"><input type="number" value={draft.quantity} onChange={(e) => set("quantity", e.target.value)} className="input num w-full" /></Field>
          <Field label="Ccy">
            <select value={draft.nativeCurrency} onChange={(e) => set("nativeCurrency", e.target.value)} className="input w-full">
              {["GBP", "USD", "EUR", "CHF"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>
          <Field label="Native amount"><input type="number" value={draft.nativeAmount} onChange={(e) => set("nativeAmount", e.target.value)} className="input num w-full" /></Field>
          <Field label={<span className="flex items-center gap-1">FX→GBP {draft.nativeCurrency !== "GBP" && <button onClick={fetchFx} title="Fetch ECB rate for date" className="text-[var(--accent)]">{fxBusy ? <RefreshCw size={12} className="animate-spin" /> : <Wand2 size={12} />}</button>}</span>}>
            <input type="number" value={draft.fxRate} onChange={(e) => set("fxRate", e.target.value)} disabled={draft.nativeCurrency === "GBP"} className="input num w-full disabled:opacity-50" />
          </Field>
          <Field label="GBP amount"><input type="number" value={draft.gbpAmount} onChange={(e) => set("gbpAmount", e.target.value)} className="input num w-full" /></Field>
        </div>
        <div className="flex items-center justify-between mt-2">
          <span className="text-xs text-[var(--muted)]">{draft.nativeCurrency !== "GBP" ? "GBP auto-computes from native × rate; both stay editable." : "GBP transaction — rate fixed at 1."}</span>
          <button onClick={add} className="btn-accent"><Plus size={15} /> Add transaction</button>
        </div>
      </div>

      {/* table — every field editable inline; edits recompute GBP from native×fx same as the add form */}
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <SortTh id="date" label="Date" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium" />
              <SortTh id="ticker" label="Ticker" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium" />
              <SortTh id="side" label="Side" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium" />
              <SortTh id="quantity" label="Qty" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium" />
              <SortTh id="nativeCurrency" label="Ccy" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium" />
              <SortTh id="nativeAmount" label="Native" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium" />
              <SortTh id="fxRate" label="FX" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium" />
              <SortTh id="gbpAmount" label="GBP" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium" />
              {/* Sticky to the right so it's never scrolled out of view on a
                  table this wide — the whole point of a delete control is
                  that it's always reachable, not something you have to go
                  hunting for past eight other columns. */}
              <th className="px-2 py-1.5 text-left font-medium sticky right-0 bg-[var(--panel2)] border-l border-[var(--border)]">Delete</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {filteredRows.map((t) => {
              const isGBP = (t.nativeCurrency || "GBP") === "GBP";
              return (
                <tr key={t.id} className="group hover:bg-[var(--panel2)]">
                  <td className="px-2 py-1"><input type="date" value={t.date} onChange={(e) => updateTxn(t.id, { date: e.target.value })} className="input num w-32 py-1 text-sm" /></td>
                  <td className="px-2 py-1"><input value={t.ticker} onChange={(e) => updateTxn(t.id, { ticker: e.target.value.toUpperCase() })} className="input w-24 py-1 text-sm font-medium" /></td>
                  <td className="px-2 py-1">
                    <select value={t.side} onChange={(e) => updateTxn(t.id, { side: e.target.value })}
                      className={"input w-20 py-1 text-sm font-semibold " + (t.side === "BUY" ? "text-[var(--gain)]" : "text-[var(--loss)]")}>
                      <option>BUY</option><option>SELL</option>
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right"><NumberInput value={t.quantity} onChange={(v) => updateTxn(t.id, { quantity: v })} className="w-28 py-1 text-sm" dp={4} /></td>
                  <td className="px-2 py-1">
                    <select value={t.nativeCurrency || "GBP"} onChange={(e) => updateTxn(t.id, { nativeCurrency: e.target.value })} className="input w-20 py-1 text-sm">
                      {["GBP", "USD", "EUR", "CHF"].map((c) => <option key={c}>{c}</option>)}
                    </select>
                  </td>
                  <td className="px-2 py-1 text-right">
                    <NumberInput value={isGBP ? t.gbpAmount : t.nativeAmount} onChange={(v) => updateTxn(t.id, { nativeAmount: v })} disabled={isGBP} className="w-28 py-1 text-sm" />
                  </td>
                  <td className="px-2 py-1 text-right">
                    <input type="number" value={t.fxRate ?? 1} disabled={isGBP} onChange={(e) => updateTxn(t.id, { fxRate: +e.target.value || 0 })} className="input num w-16 py-1 text-sm text-right disabled:opacity-50" />
                  </td>
                  <td className="px-2 py-1 text-right"><NumberInput value={t.gbpAmount} onChange={(v) => updateTxn(t.id, { gbpAmount: v })} className="w-28 py-1 text-sm font-medium" /></td>
                  <td className="px-2 py-1 sticky right-0 bg-[var(--panel)] group-hover:bg-[var(--panel2)] border-l border-[var(--border)]">
                    <TwoStepDelete onConfirm={() => setTxns((p) => p.filter((x) => x.id !== t.id))} label={`Delete transaction: ${t.date} ${t.ticker}`} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ----------------------- Live prices (Alpha Vantage) ---------------- */

export default LedgerTab;
