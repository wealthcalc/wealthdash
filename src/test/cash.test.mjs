import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cashAccountsByWrapper, effectiveCashByWrapper, totalCashAccounts,
  weightedAverageRate, accountsMaturingSoon, estimatedAnnualInterest,
} from "../core/cash.mjs";

/* --------------------------- roll-ups ----------------------------------- */

test("cashAccountsByWrapper: sums balances per wrapper, defaults to GIA", () => {
  const out = cashAccountsByWrapper([
    { wrapper: "ISA", balance: 5000 },
    { wrapper: "ISA", balance: 2000 },
    { wrapper: "GIA", balance: 1000 },
    { balance: 300 }, // no wrapper -> GIA
  ]);
  assert.deepEqual(out, { ISA: 7000, GIA: 1300 });
});

test("effectiveCashByWrapper: manual/unallocated + named accounts, additive not replacing", () => {
  const manual = { GIA: 500, LISA: 1000 };
  const accounts = [
    { wrapper: "GIA", balance: 2000 },
    { wrapper: "ISA", balance: 300 }, // wrapper with no manual figure at all
  ];
  const out = effectiveCashByWrapper(manual, accounts);
  assert.deepEqual(out, { GIA: 2500, LISA: 1000, ISA: 300 });
});

test("effectiveCashByWrapper: no accounts at all -> identical to the manual map (backward compatible)", () => {
  const manual = { GIA: 500, ISA: 100 };
  assert.deepEqual(effectiveCashByWrapper(manual, []), manual);
});

test("totalCashAccounts: sums every account regardless of wrapper", () => {
  assert.equal(totalCashAccounts([{ balance: 100 }, { balance: 250 }]), 350);
  assert.equal(totalCashAccounts([]), 0);
});

/* ------------------------------- rates ---------------------------------- */

test("weightedAverageRate: balance-weighted, unrated accounts excluded from both sides", () => {
  // £1,000 @ 5% and £3,000 @ 4% -> (1000*5 + 3000*4)/4000 = 4.25
  const rate = weightedAverageRate([
    { balance: 1000, rate: 5 },
    { balance: 3000, rate: 4 },
    { balance: 9999, rate: null }, // unrated — must not drag the average toward 0
  ]);
  assert.equal(rate, 4.25);
});

test("weightedAverageRate: no rated accounts -> null, not 0 or NaN", () => {
  assert.equal(weightedAverageRate([{ balance: 500, rate: "" }]), null);
  assert.equal(weightedAverageRate([]), null);
});

/* ----------------------------- maturity --------------------------------- */

test("accountsMaturingSoon: fixed-term within window, sorted soonest-first, matured flagged", () => {
  const accounts = [
    { id: "a1", rateType: "fixed", maturityDate: "2027-06-01" }, // far out -> excluded
    { id: "a2", rateType: "fixed", maturityDate: "2026-08-01" }, // within window
    { id: "a3", rateType: "fixed", maturityDate: "2026-06-01" }, // already matured
    { id: "a4", rateType: "variable", maturityDate: "2026-08-01" }, // not fixed -> excluded
    { id: "a5", rateType: "fixed", maturityDate: null }, // no date -> excluded
  ];
  const soon = accountsMaturingSoon(accounts, "2026-07-08", 90);
  assert.deepEqual(soon.map((a) => a.id), ["a3", "a2"]);
  assert.equal(soon[0].matured, true);
  assert.equal(soon[1].matured, false);
});

/* --------------------------- interest projection ------------------------ */

test("estimatedAnnualInterest: balance x rate, unrated accounts contribute nothing", () => {
  // £10,000 @ 4.5% = £450; unrated £5,000 contributes £0.
  const est = estimatedAnnualInterest([
    { balance: 10000, rate: 4.5 },
    { balance: 5000, rate: null },
  ]);
  assert.equal(est, 450);
});
