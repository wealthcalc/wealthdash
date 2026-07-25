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

test("mergedSpend is the ONE spend list — statements, manual rows AND recurring", async () => {
  const { mergedSpend } = await import("../core/budget.mjs");
  const month = "2026-07";
  const spendTxns = [
    { id: "s1", date: "2026-07-04", description: "TESCO STORES 3155", amount: 82, account: "Amex" },
    { id: "s2", date: "2026-07-06", description: "Plumber", amount: 140, manualCategoryId: "gro" },
  ];
  const rules = [{ id: "r", op: "contains", value: "TESCO", categoryId: "gro", enabled: true }];
  const recurring = [
    // HSBC is never imported, so this must appear every month.
    { id: "m", label: "Mobile", amount: 35, frequency: "monthly", startDate: "2026-07-15", categoryId: "gro", account: "HSBC" },
  ];
  const merged = mergedSpend({ spendTxns, rules, recurring, month });

  // rule-categorised statement row
  assert.equal(merged.find((t) => t.id === "s1").categoryId, "gro");
  // manual row survives
  assert.ok(merged.some((t) => t.id === "s2"));
  // recurring commitment is present — the omission that made the Plan
  // tab's prefill disagree with the Budget tab's own total.
  const rec = merged.filter((t) => t.recurringId === "m");
  assert.ok(rec.length >= 12, `expected ~monthly rows, got ${rec.length}`);
  assert.equal(rec[0].estimated, true);

  // and the July total reflects all three
  const m = monthlyBudget({ categories: CATS, txns: merged, month });
  assert.equal(m.summary.totalActual, 82 + 140 + 35);

  assert.throws(() => mergedSpend({ spendTxns: [] }), /month/);
});

test("spendByCategory + withComparison: this period vs a baseline", async () => {
  const { spendByCategory, withComparison, monthlyBudget } = await import("../core/budget.mjs");
  const txns = [
    { id: 1, date: "2026-06-03", amount: 500, categoryId: "gro" },  // baseline month
    { id: 2, date: "2026-07-03", amount: 650, categoryId: "gro" },  // this month — up 150
    { id: 3, date: "2026-07-05", amount: 100, categoryId: "fun" },  // new this month
    { id: 4, date: "2026-07-06", amount: 40, categoryId: "xfer" },  // transfer — excluded
  ];
  const prev = spendByCategory({ categories: CATS, txns, months: ["2026-06"] });
  assert.equal(prev.get("gro"), 500);
  assert.equal(prev.has("xfer"), false); // transfers never counted

  const rows = monthlyBudget({ categories: CATS, txns, month: "2026-07" }).rows;
  const compared = withComparison(rows, { baseline: prev, label: "vs June" });
  const gro = compared.find((r) => r.id === "gro");
  assert.equal(gro.baseline, 500);
  assert.equal(gro.delta, 150);
  assert.equal(gro.deltaPct, 30);
  // a category with no baseline reports null %, not Infinity
  const fun = compared.find((r) => r.id === "fun");
  assert.equal(fun.baseline, 0);
  assert.equal(fun.deltaPct, null);
});

test("averageAnnualBudget normalises ALL history to a representative year", async () => {
  const { averageAnnualBudget } = await import("../core/budget.mjs");
  // 18 months of data: £600/mo groceries every month, plus a one-off £3600
  // in a single month. Trailing-12m would over- or under-weight the one-off
  // depending on where it fell; the average spreads it across 18 months.
  const txns = [];
  const months = [];
  for (let i = 0; i < 18; i++) {
    const y = 2025 + Math.floor(i / 12), mo = (i % 12) + 1;
    const m = `${y}-${String(mo).padStart(2, "0")}`;
    months.push(m);
    txns.push({ id: `g${i}`, date: `${m}-05`, amount: 600, categoryId: "gro" });
  }
  txns.push({ id: "spike", date: "2025-03-11", amount: 3600, categoryId: "fun" }); // one-off

  const a = averageAnnualBudget({ categories: CATS, txns, toMonth: "2026-06" });
  assert.equal(a.summary.monthsWithData, 18);
  const gro = a.rows.find((r) => r.id === "gro");
  // 600/mo over 18 months → still 600×12 = 7200 representative annual
  assert.equal(gro.actual, 7200);
  const fun = a.rows.find((r) => r.id === "fun");
  // 3600 over 18 months = 200/mo → 2400 representative annual (diluted)
  assert.equal(fun.actual, 2400);
  // limits are the TRUE annual budget, not scaled by history length
  assert.equal(gro.limit, 7200);  // 600 × 12
  assert.equal(fun.limit, 2400);  // 200 × 12

  // empty history returns a safe zero shape, not NaN
  const empty = averageAnnualBudget({ categories: CATS, txns: [], toMonth: "2026-06" });
  assert.equal(empty.summary.monthsWithData, 0);
  assert.equal(empty.summary.essentialPct, null);
});

test("annualBudget pro-rates annual-only limits to the window (the YTD fix)", () => {
  const txns = [{ id: 1, date: "2026-03-11", amount: 300, categoryId: "ins" }]; // annual insurance, part paid
  // Full 12-month window: annual limit is the whole £720 (unchanged).
  const full = annualBudget({ categories: CATS, txns, month: "2026-12" });
  assert.equal(full.rows.find((r) => r.id === "ins").limit, 720);
  // 6-month window (Jan–Jun): the annual budget is halved to £360.
  const half = annualBudget({ categories: CATS, txns, months: ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] });
  assert.equal(half.rows.find((r) => r.id === "ins").limit, 360);
  // monthly categories already pro-rated by months (£600 × 6)
  assert.equal(half.rows.find((r) => r.id === "gro")?.limit ?? 3600, 3600);
});

