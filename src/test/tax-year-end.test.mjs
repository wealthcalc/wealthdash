import { test } from "node:test";
import assert from "node:assert/strict";
import { daysToTaxYearEnd, taxYearEndChecklist } from "../core/tax-year-end.mjs";

/* --------------------------- daysToTaxYearEnd ------------------------------ */

test("daysToTaxYearEnd: counts down to the upcoming 5 April", () => {
  assert.equal(daysToTaxYearEnd("2026-04-05"), 0); // on the day itself
  assert.equal(daysToTaxYearEnd("2026-04-04"), 1);
  assert.equal(daysToTaxYearEnd("2026-04-06"), 364); // just missed it -> next year's 5 April (2027, leap-free count)
});

test("daysToTaxYearEnd: mid-year gives a large count, not negative or wrapped", () => {
  const d = daysToTaxYearEnd("2026-07-08");
  assert.ok(d > 200 && d < 320);
});

/* ------------------------------ checklist ---------------------------------- */

test("taxYearEndChecklist: requires `today`", () => {
  assert.throws(() => taxYearEndChecklist({}));
});

test("taxYearEndChecklist: full ISA/AEA/dividend/PSA/pension headroom -> every item present", () => {
  const c = taxYearEndChecklist({
    txns: [], pensionCashflows: [], incomeEntries: [], eriTxns: [], taxableDisposals: [],
    income: 30000, today: "2026-01-15",
  });
  const ids = c.items.map((i) => i.id);
  assert.ok(ids.includes("isa"));
  assert.ok(ids.includes("aea"));
  assert.ok(ids.includes("dividend-allowance"));
  assert.ok(ids.includes("psa"));
  assert.equal(c.year, "2025/26");
});

test("taxYearEndChecklist: fully used ISA allowance drops off the list", () => {
  const txns = [{ date: "2026-01-01", side: "BUY", wrapper: "ISA", gbpAmount: 20000 }];
  const c = taxYearEndChecklist({ txns, today: "2026-01-15" });
  assert.ok(!c.items.some((i) => i.id === "isa"));
});

test("taxYearEndChecklist: fully used AEA drops off the list", () => {
  const taxableDisposals = [{ taxYear: "2025/26", gain: 10000 }]; // way over the £3,000 AEA
  const c = taxYearEndChecklist({ taxableDisposals, today: "2026-01-15" });
  assert.ok(!c.items.some((i) => i.id === "aea"));
});

test("taxYearEndChecklist: pension carry-forward flags the OLDEST unused year, expiring this year-end", () => {
  // No contributions at all in the three years carried into 2025/26 (2022/23, 2023/24, 2024/25).
  const c = taxYearEndChecklist({ pensionCashflows: [], today: "2026-01-15", income: 50000 });
  const pcf = c.items.find((i) => i.id === "pension-carry-forward");
  assert.ok(pcf);
  assert.equal(pcf.expiringYear, "2022/23"); // earliest of the three carried years
});

test("taxYearEndChecklist: pension carry-forward absent once the oldest year's allowance is fully used", () => {
  // Use up the AA in 2022/23 specifically.
  const pensionCashflows = [{ date: "2022-06-01", gbpAmount: 40000 }]; // 2022/23 AA was £40,000
  const c = taxYearEndChecklist({ pensionCashflows, today: "2026-01-15", income: 50000 });
  const pcf = c.items.find((i) => i.id === "pension-carry-forward");
  // Oldest year now has ~£0 unused, so either absent or points to a later (still-unused) year.
  assert.ok(!pcf || pcf.expiringYear !== "2022/23");
});

test("taxYearEndChecklist: `active` reflects the activeWithinDays window", () => {
  const near = taxYearEndChecklist({ today: "2026-03-01", activeWithinDays: 60 }); // ~35 days out
  const far = taxYearEndChecklist({ today: "2026-07-08", activeWithinDays: 60 }); // ~270 days out
  assert.equal(near.active, true);
  assert.equal(far.active, false);
});

test("taxYearEndChecklist: items are sorted by amount, largest first", () => {
  const c = taxYearEndChecklist({ income: 30000, today: "2026-01-15" });
  for (let i = 1; i < c.items.length; i++) assert.ok(c.items[i - 1].amount >= c.items[i].amount);
});
