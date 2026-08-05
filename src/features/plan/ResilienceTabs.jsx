/* Plan sub-tabs concerned with whether the plan SURVIVES rather than what it
   averages: the guaranteed-income floor, the expense run-off, drawdown
   strategy, sequence-risk heatmap, stress tests, historical replay, and the
   Monte-Carlo adequacy view. Extracted verbatim from PlanTab.jsx during the
   file split; no behaviour change. */
import React, { useMemo, useState, useCallback } from "react";
import {
  ResponsiveContainer, ComposedChart, AreaChart, LineChart, BarChart,
  Area, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";
import {
  Settings2, TrendingUp, TrendingDown, ShieldAlert, Activity, Gauge,
  ChevronDown, ChevronUp, Info, RefreshCw, Building2, Coins, HeartPulse,
  Layers, Landmark, Plus, Trash2, Umbrella, Droplets,
} from "lucide-react";
import { T, MONO, SANS, gbp, gbpK, pct, tooltipStyle } from "./theme.js";
import { Card, Stat, Field, Segmented, Toggle, PanelSection, Legendlet, Note, Barline, Row } from "./controls.jsx";
import { mcInputsFromPlan, applyScenario, SCENARIOS } from "./scenarios.jsx";
import { taxRUK, taxScot, employeeNI, netEmploymentIncome } from "../../core/uk-income-tax.mjs";
import { lifeExpectancy, effInflation, btlYearly, replayDecum, STRATEGY_LABELS, buildProjection, HIST } from "../../core/drawdown.mjs";
import { bootstrapPairs, TWO_ASSET_DEFAULTS } from "../../core/monte-carlo.mjs";
import { solveSWR } from "../../core/swr.mjs";
import { runGuytonKlinger } from "../../core/guyton-klinger.mjs";
import { rollingStressTest } from "../../core/sequence-risk.mjs";
import { buildIncomeFloor } from "../../core/income-floor.mjs";
import { optimiseDrawdown, TFC_LABELS } from "../../core/drawdown-optimiser.mjs";
import { sequenceHeatmap } from "../../core/sequence-heatmap.mjs";
import { buildRunoff } from "../../core/runoff-model.mjs";
import { effectiveCashByWrapper } from "../../core/cash.mjs";
import { deferredCashCalendar } from "../../core/deferred-cash.mjs";
import { vestingSchedule } from "../../core/rsu.mjs";
import { giltIncomeByYear } from "../../core/gilt-ladder.mjs";
import { planSpendFromBudget, mergedSpend } from "../../core/budget.mjs";
import { store, uid, todayISO } from "../../ui/shared.jsx";
import useAppStore from "../../state/appStore.js";

function FloorTab({ p, det, set, giltCashflows = [] }) {
  const currentYear = new Date().getFullYear();
  const giltNominalByYear = useMemo(() => giltIncomeByYear(giltCashflows), [giltCashflows]);
  const floor = useMemo(
    () => buildIncomeFloor({ det, p, giltNominalByYear, currentYear, essentialPct: p.essentialPct ?? 65 }),
    [det, p, giltNominalByYear, currentYear]
  );
  const s = floor.summary;
  if (!s) {
    return (
      <Note tone="amber">
        The income floor needs a retirement phase to analyse — check that retirement age is above current age on the panel.
      </Note>
    );
  }

  const spaRow = floor.rows.find((r) => r.age >= p.spaAge) || null;
  const hasGilts = Object.keys(giltNominalByYear).length > 0;
  const fmtCover = (c) => (c == null ? "n/a" : pct(Math.min(9.99, c), 0));

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", gap: 12, marginBottom: 16 }}>
        <Card><Stat label={`Essentials covered from`} value={s.permanentFromAge ? `age ${s.permanentFromAge}` : "never"} sub={s.permanentFromAge ? "every year from here is covered" : `guaranteed income never reaches ${Math.round(s.essentialPct)}% of spend`} tone={s.permanentFromAge ? "green" : "red"} /></Card>
        <Card><Stat label="Years fully covered" value={`${s.coveredYears} / ${s.totalYears}`} sub={`essential = ${Math.round(s.essentialPct)}% of target spend`} tone={s.coveredYears === s.totalYears ? "green" : "ink"} /></Card>
        <Card><Stat label="Thinnest year" value={fmtCover(s.worstCoverage)} sub={s.worstAge ? `of essentials at age ${s.worstAge}` : ""} tone={s.worstCoverage != null && s.worstCoverage < 1 ? "red" : "green"} /></Card>
        <Card><Stat label={`At State Pension age (${p.spaAge})`} value={spaRow ? gbp(spaRow.guaranteed) : "—"} sub={spaRow ? `guaranteed vs ${gbp(spaRow.essential)} essential` : "outside plan range"} tone={spaRow && spaRow.covered ? "green" : "ink"} /></Card>
      </div>

      <Card>
        <div style={{ fontSize: 13, fontWeight: 600, color: T.ink, marginBottom: 8 }}>
          Guaranteed income vs essential spending — today's £, age {floor.rows[0].age} to {floor.rows[floor.rows.length - 1].age}
        </div>
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={floor.rows} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), { state: "State Pension", db: "DB pension", annuity: "Annuity", gilt: "Gilt ladder cashflow", essential: "Essential spend", spend: "Target spend" }[n] || n]} labelFormatter={(a) => `Age ${a}`} />
            <Area type="stepAfter" dataKey="state" stackId="floor" stroke="none" fill={T.blue} fillOpacity={0.75} name="state" />
            <Area type="stepAfter" dataKey="db" stackId="floor" stroke="none" fill={T.green} fillOpacity={0.7} name="db" />
            <Area type="stepAfter" dataKey="annuity" stackId="floor" stroke="none" fill={T.gold} fillOpacity={0.7} name="annuity" />
            <Area type="stepAfter" dataKey="gilt" stackId="floor" stroke="none" fill={T.ink2} fillOpacity={0.55} name="gilt" />
            <Line type="monotone" dataKey="essential" stroke={T.red} strokeWidth={2} dot={false} name="essential" />
            <Line type="monotone" dataKey="spend" stroke={T.muted} strokeWidth={1.2} strokeDasharray="5 4" dot={false} name="spend" />
            {p.includeState && <ReferenceLine x={p.spaAge} stroke={T.blue} strokeDasharray="2 3" label={{ value: "State Pension", position: "top", fontSize: 10, fill: T.blue }} />}
          </ComposedChart>
        </ResponsiveContainer>
        <Legendlet items={[
          { c: T.blue, t: "State Pension" },
          ...(p.dbEnabled ? [{ c: T.green, t: "DB pension" }] : []),
          ...(p.annuityEnabled ? [{ c: T.gold, t: "Annuity" }] : []),
          ...(hasGilts ? [{ c: T.ink2, t: "Gilt ladder (coupons + maturities)" }] : []),
          { c: T.red, t: "Essential spend" },
          { c: T.muted, t: "Target spend", dash: true },
        ]} />
      </Card>

      <div style={{ marginTop: 12 }}>
        <Note tone="blue">
          A different question to the Monte Carlo tab: not "will the portfolio last?" but "if markets fell apart, what still gets paid?".
          Everything here is contractual or state-backed and shown in today's £.
          Deliberately excluded: portfolio withdrawals (the thing being stress-screened out) and buy-to-let rent (voids and arrears make it contingent — it stays on the Buy-to-let tab).
          {hasGilts
            ? ` The gilt ladder counts coupons AND maturing principal from gilts you hold today (${s.giltYearsCounted} year${s.giltYearsCounted === 1 ? "" : "s"} of cashflow) — it runs out when the last gilt matures, and the chart shows that cliff on purpose; no reinvestment is assumed.`
            : " No gilts are held (or none have prices) — a gilt ladder bought over the next few years is the classic way to raise the floor across any gap before the State Pension starts."}
          {" "}Raise the floor with more DB/annuity/gilts; lower the essential share on the panel if {Math.round(s.essentialPct)}% overstates your true needs.
          {!s.permanentFromAge && p.annuityEnabled === false && " An annuity (panel, optional) is the bluntest fix for a floor that never closes."}
        </Note>
      </div>
    </div>
  );
}

