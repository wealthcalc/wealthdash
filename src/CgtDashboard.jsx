import React, { useState, useMemo, useCallback, useRef, lazy, Suspense } from "react";
import { Download, Upload, Moon, Sun, Receipt, AlertTriangle, Menu, ArrowLeft, LayoutGrid } from "lucide-react";
import { matchPortfolio, ukTaxYear } from "./core/cgt-engine.mjs";
import { buildWealthModel, classifyInstrument, normWrapper } from "./core/portfolio.mjs";
import { computeReturns } from "./core/returns.mjs";
import { giltAnalytics } from "./core/gilts.mjs";
import { allocateCostByValueWeight } from "./core/pension-import.mjs";
import { liabilityForYear, liabilityAllYears } from "./core/uk-tax.mjs";
import { householdNetWorth } from "./core/property.mjs";
import { totalCreditCardDebt } from "./core/credit-cards.mjs";
import { privateTotals } from "./core/private-investments.mjs";
import { rsuTotals, vestingSchedule } from "./core/rsu.mjs";
import { deferredCashTotals, deferredCashCalendar } from "./core/deferred-cash.mjs";
import { effectiveCashByWrapper } from "./core/cash.mjs";
import { buildIncomeCalendar } from "./core/income-calendar.mjs";
import { buildNetWorthSnapshot, upsertDailySnapshot } from "./core/net-worth-series.mjs";
import { buildBackup, restorePlan } from "./core/backup.mjs";
import { taxYearEndChecklist } from "./core/tax-year-end.mjs";
import { isaSubscriptionsByYear, realisedForYear } from "./core/allowances.mjs";
import { aeaForYear } from "./core/uk-tax.mjs";
import { concentration } from "./core/exposure.mjs";
import { portfolioExposure } from "./core/lookthrough.mjs";
import { pensionXirrByWrapper } from "./core/returns.mjs";
import { renderAiSnapshot } from "./core/ai-snapshot.mjs";
import { unitsHeldAt, uid, todayISO, IconBtn, store as lsStore } from "./ui/shared.jsx";
import { DesktopSidebar, MobileDrawer, SubTabBar, SCREENS } from "./ui/Sidebar.jsx";
import CommandPalette from "./ui/CommandPalette.jsx";
import { useIsMobile } from "./ui/useIsMobile.js";
import useAppStore from "./state/appStore.js";

// Feature sections are lazy-loaded so the initial bundle carries only the
// shell + shared primitives; each tab loads on first visit.
const HomeTab = lazy(() => import("./features/HomeTab.jsx"));
const PlanTab = lazy(() => import("./features/PlanTab.jsx"));
const AllowancesTab = lazy(() => import("./features/AllowancesTab.jsx"));
const WealthTab = lazy(() => import("./features/WealthTab.jsx"));
const ReturnsTab = lazy(() => import("./features/ReturnsTab.jsx"));
const GiltsTab = lazy(() => import("./features/GiltsTab.jsx"));
const PensionTab = lazy(() => import("./features/PensionTab.jsx"));
const CgtSection = lazy(() => import("./features/CgtSection.jsx"));
const IncomeTab = lazy(() => import("./features/IncomeTab.jsx"));
const HoldingsTab = lazy(() => import("./features/HoldingsTab.jsx"));
const LedgerTab = lazy(() => import("./features/LedgerTab.jsx"));
const ImportTab = lazy(() => import("./features/ImportTab.jsx"));
const PropertyTab = lazy(() => import("./features/PropertyTab.jsx"));
const PrivateTab = lazy(() => import("./features/PrivateTab.jsx"));
const RsuTab = lazy(() => import("./features/RsuTab.jsx"));
const SyncTab = lazy(() => import("./features/SyncTab.jsx"));
const DeferredCashTab = lazy(() => import("./features/DeferredCashTab.jsx"));

