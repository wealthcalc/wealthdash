import { test } from "node:test";
import assert from "node:assert/strict";
import {
  monthlyBudget, annualBudget, spendByMonth, monthRange, trailing12, planSpendFromBudget,
} from "../core/budget.mjs";

const CATS = [
  { id: "gro", name: "Groceries", monthly: 600, essential: true },
  { id: "fun", name: "Eating out", monthly: 200, essential: false },
  { id: "ins", name: "Car insurance", annual: 720, essential: true }, // annual-only
  { id: "xfer", name: "Card payment", transfer: true },
];

test("monthRange and trailing12 cross year boundaries", () => {
  assert.deepEqual(monthRange("2026-11", "2027-02"), ["2026-11", "2026-12", "2027-01", "2027-02"]);
  const t = trailing12("2026-07");
  assert.equal(t.length, 12);
  assert.equal(t[0], "2025-08");
  assert.equal(t[11], "2026-07");
  assert.equal(trailing12("2026-12")[0], "2026-01");
});

test("monthly view: actual vs limit, over-budget flag, essential split", () => {
  const txns = [
    { id: 1, date: "2026-07-03", amount: 320, categoryId: "gro" },
    { id: 2, date: "2026-07-19", amount: 340, categoryId: "gro" }, // 660 > 600
    { id: 3, date: "2026-07-05", amount: 45, categoryId: "fun" },
    { id: 4, date: "2026-06-30", amount: 999, categoryId: "gro" }, // other month
  ];
  const { rows, summary } = monthlyBudget({ categories: CATS, txns, month: "2026-07" });
  const gro = rows.find((r) => r.id === "gro");
  assert.equal(gro.actual, 660);
  assert.equal(gro.variance, -60);
  assert.equal(gro.over, true);
  assert.equal(summary.essentialActual, 660);
  assert.equal(summary.discretionaryActual, 45);
  assert.equal(summary.overCount, 1);
});

test("THE annual-only rule: no monthly limit, but actual still shows in its month", () => {
  const txns = [{ id: 1, date: "2026-07-11", amount: 720, categoryId: "ins" }];
  const m = monthlyBudget({ categories: CATS, txns, month: "2026-07" });
  const ins = m.rows.find((r) => r.id === "ins");
  assert.equal(ins.actual, 720);      // the money is visible…
  assert.equal(ins.limit, null);      // …but there's no phantom monthly budget
  assert.equal(ins.variance, null);
  assert.equal(ins.over, false);
  // and it doesn't inflate the monthly limit total (600 + 200 only)
  assert.equal(m.summary.totalLimit, 800);
  // over the year it IS compared, against the annual figure
  const a = annualBudget({ categories: CATS, txns, month: "2026-07" });
  const insA = a.rows.find((r) => r.id === "ins");
  assert.equal(insA.limit, 720);
  assert.equal(insA.over, false);
  assert.equal(insA.annualOnly, true);
});

test("transfers are excluded from spend totals — paying the card isn't spending", () => {
  const txns = [
    { id: 1, date: "2026-07-03", amount: 100, categoryId: "gro" },
    { id: 2, date: "2026-07-04", amount: 1500, categoryId: "xfer" },
  ];
  const m = monthlyBudget({ categories: CATS, txns, month: "2026-07" });
  assert.equal(m.summary.totalActual, 100);
  assert.equal(m.summary.transfers, 1500);
  assert.equal(m.rows.find((r) => r.id === "xfer"), undefined);
});

test("refunds net off their category rather than counting as income", () => {
  const txns = [
    { id: 1, date: "2026-07-03", amount: 250, categoryId: "fun" },
    { id: 2, date: "2026-07-09", amount: -50, categoryId: "fun" }, // refund
  ];
  const m = monthlyBudget({ categories: CATS, txns, month: "2026-07" });
  assert.equal(m.rows.find((r) => r.id === "fun").actual, 200);
  assert.equal(m.summary.totalActual, 200);
});

test("uncategorised is tracked separately, never silently folded into a category", () => {
  const txns = [
    { id: 1, date: "2026-07-03", amount: 100, categoryId: "gro" },
    { id: 2, date: "2026-07-04", amount: 80 }, // no category
  ];
  const m = monthlyBudget({ categories: CATS, txns, month: "2026-07" });
  assert.equal(m.summary.totalActual, 100);
  assert.equal(m.summary.uncategorised, 80);
});

test("annual view scales monthly limits by window length; essentialPct from actuals", () => {
  const txns = [
    { id: 1, date: "2026-07-03", amount: 600, categoryId: "gro" },  // essential
    { id: 2, date: "2026-07-05", amount: 400, categoryId: "fun" },  // discretionary
  ];
  const a = annualBudget({ categories: CATS, txns, month: "2026-07" });
  assert.equal(a.summary.monthsCovered, 12);
  assert.equal(a.rows.find((r) => r.id === "gro").limit, 7200); // 600 × 12
  assert.equal(a.summary.essentialPct, 60); // 600 of 1000
});

