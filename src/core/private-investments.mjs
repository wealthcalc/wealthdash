/* ======================================================================
   PRIVATE INVESTMENTS — EIS/SEIS shares and LP fund commitments (e.g. a
   direct EIS investment, or a venture LP like "Passion Capital IV" /
   "JamJar Fund II"). These aren't exchange-traded, don't fit the existing
   wrapper/transaction-ledger model (no market price, no share quantity —
   money moves via irregular capital calls and distributions rather than
   priced buy/sell trades), and EIS/SEIS carry their own income-tax relief
   and CGT rules HMRC applies nowhere else in this app. Pure and
   React-free; runs under node --test (private-investments.test.mjs).

   Model:
     HOLDING — one company (EIS/SEIS) or one fund (LP/"other"): identity,
               type, share-issue date (starts the EIS/SEIS 3-year CGT
               clock), income-tax relief rate claimed, and a manual
               valuation (no live price exists for any of these — see
               ui/PrivateTab.jsx).
     EVENT   — a cashflow against a holding: "call" (money invested —
               covers both a single EIS subscription and an LP fund's
               staged capital calls the same way, so a fund drawn down
               over several tranches is just several "call" events),
               "distribution_capital" (return of capital / capital gain,
               disposal proceeds for CGT purposes), "distribution_income"
               (income distribution, taxable as income, not a gain), or
               "write_off" (holding taken to zero — the trigger for
               EIS/SEIS loss relief below).

   EIS/SEIS reliefs modelled (2025/26 rates and caps — stated explicitly,
   not silently assumed, same honesty policy as the rest of the app):
     - Income tax relief: 30% (EIS) / 50% (SEIS) of the amount invested,
       claimed in the tax year of the share issue (approximated here by
       the EARLIEST "call" event's tax year), subject to annual caps (EIS
       £1m, or £2m where the excess is in knowledge-intensive companies —
       this app doesn't know which, so only the standard £1m cap is
       flagged; SEIS £200k) aggregated ACROSS every EIS/SEIS holding in
       that tax year — the same "combined limit, not per-holding"
       modelling as the ISA/LISA £20k check in allowances.mjs.
     - CGT exemption: gains on disposal are exempt from CGT once the
       shares have been held 3 years from issue AND income tax relief on
       them wasn't later withdrawn/reduced by HMRC — this module tracks
       the 3-year CLOCK only (a date comparison), not the relief-withdrawal
       condition, which this app has no way to know about.
     - Loss relief: if a holding is written off, or sits at a loss net of
       what's already been returned, the EFFECTIVE loss (amount invested,
       minus income tax relief already given, minus capital already
       returned) can be set against INCOME in the year of loss (or the
       prior year) rather than only against capital gains — usually far
       more valuable at the higher/additional rate than ordinary CGT loss
       relief. This module computes the eligible amount; making the actual
       claim is a Self Assessment supplementary-page action this app
       doesn't file.
   LP funds (type "LP") and "other" private holdings get NONE of the
   above — 0% relief, no 3-year clock, no loss-relief-against-income —
   they're just illiquid GIA-style investments, an ordinary CGT disposal
   on distribution/exit like anything else in the GIA. That CGT isn't
   computed here (there's no Section-104-style cost-pool concept for a
   fund's irregular capital calls/distributions the way there is for
   priced shares) — the UI says so, rather than fabricating a number.
   ====================================================================== */

import { ukTaxYear } from "./cgt-engine.mjs";
import { xirr } from "./returns.mjs";

export const PRIVATE_TYPES = ["EIS", "SEIS", "LP", "other"];
export const TYPE_LABEL = { EIS: "EIS", SEIS: "SEIS", LP: "LP fund", other: "Other private" };
export const RELIEF_RATE = { EIS: 30, SEIS: 50, LP: 0, other: 0 };
// 2025/26 annual investor caps, aggregated across every EIS/SEIS holding
// whose share-issue tax year matches (not a per-holding cap).
export const EIS_ANNUAL_CAP = 1000000;
export const EIS_ANNUAL_CAP_KI = 2000000; // knowledge-intensive companies — the raised cap covers the excess only; not distinguished here
export const SEIS_ANNUAL_CAP = 200000;
const CGT_EXEMPT_YEARS = 3;

const round2 = (x) => Math.round((+x || 0) * 100) / 100;
const todayFallback = () => new Date().toISOString().slice(0, 10);
function addYearsISO(iso, years) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCFullYear(dt.getUTCFullYear() + years);
  return dt.toISOString().slice(0, 10);
}

/* ------------------------------- events ---------------------------------- */
export function holdingEvents(holdingId, events = []) {
  return events.filter((e) => e && e.holdingId === holdingId);
}

/* ------------------------------ per-holding ------------------------------- */
// Money-in-money-out summary + XIRR for one holding. `today` is injected
// (ISO string) so this stays pure/testable; the UI passes the real date.
export function holdingSummary(holding, events = [], today = todayFallback()) {
  const evs = holdingEvents(holding.id, events);
  const called = evs.filter((e) => e.type === "call").reduce((s, e) => s + (+e.amount || 0), 0);
  const distCapital = evs.filter((e) => e.type === "distribution_capital").reduce((s, e) => s + (+e.amount || 0), 0);
  const distIncome = evs.filter((e) => e.type === "distribution_income").reduce((s, e) => s + (+e.amount || 0), 0);
  const writtenOff = evs.some((e) => e.type === "write_off");
  const currentValue = writtenOff ? 0 : (Number.isFinite(+holding.currentValuation) ? +holding.currentValuation : 0);
  const totalReturned = distCapital + distIncome;
  const moic = called > 1e-9 ? (totalReturned + currentValue) / called : null;

  // XIRR: calls negative (money out of pocket), distributions positive,
  // plus a terminal positive cashflow of today's valuation if still held —
  // same "unrealised value as a terminal flow" convention used for open
  // holdings' XIRR elsewhere in the app (see returns.mjs).
  const flows = [];
  for (const e of evs) {
    if (e.type === "call") flows.push({ date: e.date, amount: -Math.abs(+e.amount || 0) });
    else if (e.type === "distribution_capital" || e.type === "distribution_income") flows.push({ date: e.date, amount: Math.abs(+e.amount || 0) });
  }
  if (!writtenOff && currentValue > 0) flows.push({ date: holding.valuationAsOf || today, amount: currentValue });
  const irr = xirr(flows);

  return {
    called: round2(called), distCapital: round2(distCapital), distIncome: round2(distIncome),
    totalReturned: round2(totalReturned), currentValue: round2(currentValue),
    moic, irr, writtenOff, eventCount: evs.length,
  };
}

