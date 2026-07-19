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
import { runGuytonKlinger } from "../core/guyton-klinger.mjs";
import { rollingStressTest } from "../core/sequence-risk.mjs";
import { projectIHT, pensionsInEstate, PENSIONS_IN_ESTATE_FROM } from "../core/iht.mjs";
import { buildIncomeFloor } from "../core/income-floor.mjs";
import { optimiseDrawdown, TFC_LABELS } from "../core/drawdown-optimiser.mjs";
import { sequenceHeatmap } from "../core/sequence-heatmap.mjs";
import { buildRunoff } from "../core/runoff-model.mjs";
import { effectiveCashByWrapper } from "../core/cash.mjs";
import { deferredCashCalendar } from "../core/deferred-cash.mjs";
import { vestingSchedule } from "../core/rsu.mjs";
import { giltIncomeByYear } from "../core/gilt-ladder.mjs";
import { planSpendFromBudget } from "../core/budget.mjs";
import { categoriseAll, learnMerchants } from "../core/categorise.mjs";
import { store, uid, todayISO } from "../ui/shared.jsx";
import useAppStore from "../state/appStore.js";

/* ------------------------------------------------------------------ */
/*  Design tokens — Phase 2.8: mapped onto the APP's CSS variables      */
/*  (CgtDashboard.jsx's .root / .dark .root palette) instead of a        */
/*  second, private light/dark palette that had to be kept in sync by    */
/*  hand. The `T.*` indirection every inline style here uses is          */
/*  unchanged — only what the tokens RESOLVE to moved — so this is a     */
/*  mapping table, not a 2,000-line restyle. Soft ("Soft") backgrounds   */
/*  derive via color-mix (already used throughout the app shell), and    */
/*  since the app vars flip with the .dark class, one mapping serves     */
/*  both themes — the [data-theme] attribute and THEME_CSS remain only   */
/*  so the chart-specific extras (ink2/gold) can keep per-theme values   */
/*  with the same mechanism as before.                                  */
/* ------------------------------------------------------------------ */
const SHARED_TOKENS = {
  paper: "var(--bg)",
  surface: "var(--panel)",
  ink: "var(--fg)",
  muted: "var(--muted)",
  line: "var(--border)",
  lineSoft: "color-mix(in srgb, var(--border) 55%, transparent)",
  green: "var(--gain)",
  greenSoft: "color-mix(in srgb, var(--gain) 14%, transparent)",
  blue: "var(--m-same)",
  blueSoft: "color-mix(in srgb, var(--m-same) 13%, transparent)",
  amber: "var(--m-bb)",
  amberSoft: "color-mix(in srgb, var(--m-bb) 14%, transparent)",
  red: "var(--loss)",
  redSoft: "color-mix(in srgb, var(--loss) 13%, transparent)",
  // secondary ink: between fg and muted — no app token exists for this
  ink2: "color-mix(in srgb, var(--fg) 70%, var(--muted))",
};
// Chart-only colours with no app-palette equivalent keep per-theme values.
const LIGHT = { ...SHARED_TOKENS, gold: "#8F7327" };
const DARK = { ...SHARED_TOKENS, gold: "#C6A24E" };
const T = Object.fromEntries(Object.keys(LIGHT).map((k) => [k, `var(--t-${k})`]));
const themeVars = (obj) => Object.entries(obj).map(([k, v]) => `--t-${k}:${v};`).join("");
const THEME_CSS = `[data-theme="light"]{${themeVars(LIGHT)}}[data-theme="dark"]{${themeVars(DARK)}}`;

/* ------------------------------------------------------------------ */
/*  Inputs are owned by the app's Zustand store (`planInputs`/            */
/*  `setPlanInputs` props), not local state — this used to be a plain     */
/*  `useState` backed by its own `localStorage.setItem(                   */
/*  "uk-retirement-planner:inputs", ...)` call, invisible to the app's    */
/*  IndexedDB durable mirror, daily snapshot, and JSON backup/restore,    */
/*  the same data-loss class fixed for the Allowances tab's overrides.    */
/*  It's also why this tab used to need its own Save/Load buttons: with   */
/*  inputs living in the shared store, the app-wide Save/Load already     */
/*  covers them, so this tab doesn't need its own.                        */
/* ------------------------------------------------------------------ */
const MONO = "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace";
const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, system-ui, sans-serif";
const hdrBtn = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  border: `1px solid ${T.line}`,
  background: T.surface,
  borderRadius: 9,
  padding: "8px 11px",
  cursor: "pointer",
  fontWeight: 600,
  fontSize: 13,
  color: T.ink,
  fontFamily: SANS,
};

/* ------------------------------------------------------------------ */
/*  Formatters                                                         */
/* ------------------------------------------------------------------ */
const gbp = (n) => "£" + Math.round(n || 0).toLocaleString("en-GB");
const gbpK = (n) => {
  const v = n || 0;
  if (Math.abs(v) >= 1e6) return "£" + (v / 1e6).toFixed(2) + "m";
  if (Math.abs(v) >= 1e3) return "£" + Math.round(v / 1e3) + "k";
  return "£" + Math.round(v);
};
const pct = (n, d = 1) => (n * 100).toFixed(d) + "%";

/* ------------------------------------------------------------------ */
/*  UK tax engine + drawdown projection engine — moved to core/*.mjs so    */
/*  they're pure, importable, and node-tested (uk-income-tax.test.mjs,     */
/*  drawdown.test.mjs) instead of living as untested component-local       */
/*  functions. Behaviour is unchanged; every call site below is the same.  */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/*  Monte Carlo (returns randomised; spending plan fixed) — the actual    */
/*  simulation loop now lives in core/monte-carlo.mjs (pure, node-tested, */
/*  and importable from the Web Worker in workers/monteCarloWorker.js so */
/*  it runs off the main thread — see useMonteCarloWorker()). This just  */
/*  flattens this tab's `p`/`det` shapes into that module's plain input  */
/*  interface, the same adapter role applyScenario()/buildProjection()   */
/*  already play for the scenario table above.                           */
/* ------------------------------------------------------------------ */
function mcInputsFromPlan(p, det) {
  return {
    startWealth: det.startWealth, // total investable wealth (pension + ISA)
    accumYears: det.accumYears,
    wealthContribSchedule: det.wealthContribSchedule,
    withdrawSchedule: det.withdrawSchedule,
    growthPre: p.growthPre, growthPost: p.growthPost, fee: p.fee, vol: p.vol,
    inflation: effInflation(p), currentAge: p.currentAge,
    // Phase 2.7 return-model options — defaults reproduce the legacy
    // single-asset/fixed-inflation engine exactly (see monte-carlo.mjs).
    model: p.mcModel || "single",
    glidepath: { start: p.mcEqStart ?? 60, end: p.mcEqEnd ?? 40 },
    stochasticInflation: !!p.mcStochInfl,
    ...(p.mcModel === "bootstrap" ? { histPairs: bootstrapPairs(HIST) } : {}),
  };
}

/* ------------------------------------------------------------------ */
/*  Scenario presets                                                   */
/* ------------------------------------------------------------------ */
function applyScenario(base, key) {
  const s = { ...base };
  switch (key) {
    case "optimistic":
      s.growthPre = base.growthPre + 2;
      s.growthPost = base.growthPost + 1.5;
      s.inflation = Math.max(1, base.inflation - 0.5);
      return s;
    case "pessimistic":
      s.growthPre = Math.max(0, base.growthPre - 2.5);
      s.growthPost = Math.max(0, base.growthPost - 2);
      s.inflation = base.inflation + 1;
      return s;
    case "stagflation":
      // 1970s-style: high inflation, near-zero real returns
      s.inflation = 9;
      s.growthPre = 9; // ~0% real
      s.growthPost = 8.5;
      return s;
    case "lostdecade":
      // muted nominal returns
      s.growthPre = Math.max(0, base.growthPre - 4);
      s.growthPost = 1;
      return s;
    case "highinfl":
      s.inflation = 6;
      return s;
    default:
      return s;
  }
}
const SCENARIOS = [
  { key: "base", label: "Base case", note: "Your assumptions, unchanged" },
  { key: "optimistic", label: "Bull market", note: "+2% growth, lower inflation" },
  { key: "pessimistic", label: "Bear market", note: "−2.5% growth, +1% inflation" },
  { key: "stagflation", label: "1970s stagflation", note: "9% inflation, ~0% real return" },
  { key: "lostdecade", label: "Lost decade", note: "Flat nominal returns post-retirement" },
  { key: "highinfl", label: "Sticky inflation", note: "Inflation held at 6%" },
];

