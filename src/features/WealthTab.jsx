import React, { useState, useMemo, useCallback, useRef } from "react";
import { AlertCircle, PieChart } from "lucide-react";
import { WRAPPERS } from "../core/portfolio.mjs";
import LivePricesPanel from "../ui/LivePricesPanel.jsx";
import { gbp, gbp0, WrapperChip, num, CurrencyInput, KIND_LABEL, ALLOC_COLORS, AllocBar, pct, Stat, Empty } from "../ui/shared.jsx";

function WealthTab({ model, cash, setCash, prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, dmoReportDate, setDmoReportDate }) {
  if (!model) return <Empty msg="Couldn't build the portfolio model — check the Transactions tab for ledger errors." />;
  const { positions, byWrapper, total, income } = model;
  if (!positions.length && !Object.keys(cash).length)
    return <Empty msg="No holdings yet. Add transactions (any wrapper — GIA, ISA, SIPP, LISA, VCT) on the Transactions or Import tab, and cash balances below will appear here." />;

  const tickers = [...new Set(positions.map((p) => p.ticker))].sort();
  const wrapperOrder = [...WRAPPERS, ...Object.keys(byWrapper).filter((w) => !WRAPPERS.includes(w))].filter((w) => byWrapper[w]);
  const setWrapperCash = (w, v) => setCash((c) => { const n = { ...c }; if (v === "" || isNaN(+v)) delete n[w]; else n[w] = +v; return n; });
  // Pension wrappers aren't accessible until retirement age — split out from
  // everything else ("readily available": GIA, ISA, VCT) so Total Wealth
  // doesn't imply money you can't actually get at right now.
  const PENSION_WRAPPERS = ["SIPP", "LISA"];
  const pensionTotal = PENSION_WRAPPERS.reduce((s, w) => s + (byWrapper[w]?.total || 0), 0);
  const readilyAvailable = total.total - pensionTotal;

  return (
    <div className="space-y-4">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 col-span-2 sm:col-span-1">
          <div className="text-xs text-[var(--muted)]">Total wealth</div>
          <div className="num font-semibold text-2xl mt-0.5">{gbp0(total.total)}</div>
          <div className="text-xs text-[var(--muted)] mt-0.5">{total.positions} holding{total.positions === 1 ? "" : "s"} + cash across {wrapperOrder.length} wrapper{wrapperOrder.length === 1 ? "" : "s"}</div>
          <div className="mt-2 pt-2 border-t border-[var(--border)] flex justify-between gap-3 text-xs">
            <span><span className="text-[var(--muted)]">Readily available</span> <span className="num font-medium">{gbp0(readilyAvailable)}</span></span>
            <span><span className="text-[var(--muted)]">Pension (SIPP+LISA)</span> <span className="num font-medium">{gbp0(pensionTotal)}</span></span>
          </div>
        </div>
        <Stat label="Invested (priced)" value={total.priced ? gbp0(total.marketValue) : "—"} sub={total.unpriced ? `${total.priced}/${total.positions} priced` : "all priced"} />
        <Stat label="Cash" value={gbp0(total.cash)} />
        <Stat label="Unrealised gain" value={total.priced ? gbp0(total.unrealised) : "—"} sub={total.bookCostPriced ? `${total.unrealised >= 0 ? "+" : ""}${num((total.unrealised / total.bookCostPriced) * 100)}% on priced book cost` : undefined} tone={total.unrealised >= 0 ? "gain" : "loss"} />
      </div>

      {total.unpriced > 0 && (
        <div className="flex items-start gap-2 text-xs rounded-lg px-3 py-2 border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)]">
          <AlertCircle size={14} className="mt-0.5 shrink-0 text-[var(--m-bb)]" />
          <span>{total.unpriced} holding{total.unpriced === 1 ? "" : "s"} without a price ({total.unpricedTickers.join(", ")}) — excluded from market value and allocation until priced. Fetch live prices below or type a price into the table.</span>
        </div>
      )}

      <LivePricesPanel {...{ tickers, avKey, setAvKey, avMeta, setAvMeta, prices, setPrices, priceMeta, setPriceMeta, txns, secMeta, dmoReportDate, setDmoReportDate }} />

      {/* per-wrapper roll-up with editable cash */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Holdings", "Book cost", "Market value", "Unrealised", "Cash", "Total"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {wrapperOrder.map((w) => {
              const a = byWrapper[w];
              return (
                <tr key={w} className="hover:bg-[var(--panel2)]">
                  <td className="px-3 py-2">
                    <span className="font-medium">{w}</span>
                    <span className={"ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded " + (a.taxable ? "bg-[var(--chip)] text-[var(--fg)]" : "bg-[color:color-mix(in_srgb,var(--gain)_18%,transparent)] text-[var(--gain)]")}>{a.taxable ? "taxable" : "sheltered"}</span>
                  </td>
                  <td className="px-3 py-2 num text-right">{a.positions}{a.unpriced ? <span className="text-[var(--m-bb)]" title={`${a.unpriced} unpriced`}> *</span> : null}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(a.bookCost)}</td>
                  <td className="px-3 py-2 num text-right">{a.priced ? gbp(a.marketValue) : "—"}</td>
                  <td className={"px-3 py-2 num text-right " + (a.priced ? (a.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]") : "text-[var(--muted)]")}>{a.priced ? gbp(a.unrealised) : "—"}</td>
                  <td className="px-3 py-2 text-right">
                    <CurrencyInput value={cash[w] ?? 0} onChange={(v) => setWrapperCash(w, v)} className="w-32 ml-auto" />
                  </td>
                  <td className="px-3 py-2 num text-right font-medium">{gbp(a.total)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot className="bg-[var(--panel2)]">
            <tr className="font-medium">
              <td className="px-3 py-2">Total</td>
              <td className="px-3 py-2 num text-right">{total.positions}</td>
              <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(total.bookCost)}</td>
              <td className="px-3 py-2 num text-right">{total.priced ? gbp(total.marketValue) : "—"}</td>
              <td className={"px-3 py-2 num text-right " + (total.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{total.priced ? gbp(total.unrealised) : "—"}</td>
              <td className="px-3 py-2 num text-right">{gbp(total.cash)}</td>
              <td className="px-3 py-2 num text-right">{gbp(total.total)}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* allocation */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-4">
        <div className="text-sm font-medium flex items-center gap-2"><PieChart size={15} className="text-[var(--accent)]" /> Allocation <span className="text-xs font-normal text-[var(--muted)]">— by priced market value; unpriced holdings excluded</span></div>
        <AllocBar title="By wrapper" buckets={model.allocation.wrapper} />
        <AllocBar title="By asset class" buckets={model.allocation.assetClass} labelOf={(k) => KIND_LABEL[k] || k} />
        <AllocBar title="By native currency" buckets={model.allocation.currency} />
        <AllocBar title="By fund domicile" buckets={model.allocation.geography} labelOf={(k) => (k === "unknown" ? "Unset" : k)} />
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          Currency is each line's native trading currency (a proxy for listing, not look-through exposure — a USD-quoted S&amp;P 500 ETF and a GBP-quoted one hold the same underlying). Domicile comes from the ISIN registry (IE = Irish-domiciled fund, GB = UK). Look-through asset/geography exposure would need fund-holdings data — out of scope for now.
        </p>
      </div>

      {/* consolidated holdings */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Ticker", "Quantity", "Avg cost", "Book cost", "Price now", "Market value", "Unrealised", "%"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i <= 1 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {positions.map((p) => (
              <tr key={p.wrapper + p.ticker} className="hover:bg-[var(--panel2)]">
                <td className="px-3 py-2">
                  <WrapperChip wrapper={p.wrapper} />
                </td>
                <td className="px-3 py-2 font-medium">
                  <div className="flex items-center gap-1.5">
                    <span>{p.ticker}</span>
                    {p.cgtExempt && <span title="CGT-exempt instrument (individual gilt, TCGA 1992 s115)" className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[color:color-mix(in_srgb,var(--m-same)_18%,transparent)] text-[var(--m-same)] align-middle">CGT-free</span>}
                  </div>
                  {p.name && <div className="text-xs font-normal text-[var(--muted)] truncate max-w-[220px]" title={p.name}>{p.name}</div>}
                </td>
                <td className="px-3 py-2 num text-right">{num(p.qty, p.qty % 1 ? 2 : 0)}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{gbp(p.avgCost)}</td>
                <td className="px-3 py-2 num text-right">{gbp(p.bookCost)}</td>
                <td className="px-3 py-2 text-right">
                  <input type="number" value={prices[p.ticker] ?? ""} placeholder="—"
                    onChange={(e) => setPrices((pr) => ({ ...pr, [p.ticker]: e.target.value === "" ? undefined : +e.target.value }))}
                    className="input num w-24 text-right py-1" />
                </td>
                <td className="px-3 py-2 num text-right">{p.priced ? gbp(p.marketValue) : "—"}</td>
                <td className={"px-3 py-2 num text-right font-medium " + (!p.priced ? "text-[var(--muted)]" : p.unrealised >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{p.priced ? gbp(p.unrealised) : "—"}</td>
                <td className={"px-3 py-2 num text-right " + (!p.priced || p.unrealisedPct == null ? "text-[var(--muted)]" : p.unrealisedPct >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{p.priced && p.unrealisedPct != null ? `${p.unrealisedPct >= 0 ? "+" : ""}${num(p.unrealisedPct * 100)}%` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* income strip */}
      {income.total.total > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Stat label="Income (all wrappers)" value={gbp(income.total.total)} sub="dividends + interest + ERI, gross" />
          <Stat label="of which dividends" value={gbp(income.total.dividends)} />
          <Stat label="of which interest" value={gbp(income.total.interest)} />
          <Stat label="Taxable (GIA only)" value={gbp(income.total.taxableTotal)} sub="what the Income tab computes tax on" />
        </div>
      )}

      <p className="text-xs text-[var(--muted)] leading-relaxed">
        This view rolls up every wrapper; a price entered here is the same price the GIA-only Holdings tab uses (prices are per ticker, GBP). Cash balances are per wrapper, entered manually, and count toward total wealth. Tax stays gated where it belongs: only GIA holdings feed the CGT and Income tabs, and CGT-exempt instruments are flagged. Same ticker in two wrappers = two independent Section 104 pools, as HMRC requires only for the unsheltered one — sheltered pools reuse the same engine purely for book-cost consistency.
      </p>
    </div>
  );
}

export default WealthTab;
