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
  Layers,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Design tokens — resolved via CSS variables so the theme can swap    */
/* ------------------------------------------------------------------ */
const LIGHT = {
  paper: "#F4F6F2",
  surface: "#FFFFFF",
  ink: "#16202C",
  ink2: "#42505F",
  muted: "#7C8893",
  line: "#E3E7E1",
  lineSoft: "#EEF1EC",
  green: "#0F7A52",
  greenSoft: "#E2F0E8",
  blue: "#2C5C86",
  blueSoft: "#E3ECF4",
  amber: "#BE7918",
  amberSoft: "#F6ECD8",
  red: "#B23A3A",
  redSoft: "#F4E2E0",
  gold: "#8F7327",
};
const DARK = {
  paper: "#0E141A",
  surface: "#171F28",
  ink: "#E7ECF0",
  ink2: "#AFB9C3",
  muted: "#8592A0",
  line: "#2A3540",
  lineSoft: "#212B35",
  green: "#37B481",
  greenSoft: "#15281F",
  blue: "#5B94C6",
  blueSoft: "#152532",
  amber: "#D89B3F",
  amberSoft: "#2C2413",
  red: "#D45E5E",
  redSoft: "#2E1B1B",
  gold: "#C6A24E",
};
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
/*  UK tax engine — 2025/26                                            */
/* ------------------------------------------------------------------ */
const PA_BASE = 12570;
const PA_TAPER_FROM = 100000;

// f uprates all thresholds (1 = today's 2025/26 bands; >1 = inflated for future years)
function personalAllowance(income, f = 1) {
  const base = PA_BASE * f,
    from = PA_TAPER_FROM * f;
  if (income <= from) return base;
  return Math.max(0, base - (income - from) / 2);
}

// England / Wales / NI: band widths on TAXABLE income
function taxRUK(income, f = 1) {
  if (income <= 0) return 0;
  const pa = personalAllowance(income, f);
  const taxable = Math.max(0, income - pa);
  const b20 = 37700 * f;
  const b40 = 125140 * f;
  let tax = 0;
  tax += Math.min(taxable, b20) * 0.2;
  tax += Math.max(0, Math.min(taxable, b40) - b20) * 0.4;
  tax += Math.max(0, taxable - b40) * 0.45;
  return tax;
}

// Scotland 2025/26
function taxScot(income, f = 1) {
  if (income <= 0) return 0;
  const pa = personalAllowance(income, f);
  const taxable = Math.max(0, income - pa);
  const bands = [
    [2827, 0.19],
    [12093 - 2827, 0.2],
    [31092 - 12093, 0.21],
    [62430 - 31092, 0.42],
    [125140 - 62430, 0.45],
    [Infinity, 0.48],
  ];
  let tax = 0,
    rem = taxable;
  for (const [w, r] of bands) {
    const width = w === Infinity ? Infinity : w * f;
    const slice = Math.min(rem, width);
    if (slice <= 0) break;
    tax += slice * r;
    rem -= slice;
  }
  return tax;
}

// higher-rate threshold (total income) for the basic-rate-ceiling rule
const HR_THRESHOLD = 50270;

function employeeNI(salary) {
  const pt = 12570,
    uel = 50270;
  let ni = 0;
  ni += Math.max(0, Math.min(salary, uel) - pt) * 0.08;
  ni += Math.max(0, salary - uel) * 0.02;
  return ni;
}

// Annual Allowance with high-income taper
function annualAllowance(adjustedIncome) {
  if (adjustedIncome <= 260000) return 60000;
  const reduced = 60000 - (adjustedIncome - 260000) / 2;
  return Math.max(10000, reduced);
}

// effective general inflation given chosen basis (RPI runs above CPI)
function effInflation(p) {
  if (p.inflMode === "rpi") return p.inflation + p.rpiWedge;
  return p.inflation; // CPI or custom both read the slider directly
}

// Buy-to-let cashflow for a given number of years elapsed from today.
// Interest-only mortgage; Section 24 (mortgage interest not deductible, 20% credit).
function btlYearly(p, elapsed) {
  const value = p.btlValue * Math.pow(1 + p.btlGrowth / 100, elapsed);
  const rent =
    p.btlValue * (p.btlYield / 100) * Math.pow(1 + p.btlRentGrowth / 100, elapsed);
  const opex = rent * ((p.btlMaint + p.btlMgmt + p.btlVoid) / 100);
  const cleared = p.btlClearAge && p.currentAge + elapsed >= p.btlClearAge;
  const balance = cleared ? 0 : p.btlMortgage;
  const interest = (balance * p.btlRate) / 100;
  const taxableProfit = Math.max(0, rent - opex); // interest NOT deducted
  const cashProfit = rent - opex - interest;
  return { value, rent, opex, interest, taxableProfit, cashProfit, balance, equity: value - balance };
}