/* ------------------------------------------------------------------ */
/*  Small UI primitives                                                */
/* ------------------------------------------------------------------ */
function Card({ children, style }) {
  return (
    <div
      style={{
        background: T.surface,
        border: `1px solid ${T.line}`,
        borderRadius: 14,
        padding: 18,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function Stat({ label, value, sub, tone = "ink", big }) {
  const color =
    tone === "green" ? T.green : tone === "red" ? T.red : tone === "amber" ? T.amber : T.ink;
  return (
    <div style={{ minWidth: 0 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".06em",
          textTransform: "uppercase",
          color: T.muted,
          fontWeight: 600,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: MONO,
          fontSize: big ? 30 : 22,
          fontWeight: 600,
          color,
          fontVariantNumeric: "tabular-nums",
          lineHeight: 1.1,
          marginTop: 4,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 12, color: T.ink2, marginTop: 3 }}>{sub}</div>
      )}
    </div>
  );
}

function Field({ label, value, onChange, min, max, step = 1, prefix, suffix, hint }) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600 }}>{label}</span>
        <span
          style={{
            fontFamily: MONO,
            fontSize: 13,
            color: T.ink,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {prefix}
          {typeof value === "number" ? value.toLocaleString("en-GB") : value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: T.green, cursor: "pointer" }}
      />
      {hint && (
        <div style={{ fontSize: 11, color: T.muted, marginTop: 3 }}>{hint}</div>
      )}
    </label>
  );
}

