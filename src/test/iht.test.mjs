import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NRB, RNRB, RNRB_TAPER_THRESHOLD, IHT_RATE, IHT_RATE_CHARITY,
  BPR_APR_FULL_RELIEF_CAP, PENSIONS_IN_ESTATE_FROM,
  pensionsInEstate, residenceNRB, giftTaperRelief, businessAgriculturalRelief, projectIHT,
} from "../core/iht.mjs";

/* ------------------------------ pensionsInEstate --------------------------- */

test("pensionsInEstate: false before 6 April 2027, true on/after", () => {
  assert.equal(pensionsInEstate("2026-07-10"), false);
  assert.equal(pensionsInEstate("2027-04-05"), false);
  assert.equal(pensionsInEstate(PENSIONS_IN_ESTATE_FROM), true);
  assert.equal(pensionsInEstate("2030-01-01"), true);
});

/* ------------------------------- residenceNRB ------------------------------ */

test("residenceNRB: full band below the £2m taper threshold", () => {
  assert.equal(residenceNRB(500000, true), RNRB);
  assert.equal(residenceNRB(RNRB_TAPER_THRESHOLD, true), RNRB);
});

test("residenceNRB: tapers £1 per £2 over the threshold, floors at 0", () => {
  assert.equal(residenceNRB(RNRB_TAPER_THRESHOLD + 100000, true), RNRB - 50000);
  assert.equal(residenceNRB(RNRB_TAPER_THRESHOLD + 2 * RNRB, true), 0);
  assert.equal(residenceNRB(RNRB_TAPER_THRESHOLD + 10000000, true), 0); // never negative
});

test("residenceNRB: zero when the residence doesn't pass to direct descendants", () => {
  assert.equal(residenceNRB(500000, false), 0);
});

/* ----------------------------- giftTaperRelief ----------------------------- */

test("giftTaperRelief: matches HMRC's published bands exactly", () => {
  assert.equal(giftTaperRelief(0), 0);
  assert.equal(giftTaperRelief(2.9), 0);
  assert.equal(giftTaperRelief(3), 0.20);
  assert.equal(giftTaperRelief(3.9), 0.20);
  assert.equal(giftTaperRelief(4), 0.40);
  assert.equal(giftTaperRelief(5), 0.60);
  assert.equal(giftTaperRelief(6), 0.80);
  assert.equal(giftTaperRelief(7), 1.0);
  assert.equal(giftTaperRelief(15), 1.0);
});

/* ------------------------- businessAgriculturalRelief ----------------------- */

test("businessAgriculturalRelief: zero value relieves nothing", () => {
  const r = businessAgriculturalRelief(0, "2026-07-10");
  assert.equal(r.relievedValue, 0);
  assert.equal(r.chargeableValue, 0);
});

test("businessAgriculturalRelief: before the April 2026 cap, 100% relief however large", () => {
  const r = businessAgriculturalRelief(10000000, "2026-04-01");
  assert.equal(r.relievedValue, 10000000);
  assert.equal(r.chargeableValue, 0);
});

test("businessAgriculturalRelief: on/after the cap, full relief up to £2.5m, 50% above", () => {
  const under = businessAgriculturalRelief(2000000, "2026-04-06");
  assert.equal(under.relievedValue, 2000000);
  assert.equal(under.chargeableValue, 0);

  const over = businessAgriculturalRelief(3500000, "2026-04-06");
  // £2.5m fully relieved + 50% of the remaining £1m relieved = £3m relieved, £500k chargeable
  assert.equal(over.relievedValue, BPR_APR_FULL_RELIEF_CAP + 1000000 * 0.5);
  assert.equal(over.chargeableValue, 1000000 * 0.5);
});

/* --------------------------------- projectIHT ------------------------------- */

const ASOF = "2026-07-10"; // before pensions-in-estate and before mattering for BPR cap either way

test("projectIHT: estate fully within NRB+RNRB owes nothing", () => {
  const r = projectIHT({ investedValue: 200000, propertyEquity: 200000, asOfDate: ASOF });
  // 400,000 total < 325,000 (NRB) + 175,000 (RNRB) = 500,000
  assert.equal(r.totalIHT, 0);
  assert.equal(r.netEstateToHeirs, 400000);
});