/* ===================== EXPENSE RUN-OFF ===================== */
// "If I spend £X/yr, where does it come from, year by year, before I have
// to sell anything?" — core/runoff-model.mjs. Sources in strict order:
// gilt ladder (with the surplus BANK carrying forward), cash float,
// deferred-cash tranches, RSU vests (sell-on-vest at today's price),
// recurring dividends, and only then portfolio disposals. All modelling
// assumptions are in the core module's header and echoed in the footer.
function RunoffTab({ p, giltCashflows = [], forwardDividends = 0, budgetSpend = null }) {
  const cash = useAppStore((s) => s.cash);
  const cashAccounts = useAppStore((s) => s.cashAccounts);
  const dcAwards = useAppStore((s) => s.deferredCashAwards);
  const dcVests = useAppStore((s) => s.deferredCashVests);
  const rsuGrants = useAppStore((s) => s.rsuGrants);
  const rsuEvents = useAppStore((s) => s.rsuEvents);
  const prices = useAppStore((s) => s.prices);

  // View inputs, persisted per-browser like the rebalance targets — a
  // planning knob, not portfolio data.
  const [expense, setExpense] = useState(() => store.get("plan.runoff.expense", p.targetAbsolute || 40000));
  React.useEffect(() => store.set("plan.runoff.expense", expense), [expense]);
  const [horizon, setHorizon] = useState(() => store.get("plan.runoff.years", 25));
  React.useEffect(() => store.set("plan.runoff.years", horizon), [horizon]);
  // Display mode: nominal £ (the engine's native unit — gilt/deferred
  // flows are contractual nominal) or today's £ (every year deflated by
  // the same inflation the expense uprates at, so the expense line reads
  // FLAT and erosion of fixed cashflows is visible).
  const [realTerms, setRealTerms] = useState(() => store.get("plan.runoff.real", true));
  React.useEffect(() => store.set("plan.runoff.real", realTerms), [realTerms]);
  // CGT on portfolio sales — opt-in, because it needs a gain-fraction
  // assumption the app can't reliably derive for a GIA blended pool.
  const [cgtOn, setCgtOn] = useState(() => store.get("plan.runoff.cgtOn", false));
  React.useEffect(() => store.set("plan.runoff.cgtOn", cgtOn), [cgtOn]);
  const [cgtGain, setCgtGain] = useState(() => store.get("plan.runoff.cgtGain", 40));
  React.useEffect(() => store.set("plan.runoff.cgtGain", cgtGain), [cgtGain]);
  // Include future RSU vests / deferred-cash tranches? On by default (they
  // ARE scheduled income), but toggling off shows the conservative floor
  // that leans only on gilts, cash and dividends.
  const [useRsu, setUseRsu] = useState(() => store.get("plan.runoff.useRsu", true));
  React.useEffect(() => store.set("plan.runoff.useRsu", useRsu), [useRsu]);
  const [useDeferred, setUseDeferred] = useState(() => store.get("plan.runoff.useDeferred", true));
  React.useEffect(() => store.set("plan.runoff.useDeferred", useDeferred), [useDeferred]);

  const today = todayISO();
  const startYear = +today.slice(0, 4) + 1; // first FULL calendar year

  const inputs = useMemo(() => {
    const byYear = (events, dateOf, amountOf) => {
      const m = {};
      for (const e of events) { const y = +dateOf(e).slice(0, 4); m[y] = (m[y] || 0) + amountOf(e); }
      return m;
    };
    const giltNominalByYear = giltIncomeByYear(giltCashflows);
    const cashStart = Object.values(effectiveCashByWrapper(cash, cashAccounts)).reduce((s, v) => s + v, 0);
    const deferredByYear = byYear(
      deferredCashCalendar(dcAwards, dcVests, today, horizon * 366),
      (e) => e.date, (e) => e.amount
    );
    // RSU: FUTURE scheduled vests only, at today's price (sell-on-vest —
    // held shares are already in the portfolio, see module header).
    const rsuByYear = {};
    let rsuUnpriced = 0;
    for (const g of rsuGrants) {
      const price = prices[g.ticker];
      for (const v of vestingSchedule(g, rsuEvents, today)) {
        if (v.vested) continue;
        if (price == null) { rsuUnpriced++; continue; }
        const y = +v.date.slice(0, 4);
        rsuByYear[y] = (rsuByYear[y] || 0) + (+v.shares || 0) * price;
      }
    }
    // TAX: RSU vests and deferred-cash tranches are employment income —
    // net them down at marginal UK bands + employee NI, taxed JOINTLY per
    // year (they stack on each other) on top of salary while still
    // working, on top of nothing after retirement. Dividends are left
    // gross (assumed ISA/VCT — disclosed in the footnote); gilt coupons
    // and redemptions are untaxed here (low-coupon gilts in a GIA are
    // mostly CGT-free redemption gain; coupon tax would need per-gilt
    // detail this view doesn't have — disclosed too).
    const retireYear = (startYear - 1) + Math.max(0, (+p.retireAge || 0) - (+p.currentAge || 0));
    let grossComp = 0, netComp = 0;
    for (const y of new Set([...Object.keys(deferredByYear), ...Object.keys(rsuByYear)].map(Number))) {
      const gross = (deferredByYear[y] || 0) + (rsuByYear[y] || 0);
      if (!(gross > 0)) continue;
      const base = y < retireYear ? (+p.salary || 0) : 0;
      const f = netEmploymentIncome(gross, { base, region: p.region }) / gross;
      if (deferredByYear[y]) deferredByYear[y] *= f;
      if (rsuByYear[y]) rsuByYear[y] *= f;
      grossComp += gross; netComp += gross * f;
    }
    const compTaxRate = grossComp > 0 ? 1 - netComp / grossComp : 0;
    return { giltNominalByYear, cashStart, deferredByYear, rsuByYear, rsuUnpriced, compTaxRate };
  }, [giltCashflows, cash, cashAccounts, dcAwards, dcVests, rsuGrants, rsuEvents, prices, today, horizon, startYear, p]);

  const runoff = useMemo(() => buildRunoff({
    annualExpense: +expense || 0, inflation: effInflation(p), startYear, years: Math.max(1, +horizon || 1),
    giltNominalByYear: inputs.giltNominalByYear, cashStart: inputs.cashStart,
    // RSU vests and deferred cash are less certain than gilts and cash —
    // vests depend on continued employment and a share price, deferred
    // tranches on staying at the firm. Toggling them off answers "how does
    // the run-off look if I DON'T rely on comp I haven't received yet?",
    // which is the conservative floor worth seeing.
    deferredByYear: useDeferred ? inputs.deferredByYear : {},
    rsuByYear: useRsu ? inputs.rsuByYear : {},
    annualDividends: +forwardDividends || 0,
    // CGT on the sales that cover a shortfall — off unless the user asks,
    // since it needs an assumption (what fraction of a sale is gain).
    cgtGainFraction: cgtOn ? (+cgtGain || 0) / 100 : 0,
    cgtRate: cgtOn ? 0.24 : 0,        // higher-rate CGT on non-property assets
    cgtAllowance: cgtOn ? 3000 : 0,   // annual exempt amount
  }), [expense, horizon, p, startYear, inputs, forwardDividends, cgtOn, cgtGain, useRsu, useDeferred]);

  const s = runoff.summary;
  // Deflate for display when in today's-£ mode (engine stays nominal).
  const deflate = (row, v) => realTerms ? v / Math.pow(1 + effInflation(p) / 100, row.year - startYear) : v;
  const displayRows = runoff.rows.map((r) => {
    const d = { ...r };
    for (const k of ["expense", "fromGilts", "fromCash", "fromDeferred", "fromRsu", "fromDividends", "fromPortfolio", "portfolioGross", "cgtOnSale", "surplusToCash", "giltBankEnd", "cashEnd", "giltIn", "deferredIn", "rsuIn", "divIn", "totalIn", "net", "balanceEnd"]) d[k] = deflate(r, r[k]);
    d.expenseNeg = -d.expense; // cash-flow view: spend as a negative bar
    return d;
  });
  const SOURCES = [
    ["fromGilts", "Gilt ladder", T.blue],
    ["fromCash", "Cash", T.green],
    ["fromDeferred", "Deferred cash", "#7A5C9E"],
    ["fromRsu", "RSU vests", T.gold],
    ["fromDividends", "Dividends", T.amber],
    ["fromPortfolio", "Portfolio sales", T.red],
  ];
  // Cash-flow view: GROSS money in (received, whether or not the waterfall
  // needed it) vs the spend as a negative bar, with the total liquid
  // balance (cash + gilt bank) as a line.
  const INFLOWS = [
    ["giltIn", "Gilt coupons + maturities", T.blue],
    ["deferredIn", "Deferred cash", "#7A5C9E"],
    ["rsuIn", "RSU vests (sold)", T.gold],
    ["divIn", "Dividends", T.amber],
    ["fromPortfolio", "Portfolio sales", T.red],
  ];
  const [chartView, setChartView] = useState(() => store.get("plan.runoff.chart", "flow"));
  React.useEffect(() => store.set("plan.runoff.chart", chartView), [chartView]);

  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <Droplets size={17} color={T.blue} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Expense run-off — what pays the bills before anything is sold</h3>
        </div>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted, maxWidth: 680 }}>
          An annual spend, funded in strict order: gilt cashflows (surpluses bank forward), your cash float, deferred-cash tranches, RSU vests, recurring dividends — and only then portfolio sales. The question this answers: <strong>when does the selling start?</strong>
        </p>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
          <Field label="Annual spend (today's £)" value={expense} min={0} max={500000} step={1000} prefix="£" onChange={setExpense} />
          <Field label="Horizon (years)" value={horizon} min={1} max={40} onChange={setHorizon} />
          <div>
            <div style={{ fontSize: 11.5, color: T.ink2, fontWeight: 600, marginBottom: 4 }}>Display</div>
            <Segmented ariaLabel="Money terms" value={realTerms ? "real" : "nominal"} onChange={(v) => setRealTerms(v === "real")} accent={T.blue}
              options={[{ value: "real", label: "Today's £" }, { value: "nominal", label: "Nominal £" }]} />
          </div>
          {/* Each option group is a self-contained column, so revealing the
              CGT slider grows THIS column downward rather than shoving the
              comp toggles sideways. */}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div style={{ fontSize: 11.5, color: T.ink2, fontWeight: 600 }}>Include future comp</div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: T.ink2 }}>
              <input type="checkbox" checked={useRsu} onChange={(e) => setUseRsu(e.target.checked)} /> RSU vests
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: T.ink2 }}>
              <input type="checkbox" checked={useDeferred} onChange={(e) => setUseDeferred(e.target.checked)} /> Deferred cash
            </label>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 210 }}>
            <div style={{ fontSize: 11.5, color: T.ink2, fontWeight: 600 }}>Portfolio sales</div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: T.ink2 }}>
              <input type="checkbox" checked={cgtOn} onChange={(e) => setCgtOn(e.target.checked)} /> Account for CGT
            </label>
            {cgtOn && (
              <div style={{ marginTop: 2 }}>
                <Field label="Gain fraction of a sale" value={cgtGain} min={0} max={100} step={5} suffix=" %" onChange={setCgtGain} />
              </div>
            )}
          </div>
        </div>
        {budgetSpend?.ready && Math.round(budgetSpend.annualSpend) !== Math.round(+expense || 0) && (
          <p style={{ margin: "10px 0 0", fontSize: 11.5, color: T.muted }}>
            Your Budget tab's trailing-12-month actual spend is <strong style={{ color: T.ink }}>{gbp(budgetSpend.annualSpend)}</strong>.{" "}
            <button onClick={() => setExpense(Math.round(budgetSpend.annualSpend))} style={{ color: T.blue, textDecoration: "underline", textDecorationStyle: "dotted" }}>Use it here →</button>
          </p>
        )}
      </Card>

      {s && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 12, marginBottom: 14 }}>
            <Card><Stat label="First portfolio sale" value={s.firstDisposalYear ?? "never"} sub={s.firstDisposalYear ? `${s.firstDisposalYear - startYear} clear year${s.firstDisposalYear - startYear === 1 ? "" : "s"} first` : `covered for all ${s.totalYears} years`} tone={s.firstDisposalYear ? "amber" : "green"} /></Card>
            <Card><Stat label="Selling every year from" value={s.permanentDisposalFrom ?? "never"} sub="no later rescue after this" tone={s.permanentDisposalFrom ? "red" : "green"} /></Card>
            <Card><Stat label="Total sold over horizon" value={gbpK(cgtOn ? s.totalPortfolioGross : s.totalFromPortfolio)} sub={cgtOn && s.totalCgtOnSales > 0 ? `incl. ${gbpK(s.totalCgtOnSales)} CGT` : `${s.coveredYears}/${s.totalYears} years need no sales`} /></Card>
            <Card><Stat label="Gilt ladder ends" value={s.giltLadderEndsYear ?? "no gilts"} sub={s.cashExhaustedYear ? `cash float gone ${s.cashExhaustedYear}` : "cash float never exhausted"} /></Card>
          </div>

          <Card style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.ink }}>
                {chartView === "flow" ? "Cash flow — what arrives vs what you spend" : "Funding waterfall — what covers each year"} — {realTerms ? "today's £" : "nominal £"}
              </div>
              <Segmented ariaLabel="Chart view" value={chartView} onChange={setChartView} accent={T.blue}
                options={[{ value: "flow", label: "Cash flow" }, { value: "src", label: "Funding waterfall" }]} />
            </div>
            {chartView === "flow" ? (
              <>
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={displayRows} stackOffset="sign" margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={T.lineSoft} vertical={false} />
                    <XAxis dataKey="year" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} />
                    <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={56} />
                    <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => {
                      const labels = { ...Object.fromEntries(INFLOWS.map(([k, l]) => [k, l])), expenseNeg: "Spend", balanceEnd: "Cash + gilt bank (end)" };
                      return [gbp(Math.abs(v)), labels[n] || n];
                    }} labelFormatter={(y) => `Year ${y}`} />
                    <ReferenceLine y={0} stroke={T.line} />
                    {INFLOWS.map(([k, , c]) => (
                      <Bar key={k} dataKey={k} stackId="flow" fill={c} fillOpacity={k === "fromPortfolio" ? 0.85 : 0.7} name={k} />
                    ))}
                    <Bar dataKey="expenseNeg" stackId="flow" fill={T.ink} fillOpacity={0.35} name="expenseNeg" />
                    <Line type="monotone" dataKey="balanceEnd" stroke={T.green} strokeWidth={2} dot={false} name="balanceEnd" />
                  </ComposedChart>
                </ResponsiveContainer>
                <Legendlet items={[...INFLOWS.map(([, l, c]) => ({ c, t: l })), { c: T.ink, t: "Spend (out)" }, { c: T.green, t: "Cash + gilt bank at year end" }]} />
              </>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={280}>
                  <ComposedChart data={displayRows} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                    <CartesianGrid stroke={T.lineSoft} vertical={false} />
                    <XAxis dataKey="year" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} />
                    <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
                    <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), Object.fromEntries(SOURCES.map(([k, l]) => [k, l]))[n] || (n === "expense" ? "Spend" : n)]} labelFormatter={(y) => `Year ${y}`} />
                    {SOURCES.map(([k, , c]) => (
                      <Area key={k} type="stepAfter" dataKey={k} stackId="src" stroke="none" fill={c} fillOpacity={k === "fromPortfolio" ? 0.8 : 0.65} name={k} />
                    ))}
                    <Line type="stepAfter" dataKey="expense" stroke={T.ink} strokeWidth={1.6} strokeDasharray="5 4" dot={false} name="expense" />
                  </ComposedChart>
                </ResponsiveContainer>
                <Legendlet items={[...SOURCES.map(([, l, c]) => ({ c, t: l })), { c: T.ink, t: realTerms ? "Spend (flat — today's £)" : "Spend (inflation-uprated)", dash: true }]} />
              </>
            )}
          </Card>

          {/* The TABLE follows the same framing as the chart, because the
              two answer different questions and mixing them is what made
              this confusing. Cash flow = what ARRIVES each year (a
              dividend shows up whether or not the waterfall needed it);
              funding waterfall = what was CONSUMED to meet the spend, in
              priority order, where a covered year legitimately reads £0
              for every source below the one that covered it. */}
          <Card style={{ padding: 0, overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              {chartView === "flow" ? (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: T.lineSoft }}>
                      {["Year", "Gilts", "Deferred cash", "RSU vests", "Dividends", "Total in", "Spend", "Net", "Sold", "Balance end"].map((h, i) => (
                        <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "9px 10px", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase", color: T.muted, fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((r) => (
                      <tr key={r.year} style={{ borderTop: `1px solid ${T.line}`, background: r.covered ? "transparent" : `color-mix(in srgb, ${T.red} 7%, transparent)` }}>
                        <td style={{ padding: "7px 10px", fontFamily: MONO, fontWeight: 600 }}>{r.year}</td>
                        {[["giltIn", T.blue], ["deferredIn", "#7A5C9E"], ["rsuIn", T.gold], ["divIn", T.amber]].map(([k, c]) => (
                          <td key={k} style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: r[k] > 0 ? c : T.muted }}>
                            {r[k] > 0 ? gbpK(r[k]) : "—"}
                          </td>
                        ))}
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, fontWeight: 600 }}>{gbpK(r.totalIn)}</td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: T.ink2 }}>({gbpK(r.expense)})</td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, fontWeight: 600, color: r.net >= 0 ? T.green : T.red }}>
                          {r.net >= 0 ? "+" : "−"}{gbpK(Math.abs(r.net))}
                        </td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: r.fromPortfolio > 0 ? T.red : T.muted }}
                          title={cgtOn && r.cgtOnSale > 0 ? `Sell ${gbp(r.portfolioGross)} to net ${gbp(r.fromPortfolio)} after ${gbp(r.cgtOnSale)} CGT` : undefined}>
                          {(cgtOn ? r.portfolioGross : r.fromPortfolio) > 0 ? gbpK(cgtOn ? r.portfolioGross : r.fromPortfolio) : "—"}
                          {cgtOn && r.cgtOnSale > 0 && <span style={{ color: T.muted, fontSize: 10.5, marginLeft: 3 }}>·{gbpK(r.cgtOnSale)} tax</span>}
                        </td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: T.ink2 }}
                          title={`Cash ${gbp(r.cashEnd)}${r.giltBankEnd > 0 ? ` + banked gilt proceeds ${gbp(r.giltBankEnd)}` : ""}`}>
                          {gbpK(r.balanceEnd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr style={{ background: T.lineSoft }}>
                      {["Year", "Spend", ...SOURCES.map(([, l]) => l), "Gilt bank", "Cash left"].map((h, i) => (
                        <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "9px 10px", fontSize: 10.5, letterSpacing: ".04em", textTransform: "uppercase", color: T.muted, fontWeight: 700, whiteSpace: "nowrap" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {displayRows.map((r) => (
                      <tr key={r.year} style={{ borderTop: `1px solid ${T.line}`, background: r.covered ? "transparent" : `color-mix(in srgb, ${T.red} 7%, transparent)` }}>
                        <td style={{ padding: "7px 10px", fontFamily: MONO, fontWeight: 600 }}>{r.year}</td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO }}>{gbpK(r.expense)}</td>
                        {SOURCES.map(([k, , c]) => (
                          <td key={k} style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: r[k] > 0 ? (k === "fromPortfolio" ? T.red : c) : T.muted }}>
                            {r[k] > 0 ? gbpK(r[k]) : "—"}
                          </td>
                        ))}
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: r.giltBankEnd > 0 ? T.blue : T.muted }}>{r.giltBankEnd > 0 ? gbpK(r.giltBankEnd) : "—"}</td>
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: T.ink2, whiteSpace: "nowrap" }} title={r.surplusToCash > 0 ? `+${gbp(r.surplusToCash)} surplus income banked this year` : undefined}>
                          {gbpK(r.cashEnd)}{r.surplusToCash > 0 && <span style={{ color: T.green, fontSize: 10.5, marginLeft: 4 }}>+{gbpK(r.surplusToCash)}</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
            <div style={{ padding: "8px 12px", fontSize: 11.5, color: T.muted, borderTop: `1px solid ${T.line}` }}>
              {chartView === "flow"
                ? "What ARRIVES each year, against what you spend. A dividend or vest appears here whether or not that year needed it — surplus rolls into the balance. \"Sold\" is what had to come out of the portfolio; a shaded row is a year that needed it."
                : "What was CONSUMED to meet each year's spend, in priority order: gilts, then cash, then deferred, vests, dividends, and only then portfolio sales. Sources below the one that covered the year read £0 by design — the money still arrived; see the Cash flow view."}
            </div>
          </Card>

          <div style={{ marginTop: 12 }}>
            <Note tone="blue">
              Nominal £ throughout ({effInflation(p)}%/yr spend uprating); the gilt bank and cash float earn nothing here — crediting interest would quietly stretch the runway.
              "Cash left" can RISE: income received beyond a year's need (dividends, deferred-cash tranches, RSU vests once gilts have covered the spend) is banked into the float — the small green +£ next to it is that year's top-up. Gilt surpluses stay in their own bank so the ladder's contribution stays auditable. The Cash-flow chart shows the same engine as gross money IN (bars up) vs spend (bar down), with the green line tracking the total float (cash + gilt bank).
              {(!useRsu || !useDeferred) && <strong style={{ color: T.amber }}>{!useRsu && !useDeferred ? "RSU vests and deferred cash are EXCLUDED" : !useRsu ? "RSU vests are EXCLUDED" : "Deferred cash is EXCLUDED"} — showing the conservative floor without comp you haven't received. </strong>}
              RSUs assume SELL-ON-VEST at today's price ({inputs.rsuUnpriced > 0 ? `${inputs.rsuUnpriced} unpriced vest(s) excluded — set the ticker's price` : "no price forecasting"}); vested-and-held shares are already inside the portfolio, so they're deliberately not a source here.
              RSU vests and deferred-cash tranches are shown NET of tax — marginal UK income-tax bands + employee NI, taxed jointly per year on top of your plan salary while working ({inputs.compTaxRate > 0 ? `effective ${Math.round(inputs.compTaxRate * 100)}% over the horizon` : "none scheduled"}).
              Dividends are held flat at {gbpK(+forwardDividends || 0)}/yr — trailing 12-month income per unit × units held TODAY (so recent buys raise it above last year's cash received), EXCLUDING gilt coupons (those are already in the ladder), and assumed tax-free (ISA/VCT holdings; GIA dividends would bear dividend tax not modelled here). No growth, and no shrinkage as later sales reduce the portfolio: that circularity is disclosed rather than half-modelled.
              Gilts are conventional only: coupons + redemption at PAR, contractual nominal £ with no indexation — index-linked gilts are not modelled. Deferred cash and gilt cashflows are contractual schedules from their own tabs.
              {cgtOn && ` CGT on sales assumes ${cgtGain}% of each disposal is gain, taxed at 24% above the £3,000 annual exempt amount — a blended-pool estimate, not per-lot matching, and it assumes the sale happens in a GIA (ISA/SIPP disposals are tax-free). "Sold" shows the gross sale needed to net the shortfall.`}
            </Note>
          </div>
        </>
      )}
    </div>
  );
}


function DrawdownTab({ p, det, set }) {
  // Phase 3.1: the comparison now runs through the node-tested optimiser
  // (core/drawdown-optimiser.mjs) — 5 strategies × 2 tax-free-cash modes,
  // ranked survival > lifetime tax > estate. Two upgrades over the old
  // in-component version: TFC mode is part of the search (PCLS-vs-UFPLS
  // often moves more tax than the ordering itself), and the headline
  // saving is vs YOUR CURRENT pick, not vs the worst candidate — "you
  // could save £X" only means something measured from where you stand.
  const opt = useMemo(() => optimiseDrawdown(p), [p]);
  const ranked = opt.candidates;
  const best = opt.best;
  const saving = Math.max(0, opt.taxSaving ?? 0);
  const isCurrent = (c) => opt.current && c.strategy === opt.current.strategy && c.tfcMode === opt.current.tfcMode;
  const isBest = (c) => c.strategy === best.strategy && c.tfcMode === best.tfcMode;

  // source mix over time for the current strategy
  const mix = det.timeline
    .filter((d) => d.phase === "decum")
    .map((d) => ({
      age: d.age,
      pension: d.pensionDrawReal || 0,
      bridge: d.bridgeDrawReal || 0,
      state: d.stateReal || 0,
      db: d.dbReal || 0,
      annuity: d.annuityReal || 0,
      btl: d.btlNetReal || 0,
    }));

  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <Layers size={17} color={T.green} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Drawdown sequencing optimiser</h3>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: T.muted }}>
          The order you tap pension, ISA, GIA and LISA — and whether you take tax-free cash up front (PCLS) or 25% of each withdrawal (UFPLS) — barely changes how long the money lasts, but changes lifetime <strong>tax</strong> a lot. All {ranked.length} combinations, run on your exact plan.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 12 }}>
          <Card style={{ background: T.greenSoft, border: "none" }}>
            <Stat label="Best combination" value={best.label} sub={`${TFC_LABELS[best.tfcMode]} · ${gbp(best.lifetimeTaxReal)} lifetime tax (today's £)`} tone="green" />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Switching saves you" value={gbp(saving)} sub="lifetime tax vs your current pick" tone={saving > 1000 ? "green" : "ink"} />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Your current choice" value={STRATEGY_LABELS[p.drawStrategy]} sub={opt.alreadyOptimal ? `${TFC_LABELS[p.tfcMode || "ufpls"]} — already optimal ✓` : TFC_LABELS[p.tfcMode || "ufpls"]} tone={opt.alreadyOptimal ? "green" : "amber"} />
          </Card>
        </div>
        {!opt.alreadyOptimal && (
          <button
            onClick={() => { set("drawStrategy", best.strategy); set("tfcMode", best.tfcMode); }}
            style={{ marginTop: 12, background: T.ink, color: T.paper, border: "none", borderRadius: 9, padding: "9px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
          >
            Adopt "{best.label}" with {best.tfcMode.toUpperCase()} — save {gbp(saving)}
          </button>
        )}
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: T.lineSoft }}>
              {["Strategy", "Tax-free cash", "Lifetime tax", "Money lasts to", "Estate left"].map((h, i) => (
                <th key={h} style={{ textAlign: i <= 1 ? "left" : "right", padding: "11px 16px", fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: T.muted, fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.strategy + r.tfcMode} style={{ borderTop: `1px solid ${T.line}`, background: isCurrent(r) ? T.greenSoft : "transparent" }}>
                <td style={{ padding: "12px 16px", fontWeight: 600 }}>
                  {r.label}
                  {isBest(r) && <span style={{ marginLeft: 8, fontSize: 10.5, color: T.green, fontWeight: 700 }}>BEST</span>}
                  {isCurrent(r) && <span style={{ marginLeft: 8, fontSize: 10.5, color: T.muted }}>(current)</span>}
                </td>
                <td style={{ padding: "12px 16px", color: T.ink2 }}>{r.tfcMode.toUpperCase()}</td>
                <td style={cellMono}>{gbp(r.lifetimeTaxReal)}</td>
                <td style={{ ...cellMono, color: r.depletionAge === null ? T.green : T.amber }}>{r.depletionAge === null ? `${p.planAge}+` : `age ${r.depletionAge}`}</td>
                <td style={cellMono}>{gbpK(r.estateReal)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      {p.postAccessContrib > 0 && (
        <Card style={{ marginTop: 14, borderColor: det.mpaaBreachAge ? T.amber : undefined }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
            <ShieldAlert size={17} color={det.mpaaBreachAge ? T.amber : T.ink2} />
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>MPAA — money purchase annual allowance</h3>
          </div>
          {det.mpaaTriggered ? (
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: T.ink2, lineHeight: 1.5 }}>
              Taking pension income (rather than tax-free cash alone) triggers MPAA — under this plan, that happens at age <strong>{det.mpaaTriggerAge}</strong>. From then on, DC contributions are capped at <strong>{gbp(det.mpaaLimit)}/yr</strong> regardless of the standard annual allowance.
              {det.mpaaBreachAge
                ? ` Your continued contribution of ${gbp(p.postAccessContrib)}/yr exceeds that cap from age ${det.mpaaBreachAge} — the excess (${gbp(det.mpaaExcessTotal)} over the plan) would typically face an annual allowance tax charge. Consider reducing contributions once income drawdown starts, or taking PCLS only (no income) until they stop.`
                : ` Your continued contribution of ${gbp(p.postAccessContrib)}/yr stays within that cap.`}
            </p>
          ) : (
            <p style={{ margin: "8px 0 0", fontSize: 12.5, color: T.muted, lineHeight: 1.5 }}>
              No year in this plan draws pension income under "{STRATEGY_LABELS[p.drawStrategy]}" — {p.tfcMode === "pcls" ? "the upfront lump sum alone doesn't trigger MPAA" : "check the other strategies above, since ordering affects when the pension is first tapped"}, so your {gbp(p.postAccessContrib)}/yr continued contribution stays under the standard annual allowance throughout.
            </p>
          )}
        </Card>
      )}

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Income mix under "{STRATEGY_LABELS[p.drawStrategy]}"</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Which sources fund each year (real terms), under your currently selected order.
        </p>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={mix} margin={{ top: 10, right: 8, left: 8, bottom: 0 }} barCategoryGap={1}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), { pension: "Pension", bridge: "ISA/GIA/LISA", state: "State Pension", db: "DB pension", annuity: "Annuity", btl: "BTL net rent" }[n]]} labelFormatter={(a) => `Age ${a}`} />
            <Bar dataKey="bridge" stackId="a" fill={T.gold} name="bridge" />
            <Bar dataKey="pension" stackId="a" fill={T.green} name="pension" />
            <Bar dataKey="annuity" stackId="a" fill="#7A5C9E" name="annuity" />
            {det.btlEnabled && <Bar dataKey="btl" stackId="a" fill="#B0884E" name="btl" />}
            <Bar dataKey="db" stackId="a" fill={T.ink2} name="db" />
            <Bar dataKey="state" stackId="a" fill={T.blue} name="state" />
          </BarChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.gold, t: "ISA/GIA/LISA" }, { c: T.green, t: "Pension" }, { c: "#7A5C9E", t: "Annuity" }, ...(det.btlEnabled ? [{ c: "#B0884E", t: "BTL rent" }] : []), { c: T.ink2, t: "DB" }, { c: T.blue, t: "State" }]} />
      </Card>

      <Note tone="blue">
        Depletion age is usually similar across strategies because total spending is the same — the prize is tax efficiency and what's left for your estate. "Pension first" can be smart given pensions become subject to inheritance tax from April 2027; "Tax-free first" preserves the pension but wastes your personal allowance. There's no universally correct answer, which is why this compares them on your numbers.
      </Note>
    </div>
  );
}

