import { test } from "node:test";
import assert from "node:assert/strict";
import { detectCadence, nextOccurrences, buildIncomeCalendar, summariseBySource } from "../core/income-calendar.mjs";

/* ------------------------------ cadence --------------------------------- */

test("detectCadence: classifies monthly/quarterly/semi-annual/annual by median gap", () => {
  assert.equal(detectCadence(["2026-01-01", "2026-02-01", "2026-03-03"]).label, "monthly");
  assert.equal(detectCadence(["2026-01-01", "2026-04-02", "2026-07-01"]).label, "quarterly");
  assert.equal(detectCadence(["2025-01-01", "2025-07-02", "2026-01-01"]).label, "semi-annual");
  assert.equal(detectCadence(["2023-01-01", "2024-01-01", "2025-01-01"]).label, "annual");
});

test("detectCadence: wildly inconsistent gaps -> irregular, not a false cadence", () => {
  const c = detectCadence(["2026-01-01", "2026-01-15", "2026-09-01"]);
  assert.equal(c.label, "irregular");
});

test("detectCadence: fewer than 2 dates -> null (nothing to measure)", () => {
  assert.equal(detectCadence([]), null);
  assert.equal(detectCadence(["2026-01-01"]), null);
});

/* --------------------------- next occurrences ---------------------------- */

test("nextOccurrences: steps forward from last date, stops at horizon, excludes today/past", () => {
  const occs = nextOccurrences("2026-06-01", 91, "2026-07-08", 200);
  // 2026-06-01 + 91 = 2026-08-31 (within horizon of 2026-07-08+200=2027-01-24)
  // + another 91 = 2026-11-30 (still within)
  // + another 91 = 2027-02-28 (past horizon -> stop)
  assert.deepEqual(occs, ["2026-08-31", "2026-11-30"]);
});

test("nextOccurrences: invalid step or missing date -> empty, not a crash", () => {
  assert.deepEqual(nextOccurrences(null, 91, "2026-07-08"), []);
  assert.deepEqual(nextOccurrences("2026-01-01", 0, "2026-07-08"), []);
});

/* ---------------------------- full calendar ------------------------------ */

const TODAY = "2026-07-08";

test("buildIncomeCalendar: requires `today` — pure functions don't read the clock", () => {
  assert.throws(() => buildIncomeCalendar({}));
});

test("buildIncomeCalendar: gilt cashflows pass through as scheduled, filtered to the horizon", () => {
  const giltCashflows = [
    { date: "2026-08-01", type: "coupon", amount: 62.5, ticker: "TN28" },
    { date: "2028-01-31", type: "redemption", amount: 10000, ticker: "TN28" }, // beyond 365d horizon
    { date: "2026-06-01", type: "coupon", amount: 62.5, ticker: "TN28" }, // already in the past
  ];
  const events = buildIncomeCalendar({ giltCashflows, today: TODAY, horizonDays: 365 });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "gilt-coupon");
  assert.equal(events[0].certainty, "scheduled");
  assert.equal(events[0].amount, 62.5);
});

test("buildIncomeCalendar: forecasts quarterly dividends for a currently-held ticker", () => {
  const txns = [{ date: "2020-01-01", ticker: "SMT", side: "BUY", quantity: 100 }];
  const incomeEntries = [
    { date: "2025-10-01", ticker: "SMT", kind: "dividend", amount: 100 },
    { date: "2026-01-02", ticker: "SMT", kind: "dividend", amount: 105 },
    { date: "2026-04-01", ticker: "SMT", kind: "dividend", amount: 110 },
  ];
  const events = buildIncomeCalendar({ incomeEntries, txns, today: TODAY, horizonDays: 100 });
  const divs = events.filter((e) => e.source === "dividend");
  assert.equal(divs.length, 1); // one quarterly occurrence within a 100-day horizon
  assert.equal(divs[0].date, "2026-10-04");
  assert.equal(divs[0].label, "SMT");
  assert.equal(divs[0].certainty, "estimated");
  assert.equal(divs[0].amount, 105); // avg of last 3: (100+105+110)/3 = 105
});

