/* ======================================================================
   UK INHERITANCE TAX (IHT) PROJECTION ENGINE — pure and node-tested
   (iht.test.mjs).

   Models the nil-rate band (NRB), residence nil-rate band (RNRB, with its
   £2m taper), transferable bands between spouses/civil partners, business
   & agricultural property relief (BPR/APR, including the April 2026 cap),
   the reduced 36% charity rate, and lifetime gifts (PETs) with their
   chronological NRB allocation and 7-year taper relief. Also gates whether
   pension wealth counts as part of the estate at all, since that changes
   for deaths on/after 6 April 2027 — the single biggest recent change to
   how this app's own retirement pots interact with IHT.

   Deliberate simplifications (stated here once, not fabricated elsewhere):
   - No annual gift exemption (£3,000/yr, plus £250 small gifts) or wedding
     gift exemptions modelled — every non-exempt gift counts in full. This
     UNDERSTATES how much lifetime gifting can shelter, so it's a
     conservative (higher-IHT) simplification, not an optimistic one.
   - Married/civil-partnership is a single "assume full transferable NRB
     +RNRB" toggle, not a real second estate — the true transferable
     fraction depends on how much of the FIRST spouse's own NRB/RNRB they
     used, which this app has no way to know without modelling their
     estate too.
   - RNRB taper is based on the gross estate before BPR/APR relief and
     before lifetime-gift NRB use (HMRC's own "net value of the estate"
     definition for taper purposes, deducting only liabilities — not the
     same base as the final taxable-estate figure below it).
   - BPR and APR are treated as a single combined "qualifying business/
     agricultural property" pot sharing one £2.5m 100%-relief cap, rather
     than tracked as separate asset classes (this app has no dedicated
     business/agricultural asset ledger to split them from).
   - Taper relief only reduces the TAX on the excess of a gift over
     whatever nil-rate band is left for it, per HMRC's own rule — it never
     reduces the gift's value, and never applies at all to a gift already
     fully covered by remaining NRB.
   ====================================================================== */

// Frozen at these figures until 5 April 2031 (confirmed via GOV.UK's
// published NRB/RNRB table covering 2026/27–2027/28) — a flat constant,
// not a by-year table, since nothing has moved and nothing is legislated
// to move before then.
export const NRB = 325000;
export const RNRB = 175000;
export const RNRB_TAPER_THRESHOLD = 2000000; // £1 of RNRB lost per £2 over this
export const IHT_RATE = 0.40;
export const IHT_RATE_CHARITY = 0.36; // when >=10% of the (post-exemption) estate goes to charity
export const CHARITY_RATE_THRESHOLD = 0.10;

// BPR/APR: 100% relief was uncapped before this date; from 6 April 2026,
// the first £2.5m of combined qualifying value per person gets 100%
// relief, anything above gets 50%.
export const BPR_APR_CAP_START = "2026-04-06";
export const BPR_APR_FULL_RELIEF_CAP = 2500000;
export const BPR_APR_EXCESS_RELIEF_RATE = 0.50;

// Unused pension funds and death benefits become part of the taxable
// estate for deaths on/after this date (Budget-confirmed rule change).
export const PENSIONS_IN_ESTATE_FROM = "2027-04-06";

export function pensionsInEstate(asOfDate) {
  return asOfDate >= PENSIONS_IN_ESTATE_FROM;
}

// Residence nil-rate band, tapered away above the £2m threshold — only
// available at all if the main residence passes to direct descendants
// (children, grandchildren, etc; HMRC's actual "direct descendants" test
// is more detailed than this app models — treated as a single toggle).
export function residenceNRB(grossEstateBeforeReliefs, mainResidenceToDescendants = true) {
  if (!mainResidenceToDescendants) return 0;
  if (grossEstateBeforeReliefs <= RNRB_TAPER_THRESHOLD) return RNRB;
  const excess = grossEstateBeforeReliefs - RNRB_TAPER_THRESHOLD;
  return Math.max(0, RNRB - excess / 2);
}

// Fraction of the tax on a gift's chargeable excess that's RELIEVED
// (not the fraction of value relieved) — HMRC's taper relief table.
// Only meaningful for the portion of a gift already established to be
// above the donor's remaining NRB; see `giftBreakdown` in `projectIHT`.
export function giftTaperRelief(yearsBeforeDeath) {
  if (yearsBeforeDeath < 3) return 0;
  if (yearsBeforeDeath < 4) return 0.20;
  if (yearsBeforeDeath < 5) return 0.40;
  if (yearsBeforeDeath < 6) return 0.60;
  if (yearsBeforeDeath < 7) return 0.80;
  return 1.0; // 7+ years: fully outside the estate, no tax at all
}

// Business/agricultural property relief on one combined qualifying value.
// Returns how much of `value` is relieved (drops out of the estate) vs
// chargeable (counts toward the taxable estate).
export function businessAgriculturalRelief(value, asOfDate) {
  const v = Math.max(0, +value || 0);
  if (v <= 0) return { relievedValue: 0, chargeableValue: 0 };
  if (asOfDate < BPR_APR_CAP_START) return { relievedValue: v, chargeableValue: 0 };
  const fullPortion = Math.min(v, BPR_APR_FULL_RELIEF_CAP);
  const excessPortion = Math.max(0, v - BPR_APR_FULL_RELIEF_CAP);
  const relievedValue = fullPortion + excessPortion * BPR_APR_EXCESS_RELIEF_RATE;
  return { relievedValue, chargeableValue: v - relievedValue };
}