// ONS-style cohort life-expectancy approximation (England & Wales)
function lifeExpectancy(age, sex, healthy) {
  const base =
    sex === "female" ? { mean: 88, q25: 94, q10: 98 } : { mean: 85, q25: 92, q10: 96 };
  const bump = Math.max(0, age - 40) * 0.06; // survivorship nudge
  const adj = healthy ? 2.5 : 0; // affluent / non-smoker / active
  return {
    mean: Math.round(base.mean + bump + adj),
    q25: Math.round(base.q25 + bump + adj),
    q10: Math.round(base.q10 + bump + adj),
  };
}

// Historical return + inflation sequences (illustrative annual %, portfolio-level)
const HIST = {
  gfc2008: {
    label: "2008 financial crisis",
    returns: [-37, 26, 15, 2, 16, 32, 14, 1, 12, 22],
    infl: [3.6, 2.2, 3.3, 4.5, 2.8, 2.6, 1.5, 0.4, 1.0, 2.6],
  },
  dotcom2000: {
    label: "2000–02 dot-com bust",
    returns: [-9, -12, -22, 28, 11, 5, 16, 5, -37, 26],
    infl: [1.0, 1.2, 1.3, 1.4, 1.3, 2.0, 2.3, 2.3, 3.6, 2.2],
  },
  oil1973: {
    label: "1973–74 oil shock",
    returns: [-15, -26, 37, 24, -7, 18, 8, 15, -5, 21],
    infl: [9, 16, 24, 17, 8, 8, 13, 18, 12, 9],
  },
};

// Replay a historical sequence over the fixed retirement spending plan.
// Returns are normalised so their geometric mean matches the user's assumed
// post-retirement return (and inflation to the user's assumption), so the ONLY
// difference vs the base plan is the ORDER of returns — pure sequence risk.
function replayDecum(p, det, key, offset) {
  const h = HIST[key];
  const gPostNet = (p.growthPost - p.fee) / 100;
  const baseInfl = effInflation(p) / 100;
  const n = h.returns.length;
  // geometric mean of the raw historical returns
  let prod = 1;
  for (const r of h.returns) prod *= 1 + r / 100;
  const geo = Math.pow(prod, 1 / n) - 1;
  const k = (1 + gPostNet) / (1 + geo); // scale so mean matches user's assumption
  // inflation: scale so its mean matches the user's inflation assumption
  let iprod = 1;
  for (const r of h.infl) iprod *= 1 + r / 100;
  const igeo = Math.pow(iprod, 1 / n) - 1;
  const ik = (1 + baseInfl) / (1 + igeo);

  let pot = det.wealthAtRetire;
  let cumInfl = 1;
  let depletion = null;
  const path = [];
  for (let i = 0; i < det.withdrawSchedule.length; i++) {
    const age = p.retireAge + i;
    const hi = i - offset;
    const ret = hi >= 0 && hi < n ? (1 + h.returns[hi] / 100) * k - 1 : gPostNet;
    const yearInfl = hi >= 0 && hi < n ? (1 + h.infl[hi] / 100) * ik - 1 : baseInfl;
    pot = (pot - det.withdrawSchedule[i]) * (1 + ret);
    if (pot <= 0 && depletion === null && det.withdrawSchedule[i] > 0) depletion = age;
    pot = Math.max(0, pot);
    cumInfl *= 1 + yearInfl;
    path.push({ age, real: pot / cumInfl });
  }
  return { path, depletion, label: h.label };
}

