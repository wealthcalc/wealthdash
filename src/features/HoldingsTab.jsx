import React, { useState, useMemo, useCallback, useRef } from "react";
import { isWrapperTaxable } from "../core/portfolio.mjs";
import LivePricesPanel from "../ui/LivePricesPanel.jsx";
import { gbp, gbp0, WrapperChip, num, pct, Stat, Empty } from "../ui/shared.jsx";

function HoldingsTab({ positions, prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, setSecMeta, dmoReportDate, setDmoReportDate }) {
  const open = positions.filter((p) => p.qty > 1e-6);
  if (!open.length) return <Empty msg="No open holdings yet. Add buy transactions (any wrapper) to see your positions and unrealised gains." />;

  const setISIN = (tk, v) => setSecMeta((m) => ({ ...m, [tk]: { ...m[tk], isin: v.toUpperCase().trim() } }));

  const rows = open.map((p) => {
    const cost = p.bookCost;
    const avg = p.qty ? cost / p.qty : 0;
    const price = prices[p.ticker] ?? "";
    const hasP = price !== "" && !isNaN(+price);
    const value = hasP ? p.qty * +price : null;
    const unreal = hasP ? value - cost : null;
    return { tk: p.ticker, wrapper: p.wrapper, qty: p.qty, cost, avg, price, value, unreal,
      pct: hasP && cost ? (unreal / cost) * 100 : null, sec: secMeta[p.ticker] || {},
      sheltered: !isWrapperTaxable(p.wrapper) };
  }).sort((a, b) => a.wrapper.localeCompare(b.wrapper) || a.tk.localeCompare(b.tk));

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
            <tr>{["Wrapper", "Ticker", "ISIN", "Quantity", "Avg cost", "Pool cost", "Price now", "Market value", "Unrealised", "%"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i <= 2 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {rows.map((r) => (
              <tr key={r.wrapper + r.tk} className="hover:bg-[var(--panel2)]">
                <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                <td className="px-3 py-2 font-medium">
                  {r.tk}
                  {r.sec.eri === true && <span title="Offshore reporting fund — generates excess reportable income (ERI) while held unsheltered" className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-bb)_18%,transparent)] text-[var(--m-bb)] align-middle">ERI</span>}
                </td>
                <td className="px-3 py-2">
                  <input value={r.sec.isin || ""} onChange={(e) => setISIN(r.tk, e.target.value)} placeholder="IE00…" className="input font-mono text-xs w-36 py-1" />
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
      </p>
    </div>
  );
}

/* --------------------------- Planning tab --------------------------- */
// Shared scope banner for the three CGT-specific tools (Planning, Report,
// What-if). These are deliberately GIA-only: they compute UK Capital Gains
// Tax, which only applies to unsheltered holdings. ISA/SIPP/LISA/VCT are
// exempt, so including them here would be misleading, not helpful.

export default HoldingsTab;