function Segmented({ options, value, onChange, accent = T.ink }) {
  return (
    <div
      style={{
        display: "inline-flex",
        background: T.lineSoft,
        borderRadius: 10,
        padding: 3,
        gap: 2,
        flexWrap: "wrap",
      }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            style={{
              border: "none",
              cursor: "pointer",
              borderRadius: 8,
              padding: "7px 13px",
              fontSize: 13,
              fontWeight: 600,
              fontFamily: SANS,
              background: active ? T.surface : "transparent",
              color: active ? accent : T.muted,
              boxShadow: active ? "0 1px 2px rgba(0,0,0,.08)" : "none",
              transition: "all .15s",
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginBottom: 14,
        cursor: "pointer",
      }}
    >
      <span style={{ fontSize: 12.5, color: T.ink2, fontWeight: 600 }}>{label}</span>
      <button
        onClick={() => onChange(!checked)}
        style={{
          width: 42,
          height: 24,
          borderRadius: 12,
          border: "none",
          cursor: "pointer",
          background: checked ? T.green : T.line,
          position: "relative",
          transition: "background .15s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 21 : 3,
            width: 18,
            height: 18,
            borderRadius: "50%",
            background: "#fff",
            transition: "left .15s",
            boxShadow: "0 1px 2px rgba(0,0,0,.2)",
          }}
        />
      </button>
    </label>
  );
}

function tooltipStyle() {
  return {
    background: T.surface,
    border: `1px solid ${T.line}`,
    borderRadius: 10,
    fontSize: 12,
    fontFamily: SANS,
    color: T.ink,
    boxShadow: "0 4px 16px rgba(0,0,0,.08)",
  };
}

/* ------------------------------------------------------------------ */
/*  Main component                                                     */
/* ------------------------------------------------------------------ */
const DEFAULTS = {
  region: "ruk",
  currentAge: 45,
  retireAge: 60,
  spaAge: 67,
  accessAge: 57,
  planAge: 95,
  salary: 75000,
  salaryGrowth: 2.5,
  startPot: 250000,
  empPct: 8,
  erPct: 5,
  fixedContrib: 0,
  growthPre: 6,
  growthPost: 4.5,
  inflation: 3,
  inflMode: "cpi", // 'cpi' | 'rpi' | 'custom'
  rpiWedge: 1,
  fee: 0.5, // platform + fund AUM drag %
  vol: 13,
  includeState: true,
  statePension: 11973,
  targetMode: "ratio",
  replacementRatio: 67,
  targetAbsolute: 35000,
  // essential ("needs, not wants") share of target spending — what the
  // Income floor tab tests guaranteed income against
  essentialPct: 65,
  // Monte Carlo return model (Phase 2.7): "single" = legacy one-asset
  // normal; "twoAsset" = correlated equity/bond with a glidepath;
  // "bootstrap" = resampled historical (return, inflation) year-pairs.
  mcModel: "single",
  mcEqStart: 60, // equity % at retirement start (twoAsset)
  mcEqEnd: 40,   // equity % at plan end — the derisking glidepath
  mcStochInfl: false,
  // tax-free cash treatment
  tfcMode: "ufpls", // 'ufpls' | 'pcls'
  // phased/part-time retirement: a DC contribution that continues into the
  // decumulation phase, alongside flexible pension income being drawn —
  // the one scenario where MPAA can actually bind. 0 = off, same as every
  // plan before this existed (see core/drawdown.mjs's mpaaTriggered).
  postAccessContrib: 0,
  // ISA / GIA / LISA wrappers
  isaStart: 90000,
  isaContrib: 8000,
  giaStart: 40000,
  // Property equity (or any other net worth) not otherwise modelled here —
  // static, added to the estate at death only, never treated as investable/
  // drawdown-eligible wealth. See Property tab; exclude anything already
  // captured by the Buy-to-let section below to avoid double-counting.
  otherNetWorthStart: 0,
  giaContrib: 0,
  lisaStart: 12000,
  lisaContrib: 4000,
  // state pension uprating
  tripleLock: true,
  earningsGrowth: 3.5,
  // DB / final-salary
  dbEnabled: false,
  dbPension: 0,
  dbIndex: "cpi", // 'cpi' | 'rpi' | 'fixed'
  dbFixedRate: 3,
  // drawdown sequencing
  drawStrategy: "taxopt",
  // variable spending
  spendProfile: "flat", // flat | smile | decline | custom
  goGoUntil: 75,
  slowGoUntil: 85,
  goGoPct: 110,
  slowGoPct: 90,
  noGoPct: 80,
  // annuity
  // Phase 3.6 goals: one-off dated outflows in TODAY'S £ — funded from
  // ISA→GIA→LISA(60+) before retirement, joining the spending need after.
  goals: [],
  annuityEnabled: false,
  annuityAge: 70,
  annuityPortion: 30,
  annuityEscalation: "level", // level | esc3 | rpi
  // buy-to-let
  btlEnabled: false,
  btlValue: 350000,
  btlMortgage: 180000,
  btlRate: 5.5,
  btlYield: 5.5,
  btlMaint: 12,
  btlMgmt: 10,
  btlVoid: 5,
  btlGrowth: 3,
  btlRentGrowth: 3,
  btlClearAge: 0, // 0 = interest-only forever
  btlBaseCost: 350000, // original purchase price (for CGT)
  btlSellAge: 0, // 0 = never sell (hold for life)
  // longevity
  sex: "male",
  healthy: true,
  // inheritance tax — see core/iht.mjs. `ihtGifts` is an array field on this
  // same flat object (not a new store key) so it rides along with every
  // existing planInputs persistence/backup path for free.
  ihtMarried: false,
  ihtMainResidenceToDescendants: true,
  ihtCharityPct: 0, // 0-100, % of the taxable estate left to charity
  ihtBusinessAgriculturalValue: 0,
  ihtGifts: [], // [{ id, date, amount, exempt, note }]
};

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
  const budgetSpend = useMemo(() => {
    if (!budgetCategories?.length || !rawSpendTxns?.length) return null;
    const txns = categoriseAll(rawSpendTxns, { rules: budgetRules || [], merchantMap: learnMerchants(rawSpendTxns) });
    return planSpendFromBudget({ categories: budgetCategories, txns, month: todayISO().slice(0, 7) });
  }, [budgetCategories, budgetRules, rawSpendTxns]);
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
  const [panelOpen, setPanelOpen] = useState(true);
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
          {/* Tabs */}
          <div
            style={{
              display: "flex",
              gap: 4,
              borderBottom: `1px solid ${T.line}`,
              marginBottom: 20,
              flexWrap: "wrap",
            }}
          >
            {[
              { k: "overview", label: "Overview", icon: Gauge },
              { k: "accum", label: "Accumulation", icon: TrendingUp },
              { k: "decum", label: "Decumulation", icon: TrendingDown },
              { k: "floor", label: "Income floor", icon: Umbrella },
              { k: "runoff", label: "Run-off", icon: Droplets },
              { k: "drawdown", label: "Sequencing", icon: Layers },
              { k: "btl", label: "Buy-to-let", icon: Building2 },
              { k: "stress", label: "Scenarios & stress", icon: ShieldAlert },
              { k: "adequacy", label: "Monte Carlo", icon: Activity },
              { k: "iht", label: "Inheritance tax", icon: Landmark },
            ].map(({ k, label, icon: Icon }) => {
              const active = tab === k;
              return (
                <button
                  key={k}
                  className="rp-tab"
                  onClick={() => setTab(k)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    border: "none",
                    background: "none",
                    cursor: "pointer",
                    padding: "10px 12px",
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
function ScenarioLibrary({ p, det, scenarios = [], setScenarios, setPlanInputs }) {
  const [name, setName] = useState("");
  const [confirmDel, setConfirmDel] = useState(null);
  // Deterministic quick metrics per scenario — the engine is fast and the
  // library is short, so this is fine to recompute on render.
  const metrics = useMemo(() => Object.fromEntries(scenarios.map((sc) => {
    try {
      const d = buildProjection({ ...DEFAULTS, ...sc.inputs });
      return [sc.id, { tax: d.totalTaxReal, lasts: d.depletionAge === null, depletion: d.depletionAge, estate: d.estateReal }];
    } catch { return [sc.id, null]; }
  })), [scenarios]);

  const save = () => {
    const n = name.trim();
    if (!n) return;
    setScenarios((prev) => {
      const existing = prev.find((s) => s.name === n);
      const entry = { id: existing ? existing.id : uid(), name: n, savedAt: todayISO(), inputs: { ...p } };
      return existing ? prev.map((s) => (s.id === existing.id ? entry : s)) : [...prev, entry];
    });
    setName("");
  };

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name this plan — e.g. Retire at 58"
          style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: "7px 9px", borderRadius: 8, border: `1px solid ${T.line}`, background: T.surface, color: T.ink }} />
        <button onClick={save} disabled={!name.trim()}
          style={{ background: T.ink, color: T.paper, border: "none", borderRadius: 8, padding: "7px 12px", fontWeight: 600, fontSize: 12.5, cursor: "pointer", opacity: name.trim() ? 1 : 0.5 }}>
          Save
        </button>
      </div>
      {scenarios.length === 0 && (
        <p style={{ margin: 0, fontSize: 11.5, color: T.muted, lineHeight: 1.5 }}>
          Save the current inputs under a name, tweak freely, and load back any time. Saved plans appear in the Monte Carlo "Compare against" picker (same random paths) and travel with backups and sync.
        </p>
      )}
      {scenarios.map((sc) => {
        const m = metrics[sc.id];
        const dTax = m ? m.tax - det.totalTaxReal : null;
        return (
          <div key={sc.id} style={{ border: `1px solid ${T.line}`, borderRadius: 9, padding: "8px 10px", display: "grid", gap: 3 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 12.5, fontWeight: 600, color: T.ink, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{sc.name}</span>
              <button onClick={() => setPlanInputs && setPlanInputs({ ...DEFAULTS, ...sc.inputs })} title="Replace the current plan inputs with this scenario"
                style={{ border: `1px solid ${T.line}`, background: "none", color: T.ink, borderRadius: 7, padding: "3px 9px", fontSize: 11.5, fontWeight: 600, cursor: "pointer" }}>Load</button>
              <button onClick={() => { if (confirmDel === sc.id) { setScenarios((prev) => prev.filter((s) => s.id !== sc.id)); setConfirmDel(null); } else setConfirmDel(sc.id); }}
                style={{ border: `1px solid ${confirmDel === sc.id ? T.red : T.line}`, background: "none", color: confirmDel === sc.id ? T.red : T.muted, borderRadius: 7, padding: "3px 9px", fontSize: 11.5, cursor: "pointer" }}>
                {confirmDel === sc.id ? "Sure?" : "✕"}
              </button>
            </div>
            <div style={{ fontSize: 11, color: T.muted, fontFamily: MONO }}>
              {sc.savedAt} · {m ? <>
                {m.lasts ? "lasts" : `gone at ${m.depletion}`} · tax {gbpK(m.tax)}
                {dTax != null && Math.abs(dTax) > 500 && <span style={{ color: dTax < 0 ? T.green : T.red }}> ({dTax < 0 ? "−" : "+"}{gbpK(Math.abs(dTax))} vs current)</span>}
              </> : "couldn't project"}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---- Phase 3.6: goals editor (one-off dated outflows) ---------------- */
function GoalsEditor({ p, det, setP }) {
  const goals = p.goals || [];
  const upd = (id, patch) => setP((x) => ({ ...x, goals: (x.goals || []).map((g) => (g.id === id ? { ...g, ...patch } : g)) }));
  const add = () => setP((x) => ({ ...x, goals: [...(x.goals || []), { id: uid(), label: "", age: Math.max(p.currentAge + 1, 60), amount: 20000, enabled: true }] }));
  const remove = (id) => setP((x) => ({ ...x, goals: (x.goals || []).filter((g) => g.id !== id) }));
  const eventFor = (g) => (det.goalEvents || []).find((e) => e.age === Math.round(+g.age) && e.label === (g.label || "Goal"));

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {goals.length === 0 && (
        <p style={{ margin: 0, fontSize: 11.5, color: T.muted, lineHeight: 1.5 }}>
          House deposit, university fees, a gift — one-off outflows in today's £ at a given age. Funded from ISA → GIA (→ LISA from 60) before retirement, never the pension; from retirement they join that year's spending and the drawdown pays them tax-aware.
        </p>
      )}
      {goals.map((g) => {
        const ev = g.enabled !== false ? eventFor(g) : null;
        return (
          <div key={g.id} style={{ border: `1px solid ${T.line}`, borderRadius: 9, padding: "8px 10px", display: "grid", gap: 6 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input value={g.label} onChange={(e) => upd(g.id, { label: e.target.value })} placeholder="House deposit"
                style={{ flex: 1, minWidth: 0, fontSize: 12.5, padding: "6px 8px", borderRadius: 7, border: `1px solid ${T.line}`, background: T.surface, color: T.ink }} />
              <button onClick={() => remove(g.id)} title="Remove goal" style={{ border: "none", background: "none", color: T.muted, cursor: "pointer", fontSize: 14 }}>✕</button>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              <label style={{ fontSize: 11.5, color: T.muted }}>Age{" "}
                <input type="number" value={g.age} min={p.currentAge + 1} max={p.planAge} onChange={(e) => upd(g.id, { age: +e.target.value || 0 })}
                  style={{ width: 54, fontSize: 12, padding: "4px 6px", borderRadius: 6, border: `1px solid ${T.line}`, background: T.surface, color: T.ink, fontFamily: MONO }} />
              </label>
              <label style={{ fontSize: 11.5, color: T.muted }}>£ today{" "}
                <input type="number" value={g.amount} min={0} step={1000} onChange={(e) => upd(g.id, { amount: +e.target.value || 0 })}
                  style={{ width: 90, fontSize: 12, padding: "4px 6px", borderRadius: 6, border: `1px solid ${T.line}`, background: T.surface, color: T.ink, fontFamily: MONO }} />
              </label>
              <label style={{ fontSize: 11.5, color: T.muted, display: "flex", alignItems: "center", gap: 4, cursor: "pointer" }}>
                <input type="checkbox" checked={g.enabled !== false} onChange={(e) => upd(g.id, { enabled: e.target.checked })} /> on
              </label>
            </div>
            {ev && (
              <div style={{ fontSize: 11, fontFamily: MONO, color: ev.shortfallNominal > 0 ? T.red : T.green }}>
                {ev.shortfallNominal > 0
                  ? `⚠ short by ${gbpK(ev.shortfallReal)} (today's £) — liquid pots can't cover it at ${g.age}`
                  : ev.phase === "accum" ? `funded from ISA/GIA at ${g.age} ✓` : `paid through drawdown at ${g.age} ✓`}
              </div>
            )}
          </div>
        );
      })}
      <button onClick={add}
        style={{ border: `1px dashed ${T.line}`, background: "none", color: T.ink2, borderRadius: 8, padding: "7px 10px", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
        + Add goal
      </button>
    </div>
  );
}

// The panel grew to ~17 sections (scenarios, goals, MC options, BTL…) —
// a wall nobody scrolls. Sections now collapse, with open-state persisted
// per section per browser; the core trio starts open, everything else
// starts closed. Optional sections whose feature is OFF (annuity/BTL
// toggles) still show their title, so discoverability survives collapse.
const PANEL_OPEN_DEFAULT = new Set(["Scenario library", "You & timing", "Money in"]);

function PanelSection({ title, children }) {
  const [open, setOpen] = useState(() => store.get(`plan.panel.${title}`, PANEL_OPEN_DEFAULT.has(title)));
  React.useEffect(() => { store.set(`plan.panel.${title}`, open); }, [open, title]);
  return (
    <div style={{ marginBottom: open ? 22 : 10 }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: "flex", alignItems: "center", justifyContent: "space-between",
          width: "100%", background: "none", border: "none", cursor: "pointer",
          padding: "0 0 6px", marginBottom: open ? 12 : 0,
          fontSize: 11, letterSpacing: ".08em", textTransform: "uppercase",
          color: T.gold, fontWeight: 700, textAlign: "left",
          borderBottom: `1px solid ${T.lineSoft}`,
        }}
      >
        <span>{title}</span>
        <span aria-hidden="true" style={{ color: T.muted, fontSize: 10 }}>{open ? "▾" : "▸"}</span>
      </button>
      {open && children}
    </div>
  );
}

function Legendlet({ items }) {
  return (
    <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginTop: 10 }}>
      {items.map((it, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12, color: T.ink2 }}>
          <span style={{ width: 16, height: 0, borderTop: `${it.dash ? "2px dashed" : "3px solid"} ${it.c}` }} />
          {it.t}
        </div>
      ))}
    </div>
  );
}

function Note({ children, tone = "amber" }) {
  const c = tone === "amber" ? T.amber : tone === "red" ? T.red : T.blue;
  const bg = tone === "amber" ? T.amberSoft : tone === "red" ? T.redSoft : T.blueSoft;
  return (
    <div
      style={{
        display: "flex",
        gap: 10,
        background: bg,
        border: `1px solid ${c}33`,
        borderRadius: 11,
        padding: "12px 15px",
        marginTop: 14,
        fontSize: 13,
        color: T.ink2,
        lineHeight: 1.5,
      }}
    >
      <Info size={16} color={c} style={{ flexShrink: 0, marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

/* ---- Accumulation tab ---- */
function AccumulationTab({ p, det, feeFree, feeDrag }) {
  const taxFn = p.region === "scotland" ? taxScot : taxRUK;
  const tax = taxFn(p.salary);
  const ni = employeeNI(p.salary);
  const empContrib = (p.salary * p.empPct) / 100;
  const erContrib = (p.salary * p.erPct) / 100;
  const reliefRate = marginalRate(p.salary, p.region);
  const reliefValue = empContrib * (reliefRate + 0.02); // tax + ~NI under sacrifice

  const accumData = det.timeline.filter((d) => d.phase === "accum").map((d, i) => ({
    age: d.age,
    contributions: det.wealthContribSchedule.slice(0, i + 1).reduce((a, b) => a + b, 0),
    pension: d.pension,
    bridge: d.bridge,
    real: d.potReal,
  }));
  const totalPensionContrib = det.contribSchedule.reduce((a, b) => a + b, 0);
  const totalIsaContrib = (p.isaContrib + p.giaContrib + Math.min(p.lisaContrib, 4000) * 1.25) * det.accumYears;
  const totalContrib = totalPensionContrib + totalIsaContrib;
  const startTotal = p.startPot + p.isaStart + p.giaStart + p.lisaStart;
  const growthPortion = det.wealthAtRetire - startTotal - totalContrib;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <Card><Stat label="Marginal tax rate" value={pct(reliefRate, 0)} sub="on your top £ of income" tone={reliefRate >= 0.6 ? "amber" : "ink"} /></Card>
        <Card><Stat label="Pension + ISA in / yr" value={gbp(det.firstContrib + p.isaContrib)} sub={`${gbp(det.firstContrib)} pension · ${gbp(p.isaContrib)} ISA`} /></Card>
        <Card><Stat label="Annual Allowance" value={gbp(det.aa)} sub={det.aaBreach ? "exceeded ⚠" : "within limit"} tone={det.aaBreach ? "red" : "green"} /></Card>
        <Card><Stat label="Tax + NI relief / yr" value={gbp(reliefValue)} sub="on pension contribution" tone="green" /></Card>
      </div>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>What builds your wealth</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Pension and ISA/GIA bridge grow side by side over {det.accumYears} years — the bridge is what lets you retire before {p.accessAge}.
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={accumData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), n === "pension" ? "Pension pot" : n === "bridge" ? "ISA/GIA bridge" : "Contributions paid in"]} labelFormatter={(a) => `Age ${a}`} />
            <Area type="monotone" dataKey="pension" stackId="w" stroke={T.green} strokeWidth={2} fill={T.greenSoft} name="pension" />
            <Area type="monotone" dataKey="bridge" stackId="w" stroke={T.gold} strokeWidth={2} fill={T.amberSoft} name="bridge" />
            <Area type="monotone" dataKey="contributions" stroke={T.blue} strokeWidth={1.4} fill="none" name="contributions" />
          </AreaChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.green, t: "Pension pot" }, { c: T.gold, t: "ISA/GIA bridge" }, { c: T.blue, t: "Contributions paid in" }]} />
      </Card>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px,1fr))", gap: 12, marginTop: 14 }}>
        <Card>
          <h4 style={{ margin: "0 0 10px", fontSize: 13.5 }}>Wealth composition at retirement</h4>
          <Barline label="Starting balances" value={startTotal} total={det.wealthAtRetire} color={T.muted} />
          <Barline label="Contributions" value={totalContrib} total={det.wealthAtRetire} color={T.blue} />
          <Barline label="Investment growth" value={growthPortion} total={det.wealthAtRetire} color={T.green} />
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 10, paddingTop: 10, display: "flex", justifyContent: "space-between", fontFamily: MONO, fontWeight: 700 }}>
            <span>Total</span><span>{gbp(det.wealthAtRetire)}</span>
          </div>
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
            Split: {gbp(det.potAtRetire)} pension · {gbp(det.bridgeAtRetire)} ISA/bridge.
          </div>
        </Card>
        <Card>
          <h4 style={{ margin: "0 0 10px", fontSize: 13.5 }}>Current take-home</h4>
          <Row l="Gross salary" v={gbp(p.salary)} />
          <Row l="Income tax" v={"−" + gbp(tax)} neg />
          <Row l="Employee NI" v={"−" + gbp(ni)} neg />
          <Row l="Your pension" v={"−" + gbp(empContrib)} neg />
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 8, paddingTop: 8 }}>
            <Row l="Net take-home" v={gbp(det.preNetToday)} bold />
          </div>
          <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
            Employer adds {gbp(erContrib)} on top, outside your take-home.
          </div>
        </Card>
      </div>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Fee drag: {p.fee}% vs DIY (0%)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          A {p.fee}% annual fee compounds against you. Same contributions and market returns, only the charge differs.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12, marginBottom: 6 }}>
          <Stat label={`Wealth @ ${p.fee}% fee`} value={gbpK(det.wealthAtRetire)} tone="ink" />
          <Stat label="Wealth @ 0% (DIY)" value={gbpK(feeFree.wealthAtRetire)} tone="green" />
          <Stat label="Cost of fees" value={gbpK(feeDrag)} sub={`${pct(feeDrag / Math.max(1, feeFree.wealthAtRetire), 1)} of pot surrendered`} tone="red" />
        </div>
        <div style={{ height: 8, background: T.greenSoft, borderRadius: 4, overflow: "hidden", marginTop: 6 }}>
          <div style={{ width: pct(det.wealthAtRetire / Math.max(1, feeFree.wealthAtRetire)), height: "100%", background: T.green }} />
        </div>
        <div style={{ fontSize: 11.5, color: T.muted, marginTop: 8 }}>
          Over {det.accumYears} years, fees quietly take {gbp(feeDrag)} off your retirement pot — before you've drawn a penny. The drag continues through retirement too.
        </div>
      </Card>
    </div>
  );
}

