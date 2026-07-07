import React, { useState, useMemo, useCallback, useRef, lazy, Suspense } from "react";
import {
  Download, Upload, Moon, Sun, TableProperties, Receipt, FileUp, AlertTriangle,
  Wallet, PoundSterling, PieChart, Percent, Landmark, PiggyBank, TrendingUp, Gauge,
} from "lucide-react";
import { matchPortfolio, ukTaxYear } from "./core/cgt-engine.mjs";
import { buildWealthModel, classifyInstrument, normWrapper } from "./core/portfolio.mjs";
import { computeReturns } from "./core/returns.mjs";
import { giltAnalytics } from "./core/gilts.mjs";
import { allocateCostByValueWeight } from "./core/pension-import.mjs";
import { liabilityForYear, liabilityAllYears } from "./core/uk-tax.mjs";
import { unitsHeldAt, uid, todayISO, IconBtn } from "./ui/shared.jsx";
import useAppStore from "./state/appStore.js";

// Feature sections are lazy-loaded so the initial bundle carries only the
// shell + shared primitives; each tab loads on first visit.
const HomeTab = lazy(() => import("./features/HomeTab.jsx"));
const PlanTab = lazy(() => import("./features/PlanTab.jsx"));
const WealthTab = lazy(() => import("./features/WealthTab.jsx"));
const ReturnsTab = lazy(() => import("./features/ReturnsTab.jsx"));
const GiltsTab = lazy(() => import("./features/GiltsTab.jsx"));
const PensionTab = lazy(() => import("./features/PensionTab.jsx"));
const CgtSection = lazy(() => import("./features/CgtSection.jsx"));
const IncomeTab = lazy(() => import("./features/IncomeTab.jsx"));
const HoldingsTab = lazy(() => import("./features/HoldingsTab.jsx"));
const LedgerTab = lazy(() => import("./features/LedgerTab.jsx"));
const ImportTab = lazy(() => import("./features/ImportTab.jsx"));