test("yearOverlay: complete years only, cumulative, transfers out, uncategorised in", async () => {
  const { yearOverlay } = await import("../core/budget.mjs");
  // 2020 and 2021 are complete (spend in Jan AND Dec); 2019 starts in
  // August so it's incomplete and must be excluded (its early months would
  // read as £0 and drag the trend down).
  const txns = [
    { id: 0, date: "2019-08-10", amount: 999, categoryId: "gro" }, // incomplete first year
    { id: 1, date: "2020-01-10", amount: 100, categoryId: "gro" },
    { id: 2, date: "2020-02-10", amount: 200, categoryId: "gro" },
    { id: 3, date: "2020-12-10", amount: 50, categoryId: "gro" },
    { id: 4, date: "2021-01-10", amount: 150, categoryId: "gro" },
    { id: 5, date: "2021-01-11", amount: 50 },                      // uncategorised — counts
    { id: 6, date: "2021-02-10", amount: 300, categoryId: "xfer" }, // transfer — excluded
    { id: 7, date: "2021-12-10", amount: 40, categoryId: "gro" },
  ];
  const o = yearOverlay({ categories: CATS, txns });
  assert.deepEqual(o.years, [2020, 2021]);      // 2019 dropped as incomplete
  const jan = o.rows[0], feb = o.rows[1];
  assert.equal(jan[2020], 100);
  assert.equal(feb[2020], 300);                 // 100 + 200 cumulative
  assert.equal(o.rows[11][2020], 350);          // Dec = full-year total
  assert.equal(jan[2021], 200);                 // 150 categorised + 50 uncategorised
  assert.equal(feb[2021], 200);                 // Feb transfer excluded, unchanged
});

test("yearOverlay: the current year's line stops at the present month, not a plateau", async () => {
  const { yearOverlay } = await import("../core/budget.mjs");
  const y = new Date().getFullYear();
  const nowM = new Date().getMonth();
  const txns = [{ id: 1, date: `${y}-01-05`, amount: 100, categoryId: "gro" }];
  const o = yearOverlay({ categories: CATS, txns });
  // this month and earlier are numbers; later months are null (line ends)
  assert.ok(typeof o.rows[nowM][y] === "number");
  if (nowM < 11) assert.equal(o.rows[nowM + 1][y], null);
});

test("discretionaryRunway: spent YTD + remaining essentials → non-essential headroom", async () => {
  const { discretionaryRunway } = await import("../core/budget.mjs");
  // As at end of June (month 6): 6 months elapsed, 6 whole months left.
  const cats = [
    { id: "gro", name: "Groceries", monthly: 600, essential: true },
    { id: "fun", name: "Eating out", monthly: 300, essential: false },
    { id: "ins", name: "Insurance", annual: 1200, essential: true }, // annual-only essential
  ];
  const txns = [
    // 6 months of groceries at budget, plus 6 months of eating out over budget
    ...["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"].flatMap((m, i) => [
      { id: `g${i}`, date: `${m}-05`, amount: 600, categoryId: "gro" },
      { id: `f${i}`, date: `${m}-06`, amount: 400, categoryId: "fun" }, // £400 vs £300 budget
    ]),
    { id: "ins", date: "2026-03-01", amount: 1200, categoryId: "ins" }, // insurance already paid
  ];
  const r = discretionaryRunway({ categories: cats, txns, month: "2026-06" });
  assert.equal(r.wholeMonthsLeft, 6);
  // spent YTD: 6×600 groceries + 6×400 eating + 1200 insurance = 3600 + 2400 + 1200 = 7200
  assert.equal(r.ytdTotal, 7200);
  assert.equal(r.ytdEssential, 4800);      // groceries 3600 + insurance 1200
  assert.equal(r.ytdDiscretionary, 2400);  // eating out
  // remaining essential: groceries 600×6 = 3600; insurance already fully paid → 0
  assert.equal(r.remainingEssential, 3600);
  // ceiling default = full-year budget: (600+300)×12 + 1200 = 10800 + 1200 = 12000
  assert.equal(r.totalBudget, 12000);
  assert.equal(r.ceiling, 12000);
  // headroom = 12000 − 7200 − 3600 = 1200 for the rest of the year
  assert.equal(r.headroom, 1200);
  assert.equal(r.perMonthHeadroom, 200); // 1200 / 6
});

test("discretionaryRunway: over-commitment is surfaced, not floored; custom ceiling", async () => {
  const { discretionaryRunway } = await import("../core/budget.mjs");
  const cats = [{ id: "gro", name: "Groceries", monthly: 600, essential: true }];
  const txns = [{ id: 1, date: "2026-06-15", amount: 9000, categoryId: "gro" }]; // blew it
  const r = discretionaryRunway({ categories: cats, txns, month: "2026-06", ceiling: 8000 });
  assert.equal(r.ceiling, 8000);
  assert.equal(r.usedDefaultCeiling, false);
  assert.ok(r.overCommitted);
  assert.ok(r.headroom < 0);
  assert.throws(() => discretionaryRunway({ categories: cats, txns: [] }), /month/);
});
