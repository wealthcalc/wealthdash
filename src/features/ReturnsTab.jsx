import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Percent, LineChart } from "lucide-react";
import { WRAPPERS } from "../core/portfolio.mjs";
import { pensionXirrByWrapper } from "../core/returns.mjs";
import { giltAnalytics } from "../core/gilts.mjs";
import { growthIndex, maxDrawdown, volatility, benchmarkCumulativeReturn, feeDrag } from "../core/benchmark.mjs";
import { gbp, WrapperChip, num, todayISO, pct, pctPlain, toneOf, SHORT_SPAN, RateCell, rateIsDisplayable, Stat, Empty, useSort, sortRows, SortTh, store, SubTabs, Field } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

const BENCHMARK_SUGGESTIONS = [
  ["VWRL.L", "Vanguard FTSE All-World UCITS ETF"],
  ["VUKE.L", "Vanguard FTSE 100 UCITS ETF"],
  ["SWDA.L", "iShares Core MSCI World UCITS ETF"],
  ["VUSA.L", "Vanguard S&P 500 UCITS ETF"],
  ["^FTAS", "FTSE All-Share index"],
];

// Phase 2.8 de-drilling: raw state from the store; `returns` (derived)
// stays a prop from the shell.
function ReturnsTab({ returns }) {
  const valuations = useAppStore((s) => s.valuations);
  const pensionCashflows = useAppStore((s) => s.pensionCashflows);
  const secMeta = useAppStore((s) => s.secMeta), setSecMeta = useAppStore((s) => s.setSecMeta);
  const txns = useAppStore((s) => s.txns);
  const [sub, setSub] = useState(() => store.get("cgt.returnssubtab", "performance"));
  useEffect(() => store.set("cgt.returnssubtab", sub), [sub]);
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
  // Extracted to core/returns.mjs (tested) so Home's wrapper strip shows
  // the same combined pension XIRR — one implementation, two surfaces.
  const pensionXirr = useMemo(() => {
    if (!byWrapper) return {};
    return pensionXirrByWrapper({
      txns, secMeta, pensionCashflows,
      valueByWrapper: { SIPP: byWrapper.SIPP?.value ?? 0, LISA: byWrapper.LISA?.value ?? 0 },
      today: todayISO(),
    });
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
      <SubTabs tabs={[["performance", "Performance"], ["benchmark", "Benchmark & risk"]]} active={sub} onChange={setSub} />

      {sub === "performance" && (
      <>
      {/* headline */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Stat label="Money-weighted return (XIRR)"
          value={rateIsDisplayable(total.xirr) ? pct(total.xirr.rate) : "n/a"}
          sub={rateIsDisplayable(total.xirr) ? `annualised, since first transaction${total.xirr.xirrScope?.snapshotOnlyExcluded ? ` — ${total.xirr.xirrScope.snapshotOnlyExcluded} snapshot-dated pension fund(s) excluded (their real XIRR is the ◆ per-wrapper figure)` : ""}`
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
      <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
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
                    <RateCell r={pensionXirr[w] || a.xirr} />
                    {pensionXirr[w] && <span className="ml-1 text-[11px] text-[var(--muted)]" title="From real contribution dates (Pension & LISA tab), not the transaction ledger — the ledger only holds one snapshot per fund, not a purchase history">◆</span>}
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
                <td className="px-3 py-2 font-medium">{h.ticker}{!h.open && <span className="ml-1.5 text-[11px] font-semibold px-1.5 py-0.5 rounded bg-[var(--chip)] text-[var(--muted)] align-middle">closed</span>}</td>
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
      </>
      )}

      {sub === "benchmark" && (
        <BenchmarkRiskView portfolioTWR={portfolioTWR} perHolding={perHolding} secMeta={secMeta} setSecMeta={setSecMeta} />
      )}
    </div>
  );
}

/* ------------------------- Benchmark & risk view ------------------------- */
// Phase 2, step 5: benchmark comparison, volatility/drawdown, fee drag — all
// built on core/benchmark.mjs (see that file's header for the modelling
// choices, esp. why growth index/volatility/drawdown use TWR PERIOD FACTORS
// rather than raw valuation snapshots).
function BenchmarkRiskView({ portfolioTWR, perHolding, secMeta, setSecMeta }) {
  const [symbol, setSymbol] = useState(() => store.get("cgt.benchmark.symbol", "VWRL.L"));
  useEffect(() => store.set("cgt.benchmark.symbol", symbol), [symbol]);
  const [benchmarkData, setBenchmarkData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  // Accepts an explicit symbol override so a suggestion button can set the
  // symbol and fetch in the same click, without waiting on a state update /
  // relying on a stale closure of `symbol`.
  const fetchBenchmark = async (sym) => {
    const s = (sym ?? symbol).trim();
    if (!s || !portfolioTWR?.from) return;
    setSymbol(s);
    setBusy(true); setErr(""); setBenchmarkData(null);
    try {
      const r = await fetch(`/api/benchmark?symbol=${encodeURIComponent(s)}&from=${encodeURIComponent(portfolioTWR.from)}&to=${encodeURIComponent(portfolioTWR.to)}`);
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setBenchmarkData(body);
    } catch (e) { setErr(e.message || "Fetch failed"); }
    setBusy(false);
  };

  const growthIdx = useMemo(
    () => (portfolioTWR?.twr != null ? growthIndex(portfolioTWR.periods, portfolioTWR.from) : []),
    [portfolioTWR]
  );
  const dd = useMemo(() => maxDrawdown(growthIdx), [growthIdx]);
  const vol = useMemo(() => (portfolioTWR?.twr != null ? volatility(portfolioTWR.periods) : { annualisedVol: null }), [portfolioTWR]);
  const benchCmp = useMemo(
    () => (benchmarkData && portfolioTWR?.from ? benchmarkCumulativeReturn(benchmarkData.prices, portfolioTWR.from, portfolioTWR.to) : null),
    [benchmarkData, portfolioTWR]
  );

  const ocfByTicker = useMemo(() => {
    const m = {};
    for (const [tk, meta] of Object.entries(secMeta)) if (Number.isFinite(+meta?.ocf)) m[tk] = +meta.ocf;
    return m;
  }, [secMeta]);
  const fees = useMemo(() => feeDrag({ holdings: perHolding, ocfByTicker }), [perHolding, ocfByTicker]);
  const setOcf = (ticker, v) => setSecMeta((m) => ({ ...m, [ticker]: { ...m[ticker], ocf: v === "" ? undefined : +v } }));

  return (
    <div className="space-y-5">
      {/* volatility & drawdown */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
        <div className="text-sm font-medium flex items-center gap-2"><LineChart size={15} className="text-[var(--accent)]" /> Volatility &amp; drawdown
          <span className="text-xs font-normal text-[var(--muted)]">— from valuation-snapshot periods, cashflows netted out</span>
        </div>
        {portfolioTWR?.twr == null ? (
          <p className="text-xs text-[var(--muted)]">Needs portfolio TWR first (see the Performance tab — requires &gt;= 2 valuation snapshots).</p>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label="Annualised volatility" value={vol.annualisedVol != null ? pct(vol.annualisedVol) : "n/a"}
              sub={vol.annualisedVol != null ? `${vol.sampleSize} periods, ~${Math.round(vol.periodsPerYear)}/yr` : vol.reason} />
            <Stat label="Max drawdown" value={dd.maxDrawdown != null ? pct(dd.maxDrawdown) : "n/a"}
              sub={dd.maxDrawdown != null ? `${dd.peakDate} → ${dd.troughDate}${dd.recovered ? ` · recovered ${dd.recoveryDate}` : " · not yet recovered"}` : dd.reason}
              tone={dd.maxDrawdown != null ? (dd.maxDrawdown < 0 ? "loss" : undefined) : undefined} />
            <Stat label="Cumulative TWR" value={pct(portfolioTWR.twr)} sub={`${portfolioTWR.from} → ${portfolioTWR.to}`} tone={toneOf(portfolioTWR.twr)} />
          </div>
        )}
      </div>

      {/* benchmark comparison */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
        <div className="text-sm font-medium">Benchmark comparison</div>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-1.5">
            {BENCHMARK_SUGGESTIONS.map(([s, n]) => (
              <button key={s} type="button" onClick={() => fetchBenchmark(s)} disabled={busy || !portfolioTWR?.from}
                title={n}
                className={"text-xs px-2.5 py-1 rounded-full border transition-colors disabled:opacity-50 disabled:cursor-not-allowed "
                  + (symbol === s && benchmarkData?.symbol === s
                    ? "border-[var(--accent)] bg-[color:color-mix(in_srgb,var(--accent)_14%,transparent)] text-[var(--accent)] font-medium"
                    : "border-[var(--border)] bg-[var(--panel2)] hover:bg-[var(--chip)] text-[var(--fg)]")}>
                {s} <span className="text-[var(--muted)]">— {n}</span>
              </button>
            ))}
          </div>
          <div className="flex items-end gap-2 flex-wrap">
            <Field label="Or type your own (Yahoo symbol)">
              <input value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} className="input w-40" placeholder="e.g. ^GSPC" />
            </Field>
            <button onClick={() => fetchBenchmark()} disabled={busy || !portfolioTWR?.from || !symbol.trim()} className="btn-accent">{busy ? "Fetching…" : "Fetch"}</button>
            {!portfolioTWR?.from && <span className="text-xs text-[var(--muted)]">Needs portfolio TWR (&gt;= 2 valuation snapshots) to know the comparison window.</span>}
          </div>
        </div>
        {err && <p className="text-xs text-[var(--loss)]">{err}</p>}
        {benchmarkData && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Stat label={`Portfolio TWR`} value={portfolioTWR.twr != null ? pct(portfolioTWR.twr) : "n/a"} sub={`${portfolioTWR.from} → ${portfolioTWR.to}`} tone={toneOf(portfolioTWR.twr)} />
            <Stat label={`${benchmarkData.symbol} buy-and-hold`} value={benchCmp?.cumulativeReturn != null ? pct(benchCmp.cumulativeReturn) : "n/a"}
              sub={benchCmp?.cumulativeReturn != null ? `${benchCmp.fromDate} → ${benchCmp.toDate}` : benchCmp?.reason}
              tone={benchCmp?.cumulativeReturn != null ? toneOf(benchCmp.cumulativeReturn) : undefined} />
            <Stat label="Difference" value={(portfolioTWR.twr != null && benchCmp?.cumulativeReturn != null) ? pct(portfolioTWR.twr - benchCmp.cumulativeReturn) : "n/a"}
              sub="portfolio minus benchmark, same window" tone={(portfolioTWR.twr != null && benchCmp?.cumulativeReturn != null) ? toneOf(portfolioTWR.twr - benchCmp.cumulativeReturn) : undefined} />
          </div>
        )}
        <p className="text-xs text-[var(--muted)] leading-relaxed">
          This is a buy-and-hold comparison over your portfolio's own measurement window (the span your valuation snapshots cover), not a risk-adjusted alpha — it answers "how did a simple tracker do over the same period I actually held my portfolio," not "how much of my return came from skill vs. the market."
        </p>
      </div>

      {/* fee drag */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 space-y-3">
        <div className="text-sm font-medium">Fee drag <span className="font-normal text-xs text-[var(--muted)]">— ongoing charges figure (OCF), entered per holding</span></div>
        {!perHolding.some((h) => h.open) ? (
          <Empty msg="No open holdings to show fees for." />
        ) : (
          <>
            <div className="rounded-xl border border-[var(--border)] overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-[var(--panel2)] text-[var(--muted)] text-xs uppercase tracking-wide">
                  <tr>{["Ticker", "Wrapper", "Value", "OCF %/yr", "Annual cost"].map((h, i) => (
                    <th key={i} className={"px-3 py-2 font-medium " + (i === 0 || i === 1 ? "text-left" : "text-right")}>{h}</th>
                  ))}</tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {fees.rows.sort((a, b) => b.marketValue - a.marketValue).map((r) => (
                    <tr key={r.wrapper + r.ticker}>
                      <td className="px-3 py-2 font-medium">{r.ticker}</td>
                      <td className="px-3 py-2"><WrapperChip wrapper={r.wrapper} /></td>
                      <td className="px-3 py-2 num text-right">{gbp(r.marketValue)}</td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" step="0.01" min="0" value={r.ocf ?? ""} onChange={(e) => setOcf(r.ticker, e.target.value)}
                          className="input num w-20 text-right" placeholder="—" />
                      </td>
                      <td className="px-3 py-2 num text-right">{r.annualCost != null ? gbp(r.annualCost) : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              <Stat label="Asset-weighted OCF" value={fees.weightedOcf != null ? `${fees.weightedOcf.toFixed(2)}%` : "n/a"} sub={fees.unknownValue > 0 ? `${gbp(fees.unknownValue)} in holdings with no OCF entered` : "all open holdings have an OCF"} />
              <Stat label="Total annual cost" value={fees.totalAnnualCost != null ? gbp(fees.totalAnnualCost) : "n/a"} sub="at current values, before any further growth/contributions" tone={fees.totalAnnualCost != null ? "loss" : undefined} />
            </div>
            <p className="text-xs text-[var(--muted)]">OCF isn't available from a free, verified live source the way prices/FX/gilts/HPI are (issuer KIIDs/factsheets are the real source) — enter each fund's ongoing charge figure by hand. This shows today's actual cost given today's holdings and values; the Plan tab's "Platform + fund fees" is a separate, forward-looking single-rate assumption for the retirement projection, not reconciled with this per-holding figure.</p>
          </>
        )}
      </div>
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