/* ============================== app =================================== */
export default function App() {
  // Persisted app state lives in the Zustand store (src/state/appStore.js) —
  // same localStorage keys as before, setters are setState-compatible.
  const {
    dark, setDark, txns, setTxns, tab, setTab, income, setIncome,
    carried, setCarried, cash, setCash, pensionCashflows, setPensionCashflows,
    dmoReportDate, setDmoReportDate, valuations, setValuations,
    incomeEntries, setIncomeEntries, eriEntries, setEriEntries,
    prices, setPrices, avKey, setAvKey, avMeta, setAvMeta,
    priceMeta, setPriceMeta, secMeta, setSecMeta,
  } = useAppStore();
  // Shared by the Pension tab (one-off add) and the Import tab (bulk CSV) —
  // one allocation function, not two copies that could drift. Accepts an
  // optional cashflow list override so a caller can pass "current + about to
  // be added" directly, rather than racing a setState that hasn't landed yet.
  const recomputeProviderCost = useCallback((provider, cashflowsOverride) => {
    const cfs = (cashflowsOverride || pensionCashflows).filter((c) => c.provider === provider && c.gbpAmount != null);
    const totalContributed = cfs.reduce((s, c) => s + c.gbpAmount, 0);
    if (totalContributed <= 0) return;
    const providerTickers = Object.entries(secMeta).filter(([, m]) => m.provider === provider).map(([tk]) => tk);
    const byTicker = {};
    for (const t of txns) {
      if (!providerTickers.includes(t.ticker)) continue;
      const w = normWrapper(t.wrapper);
      if (w !== "SIPP" && w !== "LISA") continue;
      const sign = t.side === "SELL" ? -1 : 1;
      (byTicker[t.ticker] ||= { qty: 0, cost: 0 });
      byTicker[t.ticker].qty += sign * t.quantity;
      byTicker[t.ticker].cost += sign * t.gbpAmount;
    }
    const funds = Object.entries(byTicker).filter(([, v]) => v.qty > 1e-9)
      .map(([tk, v]) => ({ ticker: tk, value: (prices[tk] ?? (v.qty ? v.cost / v.qty : 0)) * v.qty }));
    if (!funds.length) return;
    const allocated = allocateCostByValueWeight(totalContributed, funds);
    setTxns((all) => all.map((t) => {
      const hit = allocated.find((a) => a.ticker === t.ticker);
      if (!hit || !providerTickers.includes(t.ticker)) return t;
      return { ...t, gbpAmount: hit.cost, nativeAmount: hit.cost, note: `Cost basis allocated from ${provider}'s total contributions (£${totalContributed.toFixed(2)}) by current-value weight — recomputed ${todayISO()}.` };
    }));
  }, [pensionCashflows, secMeta, txns, prices]);
  const [error, setError] = useState(null);
  // (persistence moved into the store — one subscription, only changed keys)

  // Only unsheltered (GIA) holdings are within scope for CGT and income tax;
  // ISA / SIPP / LISA are tax-free and excluded from every tax computation.
  const isGIA = (w) => (w || "GIA") === "GIA";
  const giaTxns = useMemo(() => txns.filter((t) => isGIA(t.wrapper)), [txns]);

  // Excess reportable income -> synthetic ERI txns (pool cost uplift) + income.
  const eriTxns = useMemo(() => eriEntries.map((e) => {
    const units = unitsHeldAt(giaTxns, e.periodEnd || "9999-12-31", e.ticker);
    const native = units * (+e.perShare || 0);
    const g = e.currency === "GBp" ? native / 100 : e.currency === "GBP" ? native : native * (+e.fxRate || 0);
    return { id: "eri-" + e.id, ticker: e.ticker, side: "ERI", date: e.distributionDate, quantity: 0, gbpAmount: Math.round((g || 0) * 100) / 100, _eri: e, _units: units, _gbp: g || 0 };
  }).filter((t) => t.ticker && t.date), [eriEntries, giaTxns]);

  const matched = useMemo(() => {
    try { setError(null); return matchPortfolio([...giaTxns, ...eriTxns]); }
    catch (e) { setError(e.message); return { disposals: [], pools: {} }; }
  }, [giaTxns, eriTxns]);

  // The wealth model reads ALL wrappers — the whole point of the wealth core.
  // (eriTxns stay GIA-scoped: ERI only arises on unsheltered holdings.)
  const wealthModel = useMemo(() => {
    try { return buildWealthModel({ txns, eriTxns, incomeEntries, secMeta, prices, cash }); }
    catch { return null; } // a malformed ledger shows its error via `matched` above
  }, [txns, eriTxns, incomeEntries, secMeta, prices, cash]);

  // Record a securities-only valuation snapshot (one per day, last write wins)
  // whenever every open position is priced. This series is what makes an
  // EXACT portfolio-level TWR possible over time — no snapshots, no TWR,
  // rather than a stale-price approximation.
  React.useEffect(() => {
    if (!wealthModel || !wealthModel.positions.length || wealthModel.total.unpriced > 0) return;
    const value = +wealthModel.total.marketValue.toFixed(2);
    const date = todayISO();
    setValuations((v) => {
      const last = v.length && v[v.length - 1].date === date ? v[v.length - 1] : null;
      if (last && last.value === value) return v; // no change — bail to avoid re-render churn
      const rest = v.filter((s) => s.date !== date);
      const byWrapper = Object.fromEntries(Object.entries(wealthModel.byWrapper).map(([w, a]) => [w, +a.marketValue.toFixed(2)]));
      return [...rest, { date, value, byWrapper }].sort((a, b) => (a.date < b.date ? -1 : 1));
    });
  }, [wealthModel]);

  // Returns & income analytics (build step 3) — all wrappers, pre-tax.
  const returns = useMemo(() => {
    try { return computeReturns({ txns, incomeEntries, eriTxns, prices, valuations }); }
    catch { return null; }
  }, [txns, incomeEntries, eriTxns, prices, valuations]);

  // Gilt ladder analytics (build step 4) — driven by secMeta kind: "gilt".
  const giltData = useMemo(() => {
    try { return giltAnalytics({ txns, secMeta, prices }); }
    catch { return null; }
  }, [txns, secMeta, prices]);

  // Individual gilts are CGT-exempt (TCGA 1992 s115), but `matched` (the raw
  // matching engine output) doesn't know about instrument type — it'll happily
  // compute a "gain" on a gilt disposal exactly like any equity. Every view
  // that computes or reports CGT LIABILITY must exclude exempt instruments;
  // views that just show GIA holdings (the legacy Holdings tab) are unaffected
  // and keep showing gilts, since that's a holdings list, not a tax computation.
  const isCgtExempt = useMemo(() => {
    const cache = new Map();
    return (ticker) => {
      if (!cache.has(ticker)) cache.set(ticker, classifyInstrument(ticker, secMeta).cgtExempt);
      return cache.get(ticker);
    };
  }, [secMeta]);
  const taxableDisposals = useMemo(
    () => matched.disposals.filter((d) => !isCgtExempt(d.ticker)),
    [matched, isCgtExempt]
  );
  const taxablePools = useMemo(() => {
    const out = {};
    for (const [tk, p] of Object.entries(matched.pools)) if (!isCgtExempt(tk)) out[tk] = p;
    return out;
  }, [matched, isCgtExempt]);
  const exemptGiltDisposalCount = matched.disposals.length - taxableDisposals.length;

  const taxYears = useMemo(() => {
    const s = new Set(taxableDisposals.map((d) => d.taxYear));
    return [...s].sort().reverse();
  }, [taxableDisposals]);
  const [year, setYear] = useState(null);
  const activeYear = year && taxYears.includes(year) ? year : taxYears[0] || "2025/26";

  // Chain CGT losses across all tracked years (initial b/f losses = `carried`).
  const allYears = useMemo(() => {
    const yrs = [...new Set(taxableDisposals.map((d) => d.taxYear))];
    const inc = Object.fromEntries(yrs.map((y) => [y, income]));
    return liabilityAllYears(taxableDisposals, { incomeByYear: inc, initialCarried: carried });
  }, [taxableDisposals, income, carried]);

  const yearDisposals = taxableDisposals.filter((d) => d.taxYear === activeYear);
  const liab = allYears.results[activeYear] || liabilityForYear(yearDisposals, { income, carriedLosses: carried });

  // Aggregate dividends/interest per tax year (ledger + ERI-derived income).
  const incomeByYear = useMemo(() => {
    const m = {}; const add = (y, kind, amt) => { (m[y] ||= { dividends: 0, interest: 0 }); m[y][kind === "interest" ? "interest" : "dividends"] += amt; };
    for (const e of incomeEntries) if (e.date && e.amount && isGIA(e.wrapper)) add(ukTaxYear(e.date), e.kind, +e.amount);
    for (const t of eriTxns) if (t.date) add(ukTaxYear(t.date), t._eri.treatment, t._gbp);
    return m;
  }, [incomeEntries, eriTxns]);

  // All-wrapper income (taxable AND sheltered), grouped by year then wrapper —
  // so the Income tab can show the full picture, not just the CGT-relevant part.
  const incomeAllWrappers = useMemo(() => {
    const m = {};
    for (const e of incomeEntries) {
      if (!e.date || !e.amount) continue;
      const y = ukTaxYear(e.date), w = normWrapper(e.wrapper);
      (m[y] ||= {});
      (m[y][w] ||= { dividends: 0, interest: 0 });
      m[y][w][e.kind === "interest" ? "interest" : "dividends"] += +e.amount;
    }
    return m;
  }, [incomeEntries]);

  const fileRef = useRef(null);
  const [status, setStatus] = useState("");
  const flash = (msg) => { setStatus(msg); setTimeout(() => setStatus(""), 3500); };

  const exportJSON = async () => {
    const backup = {
      __cgtBackup: true, version: 4, exportedAt: new Date().toISOString(),
      txns, incomeEntries, eriEntries, income, carried, cash, valuations,
      prices, priceMeta, avKey, avMeta, secMeta, pensionCashflows,
    };
    const text = JSON.stringify(backup, null, 2);
    let downloaded = false;
    try {
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `cgt-backup-${todayISO()}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      downloaded = true;
    } catch { /* sandbox may block downloads */ }
    // Clipboard fallback so export never silently fails inside a sandboxed frame.
    try { await navigator.clipboard.writeText(text); flash(downloaded ? "Downloaded — also copied to clipboard." : "Download blocked here; JSON copied to clipboard instead."); }
    catch { flash(downloaded ? "Downloaded." : "Couldn't download or copy in this frame — try the deployed app."); }
  };
  const importJSON = (e) => {
    const f = e.target.files?.[0]; if (!f) { return; }
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (Array.isArray(d)) {
          // Legacy export: a bare transaction array, nothing else.
          setTxns(d.map((x) => ({ ...x, id: x.id || uid() })));
          flash(`Imported ${d.length} transactions (legacy format — no income/ERI data in this file).`);
        } else if (d && d.__cgtBackup) {
          const n = (arr) => Array.isArray(arr) ? arr.length : 0;
          if (Array.isArray(d.txns)) setTxns(d.txns.map((x) => ({ ...x, id: x.id || uid() })));
          if (Array.isArray(d.incomeEntries)) setIncomeEntries(d.incomeEntries.map((x) => ({ ...x, id: x.id || uid() })));
          if (Array.isArray(d.eriEntries)) setEriEntries(d.eriEntries.map((x) => ({ ...x, id: x.id || uid() })));
          if (typeof d.income === "number") setIncome(d.income);
          if (typeof d.carried === "number") setCarried(d.carried);
          if (d.cash && typeof d.cash === "object" && !Array.isArray(d.cash)) setCash(d.cash);
          if (Array.isArray(d.valuations)) setValuations(d.valuations);
          if (d.prices && typeof d.prices === "object") setPrices(d.prices);
          if (d.priceMeta && typeof d.priceMeta === "object") setPriceMeta(d.priceMeta);
          if (typeof d.avKey === "string") setAvKey(d.avKey);
          if (d.avMeta && typeof d.avMeta === "object") setAvMeta(d.avMeta);
          if (d.secMeta && typeof d.secMeta === "object") setSecMeta((m) => ({ ...m, ...d.secMeta }));
          if (Array.isArray(d.pensionCashflows)) setPensionCashflows(d.pensionCashflows.map((x) => ({ ...x, id: x.id || uid() })));
          flash(`Restored: ${n(d.txns)} transactions, ${n(d.incomeEntries)} dividend/interest entries, ${n(d.eriEntries)} ERI entries, ${n(d.pensionCashflows)} pension cashflows, plus prices and settings.`);
        } else {
          setError("That file isn't a recognised backup — expected a transaction array or a full backup file exported from this app.");
        }
      } catch { setError("Couldn't parse that JSON file."); }
    };
    r.readAsText(f);
    e.target.value = ""; // allow re-selecting the same file
  };

  return (
    <div className={dark ? "dark" : ""}>
      <style>{`
        .root{
          --bg:#f6f7f9;--panel:#ffffff;--panel2:#f1f3f6;--fg:#0f1729;--muted:#5b6677;
          --border:#e2e6ec;--accent:#4338ca;--accent-fg:#ffffff;--gain:#047857;--loss:#be123c;
          --m-same:#0369a1;--m-bb:#b45309;--m-pool:#4338ca;--chip:#eef1f6;
        }
        .dark .root{
          --bg:#080b12;--panel:#0f141d;--panel2:#151b26;--fg:#e8edf4;--muted:#8a97a8;
          --border:#222b38;--accent:#6366f1;--accent-fg:#ffffff;--gain:#34d399;--loss:#fb7185;
          --m-same:#38bdf8;--m-bb:#fbbf24;--m-pool:#a5b4fc;--chip:#1a2230;
        }
        .num{font-variant-numeric:tabular-nums;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;}
        @media print {
          body * { visibility: hidden !important; }
          .print-area, .print-area * { visibility: visible !important; }
          .print-area { position: absolute; left: 0; top: 0; width: 100%; padding: 24px;
            --bg:#fff; --panel:#fff; --panel2:#f6f7f9; --fg:#000; --muted:#444; --border:#ccc;
            --gain:#065f46; --loss:#9f1239; --accent:#1e293b; }
          .no-print { display: none !important; }
          table { page-break-inside: auto; } tr { page-break-inside: avoid; }
        }
      `}</style>
      <div className="root min-h-screen bg-[var(--bg)] text-[var(--fg)]" style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" }}>
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6">
          {/* header */}
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div>
              <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                <Receipt size={20} className="text-[var(--accent)]" /> Wealth Dashboard
              </h1>
              <p className="text-sm text-[var(--muted)] mt-0.5">Total wealth across GIA · ISA · SIPP · LISA · VCT, with HMRC-precise CGT (same-day · 30-day · S104). All figures GBP.</p>
            </div>
            <div className="flex items-center gap-2">
              {status && <span className="text-xs text-[var(--muted)] mr-1 max-w-[220px] text-right leading-tight">{status}</span>}
              <IconBtn onClick={exportJSON} title="Full backup: transactions, dividends/interest, ERI, prices and settings (downloads a file; if you've set an Alpha Vantage key it's included in plain text). Also copies to clipboard as a fallback."><Download size={16} /></IconBtn>
              <IconBtn onClick={() => fileRef.current && fileRef.current.click()} title="Restore from a full backup file (or import a legacy transactions-only JSON)"><Upload size={16} /></IconBtn>
              <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={importJSON} />
              <IconBtn onClick={() => setDark((d) => !d)} title="Theme">{dark ? <Sun size={16} /> : <Moon size={16} />}</IconBtn>
            </div>
          </div>

          {/* tabs */}
          <div className="flex flex-wrap gap-1 mt-5 border-b border-[var(--border)]">
            {[["home", "Home", TrendingUp], ["plan", "Plan", Gauge], ["wealth", "Wealth", PieChart], ["returns", "Returns", Percent], ["gilts", "Gilts", Landmark], ["pension", "Pension & LISA", PiggyBank], ["cgt", "CGT", TableProperties], ["holdings", "Holdings", Wallet], ["income", "Income", PoundSterling], ["ledger", "Transactions", Receipt], ["import", "Import CSV", FileUp]].map(([k, label, Icon]) => (
              <button key={k} onClick={() => setTab(k)}
                className={"px-3 py-2 text-sm font-medium flex items-center gap-1.5 border-b-2 -mb-px transition " +
                  (tab === k ? "border-[var(--accent)] text-[var(--fg)]" : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]")}>
                <Icon size={15} /> {label}
              </button>
            ))}
          </div>

          {error && (
            <div className="mt-4 flex items-start gap-2 text-sm rounded-lg px-3 py-2 text-[var(--loss)] border"
              style={{ background: "color-mix(in srgb, var(--loss) 12%, transparent)", borderColor: "color-mix(in srgb, var(--loss) 35%, transparent)" }}>
              <AlertTriangle size={16} className="mt-0.5 shrink-0" /> <span>{error}</span>
            </div>
          )}

          <div className="mt-5">
          <Suspense fallback={<div className="text-sm text-[var(--muted)] py-6">Loading…</div>}>
            {tab === "home" && <HomeTab {...{ model: wealthModel, valuations, returns, priceMeta, setTab }} />}
            {tab === "plan" && <PlanTab {...{
              dark,
              // wrapper totals (holdings + cash) for one-click plan prefill
              livePots: wealthModel ? Object.fromEntries(["SIPP", "ISA", "GIA", "LISA"].map((w) => [w, wealthModel.byWrapper[w]?.total ?? null])) : null,
              liveSalary: income,
            }} />}
            {tab === "wealth" && <WealthTab {...{ model: wealthModel, cash, setCash, prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, setSecMeta, dmoReportDate, setDmoReportDate }} />}
            {tab === "returns" && <ReturnsTab {...{ returns, valuations, pensionCashflows, secMeta, txns }} />}
            {tab === "gilts" && <GiltsTab {...{ data: giltData, secMeta, setSecMeta, prices, setPrices, dmoReportDate, setDmoReportDate }} />}
            {tab === "pension" && <PensionTab {...{ txns, setTxns, cash, setCash, secMeta, setSecMeta, prices, setPrices, pensionCashflows, setPensionCashflows, recomputeProviderCost }} />}
            {tab === "cgt" && <CgtSection {...{
              taxYears, activeYear, setYear, yearDisposals, liab, income, setIncome, carried, setCarried,
              carryForward: allYears.carriedForward, exemptGiltDisposalCount,
              pools: taxablePools, disposals: taxableDisposals, prices, setPrices, txns: giaTxns,
            }} />}
            {tab === "income" && <IncomeTab {...{ incomeEntries, setIncomeEntries, eriEntries, setEriEntries, eriTxns, incomeByYear, incomeAllWrappers, income, setIncome, txns: giaTxns, secMeta, setSecMeta }} />}
            {tab === "holdings" && <HoldingsTab {...{ positions: wealthModel ? wealthModel.positions : [], prices, setPrices, avKey, setAvKey, avMeta, setAvMeta, priceMeta, setPriceMeta, txns, secMeta, setSecMeta, dmoReportDate, setDmoReportDate }} />}
            {tab === "ledger" && <LedgerTab {...{ txns, setTxns }} />}
            {tab === "import" && <ImportTab {...{ setTxns, setTab, setIncomeEntries, setEriEntries, secMeta, setPensionCashflows, pensionCashflows, recomputeProviderCost }} />}
          </Suspense>
          </div>

          <p className="text-xs text-[var(--muted)] mt-8 leading-relaxed">
            Figures are an estimate to support your own filing, not tax advice. Verify before submitting to HMRC.
          </p>
        </div>
      </div>
    </div>
  );
}