/* ------------------------------------------------------------------ */
/*  Projection engine                                                  */
/* ------------------------------------------------------------------ */
// Solve gross pension drawdown whose INCREMENTAL net (on top of existing taxable
// income) equals the target. frac = taxable fraction of each withdrawal
// (0.75 under UFPLS, 1.0 once the 25% PCLS has already been removed).
function grossForNetPension(targetIncrNet, otherTaxable, taxFn, f, frac, cap) {
  if (targetIncrNet <= 0 || cap <= 0) return 0;
  const baseTax = taxFn(otherTaxable, f);
  const incr = (g) => g - (taxFn(otherTaxable + g * frac, f) - baseTax);
  if (incr(cap) <= targetIncrNet) return cap;
  let lo = 0,
    hi = cap;
  for (let k = 0; k < 60; k++) {
    const m = (lo + hi) / 2;
    if (incr(m) < targetIncrNet) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

// ---- spending profile multiplier (the "retirement smile") ----
function spendMult(p, age) {
  const t = age - p.retireAge;
  switch (p.spendProfile) {
    case "smile": {
      // go-go early, dip mid, slight rise late (care costs)
      if (t < 10) return 1.1 - (t / 10) * 0.05; // 1.10 -> 1.05
      if (t < 20) return 1.05 - ((t - 10) / 10) * 0.2; // 1.05 -> 0.85
      return Math.min(1.0, 0.85 + ((t - 20) / 15) * 0.15); // 0.85 -> 1.00
    }
    case "decline":
      return Math.max(0.6, Math.pow(0.99, t)); // ~1%/yr real decline, floor 0.6
    case "custom": {
      if (age < p.goGoUntil) return p.goGoPct / 100;
      if (age < p.slowGoUntil) return p.slowGoPct / 100;
      return p.noGoPct / 100;
    }
    default:
      return 1.0; // flat
  }
}

// DB pension annual indexation rate
function dbRate(p) {
  if (p.dbIndex === "fixed") return p.dbFixedRate / 100;
  if (p.dbIndex === "rpi") return (p.inflation + p.rpiWedge) / 100;
  return p.inflation / 100; // cpi
}

// approximate UK level single-life annuity rate by age (2025-ish), reduced for escalation
function annuityRate(age, escalation) {
  const a = Math.max(55, Math.min(85, age));
  const level = 0.05 + (a - 60) * 0.003; // 60: 5.0%, 65: 6.5%, 70: 8.0%, 75: 9.5%
  if (escalation === "rpi") return level * 0.62;
  if (escalation === "esc3") return level * 0.74;
  return level;
}

// withdraw `need` cash from a GIA, realising proportional CGT
function giaWithdraw(need, value, basis, aeaLeft, cgtRate) {
  if (value <= 0 || need <= 0)
    return { sale: 0, cash: 0, gain: 0, cgt: 0, value, basis, aeaUsed: 0 };
  const gainFrac = Math.max(0, (value - basis) / value);
  let sale;
  const noCgtSale = need; // if gain within allowance
  if (noCgtSale * gainFrac <= aeaLeft) {
    sale = need;
  } else {
    const denom = 1 - gainFrac * cgtRate;
    sale = denom > 0 ? (need - aeaLeft * cgtRate) / denom : need;
  }
  sale = Math.min(Math.max(0, sale), value);
  const gain = sale * gainFrac;
  const cgt = Math.max(0, gain - aeaLeft) * cgtRate;
  const cash = sale - cgt;
  const newBasis = basis * (1 - sale / value);
  return { sale, cash, gain, cgt, value: value - sale, basis: newBasis, aeaUsed: Math.min(gain, aeaLeft) };
}

// drawdown sequencing strategies (ordered pool priorities)
const STRATEGY = {
  taxopt: ["PB", "ISA", "LISA", "GIA", "PX"],
  taxfree: ["ISA", "LISA", "GIA", "PB", "PX"],
  pension: ["PB", "PX", "GIA", "ISA", "LISA"],
  giafirst: ["GIA", "PB", "ISA", "LISA", "PX"],
  preserveisa: ["PB", "GIA", "PX", "LISA", "ISA"],
};
const STRATEGY_LABELS = {
  taxopt: "Tax-optimised",
  taxfree: "Tax-free first",
  pension: "Pension first",
  giafirst: "GIA first",
  preserveisa: "Preserve ISA",
};

function buildProjection(p) {
  const taxFn = p.region === "scotland" ? taxScot : taxRUK;
  const years = p.planAge - p.currentAge;
  const accumYears = p.retireAge - p.currentAge;
  const LSA = 268275; // lump sum allowance
  const infl = effInflation(p) / 100; // general inflation (CPI / RPI / custom)
  const gPre = (p.growthPre - p.fee) / 100; // net of fees
  const gPost = (p.growthPost - p.fee) / 100;

  // ---- pre-retirement: net take-home today (for replacement ratio), today's bands ----
  const empContribToday = (p.salary * p.empPct) / 100;
  const preNetToday =
    p.salary - taxFn(p.salary, 1) - employeeNI(p.salary) - empContribToday;

  const targetNetToday =
    p.targetMode === "ratio"
      ? preNetToday * (p.replacementRatio / 100)
      : p.targetAbsolute;

  // state-pension annual growth factor (triple lock = max of CPI / earnings / 2.5%)
  const spRate = p.tripleLock
    ? Math.max(p.inflation, p.earningsGrowth, 2.5) / 100
    : infl;

  // ---- accumulation: pension + ISA + GIA + LISA pots ----
  const timeline = [];
  let pot = p.startPot;
  let isa = p.isaStart;
  let gia = p.giaStart;
  let giaBasis = p.giaStart; // cost basis (no latent gain assumed at t0)
  let lisa = p.lisaStart;
  let salary = p.salary;
  const contribSchedule = []; // pension contributions per year
  const wealthContribSchedule = []; // all-wrapper contributions, for Monte Carlo
  for (let i = 0; i < accumYears; i++) {
    const age = p.currentAge + i;
    const pensionContrib = (salary * (p.empPct + p.erPct)) / 100 + p.fixedContrib;
    const lisaIn = age < 50 ? Math.min(p.lisaContrib, 4000) : 0;
    const lisaBonus = lisaIn * 0.25; // 25% government bonus to age 50
    contribSchedule.push(pensionContrib);
    wealthContribSchedule.push(pensionContrib + p.isaContrib + p.giaContrib + lisaIn + lisaBonus);
    const inflFactor = Math.pow(1 + infl, i);
    const total = pot + isa + gia + lisa;
    timeline.push({
      age,
      pension: pot,
      bridge: isa + gia + lisa,
      potNominal: total,
      potReal: total / inflFactor,
      phase: "accum",
    });
    pot = pot * (1 + gPre) + pensionContrib;
    isa = isa * (1 + gPre) + p.isaContrib;
    gia = gia * (1 + gPre) + p.giaContrib;
    giaBasis += p.giaContrib; // basis grows by contributions only
    lisa = lisa * (1 + gPre) + lisaIn + lisaBonus;
    salary *= 1 + p.salaryGrowth / 100;
  }

  // ---- at retirement: handle PCLS vs UFPLS ----
  let pension = pot;
  let pclsAmount = 0;
  let frac = 0.75; // UFPLS: 25% of each withdrawal tax-free
  if (p.tfcMode === "pcls") {
    pclsAmount = Math.min(pension * 0.25, LSA);
    pension -= pclsAmount; // remaining pension fully taxable
    isa += pclsAmount; // tax-free cash parked in ISA
    frac = 1.0;
  }
  const pensionAtRetire = pension + pclsAmount;
  const wealthAtRetire = pension + isa + gia + lisa;
  const wealthAtRetireReal = wealthAtRetire / Math.pow(1 + infl, accumYears);
  const bridgeAtRetire = isa + gia + lisa;
  const isaAtRetire = isa,
    giaAtRetire = gia,
    lisaAtRetire = lisa;

  // Annual Allowance check (first-year basis)
  const adjustedIncome = p.salary + (p.salary * p.erPct) / 100;
  const aa = annualAllowance(adjustedIncome);
  const firstContrib = contribSchedule[0] || 0;
  const aaBreach = firstContrib > aa;

  // ---- decumulation ----
  const grossSchedule = []; // pension gross draw per year
  const withdrawSchedule = []; // total nominal pool draw (Monte Carlo)
  const btlSeries = [];
  let depletionAge = null;
  let btlSold = false;
  let btlSaleAge = null,
    btlSaleProceeds = 0,
    btlSaleCGT = 0,
    btlSaleGain = 0;
  let annuityBought = false,
    annuityIncome0 = 0,
    annuityAgeBought = null,
    annuityCost = 0;
  let totalTaxReal = 0; // lifetime income tax + CGT, in today's money
  let firstYearGross = 0,
    firstYearNet = 0,
    firstYearTax = 0,
    firstYearState = 0,
    firstYearPensionDraw = 0,
    firstYearBridgeDraw = 0;

  const order = STRATEGY[p.drawStrategy] || STRATEGY.taxopt;
  const dbGrowth = dbRate(p);

  for (let i = 0; i <= years - accumYears; i++) {
    const age = p.retireAge + i;
    if (age > p.planAge) break;
    const elapsed = accumYears + i;
    const inflFactor = Math.pow(1 + infl, elapsed);
    const bandFactor = inflFactor;

    // annuity purchase (once)
    if (p.annuityEnabled && !annuityBought && age >= p.annuityAge) {
      annuityCost = pension * (p.annuityPortion / 100);
      pension -= annuityCost;
      annuityIncome0 = annuityCost * annuityRate(age, p.annuityEscalation);
      annuityBought = true;
      annuityAgeBought = age;
    }
    let annuityInc = 0;
    if (annuityBought) {
      const escRate =
        p.annuityEscalation === "esc3"
          ? 0.03
          : p.annuityEscalation === "rpi"
          ? (p.inflation + p.rpiWedge) / 100
          : 0;
      annuityInc = annuityIncome0 * Math.pow(1 + escRate, age - annuityAgeBought);
    }

    const statePension =
      p.includeState && age >= p.spaAge
        ? p.statePension * Math.pow(1 + spRate, elapsed)
        : 0;
    const dbPension = p.dbEnabled ? p.dbPension * Math.pow(1 + dbGrowth, elapsed) : 0;

    // --- buy-to-let (Section 24) ---
    let btlTaxable = 0,
      btlCash = 0,
      btlInterest = 0,
      btlNet = 0,
      btlVal = 0,
      btlEq = 0,
      btlRent = 0;
    if (p.btlEnabled) {
      if (p.btlSellAge && age >= p.btlSellAge && !btlSold) {
        const b = btlYearly(p, elapsed);
        btlSaleGain = Math.max(0, b.value - p.btlBaseCost);
        const aea = 3000 * bandFactor;
        const taxableGain = Math.max(0, btlSaleGain - aea);
        const room = Math.max(0, HR_THRESHOLD * bandFactor - (statePension + dbPension));
        btlSaleCGT = Math.min(taxableGain, room) * 0.18 + Math.max(0, taxableGain - room) * 0.24;
        btlSaleProceeds = Math.max(0, b.equity - btlSaleCGT);
        gia += btlSaleProceeds; // proceeds into GIA (taxable wrapper, fresh basis)
        giaBasis += btlSaleProceeds;
        totalTaxReal += btlSaleCGT / inflFactor;
        btlSold = true;
        btlSaleAge = age;
      }
      if (!btlSold) {
        const b = btlYearly(p, elapsed);
        btlTaxable = b.taxableProfit;
        btlCash = b.cashProfit;
        btlInterest = b.interest;
        btlVal = b.value;
        btlEq = b.equity;
        btlRent = b.rent;
      }
    }

    // guaranteed taxable income (state + DB + annuity + BTL profit)
    const guaranteedTaxable = statePension + dbPension + annuityInc + btlTaxable;
    const paBase = personalAllowance(guaranteedTaxable, bandFactor);
    const creditBase = Math.min(btlInterest, btlTaxable, Math.max(0, guaranteedTaxable - paBase));
    const interestCredit = 0.2 * creditBase;
    const baseTax = Math.max(0, taxFn(guaranteedTaxable, bandFactor) - interestCredit);
    const guaranteedCash = statePension + dbPension + annuityInc + btlCash;
    const baseNet = guaranteedCash - baseTax;

    const targetNetNominal = targetNetToday * inflFactor * spendMult(p, age);
    let need = Math.max(0, targetNetNominal - baseNet);

    // ---- waterfall over wrappers ----
    let runTaxable = guaranteedTaxable; // grows as we draw taxable pension
    let aeaLeft = 3000 * bandFactor;
    let drawPension = 0,
      drawISA = 0,
      drawLISA = 0,
      drawGIA = 0,
      giaCGT = 0;

    const drawPensionTo = (cap) => {
      if (cap <= 0 || need <= 0.5) return;
      const g = grossForNetPension(need, runTaxable, taxFn, bandFactor, frac, cap);
      const net = g - (taxFn(runTaxable + g * frac, bandFactor) - taxFn(runTaxable, bandFactor));
      drawPension += g;
      runTaxable += g * frac;
      need -= net;
    };

    for (const step of order) {
      if (need <= 0.5) break;
      if (step === "PB" || step === "PX") {
        if (age < p.accessAge) continue; // pension locked
        const remainingPension = pension - drawPension;
        let cap = remainingPension;
        if (step === "PB") {
          const room = Math.max(0, HR_THRESHOLD * bandFactor - runTaxable);
          cap = Math.min(room / frac, remainingPension);
        }
        drawPensionTo(cap);
      } else if (step === "ISA") {
        const u = Math.min(isa - drawISA, need);
        drawISA += u;
        need -= u;
      } else if (step === "LISA") {
        if (age >= 60) {
          const u = Math.min(lisa - drawLISA, need);
          drawLISA += u;
          need -= u;
        }
      } else if (step === "GIA") {
        const cgtRate = runTaxable > HR_THRESHOLD * bandFactor ? 0.24 : 0.18;
        const w = giaWithdraw(need, gia - drawGIA, giaBasis, aeaLeft, cgtRate);
        drawGIA += w.sale;
        giaBasis = w.basis;
        aeaLeft = Math.max(0, aeaLeft - w.aeaUsed);
        giaCGT += w.cgt;
        need -= w.cash;
      }
    }

    const shortfall = need > 1;
    if (shortfall && depletionAge === null && targetNetNominal > baseNet + 1) {
      depletionAge = age;
    }

    const taxableIncome = guaranteedTaxable + drawPension * frac;
    const incomeTax = Math.max(0, taxFn(taxableIncome, bandFactor) - interestCredit);
    const yearTax = incomeTax + giaCGT;
    const yearGross =
      guaranteedCash + drawPension + drawISA + drawLISA + drawGIA;
    const yearNet = yearGross - yearTax;
    totalTaxReal += yearTax / inflFactor;

    // BTL net at actual marginal rate
    let btlMarginal = 0;
    if (p.btlEnabled && btlTaxable > 0) {
      const btlIncrTax = Math.max(
        0,
        taxFn(taxableIncome, bandFactor) - taxFn(taxableIncome - btlTaxable, bandFactor) - interestCredit
      );
      btlNet = btlCash - btlIncrTax;
      btlMarginal = (taxFn(taxableIncome, bandFactor) - taxFn(taxableIncome - 100, bandFactor)) / 100;
      btlSeries.push({
        age,
        value: btlVal / inflFactor,
        equity: btlEq / inflFactor,
        rent: btlRent / inflFactor,
        opex: (btlRent - btlCash - btlInterest) / inflFactor,
        interest: btlInterest / inflFactor,
        taxableProfit: btlTaxable / inflFactor,
        cashProfit: btlCash / inflFactor,
        tax: btlIncrTax / inflFactor,
        net: btlNet / inflFactor,
        credit: interestCredit / inflFactor,
        marginal: btlMarginal,
        sold: false,
      });
    } else if (p.btlEnabled) {
      btlSeries.push({ age, value: 0, equity: 0, rent: 0, net: 0, marginal: 0, sold: btlSold });
    }

    const tfDraw = drawISA + drawLISA + drawGIA; // tax-free-ish (GIA net of its CGT)
    if (i === 0) {
      firstYearGross = yearGross;
      firstYearNet = yearNet;
      firstYearTax = yearTax;
      firstYearState = statePension;
      firstYearPensionDraw = drawPension;
      firstYearBridgeDraw = tfDraw;
    }

    const bridgeTotal = isa + gia + lisa;
    timeline.push({
      age,
      pension,
      bridge: bridgeTotal,
      potNominal: pension + bridgeTotal,
      potReal: (pension + bridgeTotal) / inflFactor,
      phase: "decum",
      pensionDrawReal: drawPension / inflFactor,
      bridgeDrawReal: tfDraw / inflFactor,
      stateReal: statePension / inflFactor,
      dbReal: dbPension / inflFactor,
      annuityReal: annuityInc / inflFactor,
      btlNetReal: btlNet / inflFactor,
      pensionReal: pension / inflFactor,
      isaReal: isa / inflFactor,
      giaReal: gia / inflFactor,
      lisaReal: lisa / inflFactor,
      bridgeReal: bridgeTotal / inflFactor,
      spendReal: targetNetNominal / inflFactor,
    });

    grossSchedule.push(drawPension);
    withdrawSchedule.push(drawPension + drawISA + drawLISA + drawGIA);

    pension = Math.max(0, (pension - drawPension) * (1 + gPost));
    isa = Math.max(0, (isa - drawISA) * (1 + gPost));
    lisa = Math.max(0, (lisa - drawLISA) * (1 + gPost));
    const giaGrowth = (gia - drawGIA) * (1 + gPost);
    giaBasis = giaBasis * (giaGrowth > 0 ? 1 : 1); // basis unchanged by growth
    gia = Math.max(0, giaGrowth);
  }

  const firstYearNetToday = firstYearNet / Math.pow(1 + infl, accumYears);
  const replacementNet = preNetToday > 0 ? firstYearNetToday / preNetToday : 0;
  const lastReal = timeline[timeline.length - 1] || {};
  // Property/other net worth (Property tab) is a static addendum to the
  // estate, NOT investable/drawdown-eligible wealth — it never enters
  // `pension`/`isa`/`gia`/`lisa` above, so it can't be drawn on for income
  // and doesn't grow or inflate here (already in today's money; no
  // assumption about whether it'd ever be sold or downsized).
  const otherNetWorthReal = +p.otherNetWorthStart || 0;
  const estateReal = (lastReal.potReal || 0) + (p.btlEnabled && !btlSold ? btlYearly(p, years).equity / Math.pow(1 + infl, years) : 0) + otherNetWorthReal;

  return {
    timeline,
    potAtRetire: pensionAtRetire,
    potAtRetireReal: pensionAtRetire / Math.pow(1 + infl, accumYears),
    wealthAtRetire,
    wealthAtRetireReal,
    bridgeAtRetire,
    isaAtRetire,
    giaAtRetire,
    lisaAtRetire,
    pclsAmount,
    depletionAge,
    preNetToday,
    targetNetToday,
    firstYearGross,
    firstYearNet,
    firstYearNetToday,
    firstYearState,
    firstYearTax,
    firstYearPensionDraw,
    firstYearBridgeDraw,
    replacementNet,
    aa,
    aaBreach,
    firstContrib,
    accumYears,
    contribSchedule,
    wealthContribSchedule,
    grossSchedule,
    withdrawSchedule,
    startWealth: p.startPot + p.isaStart + p.giaStart + p.lisaStart,
    otherNetWorthReal,
    infl,
    btlEnabled: p.btlEnabled,
    btlSeries,
    btlSaleAge,
    btlSaleProceeds,
    btlSaleCGT,
    btlSaleGain,
    annuityIncome0,
    annuityAgeBought,
    annuityCost,
    totalTaxReal,
    estateReal,
  };
}

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
  // tax-free cash treatment
  tfcMode: "ufpls", // 'ufpls' | 'pcls'
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
};

export default function PlanTab({ dark = true, planInputs = null, setPlanInputs = null, livePots = null, liveSalary = null, liveOtherNetWorth = null }) {
  // `planInputs` is null until the user changes something for the first
  // time (nothing to persist yet) — DEFAULTS covers that first render.
  // `setPlanInputs` may be omitted by a caller that hasn't wired the store
  // prop through yet; guard so the tab still renders (read-only) rather than
  // throwing, same defensive pattern as AllowancesTab's setOverrides.
  const p = planInputs || DEFAULTS;
  const set = useCallback((k, v) => setPlanInputs && setPlanInputs((x) => ({ ...(x || DEFAULTS), [k]: v })), [setPlanInputs]);
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

  const [tab, setTab] = useState("overview");
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
        const spB = applyScenario(p, mcCompareKey);
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
  }, [p, det, mcCompareKey, runMonteCarloAsync]);

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
              { k: "drawdown", label: "Sequencing", icon: Layers },
              { k: "btl", label: "Buy-to-let", icon: Building2 },
              { k: "stress", label: "Scenarios & stress", icon: ShieldAlert },
              { k: "adequacy", label: "Monte Carlo", icon: Activity },
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
            <AdequacyTab p={p} mc={mc} mcB={mcB} progress={mcProgress} compareKey={mcCompareKey} setCompareKey={setMcCompareKey} running={mcRunning} runMC={runMC} det={det} life={life} set={set} />
          )}
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-sections                                                       */
/* ------------------------------------------------------------------ */
function PanelSection({ title, children }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div
        style={{
          fontSize: 11,
          letterSpacing: ".08em",
          textTransform: "uppercase",
          color: T.gold,
          fontWeight: 700,
          marginBottom: 12,
          paddingBottom: 6,
          borderBottom: `1px solid ${T.lineSoft}`,
        }}
      >
        {title}
      </div>
      {children}
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
function DrawdownTab({ p, det, set }) {
  const strategies = Object.keys(STRATEGY_LABELS);
  const runs = useMemo(
    () =>
      strategies.map((s) => {
        const r = buildProjection({ ...p, drawStrategy: s });
        return {
          key: s,
          label: STRATEGY_LABELS[s],
          tax: r.totalTaxReal,
          depletion: r.depletionAge,
          estate: r.estateReal,
          lasts: r.depletionAge === null,
        };
      }),
    [p]
  );
  // rank: survive first, then lowest lifetime tax, then biggest estate
  const ranked = [...runs].sort((a, b) => {
    if (a.lasts !== b.lasts) return a.lasts ? -1 : 1;
    if (Math.abs(a.tax - b.tax) > 500) return a.tax - b.tax;
    return b.estate - a.estate;
  });
  const best = ranked[0];
  const worst = runs.reduce((m, r) => (r.tax > m.tax ? r : m), runs[0]);
  const saving = worst.tax - best.tax;

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
          The order you tap pension, ISA, GIA and LISA barely changes how long the money lasts — but it changes lifetime <strong>tax</strong> a lot. Here's every strategy run on your exact plan.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(170px,1fr))", gap: 12 }}>
          <Card style={{ background: T.greenSoft, border: "none" }}>
            <Stat label="Best strategy" value={best.label} sub={`${gbp(best.tax)} lifetime tax (today's £)`} tone="green" />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Potential tax saving" value={gbp(saving)} sub={`vs "${worst.label}"`} tone={saving > 1000 ? "green" : "ink"} />
          </Card>
          <Card style={{ background: T.paper, border: "none" }}>
            <Stat label="Your current choice" value={STRATEGY_LABELS[p.drawStrategy]} sub={p.drawStrategy === best.key ? "already optimal ✓" : "not the cheapest"} tone={p.drawStrategy === best.key ? "green" : "amber"} />
          </Card>
        </div>
        {p.drawStrategy !== best.key && (
          <button
            onClick={() => set("drawStrategy", best.key)}
            style={{ marginTop: 12, background: T.ink, color: T.paper, border: "none", borderRadius: 9, padding: "9px 16px", fontWeight: 600, fontSize: 13, cursor: "pointer" }}
          >
            Switch to "{best.label}"
          </button>
        )}
      </Card>

      <Card style={{ padding: 0, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: T.lineSoft }}>
              {["Strategy", "Lifetime tax", "Money lasts to", "Estate left"].map((h, i) => (
                <th key={h} style={{ textAlign: i === 0 ? "left" : "right", padding: "11px 16px", fontSize: 11, letterSpacing: ".04em", textTransform: "uppercase", color: T.muted, fontWeight: 700 }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ranked.map((r) => (
              <tr key={r.key} style={{ borderTop: `1px solid ${T.line}`, background: r.key === p.drawStrategy ? T.greenSoft : "transparent" }}>
                <td style={{ padding: "12px 16px", fontWeight: 600 }}>
                  {r.label}
                  {r.key === best.key && <span style={{ marginLeft: 8, fontSize: 10.5, color: T.green, fontWeight: 700 }}>BEST</span>}
                  {r.key === p.drawStrategy && <span style={{ marginLeft: 8, fontSize: 10.5, color: T.muted }}>(current)</span>}
                </td>
                <td style={cellMono}>{gbp(r.tax)}</td>
                <td style={{ ...cellMono, color: r.lasts ? T.green : T.amber }}>{r.lasts ? `${p.planAge}+` : `age ${r.depletion}`}</td>
                <td style={cellMono}>{gbpK(r.estate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>

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

function AdequacyTab({ p, mc, mcB, progress = 0, compareKey = "none", setCompareKey, running, runMC, det, life, set }) {
  const planShort = p.planAge < life.q25; // planning shorter than 1-in-4 longevity
  const compareOptions = [{ value: "none", label: "None" }, ...SCENARIOS.filter((s) => s.key !== "base").map((s) => ({ value: s.key, label: s.label }))];
  const compareLabel = compareOptions.find((o) => o.value === compareKey)?.label || "comparison";
  const mergedFan = useMemo(() => mergeFans(mc ? mc.fan : [], mcB ? mcB.fan : []), [mc, mcB]);
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
    </div>
  );
}