test("buildIncomeCalendar: a fully sold holding gets no forecast dividends", () => {
  const txns = [
    { date: "2020-01-01", ticker: "SMT", side: "BUY", quantity: 100 },
    { date: "2026-01-01", ticker: "SMT", side: "SELL", quantity: 100 }, // closed before `today`
  ];
  const incomeEntries = [
    { date: "2025-04-01", ticker: "SMT", kind: "dividend", amount: 100 },
    { date: "2025-07-01", ticker: "SMT", kind: "dividend", amount: 100 },
  ];
  const events = buildIncomeCalendar({ incomeEntries, txns, today: TODAY, horizonDays: 200 });
  assert.equal(events.filter((e) => e.source === "dividend").length, 0);
});

test("buildIncomeCalendar: blank-ticker interest is forecast regardless of holdings", () => {
  const incomeEntries = [
    { date: "2026-01-01", ticker: "", kind: "interest", amount: 20 },
    { date: "2026-04-01", ticker: "", kind: "interest", amount: 20 },
  ];
  const events = buildIncomeCalendar({ incomeEntries, txns: [], today: TODAY, horizonDays: 100 });
  const interest = events.filter((e) => e.source === "interest");
  assert.equal(interest.length, 1);
  assert.equal(interest[0].date, "2026-09-28");
});

test("buildIncomeCalendar: a single historical payment isn't enough to forecast", () => {
  const txns = [{ date: "2020-01-01", ticker: "AAPL", side: "BUY", quantity: 10 }];
  const incomeEntries = [{ date: "2026-04-01", ticker: "AAPL", kind: "dividend", amount: 50 }];
  const events = buildIncomeCalendar({ incomeEntries, txns, today: TODAY, horizonDays: 365 });
  assert.equal(events.filter((e) => e.source === "dividend").length, 0);
});

test("buildIncomeCalendar: fixed-term cash maturity within horizon is scheduled; variable and matured are excluded", () => {
  const cashAccounts = [
    { id: "a1", label: "12mo bond", wrapper: "GIA", balance: 10000, rateType: "fixed", maturityDate: "2026-09-01" },
    { id: "a2", label: "easy access", wrapper: "GIA", balance: 5000, rateType: "variable", maturityDate: null },
    { id: "a3", label: "matured bond", wrapper: "ISA", balance: 3000, rateType: "fixed", maturityDate: "2026-01-01" },
  ];
  const events = buildIncomeCalendar({ cashAccounts, today: TODAY, horizonDays: 365 });
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "cash-maturity");
  assert.equal(events[0].label, "12mo bond");
  assert.equal(events[0].amount, 10000);
  assert.equal(events[0].certainty, "scheduled");
});

test("buildIncomeCalendar: pension contributions are never forecast — they're money going INTO the pot, not income", () => {
  // Even a clean, obviously-forecastable monthly cadence must not appear:
  // buildIncomeCalendar no longer accepts a pensionCashflows input at all.
  const events = buildIncomeCalendar({
    incomeEntries: [], txns: [], cashAccounts: [], giltCashflows: [],
    pensionCashflows: [ // extra/unknown input — must be silently ignored, not throw
      { date: "2026-04-06", provider: "L&G", gbpAmount: 600 },
      { date: "2026-05-06", provider: "L&G", gbpAmount: 600 },
    ],
    today: TODAY, horizonDays: 60,
  });
  assert.equal(events.filter((e) => e.source === "pension-contribution").length, 0);
  assert.equal(events.length, 0);
});

test("buildIncomeCalendar: everything sorted chronologically across sources", () => {
  const giltCashflows = [{ date: "2026-12-01", type: "coupon", amount: 50, ticker: "TN28" }];
  const cashAccounts = [{ id: "a1", label: "bond", wrapper: "GIA", balance: 1000, rateType: "fixed", maturityDate: "2026-08-01" }];
  const events = buildIncomeCalendar({ giltCashflows, cashAccounts, today: TODAY, horizonDays: 365 });
  assert.deepEqual(events.map((e) => e.date), ["2026-08-01", "2026-12-01"]);
});

/* ------------------------------ summaries -------------------------------- */

