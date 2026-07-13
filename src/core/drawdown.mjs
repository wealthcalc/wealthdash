/* ======================================================================
   DRAWDOWN STRATEGY SIMULATOR — the Plan tab's deterministic retirement
   projection: accumulation, PCLS/UFPLS tax-free-cash handling, a 5-way
   withdrawal-ordering waterfall across pension/ISA/LISA/GIA, income-tax
   band-filling, MPAA tracking, buy-to-let (Section 24), annuity purchase,
   variable "retirement smile" spending, and historical-sequence replay.
   Pure and node-tested (drawdown.test.mjs).

   Extracted out of PlanTab.jsx, where it lived as component-local
   functions with no test coverage and no way to reach it from anywhere
   but that one 2000-line React file. `buildProjection()` was already
   React-free in spirit (a pure function of its `p` config object) — this
   is a straight move plus the MPAA addition described below, not a
   rewrite. PlanTab.jsx now imports everything here instead of defining
   it locally; every call site is unchanged.

   MPAA (Money Purchase Annual Allowance): this engine's accumulation and
   decumulation phases were previously strictly sequential — contributions
   only ever ran from `currentAge` to `retireAge`, decumulation only ever
   ran from `retireAge` onward, so MPAA (which only bites when DC
   contributions continue AFTER flexible pension access has started) could
   never actually be triggered by anything the engine modelled. The new
   `postAccessContrib` input (default 0, so existing plans are unaffected)
   models a phased/part-time retirement where someone keeps paying into a
   DC pot while also drawing flexible income from another pot — the one
   realistic scenario where MPAA matters. The engine flags the age flexible
   access is first triggered (the first year any pension income is drawn —
   under UFPLS every withdrawal triggers it immediately; under PCLS-then-
   drawdown, taking the 25% lump sum alone does NOT trigger it, only the
   first income withdrawal that follows does) and, from that point on,
   whether `postAccessContrib` exceeds the £10,000 MPAA cap.
   ====================================================================== */

import {
  personalAllowance, taxRUK, taxScot, HR_THRESHOLD, employeeNI,
  annualAllowance, grossForNetPension,
} from "./uk-income-tax.mjs";
import { MPAA_LIMIT } from "./allowances.mjs";