function Barline({ label, value, total, color }) {
  const w = Math.max(0, Math.min(100, (value / total) * 100));
  return (
    <div style={{ marginBottom: 9 }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 4 }}>
        <span style={{ color: T.ink2 }}>{label}</span>
        <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums" }}>{gbp(value)}</span>
      </div>
      <div style={{ height: 7, background: T.lineSoft, borderRadius: 4 }}>
        <div style={{ width: w + "%", height: "100%", background: color, borderRadius: 4 }} />
      </div>
    </div>
  );
}
// tiny labelled row
function Row({ l, v, neg, bold }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0" }}>
      <span style={{ color: bold ? T.ink : T.ink2, fontWeight: bold ? 700 : 400 }}>{l}</span>
      <span style={{ fontFamily: MONO, fontVariantNumeric: "tabular-nums", color: neg ? T.red : T.ink, fontWeight: bold ? 700 : 500 }}>{v}</span>
    </div>
  );
}

function marginalRate(income, region) {
  const fn = region === "scotland" ? taxScot : taxRUK;
  const d = 100;
  return (fn(income + d) - fn(income)) / d;
}

/* ---- Decumulation tab ---- */
function DecumulationTab({ p, det, retireRow }) {
  const decData = det.timeline
    .filter((d) => d.phase === "decum")
    .map((d) => ({
      age: d.age,
      pension: d.pensionDrawReal || 0,
      bridge: d.bridgeDrawReal || 0,
      state: d.stateReal || 0,
      db: d.dbReal || 0,
      annuity: d.annuityReal || 0,
      btl: d.btlNetReal || 0,
      spend: d.spendReal || 0,
      pensionPot: d.pensionReal,
      bridgePot: d.bridgeReal,
    }));
  const taxFn = p.region === "scotland" ? taxScot : taxRUK;

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <Card><Stat label="Yr-1 gross income" value={gbp(det.firstYearGross)} sub={det.firstYearBridgeDraw > 1 ? "pension + wrappers + State" : "pension + State Pension"} /></Card>
        <Card><Stat label="Yr-1 tax" value={gbp(det.firstYearTax)} sub="income tax + any CGT" tone="amber" /></Card>
        <Card><Stat label="Yr-1 net" value={gbp(det.firstYearNet)} sub="spendable, nominal" tone="green" /></Card>
        <Card><Stat label="Drawdown order" value={STRATEGY_LABELS[p.drawStrategy]} sub="see Sequencing tab" tone="ink" /></Card>
      </div>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Where retirement income comes from</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          In today's money. The dashed line is your target spend — useful when the spending profile isn't flat.
        </p>
        <ResponsiveContainer width="100%" height={300}>
          <ComposedChart data={decData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }} barCategoryGap={1}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), { pension: "Pension", bridge: "ISA/GIA/LISA", state: "State Pension", db: "DB pension", annuity: "Annuity", btl: "BTL net rent", spend: "Target spend" }[n]]} labelFormatter={(a) => `Age ${a}`} />
            <Bar dataKey="bridge" stackId="a" fill={T.gold} name="bridge" />
            <Bar dataKey="pension" stackId="a" fill={T.green} name="pension" />
            {p.annuityEnabled && <Bar dataKey="annuity" stackId="a" fill="#7A5C9E" name="annuity" />}
            {p.dbEnabled && <Bar dataKey="db" stackId="a" fill={T.ink2} name="db" />}
            {det.btlEnabled && <Bar dataKey="btl" stackId="a" fill="#B0884E" name="btl" />}
            <Bar dataKey="state" stackId="a" fill={T.blue} name="state" />
            <Line type="monotone" dataKey="spend" stroke={T.red} strokeWidth={1.6} strokeDasharray="4 3" dot={false} name="spend" />
          </ComposedChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.gold, t: "ISA/GIA/LISA" }, { c: T.green, t: "Pension" }, ...(p.annuityEnabled ? [{ c: "#7A5C9E", t: "Annuity" }] : []), ...(p.dbEnabled ? [{ c: T.ink2, t: "DB" }] : []), ...(det.btlEnabled ? [{ c: "#B0884E", t: "BTL" }] : []), { c: T.blue, t: "State" }, { c: T.red, t: "Target spend", dash: true }]} />
      </Card>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Pots run-down (real terms)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          {det.depletionAge ? `Combined wealth can't sustain the target from age ${det.depletionAge}.` : `Both pots sustain the target to age ${p.planAge}.`} The ISA/bridge is usually drawn first.
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <AreaChart data={decData} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), n === "pensionPot" ? "Pension pot" : "ISA/bridge"]} labelFormatter={(a) => `Age ${a}`} />
            {det.depletionAge && <ReferenceLine x={det.depletionAge} stroke={T.red} strokeDasharray="4 3" />}
            <Area type="monotone" dataKey="pensionPot" stackId="p" stroke={T.green} strokeWidth={2} fill={T.greenSoft} name="pensionPot" />
            <Area type="monotone" dataKey="bridgePot" stackId="p" stroke={T.gold} strokeWidth={2} fill={T.amberSoft} name="bridgePot" />
          </AreaChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.green, t: "Pension pot" }, { c: T.gold, t: "ISA/bridge" }]} />
      </Card>

      <Note tone="blue">
        {p.tfcMode === "ufpls"
          ? "Tax-free cash is spread UFPLS-style (25% of each pension withdrawal is tax-free). "
          : `25% (${gbp(det.pclsAmount)}) was taken upfront into the ISA/bridge, so pension withdrawals here are fully taxable. `}
        The drawdown waterfall fills the basic-rate band from the pension first, then tops up from the tax-free bridge to avoid higher-rate tax — and the bridge is the only source before age {p.accessAge}. Tax thresholds are assumed to rise with CPI, so tax stays roughly constant in real terms.
      </Note>
    </div>
  );
}

