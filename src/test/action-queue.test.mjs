import { test } from "node:test";
import assert from "node:assert/strict";
import { buildActionQueue, DRIFT_THRESHOLD_PP, HARVEST_FLOOR, MAX_ITEMS } from "../core/action-queue.mjs";

const TODAY = "2026-07-10"; // early in the 2026/27 tax year (~270 days left)
const LATE = "2027-03-01";  // ~35 days before year-end

test("requires today", () => {
  assert.throws(() => buildActionQueue({}));
});

test("empty inputs -> empty queue", () => {
  assert.deepEqual(buildActionQueue({ today: TODAY }), []);
});

/* ------------------------------ mortgages ------------------------------ */

test("expired fix outranks everything and carries the balance", () => {
  const q = buildActionQueue({
    today: TODAY,
    mortgagesSoon: [{ lender: "Halifax", balance: 180000, fixedEndDate: "2026-06-01", expired: true }],
    hasIsaWrapper: true, isaSubscribed: 0,
    aeaLeft: 3000, harvestable: 5000,
  });
  assert.equal(q[0].id, "mortgage-expired");
  assert.equal(q[0].amount, 180000);
  assert.equal(q[0].tab, "property");
});

test("a fix ending sooner scores higher than one ending later", () => {
  const mk = (fixedEndDate) => buildActionQueue({
    today: TODAY, mortgagesSoon: [{ balance: 1, fixedEndDate, expired: false }],
  })[0].score;
  assert.ok(mk("2026-07-20") > mk("2026-12-20"));
});

/* ---------------------------- cash maturities --------------------------- */

test("matured fixed-term account beats a merely-maturing one", () => {
  const q = buildActionQueue({
    today: TODAY,
    cashMaturing: [
      { label: "NS&I 1yr", balance: 20000, maturityDate: "2026-09-01", matured: false },
      { label: "Shawbrook", balance: 15000, maturityDate: "2026-07-01", matured: true },
    ],
  });
  assert.equal(q[0].id, "cash-matured");
  assert.equal(q[0].label, "Shawbrook");
  assert.equal(q[1].id, "cash-maturing");
});

/* ------------------------------ allowances ----------------------------- */

test("ISA headroom only appears for ISA users and grows more urgent late in the year", () => {
  const base = { hasIsaWrapper: true, isaSubscribed: 12000 };
  const early = buildActionQueue({ today: TODAY, ...base });
  const late = buildActionQueue({ today: LATE, ...base });
  assert.equal(early[0].id, "isa-headroom");
  assert.equal(early[0].amount, 8000);
  assert.ok(late[0].score > early[0].score);
  // GIA-only user: no ISA lecture
  assert.deepEqual(buildActionQueue({ today: TODAY, hasIsaWrapper: false, isaSubscribed: 0 }), []);
});

test("harvest amount is min(aeaLeft, harvestable) and respects the floor", () => {
  const q = buildActionQueue({ today: TODAY, aeaLeft: 3000, harvestable: 1200 });
  assert.equal(q[0].id, "aea-harvest");
  assert.equal(q[0].amount, 1200);
  assert.deepEqual(buildActionQueue({ today: TODAY, aeaLeft: 3000, harvestable: HARVEST_FLOOR - 1 }), []);
  assert.deepEqual(buildActionQueue({ today: TODAY, aeaLeft: 0, harvestable: 50000 }), []);
});

test("tax-year-end mode suppresses ISA/AEA items (the banner owns them) but not mortgages", () => {
  const q = buildActionQueue({
    today: LATE, taxYearEndActive: true,
    hasIsaWrapper: true, isaSubscribed: 0, aeaLeft: 3000, harvestable: 5000,
    mortgagesSoon: [{ balance: 1000, fixedEndDate: "2027-04-01", expired: false }],
  });
  assert.deepEqual(q.map((i) => i.id), ["mortgage-ending"]);
});

/* -------------------------------- drift -------------------------------- */

const DRIFT = [
  { bucket: "equities", driftPct: 8, driftValue: 24000 },
  { bucket: "bonds", driftPct: -8, driftValue: -24000 },
];

test("drift needs real targets and the threshold", () => {
  assert.deepEqual(buildActionQueue({ today: TODAY, driftRows: DRIFT, targetsSumTo100: false }), []);
  const small = DRIFT.map((r) => ({ ...r, driftPct: r.driftPct / 2, driftValue: r.driftValue / 2 }));
  assert.deepEqual(buildActionQueue({ today: TODAY, driftRows: small, targetsSumTo100: true }), []);
  const q = buildActionQueue({ today: TODAY, driftRows: DRIFT, targetsSumTo100: true });
  assert.equal(q[0].id, "allocation-drift");
  assert.equal(q[0].bucket, "equities"); // worst |drift| wins; equities is overweight
  assert.equal(q[0].overweight, true);
  assert.equal(q[0].amount, 24000);
  assert.ok(Math.abs(DRIFT[0].driftPct) >= DRIFT_THRESHOLD_PP);
});

/* --------------------------------- cap --------------------------------- */

test("queue is capped", () => {
  const q = buildActionQueue({
    today: LATE,
    hasIsaWrapper: true, isaSubscribed: 0, aeaLeft: 3000, harvestable: 5000,
    driftRows: DRIFT, targetsSumTo100: true,
    mortgagesSoon: [
      { balance: 1, fixedEndDate: "2027-03-10", expired: false },
      { balance: 2, fixedEndDate: "2026-01-01", expired: true },
    ],
    cashMaturing: [
      { balance: 3, maturityDate: "2027-03-05", matured: false },
      { balance: 4, maturityDate: "2027-02-01", matured: true },
    ],
  });
  assert.equal(q.length, MAX_ITEMS);
  // and sorted descending
  for (let i = 1; i < q.length; i++) assert.ok(q[i - 1].score >= q[i].score);
});