// ONS-style cohort life-expectancy approximation (England & Wales)
export function lifeExpectancy(age, sex, healthy) {
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

// effective general inflation given chosen basis (RPI runs above CPI)
export function effInflation(p) {
  if (p.inflMode === "rpi") return p.inflation + p.rpiWedge;
  return p.inflation; // CPI or custom both read the slider directly
}

// Buy-to-let cashflow for a given number of years elapsed from today.
// Interest-only mortgage; Section 24 (mortgage interest not deductible, 20% credit).
export function btlYearly(p, elapsed) {
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

// Historical return + inflation sequences (illustrative annual %, portfolio-level)
export const HIST = {
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
export function replayDecum(p, det, key, offset) {
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

// ---- spending profile multiplier (the "retirement smile") ----
export function spendMult(p, age) {
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
export function dbRate(p) {
  if (p.dbIndex === "fixed") return p.dbFixedRate / 100;
  if (p.dbIndex === "rpi") return (p.inflation + p.rpiWedge) / 100;
  return p.inflation / 100; // cpi
}

// approximate UK level single-life annuity rate by age (2025-ish), reduced for escalation
export function annuityRate(age, escalation) {
  const a = Math.max(55, Math.min(85, age));
  const level = 0.05 + (a - 60) * 0.003; // 60: 5.0%, 65: 6.5%, 70: 8.0%, 75: 9.5%
  if (escalation === "rpi") return level * 0.62;
  if (escalation === "esc3") return level * 0.74;
  return level;
}

// withdraw `need` cash from a GIA, realising proportional CGT
export function giaWithdraw(need, value, basis, aeaLeft, cgtRate) {
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
export const STRATEGY = {
  taxopt: ["PB", "ISA", "LISA", "GIA", "PX"],
  taxfree: ["ISA", "LISA", "GIA", "PB", "PX"],
  pension: ["PB", "PX", "GIA", "ISA", "LISA"],
  giafirst: ["GIA", "PB", "ISA", "LISA", "PX"],
  preserveisa: ["PB", "GIA", "PX", "LISA", "ISA"],
};
export const STRATEGY_LABELS = {
  taxopt: "Tax-optimised",
  taxfree: "Tax-free first",
  pension: "Pension first",
  giafirst: "GIA first",
  preserveisa: "Preserve ISA",
};

export function buildProjection(p) {
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

  // ---- Phase 3.6: goals — one-off dated outflows ----
  // p.goals: [{ id, label, age, amount (TODAY'S £), enabled }]. Zero goals
  // = byte-identical projection (tested). Before retirement a goal is
  // funded from liquid, non-pension wealth in ISA → GIA → LISA(60+)
  // order — never the pension (pre-access it CAN'T fund a house deposit,
  // and post-access raiding it for goals would need tax modelling this
  // deliberately routes through the decumulation waterfall instead).
  // From retirement onward a goal simply joins that year's net spending
  // need, so the existing waterfall pays it tax-aware and a too-big goal
  // shows up as earlier depletion — the honest signal.
  const goals = (p.goals || []).filter((g) => g && g.enabled !== false && +g.amount > 0 && +g.age > 0);
  const goalEvents = [];
  const goalsAt = (age) => goals.filter((g) => Math.round(+g.age) === age);

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
    // Goals due this year leave at year-end, ISA → GIA → LISA (60+ only).
    // Whatever the liquid pots can't cover is recorded as a SHORTFALL,
    // never silently taken from the pension. The Monte Carlo contribution
    // schedule nets the funded amount so randomised paths see the outflow.
    for (const g of goalsAt(age)) {
      const nominal = g.amount * inflFactor;
      let rem = nominal;
      const fromIsa = Math.min(isa, rem); isa -= fromIsa; rem -= fromIsa;
      const fromGia = Math.min(gia, rem);
      if (fromGia > 0) { giaBasis -= gia > 0 ? giaBasis * (fromGia / gia) : 0; gia -= fromGia; rem -= fromGia; }
      if (age >= 60 && rem > 0) { const fromLisa = Math.min(lisa, rem); lisa -= fromLisa; rem -= fromLisa; }
      const funded = nominal - rem;
      if (funded > 0) wealthContribSchedule[i] -= funded;
      goalEvents.push({ age, label: g.label || "Goal", amountReal: +g.amount, fundedNominal: funded, shortfallNominal: rem, shortfallReal: rem / inflFactor, phase: "accum" });
    }
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

  // MPAA — see module header. Only meaningful when postAccessContrib > 0
  // (a phased/part-time retirement continuing to fund a DC pot); default 0
  // means these all stay at their "never triggered" values for every
  // existing plan.
  const postAccessContrib = p.postAccessContrib || 0;
  let mpaaTriggered = false,
    mpaaTriggerAge = null,
    mpaaBreachAge = null,
    mpaaExcessTotal = 0;

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

    // Goals due in retirement join this year's NET spending need — the
    // waterfall below funds them tax-aware (grossing up pension draws as
    // required), and an unaffordable goal surfaces as earlier depletion.
    let goalNominal = 0;
    for (const g of goalsAt(age)) {
      const nominal = g.amount * inflFactor;
      goalNominal += nominal;
      goalEvents.push({ age, label: g.label || "Goal", amountReal: +g.amount, fundedNominal: nominal, shortfallNominal: 0, shortfallReal: 0, phase: "decum" });
    }
    const targetNetNominal = targetNetToday * inflFactor * spendMult(p, age) + goalNominal;
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

    // MPAA: the first year any pension income is actually drawn (UFPLS or
    // flexi-access drawdown) is what triggers it — taking PCLS alone at
    // retirement (handled above, before this loop starts) does not.
    if (drawPension > 0 && !mpaaTriggered) {
      mpaaTriggered = true;
      mpaaTriggerAge = age;
    }
    if (mpaaTriggered && postAccessContrib > MPAA_LIMIT) {
      if (mpaaBreachAge === null) mpaaBreachAge = age;
      mpaaExcessTotal += postAccessContrib - MPAA_LIMIT;
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

    pension = Math.max(0, (pension - drawPension) * (1 + gPost) + postAccessContrib);
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
    // Phase 3.6 goals: per-goal funding record ({age, label, amountReal,
    // fundedNominal, shortfallNominal/Real, phase}) — empty when no goals.
    goalEvents,
    // MPAA — see module header. mpaaLimit is echoed back so callers never
    // need to import allowances.mjs's MPAA_LIMIT separately just to render
    // "the £10,000 cap" in a UI string.
    postAccessContrib,
    mpaaTriggered,
    mpaaTriggerAge,
    mpaaLimit: MPAA_LIMIT,
    mpaaBreachAge,
    mpaaExcessTotal,
  };
}
