import React, { useState, useMemo, useCallback, useRef } from "react";
import { Percent } from "lucide-react";
import { WRAPPERS, normWrapper } from "../core/portfolio.mjs";
import { xirr } from "../core/returns.mjs";
import { giltAnalytics } from "../core/gilts.mjs";
import { gbp, WrapperChip, num, todayISO, pct, pctPlain, toneOf, SHORT_SPAN, RateCell, rateIsDisplayable, Stat, Empty, useSort, sortRows, SortTh } from "../ui/shared.jsx";


function ReturnsTab({ returns, valuations, pensionCashflows = [], secMeta = {}, txns = [] }) {
  const [selectedWrapper, setSelectedWrapper] = useState(null); // click a per-wrapper row to filter the per-holding table below
  const [sort, toggleSort] = useSort("ticker", "asc");

  // Pension funds (SIPP/LISA) only ever have ONE consolidated transaction
  // (a snapshot, not a purchase history), so the normal txn-based XIRR above
  // just measures the time since that snapshot/last edit — meaningless, and
  // was the actual source of "the pension XIRR looks wrong" here (the
  // Pension tab's own XIRR is correct, since it uses the real contribution
  // dates in pensionCashflows; this tab wasn't using them at all before).
  // Fix: recompute wrapper-level XIRR for SIPP/LISA from real contribution
  // dates when available, and blank the misleading per-fund figure (real
  // per-fund attribution isn't possible — contributions aren't tied to a
  // specific fund in these exports) rather than show a wrong number.
  const byWrapper = returns?.byWrapper;
  const pensionXirrByWrapper = useMemo(() => {
    const out = {};
    if (!byWrapper) return out;
    for (const w of ["SIPP", "LISA"]) {
      const providers = new Set(Object.entries(secMeta).filter(([tk, m]) => m.provider && txns.some((t) => t.ticker === tk && normWrapper(t.wrapper) === w)).map(([, m]) => m.provider));
      if (!providers.size) continue;
      const cfs = pensionCashflows.filter((c) => providers.has(c.provider) && c.gbpAmount != null);
      if (!cfs.length) continue;
      const flows = cfs.map((c) => ({ date: c.date, amount: -Math.abs(c.gbpAmount) }));
      const currentValue = byWrapper[w]?.value ?? 0;
      if (currentValue > 0) flows.push({ date: todayISO(), amount: currentValue });
      out[w] = xirr(flows);
    }
    return out;
  }, [secMeta, txns, pensionCashflows, byWrapper]);

  if (!returns) return <Empty msg="Couldn't compute returns — check the Transactions tab for ledger errors." />;
  const { perHolding, total, portfolioTWR } = returns;
  if (!perHolding.length) return <Empty msg="No transactions yet. Returns appear once you have holdings (any wrapper)." />;

  const wrapperOrder = [...WRAPPERS, ...Object.keys(byWrapper).filter((w) => !WRAPPERS.includes(w))].filter((w) => byWrapper[w]);
  const PERHOLDING_ACCESSORS = {
    ticker: (h) => h.ticker, firstDate: (h) => h.firstDate, moneyIn: (h) => h.moneyIn,
    outIncome: (h) => h.moneyOut + h.incomeReceived, value: (h) => (h.open ? (h.priced ? h.marketValue : null) : 0),
    profit: (h) => h.profit, xirr: (h) => h.xirr?.rate ?? null, twr: (h) => h.twr?.twr ?? null,
    yield12m: (h) => (h.open ? h.income.actualYield : null), yieldFwd: (h) => (h.open ? h.income.forwardYield : null),
  };
  // Open-first grouping is the point (closed positions are shown de-emphasised
  // below), so the chosen sort applies WITHIN each group rather than across
  // both — otherwise sorting by, say, value would interleave closed
  // positions (always £0) into the middle of the open list.
  const openH = sortRows(perHolding.filter((h) => h.open && (!selectedWrapper || h.wrapper === selectedWrapper)).sort((a, b) => a.ticker.localeCompare(b.ticker)), sort, PERHOLDING_ACCESSORS);
  const closedH = sortRows(perHolding.filter((h) => !h.open && (!selectedWrapper || h.wrapper === selectedWrapper)).sort((a, b) => a.ticker.localeCompare(b.ticker)), sort, PERHOLDING_ACCESSORS);
  const pensionTickers = new Set(Object.entries(secMeta).filter(([, m]) => m.provider).map(([tk]) => tk));

  return (
    <div className="space-y-4">
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Money-weighted return (XIRR)"
          value={rateIsDisplayable(total.xirr) ? pct(total.xirr.rate) : "n/a"}
          sub={rateIsDisplayable(total.xirr) ? "annualised, since first transaction"
            : total.xirr.rate == null ? total.xirr.reason
            : `only ${total.xirr.spanDays} days of history — annualised figures this young are noise (shows from ${SHORT_SPAN} days)`}
          tone={rateIsDisplayable(total.xirr) ? toneOf(total.xirr.rate) : undefined} big />
        <Stat label="Total profit" value={total.profit != null ? gbp(total.profit) : "—"} sub={total.profit != null && total.moneyIn > 0 ? `${pct(total.simpleReturn)} simple, on ${gbp(total.moneyIn)} in` : undefined} tone={toneOf(total.profit)} />
        <Stat label="Income yield (trailing 12m)" value={pctPlain(total.actualYield)} sub={total.trailing12m ? `${gbp(total.trailing12m)} received incl. ERI` : "no income in the last year"} />
        <Stat label="Income yield (forward)" value={pctPlain(total.forwardYield)} sub={total.forwardIncome ? `${gbp(total.forwardIncome)} est. on current units` : undefined} />
      </div>

      {/* portfolio TWR from snapshots */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="text-sm font-medium flex items-center gap-2"><Percent size={15} className="text-[var(--accent)]" /> Portfolio time-weighted return
          <span className="text-xs font-normal text-[var(--muted)]">— exact, from valuation snapshots</span>
        </div>
        {portfolioTWR.twr != null ? (
          <div className="mt-2 flex items-baseline gap-4 flex-wrap">
            <span className={"text-lg font-semibold num " + (portfolioTWR.twr >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{pct(portfolioTWR.twr)}</span>
            <span className="text-xs text-[var(--muted)] num">{portfolioTWR.from} → {portfolioTWR.to} ({portfolioTWR.spanDays}d, {portfolioTWR.periods.length} period{portfolioTWR.periods.length === 1 ? "" : "s"})
              {portfolioTWR.annualised != null && portfolioTWR.spanDays >= SHORT_SPAN && <> · {pct(portfolioTWR.annualised)} annualised</>}
            </span>
          </div>
        ) : (
          <p className="text-xs text-[var(--muted)] mt-2 leading-relaxed">
            Not available yet — {portfolioTWR.reason}. The app records a snapshot of total market value each day all your holdings are priced (currently {valuations.length} snapshot{valuations.length === 1 ? "" : "s"}); portfolio TWR appears once two or more exist and is exact between them, rather than approximated from stale prices. Per-holding TWR below doesn't need this — it's exact from your trade prices.
          </p>
        )}
      </div>

      {/* per-wrapper — click a row to filter the per-holding table below */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>{["Wrapper", "Money in", "Money out + income", "Value now", "Profit", "Simple", "XIRR", "Yield 12m", "Yield fwd"].map((h, i) => (
              <th key={i} className={"px-3 py-2 font-medium " + (i === 0 ? "text-left" : "text-right")}>{h}</th>
            ))}</tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {wrapperOrder.map((w) => {
              const a = byWrapper[w];
              const selected = selectedWrapper === w;
              return (
                <tr key={w} onClick={() => setSelectedWrapper(selected ? null : w)}
                  className={"cursor-pointer " + (selected ? "bg-[color:color-mix(in_srgb,var(--accent)_10%,transparent)]" : "hover:bg-[var(--panel2)]")}
                  title="Click to filter the holdings table below to this wrapper">
                  <td className="px-3 py-2 font-medium">{w}{a.unpricedOpen > 0 && <span className="text-[var(--m-bb)]" title={`${a.unpricedOpen} open holding(s) unpriced — profit/XIRR unavailable`}> *</span>}</td>
                  <td className="px-3 py-2 num text-right">{gbp(a.moneyIn)}</td>
                  <td className="px-3 py-2 num text-right">{gbp(a.moneyOut + a.income)}</td>
                  <td className="px-3 py-2 num text-right">{a.unpricedOpen ? "—" : gbp(a.value)}</td>
                  <td className={"px-3 py-2 num text-right font-medium " + (a.profit == null ? "text-[var(--muted)]" : a.profit >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{a.profit != null ? gbp(a.profit) : "—"}</td>
                  <td className="px-3 py-2 num text-right">{pct(a.simpleReturn)}</td>
                  <td className="px-3 py-2 text-right">
                    <RateCell r={pensionXirrByWrapper[w] || a.xirr} />
                    {pensionXirrByWrapper[w] && <span className="ml-1 text-[10px] text-[var(--muted)]" title="From real contribution dates (Pension & LISA tab), not the transaction ledger — the ledger only holds one snapshot per fund, not a purchase history">◆</span>}
                  </td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{pctPlain(a.actualYield)}</td>
                  <td className="px-3 py-2 num text-right text-[var(--muted)]">{pctPlain(a.forwardYield)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* per-holding */}
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
        <div className="flex items-center justify-between px-3 pt-2">
          <span className="text-xs text-[var(--muted)]">{selectedWrapper ? `Filtered to ${selectedWrapper}` : "All wrappers"}</span>
          {selectedWrapper && <button onClick={() => setSelectedWrapper(null)} className="text-xs text-[var(--accent)] hover:underline">Clear filter</button>}
        </div>
        <table className="w-full text-sm">
          <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 font-medium text-left"></th>
              <SortTh id="ticker" label="Ticker" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
              <SortTh id="firstDate" label="Since" sort={sort} onSort={toggleSort} className="px-3 py-2 font-medium" />
              <SortTh id="moneyIn" label="Money in" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="outIncome" label="Out + income" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="value" label="Value" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="profit" label="Profit" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="xirr" label="XIRR" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="twr" label="TWR (episode)" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="yield12m" label="Yield 12m" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
              <SortTh id="yieldFwd" label="Yield fwd" sort={sort} onSort={toggleSort} align="right" className="px-3 py-2 font-medium" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)] bg-[var(--panel)]">
            {[...openH, ...closedH].map((h) => (
              <tr key={h.wrapper + h.ticker} className={"hover:bg-[var(--panel2)]" + (h.open ? "" : " opacity-60")}>
                <td className="px-3 py-2"><WrapperChip wrapper={h.wrapper} /></td>
                <td className="px-3 py-2 font-medium">{h.ticker}{!h.open && <span className="ml-1.5 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-[var(--chip)] text-[var(--muted)] align-middle">closed</span>}</td>
                <td className="px-3 py-2 num text-[var(--muted)] whitespace-nowrap text-xs">{h.firstDate || "—"}</td>
                <td className="px-3 py-2 num text-right">{gbp(h.moneyIn)}</td>
                <td className="px-3 py-2 num text-right">{gbp(h.moneyOut + h.incomeReceived)}</td>
                <td className="px-3 py-2 num text-right">{h.open ? (h.priced ? gbp(h.marketValue) : "—") : gbp(0)}</td>
                <td className={"px-3 py-2 num text-right font-medium " + (h.profit == null ? "text-[var(--muted)]" : h.profit >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")}>{h.profit != null ? gbp(h.profit) : "—"}</td>
                <td className="px-3 py-2 text-right">
                  {pensionTickers.has(h.ticker)
                    ? <span className="text-[var(--muted)]" title={`Not shown per-fund — contributions aren't tied to a specific fund in this provider's export. See the ${h.wrapper} row above for a real, contribution-dated XIRR.`}>see {h.wrapper}</span>
                    : <RateCell r={h.xirr} />}
                </td>
                <td className="px-3 py-2 text-right">
                  {pensionTickers.has(h.ticker)
                    ? <span className="text-[var(--muted)]" title="Not meaningful for a snapshot-only holding (no real trade-price history)">—</span>
                    : (h.twr.twr == null ? <span className="text-[var(--muted)]" title={h.twr.reason || ""}>—</span> : <span className={"num " + (h.twr.twr >= 0 ? "text-[var(--gain)]" : "text-[var(--loss)]")} title={`Since ${h.twr.episodeStart} (${h.twr.spanDays}d)${h.twr.annualised != null && h.twr.spanDays >= SHORT_SPAN ? ` · ${pct(h.twr.annualised)} annualised` : ""}`}>{pct(h.twr.twr)}</span>)}
                </td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{h.open ? pctPlain(h.income.actualYield) : "—"}</td>
                <td className="px-3 py-2 num text-right text-[var(--muted)]">{h.open ? pctPlain(h.income.forwardYield) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[var(--muted)] leading-relaxed">
        Everything here is pre-tax and in GBP. <span className="font-medium">XIRR</span> is your money-weighted annual return — cashflow-timing included — computed from every trade, cash distribution, and the current value (365-day count; † marks histories under {SHORT_SPAN} days, where annualised rates are noise). A <span className="text-[var(--muted)]">◆</span> marks a wrapper's XIRR as computed from real pension contribution dates (Pension &amp; LISA tab) rather than the transaction ledger, which only holds one snapshot per fund — individual pension fund rows show "see {"{wrapper}"}" instead of their own XIRR/TWR for the same reason. <span className="font-medium">TWR (episode)</span> is the cumulative time-weighted return on the current holding episode, exact from your own trade prices, with distributions treated as reinvested — compare it to a benchmark; compare XIRR to your own expectations. ERI counts toward income yields (it's real accumulation) but is never an XIRR cashflow (no cash moves). Cash balances sit outside all return figures. Forward yield applies the last 12 months' per-unit distributions to your current unit count — an estimate, not a promise.
      </p>
    </div>
  );
}

/* ---------------------------- Gilts tab ----------------------------- */
// Gilt ladder view (build step 4). Pure view over giltAnalytics()
// (core/gilts.mjs, DMO/HMRC-verified conventions).
/* --------------------------- Pension & LISA tab --------------------------- */
// Pension and LISA holdings are insurer/administrator-priced fund units, not
// exchange-traded — no live price feed exists for them (unlike everything
// else in the app), and they don't trade via buy/sell the way a normal
// ledger transaction does. This is a snapshot editor: each row is a current
// fund holding (units × price), not a transaction history. Editing a row
// replaces its underlying "opening balance" transaction(s) in one go, and
// LISA can either be itemised the same way or left as a single cash figure.

export default ReturnsTab;
