/* Plan tab scenario machinery and input defaults — the adapter layer between
   this tab's flat `p`/`det` shapes and the pure engines in core/. Extracted
   from PlanTab.jsx during the file split; no behaviour change. */
import React, { useState, useMemo } from "react";
import { Plus, Trash2 } from "lucide-react";
import { T, MONO, SANS, gbp, gbpK, pct } from "./theme.js";
import { Card, Field } from "./controls.jsx";
import { uid, todayISO } from "../../ui/shared.jsx";
import { buildProjection, effInflation, HIST } from "../../core/drawdown.mjs";
import { TWO_ASSET_DEFAULTS, bootstrapPairs } from "../../core/monte-carlo.mjs";

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

export { mcInputsFromPlan, applyScenario, SCENARIOS, DEFAULTS, ScenarioLibrary, GoalsEditor };
