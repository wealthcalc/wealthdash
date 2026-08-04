/* ======================================================================
   PLAN — the retirement model's shell: inputs, scenario switching, and the
   sub-tab router. The sub-tabs themselves live in ./plan/* since this file
   passed 2,900 lines and became the one place a change felt risky:

     plan/theme.js            design tokens + £/% formatters
     plan/controls.jsx        Card, Stat, Field, Segmented, Toggle, …
     plan/scenarios.jsx       DEFAULTS, SCENARIOS, applyScenario, editors
     plan/AccumulationTabs    building the pot / drawing it down
     plan/ResilienceTabs      floor, run-off, drawdown, stress, Monte Carlo
     plan/EstateTabs          buy-to-let, inheritance tax

   The split is presentational only — every component is the same code it
   was, and the inputs still live in the app's Zustand store (`planInputs`/
   `setPlanInputs` props), not local state, so the app-wide backup/restore
   and durable mirror cover them without this tab needing its own Save/Load.
   ====================================================================== */
import React, { useMemo, useState, useCallback } from "react";
import {
  ResponsiveContainer, ComposedChart, AreaChart, LineChart, BarChart,
  Area, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";
import { useMonteCarloWorker } from "../ui/useMonteCarloWorker.js";
import {
  Settings2, TrendingUp, TrendingDown, ShieldAlert, Activity,
  Gauge, ChevronDown, ChevronUp, Info, RefreshCw, Building2, Coins, HeartPulse,
  Layers, Landmark, Plus, Trash2, Umbrella, Droplets,
} from "lucide-react";
import { taxRUK, taxScot, employeeNI, netEmploymentIncome } from "../core/uk-income-tax.mjs";
import {
  lifeExpectancy, effInflation, btlYearly, replayDecum, STRATEGY_LABELS, buildProjection, HIST,
} from "../core/drawdown.mjs";
import { bootstrapPairs, TWO_ASSET_DEFAULTS } from "../core/monte-carlo.mjs";
import { solveSWR } from "../core/swr.mjs";
import { projectIHT, pensionsInEstate, PENSIONS_IN_ESTATE_FROM } from "../core/iht.mjs";
import { effectiveCashByWrapper } from "../core/cash.mjs";
import { planSpendFromBudget, mergedSpend } from "../core/budget.mjs";
import { store, uid, todayISO } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

import { T, THEME_CSS, MONO, SANS, hdrBtn, gbp, gbpK, pct, tooltipStyle } from "./plan/theme.js";
import { Card, Stat, Field, Segmented, Toggle, PANEL_OPEN_DEFAULT, PanelSection, Legendlet, Note, Barline, Row } from "./plan/controls.jsx";
import { mcInputsFromPlan, applyScenario, SCENARIOS, DEFAULTS, ScenarioLibrary, GoalsEditor } from "./plan/scenarios.jsx";
import { AccumulationTab, DecumulationTab, marginalRate } from "./plan/AccumulationTabs.jsx";
import { FloorTab, RunoffTab, DrawdownTab, SequenceHeatmap, StressTab, HistoricalReplay, AdequacyTab, mergeFans } from "./plan/ResilienceTabs.jsx";
import { BtlTab, IhtTab } from "./plan/EstateTabs.jsx";

export default function PlanTab({
  dark = true, planInputs = null, setPlanInputs = null, livePots = null, liveSalary = null, liveOtherNetWorth = null,
  liveEstate = null, giltCashflows = [], forwardDividends = 0,
}) {
  // `planInputs` is null until the user changes something for the first
  // time (nothing to persist yet) — DEFAULTS covers that first render.
  // `setPlanInputs` may be omitted by a caller that hasn't wired the store
  // prop through yet; guard so the tab still renders (read-only) rather than
  // throwing, same defensive pattern as AllowancesTab's setOverrides.
  const p = planInputs || DEFAULTS;
  const set = useCallback((k, v) => setPlanInputs && setPlanInputs((x) => ({ ...(x || DEFAULTS), [k]: v })), [setPlanInputs]);
  // Budget tab actuals — trailing-12m spend and the essential share, which
  // are the two spending numbers this whole plan rests on and which are
  // otherwise typed in from memory. Deliberately only OFFERED (never
  // auto-applied), and only when the underlying data is thick enough to
  // mean something: planSpendFromBudget() returns ready:false with reasons
  // for thin or half-categorised data. See core/budget.mjs.
  const budgetCategories = useAppStore((s) => s.budgetCategories);
  const budgetRules = useAppStore((s) => s.budgetRules);
  const rawSpendTxns = useAppStore((s) => s.spendTxns);
  const recurringExpenses = useAppStore((s) => s.recurringExpenses);
  const budgetSpend = useMemo(() => {
    if (!budgetCategories?.length || !rawSpendTxns?.length) return null;
    const month = todayISO().slice(0, 7);
    const txns = mergedSpend({ spendTxns: rawSpendTxns, rules: budgetRules || [], recurring: recurringExpenses || [], month });
    return planSpendFromBudget({ categories: budgetCategories, txns, month });
  }, [budgetCategories, budgetRules, rawSpendTxns, recurringExpenses]);
  const setP = useCallback((updater) => setPlanInputs && setPlanInputs((x) => (typeof updater === "function" ? updater(x || DEFAULTS) : updater)), [setPlanInputs]);

  // Pull live wrapper totals (holdings + cash) from the wealth dashboard into
  // the plan inputs — one click instead of retyping pot values that the app
  // already knows. Only overwrites the pot/salary fields, nothing else.
  const syncFromPortfolio = useCallback(() => {
    if (!livePots) return;
    setP((x) => ({
      ...x,
      ...(livePots.SIPP != null ? { startPot: Math.round(livePots.SIPP) } : {}),
      ...(livePots.ISA != null ? { isaStart: Math.round(livePots.ISA) } : {}),
      ...(livePots.GIA != null ? { giaStart: Math.round(livePots.GIA) } : {}),
      ...(livePots.LISA != null ? { lisaStart: Math.round(livePots.LISA) } : {}),
      ...(liveSalary != null && liveSalary > 0 ? { salary: Math.round(liveSalary) } : {}),
      // Property equity net of other (non-mortgage) liabilities, from the
      // Property tab — static addendum to the estate, see otherNetWorthStart.
      ...(liveOtherNetWorth != null ? { otherNetWorthStart: Math.round(liveOtherNetWorth) } : {}),
    }));
  }, [setP, livePots, liveSalary, liveOtherNetWorth]);

  // Theme follows the app shell (one toggle for the whole dashboard).
  const theme = dark ? "dark" : "light";

  // Sub-tab persisted under its own key so (a) a reload returns you to the
  // sub-tab you were on, and (b) the ⌘K palette / #/plan/<subtab> deep
  // links can pre-select one by writing the key before switching here
  // (this component remounts on tab switch and reads it in this
  // initialiser — same pattern as CgtSection's cgt.cgtsubtab).
  const VALID_SUBTABS = ["overview", "accum", "decum", "floor", "runoff", "drawdown", "btl", "stress", "adequacy", "iht"];
  const [tab, setTab] = useState(() => {
    const saved = store.get("plan.subtab", "overview");
    return VALID_SUBTABS.includes(saved) ? saved : "overview";
  });
  // Phase 3.6: named scenario library — full planInputs snapshots in the
  // store (persisted, mirrored, synced, in backups via PERSIST_KEYS).
  const scenarios = useAppStore((s) => s.scenarios);
  const setScenarios = useAppStore((s) => s.setScenarios);
  React.useEffect(() => { store.set("plan.subtab", tab); }, [tab]);
  // Persisted, like every PanelSection inside it — collapsing the whole
  // assumptions strip is a deliberate "I'm done tuning, show me results"
  // gesture, and re-opening it on every visit undoes that each time.
  const [panelOpen, setPanelOpen] = useState(() => store.get("plan.assumptionsOpen", true));
  React.useEffect(() => { store.set("plan.assumptionsOpen", panelOpen); }, [panelOpen]);
  const [mc, setMc] = useState(null);
  const [mcB, setMcB] = useState(null);
  const [mcRunning, setMcRunning] = useState(false);
  const [mcProgress, setMcProgress] = useState(0);
  const [mcCompareKey, setMcCompareKey] = useState("none");
  const runMonteCarloAsync = useMonteCarloWorker();

  const det = useMemo(() => buildProjection(p), [p]);
  const feeFree = useMemo(() => buildProjection({ ...p, fee: 0 }), [p]);
  const feeDrag = feeFree.wealthAtRetire - det.wealthAtRetire;
  const life = useMemo(() => lifeExpectancy(p.currentAge, p.sex, p.healthy), [p.currentAge, p.sex, p.healthy]);

  // accessibility / sanity: clamp retireAge
  const validRetire = p.retireAge > p.currentAge && p.retireAge >= p.accessAge - 0;

  const scenarioResults = useMemo(() => {
    return SCENARIOS.map((sc) => {
      const sp = sc.key === "base" ? p : applyScenario(p, sc.key);
      const r = buildProjection(sp);
      return {
        ...sc,
        potReal: r.wealthAtRetireReal,
        incomeToday: r.firstYearNetToday,
        replacement: r.replacementNet,
        depletionAge: r.depletionAge,
        lasts: r.depletionAge === null,
      };
    });
  }, [p]);

  // Runs off the main thread via useMonteCarloWorker() (see workers/
  // monteCarloWorker.js) — the old version ran synchronously, wrapped in a
  // setTimeout(...,30) purely so the "running" spinner had a chance to
  // paint before the computation blocked everything else. A real progress
  // percentage now comes back from the worker instead. When a "Compare
  // against" scenario is selected, both runs share the same random seed
  // (common random numbers) so the reported success-rate/median-wealth
  // DELTA reflects the parameter change, not which random path each side
  // happened to draw — same technique as core/monte-carlo.mjs's
  // runScenarioAB, just run as two sequential worker calls here so a
  // single progress bar can span both halves.
  const runMC = useCallback(async () => {
    setMcRunning(true); setMcProgress(0); setMc(null); setMcB(null);
    const seed = Math.floor(Math.random() * 1e9);
    const runsForBoth = mcCompareKey !== "none" ? 2 : 1;
    try {
      const resA = await runMonteCarloAsync(
        { ...mcInputsFromPlan(p, det), runs: 1000, seed },
        { onProgress: (f) => setMcProgress(f / runsForBoth) }
      );
      setMc(resA);
      if (mcCompareKey !== "none") {
        // "sc:<id>" = a SAVED scenario from the library — compared on the
        // same common random numbers as the preset tweaks.
        const saved = mcCompareKey.startsWith("sc:")
          ? scenarios.find((x) => `sc:${x.id}` === mcCompareKey)
          : null;
        const spB = saved ? { ...DEFAULTS, ...saved.inputs } : applyScenario(p, mcCompareKey);
        const detB = buildProjection(spB);
        const resB = await runMonteCarloAsync(
          { ...mcInputsFromPlan(spB, detB), runs: 1000, seed },
          { onProgress: (f) => setMcProgress(0.5 + f / runsForBoth) }
        );
        setMcB(resB);
      }
    } finally {
      setMcRunning(false);
    }
  }, [p, det, mcCompareKey, runMonteCarloAsync, scenarios]);

  // adequacy verdict
  const verdict = (() => {
    if (det.depletionAge === null)
      return { tone: "green", label: "On track", text: `Pot sustains your target income through age ${p.planAge}.` };
    if (det.depletionAge >= p.planAge - 5)
      return { tone: "amber", label: "Tight", text: `Pot runs dry around age ${det.depletionAge} — close to your plan horizon.` };
    return { tone: "red", label: "Shortfall", text: `Pot is exhausted at age ${det.depletionAge}, before your plan age of ${p.planAge}.` };
  })();

  const retireRow = det.timeline.find((d) => d.age === p.retireAge);

  /* ---------------------------------------------------------------- */
  return (
    <div
      data-theme={theme}
      style={{
        background: T.paper,
        borderRadius: 12,
        border: `1px solid ${T.line}`,
        overflow: "hidden",
        fontFamily: SANS,
        color: T.ink,
        transition: "background 120ms ease, color 120ms ease",
      }}
    >
      <style>{`
        ${THEME_CSS}
        input[type=range]{ height: 4px; }
        .rp-tab:hover{ color:${T.ink} !important; }
        ::-webkit-scrollbar{ width:8px; height:8px;}
        ::-webkit-scrollbar-thumb{ background:${T.line}; border-radius:4px;}
        .rp-assumptions-grid{ display:grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 4px 28px; }
      `}</style>

      {/* Slim controls bar — no page title/subheading here on purpose: the
          sidebar's "Plan" tab already labels this, and the app-wide header
          above already owns Save/Load, so this tab doesn't repeat either. */}
      <div
        className="rp-noprint"
        style={{
          borderBottom: `1px solid ${T.line}`,
          background: T.surface,
          padding: "10px 22px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <div style={{ fontSize: 11.5, color: T.muted }}>
          Pre &amp; post-retirement projections · 2025/26 tax rules · educational model, not advice
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <Segmented
            value={p.region}
            onChange={(v) => set("region", v)}
            options={[
              { value: "ruk", label: "England/Wales/NI" },
              { value: "scotland", label: "Scotland" },
            ]}
          />
          {livePots && (
            <button onClick={syncFromPortfolio} style={hdrBtn}
              title="Copy current pot values from your live portfolio (SIPP / ISA / GIA / LISA wrapper totals incl. cash), salary, and property equity net of other liabilities (Property tab) into the plan inputs. If you've modelled a rental property below via Buy-to-let, check 'Other net worth' doesn't double-count it.">
              <RefreshCw size={14} /> Sync from portfolio
            </button>
          )}
          <button
            onClick={() => setPanelOpen((o) => !o)}
            style={{ ...hdrBtn, background: panelOpen ? T.ink : T.surface, color: panelOpen ? T.paper : T.ink }}
          >
            <Settings2 size={14} /> Assumptions {panelOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
        </div>
      </div>

      {/* ---- Assumptions — a collapsible strip ABOVE the main content, laid
          out as a wrapping card grid, not a side panel: the app already has
          its own sidebar nav, so a second, narrower sidebar competing for
          the same edge of the screen was the thing to remove. ---- */}
      {panelOpen && (
        <section
          className="rp-panel"
          style={{
            borderBottom: `1px solid ${T.line}`,
            background: T.surface,
            padding: "18px 22px 8px",
          }}
        >
          <div className="rp-assumptions-grid">
            <PanelSection title="Scenario library">
              <ScenarioLibrary p={p} det={det} scenarios={scenarios} setScenarios={setScenarios} setPlanInputs={setPlanInputs} />
            </PanelSection>

            <PanelSection title="You & timing">
              <Field label="Current age" value={p.currentAge} min={18} max={70} onChange={(v) => set("currentAge", v)} suffix="" />
              <Field label="Planned retirement age" value={p.retireAge} min={p.currentAge + 1} max={75} onChange={(v) => set("retireAge", v)}
                hint={p.retireAge < p.accessAge ? `⚠ Below pension access age (${p.accessAge}) — you'd need a bridge.` : undefined} />
              <Field label="Pension access age" value={p.accessAge} min={55} max={60} onChange={(v) => set("accessAge", v)} hint="Rises to 57 from April 2028" />
              <Field label="State Pension age" value={p.spaAge} min={66} max={70} onChange={(v) => set("spaAge", v)} />
              <Field label="Plan to age" value={p.planAge} min={80} max={105} onChange={(v) => set("planAge", v)} hint="Longevity horizon for adequacy" />
              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600, marginBottom: 6 }}>Sex (for ONS life expectancy)</div>
                <Segmented value={p.sex} onChange={(v) => set("sex", v)} options={[{ value: "male", label: "Male" }, { value: "female", label: "Female" }]} />
              </div>
              <Toggle label="Non-smoker / active / affluent" checked={p.healthy} onChange={(v) => set("healthy", v)} />
            </PanelSection>

            <PanelSection title="Money in">
              <Field label="Gross salary" value={p.salary} min={20000} max={300000} step={1000} prefix="£" onChange={(v) => set("salary", v)} />
              <Field label="Salary growth" value={p.salaryGrowth} min={0} max={8} step={0.25} suffix="%" onChange={(v) => set("salaryGrowth", v)} />
              <Field label="Current pension pot" value={p.startPot} min={0} max={3000000} step={5000} prefix="£" onChange={(v) => set("startPot", v)} />
              <Field label="Your contribution" value={p.empPct} min={0} max={40} step={0.5} suffix="%" onChange={(v) => set("empPct", v)} />
              <Field label="Employer contribution" value={p.erPct} min={0} max={20} step={0.5} suffix="%" onChange={(v) => set("erPct", v)} />
            </PanelSection>

            <PanelSection title="ISA · GIA · LISA (bridge & tax-free)">
              <Field label="ISA balance" value={p.isaStart} min={0} max={2000000} step={5000} prefix="£" onChange={(v) => set("isaStart", v)} hint="Withdrawals fully tax-free" />
              <Field label="Annual ISA top-up" value={p.isaContrib} min={0} max={20000} step={500} prefix="£" onChange={(v) => set("isaContrib", v)} />
              <Field label="GIA balance" value={p.giaStart} min={0} max={2000000} step={5000} prefix="£" onChange={(v) => set("giaStart", v)} hint="Taxable: CGT on gains when sold" />
              <Field label="Annual GIA top-up" value={p.giaContrib} min={0} max={50000} step={500} prefix="£" onChange={(v) => set("giaContrib", v)} />
              <Field label="LISA balance" value={p.lisaStart} min={0} max={200000} step={1000} prefix="£" onChange={(v) => set("lisaStart", v)} hint="Tax-free, but locked until age 60" />
              <Field label="Annual LISA top-up" value={p.lisaContrib} min={0} max={4000} step={100} prefix="£" onChange={(v) => set("lisaContrib", v)} hint="+25% bonus, to age 50 (max £4k)" />
            </PanelSection>

            <PanelSection title="Other net worth (not drawn down)">
              <Field label="Property equity, minus other debts" value={p.otherNetWorthStart} min={0} max={5000000} step={10000} prefix="£" onChange={(v) => set("otherNetWorthStart", v)}
                hint="Static — added to your estate at death only, never drawn on for retirement income or grown/inflated. Sync from portfolio pulls this from the Property tab (all registered properties minus mortgages and other liabilities). If a rental property is already modelled via Buy-to-let below, don't count it twice here." />
            </PanelSection>

            <PanelSection title="Growth & inflation">
              <Field label="Growth — pre-retirement" value={p.growthPre} min={0} max={12} step={0.25} suffix="%" onChange={(v) => set("growthPre", v)} hint="Gross market return, before fees" />
              <Field label="Growth — in retirement" value={p.growthPost} min={0} max={10} step={0.25} suffix="%" onChange={(v) => set("growthPost", v)} hint="Lower-risk drawdown portfolio" />
              <Field label="Platform + fund fees" value={p.fee} min={0} max={2} step={0.05} suffix="%" onChange={(v) => set("fee", v)} hint={`Drag on returns each year (≈${gbpK(feeDrag)} less at retirement)`} />
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600, marginBottom: 6 }}>Inflation basis</div>
                <Segmented
                  value={p.inflMode}
                  onChange={(v) => set("inflMode", v)}
                  options={[
                    { value: "cpi", label: "CPI" },
                    { value: "rpi", label: "RPI" },
                    { value: "custom", label: "Custom" },
                  ]}
                />
              </div>
              <Field label={p.inflMode === "rpi" ? "CPI base" : "Inflation rate"} value={p.inflation} min={0} max={12} step={0.25} suffix="%" onChange={(v) => set("inflation", v)} hint={p.inflMode === "rpi" ? `Effective RPI = ${(p.inflation + p.rpiWedge).toFixed(2)}%` : p.inflMode === "custom" ? "Your own assumption" : "Most pensions & benefits index to CPI"} />
              {p.inflMode === "rpi" && (
                <Field label="RPI wedge over CPI" value={p.rpiWedge} min={0} max={2} step={0.1} suffix="%" onChange={(v) => set("rpiWedge", v)} hint="RPI historically ~0.8–1% above CPI" />
              )}
              <Field label="Return volatility" value={p.vol} min={2} max={25} step={0.5} suffix="%" onChange={(v) => set("vol", v)} hint="Used in Monte Carlo" />
            </PanelSection>

            <PanelSection title="Retirement income">
              <div style={{ marginBottom: 12 }}>
                <Segmented
                  value={p.targetMode}
                  onChange={(v) => set("targetMode", v)}
                  accent={T.green}
                  options={[
                    { value: "ratio", label: "Replacement %" },
                    { value: "absolute", label: "Fixed £" },
                  ]}
                />
              </div>
              {p.targetMode === "ratio" ? (
                <Field label="Income replacement ratio" value={p.replacementRatio} min={30} max={120} step={1} suffix="%" onChange={(v) => set("replacementRatio", v)} hint={`= ${gbp(det.targetNetToday)}/yr net, today's money`} />
              ) : (
                <Field label="Target net income (today's £)" value={p.targetAbsolute} min={10000} max={150000} step={500} prefix="£" onChange={(v) => set("targetAbsolute", v)} hint={`= ${pct(det.targetNetToday / Math.max(1, det.preNetToday))} of current take-home`} />
              )}
              <Toggle label="Include State Pension" checked={p.includeState} onChange={(v) => set("includeState", v)} />
              {p.includeState && (
                <Field label="Full State Pension" value={p.statePension} min={0} max={15000} step={1} prefix="£" onChange={(v) => set("statePension", v)} hint="2025/26 full new SP = £11,973" />
              )}
              {p.includeState && (
                <Toggle label="State Pension triple lock" checked={p.tripleLock} onChange={(v) => set("tripleLock", v)} />
              )}
              {p.includeState && p.tripleLock && (
                <Field label="Assumed earnings growth" value={p.earningsGrowth} min={0} max={8} step={0.25} suffix="%" onChange={(v) => set("earningsGrowth", v)} hint={`SP rises at max(CPI ${p.inflation}%, earnings, 2.5%)`} />
              )}
              <Toggle label="Defined-benefit pension" checked={p.dbEnabled} onChange={(v) => set("dbEnabled", v)} />
              {p.dbEnabled && (
                <>
                  <Field label="DB pension (today's £)" value={p.dbPension} min={0} max={80000} step={500} prefix="£" onChange={(v) => set("dbPension", v)} hint="Annual amount from retirement" />
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600, marginBottom: 6 }}>DB indexation</div>
                    <Segmented value={p.dbIndex} onChange={(v) => set("dbIndex", v)} options={[{ value: "cpi", label: "CPI" }, { value: "rpi", label: "RPI" }, { value: "fixed", label: "Fixed %" }]} />
                  </div>
                  {p.dbIndex === "fixed" && (
                    <Field label="Fixed escalation" value={p.dbFixedRate} min={0} max={8} step={0.25} suffix="%" onChange={(v) => set("dbFixedRate", v)} />
                  )}
                </>
              )}
            </PanelSection>

            <PanelSection title="Tax-free cash (25%)">
              <Segmented
                value={p.tfcMode}
                onChange={(v) => set("tfcMode", v)}
                accent={T.green}
                options={[
                  { value: "ufpls", label: "Spread (UFPLS)" },
                  { value: "pcls", label: "Upfront lump sum" },
                ]}
              />
              <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8, lineHeight: 1.5 }}>
                {p.tfcMode === "ufpls"
                  ? "Each withdrawal is 25% tax-free, 75% taxable — keeps the tax-free pot growing."
                  : "Take 25% (max £268,275) tax-free at retirement into your ISA; later pension draws are fully taxable."}
              </div>
            </PanelSection>

            <PanelSection title="Phased retirement (optional)">
              <Field label="Pension contributions after access" value={p.postAccessContrib} min={0} max={40000} step={500} prefix="£" onChange={(v) => set("postAccessContrib", v)} hint="Still paying into a DC pot (e.g. part-time work) after you start drawing pension income" />
              {p.postAccessContrib > 0 && (
                <div style={{ fontSize: 11.5, color: p.postAccessContrib > det.mpaaLimit ? T.amber : T.muted, marginTop: 8, lineHeight: 1.5 }}>
                  {det.mpaaTriggered
                    ? p.postAccessContrib > det.mpaaLimit
                      ? `⚠ MPAA triggered at age ${det.mpaaTriggerAge} — this exceeds the £${det.mpaaLimit.toLocaleString("en-GB")} money-purchase annual allowance cap. See the Sequencing tab.`
                      : `MPAA triggers at age ${det.mpaaTriggerAge} once income drawdown starts — this contribution stays within the £${det.mpaaLimit.toLocaleString("en-GB")} cap.`
                    : `Taking only tax-free cash (no income drawdown) doesn't trigger MPAA by itself — the cap only bites once pension income is actually drawn.`}
                </div>
              )}
            </PanelSection>

            <PanelSection title="Drawdown order">
              <Segmented value={p.drawStrategy} onChange={(v) => set("drawStrategy", v)} accent={T.green}
                options={[{ value: "taxopt", label: "Tax-opt" }, { value: "taxfree", label: "Tax-free 1st" }, { value: "pension", label: "Pension 1st" }, { value: "giafirst", label: "GIA 1st" }]} />
              <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
                Order pots are tapped to fund income. The optimiser (Drawdown tab) compares all strategies.
              </div>
            </PanelSection>

            <PanelSection title="Spending profile">
              <Segmented value={p.spendProfile} onChange={(v) => set("spendProfile", v)} accent={T.green}
                options={[{ value: "flat", label: "Flat" }, { value: "smile", label: "Smile" }, { value: "decline", label: "Decline" }, { value: "custom", label: "Custom" }]} />
              <div style={{ fontSize: 11.5, color: T.muted, margin: "8px 0 4px", lineHeight: 1.5 }}>
                {p.spendProfile === "flat" && "Constant real spending throughout."}
                {p.spendProfile === "smile" && "Higher 'go-go' years early, a mid-retirement dip, slight rise late for care."}
                {p.spendProfile === "decline" && "Real spending drifts down ~1%/yr (the 'reality retirement' pattern)."}
                {p.spendProfile === "custom" && "Set your own go-go / slow-go / no-go levels."}
              </div>
              <Field label="Essential share of spending" value={p.essentialPct ?? 65} min={0} max={100} step={5} suffix="%"
                onChange={(v) => set("essentialPct", v)} hint="The 'needs, not wants' part of the target — what the Income floor tab tests guaranteed income against" />
              {budgetSpend && (
                <div style={{ fontSize: 11.5, color: T.muted, marginTop: 6, lineHeight: 1.5 }}>
                  {budgetSpend.ready ? (
                    <>
                      Your Budget tab says you actually spend <strong style={{ color: T.ink }}>{gbp(budgetSpend.annualSpend)}</strong>/yr, <strong style={{ color: T.ink }}>{Math.round(budgetSpend.essentialPct)}%</strong> of it on essentials.{" "}
                      <button onClick={() => setP((x) => ({ ...x, targetMode: "absolute", targetAbsolute: Math.round(budgetSpend.annualSpend), essentialPct: Math.round(budgetSpend.essentialPct) }))}
                        style={{ color: T.blue, textDecoration: "underline", textDecorationStyle: "dotted" }}>
                        Use both as the target →
                      </button>
                    </>
                  ) : (
                    <>Budget tab actuals aren't representative yet ({budgetSpend.reasons.join("; ")}), so they're not offered as a prefill here.</>
                  )}
                </div>
              )}
              {p.spendProfile === "custom" && (
                <>
                  <Field label="Go-go until age" value={p.goGoUntil} min={p.retireAge + 1} max={90} onChange={(v) => set("goGoUntil", v)} />
                  <Field label="Go-go spend" value={p.goGoPct} min={70} max={150} step={5} suffix="%" onChange={(v) => set("goGoPct", v)} />
                  <Field label="Slow-go until age" value={p.slowGoUntil} min={p.goGoUntil + 1} max={100} onChange={(v) => set("slowGoUntil", v)} />
                  <Field label="Slow-go spend" value={p.slowGoPct} min={50} max={120} step={5} suffix="%" onChange={(v) => set("slowGoPct", v)} />
                  <Field label="No-go spend" value={p.noGoPct} min={50} max={120} step={5} suffix="%" onChange={(v) => set("noGoPct", v)} />
                </>
              )}
            </PanelSection>

            <PanelSection title="Goals — one-off outflows">
              <GoalsEditor p={p} det={det} setP={setP} />
            </PanelSection>

            <PanelSection title="Annuity (optional)">
              <Toggle label="Buy an annuity in retirement" checked={p.annuityEnabled} onChange={(v) => set("annuityEnabled", v)} />
              {p.annuityEnabled && (
                <>
                  <Field label="Purchase at age" value={p.annuityAge} min={p.accessAge} max={p.planAge - 1} onChange={(v) => set("annuityAge", v)} />
                  <Field label="Share of pension used" value={p.annuityPortion} min={5} max={100} step={5} suffix="%" onChange={(v) => set("annuityPortion", v)} hint={`≈ ${gbp((det.annuityIncome0 || 0))}/yr guaranteed`} />
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600, marginBottom: 6 }}>Escalation</div>
                    <Segmented value={p.annuityEscalation} onChange={(v) => set("annuityEscalation", v)} options={[{ value: "level", label: "Level" }, { value: "esc3", label: "3%/yr" }, { value: "rpi", label: "RPI" }]} />
                  </div>
                </>
              )}
            </PanelSection>

            <PanelSection title="Buy-to-let (optional)">
              <Toggle label="Include a BTL property" checked={p.btlEnabled} onChange={(v) => set("btlEnabled", v)} />
              {p.btlEnabled && (
                <>
                  <Field label="Property value" value={p.btlValue} min={100000} max={2000000} step={10000} prefix="£" onChange={(v) => set("btlValue", v)} />
                  <Field label="Mortgage balance" value={p.btlMortgage} min={0} max={1500000} step={5000} prefix="£" onChange={(v) => set("btlMortgage", v)} hint="Interest-only assumed" />
                  <Field label="Mortgage rate" value={p.btlRate} min={0} max={10} step={0.1} suffix="%" onChange={(v) => set("btlRate", v)} />
                  <Field label="Gross rental yield" value={p.btlYield} min={2} max={12} step={0.1} suffix="%" onChange={(v) => set("btlYield", v)} hint="Annual rent as % of value" />
                  <Field label="Maintenance" value={p.btlMaint} min={0} max={30} step={1} suffix="%" onChange={(v) => set("btlMaint", v)} hint="% of rent" />
                  <Field label="Letting / management" value={p.btlMgmt} min={0} max={20} step={1} suffix="%" onChange={(v) => set("btlMgmt", v)} hint="% of rent" />
                  <Field label="Voids" value={p.btlVoid} min={0} max={20} step={1} suffix="%" onChange={(v) => set("btlVoid", v)} hint="% of rent lost to empty periods" />
                  <Field label="Capital growth" value={p.btlGrowth} min={0} max={8} step={0.25} suffix="%" onChange={(v) => set("btlGrowth", v)} />
                  <Field label="Rent growth" value={p.btlRentGrowth} min={0} max={8} step={0.25} suffix="%" onChange={(v) => set("btlRentGrowth", v)} />
                  <Field label="Original purchase price" value={p.btlBaseCost} min={50000} max={2000000} step={10000} prefix="£" onChange={(v) => set("btlBaseCost", v)} hint="Cost base for CGT on sale" />
                  <Field label="Sell at age" value={p.btlSellAge} min={0} max={p.planAge} step={1} onChange={(v) => set("btlSellAge", v === 0 ? 0 : Math.max(p.retireAge, Math.min(v, p.planAge)))} hint={p.btlSellAge === 0 ? "0 = hold for life (no sale)" : p.btlSellAge < p.retireAge ? `Will sell at retirement (${p.retireAge})` : `Sell at ${p.btlSellAge}: proceeds → GIA/drawdown`} />
                </>
              )}
            </PanelSection>
          </div>
        </section>
      )}

      {/* ---- Main content ---- */}
      <main style={{ padding: "20px 22px 60px", minWidth: 0 }}>
          {/* Tabs — grouped into three themes so ten peers stop competing
              for attention: PROJECTION (where am I heading), RESILIENCE
              (what if it goes wrong), ESTATE (what's left, and property).
              Grouping only — the panels themselves are unchanged, so every
              setTab deep-link keeps working. */}
          <div
            style={{
              display: "flex",
              gap: 14,
              borderBottom: `1px solid ${T.line}`,
              marginBottom: 20,
              flexWrap: "wrap",
              alignItems: "flex-end",
            }}
          >
            {[
              { group: "Projection", tabs: [
                { k: "overview", label: "Overview", icon: Gauge },
                { k: "accum", label: "Accumulation", icon: TrendingUp },
                { k: "decum", label: "Decumulation", icon: TrendingDown },
                { k: "drawdown", label: "Sequencing", icon: Layers },
              ] },
              { group: "Resilience", tabs: [
                { k: "floor", label: "Income floor", icon: Umbrella },
                { k: "runoff", label: "Run-off", icon: Droplets },
                { k: "stress", label: "Scenarios & stress", icon: ShieldAlert },
                { k: "adequacy", label: "Monte Carlo", icon: Activity },
              ] },
              { group: "Estate & property", tabs: [
                { k: "iht", label: "Inheritance tax", icon: Landmark },
                { k: "btl", label: "Buy-to-let", icon: Building2 },
              ] },
            ].map(({ group, tabs }) => (
              <div key={group} role="tablist" aria-label={group} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                <div style={{ fontSize: 9.5, letterSpacing: ".08em", textTransform: "uppercase", color: T.muted, fontWeight: 700, paddingLeft: 12 }}>{group}</div>
                <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
                  {tabs.map(({ k, label, icon: Icon }) => {
                    const active = tab === k;
                    return (
                      <button
                        key={k}
                        className="rp-tab"
                        role="tab"
                        aria-selected={active}
                        onClick={() => setTab(k)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          border: "none",
                          background: "none",
                          cursor: "pointer",
                          padding: "8px 12px",
                          fontSize: 13.5,
                          fontWeight: 600,
                          color: active ? T.ink : T.muted,
                          borderBottom: active ? `2px solid ${T.green}` : "2px solid transparent",
                          marginBottom: -1,
                        }}
                      >
                        <Icon size={15} /> {label}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* ===== OVERVIEW ===== */}
          {tab === "overview" && (
            <div>
              {/* verdict banner */}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  background:
                    verdict.tone === "green" ? T.greenSoft : verdict.tone === "amber" ? T.amberSoft : T.redSoft,
                  border: `1px solid ${verdict.tone === "green" ? T.green : verdict.tone === "amber" ? T.amber : T.red}33`,
                  borderRadius: 12,
                  padding: "14px 18px",
                  marginBottom: 18,
                }}
              >
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: ".05em",
                    textTransform: "uppercase",
                    color: verdict.tone === "green" ? T.green : verdict.tone === "amber" ? T.amber : T.red,
                    padding: "4px 10px",
                    borderRadius: 20,
                    background: T.surface,
                  }}
                >
                  {verdict.label}
                </div>
                <div style={{ fontSize: 14, color: T.ink2 }}>{verdict.text}</div>
              </div>

              {/* key stats */}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))",
                  gap: 12,
                  marginBottom: 18,
                }}
              >
                <Card><Stat label="Wealth at retirement" value={gbpK(det.wealthAtRetire)} sub={`${gbp(det.wealthAtRetireReal)} today · pension ${gbpK(det.potAtRetire)} + ISA ${gbpK(det.bridgeAtRetire)}`} tone="green" /></Card>
                <Card><Stat label="Retirement income" value={gbp(det.firstYearNetToday)} sub="net/yr, today's money" /></Card>
                <Card><Stat label="Net replacement" value={pct(det.replacementNet, 0)} sub={`of ${gbp(det.preNetToday)} take-home`} tone={det.replacementNet >= (p.replacementRatio - 5) / 100 ? "green" : "amber"} /></Card>
                <Card><Stat label="Money lasts to" value={det.depletionAge ? `age ${det.depletionAge}` : `${p.planAge}+`} sub={det.depletionAge ? "then State Pension only" : "target met"} tone={det.depletionAge ? "red" : "green"} /></Card>
              </div>

              {/* HERO lifeline chart */}
              <Card style={{ padding: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                  <div>
                    <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Your wealth lifeline</h3>
                    <p style={{ margin: "3px 0 0", fontSize: 12.5, color: T.muted }}>
                      Total investable wealth (pension + ISA/GIA bridge) from today, building to retirement at {p.retireAge}, then drawn down. Real = inflation-adjusted to today.
                    </p>
                  </div>
                </div>
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart data={det.timeline} margin={{ top: 14, right: 8, bottom: 0, left: 8 }}>
                    <defs>
                      <linearGradient id="gReal" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor={T.green} stopOpacity={0.28} />
                        <stop offset="100%" stopColor={T.green} stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke={T.lineSoft} vertical={false} />
                    <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={4} />
                    <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
                    <Tooltip
                      contentStyle={tooltipStyle()}
                      formatter={(v, n) => [gbp(v), n === "potNominal" ? "Nominal" : "Real (today's £)"]}
                      labelFormatter={(a) => `Age ${a}`}
                    />
                    <ReferenceArea x1={p.retireAge} x2={p.planAge} fill={T.amber} fillOpacity={0.04} />
                    <ReferenceLine x={p.retireAge} stroke={T.amber} strokeDasharray="4 3" label={{ value: "Retire", position: "top", fontSize: 11, fill: T.amber }} />
                    {p.includeState && <ReferenceLine x={p.spaAge} stroke={T.blue} strokeDasharray="2 3" label={{ value: "State Pension", position: "top", fontSize: 10, fill: T.blue }} />}
                    {det.depletionAge && <ReferenceLine x={det.depletionAge} stroke={T.red} strokeDasharray="4 3" label={{ value: "Depleted", position: "top", fontSize: 10, fill: T.red }} />}
                    <Area type="monotone" dataKey="potReal" stroke={T.green} strokeWidth={2.4} fill="url(#gReal)" name="potReal" />
                    <Line type="monotone" dataKey="potNominal" stroke={T.ink2} strokeWidth={1.4} strokeDasharray="3 3" dot={false} name="potNominal" />
                  </ComposedChart>
                </ResponsiveContainer>
                <Legendlet items={[
                  { c: T.green, t: "Real value (today's £)" },
                  { c: T.ink2, t: "Nominal value", dash: true },
                  { c: T.amber, t: "Retirement & drawdown" },
                ]} />
              </Card>

              {det.aaBreach && (
                <Note tone="amber">
                  Your annual contribution of {gbp(det.firstContrib)} exceeds your Annual Allowance of {gbp(det.aa)}. Excess may face a tax charge — check carry-forward from the previous three years.
                </Note>
              )}
              {p.retireAge < p.accessAge && (
                <Note tone={det.depletionAge && det.depletionAge <= p.accessAge ? "red" : "blue"}>
                  You retire at {p.retireAge} but can't touch the pension until {p.accessAge}. The ISA/GIA bridge ({gbp(det.bridgeAtRetire)} at retirement) must cover those {p.accessAge - p.retireAge} year(s).{" "}
                  {det.depletionAge && det.depletionAge <= p.accessAge
                    ? `As modelled, it runs dry at ${det.depletionAge} — increase the bridge pot or delay retirement.`
                    : "As modelled, the bridge covers the gap."}
                </Note>
              )}
              {p.tfcMode === "pcls" && (
                <Note tone="blue">
                  Taking {gbp(det.pclsAmount)} as an upfront 25% tax-free lump sum into your ISA/bridge. Remaining pension withdrawals are then fully taxable. Switch to UFPLS to instead spread the tax-free portion across every withdrawal — usually better for keeping money invested, but less useful if you need a large bridge.
                </Note>
              )}
            </div>
          )}

          {/* ===== ACCUMULATION ===== */}
          {tab === "accum" && (
            <AccumulationTab p={p} det={det} feeFree={feeFree} feeDrag={feeDrag} />
          )}

          {/* ===== DECUMULATION ===== */}
          {tab === "decum" && (
            <DecumulationTab p={p} det={det} retireRow={retireRow} />
          )}

          {/* ===== INCOME FLOOR ===== */}
          {tab === "floor" && (
            <FloorTab p={p} det={det} set={set} giltCashflows={giltCashflows} />
          )}

          {/* ===== EXPENSE RUN-OFF ===== */}
          {tab === "runoff" && (
            <RunoffTab p={p} giltCashflows={giltCashflows} forwardDividends={forwardDividends} budgetSpend={budgetSpend} />
          )}

          {/* ===== BUY-TO-LET ===== */}
          {tab === "btl" && (
            <BtlTab p={p} det={det} set={set} />
          )}

          {/* ===== DRAWDOWN OPTIMISER ===== */}
          {tab === "drawdown" && (
            <DrawdownTab p={p} det={det} set={set} />
          )}

          {/* ===== SCENARIOS / STRESS ===== */}
          {tab === "stress" && (
            <StressTab p={p} det={det} results={scenarioResults} />
          )}

          {/* ===== MONTE CARLO ===== */}
          {tab === "adequacy" && (
            <AdequacyTab p={p} mc={mc} mcB={mcB} progress={mcProgress} compareKey={mcCompareKey} setCompareKey={setMcCompareKey} running={mcRunning} runMC={runMC} det={det} life={life} set={set} savedScenarios={scenarios} />
          )}

          {/* ===== INHERITANCE TAX ===== */}
          {tab === "iht" && (
            <IhtTab p={p} det={det} set={set} liveEstate={liveEstate} livePots={livePots} />
          )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-sections                                                       */
/* ------------------------------------------------------------------ */
/* ---- Phase 3.6: scenario library (save/load/compare full plans) ------ */
