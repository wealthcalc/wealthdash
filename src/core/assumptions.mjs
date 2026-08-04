/* ======================================================================
   ASSUMPTIONS REGISTRY — one place that knows every estimate this app makes,
   what it drives, and what the user has overridden.

   The problem this solves: the dashboard is full of small, defensible
   assumptions (a 2% equity yield here, a 0.5 realisation discount there,
   3% inflation in the plan). Each was disclosed where it was used, which is
   honest but scattered — there was no way to answer "what is this app
   assuming on my behalf, and what happens if I disagree?" without reading
   the source. This registry is the answer, and the UI renders straight off
   it, so a new assumption shows up simply by being listed here.

   Two kinds of entry, deliberately:
   - `home: "assumptions"` — this registry OWNS the value. Editable here,
     stored in the `assumptionOverrides` map, and read by the engines.
   - `home: "plan"` — the value already has a proper editor (the Plan tab's
     own inputs). Shown here READ-ONLY with a pointer, because two editors
     writing one number is how figures start disagreeing between tabs.

   Overrides are stored sparsely: only what the user actually changed, so
   defaults can be improved later without silently overwriting real choices.
   Pure and node-tested (assumptions.test.mjs).
   ====================================================================== */

const r2 = (x) => Math.round(x * 100) / 100;

// Every assumption, grouped for display. `drives` is the honest bit: what
// visibly changes when this number changes.
export const ASSUMPTIONS = [
  // --- Asset location: per-instrument-kind income yield and growth -------
  {
    id: "yield.equity", group: "Expected returns", home: "assumptions",
    label: "Equity / fund income yield", unit: "%", def: 2.0, min: 0, max: 15, step: 0.1,
    drives: ["Tax → Location: annual GIA drag, and which holdings it says to shelter"],
    note: "Only used where a holding has NO real payment history — actual trailing-12m yields are preferred automatically.",
  },
  {
    id: "yield.investment_trust", group: "Expected returns", home: "assumptions",
    label: "Investment trust income yield", unit: "%", def: 3.5, min: 0, max: 15, step: 0.1,
    drives: ["Tax → Location: annual GIA drag"],
    note: "Superseded by a holding's real payment history when one exists.",
  },
  {
    id: "yield.bond_fund", group: "Expected returns", home: "assumptions",
    label: "Bond fund income yield", unit: "%", def: 4.0, min: 0, max: 15, step: 0.1,
    drives: ["Tax → Location: annual GIA drag (taxed at interest rates)"],
  },
  {
    id: "yield.gilt", group: "Expected returns", home: "assumptions",
    label: "Gilt coupon (fallback)", unit: "%", def: 3.5, min: 0, max: 15, step: 0.1,
    drives: ["Tax → Location: gilt income drag"],
    note: "A gilt's REAL coupon is used whenever its metadata carries one — this only fills the gap. Gilts stay CGT-exempt either way.",
  },
  {
    id: "growth.equity", group: "Expected returns", home: "assumptions",
    label: "Equity / fund capital growth", unit: "%", def: 5.0, min: 0, max: 20, step: 0.5,
    drives: ["Tax → Location: the capital half of the GIA drag"],
  },
  {
    id: "growth.investment_trust", group: "Expected returns", home: "assumptions",
    label: "Investment trust capital growth", unit: "%", def: 4.0, min: 0, max: 20, step: 0.5,
    drives: ["Tax → Location: the capital half of the GIA drag"],
  },
  {
    id: "growth.bond_fund", group: "Expected returns", home: "assumptions",
    label: "Bond fund capital growth", unit: "%", def: 0.5, min: 0, max: 20, step: 0.5,
    drives: ["Tax → Location: the capital half of the GIA drag"],
  },
  // --- Tax modelling ----------------------------------------------------
  {
    id: "realisationFactor", group: "Tax modelling", home: "assumptions",
    label: "CGT realisation discount", unit: "×", def: 0.5, min: 0, max: 1, step: 0.05,
    drives: ["Tax → Location: how much of each year's paper growth is treated as taxed"],
    note: "Unrealised gains defer tax and the annual exempt amount absorbs some. 1.0 charges full CGT on paper growth every year (harsh); 0 ignores capital tax entirely.",
  },
  // --- Benchmark --------------------------------------------------------
  {
    id: "benchmark.symbol", group: "Comparison", home: "assumptions", kind: "text",
    label: "Benchmark symbol", def: "VWRL.L",
    drives: ["Home: trend-chart overlay", "Portfolio → Returns: benchmark & risk"],
    note: "Any symbol your price provider recognises.",
  },
  // --- Plan-owned (read-only mirrors) -----------------------------------
  {
    id: "plan.inflation", group: "Planning", home: "plan", planKey: "inflation",
    label: "Inflation", unit: "%", def: 3,
    drives: ["Plan: every real-terms figure", "Budget: the “History + inflation” spend forecast", "Run-off: uprating expenses"],
  },
  {
    id: "plan.growthPre", group: "Planning", home: "plan", planKey: "growthPre",
    label: "Growth before retirement", unit: "%", def: 6,
    drives: ["Plan: pot projection to retirement"],
  },
  {
    id: "plan.growthPost", group: "Planning", home: "plan", planKey: "growthPost",
    label: "Growth in retirement", unit: "%", def: 4.5,
    drives: ["Plan: drawdown sustainability", "Monte Carlo: central return"],
  },
  {
    id: "plan.fee", group: "Planning", home: "plan", planKey: "fee",
    label: "Platform + fund fees", unit: "%", def: 0.5,
    drives: ["Plan: net growth", "Monte Carlo: drag on every simulated year"],
  },
  {
    id: "plan.vol", group: "Planning", home: "plan", planKey: "vol",
    label: "Return volatility", unit: "%", def: 13,
    drives: ["Monte Carlo: spread of outcomes", "Sequence-risk analysis"],
  },
  {
    id: "plan.essentialPct", group: "Planning", home: "plan", planKey: "essentialPct",
    label: "Essential share of spending", unit: "%", def: 65,
    drives: ["Plan → Income floor: what guaranteed income is tested against"],
  },
];