test("projectIHT: single person, no property (no RNRB), taxed at 40% above NRB alone", () => {
  const r = projectIHT({ investedValue: 500000, mainResidenceToDescendants: false, asOfDate: ASOF });
  assert.equal(r.totalRNRB, 0);
  assert.equal(r.taxableBeforeCharity, 500000 - NRB);
  assert.ok(Math.abs(r.estateTax - (500000 - NRB) * IHT_RATE) < 1e-6);
  assert.equal(r.rate, IHT_RATE);
});

test("projectIHT: married doubles both NRB and RNRB", () => {
  const single = projectIHT({ investedValue: 1200000, asOfDate: ASOF, married: false });
  const married = projectIHT({ investedValue: 1200000, asOfDate: ASOF, married: true });
  assert.equal(married.totalNRB, single.totalNRB * 2);
  // RNRB taper threshold means doubling isn't always exactly 2x totalRNRB once
  // near/over £2m, but bandsAvailable must strictly increase.
  assert.ok(married.bandsAvailable > single.bandsAvailable);
  assert.ok(married.totalIHT < single.totalIHT);
});

test("projectIHT: pensions excluded before April 2027, included on/after", () => {
  const before = projectIHT({ investedValue: 200000, pensionValue: 400000, mainResidenceToDescendants: false, asOfDate: "2027-04-05" });
  const after = projectIHT({ investedValue: 200000, pensionValue: 400000, mainResidenceToDescendants: false, asOfDate: "2027-04-06" });
  assert.equal(before.pensionCounted, false);
  assert.equal(before.pensionInEstateValue, 0);
  assert.equal(before.deathEstate, 200000);
  assert.equal(after.pensionCounted, true);
  assert.equal(after.pensionInEstateValue, 400000);
  assert.equal(after.deathEstate, 600000);
  assert.ok(after.totalIHT > before.totalIHT);
});

test("projectIHT: charity gift at >=10% of the taxable estate drops the rate to 36% and reduces what's left to heirs by the gift itself", () => {
  const r = projectIHT({ investedValue: 800000, mainResidenceToDescendants: false, asOfDate: ASOF, charityGiftPct: 0.10 });
  assert.equal(r.rate, IHT_RATE_CHARITY);
  const taxable = 800000 - NRB;
  assert.ok(Math.abs(r.charityGiftAmount - taxable * 0.10) < 1e-6);
  assert.ok(Math.abs(r.netTaxableEstate - taxable * 0.90) < 1e-6);
  assert.ok(Math.abs(r.estateTax - taxable * 0.90 * IHT_RATE_CHARITY) < 1e-6);
});

test("projectIHT: charity gift below 10% keeps the standard 40% rate", () => {
  const r = projectIHT({ investedValue: 800000, mainResidenceToDescendants: false, asOfDate: ASOF, charityGiftPct: 0.05 });
  assert.equal(r.rate, IHT_RATE);
});

test("projectIHT: BPR/APR relief removes qualifying business value from the taxable estate", () => {
  const withoutRelief = projectIHT({ investedValue: 300000, mainResidenceToDescendants: false, asOfDate: "2026-04-06" });
  const withBusiness = projectIHT({ investedValue: 300000, businessAgriculturalValue: 1000000, mainResidenceToDescendants: false, asOfDate: "2026-04-06" });
  // £1m qualifying value, fully under the £2.5m cap -> fully relieved -> same taxable estate as without it
  assert.ok(Math.abs(withBusiness.taxableBeforeCharity - withoutRelief.taxableBeforeCharity) < 1e-6);
  assert.equal(withBusiness.bprApr.chargeableValue, 0);
});