/* ---- Buy-to-let tab ---- */

function SequenceHeatmap({ p, det }) {
  const hm = useMemo(() => sequenceHeatmap(p, det), [p, det]);
  if (!hm.summary) return null;
  const s = hm.summary;
  const cellStyle = (w) => {
    if (w.lasts) return { background: T.green, opacity: w.partial ? 0.45 : 0.9 };
    const short = p.retireAge + s.horizonYears - w.depletion; // years short
    const bad = Math.min(1, short / s.horizonYears);
    return { background: bad > 0.4 ? T.red : T.amber, opacity: w.partial ? 0.45 : 0.55 + 0.45 * bad };
  };
  const decades = [];
  for (const w of hm.windows) {
    const d = Math.floor(w.startYear / 10) * 10;
    (decades[decades.length - 1]?.d === d ? decades[decades.length - 1].cells : decades[decades.push({ d, cells: [] }) - 1].cells).push(w);
  }
  return (
    <Card style={{ marginTop: 14 }}>
      <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Every retirement start since {hm.windows[0].startYear} — the sequence-risk heatmap</h3>
      <p style={{ margin: "0 0 10px", fontSize: 12.5, color: T.muted, maxWidth: 680 }}>
        Your exact withdrawal schedule ({s.horizonYears} years, fee-adjusted) replayed against every rolling window of real history. Survived <strong>{s.fullWindows - s.failures} of {s.fullWindows}</strong> full windows ({pct(s.successRate, 0)}){s.failures > 0 ? <> — worst start <strong>{s.worstStart}</strong>, money gone at age <strong>{s.worstDepletionAge}</strong></> : " — no historical start defeats this plan"}.
      </p>
      <div style={{ display: "grid", gap: 4 }}>
        {decades.map(({ d, cells }) => (
          <div key={d} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ width: 42, fontSize: 11, color: T.muted, fontFamily: MONO }}>{d}s</span>
            {cells.map((w) => (
              <div key={w.startYear} title={`Start ${w.startYear}${w.partial ? ` (${w.histYears} historical yrs, rest assumed)` : ""}: ${w.lasts ? `lasts — ${gbpK(w.finalReal)} left (real)` : `money gone at age ${w.depletion}`}`}
                style={{ width: 20, height: 20, borderRadius: 4, cursor: "default", border: w.partial ? `1px dashed ${T.muted}` : "none", ...cellStyle(w) }} />
            ))}
          </div>
        ))}
      </div>
      <Legendlet items={[{ c: T.green, t: "Lasts the full plan" }, { c: T.amber, t: "Depleted late" }, { c: T.red, t: "Depleted early" }, { c: T.muted, t: "Dashed: partial window (assumption tail)", dash: true }]} />
      <p style={{ margin: "10px 0 0", fontSize: 11.5, color: T.muted, maxWidth: 680 }}>
        Series: S&amp;P 500 total returns + US CPI, 1926–2025 (transcribed from slickcharts.com, 2026 — see core/market-history.mjs). US data, 100% equity, no bond damping: absolute rates are indicative for a GBP investor, the ORDERING of good and bad start years is the point. Withdrawals inflate with each window's actual inflation — the 1966 cell is red because prices tripled, not just because markets fell.
      </p>
    </Card>
  );
}