export const ASSUMPTION_GROUPS = [...new Set(ASSUMPTIONS.map((a) => a.group))];
const BY_ID = new Map(ASSUMPTIONS.map((a) => [a.id, a]));

// Clamp a candidate value to the definition's declared range. Text
// assumptions pass through trimmed; a blank/invalid number falls back to the
// default rather than poisoning an engine with NaN.
export function coerceAssumption(id, raw) {
  const def = BY_ID.get(id);
  if (!def) return undefined;
  if (def.kind === "text") {
    const s = String(raw ?? "").trim();
    return s || def.def;
  }
  const n = +raw;
  if (!Number.isFinite(n)) return def.def;
  const lo = def.min ?? -Infinity, hi = def.max ?? Infinity;
  return r2(Math.min(hi, Math.max(lo, n)));
}

// Effective value of every registry-owned assumption: default, overridden by
// the sparse `overrides` map. Plan-owned entries resolve from planInputs so
// callers can display one consistent table.
export function resolveAssumptions(overrides = {}, planInputs = {}) {
  const out = {};
  for (const a of ASSUMPTIONS) {
    if (a.home === "plan") {
      const v = planInputs[a.planKey];
      out[a.id] = Number.isFinite(+v) ? +v : a.def;
    } else {
      out[a.id] = Object.prototype.hasOwnProperty.call(overrides, a.id)
        ? coerceAssumption(a.id, overrides[a.id])
        : a.def;
    }
  }
  return out;
}

// True where the user has actually moved a value off its default.
export function isOverridden(id, overrides = {}) {
  const def = BY_ID.get(id);
  if (!def || def.home === "plan") return false;
  if (!Object.prototype.hasOwnProperty.call(overrides, id)) return false;
  return coerceAssumption(id, overrides[id]) !== def.def;
}

export function overriddenCount(overrides = {}) {
  return ASSUMPTIONS.filter((a) => isOverridden(a.id, overrides)).length;
}

// Shape the resolved values into the KIND_ASSUMPTIONS map core/asset-location
// consumes, so the location engine picks up user overrides without knowing
// this registry exists.
export function kindAssumptionsFrom(resolved = {}) {
  const g = (id, fallback) => (Number.isFinite(+resolved[id]) ? +resolved[id] : fallback);
  const equity = { incomeYield: g("yield.equity", 2), incomeKind: "dividend", growth: g("growth.equity", 5) };
  return {
    equity,
    fund: equity,
    investment_trust: { incomeYield: g("yield.investment_trust", 3.5), incomeKind: "dividend", growth: g("growth.investment_trust", 4) },
    gilt: { incomeYield: g("yield.gilt", 3.5), incomeKind: "interest", growth: 0, cgtExempt: true },
    bond_fund: { incomeYield: g("yield.bond_fund", 4), incomeKind: "interest", growth: g("growth.bond_fund", 0.5) },
  };
}