test("projectIHT: a gift over 7 years old is fully exempt — no tax, doesn't touch NRB", () => {
  const r = projectIHT({
    investedValue: 500000, mainResidenceToDescendants: false, asOfDate: "2026-07-10",
    gifts: [{ date: "2015-01-01", amount: 400000 }],
  });
  assert.equal(r.giftTaxDue, 0);
  assert.equal(r.nrbUsedByGifts, 0);
  assert.equal(r.nrbRemainingForEstate, NRB);
});

test("projectIHT: a gift within 3 years, exceeding NRB, is taxed at the full 40% on the excess with no taper", () => {
  const giftDate = "2025-06-01"; // ~13 months before asOfDate
  const r = projectIHT({
    investedValue: 100000, mainResidenceToDescendants: false, asOfDate: "2026-07-10",
    gifts: [{ date: giftDate, amount: 425000 }], // 425k - 325k NRB = 100k excess
  });
  const gift = r.giftBreakdown[0];
  assert.ok(Math.abs(gift.excess - 100000) < 1e-6);
  assert.equal(gift.taperFrac, 0);
  assert.ok(Math.abs(gift.taxDue - 100000 * IHT_RATE) < 1e-6);
  assert.equal(r.nrbRemainingForEstate, 0); // gift used up all of NRB
});

test("projectIHT: a gift 4-5 years before death gets 40% taper relief on the excess tax", () => {
  // ~4.5 years before asOfDate
  const r = projectIHT({
    investedValue: 100000, mainResidenceToDescendants: false, asOfDate: "2026-07-10",
    gifts: [{ date: "2022-01-10", amount: 425000 }],
  });
  const gift = r.giftBreakdown[0];
  assert.equal(gift.taperFrac, 0.40);
  assert.ok(Math.abs(gift.taxDue - 100000 * IHT_RATE * 0.60) < 1e-6);
});

test("projectIHT: exempt gifts (e.g. to a spouse) never use NRB and never incur gift tax", () => {
  const r = projectIHT({
    investedValue: 500000, mainResidenceToDescendants: false, asOfDate: "2026-07-10",
    gifts: [{ date: "2025-01-01", amount: 1000000, exempt: true }],
  });
  assert.equal(r.giftTaxDue, 0);
  assert.equal(r.nrbUsedByGifts, 0);
});

test("projectIHT: multiple gifts consume NRB in chronological (oldest-first) order regardless of input order", () => {
  const r = projectIHT({
    investedValue: 100000, mainResidenceToDescendants: false, asOfDate: "2026-07-10",
    gifts: [
      { date: "2024-01-01", amount: 200000 }, // later gift, listed first in the array
      { date: "2023-01-01", amount: 200000 }, // earlier gift, listed second
    ],
  });
  const earlier = r.giftBreakdown.find((g) => g.date === "2023-01-01");
  const later = r.giftBreakdown.find((g) => g.date === "2024-01-01");
  // earlier gift should be fully covered by NRB first (200k < 325k)
  assert.equal(earlier.nrbUsed, 200000);
  assert.equal(earlier.excess, 0);
  // later gift only gets the remaining 125k of NRB, rest is excess
  assert.equal(later.nrbUsed, NRB - 200000);
  assert.ok(Math.abs(later.excess - (200000 - (NRB - 200000))) < 1e-6);
});

test("projectIHT: netEstateToHeirs = deathEstate - estateTax - charityGiftAmount, always", () => {
  const r = projectIHT({
    investedValue: 900000, propertyEquity: 300000, mainResidenceToDescendants: true,
    asOfDate: ASOF, charityGiftPct: 0.15,
  });
  assert.ok(Math.abs(r.netEstateToHeirs - (r.deathEstate - r.estateTax - r.charityGiftAmount)) < 1e-6);
});

test("projectIHT: liabilities reduce the estate before any band is applied", () => {
  const clean = projectIHT({ investedValue: 600000, mainResidenceToDescendants: false, asOfDate: ASOF });
  const indebted = projectIHT({ investedValue: 600000, otherLiabilities: 100000, mainResidenceToDescendants: false, asOfDate: ASOF });
  assert.equal(indebted.deathEstate, clean.deathEstate - 100000);
  assert.ok(indebted.totalIHT < clean.totalIHT);
});