function StressTab({ p, det, results }) {
  const chartData = results.map((r) => ({ label: r.label, potReal: r.potReal, income: r.incomeToday }));
  return (
    <div>
      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Scenario comparison</h3>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: T.muted }}>
          The same plan run through six market environments — including historical regimes — to test how sensitive your outcome is to growth and inflation.
        </p>
        <ResponsiveContainer width="100%" height={260}>
          <BarChart data={chartData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="label" tick={{ fontSize: 10.5, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={0} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v) => [gbpK(v), "Wealth at retirement (real)"]} />
            <Bar dataKey="potReal" radius={[5, 5, 0, 0]}>
              {results.map((r, i) => (
                <Cell key={i} fill={r.lasts ? T.green : r.key === "base" ? T.ink : T.amber} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card style={{ marginTop: 14, padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: T.lineSoft }}>
              {["Scenario", "Wealth at retirement", "Net income (today)", "Replacement", "Money lasts to"].map((h, i) => (
                <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "11px 16px", fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: T.muted, fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.map((r) => (
              <tr key={r.key} style={{ borderTop: `1px solid ${T.line}` }}>
                <td style={{ padding: "12px 16px" }}>
                  <div style={{ fontWeight: 600 }}>{r.label}</div>
                  <div style={{ fontSize: 11.5, color: T.muted }}>{r.note}</div>
                </td>
                <td style={cellMono}>{gbpK(r.potReal)}</td>
                <td style={cellMono}>{gbp(r.incomeToday)}</td>
                <td style={cellMono}>{pct(r.replacement, 0)}</td>
                <td style={{ ...cellMono, color: r.lasts ? T.green : T.red, fontWeight: 700 }}>
                  {r.lasts ? `${p.planAge}+` : `age ${r.depletionAge}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

      <Note tone="amber">
        <strong>Sequence-of-returns risk:</strong> a crash in the first few years of retirement is far more damaging than the same crash later, because you're selling units to fund income while prices are low. The "1970s stagflation" and "Lost decade" rows approximate that danger — note how the depletion age can move sharply even when average returns look acceptable.
      </Note>

      <HistoricalReplay p={p} det={det} />
      <SequenceHeatmap p={p} det={det} />
    </div>
  );
}

function HistoricalReplay({ p, det }) {
  const [key, setKey] = useState("gfc2008");
  const [offset, setOffset] = useState(0);
  const replay = replayDecum(p, det, key, offset);
  // base real path (no crash) aligned by age
  const baseDecum = det.timeline.filter((d) => d.phase === "decum");
  const merged = baseDecum.map((d, i) => ({
    age: d.age,
    base: d.potReal,
    replay: replay.path[i] ? replay.path[i].real : 0,
  }));
  const baseDepletes = det.depletionAge;
  // Aggregate across EVERY offset of every sequence (30 historical entry
  // points, not just the 3 the picker below lets you view one at a time) —
  // the picker is for "show me 2008 specifically"; this is "how exposed is
  // this plan to sequence risk overall".
  const rolling = useMemo(() => rollingStressTest(p, det), [p, det]);
  return (
    <Card style={{ marginTop: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 10, marginBottom: 10 }}>
        <div>
          <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Replay a historical crash on your plan</h3>
          <p style={{ margin: 0, fontSize: 12.5, color: T.muted, maxWidth: 520 }}>
            Splices an actual market sequence into your retirement, keeping your spending plan fixed — the purest test of sequence risk.
          </p>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 12, marginBottom: 14 }}>
        <Card style={{ background: rolling.survivalRate >= 0.85 ? T.greenSoft : rolling.survivalRate >= 0.6 ? T.amberSoft : T.redSoft, border: "none" }}>
          <Stat label="Survives across all 30 entry points" value={pct(rolling.survivalRate, 0)} sub="every offset of 2008 / dot-com / 1970s" tone={rolling.survivalRate >= 0.85 ? "green" : rolling.survivalRate >= 0.6 ? "amber" : "red"} />
        </Card>
        <Card style={{ background: T.paper, border: "none" }}>
          <Stat label="Worst-case depletion" value={rolling.worstDepletionAge ? `age ${rolling.worstDepletionAge}` : "never"} sub={rolling.worstCase ? `${rolling.worstCase.label}, hitting ${rolling.worstCase.offset === 0 ? "at retirement" : `+${rolling.worstCase.offset}yr`}` : "no failing entry point"} tone={rolling.worstDepletionAge ? "red" : "green"} />
        </Card>
        {Object.entries(rolling.bySequence).map(([k, s]) => (
          <Card key={k} style={{ background: T.paper, border: "none" }}>
            <Stat label={s.label} value={pct(s.survivalRate, 0)} sub={s.worstDepletion ? `worst: age ${s.worstDepletion}` : "survives every entry point"} tone={s.survivalRate === 1 ? "green" : s.survivalRate >= 0.5 ? "amber" : "red"} />
          </Card>
        ))}
      </div>

      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        <Segmented
          ariaLabel="Historical crash scenario"
          value={key}
          onChange={setKey}
          accent={T.red}
          options={[
            { value: "gfc2008", label: "2008 crash" },
            { value: "dotcom2000", label: "Dot-com" },
            { value: "oil1973", label: "1970s" },
          ]}
        />
        <Segmented
          ariaLabel="When the crash hits"
          value={String(offset)}
          onChange={(v) => setOffset(parseInt(v))}
          options={[
            { value: "0", label: "Hits at retirement" },
            { value: "5", label: "+5 years" },
            { value: "10", label: "+10 years" },
          ]}
        />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12, marginBottom: 12 }}>
        <Stat label="Base plan lasts to" value={baseDepletes ? `age ${baseDepletes}` : `${p.planAge}+`} tone={baseDepletes ? "amber" : "green"} />
        <Stat label={`With ${replay.label}`} value={replay.depletion ? `age ${replay.depletion}` : `${p.planAge}+`} tone={replay.depletion ? "red" : "green"} />
        <Stat label="Years of runway lost" value={replay.depletion ? `${Math.max(0, (baseDepletes || p.planAge) - replay.depletion)} yrs` : "none"} tone={replay.depletion && (baseDepletes || p.planAge) - replay.depletion > 0 ? "red" : "green"} />
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <ComposedChart data={merged} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
          <CartesianGrid stroke={T.lineSoft} vertical={false} />
          <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
          <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
          <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), n === "base" ? "Base plan" : "With crash"]} labelFormatter={(a) => `Age ${a}`} />
          {replay.depletion && <ReferenceLine x={replay.depletion} stroke={T.red} strokeDasharray="4 3" />}
          <Area type="monotone" dataKey="base" stroke={T.green} strokeWidth={1.6} fill={T.greenSoft} name="base" />
          <Line type="monotone" dataKey="replay" stroke={T.red} strokeWidth={2.2} dot={false} name="replay" />
        </ComposedChart>
      </ResponsiveContainer>
      <Legendlet items={[{ c: T.green, t: "Base plan (real)" }, { c: T.red, t: "With historical crash" }]} />
      <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
        Sequences are illustrative annual portfolio returns and inflation for each era. The same crash does far less damage when it lands 10 years into retirement than on day one.
      </div>
    </Card>
  );
}
const cellMono = { padding: "12px 16px", textAlign: "right", fontFamily: MONO, fontVariantNumeric: "tabular-nums" };

/* ---- Adequacy / Monte Carlo tab ---- */
// Merges two fan-chart arrays (base "A" run + an optional "B" comparison
// scenario run) into one age-keyed row set for a single overlaid chart —
// scenarios with a different total year count (a different retire/plan
// age changes how many years get simulated) just leave the missing side's
// keys undefined past where it ends, which recharts skips over cleanly.
function mergeFans(fanA, fanB) {
  const byAge = new Map();
  for (const row of fanA) byAge.set(row.age, { age: row.age, aP10: row.p10, aP50: row.p50, aP90: row.p90 });
  for (const row of fanB || []) {
    const existing = byAge.get(row.age) || { age: row.age };
    byAge.set(row.age, { ...existing, bP10: row.p10, bP50: row.p50, bP90: row.p90 });
  }
  return [...byAge.values()].sort((x, y) => x.age - y.age);
}


function AdequacyTab({ p, mc, mcB, progress = 0, compareKey = "none", setCompareKey, running, runMC, det, life, set, savedScenarios = [] }) {
  const planShort = p.planAge < life.q25; // planning shorter than 1-in-4 longevity
  const compareOptions = [
    { value: "none", label: "None" },
    ...SCENARIOS.filter((s) => s.key !== "base").map((s) => ({ value: s.key, label: s.label })),
    // Saved plans from the scenario library — compared on the same common
    // random numbers as the preset tweaks.
    ...savedScenarios.map((s) => ({ value: `sc:${s.id}`, label: s.name })),
  ];
  const compareLabel = compareOptions.find((o) => o.value === compareKey)?.label || "comparison";
  const mergedFan = useMemo(() => mergeFans(mc ? mc.fan : [], mcB ? mcB.fan : []), [mc, mcB]);

  // Safe withdrawal rate + Guyton-Klinger — both cheap enough (a few hundred
  // thousand simulated steps, sub-100ms) to compute synchronously on every
  // render, unlike the 1,000-run headline Monte Carlo above which needs the
  // Web Worker. Both intentionally look at the PORTFOLIO in isolation
  // (starting pot at retirement, growth/vol/inflation assumptions) rather
  // than this plan's specific state-pension/DB/BTL/spend-profile mix — see
  // swr.mjs's header for why that's a deliberate, different question than
  // the plan-specific Monte Carlo success rate above.
  const decYears = Math.max(1, p.planAge - p.retireAge);
  const swr = useMemo(
    () => solveSWR({
      startWealth: det.wealthAtRetire, years: decYears,
      growthPost: p.growthPost, vol: p.vol, inflation: p.inflation, fee: p.fee,
      targetSuccess: 0.9, runs: 300, seed: 42,
    }),
    [det.wealthAtRetire, decYears, p.growthPost, p.vol, p.inflation, p.fee]
  );
  const impliedRate = det.wealthAtRetire > 0 ? (det.firstYearPensionDraw + det.firstYearBridgeDraw) / det.wealthAtRetire : 0;
  const gk = useMemo(
    () => runGuytonKlinger({
      startWealth: det.wealthAtRetire, years: decYears, initialRate: impliedRate > 0 ? impliedRate : 0.04,
      growthPost: p.growthPost, vol: p.vol, inflation: p.inflation, runs: 300, seed: 42,
    }),
    [det.wealthAtRetire, decYears, impliedRate, p.growthPost, p.vol, p.inflation]
  );
  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <HeartPulse size={17} color={T.red} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Longevity benchmark</h3>
        </div>
        <p style={{ margin: "0 0 14px", fontSize: 12.5, color: T.muted }}>
          ONS-style cohort life expectancy for a {p.currentAge}-year-old {p.sex}{p.healthy ? ", adjusted for a healthy/affluent profile" : ""}. The real risk is outliving your money — so plan to the tail, not the average.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12 }}>
          <Card style={{ background: T.paper, border: "none" }}><Stat label="Median lifespan" value={`age ${life.mean}`} sub="50% live beyond this" /></Card>
          <Card style={{ background: T.paper, border: "none" }}><Stat label="1 in 4 reach" value={`age ${life.q25}`} sub="25% chance" tone="amber" /></Card>
          <Card style={{ background: T.paper, border: "none" }}><Stat label="1 in 10 reach" value={`age ${life.q10}`} sub="10% chance" tone="red" /></Card>
          <Card style={{ background: T.paper, border: "none" }}><Stat label="Your plan age" value={`age ${p.planAge}`} sub={planShort ? "below 1-in-4 age" : "covers the tail"} tone={planShort ? "amber" : "green"} /></Card>
        </div>
        {planShort && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
            <span style={{ fontSize: 13, color: T.ink2 }}>
              You're planning to {p.planAge}, but you have a 1-in-4 chance of reaching {life.q25}. Underplanning longevity is the most common adequacy mistake.
            </span>
            <button
              onClick={() => set("planAge", life.q10)}
              style={{ background: T.ink, color: T.paper, border: "none", borderRadius: 9, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer", whiteSpace: "nowrap" }}
            >
              Plan to age {life.q10}
            </button>
          </div>
        )}
      </Card>

      <Card>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div>
            <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Monte Carlo stress test</h3>
            <p style={{ margin: 0, fontSize: 12.5, color: T.muted, maxWidth: 560 }}>
              Runs 1,000 randomised market paths (volatility {p.vol}%) against your fixed spending plan in a background Web Worker (doesn't freeze the page), then measures how often the pot survives to age {p.planAge}.
            </p>
          </div>
          <button
            onClick={runMC}
            disabled={running}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              background: T.ink, color: T.paper, border: "none", borderRadius: 10,
              padding: "11px 18px", fontWeight: 600, fontSize: 14, cursor: running ? "wait" : "pointer",
            }}
          >
            <RefreshCw size={15} style={{ animation: running ? "spin 1s linear infinite" : "none" }} />
            {running ? `Running… ${Math.round(progress * 100)}%` : mc ? "Re-run" : "Run simulation"}
          </button>
        </div>
        <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        {/* Return model (Phase 2.7) */}
        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.line}` }}>
          <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600, marginBottom: 6 }}>Return model</div>
          <Segmented ariaLabel="Return model" value={p.mcModel || "single"} onChange={(v) => set("mcModel", v)} accent={T.green}
            options={[
              { value: "single", label: "Simple" },
              { value: "twoAsset", label: "Equity + bonds" },
              { value: "bootstrap", label: "Historical bootstrap" },
            ]} />
          <p style={{ margin: "6px 0 0", fontSize: 11.5, color: T.muted, maxWidth: 640 }}>
            {(p.mcModel || "single") === "single" && `One blended asset at your growth/volatility sliders, fixed ${effInflation(p)}% inflation — the original model.`}
            {p.mcModel === "twoAsset" && `Correlated equity (${TWO_ASSET_DEFAULTS.equityMean}%/${TWO_ASSET_DEFAULTS.equityVol}%) and bonds (${TWO_ASSET_DEFAULTS.bondMean}%/${TWO_ASSET_DEFAULTS.bondVol}%, ρ=${TWO_ASSET_DEFAULTS.correlation}), derisking along your glidepath through retirement. Your growth sliders are ignored in this mode — the mix drives the return.`}
            {p.mcModel === "bootstrap" && "Resamples (return, inflation) YEAR-PAIRS from the app's historical stress sequences (2008 GFC, 1970s stagflation, 2000s lost decade) — fat tails and inflation shocks arrive together, as they did. Small pool by design: it tests \"years like these, reshuffled\", not all of market history."}
          </p>
          {p.mcModel === "twoAsset" && (
            <div style={{ display: "flex", gap: 16, marginTop: 8, flexWrap: "wrap", alignItems: "center" }}>
              <Field label="Equity % at retirement" value={p.mcEqStart ?? 60} min={0} max={100} step={5} suffix="%" onChange={(v) => set("mcEqStart", v)} />
              <Field label="Equity % at plan end" value={p.mcEqEnd ?? 40} min={0} max={100} step={5} suffix="%" onChange={(v) => set("mcEqEnd", v)} />
            </div>
          )}
          {p.mcModel !== "bootstrap" && (
            <div style={{ marginTop: 8 }}>
              <Toggle label={`Stochastic inflation (AR(1) around ${effInflation(p)}%) — withdrawals re-price along each simulated path`} checked={!!p.mcStochInfl} onChange={(v) => set("mcStochInfl", v)} />
            </div>
          )}
        </div>

        <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.line}` }}>
          <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600, marginBottom: 6 }}>Compare against (Scenario A/B)</div>
          <Segmented ariaLabel="Compare against scenario" value={compareKey} onChange={setCompareKey} options={compareOptions} accent={T.blue} />
          <p style={{ margin: "6px 0 0", fontSize: 11.5, color: T.muted }}>
            {compareKey === "none"
              ? "Runs your base plan alone. Pick a scenario to run it alongside your base plan, on the SAME random market paths, so any difference in outcome reflects the parameter change, not luck."
              : `Runs your base plan (A) and "${compareLabel}" (B) on identical random draws — the reported difference isolates what changing to "${compareLabel}" actually does to your outcome.`}
          </p>
        </div>
      </Card>

      {!mc && !running && (
        <div style={{ textAlign: "center", padding: "50px 20px", color: T.muted }}>
          <Activity size={34} color={T.line} />
          <p style={{ marginTop: 12, fontSize: 14 }}>Run the simulation to see your probability of success and the range of outcomes.</p>
        </div>
      )}

      {mc && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12, marginTop: 14 }}>
            <Card style={{ background: mc.successRate >= 0.85 ? T.greenSoft : mc.successRate >= 0.65 ? T.amberSoft : T.redSoft, border: "none" }}>
              <Stat big label={mcB ? "Success probability (A: base)" : "Success probability"} value={pct(mc.successRate, 0)} sub={`pot survives to ${p.planAge} in ${Math.round(mc.successRate * mc.runs)} of ${mc.runs} runs`} tone={mc.successRate >= 0.85 ? "green" : mc.successRate >= 0.65 ? "amber" : "red"} />
            </Card>
            <Card><Stat label="Median wealth at retirement" value={gbpK(mc.medianRetire)} sub="nominal, pension + ISA" /></Card>
            <Card><Stat label="Unlucky case (10th %ile)" value={gbpK(mc.p10Retire)} sub="1-in-10 downside" tone="amber" /></Card>
            <Card><Stat label="Lucky case (90th %ile)" value={gbpK(mc.p90Retire)} sub="1-in-10 upside" tone="green" /></Card>
          </div>

          {mcB && (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12, marginTop: 12 }}>
              <Card style={{ background: mcB.successRate >= 0.85 ? T.greenSoft : mcB.successRate >= 0.65 ? T.amberSoft : T.redSoft, border: `1px solid ${T.blue}` }}>
                <Stat big label={`Success probability (B: ${compareLabel})`} value={pct(mcB.successRate, 0)} sub={`pot survives to ${p.planAge} in ${Math.round(mcB.successRate * mcB.runs)} of ${mcB.runs} runs`} tone={mcB.successRate >= 0.85 ? "green" : mcB.successRate >= 0.65 ? "amber" : "red"} />
              </Card>
              <Card style={{ border: `1px solid ${T.blue}` }}><Stat label="Median wealth at retirement (B)" value={gbpK(mcB.medianRetire)} sub="nominal, pension + ISA" /></Card>
              <Card style={{ border: `1px solid ${T.blue}` }}>
                <Stat label="Δ success rate (B − A)" value={`${mcB.successRate >= mc.successRate ? "+" : ""}${Math.round((mcB.successRate - mc.successRate) * 100)}pp`} sub={`${compareLabel} vs. your base plan`} tone={mcB.successRate >= mc.successRate ? "green" : "red"} />
              </Card>
              <Card style={{ border: `1px solid ${T.blue}` }}>
                <Stat label="Δ median wealth (B − A)" value={gbpK(mcB.medianRetire - mc.medianRetire)} sub={`${compareLabel} vs. your base plan`} tone={mcB.medianRetire >= mc.medianRetire ? "green" : "red"} />
              </Card>
            </div>
          )}

          <Card style={{ marginTop: 14 }}>
            <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Range of outcomes (real terms)</h3>
            <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
              Shaded band spans the unlucky (10th) to lucky (90th) percentile; the line is the median path.{mcB ? ` Dashed blue is "${compareLabel}" (B) for comparison.` : ""}
            </p>
            <ResponsiveContainer width="100%" height={320}>
              <ComposedChart data={mergedFan} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id="fan" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={T.green} stopOpacity={0.18} />
                    <stop offset="100%" stopColor={T.green} stopOpacity={0.03} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={T.lineSoft} vertical={false} />
                <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={4} />
                <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
                <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbpK(v), { aP90: "Lucky (90th, A)", aP50: "Median (A)", aP10: "Unlucky (10th, A)", bP90: "Lucky (90th, B)", bP50: "Median (B)", bP10: "Unlucky (10th, B)" }[n] || n]} labelFormatter={(a) => `Age ${a}`} />
                <ReferenceLine x={p.retireAge} stroke={T.amber} strokeDasharray="4 3" />
                <Area type="monotone" dataKey="aP90" stroke="none" fill="url(#fan)" />
                <Area type="monotone" dataKey="aP10" stroke="none" fill={T.surface} />
                <Line type="monotone" dataKey="aP50" stroke={T.green} strokeWidth={2.4} dot={false} />
                <Line type="monotone" dataKey="aP10" stroke={T.amber} strokeWidth={1} strokeDasharray="3 3" dot={false} />
                <Line type="monotone" dataKey="aP90" stroke={T.green} strokeWidth={1} strokeDasharray="3 3" dot={false} />
                {mcB && <Line type="monotone" dataKey="bP50" stroke={T.blue} strokeWidth={2.2} strokeDasharray="5 3" dot={false} />}
                {mcB && <Line type="monotone" dataKey="bP10" stroke={T.blue} strokeWidth={1} strokeDasharray="2 2" dot={false} />}
                {mcB && <Line type="monotone" dataKey="bP90" stroke={T.blue} strokeWidth={1} strokeDasharray="2 2" dot={false} />}
              </ComposedChart>
            </ResponsiveContainer>
            <Legendlet items={[{ c: T.green, t: "Median outcome (A)" }, { c: T.amber, t: "Unlucky / lucky bounds (A)", dash: true }, ...(mcB ? [{ c: T.blue, t: `Median (B: ${compareLabel})`, dash: true }] : [])]} />
          </Card>

          <Note tone={mc.successRate >= 0.85 ? "blue" : "amber"}>
            A success rate above ~85% is often treated as a comfortable plan; 65–85% suggests building in flexibility (variable spending, working longer, or a cash buffer); below 65% the plan likely needs a higher pot or lower target. Each re-run draws fresh randomness, so the figure will wobble a few points — that variability is itself the point (A/B comparisons above use the same random draws for both sides specifically to cancel out that wobble when judging the parameter change itself).
          </Note>
        </>
      )}

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Safe withdrawal rate (textbook cross-check)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted, maxWidth: 620 }}>
          A different question to the Monte Carlo above: ignoring state pension, DB income, BTL and your spend profile — just this pot, growing at your assumed {p.growthPost}%/{p.vol}% return/volatility — what flat, inflation-adjusted % has a 90% chance of lasting {decYears} years?
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12 }}>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Max sustainable rate (90% confidence)" value={pct(swr.rate, 1)} sub={`≈ ${gbp(swr.annualAmount)}/yr on ${gbpK(det.wealthAtRetire)} at retirement`} tone="green" />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Your plan's initial rate" value={pct(impliedRate, 1)} sub="pension + bridge draw, year 1 of retirement" tone={impliedRate <= swr.rate ? "green" : "amber"} />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label={impliedRate <= swr.rate ? "Headroom vs. textbook rate" : "Over the textbook rate by"} value={pct(Math.abs(swr.rate - impliedRate), 1)} sub={impliedRate <= swr.rate ? "your plan draws more conservatively" : "worth checking Monte Carlo above holds up"} tone={impliedRate <= swr.rate ? "green" : "amber"} />
          </Card>
        </div>
        {swr.atCeiling && <p style={{ margin: "10px 0 0", fontSize: 11.5, color: T.muted }}>Even the top of the search range (12%/yr) still clears 90% confidence — an unusually strong return/vol assumption, or a very short {decYears}-year horizon.</p>}
        {swr.atFloor && <p style={{ margin: "10px 0 0", fontSize: 11.5, color: T.amber }}>Even the bottom of the search range (0.5%/yr) can't clear 90% confidence at these assumptions — check your growth/volatility inputs.</p>}
      </Card>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Guyton-Klinger dynamic guardrails</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted, maxWidth: 620 }}>
          Same starting pot and initial rate as your plan (year-1 pension + bridge draw, {pct(impliedRate, 1)}), but instead of a fixed inflation-linked withdrawal every year, spending is cut 10% after a bad run pushes the withdrawal rate 20% above where it started, raised 10% after a good run pushes it 20% below, and skips that year's inflation rise after any losing year. Compared against a rigid fixed-real withdrawal at the identical rate, on the identical random market paths.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12 }}>
          <Card style={{ background: gk.successDelta > 0.001 ? T.greenSoft : T.paper, border: "none" }}>
            <Stat label="Success rate, with guardrails" value={pct(gk.successRate, 0)} sub={`vs ${pct(gk.fixedSuccessRate, 0)} fixed-real at the same rate`} tone={gk.successDelta > 0.001 ? "green" : "ink"} />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Avg. spending cuts" value={gk.avgCutsPerPath.toFixed(1)} sub={`per ${decYears}-year retirement, across ${gk.runs} runs`} tone="amber" />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Avg. spending raises" value={gk.avgRaisesPerPath.toFixed(1)} sub={`per ${decYears}-year retirement`} tone="green" />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Median final wealth" value={gbpK(gk.medianFinalWealth)} sub="real terms, guardrails path" />
          </Card>
        </div>
        <p style={{ margin: "10px 0 0", fontSize: 11.5, color: T.muted, lineHeight: 1.5 }}>
          The trade-off guardrails make explicit: a {gk.successDelta > 0 ? `${Math.round(gk.successDelta * 100)}pp higher` : "similar"} success rate comes at the cost of {gk.avgCutsPerPath >= 1 ? "occasionally living on less than planned" : "rarely needing to flex"} — this doesn't model the 4th "portfolio management" GK rule (asset-allocation shifts after guardrail triggers), which this app has no dynamic-allocation engine to represent.
        </p>
      </Card>
    </div>
  );
}

/* ---- Inheritance tax tab ---- */
// Two snapshots through the SAME `projectIHT()` engine (core/iht.mjs): your
// estate as it stands TODAY (from the live portfolio, pensions excluded
// since that's before the April 2027 rule change), and your estate at the
// END of this plan (from `det`'s final timeline row, decades from now —
// pensions almost certainly included by then). Gifts you log below age
// naturally between the two snapshots since each just passes a different
// `asOfDate` into the same taper-relief maths.

export { FloorTab, RunoffTab, DrawdownTab, SequenceHeatmap, StressTab, HistoricalReplay, AdequacyTab, mergeFans };