/* ============================== app =================================== */
export default function App() {
  // Persisted app state lives in the Zustand store (src/state/appStore.js) —
  // same localStorage keys as before, setters are setState-compatible.
  const {
    dark, setDark, txns, setTxns, tab, setTab, income, setIncome,
    carried, setCarried, cash, setCash, pensionCashflows, setPensionCashflows,
    dmoReportDate, setDmoReportDate, valuations, setValuations,
    netWorthSnapshots, setNetWorthSnapshots,
    incomeEntries, setIncomeEntries, eriEntries, setEriEntries,
    prices, setPrices, avKey, setAvKey, avMeta, setAvMeta,
    priceMeta, setPriceMeta, secMeta, setSecMeta,
    properties, setProperties, mortgages, setMortgages, otherLiabilities, setOtherLiabilities,
    cashAccounts, setCashAccounts, allowanceOverrides, setAllowanceOverrides,
    planInputs, setPlanInputs,
    privateHoldings, setPrivateHoldings, privateEvents, setPrivateEvents,
    rsuGrants, setRsuGrants, rsuEvents, setRsuEvents,
    deferredCashAwards, deferredCashVests,
    ibkrQueryId, setIbkrQueryId, ibkrToken, setIbkrToken,
    creditCards, setCreditCards,
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
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  // Read-only mobile layer (Phase 3.4): on a phone-sized viewport, the
  // default view is a single-scroll, glanceable summary — not the full
  // editing UI reflowed into one column. `mobileFullApp` is an explicit,
  // session-only escape hatch (never persisted — every fresh mobile visit
  // starts back on the summary, which is the point) for anyone who does
  // need to edit something from their phone; the summary itself can't
  // mutate the ledger (same guarantee HomeTab.jsx already documents for
  // itself, since the summary is built on top of it).
  const isMobile = useIsMobile();
  const [mobileFullApp, setMobileFullApp] = useState(false);
  // (persistence moved into the store — one subscription, only changed keys)

  // ---- Phase 2.4: hash deep links + command palette -------------------
  const [paletteOpen, setPaletteOpen] = useState(false);
  // #/<leaf>(/<subtab>) — leaf keys are the SAME strings tab state has
  // always used, so old muscle memory and new URLs agree. A subtab segment
  // pre-selects an inner tab by writing its localStorage key before the
  // switch (CgtSection/PlanTab read it in a useState initialiser and
  // remount on tab change). Setting location.hash pushes a history entry,
  // so the browser back button walks tab history for free.
  React.useEffect(() => {
    const validLeaves = new Set(SCREENS.flatMap((s) => s.leaves));
    const applyHash = () => {
      const m = window.location.hash.match(/^#\/([a-z]+)(?:\/([a-z-]+))?$/i);
      if (!m || !validLeaves.has(m[1])) return;
      if (m[2]) {
        if (m[1] === "cgt") lsStore.set("cgt.cgtsubtab", m[2]);
        if (m[1] === "plan") lsStore.set("plan.subtab", m[2]);
      }
      setTab(m[1]);
    };
    applyHash(); // honour a deep link on first load
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);
  React.useEffect(() => {
    // Reflect leaf-level location in the hash (subtab segments only come
    // FROM deep links; inner tab clicks don't rewrite history — one
    // history entry per screen change is the sane granularity).
    if (!window.location.hash.startsWith(`#/${tab}`)) window.location.hash = `#/${tab}`;
  }, [tab]);
  React.useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPaletteOpen((o) => !o); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  // Per-wrapper cash fed into the wealth model is the manual/unallocated
  // figure PLUS the sum of any named cash accounts under that wrapper
  // (core/cash.mjs) — additive, so a user who's never touched the Cash
  // accounts panel sees exactly the old behaviour (effectiveCash === cash).
  const effectiveCash = useMemo(() => effectiveCashByWrapper(cash, cashAccounts), [cash, cashAccounts]);

  // The wealth model reads ALL wrappers — the whole point of the wealth core.
  // (eriTxns stay GIA-scoped: ERI only arises on unsheltered holdings.)
  const wealthModel = useMemo(() => {
    try { return buildWealthModel({ txns, eriTxns, incomeEntries, secMeta, prices, cash: effectiveCash }); }
    catch { return null; } // a malformed ledger shows its error via `matched` above
  }, [txns, eriTxns, incomeEntries, secMeta, prices, effectiveCash]);

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
    try { return computeReturns({ txns, incomeEntries, eriTxns, prices, valuations, secMeta }); }
    catch { return null; }
  }, [txns, incomeEntries, eriTxns, prices, valuations, secMeta]);

  // Private investments (EIS/SEIS/LP funds) — current valuations only; the
  // called/distributed/MOIC/relief detail lives entirely in PrivateTab.
  const privateSummary = useMemo(
    () => privateTotals(privateHoldings, privateEvents, todayISO()),
    [privateHoldings, privateEvents]
  );

  // RSU grants — held (vested, unsold) shares valued at the SAME live
  // `prices` map the rest of the app already fetches; full vesting-schedule
  // detail lives entirely in RsuTab.
  const rsuSummary = useMemo(
    () => rsuTotals(rsuGrants, rsuEvents, prices, todayISO()),
    [rsuGrants, rsuEvents, prices]
  );

  // Deferred cash comp — only the UNVESTED (`outstanding`) tranches feed net
  // worth; vested ones have been paid and are already counted as cash. Full
  // schedule detail lives in DeferredCashTab; see core/deferred-cash.mjs.
  const deferredCashSummary = useMemo(
    () => deferredCashTotals(deferredCashAwards, deferredCashVests, todayISO()),
    [deferredCashAwards, deferredCashVests]
  );

  // Phase 2: true household net worth = investments + cash (the existing
  // wealth model) + property equity + private-holding valuations + held RSU
  // value − other (non-mortgage) liabilities − credit card balances.
  // Mortgages are netted off inside property equity, not subtracted again.
  const creditCardDebt = useMemo(() => totalCreditCardDebt(creditCards), [creditCards]);
  const netWorth = useMemo(() => householdNetWorth({
    investedTotal: wealthModel ? wealthModel.total.total : 0,
    properties, mortgages, otherLiabilities, privateValue: privateSummary.currentValue, rsuValue: rsuSummary.currentValueGBP,
    deferredCashValue: deferredCashSummary.outstanding,
    creditCardDebt,
  }), [wealthModel, properties, mortgages, otherLiabilities, privateSummary, rsuSummary, deferredCashSummary, creditCardDebt]);

  // Daily household net-worth snapshot (core/net-worth-series.mjs) — the
  // headline number's own history. Unlike the `valuations` effect above,
  // this records EVEN WHEN holdings are unpriced (flagged `estimated`):
  // valuations must stay exact because TWR is computed from it; a
  // net-worth TREND is useless if it gaps every day one pension fund has
  // no quote. All-zero states record nothing (see the engine's header).
  React.useEffect(() => {
    if (!wealthModel || !netWorth) return;
    const rec = buildNetWorthSnapshot({ date: todayISO(), total: wealthModel.total, netWorth });
    if (!rec) return;
    setNetWorthSnapshots((s) => upsertDailySnapshot(s, rec));
  }, [wealthModel, netWorth]);

  // Gilt ladder analytics (build step 4) — driven by secMeta kind: "gilt".
  const giltData = useMemo(() => {
    try { return giltAnalytics({ txns, secMeta, prices }); }
    catch { return null; }
  }, [txns, secMeta, prices]);

  // Phase 2, step 4: forward income calendar — gilt coupons/redemptions
  // (contractually scheduled, from giltData.cashflows), cash account
  // maturities, and a cadence-detected forecast of recurring dividends and
  // interest. Uses the FULL ledger (all wrappers), not just GIA, since
  // dividends in ISA/SIPP are just as real a forward cashflow as taxable
  // ones — this is a "what's coming in" view, not a tax computation.
  // Pension CONTRIBUTIONS are deliberately excluded (see
  // core/income-calendar.mjs's header comment) — money going into the
  // pension pot isn't income, so pensionCashflows is intentionally not
  // passed here even though it's available in this component.
  const incomeCalendar = useMemo(() => buildIncomeCalendar({
    incomeEntries, txns,
    cashAccounts, giltCashflows: giltData ? giltData.cashflows : [],
    // Deferred-cash tranche payouts are contractually scheduled cash inflows
    // — folded in as a "deferred-cash" source (core/deferred-cash.mjs shapes
    // them, bounded to future/in-horizon).
    deferredCash: deferredCashCalendar(deferredCashAwards, deferredCashVests, todayISO(), 365),
    // Future scheduled RSU vests at TODAY'S price (estimated — the price
    // will differ on the day; unpriced tickers are skipped, not guessed).
    rsuVests: rsuGrants.flatMap((g) => {
      const price = prices[g.ticker];
      if (price == null) return [];
      return vestingSchedule(g, rsuEvents, todayISO())
        .filter((v) => !v.vested)
        .map((v) => ({ date: v.date, amount: (+v.shares || 0) * price, label: `${g.ticker} vest` }));
    }),
    today: todayISO(), horizonDays: 365,
  }), [incomeEntries, txns, cashAccounts, giltData, deferredCashAwards, deferredCashVests, rsuGrants, rsuEvents, prices]);

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

  // Phase 2, step 7: tax-year-end mode — a prioritised "use it or lose it"
  // checklist (ISA/AEA/dividend allowance/PSA/pension carry-forward), only
  // surfaced as an active banner once 5 April is close enough to matter
  // (see core/tax-year-end.mjs). Cheap to compute unconditionally; the
  // `active` flag (not a conditional hook) gates whether the Home tab shows it.
  const taxYearEnd = useMemo(() => taxYearEndChecklist({
    txns, pensionCashflows, incomeEntries, eriTxns, taxableDisposals, income,
    today: todayISO(),
  }), [txns, pensionCashflows, incomeEntries, eriTxns, taxableDisposals, income]);

  // Single-company concentration across the WHOLE household position:
  // ledger positions at live prices plus RSU-held employer shares (valued
  // by the RSU module, outside `positions`), merged per ticker inside
  // core/exposure.mjs — employer stock split across two tabs is still one
  // company risk. Feeds the Home action queue and the Wealth tab's
  // exposure panel.
  const exposureConcentration = useMemo(() => {
    const rsuByTicker = {};
    for (const r of rsuSummary.rows || []) {
      const tk = r.grant?.ticker;
      if (!tk || !r.priced || !(r.currentValueGBP > 0)) continue;
      rsuByTicker[tk] = (rsuByTicker[tk] || 0) + r.currentValueGBP;
    }
    return concentration({
      positions: wealthModel ? wealthModel.positions : [],
      extras: Object.entries(rsuByTicker).map(([ticker, value]) => ({ ticker, value, kind: "equity", label: "RSU held shares" })),
    });
  }, [wealthModel, rsuSummary]);

  // AI snapshot (core/ai-snapshot.mjs): one Markdown document of the whole
  // portfolio, built from aggregates this shell already computes, for
  // pasting into an LLM prompt. Assembled lazily-ish via memo; the
  // Holdings tab exposes copy/download buttons.
  const aiSnapshot = useMemo(() => {
    try {
      return renderAiSnapshot({
        today: todayISO(),
        netWorth, model: wealthModel, returns,
        pensionXirr: pensionXirrByWrapper({
          txns, secMeta, pensionCashflows,
          valueByWrapper: {
            SIPP: wealthModel?.byWrapper?.SIPP?.marketValue ?? 0,
            LISA: wealthModel?.byWrapper?.LISA?.marketValue ?? 0,
          },
          today: todayISO(),
        }),
        concentration: exposureConcentration,
        regionExposure: portfolioExposure({ positions: wealthModel?.positions || [], secMeta, field: "region" }),
        sectorExposure: portfolioExposure({ positions: wealthModel?.positions || [], secMeta, field: "sector" }),
        secMeta, cashAccounts, properties, mortgages,
      });
    } catch { return null; }
  }, [netWorth, wealthModel, returns, txns, secMeta, pensionCashflows, exposureConcentration, cashAccounts, properties, mortgages]);

  // Aggregates for the Home action queue (core/action-queue.mjs) — each
  // figure from the module that owns it: ISA subscriptions from the ledger
  // (allowances.mjs), AEA headroom from this year's taxable disposals
  // (allowances.mjs + uk-tax.mjs), harvestable gains from the CGT-taxable
  // S104 pools at live prices (NOT position book cost — the pools are the
  // tax truth, including ERI uplifts, and gilts are already excluded).
  const actionData = useMemo(() => {
    const year = ukTaxYear(todayISO());
    const isa = isaSubscriptionsByYear(txns)[year];
    const realised = realisedForYear(taxableDisposals, year, aeaForYear(year));
    let harvestable = 0;
    for (const [tk, p] of Object.entries(taxablePools)) {
      const price = prices[tk];
      if (!price || !p || p.qty <= 1e-9) continue;
      harvestable += Math.max(0, p.qty * price - p.cost);
    }
    return { isaSubscribed: isa ? isa.total : 0, aeaLeft: realised.aeaLeft, harvestable };
  }, [txns, taxableDisposals, taxablePools, prices]);

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
    // v15: generated from PERSIST_KEYS by core/backup.mjs — one source of
    // truth for what a backup contains (secrets/UI state/caches excluded
    // there, with an exhaustiveness test so a new persisted key can't
    // silently fall out of backups). See the module header for policy.
    const backup = buildBackup(useAppStore.getState());
    const text = JSON.stringify(backup, null, 2);
    lsStore.set("cgt.lastBackupAt", todayISO()); // feeds Home's backup-age nudge
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
        const plan = restorePlan(JSON.parse(r.result), { uid });
        if (plan.error) { setError(plan.error); return; }
        // Apply via the store's setter convention (stateKey -> setStateKey) —
        // generated, so a key restored by core/backup.mjs can't be missing a
        // hand-written apply line here (the old bug class this replaces).
        const s = useAppStore.getState();
        const setterOf = (key) => s["set" + key[0].toUpperCase() + key.slice(1)];
        for (const [key, value] of Object.entries(plan.updates)) {
          const setter = setterOf(key);
          if (typeof setter === "function") setter(value);
        }
        for (const [key, value] of Object.entries(plan.merges)) {
          const setter = setterOf(key);
          if (typeof setter === "function") setter((cur) => ({ ...cur, ...value }));
        }
        if (plan.legacy) {
          flash(`Imported ${plan.counts.txns} transactions (legacy format — no income/ERI data in this file).`);
        } else {
          const c = plan.counts;
          flash(`Restored: ${c.txns ?? 0} transactions, ${c.incomeEntries ?? 0} dividend/interest entries, ${c.pensionCashflows ?? 0} pension cashflows, ${c.properties ?? 0} properties, ${c.cashAccounts ?? 0} cash accounts, ${c.privateHoldings ?? 0} private holdings, ${c.rsuGrants ?? 0} RSU grants, ${c.creditCards ?? 0} credit cards, plus prices, allowances, plan inputs and settings.${plan.skipped.length ? ` Skipped malformed: ${plan.skipped.join(", ")}.` : ""}`);
        }
      } catch { setError("Couldn't parse that JSON file."); }
    };
    r.readAsText(f);
    e.target.value = ""; // allow re-selecting the same file
  };

  const mobileSummaryMode = isMobile && !mobileFullApp;
  // Shared by the normal "home" tab render AND the read-only mobile summary
  // below — one object, so the two call sites can never quietly drift.
  // Phase 2.8: only DERIVED data (computed in this shell) travels as props
  // now — HomeTab reads raw persisted state from the store itself.
  // setTab is wrapped so that, from the read-only mobile summary, tapping
  // an action-queue item (or any Home deep-link) opens the FULL app on
  // that tab — previously those taps changed the tab state invisibly
  // behind the summary, which looked like a dead button.
  const homeTabProps = {
    model: wealthModel, returns, netWorth,
    setTab: (t) => { setTab(t); if (mobileSummaryMode) setMobileFullApp(true); },
    taxYearEnd, actionData, incomeCalendar,
    concentration: exposureConcentration,
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
      <a href="#main-content" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[100] focus:px-3 focus:py-2 focus:rounded-lg focus:bg-[var(--accent)] focus:text-[var(--accent-fg)] focus:text-sm focus:font-medium">
        Skip to main content
      </a>
      <div className="root min-h-screen bg-[var(--bg)] text-[var(--fg)] flex" style={{ fontFamily: "ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif" }}>
        {!mobileSummaryMode && <DesktopSidebar tab={tab} setTab={setTab} onOpenPalette={() => setPaletteOpen(true)} />}
        {!mobileSummaryMode && <MobileDrawer tab={tab} setTab={setTab} open={mobileNavOpen} onClose={() => setMobileNavOpen(false)} onOpenPalette={() => setPaletteOpen(true)} />}
        <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} setTab={setTab}
          tickers={wealthModel ? [...new Set(wealthModel.positions.filter((p) => p.qty > 1e-9).map((p) => p.ticker))].sort() : []} />
        <main id="main-content" tabIndex={-1} className="flex-1 min-w-0">
          <div className="max-w-5xl mx-auto px-4 sm:px-6 py-6">
            {/* header */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <div className="flex items-center gap-2">
                {!mobileSummaryMode && (
                  <button onClick={() => setMobileNavOpen(true)} title="Menu" aria-label="Open menu" aria-expanded={mobileNavOpen}
                    className="sm:hidden inline-flex items-center justify-center w-9 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--fg)] shrink-0">
                    <Menu size={16} aria-hidden="true" />
                  </button>
                )}
                <div>
                  <h1 className="text-xl font-semibold tracking-tight flex items-center gap-2">
                    <Receipt size={20} className="text-[var(--accent)] sm:hidden" aria-hidden="true" /> Wealth Dashboard
                  </h1>
                  <p className="text-sm text-[var(--muted)] mt-0.5">
                    {mobileSummaryMode ? "Read-only summary" : "Net worth, tax & retirement — all figures GBP, all data on your device."}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {isMobile && mobileFullApp && (
                  <button onClick={() => setMobileFullApp(false)} title="Back to the read-only summary"
                    className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)] text-[var(--fg)]">
                    <ArrowLeft size={16} aria-hidden="true" /> Summary
                  </button>
                )}
                {status && <span role="status" className="text-xs text-[var(--muted)] mr-1 max-w-[220px] text-right leading-tight">{status}</span>}
                {!mobileSummaryMode && (
                  <>
                    <button onClick={exportJSON} title="Full backup: transactions, dividends/interest, ERI, prices and settings. API keys and the IBKR token are NOT included — re-enter those on a new machine. Also copies to clipboard as a fallback."
                      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)] text-[var(--fg)]">
                      <Download size={16} aria-hidden="true" /> Backup
                    </button>
                    <button onClick={() => fileRef.current && fileRef.current.click()} title="Restore from a full backup file (or import a legacy transactions-only JSON)"
                      className="inline-flex items-center gap-1.5 text-sm font-medium px-3 h-9 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)] text-[var(--fg)]">
                      <Upload size={16} aria-hidden="true" /> Restore
                    </button>
                  </>
                )}
                <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={importJSON} aria-label="Choose backup file to restore" />
                <IconBtn onClick={() => setDark((d) => !d)} title={dark ? "Switch to light theme" : "Switch to dark theme"}>{dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}</IconBtn>
              </div>
            </div>

            {error && (
              <div role="alert" className="mt-4 flex items-start gap-2 text-sm rounded-lg px-3 py-2 text-[var(--loss)] border"
                style={{ background: "color-mix(in srgb, var(--loss) 12%, transparent)", borderColor: "color-mix(in srgb, var(--loss) 35%, transparent)" }}>
                <AlertTriangle size={16} className="mt-0.5 shrink-0" aria-hidden="true" /> <span>{error}</span>
              </div>
            )}

            {mobileSummaryMode ? (
              <div className="mt-5 space-y-4">
                <Suspense fallback={<div className="text-sm text-[var(--muted)] py-6">Loading…</div>}>
                  {/* PlanHealthCard now renders INSIDE HomeTab (it's on the
                      desktop Home too since the redesign) — no separate copy
                      here or the summary would show it twice. */}
                  <HomeTab {...homeTabProps} />
                </Suspense>
                <button onClick={() => setMobileFullApp(true)}
                  className="w-full inline-flex items-center justify-center gap-2 text-sm font-medium px-4 h-11 rounded-lg border border-[var(--border)] bg-[var(--panel)] hover:bg-[var(--panel2)] text-[var(--fg)]">
                  <LayoutGrid size={16} aria-hidden="true" /> Open full app — add, edit, and explore every tab
                </button>
                <p className="text-xs text-[var(--muted)] leading-relaxed">
                  This summary is read-only by design — nothing here can change your data. Tap "Open full app" any time to reach every tab (imports, ledger edits, tax tools, retirement planner) exactly as on desktop.
                </p>
              </div>
            ) : (
            <div className="mt-5">
            <SubTabBar tab={tab} setTab={setTab} />
            <Suspense fallback={<div className="text-sm text-[var(--muted)] py-6">Loading…</div>}>
              {tab === "home" && <HomeTab {...homeTabProps} />}
              {tab === "plan" && <PlanTab {...{
                dark,
                planInputs, setPlanInputs,
                // Gilt cashflows (coupons + redemptions of gilts held today,
                // from giltAnalytics) — the Income floor sub-tab stacks them
                // under State Pension/DB/annuity as contractual income.
                giltCashflows: giltData ? giltData.cashflows : [],
                // Recurring-dividend estimate for the Run-off sub-tab
                // (forward income on current units, from the returns engine).
                forwardDividends: returns?.total?.forwardIncome ?? 0,
                // wrapper totals (holdings + cash) for one-click plan prefill
                livePots: wealthModel ? Object.fromEntries(["SIPP", "ISA", "GIA", "LISA"].map((w) => [w, wealthModel.byWrapper[w]?.total ?? null])) : null,
                liveSalary: income,
                // Property equity net of non-mortgage liabilities — a static
                // "other net worth" figure, kept OUT of the investable pots
                // above so it's never treated as liquid, growing, drawdown-
                // eligible wealth by the projection engine.
                liveOtherNetWorth: netWorth ? netWorth.propertyEquity - netWorth.otherLiabilities - netWorth.creditCardDebt : null,
                // IHT module: a clean, separate bundle of `netWorth`'s pieces
                // for "your estate today" — deliberately NOT reusing
                // liveOtherNetWorth above (that figure is already net of
                // liabilities/credit cards, for the drawdown engine's
                // "static addendum" role); the IHT card needs each
                // component raw so it can apply its own band/relief maths.
                liveEstate: netWorth ? {
                  propertyEquity: netWorth.propertyEquity,
                  privateValue: netWorth.privateValue,
                  rsuValue: netWorth.rsuValue,
                  otherLiabilities: netWorth.otherLiabilities,
                  creditCardDebt: netWorth.creditCardDebt,
                } : null,
              }} />}
              {tab === "wealth" && <WealthTab model={wealthModel} netWorth={netWorth} setTab={setTab} />}
              {tab === "returns" && <ReturnsTab returns={returns} />}
              {tab === "gilts" && <GiltsTab data={giltData} />}
              {tab === "pension" && <PensionTab recomputeProviderCost={recomputeProviderCost} />}
              {tab === "cgt" && <CgtSection {...{
                taxYears, activeYear, setYear, yearDisposals, liab,
                carryForward: allYears.carriedForward, exemptGiltDisposalCount,
                pools: taxablePools, disposals: taxableDisposals, txns: giaTxns,
                positions: wealthModel ? wealthModel.positions : [],
                yearlyLiab: allYears.results,
              }} />}
              {tab === "allowances" && <AllowancesTab eriTxns={eriTxns} taxableDisposals={taxableDisposals} />}
              {tab === "income" && <IncomeTab {...{ eriTxns, incomeByYear, incomeAllWrappers, txns: giaTxns, incomeCalendar }} />}
              {tab === "holdings" && <HoldingsTab positions={wealthModel ? wealthModel.positions : []} model={wealthModel} concentration={exposureConcentration} aiSnapshot={aiSnapshot} />}
              {tab === "property" && <PropertyTab />}
              {tab === "private" && <PrivateTab />}
              {tab === "rsu" && <RsuTab />}
              {tab === "deferredcash" && <DeferredCashTab />}
              {tab === "ledger" && <LedgerTab />}
              {tab === "sync" && <SyncTab />}
              {tab === "import" && <ImportTab setTab={setTab} recomputeProviderCost={recomputeProviderCost} />}
            </Suspense>
            </div>
            )}

            <p className="text-xs text-[var(--muted)] mt-8 leading-relaxed">
              Figures are an estimate to support your own filing, not tax advice. Verify before submitting to HMRC.
            </p>
          </div>
        </main>
      </div>
    </div>
  );
}
