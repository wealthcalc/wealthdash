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

/* ----------------------------- concentration ---------------------------- */

test("concentration alerts rank with weight and survive tax-year-end mode", () => {
  const q = buildActionQueue({
    today: TODAY, taxYearEndActive: true,
    concentrationAlerts: [
      { ticker: "WFC", value: 40000, weight: 0.28 },
      { ticker: "AAPL", value: 12000, weight: 0.11 },
    ],
  });
  assert.deepEqual(q.map((i) => [i.id, i.ticker]), [["concentration", "WFC"], ["concentration", "AAPL"]]);
  assert.ok(q[0].score > q[1].score);
  assert.equal(q[0].tab, "wealth");
  assert.ok(Math.abs(q[0].weightPct - 28) < 1e-9);
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

test("gilt redemptions rank near matured cash and rise as the date nears", () => {
  const near = buildActionQueue({
    today: TODAY,
    giltRedemptions: [{ date: "2026-07-20", label: "TN26", amount: 25000 }],
  });
  const far = buildActionQueue({
    today: TODAY,
    giltRedemptions: [{ date: "2026-09-05", label: "TN26", amount: 25000 }],
  });
  assert.equal(near[0].id, "gilt-redemption");
  assert.equal(near[0].tab, "gilts");
  assert.equal(near[0].amount, 25000);
  assert.ok(near[0].score > far[0].score, "nearer maturity scores higher");
  // not suppressed by tax-year-end mode — idle cash doesn't care what month it is
  const tye = buildActionQueue({ today: TODAY, taxYearEndActive: true, giltRedemptions: [{ date: "2026-07-20", label: "TN26", amount: 1 }] });
  assert.equal(tye.length, 1);
});

test("backup nudge: only with data, only when sync is off; never-backed-up outranks old", () => {
  assert.deepEqual(buildActionQueue({ today: TODAY, hasData: false, backupAgeDays: null }), []);
  assert.deepEqual(buildActionQueue({ today: TODAY, hasData: true, syncEnabled: true, backupAgeDays: null }), []);
  assert.deepEqual(buildActionQueue({ today: TODAY, hasData: true, backupAgeDays: 10 }), []); // fresh enough
  const never = buildActionQueue({ today: TODAY, hasData: true, backupAgeDays: null });
  const old = buildActionQueue({ today: TODAY, hasData: true, backupAgeDays: 60 });
  assert.equal(never[0].id, "backup-stale");
  assert.equal(never[0].tab, "sync");
  assert.ok(never[0].score > old[0].score, "never > merely old");
});

test("import staleness: per-source, 45-day threshold, low-scored housekeeping", () => {
  const q = buildActionQueue({
    today: TODAY, hasData: true, backupAgeDays: 5,
    importAges: [{ source: "Fidelity UK", days: 90 }, { source: "IBKR", days: 10 }],
  });
  assert.equal(q.length, 1);
  assert.equal(q[0].id, "import-stale");
  assert.equal(q[0].source, "Fidelity UK");
  // housekeeping stays below a real money item
  const withMoney = buildActionQueue({
    today: TODAY, hasData: true, backupAgeDays: 5,
    importAges: [{ source: "Fidelity UK", days: 90 }],
    cashMaturing: [{ label: "NS&I", balance: 20000, maturityDate: "2026-07-20", matured: false }],
  });
  assert.equal(withMoney[0].id, "cash-maturing");
});

/* ------------------- budget signals (spend drift, overspend) ----------- */

const idsOf = (q) => q.map((i) => i.id);

test("spend-drift fires only on THICK data and a material gap", () => {
  const drift = (o) => idsOf(buildActionQueue({ today: TODAY, spendDrift: o }));
  // >10% over, data ready -> fires
  assert.ok(drift({ actual: 60000, planned: 50000, ready: true }).includes("spend-drift"));
  // same gap but the budget data isn't representative yet -> silent.
  // A confident nudge from two months of half-categorised spending is
  // worse than no nudge at all.
  assert.ok(!drift({ actual: 60000, planned: 50000, ready: false }).includes("spend-drift"));
  // inside 10% -> noise, a plan is not a budget
  assert.ok(!drift({ actual: 52000, planned: 50000, ready: true }).includes("spend-drift"));
  // no plan target -> nothing to compare
  assert.ok(!drift({ actual: 60000, planned: 0, ready: true }).includes("spend-drift"));
  assert.ok(!drift(null).includes("spend-drift"));
});

test("spend-drift: under-spending is reported too, but scores lower than over", () => {
  const [over] = buildActionQueue({ today: TODAY, spendDrift: { actual: 60000, planned: 50000, ready: true } });
  const [under] = buildActionQueue({ today: TODAY, spendDrift: { actual: 40000, planned: 50000, ready: true } });
  assert.equal(over.id, "spend-drift");
  assert.equal(under.id, "spend-drift");
  assert.equal(over.over, true);
  assert.equal(under.over, false);
  assert.equal(over.amount, 10000);
  assert.equal(under.amount, 10000);
  assert.ok(over.score > under.score, "over-spending should outrank under-spending");
  assert.equal(over.tab, "plan");
});

test("budget-overspend needs to be material in BOTH senses", () => {
  const q = (o) => idsOf(buildActionQueue({ today: TODAY, overspend: o }));
  assert.ok(q({ name: "Groceries", over: 200, limit: 600 }).includes("budget-overspend"));
  // £12 over is not a money decision, however large the percentage
  assert.ok(!q({ name: "Coffee", over: 12, limit: 20 }).includes("budget-overspend"));
  // 5% over a big budget isn't either
  assert.ok(!q({ name: "Housing", over: 90, limit: 2000 }).includes("budget-overspend"));
  assert.ok(!q(null).includes("budget-overspend"));
});

test("budget items never outrank real money deadlines", () => {
  // A cash pot that has already matured is a genuine decision; an
  // overspent category is context. The five-slot queue must not invert.
  const q = buildActionQueue({
    today: TODAY,
    cashMaturing: [{ label: "Fixed saver", balance: 50000, days: 0, matured: true }],
    overspend: { name: "Groceries", over: 300, limit: 600 },
    spendDrift: { actual: 60000, planned: 50000, ready: true },
  });
  const pos = (id) => q.findIndex((i) => i.id === id);
  assert.ok(pos("cash-matured") < pos("budget-overspend"), "overspend outranked a matured fixed term");
  assert.ok(pos("cash-matured") < pos("spend-drift"), "spend drift outranked a matured fixed term");
});