/* ---- Drawdown sequencing optimiser ---- */
/* ===================== INCOME FLOOR ===================== */
// Guaranteed income (State Pension + DB + annuity + the gilt ladder's
// contractual cashflows) stacked against the essential share of target
// spending, per retirement year — core/income-floor.mjs. A different
// question to Monte Carlo's "will the pot last?": this asks "if markets
// fell apart, what still gets paid?". BTL rent is deliberately excluded
// (voids/arrears make it contingent — see the module header); gilt
// cashflows are only the gilts held TODAY, so the ladder visibly runs out
// rather than being smoothed away.
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
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), { state: "State Pension", db: "DB pension", annuity: "Annuity", gilt: "Gilt ladder cashflow", essential: "Essential spend", spend: "Target spend" }[n] || n]} labelFormatter={(a) => `Age ${a}`} />
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
    deferredByYear: inputs.deferredByYear, rsuByYear: inputs.rsuByYear,
    annualDividends: +forwardDividends || 0,
  }), [expense, horizon, p, startYear, inputs, forwardDividends]);

  const s = runoff.summary;
  // Deflate for display when in today's-£ mode (engine stays nominal).
  const deflate = (row, v) => realTerms ? v / Math.pow(1 + effInflation(p) / 100, row.year - startYear) : v;
  const displayRows = runoff.rows.map((r) => {
    const d = { ...r };
    for (const k of ["expense", "fromGilts", "fromCash", "fromDeferred", "fromRsu", "fromDividends", "fromPortfolio", "surplusToCash", "giltBankEnd", "cashEnd", "giltIn", "deferredIn", "rsuIn", "divIn", "totalIn", "net", "balanceEnd"]) d[k] = deflate(r, r[k]);
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
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "center" }}>
          <Field label="Annual spend (today's £)" value={expense} min={0} max={500000} step={1000} prefix="£" onChange={setExpense} />
          <Field label="Horizon (years)" value={horizon} min={1} max={40} onChange={setHorizon} />
          <div>
            <div style={{ fontSize: 11.5, color: T.ink2, fontWeight: 600, marginBottom: 4 }}>Display</div>
            <Segmented value={realTerms ? "real" : "nominal"} onChange={(v) => setRealTerms(v === "real")} accent={T.blue}
              options={[{ value: "real", label: "Today's £" }, { value: "nominal", label: "Nominal £" }]} />
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
            <Card><Stat label="Total sold over horizon" value={gbpK(s.totalFromPortfolio)} sub={`${s.coveredYears}/${s.totalYears} years need no sales`} /></Card>
            <Card><Stat label="Gilt ladder ends" value={s.giltLadderEndsYear ?? "no gilts"} sub={s.cashExhaustedYear ? `cash float gone ${s.cashExhaustedYear}` : "cash float never exhausted"} /></Card>
          </div>

          <Card style={{ marginBottom: 14 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: T.ink }}>
                {chartView === "flow" ? "Cash flow — what arrives vs what you spend" : "Funding waterfall — what covers each year"} — {realTerms ? "today's £" : "nominal £"}
              </div>
              <Segmented value={chartView} onChange={setChartView} accent={T.blue}
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
                    <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), Object.fromEntries(SOURCES.map(([k, l]) => [k, l]))[n] || (n === "expense" ? "Spend" : n)]} labelFormatter={(y) => `Year ${y}`} />
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
                        <td style={{ padding: "7px 10px", textAlign: "right", fontFamily: MONO, color: r.fromPortfolio > 0 ? T.red : T.muted }}>
                          {r.fromPortfolio > 0 ? gbpK(r.fromPortfolio) : "—"}
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
              RSUs assume SELL-ON-VEST at today's price ({inputs.rsuUnpriced > 0 ? `${inputs.rsuUnpriced} unpriced vest(s) excluded — set the ticker's price` : "no price forecasting"}); vested-and-held shares are already inside the portfolio, so they're deliberately not a source here.
              RSU vests and deferred-cash tranches are shown NET of tax — marginal UK income-tax bands + employee NI, taxed jointly per year on top of your plan salary while working ({inputs.compTaxRate > 0 ? `effective ${Math.round(inputs.compTaxRate * 100)}% over the horizon` : "none scheduled"}).
              Dividends are held flat at {gbpK(+forwardDividends || 0)}/yr — trailing 12-month income per unit × units held TODAY (so recent buys raise it above last year's cash received), EXCLUDING gilt coupons (those are already in the ladder), and assumed tax-free (ISA/VCT holdings; GIA dividends would bear dividend tax not modelled here). No growth, and no shrinkage as later sales reduce the portfolio: that circularity is disclosed rather than half-modelled.
              Gilts are conventional only: coupons + redemption at PAR, contractual nominal £ with no indexation — index-linked gilts are not modelled. Deferred cash and gilt cashflows are contractual schedules from their own tabs.
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
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), { pension: "Pension", bridge: "ISA/GIA/LISA", state: "State Pension", db: "DB pension", annuity: "Annuity", btl: "BTL net rent" }[n]]} labelFormatter={(a) => `Age ${a}`} />
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
function BtlTab({ p, det, set }) {
  if (!p.btlEnabled) {
    return (
      <div style={{ textAlign: "center", padding: "50px 20px", color: T.muted }}>
        <Building2 size={34} color={T.line} />
        <p style={{ marginTop: 12, fontSize: 14 }}>No buy-to-let in the plan yet.</p>
        <button
          onClick={() => set("btlEnabled", true)}
          style={{ marginTop: 4, background: T.ink, color: T.paper, border: "none", borderRadius: 10, padding: "10px 18px", fontWeight: 600, fontSize: 14, cursor: "pointer" }}
        >
          Add a BTL property
        </button>
      </div>
    );
  }
  // year-1 of retirement, taken straight from the engine (actual marginal tax)
  const s = det.btlSeries.filter((x) => x.value > 0);
  const b0 = s[0] || det.btlSeries[0] || { rent: 0, opex: 0, interest: 0, cashProfit: 0, taxableProfit: 0, tax: 0, net: 0, marginal: 0, value: 0, equity: 0 };

  // property value/equity over the whole plan (real), drops to 0 after a sale
  const series = [];
  for (let i = 0; i <= p.planAge - p.currentAge; i++) {
    const age = p.currentAge + i;
    const inflF = Math.pow(1 + det.infl, i);
    const sold = p.btlSellAge && age >= p.btlSellAge;
    const b = btlYearly(p, i);
    series.push({
      age,
      value: sold ? 0 : b.value / inflF,
      equity: sold ? 0 : b.equity / inflF,
    });
  }

  return (
    <div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px,1fr))", gap: 12, marginBottom: 18 }}>
        <Card><Stat label="Gross rent / yr" value={gbp(b0.rent)} sub="year 1 of retirement, real" /></Card>
        <Card><Stat label="Net income after tax" value={gbp(b0.net)} sub={`taxed at your ${pct(b0.marginal, 0)} marginal rate`} tone={b0.net > 0 ? "green" : "red"} /></Card>
        <Card><Stat label="Mortgage interest" value={gbp(b0.interest)} sub={`${p.btlRate}% interest-only`} tone="amber" /></Card>
        <Card><Stat label="Equity at retirement" value={gbpK(b0.equity)} sub={`value ${gbpK(b0.value)}`} /></Card>
      </div>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Year-1 rental cashflow (at retirement)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Gross rent to net income, with Section 24 applied and the tax computed at your <strong>actual marginal rate that year</strong> ({pct(b0.marginal, 0)}), not a flat assumption.
        </p>
        <div style={{ maxWidth: 470 }}>
          <Row l="Gross rent" v={gbp(b0.rent)} />
          <Row l="Maintenance / management / voids" v={"−" + gbp(b0.opex)} neg />
          <Row l="Mortgage interest" v={"−" + gbp(b0.interest)} neg />
          <div style={{ borderTop: `1px solid ${T.line}`, margin: "6px 0", paddingTop: 6 }}>
            <Row l="Cash profit" v={gbp(b0.cashProfit)} bold />
          </div>
          <Row l="Taxable profit (interest not deductible)" v={gbp(b0.taxableProfit)} />
          <Row l={`Tax at ${pct(b0.marginal, 0)} less 20% interest credit`} v={"−" + gbp(b0.tax)} neg />
          <div style={{ borderTop: `1px solid ${T.line}`, marginTop: 6, paddingTop: 6 }}>
            <Row l="Net income to you" v={gbp(b0.net)} bold />
          </div>
        </div>
        <Note tone="amber">
          The marginal rate is recomputed every year: as the State Pension starts and pension drawdown rises, your rental profit can be pushed from basic into higher rate, so net BTL income shifts over time. Section 24 means interest isn't deductible — you only get a 20% credit — which is what makes a higher-rate landlord's effective rate so punishing.
        </Note>
      </Card>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>BTL marginal rate & net income through retirement</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Net rental income (real) and the marginal rate it's taxed at, year by year.
        </p>
        <ResponsiveContainer width="100%" height={240}>
          <ComposedChart data={s} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={3} />
            <YAxis yAxisId="l" tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={48} />
            <YAxis yAxisId="r" orientation="right" tickFormatter={(v) => pct(v, 0)} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={40} domain={[0, 0.5]} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [n === "marginal" ? pct(v, 0) : gbp(v), n === "marginal" ? "Marginal rate" : "Net income"]} labelFormatter={(a) => `Age ${a}`} />
            <Bar yAxisId="l" dataKey="net" fill="#7A5C9E" name="net" radius={[3, 3, 0, 0]} />
            <Line yAxisId="r" type="stepAfter" dataKey="marginal" stroke={T.amber} strokeWidth={2} dot={false} name="marginal" />
          </ComposedChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: "#7A5C9E", t: "Net rental income (real)" }, { c: T.amber, t: "Marginal tax rate" }]} />
      </Card>

      <Card style={{ marginTop: 14 }}>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Property value & equity (real terms)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          {p.btlSellAge ? `Sold at age ${p.btlSellAge} — net proceeds flow into your drawdown pool.` : `Held for life at ${p.btlGrowth}% capital growth on a ${gbpK(p.btlMortgage)} interest-only loan.`}
        </p>
        <ResponsiveContainer width="100%" height={260}>
          <AreaChart data={series} margin={{ top: 10, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid stroke={T.lineSoft} vertical={false} />
            <XAxis dataKey="age" tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={{ stroke: T.line }} interval={4} />
            <YAxis tickFormatter={gbpK} tick={{ fontSize: 11, fill: T.muted }} tickLine={false} axisLine={false} width={52} />
            <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), n === "value" ? "Property value" : "Your equity"]} labelFormatter={(a) => `Age ${a}`} />
            <ReferenceLine x={p.retireAge} stroke={T.amber} strokeDasharray="4 3" label={{ value: "Retire", position: "top", fontSize: 10, fill: T.amber }} />
            {det.btlSaleAge && <ReferenceLine x={det.btlSaleAge} stroke={T.red} strokeDasharray="4 3" label={{ value: "Sell", position: "top", fontSize: 10, fill: T.red }} />}
            <Area type="monotone" dataKey="value" stroke={T.blue} strokeWidth={1.6} fill={T.blueSoft} name="value" />
            <Area type="monotone" dataKey="equity" stroke={T.green} strokeWidth={2} fill={T.greenSoft} name="equity" />
          </AreaChart>
        </ResponsiveContainer>
        <Legendlet items={[{ c: T.blue, t: "Property value" }, { c: T.green, t: "Your equity" }]} />
      </Card>

      {det.btlSaleAge ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px,1fr))", gap: 12, marginTop: 14 }}>
          <Card><Stat label={`Sold at ${det.btlSaleAge}`} value={gbpK(det.btlSaleProceeds)} sub="net proceeds into drawdown" tone="green" /></Card>
          <Card><Stat label="Capital gain realised" value={gbpK(det.btlSaleGain)} sub="value − purchase price" /></Card>
          <Card><Stat label="CGT paid" value={gbpK(det.btlSaleCGT)} sub="18% / 24% residential" tone="red" /></Card>
        </div>
      ) : (
        <Note tone="blue">
          You're holding the property for life, so the rent feeds your income and the equity ({gbpK(b0.equity)} now) sits outside the drawdown model. Set a "sell at age" to convert the property into spendable capital — CGT at 18%/24% is then applied and the net proceeds are added to your tax-free drawdown pool.
        </Note>
      )}

      <Note tone="amber">
        Simplifications: interest-only mortgage, CGT base cost set to your "original purchase price" input, and proceeds treated as tax-free drawable capital thereafter. Ignores SDLT and the 3% surcharge already paid, letting-relief edge cases, and incorporation. Rental income stacks with your other income for the marginal-rate calculation each year.
      </Note>
    </div>
  );
}

/* ---- Stress / scenarios tab ---- */
/* ---- Phase 3.5: sequence-risk heatmap (core/sequence-heatmap.mjs) ----
   One cell per historical start year: would THIS plan's withdrawal
   schedule have survived retiring into that year's actual sequence of
   returns and inflation? Raw history (minus your fee), withdrawals
   re-priced along each window's real inflation. */
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
            <Tooltip contentStyle={tooltipStyle()} formatter={(v) => [gbp(v), "Wealth at retirement (real)"]} />
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
          <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), n === "base" ? "Base plan" : "With crash"]} labelFormatter={(a) => `Age ${a}`} />
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
          <Segmented value={p.mcModel || "single"} onChange={(v) => set("mcModel", v)} accent={T.green}
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
          <Segmented value={compareKey} onChange={setCompareKey} options={compareOptions} accent={T.blue} />
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
                <Tooltip contentStyle={tooltipStyle()} formatter={(v, n) => [gbp(v), { aP90: "Lucky (90th, A)", aP50: "Median (A)", aP10: "Unlucky (10th, A)", bP90: "Lucky (90th, B)", bP50: "Median (B)", bP10: "Unlucky (10th, B)" }[n] || n]} labelFormatter={(a) => `Age ${a}`} />
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
function IhtTab({ p, det, set, liveEstate, livePots }) {
  const [giftForm, setGiftForm] = useState({ date: "", amount: "", exempt: false, note: "" });
  const todayISO = useMemo(() => new Date().toISOString().slice(0, 10), []);
  const planEndISO = useMemo(() => {
    const years = Math.max(0, (p.planAge || 0) - (p.currentAge || 0));
    const d = new Date();
    d.setUTCFullYear(d.getUTCFullYear() + years);
    return d.toISOString().slice(0, 10);
  }, [p.planAge, p.currentAge]);

  // Individual primitives (not one object literal) as the useMemo deps
  // below, so the two projections only recompute when something that
  // actually feeds `projectIHT()` changes — not on every render.
  const ihtMainResidenceToDescendants = p.ihtMainResidenceToDescendants;
  const ihtMarried = p.ihtMarried;
  const ihtCharityPct = (p.ihtCharityPct || 0) / 100;
  const ihtBusinessAgriculturalValue = p.ihtBusinessAgriculturalValue || 0;
  const ihtGifts = p.ihtGifts || [];

  const todayResult = useMemo(() => {
    const investedValue = (livePots?.ISA || 0) + (livePots?.GIA || 0) + (livePots?.LISA || 0);
    return projectIHT({
      mainResidenceToDescendants: ihtMainResidenceToDescendants,
      married: ihtMarried,
      charityGiftPct: ihtCharityPct,
      businessAgriculturalValue: ihtBusinessAgriculturalValue,
      gifts: ihtGifts,
      investedValue,
      pensionValue: livePots?.SIPP || 0,
      propertyEquity: liveEstate?.propertyEquity || 0,
      privateValue: liveEstate?.privateValue || 0,
      rsuValue: liveEstate?.rsuValue || 0,
      otherLiabilities: liveEstate?.otherLiabilities || 0,
      creditCardDebt: liveEstate?.creditCardDebt || 0,
      asOfDate: todayISO,
    });
  }, [livePots, liveEstate, ihtMainResidenceToDescendants, ihtMarried, ihtCharityPct, ihtBusinessAgriculturalValue, ihtGifts, todayISO]);

  const futureResult = useMemo(() => {
    const lastRow = det.timeline[det.timeline.length - 1] || {};
    const pensionValue = Math.max(0, lastRow.pensionReal || 0);
    // det.estateReal already bundles pension + bridge (ISA/GIA/LISA) + BTL
    // equity (if unsold) + other net worth into one real-terms figure —
    // subtracting the pension-only piece leaves everything else in one
    // clean "invested + other" number, which is all projectIHT needs
    // (it just sums whatever it's given; it doesn't care which named
    // field a given £ arrives in).
    const investedValue = Math.max(0, (det.estateReal || 0) - pensionValue);
    return projectIHT({
      mainResidenceToDescendants: ihtMainResidenceToDescendants,
      married: ihtMarried,
      charityGiftPct: ihtCharityPct,
      businessAgriculturalValue: ihtBusinessAgriculturalValue,
      gifts: ihtGifts,
      investedValue,
      pensionValue,
      asOfDate: planEndISO,
    });
  }, [det, ihtMainResidenceToDescendants, ihtMarried, ihtCharityPct, ihtBusinessAgriculturalValue, ihtGifts, planEndISO]);

  const addGift = () => {
    const amount = +giftForm.amount;
    if (!giftForm.date || !Number.isFinite(amount) || amount <= 0) return;
    const gift = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, date: giftForm.date, amount, exempt: giftForm.exempt, note: giftForm.note.trim() };
    set("ihtGifts", [...(p.ihtGifts || []), gift]);
    setGiftForm({ date: "", amount: "", exempt: false, note: "" });
  };
  const removeGift = (id) => set("ihtGifts", (p.ihtGifts || []).filter((g) => g.id !== id));

  const EstateCard = ({ title, sub, r }) => (
    <Card style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, marginBottom: 2 }}>
        <div>
          <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>{title}</h3>
          <p style={{ margin: 0, fontSize: 12.5, color: T.muted }}>{sub}</p>
        </div>
        <span style={{
          fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 20,
          background: r.pensionCounted ? T.amberSoft : T.greenSoft,
          color: r.pensionCounted ? T.amber : T.green,
        }}>
          {r.pensionCounted ? "Pension IN estate" : "Pension excluded"}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px,1fr))", gap: 12, marginTop: 12 }}>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="Gross estate" value={gbpK(r.deathEstate)} sub={r.pensionCounted ? `incl. ${gbpK(r.pensionInEstateValue)} pension` : "pension excluded"} /></Card>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="NRB + RNRB available" value={gbpK(r.bandsAvailable)} sub={r.married ? "married — both bands doubled" : "single"} /></Card>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="Taxable estate" value={gbpK(r.netTaxableEstate)} sub={`at ${pct(r.rate, 0)}`} /></Card>
        <Card style={{ background: r.totalIHT > 0 ? T.redSoft : T.greenSoft, border: "none" }}>
          <Stat big label="IHT due" value={gbp(r.totalIHT)} sub={`${pct(r.effectiveRate, 1)} effective rate`} tone={r.totalIHT > 0 ? "red" : "green"} />
        </Card>
        <Card style={{ background: T.paper, border: "none" }}><Stat label="Net to heirs" value={gbpK(r.netEstateToHeirs)} sub={r.charityGiftAmount > 0 ? `after ${gbpK(r.charityGiftAmount)} to charity` : undefined} /></Card>
      </div>
      {r.giftTaxDue > 0 && (
        <div style={{ marginTop: 10, fontSize: 12, color: T.amber }}>
          + {gbp(r.giftTaxDue)} additional tax on lifetime gifts within 7 years (typically borne by the recipients, not the estate).
        </div>
      )}
    </Card>
  );

  return (
    <div>
      <Card style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <Landmark size={17} color={T.ink} />
          <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Inheritance tax projection</h3>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: T.muted, maxWidth: 680 }}>
          Nil-rate band £{(325000).toLocaleString("en-GB")} + residence nil-rate band £{(175000).toLocaleString("en-GB")} (tapered above a £2m estate), 40% on the excess (36% if 10%+ of the taxable estate goes to charity). Doesn't model the annual £3,000 gift exemption, so lifetime gifting looks slightly less sheltered here than it would with proper planning — a conservative simplification, not an optimistic one. Unused pension funds join the taxable estate for deaths on or after {PENSIONS_IN_ESTATE_FROM} — which is why "today" and "at your plan's end" below usually look structurally different, not just bigger.
        </p>
      </Card>

      <EstateCard title="Your estate today" sub={`As of ${todayISO}, from your live portfolio`} r={todayResult} />
      <EstateCard title={`At your plan's final year (age ${p.planAge})`} sub={`Projected ${planEndISO}, from the Overview projection`} r={futureResult} />

      <Card style={{ marginBottom: 14 }}>
        <h3 style={{ margin: "0 0 12px", fontSize: 15, fontWeight: 700 }}>Assumptions</h3>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px,1fr))", gap: 18 }}>
          <div>
            <Toggle label="Married / civil partnership" checked={p.ihtMarried} onChange={(v) => set("ihtMarried", v)} />
            <div style={{ fontSize: 11, color: T.muted, margin: "4px 0 14px" }}>Assumes a spouse who's used none of their own NRB/RNRB — doubles both bands. The real transferable fraction depends on their estate, which isn't modelled here.</div>
            <Toggle label="Main home passes to children/grandchildren" checked={p.ihtMainResidenceToDescendants} onChange={(v) => set("ihtMainResidenceToDescendants", v)} />
            <div style={{ fontSize: 11, color: T.muted, margin: "4px 0 0" }}>Required for the residence nil-rate band to apply at all.</div>
          </div>
          <div>
            <Field label="Left to charity" value={p.ihtCharityPct} min={0} max={100} step={1} suffix="%" onChange={(v) => set("ihtCharityPct", v)} hint="10%+ of the taxable estate drops the rate to 36%" />
            <Field label="Business/agricultural property (BPR/APR)" value={p.ihtBusinessAgriculturalValue} min={0} max={10000000} step={10000} prefix="£" onChange={(v) => set("ihtBusinessAgriculturalValue", v)} hint="100% relief up to £2.5m from April 2026, 50% above" />
          </div>
        </div>
      </Card>

      <Card>
        <h3 style={{ margin: "0 0 2px", fontSize: 15, fontWeight: 700 }}>Lifetime gifts (PETs)</h3>
        <p style={{ margin: "0 0 12px", fontSize: 12.5, color: T.muted }}>
          Gifts drop out of your estate entirely after 7 years; within 7 years, tax on the excess over your remaining nil-rate band tapers down the closer to 7 years you get. Mark a gift "exempt" if it went to a spouse/civil partner or registered charity — those are always outside IHT.
        </p>
        {(p.ihtGifts || []).length > 0 && (
          <div style={{ marginBottom: 12 }}>
            {(p.ihtGifts || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1)).map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `1px solid ${T.lineSoft}`, fontSize: 13 }}>
                <span style={{ color: T.muted, width: 92 }}>{g.date}</span>
                <span style={{ fontWeight: 600, width: 100 }} className="num">{gbp(g.amount)}</span>
                {g.exempt && <span style={{ fontSize: 10.5, fontWeight: 700, color: T.green, background: T.greenSoft, padding: "2px 8px", borderRadius: 10 }}>EXEMPT</span>}
                <span style={{ color: T.muted, flex: 1 }}>{g.note}</span>
                <button onClick={() => removeGift(g.id)} title="Remove" style={{ border: "none", background: "none", cursor: "pointer", color: T.red, display: "flex" }}>
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Date</div>
            <input type="date" value={giftForm.date} onChange={(e) => setGiftForm({ ...giftForm, date: e.target.value })}
              style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 9px", fontSize: 13, background: T.surface, color: T.ink }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Amount (£)</div>
            <input type="number" min="0" step="1000" value={giftForm.amount} onChange={(e) => setGiftForm({ ...giftForm, amount: e.target.value })}
              style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 9px", fontSize: 13, width: 110, background: T.surface, color: T.ink }} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: T.muted, marginBottom: 4 }}>Note (optional)</div>
            <input type="text" value={giftForm.note} onChange={(e) => setGiftForm({ ...giftForm, note: e.target.value })} placeholder="e.g. deposit for daughter's house"
              style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: "7px 9px", fontSize: 13, width: 220, background: T.surface, color: T.ink }} />
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: T.ink2, paddingBottom: 8 }}>
            <input type="checkbox" checked={giftForm.exempt} onChange={(e) => setGiftForm({ ...giftForm, exempt: e.target.checked })} />
            Exempt (spouse/charity)
          </label>
          <button onClick={addGift} style={{ display: "flex", alignItems: "center", gap: 6, background: T.ink, color: T.paper, border: "none", borderRadius: 9, padding: "8px 14px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}>
            <Plus size={14} /> Add gift
          </button>
        </div>
      </Card>

      <Note tone="amber">
        Estimates only, not a substitute for professional estate planning advice — real IHT positions involve trusts, business/agricultural relief eligibility tests, and a transferable-band calculation that depends on a spouse's own estate, none of which this simplified model can verify. Figures are today's rules and thresholds; NRB/RNRB are frozen to April 2031 but nothing is guaranteed to stay the same at your plan's final year, decades away.
      </Note>
    </div>
  );
}
