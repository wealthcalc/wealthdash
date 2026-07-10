import React, { useState, useMemo, useCallback, useRef } from "react";
import { isWrapperTaxable } from "../core/portfolio.mjs";
import LivePricesPanel from "../ui/LivePricesPanel.jsx";
import { gbp, gbp0, WrapperChip, num, pct, Stat, Empty, useSort, sortRows, SortTh } from "../ui/shared.jsx";

function HoldingsTab({ positions, prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, setSecMeta, dmoReportDate, setDmoReportDate }) {
  const open = positions.filter((p) => p.qty > 1e-6);
  const [sort, toggleSort] = useSort("wrapper", "asc");
  if (!open.length) return <Empty msg="No open holdings yet. Add buy transactions (any wrapper) to see your positions and unrealised gains." />;

  const setISIN = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], isin: v.toUpperCase().trim() } }));
  // Region/sector tags — look-through v0, read by the Wealth tab's
  // exposure bars (core/exposure.mjs). Free text with suggestions;
  // whatever the user types is their own claim about what a fund holds.
  const setTag = (tk, field, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], [field]: v } }));

  // Sorted by ticker first so that when the user's chosen sort key ties
  // (e.g. every row shares a wrapper), the stable sort below keeps a
  // sensible secondary order instead of falling back to insertion order.
  const baseRows = open.map((p) => {
    const cost = p.bookCost;
    const avg = p.qty ? cost / p.qty : 0;
    const price = prices[p.ticker] ?? "";
    const hasP = price !== "" && !isNaN(+price);
    const value = hasP ? p.qty * +price : null;
    const unreal = hasP ? value - cost : null;
    return { tk: p.ticker, wrapper: p.wrapper, qty: p.qty, cost, avg, price, value, unreal,
      pct: hasP && cost ? (unreal / cost) * 100 : null, sec: secMeta[p.ticker] || {},
      sheltered: !isWrapperTaxable(p.wrapper) };
  }).sort((a, b) => a.tk.localeCompare(b.tk));
  const rows = sortRows(baseRows, sort, {
    wrapper: (r) => r.wrapper, tk: (r) => r.tk, qty: (r) => r.qty, avg: (r) => r.avg, cost: (r) => r.cost,
    price: (r) => (r.price === "" ? null : +r.price), value: (r) => r.value, unreal: (r) => r.unreal, pct: (r) => r.pct,
  });

  const priced = rows.filter((r) => r.value != null);
  const totCost = priced.reduce((s, r) => s + r.cost, 0);
  const totValue = priced.reduce((s, r) => s + r.value, 0);
  const totUnreal = totValue - totCost;
  const missingIsin = rows.filter((r) => !r.sec.isin).length;
  const tickers = [...new Set(rows.map((r) => r.tk))];
  // Taxable vs sheltered split of pool cost, so the all-wrapper view still
  // makes the CGT-relevant portion obvious at a glance.
  const taxableCost = rows.filter((r) => !r.sheltered).reduce((s, r) => s + r.cost, 0);
  const shelteredCost = rows.filter((r) => r.sheltered).reduce((s, r) => s + r.cost, 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Open pool cost" value={gbp0(rows.reduce((s, r) => s + r.cost, 0))} sub={`taxable ${gbp0(taxableCost)} · sheltered ${gbp0(shelteredCost)}`} />
        <Stat label="Market value (priced)" value={priced.length ? gbp0(totValue) : "—"} sub={priced.length < rows.length ? `${priced.length}/${rows.length} priced` : "all priced"} />
        <Stat label="Unrealised gain" value={priced.length ? gbp0(totUnreal) : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} big />
        <Stat label="Unrealised %" value={priced.length && totCost ? `${totUnreal >= 0 ? "+" : ""}${num((totUnreal / totCost) * 100)}%` : "—"} tone={totUnreal >= 0 ? "gain" : "loss"} />
      </div>

      <LivePricesPanel {...{ tickers, avKey, setAvKey, avMeta, setAvMeta, prices, setPrices, priceMeta, setPriceMeta, txns, secMeta, dmoReportDate, setDmoReportDate }} />

      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <SortTh id="wrapper" label="Wrapper" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
              <SortTh id="tk" label="Ticker" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
              <th className="px-3 py-2 font-medium text-left">ISIN</th>
              <th className="px-3 py-2 font-medium text-left" title="Where the holding's underlying exposure actually is — your judgement, powers the Wealth tab's region bar">Region</th>
              <th className="px-3 py-2 font-medium text-left" title="Sector of the underlying exposure — 'Diversified' is the honest tag for a broad fund">Sector</th>
              <SortTh id="qty" label="Quantity" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="avg" label="Avg cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="cost" label="Pool cost" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="price" label="Price now" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="value" label="Market value" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="unreal" label="Unrealised" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="pct" label="%" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {rows.map((r) => (
              <tr key={r.wrapper + r.tk} className="hover:bg-[var(--panel2)]">
                <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                <td className="px-3 py-2 font-medium">
                  {r.tk}
                  {r.sec.eri === true && <span title="Offshore reporting fund — generates excess reportable income (ERI) while held unsheltered" className="ml-1.5 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)] align-middle">ERI</span>}
                </td>
                <td className="px-3 py-2">
                  <input value={r.sec.isin || ""} onChange={(e) => setISIN(r.tk, e.target.value)} placeholder="IE00…" className="input font-mono text-xs w-36 py-1" />
                </td>
                <td className="px-3 py-2">
                  <input list="holdings-region-tags" value={r.sec.region || ""} onChange={(e) => setTag(r.tk, "region", e.target.value)} placeholder="—" className="input text-xs w-24 py-1" aria-label={`Region tag for ${r.tk}`} />
                </td>
                <td className="px-3 py-2">
                  <input list="holdings-sector-tags" value={r.sec.sector || ""} onChange={(e) => setTag(r.tk, "sector", e.target.value)} placeholder="—" className="input text-xs w-24 py-1" aria-label={`Sector tag for ${r.tk}`} />
                </td>
                <td className="px-3 py-2 num text-right">{num(r.qty, r.qty % 1 ? 2 : 0)}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(r.avg)}</td>
                <td className="px-3 py-2 num text-right">{gbp(r.cost)}</td>
                <td className="px-3 py-2 text-right">
                  <input type="number" value={r.price} placeholder="—"
                    onChange={(e) => setPrices((p) => ({ ...p, [r.tk]: e.target.value === "" ? undefined : +e.target.value }))}
                    className="input num w-24 text-right py-1" />
                </td>
                <td className="px-3 py-2 num text-right">{r.value != null ? gbp(r.value) : "—"}</td>
                <td className={"px-3 py-2 num text-right font-medium " + (r.unreal == null ? "text-[var(--muted)]" : r.unreal >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.unreal != null ? gbp(r.unreal) : "—"}</td>
                <td className={"px-3 py-2 num text-right " + (r.pct == null ? "text-[var(--muted)]" : r.pct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{r.pct != null ? `${r.pct >= 0 ? "+" : ""}${num(r.pct)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-[var(--muted)]">
        All holdings across every wrapper (GIA, ISA, SIPP, LISA, VCT). The same price per share applies to a ticker wherever it's held. Prices save locally on your device.
        Unrealised gain = current value − Section 104 pool cost; it's an indicator, not a taxable event. Only <span className="font-semibold">GIA</span> holdings are subject to CGT — ISA/SIPP/LISA/VCT are sheltered.
        {missingIsin > 0 && ` ISIN is set for ${rows.length - missingIsin}/${rows.length} rows — it's the join key for matching issuer ERI reports, so fill in the rest when you get the chance.`}
        {" "}The <span className="text-[var(--m-bb)] font-semibold">ERI</span> badge flags offshore reporting funds.
        {" "}Region/Sector are YOUR look-through tags (a ticker's tags apply wherever it's held) — they feed the Wealth tab's exposure bars, so a world ETF tagged "Global" stops reporting as Irish. Tag a broad fund's sector "Diversified".
      </p>
      <datalist id="holdings-region-tags">
        {["Global", "UK", "US", "Europe ex-UK", "Japan", "Asia ex-Japan", "Emerging markets", "Global ex-US"].map((v) => <option key={v} value={v} />)}
      </datalist>
      <datalist id="holdings-sector-tags">
        {["Diversified", "Technology", "Financials", "Healthcare", "Energy", "Consumer", "Industrials", "Utilities", "Materials", "Telecoms", "Property", "Government bonds"].map((v) => <option key={v} value={v} />)}
      </datalist>
    </div>
  );
}

/* --------------------------- Planning tab --------------------------- */
// Shared scope banner for the three CGT-specific tools (Planning, Report,
// What-if). These are deliberately GIA-only: they compute UK Capital Gains
// Tax, which only applies to unsheltered holdings. ISA/SIPP/LISA/VCT are
// exempt, so including them here would be misleading, not helpful.

export default HoldingsTab;