test("spendByMonth: annual-only spend broken out so a spike is explainable", () => {
  const txns = [
    { id: 1, date: "2026-06-02", amount: 500, categoryId: "gro" },
    { id: 2, date: "2026-07-11", amount: 720, categoryId: "ins" },
    { id: 3, date: "2026-07-03", amount: 550, categoryId: "gro" },
  ];
  const rows = spendByMonth({ categories: CATS, txns, months: ["2026-06", "2026-07"] });
  assert.equal(rows[0].actual, 500);
  assert.equal(rows[1].actual, 1270);
  assert.equal(rows[1].annualOnlyActual, 720); // the spike, labelled
  assert.equal(rows[0].limit, 800);            // monthly limits only, not 800+720
});

test("spreadAnnual smooths the lumpy year — and moves the budget line with it", () => {
  const months = ["2026-06", "2026-07"];
  const txns = [
    { id: 1, date: "2026-06-02", amount: 500, categoryId: "gro" },  // monthly, essential
    { id: 2, date: "2026-07-11", amount: 720, categoryId: "ins" },  // annual-only, essential
    { id: 3, date: "2026-07-03", amount: 550, categoryId: "gro" },
  ];
  const cash = spendByMonth({ categories: CATS, txns, months });
  const smooth = spendByMonth({ categories: CATS, txns, months, spreadAnnual: true });

  // cash view: the £720 lands in July and towers
  assert.equal(cash[0].actual, 500);
  assert.equal(cash[1].actual, 1270);
  assert.equal(cash[0].limit, 800);   // monthly limits only

  // smoothed: 720 split across the 2-month window, run-rate legible
  assert.equal(smooth[0].actual, 860);   // 500 + 360
  assert.equal(smooth[1].actual, 910);   // 550 + 360
  assert.equal(smooth[0].annualOnlyActual, 360);
  // essential/discretionary keep their split (insurance is essential)
  assert.equal(smooth[0].essential, 860);
  assert.equal(smooth[0].discretionary, 0);
  // and the LIMIT smooths too, or the comparison would be inconsistent
  assert.equal(smooth[0].limit, 800 + 720 / 12);

  // conservation: the same total money either way
  const sum = (rows) => rows.reduce((s, r) => s + r.actual, 0);
  assert.ok(Math.abs(sum(cash) - sum(smooth)) < 1e-9);
});

test("planSpendFromBudget refuses to be confident on thin or messy data", () => {
  const thin = planSpendFromBudget({
    categories: CATS, month: "2026-07",
    txns: [{ id: 1, date: "2026-07-03", amount: 600, categoryId: "gro" }],
  });
  assert.equal(thin.ready, false);
  assert.match(thin.reasons[0], /month/);

  // 8 months of data, all categorised → ready
  const txns = [];
  for (let i = 0; i < 8; i++) txns.push({ id: i, date: `2026-0${i < 3 ? i + 1 : i + 1}-05`.replace("2026-09", "2026-09"), amount: 1000, categoryId: i % 2 ? "gro" : "fun" });
  const good = planSpendFromBudget({
    categories: CATS, month: "2026-08",
    txns: [
      ...["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]
        .map((m, i) => ({ id: `g${i}`, date: `${m}-05`, amount: 700, categoryId: "gro" })),
      ...["2026-01", "2026-02", "2026-03"].map((m, i) => ({ id: `f${i}`, date: `${m}-06`, amount: 300, categoryId: "fun" })),
    ],
  });
  assert.equal(good.ready, true);
  assert.equal(good.monthsWithData, 8);
  assert.equal(good.annualSpend, 700 * 8 + 300 * 3);
  assert.ok(good.essentialPct > 80);

  // same data but a big uncategorised chunk → not ready
  const messy = planSpendFromBudget({
    categories: CATS, month: "2026-08",
    txns: [
      ...["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]
        .map((m, i) => ({ id: `g${i}`, date: `${m}-05`, amount: 700, categoryId: "gro" })),
      { id: "u", date: "2026-08-09", amount: 3000 },
    ],
  });
  assert.equal(messy.ready, false);
  assert.match(messy.reasons.join(" "), /uncategorised/);
});

test("degenerate inputs", () => {
  assert.throws(() => monthlyBudget({ categories: CATS, txns: [] }), /month/);
  const empty = monthlyBudget({ categories: [], txns: [], month: "2026-07" });
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.summary.totalActual, 0);
  assert.equal(annualBudget({ categories: CATS, txns: [], month: "2026-07" }).summary.essentialPct, null);
});