const daysBetween = (aISO, bISO) => (new Date(bISO + "T00:00:00Z") - new Date(aISO + "T00:00:00Z")) / 86400000;

// Full IHT projection for one estate snapshot (either "today" or some
// future valuation date, e.g. the Plan tab's projected plan-end estate).
// `gifts`: [{ date: "YYYY-MM-DD", amount, exempt }] — spouse/charity gifts
// should be passed with `exempt: true` (fully outside IHT, never chargeable
// and never use up NRB) rather than omitted, so a caller's gift log stays
// complete even for gifts that don't affect the tax.
export function projectIHT({
  investedValue = 0,       // non-pension investable wealth (GIA/ISA/LISA/VCT)
  pensionValue = 0,        // SIPP/DC pension pot value
  propertyEquity = 0,      // net of mortgages
  privateValue = 0,
  rsuValue = 0,
  businessAgriculturalValue = 0, // qualifying BPR/APR assets, full value before relief
  otherLiabilities = 0,
  creditCardDebt = 0,
  mainResidenceToDescendants = true,
  married = false,
  charityGiftPct = 0,      // fraction (0-1) of the taxable estate left to charity
  gifts = [],
  asOfDate,
} = {}) {
  const pensionCounts = pensionsInEstate(asOfDate);
  const pensionInEstateValue = pensionCounts ? Math.max(0, pensionValue) : 0;

  const bpr = businessAgriculturalRelief(businessAgriculturalValue, asOfDate);

  const liabilities = Math.max(0, otherLiabilities) + Math.max(0, creditCardDebt);
  const grossEstateBeforeReliefs =
    Math.max(0, investedValue) + pensionInEstateValue + Math.max(0, propertyEquity) +
    Math.max(0, privateValue) + Math.max(0, rsuValue) + Math.max(0, businessAgriculturalValue) - liabilities;

  const deathEstate =
    Math.max(0, investedValue) + pensionInEstateValue + Math.max(0, propertyEquity) +
    Math.max(0, privateValue) + Math.max(0, rsuValue) + bpr.chargeableValue - liabilities;

  // --- lifetime gifts: chronological NRB allocation + per-gift taper ---
  const totalNRB = NRB * (married ? 2 : 1);
  const sortedGifts = gifts
    .filter((g) => g && g.date && Number.isFinite(+g.amount) && +g.amount > 0)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let nrbLeft = totalNRB;
  let giftTaxDue = 0;
  const giftBreakdown = [];
  for (const g of sortedGifts) {
    const amount = +g.amount;
    const yearsBeforeDeath = daysBetween(g.date, asOfDate) / 365.25;
    const stillWithin7Years = yearsBeforeDeath >= 0 && yearsBeforeDeath < 7;
    // A gift that has already dropped out of the 7-year window (or is
    // exempt) is no longer a "chargeable transfer" at all by the time of
    // death — it neither uses up NRB nor owes any tax, exactly as if it
    // had never been made for IHT purposes.
    if (g.exempt || !stillWithin7Years) {
      giftBreakdown.push({ ...g, amount, chargeable: 0, nrbUsed: 0, excess: 0, yearsBeforeDeath, taperFrac: g.exempt ? null : 1, taxDue: 0 });
      continue;
    }
    const nrbUsed = Math.min(amount, nrbLeft);
    nrbLeft -= nrbUsed;
    const excess = amount - nrbUsed;
    const taperFrac = giftTaperRelief(yearsBeforeDeath);
    const taxDue = excess * IHT_RATE * (1 - taperFrac);
    giftTaxDue += taxDue;
    giftBreakdown.push({ ...g, amount, chargeable: amount, nrbUsed, excess, yearsBeforeDeath, taperFrac, taxDue });
  }
  const nrbRemainingForEstate = nrbLeft;

  // --- death estate: RNRB (unaffected by lifetime gifts) + remaining NRB ---
  const totalRNRB = residenceNRB(grossEstateBeforeReliefs, mainResidenceToDescendants) * (married ? 2 : 1);
  const bandsAvailable = nrbRemainingForEstate + totalRNRB;
  const taxableBeforeCharity = Math.max(0, deathEstate - bandsAvailable);

  const pct = Math.max(0, Math.min(1, +charityGiftPct || 0));
  const charityGiftAmount = taxableBeforeCharity * pct;
  const netTaxableEstate = Math.max(0, taxableBeforeCharity - charityGiftAmount);
  const rate = pct >= CHARITY_RATE_THRESHOLD ? IHT_RATE_CHARITY : IHT_RATE;
  const estateTax = netTaxableEstate * rate;

  const totalIHT = estateTax + giftTaxDue;
  const netEstateToHeirs = deathEstate - estateTax - charityGiftAmount;

  return {
    asOfDate,
    pensionCounted: pensionCounts,
    pensionValue, pensionInEstateValue,
    grossEstateBeforeReliefs,
    deathEstate,
    bprApr: bpr,
    nrb: NRB, rnrb: RNRB,
    totalNRB, nrbUsedByGifts: totalNRB - nrbRemainingForEstate, nrbRemainingForEstate,
    totalRNRB,
    bandsAvailable,
    taxableBeforeCharity,
    charityGiftPct: pct, charityGiftAmount,
    netTaxableEstate,
    rate,
    estateTax,
    giftTaxDue,
    giftBreakdown,
    totalIHT,
    netEstateToHeirs,
    effectiveRate: deathEstate > 0 ? totalIHT / deathEstate : 0,
  };
}