/* ------------------------- CGT exemption clock ---------------------------- */
export function cgtExemptionStatus(holding, today = todayFallback()) {
  if (holding.type !== "EIS" && holding.type !== "SEIS") return { applies: false };
  if (!holding.shareIssueDate) return { applies: true, exempt: false, reason: "no share issue date set" };
  const exemptFrom = addYearsISO(holding.shareIssueDate, CGT_EXEMPT_YEARS);
  return { applies: true, exempt: today >= exemptFrom, exemptFrom };
}

/* ----------------- income tax relief, aggregated by tax year -------------- */
// { taxYear: { EIS: {invested, relief, cap, capKi, overCap}, SEIS: {...} } }
export function reliefByYear(holdings = [], events = []) {
  const out = {};
  for (const h of holdings) {
    if (h.type !== "EIS" && h.type !== "SEIS") continue;
    const calls = holdingEvents(h.id, events).filter((e) => e.type === "call").sort((a, b) => (a.date < b.date ? -1 : 1));
    if (!calls.length) continue;
    const year = ukTaxYear(calls[0].date);
    const invested = calls.reduce((s, e) => s + (+e.amount || 0), 0);
    const rate = Number.isFinite(+h.reliefPct) ? +h.reliefPct : RELIEF_RATE[h.type];
    const relief = invested * rate / 100;
    (out[year] ||= { EIS: { invested: 0, relief: 0 }, SEIS: { invested: 0, relief: 0 } });
    out[year][h.type].invested += invested;
    out[year][h.type].relief += relief;
  }
  for (const y of Object.keys(out)) {
    const row = out[y];
    row.EIS.invested = round2(row.EIS.invested); row.EIS.relief = round2(row.EIS.relief);
    row.SEIS.invested = round2(row.SEIS.invested); row.SEIS.relief = round2(row.SEIS.relief);
    row.EIS.cap = EIS_ANNUAL_CAP; row.EIS.capKi = EIS_ANNUAL_CAP_KI;
    row.SEIS.cap = SEIS_ANNUAL_CAP;
    row.EIS.overCap = row.EIS.invested > EIS_ANNUAL_CAP;
    row.SEIS.overCap = row.SEIS.invested > SEIS_ANNUAL_CAP;
  }
  return out;
}

/* ------------------------ loss relief (EIS/SEIS only) ---------------------- */
// The amount eligible to be set against INCOME rather than only gains —
// net of income tax relief already given (no double relief on the same
// pound) and any capital already returned. Floored at 0. LP/"other"
// holdings return null: ordinary CGT loss rules apply to those instead,
// same as any other GIA disposal, not something this module computes.
export function lossReliefEligible(holding, events = []) {
  if (holding.type !== "EIS" && holding.type !== "SEIS") return null;
  const s = holdingSummary(holding, events);
  const rate = Number.isFinite(+holding.reliefPct) ? +holding.reliefPct : RELIEF_RATE[holding.type];
  const incomeTaxReliefGiven = round2(s.called * rate / 100);
  const netCost = round2(s.called - incomeTaxReliefGiven);
  const stillWorth = s.currentValue + s.distCapital; // capital-side value: what's back plus what's left
  const loss = netCost - stillWorth;
  return { eligible: loss > 0.01, amount: round2(Math.max(0, loss)), netCost, incomeTaxReliefGiven };
}

/* ------------------------------ portfolio totals --------------------------- */
// Blended IRR pools every holding's calls/distributions into one cashflow
// series (plus one combined terminal flow of today's total valuation) —
// valid because XIRR only needs dated amounts, not a single instrument;
// this is the same "whole-portfolio cashflow list" approach the rest of
// the app uses for portfolio-level XIRR (see returns.mjs).
export function privateTotals(holdings = [], events = [], today = todayFallback()) {
  let called = 0, distCapital = 0, distIncome = 0, currentValue = 0;
  const flows = [];
  const rows = holdings.map((h) => {
    const s = holdingSummary(h, events, today);
    called += s.called; distCapital += s.distCapital; distIncome += s.distIncome; currentValue += s.currentValue;
    for (const e of holdingEvents(h.id, events)) {
      if (e.type === "call") flows.push({ date: e.date, amount: -Math.abs(+e.amount || 0) });
      else if (e.type === "distribution_capital" || e.type === "distribution_income") flows.push({ date: e.date, amount: Math.abs(+e.amount || 0) });
    }
    return { holding: h, ...s };
  });
  if (currentValue > 0) flows.push({ date: today, amount: currentValue });
  return {
    rows,
    called: round2(called), distCapital: round2(distCapital), distIncome: round2(distIncome),
    currentValue: round2(currentValue), totalReturned: round2(distCapital + distIncome),
    moic: called > 1e-9 ? (distCapital + distIncome + currentValue) / called : null,
    irr: xirr(flows),
  };
}