test("summariseBySource: counts and totals per source", () => {
  const events = [
    { source: "dividend", amount: 100 },
    { source: "dividend", amount: 50 },
    { source: "gilt-coupon", amount: 62.5 },
  ];
  const s = summariseBySource(events);
  assert.deepEqual(s.dividend, { count: 2, total: 150 });
  assert.deepEqual(s["gilt-coupon"], { count: 1, total: 62.5 });
});

test("rsu-vest events: future scheduled dates, estimated certainty, horizon-bounded", async () => {
  const { buildIncomeCalendar } = await import("../core/income-calendar.mjs");
  const events = buildIncomeCalendar({
    today: "2026-07-16", horizonDays: 365,
    rsuVests: [
      { date: "2027-02-05", amount: 16000, label: "WFC vest" },   // in horizon
      { date: "2026-07-01", amount: 999, label: "past" },          // past — excluded
      { date: "2028-02-05", amount: 999, label: "beyond" },        // beyond horizon
      { date: "2027-01-01", amount: 0, label: "zero" },            // zero — excluded
    ],
  });
  const vests = events.filter((e) => e.source === "rsu-vest");
  assert.equal(vests.length, 1);
  assert.equal(vests[0].date, "2027-02-05");
  assert.equal(vests[0].amount, 16000);
  assert.equal(vests[0].certainty, "estimated");
});

test("VCT fallback: irregular-but-established payers are projected forward a year", () => {
  // A VCT paying twice a year on drifting dates — median gap lands
  // between the quarterly and semi-annual bands, so detectCadence calls it
  // irregular. Without the fallback it would be dropped; with it, the
  // trailing 12 months project forward.
  const today = "2026-07-24";
  const txns = [{ id: 1, date: "2020-01-01", side: "BUY", ticker: "GHV1", quantity: 1000 }];
  // Two ~200 ordinary dividends a year on drifting dates (irregular
  // cadence), PLUS a one-off £400 special in the most recent year. The
  // forecast must be built from the robust annual rate (~£400/yr, the
  // median of the three years) — NOT the special-inflated last year (£800).
  const incomeEntries = [
    { date: "2023-09-01", ticker: "GHV1", amount: 200, wrapper: "VCT" },
    { date: "2024-02-01", ticker: "GHV1", amount: 200, wrapper: "VCT" },
    { date: "2024-09-01", ticker: "GHV1", amount: 200, wrapper: "VCT" },
    { date: "2025-02-01", ticker: "GHV1", amount: 200, wrapper: "VCT" },
    { date: "2025-09-01", ticker: "GHV1", amount: 200, wrapper: "VCT" }, // trailing 12m
    { date: "2026-02-01", ticker: "GHV1", amount: 200, wrapper: "VCT" }, // trailing 12m
    { date: "2026-03-01", ticker: "GHV1", amount: 400, wrapper: "VCT" }, // trailing 12m — SPECIAL
  ];
  assert.equal(detectCadence(incomeEntries.map((e) => e.date)).label, "irregular");
  const ev = buildIncomeCalendar({ incomeEntries, txns, today, horizonDays: 365 });
  const vct = ev.filter((e) => e.label === "GHV1");
  const total = vct.reduce((s, e) => s + e.amount, 0);
  // the special is discounted: ~£400/yr, not £800
  assert.ok(Math.abs(total - 400) < 1, `forecast total ${total} should be ~400, not 800`);
  assert.ok(vct.length >= 2);
  assert.ok(vct.every((e) => e.certainty === "estimated"));
  assert.ok(vct.every((e) => e.cadence === "annual (est.)"));
});

test("VCT fallback needs real history — two close one-offs are NOT annualised", () => {
  const today = "2026-07-24";
  const txns = [{ id: 1, date: "2026-01-01", side: "BUY", ticker: "NEW", quantity: 100 }];
  const incomeEntries = [
    { date: "2026-03-01", ticker: "NEW", amount: 50, wrapper: "VCT" },
    { date: "2026-06-15", ticker: "NEW", amount: 50, wrapper: "VCT" }, // gap 106d = irregular, span < 300
  ];
  assert.equal(detectCadence(incomeEntries.map((e) => e.date)).label, "irregular");
  const ev = buildIncomeCalendar({ incomeEntries, txns, today, horizonDays: 365 });
  assert.equal(ev.filter((e) => e.label === "NEW").length, 0);
});
