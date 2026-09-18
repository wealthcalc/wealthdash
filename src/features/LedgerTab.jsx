import React, { useState, useMemo, useCallback, useRef } from "react";
import { Plus, Wand2, RefreshCw, Search, X } from "lucide-react";
import { WRAPPERS, normWrapper } from "../core/portfolio.mjs";
import { store, num, NumberInput, uid, todayISO, Field, FormErrors, EnterSubmits, fxToGBP, gbp, useSort, sortRows, SortTh, TwoStepDelete, useVirtualRows, VIRTUALIZE_THRESHOLD } from "../ui/shared.jsx";
import { validateFields, req, pos, isoDate, nonNeg, numberish } from "../core/validate.mjs";
import useAppStore from "../state/appStore.js";
import { showUndo } from "../ui/undo.jsx";

// `fees`: dealing costs NOT already inside the amount (commission, stamp
// duty, PTM levy) — BUY cost +fees, SELL proceeds −fees in the CGT/returns
// engines. IBKR imports net commissions into the amount, so leave 0 there.
// `account`: free-text broker/account label ("HL ISA", "IBKR") so two
// accounts in the same wrapper stay distinguishable.
const BLANK = () => ({ id: uid(), date: todayISO(), ticker: "", side: "BUY", quantity: "", nativeCurrency: "GBP", nativeAmount: "", fxRate: 1, gbpAmount: "", fees: "", account: "", wrapper: "GIA", note: "" });
// Phase 2.8 de-drilling: all raw persisted state from the store.
function LedgerTab({ onOpenHolding }) {
  const txns = useAppStore((s) => s.txns), setTxns = useAppStore((s) => s.setTxns);
  const secMeta = useAppStore((s) => s.secMeta);
  // Pension/LISA fund rows are unit SNAPSHOTS written by the Pension tab
  // (one row per fund, overwritten in place), not trades. Editing one here
  // — changing its quantity, say — silently corrupts the Pension view, so
  // they're shown but locked, with a link to where they're actually edited.
  const isSnapshotRow = (t) => secMeta?.[t.ticker]?.kind === "fund" || t.ticker === "LISA_INVESTED";
  // A one-shot search handed over by the holding drawer ("all TG36 trades"):
  // read once and cleared, so a later visit doesn't reopen pre-filtered.
  const [query, setQuery] = useState(() => { const q = store.get("cgt.ledger.search", ""); if (q) store.set("cgt.ledger.search", ""); return q || ""; });
  const [selected, setSelected] = useState(() => new Set());
  const [draft, setDraft] = useState(BLANK());
  // Progressive disclosure: most entries are simple GBP buys, so the
  // add-form shows six fields; Ccy/FX/fees/account live behind "More"
  // (persisted — anyone entering foreign trades keeps it open).
  const [advanced, setAdvanced] = useState(() => store.get("cgt.ledger.advanced", false));
  React.useEffect(() => store.set("cgt.ledger.advanced", advanced), [advanced]);
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

  const [errors, setErrors] = useState({});
  const add = () => {
    // Every rejected field says why — the old handler returned silently,
    // which reads as a broken button rather than a missing value.
    const r = validateFields(draft, {
      ticker: [req("Ticker")],
      date: [isoDate("Date")],
      quantity: [pos("Quantity")],
      gbpAmount: [numberish("GBP amount"), nonNeg("GBP amount")],
      nativeAmount: [numberish("Native amount"), nonNeg("Native amount")],
      fxRate: [numberish("FX rate")],
      fees: [numberish("Fees"), nonNeg("Fees")],
    });
    setErrors(r.errors);
    if (!r.ok) return;
    const t = { ...draft, ticker: draft.ticker.toUpperCase().trim(), quantity: +draft.quantity, nativeAmount: +draft.nativeAmount || 0, fxRate: +draft.fxRate || 1, gbpAmount: +draft.gbpAmount || 0, fees: +draft.fees || 0, account: (draft.account || "").trim(), note: (draft.note || "").trim() };
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
    fees: (t) => +t.fees || 0, account: (t) => t.account || "", note: (t) => t.note || "",
  };
  const [filterWrapper, setFilterWrapper] = useState(() => store.get("cgt.ledger.wrapper", "All"));
  React.useEffect(() => store.set("cgt.ledger.wrapper", filterWrapper), [filterWrapper]);
  const wrapperCounts = useMemo(() => {
    const m = {};
    for (const t of txns) { const w = normWrapper(t.wrapper); m[w] = (m[w] || 0) + 1; }
    return m;
  }, [txns]);
  const scopedTxns = filterWrapper === "All" ? txns : txns.filter((t) => normWrapper(t.wrapper) === filterWrapper);
  // Free-text search across the fields a person actually remembers a trade
  // by — ticker, note, account, date — so "every TG35 trade" is a keystroke,
  // not a sort-and-scroll through thousands of rows.
  const q = query.trim().toLowerCase();
  const searched = useMemo(() => {
    if (!q) return scopedTxns;
    const terms = q.split(/\s+/);
    return scopedTxns.filter((t) => {
      const hay = `${t.ticker || ""} ${t.note || ""} ${t.account || ""} ${t.date || ""} ${t.side || ""} ${secMeta?.[t.ticker]?.name || ""}`.toLowerCase();
      return terms.every((term) => hay.includes(term));
    });
  }, [scopedTxns, q, secMeta]);
  const filteredRows = useMemo(() => sortRows(searched, sort, SORT_ACCESSORS), [searched, sort]);

  // Bulk selection. Only editable (non-snapshot) rows are selectable, and
  // the header checkbox acts on what's VISIBLE after filter + search, which
  // is the set the person is looking at and meant.
  const selectableVisible = filteredRows.filter((t) => !isSnapshotRow(t));
  const allVisibleSelected = selectableVisible.length > 0 && selectableVisible.every((t) => selected.has(t.id));
  const toggleOne = (id) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAllVisible = () => setSelected((s) => {
    const n = new Set(s);
    if (allVisibleSelected) selectableVisible.forEach((t) => n.delete(t.id)); else selectableVisible.forEach((t) => n.add(t.id));
    return n;
  });
  const clearSelection = () => setSelected(new Set());
  const bulkDelete = () => {
    const ids = new Set(selected);
    const removed = txns.filter((t) => ids.has(t.id));
    if (!removed.length) return;
    setTxns((p) => p.filter((t) => !ids.has(t.id)));
    clearSelection();
    showUndo({
      message: `Deleted ${removed.length} transaction${removed.length === 1 ? "" : "s"}`,
      onUndo: () => setTxns((p) => [...p, ...removed]),
    });
  };
  const bulkPatch = (patch, label) => {
    const ids = new Set(selected);
    const before = txns.filter((t) => ids.has(t.id));
    if (!before.length) return;
    setTxns((p) => p.map((t) => (ids.has(t.id) ? { ...t, ...patch } : t)));
    showUndo({
      message: `${label} on ${before.length} transaction${before.length === 1 ? "" : "s"}`,
      onUndo: () => setTxns((p) => p.map((t) => before.find((b) => b.id === t.id) || t)),
    });
  };
  const knownAccounts = [...new Set(txns.map((t) => t.account).filter(Boolean))].sort();
  // Windowed rendering past VIRTUALIZE_THRESHOLD rows (see ui/shared.jsx) —
  // a decade of active trading can comfortably run into thousands of rows,
  // and rendering every <tr> at once gets sluggish well before that.
  const LEDGER_ROW_H = 40;
  const virtualLedger = filteredRows.length > VIRTUALIZE_THRESHOLD;
  const { containerRef: ledgerScrollRef, start: ledgerStart, end: ledgerEnd, topPad: ledgerTopPad, bottomPad: ledgerBottomPad } =
    useVirtualRows(virtualLedger ? filteredRows.length : 0, LEDGER_ROW_H);
  const visibleRows = virtualLedger ? filteredRows.slice(ledgerStart, ledgerEnd) : filteredRows;
  // Adding a transaction while filtered to one wrapper should land in that
  // wrapper by default — switching the filter re-defaults the add-form too,
  // without fighting a manual override mid-edit.
  React.useEffect(() => { if (filterWrapper !== "All") setDraft((d) => ({ ...d, wrapper: filterWrapper })); }, [filterWrapper]);

  return (
    <div className="space-y-4">
      {/* wrapper filter — replaces the per-row Wrapper column — plus search */}
      <div className="flex flex-wrap items-center gap-1.5">
        {["All", ...WRAPPERS].filter((w) => w === "All" || wrapperCounts[w]).map((w) => (
          <button key={w} onClick={() => setFilterWrapper(w)}
            className={"text-xs font-medium px-2.5 py-1 rounded-full border transition " +
              (filterWrapper === w ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-fg)]" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--fg)]")}>
            {w}{w !== "All" ? ` (${wrapperCounts[w] || 0})` : ` (${txns.length})`}
          </button>
        ))}
        <label className="ml-auto relative flex items-center">
          <Search size={13} className="absolute left-2 text-[var(--muted)]" aria-hidden="true" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search ticker, note, account, date…"
            className="input pl-7 pr-7 py-1 text-sm w-64" aria-label="Search transactions" />
          {query && <button onClick={() => setQuery("")} className="absolute right-2 text-[var(--muted)] hover:text-[var(--fg)]" aria-label="Clear search"><X size={13} /></button>}
        </label>
        {q && <span className="text-xs text-[var(--muted)]">{filteredRows.length} match{filteredRows.length === 1 ? "" : "es"}</span>}
      </div>

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-[var(--accent)] bg-[color:color-mix(in_srgb,var(--accent)_8%,transparent)] px-3 py-2 text-sm" role="region" aria-label="Bulk actions">
          <span className="font-medium">{selected.size} selected</span>
          <button onClick={bulkDelete} className="text-xs font-medium px-2.5 py-1 rounded-lg border border-[var(--loss)] text-[var(--loss)] hover:bg-[color:color-mix(in_srgb,var(--loss)_10%,transparent)]">Delete</button>
          <label className="text-xs text-[var(--muted)] flex items-center gap-1">Set wrapper
            <select className="input py-0.5 text-xs" value="" onChange={(e) => { if (e.target.value) bulkPatch({ wrapper: e.target.value }, `Wrapper → ${e.target.value}`); }}>
              <option value="">…</option>{WRAPPERS.map((w) => <option key={w}>{w}</option>)}
            </select>
          </label>
          <label className="text-xs text-[var(--muted)] flex items-center gap-1">Set account
            <input list="ledger-accounts" className="input py-0.5 text-xs w-32" placeholder="type or pick" onKeyDown={(e) => { if (e.key === "Enter" && e.target.value.trim()) { bulkPatch({ account: e.target.value.trim() }, `Account → ${e.target.value.trim()}`); e.target.value = ""; } }} />
            <span className="text-[10px]">↵</span>
          </label>
          <button onClick={clearSelection} className="ml-auto text-xs text-[var(--muted)] hover:text-[var(--fg)] underline underline-offset-2">Clear selection</button>
          <span className="basis-full text-[11px] text-[var(--muted)]">Deletes and re-tags can be undone for a few seconds from the toast.</span>
        </div>
      )}

      {/* add row */}
      <EnterSubmits onSubmit={add} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
        {/* Date gets a wider track than its 8 siblings (1.3fr vs 1fr each) —
            "yyyy-mm-dd" plus the native date-picker icon needs more room than
            an equal 1/9 share gives it. */}
        <div className={"grid grid-cols-2 gap-2 items-end " + (advanced ? "sm:grid-cols-[1.3fr_repeat(11,1fr)]" : "sm:grid-cols-[1.3fr_repeat(5,1fr)_auto]")}>
          <Field label="Date" error={errors.date}><input type="date" value={draft.date} onChange={(e) => set("date", e.target.value)} className="input num w-full" aria-invalid={!!errors.date} /></Field>
          <Field label="Ticker" error={errors.ticker}><input value={draft.ticker} onChange={(e) => set("ticker", e.target.value)} placeholder="WFC" className="input w-full" aria-invalid={!!errors.ticker} /></Field>
          <Field label="Side">
            <select value={draft.side} onChange={(e) => set("side", e.target.value)} className="input w-full"><option>BUY</option><option>SELL</option></select>
          </Field>
          <Field label="Wrapper">
            <select value={draft.wrapper} onChange={(e) => set("wrapper", e.target.value)} className="input w-full">{WRAPPERS.map((w) => <option key={w}>{w}</option>)}</select>
          </Field>
          <Field label="Quantity" error={errors.quantity}><input type="number" value={draft.quantity} onChange={(e) => set("quantity", e.target.value)} className="input num w-full" aria-invalid={!!errors.quantity} /></Field>
          {advanced && <Field label="Ccy">
            <select value={draft.nativeCurrency} onChange={(e) => set("nativeCurrency", e.target.value)} className="input w-full">
              {["GBP", "USD", "EUR", "CHF"].map((c) => <option key={c}>{c}</option>)}
            </select>
          </Field>}
          {advanced && <Field label="Native amount"><input type="number" value={draft.nativeAmount} onChange={(e) => set("nativeAmount", e.target.value)} className="input num w-full" /></Field>}
          {advanced && <Field label={<span className="flex items-center gap-1">FX→GBP {draft.nativeCurrency !== "GBP" && <button onClick={fetchFx} title="Fetch ECB rate for date" className="text-[var(--accent)]">{fxBusy ? <RefreshCw size={12} className="animate-spin" /> : <Wand2 size={12} />}</button>}</span>}>
            <input type="number" value={draft.fxRate} onChange={(e) => set("fxRate", e.target.value)} disabled={draft.nativeCurrency === "GBP"} className="input num w-full disabled:opacity-50" />
          </Field>}
          <Field label="GBP amount" error={errors.gbpAmount}><input type="number" value={draft.gbpAmount} onChange={(e) => set("gbpAmount", e.target.value)} className="input num w-full" aria-invalid={!!errors.gbpAmount} /></Field>
          {advanced && <Field label={<span title="Dealing costs NOT already in the amount: commission, stamp duty, PTM levy (£). Buys add to CGT cost, sells reduce proceeds. Leave 0 if your amount already includes them (IBKR imports do).">Fees £</span>}>
            <input type="number" value={draft.fees} onChange={(e) => set("fees", e.target.value)} placeholder="0" className="input num w-full" />
          </Field>}
          {advanced && <Field label={<span title="Broker/account label so two accounts in the same wrapper stay distinguishable">Account</span>}>
            <input value={draft.account} onChange={(e) => set("account", e.target.value)} placeholder="HL ISA" className="input w-full" list="ledger-accounts" />
          </Field>}
          {advanced && <Field label="Note"><input value={draft.note} onChange={(e) => set("note", e.target.value)} placeholder="optional" className="input w-full" /></Field>}
          {!advanced && (
            <button onClick={() => setAdvanced(true)} title="Foreign currency, FX rate, dealing fees, account label"
              className="text-xs text-[var(--accent)] underline underline-offset-2 pb-2 whitespace-nowrap justify-self-start">
              More…
            </button>
          )}
        </div>
        {advanced && (
          <button onClick={() => setAdvanced(false)} className="mt-1 text-xs text-[var(--muted)] underline underline-offset-2">
            Fewer fields (hides Ccy/FX/fees/account/note — values entered stay on the transaction)
          </button>
        )}
        <div className="flex items-center justify-between mt-2 gap-3 flex-wrap">
          <span className="text-xs text-[var(--muted)]">{draft.nativeCurrency !== "GBP" ? "GBP auto-computes from native × rate; both stay editable." : "GBP transaction — rate fixed at 1."} Enter adds.</span>
          <div className="flex items-center gap-3">
            <FormErrors errors={errors} />
            <button onClick={add} className="btn-accent"><Plus size={15} /> Add transaction</button>
          </div>
        </div>
      </EnterSubmits>

      {/* table — every field editable inline; edits recompute GBP from native×fx same as the add form.
          Past VIRTUALIZE_THRESHOLD rows this becomes a capped-height scroll
          region with a sticky header and only the visible rows (plus
          overscan) actually in the DOM — see ui/shared.jsx's useVirtualRows. */}
      {/* Phone: a read-only card per transaction instead of a 13-column
          sideways scroll. Editing stays on desktop, where the inputs fit. */}
      <div className="sm:hidden space-y-1.5">
        {filteredRows.slice(0, 200).map((t) => (
          <div key={t.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <span className={"text-[11px] font-semibold px-1.5 py-0.5 rounded " + (t.side === "BUY" ? "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]" : "bg-[color:color-mix(in_srgb,var(--loss)_18%,transparent)] text-[var(--loss)]")}>{t.side}</span>
                {onOpenHolding ? <button onClick={() => onOpenHolding(t.ticker)} className="font-medium hover:text-[var(--accent)]">{t.ticker}</button> : <span className="font-medium">{t.ticker}</span>}
                <span className="text-[11px] text-[var(--muted)]">{normWrapper(t.wrapper)}</span>
              </div>
              <span className="num font-medium">{gbp(+t.gbpAmount || 0)}</span>
            </div>
            <div className="flex items-center justify-between text-[11px] text-[var(--muted)] mt-0.5 num">
              <span>{t.date} · {num(+t.quantity || 0, (+t.quantity || 0) % 1 ? 4 : 0)} @ {+t.quantity ? gbp((+t.gbpAmount || 0) / +t.quantity) : "—"}</span>
              <span className="truncate max-w-[45%]">{t.account || ""}{t.account && t.note ? " · " : ""}{t.note || ""}</span>
            </div>
          </div>
        ))}
        {filteredRows.length > 200 && <p className="text-xs text-[var(--muted)]">Showing the first 200 of {filteredRows.length} — narrow with search, or use a larger screen to edit.</p>}
      </div>

      <div ref={virtualLedger ? ledgerScrollRef : undefined} className="hidden sm:block rounded-xl border border-[var(--border)] overflow-x-auto" style={virtualLedger ? { maxHeight: "70vh", overflowY: "auto" } : undefined}>
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <th className="px-2 py-1.5 sticky top-0 z-10 bg-[var(--panel2)] w-8">
                <input type="checkbox" checked={allVisibleSelected} onChange={toggleAllVisible} disabled={!selectableVisible.length}
                  aria-label={allVisibleSelected ? "Deselect all visible transactions" : "Select all visible transactions"} />
              </th>
              <SortTh id="date" label="Date" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="ticker" label="Ticker" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="side" label="Side" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="quantity" label="Qty" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="nativeCurrency" label="Ccy" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="nativeAmount" label="Native" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="fxRate" label="FX" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="gbpAmount" label="GBP" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="fees" label="Fees" sort={sort} onSort={toggleSort} align="right" className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="account" label="Account" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              <SortTh id="note" label="Note" sort={sort} onSort={toggleSort} className="px-2 py-1.5 font-medium sticky top-0 z-10 bg-[var(--panel2)]" />
              {/* Sticky to the right (and, above the threshold, also to the
                  top) so it's never scrolled out of view on a table this
                  wide — the whole point of a delete control is that it's
                  always reachable, not something you have to go hunting
                  for past eight other columns. */}
              <th className="px-2 py-1.5 text-left font-medium sticky right-0 top-0 z-20 bg-[var(--panel2)] border-l border-[var(--border)]">Delete</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {ledgerTopPad > 0 && <tr aria-hidden="true"><td colSpan={13} style={{ height: ledgerTopPad, padding: 0, border: 0 }} /></tr>}
            {visibleRows.map((t) => {
              const isGBP = (t.nativeCurrency || "GBP") === "GBP";
              if (isSnapshotRow(t)) {
                return (
                  <tr key={t.id} className="group bg-[var(--panel2)]/40 text-[var(--muted)]" title="Pension/LISA fund units are set on the Pension & LISA tab, not here — this row is the snapshot it writes.">
                    <td className="px-2 py-1" />
                    <td className="px-2 py-1 num text-xs">{t.date}</td>
                    <td className="px-2 py-1 font-medium">{t.ticker}</td>
                    <td className="px-2 py-1 text-xs">units</td>
                    <td className="px-2 py-1 num text-right">{num(+t.quantity || 0, 4)}</td>
                    <td className="px-2 py-1 text-xs">GBP</td>
                    <td className="px-2 py-1 num text-right">—</td>
                    <td className="px-2 py-1 num text-right">—</td>
                    <td className="px-2 py-1 num text-right">{gbp(+t.gbpAmount || 0)}</td>
                    <td className="px-2 py-1 num text-right">—</td>
                    <td className="px-2 py-1 text-xs">{t.account || "—"}</td>
                    <td className="px-2 py-1 text-xs truncate max-w-[16rem]">Pension/LISA units snapshot</td>
                    <td className="px-2 py-1 sticky right-0 bg-[var(--panel)] border-l border-[var(--border)] text-xs whitespace-nowrap">
                      <a href="#/pension" className="text-[var(--accent)] hover:underline">Pension tab →</a>
                    </td>
                  </tr>
                );
              }
              return (
                <tr key={t.id} className={"group hover:bg-[var(--panel2)] " + (selected.has(t.id) ? "bg-[color:color-mix(in_srgb,var(--accent)_8%,transparent)]" : "")}>
                  <td className="px-2 py-1"><input type="checkbox" checked={selected.has(t.id)} onChange={() => toggleOne(t.id)} aria-label={`Select ${t.date} ${t.ticker}`} /></td>
                  <td className="px-2 py-1"><input type="date" value={t.date} onChange={(e) => updateTxn(t.id, { date: e.target.value })} className="input num w-32 py-1 text-sm" /></td>
                  <td className="px-2 py-1">
                    <div className="flex items-center gap-1">
                      <input value={t.ticker} onChange={(e) => updateTxn(t.id, { ticker: e.target.value.toUpperCase() })} className="input w-24 py-1 text-sm font-medium" />
                      {onOpenHolding && t.ticker && (
                        <button onClick={() => onOpenHolding(t.ticker)} className="text-[var(--muted)] hover:text-[var(--accent)] text-xs" title={`Everything about ${t.ticker}`} aria-label={`Open ${t.ticker}`}>↗</button>
                      )}
                    </div>
                    {secMeta?.[t.ticker]?.name && <div className="text-[10px] text-[var(--muted)] truncate max-w-[9rem] leading-tight" title={secMeta[t.ticker].name}>{secMeta[t.ticker].name}</div>}
                  </td>
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
                  <td className="px-2 py-1 text-right"><NumberInput value={t.fees ?? 0} onChange={(v) => updateTxn(t.id, { fees: v })} className="w-20 py-1 text-sm" /></td>
                  <td className="px-2 py-1"><input value={t.account || ""} onChange={(e) => updateTxn(t.id, { account: e.target.value })} placeholder="—" className="input w-24 py-1 text-sm" list="ledger-accounts" /></td>
                  <td className="px-2 py-1"><input value={t.note || ""} onChange={(e) => updateTxn(t.id, { note: e.target.value })} placeholder="—" className="input w-40 py-1 text-sm" title={t.note || ""} /></td>
                  <td className="px-2 py-1 sticky right-0 bg-[var(--panel)] group-hover:bg-[var(--panel2)] border-l border-[var(--border)]">
                    <TwoStepDelete onConfirm={() => setTxns((p) => p.filter((x) => x.id !== t.id))} label={`Delete transaction: ${t.date} ${t.ticker}`} />
                  </td>
                </tr>
              );
            })}
            {ledgerBottomPad > 0 && <tr aria-hidden="true"><td colSpan={13} style={{ height: ledgerBottomPad, padding: 0, border: 0 }} /></tr>}
          </tbody>
        </table>
      </div>
      {virtualLedger && (
        <p className="text-xs text-[var(--muted)]">
          Showing {visibleRows.length} of {filteredRows.length} transactions in view — scroll for more (rendering all {filteredRows.length} at once past {VIRTUALIZE_THRESHOLD} rows gets sluggish, so only the visible window is in the page).
        </p>
      )}
      {/* one shared suggestion list for the add-form and inline Account inputs */}
      <datalist id="ledger-accounts">
        {knownAccounts.map((a) => <option key={a} value={a} />)}
      </datalist>
      <p className="text-xs text-[var(--muted)]">
        Fees are dealing costs <span className="font-medium">not already inside the GBP amount</span> (commission, stamp duty, PTM levy): buys add them to the CGT cost, sells deduct them from proceeds, and returns are computed net of them. IBKR imports already net commissions into the amount — leave their fees at 0. Account is a free label ("HL ISA", "IBKR") so two brokers in one wrapper stay distinguishable.
      </p>
    </div>
  );
}

/* ----------------------- Live prices (Alpha Vantage) ---------------- */

export default LedgerTab;
